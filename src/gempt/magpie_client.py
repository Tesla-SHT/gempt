"""HTTP client for local Magpie gateway (/v1/responses and /v1/chat/completions) and group sync."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from typing import Any

from . import TIER_ORDER
from .config import is_loopback_url, require_subscription

_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0


def build_magpie_cli_env() -> dict[str, str]:
    """Return environment for Magpie CLI with proxy vars stripped so local RPC does not stall."""
    env = dict(os.environ)
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        env.pop(key, None)
    env["NO_PROXY"] = "127.0.0.1,localhost,::1"
    env["no_proxy"] = "127.0.0.1,localhost,::1"
    return env


class MagpieRequestError(RuntimeError):
    """Structured error raised when a Magpie HTTP or CLI operation fails."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        model: str = "",
        endpoint: str = "",
        detail: str = "",
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.model = model
        self.endpoint = endpoint
        self.detail = detail


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def build_opener(url: str) -> urllib.request.OpenerDirector:
    """Return an HTTP opener that bypasses system/clash proxies for loopback URLs."""
    if is_loopback_url(url):
        return urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    return urllib.request.build_opener(NoRedirect())


def _http_json(
    url: str,
    *,
    api_key: str,
    payload: dict[str, Any] | None = None,
    timeout_sec: int = 180,
    model: str = "",
) -> dict[str, Any]:
    headers = {"Accept": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    data_bytes: bytes | None = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    req = urllib.request.Request(url, data=data_bytes, headers=headers, method="POST" if payload is not None else "GET")
    opener = build_opener(url)
    try:
        with opener.open(req, timeout=timeout_sec) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", errors="replace")[:800]
        except Exception:
            pass
        raise MagpieRequestError(
            f"Magpie HTTP {exc.code} at {url} for model '{model or '-'}': {body or exc.reason}",
            status_code=exc.code,
            model=model,
            endpoint=url,
            detail=body,
        ) from exc
    except urllib.error.URLError as exc:
        raise MagpieRequestError(
            f"Cannot reach Magpie at {url}: {exc.reason}",
            model=model,
            endpoint=url,
            detail=str(exc.reason),
        ) from exc
    except TimeoutError as exc:
        raise MagpieRequestError(
            f"Magpie request timed out after {timeout_sec}s at {url} (model '{model}')",
            model=model,
            endpoint=url,
            detail="timeout",
        ) from exc

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise MagpieRequestError(
            f"Magpie returned non-JSON from {url}: {raw[:300]}",
            model=model,
            endpoint=url,
            detail=raw[:300],
        ) from exc
    if not isinstance(parsed, dict):
        raise MagpieRequestError(f"Unexpected JSON type from {url}: {type(parsed).__name__}", model=model, endpoint=url)
    return parsed


def _extract_responses_text(data: dict[str, Any]) -> str:
    direct = data.get("output_text")
    if isinstance(direct, str) and direct.strip():
        return direct.strip()

    chunks: list[str] = []
    for item in data.get("output") or []:
        if not isinstance(item, dict):
            continue
        item_text = item.get("text")
        if isinstance(item_text, str) and item_text.strip():
            chunks.append(item_text.strip())
        for block in item.get("content") or []:
            if not isinstance(block, dict):
                continue
            b_type = block.get("type")
            if b_type in {"output_text", "text", None}:
                text_val = block.get("text")
                if isinstance(text_val, str) and text_val.strip():
                    chunks.append(text_val.strip())
    return "\n\n".join(chunks).strip()


def _extract_chat_text(data: dict[str, Any]) -> str:
    choices = data.get("choices") or []
    if not choices or not isinstance(choices[0], dict):
        return ""
    msg = choices[0].get("message") or {}
    content = msg.get("content")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "\n".join(parts).strip()
    return ""


def call_responses(
    *,
    base_url: str,
    api_key: str,
    model: str,
    messages: list[dict[str, str]],
    reasoning_effort: str = "",
    instructions: str = "",
    max_output_tokens: int = 16384,
    timeout_sec: int = 180,
) -> dict[str, Any]:
    """Call Magpie /v1/responses endpoint and extract text + usage."""
    url = base_url.rstrip("/") + "/v1/responses"
    payload: dict[str, Any] = {
        "model": model,
        "input": messages,
        "max_output_tokens": max_output_tokens,
    }
    if instructions.strip():
        payload["instructions"] = instructions.strip()
    if reasoning_effort and reasoning_effort != "none":
        payload["reasoning"] = {"effort": reasoning_effort}

    data = _http_json(url, api_key=api_key, payload=payload, timeout_sec=timeout_sec, model=model)
    if data.get("error"):
        raise MagpieRequestError(f"Model error from {model}: {data['error']}", model=model, endpoint=url, detail=str(data["error"]))

    text = _extract_responses_text(data)
    usage = data.get("usage") or {}
    if not text:
        incomplete = data.get("incomplete_details") or {}
        r_tokens = (usage.get("output_tokens_details") or {}).get("reasoning_tokens")
        raise MagpieRequestError(
            f"Empty output from '{model}' on /v1/responses (status={data.get('status')}, "
            f"incomplete={incomplete}, reasoning_tokens={r_tokens}). Try increasing max_output_tokens.",
            model=model,
            endpoint=url,
            detail=json.dumps({"status": data.get("status"), "incomplete": incomplete, "usage": usage}),
        )

    return {
        "text": text,
        "served_model": str(data.get("model") or model),
        "usage": usage,
        "response_id": data.get("id"),
        "raw_status": data.get("status"),
    }


def call_chat(
    *,
    base_url: str,
    api_key: str,
    model: str,
    messages: list[dict[str, str]],
    reasoning_effort: str = "",
    instructions: str = "",
    max_output_tokens: int = 16384,
    timeout_sec: int = 180,
) -> dict[str, Any]:
    """Call Magpie /v1/chat/completions endpoint and extract text + usage."""
    url = base_url.rstrip("/") + "/v1/chat/completions"
    full_messages = list(messages)
    if instructions.strip():
        full_messages = [{"role": "system", "content": instructions.strip()}, *full_messages]
    payload: dict[str, Any] = {
        "model": model,
        "messages": full_messages,
        "max_tokens": max_output_tokens,
    }
    if reasoning_effort and reasoning_effort != "none":
        payload["reasoning_effort"] = reasoning_effort

    data = _http_json(url, api_key=api_key, payload=payload, timeout_sec=timeout_sec, model=model)
    if data.get("error"):
        raise MagpieRequestError(f"Model error from {model}: {data['error']}", model=model, endpoint=url, detail=str(data["error"]))

    text = _extract_chat_text(data)
    usage = data.get("usage") or {}
    choices = data.get("choices") or []
    finish_reason = choices[0].get("finish_reason") if choices and isinstance(choices[0], dict) else None
    if not text:
        r_tokens = (usage.get("completion_tokens_details") or {}).get("reasoning_tokens")
        raise MagpieRequestError(
            f"Empty output from '{model}' on /v1/chat/completions (finish_reason={finish_reason}, "
            f"reasoning_tokens={r_tokens}). Try increasing max_output_tokens.",
            model=model,
            endpoint=url,
            detail=json.dumps({"finish_reason": finish_reason, "usage": usage}),
        )

    return {
        "text": text,
        "served_model": str(data.get("model") or model),
        "usage": usage,
        "response_id": data.get("id"),
        "raw_status": finish_reason,
    }


def consult_with_fallback(
    *,
    base_url: str,
    api_key: str,
    primary_model: str,
    fallback_models: list[str] | None,
    api_mode: str,
    messages: list[dict[str, str]],
    reasoning_effort: str = "",
    instructions: str = "",
    max_output_tokens: int = 16384,
    timeout_sec: int = 180,
) -> dict[str, Any]:
    """Execute a consult call against primary_model, trying only user-configured fallbacks if primary fails."""
    candidates = [primary_model]
    for fb in fallback_models or []:
        if fb and fb not in candidates:
            candidates.append(fb)

    caller = call_responses if api_mode == "responses" else call_chat
    attempts: list[dict[str, Any]] = []
    t0 = time.monotonic()

    for idx, candidate in enumerate(candidates):
        try:
            res = caller(
                base_url=base_url,
                api_key=api_key,
                model=candidate,
                messages=messages,
                reasoning_effort=reasoning_effort,
                instructions=instructions,
                max_output_tokens=max_output_tokens,
                timeout_sec=timeout_sec,
            )
            res["elapsed_sec"] = time.monotonic() - t0
            res["requested_model"] = primary_model
            res["attempts"] = attempts + [{"model": candidate, "ok": True}]
            res["used_fallback"] = idx > 0
            return res
        except MagpieRequestError as exc:
            attempts.append({"model": candidate, "ok": False, "error": str(exc), "status_code": exc.status_code})

    summary = "; ".join(f"{a['model']}: {a['error']}" for a in attempts)
    raise MagpieRequestError(f"All configured models failed for consult: {summary}", model=primary_model, detail=summary)


def _normalize_group_member(model_id: str) -> str:
    """Convert auto/<slug> into group/auto-<slug> when passed as a nested group member."""
    m = model_id.strip()
    if m.startswith("auto/"):
        slug = m[len("auto/") :].replace(".", "-")
        return f"group/auto-{slug}"
    return m


def _group_command(argv: list[str], *, missing: str = "", timeout: int = 60) -> str | None:
    proc = subprocess.run(argv, env=build_magpie_cli_env(), stdin=subprocess.DEVNULL,
                          capture_output=True, text=True, encoding="utf-8", errors="replace",
                          timeout=timeout, creationflags=_CREATE_NO_WINDOW)
    if proc.returncode:
        detail = (proc.stderr or proc.stdout).strip()
        if missing and detail.startswith(f'magpie: no group "{missing}"'):
            return None
        raise MagpieRequestError(f"Magpie group command failed: {detail}")
    return proc.stdout


def _group_members(report: str) -> list[str]:
    section = re.search(r"(?m)^\s*models[ \t]+([^\n]+(?:\n[ \t]+\d+[ \t]+[^\n]+)*)", report)
    if not section:
        return []
    members: list[str] = []
    for line in section[1].splitlines():
        match = re.match(r"^\s*\d+\s+(\S+)", line)
        if match:
            members.append(match[1])
    return members


def _group_rules(report):
    return re.findall(r"^\s*(?:rules\s+)?\d+\s+(.+ → .+)$", report, re.MULTILINE)


def verify_subscription_group(cfg, group_id):
    from . import DEFAULT_MAGPIE_URL
    from .discover import find_magpie_cli
    if cfg["magpie"]["base_url"].rstrip("/") != DEFAULT_MAGPIE_URL:
        raise MagpieRequestError("Cannot attest remote subscription group from local CLI")
    exe = find_magpie_cli(cfg["magpie"].get("cli_path") or "")
    if not exe:
        raise MagpieRequestError("Subscription group verification requires Magpie CLI")
    report = _group_command([exe, "group", "show", group_id.removeprefix("group/")])
    # Fail closed on patterns, nested groups and unknown member display formats.
    section = re.search(r"(?m)^\s*models[ \t]+([^\n]+(?:\n[ \t]+\d+[ \t]+[^\n]+)*)", report)
    if not section:
        raise MagpieRequestError("Could not verify subscription group members")
    members = []
    for line in section[1].splitlines():
        row = re.fullmatch(r"\s*\d+\s+(\S+)\s+.+ · .+", line)
        if not row:
            raise MagpieRequestError("Unrecognized group member")
        members.append(row[1])
    require_subscription(members)
    require_subscription([rule.split(" → ")[-1] for rule in _group_rules(report)])


def _sync_group(exe, name, members, strategy, note, commands):
    show = [exe, "group", "show", name]
    report = _group_command(show, missing=name)
    writes = 0
    if report is None:
        _group_command(commands[0])
        writes += 1
        report = _group_command(show)
    if not re.search(r"^\s*note\s+" + re.escape(note) + r"\s*$", report, re.MULTILINE):
        raise MagpieRequestError(f"Existing group {name} has a different owner; sync stopped.")
    current = _group_members(report)
    if not current:
        raise MagpieRequestError(f"Cannot read members for {name}")
    rules = _group_rules(report)
    if any(rule.split(" → ")[-1] not in members for rule in rules):
        raise MagpieRequestError(f"Changing members would invalidate existing rules on {name}")
    settings = {"routing": strategy, "stays": "session"}
    updates = [f"{key}={value}" for key, value in settings.items()
               if not re.search(r"^\s*" + key + r"\s+" + value + r"\s*$", report, re.MULTILINE)]
    if current != members:
        updates.append("models=" + ",".join(members))
    if updates:
        _group_command([exe, "group", "set", name, *updates])
        writes += 1
    expected = []
    for cmd in commands[1:]:
        condition = "compacting" if cmd[-1] == "compact" else "effort ≥ " + cmd[-1].split("=", 1)[1]
        rule = condition + " → " + cmd[-2].removeprefix("use=")
        expected.append(rule)
        if rule not in rules:
            if any(r.startswith(condition + " → ") for r in rules):
                raise MagpieRequestError(f"Conflicting {condition} rule on {name}")
            _group_command(cmd)
            writes += 1
    final = _group_command(show) if writes else report
    settings_ok = all(re.search(r"^\s*" + k + r"\s+" + v + r"\s*$", final, re.MULTILINE)
                      for k, v in settings.items())
    if not settings_ok or _group_members(final) != members or any(rule not in _group_rules(final) for rule in expected):
        raise MagpieRequestError(f"Group readback differs for {name}")
    return writes


def sync_magpie_groups(config, *, cli_path, dry_run=False):
    from .sessions import exclusive_operation, resolve_sessions_dir
    if dry_run:
        return _sync_magpie_groups(config, cli_path=cli_path, dry_run=True)
    with exclusive_operation(resolve_sessions_dir() / ".groups.lock"):
        return _sync_magpie_groups(config, cli_path=cli_path)


def _sync_magpie_groups(
    config: dict[str, Any],
    *,
    cli_path: str,
    dry_run: bool = False,
) -> list[dict[str, Any]]:
    """Create or update Magpie routing groups group/gempt-harness-{sonnet,opus,fable} via Magpie CLI."""
    if not cli_path and not dry_run:
        raise MagpieRequestError("Magpie CLI path not configured or discovered; cannot sync routing groups.")

    policy = config.get("routing_policy") or {}
    strategy = str(policy.get("magpie_group_strategy") or "order")
    tiers = config.get("tiers") or {}
    utility = config.get("utility") or {}
    utility_model = str(utility.get("model") or "").strip()
    use_compact = bool(utility.get("use_for_magpie_compact", True)) and bool(utility_model)
    utility_member = _normalize_group_member(utility_model) if use_compact else ""

    results: list[dict[str, Any]] = []
    exe = cli_path or "magpie"

    for tier_name in TIER_ORDER:
        tier = tiers.get(tier_name) or {}
        members: list[str] = []
        raw_members = tier.get("magpie_group_members") or []
        for item in raw_members:
            norm = _normalize_group_member(str(item))
            if norm and not norm.startswith("group/gempt-harness-") and norm not in members:
                members.append(norm)

        if not members:
            candidates = [
                str(tier.get("consult_model") or "").strip(),
                str(tier.get("escalate_model") or "").strip(),
                *[str(m).strip() for m in (tier.get("fallback_models") or [])],
            ]
            for cand in candidates:
                norm = _normalize_group_member(cand)
                if norm and not norm.startswith("group/gempt-harness-") and norm not in members:
                    members.append(norm)

        if not members:
            results.append(
                {
                    "tier": tier_name,
                    "group": f"group/gempt-harness-{tier_name}",
                    "skipped": True,
                    "reason": "no concrete member models",
                }
            )
            continue

        if policy.get("failover_mode") == "subscription_only":
            require_subscription(members)
            if not utility_member.startswith("codex/"):
                utility_member = ""
        if utility_member and utility_member not in members:
            members.append(utility_member)

        group_name = f"gempt-harness-{tier_name}"
        note = f"gempt {tier_name} ({tier.get('label', tier_name)})"
        commands: list[list[str]] = [
            [
                exe,
                "group",
                "add",
                group_name,
                f"models={','.join(members)}",
                f"routing={strategy}",
                "stays=session",
                f"note={note}",
            ],
        ]

        escalate_model = str(tier.get("escalate_model") or "").strip()
        primary_model = str(tier.get("consult_model") or "").strip()
        threshold = str(tier.get("escalate_effort_threshold") or "high").strip()
        if (
            tier_name == "opus"
            and escalate_model
            and escalate_model != primary_model
            and not escalate_model.startswith("group/gempt-harness-")
        ):
            commands.append(
                [
                    exe,
                    "group",
                    "rule",
                    "add",
                    group_name,
                    f"use={_normalize_group_member(escalate_model)}",
                    f"effort={threshold}",
                ]
            )

        if utility_member:
            commands.append(
                [
                    exe,
                    "group",
                    "rule",
                    "add",
                    group_name,
                    f"use={utility_member}",
                    "compact",
                ]
            )

        entry: dict[str, Any] = {
            "tier": tier_name,
            "group": f"group/{group_name}",
            "members": members,
            "commands": commands,
            "dry_run": dry_run,
        }
        if not dry_run:
            entry["writes"] = _sync_group(exe, group_name, members, strategy, note, commands)
            entry["ok"] = True
        results.append(entry)

    return results
