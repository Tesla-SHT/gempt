"""Codex app-server v2 over the Magpie plugin's authenticated loopback socket."""

from __future__ import annotations

import base64
from concurrent.futures import Future
from contextlib import suppress
import hashlib
import itertools
import json
import os
from pathlib import Path
import re
import socket
import struct
import threading
import time
from urllib.parse import urlsplit

from . import DEFAULT_CONFIG_PATH
from .codex_runner import CodexExecError

UNAVAILABLE = "未检测到 Magpie 插件托管的共享 codex app-server（请先启动 Magpie 并确认 GemPT 插件已启用）。"
PROVIDER = "gempt_gateway"
DEVELOPER_INSTRUCTIONS = (
    "Use ask_gemini for visual checks, clarifications, decisions, or blockers that require the coordinating Gemini. "
    "Provide a specific question and include the relevant context and local media paths when appropriate."
)
ASK_GEMINI = {
    "type": "function",
    "name": "ask_gemini",
    "description": "Ask the coordinating Gemini for input and continue this turn when it replies.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "reason": {"type": "string", "enum": ["visual_check", "clarification", "decision", "blocked"]},
            "question": {"type": "string"},
            "context": {"type": "string"},
            "media_paths": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["reason", "question"],
        "additionalProperties": False,
    },
}
SANDBOX_TYPES = {
    "read-only": "readOnly",
    "workspace-write": "workspaceWrite",
    "danger-full-access": "dangerFullAccess",
}
MAX_MESSAGE = 64 * 1024 * 1024


class AppServerUnavailableError(CodexExecError):
    def __init__(self):
        super().__init__(UNAVAILABLE)


class TurnInterrupted(CodexExecError):
    pass


def text_input(text):
    return [{"type": "text", "text": text}]


def tool_reply_path(directory, call_id):
    if not isinstance(call_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", call_id):
        raise ValueError("Invalid tool call_id.")
    return directory / "tool_replies" / f"{call_id}.json"


def state_path(config_path=None):
    override = os.environ.get("GEMPT_APP_SERVER_STATE", "").strip()
    config = config_path or os.environ.get("GEMPT_CONFIG") or DEFAULT_CONFIG_PATH
    return Path(override).expanduser().resolve() if override else Path(config).expanduser().resolve().with_name("app-server.json")


class WebSocket:
    """RFC 6455 text messages with masked writes, fragmentation and control frames."""

    def __init__(self, url, auth_header, token, timeout=3):
        target = urlsplit(url)
        if (target.scheme != "ws" or target.hostname != "127.0.0.1" or not target.port
                or target.username or target.password or target.fragment
                or auth_header.lower() != "authorization" or not re.fullmatch(r"[A-Za-z0-9_-]+", token)):
            raise ValueError("Invalid app-server WebSocket endpoint or capability token.")
        self.sock = socket.create_connection((target.hostname, target.port), timeout)
        self._buf = bytearray()
        self.write_lock = threading.Lock()
        self.closed = False
        try:
            key = base64.b64encode(os.urandom(16)).decode("ascii")
            path = target.path or "/"
            if target.query:
                path += "?" + target.query
            if re.search(r"[\x00-\x20\x7f]", path):
                raise ValueError("Invalid WebSocket request target.")
            request = (
                f"GET {path} HTTP/1.1\r\nHost: {target.netloc}\r\nUpgrade: websocket\r\n"
                f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
                f"Authorization: Bearer {token}\r\n\r\n"
            )
            self.sock.sendall(request.encode("ascii"))
            while b"\r\n\r\n" not in self._buf:
                if len(self._buf) > 65536:
                    raise OSError("WebSocket upgrade header too large.")
                chunk = self.sock.recv(4096)
                if not chunk:
                    raise EOFError("WebSocket upgrade closed.")
                self._buf.extend(chunk)
            raw_head, _, remainder = bytes(self._buf).partition(b"\r\n\r\n")
            self._buf = bytearray(remainder)
            lines = raw_head.split(b"\r\n")
            status = lines[0].split()
            if status[:2] != [b"HTTP/1.1", b"101"]:
                raise OSError("WebSocket upgrade rejected.")
            if len(lines) > 65:
                raise OSError("Too many WebSocket upgrade headers.")
            headers = {}
            for line in lines[1:]:
                name, sep, value = line.partition(b":")
                if not sep or not value:
                    raise OSError("Invalid WebSocket upgrade header.")
                headers[name.lower()] = value.strip()
            accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest())
            if (headers.get(b"sec-websocket-accept") != accept or headers.get(b"upgrade", b"").lower() != b"websocket"
                    or b"upgrade" not in [part.strip() for part in headers.get(b"connection", b"").lower().split(b",")]
                    or b"sec-websocket-extensions" in headers or b"sec-websocket-protocol" in headers):
                raise OSError("Invalid WebSocket upgrade response.")
            self.sock.settimeout(0.5)
        except BaseException:
            self.sock.close()
            raise

    def stop(self):
        self.closed = True
        with suppress(OSError):
            self.send(b"", opcode=8)
        with suppress(OSError):
            self.sock.shutdown(socket.SHUT_RDWR)
        with suppress(OSError):
            self.sock.close()

    def send(self, payload, opcode=1):
        size = len(payload)
        mask = os.urandom(4)
        if size < 126:
            length = bytes([0x80 | size])
        elif size < 65536:
            length = b"\xfe" + struct.pack("!H", size)
        else:
            length = b"\xff" + struct.pack("!Q", size)
        # XOR four byte lanes in C via Python's big integers for large prompts.
        pattern = (mask * ((size + 3) // 4))[:size]
        masked = (int.from_bytes(payload, "big") ^ int.from_bytes(pattern, "big")).to_bytes(size, "big")
        with self.write_lock:
            self.sock.sendall(bytes([0x80 | opcode]) + length + mask + masked)

    def _read(self, size):
        while len(self._buf) < size:
            if self.closed:
                raise EOFError("Codex app-server WebSocket closed.")
            try:
                chunk = self.sock.recv(max(4096, size - len(self._buf)))
            except TimeoutError:
                continue
            if not chunk:
                raise EOFError("Codex app-server closed the WebSocket.")
            self._buf.extend(chunk)
        out = bytes(self._buf[:size])
        del self._buf[:size]
        return out

    def receive(self):
        message = bytearray()
        fragmented = False
        while True:
            first, length = self._read(2)
            final, opcode = bool(first & 0x80), first & 15
            if first & 0x70 or length & 0x80:
                raise OSError("Unexpected WebSocket extension or server mask.")
            if opcode >= 8 and (not final or length > 125):
                raise OSError("Invalid WebSocket control frame.")
            if length == 126:
                length = struct.unpack("!H", self._read(2))[0]
                if length < 126:
                    raise OSError("Invalid WebSocket frame length.")
            elif length == 127:
                length = struct.unpack("!Q", self._read(8))[0]
                if length < 65536:
                    raise OSError("Invalid WebSocket frame length.")
            if len(message) + length > MAX_MESSAGE:
                raise OSError("WebSocket message exceeds the size limit.")
            payload = self._read(length)
            if opcode == 8:
                with suppress(OSError):
                    self.send(payload, opcode=8)
                raise EOFError("Codex app-server closed the WebSocket.")
            if opcode == 9:
                self.send(payload, opcode=10)
            elif opcode == 10:
                continue
            elif opcode == (0 if fragmented else 1):
                message.extend(payload)
                if final:
                    return message.decode("utf-8")
                fragmented = True
            else:
                raise OSError("Unexpected WebSocket frame opcode.")


class AppServerClient:
    """Multiplex requests, notifications and incoming requests on one connection."""

    def __init__(self, *, config_path=None, gateway_url=None, on_event=None):
        try:
            state = json.loads(state_path(config_path).read_text(encoding="utf-8"))
            if state["status"] != "running":
                raise ValueError("App-server is not running.")
            self.ws = WebSocket(state["ws_url"], state["auth_header"], state["auth_token"])
        except (AttributeError, KeyError, OSError, TypeError, ValueError) as exc:
            raise AppServerUnavailableError() from exc
        if gateway_url and str(state.get("gateway_url", "")).rstrip("/") != gateway_url.rstrip("/"):
            self.ws.stop()
            raise CodexExecError("共享 codex app-server 的 Magpie 网关与 GemPT 配置不一致。")
        self.on_event = on_event
        self.ids = itertools.count(1)
        self.pending = {}
        self.lock = threading.Lock()
        self.error = None
        self.reader = threading.Thread(target=self._read_loop, name="gempt-app-server", daemon=True)
        self.reader.start()

    def _read_loop(self):
        try:
            while True:
                message = json.loads(self.ws.receive())
                if "method" in message:
                    if self.on_event:
                        self.on_event(message)
                else:
                    with self.lock:
                        future = self.pending.pop(message.get("id"), None)
                    if future is not None:
                        if "error" in message:
                            future.set_exception(CodexExecError(str(message["error"].get("message") or message["error"])))
                        else:
                            future.set_result(message.get("result"))
        except Exception as exc:
            self.ws.stop()
            with self.lock:
                self.error = CodexExecError(f"Codex app-server connection closed: {exc}")
                for future in self.pending.values():
                    future.set_exception(self.error)
                self.pending.clear()
        finally:
            self.ws.stop()

    def _send(self, **message):
        self.ws.send(json.dumps({"jsonrpc": "2.0", **message}, ensure_ascii=False).encode("utf-8"))

    def request(self, method, params, *, timeout=8):
        with self.lock:
            if self.error:
                raise self.error
            ident = next(self.ids)
            future = self.pending[ident] = Future()
        try:
            self._send(id=ident, method=method, params=params)
            return future.result(timeout=timeout)
        except TimeoutError as exc:
            raise CodexExecError(f"{method} timed out.") from exc
        finally:
            with self.lock:
                self.pending.pop(ident, None)

    def initialize(self):
        try:
            self.request("initialize", {
                "clientInfo": {"name": "gempt", "version": "2.0"},
                "capabilities": {"experimentalApi": True},
            }, timeout=4)
            self._send(method="initialized")
        except (CodexExecError, OSError) as exc:
            raise AppServerUnavailableError() from exc

    def reply(self, ident, result):
        self._send(id=ident, result=result)

    def reject(self, ident):
        self._send(id=ident, error={"code": -32601, "message": "Unsupported server request"})

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.ws.stop()
        self.reader.join(timeout=2.0)


def approval_reply(method, params, sandbox):
    full = sandbox == "danger-full-access"
    if method == "item/commandExecution/requestApproval":
        # A command approval can authorize execution outside the sandbox. Input
        # to an existing terminal does not obtain a different sandbox.
        allowed = full or (params.get("kind") == "writeStdin" and not params.get("additionalPermissions")
                           and not params.get("networkApprovalContext"))
        return {"decision": "accept" if allowed else "decline"}
    if method == "item/fileChange/requestApproval":
        return {"decision": "accept" if full else "decline"}
    if method == "item/permissions/requestApproval":
        return {"permissions": params["permissions"] if full else {}, "scope": "turn"}
    if method in {"execCommandApproval", "applyPatchApproval"}:
        return {"decision": "approved" if full else {"denied": {"rejection": "Configured sandbox"}}}
    return None


class TurnJournal:
    """Own the live run state and collect the result from v2 notifications."""

    def __init__(self, run_id, session_id, thread_id, sandbox, on_identity, *, model):
        from .runs import read_run, run_directory
        self.directory = run_directory(run_id) if run_id else None
        self.record = read_run(run_id) if run_id else {}
        self.record.update(session_id=session_id, model=model, state="running", pending_tool_call=None)
        self.on_identity = on_identity
        self.sandbox = sandbox
        self.turn = None
        self.client = None
        self.lock = threading.RLock()
        self.changed = threading.Event()
        self.accept_turn = False
        self.tools = {}
        self.commands = {}
        self.messages = {}
        self.files = {}
        self.usage = {}
        self.last_write = 0.0
        self.progress = {"phase": "connecting", "thread_id": thread_id or None, "turn_id": None,
                         "last_message": "", "recent_commands": [], "touched_files": [], "token_usage": {}}
        self.save(force=True)

    def save(self, *, force=False):
        now = time.monotonic()
        if self.directory and (force or now - self.last_write >= 0.5):
            from .runs import _write_run_state
            self.progress["updated_at"] = time.time()
            self.record["progress"] = self.progress
            _write_run_state(self.directory, self.record)
            self.last_write = now

    def identity(self, *, thread_id=None, turn_id=None):
        changed = False
        for key, value in (("thread_id", thread_id), ("turn_id", turn_id)):
            if value and self.progress[key] != value:
                self.progress[key] = value
                changed = True
        if changed or (thread_id and not self.record.get("codex_thread_id")):
            self.record.update(codex_thread_id=self.progress["thread_id"], turn_id=self.progress["turn_id"])
            self.save(force=True)
            if self.on_identity:
                self.on_identity(self.progress["thread_id"], self.progress["turn_id"])

    def pending_changed(self):
        waiting = next(iter(self.tools.values()), None)
        self.record.update(state="waiting_gemini" if waiting else "running",
                           pending_tool_call=waiting)
        self.progress["phase"] = self.record["state"]
        self.save(force=True)
        self.changed.set()

    def event(self, message):
        with self.lock:
            if self.directory:
                with (self.directory / "events.jsonl").open("a", encoding="utf-8") as stream:
                    stream.write(json.dumps(message, ensure_ascii=False) + "\n")
            method = message["method"]
            params = message.get("params") or {}
            if method == "thread/started":
                self.identity(thread_id=params["thread"]["id"])
                return
            if "id" in message:
                self.server_request(method, params, message["id"])
                return
            if not self.accept_turn or params.get("threadId") != self.progress["thread_id"]:
                return
            event_turn = params.get("turnId") or (params.get("turn") or {}).get("id")
            if self.progress["turn_id"] and event_turn and event_turn != self.progress["turn_id"]:
                return
            if method == "turn/started":
                self.progress["phase"] = "running"
                self.identity(turn_id=params["turn"]["id"])
            elif method == "turn/completed":
                self.identity(turn_id=params["turn"]["id"])
                self.turn = params["turn"]
                self.tools.clear()
                self.record.update(state="running", pending_tool_call=None)
                self.progress["phase"] = self.turn["status"]
                self.save(force=True)
                self.changed.set()
            elif method == "serverRequest/resolved" and params.get("requestId") in self.tools:
                self.tools.pop(params["requestId"])
                self.pending_changed()
            elif method in {"item/started", "item/completed"}:
                self.item(params["item"])
                self.save(force=True)
            elif method == "item/agentMessage/delta":
                ident = params["itemId"]
                self.messages[ident] = self.messages.get(ident, "") + params["delta"]
                self.progress["last_message"] = self.messages[ident][-1500:]
                self.save()
            elif method == "thread/tokenUsage/updated":
                last = params["tokenUsage"]["last"]
                self.usage = {"input_tokens": last["inputTokens"], "output_tokens": last["outputTokens"],
                              "cached_input_tokens": last["cachedInputTokens"], "total_tokens": last["totalTokens"],
                              "reasoning_tokens": last["reasoningOutputTokens"]}
                self.progress["token_usage"] = self.usage
                self.save()

    def item(self, item):
        kind = item["type"]
        if kind == "agentMessage":
            self.messages[item["id"]] = item["text"]
            self.progress["last_message"] = item["text"][-1500:]
        elif kind == "commandExecution":
            self.commands[item["id"]] = {"command": item["command"], "exit_code": item.get("exitCode"),
                                         "output": str(item.get("aggregatedOutput") or "")[-4000:]}
            self.progress["recent_commands"] = list(self.commands.values())[-5:]
        elif kind == "fileChange":
            self.files.update((change["path"], None) for change in item["changes"])
            self.progress["touched_files"] = list(self.files)[-50:]

    def server_request(self, method, params, ident):
        related = params.get("threadId", params.get("conversationId")) == self.progress["thread_id"]
        if not related or self.turn:
            self.client.reject(ident)
            return
        if method == "item/tool/call":
            if params.get("tool") == "ask_gemini" and self.directory:
                call_id = params["callId"]
                try:
                    tool_reply_path(self.directory, call_id)
                except ValueError:
                    self.client.reject(ident)
                    return
                self.identity(turn_id=params["turnId"])
                self.tools[ident] = {"call_id": call_id, "tool": "ask_gemini",
                                     "arguments": params["arguments"], "requested_at": time.time()}
                self.pending_changed()
            else:
                self.client.reply(ident, {"success": False, "contentItems": [
                    {"type": "inputText", "text": "This tool is unavailable for this run."}]})
            return
        answer = approval_reply(method, params, self.sandbox)
        if answer is None:
            self.client.reject(ident)
        else:
            self.client.reply(ident, answer)

    def poll_reply(self):
        if not self.tools:
            return
        ident, pending = next(iter(self.tools.items()))
        try:
            reply = json.loads(tool_reply_path(self.directory, pending["call_id"]).read_text(encoding="utf-8"))
        except (FileNotFoundError, PermissionError, json.JSONDecodeError):
            return
        self.client.reply(ident, {"success": reply["success"], "contentItems": [
            {"type": "inputText", "text": reply["answer"]}]})
        self.tools.pop(ident)
        self.pending_changed()


def run_app_server(*, prompt, cwd, model, reasoning_effort, sandbox, approval_policy,
                   codex_thread_id, gateway_url, config_path, timeout_sec, run_id, session_id, on_identity):
    start = time.monotonic()
    deadline = start + timeout_sec
    journal = TurnJournal(run_id, session_id, codex_thread_id, sandbox, on_identity, model=model)
    policy = {"type": SANDBOX_TYPES[sandbox]}
    common = {"cwd": str(cwd), "model": model, "modelProvider": PROVIDER,
              "sandbox": sandbox, "approvalPolicy": approval_policy,
              "developerInstructions": DEVELOPER_INSTRUCTIONS}
    with AppServerClient(config_path=config_path, gateway_url=gateway_url, on_event=journal.event) as client:
        journal.client = client
        client.initialize()
        method, params = ("thread/resume", {"threadId": codex_thread_id, "excludeTurns": True}) if codex_thread_id else (
            "thread/start", {"dynamicTools": [ASK_GEMINI], "allowProviderModelFallback": False})
        # Codex stores dynamic tool specs with the thread. Resume has no dynamicTools field.
        thread = client.request(method, {**common, **params}, timeout=max(0.01, deadline - time.monotonic()))
        thread_id = thread["thread"]["id"]
        with journal.lock:
            journal.identity(thread_id=thread_id)
            journal.accept_turn = True
        if codex_thread_id and thread_id != codex_thread_id:
            raise CodexExecError("Codex returned a different thread on resume.")
        observed = {"cwd": thread.get("cwd"), "sandbox": next(
            (mode for mode, kind in SANDBOX_TYPES.items() if kind == (thread.get("sandbox") or {}).get("type")), None)}
        if (not observed["cwd"] or Path(observed["cwd"]).resolve() != Path(cwd).resolve()
                or observed["sandbox"] not in SANDBOX_TYPES
                or list(SANDBOX_TYPES).index(observed["sandbox"]) > list(SANDBOX_TYPES).index(sandbox)
                or thread.get("modelProvider") != PROVIDER):
            raise CodexExecError("Codex app-server did not confirm the requested workspace, sandbox and Magpie provider.")
        try:
            result = client.request("turn/start", {
                "threadId": thread_id, "input": text_input(prompt), "effort": reasoning_effort,
                "model": model, "cwd": str(cwd), "sandboxPolicy": policy, "approvalPolicy": approval_policy,
            }, timeout=max(0.01, deadline - time.monotonic()))
            with journal.lock:
                journal.identity(turn_id=result["turn"]["id"])
            while True:
                with journal.lock:
                    if journal.turn:
                        break
                    if client.error:
                        raise client.error
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise CodexExecError(f"Codex turn timed out after {timeout_sec}s.")
                    journal.poll_reply()
                    journal.changed.clear()
                journal.changed.wait(min(0.1, remaining))
        except CodexExecError as exc:
            if "timed out" in str(exc) and journal.progress["turn_id"]:
                with suppress(CodexExecError, OSError):
                    client.request("turn/interrupt", {"threadId": thread_id, "turnId": journal.progress["turn_id"]}, timeout=4)
            raise
    if journal.turn["status"] == "interrupted":
        raise TurnInterrupted("Codex turn interrupted.")
    if journal.turn["status"] != "completed":
        error = journal.turn.get("error") or {}
        raise CodexExecError(str(error.get("message") or f"Codex turn {journal.turn['status']}."))
    reply = "\n\n".join(value.strip() for value in journal.messages.values() if value.strip())
    if not reply:
        raise CodexExecError("Codex finished without an assistant message.")
    return {"codex_thread_id": thread_id, "turn_id": journal.progress["turn_id"], "text": reply,
            "observed_context": observed, "commands": list(journal.commands.values()),
            "usage": journal.usage, "elapsed_sec": time.monotonic() - start}
