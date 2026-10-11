#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultRoot, initArchiveRoot, resolveArchiveRoot } from './archive-root.mjs';
import { createStage, promoteStage, ingestSession, verifyBundle } from './session_ingest.mjs';
import { resolveCodexSession } from './codex_session_resolve.mjs';

function args(argv) {
  const [command = 'help', ...rest] = argv;
  const options = {};
  const allowed = new Set(['output', 'input', 'source-app', 'title', 'occurred-at', 'origin', 'max-bytes', 'thread-id', 'codex-home', 'bundle']);
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--json') continue;
    const name = flag.slice(2);
    if (!flag.startsWith('--') || !allowed.has(name)) throw new Error(`未知参数: ${flag}`);
    const key = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = rest[++i];
    if (!value || value.startsWith('--') || Object.hasOwn(options, key)) throw new Error(`参数无效或重复: ${flag}`);
    options[key] = value;
  }
  return { command, options };
}
export async function main(argv = process.argv.slice(2)) {
  try {
    const { command, options } = args(argv);
    let result;
    if (['help', '--help', '-h'].includes(command)) {
      result = { ok: true, help: 'session-archive init [--output PATH]\nsession-archive doctor\nsession-archive resolve --thread-id UUID [--codex-home PATH]\nsession-archive ingest (--input FILE | --thread-id UUID) --title TITLE --occurred-at DATE [--source-app APP] [--output PATH]\nsession-archive verify --bundle BUNDLE\n所有命令输出 JSON。默认目录：ARCHIVE_ROOT 或 ~/codex-resource/archive。仅处理明确选定的原始文件/完整 UUID，不扫描历史；原始字节不脱敏。' };
    } else if (command === 'doctor') {
      result = { ok: true, version: '1.0.0', node: process.version, archive_root: path.resolve(options.output || defaultRoot()), requires_wiki: false, resolver_dependency: 'sqlite3; Codex state_5.sqlite schema' };
    } else if (command === 'init') {
      result = { ok: true, archive_root: await initArchiveRoot(options.output) };
    } else if (command === 'resolve') {
      result = await resolveCodexSession({ threadId: options.threadId, codexHome: options.codexHome });
    } else if (command === 'verify') {
      if (!options.bundle) throw new Error('verify 需要 --bundle');
      result = await verifyBundle(path.resolve(options.bundle), await resolveArchiveRoot(path.resolve(options.bundle)));
    } else if (command === 'ingest') {
      if (Boolean(options.input) === Boolean(options.threadId)) throw new Error('必须且只能提供 --input 或 --thread-id');
      if (!options.title || !options.occurredAt) throw new Error('需要 --title 与准确的 --occurred-at 日期，不推测会话元数据');
      const selected = options.threadId ? await resolveCodexSession({ threadId: options.threadId, codexHome: options.codexHome }) : null;
      const input = selected?.rollout_path || options.input;
      const before = selected ? await fs.lstat(input) : null;
      const ingestOptions = { ...options, input, repo: await initArchiveRoot(options.output), sourceApp: selected ? 'codex' : options.sourceApp || 'other', origin: options.origin || 'user-provided' };
      if (selected) {
        const staged = await createStage(ingestOptions);
        try {
          const afterSelection = await resolveCodexSession({ threadId: options.threadId, codexHome: options.codexHome });
          const after = await fs.lstat(input);
          if (afterSelection.rollout_path !== input || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('会话在读取期间发生变化');
          result = await promoteStage(staged);
        } finally { await fs.rm(staged.stage, { recursive: true, force: true }); }
      } else result = await ingestSession(ingestOptions);
    } else throw new Error(`未知命令: ${command}`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: e.message })}\n`);
    return 1;
  }
}
const entry = process.argv[1] && await fs.realpath(path.resolve(process.argv[1])).catch(() => null);
if (entry && import.meta.url === pathToFileURL(entry).href) process.exitCode = await main();
