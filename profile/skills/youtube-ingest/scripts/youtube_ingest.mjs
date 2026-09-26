#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SCHEMA_VERSION = 1;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const LANGUAGE_RE = /^[A-Za-z0-9._-]{1,48}$/;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_SUBTITLE_BYTES = 10 * 1024 * 1024;
const MAX_ARTICLE_BYTES = 10 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 45_000;
const WARNING_CODES = new Set(['caption-fetch-failed', 'caption-no-valid-cues', 'caption-track-unavailable']);

function fail(message, details) { const error = new Error(message); error.details = details; throw error; }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function canonicalJson(value) { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`; return JSON.stringify(value); }
function checksum(value) { return `sha256:${sha256(canonicalJson(value))}`; }
function hasExactKeys(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()); }
function inside(parent, target) { const relative = path.relative(parent, target); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
function assertInside(parent, target, label) { if (!inside(parent, target)) fail(`${label}超出允许目录: ${target}`); }
function safeText(value, fallback = 'unknown') { return typeof value === 'string' && value.trim() ? value.trim().replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ') : fallback; }
function today() { return new Date().toISOString().slice(0, 10); }
async function exists(target) { try { await fs.access(target); return true; } catch { return false; } }
function allowedShareParams(url, primary) {
  const allowed = new Set(['si', 'feature', 't', 'start', 'list', 'index', 'start_radio', 'pp']);
  for (const key of url.searchParams.keys()) {
    if (key === primary) continue;
    if (!allowed.has(key) && !key.startsWith('utm_')) fail(`YouTube URL 包含不支持的参数: ${key}`);
  }
}

function parseVideoUrl(raw) {
  let url; try { url = new URL(raw); } catch { fail(`无效 YouTube 视频 URL: ${raw}`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) fail('仅接受无凭据、无端口的 HTTPS YouTube 视频 URL');
  const host = url.hostname.toLowerCase(); let videoId;
  if (host === 'www.youtube.com' && url.pathname === '/watch') {
    if (url.searchParams.getAll('v').length !== 1) fail('watch URL 必须包含且只包含一个 v 参数');
    allowedShareParams(url, 'v');
    videoId = url.searchParams.get('v');
  } else if (host === 'youtu.be') {
    const match = /^\/([^/]+)$/.exec(url.pathname); if (!match) fail('youtu.be URL 必须严格为 /<video-id>'); allowedShareParams(url, null); videoId = match?.[1];
  } else if (host === 'www.youtube.com') {
    const match = /^\/shorts\/([^/]+)$/.exec(url.pathname); if (!match) fail('YouTube URL 必须是严格的 /watch?v=、/shorts/<id> 或 youtu.be/<id>'); allowedShareParams(url, null); videoId = match?.[1];
  } else fail('仅接受 www.youtube.com 或 youtu.be');
  if (!VIDEO_ID_RE.test(videoId || '')) fail('YouTube video ID 必须是 11 个合法字符');
  const canonical_url = `https://www.youtube.com/watch?v=${videoId}`;
  return { original_url: canonical_url, canonical_url, video_id: videoId };
}

async function plainDirectory(target, label, { create = false } = {}) { if (create) await fs.mkdir(target, { recursive: false }).catch((error) => { if (error.code !== 'EEXIST') throw error; }); const stat = await fs.lstat(target).catch(() => null); if (!stat?.isDirectory() || stat.isSymbolicLink()) fail(`${label}不是普通目录: ${target}`); return stat; }
async function regularFile(target, label) { const stat = await fs.lstat(target).catch(() => null); if (!stat?.isFile() || stat.isSymbolicLink()) fail(`${label}不是普通文件: ${target}`); return stat; }
async function readRegular(target, label, limit) { const before = await regularFile(target, label); if (before.size > limit) fail(`${label}超过 ${limit} 字节上限`); const bytes = await fs.readFile(target); const after = await regularFile(target, label); if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || bytes.length !== before.size) fail(`${label}读取期间发生变化: ${target}`); return bytes; }
async function directoryIdentity(target, label) { const stat = await plainDirectory(target, label); return { dev: String(stat.dev), ino: String(stat.ino) }; }
async function assertDirectoryIdentity(target, identity, label) { const actual = await directoryIdentity(target, label); if (actual.dev !== identity.dev || actual.ino !== identity.ino) fail(`${label}在校验后发生目录替换: ${target}`); }
function assertDirectChild(parent, child, label) { assertInside(parent, child, label); if (path.dirname(child) !== parent) fail(`${label}必须是平台根目录的直接子目录: ${child}`); }
async function directoryChain(root, parts, label, { create = false } = {}) { await plainDirectory(root, '仓库根目录'); let current = root; for (const part of parts) { if (!/^[A-Za-z0-9._-]+$/.test(part)) fail(`${label}路径段无效: ${part}`); current = path.join(current, part); assertInside(root, current, label); await plainDirectory(current, label, { create }); } return current; }
async function repoRoot(value) { let current = path.resolve(value || process.cwd()); while (true) { const agents = await fs.lstat(path.join(current, 'AGENTS.md')).catch(() => null); const wiki = await fs.lstat(path.join(current, 'wiki')).catch(() => null); if (agents?.isFile() && !agents.isSymbolicLink() && wiki?.isDirectory() && !wiki.isSymbolicLink()) { await plainDirectory(current, '仓库根目录'); return current; } const parent = path.dirname(current); if (parent === current) fail('找不到同时含 AGENTS.md 和 wiki/ 的仓库根目录；请传入 --repo'); current = parent; } }
async function stageRoot(root, create = false) { return directoryChain(root, ['staging', 'youtube'], '暂存目录', { create }); }
async function rawRoot(root, create = false) { return directoryChain(root, ['raw', 'youtube'], 'raw/youtube', { create }); }
function parseJson(bytes, label) { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail(`${label}不是有效 UTF-8 JSON`); } }

function run(command, args, { cwd, maxBytes = MAX_METADATA_BYTES, timeoutMs = COMMAND_TIMEOUT_MS, graceMs = 250, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let child; try { child = spawnImpl(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); } catch (error) { reject(new Error('yt-dlp 命令不可执行')); return; }
    let output = []; let size = 0; let termination = null; let settled = false; let timer; let killTimer;
    const finish = (callback) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); callback(); };
    const terminate = (reason) => { if (termination || settled) return; termination = reason; child.kill('SIGTERM'); killTimer = setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, graceMs); };
    timer = setTimeout(() => terminate('timeout'), timeoutMs);
    const add = (list, chunk) => { size += chunk.length; if (size <= maxBytes) list.push(chunk); else terminate('oversize'); };
    child.stdout.on('data', (chunk) => add(output, chunk)); child.stderr.on('data', (chunk) => add([], chunk));
    child.once('error', () => finish(() => reject(new Error('yt-dlp 命令不可执行'))));
    child.once('close', (code) => finish(() => { if (termination === 'timeout') reject(new Error(`yt-dlp 命令超过 ${timeoutMs}ms 超时`)); else if (termination === 'oversize') reject(new Error(`yt-dlp 输出超过 ${maxBytes} 字节上限`)); else if (code !== 0) reject(new Error(`yt-dlp 命令失败 (${code})`)); else resolve(Buffer.concat(output)); }));
  });
}
async function defaultMetadataFetcher({ source }) {
  const output = await run('yt-dlp', ['--ignore-config', '--skip-download', '--no-playlist', '--no-warnings', '--dump-single-json', source.canonical_url], { maxBytes: MAX_METADATA_BYTES });
  return { metadata: parseJson(output, 'yt-dlp metadata') };
}

function limitedString(value, fallback = 'unknown') { const text = safeText(value, fallback); if (Buffer.byteLength(text) > 100_000) fail('元数据文本字段过大'); return text; }
function classifyRestricted(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.is_live === true || ['is_live', 'live', 'is_upcoming', 'upcoming'].includes(value.live_status)) return 'active/upcoming live';
  if (value.is_private === true || value._type === 'url_transparent') return '私密、删除或访问受限';
  if (Number(value.age_limit) > 0) return '年龄受限';
  if (!['public', 'unlisted'].includes(value.availability)) return 'availability 非公开或未知';
  return null;
}
function normalizeMetadata(raw, source) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('yt-dlp metadata schema 无效');
  if (raw.id !== source.video_id || !VIDEO_ID_RE.test(raw.id || '')) fail('yt-dlp metadata video ID 与请求不一致');
  if (raw.extractor_key !== 'Youtube' || raw.extractor !== 'youtube' || Array.isArray(raw.entries)) fail('yt-dlp metadata 不是唯一 YouTube video 结果');
  if (typeof raw.webpage_url !== 'string' || parseVideoUrl(raw.webpage_url).video_id !== source.video_id) fail('yt-dlp webpage URL 与请求 video ID 不一致');
  const restricted = classifyRestricted(raw); if (restricted) fail(`仅允许可公开访问的非活动直播视频: ${restricted}`);
  const duration = raw.duration === null || raw.duration === undefined ? 'unknown' : Number(raw.duration); if (duration !== 'unknown' && (!Number.isFinite(duration) || duration < 0)) fail('yt-dlp metadata duration 无效');
  return { id: raw.id, title: limitedString(raw.title), uploader: limitedString(raw.uploader), channel: limitedString(raw.channel), channel_id: limitedString(raw.channel_id), upload_date: typeof raw.upload_date === 'string' && /^\d{8}$/.test(raw.upload_date) ? raw.upload_date : 'unknown', timestamp: Number.isFinite(Number(raw.timestamp)) ? Number(raw.timestamp) : 'unknown', duration, description: limitedString(raw.description, ''), live_status: safeText(raw.live_status, 'not_live'), webpage_url: source.canonical_url, original_language: LANGUAGE_RE.test(raw.original_language || '') ? raw.original_language : null, was_live: raw.was_live === true };
}
function safeTrackLanguage(language) { return typeof language === 'string' && LANGUAGE_RE.test(language) ? language : null; }
function summarizeTrack(track) { const formats = Array.isArray(track) ? track : []; return formats.map((format) => ({ ext: safeText(format?.ext, 'unknown'), format_id: safeText(format?.format_id, 'unknown'), protocol: safeText(format?.protocol, 'unknown') })).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))); }
function inventoryFromMetadata(raw) {
  const rows = [];
  for (const [kind, collection] of [['manual', raw?.subtitles], ['automatic', raw?.automatic_captions]]) {
    if (!collection || typeof collection !== 'object' || Array.isArray(collection)) continue;
    for (const language of Object.keys(collection).sort((a, b) => a.localeCompare(b))) { if (!safeTrackLanguage(language)) continue; rows.push({ stable_track_id: `${kind}:${language}`, kind, language, formats: summarizeTrack(collection[language]) }); }
  }
  return rows;
}
function languageRank(language, original) { const fixed = ['zh-Hans', 'zh-Hant', 'zh', 'en']; const fixedIndex = fixed.indexOf(language); if (fixedIndex !== -1) return [fixedIndex, '']; if (original && language === original) return [4, '']; return [5, language]; }
function selectSubtitleTrack(inventory, originalLanguage) { const candidates = inventory.filter((item) => item.formats.some((format) => format.ext === 'vtt')); const manual = candidates.filter((item) => item.kind === 'manual').sort((a, b) => { const left = languageRank(a.language, originalLanguage); const right = languageRank(b.language, originalLanguage); return left[0] - right[0] || left[1].localeCompare(right[1]) || a.stable_track_id.localeCompare(b.stable_track_id); })[0]; if (manual) return manual; if (!originalLanguage) return null; return candidates.find((item) => item.kind === 'automatic' && item.language === originalLanguage) || null; }
function captionRelative(source, track) { return `captions/${source.video_id}.${track.language}.${track.kind}.vtt`; }
function vttCues(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); if (!/^WEBVTT(?:\s|$)/.test(text)) fail('字幕不是 VTT');
  const cues = []; const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/).slice(1);
  const time = (value) => { const matched = /^(?:(\d{2,}):)?(\d{2}):(\d{2}(?:\.\d{1,3})?)$/.exec(value.trim()); if (!matched) return Number.NaN; return Number(matched[1] || 0) * 3600 + Number(matched[2]) * 60 + Number(matched[3]); };
  for (const block of blocks) { const lines = block.split('\n').filter(Boolean); const timing = lines.findIndex((line) => line.includes('-->')); if (timing < 0) continue; const [fromText, rest] = lines[timing].split('-->'); const toText = rest.trim().split(/\s+/)[0]; const from = time(fromText); const to = time(toText); const content = lines.slice(timing + 1).join(' ').replace(/<[^>]*>/g, '').trim(); if (Number.isFinite(from) && Number.isFinite(to) && from >= 0 && to >= from && content) cues.push({ from, to, content }); }
  return cues.sort((a, b) => a.from - b.from || a.to - b.to || a.content.localeCompare(b.content));
}
function assertCuesWithinDuration(cues, duration) { if (typeof duration !== 'number') return; const last = Math.max(...cues.map((cue) => cue.to)); if (last > duration + 5) fail('字幕 cue 超出视频时长容差'); }
function stamp(value) { const h = Math.floor(value / 3600); const m = Math.floor((value % 3600) / 60); const s = value % 60; return `${h ? `${String(h).padStart(2, '0')}:` : ''}${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`; }
function renderArticle(source, metadata, selected, cues) {
  const lines = [`# ${metadata.title}`, '', `- Canonical URL: ${source.canonical_url}`, `- Video ID: ${source.video_id}`, `- Uploader: ${metadata.uploader}`, `- Channel: ${metadata.channel}`, `- Upload date: ${metadata.upload_date}`, `- Duration: ${metadata.duration}`, '- Metadata: [metadata.json](./metadata.json)', ''];
  if (selected && cues.length) { lines.push(`- Subtitle: [${selected.path}](./${selected.path})`, `- Subtitle kind: ${selected.kind}`, `- Subtitle language: ${selected.language}`, `- Subtitle source language: ${selected.source_language || metadata.original_language || 'unknown'}`, `- Subtitle translation state: ${selected.translation_state || 'unknown'}`, `- Stable track: ${selected.stable_track_id}`, '', '## 字幕 cues', '', ...cues.map((cue) => `- [${stamp(cue.from)} → ${stamp(cue.to)}] ${cue.content}`)); } else lines.push('## 字幕状态', '', '- 未取得并固化有效字幕 cue；这不表示该视频没有字幕。');
  return `${lines.join('\n').trimEnd()}\n`;
}
async function defaultSubtitleFetcher({ source, track, stage }) {
  const outputDir = path.join(stage, '.yt-dlp-output'); await fs.mkdir(outputDir, { recursive: false });
  const flag = track.kind === 'manual' ? '--write-subs' : '--write-auto-subs';
  await run('yt-dlp', ['--ignore-config', '--skip-download', '--no-playlist', '--no-warnings', flag, '--sub-langs', track.language, '--sub-format', 'vtt', '--paths', `home:${outputDir}`, '--output', `${source.video_id}.%(ext)s`, source.canonical_url], { cwd: stage, maxBytes: MAX_SUBTITLE_BYTES });
  const expected = path.join(outputDir, `${source.video_id}.${track.language}.vtt`); await regularFile(expected, 'yt-dlp 字幕文件'); const result = { path: expected }; return result;
}
async function materializeSubtitle(result, stage, source, track, duration) {
  if (!result) return null; const relative = captionRelative(source, track); const target = path.join(stage, relative); assertInside(stage, target, '字幕目标'); await fs.mkdir(path.dirname(target), { recursive: true });
  if (typeof result === 'string' || Buffer.isBuffer(result)) await fs.writeFile(target, result, { flag: 'wx' });
  else if (typeof result === 'object' && (typeof result.content === 'string' || Buffer.isBuffer(result.content))) await fs.writeFile(target, result.content, { flag: 'wx' });
  else if (typeof result === 'object' && result.path) { const origin = path.resolve(result.path); assertInside(stage, origin, 'yt-dlp 字幕文件'); const bytes = await readRegular(origin, 'yt-dlp 字幕文件', MAX_SUBTITLE_BYTES); await fs.writeFile(target, bytes, { flag: 'wx' }); }
  else fail('字幕后端返回无效结果');
  const bytes = await readRegular(target, '字幕文件', MAX_SUBTITLE_BYTES); const cues = vttCues(bytes); if (!cues.length) { await fs.unlink(target); return null; } assertCuesWithinDuration(cues, duration); return { path: relative, kind: track.kind, language: track.language, stable_track_id: track.stable_track_id, cue_count: cues.length, cues };
}

async function stageVideo({ url, repo, stage, metadataImpl = defaultMetadataFetcher, subtitleImpl = defaultSubtitleFetcher }) {
  const source = parseVideoUrl(url); const root = await repoRoot(repo); const parent = await stageRoot(root, true); const stagePath = path.resolve(stage || path.join(parent, `.capture-${source.video_id}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)); assertDirectChild(parent, stagePath, '暂存目录'); if (await exists(stagePath)) fail(`暂存目录已存在或无效: ${stagePath}`); await fs.mkdir(stagePath); const stageIdentity = await directoryIdentity(stagePath, '暂存目录');
  try {
    const received = await metadataImpl({ source }); const rawMetadata = received?.metadata && typeof received.metadata === 'object' ? received.metadata : received; const metadata = normalizeMetadata(rawMetadata, source); const metadataBytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`); if (metadataBytes.length > MAX_METADATA_BYTES) fail(`元数据超过 ${MAX_METADATA_BYTES} 字节上限`); await fs.writeFile(path.join(stagePath, 'metadata.json'), metadataBytes, { flag: 'wx' });
    const track_inventory = inventoryFromMetadata(rawMetadata); const selectedTrack = selectSubtitleTrack(track_inventory, metadata.original_language); const warnings = []; let selected = null;
    if (selectedTrack) { try { selected = await materializeSubtitle(await subtitleImpl({ source, track: selectedTrack, stage: stagePath }), stagePath, source, selectedTrack, metadata.duration); if (!selected) warnings.push('caption-no-valid-cues'); } catch (error) { if (error?.message === '字幕 cue 超出视频时长容差') throw error; warnings.push('caption-fetch-failed'); } finally { await fs.rm(path.join(stagePath, '.yt-dlp-output'), { recursive: true, force: true }); } } else warnings.push('caption-track-unavailable');
    // capture.json is mutable staging data. It cannot attest which implementation
    // produced it, so persisted provenance is intentionally declaration-only.
    const metadataAuthenticity = 'stage-declared-youtube-metadata-needs-review';
    const subtitleAuthenticity = selected ? 'stage-declared-youtube-caption-needs-review' : 'unavailable-not-absence-proof';
    const sourceAuthenticity = selected ? 'stage-declared-youtube-tool-mediated-needs-review' : 'stage-declared-youtube-metadata-only-needs-review';
    const translationState = selected ? (selected.kind === 'automatic' ? 'automatic-source-language-only' : 'unknown') : 'none';
    const capture = { schema_version: SCHEMA_VERSION, kind: 'youtube-video-capture-stage', state: 'staged', capture_scope: 'single-public-video', source_authenticity: sourceAuthenticity, metadata_authenticity: metadataAuthenticity, subtitle_authenticity: subtitleAuthenticity, subtitle_kind: selected?.kind || 'none', subtitle_language: selected?.language || null, source_language: metadata.original_language, translation_state: translationState, transcript_available: Boolean(selected), source, capture: { provenance_attestation: 'stage-declared-only', subtitle_selection: 'manual-first-zh-hans-zh-hant-zh-en-original-stable-automatic-original-only' }, metadata, track_inventory, selected_track: selected ? { path: selected.path, kind: selected.kind, language: selected.language, stable_track_id: selected.stable_track_id, cue_count: selected.cue_count, source_language: metadata.original_language, translation_state: translationState } : null, warnings };
    const article = renderArticle(source, metadata, capture.selected_track, selected?.cues || []); if (Buffer.byteLength(article) > MAX_ARTICLE_BYTES) fail(`生成的 Markdown 超过 ${MAX_ARTICLE_BYTES} 字节上限`); await fs.writeFile(path.join(stagePath, 'article.md'), article, { flag: 'wx' }); await fs.writeFile(path.join(stagePath, 'capture.json'), `${JSON.stringify(capture, null, 2)}\n`, { flag: 'wx' });
    return { ok: true, stage: stagePath, stage_identity: stageIdentity, source, warnings, transcript_available: capture.transcript_available, subtitle_kind: capture.subtitle_kind, subtitle_language: capture.subtitle_language, source_language: capture.source_language, translation_state: capture.translation_state, stable_track_id: capture.selected_track?.stable_track_id || null };
  } catch (error) { await fs.rm(stagePath, { recursive: true, force: true }); throw error; }
}

async function recordFile(root, relative) { const target = path.join(root, relative); assertInside(root, target, '文件'); const bytes = await readRegular(target, '原文文件', Math.max(MAX_METADATA_BYTES, MAX_SUBTITLE_BYTES, MAX_ARTICLE_BYTES)); return { path: relative.split(path.sep).join('/'), bytes: bytes.length, sha256: `sha256:${sha256(bytes)}` }; }
async function walkFiles(root, relative = '') { const current = path.join(root, relative); assertInside(root, current, '目录'); await plainDirectory(current, '目录'); const files = []; for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) { const rel = path.join(relative, entry.name); if (entry.isSymbolicLink()) fail(`不允许符号链接: ${rel}`); if (entry.isDirectory()) files.push(...await walkFiles(root, rel)); else if (entry.isFile()) files.push(await recordFile(root, rel)); else fail(`不允许特殊文件: ${rel}`); } return files; }
function expectedPaths(capture) { return new Set(['metadata.json', 'article.md', 'capture.json', ...(capture.selected_track ? [capture.selected_track.path] : [])]); }
function validateCapture(capture) {
  const captureKeys = ['schema_version', 'kind', 'state', 'capture_scope', 'source_authenticity', 'metadata_authenticity', 'subtitle_authenticity', 'subtitle_kind', 'subtitle_language', 'source_language', 'translation_state', 'transcript_available', 'source', 'capture', 'metadata', 'track_inventory', 'selected_track', 'warnings'];
  if (!hasExactKeys(capture, captureKeys) || capture.schema_version !== SCHEMA_VERSION || capture.kind !== 'youtube-video-capture-stage' || capture.state !== 'staged') fail('capture.json schema 无效'); const source = capture.source; if (!hasExactKeys(source, ['original_url', 'canonical_url', 'video_id']) || parseVideoUrl(source.canonical_url).video_id !== source.video_id || source.original_url !== source.canonical_url) fail('capture source 无效');
  const metadataKeys = ['id', 'title', 'uploader', 'channel', 'channel_id', 'upload_date', 'timestamp', 'duration', 'description', 'live_status', 'webpage_url', 'original_language', 'was_live'];
  if (!hasExactKeys(capture.metadata, metadataKeys) || capture.metadata.id !== source.video_id || !Array.isArray(capture.track_inventory) || capture.track_inventory.some((track) => !hasExactKeys(track, ['stable_track_id', 'kind', 'language', 'formats']) || !Array.isArray(track.formats) || track.formats.some((format) => !hasExactKeys(format, ['ext', 'format_id', 'protocol']))) || !Array.isArray(capture.warnings) || capture.warnings.some((warning) => !WARNING_CODES.has(warning))) fail('capture metadata、轨道清单或 warning 无效');
  if (capture.selected_track && !hasExactKeys(capture.selected_track, ['path', 'kind', 'language', 'stable_track_id', 'cue_count', 'source_language', 'translation_state'])) fail('selected_track schema 无效');
  if (!hasExactKeys(capture.capture, ['provenance_attestation', 'subtitle_selection'])) fail('capture provenance schema 无效');
  if (capture.capture?.provenance_attestation !== 'stage-declared-only' || capture.capture?.subtitle_selection !== 'manual-first-zh-hans-zh-hant-zh-en-original-stable-automatic-original-only') fail('capture provenance 或字幕选择策略无效');
  const expectedMetadataAuthenticity = 'stage-declared-youtube-metadata-needs-review';
  const chosen = selectSubtitleTrack(capture.track_inventory, capture.metadata.original_language); if (capture.selected_track) { if (!chosen || canonicalJson({ kind: chosen.kind, language: chosen.language, stable_track_id: chosen.stable_track_id }) !== canonicalJson({ kind: capture.selected_track.kind, language: capture.selected_track.language, stable_track_id: capture.selected_track.stable_track_id })) fail('选定字幕轨不符合确定性规则'); if (capture.selected_track.path !== captionRelative(source, chosen) || !Number.isSafeInteger(capture.selected_track.cue_count) || capture.selected_track.cue_count < 1 || capture.selected_track.source_language !== capture.metadata.original_language) fail('选定字幕文件或 cue_count 无效'); const expectedTranslationState = chosen.kind === 'automatic' ? 'automatic-source-language-only' : 'unknown'; if (!capture.transcript_available || capture.subtitle_kind !== chosen.kind || capture.subtitle_language !== chosen.language || capture.source_language !== capture.metadata.original_language || capture.translation_state !== expectedTranslationState || capture.selected_track.translation_state !== expectedTranslationState || capture.source_authenticity !== 'stage-declared-youtube-tool-mediated-needs-review' || capture.subtitle_authenticity !== 'stage-declared-youtube-caption-needs-review') fail('字幕状态或真实性字段不一致'); } else { if (capture.transcript_available || capture.subtitle_kind !== 'none' || capture.subtitle_language !== null || capture.translation_state !== 'none' || capture.source_language !== capture.metadata.original_language || capture.source_authenticity !== 'stage-declared-youtube-metadata-only-needs-review' || capture.subtitle_authenticity !== 'unavailable-not-absence-proof') fail('metadata-only 字幕状态或真实性字段不一致'); } if (capture.capture_scope !== 'single-public-video' || capture.metadata_authenticity !== expectedMetadataAuthenticity) fail('capture scope 或 metadata 真实性字段无效'); return source;
}
async function validateStage(stage, repo, options = {}) {
  const root = await repoRoot(repo || stage); const parent = await stageRoot(root); const bundle = path.resolve(stage); assertDirectChild(parent, bundle, '暂存目录'); const identity = await directoryIdentity(bundle, '暂存目录'); const capture = parseJson(await readRegular(path.join(bundle, 'capture.json'), 'capture.json', MAX_METADATA_BYTES), 'capture.json'); const source = validateCapture(capture); const metadata = parseJson(await readRegular(path.join(bundle, 'metadata.json'), 'metadata.json', MAX_METADATA_BYTES), 'metadata.json'); if (canonicalJson(metadata) !== canonicalJson(capture.metadata)) fail('metadata.json 与 capture.json 不一致');
  let cues = []; if (capture.selected_track) { const target = path.join(bundle, capture.selected_track.path); assertInside(bundle, target, '字幕文件'); const bytes = await readRegular(target, '字幕文件', MAX_SUBTITLE_BYTES); cues = vttCues(bytes); if (cues.length !== capture.selected_track.cue_count || !cues.length) fail('字幕 cue_count 不一致或为空'); assertCuesWithinDuration(cues, metadata.duration); }
  const article = await readRegular(path.join(bundle, 'article.md'), 'article.md', MAX_ARTICLE_BYTES); if (!article.equals(Buffer.from(renderArticle(source, metadata, capture.selected_track, cues)))) fail('article.md 不是由元数据和字幕确定性渲染的结果'); const files = await walkFiles(bundle); const actual = new Set(files.map((file) => file.path)); const expected = expectedPaths(capture); if (actual.size !== expected.size || [...actual].some((item) => !expected.has(item))) fail('暂存包包含未声明文件'); await options.testHook?.beforeIdentityCheck?.(); await assertDirectoryIdentity(bundle, identity, '暂存目录'); const content_checksum = checksum({ source, files }); return { ok: true, stage: bundle, stage_identity: identity, capture, files, content_checksum };
}
async function readManifest(bundle) { return parseJson(await readRegular(path.join(bundle, 'manifest.json'), 'manifest.json', MAX_METADATA_BYTES), 'manifest.json'); }
async function verifyBundle(bundle) {
  const identity = await directoryIdentity(bundle, '原文包'); const manifest = await readManifest(bundle); if (manifest?.schema_version !== SCHEMA_VERSION || manifest.kind !== 'youtube-video-bundle' || manifest.state !== 'immutable') fail('manifest schema 无效'); const { files: manifestFiles, content_checksum: manifestContentChecksum, bundle_checksum: manifestBundleChecksum, promoted_at: manifestPromotedAt, ...captureFields } = manifest; const source = validateCapture({ ...captureFields, kind: 'youtube-video-capture-stage', state: 'staged' }); if (!Array.isArray(manifestFiles) || typeof manifestContentChecksum !== 'string' || typeof manifestBundleChecksum !== 'string' || typeof manifestPromotedAt !== 'string') fail('manifest bundle 字段无效'); const actual = await walkFiles(bundle); const expected = new Set([...(manifest.files || []).map((file) => file.path), 'manifest.json']); if (actual.length !== expected.size || actual.some((file) => !expected.has(file.path))) fail('manifest 文件清单不完整或含额外文件'); for (const file of manifest.files || []) { const actualFile = actual.find((item) => item.path === file.path); if (!actualFile || canonicalJson(actualFile) !== canonicalJson(file)) fail(`文件清单或 SHA-256 不一致: ${file.path}`); }
  if (manifest.content_checksum !== checksum({ source, files: manifest.files })) fail('content_checksum 不一致'); const body = { ...manifest }; delete body.bundle_checksum; if (manifest.bundle_checksum !== checksum(body)) fail('bundle_checksum 不一致'); const bundledCapture = parseJson(await readRegular(path.join(bundle, 'capture.json'), 'capture.json', MAX_METADATA_BYTES), 'capture.json'); const expectedCapture = { ...captureFields, kind: 'youtube-video-capture-stage', state: 'staged' }; if (canonicalJson(bundledCapture) !== canonicalJson(expectedCapture)) fail('capture.json 与 manifest 声明不一致'); const metadata = parseJson(await readRegular(path.join(bundle, 'metadata.json'), 'metadata.json', MAX_METADATA_BYTES), 'metadata.json'); if (canonicalJson(metadata) !== canonicalJson(manifest.metadata)) fail('manifest metadata 不一致'); let cues = []; if (manifest.selected_track) { cues = vttCues(await readRegular(path.join(bundle, manifest.selected_track.path), '字幕文件', MAX_SUBTITLE_BYTES)); if (!cues.length || cues.length !== manifest.selected_track.cue_count) fail('manifest 字幕 cue_count 不一致'); assertCuesWithinDuration(cues, metadata.duration); }
  const article = await readRegular(path.join(bundle, 'article.md'), 'article.md', MAX_ARTICLE_BYTES); if (!article.equals(Buffer.from(renderArticle(source, metadata, manifest.selected_track, cues)))) fail('article.md 不是确定性渲染结果'); await assertDirectoryIdentity(bundle, identity, '原文包'); return { ok: true, raw_bundle: bundle, bundle_checksum: manifest.bundle_checksum, content_checksum: manifest.content_checksum, source, source_authenticity: manifest.source_authenticity, metadata_authenticity: manifest.metadata_authenticity, subtitle_authenticity: manifest.subtitle_authenticity, transcript_available: manifest.transcript_available, subtitle_kind: manifest.subtitle_kind, subtitle_language: manifest.subtitle_language, source_language: manifest.source_language, translation_state: manifest.translation_state, stable_track_id: manifest.selected_track?.stable_track_id || null, warnings: manifest.warnings || [] };
}
async function verifyRaw(raw, repo) { const root = await repoRoot(repo || raw); const parent = await rawRoot(root); const bundle = path.resolve(raw); assertDirectChild(parent, bundle, '原文包'); return verifyBundle(bundle); }
async function existingBundles(parent) { const values = []; for (const entry of await fs.readdir(parent, { withFileTypes: true })) { const target = path.join(parent, entry.name); if (entry.name.startsWith('.') || entry.isSymbolicLink() || !entry.isDirectory()) fail(`raw/youtube 包含无效条目: ${target}`); values.push({ bundle: target, manifest: await readManifest(target) }); } return values; }
async function duplicateResult(bundle, validation, root) { const verified = await verifyRaw(bundle, root); const manifest = await readManifest(bundle); if (manifest.source.canonical_url !== validation.capture.source.canonical_url || manifest.content_checksum !== validation.content_checksum) fail(`目标原文包已存在且与本次内容不同: ${bundle}`); return { ok: true, action: 'duplicate-noop', raw_bundle: bundle, manifest: path.join(bundle, 'manifest.json'), bundle_checksum: verified.bundle_checksum, transcript_available: verified.transcript_available, subtitle_kind: verified.subtitle_kind, subtitle_language: verified.subtitle_language, source_language: verified.source_language, translation_state: verified.translation_state, stable_track_id: verified.stable_track_id, warnings: manifest.warnings || [] }; }
async function promoteStage(stage, repo) {
  const root = await repoRoot(repo); const validation = await validateStage(stage, root); await assertDirectoryIdentity(validation.stage, validation.stage_identity, '暂存目录'); const parent = await rawRoot(root, true); const prior = await existingBundles(parent); for (const item of prior) await verifyRaw(item.bundle, root); const duplicate = prior.find((item) => item.manifest.source?.canonical_url === validation.capture.source.canonical_url && item.manifest.content_checksum === validation.content_checksum); if (duplicate) return duplicateResult(duplicate.bundle, validation, root);
  const slug = safeText(validation.capture.metadata.title).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'youtube-video'; const name = `${today()}--${slug}--${validation.capture.source.video_id}--c${validation.content_checksum.slice(7, 15)}`; const finalPath = path.join(parent, name); assertDirectChild(parent, finalPath, '原文包'); if (await exists(finalPath)) return duplicateResult(finalPath, validation, root);
  const tmpParent = await directoryChain(root, ['staging', '.youtube-promote-tmp'], '原文临时目录', { create: true }); const temp = path.join(tmpParent, `.tmp-${name}-${process.pid}-${Math.random().toString(16).slice(2)}`);
  try { await fs.mkdir(temp); for (const record of validation.files) { const source = path.join(validation.stage, record.path); const target = path.join(temp, record.path); assertInside(validation.stage, source, '暂存文件'); assertInside(temp, target, '原文文件'); const bytes = await readRegular(source, `暂存文件 ${record.path}`, Math.max(MAX_METADATA_BYTES, MAX_SUBTITLE_BYTES, MAX_ARTICLE_BYTES)); if (bytes.length !== record.bytes || `sha256:${sha256(bytes)}` !== record.sha256) fail(`验证后暂存文件发生变化: ${record.path}`); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes, { flag: 'wx' }); }
    const body = { schema_version: SCHEMA_VERSION, kind: 'youtube-video-bundle', state: 'immutable', capture_scope: 'single-public-video', source_authenticity: validation.capture.source_authenticity, metadata_authenticity: validation.capture.metadata_authenticity, subtitle_authenticity: validation.capture.subtitle_authenticity, subtitle_kind: validation.capture.subtitle_kind, subtitle_language: validation.capture.subtitle_language, source_language: validation.capture.source_language, translation_state: validation.capture.translation_state, transcript_available: validation.capture.transcript_available, source: validation.capture.source, capture: validation.capture.capture, metadata: validation.capture.metadata, track_inventory: validation.capture.track_inventory, selected_track: validation.capture.selected_track, files: validation.files, content_checksum: validation.content_checksum, warnings: validation.capture.warnings, promoted_at: new Date().toISOString() }; const manifest = { ...body, bundle_checksum: checksum(body) }; await fs.writeFile(path.join(temp, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' }); await verifyBundle(temp); try { await fs.rename(temp, finalPath); } catch (error) { if ((error.code === 'EEXIST' || error.code === 'ENOTEMPTY') && await exists(finalPath)) return duplicateResult(finalPath, validation, root); throw error; } return { ok: true, action: 'promoted', raw_bundle: finalPath, manifest: path.join(finalPath, 'manifest.json'), bundle_checksum: manifest.bundle_checksum, transcript_available: manifest.transcript_available, subtitle_kind: manifest.subtitle_kind, subtitle_language: manifest.subtitle_language, source_language: manifest.source_language, translation_state: manifest.translation_state, stable_track_id: manifest.selected_track?.stable_track_id || null, warnings: manifest.warnings };
  } finally { if (await exists(temp)) await fs.rm(temp, { recursive: true, force: true }); await fs.rmdir(tmpParent).catch(() => {}); }
}
async function ingestUrl(options) { let staged; try { staged = await stageVideo(options); return { ...await promoteStage(staged.stage, options.repo), capture_exercised: true }; } catch (error) { if (staged?.stage && await exists(staged.stage)) await fs.rm(staged.stage, { recursive: true, force: true }); throw error; } }
function parseArgs(argv) { const [command, ...rest] = argv; const options = {}; for (let index = 0; index < rest.length; index += 1) { const item = rest[index]; if (!item.startsWith('--')) fail(`无效参数: ${item}`); const key = item.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase()); const value = rest[++index]; if (!value || value.startsWith('--') || Object.hasOwn(options, key)) fail(`参数无效或重复: ${item}`); options[key] = value; } return { command, options }; }
function help() { return 'YouTube 视频不可变归档工具\n\n用法:\n  youtube_ingest.mjs stage --url URL [--repo PATH]\n  youtube_ingest.mjs validate --stage PATH [--repo PATH]\n  youtube_ingest.mjs promote --stage PATH [--repo PATH]\n  youtube_ingest.mjs verify --raw PATH [--repo PATH]\n  youtube_ingest.mjs ingest --url URL [--repo PATH]'; }
async function main(argv) { if (!argv.length || ['help', '-h', '--help'].includes(argv[0])) { process.stdout.write(`${help()}\n`); return; } const { command, options } = parseArgs(argv); let result; if (command === 'stage') { if (!options.url) fail('stage 需要 --url'); result = await stageVideo({ url: options.url, repo: options.repo }); } else if (command === 'validate') { if (!options.stage) fail('validate 需要 --stage'); result = await validateStage(options.stage, options.repo); } else if (command === 'promote') { if (!options.stage) fail('promote 需要 --stage'); result = await promoteStage(options.stage, options.repo); } else if (command === 'verify') { if (!options.raw) fail('verify 需要 --raw'); result = await verifyRaw(options.raw, options.repo); } else if (command === 'ingest') { if (!options.url) fail('ingest 需要 --url'); result = await ingestUrl({ url: options.url, repo: options.repo }); } else fail(`未知命令: ${command}`); process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); }
const direct = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (direct) main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`); process.exitCode = 1; });
export { MAX_METADATA_BYTES, MAX_SUBTITLE_BYTES, defaultMetadataFetcher, defaultSubtitleFetcher, ingestUrl, inventoryFromMetadata, parseVideoUrl, promoteStage, renderArticle, run, selectSubtitleTrack, stageVideo, validateStage, verifyRaw, vttCues };
