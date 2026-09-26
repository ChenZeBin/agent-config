---
name: youtube-ingest
description: 将公开单个 YouTube 视频的无凭据 yt-dlp 元数据和一条字幕轨固化为可验证、不可变的本地 raw 证据包。用户要求收录、归档、摄取或校验公开 YouTube watch、短链或 Shorts 视频时使用；不用于搜索、登录内容、直播、播放列表、视频/音频下载或非标准链接。
---

# YouTube 公开视频收录

先固化证据，再编译 Wiki。仅由 `article-ingest` 路由调用；`agents/openai.yaml` 禁止隐式调用。

## 边界

- 仅接收无凭据、无端口的 HTTPS `www.youtube.com/watch?v=<11-char-id>`、`youtu.be/<id>`、`www.youtube.com/shorts/<id>`；固定为 `https://www.youtube.com/watch?v=<id>`。
- 使用本机 `yt-dlp --ignore-config --skip-download --no-playlist`，不读取 Cookie、浏览器登录态或配置，不下载视频或音频。
- active/upcoming live、私密、删除、年龄/地区/登录受限或 availability 未明确为 `public`/`unlisted` 的内容必须失败；已结束直播作为 VOD 处理。
- 保存白名单归一化元数据、已脱敏的字幕轨清单，以及按“人工字幕优先；`zh-Hans`、`zh-Hant`、`zh`、`en`、原始语言、其余稳定排序”选择的一条精确 VTT 字幕。自动字幕仅可选与 `original_language` 完全一致的轨道，且显式记录 source language 与 translation state。
- yt-dlp 是工具中介，但 mutable stage 不能证明实际执行后端；因此 raw 只保存 `provenance_attestation: stage-declared-only`，不保存或声称已验证的 backend/工具版本，元数据与字幕均保持 `needs-review`。字幕异常只保存枚举 warning，绝不保存后端错误文本、URL 或凭据。
- 无法取到字幕时只允许 metadata-only：这不是“没有字幕”的结论；通用队列将其标为 `archive-only` 并排除在自动 compile claim 之外，不能作为已具备逐字稿的内容编译输入。

## 命令

在仓库根目录执行：

```bash
node .agents/skills/youtube-ingest/scripts/youtube_ingest.mjs stage --url 'https://youtu.be/dQw4w9WgXcQ'
node .agents/skills/youtube-ingest/scripts/youtube_ingest.mjs validate --stage 'ABSOLUTE_STAGE_PATH'
node .agents/skills/youtube-ingest/scripts/youtube_ingest.mjs promote --stage 'ABSOLUTE_STAGE_PATH'
node .agents/skills/youtube-ingest/scripts/youtube_ingest.mjs verify --raw 'ABSOLUTE_RAW_BUNDLE'
```

或以 `ingest --url URL` 顺序执行。`stage` 仅写新的 `staging/youtube/` 直接子目录；`promote` 在验证后以原子 rename 发布到 `raw/youtube/`。同一 canonical URL 与内容 checksum 已存在时返回 `duplicate-noop`，绝不覆盖原包。

`verifyRaw` 会返回 `transcript_available`、`subtitle_kind`、`subtitle_language` 与稳定轨道标识。只有至少一条有效时间 cue 被固化时 `transcript_available` 才是 `true`。manifest、文件清单、ID、选轨、确定性渲染、大小、路径或符号链接异常均 fail-closed。
