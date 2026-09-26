---
name: wechat-channels-ingest
description: 将公开微信视频号 weixin.qq.com/sph 短链的第一方预览元数据、原始 API 响应与封面固化为可验证、不可变的本地 raw 证据包。仅由 article-ingest 路由调用；当前不获取登录内容、视频媒体或字幕。
---

# 微信视频号公开分享收录

先固化证据，再判断是否具备炼化条件。仅由 `article-ingest` 路由调用；`agents/openai.yaml` 禁止隐式调用。

## 边界

- 仅接收无凭据、无端口的 HTTPS `https://weixin.qq.com/sph/<short-uri>`，以及其第一方规范预览形式 `https://channels.weixin.qq.com/finder-preview/pages/sph?id=<short-uri>`。
- 每次采集必须匿名请求短链，并验证它精确跳转到同一 `short-uri` 的 `channels.weixin.qq.com` 第一方预览页；随后保存原始预览 HTML、`feed/get_feed_info` 精确 JSON 响应和允许域内的原始封面。
- 当前 capture scope 仅为 `single-public-share-preview`。第一方 API 能证明短链对应的公开描述、作者、发布时间、封面和采集时互动快照，但该 `sph` 预览未暴露视频媒体、音频、字幕或逐字稿。
- 所有当前 bundle 都是 `metadata-only`、`transcript_available: false`，通用队列必须标为 `archive-only` 并排除在正式编译 claim 之外。不得把描述或封面文字说成视频完整内容，不得声称视频内容已经炼化。
- `dynamicExportId`、封面 CDN URL 和互动数可能过期或变化；保留在精确原始响应中，但不作为稳定内容身份。重复判断使用 canonical URL、作者、描述、发布时间和固化封面 checksum。
- 不读取 Cookie、浏览器登录态或微信客户端数据，不调用第三方解析器，不绕过“此内容暂时无法播放”、登录或平台限制。

## 命令

在仓库根目录执行：

```bash
node .agents/skills/wechat-channels-ingest/scripts/wechat_channels_ingest.mjs stage --url 'https://weixin.qq.com/sph/AyN0KgKSs2'
node .agents/skills/wechat-channels-ingest/scripts/wechat_channels_ingest.mjs validate --stage 'ABSOLUTE_STAGE_PATH'
node .agents/skills/wechat-channels-ingest/scripts/wechat_channels_ingest.mjs promote --stage 'ABSOLUTE_STAGE_PATH'
node .agents/skills/wechat-channels-ingest/scripts/wechat_channels_ingest.mjs verify --raw 'ABSOLUTE_RAW_BUNDLE'
```

或使用 `ingest --url URL` 顺序执行。`stage` 仅写新的 `staging/wechat-channels/` 直接子目录；`promote` 通过确定性验证后原子发布到 `raw/wechat-channels/`。同一 canonical URL 与稳定内容 checksum 已存在时返回 `duplicate-noop`，绝不覆盖原包。

`verifyRaw` 返回 `source_authenticity`、`metadata_authenticity`、`content_authenticity`、`transcript_available`、warning 和 checksum。manifest、文件清单、short URI 绑定、第一方 API schema、确定性 Markdown、封面域名/类型/magic bytes、大小、路径、符号链接或额外文件异常均 fail-closed。

## 后续补全

若用户以后明确提供其有权分享的原始视频或精确转录，应通过新的显式导入流程创建一个新 bundle，并保留对本 metadata-only bundle 的 provenance 关联。不要修改、补写或替换既有 `raw/wechat-channels/` 包。
