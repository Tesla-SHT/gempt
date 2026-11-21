"""Command-line interface for gempt discovery, setup, consult, exec, and plugin install."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import sys
from pathlib import Path
from typing import Any

from . import (
    CONSULT_TIERS,
    DEFAULT_CONFIG_PATH,
    TIER_ALIASES,
    TIER_ORDER,
    VALID_EFFORTS,
    VALID_FAILOVER_MODES,
    VALID_GROUP_STRATEGIES,
    VALID_SANDBOXES,
    __version__,
)
from .agy_install import DEFAULT_AGY_TARGET, build_mcp_config, install_agy
from .config import get_default_tier, load_config, resolve_tier
from .discover import discover_environment
from .presets import apply_native_presets
from .runs import dispatch_exec, interrupt_run, read_run, reply_tool_call, steer_run, wait_for_run, wait_for_runs
from .mcp_server import serve_stdio
from .workload import SCHEMA as DISPATCH_SCHEMA, dispatch_task
from .service import configure_gempt, get_status, run_consult, set_auto_effort, set_default_sandbox, set_default_tier, set_tier_effort

_TIER_CHOICES = (*CONSULT_TIERS, *TIER_ALIASES.keys())


def _configure_stdio_utf8() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass


def _interactive_init(args: argparse.Namespace) -> int:
    info = discover_environment(magpie_url=args.magpie_url, config_path=args.config)
    print(f"gempt setup wizard (v{__version__})")
    print(f"Target config path: {info['config']['path']}")
    gw = info["magpie"]["gateway"]
    if gw.get("reachable"):
        print(
            f"Magpie gateway: OK ({gw['url']}, {gw.get('total_models', 0)} models; "
            f"codex={len(gw.get('codex_subscription_models', []))}, "
            f"openai={len(gw.get('openai_api_models', []))}, "
            f"utility={len(gw.get('utility_candidates', []))}, "
            f"groups={len(gw.get('routing_groups', []))})"
        )
    else:
        print(f"Magpie gateway: UNREACHABLE ({gw.get('error')})")
    codex = info["codex"]
    print(f"Codex CLI: {'OK ' + codex.get('version', '') + ' (' + codex.get('path', '') + ')' if codex.get('found') else 'NOT FOUND'}")

    recs = info.get("recommendations") or {}
    presets = recs.get("presets") or {}
    if not recs.get("available"):
        print("Error: No GPT/Codex models found in Magpie /v1/models. Add/expose GPT models in Magpie first.", file=sys.stderr)
        return 1

    print("\nRouting presets:")
    mode_list = list(VALID_FAILOVER_MODES)
    sub_available = bool((presets.get("subscription_only") or {}).get("tiers"))
    default_idx = "1" if sub_available else "2"
    default_mode = mode_list[int(default_idx) - 1]
    for idx, mode in enumerate(mode_list, start=1):
        p = presets.get(mode) or {}
        tiers = p.get("tiers") or {}
        summary = ", ".join(
            f"{t}={tiers[t]['consult_model']}:{tiers[t]['reasoning_effort']}"
            for t in TIER_ORDER
            if t in tiers
        ) or "unavailable (no matching models)"
        print(f"  [{idx}] {mode}: {p.get('description', '')}")
        print(f"      {summary}")

    choice = input(f"\nSelect preset [1-3, default {default_idx}]: ").strip() or default_idx
    failover_mode = mode_list[int(choice) - 1] if choice in {"1", "2", "3"} else default_mode

    chosen_preset = (presets.get(failover_mode) or {}).get("tiers") or {}
    if not chosen_preset:
        print(f"Error: Preset '{failover_mode}' has no available models in Magpie /v1/models.", file=sys.stderr)
        return 1
    tiers_override: dict[str, dict[str, Any]] = {}
    for t in TIER_ORDER:
        rec = chosen_preset[t]
        m = input(f"  {t} primary model [{rec['consult_model']}]: ").strip() or rec["consult_model"]
        e = input(f"  {t} reasoning_effort [{rec['reasoning_effort']}]: ").strip() or rec["reasoning_effort"]
        tier_entry: dict[str, Any] = {"consult_model": m, "exec_model": m, "reasoning_effort": e}
        if t == "opus" and rec.get("escalate_model"):
            esc = input(f"  {t} escalate model (for hard turns) [{rec['escalate_model']}]: ").strip() or rec["escalate_model"]
            tier_entry["escalate_model"] = esc
        tiers_override[t] = tier_entry

    default_util = recs.get("utility_model") or ""
    util_prompt = f"\nFree/fast utility model for chore & Magpie compact [{default_util or 'none'}]: "
    util_val = input(util_prompt).strip() or default_util

    sync_ans = input("\nCreate/update Magpie routing groups group/gempt-harness-{sonnet,opus,fable}? [y/N]: ").strip().lower()
    sync_groups = sync_ans in {"y", "yes"}
    use_group_ids = False
    if sync_groups:
        use_ans = input("Point gempt tiers to group/gempt-harness-{sonnet,opus,fable}? [Y/n]: ").strip().lower()
        use_group_ids = use_ans in {"", "y", "yes"}

    sbx = input("Default Codex sandbox [workspace-write / read-only / danger-full-access, default workspace-write]: ").strip() or "workspace-write"
    result = configure_gempt(
        config_path=args.config,
        magpie_url=args.magpie_url,
        default_sandbox=sbx,
        failover_mode=failover_mode,
        magpie_group_strategy=args.strategy,
        utility_model=util_val,
        tiers_override=tiers_override,
        use_magpie_group_ids=use_group_ids,
        sync_groups=sync_groups,
        dry_run=args.dry_run,
    )
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


def _cmd_install_agy(args: argparse.Namespace) -> int:
    target = Path(args.target).expanduser().resolve()
    source = Path(args.source).expanduser().resolve() if args.source else None
    mcp_config = install_agy(target, source=source, force=args.force)
    print(json.dumps({
        "installed": True,
        "plugin_dir": str(target),
        "mcp_config": mcp_config,
        "next_steps": [
            "Reload the plugin in Antigravity and run /gempt to configure it.",
            "For a standalone stdio MCP client, run gempt print-mcp --installed.",
        ],
    }, indent=2, ensure_ascii=False))
    return 0


def _cmd_print_mcp(args: argparse.Namespace) -> int:
    if args.installed:
        config_file = Path(args.target).expanduser() / "mcp_config.json"
        config = json.loads(config_file.read_text(encoding="utf-8"))
    else:
        config = build_mcp_config(Path(__file__).resolve().parent.parent)
    print(json.dumps(config, indent=2, ensure_ascii=False))
    return 0


def _cmd_presets(apply: bool, cli_path: str = "", as_json: bool = False) -> int:
    res = apply_native_presets(cli_path=cli_path, apply=apply)
    if as_json:
        print(json.dumps(res, indent=2, ensure_ascii=False))
    else:
        for command in res["commands"]:
            print(shlex.join(command))
        if res["applied"]:
            print(f"Applied native Magpie groups: {', '.join(res['groups'])}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="gempt", description="Gemini x GPT dual-mode orchestrator via Magpie")
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    p_disc = sub.add_parser("discover", help="Discover local Magpie, models, routing groups, and Codex CLI")
    p_disc.add_argument("--magpie-url", default=None)
    p_disc.add_argument("--config", default=None)
    p_disc.add_argument("--json", action="store_true", help="Print JSON output (default)")

    p_init = sub.add_parser("init", help="Initialize or update gempt configuration")
    p_init.add_argument("--config", default=None)
    p_init.add_argument("--magpie-url", default=None)
    p_init.add_argument("--failover", choices=VALID_FAILOVER_MODES, default="subscription_only")
    p_init.add_argument("--strategy", choices=VALID_GROUP_STRATEGIES, default="order")
    p_init.add_argument("--sandbox", choices=VALID_SANDBOXES, default="workspace-write")
    p_init.add_argument("--utility-model", default=None)
    p_init.add_argument("--no-compact-rule", action="store_true", help="Do not add Magpie compact rule when syncing groups")
    p_init.add_argument("--sync-magpie", action="store_true", help="Create/update group/gempt-harness-{sonnet,opus,fable} in Magpie")
    p_init.add_argument("--use-groups", action="store_true", help="Point gempt tiers to group/gempt-harness-{sonnet,opus,fable}")
    p_init.add_argument("--non-interactive", action="store_true", help="Use discovered preset defaults without prompts")
    p_init.add_argument("--dry-run", action="store_true", help="Preview changes without writing config or groups")

    dispatch = sub.add_parser("dispatch", help="Apply the current ordinary or Swarm work split")
    for name, prop in DISPATCH_SCHEMA["properties"].items():
        if prop["type"] == "boolean":
            dispatch.add_argument("--" + name.replace("_", "-"), action="store_true", default=None, help=prop.get("description"))
        else:
            dispatch.add_argument("--" + name.replace("_", "-"), choices=prop.get("enum"),
                                  action="append" if prop["type"] == "array" else "store",
                                  required=name in DISPATCH_SCHEMA["required"], help=prop.get("description"))
    dispatch.add_argument("--config")

    p_cons = sub.add_parser("consult", help="Consult GPT/utility via Magpie HTTP API (no Codex tool overhead)")
    p_cons.add_argument("--tier", choices=_TIER_CHOICES, default=None, help="Target tier (defaults to routing_policy.default_tier)")
    p_cons.add_argument("--escalate", action="store_true", help="For opus tier: escalate to escalate_model (e.g. Astra)")
    p_cons.add_argument("--goal", required=True)
    p_cons.add_argument("--context", default="")
    p_cons.add_argument("--constraints", default="")
    p_cons.add_argument("--expected-output", default="")
    p_cons.add_argument("--file", dest="files", action="append", default=[])
    p_cons.add_argument("--session", default="")
    p_cons.add_argument("--effort", choices=VALID_EFFORTS, default=None)
    p_cons.add_argument("--model", default=None)
    p_cons.add_argument("--max-tokens", type=int, default=None)
    p_cons.add_argument("--api-mode", choices=("responses", "chat"), default=None)
    p_cons.add_argument("--cwd", default=None)
    p_cons.add_argument("--config", default=None)
    p_cons.add_argument("--json", action="store_true")

    p_exec = sub.add_parser("exec", help="Delegate coding/verification task to headless Codex CLI")
    p_exec.add_argument("--tier", choices=(*TIER_ORDER, "lite", "mid", "max"), default=None, help="Target tier (defaults to routing_policy.default_tier)")
    p_exec.add_argument("--escalate", action="store_true", help="For opus tier: escalate to escalate_model (e.g. Astra)")
    p_exec.add_argument("--cwd", default=".")
    p_exec.add_argument("--workspace", choices=("inherit", "share"), default="inherit")
    p_exec.add_argument("--goal", required=True)
    p_exec.add_argument("--title")
    p_exec.add_argument("--host-conversation-id")
    p_exec.add_argument("--context", default="")
    p_exec.add_argument("--constraints", default="")
    p_exec.add_argument("--verification", default="")
    p_exec.add_argument("--expected-report", default="")
    p_exec.add_argument("--file", dest="files", action="append", default=[])
    p_exec.add_argument("--session", default="")
    p_exec.add_argument("--sandbox", choices=VALID_SANDBOXES, default=None)
    p_exec.add_argument("--effort", choices=VALID_EFFORTS, default=None)
    p_exec.add_argument("--model", default=None)
    p_exec.add_argument("--timeout", type=int, default=None)
    p_exec.add_argument("--config", default=None)
    p_exec.add_argument("--background", action="store_true")
    p_exec.add_argument("--run-id", default="")
    p_exec.add_argument("--json", action="store_true")

    p_stat = sub.add_parser("status", help="Show active configuration and health")
    p_stat.add_argument("--run-id", default="")
    p_stat.add_argument("--run-ids", default="", help="Comma-separated run IDs for batch status/wait")
    p_stat.add_argument("--wait", action="store_true", help="Wait until the run (or any run in --run-ids) finishes or requests Gemini input")
    p_stat.add_argument("--wait-all", action="store_true", help="With --run-ids --wait, wait until all runs reach a non-running state")
    p_stat.add_argument("--config", default=None)
    p_stat.add_argument("--sessions", type=int, default=10)

    steer = sub.add_parser("steer", help="Send a message to an active Codex turn")
    steer.add_argument("--run-id", required=True)
    steer.add_argument("--message", required=True)
    steer.add_argument("--config")

    interrupt = sub.add_parser("interrupt", help="Interrupt an active Codex turn")
    interrupt.add_argument("--run-id", required=True)
    interrupt.add_argument("--config")

    reply = sub.add_parser("reply-tool", help="Reply to a pending ask_gemini call")
    reply.add_argument("--run-id", required=True)
    reply.add_argument("--call-id", required=True)
    reply.add_argument("--answer", required=True)
    reply.add_argument("--failure", action="store_true", help="Report that the requested action failed")

    p_tier = sub.add_parser("tier", help="Show or switch the default gempt tier (sonnet/opus/fable)")
    p_tier.add_argument("value", nargs="?", choices=(*TIER_ORDER, "lite", "mid", "max"), default=None)
    p_tier.add_argument("--config", default=None)
    p_tier.add_argument("--json", action="store_true")

    p_sbx = sub.add_parser("sandbox", help="Show or switch the default Codex sandbox (read-only/workspace-write/danger-full-access)")
    p_sbx.add_argument("value", nargs="?", choices=VALID_SANDBOXES, default=None)
    p_sbx.add_argument("--config", default=None)
    p_sbx.add_argument("--json", action="store_true")

    p_eff = sub.add_parser("effort", help="Show or switch reasoning effort (low/medium/high/xhigh/auto)")
    p_eff.add_argument("value", nargs="?", choices=("low", "medium", "high", "xhigh", "auto"), default=None)
    p_eff.add_argument("--tier", choices=TIER_ORDER, default=None)
    p_eff.add_argument("--config", default=None)
    p_eff.add_argument("--json", action="store_true")

    sub.add_parser("mcp", help="Run gempt stdio MCP server")

    p_inst = sub.add_parser("install-agy", help="Install gempt plugin into Antigravity config directory")
    p_inst.add_argument("--target", default=str(DEFAULT_AGY_TARGET))
    p_inst.add_argument("--source", default=None, help="Path to source plugin/ folder")
    p_inst.add_argument("--force", action="store_true")

    p_pmcp = sub.add_parser("print-mcp", help="Print standalone stdio MCP client configuration")
    p_pmcp.add_argument("--installed", action="store_true", help="Read the installed Antigravity MCP config")
    p_pmcp.add_argument("--target", default=str(DEFAULT_AGY_TARGET))

    p_pres = sub.add_parser("presets", help="Preview or apply native Magpie groups group/gempt-{sonnet,opus,fable}")
    p_pres.add_argument("--apply", action="store_true", help="Create the native Magpie routing groups")
    p_pres.add_argument("--magpie-cli", default="", help="Optional path to magpie / magpie.com executable")
    p_pres.add_argument("--json", action="store_true", help="Print structured JSON output")

    p_install = sub.add_parser("install", help="Install the Antigravity plugin or manage Magpie presets")
    mode = p_install.add_mutually_exclusive_group()
    for flag, description in (
        ("plugin", "Install the Antigravity plugin (default)"),
        ("preview", "Preview Magpie route group commands"),
        ("apply", "Create the Magpie route groups"),
        ("print-mcp", "Print standalone stdio MCP configuration from the installed plugin"),
        ("all", "Create the Magpie route groups and install the Antigravity plugin"),
    ):
        mode.add_argument(f"--{flag}", action="store_const", const=flag, dest="mode", help=description)
    p_install.set_defaults(mode="plugin")
    p_install.add_argument("--target", default=str(DEFAULT_AGY_TARGET))
    p_install.add_argument("--source", default=None, help="Path to source plugin/ folder")
    p_install.add_argument("--force", action="store_true")
    p_install.add_argument("--magpie-cli", default="", help="Optional path to the Magpie executable")

    return parser


def main(argv: list[str] | None = None) -> int:
    _configure_stdio_utf8()
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        if args.command == "discover":
            data = discover_environment(magpie_url=args.magpie_url, config_path=args.config)
            print(json.dumps(data, indent=2, ensure_ascii=False))
            return 0

        if args.command == "init":
            if args.non_interactive or not sys.stdin.isatty():
                res = configure_gempt(
                    config_path=args.config,
                    magpie_url=args.magpie_url,
                    default_sandbox=args.sandbox,
                    failover_mode=args.failover,
                    magpie_group_strategy=args.strategy,
                    utility_model=args.utility_model,
                    use_for_magpie_compact=not args.no_compact_rule,
                    use_magpie_group_ids=args.use_groups,
                    sync_groups=args.sync_magpie,
                    dry_run=args.dry_run,
                )
                print(json.dumps(res, indent=2, ensure_ascii=False))
                return 0
            return _interactive_init(args)

        if args.command == "dispatch":
            packet = {key: getattr(args, key) for key in DISPATCH_SCHEMA["properties"] if getattr(args, key) is not None}
            result = dispatch_task(packet, args.config or os.environ.get("GEMPT_CONFIG") or DEFAULT_CONFIG_PATH)
            print(json.dumps(result, ensure_ascii=False))
            return int(result.get("state") == "interrupted" or (result.get("verification") or {}).get("status") in {"failed", "unverified"})

        if args.command == "consult":
            res = run_consult(
                goal=args.goal,
                tier=args.tier,
                context=args.context,
                file_paths=args.files,
                constraints=args.constraints,
                expected_output=args.expected_output,
                session_id=args.session,
                reasoning_effort=args.effort,
                escalate=args.escalate,
                model_override=args.model,
                max_output_tokens=args.max_tokens,
                api_mode=args.api_mode,
                cwd=args.cwd,
                config_path=args.config,
            )
            if args.json:
                print(json.dumps(res, indent=2, ensure_ascii=False))
            else:
                print(res["formatted"])
            return 0

        if args.command == "exec":
            res = dispatch_exec(background=args.background, run_id=args.run_id, workspace=args.workspace,
                goal=args.goal,
                title=args.title,
                host_conversation_id=args.host_conversation_id,
                cwd=args.cwd,
                tier=args.tier,
                context=args.context,
                file_paths=args.files,
                constraints=args.constraints,
                verification=args.verification,
                expected_report=args.expected_report,
                session_id=args.session,
                sandbox=args.sandbox,
                reasoning_effort=args.effort,
                escalate=args.escalate,
                model_override=args.model,
                timeout_sec=args.timeout,
                config_path=args.config,
            )
            if args.json or args.background or "formatted" not in res:
                print(json.dumps(res, indent=2, ensure_ascii=False))
            else:
                print(res["formatted"])
                if res.get("run_id"):
                    print(f"\n[run_id={res['run_id']}]")
            return int(res.get("state") == "interrupted" or (res.get("verification") or {}).get("status") in {"failed", "unverified"})

        if args.command == "status" and args.run_ids:
            ids = [x.strip() for x in args.run_ids.split(",") if x.strip()]
            if args.wait or args.wait_all:
                batch = wait_for_runs(ids, wait_any=not args.wait_all)
            else:
                records = {rid: read_run(rid) for rid in ids}
                batch = {
                    "ready": [rid for rid, rec in records.items() if rec["state"] not in {"queued", "running"}],
                    "active": [rid for rid, rec in records.items() if rec["state"] in {"queued", "running"}],
                    "runs": records,
                }
            print(json.dumps(batch, ensure_ascii=False, indent=2))
            return 0

        if args.command == "status" and args.run_id:
            record = wait_for_run(args.run_id) if args.wait else read_run(args.run_id)
            print(json.dumps(record, ensure_ascii=False, indent=2))
            return int(args.wait and record.get("state") in {"failed", "outcome_unknown", "interrupted"})

        if args.command in {"steer", "interrupt", "reply-tool"}:
            if args.command == "steer":
                result = steer_run(args.run_id, args.message, config_path=args.config)
            elif args.command == "interrupt":
                result = interrupt_run(args.run_id, config_path=args.config)
            else:
                result = reply_tool_call(args.run_id, args.call_id, args.answer, success=not args.failure)
            print(json.dumps(result, ensure_ascii=False))
            return 0

        if args.command == "status":
            data = get_status(config_path=args.config, session_limit=args.sessions)
            print(json.dumps(data, indent=2, ensure_ascii=False))
            return 0

        if args.command == "tier":
            if args.value is not None:
                res = set_default_tier(args.value, config_path=args.config)
                if args.json:
                    print(json.dumps(res, indent=2, ensure_ascii=False))
                else:
                    resolved = res["resolved"]
                    print(f"default_tier: {res['default_tier']} ({resolved['model']}, effort={resolved['reasoning_effort']})")
            else:
                cfg, cfg_path = load_config(explicit=args.config, require_exists=True)
                tier_name = get_default_tier(cfg)
                resolved = resolve_tier(cfg, tier_name)
                res = {"default_tier": tier_name, "config_path": str(cfg_path), "resolved": resolved}
                if args.json:
                    print(json.dumps(res, indent=2, ensure_ascii=False))
                else:
                    print(f"default_tier: {tier_name} ({resolved['model']}, effort={resolved['reasoning_effort']})")
            return 0

        if args.command == "sandbox":
            if args.value is not None:
                res = set_default_sandbox(args.value, config_path=args.config)
                if args.json:
                    print(json.dumps(res, indent=2, ensure_ascii=False))
                else:
                    print(f"default_sandbox: {res['default_sandbox']}")
            else:
                cfg, cfg_path = load_config(explicit=args.config, require_exists=True)
                sbx_val = str(cfg.get("codex", {}).get("default_sandbox") or "workspace-write")
                res = {"default_sandbox": sbx_val, "config_path": str(cfg_path)}
                if args.json:
                    print(json.dumps(res, indent=2, ensure_ascii=False))
                else:
                    print(f"default_sandbox: {sbx_val}")
            return 0

        if args.command == "effort":
            if args.value == "auto":
                res = set_auto_effort(True, config_path=args.config)
                if args.json:
                    print(json.dumps(res, indent=2, ensure_ascii=False))
                else:
                    print(f"auto_effort: true (default_tier={res['default_tier']})")
            elif args.value is not None:
                res = set_tier_effort(args.value, tier=args.tier, disable_auto=True, config_path=args.config)
                if args.json:
                    print(json.dumps(res, indent=2, ensure_ascii=False))
                else:
                    print(f"effort: {res['tier']}={res['reasoning_effort']} (auto_effort={res['auto_effort']})")
            else:
                cfg, cfg_path = load_config(explicit=args.config, require_exists=True)
                tier_name = args.tier or get_default_tier(cfg)
                resolved = resolve_tier(cfg, tier_name)
                auto_flag = bool((cfg.get("routing_policy") or {}).get("auto_effort", False))
                efforts = {t: str((cfg.get("tiers") or {}).get(t, {}).get("reasoning_effort") or "") for t in TIER_ORDER}
                res = {
                    "auto_effort": auto_flag,
                    "default_tier": get_default_tier(cfg),
                    "tier": tier_name,
                    "reasoning_effort": resolved["reasoning_effort"],
                    "efforts": efforts,
                    "config_path": str(cfg_path),
                }
                if args.json:
                    print(json.dumps(res, indent=2, ensure_ascii=False))
                else:
                    mode_lbl = "auto" if auto_flag else resolved["reasoning_effort"]
                    print(f"effort: {mode_lbl} (tier={tier_name}, model={resolved['model']}, auto_effort={auto_flag})")
            return 0

        if args.command == "mcp":
            return serve_stdio()

        if args.command == "install-agy":
            return _cmd_install_agy(args)

        if args.command == "print-mcp":
            return _cmd_print_mcp(args)

        if args.command == "presets":
            return _cmd_presets(args.apply, args.magpie_cli, args.json)

        if args.command == "install":
            if args.mode in {"preview", "apply", "all"}:
                _cmd_presets(args.mode != "preview", args.magpie_cli)
            if args.mode in {"plugin", "all"}:
                return _cmd_install_agy(args)
            if args.mode == "print-mcp":
                args.installed = True
                return _cmd_print_mcp(args)

    except Exception as exc:
        print(f"gempt error: {exc}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
