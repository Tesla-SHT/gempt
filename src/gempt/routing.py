"""Deterministic, auditable effort routing, timeout floors, and escalation hints."""

from __future__ import annotations

import re
from typing import Any

AUTO_EFFORT_CANDIDATES = ("low", "medium", "high", "xhigh")

EFFORT_EXEC_TIMEOUT_SEC: dict[str, int] = {
    "none": 300,
    "minimal": 300,
    "low": 450,
    "medium": 600,
    "high": 900,
    "xhigh": 1200,
    "max": 1200,
    "ultra": 1200,
}

EFFORT_CONSULT_TIMEOUT_SEC: dict[str, int] = {
    "none": 120,
    "minimal": 120,
    "low": 150,
    "medium": 180,
    "high": 240,
    "xhigh": 300,
    "max": 300,
    "ultra": 300,
}

TIER_DEFAULT_EFFORTS: dict[str, str] = {
    "sonnet": "medium",
    "opus": "high",
    "fable": "xhigh",
}

_TIER_BASE_SCORES: dict[str, int] = {
    "sonnet": 1,
    "opus": 3,
    "fable": 6,
}

_SIGNAL_RULES: tuple[tuple[int, str, re.Pattern[str]], ...] = (
    (
        3,
        "architecture_concurrency",
        re.compile(
            r"(?:architect(?:ure|ural)?|migration|state machine|concurren(?:cy|t)|deadlock|race condition|distributed|consensus|架构|状态机|并发|死锁|竞态|迁移)",
            re.IGNORECASE,
        ),
    ),
    (
        3,
        "math_algorithm",
        re.compile(
            r"(?:algorithm|proof|theorem|optimi[zs](?:e|ation)|convergen(?:ce|t)|gradient|solver|invariant|math(?:ematic)?|complexity|算法|数学|推导|证明|收敛|求解|不变量)",
            re.IGNORECASE,
        ),
    ),
    (
        2,
        "security_boundary",
        re.compile(
            r"(?:security|auth(?:entication|orization)?|sandbox|crypto|permission|privilege|traversal|bypass|vulnerabilit(?:y|ies)|安全|权限|沙箱|鉴权|漏洞)",
            re.IGNORECASE,
        ),
    ),
    (
        2,
        "deep_debugging",
        re.compile(
            r"(?:debug(?:ging)?|root cause|flaky|regression|memory leak|oom|segfault|traceback|stack trace|根因|疑难|偶现|内存泄漏|回归)",
            re.IGNORECASE,
        ),
    ),
    (
        2,
        "multi_file_refactor",
        re.compile(
            r"(?:refactor|cross-file|cross-module|across files|multi-file|重构|跨文件|跨模块|全链路)",
            re.IGNORECASE,
        ),
    ),
    (
        1,
        "performance",
        re.compile(
            r"(?:performance|latency|throughput|benchmark|bottleneck|性能|延迟|吞吐)",
            re.IGNORECASE,
        ),
    ),
    (
        -2,
        "trivial_routine",
        re.compile(
            r"(?:typo|rename|comment|docstring|format(?:ting)?|lint|readme|changelog|translat(?:e|ion)|boilerplate|trivial|注释|改名|拼写|格式化|翻译|文档|模板代码)",
            re.IGNORECASE,
        ),
    ),
    (
        -1,
        "simple_small",
        re.compile(
            r"(?:simple|quick|minor|small fix|one-line|status check|简单|微调|小修)",
            re.IGNORECASE,
        ),
    ),
)


def is_astra_model(model_id: str | None) -> bool:
    """Return True if the target model identifier is an Astra-class model."""
    return "astra" in str(model_id or "").lower()


def effort_timeout_floor(effort: str | None, *, mode: str = "exec") -> int:
    """Return the minimum recommended timeout seconds for a given reasoning effort."""
    key = str(effort or "medium").strip().lower()
    table = EFFORT_CONSULT_TIMEOUT_SEC if mode == "consult" else EFFORT_EXEC_TIMEOUT_SEC
    fallback = 180 if mode == "consult" else 600
    return table.get(key, fallback)


def classify_task_effort(
    *,
    tier: str,
    tier_default_effort: str,
    model_id: str = "",
    escalate: bool = False,
    goal: str = "",
    context: str = "",
    constraints: str = "",
    file_count: int = 0,
    is_resume: bool = False,
) -> dict[str, Any]:
    """Deterministically select reasoning effort for fresh threads.

    Returns an auditable classification dictionary:
      - Disabled for `chore` and `is_resume=True` (prevents mid-thread effort drift).
      - Bounded within `low..xhigh` (`ultra`/`max` never selected automatically).
      - Floors Astra / `fable` at `high` (never `low` or `medium`).
    """
    clean_tier = str(tier or "sonnet").strip().lower() or "sonnet"
    base_effort = str(tier_default_effort or TIER_DEFAULT_EFFORTS.get(clean_tier, "medium")).strip().lower()

    if clean_tier == "chore":
        return {
            "tier": "chore",
            "effort": base_effort or "low",
            "score": 0,
            "base_score": 0,
            "signals": ["chore_fixed"],
            "auto_applied": False,
            "clamped": False,
            "reason": "chore_tier_fixed",
        }

    if is_resume:
        return {
            "tier": clean_tier,
            "effort": base_effort,
            "score": 0,
            "base_score": _TIER_BASE_SCORES.get(clean_tier, 1),
            "signals": ["resume_locked"],
            "auto_applied": False,
            "clamped": False,
            "reason": "resume_preserves_thread_effort",
        }

    base_score = _TIER_BASE_SCORES.get(clean_tier, 1)
    score = base_score
    signals: list[str] = [f"tier:{clean_tier}({base_score:+d})"]
    haystack = f"{goal}\n{context}\n{constraints}"

    for delta, name, pattern in _SIGNAL_RULES:
        if pattern.search(haystack):
            score += delta
            signals.append(f"{delta:+d}:{name}")

    if file_count >= 5:
        score += 2
        signals.append("+2:files>=5")
    elif file_count >= 3:
        score += 1
        signals.append("+1:files>=3")

    if len(goal.strip()) >= 260:
        score += 1
        signals.append("+1:long_goal")

    if escalate:
        score += 2
        signals.append("+2:escalate_requested")

    if score <= 0:
        candidate = "low"
    elif score <= 2:
        candidate = "medium"
    elif score <= 5:
        candidate = "high"
    else:
        candidate = "xhigh"

    clamped = False
    if (is_astra_model(model_id) or clean_tier == "fable") and candidate in {"none", "minimal", "low", "medium"}:
        candidate = "high"
        clamped = True
        signals.append("astra_floor:high")

    return {
        "tier": clean_tier,
        "effort": candidate,
        "score": score,
        "base_score": base_score,
        "signals": signals,
        "auto_applied": True,
        "clamped": clamped,
        "reason": "classified",
    }


def build_escalation_suggestion(
    *,
    mode: str,
    tier: str,
    effort: str,
    verification_status: str = "",
    timed_out: bool = False,
    error_message: str = "",
) -> str:
    """Recommend a fresh-thread escalation step after failure or unverified output."""
    needs_help = bool(timed_out or error_message or (mode == "exec" and verification_status in {"failed", "unverified"}))
    if not needs_help:
        return ""

    clean_tier = str(tier or "sonnet").strip().lower()
    clean_effort = str(effort or "medium").strip().lower()

    if clean_tier == "sonnet":
        return (
            "Retry in a fresh thread (omit session_id) with tier='opus' (Sol @ high) "
            "or tier='opus', escalate=true (Astra @ xhigh). Do not bump effort mid-thread on resume and avoid ultra."
        )
    if clean_tier == "opus" and clean_effort != "xhigh":
        return (
            "Retry in a fresh thread (omit session_id) with tier='opus', escalate=true "
            "(or tier='fable') for Astra @ xhigh. Do not bump effort mid-thread on resume and avoid ultra."
        )
    return (
        "Already at xhigh/fable; decompose into smaller verified steps or isolate root cause via gempt_consult "
        "before starting a fresh thread (omit session_id; avoid ultra)."
    )
