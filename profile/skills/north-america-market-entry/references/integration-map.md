# 融合来源与适用边界

本 Skill 的市场进入主流程为本机自有内容：`agent-config` 的 `5777cc8278afe0226035cabfd95bbb76af95b03b` 提交首次发布该 Skill，提交作者与当前仓库 `user.name` 均为 `ChenZeBin`，依赖记录原标为 `local-authored-snapshot`。因此本次更新原 Skill；用户提出的“若非自写则新建”条件未触发。此处只记录可核验的本机来源，不证明互联网中不存在更早的相似文本。

以下三份 MIT Skill 仅提供方法线索；正文由本地重新组织撰写，没有引入原文、示例或资产。外部版本固定为检索当时的 commit；其通用建议仍须接受当次国家、品类和 Apple 官方来源核验。

| 固定来源 | 本 Skill 吸收的能力 | 明确未照搬 |
| --- | --- | --- |
| [US Business English](https://github.com/jezweb/claude-skills/blob/176df0f01dfb629fb5f0db144d2e4aa76931d862/plugins/writing/skills/us-business-english/SKILL.md)，MIT | `en-US` 拼写、清楚直接的语气、减少生硬商务套话；在第 4 步应用到产品与营销文案 | 邮件称呼、落款、固定“禁用词”不直接套用到 App UI；不把美国语气等同加拿大英语或墨西哥西语 |
| [Localization Design](https://github.com/owl-listener/designer-skills/blob/9a6930cf84a822eb458624bd11c61aac5bbdf224/design-systems/skills/localization-design/SKILL.md)，MIT | 文本伸缩、地区格式、文化符号与伪本地化测试；在第 5 步转为 Mac 界面检查 | CSS 和网页布局实现、未经目标用户验证的颜色文化表不套用到 SwiftUI/AppKit |
| [App Store Localization](https://github.com/appeeky/aso-skills/blob/8de1ee18d8971723ac49320f01c574b8972ed1a5/skills/localization/SKILL.md)，MIT | 按地区重新研究搜索词、竞品、截图及上架后指标；在第 6 步用于 Mac App Store 素材 | iPhone 专属字段/截图假设、固定市场分层和无来源的收入提升预测不作为 Mac 结论 |

发布前仍须分别通过：美国 `en-US` 文案与 Mac 体验核验；加拿大 `en-CA`、适用的 `fr-CA` 与魁北克要求核验；墨西哥 `es-MX` 搜索用语与商店展示核验。语言、法律和收入不是由上述 Skill 本身证明的。
