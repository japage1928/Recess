# ============================================================
# config.py — Central settings for the DevBot server
# Phase 3 adds: escalation gate, cost tracking, smart classifier
# ============================================================

import os

# --- Ollama Settings ---
OLLAMA_BASE_URL    = "http://localhost:11434"
OLLAMA_MODEL       = "deepseek-coder:6.7b"
OLLAMA_EMBED_MODEL = "nomic-embed-text"
OLLAMA_TIMEOUT     = 120

# --- Generation Settings ---
TEMPERATURE  = 0.2
MAX_TOKENS   = 2048
MAX_RETRIES  = 2

# Minimum confidence to accept a local answer WITHOUT escalating
CONFIDENCE_THRESHOLD = 0.4

# --- RAG Settings ---
RAG_TOP_K                = 4
RAG_SIMILARITY_THRESHOLD = 0.35
RAG_MAX_CONTEXT_CHARS    = 3000

# --- ChromaDB Settings ---
CHROMA_DB_PATH             = "./data/chromadb"
CHROMA_CODEBASE_COLLECTION = "codebase"
CHROMA_ANSWERS_COLLECTION  = "answers"
CHROMA_SNIPPETS_COLLECTION = "snippets"

# --- Indexer Settings ---
INDEXABLE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".py", ".md", ".json", ".yaml", ".yml"]
IGNORE_DIRS          = ["node_modules", ".git", ".expo", "dist", "build",
                        "__pycache__", ".next", "android", "ios", ".turbo"]
MAX_FILE_SIZE_BYTES  = 50_000
CHUNK_SIZE           = 1200
CHUNK_OVERLAP        = 150

# --- Server Settings ---
HOST = "0.0.0.0"
PORT = 8000

# ============================================================
# PHASE 3 — ESCALATION GATE
# ============================================================

# Your Anthropic API key — set as env var or paste directly (dev only)
# Production: export ANTHROPIC_API_KEY="sk-ant-..."
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

# Model tier ladder — we try cheapest first
# Haiku  → fast, cheap (~$0.0003/escalation), handles most fallbacks
# Sonnet → smarter, moderate cost, for architecture/multi-file tasks
# Opus   → most capable, use sparingly for truly complex problems
ESCALATION_MODEL_HAIKU  = "claude-haiku-4-5-20251001"
ESCALATION_MODEL_SONNET = "claude-sonnet-4-6"
ESCALATION_MODEL_OPUS   = "claude-opus-4-6"

# Default escalation tier — start here, only go higher on retry
ESCALATION_MODEL = ESCALATION_MODEL_HAIKU

# Escalation only fires if local confidence stays below this after all retries
# Must be <= CONFIDENCE_THRESHOLD (otherwise local model always wins)
ESCALATION_TRIGGER_THRESHOLD = 0.35

# If escalated answer confidence is still below this, flag needs_review=True
ESCALATION_MIN_CONFIDENCE = 0.5

# Intent types that ALWAYS escalate directly (skip local model attempts)
# These are tasks the 6.7B model consistently fails at
ALWAYS_ESCALATE_INTENTS = ["architecture"]

# Intent types that NEVER escalate (always local, even if low confidence)
# These are fast/cheap enough to just retry locally
NEVER_ESCALATE_INTENTS = ["style", "config"]

# Rough token cost estimates per model (USD per 1K tokens, input+output blended)
# Used for cost tracking — not billing-accurate, just for your dashboard
COST_PER_1K_TOKENS = {
    ESCALATION_MODEL_HAIKU:  0.00040,   # ~$0.0003–0.0005 blended
    ESCALATION_MODEL_SONNET: 0.00900,
    ESCALATION_MODEL_OPUS:   0.07500,
}

# Average tokens per escalation request (prompt + response)
# Update this after a week of real usage for better estimates
AVG_TOKENS_PER_ESCALATION = 1000

# --- Cost log path ---
COST_LOG_PATH = "./data/escalation_log.json"
