# 维护与发布

先读根目录 `AGENTS.md`。本仓库区分公开源文件、机器私有状态和可重建的目录。
GitHub `main` 记录已发布版本。只在本机创建文件不等于已发布。

## 文件职责

| 文件 | 职责 |
| --- | --- |
| `profile/AGENTS.md` | 个人 Codex 全局规则 |
| `profile/skills/<name>/` | Skill 指令、引用资料、脚本与可移植评测源文件 |
| `manifest.yaml` | 安装清单，声明且只声明需要管理的 Skill |
| `dependencies/skills.lock.yaml` | 来源、固定版本、改编关系与许可证 |
| `third_party_licenses/` | 第三方许可证原文 |
| `docs/skills.md` | 生成的公开目录，不手工维护 |
| `bin/`、`scripts/`、`.githooks/` | 管理工具与安全检查，属于受保护控制面 |

## 新增或修改 Skill

1. 在 `profile/skills/<name>/` 修改公开源文件。保持目录名与 frontmatter `name` 一致。`description` 说明用途和触发范围。大段参考资料放入引用文件。
2. 在 `manifest.yaml` 登记名称，并在 `dependencies/skills.lock.yaml` 登记同名来源。原创使用 `local-authored-snapshot`。改编第三方内容须记录上游完整 commit、改编关系、许可证及许可证文件。
3. 检查许可证。公开可见不等于获准复制。没有许可证的原创内容沿用 `LICENSE.md` 的保留权利政策，不自动改成 MIT。
4. 完成适用的 `skill-up validate` 和真实 `skill-up run`，读取逐例结果。评测源文件可以入库；运行产物、登录状态和本机绝对路径不得入库。
5. 更新生成目录，再运行仓库检查：

```bash
python3 -B scripts/build_skill_catalog.py
python3 -B scripts/build_skill_catalog.py --check
bin/agent-config validate
bin/agent-config security-scan
python3 -B -m unittest discover -s tests -v
```

`catalog` 支持仓库使用的 frontmatter 标量格式，不执行 Skill。
目录按 manifest 生成，不递归收录测试夹具。
`--check` 只检查，不改写目录。CI 会拒绝过期目录。

## 修改安装、发现或分发方式

常规单元测试不访问 npm 或 GitHub。涉及安装发现、目录布局、安装文档或固定安装器版本时，
额外运行真实安装探针：

```bash
python3 -B tests/verify_skills_install.py
```

它需要 Node.js >=22.20.0、npm、Git、curl 和网络。它在临时 HOME 与临时项目中运行固定版本的安装器，
验证仓库发现清单、单 Skill 列表、本地与公开固定 revision 的项目安装及文件摘要。
推荐流程必须保留对应版本的许可证与作者声明。探针还会验证缺失或错误许可证导致失败，
并确认最终安装副本带有正确的 `LICENSE`。
它不执行 Skill，不改真实全局配置，也不代表其他宿主可用。公开探针的 revision 必须保留；
只有目标 Skill 源文件变化且新版本已发布时，才更新并重新核验。

## 提交与推送

1. 先检查 `git status --short` 和 `git diff`。存在其他任务的改动时，优先使用独立工作区。
2. 按任务完成证据验收。只把本次已通过检查的路径交给 `git add --`。不要使用 `git add -A` 收入其他任务的文件。
3. 检查 `git diff --cached --check` 和 `git diff --cached --stat`，然后提交。核对新 commit 与工作区状态。
4. 有效发布授权包括自有 Skill 的既定发布流程。普通工具或文档改动的本地提交不自动授权推送。获得适用授权后执行 `bin/agent-config sync --push`，不得 force push。
5. 推送后比较本地 commit 与远端 ref，检查远端 CI。推送或 CI 失败时，明确报告未完成发布。

远端改变控制面时，自动拉取会停止。先人工审查这些变更，再按受审版本更新。
不要通过自动 stash、rebase、降低检查或覆盖现有文件绕过冲突。
