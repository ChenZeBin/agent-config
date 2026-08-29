# agent-config

公开、安全、可恢复的个人 Codex 全局配置仓库。GitHub `main` 是已发布事实源；本机 clone 是工作副本；Codex 只使用清单声明的叶级符号链接。

## 安装

```bash
git clone git@github.com:ChenZeBin/agent-config.git ~/.config/agent-config
cd ~/.config/agent-config
bin/agent-config doctor
bin/agent-config validate
bin/agent-config link --apply
bin/agent-config hooks install
```

实际链接：

```text
~/.codex/AGENTS.md              -> profile/AGENTS.md
~/.agents/skills/<skill-name>   -> profile/skills/<skill-name>
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

状态为 dirty、diverged 或 no-upstream 时，脚本会停止，不会自动 stash、merge 或 rebase。拉取时只用当前受信任工具把远端候选当纯数据扫描，并在推进 HEAD 前完成链接碰撞预检；离线时保持最后一个已验证版本可用。

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
