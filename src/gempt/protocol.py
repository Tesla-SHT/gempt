"""Security-safe file context loading and structured Gemini -> GPT task packet formatting."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Iterable

CONSULT_SYSTEM_PROMPT = (
    "You are a specialist GPT reasoning collaborator working behind Gemini (the human-facing orchestrator).\n"
    "Produce dense, precise, verifiable technical analysis rather than conversational filler.\n"
    "Cite exact file paths, line numbers, invariants, failure modes, and concrete verification steps.\n"
    "If provided evidence is insufficient to prove a claim, state the exact missing evidence explicitly."
)

EXEC_SYSTEM_HEADER = (
    "You are executing a task delegated by Gemini (the human-facing orchestrator).\n"
    "Follow the scope and hard constraints strictly, verify your changes by running the requested checks,\n"
    "and conclude with a concise engineering report: changed files, exact commands run and results, and remaining risks."
)


def read_context_files(
    file_paths: Iterable[str] | None,
    *,
    cwd: str | Path | None = None,
    max_file_bytes: int = 131072,
    max_total_bytes: int = 393216,
) -> tuple[list[dict[str, str]], list[str]]:
    """Read requested files safely with line numbers and byte caps.

    Returns (file_blocks, warnings). Never raises on missing/binary files; records a warning instead.
    """
    blocks: list[dict[str, str]] = []
    warnings: list[str] = []
    if not file_paths:
        return blocks, warnings

    base = Path(cwd).expanduser().resolve() if cwd else Path.cwd().resolve()
    total_used = 0

    for raw in file_paths:
        raw_str = str(raw).strip()
        if not raw_str:
            continue
        candidate = Path(raw_str).expanduser()
        if not candidate.is_absolute():
            candidate = (base / candidate).resolve()
        else:
            candidate = candidate.resolve()

        if not candidate.is_relative_to(base):
            raise ValueError(f"Context file is outside workspace: {raw_str}")
        if not candidate.exists():
            warnings.append(f"Skipped missing file: {raw_str}")
            continue
        if not candidate.is_file():
            warnings.append(f"Skipped non-file path: {raw_str}")
            continue

        remaining = max_total_bytes - total_used
        if remaining <= 0:
            warnings.append(f"Total context budget ({max_total_bytes} bytes) reached; skipped {candidate}")
            break

        limit = min(max_file_bytes, remaining)
        try:
            with candidate.open("rb") as stream:
                raw_bytes = stream.read(limit + 1)
        except OSError as exc:
            warnings.append(f"Failed to read {candidate}: {exc}")
            continue

        sample = raw_bytes[:4096]
        if b"\x00" in sample:
            warnings.append(f"Skipped binary file: {candidate}")
            continue

        truncated = len(raw_bytes) > limit
        sliced = raw_bytes[:limit]
        text = sliced.decode("utf-8", errors="replace")
        total_used += len(sliced)

        lines = text.splitlines()
        numbered = "\n".join(f"{idx}: {line}" for idx, line in enumerate(lines, start=1))
        if truncated:
            numbered += f"\n... [truncated at {limit} bytes of {candidate.stat().st_size} total bytes]"

        blocks.append({"path": str(candidate), "content": numbered})

    return blocks, warnings


def build_consult_prompt(
    *,
    goal: str,
    context: str = "",
    file_blocks: list[dict[str, str]] | None = None,
    constraints: str = "",
    expected_output: str = "",
) -> str:
    """Format a structured reasoning/review task packet for gempt_consult."""
    sections: list[str] = [f"## Goal\n{goal.strip()}"]
    if context.strip():
        sections.append(f"## Context\n{context.strip()}")
    if constraints.strip():
        sections.append(f"## Hard Constraints\n{constraints.strip()}")
    if file_blocks:
        rendered_files = []
        for blk in file_blocks:
            rendered_files.append(f"### File: {blk['path']}\n```text\n{blk['content']}\n```")
        sections.append("## Referenced Files\n" + "\n\n".join(rendered_files))
    if expected_output.strip():
        sections.append(f"## Expected Output\n{expected_output.strip()}")
    else:
        sections.append(
            "## Expected Output\n"
            "1. Direct conclusion / recommendation\n"
            "2. Key reasoning, edge cases, and failure modes\n"
            "3. Concrete verification steps or exact next actions"
        )
    return "\n\n".join(sections)


def build_exec_prompt(
    *,
    goal: str,
    context: str = "",
    file_blocks: list[dict[str, str]] | None = None,
    constraints: str = "",
    verification: str = "",
    expected_report: str = "",
    is_resume: bool = False,
) -> str:
    """Format a structured execution task packet for Codex CLI."""
    sections: list[str] = []
    if not is_resume:
        sections.append(EXEC_SYSTEM_HEADER)
    sections.append(f"## Goal\n{goal.strip()}")
    if context.strip():
        sections.append(f"## Context\n{context.strip()}")
    if constraints.strip():
        sections.append(f"## Hard Constraints\n{constraints.strip()}")
    if file_blocks:
        rendered_files = [f"### File: {blk['path']}\n```text\n{blk['content']}\n```" for blk in file_blocks]
        sections.append("## Preloaded Files\n" + "\n\n".join(rendered_files))
    if verification.strip():
        sections.append(f"## Required Verification\n{verification.strip()}")
    if expected_report.strip():
        sections.append(f"## Required Report\n{expected_report.strip()}")
    else:
        sections.append(
            "## Required Report\n"
            "Summarize: (1) modified/created files, (2) exact commands run and observed pass/fail results, (3) any open risks or unverified gaps."
        )
    return "\n\n".join(sections)


def format_result_summary(
    *,
    mode: str,
    session_id: str,
    tier: str,
    model: str,
    effort: str,
    elapsed_sec: float,
    reply_text: str,
    usage: dict | None = None,
    extra: dict | None = None,
) -> str:
    """Render a concise header + reply body suitable for MCP tool output and CLI stdout."""
    meta_parts = [
        f"mode={mode}",
        f"tier={tier}",
        f"model={model}",
        f"effort={effort or 'default'}",
        f"session_id={session_id}",
        f"elapsed={elapsed_sec:.2f}s",
    ]
    if usage:
        tok_in = usage.get("input_tokens") or usage.get("prompt_tokens")
        tok_out = usage.get("output_tokens") or usage.get("completion_tokens")
        if tok_in is not None or tok_out is not None:
            meta_parts.append(f"tokens=in:{tok_in or 0}/out:{tok_out or 0}")
    if extra:
        for k, v in extra.items():
            if v is not None and v != "":
                meta_parts.append(f"{k}={v}")
    header = "[" + " | ".join(meta_parts) + "]"
    return f"{header}\n\n{reply_text.strip()}"
