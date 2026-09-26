import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { recall } from './wiki_recall.mjs';

async function fixture(t) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-recall-test-'));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, 'wiki', 'concepts'), { recursive: true });
  await fs.mkdir(path.join(repo, 'wiki', 'sources'));
  await fs.writeFile(path.join(repo, 'AGENTS.md'), '# fixture\n');
  await fs.writeFile(path.join(repo, 'wiki', '日志.md'), '# 日志\n检索词不应影响候选。\n');
  await fs.writeFile(path.join(repo, 'wiki', '索引.md'), '# 索引\n\n## Concepts\n\n- [索引优先主题](concepts/索引优先主题.md) — 检索词在索引摘要中。 Updated 2026-08-30; 1 source.\n- [正文主题](concepts/正文主题.md) — 普通主题。 Updated 2026-08-30; 1 source.\n');
  await fs.writeFile(path.join(repo, 'wiki', 'concepts', '索引优先主题.md'), '---\ntitle: 普通标题\ntype: concept\nstatus: active\ncreated: 2026-08-30\nupdated: 2026-08-30\nsources: []\ntags: []\n---\n\n# 普通标题\n');
  await fs.writeFile(path.join(repo, 'wiki', 'concepts', '正文主题.md'), '---\ntitle: 正文主题\ntype: concept\nstatus: active\ncreated: 2026-08-30\nupdated: 2026-08-30\nsources: []\ntags:\n  - 检索词\n---\n\n# 检索词\n\n正文命中检索词。\n');
  return repo;
}

test('recall 以索引标题、标签和正文的固定权重排序，且不读取日志', async (t) => {
  const repo = await fixture(t);
  const result = await recall({ repo, query: '检索词', limit: 5 });
  assert.equal(result.candidate_count, 2);
  assert.deepEqual(result.candidates.map((item) => item.path), [
    'wiki/concepts/索引优先主题.md',
    'wiki/concepts/正文主题.md',
  ]);
  assert.deepEqual(result.candidates[0].matches, ['index_summary']);
  assert.ok(result.candidates[1].matches.includes('tags'));
});

test('recall 对空 query 和无效 limit fail closed', async (t) => {
  const repo = await fixture(t);
  await assert.rejects(() => recall({ repo, query: '   ' }), /query/);
  await assert.rejects(() => recall({ repo, query: '检索词', limit: 0 }), /limit/);
});

test('任务召回排除已取代来源、优先 canonical 页面，并按 raw bundle 去重 lineage', async (t) => {
  const repo = await fixture(t);
  const raw = path.join(repo, 'raw', 'x', '同一来源');
  await fs.mkdir(raw, { recursive: true });
  await fs.writeFile(path.join(raw, 'article.md'), '# raw\n');
  await fs.mkdir(path.join(repo, 'wiki', 'analyses'), { recursive: true });
  const rawPath = '../../raw/x/同一来源/article.md';
  await fs.writeFile(path.join(repo, 'wiki', 'sources', '旧来源.md'), `---\ntitle: 旧来源\ntype: source\nstatus: superseded\nsources:\n  - ${rawPath}\ntags: [任务词]\n---\n\n旧来源任务词。\n`);
  await fs.writeFile(path.join(repo, 'wiki', 'concepts', '规范概念.md'), `---\ntitle: 规范概念\ntype: concept\nstatus: active\nsources:\n  - ${rawPath}\ntags: [任务词]\n---\n\n规范概念任务词。\n`);
  await fs.writeFile(path.join(repo, 'wiki', 'analyses', '规范分析.md'), `---\ntitle: 规范分析\ntype: analysis\nstatus: active\nsources:\n  - ${rawPath}\ntags: [任务词]\n---\n\n规范分析任务词。\n`);
  await fs.appendFile(path.join(repo, 'wiki', '索引.md'), '- [旧来源](sources/旧来源.md) — 任务词。 Updated 2026-08-30; 1 source.\n- [规范概念](concepts/规范概念.md) — 任务词。 Updated 2026-08-30; 1 source.\n- [规范分析](analyses/规范分析.md) — 任务词。 Updated 2026-08-30; 1 source.\n');

  const task = await recall({ repo, query: '任务词', limit: 10 });
  assert.ok(!task.candidates.some((item) => item.path === 'wiki/sources/旧来源.md'));
  assert.ok(['wiki/concepts/规范概念.md', 'wiki/analyses/规范分析.md'].includes(task.candidates[0].path));
  assert.equal(task.independent_source_count, 1);
  assert.equal(task.candidates[0].independent_source_count, 1);

  const source = await recall({ repo, query: '任务词', limit: 10, mode: 'source' });
  assert.equal(source.candidates[0].path, 'wiki/sources/旧来源.md');
  assert.equal(source.candidates[0].status, 'superseded');
});

test('YouTube article、manifest 与字幕引用归并为同一个来源 lineage', async (t) => {
  const repo = await fixture(t);
  const raw = path.join(repo, 'raw', 'youtube', '同一视频');
  await fs.mkdir(path.join(raw, 'responses', 'subtitles'), { recursive: true });
  await fs.writeFile(path.join(raw, 'article.md'), '# 视频字幕\n');
  await fs.writeFile(path.join(raw, 'manifest.json'), '{}\n');
  await fs.writeFile(path.join(raw, 'responses', 'subtitles', 'selected.json3'), '{}\n');
  await fs.writeFile(path.join(repo, 'wiki', 'concepts', 'YouTube来源甲.md'), `---\ntitle: YouTube来源甲\ntype: concept\nstatus: active\nsources:\n  - ../../raw/youtube/同一视频/article.md\n  - ../../raw/youtube/同一视频/manifest.json\ntags: [YouTubeLineageToken]\n---\n\nYouTubeLineageToken 正文。\n`);
  await fs.writeFile(path.join(repo, 'wiki', 'concepts', 'YouTube来源乙.md'), `---\ntitle: YouTube来源乙\ntype: concept\nstatus: active\nsources:\n  - ../../raw/youtube/同一视频/responses/subtitles/selected.json3\ntags: [YouTubeLineageToken]\n---\n\nYouTubeLineageToken 补充。\n`);
  const result = await recall({ repo, query: 'YouTubeLineageToken', limit: 10 });
  assert.equal(result.independent_source_count, 1);
  assert.ok(result.candidates.every((item) => item.evidence_lineages.includes('raw/youtube/同一视频')));
});
