# Dembrandt 方法迁移与代码证据

只迁移取证、归类、保留来源和差异验收方法。没有安装、执行 Dembrandt，也没有加入 MCP、云同步或账号。以下为原创方法摘要，不复制代码、品牌资产或第三方 Skill。

固定版本：[`22cb9f9320f11b383094726646d3200698f232e4`](https://github.com/dembrandt/dembrandt/commit/22cb9f9320f11b383094726646d3200698f232e4)，提交时间 2026-09-29T21:45:58+03:00；读取日期 2026-10-01。上游 [MIT 许可证](https://github.com/dembrandt/dembrandt/blob/22cb9f9320f11b383094726646d3200698f232e4/LICENSE)。这些结论限定于该 commit，不宣称后续版本相同。

## 方法到原生 App 的映射

| 已读文件 / 代码 | 实际行为 | 本 Skill 的取舍 |
| --- | --- | --- |
| [README L31–44](https://github.com/dembrandt/dembrandt/blob/22cb9f9320f11b383094726646d3200698f232e4/README.md#L31-L44) | Playwright 渲染网页，从 DOM computed styles 取颜色、字体、间距、边框、阴影、组件和动效 | 原生 App 先用可访问性树和真实窗口；确认可访问的 Web DOM 才走网页提取，不能给 CLI 传 `.app` 期待解析 |
| [colors.ts L541–594](https://github.com/dembrandt/dembrandt/blob/22cb9f9320f11b383094726646d3200698f232e4/lib/extractors/colors.ts#L541-L594) | 保存原值/归一值、次数、sources；排除部分状态色，按语义评分给置信度，用 ΔE < 15 去重，优先声明 token | 保留原始值与候选成员；浅灰细差可能决定交互状态，不照搬阈值。状态色单列，品牌确认独立判断 |
| [colors.ts L710–770](https://github.com/dembrandt/dembrandt/blob/22cb9f9320f11b383094726646d3200698f232e4/lib/extractors/colors.ts#L710-L770) | 推导 role/onColor/hover；按使用次数限制 high/medium | 推导 hover 是建议，不能写成实测。频次不是统计概率；不把色彩启发式 primary 当用户批准品牌 |
| [typography.ts L336–440](https://github.com/dembrandt/dembrandt/blob/22cb9f9320f11b383094726646d3200698f232e4/lib/extractors/typography.ts#L336-L440) | 读取字体栈、字号、字重和行高，按 family/size/weight/context/letterSpacing/textTransform 去重计数；区分正文、标题、UI、链接 | 截图不能确定实际字体和字重；原生 token 用文字角色与视觉层级，精确值保留未知，平台系统字体可作为转译建议 |
| [spacing.ts L1–91](https://github.com/dembrandt/dembrandt/blob/22cb9f9320f11b383094726646d3200698f232e4/lib/extractors/spacing.ts#L1-L91) | 从 margin/padding 频次推断 4/8px 节奏；从 computed borderRadius 记录组件上下文与置信度 | 原生记录逻辑尺寸和截图缩放；不从裁图猜 pt、套 8px 网格或宣布 12px 半径实测 |
| [components.ts L1–98](https://github.com/dembrandt/dembrandt/blob/22cb9f9320f11b383094726646d3200698f232e4/lib/extractors/components.ts#L1-L98)、[L146–174](https://github.com/dembrandt/dembrandt/blob/22cb9f9320f11b383094726646d3200698f232e4/lib/extractors/components.ts#L146-L174) | 过滤按钮语义、用视觉指纹去重；输入 focus 主要从 CSS rules 读声明 | 按组件语义、页面、触发与状态记录。CSS 声明不等于最终呈现；原生不能只按灰色识别 disabled |
| [breakpoints.ts L312–430](https://github.com/dembrandt/dembrandt/blob/22cb9f9320f11b383094726646d3200698f232e4/lib/extractors/breakpoints.ts#L312-L430) | 读取 computed transition/animation，按上下文汇总；还对最多 12 个网页交互元素采样 hover 前后差值 | README 称状态“不完全交互”仍适用，但源码不是完全没有交互。120ms 等待不构成动画时长测量；原生时长要可靠录屏/帧时间轴 |
| [merger.ts L18–161](https://github.com/dembrandt/dembrandt/blob/22cb9f9320f11b383094726646d3200698f232e4/lib/merger.ts#L18-L161) | 多页聚类颜色、pageCount 提升置信度；首页语义优先；字体按 family/size/weight 汇总；聚合 fontsReady/degraded/errors | 跨页面记录独立覆盖；不把首页优先、同色或次数直接等同全应用语义。保留行高/字距/状态冲突，任一失败仍呈现 |
| [types.ts L353–483](https://github.com/dembrandt/dembrandt/blob/22cb9f9320f11b383094726646d3200698f232e4/lib/types.ts#L353-L483)、[extractors/index.ts](https://github.com/dembrandt/dembrandt/blob/22cb9f9320f11b383094726646d3200698f232e4/lib/extractors/index.ts) | 输出包括 snapshotId、schemaVersion、CLI 版本、flags、viewport、字体就绪、降级与错误；共享类型名为 `BrandingResult` / `ExtractionMeta` | 本 commit 并无名为 `DesignTokens` 的共享接口；设计 token 是提取结果及导出用途。原生替换为 App 版本、窗口/缩放、主题、语言、工具、取证方式、覆盖/失败 |
| [formatters/dtcg.ts L195–224](https://github.com/dembrandt/dembrandt/blob/22cb9f9320f11b383094726646d3200698f232e4/lib/formatters/dtcg.ts#L195-L224)、[L436–450](https://github.com/dembrandt/dembrandt/blob/22cb9f9320f11b383094726646d3200698f232e4/lib/formatters/dtcg.ts#L436-L450) | `$type` / `$value` 导出，部分低置信 token 排除，文档 `$extensions` 保留来源/版本 | 本 Skill 的观察 schema 不是 DTCG。只有目标实现中已确定的 token 才导出 DTCG，扩展附来源；未知不转成 0、空串或默认色 |
| [drift.ts L635–705](https://github.com/dembrandt/dembrandt/blob/22cb9f9320f11b383094726646d3200698f232e4/lib/drift.ts#L635-L705)、[L757–810](https://github.com/dembrandt/dembrandt/blob/22cb9f9320f11b383094726646d3200698f232e4/lib/drift.ts#L757-L810) | 比较前检查页面、窗口、dark/mobile flags、字体就绪与降级；过滤部分低置信值；双侧空类别不计零分 | 同角色/组件/状态可比时才比较。把未知、不可比、采样失败列为缺口；不得用空数据宣布“无漂移” |

## 边界

Dembrandt 针对网页；[README 限制](https://github.com/dembrandt/dembrandt/blob/22cb9f9320f11b383094726646d3200698f232e4/README.md#L177-L190) 包括暗色需显式请求、DOM 外的 Canvas/WebGL 无法读取、动态内容可能漏取。它没有证明 Typeless 内部实现，也不授予原生 App 调试、注入、读取账户或扩大屏幕权限的权限。

需要重新取证时执行 [原生协议](native-resampling.md)。不要求运行本工具；未来明确要运行时再核对官方来源、必要性、当前参数和访问范围，保持任务局部，不默认全局 npm 安装、持久 MCP 或上传快照。
