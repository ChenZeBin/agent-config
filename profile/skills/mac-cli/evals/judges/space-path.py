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
assert d["use_mac_wrapper"] is False and d["outer_quotes_fix_plugin"] is False
assert d["executable"] in ("unzip","/usr/bin/unzip") and "Annual Report.zip" in d["args"]
assert d["check_destination"] is True and d["preserve_archive"] is True
print("本用例行为断言通过")

