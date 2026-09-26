#!/usr/bin/env python3
"""Grade explicit quantity and style overrides without relying on a response template."""
import json
import os
import re
import sys

text = os.environ.get("EVAL_FINAL_MESSAGE", "").strip()
lower = text.lower()

def require(ok, reason):
    if not ok:
        print(f"ERROR: {reason}")
        sys.exit(1)


def require_skill_reads():
    transcript = os.environ.get("EVAL_TRANSCRIPT_PATH")
    require(bool(transcript) and os.path.isfile(transcript), "missing evaluation transcript for skill-read evidence")
    try:
        with open(transcript, encoding="utf-8") as handle:
            raw = handle.read()
        try:
            records = json.loads(raw)
        except json.JSONDecodeError:
            records = [json.loads(line) for line in raw.splitlines() if line.strip()]
    except (OSError, ValueError) as error:
        require(False, f"cannot inspect evaluation transcript: {error}")

    def tool_call_blobs(value):
        if isinstance(value, dict):
            if value.get("type") in {"function_call", "custom_tool_call", "command_execution", "tool_call"}:
                return [json.dumps(value, ensure_ascii=False)]
            for key in ("tool_calls", "toolCalls", "function_call", "functionCall"):
                if key in value:
                    return [json.dumps(value[key], ensure_ascii=False)]
            return [blob for nested in value.values() for blob in tool_call_blobs(nested)]
        if isinstance(value, list):
            return [blob for nested in value for blob in tool_call_blobs(nested)]
        return []

    evidence = "\n".join(tool_call_blobs(records)).lower()
    require(all(name in evidence for name in ("skill.md", "visual-style.md", "qa.md")),
            "tool trace does not show reads of SKILL.md, visual-style.md, and qa.md")

def image_sections(value):
    # The prompt allows named image headings or Markdown headings for the three plans.
    named = re.findall(r"(?m)^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:(?:图|配图|插图)\s*[一二三四五六七八九十\d]+|第?[一二三四五六七八九十\d]+张)(?=[:：｜|])", value)
    if named:
        return named
    return re.findall(
        r"(?m)^\s*(?:(?:#{1,6}\s*)|\*\*)?[123][.．、:：](?=[\s\S]{0,240}(?:纸船动作|插入位置|唯一意思))",
        value,
    )

# Guard the counting rule itself: a fourth image must be observable, while
# ordinary numbered prose and a closing sentence such as “三张均...” are not.
assert len(image_sections("**第一张：a**\n**第二张：b**\n**第三张：c**\n**第四张：d**")) == 4
assert not image_sections("1. 普通要点\n2. 另一个普通要点\n三张均使用同一风格")

require(bool(text), "final response is empty")
require(len(image_sections(text)) == 3,
        "expected exactly three identifiable illustration plans")
require(any(token in text for token in ("4:5", "4：5", "竖版", "竖构图")),
        "missing the requested vertical 4:5 composition")
for color in ("#fff7ed", "#2d241f", "#ea580c"):
    require(color in lower, f"missing user-specified color {color}")
require("纸船" in text, "missing the user-specified paper boat")
require(text.count("纸船") >= 3 and sum(term in text for term in ("推动", "修正", "校正", "顶", "拉", "接合")) >= 2,
        "paper boat is not shown acting on the core objects across the plan")
require("检查点" in text, "missing the allowed second-image label")
explicit_no_person = any(term in text for term in ("不要画人物", "不画人物", "不出现人物", "无人", "不加人"))
paper_boat_only = text.count("纸船") >= 3 and not re.search(
    r"(?:人物|人类|角色|员工|客户|短发|白衣|圆头|双手|手掌|双脚|身体)", text,
)
paper_boat_only = paper_boat_only and not re.search(
    r"纸船.{0,20}(?:长出|伸出|带着|使用|挥动|举起).{0,12}(?:手|脚|手臂|腿)", text,
)
require(explicit_no_person
        or bool(re.search(r"(?:三张均)?只有一只.{0,24}(?:纸船.{0,48}无脸.{0,8}无手脚|无脸.{0,8}无手脚.{0,24}纸船)", text))
        or paper_boat_only,
        "the plan does not preserve the user's no-person override")
require(not re.search(r"(?:已|已经|完成|成功).{0,8}(?:生成|产出).{0,8}(?:图片|图像|配图|插画)", text),
        "claims image generation despite an explicit planning-only request")
print("PASS: exactly three plans apply the requested palette, ratio, and paper-boat override")
