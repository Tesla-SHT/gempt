"""Stage, validate, and install the standalone Antigravity plugin."""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
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
    for handler in (hooks["PreInvocation"][0], hooks["PreToolUse"][0]["hooks"][0]):
        if handler.get("type") != "command":
            raise ValueError("Expected a command handler in Antigravity hooks.json.")
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
    requests = "".join(json.dumps(request) + "\n" for request in (initialize, read_app))
    server = subprocess.run([mcp["command"], *mcp["args"]], input=requests, env=env, **options)
    if server.returncode or not server.stdout:
        raise ValueError(f"Staged Antigravity MCP server failed to start: {server.stderr.strip()}")
    responses = {packet["id"]: packet for packet in map(json.loads, server.stdout.splitlines())}
    if responses.get(1, {}).get("result", {}).get("serverInfo", {}).get("name") != "gempt":
        raise ValueError("Staged Antigravity MCP server did not identify itself as gempt.")
    contents = responses.get(2, {}).get("result", {}).get("contents", [])
    if not contents or contents[0].get("mimeType") != APP_RESOURCE["mimeType"] or not contents[0].get("text"):
        raise ValueError("Staged Antigravity MCP server could not read the bundled GemPT Live app.")

    hook = subprocess.run(
        [mcp["command"], "-I", "-X", "utf8", "-B", str(staged / "work_split_hook.py")],
        input="{}", env={**os.environ, "GEMPT_CONFIG": str(staged / "no-local-config.json")}, **options,
    )
    if hook.returncode or not hook.stdout:
        raise ValueError(f"Staged Antigravity hook failed to start: {hook.stderr.strip()}")
    if not json.loads(hook.stdout).get("injectSteps"):
        raise ValueError("Staged Antigravity hook did not return a work-split reminder.")


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
                    target.replace(backup)
                staged.replace(target)
            except BaseException:
                if backup.exists() and not target.exists():
                    try:
                        backup.replace(target)
                    except OSError as exc:
                        keep_backup = True
                        raise OSError(f"Could not restore {target}. Previous installation saved at {backup}.") from exc
                raise
            return mcp_config
        finally:
            if not keep_backup:
                shutil.rmtree(workspace, ignore_errors=True)
