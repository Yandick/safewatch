"""Build the research relation graph (data/graph.json).

Deterministic, zero-cost construction from the harvested corpus:

  nodes  paper   one per collected paper (sized by impact/upvotes)
         concept top terms (TF-IDF vocabulary, plural-folded)
  links  paper-paper       from the precomputed ``related`` lists
         paper-concept     top TF-IDF concepts of the paper
         concept-concept   co-occurrence within papers (both in top concepts)

  steps  harvest dates (batch buckets) -- the net is replayed step by step:
         each paper carries the step index when it first entered the corpus,
         each concept carries a cumulative per-step document count. This is
         what makes the network *dynamic*: the UI can grow it day by day.

Output budget is capped (nodes/links) so graph.json stays a few hundred KB.

Usage: python scripts/graph.py
"""
from __future__ import annotations

import json
import math
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import enrich  # noqa: E402  (reuses tokenize/stopwords)
import update_data as ud  # noqa: E402

GRAPH_FILE = ud.ROOT / "data" / "graph.json"

MAX_CONCEPTS = 160
CONCEPT_DF_MIN = 5          # min documents containing a concept
CONCEPTS_PER_PAPER = 6      # strongest paper-concept links kept
COOCCUR_MIN = 5             # min shared papers for a concept-concept edge
CC_EDGE_CAP = 500           # cap on concept-concept edges (by weight)
TITLE_MAX = 72


def short_title(t: str) -> str:
    t = t.strip()
    return t if len(t) <= TITLE_MAX else t[: TITLE_MAX - 1].rstrip() + "…"


def main() -> int:
    data = ud.load_dataset()
    abstracts = enrich.load_json(enrich.ABSTRACTS_FILE, {})

    # ---- unique papers + first-seen harvest step ----
    steps = sorted({d["batch_date"] for d in data["days"]})
    step_idx = {s: i for i, s in enumerate(steps)}

    unique: dict[str, dict] = {}
    first_step: dict[str, int] = {}
    for d in sorted(data["days"], key=lambda x: x["batch_date"]):
        si = step_idx[d["batch_date"]]
        for p in d.get("papers", []) + d.get("collected", []):
            if not isinstance(p, dict) or not p.get("id"):
                continue
            if p["id"] not in unique:
                unique[p["id"]] = p
                first_step[p["id"]] = si

    print(f"[graph] {len(unique)} papers across {len(steps)} harvest steps")

    # ---- concepts ----
    texts: dict[str, str] = {}
    toks: dict[str, list[str]] = {}
    for pid, p in unique.items():
        t = f'{p.get("title", "")} {abstracts.get(pid, p.get("abstract", ""))}'
        texts[pid] = t
        toks[pid] = enrich.tokenize(t)

    df: Counter = Counter()
    for toks_p in toks.values():
        df.update(set(toks_p))
    concepts = [t for t, c in df.most_common(MAX_CONCEPTS) if c >= CONCEPT_DF_MIN]
    concept_set = set(concepts)
    print(f"[graph] {len(concepts)} concepts (df>={CONCEPT_DF_MIN})")

    # ---- paper vectors (tf-idf over concept vocabulary) ----
    n_docs = len(unique)
    vecs: dict[str, dict[str, float]] = {}
    for pid, toks_p in toks.items():
        tf = Counter(t for t in toks_p if t in concept_set)
        if not tf:
            vecs[pid] = {}
            continue
        v = {t: (c / len(toks_p)) * (math.log(n_docs / df[t]) + 1.0)
             for t, c in tf.items()}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1.0
        vecs[pid] = {t: x / norm for t, x in v.items()}

    # dominant topic per concept (for coloring) + paper sets per concept
    concept_papers: dict[str, list[str]] = {t: [] for t in concepts}
    concept_topic: dict[str, Counter] = {t: Counter() for t in concepts}
    for pid, p in unique.items():
        for t in vecs[pid]:
            concept_papers[t].append(pid)
            concept_topic[t][p["category"]] += 1

    # ---- nodes ----
    colors = ud.TOPIC_COLORS
    nodes = []
    for pid, p in unique.items():
        impact = p.get("ai_imp") or p.get("score") or 1
        nodes.append({
            "id": f"p:{pid}",
            "type": "paper",
            "label": short_title(p["title"]),
            "topic": p["category"],
            "impact": min(int(impact), 10),
            "upvotes": p.get("upvotes") or 0,
            "repo": bool(p.get("repo")),
            "curated": bool(p.get("curated")),
            "step": first_step[pid],
        })
    for t in concepts:
        dom = concept_topic[t].most_common(1)
        dom_topic = dom[0][0] if dom else "Defenses, Privacy & Robustness"
        nodes.append({
            "id": f"c:{t}",
            "type": "concept",
            "label": t,
            "df": df[t],
            "domTopic": dom_topic,
            "domColor": colors.get(dom_topic, "#8b93a7"),
        })

    # ---- links ----
    links = []
    seen_pair = set()

    def add_pair(a: str, b: str, w: float, kind: str):
        key = (a, b) if a < b else (b, a)
        if key in seen_pair:
            return
        seen_pair.add(key)
        links.append({"s": key[0], "t": key[1], "w": round(w, 3), "k": kind})

    for pid, p in unique.items():
        rel = p.get("related") or []
        for rank, oid in enumerate(rel):
            if oid in unique:
                add_pair(f"p:{pid}", f"p:{oid}", max(1.0 - rank * 0.12, 0.5), "pp")
    for pid, v in vecs.items():
        top = sorted(v.items(), key=lambda kv: -kv[1])[:CONCEPTS_PER_PAPER]
        for t, w in top:
            add_pair(f"p:{pid}", f"c:{t}", round(w * 2.0, 3), "pc")

    cc = Counter()
    pair_docs: dict[tuple, list[str]] = {}
    for pid, v in vecs.items():
        ts = sorted(v)
        for i in range(len(ts)):
            for j in range(i + 1, len(ts)):
                cc[(ts[i], ts[j])] += 1
                pair_docs.setdefault((ts[i], ts[j]), []).append(pid)
    cc_edges = [(pair, c) for pair, c in cc.items() if c >= COOCCUR_MIN]
    cc_edges.sort(key=lambda kv: -kv[1])
    for (a, b), c in cc_edges[:CC_EDGE_CAP]:
        add_pair(f"c:{a}", f"c:{b}", round(c / max(df[a], df[b]), 3), "cc")
    print(f"[graph] links: {len(links)} (pp+pc+cc)")

    # ---- concept cumulative series per step ----
    concept_series = {}
    for t in concepts:
        s = []
        cum = 0
        for si in range(len(steps)):
            cum += sum(1 for pid in concept_papers[t] if first_step[pid] == si)
            s.append(cum)
        concept_series[t] = s

    out = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "steps": steps,
        "topicColors": colors,
        "nodes": nodes,
        "links": links,
        "conceptSeries": concept_series,
        "conceptPapers": {
            t: sorted(
                concept_papers[t],
                key=lambda pid: -(unique[pid].get("ai_imp") or unique[pid].get("score") or 0),
            )[:12]
            for t in concepts
        },
    }
    GRAPH_FILE.parent.mkdir(parents=True, exist_ok=True)
    GRAPH_FILE.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    size_kb = GRAPH_FILE.stat().st_size // 1024
    print(f"[write] data/graph.json | {len(nodes)} nodes, {len(links)} links, {size_kb} KB")
    return 0


from datetime import datetime, timezone  # noqa: E402  (used for timestamp)

if __name__ == "__main__":
    raise SystemExit(main())
