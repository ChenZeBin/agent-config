# 微信公众号入口

目标链路：在微信中复制公众号文章链接并粘贴发送给测试号，测试号立即 ACK；本机随后把文章固化到 `raw/wechat/`，启动 `gpt-5.6-sol` / `max` 编译和全新 reviewer，只有最终队列状态为 `consistent` 才显示“LLM Wiki 已更新”。

## 1. 本机配置

配置文件路径：

```text
$HOME/my-wiki/.agents/skills/wechat-official-account/.env
```

先从 `.env.example` 创建 `.env`，执行 `chmod 600 .env`。不要把 `.env`、Token、AES Key 或 HMAC Key 发进聊天或 Git。建议这样生成本地随机值：

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
openssl rand -hex 32
```

第一行恰好生成 43 字符，可作为 `WECHAT_ENCODING_AES_KEY`；第二行可作为 `WEBHOOK_HMAC_KEY`。`WECHAT_TOKEN` 必须与公众号后台填写的 Token 完全一致。

## 2. 安全配对自己的微信账号

首次设置 `WECHAT_MODE=pair`，留空 `WECHAT_ALLOWED_SENDER_HMAC`。该模式不会抓文章、不会调用 LLM、不会写 Wiki。

```bash
cd $HOME/my-wiki
npm ci
cd .agents/skills/wechat-official-account
npm run build
npm start
```

另开终端启动用户已同意的临时隧道：

```bash
cloudflared tunnel --url http://127.0.0.1:8787 --no-autoupdate
```

把生成的 `https://<随机>.trycloudflare.com/wechat` 填到微信测试号“接口配置信息”的 URL；Token 填 `.env` 的同一值。`JS 接口安全域名` 不需要填写。保存成功后，从自己的微信向测试号粘贴发送一条完整的微信文章 URL。它只会产生脱敏 sender HMAC。

停止服务后读取配对值：

```bash
npm run pairing:hmac
```

把输出的一整行写入 `.env`，再改为：

```dotenv
WECHAT_MODE=run
WECHAT_ALLOWED_SENDER_HMAC=h1:...
```

不要把第一个来信者自动设成授权用户；`pair` 模式始终拒绝执行任务。

## 3. 正式运行

确保 Codex CLI 已登录，并且本地电脑保持唤醒、联网：

```bash
cd $HOME/my-wiki/.agents/skills/wechat-official-account
npm test
npm start
```

再启动 Quick Tunnel。每次 Quick Tunnel 地址变化，都同时更新 `.env` 的 `PUBLIC_BASE_URL` 和微信后台 URL，然后重启服务。回调 URL 必须以 `/wechat` 结尾。

在微信文章右上角选择“复制链接”，回到测试号对话，粘贴完整 URL 并发送。被授权的账号会收到一个状态链接：

- `正在抓取文章并炼化知识`：raw intake 或 LLM/reviewer 尚在运行；
- `LLM Wiki 已更新`：精确 bundle 已达到 `consistent`；
- `处理未完成`：抓取、编译、独立审查或一致性门禁失败，没有伪装成成功。

同一个 WeChat `MsgId` 在 24 小时内只执行一次。队列严格串行，最多保留 16 个已接收任务。

## 4. 验收

```bash
node $HOME/my-wiki/.agents/skills/article-ingest/scripts/article_compile_queue.mjs scan \
  --repo $HOME/my-wiki

node $HOME/my-wiki/.agents/skills/wiki-knowledge-loop/scripts/wiki_health.mjs \
  --repo $HOME/my-wiki
```

只有目标 `raw/wechat/<bundle>` 出现在 `consistent`，且对应 `quality-reviews/*.json` 有效，才算 LLM Wiki 成功。`promoted` 只代表原始资料已固化。

## 安全边界

- 公网只暴露 `/wechat` 与不可猜测的 `/probe/events/<token>`；没有公网管理端点。
- 原始回调 XML 和 OpenID 不落盘，正常日志不输出 URL、文章内容、配置或异常对象。
- 只有授权 sender HMAC 可以触发网络抓取和 LLM 成本。
- 微信正文通过独立递归 DNS 解析全部地址、拒绝非公网地址，并把 HTTPS/TLS/SNI 与实际对端 IP 固定；图片不进入该公网服务的网络抓取边界，失败时保留远程引用和明确 warning。
- 子 Codex 进程使用 `workspace-write` 且不能自动提权；其环境变量采用允许清单，不传递微信 Token、AES Key、HMAC Key、公众号 URL、provider API key 或其他任意业务变量。`.env` 仍必须视为本机敏感文件，不得让来源内容改变其权限或读取规则。
- Quick Tunnel 地址临时且进程退出即失效；它只适合本机 Phase 0/个人试运行，不是长期托管方案。
