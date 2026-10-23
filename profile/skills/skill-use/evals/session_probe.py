#!/usr/bin/env python3
"""Verify late loading and reloading in one real Codex CLI conversation."""

import argparse
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import tempfile

from process_support import run_logged


def events_from(text):
    events = []
    for line in text.splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def run_turn(codex, workspace, output, name, prompt, session=None):
    message = output / (name + '.txt')
    command = [codex, 'exec']
    if session:
        command += ['resume', session]
    else:
        command += ['--sandbox', 'read-only', '-C', str(workspace)]
    command += ['--skip-git-repo-check', '--json', '-o', str(message), '-']
    env = dict(os.environ)
    for key in ('CODEX_THREAD_ID', 'CODEX_TURN_ID'):
        env.pop(key, None)
    result = run_logged(command, output, name, prompt=prompt,
                        cwd=workspace, env=env, timeout=170)
    (output / (name + '.jsonl')).write_text(result.stdout)
    (output / (name + '.stderr')).write_text(result.stderr)
    (output / (name + '.command.json')).write_text(json.dumps(command))
    if result.returncode:
        raise RuntimeError(f'{name}: Codex exited {result.returncode}; inspect saved stderr')
    events = events_from(result.stdout)
    ids = [e['thread_id'] for e in events if e.get('type') == 'thread.started']
    if not ids or (session and ids[0] != session):
        raise AssertionError(f'{name}: same session identity was not observed')
    reads = '\n'.join(e.get('item', {}).get('aggregated_output', '') for e in events
                      if e.get('type') == 'item.completed'
                      and e.get('item', {}).get('type') == 'command_execution'
                      and e.get('item', {}).get('exit_code') == 0)
    items = [e.get('item', {}) for e in events if e.get('type') == 'item.completed']
    assert_read_only(items)
    return ids[0], message.read_text(), reads, items


def assert_read_only(items):
    for item in items:
        if item.get('type') == 'file_change':
            raise AssertionError('test conversation modified a file')
        action = item.get('command', '')
        if item.get('type') == 'mcp_tool_call':
            action += ' ' + str(item.get('tool', '')) + ' ' + json.dumps(item.get('arguments', {}))
        forbidden = (r'\b(?:reboot|shutdown|killall|pkill|osascript|launchctl|defaults)\b',
                     r'\bcodex\s+(?:exec|resume|app-server)\b',
                     r'(?:create_thread|send_message_to_thread|handoff_thread|fork_thread|apply_patch)',
                     r'(?:\.codex|\.config)[/\\].*(?:config\.toml|settings\.json)')
        if any(re.search(pattern, action) for pattern in forbidden):
            raise AssertionError('unexpected host, configuration, or session action: ' + action)


def create_target(workspace, multiplier, offset):
    folder = workspace / 'late-skill'
    (folder / 'references').mkdir(parents=True, exist_ok=True)
    marker = secrets.token_hex(8)
    rule = secrets.token_hex(8)
    content = f'''---
name: invoice-format
description: 按本地规则计算当前任务的数值并保留会话工单号。
---
# Invoice Format
读取本目录的 references/rule.json 和任务目录的 input.json。
将 input.json 中 values 的和乘以 multiplier，再加 offset。
沿用本会话先前给出的工单号，不另问工单号。
只返回 JSON：ticket 是工单号，value 是计算结果，rule 是规则文件的 marker，revision 是 {marker}。
'''
    (folder / 'SKILL.md').write_text(content)
    reference = json.dumps({'multiplier': multiplier, 'offset': offset, 'marker': rule})
    (folder / 'references/rule.json').write_text(reference)
    return marker, rule, content, reference


def verify_answer(answer, reads, ticket, marker, rule, content, reference, expected):
    start, end = answer.find('{'), answer.rfind('}')
    actual = json.loads(answer[start:end + 1])
    wanted = {'ticket': ticket, 'value': expected, 'rule': rule, 'revision': marker}
    if actual != wanted:
        raise AssertionError(f'output differs: {actual!r} != {wanted!r}')
    if content.strip() not in reads or reference not in reads:
        raise AssertionError('tool trace does not show full current Skill and reference content')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--codex', default=shutil.which('codex'))
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    output = Path(tempfile.mkdtemp(prefix='session-', dir=args.output))
    workspace = output / 'workspace'
    workspace.mkdir()
    skill = Path(__file__).resolve().parents[1] / 'SKILL.md'
    (workspace / 'input.json').write_text(json.dumps({'values': [2, 5, 11]}))
    ticket = 'CASE-' + secrets.token_hex(5)
    results = []
    try:
        if not args.codex:
            raise RuntimeError('codex is not available')
        version = subprocess.check_output([args.codex, '--version'], text=True, timeout=10).strip()
        (output / 'runtime.json').write_text(json.dumps(
            {'codex': str(Path(args.codex).resolve()), 'version': version}, indent=2))
        session, answer, _, items = run_turn(args.codex, workspace, output, 'initial',
            f'这是一段隔离测试会话。请记住工单号 {ticket}，后续继续这个工单。'
            '本轮不读取任何文件，不调用工具，只回复 READY。')
        if answer.strip() != 'READY' or any(i.get('type') in
                ('command_execution', 'mcp_tool_call', 'file_change', 'web_search') for i in items):
            raise AssertionError('initial turn did not preserve the no-tool setup')
        if (workspace / 'late-skill').exists():
            raise AssertionError('target Skill existed before the first turn finished')
        marker, rule, content, reference = create_target(workspace, 7, 13)
        session, answer, reads, _ = run_turn(args.codex, workspace, output, 'late-load',
            f'使用 skill-use，入口 {skill}。目标 Skill 刚放入 ./late-skill/SKILL.md，'
            '请现在加载它，按它处理 input.json，继续刚才的工单。'
            '这是只读测试，不改文件、不派发、不创建其他会话。', session)
        if skill.read_text().strip() not in reads:
            raise AssertionError('skill-use entrypoint was not fully read')
        verify_answer(answer, reads, ticket, marker, rule, content, reference, 139)
        results.append({'id': 'late-load', 'status': 'pass', 'environment_id': 'codex-cli',
                        'actual': f'{version}; session {session}; fresh Skill/reference read; value=139; prior ticket retained'})
        marker, rule, content, reference = create_target(workspace, 3, 19)
        _, answer, reads, _ = run_turn(args.codex, workspace, output, 'reload-in-session',
            '同一工单继续。刚才的 Skill 和相对引用文件都已更新。'
            '用 skill-use 重新读取它们，再处理 input.json，保持之前的只读约束。', session)
        verify_answer(answer, reads, ticket, marker, rule, content, reference, 73)
        results.append({'id': 'reload-in-session', 'status': 'pass', 'environment_id': 'codex-cli',
                        'actual': f'session {session}; updated Skill/reference read; value=73; prior ticket retained'})
    except Exception as exc:
        for case in ('late-load', 'reload-in-session'):
            if not any(r['id'] == case for r in results):
                results.append({'id': case, 'status': 'fail', 'environment_id': 'codex-cli',
                                'actual': f'{type(exc).__name__}: {exc}'})
    (output / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
    print(f'Raw session evidence: {output}')
    for result in results:
        print('EVIDENCE_GATE_CASE ' + json.dumps(result, ensure_ascii=False))
    return 0 if all(r['status'] == 'pass' for r in results) else 1


if __name__ == '__main__':
    raise SystemExit(main())
