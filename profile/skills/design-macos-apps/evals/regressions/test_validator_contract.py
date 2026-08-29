#!/usr/bin/env python3
"""Contract regression for the spec validator's template/completed-spec modes."""

from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parents[2]
VALIDATOR = SKILL_ROOT / "scripts/validate_spec.py"
TEMPLATE = SKILL_ROOT / "assets/macos-design-spec-template.md"


def validate(path: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["python3", str(VALIDATOR), *arguments, str(path)],
        text=True,
        capture_output=True,
        check=False,
    )


class ValidatorContractTests(unittest.TestCase):
    def test_template_mode_accepts_the_template(self) -> None:
        result = validate(TEMPLATE, "--template")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_default_mode_rejects_the_blank_template(self) -> None:
        default_mode = validate(TEMPLATE)
        self.assertNotEqual(
            default_mode.returncode,
            0,
            "an untouched template must not pass completed-spec validation\n"
            + default_mode.stdout
            + default_mode.stderr,
        )

    def test_strict_mode_rejects_the_blank_template(self) -> None:
        strict_mode = validate(TEMPLATE, "--strict")
        self.assertNotEqual(
            strict_mode.returncode,
            0,
            "an untouched template must not pass strict completed-spec validation\n"
            + strict_mode.stdout
            + strict_mode.stderr,
        )

    def test_rejects_headings_with_filler_only(self) -> None:
        headings = """# macOS Design Specification

## Context and assumptions
TBD
## Product intent
TBD
## Apple reference prototype
TBD
## Platform contract
TBD
## Scene and window model
TBD
## Information architecture
TBD
## Commands and input
TBD
## Surface specifications
TBD
## Visual system
TBD
## Motion and feedback
TBD
## Accessibility and localization
TBD
## SwiftUI/AppKit mapping
TBD
## States and edge cases
TBD
## Runtime screenshot matrix
TBD
## Interaction verification record
TBD
## Verification plan
TBD
## Sources and open risks
TBD
"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "filler.md"
            path.write_text(headings, encoding="utf-8")
            result = validate(path)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Unresolved filler", result.stdout)

    def test_accepts_a_substantive_chinese_spec(self) -> None:
        spec = """# macOS 研究资料库设计规范

更新时间：2026-08-16

## 背景与假设
这是一个面向研究人员的原生 macOS 资料库。当前证据来自产品简报与现有 SwiftUI 场景；尚无运行截图，运行行为将在实现后验证。

## 产品意图
主要任务是高频检索、比较元数据并批量标注资料。设计主张是用可调整的资料库窗口减少层级，同时保留安静可信的品牌表达。

## Apple 参照原型
以当前 macOS 的 Finder 列表浏览窗口作为最近的任务原型，只采用可调整侧边栏、表格比较和窗口级选择行为；研究元数据检查器按本产品适配，不复制图标、尺寸、资源或装饰。当前原型版本和截图仍需在实现前核实。

## 平台契约
窗口、菜单与键盘模型参考 Apple 当前 macOS 指南，来源：https://developer.apple.com/design/human-interface-guidelines/designing-for-macos/ ，检索日期 2026-08-16。结论仅适用于本规范描述的窗口和命令行为。

## 场景与窗口模型
主资料库使用可创建多个实例的窗口组。资料数据由应用共享，选择、搜索、栏宽和检查器显隐由每个窗口独立拥有并按窗口恢复。

## 信息架构
侧边栏承载研究主题，中栏显示可多选的资料表格，右侧检查器编辑当前选择。搜索范围和筛选状态始终可见且可清除。

## 命令与输入
导入、删除和批量标注拥有一致动作语义。菜单栏提供完整发现路径，工具栏承载高频动作，键盘命令作用于当前焦点窗口并支持撤销。

## 界面规格
默认状态展示真实标题、来源和日期。空状态提供导入入口；离线状态保留本地阅读；导入失败逐项说明原因并允许重试。

## 视觉系统
使用系统语义背景、文字、选择与分隔角色。深绿色只表达已同步状态；颜色之外同时使用文字或符号，避免把品牌色铺满所有图标。

## 动效与反馈
选择和键盘命令保持即时，导入显示标准进度反馈。减弱动态时取消非必要位移，但继续保留状态变化、焦点移动和错误信息。

## 无障碍与本地化
所有核心任务可由键盘完成，焦点环和返回位置可预测。VoiceOver 朗读名称、选择数量和错误状态；长文本、本地化扩展和不同外观均需验证。

## SwiftUI 与 AppKit 映射
优先使用 WindowGroup、NavigationSplitView、Table、Commands 与 searchable。应用模型保持共享，窗口展示状态留在场景边界；当前没有已确认的 AppKit 缺口。

## 状态与边界情况
覆盖空资料库、导入中、部分失败、离线、只读、批量选择和删除恢复。每个状态都定义触发条件、可见反馈、下一步动作与验证方式。

## 运行截图矩阵
真实应用启动后必须采集最小、默认、宽窗口在浅色与深色下的六个单元，并补充默认宽度的活动与非活动窗口。当前均为 pending，不使用 Figma 或 Preview 冒充运行证据。

## 交互验证记录
实现后记录菜单、工具栏、键盘、焦点、窗口缩放与恢复、撤销和拖放路径的预期与实际结果，并附日志、录像或 UI test 路径。当前没有可启动目标，因此所有行均明确 pending。

## 验证计划
先构建目标并渲染真实样本，再启动应用检查两个窗口的独立选择、菜单命令范围、缩放恢复、键盘焦点和撤销。VoiceOver 与显示偏好保留为明确的人工检查。

## 来源与开放风险
Apple macOS 指南于 2026-08-16 检索。部署版本内的具体 API 签名仍需用实际 SDK 核实；在此之前使用稳定系统容器，不引入版本敏感视觉效果。
"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "valid-zh.md"
            path.write_text(spec, encoding="utf-8")
            result = validate(path)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
