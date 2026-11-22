"""Durable detached exec and recovery by caller-supplied run ID."""
from __future__ import annotations

from contextlib import nullcontext
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

from .sessions import atomic_json, exclusive_operation, list_sessions, load_session, new_session_id, resolve_sessions_dir, validate_session_id
from .titles import normalize_title


ACTIVE_STATES = {"queued", "running", "waiting_gemini"}


def verification_result(request, commands):
    wanted = request.strip()
    matches = []
    for item in commands:
        command = item.get("command") or ""
        # Codex reports the shell invocation, including its -Command/-lc wrapper.
        match = re.fullmatch(
            r'(?i)(?:"[^"]*(?:pwsh|powershell)(?:\.exe)?"|[^\s"]*(?:pwsh|powershell)(?:\.exe)?)'
            r'(?:\s+(?:-NoProfile|-NonInteractive|-NoLogo|-ExecutionPolicy\s+\S+))*\s+-(?:command|c)\s+(.+)', command)
        if not match:
            match = re.fullmatch(r'(?i)(?:"[^"]*cmd(?:\.exe)?"|cmd(?:\.exe)?)(?:\s+/(?:d|s|q))*\s+/c\s+(.+)', command)
        if match:
            command = match[1]
            if len(command) >= 2 and command[0] == command[-1] and command[0] in {"'", '"'}:
                command = command[1:-1]
        elif command != wanted:
            try:
                parts = shlex.split(command)
            except ValueError:
                parts = []
            if len(parts) == 3 and parts[1] in {"-c", "-lc"}:
                shell_name = Path(parts[0].replace("\\", "/")).name.lower().removesuffix(".exe")
                if shell_name in {"bash", "sh", "zsh"} or parts[0].lower().endswith(("bash.exe", "sh.exe", "zsh.exe")):
                    command = parts[2]
        if wanted and command == wanted and type(item.get("exit_code")) is int:
            matches.append(item)
    state = "unverified" if wanted else "not_requested"
    if matches:
        state = "passed" if matches[-1]["exit_code"] == 0 else "failed"
    return {"status": state, "requested": wanted, "checks": matches, "commands": commands}


def run_directory(run_id):
    if not re.fullmatch(r"[a-f0-9]{32}", run_id):
        raise ValueError("run_id must be 32 lowercase hexadecimal characters")
    return resolve_sessions_dir() / "runs" / run_id


def read_run(run_id):
    state_path = run_directory(run_id) / "state.json"
    if not state_path.is_file():
        raise FileNotFoundError(f"Run '{run_id}' not found.")
    for attempt in range(5):
        try:
            record = json.loads(state_path.read_text(encoding="utf-8"))
            break
        except (PermissionError, json.JSONDecodeError):
            if attempt == 4:
                raise
            time.sleep(0.02)
    if record["state"] in ACTIVE_STATES and time.time() > record.get("deadline", float("inf")):
        record.update(state="outcome_unknown", pending_tool_call=None)
    record["title"] = normalize_title(record.get("title"), record.get("goal"), record.get("cwd"))
    return record


def wait_for_run(run_id, *, timeout_sec: float | None = None, poll_interval: float = 0.25):
    deadline = None if timeout_sec is None else time.monotonic() + timeout_sec
    while True:
        record = read_run(run_id)
        if record["state"] not in {"queued", "running"}:
            return record
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return record
            time.sleep(min(poll_interval, remaining))
        else:
            time.sleep(poll_interval)


def wait_for_runs(run_ids, *, wait_any: bool = True, timeout_sec: float | None = None, poll_interval: float = 0.25):
    ids = [rid.strip() for rid in run_ids if isinstance(rid, str) and rid.strip()]
    if not ids:
        raise ValueError("At least one run_id is required.")
    for rid in ids:
        run_directory(rid)
    deadline = None if timeout_sec is None else time.monotonic() + timeout_sec
    while True:
        records = {rid: read_run(rid) for rid in ids}
        ready = [rid for rid, rec in records.items() if rec["state"] not in {"queued", "running"}]
        active = [rid for rid, rec in records.items() if rec["state"] in {"queued", "running"}]
        if (wait_any and ready) or (not wait_any and not active):
            return {"ready": ready, "active": active, "runs": records}
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return {"ready": ready, "active": active, "runs": records}
            time.sleep(min(poll_interval, remaining))
        else:
            time.sleep(poll_interval)


def _control_run(run_id, method, *, config_path=None, message=None):
    from .app_server_client import AppServerClient, text_input
    record = read_run(run_id)
    thread_id, turn_id = record.get("codex_thread_id"), record.get("turn_id")
    if record["state"] not in {"running", "waiting_gemini"} or not thread_id or not turn_id:
        raise ValueError(f"Run {run_id} has no active Codex turn.")
    if method == "turn/steer":
        params = {"threadId": thread_id, "expectedTurnId": turn_id, "input": text_input(message)}
    else:
        params = {"threadId": thread_id, "turnId": turn_id}
    with AppServerClient(config_path=config_path or record.get("config_path")) as client:
        client.initialize()
        client.request(method, params, timeout=4)
    return {"ok": True, "run_id": run_id, "session_id": record.get("session_id"),
            "thread_id": thread_id, "turn_id": turn_id}


def steer_run(run_id, message, *, config_path=None):
    if not isinstance(message, str) or not message.strip():
        raise ValueError("Steering message must be non-empty.")
    return _control_run(run_id, "turn/steer", config_path=config_path, message=message)


def interrupt_run(run_id, *, config_path=None):
    return _control_run(run_id, "turn/interrupt", config_path=config_path)


def reply_tool_call(run_id, call_id, answer, *, success=True):
    from .app_server_client import tool_reply_path
    path = tool_reply_path(run_directory(run_id), call_id)
    if not isinstance(answer, str) or not isinstance(success, bool):
        raise ValueError("Tool reply requires a text answer and boolean success.")
    record = read_run(run_id)
    if record["state"] != "waiting_gemini" or (record.get("pending_tool_call") or {}).get("call_id") != call_id:
        raise ValueError(f"Run {run_id} is not waiting for tool call {call_id}.")
    path.parent.mkdir(exist_ok=True)
    with exclusive_operation(path.with_suffix(".lock")):
        reply = {"answer": answer, "success": success}
        if path.is_file():
            if json.loads(path.read_text(encoding="utf-8")) != reply:
                raise ValueError("A different reply was already submitted for this tool call.")
        else:
            atomic_json(path, reply)
    return {"ok": True, "run_id": run_id, "session_id": record.get("session_id"), "call_id": call_id}


def _format_cli_command(cli_args: list[str]) -> str:
    runtime = str(Path(__file__).resolve().parents[1])
    bootstrap = (
        "import runpy,sys;sys.path.insert(0,sys.argv.pop(1));"
        "runpy.run_module('gempt.cli',run_name='__main__')"
    )
    argv = [sys.executable, "-I", "-X", "utf8", "-B", "-c", bootstrap, runtime, *cli_args]
    if os.name != "nt":
        return shlex.join(argv)

    def _ps_quote(arg: str) -> str:
        return "'" + arg.replace("'", "''") + "'"

    return "& " + " ".join(_ps_quote(a) for a in argv)


def _wait_shim_available() -> bool:
    if os.environ.get("GEMPT_DISABLE_WAIT_SHIM", "").strip() in {"1", "true", "yes"}:
        return False
    if shutil.which("gempt-wait"):
        return True
    home_bin = Path.home() / "bin"
    candidates = [home_bin / "gempt-wait.cmd", home_bin / "gempt-wait"] if os.name == "nt" else [home_bin / "gempt-wait"]
    return any(p.is_file() for p in candidates)


def build_wait_command(run_id: str) -> str:
    run_directory(run_id)
    if _wait_shim_available():
        return f"gempt-wait {run_id}"
    return _format_cli_command(["status", "--run-id", run_id, "--wait"])


def build_wait_many_command(run_ids: list[str], *, wait_any: bool = True) -> str:
    ids = [rid.strip() for rid in run_ids if isinstance(rid, str) and rid.strip()]
    if not ids:
        raise ValueError("At least one run_id is required.")
    for rid in ids:
        run_directory(rid)
    if _wait_shim_available():
        flag = "" if wait_any else "--all "
        return f"gempt-wait {flag}{','.join(ids)}"
    args = ["status", "--run-ids", ",".join(ids), "--wait"]
    if not wait_any:
        args.append("--wait-all")
    return _format_cli_command(args)


def _cwd_within_root(record: dict, root: Path | None) -> bool:
    if root is None:
        return True
    for candidate in (record.get("source_cwd"), record.get("cwd")):
        if not candidate:
            continue
        try:
            if Path(candidate).resolve().is_relative_to(root):
                return True
        except OSError:
            continue
    return False


def recent_runs(limit, root=None, host_conversation_id=None):
    directory = resolve_sessions_dir() / "runs"
    if not directory.is_dir():
        return []
    files = sorted(directory.glob("*/state.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    items = []
    for path in files:
        try:
            record = read_run(path.parent.name)
            if not _cwd_within_root(record, root):
                continue
            if host_conversation_id and record.get("host_conversation_id") != host_conversation_id:
                continue
            items.append({key: record.get(key) for key in (
                "run_id", "session_id", "cwd", "worktree_path", "source_cwd", "state", "title", "host_conversation_id",
            )})
        except (OSError, json.JSONDecodeError, KeyError, ValueError):
            continue
        if len(items) >= limit:
            break
    return items


def active_runs_summary(limit=20, root=None, host_conversation_id=None):
    directory = resolve_sessions_dir() / "runs"
    if not directory.is_dir():
        return []
    files = sorted(directory.glob("*/state.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    items = []
    for path in files:
        try:
            record = read_run(path.parent.name)
            if record.get("state") not in ACTIVE_STATES:
                continue
            if not _cwd_within_root(record, root):
                continue
            if host_conversation_id and record.get("host_conversation_id") != host_conversation_id:
                continue
            progress = record.get("progress") or {}
            items.append({
                "run_id": record.get("run_id"),
                "session_id": record.get("session_id"),
                "title": record.get("title"),
                "state": record.get("state"),
                "phase": progress.get("phase"),
                "model": record.get("model"),
                "cwd": record.get("cwd"),
                "worktree_path": record.get("worktree_path"),
                "source_cwd": record.get("source_cwd"),
                "host_conversation_id": record.get("host_conversation_id"),
                "last_message": (progress.get("last_message") or "")[-240:],
                "pending_tool_call": record.get("pending_tool_call"),
            })
        except (OSError, json.JSONDecodeError, KeyError, ValueError):
            continue
        if len(items) >= limit:
            break
    return items


def session_roster(limit=15, root=None, host_conversation_id=None):
    """Build a concise per-session GPT roster (for resuming or inspecting parallel threads)."""
    latest_by_session = {}
    directory = resolve_sessions_dir() / "runs"
    if directory.is_dir():
        for path in sorted(directory.glob("*/state.json"), key=lambda p: p.stat().st_mtime, reverse=True):
            try:
                rec = read_run(path.parent.name)
            except (OSError, json.JSONDecodeError, KeyError, ValueError):
                continue
            sid = rec.get("session_id")
            if not sid or sid in latest_by_session:
                continue
            if not _cwd_within_root(rec, root):
                continue
            if host_conversation_id and rec.get("host_conversation_id") != host_conversation_id:
                continue
            latest_by_session[sid] = rec

    roster = []
    seen = set()
    for sess in list_sessions(limit=max(limit * 3, 30)):
        sid = sess.get("session_id")
        if not sid or sid in seen:
            continue
        rec = latest_by_session.get(sid)
        full = load_session(sid) or {}
        if host_conversation_id and (full.get("host_conversation_id") or (rec or {}).get("host_conversation_id")) != host_conversation_id:
            continue
        if not _cwd_within_root(full, root):
            continue
        seen.add(sid)
        progress = (rec or {}).get("progress") or {}
        roster.append({
            "session_id": sid,
            "latest_run_id": (rec or {}).get("run_id"),
            "title": (rec or {}).get("title") or full.get("title") or normalize_title(None, "", full.get("cwd")),
            "mode": full.get("mode", "exec"),
            "state": (rec or {}).get("state", "finished"),
            "model": (rec or {}).get("model") or full.get("model"),
            "cwd": full.get("cwd") or (rec or {}).get("cwd"),
            "worktree_path": full.get("worktree_path") or (rec or {}).get("worktree_path"),
            "source_cwd": full.get("source_cwd") or (rec or {}).get("source_cwd"),
            "turns": len(full.get("turns") or []),
            "updated_at": full.get("updated_at") or "",
            "last_message": (progress.get("last_message") or "")[-200:],
        })
        if len(roster) >= limit:
            break

    # Include newly queued/running sessions that have not written a session json yet.
    for sid, rec in latest_by_session.items():
        if sid in seen or len(roster) >= limit:
            continue
        progress = rec.get("progress") or {}
        roster.insert(0, {
            "session_id": sid,
            "latest_run_id": rec.get("run_id"),
            "title": rec.get("title"),
            "mode": "exec",
            "state": rec.get("state"),
            "model": rec.get("model"),
            "cwd": rec.get("cwd"),
            "worktree_path": rec.get("worktree_path"),
            "source_cwd": rec.get("source_cwd"),
            "turns": 0,
            "updated_at": "",
            "last_message": (progress.get("last_message") or "")[-200:],
        })
    return roster[:limit]


def _write_run_state(directory, record):
    path = directory / "state.json"
    for attempt in range(5):
        try:
            atomic_json(path, record)
            return
        except PermissionError as exc:
            # On Windows a concurrent status reader can briefly block os.replace.
            if getattr(exc, "winerror", None) not in {5, 32} or attempt == 4:
                raise
            time.sleep(0.02)


def dispatch_exec(*, background=False, run_id="", wait_sec: float | None = None, workspace: str | None = None, **options):
    wait_deadline = None if wait_sec is None else time.monotonic() + wait_sec
    source_cwd = str(Path(options["cwd"]).resolve())
    options["cwd"] = source_cwd
    session_id = options.get("session_id")
    host_id = options.get("host_conversation_id")
    worktree_path = ""
    prior = {}
    if session_id:
        try:
            prior = load_session(session_id) or {}
            if not host_id:
                host_id = prior.get("host_conversation_id")
            if prior.get("worktree_path") and Path(prior["worktree_path"]).is_dir():
                worktree_path = str(Path(prior["worktree_path"]).resolve())
                source_cwd = str(prior.get("source_cwd") or source_cwd)
                options["cwd"] = str(Path(prior.get("cwd") or worktree_path).resolve())
        except (OSError, ValueError):
            pass  # The worker validates the session under its lock.
    run_id = run_id or uuid.uuid4().hex
    directory = run_directory(run_id)
    directory.parent.mkdir(parents=True, exist_ok=True)
    try:
        directory.mkdir()  # Exclusive claim; never replay a write on duplicate submission.
    except FileExistsError:
        raise ValueError(f"Run {run_id} already exists; query its status.") from None
    if options.get("config_path"):
        options["config_path"] = str(Path(options["config_path"]).resolve())
    effective_sid = session_id or new_session_id("exec")
    if not session_id:
        options["_new_session_id"] = effective_sid
    if workspace == "share" and not worktree_path:
        from .worktrees import ensure_share_worktree
        try:
            wt = ensure_share_worktree(options["cwd"], effective_sid)
        except Exception:
            try:
                directory.rmdir()
            except OSError:
                pass
            raise
        options["cwd"] = wt["cwd"]
        worktree_path = wt["worktree_root"]
        source_cwd = wt["source_cwd"]
    if worktree_path:
        options["_worktree_path"] = worktree_path
        options["_source_cwd"] = source_cwd
    record = {"run_id": run_id, "state": "queued", "cwd": options["cwd"],
              "worktree_path": worktree_path or None, "source_cwd": source_cwd if worktree_path else None,
              "goal": options.get("goal", ""), "tier": options.get("tier"),
              "title": normalize_title(options.get("title"), options.get("goal"), source_cwd),
              "host_conversation_id": host_id,
              "session_id": effective_sid,
              "config_path": options.get("config_path"), "progress": None,
              "verification": options.get("verification"),
              "created_at": time.time(),
              "deadline": time.time() + 900 + int(options.get("timeout_sec") or 3600)}
    _write_run_state(directory, record)
    try:
        atomic_json(directory / "request.json", options)
        env = os.environ.copy()
        runtime = str(Path(__file__).resolve().parents[1])
        bootstrap = ("import runpy,sys;sys.path.insert(0,sys.argv.pop(1));"
                     "runpy.run_module('gempt.runs',run_name='__main__')")
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        new_group = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        breakaway = getattr(subprocess, "CREATE_BREAKAWAY_FROM_JOB", 0)
        use_launcher = os.name == "nt"
        argv = [sys.executable, "-I", "-c", bootstrap, runtime, run_id]
        if use_launcher:
            # Antigravity also reaps descendants of a live MCP process. The
            # launcher relinquishes parentage before we acknowledge submission.
            launcher = (
                "import subprocess,sys;"
                "fl=getattr(subprocess,'CREATE_NO_WINDOW',0)|getattr(subprocess,'CREATE_NEW_PROCESS_GROUP',0);"
                "subprocess.Popen(sys.argv[1:],stdin=subprocess.DEVNULL,"
                "stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,"
                "creationflags=fl)"
            )
            argv = [sys.executable, "-I", "-c", launcher, *argv]
        if use_launcher and breakaway:
            # Prefer breakaway from host Windows Job Object, but gracefully fall back
            # when the host Job Object denies JOB_OBJECT_LIMIT_BREAKAWAY_OK (WinError 5).
            try:
                proc = subprocess.Popen(
                    argv,
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    env=env, creationflags=flags | breakaway, start_new_session=False,
                )
            except PermissionError as exc:
                if getattr(exc, "winerror", None) != 5 and exc.errno != 13:
                    raise
                proc = subprocess.Popen(
                    argv,
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    env=env, creationflags=flags | new_group, start_new_session=False,
                )
        else:
            proc = subprocess.Popen(
                argv,
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                env=env, creationflags=flags | new_group if use_launcher else flags,
                start_new_session=not use_launcher,
            )
        if use_launcher:
            if proc.wait() != 0:
                raise RuntimeError("Could not launch independent background worker.")
        else:
            # Reap the POSIX child while the caller is alive, without delaying shutdown.
            threading.Thread(target=proc.wait, daemon=True).start()
    except Exception as exc:
        record.update(state="failed", error=str(exc), finished_at=time.time())
        _write_run_state(directory, record)
        raise
    if background:
        return record
    budget = None if wait_deadline is None else max(0, wait_deadline - time.monotonic())
    record = wait_for_run(run_id, timeout_sec=budget)
    if record["state"] in ACTIVE_STATES or record["state"] == "interrupted":
        return record
    if "result" not in record:
        raise RuntimeError(f"{run_id}: {record.get('error', record['state'])}")
    return record["result"]


def git_evidence(cwd):
    def git(*args):
        p = subprocess.run(["git", "-C", cwd, "--no-optional-locks", "-c", "core.fsmonitor=false", *args], capture_output=True,
                           timeout=20, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if p.returncode:
            return None
        return p.stdout[:65536].decode("utf-8", "replace")
    try:
        return {"status": git("status", "--porcelain=v1", "--", "."),
                "diff": git("diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", ".")}
    except (OSError, subprocess.TimeoutExpired):
        return {}


def worker(run_id):
    from .app_server_client import TurnInterrupted
    from .service import run_exec
    directory = run_directory(run_id)
    record = read_run(run_id)
    request = directory / "request.json"
    try:
        options = json.loads(request.read_text(encoding="utf-8"))
        request.unlink()
        record.update(state="running", pid=os.getpid(), started_at=time.time(), before=git_evidence(record["cwd"]))
        _write_run_state(directory, record)
        lock = nullcontext()
        if options.get("session_id"):
            sid = validate_session_id(options["session_id"])
            lock = exclusive_operation(resolve_sessions_dir() / f"{sid}.lock")
        with lock:
            result = run_exec(**options, _run_id=run_id)
        result["run_id"] = run_id
        outcome = {"state": "finished", "result": result}
    except TurnInterrupted as exc:
        outcome = {"state": "interrupted", "error": str(exc)}
    except Exception as exc:
        outcome = {"state": "failed", "error": str(exc)}
    finally:
        record = read_run(run_id)
        record.update(outcome, pending_tool_call=None)
        if record.get("progress"):
            record["progress"].update(phase=record["state"], updated_at=time.time())
        record["after"] = git_evidence(record["cwd"])
        record["finished_at"] = time.time()
        _write_run_state(directory, record)


if __name__ == "__main__":
    worker(sys.argv[1])
