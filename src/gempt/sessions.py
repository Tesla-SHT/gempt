"""Lightweight local session persistence for multi-turn consult and Codex exec continuation."""

from __future__ import annotations

import json
import os
import re
import time
import tempfile
from contextlib import contextmanager
import uuid
from pathlib import Path
from typing import Any

from . import SESSIONS_DIR
from .titles import normalize_title, session_goal

_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9_.-]+$")


def resolve_sessions_dir(override: str | Path | None = None) -> Path:
    """Resolve session directory (honors GEMPT_SESSIONS_DIR env for isolation)."""
    if override:
        return Path(override).expanduser().resolve()
    env_dir = os.environ.get("GEMPT_SESSIONS_DIR", "").strip()
    if env_dir:
        return Path(env_dir).expanduser().resolve()
    return SESSIONS_DIR


def validate_session_id(session_id: str) -> str:
    """Ensure session_id is safe for use as a filename stem."""
    cleaned = (session_id or "").strip()
    if not cleaned or not _SAFE_ID_RE.match(cleaned) or ".." in cleaned:
        raise ValueError(f"Invalid session_id '{session_id}'")
    return cleaned


def new_session_id(prefix: str = "consult") -> str:
    """Generate a compact, sortable session ID."""
    ts = time.strftime("%Y%m%d-%H%M%S", time.localtime())
    return f"{prefix}-{ts}-{uuid.uuid4().hex[:8]}"


def load_session(session_id: str, sessions_dir: str | Path | None = None) -> dict[str, Any] | None:
    """Load an existing session record or return None if not found."""
    sid = validate_session_id(session_id)
    path = resolve_sessions_dir(sessions_dir) / f"{sid}.json"
    if not path.is_file():
        return None
    record = json.loads(path.read_text(encoding="utf-8"))
    record["title"] = normalize_title(record.get("title"), session_goal(record), record.get("cwd"))
    return record


def save_session(record: dict[str, Any], sessions_dir: str | Path | None = None) -> Path:
    """Persist a session record to disk."""
    sid = validate_session_id(str(record["session_id"]))
    directory = resolve_sessions_dir(sessions_dir)
    directory.mkdir(parents=True, exist_ok=True)
    record = dict(record)
    record["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime())
    record.setdefault("created_at", record["updated_at"])
    path = directory / f"{sid}.json"
    atomic_json(path, record)
    return path


@contextmanager
def exclusive_operation(path: Path):
    """OS-held lock; process exit releases it even after interruption."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as stream:
        stream.seek(0)
        if os.name == "nt":
            import msvcrt
            try:
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                raise RuntimeError("Another operation is in progress; query status before retrying.") from exc
        else:
            import fcntl
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                raise RuntimeError("Another operation is in progress; query status before retrying.") from exc
        yield


def atomic_json(path: Path, value: dict) -> None:
    fd, name = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def list_sessions(limit: int = 10, sessions_dir: str | Path | None = None) -> list[dict[str, Any]]:
    """Return recent session summaries sorted newest-first by mtime."""
    directory = resolve_sessions_dir(sessions_dir)
    if not directory.is_dir():
        return []
    files = sorted(directory.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    items: list[dict[str, Any]] = []
    for path in files[: max(1, limit)]:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        items.append(
            {
                "session_id": data.get("session_id", path.stem),
                "mode": data.get("mode"),
                "tier": data.get("tier"),
                "model": data.get("model"),
                "codex_thread_id": data.get("codex_thread_id"),
                "cwd": data.get("cwd"),
                "title": normalize_title(data.get("title"), session_goal(data), data.get("cwd")),
                "host_conversation_id": data.get("host_conversation_id"),
                "turns": len(data.get("turns") or []),
                "updated_at": data.get("updated_at"),
            }
        )
    return items
