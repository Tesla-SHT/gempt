"""Apply the user's work split at dispatch time, including fresh Swarm workers."""
import re

from .config import WORKLOAD, load_config
from .runs import ACTIVE_STATES, build_wait_command, dispatch_exec
from .service import run_consult
from .sessions import resolve_sessions_dir

SCHEMA = WORKLOAD["schema"]


def dispatch_task(args, config_path, *, wait_sec: float | None = None):
    goal = args.get("goal")
    if not isinstance(goal, str) or not goal.strip():
        raise ValueError("A task goal is required.")
    kind, access, role = args.get("kind"), args.get("access"), args.get("role", "solo")
    for key, value in (("kind", kind), ("access", access), ("role", role)):
        if value not in SCHEMA["properties"][key]["enum"]:
            raise ValueError(f"Invalid {key}: {value}")
    cfg, _ = load_config(explicit=config_path, require_exists=False)
    policy = cfg["routing_policy"]
    profile = policy.get("work_split", "balanced")
    if role != "solo" and policy.get("swarm_split", "inherit") != "inherit":
        profile = policy["swarm_split"]
    plan = WORKLOAD["profiles"][profile]
    result = {"profile": profile, "role": role, "kind": kind}
    if not plan["kinds"]:
        return {**result, "action": "gemini", "disabled": True,
                "text": "GemPT automatic delegation is off. Handle this task directly in Gemini."}
    if role in ("coordinator", "narrator"):
        return {**result, "action": "board", "text": "Keep this role on the Swarm board. Assign each work item to one named owner. Summarize board evidence for the user."}
    if kind == "visual" and access == "change":
        raise ValueError("Separate visual observation from the implementation assignment.")
    action = "consult" if access == "provided" else "exec"
    if action == "exec" and not args.get("cwd"):
        raise ValueError("Workspace work requires cwd.")
    if role == "verifier" and access == "change":
        raise ValueError("The independent verifier inspects evidence. Return fixes to the owning worker.")
    if role in ("worker", "verifier"):
        assignment = args.get("assignment_id", "")
        if not isinstance(assignment, str) or not re.fullmatch("[a-f0-9]{32}", assignment):
            raise ValueError("Use the coordinator's unique 32-hex assignment_id from the board.")
        claims = resolve_sessions_dir() / "swarm-claims"
        claims.mkdir(parents=True, exist_ok=True)
        try:
            (claims / assignment).mkdir()
        except FileExistsError:
            return {**result, "action": "already_assigned", "text": "Check this assignment on the board with its owner before retrying."}
    if kind not in plan["kinds"]:
        return {**result, "action": "gemini", "text": "Handle this part in Gemini. Report to the board if assigned there."}

    options = {"goal": goal, "config_path": config_path, "tier": args.get("tier"), "cwd": args.get("cwd")}
    for field in ("session_id", "context", "file_paths", "title", "host_conversation_id"):
        if args.get(field) is not None:
            options[field] = args[field]
    if args.get("gemini_family"):
        options["gemini_family"] = args["gemini_family"]
    if action == "consult":
        reply = run_consult(**options, expected_output=WORKLOAD["report"])
    else:
        reply = dispatch_exec(**options, sandbox="read-only" if access == "inspect" else None,
                              verification=args.get("verification", ""), expected_report=WORKLOAD["report"],
                              wait_sec=wait_sec)
        if reply.get("state") in ACTIVE_STATES | {"interrupted"}:
            run_id, state = reply["run_id"], reply["state"]
            return {**result, "action": action, **reply,
                    "wait_command": build_wait_command(run_id),
                    "text": (f"Run {run_id} is waiting for a reply to ask_gemini." if state == "waiting_gemini"
                             else f"Run {run_id} is {state}. Query gempt_status with run_id='{run_id}'.")}
    fields = ("model", "served_model", "session_id", "run_id", "verification", "usage", "warnings", "text")
    receipt = {key: reply[key] for key in fields if key in reply}
    if "verification" in receipt:
        evidence = receipt["verification"]
        receipt["verification"] = {
            "status": evidence.get("status"),
            "checks": [{key: check.get(key) for key in ("command", "exit_code")} for check in evidence.get("checks", [])],
        }
    return {**result, "action": action, **receipt}
