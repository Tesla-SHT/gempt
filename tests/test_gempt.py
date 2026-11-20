"""Unit and integration tests for gempt (Python stdlib unittest only)."""

from __future__ import annotations

import contextlib
import io
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC_ROOT = REPO_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from gempt.cli import main as cli_main
from gempt.codex_runner import build_cli_invocation, run_codex_exec
from gempt.config import (
    ConfigError,
    ConfigNotFoundError,
    default_config_template,
    get_default_tier,
    load_config,
    redact_config,
    resolve_tier,
    save_config,
    validate_config,
)
from gempt.discover import build_tier_recommendations, probe_magpie_gateway
from gempt.magpie_client import MagpieRequestError, _group_members, consult_with_fallback, sync_magpie_groups
from gempt.mcp_server import _handle_tool_call
from gempt.presets import apply_native_presets, build_native_preset_commands, strip_model_modifiers
from gempt.protocol import build_consult_prompt, build_exec_prompt, read_context_files
from gempt.runs import recent_runs, verification_result
from gempt.routing import build_escalation_suggestion, classify_task_effort, effort_timeout_floor
from gempt.service import (
    configure_gempt,
    run_consult,
    run_exec,
    set_auto_effort,
    set_default_sandbox,
    set_default_tier,
    set_tier_effort,
)
from gempt.sessions import list_sessions, load_session, save_session


class ConfigTests(unittest.TestCase):
    def test_missing_config_raises(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "nonexistent.json"
            with self.assertRaises(ConfigNotFoundError):
                load_config(explicit=missing, require_exists=True)

    def test_save_load_redact_and_tier_resolution(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cfg_path = Path(tmp) / "gempt.json"
            cfg = default_config_template()
            cfg["magpie"]["api_key"] = "sk-secret-value-123"
            save_config(cfg, path=cfg_path)

            loaded, resolved = load_config(explicit=cfg_path, require_exists=True)
            self.assertEqual(resolved, cfg_path.resolve())
            redacted = redact_config(loaded)
            self.assertEqual(redacted["magpie"]["api_key"], "***redacted***")

            # Canonical tiers and legacy aliases
            sonnet = resolve_tier(loaded, "sonnet")
            self.assertEqual(sonnet["model"], "codex/gpt-6.2-sol")
            self.assertEqual(resolve_tier(loaded, "lite")["tier"], "sonnet")

            # Opus normal vs escalation (sweet spot: Sol@high -> Astra@xhigh)
            opus_normal = resolve_tier(loaded, "opus")
            self.assertEqual(opus_normal["model"], "codex/gpt-6.2-sol")
            self.assertEqual(opus_normal["reasoning_effort"], "high")
            self.assertFalse(opus_normal["escalated"])

            opus_esc = resolve_tier(loaded, "opus", escalate=True)
            self.assertEqual(opus_esc["model"], "codex/gpt-6.2-astra")
            self.assertEqual(opus_esc["reasoning_effort"], "xhigh")
            self.assertTrue(opus_esc["escalated"])

            opus_high = resolve_tier(loaded, "opus", effort_override="high")
            self.assertEqual(opus_high["model"], "codex/gpt-6.2-sol")
            self.assertFalse(opus_high["escalated"])

            opus_xhigh = resolve_tier(loaded, "opus", effort_override="xhigh")
            self.assertEqual(opus_xhigh["model"], "codex/gpt-6.2-astra")
            self.assertTrue(opus_xhigh["escalated"])

            fable_default = resolve_tier(loaded, "fable")
            self.assertEqual(fable_default["model"], "codex/gpt-6.2-astra")
            self.assertEqual(fable_default["reasoning_effort"], "xhigh")

            # Chore consult allowed, chore exec disallowed
            chore = resolve_tier(loaded, "chore")
            self.assertEqual(chore["model"], "auto/deepseek-v4.1-flash")
            self.assertEqual(chore["api_mode"], "chat")
            with self.assertRaises(Exception):
                resolve_tier(loaded, "chore", for_exec=True)

    def test_excluded_models_validation(self) -> None:
        cfg = default_config_template()
        cfg["routing_policy"]["excluded_models"] = ["gemini-4-argon"]
        validate_config(cfg)

        for bad in ("gemini-4-argon", [123], {"a": "b"}):
            bad_cfg = default_config_template()
            bad_cfg["routing_policy"]["excluded_models"] = bad
            with self.assertRaises(ConfigError):
                validate_config(bad_cfg)

    def test_default_tier_sandbox_and_failover_modes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cfg_path = Path(tmp) / "gempt.json"
            cfg = default_config_template()
            cfg["magpie"]["api_key"] = "sk-keep-me"
            cfg["routing_policy"]["failover_mode"] = "api_fallback"
            cfg["routing_policy"]["default_tier"] = "max"
            save_config(cfg, path=cfg_path)

            loaded, _ = load_config(explicit=cfg_path, require_exists=True)
            self.assertEqual(get_default_tier(loaded), "fable")
            self.assertEqual(resolve_tier(loaded, None)["tier"], "fable")
            self.assertEqual(resolve_tier(loaded, "")["tier"], "fable")

            bad_mode_cfg = default_config_template()
            bad_mode_cfg["routing_policy"]["failover_mode"] = "invalid_mode"
            with self.assertRaises(ConfigError):
                validate_config(bad_mode_cfg)
            with self.assertRaises(ConfigError):
                configure_gempt(config_path=cfg_path, failover_mode="invalid_mode")

            for bad_default in ("chore", "unknown", 42):
                bad_cfg = default_config_template()
                bad_cfg["routing_policy"]["default_tier"] = bad_default
                with self.assertRaises(ConfigError):
                    validate_config(bad_cfg)

            with self.assertRaises(ConfigError):
                set_default_tier("chore", config_path=cfg_path)
            with self.assertRaises(ConfigError):
                set_default_sandbox("invalid-mode", config_path=cfg_path)

            res = set_default_tier("opus", config_path=cfg_path)
            self.assertTrue(res["saved"])
            self.assertEqual(res["default_tier"], "opus")

            sbx_res = set_default_sandbox("read-only", config_path=cfg_path)
            self.assertTrue(sbx_res["saved"])
            self.assertEqual(sbx_res["default_sandbox"], "read-only")

            reloaded, _ = load_config(explicit=cfg_path, require_exists=True)
            self.assertEqual(reloaded["routing_policy"]["default_tier"], "opus")
            self.assertEqual(reloaded["codex"]["default_sandbox"], "read-only")
            self.assertEqual(reloaded["magpie"]["api_key"], "sk-keep-me")

            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = cli_main(["tier", "--config", str(cfg_path), "--json"])
            self.assertEqual(rc, 0)
            self.assertEqual(json.loads(buf.getvalue())["default_tier"], "opus")

            buf2 = io.StringIO()
            with contextlib.redirect_stdout(buf2):
                rc2 = cli_main(["tier", "fable", "--config", str(cfg_path), "--json"])
            self.assertEqual(rc2, 0)
            self.assertEqual(json.loads(buf2.getvalue())["default_tier"], "fable")

            buf3 = io.StringIO()
            with contextlib.redirect_stdout(buf3):
                rc3 = cli_main(["sandbox", "workspace-write", "--config", str(cfg_path), "--json"])
            self.assertEqual(rc3, 0)
            self.assertEqual(json.loads(buf3.getvalue())["default_sandbox"], "workspace-write")

            buf4 = io.StringIO()
            with contextlib.redirect_stdout(buf4):
                rc4 = cli_main(["sandbox", "--config", str(cfg_path), "--json"])
            self.assertEqual(rc4, 0)
            self.assertEqual(json.loads(buf4.getvalue())["default_sandbox"], "workspace-write")

            with self.assertRaises(ConfigError):
                set_tier_effort("low", tier="fable", config_path=cfg_path)
            with self.assertRaises(ConfigError):
                set_tier_effort("ultra", tier="opus", config_path=cfg_path)

            eff_auto = set_auto_effort(True, config_path=cfg_path)
            self.assertTrue(eff_auto["auto_effort"])

            buf5 = io.StringIO()
            with contextlib.redirect_stdout(buf5):
                rc5 = cli_main(["effort", "high", "--tier", "opus", "--config", str(cfg_path), "--json"])
            self.assertEqual(rc5, 0)
            parsed_eff = json.loads(buf5.getvalue())
            self.assertEqual(parsed_eff["tier"], "opus")
            self.assertEqual(parsed_eff["reasoning_effort"], "high")
            self.assertFalse(parsed_eff["auto_effort"])

            buf6 = io.StringIO()
            with contextlib.redirect_stdout(buf6):
                rc6 = cli_main(["effort", "auto", "--config", str(cfg_path), "--json"])
            self.assertEqual(rc6, 0)
            self.assertTrue(json.loads(buf6.getvalue())["auto_effort"])


class DiscoverTests(unittest.TestCase):
    def test_recommendations_exclude_forbidden_model_and_build_presets(self) -> None:
        catalog = {
            "codex_subscription_models": [
                {"id": "codex/gpt-6.2-sol"},
                {"id": "codex/gpt-6.2-astra"},
                {"id": "codex/gpt-6.1-terra"},
            ],
            "openai_api_models": [
                {"id": "openai/gpt-6.1-sol"},
                {"id": "openai/gpt-6-astra"},
            ],
            "other_gpt_models": [],
            "utility_candidates": [
                {"id": "auto/deepseek-v4.1-flash"},
                {"id": "workbuddy/deepseek-v4.1-flash"},
            ],
        }
        recs = build_tier_recommendations(catalog)
        self.assertTrue(recs["available"])
        self.assertEqual(recs["utility_model"], "auto/deepseek-v4.1-flash")
        self.assertIn("subscription_only", recs["presets"])
        self.assertIn("api_fallback", recs["presets"])
        self.assertIn("effort_only", recs["presets"])
        sub = recs["presets"]["subscription_only"]["tiers"]
        self.assertEqual(sub["sonnet"]["consult_model"], "codex/gpt-6.2-sol")
        self.assertEqual(sub["sonnet"]["reasoning_effort"], "medium")
        self.assertEqual(sub["opus"]["consult_model"], "codex/gpt-6.2-sol")
        self.assertEqual(sub["opus"]["escalate_model"], "codex/gpt-6.2-astra")
        self.assertEqual(sub["opus"]["reasoning_effort"], "high")
        self.assertEqual(sub["opus"]["escalate_effort_threshold"], "xhigh")
        self.assertEqual(sub["fable"]["consult_model"], "codex/gpt-6.2-astra")
        self.assertEqual(sub["fable"]["reasoning_effort"], "xhigh")

        api_fb = recs["presets"]["api_fallback"]["tiers"]
        self.assertIn("openai/gpt-6-astra", api_fb["fable"]["fallback_models"])

        effort_only = recs["presets"]["effort_only"]["tiers"]
        self.assertEqual(effort_only["sonnet"]["consult_model"], "codex/gpt-6.2-sol")
        self.assertEqual(effort_only["sonnet"]["reasoning_effort"], "medium")
        self.assertEqual(effort_only["opus"]["consult_model"], "codex/gpt-6.2-sol")
        self.assertEqual(effort_only["opus"]["reasoning_effort"], "high")
        self.assertEqual(effort_only["fable"]["consult_model"], "codex/gpt-6.2-sol")
        self.assertEqual(effort_only["fable"]["reasoning_effort"], "xhigh")

        api_only_recs = build_tier_recommendations({**catalog, "codex_subscription_models": []})
        self.assertTrue(api_only_recs["available"])
        self.assertFalse(api_only_recs["presets"]["subscription_only"]["tiers"])

    def test_probe_filters_forbidden_model(self) -> None:
        fake_payload = {
            "data": [
                {"id": "opencode-go/gemini-4-argon", "owned_by": "opencode-go", "magpie_label": "Gemini 4 Argon"},
                {"id": "auto/gemini-4-argon", "owned_by": "opencode-go", "magpie_label": "Gemini 4 Argon · routing group"},
                {"id": "group/gempt-sonnet", "owned_by": "magpie", "magpie_label": "GemPT Sonnet · routing group"},
                {"id": "group/gempt-harness-sonnet", "owned_by": "magpie", "magpie_label": "gempt harness sonnet · routing group"},
                {"id": "codex/gpt-6.2-sol", "owned_by": "codex", "magpie_label": "GPT-6.2-Sol · Codex"},
                {"id": "auto/deepseek-v4.1-flash", "owned_by": "opendesign", "magpie_label": "DeepSeek · routing group"},
            ]
        }

        class FakeResp:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return json.dumps(fake_payload).encode("utf-8")

        class FakeOpener:
            def open(self, req, timeout=8):
                return FakeResp()

        with mock.patch("gempt.discover.build_opener", return_value=FakeOpener()):
            with mock.patch.dict(os.environ, {"GEMPT_EXCLUDED_MODELS": ""}):
                default_out = probe_magpie_gateway("http://127.0.0.1:3425")
                self.assertIn("auto/gemini-4-argon", [g["id"] for g in default_out["routing_groups"]])
                self.assertEqual([g["id"] for g in default_out["native_gempt_groups"]], ["group/gempt-sonnet"])
                self.assertEqual([g["id"] for g in default_out["gempt_groups"]], ["group/gempt-harness-sonnet"])
                self.assertEqual(len(default_out["codex_subscription_models"]), 1)
                self.assertEqual(default_out["utility_candidates"][0]["id"], "auto/deepseek-v4.1-flash")

                cfg_filtered = probe_magpie_gateway(
                    "http://127.0.0.1:3425",
                    excluded_models=["gemini-4-argon"],
                )
                self.assertNotIn("gemini-4-argon", json.dumps(cfg_filtered))

            with mock.patch.dict(os.environ, {"GEMPT_EXCLUDED_MODELS": "gemini-4-argon"}):
                env_filtered = probe_magpie_gateway("http://127.0.0.1:3425")
                self.assertNotIn("gemini-4-argon", json.dumps(env_filtered))


class ProtocolAndSessionsTests(unittest.TestCase):
    def test_read_context_files_handles_text_truncation_and_binary(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            txt = root / "sample.py"
            txt.write_text("line1\nline2\nline3\n", encoding="utf-8")
            binf = root / "blob.bin"
            binf.write_bytes(b"\x00\x01\x02\x03")

            blocks, warnings = read_context_files(
                ["sample.py", "blob.bin", "missing.txt"],
                cwd=root,
                max_file_bytes=12,
                max_total_bytes=100,
            )
            self.assertEqual(len(blocks), 1)
            self.assertIn("1: line1", blocks[0]["content"])
            self.assertIn("[truncated at 12 bytes", blocks[0]["content"])
            self.assertTrue(any("binary" in w for w in warnings))
            self.assertTrue(any("missing" in w for w in warnings))

            prompt = build_consult_prompt(goal="Analyze bug", file_blocks=blocks, constraints="No deps")
            self.assertIn("## Goal", prompt)
            self.assertIn("## Hard Constraints", prompt)
            self.assertIn("## Referenced Files", prompt)

            exec_p = build_exec_prompt(goal="Fix bug", verification="pytest -q", is_resume=False)
            self.assertIn("## Required Verification", exec_p)

    def test_sessions_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            rec = {
                "session_id": "consult-20261119-abc123",
                "mode": "consult",
                "tier": "opus",
                "model": "codex/gpt-6.2-sol",
                "turns": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "ok"}],
            }
            save_session(rec, sessions_dir=tmp)
            loaded = load_session("consult-20261119-abc123", sessions_dir=tmp)
            self.assertIsNotNone(loaded)
            self.assertEqual(loaded["model"], "codex/gpt-6.2-sol")
            listed = list_sessions(limit=5, sessions_dir=tmp)
            self.assertEqual(len(listed), 1)
            self.assertEqual(listed[0]["turns"], 2)


class MagpieClientAndCodexRunnerTests(unittest.TestCase):
    def test_responses_and_chat_and_empty_reasoning_error(self) -> None:
        with mock.patch("gempt.magpie_client._http_json") as mock_http:
            mock_http.return_value = {
                "id": "resp_1",
                "model": "codex/gpt-6.2-sol",
                "status": "completed",
                "output": [{"type": "message", "content": [{"type": "output_text", "text": "SOLVED"}]}],
                "usage": {"input_tokens": 10, "output_tokens": 5},
            }
            res = consult_with_fallback(
                base_url="http://127.0.0.1:3425",
                api_key="magpie",
                primary_model="codex/gpt-6.2-sol",
                fallback_models=[],
                api_mode="responses",
                messages=[{"role": "user", "content": "hi"}],
                reasoning_effort="medium",
            )
            self.assertEqual(res["text"], "SOLVED")

            # Empty output caused by reasoning token exhaustion should raise clear error
            mock_http.return_value = {
                "id": "resp_2",
                "model": "codex/gpt-6.2-astra",
                "status": "incomplete",
                "incomplete_details": {"reason": "max_output_tokens"},
                "output": [],
                "usage": {"output_tokens_details": {"reasoning_tokens": 512}},
            }
            with self.assertRaises(MagpieRequestError) as ctx:
                consult_with_fallback(
                    base_url="http://127.0.0.1:3425",
                    api_key="magpie",
                    primary_model="codex/gpt-6.2-astra",
                    fallback_models=[],
                    api_mode="responses",
                    messages=[{"role": "user", "content": "hi"}],
                )
            self.assertIn("max_output_tokens", str(ctx.exception))

    def test_sync_magpie_groups_dry_run_commands(self) -> None:
        cfg = default_config_template()
        cfg["routing_policy"]["failover_mode"] = "api_fallback"
        res = sync_magpie_groups(cfg, cli_path="magpie", dry_run=True)
        self.assertEqual(len(res), 3)
        by_tier = {item["tier"]: item for item in res}
        self.assertEqual(by_tier["sonnet"]["group"], "group/gempt-harness-sonnet")
        self.assertIn("group/auto-deepseek-v4-1-flash", by_tier["sonnet"]["members"])

        opus_cmds = [" ".join(c) for c in by_tier["opus"]["commands"]]
        self.assertTrue(any("group add gempt-harness-opus" in c for c in opus_cmds))
        self.assertTrue(any("group rule add gempt-harness-opus use=codex/gpt-6.2-astra effort=xhigh" in c for c in opus_cmds))
        self.assertTrue(any("group rule add gempt-harness-opus use=group/auto-deepseek-v4-1-flash compact" in c for c in opus_cmds))

    def test_codex_cmd_invocation_no_shell_interpolation(self) -> None:
        if sys.platform == "win32":
            argv = build_cli_invocation("C:\\tools\\codex.cmd", ["exec", "-m", "codex/gpt-6.2-sol", "-"])
            self.assertEqual(argv[1:4], ["/d", "/c", "C:\\tools\\codex.cmd"])
        else:
            argv = build_cli_invocation("/usr/bin/codex", ["exec", "-"])
            self.assertEqual(argv, ["/usr/bin/codex", "exec", "-"])


class McpStdioHandshakeTests(unittest.TestCase):
    def test_mcp_stdio_initialize_list_and_status(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cfg_path = Path(tmp) / "gempt.json"
            sess_dir = Path(tmp) / "sessions"
            env = dict(os.environ)
            env["PYTHONPATH"] = str(SRC_ROOT)
            env["PYTHONUTF8"] = "1"
            env["GEMPT_CONFIG"] = str(cfg_path)
            env["GEMPT_SESSIONS_DIR"] = str(sess_dir)

            requests = [
                {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}},
                {"jsonrpc": "2.0", "method": "notifications/initialized"},
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
                {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "gempt_status", "arguments": {}}},
            ]
            stdin_payload = "".join(json.dumps(r) + "\n" for r in requests).encode("utf-8")

            kwargs = {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)} if sys.platform == "win32" else {}
            proc = subprocess.run(
                [sys.executable, "-m", "gempt.mcp_server"],
                input=stdin_payload,
                capture_output=True,
                env=env,
                timeout=20,
                **kwargs,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr.decode("utf-8", "replace"))
            lines = [json.loads(line) for line in proc.stdout.decode("utf-8").splitlines() if line.strip()]
            self.assertEqual(len(lines), 3)  # notification emits no response
            self.assertEqual(lines[0]["result"]["serverInfo"]["name"], "gempt")
            tool_names = [t["name"] for t in lines[1]["result"]["tools"]]
            self.assertEqual(
                tool_names,
                ["gempt_discover", "gempt_configure", "gempt_consult", "gempt_exec", "gempt_status"],
            )
            status_payload = json.loads(lines[2]["result"]["content"][0]["text"])
            self.assertFalse(status_payload["configured"])


class CliPackagingTests(unittest.TestCase):
    def test_print_mcp_and_install_agy_from_flat_plugin(self) -> None:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = cli_main(["print-mcp"])
        self.assertEqual(rc, 0)
        mcp_payload = json.loads(buf.getvalue())
        gempt_entry = mcp_payload["mcpServers"]["gempt"]
        self.assertEqual(Path(gempt_entry["env"]["PYTHONPATH"]).resolve(), SRC_ROOT.resolve())
        self.assertIn(str(SRC_ROOT.resolve()), gempt_entry["args"])

        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "gempt-installed"
            legacy_sidecar = target / "sidecars" / "gempt_panel"
            legacy_sidecar.mkdir(parents=True)
            (legacy_sidecar / "sidecar.json").write_text("{}", encoding="utf-8")

            inst_buf = io.StringIO()
            with contextlib.redirect_stdout(inst_buf):
                rc_inst = cli_main(["install-agy", "--target", str(target), "--force"])
            self.assertEqual(rc_inst, 0)
            inst_payload = json.loads(inst_buf.getvalue())
            self.assertTrue(inst_payload["installed"])

            for rel in (
                "plugin.json",
                "README.md",
                "rules/AGENTS.md",
                "skills/gempt/SKILL.md",
                "skills/gempt-sonnet/SKILL.md",
                "skills/gempt-opus/SKILL.md",
                "skills/gempt-fable/SKILL.md",
                "skills/gempt-chore/SKILL.md",
                "runtime/gempt/__init__.py",
                "mcp_config.json",
            ):
                self.assertTrue((target / rel).is_file(), f"missing installed file: {rel}")

            self.assertFalse((target / "sidecars" / "gempt_panel").exists())
            self.assertFalse((target / "sidecars").exists())

            written_mcp = json.loads((target / "mcp_config.json").read_text(encoding="utf-8"))
            self.assertEqual(
                Path(written_mcp["mcpServers"]["gempt"]["env"]["PYTHONPATH"]).resolve(),
                (target / "runtime").resolve(),
            )
            self.assertFalse((target / "tests").exists())
            self.assertFalse((target / "src").exists())


class PresetsParityTests(unittest.TestCase):
    def test_strip_model_modifiers_and_auto_normalization(self) -> None:
        self.assertEqual(strip_model_modifiers("codex/gpt-6.2-astra:high:fast#work"), "codex/gpt-6.2-astra")
        self.assertEqual(strip_model_modifiers("openrouter/model:free#acct"), "openrouter/model:free")
        preview = apply_native_presets(apply=False, env={"DEEPSEEK_FLASH": "auto/deepseek-v4.1-flash"})
        self.assertFalse(preview["applied"])
        cmds = [" ".join(c) for c in preview["commands"]]
        self.assertEqual(len(cmds), 14)
        self.assertTrue(any("use=group/auto-deepseek-v4-1-flash" in c for c in cmds))
        self.assertTrue(any("classifier=group/auto-deepseek-v4-1-flash" in c for c in cmds))

    def test_install_sh_matches_presets_output(self) -> None:
        bash = os.environ.get("GEMPT_TEST_BASH")
        if not bash and os.name == "nt":
            git_bash = Path(r"C:\Program Files\Git\bin\bash.exe")
            if git_bash.is_file():
                bash = str(git_bash)
        if not bash:
            bash = shutil.which("bash")
        if not bash:
            self.skipTest("bash not available")

        for extra_env in ({}, {"DEEPSEEK_FLASH": "auto/deepseek-v4.1-flash"}):
            env = dict(os.environ, MAGPIE_BIN="magpie", **extra_env)
            kwargs = {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)} if sys.platform == "win32" else {}
            proc = subprocess.run(
                [bash, str(REPO_ROOT / "install.sh")],
                cwd=REPO_ROOT,
                env=env,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=30,
                **kwargs,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            shell_cmds = [shlex.split(line) for line in proc.stdout.splitlines() if line.strip()]
            py_cmds = build_native_preset_commands(
                magpie_bin="magpie",
                models=apply_native_presets(apply=False, env=env)["models"],
            )
            self.assertEqual(shell_cmds, py_cmds)

    def test_apply_native_presets_auto_resolves_catalog_and_respects_exclusions(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            conf = Path(tmp) / "config.json"
            cfg = default_config_template()
            cfg["routing_policy"]["excluded_models"] = ["gemini-4-argon"]
            save_config(cfg, path=conf)

            seen_cmds: list[list[str]] = []
            catalog_text = "\n".join(
                [
                    "agy-cli/gemini-4-hydrogen",
                    "agy-cli/gemini-4-neon",
                    "agy-cli/gemini-4-argon",
                    "codex/gpt-6.2-sol",
                    "codex/gpt-6.2-astra",
                    "auto/deepseek-v4.1-flash",
                ]
            )

            def fake_group_cmd(argv, *, missing="", timeout=60):
                seen_cmds.append(list(argv))
                if argv[1:] == ["models"]:
                    return catalog_text
                if argv[1:] == ["groups"]:
                    return ""
                if len(argv) >= 3 and argv[1] == "group" and missing:
                    return None
                return ""

            with mock.patch.dict(os.environ, {"GEMPT_CONFIG": str(conf), "GEMPT_SESSIONS_DIR": str(Path(tmp) / "sess"), "GEMPT_EXCLUDED_MODELS": ""}), \
                 mock.patch("gempt.presets.find_magpie_cli", return_value="magpie"), \
                 mock.patch("gempt.presets._group_command", side_effect=fake_group_cmd):
                res = apply_native_presets(apply=True, env={})

            self.assertTrue(res["applied"])
            self.assertEqual(res["models"]["hydrogen"], "agy-cli/gemini-4-hydrogen")
            self.assertEqual(res["models"]["neon"], "agy-cli/gemini-4-neon")
            self.assertNotIn("gemini-4-argon", res["models"]["argon"])
            self.assertEqual(res["models"]["argon"], "agy-cli/gemini-4-neon")
            self.assertEqual(res["models"]["sol"], "codex/gpt-6.2-sol")
            self.assertEqual(res["models"]["astra"], "codex/gpt-6.2-astra")
            self.assertEqual(res["models"]["flash"], "auto/deepseek-v4.1-flash")
            self.assertTrue(any("gempt-fable" in " ".join(c) and "agy-cli/gemini-4-neon" in " ".join(c) for c in seen_cmds))


class BugfixRegressionTests(unittest.TestCase):
    def test_group_members_parses_not_served_and_nested_groups(self) -> None:
        report = """
  gempt-harness-sonnet  group/gempt-harness-sonnet
  routing   order
  stays     session
  models    1 codex/gpt-6.2-sol  not served now, skipped
            2 group/auto-deepseek-v4-1-flash  DeepSeek V4.1 Flash
  rules     1 compacting → group/auto-deepseek-v4-1-flash
"""
        self.assertEqual(
            _group_members(report),
            ["codex/gpt-6.2-sol", "group/auto-deepseek-v4-1-flash"],
        )

    def test_verification_result_unwraps_windows_and_posix_shells(self) -> None:
        valid_cases = [
            {"command": 'cmd.exe /d /c "python check.py"', "exit_code": 0},
            {"command": '"C:/Program Files/Git/bin/bash.exe" -lc \'python check.py\'', "exit_code": 0},
            {"command": 'pwsh.exe -NoProfile -NonInteractive -Command "python check.py"', "exit_code": 0},
        ]
        for item in valid_cases:
            self.assertEqual(verification_result("python check.py", [item])["status"], "passed")
        for spoof in ("echo python check.py", "python check.py || true"):
            self.assertEqual(
                verification_result("python check.py", [{"command": spoof, "exit_code": 0}])["status"],
                "unverified",
            )

    def test_codex_runner_sets_loopback_no_proxy(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            seen_env = {}

            def fake_run(cmd, *, env, input, cwd, capture_output, timeout, creationflags):
                seen_env.update(env)
                out_idx = cmd.index("-o") + 1
                Path(cmd[out_idx]).write_text("DONE", encoding="utf-8")
                return subprocess.CompletedProcess(
                    cmd,
                    0,
                    stdout=json.dumps({"type": "thread.started", "thread_id": "t1"}).encode("utf-8"),
                    stderr=b"",
                )

            with mock.patch.dict(os.environ, {"NO_PROXY": "internal.corp", "no_proxy": "internal.corp"}), \
                 mock.patch("gempt.codex_runner.subprocess.run", side_effect=fake_run):
                res = run_codex_exec(
                    cli_path="codex",
                    prompt="hi",
                    cwd=tmp,
                    model="codex/gpt-6.2-sol",
                    gateway_url="http://127.0.0.1:3425",
                )
            self.assertEqual(res["text"], "DONE")
            for key in ("NO_PROXY", "no_proxy"):
                parts = seen_env[key].split(",")
                self.assertEqual(parts[0], "internal.corp")
                for host in ("127.0.0.1", "localhost", "::1"):
                    self.assertIn(host, parts)

    def test_mcp_configure_allows_sandbox_tightening_only(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            conf = Path(tmp) / "config.json"
            cfg = default_config_template()
            save_config(cfg, conf)
            with mock.patch.dict(os.environ, {"GEMPT_CONFIG": str(conf), "GEMPT_WORKSPACE_ROOT": tmp}), \
                 mock.patch("gempt.mcp_server.configure_gempt", return_value={"saved": True}) as mock_cfg:
                res = _handle_tool_call("gempt_configure", {"default_sandbox": "read-only"})
                self.assertTrue(json.loads(res["content"][0]["text"])["saved"])
                mock_cfg.assert_called_once()
                with self.assertRaisesRegex(ValueError, "default_sandbox"):
                    _handle_tool_call("gempt_configure", {"default_sandbox": "danger-full-access"})

    def test_recent_runs_skips_corrupted_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            runs_dir = root / "sessions" / "runs"
            bad = runs_dir / ("0" * 32)
            bad.mkdir(parents=True)
            (bad / "state.json").write_text("{corrupt", encoding="utf-8")
            good = runs_dir / ("a" * 32)
            good.mkdir(parents=True)
            (good / "state.json").write_text(
                json.dumps({"run_id": "a" * 32, "cwd": str(root), "state": "finished"}),
                encoding="utf-8",
            )
            with mock.patch.dict(os.environ, {"GEMPT_SESSIONS_DIR": str(root / "sessions")}):
                items = recent_runs(5, root=root)
            self.assertEqual(len(items), 1)
            self.assertEqual(items[0]["run_id"], "a" * 32)

    def test_mcp_consult_and_exec_honor_configured_default_tier(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            conf = Path(tmp) / "config.json"
            sess_dir = Path(tmp) / "sessions"
            cfg = default_config_template()
            cfg["routing_policy"]["default_tier"] = "fable"
            save_config(cfg, conf)

            with mock.patch.dict(
                os.environ,
                {"GEMPT_CONFIG": str(conf), "GEMPT_SESSIONS_DIR": str(sess_dir), "GEMPT_WORKSPACE_ROOT": tmp},
            ):
                with mock.patch(
                    "gempt.service.consult_with_fallback",
                    return_value={"served_model": "codex/gpt-6.2-astra", "elapsed_sec": 0.1, "text": "OK", "usage": {}},
                ) as mock_consult:
                    res = _handle_tool_call("gempt_consult", {"goal": "check default tier"})
                    self.assertIn("codex/gpt-6.2-astra", res["content"][0]["text"])
                    self.assertEqual(mock_consult.call_args.kwargs["primary_model"], "codex/gpt-6.2-astra")

                with mock.patch("gempt.mcp_server.dispatch_exec", return_value={"ok": True, "verification": {}}) as mock_exec:
                    _handle_tool_call("gempt_exec", {"goal": "run check", "cwd": tmp})
                    self.assertIsNone(mock_exec.call_args.kwargs["tier"])

                with mock.patch("gempt.mcp_server.configure_gempt", return_value={"saved": True}) as mock_cfg:
                    _handle_tool_call("gempt_configure", {"default_tier": "opus", "auto_effort": True})
                    self.assertEqual(mock_cfg.call_args.kwargs["default_tier"], "opus")
                    self.assertTrue(mock_cfg.call_args.kwargs["auto_effort"])

    def test_auto_effort_classifier_timeout_floor_and_js_parity(self) -> None:
        trivial = classify_task_effort(
            tier="sonnet",
            tier_default_effort="medium",
            model_id="codex/gpt-6.2-sol",
            goal="Rename variable and fix comment typo",
        )
        self.assertEqual(trivial["effort"], "low")
        self.assertTrue(trivial["auto_applied"])

        hard_opus = classify_task_effort(
            tier="opus",
            tier_default_effort="high",
            model_id="codex/gpt-6.2-sol",
            goal="Diagnose deadlock and race condition in distributed state machine",
            file_count=5,
        )
        self.assertEqual(hard_opus["effort"], "xhigh")

        astra_floor = classify_task_effort(
            tier="fable",
            tier_default_effort="xhigh",
            model_id="codex/gpt-6.2-astra",
            goal="Simple typo check in README comments",
        )
        self.assertEqual(astra_floor["effort"], "high")
        self.assertFalse(astra_floor["clamped"])

        astra_clamped = classify_task_effort(
            tier="sonnet",
            tier_default_effort="medium",
            model_id="codex/gpt-6.2-astra",
            goal="Simple typo check in README comments",
        )
        self.assertEqual(astra_clamped["effort"], "high")
        self.assertTrue(astra_clamped["clamped"])

        resumed = classify_task_effort(
            tier="opus",
            tier_default_effort="high",
            model_id="codex/gpt-6.2-sol",
            goal="Diagnose deadlock and race condition",
            is_resume=True,
        )
        self.assertFalse(resumed["auto_applied"])
        self.assertEqual(resumed["effort"], "high")

        self.assertEqual(effort_timeout_floor("xhigh", mode="exec"), 1200)
        self.assertEqual(effort_timeout_floor("high", mode="exec"), 900)
        self.assertEqual(effort_timeout_floor("xhigh", mode="consult"), 300)

        hint = build_escalation_suggestion(mode="exec", tier="sonnet", effort="medium", verification_status="failed")
        self.assertIn("omit session_id", hint)

        node_bin = shutil.which("node")
        if node_bin:
            samples = [
                {"tier": "sonnet", "tierDefaultEffort": "medium", "modelId": "codex/gpt-6.2-sol", "goal": "Rename typo in comment"},
                {"tier": "opus", "tierDefaultEffort": "high", "modelId": "codex/gpt-6.2-sol", "goal": "Diagnose race condition and deadlock", "fileCount": 5},
                {"tier": "fable", "tierDefaultEffort": "xhigh", "modelId": "codex/gpt-6.2-astra", "goal": "Simple typo README fix"},
                {"tier": "sonnet", "tierDefaultEffort": "medium", "modelId": "codex/gpt-6.2-astra", "goal": "Simple typo check in README comments"},
                {"tier": "opus", "tierDefaultEffort": "high", "modelId": "codex/gpt-6.2-sol", "goal": "Deadlock", "isResume": True},
            ]
            js_script = (
                "import { classifyTaskEffort } from './magpie_plugin/lib/routing.mjs';"
                f"const items = {json.dumps(samples)};"
                "console.log(JSON.stringify(items.map((x) => classifyTaskEffort(x))));"
            )
            proc = subprocess.run(
                [node_bin, "--input-type=module", "-e", js_script],
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=20,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            js_results = json.loads(proc.stdout)
            for sample, js_out in zip(samples, js_results):
                py_out = classify_task_effort(
                    tier=sample["tier"],
                    tier_default_effort=sample["tierDefaultEffort"],
                    model_id=sample["modelId"],
                    goal=sample["goal"],
                    file_count=sample.get("fileCount", 0),
                    is_resume=sample.get("isResume", False),
                )
                self.assertEqual(js_out["effort"], py_out["effort"])
                self.assertEqual(js_out["score"], py_out["score"])
                self.assertEqual(js_out["auto_applied"], py_out["auto_applied"])
                self.assertEqual(js_out["clamped"], py_out["clamped"])

    def test_service_auto_effort_timeout_floor_and_fresh_escalation_hint(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            conf = root / "cfg" / "config.json"
            sess_dir = root / "sessions"
            repo = root / "repo"
            repo.mkdir(parents=True)
            cfg = default_config_template()
            cfg["routing_policy"]["default_tier"] = "opus"
            cfg["routing_policy"]["auto_effort"] = True
            save_config(cfg, conf)

            with mock.patch.dict(os.environ, {"GEMPT_CONFIG": str(conf), "GEMPT_SESSIONS_DIR": str(sess_dir)}):
                with mock.patch(
                    "gempt.service.consult_with_fallback",
                    return_value={"served_model": "codex/gpt-6.2-astra", "elapsed_sec": 0.2, "text": "ROOT_CAUSE", "usage": {}},
                ) as mock_consult:
                    c1 = run_consult(
                        goal="Diagnose race condition and deadlock in scheduler state machine",
                        cwd=repo,
                        config_path=conf,
                    )
                    self.assertEqual(c1["reasoning_effort"], "xhigh")
                    self.assertEqual(c1["requested_model"], "codex/gpt-6.2-astra")
                    self.assertTrue(c1["escalated"])
                    self.assertGreaterEqual(mock_consult.call_args.kwargs["timeout_sec"], 300)

                    # Follow-up resume locks thread effort without auto_effort re-running
                    c2 = run_consult(
                        goal="Explain fix",
                        session_id=c1["session_id"],
                        cwd=repo,
                        config_path=conf,
                    )
                    self.assertEqual(c2["reasoning_effort"], "xhigh")
                    self.assertIsNone(c2["auto_effort"])

                with mock.patch("gempt.service.find_codex_cli", return_value={"found": True, "path": str(root / "codex")}), \
                     mock.patch("gempt.service.run_codex_exec") as mock_exec:
                    mock_exec.return_value = {
                        "codex_thread_id": "t_xhigh",
                        "text": "ran check",
                        "commands": [{"command": "python -m unittest", "exit_code": 1}],
                        "observed_context": {"cwd": str(repo), "sandbox": "workspace-write"},
                        "elapsed_sec": 1.0,
                        "usage": {},
                    }
                    ex = run_exec(
                        goal="Fix convergence math proof",
                        cwd=repo,
                        tier="fable",
                        verification="python -m unittest",
                        config_path=conf,
                    )
                    self.assertGreaterEqual(mock_exec.call_args.kwargs["timeout_sec"], 1200)
                    self.assertIn("omit session_id", ex["escalation_suggestion"])


if __name__ == "__main__":
    unittest.main()
