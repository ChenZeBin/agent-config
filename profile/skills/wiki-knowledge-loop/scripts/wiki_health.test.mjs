import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inspectHealth } from './wiki_health.mjs';
import { promoteStage as promoteYoutubeStage, stageVideo as stageYoutubeVideo } from '../../youtube-ingest/scripts/youtube_ingest.mjs';

async function fixture(t) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-health-test-'));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, 'wiki', 'concepts'), { recursive: true });
  await fs.mkdir(path.join(repo, 'wiki', 'sources'));
  await fs.mkdir(path.join(repo, 'raw'));
  await fs.writeFile(path.join(repo, 'AGENTS.md'), '# fixture\n');
  await fs.writeFile(path.join(repo, 'raw', '证据.md'), '# evidence\n');
  await fs.writeFile(path.join(repo, 'wiki', '索引.md'), '# 索引\n\n## Concepts\n\n- [主题](concepts/主题.md) — 测试主题。 Updated 2026-08-30; 1 source.\n');
  await fs.writeFile(path.join(repo, 'wiki', '日志.md'), '# 日志\n');
  await fs.writeFile(path.join(repo, 'wiki', 'concepts', '主题.md'), '---\ntitle: 主题\ntype: concept\nstatus: active\ncreated: 2026-08-30\nupdated: 2026-08-30\nsources:\n  - ../../raw/证据.md\ntags: []\n---\n\n# 主题\n\n[证据](../../raw/证据.md)\n');
  return repo;
}

test('health 接受仓库内 raw 证据链接，警告不阻断', async (t) => {
  const repo = await fixture(t);
  const result = await inspectHealth({ repo });
  assert.equal(result.ok, true);
  assert.equal(result.summary.errors, 0);
  assert.equal(result.compile_queue.integrity_failures.length, 0);
  assert.ok(result.issues.some((item) => item.code === 'orphan-page'));
});

test('health 将 frontmatter、raw、链接和中文 basename 违规作为错误', async (t) => {
  const repo = await fixture(t);
  await fs.writeFile(path.join(repo, 'wiki', 'concepts', 'english-name.md'), '---\ntitle: 缺失\ntype: bad\nstatus: active\ncreated: 2026-08-30\nupdated: 2026-08-30\nsources:\n  - ../../outside.md\n---\n\n[坏链接](不存在.md)\n');
  const result = await inspectHealth({ repo, includeCompile: false });
  assert.equal(result.ok, false);
  const codes = new Set(result.issues.filter((item) => item.severity === 'error').map((item) => item.code));
  for (const code of ['non-chinese-basename', 'invalid-type', 'source-outside-raw', 'broken-relative-link']) assert.ok(codes.has(code), code);
});

test('health 通过 compile queue 报告被篡改的 YouTube raw bundle', async (t) => {
  const repo = await fixture(t);
  const videoId = 'dQw4w9WgXcQ';
  const canonical = `https://www.youtube.com/watch?v=${videoId}`;
  const stage = await stageYoutubeVideo({
    repo,
    url: canonical,
    metadataImpl: async () => ({ yt_dlp_version: 'fixture', metadata: { id: videoId, extractor: 'youtube', extractor_key: 'Youtube', webpage_url: canonical, availability: 'public', title: 'YouTube health fixture', uploader: 'Fixture', channel: 'Fixture', channel_id: 'UCfixture', upload_date: '20260830', duration: 1, original_language: 'en', live_status: 'not_live', subtitles: { en: [{ ext: 'vtt' }] }, automatic_captions: {} } }),
    subtitleImpl: async () => ({ content: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhealth fixture\n' }),
  });
  const raw = await promoteYoutubeStage(stage.stage, repo);
  await fs.appendFile(path.join(raw.raw_bundle, 'article.md'), 'tampered\n');
  const result = await inspectHealth({ repo });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((item) => item.code === 'compile-integrity-failure' && item.platform === 'youtube'));
});
