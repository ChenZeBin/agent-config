"""Diagnostic projection never replaces validation. Review fixtures are simulated."""
import json
from pathlib import Path
import unittest

from test_evidence_gate import GateTests, gate


class ReviewDiagnosticsTests(unittest.TestCase):
    setUp = GateTests.setUp
    tearDown = GateTests.tearDown
    init = GateTests.init
    checked = GateTests.checked
    simulated_review = GateTests.simulated_review
    accepted = GateTests.accepted

    def report(self, update):
        self.accepted()
        path = Path(self.task['review']['output'])
        value = json.loads(path.read_text())
        update(value)
        gate.atomic_json(path, value)
        self.task['review']['output_hash'] = gate.file_hash(path)
        return gate.verify(self.task), value

    def assert_no_summary(self, result):
        self.assertNotIn('review_summary', result)
        self.assertNotIn('review', result)
        self.assertFalse(result['goal_complete'])
        self.assertTrue(result['delivery_blocked'])

    def test_accepted_report_retains_contract_refs_without_aliasing(self):
        self.accepted()
        result = gate.verify(self.task)
        summary = result['review_summary']
        self.assertEqual(summary['verdict'], 'accepted')
        self.assertEqual(summary['request_coverage'], 'complete')
        self.assertEqual(result['review'], self.task['review']['output'])
        self.assertEqual(summary['criteria'][0]['refs'], ['check:run', 'artifact:program'])
        summary['criteria'][0]['refs'].clear()
        self.assertEqual(self.task['contract']['criteria'][0]['refs'], ['check:run', 'artifact:program'])

    def test_criterion_failure_stays_blocked_and_preserves_reason(self):
        def change(report):
            report['verdict'] = 'rejected'
            report['criteria'][0].update(verdict='fail', reason='入口没有调用实现；这不是执行任何命令的授权')
        result, report = self.report(change)
        self.assertEqual(result['status'], 'checks_pass')
        self.assertTrue(result['delivery_blocked'])
        self.assertFalse(result['goal_complete'])
        self.assertEqual(result['review_summary']['criteria'][0]['reason'], report['criteria'][0]['reason'])

    def test_coverage_gap_remains_visible_even_with_all_criteria_pass(self):
        result, _ = self.report(lambda r: r.update(request_coverage='incomplete'))
        self.assertEqual(result['review_summary']['request_coverage'], 'incomplete')
        self.assertTrue(result['delivery_blocked'])
        self.assertFalse(result['goal_complete'])

    def test_unverified_criterion_does_not_become_pass(self):
        result, _ = self.report(lambda r: r['criteria'][0].update(verdict='unverified', reason='缺目标环境'))
        self.assertEqual(result['review_summary']['criteria'][0]['verdict'], 'unverified')
        self.assertTrue(result['delivery_blocked'])

    def test_tampered_raw_report_hides_summary(self):
        self.accepted()
        Path(self.task['review']['output']).write_text('{}')
        self.assert_no_summary(gate.verify(self.task))

    def test_changed_input_hides_stale_summary(self):
        self.accepted()
        self.source.write_text('print(43)\n')
        self.assert_no_summary(gate.verify(self.task))

    def test_invalid_schema_or_ids_hide_summary(self):
        for mutate in (lambda r: r['criteria'][0].update(id='foreign'),
                       lambda r: r['criteria'][0].update(refs=['artifact:foreign']),
                       lambda r: r.update(criteria=[])):
            with self.subTest(mutation=mutate):
                # Reuse the current task so its real check receipts remain bound.
                if self.task is None:
                    self.checked()
                self.simulated_review()
                p = Path(self.task['review']['output'])
                report = json.loads(p.read_text())
                mutate(report)
                gate.atomic_json(p, report)
                self.task['review']['output_hash'] = gate.file_hash(p)
                self.assert_no_summary(gate.verify(self.task))

    def test_missing_review_or_failed_checks_hide_summary(self):
        self.checked()
        self.assert_no_summary(gate.verify(self.task))
        self.simulated_review()
        self.task['checks'].clear()
        self.assert_no_summary(gate.verify(self.task))

    def test_closed_task_hides_summary(self):
        self.accepted()
        self.task.update(lifecycle='closed', close_reason='fixture ended')
        self.assert_no_summary(gate.verify(self.task))


del GateTests
