# Skill 分发设计与上游研究

核验日期：2026-10-18。

## 结论

`mattpocock/skills` 公开的是作者日常使用的 Skill 集合。
公开源码不足以恢复他的整台机器。可观察到的维护方式是：Git 保存可复用指令，宿主读取插件或本机链接。
`agent-config` 继续保存个人规则与受管 Skill，同时提供方便别人理解和按需取用的入口。

本次研究固定到上游 commit
[`49dd158d1076134a641b33efb035946536778336`](https://github.com/mattpocock/skills/tree/49dd158d1076134a641b33efb035946536778336)。
下表记录直接核验的事实。建议和本仓库决策另列。

## 上游事实

| 事实 | 原始依据 |
| --- | --- |
| 作者将仓库定义为每天使用的精选 Skill，并要求改进源自真实会话中的失败。 | [SCOPE.md，3–18 行](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/SCOPE.md#L3-L18) |
| 正式插件用显式列表选择 27 个 Skill，来源为 engineering 与 productivity。 | [plugin.json，21–49 行](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/.claude-plugin/plugin.json#L21-L49) |
| 人类文档解释用途、使用时机与有效结果。安装文案单独维护，避免多处复制后漂移。 | [writing-docs.md，3–19 行](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/.agents/writing-docs.md#L3-L19) |
| 开发脚本把 Skill 链接到 Claude 和通用 Agent Skills 目录。脚本明确不属于受支持的安装器。 | [link-skills.sh，4–16 行](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/scripts/link-skills.sh#L4-L16) |
| 该脚本还会收录 in-progress；遇到同名普通目录会删除后建立链接。 | [link-skills.sh，18–31 行与 50–59 行](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/scripts/link-skills.sh#L18-L59) |
| 上游采用 MIT 许可证。 | [LICENSE](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/LICENSE) |

上游 README 声明了多种宿主安装路线，包括插件和 `skills` CLI。
本次没有验证上游各宿主的插件安装与自动更新，不把文档声明当作实测。
参考：[固定版本 README](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/README.md)。

## 本仓库采用的做法

| 采用项 | 实现 | 验证方式 |
| --- | --- | --- |
| 先解释范围，再提供安装入口。 | README 分开“按需取用”和“安装个人环境”。 | 审查依赖、目标路径、更新及许可说明。 |
| 使用显式分发清单。 | 保持 `manifest.yaml` 为准，不重排已有 Skill 路径。 | CLI 清单与 manifest、lock 精确匹配。 |
| 提供人类可浏览的目录。 | `catalog` 和生成的 `docs/skills.md` 展示用途、来源与许可证。 | CLI 测试、生成器漂移检查、CI。 |
| 减少目录维护漂移。 | 目录从 manifest、frontmatter 和 lock 生成。 | `build_skill_catalog.py --check` 失败时阻止 CI 通过。 |
| 依据真实行为确认分发。 | 固定外部安装器版本，验证发现与项目安装。 | 在隔离 HOME 和项目内检查实际安装文件及摘要。 |

没有照搬上游的删除覆盖脚本，也没有加入新的插件市场、批量安装全部宿主或自动更新通道。
这些改动需要明确的宿主范围和额外验收。现有叶级链接、碰撞即停止、fast-forward-only、
第三方来源记录、安全扫描和独立审查继续有效。

本次没有复制或改编 Matt Pocock 的 Skill，也没有改变本仓库已有内容的许可证。
本仓库的 MIT、GPL 或未声明许可等状态须逐项读取，不能沿用上游仓库级 MIT 的结论。

## 安装器验证边界

本次固定使用 npm `skills@1.7.2`，其声明要求 Node.js >=22.20.0。
官方使用方式参见
[vercel-labs/skills README](https://github.com/vercel-labs/skills/blob/13e4063a1cf913f5606d57d42ab83a86f5001e04/README.md)。
该源码 revision 与 npm 发布包不是同一身份；实际兼容性以下面的固定 npm 包探针为准。

`tests/verify_skills_install.py` 会真实执行以下检查：

1. 从本地仓库发现 Skill，要求结果与 manifest 完全一致。本次清单为 30 个。
2. 从 `profile/skills/teach` 只列出 `teach`，且列表操作不安装文件。
3. 在临时项目安装 `teach`，按 README 的必需步骤获取同版本许可证，核对 6 个源文件及 `LICENSE` 的摘要。
4. 从公开仓库固定 commit `93b86f619151e19228efb725f1a1ad581e1dc052` 的同一子目录安装，并保留该版本的许可证，再核对全部 7 个文件。
5. 确认没有安装全局 `AGENTS.md`、`config.toml`、Git hooks 或其他 Skill。
6. 确认缺少许可证或许可证内容不匹配时检查失败，恢复正确许可证后才允许通过。

使用项目范围可避免与本机 `agent-config` 管理的全局路径重叠。
Skill 的依赖、登录状态、业务执行与其他宿主兼容性不在此安装探针覆盖内。
外部安装器升级后必须重新运行探针，不以本次结果保证未来版本。

许可证文件保留在完整仓库的 `third_party_licenses/`。安装器只复制 Skill 子目录，
不会把仓库级许可证目录一并带走。因此推荐安装流程包含从同一个固定 revision 获取
`teach-LICENSE.txt` 并保存为安装目录中 `LICENSE` 的必需步骤。下载失败时安装未完成。
初始六文件探针未覆盖这一点；独立审查发现缺陷后，已补上实际安装步骤和缺失、错误许可证的失败检查。

## 后续改进的选择标准

后续可以为有实际使用反馈的 Skill 增加独立人类说明页。
不要先批量复制 30 份安装说明。先证明生成目录无法回答的问题，再补所需说明。
只有出现明确的多宿主分发需求，才评估插件 manifest、版本发布或额外兼容层。
不要把本机账号、MCP 配置、模型路由和会话上传来追求表面上的环境完整。
