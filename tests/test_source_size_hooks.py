#!/usr/bin/env python3
"""Mocked hook unit tests; never install hooks or execute subprocesses."""

import json
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


from source_size_unit_helpers import IsolatedUnitTest, completed
import source_size as checker
import source_size_hooks as hooks


class HookTests(IsolatedUnitTest):
    def test_ownership_record_rejects_symlinks_and_invalid_shapes(self):
        with tempfile.TemporaryDirectory(prefix="source-size-unit-") as temporary:
            record = Path(temporary) / "state.json"
            self.assertIsNone(hooks.read_record(record, {"version", "files"}))
            for data in ([], {"version": True, "files": {}}, {"version": 1},
                         {"version": 1, "files": {}, "unknown": True}):
                record.write_text(json.dumps(data))
                with self.assertRaisesRegex(ValueError, "invalid ownership record"):
                    hooks.read_record(record, {"version", "files"})
            record.write_text('{"version": 1, "files": {}}')
            self.assertEqual(hooks.read_record(record, {"version", "files"}),
                             {"version": 1, "files": {}})
            alias = Path(temporary) / "alias.json"
            alias.symlink_to(record)
            with self.assertRaisesRegex(ValueError, "record collision"):
                hooks.read_record(alias, {"version", "files"})
            self.process.assert_not_called()

    def test_runtime_switch_failure_restores_every_old_file_and_allows_retry(self):
        with tempfile.TemporaryDirectory(prefix="source-size-unit-") as temporary:
            dest = Path(temporary) / "runtime"
            dest.mkdir()
            for name in hooks.RUNTIME:
                (dest / name).write_text("old " + name)
            record = {"version": 1, "files": {name: hashlib.sha256((dest / name).read_bytes()).hexdigest()
                                              for name in hooks.RUNTIME}}
            (dest / "managed.json").write_text(json.dumps(record))
            before = {path.name: path.read_bytes() for path in dest.iterdir()}
            replace = hooks.os.replace
            count = 0

            def fail_second(source, target):
                nonlocal count
                count += 1
                if count == 2:
                    raise OSError("injected switch failure")
                return replace(source, target)

            with mock.patch.object(hooks, "root_path", return_value=dest):
                with mock.patch.object(hooks.os, "replace", side_effect=fail_second):
                    with self.assertRaisesRegex(OSError, "injected switch failure"):
                        hooks.install_runtime()
                self.assertEqual({path.name: path.read_bytes() for path in dest.iterdir()}, before)
                self.assertEqual(hooks.install_runtime(), dest)
            for name in hooks.RUNTIME:
                self.assertEqual((dest / name).read_bytes(), (Path(hooks.__file__).parent / name).read_bytes())
            self.process.assert_not_called()

    def test_git_wrapper_uses_text_and_preserves_failure_handling(self):
        self.process.side_effect = None
        self.process.return_value = completed(" value \n", stderr="", returncode=0)
        self.assertEqual(hooks.git("repo", "config", "--local"), "value")
        self.process.assert_called_once_with(
            ["git", "-C", "repo", "config", "--local"], capture_output=True, text=True
        )
        self.process.return_value = completed("", stderr=" fatal: no config \n", returncode=1)
        with self.assertRaisesRegex(ValueError, "fatal: no config"):
            hooks.git("repo", "config")
        self.assertEqual(hooks.git("repo", "config", check=False), "")

    def test_config_rejects_multiple_values_and_handles_absent_value(self):
        for output, expected in (("", None), ("old/hooks", "old/hooks")):
            with mock.patch.object(hooks, "git", return_value=output) as git:
                self.assertEqual(hooks.config("repo", "local"), expected)
                git.assert_called_once_with("repo", "config", "--local", "--get-all",
                                            "core.hooksPath", check=False)
        with mock.patch.object(hooks, "git", return_value="one\ntwo"):
            with self.assertRaisesRegex(ValueError, "multiple hooksPath"):
                hooks.config("repo", "local")

    def test_config_write_and_restore_commands_are_mocked(self):
        with mock.patch.object(hooks, "git") as git:
            hooks.config("repo", "local", "prior path")
            hooks.config("repo", "local", unset=True)
        self.assertEqual(git.call_args_list, [
            mock.call("repo", "config", "--local", "core.hooksPath", "prior path"),
            mock.call("repo", "config", "--local", "--unset-all", "core.hooksPath", check=False),
        ])

    def test_wrapper_quotes_paths_and_can_be_compiled_without_execution(self):
        runtime = Path("/unit/runtime with 'quotes'")
        source = hooks.wrapper(runtime, "pre-commit")
        compile(source, "unit-hook", "exec")
        self.assertEqual(source.count(hooks.MARKER), 1)
        self.assertIn(repr(str(runtime)), source)
        self.assertIn("dispatch('pre-commit', sys.argv[1:], __file__)", source)
        self.process.assert_not_called()

    def test_default_hooks_uses_exported_directory_before_head_exists(self):
        for environment, expected in (
                ({"GIT_COMMON_DIR": "/unit/common", "GIT_DIR": "/unit/worktree"}, "/unit/common/hooks"),
                ({"GIT_DIR": "/unit/new-repo/.git"}, "/unit/new-repo/.git/hooks"),
                ({"GIT_DIR": "."}, "hooks")):
            with self.subTest(environment=environment), mock.patch.dict(hooks.os.environ, environment, clear=True):
                self.assertEqual(hooks.default_hooks(), Path(expected))
        self.process.assert_not_called()

    def test_default_hooks_resolves_linked_worktree_commondir(self):
        with tempfile.TemporaryDirectory(prefix="source-size-unit-") as temporary:
            common = Path(temporary) / "common"
            directory = common / "worktrees" / "linked"
            directory.mkdir(parents=True)
            link = directory / "commondir"
            for content, expected in (("../..\n", common / "hooks"),
                                      (str(common) + "\n", common / "hooks")):
                link.write_text(content)
                with mock.patch.dict(hooks.os.environ, {"GIT_DIR": str(directory)}, clear=True):
                    self.assertEqual(hooks.default_hooks().resolve(), expected.resolve())
        self.process.assert_not_called()

    def dispatch(self, name="pre-commit", args=(), state=None, gate=0, exists=True, executable=True):
        state = {"previous": "/unit/prior"} if state is None else state
        with mock.patch.dict(hooks.os.environ, {}, clear=True), \
             mock.patch.object(Path, "read_text", return_value=json.dumps(state)), \
             mock.patch.object(Path, "resolve", autospec=True, side_effect=lambda path: path), \
             mock.patch.object(Path, "is_file", return_value=exists), \
             mock.patch.object(hooks.os, "access", return_value=executable), \
             mock.patch.object(hooks, "git", return_value="/unit/common") as git, \
             mock.patch.object(checker, "main", return_value=gate) as check:
            result = self.capture(hooks.dispatch, name, list(args), "/unit/hooks/" + name)
        return result, git, check

    def test_precommit_gate_blocks_before_old_hook(self):
        for gate in (1, 2):
            with self.subTest(gate=gate):
                result, git, check = self.dispatch(gate=gate)
                self.assertEqual(result, (gate, "", ""))
                check.assert_called_once_with(["--staged"])
                git.assert_not_called()
                self.process.assert_not_called()

    def test_dispatch_preserves_hook_arguments_exit_code_and_inherited_stdin(self):
        self.process.side_effect = None
        self.process.return_value = completed(returncode=7)
        result, git, check = self.dispatch("pre-push", ("origin", "url with spaces"))
        self.assertEqual(result, (7, "", ""))
        self.process.assert_called_once_with(["/unit/prior/pre-push", "origin", "url with spaces"])
        git.assert_not_called()
        check.assert_not_called()

    def test_successful_gate_uses_default_git_hooks_when_no_prior_config(self):
        self.process.side_effect = None
        self.process.return_value = completed()
        result, git, check = self.dispatch(state={"previous": None})
        self.assertEqual(result, (0, "", ""))
        check.assert_called_once_with(["--staged"])
        git.assert_called_once_with(".", "rev-parse", "--path-format=absolute", "--git-common-dir")
        self.process.assert_called_once_with(["/unit/common/hooks/pre-commit"])

    def test_absent_or_nonexecutable_hooks_are_not_started(self):
        for exists, executable in ((False, True), (True, False)):
            with self.subTest(exists=exists, executable=executable):
                self.assertEqual(self.dispatch(exists=exists, executable=executable)[0], (0, "", ""))
                self.process.assert_not_called()

    def test_dispatch_reports_missing_state_fields_and_recursive_chain(self):
        for state in ({}, {"previous": "/unit/hooks"}):
            with self.subTest(state=state):
                result, _, _ = self.dispatch(state=state)
                self.assertEqual(result[:2], (2, ""))
                self.assertIn("hook dispatch failed:", result[2])
                self.process.assert_not_called()

    def test_dispatch_reports_state_read_json_and_process_errors(self):
        for error in (OSError("missing state"), ValueError("invalid JSON")):
            with self.subTest(error=error), mock.patch.object(Path, "read_text", side_effect=error):
                code, out, err = self.capture(hooks.dispatch, "pre-push", [], "/unit/hooks/pre-push")
                self.assertEqual((code, out), (2, ""))
                self.assertIn("hook dispatch failed:", err)
        self.process.side_effect = OSError("hook missing")
        result, _, _ = self.dispatch("pre-push")
        self.assertEqual(result[:2], (2, ""))
        self.assertIn("hook missing", result[2])

    def test_install_main_reports_expected_errors_without_real_installation(self):
        for error in (OSError("no permission"), ValueError("collision"), KeyError("previous")):
            with self.subTest(error=error), mock.patch.object(sys, "argv", ["hooks", "install"]), \
                 mock.patch.object(hooks, "install", side_effect=error) as install:
                code, out, err = self.capture(hooks.main)
                self.assertEqual((code, out), (2, ""))
                self.assertIn("installation failed:", err)
                install.assert_called_once_with("local", ".")
                self.process.assert_not_called()


if __name__ == "__main__":
    unittest.main()
