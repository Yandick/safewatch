"""Retroactively repair stored papers' categories (and enrich metadata).

The archive tier stores compact records without abstracts, so this script
first re-fetches abstracts from arXiv by id, then re-runs classification:

  * with ZENMUX_API_KEY set -> LLM re-classifies every stored paper and
    also fills ai_rel / ai_imp / tldr where missing;
  * without a key -> the improved rule-based classifier (with
    defense-intent redirect) re-runs offline.

Finally stats/proportions are recomputed and a change log is printed.

Usage:
    python scripts/reclassify.py            # LLM if key present, else rules
Run on CI via the workflow's ``reclassify`` input.
"""
from __future__ import annotations

import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import curate  # noqa: E402
import update_data as ud  # noqa: E402

BATCH = 100


def fetch_abstracts(ids: list[str]) -> dict[str, str]:
    """Fetch abstracts for arXiv ids via the export API (id_list)."""
    out: dict[str, str] = {}
    for start in range(0, len(ids), BATCH):
        chunk = ids[start:start + BATCH]
        params = urllib.parse.urlencode({
            "id_list": ",".join(chunk),
            "max_results": str(len(chunk)),
        })
        url = f"{ud.ARXIV_API}?{params}"
        print(f"[abs  ] fetching {len(chunk)} abstracts from arXiv...")
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "SafeWatch/1.0"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                feed = feedparser_parse(resp.read())
        except Exception as exc:  # noqa: BLE001
            print(f"  !! failed ({exc}); these papers stay as-is")
            continue
        for e in feed:
            m = ud.ARXIV_ID_RE.search(e.get("id", ""))
            if m:
                out[m.group(1)] = re.sub(r"\s+", " ", e.get("summary", "")).strip()
        time.sleep(3.2)
    print(f"[abs  ] got {len(out)}/{len(ids)} abstracts")
    return out


def feedparser_parse(xml_bytes: bytes):
    import feedparser
    return feedparser.parse(xml_bytes).entries


def main() -> int:
    data = ud.load_dataset()
    topics = list(ud.TOPIC_COLORS.keys())

    # collect unique paper dicts across both tiers
    unique: dict[str, dict] = {}
    for day in data["days"]:
        for p in day.get("papers", []) + day.get("collected", []):
            if isinstance(p, dict) and p.get("id") and p["id"] not in unique:
                unique[p["id"]] = p
    print(f"[scan ] {len(unique)} unique stored papers")

    missing = [pid for pid, p in unique.items() if not p.get("abstract")]
    if missing:
        abstracts = fetch_abstracts(missing)
        for pid, abst in abstracts.items():
            unique[pid]["abstract"] = abst

    flat = list(unique.values())
    if curate.llm_available():
        print("[mode ] LLM re-classification")
        curate.curate(flat, topics)
    else:
        print("[mode ] rule-based re-classification (defense-intent fallback)")
        changed = 0
        for p in flat:
            text = f'{p["title"]} {p.get("abstract", "")}'.lower()
            if not ud.MODEL_HINT_RE.search(text):
                continue
            topic, _score = ud.classify(text, p["title"].lower(), None)
            if topic and topic != p.get("category"):
                changed += 1
                print(f'  {p["id"]}: {p.get("category")} -> {topic}')
                p["category"] = topic
        print(f"[rules] reclassified {changed} papers")

    counts, proportions, total = ud.recompute_totals(data["days"])
    data["category_counts"] = counts
    data["proportions"] = proportions
    data["total_papers"] = total
    data["total_picks"] = sum(len(d.get("papers", [])) for d in data["days"])
    ud.DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    ud.DATA_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False),
                            encoding="utf-8")
    print(f"[write] data/papers.json | corpus {total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
