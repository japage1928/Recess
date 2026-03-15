# ============================================================
# memory.py — ChromaDB vector store
#
# Three collections:
#   codebase  → your indexed project files (set once, reused forever)
#   answers   → cached bot responses (free answers grow over time)
#   snippets  → manually added patterns/templates
#
# How it works:
#   1. Text is converted to a vector (embedding) via Ollama
#   2. Vectors are stored in ChromaDB on disk
#   3. When a prompt arrives, we embed it and find similar vectors
#   4. The matching chunks are injected as context into the prompt
# ============================================================

import hashlib
import json
import time
from typing import Optional
import httpx
import chromadb
from chromadb.config import Settings

from app.config import (
    CHROMA_DB_PATH,
    CHROMA_CODEBASE_COLLECTION,
    CHROMA_ANSWERS_COLLECTION,
    CHROMA_SNIPPETS_COLLECTION,
    OLLAMA_BASE_URL,
    OLLAMA_EMBED_MODEL,
    RAG_TOP_K,
    RAG_SIMILARITY_THRESHOLD,
    RAG_MAX_CONTEXT_CHARS,
)


# ── ChromaDB client (singleton) ───────────────────────────────
_chroma_client: Optional[chromadb.PersistentClient] = None

def get_chroma_client() -> chromadb.PersistentClient:
    global _chroma_client
    if _chroma_client is None:
        _chroma_client = chromadb.PersistentClient(
            path=CHROMA_DB_PATH,
            settings=Settings(anonymized_telemetry=False),
        )
    return _chroma_client


def get_collection(name: str) -> chromadb.Collection:
    """Get or create a named ChromaDB collection."""
    client = get_chroma_client()
    return client.get_or_create_collection(
        name=name,
        metadata={"hnsw:space": "cosine"},  # cosine similarity for text
    )


# ── Embedding via Ollama ──────────────────────────────────────
async def embed_text(text: str) -> Optional[list[float]]:
    """
    Converts text into a vector embedding using the local Ollama embed model.
    Returns a list of floats, or None if embedding fails.

    The embed model (nomic-embed-text) is separate from the generation model —
    it's much smaller (~270MB) and very fast.
    """
    url = f"{OLLAMA_BASE_URL}/api/embed"
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(url, json={
                "model": OLLAMA_EMBED_MODEL,
                "input": text[:8000],  # cap to avoid token limit issues
            })
            r.raise_for_status()
            data = r.json()
            # Ollama returns embeddings as a list of lists (one per input)
            embeddings = data.get("embeddings", [])
            if embeddings:
                return embeddings[0]
            return None
    except Exception as e:
        print(f"[memory] Embedding failed: {e}")
        return None


def _make_id(text: str) -> str:
    """Deterministic ID from content hash — prevents duplicate entries."""
    return hashlib.md5(text.encode()).hexdigest()


# ── Codebase collection ───────────────────────────────────────
async def index_code_chunk(
    content: str,
    file_path: str,
    chunk_index: int = 0,
    metadata: Optional[dict] = None,
) -> bool:
    """
    Adds a chunk of source code to the codebase collection.
    Called by the indexer when scanning project files.

    Returns True if successfully indexed, False otherwise.
    """
    embedding = await embed_text(content)
    if embedding is None:
        return False

    collection = get_collection(CHROMA_CODEBASE_COLLECTION)
    doc_id = _make_id(f"{file_path}:{chunk_index}:{content[:100]}")

    meta = {
        "file_path": file_path,
        "chunk_index": chunk_index,
        "indexed_at": int(time.time()),
        "char_count": len(content),
    }
    if metadata:
        meta.update(metadata)

    try:
        collection.upsert(
            ids=[doc_id],
            embeddings=[embedding],
            documents=[content],
            metadatas=[meta],
        )
        return True
    except Exception as e:
        print(f"[memory] Failed to index chunk {file_path}:{chunk_index} — {e}")
        return False


async def search_codebase(query: str, top_k: int = RAG_TOP_K) -> list[dict]:
    """
    Finds code chunks in your project most relevant to the query.
    Returns a list of {content, file_path, similarity} dicts.
    """
    embedding = await embed_text(query)
    if embedding is None:
        return []

    collection = get_collection(CHROMA_CODEBASE_COLLECTION)

    try:
        count = collection.count()
        if count == 0:
            return []

        results = collection.query(
            query_embeddings=[embedding],
            n_results=min(top_k, count),
            include=["documents", "metadatas", "distances"],
        )

        hits = []
        for doc, meta, dist in zip(
            results["documents"][0],
            results["metadatas"][0],
            results["distances"][0],
        ):
            # ChromaDB cosine distance: 0 = identical, 2 = opposite
            # Convert to similarity: 1.0 = perfect match
            similarity = 1.0 - (dist / 2.0)
            if similarity >= RAG_SIMILARITY_THRESHOLD:
                hits.append({
                    "content": doc,
                    "file_path": meta.get("file_path", "unknown"),
                    "chunk_index": meta.get("chunk_index", 0),
                    "similarity": round(similarity, 3),
                })

        # Sort by similarity descending
        hits.sort(key=lambda x: x["similarity"], reverse=True)
        return hits

    except Exception as e:
        print(f"[memory] Codebase search failed: {e}")
        return []


# ── Answer cache collection ───────────────────────────────────
async def cache_answer(
    prompt: str,
    code: str,
    explanation: str,
    source: str,
    model: str,
) -> bool:
    """
    Saves a successful bot response to the answer cache.
    Next time a similar prompt comes in, we can serve it without hitting any LLM.
    This is how paid API responses become permanently free.
    """
    embedding = await embed_text(prompt)
    if embedding is None:
        return False

    collection = get_collection(CHROMA_ANSWERS_COLLECTION)
    doc_id = _make_id(prompt)

    try:
        collection.upsert(
            ids=[doc_id],
            embeddings=[embedding],
            documents=[code],
            metadatas=[{
                "prompt": prompt[:500],
                "explanation": explanation[:300],
                "source": source,
                "model": model,
                "cached_at": int(time.time()),
            }],
        )
        return True
    except Exception as e:
        print(f"[memory] Failed to cache answer: {e}")
        return False


async def search_answer_cache(prompt: str) -> Optional[dict]:
    """
    Checks if we have a cached answer for a similar prompt.
    Returns the cached result if similarity is high enough, else None.

    We use a higher threshold here (0.85) because answers need to be
    very relevant — unlike codebase context which is just supplementary.
    """
    CACHE_THRESHOLD = 0.85

    embedding = await embed_text(prompt)
    if embedding is None:
        return None

    collection = get_collection(CHROMA_ANSWERS_COLLECTION)

    try:
        count = collection.count()
        if count == 0:
            return None

        results = collection.query(
            query_embeddings=[embedding],
            n_results=1,
            include=["documents", "metadatas", "distances"],
        )

        if not results["documents"][0]:
            return None

        dist = results["distances"][0][0]
        similarity = 1.0 - (dist / 2.0)

        if similarity >= CACHE_THRESHOLD:
            meta = results["metadatas"][0][0]
            return {
                "code": results["documents"][0][0],
                "explanation": meta.get("explanation", ""),
                "source": "cache",
                "model": meta.get("model", "cached"),
                "similarity": round(similarity, 3),
                "original_source": meta.get("source", "unknown"),
            }

        return None

    except Exception as e:
        print(f"[memory] Cache search failed: {e}")
        return None


# ── Snippet collection ────────────────────────────────────────
async def add_snippet(
    name: str,
    code: str,
    description: str,
    tags: Optional[list[str]] = None,
) -> bool:
    """
    Manually add a reusable code snippet to the knowledge base.
    Great for your own patterns, company standards, or common Expo boilerplate.

    POST /memory/snippet to call this from the API.
    """
    content = f"{description}\n\n{code}"
    embedding = await embed_text(content)
    if embedding is None:
        return False

    collection = get_collection(CHROMA_SNIPPETS_COLLECTION)
    doc_id = _make_id(name + code[:100])

    try:
        collection.upsert(
            ids=[doc_id],
            embeddings=[embedding],
            documents=[code],
            metadatas=[{
                "name": name,
                "description": description,
                "tags": json.dumps(tags or []),
                "added_at": int(time.time()),
            }],
        )
        return True
    except Exception as e:
        print(f"[memory] Failed to add snippet: {e}")
        return False


async def search_snippets(query: str, top_k: int = 2) -> list[dict]:
    """Find manually added snippets relevant to the query."""
    embedding = await embed_text(query)
    if embedding is None:
        return []

    collection = get_collection(CHROMA_SNIPPETS_COLLECTION)

    try:
        count = collection.count()
        if count == 0:
            return []

        results = collection.query(
            query_embeddings=[embedding],
            n_results=min(top_k, count),
            include=["documents", "metadatas", "distances"],
        )

        hits = []
        for doc, meta, dist in zip(
            results["documents"][0],
            results["metadatas"][0],
            results["distances"][0],
        ):
            similarity = 1.0 - (dist / 2.0)
            if similarity >= RAG_SIMILARITY_THRESHOLD:
                hits.append({
                    "content": doc,
                    "name": meta.get("name", ""),
                    "description": meta.get("description", ""),
                    "similarity": round(similarity, 3),
                })

        return sorted(hits, key=lambda x: x["similarity"], reverse=True)

    except Exception as e:
        print(f"[memory] Snippet search failed: {e}")
        return []


# ── RAG context builder ───────────────────────────────────────
async def build_rag_context(prompt: str) -> tuple[str, list[str]]:
    """
    The main RAG function called before every prompt.

    Searches all three collections and assembles a context block
    to inject into the prompt. Returns:
        - context_block: formatted string ready to inject
        - sources: list of file paths / names used (for logging)
    """
    # Run all three searches
    codebase_hits  = await search_codebase(prompt, top_k=RAG_TOP_K)
    snippet_hits   = await search_snippets(prompt, top_k=2)

    if not codebase_hits and not snippet_hits:
        return "", []

    parts = []
    sources = []
    total_chars = 0

    # Add snippet matches first (manually curated = highest signal)
    if snippet_hits:
        parts.append("--- RELEVANT SNIPPETS FROM YOUR KNOWLEDGE BASE ---")
        for hit in snippet_hits:
            chunk = f"// Snippet: {hit['name']}\n// {hit['description']}\n{hit['content']}"
            if total_chars + len(chunk) > RAG_MAX_CONTEXT_CHARS:
                break
            parts.append(chunk)
            sources.append(f"snippet:{hit['name']}")
            total_chars += len(chunk)

    # Add codebase matches
    if codebase_hits and total_chars < RAG_MAX_CONTEXT_CHARS:
        parts.append("--- RELEVANT CODE FROM YOUR PROJECT ---")
        for hit in codebase_hits:
            chunk = f"// From: {hit['file_path']} (similarity: {hit['similarity']})\n{hit['content']}"
            if total_chars + len(chunk) > RAG_MAX_CONTEXT_CHARS:
                break
            parts.append(chunk)
            sources.append(hit["file_path"])
            total_chars += len(chunk)

    context_block = "\n\n".join(parts)
    return context_block, sources


# ── Stats ─────────────────────────────────────────────────────
def get_memory_stats() -> dict:
    """Returns collection sizes — useful for the /memory/stats endpoint."""
    try:
        return {
            "codebase_chunks": get_collection(CHROMA_CODEBASE_COLLECTION).count(),
            "cached_answers":  get_collection(CHROMA_ANSWERS_COLLECTION).count(),
            "snippets":        get_collection(CHROMA_SNIPPETS_COLLECTION).count(),
            "db_path":         CHROMA_DB_PATH,
        }
    except Exception as e:
        return {"error": str(e)}


async def clear_collection(name: str) -> bool:
    """Wipes a collection. Used by DELETE /memory/{collection}."""
    try:
        client = get_chroma_client()
        client.delete_collection(name)
        return True
    except Exception as e:
        print(f"[memory] Failed to clear {name}: {e}")
        return False
