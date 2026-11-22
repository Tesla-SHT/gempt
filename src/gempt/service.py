"""Shared orchestration layer used by both MCP server and CLI."""

from __future__ import annotations

import copy
import os
import time
from pathlib import Path
from typing import Any

from . import DEFAULT_CONFIG_PATH, EFFORT_RANK, TIER_ORDER, VALID_EFFORTS, VALID_FAILOVER_MODES, VALID_SANDBOXES
from .runs import active_runs_summary, recent_runs, session_roster, verification_result
from .app_server_client import AppServerUnavailableError, TurnInterrupted, run_app_server
from .config import (
    paired_model,
    ConfigError,
    config_exists,
    default_config_template,
    get_default_tier,
    load_config,
    normalize_tier_name,
    redact_config,
    resolve_magpie_api_key,
    resolve_tier,
    require_subscription,
    validate_config,
    save_config,
)
from .discover import discover_environment, find_codex_cli, find_magpie_cli, probe_magpie_gateway
from .magpie_client import MagpieRequestError, consult_with_fallback, sync_magpie_groups
from .protocol import (
    CONSULT_SYSTEM_PROMPT,
    build_consult_prompt,
    build_exec_prompt,
    format_result_summary,
    read_context_files,
)
from .routing import (
    build_escalation_suggestion,
    classify_task_effort,
    effort_timeout_floor,
    is_astra_model,
)
from .sessions import list_sessions, load_session, new_session_id, save_session
from .titles import explicit_title, normalize_title


def _normalize_default_tier(tier: str) -> str:
    canonical = normalize_tier_name(tier)
    if canonical not in TIER_ORDER:
        raise ConfigError(f"Default tier must be one of: {', '.join(TIER_ORDER)}")
    return canonical


def set_default_tier(tier: str, *, config_path: str | Path | None = None) -> dict[str, Any]:
    """Persist routing_policy.default_tier atomically without re-running discovery."""
    canonical = _normalize_default_tier(tier)
    target = config_path or os.environ.get("GEMPT_CONFIG") or DEFAULT_CONFIG_PATH
    cfg, resolved_path = load_config(explicit=target, require_exists=True)
    cfg.setdefault("routing_policy", {})["default_tier"] = canonical
    saved_path = save_config(cfg, path=resolved_path)
    return {
        "saved": True,
        "default_tier": canonical,
        "config_path": str(saved_path),
        "resolved": resolve_tier(cfg, canonical),
    }


def set_default_sandbox(sandbox: str, *, config_path: str | Path | None = None) -> dict[str, Any]:
    """Persist codex.default_sandbox atomically without re-running discovery."""
    cleaned = str(sandbox or "").strip()
    if cleaned not in VALID_SANDBOXES:
        raise ConfigError(f"Default sandbox must be one of: {', '.join(VALID_SANDBOXES)}")
    target = config_path or os.environ.get("GEMPT_CONFIG") or DEFAULT_CONFIG_PATH
    cfg, resolved_path = load_config(explicit=target, require_exists=True)
    cfg.setdefault("codex", {})["default_sandbox"] = cleaned
    saved_path = save_config(cfg, path=resolved_path)
    return {
        "saved": True,
        "default_sandbox": cleaned,
        "config_path": str(saved_path),
    }


def set_auto_effort(enabled: bool, *, config_path: str | Path | None = None) -> dict[str, Any]:
    """Persist routing_policy.auto_effort atomically without re-running discovery."""
    target = config_path or os.environ.get("GEMPT_CONFIG") or DEFAULT_CONFIG_PATH
    cfg, resolved_path = load_config(explicit=target, require_exists=True)
    cfg.setdefault("routing_policy", {})["auto_effort"] = bool(enabled)
    saved_path = save_config(cfg, path=resolved_path)
    tier_name = get_default_tier(cfg)
    return {
        "saved": True,
        "auto_effort": bool(enabled),
        "default_tier": tier_name,
        "config_path": str(saved_path),
        "resolved": resolve_tier(cfg, tier_name),
    }


def set_tier_effort(
    effort: str,
    *,
    tier: str | None = None,
    disable_auto: bool = True,
    config_path: str | Path | None = None,
) -> dict[str, Any]:
    """Persist tiers.<tier>.reasoning_effort (and optionally disable auto_effort) atomically."""
    cleaned = str(effort or "").strip().lower()
    if cleaned not in VALID_EFFORTS:
        raise ConfigError(f"Reasoning effort must be one of: {', '.join(VALID_EFFORTS)}")
    target = config_path or os.environ.get("GEMPT_CONFIG") or DEFAULT_CONFIG_PATH
    cfg, resolved_path = load_config(explicit=target, require_exists=True)
    target_tier = _normalize_default_tier(tier) if (tier is not None and str(tier).strip()) else get_default_tier(cfg)
    tier_cfg = cfg.setdefault("tiers", {}).setdefault(target_tier, {})
    primary_model = str(tier_cfg.get("consult_model") or "")
    exec_model = str(tier_cfg.get("exec_model") or "")
    group_members = [str(m) for m in (tier_cfg.get("magpie_group_members") or []) if m]
    uses_astra = (
        target_tier == "fable"
        or is_astra_model(primary_model)
        or is_astra_model(exec_model)
        or any(is_astra_model(m) for m in group_members)
    )
    if uses_astra and EFFORT_RANK[cleaned] < EFFORT_RANK["medium"]:
        raise ConfigError("Astra models should not be downgraded to low effort; use medium/high Sol or high/xhigh Astra.")
    if cleaned == "ultra":
        raise ConfigError("Default effort must not be set to 'ultra'; pass explicit override on a single run only if strictly needed.")
    tier_cfg["reasoning_effort"] = cleaned
    if disable_auto:
        cfg.setdefault("routing_policy", {})["auto_effort"] = False
    saved_path = save_config(cfg, path=resolved_path)
    return {
        "saved": True,
        "tier": target_tier,
        "reasoning_effort": cleaned,
        "auto_effort": bool(cfg.get("routing_policy", {}).get("auto_effort", False)),
        "config_path": str(saved_path),
        "resolved": resolve_tier(cfg, target_tier),
    }


def configure_gempt(
    *,
    config_path: str | Path | None = None,
    magpie_url: str | None = None,
    magpie_api_key: str | None = None,
    magpie_cli_path: str | None = None,
    codex_cli_path: str | None = None,
    default_sandbox: str | None = None,
    codex_model_provider: str | None = None,
    default_tier: str | None = None,
    failover_mode: str = "subscription_only",
    auto_effort: bool | None = None,
    magpie_group_strategy: str = "pace",
    utility_model: str | None = None,
    use_for_magpie_compact: bool | None = None,
    tiers_override: dict[str, dict[str, Any]] | None = None,
    use_magpie_group_ids: bool = False,
    sync_groups: bool = False,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Build, validate, save gempt configuration and optionally sync Magpie routing groups."""
    # Initialization writes host settings, including secrets. Never pick a checkout implicitly.
    target = config_path or os.environ.get("GEMPT_CONFIG") or DEFAULT_CONFIG_PATH
    existing_cfg, resolved_path = load_config(explicit=target, require_exists=False)
    cfg = copy.deepcopy(existing_cfg)

    if magpie_url is not None and magpie_url.strip():
        if magpie_url.rstrip("/") != cfg["magpie"]["base_url"].rstrip("/"):
            cfg["magpie"]["api_key"] = ""
        cfg["magpie"]["base_url"] = magpie_url.strip()
    if magpie_api_key is not None:
        cfg["magpie"]["api_key"] = magpie_api_key.strip()
    if magpie_cli_path is not None:
        cfg["magpie"]["cli_path"] = magpie_cli_path.strip()
    elif not cfg["magpie"].get("cli_path"):
        found_m = find_magpie_cli()
        if found_m:
            cfg["magpie"]["cli_path"] = found_m

    if codex_cli_path is not None:
        cfg["codex"]["cli_path"] = codex_cli_path.strip()
    elif not cfg["codex"].get("cli_path"):
        codex_info = find_codex_cli()
        if codex_info.get("found"):
            cfg["codex"]["cli_path"] = codex_info["path"]

    if default_sandbox is not None and default_sandbox.strip():
        cfg["codex"]["default_sandbox"] = default_sandbox.strip()
    if codex_model_provider is not None:
        cfg["codex"]["model_provider"] = codex_model_provider.strip()

    cleaned_mode = str(failover_mode or "subscription_only").strip()
    if cleaned_mode not in VALID_FAILOVER_MODES:
        raise ConfigError(f"failover_mode must be one of: {', '.join(VALID_FAILOVER_MODES)}")
    failover_mode = cleaned_mode

    if default_tier is not None and str(default_tier).strip():
        cfg["routing_policy"]["default_tier"] = _normalize_default_tier(default_tier)
    cfg["routing_policy"]["failover_mode"] = failover_mode
    if auto_effort is not None:
        cfg["routing_policy"]["auto_effort"] = bool(auto_effort)
    cfg["routing_policy"]["magpie_group_strategy"] = magpie_group_strategy

    discovery = discover_environment(
        magpie_url=cfg["magpie"]["base_url"],
        config_path=resolved_path,
        include_cli_groups=False,
        effective_config=cfg,
    )
    recs = discovery.get("recommendations") or {}
    presets = recs.get("presets") or {}
    preset_tiers = (presets.get(failover_mode) or {}).get("tiers") or {}

    if failover_mode == "subscription_only" and not preset_tiers:
        raise ConfigError("No Codex subscription models available; subscription_only cannot be initialized.")

    if utility_model is not None:
        cfg["utility"]["model"] = utility_model.strip()
    elif recs.get("utility_model"):
        cfg["utility"]["model"] = recs["utility_model"]
    if use_for_magpie_compact is not None:
        cfg["utility"]["use_for_magpie_compact"] = bool(use_for_magpie_compact)

    defaults_tiers = default_config_template()["tiers"]
    for tier_name in TIER_ORDER:
        base_tier = copy.deepcopy(cfg["tiers"].get(tier_name) or defaults_tiers[tier_name])
        if tier_name in preset_tiers:
            for k, v in preset_tiers[tier_name].items():
                base_tier[k] = copy.deepcopy(v)
        if tiers_override and isinstance(tiers_override.get(tier_name), dict):
            for k, v in tiers_override[tier_name].items():
                if v is not None:
                    base_tier[k] = copy.deepcopy(v)
        if failover_mode == "subscription_only":
            require_subscription([m for m in (base_tier.get("consult_model"), base_tier.get("exec_model"),
                base_tier.get("escalate_model"), *base_tier.get("fallback_models", []),
                *base_tier.get("magpie_group_members", [])) if m])
        if use_magpie_group_ids:
            members = list(base_tier.get("magpie_group_members") or [])
            if not members and base_tier.get("consult_model") and not str(base_tier["consult_model"]).startswith(("group/", "auto/")):
                for m in (base_tier.get("consult_model"), base_tier.get("escalate_model"), *(base_tier.get("fallback_models") or [])):
                    ms = str(m or "").strip()
                    if ms and ms not in members:
                        members.append(ms)
                base_tier["magpie_group_members"] = members
            group_id = f"group/gempt-harness-{tier_name}"
            base_tier["consult_model"] = group_id
            base_tier["exec_model"] = group_id
        cfg["tiers"][tier_name] = base_tier

    validate_config(cfg)
    group_sync_results: list[dict[str, Any]] = []
    if sync_groups:
        cli_path = cfg["magpie"].get("cli_path") or find_magpie_cli() or ""
        group_sync_results = sync_magpie_groups(cfg, cli_path=cli_path, dry_run=dry_run)

    if not dry_run:
        saved_path = save_config(cfg, path=resolved_path)
    else:
        saved_path = resolved_path

    return {
        "saved": not dry_run,
        "config_path": str(saved_path),
        "config": redact_config(cfg),
        "magpie_groups_sync": group_sync_results,
    }


def run_consult(
    *,
    goal: str,
    title: str | None = None,
    host_conversation_id: str | None = None,
    tier: str | None = None,
    context: str = "",
    file_paths: list[str] | None = None,
    constraints: str = "",
    expected_output: str = "",
    session_id: str = "",
    reasoning_effort: str | None = None,
    escalate: bool = False,
    model_override: str | None = None,
    gemini_family: str | None = None,
    max_output_tokens: int | None = None,
    api_mode: str | None = None,
    cwd: str | Path | None = None,
    config_path: str | Path | None = None,
) -> dict[str, Any]:
    """Run a structured reasoning/review/utility consultation via Magpie HTTP API."""
    if not goal or not goal.strip():
        raise ConfigError("`goal` must not be empty.")

    cfg, _ = load_config(explicit=config_path, require_exists=True, cwd=Path(cwd) if cwd else None)
    workspace = str(Path(cwd or ".").resolve())
    history_messages: list[dict[str, str]] = []
    session_record: dict[str, Any] | None = None
    sid = (session_id or "").strip()
    is_resume = bool(sid)
    if sid:
        session_record = load_session(sid)
        if not session_record:
            raise ConfigError(f"Consult session '{sid}' not found.")
        if session_record.get("mode") != "consult":
            raise ConfigError(f"Session '{sid}' is mode='{session_record.get('mode')}', not 'consult'.")
        if session_record.get("cwd") != workspace or session_record.get("gateway") != cfg["magpie"]["base_url"]:
            raise ConfigError("Consult session workspace or gateway differs or was never recorded.")
        for turn in session_record.get("turns") or []:
            role = turn.get("role")
            content = turn.get("content")
            if role in {"user", "assistant"} and isinstance(content, str):
                history_messages.append({"role": role, "content": content})

    effective_tier_arg = tier if (tier is not None and str(tier).strip()) else (session_record.get("tier") if session_record else None)
    explicit_effort = (reasoning_effort or "").strip() or None
    resume_effort = str(session_record.get("reasoning_effort") or "").strip() if (session_record and not explicit_effort) else ""

    paired = None if model_override else paired_model(cfg, gemini_family, tier, session_record if is_resume else None)
    model_override = model_override or paired
    base_resolved = resolve_tier(
        cfg,
        effective_tier_arg,
        model_override=model_override,
        effort_override=explicit_effort or resume_effort or None,
        max_tokens_override=max_output_tokens,
        api_mode_override=api_mode,
        for_exec=False,
        escalate=escalate,
    )

    policy = cfg.get("routing_policy") or {}
    auto_effort_info: dict[str, Any] | None = None
    if bool(policy.get("auto_effort", False)) and not explicit_effort and not is_resume and base_resolved["tier"] != "chore":
        auto_effort_info = classify_task_effort(
            tier=base_resolved["tier"],
            tier_default_effort=base_resolved["reasoning_effort"],
            model_id=base_resolved["model"],
            escalate=escalate,
            goal=goal,
            context=context,
            constraints=constraints,
            file_count=len(file_paths or ()),
            is_resume=False,
        )
        resolved = resolve_tier(
            cfg,
            effective_tier_arg,
            model_override=model_override,
            effort_override=auto_effort_info["effort"],
            max_tokens_override=max_output_tokens,
            api_mode_override=api_mode,
            for_exec=False,
            escalate=escalate,
        )
    else:
        resolved = base_resolved

    limits = cfg.get("limits") or {}
    file_blocks, warnings = read_context_files(
        file_paths,
        cwd=cwd,
        max_file_bytes=int(limits.get("max_context_file_bytes") or 131072),
        max_total_bytes=int(limits.get("max_total_context_bytes") or 393216),
    )

    user_prompt = build_consult_prompt(
        goal=goal,
        context=context,
        file_blocks=file_blocks,
        constraints=constraints,
        expected_output=expected_output,
    )

    if not session_record:
        sid = new_session_id("consult")
        session_record = {
            "session_id": sid,
            "mode": "consult",
            "cwd": workspace,
            "gateway": cfg["magpie"]["base_url"],
            "tier": resolved["tier"],
            "model": resolved["model"],
            "reasoning_effort": resolved["reasoning_effort"],
            "turns": [],
        }

    messages = [*history_messages, {"role": "user", "content": user_prompt}]
    api_key, _ = resolve_magpie_api_key(cfg)
    base_url = str(cfg["magpie"]["base_url"])
    timeout_sec = max(
        int(limits.get("consult_timeout_sec") or 180),
        effort_timeout_floor(resolved["reasoning_effort"], mode="consult"),
    )

    try:
        res = consult_with_fallback(
            base_url=base_url,
            api_key=api_key,
            primary_model=resolved["model"],
            fallback_models=resolved["fallback_models"],
            api_mode=resolved["api_mode"],
            messages=messages,
            reasoning_effort=resolved["reasoning_effort"],
            instructions=CONSULT_SYSTEM_PROMPT,
            max_output_tokens=resolved["max_output_tokens"],
            timeout_sec=timeout_sec,
        )
    except MagpieRequestError as exc:
        hint = build_escalation_suggestion(
            mode="consult",
            tier=resolved["tier"],
            effort=resolved["reasoning_effort"],
            error_message=str(exc),
        )
        raise MagpieRequestError(f"{exc} | {hint}" if hint else str(exc)) from exc

    task_title = normalize_title(title, goal, workspace)
    session_record["title"] = explicit_title(title) or session_record.get("title") or task_title
    host_conversation_id = host_conversation_id or session_record.get("host_conversation_id")
    session_record["host_conversation_id"] = host_conversation_id
    session_record["paired_model"] = paired
    session_record["tier"] = resolved["tier"]
    session_record["model"] = res["served_model"]
    session_record["reasoning_effort"] = resolved["reasoning_effort"]
    session_record.setdefault("turns", []).extend(
        [
            {"role": "user", "content": user_prompt},
            {"role": "assistant", "content": res["text"]},
        ]
    )
    turn_count = len(session_record["turns"]) // 2
    session_record.setdefault("turn_details", {})[str(turn_count)] = {
        "goal": goal.strip(),
        "title": task_title,
        "host_conversation_id": host_conversation_id,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime()),
        "cwd": workspace,
        "tier": resolved["tier"],
        "served_model": res["served_model"],
        "requested_model": resolved["model"],
        "response_id": res.get("response_id"),
        "attempted_models": [attempt["model"] for attempt in res.get("attempts", []) if "model" in attempt],
        "reasoning_effort": resolved["reasoning_effort"],
        "elapsed_sec": float(res["elapsed_sec"]),
        "usage": res.get("usage") or {},
        "retried": bool(res.get("used_fallback")),
    }
    save_session(session_record)
    formatted = format_result_summary(
        mode="consult",
        session_id=sid,
        tier=resolved["tier"],
        model=res["served_model"],
        effort=resolved["reasoning_effort"],
        elapsed_sec=float(res["elapsed_sec"]),
        reply_text=res["text"],
        usage=res.get("usage"),
        extra={
            "turn": turn_count,
            "escalated": "yes" if resolved.get("escalated") else "",
            "auto_effort": f"{auto_effort_info['effort']}(score={auto_effort_info['score']})" if auto_effort_info else "",
            "fallback_used": "yes" if res.get("used_fallback") else "",
            "warnings": "; ".join(warnings) if warnings else "",
        },
    )
    return {
        "session_id": sid,
        "tier": resolved["tier"],
        "requested_model": resolved["model"],
        "served_model": res["served_model"],
        "reasoning_effort": resolved["reasoning_effort"],
        "escalated": bool(resolved.get("escalated")),
        "auto_effort": auto_effort_info,
        "elapsed_sec": round(float(res["elapsed_sec"]), 3),
        "usage": res.get("usage") or {},
        "turns": turn_count,
        "warnings": warnings,
        "text": res["text"],
        "formatted": formatted,
    }


def run_exec(
    *,
    goal: str,
    cwd: str | Path,
    title: str | None = None,
    host_conversation_id: str | None = None,
    tier: str | None = None,
    context: str = "",
    file_paths: list[str] | None = None,
    constraints: str = "",
    verification: str = "",
    expected_report: str = "",
    session_id: str = "",
    sandbox: str | None = None,
    reasoning_effort: str | None = None,
    escalate: bool = False,
    model_override: str | None = None,
    gemini_family: str | None = None,
    timeout_sec: int | None = None,
    config_path: str | Path | None = None,
    _run_id: str = "",
    _new_session_id: str = "",
    _worktree_path: str = "",
    _source_cwd: str = "",
) -> dict[str, Any]:
    """Delegate a coding/verification task to the Magpie-managed Codex app-server."""
    if not goal or not goal.strip():
        raise ConfigError("`goal` must not be empty.")
    workdir = Path(cwd).expanduser().resolve()
    if not workdir.is_dir():
        raise ConfigError(f"`cwd` does not exist or is not a directory: {workdir}")

    cfg, resolved_config = load_config(explicit=config_path, require_exists=True, cwd=workdir)
    codex_cfg = cfg.get("codex") or {}
    # Auto-discovered workspace configuration is not a trusted connection manifest.
    app_config = resolved_config if config_path or os.environ.get("GEMPT_CONFIG") else DEFAULT_CONFIG_PATH

    limits = cfg.get("limits") or {}
    file_blocks, warnings = read_context_files(
        file_paths,
        cwd=workdir,
        max_file_bytes=int(limits.get("max_context_file_bytes") or 131072),
        max_total_bytes=int(limits.get("max_total_context_bytes") or 393216),
    )

    sid = (session_id or "").strip()
    codex_thread_id = ""
    session_record: dict[str, Any] | None = None
    if sid:
        session_record = load_session(sid)
        if session_record:
            if session_record.get("mode") != "exec":
                raise ConfigError(f"Session '{sid}' is mode='{session_record.get('mode')}', not 'exec'.")
            codex_thread_id = str(session_record.get("codex_thread_id") or "").strip()
            if not codex_thread_id:
                raise ConfigError(f"Session '{sid}' has no stored Codex thread_id to resume.")
        else:
            raise ConfigError("Unknown exec session; raw Codex thread IDs cannot establish permissions.")
    else:
        sid = _new_session_id or new_session_id("exec")
        session_record = {
            "session_id": sid,
            "mode": "exec",
            "cwd": str(workdir),
            "codex_thread_id": "",
            "turns": [],
        }

    is_resume = bool(codex_thread_id)
    effective_tier_arg = tier if (tier is not None and str(tier).strip()) else (session_record.get("tier") if is_resume else None)
    explicit_effort = (reasoning_effort or "").strip() or None
    resume_effort = str(session_record.get("reasoning_effort") or "").strip() if (is_resume and not explicit_effort) else ""

    paired = None if model_override else paired_model(cfg, gemini_family, tier, session_record if is_resume else None)
    model_override = model_override or paired
    base_resolved = resolve_tier(
        cfg,
        effective_tier_arg,
        model_override=model_override,
        effort_override=explicit_effort or resume_effort or None,
        for_exec=True,
        escalate=escalate,
    )

    policy = cfg.get("routing_policy") or {}
    auto_effort_info: dict[str, Any] | None = None
    if bool(policy.get("auto_effort", False)) and not explicit_effort and not is_resume:
        auto_effort_info = classify_task_effort(
            tier=base_resolved["tier"],
            tier_default_effort=base_resolved["reasoning_effort"],
            model_id=base_resolved["model"],
            escalate=escalate,
            goal=goal,
            context=context,
            constraints=constraints,
            file_count=len(file_paths or ()),
            is_resume=False,
        )
        resolved = resolve_tier(
            cfg,
            effective_tier_arg,
            model_override=model_override,
            effort_override=auto_effort_info["effort"],
            for_exec=True,
            escalate=escalate,
        )
    else:
        resolved = base_resolved

    prompt = build_exec_prompt(
        goal=goal,
        context=context,
        file_blocks=file_blocks,
        constraints=constraints,
        verification=verification,
        expected_report=expected_report,
        is_resume=is_resume,
    )

    effective_sandbox = (sandbox or "").strip() or str(codex_cfg.get("default_sandbox") or "workspace-write")
    ceiling = codex_cfg["default_sandbox"]
    if effective_sandbox not in VALID_SANDBOXES or VALID_SANDBOXES.index(effective_sandbox) > VALID_SANDBOXES.index(ceiling):
        raise ConfigError("Requested sandbox exceeds configured permissions.")
    if codex_thread_id:
        if session_record.get("gateway") != cfg["magpie"]["base_url"]:
            raise ConfigError("Resume requires the previously bound gateway.")
        previous = session_record.get("sandbox")
        if Path(session_record["cwd"]).resolve() != workdir or previous not in VALID_SANDBOXES:
            raise ConfigError("Resume requires the original workspace and a recorded sandbox.")
        if not sandbox:
            effective_sandbox = min((previous, ceiling), key=VALID_SANDBOXES.index)
        if VALID_SANDBOXES.index(effective_sandbox) > VALID_SANDBOXES.index(previous):
            raise ConfigError("Resume cannot increase sandbox permissions.")
    session_record["sandbox"] = effective_sandbox
    session_record["gateway"] = cfg["magpie"]["base_url"]
    if timeout_sec is not None:
        effective_timeout = int(timeout_sec)
    else:
        effective_timeout = max(
            int(codex_cfg.get("timeout_sec") or 600),
            effort_timeout_floor(resolved["reasoning_effort"], mode="exec"),
        )
    if codex_cfg.get("extra_args"):
        raise ConfigError("Unrestricted Codex extra_args conflict with gateway and sandbox enforcement.")
    task_title = normalize_title(title, goal, str(workdir))
    host_conversation_id = host_conversation_id or session_record.get("host_conversation_id")
    session_record.update(paired_model=paired, tier=resolved["tier"], model=resolved["model"],
                          reasoning_effort=resolved["reasoning_effort"], host_conversation_id=host_conversation_id,
                          title=explicit_title(title) or session_record.get("title") or task_title)
    if _worktree_path:
        session_record["worktree_path"] = _worktree_path
    if _source_cwd:
        session_record["source_cwd"] = _source_cwd
    if _run_id:
        save_session(session_record)

    def persist_identity(thread_id, turn_id):
        session_record.update(codex_thread_id=thread_id, turn_id=turn_id)
        save_session(session_record)

    approval = codex_cfg.get("approval_policy") or "never"
    if effective_sandbox != "danger-full-access":
        approval = "never"
    idle_timeout = int(codex_cfg.get("idle_timeout_sec") if codex_cfg.get("idle_timeout_sec") is not None else 300)
    try:
        res = run_app_server(
            prompt=prompt, cwd=workdir, model=resolved["model"], reasoning_effort=resolved["reasoning_effort"],
            sandbox=effective_sandbox, approval_policy=approval, codex_thread_id=codex_thread_id,
            gateway_url=cfg["magpie"]["base_url"], config_path=app_config, timeout_sec=effective_timeout,
            idle_timeout_sec=idle_timeout, run_id=_run_id, session_id=sid, on_identity=persist_identity,
        )
    except (AppServerUnavailableError, TurnInterrupted):
        raise
    except Exception as exc:
        msg = str(exc)
        hint = build_escalation_suggestion(
            mode="exec",
            tier=resolved["tier"],
            effort=resolved["reasoning_effort"],
            model=resolved["model"],
            timed_out="timed out" in msg.lower() or "stalled" in msg.lower(),
            error_message=msg,
        )
        if hint and hint not in msg:
            try:
                new_exc = type(exc)(f"{msg} | {hint}")
            except TypeError:
                raise
            raise new_exc from exc
        raise

    observed = res.get("observed_context") or {}
    actual = observed.get("sandbox")
    if not observed.get("cwd") or Path(observed["cwd"]).resolve() != workdir or actual not in VALID_SANDBOXES:
        actual = None
        warnings.append("Codex execution context unconfirmed; resume is disabled.")
    elif VALID_SANDBOXES.index(actual) > VALID_SANDBOXES.index(effective_sandbox):
        raise ConfigError("Observed Codex permissions exceeded the requested sandbox; inspect the run.")
    session_record["sandbox"] = actual
    acceptance = verification_result(verification, res["commands"])
    escalation_hint = build_escalation_suggestion(
        mode="exec",
        tier=resolved["tier"],
        effort=resolved["reasoning_effort"],
        model=resolved["model"],
        verification_status=str(acceptance.get("status") or ""),
    )
    session_record["codex_thread_id"] = res["codex_thread_id"]
    session_record.setdefault("turns", []).append(
        {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime()),
            "goal": goal.strip(),
            "title": task_title,
            "host_conversation_id": host_conversation_id,
            "prompt": prompt,
            "reply": res["text"],
            "run_id": _run_id,
            "tier": resolved["tier"],
            "model": resolved["model"],
            "reasoning_effort": resolved["reasoning_effort"],
            "verification": acceptance,
            "elapsed_sec": round(float(res["elapsed_sec"]), 3),
            "usage": res.get("usage") or {},
            "reply_preview": res["text"][:600],
        }
    )
    save_session(session_record)

    turn_count = sum(1 for turn in session_record["turns"] if turn.get("role") in (None, "user"))
    formatted = format_result_summary(
        mode="exec",
        session_id=sid,
        tier=resolved["tier"],
        model=resolved["model"],
        effort=resolved["reasoning_effort"],
        elapsed_sec=float(res["elapsed_sec"]),
        reply_text=res["text"],
        usage=res.get("usage"),
        extra={
            "codex_thread_id": res["codex_thread_id"],
            "sandbox": actual or "unconfirmed",
            "verification": acceptance["status"],
            "turn": turn_count,
            "escalated": "yes" if resolved.get("escalated") else "",
            "auto_effort": f"{auto_effort_info['effort']}(score={auto_effort_info['score']})" if auto_effort_info else "",
            "warnings": "; ".join(warnings) if warnings else "",
        },
    )
    return {
        "session_id": sid,
        "title": task_title,
        "host_conversation_id": host_conversation_id,
        "worktree_path": session_record.get("worktree_path"),
        "source_cwd": session_record.get("source_cwd"),
        "codex_thread_id": res["codex_thread_id"],
        "turn_id": res.get("turn_id"),
        "verification": acceptance,
        "tier": resolved["tier"],
        "model": resolved["model"],
        "reasoning_effort": resolved["reasoning_effort"],
        "escalated": bool(resolved.get("escalated")),
        "auto_effort": auto_effort_info,
        "escalation_suggestion": escalation_hint,
        "sandbox": actual,
        "requested_sandbox": effective_sandbox,
        "elapsed_sec": round(float(res["elapsed_sec"]), 3),
        "usage": res.get("usage") or {},
        "turns": turn_count,
        "warnings": warnings,
        "text": res["text"],
        "formatted": formatted,
    }


def get_status(
    *,
    workspace_root: Path | None = None,
    config_path: str | Path | None = None,
    session_limit: int = 10,
    host_conversation_id: str | None = None,
) -> dict[str, Any]:
    """Return active configuration (redacted), Magpie & Codex health, active runs, and GPT roster."""
    resolved_path, exists = config_exists(explicit=config_path)
    if exists:
        cfg, resolved_path = load_config(explicit=config_path, require_exists=True)
        api_key, key_source = resolve_magpie_api_key(cfg)
        base_url = str(cfg["magpie"]["base_url"])
        excluded_models = (cfg.get("routing_policy") or {}).get("excluded_models")
        gateway = probe_magpie_gateway(base_url, api_key=api_key, excluded_models=excluded_models)
        codex_info = find_codex_cli(str(cfg["codex"].get("cli_path") or ""))
        magpie_cli = find_magpie_cli(str(cfg["magpie"].get("cli_path") or ""))
        redacted = redact_config(cfg)
    else:
        gateway = probe_magpie_gateway("http://127.0.0.1:3425")
        codex_info = find_codex_cli()
        magpie_cli = find_magpie_cli()
        key_source = "unconfigured"
        redacted = None

    from .token_ratio import resolve_budget

    policy = (cfg.get("routing_policy") or {}) if exists else {}
    profile = str(policy.get("work_split") or "balanced")
    budget = resolve_budget(profile, policy=policy, config_path=resolved_path)

    return {
        "active_runs": active_runs_summary(limit=max(session_limit, 20), root=workspace_root, host_conversation_id=host_conversation_id),
        "roster": session_roster(limit=session_limit, root=workspace_root, host_conversation_id=host_conversation_id),
        "recent_runs": recent_runs(session_limit, workspace_root, host_conversation_id=host_conversation_id),
        "token_ratio": budget,
        "configured": exists,
        "default_tier": get_default_tier(cfg) if exists else "sonnet",
        "auto_effort": bool((cfg.get("routing_policy") or {}).get("auto_effort", False)) if exists else False,
        "config_path": str(resolved_path),
        "api_key_source": key_source,
        "config": redacted,
        "health": {
            "magpie_gateway_reachable": bool(gateway.get("reachable")),
            "magpie_total_models": gateway.get("total_models", 0),
            "magpie_error": gateway.get("error", ""),
            "magpie_cli": magpie_cli or "",
            "native_gempt_groups": [g["id"] for g in (gateway.get("native_gempt_groups") or [])],
            "harness_gempt_groups": [g["id"] for g in (gateway.get("gempt_groups") or [])],
            "codex_cli_found": bool(codex_info.get("found")),
            "codex_cli_path": codex_info.get("path", ""),
            "codex_version": codex_info.get("version", ""),
        },
        "recent_sessions": [s for s in list_sessions(limit=session_limit) if workspace_root is None or (s.get("cwd") and Path(s["cwd"]).is_relative_to(workspace_root))],
    }
