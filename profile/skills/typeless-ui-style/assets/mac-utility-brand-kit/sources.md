> 历史设计提案，尚未确认品牌；不是 Typeless 实测或当前平台要求的验证结果。请先读 Skill 的 `references/mac-utility-brand-kit.md`。

# 网上方案与证据

检索日期：2026-09-19。Exa 搜索发现来源，Apple HIG 正文通过 Jina 实时读取；web 工具读取 Icon Composer、Rogue Amoeba 和 Sindre Sorhus 原页。以下均为第一方来源；设计取舍是本方案判断，不声称案例公司公开了同一套内部设计系统。

| 来源 | 实际读取与依据 | 本方案采用 |
|---|---|---|
| [Apple Branding](https://developer.apple.com/design/human-interface-guidelines/branding) | live；页内更新日期 2026-09-09；品牌色克制、熟悉组件、品牌让位内容，避免反复展示 Logo | 把品牌集中在图标、官网、关于页和语言风格 |
| [Apple App icons](https://developer.apple.com/design/human-interface-guidelines/app-icons) | live；页内更新日期 2026-06-08；清晰简单的形状、未蒙版分层素材、外观间保持核心图形一致，macOS 布局 1024×1024 | SVG 保留可编辑；发布另做平台素材，不把圆角预览当发布文件 |
| [Icon Composer](https://developer.apple.com/icon-composer/) | live；支持图层、Default/Dark/Mono 注解及 Xcode 集成 | 一套几何母版适配多种系统外观 |
| [Apple Design Resources](https://developer.apple.com/design/resources/) | 搜索结果核实有当前平台模板；未下载模板 | 发布时取当前模板，不手画平台蒙版 |
| [Rogue Amoeba 图标演变](https://weblog.rogueamoeba.com/2023/09/30/rogue-amoeba-icon-timeline/) | live；文章日期 2023-09-30；作者说明从细节丰富走向简单形状、鲜明色彩，并保留个性 | 家族一致，同时保留工具自身识别性；历史案例不作为当前平台要求 |
| [Sindre Sorhus 应用目录](https://sindresorhus.com/apps) | live；目录列出多个单一用途工具，并集中提供分类、FAQ、支持和旧版入口 | 用统一发行者、网站、支持入口组织产品组合；未推断其销量和团队成本 |
| [Things 设计说明](https://culturedcode.com/things/features/) | live；描述渐进展示细节、键盘和多窗口功能 | 学习内容优先和按需展开，不复制其界面 |

比较：完全统一 Logo 换色，生产快但难区分；完全独立品牌，表现力强但维护多套素材；本方案推荐母品牌背书＋家族化产品图标，在复用与辨识之间取得平衡。该比较是设计判断，无转化率实验数据。

访问边界：web 直接读取两个 HIG 页面只得到 JavaScript 提示，Jina 已取得完整标题、正文及更新日志。Panic 首页抓取只得到游戏清单，未以此证明其 Mac 产品视觉规则。未进行用户访谈或商标相似性检索。
