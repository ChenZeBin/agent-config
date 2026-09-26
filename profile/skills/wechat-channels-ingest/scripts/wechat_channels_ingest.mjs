#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SCHEMA_VERSION = 1;
const SHORT_URI_RE = /^[A-Za-z0-9_-]{6,64}$/;
const MAX_PREVIEW_BYTES = 1024 * 1024;
const MAX_API_BYTES = 2 * 1024 * 1024;
const MAX_COVER_BYTES = 20 * 1024 * 1024;
const API_URL = 'https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info';
const WARNING_CODES = new Set(['media-not-exposed', 'transcript-unavailable']);
const COVER_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

function fail(message, details) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function checksum(value) {
  return `sha256:${sha256(canonicalJson(value))}`;
}

function inside(parent, target) {
  const relative = path.relative(parent, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertInside(parent, target, label) {
  if (!inside(parent, target)) fail(`${label}超出允许目录: ${target}`);
}

function safeText(value, fallback = 'unknown', maxBytes = 256 * 1024) {
  const text = typeof value === 'string' && value.trim() ? value.trim().replace(/\r\n?/g, '\n') : fallback;
  if (Buffer.byteLength(text) > maxBytes) fail('视频号文本字段超过大小上限');
  return text;
}

function singleLine(value, fallback = 'unknown') {
  return safeText(value, fallback).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function plainDirectory(target, label, { create = false } = {}) {
  if (create) await fs.mkdir(target, { recursive: false }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail(`${label}不是普通目录: ${target}`);
  return stat;
}

async function regularFile(target, label) {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) fail(`${label}不是普通文件: ${target}`);
  return stat;
}

async function readRegular(target, label, limit) {
  const before = await regularFile(target, label);
  if (before.size > limit) fail(`${label}超过 ${limit} 字节上限`);
  const bytes = await fs.readFile(target);
  const after = await regularFile(target, label);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || bytes.length !== before.size) {
    fail(`${label}读取期间发生变化: ${target}`);
  }
  return bytes;
}

async function directoryIdentity(target, label) {
  const stat = await plainDirectory(target, label);
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

async function assertDirectoryIdentity(target, identity, label) {
  const actual = await directoryIdentity(target, label);
  if (actual.dev !== identity.dev || actual.ino !== identity.ino) fail(`${label}在校验后发生目录替换: ${target}`);
}

function assertDirectChild(parent, child, label) {
  assertInside(parent, child, label);
  if (path.dirname(child) !== parent) fail(`${label}必须是平台根目录的直接子目录: ${child}`);
}

async function directoryChain(root, parts, label, { create = false } = {}) {
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

async function repoRoot(value) {
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

async function stageRoot(root, create = false) {
  return directoryChain(root, ['staging', 'wechat-channels'], '视频号暂存目录', { create });
}

async function rawRoot(root, create = false) {
  return directoryChain(root, ['raw', 'wechat-channels'], 'raw/wechat-channels', { create });
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail(`${label}不是有效 UTF-8 JSON`);
  }
}

function normalizePreviewUrl(shortUri) {
  return `https://channels.weixin.qq.com/finder-preview/pages/sph?id=${shortUri}`;
}

function parseChannelsUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`无效微信视频号 URL: ${raw}`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) {
    fail('仅接受无凭据、无端口、无 fragment 的 HTTPS 微信视频号 URL');
  }
  const host = url.hostname.toLowerCase();
  let shortUri;
  if (host === 'weixin.qq.com') {
    if (url.search) fail('weixin.qq.com/sph URL 不接受查询参数');
    const match = /^\/sph\/([^/]+)$/.exec(url.pathname);
    if (!match) fail('微信视频号短链必须严格为 https://weixin.qq.com/sph/<short-uri>');
    shortUri = match[1];
  } else if (host === 'channels.weixin.qq.com') {
    if (url.pathname !== '/finder-preview/pages/sph' || url.searchParams.getAll('id').length !== 1 || [...url.searchParams.keys()].some((key) => key !== 'id')) {
      fail('视频号预览 URL 必须严格为 /finder-preview/pages/sph?id=<short-uri>');
    }
    shortUri = url.searchParams.get('id');
  } else {
    fail('仅接受 weixin.qq.com 或 channels.weixin.qq.com 视频号分享链接');
  }
  if (!SHORT_URI_RE.test(shortUri || '')) fail('微信视频号 short URI 格式无效');
  return {
    submitted_url: raw,
    canonical_url: `https://weixin.qq.com/sph/${shortUri}`,
    preview_url: normalizePreviewUrl(shortUri),
    short_uri: shortUri,
  };
}

function normalizeCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = singleLine(String(value), '');
  return text || null;
}

function coverUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('视频号 API 未返回有效封面 URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hostname !== 'finder.video.qq.com') {
    fail('视频号封面 URL 不在允许的腾讯 HTTPS 域');
  }
  return url.toString();
}

function normalizeApi(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.errCode !== 0) fail('视频号 API 返回错误或 schema 无效');
  const data = raw.data;
  const feed = data?.feedInfo;
  const author = data?.authorInfo;
  if (!feed || typeof feed !== 'object' || Array.isArray(feed)) fail('视频号 API 未返回 feedInfo');
  if (!author || typeof author !== 'object' || Array.isArray(author)) fail('视频号 API 未返回 authorInfo');
  if (data?.errMsg?.type !== 0) fail('视频号公开预览不可用');
  const exposedMedia = [feed.videoUrl, feed.h264VideoInfo?.videoUrl, feed.h265VideoInfo?.videoUrl]
    .some((value) => typeof value === 'string' && value.trim());
  if (exposedMedia) fail('视频号 API 已暴露媒体 URL；当前 metadata-only 适配器拒绝忽略它，请扩展媒体固化与转录流程');
  if (Array.isArray(feed.picInfo) && feed.picInfo.length) fail('视频号 API 返回多图内容；当前 single-public-share-preview 适配器拒绝不完整归档');
  const createdAt = Number(feed.createtime);
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) fail('视频号 createtime 无效');
  const description = safeText(feed.description, '');
  const nickname = singleLine(author.nickname, '');
  if (!description || !nickname) fail('视频号公开预览缺少作者或描述');
  const previewCoverUrl = coverUrl(feed.coverUrl);
  return {
    title: `微信视频号分享：${singleLine(description).slice(0, 72)}`,
    title_origin: 'derived-from-description',
    author: nickname,
    description,
    created_at: createdAt,
    created_date: new Date(createdAt * 1000).toISOString().slice(0, 10),
    cover_url: previewCoverUrl,
    engagement_snapshot: {
      likes: normalizeCount(feed.likeCountFmt),
      favorites: normalizeCount(feed.favCountFmt),
      comments: normalizeCount(feed.commentCountFmt),
      forwards: normalizeCount(feed.forwardCountFmt),
    },
  };
}

async function responseBytes(response, label, limit) {
  const header = response.headers.get('content-length');
  if (header && Number(header) > limit) fail(`${label}超过 ${limit} 字节上限`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > limit) fail(`${label}超过 ${limit} 字节上限`);
  return bytes;
}

async function defaultCapture({ source, fetchImpl = fetch }) {
  const share = await fetchImpl(source.canonical_url, {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
    headers: { accept: 'text/html,application/xhtml+xml' },
  });
  if (![301, 302, 303, 307, 308].includes(share.status)) fail(`视频号短链未返回受支持的重定向 (${share.status})`);
  const location = share.headers.get('location');
  let resolved;
  try {
    resolved = new URL(location, source.canonical_url).toString();
  } catch {
    fail('视频号短链返回无效 Location');
  }
  if (resolved !== source.preview_url) fail('视频号短链 Location 与 short URI 不一致');

  const preview = await fetchImpl(source.preview_url, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: { accept: 'text/html,application/xhtml+xml' },
  });
  if (preview.status !== 200 || !String(preview.headers.get('content-type') || '').toLowerCase().includes('text/html')) {
    fail(`视频号官方预览页不可用 (${preview.status})`);
  }
  const previewBytes = await responseBytes(preview, '视频号官方预览页', MAX_PREVIEW_BYTES);
  const previewText = new TextDecoder('utf-8', { fatal: true }).decode(previewBytes);
  if (!previewText.includes('finder-preview') || !previewText.includes('<title>视频号</title>')) fail('视频号官方预览页标记不完整');

  const requestBody = Buffer.from(JSON.stringify({ baseReq: { generalToken: '' }, shortUri: source.short_uri }));
  const api = await fetchImpl(API_URL, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      origin: 'https://channels.weixin.qq.com',
      referer: source.preview_url,
    },
    body: requestBody,
  });
  if (![200, 201].includes(api.status) || !String(api.headers.get('content-type') || '').toLowerCase().includes('application/json')) {
    fail(`视频号官方 API 不可用 (${api.status})`);
  }
  const apiBytes = await responseBytes(api, '视频号官方 API 响应', MAX_API_BYTES);
  const normalized = normalizeApi(parseJson(apiBytes, '视频号官方 API 响应'));

  const cover = await fetchImpl(normalized.cover_url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { accept: 'image/*' } });
  const coverType = String(cover.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (cover.status !== 200 || !COVER_TYPES.has(coverType)) fail(`视频号封面不可用或类型不支持 (${cover.status})`);
  const coverBytes = await responseBytes(cover, '视频号封面', MAX_COVER_BYTES);
  if (!coverBytes.length) fail('视频号封面为空');
  const validMagic = coverType === 'image/jpeg' || coverType === 'image/jpg'
    ? coverBytes.length >= 3 && coverBytes[0] === 0xff && coverBytes[1] === 0xd8 && coverBytes[2] === 0xff
    : coverType === 'image/png'
      ? coverBytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : coverBytes.length >= 12 && coverBytes.subarray(0, 4).toString('ascii') === 'RIFF' && coverBytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!validMagic) fail('视频号封面 magic bytes 与 Content-Type 不一致');
  return {
    retrieved_at: new Date().toISOString(),
    redirect_status: share.status,
    preview_status: preview.status,
    api_status: api.status,
    preview_bytes: previewBytes,
    api_bytes: apiBytes,
    cover_bytes: coverBytes,
    cover_extension: COVER_TYPES.get(coverType),
    cover_content_type: coverType,
    normalized,
  };
}

function slug(value) {
  const result = singleLine(value, '微信视频号').toLocaleLowerCase('zh-CN')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/g, '');
  return result || '微信视频号';
}

function renderArticle(source, normalized, capture, coverPath) {
  const engagement = normalized.engagement_snapshot;
  return [
    `# ${normalized.title}`,
    '',
    `- Canonical URL: ${source.canonical_url}`,
    `- Short URI: ${source.short_uri}`,
    `- Author: ${normalized.author}`,
    `- Created at: ${new Date(normalized.created_at * 1000).toISOString()}`,
    '- Capture scope: single-public-share-preview',
    '- Metadata authenticity: wechat-channels-origin-api',
    '- Content coverage: metadata-only',
    '- Transcript available: false',
    '- API response: [responses/feed-info.json](./responses/feed-info.json)',
    '- Preview page: [responses/preview.html](./responses/preview.html)',
    `- Cover: [${coverPath}](./${coverPath})`,
    '',
    '## 视频号公开描述',
    '',
    normalized.description,
    '',
    '## 互动快照',
    '',
    `- Captured at: ${capture.retrieved_at}`,
    `- Likes: ${engagement.likes ?? 'unknown'}`,
    `- Favorites: ${engagement.favorites ?? 'unknown'}`,
    `- Comments: ${engagement.comments ?? 'unknown'}`,
    `- Forwards: ${engagement.forwards ?? 'unknown'}`,
    '',
    '## 内容证据缺口',
    '',
    '- 官方公开预览未暴露视频媒体、字幕或逐字稿；本包只能证明公开描述、封面与采集时互动快照。',
    '- 不得把公开描述或封面文字表述为视频完整内容，也不得声称已经完成视频内容炼化。',
    '',
  ].join('\n');
}

async function fileRecord(stage, relative, limit) {
  const absolute = path.join(stage, relative);
  assertInside(stage, absolute, 'bundle 文件');
  const bytes = await readRegular(absolute, relative, limit);
  return { path: relative.split(path.sep).join('/'), sha256: `sha256:${sha256(bytes)}`, size: bytes.length };
}

function bundleChecksum(manifest) {
  const copy = structuredClone(manifest);
  delete copy.bundle_checksum;
  return checksum(copy);
}

async function stageVideo({ url, repo, stage, fetchImpl = fetch, captureImpl } = {}) {
  const root = await repoRoot(repo);
  const source = parseChannelsUrl(url);
  const base = await stageRoot(root, true);
  const target = stage ? path.resolve(stage) : path.join(base, `${Date.now()}-${process.pid}-${randomUUID()}`);
  assertDirectChild(base, target, '视频号暂存任务');
  await fs.mkdir(target, { recursive: false });
  try {
    const capture = captureImpl ? await captureImpl({ source, fetchImpl }) : await defaultCapture({ source, fetchImpl });
    if (!capture?.normalized || !Buffer.isBuffer(capture.preview_bytes) || !Buffer.isBuffer(capture.api_bytes) || !Buffer.isBuffer(capture.cover_bytes)) {
      fail('视频号 capture 返回结构无效');
    }
    const normalized = normalizeApi(parseJson(capture.api_bytes, '视频号官方 API 响应'));
    if (canonicalJson(normalized) !== canonicalJson(capture.normalized)) fail('视频号 normalized 与原始 API 响应不一致');
    const coverExtension = capture.cover_extension;
    if (!['jpg', 'png', 'webp'].includes(coverExtension)) fail('视频号封面扩展名无效');
    const coverPath = `assets/cover.${coverExtension}`;
    await fs.mkdir(path.join(target, 'responses'));
    await fs.mkdir(path.join(target, 'assets'));
    await fs.writeFile(path.join(target, 'responses', 'preview.html'), capture.preview_bytes, { flag: 'wx' });
    await fs.writeFile(path.join(target, 'responses', 'feed-info.json'), capture.api_bytes, { flag: 'wx' });
    await fs.writeFile(path.join(target, coverPath), capture.cover_bytes, { flag: 'wx' });
    const safeCapture = {
      method: 'wechat-channels-origin-api',
      retrieved_at: capture.retrieved_at,
      redirect_status: capture.redirect_status,
      preview_status: capture.preview_status,
      api_status: capture.api_status,
      api_endpoint: API_URL,
      cover_content_type: capture.cover_content_type,
      warnings: ['media-not-exposed', 'transcript-unavailable'],
    };
    await fs.writeFile(path.join(target, 'capture.json'), `${JSON.stringify({ source, normalized, capture: safeCapture }, null, 2)}\n`, { flag: 'wx' });
    await fs.writeFile(path.join(target, 'article.md'), renderArticle(source, normalized, safeCapture, coverPath), { flag: 'wx' });
    const files = await Promise.all([
      fileRecord(target, 'article.md', MAX_API_BYTES),
      fileRecord(target, 'capture.json', MAX_API_BYTES),
      fileRecord(target, 'responses/preview.html', MAX_PREVIEW_BYTES),
      fileRecord(target, 'responses/feed-info.json', MAX_API_BYTES),
      fileRecord(target, coverPath, MAX_COVER_BYTES),
    ]);
    files.sort((left, right) => left.path.localeCompare(right.path));
    const contentChecksum = checksum({
      canonical_url: source.canonical_url,
      author: normalized.author,
      description: normalized.description,
      created_at: normalized.created_at,
      cover_sha256: files.find((item) => item.path === coverPath).sha256,
    });
    const manifest = {
      schema_version: SCHEMA_VERSION,
      kind: 'wechat-channels-bundle',
      state: 'immutable',
      platform: 'wechat-channels',
      capture_scope: 'single-public-share-preview',
      source,
      source_authenticity: 'wechat-channels-origin-api',
      metadata_authenticity: 'wechat-channels-origin-api',
      content_authenticity: 'metadata-only',
      normalized,
      capture: safeCapture,
      transcript_available: false,
      files,
      content_checksum: contentChecksum,
    };
    manifest.bundle_checksum = bundleChecksum(manifest);
    await fs.writeFile(path.join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    const checked = await validateStage(target, root);
    return { action: 'staged', capture_exercised: true, stage: target, ...checked };
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function listEntries(bundle) {
  const entries = [];
  async function walk(current) {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      assertInside(bundle, absolute, 'bundle 条目');
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) fail(`bundle 不允许符号链接: ${absolute}`);
      if (stat.isDirectory()) await walk(absolute);
      else if (stat.isFile()) entries.push(path.relative(bundle, absolute).split(path.sep).join('/'));
      else fail(`bundle 含特殊文件: ${absolute}`);
    }
  }
  await walk(bundle);
  return entries;
}

async function validateBundle(bundle, root, expectedParent) {
  const absolute = path.resolve(bundle);
  assertDirectChild(expectedParent, absolute, '视频号 bundle');
  const identity = await directoryIdentity(absolute, '视频号 bundle');
  const manifestPath = path.join(absolute, 'manifest.json');
  const manifestBytes = await readRegular(manifestPath, 'manifest.json', MAX_API_BYTES);
  const manifest = parseJson(manifestBytes, 'manifest.json');
  if (manifest.schema_version !== SCHEMA_VERSION || manifest.kind !== 'wechat-channels-bundle' || manifest.state !== 'immutable' || manifest.platform !== 'wechat-channels') fail('视频号 manifest schema 无效');
  if (manifest.capture_scope !== 'single-public-share-preview') fail('视频号 capture_scope 无效');
  const source = parseChannelsUrl(manifest.source?.canonical_url);
  const submitted = parseChannelsUrl(manifest.source?.submitted_url);
  if (source.short_uri !== submitted.short_uri) fail('视频号 submitted URL 与 canonical URL 不一致');
  const expectedSource = { ...source, submitted_url: manifest.source.submitted_url };
  if (canonicalJson(expectedSource) !== canonicalJson(manifest.source)) fail('视频号 manifest source 无法规范化');
  if (manifest.source_authenticity !== 'wechat-channels-origin-api' || manifest.metadata_authenticity !== 'wechat-channels-origin-api' || manifest.content_authenticity !== 'metadata-only') fail('视频号真实性字段无效');
  if (manifest.transcript_available !== false) fail('视频号 metadata-only bundle 不得声明 transcript_available');
  if (!Array.isArray(manifest.capture?.warnings) || manifest.capture.warnings.length !== 2 || manifest.capture.warnings.some((item) => !WARNING_CODES.has(item))) fail('视频号 warning 集合无效');
  if (manifest.capture?.method !== 'wechat-channels-origin-api' || manifest.capture?.api_endpoint !== API_URL) fail('视频号 capture 方法无效');
  if (!Array.isArray(manifest.files) || manifest.files.length !== 5) fail('视频号 manifest 文件清单无效');
  const expectedFiles = new Set(['article.md', 'capture.json', 'responses/preview.html', 'responses/feed-info.json']);
  const coverRecords = manifest.files.filter((item) => /^assets\/cover\.(?:jpg|png|webp)$/.test(item?.path || ''));
  if (coverRecords.length !== 1) fail('视频号 bundle 必须恰有一个封面文件');
  expectedFiles.add(coverRecords[0].path);
  const seen = new Set();
  for (const record of manifest.files) {
    if (!record || typeof record.path !== 'string' || !expectedFiles.has(record.path) || seen.has(record.path) || !/^sha256:[a-f0-9]{64}$/.test(record.sha256) || !Number.isSafeInteger(record.size) || record.size <= 0) fail('视频号文件记录无效');
    seen.add(record.path);
    const limit = record.path.endsWith('preview.html') ? MAX_PREVIEW_BYTES : record.path.startsWith('assets/') ? MAX_COVER_BYTES : MAX_API_BYTES;
    const bytes = await readRegular(path.join(absolute, record.path), record.path, limit);
    if (bytes.length !== record.size || `sha256:${sha256(bytes)}` !== record.sha256) fail(`视频号文件 checksum 不匹配: ${record.path}`);
  }
  if (seen.size !== expectedFiles.size || [...expectedFiles].some((item) => !seen.has(item))) fail('视频号文件清单不完整');
  const actualEntries = (await listEntries(absolute)).filter((item) => item !== 'manifest.json');
  if (canonicalJson(actualEntries) !== canonicalJson([...expectedFiles].sort())) fail('视频号 bundle 存在未声明文件');
  const apiBytes = await readRegular(path.join(absolute, 'responses', 'feed-info.json'), 'API 响应', MAX_API_BYTES);
  const normalized = normalizeApi(parseJson(apiBytes, 'API 响应'));
  if (canonicalJson(normalized) !== canonicalJson(manifest.normalized)) fail('视频号 normalized 与 API 响应不一致');
  const capture = parseJson(await readRegular(path.join(absolute, 'capture.json'), 'capture.json', MAX_API_BYTES), 'capture.json');
  if (canonicalJson(capture) !== canonicalJson({ source: manifest.source, normalized: manifest.normalized, capture: manifest.capture })) fail('视频号 capture.json 与 manifest 不一致');
  const article = await readRegular(path.join(absolute, 'article.md'), 'article.md', MAX_API_BYTES);
  if (!article.equals(Buffer.from(renderArticle(manifest.source, manifest.normalized, manifest.capture, coverRecords[0].path)))) fail('视频号 article.md 不是确定性渲染结果');
  const calculatedContent = checksum({
    canonical_url: manifest.source.canonical_url,
    author: normalized.author,
    description: normalized.description,
    created_at: normalized.created_at,
    cover_sha256: coverRecords[0].sha256,
  });
  if (manifest.content_checksum !== calculatedContent) fail('视频号 content_checksum 不匹配');
  if (manifest.bundle_checksum !== bundleChecksum(manifest)) fail('视频号 bundle_checksum 不匹配');
  await assertDirectoryIdentity(absolute, identity, '视频号 bundle');
  const { cover_url: _ephemeralCoverUrl, ...publicNormalized } = normalized;
  return {
    ok: true,
    source: manifest.source,
    normalized: publicNormalized,
    content_checksum: manifest.content_checksum,
    bundle_checksum: manifest.bundle_checksum,
    source_authenticity: manifest.source_authenticity,
    metadata_authenticity: manifest.metadata_authenticity,
    content_authenticity: manifest.content_authenticity,
    transcript_available: false,
    warnings: manifest.capture.warnings,
  };
}

async function validateStage(stage, repo) {
  const root = await repoRoot(repo);
  const base = await stageRoot(root, false);
  return validateBundle(stage, root, base);
}

async function verifyRaw(raw, repo) {
  const root = await repoRoot(repo);
  const base = await rawRoot(root, false);
  const absolute = path.resolve(raw);
  const result = await validateBundle(absolute, root, base);
  return { ...result, raw_bundle: absolute };
}

async function duplicate(root, validation) {
  const base = await rawRoot(root, true);
  for (const entry of (await fs.readdir(base, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const candidate = path.join(base, entry.name);
    const verified = await verifyRaw(candidate, root);
    if (verified.source.canonical_url === validation.source.canonical_url && verified.content_checksum === validation.content_checksum) return verified;
  }
  return null;
}

async function promoteStage(stage, repo) {
  const root = await repoRoot(repo);
  const base = await stageRoot(root, false);
  const absolute = path.resolve(stage);
  assertDirectChild(base, absolute, '视频号暂存任务');
  const validation = await validateStage(absolute, root);
  const existing = await duplicate(root, validation);
  if (existing) return { action: 'duplicate-noop', capture_exercised: true, ...existing };
  const destinationRoot = await rawRoot(root, true);
  const bundleName = `${validation.normalized.created_date}--${slug(validation.normalized.title)}--${validation.source.short_uri}--${validation.content_checksum.slice(7, 16)}`;
  const destination = path.join(destinationRoot, bundleName);
  assertDirectChild(destinationRoot, destination, '视频号 raw bundle');
  if (await exists(destination)) fail(`视频号 raw 目标已存在: ${destination}`);
  const identity = await directoryIdentity(absolute, '视频号暂存任务');
  await assertDirectoryIdentity(absolute, identity, '视频号暂存任务');
  await fs.rename(absolute, destination);
  const verified = await verifyRaw(destination, root);
  return { action: 'promoted', capture_exercised: true, ...verified };
}

async function ingestUrl(options = {}) {
  const staged = await stageVideo(options);
  return promoteStage(staged.stage, options.repo);
}

function args(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) parsed._.push(item);
    else {
      const key = item.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) parsed[key] = true;
      else { parsed[key] = next; index += 1; }
    }
  }
  return parsed;
}

async function main() {
  const parsed = args(process.argv.slice(2));
  const command = parsed._[0];
  let result;
  if (command === 'stage') result = await stageVideo({ url: parsed.url, repo: parsed.repo, stage: parsed.stage });
  else if (command === 'validate') result = await validateStage(parsed.stage, parsed.repo);
  else if (command === 'promote') result = await promoteStage(parsed.stage, parsed.repo);
  else if (command === 'verify') result = await verifyRaw(parsed.raw, parsed.repo);
  else if (command === 'ingest') result = await ingestUrl({ url: parsed.url, repo: parsed.repo });
  else fail('用法: wechat_channels_ingest.mjs <stage|validate|promote|verify|ingest> [--url URL] [--stage PATH] [--raw PATH] [--repo PATH]');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message, details: error.details }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

export {
  ingestUrl,
  parseChannelsUrl,
  promoteStage,
  stageVideo,
  validateStage,
  verifyRaw,
};
