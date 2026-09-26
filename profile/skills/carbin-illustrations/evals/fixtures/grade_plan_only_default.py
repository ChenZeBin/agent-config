#!/usr/bin/env python3
"""Grade the planning-only default-style behaviour without a canned format."""
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
    # Count only headings that identify an illustration, rather than ordinary list items.
    pattern = r"(?m)^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:(?:图|配图|插图)\s*[一二三四五六七八九十\d]+|[12][.．、])"
    return re.findall(pattern, value)

require(bool(text), "final response is empty")
require(len(image_sections(text)) == 2,
        "expected exactly two identifiable illustration plans, not a generic numbered list")
require(any(term in text for term in ("阻塞", "瓶颈", "排队", "等待")),
        "missing the article's shared-review bottleneck")
require(sum(term in text for term in ("限制", "在制", "并行", "畅通", "接近完成")) >= 2,
        "missing the article's limit-work-and-finish recovery idea")
require(any(term in text for term in ("插入位置", "插入", "段落")),
        "plans do not state where they belong in the article")
require(sum(term in text for term in ("推", "拉", "移", "操作", "检查")) >= 2,
        "the figures are not assigned meaningful actions on core objects")
require(any(term in text for term in ("纯白背景", "纯白底")) and bool(re.search(r"黑色.{0,8}(?:线|稿)|(?:线|稿).{0,8}黑色", text)),
        "default treatment must be a white background with black linework")
require("#2563eb" in lower or "蓝色" in text,
        "missing the default single blue emphasis")
require(any(token in text for token in ("16:9", "16：9", "横版 16:9")),
        "missing the default 16:9 ratio")
require(not re.search(r"(?:已|已经|完成|成功).{0,8}(?:生成|产出).{0,8}(?:图片|图像|配图|插画)", text),
        "claims image generation despite an explicit planning-only request")
print("PASS: exactly two content-grounded plans stop before generation and apply default style")
