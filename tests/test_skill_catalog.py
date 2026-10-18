#!/usr/bin/env python3
"""Exercise catalog behavior through the real CLI and generator entrypoints."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class SkillCatalogTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="skill-catalog-test-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.checkout = self.base / "checkout"
        for directory in ("bin", "scripts", "dependencies", "profile/skills", "third_party_licenses"):
            (self.checkout / directory).mkdir(parents=True, exist_ok=True)
        for path in ("bin/agent-config", "scripts/skill_catalog.py", "scripts/build_skill_catalog.py"):
            shutil.copy2(ROOT / path, self.checkout / path)
        self.home = self.base / "home"
        self.home.mkdir()
        (self.home / "sentinel").write_text("unchanged\n")
        self.env = os.environ | {
            "HOME": str(self.home),
            "CODEX_HOME": str(self.base / "codex"),
            "XDG_STATE_HOME": str(self.base / "state"),
            "PYTHONPYCACHEPREFIX": str(self.base / "cache"),
        }
        self.env.pop("PYTHONDONTWRITEBYTECODE", None)
        # The CLI's env shebang needs Python, but no package manager or skill tool.
        tool_bin = self.base / "tools"
        tool_bin.mkdir()
        (tool_bin / "python3").symlink_to(sys.executable)
        self.env["PATH"] = str(tool_bin)
        self.env.pop("PYTHONPATH", None)
        self.manifest = {
            "schema_version": 1,
            "profile": {"agents": "profile/AGENTS.md", "skills": ["alpha", "beta"]},
        }
        self.lock = {
            "schema_version": 1,
            "skills": {
                "alpha": {
                    "source": "https://example.org/alpha",
                    "version": "1.0.0",
                    "revision": "a" * 40,
                    "tracking": "pinned-snapshot",
                    "license": "MIT",
                    "license_file": "third_party_licenses/alpha.txt",
                },
                "beta": {"tracking": "local-authored-snapshot"},
            },
        }
        (self.checkout / "third_party_licenses/alpha.txt").write_text("test license\n")
        self.write_inputs()
        self.write_skill("alpha", "description: Alpha purpose.")
        self.write_skill("beta", "description: Beta purpose.")

    def write_inputs(self) -> None:
        (self.checkout / "manifest.yaml").write_text(json.dumps(self.manifest), encoding="utf-8")
        (self.checkout / "dependencies/skills.lock.yaml").write_text(json.dumps(self.lock), encoding="utf-8")

    def write_skill(self, name: str, fields: str, body: str = "No script is needed.\n") -> None:
        path = self.checkout / "profile/skills" / name / "SKILL.md"
        path.parent.mkdir(exist_ok=True)
        path.write_text(f"---\nname: {name}\n{fields}\n---\n{body}", encoding="utf-8")

    def cli(self, *args: str, root: Path | None = None) -> subprocess.CompletedProcess:
        return subprocess.run(
            [str((root or self.checkout) / "bin/agent-config"), "catalog", *args],
            cwd=self.base, env=self.env, text=True, capture_output=True, timeout=15,
        )

    def build(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, "-B", str(self.checkout / "scripts/build_skill_catalog.py"), *args],
            cwd=self.base, env=self.env, text=True, capture_output=True, timeout=15,
        )

    def accepted(self, result: subprocess.CompletedProcess) -> None:
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stderr, "")

    def rejected(self, result: subprocess.CompletedProcess, detail: str | None = None) -> None:
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertTrue(result.stderr.startswith("catalog:"), result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        if detail:
            self.assertIn(detail, result.stderr)

    def snapshot(self, root: Path) -> dict:
        result = {}
        if root.exists():
            for path in root.rglob("*"):
                relative = str(path.relative_to(root))
                if path.is_symlink():
                    result[relative] = ("symlink", os.readlink(path))
                elif path.is_file():
                    info = path.stat()
                    result[relative] = (
                        "file", info.st_mode, info.st_mtime_ns,
                        hashlib.sha256(path.read_bytes()).hexdigest(),
                    )
                else:
                    result[relative] = ("directory", path.stat().st_mode)
        return result

    def test_real_manifest_all_entries_and_exact_names(self) -> None:
        manifest = json.loads((ROOT / "manifest.yaml").read_text())
        lock = json.loads((ROOT / "dependencies/skills.lock.yaml").read_text())["skills"]
        result = self.cli("--json", root=ROOT)
        self.accepted(result)
        data = json.loads(result.stdout)
        self.assertEqual(data["schema_version"], 1)
        self.assertEqual(data["scope"], "manifest.profile.skills")
        self.assertEqual(data["manifest_count"], len(manifest["profile"]["skills"]))
        self.assertEqual(data["count"], len(manifest["profile"]["skills"]))
        self.assertEqual([item["name"] for item in data["skills"]], sorted(manifest["profile"]["skills"]))
        for item in data["skills"]:
            self.assertEqual(item["lock"], lock[item["name"]])
            self.assertEqual(item["path"], f"profile/skills/{item['name']}/SKILL.md")
            self.assertTrue(item["description"].strip())
        self.assertNotIn("sample-no-evals", result.stdout)
        self.assertNotIn("sample-with-evals", result.stdout)

    def test_human_output_has_purpose_provenance_and_missing_license(self) -> None:
        result = self.cli()
        self.accepted(result)
        for expected in (
            "2 of 2 manifest skills", "Purpose: Alpha purpose.",
            "Path: profile/skills/alpha/SKILL.md", "Source: https://example.org/alpha",
            "Version: 1.0.0", "Revision: " + "a" * 40, "Tracking: pinned-snapshot",
            "License: MIT", "License file: third_party_licenses/alpha.txt",
            "License: not declared; no permission inferred",
        ):
            self.assertIn(expected, result.stdout)
        selected = self.cli("--skill", "beta", "--json")
        self.accepted(selected)
        data = json.loads(selected.stdout)
        self.assertEqual((data["count"], data["manifest_count"]), (1, 2))
        self.assertEqual(data["skills"][0]["name"], "beta")
        for key in ("source", "version", "revision", "license", "license_file"):
            self.assertIsNone(data["skills"][0][key])
        self.assertEqual(data["skills"][0]["license_status"], "not-declared")

    def test_unknown_partial_case_and_path_names_fail(self) -> None:
        for name in ("missing", "alph", "Alpha", "../alpha", "*", ""):
            with self.subTest(name=name):
                self.rejected(self.cli("--skill", name, "--json"), "unknown skill")

    def test_all_supported_description_forms_preserve_meaning(self) -> None:
        cases = [
            ("description: Plain text # a comment", "Plain text"),
            ('description: "A \\"quote\\" and \\\\ slash: # text" # comment', 'A "quote" and \\ slash: # text'),
            ("description: 'It''s quoted: # text' # comment", "It's quoted: # text"),
            ("description: >\n  First line\n  continues.\n\n  Second paragraph.", "First line continues.\nSecond paragraph.\n"),
            ("description: |\n  First line\n  second line.\n\n  Last.", "First line\nsecond line.\n\nLast.\n"),
            ("description: >-\n  First\n  second\n\n", "First second"),
            ("description: |+\n  First\n\n", "First\n\n\n"),
            ("description: >\n  Intro\n    code one\n    code two\n  End", "Intro\n  code one\n  code two\nEnd\n"),
            ("description: >\n\n  First\n\n\n  Second", "\nFirst\n\nSecond\n"),
        ]
        for source, expected in cases:
            with self.subTest(source=source):
                self.write_skill("alpha", source)
                result = self.cli("--skill", "alpha", "--json")
                self.accepted(result)
                self.assertEqual(json.loads(result.stdout)["skills"][0]["description"], expected)

    def test_metadata_mapping_sequences_and_duplicate_keys(self) -> None:
        self.write_skill(
            "alpha",
            'description: "Useful"\nmetadata:\n  version: 2.0.1\n  tools:\n    - node\n    - "python3"\n  env: []',
        )
        self.accepted(self.cli("--json"))
        self.write_skill("alpha", "description: Useful\nmetadata:\n  version: one\n  version: two")
        self.rejected(self.cli("--json"), "duplicate key")

    def test_invalid_or_unsupported_frontmatter_fails_without_partial_output(self) -> None:
        cases = [
            "",
            "description:",
            "description: null",
            "description: true",
            "description: 42",
            "description: []",
            "description: [one, two]",
            "description:\n  nested: value",
            "description:\n  - value",
            "description: ''",
            "description: Good\ndescription: Duplicate",
            "description: Good\nname: alpha",
            "description: Text: invalid",
            'description: "unterminated',
            "description: 'unterminated",
            'description: "ok" trailing',
            "description: &anchor value",
            "description: *alias",
            "description: !!str value",
            "description: >2\n  Unsupported",
            "description: >\n    first\n  invalid dedent",
            "description: Plain\n  continuation",
            "description: Good\nmetadata:\n\tbad: indent",
            'description: "\\u001b[31m"',
            'description: "\\ud800"',
        ]
        for fields in cases:
            with self.subTest(fields=fields):
                self.write_skill("beta", fields)
                self.rejected(self.cli("--json"))
                self.rejected(self.cli("--skill", "alpha", "--json"))
        for text in (
            "name: beta\ndescription: Missing delimiter\n",
            "---\nname: beta\ndescription: Missing end\n",
            "---\ndescription: Missing name\n---\n",
            "---\nname: another\ndescription: Wrong name\n---\n",
        ):
            (self.checkout / "profile/skills/beta/SKILL.md").write_text(text)
            self.rejected(self.cli("--json"))

    def test_manifest_missing_unsafe_duplicate_and_non_string_names(self) -> None:
        for names in (["alpha"], ["alpha", "../beta"], ["alpha", "/beta"], ["alpha", "a\\b"],
                      ["alpha", "alpha"], ["alpha", {}], [], "alpha"):
            with self.subTest(names=names):
                self.manifest["profile"]["skills"] = names
                self.write_inputs()
                self.rejected(self.cli("--json"), "manifest")
        self.manifest["profile"]["skills"] = ["alpha", "beta", "missing"]
        self.write_inputs()
        self.rejected(self.cli("--json"), "missing")

    def test_manifest_agents_path_and_schema_are_checked(self) -> None:
        self.manifest["profile"]["agents"] = "../outside"
        self.write_inputs()
        self.rejected(self.cli("--json"), "manifest")
        self.manifest["profile"]["agents"] = "profile/AGENTS.md"
        self.manifest["schema_version"] = True
        self.write_inputs()
        self.rejected(self.cli("--json"), "schema_version")

    def test_lock_mismatch_missing_fields_and_unsafe_license(self) -> None:
        original = json.loads(json.dumps(self.lock))
        changes = [
            ("missing", lambda: self.lock["skills"].pop("beta")),
            ("extra", lambda: self.lock["skills"].update(extra={})),
            ("tracking", lambda: self.lock["skills"]["beta"].clear()),
            ("not-object", lambda: self.lock["skills"].update(beta=[])),
            ("revision", lambda: self.lock["skills"]["alpha"].update(revision="latest")),
            ("source", lambda: self.lock["skills"]["alpha"].update(source="javascript:alert(1)")),
            ("empty-license", lambda: self.lock["skills"]["alpha"].update(license="")),
            ("unsafe-license", lambda: self.lock["skills"]["alpha"].update(license_file="../outside")),
            ("non-string-license", lambda: self.lock["skills"]["alpha"].update(license_file=[])),
            ("nested-unsafe-license", lambda: self.lock["skills"]["beta"].update(
                vendored_dependencies={"dep": {"license_file": "/outside"}})),
        ]
        for label, change in changes:
            with self.subTest(label=label):
                self.lock = json.loads(json.dumps(original))
                change()
                self.write_inputs()
                self.rejected(self.cli("--json"))

    def test_json_duplicate_keys_constants_and_wrong_roots_fail(self) -> None:
        for path in ("manifest.yaml", "dependencies/skills.lock.yaml"):
            for text in (
                '{"schema_version":1,"schema_version":1}',
                '{"schema_version":1,"bad":{"key":1,"key":2}}',
                '{"schema_version":1,"number":NaN}',
                '{"schema_version":1,"number":1e999}',
                "[]", "{bad json", '{"schema_version":1,"number":Infinity}',
            ):
                with self.subTest(path=path, text=text):
                    self.write_inputs()
                    (self.checkout / path).write_text(text)
                    self.rejected(self.cli("--json"))

    def test_symlink_components_and_fifo_are_never_read(self) -> None:
        paths = (
            "manifest.yaml", "dependencies", "dependencies/skills.lock.yaml", "profile",
            "profile/skills", "profile/skills/alpha", "profile/skills/alpha/SKILL.md",
            "third_party_licenses", "third_party_licenses/alpha.txt",
        )
        for relative in paths:
            with self.subTest(relative=relative):
                target = self.checkout / relative
                moved = self.base / "outside"
                target.rename(moved)
                target.symlink_to(moved, target_is_directory=moved.is_dir())
                try:
                    self.rejected(self.cli("--json"))
                finally:
                    target.unlink()
                    moved.rename(target)
        path = self.checkout / "profile/skills/alpha/SKILL.md"
        path.unlink()
        os.mkfifo(path)
        self.rejected(self.cli("--json"), "regular file")

    def test_nested_fixtures_are_not_discovered_or_read(self) -> None:
        nested = self.checkout / "profile/skills/alpha/evals/fixtures/rogue"
        nested.mkdir(parents=True)
        (nested / "SKILL.md").symlink_to(self.base / "nonexistent")
        self.accepted(self.cli("--json"))
        self.rejected(self.cli("--skill", "rogue"), "unknown skill")

    def test_catalog_does_not_install_execute_scripts_or_write_home_or_cache(self) -> None:
        script = self.checkout / "profile/skills/alpha/install.py"
        script.write_text("raise RuntimeError('must not execute')\n")
        before = self.snapshot(self.checkout)
        home_before = self.snapshot(self.home)
        for args in ((), ("--json",), ("--skill", "alpha"), ("--skill", "beta", "--json")):
            self.accepted(self.cli(*args))
        self.assertEqual(self.snapshot(self.checkout), before)
        self.assertEqual(self.snapshot(self.home), home_before)
        for key in ("CODEX_HOME", "XDG_STATE_HOME", "PYTHONPYCACHEPREFIX"):
            self.assertFalse(Path(self.env[key]).exists(), key)

    def test_generation_is_deterministic_and_check_is_read_only(self) -> None:
        before = self.snapshot(self.checkout)
        home_before = self.snapshot(self.home)
        self.rejected(self.build("--check"))
        self.assertEqual(self.snapshot(self.checkout), before)
        self.accepted(self.build())
        target = self.checkout / "docs/skills.md"
        document = target.read_bytes()
        self.accepted(self.build())
        self.assertEqual(target.read_bytes(), document)
        before = self.snapshot(self.checkout)
        self.accepted(self.build("--check"))
        self.assertEqual(self.snapshot(self.checkout), before)
        target.write_bytes(document.replace(b"\n", b"\r\n"))
        before = self.snapshot(self.checkout)
        self.rejected(self.build("--check"), "drift")
        self.assertEqual(self.snapshot(self.checkout), before)
        target.write_bytes(document)
        self.write_skill("beta", "description: Changed description.")
        changed = self.snapshot(self.checkout)
        self.rejected(self.build("--check"), "drift")
        self.assertEqual(self.snapshot(self.checkout), changed)
        self.assertEqual(target.read_bytes(), document)
        self.accepted(self.build())
        self.assertNotEqual(target.read_bytes(), document)
        target.write_text("edited document\n")
        before = self.snapshot(self.checkout)
        self.rejected(self.build("--check"), "drift")
        self.assertEqual(self.snapshot(self.checkout), before)
        self.assertEqual(self.snapshot(self.home), home_before)
        for key in ("CODEX_HOME", "XDG_STATE_HOME", "PYTHONPYCACHEPREFIX"):
            self.assertFalse(Path(self.env[key]).exists(), key)

    def test_document_stays_compact_and_skill_links_resolve(self) -> None:
        self.accepted(self.build())
        text = (self.checkout / "docs/skills.md").read_text()
        self.assertNotIn("```json", text)
        self.assertIn("bin/agent-config catalog --json", text)
        for target in re.findall(r"\]\((\.\./[^)]+)\)", text):
            if target in {"../README.md", "../CONTRIBUTING.md"}:
                continue
            self.assertTrue((self.checkout / "docs" / target).is_file(), target)
        self.assertIn("../profile/skills/alpha/SKILL.md", text)
        self.assertIn("../third_party_licenses/alpha.txt", text)
        self.assertIn("no permission inferred", text)

    def test_markdown_escapes_cells_and_json_preserves_full_description(self) -> None:
        description = "Use | [unsafe](https://bad.example) <img> `code` & *stars*.\n```"
        self.write_skill("alpha", "description: " + json.dumps(description))
        self.lock["skills"]["alpha"]["license"] = "MIT | <b> *text*"
        self.write_inputs()
        self.accepted(self.build())
        text = (self.checkout / "docs/skills.md").read_text()
        self.assertIn(r"Use \| \[unsafe\]\(https://bad.example\) &lt;img&gt; \`code\` &amp; \*stars\*", text)
        self.assertIn(r"MIT \| &lt;b&gt; \*text\*", text)
        self.assertNotIn("<img>", text)
        self.assertEqual(json.loads(self.cli("--json").stdout)["skills"][0]["description"], description)

    def test_generator_rejects_symlink_and_hardlinked_output(self) -> None:
        outside = self.base / "outside.md"
        outside.write_text("keep me\n")
        docs = self.checkout / "docs"
        docs.symlink_to(self.base, target_is_directory=True)
        self.rejected(self.build())
        self.assertFalse((self.base / "skills.md").exists())
        docs.unlink()
        docs.mkdir()
        target = docs / "skills.md"
        target.symlink_to(outside)
        self.rejected(self.build())
        self.rejected(self.build("--check"))
        self.assertEqual(outside.read_text(), "keep me\n")
        target.unlink()
        os.link(outside, target)
        self.rejected(self.build(), "one link")
        self.assertEqual(outside.read_text(), "keep me\n")


if __name__ == "__main__":
    unittest.main()
