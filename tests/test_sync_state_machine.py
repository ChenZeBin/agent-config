#!/usr/bin/env python3

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class SyncStateMachineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="agent-config-sync-test-")
        self.base = Path(self.temporary.name)
        seed = self.base / "seed"
        shutil.copytree(
            ROOT,
            seed,
            ignore=shutil.ignore_patterns(".git", "__pycache__", "*.pyc", ".DS_Store"),
        )
        self.git(seed, "init", "-q", "-b", "main")
        self.git(seed, "config", "user.name", "Agent Config Test")
        self.git(seed, "config", "user.email", "test@example.com")
        self.git(seed, "add", "-A")
        self.git(seed, "commit", "-q", "-m", "seed")
        self.origin = self.base / "origin.git"
        subprocess.run(["git", "clone", "--quiet", "--bare", str(seed), str(self.origin)], check=True)
        self.a = self.clone("a")
        self.b = self.clone("b")
        self.env = os.environ | {
            "HOME": str(self.base / "home"),
            "CODEX_HOME": str(self.base / "codex"),
            "XDG_STATE_HOME": str(self.base / "state"),
        }
        if shutil.which("gitleaks") is None:
            fake_bin = self.base / "fake-bin"
            fake_bin.mkdir()
            fake = fake_bin / "gitleaks"
            fake.write_text(
                "#!/usr/bin/env python3\n"
                "import pathlib,sys\n"
                "root=pathlib.Path(sys.argv[-1])\n"
                "bad=any((b'ghp_'+b'A'*36) in p.read_bytes() for p in root.rglob('*') if p.is_file())\n"
                "raise SystemExit(1 if bad else 0)\n",
                encoding="utf-8",
            )
            fake.chmod(0o700)
            self.env["PATH"] = str(fake_bin) + os.pathsep + self.env.get("PATH", "")
        Path(self.env["CODEX_HOME"]).mkdir(parents=True)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def git(self, cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["git", *args], cwd=cwd, check=True, text=True, capture_output=True)

    def clone(self, name: str) -> Path:
        destination = self.base / name
        subprocess.run(["git", "clone", "--quiet", str(self.origin), str(destination)], check=True)
        self.git(destination, "config", "user.name", "Agent Config Test")
        self.git(destination, "config", "user.email", "test@example.com")
        return destination

    def cli(self, repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(repo / "bin" / "agent-config"), *args],
            cwd=repo,
            env=self.env,
            text=True,
            capture_output=True,
        )

    def commit_file(self, repo: Path, name: str, content: str) -> str:
        (repo / name).write_text(content, encoding="utf-8")
        self.git(repo, "add", name)
        self.git(repo, "commit", "-q", "-m", f"update {name}")
        return self.git(repo, "rev-parse", "HEAD").stdout.strip()

    def test_dirty_pull_is_non_mutating_then_clean_pull_records_recovery_heads(self) -> None:
        self.assertEqual(self.cli(self.a, "link", "--apply").returncode, 0)
        remote_head = self.commit_file(self.b, "remote-note.md", "safe remote update\n")
        self.git(self.b, "push", "-q", "origin", "main")
        original_head = self.git(self.a, "rev-parse", "HEAD").stdout.strip()
        marker = self.a / "do-not-touch.txt"
        marker.write_text("local work\n", encoding="utf-8")

        dirty = self.cli(self.a, "sync", "--pull")
        self.assertEqual(dirty.returncode, 10, dirty.stdout + dirty.stderr)
        self.assertEqual(self.git(self.a, "rev-parse", "HEAD").stdout.strip(), original_head)
        self.assertEqual(marker.read_text(encoding="utf-8"), "local work\n")

        marker.unlink()
        pulled = self.cli(self.a, "sync", "--pull")
        self.assertEqual(pulled.returncode, 0, pulled.stdout + pulled.stderr)
        self.assertEqual(self.git(self.a, "rev-parse", "HEAD").stdout.strip(), remote_head)
        state = json.loads((self.base / "state" / "agent-config" / "state.json").read_text())
        self.assertEqual(state["event"], "pull")
        self.assertEqual(state["previous_head"], original_head)
        self.assertEqual(state["last_good_head"], remote_head)

    def test_ahead_push_runs_security_gate(self) -> None:
        local_head = self.commit_file(self.a, "local-note.md", "safe local update\n")
        pushed = self.cli(self.a, "sync", "--push")
        self.assertEqual(pushed.returncode, 0, pushed.stdout + pushed.stderr)
        remote_head = self.git(self.origin, "rev-parse", "main").stdout.strip()
        self.assertEqual(remote_head, local_head)

    def test_diverged_refuses_automatic_resolution(self) -> None:
        local_head = self.commit_file(self.a, "local-note.md", "local branch\n")
        self.commit_file(self.b, "remote-note.md", "remote branch\n")
        self.git(self.b, "push", "-q", "origin", "main")
        result = self.cli(self.a, "sync", "--pull")
        self.assertEqual(result.returncode, 13, result.stdout + result.stderr)
        self.assertEqual(self.git(self.a, "rev-parse", "HEAD").stdout.strip(), local_head)

    def test_offline_check_keeps_last_good_checkout(self) -> None:
        original_head = self.git(self.a, "rev-parse", "HEAD").stdout.strip()
        self.git(self.a, "remote", "set-url", "origin", str(self.base / "missing-origin.git"))
        result = self.cli(self.a, "sync", "--check")
        self.assertEqual(result.returncode, 40, result.stdout + result.stderr)
        self.assertEqual(self.git(self.a, "rev-parse", "HEAD").stdout.strip(), original_head)

    def test_secret_bearing_remote_candidate_is_not_applied(self) -> None:
        original_head = self.git(self.a, "rev-parse", "HEAD").stdout.strip()
        marker = self.base / "state" / "candidate-executed"
        candidate_program = "#!/bin/sh\ntouch \"$XDG_STATE_HOME/candidate-executed\"\nexit 0\n"
        (self.b / "bin" / "agent-config").write_text(candidate_program, encoding="utf-8")
        (self.b / "bin" / "agent-config").chmod(0o755)
        leaked_value = "ghp_" + ("A" * 36)
        (self.b / "unsafe-fixture.txt").write_text(leaked_value + "\n", encoding="utf-8")
        self.git(self.b, "add", "bin/agent-config", "unsafe-fixture.txt")
        self.git(self.b, "commit", "-q", "-m", "secret-bearing candidate")
        self.git(self.b, "push", "-q", "origin", "main")
        result = self.cli(self.a, "sync", "--pull")
        self.assertEqual(result.returncode, 30, result.stdout + result.stderr)
        self.assertEqual(self.git(self.a, "rev-parse", "HEAD").stdout.strip(), original_head)
        self.assertFalse(marker.exists(), "untrusted candidate validator was executed")

    def test_remote_candidate_cannot_replace_or_execute_privacy_scanner(self) -> None:
        original_head = self.git(self.a, "rev-parse", "HEAD").stdout.strip()
        marker = self.base / "state" / "candidate-scanner-executed"
        candidate_scanner = (
            "#!/usr/bin/env python3\n"
            "import os, pathlib\n"
            "pathlib.Path(os.environ['XDG_STATE_HOME'], 'candidate-scanner-executed').touch()\n"
        )
        (self.b / "scripts" / "privacy_scan.py").write_text(candidate_scanner, encoding="utf-8")
        self.git(self.b, "add", "scripts/privacy_scan.py")
        self.git(self.b, "commit", "-q", "-m", "replace candidate scanner")
        self.git(self.b, "push", "-q", "origin", "main")

        result = self.cli(self.a, "sync", "--pull")
        self.assertEqual(result.returncode, 30, result.stdout + result.stderr)
        self.assertEqual(self.git(self.a, "rev-parse", "HEAD").stdout.strip(), original_head)
        self.assertFalse(marker.exists(), "untrusted candidate scanner was executed")

    def test_deleted_historical_identifier_in_remote_candidate_is_rejected(self) -> None:
        original_head = self.git(self.a, "rev-parse", "HEAD").stdout.strip()
        private_path = "/Users/" + "remote-private-person/secret.txt"
        self.commit_file(self.b, "remote-history.md", private_path + "\n")
        self.commit_file(self.b, "remote-history.md", "safe tip\n")
        self.git(self.b, "push", "-q", "origin", "main")

        result = self.cli(self.a, "sync", "--pull")
        self.assertEqual(result.returncode, 30, result.stdout + result.stderr)
        self.assertEqual(self.git(self.a, "rev-parse", "HEAD").stdout.strip(), original_head)

    def test_candidate_link_collision_is_rejected_before_fast_forward(self) -> None:
        original_head = self.git(self.a, "rev-parse", "HEAD").stdout.strip()
        manifest_path = self.b / "manifest.yaml"
        manifest = json.loads(manifest_path.read_text())
        manifest["profile"]["skills"].append("collision-proof")
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        lock_path = self.b / "dependencies" / "skills.lock.yaml"
        lock = json.loads(lock_path.read_text())
        lock["skills"]["collision-proof"] = {"tracking": "local-authored-snapshot"}
        lock_path.write_text(json.dumps(lock, indent=2) + "\n", encoding="utf-8")
        skill = self.b / "profile" / "skills" / "collision-proof"
        skill.mkdir()
        (skill / "SKILL.md").write_text("---\nname: collision-proof\ndescription: test\n---\n", encoding="utf-8")
        self.git(self.b, "add", "manifest.yaml", "dependencies/skills.lock.yaml", "profile/skills/collision-proof/SKILL.md")
        self.git(self.b, "commit", "-q", "-m", "add colliding skill")
        self.git(self.b, "push", "-q", "origin", "main")
        occupied = self.base / "home" / ".agents" / "skills" / "collision-proof"
        occupied.mkdir(parents=True)
        (occupied / "owned-by-user.txt").write_text("keep\n", encoding="utf-8")
        result = self.cli(self.a, "sync", "--pull")
        self.assertEqual(result.returncode, 30, result.stdout + result.stderr)
        self.assertEqual(self.git(self.a, "rev-parse", "HEAD").stdout.strip(), original_head)
        self.assertEqual((occupied / "owned-by-user.txt").read_text(), "keep\n")

    def test_no_upstream_is_not_reported_as_healthy(self) -> None:
        self.git(self.a, "branch", "--unset-upstream")
        result = self.cli(self.a, "sync", "--check")
        self.assertEqual(result.returncode, 14, result.stdout + result.stderr)

    def test_adopt_records_state_and_keeps_private_backup_permissions(self) -> None:
        target = Path(self.env["CODEX_HOME"]) / "AGENTS.md"
        target.write_text("# Adopted safe global instructions\n", encoding="utf-8")
        result = self.cli(self.a, "adopt", "agents", "--apply")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        state_root = self.base / "state" / "agent-config"
        state = json.loads((state_root / "state.json").read_text())
        self.assertEqual(state["event"], "adopt")
        self.assertEqual(state_root.stat().st_mode & 0o777, 0o700)
        backup_files = list((state_root / "backups").rglob("AGENTS.md"))
        self.assertTrue(backup_files)
        self.assertTrue(all((path.stat().st_mode & 0o777) == 0o600 for path in backup_files))

    def test_rollback_creates_a_new_commit_and_records_recovery_state(self) -> None:
        baseline = self.git(self.a, "rev-parse", "HEAD").stdout.strip()
        previous = self.commit_file(self.a, "temporary-note.md", "remove through rollback\n")
        result = self.cli(self.a, "rollback", baseline)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        current = self.git(self.a, "rev-parse", "HEAD").stdout.strip()
        self.assertNotEqual(current, baseline)
        self.assertNotEqual(current, previous)
        self.assertFalse((self.a / "temporary-note.md").exists())
        state = json.loads((self.base / "state" / "agent-config" / "state.json").read_text())
        self.assertEqual(state["event"], "rollback")
        self.assertEqual(state["previous_head"], previous)
        self.assertEqual(state["last_good_head"], current)


if __name__ == "__main__":
    unittest.main()
