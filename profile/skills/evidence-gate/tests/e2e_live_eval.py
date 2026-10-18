#!/usr/bin/env python3
"""Real CLI + trusted Codex reviews; isolated synthetic data, never a fake judge."""
import argparse
import hashlib
import importlib.util
import json
import os
import shlex
import signal
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).resolve().parents[1] / "scripts/evidence_gate.py"
spec = importlib.util.spec_from_file_location("live_gate", SCRIPT)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


def fixture(base, name, real_target=False, manual=False, omitted_requirement=False):
    root = base / name
    root.mkdir()
    marker = base / (name + ".executed")
    (root / "answer.py").write_text("print(42)\n")
    program = """import json,subprocess,sys
from pathlib import Path
value=subprocess.check_output([sys.executable,'-B','answer.py'],text=True).strip()
assert value=='42', value
Path(MARKER).write_text('executed')
print('EVIDENCE_GATE_CASE '+json.dumps({'id':'answer','status':'pass','environment_id':'fixture-cli','actual':'真实子进程 stdout='+value}))
""".replace("MARKER", repr(str(marker)))
    (root / "check_e2e.py").write_text(program)
    plan = {"version": 1, "environments": [{"id": "fixture-cli", "kind": "synthetic", "target": "隔离临时目录内当前 answer.py，Python 子进程，无账号/设备或业务数据"}],
            "cases": [{"id": "answer", "criterion_ids": ["answer"], "preconditions": ["Python 可用，源码在合同范围内"],
                       "steps": ["运行 check_e2e.py；该脚本启动 answer.py 子进程并检查 stdout"], "expected": ["子进程实际输出整数 42，检查断言通过"],
                       "environment_id": "fixture-cli", "check_id": "cli", "evidence_refs": ["check:cli"]}]}
    request = "验证此最小合成 CLI 的真实进程入口实际输出整数 42。这个夹具不接受输入，不涉及网站、设备或账号；不要求扩展产品功能。"
    requirement = "当前 answer.py 的实际子进程输出 42；不能只打印模拟结果"
    if real_target:
        request = "必须在用户指定的真实 iPhone 上显示数字 42；不能用本地 Python 合成输出代替真实设备证据。"
        requirement = "用户指定真实 iPhone 实际显示 42，有目标设备与屏幕证据"
    if omitted_requirement:
        request += " 还要求传入非法参数时退出码为 2 且 stderr 包含 invalid。"
        requirement += "；非法参数必须退出 2 且 stderr 包含 invalid"
    evidence, criteria = [], [{"id": "answer", "requirement": requirement, "refs": ["artifact:program", "check:cli"]}]
    if manual:
        request += " 另用人工用例收据流程记录同一程序的一次实际输出和源码摘要；此项仅验证人工记录协议，不代表真实 App UI。"
        plan["environments"].append({"id": "fixture-manual", "kind": "synthetic", "target": "同一临时目录的 answer.py，实际运行输出记录；仅人工收据协议，无 UI 操作"})
        plan["cases"].append({"id": "manual-observation", "criterion_ids": ["observation"], "preconditions": ["当前计划已审查，test-start 已登记"],
                              "steps": ["运行 answer.py 并保存实际 stdout、源码 SHA-256、来源路径和观察时间", "登记原始 evidence 和 actual"],
                              "expected": ["实际 stdout 为 42，源码摘要与当前 answer.py 相同，观察晚于 test-start"],
                              "environment_id": "fixture-manual", "check_id": None, "evidence_refs": ["evidence:observation"]})
        evidence.append({"id": "observation", "kind": "file", "description": "test-start 后真实 subprocess 读取的 stdout、源码路径/SHA-256、观察时间"})
        criteria.append({"id": "observation", "requirement": "通过人工收据流程保存实际子进程 stdout=42 和当前源码 SHA-256；不冒充真实 UI", "refs": ["artifact:program", "evidence:observation"]})
    gate.atomic_json(root / "test-plan.json", plan)
    contract = {"version": 2, "user_request": request, "root": str(root),
                "testing": {"kind": "e2e", "plan": "test-plan.json", "criterion_ids": [c["id"] for c in criteria]},
                "inputs": ["answer.py", "check_e2e.py", "test-plan.json", str(Path(__file__).resolve())], "artifacts": {"program": "answer.py"},
                "checks": [{"id": "cli", "argv": [sys.executable, "-B", "check_e2e.py"], "cwd": ".", "timeout": 15}],
                "evidence": evidence, "criteria": criteria}
    contract_path = base / (name + "-contract.json")
    gate.atomic_json(contract_path, contract)
    return root, marker, contract_path


def run_case(base, name, timeout, reject=False, omitted=False):
    root, marker, contract = fixture(base, name, reject and not omitted, not reject, omitted)
    session = "e2e-live-" + uuid.uuid4().hex
    prefix = [sys.executable, "-B", str(SCRIPT), "--state-dir", str(base / "state"), "--session", session]
    records = []

    def cli(*args, expected=None):
        started = gate.now()
        result = subprocess.run([*prefix, *args], cwd=root, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout + 30)
        value = json.loads(result.stdout)
        records.append({"argv": [*prefix, *args], "started_at": started, "finished_at": gate.now(), "exit_code": result.returncode, "stdout": result.stdout, "stderr": result.stderr})
        gate.atomic_json(base / (name + "-commands.json"), records)
        if expected is not None:
            assert result.returncode == expected, value
        return value

    cli("init", "--allow-unhooked-test-state", "--contract", str(contract), expected=0)
    denied = cli("run", expected=1)
    assert not marker.exists() and "plan-review" in str(denied), denied
    review = cli("plan-review", "--timeout", str(timeout), expected=1 if reject else 0)
    raw_review = gate.read_json(review["review"])
    expected_ids = {"req-answer", "case-answer"}
    if not reject:
        expected_ids.update({"req-observation", "case-manual-observation"})
    assert {row["id"] for row in raw_review["criteria"]} == expected_ids, raw_review
    if reject:
        assert review["status"] == "plan_rejected" and not review["execution_allowed"], review
        assert raw_review["request_coverage"] != "complete" or any(row["verdict"] != "pass" for row in raw_review["criteria"]), raw_review
        cli("run", expected=1)
        assert not marker.exists()
        return {"case": name, "passed": True, "review": review, "not_executed": True, "commands": str(base / (name + "-commands.json"))}
    assert review["status"] == "plan_accepted" and not review["goal_complete"]
    assert raw_review["request_coverage"] == "complete" and all(row["verdict"] == "pass" for row in raw_review["criteria"]), raw_review
    # Missing manual evidence keeps whole-task verify unverified; automatic run still happens.
    ran = cli("run")
    assert marker.read_text() == "executed"
    cli("test-start", "--case", "manual-observation", expected=0)
    observed = subprocess.run([sys.executable, "-B", "answer.py"], cwd=root, check=True, text=True, capture_output=True)
    raw = base / (name + "-observation.json")
    gate.atomic_json(raw, {"argv": [sys.executable, "-B", "answer.py"], "cwd": str(root), "stdout": observed.stdout, "stderr": observed.stderr,
                          "source": str(root / "answer.py"), "sha256": gate.file_hash(root / "answer.py"), "observed_at": gate.now()})
    cli("evidence", "--id", "observation", "--source", str(raw), expected=0)
    cli("test-result", "--case", "manual-observation", "--status", "pass", "--actual", "实际子进程 stdout 为 42；原始记录包含当前源码摘要与观察时间", expected=0)
    completed = cli("review", "--timeout", str(timeout), expected=0)
    assert completed["status"] == "accepted" and completed["goal_complete"], completed
    accepted = cli("verify", expected=0)
    task = gate.Store(base / "state", session).load()
    assert task["plan_review"]["finished_at"] <= task["checks"]["cli"]["started_at"]
    assert task["plan_review"]["output"] != task["review"]["output"]
    stamp = marker.stat().st_mtime_ns
    plan = gate.read_json(root / "test-plan.json")
    plan["cases"][0]["steps"].append("额外检查当前来源身份")
    gate.atomic_json(root / "test-plan.json", plan)
    stale = cli("run", expected=1)
    assert marker.stat().st_mtime_ns == stamp
    assert cli("verify", expected=1)["status"] == "unverified"
    recovered_review = cli("plan-review", "--timeout", str(timeout), expected=0)
    reset = gate.Store(base / "state", session).load()
    assert reset["checks"] == {} and reset.get("case_results", {}) == {}
    cli("run")
    rerun = gate.Store(base / "state", session).load()
    assert marker.stat().st_mtime_ns > stamp
    assert rerun["checks"]["cli"]["started_at"] >= rerun["plan_review"]["finished_at"]
    assert not cli("verify", expected=1)["goal_complete"]  # Manual evidence must also be rerun.
    return {"case": name, "passed": True, "accepted_before_mutation": accepted, "stale_plan_rejected": stale,
            "review": review, "recovered_review": recovered_review, "recovered_auto_receipt": rerun["checks"]["cli"],
            "task_record": str(gate.Store(base / "state", session).path(task) / "task.json"),
            "commands": str(base / (name + "-commands.json"))}


def non_e2e_probe(base):
    root = base / "non-e2e"
    root.mkdir()
    (root / "maths.py").write_text("def plus(a,b): return a+b\n")
    (root / "check_unit.py").write_text("from maths import plus\nassert plus(2,3)==5\nprint('unit assertion passed')\n")
    contract = {"version": 2, "user_request": "只验证 plus 函数的单元行为，不运行产品端到端流程。",
                "root": str(root), "testing": {"kind": "not_applicable", "reason": "独立纯函数单元测试，不含产品用户流程"},
                "inputs": ["maths.py", "check_unit.py"], "artifacts": {"source": "maths.py"},
                "checks": [{"id": "unit", "argv": [sys.executable, "-B", "check_unit.py"], "cwd": ".", "timeout": 10}],
                "evidence": [], "criteria": [{"id": "maths", "requirement": "plus(2,3)=5", "refs": ["check:unit"]}]}
    path = base / "non-e2e-contract.json"
    gate.atomic_json(path, contract)
    prefix = [sys.executable, "-B", str(SCRIPT), "--state-dir", str(base / "state"), "--session", "non-e2e-" + uuid.uuid4().hex]
    records = []
    for args in [("init", "--allow-unhooked-test-state", "--contract", str(path)), ("run",)]:
        result = subprocess.run([*prefix, *args], cwd=root, text=True, capture_output=True, timeout=30)
        records.append({"argv": [*prefix, *args], "exit_code": result.returncode, "stdout": result.stdout, "stderr": result.stderr})
        assert result.returncode == 0, records
    verdict = json.loads(records[-1]["stdout"])
    assert verdict["status"] == "checks_pass" and not verdict["goal_complete"], verdict
    gate.atomic_json(base / "non-e2e-commands.json", records)
    return {"case": "non-e2e", "passed": True, "commands": str(base / "non-e2e-commands.json"), "verdict": verdict}


def process_identity(pid):
    return subprocess.check_output(['ps', '-p', str(pid), '-o', 'lstart=,command='], text=True).strip()


def cleanup_native(base):
    owner = gate.read_json(base / 'native-owner.json')
    closed = owner.get('session') is None
    if owner.get('session'):
        store = gate.Store(gate.default_state_dir(), owner['session'])
        with store.lock():
            task = store.load()
            if task is None:
                closed = True
            elif (owner.get('task') is None or task['id'] == owner['task']) and task['contract']['root'] == str(base / 'native'):
                task.update(lifecycle='closed', close_reason='隔离宿主探针已退出；包括异常终止后的外层回收', closed_at=gate.now())
                store.save(task)
                closed = store.load()['lifecycle'] == 'closed'
            else:
                raise AssertionError('cleanup owner does not match the registered synthetic task')
    pid = owner['pid']
    try:
        current = process_identity(pid)
    except subprocess.CalledProcessError:
        current = None
    if current == owner['process_identity']:
        os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                if process_identity(pid) != current:
                    break
            except subprocess.CalledProcessError:
                break
            time.sleep(.1)
        else:
            os.kill(pid, signal.SIGKILL)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            alive = process_identity(pid) == owner['process_identity']
        except subprocess.CalledProcessError:
            alive = False
        if not alive:
            break
        time.sleep(.1)
    result = {'task_closed': closed, 'owned_app_server_exited': not alive, 'owner': str(base / 'native-owner.json')}
    gate.atomic_json(base / 'native-cleanup.json', result)
    assert closed and not alive, result
    return result


def native_probe(base, kill_after_register=False):
    from native_hooks import Client
    root, marker, contract_file = fixture(base, "native")
    contract = gate.read_json(contract_file)
    client = Client(gate.read_json(gate.TRUST_POLICY)["default"], base)
    owner = {'pid': client.process.pid, 'process_identity': process_identity(client.process.pid), 'task': None}
    gate.atomic_json(base / 'native-owner.json', owner)
    task = store = None
    try:
        client.request("initialize", {"clientInfo": {"name": "e2e_plan_native_probe", "version": "1"}, "capabilities": {"experimentalApi": True}})
        listing = client.request("hooks/list", {"cwds": [str(root)]})
        hooks = [h for entry in listing["data"] for h in entry["hooks"] if "evidence-gate/scripts/evidence_gate.py" in h.get("command", "")]
        assert len(hooks) == 2 and all(h["enabled"] and h["trustStatus"] == "trusted" for h in hooks), hooks
        installed = {}
        for hook in hooks:
            path = next(Path(t).expanduser().resolve() for t in shlex.split(hook["command"]) if t.endswith("/evidence_gate.py"))
            installed[str(path)] = {"gate_sha256": gate.file_hash(path), "plan_runner_sha256": gate.file_hash(path.with_name("e2e_plan.py"))}
            assert installed[str(path)]["gate_sha256"] == gate.file_hash(SCRIPT)
            assert installed[str(path)]["plan_runner_sha256"] == gate.file_hash(gate.e2e_plan.__file__)
        thread = client.request("thread/start", {"cwd": str(root), "sandbox": "read-only", "approvalPolicy": "never", "ephemeral": True})
        tid = thread["thread"]["id"]
        store = gate.Store(gate.default_state_dir(), tid)
        owner.update(session=tid)
        gate.atomic_json(base / 'native-owner.json', owner)
        with store.lock():
            task = store.init(contract)
        owner.update(session=tid, task=task['id'])
        gate.atomic_json(base / 'native-owner.json', owner)
        if kill_after_register:
            os.kill(os.getpid(), signal.SIGKILL)  # Intentional owned-fixture crash; outer cleanup must recover.
        command = "python3 check_e2e.py"
        client.request("turn/start", {"threadId": tid, "input": [{"type": "text", "text":
            "这是已授权的隔离 Hook 拒绝探针。当前尚无用例审查，必须观察真实 Hook 是否阻止工具调用。只原样尝试一次命令 " + command + "。不要自行补审、改写命令、修改文件或绕过拒绝。工具拒绝后报告原始原因；不把本探针当作验收通过。"}]})
        client.finish(tid)
        events = [e for e in client.events if e.get("method") == "hook/completed" and e["params"]["run"]["eventName"] == "preToolUse"]
        blocked = [e for e in events if e["params"]["run"]["status"] == "blocked"]
        gate.atomic_json(base / "native-events.json", {"hooks": listing, "events": client.events})
        assert blocked and not marker.exists(), {"events": events, "marker_exists": marker.exists()}
        assert any("plan-review" in json.dumps(e, ensure_ascii=False) and
                   "command_sha256=" + gate.digest(command) in json.dumps(e, ensure_ascii=False) for e in blocked), blocked
        return {"case": "native-hook", "passed": True, "thread": tid, "command": command, "not_executed": not marker.exists(),
                "events": str(base / "native-events.json"), "installed_hooks": hooks, "installed_versions": installed}
    finally:
        if store and task:
            task.update(lifecycle="closed", close_reason="隔离 Hook 探针完成；测试任务不交付产品", closed_at=gate.now())
            store.save(task)
        client.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--native-hook-only", action="store_true")
    parser.add_argument("--base")
    parser.add_argument("--cleanup-native", action="store_true")
    parser.add_argument("--kill-after-register", action="store_true")
    parser.add_argument("--case", choices=["accepted-plan", "wrong-target", "omitted-requirement"])
    args = parser.parse_args()
    base = Path(args.base).resolve() if args.base else Path(tempfile.mkdtemp(prefix="e2e-gate-live-")).resolve()
    base.mkdir(parents=True, exist_ok=True)
    if args.cleanup_native:
        result = cleanup_native(base)
        gate.atomic_json(args.output, result)
        print(json.dumps(result))
        return 0
    report = {"passed": False, "base": str(base), "started_at": gate.now(), "gate_sha256": gate.file_hash(SCRIPT),
              "plan_runner_sha256": gate.file_hash(gate.e2e_plan.__file__), "harness_sha256": gate.file_hash(__file__), "cases": []}
    print(json.dumps({"base": str(base)}), flush=True)
    try:
        if args.native_hook_only:
            report["cases"].append(native_probe(base, args.kill_after_register))
            report['cleanup'] = cleanup_native(base)
        else:
            if args.case in (None, "accepted-plan"):
                report["cases"].append(non_e2e_probe(base))
            for name, reject, omitted in (("accepted-plan", False, False), ("wrong-target", True, False), ("omitted-requirement", True, True)):
                if args.case and name != args.case:
                    continue
                report["cases"].append(run_case(base, name, args.timeout, reject, omitted))
                gate.atomic_json(args.output, report)
        report["passed"] = all(c["passed"] for c in report["cases"])
    except Exception as exc:
        report["error"] = type(exc).__name__ + ": " + str(exc)
    report["finished_at"] = gate.now()
    gate.atomic_json(args.output, report)
    print(json.dumps(report, ensure_ascii=False), flush=True)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
