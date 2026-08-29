#!/usr/bin/env python3

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "bin" / "agent-config"
SKILLS = json.loads((ROOT / "manifest.yaml").read_text())["profile"]["skills"]


class AgentConfigTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="agent-config-test-")
        self.base = Path(self.temporary.name)
        self.env = os.environ | {
            "HOME": str(self.base / "home"),
            "CODEX_HOME": str(self.base / "codex"),
            "XDG_STATE_HOME": str(self.base / "state"),
        }
        Path(self.env["CODEX_HOME"]).mkdir(parents=True)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def run_cli(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run([str(CLI), *args], env=self.env, text=True, capture_output=True)

    def test_link_is_leaf_only_and_idempotent(self) -> None:
        first = self.run_cli("link", "--apply")
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        agents = Path(self.env["CODEX_HOME"]) / "AGENTS.md"
        self.assertTrue(agents.is_symlink())
        self.assertEqual(agents.resolve(), ROOT / "profile" / "AGENTS.md")
        skills_root = Path(self.env["HOME"]) / ".agents" / "skills"
        self.assertFalse(skills_root.is_symlink())
        for name in SKILLS:
            self.assertTrue((skills_root / name).is_symlink(), name)
        state_path = Path(self.env["XDG_STATE_HOME"]) / "agent-config" / "state.json"
        state_before = state_path.read_text(encoding="utf-8")
        second = self.run_cli("link", "--apply")
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertEqual(state_path.read_text(encoding="utf-8"), state_before)
        self.assertEqual(state_path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(state_path.parent.stat().st_mode & 0o777, 0o700)

    def test_collision_fails_without_overwrite(self) -> None:
        agents = Path(self.env["CODEX_HOME"]) / "AGENTS.md"
        agents.write_text("keep me", encoding="utf-8")
        result = self.run_cli("link", "--apply")
        self.assertEqual(result.returncode, 20, result.stdout + result.stderr)
        self.assertEqual(agents.read_text(encoding="utf-8"), "keep me")
        self.assertFalse((Path(self.env["HOME"]) / ".agents" / "skills" / SKILLS[0]).exists())

    def test_unlink_removes_only_owned_links(self) -> None:
        self.assertEqual(self.run_cli("link", "--apply").returncode, 0)
        unrelated = Path(self.env["HOME"]) / ".agents" / "skills" / "unrelated"
        unrelated.mkdir()
        result = self.run_cli("unlink", "--apply")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(unrelated.is_dir())
        self.assertFalse((Path(self.env["CODEX_HOME"]) / "AGENTS.md").exists())

    def test_doctor_reports_override_shadowing(self) -> None:
        override = Path(self.env["CODEX_HOME"]) / "AGENTS.override.md"
        override.write_text("override", encoding="utf-8")
        result = self.run_cli("doctor")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("agents_override=SHADOWING", result.stdout)

    def test_explicit_dry_run_and_missing_link_status(self) -> None:
        dry_run = self.run_cli("link", "--dry-run")
        self.assertEqual(dry_run.returncode, 0, dry_run.stdout + dry_run.stderr)
        self.assertFalse((Path(self.env["CODEX_HOME"]) / "AGENTS.md").exists())
        status = self.run_cli("status")
        self.assertEqual(status.returncode, 20, status.stdout + status.stderr)


if __name__ == "__main__":
    unittest.main()
