#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { extractZipEntry, parseZipArchive, readOrigin } from './wechat_inbox.mjs';

const MAX_ARTICLE_BYTES = 50 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const DEFAULT_PORT = 9527;
const require = createRequire(import.meta.url);

function fail(message, details = undefined) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

function canonicalWeChatUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`无效 URL: ${raw}`);
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'mp.weixin.qq.com') {
    fail('只允许 https://mp.weixin.qq.com 微信文章');
  }
  if (url.username || url.password || url.port) fail('微信 URL 不允许凭据或非默认端口');
  if (!(url.pathname === '/s' || url.pathname.startsWith('/s/'))) fail('只允许 mp.weixin.qq.com/s 文章路径');
  url.hostname = 'mp.weixin.qq.com';
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || ['spm', 'from', 'source'].includes(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.toString();
}

async function isPlainDirectory(target, label, { create = false } = {}) {
  let stat = await fs.lstat(target).catch(() => null);
  if (!stat && create) {
    await fs.mkdir(target, { mode: 0o700 });
    stat = await fs.lstat(target);
  }
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail(`${label}不是普通目录: ${target}`);
  return stat;
}

async function findRepoRoot(start = process.cwd()) {
  let current = path.resolve(start);
  while (true) {
    if (await fs.access(path.join(current, 'AGENTS.md')).then(() => true, () => false)
      && await fs.access(path.join(current, 'wiki')).then(() => true, () => false)) return current;
    const parent = path.dirname(current);
    if (parent === current) fail('找不到 wiki 仓库根目录；请使用 --repo 指定');
    current = parent;
  }
}

function tokenFromKeychain() {
  if (process.platform !== 'darwin') return null;
  const result = spawnSync('security', [
    'find-generic-password', '-a', os.userInfo().username,
    '-s', 'com.codex.wechat-ingest', '-w',
  ], { encoding: 'utf8', timeout: 5000 });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

function resolveToken() {
  return process.env.WECHATSYNC_TOKEN || process.env.MCP_TOKEN || tokenFromKeychain();
}

function executableOnPath(name) {
  for (const directory of String(process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      require('node:fs').accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue to the next PATH entry.
    }
  }
  fail(`${name} 不在 PATH 中`);
}

async function loadWebSocketServer() {
  const executable = await fs.realpath(executableOnPath('wechatsync'));
  const cliRoot = path.dirname(path.dirname(executable));
  const manifest = JSON.parse(await fs.readFile(path.join(cliRoot, 'package.json'), 'utf8'));
  if (manifest.name !== '@wechatsync/cli') fail(`wechatsync 可执行文件来源异常: ${cliRoot}`);
  const wsPath = path.join(cliRoot, 'node_modules', 'ws');
  const ws = require(wsPath);
  if (typeof ws.WebSocketServer !== 'function') fail('WechatSync 的 ws 依赖不可用');
  return ws.WebSocketServer;
}

function portAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port }, () => server.close(() => resolve(true)));
  });
}

async function requestExtension(method, params, { port, timeoutMs, token }) {
  if (!await portAvailable(port) || !await portAvailable(port + 1)) {
    fail(`本地端口 ${port}/${port + 1} 已占用；拒绝连接未知桥接实例`);
  }
  const WebSocketServer = await loadWebSocketServer();
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port,
    maxPayload: Math.ceil(MAX_ARCHIVE_BYTES * 4 / 3) + 2 * 1024 * 1024,
  });
  let client = null;
  try {
    const response = await new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => reject(new Error(`等待文章同步助手超时 (${timeoutMs}ms)`)), timeoutMs);
      const finish = (callback, value) => {
        clearTimeout(timer);
        callback(value);
      };
      server.once('error', (error) => finish(reject, error));
      server.on('connection', (socket, request) => {
        if (client) {
          socket.close(1013, 'single client only');
          return;
        }
        const remote = request.socket.remoteAddress;
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
          socket.close(1008, 'loopback only');
          return;
        }
        client = socket;
        socket.once('error', (error) => finish(reject, error));
        socket.on('message', (data) => {
          let message;
          try {
            message = JSON.parse(data.toString('utf8'));
          } catch {
            finish(reject, new Error('扩展返回了无效 JSON'));
            return;
          }
          if (message.id !== requestId) return;
          if (message.error) {
            const code = Number.isInteger(message.error.code) ? message.error.code : -1;
            finish(reject, new Error(`扩展拒绝请求 (${code}): ${String(message.error.message || 'unknown').slice(0, 300)}`));
            return;
          }
          finish(resolve, message.result);
        });
        socket.send(JSON.stringify({ id: requestId, method, token, params }));
      });
    });
    return response;
  } finally {
    if (client && client.readyState < 2) client.close(1000, 'capture complete');
    await new Promise((resolve) => server.close(resolve));
  }
}

function normalizePublishedAt(raw) {
  if (!raw) return undefined;
  const match = String(raw).trim().match(/\b(20\d{2})[年\/.\-](\d{1,2})[月\/.\-](\d{1,2})日?\b/);
  if (!match) return undefined;
  const value = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return undefined;
  return value;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    if (nameBuffer.length === 0 || nameBuffer.length > 0xffff || data.length > 0xffffffff) fail('ZIP 条目尺寸无效');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    localParts.push(local, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(name.endsWith('/') ? 0x41ed0000 : 0x81a40000, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

async function publishExclusive(target, bytes) {
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.partial`);
  let handle;
  try {
    handle = await fs.open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.link(temporary, target);
    await fs.unlink(temporary);
    const dirHandle = await fs.open(directory, fsConstants.O_RDONLY);
    try { await dirHandle.sync(); } finally { await dirHandle.close(); }
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
    if (error.code === 'EEXIST') fail(`拒绝覆盖现有 inbox 文件: ${target}`);
    throw error;
  }
}

async function captureUrlToInbox(options) {
  if (!options.url) fail('capture-url-to-inbox 需要 --url');
  const requestedUrl = canonicalWeChatUrl(options.url);
  const repoRoot = path.resolve(options.repo || await findRepoRoot());
  await isPlainDirectory(repoRoot, '仓库根目录');
  await isPlainDirectory(path.join(repoRoot, 'staging'), 'staging 目录');
  const inbox = path.join(repoRoot, 'staging', 'inbox');
  await isPlainDirectory(inbox, 'inbox 目录', { create: true });
  const outputName = options.output || 'target.zip';
  if (path.basename(outputName) !== outputName || outputName.startsWith('.') || !outputName.toLowerCase().endsWith('.zip')) {
    fail('--output 必须是 staging/inbox 下的非隐藏 .zip 文件名');
  }
  const output = path.join(inbox, outputName);
  const token = resolveToken();
  if (!token) fail('未找到 WechatSync Token');
  const port = Number.parseInt(options.port || process.env.SYNC_WS_PORT || String(DEFAULT_PORT), 10);
  const timeoutMs = Number.parseInt(options.timeout || '90000', 10);
  if (!Number.isInteger(port) || port < 1024 || port > 65534) fail(`无效端口: ${port}`);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 5000 || timeoutMs > 360000) fail(`无效超时: ${timeoutMs}`);

  const result = await requestExtension('exportUrlZip', { url: requestedUrl }, { port, timeoutMs, token });
  const article = result?.article;
  const page = result?.page;
  if (!article || typeof article !== 'object' || !page || typeof page !== 'object') fail('扩展未返回文章与页面证明');
  const actualUrl = canonicalWeChatUrl(page.url);
  const sourceUrl = canonicalWeChatUrl(article.source?.url);
  if (actualUrl !== requestedUrl || sourceUrl !== requestedUrl) {
    fail('扩展返回 URL 与请求 URL 不一致', { requested_url: requestedUrl, actual_url: actualUrl, source_url: sourceUrl });
  }
  const title = String(article.title || page.title || '').normalize('NFKC').trim();
  const markdown = String(article.markdown || article.content || '').trim();
  if (!title || !markdown) fail('扩展返回的标题或 Markdown 为空');
  const encoded = result.archive_base64;
  if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) fail('扩展返回的 ZIP base64 无效');
  if (encoded.length > Math.ceil(MAX_ARCHIVE_BYTES * 4 / 3) + 4) fail(`ZIP 超过 ${MAX_ARCHIVE_BYTES} 字节上限`);
  const zip = Buffer.from(encoded, 'base64');
  if (zip.length === 0 || zip.length > MAX_ARCHIVE_BYTES) fail(`ZIP 超过 ${MAX_ARCHIVE_BYTES} 字节上限`);
  const entries = parseZipArchive(zip);
  const articleEntry = entries.find((entry) => entry.path === 'article.md');
  const originEntry = entries.find((entry) => entry.path === 'origin.json');
  if (!articleEntry || !originEntry) fail('ZIP 缺少 article.md 或 origin.json');
  let archivedMarkdown;
  try {
    archivedMarkdown = new TextDecoder('utf-8', { fatal: true }).decode(extractZipEntry(zip, articleEntry));
  } catch {
    fail('ZIP 中 article.md 不是有效 UTF-8');
  }
  if (Buffer.byteLength(archivedMarkdown) > MAX_ARTICLE_BYTES || !archivedMarkdown.trim()) fail('ZIP 中 article.md 无效');
  const archivedOrigin = readOrigin(extractZipEntry(zip, originEntry), 'ZIP origin.json', { ignoreCaptureFields: true });
  if (canonicalWeChatUrl(archivedOrigin.url) !== requestedUrl) fail('ZIP 内 origin URL 与请求 URL 不一致');
  const archivedTitle = archivedMarkdown.match(/^#\s+(.+?)\s*$/m)?.[1]?.normalize('NFKC').trim();
  if (!archivedTitle || archivedTitle !== title) fail('ZIP 内文章标题与扩展回传标题不一致');
  if (archivedOrigin.title && archivedOrigin.title.normalize('NFKC').trim() !== title) fail('ZIP 内来源标题不一致');
  const localImageCount = entries.filter((entry) => !entry.isDirectory && entry.path.startsWith('images/')).length;
  const remoteImageCount = [...archivedMarkdown.matchAll(/!\[[^\]]*\]\((?:<)?https?:\/\//g)].length;
  // The extension ZIP is untrusted transport.  Preserve its article/assets but
  // replace origin metadata with fields derived from the four checks above.
  const controlledOrigin = {
    origin_url: archivedOrigin.url,
    ...(archivedOrigin.title ? { title: archivedOrigin.title } : {}),
    ...(archivedOrigin.publisher ? { publisher: archivedOrigin.publisher } : {}),
    ...(archivedOrigin.publishedAt ? { published_at: archivedOrigin.publishedAt } : {}),
    ...(archivedOrigin.retrieved ? { retrieved: archivedOrigin.retrieved } : {}),
    capture_method: 'wechatsync-url-zip',
    source_authenticity: 'browser-extension-verified',
    provenance_evidence: {
      submitted_url: requestedUrl,
      page_url: actualUrl,
      article_url: sourceUrl,
      zip_origin_url: canonicalWeChatUrl(archivedOrigin.url),
      verified_at: new Date().toISOString(),
    },
  };
  const rebuilt = [];
  for (const entry of entries) {
    const name = entry.isDirectory ? `${entry.path}/` : entry.path;
    rebuilt.push([name, entry.path === 'origin.json'
      ? `${JSON.stringify(controlledOrigin)}\n`
      : extractZipEntry(zip, entry)]);
  }
  const controlledZip = makeStoredZip(rebuilt);
  await publishExclusive(output, controlledZip);
  return {
    ok: true,
    action: 'captured-to-inbox',
    requested_url: requestedUrl,
    verified_url: actualUrl,
    title,
    publisher: archivedOrigin.publisher || null,
    published_at: archivedOrigin.publishedAt || normalizePublishedAt(page.published_text) || null,
    output,
    bytes: controlledZip.length,
    local_images: localImageCount,
    remote_images_remaining: remoteImageCount,
    limitations: remoteImageCount ? [`${remoteImageCount} 个远程图片引用下载失败或未被本地化。`] : [],
  };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith('--')) fail(`无法识别的参数: ${item}`);
    const key = item.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) fail(`参数缺少值: ${item}`);
    if (Object.hasOwn(options, key)) fail(`参数重复: ${item}`);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

async function main(argv) {
  const { command, options } = parseArgs(argv);
  if (command !== 'capture-url-to-inbox') fail('用法: wechat_url_capture.mjs capture-url-to-inbox --url URL [--output target.zip]');
  process.stdout.write(`${JSON.stringify(await captureUrlToInbox(options), null, 2)}\n`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message, details: error.details }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

export { canonicalWeChatUrl, captureUrlToInbox, crc32, makeStoredZip, normalizePublishedAt };
