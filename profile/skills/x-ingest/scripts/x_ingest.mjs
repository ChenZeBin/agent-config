#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const MAX_MEDIA_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;
const SCHEMA_VERSION = 1;
const MEDIA_HOSTS = new Set(['pbs.twimg.com', 'video.twimg.com', 'ton.twimg.com']);
const STATUS_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);
const OFFICIAL_ENDPOINT = (id) => `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(id)}&lang=en`;
const FX_ENDPOINT = (id) => `https://api.fxtwitter.com/status/${encodeURIComponent(id)}`;

function fail(message, details) { const error = new Error(message); error.details = details; throw error; }
function sha256(data) { return createHash('sha256').update(data).digest('hex'); }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function checksum(value) { return `sha256:${sha256(canonicalJson(value))}`; }
function isInside(parent, child) { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
function assertInside(parent, child, label) { if (!isInside(parent, child)) fail(`${label}超出允许目录: ${child}`); }
function now() { return new Date().toISOString(); }
function localDate(value = new Date()) { return value.toISOString().slice(0, 10); }
function slug(value) { return String(value || 'x-post').normalize('NFKC').replace(/\s+/g, ' ').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'x-post'; }
async function exists(target) { try { await fs.access(target); return true; } catch { return false; } }

function parseStatusUrl(value) {
  let url; try { url = new URL(value); } catch { fail(`无效 X 状态 URL: ${value}`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !STATUS_HOSTS.has(url.hostname.toLowerCase())) fail('仅接受无凭据、无端口的 HTTPS x.com/twitter.com 状态 URL');
  if (url.hash) fail('状态 URL 不允许 fragment');
  const match = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,30})\/?$/.exec(url.pathname);
  if (!match) fail('状态 URL 必须严格为 /<user>/status/<id>');
  const [, username, statusId] = match; const query = new URLSearchParams(url.search);
  for (const key of query.keys()) if (!['s', 't', 'c', 'ref_src'].includes(key)) fail(`状态 URL 包含不允许的查询参数: ${key}`);
  return { original_url: url.toString(), canonical_url: `https://x.com/${username}/status/${statusId}`, username, status_id: statusId };
}
function asText(value) { return typeof value === 'string' ? value.trim() : ''; }
function markdownTitle(value) { return asText(value).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim(); }

async function plainDirectory(target, label, { create = false } = {}) {
  if (create) await fs.mkdir(target, { recursive: false }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail(`${label}不是普通目录: ${target}`);
  return target;
}
async function ensureDirectoryChain(root, parts, label, { create = false } = {}) {
  await plainDirectory(root, '仓库根目录'); let current = root;
  for (const part of parts) {
    if (!/^[A-Za-z0-9._-]+$/.test(part)) fail(`${label}路径段无效: ${part}`);
    current = path.join(current, part); assertInside(root, current, label);
    await plainDirectory(current, label, { create });
  }
  return current;
}
async function regularFile(target, label) {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) fail(`${label}不是普通文件: ${target}`);
  return stat;
}
async function repoRoot(value) {
  let current = path.resolve(value || process.cwd());
  while (true) {
    const agents = path.join(current, 'AGENTS.md'); const wiki = path.join(current, 'wiki');
    const agentsStat = await fs.lstat(agents).catch(() => null); const wikiStat = await fs.lstat(wiki).catch(() => null);
    if (agentsStat?.isFile() && !agentsStat.isSymbolicLink() && wikiStat?.isDirectory() && !wikiStat.isSymbolicLink()) {
      await plainDirectory(current, '仓库根目录'); return current;
    }
    const parent = path.dirname(current); if (parent === current) fail('找不到同时含 AGENTS.md 和 wiki/ 的仓库根目录；请传入 --repo'); current = parent;
  }
}
async function safeStageBase(root, create = false) { return ensureDirectoryChain(root, ['staging', 'x'], '暂存父目录', { create }); }
async function safeRawRoot(root, create = false) { return ensureDirectoryChain(root, ['raw', 'x'], 'raw/x', { create }); }

function assertEndpoint(url, host) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hostname !== host) fail(`拒绝未授权的抓取端点: ${url}`);
}
async function readLimited(response, maxBytes, label) {
  if (!response?.ok) fail(`${label} 返回 HTTP ${response?.status ?? 'unknown'}`);
  if (response.redirected) fail(`${label} 不允许重定向`);
  const contentLength = response.headers?.get?.('content-length');
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) fail(`${label} 超过 ${maxBytes} 字节上限`);
  if (!response.body?.getReader) { const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > maxBytes) fail(`${label} 超过 ${maxBytes} 字节上限`); return bytes; }
  const reader = response.body.getReader(); const chunks = []; let total = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > maxBytes) { void reader.cancel(); fail(`${label} 超过 ${maxBytes} 字节上限`); } chunks.push(Buffer.from(value)); }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}
async function getJson(fetchImpl, endpoint, backend) {
  assertEndpoint(endpoint, backend === 'x-syndication' ? 'cdn.syndication.twimg.com' : 'api.fxtwitter.com');
  const response = await fetchImpl(endpoint, { redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } });
  const bytes = await readLimited(response, MAX_JSON_BYTES, `${backend} 响应`);
  let data; try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail(`${backend} 响应不是有效 UTF-8 JSON`); }
  if (!data || typeof data !== 'object') fail(`${backend} 响应不是对象`);
  return { endpoint, data, bytes };
}
function candidateId(data) { return String(data?.id_str ?? data?.id ?? data?.tweet?.id_str ?? data?.tweet?.id ?? ''); }
function draftBlocks(value) {
  if (Array.isArray(value?.blocks)) return value.blocks;
  if (Array.isArray(value?.content?.blocks)) return value.content.blocks;
  if (Array.isArray(value?.body?.blocks)) return value.body.blocks;
  return null;
}
function draftMarkdown(value) {
  const blocks = draftBlocks(value); if (!blocks) return '';
  const lines = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const text = asText(block.text); const type = asText(block.type) || 'unstyled'; const depth = Math.max(0, Number(block.depth) || 0); const indent = '  '.repeat(depth);
    if (!text && type !== 'atomic') continue;
    if (type === 'header-one') lines.push(`## ${text}`);
    else if (type === 'header-two') lines.push(`### ${text}`);
    else if (type === 'header-three') lines.push(`#### ${text}`);
    else if (type === 'unordered-list-item') lines.push(`${indent}- ${text}`);
    else if (type === 'ordered-list-item') lines.push(`${indent}1. ${text}`);
    else if (type === 'blockquote') lines.push(`> ${text}`);
    else if (type === 'code-block') lines.push(`\`\`\`\n${text}\n\`\`\``);
    else if (type !== 'atomic') lines.push(text);
  }
  return lines.join('\n\n').trim();
}
function extractMedia(...roots) {
  const urls = []; const warnings = []; const seen = new Set(); const visit = (value, context = 'media') => {
    if (typeof value === 'string') { if (!seen.has(value)) { seen.add(value); urls.push(value); } return; }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) visit(item, context); return; }
    let found = false;
    for (const key of ['url', 'media_url_https', 'media_url', 'thumbnail_url', 'preview_url', 'preview_image_url']) if (typeof value[key] === 'string') { visit(value[key], context); found = true; }
    for (const key of ['all', 'photos', 'videos', 'media', 'variants']) if (value[key] !== undefined) { visit(value[key], key); found = true; }
    if (!found && (context === 'all' || context === 'photos' || context === 'videos' || context === 'media' || context === 'variants')) {
      const children = Object.values(value).filter((item) => item && typeof item === 'object');
      if (children.length) for (const child of children) visit(child, context); else warnings.push('发现无法识别的媒体对象，未下载');
    }
  };
  for (const root of roots) visit(root); return { urls, warnings };
}
function normalizeCapture(data, request, backend) {
  if (candidateId(data) !== request.status_id) fail(`${backend} 返回的状态 ID 与请求不一致`);
  const post = data.tweet && typeof data.tweet === 'object' ? data.tweet : data; const user = post.user || post.author || data.user || data.author || {};
  const userName = asText(user.screen_name || user.username || user.handle) || request.username;
  const text = asText(post.note_tweet?.text || post.full_text || post.text || post.content || data.text);
  const article = post.article || data.article || post.note_tweet?.article || null;
  const articleBody = draftMarkdown(article) || asText(article?.content || article?.text || article?.body || post.note_tweet?.text);
  const articleTitle = markdownTitle(article?.title || post.note_tweet?.title);
  const type = article && (articleBody || articleTitle) ? 'x-article' : 'x-post';
  if (!(type === 'x-article' ? articleBody || text : text)) fail(`${backend} 响应没有可归档的帖子正文`);
  const media = extractMedia(post.photos, post.videos, post.media, post.extended_entities?.media, data.photos, data.videos, data.media, article?.media, article?.photos, article?.videos);
  return { type, title: articleTitle || `@${userName} 的 X 帖子`, text, article_body: articleBody, author: { username: userName, name: asText(user.name || user.display_name) || 'unknown' }, created_at: asText(post.created_at || data.created_at) || 'unknown', media_urls: media.urls, warnings: media.warnings };
}
function renderMarkdown(capture, request, localMedia) {
  const lines = [`# ${markdownTitle(capture.title) || 'X post'}`, '', `- Canonical URL: ${request.canonical_url}`, `- Captured backend: ${capture.backend}`, `- Author: @${capture.author.username}${capture.author.name !== 'unknown' ? ` (${capture.author.name})` : ''}`, `- Created at: ${capture.created_at}`, ''];
  if (capture.type === 'x-article') lines.push('## X Article', '', capture.article_body || capture.text, '', '## Attached post text', '', capture.text || 'unknown'); else lines.push('## Post', '', capture.text);
  if (localMedia.length) lines.push('', '## Local media', '', ...localMedia.map((item) => `- [${item.path}](./${item.path})`));
  return `${lines.join('\n').trimEnd()}\n`;
}
function mediaFilename(url, index) { const ext = path.extname(new URL(url).pathname).replace(/[^.A-Za-z0-9]/g, '').slice(0, 10) || '.bin'; return `${String(index + 1).padStart(2, '0')}-${sha256(url).slice(0, 12)}${ext}`; }
async function downloadMedia(fetchImpl, mediaUrls, stage) {
  const saved = []; const warnings = []; let total = 0;
  for (const [index, sourceUrl] of mediaUrls.entries()) {
    try {
      const parsed = new URL(sourceUrl); if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !MEDIA_HOSTS.has(parsed.hostname)) throw new Error('媒体 URL 不在 HTTPS 域名白名单');
      const bytes = await readLimited(await fetchImpl(sourceUrl, { redirect: 'error', signal: AbortSignal.timeout(20_000) }), MAX_MEDIA_BYTES, `媒体 ${index + 1}`);
      if (total + bytes.length > MAX_MEDIA_TOTAL_BYTES) throw new Error(`媒体总量超过 ${MAX_MEDIA_TOTAL_BYTES} 字节上限`); total += bytes.length;
      const relative = `media/${mediaFilename(sourceUrl, index)}`; const destination = path.join(stage, relative); assertInside(stage, destination, '媒体文件'); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, bytes, { flag: 'wx' }); saved.push({ path: relative, source_url: sourceUrl, bytes: bytes.length, sha256: `sha256:${sha256(bytes)}` });
    } catch (error) { warnings.push(`媒体 ${index + 1} 未保存: ${error.message}`); }
  }
  return { saved, warnings };
}
async function recordFile(root, relative) { const target = path.join(root, relative); assertInside(root, target, '文件'); await regularFile(target, '原文文件'); const bytes = await fs.readFile(target); return { path: relative.split(path.sep).join('/'), bytes: bytes.length, sha256: `sha256:${sha256(bytes)}` }; }
async function walkFiles(root, relative = '') { const current = path.join(root, relative); assertInside(root, current, '目录'); await plainDirectory(current, '目录'); const entries = await fs.readdir(current, { withFileTypes: true }); const files = []; for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) { const rel = path.join(relative, entry.name); if (entry.isSymbolicLink()) fail(`不允许符号链接: ${rel}`); if (entry.isDirectory()) files.push(...await walkFiles(root, rel)); else if (entry.isFile()) files.push(await recordFile(root, rel)); else fail(`不允许特殊文件: ${rel}`); } return files; }
async function captureToStage({ url, repo, stage, fetchImpl = fetch }) {
  const request = parseStatusUrl(url); const root = await repoRoot(repo); const stageBase = await safeStageBase(root, true); const stagePath = path.resolve(stage || path.join(stageBase, `.capture-${request.status_id}-${process.pid}-${Date.now()}`)); assertInside(stageBase, stagePath, '暂存目录'); if (stagePath === stageBase || await exists(stagePath)) fail(`暂存目录已存在或无效: ${stagePath}`); await fs.mkdir(stagePath);
  let received; let backend; const errors = [];
  for (const choice of ['x-syndication', 'fxtwitter']) { try { const candidate = await getJson(fetchImpl, choice === 'x-syndication' ? OFFICIAL_ENDPOINT(request.status_id) : FX_ENDPOINT(request.status_id), choice); normalizeCapture(candidate.data, request, choice); received = candidate; backend = choice; break; } catch (error) { errors.push(`${choice}: ${error.message}`); } }
  if (!received) { await fs.rm(stagePath, { recursive: true, force: true }); fail('所有公开后端均未能提供匹配帖子', { backends: errors }); }
  try {
    const normalized = normalizeCapture(received.data, request, backend); normalized.backend = backend;
    const responsePath = `responses/${backend}.json`; await fs.mkdir(path.join(stagePath, 'responses')); await fs.writeFile(path.join(stagePath, responsePath), received.bytes, { flag: 'wx' });
    const localMedia = await downloadMedia(fetchImpl, normalized.media_urls, stagePath); const warnings = [...normalized.warnings, ...localMedia.warnings];
    if (backend === 'fxtwitter') warnings.unshift('X syndication 未提供匹配内容；本次回退到第三方 FxTwitter，来源真实性保持 third-party-unverified。');
    const markdown = renderMarkdown(normalized, request, localMedia.saved); if (Buffer.byteLength(markdown) > MAX_MARKDOWN_BYTES) fail('生成的 Markdown 超过上限'); await fs.writeFile(path.join(stagePath, 'article.md'), markdown, { flag: 'wx' });
    const authenticity = backend === 'x-syndication' ? 'x-syndication' : 'third-party-unverified'; const capture = { schema_version: SCHEMA_VERSION, kind: 'x-capture-stage', capture_scope: 'single-post', source_authenticity: authenticity, source: request, capture: { retrieved_at: now(), backend, backend_kind: authenticity, response_endpoint: received.endpoint, content_type: normalized.type }, normalized: { title: normalized.title, author: normalized.author, created_at: normalized.created_at, media_urls: normalized.media_urls }, warnings };
    await fs.writeFile(path.join(stagePath, 'capture.json'), `${JSON.stringify(capture, null, 2)}\n`, { flag: 'wx' }); return { ok: true, stage: stagePath, backend, warnings, source: request };
  } catch (error) { await fs.rm(stagePath, { recursive: true, force: true }); throw error; }
}
async function validateStage(stage, repo) {
  const root = await repoRoot(repo || stage); const stageBase = await safeStageBase(root); const stagePath = path.resolve(stage); assertInside(stageBase, stagePath, '暂存目录'); if (stagePath === stageBase) fail('暂存目录不能是 staging/x 根目录'); await plainDirectory(stagePath, '暂存目录');
  await regularFile(path.join(stagePath, 'capture.json'), 'capture.json'); const rawCapture = await fs.readFile(path.join(stagePath, 'capture.json')); let capture; try { capture = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawCapture)); } catch { fail('capture.json 无效'); }
  if (capture?.kind !== 'x-capture-stage' || capture.capture_scope !== 'single-post' || !['x-syndication', 'third-party-unverified'].includes(capture.source_authenticity) || !capture.source?.status_id || !['x-syndication', 'fxtwitter'].includes(capture.capture?.backend)) fail('capture.json schema 无效');
  if ((capture.capture.backend === 'x-syndication') !== (capture.source_authenticity === 'x-syndication')) fail('capture.json 后端真实性标记不一致'); const parsed = parseStatusUrl(capture.source.original_url); if (parsed.status_id !== capture.source.status_id || parsed.canonical_url !== capture.source.canonical_url) fail('capture.json 来源 URL 不一致');
  await regularFile(path.join(stagePath, 'article.md'), 'article.md'); const markdown = await fs.readFile(path.join(stagePath, 'article.md')); if (!markdown.length || markdown.length > MAX_MARKDOWN_BYTES) fail('article.md 缺失、为空或超限'); new TextDecoder('utf-8', { fatal: true }).decode(markdown);
  const files = await walkFiles(stagePath); const allowed = new Set(['article.md', 'capture.json']); for (const item of files) if (!allowed.has(item.path) && !item.path.startsWith('responses/') && !item.path.startsWith('media/')) fail(`暂存文件不在允许布局内: ${item.path}`); if (!files.some((item) => item.path === `responses/${capture.capture.backend}.json`)) fail('缺少原始后端响应');
  const contentFiles = files.filter((item) => item.path !== 'capture.json'); return { root, stage: stagePath, capture, files: contentFiles, content_checksum: checksum(contentFiles) };
}
async function readManifest(bundle) { await regularFile(path.join(bundle, 'manifest.json'), 'manifest'); const bytes = await fs.readFile(path.join(bundle, 'manifest.json')); try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail(`manifest 无效: ${bundle}`); } }
async function verifyBundle(bundle) {
  await plainDirectory(bundle, '原文包'); const manifest = await readManifest(bundle);
  if (manifest.schema_version !== SCHEMA_VERSION || manifest.kind !== 'x-public-status-bundle' || manifest.state !== 'immutable' || manifest.capture_scope !== 'single-post' || !['x-syndication', 'third-party-unverified'].includes(manifest.source_authenticity)) fail('manifest schema、kind、state 或证据范围无效'); if ((manifest.capture?.backend === 'x-syndication') !== (manifest.source_authenticity === 'x-syndication')) fail('manifest 后端真实性标记不一致'); const body = { ...manifest }; delete body.bundle_checksum; if (checksum(body) !== manifest.bundle_checksum) fail('manifest 元数据校验和不匹配');
  const files = (await walkFiles(bundle)).filter((item) => item.path !== 'manifest.json'); if (canonicalJson(files) !== canonicalJson(manifest.files)) fail('文件清单或 SHA-256 与 manifest 不匹配'); if (checksum(files) !== manifest.content_checksum) fail('内容校验和不匹配'); return { ok: true, raw_bundle: bundle, bundle_checksum: manifest.bundle_checksum, content_checksum: manifest.content_checksum, files };
}
async function verifyRaw(raw, repo) {
  const root = await repoRoot(repo || raw); const rawRoot = await safeRawRoot(root); const bundle = path.resolve(raw); assertInside(rawRoot, bundle, '原文包'); if (bundle === rawRoot) fail('原文包不能是 raw/x 根目录'); return verifyBundle(bundle);
}
async function existingBundles(rawRoot) {
  const entries = await fs.readdir(rawRoot, { withFileTypes: true }); const bundles = [];
  for (const entry of entries) { const bundle = path.join(rawRoot, entry.name); if (entry.name.startsWith('.') || entry.isSymbolicLink() || !entry.isDirectory()) fail(`raw/x 包含无效条目: ${bundle}`); const manifest = await readManifest(bundle); bundles.push({ bundle, manifest }); }
  return bundles;
}
async function duplicateResult(finalPath, validation, root) {
  const verified = await verifyRaw(finalPath, root); const manifest = await readManifest(finalPath); if (manifest.source?.canonical_url !== validation.capture.source.canonical_url || manifest.content_checksum !== validation.content_checksum) fail(`目标原文包已存在且与本次内容不同: ${finalPath}`); return { ok: true, action: 'duplicate-noop', raw_bundle: finalPath, bundle_checksum: verified.bundle_checksum, warnings: manifest.warnings || validation.capture.warnings };
}
async function promoteStage(stage, repo) {
  const root = await repoRoot(repo); const validation = await validateStage(stage, root); const rawRoot = await safeRawRoot(root, true); const old = await existingBundles(rawRoot); for (const item of old) await verifyRaw(item.bundle, root); const duplicate = old.find(({ manifest }) => manifest.source?.canonical_url === validation.capture.source.canonical_url && manifest.content_checksum === validation.content_checksum); if (duplicate) return duplicateResult(duplicate.bundle, validation, root);
  const name = `${localDate()}--${slug(validation.capture.normalized?.title)}--u${validation.capture.source.status_id.slice(-12)}--c${validation.content_checksum.slice(7, 15)}`; const finalPath = path.join(rawRoot, name); assertInside(rawRoot, finalPath, '原文包'); if (await exists(finalPath)) return duplicateResult(finalPath, validation, root);
  const tempRoot = await ensureDirectoryChain(root, ['staging', '.x-promote-tmp'], '原文临时目录', { create: true }); const temp = path.join(tempRoot, `.tmp-${name}-${process.pid}-${Math.random().toString(16).slice(2)}`);
  try {
    await fs.mkdir(temp); for (const record of validation.files) { const source = path.join(validation.stage, record.path); const destination = path.join(temp, record.path); assertInside(validation.stage, source, '暂存文件'); assertInside(temp, destination, '原文文件'); const bytes = await fs.readFile(source); if (bytes.length !== record.bytes || `sha256:${sha256(bytes)}` !== record.sha256) fail(`验证后暂存文件发生变化: ${record.path}`); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, bytes, { flag: 'wx' }); }
    const body = { schema_version: SCHEMA_VERSION, kind: 'x-public-status-bundle', state: 'immutable', capture_scope: 'single-post', source_authenticity: validation.capture.source_authenticity, source: validation.capture.source, capture: validation.capture.capture, normalized: validation.capture.normalized, files: validation.files, content_checksum: validation.content_checksum, warnings: validation.capture.warnings, promoted_at: now() }; const manifest = { ...body, bundle_checksum: checksum(body) }; await fs.writeFile(path.join(temp, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await verifyBundle(temp);
    try { await fs.rename(temp, finalPath); } catch (error) { if ((error.code === 'EEXIST' || error.code === 'ENOTEMPTY') && await exists(finalPath)) return duplicateResult(finalPath, validation, root); throw error; }
    return { ok: true, action: 'promoted', raw_bundle: finalPath, manifest: path.join(finalPath, 'manifest.json'), bundle_checksum: manifest.bundle_checksum, backend: body.capture.backend, warnings: body.warnings };
  } finally { if (await exists(temp)) await fs.rm(temp, { recursive: true, force: true }); await fs.rmdir(tempRoot).catch(() => {}); }
}
async function ingestUrl({ url, repo, fetchImpl = fetch }) {
  let captured;
  try { captured = await captureToStage({ url, repo, fetchImpl }); return await promoteStage(captured.stage, repo); }
  catch (error) { if (captured?.stage && await exists(captured.stage)) await fs.rm(captured.stage, { recursive: true, force: true }); throw error; }
}
function args(argv) { const [command, ...rest] = argv; const options = {}; for (let index = 0; index < rest.length; index += 1) { const item = rest[index]; if (!item.startsWith('--')) fail(`无效参数: ${item}`); const key = item.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase()); const value = rest[++index]; if (!value || value.startsWith('--') || Object.hasOwn(options, key)) fail(`参数无效或重复: ${item}`); options[key] = value; } return { command, options }; }
function help() { return 'X 公开帖子不可变归档工具\n\n用法:\n  x_ingest.mjs ingest --url URL [--repo PATH]\n  x_ingest.mjs capture --url URL [--repo PATH]\n  x_ingest.mjs validate --stage PATH [--repo PATH]\n  x_ingest.mjs promote --stage PATH [--repo PATH]\n  x_ingest.mjs verify --raw PATH [--repo PATH]'; }
async function main(argv) {
  if (!argv.length || ['help', '-h', '--help'].includes(argv[0])) { process.stdout.write(`${help()}\n`); return; }
  const { command, options } = args(argv); let result;
  if (command === 'capture') { if (!options.url) fail('capture 需要 --url'); result = await captureToStage({ url: options.url, repo: options.repo }); }
  else if (command === 'validate') { if (!options.stage) fail('validate 需要 --stage'); result = await validateStage(options.stage, options.repo); }
  else if (command === 'promote') { if (!options.stage) fail('promote 需要 --stage'); result = await promoteStage(options.stage, options.repo); }
  else if (command === 'verify') { if (!options.raw) fail('verify 需要 --raw'); result = await verifyRaw(options.raw, options.repo); }
  else if (command === 'ingest') { if (!options.url) fail('ingest 需要 --url'); result = await ingestUrl({ url: options.url, repo: options.repo }); }
  else fail(`未知命令: ${command}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
const direct = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (direct) main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${JSON.stringify({ ok: false, error: error.message, details: error.details }, null, 2)}\n`); process.exitCode = 1; });
export { MAX_JSON_BYTES, captureToStage, draftMarkdown, extractMedia, ingestUrl, parseStatusUrl, promoteStage, validateStage, verifyRaw };
