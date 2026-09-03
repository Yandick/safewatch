# SafeWatch state — rolling summary (working memory)

_Last updated: 2026-09-03 by system bootstrap (no analyst run yet)._

## What the field is doing (past ~2 weeks of harvests)

- Corpus: 180+ on-topic papers across 5+ harvest steps; ~70 curated picks.
- Topic mix (approx, live numbers in `agent/tools.py stats`):
  Defenses largest (~35%), Agentic Safety growing fast, Reward Hacking
  smallest but rising (sycophancy / reward-tampering vocabulary newly added).
- LLM classifier (glm-5.3-flash via zenmux) judges topics by intent; rules
  only backfill. Known weak spot: taxonomy boundaries (e.g. jailbreak-defense
  vs jailbreak-attack) — resolved by LLM, monitored via decisions.md.

## Open questions tracked

1. Is Agentic AI Safety growth real or a vocabulary artifact? (catch-all
   query added 2026-09-02 — re-check after 2 weeks of data.)
2. Which defense paradigms dominate: training-time vs inference-time?
   (Not yet measurable — needs concept-level analysis via `tools.py`.)
3. Reward hacking papers cluster around RLHF fine-tuning — is "process
   reward models" a distinct sub-trend? Watch `concept --term reward`.

## Pointers

- Latest findings: `memory/findings/` (empty — first analyst run pending)
- Graph: `data/graph.json` (rebuilt每 run), dashboard `#net` view
- Harvest cron: 06:30 + 18:00 UTC; LLM stage needs ZENMUX_API_KEY secret
