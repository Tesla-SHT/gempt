"""Opt-in Windows Magpie CLI integration. All Magpie storage is redirected to a new profile."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from gempt import magpie_client
from gempt.service import configure_gempt


@unittest.skipUnless(os.name == "nt" and os.environ.get("GEMPT_TEST_MAGPIE_CLI"),
                     "requires GEMPT_TEST_MAGPIE_CLI and isolated Windows profile")
class GroupSyncTests(unittest.TestCase):
    def test_repeated_init_recovers_after_rule_failure(self):
        exe = str(Path(os.environ["GEMPT_TEST_MAGPIE_CLI"]).resolve(strict=True))

        class Catalog(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({"data": [{"id": "fixture/gpt-small"}, {"id": "fixture/gpt-large"}]}).encode())
            def log_message(self, *args):
                pass

        with tempfile.TemporaryDirectory() as tmp, ThreadingHTTPServer(("127.0.0.1", 0), Catalog) as server:
            threading.Thread(target=server.serve_forever, daemon=True).start()
            conf = Path(tmp) / "gempt.json"
            env = {key: tmp for key in ("APPDATA", "LOCALAPPDATA", "USERPROFILE", "XDG_CONFIG_HOME")}
            env["GEMPT_SESSIONS_DIR"] = str(Path(tmp) / "sessions")
            try:
                with patch.dict(os.environ, env):
                    def cli(*args):
                        return subprocess.run([exe, *args], check=True, timeout=30, capture_output=True,
                                              env=magpie_client.build_magpie_cli_env(),
                                              creationflags=subprocess.CREATE_NO_WINDOW)
                    # Verify real CLI writes locks into the fresh profile before any group mutation.
                    cli("groups")
                    self.assertTrue((Path(tmp) / "magpie").is_dir())
                    cli("provider", "add", "fixture", "url=http://127.0.0.1:1/v1", "key=fixture",
                        "models=gpt-small,gpt-large", "list=off")
                    # Install the upstream preset into this same isolated profile.
                    # The optional integration test needs Git Bash on Windows.
                    bash = os.environ.get("GEMPT_TEST_BASH") or shutil.which("bash")
                    self.assertTrue(bash, "Set GEMPT_TEST_BASH to Git Bash")
                    repo = Path(__file__).resolve().parents[1]
                    native_env = magpie_client.build_magpie_cli_env()
                    native_env.pop("PYTHONHOME", None)
                    native_env.update(PYTHON_BIN=sys.executable, MAGPIE_BIN=exe, GEMPT_HYDROGEN="fixture/hydrogen",
                                      GEMPT_NEON="fixture/neon", GEMPT_ARGON="fixture/frontier",
                                      GEMPT_SOL="fixture/gpt-small", GEMPT_ASTRA="fixture/gpt-large",
                                      DEEPSEEK_FLASH="fixture/gpt-flash")
                    cli("provider", "set", "fixture", "models=gpt-small,gpt-large,gpt-flash,hydrogen,neon,frontier")
                    subprocess.run([bash, "install.sh", "--apply"], cwd=repo, env=native_env,
                                   check=True, timeout=240, capture_output=True)
                    def native_groups():
                        catalog = Path(tmp) / "magpie" / "providers.json"
                        groups = json.loads(catalog.read_text(encoding="utf-8"))["groups"]
                        return {g["id"]: g for g in groups if g["id"] in
                                {"gempt-sonnet", "gempt-opus", "gempt-fable"}}
                    untouched = native_groups()
                    self.assertEqual({k: len(g["rules"]) for k, g in untouched.items()},
                                     {"gempt-sonnet": 4, "gempt-opus": 4, "gempt-fable": 3})
                    overrides = {t: {"consult_model": "fixture/gpt-small", "exec_model": "fixture/gpt-small",
                                     "magpie_group_members": ["fixture/gpt-small", "fixture/gpt-large"]}
                                 for t in ("sonnet", "opus", "fable")}
                    overrides["opus"]["escalate_model"] = "fixture/gpt-large"
                    opts = dict(config_path=conf, magpie_url=f"http://127.0.0.1:{server.server_port}",
                                magpie_cli_path=exe, failover_mode="api_fallback", tiers_override=overrides,
                                utility_model="fixture/gpt-small", sync_groups=True, use_magpie_group_ids=True)
                    real = magpie_client._group_command
                    def interrupt(argv, **kwargs):
                        if argv[1:5] == ["group", "rule", "add", "gempt-harness-opus"]:
                            raise InterruptedError("injected rule interruption")
                        return real(argv, **kwargs)
                    with patch.object(magpie_client, "_group_command", interrupt):
                        with self.assertRaises(InterruptedError):
                            configure_gempt(**opts)
                    self.assertFalse(conf.exists())
                    recovered = configure_gempt(**opts)
                    self.assertTrue(recovered["saved"])
                    self.assertEqual(recovered["magpie_groups_sync"][0]["writes"], 0)
                    again = configure_gempt(**opts)
                    self.assertEqual([g["writes"] for g in again["magpie_groups_sync"]], [0, 0, 0])
                    self.assertEqual(native_groups(), untouched)
                    self.assertEqual([g["group"] for g in again["magpie_groups_sync"]],
                                     [f"group/gempt-harness-{tier}" for tier in ("sonnet", "opus", "fable")])
            finally:
                server.shutdown()
