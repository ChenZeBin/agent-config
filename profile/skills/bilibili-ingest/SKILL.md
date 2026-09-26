---
name: bilibili-ingest
description: 将公开哔哩哔哩 UGC `https://www.bilibili.com/video/BV...` 视频的原站详情与逐 P 字幕采集为可验证、不可变的本地 raw 证据包。用户要求收录、归档、摄取、校验或编译公开 B 站 BV 视频时使用；详情来自 B 站原站 API，但 OpenCLI 字幕未与原站响应绑定，成包必须标记为 needs-review。不要用于搜索、登录内容、直播、番剧、音视频下载、投稿或非 BV 链接。
---

# 哔哩哔哩公开视频收录

先固化证据，再编译 Wiki。只通过仓库的 `article-ingest` 路由调用本 Skill；`agents/openai.yaml` 禁止隐式调用以维持统一 URL 入口。

## 边界

- 仅接收无凭据、无自定义端口的 HTTPS `https://www.bilibili.com/video/BV...` URL。脚本移除片段与全部查询参数并保留规范 URL。
- 保存精确 B 站详情响应至 `responses/view.json`，验证 `bvid`、每 P 的 `cid`、页码和时长。不得下载视频或音频。
- 每 P 优先调用 `opencli bilibili subtitle <bvid> --page N -f json`，单次最多等待 30 秒，保存结构化结果，并在 manifest 中记录 `opencli-bilibili` 与 `default-first-track` 选择策略；`article.md` 按 P、CID 与 cue 时间戳呈现。字幕结果（包括注入测试后端）未与 B 站详情响应绑定，顶层 `source_authenticity` 固定为 `mixed-detail-origin-subtitle-unverified`，不得描述为 B 站已验证字幕。空结果只能作为 warning，不能断言无字幕。
- 字幕不可用时可产生 metadata-only bundle，但必须保留 warning。不得保存或输出 Cookie、Token 或授权头。
- `staging/` 不是证据；只从通过 `verify` 的 `raw/bilibili/<bundle>/` 编译。不要修改已有 raw 包。

## 采集与发布

从仓库根目录运行；`stage` 只写新 `staging/bilibili/` 目录，检查 Markdown 和 warnings 后才发布：

```bash
node .agents/skills/bilibili-ingest/scripts/bilibili_ingest.mjs stage \
  --url 'https://www.bilibili.com/video/BV1xx411c7mD?spm_id_from=333.1007.0.0'
node .agents/skills/bilibili-ingest/scripts/bilibili_ingest.mjs validate --stage 'ABSOLUTE_STAGE_PATH'
node .agents/skills/bilibili-ingest/scripts/bilibili_ingest.mjs promote --stage 'ABSOLUTE_STAGE_PATH'
```

也可执行：

```bash
node .agents/skills/bilibili-ingest/scripts/bilibili_ingest.mjs ingest --url 'https://www.bilibili.com/video/BV1xx411c7mD'
```

发布以原子 rename 写入 `raw/bilibili/`。相同规范 URL 与相同内容返回 `duplicate-noop`，不覆盖已有包。结果会给出绝对 `raw_bundle`、`manifest` 与 `bundle_checksum`。

## 编译与复核

```bash
node .agents/skills/bilibili-ingest/scripts/bilibili_ingest.mjs verify \
  --raw 'ABSOLUTE_PATH/raw/bilibili/BUNDLE'
```

`verifyRaw` 导出给 compile queue 使用。manifest、文件清单、SHA-256、路径、响应身份或符号链接异常都必须停止，不能修补 raw 包。

正式编译必须使用 `gpt-5.6-sol`、推理强度 `max`。此 bundle 的 detail 为 `bilibili-origin-api`，但 `subtitle_authenticity` 为未验证；compile queue 必须将其置为 `needs-review`，在人工复核前不得把字幕作为 B 站原站事实。仅从已验证的 `article.md`、`responses/view.json` 和逐 P 字幕 JSON 编译；来源页按 P、CID、cue 时间戳引用，记录 `bundle_checksum`，并同步 `wiki/索引.md` 与 `wiki/日志.md`。字幕不可得是证据缺口，不是无字幕结论。
