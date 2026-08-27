"""SafeWatch -- update the LLM/agent-safety paper dataset.

Fetches recent papers from the arXiv API, gates them for LLM relevance,
classifies them into safety sub-topics, then merges a curated selection of
the best candidates into ``data/papers.json`` (one bucket per batch date,
plus computed stats and topic proportions consumed by the dashboard).

Usage:
    python scripts/update_data.py            # incremental run (last N days)
    python scripts/update_data.py --full     # rebuild with a longer window
Environment overrides:
    FETCH_DAYS=7   DAILY_CAP=24   PER_CATEGORY_CAP=6   FETCH_MAX=110
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    import feedparser
except ImportError:  # pragma: no cover
    sys.exit("Missing dependency 'feedparser'. Install with: pip install feedparser")

ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "data" / "papers.json"

FETCH_DAYS = int(os.environ.get("FETCH_DAYS", 7))
DAILY_CAP = int(os.environ.get("DAILY_CAP", 24))
PER_CATEGORY_CAP = int(os.environ.get("PER_CATEGORY_CAP", 6))
FETCH_MAX = int(os.environ.get("FETCH_MAX", 110))

ARXIV_API = "https://export.arxiv.org/api/query"
DATE_FORMAT = "%Y-%m-%d"
ARXIV_ID_RE = re.compile(r"arxiv\.org/abs/([0-9]{4}\.[0-9]{4,5})v?[0-9]*")
GITHUB_RE = re.compile(r"https?://(?:www\.)?github\.com/([\w.-]+/[\w.-]+)", re.I)

# A paper is kept only if it clearly involves LLMs / language models.
MODEL_HINT_RE = re.compile(
    r"\b(llms?|large\s+language|language\s+models?|foundation\s+models?"
    r"|vision[-\s]language|multimodal|multi[-\s]modal|mllms?|vlms?"
    r"|chatgpt|gpt[\s\-]?\d|gpt[\s\-]?o|gpts?|openai|claude|gemini"
    r"|llamas?|mistral|qwen|deepseek|rlhf|rlaif)\b",
    re.I,
)

TOPIC_COLORS = {
    "Jailbreaking & Red Teaming": "#ff5d8f",
    "Prompt Injection & LLM Attacks": "#ff9f43",
    "Reward Hacking & Deceptive Alignment": "#a78bfa",
    "Agentic AI Safety": "#38bdf8",
    "Safety Training & Alignment": "#34d399",
    "Defenses, Privacy & Robustness": "#60a5fa",
}

# Topic key -> {"queries": arXiv search strings used to gather candidates,
#               "patterns": scored evidence patterns applied to title+abstract}
CATEGORY_RULES: dict[str, dict] = {
    "Jailbreaking & Red Teaming": {
        "queries": [
            'all:"jailbreak" AND (cat:cs.CL OR cat:cs.AI OR cat:cs.CR)',
            '(all:"red teaming" OR all:"red-teaming") '
            "AND (cat:cs.CL OR cat:cs.AI OR cat:cs.CR)",
        ],
        "patterns": [
            r"\bjailbreak", r"\bred.?team", r"harmful (content|output|response)"
            , r"\bharmfulness\b", r"safety.{0,14}attack"
            , r"refusal.{0,16}(bypass|circumvent)"
            , r"unsafe prompt", r"\bharm\b.{0,20}(eliciti|extract)",
        ],
    },
    "Prompt Injection & LLM Attacks": {
        "queries": [
            'all:"prompt injection" AND (cat:cs.CL OR cat:cs.AI OR cat:cs.CR)',
            '(all:"indirect prompt injection" OR all:"system prompt"'
            ' OR all:"data exfiltration" OR ti:"backdoor")'
            " AND (cat:cs.CL OR cat:cs.AI)",
        ],
        "patterns": [
            r"prompt injection", r"data exfiltrat", r"injected instruction"
            , r"backdoor", r"adversarial (suffix|prefix|trigger|perturbation|example)"
            , r"(data|corpus) poison", r"system prompt (leak|extraction)"
            , r"indirect attack", r"instruction manipulation",
        ],
    },
    "Reward Hacking & Deceptive Alignment": {
        "queries": [
            '(all:"reward hacking" OR all:"specification gaming"'
            ' OR all:"reward tampering" OR all:"deceptive alignment"'
            ' OR all:"reward forgery" OR all:"sandbagging")'
            " AND (cat:cs.AI OR cat:cs.CL OR cat:cs.LG)",
        ],
        "patterns": [
            r"reward hack", r"specification gaming", r"reward tamper"
            , r"deceptive (align|behavio|capabil)", r"sandbagging", r"goodhart"
            , r"overoptimi[sz]ation of the reward", r"sycophanc"
            , r"reward (model )?(exploit|forge|hack|misuse)",
        ],
    },
    "Agentic AI Safety": {
        "queries": [
            '(ti:"LLM agent" OR ti:"LLM agents" OR ti:"AI agent" OR ti:"AI agents"'
            ' OR ti:"web agent" OR ti:"GUI agent" OR ti:"agentic")'
            " AND (cat:cs.CL OR cat:cs.AI OR cat:cs.CR OR cs.MA)",
            '(abs:"agent safety" OR abs:"safe agent" OR abs:"agent security")'
            " AND (cat:cs.CL OR cat:cs.AI OR cat:cs.CR)",
        ],
        "patterns": [
            r"agent.{0,24}(safety|security|risk|harm|danger|malicious|abuse|misuse)"
            , r"(unsafe|malicious|harmful|dangerous) agent"
            , r"(tool|function)-?calling.{0,20}(risk|attack|security)"
            , r"autonomous.{0,28}(harm|threat|risk|attack)"
            , r"(web|os|gui|code) agent.{0,30}(attack|risk|security|safety)"
            , r"goal (hijack|misgeneraliz)", r"agentic (safety|risk)",
        ],
    },
    "Safety Training & Alignment": {
        "queries": [
            '(abs:"safety alignment" OR abs:"constitutional ai" OR ti:"harmlessness"'
            ' OR abs:"harmlessness" OR ti:"machine unlearning" OR abs:"unlearning")'
            " AND (cat:cs.CL OR cat:cs.AI OR cat:cs.LG)",
            '(ti:"alignment" OR ti:"value alignment" OR all:"superalignment"'
            ' OR all:"safe RLHF") AND (cat:cs.CL OR cat:cs.AI OR cat:cs.LG)',
        ],
        "patterns": [
            r"safety alignment", r"\brlhf\b|\brlaif\b|\bdpo\b|\bgrpo\b"
            , r"constitution(al)? ai", r"harmless(ness)?"
            , r"align(ing|ment).{0,26}(value|human|intent|safety)"
            , r"machine unlearning", r"knowledge unlearning"
            , r"safety (finetun|tuning|train)|safer finetun", r"model (edit|steer)ing",
        ],
    },
    "Defenses, Privacy & Robustness": {
        "queries": [
            '(abs:"guardrail" OR abs:"watermarking" OR abs:"membership inference"'
            ' OR ti:"guardrail" OR abs:"privacy attack"'
            ' OR abs:"jailbreak detection" OR abs:"harmful content detection"'
            ' OR abs:"content moderation")'
            " AND (cat:cs.CL OR cat:cs.AI OR cat:cs.CR)",
            '(all:"LLM watermark" OR all:"text watermarking"'
            ' OR all:"certified robustness" OR all:"training data extraction")'
            " AND (cat:cs.CL OR cat:cs.AI OR cat:cs.CR)",
        ],
        "patterns": [
            r"guardrail", r"watermark", r"membership inferen", r"training data extraction"
            , r"(personal|private).{0,20}(data|information)"
            , r"privacy.{0,24}(attack|risk|leak|preserv)"
            , r"content moderation", r"(detect|monitor|defend|mitigat)\w*.{0,32}"
              r"(jailbreak|injection|backdoor|harmful)"
            , r"certified robust", r"\bsafe decod", r"(input|output) filter"
            , r"robust.{0,18}alignment", r"defen[cs]e against", r"\bfirewall\b",
        ],
    },
}


def fetch_category_batch(topic_key: str, queries: list[str]) -> list[dict]:
    """Run each query for one topic and return tagged raw entries."""
    out: list[dict] = []
    for q in queries:
        params = {
            "search_query": q,
            "sortBy": "submittedDate",
            "sortOrder": "descending",
            "max_results": str(FETCH_MAX),
        }
        url = f"{ARXIV_API}?{urllib.parse.urlencode(params)}"
        print(f"[fetch] {topic_key}: {q[:72]}...")
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "SafeWatch/1.0"})
            with urllib.request.urlopen(req, timeout=45) as resp:
                feed = feedparser.parse(resp.read())
        except Exception as exc:  # noqa: BLE001 - skip on transient network issues
            print(f"  !! fetch failed ({exc}); skipping query")
            continue
        for e in feed.entries:
            aid_m = ARXIV_ID_RE.search(e.get("id", ""))
            if not aid_m:
                continue
            out.append(
                {
                    "arxiv_id": aid_m.group(1),
                    "title": re.sub(r"\s+", " ", e.get("title", "")).strip(),
                    "abstract": re.sub(r"\s+", " ", e.get("summary", "")).strip(),
                    "authors": [a.get("name", "").strip() for a in e.get("authors", [])],
                    "published": e.get("published", ""),
                    "topic_hint": topic_key,
                }
            )
        time.sleep(3.2)
    return out


def classify(text_low: str, title_low: str, hint: str | None) -> tuple[str | None, int]:
    """Score every topic's patterns; return (best_topic, score).

    Topic patterns scored by how often they appear (+2 bonus for hits inside
    titles). Ties between top scores fall back to the topic whose query found
    the paper first (the hint).
    """
    scores: dict[str, int] = {}
    for tk, rules in CATEGORY_RULES.items():
        s = 0
        for pat in rules["patterns"]:
            n = len(re.findall(pat, text_low))
            if not n:
                continue
            s += 1
            if re.search(pat, title_low):
                s += 2
        if s > 0:
            scores[tk] = s
    if not scores:
        return None, 0
    best_score = max(scores.values())
    best_topics = [tk for tk, s in scores.items() if s == best_score]
    if hint in best_topics:
        return hint, best_score
    return best_topics[0], best_score


def build_paper(entry: dict, topic: str, score: int) -> dict:
    pub_dt = datetime.strptime(entry["published"][:19], "%Y-%m-%dT%H:%M:%S").replace(
        tzinfo=timezone.utc
    )
    abstract = entry["abstract"]
    repo = None
    repo_m = GITHUB_RE.search(abstract)
    if repo_m:
        slug = repo_m.group(1).rstrip(".")
        repo = f"https://github.com/{slug}"
    return {
        "id": entry["arxiv_id"],
        "title": entry["title"],
        "authors": entry["authors"],
        "abstract": abstract,
        "category": topic,
        "date": pub_dt.strftime(DATE_FORMAT),
        "url": f"https://arxiv.org/abs/{entry['arxiv_id']}",
        "repo": repo,
        "score": score,
    }


def fetch_hf_upvotes(days_back: int) -> dict[str, int]:
    """Fetch Hugging Face daily-papers upvotes for the last ``days_back`` days.

    Community upvotes are used as an "interestingness" boost. GitHub Actions
    runners reach huggingface.co directly; locally without a proxy this
    degrades gracefully to an empty map and ranking falls back to regex score.
    """
    votes: dict[str, int] = {}
    for offset in range(1, days_back + 1):
        day = (datetime.now(timezone.utc) - timedelta(days=offset)).strftime(DATE_FORMAT)
        url = f"https://huggingface.co/api/daily_papers?date={day}"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "SafeWatch/1.0"})
            with urllib.request.urlopen(req, timeout=20) as resp:
                items = json.loads(resp.read())
        except Exception as exc:  # noqa: BLE001 - signal source must never break the run
            print(f"[hf   ] {day}: unavailable ({exc}); continuing")
            continue
        for item in items:
            pid = ((item.get("paper") or {}).get("id") or "").strip()
            if pid:
                votes[pid] = int((item.get("paper") or {}).get("upvotes") or 0)
        time.sleep(0.8)
    print(f"[hf   ] collected upvotes for {len(votes)} papers")
    return votes


def rank_score(score: int, upvotes: int) -> tuple:
    """Blend topic-match evidence with HF community signal (bounded)."""
    hf_bonus = min(4.0, math.log1p(upvotes)) if upvotes else 0.0
    return (round(score + hf_bonus, 2), upvotes)


def select_papers(candidates: list[dict], hf_votes: dict[str, int]) -> list[dict]:
    """De-dupe, classify, rank; apply per-topic and per-day caps."""
    seen: set[str] = set()
    uniq: list[dict] = []
    for e in sorted(candidates, key=lambda x: x["published"], reverse=True):
        if e["arxiv_id"] in seen:
            continue
        seen.add(e["arxiv_id"])
        uniq.append(e)

    ranked_by_topic: dict[str, list[dict]] = {tk: [] for tk in CATEGORY_RULES}
    rejected = 0
    for e in uniq:
        low = f'{e["title"]} {e["abstract"]}'.lower()
        tlow = e["title"].lower()
        if not MODEL_HINT_RE.search(low):
            rejected += 1
            continue
        topic, score = classify(low, tlow, e.get("topic_hint"))
        if topic is None:
            rejected += 1
            continue
        paper = build_paper(e, topic, score)
        paper["upvotes"] = hf_votes.get(paper["id"], 0)
        ranked_by_topic[topic].append(paper)

    chosen: list[dict] = []
    for plist in ranked_by_topic.values():
        # Strongest blended evidence first; date as final tiebreaker.
        plist.sort(key=lambda p: p["date"], reverse=True)
        plist.sort(key=lambda p: rank_score(p["score"], p["upvotes"]), reverse=True)
        chosen.extend(plist[:PER_CATEGORY_CAP])
    chosen.sort(key=lambda p: rank_score(p["score"], p["upvotes"]), reverse=True)
    return chosen[:DAILY_CAP]


def recompute_totals(days: list[dict]) -> tuple[dict[str, int], float, int]:
    """Recount per-topic totals across the entire accumulated history."""
    counts: dict[str, int] = {c: 0 for c in TOPIC_COLORS}
    total = sum(len(d["papers"]) for d in days)
    for d in days:
        for p in d["papers"]:
            counts[p["category"]] = counts.get(p["category"], 0) + 1
    proportions = {
        c: round(counts.get(c, 0) * 100 / total, 1) if total else 0.0
        for c in TOPIC_COLORS
    }
    return counts, proportions, total


def load_dataset() -> dict:
    if DATA_FILE.exists():
        try:
            data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
            data.setdefault("days", [])
            data.setdefault("pending", [])
            return data
        except json.JSONDecodeError:
            print("[warn] papers.json unreadable; starting a fresh dataset")
    return {"days": [], "pending": []}


def merge_into_dataset(batch_date: str, selected: list[dict]) -> None:
    """Merge this run's selection into data/papers.json."""
    dataset = load_dataset()
    existing_ids = {
        p["id"]
        for d in dataset["days"] + dataset.get("pending", [])
        for p in d["papers"]
    }

    days_by_date = {d["batch_date"]: d for d in dataset["days"]}
    fresh = [p for p in selected if p["id"] not in existing_ids]
    bucket = days_by_date.setdefault(
        batch_date, {"batch_date": batch_date, "papers": [], "total_count": 0}
    )
    known_in_bucket = {p["id"] for p in bucket["papers"]}
    added = [p for p in fresh if p["id"] not in known_in_bucket]
    bucket["papers"].extend(added)
    bucket["total_count"] = len(bucket["papers"])

    merged_days = sorted(days_by_date.values(), key=lambda d: d["batch_date"], reverse=True)
    counts, proportions, total = recompute_totals(merged_days)

    out = {
        "last_updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "latest_day": merged_days[0]["batch_date"] if merged_days else None,
        "total_today": next(
            (d["total_count"] for d in merged_days if d["batch_date"] == batch_date), 0
        ),
        "categories": list(TOPIC_COLORS.keys()),
        "topic_colors": TOPIC_COLORS,
        "proportions": proportions,
        "category_counts": counts,
        "total_papers": total,
        "days": merged_days,
    }
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    DATA_FILE.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[merge] +{len(added)} new papers into {batch_date}")
    print(f"[write] data/papers.json | cumulative total {total}")


def collect(days_back: int) -> list[dict]:
    pool: list[dict] = []
    for tk, rules in CATEGORY_RULES.items():
        pool.extend(fetch_category_batch(tk, rules["queries"]))
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days_back)).strftime(DATE_FORMAT)
    recent = [e for e in pool if e["published"][:10] >= cutoff]
    print(f"[pool ] {len(pool)} raw entries | {len(recent)} within last {days_back} days")
    hf_votes = fetch_hf_upvotes(days_back)
    return select_papers(recent, hf_votes)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--full", action="store_true", help="wider backfill window")
    args = parser.parse_args(argv)

    days_back = FETCH_DAYS * (6 if args.full else 1)
    selected = collect(days_back)
    if not selected:
        print("[warn] nothing selected this run; dataset unchanged")
        return 0
    latest_batch = max(p["date"] for p in selected)
    merge_into_dataset(latest_batch, selected)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
