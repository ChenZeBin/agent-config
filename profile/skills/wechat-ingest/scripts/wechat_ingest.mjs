#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD_PATH = path.join(SCRIPT_DIR, 'loopback-preload.cjs');
const DEFAULT_PORT = 9527;
const MAX_ARTICLE_BYTES = 50 * 1024 * 1024;
const MAX_ASSET_BYTES = 500 * 1024 * 1024;
const MAX_METADATA_BYTES = 5 * 1024 * 1024;
const SCHEMA_VERSION = 1;
const SOURCE_AUTHENTICITY = new Map([
  ['declared-only', 0],
  ['browser-extension-verified', 1],
  ['wechat-origin-response', 2],
]);

function fail(message, details = undefined) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function checksum(value) {
  return `sha256:${sha256(canonicalJson(value))}`;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertInside(parent, child, label) {
  if (!isInside(parent, child)) fail(`${label} 超出允许目录: ${child}`);
}

function canonicalizeUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    fail(`无效 URL: ${rawUrl}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) fail('来源 URL 必须使用 http 或 https');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || ['spm', 'from', 'source'].includes(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  url.hostname = url.hostname.toLowerCase();
  return url.toString();
}

function slugify(value) {
  const slug = String(value || 'article')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'article';
}

function isoNow() {
  return new Date().toISOString();
}

function localDate() {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function validateDate(value, label, { allowDateTime = false } = {}) {
  if (!value || value === 'unknown') return value || 'unknown';
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (parsed.getUTCFullYear() !== Number(year)
      || parsed.getUTCMonth() + 1 !== Number(month)
      || parsed.getUTCDate() !== Number(day)) fail(`${label} 日期不存在: ${value}`);
    return value;
  }
  if (!allowDateTime || !/^\d{4}-\d{2}-\d{2}T.+Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    fail(`${label} 格式无效: ${value}`);
  }
  return value;
}

async function pathExists(target) {
  try {
    await fs.access(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function findRepoRoot(start = process.cwd()) {
  let current = path.resolve(start);
  while (true) {
    if (await pathExists(path.join(current, 'AGENTS.md')) && await pathExists(path.join(current, 'wiki'))) return current;
    const parent = path.dirname(current);
    if (parent === current) fail('找不到 wiki 仓库根目录；请使用 --repo 指定');
    current = parent;
  }
}

async function resolveRepoRoot(value) {
  const root = value ? path.resolve(value) : await findRepoRoot();
  if (!await pathExists(path.join(root, 'AGENTS.md'))) fail(`不是有效 wiki 仓库: ${root}`);
  return root;
}

async function ensurePlainDirectory(target, label, { create = false } = {}) {
  let stat = await fs.lstat(target).catch(() => null);
  if (!stat && create) {
    await fs.mkdir(target);
    stat = await fs.lstat(target);
  }
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail(`${label}不是普通目录: ${target}`);
  return target;
}

async function repoDirectory(repoRoot, parts, label, { create = false } = {}) {
  await ensurePlainDirectory(repoRoot, '仓库根目录');
  let current = repoRoot;
  for (const part of parts) {
    current = path.join(current, part);
    assertInside(repoRoot, current, label);
    await ensurePlainDirectory(current, label, { create });
  }
  return current;
}

function decodeUtf8(buffer, label) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    fail(`${label} 不是有效 UTF-8`);
  }
  if (text.includes('\0')) fail(`${label} 包含 NUL 字节`);
  if (!text.trim()) fail(`${label} 内容为空`);
  return text;
}

function markdownTitle(text) {
  const match = text.match(/^#\s+(.+?)\s*$/m);
  return match?.[1]?.trim() || 'unknown';
}

function titlesEquivalent(left, right) {
  const normalize = (value) => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  return normalize(left) === normalize(right);
}

async function lstatRegularFile(filePath, label) {
  const stat = await fs.lstat(filePath).catch(() => null);
  if (!stat) fail(`${label} 不存在: ${filePath}`);
  if (stat.isSymbolicLink()) fail(`${label} 不允许符号链接: ${filePath}`);
  if (!stat.isFile()) fail(`${label} 必须是普通文件: ${filePath}`);
  return stat;
}

async function readStableRegularFile(filePath, label, maxBytes) {
  const noFollow = fsConstants.O_NOFOLLOW || 0;
  let handle;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    fail(`${label}无法安全打开: ${filePath}: ${error.message}`);
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) fail(`${label}必须是普通文件: ${filePath}`);
    if (before.size > BigInt(maxBytes)) fail(`${label}超过 ${maxBytes} 字节上限`);
    const chunks = [];
    let total = 0;
    while (true) {
      const remaining = maxBytes + 1 - total;
      if (remaining <= 0) fail(`${label}读取时超过 ${maxBytes} 字节上限`);
      const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || BigInt(total) !== before.size) {
      fail(`${label}在读取期间发生变化: ${filePath}`);
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

async function walkRegularFiles(root, relative = '') {
  const current = path.join(root, relative);
  const entries = await fs.readdir(current, { withFileTypes: true });
  const results = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = path.join(relative, entry.name);
    const absolute = path.join(root, rel);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) fail(`不允许符号链接: ${absolute}`);
    if (stat.isDirectory()) {
      results.push(...await walkRegularFiles(root, rel));
    } else if (stat.isFile()) {
      results.push({ absolute, relative: rel.split(path.sep).join('/'), size: stat.size });
    } else {
      fail(`不允许特殊文件: ${absolute}`);
    }
  }
  return results;
}

async function inspectMarkdownImages(text, stagePath) {
  const warnings = [];
  const missing = [];
  const links = [];
  const markdownImage = /!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/g;
  const htmlImage = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  for (const match of text.matchAll(markdownImage)) links.push(match[1] || match[2]);
  for (const match of text.matchAll(htmlImage)) links.push(match[1]);

  let remoteCount = 0;
  for (const rawLink of links) {
    const link = rawLink.trim();
    if (/^(https?:)?\/\//i.test(link)) {
      remoteCount += 1;
      continue;
    }
    if (/^(data:|#|mailto:)/i.test(link)) continue;
    let decoded;
    try {
      decoded = decodeURIComponent(link.split(/[?#]/, 1)[0]);
    } catch {
      warnings.push(`无法解析图片路径: ${link}`);
      continue;
    }
    const target = path.resolve(stagePath, decoded);
    if (!isInside(stagePath, target)) fail(`Markdown 图片路径越界: ${link}`);
    if (!await pathExists(target)) {
      missing.push(link);
      continue;
    }
    const targetStat = await fs.lstat(target);
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) fail(`本地图片不是普通文件: ${link}`);
  }
  if (missing.length) fail(`本地图片缺失，不能固化离线断链: ${missing.join(', ')}`);
  if (remoteCount) warnings.push(`正文仍引用 ${remoteCount} 个远程图片 URL；离线可复现性受限`);
  return warnings;
}

async function fileRecord(filePath, relativePath, maxBytes = MAX_ASSET_BYTES) {
  const buffer = await readStableRegularFile(filePath, relativePath, maxBytes);
  return {
    path: relativePath.split(path.sep).join('/'),
    bytes: buffer.length,
    sha256: `sha256:${sha256(buffer)}`,
  };
}

async function validateStage(stagePathInput, repoRootInput = undefined) {
  const stagePath = path.resolve(stagePathInput);
  const repoRoot = repoRootInput ? path.resolve(repoRootInput) : await findRepoRoot(stagePath);
  const stagingRoot = await repoDirectory(repoRoot, ['staging', 'wechat'], '暂存根目录');
  assertInside(stagingRoot, stagePath, '暂存目录');

  const stageStat = await fs.lstat(stagePath).catch(() => null);
  if (!stageStat?.isDirectory() || stageStat.isSymbolicLink()) fail(`暂存目录不存在或无效: ${stagePath}`);

  const capturePath = path.join(stagePath, 'capture.json');
  const articlePath = path.join(stagePath, 'article.md');
  await lstatRegularFile(capturePath, '采集元数据');
  const articleStat = await lstatRegularFile(articlePath, '文章 Markdown');
  if (articleStat.size > MAX_ARTICLE_BYTES) fail(`文章超过 ${MAX_ARTICLE_BYTES} 字节上限`);

  let capture;
  try {
    capture = JSON.parse(decodeUtf8(
      await readStableRegularFile(capturePath, '采集元数据', MAX_METADATA_BYTES),
      '采集元数据',
    ));
  } catch (error) {
    fail(`capture.json 无法解析: ${error.message}`);
  }
  if (capture.schema_version !== SCHEMA_VERSION) fail(`不支持的 capture schema: ${capture.schema_version}`);
  if (capture.status !== 'staged') fail(`暂存状态不是 staged: ${capture.status}`);
  capture.source ??= {};
  capture.source.origin = canonicalizeUrl(capture.source.origin);
  capture.source.canonical_url = canonicalizeUrl(capture.source.canonical_url || capture.source.origin);
  capture.source.retrieved = validateDate(capture.source.retrieved, 'retrieved', { allowDateTime: true });
  capture.source.published_at = validateDate(capture.source.published_at || 'unknown', 'published_at');
  capture.capture.source_authenticity = validateCaptureAuthenticity(capture.capture, capture.source.canonical_url);

  const articleBuffer = await readStableRegularFile(articlePath, '文章 Markdown', MAX_ARTICLE_BYTES);
  const articleText = decodeUtf8(articleBuffer, '文章 Markdown');
  const stageFiles = await walkRegularFiles(stagePath);
  const attachmentFiles = stageFiles.filter((item) => !['article.md', 'capture.json'].includes(item.relative));
  if (attachmentFiles.some((item) => item.relative === 'manifest.json')) fail('暂存附件不能使用保留名称 manifest.json');
  const assetBytes = attachmentFiles.reduce((sum, item) => sum + item.size, 0);
  if (assetBytes > MAX_ASSET_BYTES) fail(`附件超过 ${MAX_ASSET_BYTES} 字节上限`);

  const article = {
    path: 'article.md',
    bytes: articleBuffer.length,
    sha256: `sha256:${sha256(articleBuffer)}`,
  };
  const attachments = [];
  for (const item of attachmentFiles) attachments.push(await fileRecord(item.absolute, item.relative));
  const filesForContent = { article, attachments };
  const contentChecksum = checksum(filesForContent);
  const warnings = [...new Set([
    ...(Array.isArray(capture.warnings) ? capture.warnings.map(String) : []),
    ...await inspectMarkdownImages(articleText, stagePath),
  ])];

  return {
    ok: true,
    repo_root: repoRoot,
    stage: stagePath,
    capture,
    title: capture.source.title && capture.source.title !== 'unknown' ? capture.source.title : markdownTitle(articleText),
    files: filesForContent,
    content_checksum: contentChecksum,
    warnings,
    totals: { article_bytes: article.bytes, asset_count: attachments.length, asset_bytes: assetBytes },
  };
}

async function uniqueStagePath(repoRoot) {
  const root = await repoDirectory(repoRoot, ['staging', 'wechat'], '暂存根目录', { create: true });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const stamp = isoNow().replace(/[-:.]/g, '').replace('Z', 'Z');
    const suffix = sha256(`${process.pid}:${Math.random()}:${attempt}`).slice(0, 8);
    const candidate = path.join(root, `${stamp}-${suffix}`);
    try {
      await fs.mkdir(candidate, { recursive: false });
      return candidate;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  fail('无法创建唯一暂存目录');
}

function sourceMetadata(options, articleText = '') {
  const origin = canonicalizeUrl(options.url);
  return {
    origin,
    canonical_url: canonicalizeUrl(options.canonicalUrl || origin),
    title: options.title || markdownTitle(articleText),
    publisher: options.publisher || 'unknown',
    published_at: validateDate(options.publishedAt || 'unknown', 'published_at'),
    retrieved: validateDate(options.retrieved || localDate(), 'retrieved', { allowDateTime: true }),
  };
}

function sourceAuthenticity(value = 'declared-only') {
  if (!SOURCE_AUTHENTICITY.has(value)) fail(`source_authenticity 无效: ${value}`);
  return value;
}

function validateProvenanceEvidence(value, canonicalUrl, authenticity) {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail('provenance_evidence 必须是对象');
  const result = {};
  const urlKeys = authenticity === 'wechat-origin-response'
    ? ['submitted_url', 'response_url', 'embedded_url']
    : ['submitted_url', 'page_url', 'article_url', 'zip_origin_url'];
  for (const key of urlKeys) {
    if (typeof value[key] !== 'string') fail(`provenance_evidence.${key} 必须是字符串`);
    result[key] = canonicalizeUrl(value[key]);
    if (result[key] !== canonicalUrl) fail(`provenance_evidence.${key} 与来源 URL 不一致`);
  }
  result.verified_at = validateDate(value.verified_at, 'provenance_evidence.verified_at', { allowDateTime: true });
  if (authenticity === 'wechat-origin-response') {
    if (typeof value.html_sha256 !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.html_sha256)) {
      fail('provenance_evidence.html_sha256 无效');
    }
    result.html_sha256 = value.html_sha256;
  }
  return result;
}

function validateCaptureAuthenticity(capture, canonicalUrl, { legacy = false } = {}) {
  if (!capture || typeof capture !== 'object') fail('capture 元数据无效');
  if (capture.source_authenticity === undefined && legacy) return 'declared-only';
  const authenticity = sourceAuthenticity(capture.source_authenticity);
  if (authenticity === 'browser-extension-verified') {
    if (capture.method !== 'wechatsync-url-zip') fail('browser-extension-verified 只能来自 wechatsync-url-zip');
    capture.provenance_evidence = validateProvenanceEvidence(capture.provenance_evidence, canonicalUrl, authenticity);
  } else if (authenticity === 'wechat-origin-response') {
    if (capture.method !== 'wechat-origin-response') fail('wechat-origin-response 真实性只能来自同名采集方法');
    capture.provenance_evidence = validateProvenanceEvidence(capture.provenance_evidence, canonicalUrl, authenticity);
  } else if (['wechatsync-url-zip', 'wechat-origin-response'].includes(capture.method)) {
    fail(`${capture.method} 必须使用匹配的强真实性标记`);
  }
  return authenticity;
}

async function writeJson(filePath, value, { exclusive = false } = {}) {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(filePath, json, { encoding: 'utf8', flag: exclusive ? 'wx' : 'w' });
}

async function copyAssets(source, destination) {
  const sourcePath = path.resolve(source);
  const destinationPath = path.resolve(destination);
  if (isInside(sourcePath, destinationPath) || isInside(destinationPath, sourcePath)) {
    fail(`附件源与目标目录不能重叠: ${sourcePath} -> ${destinationPath}`);
  }
  const stat = await fs.lstat(sourcePath).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail(`附件源不是普通目录: ${sourcePath}`);
  const files = await walkRegularFiles(sourcePath);
  const totalBytes = files.reduce((sum, item) => sum + item.size, 0);
  if (totalBytes > MAX_ASSET_BYTES) fail(`附件超过 ${MAX_ASSET_BYTES} 字节上限`);
  for (const item of files) {
    const target = path.join(destinationPath, item.relative);
    assertInside(destinationPath, target, '附件目标');
    const buffer = await readStableRegularFile(item.absolute, `附件 ${item.relative}`, MAX_ASSET_BYTES);
    if (buffer.length !== item.size) fail(`附件在复制前发生变化: ${item.absolute}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buffer, { flag: 'wx' });
  }
}

function relativeAttachmentRoot(value) {
  const candidate = value || 'assets';
  if (candidate === '.') return '.';
  if (path.isAbsolute(candidate)) fail('--assets-at 必须是相对于 article.md 的目录');
  const normalized = path.normalize(candidate);
  if (!normalized || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    fail('--assets-at 不能越出文章目录');
  }
  if (['article.md', 'capture.json', 'manifest.json'].includes(normalized)) fail('--assets-at 使用了保留名称');
  return normalized;
}

async function stageInput(options) {
  const repoRoot = await resolveRepoRoot(options.repo);
  if (!options.url) fail('stage 需要 --url');
  if (!options.input) fail('stage 需要 --input');
  const input = path.resolve(options.input);
  const articleBuffer = await readStableRegularFile(input, '输入 Markdown', MAX_ARTICLE_BYTES);
  const articleText = decodeUtf8(articleBuffer, '输入 Markdown');

  const stagePath = await uniqueStagePath(repoRoot);
  try {
    await fs.writeFile(path.join(stagePath, 'article.md'), articleBuffer, { flag: 'wx' });
    const attachmentRoot = relativeAttachmentRoot(options.assetsAt);
    if (options.assets) await copyAssets(options.assets, path.resolve(stagePath, attachmentRoot));
    const capture = {
      schema_version: SCHEMA_VERSION,
      status: 'staged',
      source: sourceMetadata(options, articleText),
      capture: {
        method: options.captureMethod || 'file-import',
        source_authenticity: options.sourceAuthenticity || 'declared-only',
        ...(options.provenanceEvidence ? { provenance_evidence: options.provenanceEvidence } : {}),
        captured_at: isoNow(),
        input_name: path.basename(input),
        attachment_root: options.assets ? attachmentRoot.split(path.sep).join('/') : null,
      },
      warnings: [],
    };
    await writeJson(path.join(stagePath, 'capture.json'), capture, { exclusive: true });
    return await validateStage(stagePath, repoRoot);
  } catch (error) {
    await fs.rm(stagePath, { recursive: true, force: true });
    throw error;
  }
}

function tokenFromKeychain() {
  if (process.platform !== 'darwin') return null;
  const account = os.userInfo().username;
  const result = spawnSync('security', [
    'find-generic-password', '-a', account, '-s', 'com.codex.wechat-ingest', '-w',
  ], { encoding: 'utf8', timeout: 5000 });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

function resolveToken() {
  if (process.env.WECHATSYNC_TOKEN) return { value: process.env.WECHATSYNC_TOKEN, source: 'environment' };
  if (process.env.MCP_TOKEN) return { value: process.env.MCP_TOKEN, source: 'environment' };
  const keychain = tokenFromKeychain();
  if (keychain) return { value: keychain, source: 'macOS-keychain' };
  return null;
}

function configureToken() {
  if (process.platform !== 'darwin') fail('configure-token 仅支持 macOS Keychain');
  const account = os.userInfo().username;
  const service = 'com.codex.wechat-ingest';
  const result = spawnSync('security', [
    'add-generic-password',
    '-U',
    '-a', account,
    '-s', service,
    '-l', 'WechatSync bridge for Codex',
    '-T', '/usr/bin/security',
    // Keep -w last: macOS security then prompts without echoing the secret or
    // placing it in argv/shell history.
    '-w',
  ], { stdio: 'inherit' });
  if (result.error) fail(`无法调用 macOS Keychain: ${result.error.message}`);
  if (result.status !== 0) fail(`Keychain 未保存 Token（security 退出码 ${result.status ?? 'unknown'}）`);
  if (!tokenFromKeychain()) fail('Keychain 写入后无法读取 Token');
  return { ok: true, service, account, source: 'macOS-keychain' };
}

function portAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1' }, () => server.close(() => resolve(true)));
  });
}

async function assertBridgePortsFree(port) {
  for (const candidate of [port, port + 1]) {
    if (!await portAvailable(candidate)) fail(`本地端口 ${candidate} 已占用；为避免转发到未知实例，已停止采集`);
  }
}

function runWechatSync(args, { env, input = 'n\n', timeout }) {
  return new Promise((resolve, reject) => {
    const child = spawn('wechatsync', args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.stdin.end(input);
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function diagnosticExcerpt(value, secrets = []) {
  let safe = String(value || '').replace(/\x1b\[[0-9;]*m/g, '');
  for (const secret of secrets) {
    if (secret) safe = safe.replaceAll(String(secret), '[REDACTED]');
  }
  safe = safe
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(wechatsync_token|mcp_token|access_token|refresh_token|authorization|token)\s*([=:])\s*([^\s,;]+)/gi, '$1$2[REDACTED]');
  return safe.trim().slice(-2000);
}

async function captureCurrent(options) {
  const repoRoot = await resolveRepoRoot(options.repo);
  if (!options.url) fail('capture-current 需要 --url');
  const captureUrl = new URL(canonicalizeUrl(options.url));
  if (captureUrl.hostname !== 'mp.weixin.qq.com') {
    fail(`实时采集只接受 mp.weixin.qq.com 文章，当前为 ${captureUrl.hostname}`);
  }
  const token = resolveToken();
  if (!token) {
    fail('未找到 WechatSync Token；请在扩展中启用 MCP/同步桥接，并把 Token 放入 WECHATSYNC_TOKEN 环境变量或 macOS Keychain 服务 com.codex.wechat-ingest');
  }
  const port = Number.parseInt(options.port || process.env.SYNC_WS_PORT || String(DEFAULT_PORT), 10);
  if (!Number.isInteger(port) || port < 1024 || port > 65534) fail(`无效桥接端口: ${port}`);
  await assertBridgePortsFree(port);
  const timeoutMs = Number.parseInt(options.timeout || '30000', 10);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 360000) fail(`无效超时: ${timeoutMs}`);

  const stagePath = await uniqueStagePath(repoRoot);
  const articlePath = path.join(stagePath, 'article.md');
  const startedAt = isoNow();
  const childEnv = {
    PATH: process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME || os.homedir(),
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    USER: process.env.USER || os.userInfo().username,
    LOGNAME: process.env.LOGNAME || os.userInfo().username,
    LANG: process.env.LANG || 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL || '',
    WECHATSYNC_TOKEN: token.value,
    SYNC_WS_PORT: String(port),
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    NODE_OPTIONS: `--require=${PRELOAD_PATH}`,
  };
  const result = await runWechatSync([
    '--timeout', String(timeoutMs), 'extract', '--output', articlePath,
  ], { env: childEnv, timeout: timeoutMs + 10000 });

  const captureBase = {
    schema_version: SCHEMA_VERSION,
    source: sourceMetadata(options),
    capture: {
      method: 'wechatsync-cli-current-tab',
      source_authenticity: 'declared-only',
      captured_at: startedAt,
      extractor: { package: '@wechatsync/cli', installed: '1.1.0', reported: '1.0.0' },
      bridge: { host: '127.0.0.1', websocket_port: port, token_source: token.source },
    },
    warnings: [
      'WechatSync CLI 1.1.0 内部报告版本 1.0.0；这是上游发布物差异。',
      'CLI 不提供页面 URL 回传；来源 URL 由采集前的 Chrome 页面核验承担。',
    ],
  };

  const outputExists = await pathExists(articlePath);
  if (!outputExists) {
    await writeJson(path.join(stagePath, 'capture.json'), {
      ...captureBase,
      status: 'failed',
      diagnostics: {
        exit_code: result.code,
        signal: result.signal,
        stdout: diagnosticExcerpt(result.stdout, [token.value]),
        stderr: diagnosticExcerpt(result.stderr, [token.value]),
      },
    }, { exclusive: true });
    fail('WechatSync 未生成 article.md；失败记录已保留在暂存目录', { stage: stagePath });
  }

  let articleText;
  try {
    const articleBuffer = await readStableRegularFile(articlePath, 'WechatSync 输出', MAX_ARTICLE_BYTES);
    articleText = decodeUtf8(articleBuffer, 'WechatSync 输出');
    if (!/^#\s+\S/m.test(articleText)) fail('WechatSync 输出缺少文章标题，未通过校验');
    const extractedTitle = markdownTitle(articleText);
    if (options.title && !titlesEquivalent(options.title, extractedTitle)) {
      fail(`WechatSync 抓取标题与已核验页面不一致: expected=${JSON.stringify(options.title)} actual=${JSON.stringify(extractedTitle)}`);
    }
  } catch (error) {
    await writeJson(path.join(stagePath, 'capture.json'), {
      ...captureBase,
      status: 'failed',
      diagnostics: { error: error.message },
    }, { exclusive: true });
    error.details = { ...(error.details || {}), stage: stagePath };
    throw error;
  }
  captureBase.source.title = markdownTitle(articleText);
  await writeJson(path.join(stagePath, 'capture.json'), { ...captureBase, status: 'staged' }, { exclusive: true });
  try {
    return await validateStage(stagePath, repoRoot);
  } catch (error) {
    error.details = { ...(error.details || {}), stage: stagePath };
    throw error;
  }
}

async function readRawManifests(rawRoot) {
  if (!await pathExists(rawRoot)) return [];
  await ensurePlainDirectory(rawRoot, '原文包根目录');
  const entries = await fs.readdir(rawRoot, { withFileTypes: true });
  const manifests = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.gitkeep') continue;
    const bundlePath = path.join(rawRoot, entry.name);
    if (entry.isSymbolicLink() || !entry.isDirectory()) fail(`raw/wechat 包含无效条目: ${bundlePath}`);
    const manifestPath = path.join(bundlePath, 'manifest.json');
    if (!await pathExists(manifestPath)) fail(`原文包缺少 manifest.json: ${bundlePath}`);
    await lstatRegularFile(manifestPath, 'manifest');
    let manifest;
    try {
      manifest = JSON.parse(decodeUtf8(
        await readStableRegularFile(manifestPath, 'manifest', MAX_METADATA_BYTES),
        'manifest',
      ));
    } catch (error) {
      fail(`原文包 manifest 无法解析: ${manifestPath}: ${error.message}`);
    }
    await verifyRaw(bundlePath, path.resolve(rawRoot, '..', '..'));
    manifests.push({ bundlePath, manifest });
  }
  return manifests;
}

function dateForBundle(source) {
  const value = source.published_at !== 'unknown' ? source.published_at : source.retrieved.slice(0, 10);
  return validateDate(value, 'bundle date');
}

async function copyValidatedStageToRaw(validation, target) {
  await fs.mkdir(target, { recursive: false });
  for (const record of [validation.files.article, ...validation.files.attachments]) {
    const source = path.join(validation.stage, record.path);
    const destination = path.join(target, record.path);
    assertInside(validation.stage, source, '暂存文件');
    assertInside(target, destination, '原文文件');
    const limit = record.path === 'article.md' ? MAX_ARTICLE_BYTES : MAX_ASSET_BYTES;
    const buffer = await readStableRegularFile(source, `暂存文件 ${record.path}`, limit);
    if (buffer.length !== record.bytes || `sha256:${sha256(buffer)}` !== record.sha256) {
      fail(`暂存文件在验证后发生变化: ${record.path}`);
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, buffer, { flag: 'wx' });
  }
}

async function promoteStage(stagePathInput, repoRootInput = undefined) {
  const repoRoot = repoRootInput ? await resolveRepoRoot(repoRootInput) : await findRepoRoot(stagePathInput);
  const validation = await validateStage(stagePathInput, repoRoot);
  const rawRoot = await repoDirectory(repoRoot, ['raw', 'wechat'], '原文包根目录', { create: true });
  const existing = await readRawManifests(rawRoot);
  const requestedAuthenticity = validation.capture.capture.source_authenticity;
  const authenticityGrade = (manifest) => SOURCE_AUTHENTICITY.get(
    manifest.source_authenticity || manifest.capture?.source_authenticity || 'declared-only',
  ) ?? -1;
  const duplicate = existing.find(({ manifest }) =>
    manifest.source?.canonical_url === validation.capture.source.canonical_url
    && manifest.content_checksum === validation.content_checksum
    && authenticityGrade(manifest) >= SOURCE_AUTHENTICITY.get(requestedAuthenticity));
  if (duplicate) {
    const verified = await verifyRaw(duplicate.bundlePath, repoRoot);
    return {
      ok: true,
      action: 'duplicate-noop',
      raw_bundle: duplicate.bundlePath,
      bundle_checksum: verified.bundle_checksum,
      content_checksum: validation.content_checksum,
      warnings: validation.warnings,
    };
  }

  const sameContentOtherOrigin = existing.filter(({ manifest }) =>
    manifest.content_checksum === validation.content_checksum
    && manifest.source?.canonical_url !== validation.capture.source.canonical_url);
  const warnings = [...validation.warnings];
  if (sameContentOtherOrigin.length) warnings.push('相同内容已从另一 URL 归档；本次保留独立来源记录');

  const urlHash = sha256(validation.capture.source.canonical_url).slice(0, 8);
  const contentHash = validation.content_checksum.slice('sha256:'.length, 'sha256:'.length + 8);
  const authSuffix = requestedAuthenticity === 'declared-only' ? '' : `--a${requestedAuthenticity}`;
  const bundleName = `${dateForBundle(validation.capture.source)}--${slugify(validation.title)}--u${urlHash}--c${contentHash}${authSuffix}`;
  const finalPath = path.join(rawRoot, bundleName);
  assertInside(rawRoot, finalPath, '原文包');
  const existingFinalResult = async () => {
    const finalVerified = await verifyRaw(finalPath, repoRoot);
    const finalManifest = JSON.parse(decodeUtf8(
      await readStableRegularFile(path.join(finalPath, 'manifest.json'), 'manifest', MAX_METADATA_BYTES),
      'manifest',
    ));
    if (finalManifest.source?.canonical_url !== validation.capture.source.canonical_url
      || finalManifest.content_checksum !== validation.content_checksum
      || authenticityGrade(finalManifest) < SOURCE_AUTHENTICITY.get(requestedAuthenticity)) {
      fail(`目标原文包已存在且与本次内容不同: ${finalPath}`);
    }
    return {
      ok: true,
      action: 'duplicate-noop',
      raw_bundle: finalPath,
      bundle_checksum: finalVerified.bundle_checksum,
      content_checksum: validation.content_checksum,
      warnings: finalManifest.warnings || warnings,
    };
  };
  if (await pathExists(finalPath)) return await existingFinalResult();

  const promotionRoot = await repoDirectory(repoRoot, ['staging'], 'staging 目录');
  const temporaryRoot = await fs.mkdtemp(path.join(promotionRoot, `.raw-promote-${bundleName}-`));
  const temporaryPath = path.join(temporaryRoot, 'bundle');
  assertInside(promotionRoot, temporaryPath, '临时原文包');
  try {
    await copyValidatedStageToRaw(validation, temporaryPath);
    const manifestBody = {
      schema_version: SCHEMA_VERSION,
      kind: 'wechat-article-bundle',
      state: 'immutable',
      source: validation.capture.source,
      capture: validation.capture.capture,
      source_authenticity: requestedAuthenticity,
      files: validation.files,
      content_checksum: validation.content_checksum,
      warnings,
      promoted_at: isoNow(),
    };
    const manifest = { ...manifestBody, bundle_checksum: checksum(manifestBody) };
    await writeJson(path.join(temporaryPath, 'manifest.json'), manifest, { exclusive: true });
    const verified = await verifyRaw(temporaryPath, repoRoot, { allowedRoot: promotionRoot });
    try {
      await fs.rename(temporaryPath, finalPath);
    } catch (error) {
      if (['EEXIST', 'ENOTEMPTY'].includes(error.code) && await pathExists(finalPath)) {
        await fs.rm(temporaryRoot, { recursive: true, force: true });
        return await existingFinalResult();
      }
      throw error;
    }
    await fs.rmdir(temporaryRoot);
    return {
      ok: true,
      action: 'promoted',
      raw_bundle: finalPath,
      article: path.join(finalPath, 'article.md'),
      manifest: path.join(finalPath, 'manifest.json'),
      bundle_checksum: verified.bundle_checksum,
      content_checksum: validation.content_checksum,
      warnings,
    };
  } catch (error) {
    if (await pathExists(temporaryRoot)) await fs.rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

async function verifyRaw(rawPathInput, repoRootInput = undefined, options = {}) {
  const rawPath = path.resolve(rawPathInput);
  const repoRoot = repoRootInput ? path.resolve(repoRootInput) : await findRepoRoot(rawPath);
  const rawRoot = await repoDirectory(repoRoot, ['raw', 'wechat'], '原文包根目录');
  const allowedRoot = options.allowedRoot ? path.resolve(options.allowedRoot) : rawRoot;
  if (options.allowedRoot) {
    const stagingRoot = await repoDirectory(repoRoot, ['staging'], 'staging 目录');
    assertInside(stagingRoot, allowedRoot, '临时原文包根目录');
  }
  assertInside(allowedRoot, rawPath, '原文包');
  const stat = await fs.lstat(rawPath).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail(`原文包不存在或无效: ${rawPath}`);

  const manifestPath = path.join(rawPath, 'manifest.json');
  await lstatRegularFile(manifestPath, 'manifest');
  let manifest;
  try {
    manifest = JSON.parse(decodeUtf8(
      await readStableRegularFile(manifestPath, 'manifest', MAX_METADATA_BYTES),
      'manifest',
    ));
  } catch (error) {
    fail(`manifest 无法解析: ${error.message}`);
  }
  if (manifest.schema_version !== SCHEMA_VERSION || manifest.kind !== 'wechat-article-bundle' || manifest.state !== 'immutable') {
    fail('manifest schema、kind 或 state 无效');
  }
  const sourceCanonical = canonicalizeUrl(manifest.source?.canonical_url || manifest.source?.origin);
  const captureAuthenticity = validateCaptureAuthenticity(manifest.capture, sourceCanonical, { legacy: true });
  if (manifest.source_authenticity !== undefined && manifest.source_authenticity !== captureAuthenticity) {
    fail('manifest source_authenticity 与 capture 不一致');
  }
  const storedBundleChecksum = manifest.bundle_checksum;
  const manifestBody = { ...manifest };
  delete manifestBody.bundle_checksum;
  const actualBundleChecksum = checksum(manifestBody);
  if (storedBundleChecksum !== actualBundleChecksum) fail('manifest 元数据校验和不匹配');

  const articlePath = path.join(rawPath, 'article.md');
  await lstatRegularFile(articlePath, '原文 Markdown');
  const articleBuffer = await readStableRegularFile(articlePath, '原文 Markdown', MAX_ARTICLE_BYTES);
  const article = {
    path: 'article.md',
    bytes: articleBuffer.length,
    sha256: `sha256:${sha256(articleBuffer)}`,
  };
  decodeUtf8(articleBuffer, '原文 Markdown');
  const rawFiles = await walkRegularFiles(rawPath);
  const attachmentFiles = rawFiles.filter((item) => !['article.md', 'manifest.json'].includes(item.relative));
  const attachments = [];
  for (const item of attachmentFiles) attachments.push(await fileRecord(item.absolute, item.relative));
  const files = { article, attachments };
  if (canonicalJson(files) !== canonicalJson(manifest.files)) fail('原文文件清单或 SHA-256 与 manifest 不匹配');
  const actualContentChecksum = checksum(files);
  if (manifest.content_checksum !== actualContentChecksum) fail('原文内容校验和不匹配');

  return {
    ok: true,
    raw_bundle: rawPath,
    bundle_checksum: storedBundleChecksum,
    content_checksum: actualContentChecksum,
    files,
    canonical_url: sourceCanonical,
    source_authenticity: captureAuthenticity,
  };
}

async function doctor(options) {
  const repoRoot = await resolveRepoRoot(options.repo);
  const cli = spawnSync('wechatsync', ['--version'], { encoding: 'utf8', timeout: 5000 });
  const token = resolveToken();
  const port = Number.parseInt(options.port || process.env.SYNC_WS_PORT || String(DEFAULT_PORT), 10);
  const ports = {};
  for (const candidate of [port, port + 1]) ports[String(candidate)] = await portAvailable(candidate) ? 'free' : 'busy';
  return {
    ok: cli.status === 0,
    repo_root: repoRoot,
    wechatsync: {
      installed: cli.status === 0,
      reported_version: cli.status === 0 ? cli.stdout.trim() : null,
      expected_package_version: '1.1.0',
      note: '上游 1.1.0 发布物当前仍报告 1.0.0',
    },
    token: { configured: Boolean(token), source: token?.source || null },
    bridge: { host: '127.0.0.1', ports },
    ready_for_live_capture: cli.status === 0 && Boolean(token) && Object.values(ports).every((value) => value === 'free'),
  };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith('--')) fail(`无法识别的参数: ${item}`);
    const [rawKey, inlineValue] = item.slice(2).split(/=(.*)/s, 2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const value = inlineValue ?? rest[index + 1];
    if (inlineValue === undefined) {
      if (value === undefined || value.startsWith('--')) fail(`参数缺少值: ${item}`);
      index += 1;
    }
    if (Object.hasOwn(options, key)) fail(`参数重复: ${item}`);
    options[key] = value;
  }
  return { command, options };
}

function help() {
  return `微信文章不可变归档工具

用法:
  wechat_ingest.mjs doctor [--repo PATH]
  wechat_ingest.mjs configure-token
  wechat_ingest.mjs capture-current --url URL [--title EXACT_TITLE] [--publisher NAME] [--published-at YYYY-MM-DD] [--timeout MS] [--repo PATH]
  wechat_ingest.mjs stage --url URL --input ARTICLE.md [--assets DIR] [--assets-at RELATIVE_DIR] [--publisher NAME] [--published-at YYYY-MM-DD] [--repo PATH]
  wechat_ingest.mjs validate --stage PATH [--repo PATH]
  wechat_ingest.mjs promote --stage PATH [--repo PATH]
  wechat_ingest.mjs verify --raw PATH [--repo PATH]

所有成功结果都以 JSON 输出。capture-current 只读取 Chrome 当前页；运行前必须由操作者核对当前标签页 URL。`;
}

async function main(argv) {
  if (!argv.length || ['help', '--help', '-h'].includes(argv[0])) {
    process.stdout.write(`${help()}\n`);
    return;
  }
  const { command, options } = parseArgs(argv);
  let result;
  if (command === 'doctor') result = await doctor(options);
  else if (command === 'configure-token') result = configureToken();
  else if (command === 'stage') result = await stageInput(options);
  else if (command === 'capture-current') result = await captureCurrent(options);
  else if (command === 'validate') {
    if (!options.stage) fail('validate 需要 --stage');
    result = await validateStage(options.stage, options.repo);
  } else if (command === 'promote') {
    if (!options.stage) fail('promote 需要 --stage');
    result = await promoteStage(options.stage, options.repo);
  } else if (command === 'verify') {
    if (!options.raw) fail('verify 需要 --raw');
    result = await verifyRaw(options.raw, options.repo);
  } else {
    fail(`未知命令: ${command}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message, details: error.details }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

export {
  canonicalizeUrl,
  configureToken,
  diagnosticExcerpt,
  doctor,
  promoteStage,
  readStableRegularFile,
  stageInput,
  titlesEquivalent,
  validateStage,
  verifyRaw,
  SOURCE_AUTHENTICITY,
};
