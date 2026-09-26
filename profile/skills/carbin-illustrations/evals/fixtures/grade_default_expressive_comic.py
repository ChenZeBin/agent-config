#!/usr/bin/env python3
"""Grade default expressive-comic planning without requiring a fixed template."""
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
    matches = list(re.finditer(
        r"(?m)^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:(?:图|配图|插图)\s*[一二三四五六七八九十\d]+|[12][.．、])(?:[^\n]*)",
        value,
    ))
    return [value[m.start(): matches[i + 1].start() if i + 1 < len(matches) else len(value)]
            for i, m in enumerate(matches)]


def has_any(value, words):
    return any(word in value for word in words)


def has_force_relation(value):
    """Require a body/actor and a physical manipulation verb in one local action."""
    return bool(re.search(
        r"(?:手|掌|指|臂|脚|肩|身体|人物|角色|员工|负责人|成员|纸船).{0,36}(?:压|按|拉|推|拖|扣|握|顶|抵|蹬|拽|抬|搬|扛|托|扶|放)",
        value,
    ))


def has_effective_detail_or_contrast(value):
    """A detail must explain the point; a bare decorative noun does not qualify."""
    detail = ("叙事细节", "必要元素", "关键物件", "时间或成本", "时间或成本道具", "构图对比")
    explains = ("表示", "说明", "表达", "支撑", "突出", "对比", "提示", "解释", "暗示")
    return has_any(value, detail) and has_any(value, explains)


def has_semantic_blue_emphasis(value):
    """Require blue on a named story object, rather than a decorative dot or outline."""
    blue = r"(?:蓝色|#2563eb)"
    story_object = r"(?:按钮|印章|托盘|纸箱|包裹|旗|平台|砝码|天平)"
    decorative_only = re.search(rf"{blue}.{{0,20}}(?:轮廓|描边|小点|点缀)", value, re.I)
    return not decorative_only and bool(re.search(
        rf"{blue}.{{0,40}}{story_object}|{story_object}.{{0,40}}{blue}", value, re.I))


require(bool(text), "final response is empty")
plans = sections(text)
require(len(plans) == 2, "expected exactly two identifiable illustration plans")
require(has_any(text, ("纯白背景", "白底", "纯白")) and has_any(text, ("黑色", "黑线", "黑色手绘")),
        "default plan must retain the white background and black linework")
require("#2563eb" in lower or "蓝色" in text,
        "default plan is missing the single blue emphasis")
require(any(token in text for token in ("16:9", "16：9", "横版 16:9")),
        "default plan is missing the default 16:9 ratio")
require(not re.search(r"(?:已|已经|完成|成功).{0,8}(?:生成|产出).{0,8}(?:图片|图像|配图|插画)", text),
        "claims image generation despite the planning-only request")

emotion_words = ("夸张", "瞪", "张大", "睁大", "高挑", "惊", "焦急", "紧张", "皱眉", "眉头", "微蹙", "咬牙", "咬紧", "冒汗", "慌", "吃力", "紧抿", "认真", "自然", "放松")
action_words = ("推", "拉", "搬", "抬", "拽", "压", "按", "托", "扶", "放", "塞", "拖", "递", "装", "分拣")

require(has_any(text, emotion_words),
        "default plans lack a readable character emotion")
for index, plan in enumerate(plans, 1):
    require(has_any(plan, action_words), f"plan {index} lacks a substantive action on a core object")
    require(has_force_relation(plan), f"plan {index} lacks a local body-to-object force relation")
    require(has_effective_detail_or_contrast(plan),
            f"plan {index} lacks a detail or contrast that explains its point")
    require(has_any(plan, ("插入位置", "插入", "段落")), f"plan {index} lacks an insertion location")
    require(has_any(plan, ("唯一观点", "核心观点", "核心意思", "重点")), f"plan {index} lacks one stated idea")

require(sum(term in text for term in ("免费配送", "配送", "订单", "仓库", "加急", "快递")) >= 3,
        "plans are not grounded in the article's hidden delivery cost")
require(any(has_semantic_blue_emphasis(plan) for plan in plans),
        "default plans lack blue emphasis on a story object")
print("PASS: default planning uses expressive action and meaningful detail or contrast in both plans")
