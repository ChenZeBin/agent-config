#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ingestUrl, parseChannelsUrl, promoteStage, stageVideo, validateStage, verifyRaw } from './wechat_channels_ingest.mjs';

const SHORT_URI = 'AyN0KgKSs2';
const URL = `https://weixin.qq.com/sph/${SHORT_URI}`;
const PREVIEW = `https://channels.weixin.qq.com/finder-preview/pages/sph?id=${SHORT_URI}`;
const API = 'https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info';
const COVER = 'https://finder.video.qq.com/251/20304/stodownload?token=fixture';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0xff, 0xd9]);

async function makeRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-channels-ingest-test-'));
  await fs.writeFile(path.join(root, 'AGENTS.md'), '# fixture\n');
  await fs.mkdir(path.join(root, 'wiki'));
  await fs.mkdir(path.join(root, 'staging', 'wechat-channels'), { recursive: true });
  await fs.mkdir(path.join(root, 'raw', 'wechat-channels'), { recursive: true });
  return root;
}

function apiFixture(overrides = {}) {
  return {
    data: {
      feedInfo: {
        picInfo: [],
        description: 'Cloudflare 正式发布 Kitesurf，AI 智能体专用浏览器。',
        coverUrl: COVER,
        likeCountFmt: '100',
        favCountFmt: '338',
        commentCountFmt: '27',
        forwardCountFmt: '1184',
        createtime: 1786180885,
        ...overrides.feedInfo,
      },
      authorInfo: { nickname: 'Game.AI', ...overrides.authorInfo },
      errMsg: { type: 0, ...overrides.errMsg },
      sceneInfo: { dynamicExportId: 'export/temporary-fixture', expiredTime: 1788589657 },
      ...overrides.data,
    },
    errCode: 0,
    errMsg: '',
    ...overrides.root,
  };
}

function fetchFixture({ api = apiFixture(), location = PREVIEW, cover = JPEG, preview = '<html><head><title>视频号</title></head><body>finder-preview</body></html>', apiStatus = 201, coverType = 'image/jpg' } = {}) {
  return async function mockFetch(input, init = {}) {
    const requestUrl = String(input);
    if (requestUrl === URL) return new Response(null, { status: 301, headers: { location } });
    if (requestUrl === PREVIEW) return new Response(preview, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (requestUrl === API) {
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(String(init.body)), { baseReq: { generalToken: '' }, shortUri: SHORT_URI });
      return new Response(JSON.stringify(api), { status: apiStatus, headers: { 'content-type': 'application/json' } });
    }
    if (requestUrl === COVER) return new Response(cover, { status: 200, headers: { 'content-type': coverType } });
    return new Response('not found', { status: 404 });
  };
}

test('规范短链与官方预览 URL，拒绝凭据、端口、额外路径和参数', () => {
  assert.deepEqual(parseChannelsUrl(URL), {
    submitted_url: URL,
    canonical_url: URL,
    preview_url: PREVIEW,
    short_uri: SHORT_URI,
  });
  assert.deepEqual(parseChannelsUrl(PREVIEW), {
    submitted_url: PREVIEW,
    canonical_url: URL,
    preview_url: PREVIEW,
    short_uri: SHORT_URI,
  });
  for (const bad of [
    `http://weixin.qq.com/sph/${SHORT_URI}`,
    `https://user@weixin.qq.com/sph/${SHORT_URI}`,
    `https://weixin.qq.com:444/sph/${SHORT_URI}`,
    `https://weixin.qq.com/sph/${SHORT_URI}?x=1`,
    `https://weixin.qq.com/sph/${SHORT_URI}/extra`,
    'https://weixin.qq.com/sph/a',
    `https://channels.weixin.qq.com/finder-preview/pages/sph?id=${SHORT_URI}&x=1`,
    'https://example.com/sph/AyN0KgKSs2',
  ]) assert.throws(() => parseChannelsUrl(bad));
});

test('stage/validate/promote/verify 固化第一方 metadata-only 包并检测篡改', async (t) => {
  const root = await makeRepo();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const staged = await stageVideo({ repo: root, url: URL, fetchImpl: fetchFixture() });
  assert.equal(staged.capture_exercised, true);
  assert.equal(staged.transcript_available, false);
  assert.deepEqual(staged.warnings, ['media-not-exposed', 'transcript-unavailable']);
  const checked = await validateStage(staged.stage, root);
  assert.equal(checked.metadata_authenticity, 'wechat-channels-origin-api');
  const promoted = await promoteStage(staged.stage, root);
  assert.equal(promoted.action, 'promoted');
  const verified = await verifyRaw(promoted.raw_bundle, root);
  assert.equal(verified.source.canonical_url, URL);
  assert.equal(verified.normalized.author, 'Game.AI');
  const article = await fs.readFile(path.join(promoted.raw_bundle, 'article.md'), 'utf8');
  assert.match(article, /Content coverage: metadata-only/);
  assert.match(article, /不得.*视频完整内容/);
  await fs.appendFile(path.join(promoted.raw_bundle, 'article.md'), '篡改');
  await assert.rejects(() => verifyRaw(promoted.raw_bundle, root), /checksum|确定性|文件清单/);
});

test('相同 canonical URL 与稳定内容返回 duplicate-noop，不因互动数和动态 token 变化重复固化', async (t) => {
  const root = await makeRepo();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await ingestUrl({ repo: root, url: URL, fetchImpl: fetchFixture() });
  const changed = apiFixture({ feedInfo: { likeCountFmt: '101' }, data: { sceneInfo: { dynamicExportId: 'export/new-token', expiredTime: 1788599999 } } });
  const second = await ingestUrl({ repo: root, url: URL, fetchImpl: fetchFixture({ api: changed }) });
  assert.equal(first.action, 'promoted');
  assert.equal(second.action, 'duplicate-noop');
  assert.equal(second.raw_bundle, first.raw_bundle);
});

test('重定向错绑、API 错误/空字段和不可播放状态 fail-closed', async (t) => {
  const root = await makeRepo();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(() => stageVideo({ repo: root, url: URL, fetchImpl: fetchFixture({ location: 'https://channels.weixin.qq.com/finder-preview/pages/sph?id=WrongId1' }) }), /Location.*不一致/);
  await assert.rejects(() => stageVideo({ repo: root, url: URL, fetchImpl: fetchFixture({ api: apiFixture({ root: { errCode: 1 } }) }) }), /API 返回错误/);
  await assert.rejects(() => stageVideo({ repo: root, url: URL, fetchImpl: fetchFixture({ api: apiFixture({ feedInfo: { description: '' } }) }) }), /缺少作者或描述/);
  await assert.rejects(() => stageVideo({ repo: root, url: URL, fetchImpl: fetchFixture({ api: apiFixture({ errMsg: { type: 2 } }) }) }), /公开预览不可用/);
  await assert.rejects(() => stageVideo({ repo: root, url: URL, fetchImpl: fetchFixture({ api: apiFixture({ feedInfo: { videoUrl: 'https://finder.video.qq.com/media.mp4' } }) }) }), /媒体 URL/);
  await assert.rejects(() => stageVideo({ repo: root, url: URL, fetchImpl: fetchFixture({ api: apiFixture({ feedInfo: { picInfo: [{ url: 'https://finder.video.qq.com/image.jpg' }] } }) }) }), /多图内容/);
});

test('封面 host、Content-Type、magic bytes 和响应大小必须受限', async (t) => {
  const root = await makeRepo();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(() => stageVideo({ repo: root, url: URL, fetchImpl: fetchFixture({ api: apiFixture({ feedInfo: { coverUrl: 'https://evil.example/cover.jpg' } }) }) }), /允许的腾讯 HTTPS 域/);
  await assert.rejects(() => stageVideo({ repo: root, url: URL, fetchImpl: fetchFixture({ coverType: 'text/html' }) }), /类型不支持/);
  await assert.rejects(() => stageVideo({ repo: root, url: URL, fetchImpl: fetchFixture({ cover: Buffer.from('not-an-image') }) }), /magic bytes/);
  const hugeHeader = async (input) => {
    if (String(input) === URL) return new Response(null, { status: 301, headers: { location: PREVIEW } });
    if (String(input) === PREVIEW) return new Response('tiny', { status: 200, headers: { 'content-type': 'text/html', 'content-length': String(2 * 1024 * 1024) } });
    return new Response('not found', { status: 404 });
  };
  await assert.rejects(() => stageVideo({ repo: root, url: URL, fetchImpl: hugeHeader }), /字节上限/);
});

test('额外文件、symlink、越界 stage 和确定性 article 篡改 fail-closed', async (t) => {
  const root = await makeRepo();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const staged = await stageVideo({ repo: root, url: URL, fetchImpl: fetchFixture() });
  await fs.writeFile(path.join(staged.stage, 'extra.txt'), 'bad');
  await assert.rejects(() => validateStage(staged.stage, root), /未声明文件/);
  const second = await stageVideo({ repo: root, url: URL, fetchImpl: fetchFixture() });
  const capturePath = path.join(second.stage, 'capture.json');
  const capture = JSON.parse(await fs.readFile(capturePath, 'utf8'));
  capture.normalized.author = '篡改';
  await fs.writeFile(capturePath, JSON.stringify(capture));
  await assert.rejects(() => validateStage(second.stage, root), /checksum|不一致/);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-channels-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(root, 'staging', 'wechat-channels', 'bad-link'));
  await assert.rejects(() => validateStage(path.join(root, 'staging', 'wechat-channels', 'bad-link'), root), /普通目录|符号链接/);
  await assert.rejects(() => validateStage(outside, root), /直接子目录|超出/);
});
