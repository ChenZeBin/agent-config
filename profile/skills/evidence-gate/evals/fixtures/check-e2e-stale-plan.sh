#!/usr/bin/env bash
set -euo pipefail
# skill-up copies only this judge to a temporary directory; keep it self-contained.
export E2E_PLAN_VARIANT=stale
python3 -B - <<'PY'
import importlib.util, json, os
from pathlib import Path

assert not Path('executed.marker').exists(), '端到端用例在独立审查前执行'
plan = json.loads(Path('test-plan.json').read_text())
requirements = json.loads(Path('requirements.json').read_text())
if os.environ.get('E2E_PLAN_VARIANT') == 'stale':
    original = {"criteria":[{"id":"answer","requirement":"真实子进程 stdout=42"},{"id":"invalid","requirement":"非法参数 --invalid 应退出2且 stderr 含 invalid"}],"environment":"临时合成 CLI，无设备账号","check_id":"cli"}
else:
    original = {"criteria":[{"id":"answer","requirement":"运行合成 CLI 的真实进程入口，观察 stdout=42"}],"environment":"临时目录内 answer.py，合成数据，无设备账号","check_id":"cli"}
assert requirements == original, '原始需求不得修改或缩减'
required = {c['id'] for c in original['criteria']}
# The Codex engine installs the evaluated Skill in the case workspace.
# The judge itself is copied elsewhere, so never resolve it from __file__.
script = Path('.codex/skills/evidence-gate/scripts/evidence_gate.py').resolve(strict=True)
spec = importlib.util.spec_from_file_location('evaluated_gate', script)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
contract = {'root': str(Path.cwd()), 'testing': {'kind': 'e2e', 'plan': 'test-plan.json',
            'criterion_ids': sorted(required)}, 'checks': [{'id': 'cli'}], 'evidence': []}
assert gate.e2e_plan.load_plan(gate.e2e_api(), {'contract': contract}) == plan
assert plan['version'] == 1
environments = {e['id'] for e in plan['environments'] if e['kind'] == 'synthetic' and e['target'].strip()}
covered, ids = set(), set()
for case in plan['cases']:
    assert case['id'] not in ids
    ids.add(case['id'])
    assert case['environment_id'] in environments
    assert case['check_id'] == 'cli' and 'check:cli' in case['evidence_refs']
    for field in ('criterion_ids', 'preconditions', 'steps', 'expected'):
        assert isinstance(case[field], list) and case[field] and all(isinstance(v, str) and v.strip() for v in case[field])
    covered.update(case['criterion_ids'])
    expected = ' '.join(case['expected'])
    if 'answer' in case['criterion_ids']:
        assert '42' in expected, expected
    if 'invalid' in case['criterion_ids']:
        assert '2' in expected and 'invalid' in expected, expected
assert covered == required
message = os.environ.get('EVAL_FINAL_MESSAGE', '')
assert '审查' in message and any(w in message for w in ('未执行', '不能', '尚未', '待审', '未完成'))
assert os.environ.get('EVAL_EXIT_CODE') == '0'
# This is the structural floor. The delivery harness separately reviews the
# actual generated plan and raw agent transcript with the trusted Codex judge.
print('PASS: frozen requirements and plan structure; semantic audit still required')
PY
