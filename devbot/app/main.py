# ============================================================
# main.py — FastAPI server (Phase 3)
# New in Phase 3:
#   - Escalation gate wired into /prompt flow
#   - force_escalate field on PromptRequest
#   - GET  /escalation/stats  — cost tracker dashboard
#   - DELETE /escalation/log  — reset the cost log
# ============================================================

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Optional
import time
import re

from app.bot import (
    call_ollama,
    build_prompt_with_rag,
    classify_intent,
    check_ollama_health,
)
from app.memory import (
    build_rag_context,
    search_answer_cache,
    cache_answer,
    get_memory_stats,
    clear_collection,
    add_snippet,
)
from app.escalator import (
    should_escalate,
    pick_escalation_model,
    call_claude,
    log_escalation,
    get_escalation_stats,
    clear_escalation_log,
)
from app.indexer import index_project
from app.config import (
    MAX_RETRIES,
    CONFIDENCE_THRESHOLD,
    ESCALATION_MIN_CONFIDENCE,
    CHROMA_CODEBASE_COLLECTION,
    CHROMA_ANSWERS_COLLECTION,
    CHROMA_SNIPPETS_COLLECTION,
)


# ── App setup ─────────────────────────────────────────────────
app = FastAPI(
    title="DevBot API",
    description="Local-first AI coding bot — Phase 3: Escalation Gate + Cost Tracker",
    version="3.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Request / Response models ─────────────────────────────────

class PromptRequest(BaseModel):
    prompt: str = Field(..., min_length=3)
    context_code: Optional[str]  = Field(None, description="Current file content")
    file_path:    Optional[str]  = Field(None, description="e.g. src/screens/Home.tsx")
    skip_cache:   bool           = Field(False, description="Force fresh generation")
    force_escalate: bool         = Field(False, description="Skip local model, go straight to Claude")

    class Config:
        json_schema_extra = {"example": {
            "prompt": "Design the full auth flow for a Supabase + Expo app",
            "context_code": None,
            "file_path": None,
            "skip_cache": False,
            "force_escalate": False,
        }}


class BotResponse(BaseModel):
    success:        bool
    intent:         str
    code:           Optional[str]
    explanation:    str
    confidence:     float
    source:         str           # "cache" | "local" | "escalated"
    model:          str
    needs_review:   bool
    rag_sources:    list[str]
    escalated:      bool          # NEW: was a paid API used?
    escalation_reason: Optional[str]  # NEW: why it escalated (or didn't)
    estimated_cost_usd: float     # NEW: $0.000 if local/cache, actual cost if escalated
    duration_ms:    int
    error:          Optional[str]


class IndexRequest(BaseModel):
    project_path: str


class SnippetRequest(BaseModel):
    name:        str
    code:        str
    description: str
    tags:        Optional[list[str]] = None


# ── Routes ────────────────────────────────────────────────────

@app.get("/", tags=["Status"])
async def root():
    return {
        "status": "DevBot is running",
        "version": "3.0.0 — Phase 3 (Escalation Gate + Cost Tracking)",
        "docs": "/docs",
    }


@app.get("/health", tags=["Status"])
async def health():
    ollama_status  = await check_ollama_health()
    memory_stats   = get_memory_stats()
    escalation_stats = get_escalation_stats()
    return {
        "server":     "ok",
        "ollama":     ollama_status,
        "memory":     memory_stats,
        "escalation": {
            "total_escalations": escalation_stats["total_escalations"],
            "total_cost_usd":    escalation_stats["total_cost_usd"],
        },
    }


# ── Core prompt endpoint ──────────────────────────────────────
@app.post("/prompt", response_model=BotResponse, tags=["Bot"])
async def handle_prompt(request: PromptRequest, background_tasks: BackgroundTasks):
    """
    Main endpoint — full Phase 3 flow.

    Decision path:
      1. Answer cache check         → return instantly if hit (free)
      2. RAG context build          → enrich prompt with your codebase
      3. Local model (Ollama)       → attempt generation, retry if low confidence
      4. Escalation gate check      → should we call Claude?
      5. Claude API call (if needed)→ Haiku by default, Sonnet for complex tasks
      6. Cache successful answer    → future identical prompts are free
      7. Log escalation cost        → visible in /escalation/stats
    """
    start      = time.time()
    intent     = classify_intent(request.prompt)
    rag_sources: list[str] = []
    escalated  = False
    escalation_reason: Optional[str] = None
    estimated_cost = 0.0

    # ── Step 1: Answer cache ──────────────────────────────────
    if not request.skip_cache and not request.force_escalate:
        cached = await search_answer_cache(request.prompt)
        if cached:
            return BotResponse(
                success=True, intent=intent,
                code=cached["code"], explanation=cached["explanation"],
                confidence=1.0, source="cache", model=cached["model"],
                needs_review=False, rag_sources=[],
                escalated=False, escalation_reason="cache hit",
                estimated_cost_usd=0.0,
                duration_ms=int((time.time() - start) * 1000),
                error=None,
            )

    # ── Step 2: RAG context ───────────────────────────────────
    rag_context, rag_sources = await build_rag_context(request.prompt)

    full_prompt = build_prompt_with_rag(
        user_prompt=request.prompt,
        context_code=request.context_code,
        rag_context=rag_context or None,
    )

    # ── Step 3: Local model (skip if force_escalate) ──────────
    local_result = None
    local_confidence = 0.0
    attempts = 0

    if not request.force_escalate:
        while attempts <= MAX_RETRIES:
            local_result = await call_ollama(full_prompt)
            attempts += 1
            local_confidence = local_result["confidence"]

            # Ollama is down — escalate immediately if possible
            if local_result["error"] and "Cannot connect" in local_result["error"]:
                break

            if local_confidence >= CONFIDENCE_THRESHOLD:
                break

            # Low confidence retry
            if attempts <= MAX_RETRIES:
                full_prompt = build_prompt_with_rag(
                    user_prompt=(
                        f"{request.prompt}\n\n"
                        "IMPORTANT: Return ONLY working TypeScript/React Native code "
                        "in a single code block. No text outside the code block."
                    ),
                    context_code=request.context_code,
                    rag_context=rag_context or None,
                )

    # ── Step 4: Escalation gate ───────────────────────────────
    do_escalate, escalation_reason = should_escalate(
        confidence=local_confidence,
        intent=intent,
        attempts=attempts,
        force=request.force_escalate,
    )

    # ── Step 5: Call Claude if escalating ─────────────────────
    final_result = local_result
    escalation_model = None

    if do_escalate:
        escalation_model = pick_escalation_model(intent, local_confidence)
        claude_result = await call_claude(full_prompt, model=escalation_model)

        if claude_result["error"] and not claude_result["code"]:
            # Claude failed too — fall back to whatever local produced
            escalation_reason = f"escalation failed: {claude_result['error']}"
        else:
            escalated = True
            final_result = claude_result
            estimated_cost = (
                (claude_result["input_tokens"] + claude_result["output_tokens"]) / 1000
            ) * 0.00040  # Haiku rate; escalator.estimate_cost() handles per-model

    # ── Build final result ────────────────────────────────────
    result = final_result or {
        "raw": "", "code": None, "confidence": 0.0,
        "model": "none", "source": "local", "error": "No result from any model",
        "input_tokens": 0, "output_tokens": 0,
    }

    duration_ms = int((time.time() - start) * 1000)

    # Hard failure — nothing worked
    if not result["code"] and result.get("error"):
        return BotResponse(
            success=False, intent=intent, code=None,
            explanation="", confidence=0.0,
            source=result["source"], model=result["model"],
            needs_review=True, rag_sources=rag_sources,
            escalated=escalated, escalation_reason=escalation_reason,
            estimated_cost_usd=estimated_cost,
            duration_ms=duration_ms, error=result["error"],
        )

    # Extract prose explanation
    explanation = result.get("raw", "")
    if result.get("code"):
        explanation = re.sub(r"```[\s\S]*?```", "", explanation).strip()
        explanation = explanation[:300] + ("..." if len(explanation) > 300 else "")

    needs_review = result["confidence"] < (
        ESCALATION_MIN_CONFIDENCE if escalated else CONFIDENCE_THRESHOLD
    )

    # ── Step 6: Cache good answers (background) ───────────────
    if result.get("code") and not needs_review:
        background_tasks.add_task(
            cache_answer,
            prompt=request.prompt,
            code=result["code"],
            explanation=explanation or "Code generated.",
            source=result["source"],
            model=result["model"],
        )

    # ── Step 7: Log escalation (background) ───────────────────
    if escalated and escalation_model:
        background_tasks.add_task(
            log_escalation,
            prompt=request.prompt,
            intent=intent,
            reason=escalation_reason or "",
            model=escalation_model,
            success=bool(result.get("code")),
            local_confidence=local_confidence,
            escalated_confidence=result["confidence"],
            input_tokens=result.get("input_tokens", 0),
            output_tokens=result.get("output_tokens", 0),
            cached=not needs_review,
        )

    return BotResponse(
        success=True, intent=intent,
        code=result.get("code"), explanation=explanation or "Code generated.",
        confidence=result["confidence"],
        source=result["source"], model=result["model"],
        needs_review=needs_review, rag_sources=rag_sources,
        escalated=escalated, escalation_reason=escalation_reason,
        estimated_cost_usd=estimated_cost,
        duration_ms=duration_ms, error=result.get("error"),
    )


# ── Escalation stats & controls ───────────────────────────────

@app.get("/escalation/stats", tags=["Escalation"])
async def escalation_stats():
    """
    Cost tracker dashboard.
    Shows total spend, cache hit rate, escalations by intent,
    and the 10 most recent escalations.
    """
    return get_escalation_stats()


@app.delete("/escalation/log", tags=["Escalation"])
async def reset_escalation_log():
    """Wipe the escalation log and reset cost tracking to zero."""
    success = clear_escalation_log()
    if success:
        return {"message": "Escalation log cleared"}
    raise HTTPException(status_code=500, detail="Failed to clear log")


# ── Indexer endpoints ─────────────────────────────────────────

@app.post("/index", tags=["Memory"])
async def trigger_index(request: IndexRequest, background_tasks: BackgroundTasks):
    background_tasks.add_task(index_project, request.project_path, True)
    return {
        "message": "Indexing started in background",
        "project_path": request.project_path,
        "tip": "Check GET /memory/stats to see progress",
    }


@app.post("/index/sync", tags=["Memory"])
async def trigger_index_sync(request: IndexRequest):
    return await index_project(request.project_path, verbose=False)


# ── Memory / knowledge base ───────────────────────────────────

@app.get("/memory/stats", tags=["Memory"])
async def memory_stats():
    return get_memory_stats()


@app.post("/memory/snippet", tags=["Memory"])
async def create_snippet(request: SnippetRequest):
    success = await add_snippet(
        name=request.name, code=request.code,
        description=request.description, tags=request.tags,
    )
    if success:
        return {"message": f"Snippet '{request.name}' added"}
    raise HTTPException(status_code=500, detail="Failed to add snippet — is Ollama running?")


@app.delete("/memory/{collection}", tags=["Memory"])
async def wipe_collection(collection: str):
    valid = [CHROMA_CODEBASE_COLLECTION, CHROMA_ANSWERS_COLLECTION, CHROMA_SNIPPETS_COLLECTION]
    if collection not in valid:
        raise HTTPException(status_code=400, detail=f"Valid collections: {valid}")
    success = await clear_collection(collection)
    if success:
        return {"message": f"Collection '{collection}' cleared"}
    raise HTTPException(status_code=500, detail="Failed to clear collection")


@app.get("/models", tags=["Status"])
async def list_models():
    import httpx
    from app.config import OLLAMA_BASE_URL
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(f"{OLLAMA_BASE_URL}/api/tags")
            return r.json()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Ollama not reachable: {str(e)}")
