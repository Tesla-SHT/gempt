"""Zero-dependency stdio MCP server exposing gempt discovery, setup, consult, and exec tools."""

from __future__ import annotations

import json
import math
import os
import sys
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from pathlib import Path
from typing import Any

from . import CONSULT_TIERS, DEFAULT_CONFIG_PATH, TIER_ORDER, __version__
from .config import load_config
from .discover import discover_environment
from .host_context import read_host_context
from .mcp_app import APP_RESOURCE, APP_TOOLS, APP_URI, call_app_tool, read_app_resource
from .runs import (
    ACTIVE_STATES, build_wait_command, dispatch_exec, interrupt_run, read_run, reply_tool_call, steer_run, wait_for_run,
)
from .service import configure_gempt, get_status, run_consult
from .sessions import exclusive_operation, resolve_sessions_dir, validate_session_id
from .token_ratio import resolve_budget
from .workload import SCHEMA as DISPATCH_SCHEMA, compact_receipt_text, dispatch_task

_WRITE_LOCK = threading.Lock()
_CONFIGURE_LOCK = threading.Lock()
_RUN_ID_SCHEMA = {"type": "string", "pattern": "^[0-9a-f]{32}$"}
_MAX_CTL_STATUS_BYTES = 500

# Model-visible surface: strictly 3 flat tools (each <= 5 core properties).
# GemPT Live attaches to gpt_ctl({}) while the 4 gempt_app_* tools remain app-only (hidden from model).
TOOLS: list[dict[str, Any]] = [
    {
        "name": "gpt_run",
        "description": (
            "Async-first headless Codex execution inside cwd. Returns immediately with run_id, session_id, and "
            "short wait_command (`gempt-wait <run_id>`). Execute wait_command via run_command(WaitMsBeforeAsync=500) "
            "for zero-poll wakeup; pass workspace='share' for parallel repo edits and session_id to resume."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "goal": {"type": "string", "description": "Task objective, constraints, and verification criteria."},
                "cwd": {"type": "string", "description": "Absolute path to the target workspace directory."},
                "access": {
                    "type": "string",
                    "enum": ["change", "inspect"],
                    "default": "change",
                    "description": "'change' edits/tests workspace; 'inspect' runs read-only investigation.",
                },
                "workspace": {
                    "type": "string",
                    "enum": ["inherit", "share"],
                    "default": "inherit",
                    "description": "'share' creates/reuses an isolated git worktree bound to session_id.",
                },
                "session_id": {"type": "string", "description": "Optional GPT session_id to continue."},
            },
            "required": ["goal", "cwd"],
            "additionalProperties": False,
        },
    },
    {
        "name": "gpt_ask",
        "description": (
            "Fast synchronous GPT HTTP consultation via Magpie (no Codex CLI overhead; receipt <= 3200 chars). "
            "Pass file_paths for GPT to read directly; use tier='chore' for free/fast summarization."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "goal": {"type": "string", "description": "Question, review, summary, or reasoning prompt."},
                "file_paths": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional workspace file paths for GPT to read directly.",
                },
                "cwd": {"type": "string", "description": "Optional base directory for relative file_paths."},
                "tier": {
                    "type": "string",
                    "enum": list(CONSULT_TIERS),
                    "description": "Optional tier (chore/sonnet/opus/fable).",
                },
                "session_id": {"type": "string", "description": "Optional consult session_id to continue."},
            },
            "required": ["goal"],
            "additionalProperties": False,
        },
    },
    {
        "name": "gpt_ctl",
        "description": (
            "Control runs (steer/interrupt/reply) or read a compact status snapshot (<=500B, no polling) and open GemPT Live. "
            "Call with {} to view current session runs in GemPT Live."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["status", "steer", "interrupt", "reply"],
                    "default": "status",
                    "description": "Control action (default: status / open GemPT Live).",
                },
                "run_id": _RUN_ID_SCHEMA,
                "message": {"type": "string", "description": "Steering message (steer) or answer text (reply)."},
                "call_id": {"type": "string", "description": "Pending ask_gemini call_id (reply only)."},
                "scope": {
                    "type": "string",
                    "enum": ["session", "all"],
                    "default": "session",
                    "description": "Run listing scope for status / GemPT Live.",
                },
            },
            "additionalProperties": False,
        },
        "_meta": {
            "ui": {"resourceUri": APP_URI},
            "com.google.antigravity/ui": {
                "entrypoints": [
                    {"type": "aux_pane", "title": "GemPT Live"},
                    {"type": "global", "title": "GemPT Live"},
                ]
            },
        },
    },
    *(tool for name, tool in APP_TOOLS.items() if name != "gempt_live_view"),
]


def _resolve_magpie_config_dir(home: Path) -> Path:
    raw = os.environ.get("MAGPIE_CONFIG_DIR", "").strip()
    if not raw:
        return home / ".config" / "magpie"
    if raw == "~" or raw.startswith(("~/", "~\\")):
        return home / raw[2:]
    return Path(raw)


def _normalize_workspace_cwd(
    raw_cwd: str | None, *, workspace_root: Path | None, trusted_config: Path,
) -> Path:
    if workspace_root is not None:
        cwd = (workspace_root / (raw_cwd or ".")).resolve()
        if not cwd.is_relative_to(workspace_root):
            raise ValueError("cwd outside host workspace")
        return cwd

    if not isinstance(raw_cwd, str) or not raw_cwd.strip():
        raise ValueError("cwd is required and must be a non-empty directory path.")
    cwd = Path(raw_cwd.strip()).resolve()
    if not cwd.is_dir():
        raise ValueError(f"Working directory must be an existing directory: {cwd}")
    home = Path.home().resolve()
    if cwd in (Path(cwd.anchor).resolve(), home):
        raise ValueError(f"Refused blocked workspace root: {cwd}")

    for directory in (trusted_config.parent, _resolve_magpie_config_dir(home),
                      home / ".ssh", home / ".aws", home / ".gnupg"):
        sensitive = directory.resolve()
        if cwd.is_relative_to(sensitive) or sensitive.is_relative_to(cwd):
            raise ValueError(f"Refused sensitive directory as workspace: {cwd}")
    return cwd


def _mcp_wait_sec() -> float:
    try:
        wait_sec = float(os.environ.get("GEMPT_MCP_WAIT_SEC", "10.0"))
    except ValueError:
        wait_sec = math.nan
    if not math.isfinite(wait_sec) or wait_sec < 0:
        raise ValueError("GEMPT_MCP_WAIT_SEC must be a finite, non-negative number of seconds.")
    return wait_sec


def _gpt_run_sync_sec() -> float:
    raw = os.environ.get("GEMPT_GPT_RUN_SYNC_SEC", "0").strip()
    try:
        val = float(raw)
    except ValueError:
        return 0.0
    if not math.isfinite(val) or val < 0:
        return 0.0
    return min(10.0, val)


def _fit_utf8_json(payload: dict[str, Any], limit: int = _MAX_CTL_STATUS_BYTES) -> str:
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    if len(text.encode("utf-8")) <= limit:
        return text
    trimmed = dict(payload)
    for key in ("recent", "active"):
        if isinstance(trimmed.get(key), list):
            items = list(trimmed[key])
            while items and len(json.dumps({**trimmed, key: items}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > limit:
                items.pop()
            trimmed[key] = items
    text = json.dumps(trimmed, ensure_ascii=False, separators=(",", ":"))
    if len(text.encode("utf-8")) <= limit:
        return text
    if isinstance(trimmed.get("err"), str):
        trimmed["err"] = trimmed["err"][:80]
    if isinstance(trimmed.get("msg"), str):
        trimmed["msg"] = trimmed["msg"][:80]
    text = json.dumps(trimmed, ensure_ascii=False, separators=(",", ":"))
    if len(text.encode("utf-8")) <= limit:
        return text
    # Guaranteed <= limit UTF-8 bytes fallback
    minimal = {"ok": True, "split": trimmed.get("split"), "active_n": len(payload.get("active") or [])}
    return json.dumps(minimal, ensure_ascii=False, separators=(",", ":"))[:limit]


def _compact_ctl_status(live_data: dict[str, Any], trusted_config: Path, *, run_id: str | None = None) -> str:
    cfg, _ = load_config(explicit=trusted_config, require_exists=False)
    policy = cfg.get("routing_policy") or {}
    profile = str(policy.get("work_split") or "balanced")
    budget = resolve_budget(profile, policy=policy, config_path=trusted_config)
    share = budget.get("actual_gpt_share")
    if run_id:
        rec = read_run(run_id)
        item: dict[str, Any] = {
            "id": run_id,
            "st": rec.get("state"),
            "sid": rec.get("session_id"),
            "title": str(rec.get("title") or "")[:32],
        }
        if rec.get("state") in ACTIVE_STATES:
            item["wait"] = build_wait_command(run_id)
        if rec.get("pending_tool_call"):
            ptc = rec["pending_tool_call"]
            item["ask"] = {"call_id": ptc.get("call_id"), "q": str((ptc.get("arguments") or {}).get("question") or "")[:100]}
        elif rec.get("error"):
            item["err"] = str(rec["error"])[:140]
        elif (rec.get("result") or {}).get("text"):
            item["msg"] = str(rec["result"]["text"])[:140]
        return _fit_utf8_json(item)

    runs = live_data.get("runs") or []
    active = [
        {"id": r["run_id"], "st": r["state"], "t": str(r.get("title") or "")[:24]}
        for r in runs
        if r.get("state") in ACTIVE_STATES
    ][:4]
    recent = [
        {"id": r["run_id"], "st": r["state"], "t": str(r.get("title") or "")[:20]}
        for r in runs
        if r.get("state") not in ACTIVE_STATES
    ][:3]
    summary = {
        "split": profile,
        "target": budget.get("target_gpt_share"),
        "gpt": share,
        "active": active,
        "recent": recent,
    }
    return _fit_utf8_json(summary)


def _handle_tool_call(name: str, args: dict[str, Any]) -> dict[str, Any]:
    args = dict(args)
    env_root = os.environ.get("GEMPT_WORKSPACE_ROOT", "").strip()
    workspace_root = Path(env_root).resolve() if env_root else None
    trusted_config = Path(os.environ.get("GEMPT_CONFIG") or DEFAULT_CONFIG_PATH).resolve()
    if name in APP_TOOLS:
        return call_app_tool(name, args, root=workspace_root, config=trusted_config)

    if name == "gpt_run":
        goal = str(args.get("goal") or "").strip()
        if not goal:
            raise ValueError("`goal` is required.")
        access = str(args.get("access") or "change").strip()
        if access not in {"change", "inspect"}:
            raise ValueError(f"Invalid access: {access}")
        workspace = str(args.get("workspace") or "inherit").strip()
        if workspace not in {"inherit", "share"}:
            raise ValueError(f"Invalid workspace: {workspace}")
        cwd_str = str(_normalize_workspace_cwd(
            args.get("cwd"), workspace_root=workspace_root, trusted_config=trusted_config,
        ))
        host_ctx = read_host_context(trusted_config)
        host_cid = args.get("host_conversation_id") or host_ctx.get("conversation_id")
        family = args.get("gemini_family") or host_ctx.get("gemini_family")
        sync_sec = _gpt_run_sync_sec()
        background = bool(args.get("background", sync_sec <= 0))
        res = dispatch_exec(
            background=background,
            wait_sec=None if background else sync_sec,
            workspace=workspace,
            config_path=trusted_config,
            goal=goal,
            title=args.get("title"),
            host_conversation_id=host_cid if isinstance(host_cid, str) else None,
            cwd=cwd_str,
            tier=args.get("tier") or None,
            session_id=str(args.get("session_id") or ""),
            sandbox="read-only" if access == "inspect" else None,
            gemini_family=family if isinstance(family, str) else None,
            expected_report=(
                "Report concisely: changed files, verification commands/results, and any remaining blockers. "
                "Omit verbose raw logs."
            ),
        )
        in_progress = res.get("state") in ACTIVE_STATES
        if in_progress or res.get("state") == "interrupted":
            rid = res["run_id"]
            wait_cmd = build_wait_command(rid)
            receipt: dict[str, Any] = {
                "run_id": rid,
                "session_id": res.get("session_id"),
                "state": res.get("state"),
                "wait_command": wait_cmd,
                "text": (
                    f"Run {rid} is waiting for ask_gemini reply (use gpt_ctl action='reply')."
                    if res.get("state") == "waiting_gemini"
                    else f"Run {rid} started. Execute `{wait_cmd}` via run_command(WaitMsBeforeAsync=500) for zero-poll wakeup."
                ),
            }
            if res.get("worktree_path"):
                receipt["worktree_path"] = res["worktree_path"]
            return {"content": [{"type": "text", "text": json.dumps(receipt, ensure_ascii=False)}], "isError": res.get("state") == "interrupted"}
        out = {k: res[k] for k in ("run_id", "session_id", "model", "worktree_path", "verification", "usage", "text") if k in res}
        if "text" in out:
            out["text"] = compact_receipt_text(out["text"], session_id=out.get("session_id"))
        return {
            "content": [{"type": "text", "text": json.dumps(out, ensure_ascii=False)}],
            "isError": (out.get("verification") or {}).get("status") in {"failed", "unverified"},
        }

    if name == "gpt_ask":
        goal = str(args.get("goal") or "").strip()
        if not goal:
            raise ValueError("`goal` is required.")
        raw_cwd = args.get("cwd")
        cwd_norm = None
        if workspace_root is not None or raw_cwd is not None or args.get("file_paths") is not None:
            cwd_norm = str(_normalize_workspace_cwd(
                raw_cwd, workspace_root=workspace_root, trusted_config=trusted_config,
            ))
        host_ctx = read_host_context(trusted_config)
        family = args.get("gemini_family") or host_ctx.get("gemini_family")
        session_id = str(args.get("session_id") or "").strip()
        lock = nullcontext()
        if session_id:
            session_id = validate_session_id(session_id)
            lock = exclusive_operation(resolve_sessions_dir() / f"{session_id}.lock")
        with lock:
            res = run_consult(
                goal=goal,
                tier=args.get("tier") or None,
                file_paths=args.get("file_paths"),
                session_id=session_id,
                gemini_family=family if isinstance(family, str) else None,
                cwd=cwd_norm,
                config_path=trusted_config,
                host_conversation_id=host_ctx.get("conversation_id") if isinstance(host_ctx.get("conversation_id"), str) else None,
            )
        text = compact_receipt_text(res.get("text"), session_id=res.get("session_id"), max_chars=3200)
        receipt = {
            "session_id": res.get("session_id"),
            "model": res.get("served_model"),
            "tier": res.get("tier"),
            "text": text,
        }
        return {"content": [{"type": "text", "text": json.dumps(receipt, ensure_ascii=False)}]}

    if name == "gpt_ctl":
        if "wait_sec" in args:
            raise ValueError("gpt_ctl does not support wait_sec polling; use `gempt-wait <run_id>` via background run_command.")
        action = str(args.get("action") or "status").strip()
        if action not in {"status", "steer", "interrupt", "reply"}:
            raise ValueError(f"Invalid action: {action}")
        run_id = args.get("run_id")
        if action in {"steer", "interrupt", "reply"}:
            if not isinstance(run_id, str) or not run_id:
                raise ValueError(f"run_id is required for action='{action}'.")
            data = read_run(run_id)
            check_cwd = data.get("source_cwd") or data["cwd"]
            if workspace_root is not None and not Path(check_cwd).resolve().is_relative_to(workspace_root):
                raise ValueError("Run outside host workspace")
            if action == "steer":
                res = steer_run(run_id, str(args.get("message") or ""), config_path=trusted_config)
            elif action == "interrupt":
                res = interrupt_run(run_id, config_path=trusted_config)
            else:
                res = reply_tool_call(run_id, str(args.get("call_id") or ""), str(args.get("message") or ""), success=True)
            return {"content": [{"type": "text", "text": _fit_utf8_json(res)}]}
        # action == "status": serve both compact <=500B text for model and full GemPT Live structuredContent for UI
        live_args: dict[str, Any] = {}
        if isinstance(run_id, str) and run_id:
            data = read_run(run_id)
            check_cwd = data.get("source_cwd") or data["cwd"]
            if workspace_root is not None and not Path(check_cwd).resolve().is_relative_to(workspace_root):
                raise ValueError("Run outside host workspace")
            live_args["run_id"] = run_id
        if args.get("scope") in {"session", "all"}:
            live_args["scope"] = args["scope"]
        live_res = call_app_tool("gempt_live_view", live_args, root=workspace_root, config=trusted_config)
        compact_text = _compact_ctl_status(live_res.get("structuredContent") or {}, trusted_config, run_id=live_args.get("run_id"))
        return {
            "content": [{"type": "text", "text": compact_text}],
            "structuredContent": live_res.get("structuredContent"),
        }

    if name in ("gempt_dispatch", "gempt_exec"):
        for key in ("title", "host_conversation_id"):
            if key in args and not isinstance(args[key], str):
                raise ValueError(f"Invalid {key}.")
    if args.get("config_path") and Path(args["config_path"]).resolve() != trusted_config:
        raise ValueError("Config path is outside the host configuration")
    args["config_path"] = str(trusted_config)
    raw_cwd = args.get("cwd")
    if name == "gempt_dispatch":
        if raw_cwd is not None:
            args["cwd"] = str(_normalize_workspace_cwd(
                raw_cwd, workspace_root=workspace_root, trusted_config=trusted_config,
            ))
        data = dispatch_task(args, trusted_config, wait_sec=_mcp_wait_sec())
        return {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}],
                "isError": data.get("state") == "interrupted" or (data.get("state") not in ACTIVE_STATES
                    and (data.get("verification") or {}).get("status") in {"failed", "unverified"})}
    if name == "gempt_exec" or (name == "gempt_consult" and (
        workspace_root is not None or raw_cwd is not None or args.get("file_paths") is not None
    )):
        args["cwd"] = str(_normalize_workspace_cwd(
            raw_cwd, workspace_root=workspace_root, trusted_config=trusted_config,
        ))
    if name in {"gempt_steer", "gempt_interrupt", "gempt_reply_tool_call"} or (name == "gempt_status" and args.get("run_id")):
        wait_sec = args.get("wait_sec", 0) if name == "gempt_status" else 0
        if isinstance(wait_sec, bool) or not isinstance(wait_sec, (int, float)) or not 0 <= wait_sec <= 120:
            raise ValueError("wait_sec must be a number between 0 and 120 seconds.")
        data = read_run(args["run_id"])
        check_cwd = data.get("source_cwd") or data["cwd"]
        if workspace_root is not None and not Path(check_cwd).resolve().is_relative_to(workspace_root):
            raise ValueError("Run outside host workspace")
        if name == "gempt_steer":
            data = steer_run(args["run_id"], args["message"], config_path=trusted_config)
        elif name == "gempt_interrupt":
            data = interrupt_run(args["run_id"], config_path=trusted_config)
        elif name == "gempt_reply_tool_call":
            data = reply_tool_call(args["run_id"], args["call_id"], args["answer"], success=args.get("success", True))
        elif wait_sec > 0:
            data = wait_for_run(args["run_id"], timeout_sec=wait_sec)
        return {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}]}
    if name == "gempt_discover" and args.get("magpie_url"):
        from .config import load_config
        cfg, _ = load_config(explicit=trusted_config, require_exists=False)
        if args["magpie_url"].rstrip("/") != cfg["magpie"]["base_url"].rstrip("/"):
            raise ValueError("Gateway is outside the host configuration")
    if name == "gempt_discover":
        data = discover_environment(
            magpie_url=args.get("magpie_url"),
            config_path=args.get("config_path"),
        )
        return {"content": [{"type": "text", "text": json.dumps(data, indent=2, ensure_ascii=False)}]}

    if name == "gempt_configure":
        from . import VALID_SANDBOXES
        from .config import load_config
        cfg, _ = load_config(explicit=trusted_config, require_exists=False)
        for field, existing in (("magpie_cli_path", cfg["magpie"]["cli_path"]),
                                ("codex_cli_path", cfg["codex"]["cli_path"])):
            if args.get(field) and args[field] != existing:
                raise ValueError(f"Set host-controlled {field} via CLI or trusted configuration.")
        if args.get("magpie_url") and str(args["magpie_url"]).rstrip("/") != str(cfg["magpie"]["base_url"]).rstrip("/"):
            raise ValueError("Set host-controlled magpie_url via CLI or trusted configuration.")
        if args.get("default_sandbox"):
            req_sbx = str(args["default_sandbox"]).strip()
            cur_sbx = str(cfg["codex"]["default_sandbox"]).strip()
            if req_sbx not in VALID_SANDBOXES or VALID_SANDBOXES.index(req_sbx) > VALID_SANDBOXES.index(cur_sbx):
                raise ValueError("Set host-controlled default_sandbox via CLI or trusted configuration.")
        data = configure_gempt(
            config_path=args.get("config_path"),
            magpie_url=args.get("magpie_url"),
            magpie_api_key=args.get("magpie_api_key"),
            magpie_cli_path=args.get("magpie_cli_path"),
            codex_cli_path=args.get("codex_cli_path"),
            default_sandbox=args.get("default_sandbox"),
            codex_model_provider=args.get("codex_model_provider"),
            default_tier=args.get("default_tier"),
            failover_mode=str(args.get("failover_mode") or "subscription_only"),
            auto_effort=args.get("auto_effort"),
            magpie_group_strategy=str(args.get("magpie_group_strategy") or "pace"),
            utility_model=args.get("utility_model"),
            use_for_magpie_compact=args.get("use_for_magpie_compact"),
            tiers_override=args.get("tiers"),
            use_magpie_group_ids=bool(args.get("use_magpie_group_ids", False)),
            sync_groups=bool(args.get("sync_magpie_groups", False)),
            dry_run=bool(args.get("dry_run", False)),
        )
        return {"content": [{"type": "text", "text": json.dumps(data, indent=2, ensure_ascii=False)}]}

    if name == "gempt_consult":
        session_id = str(args.get("session_id") or "").strip()
        lock = nullcontext()
        if session_id:
            session_id = validate_session_id(session_id)
            lock = exclusive_operation(resolve_sessions_dir() / f"{session_id}.lock")
        with lock:
            res = run_consult(
                goal=str(args["goal"]),
                tier=args.get("tier") or None,
                context=str(args.get("context") or ""),
                file_paths=args.get("file_paths"),
                constraints=str(args.get("constraints") or ""),
                expected_output=str(args.get("expected_output") or ""),
                session_id=session_id,
                reasoning_effort=args.get("reasoning_effort"),
                escalate=bool(args.get("escalate", False)),
                model_override=args.get("model_override"),
                gemini_family=args.get("gemini_family"),
                max_output_tokens=args.get("max_output_tokens"),
                api_mode=args.get("api_mode"),
                cwd=args.get("cwd"),
                config_path=trusted_config,
            )
        return {"content": [{"type": "text", "text": res["formatted"]}]}

    if name == "gempt_exec":
        background = bool(args.get("background"))
        res = dispatch_exec(background=background, run_id=args.get("run_id", ""),
            wait_sec=None if background else _mcp_wait_sec(),
            workspace=args.get("workspace") or "inherit",
            config_path=trusted_config,
            goal=str(args["goal"]),
            title=args.get("title"),
            host_conversation_id=args.get("host_conversation_id"),
            cwd=str(args["cwd"]),
            tier=args.get("tier") or None,
            context=str(args.get("context") or ""),
            file_paths=args.get("file_paths"),
            constraints=str(args.get("constraints") or ""),
            verification=str(args.get("verification") or ""),
            expected_report=str(args.get("expected_report") or ""),
            session_id=str(args.get("session_id") or ""),
            sandbox=args.get("sandbox"),
            reasoning_effort=args.get("reasoning_effort"),
            escalate=bool(args.get("escalate", False)),
            model_override=args.get("model_override"),
            gemini_family=args.get("gemini_family"),
            timeout_sec=args.get("timeout_sec"),
        )
        in_progress = res.get("state") in ACTIVE_STATES
        if in_progress and res.get("run_id") and "wait_command" not in res:
            res = {**res, "wait_command": build_wait_command(res["run_id"])}
        return {"content": [{"type": "text", "text": json.dumps(res, ensure_ascii=False)}],
                "isError": res.get("state") == "interrupted" or (not in_progress
                    and (res.get("verification") or {}).get("status") in {"failed", "unverified"})}

    if name == "gempt_status":
        data = get_status(
            workspace_root=workspace_root,
            config_path=args.get("config_path"),
            session_limit=int(args.get("session_limit") or 10),
            host_conversation_id=args.get("host_conversation_id"),
        )
        return {"content": [{"type": "text", "text": json.dumps(data, indent=2, ensure_ascii=False)}]}

    raise KeyError(f"Unknown tool: {name}")


def _write_message(msg: dict[str, Any]) -> None:
    line = (json.dumps(msg, ensure_ascii=False) + "\n").encode("utf-8")
    with _WRITE_LOCK:
        sys.stdout.buffer.write(line)
        sys.stdout.buffer.flush()


def _dispatch_request(req: dict[str, Any]) -> dict[str, Any] | None:
    req_id = req.get("id")
    method = req.get("method", "")
    params = req.get("params") or {}

    if req_id is None or str(method).startswith("notifications/"):
        return None

    try:
        if method == "initialize":
            client_proto = params.get("protocolVersion") or "2024-11-05"
            result = {
                "protocolVersion": client_proto,
                "capabilities": {"tools": {"listChanged": False}, "resources": {"listChanged": False}},
                "serverInfo": {"name": "gempt", "version": __version__},
            }
            return {"jsonrpc": "2.0", "id": req_id, "result": result}

        if method == "ping":
            return {"jsonrpc": "2.0", "id": req_id, "result": {}}

        if method == "tools/list":
            return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": TOOLS}}

        if method == "resources/list":
            return {"jsonrpc": "2.0", "id": req_id, "result": {"resources": [APP_RESOURCE]}}

        if method == "resources/read":
            if params.get("uri") != APP_URI:
                return {"jsonrpc": "2.0", "id": req_id, "error": {
                    "code": -32002, "message": "Resource not found", "data": {"uri": params.get("uri")},
                }}
            return {"jsonrpc": "2.0", "id": req_id, "result": read_app_resource()}

        if method == "tools/call":
            tool_name = str(params.get("name") or "")
            tool_args = params.get("arguments", {})
            if tool_args is None:
                tool_args = {}
            if not isinstance(tool_args, dict):
                raise ValueError("Tool arguments must be a JSON object.")
            try:
                with _CONFIGURE_LOCK if tool_name == "gempt_configure" else nullcontext():
                    tool_res = _handle_tool_call(tool_name, tool_args)
            except Exception as exc:
                sys.stderr.write(f"[gempt-mcp] tool '{tool_name}' error: {exc}\n")
                sys.stderr.flush()
                tool_res = {
                    "content": [{"type": "text", "text": f"Error in {tool_name}: {exc}"}],
                    "isError": True,
                }
            return {"jsonrpc": "2.0", "id": req_id, "result": tool_res}

        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": -32601, "message": f"Method not found: {method}"},
        }
    except Exception as exc:
        sys.stderr.write(traceback.format_exc())
        sys.stderr.flush()
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": -32603, "message": str(exc)},
        }


def _respond(req: dict[str, Any]) -> None:
    resp = _dispatch_request(req)
    if resp is not None:
        _write_message(resp)


def serve_stdio() -> int:
    """Run the newline-delimited JSON-RPC 2.0 MCP loop on stdin/stdout."""
    # Keep status and discovery available even when every delegation worker is busy.
    # On EOF the executors join requests that were accepted, but not detached runs.
    with ThreadPoolExecutor() as tools, ThreadPoolExecutor() as delegations:
        for raw_line in sys.stdin.buffer:
            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except json.JSONDecodeError as exc:
                _write_message({
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {"code": -32700, "message": f"Parse error: {exc}"},
                })
                continue
            if not isinstance(req, dict):
                continue
            if req.get("method") == "tools/call" and req.get("id") is not None:
                params = req.get("params")
                name = params.get("name") if isinstance(params, dict) else None
                pool = delegations if name in ("gpt_run", "gpt_ask", "gempt_dispatch", "gempt_exec", "gempt_consult") else tools
                pool.submit(_respond, req)
            else:
                _respond(req)
    return 0


def main() -> int:
    """Entry point for `python -m gempt.mcp_server`."""
    return serve_stdio()


if __name__ == "__main__":
    raise SystemExit(main())
