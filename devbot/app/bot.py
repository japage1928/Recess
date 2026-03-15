# ============================================================
# bot.py — Core bot logic: talks to Ollama, scores output
# ============================================================

import httpx
import json
import re
from typing import Optional
from app.config import (
    OLLAMA_BASE_URL,
    OLLAMA_MODEL,
    OLLAMA_TIMEOUT,
    TEMPERATURE,
    MAX_TOKENS,
    CONFIDENCE_THRESHOLD,
)


# ── System prompt injected before every coding request ──────
SYSTEM_PROMPT = """You are an expert mobile app developer specializing in React Native and Expo.
Your job is to write clean, production-ready code based on the user's prompt.

Rules:
- Always return working, complete code. No placeholders or TODO comments unless asked.
- Use TypeScript by default unless the user specifies JavaScript.
- Follow React Native and Expo best practices.
- If generating a component, export it as a default export.
- If the request is unclear, make the most reasonable assumption and note it briefly.
- Keep explanations SHORT — one or two sentences max. The code is the deliverable.
- Wrap all code in a single ```typescript ... ``` or ```javascript ... ``` block.
"""


# ── Intent classifier ────────────────────────────────────────
# Phase 1: simple rule-based classification
# Phase 2: swap this for a real ML classifier
INTENT_PATTERNS = {
    "component":    [r"component", r"screen", r"button", r"input", r"modal", r"card", r"list"],
    "navigation":   [r"navigate", r"stack", r"tab", r"drawer", r"router", r"expo.router"],
    "api_call":     [r"fetch", r"axios", r"api call", r"http request", r"supabase", r"endpoint"],
    "hook":         [r"hook", r"usestate", r"useeffect", r"usecallback", r"usememo", r"custom hook"],
    "style":        [r"style", r"css", r"tailwind", r"stylesheet", r"theme", r"color", r"layout"],
    "refactor":     [r"refactor", r"clean up", r"improve", r"optimize", r"rewrite"],
    "debug":        [r"fix", r"bug", r"error", r"broken", r"not working", r"crash", r"why"],
    "config":       [r"config", r"setup", r"install", r"package", r"app\.json", r"eas"],
    "general":      [],  # fallback
}

def classify_intent(prompt: str) -> str:
    """Returns the best-guess intent category for a prompt."""
    lower = prompt.lower()
    for intent, patterns in INTENT_PATTERNS.items():
        if any(re.search(p, lower) for p in patterns):
            return intent
    return "general"


# ── Confidence scorer ────────────────────────────────────────
def score_response(response_text: str, intent: str) -> float:
    """
    Heuristic confidence score (0.0 – 1.0) based on the model's output.
    Phase 3 can replace this with perplexity scoring or a classifier.
    """
    score = 1.0

    # Penalize if no code block was returned
    if "```" not in response_text:
        score -= 0.5

    # Penalize for refusal / uncertainty signals
    uncertainty_phrases = [
        "i'm not sure", "i don't know", "cannot", "i am unable",
        "as an ai", "i apologize", "unfortunately", "i cannot help"
    ]
    if any(p in response_text.lower() for p in uncertainty_phrases):
        score -= 0.4

    # Penalize if response is very short (likely unhelpful)
    if len(response_text.strip()) < 80:
        score -= 0.3

    # Bonus: response contains TypeScript/React Native patterns
    good_signals = ["import", "export default", "const ", "return (", "StyleSheet", "useState"]
    hits = sum(1 for s in good_signals if s in response_text)
    score += min(hits * 0.05, 0.2)

    return round(max(0.0, min(score, 1.0)), 2)


# ── Code extractor ───────────────────────────────────────────
def extract_code_block(text: str) -> Optional[str]:
    """Pull the first code block out of a markdown response."""
    pattern = r"```(?:typescript|javascript|tsx|jsx|ts|js)?\n?([\s\S]*?)```"
    match = re.search(pattern, text)
    if match:
        return match.group(1).strip()
    return None


# ── Build the full prompt ────────────────────────────────────
def build_prompt(user_prompt: str, context_code: Optional[str] = None) -> str:
    """
    Assembles the final prompt sent to the model.
    Injects existing code context if provided (used heavily in Phase 2 with RAG).
    """
    parts = [SYSTEM_PROMPT.strip(), "\n\n"]

    if context_code:
        parts.append("--- EXISTING CODE CONTEXT ---\n")
        parts.append(context_code.strip())
        parts.append("\n--- END CONTEXT ---\n\n")

    parts.append(f"USER REQUEST:\n{user_prompt.strip()}")
    return "".join(parts)


# ── Main call to Ollama ──────────────────────────────────────
async def call_ollama(prompt: str, retries: int = 0) -> dict:
    """
    Sends a prompt to the local Ollama model and returns a structured result.

    Returns:
        {
            "raw": str,           # Full model output
            "code": str | None,   # Extracted code block
            "confidence": float,  # 0.0–1.0 score
            "model": str,         # Model used
            "source": "local"
        }
    """
    url = f"{OLLAMA_BASE_URL}/api/generate"
    payload = {
        "model": OLLAMA_MODEL,
        "prompt": prompt,
        "stream": False,
        "options": {
            "temperature": TEMPERATURE,
            "num_predict": MAX_TOKENS,
        }
    }

    try:
        async with httpx.AsyncClient(timeout=OLLAMA_TIMEOUT) as client:
            response = await client.post(url, json=payload)
            response.raise_for_status()
            data = response.json()
            raw_text = data.get("response", "")

            return {
                "raw": raw_text,
                "code": extract_code_block(raw_text),
                "confidence": score_response(raw_text, ""),
                "model": OLLAMA_MODEL,
                "source": "local",
                "error": None,
            }

    except httpx.ConnectError:
        return {
            "raw": "",
            "code": None,
            "confidence": 0.0,
            "model": OLLAMA_MODEL,
            "source": "local",
            "error": "Cannot connect to Ollama. Is it running? Run: ollama serve",
        }
    except httpx.TimeoutException:
        return {
            "raw": "",
            "code": None,
            "confidence": 0.0,
            "model": OLLAMA_MODEL,
            "source": "local",
            "error": f"Ollama timed out after {OLLAMA_TIMEOUT}s. Try a smaller model.",
        }
    except Exception as e:
        return {
            "raw": "",
            "code": None,
            "confidence": 0.0,
            "model": OLLAMA_MODEL,
            "source": "local",
            "error": str(e),
        }


# ── Health check for Ollama ──────────────────────────────────
async def check_ollama_health() -> dict:
    """Pings Ollama to verify it's running and the model is available."""
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            # Check if Ollama is running
            r = await client.get(f"{OLLAMA_BASE_URL}/api/tags")
            r.raise_for_status()
            models_data = r.json()
            available_models = [m["name"] for m in models_data.get("models", [])]

            model_ready = any(OLLAMA_MODEL in m for m in available_models)

            return {
                "ollama_running": True,
                "model_ready": model_ready,
                "model": OLLAMA_MODEL,
                "available_models": available_models,
                "message": "Ready" if model_ready else f"Model '{OLLAMA_MODEL}' not found. Run: ollama pull {OLLAMA_MODEL}",
            }
    except Exception as e:
        return {
            "ollama_running": False,
            "model_ready": False,
            "model": OLLAMA_MODEL,
            "available_models": [],
            "message": f"Ollama not running: {str(e)}. Run: ollama serve",
        }


# ── Phase 2: RAG-aware prompt builder ────────────────────────
def build_prompt_with_rag(
    user_prompt: str,
    context_code: Optional[str] = None,
    rag_context: Optional[str] = None,
) -> str:
    """
    Phase 2 version of build_prompt — adds RAG context block.

    Injection order:
      1. System prompt
      2. RAG context from ChromaDB (similar code from your project + snippets)
      3. Inline context code (the specific file the user is editing)
      4. The user's actual request
    """
    parts = [SYSTEM_PROMPT.strip(), "\n\n"]

    if rag_context:
        parts.append("--- KNOWLEDGE BASE CONTEXT (similar code from your project) ---\n")
        parts.append(rag_context.strip())
        parts.append("\n--- END KNOWLEDGE BASE ---\n\n")

    if context_code:
        parts.append("--- CURRENT FILE CONTEXT ---\n")
        parts.append(context_code.strip())
        parts.append("\n--- END CURRENT FILE ---\n\n")

    parts.append(f"USER REQUEST:\n{user_prompt.strip()}")
    return "".join(parts)
