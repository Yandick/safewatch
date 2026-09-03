# AGENTS.md — operating guide for AI agents working on SafeWatch

SafeWatch is an LLM/agent-safety research radar: it harvests arXiv papers
daily (GitHub Actions), classifies them, and serves an interactive dashboard
(GitHub Pages). This document tells YOU (Claude Code, opencode, Codex, or any
file-native agent) how to operate, analyze, and evolve the system.

## Ground rules

1. Never call paid LLM APIs as part of pipelines. Deterministic Python only.
   (LLM judgment happens ONLY inside the scheduled workflow via the user's
   own zenmux key, or interactively by the user running you.)
2. Never hand-edit `data/papers.json` or `data/graph.json`. They are
   generated. To change them, run the scripts or change the scripts.
3. Write your analysis outputs to `memory/findings/YYYY-MM-DD-<slug>.md`.
   Never delete or rewrite past findings — append new ones (episodic memory).
4. Record every taxonomy/prompt/policy change in `memory/decisions.md`
   (semantic memory) with date, rationale, and evidence links.
5. Cite evidence for any claim: paper ids, graph paths, or tool output.

## Architecture map

```
scripts/update_data.py   daily harvest: arXiv queries → gate → classify → merge
scripts/curate.py        LLM stage (CI-only): topic/scores/TL;DR via zenmux
scripts/enrich.py        TF-IDF relatedness, topic momentum, emerging keywords
scripts/graph.py         research relation graph → data/graph.json
scripts/reclassify.py    retroactive re-classification of stored papers
agent/tools.py           READ-ONLY query/analysis CLI (your main instrument)
agent/prompts/           versioned prompt templates for recurring analyses
memory/                  your memory (see below)
index.html + assets/     the dashboard (do not restructure casually)
```

## Data contracts

- `data/papers.json` — `days[]` = harvest buckets; each has `papers`
  (curated picks, rich fields incl. `tldr`, `ai_rel`, `ai_imp`, `related`)
  and `collected` (complete on-topic archive, compact). Top-level
  `momentum`, `emerging`, `category_counts`, `proportions`.
- `data/graph.json` — `nodes` (`p:<arxiv_id>` papers with `step` =
  first-harvest index; `c:<term>` concepts with `df`), `links` (`k` in
  `pp|pc|cc`), `conceptSeries` (cumulative docs per concept per step),
  `steps` (harvest dates).
- `data/abstracts.json` — id → abstract cache.

## Commands

```powershell
& D:\Anaconda\envs\safewatch\python.exe scripts/update_data.py   # harvest
& D:\Anaconda\envs\safewatch\python.exe scripts/graph.py         # rebuild graph
& D:\Anaconda\envs\safewatch\python.exe agent/tools.py stats     # read tools
python -m http.server 8000                                       # local site
```

CI (`.github/workflows/update.yml`) runs harvest+enrich+graph+deploy
twice daily. Local runs without `ZENMUX_API_KEY` skip LLM stages — fine.

## Your instrument: agent/tools.py (read-only)

```
python agent/tools.py stats
python agent/tools.py papers --topic "Agentic AI Safety" --since 2026-08-28 --min-impact 7 --format md
python agent/tools.py concept --term sandbagging
python agent/tools.py edge --a prompt\ injection --b agent
python agent/tools.py forecast
python agent/tools.py search --q "watermark"
```

## The weekly research-analyst loop (your main job)

When the user (or a schedule) asks for an analysis round:
1. `tools.py stats` — corpus state.
2. `tools.py forecast` — directional candidates (naive extrapolation;
   treat as hypotheses, not facts).
3. Pick 2–3 hypotheses worth reading for. For each, use `papers` / `concept`
   / `edge` to gather evidence. Read what you must (arXiv links).
4. Write `memory/findings/<today>-<slug>.md`: Claim → Evidence (ids/paths)
   → Confidence → What would change my mind.
5. Update `memory/state.md` (rolling summary, ≤80 lines: what the field is
   doing this month, open questions you track, pointers into findings).
6. If the taxonomy itself looks wrong (systematic misclassification), propose
   an edit to `CATEGORY_RULES` in `scripts/update_data.py` as a diff, log it
   in `memory/decisions.md`, and wait for user approval before applying.

## Memory layout (CoALA-style)

- `memory/state.md` — working memory: the rolling situation summary.
- `memory/findings/` — episodic: dated, immutable analysis notes.
- `memory/decisions.md` — semantic: evolving truths, taxonomy rationale.
- `agent/prompts/` — procedural: reusable prompt templates.

## Compatibility

Any agent that reads the repo can operate: Claude Code and opencode load
this file automatically; Codex-compatible tools read `AGENTS.md`; everything
is plain files + stdlib CLI, so no plugin is required. An MCP server wrapper
for `agent/tools.py` is planned (`agent/mcp_server.py`) — until then, shell
access to the CLI is the interface.
