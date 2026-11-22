"""Stage, validate, and install the standalone Antigravity plugin."""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from importlib.resources import files
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .mcp_app import APP_RESOURCE, APP_URI
from .sessions import exclusive_operation

if TYPE_CHECKING:
    from importlib.resources.abc import Traversable

DEFAULT_AGY_TARGET = Path.home() / ".gemini" / "config" / "plugins" / "gempt"
_REQUIRED_ASSETS = (
    "plugin.json", "mcp_config.json", "hooks.json", "work_split_hook.py",
    "rules/AGENTS.md", "agents/gempt-worker.md",
    "skills/gempt/SKILL.md", "skills/gempt-sonnet/SKILL.md", "skills/gempt-opus/SKILL.md",
    "skills/gempt-fable/SKILL.md", "skills/gempt-chore/SKILL.md",
    "templates/gempt.config.example.json", "templates/magpie-groups.template.json",
    "runtime/gempt/mcp_app_live.html",
)


def build_mcp_config(runtime: Path) -> dict[str, Any]:
    # uvx and venv entry points live in disposable environments. GemPT has no
    # third-party dependencies and can run with their base Python directly.
    python = Path(sys._base_executable or sys.executable).resolve(strict=True)
    runtime_root = str(runtime.absolute())
    return {
        "mcpServers": {
            "gempt": {
                "command": str(python),
                "args": [
                    "-I", "-X", "utf8", "-B", "-c",
                    "import runpy,sys;sys.path.insert(0,sys.argv.pop(1));"
                    "runpy.run_module('gempt.mcp_server',run_name='__main__')",
                    runtime_root,
                ],
                "env": {"PYTHONPATH": runtime_root, "PYTHONUTF8": "1"},
            }
        }
    }


def _copy_resources(source: Traversable, target: Path) -> None:
    target.mkdir(parents=True, exist_ok=True)
    for item in source.iterdir():
        if item.name.startswith(".") or item.name in {"__pycache__", "node_modules"}:
            continue
        dest = target / item.name
        if item.is_dir():
            _copy_resources(item, dest)
        elif item.is_file() and not item.name.endswith((".pyc", ".pyo")):
            dest.write_bytes(item.read_bytes())


def _stage_plugin(staged: Path, source: Path | None) -> None:
    package = files("gempt")
    bundled = package.joinpath("plugin_data")
    if bundled.is_dir():
        plugin, templates, readme = bundled, bundled.joinpath("templates"), None
    else:
        # Source runs use the same inputs setuptools puts under plugin_data.
        repo = Path(__file__).resolve().parents[2]
        plugin, templates, readme = repo / "plugin", repo / "templates", repo / "README.md"
    if source is not None:
        plugin = source
        if source.joinpath("templates").is_dir():
            templates = source.joinpath("templates")
        readme = source / "README.md"

    staged.mkdir()
    for name in ("plugin.json", "mcp_config.json", "hooks.json", "work_split_hook.py"):
        (staged / name).write_bytes(plugin.joinpath(name).read_bytes())
    for folder in ("rules", "agents", "skills", "assets"):
        directory = plugin.joinpath(folder)
        if directory.is_dir():
            _copy_resources(directory, staged / folder)
    _copy_resources(templates, staged / "templates")
    if readme is not None and readme.is_file():
        shutil.copyfile(readme, staged / "README.md")

    runtime_pkg = staged / "runtime" / "gempt"
    runtime_pkg.mkdir(parents=True)
    for item in package.iterdir():
        if item.is_file() and (item.name.endswith(".py") or item.name in {"workload.json", "mcp_app_live.html"}):
            (runtime_pkg / item.name).write_bytes(item.read_bytes())


def _write_launchers(staged: Path, target: Path) -> dict[str, Any]:
    mcp_config = build_mcp_config(target / "runtime")
    (staged / "mcp_config.json").write_text(json.dumps(mcp_config, indent=2) + "\n", encoding="utf-8")
    python = mcp_config["mcpServers"]["gempt"]["command"]
    hook_argv = [python, "-I", "-X", "utf8", "-B", str(target / "work_split_hook.py")]
    command = subprocess.list2cmdline(hook_argv) if os.name == "nt" else shlex.join(hook_argv)
    hook_file = staged / "hooks.json"
    config = json.loads(hook_file.read_text(encoding="utf-8"))
    hooks = config["gempt-work-split"]
    for entries in hooks.values():
        for entry in entries:
            for handler in entry.get("hooks", [entry]):
                if handler.get("type") == "command":
                    handler["command"] = command
    hook_file.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    return mcp_config


def _validate_staged(staged: Path) -> None:
    for name in _REQUIRED_ASSETS:
        if not (staged / name).is_file() or not (staged / name).stat().st_size:
            raise ValueError(f"Missing or empty Antigravity plugin asset: {name}")
    manifest = json.loads((staged / "plugin.json").read_text(encoding="utf-8"))
    if manifest.get("name") != "gempt":
        raise ValueError("Expected Antigravity plugin manifest name 'gempt'.")
    for template in (staged / "templates").glob("*.json"):
        json.loads(template.read_text(encoding="utf-8"))

    mcp = build_mcp_config(staged / "runtime")["mcpServers"]["gempt"]
    initialize = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}}
    read_app = {"jsonrpc": "2.0", "id": 2, "method": "resources/read", "params": {"uri": APP_URI}}
    options = dict(cwd=staged, encoding="utf-8", capture_output=True, timeout=20,
                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    env = os.environ.copy()
    env.pop("GEMPT_APP_HTML", None)
    read_tools = {"jsonrpc": "2.0", "id": 3, "method": "tools/list", "params": {}}
    requests = "".join(json.dumps(request) + "\n" for request in (initialize, read_app, read_tools))
    server = subprocess.run([mcp["command"], *mcp["args"]], input=requests, env=env, **options)
    if server.returncode or not server.stdout:
        raise ValueError(f"Staged Antigravity MCP server failed to start: {server.stderr.strip()}")
    responses = {packet["id"]: packet for packet in map(json.loads, server.stdout.splitlines())}
    if responses.get(1, {}).get("result", {}).get("serverInfo", {}).get("name") != "gempt":
        raise ValueError("Staged Antigravity MCP server did not identify itself as gempt.")
    contents = responses.get(2, {}).get("result", {}).get("contents", [])
    if not contents or contents[0].get("mimeType") != APP_RESOURCE["mimeType"] or not contents[0].get("text"):
        raise ValueError("Staged Antigravity MCP server could not read the bundled GemPT Live app.")
    tool_names = [t.get("name") for t in responses.get(3, {}).get("result", {}).get("tools", [])]
    for required_tool in ("gpt_run", "gpt_ask", "gpt_ctl"):
        if required_tool not in tool_names:
            raise ValueError(f"Staged Antigravity MCP server missing required tool: {required_tool}")

    hook = subprocess.run(
        [mcp["command"], "-I", "-X", "utf8", "-B", str(staged / "work_split_hook.py")],
        input=json.dumps({"hookEventName": "SessionStart", "modelName": "gemini-4-neon-high"}),
        env={**os.environ, "GEMPT_CONFIG": str(staged / "no-local-config.json")}, **options,
    )
    if hook.returncode or not hook.stdout:
        raise ValueError(f"Staged Antigravity hook failed to start: {hook.stderr.strip()}")
    parsed_hook = json.loads(hook.stdout)
    steps = parsed_hook.get("injectSteps") or []
    if not steps or "systemMessage" not in steps[0]:
        raise ValueError("Staged Antigravity SessionStart hook did not return a systemMessage.")


def install_wait_shim(target: Path, python_exe: str, bin_dir: Path | None = None) -> list[str]:
    """Install short `gempt-wait` (and `gempt-wait.cmd` on Windows) shims into ~/bin."""
    dest_dir = bin_dir or (Path.home() / "bin")
    dest_dir.mkdir(parents=True, exist_ok=True)
    runtime_root = str((target / "runtime").resolve())
    helper_py = dest_dir / "gempt-wait.py"
    helper_code = (
        "#!/usr/bin/env python3\n"
        '"""Short zero-poll waiter shim for GemPT v2 (`gempt-wait <run_id>` or `gempt-wait [--all] id1,id2`)."""\n'
        "import sys\n"
        f"sys.path.insert(0, {runtime_root!r})\n"
        "from gempt.cli import main\n"
        "raw = [a for a in sys.argv[1:] if a != '--wait']\n"
        "wait_all = '--all' in raw or '--wait-all' in raw\n"
        "ids = [a for a in raw if not a.startswith('-')]\n"
        "if not ids:\n"
        "    sys.stderr.write('usage: gempt-wait [--all] <run_id[,run_id2,...]>\\n')\n"
        "    raise SystemExit(2)\n"
        "joined = ','.join(part.strip() for item in ids for part in item.split(',') if part.strip())\n"
        "if ',' in joined:\n"
        "    cli_args = ['status', '--run-ids', joined, '--wait', *(['--wait-all'] if wait_all else [])]\n"
        "else:\n"
        "    cli_args = ['status', '--run-id', joined, '--wait']\n"
        "raise SystemExit(main(cli_args))\n"
    )
    helper_py.write_text(helper_code, encoding="utf-8")
    written = [str(helper_py)]

    posix_shim = dest_dir / "gempt-wait"
    posix_shim.write_text(
        f'#!/usr/bin/env sh\nexec "{python_exe}" -I -X utf8 -B "{helper_py}" "$@"\n',
        encoding="utf-8",
    )
    try:
        os.chmod(posix_shim, 0o755)
    except OSError:
        pass
    written.append(str(posix_shim))

    if os.name == "nt":
        cmd_shim = dest_dir / "gempt-wait.cmd"
        cmd_shim.write_text(
            f'@echo off\r\n"{python_exe}" -I -X utf8 -B "{helper_py}" %*\r\n',
            encoding="utf-8",
        )
        written.append(str(cmd_shim))
    return written


def refresh_mcp_server(server_name: str = "gempt_gempt") -> dict[str, Any]:
    """Best-effort Antigravity MCP server reload via local LanguageServerService."""
    csrf = os.environ.get("ANTIGRAVITY_CSRF_TOKEN", "").strip()
    addr = os.environ.get("ANTIGRAVITY_LS_ADDRESS", "").strip() or "localhost:5387"
    if not csrf:
        return {"refreshed": False, "reason": "ANTIGRAVITY_CSRF_TOKEN not present in environment"}
    url = f"http://{addr}/exa.language_server_pb.LanguageServerService/RefreshMcpServers"
    data = json.dumps({"serverName": server_name}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", "x-codeium-csrf-token": csrf},
        method="POST",
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=3) as resp:
            return {"refreshed": 200 <= resp.status < 300, "status": resp.status, "url": url}
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        return {"refreshed": False, "reason": str(exc), "url": url}


def _sync_in_place(staged: Path, target: Path) -> None:
    """Fallback when Windows denies renaming an active plugin directory (WinError 5/32)."""
    target.mkdir(parents=True, exist_ok=True)
    expected_files: set[Path] = set()
    for src in staged.rglob("*"):
        rel = src.relative_to(staged)
        dst = target / rel
        if src.is_dir():
            dst.mkdir(parents=True, exist_ok=True)
        elif src.is_file():
            expected_files.add(rel)
            dst.parent.mkdir(parents=True, exist_ok=True)
            tmp = dst.with_name(f".{dst.name}.{os.getpid()}.tmp")
            tmp.write_bytes(src.read_bytes())
            tmp.replace(dst)
    # Remove stale files/dirs (like legacy sidecars/) without failing on locked caches.
    for existing in sorted(target.rglob("*"), key=lambda p: len(p.parts), reverse=True):
        rel = existing.relative_to(target)
        if "__pycache__" in rel.parts:
            continue
        if existing.is_file() and rel not in expected_files:
            try:
                existing.unlink()
            except OSError:
                pass
        elif existing.is_dir() and not (staged / rel).is_dir():
            try:
                existing.rmdir()
            except OSError:
                pass


def install_agy(target: Path, *, source: Path | None = None, force: bool = False) -> dict[str, Any]:
    if any(path.resolve().is_relative_to(target) for path in (Path(__file__), Path(sys._base_executable or sys.executable))):
        raise ValueError(f"Target {target} contains the running GemPT package or its base Python interpreter.")
    with exclusive_operation(target.parent / f".{target.name}-install.lock"):
        if target.exists() and not force:
            try:
                manifest = json.loads((target / "plugin.json").read_text(encoding="utf-8"))
            except (OSError, ValueError):
                manifest = None
            if not isinstance(manifest, dict) or manifest.get("name") != "gempt":
                raise ValueError(f"Target {target} is not an existing GemPT plugin. Use --force or another --target.")

        workspace = Path(tempfile.mkdtemp(prefix=f".{target.name}-install-", dir=target.parent))
        staged, backup = workspace / "plugin", workspace / "previous"
        keep_backup = False
        try:
            _stage_plugin(staged, source)
            mcp_config = _write_launchers(staged, target)
            _validate_staged(staged)

            try:
                if target.exists():
                    try:
                        target.replace(backup)
                        staged.replace(target)
                    except PermissionError as exc:
                        if os.name != "nt" or getattr(exc, "winerror", None) not in {5, 32} or backup.exists():
                            raise
                        _sync_in_place(staged, target)
                else:
                    staged.replace(target)
            except BaseException:
                if backup.exists() and not target.exists():
                    try:
                        backup.replace(target)
                    except OSError as exc:
                        keep_backup = True
                        raise OSError(f"Could not restore {target}. Previous installation saved at {backup}.") from exc
                raise
            if target.resolve() == DEFAULT_AGY_TARGET.resolve():
                try:
                    install_wait_shim(target, mcp_config["mcpServers"]["gempt"]["command"])
                except OSError:
                    pass
                mcp_config = {**mcp_config, "_refresh": refresh_mcp_server("gempt_gempt")}
            return mcp_config
        finally:
            if not keep_backup:
                shutil.rmtree(workspace, ignore_errors=True)
