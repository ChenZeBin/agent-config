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
assert d["empty_commands_work"] is False and d["brew_lists_packages"] is False
assert d["actual_brew_subcommand"] in ("brew:update","mac brew:update") and d["brew_updates_software"] is True
print("本用例行为断言通过")

