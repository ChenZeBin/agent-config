# `design-macos-apps` Skill 效果评测

评测日期：2026-08-16  
关联会话：`01a00635-fa83-7041-aefd-afd0a5549853`

## 结论先行

当前证据支持一个有限结论：`design-macos-apps` 能提高若干可明确检查的流程与交付约束，尤其是设计方向完整性、审阅证据分级和原生 Mac 边界；但尚不能证明它稳定提升最终设计质量。

- 冻结的 6-case core 对照中，target 为 **6/6**，同轮 no-skill 为 **4/6**；冻结 EHMO 上游 comparator 在独立同配置运行中为 **5/6**。
- 4-case 独立语义 judge 单次运行中，target 为 **4/4**，no-skill 为 **1/4**。
- 但在两个高风险 case 上各复跑 3 次后，两臂的语义 criterion 总分都是 **31/36（86.1%）**；target case PASS 为 **4/6**，no-skill 为 **5/6**。单次优势没有稳定复现。
- target 的代价明显更高：core 对照平均每 case 时间增加约 **32%**、token 增加约 **153%**；稳定性子集平均每轮时间增加 **44.8%**、token 为 no-skill 的约 **2.20 倍**。
- 实现 case 能证明 fixture 保持 macOS 14 deployment 且真实 `swift build` 成功；没有 launch、窗口交互、VoiceOver 或视觉运行态证据。
- 现有 `validate_spec.py` 有确定的高风险假阳性：原封不动的空白模板在 default 和 `--strict` 下都 PASS。

因此，当前发布判断应是：**适合作为 beta 级流程护栏，不应宣称已证明设计质量增益，也不应以 validator PASS 代表完成或 HIG 合规。**

## 原会话总结

原会话完成了四类工作：

1. 收集并固定原生 macOS 设计、SwiftUI/AppKit、窗口/命令、可访问性和平台证据，保留 Git 与来源谱系。
2. 综合为 `design-macos-apps`：按 design、review、translate、implement 四种模式路由，并加入证据分级、deployment/API fallback、原生边界和验证报告要求。
3. 安装模板、参考资料与 `validate_spec.py`，并做文件、链接、frontmatter 和供应链完整性检查。
4. 运行三个单轮 forward demonstration：utility 设计、iOS→Mac 翻译、proposal review。

前三个 forward 输出能证明 Skill 被触发、能按预期组织内容，并且多数情况下会声明没有运行态证据；它们不能证明 Skill 相对 no-skill 更好，也不能证明实际 UI、API availability、焦点、窗口恢复或 VoiceOver 正确：

| Forward demo | 可支持的证据 | 不能支持的结论 |
| --- | --- | --- |
| utility design | 中等流程证据：模式、方向、scene/command/state/a11y/验证计划 | UI 或架构已在真实产品中正确 |
| iOS→Mac translate | 中等偏低结构证据：能丢弃 bottom tabs、swipe、bottom sheet、44pt 等移动壳 | 对真实 Figma/source frame 的翻译已验收 |
| proposal review | 中等审阅纪律证据：区分提案事实、推断风险与待运行验证 | proposal 中的问题已成为实际 app 的 confirmed runtime defect |

这也是本轮新增 A/B、上游 comparator、独立 judge、重复试验和 validator 回归的原因。

## 评测设计

### 三个比较臂

- **Target**：当前 `design-macos-apps`。
- **No-skill**：相同模型、prompt、fixture、预算，不安装 target。
- **Upstream**：EHMO `macos-design-guidelines`，固定 commit `dc2be825d8b439caea78e9eaa8fb3ac23b0ff3e9`；只包含 `SKILL.md`、`AGENTS.md`、`rules/_sections.md`。

主 runner 为 `openai/gpt-5.6-terra`；语义 judge 为独立的 `openai/gpt-5.6-sol`，judge 上下文中会移除被测 Skill。

### 隔离与污染控制

最初发现全局安装的 target 会被 nominal `without_skill` 分支主动发现并读取，因此该次运行被判定为污染并排除。有效运行都使用临时、权限为 `700` 的干净 `CODEX_HOME`，只链接现有登录凭据，不含用户安装的 Skills。系统 Skills 对所有臂保持一致。

主轨道离线运行，统一使用冻结证据：

- [`apple-contract.md`](/Users/example/.codex/skills/design-macos-apps/evals/fixtures/offline/evidence/apple-contract.md)
- SHA-256：`e0443b9a1b29cc279c6382a419b34a3fb5d410717ea6dbdfdc450f0d2b6109ee`

曾尝试 live Apple source 轨道，但 `developer.apple.com` DNS 解析失败并导致 stream 中断；该结果只算基础设施失败，不计入 Skill 质量。

### 判分层

1. **确定性 gate**：fixture 全工作树不变、deployment 保持、错误 iOS guard 移除、真实 `swift build`、必要结构与证据边界。
2. **独立语义 judge**：任务适配、证据校准、假阳性、取舍与最小修正；不以文章长度为直接分数。
3. **运行态 gate**：本轮只做到 build。窗口、菜单 scope、焦点、resize、appearance、VoiceOver 等仍需独立 UI/runtime 轨道。

10 个确定性 case 覆盖：研究资料库设计方向、只读证据审阅、多窗口状态与命令、iPhone→Mac 翻译、Electron 原生边界、纯 Swift 负向路由、Liquid Glass/品牌边界、API availability/fallback、审阅假阳性、MenuBarExtra 权限与恢复。

## 结果

### 1. 冻结 core：target vs no-skill

| Case | Target | No-skill |
| --- | ---: | ---: |
| 研究资料库设计方向 | PASS | FAIL |
| 只读 evidence-gated review | PASS | FAIL |
| 多窗口独立选择与命令 | PASS | PASS |
| iPhone Figma 意图→Mac | PASS | PASS |
| Electron/Tauri 原生边界 | PASS | PASS |
| 纯 Swift 负向路由 | PASS | PASS |
| **合计** | **6/6** | **4/6** |

同轮资源：

| 指标（每 case 均值） | Target | No-skill | 差异 |
| --- | ---: | ---: | ---: |
| 耗时 | 57.54 s | 43.65 s | +13.89 s / +31.8% |
| tokens | 279,026 | 110,168 | +168,858 / +153.3% |

target 在该轮的主要可观察优势是 design/review contract 完整度；implementation、translation、boundary 和纯 Swift 负向路由没有拉开 case-level 差异。

证据：[core HTML report](/Users/example/.codex/skills/design-macos-apps-target-core-final-workspace/iteration-1/report.html) · [core benchmark JSON](/Users/example/.codex/skills/design-macos-apps-target-core-final-workspace/iteration-1/benchmark.json)

### 2. 冻结上游 comparator

| 比较 | Skill 臂 | 同轮 no-skill |
| --- | ---: | ---: |
| EHMO upstream core | 5/6 | 3/6 |

EHMO 唯一失败是 review case 缺少足够具体的最小修正。target 的 6/6 与 upstream 的 5/6 是两个独立随机运行，只能描述，不能把 1 个 case 差直接解释为因果优势。

资源均值：upstream 46.49 s / 176,741 tokens；同轮 no-skill 41.91 s / 123,274 tokens。target 比 upstream 更重，但二者没有做成同一随机 trial 内的三臂配对。

证据：[upstream HTML report](/Users/example/.codex/skills/design-macos-apps-upstream-workspace/iteration-1/report.html) · [upstream benchmark JSON](/Users/example/.codex/skills/design-macos-apps-upstream-workspace/iteration-1/benchmark.json)

### 3. 独立语义 judge：单次与稳定性

单次 4-case 结果：

| Arm | Case PASS | Criterion pass |
| --- | ---: | ---: |
| Target | 4/4 | 24/24（100%） |
| No-skill | 1/4 | 18/24（75%） |

证据：[semantic one-shot HTML](/Users/example/.codex/skills/design-macos-apps-semantic-workspace/iteration-1/report.html) · [benchmark JSON](/Users/example/.codex/skills/design-macos-apps-semantic-workspace/iteration-1/benchmark.json)

为避免把一次性完整答案误当增益，对 research-direction 与 false-positive review 各复跑 3 次：

| 子集（三轮） | Target | No-skill |
| --- | ---: | ---: |
| Criterion pass | 31/36（86.1%） | 31/36（86.1%） |
| Case PASS | 4/6（66.7%） | 5/6（83.3%） |
| 每轮平均耗时 | 102.42 s | 70.75 s |
| 每轮平均 tokens | 354,316 | 161,047 |

稳定项是 false-positive review：target 3/3 且 18/18 criteria，no-skill 3/3 且 17/18。波动来源是 research-direction：target 1/3 case PASS、criteria 13/18；no-skill 2/3、criteria 14/18。target 的常见缺口是窗口级与共享状态边界，另有一次漏关键状态/无障碍，一次漏证据边界。

三轮报告：[iteration 1](/Users/example/.codex/skills/design-macos-apps-semantic-stability-workspace/iteration-1/report.html) · [iteration 2](/Users/example/.codex/skills/design-macos-apps-semantic-stability-workspace/iteration-2/report.html) · [iteration 3](/Users/example/.codex/skills/design-macos-apps-semantic-stability-workspace/iteration-3/report.html)

这组重复结果推翻了“单次 4/4 vs 1/4 足以证明稳定提升”的解释。

### 4. 实现与 API fallback

- core 多窗口实现：两臂都保持 macOS 14 并通过真实 `swift build`。
- API fallback 最终 artifact：两臂都移除错误的 `#available(iOS...)`，保留 `NavigationSplitView`、语义 tint、标准按钮、macOS 14 deployment，未引入 AppKit，并通过真实 `swift build`。
- target 的 API artifact 首次被旧 grader 以“来源或未验证”漏词拒绝；输出实际写有“冻结的 Apple 证据”。中立扩展该来源模式后，直接重放现有两臂 artifact，均为 **9/9 + build PASS**。没有重新生成回答。

重判记录：[API fallback artifact regrade](/Users/example/.codex/skills/design-macos-apps/evals/results/2026-08-16-api-regrade.md)

这证明了代码 fixture 的最低构建与边界约束，不证明实际点击行为、视觉层级或辅助技术行为。

### 5. Validator 回归

[`test_validator_contract.py`](/Users/example/.codex/skills/design-macos-apps/evals/regressions/test_validator_contract.py) 有三个 contract：

| 输入/模式 | 预期 | 实际 |
| --- | ---: | ---: |
| 原模板 + `--template` | PASS | PASS |
| 原模板 + default | FAIL | **PASS** |
| 原模板 + `--strict` | FAIL | **PASS** |

原因是模板自身已经包含全部标题、Apple URL、日期、`unverified`、`availability` 与 `fallback`，而 `[Text]`、`[Target]` 等未被识别为未填写占位符。`--strict` 只把 warning 提升为失败，不增加语义或完成度检查。

因此，validator 目前只能当结构 lint，不能当设计规范完成、证据闭合或 HIG 合规证明。

## 失败模式与限制

1. **确定性 grader 仍可被词袋答案绕过。** 本轮已针对真实假阴性做中立校准，并用独立 judge 补位，但结构关键词不等于关系、因果和正确取舍。
2. **语义 judge 自身有方差。** 相同 prompt/model 的 research case 出现 50%–100% criterion 波动；必须报告重复试验，不能 cherry-pick。
3. **没有真人 Mac 专家盲评。** 独立模型 judge 不能替代资深产品设计、AppKit/SwiftUI 工程和可访问性评审。
4. **没有 runtime UI 证据。** build 不覆盖窗口激活、active-window command scope、恢复、resize、focus、键盘、VoiceOver、Reduce Motion/Transparency 或视觉品质。
5. **主轨道是冻结证据。** 它适合因果对照，不验证 Apple 文档与 SDK 的实时 freshness；live-source 轨道本次因网络失败未完成。
6. **成本显著。** Skill 经常生成更完整但更长的路径；当前没有证据表明额外 token 在重复语义评分上得到稳定回报。
7. **样本仍小。** core 只有 6 个共同 case；语义稳定性只有 2 个 case × 3 次。不能推断到全部 Mac app archetype。
8. **安全摩擦。** 个别被测 agent 尝试对显式临时 build cache 执行递归清理，被执行策略拒绝；未删除用户数据，但应减少不必要的清理动作。

## 下一轮发布门槛

建议在声称 Skill “有效”前完成：

1. 修复 blank-template validator 假阳性；默认/strict 必须拒绝未填模板，并加入 headings+filler 反例与一个最小 valid fixture。
2. 把确定性输出改为结构化 schema：claim、evidence level、source/retrieval、platform/version、state owner、fallback、verification status；脚本只检查可确定的完整性。
3. 将 core 扩到至少 12–16 个冻结 case，每 case 3–5 次，包含 document、utility、menu bar、multiwindow、custom chrome、brand conflict、无 source、Web/Catalyst 边界和对抗样本。
4. 加入真实 Xcode/UI 轨道：build、launch、窗口 resize/restore、菜单/快捷键 scope、focus、VoiceOver、appearance、localization；实现模式声称完成时必须提供运行证据。
5. 做配对盲评：target、no-skill、upstream 使用相同 prompt、fixture、model、预算、顺序随机；至少两名 Mac 专家，报告一致率。
6. 报告 matched effect 与成本：per-case delta、hard-violation rate、unsupported-claim rate、false-confidence rate、unnecessary-action rate、时间与 tokens；用 paired bootstrap CI 或 exact McNemar，而不是只报平均文案分。
7. 优先压缩 Skill：删除重复说明，增强经常遗漏的 window/shared-state、关键状态和 evidence-boundary gate。目标是在不降低 hard-gate 通过率的前提下，将 token overhead 控制到 50% 以下。

建议硬门槛：任何未证实的 Must/API availability、错误平台 guard、review 未授权写入、implement 声称完成但无 build/run 证据，都直接 FAIL；视觉偏好和可选审美不得升格为 HIG defect。

## 可复跑资产

- [评测说明与命令](/Users/example/.codex/skills/design-macos-apps/evals/README.md)
- [确定性配置](/Users/example/.codex/skills/design-macos-apps/evals/eval.yaml)
- [语义配置](/Users/example/.codex/skills/design-macos-apps/evals/eval-semantic.yaml)
- [上游配置](/Users/example/.codex/skills/design-macos-apps/evals/eval-upstream.yaml)
- [确定性 grader](/Users/example/.codex/skills/design-macos-apps/evals/fixtures/grade_case.py)
- [validator 回归](/Users/example/.codex/skills/design-macos-apps/evals/regressions/test_validator_contract.py)

本轮只新增/修改 `evals/` 下的评测资产，没有修改 target `SKILL.md`、模板或 validator 实现。
