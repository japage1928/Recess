#!/usr/bin/env python3
# ============================================================
# test_phase3.py — Phase 3 test suite
# Tests: escalation logic, Claude API call, cost logging,
#        force_escalate flag, stats endpoint, log reset
#
# Usage: python tests/test_phase3.py
# ============================================================

import asyncio
import httpx
import sys
import os
import json

BASE_URL = "http://localhost:8000"

GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
CYAN   = "\033[96m"
BOLD   = "\033[1m"
RESET  = "\033[0m"

def ok(msg):      print(f"  {GREEN}✓{RESET} {msg}")
def fail(msg):    print(f"  {RED}✗{RESET} {msg}")
def info(msg):    print(f"  {CYAN}→{RESET} {msg}")
def warn(msg):    print(f"  {YELLOW}⚠{RESET} {msg}")
def section(t):   print(f"\n{BOLD}[{t}]{RESET}")


async def run_tests():
    print(f"\n{BOLD}{'='*58}{RESET}")
    print(f"{BOLD}  DevBot Phase 3 — Escalation Gate Test Suite{RESET}")
    print(f"{BOLD}{'='*58}{RESET}")

    # Check API key presence
    api_key_set = bool(os.environ.get("ANTHROPIC_API_KEY", ""))

    async with httpx.AsyncClient(timeout=180) as client:

        # ── 1: Server health ──────────────────────────────────
        section("1/6  Server health")
        try:
            r = await client.get(f"{BASE_URL}/health")
            r.raise_for_status()
            data = r.json()
            ok("Server running")
            ok(f"Ollama: {data['ollama']['message']}")
            esc = data.get("escalation", {})
            ok(f"Escalations so far: {esc.get('total_escalations', 0)} "
               f"| Total cost: ${esc.get('total_cost_usd', 0):.4f}")
        except Exception as e:
            fail(f"Server not reachable: {e}")
            fail("Run: uvicorn app.main:app --reload")
            sys.exit(1)

        # ── 2: Escalation decision logic (unit test) ──────────
        section("2/6  Escalation classifier (unit tests)")
        sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
        from app.escalator import should_escalate, pick_escalation_model
        from app.config import (
            ESCALATION_MODEL_HAIKU, ESCALATION_MODEL_SONNET,
            ALWAYS_ESCALATE_INTENTS, NEVER_ESCALATE_INTENTS,
        )

        tests = [
            # (confidence, intent, attempts, force, expected_escalate)
            (0.2, "component", 2, False, True,  "low confidence after retries"),
            (0.8, "component", 1, False, False, "high confidence stays local"),
            (0.1, "style",     2, False, False, "style never escalates"),
            (0.1, "architecture", 1, False, True, "architecture always escalates"),
            (0.9, "hook",      1, True,  True,  "force=True overrides confidence"),
            (0.0, "debug",     0, False, False, "0 attempts → not enough retries yet"),
        ]

        all_passed = True
        for conf, intent, attempts, force, expected, label in tests:
            result, reason = should_escalate(conf, intent, attempts, force)
            passed = result == expected
            if passed:
                ok(f"{label}: escalate={result} ({reason})")
            else:
                fail(f"{label}: expected escalate={expected}, got {result}")
                all_passed = False

        # Model tier tests
        model = pick_escalation_model("architecture", 0.1)
        if model == ESCALATION_MODEL_SONNET:
            ok(f"architecture → Sonnet tier (correct)")
        else:
            warn(f"architecture → {model} (expected Sonnet)")

        model = pick_escalation_model("component", 0.3)
        if model == ESCALATION_MODEL_HAIKU:
            ok(f"component → Haiku tier (cheapest, correct)")
        else:
            warn(f"component → {model} (expected Haiku)")

        # ── 3: Local prompt (no escalation expected) ──────────
        section("3/6  Local model prompt (should NOT escalate)")
        info("Sending a simple component prompt...")
        try:
            r = await client.post(f"{BASE_URL}/prompt", json={
                "prompt": "Create a React Native Text component displaying 'Hello World'",
                "skip_cache": True,
                "force_escalate": False,
            })
            data = r.json()
            if data["success"]:
                ok(f"Response in {data['duration_ms']}ms")
                ok(f"Source: {data['source']} | Escalated: {data['escalated']}")
                ok(f"Confidence: {data['confidence']} | Cost: ${data['estimated_cost_usd']:.6f}")
                if not data["escalated"]:
                    ok("Correctly stayed local — $0.00 cost")
                else:
                    warn(f"Escalated unexpectedly: {data['escalation_reason']}")
            else:
                warn(f"Prompt failed: {data.get('error')}")
        except Exception as e:
            fail(f"Request error: {e}")

        # ── 4: Force escalate ─────────────────────────────────
        section("4/6  Force escalate (calls Claude API directly)")
        if not api_key_set:
            warn("ANTHROPIC_API_KEY not set — skipping live Claude test")
            warn("Set it with: export ANTHROPIC_API_KEY='sk-ant-...'")
            warn("Then re-run this test suite")
        else:
            info("Sending force_escalate=True — this will use ~$0.0003 of API credit...")
            try:
                r = await client.post(f"{BASE_URL}/prompt", json={
                    "prompt": (
                        "Design the complete Supabase auth integration for an Expo app: "
                        "sign up, sign in, session persistence, and protected route guard"
                    ),
                    "skip_cache": True,
                    "force_escalate": True,
                })
                data = r.json()
                if data["success"]:
                    ok(f"Claude responded in {data['duration_ms']}ms")
                    ok(f"Model used: {data['model']}")
                    ok(f"Confidence: {data['confidence']}")
                    ok(f"Estimated cost: ${data['estimated_cost_usd']:.6f}")
                    if data["code"]:
                        lines = len(data["code"].splitlines())
                        ok(f"Code extracted: {lines} lines")
                    if data["escalated"]:
                        ok(f"Escalation reason: {data['escalation_reason']}")
                else:
                    fail(f"Escalated call failed: {data.get('error')}")
            except Exception as e:
                fail(f"Force escalate error: {e}")

        # ── 5: Escalation stats ───────────────────────────────
        section("5/6  Escalation stats endpoint")
        try:
            r = await client.get(f"{BASE_URL}/escalation/stats")
            stats = r.json()
            ok(f"Total escalations:  {stats['total_escalations']}")
            ok(f"Total cost (USD):   ${stats['total_cost_usd']:.6f}")
            ok(f"Avg cost per call:  ${stats['avg_cost_per_escalation_usd']:.6f}")

            if stats["escalations_by_intent"]:
                ok(f"By intent: {stats['escalations_by_intent']}")
            if stats["escalations_by_model"]:
                ok(f"By model:  {stats['escalations_by_model']}")
            if stats.get("recent_escalations"):
                ok(f"Most recent: \"{stats['recent_escalations'][0]['prompt'][:60]}...\"")
        except Exception as e:
            fail(f"Stats endpoint error: {e}")

        # ── 6: Architecture prompt (should auto-escalate) ─────
        section("6/6  Architecture intent (auto-escalates if API key set)")
        if not api_key_set:
            warn("Skipping — no API key")
        else:
            info("Sending an architecture-level prompt...")
            try:
                r = await client.post(f"{BASE_URL}/prompt", json={
                    "prompt": "Design the full state management architecture for a React Native truck dispatch app with offline sync",
                    "skip_cache": True,
                    "force_escalate": False,
                })
                data = r.json()
                if data["success"]:
                    ok(f"Intent classified as: {data['intent']}")
                    ok(f"Escalated: {data['escalated']}")
                    ok(f"Reason: {data['escalation_reason']}")
                    ok(f"Cost: ${data['estimated_cost_usd']:.6f}")
                    ok(f"Source: {data['source']} | Model: {data['model']}")
                else:
                    warn(f"Failed: {data.get('error')}")
            except Exception as e:
                fail(f"Request error: {e}")

    # ── Summary ───────────────────────────────────────────────
    print(f"\n{BOLD}{'='*58}{RESET}")
    print(f"{BOLD}  Phase 3 setup checklist:{RESET}")
    print(f"\n  {GREEN if api_key_set else RED}{'✓' if api_key_set else '✗'}{RESET} "
          f"ANTHROPIC_API_KEY {'is set' if api_key_set else 'NOT set — add to run escalation tests'}")
    print(f"  {CYAN}→{RESET}  Set it: export ANTHROPIC_API_KEY='sk-ant-...'")
    print(f"  {CYAN}→{RESET}  View cost log: GET /escalation/stats")
    print(f"  {CYAN}→{RESET}  Reset cost log: DELETE /escalation/log")
    print(f"  {CYAN}→{RESET}  Force Claude: POST /prompt {{force_escalate: true}}")
    print(f"  {CYAN}→{RESET}  API docs: http://localhost:8000/docs")
    print(f"\n  Tune escalation thresholds in app/config.py:")
    print(f"  {CYAN}→{RESET}  CONFIDENCE_THRESHOLD       (when local is 'good enough')")
    print(f"  {CYAN}→{RESET}  ESCALATION_TRIGGER_THRESHOLD (when to call Claude)")
    print(f"  {CYAN}→{RESET}  ALWAYS_ESCALATE_INTENTS    (intents that skip local)")
    print(f"  {CYAN}→{RESET}  NEVER_ESCALATE_INTENTS     (intents that stay local)")
    print(f"{BOLD}{'='*58}{RESET}\n")


if __name__ == "__main__":
    asyncio.run(run_tests())
