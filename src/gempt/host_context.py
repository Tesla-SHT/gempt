"""Local context shared by the Antigravity hook and GemPT Live."""

import json
import os
import time
from pathlib import Path

from . import DEFAULT_CONFIG_PATH
from .sessions import atomic_json, exclusive_operation


def context_path(config=None):
    return Path(config or os.environ.get("GEMPT_CONFIG") or DEFAULT_CONFIG_PATH).expanduser().parent / "host-context.json"


def read_host_context(config=None):
    try:
        data = json.loads(context_path(config).read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except (OSError, RuntimeError, ValueError):
        pass
    return {}


def update_host_context(conversation_id, workspace_paths, *, parent_id=None, gemini_family=None):
    """Record the active main conversation or register a child from its dispatch."""
    if not isinstance(conversation_id, str) or not conversation_id.strip():
        return
    for attempt in range(3):
        try:
            path = context_path()
            with exclusive_operation(path.with_suffix(".lock")):
                data = read_host_context()
                entries = data.get("subagent_conversations")
                children = {item for item in entries if isinstance(item, str)} if isinstance(entries, list) else set()
                active = data.get("conversation_id")
                workspace = [item for item in workspace_paths if isinstance(item, str)] if isinstance(workspace_paths, list) else []
                if parent_id:
                    children.add(conversation_id)
                    if active == conversation_id or not active:
                        # A child's first PreInvocation can arrive before its first dispatch identifies it.
                        previous = data.pop("previous_context", {})
                        if isinstance(previous, dict) and previous.get("conversation_id") not in children:
                            active = previous.get("conversation_id")
                            workspace = previous.get("workspace_paths") or []
                        else:
                            active, workspace = None, []
                        data.update(conversation_id=active or parent_id, workspace_paths=workspace)
                elif conversation_id not in children:
                    if isinstance(active, str) and active and active != conversation_id:
                        data["previous_context"] = {"conversation_id": active, "workspace_paths": data.get("workspace_paths", [])}
                    data.update(conversation_id=conversation_id, workspace_paths=workspace)
                else:
                    return
                if isinstance(gemini_family, str) and gemini_family.strip():
                    data["gemini_family"] = gemini_family.strip()
                data.update(updated_at=time.time(), subagent_conversations=sorted(children))
                atomic_json(path, data)
                return
        except (RuntimeError, PermissionError):
            if attempt < 2:
                time.sleep(0.02)
        except (OSError, ValueError, TypeError):
            return
