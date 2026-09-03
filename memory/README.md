# memory/ — agent memory (CoALA-style)

- `state.md` — working memory: the rolling ≤80-line situation summary.
  Keep it current; it is the first thing an agent reads.
- `findings/` — episodic memory: dated, immutable analysis notes
  (`YYYY-MM-DD-<slug>.md`). Append, never rewrite.
- `decisions.md` — semantic memory: taxonomy rationale, policy changes.

Agents: read `AGENTS.md` at the repo root first.
