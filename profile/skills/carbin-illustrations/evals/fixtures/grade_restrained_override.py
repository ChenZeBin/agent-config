#!/usr/bin/env python3
"""Grade a user-requested restrained style override without a canned format."""
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


def sections(value):
    return re.findall(
        r"(?m)^\s*(?:#{1,6}\s*)?(?:\d+[.．、]\s*)?(?:\*\*)?(?:(?:图|配图|插图)\s*[一二三四五六七八九十\d]+|插入位置)(?:\*\*)?",
        value,
    )


require(bool(text), "final response is empty")
require(len(sections(text)) == 2, "expected exactly two identifiable illustration plans")
require("#ffffff" in lower and "#1f2937" in lower,
        "missing the user-specified white and graphite palette")
require("#2563eb" not in lower,
        "reintroduces the default blue emphasis despite the explicit override")
require(any(word in text for word in ("克制", "平静", "中性", "轻微", "等比例", "等大", "等宽", "等距", "留白", "轻触", "自然", "无透视")),
        "does not preserve the requested restrained treatment")
require(any(word in text for word in ("下周优先", "无")),
        "does not respect the restricted text policy")
require(sum(term in text for term in ("完成", "未完成", "下周", "优先", "复盘")) >= 3,
        "plans are not grounded in the weekly review article")
require(not re.search(r"(?:已|已经|完成|成功).{0,8}(?:生成|产出).{0,8}(?:图片|图像|配图|插画)", text),
        "claims image generation despite the planning-only request")
print("PASS: explicit restrained style overrides the default expressive treatment")
