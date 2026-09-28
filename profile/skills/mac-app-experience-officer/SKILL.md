---
name: mac-app-experience-officer
description: 每次端到端测试之后，使用 Harness 以用户目标走查实际界面、记录可回放操作和体验阻力；以 macOS App 为主，也支持 Web App 与 iOS Simulator。无法运行实际界面时报告阻塞。
---

# Mac App 体验官

用 Harness 操作**实际运行的构建产物**，观察一个用户能否理解并完成目标。功能测试结果与体验走查结果分开报告。此 Skill 不自动修改 App、不替代真人研究，也不把模拟体验说成真实用户反馈。

## 何时开始

- 每次任务需要端到端测试：先完成该测试，再走查实际界面。测试失败时若界面仍可操作，照常走查可达路径，并标清功能失败对观察范围的影响。
- 用户单独要求体验审查：可直接开始，不必额外制造一轮端到端测试。
- 先定位测试对象和可运行入口：macOS 的 `.app`、Web URL，或 iOS Simulator 中的 App，并核对版本、运行环境和用户目标。找不到可运行界面或缺少必需权限时，记录阻塞，不能改看源码或静态截图后声称已经体验；说明须修复环境后才能继续走查。

## 连接 Harness

1. 核对 `$HOME/Applications/Harness.app` 或实际安装路径，以及 `harness-mcp` 是否可用。优先使用已连接的 Harness MCP；本机常见二进制为 `$HOME/.local/bin/harness-mcp`。用 `harness-mcp --version` 核对版本；当前验证版本为 `0.8.4`，升级后重新核对工具契约。
2. 自主测试可通过 MCP 的 `list_personas`、`list_applications`、`create_application`、`start_run`、`get_run_status`、`get_run_result` 和 `get_step_screenshot` 操作。依据实际工具 schema 填参，不猜测字段。Harness GUI 也可选择 `.app`、persona 和 goal 发起运行。
3. 如未配置 Harness 支持的模型密钥，可用 MCP 的 `start_ui_session` → `observe_ui` → `act_ui` → `end_ui_session` 逐步操作目标界面；这一模式不需要 Harness 自身的模型密钥，但 AI 仍须阅读真实画面并自己决策。用 `artifact_dir` 保存干净截图和 `steps.jsonl`。MCP 不可用时，若当前智能体具备原生界面操作工具，可通过它操作 Harness GUI 并保留同等证据；否则报告尚未执行。
4. macOS 首次操作可能需要 Screen Recording 和 Accessibility 权限；iOS Simulator 会话需要 Xcode 与 WebDriverAgent；Web 会话使用 Harness 的 WebKit 环境。按实际平台核对依赖和权限，仅有配置或空白截图不能视为已授权。不要替用户读取或配置模型密钥。测试数据、账号和可能对外发送的内容遵循当前任务授权。

## 走查方法

- 选一个明确的用户角色与任务目标；例如首次使用者从启动开始完成一项核心任务。大型 App 可增加熟练用户或异常恢复角色，但不为凑数量扩大范围。
- 开始操作前，先从界面理解产品。已有源码、README 或实现知识只用于事后诊断，不替用户补全界面没有说清的意思。
- 按用户可见入口执行，观察首次启动、权限、发现入口、反馈、等待、错误恢复和结果确认中与本次目标相关的部分。每次行动后确认界面实际状态。不能把模型点错、权限未授予或测试数据缺失直接判为产品缺陷。
- 保留运行 ID、目标、角色、App 版本、步骤记录与关键截图。每个体验问题写清：用户目标、发生步骤、可见证据、影响、复现条件与建议；将观察事实、推断和偏好分开。无法复现的问题标为待核验。
- 交付时明确写出实际采用或准备采用的 Harness 方式：自主运行，或 `start_ui_session` → `observe_ui` → `act_ui` → `end_ui_session` 逐步 UI 会话；说明步骤记录和关键截图的位置。走查受阻时也需写明拟用方式，但不得把计划说成已执行。
- 结果至少区分：目标完成/未完成/阻塞、实际路径、体验阻力、未覆盖范围。体验结论不能覆盖已有端到端测试的通过或失败状态；需要修复时回到项目原有验收流程。
- 若因 App 无法启动或权限不足而阻塞，交付结论须明确写出恢复步骤：先修复启动或授予权限，重新启动可运行构建后，再执行 Harness 走查；在此之前保持“未完成”，不宣称体验通过。

官方工具说明：[Harness](https://github.com/awizemann/harness) · [HarnessMCP](https://github.com/awizemann/harness/blob/main/HarnessMCP/README.md)。
