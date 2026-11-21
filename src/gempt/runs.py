"""Durable detached exec and recovery by caller-supplied run ID."""
from __future__ import annotations

from contextlib import nullcontext
import json
import os
import re
import shlex
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

from .sessions import atomic_json, exclusive_operation, load_session, new_session_id, resolve_sessions_dir, validate_session_id
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


def build_wait_command(run_id: str) -> str:
    run_directory(run_id)
    runtime = str(Path(__file__).resolve().parents[1])
    bootstrap = (
        "import runpy,sys;sys.path.insert(0,sys.argv.pop(1));"
        "runpy.run_module('gempt.cli',run_name='__main__')"
    )
    argv = [sys.executable, "-I", "-X", "utf8", "-B", "-c", bootstrap, runtime, "status", "--run-id", run_id, "--wait"]
    if os.name != "nt":
        return shlex.join(argv)

    def _ps_quote(arg: str) -> str:
        return "'" + arg.replace("'", "''") + "'"

    return "& " + " ".join(_ps_quote(a) for a in argv)


def recent_runs(limit, root=None):
    directory = resolve_sessions_dir() / "runs"
    if not directory.is_dir():
        return []
    files = sorted(directory.glob("*/state.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    items = []
    for path in files:
        try:
            record = read_run(path.parent.name)
            if root is None or Path(record["cwd"]).resolve().is_relative_to(root):
                items.append({key: record.get(key) for key in ("run_id", "cwd", "state", "title", "host_conversation_id")})
        except (OSError, json.JSONDecodeError, KeyError, ValueError):
            continue
        if len(items) >= limit:
            break
    return items


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


def dispatch_exec(*, background=False, run_id="", wait_sec: float | None = None, **options):
    wait_deadline = None if wait_sec is None else time.monotonic() + wait_sec
    options["cwd"] = str(Path(options["cwd"]).resolve())
    session_id = options.get("session_id")
    host_id = options.get("host_conversation_id")
    if session_id and not host_id:
        try:
            prior = load_session(session_id) or {}
            host_id = prior.get("host_conversation_id")
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
    if not session_id:
        options["_new_session_id"] = new_session_id("exec")
    record = {"run_id": run_id, "state": "queued", "cwd": options["cwd"],
              "goal": options.get("goal", ""), "tier": options.get("tier"),
              "title": normalize_title(options.get("title"), options.get("goal"), options["cwd"]),
              "host_conversation_id": host_id,
              "session_id": session_id or options["_new_session_id"],
              "config_path": options.get("config_path"), "progress": None,
              "verification": options.get("verification"),
              "created_at": time.time(),
              "deadline": time.time() + 120 + int(options.get("timeout_sec") or 3600)}
    _write_run_state(directory, record)
    try:
        atomic_json(directory / "request.json", options)
        env = os.environ.copy()
        runtime = str(Path(__file__).resolve().parents[1])
        bootstrap = ("import runpy,sys;sys.path.insert(0,sys.argv.pop(1));"
                     "runpy.run_module('gempt.runs',run_name='__main__')")
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        use_launcher = os.name == "nt"
        if use_launcher:
            # A host can close its Windows job when the MCP connection ends.
            # Request independent lifetime, retaining the caller's security token.
            flags |= subprocess.CREATE_BREAKAWAY_FROM_JOB
        argv = [sys.executable, "-I", "-c", bootstrap, runtime, run_id]
        if use_launcher:
            # Antigravity also reaps descendants of a live MCP process. The
            # launcher relinquishes parentage before we acknowledge submission.
            launcher = ("import subprocess,sys;"
                        "subprocess.Popen(sys.argv[1:],stdin=subprocess.DEVNULL,"
                        "stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,"
                        "creationflags=subprocess.CREATE_NO_WINDOW)")
            argv = [sys.executable, "-I", "-c", launcher, *argv]
        proc = subprocess.Popen(argv,
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                env=env, creationflags=flags, start_new_session=os.name != "nt")
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
