#!/usr/bin/env python3

from __future__ import annotations

import subprocess
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCANNER = ROOT / "scripts" / "privacy_scan.py"


class PrivacyScanTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="agent-config-privacy-test-")
        self.repo = Path(self.temporary.name)
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Privacy Test")
        self.git("config", "user.email", "test@example.com")
        (self.repo / "note.md").write_text("safe\n", encoding="utf-8")
        self.git("add", "note.md")
        self.git("commit", "-q", "-m", "safe baseline")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def git(self, *args: str) -> None:
        subprocess.run(["git", *args], cwd=self.repo, check=True, capture_output=True)

    def scan(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["python3", str(SCANNER), "--root", str(self.repo), *args],
            text=True,
            capture_output=True,
        )

    def test_staged_content_is_scanned_instead_of_worktree(self) -> None:
        private_path = "/Users/" + "privateperson/secret.txt"
        (self.repo / "note.md").write_text(private_path + "\n", encoding="utf-8")
        self.git("add", "note.md")
        (self.repo / "note.md").write_text("safe worktree replacement\n", encoding="utf-8")
        self.assertEqual(self.scan().returncode, 0)
        staged = self.scan("--staged")
        self.assertEqual(staged.returncode, 1, staged.stdout + staged.stderr)

    def test_deleted_personal_identifier_is_still_found_in_history(self) -> None:
        private_path = "/Users/" + "privateperson/secret.txt"
        (self.repo / "note.md").write_text(private_path + "\n", encoding="utf-8")
        self.git("add", "note.md")
        self.git("commit", "-q", "-m", "unsafe intermediate")
        (self.repo / "note.md").write_text("safe again\n", encoding="utf-8")
        self.git("add", "note.md")
        self.git("commit", "-q", "-m", "remove unsafe value")
        self.assertEqual(self.scan().returncode, 0)
        history = self.scan("--git-history")
        self.assertEqual(history.returncode, 1, history.stdout + history.stderr)


if __name__ == "__main__":
    unittest.main()
