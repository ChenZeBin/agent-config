#!/usr/bin/env python3
"""Contract regressions for the deterministic evaluation grader."""

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SKILL_ROOT = Path(__file__).resolve().parents[2]
GRADER_PATH = SKILL_ROOT / "evals/fixtures/grade_case.py"
SPEC = importlib.util.spec_from_file_location("design_macos_grade_case", GRADER_PATH)
assert SPEC is not None and SPEC.loader is not None
GRADER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GRADER)


class GraderContractTests(unittest.TestCase):
    def test_negated_or_unverified_hig_language_is_not_a_blanket_claim(self) -> None:
        responses = (
            "这不能证明原生 macOS HIG 合规；窗口、焦点和 VoiceOver 尚未验证。",
            "是否符合 HIG 仍待核验，当前离线证据不足以支持对外合规声明。",
            "不要宣称 Human Interface Guidelines compliant，需在目标系统上重新验证。",
            "“全面符合 HIG”仍应限于已审查的具体范围。",
            "若要写‘全面符合 HIG’，还需覆盖适用窗口尺寸与明暗模式并形成运行证据。",
            "要写‘全面符合 HIG’，仍需补齐实际界面状态与交互验收记录。",
        )

        for response in responses:
            with self.subTest(response=response):
                self.assertTrue(GRADER.reject_blanket_hig_claim(response))

    def test_actual_blanket_hig_claim_fails(self) -> None:
        response = "所有界面均已完成，因此该应用已经原生 macOS HIG 合规。"
        self.assertFalse(GRADER.reject_blanket_hig_claim(response))

    def test_build_only_api_fallback_answer_passes_with_real_files_and_runtime_boundary(self) -> None:
        response = """\
已修复 `Sources/GlassNotes/GlassNotes.swift`：移除了 iOS availability guard，保留
`NavigationSplitView`、语义 tint 与标准按钮 fallback。`swift build` 成功。

本次只验证了构建；运行时窗口、菜单路径、VoiceOver 和外观尚未验证，仍需人工检查。
API 结论依据离线 `evidence/apple-contract.md`，版本敏感 API 未核实。
"""
        source = """\
import SwiftUI

struct GlassNotesView: View {
    var body: some View {
        NavigationSplitView { Text(\"Notes\") } detail: {
            Button(\"New Note\") {}
                .tint(.accentColor)
        }
    }
}
"""

        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            package = workspace / "Package.swift"
            implementation = workspace / "Sources/GlassNotes/GlassNotes.swift"
            implementation.parent.mkdir(parents=True)
            package.write_text("// macOS 14 fixture\n", encoding="utf-8")
            implementation.write_text(source, encoding="utf-8")

            with (
                patch.object(GRADER, "sha256", return_value="0b3b4dd7b513a4fc3e9316d703292160efe062d74f62ae1feb1303ff94c53b34"),
                patch.object(GRADER, "run_swift_build", return_value=True),
            ):
                self.assertTrue(GRADER.grade_api_fallback(response, workspace))

    def test_review_finding_with_impact_and_smallest_correction_passes(self) -> None:
        response = """\
结论：证据覆盖有限，以下 finding 只适用于截图中的当前窗口。

严重度：high；状态：confirmed。
观察：`Sources/ReviewApp/MainView.swift` 中删除按钮在工具栏；`screenshot-notes.md`
显示当前选择为空时没有解释。推断：需运行验证菜单和键盘路径。
用户影响：用户无法判断为什么删除不可用，容易误以为操作失败。
最小修正：在空选择状态显示“选择项目后可删除”，并保持 Delete 命令的 disabled 状态同步。
验证：用键盘选择项目、通过菜单执行删除，并以 VoiceOver 和窄窗口复查反馈。
当前使用离线 apple-contract 证据；运行时平台结论仍未验证。
"""

        with patch.object(GRADER, "verify_readonly_workspace", return_value=True):
            self.assertTrue(GRADER.grade_review(response, Path("/unused-workspace")))

    def test_design_direction_accepts_compact_named_tradeoffs_and_proposed_boundary(self) -> None:
        response = """\
结论（设计提案）：推荐三栏资料台。阅读器优先利于深读却增加检索往返；
卡片画布利于探索，却损失表格密度与批处理，因此不选。
使用 WindowGroup 与 NavigationSplitView；侧边栏、Table 和 inspector 管理选择。
菜单、工具栏、键盘和拖放共享命令语义，状态只作用于活跃窗口并可撤销。
空状态提供导入；加载、错误、离线均有恢复。VoiceOver、全键盘、Reduce Motion 与
Reduce Transparency 均列入验收。冻结 apple-contract 是唯一来源，版本 API 未验证。
验证等级：Proposed；无代码、运行目标或截图，未达到 Apple-native fit accepted。
"""
        with patch.object(GRADER, "verify_readonly_workspace", return_value=True):
            self.assertTrue(GRADER.grade_design(response, Path("/unused-workspace")))

    def test_build_evidence_boundary_requires_paths_and_accepts_scoped_table(self) -> None:
        response = """\
不能发布这句话。

| 已检查 | 真正证明 | 仍无法证明 |
| --- | --- | --- |
| `evidence/build.log` | Debug 构建成功 | App 能启动或界面能正常呈现 |
| `Sources/BoundaryApp/MainView.swift` | 静态源码结构 | 实际窗口、菜单、快捷键、焦点与 VoiceOver 行为 |

可发布的表述是：“已完成 Swift Debug 构建；UI、键盘操作、VoiceOver 与 HIG
合规性尚待运行验证。”最小下一轮验证是启动 app，检查界面，走通菜单、快捷键和焦点，
再开启 VoiceOver 复查核心流程。有限证据不支持全面 HIG 合规声明。
"""
        missing_paths = response.replace("`evidence/build.log`", "构建日志").replace(
            "`Sources/BoundaryApp/MainView.swift`", "SwiftUI 源码"
        )

        with patch.object(GRADER, "verify_readonly_workspace", return_value=True):
            self.assertTrue(
                GRADER.grade_build_evidence_boundary(response, Path("/unused-workspace"))
            )
            self.assertFalse(
                GRADER.grade_build_evidence_boundary(missing_paths, Path("/unused-workspace"))
            )

    def test_quick_decision_accepts_mixed_language_window_scope(self) -> None:
        response = """\
决定：Export 移出默认工具栏，因为它是每周一次的低频动作；保留 `File > Export Selected…`。
导出严格读取当前焦点 Library window 的 selection。selection 为空时，菜单与可选工具栏按钮禁用。
开始后显示进度并阻止重复导出；目标不可用时保留选择，允许重试、换目标或取消。
最小验证：打开两个窗口并选择不同记录，检查菜单作用域、空选择禁用和失败恢复。
证据已检查：`evidence/product-brief.md`、`Sources/QuickLibrary/LibraryView.swift`；尚未运行 app。
"""
        with patch.object(GRADER, "verify_readonly_workspace", return_value=True):
            self.assertTrue(GRADER.grade_quick_export(response, Path("/unused-workspace")))

    def test_false_positive_review_needs_no_correction_when_no_finding_exists(self) -> None:
        response = """\
结论：没有已证实的 release finding，不能宣称全面 HIG 合规。
A 不成立：44pt 不是 Mac 表格硬规则。B 不成立：brand/brief.md 要求系统语义色，深绿色仅表示同步。
C 不成立：runtime.md 与 MainView.swift 显示已有 Edit > Delete、Command-Delete 和 Undo。
证据等级：源码确认上述路径；建议仅为推断。Unknown：VoiceOver、Full Keyboard Access、窄窗口和多选未测试。
发布前复测空选择、多选和窄窗口下的菜单、快捷键、工具栏禁用与 Undo。
"""
        with patch.object(GRADER, "verify_readonly_workspace", return_value=True):
            self.assertTrue(
                GRADER.grade_false_positive_review(response, Path("/unused-workspace"))
            )

    def test_false_positive_review_accepts_compact_confirmed_finding_verification(self) -> None:
        response = """\
结论：仅有一个确认 finding，不作全面 HIG 合规声明。
A 不成立：44pt 不是 Mac 表格硬规则。B 不成立：brand/brief.md 要求深绿色只表示同步。
C 不成立：runtime.md 与 MainView.swift 已有 Edit > Delete、Command-Delete 和 Undo。
证据等级：源码确认；无额外推断。Unknown：VoiceOver、Full Keyboard Access、窄窗口和多选。
用户影响：工具栏空动作会让鼠标用户误以为删除失败。最小修正：复用菜单删除 action。
验证：点击工具栏删除并由 Edit > Undo 恢复；补录菜单、键盘、VoiceOver 与窄窗口行为。
"""
        with patch.object(GRADER, "verify_readonly_workspace", return_value=True):
            self.assertTrue(
                GRADER.grade_false_positive_review(response, Path("/unused-workspace"))
            )

    def test_menubar_design_accepts_equivalent_lifecycle_phrasing(self) -> None:
        response = """\
`MenuBarExtra` 只做状态和开始/停止；主窗口管理历史，`Settings` 管理偏好。
录音由 app 级控制器拥有。开始录音是唯一首次请求麦克风权限的时机；拒绝或撤销后显示原因，
显示用户点击的“打开系统设置”按钮；不自动跳转。关闭 popover、主窗口或 Settings 只关闭界面，
状态持续显示，停止必须经明确命令。
磁盘不足时保存可用片段并允许恢复；服务离线保留待重试任务，USB 设备丢失时停止并选择设备。
重启或崩溃后恢复已落盘片段，不自动恢复录音。若坚持隐藏 Dock，可采用 agent 呈现，但发布前必须实测。
所有命令有键盘路径和 VoiceOver 标签；Reduce Motion 与 Reduce Transparency 下保留明确状态。
运行时仍待验证首次权限、关闭 popover、设备断开、崩溃恢复、键盘和 VoiceOver。
"""
        with patch.object(GRADER, "verify_readonly_workspace", return_value=True):
            self.assertTrue(GRADER.grade_menubar(response, Path("/unused-workspace")))

    def test_apple_native_design_gate_requires_runtime_acceptance_artifacts(self) -> None:
        response = """\
结论：当前最高等级是 Proposed，不能写“Apple 原生感已经验证，可以发布”。

Apple 参照原型选择 Finder 的侧边栏与列表窗口。Adopt：沿用系统窗口、表格比较和菜单命令；
改造：按财务任务增加账户层级与异常检查器；Avoid：不复制 Finder 的像素、图标资产和固定尺寸。

运行截图矩阵全部 pending。Evidence source: actual launched `.app` only；Figma 或 SwiftUI Preview 不能算运行截图证据。
| Window | Width | Appearance | Activation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| main | minimum | light | active | no runnable target | pending |
| main | minimum | dark | active | no runnable target | pending |
| main | default | light | active | none | pending |
| main | default | dark | active | none | pending |
| main | wide | light | active | none | pending |
| main | wide | dark | active | none | pending |
| main | default | light | inactive | none | pending |
| main | default | dark | inactive | none | pending |

交互记录按“路径/命令 → 输入 → 预期 → 实际 → 证据路径 → 状态”填写。待运行项包括菜单与工具栏等价路径、
键盘与焦点、窗口缩放与恢复、Undo/错误恢复。没有实际观察结果前不能完成原生感验收。
"""
        incomplete = response.replace("minimum", "unspecified").replace(
            "wide", "unspecified"
        )

        with patch.object(GRADER, "verify_readonly_workspace", return_value=True):
            self.assertTrue(
                GRADER.grade_apple_native_completion_gate(response, Path("/unused-workspace"))
            )
            self.assertFalse(
                GRADER.grade_apple_native_completion_gate(incomplete, Path("/unused-workspace"))
            )

    def test_apple_native_design_gate_rejects_merged_interaction_fields(self) -> None:
        response = """\
结论：Proposed，不能写“Apple 原生感已经验证，可以发布”。
Finder 参照：采用系统侧边栏；调整为账户表格；避免复制像素和私有资产。
运行截图只接受实际启动的 `.app`，没有可启动目标时全部 pending。
最低可用、默认、宽窗口 × 浅色、深色；默认宽度另含活动、非活动状态。
菜单和工具栏、键盘与焦点、缩放、恢复及撤销均待运行。
| 路径 | 预期 | 观察/证据/状态 |
| --- | --- | --- |
| 搜索 | 聚焦搜索 | 未运行/无/pending |
"""
        with patch.object(GRADER, "verify_readonly_workspace", return_value=True):
            self.assertFalse(
                GRADER.grade_apple_native_completion_gate(response, Path("/unused-workspace"))
            )

    def test_apple_native_review_rejects_incomplete_gate_evidence(self) -> None:
        response = """\
结论：不能批准，Apple-native fit 未通过，当前最多是 build-verified、runtime pending。

已检查 `evidence/reference-map.md`、`evidence/screenshot-manifest.md`、
`evidence/interaction-notes.md` 和 `evidence/build.log`。

- 参照：版本、日期、来源均未记录，采用、适配、不复制的边界也缺少。
- 截图：清单中的 PNG 未提供；缺少最小/窄与 wide/宽窗口、非活动 inactive 状态，
  也缺 build 标识、macOS 版本、窗口尺寸、显示缩放和数据状态。
- 交互：一次工具栏点击不能覆盖菜单、快捷键、焦点、窗口缩放与恢复、Undo 和多窗口作用域。

构建成功不能证明视觉或交互。最小下一轮验证：补齐可追溯参照，启动同一 build 采集完整矩阵，
再按预期/实际/证据记录执行菜单、键盘、焦点、缩放恢复、撤销与多窗口路径。
"""
        missing_paths = response.replace("`evidence/interaction-notes.md`", "交互笔记")

        with patch.object(GRADER, "verify_readonly_workspace", return_value=True):
            self.assertTrue(
                GRADER.grade_apple_native_fit_review(response, Path("/unused-workspace"))
            )
            self.assertFalse(
                GRADER.grade_apple_native_fit_review(missing_paths, Path("/unused-workspace"))
            )

    def test_translation_accepts_figma_header_quiet_visual_mapping_and_unmodified_boundary(self) -> None:
        response = """\
结论：保留研究任务意图，不搬运手机结构；未修改 Figma。
| Figma 元素 | macOS 原生结构与取舍 |
| --- | --- |
| 底部 tab | 替换为 WindowGroup、NavigationSplitView 侧边栏与工具栏搜索 |
| 逐屏 push | 映射为列表、详情和 inspector |
| 底部 sheet | 多选后用检查器，窄窗 fallback 为标准 sheet |
| 左滑删除 | 替换为菜单、右键、工具栏和键盘，支持 Undo |
丢弃 44pt、safe area、固定像素和移动端底栏。窗口、菜单和快捷键作用于活跃窗口。
空状态、加载、错误、离线及 VoiceOver、全键盘、Reduce Motion 均有恢复路径。
视觉保持安静、可信和高可读性，使用系统层级，避免全内容玻璃。
macOS 14 API availability 未验证；使用标准控件 fallback。
"""
        with patch.object(GRADER, "verify_readonly_workspace", return_value=True):
            self.assertTrue(GRADER.grade_translate(response, Path("/unused-workspace")))


if __name__ == "__main__":
    unittest.main()
