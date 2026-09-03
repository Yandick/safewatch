"""SafeWatch read-only analysis CLI — the instrument for AI agents.

Every subcommand reads only the generated datasets (data/*.json) and prints
either JSON or markdown to stdout, so any agent (Claude Code, opencode,
Codex, or a plain shell) can consume it. No network, no API keys.

Subcommands:
  stats                          corpus overview
  papers [--topic T] [--since D] [--min-impact N] [--has-repo]
         [--limit N] [--format json|md]
  concept --term TERM            concept: frequency, series, papers, neighbors
  edge --a TERM --b TERM         question evolution: pair series + papers
  forecast                       naive next-step extrapolation per concept
  search --q QUERY               substring search over title+abstract
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import enrich  # noqa: E402
import update_data as ud  # noqa: E402


def load_all():
    data = ud.load_dataset()
    abstracts = enrich.load_json(enrich.ABSTRACTS_FILE, {})
    graph = enrich.load_json(ud.ROOT / "data" / "graph.json", {})
    # unique papers, preserving curated richness
    uniq = {}
    for day in data["days"]:
        for p in day.get("collected", []):
            uniq.setdefault(p["id"], p)
        for p in day.get("papers", []):
            p = dict(p)
            p["curated"] = True
            uniq[p["id"]] = p  # picks override
    for pid, p in uniq.items():
        p.setdefault("abstract", abstracts.get(pid, ""))
    return data, uniq, graph


def text_of(p: dict) -> str:
    return f'{p.get("title", "")} {p.get("abstract", "")}'.lower()


def cmd_stats(args, data, uniq, graph):
    out = {
        "generated": data.get("last_updated"),
        "papers": len(uniq),
        "curated": sum(1 for p in uniq.values() if p.get("curated")),
        "with_code": sum(1 for p in uniq.values() if p.get("repo")),
        "harvest_steps": data.get("days", [{}])[0].get("batch_date"),
        "steps_total": len(data.get("days", [])),
        "category_counts": data.get("category_counts"),
        "proportions": data.get("proportions"),
        "momentum": data.get("momentum"),
        "emerging": [e["term"] for e in data.get("emerging", [])],
        "graph": (
            {
                "nodes": len(graph.get("nodes", [])),
                "links": len(graph.get("links", [])),
                "steps": graph.get("steps", []),
            }
            if graph
            else None
        ),
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))


def select_papers(args, uniq):
    rows = []
    for p in uniq.values():
        if args.topic and p.get("category") != args.topic:
            continue
        if args.since and (p.get("date") or "") < args.since:
            continue
        impact = p.get("ai_imp") or p.get("score") or 0
        if args.min_impact and impact < args.min_impact:
            continue
        if args.has_repo and not p.get("repo"):
            continue
        if args.q and args.q.lower() not in text_of(p):
            continue
        rows.append(p)
    rows.sort(
        key=lambda p: p.get("date", ""), reverse=True
    )
    return rows[: args.limit]


def fmt_md(rows):
    out = []
    for p in rows:
        out.append(
            f"## {p['title']}\n"
            f"- {p.get('category')} · {p.get('date')} · impact "
            f"{p.get('ai_imp', '?')}/10 · {p.get('url')}"
            + (f"\n- code: {p['repo']}" if p.get("repo") else "")
            + (f"\n- TL;DR: {p['tldr']}" if p.get("tldr") else "")
            + (f"\n- note: {p['abstract'][:400]}" if not p.get("tldr") else "")
            + "\n"
        )
    return "\n".join(out)


def cmd_papers(args, data, uniq, graph):
    rows = select_papers(args, uniq)
    if args.format == "md":
        print(fmt_md(rows))
    else:
        print(json.dumps(rows, ensure_ascii=False, indent=2))


def cmd_concept(args, data, uniq, graph):
    term = args.term.lower()
    series = (graph.get("conceptSeries") or {}).get(term)
    steps = graph.get("steps", [])
    matches = [p for p in uniq.values() if term in enrich.tokenize(text_of(p))]
    matches.sort(
        key=lambda p: p.get("ai_imp") or p.get("score") or 0, reverse=True
    )
    neighbors = []
    for l in graph.get("links", []):
        if l.get("k") != "cc":
            continue
        pair = {l["s"], l["t"]}
        if f"c:{term}" in pair:
            other = (pair - {f"c:{term}"}).pop()[2:]
            neighbors.append((other, l["w"]))
    neighbors.sort(key=lambda kv: -kv[1])
    out = {
        "term": term,
        "df_total": (graph.get("nodes") and next(
            (n.get("df") for n in graph["nodes"]
             if n.get("id") == f"c:{term}"), None)),
        "series_per_step": dict(zip(steps, series)) if series else None,
        "top_papers": [
            {
                "id": p["id"],
                "title": p["title"],
                "category": p.get("category"),
                "impact": p.get("ai_imp") or p.get("score"),
                "url": p.get("url"),
            }
            for p in matches[: args.limit]
        ],
        "co_occurring": [t for t, _ in neighbors[:12]],
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))


def cmd_edge(args, data, uniq, graph):
    a, b = args.a.lower(), args.b.lower()
    steps = graph.get("steps", [])
    sa = (graph.get("conceptSeries") or {}).get(a, [])
    sb = (graph.get("conceptSeries") or {}).get(b, [])
    ta = {p for p in uniq if a in enrich.tokenize(text_of(uniq[p]))}
    tb = {p for p in uniq if b in enrich.tokenize(text_of(uniq[p]))}
    both = ta & tb
    per_step = [0] * len(steps)
    for pid in both:
        # find step of pid via days scan
        for i, day in enumerate(data["days"]):
            if any(x["id"] == pid for x in day.get("papers", []) + day.get("collected", [])):
                per_step[i] += 1
                break
    c = 0
    cum_pair = []
    for v in per_step:
        c += v
        cum_pair.append(c)
    rep = sorted(
        (uniq[pid] for pid in both),
        key=lambda p: p.get("ai_imp") or p.get("score") or 0,
        reverse=True,
    )[: args.limit]
    out = {
        "pair": [a, b],
        "steps": steps,
        "series_a": sa,
        "series_b": sb,
        "pair_new_per_step": per_step,
        "pair_cumulative": cum_pair,
        "shared_papers": len(both),
        "representative": [
            {"id": p["id"], "title": p["title"], "url": p.get("url")} for p in rep
        ],
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))


def cmd_forecast(args, data, uniq, graph):
    """Naive slope-based extrapolation. Hypotheses, not facts."""
    steps = graph.get("steps", [])
    series = graph.get("conceptSeries") or {}
    momentum = data.get("momentum") or {}
    emerging = [e["term"] for e in data.get("emerging", [])]

    scored = []
    for term, s in series.items():
        if len(s) < 2:
            continue
        k = min(3, len(s))
        window = s[-k:]
        slope = (window[-1] - window[0]) / (k - 1)
        accel = slope - ((s[-k - 1] - s[-k]) if len(s) > k else 0)
        scored.append(
            {
                "term": term,
                "cumulative": s[-1],
                "recent_slope": round(slope, 2),
                "acceleration": round(accel, 2),
                "projected_next": round(s[-1] + max(slope, 0)),
                "emerging_flag": term in emerging,
                "topic_momentum_pct": momentum,
            }
        )
    scored.sort(key=lambda d: (-d["acceleration"], -d["recent_slope"]))
    out = {
        "note": "naive linear extrapolation over harvest steps; hypotheses only",
        "steps": steps,
        "hot_concepts": scored[: args.limit],
        "emerging_now": emerging,
        "topic_momentum": momentum,
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))


def cmd_search(args, data, uniq, graph):
    rows = [
        p for p in uniq.values()
        if args.q.lower() in text_of(p)
    ]
    rows.sort(key=lambda p: p.get("date", ""), reverse=True)
    out = rows[: args.limit]
    if args.format == "md":
        print(fmt_md(out))
    else:
        print(json.dumps(out, ensure_ascii=False, indent=2))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("stats")

    sp = sub.add_parser("papers")
    sp.add_argument("--topic")
    sp.add_argument("--since", help="YYYY-MM-DD on paper date")
    sp.add_argument("--min-impact", type=int)
    sp.add_argument("--has-repo", action="store_true")
    sp.add_argument("--q")
    sp.add_argument("--limit", type=int, default=20)
    sp.add_argument("--format", choices=["json", "md"], default="json")

    sc = sub.add_parser("concept")
    sc.add_argument("--term", required=True)
    sc.add_argument("--limit", type=int, default=10)

    se = sub.add_parser("edge")
    se.add_argument("--a", required=True)
    se.add_argument("--b", required=True)
    se.add_argument("--limit", type=int, default=8)

    sf = sub.add_parser("forecast")
    sf.add_argument("--limit", type=int, default=12)

    ss = sub.add_parser("search")
    ss.add_argument("--q", required=True)
    ss.add_argument("--limit", type=int, default=15)
    ss.add_argument("--format", choices=["json", "md"], default="json")

    args = ap.parse_args()
    data, uniq, graph = load_all()

    if args.cmd == "stats":
        cmd_stats(args, data, uniq, graph)
    elif args.cmd == "papers":
        cmd_papers(args, data, uniq, graph)
    elif args.cmd == "concept":
        cmd_concept(args, data, uniq, graph)
    elif args.cmd == "edge":
        cmd_edge(args, data, uniq, graph)
    elif args.cmd == "forecast":
        cmd_forecast(args, data, uniq, graph)
    elif args.cmd == "search":
        cmd_search(args, data, uniq, graph)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
