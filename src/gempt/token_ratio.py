"""Live Gemini vs. GPT token-ratio telemetry and closed-loop work-split budget controller."""

from __future__ import annotations

import json
import os
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import DEFAULT_CONFIG_PATH, WORKLOAD

KIND_LADDER: tuple[str, ...] = ("specialist", "engineering", "design", "routine")
MIN_SAMPLE_TOKENS = 20_000
UNDER_MARGIN = 6.0
STRONG_UNDER_MARGIN = 18.0
OVER_MARGIN = 8.0
MAX_USAGE_TAIL_BYTES = 16 * 1024 * 1024
DEFAULT_CACHE_TTL_SEC = 15.0
OUTPUT_WEIGHT = 5

_SWARM_COORD_TOOLS = frozenset({
    "read_board",
    "swarm_wait",
    "post_message",
    "swarm",
    "schedule",
    "manage_task",
})
_VISION_TOOLS = frozenset({"generate_image", "browser_subagent"})
_MEDIA_EXTS = frozenset({
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".ico", ".svg",
    ".mp4", ".mov", ".webm", ".wav", ".mp3", ".pdf",
})


def _is_temp_path(path: Path | None) -> bool:
    if path is None:
        return False
    try:
        resolved = path.expanduser().resolve()
        tmp_root = Path(tempfile.gettempdir()).resolve()
        return resolved.is_relative_to(tmp_root)
    except OSError:
        return False


def _default_agy_brain_dir() -> Path:
    return Path.home() / ".gemini" / "antigravity" / "brain"


def _default_magpie_dir() -> Path:
    return Path.home() / ".config" / "magpie"


def resolve_agy_brain_dir(
    explicit: str | Path | None = None,
    *,
    config_path: str | Path | None = None,
    magpie_dir: str | Path | None = None,
) -> Path | None:
    if explicit is not None:
        raw = str(explicit).strip()
        return Path(raw).expanduser().resolve() if raw else None
    env_val = os.environ.get("GEMPT_AGY_BRAIN_DIR", "").strip()
    if env_val:
        return Path(env_val).expanduser().resolve()
    # Keep isolated unit tests hermetic: never leak host Antigravity history into temp sandboxes.
    for probe in (
        Path(config_path) if config_path else None,
        Path(magpie_dir) if magpie_dir else None,
        Path(os.environ["GEMPT_CONFIG"]) if os.environ.get("GEMPT_CONFIG") else None,
        Path(os.environ["GEMPT_SESSIONS_DIR"]) if os.environ.get("GEMPT_SESSIONS_DIR") else None,
        Path(os.environ["MAGPIE_CONFIG_DIR"]) if os.environ.get("MAGPIE_CONFIG_DIR") else None,
    ):
        if _is_temp_path(probe):
            return None
    return _default_agy_brain_dir()


def resolve_magpie_dir(explicit: str | Path | None = None, *, config_path: str | Path | None = None) -> Path | None:
    if explicit is not None:
        raw = str(explicit).strip()
        return Path(raw).expanduser().resolve() if raw else None
    env_val = os.environ.get("MAGPIE_CONFIG_DIR", "").strip()
    if env_val:
        return Path(env_val).expanduser().resolve()
    for probe in (
        Path(config_path) if config_path else None,
        Path(os.environ["GEMPT_CONFIG"]) if os.environ.get("GEMPT_CONFIG") else None,
        Path(os.environ["GEMPT_SESSIONS_DIR"]) if os.environ.get("GEMPT_SESSIONS_DIR") else None,
    ):
        if _is_temp_path(probe):
            return None
    return _default_magpie_dir()


def _parse_iso_ts(value: Any) -> float | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def _empty_bucket() -> dict[str, int]:
    return {"in": 0, "out": 0, "cache_read": 0, "fresh": 0, "work": 0, "total": 0}


def _add_tokens(bucket: dict[str, int], inp: int, out: int, cache_read: int) -> None:
    i = max(0, int(inp or 0))
    o = max(0, int(out or 0))
    c = max(0, int(cache_read or 0))
    bucket["in"] += i
    bucket["out"] += o
    bucket["cache_read"] += c
    bucket["fresh"] += i + o
    bucket["work"] += i + OUTPUT_WEIGHT * o
    bucket["total"] += i + o + c


def _merge_bucket(dst: dict[str, int], src: dict[str, int]) -> None:
    for key in dst:
        dst[key] += src.get(key, 0)


def _classify_model(model: str, provider: str = "") -> str:
    m = str(model or "").strip().lower()
    p = str(provider or "").strip().lower()
    if "gpt" in m or p in ("codex", "openai") or m.startswith(("codex/", "openai/")):
        return "gpt"
    if "gemini" in m or p in ("gemini", "google", "vertex", "antigravity"):
        return "gemini"
    return "other"


def _classify_tool_call(tc: dict[str, Any]) -> str:
    name = str(tc.get("name") or tc.get("tool_name") or "").strip()
    if not name:
        return "other"
    if name in _SWARM_COORD_TOOLS:
        return "swarm"
    if name in _VISION_TOOLS:
        return "vision"
    if name in ("read_file", "view_file"):
        args = tc.get("args") or tc.get("arguments") or {}
        raw_path = str(args.get("Path") or args.get("AbsolutePath") or "").strip().strip('"').lower()
        if raw_path and Path(raw_path.replace("\\", "/")).suffix in _MEDIA_EXTS:
            return "vision"
    return "work"


def _scan_transcript_file(path: Path, cutoff: float, gemini: dict[str, int], gpt: dict[str, int]) -> bool:
    """Scan one transcript; return False if excluded as pure swarm-coordination or pure-vision."""
    try:
        raw_lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return True
    file_gem = _empty_bucket()
    file_gpt = _empty_bucket()
    work_calls = 0
    swarm_calls = 0
    vision_calls = 0
    for line in raw_lines:
        if "PLANNER_RESPONSE" not in line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(obj, dict) or obj.get("type") != "PLANNER_RESPONSE":
            continue
        ts = _parse_iso_ts(obj.get("created_at"))
        if ts is not None and ts < cutoff:
            continue
        for tc in (obj.get("tool_calls") or []):
            if not isinstance(tc, dict):
                continue
            cat = _classify_tool_call(tc)
            if cat == "swarm":
                swarm_calls += 1
            elif cat == "vision":
                vision_calls += 1
            elif cat == "work":
                work_calls += 1
        model = str(obj.get("model") or "")
        cls = _classify_model(model)
        bucket = file_gpt if cls == "gpt" else file_gem
        _add_tokens(
            bucket,
            obj.get("input_tokens") or 0,
            obj.get("output_tokens") or 0,
            obj.get("cache_read_tokens") or 0,
        )
    if work_calls == 0 and (swarm_calls > 0 or vision_calls > 0):
        return False
    _merge_bucket(gemini, file_gem)
    _merge_bucket(gpt, file_gpt)
    return True


def _scan_agy_brain(brain_dir: Path | None, cutoff: float, gemini: dict[str, int], gpt: dict[str, int]) -> tuple[int, int]:
    if brain_dir is None or not brain_dir.is_dir():
        return 0, 0
    files_scanned = 0
    excluded_sessions = 0
    try:
        entries = list(brain_dir.iterdir())
    except OSError:
        return 0, 0
    for entry in entries:
        if not entry.is_dir():
            continue
        transcript = entry / ".system_generated" / "logs" / "transcript.jsonl"
        try:
            st = transcript.stat()
        except OSError:
            continue
        if st.st_mtime < cutoff:
            continue
        files_scanned += 1
        if not _scan_transcript_file(transcript, cutoff, gemini, gpt):
            excluded_sessions += 1
    return files_scanned, excluded_sessions


def _scan_magpie_usage(
    magpie_dir: Path | None,
    cutoff: float,
    gemini: dict[str, int],
    gpt: dict[str, int],
    other: dict[str, int],
) -> int:
    if magpie_dir is None:
        return 0
    usage_file = magpie_dir / "usage.jsonl"
    try:
        size = usage_file.stat().st_size
    except OSError:
        return 0
    if size <= 0:
        return 0
    start = max(0, size - MAX_USAGE_TAIL_BYTES)
    try:
        with usage_file.open("rb") as fh:
            if start > 0:
                fh.seek(start)
            chunk = fh.read().decode("utf-8", errors="replace")
    except OSError:
        return 0
    lines = chunk.splitlines()
    if start > 0 and lines:
        lines = lines[1:]
    matched = 0
    for line in lines:
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(obj, dict):
            continue
        ts = _parse_iso_ts(obj.get("t") or obj.get("created_at") or obj.get("timestamp"))
        if ts is not None and ts < cutoff:
            continue
        model = str(obj.get("served") or obj.get("model") or obj.get("req") or "")
        provider = str(obj.get("provider") or "")
        cls = _classify_model(model, provider)
        target = gpt if cls == "gpt" else (gemini if cls == "gemini" else other)
        _add_tokens(
            target,
            obj.get("in") if "in" in obj else (obj.get("input_tokens") or 0),
            obj.get("out") if "out" in obj else (obj.get("output_tokens") or 0),
            obj.get("cache_read") if "cache_read" in obj else (obj.get("cache_read_tokens") or 0),
        )
        matched += 1
    return matched


def _cache_file_path(config_path: str | Path | None = None) -> Path:
    if config_path:
        return Path(config_path).expanduser().resolve().with_name("token-ratio-cache.json")
    env_cfg = os.environ.get("GEMPT_CONFIG", "").strip()
    if env_cfg:
        return Path(env_cfg).expanduser().resolve().with_name("token-ratio-cache.json")
    return DEFAULT_CONFIG_PATH.with_name("token-ratio-cache.json")


def _read_cache(cache_path: Path, cache_key: str, ttl_sec: float, now: float) -> dict[str, Any] | None:
    if ttl_sec <= 0:
        return None
    try:
        data = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict) or data.get("cache_key") != cache_key:
        return None
    ts = data.get("computed_at_epoch")
    if not isinstance(ts, (int, float)) or (now - float(ts)) > ttl_sec:
        return None
    snapshot = data.get("snapshot")
    return snapshot if isinstance(snapshot, dict) else None


def _write_cache(cache_path: Path, cache_key: str, snapshot: dict[str, Any], now: float) -> None:
    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = cache_path.with_name(f".{cache_path.name}.tmp.{os.getpid()}")
        payload = {"cache_key": cache_key, "computed_at_epoch": now, "snapshot": snapshot}
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        tmp.replace(cache_path)
    except OSError:
        pass


def read_token_ratio(
    window_hours: float = 24.0,
    *,
    config_path: str | Path | None = None,
    brain_dir: str | Path | None = None,
    magpie_dir: str | Path | None = None,
    cache_ttl_sec: float = DEFAULT_CACHE_TTL_SEC,
    now_epoch: float | None = None,
) -> dict[str, Any]:
    """Compute live Gemini vs. GPT token totals and shares over a rolling window."""
    now = float(now_epoch) if now_epoch is not None else time.time()
    resolved_brain = resolve_agy_brain_dir(brain_dir, config_path=config_path, magpie_dir=magpie_dir)
    resolved_magpie = resolve_magpie_dir(magpie_dir, config_path=config_path)
    cache_path = _cache_file_path(config_path)
    cache_key = f"{window_hours:.2f}|{resolved_brain or ''}|{resolved_magpie or ''}"

    cached = _read_cache(cache_path, cache_key, cache_ttl_sec, now)
    if cached is not None:
        return cached

    cutoff = now - max(1.0, float(window_hours)) * 3600.0
    gemini = _empty_bucket()
    gpt = _empty_bucket()
    other = _empty_bucket()

    agy_files, excluded_sessions = _scan_agy_brain(resolved_brain, cutoff, gemini, gpt)
    magpie_records = _scan_magpie_usage(resolved_magpie, cutoff, gemini, gpt, other)

    combined_work = gemini["work"] + gpt["work"]
    combined_fresh = gemini["fresh"] + gpt["fresh"]
    combined_total = gemini["total"] + gpt["total"]

    actual_gpt_work_share = round((gpt["work"] / combined_work) * 100.0, 1) if combined_work > 0 else None
    actual_gpt_fresh_share = round((gpt["fresh"] / combined_fresh) * 100.0, 1) if combined_fresh > 0 else None
    actual_gpt_total_share = round((gpt["total"] / combined_total) * 100.0, 1) if combined_total > 0 else None
    # Primary share uses attributable work tokens (in + 5*out), immune to 91%-cached prefix replay.
    actual_gpt_share = actual_gpt_work_share
    actual_gemini_share = round(100.0 - actual_gpt_share, 1) if actual_gpt_share is not None else None

    snapshot: dict[str, Any] = {
        "window_hours": window_hours,
        "metric": "attributable_work_in_plus_5out",
        "gemini": gemini,
        "gpt": gpt,
        "other": other,
        "combined_work": combined_work,
        "combined_fresh": combined_fresh,
        "combined_total": combined_total,
        "actual_gpt_share": actual_gpt_share,
        "actual_gemini_share": actual_gemini_share,
        "actual_gpt_work_share": actual_gpt_work_share,
        "actual_gpt_fresh_share": actual_gpt_fresh_share,
        "actual_gpt_total_share": actual_gpt_total_share,
        "sources": {
            "agy_files": agy_files,
            "excluded_sessions": excluded_sessions,
            "magpie_records": magpie_records,
        },
        "computed_at": datetime.fromtimestamp(now, tz=timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    if cache_ttl_sec > 0 and now_epoch is None:
        _write_cache(cache_path, cache_key, snapshot, now)
    return snapshot


def dynamic_budget_enabled(policy: dict[str, Any] | None = None) -> bool:
    env_flag = os.environ.get("GEMPT_DYNAMIC_BUDGET", "").strip().lower()
    if env_flag in ("0", "false", "no", "off"):
        return False
    if env_flag in ("1", "true", "yes", "on"):
        return True
    if isinstance(policy, dict) and policy.get("dynamic_budget") is False:
        return False
    return True


def evaluate_budget(
    profile: str,
    snapshot: dict[str, Any] | None,
    *,
    enabled: bool = True,
) -> dict[str, Any]:
    """Compute effective delegated kinds by comparing actual 24h GPT token share to target."""
    plan = WORKLOAD["profiles"].get(profile) or WORKLOAD["profiles"]["balanced"]
    target = int(plan["gpt_share"])
    base_kinds = list(plan["kinds"])
    snap = snapshot or {}
    gemini = snap.get("gemini") or _empty_bucket()
    gpt = snap.get("gpt") or _empty_bucket()
    combined_work = int(snap.get("combined_work") if snap.get("combined_work") is not None else (gemini.get("work", 0) + gpt.get("work", 0)))
    combined_fresh = int(snap.get("combined_fresh") if snap.get("combined_fresh") is not None else (gemini.get("fresh", 0) + gpt.get("fresh", 0)))
    combined_total = int(snap.get("combined_total") if snap.get("combined_total") is not None else (gemini.get("total", 0) + gpt.get("total", 0)))
    sample_tokens = combined_work if combined_work > 0 else combined_total
    actual = snap.get("actual_gpt_share")
    actual_gem = snap.get("actual_gemini_share")
    actual_fresh = snap.get("actual_gpt_fresh_share")
    actual_total = snap.get("actual_gpt_total_share")
    delta = round(float(actual) - target, 1) if isinstance(actual, (int, float)) else None

    effective_kinds = list(base_kinds)
    adjustment = "balanced"

    if not base_kinds or target <= 0:
        effective_kinds = []
        adjustment = "off"
    elif not enabled:
        adjustment = "disabled"
    elif sample_tokens < MIN_SAMPLE_TOKENS or actual is None:
        adjustment = "warming_up"
    elif target >= 95:
        effective_kinds = list(KIND_LADDER)
        adjustment = "under_target" if float(actual) < (target - UNDER_MARGIN) else "balanced"
    else:
        assert delta is not None
        if delta <= -STRONG_UNDER_MARGIN:
            max_cap = 3 if target <= 50 else len(KIND_LADDER)
            count = min(max_cap, len(base_kinds) + 2)
            effective_kinds = list(KIND_LADDER[:count])
            adjustment = "widened_strong"
        elif delta < -UNDER_MARGIN:
            count = min(len(KIND_LADDER), len(base_kinds) + 1)
            effective_kinds = list(KIND_LADDER[:count])
            adjustment = "widened"
        elif delta > OVER_MARGIN:
            if len(base_kinds) > 1:
                effective_kinds = list(KIND_LADDER[: len(base_kinds) - 1])
                adjustment = "tightened"
            else:
                effective_kinds = list(base_kinds)
                adjustment = "over_target"
        else:
            effective_kinds = list(base_kinds)
            adjustment = "balanced"

    return {
        "enabled": bool(enabled),
        "metric": snap.get("metric", "attributable_work_in_plus_5out"),
        "profile": profile,
        "target_gpt_share": target,
        "actual_gpt_share": actual,
        "actual_gemini_share": actual_gem,
        "actual_gpt_fresh_share": actual_fresh,
        "actual_gpt_total_share": actual_total,
        "delta": delta,
        "adjustment": adjustment,
        "base_kinds": base_kinds,
        "effective_kinds": effective_kinds,
        "gemini_work_tokens": int(gemini.get("work", 0)),
        "gpt_work_tokens": int(gpt.get("work", 0)),
        "gemini_tokens": int(gemini.get("total", 0)),
        "gpt_tokens": int(gpt.get("total", 0)),
        "gemini_fresh_tokens": int(gemini.get("fresh", 0)),
        "gpt_fresh_tokens": int(gpt.get("fresh", 0)),
        "combined_work": combined_work,
        "combined_fresh": combined_fresh,
        "combined_total": combined_total,
        "excluded_sessions": int((snap.get("sources") or {}).get("excluded_sessions") or 0),
        "window_hours": snap.get("window_hours", 24.0),
    }


def resolve_budget(
    profile: str,
    *,
    policy: dict[str, Any] | None = None,
    config_path: str | Path | None = None,
    brain_dir: str | Path | None = None,
    magpie_dir: str | Path | None = None,
    window_hours: float = 24.0,
    cache_ttl_sec: float = DEFAULT_CACHE_TTL_SEC,
) -> dict[str, Any]:
    enabled = dynamic_budget_enabled(policy)
    if not enabled or profile == "gemini":
        return evaluate_budget(profile, None, enabled=enabled)
    snapshot = read_token_ratio(
        window_hours=window_hours,
        config_path=config_path,
        brain_dir=brain_dir,
        magpie_dir=magpie_dir,
        cache_ttl_sec=cache_ttl_sec,
    )
    return evaluate_budget(profile, snapshot, enabled=enabled)
