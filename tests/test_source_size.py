#!/usr/bin/env python3
"""Pure and mocked source-size tests; never invoke Git or install real hooks."""

from contextlib import redirect_stderr
from io import StringIO
import json
import os
import unittest
from unittest import mock


from source_size_unit_helpers import CheckerUnitTest, IsolatedUnitTest, completed
import source_size as checker
import source_size_policy as policy


class PolicyTests(IsolatedUnitTest):
    def load(self, **fields):
        return policy.load(json.dumps({"version": 1, **fields}))

    def test_missing_policy_and_minimal_schema(self):
        expected = {"generated": [], "baseline": {}}
        self.assertEqual(policy.load(None), expected)
        self.assertEqual(self.load(), expected)
        self.assertEqual(policy.load(b'{"version": 1}'), expected)

    def test_version_requires_integer_one_not_bool_or_float(self):
        for value in (False, True, 0, 2, 1.0, "1", None, [], {}):
            with self.subTest(version=value), self.assertRaises(ValueError):
                policy.load(json.dumps({"version": value}))

    def test_schema_rejects_invalid_json_nonobjects_and_unknown_keys(self):
        for raw in (b"{", b"\xff", b"[]", b"null", b"false", b"1", b'"text"',
                    b"{}", b'{"version":1,"limit":99999}'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                policy.load(raw)

    def test_schema_rejects_wrong_container_types(self):
        for field, values in (("generated", (None, False, 1, "", {})),
                              ("baseline", (None, False, 1, "", []))):
            for value in values:
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    self.load(**{field: value})

    def test_generated_records_require_only_path_and_nonblank_reason(self):
        valid = {"path": "src/api.generated.ts", "reason": "API compiler output"}
        self.assertEqual(self.load(generated=[valid])["generated"], [valid])
        invalid = [None, False, 1, "src/a.py", [], {}, {"path": "src/a.py"},
                   {**valid, "extra": True}]
        invalid += [{**valid, "reason": reason} for reason in (None, False, 1, [], "", " \t\n")]
        for item in invalid:
            with self.subTest(item=item), self.assertRaises(ValueError):
                self.load(generated=[item])

    def test_baseline_ceiling_requires_real_integer_above_default(self):
        for value in (False, True, None, -1, 0, 20_000, 20_001.0, "20001", [], {}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.load(baseline={"src/old.py": {"max_bytes": value, "reason": "Legacy"}})
        self.assertEqual(self.load(baseline={"src/old.py": {
            "max_bytes": 20_001, "reason": "Legacy"
        }})["baseline"]["src/old.py"]["max_bytes"], 20_001)

    def test_baseline_requires_exact_fields_and_reason(self):
        valid = {"max_bytes": 24_000, "reason": "Legacy parser"}
        self.assertEqual(self.load(baseline={"src/old.py": valid})["baseline"],
                         {"src/old.py": valid})
        invalid = [None, False, 1, 24_000, "src/a.py", [], {}, {"max_bytes": 24_000},
                   {**valid, "extra": 1}, {**valid, "extra": True}]
        invalid += [{**valid, "reason": reason} for reason in (None, False, 1, [], "", " \n", " \t\n")]
        for item in invalid:
            with self.subTest(item=item), self.assertRaises(ValueError):
                self.load(baseline={"src/old.py": item})

    def test_absolute_parent_and_nul_paths_are_rejected(self):
        for path in ("", "/src/a.py", "../a.py", "src/../a.py", "src/..",
                     "src/../../a.py", "src/a\x00.py", None, False, 1, [], {}):
            with self.subTest(path=path):
                self.assertFalse(policy.path_ok(path))
                with self.assertRaises(ValueError):
                    self.load(generated=[{"path": path, "reason": "Generated"}])
                if isinstance(path, str):
                    with self.assertRaises(ValueError):
                        self.load(baseline={path: {"max_bytes": 24_000, "reason": "Legacy"}})

    def test_relative_paths_preserve_spaces_newlines_and_unicode(self):
        for path in ("src/two words.py", "src/line\nbreak.py", "src/\u4e2d\u6587.py"):
            with self.subTest(path=path):
                self.assertTrue(policy.path_ok(path))
                baseline = {path: {"max_bytes": 24_000, "reason": "Legacy"}}
                self.assertEqual(self.load(baseline=baseline)["baseline"], baseline)

    def test_baseline_paths_cannot_be_patterns(self):
        for path in ("src/*.py", "src/?.py", "src/[ab].py"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.load(baseline={path: {"max_bytes": 24_000, "reason": "Legacy"}})

    def test_default_boundary_is_20000_not_20001(self):
        self.assertEqual(policy.LIMIT, 20_000)
        rules = self.load()
        for path in ("src/new.py", "tests/test_new.py", "ui/main.css", "bin/check"):
            with self.subTest(path=path):
                self.assertTrue(policy.permitted(path, 20_000, rules))
                self.assertFalse(policy.permitted(path, 20_001, rules))

    def test_baseline_allows_no_growth_and_does_not_follow_rename(self):
        rules = self.load(baseline={"src/old.py": {"max_bytes": 24_000, "reason": "Legacy"}})
        for size in (19_999, 20_000, 20_001, 23_999, 24_000):
            with self.subTest(size=size):
                self.assertTrue(policy.permitted("src/old.py", size, rules))
        self.assertFalse(policy.permitted("src/old.py", 24_001, rules))
        for path in ("src/new.py", "src/old.py.copy", "other/src/old.py", "src/Old.py"):
            with self.subTest(path=path):
                self.assertFalse(policy.permitted(path, 20_001, rules))

    def test_lockfiles_are_excluded_by_exact_basename_only(self):
        rules = self.load()
        expected = ("package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml",
                    "bun.lock", "bun.lockb", "Cargo.lock", "Gemfile.lock", "poetry.lock",
                    "uv.lock", "Pipfile.lock", "composer.lock", "go.sum", "Package.resolved",
                    "Podfile.lock", "flake.lock")
        for name in expected:
            with self.subTest(name=name):
                self.assertTrue(policy.ignored(name, rules))
                self.assertTrue(policy.ignored("vendor/" + name, rules))
                self.assertFalse(policy.ignored("vendor/my-" + name, rules))
                self.assertFalse(policy.ignored(name + ".py", rules))
                self.assertFalse(policy.ignored(name.swapcase(), rules))

    def test_exact_generated_exemption_does_not_cover_similar_paths(self):
        path = "src/api.generated.ts"
        rules = self.load(generated=[{"path": path, "reason": "Schema compiler"}])
        self.assertTrue(policy.ignored(path, rules))
        for other in ("src/Api.generated.ts", path + ".py", "other/" + path,
                      "src/api.ts", "api.generated.ts", "tests/test_api.py"):
            with self.subTest(path=other):
                self.assertFalse(policy.ignored(other, rules))

    def test_generated_patterns_are_rejected_even_with_reasons(self):
        for path in ("*", "**/*.ts", "src/*.generated.ts", "tests/*", "src/?.py", "[ab].py"):
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "exact relative path"):
                self.load(generated=[{"path": path, "reason": "Compiler"}])

    def test_source_suffixes_include_tests_styles_and_language_variants(self):
        suffixes = (".py .pyi .js .jsx .mjs .cjs .ts .tsx .mts .cts .swift .m .mm .h .hpp "
                    ".c .cc .cpp .cxx .rs .go .java .kt .kts .cs .fs .php .rb .r .R .sh "
                    ".bash .zsh .fish .ps1 .lua .pl .ex .exs .erl .hrl .clj .cljs .scala "
                    ".dart .vue .svelte .css .scss .sass .less .sql .proto .graphql .gql")
        for suffix in suffixes.split():
            with self.subTest(suffix=suffix):
                self.assertTrue(policy.is_source("tests/example" + suffix))
        for suffix in (".md", ".json", ".yaml", ".png", ".txt", ".lock", ".PY"):
            with self.subTest(suffix=suffix):
                self.assertFalse(policy.is_source("assets/example" + suffix, b"#!"))

    def test_extensionless_shebangs_and_nonregular_modes(self):
        for mode in ("100644", "100755"):
            with self.subTest(mode=mode):
                self.assertTrue(policy.is_source("bin/tool", b"#!/usr/bin/python3", mode))
                self.assertFalse(policy.is_source("bin/tool", b" #!/bin/sh", mode))
                self.assertFalse(policy.is_source("bin/tool", b"", mode))
        for mode in ("120000", "160000", "040000", "000000"):
            with self.subTest(mode=mode):
                self.assertFalse(policy.is_source("link.py", b"#!", mode))
                self.assertFalse(policy.is_source("bin/link", b"#!", mode))


class CheckerTests(CheckerUnitTest):
    def test_git_keeps_arguments_separate_and_returns_binary_output(self):
        self.process.side_effect = None
        self.process.return_value = completed(b"bytes\x00")
        result = checker.git("repo with spaces", "cat-file", "blob", "odd\nname")
        self.assertEqual(result.stdout, b"bytes\x00")
        self.process.assert_called_once_with(
            ["git", "-C", "repo with spaces", "cat-file", "blob", "odd\nname"], capture_output=True
        )

    def test_git_failures_and_explicit_nonchecking_mode(self):
        self.process.side_effect = None
        result = completed(returncode=128, stderr=b" fatal: bad object \xff\n")
        self.process.return_value = result
        with self.assertRaisesRegex(ValueError, "fatal: bad object"):
            checker.git("repo", "show")
        self.assertIs(checker.git("repo", "show", check=False), result)

    def test_entry_parser_preserves_nul_delimited_names(self):
        names = (b"src/two words.py", b"src/line\nbreak.py", "src/\u4e2d.py".encode(), b"src/\xff.py")
        data = b"".join(b"100644 oid 0\t" + path + b"\x00" for path in names)
        with mock.patch.object(checker, "git", return_value=completed(data)) as git:
            result = checker.entries("repo")
        self.assertEqual(result, {os.fsdecode(path): ("100644", "oid") for path in names})
        self.assertEqual([os.fsencode(path) for path in result], list(names))
        git.assert_called_once_with("repo", "ls-files", "--stage", "-z")

    def test_tree_parser_retains_modes_and_object_ids(self):
        data = b"100755 blob script\tbin/check\0" + b"120000 blob link\tlink.py\0" \
               + b"160000 commit module\tvendor/module\0"
        with mock.patch.object(checker, "git", return_value=completed(data)) as git:
            self.assertEqual(checker.entries("repo", "HEAD"), {
                "bin/check": ("100755", "script"), "link.py": ("120000", "link"),
                "vendor/module": ("160000", "module"),
            })
        git.assert_called_once_with("repo", "ls-tree", "-rz", "--full-tree", "HEAD")

    def test_empty_entries_pass_and_unmerged_entries_fail(self):
        with mock.patch.object(checker, "git", return_value=completed()):
            self.assertEqual(checker.entries("repo"), {})
        for stage in (b"1", b"2", b"3"):
            with self.subTest(stage=stage), mock.patch.object(checker, "git", return_value=
                    completed(b"100644 oid " + stage + b"\tconflict.py\0")):
                with self.assertRaisesRegex(ValueError, "unmerged"):
                    checker.entries("repo")

    def test_entry_parser_rejects_malformed_metadata(self):
        for row in (b"missing-tab", b"100644 oid\ta.py", b"100644 oid 0 extra\ta.py",
                    b"\xff oid 0\ta.py"):
            with self.subTest(row=row), mock.patch.object(checker, "git", return_value=completed(row)):
                with self.assertRaises(ValueError):
                    checker.entries("repo")

    def test_snapshot_policy_reads_only_its_regular_blob(self):
        with mock.patch.object(checker, "blob", return_value=b'{"version":1}') as read:
            self.assertEqual(checker.snapshot_policy("repo", {}), policy.load(None))
            read.assert_not_called()
            for mode in ("100644", "100755"):
                self.assertEqual(checker.snapshot_policy("repo", {policy.POLICY: (mode, "oid")}),
                                 policy.load(None))
            self.assertEqual(read.call_args_list, [mock.call("repo", "oid")] * 2)
        for mode in ("120000", "160000", "040000"):
            with self.subTest(mode=mode), mock.patch.object(checker, "blob") as read:
                with self.assertRaisesRegex(ValueError, "regular file"):
                    checker.snapshot_policy("repo", {policy.POLICY: (mode, "oid")})
                read.assert_not_called()

    def test_inspect_selects_only_changed_existing_index_entries(self):
        files = {"small.py": ("100644", "small"), "unchanged.py": ("100644", "large")}
        result, git, read = self.inspect_files(files, {"small": b"x" * 20_000},
                                              changed=b"small.py\0deleted.py\0")
        self.assertEqual(result, ([], [("small.py", 20_000)]))
        self.assertEqual(git.call_count, 2)
        read.assert_not_called()

    def test_tree_and_all_files_check_every_source_without_diff(self):
        files = {"new.py": ("100644", "large"), "small.css": ("100644", "small")}
        for options in ({"tree": "HEAD"}, {"all_files": True}):
            with self.subTest(options=options):
                result, git, read = self.inspect_files(
                    files, {"large": b"x" * 20_001, "small": b"x" * 20_000}, **options
                )
                self.assertEqual(result, ([("new.py", 20_001)],
                                         [("new.py", 20_001), ("small.css", 20_000)]))
                self.assertEqual(git.call_count, 2)
                read.assert_not_called()

    def test_inspect_never_reads_symlink_submodule_lockfile_or_generated_target(self):
        files = {policy.POLICY: ("100644", "rules"), "link.py": ("120000", "link"),
                 "module.py": ("160000", "module"), "yarn.lock": ("100644", "lock"),
                 "src/generated.py": ("100644", "generated"), "bin/run": ("100755", "script"),
                 "bin/data": ("100644", "text"), "asset.png": ("100644", "asset")}
        rules = {"version": 1, "generated": [{"path": "src/generated.py", "reason": "Compiler"}]}
        blobs = {"rules": json.dumps(rules).encode(), "script": b"#!" + b"x" * 19_999,
                 "text": b"not a script", "asset": b"x" * 20_001}
        result, git, read = self.inspect_files(files, blobs, tree="HEAD")
        self.assertEqual(result, ([("bin/run", 20_001)], [("bin/run", 20_001)]))
        self.assertEqual(read.call_args_list,
                         [mock.call("unit-repo", oid) for oid in ("rules", "script", "text")])
        self.assertEqual(git.call_count, 4)

    def test_inspect_uses_exact_snapshot_baseline_and_rejects_growth(self):
        raw = json.dumps({"version": 1, "baseline": {
            "old.py": {"max_bytes": 24_000, "reason": "Legacy"}
        }}).encode()
        for size in (23_999, 24_000, 24_001):
            with self.subTest(size=size):
                files = {policy.POLICY: ("100644", "rules"), "old.py": ("100644", "old"),
                         "renamed.py": ("100644", "renamed")}
                result, _, _ = self.inspect_files(files, {
                    "rules": raw, "old": b"x" * size, "renamed": b"x" * 24_000
                }, all_files=True)
                expected = [("old.py", size)] if size > 24_000 else []
                self.assertEqual(result[0], expected + [("renamed.py", 24_000)])

    def test_main_routes_modes_and_prints_success(self):
        for argv, tree in (([], None), (["--staged"], None), (["--tree", "revision"], "revision")):
            with self.subTest(argv=argv), mock.patch.object(checker, "git", return_value=
                    completed(b"unit-repo\n")), mock.patch.object(checker, "inspect",
                    return_value=([], [("ok.py", 20_000)])) as inspect:
                code, out, err = self.capture(checker.main, argv)
                self.assertEqual((code, err), (0, ""))
                self.assertIn("checked 1 source file(s); limit 20000 bytes", out)
                inspect.assert_called_once_with("unit-repo", tree)

    def test_main_baseline_proposal_is_head_only_and_has_no_small_files(self):
        with mock.patch.object(checker, "git", return_value=completed(b"repo\n")), \
             mock.patch.object(checker, "inspect", return_value=([], [
                 ("small.py", 20_000), ("old.py", 20_001)
             ])) as inspect:
            code, out, err = self.capture(checker.main, ["--baseline"])
        self.assertEqual((code, err), (0, ""))
        inspect.assert_called_once_with("repo", "HEAD")
        data = json.loads(out)
        self.assertEqual((data["version"], data["generated"]), (1, []))
        self.assertEqual(set(data["baseline"]), {"old.py"})
        self.assertEqual(data["baseline"]["old.py"]["max_bytes"], 20_001)
        self.assertIn("no growth", data["baseline"]["old.py"]["reason"])

    def test_main_blocking_message_contains_path_size_and_recovery_steps(self):
        path = "src/line\nbreak.py"
        with mock.patch.object(checker, "git", return_value=completed(b"repo")), \
             mock.patch.object(checker, "inspect", return_value=([(path, 20_001)], [(path, 20_001)])):
            code, out, err = self.capture(checker.main, ["--staged"])
        self.assertEqual((code, out), (1, ""))
        for text in (repr(path), "20001 bytes", "default limit 20000", "Extract cohesive modules",
                     "Update imports and tests", "git add", "Do not minify", "not a model-specific tokenizer"):
            self.assertIn(text, err)

    def test_main_reports_git_inspect_and_parser_errors_without_traceback(self):
        for error in (ValueError("bad policy"), OSError("git missing"), KeyError("bad entry")):
            with self.subTest(error=error), mock.patch.object(checker, "git", side_effect=error):
                code, out, err = self.capture(checker.main, [])
                self.assertEqual((code, out), (2, ""))
                self.assertIn("source-size: check failed:", err)
                self.assertNotIn("Traceback", err)
        with mock.patch.object(checker, "git", side_effect=[completed(b"repo"), completed(b"bad-row")]):
            code, out, err = self.capture(checker.main, [])
        self.assertEqual((code, out), (2, ""))
        self.assertIn("check failed:", err)
        with mock.patch.object(checker, "git", return_value=completed(b"repo")), \
             mock.patch.object(checker, "inspect", side_effect=ValueError("bad blob size")):
            self.assertEqual(self.capture(checker.main, [])[0], 2)

    def test_cli_rejects_conflicting_modes_before_running_git(self):
        with redirect_stderr(StringIO()), self.assertRaises(SystemExit) as raised:
            checker.main(["--staged", "--tree", "HEAD"])
        self.assertEqual(raised.exception.code, 2)
        self.process.assert_not_called()


if __name__ == "__main__":
    unittest.main()
