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

sys.path.insert(0, str(Path(__file__).resolve().parent))
import curate  # noqa: E402 - sibling module shipped with this script

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
# Fields kept for the complete-collection tier (no abstract -> compact JSON).
COMPACT_KEYS = ("id", "title", "category", "date", "url", "repo", "upvotes")
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


# Explicit defensive intent: the paper's contribution is countermeasure/
# audit work, even when attack words dominate the title (user-reported issue).
DEFENSE_CONTEXT_RE = re.compile(
    r"defen[cs]e\w*|defending|mitigat\w+|counter\w*|auditing|audits\b"
    r"|safeguard\w*|hardening|robust\w* against|protect\w* against"
    r"|\b_against\b|\bagainst\b",
    re.I,
)
# Topics whose papers are usually *attacks*; defense-intent redirects them.
ATTACK_TOPICS = {
    "Jailbreaking & Red Teaming",
    "Prompt Injection & LLM Attacks",
    "Reward Hacking & Deceptive Alignment",
}


def classify(text_low: str, title_low: str, hint: str | None) -> tuple[str | None, int]:
    """Score every topic's patterns; return (best_topic, score).

    Topic patterns scored by how often they appear (+2 bonus for hits inside
    titles). Ties between top scores fall back to the topic whose query found
    the paper first (the hint). Defensive-intent papers whose best topic is
    an attack category get redirected to the defense bucket -- this fallback
    only runs when the LLM classifier is unavailable.
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
        best = hint
    else:
        best = best_topics[0]

    defense_topic = "Defenses, Privacy & Robustness"
    if (
        best in ATTACK_TOPICS
        and scores.get(defense_topic, 0) >= 1
        and DEFENSE_CONTEXT_RE.search(text_low)
    ):
        return defense_topic, max(best_score, scores[defense_topic])
    return best, best_score


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


def rank_score(paper: dict) -> float:
    """Blend rule evidence, HF community signal and LLM judgment (bounded)."""
    upvotes = paper.get("upvotes", 0)
    hf_bonus = min(4.0, math.log1p(upvotes)) if upvotes else 0.0
    composite = paper["score"] + hf_bonus
    if paper.get("ai_rel") is not None:
        composite += 0.6 * paper["ai_rel"] + 0.4 * paper.get("ai_imp", 0)
    return round(composite, 2)


def build_ranked(candidates: list[dict], hf_votes: dict[str, int]) -> list[dict]:
    """De-duplicate, gate and classify candidates into scored papers."""
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
    print(f"[rank ] kept {sum(len(v) for v in ranked_by_topic.values())} "
          f"| gated/capped off {rejected} candidates")

    flat: list[dict] = []
    for plist in ranked_by_topic.values():
        plist.sort(key=lambda p: p["date"], reverse=True)
        plist.sort(key=lambda p: rank_score(p), reverse=True)
        flat.extend(plist)
    return flat


def _top_per_topic(papers: list[dict], cap: int) -> list[dict]:
    """Keep the best `cap` papers per topic (stable, rank-based)."""
    buckets: dict[str, list[dict]] = {}
    for p in sorted(papers, key=lambda p: p["date"], reverse=True):
        buckets.setdefault(p["category"], []).append(p)
    out: list[dict] = []
    for plist in buckets.values():
        plist.sort(key=lambda p: rank_score(p), reverse=True)
        out.extend(plist[:cap])
    return out


def apply_caps(papers: list[dict]) -> list[dict]:
    chosen = _top_per_topic(papers, PER_CATEGORY_CAP)
    chosen.sort(key=lambda p: rank_score(p), reverse=True)
    return chosen[:DAILY_CAP]


def compact_paper(p: dict) -> dict:
    return {k: p.get(k) for k in COMPACT_KEYS}


def select_papers(candidates: list[dict], hf_votes: dict[str, int]):
    """Full selection stage; LLM (when keyed) classifies & scores everything.

    The archive tier keeps ALL annotated papers; only the curated picks feed
    applies the LLM relevance/impact threshold and caps.
    """
    papers = build_ranked(candidates, hf_votes)
    curator = None
    if curate.llm_available():
        papers, stats = curate.curate(papers, list(TOPIC_COLORS.keys()))
        curator = stats.get("model")
        picks_pool = [p for p in papers if curate.passes_filter(p)]
    else:
        picks_pool = papers
    selected = apply_caps(picks_pool)
    return selected, curator, papers


def recompute_totals(days: list[dict]) -> tuple[dict[str, int], float, int]:
    """Recount per-topic totals across all tiers, de-duplicated by paper id."""
    counts: dict[str, int] = {c: 0 for c in TOPIC_COLORS}
    seen: set[str] = set()
    total = 0
    for d in days:
        for p in d.get("papers", []) + d.get("collected", []):
            if not isinstance(p, dict) or p.get("id") in seen:
                continue
            seen.add(p["id"])
            counts[p["category"]] = counts.get(p["category"], 0) + 1
    total = len(seen)
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


def merge_into_dataset(batch_date: str, selected: list[dict],
                       hf_votes: dict[str, int] | None = None,
                       curator: str | None = None,
                       collected_all: list[dict] | None = None) -> None:
    """Merge this run's picks + complete collection into data/papers.json.

    Two tiers per batch bucket:
      papers    -- curated picks (small reading feed, LLM-filtered)
      collected -- complete on-topic collection (powers stats & trends)
    """
    dataset = load_dataset()
    hf_votes = hf_votes or {}
    existing_ids = {
        p["id"]
        for d in dataset["days"]
        for arr in ("papers", "collected")
        for p in d.get(arr, [])
        if isinstance(p, dict) and "id" in p
    }

    days_by_date = {d["batch_date"]: d for d in dataset["days"]}
    fresh = [p for p in selected if p["id"] not in existing_ids]
    bucket = days_by_date.setdefault(
        batch_date, {"batch_date": batch_date, "papers": [], "collected": [],
                     "total_count": 0}
    )
    bucket.setdefault("collected", [])
    known_in_bucket = {p["id"] for p in bucket["papers"]}
    added = [p for p in fresh if p["id"] not in known_in_bucket]
    bucket["papers"].extend(added)

    # Complete-collection tier: everything on-topic from this run.
    known_in_archive = {p["id"] for p in bucket["collected"]}
    arch_added = [
        compact_paper(p) for p in (collected_all or [])
        if p["id"] not in existing_ids and p["id"] not in known_in_archive
    ]
    bucket["collected"].extend(arch_added)

    # Re-apply the latest HF community signal to every stored paper so
    # badges and rankings stay current even for previously collected items.
    for p in bucket["papers"]:
        p["upvotes"] = max(p.get("upvotes", 0), hf_votes.get(p["id"], 0))
    for p in bucket["collected"]:
        p["upvotes"] = max(p.get("upvotes") or 0, hf_votes.get(p["id"], 0))
    bucket["total_count"] = len(bucket["papers"])
    bucket["archived_count"] = len(bucket["collected"])

    merged_days = sorted(days_by_date.values(), key=lambda d: d["batch_date"], reverse=True)
    counts, proportions, total = recompute_totals(merged_days)
    total_picks = sum(len(d.get("papers", [])) for d in merged_days)

    out = {
        "last_updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "latest_day": merged_days[0]["batch_date"] if merged_days else None,
        "curated_by": curator or "rule-based",
        "total_today": next(
            (d["total_count"] for d in merged_days if d["batch_date"] == batch_date), 0
        ),
        "categories": list(TOPIC_COLORS.keys()),
        "topic_colors": TOPIC_COLORS,
        "proportions": proportions,
        "category_counts": counts,
        "total_papers": total,
        "total_picks": total_picks,
        "days": merged_days,
    }
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    DATA_FILE.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[merge] +{len(added)} picks, +{len(arch_added)} archived into {batch_date}")
    print(f"[write] data/papers.json | corpus {total} on-topic ({total_picks} curated)")


def collect(days_back: int):
    pool: list[dict] = []
    for tk, rules in CATEGORY_RULES.items():
        pool.extend(fetch_category_batch(tk, rules["queries"]))
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days_back)).strftime(DATE_FORMAT)
    recent = [e for e in pool if e["published"][:10] >= cutoff]
    print(f"[pool ] {len(pool)} raw entries | {len(recent)} within last {days_back} days")
    hf_votes = fetch_hf_upvotes(days_back)
    selected, curator, ranked_all = select_papers(recent, hf_votes)
    return selected, hf_votes, curator, ranked_all


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--full", action="store_true", help="wider backfill window")
    args = parser.parse_args(argv)

    days_back = FETCH_DAYS * (6 if args.full else 1)
    selected, hf_votes, curator, ranked_all = collect(days_back)
    if not selected and not ranked_all:
        print("[warn] nothing collected this run; dataset unchanged")
        return 0
    # Key the batch by HARVEST date, not paper publication date: arXiv's
    # announcement calendar (weekend gaps, ~48h lag) otherwise pins the
    # newest bucket label on the same day for days and the dashboard
    # looks frozen even while papers keep flowing in.
    batch = datetime.now(timezone.utc).strftime(DATE_FORMAT)
    if ranked_all:
        newest_paper = max(p["date"] for p in ranked_all)
        print(f"[batch] harvest {batch} | newest paper published {newest_paper}")
    merge_into_dataset(batch, selected, hf_votes, curator, ranked_all)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
