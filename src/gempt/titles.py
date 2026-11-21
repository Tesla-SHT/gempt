"""Display titles for new and historical work. Keep in sync with backend.mjs."""

import re

_SPACE = re.compile(r"[\s\ufeff]+")
_GOAL_SECTION = re.compile(r"^#{1,6}[ \t]+(?:Goal|任务目标|目标)[:：]?[ \t]*$", re.I | re.M)
_PREFIX = re.compile(
    r"^(?:[ \t]*(?:#{1,6}[ \t]+|[-*+>][ \t]+|[0-9]+[.)][ \t]+)"
    r"|(?:用户反馈|任务目标|目标|需求|Goal)\s*[:：]\s*"
    r"|请?在(?:你当前分配的|当前分配的|当前的?)?(?:隔离)?\s*"
    r"(?:工作区|工作目录|worktree)[^\n。]*?[中内里][：:,，]?\s*(?:[（(][^\n）)]*[）)]\s*)?"
    r"|请?(?:先|帮我|协助我|麻烦你)\s*|请\s*"
    r"|(?:[`'\"“‘](?:[a-z]:[\\/]|[\\/]{1,2}|~/)[^`'\"”’]+[`'\"”’]"
    r"|(?:[a-z]:[\\/]|[\\/]{1,2}|~/)[^\s：:,，。；;]+)(?:\s+|[：:,，·—–-]+\s*|$))",
    re.I,
)


def workspace_name(cwd):
    if not isinstance(cwd, str):
        return ""
    return re.split(r"[/\\]+", cwd.rstrip("/\\"))[-1]


def _shorten(text, limit):
    return text if len(text) <= limit else text[:limit - 1].rstrip() + "…"


def explicit_title(title):
    return _shorten(_SPACE.sub(" ", title).strip(), 48) if isinstance(title, str) else ""


def normalize_title(title=None, goal=None, cwd=None):
    if name := explicit_title(title):
        return name
    text = goal.replace("\r\n", "\n").replace("\r", "\n") if isinstance(goal, str) else ""
    text = re.sub(r"(?ms)^[ \t]*```[^\n]*\n.*?(?:^[ \t]*```[^\n]*(?:\n|$)|\Z)", "", text)
    if section := _GOAL_SECTION.search(text):
        text = text[section.end():]
    text = re.sub(r"(?im)^\s*You are executing a task delegated by[^\n]*?(?:\.(?=\s|$)|\n|$)", "", text)
    for line in text.splitlines():
        line = _SPACE.sub(" ", line).strip()
        while line and (stripped := _PREFIX.sub("", line, count=1).lstrip()) != line:
            line = stripped
        line = re.split(r"[。！？!?；;]|\.(?= |$)", line.replace("`", ""), maxsplit=1)[0]
        intent = line.strip(" #：:，,·—–-")
        if intent:
            prefix = _shorten(workspace_name(cwd), 16)
            return _shorten(f"{prefix} · {intent}" if prefix else intent, 32)
    return _shorten(workspace_name(cwd), 32) or "GPT 任务"


def session_goal(record):
    if isinstance(record.get("goal"), str) and record["goal"].strip():
        return record["goal"]
    details = record.get("turn_details") or {}
    index = 0
    turns = record.get("turns")
    for turn in turns if isinstance(turns, list) else []:
        if not isinstance(turn, dict) or turn.get("role") not in (None, "user"):
            continue
        index += 1
        detail = details.get(str(index), {}) if isinstance(details, dict) else {}
        goal = (detail.get("goal") if isinstance(detail, dict) else None) or turn.get("goal")
        goal = goal or turn.get("prompt") or turn.get("content")
        if isinstance(goal, str) and goal.strip():
            return goal
    return ""
