# Third-party notices

本仓库包含固定快照或改编版本。版权归各自作者所有。精确 revision 与固定依据记录在 `dependencies/skills.lock.yaml`，对应许可证全文保存在 `third_party_licenses/`：

| Skill | Upstream | License |
|---|---|---|
| `agent-reach` | [Panniantong/Agent-Reach](https://github.com/Panniantong/Agent-Reach) | MIT |
| `evidence-gate` → `bashlex` | [idank/bashlex](https://github.com/idank/bashlex) | GPL-3.0-or-later；`yacc.py` 保留 BSD-3-Clause 声明 |
| `customer-research` | [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills) | MIT |
| `last30days` | [mvanhorn/last30days-skill](https://github.com/mvanhorn/last30days-skill) | MIT |
| `skill-upper` | [alibaba/skill-up](https://github.com/alibaba/skill-up) | Apache-2.0 |
| `teach` | [mattpocock/skills](https://github.com/mattpocock/skills) | MIT |

`design-macos-apps` 内还包含其 `references/source-provenance.md` 所列的研究来源；`last30days` 内的 vendor 组件保留其随附许可证。更新快照时必须同时更新 lock、许可证副本与 notice。

`content_relation` 明确区分与固定 revision 完全一致的 `SKILL.md` 和在该 revision 基础上的本地改编，避免把改编内容误称为上游原文。

`evidence-gate` 随附 bashlex 0.18 的 12 个运行时源文件及 GPL 全文；不发布生成解析表、安装元数据和缓存。bashlex 作者为 Idan Kamara；其中 PLY `yacc.py` 保留 David M. Beazley (Dabeaz LLC) 的版权及完整许可证声明。详见该 Skill 的 `vendor/README.md`。
