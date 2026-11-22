"""GemPT v2 Antigravity lifecycle hook: SessionStart signatures, 0-token /compact milestones, and 5-tier fail-open routing."""
from __future__ import annotations

import ctypes
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

if __name__ == "__main__":
    plugin = Path(__file__).resolve().parent
    runtime = plugin / "runtime"
    sys.path.insert(0, str(runtime if runtime.is_dir() else plugin.parent / "src"))

from gempt.host_context import context_path, update_host_context
from gempt.sessions import resolve_sessions_dir
from gempt.titles import explicit_title

_READ_TOOLS = frozenset({
    "read_file",
    "view_file",
    "view_file_outline",
    "view_code_item",
    "grep_search",
    "find_by_name",
    "list_dir",
})
_WRITE_TOOLS = frozenset({"edit_file", "write_file"})
_EXEMPT_EXTS = frozenset({
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".ico", ".svg",
    ".mp4", ".mov", ".webm", ".wav", ".mp3", ".pdf",
})
_EXEMPT_PATH_PARTS = (
    "/.gemini/antigravity/mcp/",
    "/.gemini/antigravity/brain/",
    "/.gemini/config/plugins/",
    "/.zcode/skills/",
    "/agent-skills/",
    "/.config/gempt/",
)
_DOC_EXTS = frozenset({".md", ".mdx", ".txt", ".rst", ".adoc"})
_SMALL_CONFIG_EXTS = frozenset({".json", ".toml", ".yaml", ".yml", ".ini", ".cfg", ".conf", ".env"})
_SOURCE_EXTS = frozenset({
    ".py", ".pyi", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
    ".go", ".rs", ".java", ".kt", ".scala", ".c", ".cc", ".cpp", ".cxx", ".h", ".hpp",
    ".cs", ".rb", ".php", ".sh", ".bash", ".zsh", ".ps1", ".psm1", ".bat", ".cmd",
    ".css", ".scss", ".less", ".html", ".htm", ".vue", ".svelte", ".sql", ".lua", ".gd",
    ".swift", ".m", ".mm", ".r", ".jl", ".dart", ".ex", ".exs", ".zig",
})
_USER_OVERRIDE_RE = re.compile(
    r"(?:自己改|自己查|自己做|不用\s*gpt|别用\s*gpt|别派\s*gpt|不要\s*gpt|别转\s*gpt|"
    r"gemini\s*(?:自己|直接)?(?:做|改|查|处理)|"
    r"\bno\s+gpt\b|\bskip\s+gempt\b|\bbypass\s+gempt\b|\bdon'?t\s+use\s+gpt\b)",
    re.IGNORECASE,
)
_WAIT_CMD_RE = re.compile(r"\bgempt-wait\b|\bgempt\.cli\b[^\n]*--wait\b|\bgempt\s+status\b[^\n]*--wait\b", re.IGNORECASE)
_READ_CMD_RE = re.compile(
    r"(?:^|[;&|\r\n]\s*)(?:(?:sudo|command|time)\s+)?(?:Get-Content|Select-String|Get-ChildItem|"
    r"gc|sls|gci|cat|head|tail|rg|ripgrep|grep|findstr|find|ls|dir|tree|sed|awk|wc|"
    r"git\s+(?:diff|show|log|grep|status)|type)(?:\.exe)?(?=\s|$)",
    re.IGNORECASE,
)
_CTX_MILESTONES_K = (120, 200, 280)
_SMALL_CONFIG_MAX_LINES = 15
_CIRCUIT_WINDOW_SEC = 600.0
_CIRCUIT_CONSECUTIVE_FAILS = 2
_EXPLORE_LIMIT_80 = 5
_EXPLORE_LIMIT_95 = 2


def native_family(name: Any) -> str | None:
    if name == "gemini-pro-orchestrator":
        return "carbon"
    match = re.search(r"(?:^|[^a-z0-9])(hydrogen|neon|carbon)(?:$|[^a-z0-9])", str(name).lower())
    return match.group(1) if match else None


def _config_path() -> Path:
    return Path(os.environ.get("GEMPT_CONFIG") or context_path().with_name("config.json")).expanduser()


def _load_policy(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig")).get("routing_policy", {}) if path.is_file() else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _load_profiles() -> dict[str, Any]:
    profiles_file = Path(__file__).parent / "runtime/gempt/workload.json"
    if not profiles_file.is_file():
        profiles_file = Path(__file__).resolve().parent.parent / "src/gempt/workload.json"
    return json.loads(profiles_file.read_text(encoding="utf-8"))["profiles"]


def _state_file(conversation: str) -> Path:
    safe = re.sub(r"[^a-zA-Z0-9._-]", "_", conversation)[:80] or "default"
    return _config_path().with_name("hook-state") / f"{safe}.json"


def _read_state(conversation: str | None) -> dict[str, Any]:
    if not isinstance(conversation, str) or not conversation.strip():
        return {}
    try:
        p = _state_file(conversation)
        if p.is_file():
            data = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
    except (OSError, json.JSONDecodeError):
        pass
    return {}


def _write_state(conversation: str | None, data: dict[str, Any]) -> None:
    if not isinstance(conversation, str) or not conversation.strip():
        return
    try:
        p = _state_file(conversation)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(f".{p.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        tmp.replace(p)
    except OSError:
        pass


def _turn_key(last_user_input: Any) -> str:
    text = str(last_user_input or "").strip()
    if not text:
        return ""
    return hashlib.sha1(text.encode("utf-8", errors="replace")).hexdigest()[:16]


def _reset_explore_count(conversation: str | None, turn_key: str = "") -> None:
    if not isinstance(conversation, str) or not conversation.strip():
        return
    state = _read_state(conversation)
    state["explore_count"] = 0
    if turn_key:
        state["turn_key"] = turn_key
    state["updated_at"] = time.time()
    _write_state(conversation, state)


def _bump_explore_count(conversation: str | None, turn_key: str) -> int:
    if not isinstance(conversation, str) or not conversation.strip():
        return 1
    state = _read_state(conversation)
    prev_key = str(state.get("turn_key") or "")
    count = int(state.get("explore_count") or 0)
    if turn_key and prev_key and turn_key != prev_key:
        count = 0
    count += 1
    state["explore_count"] = count
    if turn_key:
        state["turn_key"] = turn_key
    state["updated_at"] = time.time()
    _write_state(conversation, state)
    return count


def _pid_alive(pid: Any) -> bool:
    try:
        val = int(pid)
    except (TypeError, ValueError):
        return False
    if val < 1:
        return False
    if os.name == "nt":
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, val)
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            if ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return code.value == STILL_ACTIVE
            return True
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)
    try:
        os.kill(val, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def _gpt_backend_healthy(cfg_path: Path) -> bool:
    """Return False (fail-open) if shared codex app-server is down or recent runs tripped the circuit breaker."""
    override = os.environ.get("GEMPT_APP_SERVER_STATE", "").strip()
    app_state = Path(override).expanduser() if override else cfg_path.with_name("app-server.json")
    try:
        data = json.loads(app_state.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or data.get("status") != "running":
            return False
        if not data.get("ws_url") or not _pid_alive(data.get("pid")):
            return False
    except (OSError, json.JSONDecodeError):
        return False

    # Circuit breaker: >= 2 consecutive recent terminal failures within window -> fail-open.
    try:
        window = float(os.environ.get("GEMPT_CIRCUIT_WINDOW_SEC", str(_CIRCUIT_WINDOW_SEC)))
    except ValueError:
        window = _CIRCUIT_WINDOW_SEC
    try:
        runs_dir = resolve_sessions_dir() / "runs"
        if not runs_dir.is_dir():
            return True
        state_files = sorted(
            runs_dir.glob("*/state.json"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
    except OSError:
        return True

    now = time.time()
    terminal_checked = 0
    consecutive_failures = 0
    for sf in state_files[:10]:
        try:
            st = sf.stat()
            rec = json.loads(sf.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        state = rec.get("state")
        if state not in {"finished", "failed", "outcome_unknown"}:
            continue
        ts = rec.get("finished_at")
        if isinstance(ts, (int, float)):
            age = now - float(ts)
        else:
            age = now - st.st_mtime
        if age > window:
            break
        terminal_checked += 1
        if state in {"failed", "outcome_unknown"}:
            consecutive_failures += 1
            if consecutive_failures >= _CIRCUIT_CONSECUTIVE_FAILS:
                return False
        else:
            break
        if terminal_checked >= _CIRCUIT_CONSECUTIVE_FAILS:
            break
    return True


def _is_exempt_path(raw: str) -> bool:
    if not raw:
        return False
    norm = raw.replace("\\", "/").lower()
    if norm.endswith("/skill.md") or norm == "skill.md":
        return True
    if any(part in norm for part in _EXEMPT_PATH_PARTS):
        return True
    return Path(norm).suffix in _EXEMPT_EXTS


def _extract_path(args: dict[str, Any]) -> str:
    for key in ("Path", "TargetFile", "AbsolutePath", "SearchPath", "DirectoryPath"):
        val = args.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return ""


def _is_user_override(payload: dict[str, Any]) -> bool:
    text = str(payload.get("lastUserInput") or "")
    return bool(text and _USER_OVERRIDE_RE.search(text))


def _effective_cwd(payload: dict[str, Any], target_path: str = "") -> str:
    cwd = payload.get("cwd")
    if isinstance(cwd, str) and cwd.strip():
        return cwd.strip()
    ws = payload.get("workspacePaths")
    if isinstance(ws, list) and ws and isinstance(ws[0], str) and ws[0].strip():
        return ws[0].strip()
    if target_path:
        try:
            p = Path(target_path)
            return str(p.parent if p.suffix else p)
        except OSError:
            pass
    return "."


def _is_source_write(args: dict[str, Any]) -> tuple[bool, str]:
    """Return (should_deny_write, target_path). Exempts whitelist, docs, and small (<=15 line) config edits."""
    raw = _extract_path(args)
    if not raw or _is_exempt_path(raw):
        return False, raw
    norm = raw.replace("\\", "/").lower()
    suffix = Path(norm).suffix
    if suffix in _DOC_EXTS:
        return False, raw
    if suffix in _SMALL_CONFIG_EXTS:
        line_counts = [
            len(str(args[k]).splitlines())
            for k in ("Target", "Replacement", "Content", "OldString", "NewString")
            if isinstance(args.get(k), str) and args.get(k)
        ]
        if max(line_counts, default=0) <= _SMALL_CONFIG_MAX_LINES:
            return False, raw
        return True, raw
    if suffix in _SOURCE_EXTS:
        return True, raw
    # Unknown extension (e.g. Dockerfile, Makefile, CMakeLists): deny only if clearly code/build file
    base = Path(norm).name
    if base in {"dockerfile", "makefile", "cmakelists.txt", "justfile", "procfile"}:
        return True, raw
    return False, raw


def _is_read_command(args: dict[str, Any]) -> bool:
    cmd = str(args.get("CommandLine") or "").strip()
    if not cmd:
        return False
    if _WAIT_CMD_RE.search(cmd):
        return False
    return bool(_READ_CMD_RE.search(cmd))


def _tail_context_tokens(transcript_path: Any) -> int | None:
    """O(1) tail-read (<2ms) of the latest PLANNER_RESPONSE context size from transcriptPath."""
    if not isinstance(transcript_path, str) or not transcript_path.strip():
        return None
    path = Path(transcript_path)
    try:
        size = path.stat().st_size
        if size <= 0:
            return None
        read_len = min(size, 65536)
        with path.open("rb") as fh:
            if size > read_len:
                fh.seek(size - read_len)
            chunk = fh.read(read_len).decode("utf-8", errors="replace")
    except OSError:
        return None
    lines = chunk.splitlines()
    for line in reversed(lines):
        if "PLANNER_RESPONSE" not in line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and obj.get("type") == "PLANNER_RESPONSE":
            inp = int(obj.get("input_tokens") or 0)
            out = int(obj.get("output_tokens") or 0)
            cache = int(obj.get("cache_read_tokens") or 0)
            total = inp + out + cache
            return total if total > 0 else None
    return None


def _context_milestone_step(conversation: str | None, transcript_path: Any) -> dict[str, Any] | None:
    ctx_tokens = _tail_context_tokens(transcript_path)
    if not ctx_tokens:
        return None
    ctx_k = ctx_tokens // 1000
    state = _read_state(conversation)
    shown = set(int(x) for x in (state.get("milestones_shown") or []) if isinstance(x, (int, float)))
    crossed = [m for m in _CTX_MILESTONES_K if ctx_k >= m and m not in shown]
    if not crossed:
        return None
    highest = max(crossed)
    for m in _CTX_MILESTONES_K:
        if m <= highest:
            shown.add(m)
    state["milestones_shown"] = sorted(shown)
    state["updated_at"] = time.time()
    _write_state(conversation, state)
    # 0-token user-only banner: empty systemMessage text sends nothing to the model.
    return {
        "systemMessage": {
            "systemMessage": "",
            "metadata": {
                "user_markdown": (
                    f"⚠️ 当前会话上下文已达 **{ctx_k}k tokens**（越过 {highest}k 里程碑），"
                    "继续多轮对话将成倍重放 Gemini 缓存。建议输入 `/compact` 压缩上下文，或开新对话继续。"
                )
            },
        }
    }


def session_start(payload: dict[str, Any], family: str | None) -> dict[str, Any]:
    update_host_context(payload.get("conversationId"), payload.get("workspacePaths"), gemini_family=family)
    cfg_path = _config_path()
    policy = _load_policy(cfg_path)
    profiles = _load_profiles()
    ordinary = policy.get("work_split", "balanced")
    plan = profiles.get(ordinary) or profiles["balanced"]
    target = int(plan.get("gpt_share") or 0)
    if target <= 0:
        return {}
    fam_str = f", family={family}" if family else ""
    msg = (
        f"GemPT v2 active: {ordinary} ({target}% GPT{fam_str}).\n"
        'Tools (ServerName="gempt_gempt"): '
        'gpt_run(goal,cwd,access="change"|"inspect",workspace="inherit"|"share",session_id?) | '
        'gpt_ask(goal,file_paths?,cwd?,tier?,session_id?) | '
        'gpt_ctl(action="status"|"steer"|"interrupt"|"reply",run_id?,message?,call_id?).\n'
        "Run gpt_run's returned `gempt-wait <id>` via run_command(WaitMsBeforeAsync=500); never poll status."
    )
    return {"injectSteps": [{"systemMessage": {"systemMessage": msg}}]}


def pre_invocation(payload: dict[str, Any], family: str | None) -> dict[str, Any]:
    conversation = payload.get("conversationId")
    update_host_context(conversation, payload.get("workspacePaths"), gemini_family=family)
    steps: list[dict[str, Any]] = []

    # 1. 0-token user_markdown milestone alert at 120k / 200k / 280k (fires once per threshold)
    milestone = _context_milestone_step(conversation, payload.get("transcriptPath"))
    if milestone:
        steps.append(milestone)

    # 2. Turn-entry routing (ONLY once per user turn; supports hosts indexing invocationNum from 0 or 1!)
    inv_num = payload.get("invocationNum")
    if inv_num in (0, 1):
        tkey = _turn_key(payload.get("lastUserInput"))
        init_steps = payload.get("initialNumSteps")
        entry_key = f"{init_steps if init_steps is not None else ''}:{tkey}"
        state = _read_state(conversation)
        already_emitted = bool(
            conversation and state.get("last_entry_key") == entry_key
            and (entry_key != ":" or (time.time() - float(state.get("last_entry_at") or 0)) < 15.0)
        )
        if not already_emitted:
            state["explore_count"] = 0
            if tkey:
                state["turn_key"] = tkey
            state["last_entry_key"] = entry_key
            state["last_entry_at"] = time.time()
            state["updated_at"] = time.time()
            _write_state(conversation, state)
            cfg_path = _config_path()
            policy = _load_policy(cfg_path)
            ordinary = policy.get("work_split", "balanced")
            if ordinary != "gemini" and not _is_user_override(payload) and _gpt_backend_healthy(cfg_path):
                if ordinary == "gemini_first":
                    steps.append({"systemMessage": {"systemMessage": (
                        "[GemPT 30%] Handle routine edits/reads in Gemini; route heavy debugging, long test loops, "
                        "expert review, or Swarm verification to gpt_run / gpt_ask."
                    )}})
                elif ordinary == "gpt":
                    steps.append({"systemMessage": {"systemMessage": (
                        "[GemPT 80%] Route repo investigation & code changes directly to gpt_run(cwd, access='inspect'|'change') "
                        "or gpt_ask(file_paths); keep quick Gemini checks <=5 steps."
                    )}})
                elif ordinary == "gpt_first":
                    steps.append({"systemMessage": {"systemMessage": (
                        "[GemPT 95%] Delegate this turn to a persistent gpt_run(cwd, session_id=...) thread immediately; "
                        "reserve Gemini for <=2 quick checks/visuals (for pure 95% coding workspaces, use Codex CLI / codex-lab directly)."
                    )}})
    return {"injectSteps": steps} if steps else {}


def pre_tool_use(payload: dict[str, Any], family: str | None) -> dict[str, Any]:
    result: dict[str, Any] = {"decision": "allow"}
    call = payload.get("toolCall") or {}
    args = call.get("args") or {}
    conversation = payload.get("conversationId")
    workspace = payload.get("workspacePaths")
    tool_name = str(call.get("name") or "")
    tkey = _turn_key(payload.get("lastUserInput"))

    # Keep host context fresh for GemPT Live & gpt_run/gpt_ask
    if family or conversation:
        update_host_context(conversation, workspace, gemini_family=family)

    # Legacy gempt-worker subagent metadata injection
    if tool_name == "invoke_subagent" and args.get("TypeName") == "gempt-worker":
        _reset_explore_count(conversation, tkey)
        prompt = args.get("Prompt")
        if (isinstance(conversation, str) and conversation.strip() and isinstance(prompt, str)
                and not any(line.startswith("GemPT metadata: ") for line in prompt.splitlines())):
            meta = {"host_conversation_id": conversation, "title": explicit_title(args.get("Role"))}
            result["overwrite"] = {"Prompt": prompt + "\nGemPT metadata: " + json.dumps(meta, ensure_ascii=False)}
        return result

    # MCP calls to gempt_gempt: reset exploration counter on GPT delegation, keep legacy injection for gempt_*
    if tool_name == "call_mcp_tool":
        if args.get("ServerName") == "gempt_gempt":
            tool = str(args.get("ToolName") or "")
            if tool in ("gpt_run", "gpt_ask", "gempt_dispatch", "gempt_exec", "gempt_consult"):
                _reset_explore_count(conversation, tkey)
            # Only inject legacy fields on legacy gempt_* tools (3 flat v2 tools read host-context.json directly).
            if tool.startswith("gempt_"):
                task = args.get("Arguments")
                if isinstance(task, dict):
                    updates: dict[str, Any] = {}
                    if isinstance(conversation, str) and conversation.strip() and tool in ("gempt_dispatch", "gempt_exec", "gempt_live_view", "gempt_status"):
                        parent = task.get("host_conversation_id")
                        if not parent and (tool != "gempt_status" or not task.get("run_id")):
                            updates["host_conversation_id"] = conversation
                        elif isinstance(parent, str) and parent != conversation and tool not in ("gempt_live_view", "gempt_status"):
                            update_host_context(conversation, workspace, parent_id=parent, gemini_family=family)
                    if (tool in ("gempt_dispatch", "gempt_consult", "gempt_exec") and family
                            and not task.get("tier") and not task.get("session_id")
                            and task.get("role") in (None, "solo", "coordinator", "narrator")
                            and task.get("gemini_family") != family):
                        updates["gemini_family"] = family
                    if updates:
                        result["overwrite"] = {"Arguments": {**task, **updates}}
        return result

    cfg_path = _config_path()
    policy = _load_policy(cfg_path)
    ordinary = policy.get("work_split", "balanced")

    # 0% (gemini) & 30% (gemini_first): strictly ZERO PreToolUse deny.
    if ordinary in ("gemini", "gemini_first"):
        return result

    # Escape hatch: user explicitly asked Gemini to do it directly.
    if _is_user_override(payload):
        return result

    # Automatic fail-open: never block Gemini when Codex app-server is down or circuit breaker is open.
    if not _gpt_backend_healthy(cfg_path):
        return result

    # 50% / 80% / 95%: Source-code write gate (exempts docs, brain/whitelist, and small <=15-line configs).
    if tool_name in _WRITE_TOOLS:
        deny_write, target = _is_source_write(args)
        if deny_write:
            cwd = _effective_cwd(payload, target)
            pct = {"balanced": 50, "gpt": 80, "gpt_first": 95}.get(ordinary, 50)
            return {
                "decision": "deny",
                "reason": (
                    f"[GemPT {pct}% Write Gate] Source edit ({Path(target).name}) routed to Codex. "
                    f'Call call_mcp_tool(ServerName="gempt_gempt", ToolName="gpt_run", Arguments={{"goal": "Edit {target}: <change & verify>", "cwd": "{cwd}", "access": "change"}}) '
                    "then run the returned `gempt-wait <id>` via run_command(WaitMsBeforeAsync=500). "
                    '(User can say "自己改" to bypass.)'
                ),
            }
        return result

    # 50% (balanced): strictly ZERO read/command blocking.
    if ordinary == "balanced":
        return result

    # 80% (gpt, Option A: allow 5 checks/turn) & 95% (gpt_first: allow 2 checks/turn, never 0)
    limit = _EXPLORE_LIMIT_80 if ordinary == "gpt" else _EXPLORE_LIMIT_95
    is_explore = False
    if tool_name in _READ_TOOLS:
        raw_path = _extract_path(args)
        if not _is_exempt_path(raw_path):
            is_explore = True
    elif tool_name == "run_command":
        if _is_read_command(args):
            is_explore = True

    if not is_explore:
        return result

    count = _bump_explore_count(conversation, tkey)
    if count <= limit:
        return result

    cwd = _effective_cwd(payload, _extract_path(args))
    pct = 80 if ordinary == "gpt" else 95
    extra = " For pure 95% coding workspaces, prefer Codex CLI / codex-lab directly." if pct == 95 else ""
    return {
        "decision": "deny",
        "reason": (
            f"[GemPT {pct}% Explore Stop-Loss] {count} non-exempt workspace reads/searches this turn (limit {limit}). "
            f'Dispatch deep inspection to Codex: call_mcp_tool(ServerName="gempt_gempt", ToolName="gpt_run", Arguments={{"goal": "<what to inspect>", "cwd": "{cwd}", "access": "inspect"}}) '
            f'then run returned `gempt-wait <id>` via run_command(WaitMsBeforeAsync=500).{extra} (Say "自己查" to bypass.)'
        ),
    }


def main() -> int:
    payload = json.load(sys.stdin.buffer)
    family = native_family(payload.get("modelName"))
    event = str(payload.get("hookEventName") or "")
    if "toolCall" in payload or event == "PreToolUse":
        response = pre_tool_use(payload, family)
    elif event == "SessionStart":
        response = session_start(payload, family)
    else:
        response = pre_invocation(payload, family)
    print(json.dumps(response))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
