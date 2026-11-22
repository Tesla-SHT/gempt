"""Apply GemPT's assignment rules, live token-ratio telemetry, read-diet guardrail, and active conversation tracking."""
import json
import os
import re
import sys
import time
from pathlib import Path

if __name__ == "__main__":
    plugin = Path(__file__).resolve().parent
    runtime = plugin / "runtime"
    sys.path.insert(0, str(runtime if runtime.is_dir() else plugin.parent / "src"))

from gempt.host_context import context_path, update_host_context
from gempt.titles import explicit_title
from gempt.token_ratio import resolve_budget

_READ_TOOLS = {
    "read_file",
    "view_file",
    "view_file_outline",
    "view_code_item",
    "grep_search",
    "find_by_name",
    "list_dir",
}
_EXEMPT_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".ico", ".mp4", ".mov", ".webm", ".wav", ".mp3", ".pdf"}
_EXEMPT_PATH_PARTS = (
    "/.gemini/antigravity/brain/",
    "/.gemini/config/plugins/",
    "/.zcode/skills/",
    "/agent-skills/",
    "/.config/gempt/",
)


def native_family(name):
    # agy models lists the unsuffixed orchestrator as Carbon.
    if name == "gemini-pro-orchestrator":
        return "carbon"
    match = re.search(r"(?:^|[^a-z0-9])(hydrogen|neon|carbon)(?:$|[^a-z0-9])", str(name).lower())
    return match.group(1) if match else None


def _config_path() -> Path:
    return Path(os.environ.get("GEMPT_CONFIG") or context_path().with_name("config.json")).expanduser()


def _load_policy(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig")).get("routing_policy", {}) if path.is_file() else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _load_profiles() -> dict:
    profiles_file = Path(__file__).parent / "runtime/gempt/workload.json"
    if not profiles_file.is_file():
        profiles_file = Path(__file__).resolve().parent.parent / "src/gempt/workload.json"
    return json.loads(profiles_file.read_text(encoding="utf-8"))["profiles"]


def _guard_file(conversation: str) -> Path:
    safe = re.sub(r"[^a-zA-Z0-9._-]", "_", conversation)[:80] or "default"
    return _config_path().with_name("read-guard") / f"{safe}.json"


def _reset_read_guard(conversation: str | None) -> None:
    if not isinstance(conversation, str) or not conversation.strip():
        return
    try:
        p = _guard_file(conversation)
        if p.exists():
            p.unlink()
    except OSError:
        pass


def _bump_read_guard(conversation: str) -> int:
    try:
        p = _guard_file(conversation)
        p.parent.mkdir(parents=True, exist_ok=True)
        now = time.time()
        count = 0
        if p.is_file():
            data = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(data, dict) and (now - float(data.get("updated_at") or 0)) < 1800:
                count = int(data.get("count") or 0)
        count += 1
        p.write_text(json.dumps({"count": count, "updated_at": now}), encoding="utf-8")
        return count
    except (OSError, json.JSONDecodeError, ValueError):
        return 0


def _is_exempt_read(args: dict) -> bool:
    raw = str(args.get("Path") or args.get("AbsolutePath") or args.get("SearchPath") or args.get("DirectoryPath") or "").strip()
    if not raw:
        return False
    norm = raw.replace("\\", "/").lower()
    if norm.endswith("/skill.md") or norm == "skill.md":
        return True
    if any(part in norm for part in _EXEMPT_PATH_PARTS):
        return True
    suffix = Path(norm).suffix
    return suffix in _EXEMPT_EXTS


def _read_diet_nudge(conversation: str | None, tool_name: str, args: dict) -> str | None:
    if tool_name not in _READ_TOOLS or not isinstance(conversation, str) or not conversation.strip():
        return None
    if _is_exempt_read(args):
        return None
    cfg_path = _config_path()
    policy = _load_policy(cfg_path)
    profiles = _load_profiles()
    ordinary = policy.get("work_split", "balanced")
    plan = profiles.get(ordinary) or profiles["balanced"]
    if not plan["kinds"]:
        return None
    budget = resolve_budget(ordinary, policy=policy, config_path=cfg_path)
    target = int(budget.get("target_gpt_share") or 0)
    adj = str(budget.get("adjustment") or "balanced")
    if adj in ("widened_strong", "widened", "under_target") or target >= 80:
        threshold = 2
    elif target >= 50:
        threshold = 3
    else:
        threshold = 4
    count = _bump_read_guard(conversation)
    if count < threshold:
        return None
    actual = budget.get("actual_gpt_share")
    share_str = f"{actual:.1f}%" if isinstance(actual, (int, float)) else "warming up"
    kinds_str = "/".join(budget.get("effective_kinds") or plan["kinds"])
    return (
        f"[GemPT Context Diet] {count} consecutive workspace code reads in Gemini while 24h GPT token share is "
        f"{share_str} (target {target}%, active GPT kinds: {kinds_str}). Stop pre-reading repo files in Gemini — "
        "dispatch the investigation or edit directly via gempt_dispatch(cwd=..., access='inspect'|'change') "
        "or pass file_paths to gempt_consult so GPT reads the files and returns a concise brief."
    )


def pre_tool_use(payload, family):
    result = {"decision": "allow"}
    call = payload.get("toolCall") or {}
    args = call.get("args") or {}
    conversation = payload.get("conversationId")
    workspace = payload.get("workspacePaths")
    tool_name = call.get("name")
    if tool_name == "invoke_subagent" and args.get("TypeName") == "gempt-worker":
        update_host_context(conversation, workspace)
        _reset_read_guard(conversation)
        prompt = args.get("Prompt")
        if (isinstance(conversation, str) and conversation.strip() and isinstance(prompt, str)
                and not any(line.startswith("GemPT metadata: ") for line in prompt.splitlines())):
            meta = {"host_conversation_id": conversation, "title": explicit_title(args.get("Role"))}
            result["overwrite"] = {"Prompt": prompt + "\nGemPT metadata: " + json.dumps(meta, ensure_ascii=False)}
        return result
    if tool_name != "call_mcp_tool" or args.get("ServerName") != "gempt_gempt":
        nudge = _read_diet_nudge(conversation, str(tool_name or ""), args)
        if nudge:
            result["injectSteps"] = [{"ephemeralMessage": nudge}]
        return result
    tool = args.get("ToolName")
    if tool in ("gempt_dispatch", "gempt_exec", "gempt_consult"):
        _reset_read_guard(conversation)
    task = args.get("Arguments")
    if task is None:
        task = {}
    if not isinstance(task, dict):
        return result
    updates = {}
    if isinstance(conversation, str) and conversation.strip() and tool in ("gempt_dispatch", "gempt_exec", "gempt_live_view", "gempt_status"):
        parent = task.get("host_conversation_id")
        if not parent and (tool != "gempt_status" or not task.get("run_id")):
            updates["host_conversation_id"] = conversation
        elif isinstance(parent, str) and parent != conversation and tool not in ("gempt_live_view", "gempt_status"):
            update_host_context(conversation, workspace, parent_id=parent)
    # Workers receive the coordinator family from the board, including an unknown family.
    if (tool in ("gempt_dispatch", "gempt_consult", "gempt_exec") and family
            and not task.get("tier") and not task.get("session_id")
            and task.get("role") in (None, "solo", "coordinator", "narrator") and task.get("gemini_family") != family):
        updates["gemini_family"] = family
    if updates:
        result["overwrite"] = {"Arguments": {**task, **updates}}
    return result


def _budget_note(ordinary: str, policy: dict, cfg_path: Path) -> str:
    budget = resolve_budget(ordinary, policy=policy, config_path=cfg_path)
    target = int(budget.get("target_gpt_share") or 0)
    if target <= 0:
        return ""
    actual = budget.get("actual_gpt_share")
    actual_gem = budget.get("actual_gemini_share")
    adj = str(budget.get("adjustment") or "balanced")
    kinds_str = "/".join(budget.get("effective_kinds") or [])
    if isinstance(actual, (int, float)) and isinstance(actual_gem, (int, float)):
        telemetry = f"Live 24h token split: Gemini {actual_gem:.1f}% vs GPT {actual:.1f}% (target GPT {target}%, status={adj}, active GPT kinds: {kinds_str})."
    else:
        telemetry = f"Dynamic token budget active (target GPT {target}%, active GPT kinds: {kinds_str})."
    if adj in ("widened_strong", "widened", "under_target"):
        diet = (" GPT is below target — ZERO-PRE-READ: do NOT read source files, grep the repo, or run exploratory "
                "commands in Gemini first; dispatch goal + cwd (or file_paths) directly to GPT via gempt_dispatch "
                "so GPT does the reading, editing, and verification.")
    else:
        diet = (" ZERO-PRE-READ: for tasks routed to GPT, dispatch directly with goal + cwd (or file_paths) "
                "without pre-reading source files in Gemini first.")
    return " " + telemetry + diet


def reminder(family):
    path = _config_path()
    policy = _load_policy(path)
    profiles = _load_profiles()
    ordinary = policy.get("work_split", "balanced")
    team = policy.get("swarm_split", "inherit")
    if team == "inherit":
        team = ordinary
    ordinary_off = not profiles[ordinary]["kinds"]
    swarm_off = not profiles[team]["kinds"]
    delegate = ('For each new task assigned to GPT by the ordinary work split, call gempt_dispatch directly '
                '(goal, kind, access, cwd, short title; pass background=true for long or parallel runs and '
                'workspace="share" for concurrent repo edits). Run the returned wait_command (or --run-ids ... --wait '
                'for batches) via run_command(WaitMsBeforeAsync=500) for zero-poll wakeup. Reuse session_id to continue '
                'a GPT thread, call gempt_status() for this conversation roster, and use gempt_steer/gempt_interrupt/'
                'gempt_reply_tool_call directly.')
    swarm_roles = ("In /swarm the coordinator briefs one owner per 32-hex assignment_id. Each worker and "
                   "independent verifier first calls gempt_dispatch with goal, kind, access, role and that ID. "
                   "Coordinator and narrator stay on the board.")
    no_delegation = "Do not call gempt_dispatch"
    direct = "Handle tasks directly in Gemini unless the user explicitly asks to invoke GPT."
    if ordinary_off and swarm_off:
        message = f"GemPT is OFF for ordinary conversations and Swarm. {no_delegation}. {direct}"
    elif ordinary_off:
        message = (f"GemPT is OFF for ordinary conversations. {no_delegation} in ordinary conversations. "
                   f"{direct} GemPT remains active in Swarm: {profiles[team]['detail']} "
                   f"In Swarm only: {swarm_roles} Explain the result in the user's language.")
    elif swarm_off:
        message = (f"GemPT is OFF for Swarm. {no_delegation} in Swarm. "
                   f"{direct} GemPT remains active in ordinary conversations: {profiles[ordinary]['detail']}"
                   f"{_budget_note(ordinary, policy, path)} "
                   f"In ordinary conversations only: {delegate} Explain the result in the user's language.")
    else:
        message = (f"GemPT ordinary: {profiles[ordinary]['detail']}{_budget_note(ordinary, policy, path)}  "
                   f"Swarm: {profiles[team]['detail']} "
                   f"In ordinary conversations: {delegate} {swarm_roles} Explain the result in the user's language.")
    if family and not (ordinary_off and swarm_off):
        message += f" Current native gemini_family={family}."
        if swarm_off:
            message += " Include that family in ordinary GemPT calls."
        else:
            scope = "Swarm GemPT calls" if ordinary_off else "GemPT calls"
            message += (f" Include that family in {scope} and in each coordinator brief. Workers and verifiers "
                        "must use only the coordinator family from their brief, omitting gemini_family if the brief has none.")
    return {"injectSteps": [{"ephemeralMessage": message}]}


if __name__ == "__main__":
    payload = json.load(sys.stdin.buffer)
    family = native_family(payload.get("modelName"))
    if "toolCall" in payload:
        response = pre_tool_use(payload, family)
    else:
        update_host_context(payload.get("conversationId"), payload.get("workspacePaths"))
        response = reminder(family)
    print(json.dumps(response))
