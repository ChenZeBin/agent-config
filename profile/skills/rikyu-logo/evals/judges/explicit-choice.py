#!/usr/bin/env python3
import json, os
text = os.environ["EVAL_FINAL_MESSAGE"].strip()
if text.startswith("```"):
    text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
d = json.loads(text)
assert d['force_rikyu'] is False and d['respect_explicit_choice'] is True
print("行为断言通过")
