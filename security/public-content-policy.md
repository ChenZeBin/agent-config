# 公开内容安全策略

本仓库默认所有内容都会永久公开、被 fork、缓存和索引。提交前必须满足：

- 无 API key、access token、密码、Cookie、私钥、认证头或 `.env` 实值。
- 无个人邮箱、手机号、内网域名、私有主机名、本机用户名绝对路径、设备标识和客户名称。
- 无 Codex `auth.json`、session、log、SQLite、cache、浏览器数据和运行生成物。
- 示例只使用 `example.com`、`user@example.com`、`$HOME`、`/Users/example` 和明显占位符。
- 第三方代码必须记录来源、固定 40 位 commit、固定依据与许可证，并在 `third_party_licenses/` 保留许可证全文；来源不明时标记为 `unverified-legacy-snapshot`，不得声称拥有其版权。

安全门禁：

1. `scripts/privacy_scan.py` 分别检查工作树、staged index 和完整 Git 历史中的隐私与高置信度凭据模式。
2. Gitleaks 使用默认规则加本仓库自定义规则扫描 Git 历史。
3. pre-commit 扫描 staged 内容；pre-push 扫描历史；GitHub Actions 再独立扫描。

若秘密已经提交：立即轮换或撤销秘密，再评估历史清理。历史改写和 force push 必须作为单独事故操作，不由日常同步脚本自动执行。
