# DevBot — Phase 1
### Local-First AI Coding Bot for Your Mobile Dev Tool

---

## What This Is

A FastAPI server that accepts coding prompts from your Expo app and returns
generated React Native / TypeScript code — powered entirely by a free local
AI model (no API costs).

---

## Prerequisites

- Python 3.10+
- [Ollama](https://ollama.com) installed on your machine

---

## Setup (5 minutes)

### Step 1 — Install Ollama

**Mac:**
```bash
brew install ollama
```

**Windows / Linux:**
Download from https://ollama.com/download

---

### Step 2 — Pull the coding model

```bash
ollama pull deepseek-coder:6.7b
```

This downloads ~4GB. Do it once. Alternatives if you're low on RAM:
```bash
ollama pull deepseek-coder:1.3b   # ~800MB — faster, less accurate
ollama pull codellama:7b           # good alternative
```

---

### Step 3 — Start Ollama (keep this terminal open)

```bash
ollama serve
```

---

### Step 4 — Install Python dependencies

In a new terminal, navigate to this folder:
```bash
cd devbot
pip install -r requirements.txt
```

---

### Step 5 — Start the DevBot server

```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Server is now running at: http://localhost:8000
API docs at: http://localhost:8000/docs

---

### Step 6 — Run the tests

```bash
python tests/test_bot.py
```

---

## API Reference

### POST /prompt
Send a coding request, get back generated code.

**Request:**
```json
{
  "prompt": "Create a React Native search bar component",
  "context_code": "// optional: paste existing code here for context",
  "file_path": "src/components/SearchBar.tsx"
}
```

**Response:**
```json
{
  "success": true,
  "intent": "component",
  "code": "import React from 'react';\n...",
  "explanation": "A search bar with debounced input...",
  "confidence": 0.85,
  "source": "local",
  "model": "deepseek-coder:6.7b",
  "needs_review": false,
  "duration_ms": 3240,
  "error": null
}
```

### GET /health
Check if Ollama is running and the model is loaded.

### GET /models
List all models available in your local Ollama install.

---

## Connecting Your Expo App

1. Copy `devbot-client.ts` into your Expo project
2. Update `DEVBOT_URL` at the top of the file:
   - iOS Simulator: `http://localhost:8000`
   - Android Emulator: `http://10.0.2.2:8000`
   - Physical device: `http://YOUR_LAN_IP:8000`
3. Import and use:

```typescript
import { askDevBot } from './devbot-client';

const result = await askDevBot({ prompt: "Build a login screen" });
if (result.success) {
  console.log(result.code);
}
```

---

## Project Structure

```
devbot/
├── app/
│   ├── __init__.py
│   ├── main.py         ← FastAPI server + all routes
│   ├── bot.py          ← Ollama calls, prompt building, scoring
│   └── config.py       ← All settings (model, thresholds, etc.)
├── tests/
│   └── test_bot.py     ← Test suite
├── devbot-client.ts    ← Drop into your Expo app
└── requirements.txt
```

---

## Changing the Model

Open `app/config.py` and change `OLLAMA_MODEL`:
```python
OLLAMA_MODEL = "qwen2.5-coder:7b"  # or "codellama:7b", etc.
```

Then pull the new model: `ollama pull qwen2.5-coder:7b`

---

## What's Coming in Phase 2

- ChromaDB RAG: bot will learn your codebase
- Persistent prompt/answer cache (free answers grow over time)
- Smarter intent classification
- Multi-file context injection

## What's Coming in Phase 3

- Escalation gate to Claude Haiku (paid fallback, only when needed)
- Confidence threshold tuning
- Response caching to avoid paying twice for the same question
