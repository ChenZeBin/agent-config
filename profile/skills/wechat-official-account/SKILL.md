---
name: wechat-official-account
description: "Run the private WeChat Official Account webhook that accepts an exact copied mp.weixin.qq.com article URL, promotes it through my-wiki immutable intake, and triggers the LLM Wiki compiler plus an independent semantic reviewer."
---

# WeChat Official Account → my-wiki

Use this skill only when the user explicitly wants to run, test, diagnose, or maintain the local Official Account webhook. Read the repository `AGENTS.md`, this file, `../wechat-ingest/SKILL.md`, and `../wiki-knowledge-loop/SKILL.md` before changing the flow.

## Fixed contract

- Accept only authenticated WeChat callbacks containing one exact `https://mp.weixin.qq.com/s...` link message or pasted text link.
- Finish the WeChat ACK before intake, network fetch, or LLM work.
- In `pair` mode, reject all work and record only a sender HMAC. In `run` mode, only the configured sender HMAC may enqueue work.
- Do not persist callback XML or OpenID. Callback audit is strict redacted NDJSON. The accepted canonical article URL is retained only by the existing immutable source-intake provenance contract.
- Run jobs serially. Call `wechat_auto_capture.mjs` in-process so the URL is never placed in CLI arguments.
- Compile with `gpt-5.6-sol` and `model_reasoning_effort=max`; use a fresh second run for semantic review. Strip webhook and provider API secrets from both child environments.
- A job is complete only after `article_compile_queue.mjs scan` reports the exact bundle as `consistent`; otherwise retain the compile lock and show failure.
- Never modify existing `raw/` files, bypass the compile queue, weaken the quality receipt, or turn a failed/locked run into success.

## Commands

Install the pinned dependencies once from the repository root, then run the service commands from this skill directory. Build output goes to ignored `staging/wechat-official-account-dist/`, never below the durable skill tree.

```bash
cd $HOME/my-wiki
npm ci
cd .agents/skills/wechat-official-account
npm test
npm run build
npm start
```

The local secret file is exactly `$HOME/my-wiki/.agents/skills/wechat-official-account/.env`, must be mode `0600`, and must never be committed or pasted into a task.

Use [README.md](README.md) for the pairing, Quick Tunnel, WeChat callback, and acceptance sequence. Cloudflare Quick Tunnel is ephemeral; changing its URL requires updating `PUBLIC_BASE_URL` and the WeChat callback URL before restarting.
