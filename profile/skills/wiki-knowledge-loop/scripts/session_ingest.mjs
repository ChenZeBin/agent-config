#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_PATTERN_BYTES = 1024 * 1024;
const SCHEMA_VERSION = 1;
const FORMATS = new Set(['json', 'jsonl', 'md', 'txt']);

function fail(message) { throw new Error(message); }
function sha256(value) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function checksum(value) { return sha256(Buffer.from(canonicalJson(value))); }
function posix(value) { return value.split(path.sep).join('/'); }
function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function assertInside(parent, child, label) { if (!isInside(parent, child)) fail(`${label}超出允许目录: ${child}`); }
function nonEmptyString(value, label, max = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label}无效`);
  return value.trim();
}
function markdownText(value) { return value.replace(/[\r\n]+/g, ' ').replace(/([\\`])/g, '\\$1'); }

async function plainDirectory(target, label, { create = false } = {}) {
  if (create) await fs.mkdir(target, { recursive: false }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail(`${label}不是普通目录: ${target}`);
  return target;
}
async function regularFile(target, label) {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) fail(`${label}不是普通文件: ${target}`);
  return stat;
}
async function ensureDirectoryChain(root, parts, label, create = false) {
  await plainDirectory(root, '仓库根目录');
  let current = root;
  for (const part of parts) {
    if (!/^[A-Za-z0-9._-]+$/.test(part)) fail(`${label}路径段无效: ${part}`);
    current = path.join(current, part);
    assertInside(root, current, label);
    await plainDirectory(current, label, { create });
  }
  return current;
}
async function findRepo(value) {
  let current = path.resolve(value || process.cwd());
  while (true) {
    const agents = await fs.lstat(path.join(current, 'AGENTS.md')).catch(() => null);
    const wiki = await fs.lstat(path.join(current, 'wiki')).catch(() => null);
    if (agents?.isFile() && !agents.isSymbolicLink() && wiki?.isDirectory() && !wiki.isSymbolicLink()) {
      await plainDirectory(current, '仓库根目录');
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) fail('找不到同时含 AGENTS.md 和 wiki/ 的仓库根目录；请传入 --repo');
    current = parent;
  }
}
async function safeSessionRoots(repo, create = false) {
  const staging = await ensureDirectoryChain(repo, ['staging', 'session'], 'staging/session', create);
  const raw = await ensureDirectoryChain(repo, ['raw', 'sessions'], 'raw/sessions', create);
  return { staging, raw };
}
async function safeRawSessions(repo, create = false) { return ensureDirectoryChain(repo, ['raw', 'sessions'], 'raw/sessions', create); }
function parseMaxBytes(value) {
  if (value === undefined) return DEFAULT_MAX_BYTES;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) fail('--max-bytes 必须是正整数');
  return Number(value);
}
function parseOccurredAt(value) {
  const input = nonEmptyString(value, '--occurred-at', 64);
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const date = new Date(`${input}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== input) fail('--occurred-at 日期无效');
    return { occurred_at: input, date: input };
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input)) fail('--occurred-at 必须是 ISO 日期或带时区的 ISO 时间');
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) fail('--occurred-at 日期无效');
  return { occurred_at: date.toISOString(), date: input.slice(0, 10) };
}
function parseSourceApp(value) {
  const sourceApp = nonEmptyString(value, '--source-app', 100);
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(sourceApp)) fail('--source-app 仅接受字母、数字、空格、点、下划线和连字符');
  return sourceApp;
}
function parseOrigin(value) {
  const origin = nonEmptyString(value, '--origin', 1024);
  if (origin === 'user-provided' || origin === 'unknown') return origin;
  let url;
  try { url = new URL(origin); } catch { fail('--origin 必须是 user-provided、unknown 或无凭据 HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) fail('--origin 必须是无凭据、无端口、无 fragment 的 HTTPS URL');
  return url.toString();
}
function sourceFormat(input) {
  const extension = path.extname(input).slice(1).toLowerCase();
  if (!FORMATS.has(extension)) fail('仅支持 .json、.jsonl、.md 或 .txt 会话文件');
  return extension;
}
function safeTitle(value) {
  const title = nonEmptyString(value, '--title', 240);
  return title;
}
function slug(value) {
  return value.normalize('NFKC').replace(/\s+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 72) || 'session';
}
async function readStableFile(input, maxBytes, label) {
  const resolved = path.resolve(input);
  const before = await regularFile(resolved, label);
  if (before.size > maxBytes) fail(`${label}超过 ${maxBytes} 字节上限`);
  const handle = await fs.open(resolved, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) fail(`${label}在读取前发生变化或不是普通文件`);
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) fail(`${label}在读取时发生变化`);
      offset += bytesRead;
    }
    const after = await fs.lstat(resolved);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail(`${label}在读取时发生变化`);
    return { path: resolved, bytes, stat };
  } finally { await handle.close(); }
}
async function redactPatterns(input) {
  if (!input) return { patterns: [], metadata: { requested: false, pattern_count: 0 } };
  const file = await readStableFile(input, MAX_PATTERN_BYTES, '脱敏规则文件');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes); } catch { fail('脱敏规则文件不是有效 UTF-8'); }
  const patterns = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try { patterns.push(new RegExp(line, 'gu')); } catch { fail('脱敏规则文件含无效正则表达式'); }
  }
  if (!patterns.length) fail('脱敏规则文件不含任何正则表达式');
  return { patterns, metadata: { requested: true, pattern_count: patterns.length, pattern_file_sha256: sha256(file.bytes) } };
}
function redact(value, patterns) { return patterns.reduce((result, pattern) => result.replace(pattern, '[REDACTED]'), value); }
async function recordFile(root, relative) {
  const target = path.join(root, relative);
  assertInside(root, target, '归档文件');
  const stat = await regularFile(target, '归档文件');
  const bytes = await fs.readFile(target);
  if (bytes.length !== stat.size) fail(`归档文件读取长度异常: ${relative}`);
  return { path: posix(relative), bytes: bytes.length, sha256: sha256(bytes) };
}
async function inventory(root) {
  await plainDirectory(root, '会话包');
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) fail(`会话包不允许符号链接: ${entry.name}`);
    if (!entry.isFile()) fail(`会话包不允许目录或特殊文件: ${entry.name}`);
    if (entry.name === 'manifest.json') continue;
    files.push(await recordFile(root, entry.name));
  }
  return files;
}
function exactFileList(left, right) { return canonicalJson(left) === canonicalJson(right); }
function manifestBody(manifest) { const { bundle_checksum: ignored, ...body } = manifest; return body; }
function validateManifestShape(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('manifest 无效');
  if (manifest.schema_version !== SCHEMA_VERSION || manifest.kind !== 'session-file-bundle' || manifest.state !== 'immutable') fail('manifest schema 无效');
  if (manifest.source_authenticity !== 'user-provided') fail('manifest 来源真实性无效');
  if (!manifest.source || typeof manifest.source !== 'object' || !manifest.capture || typeof manifest.capture !== 'object') fail('manifest 缺少来源或采集元数据');
  if (manifest.capture_scope !== 'explicit-file') fail('manifest capture scope 无效');
  parseSourceApp(manifest.source.source_app); safeTitle(manifest.source.title); const occurred = parseOccurredAt(manifest.source.occurred_at); parseOrigin(manifest.source.origin);
  if (manifest.source.date !== occurred.date) fail('manifest 发生日期不一致');
  if (typeof manifest.source.input_filename !== 'string' || !/^[^/\\\0]{1,255}$/.test(manifest.source.input_filename)) fail('manifest 输入文件名无效');
  if (!FORMATS.has(manifest.source.format)) fail('manifest 输入格式无效');
  if (manifest.capture.method !== 'explicit-file-copy' || !manifest.capture.redaction || typeof manifest.capture.redaction !== 'object' || typeof manifest.capture.redaction.requested !== 'boolean' || !Number.isInteger(manifest.capture.redaction.pattern_count) || manifest.capture.redaction.pattern_count < 0) fail('manifest 脱敏元数据无效');
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.warnings) || typeof manifest.content_checksum !== 'string' || typeof manifest.bundle_checksum !== 'string') fail('manifest 文件清单或 checksum 无效');
}
async function verifyBundle(bundle, repo) {
  const root = await findRepo(repo || bundle);
  const raw = await safeRawSessions(root, false);
  const resolved = path.resolve(bundle);
  assertInside(raw, resolved, '会话原文包');
  if (path.dirname(resolved) !== raw) fail('会话原文包必须是 raw/sessions/ 的直接子目录');
  await plainDirectory(resolved, '会话原文包');
  const manifestPath = path.join(resolved, 'manifest.json');
  await regularFile(manifestPath, 'manifest.json');
  let manifest;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(manifestPath))); } catch { fail('manifest.json 不是有效 UTF-8 JSON'); }
  validateManifestShape(manifest);
  const files = await inventory(resolved);
  if (!exactFileList(files, manifest.files)) fail('manifest 文件清单与实际文件不一致');
  const expectedPaths = ['article.md', `session.${manifest.source.format}`].sort();
  if (files.length !== 2 || !exactFileList(files.map((item) => item.path).sort(), expectedPaths)) fail('会话包文件布局无效');
  if (checksum(files) !== manifest.content_checksum) fail('manifest 内容校验和不一致');
  if (checksum(manifestBody(manifest)) !== manifest.bundle_checksum) fail('manifest bundle_checksum 不一致');
  return { ok: true, state: 'verified', raw_bundle: resolved, manifest: manifestPath, bundle_checksum: manifest.bundle_checksum, warnings: manifest.warnings };
}
function articleMarkdown(source, originalPath, redaction) {
  const title = markdownText(redact(source.title, redaction.patterns));
  const app = markdownText(redact(source.source_app, redaction.patterns));
  const origin = markdownText(redact(source.origin, redaction.patterns));
  return `# 会话导入元数据\n\n- 标题：${title}\n- 来源应用：${app}\n- 发生时间：${source.occurred_at}\n- 来源：${origin}\n- 原始文件：[${originalPath}](./${originalPath})\n\n> 此文件仅保存安全的派生元数据，不复制会话全文。原始会话以逐字节内容保存在上方链接文件中；即使提供了脱敏规则，本工具也不声称原始内容已完成脱敏。\n`;
}
async function createStage(options) {
  const repo = await findRepo(options.repo);
  const { staging } = await safeSessionRoots(repo, true);
  const input = nonEmptyString(options.input, '--input', 4096);
  const source = {
    source_app: parseSourceApp(options.sourceApp),
    title: safeTitle(options.title),
    ...parseOccurredAt(options.occurredAt),
    origin: parseOrigin(options.origin),
    input_filename: path.basename(path.resolve(input)),
    format: sourceFormat(input),
  };
  const original = await readStableFile(input, parseMaxBytes(options.maxBytes), '输入会话文件');
  const redaction = await redactPatterns(options.redactPatternFile);
  const job = `.capture-${Date.now()}-${process.pid}-${randomBytes(6).toString('hex')}`;
  const stage = path.join(staging, job);
  assertInside(staging, stage, '暂存目录');
  await fs.mkdir(stage, { recursive: false });
  try {
    const originalPath = `session.${source.format}`;
    await fs.writeFile(path.join(stage, originalPath), original.bytes, { flag: 'wx' });
    await fs.writeFile(path.join(stage, 'article.md'), articleMarkdown(source, originalPath, redaction), { flag: 'wx' });
    const files = await inventory(stage);
    const warnings = [
      '原始会话文件按原始字节保存；本工具不声明其中内容已完整脱敏。',
      ...(redaction.metadata.requested ? ['--redact-pattern-file 仅用于派生元数据呈现；原始会话文件不会被改写。'] : []),
    ];
    const body = {
      schema_version: SCHEMA_VERSION,
      kind: 'session-file-bundle',
      state: 'immutable',
      capture_scope: 'explicit-file',
      source_authenticity: 'user-provided',
      source,
      capture: { captured_at: new Date().toISOString(), method: 'explicit-file-copy', redaction: redaction.metadata },
      files,
      content_checksum: checksum(files),
      warnings,
      promoted_at: new Date().toISOString(),
    };
    const manifest = { ...body, bundle_checksum: checksum(body) };
    await fs.writeFile(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    validateManifestShape(manifest);
    return { repo, stage, source, manifest };
  } catch (error) { await fs.rm(stage, { recursive: true, force: true }); throw error; }
}
async function existingDuplicate(finalPath, stagedManifest, repo) {
  const verified = await verifyBundle(finalPath, repo);
  const existing = JSON.parse(await fs.readFile(verified.manifest, 'utf8'));
  const exact = canonicalJson({ source: existing.source, capture: { method: existing.capture.method, redaction: existing.capture.redaction }, content_checksum: existing.content_checksum })
    === canonicalJson({ source: stagedManifest.source, capture: { method: stagedManifest.capture.method, redaction: stagedManifest.capture.redaction }, content_checksum: stagedManifest.content_checksum });
  if (!exact) fail(`目标会话包已存在但不是完全重复输入: ${finalPath}`);
  return { ok: true, state: 'duplicate-noop', action: 'duplicate-noop', raw_bundle: finalPath, manifest: verified.manifest, bundle_checksum: verified.bundle_checksum, warnings: verified.warnings };
}
async function promoteStage(staged) {
  const { repo, stage, source, manifest } = staged;
  const { staging, raw } = await safeSessionRoots(repo, true);
  assertInside(staging, stage, '暂存目录');
  await plainDirectory(stage, '暂存目录');
  const c8 = manifest.files.find((item) => item.path === `session.${source.format}`)?.sha256.slice('sha256:'.length, 'sha256:'.length + 8);
  if (!c8) fail('暂存会话包缺少原始文件 checksum');
  const name = `${source.date}--${slug(source.title)}--${c8}`;
  const finalPath = path.join(raw, name);
  assertInside(raw, finalPath, '目标会话包');
  const lockRoot = path.join(staging, '.promotion-locks');
  await plainDirectory(lockRoot, '暂存 promotion 锁目录', { create: true });
  const lock = path.join(lockRoot, `${name}.lock`);
  let lockHandle;
  try {
    lockHandle = await fs.open(lock, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') fail(`目标会话包正在由其他摄取任务处理: ${name}`);
    throw error;
  }
  try {
    const target = await fs.lstat(finalPath).catch(() => null);
    if (target) return existingDuplicate(finalPath, manifest, repo);
    // The complete stage is verified before a guarded directory rename. The wx lock prevents
    // cooperating ingestors from reaching a replace-capable rename concurrently.
    const stageFiles = await inventory(stage);
    if (!exactFileList(stageFiles, manifest.files)) fail('暂存会话包在 promotion 前发生变化');
    if (checksum(stageFiles) !== manifest.content_checksum || checksum(manifestBody(manifest)) !== manifest.bundle_checksum) fail('暂存 manifest 校验失败');
    await fs.rename(stage, finalPath);
    const verified = await verifyBundle(finalPath, repo);
    return { ok: true, state: 'promoted', action: 'promoted', raw_bundle: finalPath, manifest: verified.manifest, bundle_checksum: verified.bundle_checksum, warnings: verified.warnings };
  } finally {
    await lockHandle.close().catch(() => {});
    await fs.unlink(lock).catch(() => {});
  }
}
export async function ingestSession(options) {
  const staged = await createStage(options);
  try { return await promoteStage(staged); } catch (error) { if (await fs.lstat(staged.stage).catch(() => null)) await fs.rm(staged.stage, { recursive: true, force: true }); throw error; }
}
function parseArgs(argv) {
  const commands = new Set(['ingest', 'verify']);
  let command = argv[0]; let rest = argv.slice(1);
  if (!commands.has(command)) { command = 'ingest'; rest = argv; }
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith('--')) fail(`无效参数: ${item}`);
    const key = item.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = rest[++index];
    if (!value || value.startsWith('--') || Object.hasOwn(options, key)) fail(`参数无效或重复: ${item}`);
    options[key] = value;
  }
  return { command, options };
}
function help() { return '显式会话文件不可变摄取器\n\n用法:\n  session_ingest.mjs ingest --input FILE --source-app APP --title TITLE --occurred-at ISO_DATE --origin ORIGIN [--redact-pattern-file FILE] [--max-bytes N] [--repo PATH]\n  session_ingest.mjs verify --bundle RAW_SESSION_BUNDLE [--repo PATH]'; }
async function main(argv) {
  if (!argv.length || ['help', '-h', '--help'].includes(argv[0])) { process.stdout.write(`${help()}\n`); return; }
  const { command, options } = parseArgs(argv);
  let result;
  if (command === 'ingest') {
    for (const key of ['input', 'sourceApp', 'title', 'occurredAt', 'origin']) if (!options[key]) fail(`ingest 需要 --${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
    result = await ingestSession(options);
  } else {
    if (!options.bundle) fail('verify 需要 --bundle');
    result = await verifyBundle(options.bundle, options.repo);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
const direct = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (direct) main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${JSON.stringify({ ok: false, state: 'failed', error: error.message }, null, 2)}\n`); process.exitCode = 1; });

export { createStage, parseArgs, promoteStage, verifyBundle };
