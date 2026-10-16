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
assert d["use_git_add_removed"] is False and d["use_git_size"] is False
assert d["ask_permission_again_for_already_authorized_deletion_staging"] is False
assert "tmp.bundle" in d["reason"] and ("修改" in d["reason"] or "tracked" in d["reason"])
print("本用例行为断言通过")

