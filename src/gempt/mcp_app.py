"""GemPT Live resource and bounded snapshots of the Codex run journal."""

from __future__ import annotations

import json
import os
import re
import threading
import time
from collections import deque
from datetime import datetime
from functools import lru_cache
from itertools import count
from pathlib import Path
from typing import Any

from . import __version__
from .host_context import read_host_context
from .runs import ACTIVE_STATES, interrupt_run, read_run, run_directory, steer_run
from .sessions import resolve_sessions_dir
from .titles import workspace_name

APP_URI = "ui://gempt/live.html"
APP_RESOURCE = {
    "uri": APP_URI, "name": "GemPT Live", "mimeType": "text/html;profile=mcp-app",
    "_meta": {"ui": {"prefersBorder": False}},
}
_MAX_HTML = 10 * 1024 * 1024
_TEXT_BYTES = 96 * 1024
_GOAL_BYTES = 16 * 1024
_RUN_ID = {"type": "string", "pattern": "^[0-9a-f]{32}$"}
_SCOPE = {
    "host_conversation_id": {"type": "string", "description": "Antigravity conversation to bind to."},
    "scope": {"type": "string", "enum": ["session", "all"], "default": "session"},
}
_MAX_EVENTS = 200
_TEXT_REVISIONS = count(1)
_USAGE_FIELDS = {
    "inputTokens": "input_tokens",
    "outputTokens": "output_tokens",
    "cachedInputTokens": "cached_input_tokens",
    "totalTokens": "total_tokens",
    "reasoningOutputTokens": "reasoning_tokens",
}


def _tool(name, description, properties, *, required=()):
    schema = {"type": "object", "properties": properties, "additionalProperties": False}
    if required:
        schema["required"] = list(required)
    meta = {"ui": {"visibility": ["app"]}}
    if name == "gempt_live_view":
        meta = {
            "ui": {"resourceUri": APP_URI},
            "com.google.antigravity/ui": {"entrypoints": [
                {"type": surface, "title": "GemPT Live"} for surface in ("aux_pane", "global")
            ]},
        }
    return {"name": name, "description": description, "inputSchema": schema, "_meta": meta}


APP_TOOLS = {
    tool["name"]: tool for tool in (
        _tool("gempt_live_view", "Open GemPT Live to watch a Codex run.", {"run_id": _RUN_ID, **_SCOPE}),
        _tool("gempt_app_runs", "List runs in GemPT Live.",
              {"limit": {"type": "integer", "minimum": 1, "maximum": 50}, **_SCOPE}),
        _tool("gempt_app_stream", "Read a run snapshot or continue a long transcript.", {
            "run_id": _RUN_ID,
            "max_events": {"type": "integer", "minimum": 1, "maximum": _MAX_EVENTS},
            "text_offset": {"type": "integer", "minimum": 0},
            "text_revision": {"type": "integer", "minimum": 1},
            "goal_offset": {"type": "integer", "minimum": 0},
        }, required=("run_id",)),
        _tool("gempt_app_interrupt", "Interrupt the selected run.", {"run_id": _RUN_ID}, required=("run_id",)),
        _tool("gempt_app_steer", "Steer the selected run.",
              {"run_id": _RUN_ID, "message": {"type": "string"}}, required=("run_id", "message")),
    )
}


def read_app_resource():
    override = os.environ.get("GEMPT_APP_HTML")
    path = Path(override) if override else Path(__file__).with_name("mcp_app_live.html")
    with path.open("rb") as stream:
        raw = stream.read(_MAX_HTML)
    if len(raw) >= _MAX_HTML or not raw.strip():
        raise ValueError("GemPT Live HTML must be non-empty and smaller than 10 MiB.")
    return {"contents": [{**APP_RESOURCE, "text": raw.decode("utf-8")}]}


def _text(value, limit):
    return value[:limit] if isinstance(value, str) else ""


def _object(value):
    return value if isinstance(value, dict) else {}


def _array(value):
    return value if isinstance(value, list) else []


def _number(value):
    return value if type(value) in (int, float) and -1e18 <= value <= 1e18 else None


def _timestamp(value):
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except (ValueError, OSError, OverflowError):
            return None
    return _number(value)


def _usage(value):
    value = _object(value)
    return {key: value[key] for key in _USAGE_FIELDS.values()
            if type(value.get(key)) is int and 0 <= value[key] <= 2**63 - 1}


def _pending(value, *, compact=False):
    args = _object(value.get("arguments"))
    paths = _array(args.get("media_paths"))
    return {
        "call_id": _text(value.get("call_id"), 128),
        "tool": "ask_gemini",
        "arguments": {
            "reason": _text(args.get("reason"), 64),
            "question": _bounded_text(args.get("question"), 512 if compact else 8192),
            "context": _bounded_text(args.get("context"), 512 if compact else 16384),
            "media_paths": _within_budget((path for path in paths if isinstance(path, str)),
                                          512 if compact else 8192),
        },
        "requested_at": _timestamp(value.get("requested_at")),
    }


def _run_summary(record, *, compact=False):
    result = _object(record.get("result"))
    progress = _object(record.get("progress"))
    pending = _object(record.get("pending_tool_call"))
    started, finished = _timestamp(record.get("started_at")), _timestamp(record.get("finished_at"))
    elapsed = _number(result.get("elapsed_sec"))
    if elapsed is None and started is not None:
        elapsed = round(max(0, (finished if finished is not None else time.time()) - started), 1)
    recent_cmds = _array(progress.get("recent_commands"))
    last_cmd_item = recent_cmds[-1] if recent_cmds else None
    last_command = ""
    if isinstance(last_cmd_item, dict):
        last_command = _text(last_cmd_item.get("command"), 160)
    elif isinstance(last_cmd_item, str):
        last_command = _text(last_cmd_item, 160)
    last_message = _text(progress.get("last_message") or result.get("text"), 200)
    return {
        "run_id": record["run_id"], "session_id": _text(record.get("session_id"), 128),
        "state": _text(record["state"], 32), "cwd": _bounded_text(record.get("cwd"), 8192),
        "worktree_path": _bounded_text(record.get("worktree_path"), 8192) or None,
        "title": record["title"], "workspace_name": _bounded_text(workspace_name(record.get("source_cwd") or record.get("cwd")), 512),
        "host_conversation_id": record.get("host_conversation_id"),
        "can_control": bool(record["state"] in {"running", "waiting_gemini"}
                            and record.get("codex_thread_id") and record.get("turn_id")),
        "model": _text(result.get("model") or record.get("model"), 128),
        "tier": _text(result.get("tier") or record.get("tier"), 64),
        "goal": _bounded_text(record.get("goal"), 512 if compact else _GOAL_BYTES),
        "last_message": last_message,
        "last_command": last_command,
        "started_at": started, "finished_at": finished, "elapsed_sec": elapsed,
        "usage": _usage(result.get("usage") or progress.get("token_usage") or record.get("usage") or {}),
        "progress": {"phase": _text(progress.get("phase"), 64), "updated_at": _timestamp(progress.get("updated_at"))},
        "pending_tool_call": _pending(pending, compact=compact) if pending else None,
        "error": _text(record.get("error"), 240 if compact else 2000),
    }


def _in_workspace(cwd, root):
    return (isinstance(cwd, str) and Path(cwd).is_absolute()
            and (root is None or Path(cwd).resolve().is_relative_to(root)))


def _read_record(run_id):
    record = read_run(run_id)
    if record.get("run_id") != run_id:
        raise ValueError("Run state does not match the requested ID.")
    return record


def _read_workspace_run(run_id, root):
    record = _read_record(run_id)
    if not (_in_workspace(record.get("cwd"), root) or _in_workspace(record.get("source_cwd"), root)):
        raise ValueError("Run outside host workspace")
    return record


@lru_cache(maxsize=512)
def _list_summary(path, mtime_ns, size):
    record = _read_record(path.parent.name)
    return _run_summary(record, compact=True), record.get("source_cwd") or record.get("cwd"), record.get("deadline", float("inf"))


def _json_size(value):
    return len(json.dumps(value, ensure_ascii=False).encode("utf-8"))


def _text_end(value, offset, budget):
    lo, hi = offset, min(len(value), offset + budget)
    if _json_size(value[offset:hi]) <= budget:
        return hi
    while lo < hi:
        middle = (lo + hi + 1) // 2
        if _json_size(value[offset:middle]) <= budget:
            lo = middle
        else:
            hi = middle - 1
    return lo


def _bounded_text(value, budget):
    return value[:_text_end(value, 0, budget)] if isinstance(value, str) else ""


def _within_budget(items, budget):
    selected = []
    for item in items:
        size = _json_size(item) + 2
        if size <= budget:
            selected.append(item)
            budget -= size
    return selected


def _run_scope(args, config):
    context = read_host_context(config)
    active = context.get("conversation_id")
    bound = args.get("host_conversation_id") or (active if isinstance(active, str) else None) or None
    scope = args.get("scope", "session") if bound else "all"
    paths = context.get("workspace_paths")
    workspace = workspace_name(paths[0]) if bound and bound == active and isinstance(paths, list) and paths else ""
    return {"bound_conversation_id": bound, "scope": scope, "bound_workspace_name": workspace}


def _list_runs(limit, root, binding):
    candidates = []
    bound, scope = binding["bound_conversation_id"], binding["scope"]
    session_count = 0
    now = time.time()
    for path in (resolve_sessions_dir() / "runs").glob("*/state.json"):
        try:
            stat = path.stat()
            summary, cwd, deadline = _list_summary(path, stat.st_mtime_ns, stat.st_size)
            if not _in_workspace(cwd, root):
                continue
            matches = bool(bound and summary["host_conversation_id"] == bound)
            session_count += int(matches)
            if scope == "session" and not matches:
                continue
            if summary["state"] in ACTIVE_STATES:
                if now > deadline:
                    summary = {**summary, "state": "outcome_unknown", "pending_tool_call": None, "can_control": False}
                elif summary["started_at"] is not None:
                    summary = {**summary, "elapsed_sec": round(max(0, now - summary["started_at"]), 1)}
            candidates.append((summary["state"] in ACTIVE_STATES, stat.st_mtime_ns, summary))
        except (OSError, RuntimeError, ValueError, KeyError, TypeError):
            continue
    candidates.sort(key=lambda entry: entry[:2], reverse=True)
    runs = _within_budget((entry[2] for entry in candidates[:limit]), 96 * 1024)
    return {**binding, "session_count": session_count, "runs": runs,
            "app_server": {"name": "gempt", "version": __version__}}


class _Journal:
    """Incrementally consume complete JSONL lines, keeping one row per logical item."""

    def __init__(self):
        self.lock = threading.Lock()
        self.file_identity = None
        self.offset = 0
        self.rows = {}
        self.messages = {}
        self.commands = {}
        self.files = {}
        self.usage = {}
        self.request_ids = {}
        self.transcripts = deque(maxlen=2)

    def reset(self, identity):
        self.file_identity = identity
        self.offset = 0
        for values in (self.rows, self.messages, self.commands, self.files,
                       self.usage, self.request_ids, self.transcripts):
            values.clear()

    def read(self, path, record):
        try:
            stream = path.open("rb")
        except FileNotFoundError:
            if self.file_identity is not None:
                self.reset(None)
            return
        with stream:
            stat = os.fstat(stream.fileno())
            identity = (stat.st_ino, record.get("codex_thread_id"), record.get("turn_id"))
            if self.file_identity != identity or stat.st_size < self.offset:
                self.reset(identity)
            stream.seek(self.offset)
            while self.offset < stat.st_size:
                line = stream.readline(stat.st_size - self.offset)
                if not line.endswith(b"\n"):
                    break  # A concurrent writer may not have finished this line.
                self.offset += len(line)
                try:
                    event = json.loads(line)
                except (ValueError, UnicodeError):
                    continue
                if isinstance(event, dict) and isinstance(event.get("method"), str):
                    self.event(event, record)

    def event(self, event, record):
        method, params = event["method"], _object(event.get("params"))
        turn_info = _object(params.get("turn"))
        thread = params.get("threadId") or params.get("conversationId")
        turn = params.get("turnId") or turn_info.get("id")
        if any(record.get(key) and value and value != record[key]
               for key, value in (("codex_thread_id", thread), ("turn_id", turn))):
            return
        if method in {"item/started", "item/completed"}:
            self.item(_object(params.get("item")), method == "item/completed")
        elif method == "turn/completed":
            for item in _array(turn_info.get("items")):
                self.item(_object(item), True)
        elif method == "item/agentMessage/delta" and isinstance(params.get("itemId"), str):
            ident = params["itemId"]
            self.rows.setdefault(("agent_message", ident), {"type": "agent_message", "id": ident})
            if isinstance(params.get("delta"), str):
                self.messages.setdefault(ident, []).append(params["delta"])
        elif method == "item/reasoning/summaryTextDelta":
            index = params.get("summaryIndex", 0)
            if isinstance(params.get("itemId"), str) and type(index) is int:
                self.reasoning(params["itemId"], index, params.get("delta"), append=True)
        elif method == "item/commandExecution/outputDelta" and isinstance(params.get("itemId"), str):
            command = self.command(params["itemId"])
            command["output"] = (command["output"] + _text(params.get("delta"), 4000))[-4000:]
        elif method == "item/tool/call" and params.get("tool") == "ask_gemini" and isinstance(params.get("callId"), str):
            call_id = params["callId"]
            self.ask(call_id, params.get("arguments"), "pending")
            if type(event.get("id")) in (str, int):
                self.request_ids[event["id"]] = call_id
        elif method == "serverRequest/resolved" and type(params.get("requestId")) in (str, int):
            call_id = self.request_ids.pop(params["requestId"], None)
            if call_id is not None:
                self.rows[("ask_gemini", call_id)]["status"] = "resolved"
        elif method == "thread/tokenUsage/updated":
            usage = _object(params.get("tokenUsage"))
            totals = _object(usage.get("last")) or _object(usage.get("total"))
            self.usage.update(_usage({field: totals.get(key) for key, field in _USAGE_FIELDS.items()}))

    def reasoning(self, ident, index, value, *, append=False):
        if isinstance(value, str) and value:
            row = self.rows.setdefault(("reasoning", ident, index), {"type": "reasoning", "text": ""})
            row["text"] = _text((row["text"] if append else "") + value, 4000)

    def command(self, ident):
        self.rows.setdefault(("command", ident), {"type": "command", "id": ident})
        return self.commands.setdefault(ident, {"id": ident, "command": "", "exit_code": None, "output": ""})

    def ask(self, ident, args, status):
        row = self.rows.setdefault(("ask_gemini", ident), {"type": "ask_gemini"})
        if isinstance(args, dict) or "arguments" not in row:
            row.update(_pending({"call_id": ident, "arguments": args}))
        row["status"] = status

    def item(self, item, completed):
        kind, ident = item.get("type"), item.get("id")
        if not isinstance(ident, str):
            return
        if kind == "agentMessage":
            self.rows.setdefault(("agent_message", ident), {"type": "agent_message", "id": ident})
            self.messages.setdefault(ident, [])
            if completed and isinstance(item.get("text"), str):
                self.messages[ident] = [item["text"]]
        elif kind == "reasoning":
            summary = item.get("summary")
            for index, value in enumerate([summary] if isinstance(summary, str) else _array(summary)):
                self.reasoning(ident, index, value)
        elif kind == "commandExecution":
            command = self.command(ident)
            command["command"] = _text(item.get("command"), 3000) or command["command"]
            command["exit_code"] = _number(item.get("exitCode"))
            output = item.get("aggregatedOutput")
            if isinstance(output, str) and output:
                command["output"] = output[-4000:]
        elif kind == "fileChange":
            paths = [change["path"] for change in _array(item.get("changes"))
                     if isinstance(_object(change).get("path"), str)]
            for path in paths:
                self.files[path] = None
            self.rows[("files", ident)] = {
                "type": "files", "count": len(paths), "paths": _within_budget(paths, 4096),
            }
        elif kind == "dynamicToolCall" and item.get("tool") == "ask_gemini":
            self.ask(_text(item.get("callId"), 200) or ident, item.get("arguments"),
                     _text(item.get("status"), 32) or ("completed" if completed else "pending"))

    def text_page(self, text):
        page = _text_page(text, 0)
        if page["next_text_offset"] is not None:
            if not self.transcripts or self.transcripts[-1][1] != text:
                self.transcripts.append((next(_TEXT_REVISIONS), text))
            page["text_revision"] = self.transcripts[-1][0]
        return page


@lru_cache(maxsize=8)
def _journal(path):
    return _Journal()


def _text_page(value, offset):
    # JSON escaping counts toward the transport budget, including control characters.
    end = _text_end(value, offset, _TEXT_BYTES)
    return {"full_text": value[offset:end], "next_text_offset": end if end < len(value) else None}


def _file_uri(path, cwd, root):
    try:
        resolved = (cwd / path).resolve()
        return resolved.as_uri() if resolved.is_relative_to(root or cwd) else None
    except (OSError, RuntimeError, ValueError):
        return None


def _stream(record, max_events, offset, root, revision=None):
    path = run_directory(record["run_id"]) / "events.jsonl"
    journal = _journal(path)
    result = _object(record.get("result"))
    progress = _object(record.get("progress"))
    with journal.lock:
        journal.read(path, record)
        if offset and revision is not None:
            for ident, text in journal.transcripts:
                if ident == revision:
                    return _text_page(text, offset)
            return {"stale_text_revision": True}
        messages = {ident: "".join(chunks) for ident, chunks in journal.messages.items()}
        full_text = result.get("text")
        if isinstance(full_text, str) and isinstance(result.get("summary"), str):
            full_text = full_text.removeprefix(result["summary"] + "\n\n")
        if not isinstance(full_text, str) or not full_text:
            full_text = "\n\n".join(text for text in messages.values() if text)
        full_text = full_text or _text(progress.get("last_message"), 1500)
        if offset:
            return _text_page(full_text, offset)
        page = journal.text_page(full_text)
        timeline = []
        for row in list(journal.rows.values())[-max_events:]:
            if row["type"] == "agent_message":
                row = {**row, "text": _text(messages.get(row["id"]), 1200)}
            elif row["type"] == "command":
                command = journal.commands[row["id"]]
                row = {**row, "command": _text(command["command"], 600),
                       "exit_code": command["exit_code"], "output": command["output"][-600:]}
            timeline.append(row)
        commands = list(journal.commands.values())
        files = list(journal.files)
        usage = _usage(result.get("usage") or journal.usage or progress.get("token_usage") or record.get("usage") or {})
        timeline = list(reversed(_within_budget(reversed(timeline), 56 * 1024)))
        if not commands:
            fallback = (_array(_object(result.get("verification")).get("commands"))
                        or _array(result.get("commands")) or _array(progress.get("recent_commands")))
            commands = [
                {"id": str(index), "command": _text(command.get("command"), 3000),
                 "exit_code": _number(command.get("exit_code")), "output": _text(command.get("output"), 4000)}
                for index, command in enumerate(fallback)
                if isinstance(command, dict)
            ]
        commands = list(reversed(_within_budget(reversed(commands), 48 * 1024)))
        files = _within_budget((name for name in reversed(files or _array(progress.get("touched_files")))
                                if isinstance(name, str)), 8 * 1024)[::-1]
    cwd = Path(record["cwd"]).resolve()
    uris = _within_budget(
        ((name, uri) for name in files if (uri := _file_uri(name, cwd, root))), 24 * 1024,
    )
    run = {**_run_summary(record), "usage": usage}
    goal = record.get("goal")
    next_goal_offset = len(run["goal"]) if isinstance(goal, str) and len(run["goal"]) < len(goal) else None
    input_tokens = usage.get("input_tokens", 0)
    cached = usage.get("cached_input_tokens")
    return {
        "run": run, "timeline": timeline, **page, "commands": commands, "next_goal_offset": next_goal_offset,
        "touched_files": files, "file_uris": dict(uris), "usage": usage,
        "cache_hit_rate": min(cached, input_tokens) / input_tokens if input_tokens > 0 and cached is not None else None,
    }


def _result(text, data):
    return {"content": [{"type": "text", "text": text}], "structuredContent": data}


def call_app_tool(name: str, args: dict[str, Any], *, root: Path | None, config: Path):
    schema = APP_TOOLS[name]["inputSchema"]
    if args.keys() - schema["properties"].keys() or set(schema.get("required", ())) - args.keys():
        raise ValueError(f"Unexpected or missing arguments for {name}.")
    for key, value in args.items():
        field = schema["properties"][key]
        if field["type"] == "string":
            if (not isinstance(value, str) or ("pattern" in field and not re.fullmatch(field["pattern"], value))
                    or ("enum" in field and value not in field["enum"])):
                raise ValueError(f"Invalid {key}.")
        elif type(value) is not int or not field["minimum"] <= value <= field.get("maximum", value):
            raise ValueError(f"Invalid {key}.")
    run_id = args.get("run_id")
    if name in ("gempt_app_runs", "gempt_live_view"):
        binding = _run_scope(args, config)
        data = _list_runs(args.get("limit", 20), root, binding)
        if name == "gempt_app_runs":
            return _result("GemPT Live runs.", data)
    record = _read_workspace_run(run_id, root) if run_id else None
    if name == "gempt_live_view":
        if record and binding["scope"] == "session" and record.get("host_conversation_id") != binding["bound_conversation_id"]:
            record = None
        if record is None:
            for run in data["runs"]:
                try:
                    record = _read_workspace_run(run["run_id"], root)
                    break
                except (OSError, ValueError):
                    continue
        return _result("Opened GemPT Live.", {
            **data, "run_id": record["run_id"] if record else None,
            "requested_run": bool(run_id),
            "stream": _stream(record, 60, 0, root) if record else None,
        })
    if name == "gempt_app_stream":
        if (offset := args.get("goal_offset")) is not None:
            goal = record.get("goal")
            goal = goal if isinstance(goal, str) else ""
            end = _text_end(goal, offset, _GOAL_BYTES)
            return _result("GemPT Live task goal.", {
                "goal": goal[offset:end], "next_goal_offset": end if end < len(goal) else None,
            })
        return _result("GemPT Live snapshot.",
                       _stream(record, args.get("max_events", 60), args.get("text_offset", 0),
                               root, args.get("text_revision")))
    if name == "gempt_app_steer":
        return _result("Steering sent.", steer_run(run_id, args["message"], config_path=config))
    return _result("Interrupt requested.", interrupt_run(run_id, config_path=config))
