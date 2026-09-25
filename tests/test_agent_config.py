#!/usr/bin/env python3

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
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
            "SHELL": "/bin/zsh",
        }
        self.env.pop("ZDOTDIR", None)
        Path(self.env["CODEX_HOME"]).mkdir(parents=True)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def run_cli(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run([str(CLI), *args], env=self.env, text=True, capture_output=True)

    def setup_checkout(self) -> tuple[Path, Path]:
        checkout = self.base / "checkout"
        checkout.mkdir()
        for name in ("bin", "profile", "dependencies", "scripts", "third_party_licenses", ".githooks"):
            shutil.copytree(
                ROOT / name,
                checkout / name,
                ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store"),
            )
        shutil.copy2(ROOT / "manifest.yaml", checkout / "manifest.yaml")
        subprocess.run(["git", "init", "-q", str(checkout)], check=True)
        return checkout, checkout / "bin" / "agent-config"

    def run_setup(self, cli: Path, *args: str) -> subprocess.CompletedProcess[str]:
        environment = self.env | {"GIT_CONFIG_GLOBAL": "/dev/null"}
        return subprocess.run([str(cli), "setup", *args], env=environment, text=True, capture_output=True)

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

    def test_setup_from_fresh_checkout_is_one_command_and_idempotent(self) -> None:
        checkout, cli = self.setup_checkout()
        home = Path(self.env["HOME"])
        home.mkdir()
        (home / ".zprofile").write_text(
            f'export PATH="{Path(sys.executable).parent}:$PATH"\n', encoding="utf-8"
        )
        preview = self.run_setup(cli, "--dry-run")
        self.assertEqual(preview.returncode, 0, preview.stdout + preview.stderr)
        self.assertFalse((Path(self.env["CODEX_HOME"]) / "AGENTS.md").exists())
        self.assertFalse((Path(self.env["HOME"]) / ".local" / "bin").exists())

        first = self.run_setup(cli)
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        self.assertIn("setup complete", first.stdout)
        self.assertEqual((Path(self.env["CODEX_HOME"]) / "AGENTS.md").resolve(), (checkout / "profile" / "AGENTS.md").resolve())
        skills_root = Path(self.env["HOME"]) / ".agents" / "skills"
        for name in SKILLS:
            self.assertEqual((skills_root / name).resolve(), (checkout / "profile" / "skills" / name).resolve())
        commands_dir = Path(self.env["HOME"]) / ".local" / "bin"
        for name in ("agent-config", "codex-hybrid"):
            self.assertEqual((commands_dir / name).resolve(), (checkout / "bin" / name).resolve())
        shell_profile = Path(self.env["HOME"]) / ".zprofile"
        self.assertIn('export PATH="$HOME/.local/bin:$PATH"', shell_profile.read_text(encoding="utf-8"))
        invoked = subprocess.run(
            ["/bin/zsh", "-lc", "agent-config validate"],
            env=self.env, text=True, capture_output=True,
        )
        self.assertEqual(invoked.returncode, 0, invoked.stdout + invoked.stderr)
        (Path(self.env["CODEX_HOME"]) / "config.toml").write_text(
            'model = "gpt-6-sol"\nmodel_reasoning_effort = "xhigh"\n[agents]\nenabled = false\n',
            encoding="utf-8",
        )
        hybrid = subprocess.run(
            ["/bin/zsh", "-lc", "codex-hybrid status --json"],
            env=self.env, text=True, capture_output=True,
        )
        self.assertEqual(hybrid.returncode, 0, hybrid.stdout + hybrid.stderr)
        self.assertFalse(json.loads(hybrid.stdout)["hybridEnabled"])
        hooks = subprocess.run(
            ["git", "-C", str(checkout), "config", "--local", "--get", "core.hooksPath"],
            check=True, text=True, capture_output=True,
        )
        self.assertEqual(hooks.stdout.strip(), ".githooks")

        state = (Path(self.env["XDG_STATE_HOME"]) / "agent-config" / "links.json").read_bytes()
        second = self.run_setup(cli)
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertEqual((Path(self.env["XDG_STATE_HOME"]) / "agent-config" / "links.json").read_bytes(), state)

        for action in ("reconcile", "unlink"):
            result = subprocess.run(
                [str(cli), action, "--apply"], env=self.env, text=True, capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            if action == "reconcile":
                self.assertTrue((commands_dir / "agent-config").is_symlink())
            else:
                self.assertFalse((commands_dir / "agent-config").exists())
                self.assertFalse((commands_dir / "codex-hybrid").exists())

    def test_setup_collision_aborts_before_any_links_or_hooks(self) -> None:
        checkout, cli = self.setup_checkout()
        commands_dir = Path(self.env["HOME"]) / ".local" / "bin"
        commands_dir.mkdir(parents=True)
        existing = commands_dir / "codex-hybrid"
        existing.write_text("keep me", encoding="utf-8")

        result = self.run_setup(cli)
        self.assertEqual(result.returncode, 20, result.stdout + result.stderr)
        self.assertEqual(existing.read_text(encoding="utf-8"), "keep me")
        self.assertFalse((Path(self.env["CODEX_HOME"]) / "AGENTS.md").exists())
        hooks = subprocess.run(
            ["git", "-C", str(checkout), "config", "--local", "--get", "core.hooksPath"],
            text=True, capture_output=True,
        )
        self.assertNotEqual(hooks.returncode, 0)

    def test_setup_respects_existing_hooks_configuration(self) -> None:
        checkout, cli = self.setup_checkout()
        subprocess.run(
            ["git", "-C", str(checkout), "config", "--local", "core.hooksPath", "custom-hooks"],
            check=True,
        )
        result = self.run_setup(cli)
        self.assertEqual(result.returncode, 20, result.stdout + result.stderr)
        self.assertFalse((Path(self.env["CODEX_HOME"]) / "AGENTS.md").exists())
        self.assertEqual(
            subprocess.run(
                ["git", "-C", str(checkout), "config", "--local", "--get", "core.hooksPath"],
                check=True, text=True, capture_output=True,
            ).stdout.strip(),
            "custom-hooks",
        )

    def test_setup_rejects_incomplete_checkout_before_installing(self) -> None:
        checkout, cli = self.setup_checkout()
        (checkout / "bin" / "codex-hybrid").unlink()
        result = self.run_setup(cli)
        self.assertEqual(result.returncode, 30, result.stdout + result.stderr)
        self.assertFalse((Path(self.env["CODEX_HOME"]) / "AGENTS.md").exists())
        self.assertFalse((Path(self.env["HOME"]) / ".local" / "bin" / "agent-config").exists())

    @unittest.skipUnless(sys.platform == "darwin", "Homebrew setup is macOS-specific")
    def test_setup_installs_missing_gitleaks_before_linking(self) -> None:
        checkout, cli = self.setup_checkout()
        fake_bin = self.base / "fake-bin"
        fake_bin.mkdir()
        (fake_bin / "python3").symlink_to(sys.executable)
        package = self.base / "fake-gitleaks"
        package.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        package.chmod(0o755)
        brew = fake_bin / "brew"
        brew.write_text(
            '#!/bin/sh\nprintf "%s" "$*" > "$FAKE_BREW_ARGS"\n'
            'cp "$FAKE_GITLEAKS_SOURCE" "$FAKE_BIN/gitleaks"\n'
            'chmod +x "$FAKE_BIN/gitleaks"\n',
            encoding="utf-8",
        )
        brew.chmod(0o755)
        recorded_args = self.base / "brew-args"
        self.env.update({
            "PATH": f"{fake_bin}:/usr/bin:/bin",
            "FAKE_BIN": str(fake_bin),
            "FAKE_GITLEAKS_SOURCE": str(package),
            "FAKE_BREW_ARGS": str(recorded_args),
        })
        preview = self.run_setup(cli, "--dry-run")
        self.assertEqual(preview.returncode, 0, preview.stdout + preview.stderr)
        self.assertIn("would install gitleaks", preview.stdout)
        self.assertFalse(recorded_args.exists())
        result = self.run_setup(cli)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(recorded_args.read_text(encoding="utf-8"), "install gitleaks")
        self.assertTrue((fake_bin / "gitleaks").is_file())
        self.assertTrue((Path(self.env["CODEX_HOME"]) / "AGENTS.md").is_symlink())

    def test_setup_rolls_back_if_state_write_fails(self) -> None:
        checkout, cli = self.setup_checkout()
        blocked_state = self.base / "blocked-state"
        blocked_state.write_text("not a directory", encoding="utf-8")
        self.env["XDG_STATE_HOME"] = str(blocked_state)

        result = self.run_setup(cli)
        self.assertEqual(result.returncode, 30, result.stdout + result.stderr)
        self.assertFalse((Path(self.env["CODEX_HOME"]) / "AGENTS.md").exists())
        self.assertFalse((Path(self.env["HOME"]) / ".local" / "bin" / "agent-config").exists())
        self.assertFalse((Path(self.env["HOME"]) / ".zprofile").exists())
        hooks = subprocess.run(
            ["git", "-C", str(checkout), "config", "--local", "--get", "core.hooksPath"],
            text=True, capture_output=True,
        )
        self.assertNotEqual(hooks.returncode, 0)


if __name__ == "__main__":
    unittest.main()
