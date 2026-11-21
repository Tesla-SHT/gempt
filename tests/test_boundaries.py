import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from gempt.config import ConfigError, default_config_template, resolve_tier, save_config
from gempt.discover import discover_environment
from gempt.mcp_server import _handle_tool_call
from gempt.protocol import read_context_files
from gempt.service import configure_gempt, run_exec
from gempt.sessions import save_session
from gempt.runs import verification_result


class BoundaryTests(unittest.TestCase):
    def test_api_only_and_gateway_binding(self):
        seen = []
        class Catalog(BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append(self.headers.get("Authorization"))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"data":[{"id":"openai/gpt-test","owned_by":"openai"}]}')
            def log_message(self, *args):
                pass

        with ThreadingHTTPServer(("127.0.0.1", 0), Catalog) as server, tempfile.TemporaryDirectory() as tmp:
            threading.Thread(target=server.serve_forever, daemon=True).start()
            try:
                conf = Path(tmp) / "config.json"
                url = f"http://127.0.0.1:{server.server_port}"
                cfg = default_config_template()
                cfg["magpie"]["api_key"] = "fixture-key-private-to-original-gateway"
                save_config(cfg, conf)
                with patch.dict(os.environ, {"GEMPT_MAGPIE_API_KEY": "fixture-env"}):
                    data = discover_environment(magpie_url=url, config_path=conf, include_cli_groups=False)
                    self.assertFalse(data["recommendations"]["presets"]["subscription_only"]["tiers"])
                    with self.assertRaisesRegex(ConfigError, "No Codex subscription"):
                        configure_gempt(magpie_url=url, config_path=conf)
                self.assertEqual(seen, [None, None])
                self.assertEqual(json.loads(conf.read_text(encoding="utf-8"))["magpie"]["api_key"], cfg["magpie"]["api_key"])
                for model in ("openai/gpt-test", "auto/test", "group/other"):
                    with self.assertRaises(ConfigError):
                        resolve_tier(cfg, "sonnet", model_override=model)
                cfg["tiers"]["sonnet"]["fallback_models"] = ["openai/gpt-test"]
                with self.assertRaises(ConfigError):
                    resolve_tier(cfg, "sonnet")
            finally:
                server.shutdown()

    def test_project_cannot_replace_host_sandbox(self):
        from gempt.config import load_config
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"GEMPT_CONFIG": ""}):
            root = Path(tmp)
            with patch("gempt.config.DEFAULT_CONFIG_PATH", root / "trusted.json"):
                (root / ".gempt.json").write_text('{"codex":{"default_sandbox":"danger-full-access"}}')
                with self.assertRaisesRegex(ConfigError, "Project cannot override"):
                    load_config(cwd=root)

    def test_workspace_and_resume_boundaries(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "workspace"
            workspace.mkdir()
            outside = root / "outside.txt"
            outside.write_text("fixture")
            conf = root / "config.json"
            cfg = default_config_template()
            save_config(cfg, conf)
            with patch.dict(os.environ, {"GEMPT_CONFIG": str(conf), "GEMPT_WORKSPACE_ROOT": str(workspace),
                                        "GEMPT_SESSIONS_DIR": str(root / "sessions")}):
                with self.assertRaisesRegex(ValueError, "outside workspace"):
                    read_context_files(["../outside.txt"], cwd=workspace)
                with self.assertRaisesRegex(ValueError, "outside host"):
                    _handle_tool_call("gempt_exec", {"cwd": tmp, "goal": "ignored"})
                with self.assertRaisesRegex(ConfigError, "Unknown exec session"):
                    run_exec(goal="ignored", cwd=workspace, session_id="unbound")
                record = {"session_id":"exec-fixture", "mode":"exec", "cwd":str(workspace),
                          "sandbox":"read-only", "codex_thread_id":"thread-fixture",
                          "gateway":cfg["magpie"]["base_url"]}
                save_session(record)
                with self.assertRaisesRegex(ConfigError, "cannot increase"):
                    run_exec(goal="ignored", cwd=workspace, sandbox="workspace-write", session_id="exec-fixture")
                with self.assertRaisesRegex(ConfigError, "original workspace"):
                    run_exec(goal="ignored", cwd=root, session_id="exec-fixture")
                del record["sandbox"]
                save_session(record)
                with self.assertRaisesRegex(ConfigError, "recorded sandbox"):
                    run_exec(goal="ignored", cwd=workspace, session_id="exec-fixture")

    def test_authenticated_redirect_is_not_followed(self):
        from gempt.discover import probe_magpie_gateway
        seen = []
        class Redirect(BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append(self.path)
                self.send_response(302 if self.path == "/v1/models" else 200)
                self.send_header("Location", "/other")
                self.end_headers()
            def log_message(self, *args):
                pass
        with ThreadingHTTPServer(("127.0.0.1", 0), Redirect) as server:
            threading.Thread(target=server.serve_forever, daemon=True).start()
            try:
                data = probe_magpie_gateway(f"http://127.0.0.1:{server.server_port}", "fixture")
                self.assertFalse(data["reachable"])
                self.assertEqual(seen, ["/v1/models"])
            finally:
                server.shutdown()

    def test_acceptance_requires_exit_evidence(self):
        for cmd in ["echo python check.py", "python check.py || true"]:
            self.assertEqual(verification_result("python check.py", [{"command":cmd,"exit_code":0}])["status"], "unverified")
        wrapped = {"command": "\"C:/Program Files/pwsh.exe\" -Command 'python check.py'", "exit_code": 1}
        self.assertEqual(verification_result("python check.py", [wrapped])["status"], "failed")
        for code, expected in ((0, "passed"), (7, "failed")):
            self.assertEqual(verification_result("python check.py", [{"command":"python check.py","exit_code":code}])["status"], expected)

    def test_run_controls_enforce_workspace_call_id_and_no_escalation(self):
        from gempt.app_server_client import approval_reply
        from gempt.runs import reply_tool_call
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run_id = "a" * 32
            run = root / "sessions" / "runs" / run_id
            run.mkdir(parents=True)
            (run / "state.json").write_text(json.dumps({
                "run_id": run_id, "state": "waiting_gemini", "cwd": str(root / "other"),
                "pending_tool_call": {"tool": "ask_gemini", "call_id": "call_valid"},
            }), encoding="utf-8")
            with patch.dict(os.environ, GEMPT_SESSIONS_DIR=str(root / "sessions"), GEMPT_WORKSPACE_ROOT=str(root / "workspace")):
                for method, args in (
                    ("gempt_status", {}), ("gempt_steer", {"message": "continue"}), ("gempt_interrupt", {}),
                    ("gempt_reply_tool_call", {"call_id": "call_valid", "answer": "yes"}),
                ):
                    with self.assertRaisesRegex(ValueError, "outside host workspace"):
                        _handle_tool_call(method, {"run_id": run_id, **args})
                for call_id in ("../outside", "other-call"):
                    with self.assertRaises(ValueError):
                        reply_tool_call(run_id, call_id, "yes")
                self.assertFalse((run / "tool_replies").exists())

        self.assertEqual(approval_reply("item/commandExecution/requestApproval", {}, "workspace-write"),
                         {"decision": "decline"})
        self.assertEqual(approval_reply("item/commandExecution/requestApproval", {"kind": "writeStdin"}, "workspace-write"),
                         {"decision": "accept"})
        self.assertEqual(approval_reply("item/fileChange/requestApproval", {"grantRoot": "/other"}, "read-only"),
                         {"decision": "decline"})
        self.assertEqual(approval_reply("item/permissions/requestApproval", {"permissions": {"network": {"enabled": True}}}, "read-only"),
                         {"permissions": {}, "scope": "turn"})
        self.assertEqual(approval_reply("execCommandApproval", {}, "danger-full-access"), {"decision": "approved"})
