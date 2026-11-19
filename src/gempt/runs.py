"""Durable detached exec and recovery by caller-supplied run ID."""
from __future__ import annotations

from contextlib import nullcontext
import json
import os
import re
import shlex
import subprocess
import sys
import time
import uuid
from pathlib import Path

from .sessions import atomic_json, exclusive_operation, resolve_sessions_dir, validate_session_id


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
    record = json.loads(state_path.read_text(encoding="utf-8"))
    if record["state"] in {"queued", "running"} and time.time() > record["deadline"]:
        record["state"] = "outcome_unknown"
    return record


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
                items.append({key: record[key] for key in ("run_id", "cwd", "state")})
        except (OSError, json.JSONDecodeError, KeyError, ValueError):
            continue
        if len(items) >= limit:
            break
    return items


def dispatch_exec(*, background=False, run_id="", **options):
    run_id = run_id or uuid.uuid4().hex
    directory = run_directory(run_id)
    directory.parent.mkdir(parents=True, exist_ok=True)
    try:
        directory.mkdir()  # Exclusive claim; never replay a write on duplicate submission.
    except FileExistsError:
        raise ValueError(f"Run {run_id} already exists; query its status.") from None
    options["cwd"] = str(Path(options["cwd"]).resolve())
    if options.get("config_path"):
        options["config_path"] = str(Path(options["config_path"]).resolve())
    record = {"run_id": run_id, "state": "queued", "cwd": options["cwd"],
              "deadline": time.time() + 120 + int(options.get("timeout_sec") or 3600)}
    atomic_json(directory / "state.json", record)
    try:
        atomic_json(directory / "request.json", options)
        env = os.environ.copy()
        runtime = str(Path(__file__).resolve().parents[1])
        bootstrap = ("import runpy,sys;sys.path.insert(0,sys.argv.pop(1));"
                     "runpy.run_module('gempt.runs',run_name='__main__')")
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        if os.name == "nt" and background:
            # A host can close its Windows job when the MCP connection ends.
            # Request independent lifetime, retaining the caller's security token.
            flags |= subprocess.CREATE_BREAKAWAY_FROM_JOB
        argv = [sys.executable, "-I", "-c", bootstrap, runtime, run_id]
        detach = background and os.name == "nt"
        if detach:
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
        if detach and proc.wait() != 0:
            raise RuntimeError("Could not launch independent background worker.")
    except Exception as exc:
        record.update(state="failed", error=str(exc))
        atomic_json(directory / "state.json", record)
        raise
    if background:
        return record
    proc.wait()
    record = read_run(run_id)
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
    from .service import run_exec
    directory = run_directory(run_id)
    record = read_run(run_id)
    request = directory / "request.json"
    try:
        options = json.loads(request.read_text(encoding="utf-8"))
        request.unlink()
        record.update(state="running", pid=os.getpid(), before=git_evidence(record["cwd"]))
        atomic_json(directory / "state.json", record)
        lock = nullcontext()
        if options.get("session_id"):
            sid = validate_session_id(options["session_id"])
            lock = exclusive_operation(resolve_sessions_dir() / f"{sid}.lock")
        with lock:
            result = run_exec(**options)
        result["run_id"] = run_id
        record.update(state="finished", result=result)
    except Exception as exc:
        record.update(state="failed", error=str(exc))
    finally:
        record["after"] = git_evidence(record["cwd"])
        atomic_json(directory / "state.json", record)


if __name__ == "__main__":
    worker(sys.argv[1])
