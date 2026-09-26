# 炼化质量评测规则

## 适用范围

用本规则审查一次来源或会话炼化是否可供后续 Agent 安全复用。结构检查由脚本完成；本规则评估脚本不能可靠判断的语义质量。

## 硬门槛

任一项失败则整体失败，不计算“平均通过”：

1. 原始 bundle 在审查前后验证通过，现有 `raw/` 没有被改动。
2. 来源页 checksum、manifest、origin 与实际 bundle 一致。
3. 没有把 `staging/`、Wiki 页面或模型总结当作事实锚点。
4. 没有发现无来源支持的关键事实、数字、引语或归因。
5. 来源页、相关主题页、索引与 append-only 日志同步。
6. 至少形成一个与来源规模相称、带精确 raw locator 的可复用知识单元；只有标题、溯源、限制或泛化摘要的页面失败。来源确实没有可炼化知识时标为 `archive-only`，不得宣告正式编译完成。
7. 提供“来源主要范围 → Wiki 覆盖位置或明确省略理由”的 coverage map。清单、教程、比较、多章节文章和长视频必须逐项覆盖标题承诺的主体，不能只用一段总括代替。
8. 对适用的 canonical concept/entity/analysis 作出显式整合决定：更新并建立双向链接，或记录有证据的 `no-update rationale`；不得默认停在孤立来源页。

## 评分

每项按 `0`、`1`、`2` 评分，总分 12。使用下表锚点，不得因为页面“很安全”而抬高其知识价值评分。

| 维度 | 0 分 | 1 分 | 2 分 |
| --- | --- | --- | --- |
| 来源覆盖 | 重要主体缺失，或标题承诺未兑现 | 覆盖主线但遗漏重要分支、条目或边界 | coverage map 完整覆盖主要范围、标题承诺和重要限制，省略均有理由 |
| 主张支撑 | 存在无依据的实质性主张或错误归因 | 多数主张有依据，但 locator 粗糙或少量推断未清楚标记 | 实质性主张紧跟精确 raw 引用；推断明确标记并引用全部输入 |
| 不确定性 | 隐藏真实性、缺失或冲突 | 提到主要限制但未说明影响范围 | 来源真实性、缺失内容、分歧和未决问题均被显式保留并限制复用范围 |
| 知识整合 | 重复建页、错误合并，或有明显相关 canonical 页却不处理 | 建立部分关联，但仍有弱链接、缺反链或整合决定不完整 | 更新适用 canonical 页面并双向链接；无更新时给出充分的 `no-update rationale` |
| 可复用性 | 只有元数据、限制、泛化摘要或流水账，不能支持后续判断或行动 | 有可迁移结论，但缺触发条件、边界、失败模式或操作结构 | 核心知识单元包含做法/主张、适用或决策触发条件、边界/失败风险和 raw locator |
| 信息节制 | 含大量无关原文、秘密、私人信息或过程噪声 | 有重复或低价值细节，但不妨碍使用 | 没有复制大段原文、临时进度、秘密、私人信息或可从代码直接推出的噪声 |

通过条件：

- 所有硬门槛通过；
- 总分至少 10；
- `来源覆盖`、`知识整合`、`可复用性` 必须各为 2，不能由其他维度补偿；
- 任何单项不得为 0。

## Coverage map 最低要求

- 清单型来源：逐项列出名称、用途或主张、适用/触发条件、边界和 locator；无法可靠辨识的条目也必须占位并标明缺口。
- 教程/流程：覆盖前置条件、步骤、分支、失败模式和完成条件。
- 比较/选型：覆盖所有对象、比较维度、证据可比性和采用条件。
- 多章节文章或长视频：逐章节或主题段说明 Wiki 落点；Bilibili locator 至少包含分 P/CID 与时间区间，YouTube locator 至少包含 video ID、所选轨道语言与类型（人工或自动）及时间区间。
- 翻译型来源：完整翻译不自动等于知识炼化；仍需给出可复用结构与整合决定。

## 可审计审核凭证

正式通过必须保存机器可验证的 semantic-quality receipt，并绑定：

- `platform` 与 `bundle_checksum`；
- 来源页及所有本次修改 Wiki 页的相对路径和 SHA-256；
- 本规则文件的 SHA-256；
- compiler 与独立 reviewer 身份，二者不得相同；
- 每个硬门槛、六项分数、总分、最终状态和证据摘要。

任一被绑定文件或本规则变化后，旧 receipt 失效。结构检查、检索命中或一次性聊天总结不能代替该凭证。

质量 receipt 的信任边界是本地仓库的受控写入流程：它用于发现缺失、过期、自审、证据不足和绑定不完整，不是密码学签名，也不能证明 JSON 中自报的模型或 reviewer 身份。拥有仓库任意写权限的恶意进程仍可伪造文件；如需抵抗该威胁，必须由仓库外的受信执行器签名或保存不可伪造的运行证明，当前门禁不作此声明。

门禁必须 fail-closed：malformed receipt、未知或符号链接条目、非空 `unsupported_claims`、缺少逐硬门槛/逐评分证据、来源页直接链接但未绑定的 canonical 页，以及 claim 期间变化却未绑定的内容页，都不得通过或释放 claim。来源页还必须具有多段可见实质正文和至少一个真实、已声明、位于 `raw/` 内的证据定位；HTML 注释、标题、索引摘要、伪链接和单行标点不计入知识内容。

## 审查输出

输出 JSON：

```json
{
  "platform": "wechat | x | bilibili | youtube",
  "bundle_checksum": "sha256:...",
  "source_page": "wiki/sources/....md",
  "source_page_sha256": "sha256:...",
  "rubric_sha256": "sha256:...",
  "status": "pass | fail | needs-review",
  "hard_gates": [{"name": "raw_integrity", "passed": true, "evidence": {"version": 1, "raw": [{"path": "raw/x/example/article.md", "locator": {"kind": "lines", "start": 1, "end": 3}}], "wiki": [{"path": "wiki/sources/example.md", "locator": {"kind": "lines", "start": 20, "end": 24}}]}}],
  "scores": [{"dimension": "source_coverage", "score": 2, "evidence": {"version": 1, "raw": [{"path": "raw/x/example/article.md", "locator": {"kind": "lines", "start": 1, "end": 3}}], "wiki": [{"path": "wiki/sources/example.md", "locator": {"kind": "lines", "start": 20, "end": 24}}]}}],
  "total_score": 12,
  "coverage_map": [{"source_scope": "...", "wiki_location": "...", "omission_reason": null}],
  "integration_decision": {"updated_pages": [], "no_update_rationale": null},
  "compiler": "...",
  "compiler_model": "gpt-5.6-sol",
  "compiler_reasoning": "max",
  "reviewer": "...",
  "wiki_pages": [{"path": "wiki/sources/....md", "sha256": "sha256:..."}],
  "unsupported_claims": [],
  "missing_evidence": [],
  "recommended_fixes": []
}
```

`evidence` 不是审核结论文本；所有 hard gate 与每个 score 都必须使用以下版本化对象。旧的任意字符串、只有 URL、缺路径、越界路径、符号链接路径、未绑定 Wiki 页、或不存在/越界行号一律无效：

```json
{
  "version": 1,
  "raw": [
    {
      "path": "raw/x/example/article.md",
      "locator": {"kind": "lines", "start": 12, "end": 18}
    }
  ],
  "wiki": [
    {
      "path": "wiki/sources/example.md",
      "locator": {"kind": "lines", "start": 25, "end": 31}
    }
  ]
}
```

`raw.path` 必须是本 receipt 所绑定 bundle 内的普通文件；`wiki.path` 必须在同一 receipt 的 `wiki_pages` 中并且 checksum 仍匹配。每个 locator 当前只接受闭区间行号，`start`、`end` 均为从 1 开始的整数且不得超过文件实际行数。没有足够可核验的 evidence 时使用 `needs-review`，不要猜测通过。
