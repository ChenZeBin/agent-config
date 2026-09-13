"""Deterministic protocol tests. Simulated reviewers are NOT model acceptance evidence."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("gate", Path(__file__).resolve().parents[1] / "scripts/evidence_gate.py")
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


class GateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="evidence-unit-")
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / "project"
        self.root.mkdir()
        self.source = self.root / "main.py"
        self.source.write_text("print(42)\n")
        self.state = self.base / "state"
        self.test_policy = self.base / "test-reviewer-policy.json"
        gate.atomic_json(self.test_policy, {"version": 1, "reviewers": []})
        self.policy_patch = patch.object(gate, "TRUST_POLICY", self.test_policy)
        self.policy_patch.start()
        self.store = gate.Store(self.state, "unit-session")
        self.contract = {
            "version": 1, "user_request": "程序应输出 42，经过运行检查后交付。", "root": str(self.root),
            "inputs": ["main.py"], "artifacts": {"program": "main.py"},
            "checks": [{"id": "run", "argv": [sys.executable, "-B", "-c", "import subprocess,sys; assert subprocess.check_output([sys.executable,'-B','main.py']).strip()==b'42'"], "cwd": ".", "timeout": 5}],
            "evidence": [], "criteria": [{"id": "answer", "requirement": "真实运行输出 42", "refs": ["check:run", "artifact:program"]}]
        }
        self.task = None

    def tearDown(self):
        self.policy_patch.stop()
        self.temp.cleanup()

    def init(self):
        self.task = self.store.init(self.contract)
        return self.task

    def checked(self):
        self.init()
        gate.run_checks(self.store, self.task)
        self.assertEqual(gate.verify(self.task)["status"], "checks_pass")

    def simulated_review(self, mode="pass"):
        reviewer = self.base / "simulated-codex"
        report = {"verdict": "accepted", "request_coverage": "complete",
                  "criteria": [{"id": "answer", "verdict": "pass", "reason": "仅用于单测的模拟审查"}],
                  "findings": ["SIMULATED REVIEW; not a real independent model result"]}
        if mode == "reject":
            report.update(verdict="rejected", request_coverage="incomplete")
        if mode == "partial":
            report["criteria"] = []
        text = "not json" if mode == "bad_json" else json.dumps(report)
        program = "#!/usr/bin/env python3\nimport sys,pathlib,time\n"
        if mode == "timeout":
            program += "time.sleep(5)\n"
        elif mode == "empty":
            program += "sys.exit(0)\n"
        elif mode == "error":
            program += "sys.exit(3)\n"
        else:
            program += f"pathlib.Path(sys.argv[sys.argv.index('-o')+1]).write_text({text!r})\n"
        reviewer.write_text(program)
        reviewer.chmod(0o700)
        # Test-only injection into module memory, not a public production override.
        gate.atomic_json(self.test_policy, {"version": 1, "reviewers": [{"path": str(reviewer), "sha256": gate.file_hash(reviewer)}]})
        self.task["policy_digest"] = gate.file_hash(self.test_policy)
        gate.run_checks(self.store, self.task)
        gate.run_review(self.store, self.task, str(reviewer), 0.15 if mode == "timeout" else 5)

    def accepted(self):
        self.checked()
        self.simulated_review()
        self.assertEqual(gate.verify(self.task)["status"], "accepted")

    def pre_delivery_contract(self, commands=None, steps=None):
        plan = {
            "id": "commit-record", "requirement": "交付后核验提交记录与已验收内容一致",
            "deferred_action_ids": ["commit"],
        }
        if steps is not None:
            plan["steps"] = steps
        self.contract.update({
            "acceptance_stage": "pre_delivery",
            "deferred_actions": [{
                "id": "commit", "description": "将已验收内容提交到当前仓库",
                "approved_commands": commands or ["git commit -m deliver"],
            }],
            "post_delivery_verification": [plan],
        })

    def pre_delivery_accepted(self, commands=None, steps=None):
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        self.pre_delivery_contract(commands, steps)
        self.checked()
        self.simulated_review()
        status = gate.verify(self.task)
        self.assertEqual(status["status"], "accepted")
        self.assertEqual(status["acceptance_stage"], "pre_delivery")
        self.assertFalse(status["goal_complete"])

    def payload(self, event="Stop", **changes):
        result = {"hook_event_name": event, "session_id": self.store.session, "cwd": str(self.root),
                  "turn_id": "t1", "stop_hook_active": False, "last_assistant_message": "已完成。"}
        result.update(changes)
        return result

    def pre(self, command, **changes):
        return gate.hook(self.state, self.payload("PreToolUse", tool_name="exec_command", tool_input={"cmd": command}, **changes))

    def test_network_check_schema_rejects_invalid_declarations(self):
        for value in ([], {}, [{"id":"missing","max_age_seconds":60}],
                      [{"id":"run","max_age_seconds":True}],
                      [{"id":"run","max_age_seconds":0}],
                      [{"id":"run","max_age_seconds":86401}],
                      [{"id":"run","max_age_seconds":1.5}],
                      [{"id":"run","max_age_seconds":60,"trust":True}],
                      [{"id":"run","max_age_seconds":60}]*2):
            with self.subTest(value=value):
                self.contract["network_checks"] = value
                with self.assertRaises(gate.GateError):
                    gate.validate_contract(self.contract, self.state)

    def test_network_check_fresh_receipt_still_needs_independent_review(self):
        self.contract["network_checks"] = [{"id":"run","max_age_seconds":60}]
        self.checked()
        self.assertEqual(gate.verify(self.task)["status"], "checks_pass")
        self.simulated_review()
        self.assertEqual(gate.verify(self.task)["status"], "accepted")

    def test_network_check_must_be_referenced_by_criterion(self):
        self.contract["network_checks"] = [{"id":"run","max_age_seconds":60}]
        self.contract["criteria"][0]["refs"] = ["artifact:program"]
        with self.assertRaises(gate.GateError):
            self.init()

    def test_network_check_executable_hash_is_checked(self):
        self.contract["network_checks"] = [{"id":"run","max_age_seconds":60}]
        self.checked()
        receipt=self.task["checks"]["run"]
        self.assertEqual(receipt["executable"]["sha256"],gate.file_hash(receipt["executable"]["path"]))
        receipt["executable"]["sha256"]="invalid"
        self.assertIn("联网检查执行文件缺失或改变: run",gate.verify(self.task)["issues"])

    def test_network_check_expires_after_successful_review(self):
        self.contract["network_checks"] = [{"id":"run","max_age_seconds":60}]
        self.accepted()
        with patch.object(gate.time, "time", return_value=gate.time.time()+61):
            result=gate.verify(self.task)
        self.assertEqual(result["status"], "unverified")
        self.assertIn("联网检查超出有效期: run", result["issues"])

    def test_network_check_rejects_bad_timestamps(self):
        self.contract["network_checks"] = [{"id":"run","max_age_seconds":60}]
        self.checked()
        receipt=self.task["checks"]["run"]
        original=dict(receipt)
        for fields in ({"started_at":"invalid"}, {"finished_at":None},
                       {"started_at":"2000-01-01T00:00:00+00:00"},
                       {"finished_at":"2999-01-01T00:00:00+00:00"},
                       {"finished_at":"2000-01-01T00:00:00+00:00"},
                       {"started_at":"2026-01-01T00:00:00"}):
            with self.subTest(fields=fields):
                receipt.clear();receipt.update(original);receipt.update(fields)
                self.assertIn("联网检查缺失或时间记录无效: run",gate.verify(self.task)["issues"])

    def test_network_check_age_uses_start_not_end(self):
        self.contract["network_checks"] = [{"id":"run","max_age_seconds":60}]
        self.checked()
        current=gate.time.time()
        stamp=lambda seconds: gate.dt.datetime.fromtimestamp(seconds,gate.dt.timezone.utc).isoformat()
        self.task["created_at"]=stamp(current-120)
        self.task["checks"]["run"].update(started_at=stamp(current-61),finished_at=stamp(current-1))
        self.assertIn("联网检查超出有效期: run",gate.network_check_issues(self.task))

    def test_network_check_missing_failure_and_tampering_remain_rejected(self):
        self.contract["network_checks"] = [{"id":"run","max_age_seconds":60}]
        self.init()
        self.assertEqual(gate.verify(self.task)["status"],"unverified")
        gate.run_checks(self.store,self.task)
        self.task["checks"]["run"]["exit_code"]=1
        self.assertEqual(gate.verify(self.task)["status"],"unverified")
        gate.run_checks(self.store,self.task)
        Path(self.task["checks"]["run"]["stdout"]).write_text("fabricated success")
        self.assertEqual(gate.verify(self.task)["status"],"unverified")

    def test_missing_checks_never_accept(self):
        self.init()
        self.assertEqual(gate.verify(self.task)["status"], "unverified")

    def test_zero_exit_only_checks_pass(self):
        self.checked()
        self.assertEqual(gate.verify(self.task)["status"], "checks_pass")

    def test_failed_check(self):
        self.source.write_text("print(41)\n")
        self.init()
        gate.run_checks(self.store, self.task)
        self.assertNotEqual(gate.verify(self.task)["status"], "accepted")

    def test_missing_artifact(self):
        self.init()
        self.source.unlink()
        self.assertEqual(gate.verify(self.task)["status"], "unverified")

    def test_empty_artifact(self):
        self.source.write_text("")
        self.init()
        self.assertIn("交付产物为空", " ".join(gate.verify(self.task)["issues"]))

    def test_stale_artifact(self):
        self.accepted()
        self.source.write_text("print(43)\n")
        self.assertEqual(gate.verify(self.task)["status"], "unverified")

    def test_changed_executable_mode(self):
        self.accepted()
        self.source.chmod(0o700)
        self.assertEqual(gate.verify(self.task)["status"], "unverified")

    def test_changed_check_log(self):
        self.accepted()
        Path(self.task["checks"]["run"]["stdout"]).write_text("edited log")
        self.assertEqual(gate.verify(self.task)["status"], "unverified")

    def test_changed_contract(self):
        self.accepted()
        self.task["contract"]["checks"] = []
        self.assertEqual(gate.verify(self.task)["status"], "unverified")

    def test_no_check_does_not_auto_accept(self):
        self.contract["checks"] = []
        self.contract["criteria"][0]["refs"] = ["artifact:program"]
        self.init()
        self.assertEqual(gate.verify(self.task)["status"], "checks_pass")

    def test_check_that_modifies_input_invalidated(self):
        self.contract["checks"][0]["argv"] = [sys.executable, "-c", "from pathlib import Path; Path('main.py').write_text('print(43)')"]
        self.init()
        with self.assertRaises(gate.GateError):
            gate.run_checks(self.store, self.task)
        self.assertEqual(gate.verify(self.task)["status"], "unverified")

    def test_command_missing(self):
        self.contract["checks"][0]["argv"] = ["/no/such/program"]
        self.init()
        gate.run_checks(self.store, self.task)
        self.assertEqual(gate.verify(self.task)["status"], "unverified")

    def test_timeout(self):
        result = gate.run_process([sys.executable, "-c", "import time; time.sleep(5)"], self.root, self.base / "timeout", 0.15)
        self.assertEqual(result["error"], "timeout")
        self.assertFalse(gate.log_valid(result))

    def test_signal(self):
        result = gate.run_process([sys.executable, "-c", "import os,signal; os.kill(os.getpid(),signal.SIGTERM)"], self.root, self.base / "signal", 5)
        self.assertLess(result["exit_code"], 0)
        self.assertFalse(gate.log_valid(result))

    def test_output_cap(self):
        result = gate.run_process([sys.executable, "-c", "import sys; sys.stdout.write('x'*4000000)"], self.root, self.base / "large", 5)
        self.assertEqual(result["error"], "output_limit")
        self.assertLessEqual(Path(result["stdout"]).stat().st_size, gate.MAX_LOG)

    def test_argv_does_not_expand_shell(self):
        result = gate.run_process(["/bin/echo", "$(touch pwned); > pwned"], self.root, self.base / "literal", 5)
        self.assertEqual(result["exit_code"], 0)
        self.assertFalse((self.root / "pwned").exists())

    def test_review_failure_modes(self):
        self.checked()
        for mode in ("reject", "partial", "bad_json", "timeout", "empty", "error"):
            with self.subTest(mode=mode):
                self.simulated_review(mode)
                self.assertNotEqual(gate.verify(self.task)["status"], "accepted")

    def test_unavailable_reviewer_clears_old_pass(self):
        self.accepted()
        with self.assertRaises(gate.GateError):
            gate.run_review(self.store, self.task, "/no/such/codex", 5)
        self.assertEqual(gate.verify(self.task)["status"], "checks_pass")

    def test_review_output_mutation(self):
        self.accepted()
        Path(self.task["review"]["output"]).write_text("{}")
        self.assertEqual(gate.verify(self.task)["status"], "checks_pass")

    def test_reviewer_binary_change(self):
        self.accepted()
        Path(self.task["review"]["binary"]).write_text("# replaced reviewer")
        self.assertEqual(gate.verify(self.task)["status"], "checks_pass")

    def evidence_contract(self):
        self.contract["evidence"] = [{"id": "runtime", "kind": "file", "description": "实际运行记录"}]
        self.contract["criteria"][0]["refs"].append("evidence:runtime")

    def test_missing_evidence(self):
        self.evidence_contract()
        self.init()
        gate.run_checks(self.store, self.task)
        self.assertIn("证据缺失", " ".join(gate.verify(self.task)["issues"]))

    def test_old_evidence_rejected(self):
        self.evidence_contract()
        source = self.base / "old.txt"
        source.write_text("old")
        os.utime(source, (1, 1))
        self.init()
        with self.assertRaises(gate.GateError):
            gate.record_evidence(self.store, self.task, "runtime", source)

    def test_evidence_bound_to_current_artifact(self):
        self.evidence_contract()
        self.init()
        gate.run_checks(self.store, self.task)
        source = self.base / "runtime.txt"
        source.write_text("fresh raw runtime record")
        gate.record_evidence(self.store, self.task, "runtime", source)
        self.assertEqual(gate.verify(self.task)["status"], "checks_pass")
        self.source.write_text("print(43)")
        self.assertIn("证据缺失/过期", " ".join(gate.verify(self.task)["issues"]))

    def test_evidence_copy_tamper(self):
        self.evidence_contract()
        self.init()
        gate.run_checks(self.store, self.task)
        source = self.base / "runtime.txt"
        source.write_text("fresh")
        gate.record_evidence(self.store, self.task, "runtime", source)
        Path(self.task["evidence"]["runtime"]["copy"]).write_text("modified")
        self.assertEqual(gate.verify(self.task)["status"], "unverified")

    def test_symlink_input_rejected(self):
        target = self.base / "external.py"
        target.write_text("print(42)")
        self.source.unlink()
        self.source.symlink_to(target)
        with self.assertRaises(gate.GateError):
            self.init()

    def test_directory_covers_new_files(self):
        self.contract["inputs"] = ["."]
        self.accepted()
        (self.root / "new.py").write_text("new content")
        self.assertEqual(gate.verify(self.task)["status"], "unverified")

    def test_no_silent_task_replacement(self):
        self.init()
        with self.assertRaises(gate.GateError):
            self.store.init(self.contract)

    def test_pre_delivery_requires_structured_actions_and_plan(self):
        self.contract["acceptance_stage"] = "pre_delivery"
        with self.assertRaises(gate.GateError):
            self.init()

    def test_post_delivery_step_rejects_gate_delivery_command(self):
        self.pre_delivery_contract(steps=[{"id": "bad", "argv": ["git", "push"], "cwd": ".", "outputs": ["package.txt"]}])
        with self.assertRaises(gate.GateError):
            self.init()

    def test_post_delivery_step_output_requires_next_checked_artifact(self):
        build = self.root / "build_package.py"
        build.write_text("from pathlib import Path; Path('package.txt').write_text('package')\n")
        step = {"id": "package", "argv": [sys.executable, "-B", "build_package.py"], "cwd": ".", "outputs": ["package.txt"]}
        self.pre_delivery_accepted(steps=[step])
        next_contract = json.loads(json.dumps(self.contract))
        next_contract.pop("acceptance_stage")
        next_contract.pop("deferred_actions")
        next_contract.pop("post_delivery_verification")
        next_contract["artifacts"]["package"] = "package.txt"
        next_contract["criteria"][0]["refs"].append("artifact:package")
        with self.assertRaises(gate.GateError):
            self.store.init(next_contract, allow_stage_transition=True)
        subprocess.run([sys.executable, "-B", str(build)], cwd=self.root, check=True)
        self.assertEqual(gate.verify(self.task)["status"], "accepted")
        missing_ref = json.loads(json.dumps(next_contract))
        missing_ref["criteria"][0]["refs"].remove("artifact:package")
        with self.assertRaises(gate.GateError):
            self.store.init(missing_ref, allow_stage_transition=True)
        advanced = self.store.init(next_contract, allow_stage_transition=True)
        self.assertEqual(advanced["previous_task"], self.task["id"])
        self.pre_delivery_contract()
        self.contract["post_delivery_verification"][0]["deferred_action_ids"] = []
        with self.assertRaises(gate.GateError):
            self.init()

    def test_pre_delivery_does_not_replace_active_task(self):
        self.pre_delivery_accepted()
        with self.assertRaises(gate.GateError):
            self.store.init(self.contract)

    def test_pre_delivery_requires_explicit_same_request_advance(self):
        self.pre_delivery_accepted()
        next_contract = json.loads(json.dumps(self.contract))
        next_contract["deferred_actions"][0]["approved_commands"] = ["git push"]
        advanced = self.store.init(next_contract, allow_stage_transition=True)
        self.assertEqual(advanced["previous_task"], self.task["id"])
        previous = gate.read_json(self.store.path(self.task) / "task.json")
        self.assertEqual(previous["lifecycle"], "advanced")
        self.assertEqual(previous["advanced_to"], advanced["id"])

    def test_pre_delivery_advance_rejects_changed_request_or_unready_stage(self):
        self.pre_delivery_accepted()
        changed = json.loads(json.dumps(self.contract))
        changed["user_request"] = "不同的用户目标"
        with self.assertRaises(gate.GateError):
            self.store.init(changed, allow_stage_transition=True)
        other = gate.Store(self.base / "other-state", "other-session")
        other.init(self.contract)
        with self.assertRaises(gate.GateError):
            other.init(self.contract, allow_stage_transition=True)

    def test_pre_delivery_allows_only_exact_declared_delivery(self):
        self.pre_delivery_accepted()
        self.assertEqual(self.pre("git commit -m deliver"), {})
        for command in ("git commit -m other", "git push", "git tag v1"):
            with self.subTest(command=command):
                result = self.pre(command)
                self.assertEqual(result["hookSpecificOutput"]["permissionDecision"], "deny")
                self.assertIn("精确声明", result["hookSpecificOutput"]["permissionDecisionReason"])

    def test_pre_delivery_still_enforces_delivery_scope(self):
        self.pre_delivery_accepted(["echo bypass && git commit -m deliver"])
        result = self.pre("echo bypass && git commit -m deliver")
        self.assertEqual(result["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertIn("独立 simple command", result["hookSpecificOutput"]["permissionDecisionReason"])

    def test_pre_delivery_blocks_stop_completion_and_goal_complete(self):
        self.pre_delivery_accepted()
        stopped = gate.hook(self.state, self.payload(last_assistant_message="本次任务已完成。"))
        self.assertEqual(stopped["decision"], "block")
        payload = self.payload("PreToolUse", tool_name="update_goal", tool_input={"status": "complete"})
        result = gate.hook(self.state, payload)
        self.assertEqual(result["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertIn("不能声明目标完成", result["hookSpecificOutput"]["permissionDecisionReason"])

    def test_pre_delivery_expired_evidence_blocks_declared_delivery(self):
        self.pre_delivery_accepted(["git push"])
        self.source.write_text("print(43)\n")
        self.assertEqual(gate.verify(self.task)["status"], "unverified")
        result = self.pre("git push")
        self.assertEqual(result["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertIn("检查缺失/失败/过期", result["hookSpecificOutput"]["permissionDecisionReason"])

    def test_completion_default_reports_goal_complete(self):
        self.accepted()
        status = gate.verify(self.task)
        self.assertEqual(status["acceptance_stage"], "completion")
        self.assertTrue(status["goal_complete"])

    def test_explicit_completion_stage_is_compatible(self):
        self.contract["acceptance_stage"] = "completion"
        self.accepted()

    def test_closed_never_accepts_and_blocks_delivery(self):
        self.accepted()
        self.task.update(lifecycle="closed", close_reason="用户取消")
        self.store.save(self.task)
        self.assertEqual(gate.verify(self.task)["status"], "closed_unverified")
        self.assertIn("hookSpecificOutput", self.pre("git push"))

    def test_session_isolation(self):
        self.init()
        self.assertEqual(gate.hook(self.state, self.payload(session_id="other-session")), {})

    def test_normal_unregistered_question(self):
        self.assertEqual(gate.hook(self.state, self.payload()), {})

    def test_stop_bounded_continuation(self):
        self.init()
        first = gate.hook(self.state, self.payload())
        second = gate.hook(self.state, self.payload())
        self.assertEqual(first["decision"], "block")
        self.assertNotIn("decision", second)
        self.assertEqual(gate.verify(self.store.load())["status"], "unverified")

    def test_honest_incomplete_no_continuation(self):
        self.init()
        result = gate.hook(self.state, self.payload(last_assistant_message="未完成：运行检查失败。"))
        self.assertNotIn("decision", result)

    def test_accepted_no_stop_block(self):
        self.accepted()
        self.assertEqual(gate.hook(self.state, self.payload()), {})

    def test_pretool_blocks_direct_delivery(self):
        self.init()
        for command in ("git commit -m fix", '"/usr/bin/git" commit -m fix', "g\\it push", "git 'commit' -m fix", "/usr/bin/git -C /tmp/demo push", "git -c user.name=test commit -m fix", "gh pr create", "npm publish", "cargo publish", "gh release create v1", "git tag v1"):
            with self.subTest(command=command):
                self.assertEqual(self.pre(command)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_pretool_allows_repair(self):
        self.init()
        self.assertEqual(self.pre("python3 -m unittest"), {})
        self.assertEqual(self.pre("rg 'git commit'"), {})

    def test_global_option_values_do_not_hide_delivery(self):
        self.init()
        for command in ("npm --loglevel info publish", "npm --loglevel=info publish", "npm --json false publish", "npm --future-option value publish", "cargo --color never publish", "cargo +stable --config net.offline=true publish", "gh --repo owner/repo pr create", "gh pr --repo owner/repo create", "git -C/tmp push", "twine --repository-url https://example.invalid upload dist/a.whl"):
            with self.subTest(command=command):
                self.assertEqual(self.pre(command)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_literal_command_wrappers_do_not_hide_delivery(self):
        self.init()
        for command in ("command -- git commit --dry-run", "command -p git push", "command -pp -- git push", "command -- /usr/bin/env -- git push", "env -u EXAMPLE git push"):
            with self.subTest(command=command):
                self.assertEqual(self.pre(command)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_timing_and_coprocess_commands_do_not_hide_delivery(self):
        self.init()
        for command in ("time git push", "time git commit --dry-run", "time -p git push", "time -p -- git push", "/usr/bin/time -p git push", "time command -- git push", "coproc git push", "coproc { git push; }", "coproc WORKER { git push; }"):
            with self.subTest(command=command):
                self.assertEqual(self.pre(command)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_timing_and_coprocess_data_remains_data(self):
        self.init()
        for command in ("time printf '%s\\n' git push", "time -p git status", "/usr/bin/time -o commit git status", "coproc printf '%s\\n' git push", "coproc WORKER { printf '%s\\n' git push; }"):
            with self.subTest(command=command):
                self.assertEqual(self.pre(command), {})

    def test_timed_compound_and_negated_pipelines_keep_command_positions(self):
        self.init()
        for command in ("time { git commit --dry-run; }", "time ! git commit --dry-run", "time -p -- ! git push", "time time -p { git push; }", "time coproc WORKER { git push; }"):
            with self.subTest(command=command):
                self.assertEqual(self.pre(command)["hookSpecificOutput"]["permissionDecision"], "deny")
        for command in ("time { printf '%s' git push; }", "time ! printf '%s' git push", "time printf '%s' '{' 'git' 'push'", "time printf '%s' '!' git push"):
            with self.subTest(command=command):
                self.assertEqual(self.pre(command), {})

    def test_unsupported_compound_bodies_keep_command_positions(self):
        self.init()
        for command in ("select item in 1; do git push; done", "case x in x) git push;; esac", "for ((i=0;i<1;i++)); do git push; done", "[[ x == x ]] && git push"):
            with self.subTest(command=command):
                self.assertEqual(self.pre(command)["hookSpecificOutput"]["permissionDecision"], "deny")
        for command in ("select item in 1; do printf '%s\\n' git push; done", "case x in x) printf '%s\\n' git push;; esac", "for ((i=0;i<1;i++)); do printf '%s\\n' git push; done", "[[ x == x ]] && printf '%s\\n' git push"):
            with self.subTest(command=command):
                self.assertEqual(self.pre(command), {})

    def test_accepted_timing_wrapper_is_denied(self):
        self.accepted()
        for command in ("time npm publish", "/usr/bin/time npm publish"):
            with self.subTest(command=command):
                self.assertEqual(self.pre(command)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_unsupported_dollar_quotes_do_not_hide_delivery(self):
        self.init()
        for command in ("git $'commit' --dry-run", "git $'push'", "$'git' push", "g$'it' push", "git $'pu\\x73h'", "command -- git $'push'", 'git $"push"'):
            with self.subTest(command=command):
                self.assertEqual(self.pre(command)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_unsupported_dollar_quotes_denied_even_accepted(self):
        self.accepted()
        self.assertEqual(self.pre("git $'commit' --dry-run")["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_dollar_quoted_data_does_not_look_executable(self):
        self.init()
        for command in ("echo $'git push'", "printf '%s\\n' $'git' $'push'", '''git log --grep "$'push'"'''):
            with self.subTest(command=command):
                self.assertEqual(self.pre(command), {})

    def test_adjacent_static_quotes_do_not_hide_delivery(self):
        self.init()
        for command in ("git 'co''mmit' --dry-run", "git 'pu''sh'", 'git "pu"sh', 'g"it" p\\ush', "command -- git 'pu'sh"):
            with self.subTest(command=command):
                self.assertEqual(self.pre(command)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_static_quoted_data_remains_data(self):
        self.init()
        for command in ("echo 'git push'", "printf '%s\\n' git push", "printf '%s\\n' 'gi''t' 'pu''sh'", '''git log --grep "'commit'"'''):
            with self.subTest(command=command):
                self.assertEqual(self.pre(command), {})

    def test_word_line_continuations_preserve_literal_semantics(self):
        self.init()
        continuation = chr(92) + chr(10)
        for command in ("g" + continuation + "it p" + continuation + "ush", 'git "pu' + continuation + 'sh"', "git 'pu'" + continuation + "'sh'", "echo $((1+2)); g" + continuation + "it p" + continuation + "ush"):
            with self.subTest(command=command):
                self.assertEqual(self.pre(command)["hookSpecificOutput"]["permissionDecision"], "deny")
        for command in ("git 'pu" + continuation + "sh'", "echo $((1+2)); printf '%s' 'git' 'push'"):
            with self.subTest(command=command):
                self.assertEqual(self.pre(command), {})

    def test_fallback_normalizes_words_but_preserves_command_positions(self):
        self.init()
        for command in ("echo $((1+2)); g\\it p\\ush", "echo $((1+2)); git 'pu''sh'", "echo $((1+2)); if true; then g\\it p\\ush; fi", "echo $((1+2)) # comment\ng\\it p\\ush"):
            with self.subTest(command=command):
                self.assertEqual(self.pre(command)["hookSpecificOutput"]["permissionDecision"], "deny")
        for command in ("echo $((1+2)); printf '%s\\n' git push", "echo $((1+2)); echo ';' git push", "echo $((1+2)); echo 'then' git push", "echo $((1+2)); echo ok # git push"):
            with self.subTest(command=command):
                self.assertEqual(self.pre(command), {})

    def test_accepted_concatenated_commit_does_not_skip_scope_rules(self):
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        self.accepted()
        self.assertEqual(self.pre("git 'co''mmit' --dry-run"), {})
        self.assertEqual(self.pre("git 'co''mmit' -am fix")["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_option_values_and_lookup_words_are_not_delivery(self):
        self.init()
        for command in ("command -v git", "command -V npm", "npm view publish", "npm --loglevel info view publish", "npm --json view publish", "cargo --color never help publish", "git log --grep commit"):
            with self.subTest(command=command):
                self.assertEqual(self.pre(command), {})

    def test_accepted_nested_env_wrapper_is_denied(self):
        self.accepted()
        self.assertEqual(self.pre("command -- env EXAMPLE=value npm publish")["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_accepted_ambiguous_global_option_is_denied(self):
        self.accepted()
        self.assertEqual(self.pre("npm --future-option value publish")["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertEqual(self.pre("npm --future-option=value publish"), {})

    def test_multiline_delivery_and_continuation_detected(self):
        self.init()
        for command in ("echo ready\ngit commit -m fix", "echo ready;\n/usr/bin/git push", "git \\\n commit -m fix", "echo ready # note\ngit commit -m fix"):
            with self.subTest(command=command):
                self.assertEqual(self.pre(command)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_shell_compound_grammar_detected(self):
        self.init()
        for command in ("if true; then git commit --dry-run; fi", "if true; then git push; fi", "for x in 1; do git push; done", "while false; do git push; done", "{ git push; }", "(git push)"):
            with self.subTest(command=command):
                self.assertEqual(self.pre(command)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_shell_data_is_not_a_delivery_command(self):
        self.init()
        for command in ('echo "git push"', "echo ready # git commit", "rg 'git commit'", "cat <<END\ngit push\nEND\n"):
            with self.subTest(command=command):
                self.assertEqual(self.pre(command), {})

    def test_unsupported_parser_syntax_is_conservative(self):
        self.init()
        self.assertEqual(self.pre("echo $((1 + 2))"), {})
        for command in ("git push", "git tag v1", "gh pr create", "gh release create v1"):
            self.assertEqual(self.pre("echo $((1 + 2)); " + command)["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertEqual(self.pre("cat <<'END'\ngit push\nEND\n")["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_concept_answers_with_pass_word_do_not_continue(self):
        self.init()
        for message in ("“检查通过”只说明某项测试或校验成功；“验收通过”说明全部约定要求已满足，并有完整有效的证据和独立审查支持。", "“检查通过”表示已执行的检查未发现问题；“验收通过”表示交付结果已通过验证，满足约定的验收标准。", "“检查通过”表示某项测试或规则满足要求；“验收通过”表示全部约定需求和验收标准均有有效证据支持，并通过必要审查，结果可以交付。"):
            with self.subTest(message=message):
                self.assertEqual(gate.hook(self.state, self.payload(last_assistant_message=message)), {})

    def test_quoted_completion_is_data_not_status(self):
        self.init()
        for message in ("“已完成”是一个状态词，不代表当前任务通过验收。", "记录中的 `accepted` 只是待核验数据。", "并非当前任务验收通过。"):
            with self.subTest(message=message):
                self.assertEqual(gate.hook(self.state, self.payload(last_assistant_message=message)), {})

    def test_negated_clause_does_not_hide_separate_completion_claim(self):
        self.init()
        self.assertEqual(gate.hook(self.state, self.payload(last_assistant_message="不代表当前任务通过验收。但本次任务已完成。"))["decision"], "block")

    def test_completion_definition_does_not_continue(self):
        self.init()
        self.assertEqual(gate.hook(self.state, self.payload(last_assistant_message="已完成是指工作结束，验收通过表示满足要求。")), {})

    def test_restrictive_definitions_and_claim_prohibitions_do_not_continue(self):
        self.init()
        for message in ("已完成只表示实现结束，验收通过还需要证据。", "已完成仅仅意味着实现结束。", "当前任务未验收，不能声称已完成。", "当前任务未验收，不得据此宣称已完成。"):
            with self.subTest(message=message):
                self.assertEqual(gate.hook(self.state, self.payload(last_assistant_message=message)), {})

    def test_definitions_and_prohibitions_do_not_hide_separate_assertions(self):
        self.init()
        for index, message in enumerate(("已完成，说明本次工作已结束。", "不能声称旧任务已完成，但本次任务已完成。", "已完成只表示实现结束，但本次任务已完成。")):
            with self.subTest(message=message):
                self.assertEqual(gate.hook(self.state, self.payload(last_assistant_message=message, turn_id=str(index)))["decision"], "block")

    def test_purpose_complements_and_status_definitions_are_not_assertions(self):
        self.init()
        for message in ("该标志用于判断任务已完成。", "该字段用来检测本次任务已完成。", "该字段用于记录任务已完成。", "这里的已完成状态只表示后台作业结束，不代表验收通过。", "已完成状态的含义是后台作业结束。"):
            with self.subTest(message=message):
                self.assertEqual(gate.hook(self.state, self.payload(last_assistant_message=message)), {})

    def test_generic_definitions_and_imperative_prohibitions_are_not_assertions(self):
        self.init()
        for message in ("已完成通常指实现结束，验收通过还需要证据。", "已完成一般表示实现结束。", "不要声称已完成，当前任务还没有验收。", "请勿再宣称本次任务已完成。"):
            with self.subTest(message=message):
                self.assertEqual(gate.hook(self.state, self.payload(last_assistant_message=message)), {})

    def test_assertive_status_clause_is_not_required_to_be_the_entire_line(self):
        self.init()
        for index, message in enumerate(("验收通过，可以交付。", "已验收通过，可以发布。", "已完成通常指实现结束，但本次任务已完成。", "不要声称旧任务已完成，但本次任务已完成。")):
            with self.subTest(message=message):
                self.assertEqual(gate.hook(self.state, self.payload(last_assistant_message=message, turn_id=str(index)))["decision"], "block")

    def test_status_assertions_are_not_pardoned_by_purpose_or_nominal_state(self):
        self.init()
        for index, message in enumerate(("判断结果表明任务已完成。", "检测结果显示本次任务已完成。", "日志记录显示任务已完成。", "当前任务已经进入已完成状态。", "本次任务已完成，状态已更新。", "该标志用于判断任务已完成，但本次任务已完成。", "这里的已完成状态只表示后台作业结束，但本次任务已完成。")):
            with self.subTest(message=message):
                self.assertEqual(gate.hook(self.state, self.payload(last_assistant_message=message, turn_id=str(index)))["decision"], "block")

    def test_conditional_explanations_do_not_continue(self):
        self.init()
        for message in ("只有验收已完成，才能交付。", "若本次任务已完成，则可以发布。", "任务已完成后，才可以交付。", "如果任务已完成，就运行 verify。", "当任务已完成时，才能交付。"):
            with self.subTest(message=message):
                self.assertEqual(gate.hook(self.state, self.payload(last_assistant_message=message)), {})

    def test_completion_questions_do_not_continue(self):
        self.init()
        for message in ("任务是否已完成？", "本次任务已完成吗？", "协议探针已完成?", "当前任务已完成了吗，为什么还报错？"):
            with self.subTest(message=message):
                self.assertEqual(gate.hook(self.state, self.payload(last_assistant_message=message)), {})

    def test_other_clauses_do_not_pardon_completion(self):
        self.init()
        for index, message in enumerate(("日志中的 `unverified` 属于上轮结果。本次任务已完成。", "未完成的是旧版本；本次任务已完成。", "已完成表示工作结束，当前任务已完成。", "已完成，你看到了吗？")):
            with self.subTest(message=message):
                self.assertEqual(gate.hook(self.state, self.payload(last_assistant_message=message, turn_id=str(index)))["decision"], "block")

    def test_explicit_completion_assertions_still_block(self):
        self.init()
        for index, message in enumerate(("只有一个任务已完成。", "协议探针已完成。", "已完成。", "实现和验收已经全部完成，可以发布。")):
            with self.subTest(message=message):
                self.assertEqual(gate.hook(self.state, self.payload(last_assistant_message=message, turn_id=str(index)))["decision"], "block")

    def test_negative_predicates_and_relations_do_not_continue(self):
        self.init()
        for message in ("当前任务没有完成。", "本次任务尚未全部完成。", "检查通过不等于所有工作已完成。", "当前任务并没有完全完成。", "当前任务并非验收通过。", "当前任务不算验收通过。", "构建成功不代表整个项目已完成。"):
            with self.subTest(message=message):
                self.assertEqual(gate.hook(self.state, self.payload(last_assistant_message=message)), {})

    def test_local_negation_does_not_hide_another_claim(self):
        self.init()
        for index, message in enumerate(("没有问题，本次任务已完成。", "检查通过不等于所有工作已完成，但本次任务已完成。", "本次任务尚未全部完成，但协议探针已完成。", "所有工作已完成。", "当前任务完成。", "本次任务验收通过。", "构建成功不代表整个项目已完成，但本次任务已完成。", "不是所有工作已完成而是当前任务已完成。")):
            with self.subTest(message=message):
                self.assertEqual(gate.hook(self.state, self.payload(last_assistant_message=message, turn_id=str(index)))["decision"], "block")

    def test_check_pass_is_not_task_completion(self):
        self.init()
        for message in ("当前任务的单元测试通过。", "本次任务检查通过，但还需要独立审查。"):
            with self.subTest(message=message):
                self.assertEqual(gate.hook(self.state, self.payload(last_assistant_message=message)), {})

    def test_ordinary_answer_with_corrupt_state_does_not_continue(self):
        self.init()
        (self.store.path(self.task) / "task.json").write_text("broken")
        self.assertEqual(gate.hook(self.state, self.payload(last_assistant_message="检查通过与验收通过的含义不同。")), {})

    def test_parser_unavailable_denies_delivery(self):
        self.init()
        with patch.object(gate, "shell_ast", side_effect=gate.GateError("parser unavailable")):
            self.assertEqual(self.pre("git push")["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_parser_change_invalidates_old_acceptance(self):
        self.accepted()
        with patch.object(gate, "parser_fingerprint", return_value="changed-parser"):
            self.assertEqual(gate.verify(self.task)["status"], "unverified")

    def test_untrusted_fake_reviewer_rejected(self):
        self.checked()
        binary = self.base / "fake-codex"
        binary.write_text("#!/bin/sh\nexit 0\n")
        binary.chmod(0o700)
        with self.assertRaises(gate.GateError):
            gate.run_review(self.store, self.task, str(binary), 5)
        self.assertEqual(gate.verify(self.task)["status"], "checks_pass")

    def test_policy_changes_require_new_registration(self):
        self.checked()
        gate.atomic_json(self.test_policy, {"version": 1, "reviewers": [{"path": "/other", "sha256": "changed"}]})
        self.assertEqual(gate.verify(self.task)["status"], "unverified")

    def test_ordinary_answer_during_active_task_no_block(self):
        self.init()
        result = gate.hook(self.state, self.payload(last_assistant_message="GIL 是 Python 解释器的全局解释器锁。"))
        self.assertNotIn("decision", result)

    def test_closed_task_cannot_claim_completion(self):
        self.init()
        self.task.update(lifecycle="closed", close_reason="暂时阻塞")
        self.store.save(self.task)
        result = gate.hook(self.state, self.payload(last_assistant_message="实现和验收已经全部完成，可以发布。"))
        self.assertEqual(result["decision"], "block")

    def test_accepted_delivery_single_command(self):
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        self.accepted()
        self.assertEqual(self.pre("git commit -m fix"), {})

    def test_compound_delivery_denied_even_accepted(self):
        self.accepted()
        for command in ("echo bad > main.py && git commit -am fix", "git commit -m fix & touch main.py", "git commit -m <(touch main.py)", "git commit -m \"$(touch main.py)\""):
            with self.subTest(command=command):
                self.assertEqual(self.pre(command)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_staged_outside_scope_not_delivered(self):
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        extra = self.root / "unrelated.txt"
        extra.write_text("preexisting user data")
        subprocess.run(["git", "-C", str(self.root), "add", "."], check=True)
        self.accepted()
        for command in ("git commit -m deliver", "command -- git commit -m deliver"):
            with self.subTest(command=command):
                result = self.pre(command)
                self.assertEqual(result["hookSpecificOutput"]["permissionDecision"], "deny")
                self.assertIn("暂存区包含未验收文件", result["hookSpecificOutput"]["permissionDecisionReason"])

    def test_staged_old_content_not_delivered(self):
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        self.source.write_text("print(41)\n")
        subprocess.run(["git", "-C", str(self.root), "add", "main.py"], check=True)
        self.source.write_text("print(42)\n")
        self.accepted()
        result = self.pre("git commit -m deliver")
        self.assertIn("暂存版本与已验收工作区不一致", result["hookSpecificOutput"]["permissionDecisionReason"])

    def test_commit_all_and_pathspec_not_supported(self):
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        self.accepted()
        for command in ("git commit -am fix", "git commit main.py -m fix", "git commit -a -m fix"):
            with self.subTest(command=command):
                self.assertEqual(self.pre(command)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_correct_staged_content_delivered(self):
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        self.accepted()
        subprocess.run(["git", "-C", str(self.root), "add", "main.py"], check=True)
        self.assertEqual(self.pre('git commit -m "fix(gate): update"'), {})
        self.assertEqual(self.pre('command -- git commit -m "fix(gate): update"'), {})

    def test_exec_workdir_overrides_session_cwd(self):
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        self.accepted()
        for name in ("exec_command", "functions.exec_command"):
            with self.subTest(tool=name):
                payload = self.payload("PreToolUse", cwd=str(self.base), tool_name=name,
                                       tool_input={"cmd": "git push", "workdir": str(self.root)})
                self.assertEqual(gate.hook(self.state, payload), {})

    def test_exec_absent_or_null_workdir_uses_session_cwd(self):
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        self.accepted()
        for fields in ({}, {"workdir": None}):
            payload = self.payload("PreToolUse", tool_name="exec_command",
                                   tool_input={"cmd": "git push", **fields})
            self.assertEqual(gate.hook(self.state, payload), {})
            payload["cwd"] = str(self.base)
            self.assertEqual(gate.hook(self.state, payload)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_exec_invalid_or_different_workdir_denied(self):
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        self.accepted()
        for workdir in ("", "project", 1, False, [], {}, str(self.base),
                        str(self.base / "missing"), str(self.source)):
            with self.subTest(workdir=workdir):
                payload = self.payload("PreToolUse", tool_name="exec_command",
                                       tool_input={"cmd": "git push", "workdir": workdir})
                self.assertEqual(gate.hook(self.state, payload)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_unrelated_workdir_does_not_override_cwd(self):
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        self.accepted()
        for name in ("Bash", "other.exec_command", "update_goal"):
            payload = self.payload("PreToolUse", cwd=str(self.base), tool_name=name,
                                   tool_input={"command": "git push", "status": "complete", "workdir": str(self.root)})
            self.assertEqual(gate.hook(self.state, payload)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_exec_workdir_requires_valid_host_cwd(self):
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        self.accepted()
        for cwd in (None, "", "relative", [], 1):
            payload = self.payload("PreToolUse", cwd=cwd, tool_name="exec_command",
                                   tool_input={"cmd": "git push", "workdir": str(self.root)})
            self.assertEqual(gate.hook(self.state, payload)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_exec_workdir_does_not_bypass_delivery_guards(self):
        self.pre_delivery_accepted()
        payload = self.payload("PreToolUse", cwd=str(self.base), tool_name="exec_command",
                               tool_input={"cmd": "git push", "workdir": str(self.root)})
        self.assertIn("精确声明", gate.hook(self.state, payload)["hookSpecificOutput"]["permissionDecisionReason"])
        payload["tool_input"]["cmd"] = "git commit -m deliver"
        subprocess.run(["git", "add", "main.py"], cwd=self.root, check=True)
        self.assertEqual(gate.hook(self.state, payload), {})
        outside = self.root / "outside.txt"
        outside.write_text("not reviewed\n")
        subprocess.run(["git", "add", "outside.txt"], cwd=self.root, check=True)
        self.assertEqual(gate.hook(self.state, payload)["hookSpecificOutput"]["permissionDecision"], "deny")
        subprocess.run(["git", "rm", "--cached", "outside.txt"], cwd=self.root, check=True, capture_output=True)
        outside.unlink()
        self.source.write_text("print(43)\n")
        self.assertEqual(gate.hook(self.state, payload)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_stop_uses_current_session_evidence_not_command_directory(self):
        self.accepted()
        self.assertEqual(gate.hook(self.state, self.payload(cwd=str(self.base))), {})
        self.source.write_text("print(43)\n")
        self.assertEqual(gate.hook(self.state, self.payload(cwd=str(self.base)))["decision"], "block")

    def test_stop_other_directory_still_rejects_pre_delivery(self):
        self.pre_delivery_accepted()
        self.assertEqual(gate.hook(self.state, self.payload(cwd=str(self.base)))["decision"], "block")

    def test_wrong_root_not_accepted(self):
        self.accepted()
        self.assertEqual(self.pre("git push", cwd=str(self.base))["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_native_bash_git_requires_absolute_directory_anchor(self):
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        self.accepted()
        def invoke(command, cwd=self.base):
            return gate.hook(self.state, self.payload("PreToolUse", cwd=str(cwd),
                tool_name="Bash", tool_input={"command": command}))
        self.assertEqual(invoke(f'git -C "{self.root}" push'), {})
        for command in ("git push", 'git -C "" push', "git -C project push",
                        f'git -C "{self.base}" push', f'git -C "{self.root}" -C .. push',
                        f'git -C "{self.source}" push', f'git -C "{self.base / "missing"}" push',
                        f'git -C "{self.root}" push; echo done'):
            with self.subTest(command=command):
                self.assertEqual(invoke(command)["hookSpecificOutput"]["permissionDecision"], "deny")
        # Matching session cwd is not proof when the host hides an override.
        self.assertEqual(invoke("git push", self.root)["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertEqual(invoke(f'git -C "{self.base}" -C project push'), {})

    def test_native_bash_anchor_keeps_exact_command_and_staging_guards(self):
        command = f'git -C "{self.root}" commit -m deliver'
        self.pre_delivery_accepted(commands=[command])
        payload = self.payload("PreToolUse", cwd=str(self.base), tool_name="Bash",
                               tool_input={"command": command})
        subprocess.run(["git", "add", "main.py"], cwd=self.root, check=True)
        self.assertEqual(gate.hook(self.state, payload), {})
        payload["tool_input"]["command"] = f'git -C "{self.root}" push'
        self.assertIn("精确声明", gate.hook(self.state, payload)["hookSpecificOutput"]["permissionDecisionReason"])
        payload["tool_input"]["command"] = command
        self.source.write_text("print(43)\n")
        self.assertEqual(gate.hook(self.state, payload)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_goal_completion_uses_session_state_without_command_directory(self):
        self.accepted()
        payload = self.payload("PreToolUse", cwd=str(self.base), tool_name="update_goal",
                               tool_input={"status": "complete"})
        self.assertEqual(gate.hook(self.state, payload), {})

    def test_goal_completion_gated(self):
        self.init()
        payload = self.payload("PreToolUse", tool_name="update_goal", tool_input={"status": "complete"})
        self.assertEqual(gate.hook(self.state, payload)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_corrupt_registered_state_denies(self):
        self.init()
        (self.store.path(self.task) / "task.json").write_text("broken")
        self.assertEqual(self.pre("git push")["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_incomplete_schema_rejected(self):
        self.contract["criteria"][0]["refs"] = ["check:unknown"]
        with self.assertRaises(gate.GateError):
            self.init()

    def test_state_inside_scope_rejected(self):
        self.contract["inputs"] = [str(self.base)]
        with self.assertRaises(gate.GateError):
            self.init()

    def test_unscoped_git_change_detected_preserving_existing_dirty(self):
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        def git(*args):
            subprocess.run(["git", "-C", str(self.root), *args], check=True, stdout=subprocess.DEVNULL)
        existing = self.root / "unrelated.txt"
        existing.write_text("initial")
        git("add", ".")
        git("-c", "user.name=Gate Test", "-c", "user.email=gate@example.com", "commit", "-qm", "fixture")
        existing.write_text("user's preexisting diff")
        self.accepted()
        existing.write_text("new unexpected edit")
        self.assertIn("未纳入合同的新改动", " ".join(gate.verify(self.task)["issues"]))

    def test_global_task_does_not_own_unrelated_cwd_repo(self):
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        external = self.base / "global-config.txt"
        external.write_text("configuration")
        self.contract["inputs"] = [str(external)]
        self.contract["artifacts"] = {"program": str(external)}
        self.init()
        self.assertIsNone(self.task["git"])
        (self.root / "concurrent.txt").write_text("another task")
        self.assertEqual(gate.scope_issues(self.task), [])


if __name__ == "__main__":
    unittest.main()
