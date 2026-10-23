#!/usr/bin/env python3
"""执行 skill-up validate/run，绑定本次原始轨迹并输出逐例评分。"""

import argparse
import json
import os
from pathlib import Path
import shutil
import tempfile

from process_support import run_logged


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    suite = root / 'evals/eval.yaml'
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    output = Path(tempfile.mkdtemp(prefix='eval-', dir=args.output))
    skill_up = shutil.which('skill-up')
    if not skill_up:
        raise RuntimeError('skill-up is not available')
    env = dict(os.environ)
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    env['SKILL_USE_EVAL_OUTPUT'] = str(output)
    env['SKILL_USE_EVAL_SOURCE'] = str(root)
    for key in ('CODEX_THREAD_ID', 'CODEX_TURN_ID'):
        env.pop(key, None)
    validation = run_logged([skill_up, 'validate', str(suite)], output, 'validate',
                            cwd=root, env=env, timeout=20)
    validation.check_returncode()
    command = [skill_up, 'run', str(suite), '--output-dir', str(output)]
    result = run_logged(command, output, 'run', cwd=root, env=env, timeout=550)
    reports = list(output.glob('iteration-*/result.json'))
    if len(reports) != 1:
        raise RuntimeError(f'expected one fresh result.json, found {len(reports)} in {output}')
    report = json.loads(reports[0].read_text())
    cases = report['case_results']
    expected = {Path(p).stem for p in json.loads(suite.read_text())['cases']['files']}
    actual = [c['case_id'] for c in cases]
    if len(actual) != len(set(actual)) or set(actual) != expected:
        raise AssertionError(f'case coverage mismatch: {actual}')
    passed = result.returncode == 0
    print(f'Raw skill-up report: {reports[0]}')
    for case in cases:
        grading = case.get('grading') or {}
        assertions = grading.get('assertion_results') or []
        ok = case['status'].lower() == 'pass' and bool(assertions) and all(
            a.get('passed') is True for a in assertions)
        passed = passed and ok
        print('EVIDENCE_GATE_CASE ' + json.dumps({
            'id': case['case_id'], 'status': 'pass' if ok else 'fail',
            'environment_id': 'skill-up-codex',
            'actual': json.dumps({'status': case['status'], 'error': case.get('error'),
                                  'grading': grading}, ensure_ascii=False)
        }, ensure_ascii=False))
    return 0 if passed else 1


if __name__ == '__main__':
    raise SystemExit(main())
