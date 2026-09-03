"""Enrich the SafeWatch dataset with research-intelligence extras.

Runs inside the update workflow after scripts/update_data.py (also usable
standalone). Pure Python -- no extra dependencies, no API keys.

Produces, inside data/papers.json:
  * per paper ``related``   -- top-5 similar papers (TF-IDF cosine over
                               title + abstract)
  * ``momentum``            -- per-topic % change, last 7 days vs the week
                               before (based on harvest-date buckets)
  * ``emerging``            -- keywords whose document frequency jumped this
                               week vs the previous three weeks

And maintains the sidecar ``data/abstracts.json`` (id -> abstract) needed
for similarity: the archive tier stores no abstracts, so missing ones are
fetched from arXiv in batches and cached here across runs.
"""
from __future__ import annotations

import json
import math
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import update_data as ud  # noqa: E402

ABSTRACTS_FILE = ud.ROOT / "data" / "abstracts.json"
TOP_K_RELATED = 5

STOPWORDS = set(
    """a an the and or of to in for on with we our is are be by that this these those
    from as at it its into than then their they there which what when where who how
    can could will would may might must shall should has have had not no nor but also
    more most other others such so if while about over under between both each few
    some any all one two three four five first second third new novel paper papers
    method methods approach approaches experiment experiments experimental result
    results show shows shown show propose proposed proposes present presented study
    studies based using use used achieve achieving achieved across high real large
    small different various several recent many much well make made give given
    however therefore thus additionally furthermore moreover respectively via
    beyond against without within during after before between among through
    literature work works research field task tasks setting settings case cases
    find finds found demonstrate demonstrates demonstrated evaluate evaluated
    evaluation analysis improve improved improvement outperform outperforms
    always often often yet ever still even also less least own same another
    identify identified identifying include included including cannot
    success successful increasingly response responses critical
    whether though although generate generates generated generating""".split()
)

# Domain-generic for an LLM-safety corpus: present in nearly every paper, so
# they carry zero "emerging" signal. Applied ONLY to emerging-keyword
# counting (tokenize_novel) -- concept vocabulary (net/forest/relatedness)
# keeps richer words like agent, prompt, injection, alignment via tokenize().
DOMAIN_STOPWORDS = set(
    """llm llms llm-based language model models ai artificial intelligence
    safety safe security secure attack attacks attacker adversarial adversarial-attack
    agent agents agentic agent-based prompt prompts jailbreak jailbreaks
    jailbreaking chatgpt gpt gpt-4 gpt-4o openai defense defenses defensive
    benchmark benchmarks dataset datasets evaluation evaluations evaluate test tests
    training trained train fine-tuning finetuning performance code code-generated
    existing remain remains rate rates framework frameworks introduce introduces
    introduced only rather data behavior behaviors capability capabilities
    ability abilities key main further potential scenario scenarios world
    human humans system systems text texts question questions source sources
    online available open released detail details provide provides providing
    develop developed development design designed address addressed addressing
    identify identified identifying include included including cannot
    success successful increasingly response responses critical
    whether though although generate generates generated generating
    whether though although
    mechanism mechanisms signal signals content generation generative
    utility context""".split()
)

WORD_RE = re.compile(r"[a-z][a-z\-]{2,}")


def fold_plural(w: str) -> str:
    """Crude singular folding so model/models, agent/agents count together."""
    if w.endswith("ies") and len(w) > 4:
        return w[:-3] + "y"
    if w.endswith("s") and len(w) > 3 and not w.endswith("ss") and not w.endswith("us"):
        return w[:-1]
    return w


def tokenize(text: str) -> list[str]:
    """Vocabulary for concepts + TF-IDF relatedness (rich words kept)."""
    out = []
    for w in WORD_RE.findall(text.lower()):
        if w in STOPWORDS or len(w) >= 25:
            continue
        folded = fold_plural(w)
        if folded in STOPWORDS:
            continue
        out.append(folded)
    return out


def tokenize_novel(text: str) -> list[str]:
    """Vocabulary for emerging-keyword detection (domain-generic removed)."""
    out = []
    for w in WORD_RE.findall(text.lower()):
        if w in STOPWORDS or w in DOMAIN_STOPWORDS or len(w) >= 25:
            continue
        folded = fold_plural(w)
        if folded in STOPWORDS or folded in DOMAIN_STOPWORDS:
            continue
        out.append(folded)
    return out


def load_json(path: Path, default):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return default


def sync_abstracts(unique_papers: dict[str, dict]) -> dict[str, str]:
    """Ensure every stored paper has an abstract in the sidecar."""
    abstracts: dict[str, str] = load_json(ABSTRACTS_FILE, {})
    missing = [
        pid for pid, p in unique_papers.items()
        if not abstracts.get(pid) and not p.get("abstract")
    ]
    if missing:
        print(f"[abs  ] fetching {len(missing)} missing abstracts from arXiv...")
        for start in range(0, len(missing), 100):
            chunk = missing[start:start + 100]
            params = urllib.parse.urlencode({
                "id_list": ",".join(chunk), "max_results": str(len(chunk)),
            })
            url = f"{ud.ARXIV_API}?{params}"
            try:
                req = urllib.request.Request(
                    url, headers={"User-Agent": "SafeWatch/1.0"})
                with urllib.request.urlopen(req, timeout=60) as resp:
                    import feedparser
                    feed = feedparser.parse(resp.read())
            except Exception as exc:  # noqa: BLE001
                print(f"  !! abstract fetch failed ({exc}); will retry next run")
                continue
            for e in feed.entries:
                m = ud.ARXIV_ID_RE.search(e.get("id", ""))
                if m:
                    abstracts[m.group(1)] = re.sub(
                        r"\s+", " ", e.get("summary", "")).strip()
            time.sleep(3.0)
    # also remember abstracts that arrived embedded in picks
    for pid, p in unique_papers.items():
        if p.get("abstract") and not abstracts.get(pid):
            abstracts[pid] = p["abstract"]
    ABSTRACTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    ABSTRACTS_FILE.write_text(
        json.dumps(abstracts, ensure_ascii=False), encoding="utf-8")
    print(f"[abs  ] sidecar holds {len(abstracts)} abstracts")
    return abstracts


def compute_related(unique_papers: dict[str, dict], abstracts: dict[str, str]) -> int:
    """TF-IDF cosine similarity; writes top-5 ids into each paper."""
    texts: dict[str, list[str]] = {}
    for pid, p in unique_papers.items():
        texts[pid] = tokenize(f'{p.get("title", "")} {abstracts.get(pid, "")}')
    df: Counter = Counter()
    for toks in texts.values():
        df.update(set(toks))
    n_docs = len(texts)
    if n_docs < 2:
        return 0
    idf = {t: math.log(n_docs / c) + 1.0 for t, c in df.items()}

    vecs: dict[str, dict[str, float]] = {}
    for pid, toks in texts.items():
        tf: Counter = Counter(toks)
        v = {t: (c / len(toks)) * idf.get(t, 1.0) for t, c in tf.items()}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1.0
        vecs[pid] = {t: x / norm for t, x in v.items()}

    # index vectors by term for sparse scoring
    by_term: dict[str, list[str]] = {}
    for pid, v in vecs.items():
        for t in v:
            by_term.setdefault(t, []).append(pid)

    enriched = 0
    for pid, v in vecs.items():
        scores: dict[str, float] = {}
        for t, w in v.items():
            for other in by_term.get(t, ()):
                if other == pid:
                    continue
                scores[other] = scores.get(other, 0.0) + w * vecs[other][t]
        top = sorted(scores.items(), key=lambda kv: -kv[1])[:TOP_K_RELATED]
        unique_papers[pid]["related"] = [o for o, _ in top]
        enriched += 1
    return enriched


def week_windows():
    now = datetime.now(timezone.utc)
    cur_start = now - timedelta(days=7)
    prev_start = now - timedelta(days=14)
    return (
        cur_start.strftime(ud.DATE_FORMAT),  # current window start
        prev_start.strftime(ud.DATE_FORMAT),  # previous window start
    )


def compute_momentum_and_emerging(
    days: list[dict], abstracts: dict[str, str]
) -> tuple[dict, list]:
    cur_start, prev_start = week_windows()
    today = datetime.now(timezone.utc).strftime(ud.DATE_FORMAT)

    def in_window(bucket_date, lo, hi):
        return lo <= bucket_date <= hi

    cur_days = [d for d in days if in_window(d["batch_date"], cur_start, today)]
    prev_days = [
        d for d in days if in_window(d["batch_date"], prev_start, cur_start)
    ]

    def topic_counts(bucket_days):
        c = Counter()
        for d in bucket_days:
            seen = set()
            for p in d.get("papers", []) + d.get("collected", []):
                if p.get("id") in seen:
                    continue
                seen.add(p["id"])
                c[p["category"]] += 1
        return c

    cur_c, prev_c = topic_counts(cur_days), topic_counts(prev_days)
    momentum = {}
    for topic in ud.TOPIC_COLORS:
        a, b = cur_c.get(topic, 0), prev_c.get(topic, 0)
        momentum[topic] = round((a - b) * 100 / max(b, 1)) if (a or b) else 0

    def term_freqs(bucket_days):
        docs = set()
        for d in bucket_days:
            for p in d.get("papers", []) + d.get("collected", []):
                docs.add(p["id"])
        tf: Counter = Counter()
        for pid in docs:
            text = f'{unique_text.get(pid, "")}'
            tf.update(set(tokenize_novel(text)))
        return tf

    unique_text = {}
    for d in days:
        for p in d.get("papers", []) + d.get("collected", []):
            if p.get("id") not in unique_text:
                unique_text[p["id"]] = (
                    f'{p.get("title", "")} {abstracts.get(p["id"], "")}'
                )

    cur_tf = term_freqs(cur_days)
    prev_tfs = []
    for w in range(3):  # previous three weeks
        lo = (datetime.now(timezone.utc) - timedelta(days=7 * (w + 2))).strftime(
            ud.DATE_FORMAT)
        hi = (datetime.now(timezone.utc) - timedelta(days=7 * (w + 1))).strftime(
            ud.DATE_FORMAT)
        prev_tfs.append(
            term_freqs([d for d in days if lo <= d["batch_date"] < hi])
        )
    persistent = set()
    for tf in prev_tfs:
        persistent.update(t for t, c in tf.items() if c >= 2)

    emerging = []
    for term, cnt in cur_tf.most_common(60):
        if cnt < 2 or term in persistent:
            continue
        prev_max = max((tf.get(term, 0) for tf in prev_tfs), default=0)
        if cnt >= prev_max + 1:
            emerging.append({"term": term, "count": cnt})
        if len(emerging) >= 10:
            break

    return momentum, emerging


def main() -> int:
    data = ud.load_dataset()
    unique: dict[str, dict] = {}
    for day in data["days"]:
        for p in day.get("papers", []) + day.get("collected", []):
            if isinstance(p, dict) and p.get("id") and p["id"] not in unique:
                unique[p["id"]] = p
    if not unique:
        print("[enrich] empty dataset; nothing to do")
        return 0

    abstracts = sync_abstracts(unique)
    n = compute_related(unique, abstracts)
    print(f"[rel  ] related-papers computed for {n} papers")
    momentum, emerging = compute_momentum_and_emerging(data["days"], abstracts)
    print(f"[mom  ] momentum: {momentum}")
    print(f"[emrg ] emerging: {[e['term'] for e in emerging]}")

    counts, proportions, total = ud.recompute_totals(data["days"])
    data["momentum"] = momentum
    data["emerging"] = emerging
    data["category_counts"] = counts
    data["proportions"] = proportions
    data["total_papers"] = total
    ud.DATA_FILE.write_text(
        json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[write] {ud.DATA_FILE.name} enriched")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
