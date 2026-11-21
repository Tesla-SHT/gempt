"""Apply GemPT's assignment rules and track the active Antigravity conversation."""
import json
import os
import re
import sys
from pathlib import Path

if __name__ == "__main__":
    plugin = Path(__file__).resolve().parent
    runtime = plugin / "runtime"
    sys.path.insert(0, str(runtime if runtime.is_dir() else plugin.parent / "src"))

from gempt.host_context import context_path, update_host_context
from gempt.titles import explicit_title


def native_family(name):
    # agy models lists the unsuffixed orchestrator as Carbon.
    if name == "gemini-pro-orchestrator":
        return "carbon"
    match = re.search(r"(?:^|[^a-z0-9])(hydrogen|neon|carbon)(?:$|[^a-z0-9])", str(name).lower())
    return match.group(1) if match else None


def pre_tool_use(payload, family):
    result = {"decision": "allow"}
    call = payload.get("toolCall") or {}
    args = call.get("args") or {}
    conversation = payload.get("conversationId")
    workspace = payload.get("workspacePaths")
    if call.get("name") == "invoke_subagent" and args.get("TypeName") == "gempt-worker":
        update_host_context(conversation, workspace)
        prompt = args.get("Prompt")
        if (isinstance(conversation, str) and conversation.strip() and isinstance(prompt, str)
                and not any(line.startswith("GemPT metadata: ") for line in prompt.splitlines())):
            meta = {"host_conversation_id": conversation, "title": explicit_title(args.get("Role"))}
            result["overwrite"] = {"Prompt": prompt + "\nGemPT metadata: " + json.dumps(meta, ensure_ascii=False)}
        return result
    if call.get("name") != "call_mcp_tool" or args.get("ServerName") != "gempt_gempt":
        return result
    tool = args.get("ToolName")
    task = args.get("Arguments")
    if task is None:
        task = {}
    if not isinstance(task, dict):
        return result
    updates = {}
    if isinstance(conversation, str) and conversation.strip() and tool in ("gempt_dispatch", "gempt_exec", "gempt_live_view"):
        parent = task.get("host_conversation_id")
        if not parent:
            updates["host_conversation_id"] = conversation
        elif isinstance(parent, str) and parent != conversation and tool != "gempt_live_view":
            update_host_context(conversation, workspace, parent_id=parent)
    # Workers receive the coordinator family from the board, including an unknown family.
    if (tool in ("gempt_dispatch", "gempt_consult", "gempt_exec") and family
            and not task.get("tier") and not task.get("session_id")
            and task.get("role") in (None, "solo", "coordinator", "narrator") and task.get("gemini_family") != family):
        updates["gemini_family"] = family
    if updates:
        result["overwrite"] = {"Arguments": {**task, **updates}}
    return result


def reminder(family):
    path = Path(os.environ.get("GEMPT_CONFIG") or context_path().with_name("config.json")).expanduser()
    policy = json.loads(path.read_text(encoding="utf-8-sig")).get("routing_policy", {}) if path.is_file() else {}
    profiles_file = Path(__file__).parent / "runtime/gempt/workload.json"
    profiles = json.loads(profiles_file.read_text(encoding="utf-8"))["profiles"]
    ordinary = policy.get("work_split", "balanced")
    team = policy.get("swarm_split", "inherit")
    if team == "inherit":
        team = ordinary
    ordinary_off = not profiles[ordinary]["kinds"]
    swarm_off = not profiles[team]["kinds"]
    delegate = ('Main Gemini delegates each new substantive task, including consultation and workspace work, '
                'via invoke_subagent(TypeName="gempt-worker", Model="inherit", Role=..., Prompt=..., Workspace=...). '
                'Continue the task with send_message to the same subagent for follow-ups, progress, steering or '
                'ask_gemini replies. The gempt-worker itself calls gempt_dispatch with goal, kind and access.')
    swarm_roles = ("In /swarm the coordinator briefs one owner per 32-hex assignment_id. Each worker and "
                   "independent verifier first calls gempt_dispatch with goal, kind, access, role and that ID. "
                   "Coordinator and narrator stay on the board.")
    no_delegation = "Do not invoke gempt-worker or call gempt_dispatch"
    direct = "Handle tasks directly in Gemini unless the user explicitly asks to invoke GPT."
    if ordinary_off and swarm_off:
        message = f"GemPT is OFF for ordinary conversations and Swarm. {no_delegation}. {direct}"
    elif ordinary_off:
        message = (f"GemPT is OFF for ordinary conversations. {no_delegation} in ordinary conversations. "
                   f"{direct} GemPT remains active in Swarm: {profiles[team]['detail']} "
                   f"In Swarm only: {swarm_roles} Explain the result in the user's language.")
    elif swarm_off:
        message = (f"GemPT is OFF for Swarm. {no_delegation} in Swarm. "
                   f"{direct} GemPT remains active in ordinary conversations: {profiles[ordinary]['detail']} "
                   f"In ordinary conversations only: {delegate} Explain the result in the user's language.")
    else:
        message = (f"GemPT ordinary: {profiles[ordinary]['detail']}  Swarm: {profiles[team]['detail']} "
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
