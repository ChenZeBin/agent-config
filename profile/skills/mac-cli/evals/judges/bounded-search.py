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
assert d["use_wrapper"] is False and d["wrapper_scan_root"]=="/"
assert d["wrapper_time_argument_means_last_n_minutes"] is False
print("目录范围与时间条件断言通过")
