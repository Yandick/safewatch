"""LLM curation & classification stage for SafeWatch.

Calls an OpenAI-compatible endpoint (default: zenmux.ai) to, per paper:
  1. classify it into one of the dashboard topics (better intent judgment
     than regex rules, e.g. "defending against jailbreaks" -> Defenses);
  2. score relevance & impact (0-10);
  3. write a one-line Chinese TL;DR.

``curate()`` ANNOTATES every paper and never drops any -- the caller owns
keep/drop decisions (picks filtering) while the archive keeps everything.

Runs on CI (GitHub Actions reach zenmux.ai directly). Without
``ZENMUX_API_KEY`` every function degrades gracefully to a no-op.

Env knobs:
    ZENMUX_API_KEY   API key (GitHub Actions secret)
    ZENMUX_BASE_URL  default https://zenmux.ai/api/v1
    LLM_MODEL        default z-ai/glm-5.3-flash (see README for alternates)
    PAPER_REL_MIN    min relevance 0-10            (default 6)
    PAPER_IMP_MIN    min impact 0-10                (default 5)
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.request

DEFAULT_MODEL = "z-ai/glm-5.3-flash"


def build_system_prompt(topics: list[str]) -> str:
    topic_list = "\n".join(f"- {t}" for t in topics)
    return f"""You are a meticulous research assistant curating an LLM/agent-safety \
reading list for an academic group. You receive numbered arXiv candidates \
(titles + abstracts). For EACH item:

1. topic: choose the SINGLE best-fitting category from exactly this list:
{topic_list}
Judge by the paper's core CONTRIBUTION and INTENT, not by keywords. A paper
whose main contribution is defending against, auditing, detecting or
mitigating attacks belongs in a defense/evaluation category even when attack
words dominate its title. Pure NLP capability work without a safety angle
still gets the closest safety topic but relevance <= 3.
2. relevance (0-10): how central to LLM/agentic AI SAFETY research.
3. impact (0-10): likely significance -- novelty, rigor, benchmark value.
Incremental or thin papers score low.
4. why_zh: exactly ONE sentence in SIMPLIFIED CHINESE, max 40 characters, \
stating what the paper does and why it matters (or why it is weak). \
No preamble, no emoji.

Respond with ONLY minified JSON, no markdown fences:
{{"results":[{{"i":<number>,"topic":"<exact topic string>","relevance":<int>,\
"impact":<int>,"why_zh":"<...>"}}]}}"""


def llm_available() -> bool:
    return bool(os.environ.get("ZENMUX_API_KEY"))


def _settings() -> tuple[str, str]:
    base = os.environ.get("ZENMUX_BASE_URL", "https://zenmux.ai/api/v1").rstrip("/")
    model = os.environ.get("LLM_MODEL") or DEFAULT_MODEL
    return base, model


def thresholds() -> tuple[int, int]:
    return int(os.environ.get("PAPER_REL_MIN", 6)), int(os.environ.get(
        "PAPER_IMP_MIN", 5))


def _post_chat(base: str, api_key: str, payload: dict, timeout: int = 120) -> str:
    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = json.loads(resp.read())
    return body["choices"][0]["message"]["content"]


def _parse_json_blob(text: str) -> dict:
    text = text.strip()
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", text, re.S)
    if fence:
        text = fence.group(1)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        raise ValueError("no JSON object found")
    return json.loads(text[start:end + 1])


def _salvage_results(text: str) -> dict:
    """Lenient recovery: parse individual {...} objects from a corrupt blob.

    Models sometimes emit unescaped quotes inside Chinese sentences or get
    cut by token limits; strict parsing then kills the whole batch. This
    rescues every well-formed result object instead.
    """
    good = []
    for m in re.finditer(r"\{[^{}]*\}", text):
        try:
            obj = json.loads(m.group(0))
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and "i" in obj:
            good.append(obj)
    return {"results": good}


def _score_batch(batch: list[tuple[int, dict]], topics: list[str]) -> dict[int, dict]:
    """One LLM call per numbered batch; returns {index: verdict}."""
    base, model = _settings()
    api_key = os.environ["ZENMUX_API_KEY"]
    lines = [
        {"i": i, "title": p["title"], "abstract": (p.get("abstract") or "")[:1100]}
        for i, p in batch
    ]
    payload = {
        "model": model,
        "temperature": 0.1,
        "max_tokens": 4000,
        "messages": [
            {"role": "system", "content": build_system_prompt(topics)},
            {"role": "user", "content": json.dumps(lines, ensure_ascii=False)},
        ],
    }
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            content = _post_chat(base, api_key, payload)
            try:
                data = _parse_json_blob(content)
            except (json.JSONDecodeError, ValueError):
                data = _salvage_results(content)
                if not data["results"]:
                    raise ValueError("no salvageable result objects in output")
            return {r["i"]: r for r in data.get("results", []) if "i" in r}
        except Exception as exc:  # noqa: BLE001 - retry, then give up gracefully
            last_err = exc
            wait = 4 * (attempt + 1)
            print(f"[llm  ] batch attempt {attempt + 1} failed ({exc}); retrying in {wait}s")
            time.sleep(wait)
    print(f"[llm  ] batch permanently failed ({last_err}); its papers stay rule-classified")
    return {}


def curate(papers: list[dict], topics: list[str]) -> tuple[list[dict], dict]:
    """Annotate in place: category (LLM-judged), ai_rel, ai_imp, tldr.

    Drops nothing. Papers the LLM could not score keep their rule-based
    category and remain untouched (fail-open). Returns (papers, stats).
    """
    stats = {"model": "n/a", "scored": 0, "reclassified": 0}
    if not papers or not llm_available():
        return papers, stats
    base, model = _settings()
    stats["model"] = model
    topic_set = set(topics)

    scored: dict[int, dict] = {}
    batch_size = 8
    for start in range(0, len(papers), batch_size):
        batch = list(enumerate(papers))[start:start + batch_size]
        scored.update(_score_batch(batch, topics))
        time.sleep(1.0)

    for i, p in enumerate(papers):
        v = scored.get(i)
        if not v:
            continue
        old_cat = p.get("category")
        new_cat = str(v.get("topic", "")).strip()
        if new_cat in topic_set:
            p["category"] = new_cat
            if new_cat != old_cat:
                stats["reclassified"] += 1
        try:
            p["ai_rel"] = max(0, min(10, int(v.get("relevance", 0))))
            p["ai_imp"] = max(0, min(10, int(v.get("impact", 0))))
            zh = str(v.get("why_zh", "")).strip()
            if 0 < len(zh) <= 80:
                p["tldr"] = zh
            stats["scored"] += 1
        except (TypeError, ValueError):
            pass

    print(f"[llm  ] {model}: scored {stats['scored']}/{len(papers)}, "
          f"reclassified {stats['reclassified']}")
    return papers, stats


def passes_filter(p: dict) -> bool:
    """True unless the LLM explicitly scored it below the keep bar."""
    rel_min, imp_min = thresholds()
    if p.get("ai_rel") is None:
        return True  # unscored -> fail-open
    return p["ai_rel"] >= rel_min and p.get("ai_imp", 0) >= imp_min
