# agent-config 仓库维护规则

- 使用中文沟通，先给结论。
- `profile/` 是将发布到个人 Codex 环境的唯一内容目录。
- 不得提交凭据、Cookie、个人邮箱、内网地址、本机绝对路径、会话、日志或缓存。
- 修改后必须运行 `bin/agent-config validate` 和 `bin/agent-config security-scan`。
- 只允许链接 `profile/AGENTS.md` 与 `profile/skills/<name>`；禁止链接整个 `~/.codex`、`~/.agents` 或 skills 根目录。
- 同步必须 fast-forward-only；禁止自动 stash、rebase、force push。
- 第三方 skill 的来源和许可证必须记录在 `dependencies/skills.lock.yaml`。
- 今后创建或实质改编的自有 Skill，按 `profile/AGENTS.md` 的发布流程纳入 `profile/skills/<name>/`、`manifest.yaml` 和 `dependencies/skills.lock.yaml`；完成评测与安全验收后提交、非强制推送到本仓库 `main`，并核对远端。失败时报告未同步。
