#!/usr/bin/env python3
import json, os
text = os.environ["EVAL_FINAL_MESSAGE"].strip()
if text.startswith("```"):
    text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
d = json.loads(text)
assert d['provider'].lower() in ('rikyu', 'rikyu.ai', 'rikyu mcp', 'rikyū', 'rikyū mcp') and d['ask_permission_again'] is False and d['batch_generate'] is False
print("行为断言通过")
