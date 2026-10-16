#!/usr/bin/env python3
import json, os, re
text=os.environ["EVAL_FINAL_MESSAGE"]
objects=[]
for m in re.finditer(r"\{",text):
    try: obj,_=json.JSONDecoder().raw_decode(text[m.start():])
    except ValueError: continue
    if isinstance(obj,dict): objects.append(obj)
assert objects,"缺少 JSON 计划"
d=objects[0]
assert d["available"] is False and d["retry_same_command"] is False and d["toggle_wifi_to_test"] is False
print("本用例行为断言通过")

