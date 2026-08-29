# 冻结的一方证据包

评测日期：2026-08-16。主对照实验为离线、可复现轨道；不得联网。下列内容是评测方从 Apple 一方页面冻结的窄结论，
只可支持对应范围。未包含的版本/API/HIG 主张必须标为“未验证”，并说明如何在发布前核实。

| 来源 | 冻结结论 |
| --- | --- |
| https://developer.apple.com/design/human-interface-guidelines/designing-for-macos/ | Mac 体验应利用可调整窗口、键盘与高精度指针，并针对更大的显示空间减少不必要的层级和模态。 |
| https://developer.apple.com/design/human-interface-guidelines/menus | 菜单是持久、可发现的命令入口；命令可用性与当前窗口/选择状态应一致。上下文菜单不能成为重要操作的唯一入口。 |
| https://developer.apple.com/design/human-interface-guidelines/toolbars | 工具栏适合高频动作，但隐藏、溢出或定制工具栏后，重要命令仍应有可发现路径。 |
| https://developer.apple.com/design/human-interface-guidelines/materials | 材质不能损害内容可读性；需要在浅色、深色、Increased Contrast 与 Reduce Transparency 下保持层级和操作。Liquid Glass 不等于给整个内容层加玻璃。 |
| https://developer.apple.com/design/human-interface-guidelines/accessibility/ | 关键任务需要键盘与 VoiceOver 路径，并尊重 Reduce Motion、Reduce Transparency、对比度、文本扩展与本地化。 |
| https://developer.apple.com/documentation/swiftui/windowgroup | `WindowGroup` 可创建同结构的多个窗口；窗口级选择、搜索与呈现状态不应意外由一个全局对象共享。 |
| https://developer.apple.com/documentation/swiftui/navigationsplitview | `NavigationSplitView` 是 Mac 侧边栏/内容/详情结构的原生起点之一；具体列数和折叠策略取决于任务与窗口宽度。 |
| https://developer.apple.com/documentation/swiftui/menubarextra | `MenuBarExtra` 适合持续可达的菜单栏功能，但不自动替代复杂历史、设置或主窗口；持续任务的生命周期不应依附于 popover 是否打开。 |

评测专用版本事实：

- 两个实现 fixture 的 deployment floor 分别是 macOS 14；当前 runner 使用 Apple Swift 6.0 / macOS 15 SDK。
- 当前 runner 无法编译 `glassEffect()`。对 macOS 14/15 目标，保留该调用必须有真实可编译的 macOS availability 和功能 fallback；无法核实时，最安全的修复是保留标准按钮并移除不可靠视觉调用。
- Mac 不存在“所有表格行必须至少 44pt”这一冻结规则；44pt 触控目标不能直接当作桌面缺陷判据。
- React、Tailwind、ARIA、CSS `backdrop-filter` 可以按 Web/桌面壳标准审查，但不能证明 AppKit/SwiftUI 原生 HIG 合规。
