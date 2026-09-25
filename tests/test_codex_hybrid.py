#!/usr/bin/env python3

from __future__ import annotations

import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import tomllib
import unittest
from unittest import mock


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
SWITCH = REPOSITORY_ROOT / "bin" / "codex-hybrid"


def load_switch_module():
    loader = importlib.machinery.SourceFileLoader("codex_hybrid_test", str(SWITCH))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    if spec is None:
        raise RuntimeError("无法加载 codex-hybrid 测试模块")
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


BASE_CONFIG = """notify = [\"unchanged\"]
model = \"gpt-5.6-sol\"
model_reasoning_effort = \"high\"

[agents]
enabled = true
default_subagent_model = \"gpt-5.6-terra\"
default_subagent_reasoning_effort = \"high\"

[plugins.\"example@local\"]
enabled = true
"""


class CodexHybridTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.codex_home = Path(self.temporary_directory.name) / ".codex"
        self.codex_home.mkdir()
        self.config_path = self.codex_home / "config.toml"
        self.config_path.write_text(BASE_CONFIG, encoding="utf-8")
        self.config_path.chmod(0o640)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def run_switch(self, command: str, *, check: bool = True) -> subprocess.CompletedProcess[str]:
        environment = os.environ.copy()
        environment["CODEX_HOME"] = str(self.codex_home)
        return subprocess.run(
            [str(SWITCH), command, "--json"],
            check=check,
            capture_output=True,
            text=True,
            env=environment,
        )

    def parsed(self) -> dict:
        return tomllib.loads(self.config_path.read_text(encoding="utf-8"))

    def backups(self) -> list[Path]:
        directory = self.codex_home / "backups" / "hybrid-switch"
        return sorted(directory.glob("*.toml")) if directory.exists() else []

    def test_on_sets_gpt6_main_and_preserves_unrelated_configuration(self) -> None:
        before = self.config_path.read_bytes()
        result = self.run_switch("on")
        payload = json.loads(result.stdout)
        parsed = self.parsed()

        self.assertTrue(payload["hybridEnabled"])
        self.assertTrue(payload["hybridMainConfigured"])
        self.assertTrue(payload["changed"])
        self.assertEqual(parsed["model"], "gpt-6-sol")
        self.assertEqual(parsed["model_reasoning_effort"], "xhigh")
        self.assertTrue(parsed["agents"]["enabled"])
        self.assertEqual(parsed["agents"]["default_subagent_model"], "gpt-5.6-terra")
        self.assertTrue(parsed["plugins"]["example@local"]["enabled"])
        self.assertEqual(parsed["notify"], ["unchanged"])
        self.assertEqual(len(self.backups()), 1)
        self.assertEqual(self.backups()[0].read_bytes(), before)
        self.assertEqual(stat.S_IMODE(self.config_path.stat().st_mode), 0o640)

    def test_off_disables_agents_without_changing_main_model(self) -> None:
        self.config_path.write_text(
            BASE_CONFIG.replace('model = "gpt-5.6-sol"', 'model = "custom-main"')
            .replace('model_reasoning_effort = "high"', 'model_reasoning_effort = "max"', 1),
            encoding="utf-8",
        )
        payload = json.loads(self.run_switch("off").stdout)
        parsed = self.parsed()

        self.assertFalse(payload["hybridEnabled"])
        self.assertEqual(parsed["model"], "custom-main")
        self.assertEqual(parsed["model_reasoning_effort"], "max")
        self.assertFalse(parsed["agents"]["enabled"])

    def test_toggle_changes_state_in_both_directions(self) -> None:
        first = json.loads(self.run_switch("toggle").stdout)
        second = json.loads(self.run_switch("toggle").stdout)

        self.assertFalse(first["hybridEnabled"])
        self.assertTrue(second["hybridEnabled"])
        self.assertEqual(self.parsed()["model"], "gpt-6-sol")
        self.assertEqual(self.parsed()["model_reasoning_effort"], "xhigh")

    def test_status_is_read_only(self) -> None:
        before = self.config_path.read_bytes()
        payload = json.loads(self.run_switch("status").stdout)

        self.assertTrue(payload["hybridEnabled"])
        self.assertFalse(payload["changed"])
        self.assertEqual(self.config_path.read_bytes(), before)
        self.assertEqual(self.backups(), [])

    def test_idempotent_on_does_not_create_another_backup(self) -> None:
        self.run_switch("on")
        first_backup_count = len(self.backups())
        payload = json.loads(self.run_switch("on").stdout)

        self.assertFalse(payload["changed"])
        self.assertEqual(len(self.backups()), first_backup_count)

    def test_missing_agents_section_is_added(self) -> None:
        self.config_path.write_text('service_tier = "default"\n', encoding="utf-8")
        self.run_switch("on")
        parsed = self.parsed()

        self.assertEqual(parsed["service_tier"], "default")
        self.assertEqual(parsed["model"], "gpt-6-sol")
        self.assertEqual(parsed["model_reasoning_effort"], "xhigh")
        self.assertTrue(parsed["agents"]["enabled"])

    def test_hash_inside_quoted_value_is_replaced_without_creating_duplicate_key(self) -> None:
        self.config_path.write_text(
            BASE_CONFIG.replace('model = "gpt-5.6-sol"', 'model = "foo#bar" # keep'),
            encoding="utf-8",
        )

        self.run_switch("on")
        rendered = self.config_path.read_text(encoding="utf-8")
        parsed = self.parsed()

        self.assertEqual(parsed["model"], "gpt-6-sol")
        self.assertEqual(
            sum(line.startswith("model =") for line in rendered.splitlines()), 1
        )
        self.assertIn('model = "gpt-6-sol" # keep', rendered)

    def test_concurrent_unrelated_write_is_merged_instead_of_overwritten(self) -> None:
        module = load_switch_module()
        original_swap = module.atomic_swap
        injected = False
        concurrent_section = (
            '\n[projects."/tmp/concurrent-project"]\ntrust_level = "trusted"\n'
        )

        def racing_swap(left: Path, right: Path) -> None:
            nonlocal injected
            if not injected:
                injected = True
                right.write_text(
                    right.read_text(encoding="utf-8") + concurrent_section,
                    encoding="utf-8",
                )
            original_swap(left, right)

        module.atomic_swap = racing_swap
        output = io.StringIO()
        with mock.patch.dict(os.environ, {"CODEX_HOME": str(self.codex_home)}):
            with contextlib.redirect_stdout(output):
                return_code = module.execute("on", as_json=True)

        payload = json.loads(output.getvalue())
        parsed = self.parsed()
        backup = tomllib.loads(self.backups()[0].read_text(encoding="utf-8"))

        self.assertEqual(return_code, 0)
        self.assertTrue(payload["changed"])
        self.assertTrue(injected)
        self.assertEqual(parsed["model"], "gpt-6-sol")
        self.assertTrue(parsed["agents"]["enabled"])
        self.assertEqual(
            parsed["projects"]["/tmp/concurrent-project"]["trust_level"], "trusted"
        )
        self.assertEqual(backup["model"], "gpt-5.6-sol")
        self.assertEqual(
            backup["projects"]["/tmp/concurrent-project"]["trust_level"], "trusted"
        )

    def test_malformed_toml_is_rejected_without_mutation(self) -> None:
        malformed = b'model = "unterminated\n'
        self.config_path.write_bytes(malformed)
        result = self.run_switch("on", check=False)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("无法解析", result.stderr)
        self.assertEqual(self.config_path.read_bytes(), malformed)
        self.assertEqual(self.backups(), [])

    def test_symlink_config_is_rejected(self) -> None:
        target = self.codex_home / "real-config.toml"
        target.write_text(BASE_CONFIG, encoding="utf-8")
        self.config_path.unlink()
        self.config_path.symlink_to(target)

        result = self.run_switch("off", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("符号链接", result.stderr)
        self.assertTrue(tomllib.loads(target.read_text(encoding="utf-8"))["agents"]["enabled"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
