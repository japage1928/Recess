# ============================================================
# indexer.py — Scans your project directory and loads all
#              source files into ChromaDB as searchable vectors
#
# Run once to index, re-run anytime files change:
#   python -m app.indexer --path /path/to/your/expo/project
#
# Also callable from the API: POST /index
# ============================================================

import os
import asyncio
import argparse
import time
from pathlib import Path
from typing import Optional

from app.memory import index_code_chunk
from app.config import (
    INDEXABLE_EXTENSIONS,
    IGNORE_DIRS,
    MAX_FILE_SIZE_BYTES,
    CHUNK_SIZE,
    CHUNK_OVERLAP,
)


# ── Text chunker ──────────────────────────────────────────────
def chunk_text(text: str, chunk_size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """
    Splits a large file into overlapping chunks so:
    - No single chunk exceeds the embedding model's token limit
    - Context from the end of one chunk bleeds into the start of the next
      (overlap) so we don't lose meaning at boundaries

    Example with chunk_size=1200, overlap=150:
      chunk 0: chars 0–1200
      chunk 1: chars 1050–2250
      chunk 2: chars 2100–3300
      ...
    """
    if len(text) <= chunk_size:
        return [text]

    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunks.append(text[start:end])
        start += chunk_size - overlap

    return chunks


# ── Single file indexer ───────────────────────────────────────
async def index_file(file_path: str, project_root: str) -> tuple[int, int]:
    """
    Reads a single file, splits it into chunks, and indexes each chunk.

    Returns (chunks_indexed, chunks_failed).
    The file_path stored in ChromaDB is relative to project_root
    so it's portable across machines.
    """
    try:
        file_size = os.path.getsize(file_path)
        if file_size > MAX_FILE_SIZE_BYTES:
            return 0, 0  # skip silently

        with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read().strip()

        if not content:
            return 0, 0

        # Store relative path (e.g. "src/screens/HomeScreen.tsx")
        relative_path = os.path.relpath(file_path, project_root)
        chunks = chunk_text(content)

        indexed = 0
        failed = 0

        for i, chunk in enumerate(chunks):
            success = await index_code_chunk(
                content=chunk,
                file_path=relative_path,
                chunk_index=i,
                metadata={"total_chunks": len(chunks), "file_size": file_size},
            )
            if success:
                indexed += 1
            else:
                failed += 1

        return indexed, failed

    except Exception as e:
        print(f"  [!] Error reading {file_path}: {e}")
        return 0, 1


# ── Directory walker ──────────────────────────────────────────
def collect_files(project_path: str) -> list[str]:
    """
    Walks the project directory and returns all indexable file paths,
    skipping ignored directories and unsupported extensions.
    """
    files = []
    project_path = os.path.abspath(project_path)

    for root, dirs, filenames in os.walk(project_path):
        # Prune ignored directories in-place (faster than filtering after)
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS and not d.startswith(".")]

        for filename in filenames:
            _, ext = os.path.splitext(filename)
            if ext.lower() in INDEXABLE_EXTENSIONS:
                files.append(os.path.join(root, filename))

    return sorted(files)


# ── Main indexer function ─────────────────────────────────────
async def index_project(
    project_path: str,
    verbose: bool = True,
) -> dict:
    """
    Full project indexer. Call this:
    - From the CLI: python -m app.indexer --path /your/project
    - From the API: POST /index {"project_path": "..."}
    - On a schedule to keep the index fresh

    Returns a summary dict with counts.
    """
    start = time.time()

    if not os.path.isdir(project_path):
        return {
            "success": False,
            "error": f"Directory not found: {project_path}",
        }

    if verbose:
        print(f"\n{'='*54}")
        print(f"  DevBot Indexer — Phase 2")
        print(f"{'='*54}")
        print(f"  Project: {project_path}")
        print(f"  Chunk size: {CHUNK_SIZE} chars  |  Overlap: {CHUNK_OVERLAP}")
        print(f"{'='*54}\n")

    files = collect_files(project_path)

    if not files:
        return {
            "success": False,
            "error": "No indexable files found. Check INDEXABLE_EXTENSIONS in config.py",
        }

    if verbose:
        print(f"  Found {len(files)} files to index...\n")

    total_indexed = 0
    total_failed = 0
    total_skipped = 0
    file_results = []

    for i, file_path in enumerate(files):
        relative = os.path.relpath(file_path, project_path)

        # Skip files over size limit
        if os.path.getsize(file_path) > MAX_FILE_SIZE_BYTES:
            total_skipped += 1
            if verbose:
                print(f"  [{i+1}/{len(files)}] SKIP  {relative} (too large)")
            continue

        indexed, failed = await index_file(file_path, project_path)

        total_indexed += indexed
        total_failed += failed

        if verbose:
            status = "✓" if indexed > 0 else "✗"
            print(f"  [{i+1}/{len(files)}] {status}  {relative}  ({indexed} chunks)")

        file_results.append({
            "file": relative,
            "chunks": indexed,
            "failed": failed,
        })

    elapsed = round(time.time() - start, 1)

    summary = {
        "success": True,
        "project_path": project_path,
        "files_found": len(files),
        "files_skipped": total_skipped,
        "chunks_indexed": total_indexed,
        "chunks_failed": total_failed,
        "duration_seconds": elapsed,
        "files": file_results,
    }

    if verbose:
        print(f"\n{'='*54}")
        print(f"  Done in {elapsed}s")
        print(f"  Files:  {len(files)} found  |  {total_skipped} skipped")
        print(f"  Chunks: {total_indexed} indexed  |  {total_failed} failed")
        print(f"{'='*54}\n")

    return summary


# ── CLI entry point ───────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Index a project directory into DevBot's knowledge base"
    )
    parser.add_argument(
        "--path",
        required=True,
        help="Path to your Expo/React Native project root",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress per-file output",
    )
    args = parser.parse_args()

    result = asyncio.run(index_project(args.path, verbose=not args.quiet))

    if not result["success"]:
        print(f"\n[ERROR] {result['error']}")
        exit(1)
