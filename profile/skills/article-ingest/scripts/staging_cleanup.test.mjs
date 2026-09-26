import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { promoteStage, stageInput } from '../../wechat-ingest/scripts/wechat_ingest.mjs';
import { captureToStage, promoteStage as promoteXStage, verifyRaw as verifyXRaw } from '../../x-ingest/scripts/x_ingest.mjs';
import { stageVideo, promoteStage as promoteBilibiliStage, verifyRaw as verifyBilibiliRaw } from '../../bilibili-ingest/scripts/bilibili_ingest.mjs';
import { stageVideo as stageYoutubeVideo, promoteStage as promoteYoutubeStage, verifyRaw as verifyYoutubeRaw } from '../../youtube-ingest/scripts/youtube_ingest.mjs';
import { runCleanup } from './staging_cleanup.mjs';

const NOW = '2026-09-01T00:00:00.000Z';
const OLD = new Date('2026-07-01T00:00:00.000Z');

async function makeRepo() {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'staging-cleanup-test-'));
  await fs.writeFile(path.join(repo, 'AGENTS.md'), '# fixture\n');
  await fs.mkdir(path.join(repo, 'wiki', 'sources'), { recursive: true });
  await fs.mkdir(path.join(repo, '.agents', 'skills', 'wiki-knowledge-loop', 'references'), { recursive: true });
  await fs.writeFile(path.join(repo, '.agents', 'skills', 'wiki-knowledge-loop', 'references', 'quality-rubric.md'), '# Fixture quality rubric\n');
  await fs.writeFile(path.join(repo, 'wiki', '索引.md'), '# Index\n\n## Sources\n');
  await fs.writeFile(path.join(repo, 'wiki', '日志.md'), '# Log\n');
  await fs.mkdir(path.join(repo, 'raw', 'wechat'), { recursive: true });
  await fs.mkdir(path.join(repo, 'staging', 'wechat'), { recursive: true });
  await fs.mkdir(path.join(repo, 'staging', 'x'));
  await fs.mkdir(path.join(repo, 'staging', 'bilibili'));
  await fs.mkdir(path.join(repo, 'staging', 'youtube'));
  await fs.mkdir(path.join(repo, 'staging', 'wechat-channels'));
  await fs.mkdir(path.join(repo, 'staging', 'requests', '.tmp'), { recursive: true });
  await fs.mkdir(path.join(repo, 'staging', 'requests', '.locks'));
  await fs.mkdir(path.join(repo, 'staging', 'requests', '.dedupe'));
  if (process.platform !== 'win32') {
    for (const target of [
      path.join(repo, 'staging', 'requests'),
      path.join(repo, 'staging', 'requests', '.tmp'),
      path.join(repo, 'staging', 'requests', '.locks'),
      path.join(repo, 'staging', 'requests', '.dedupe'),
    ]) await fs.chmod(target, 0o700);
  }
  return repo;
}

async function markOld(root) {
  async function walk(target) {
    const stat = await fs.lstat(target);
    if (stat.isDirectory()) {
      for (const entry of await fs.readdir(target)) await walk(path.join(target, entry));
    }
    await fs.utimes(target, OLD, OLD);
  }
  await walk(root);
}

async function fixtureStage(repo, suffix = 'one', { promote = false, compiled = false } = {}) {
  const input = path.join(repo, `${suffix}.md`);
  await fs.writeFile(input, `# Fixture ${suffix}\n\n正文。\n`);
  const staged = await stageInput({
    repo,
    url: `https://mp.weixin.qq.com/s?__biz=fixture&mid=${suffix}`,
    input,
    publishedAt: '2026-07-01',
  });
  let raw;
  if (promote) raw = await promoteStage(staged.stage, repo);
  if (compiled) await markCompiled(repo, raw, suffix);
  await markOld(staged.stage);
  return { stage: staged.stage, raw };
}

function xFixtureFetch(statusId) {
  return async function fetchFixture(url) {
    if (String(url).startsWith('https://cdn.syndication.twimg.com/')) {
      return new Response(JSON.stringify({
        id_str: statusId,
        text: 'X cleanup fixture body',
        created_at: '2026-07-01T00:00:00.000Z',
        user: { screen_name: 'cleanupfixture', name: 'Cleanup Fixture' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  };
}

async function xFixtureStage(repo, suffix = 'x-cleanup') {
  const statusId = '1234567890123456789';
  const staged = await captureToStage({
    repo,
    stage: path.join(repo, 'staging', 'x', suffix),
    url: `https://x.com/cleanupfixture/status/${statusId}`,
    fetchImpl: xFixtureFetch(statusId),
  });
  const raw = await promoteXStage(staged.stage, repo);
  await markCompiled(repo, raw, suffix);
  await markOld(staged.stage);
  return { stage: staged.stage, raw };
}

async function bilibiliFixtureStage(repo, suffix = 'bilibili-cleanup') {
  const bvid = 'BV1xx411c7mD';
  const staged = await stageVideo({
    repo,
    stage: path.join(repo, 'staging', 'bilibili', suffix),
    url: `https://www.bilibili.com/video/${bvid}?fixture=cleanup`,
    fetchImpl: async () => new Response(JSON.stringify({
      code: 0,
      data: {
        bvid,
        cid: 201,
        title: 'Bilibili cleanup fixture',
        owner: { name: 'Cleanup UP', mid: 43 },
        pubdate: 1788000000,
        duration: 15,
        pages: [{ page: 1, cid: 201, duration: 15, part: 'Cleanup P1' }],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    subtitleImpl: async () => [{ index: 1, from: '0.00s', to: '1.00s', content: '清理测试字幕' }],
  });
  const raw = await promoteBilibiliStage(staged.stage, repo);
  await markCompiled(repo, raw, suffix, 'needs-review');
  await markOld(staged.stage);
  return { stage: staged.stage, raw };
}

async function youtubeFixtureStage(repo, suffix = 'youtube-cleanup') {
  const videoId = 'dQw4w9WgXcQ';
  const canonical = `https://www.youtube.com/watch?v=${videoId}`;
  const staged = await stageYoutubeVideo({
    repo,
    stage: path.join(repo, 'staging', 'youtube', suffix),
    url: `${canonical}&list=PLcleanup`,
    metadataImpl: async () => ({
      yt_dlp_version: 'fixture',
      metadata: {
        id: videoId,
        extractor: 'youtube',
        extractor_key: 'Youtube',
        webpage_url: canonical,
        availability: 'public',
        title: 'YouTube cleanup fixture',
        uploader: 'Cleanup creator',
        channel: 'Cleanup channel',
        channel_id: 'UCcleanup',
        upload_date: '20260701',
        duration: 15,
        original_language: 'en',
        live_status: 'not_live',
        subtitles: { en: [{ ext: 'vtt', format_id: 'fixture' }] },
        automatic_captions: {},
      },
    }),
    subtitleImpl: async () => ({ content: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nYouTube cleanup caption\n' }),
  });
  const raw = await promoteYoutubeStage(staged.stage, repo);
  await markCompiled(repo, raw, suffix, 'needs-review');
  await markOld(staged.stage);
  return { stage: staged.stage, raw };
}

async function markCompiled(repo, bundle, suffix, status = 'active') {
  const page = path.join(repo, 'wiki', 'sources', `${suffix}.md`);
  const article = path.join(bundle.raw_bundle, 'article.md');
  const manifest = path.join(bundle.raw_bundle, 'manifest.json');
  const relArticle = path.relative(path.dirname(page), article).split(path.sep).join('/');
  const relManifest = path.relative(path.dirname(page), manifest).split(path.sep).join('/');
  await fs.writeFile(page,
    '---\n'
    + `title: Fixture ${suffix}\n`
    + `type: source\nstatus: ${status}\ncreated: 2026-07-01\nupdated: 2026-07-01\n`
    + `sources:\n  - ${relArticle}\ntags: []\n`
    + `provenance:\n  raw_manifest: ${relManifest}\n  raw_checksum: ${bundle.bundle_checksum}\n`
    + '---\n\n# Fixture\n\n'
    + '这份 fixture 记录来源中可复用的知识内容，并用于验证编译、保留期与安全清理之间的完整闭环。\n\n'
    + '它保留来源边界、校验状态和清理条件，确保只有账本与语义质量均一致的旧暂存目录才会进入候选集合。\n\n'
    + `具体原始证据见 [固化文章](${relArticle})；该链接同时验证来源页存在可追溯、仓库内的 raw 定位。\n`);
  await fs.appendFile(path.join(repo, 'wiki', '索引.md'), `- [Fixture ${suffix}](sources/${suffix}.md) — Fixture. Updated 2026-07-01; 1 source.\n`);
  await fs.appendFile(path.join(repo, 'wiki', '日志.md'),
    `\n## [2026-07-01] ingest | Fixture ${suffix}\n\n- Raw: \`${path.relative(repo, manifest).split(path.sep).join('/')}\` (\`${bundle.bundle_checksum}\`)\n- Wiki: created \`wiki/sources/${suffix}.md\`\n- Notes: fixture\n`);
  const fileSha256 = async (target) => `sha256:${createHash('sha256').update(await fs.readFile(target)).digest('hex')}`;
  const sourcePage = path.relative(repo, page).split(path.sep).join('/');
  const rawArticle = path.relative(repo, article).split(path.sep).join('/');
  const sourcePageSha256 = await fileSha256(page);
  const evidence = {
    version: 1,
    raw: [{ path: rawArticle, locator: { kind: 'lines', start: 1, end: 1 } }],
    wiki: [{ path: sourcePage, locator: { kind: 'lines', start: 1, end: 1 } }],
  };
  const scores = {
    source_coverage: 2,
    claim_support: 2,
    uncertainty: 2,
    knowledge_integration: 2,
    reusability: 2,
    information_discipline: 2,
  };
  const receipt = {
    platform: path.relative(path.join(repo, 'raw'), bundle.raw_bundle).split(path.sep)[0],
    bundle_checksum: bundle.bundle_checksum,
    source_page: sourcePage,
    source_page_sha256: sourcePageSha256,
    rubric_sha256: await fileSha256(path.join(repo, '.agents', 'skills', 'wiki-knowledge-loop', 'references', 'quality-rubric.md')),
    status: 'pass',
    total_score: 12,
    scores: Object.entries(scores).map(([dimension, score]) => ({
      dimension,
      score,
      evidence,
    })),
    reviewer: 'cleanup-quality-reviewer',
    compiler: 'cleanup-wiki-compiler',
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
    coverage_map: [{ source_scope: 'fixture', wiki_location: sourcePage, omission_reason: null }],
    integration_decision: { updated_pages: [], no_update_rationale: 'Fixture has no canonical integration target.' },
    wiki_pages: [{ path: sourcePage, sha256: sourcePageSha256 }],
    unsupported_claims: [],
  };
  await fs.mkdir(path.join(repo, 'quality-reviews'), { recursive: true });
  await fs.writeFile(path.join(repo, 'quality-reviews', `${suffix}.json`), JSON.stringify(receipt, null, 2) + '\n');
}

async function cleanupRepo(t) {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  return repo;
}

async function captureRejection(task) {
  try {
    await task();
  } catch (error) {
    return error;
  }
  assert.fail('expected task to reject');
}

test('dry-run identifies a consistent old stage without deleting it', async (t) => {
  const repo = await cleanupRepo(t);
  const fixture = await fixtureStage(repo, 'dry', { promote: true, compiled: true });
  const result = await runCleanup({ repo, now: NOW });
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.eligible.length, 1);
  assert.equal(result.deleted.length, 0);
  await assert.doesNotReject(() => fs.lstat(fixture.stage));
});

test('stages within the 30-day retention window are retained', async (t) => {
  const repo = await cleanupRepo(t);
  const fixture = await fixtureStage(repo, 'recent', { promote: true, compiled: true });
  const recent = new Date('2026-08-31T00:00:00.000Z');
  await fs.utimes(path.join(fixture.stage, 'article.md'), recent, recent);
  await fs.utimes(path.join(fixture.stage, 'capture.json'), recent, recent);
  await fs.utimes(fixture.stage, recent, recent);
  const result = await runCleanup({ repo, now: NOW });
  assert.equal(result.eligible.length, 0);
  assert.ok(result.retained.some((item) => item.stage === fixture.stage && item.reason === 'within-retention-window'));
});

test('an unused platform stage directory may be absent without weakening existing checks', async (t) => {
  const repo = await cleanupRepo(t);
  await fs.rmdir(path.join(repo, 'staging', 'bilibili'));
  const result = await runCleanup({ repo, now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.eligible.length, 0);
});

test('old stage without a matching raw bundle is retained', async (t) => {
  const repo = await cleanupRepo(t);
  const fixture = await fixtureStage(repo, 'no-raw');
  const result = await runCleanup({ repo, now: NOW });
  assert.ok(result.retained.some((item) => item.stage === fixture.stage && item.reason === 'no-matching-verified-raw-bundle'));
});

test('old stage whose raw bundle is not compiled consistently is retained', async (t) => {
  const repo = await cleanupRepo(t);
  const fixture = await fixtureStage(repo, 'pending', { promote: true });
  const result = await runCleanup({ repo, now: NOW });
  assert.ok(result.retained.some((item) => item.stage === fixture.stage && item.reason === 'compile-state-pending'));
});

test('queue or lock anomalies globally fail closed', async (t) => {
  const repo = await cleanupRepo(t);
  const fixture = await fixtureStage(repo, 'locked', { promote: true, compiled: true });
  await fs.writeFile(path.join(repo, 'staging', 'requests', '.locks', 'unexpected.lock'), '{}\n');
  await assert.rejects(() => runCleanup({ repo, now: NOW, apply: true }), /请求队列完整性校验失败/);
  await assert.doesNotReject(() => fs.lstat(fixture.stage));
});

test('symlinked candidates and boundary paths are never deleted', async (t) => {
  const repo = await cleanupRepo(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'staging-cleanup-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'keep'), 'keep\n');
  await fs.symlink(outside, path.join(repo, 'staging', 'wechat', 'outside-link'));
  await fs.writeFile(path.join(repo, 'staging', 'wechat', '.gitkeep'), 'keep\n');
  const result = await runCleanup({ repo, now: NOW, apply: true });
  assert.ok(result.retained.some((item) => item.reason === 'not-a-direct-normal-directory'));
  assert.equal(await fs.readFile(path.join(outside, 'keep'), 'utf8'), 'keep\n');
  await assert.doesNotReject(() => fs.lstat(path.join(repo, 'staging', 'wechat')));
  await assert.doesNotReject(() => fs.lstat(path.join(repo, 'staging', 'requests')));
});

test('only an old matching consistent direct stage is removed with --apply', async (t) => {
  const repo = await cleanupRepo(t);
  const fixture = await fixtureStage(repo, 'apply', { promote: true, compiled: true });
  await fs.mkdir(path.join(repo, 'staging', 'inbox'));
  await fs.writeFile(path.join(repo, 'staging', 'inbox', 'retain.md'), 'retain\n');
  const result = await runCleanup({ repo, now: NOW, apply: true });
  assert.equal(result.deleted.length, 1);
  assert.equal(result.deleted[0].stage, fixture.stage);
  await assert.rejects(() => fs.lstat(fixture.stage), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(repo, 'staging', 'inbox', 'retain.md'), 'utf8'), 'retain\n');
  await assert.doesNotReject(() => fs.lstat(fixture.raw.raw_bundle));
});

test('删除前目录替换会被原子隔离身份栅栏阻止且替代目录保留', async (t) => {
  const repo = await cleanupRepo(t);
  const fixture = await fixtureStage(repo, 'swap-before-delete', { promote: true, compiled: true });
  const parked = `${fixture.stage}-parked`;
  let exercised = false;
  const error = await captureRejection(() => runCleanup({
    repo,
    now: NOW,
    apply: true,
    testHook: {
      beforeDelete: async ({ candidate }) => {
        if (exercised || candidate.stage !== fixture.stage) return;
        exercised = true;
        await fs.rename(fixture.stage, parked);
        await fs.mkdir(fixture.stage);
        await fs.writeFile(path.join(fixture.stage, 'replacement.txt'), 'must survive\n');
      },
    },
  }));
  assert.equal(exercised, true);
  assert.match(error.message, /原子隔离对象与已验证候选身份不一致/);
  assert.equal(await fs.readFile(path.join(fixture.stage, 'replacement.txt'), 'utf8'), 'must survive\n');
  await assert.doesNotReject(() => fs.lstat(parked));
});

test('consistent old X stage is retained by dry-run, removed by apply, and leaves raw verified', async (t) => {
  const repo = await cleanupRepo(t);
  const fixture = await xFixtureStage(repo);
  const preview = await runCleanup({ repo, now: NOW });
  assert.equal(preview.mode, 'dry-run');
  assert.ok(preview.eligible.some((item) => item.platform === 'x' && item.stage === fixture.stage));
  await assert.doesNotReject(() => fs.lstat(fixture.stage));

  const applied = await runCleanup({ repo, now: NOW, apply: true });
  assert.ok(applied.deleted.some((item) => item.platform === 'x' && item.stage === fixture.stage));
  await assert.rejects(() => fs.lstat(fixture.stage), { code: 'ENOENT' });
  await assert.doesNotReject(() => verifyXRaw(fixture.raw.raw_bundle, repo));
});

test('consistent old Bilibili stage is retained by dry-run, removed by apply, and leaves raw verified', async (t) => {
  const repo = await cleanupRepo(t);
  const fixture = await bilibiliFixtureStage(repo);
  const preview = await runCleanup({ repo, now: NOW });
  assert.equal(preview.mode, 'dry-run');
  assert.ok(preview.eligible.some((item) => item.platform === 'bilibili' && item.stage === fixture.stage));
  await assert.doesNotReject(() => fs.lstat(fixture.stage));

  const applied = await runCleanup({ repo, now: NOW, apply: true });
  assert.ok(applied.deleted.some((item) => item.platform === 'bilibili' && item.stage === fixture.stage));
  await assert.rejects(() => fs.lstat(fixture.stage), { code: 'ENOENT' });
  await assert.doesNotReject(() => verifyBilibiliRaw(fixture.raw.raw_bundle, repo));
});

test('consistent old YouTube stage is retained by dry-run, removed by apply, and leaves raw verified', async (t) => {
  const repo = await cleanupRepo(t);
  const fixture = await youtubeFixtureStage(repo);
  const preview = await runCleanup({ repo, now: NOW });
  assert.equal(preview.mode, 'dry-run');
  assert.ok(preview.eligible.some((item) => item.platform === 'youtube' && item.stage === fixture.stage));
  await assert.doesNotReject(() => fs.lstat(fixture.stage));

  const applied = await runCleanup({ repo, now: NOW, apply: true });
  assert.ok(applied.deleted.some((item) => item.platform === 'youtube' && item.stage === fixture.stage));
  await assert.rejects(() => fs.lstat(fixture.stage), { code: 'ENOENT' });
  await assert.doesNotReject(() => verifyYoutubeRaw(fixture.raw.raw_bundle, repo));
});

test('a compile lock appearing after the first deletion fail-closes remaining candidates', async (t) => {
  const repo = await cleanupRepo(t);
  const first = await fixtureStage(repo, 'a-lock-first', { promote: true, compiled: true });
  const second = await fixtureStage(repo, 'b-lock-second', { promote: true, compiled: true });
  const error = await captureRejection(
    () => runCleanup({
      repo,
      now: NOW,
      apply: true,
      testHook: {
        afterDelete: async ({ deleted }) => {
          if (deleted.length !== 1) return;
          await fs.mkdir(path.join(repo, 'staging', '.locks'));
          await fs.writeFile(path.join(repo, 'staging', '.locks', 'article-wiki-compiler.lock'), '{}\n');
        },
      },
    }),
  );
  assert.match(error.message, /存在活动编译 claim/);
  assert.equal(error.details.partial_progress.deleted.length, 1);
  assert.equal(error.details.partial_progress.deleted[0].stage, first.stage);
  await assert.rejects(() => fs.lstat(first.stage), { code: 'ENOENT' });
  await assert.doesNotReject(() => fs.lstat(second.stage));
});

test('a replaced platform stage base after the first deletion fail-closes remaining candidates', async (t) => {
  const repo = await cleanupRepo(t);
  const first = await fixtureStage(repo, 'a-base-first', { promote: true, compiled: true });
  const second = await fixtureStage(repo, 'b-base-second', { promote: true, compiled: true });
  const base = path.join(repo, 'staging', 'wechat');
  const parkedBase = path.join(repo, 'staging', 'wechat-replaced-during-cleanup');
  const error = await captureRejection(
    () => runCleanup({
      repo,
      now: NOW,
      apply: true,
      testHook: {
        afterDelete: async ({ deleted }) => {
          if (deleted.length !== 1) return;
          await fs.rename(base, parkedBase);
          await fs.mkdir(base);
        },
      },
    }),
  );
  assert.match(error.message, /staging\/wechat在操作期间被替换/);
  assert.equal(error.details.partial_progress.deleted.length, 1);
  assert.equal(error.details.partial_progress.deleted[0].stage, first.stage);
  await assert.rejects(() => fs.lstat(first.stage), { code: 'ENOENT' });
  await assert.doesNotReject(() => fs.lstat(path.join(parkedBase, path.basename(second.stage))));
});
