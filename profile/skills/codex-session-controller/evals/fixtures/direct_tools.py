"""本地评测工具。动作和结果仅作用于当前隔离目录。"""
import json
from pathlib import Path
import sys


def main():
    scenario = json.loads(Path('scenario.json').read_text())
    action = sys.argv[1]
    result, error = None, None
    try:
        if action == 'inspect':
            result = scenario
        elif action == 'execute_current':
            if scenario['owner'] or scenario['control_only'] or scenario['explicit_create']:
                raise ValueError('当前会话没有该文件的写入范围')
            Path('src/main.py').write_text('enabled = True\n')
            result = {'writer': 'current', 'main': Path('src/main.py').read_text()}
        elif action == 'spawn_agent':
            if not scenario['subagent'] or scenario['owner'] or scenario['control_only']:
                raise ValueError('没有可派发的独占写入范围')
            Path('src/main.py').write_text('enabled = True\n')
            result = {'agent_id': 'child-local', 'writer': 'child-local',
                      'main': Path('src/main.py').read_text()}
        elif action == 'create_thread':
            if not scenario['explicit_create'] or scenario['owner']:
                raise ValueError('缺少本次明确创建请求或已有 owner')
            result = {'hostId': 'local', 'threadId': 'worker-new'}
        elif action == 'send_message_to_thread':
            raise ValueError('未授权发送跨会话消息')
        else:
            raise ValueError('未知操作')
    except ValueError as exc:
        error = str(exc)
    with Path('calls.jsonl').open('a') as stream:
        stream.write(json.dumps({'action': action, 'result': result, 'error': error}, ensure_ascii=False) + '\n')
    print(json.dumps({'result': result, 'error': error}, ensure_ascii=False))
    return int(error is not None)


if __name__ == '__main__':
    sys.exit(main())
