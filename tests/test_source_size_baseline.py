"""Pure provenance tests; subprocess calls remain mocked."""

from unittest import mock
import unittest

from source_size_unit_helpers import IsolatedUnitTest, completed
import source_size as checker


def rules(ceiling=None):
    return {"generated": [], "baseline": {} if ceiling is None else {
        "old.py": {"max_bytes": ceiling, "reason": "Legacy source"}}}


class BaselineTests(IsolatedUnitTest):
    def validate(self, snapshots, current, *, tree=None, head="old", parents=None):
        snapshots = {revision: (dict(files), policy) for revision, (files, policy) in snapshots.items()}
        parents = parents or {}
        calls = []

        def git(repo, *args, **kwargs):
            calls.append(args)
            if args[:2] == ("cat-file", "-t"):
                return completed(b"commit" if args[2] in snapshots else b"tree")
            if args[:2] == ("cat-file", "-s"):
                return completed(args[2].encode())
            if args[:2] == ("cat-file", "-p"):
                parent = parents.get(args[2])
                return completed(("tree unused\n" + ("parent " + parent + "\n" if parent else "")).encode())
            if args[:3] == ("rev-parse", "--verify", "--quiet"):
                return completed(head.encode() if head else b"", returncode=0 if head else 1)
            if args[:2] == ("rev-parse", "--verify"):
                return completed(args[2].encode())
            if args[0] == "log":
                return completed("\n".join(parents).encode())
            raise AssertionError(args)

        with mock.patch.object(checker, "entries", side_effect=lambda repo, rev: snapshots[rev][0]), \
             mock.patch.object(checker, "snapshot_policy", side_effect=lambda repo, files: next(
                 policy for entries, policy in snapshots.values() if entries is files)), \
             mock.patch.object(checker, "git", side_effect=git):
            checker.validate_baselines("unit", *current, tree)
        self.process.assert_not_called()
        return calls

    def test_no_baseline_needs_no_history(self):
        self.assertEqual(self.validate({}, ({}, rules())), [])

    def test_new_large_source_and_new_baseline_are_rejected(self):
        for head in (None, "old"):
            with self.subTest(head=head), self.assertRaisesRegex(ValueError, "cannot exempt new source"):
                self.validate({"old": ({}, rules())},
                              ({"old.py": ("100644", "21000")}, rules(21000)), head=head)

    def test_first_ceiling_must_not_exceed_existing_source(self):
        for oldsize in ("19999", "21000"):
            with self.subTest(oldsize=oldsize), self.assertRaisesRegex(ValueError, "pre-existing oversized"):
                self.validate({"old": ({"old.py": ("100644", oldsize)}, rules())},
                              ({"old.py": ("100644", "22000")}, rules(22000)))

    def test_legal_first_baseline_and_reduction_pass(self):
        self.validate({"old": ({"old.py": ("100644", "22000")}, rules())},
                      ({"old.py": ("100644", "21000")}, rules(22000)))

    def test_existing_ceiling_cannot_increase(self):
        with self.assertRaisesRegex(ValueError, "cannot increase"):
            self.validate({"old": ({"old.py": ("100644", "21000")}, rules(21000))},
                          ({"old.py": ("100644", "22000")}, rules(22000)))

    def test_unchanged_ceiling_has_to_reach_valid_history(self):
        files = {"old.py": ("100644", "21000")}
        self.validate({"old": (files, rules(21000)), "before": (files, rules())},
                      (files, rules(21000)), parents={"old": "before"})

    def test_committed_root_or_inherited_bad_baseline_is_rejected(self):
        files = {"old.py": ("100644", "21000")}
        for tree, parents in (("old", {"old": None}),
                              ("child", {"child": "old", "old": None})):
            with self.subTest(tree=tree), self.assertRaisesRegex(ValueError, "cannot exempt new source"):
                self.validate({"old": (files, rules(21000)), "child": (files, rules(21000))},
                              (files, rules(21000)), tree=tree, parents=parents)

    def test_deleted_path_cannot_be_reintroduced_under_old_ceiling(self):
        with self.assertRaisesRegex(ValueError, "cannot exempt new source"):
            self.validate({"old": ({}, rules(21000))},
                          ({"old.py": ("100644", "21000")}, rules(21000)))

    def test_missing_history_is_rejected(self):
        files = {"old.py": ("100644", "21000")}
        with self.assertRaisesRegex(ValueError, "history unavailable"):
            self.validate({"old": (files, rules(21000))}, (files, rules(21000)))


if __name__ == "__main__":
    unittest.main()
