"""Shared fixtures for source-size unit tests; no real subprocess is allowed."""

from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
import subprocess
import sys
import unittest
from unittest import mock


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import source_size as checker


def completed(stdout=b"", returncode=0, stderr=b""):
    return subprocess.CompletedProcess([], returncode, stdout, stderr)


class IsolatedUnitTest(unittest.TestCase):
    def setUp(self):
        self.process = self.patch(
            subprocess, "run", side_effect=AssertionError("real subprocess forbidden in unit tests")
        )

    def patch(self, target, name, **options):
        patcher = mock.patch.object(target, name, **options)
        self.addCleanup(patcher.stop)
        return patcher.start()

    def capture(self, function, *args, **kwargs):
        stdout, stderr = StringIO(), StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            result = function(*args, **kwargs)
        return result, stdout.getvalue(), stderr.getvalue()

    def assert_error(self, result, prefix):
        code, out, err = result
        self.assertEqual((code, out), (2, ""))
        self.assertIn(prefix, err)
        self.assertNotIn("Traceback", err)
        return err


class CheckerUnitTest(IsolatedUnitTest):
    def inspect_files(self, files, blobs, *, tree=None, changed=b"", all_files=False):
        def git_output(repo, *args):
            self.assertEqual(repo, "unit-repo")
            if args == (
                "diff", "--cached", "--name-only", "--no-renames", "--diff-filter=ACMT", "-z"
            ):
                return completed(changed)
            self.assertEqual(args[:2], ("cat-file", "-s"))
            self.assertEqual(len(args), 3)
            return completed(str(len(blobs[args[2]])).encode())

        with mock.patch.object(checker, "entries", return_value=files) as scan, \
             mock.patch.object(checker, "blob", side_effect=lambda repo, oid: blobs[oid]) as read, \
             mock.patch.object(checker, "git", side_effect=git_output) as git:
            result = checker.inspect("unit-repo", tree, all_files=all_files)
        scan.assert_called_once_with("unit-repo", tree)
        self.process.assert_not_called()
        return result, git, read
