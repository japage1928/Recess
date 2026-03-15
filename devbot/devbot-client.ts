// ============================================================
// devbot-client.ts — Phase 3
// New: force_escalate, escalation fields, cost display,
//      escalation stats dashboard helper
// ============================================================

const DEVBOT_URL = "http://localhost:8000";
// Physical device  → "http://192.168.x.x:8000"
// Android emulator → "http://10.0.2.2:8000"

// ── Types ─────────────────────────────────────────────────────

export interface DevBotRequest {
  prompt: string;
  contextCode?:    string;
  filePath?:       string;
  skipCache?:      boolean;
  forceEscalate?:  boolean; // NEW: skip local model, go straight to Claude
}

export interface DevBotResponse {
  success:             boolean;
  intent:              string;
  code:                string | null;
  explanation:         string;
  confidence:          number;
  source:              "cache" | "local" | "escalated";
  model:               string;
  needs_review:        boolean;
  rag_sources:         string[];
  escalated:           boolean;           // NEW
  escalation_reason:   string | null;     // NEW
  estimated_cost_usd:  number;            // NEW
  duration_ms:         number;
  error:               string | null;
}

export interface EscalationStats {
  total_escalations:                    number;
  total_cost_usd:                       number;
  avg_cost_per_escalation_usd:          number;
  cache_hit_rate_within_escalations:    string;
  escalations_by_intent:                Record<string, number>;
  escalations_by_model:                 Record<string, number>;
  recent_escalations: Array<{
    prompt:   string;
    intent:   string;
    model:    string;
    cost:     number;
    reason:   string;
    cached:   boolean;
  }>;
}


// ── Core: ask the bot ─────────────────────────────────────────
export async function askDevBot(request: DevBotRequest): Promise<DevBotResponse> {
  try {
    const response = await fetch(`${DEVBOT_URL}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt:          request.prompt,
        context_code:    request.contextCode    ?? null,
        file_path:       request.filePath       ?? null,
        skip_cache:      request.skipCache      ?? false,
        force_escalate:  request.forceEscalate  ?? false,
      }),
    });
    if (!response.ok) throw new Error(`Server error: ${response.status}`);
    return await response.json() as DevBotResponse;
  } catch (error) {
    return {
      success: false, intent: "unknown", code: null, explanation: "",
      confidence: 0, source: "local", model: "none",
      needs_review: true, rag_sources: [],
      escalated: false, escalation_reason: null, estimated_cost_usd: 0,
      duration_ms: 0,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}


// ── Escalation stats ──────────────────────────────────────────
export async function getEscalationStats(): Promise<EscalationStats | null> {
  try {
    const r = await fetch(`${DEVBOT_URL}/escalation/stats`);
    return await r.json() as EscalationStats;
  } catch { return null; }
}

export async function resetEscalationLog(): Promise<boolean> {
  try {
    const r = await fetch(`${DEVBOT_URL}/escalation/log`, { method: "DELETE" });
    return r.ok;
  } catch { return false; }
}


// ── Helpers ───────────────────────────────────────────────────

/** Human-readable source label for UI badges */
export function sourceLabel(response: DevBotResponse): string {
  if (response.source === "cache")     return "⚡ Cache (free)";
  if (response.source === "escalated") return "☁️ Claude API";
  return "🤖 Local (free)";
}

/** Format cost for display — only shows if > $0 */
export function formatCost(usd: number): string {
  if (usd === 0) return "Free";
  if (usd < 0.001) return `$${(usd * 1000).toFixed(3)}m`; // millicents
  return `$${usd.toFixed(4)}`;
}


// ── Health / memory ───────────────────────────────────────────
export async function checkHealth() {
  try {
    const r = await fetch(`${DEVBOT_URL}/health`);
    return await r.json();
  } catch { return null; }
}

export async function getMemoryStats() {
  try {
    const r = await fetch(`${DEVBOT_URL}/memory/stats`);
    return await r.json();
  } catch { return null; }
}

export async function addSnippet(snippet: {
  name: string; code: string; description: string; tags?: string[];
}): Promise<boolean> {
  try {
    const r = await fetch(`${DEVBOT_URL}/memory/snippet`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snippet),
    });
    return r.ok;
  } catch { return false; }
}

export async function indexProject(projectPath: string) {
  try {
    const r = await fetch(`${DEVBOT_URL}/index`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_path: projectPath }),
    });
    return await r.json();
  } catch { return null; }
}


// ── Example component with cost display ──────────────────────
/*
import React, { useState } from 'react';
import {
  View, TextInput, TouchableOpacity, Text,
  ActivityIndicator, ScrollView, StyleSheet, Switch
} from 'react-native';
import { askDevBot, sourceLabel, formatCost, DevBotResponse } from './devbot-client';

export default function DevBotScreen() {
  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState<DevBotResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [forceEscalate, setForceEscalate] = useState(false);

  const handleSubmit = async () => {
    if (!prompt.trim()) return;
    setLoading(true);
    const response = await askDevBot({ prompt, forceEscalate });
    setResult(response);
    setLoading(false);
  };

  return (
    <View style={s.container}>
      <TextInput
        value={prompt} onChangeText={setPrompt}
        placeholder="Describe what to build..."
        multiline style={s.input}
      />

      <View style={s.row}>
        <Text style={s.toggleLabel}>Force Claude (paid)</Text>
        <Switch value={forceEscalate} onValueChange={setForceEscalate}
          trackColor={{ true: '#7c6af7' }} />
      </View>

      <TouchableOpacity onPress={handleSubmit} disabled={loading} style={s.btn}>
        {loading
          ? <ActivityIndicator color="#fff" />
          : <Text style={s.btnText}>Generate Code</Text>
        }
      </TouchableOpacity>

      {result && (
        <ScrollView style={s.result}>
          <View style={s.metaRow}>
            <Text style={s.badge}>{sourceLabel(result)}</Text>
            <Text style={s.cost}>{formatCost(result.estimated_cost_usd)}</Text>
            <Text style={s.conf}>{(result.confidence * 100).toFixed(0)}% conf</Text>
          </View>

          {result.escalation_reason && (
            <Text style={s.reason}>Reason: {result.escalation_reason}</Text>
          )}

          {result.rag_sources.length > 0 && (
            <Text style={s.rag}>Context: {result.rag_sources.join(', ')}</Text>
          )}

          {result.needs_review && (
            <Text style={s.warning}>⚠ Low confidence — review before using</Text>
          )}

          <Text style={s.code}>{result.code ?? result.error}</Text>
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: '#0a0a0f' },
  input:     { borderWidth: 1, borderColor: '#2a2a3a', borderRadius: 8,
               padding: 12, color: '#e8e8f0', minHeight: 80, backgroundColor: '#111118' },
  row:       { flexDirection: 'row', alignItems: 'center',
               justifyContent: 'space-between', marginTop: 10 },
  toggleLabel: { color: '#9999bb', fontSize: 13 },
  btn:       { backgroundColor: '#6366f1', padding: 14, borderRadius: 8,
               marginTop: 10, alignItems: 'center' },
  btnText:   { color: '#fff', fontWeight: '600' },
  result:    { marginTop: 16, flex: 1 },
  metaRow:   { flexDirection: 'row', gap: 12, marginBottom: 8 },
  badge:     { color: '#00ff88', fontSize: 12 },
  cost:      { color: '#ff6b35', fontSize: 12 },
  conf:      { color: '#9999bb', fontSize: 12 },
  reason:    { color: '#666680', fontSize: 11, marginBottom: 6 },
  rag:       { color: '#555570', fontSize: 11, marginBottom: 6 },
  warning:   { color: '#ffaa00', fontSize: 12, marginBottom: 8 },
  code:      { backgroundColor: '#111118', borderRadius: 8, padding: 12,
               color: '#e8e8f0', fontFamily: 'monospace', fontSize: 11 },
});
*/
