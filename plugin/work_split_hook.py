"""Give each Antigravity conversation the current assignment rule before inference."""
import json
import os
from pathlib import Path


def reminder():
    path = Path(os.environ.get("GEMPT_CONFIG") or Path.home() / ".config/gempt/config.json")
    if not path.is_file():
        return {}
    policy = json.loads(path.read_text(encoding="utf-8")).get("routing_policy", {})
    profiles_file = Path(__file__).parent / "runtime/gempt/workload.json"
    profiles = json.loads(profiles_file.read_text(encoding="utf-8"))["profiles"]
    ordinary = policy.get("work_split", "balanced")
    team = policy.get("swarm_split", "inherit")
    if team == "inherit":
        team = ordinary
    message = (f"GemPT ordinary: {profiles[ordinary]['detail']}  Swarm: {profiles[team]['detail']} "
               "For each new substantive assignment, first call gempt_dispatch with goal, kind and access. "
               "Do not pre-solve or repeat completed work. In /swarm the coordinator briefs one owner per "
               "32-hex assignment_id, workers and independent verifiers pass their role and that ID. "
               "Coordinator and narrator stay on the board. Explain the result in the user's language.")
    return {"injectSteps": [{"ephemeralMessage": message}]}


if __name__ == "__main__":
    print(json.dumps(reminder()))
