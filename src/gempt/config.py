"""Configuration loading, validation, redaction, tier resolution, and API key resolution."""

from __future__ import annotations

import copy
import json
import os
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from . import (
    CONSULT_TIERS,
    DEFAULT_CONFIG_PATH,
    DEFAULT_MAGPIE_URL,
    EFFORT_RANK,
    TIER_ALIASES,
    TIER_ORDER,
    VALID_EFFORTS,
    VALID_FAILOVER_MODES,
    VALID_GROUP_STRATEGIES,
    VALID_SANDBOXES,
)


class ConfigError(RuntimeError):
    """Raised when gempt configuration is missing or invalid."""


class ConfigNotFoundError(ConfigError):
    """Raised when no gempt config file is found and setup is required."""


def is_loopback_url(url: str) -> bool:
    """Return True when URL targets localhost or a loopback IP address."""
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    return host in {"127.0.0.1", "localhost", "::1"}


def normalize_tier_name(tier_name: str) -> str:
    """Normalize canonical tier names and legacy/friendly aliases."""
    raw = (tier_name or "sonnet").strip().lower()
    mapped = TIER_ALIASES.get(raw, raw)
    if mapped not in CONSULT_TIERS:
        raise ConfigError(f"Unknown tier '{tier_name}'. Expected one of: {', '.join(CONSULT_TIERS)}")
    return mapped


def default_config_template() -> dict[str, Any]:
    """Return a clean, machine-agnostic default configuration structure."""
    return {
        "version": 1,
        "magpie": {
            "base_url": DEFAULT_MAGPIE_URL,
            "api_key": "",
            "api_key_env": "GEMPT_MAGPIE_API_KEY",
            "cli_path": "",
        },
        "codex": {
            "cli_path": "",
            "default_sandbox": "workspace-write",
            "approval_policy": "never",
            "model_provider": "",
            "extra_args": [],
            "timeout_sec": 600,
        },
        "routing_policy": {
            "failover_mode": "subscription_only",
            "magpie_group_strategy": "order",
            "excluded_models": [],
        },
        "tiers": {
            "sonnet": {
                "label": "Sonnet · 日常高频",
                "when_to_use": "80% 日常写代码、加小功能、改 UI、写脚本",
                "consult_model": "codex/gpt-6.2-sol",
                "exec_model": "",
                "reasoning_effort": "medium",
                "api_mode": "responses",
                "max_output_tokens": 16384,
                "fallback_models": [],
                "magpie_group_members": [],
            },
            "opus": {
                "label": "Opus · 复杂工程",
                "when_to_use": "跨文件重构、读大仓库、复杂逻辑设计与排查（常规 Sol + 疑难 Astra）",
                "consult_model": "codex/gpt-6.2-sol",
                "exec_model": "",
                "escalate_model": "codex/gpt-6.2-astra",
                "escalate_effort_threshold": "high",
                "reasoning_effort": "medium",
                "api_mode": "responses",
                "max_output_tokens": 24576,
                "fallback_models": [],
                "magpie_group_members": [],
            },
            "fable": {
                "label": "Fable · 顶配攻坚",
                "when_to_use": "极难 Bug、核心算法/数学推导、长程架构设计",
                "consult_model": "codex/gpt-6.2-astra",
                "exec_model": "",
                "reasoning_effort": "high",
                "api_mode": "responses",
                "max_output_tokens": 32768,
                "fallback_models": [],
                "magpie_group_members": [],
            },
        },
        "utility": {
            "label": "Chore · 免费打杂/压缩/分类",
            "model": "auto/deepseek-v4.1-flash",
            "reasoning_effort": "low",
            "api_mode": "chat",
            "max_output_tokens": 4096,
            "fallback_models": [],
            "use_for_magpie_compact": True,
            "use_as_classifier": False,
        },
        "limits": {
            "max_internal_rounds": 3,
            "max_context_file_bytes": 131072,
            "max_total_context_bytes": 393216,
            "consult_timeout_sec": 180,
        },
    }


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    merged = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = copy.deepcopy(value)
    return merged


def find_config_path(explicit: str | Path | None = None, cwd: Path | None = None) -> Path:
    """Resolve configuration file path by explicit arg, env, local .gempt.json, or home default."""
    if explicit:
        return Path(explicit).expanduser().resolve()
    env_path = os.environ.get("GEMPT_CONFIG", "").strip()
    if env_path:
        return Path(env_path).expanduser().resolve()
    start = (cwd or Path.cwd()).resolve()
    for directory in (start, *start.parents):
        candidate = directory / ".gempt.json"
        if candidate.is_file():
            return candidate
    return DEFAULT_CONFIG_PATH


def config_exists(explicit: str | Path | None = None, cwd: Path | None = None) -> tuple[Path, bool]:
    """Return (resolved_path, exists_flag)."""
    path = find_config_path(explicit=explicit, cwd=cwd)
    return path, path.is_file()


def load_config(
    explicit: str | Path | None = None,
    *,
    require_exists: bool = True,
    cwd: Path | None = None,
) -> tuple[dict[str, Any], Path]:
    """Load config merged with defaults, raising ConfigNotFoundError if absent and required."""
    path = find_config_path(explicit=explicit, cwd=cwd)
    defaults = default_config_template()
    if not path.is_file():
        if require_exists:
            raise ConfigNotFoundError(
                f"gempt config not found at {path}. Run `gempt_discover` (or `gempt init`) to configure your 3-tier GPT routing first."
            )
        return defaults, path
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ConfigError(f"Failed to read gempt config at {path}: {exc}") from exc
    if not isinstance(raw, dict):
        raise ConfigError(f"Invalid gempt config at {path}: root must be a JSON object")
    merged = _deep_merge(defaults, raw)
    if not explicit and not os.environ.get("GEMPT_CONFIG") and path != DEFAULT_CONFIG_PATH:
        # Project files may be supplied by an untrusted checkout. Operator policy belongs to the host.
        host, _ = load_config(explicit=DEFAULT_CONFIG_PATH, require_exists=False)
        for section in ("magpie", "codex", "routing_policy"):
            for field, value in raw.get(section, {}).items():
                if value != host[section].get(field):
                    raise ConfigError(f"Project cannot override host setting {section}.{field}; select a trusted config explicitly.")
            merged[section] = host[section]
    validate_config(merged)
    return merged, path


def validate_config(cfg: dict[str, Any]) -> None:
    """Validate critical config sections and tier definitions."""
    tiers = cfg.get("tiers")
    if not isinstance(tiers, dict):
        raise ConfigError("Config error: 'tiers' must be an object")
    for tier_name in TIER_ORDER:
        tier = tiers.get(tier_name)
        if not isinstance(tier, dict):
            raise ConfigError(f"Config error: missing tier '{tier_name}'")
        model = str(tier.get("consult_model") or "").strip()
        if not model:
            raise ConfigError(f"Config error: tiers.{tier_name}.consult_model cannot be empty")
        effort = str(tier.get("reasoning_effort") or "medium").strip()
        if effort and effort not in VALID_EFFORTS:
            raise ConfigError(f"Config error: tiers.{tier_name}.reasoning_effort '{effort}' not in {VALID_EFFORTS}")
        api_mode = str(tier.get("api_mode") or "responses").strip()
        if api_mode not in {"responses", "chat"}:
            raise ConfigError(f"Config error: tiers.{tier_name}.api_mode must be 'responses' or 'chat'")

    utility = cfg.get("utility") or {}
    if utility:
        u_effort = str(utility.get("reasoning_effort") or "low").strip()
        if u_effort and u_effort not in VALID_EFFORTS:
            raise ConfigError(f"Config error: utility.reasoning_effort '{u_effort}' not in {VALID_EFFORTS}")
        u_mode = str(utility.get("api_mode") or "chat").strip()
        if u_mode not in {"responses", "chat"}:
            raise ConfigError("Config error: utility.api_mode must be 'responses' or 'chat'")

    policy = cfg.get("routing_policy") or {}
    failover = str(policy.get("failover_mode") or "subscription_only")
    if failover not in VALID_FAILOVER_MODES:
        raise ConfigError(f"Config error: routing_policy.failover_mode '{failover}' not in {VALID_FAILOVER_MODES}")
    strategy = str(policy.get("magpie_group_strategy") or "order")
    if strategy not in VALID_GROUP_STRATEGIES:
        raise ConfigError(f"Config error: routing_policy.magpie_group_strategy '{strategy}' not in {VALID_GROUP_STRATEGIES}")
    excluded = policy.get("excluded_models")
    if excluded is not None:
        if not isinstance(excluded, list) or not all(isinstance(item, str) for item in excluded):
            raise ConfigError("Config error: routing_policy.excluded_models must be a list of strings")

    codex_cfg = cfg.get("codex") or {}
    sandbox = str(codex_cfg.get("default_sandbox") or "workspace-write")
    if sandbox not in VALID_SANDBOXES:
        raise ConfigError(f"Config error: codex.default_sandbox '{sandbox}' not in {VALID_SANDBOXES}")


def save_config(cfg: dict[str, Any], path: str | Path | None = None) -> Path:
    """Validate and save gempt config JSON."""
    merged = _deep_merge(default_config_template(), cfg)
    validate_config(merged)
    target = find_config_path(explicit=path)
    target.parent.mkdir(parents=True, exist_ok=True)
    from .sessions import atomic_json
    atomic_json(target, merged)
    return target


def _discover_local_magpie_client_key() -> str:
    """Best-effort in-memory lookup of a local Magpie caller key (never written or printed)."""
    candidates = [
        Path.home() / ".zcode" / "v2" / "config.json",
        Path.home() / ".zcode" / "cli" / "config.json",
    ]
    for candidate in candidates:
        if not candidate.is_file():
            continue
        try:
            data = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        key = (
            data.get("provider", {})
            .get("magpie", {})
            .get("options", {})
            .get("apiKey", "")
        )
        if isinstance(key, str) and key.strip():
            return key.strip()
    return ""


def resolve_magpie_api_key(cfg: dict[str, Any], target: str | None = None) -> tuple[str, str]:
    """Resolve Magpie bearer token in memory; returns (key, source_label)."""
    magpie_cfg = cfg.get("magpie") or {}
    endpoint = str(magpie_cfg.get("base_url") or DEFAULT_MAGPIE_URL).rstrip("/")
    if target and target.rstrip("/") != endpoint:
        return "", "unbound_endpoint"
    trusted = os.environ.get("GEMPT_TRUSTED_GATEWAY", DEFAULT_MAGPIE_URL).rstrip("/")
    if endpoint != trusted:
        return str(magpie_cfg.get("api_key") or ""), "endpoint_config"
    env_name = str(magpie_cfg.get("api_key_env") or "GEMPT_MAGPIE_API_KEY").strip()
    if env_name:
        env_val = os.environ.get(env_name, "").strip()
        if env_val:
            return env_val, f"env:{env_name}"
    cfg_val = str(magpie_cfg.get("api_key") or "").strip()
    if cfg_val:
        return cfg_val, "config"
    if endpoint != DEFAULT_MAGPIE_URL:
        return "", "no_bound_key"
    local_key = _discover_local_magpie_client_key()
    if local_key:
        return local_key, "local_client_auto"
    return "magpie", "default_local"


def redact_config(cfg: dict[str, Any]) -> dict[str, Any]:
    """Return a copy of config with secret fields redacted."""
    clean = copy.deepcopy(cfg)
    magpie_cfg = clean.get("magpie")
    if isinstance(magpie_cfg, dict) and magpie_cfg.get("api_key"):
        magpie_cfg["api_key"] = "***redacted***"
    return clean


def require_subscription(models: list[str]) -> None:
    for model in models:
        if not re.fullmatch(r"codex/[A-Za-z0-9_.-]+(?:#[A-Za-z0-9_.-]+)?", model):
            raise ConfigError(f"subscription_only requires a concrete Codex subscription model: {model}")


def resolve_tier(
    cfg: dict[str, Any],
    tier_name: str,
    *,
    model_override: str | None = None,
    effort_override: str | None = None,
    max_tokens_override: int | None = None,
    api_mode_override: str | None = None,
    for_exec: bool = False,
    escalate: bool = False,
) -> dict[str, Any]:
    """Resolve effective model, effort, mode, escalation, and limits for a requested tier."""
    key = normalize_tier_name(tier_name)

    if key == "chore":
        if for_exec:
            raise ConfigError(
                "Tier 'chore' is for lightweight gempt_consult (summarization/classification/grunt work) only; "
                "use 'sonnet', 'opus', or 'fable' for gempt_exec."
            )
        utility = copy.deepcopy(cfg.get("utility") or {})
        chosen_model = (model_override or "").strip() or str(utility.get("model") or "").strip()
        if not chosen_model:
            raise ConfigError("utility.model is not configured; set it via gempt_configure or pass model_override.")
        effort = (effort_override or "").strip() or str(utility.get("reasoning_effort") or "low").strip()
        if effort and effort not in VALID_EFFORTS:
            raise ConfigError(f"Invalid reasoning_effort '{effort}'. Expected one of: {', '.join(VALID_EFFORTS)}")
        api_mode = (api_mode_override or "").strip() or str(utility.get("api_mode") or "chat").strip()
        if api_mode not in {"responses", "chat"}:
            raise ConfigError(f"Invalid api_mode '{api_mode}'. Expected 'responses' or 'chat'")
        max_tokens = int(max_tokens_override or utility.get("max_output_tokens") or 4096)
        fallbacks = [] if model_override else [str(m).strip() for m in (utility.get("fallback_models") or []) if str(m).strip()]
        return {
            "tier": "chore",
            "label": utility.get("label") or "Chore",
            "model": chosen_model,
            "reasoning_effort": effort,
            "api_mode": api_mode,
            "max_output_tokens": max_tokens,
            "fallback_models": fallbacks,
            "escalated": False,
        }

    tiers = cfg.get("tiers") or {}
    tier = copy.deepcopy(tiers[key])
    consult_model = str(tier.get("consult_model") or "").strip()
    exec_model = str(tier.get("exec_model") or "").strip() or consult_model
    chosen_model = (model_override or "").strip() or (exec_model if for_exec else consult_model)
    effort = (effort_override or "").strip() or str(tier.get("reasoning_effort") or "medium").strip()
    if effort and effort not in VALID_EFFORTS:
        raise ConfigError(f"Invalid reasoning_effort '{effort}'. Expected one of: {', '.join(VALID_EFFORTS)}")

    threshold = str(tier.get("escalate_effort_threshold") or "high").strip()
    threshold_rank = EFFORT_RANK.get(threshold, EFFORT_RANK["high"])
    if escalate and EFFORT_RANK.get(effort, 0) < threshold_rank and not effort_override:
        effort = threshold

    escalated = False
    escalate_model = str(tier.get("escalate_model") or "").strip()
    effort_meets_threshold = EFFORT_RANK.get(effort, 0) >= threshold_rank
    if (escalate or effort_meets_threshold) and escalate_model:
        if not model_override and not chosen_model.startswith(("group/", "auto/")):
            chosen_model = escalate_model
            escalated = True
        elif chosen_model.startswith("group/gempt-harness-"):
            escalated = True

    api_mode = (api_mode_override or "").strip() or str(tier.get("api_mode") or "responses").strip()
    if api_mode not in {"responses", "chat"}:
        raise ConfigError(f"Invalid api_mode '{api_mode}'. Expected 'responses' or 'chat'")
    max_tokens = int(max_tokens_override or tier.get("max_output_tokens") or 16384)
    fallbacks = [] if model_override else [str(m).strip() for m in (tier.get("fallback_models") or []) if str(m).strip()]

    if cfg["routing_policy"]["failover_mode"] == "subscription_only":
        if chosen_model == f"group/gempt-harness-{key}" and not model_override:
            from .magpie_client import verify_subscription_group
            verify_subscription_group(cfg, chosen_model)
            require_subscription(fallbacks)
        else:
            require_subscription([chosen_model, *fallbacks])
    return {
        "tier": key,
        "label": tier.get("label") or key,
        "model": chosen_model,
        "reasoning_effort": effort,
        "api_mode": api_mode,
        "max_output_tokens": max_tokens,
        "fallback_models": fallbacks,
        "escalated": escalated,
    }
