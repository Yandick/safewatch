"""LLM curation stage for SafeWatch.

Calls an OpenAI-compatible endpoint (default: zenmux.ai) to score each
candidate paper for relevance & impact and produce a one-line Chinese
TL;DR. Papers below the acceptance threshold are dropped so that readers
see only a handful of high-value items per batch.

Runs entirely on CI (GitHub Actions runners reach zenmux.ai directly --
no VPN involved anywhere). Without ``ZENMUX_API_KEY`` set, every function
degrades gracefully and the pipeline stays purely rule-based.

Env knobs:
    ZENMUX_API_KEY   API key (set as a GitHub Actions secret)
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
import urllib.error
import urllib.request

SYSTEM_PROMPT = """You are a meticulous research assistant curating an LLM/agent-safety \
reading list for an academic group. You receive numbered arXiv candidates \
(titles + abstracts). For EACH item judge:
- relevance (0-10): how central is it to LLM/agentic AI SAFETY research \
(jailbreaking, prompt injection, reward hacking, agent misuse/safety, \
alignment, guardrails)? Pure NLP capability papers without a safety angle \
score <= 3.
- impact (0-10): likely significance -- novel method/threat/benchmark, \
rigor of claims, whether top groups are involved. Incremental or thin \
papers score low.
- why_zh: exactly ONE sentence in SIMPLIFIED CHINESE, max 40 characters, \
stating what the paper does and why it matters (or why it is weak). No \
preamble, no emoji.

Respond with ONLY minified JSON, no markdown fences:
{"results":[{"i":<number>,"relevance":<int>,"impact":<int>,"why_zh":"<...>"}]}"""


def llm_available() -> bool:
    return bool(os.environ.get("ZENMUX_API_KEY"))


def _settings() -> tuple[str, str]:
    base = os.environ.get("ZENMUX_BASE_URL", "https://zenmux.ai/api/v1").rstrip("/")
    model = os.environ.get("LLM_MODEL") or "z-ai/glm-5.3-flash"
    return base, model


def _thresholds() -> tuple[int, int]:
    return int(os.environ.get("PAPER_REL_MIN", 6)), int(os.environ.get(
        "PAPER_IMP_MIN", 5))


def _post_chat(base: str, api_key: str, payload: dict, timeout: int = 90) -> str:
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


def _score_batch(batch: list[tuple[int, dict]]) -> dict[int, dict]:
    """Call the LLM once for a numbered batch; return {index: verdict}."""
    base, model = _settings()
    api_key = os.environ["ZENMUX_API_KEY"]
    lines = [
        {
            "i": i,
            "title": p["title"],
            "abstract": p["abstract"][:1100],
        }
        for i, p in batch
    ]
    payload = {
        "model": model,
        "temperature": 0.2,
        "max_tokens": 2000,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(lines, ensure_ascii=False)},
        ],
    }
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            content = _post_chat(base, api_key, payload)
            data = _parse_json_blob(content)
            return {r["i"]: r for r in data.get("results", []) if "i" in r}
        except Exception as exc:  # noqa: BLE001 - retry, then give up gracefully
            last_err = exc
            wait = 4 * (attempt + 1)
            print(f"[llm  ] batch attempt {attempt + 1} failed ({exc}); retrying in {wait}s")
            time.sleep(wait)
    print(f"[llm  ] batch permanently failed ({last_err}); keeping its papers unscored")
    return {}


def curate(papers: list[dict]) -> tuple[list[dict], dict]:
    """Attach tldr / ai_rel / ai_imp; drop papers below threshold.

    Returns (kept_papers, stats). Any paper the LLM failed to score is kept
    (fail-open) so network hiccups never silently hide work.
    """
    if not papers:
        return papers, {"model": "n/a", "kept": 0, "dropped": 0}
    base, model = _settings()
    rel_min, imp_min = _thresholds()

    scored: dict[int, dict] = {}
    batch_size = 10
    for start in range(0, len(papers), batch_size):
        batch = list(enumerate(papers))[start:start + batch_size]
        scored.update(_score_batch(batch))
        time.sleep(1.0)

    kept, dropped = [], 0
    for i, p in enumerate(papers):
        v = scored.get(i)
        if v:
            try:
                p["ai_rel"] = max(0, min(10, int(v.get("relevance", 0))))
                p["ai_imp"] = max(0, min(10, int(v.get("impact", 0))))
                zh = str(v.get("why_zh", "")).strip()
                if 0 < len(zh) <= 80:
                    p["tldr"] = zh
            except (TypeError, ValueError):
                pass
        passes = (
            p.get("ai_rel") is not None
            and p["ai_rel"] >= rel_min
            and p.get("ai_imp", 0) >= imp_min
        )
        if v is None or passes:
            kept.append(p)
        else:
            dropped += 1

    print(f"[llm  ] curated by {model}: kept {len(kept)}, dropped {dropped} "
          f"(rel>={rel_min}, imp>={imp_min})")
    return kept, {"model": model, "kept": len(kept), "dropped": dropped}
