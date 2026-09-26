#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ingestUrl, parseVideoUrl, promoteStage, stageVideo, subtitleCues, validateStage, verifyRaw } from './bilibili_ingest.mjs';

const URL = 'https://www.bilibili.com/video/BV1xx411c7mD?spm_id_from=333.1007.0.0#reply';
async function repo() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bilibili-ingest-test-')); await fs.writeFile(path.join(root, 'AGENTS.md'), '# fixture\n'); await fs.mkdir(path.join(root, 'wiki')); await fs.mkdir(path.join(root, 'staging', 'bilibili'), { recursive: true }); await fs.mkdir(path.join(root, 'raw', 'bilibili'), { recursive: true }); return root; }
function view(overrides = {}) { return { code: 0, data: { bvid: 'BV1xx411c7mD', cid: 11, title: '多 P 测试视频', duration: 15, pubdate: 1_700_000_000, owner: { name: '测试 UP', mid: 42 }, pages: [{ page: 1, cid: 11, duration: 10, part: '第一部分' }, { page: 2, cid: 22, duration: 5, part: '第二部分' }], ...overrides } }; }
function response(data, options = {}) { const bytes = Buffer.from(JSON.stringify(data)); return { ok: (options.status ?? 200) < 300, status: options.status ?? 200, redirected: Boolean(options.redirected), headers: new Headers({ 'content-length': String(bytes.length) }), arrayBuffer: async () => bytes }; }
function fetchView(data = view(), options = {}) { return async () => response(data, options); }
function chunkedResponse(chunks) { let index = 0; return { ok: true, status: 200, redirected: false, headers: new Headers(), body: { getReader: () => ({ read: async () => index < chunks.length ? { done: false, value: chunks[index++] } : { done: true }, cancel: async () => {}, releaseLock: () => {} }) } }; }
async function stage(root, options = {}) { return stageVideo({ url: URL, repo: root, fetchImpl: fetchView(options.view), subtitleImpl: options.subtitleImpl || (async ({ page }) => page === 1 ? { body: [{ from: 0, to: 1.25, content: '第一句' }] } : { data: { body: [{ from: 1, to: 2, content: '第二句' }] } }) }); }

test('规范 URL 并 fail-closed 拒绝不受支持目标', () => {
  assert.deepEqual(parseVideoUrl(URL), {
    original_url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    canonical_url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    bvid: 'BV1xx411c7mD',
  });
  for (const bad of ['http://www.bilibili.com/video/BV1xx411c7mD', 'https://user@www.bilibili.com/video/BV1xx411c7mD', 'https://www.bilibili.com:444/video/BV1xx411c7mD', 'https://m.bilibili.com/video/BV1xx411c7mD', 'https://www.bilibili.com/video/av1', 'https://www.bilibili.com/video/BV1xx411c7mD/extra']) assert.throws(() => parseVideoUrl(bad), /仅接受|必须严格/);
});

test('OpenCLI 顶层数组与尾随 s 时间戳可解析，非法 cue 被拒绝', () => {
  assert.deepEqual(subtitleCues([{ from: '0.00s', to: '1.250s', content: '字幕' }]), [{ from: 0, to: 1.25, content: '字幕' }]);
  assert.deepEqual(subtitleCues([{ from: '-1s', to: '1s', content: '负值' }, { from: '2s', to: '1s', content: '倒序' }, { from: 'NaNs', to: '1s', content: '非法' }]), []);
});

test('逐 P stage/validate/promote/verify，含 CID 与时间戳', async (t) => {
  const root = await repo(); t.after(() => fs.rm(root, { recursive: true, force: true })); const captured = await stage(root, { subtitleImpl: async ({ page }) => page === 1 ? [{ from: '0.00s', to: '1.25s', content: '第一句' }] : { data: { body: [{ from: 1, to: 2, content: '第二句' }] } } }); assert.equal(captured.pages, 2); assert.equal(captured.warnings.length, 0);
  const markdown = await fs.readFile(path.join(captured.stage, 'article.md'), 'utf8'); assert.match(markdown, /P1: 第一部分/); assert.match(markdown, /CID: 22/); assert.match(markdown, /00:00.000 → 00:01.250/); assert.equal((await validateStage(captured.stage, root)).ok, true);
  const promoted = await promoteStage(captured.stage, root); assert.equal(promoted.action, 'promoted'); assert.match(promoted.bundle_checksum, /^sha256:[a-f0-9]{64}$/); assert.equal((await verifyRaw(promoted.raw_bundle, root)).ok, true);
  await fs.appendFile(path.join(promoted.raw_bundle, 'article.md'), '篡改'); await assert.rejects(() => verifyRaw(promoted.raw_bundle, root), /文件清单|内容校验/);
});

test('字幕失败/空结果仅警告，脱敏并允许 metadata-only', async (t) => {
  const root = await repo(); t.after(() => fs.rm(root, { recursive: true, force: true })); const captured = await stage(root, { subtitleImpl: async ({ page }) => page === 1 ? { token: 'do-not-save', body: [] } : Promise.reject(new Error('服务不可用')) }); assert.match(captured.warnings.join('\n'), /不据此断言无字幕|字幕未取得/); assert.doesNotMatch(await fs.readFile(path.join(captured.stage, 'responses', 'subtitles', 'p01-cid11.json'), 'utf8'), /do-not-save/); const promoted = await promoteStage(captured.stage, root); await assert.doesNotReject(() => verifyRaw(promoted.raw_bundle, root));
});

test('拒绝 bvid/CID 不一致、重定向、超限与越界/符号链接路径', async (t) => {
  const root = await repo(); t.after(() => fs.rm(root, { recursive: true, force: true })); await assert.rejects(() => stage(root, { view: view({ bvid: 'BV1ab411c7mD' }) }), /bvid/); await assert.rejects(() => stageVideo({ url: URL, repo: root, fetchImpl: fetchView(view(), { redirected: true }), subtitleImpl: async () => ({}) }), /不允许重定向/); const huge = view({ title: 'x'.repeat(6 * 1024 * 1024) }); await assert.rejects(() => stageVideo({ url: URL, repo: root, fetchImpl: fetchView(huge), subtitleImpl: async () => ({}) }), /超过/);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'bilibili-outside-')); t.after(() => fs.rm(outside, { recursive: true, force: true })); await fs.symlink(outside, path.join(root, 'staging', 'bilibili', 'bad-link')); await assert.rejects(() => validateStage(path.join(root, 'staging', 'bilibili', 'bad-link'), root), /符号链接|普通目录/); await assert.rejects(() => validateStage(outside, root), /直接子目录|超出允许目录/);
});

test('流式详情响应在 chunked body 超限时立即 fail-closed', async (t) => {
  const root = await repo(); t.after(() => fs.rm(root, { recursive: true, force: true })); const chunks = [new Uint8Array(3 * 1024 * 1024), new Uint8Array(3 * 1024 * 1024)]; await assert.rejects(() => stageVideo({ url: URL, repo: root, fetchImpl: async () => chunkedResponse(chunks), subtitleImpl: async () => ({}) }), /超过/);
});

test('真实性诚实分列，ingest duplicate 仍标明已实际采集', async (t) => {
  const root = await repo(); t.after(() => fs.rm(root, { recursive: true, force: true })); const options = { url: URL, repo: root, fetchImpl: fetchView(), subtitleImpl: async () => [] }; const first = await ingestUrl(options); const second = await ingestUrl(options); assert.equal(first.capture_exercised, true); assert.equal(second.capture_exercised, true); assert.equal(second.action, 'duplicate-noop'); const manifest = JSON.parse(await fs.readFile(first.manifest, 'utf8')); assert.equal(manifest.source_authenticity, 'mixed-detail-origin-subtitle-unverified'); assert.equal(manifest.detail_authenticity, 'bilibili-origin-api'); assert.equal(manifest.subtitle_authenticity, 'injected-subtitle-unverified'); const verified = await verifyRaw(first.raw_bundle, root); assert.equal(verified.source_authenticity, 'mixed-detail-origin-subtitle-unverified');
});

test('拒绝平台根祖先和嵌套 raw/stage 路径', async (t) => {
  const root = await repo(); t.after(() => fs.rm(root, { recursive: true, force: true })); const captured = await stage(root); const nested = path.join(root, 'staging', 'bilibili', 'nested'); await fs.mkdir(nested); await assert.rejects(() => validateStage(path.join(nested, path.basename(captured.stage)), root), /直接子目录/);
  const rawLinkRoot = await repo(); t.after(() => fs.rm(rawLinkRoot, { recursive: true, force: true })); const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'bilibili-link-parent-')); t.after(() => fs.rm(outside, { recursive: true, force: true })); await fs.rm(path.join(rawLinkRoot, 'raw'), { recursive: true }); await fs.symlink(outside, path.join(rawLinkRoot, 'raw')); await assert.rejects(() => verifyRaw(path.join(rawLinkRoot, 'raw', 'bilibili', 'anything'), rawLinkRoot), /raw\/bilibili.*普通目录/);
});

test('目录身份使用真实 dev/ino 并拒绝校验末尾的 stage 替换', async (t) => {
  const root = await repo();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const captured = await stage(root);
  assert.match(captured.stage_identity.dev, /^\d+$/);
  assert.match(captured.stage_identity.ino, /^\d+$/);
  const parked = `${captured.stage}-parked`;
  await assert.rejects(() => validateStage(captured.stage, root, {
    testHook: {
      beforeIdentityCheck: async () => {
        await fs.rename(captured.stage, parked);
        await fs.mkdir(captured.stage);
        await fs.writeFile(path.join(captured.stage, 'replacement.txt'), 'must survive\n');
      },
    },
  }), /目录替换/);
  assert.equal(await fs.readFile(path.join(captured.stage, 'replacement.txt'), 'utf8'), 'must survive\n');
  await assert.doesNotReject(() => fs.lstat(parked));
});

test('validate 阻止字幕 cue_count 或确定性 Markdown 被篡改', async (t) => {
  const root = await repo(); t.after(() => fs.rm(root, { recursive: true, force: true })); const captured = await stage(root); await fs.appendFile(path.join(captured.stage, 'article.md'), '非确定性内容'); await assert.rejects(() => validateStage(captured.stage, root), /确定性渲染/);
  const again = await stage(root); const capturePath = path.join(again.stage, 'capture.json'); const capture = JSON.parse(await fs.readFile(capturePath, 'utf8')); capture.subtitles[0].cue_count = 99; await fs.writeFile(capturePath, `${JSON.stringify(capture)}\n`); await assert.rejects(() => validateStage(again.stage, root), /cue_count/);
});

test('并发相同发布为 duplicate-noop，原始包额外文件被拒绝', async (t) => {
  const root = await repo(); t.after(() => fs.rm(root, { recursive: true, force: true })); const [left, right] = await Promise.all([stage(root), stage(root)]); const results = await Promise.all([promoteStage(left.stage, root), promoteStage(right.stage, root)]); assert.deepEqual(results.map((item) => item.action).sort(), ['duplicate-noop', 'promoted']); assert.equal(results[0].raw_bundle, results[1].raw_bundle); await fs.writeFile(path.join(results[0].raw_bundle, 'extra'), 'bad'); await assert.rejects(() => verifyRaw(results[0].raw_bundle, root), /文件清单/);
});
