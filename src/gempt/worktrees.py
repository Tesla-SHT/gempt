"""Managed Git worktree isolation for concurrent GemPT GPT workers."""
from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

from .config import ConfigError
from .sessions import validate_session_id


def _no_window_flags() -> int:
    return getattr(subprocess, "CREATE_NO_WINDOW", 0)


def worktrees_root() -> Path:
    """Return a user-local directory outside ~/.config/gempt and outside user repos."""
    override = (os.environ.get("GEMPT_WORKTREES_DIR") or "").strip()
    if override:
        return Path(override).expanduser().resolve()
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or tempfile.gettempdir())
        return (base / "gempt-worktrees").resolve()
    return (Path.home() / ".cache" / "gempt-worktrees").resolve()


def _git_output(cwd: Path, *args: str, timeout: int = 30) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(cwd), "--no-optional-locks", "-c", "core.fsmonitor=false", *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        creationflags=_no_window_flags(),
    )


def ensure_share_worktree(cwd: str | Path, session_id: str) -> dict[str, str]:
    """Create (or reuse) an isolated detached Git worktree bound to session_id."""
    sid = validate_session_id(session_id)
    source_cwd = Path(cwd).expanduser().resolve()
    if not source_cwd.is_dir():
        raise ConfigError(f"`cwd` does not exist or is not a directory: {source_cwd}")

    top = _git_output(source_cwd, "rev-parse", "--show-toplevel")
    if top.returncode != 0 or not top.stdout.strip():
        raise ConfigError(f"workspace='share' requires a Git repository: {source_cwd}")
    repo_root = Path(top.stdout.strip()).resolve()
    try:
        rel = source_cwd.relative_to(repo_root)
    except ValueError:
        rel = Path(".")

    root = worktrees_root()
    root.mkdir(parents=True, exist_ok=True)
    wt_root = (root / sid).resolve()
    if not wt_root.is_relative_to(root):
        raise ConfigError("Invalid worktree target path.")

    if not wt_root.is_dir():
        add = _git_output(repo_root, "worktree", "add", "--detach", str(wt_root), "HEAD", timeout=60)
        if add.returncode != 0:
            detail = (add.stderr or add.stdout or "").strip()
            raise ConfigError(f"Failed to create isolated git worktree: {detail}")

    wt_cwd = (wt_root / rel).resolve()
    if not wt_cwd.is_dir():
        wt_cwd = wt_root

    return {
        "worktree_root": str(wt_root),
        "cwd": str(wt_cwd),
        "source_repo": str(repo_root),
        "source_cwd": str(source_cwd),
    }


def remove_share_worktree(source_repo: str | Path, worktree_root: str | Path) -> bool:
    """Remove a managed worktree cleanly."""
    wt = Path(worktree_root).expanduser().resolve()
    root = worktrees_root()
    if not wt.is_relative_to(root) or not wt.exists():
        return False
    res = _git_output(Path(source_repo).expanduser().resolve(), "worktree", "remove", "--force", str(wt), timeout=30)
    return res.returncode == 0
