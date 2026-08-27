# SafeWatch · LLM & Agent Safety Radar

A fancy, self-updating dashboard that tracks the latest research on **LLM & agent
safety** — jailbreaking & red teaming, prompt injection, reward hacking &
deceptive alignment, agentic safety, safety training/alignment, and defenses.

- **Automatic collection** — a scheduled GitHub Actions job queries the arXiv API
  daily, gates for LLM relevance, classifies papers into sub-topics, and commits
  the curated dataset.
- **Live topic pie** — proportions per category update themselves as new papers
  arrive (clickable slices filter the feed).
- **Daily lists** — one batch per run, newest first; every paper links to arXiv,
  with a code-repository link when open-source (auto-detected from abstracts).
- **No build step** — plain HTML/CSS/JS + ECharts. Publishes free on GitHub Pages.

## Quick start (local)

```powershell
conda create -n safewatch python=3.12 -y
conda activate safewatch
pip install -r requirements.txt

python scripts/update_data.py        # fetch last 7 days from arXiv
python scripts/update_data.py --full # wider backfill window (~42 days)

python -m http.server 8000           # open http://localhost:8000
```

Environment knobs: `FETCH_DAYS=7 DAILY_CAP=24 PER_CATEGORY_CAP=6 FETCH_MAX=110`.

## Publish it for your group (free)

1. Create a GitHub repo and push this folder to the `main` branch.
2. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Run the workflow once manually: **Actions → Update papers & deploy →
   Run workflow** (you can set "days back" there for an initial backfill).
4. Share `https://<your-name>.github.io/<repo-name>/` — done. It refreshes
   itself every day at ~06:30 UTC.

> Want more curation? `/clear` then ask me to wire an LLM pass into
> `scripts/update_data.py` (e.g. an OpenAI-compatible API key stored in repo
> secrets) to write one-line takeaways or re-rank picks.

## AI curation (optional but recommended)

The pipeline has a built-in LLM stage: after rule-based classification, an
LLM scores every candidate for **relevance** and **impact** (0-10) and writes
a one-line Chinese TL;DR shown on each card. Papers below the bar are dropped,
so you read ~8–14 picks/day instead of 30.

Enable it in three steps:

```powershell
# 1. store your zenmux key as a repo secret (never paste keys into chat/repo)
gh secret set ZENMUX_API_KEY   # paste when prompted

# 2. (optional) pick another model — defaults to z-ai/glm-5.3-flash
gh variable set LLM_MODEL --body "qwen/qwen3.7-flash"

# 3. run the workflow once, or wait for the daily cron
gh workflow run update.yml
```

The next daily run is fully automatic — GitHub Actions calls zenmux.ai from its
own servers, so your computer/router/VPN play no role.

Candidate models seen on zenmux (Aug 2026, price per M tokens):

| Model | In | Out | Notes |
|---|---|---|---|
| `z-ai/glm-5.3-flash` *(default)* | $0.075 | $0.25 | ≈$0.004/day, reliable JSON |
| `qwen/qwen3.7-flash` | $0.03 | $0.13 | cheapest capable |
| `z-ai/glm-4.7-flash-free` | free | free | weaker judgment |
| `deepseek/deepseek-v4-flash` | $0.22 | $0.66 | strongest cheap reasoner |
| `openai/gpt-5.4-nano` | $0.20 | $1.25 | OpenAI-flavored fallback |

Strictness knobs (repo variables): `PAPER_REL_MIN` (default 6),
`PAPER_IMP_MIN` (default 5), `LLM_PRE_CAP_MULTIPLIER` (default 3).
If the key is absent or the API fails, curation silently skips and the site
runs purely rule-based — never breaks the daily update.

## Project layout

```
├── index.html                  # dashboard page
├── assets/
│   ├── style.css               # dark/light glassmorphism theme
│   └── app.js                  # rendering, ECharts pie, filters
├── data/papers.json            # accumulated dataset (updated by script/CI)
├── scripts/update_data.py      # arXiv fetch → gate → classify → merge
├── requirements.txt
└── .github/workflows/update.yml  # daily cron: update data + deploy Pages
```

## How classification works

Each topic owns two things in `scripts/update_data.py`:

- **queries** — arXiv API search strings used to gather candidates;
- **patterns** — scored regex evidence over title + abstract (title hits count
  extra). Ties fall back to the query that found the paper.

Every candidate must also clearly mention LLMs/language models (`MODEL_HINT_RE`)
to be kept. Adjust topics by editing `CATEGORY_RULES` — colors live in
`TOPIC_COLORS`.
