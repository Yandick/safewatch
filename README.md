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
