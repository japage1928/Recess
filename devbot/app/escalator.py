# ============================================================
# escalator.py — Phase 3 Escalation Gate
#
# Responsibilities:
#   1. Decide WHETHER to escalate (smart classifier)
#   2. Call Claude API at the right tier (Haiku → Sonnet → Opus)
#   3. Log every escalation with cost estimate
#   4. Return structured result identical to local model output
#      so main.py doesn't need to know which path was taken
# ============================================================

import json
import os
import re
import time
from typing import Optional
import httpx

from app.config import (
    ANTHROPIC_API_KEY,
    ESCALATION_MODEL,
    ESCALATION_MODEL_HAIKU,
    ESCALATION_MODEL_SONNET,
    ESCALATION_MODEL_OPUS,
    ESCALATION_TRIGGER_THRESHOLD,
    ESCALATION_MIN_CONFIDENCE,
    ALWAYS_ESCALATE_INTENTS,
    NEVER_ESCALATE_INTENTS,
    COST_PER_1K_TOKENS,
    AVG_TOKENS_PER_ESCALATION,
    COST_LOG_PATH,
    MAX_TOKENS,
)


# ── Escalation decision classifier ───────────────────────────
def should_escalate(
    confidence: float,
    intent: str,
    attempts: int,
    force: bool = False,
) -> tuple[bool, str]:
    """
    Decides whether to escalate to a paid API.

    Returns (should_escalate: bool, reason: str)

    Decision tree:
      1. force=True → always escalate
      2. intent in ALWAYS_ESCALATE_INTENTS → always escalate
      3. intent in NEVER_ESCALATE_INTENTS → never escalate
      4. No API key configured → never escalate
      5. confidence < ESCALATION_TRIGGER_THRESHOLD after retries → escalate
      6. Otherwise → stay local
    """
    if force:
        return True, "force_escalate=True in request"

    if intent in ALWAYS_ESCALATE_INTENTS:
        return True, f"intent '{intent}' always escalates"

    if intent in NEVER_ESCALATE_INTENTS:
        return False, f"intent '{intent}' never escalates"

    if not ANTHROPIC_API_KEY:
        return False, "no ANTHROPIC_API_KEY configured"

    if confidence < ESCALATION_TRIGGER_THRESHOLD and attempts >= 1:
        return True, f"confidence {confidence} < threshold {ESCALATION_TRIGGER_THRESHOLD} after {attempts} attempts"

    return False, f"confidence {confidence} acceptable for local"


def pick_escalation_model(intent: str, confidence: float) -> str:
    """
    Picks the cheapest model tier that can handle the task.

    Haiku  → simple components, hooks, style, most fallbacks
    Sonnet → multi-file, refactor, debug, navigation
    Opus   → architecture (reserved for truly complex)
    """
    if intent == "architecture":
        return ESCALATION_MODEL_SONNET  # Sonnet handles arch well; Opus is overkill usually

    if intent in ["refactor", "debug"] and confidence < 0.2:
        return ESCALATION_MODEL_SONNET  # Local model really struggled — step up

    return ESCALATION_MODEL_HAIKU  # default: cheapest first


# ── Claude API call ───────────────────────────────────────────
async def call_claude(
    prompt: str,
    model: Optional[str] = None,
) -> dict:
    """
    Calls the Anthropic Messages API and returns a structured result
    in the same shape as call_ollama() so callers treat them identically.

    Returns:
        {
            "raw": str,
            "code": str | None,
            "confidence": float,
            "model": str,
            "source": "escalated",
            "error": str | None,
            "input_tokens": int,
            "output_tokens": int,
        }
    """
    model = model or ESCALATION_MODEL_HAIKU

    if not ANTHROPIC_API_KEY:
        return {
            "raw": "", "code": None, "confidence": 0.0,
            "model": model, "source": "escalated",
            "error": "ANTHROPIC_API_KEY not set. Add it to config.py or set as env var.",
            "input_tokens": 0, "output_tokens": 0,
        }

    headers = {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }

    payload = {
        "model": model,
        "max_tokens": MAX_TOKENS,
        "messages": [
            {"role": "user", "content": prompt}
        ],
    }

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            r = await client.post(
                "https://api.anthropic.com/v1/messages",
                headers=headers,
                json=payload,
            )
            r.raise_for_status()
            data = r.json()

            raw_text = data["content"][0]["text"] if data.get("content") else ""
            input_tokens  = data.get("usage", {}).get("input_tokens", 0)
            output_tokens = data.get("usage", {}).get("output_tokens", 0)

            code = _extract_code_block(raw_text)
            confidence = _score_escalated_response(raw_text)

            return {
                "raw": raw_text,
                "code": code,
                "confidence": confidence,
                "model": model,
                "source": "escalated",
                "error": None,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
            }

    except httpx.HTTPStatusError as e:
        err = f"Claude API error {e.response.status_code}: {e.response.text[:200]}"
        return {
            "raw": "", "code": None, "confidence": 0.0,
            "model": model, "source": "escalated",
            "error": err, "input_tokens": 0, "output_tokens": 0,
        }
    except Exception as e:
        return {
            "raw": "", "code": None, "confidence": 0.0,
            "model": model, "source": "escalated",
            "error": str(e), "input_tokens": 0, "output_tokens": 0,
        }


# ── Response scoring for Claude output ───────────────────────
def _score_escalated_response(text: str) -> float:
    """
    Confidence scorer specifically for Claude responses.
    Claude almost always returns well-formatted code, so the baseline
    is higher than for the local model.
    """
    score = 0.9  # Claude starts with higher baseline

    if "```" not in text:
        score -= 0.4

    if len(text.strip()) < 50:
        score -= 0.3

    good_signals = ["import", "export", "const ", "function ", "return"]
    hits = sum(1 for s in good_signals if s in text)
    score += min(hits * 0.02, 0.1)

    return round(max(0.0, min(score, 1.0)), 2)


def _extract_code_block(text: str) -> Optional[str]:
    """Extract first code block from markdown."""
    pattern = r"```(?:typescript|javascript|tsx|jsx|ts|js|python)?\n?([\s\S]*?)```"
    match = re.search(pattern, text)
    if match:
        return match.group(1).strip()
    return None


# ── Cost tracker ──────────────────────────────────────────────
def estimate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    """Returns estimated cost in USD for this API call."""
    rate = COST_PER_1K_TOKENS.get(model, 0.001)
    total_tokens = input_tokens + output_tokens
    if total_tokens == 0:
        total_tokens = AVG_TOKENS_PER_ESCALATION
    return round((total_tokens / 1000) * rate, 6)


def log_escalation(
    prompt: str,
    intent: str,
    reason: str,
    model: str,
    success: bool,
    local_confidence: float,
    escalated_confidence: float,
    input_tokens: int,
    output_tokens: int,
    cached: bool,
) -> None:
    """
    Appends one escalation event to the local JSON log file.
    This is what powers the /escalation/stats endpoint.
    Runs synchronously — called as a background task so it doesn't block.
    """
    cost = estimate_cost(model, input_tokens, output_tokens)

    entry = {
        "timestamp": int(time.time()),
        "prompt_preview": prompt[:120],
        "intent": intent,
        "reason": reason,
        "model": model,
        "success": success,
        "local_confidence": local_confidence,
        "escalated_confidence": escalated_confidence,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "estimated_cost_usd": cost,
        "cached_after": cached,
    }

    # Load existing log
    log = _load_log()
    log["escalations"].append(entry)
    log["total_cost_usd"] = round(log.get("total_cost_usd", 0.0) + cost, 6)
    log["total_escalations"] = log.get("total_escalations", 0) + 1
    if cached:
        log["total_cached"] = log.get("total_cached", 0) + 1

    _save_log(log)


def _load_log() -> dict:
    """Load the escalation log from disk, or return a fresh structure."""
    os.makedirs(os.path.dirname(COST_LOG_PATH), exist_ok=True)
    if os.path.exists(COST_LOG_PATH):
        try:
            with open(COST_LOG_PATH, "r") as f:
                return json.load(f)
        except Exception:
            pass
    return {
        "escalations": [],
        "total_cost_usd": 0.0,
        "total_escalations": 0,
        "total_cached": 0,
    }


def _save_log(log: dict) -> None:
    """Save the log back to disk."""
    try:
        os.makedirs(os.path.dirname(COST_LOG_PATH), exist_ok=True)
        with open(COST_LOG_PATH, "w") as f:
            json.dump(log, f, indent=2)
    except Exception as e:
        print(f"[escalator] Failed to save log: {e}")


# ── Stats reader ──────────────────────────────────────────────
def get_escalation_stats() -> dict:
    """
    Builds a summary for the /escalation/stats endpoint.
    Shows cost breakdown, cache hit rate, and which intents escalate most.
    """
    log = _load_log()
    escalations = log.get("escalations", [])

    if not escalations:
        return {
            "total_escalations": 0,
            "total_cost_usd": 0.0,
            "cache_hit_rate": "0%",
            "avg_cost_per_escalation_usd": 0.0,
            "escalations_by_intent": {},
            "escalations_by_model": {},
            "recent": [],
            "tip": "No escalations yet. Run some prompts to see data here.",
        }

    total = len(escalations)
    cached = sum(1 for e in escalations if e.get("cached_after"))
    total_cost = log.get("total_cost_usd", 0.0)

    # Count by intent
    by_intent: dict = {}
    for e in escalations:
        i = e.get("intent", "unknown")
        by_intent[i] = by_intent.get(i, 0) + 1

    # Count by model
    by_model: dict = {}
    for e in escalations:
        m = e.get("model", "unknown")
        by_model[m] = by_model.get(m, 0) + 1

    # Most recent 10
    recent = sorted(escalations, key=lambda x: x["timestamp"], reverse=True)[:10]

    # Free rate (local + cache answers that never escalated) estimation
    # We only know escalations here, so we show cache rate within escalations
    cache_rate = f"{round((cached / total) * 100, 1)}%" if total > 0 else "0%"

    return {
        "total_escalations": total,
        "total_cost_usd": round(total_cost, 4),
        "avg_cost_per_escalation_usd": round(total_cost / total, 6) if total else 0,
        "cache_hit_rate_within_escalations": cache_rate,
        "escalations_by_intent": dict(sorted(by_intent.items(), key=lambda x: -x[1])),
        "escalations_by_model": by_model,
        "recent_escalations": [
            {
                "prompt": e["prompt_preview"],
                "intent": e["intent"],
                "model": e["model"],
                "cost": e["estimated_cost_usd"],
                "reason": e["reason"],
                "cached": e["cached_after"],
            }
            for e in recent
        ],
    }


def clear_escalation_log() -> bool:
    """Wipe the escalation log. Called by DELETE /escalation/log."""
    try:
        fresh = {
            "escalations": [],
            "total_cost_usd": 0.0,
            "total_escalations": 0,
            "total_cached": 0,
        }
        _save_log(fresh)
        return True
    except Exception:
        return False
