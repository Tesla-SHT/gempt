"""Cross-platform Magpie native routing presets matching root install.sh."""

from __future__ import annotations

import os
from typing import Any, Mapping

from . import VALID_EFFORTS
from .discover import find_magpie_cli
from .magpie_client import MagpieRequestError, _group_command, _normalize_group_member
from .sessions import exclusive_operation, resolve_sessions_dir

NATIVE_PRESET_TIERS = ("gempt-sonnet", "gempt-opus", "gempt-fable")
DEFAULT_PRESET_MODELS: dict[str, tuple[str, str]] = {
    "hydrogen": ("GEMPT_HYDROGEN", "antigravity/gemini-4-hydrogen"),
    "neon": ("GEMPT_NEON", "antigravity/gemini-4-neon"),
    "argon": ("GEMPT_ARGON", "antigravity/gemini-4-argon"),
    "sol": ("GEMPT_SOL", "codex/gpt-6.2-sol"),
    "astra": ("GEMPT_ASTRA", "codex/gpt-6.2-astra"),
    "flash": ("DEEPSEEK_FLASH", "workbuddy/deepseek-v4.1-flash"),
}


def resolve_native_preset_models(env: Mapping[str, str] | None = None) -> dict[str, str]:
    """Resolve preset model IDs from environment overrides or defaults."""
    source = os.environ if env is None else env
    return {
        key: (source.get(env_var) or "").strip() or default
        for key, (env_var, default) in DEFAULT_PRESET_MODELS.items()
    }


def strip_model_modifiers(model_id: str) -> str:
    """Strip #account pin, :fast, and trailing reasoning-effort suffix for catalog lookup."""
    base = model_id.split("#", 1)[0]
    if base.endswith(":fast"):
        base = base[: -len(":fast")]
    if ":" in base:
        prefix, suffix = base.rsplit(":", 1)
        if suffix in VALID_EFFORTS:
            base = prefix
    return base


def build_native_preset_commands(
    magpie_bin: str = "magpie",
    models: Mapping[str, str] | None = None,
) -> list[list[str]]:
    """Build the 14 Magpie CLI commands matching root install.sh 1:1."""
    resolved = dict(models) if models is not None else resolve_native_preset_models()
    hydrogen_m = _normalize_group_member(resolved["hydrogen"])
    neon_m = _normalize_group_member(resolved["neon"])
    argon_m = _normalize_group_member(resolved["argon"])
    sol_m = _normalize_group_member(resolved["sol"])
    astra_m = _normalize_group_member(resolved["astra"])
    flash_m = _normalize_group_member(resolved["flash"])

    return [
        [magpie_bin, "group", "add", "gempt-sonnet", f"models={hydrogen_m},{sol_m},{flash_m}", "routing=order", "stays=turn"],
        [magpie_bin, "group", "rule", "add", "gempt-sonnet", f"use={flash_m}", "compact"],
        [
            magpie_bin,
            "group",
            "rule",
            "add",
            "gempt-sonnet",
            f"use={flash_m}",
            f"classifier={flash_m}",
            "intent=simple formatting, adding comments, renaming, translating, writing boilerplate, or trivial quick questions",
        ],
        [magpie_bin, "group", "rule", "add", "gempt-sonnet", f"use={sol_m}", "when=subagent"],
        [
            magpie_bin,
            "group",
            "rule",
            "add",
            "gempt-sonnet",
            f"use={sol_m}",
            "intent=writing code, editing files, running tests, or fixing bugs",
        ],
        [magpie_bin, "group", "add", "gempt-opus", f"models={neon_m},{sol_m},{astra_m},{flash_m}", "routing=order", "stays=turn"],
        [magpie_bin, "group", "rule", "add", "gempt-opus", f"use={flash_m}", "compact"],
        [
            magpie_bin,
            "group",
            "rule",
            "add",
            "gempt-opus",
            f"use={astra_m}",
            f"classifier={flash_m}",
            "intent=debugging hard bugs, complex algorithms, math/physics derivations, or critical architecture changes",
        ],
        [magpie_bin, "group", "rule", "add", "gempt-opus", f"use={sol_m}", "when=subagent"],
        [
            magpie_bin,
            "group",
            "rule",
            "add",
            "gempt-opus",
            f"use={sol_m}",
            "intent=writing code, editing files, implementing features, or writing tests",
        ],
        [magpie_bin, "group", "add", "gempt-fable", f"models={argon_m},{astra_m},{flash_m}", "routing=order", "stays=turn"],
        [magpie_bin, "group", "rule", "add", "gempt-fable", f"use={flash_m}", "compact"],
        [magpie_bin, "group", "rule", "add", "gempt-fable", f"use={astra_m}", "when=subagent"],
        [
            magpie_bin,
            "group",
            "rule",
            "add",
            "gempt-fable",
            f"use={astra_m}",
            f"classifier={flash_m}",
            "intent=writing code, editing files, debugging, or executing tasks",
        ],
    ]


def _catalog_model_ids(catalog_output: str) -> set[str]:
    ids: set[str] = set()
    for line in catalog_output.splitlines():
        parts = line.split()
        if parts:
            ids.add(parts[0])
    return ids


def _model_exists(exe: str, raw_model: str, catalog_ids: set[str]) -> bool:
    if raw_model in catalog_ids:
        return True
    if raw_model.startswith(("auto/", "group/")):
        norm = _normalize_group_member(raw_model)
        return _group_command([exe, "group", "show", norm.removeprefix("group/")], missing=norm.removeprefix("group/")) is not None
    base = strip_model_modifiers(raw_model)
    return base != raw_model and base in catalog_ids


def apply_native_presets(
    *,
    cli_path: str = "",
    apply: bool = False,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Preview or create Magpie native routing groups group/gempt-{sonnet,opus,fable}."""
    models = resolve_native_preset_models(env)
    if not apply:
        magpie_bin = cli_path.strip() or "magpie"
        return {
            "applied": False,
            "models": models,
            "commands": build_native_preset_commands(magpie_bin=magpie_bin, models=models),
        }

    exe = find_magpie_cli(cli_path.strip())
    if not exe:
        raise MagpieRequestError("Magpie CLI not found (set MAGPIE_BIN or pass --magpie-cli).")

    with exclusive_operation(resolve_sessions_dir() / ".groups.lock"):
        catalog_out = _group_command([exe, "models"]) or ""
        catalog_ids = _catalog_model_ids(catalog_out)
        for model in models.values():
            if not _model_exists(exe, model, catalog_ids):
                raise MagpieRequestError(f"Model not found in Magpie: {model}", model=model)

        _group_command([exe, "groups"])
        for tier in NATIVE_PRESET_TIERS:
            if _group_command([exe, "group", tier], missing=tier) is not None:
                raise MagpieRequestError(f"Routing group already exists: group/{tier}")

        commands = build_native_preset_commands(magpie_bin=exe, models=models)
        for cmd in commands:
            _group_command(cmd)

    return {
        "applied": True,
        "cli_path": exe,
        "models": models,
        "groups": [f"group/{t}" for t in NATIVE_PRESET_TIERS],
        "commands": commands,
    }
