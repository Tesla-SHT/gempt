"""Cross-platform Magpie native routing presets."""

from __future__ import annotations

import os
from typing import Any, Mapping

from . import VALID_EFFORTS
from .config import load_config
from .discover import (
    _is_excluded_model,
    _is_utility_candidate,
    _pick_best,
    _resolve_excluded_models,
    _score_model,
    _utility_rank,
    find_magpie_cli,
)
from .magpie_client import MagpieRequestError, _group_command, _normalize_group_member
from .sessions import exclusive_operation, resolve_sessions_dir

NATIVE_PRESET_TIERS = ("gempt-sonnet", "gempt-opus", "gempt-fable")
DEFAULT_PRESET_MODELS: dict[str, tuple[str, str]] = {
    "hydrogen": ("GEMPT_HYDROGEN", "antigravity/gemini-4-hydrogen"),
    "neon": ("GEMPT_NEON", "antigravity/gemini-4-neon"),
    "argon": ("GEMPT_ARGON", "antigravity/gemini-4-carbon"),
    "terra": ("GEMPT_TERRA", "codex/gpt-6.1-terra"),
    "sol": ("GEMPT_SOL", "codex/gpt-6.2-sol"),
    "astra": ("GEMPT_ASTRA", "codex/gpt-6.2-astra"),
    "flash": ("DEEPSEEK_FLASH", "auto/deepseek-v4.1-flash"),
}


def resolve_native_preset_models(env: Mapping[str, str] | None = None) -> dict[str, str]:
    """Resolve preset model IDs from environment overrides or defaults."""
    source = os.environ if env is None else env
    models = {
        key: (source.get(env_var) or "").strip() or default
        for key, (env_var, default) in DEFAULT_PRESET_MODELS.items()
    }
    if not source.get("GEMPT_TERRA") and source.get("GEMPT_SOL"):
        models["terra"] = models["sol"]
    return models


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
    """Build Magpie group commands, including utility rules when available."""
    resolved = dict(models) if models is not None else resolve_native_preset_models()
    hydrogen_m = _normalize_group_member(resolved["hydrogen"])
    neon_m = _normalize_group_member(resolved["neon"])
    argon_m = _normalize_group_member(resolved["argon"])
    terra_m = _normalize_group_member(resolved.get("terra", resolved["sol"]))
    sol_m = _normalize_group_member(resolved["sol"])
    astra_m = _normalize_group_member(resolved["astra"])
    flash_m = _normalize_group_member(resolved["flash"])

    return [
        [magpie_bin, "group", "add", "gempt-sonnet", _group_models(hydrogen_m, terra_m, flash_m), "routing=order", "stays=turn"],
        *([
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
        ] if flash_m else []),
        [magpie_bin, "group", "rule", "add", "gempt-sonnet", f"use={terra_m}", "when=subagent"],
        [
            magpie_bin,
            "group",
            "rule",
            "add",
            "gempt-sonnet",
            f"use={terra_m}",
            "intent=writing code, editing files, running tests, or fixing bugs",
        ],
        [magpie_bin, "group", "add", "gempt-opus", _group_models(neon_m, sol_m, astra_m, flash_m), "routing=order", "stays=turn"],
        *([
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
        ] if flash_m else []),
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
        [magpie_bin, "group", "add", "gempt-fable", _group_models(argon_m, astra_m, flash_m), "routing=order", "stays=turn"],
        *([[magpie_bin, "group", "rule", "add", "gempt-fable", f"use={flash_m}", "compact"]] if flash_m else []),
        [magpie_bin, "group", "rule", "add", "gempt-fable", f"use={astra_m}", "when=subagent"],
        [
            magpie_bin,
            "group",
            "rule",
            "add",
            "gempt-fable",
            f"use={astra_m}",
            *([f"classifier={flash_m}"] if flash_m else []),
            "intent=writing code, editing files, debugging, or executing tasks",
        ],
    ]


def _group_models(*members: str) -> str:
    return "models=" + ",".join(dict.fromkeys(member for member in members if member))


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


def _pick_gemini_slot(catalog_ids: set[str], slot: str, excluded: set[str]) -> str:
    patterns_by_slot: dict[str, list[tuple[str, int]]] = {
        "hydrogen": [("gemini-4-hydrogen", 320), ("hydrogen", 240), ("flash", 140), ("neon", 80), ("carbon", 60)],
        "neon": [("gemini-4-neon", 320), ("neon", 240), ("carbon", 160), ("pro", 100), ("hydrogen", 60)],
        "argon": [("gemini-4-carbon", 320), ("carbon", 240), ("neon", 180), ("pro", 100)],
    }
    blocked_kinds = ("embedding", "tts", "image", "imagen", "veo")
    candidates = [
        cid
        for cid in sorted(catalog_ids)
        if not _is_excluded_model(cid, excluded)
        and not cid.startswith("group/gempt-")
        and "gemini" in cid.lower()
        and not any(bad in cid.lower() for bad in blocked_kinds)
    ]
    if not candidates:
        return ""

    slot_patterns = patterns_by_slot.get(slot, [])

    def _rank(cid: str) -> tuple[int, str]:
        lower = cid.lower()
        provider_score = 100
        if lower.startswith(("agy-cli/", "antigravity/", "google/", "gemini/")):
            provider_score = 400
        elif lower.startswith("auto/"):
            provider_score = 220
        return provider_score + _score_model(cid, slot_patterns), cid

    return max(candidates, key=_rank)


def _resolve_catalog_models(
    exe: str,
    base_models: Mapping[str, str],
    catalog_ids: set[str],
    excluded: set[str],
    env: Mapping[str, str] | None,
) -> dict[str, str]:
    source = os.environ if env is None else env
    resolved = dict(base_models)

    codex_cands = [
        cid for cid in sorted(catalog_ids)
        if cid.startswith("codex/") and not _is_excluded_model(cid, excluded)
    ]
    util_cands = sorted(
        (cid for cid in catalog_ids if _is_utility_candidate({"id": cid}, excluded)),
        key=lambda cid: _utility_rank({"id": cid}),
        reverse=True,
    )

    for slot, (env_var, _) in DEFAULT_PRESET_MODELS.items():
        current = resolved[slot]
        if (source.get(env_var) or "").strip():
            if _is_excluded_model(current, excluded):
                raise MagpieRequestError(f"{env_var} selects an excluded model: {current}", model=current)
            if not _model_exists(exe, current, catalog_ids):
                raise MagpieRequestError(f"Model not found in Magpie: {current}", model=current)
            continue
        if not _is_excluded_model(current, excluded) and _model_exists(exe, current, catalog_ids):
            continue
        picked = ""
        if slot in {"hydrogen", "neon", "argon"}:
            picked = _pick_gemini_slot(catalog_ids, slot, excluded)
        elif slot == "terra":
            picked = _pick_best(codex_cands, [("6.1-terra", 320), ("terra", 240), ("sol", 140)])
        elif slot == "sol":
            picked = _pick_best(codex_cands, [("6.2-sol", 300), ("sol", 240), ("terra", 140), ("luna", 100)])
        elif slot == "astra":
            picked = _pick_best(codex_cands, [("6.2-astra", 320), ("astra", 260), ("pro", 180), ("sol", 100)])
        elif slot == "flash":
            picked = util_cands[0] if util_cands else ""
        if not picked and slot != "flash":
            raise MagpieRequestError(f"No allowed model found in Magpie for {slot} ({env_var}).")
        resolved[slot] = picked

    return resolved


def apply_native_presets(
    *,
    cli_path: str = "",
    apply: bool = False,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Preview or create Magpie native routing groups group/gempt-{sonnet,opus,fable}."""
    models = resolve_native_preset_models(env)
    if not apply:
        source = os.environ if env is None else env
        magpie_bin = cli_path.strip() or (source.get("MAGPIE_BIN") or "").strip() or "magpie"
        return {
            "applied": False,
            "models": models,
            "commands": build_native_preset_commands(magpie_bin=magpie_bin, models=models),
        }

    config, _ = load_config(require_exists=False)
    exe = find_magpie_cli(cli_path.strip() or config["magpie"].get("cli_path", ""))
    if not exe:
        raise MagpieRequestError("Magpie CLI not found (set MAGPIE_BIN or pass --magpie-cli).")

    with exclusive_operation(resolve_sessions_dir() / ".groups.lock"):
        catalog_out = _group_command([exe, "models"]) or ""
        catalog_ids = _catalog_model_ids(catalog_out)
        exclusions = config["routing_policy"].get("excluded_models")
        models = _resolve_catalog_models(exe, models, catalog_ids, _resolve_excluded_models(exclusions), env)

        _group_command([exe, "groups"])
        for tier in NATIVE_PRESET_TIERS:
            if _group_command([exe, "group", "show", tier], missing=tier) is not None:
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
