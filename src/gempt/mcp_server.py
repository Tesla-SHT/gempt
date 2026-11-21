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
from .discover import discover_environment
from .runs import ACTIVE_STATES, build_wait_command, dispatch_exec, interrupt_run, read_run, reply_tool_call, steer_run
from .service import configure_gempt, get_status, run_consult
from .sessions import exclusive_operation, resolve_sessions_dir, validate_session_id
from .workload import SCHEMA as DISPATCH_SCHEMA, dispatch_task

_WRITE_LOCK = threading.Lock()
_CONFIGURE_LOCK = threading.Lock()

TOOLS: list[dict[str, Any]] = [
    {
        "name": "gempt_discover",
        "description": (
            "Scan the local environment for Magpie gateway, exposed GPT/Codex models, free/fast utility models "
            "(e.g. DeepSeek-V4.1-Flash), Magpie CLI routing groups, Codex CLI availability, and existing gempt configuration. "
            "Always call this first during initial setup or troubleshooting."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "magpie_url": {
                    "type": "string",
                    "description": "Optional Magpie gateway base URL override (default: configured or http://127.0.0.1:3425).",
                },
                "config_path": {
                    "type": "string",
                    "description": "Optional explicit gempt config path.",
                },
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "gempt_configure",
        "description": (
            "Create or update the user's gempt configuration (~/.config/gempt/config.json by default), setting the "
            "3-tier GPT routing (sonnet/opus/fable) + utility/compact model, failover mode, sandbox default, and optionally "
            "syncing Magpie routing groups (group/gempt-harness-sonnet, group/gempt-harness-opus, group/gempt-harness-fable)."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "config_path": {"type": "string", "description": "Optional target config file path."},
                "magpie_url": {"type": "string", "description": "Magpie gateway base URL, e.g. http://127.0.0.1:3425."},
                "magpie_api_key": {"type": "string", "description": "Optional Magpie caller key (usually unnecessary for local gateway)."},
                "magpie_cli_path": {"type": "string", "description": "Optional path to magpie / magpie.com executable."},
                "codex_cli_path": {"type": "string", "description": "Optional path to codex executable."},
                "default_sandbox": {
                    "type": "string",
                    "enum": ["read-only", "workspace-write", "danger-full-access"],
                    "description": "Default Codex sandbox mode for gempt_exec.",
                },
                "codex_model_provider": {
                    "type": "string",
                    "description": "Optional Codex model_provider override (e.g. 'magpie' if Codex uses profile/provider separation).",
                },
                "default_tier": {
                    "type": "string",
                    "enum": list(TIER_ORDER),
                    "description": "Default tier used when gempt_consult or gempt_exec omits `tier` (sonnet, opus, or fable).",
                },
                "failover_mode": {
                    "type": "string",
                    "enum": ["subscription_only", "api_fallback", "effort_only"],
                    "default": "subscription_only",
                    "description": "Routing failover policy (subscription_only by default; api_fallback enables openai/* backup).",
                },
                "auto_effort": {
                    "type": "boolean",
                    "description": "If true, deterministically size reasoning effort (low..xhigh) per task complexity on fresh turns (never on resume).",
                },
                "magpie_group_strategy": {
                    "type": "string",
                    "enum": ["order", "smart", "rotate", "pace", "drain", "usage"],
                    "default": "order",
                    "description": "Magpie routing strategy used when syncing gempt-harness-* groups.",
                },
                "utility_model": {
                    "type": "string",
                    "description": "Free/fast model for tier='chore' and Magpie compact rule (e.g. auto/deepseek-v4.1-flash).",
                },
                "use_for_magpie_compact": {
                    "type": "boolean",
                    "default": True,
                    "description": "Add a Magpie `compact` rule pointing to utility_model when syncing gempt-harness-* groups.",
                },
                "tiers": {
                    "type": "object",
                    "description": "Optional per-tier overrides for sonnet, opus, fable (consult_model, exec_model, escalate_model, escalate_effort_threshold, reasoning_effort, fallback_models, max_output_tokens, api_mode, magpie_group_members).",
                },
                "use_magpie_group_ids": {
                    "type": "boolean",
                    "default": False,
                    "description": "If true, point each tier's consult_model/exec_model to group/gempt-harness-{sonnet,opus,fable}.",
                },
                "sync_magpie_groups": {
                    "type": "boolean",
                    "default": False,
                    "description": "If true, invoke Magpie CLI to create/update group/gempt-harness-{sonnet,opus,fable}.",
                },
                "dry_run": {
                    "type": "boolean",
                    "default": False,
                    "description": "Preview generated config and Magpie CLI commands without writing.",
                },
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "gempt_consult",
        "description": (
            "Fast HTTP consultation via Magpie without Codex CLI ~50K tool-injection overhead. "
            "Use tier='chore' for free/fast summarization, log compression, or classification; "
            "tier='sonnet' (~75% daily work, Sol@medium); tier='opus' (~20% complex engineering, Sol@high; escalate=true -> Astra@xhigh); "
            "tier='fable' (~5% extreme bugs/math/algorithms, Astra@xhigh). Supports multi-turn dialogue via session_id; on failure retry in a fresh thread (omit session_id)."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "goal": {"type": "string", "description": "Clear statement of what the model should solve, critique, summarize, or decide."},
                "tier": {
                    "type": "string",
                    "enum": list(CONSULT_TIERS),
                    "description": "Target tier (chore/sonnet/opus/fable). Omit to use routing_policy.default_tier from config.",
                },
                "escalate": {
                    "type": "boolean",
                    "default": False,
                    "description": "For opus tier: escalate from primary (Sol) to escalate_model (Astra) and bump reasoning effort to threshold.",
                },
                "context": {"type": "string", "description": "Verified facts, observations, error messages, and current state."},
                "file_paths": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional files to read and attach cleanly (bounded size, line-numbered).",
                },
                "constraints": {"type": "string", "description": "Hard constraints, invariants, or non-goals."},
                "expected_output": {"type": "string", "description": "Required response structure."},
                "session_id": {"type": "string", "description": "Optional consult session_id to continue prior dialogue."},
                "reasoning_effort": {
                    "type": "string",
                    "enum": ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
                },
                "gemini_family": DISPATCH_SCHEMA["properties"]["gemini_family"],
                "model_override": {"type": "string", "description": "Optional explicit model/group ID override."},
                "max_output_tokens": {"type": "integer", "minimum": 256, "maximum": 128000},
                "api_mode": {"type": "string", "enum": ["responses", "chat"]},
                "cwd": {"type": "string", "description": "Optional base directory for resolving relative file_paths and local .gempt.json."},
            },
            "required": ["goal"],
            "additionalProperties": False,
        },
    },
    {
        "name": "gempt_exec",
        "description": (
            "Delegate an autonomous coding, refactoring, or verification task to headless Codex CLI via Magpie. "
            "Codex can read/edit files and run commands inside cwd. Tiers: sonnet (~75% daily work, Sol@medium), "
            "opus (~20% complex cross-file engineering, Sol@high; escalate=true -> Astra@xhigh), fable (~5% top-tier debugging/architecture, Astra@xhigh). "
            "Supports multi-turn steering via session_id; to escalate after failure, start a fresh thread without session_id."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "goal": {"type": "string", "description": "Exact engineering task and scope for Codex to implement/verify."},
                "cwd": {"type": "string", "description": "Absolute path to the target workspace directory."},
                "tier": {
                    "type": "string",
                    "enum": list(TIER_ORDER),
                    "description": "Target tier (sonnet/opus/fable). Omit to use routing_policy.default_tier from config.",
                },
                "escalate": {
                    "type": "boolean",
                    "default": False,
                    "description": "For opus tier: escalate from Sol to Astra and bump reasoning effort to threshold.",
                },
                "context": {"type": "string", "description": "Verified files, symbols, design choices, and current state."},
                "file_paths": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional key files to preload into the prompt.",
                },
                "constraints": {"type": "string", "description": "Files or behaviors that must NOT be altered."},
                "verification": {"type": "string", "description": "Exact tests/commands Codex must run to verify completion."},
                "expected_report": {"type": "string", "description": "Structure for Codex's final engineering report."},
                "session_id": {"type": "string", "description": "Optional gempt exec session_id to resume/steer."},
                "sandbox": {"type": "string", "enum": ["read-only", "workspace-write", "danger-full-access"]},
                "reasoning_effort": {
                    "type": "string",
                    "enum": ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
                },
                "gemini_family": DISPATCH_SCHEMA["properties"]["gemini_family"],
                "model_override": {"type": "string", "description": "Optional explicit model/group ID override."},
                "timeout_sec": {"type": "integer", "minimum": 30, "maximum": 3600},
            },
            "required": ["goal", "cwd"],
            "additionalProperties": False,
        },
    },
    {
        "name": "gempt_status",
        "description": "Show redacted active gempt config, Magpie & Codex health checks, and recent delegation sessions.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "config_path": {"type": "string"},
                "session_limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 10},
            },
            "additionalProperties": False,
        },
    },
]


TOOLS.append({"name": "gempt_dispatch",
              "description": "First action for substantive tasks. Apply the live Magpie work split and run the selected GPT worker or return a Gemini/board assignment. Pass the original goal before investigation.",
              "inputSchema": DISPATCH_SCHEMA})

for tool in TOOLS:
    properties = tool["inputSchema"]["properties"]
    if tool["name"] in {"gempt_status", "gempt_exec"}:
        properties["run_id"] = {"type": "string", "pattern": "^[0-9a-f]{32}$"}
    if tool["name"] == "gempt_exec":
        properties["background"] = {"type": "boolean", "description": "Return a durable run ID immediately."}


_RUN_ID = {"type": "string", "pattern": "^[0-9a-f]{32}$"}
_TEXT = {"type": "string"}
for name, description, fields, required in (
    ("gempt_steer", "Steer an active Codex turn in the same session.", {"message": _TEXT}, ["message"]),
    ("gempt_interrupt", "Interrupt the active Codex turn and preserve its session.", {}, []),
    ("gempt_reply_tool_call", "Reply to ask_gemini and resume the waiting turn.",
     {"call_id": _TEXT, "answer": _TEXT, "success": {"type": "boolean", "default": True}}, ["call_id", "answer"]),
):
    TOOLS.append({"name": name, "description": description, "inputSchema": {
        "type": "object", "properties": {"run_id": _RUN_ID, **fields},
        "required": ["run_id", *required], "additionalProperties": False,
    }})


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
        wait_sec = float(os.environ.get("GEMPT_MCP_WAIT_SEC", "45.0"))
    except ValueError:
        wait_sec = math.nan
    if not math.isfinite(wait_sec) or wait_sec < 0:
        raise ValueError("GEMPT_MCP_WAIT_SEC must be a finite, non-negative number of seconds.")
    return wait_sec


def _handle_tool_call(name: str, args: dict[str, Any]) -> dict[str, Any]:
    args = dict(args)
    env_root = os.environ.get("GEMPT_WORKSPACE_ROOT", "").strip()
    workspace_root = Path(env_root).resolve() if env_root else None
    trusted_config = Path(os.environ.get("GEMPT_CONFIG") or DEFAULT_CONFIG_PATH).resolve()
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
        data = read_run(args["run_id"])
        if workspace_root is not None and not Path(data["cwd"]).resolve().is_relative_to(workspace_root):
            raise ValueError("Run outside host workspace")
        if name == "gempt_steer":
            data = steer_run(args["run_id"], args["message"], config_path=trusted_config)
        elif name == "gempt_interrupt":
            data = interrupt_run(args["run_id"], config_path=trusted_config)
        elif name == "gempt_reply_tool_call":
            data = reply_tool_call(args["run_id"], args["call_id"], args["answer"], success=args.get("success", True))
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
            magpie_group_strategy=str(args.get("magpie_group_strategy") or "order"),
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
            config_path=trusted_config,
            goal=str(args["goal"]),
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
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "gempt", "version": __version__},
            }
            return {"jsonrpc": "2.0", "id": req_id, "result": result}

        if method == "ping":
            return {"jsonrpc": "2.0", "id": req_id, "result": {}}

        if method == "tools/list":
            return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": TOOLS}}

        if method == "tools/call":
            tool_name = str(params.get("name") or "")
            tool_args = params.get("arguments") or {}
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
                pool = delegations if name in ("gempt_dispatch", "gempt_exec", "gempt_consult") else tools
                pool.submit(_respond, req)
            else:
                _respond(req)
    return 0


def main() -> int:
    """Entry point for `python -m gempt.mcp_server`."""
    return serve_stdio()


if __name__ == "__main__":
    raise SystemExit(main())
