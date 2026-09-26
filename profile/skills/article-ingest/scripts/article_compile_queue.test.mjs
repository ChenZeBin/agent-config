import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { stageInput, promoteStage as promoteWechat } from '../../wechat-ingest/scripts/wechat_ingest.mjs';
import { ingestUrl as ingestX } from '../../x-ingest/scripts/x_ingest.mjs';
import { stageVideo, promoteStage as promoteBilibili } from '../../bilibili-ingest/scripts/bilibili_ingest.mjs';
import { stageVideo as stageYoutubeVideo, promoteStage as promoteYoutube } from '../../youtube-ingest/scripts/youtube_ingest.mjs';
import { stageVideo as stageWechatChannelsVideo, promoteStage as promoteWechatChannels } from '../../wechat-channels-ingest/scripts/wechat_channels_ingest.mjs';
import { claimNextBundle, releaseCompileLock, scanCompileQueue } from './article_compile_queue.mjs';

async function makeRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'article-compile-test-'));
  await fs.writeFile(path.join(root, 'AGENTS.md'), '# fixture\n');
  await fs.mkdir(path.join(root, 'wiki', 'sources'), { recursive: true });
  await fs.writeFile(path.join(root, 'wiki', '索引.md'), '# Wiki Index\n\n## Sources\n');
  await fs.writeFile(path.join(root, 'wiki', '日志.md'), '# Wiki Log\n');
  await fs.mkdir(path.join(root, '.agents', 'skills', 'wiki-knowledge-loop', 'references'), { recursive: true });
  await fs.writeFile(path.join(root, '.agents', 'skills', 'wiki-knowledge-loop', 'references', 'quality-rubric.md'), '# Fixture quality rubric\n');
  await fs.mkdir(path.join(root, 'staging', 'wechat'), { recursive: true });
  await fs.mkdir(path.join(root, 'staging', 'bilibili'), { recursive: true });
  await fs.mkdir(path.join(root, 'staging', 'wechat-channels'), { recursive: true });
  return root;
}

async function addWechat(repo, suffix = '1') {
  const input = path.join(repo, 'wechat-' + suffix + '.md');
  await fs.writeFile(input, '# WeChat fixture ' + suffix + '\n\nBody.\n');
  const stage = await stageInput({
    repo,
    url: 'https://mp.weixin.qq.com/s?__biz=fixture&mid=' + suffix,
    input,
    publishedAt: '2026-08-23',
  });
  return promoteWechat(stage.stage, repo);
}

function xFetch(statusId) {
  return async function mockFetch(url) {
    if (String(url).startsWith('https://cdn.syndication.twimg.com/')) {
      return new Response(JSON.stringify({
        id_str: statusId,
        text: 'X fixture body',
        created_at: '2026-08-23T00:00:00.000Z',
        user: { screen_name: 'fixture', name: 'Fixture' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  };
}

async function addX(repo, statusId = '1234567890123456789') {
  return ingestX({
    repo,
    url: 'https://x.com/fixture/status/' + statusId,
    fetchImpl: xFetch(statusId),
  });
}

async function addBilibili(repo, bvid = 'BV1xx411c7mD') {
  const staged = await stageVideo({
    repo,
    url: `https://www.bilibili.com/video/${bvid}?share_source=fixture`,
    fetchImpl: async () => new Response(JSON.stringify({
      code: 0,
      data: {
        bvid,
        cid: 101,
        title: 'Bilibili fixture',
        owner: { name: 'Fixture UP', mid: 42 },
        pubdate: 1788000000,
        duration: 12,
        pages: [{ page: 1, cid: 101, duration: 12, part: 'Fixture P1' }],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    subtitleImpl: async () => [{ index: 1, from: '0.00s', to: '1.25s', content: '字幕 fixture' }],
  });
  return promoteBilibili(staged.stage, repo);
}

async function addYoutube(repo, { videoId = 'dQw4w9WgXcQ', transcript = true } = {}) {
  const canonical = `https://www.youtube.com/watch?v=${videoId}`;
  const staged = await stageYoutubeVideo({
    repo,
    url: `${canonical}&list=PLfixture&index=1`,
    metadataImpl: async () => ({
      yt_dlp_version: 'fixture',
      metadata: {
        id: videoId,
        extractor: 'youtube',
        extractor_key: 'Youtube',
        webpage_url: canonical,
        availability: 'public',
        title: 'YouTube fixture',
        uploader: 'Fixture creator',
        channel: 'Fixture channel',
        channel_id: 'UCfixture',
        upload_date: '20260830',
        duration: 12,
        original_language: 'en',
        live_status: 'not_live',
        subtitles: transcript ? { en: [{ ext: 'vtt', format_id: 'fixture' }] } : {},
        automatic_captions: {},
      },
    }),
    subtitleImpl: transcript ? async () => ({ content: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.250\nYouTube fixture caption\n' }) : async () => null,
  });
  return promoteYoutube(staged.stage, repo);
}

async function addWechatChannels(repo, shortUri = 'AyN0KgKSs2') {
  const canonical = `https://weixin.qq.com/sph/${shortUri}`;
  const preview = `https://channels.weixin.qq.com/finder-preview/pages/sph?id=${shortUri}`;
  const cover = 'https://finder.video.qq.com/fixture/stodownload?token=temporary';
  const api = {
    data: {
      feedInfo: {
        description: '微信视频号 compile queue fixture',
        coverUrl: cover,
        createtime: 1786180885,
        picInfo: [],
        likeCountFmt: '1',
      },
      authorInfo: { nickname: 'Fixture Channel' },
      errMsg: { type: 0 },
      sceneInfo: { dynamicExportId: 'export/temporary', expiredTime: 1788590000 },
    },
    errCode: 0,
    errMsg: '',
  };
  const fetchImpl = async (input) => {
    const requestUrl = String(input);
    if (requestUrl === canonical) return new Response(null, { status: 301, headers: { location: preview } });
    if (requestUrl === preview) return new Response('<html><title>视频号</title><body>finder-preview</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    if (requestUrl.endsWith('/finder-preview/api/feed/get_feed_info')) return new Response(JSON.stringify(api), { status: 201, headers: { 'content-type': 'application/json' } });
    if (requestUrl === cover) return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    return new Response('not found', { status: 404 });
  };
  const staged = await stageWechatChannelsVideo({ repo, url: canonical, fetchImpl });
  return promoteWechatChannels(staged.stage, repo);
}

async function sha256(target) {
  return 'sha256:' + createHash('sha256').update(await fs.readFile(target)).digest('hex');
}

async function writeQualityReceipt(repo, bundle, page, options = {}) {
  const platform = bundle.platform || path.relative(path.join(repo, 'raw'), bundle.raw_bundle).split(path.sep)[0];
  const scores = {
    source_coverage: 2,
    claim_support: 2,
    uncertainty: 2,
    knowledge_integration: 2,
    reusability: 2,
    information_discipline: 2,
    ...options.scores,
  };
  const sourcePage = path.relative(repo, page).split(path.sep).join('/');
  const sourcePageSha256 = await sha256(page);
  const evidence = {
    version: 1,
    raw: [{
      path: path.relative(repo, path.join(bundle.raw_bundle, 'article.md')).split(path.sep).join('/'),
      locator: { kind: 'lines', start: 1, end: 1 },
    }],
    wiki: [{ path: sourcePage, locator: { kind: 'lines', start: 1, end: 1 } }],
  };
  const receipt = {
    platform,
    bundle_checksum: bundle.bundle_checksum,
    source_page: sourcePage,
    source_page_sha256: sourcePageSha256,
    rubric_sha256: await sha256(path.join(repo, '.agents', 'skills', 'wiki-knowledge-loop', 'references', 'quality-rubric.md')),
    status: options.status || 'pass',
    total_score: options.total_score ?? Object.values(scores).reduce((total, score) => total + score, 0),
    scores: Object.entries(scores).map(([dimension, score]) => ({ dimension, score, evidence })),
    reviewer: options.reviewer || 'quality-reviewer',
    compiler: options.compiler || 'wiki-compiler',
    compiler_model: 'gpt-5.6-sol',
    compiler_reasoning: 'max',
    hard_gates: [
      'raw_integrity',
      'provenance_consistency',
      'valid_evidence_anchors',
      'no_unsupported_material_claims',
      'wiki_bookkeeping_sync',
      'positive_knowledge_value',
      'coverage_map_complete',
      'integration_decision',
    ].map((name) => ({ name, passed: true, evidence })),
    coverage_map: [{ source_scope: 'fixture scope', wiki_location: sourcePage, omission_reason: null }],
    integration_decision: { updated_pages: [], no_update_rationale: 'Fixture has no reusable canonical integration target.' },
    wiki_pages: [{ path: sourcePage, sha256: sourcePageSha256 }],
    unsupported_claims: [],
    ...options.receipt,
  };
  const directory = path.join(repo, 'quality-reviews');
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, options.filename || `${path.basename(page, '.md')}.json`);
  await fs.writeFile(target, JSON.stringify(receipt, null, 2) + '\n');
  return { target, receipt };
}

async function writeSharedPageReceipt(repo, bundle, page, sharedPage, filename) {
  const sourcePage = path.relative(repo, page).split(path.sep).join('/');
  const sharedPagePath = path.relative(repo, sharedPage).split(path.sep).join('/');
  const evidence = {
    version: 1,
    raw: [{
      path: path.relative(repo, path.join(bundle.raw_bundle, 'article.md')).split(path.sep).join('/'),
      locator: { kind: 'lines', start: 1, end: 1 },
    }],
    wiki: [{ path: sharedPagePath, locator: { kind: 'lines', start: 1, end: 1 } }],
  };
  const hardGateNames = [
    'raw_integrity',
    'provenance_consistency',
    'valid_evidence_anchors',
    'no_unsupported_material_claims',
    'wiki_bookkeeping_sync',
    'positive_knowledge_value',
    'coverage_map_complete',
    'integration_decision',
  ];
  const dimensions = [
    'source_coverage',
    'claim_support',
    'uncertainty',
    'knowledge_integration',
    'reusability',
    'information_discipline',
  ];
  return writeQualityReceipt(repo, bundle, page, {
    filename,
    receipt: {
      integration_decision: { updated_pages: [sharedPagePath], no_update_rationale: null },
      wiki_pages: [
        { path: sourcePage, sha256: await sha256(page) },
        { path: sharedPagePath, sha256: await sha256(sharedPage) },
      ],
      hard_gates: hardGateNames.map((name) => ({ name, passed: true, evidence })),
      scores: dimensions.map((dimension) => ({ dimension, score: 2, evidence })),
    },
  });
}

async function markCompiled(repo, bundle, options = {}) {
  const name = options.name || path.basename(bundle.raw_bundle).replace(/[^A-Za-z0-9]+/g, '-');
  const page = path.join(repo, 'wiki', 'sources', name + '.md');
  const article = path.join(bundle.raw_bundle, 'article.md');
  const manifest = path.join(bundle.raw_bundle, 'manifest.json');
  const relArticle = path.relative(path.dirname(page), article).split(path.sep).join('/');
  const relManifest = path.relative(path.dirname(page), manifest).split(path.sep).join('/');
  const status = options.status || 'active';
  await fs.writeFile(page,
    '---\n'
    + 'title: Fixture ' + name + '\n'
    + 'type: source\n'
    + 'status: ' + status + '\n'
    + 'created: 2026-08-23\n'
    + 'updated: 2026-08-23\n'
    + 'sources:\n'
    + '  - ' + relArticle + '\n'
    + 'tags: []\n'
    + 'provenance:\n'
    + '  raw_manifest: ' + relManifest + '\n'
    + '  raw_checksum: ' + bundle.bundle_checksum + '\n'
    + '---\n\n'
    + '# Fixture\n\n'
    + (options.body ?? ('本页完整覆盖原始来源的主要范围、采用条件和真实性限制，并说明何时可以安全复用这些信息。\n\n'
      + '本页同时记录失败边界、尚未解决的证据缺口和完成验收条件，避免把结构一致误认为内容质量通过。\n\n'
      + `每项实质主张均可回查[原始来源](${relArticle})，后续修改必须重新经过独立审核并更新绑定哈希。`)) + '\n');
  if (options.index !== false) {
    await fs.appendFile(path.join(repo, 'wiki', '索引.md'),
      '- [Fixture ' + name + '](sources/' + path.basename(page) + ') — Fixture. Updated 2026-08-23; 1 source.\n');
  }
  const tick = String.fromCharCode(96);
  const relLogManifest = path.relative(repo, manifest).split(path.sep).join('/');
  await fs.appendFile(path.join(repo, 'wiki', '日志.md'),
    '\n## [2026-08-23] ingest | Fixture ' + name + '\n\n'
    + '- Raw: ' + tick + relLogManifest + tick + ' (' + tick + bundle.bundle_checksum + tick + ')\n'
    + '- Wiki: created ' + tick + path.relative(repo, page).split(path.sep).join('/') + tick + '\n'
    + '- Notes: fixture\n');
  if (options.receipt !== false) await writeQualityReceipt(repo, bundle, page, options.receiptOptions);
  return page;
}

test('scan discovers WeChat, WeChat Channels, X, Bilibili and YouTube bundles with explicit trust state', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await addWechat(repo);
  await addX(repo);
  await addBilibili(repo);
  await addYoutube(repo);
  await addWechatChannels(repo);
  const scan = await scanCompileQueue(repo);
  assert.equal(scan.integrity_failures.length, 0);
  assert.equal(scan.pending.length, 4);
  assert.equal(scan.archive_only.length, 1);
  assert.equal(scan.bundles.find((item) => item.platform === 'wechat').trust_state, 'needs-review');
  assert.equal(scan.bundles.find((item) => item.platform === 'x').trust_state, 'verified');
  assert.equal(scan.bundles.find((item) => item.platform === 'bilibili').trust_state, 'needs-review');
  const youtube = scan.bundles.find((item) => item.platform === 'youtube');
  assert.equal(youtube.trust_state, 'needs-review');
  assert.equal(youtube.transcript_available, true);
  assert.equal(youtube.subtitle_kind, 'manual');
  assert.equal(youtube.subtitle_language, 'en');
  assert.equal(youtube.stable_track_id, 'manual:en');
  assert.equal(youtube.source_language, 'en');
  assert.equal(youtube.translation_state, 'unknown');
  const channels = scan.bundles.find((item) => item.platform === 'wechat-channels');
  assert.equal(channels.state, 'archive-only');
  assert.equal(channels.trust_state, 'verified');
  assert.equal(channels.metadata_authenticity, 'wechat-channels-origin-api');
  assert.equal(channels.content_authenticity, 'metadata-only');
  assert.equal(channels.transcript_available, false);
  assert.match(channels.reasons.join(','), /media-and-transcript-unavailable/);
});

test('source and log without the unique index entry remain needs-review', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const bundle = await addWechat(repo);
  const page = await markCompiled(repo, bundle, { index: false, status: 'needs-review' });
  let scan = await scanCompileQueue(repo);
  assert.equal(scan.needs_review.length, 1);
  assert.match(scan.needs_review[0].reasons.join(','), /index-entry-count:0/);
  await fs.appendFile(path.join(repo, 'wiki', '索引.md'),
    '- [Fixture](' + path.relative(path.join(repo, 'wiki'), page).split(path.sep).join('/') + ') — Fixture. Updated 2026-08-23; 1 source.\n');
  scan = await scanCompileQueue(repo);
  assert.equal(scan.consistent.length, 1);
  assert.equal(scan.consistent[0].source_status, 'needs-review');
  assert.equal(scan.consistent[0].trust_state, 'needs-review');
  assert.equal(scan.consistent[0].bookkeeping_state, 'consistent');
  assert.equal(scan.consistent[0].semantic_quality, 'pass');
});

test('claim is global across platforms and selects at most one bundle', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await addWechat(repo);
  await addX(repo);
  await addBilibili(repo);
  await addYoutube(repo);
  const first = await claimNextBundle(repo);
  const second = await claimNextBundle(repo);
  assert.equal(first.action, 'claimed');
  assert.equal(first.pending_count, 4);
  assert.ok(['wechat', 'x', 'bilibili', 'youtube'].includes(first.candidate.platform));
  assert.equal(second.action, 'locked');
  assert.equal(second.lock.claim_id, first.lock.claim_id);
});

test('release refuses a claimed bundle until index, source and log are consistent', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const bundle = await addX(repo);
  const claim = await claimNextBundle(repo);
  await assert.rejects(
    () => releaseCompileLock(repo, claim.lock.claim_id),
    /尚未达到 consistent/,
  );
  await markCompiled(repo, bundle);
  const released = await releaseCompileLock(repo, claim.lock.claim_id);
  assert.equal(released.action, 'released');
});

test('duplicate index entries are not accepted as consistent', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const bundle = await addX(repo);
  const page = await markCompiled(repo, bundle);
  await fs.appendFile(path.join(repo, 'wiki', '索引.md'),
    '- [Duplicate](' + path.relative(path.join(repo, 'wiki'), page).split(path.sep).join('/') + ') — Duplicate. Updated 2026-08-23; 1 source.\n');
  const scan = await scanCompileQueue(repo);
  assert.equal(scan.needs_review.length, 1);
  assert.match(scan.needs_review[0].reasons.join(','), /index-entry-count:2/);
});

test('正文链接和伪造日志包装不能冒充合规索引与 ingest 记录', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const bundle = await addX(repo);
  const page = await markCompiled(repo, bundle);
  const relPage = path.relative(path.join(repo, 'wiki'), page).split(path.sep).join('/');
  await fs.writeFile(path.join(repo, 'wiki', '索引.md'), `# Wiki Index\n\n正文提及 [来源](${relPage})，但这不是索引条目。\n`);
  const manifest = path.relative(repo, path.join(bundle.raw_bundle, 'manifest.json')).split(path.sep).join('/');
  await fs.writeFile(path.join(repo, 'wiki', '日志.md'), `# Wiki Log\n\n## [2026-08-23] ingest | Fixture\n\n- Raw: x${manifest}y (z${bundle.bundle_checksum}q)\n`);
  const scan = await scanCompileQueue(repo);
  assert.equal(scan.consistent.length, 0);
  assert.equal(scan.needs_review.length, 1);
  assert.match(scan.needs_review[0].reasons.join(','), /index-entry-count:0/);
  assert.match(scan.needs_review[0].reasons.join(','), /ingest-log-count:0/);
});

test('tampering an X raw bundle is an integrity failure', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const bundle = await addX(repo);
  await fs.appendFile(path.join(bundle.raw_bundle, 'article.md'), '\ntampered\n');
  const scan = await scanCompileQueue(repo);
  assert.equal(scan.integrity_failures.length, 1);
  assert.equal(scan.integrity_failures[0].platform, 'x');
});

test('Bilibili ingest log is recognized and tampering is an integrity failure', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const bundle = await addBilibili(repo);
  await markCompiled(repo, bundle, { status: 'needs-review' });
  let scan = await scanCompileQueue(repo);
  assert.equal(scan.consistent.length, 1);
  assert.equal(scan.consistent[0].platform, 'bilibili');
  await fs.appendFile(path.join(bundle.raw_bundle, 'article.md'), '\ntampered\n');
  scan = await scanCompileQueue(repo);
  assert.equal(scan.integrity_failures.length, 1);
  assert.equal(scan.integrity_failures[0].platform, 'bilibili');
});

test('Bilibili 未绑定字幕的来源页不能以 active 状态伪装为一致', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const bundle = await addBilibili(repo);
  await markCompiled(repo, bundle, { status: 'active' });
  const scan = await scanCompileQueue(repo);
  assert.equal(scan.consistent.length, 0);
  assert.equal(scan.needs_review.length, 1);
  assert.match(scan.needs_review[0].reasons.join(','), /bilibili-unverified-subtitle-requires-needs-review/);
});

test('YouTube 字幕 bundle 进入日志、receipt 与完整性闭环', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const bundle = await addYoutube(repo);
  await markCompiled(repo, bundle, { status: 'needs-review' });
  let scan = await scanCompileQueue(repo);
  assert.equal(scan.consistent.length, 1);
  assert.equal(scan.consistent[0].platform, 'youtube');
  assert.equal(scan.consistent[0].semantic_quality, 'pass');
  await fs.appendFile(path.join(bundle.raw_bundle, 'article.md'), '\ntampered\n');
  scan = await scanCompileQueue(repo);
  assert.equal(scan.integrity_failures.length, 1);
  assert.equal(scan.integrity_failures[0].platform, 'youtube');
});

test('YouTube metadata-only bundle 不能伪装为视频内容已炼化', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const bundle = await addYoutube(repo, { videoId: 'aaaaaaaaaaa', transcript: false });
  await markCompiled(repo, bundle, { status: 'needs-review' });
  const scan = await scanCompileQueue(repo);
  assert.equal(scan.consistent.length, 0);
  assert.equal(scan.pending.length, 0);
  assert.equal(scan.needs_review.length, 0);
  assert.equal(scan.archive_only.length, 1);
  assert.equal(scan.archive_only[0].bookkeeping_state, 'consistent');
  assert.match(scan.archive_only[0].reasons.join(','), /youtube-transcript-unavailable-not-content-compiled/);
});

test('YouTube metadata-only bundle 不进入全局 claim', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await addYoutube(repo, { transcript: false });
  const claimed = await claimNextBundle(repo);
  assert.equal(claimed.action, 'no-action');
  assert.equal(claimed.archive_only.length, 1);
  assert.equal(claimed.lock_released, true);
});

test('微信视频号 metadata-only bundle 不进入全局 claim', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await addWechatChannels(repo);
  const claimed = await claimNextBundle(repo);
  assert.equal(claimed.action, 'no-action');
  assert.equal(claimed.archive_only.length, 1);
  assert.equal(claimed.archive_only[0].platform, 'wechat-channels');
  assert.equal(claimed.lock_released, true);
});

test('fully compiled queue produces no-action and releases the lock', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const bundle = await addWechat(repo);
  await markCompiled(repo, bundle, { status: 'needs-review' });
  const result = await claimNextBundle(repo);
  assert.equal(result.action, 'no-action');
  assert.equal(result.lock_released, true);
});

test('只有标题的来源页即使有 receipt 也不能通过语义质量门禁', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const bundle = await addX(repo);
  await markCompiled(repo, bundle, { body: '' });
  const scan = await scanCompileQueue(repo);
  assert.equal(scan.needs_review.length, 1);
  assert.equal(scan.needs_review[0].bookkeeping_state, 'consistent');
  assert.equal(scan.needs_review[0].semantic_quality, 'needs-review');
  assert.match(scan.needs_review[0].reasons.join(','), /source-page-empty-body/);
});

test('单行标点或占位正文不能用自报满分 receipt 通过', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const bundle = await addX(repo);
  await markCompiled(repo, bundle, { body: '。' });
  const scan = await scanCompileQueue(repo);
  assert.equal(scan.consistent.length, 0);
  assert.match(scan.needs_review[0].reasons.join(','), /source-page-empty-body|source-page-thin-body/);
  assert.match(scan.needs_review[0].reasons.join(','), /source-page-raw-locator-missing/);
});

test('缺少质量 receipt 时账本一致的 bundle 不会 consistent', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const bundle = await addX(repo);
  await markCompiled(repo, bundle, { receipt: false });
  const scan = await scanCompileQueue(repo);
  assert.equal(scan.needs_review.length, 1);
  assert.equal(scan.needs_review[0].bookkeeping_state, 'consistent');
  assert.match(scan.needs_review[0].reasons.join(','), /quality-receipt-missing/);
});

test('绑定来源页旧 hash 的 receipt 会过期', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const bundle = await addX(repo);
  const page = await markCompiled(repo, bundle);
  await fs.appendFile(page, '\n后续修订使审查绑定失效。\n');
  const scan = await scanCompileQueue(repo);
  assert.equal(scan.needs_review.length, 1);
  assert.match(scan.needs_review[0].reasons.join(','), /quality-receipt-source-page-hash-mismatch/);
});

test('receipt 绑定的相关 Wiki 页变化后失效', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const bundle = await addX(repo);
  const related = path.join(repo, 'wiki', 'concepts', '相关概念.md');
  const relatedSource = path.relative(path.dirname(related), path.join(bundle.raw_bundle, 'article.md')).split(path.sep).join('/');
  await fs.mkdir(path.dirname(related), { recursive: true });
  await fs.writeFile(related, '---\ntitle: 相关概念\ntype: concept\nstatus: active\ncreated: 2026-01-01\nupdated: 2026-01-01\nsources:\n  - ' + relatedSource + '\ntags: []\n---\n\n可复用内容。\n\n[原始来源](' + relatedSource + ')\n');
  const page = await markCompiled(repo, bundle, { receipt: false });
  const sourcePage = path.relative(repo, page).split(path.sep).join('/');
  const relatedPage = path.relative(repo, related).split(path.sep).join('/');
  await writeQualityReceipt(repo, bundle, page, { receipt: {
    integration_decision: { updated_pages: [relatedPage], no_update_rationale: null },
    wiki_pages: [
      { path: sourcePage, sha256: await sha256(page) },
      { path: relatedPage, sha256: await sha256(related) },
    ],
  } });
  await fs.appendFile(related, '\n后续变化。\n');
  const scan = await scanCompileQueue(repo);
  assert.equal(scan.needs_review.length, 1);
  assert.match(scan.needs_review[0].reasons.join(','), /quality-receipt-wiki-page-hash-mismatch/);
});

test('共享 canonical 页变更只隔离旧 receipt，仍可领取无关 pending bundle', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const first = await addX(repo, '1111111111111111111');
  const shared = path.join(repo, 'wiki', 'concepts', '共享概念.md');
  const sharedSource = path.relative(path.dirname(shared), path.join(first.raw_bundle, 'article.md')).split(path.sep).join('/');
  await fs.mkdir(path.dirname(shared), { recursive: true });
  await fs.writeFile(shared, '---\ntitle: 共享概念\ntype: concept\nstatus: active\ncreated: 2026-01-01\nupdated: 2026-01-01\nsources:\n  - ' + sharedSource + '\ntags: []\n---\n\n初始共享内容。\n\n[原始来源](' + sharedSource + ')\n');

  const firstPage = await markCompiled(repo, first, { receipt: false });
  await writeSharedPageReceipt(repo, first, firstPage, shared, 'first.json');

  const second = await addX(repo, '2222222222222222222');
  const secondClaim = await claimNextBundle(repo);
  assert.equal(secondClaim.action, 'claimed');
  assert.equal(secondClaim.candidate.bundle_checksum, second.bundle_checksum);
  await fs.appendFile(shared, '\n由第二个来源更新的共享内容。\n');
  const secondPage = await markCompiled(repo, second, { receipt: false });
  await writeSharedPageReceipt(repo, second, secondPage, shared, 'second.json');
  await releaseCompileLock(repo, secondClaim.lock.claim_id);

  let scan = await scanCompileQueue(repo);
  assert.equal(scan.ok, false);
  assert.equal(scan.ready_for_claim, true);
  assert.equal(scan.needs_review.length, 1);
  assert.equal(scan.isolated_needs_review.length, 1);
  assert.equal(scan.blocking_needs_review.length, 0);
  assert.equal(scan.isolated_needs_review[0].bundle_checksum, first.bundle_checksum);
  assert.equal(scan.isolated_needs_review[0].review_isolation, 'shared-canonical-page-stale');
  assert.match(scan.isolated_needs_review[0].reasons.join(','), /quality-receipt-wiki-page-hash-mismatch:wiki\/concepts\/共享概念\.md/);
  assert.doesNotMatch(scan.isolated_needs_review[0].reasons.join(','), /quality-receipt-(?:hard-gate|score)-evidence-invalid/);

  const onlyReview = await claimNextBundle(repo);
  assert.equal(onlyReview.action, 'needs-review');
  assert.equal(onlyReview.review_status, 'shared-canonical-page-stale');
  assert.equal(onlyReview.lock_released, true);
  assert.equal(onlyReview.lock_retained, false);
  assert.equal(await fs.lstat(path.join(repo, 'staging', '.locks', 'article-wiki-compiler.lock')).catch(() => null), null);

  const unrelated = await addWechat(repo, 'unblocked');
  const claimed = await claimNextBundle(repo);
  assert.equal(claimed.action, 'claimed');
  assert.equal(claimed.candidate.bundle_checksum, unrelated.bundle_checksum);
  scan = await scanCompileQueue(repo);
  assert.equal(scan.isolated_needs_review.length, 1);
  assert.equal(scan.blocking_needs_review.length, 0);
});

test('原先 consistent 的共享 canonical 页结构损坏会转为全局阻塞', async (t) => {
  const corruptions = [
    ['缺少必填 frontmatter', (text) => text.replace('title: 共享概念\n', ''), /shared-canonical-page-missing-frontmatter-field:wiki\/concepts\/共享概念\.md:title/],
    ['type 与目录不对应', (text) => text.replace('type: concept', 'type: entity'), /shared-canonical-page-type-invalid:wiki\/concepts\/共享概念\.md/],
    ['非法 status', (text) => text.replace('status: active', 'status: invalid-status'), /shared-canonical-page-status-invalid:wiki\/concepts\/共享概念\.md/],
    ['raw source 不存在', (text, source) => text.replace(source, '../../raw/x/不存在/article.md'), /shared-canonical-page-raw-source-invalid:wiki\/concepts\/共享概念\.md/],
    ['正文相对链接失效', (text) => text + '\n[坏链接](../不存在.md)\n', /shared-canonical-page-broken-relative-link:wiki\/concepts\/共享概念\.md/],
    ['原文定位缺失', (text, source) => text.replace('[原始来源](' + source + ')', '原始来源已删除'), /shared-canonical-page-raw-locator-missing:wiki\/concepts\/共享概念\.md/],
  ];
  for (const [name, corrupt, expected] of corruptions) {
    await t.test(name, async (t) => {
      const repo = await makeRepo();
      t.after(() => fs.rm(repo, { recursive: true, force: true }));
      const bundle = await addX(repo);
      const shared = path.join(repo, 'wiki', 'concepts', '共享概念.md');
      const sharedSource = path.relative(path.dirname(shared), path.join(bundle.raw_bundle, 'article.md')).split(path.sep).join('/');
      await fs.mkdir(path.dirname(shared), { recursive: true });
      await fs.writeFile(shared, '---\ntitle: 共享概念\ntype: concept\nstatus: active\ncreated: 2026-01-01\nupdated: 2026-01-01\nsources:\n  - ' + sharedSource + '\ntags: []\n---\n\n初始共享内容。\n\n[原始来源](' + sharedSource + ')\n');
      const page = await markCompiled(repo, bundle, { receipt: false });
      await writeSharedPageReceipt(repo, bundle, page, shared, 'shared.json');
      let scan = await scanCompileQueue(repo);
      assert.equal(scan.consistent.length, 1);

      await fs.writeFile(shared, corrupt(await fs.readFile(shared, 'utf8'), sharedSource));
      scan = await scanCompileQueue(repo);
      assert.equal(scan.ready_for_claim, false);
      assert.equal(scan.isolated_needs_review.length, 0);
      assert.equal(scan.blocking_needs_review.length, 1);
      assert.match(scan.blocking_needs_review[0].reasons.join(','), expected);
      await addWechat(repo, 'canonical-' + name);
      const claim = await claimNextBundle(repo);
      assert.equal(claim.action, 'needs-review');
      assert.equal(claim.lock_retained, true);
    });
  }
});

test('来源页 receipt 过期仍是全局阻塞且保留 claim 锁', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const bundle = await addX(repo);
  const page = await markCompiled(repo, bundle);
  await fs.appendFile(page, '\n来源页发生后续修订。\n');
  await addWechat(repo, 'blocked');
  const claim = await claimNextBundle(repo);
  assert.equal(claim.action, 'needs-review');
  assert.equal(claim.lock_retained, true);
  assert.equal(claim.isolated_needs_review.length, 0);
  assert.equal(claim.blocking_needs_review.length, 1);
  assert.match(claim.blocking_needs_review[0].reasons.join(','), /quality-receipt-source-page-hash-mismatch/);
});

test('receipt 绑定的其他来源页变化仍是全局阻塞', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const bundle = await addX(repo);
  const page = await markCompiled(repo, bundle, { receipt: false });
  const otherSource = path.join(repo, 'wiki', 'sources', '其他来源页.md');
  await fs.writeFile(otherSource, '这是另一个来源页的可核验内容。\n');
  const sourcePage = path.relative(repo, page).split(path.sep).join('/');
  const otherSourcePage = path.relative(repo, otherSource).split(path.sep).join('/');
  await writeQualityReceipt(repo, bundle, page, { receipt: {
    integration_decision: { updated_pages: [otherSourcePage], no_update_rationale: null },
    wiki_pages: [
      { path: sourcePage, sha256: await sha256(page) },
      { path: otherSourcePage, sha256: await sha256(otherSource) },
    ],
  } });
  await fs.appendFile(otherSource, '后续修订。\n');
  await addWechat(repo, 'source-page-blocked');
  const claim = await claimNextBundle(repo);
  assert.equal(claim.action, 'needs-review');
  assert.equal(claim.lock_retained, true);
  assert.equal(claim.isolated_needs_review.length, 0);
  assert.equal(claim.blocking_needs_review.length, 1);
  assert.match(claim.blocking_needs_review[0].reasons.join(','), /quality-receipt-wiki-page-hash-mismatch:wiki\/sources\/其他来源页\.md/);
});

test('隔离复审与 raw 篡改或收据结构异常并存时仍阻塞 claim', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const reviewed = await addX(repo);
  const shared = path.join(repo, 'wiki', 'concepts', '共享概念.md');
  const sharedSource = path.relative(path.dirname(shared), path.join(reviewed.raw_bundle, 'article.md')).split(path.sep).join('/');
  await fs.mkdir(path.dirname(shared), { recursive: true });
  await fs.writeFile(shared, '---\ntitle: 共享概念\ntype: concept\nstatus: active\ncreated: 2026-01-01\nupdated: 2026-01-01\nsources:\n  - ' + sharedSource + '\ntags: []\n---\n\n初始共享内容。\n\n[原始来源](' + sharedSource + ')\n');
  const reviewedPage = await markCompiled(repo, reviewed, { receipt: false });
  await writeSharedPageReceipt(repo, reviewed, reviewedPage, shared, 'isolated.json');
  await fs.appendFile(shared, '\n共享页后续修订。\n');
  let scan = await scanCompileQueue(repo);
  assert.equal(scan.isolated_needs_review.length, 1);

  const tampered = await addWechat(repo, 'tampered');
  await fs.appendFile(path.join(tampered.raw_bundle, 'article.md'), '\n篡改。\n');
  await fs.writeFile(path.join(repo, 'quality-reviews', 'broken.json'), '{malformed\n');
  scan = await scanCompileQueue(repo);
  assert.equal(scan.integrity_failures.length, 2);
  assert.ok(scan.integrity_failures.some((item) => item.platform === 'wechat'));
  assert.ok(scan.integrity_failures.some((item) => item.platform === 'quality-reviews'
    && item.error === 'quality-receipt-malformed:broken.json'));
  const claim = await claimNextBundle(repo);
  assert.equal(claim.action, 'integrity-failure');
  assert.equal(claim.lock_retained, true);
});

test('来源页直接链接的 canonical 页必须由 receipt 绑定', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const bundle = await addX(repo);
  const related = path.join(repo, 'wiki', 'concepts', '相关概念.md');
  const relatedSource = path.relative(path.dirname(related), path.join(bundle.raw_bundle, 'article.md')).split(path.sep).join('/');
  await fs.mkdir(path.dirname(related), { recursive: true });
  await fs.writeFile(related, '---\ntitle: 相关概念\ntype: concept\nstatus: active\ncreated: 2026-01-01\nupdated: 2026-01-01\nsources:\n  - ' + relatedSource + '\ntags: []\n---\n\n可复用内容。\n\n[原始来源](' + relatedSource + ')\n');
  const page = await markCompiled(repo, bundle, { receipt: false });
  await fs.appendFile(page, '\n相关整合见[相关概念](../concepts/相关概念.md)。\n');
  await writeQualityReceipt(repo, bundle, page);
  const scan = await scanCompileQueue(repo);
  assert.equal(scan.consistent.length, 0);
  assert.match(scan.needs_review[0].reasons.join(','), /quality-receipt-linked-page-not-bound:wiki\/concepts\/相关概念\.md/);
});

test('receipt 的 Wiki 路径拒绝中间目录符号链接', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const bundle = await addX(repo);
  const page = await markCompiled(repo, bundle, { receipt: false });
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, '外部页.md'), '仓库外内容\n');
  await fs.mkdir(path.join(repo, 'wiki', 'concepts'), { recursive: true });
  await fs.symlink(outside, path.join(repo, 'wiki', 'concepts', '外部'));
  const sourcePage = path.relative(repo, page).split(path.sep).join('/');
  const externalPage = 'wiki/concepts/外部/外部页.md';
  await writeQualityReceipt(repo, bundle, page, { receipt: {
    integration_decision: { updated_pages: [externalPage], no_update_rationale: null },
    wiki_pages: [
      { path: sourcePage, sha256: await sha256(page) },
      { path: externalPage, sha256: await sha256(path.join(outside, '外部页.md')) },
    ],
  } });
  const scan = await scanCompileQueue(repo);
  assert.equal(scan.consistent.length, 0);
  assert.match(scan.needs_review[0].reasons.join(','), /quality-receipt-wiki-page-missing:wiki\/concepts\/外部\/外部页\.md/);
});

test('quality-reviews 中 malformed JSON 全局 fail-closed', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const bundle = await addX(repo);
  await markCompiled(repo, bundle);
  await fs.writeFile(path.join(repo, 'quality-reviews', 'broken.json'), '{malformed\n');
  const scan = await scanCompileQueue(repo);
  assert.equal(scan.ok, false);
  assert.ok(scan.integrity_failures.some((item) => item.platform === 'quality-reviews'
    && item.error === 'quality-receipt-malformed:broken.json'));
  assert.equal(scan.consistent.length, 0);
  assert.match(scan.needs_review[0].reasons.join(','), /quality-receipt-malformed:broken\.json/);
});

test('pass receipt 不接受 unsupported_claims 或缺少逐项评分证据', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const bundle = await addX(repo);
  const page = await markCompiled(repo, bundle, { receipt: false });
  await writeQualityReceipt(repo, bundle, page, { receipt: {
    unsupported_claims: ['未解决主张'],
    scores: {
      source_coverage: 2,
      claim_support: 2,
      uncertainty: 2,
      knowledge_integration: 2,
      reusability: 2,
      information_discipline: 2,
    },
  } });
  const scan = await scanCompileQueue(repo);
  assert.equal(scan.consistent.length, 0);
  assert.match(scan.needs_review[0].reasons.join(','), /quality-receipt-unsupported-claims-present/);
  assert.match(scan.needs_review[0].reasons.join(','), /quality-receipt-score-evidence-missing/);
});

test('receipt 的任意肯定句 evidence 被拒绝，不能替代可核验 locator', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const bundle = await addX(repo);
  const page = await markCompiled(repo, bundle, { receipt: false });
  await writeQualityReceipt(repo, bundle, page, { receipt: {
    hard_gates: [
      'raw_integrity',
      'provenance_consistency',
      'valid_evidence_anchors',
      'no_unsupported_material_claims',
      'wiki_bookkeeping_sync',
      'positive_knowledge_value',
      'coverage_map_complete',
      'integration_decision',
    ].map((name) => ({ name, passed: true, evidence: '我确认这项门槛已经通过。' })),
  } });
  const scan = await scanCompileQueue(repo);
  assert.equal(scan.consistent.length, 0);
  assert.match(scan.needs_review[0].reasons.join(','), /quality-receipt-hard-gate-evidence-invalid/);
});

test('reviewer 与 compiler 相同时 receipt 无效', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const bundle = await addX(repo);
  await markCompiled(repo, bundle, { receiptOptions: { reviewer: 'same-agent', compiler: 'same-agent' } });
  const scan = await scanCompileQueue(repo);
  assert.equal(scan.needs_review.length, 1);
  assert.match(scan.needs_review[0].reasons.join(','), /quality-receipt-reviewer-equals-compiler/);
});

test('核心维度不足时 receipt 无效，即使总分足够', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const bundle = await addX(repo);
  await markCompiled(repo, bundle, { receiptOptions: { scores: { source_coverage: 1 }, total_score: 11 } });
  const scan = await scanCompileQueue(repo);
  assert.equal(scan.needs_review.length, 1);
  assert.match(scan.needs_review[0].reasons.join(','), /quality-receipt-source-coverage-insufficient/);
});

test('合法 receipt 与账本一致时 bundle 才 consistent，并允许 release', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const bundle = await addX(repo);
  const claim = await claimNextBundle(repo);
  await markCompiled(repo, bundle);
  const scan = await scanCompileQueue(repo);
  assert.equal(scan.consistent.length, 1);
  assert.equal(scan.consistent[0].semantic_quality, 'pass');
  const released = await releaseCompileLock(repo, claim.lock.claim_id);
  assert.equal(released.action, 'released');
});

test('release 要求 claim 期间变化的全部 Wiki 内容页都绑定 receipt', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const bundle = await addX(repo);
  const claim = await claimNextBundle(repo);
  const related = path.join(repo, 'wiki', 'concepts', '未绑定变化.md');
  const relatedSource = path.relative(path.dirname(related), path.join(bundle.raw_bundle, 'article.md')).split(path.sep).join('/');
  await fs.mkdir(path.dirname(related), { recursive: true });
  await fs.writeFile(related, '---\ntitle: 未绑定变化\ntype: concept\nstatus: active\ncreated: 2026-01-01\nupdated: 2026-01-01\nsources:\n  - ' + relatedSource + '\ntags: []\n---\n\n本页在编译 claim 期间创建，但被 receipt 遗漏。\n\n[原始来源](' + relatedSource + ')\n');
  await markCompiled(repo, bundle);
  const scan = await scanCompileQueue(repo);
  assert.equal(scan.consistent.length, 1);
  await assert.rejects(() => releaseCompileLock(repo, claim.lock.claim_id), /变化的 Wiki 内容页未全部绑定/);
});

test('release 拒绝 claim 期间删除既有 Wiki 内容页', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const bundle = await addX(repo);
  const existing = path.join(repo, 'wiki', 'concepts', '既有知识.md');
  await fs.mkdir(path.dirname(existing), { recursive: true });
  await fs.writeFile(existing, '---\ntitle: 既有知识\ntype: concept\nstatus: active\ncreated: 2026-01-01\nupdated: 2026-01-01\nsources:\n  - ../../raw/x/source/article.md\ntags: []\n---\n\n该页在领取 claim 前已经存在。\n');
  const claim = await claimNextBundle(repo);
  await fs.unlink(existing);
  await markCompiled(repo, bundle);
  const scan = await scanCompileQueue(repo);
  assert.equal(scan.consistent.length, 1);
  await assert.rejects(() => releaseCompileLock(repo, claim.lock.claim_id), /删除了既有 Wiki 内容页/);
});
