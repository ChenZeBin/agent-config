---
name: my-wiki-link
description: Use the global my-wiki-link CLI to identify, safely capture, or verify links supported by the local my-wiki repository. Use for mp.weixin.qq.com articles, WeChat Channels sph shares, public X/Twitter statuses, Bilibili BV videos, and single public YouTube videos. Do not treat raw capture as completed Wiki distillation.
---

# My Wiki Link

Use the deterministic `my-wiki-link` CLI as the thin execution layer. Keep platform policy and the full knowledge-ingestion workflow in the repository Skills.

## Route the request

- Identify or normalize a link without writing: `my-wiki-link classify 'URL' --json`.
- Check installation and adapter availability: `my-wiki-link doctor --json`.
- Preview the exact capture adapter without writing: `my-wiki-link capture 'URL' --dry-run --json`.
- Capture and atomically promote verified raw evidence only when the user asked to capture, archive, ingest, or distill that link: `my-wiki-link capture 'URL' --json`.
- Verify an existing immutable bundle: `my-wiki-link verify 'raw/<platform>/<bundle>' --json`.
- Inspect the platform-neutral compile queue without claiming it: `my-wiki-link queue scan --json`.

Use `--repo PATH` when the target repository is not discoverable. Discovery order is `--repo`, `MY_WIKI_ROOT`, the current directory and its parents, then `$HOME/my-wiki`.

## Preserve the knowledge boundary

Before a real capture, read `$MY_WIKI_ROOT/.agents/skills/article-ingest/SKILL.md` and the routed platform Skill completely. Their request ownership, immutable `raw/`, authenticity, transcript, retry, and lock rules remain authoritative; the CLI intentionally reuses those adapters.

`capture` ends at verified raw promotion. If the user says “炼化”, “llm wiki”, or asks for durable Wiki knowledge, continue in the same repository through source/canonical page compilation, index and append-only log updates, an independent semantic review, receipt creation, queue release, final `state: consistent`, and immediate consumption. Never describe `capture`, `promoted`, or `bookkeeping_state: consistent` alone as completed distillation.

The public WeChat Channels adapter is metadata-only unless its bundle independently contains media or a transcript. YouTube without a verified caption remains archive-only. Preserve every adapter's reported evidence limitation.

## Output and failure handling

Prefer `--json`; decide from `ok`, `platform`, `action`, `raw_bundle`, and the nested `backend` result. Treat nonzero exit status, `ok: false`, unsupported host/path, a retained lock, integrity failure, or missing evidence as a stop condition. Do not bypass a failed adapter with a generic web scraper.
