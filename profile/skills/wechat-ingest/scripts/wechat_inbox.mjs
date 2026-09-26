#!/usr/bin/env node

// Deterministic receiver for visible extension exports.  It intentionally does
// not delete, rename, or otherwise acknowledge inbox files: a re-run is safe
// and promotion itself is idempotent.
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { canonicalizeUrl, promoteStage, readStableRegularFile, stageInput } from './wechat_ingest.mjs';

const MAX_ARCHIVE_BYTES = 550 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 2_000;
const MAX_ARTICLE_BYTES = 50 * 1024 * 1024;
const MAX_ASSET_BYTES = 500 * 1024 * 1024;
const MAX_ORIGIN_BYTES = 64 * 1024;
const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;

function fail(message, details = undefined) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertInside(parent, child, label) {
  if (!isInside(parent, child)) fail(`${label} 超出允许目录: ${child}`);
}

async function pathExists(target) {
  try {
    await fs.access(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveRepoRoot(value) {
  const root = path.resolve(value || process.cwd());
  if (!await pathExists(path.join(root, 'AGENTS.md')) || !await pathExists(path.join(root, 'wiki'))) {
    fail(`不是有效 wiki 仓库: ${root}`);
  }
  return root;
}

async function lstatRegularFile(filePath, label) {
  const stat = await fs.lstat(filePath).catch(() => null);
  if (!stat) fail(`${label} 不存在: ${filePath}`);
  if (stat.isSymbolicLink()) fail(`${label} 不允许符号链接: ${filePath}`);
  if (!stat.isFile()) fail(`${label} 必须是普通文件: ${filePath}`);
  return stat;
}

function decodeUtf8(buffer, label) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    if (text.includes('\0')) fail(`${label} 包含 NUL 字节`);
    return text;
  } catch (error) {
    if (error.message?.includes('NUL')) throw error;
    fail(`${label} 不是有效 UTF-8`);
  }
}

function safeRelativeZipPath(name) {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    fail(`ZIP 条目路径无效: ${JSON.stringify(name)}`);
  }
  const isDirectory = name.endsWith('/');
  const parts = name.split('/');
  if (isDirectory) parts.pop();
  if (!parts.length || parts.some((part) => !part || part === '.' || part === '..')) {
    fail(`ZIP 条目路径越界: ${JSON.stringify(name)}`);
  }
  return { path: parts.join('/'), isDirectory };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function findEndOfCentralDirectory(buffer) {
  const start = Math.max(0, buffer.length - 0x10016);
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_EOCD) return offset;
  }
  fail('ZIP 缺少有效的中央目录');
}

function parseZipArchive(buffer) {
  if (buffer.length < 22) fail('ZIP 文件过小');
  const eocd = findEndOfCentralDirectory(buffer);
  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) fail('不支持多磁盘 ZIP');
  if (entryCount === 0 || entryCount === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    fail('不支持空 ZIP 或 ZIP64');
  }
  if (entryCount > MAX_ARCHIVE_ENTRIES) fail(`ZIP 条目超过 ${MAX_ARCHIVE_ENTRIES} 个上限`);
  if (centralOffset + centralSize > eocd) fail('ZIP 中央目录越界');

  const entries = [];
  const names = new Set();
  let cursor = centralOffset;
  let articleBytes = 0;
  let originBytes = 0;
  let assetBytes = 0;
  const attachmentRoots = new Set();
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > centralOffset + centralSize || buffer.readUInt32LE(cursor) !== ZIP_CENTRAL) fail('ZIP 中央目录条目无效');
    const madeBy = buffer.readUInt16LE(cursor + 4);
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const expectedCrc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > centralOffset + centralSize || localOffset === 0xffffffff) fail('ZIP 条目长度或偏移无效');
    if (flags & 0x0001) fail('不接受加密 ZIP');
    if (![0, 8].includes(method)) fail(`ZIP 使用了不支持的压缩方法: ${method}`);
    const name = decodeUtf8(buffer.subarray(cursor + 46, cursor + 46 + nameLength), 'ZIP 文件名');
    const normalized = safeRelativeZipPath(name);
    if (names.has(normalized.path)) fail(`ZIP 包含重复条目: ${normalized.path}`);
    names.add(normalized.path);

    const unixMode = (externalAttributes >>> 16) & 0xffff;
    const type = unixMode & 0o170000;
    if (type && type !== 0o100000 && type !== 0o040000) fail(`ZIP 不允许符号链接或特殊文件: ${normalized.path}`);
    if (normalized.isDirectory) {
      if (type && type !== 0o040000) fail(`ZIP 目录类型无效: ${normalized.path}`);
      if (compressedSize !== 0 || uncompressedSize !== 0) fail(`ZIP 目录不能含数据: ${normalized.path}`);
    } else if (type === 0o040000) {
      fail(`ZIP 文件条目是目录: ${normalized.path}`);
    }

    if (!normalized.isDirectory) {
      if (normalized.path === 'article.md') articleBytes += uncompressedSize;
      else if (normalized.path === 'origin.json') originBytes += uncompressedSize;
      else if (normalized.path.startsWith('assets/')) {
        attachmentRoots.add('assets');
        assetBytes += uncompressedSize;
      } else if (normalized.path.startsWith('images/')) {
        attachmentRoots.add('images');
        assetBytes += uncompressedSize;
      } else fail(`ZIP 仅允许 article.md、可选 origin.json 与 assets/ 或 images/: ${normalized.path}`);
    }
    if (articleBytes > MAX_ARTICLE_BYTES || originBytes > MAX_ORIGIN_BYTES || assetBytes > MAX_ASSET_BYTES) {
      fail('ZIP 解压后内容超过文章、元数据或附件大小上限');
    }
    entries.push({
      path: normalized.path,
      isDirectory: normalized.isDirectory,
      flags,
      method,
      expectedCrc,
      compressedSize,
      uncompressedSize,
      localOffset,
    });
    cursor = next;
  }
  if (cursor !== centralOffset + centralSize) fail('ZIP 中央目录存在未解析数据');
  const regular = entries.filter((entry) => !entry.isDirectory);
  if (regular.filter((entry) => entry.path === 'article.md').length !== 1) fail('ZIP 必须且只能包含一个 article.md');
  if (regular.filter((entry) => entry.path === 'origin.json').length > 1) fail('ZIP 最多包含一个 origin.json');
  if (attachmentRoots.size > 1) fail('ZIP 不能同时包含 assets/ 与 images/');
  return entries;
}

function extractZipEntry(archive, entry) {
  if (entry.localOffset + 30 > archive.length || archive.readUInt32LE(entry.localOffset) !== ZIP_LOCAL) fail(`ZIP 本地条目无效: ${entry.path}`);
  const localFlags = archive.readUInt16LE(entry.localOffset + 6);
  const localMethod = archive.readUInt16LE(entry.localOffset + 8);
  const nameLength = archive.readUInt16LE(entry.localOffset + 26);
  const extraLength = archive.readUInt16LE(entry.localOffset + 28);
  if ((localFlags & 0x0001) || localMethod !== entry.method) fail(`ZIP 本地条目元数据不一致: ${entry.path}`);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (start > archive.length || end > archive.length) fail(`ZIP 压缩数据越界: ${entry.path}`);
  const compressed = archive.subarray(start, end);
  let output;
  try {
    output = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize });
  } catch {
    fail(`ZIP 解压失败: ${entry.path}`);
  }
  if (output.length !== entry.uncompressedSize || crc32(output) !== entry.expectedCrc) fail(`ZIP 数据校验失败: ${entry.path}`);
  return output;
}

function readOrigin(buffer, label, { ignoreCaptureFields = false } = {}) {
  let value;
  try {
    value = JSON.parse(decodeUtf8(buffer, label));
  } catch (error) {
    fail(`${label} 不是有效 JSON: ${error.message}`);
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') fail(`${label} 必须是 JSON 对象`);
  if (typeof value.origin_url !== 'string' || !value.origin_url.trim()) fail(`${label} 必须提供非空 origin_url`);
  const optionalStrings = ['title', 'publisher', 'published_at', 'retrieved', 'capture_method', 'source_authenticity'];
  for (const key of optionalStrings) {
    if (value[key] !== undefined && typeof value[key] !== 'string') fail(`${label}.${key} 必须是字符串`);
  }
  const canonical = canonicalizeUrl(value.origin_url);
  if (new URL(canonical).hostname !== 'mp.weixin.qq.com') fail(`${label}.origin_url 必须是 mp.weixin.qq.com 文章 URL`);
  const hasCaptureFields = !ignoreCaptureFields
    && (value.capture_method !== undefined || value.source_authenticity !== undefined || value.provenance_evidence !== undefined);
  if (hasCaptureFields) {
    if (value.capture_method !== 'wechatsync-url-zip' || value.source_authenticity !== 'browser-extension-verified') {
      fail(`${label} 的 capture 真实性字段无效`);
    }
    if (!value.provenance_evidence || Array.isArray(value.provenance_evidence) || typeof value.provenance_evidence !== 'object') {
      fail(`${label}.provenance_evidence 必须是对象`);
    }
    for (const key of ['submitted_url', 'page_url', 'article_url', 'zip_origin_url']) {
      if (typeof value.provenance_evidence[key] !== 'string'
        || canonicalizeUrl(value.provenance_evidence[key]) !== canonical) {
        fail(`${label}.provenance_evidence.${key} 与 origin_url 不一致`);
      }
    }
    if (typeof value.provenance_evidence.verified_at !== 'string'
      || Number.isNaN(Date.parse(value.provenance_evidence.verified_at))) {
      fail(`${label}.provenance_evidence.verified_at 无效`);
    }
  }
  return {
    url: value.origin_url,
    title: value.title,
    publisher: value.publisher,
    publishedAt: value.published_at,
    retrieved: value.retrieved,
    captureMethod: hasCaptureFields ? value.capture_method : 'file-import',
    sourceAuthenticity: hasCaptureFields ? value.source_authenticity : 'declared-only',
    provenanceEvidence: hasCaptureFields ? value.provenance_evidence : undefined,
  };
}

async function ensureInbox(repoRoot) {
  const stagingRoot = path.join(repoRoot, 'staging');
  let stagingStat = await fs.lstat(stagingRoot).catch(() => null);
  if (!stagingStat) {
    await fs.mkdir(stagingRoot);
    stagingStat = await fs.lstat(stagingRoot);
  }
  if (!stagingStat.isDirectory() || stagingStat.isSymbolicLink()) fail(`staging 目录无效: ${stagingRoot}`);
  const inbox = path.join(stagingRoot, 'inbox');
  let stat = await fs.lstat(inbox).catch(() => null);
  if (!stat) {
    await fs.mkdir(inbox);
    stat = await fs.lstat(inbox);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`收件箱目录无效: ${inbox}`);
  return inbox;
}

async function safeZipToTemporaryInput(archivePath, repoRoot) {
  const archiveStat = await lstatRegularFile(archivePath, 'ZIP 收件箱文件');
  if (archiveStat.size > MAX_ARCHIVE_BYTES) fail(`ZIP 超过 ${MAX_ARCHIVE_BYTES} 字节上限`);
  const archive = await readStableRegularFile(archivePath, 'ZIP 收件箱文件', MAX_ARCHIVE_BYTES);
  const entries = parseZipArchive(archive);
  const temporary = await fs.mkdtemp(path.join(repoRoot, 'staging', '.inbox-zip-'));
  try {
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const destination = path.join(temporary, entry.path);
      assertInside(temporary, destination, 'ZIP 解压目标');
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, extractZipEntry(archive, entry), { flag: 'wx' });
    }
    return temporary;
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function stageAndPromote({ repo, input, assets, assetsAt, origin }) {
  const staged = await stageInput({ repo, input, assets, assetsAt: assets ? assetsAt : undefined, ...origin });
  return promoteStage(staged.stage, repo);
}

function inboxResult(input, kind, status, extra = {}) {
  return { input, kind, status, ...extra };
}

function declaredOnlyOrigin(origin) {
  return {
    ...origin,
    captureMethod: 'file-import',
    sourceAuthenticity: 'declared-only',
    provenanceEvidence: undefined,
  };
}

async function processMarkdownInboxFile(repoRoot, inbox, entry) {
  const stem = entry.name.slice(0, -path.extname(entry.name).length);
  const input = path.join(inbox, entry.name);
  const sidecar = path.join(inbox, `${stem}.json`);
  const assets = path.join(inbox, `${stem}.assets`);
  if (!await pathExists(sidecar)) return inboxResult(entry.name, 'markdown', 'rejected', { error: '缺少同名 origin sidecar JSON' });
  try {
    await lstatRegularFile(input, 'Markdown 收件箱文件');
    const sidecarStat = await lstatRegularFile(sidecar, 'origin sidecar JSON');
    if (sidecarStat.size > MAX_ORIGIN_BYTES) fail(`origin sidecar 超过 ${MAX_ORIGIN_BYTES} 字节上限`);
    const origin = declaredOnlyOrigin(readOrigin(
      await readStableRegularFile(sidecar, 'origin sidecar JSON', MAX_ORIGIN_BYTES),
      `${stem}.json`,
    ));
    let assetsPath;
    if (await pathExists(assets)) {
      const assetStat = await fs.lstat(assets);
      if (!assetStat.isDirectory() || assetStat.isSymbolicLink()) fail(`同名 assets 必须是普通目录: ${assets}`);
      assetsPath = assets;
    }
    const promoted = await stageAndPromote({ repo: repoRoot, input, assets: assetsPath, assetsAt: 'assets', origin });
    return inboxResult(entry.name, 'markdown', promoted.action, {
      raw_bundle: promoted.raw_bundle,
      bundle_checksum: promoted.bundle_checksum,
      warnings: promoted.warnings,
    });
  } catch (error) {
    return inboxResult(entry.name, 'markdown', 'failed', { error: error.message });
  }
}

async function processZipInboxFile(repoRoot, inbox, entry, { allowVerifiedUrlZip = false } = {}) {
  const archive = path.join(inbox, entry.name);
  const stem = path.basename(entry.name, path.extname(entry.name));
  let temporary;
  try {
    temporary = await safeZipToTemporaryInput(archive, repoRoot);
    const embeddedOrigin = path.join(temporary, 'origin.json');
    const externalOrigin = path.join(inbox, `${stem}.json`);
    const originPath = await pathExists(embeddedOrigin) ? embeddedOrigin : externalOrigin;
    if (!await pathExists(originPath)) fail(`ZIP 缺少 origin.json，且未找到同名外部 sidecar: ${stem}.json`);
    const originLabel = originPath === embeddedOrigin ? 'origin.json' : `${stem}.json`;
    let origin = readOrigin(
      await readStableRegularFile(originPath, originLabel, MAX_ORIGIN_BYTES),
      originLabel,
    );
    if (originPath === externalOrigin || !allowVerifiedUrlZip) origin = declaredOnlyOrigin(origin);
    const attachmentRoot = await pathExists(path.join(temporary, 'images')) ? 'images' : 'assets';
    const assets = path.join(temporary, attachmentRoot);
    const promoted = await stageAndPromote({
      repo: repoRoot,
      input: path.join(temporary, 'article.md'),
      assets: await pathExists(assets) ? assets : undefined,
      assetsAt: attachmentRoot,
      origin,
    });
    return inboxResult(entry.name, 'zip', promoted.action, {
      raw_bundle: promoted.raw_bundle,
      bundle_checksum: promoted.bundle_checksum,
      warnings: promoted.warnings,
    });
  } catch (error) {
    return inboxResult(entry.name, 'zip', 'failed', { error: error.message });
  } finally {
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function scanInbox(options = {}) {
  const repoRoot = await resolveRepoRoot(options.repo);
  const inbox = await ensureInbox(repoRoot);
  const directoryEntries = await fs.readdir(inbox, { withFileTypes: true });
  const target = options.target;
  if (target !== undefined && (typeof target !== 'string' || path.basename(target) !== target
    || target.startsWith('.') || !target.toLowerCase().endsWith('.zip'))) {
    fail('--target 必须是收件箱内非隐藏 .zip 文件名');
  }
  const results = [];
  for (const entry of directoryEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (target !== undefined && entry.name !== target) continue;
    const lower = entry.name.toLowerCase();
    if (entry.name.startsWith('.')) continue;
    if (entry.isSymbolicLink()) {
      results.push(inboxResult(entry.name, 'unknown', 'rejected', { error: '收件箱不允许符号链接' }));
    } else if (entry.isFile() && lower.endsWith('.md')) {
      results.push(await processMarkdownInboxFile(repoRoot, inbox, entry));
    } else if (entry.isFile() && lower.endsWith('.zip')) {
      results.push(await processZipInboxFile(repoRoot, inbox, entry, {
        allowVerifiedUrlZip: options.urlZipVerified === true && target === entry.name,
      }));
    } else if (!entry.isFile() && !entry.isDirectory()) {
      results.push(inboxResult(entry.name, 'unknown', 'rejected', { error: '收件箱不允许特殊文件' }));
    }
  }
  const failed = results.filter((result) => ['failed', 'rejected'].includes(result.status));
  return {
    ok: failed.length === 0,
    action: 'inbox-scanned',
    inbox,
    processed: results.length,
    succeeded: results.filter((result) => ['promoted', 'duplicate-noop'].includes(result.status)).length,
    failed: failed.length,
    entries: results,
  };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith('--')) fail(`无法识别的参数: ${item}`);
    const [key, inline] = item.slice(2).split(/=(.*)/s, 2);
    if (!['repo', 'target'].includes(key) || Object.hasOwn(options, key)) fail(`无法识别或重复的参数: ${item}`);
    const value = inline ?? rest[++index];
    if (!value || value.startsWith('--')) fail(`参数缺少值: ${item}`);
    options[key] = value;
  }
  return { command, options };
}

async function main(argv) {
  const { command, options } = parseArgs(argv);
  if (command !== 'scan') fail('用法: wechat_inbox.mjs scan [--repo PATH] [--target NAME.zip]');
  const result = await scanInbox(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 2;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message, details: error.details }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

export { extractZipEntry, parseZipArchive, readOrigin, scanInbox };
