# 原生设计证据与差异模板

复制到任务私有目录再填写；本文件是空白模板，字段值不是实测。适用于截图/AX 原始材料和 [token schema](tokens.schema.json)。不要把含账户、历史或个人统计的原始图发布到 Skill。

## Snapshot

```yaml
snapshotId: <唯一 ID>
capturedAt: <实际 UTC ISO8601；未采为 null>
app: Typeless
installedVersion: null
installedBuild: null
installedVersionEvidence: null
runningVersion: null
runningVersionEvidence: null
platformVersion: null
toolAndVersion: null
themeObserved: unknown
locale: unknown
windowLogicalSize: null
screenshotPixels: null
backingScale: null
colorProfile: unknown
allowedActions: <本次授权与非持久动作>
blockers: []
```

## 原始材料登记

| source ID | 类型（screenshot/AX/声明/运行测量/元数据/历史摘要） | 原始文件与 SHA-256 | 版本、页/组件/状态 | 进入动作、退出与焦点 | 采集条件/缺口/脱敏副本 |
| --- | --- | --- | --- | --- | --- |
| 待填 | 待填 | 待填 | 待填 | 待填 | 待填 |

声明与依赖默认另记文件、commit/包版本、行或对象范围；未核对最终生效参数时不升级为 runtime。原始截图无法重新访问时明确“历史摘要，原图本次未复核”，其 SHA 只是身份记录。

## token 与语义映射

| token ID / role | rawValue → value / unit | precision/status | source IDs / observedAppVersion | screen/component/state/theme | confidence / 独立页与状态 / 重复次数 | 建议值及局限 |
| --- | --- | --- | --- | --- | --- | --- |
| 待填 | 无数值证据时 null | unknown | 待填 | 待填 | 待填 | 单列 proposal |

精度用 qualitative/approximate/exact/declared/unknown；高置信定性观察不自动变 exact。精确数值的取证能力必须与字段匹配。新建议不是过去已确认的品牌。

## 覆盖与退出

| 页/组件/状态 | observed / blocked / not_sampled / not_applicable | 原始证据 | 退出与焦点实况 | 值是否改变及恢复方式 | 未执行原因 |
| --- | --- | --- | --- | --- | --- |
| 待填 | not_sampled | 无 | 未执行 | 未执行 | 待填 |

分别列 default、selected、open、hover、focus、pressed、off、disabled、empty、loading、error、success、dark、narrow；按具体任务只测相关项。已授权只读时，不触发持久状态来填表。立即保存的 Escape 可能只关层；没有动作证据时不要写取消撤销。

## 差异验收

- baseline snapshot / App版本 / candidate snapshot / App版本：待填。
- 条件一致性（page/component/state/theme/locale/logical size/scale/color/tool）：待填；未知或不一致字段先列为 incomparable。

| role/组件/状态 | before → after | changed/unchanged/incomparable/unknown/newly_observed/not_sampled | 来源与判断依据 | 是否改变目标建议 | 待复核项 |
| --- | --- | --- | --- | --- | --- |
| 待填 | null → null | unknown | 无有效测量 | 否 | 待采 |

- 本次实采页数/状态数：待填；只有元数据或全阻塞时为 0，不给“无漂移”。
- 保留历史观察/未重新验证值：待填。
- 目标产品实际截图、层级/裁切/软灰选中/强调色与退出路径验证：待填；与参考 App 取证分开。
- 可用结论、未覆盖范围、下一次安全进入条件：待填。
