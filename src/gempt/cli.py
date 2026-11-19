"""Command-line interface for gempt discovery, setup, consult, exec, and plugin install."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import Any

from . import (
    CONSULT_TIERS,
    TIER_ALIASES,
    TIER_ORDER,
    VALID_EFFORTS,
    VALID_FAILOVER_MODES,
    VALID_GROUP_STRATEGIES,
    VALID_SANDBOXES,
    __version__,
)
from .discover import discover_environment
from .presets import apply_native_presets
from .runs import dispatch_exec, read_run
from .mcp_server import serve_stdio
from .service import configure_gempt, get_status, run_consult

_TIER_CHOICES = (*CONSULT_TIERS, *TIER_ALIASES.keys())


def _configure_stdio_utf8() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass


def _find_repo_plugin_dir() -> Path:
    pkg_dir = Path(__file__).resolve().parent
    candidates = [
        pkg_dir.parent.parent,
        pkg_dir.parent.parent / "plugin",
        Path.cwd(),
        Path.cwd() / "plugin",
    ]
    for cand in candidates:
        if (cand / "plugin.json").is_file():
            return cand
    raise FileNotFoundError("Could not locate source `plugin/` directory next to gempt package.")


def _build_mcp_config(src_root: Path) -> dict[str, Any]:
    resolved_root = str(src_root.expanduser().resolve())
    return {
        "mcpServers": {
            "gempt": {
                "command": sys.executable,
                "args": [
                    "-I",
                    "-c",
                    "import runpy,sys;sys.path.insert(0,sys.argv.pop(1));"
                    "runpy.run_module('gempt.mcp_server',run_name='__main__')",
                    resolved_root,
                ],
                "env": {
                    "PYTHONPATH": resolved_root,
                    "PYTHONUTF8": "1",
                },
            }
        }
    }


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
    if not presets:
        print("Error: No GPT/Codex models found in Magpie /v1/models. Add/expose GPT models in Magpie first.", file=sys.stderr)
        return 1

    print("\nFailover presets:")
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
    source_plugin = Path(args.source).expanduser().resolve() if args.source else _find_repo_plugin_dir()
    target = Path(args.target).expanduser().resolve()
    src_root = target / "runtime"

    if target.exists():
        if not args.force:
            existing_json = target / "plugin.json"
            if existing_json.is_file():
                try:
                    data = json.loads(existing_json.read_text(encoding="utf-8"))
                    if data.get("name") != "gempt":
                        print(
                            f"Refusing to overwrite unrelated plugin at {target} (name={data.get('name')!r}). Use --force or another --target.",
                            file=sys.stderr,
                        )
                        return 1
                except json.JSONDecodeError:
                    print(f"Target {target} exists; pass --force to overwrite.", file=sys.stderr)
                    return 1
            else:
                print(f"Target {target} exists; pass --force to overwrite.", file=sys.stderr)
                return 1

    target.mkdir(parents=True, exist_ok=True)
    for rel in ("plugin.json", "README.md"):
        src_file = source_plugin / rel
        if not src_file.is_file() and rel == "README.md":
            parent_readme = source_plugin.parent / "README.md"
            if parent_readme.is_file():
                src_file = parent_readme
        if src_file.is_file() and source_plugin != target:
            shutil.copy2(src_file, target / rel)

    for folder in ("rules", "skills", "assets"):
        src_sub = source_plugin / folder
        if src_sub.is_dir() and source_plugin != target:
            dst_sub = target / folder
            shutil.copytree(src_sub, dst_sub, dirs_exist_ok=True)

    package = Path(__file__).resolve().parent
    if package != src_root / "gempt":
        shutil.copytree(package, src_root / "gempt", dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    mcp_config = _build_mcp_config(src_root)
    (target / "mcp_config.json").write_text(json.dumps(mcp_config, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(
        json.dumps(
            {
                "installed": True,
                "plugin_dir": str(target),
                "mcp_config": mcp_config,
                "next_steps": [
                    "Antigravity loads plugins automatically on the next turn (or toggle in Customizations).",
                    "Tell Gemini: '初始化 gempt' to run gempt_discover + interactive 3-tier setup.",
                    "For other clients (Claude Code / ZCode / Codex) using Magpie Gemini, run `gempt print-mcp --installed` and paste into Magpie Library -> MCP or your client config.",
                ],
            },
            indent=2,
            ensure_ascii=False,
        )
    )
    return 0


def _cmd_print_mcp(args: argparse.Namespace) -> int:
    if args.installed:
        src_root = Path(args.target).expanduser().resolve() / "runtime"
    else:
        src_root = Path(__file__).resolve().parent.parent
    print(json.dumps(_build_mcp_config(src_root), indent=2, ensure_ascii=False))
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

    p_cons = sub.add_parser("consult", help="Consult GPT/utility via Magpie HTTP API (no Codex tool overhead)")
    p_cons.add_argument("--tier", choices=_TIER_CHOICES, default="sonnet")
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
    p_exec.add_argument("--tier", choices=(*TIER_ORDER, "lite", "mid", "max"), default="sonnet")
    p_exec.add_argument("--escalate", action="store_true", help="For opus tier: escalate to escalate_model (e.g. Astra)")
    p_exec.add_argument("--cwd", default=".")
    p_exec.add_argument("--goal", required=True)
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
    p_stat.add_argument("--config", default=None)
    p_stat.add_argument("--sessions", type=int, default=10)

    sub.add_parser("mcp", help="Run gempt stdio MCP server")

    p_inst = sub.add_parser("install-agy", help="Install gempt plugin into Antigravity config directory")
    p_inst.add_argument("--target", default=str(Path.home() / ".gemini" / "config" / "plugins" / "gempt"))
    p_inst.add_argument("--source", default=None, help="Path to source plugin/ folder")
    p_inst.add_argument("--force", action="store_true")

    p_pmcp = sub.add_parser("print-mcp", help="Print standard MCP JSON config for Magpie/Claude/ZCode/etc.")
    p_pmcp.add_argument("--installed", action="store_true", help="Point to installed Antigravity plugin runtime/ instead of current src/")
    p_pmcp.add_argument("--target", default=str(Path.home() / ".gemini" / "config" / "plugins" / "gempt"))

    p_pres = sub.add_parser("presets", help="Preview or apply native Magpie groups group/gempt-{sonnet,opus,fable}")
    p_pres.add_argument("--apply", action="store_true", help="Create the native Magpie routing groups")
    p_pres.add_argument("--magpie-cli", default="", help="Optional path to magpie / magpie.com executable")
    p_pres.add_argument("--json", action="store_true", help="Print structured JSON output")

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
            res = dispatch_exec(background=args.background, run_id=args.run_id,
                goal=args.goal,
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
            if args.json or args.background:
                print(json.dumps(res, indent=2, ensure_ascii=False))
            else:
                print(res["formatted"])
                if res.get("run_id"):
                    print(f"\n[run_id={res['run_id']}]")
            return 1 if res.get("verification", {}).get("status") in {"failed", "unverified"} else 0

        if args.command == "status" and args.run_id:
            print(json.dumps(read_run(args.run_id), ensure_ascii=False, indent=2))
            return 0

        if args.command == "status":
            data = get_status(config_path=args.config, session_limit=args.sessions)
            print(json.dumps(data, indent=2, ensure_ascii=False))
            return 0

        if args.command == "mcp":
            return serve_stdio()

        if args.command == "install-agy":
            return _cmd_install_agy(args)

        if args.command == "print-mcp":
            return _cmd_print_mcp(args)

        if args.command == "presets":
            res = apply_native_presets(cli_path=args.magpie_cli, apply=args.apply)
            if args.json:
                print(json.dumps(res, indent=2, ensure_ascii=False))
            else:
                import shlex
                for cmd in res["commands"]:
                    print(" ".join(shlex.quote(part) for part in cmd))
                if res.get("applied"):
                    print(f"Applied native Magpie groups: {', '.join(res['groups'])}")
            return 0

    except Exception as exc:
        print(f"gempt error: {exc}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
