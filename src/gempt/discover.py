"""Cross-platform environment discovery for Magpie gateway, models, groups, and Codex CLI."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Iterable

from . import DEFAULT_MAGPIE_URL
from .config import config_exists, load_config, resolve_magpie_api_key
from .magpie_client import build_magpie_cli_env, build_opener

_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0


def _resolve_excluded_models(excluded_models: Iterable[str] | None = None) -> set[str]:
    """Return lowercased model-ID substring filters from GEMPT_EXCLUDED_MODELS and config."""
    resolved: set[str] = set()
    env_raw = os.environ.get("GEMPT_EXCLUDED_MODELS", "")
    for part in env_raw.split(","):
        token = part.strip().lower()
        if token:
            resolved.add(token)
    if excluded_models is not None:
        for item in excluded_models:
            token = str(item).strip().lower()
            if token:
                resolved.add(token)
    return resolved


def _is_excluded_model(model_id: str, excluded: set[str] | None = None) -> bool:
    blocked = excluded if excluded is not None else _resolve_excluded_models()
    if not blocked:
        return False
    lower = model_id.lower()
    return any(token in lower for token in blocked)


def find_magpie_cli(configured_path: str = "") -> str | None:
    """Locate local Magpie CLI executable if installed."""
    candidates: list[Path] = []
    if configured_path:
        candidates.append(Path(configured_path).expanduser())
    env_magpie = os.environ.get("MAGPIE_BIN", "").strip()
    if env_magpie:
        candidates.append(Path(env_magpie).expanduser())
        found_env = shutil.which(env_magpie)
        if found_env:
            candidates.append(Path(found_env))
    for name in ("magpie.com", "magpie"):
        found = shutil.which(name)
        if found:
            candidates.append(Path(found))

    if sys.platform == "win32":
        candidates.extend(
            [
                Path.home() / "apps" / "magpie" / "magpie.com",
                Path.home() / "apps" / "magpie" / "magpie.exe",
            ]
        )
        local_appdata = os.environ.get("LOCALAPPDATA", "").strip()
        if local_appdata:
            candidates.extend(
                [
                    Path(local_appdata) / "Programs" / "magpie" / "magpie.com",
                    Path(local_appdata) / "Programs" / "magpie" / "magpie.exe",
                ]
            )
        candidates.extend(
            [
                Path("D:/apps/magpie/magpie.com"),
                Path("D:/apps/magpie/magpie.exe"),
            ]
        )
    else:
        candidates.extend(
            [
                Path.home() / ".local" / "opt" / "magpie" / "magpie",
                Path.home() / "apps" / "magpie" / "magpie",
                Path.home() / ".local" / "bin" / "magpie",
                Path("/Applications/magpie.app/Contents/MacOS/magpie"),
                Path("/usr/local/bin/magpie"),
            ]
        )

    for candidate in candidates:
        try:
            if candidate and candidate.is_file():
                return str(candidate)
        except OSError:
            continue
    return None


def find_codex_cli(configured_path: str = "") -> dict[str, Any]:
    """Locate Codex CLI and inspect its version and `exec` flags."""
    candidates: list[str] = []
    if configured_path:
        candidates.append(configured_path)
    for name in ("codex", "codex.cmd", "codex.exe"):
        found = shutil.which(name)
        if found and found not in candidates:
            candidates.append(found)

    if sys.platform == "win32":
        npm_global = Path.home() / ".npm-global"
        c_home_npm = Path(f"C:/home/{os.environ.get('USERNAME', '')}/.npm-global")
        appdata_npm = Path(os.environ.get("APPDATA", "")) / "npm"
        for base in (npm_global, c_home_npm, appdata_npm):
            for fname in ("codex.cmd", "codex.exe"):
                p = base / fname
                if p.is_file() and str(p) not in candidates:
                    candidates.append(str(p))

    resolved = ""
    for cand in candidates:
        p = Path(cand).expanduser()
        if p.is_file():
            if sys.platform == "win32" and p.suffix.lower() == ".ps1" and p.with_suffix(".cmd").is_file():
                resolved = str(p.with_suffix(".cmd"))
            else:
                resolved = str(p)
            break

    if not resolved:
        return {"found": False, "path": "", "version": "", "capabilities": {}}

    def _run(args: list[str]) -> str:
        cmd = [resolved, *args]
        if sys.platform == "win32" and resolved.lower().endswith((".cmd", ".bat")):
            cmd = [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c", resolved, *args]
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=10,
                creationflags=_CREATE_NO_WINDOW,
            )
            return (proc.stdout or "") + "\n" + (proc.stderr or "")
        except Exception:
            return ""

    ver_out = _run(["--version"]).strip()
    help_out = _run(["exec", "--help"])
    return {
        "found": True,
        "path": resolved,
        "version": ver_out.splitlines()[0].strip() if ver_out else "",
        "capabilities": {
            "exec": "--skip-git-repo-check" in help_out or "Run Codex non-interactively" in help_out,
            "json": "--json" in help_out,
            "output_last_message": "--output-last-message" in help_out,
            "cd": "--cd" in help_out,
            "sandbox": "--sandbox" in help_out,
            "resume": "resume" in help_out,
        },
    }


def _is_gpt_or_codex_model(entry: dict[str, Any]) -> bool:
    mid = str(entry.get("id") or "").lower()
    owned = str(entry.get("owned_by") or "").lower()
    if owned in {"codex", "openai"}:
        return True
    if mid.startswith(("codex/", "openai/")):
        return True
    return "gpt" in mid


def _is_utility_candidate(entry: dict[str, Any], excluded: set[str] | None = None) -> bool:
    mid = str(entry.get("id") or "").lower()
    if _is_excluded_model(mid, excluded) or _is_gpt_or_codex_model(entry):
        return False
    if "gemini" in mid:
        return False
    tokens = ("deepseek", "-flash", "-free", "glm-5.3-flash", "qwen3.8-flash")
    return any(tok in mid for tok in tokens)


def _utility_rank(entry: dict[str, Any]) -> tuple[int, str]:
    mid = str(entry.get("id") or "").lower()
    score = 0
    if mid == "auto/deepseek-v4.1-flash":
        score += 650
    elif mid.startswith(("workbuddy/", "workbuddy-ai/")) and "deepseek" in mid:
        score += 600
    elif "deepseek" in mid and "free" in mid:
        score += 520
    elif "deepseek-v4.1-flash" in mid or "deepseek-flash" in mid:
        score += 480
    elif "deepseek" in mid:
        score += 360
    if "flash" in mid:
        score += 120
    if "free" in mid:
        score += 40
    return score, mid


def probe_magpie_gateway(
    base_url: str,
    api_key: str = "magpie",
    *,
    excluded_models: Iterable[str] | None = None,
) -> dict[str, Any]:
    """Query Magpie /v1/models and classify GPT models, utility models, and routing groups."""
    excluded = _resolve_excluded_models(excluded_models)
    url = base_url.rstrip("/") + "/v1/models"
    headers = {"Accept": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    req = urllib.request.Request(url, headers=headers)
    opener = build_opener(url)
    try:
        with opener.open(req, timeout=8) as resp:
            payload = json.load(resp)
    except urllib.error.HTTPError as exc:
        return {"reachable": False, "url": base_url, "error": f"HTTP {exc.code}: {exc.reason}"}
    except Exception as exc:
        return {"reachable": False, "url": base_url, "error": str(exc)}

    raw_models = payload.get("data") or []
    codex_models: list[dict[str, Any]] = []
    openai_models: list[dict[str, Any]] = []
    routing_groups: list[dict[str, Any]] = []
    gempt_groups: list[dict[str, Any]] = []
    native_gempt_groups: list[dict[str, Any]] = []
    other_gpt_models: list[dict[str, Any]] = []
    utility_candidates: list[dict[str, Any]] = []

    for item in raw_models:
        if not isinstance(item, dict):
            continue
        mid = str(item.get("id") or "")
        if _is_excluded_model(mid, excluded):
            continue
        owned = str(item.get("owned_by") or "").lower()
        label = str(item.get("magpie_label") or "")
        compact = {
            "id": mid,
            "display_name": item.get("display_name") or mid,
            "owned_by": item.get("owned_by") or "",
            "reasoning_levels": item.get("reasoning_levels") or [],
            "context_window": item.get("context_window"),
            "max_output_tokens": item.get("max_output_tokens"),
            "pricing": item.get("pricing"),
        }
        is_group = mid.startswith(("group/", "auto/")) or "routing group" in label.lower()
        if is_group:
            routing_groups.append(compact)
            if mid.startswith("group/gempt-harness-"):
                gempt_groups.append(compact)
            elif mid in {"group/gempt-sonnet", "group/gempt-opus", "group/gempt-fable"}:
                native_gempt_groups.append(compact)
            if _is_utility_candidate(item, excluded):
                utility_candidates.append(compact)
        elif mid.startswith("codex/"):
            codex_models.append(compact)
        elif _is_utility_candidate(item, excluded):
            utility_candidates.append(compact)

    utility_candidates.sort(key=_utility_rank, reverse=True)

    return {
        "reachable": True,
        "url": base_url,
        "total_models": len(raw_models),
        "codex_subscription_models": codex_models,
        "openai_api_models": openai_models,
        "routing_groups": routing_groups,
        "gempt_groups": gempt_groups,
        "native_gempt_groups": native_gempt_groups,
        "other_gpt_models": other_gpt_models,
        "utility_candidates": utility_candidates,
    }


def _score_model(model_id: str, patterns: list[tuple[str, int]]) -> int:
    lower = model_id.lower()
    score = 0
    for token, weight in patterns:
        if token in lower:
            score += weight
    m = re.search(r"gpt-(\d+(?:\.\d+)?)", lower)
    if m:
        try:
            score += int(float(m.group(1)) * 10)
        except ValueError:
            pass
    return score


def _pick_best(candidates: list[str], patterns: list[tuple[str, int]]) -> str:
    if not candidates:
        return ""
    ranked = sorted(candidates, key=lambda m: (_score_model(m, patterns), m), reverse=True)
    return ranked[0]


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        s = item.strip()
        if s and s not in seen:
            seen.add(s)
            out.append(s)
    return out


def build_tier_recommendations(
    catalog: dict[str, Any],
    *,
    excluded_models: Iterable[str] | None = None,
) -> dict[str, Any]:
    """Build portable sonnet/opus/fable + utility recommendations from Codex subscription models."""
    excluded = _resolve_excluded_models(excluded_models)
    codex_ids = [m["id"] for m in catalog.get("codex_subscription_models") or [] if not _is_excluded_model(m["id"], excluded)]
    utility_ids = [m["id"] for m in catalog.get("utility_candidates") or [] if not _is_excluded_model(m["id"], excluded)]
    utility_pick = utility_ids[0] if utility_ids else ""

    if not codex_ids:
        return {
            "available": False,
            "utility_model": utility_pick,
            "reason": "未检测到 Codex 订阅模型，请先在 Magpie 中登录 ChatGPT/Codex 订阅账号。",
            "presets": {
                "subscription_only": {
                    "description": "Codex 订阅直连：Sonnet=Sol, Opus=Sol+Astra(疑难升级), Fable=Astra",
                    "available": False,
                    "tiers": {},
                },
            },
        }

    sonnet_pick = _pick_best(codex_ids, [("6.2-sol", 300), ("sol", 240), ("terra", 140), ("luna", 100)])
    fable_pick = _pick_best(codex_ids, [("6.2-astra", 320), ("astra", 260), ("pro", 180), ("sol", 100)])

    sub_tiers = {
        "sonnet": {
            "consult_model": sonnet_pick,
            "exec_model": sonnet_pick,
            "reasoning_effort": "medium",
            "fallback_models": [],
            "magpie_group_members": [sonnet_pick],
        },
        "opus": {
            "consult_model": sonnet_pick,
            "exec_model": sonnet_pick,
            "escalate_model": fable_pick,
            "escalate_effort_threshold": "high",
            "reasoning_effort": "medium",
            "fallback_models": [],
            "magpie_group_members": _dedupe([sonnet_pick, fable_pick]),
        },
        "fable": {
            "consult_model": fable_pick,
            "exec_model": fable_pick,
            "reasoning_effort": "high",
            "fallback_models": [],
            "magpie_group_members": [fable_pick],
        },
    }

    return {
        "available": True,
        "utility_model": utility_pick,
        "presets": {
            "subscription_only": {
                "description": "Codex 订阅直连：Sonnet=Sol, Opus=Sol+Astra(疑难升级), Fable=Astra",
                "available": True,
                "tiers": sub_tiers,
            },
        },
    }


def _read_magpie_groups_cli(
    cli_path: str | None,
    *,
    excluded_models: Iterable[str] | None = None,
) -> list[str]:
    if not cli_path:
        return []
    excluded = _resolve_excluded_models(excluded_models)
    try:
        proc = subprocess.run(
            [cli_path, "groups"],
            env=build_magpie_cli_env(),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            creationflags=_CREATE_NO_WINDOW,
        )
        if proc.returncode != 0:
            return []
        return [
            line.strip()
            for line in proc.stdout.splitlines()
            if line.strip() and not _is_excluded_model(line, excluded)
        ]
    except Exception:
        return []


def discover_environment(
    *,
    magpie_url: str | None = None,
    config_path: str | Path | None = None,
    include_cli_groups: bool = True,
    effective_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Run full local discovery for initial setup wizard or diagnostics."""
    cfg_path, cfg_present = config_exists(explicit=config_path)
    cfg = effective_config or load_config(explicit=config_path, require_exists=False)[0]
    base_url = (magpie_url or cfg.get("magpie", {}).get("base_url") or DEFAULT_MAGPIE_URL).strip()
    api_key, key_source = resolve_magpie_api_key(cfg, target=base_url)
    excluded_models = (cfg.get("routing_policy") or {}).get("excluded_models")

    magpie_cli = find_magpie_cli(str(cfg.get("magpie", {}).get("cli_path") or ""))
    codex_info = find_codex_cli(str(cfg.get("codex", {}).get("cli_path") or ""))
    catalog = probe_magpie_gateway(base_url, api_key=api_key, excluded_models=excluded_models)
    recommendations = (
        build_tier_recommendations(catalog, excluded_models=excluded_models)
        if catalog.get("reachable")
        else {"available": False}
    )
    magpie_groups_text = (
        _read_magpie_groups_cli(magpie_cli, excluded_models=excluded_models)
        if include_cli_groups
        else []
    )

    missing: list[str] = []
    subscription_ready = bool(catalog.get("codex_subscription_models"))
    if not catalog.get("reachable"):
        missing.append(f"Magpie gateway unreachable at {base_url}: {catalog.get('error')}")
    elif not recommendations.get("available"):
        missing.append("No Codex subscription models exposed in Magpie /v1/models yet. Sign in to ChatGPT/Codex in Magpie first.")
    if not codex_info.get("found"):
        missing.append("Codex CLI not found in PATH (`gempt_consult` still works; `gempt_exec` requires Codex CLI).")

    native_ids = [g["id"] for g in (catalog.get("native_gempt_groups") or [])]
    expected_native = ["group/gempt-sonnet", "group/gempt-opus", "group/gempt-fable"]
    native_presets = {
        "groups": native_ids,
        "missing": [g for g in expected_native if g not in native_ids],
        "complete": all(g in native_ids for g in expected_native),
    }

    return {
        "config": {
            "path": str(cfg_path),
            "exists": cfg_present,
            "api_key_source": key_source,
        },
        "magpie": {
            "base_url": base_url,
            "cli_path": magpie_cli or "",
            "gateway": catalog,
            "cli_groups": magpie_groups_text,
            "native_presets": native_presets,
        },
        "codex": codex_info,
        "recommendations": recommendations,
        "subscription_ready": subscription_ready,
        "ready_for_consult": bool(cfg_present and catalog.get("reachable") and recommendations.get("available")),
        "ready_for_exec": bool(cfg_present and catalog.get("reachable") and recommendations.get("available") and codex_info.get("found")),
        "missing": missing,
    }
