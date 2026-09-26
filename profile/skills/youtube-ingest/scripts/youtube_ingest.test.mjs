#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ingestUrl, inventoryFromMetadata, parseVideoUrl, promoteStage, run, selectSubtitleTrack, stageVideo, validateStage, verifyRaw } from './youtube_ingest.mjs';

const ID = 'dQw4w9WgXcQ';
const URL = `https://www.youtube.com/watch?v=${ID}`;
const VTT = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.250\n第一句\n\n00:00:01.500 --> 00:00:02.000\n第二句\n';
async function repo() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-ingest-test-')); await fs.writeFile(path.join(root, 'AGENTS.md'), '# fixture\n'); await fs.mkdir(path.join(root, 'wiki')); await fs.mkdir(path.join(root, 'staging', 'youtube'), { recursive: true }); await fs.mkdir(path.join(root, 'raw', 'youtube'), { recursive: true }); return root; }
function metadata(overrides = {}) { return { id: ID, extractor: 'youtube', extractor_key: 'Youtube', webpage_url: URL, availability: 'public', title: '测试 YouTube 视频', uploader: '测试作者', channel: '测试频道', channel_id: 'channel-1', upload_date: '20260101', timestamp: 1_767_225_600, duration: 20, description: 'fixture', original_language: 'en', live_status: 'not_live', subtitles: { en: [{ ext: 'vtt', url: 'https://secret.example/?token=nope' }], 'zh-Hans': [{ ext: 'vtt' }] }, automatic_captions: { zh: [{ ext: 'vtt' }], ja: [{ ext: 'vtt' }] }, ...overrides }; }
async function stage(root, options = {}) { return stageVideo({ url: URL, repo: root, metadataImpl: async () => ({ metadata: metadata(options.metadata), yt_dlp_version: 'fixture' }), subtitleImpl: options.subtitleImpl || (async () => ({ content: VTT })) }); }

test('规范三种 URL，严格拒绝 playlist、live/embed、host、端口和重复/非法 v', () => {
  for (const value of [URL, `https://youtu.be/${ID}`, `https://www.youtube.com/shorts/${ID}`, `${URL}&list=PLfixture&index=2`, `https://youtu.be/${ID}?si=fixture`, `https://www.youtube.com/shorts/${ID}?feature=share`]) assert.deepEqual(parseVideoUrl(value), { original_url: URL, canonical_url: URL, video_id: ID });
  for (const bad of [`http://www.youtube.com/watch?v=${ID}`, `https://user@www.youtube.com/watch?v=${ID}`, `https://www.youtube.com:444/watch?v=${ID}`, `https://m.youtube.com/watch?v=${ID}`, `https://www.youtube.com/watch?list=abc`, `https://www.youtube.com/watch?v=${ID}&evil=1`, `https://www.youtube.com/watch?v=${ID}&v=${ID}`, `https://www.youtube.com/embed/${ID}`, `https://www.youtube.com/live/${ID}`, `https://youtu.be/${ID}/extra`, 'https://www.youtube.com/watch?v=short']) assert.throws(() => parseVideoUrl(bad));
});

test('人工轨优先自动轨，语言选择对输入顺序稳定，inventory 不保存 URL/token', () => {
  const first = inventoryFromMetadata(metadata()); const reversed = inventoryFromMetadata({ ...metadata(), subtitles: { en: [{ ext: 'vtt' }], 'zh-Hans': [{ ext: 'vtt' }] }, automatic_captions: { ja: [{ ext: 'vtt' }], zh: [{ ext: 'vtt' }] } });
  assert.equal(selectSubtitleTrack(first, 'en').stable_track_id, 'manual:zh-Hans'); assert.equal(selectSubtitleTrack(reversed, 'en').stable_track_id, 'manual:zh-Hans'); assert.doesNotMatch(JSON.stringify(first), /secret|token|url/i);
  assert.equal(selectSubtitleTrack(inventoryFromMetadata({ automatic_captions: { en: [{ ext: 'vtt' }], zh: [{ ext: 'vtt' }] } }), 'en').stable_track_id, 'automatic:en');
  assert.equal(selectSubtitleTrack(inventoryFromMetadata({ automatic_captions: { zh: [{ ext: 'vtt' }] } }), 'en'), null);
  assert.equal(selectSubtitleTrack(inventoryFromMetadata({ automatic_captions: { en: [{ ext: 'vtt' }] } }), null), null);
});

test('stage/validate/promote/verify：有效字幕返回 transcript 标记并检测篡改', async (t) => {
  const root = await repo(); t.after(() => fs.rm(root, { recursive: true, force: true })); const captured = await stage(root); assert.equal(captured.transcript_available, true); assert.equal(captured.subtitle_kind, 'manual'); assert.equal(captured.subtitle_language, 'zh-Hans'); const checked = await validateStage(captured.stage, root); assert.equal(checked.ok, true); const promoted = await promoteStage(captured.stage, root); const verified = await verifyRaw(promoted.raw_bundle, root); assert.equal(verified.transcript_available, true); assert.equal(verified.stable_track_id, 'manual:zh-Hans'); assert.equal(verified.source_authenticity, 'stage-declared-youtube-tool-mediated-needs-review'); assert.equal(verified.metadata_authenticity, 'stage-declared-youtube-metadata-needs-review'); const manifest = JSON.parse(await fs.readFile(path.join(promoted.raw_bundle, 'manifest.json'), 'utf8')); assert.equal(manifest.capture.provenance_attestation, 'stage-declared-only'); assert.equal('yt_dlp_version' in manifest, false); assert.equal('metadata_backend' in manifest.capture, false); await fs.appendFile(path.join(promoted.raw_bundle, 'article.md'), '篡改'); await assert.rejects(() => verifyRaw(promoted.raw_bundle, root), /文件清单|确定性/);
});

test('metadata-only 明确为不可用而非无字幕，duplicate 为 noop', async (t) => {
  const root = await repo(); t.after(() => fs.rm(root, { recursive: true, force: true })); const noTracks = { subtitles: {}, automatic_captions: {} }; const first = await ingestUrl({ url: URL, repo: root, metadataImpl: async () => ({ metadata: metadata(noTracks), yt_dlp_version: 'fixture' }), subtitleImpl: async () => null }); const second = await ingestUrl({ url: URL, repo: root, metadataImpl: async () => ({ metadata: metadata(noTracks), yt_dlp_version: 'fixture' }), subtitleImpl: async () => null }); assert.equal(first.transcript_available, false); assert.equal(second.action, 'duplicate-noop'); const verified = await verifyRaw(first.raw_bundle, root); assert.equal(verified.subtitle_kind, 'none'); assert.equal(verified.subtitle_language, null); assert.deepEqual(verified.warnings, ['caption-track-unavailable']);
});

test('活动/预约直播、私密和受限 metadata 必须 fail-closed', async (t) => {
  const root = await repo(); t.after(() => fs.rm(root, { recursive: true, force: true })); for (const item of [{ live_status: 'is_live' }, { is_live: true }, { live_status: 'is_upcoming' }, { availability: 'private' }, { availability: 'needs_auth' }, { availability: 'premium_only' }, { availability: 'subscriber_only' }, { availability: 'unknown' }, { availability: undefined }, { age_limit: 18 }, { id: 'aaaaaaaaaaa' }, { webpage_url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' }, { entries: [] }, { extractor_key: 'Generic' }]) await assert.rejects(() => stage(root, { metadata: item }), /仅允许|年龄|video ID|唯一 YouTube/); await assert.doesNotReject(() => stage(root, { metadata: { availability: 'unlisted', live_status: 'post_live', was_live: true } }));
});

test('字幕后端错误中的 URL、Bearer、Cookie 与 token 不会写入 capture', async (t) => {
  const root = await repo(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const captured = await stageVideo({ url: URL, repo: root, metadataImpl: async () => ({ metadata: metadata(), yt_dlp_version: 'fixture' }), subtitleImpl: async () => { throw new Error('fetch https://example.test/caption?token=SECRET Bearer TOPSECRET Cookie=session=COOKIESECRET token=SECRET'); } });
  const capture = await fs.readFile(path.join(captured.stage, 'capture.json'), 'utf8');
  assert.doesNotMatch(capture, /example\.test|SECRET|Bearer|Cookie/i);
  assert.match(capture, /caption-fetch-failed/);
});

test('mutable stage 不能注入 backend、工具版本或更高 provenance', async (t) => {
  const root = await repo(); t.after(() => fs.rm(root, { recursive: true, force: true })); const captured = await stage(root); const capturePath = path.join(captured.stage, 'capture.json'); const capture = JSON.parse(await fs.readFile(capturePath, 'utf8')); capture.yt_dlp_version = 'forged-version'; capture.capture.metadata_backend = 'yt-dlp'; capture.source_authenticity = 'youtube-origin-via-yt-dlp'; await fs.writeFile(capturePath, `${JSON.stringify(capture, null, 2)}\n`); await assert.rejects(() => validateStage(captured.stage, root), /schema|provenance|字幕状态/);
});

test('已知视频时长之外的字幕 cue 必须 fail-closed', async (t) => {
  const root = await repo(); t.after(() => fs.rm(root, { recursive: true, force: true })); const beyond = 'WEBVTT\n\n00:00:29.000 --> 00:00:30.000\n越界\n'; await assert.rejects(() => stage(root, { subtitleImpl: async () => ({ content: beyond }) }), /超出视频时长容差/);
});

test('子进程忽略 SIGTERM 时在 grace 后 SIGKILL，Promise 只结算一次', async () => {
  const started = Date.now(); await assert.rejects(() => run(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { timeoutMs: 100, graceMs: 25 }), /超过 100ms 超时/); assert.ok(Date.now() - started < 1500);
});

test('超限、越界/symlink、stage 额外文件和选轨/Markdown 篡改 fail-closed', async (t) => {
  const root = await repo(); t.after(() => fs.rm(root, { recursive: true, force: true })); await assert.rejects(() => stage(root, { metadata: { title: 'x'.repeat(2 * 1024 * 1024) } }), /过大|超过/); const captured = await stage(root); await fs.writeFile(path.join(captured.stage, 'extra'), 'bad'); await assert.rejects(() => validateStage(captured.stage, root), /未声明/); const another = await stage(root); await fs.appendFile(path.join(another.stage, 'article.md'), 'bad'); await assert.rejects(() => validateStage(another.stage, root), /确定性/); const warningTamper = await stage(root); const capturePath = path.join(warningTamper.stage, 'capture.json'); const capture = JSON.parse(await fs.readFile(capturePath, 'utf8')); capture.warnings = ['Bearer SECRET']; await fs.writeFile(capturePath, JSON.stringify(capture)); await assert.rejects(() => validateStage(warningTamper.stage, root), /warning/); const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-outside-')); t.after(() => fs.rm(outside, { recursive: true, force: true })); await fs.symlink(outside, path.join(root, 'staging', 'youtube', 'bad-link')); await assert.rejects(() => validateStage(path.join(root, 'staging', 'youtube', 'bad-link'), root), /普通目录|符号链接/); await assert.rejects(() => validateStage(outside, root), /直接子目录|超出/);
});
