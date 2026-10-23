"""读取 skill-up 本次导出的 Codex 原始会话，保留回合和工具调用。"""

import json
import os
from pathlib import Path


def read_rollout(path, workspace):
    transcript = []
    turn = 0
    session_id = None
    for line in path.read_text().splitlines():
        event = json.loads(line)
        payload = event.get('payload', {})
        event_type = event.get('type')
        kind = payload.get('type')
        if event_type == 'session_meta':
            if session_id is not None:
                raise AssertionError('more than one session in rollout')
            if Path(payload['cwd']).resolve() != workspace.resolve():
                raise AssertionError('rollout workspace differs from current case')
            session_id = payload['id']
        elif event_type == 'event_msg' and kind == 'task_started':
            turn += 1
        elif event_type == 'response_item':
            if kind in ('function_call', 'custom_tool_call'):
                transcript.append({'role': 'tool_call', 'turn': turn, 'tool_call': {
                    'id': payload['call_id'], 'name': payload['name'],
                    'arguments': payload.get('arguments', payload.get('input', ''))}})
            elif kind in ('function_call_output', 'custom_tool_call_output'):
                transcript.append({'role': 'tool_result', 'turn': turn, 'tool_result': {
                    'call_id': payload['call_id'], 'content': payload['output'],
                    'container': kind == 'custom_tool_call_output'}})
            elif kind == 'message' and payload.get('role') in ('user', 'assistant'):
                transcript.append({'role': payload['role'], 'turn': turn, 'content':
                    '\n'.join(item.get('text', '') for item in payload.get('content', []))})
    if not session_id or not turn:
        raise AssertionError('rollout lacks session identity or turn boundaries')
    return transcript, {'path': str(path), 'session_id': session_id, 'turns': turn}


def load_transcript(case):
    output = os.environ.get('SKILL_USE_EVAL_OUTPUT')
    if not output:
        raise RuntimeError('use evals/run_suite.py --output DIR to bind raw evaluation traces')
    directory = Path(output) / 'iteration-1' / case / 'with_skill/outputs/agent/run'
    sources = list(directory.glob('rollout-*.jsonl'))
    if len(sources) != 1:
        raise AssertionError(f'expected one current-case rollout in {directory}, found {len(sources)}')
    return read_rollout(sources[0], Path.cwd())
