# agent-config

公开、安全、可恢复的个人 Codex 全局配置仓库。GitHub `main` 是已发布事实源；本机 clone 是工作副本；Codex 只使用清单声明的叶级符号链接。

## 安装

需要 Git 和 Python 3.11+。macOS 如尚未安装 Gitleaks，还需要 Homebrew；
`setup` 会自动运行 `brew install gitleaks`。其他系统请先安装 Gitleaks。
克隆后运行一次 `setup`：

```bash
git clone git@github.com:ChenZeBin/agent-config.git ~/.config/agent-config
cd ~/.config/agent-config
bin/agent-config setup
```

`setup` 校验仓库内容，安装清单中的叶级链接、仓库 Git hooks，并将
`agent-config` 与 `codex-hybrid` 链接到 `~/.local/bin/`。重复运行不会覆盖已有文件；
如需先预览，运行 `bin/agent-config setup --dry-run`。如遇到既有配置或 hooks
冲突，命令会在修改前停止；先检查提示，再使用 `adopt` 显式导入需要保留的内容。
若 `~/.local/bin` 不在 `PATH`，`setup` 会写入 zsh 的 `.zprofile` 或 bash 的
`.bash_profile`；打开新终端即可按名称使用。当前终端可直接运行
`~/.local/bin/agent-config` 和 `~/.local/bin/codex-hybrid`。仓库 hooks 会在提交和推送时检查 Gitleaks。

安装后的链接：

```text
~/.codex/AGENTS.md              -> profile/AGENTS.md
~/.agents/skills/<skill-name>   -> profile/skills/<skill-name>
~/.local/bin/agent-config       -> bin/agent-config
~/.local/bin/codex-hybrid       -> bin/codex-hybrid
```

工具不会管理 `~/.codex/AGENTS.override.md`，但 `doctor` 会报告它是否遮蔽全局规则。工具也不会链接整个运行时目录，因此 `auth.json`、session、log、cache 和数据库不会进入 Git。

## 日常同步

```bash
bin/agent-config sync --check      # fetch 并分类，不修改工作树
bin/agent-config sync --pull       # clean + fast-forward-only
bin/agent-config validate
bin/agent-config security-scan
git add -A && git commit -m "..."
bin/agent-config sync --push       # 禁止 force push
```

## 新建或更新自建 Skill

今后新建或实质改编的自有 Skill，创建当次就发布到这个仓库的 `main`；即使先在 `~/.codex/skills/`、`~/.agents/skills/` 或项目目录中写成，也要迁入本仓库，完成验收、提交、推送并核对远端。推送失败时明确报告未同步。Codex 的全局规则已写在 `profile/AGENTS.md`，仓库维护规则写在根目录 `AGENTS.md`。

在本仓库的 `profile/skills/<skill-name>/` 中维护可发布的 `SKILL.md`、引用资料和评测源文件，并同步更新 `manifest.yaml` 与 `dependencies/skills.lock.yaml`。自建内容用 `local-authored-snapshot`；本地改编第三方内容时记录上游 commit 与许可证，并把许可证放入 `third_party_licenses/`。

`~/.codex/skills/` 下的独立目录不会被 `sync --push` 自动发现；评测生成的 `*-workspace/`、日志和缓存也不应复制进公开仓库。入库后先运行 `bin/agent-config validate`、`bin/agent-config security-scan` 和相应 Skill 评测，再执行 `bin/agent-config link --apply` 安装清单中的叶级链接，最后提交并推送。已安装的第三方 Skill 不因位于本机目录就自动成为本仓库的自建内容。此前误归类的 `codex-session-controller` 与 [Patrick Fu 的原版](https://github.com/patrick-fu/awesome-skills/tree/70bea73faa43a3afd33e49bdfa2bd5afac36232a/codex-session-controller) 逐文件相同，已从当前公开配置移除；旧提交仍可访问，本机独立安装仍可使用。

本次还收录了 `my-wiki` 的八个项目 Skill、`cli-anything-ugreen-nas` 和 `claude-md-progressive-disclosurer`。`my-wiki` Skill 需要目标项目及其依赖；公开副本已去除本机路径、私有 `.env` 与机器专用 launchd 配置。公开仓库只保存 Skill 源码，不包含 Wiki 的 `raw/`、`staging/`、会话或运行数据。

`typeless-ui-style` 的 `evals/fixtures/` 是依赖本机绝对路径与本机 Codex 登录状态的旧评测脚手架，仅保留可移植的 `evals/eval.yaml`、用例和参考资料；不将本机配置、运行日志或夹具脚本发布到公开仓库。

历史提交中的评测报告仍可公开访问：早期提交曾包含 `profile/skills/design-macos-apps/evals/results/` 下的三份结果报告。当前 `main` 已移除这些文件并忽略后续结果；Git 历史未改写，已有链接或副本不会因此失效。

## Codex 混动开关

`bin/codex-hybrid` 管理本机 `config.toml` 中的混动状态，并在每次实际修改前创建私有备份：

```bash
codex-hybrid on       # 开启 Subagent 混动；主 Agent 设为 gpt-6-sol / xhigh
codex-hybrid off      # 关闭 Subagent 混动；不改写主 Agent 模型和强度
codex-hybrid toggle   # 在两种状态之间切换
codex-hybrid status   # 查看当前状态
```

开关只影响新建会话，已经运行的会话不会热切换。备份保存在
`$CODEX_HOME/backups/hybrid-switch/`；未设置 `CODEX_HOME` 时使用 `~/.codex`。
`setup` 会创建命令入口；macOS 上可直接使用以上命令。

状态为 dirty、diverged 或 no-upstream 时，脚本会停止，不会自动 stash、merge 或 rebase。拉取会在 fetch 后固定候选 commit SHA，用当前受信任工具扫描该 SHA 的完整历史，并在推进 HEAD 前完成链接碰撞预检；最终只快进到同一个已验证 SHA，且快进后不会执行候选中的程序。远端若修改 `bin/`、`scripts/`、`.githooks/` 或 `.gitleaks.toml` 等本地控制面文件，自动拉取会拒绝，必须人工审查更新；离线时保持最后一个已验证版本可用。

## 安全边界

- 本地：Gitleaks + `scripts/privacy_scan.py`，pre-commit 扫 staged index，pre-push 扫全部待推送历史。
- GitHub：Actions 使用完整历史执行 Gitleaks、个人标识扫描、manifest/skill 验证和状态机测试。
- `.gitignore` 不是秘密管理器；凭据只放环境变量、macOS Keychain 或密码管理器。
- `.skillignore` 不会影响仓库级扫描。
- 公开策略与事故处理见 `security/public-content-policy.md`。
- 安全问题请通过 GitHub 私密漏洞报告入口提交，见 `SECURITY.md`；不要把凭据粘贴到公开 Issue。

## 恢复与迁移

- 链接冲突会 fail closed，退出码 `20`，原文件不会被覆盖。
- 显式导入既有配置可先运行 `adopt agents --dry-run` 或 `adopt skill <name> --dry-run`，确认后改用 `--apply`。
- 旧文件在首次接管时备份到 `~/.local/state/agent-config/backups/<timestamp>/`；状态目录/子目录固定为 `0700`，文件固定为 `0600`。
- `bin/agent-config reconcile --apply` 只删除 `links.json` 中登记且已从 manifest 移除的链接。
- `bin/agent-config unlink --apply` 只删除本工具拥有、仍指向当前仓库的链接。
- `bin/agent-config rollback <commit>` 在 clean 工作树上创建恢复提交，不改写历史。
- 每次成功接管、拉取或回滚都会原子更新 `~/.local/state/agent-config/state.json`，记录 `last_good_head` 与 `previous_head`。

## 自动检查

macOS 可执行 `bin/agent-config automation install` 安装每 6 小时一次的 fetch-only 检查；卸载使用 `automation uninstall`。它不会自动 pull、commit 或 push。

退出码：`0` 成功，`10` dirty，`11` behind，`12` ahead，`13` diverged，`14` no-upstream，`20` 链接冲突，`30` 验证/安全失败，`40` 网络不可用。
