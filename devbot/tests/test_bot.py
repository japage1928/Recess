#!/usr/bin/env python3
# ============================================================
# test_bot.py — Run this to verify your Phase 1 setup works
# Usage: python tests/test_bot.py
# ============================================================

import asyncio
import httpx
import json
import sys

BASE_URL = "http://localhost:8000"

# ── Colors for terminal output ────────────────────────────────
GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
CYAN   = "\033[96m"
RESET  = "\033[0m"
BOLD   = "\033[1m"

def ok(msg):  print(f"  {GREEN}✓{RESET} {msg}")
def fail(msg): print(f"  {RED}✗{RESET} {msg}")
def info(msg): print(f"  {CYAN}→{RESET} {msg}")
def warn(msg): print(f"  {YELLOW}⚠{RESET} {msg}")


# ── Test cases ────────────────────────────────────────────────
TEST_PROMPTS = [
    {
        "name": "Simple component",
        "prompt": "Create a React Native Text component that displays 'Hello World' in bold blue",
        "context_code": None,
    },
    {
        "name": "Hook generation",
        "prompt": "Write a custom React hook called useToggle that manages a boolean state",
        "context_code": None,
    },
    {
        "name": "With context code",
        "prompt": "Add a loading spinner to this button",
        "context_code": """
import { TouchableOpacity, Text } from 'react-native';

export default function MyButton({ onPress, label }) {
  return (
    <TouchableOpacity onPress={onPress}>
      <Text>{label}</Text>
    </TouchableOpacity>
  );
}
""",
    },
]


async def run_tests():
    print(f"\n{BOLD}{'='*54}{RESET}")
    print(f"{BOLD}  DevBot Phase 1 — Test Suite{RESET}")
    print(f"{BOLD}{'='*54}{RESET}\n")

    async with httpx.AsyncClient(timeout=180) as client:

        # ── Test 1: Server alive ──────────────────────────────
        print(f"{BOLD}[1/4] Server health{RESET}")
        try:
            r = await client.get(f"{BASE_URL}/")
            r.raise_for_status()
            ok(f"Server is running → {r.json()['status']}")
        except Exception as e:
            fail(f"Server not reachable: {e}")
            fail("Make sure you ran: uvicorn app.main:app --reload")
            sys.exit(1)

        # ── Test 2: Ollama health ─────────────────────────────
        print(f"\n{BOLD}[2/4] Ollama + model check{RESET}")
        try:
            r = await client.get(f"{BASE_URL}/health")
            data = r.json()
            ollama = data["ollama"]

            if ollama["ollama_running"]:
                ok("Ollama is running")
            else:
                fail("Ollama is NOT running")
                fail("Fix: open a terminal and run: ollama serve")

            if ollama["model_ready"]:
                ok(f"Model ready: {ollama['model']}")
            else:
                warn(f"Model not found: {ollama['model']}")
                warn(f"Fix: ollama pull {ollama['model']}")
                info(f"Available models: {ollama['available_models']}")

            if not ollama["ollama_running"] or not ollama["model_ready"]:
                warn("Skipping prompt tests — fix Ollama first")
                sys.exit(1)

        except Exception as e:
            fail(f"Health check failed: {e}")
            sys.exit(1)

        # ── Test 3: Prompt endpoint ───────────────────────────
        print(f"\n{BOLD}[3/4] Prompt generation tests{RESET}")

        all_passed = True
        for i, test in enumerate(TEST_PROMPTS):
            print(f"\n  Test {i+1}: {CYAN}{test['name']}{RESET}")
            info(f"Prompt: \"{test['prompt'][:60]}...\"")

            try:
                payload = {
                    "prompt": test["prompt"],
                    "context_code": test.get("context_code"),
                }
                r = await client.post(f"{BASE_URL}/prompt", json=payload)
                r.raise_for_status()
                data = r.json()

                if data["success"]:
                    ok(f"Response received in {data['duration_ms']}ms")
                    ok(f"Intent classified as: {data['intent']}")
                    ok(f"Confidence score: {data['confidence']}")
                    ok(f"Source: {data['source']} / Model: {data['model']}")

                    if data["code"]:
                        lines = len(data["code"].splitlines())
                        ok(f"Code extracted: {lines} lines")
                        print(f"\n  {YELLOW}--- Generated Code (first 8 lines) ---{RESET}")
                        preview = "\n".join(data["code"].splitlines()[:8])
                        for line in preview.splitlines():
                            print(f"    {line}")
                        print(f"  {YELLOW}--- End Preview ---{RESET}\n")
                    else:
                        warn("No code block extracted (model may have responded in prose)")

                    if data["needs_review"]:
                        warn("needs_review = True (low confidence — consider escalation in Phase 3)")
                else:
                    fail(f"Request failed: {data.get('error')}")
                    all_passed = False

            except Exception as e:
                fail(f"Request error: {e}")
                all_passed = False

        # ── Test 4: Summary ───────────────────────────────────
        print(f"\n{BOLD}[4/4] Summary{RESET}")
        if all_passed:
            ok("All tests passed — Phase 1 is working!")
            info("Next step: integrate the /prompt endpoint into your Expo app")
            info("Docs: http://localhost:8000/docs")
        else:
            warn("Some tests had issues — check output above")

    print(f"\n{BOLD}{'='*54}{RESET}\n")


if __name__ == "__main__":
    asyncio.run(run_tests())
