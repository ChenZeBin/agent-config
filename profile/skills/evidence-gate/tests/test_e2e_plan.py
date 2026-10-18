"""Protocol regressions. Simulated reviewer results are not live model evidence."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

import test_evidence_gate as common

gate = common.gate


class E2EPlanTests(unittest.TestCase):
    def setUp(self):
        common.GateTests.setUp(self)
        self.plan_path = self.root / "test-plan.json"
        self.contract["inputs"].append("test-plan.json")
        self.contract["testing"] = {"kind": "e2e", "plan": "test-plan.json", "criterion_ids": ["answer"]}
        self.plan = {"version": 1, "environments": [{"id": "fixture", "kind": "synthetic", "target": "隔离 Python CLI 输出 42；无业务数据"}],
                     "cases": [{"id": "answer", "criterion_ids": ["answer"], "preconditions": ["Python 可用且程序为当前源码"],
                                "steps": ["运行 main.py 并读取 stdout"], "expected": ["输出整数 42"],
                                "environment_id": "fixture", "check_id": "run", "evidence_refs": ["check:run"]}]}
        self.write_plan()
        self.set_result({"id": "answer", "status": "pass", "environment_id": "fixture", "actual": "实际子进程 stdout 为 42"})
        self.reviewer = self.base / "simulated-reviewer"
        self.reviewer.write_text("""#!/usr/bin/env python3
import json,pathlib,sys
schema=json.loads(pathlib.Path(sys.argv[sys.argv.index('--output-schema')+1]).read_text())
ids=schema['properties']['criteria']['items']['properties']['id']['enum']
result={'verdict':'accepted','request_coverage':'complete','criteria':[{'id':i,'verdict':'pass','reason':'SIMULATED protocol fixture'} for i in ids],'findings':['SIMULATED; never model acceptance']}
pathlib.Path(sys.argv[sys.argv.index('-o')+1]).write_text(json.dumps(result))
""")
        self.reviewer.chmod(0o700)
        gate.atomic_json(self.test_policy, {"version": 1, "default": str(self.reviewer), "reviewers": [{"path": str(self.reviewer), "sha256": gate.file_hash(self.reviewer)}]})
        self.task = self.store.init(self.contract)

    def tearDown(self):
        common.GateTests.tearDown(self)

    def write_plan(self):
        gate.atomic_json(self.plan_path, self.plan)

    def test_copied_skill_judges_use_formal_plan_loader(self):
        skill = Path(gate.__file__).resolve().parents[1]
        spec = importlib.util.spec_from_file_location('semantic_audit', skill / 'tests/skill_semantic_review.py')
        semantic = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(semantic)
        installed = self.root / '.codex/skills/evidence-gate'
        installed.parent.mkdir(parents=True)
        installed.symlink_to(skill, target_is_directory=True)
        for name, judge in [('e2e-plan-before-run', 'check-e2e-plan.sh'),
                            ('e2e-stale-plan', 'check-e2e-stale-plan.sh')]:
            lines = (skill / 'evals/cases' / (name + '.yaml')).read_text().splitlines()
            requirements = json.loads(lines[lines.index('    requirements.json: |') + 1].strip())
            gate.atomic_json(self.root / 'requirements.json', requirements)
            plan = copy.deepcopy(self.plan)
            plan['cases'][0].update(check_id='cli', evidence_refs=['check:cli'])
            if name == 'e2e-stale-plan':
                invalid = copy.deepcopy(plan['cases'][0])
                invalid.update(id='invalid', criterion_ids=['invalid'], steps=['运行 answer.py --invalid'],
                               expected=['退出2且 stderr 含 invalid'])
                plan['cases'].append(invalid)
            # Match skill-up's copy-only-this-judge behavior.
            copied = self.base / 'copied-judge.sh'
            copied.write_text((skill / 'evals/fixtures' / judge).read_text())
            variants = [('valid', plan)]
            for label, target in [('top', None), ('environment', 'environments'), ('case', 'cases')]:
                bad = copy.deepcopy(plan)
                (bad if target is None else bad[target][0])['review_notes'] = 'not part of the schema'
                variants.append((label, bad))
            bad = copy.deepcopy(plan)
            bad['cases'][0]['id'] = 'invalid id with spaces'
            variants.append(('invalid-id', bad))
            for label, candidate in variants:
                with self.subTest(case=name, variant=label):
                    gate.atomic_json(self.plan_path, candidate)
                    env = dict(os.environ, EVAL_FINAL_MESSAGE='未执行，等待独立审查', EVAL_EXIT_CODE='0')
                    env.pop('E2E_PLAN_VARIANT', None)
                    result = subprocess.run(['bash', str(copied)], cwd=self.root, env=env,
                                            capture_output=True, text=True, timeout=10)
                    if label == 'valid':
                        self.assertEqual(result.returncode, 0, result.stderr)
                    else:
                        self.assertNotEqual(result.returncode, 0)
                        self.assertIn('GateError', result.stderr)
                    row = {'id': name, 'original_case': str(skill / 'evals/cases' / (name + '.yaml')),
                           'fixture_after': str(self.root)}
                    if label == 'valid':
                        proof = semantic.validate_generated_plan(row)
                        self.assertEqual(proof['exit_code'], 0)
                        self.assertEqual(proof['plan_sha256'], gate.file_hash(self.plan_path))
                    else:
                        with self.assertRaises(AssertionError):
                            semantic.validate_generated_plan(row)

    def set_result(self, result, duplicate=False):
        line = "" if result is None else "EVIDENCE_GATE_CASE " + json.dumps(result)
        script = self.root / "check_e2e.py"
        script.write_text("import subprocess,sys\nassert subprocess.check_output([sys.executable,'-B','main.py']).strip()==b'42'\n" +
                          "print(" + repr(line) + ")\n" + ("print(" + repr(line) + ")\n" if duplicate else ""))
        if "check_e2e.py" not in self.contract["inputs"]:
            self.contract["inputs"].append("check_e2e.py")
        self.contract["checks"][0]["argv"] = [sys.executable, "-B", "check_e2e.py"]

    def approve(self):
        gate.e2e_plan.run_plan_review(gate.e2e_api(), self.store, self.task, str(self.reviewer), 10)
        self.assertEqual(gate.e2e_plan.plan_issues(gate.e2e_api(), self.task), [])

    def test_missing_review_stops_before_process_start(self):
        self.source.write_text("from pathlib import Path\nPath('executed.marker').touch()\nprint(42)\n")
        with self.assertRaisesRegex(gate.GateError, "plan-review"):
            gate.run_checks(self.store, self.task)
        self.assertFalse((self.root / "executed.marker").exists())
        self.assertEqual(self.task["checks"], {})

    def test_positive_plan_then_run_then_final_review(self):
        self.approve()
        self.assertNotEqual(gate.verify(self.task)["status"], "accepted")
        gate.run_checks(self.store, self.task)
        self.assertEqual(gate.verify(self.task)["status"], "checks_pass")
        receipt = self.task["checks"]["run"]
        self.assertLessEqual(self.task["plan_review"]["finished_at"], receipt["started_at"])
        gate.run_review(self.store, self.task, str(self.reviewer), 10)
        self.assertTrue(gate.verify(self.task)["goal_complete"])

    def test_plan_edit_and_source_edit_require_review(self):
        for kind in ("plan", "source"):
            with self.subTest(kind=kind):
                self.approve()
                gate.run_checks(self.store, self.task)
                if kind == "plan":
                    self.plan["cases"][0]["steps"].append("确认 stderr 为空")
                    self.write_plan()
                else:
                    self.source.write_text("print(42) # revised\n")
                with self.assertRaises(gate.GateError):
                    gate.run_checks(self.store, self.task)
                self.assertEqual(gate.verify(self.task)["status"], "unverified")

    def test_rereview_cannot_retroactively_accept_prior_runs(self):
        self.approve()
        gate.run_checks(self.store, self.task)
        self.approve()
        self.assertEqual(self.task["checks"], {})
        self.assertEqual(gate.verify(self.task)["status"], "unverified")

    def test_missing_duplicate_failed_skipped_and_wrong_environment(self):
        good = {"id": "answer", "status": "pass", "environment_id": "fixture", "actual": "42"}
        variants = [(None, False), (good, True)] + [({**good, "status": s}, False) for s in ("skip", "fail", "blocked")] + [({**good, "environment_id": "other"}, False)]
        for result, duplicate in variants:
            with self.subTest(result=result, duplicate=duplicate):
                self.set_result(result, duplicate)
                self.approve()
                gate.run_checks(self.store, self.task)
                self.assertEqual(self.task["checks"]["run"]["exit_code"], 0)
                self.assertEqual(gate.verify(self.task)["status"], "unverified")
                with self.assertRaises(gate.GateError):
                    gate.run_review(self.store, self.task, str(self.reviewer), 10)

    def test_review_tampering_and_invalid_output_rejected(self):
        self.approve()
        output = Path(self.task["plan_review"]["output"])
        output.write_text("{}")
        with self.assertRaises(gate.GateError):
            gate.run_checks(self.store, self.task)
        self.task["plan_review"]["output_hash"] = gate.file_hash(output)
        with self.assertRaises(gate.GateError):
            gate.run_checks(self.store, self.task)

    def test_rejected_and_failed_review_cannot_execute(self):
        for mode in ("reject", "timeout", "empty"):
            with self.subTest(mode=mode):
                self.approve()
                r = self.task["plan_review"]
                if mode == "reject":
                    report = gate.read_json(r["output"])
                    report["verdict"] = "rejected"
                    gate.atomic_json(r["output"], report)
                    r["output_hash"] = gate.file_hash(r["output"])
                elif mode == "timeout":
                    r["error"] = "timeout"
                else:
                    Path(r["output"]).unlink()
                with self.assertRaises(gate.GateError):
                    gate.run_checks(self.store, self.task)

    def test_no_self_approval_or_legacy_new_registration(self):
        for mutate in (lambda c: c.update(version=1), lambda c: c.pop("testing"),
                       lambda c: c["testing"].update(approved=True)):
            value = copy.deepcopy(self.contract)
            mutate(value)
            with self.assertRaises(gate.GateError):
                gate.validate_contract(value, self.state)

    def test_legacy_registered_state_remains_readable(self):
        # Construct the shape of an already persisted v1 record, not a new init.
        self.task["contract"].pop("testing")
        self.task["contract"]["version"] = 1
        self.task["contract_digest"] = gate.digest(self.task["contract"])
        self.store.save(self.task)
        self.assertEqual(self.store.load()["contract"]["version"], 1)
        self.assertEqual(gate.verify(self.task)["status"], "unverified")

    def test_incomplete_and_duplicate_plans_rejected(self):
        for mutate in (lambda p: p.update(cases=[]), lambda p: p["cases"].append(copy.deepcopy(p["cases"][0])),
                       lambda p: p["cases"][0].update(expected=[]), lambda p: p["cases"][0].update(criterion_ids=["unknown"]),
                       lambda p: p["cases"][0].update(environment_id="unknown")):
            plan = copy.deepcopy(self.plan)
            mutate(plan)
            gate.atomic_json(self.plan_path, plan)
            with self.assertRaises(gate.GateError):
                gate.e2e_plan.load_plan(gate.e2e_api(), self.task)

    def test_hook_blocks_declared_command_and_ui_before_plan(self):
        for command in ("python3 check_e2e.py", "echo evidence_gate.py; python3 check_e2e.py"):
            result = gate.hook(self.state, {"hook_event_name": "PreToolUse", "session_id": "unit-session", "tool_name": "Bash", "tool_input": {"command": command}})
            self.assertEqual(result["hookSpecificOutput"]["permissionDecision"], "deny")
        result = gate.hook(self.state, {"hook_event_name": "PreToolUse", "session_id": "unit-session", "tool_name": "mcp__cua_repl__js", "tool_input": {"code": "await tab.click();"}})
        self.assertEqual(result["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertEqual(gate.hook(self.state, {"hook_event_name": "PreToolUse", "session_id": "unregistered", "tool_input": {"cmd": "python3 check_e2e.py"}}), {})

    def test_direct_command_allowed_only_after_current_review(self):
        self.approve()
        payload = {"hook_event_name": "PreToolUse", "session_id": "unit-session", "tool_name": "Bash", "tool_input": {"command": "python3 check_e2e.py"}}
        self.assertEqual(gate.hook(self.state, payload), {})
        self.source.write_text("print(41)\n")
        self.assertEqual(gate.hook(self.state, payload)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_reviewed_automatic_browser_is_not_forced_into_manual_case(self):
        self.approve()
        payload = {"hook_event_name": "PreToolUse", "session_id": "unit-session", "tool_name": "mcp__cua_repl__js", "tool_input": {"code": "await tab.click();"}}
        self.assertEqual(gate.hook(self.state, payload), {})
        self.assertEqual(gate.verify(self.task)["status"], "unverified")
        self.assertEqual(self.task["checks"], {})

    def manual(self):
        self.task["contract"]["evidence"] = [{"id": "observation", "kind": "file", "description": "操作后原始观察"}]
        self.task["contract_digest"] = gate.digest(self.task["contract"])
        self.plan["cases"][0].update(check_id=None, evidence_refs=["evidence:observation"])
        self.write_plan()

    def test_manual_start_and_fresh_evidence_required(self):
        self.manual()
        with self.assertRaises(gate.GateError):
            gate.e2e_plan.start_manual(gate.e2e_api(), self.store, self.task, "answer")
        self.approve()
        with self.assertRaises(gate.GateError):
            gate.e2e_plan.finish_manual(gate.e2e_api(), self.store, self.task, "answer", "pass", "42")
        old = self.base / "old.json"
        old.write_text('{"observed":42}')
        gate.e2e_plan.start_manual(gate.e2e_api(), self.store, self.task, "answer")
        gate.record_evidence(self.store, self.task, "observation", str(old))
        with self.assertRaises(gate.GateError):
            gate.e2e_plan.finish_manual(gate.e2e_api(), self.store, self.task, "answer", "pass", "42")
        fresh = self.base / "fresh.json"
        fresh.write_text('{"observed":42}')
        gate.record_evidence(self.store, self.task, "observation", str(fresh))
        gate.e2e_plan.finish_manual(gate.e2e_api(), self.store, self.task, "answer", "pass", "42")
        self.assertEqual(gate.e2e_plan.case_issues(gate.e2e_api(), self.task), [])
        fresh.write_text('{"observed":41}')
        gate.record_evidence(self.store, self.task, "observation", str(fresh))
        self.assertTrue(gate.e2e_plan.case_issues(gate.e2e_api(), self.task))

    def test_manual_only_ui_requires_current_start(self):
        self.manual()
        self.approve()
        payload = {"hook_event_name": "PreToolUse", "session_id": "unit-session", "tool_name": "mcp__cua_repl__js", "tool_input": {"code": "await tab.click();"}}
        self.assertEqual(gate.hook(self.state, payload)["hookSpecificOutput"]["permissionDecision"], "deny")
        gate.e2e_plan.start_manual(gate.e2e_api(), self.store, self.task, "answer")
        self.assertEqual(gate.hook(self.state, payload), {})
        self.source.write_text("print(41)\n")
        self.assertEqual(gate.hook(self.state, payload)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_literal_output_is_not_test_execution(self):
        for command in ("echo playwright test", "printf '%s' 'python3 check_e2e.py'", "echo 'npx playwright test'", "command -v playwright"):
            self.assertFalse(gate.e2e_plan.looks_like_e2e(command, gate.e2e_api()), command)
        for command in ("npx playwright test", "echo ready; python3 check_e2e.py", "env FLAG=1 python3 check_e2e.py", "echo $(npx playwright test)"):
            self.assertTrue(gate.e2e_plan.looks_like_e2e(command, gate.e2e_api()), command)
        self.task["contract"]["testing"] = {"kind": "not_applicable", "reason": "仅输出命令文档"}
        self.task["contract"]["checks"][0]["argv"] = ["echo", "playwright", "test"]
        self.task["contract_digest"] = gate.digest(self.task["contract"])
        gate.run_checks(self.store, self.task)
        self.assertTrue(gate.log_valid(self.task["checks"]["run"]))

    def test_not_applicable_does_not_allow_known_e2e_entrypoint(self):
        self.task["contract"]["testing"] = {"kind": "not_applicable", "reason": "只读检查"}
        self.task["contract_digest"] = gate.digest(self.task["contract"])
        self.store.save(self.task)
        payload = {"hook_event_name": "PreToolUse", "session_id": "unit-session", "tool_input": {"command": "npx playwright test"}}
        self.assertEqual(gate.hook(self.state, payload)["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertFalse(gate.e2e_plan.looks_like_e2e("git -C /tmp/e2e-worktree status"))
        with self.assertRaises(gate.GateError):
            gate.run_checks(self.store, self.task)

    def test_parsed_results_must_match_original_stdout(self):
        self.approve()
        gate.run_checks(self.store, self.task)
        self.task["checks"]["run"]["case_results"]["answer"]["actual"] = "self-written result"
        self.assertTrue(gate.e2e_plan.case_issues(gate.e2e_api(), self.task))


if __name__ == "__main__":
    unittest.main()
