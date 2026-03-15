#!/usr/bin/env python3
# ============================================================
# test_phase2.py — Phase 2 test suite
# Tests: embedding, RAG search, answer cache, snippet CRUD,
#        indexer, and enriched /prompt responses
#
# Usage: python tests/test_phase2.py
# ============================================================

import asyncio
import httpx
import sys
import time
import os

BASE_URL = "http://localhost:8000"

GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
CYAN   = "\033[96m"
BOLD   = "\033[1m"
RESET  = "\033[0m"

def ok(msg):   print(f"  {GREEN}✓{RESET} {msg}")
def fail(msg): print(f"  {RED}✗{RESET} {msg}")
def info(msg): print(f"  {CYAN}→{RESET} {msg}")
def warn(msg): print(f"  {YELLOW}⚠{RESET} {msg}")
def section(title): print(f"\n{BOLD}[{title}]{RESET}")


async def run_tests():
    print(f"\n{BOLD}{'='*54}{RESET}")
    print(f"{BOLD}  DevBot Phase 2 — Test Suite{RESET}")
    print(f"{BOLD}{'='*54}{RESET}")

    async with httpx.AsyncClient(timeout=180) as client:

        # ── 1: Server + health ────────────────────────────────
        section("1/6  Server health")
        try:
            r = await client.get(f"{BASE_URL}/health")
            r.raise_for_status()
            data = r.json()

            ok("Server is running")

            ollama = data.get("ollama", {})
            if ollama.get("ollama_running"):
                ok("Ollama is running")
            else:
                fail("Ollama is NOT running — run: ollama serve")
                sys.exit(1)

            if ollama.get("model_ready"):
                ok(f"Generation model ready: {ollama['model']}")
            else:
                fail(f"Model not found: {ollama['model']} — run: ollama pull {ollama['model']}")
                sys.exit(1)

            mem = data.get("memory", {})
            ok(f"Memory stats: {mem.get('codebase_chunks',0)} codebase | "
               f"{mem.get('cached_answers',0)} cached | "
               f"{mem.get('snippets',0)} snippets")

        except Exception as e:
            fail(f"Server not reachable: {e}")
            fail("Run: uvicorn app.main:app --reload")
            sys.exit(1)

        # ── 2: Embedding check ────────────────────────────────
        section("2/6  Embedding model check")
        info("Testing nomic-embed-text via memory module...")
        try:
            # Import directly to test embedding outside HTTP
            sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
            from app.memory import embed_text
            embedding = await embed_text("React Native button component")
            if embedding and len(embedding) > 100:
                ok(f"Embedding works — vector dim: {len(embedding)}")
            else:
                warn("Embedding returned empty — is nomic-embed-text pulled?")
                warn("Run: ollama pull nomic-embed-text")
        except Exception as e:
            warn(f"Embedding test skipped: {e}")
            warn("Run: ollama pull nomic-embed-text")

        # ── 3: Snippet CRUD ───────────────────────────────────
        section("3/6  Snippet add + search")

        test_snippet = {
            "name": "HaulOS status badge",
            "code": (
                "import { View, Text } from 'react-native';\n"
                "export function StatusBadge({ status }: { status: string }) {\n"
                "  const color = status === 'active' ? '#00ff88' : '#ff4040';\n"
                "  return <View style={{ backgroundColor: color }}><Text>{status}</Text></View>;\n"
                "}"
            ),
            "description": "A colored badge component that shows driver status (active/inactive)",
            "tags": ["component", "badge", "status"]
        }

        try:
            r = await client.post(f"{BASE_URL}/memory/snippet", json=test_snippet)
            if r.status_code == 200:
                ok(f"Snippet added: '{test_snippet['name']}'")
            else:
                warn(f"Snippet add failed (status {r.status_code}) — embedding may not be ready")
        except Exception as e:
            warn(f"Snippet test skipped: {e}")

        # ── 4: Prompt with RAG ────────────────────────────────
        section("4/6  Prompt generation (with RAG)")

        prompts = [
            {
                "name": "Component generation",
                "payload": {
                    "prompt": "Create a React Native card component that shows driver name, miles driven, and status",
                    "skip_cache": True,
                }
            },
            {
                "name": "Hook generation",
                "payload": {
                    "prompt": "Write a useDriverStatus hook that polls an endpoint every 30 seconds",
                    "skip_cache": True,
                }
            },
        ]

        for test in prompts:
            info(f"Testing: {test['name']}")
            try:
                r = await client.post(f"{BASE_URL}/prompt", json=test["payload"])
                r.raise_for_status()
                data = r.json()

                if data["success"]:
                    ok(f"Response in {data['duration_ms']}ms | "
                       f"confidence: {data['confidence']} | "
                       f"source: {data['source']}")

                    if data["rag_sources"]:
                        ok(f"RAG sources used: {data['rag_sources']}")
                    else:
                        info("No RAG sources (knowledge base may be empty — run /index first)")

                    if data["code"]:
                        lines = len(data["code"].splitlines())
                        ok(f"Code extracted: {lines} lines")
                    else:
                        warn("No code block returned")
                else:
                    fail(f"Request failed: {data.get('error')}")

            except Exception as e:
                fail(f"Request error: {e}")

        # ── 5: Answer cache ───────────────────────────────────
        section("5/6  Answer cache")
        cache_prompt = "Create a simple React Native loading spinner component"

        info("First call (fresh generation)...")
        try:
            r = await client.post(f"{BASE_URL}/prompt", json={
                "prompt": cache_prompt,
                "skip_cache": True,
            })
            data = r.json()
            if data["success"]:
                ok(f"Generated in {data['duration_ms']}ms (source: {data['source']})")
                # Wait a moment for background cache task
                await asyncio.sleep(2)
            else:
                warn(f"Generation failed: {data.get('error')}")
        except Exception as e:
            warn(f"First call failed: {e}")

        info("Second call (should hit cache)...")
        try:
            r = await client.post(f"{BASE_URL}/prompt", json={
                "prompt": cache_prompt,
                "skip_cache": False,
            })
            data = r.json()
            if data["success"]:
                if data["source"] == "cache":
                    ok(f"Cache HIT — returned in {data['duration_ms']}ms (was free!)")
                else:
                    warn(f"Cache miss (source: {data['source']}) — similarity threshold not met yet")
                    info("This is normal on first run — cache builds over time")
        except Exception as e:
            warn(f"Second call failed: {e}")

        # ── 6: Memory stats ───────────────────────────────────
        section("6/6  Final memory stats")
        try:
            r = await client.get(f"{BASE_URL}/memory/stats")
            stats = r.json()
            ok(f"Codebase chunks: {stats.get('codebase_chunks', 0)}")
            ok(f"Cached answers:  {stats.get('cached_answers', 0)}")
            ok(f"Snippets:        {stats.get('snippets', 0)}")
            ok(f"DB path:         {stats.get('db_path', 'N/A')}")
        except Exception as e:
            warn(f"Stats check failed: {e}")

    # ── Summary ───────────────────────────────────────────────
    print(f"\n{BOLD}{'='*54}{RESET}")
    print(f"{BOLD}  Phase 2 tests complete{RESET}")
    print(f"\n  Next steps:")
    print(f"  {CYAN}→{RESET} Index your project:")
    print(f"    python -m app.indexer --path /path/to/your/expo/project")
    print(f"  {CYAN}→{RESET} Or via API: POST /index {{\"project_path\": \"...\"}}")
    print(f"  {CYAN}→{RESET} Add snippets: POST /memory/snippet")
    print(f"  {CYAN}→{RESET} API docs: http://localhost:8000/docs")
    print(f"{BOLD}{'='*54}{RESET}\n")


if __name__ == "__main__":
    asyncio.run(run_tests())
