"""Subprocess wrapper for headless Codex CLI (`codex exec` and `codex exec resume`)."""

from __future__ import annotations

import datetime
import json
import uuid
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from .config import is_loopback_url

_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0


class CodexExecError(RuntimeError):
    """Raised when Codex CLI execution fails or cannot start."""


def build_cli_invocation(cli_path: str, args: list[str]) -> list[str]:
    """Build platform-safe argv without shell-interpolating prompts."""
    lower = cli_path.lower()
    if sys.platform == "win32" and lower.endswith((".cmd", ".bat")):
        comspec = os.environ.get("COMSPEC") or "cmd.exe"
        return [comspec, "/d", "/c", cli_path, *args]
    if sys.platform == "win32" and lower.endswith(".ps1"):
        sibling_cmd = Path(cli_path).with_suffix(".cmd")
        if sibling_cmd.is_file():
            comspec = os.environ.get("COMSPEC") or "cmd.exe"
            return [comspec, "/d", "/c", str(sibling_cmd), *args]
        pwsh = shutil.which("pwsh") or shutil.which("powershell") or "powershell.exe"
        return [pwsh, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", cli_path, *args]
    return [cli_path, *args]


def _parse_codex_jsonl(stdout_text: str) -> dict[str, Any]:
    thread_id = ""
    messages: list[str] = []
    usage: dict[str, Any] = {}
    errors: list[str] = []
    commands = []
    failed = False

    for raw_line in stdout_text.splitlines():
        line = raw_line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue

        ev_type = event.get("type")
        if ev_type == "thread.started" and isinstance(event.get("thread_id"), str):
            thread_id = event["thread_id"]
        elif ev_type == "item.completed":
            item = event.get("item") or {}
            if isinstance(item, dict) and item.get("type") == "agent_message":
                txt = item.get("text")
                if isinstance(txt, str) and txt.strip():
                    messages.append(txt.strip())
            elif item.get("type") == "command_execution":
                commands.append({"command": item.get("command"), "exit_code": item.get("exit_code"),
                                 "output": str(item.get("aggregated_output", ""))[-4000:]})
        elif ev_type == "turn.completed" and isinstance(event.get("usage"), dict):
            usage = event["usage"]
        elif ev_type in {"error", "turn.failed"}:
            failed |= ev_type == "turn.failed"
            err_obj = event.get("error") or event.get("message") or event
            errors.append(str(err_obj))

    return {
        "thread_id": thread_id,
        "messages": messages,
        "usage": usage,
        "errors": errors,
        "commands": commands,
        "failed": failed,
    }


def observed_context(thread_id):
    """Read the most recent turn context from Codex's local UUIDv7 rollout."""
    try:
        ident = uuid.UUID(thread_id)
        if ident.version != 7:
            return {}
        created = datetime.datetime.fromtimestamp((ident.int >> 80) / 1000, datetime.timezone.utc)
        root = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex") / "sessions"
        for offset in (0, -1, 1):
            day = created + datetime.timedelta(days=offset)
            for path in (root / day.strftime("%Y/%m/%d")).glob(f"*-{ident}.jsonl"):
                context = {}
                with path.open(encoding="utf-8") as stream:
                    for line in stream:
                        if '"turn_context"' in line:
                            event = json.loads(line)
                            if event.get("type") == "turn_context":
                                ctx = event["payload"]
                                context = {"cwd": ctx.get("cwd"), "sandbox": (ctx.get("sandbox_policy") or {}).get("type")}
                return context
    except (ValueError, OSError, KeyError, OverflowError):
        pass
    return {}


def run_codex_exec(
    *,
    cli_path: str,
    prompt: str,
    cwd: str | Path,
    model: str,
    reasoning_effort: str = "medium",
    sandbox: str = "workspace-write",
    sandbox_explicit: bool = False,
    model_provider: str = "",
    codex_thread_id: str = "",
    gateway_url: str = "",
    gateway_key: str = "",
    extra_args: list[str] | None = None,
    timeout_sec: int = 600,
) -> dict[str, Any]:
    """Execute `codex exec` (or `codex exec resume`) non-interactively via stdin."""
    if not cli_path:
        raise CodexExecError("Codex CLI path not found or configured.")

    workdir = Path(cwd).expanduser().resolve()
    if not workdir.is_dir():
        raise CodexExecError(f"Working directory does not exist: {workdir}")

    fd, temp_out_str = tempfile.mkstemp(prefix="gempt-codex-last-", suffix=".txt")
    os.close(fd)
    temp_out = Path(temp_out_str)

    try:
        is_resume = bool(codex_thread_id.strip())
        args: list[str] = ["exec"]
        if is_resume:
            args.append("resume")
        else:
            args.extend(["-C", str(workdir), "-s", sandbox])

        args.append("--skip-git-repo-check")
        if model:
            args.extend(["-m", model])
        env = os.environ.copy()
        # The npm CLI is a separate process, not the packaged desktop Core.
        for key in ("CODEX_WINDOWS_REGISTERED_CORE", "CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY",
                    "CODEX_APP_TOOLS_PIPE_PATH", "CODEX_SESSION_ID",
                    "CODEX_THREAD_ID", "CODEX_TOOL_CALL_ID"):
            env.pop(key, None)
        if gateway_url:
            if is_loopback_url(gateway_url):
                merged_no_proxy: list[str] = []
                for key in ("NO_PROXY", "no_proxy"):
                    for item in env.get(key, "").split(","):
                        host = item.strip()
                        if host and host not in merged_no_proxy:
                            merged_no_proxy.append(host)
                for host in ("127.0.0.1", "localhost", "::1"):
                    if host not in merged_no_proxy:
                        merged_no_proxy.append(host)
                no_proxy_val = ",".join(merged_no_proxy)
                env["NO_PROXY"] = no_proxy_val
                env["no_proxy"] = no_proxy_val
            model_provider = "gempt_gateway"
            args.extend(["-c", 'model_providers.gempt_gateway.name="Magpie"',
                         "-c", "model_providers.gempt_gateway.base_url=" + json.dumps(gateway_url.rstrip("/") + "/v1"),
                         "-c", 'model_providers.gempt_gateway.wire_api="responses"'])
            if gateway_key:
                env["GEMPT_EXEC_GATEWAY_TOKEN"] = gateway_key
                args.extend(["-c", 'model_providers.gempt_gateway.env_key="GEMPT_EXEC_GATEWAY_TOKEN"'])
        if model_provider:
            args.extend(["-c", f'model_provider="{model_provider}"'])
        if reasoning_effort and reasoning_effort != "none":
            args.extend(["-c", f'model_reasoning_effort="{reasoning_effort}"'])
        if is_resume and sandbox_explicit and sandbox:
            args.extend(["-c", f'sandbox_mode="{sandbox}"'])
        if extra_args:
            args.extend([str(a) for a in extra_args])

        args.extend(["--json", "-o", str(temp_out)])
        if is_resume:
            args.append(codex_thread_id.strip())
        args.append("-")

        if sys.platform == "win32" and Path(cli_path).suffix.lower() in (".ps1", ".cmd", ".bat"):
            # Launch the npm package directly; cmd.exe would reinterpret its arguments.
            package = Path(cli_path).parent / "node_modules/@openai/codex"
            module = package / "bin/codex.js"
            node = shutil.which("node")
            if module.is_file() and node:
                args.insert(0, str(module))
                cli_path = node
        cmd = build_cli_invocation(cli_path, args)
        t0 = time.monotonic()
        try:
            proc = subprocess.run(
                cmd,
                env=env,
                input=prompt.encode("utf-8"),
                cwd=str(workdir),
                capture_output=True,
                timeout=timeout_sec,
                creationflags=_CREATE_NO_WINDOW,
            )
        except subprocess.TimeoutExpired as exc:
            raise CodexExecError(f"Codex exec timed out after {timeout_sec}s in {workdir}") from exc
        except OSError as exc:
            raise CodexExecError(f"Failed to launch Codex CLI ({cli_path}): {exc}") from exc

        elapsed = time.monotonic() - t0
        stdout_text = (proc.stdout or b"").decode("utf-8", errors="replace")
        stderr_text = (proc.stderr or b"").decode("utf-8", errors="replace")
        parsed = _parse_codex_jsonl(stdout_text)

        last_message = ""
        if temp_out.is_file():
            last_message = temp_out.read_text(encoding="utf-8", errors="replace").strip()
        if not last_message and parsed["messages"]:
            last_message = parsed["messages"][-1]

        resolved_thread = parsed["thread_id"] or codex_thread_id.strip()

        if proc.returncode != 0 or parsed["failed"]:
            err_detail = "; ".join(parsed["errors"]) or stderr_text.strip() or stdout_text.strip()[:800]
            raise CodexExecError(
                f"Codex exec failed (exit={proc.returncode}, model={model}, thread={resolved_thread or '-'}): {err_detail}"
            )

        if not last_message:
            raise CodexExecError("Codex exited without a final assistant message.")

        return {
            "text": last_message,
            "codex_thread_id": resolved_thread,
            "observed_context": observed_context(resolved_thread),
            "usage": parsed["usage"],
            "elapsed_sec": elapsed,
            "exit_code": proc.returncode,
            "commands": parsed["commands"],
            "errors": parsed["errors"],
            "stderr": stderr_text.strip(),
        }
    finally:
        try:
            temp_out.unlink(missing_ok=True)
        except OSError:
            pass
