"""Give each Antigravity conversation the current assignment rule before inference."""
import json
import os
import re
import sys
from pathlib import Path


def native_family(name):
    # agy models lists the unsuffixed orchestrator as Carbon.
    if name == "gemini-pro-orchestrator":
        return "carbon"
    match = re.search(r"(?:^|[^a-z0-9])(hydrogen|neon|carbon)(?:$|[^a-z0-9])", str(name).lower())
    return match.group(1) if match else None


def tool_pairing(payload, family):
    result = {"decision": "allow"}
    call = payload.get("toolCall") or {}
    args = call.get("args") or {}
    if call.get("name") != "call_mcp_tool" or args.get("ServerName") != "gempt_gempt":
        return result
    if args.get("ToolName") not in ("gempt_dispatch", "gempt_consult", "gempt_exec"):
        return result
    task = args.get("Arguments")
    if not family or not isinstance(task, dict) or task.get("tier") or task.get("session_id"):
        return result
    # Workers receive the coordinator family from the board, including an unknown family.
    if task.get("role") not in (None, "solo", "coordinator", "narrator"):
        return result
    if task.get("gemini_family") != family:
        result["overwrite"] = {"Arguments": {**task, "gemini_family": family}}
    return result


def reminder(family):
    path = Path(os.environ.get("GEMPT_CONFIG") or Path.home() / ".config/gempt/config.json")
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
    response = tool_pairing(payload, family) if "toolCall" in payload else reminder(family)
    print(json.dumps(response))
