"""Registration diagnostics must not manufacture Hook or acceptance evidence."""
import json
import os
import subprocess
import sys
import unittest
from unittest.mock import patch

from test_evidence_gate import GateTests, gate


class RegistrationTests(unittest.TestCase):
    setUp = GateTests.setUp
    tearDown = GateTests.tearDown
    init = GateTests.init
    checked = GateTests.checked
    simulated_review = GateTests.simulated_review
    accepted = GateTests.accepted
    pre_delivery_contract = GateTests.pre_delivery_contract
    pre_delivery_accepted = GateTests.pre_delivery_accepted

    def cli(self, *args):
        env = dict(os.environ, CODEX_HOME=str(self.base / "codex"), CODEX_THREAD_ID="production-session")
        result = subprocess.run([sys.executable, "-B", gate.__file__, *args],
                                env=env, capture_output=True, text=True, timeout=10)
        return result.returncode, json.loads(result.stdout)

    def prepare_cli(self):
        gate.atomic_json(self.base / "codex/evidence-gate/reviewer-policy.json", {"version": 1, "reviewers": []})
        self.contract_path = self.base / "contract.json"
        gate.atomic_json(self.contract_path, self.contract)

    def test_missing_status_is_read_only_and_does_not_claim_trust(self):
        code, result = self.cli("status")
        self.assertEqual(code, 0)
        self.assertEqual(result["registration"], "none")
        self.assertEqual(result["acceptance"], "not_checked")
        self.assertEqual(result["hook_runtime"], "unknown")
        self.assertFalse((self.base / "codex").exists())
        self.assertEqual(self.cli("status", "--require-registered")[0], 1)
        self.assertFalse((self.base / "codex").exists())

    def test_default_registration_close_and_status(self):
        self.prepare_cli()
        code, result = self.cli("init", "--contract", str(self.contract_path))
        self.assertEqual(code, 0, result)
        self.assertEqual(result["registration_state"]["state_alignment"], "cli_default")
        self.assertEqual(self.cli("status", "--require-registered")[0], 0)
        code, closed = self.cli("close", "--reason", "fixture cancelled")
        self.assertEqual(code, 0)  # Operation success is not acceptance.
        self.assertFalse(closed["goal_complete"])
        self.assertTrue(closed["delivery_blocked"])
        self.assertEqual(closed["next_action"], "resolve_closure_before_resuming")
        self.assertEqual(self.cli("status", "--require-registered")[0], 1)

    def test_custom_registration_requires_explicit_test_exception(self):
        self.prepare_cli()
        args = ["--session", "isolated-test", "--state-dir", str(self.state), "init", "--contract", str(self.contract_path)]
        code, result = self.cli(*args)
        self.assertEqual(code, 1)
        self.assertIn("默认 Hook", str(result))
        self.assertFalse(self.state.exists())
        code, result = self.cli(*args, "--allow-unhooked-test-state")
        self.assertEqual(code, 0, result)
        self.assertEqual(result["registration_state"]["state_alignment"], "custom")
        self.assertEqual(self.cli("--session", "isolated-test", "--state-dir", str(self.state),
                                  "status", "--require-registered")[0], 1)
        # The default state still has no task for this session. No routing claim.
        self.assertEqual(self.cli("--session", "isolated-test", "status")[1]["registration"], "none")

    def test_test_exception_cannot_reuse_current_production_session(self):
        self.prepare_cli()
        code, result = self.cli("--state-dir", str(self.state), "init", "--allow-unhooked-test-state",
                                "--contract", str(self.contract_path))
        self.assertEqual(code, 1, result)
        self.assertFalse(self.state.exists())

    def test_legacy_custom_records_remain_readable_and_closable(self):
        self.prepare_cli()
        self.init()  # Existing internal API/legacy state: no new CLI opt-in.
        args = ["--session", self.store.session, "--state-dir", str(self.state)]
        code, result = self.cli(*args, "status")
        self.assertEqual(code, 0)
        self.assertEqual(result["registration"], "active")
        self.assertEqual(self.cli(*args, "verify")[1]["status"], "unverified")
        self.assertEqual(self.cli(*args, "close", "--reason", "legacy audit")[1]["status"], "closed_unverified")

    def test_corrupt_index_fails_and_wrong_session_does_not_cross_read(self):
        self.prepare_cli()
        self.init()
        code, result = self.cli("--session", "someone-else", "--state-dir", str(self.state), "status")
        self.assertEqual(result["registration"], "none")
        self.store.index.write_text("not json")
        code, result = self.cli("--session", self.store.session, "--state-dir", str(self.state), "status")
        self.assertEqual(code, 1)
        self.assertEqual(result["status"], "unverified")

    def test_default_directory_uses_resolved_codex_home(self):
        with patch.dict(os.environ, {"CODEX_HOME": str(self.base / "home")}):
            self.assertEqual(gate.default_state_dir(), self.base / "home/evidence-gate")

    def test_failure_guidance_preserves_delivery_block(self):
        self.init()
        result = gate.verify(self.task)
        self.assertTrue(result["delivery_blocked"])
        self.assertEqual(result["next_action"], "continue_authorized_work_and_reverify")
        gate.run_checks(self.store, self.task)
        result = gate.verify(self.task)
        self.assertEqual(result["status"], "checks_pass")
        self.assertEqual(result["next_action"], "run_independent_review")
        self.assertFalse(result["goal_complete"])
        self.simulated_review("reject")
        result = gate.verify(self.task)
        self.assertTrue(result["delivery_blocked"])
        self.assertEqual(result["next_action"], "continue_authorized_work_and_reverify")

    def test_acceptance_stage_guidance_does_not_skip_delivery(self):
        self.pre_delivery_accepted()
        result = gate.verify(self.task)
        self.assertFalse(result["delivery_blocked"])
        self.assertFalse(result["goal_complete"])
        self.assertEqual(result["next_action"], "run_declared_delivery_then_advance_and_reverify")
        # A second verify cannot substitute for --advance and next-stage checks.
        self.assertFalse(gate.verify(self.task)["goal_complete"])

    def test_completion_guidance(self):
        self.accepted()
        result = gate.verify(self.task)
        self.assertTrue(result["goal_complete"])
        self.assertEqual(result["next_action"], "none")


del GateTests
