import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { evaluate } from './wiki_eval.mjs';

async function fixture(t) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-eval-test-'));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, 'wiki', 'concepts'), { recursive: true });
  await fs.mkdir(path.join(repo, 'raw'));
  await fs.writeFile(path.join(repo, 'AGENTS.md'), '# fixture\n');
  await fs.writeFile(path.join(repo, 'raw', '证据.md'), '# evidence\n');
  await fs.writeFile(path.join(repo, 'wiki', '索引.md'), '# 索引\n\n## Concepts\n\n- [检索主题](concepts/检索主题.md) — 检索答案。 Updated 2026-08-30; 1 source.\n');
  await fs.writeFile(path.join(repo, 'wiki', '日志.md'), '# 日志\n');
  await fs.writeFile(path.join(repo, 'wiki', 'concepts', '检索主题.md'), '---\ntitle: 检索主题\ntype: concept\nstatus: active\ncreated: 2026-08-30\nupdated: 2026-08-30\nsources:\n  - ../../raw/证据.md\ntags:\n  - 检索\n---\n\n# 检索主题\n');
  return repo;
}

test('eval 计算检索指标和 answerability guard，并可附带 health 汇总', async (t) => {
  const repo = await fixture(t);
  const cases = path.join(repo, 'cases.jsonl');
  await fs.appendFile(path.join(repo, 'wiki', 'concepts', '检索主题.md'), '\n可执行答案包含触发条件与失败边界，并说明适用场景、验证步骤、预期结果和发生异常时的停止条件；执行者还要记录输入、输出、失败原因、复现环境和回退决定。这段正文用于证明答案术语位于有实际含义且直接绑定原始证据的知识单元中。[^e]\n\n[^e]: [证据](../../raw/证据.md)\n');
  await fs.writeFile(cases, '{"id":"one","query":"检索","relevant":["wiki/concepts/检索主题.md"],"answer_terms":["触发条件","失败边界"]}\n');
  const result = await evaluate({ repo, cases, limit: 3, includeHealth: true });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.metrics, { case_count: 1, evaluated_count: 1, skipped_count: 0, hit_at_k: 1, mrr: 1, coverage: 1, answerability_case_count: 1, answerability_pass_rate: 1 });
  assert.equal(result.cases[0].answerability.passed, true);
  assert.equal(result.health.ok, true);
});

test('只有标题和索引命中的页面不能通过 answerability guard', async (t) => {
  const repo = await fixture(t);
  const cases = path.join(repo, 'thin.jsonl');
  await fs.writeFile(cases, '{"id":"thin","query":"检索","relevant":["wiki/concepts/检索主题.md"],"answer_terms":["触发条件"]}\n');
  const result = await evaluate({ repo, cases, limit: 3 });
  assert.equal(result.metrics.hit_at_k, 1);
  assert.equal(result.metrics.answerability_pass_rate, 0);
  assert.equal(result.cases[0].answerability.passed, false);
  assert.equal(result.ok, false);
});

test('HTML 注释关键词和不存在或未声明的 raw 链接不能伪造 answerability', async (t) => {
  const repo = await fixture(t);
  const page = path.join(repo, 'wiki', 'concepts', '检索主题.md');
  await fs.appendFile(page, '\n<!-- 触发条件 失败边界 [伪证据](../../raw/不存在.md) -->\n');
  const cases = path.join(repo, 'bypass.jsonl');
  await fs.writeFile(cases, '{"id":"bypass","query":"检索","relevant":["wiki/concepts/检索主题.md"],"answer_terms":["触发条件","失败边界"]}\n');
  const result = await evaluate({ repo, cases, limit: 3 });
  assert.equal(result.metrics.hit_at_k, 1);
  assert.equal(result.metrics.answerability_pass_rate, 0);
  assert.equal(result.cases[0].answerability.has_raw_locator, false);
  assert.deepEqual(result.cases[0].answerability.missing_terms, ['触发条件', '失败边界']);
  assert.equal(result.ok, false);
});

test('eval 对空 JSONL 模板明确 skipped', async (t) => {
  const repo = await fixture(t);
  const cases = path.join(repo, 'empty.jsonl');
  await fs.writeFile(cases, '# 每行一个 {"query":"...","relevant":["wiki/...md"]}\n');
  const result = await evaluate({ repo, cases });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'empty-case-set');
  assert.equal(result.metrics.case_count, 0);
  assert.equal(result.ok, false);
});

test('检索完全未命中时 eval 必须失败', async (t) => {
  const repo = await fixture(t);
  const cases = path.join(repo, 'miss.jsonl');
  await fs.writeFile(cases, '{"id":"miss","query":"绝对不存在的召回词汇","relevant":["wiki/concepts/检索主题.md"]}\n');
  const result = await evaluate({ repo, cases, limit: 3 });
  assert.equal(result.metrics.hit_at_k, 0);
  assert.equal(result.metrics.coverage, 0);
  assert.equal(result.ok, false);
});

test('缺失或不安全的 relevant 页面必须 fail-closed', async (t) => {
  const repo = await fixture(t);
  const cases = path.join(repo, 'missing.jsonl');
  await fs.writeFile(cases, '{"id":"missing","query":"检索","relevant":["wiki/concepts/不存在.md"]}\n');
  await assert.rejects(evaluate({ repo, cases, limit: 3 }), /relevant 页面不存在或不安全/);
});

test('标题关键词和无关 raw 链接不能伪造 answerability', async (t) => {
  const repo = await fixture(t);
  const page = path.join(repo, 'wiki', 'concepts', '检索主题.md');
  await fs.writeFile(page, '---\ntitle: 检索主题\ntype: concept\nstatus: active\ncreated: 2026-08-30\nupdated: 2026-08-30\nsources:\n  - ../../raw/证据.md\ntags: []\n---\n\n# 触发条件 失败边界\n\n[证据](../../raw/证据.md)\n');
  const cases = path.join(repo, 'heading-link.jsonl');
  await fs.writeFile(cases, '{"id":"heading-link","query":"检索主题","relevant":["wiki/concepts/检索主题.md"],"answer_terms":["触发条件","失败边界"]}\n');
  const result = await evaluate({ repo, cases, limit: 3 });
  assert.equal(result.metrics.hit_at_k, 1);
  assert.equal(result.metrics.answerability_pass_rate, 0);
  assert.deepEqual(result.cases[0].answerability.grounded_terms, []);
  assert.equal(result.ok, false);
});

test('标点填充和未绑定长段落不能伪造实质 answerability', async (t) => {
  const repo = await fixture(t);
  const page = path.join(repo, 'wiki', 'concepts', '检索主题.md');
  await fs.appendFile(page, '\n触发条件 失败边界 ............................[^e]\n\n................................................................................\n\n[^e]: [证据](../../raw/证据.md)\n');
  const cases = path.join(repo, 'punctuation.jsonl');
  await fs.writeFile(cases, '{"id":"punctuation","query":"检索","relevant":["wiki/concepts/检索主题.md"],"answer_terms":["触发条件","失败边界"]}\n');
  const result = await evaluate({ repo, cases, limit: 3 });
  assert.equal(result.metrics.answerability_pass_rate, 0);
  assert.deepEqual(result.cases[0].answerability.grounded_terms, []);
  assert.equal(result.cases[0].answerability.substantive_character_count, 0);
  assert.equal(result.ok, false);
});

test('canonical/preferred 页面不在首位时显式报告导航成本并令评测失败', async (t) => {
  const repo = await fixture(t);
  const concept = path.join(repo, 'wiki', 'concepts', '检索主题.md');
  await fs.writeFile(concept, '---\ntitle: 检索主题\ntype: concept\nstatus: active\ncreated: 2026-08-30\nupdated: 2026-08-30\nsources:\n  - ../../raw/证据.md\ntags: [首位词]\n---\n\n# 检索主题\n\n可复用正文。\n');
  await fs.mkdir(path.join(repo, 'wiki', 'analyses'));
  await fs.writeFile(path.join(repo, 'wiki', 'analyses', '高匹配分析.md'), '---\ntitle: 首位词\ntype: analysis\nstatus: active\ncreated: 2026-08-30\nupdated: 2026-08-30\nsources:\n  - ../../raw/证据.md\ntags: []\n---\n\n# 首位词\n\n分析正文。\n');
  await fs.appendFile(path.join(repo, 'wiki', '索引.md'), '- [高匹配分析](analyses/高匹配分析.md) — 首位词。 Updated 2026-08-30; 1 source.\n');
  const cases = path.join(repo, 'canonical.jsonl');
  await fs.writeFile(cases, '{"id":"canonical","query":"首位词","relevant":["wiki/concepts/检索主题.md","wiki/analyses/高匹配分析.md"],"canonical":"wiki/concepts/检索主题.md"}\n');

  const result = await evaluate({ repo, cases, limit: 3 });
  assert.equal(result.metrics.hit_at_k, 1);
  assert.equal(result.canonical_navigation.case_count, 1);
  assert.equal(result.canonical_navigation.canonical_top_1_pass_rate, 0);
  assert.equal(result.canonical_navigation.mean_navigation_cost, 1);
  assert.equal(result.cases[0].canonical_navigation.canonical_top_1, false);
  assert.equal(result.cases[0].canonical_navigation.first_preferred_rank, 2);
  assert.equal(result.ok, false);
});

async function addRelevantSource(repo) {
  await fs.mkdir(path.join(repo, 'wiki', 'sources'));
  await fs.writeFile(path.join(repo, 'wiki', 'sources', '检索主题来源.md'), '---\ntitle: 检索主题来源\ntype: source\nstatus: active\ncreated: 2026-08-30\nupdated: 2026-08-30\nsources:\n  - ../../raw/证据.md\ntags: [检索, 主题]\n---\n\n# 检索主题来源\n\n来源正文记录检索主题的背景，但不会作为 task recall 的优先答案。[^e]\n\n[^e]: [证据](../../raw/证据.md)\n');
  await fs.appendFile(path.join(repo, 'wiki', '索引.md'), '- [检索主题来源](sources/检索主题来源.md) — 检索主题的原始来源。 Updated 2026-08-30; 1 source.\n');
  await fs.appendFile(path.join(repo, 'wiki', 'concepts', '检索主题.md'), '\n可执行答案说明触发条件与失败边界，包含足够的上下文、验证步骤、预期结果、异常停止条件、输入输出记录、失败原因、复现环境和回退决定，使内容能由原始证据定位并复用。[^e]\n\n[^e]: [证据](../../raw/证据.md)\n');
}

test('task mode 在 canonical 首位且可回答时不因来源页未进结果而失败', async (t) => {
  const repo = await fixture(t);
  await addRelevantSource(repo);
  const cases = path.join(repo, 'task-source-miss.jsonl');
  await fs.writeFile(cases, '{"id":"task-source-miss","query":"检索主题","relevant":["wiki/concepts/检索主题.md","wiki/sources/检索主题来源.md"],"canonical":"wiki/concepts/检索主题.md","answer_terms":["触发条件","失败边界"],"k":1}\n');

  const result = await evaluate({ repo, cases, limit: 1 });
  assert.equal(result.mode, 'task');
  assert.equal(result.metrics.hit_at_k, 1);
  assert.equal(result.metrics.coverage, 0.5);
  assert.deepEqual(result.coverage_gate, { required_case_count: 0, pass_rate: null });
  assert.equal(result.cases[0].canonical_navigation.canonical_top_1, true);
  assert.equal(result.cases[0].answerability.passed, true);
  assert.equal(result.ok, true);
});

test('source mode 显式要求完整 coverage，并将 canonical 导航保留为诊断', async (t) => {
  const repo = await fixture(t);
  await addRelevantSource(repo);
  const cases = path.join(repo, 'source-mode.jsonl');
  await fs.writeFile(cases, '{"id":"source-mode","query":"检索主题","relevant":["wiki/concepts/检索主题.md","wiki/sources/检索主题来源.md"],"canonical":"wiki/concepts/检索主题.md","answer_terms":["触发条件","失败边界"],"k":2}\n');

  const result = await evaluate({ repo, cases, limit: 2, mode: 'source' });
  assert.equal(result.metrics.coverage, 1);
  assert.deepEqual(result.coverage_gate, { required_case_count: 1, pass_rate: 1 });
  assert.equal(result.cases[0].canonical_navigation.canonical_top_1, false);
  assert.equal(result.cases[0].canonical_navigation.gate_required, false);
  assert.equal(result.ok, true);
});

test('指定 case 的 require_coverage 即使在 task mode 也会拒绝不完整来源覆盖', async (t) => {
  const repo = await fixture(t);
  await addRelevantSource(repo);
  const cases = path.join(repo, 'required-coverage.jsonl');
  await fs.writeFile(cases, '{"id":"required-coverage","query":"检索主题","relevant":["wiki/concepts/检索主题.md","wiki/sources/检索主题来源.md"],"canonical":"wiki/concepts/检索主题.md","answer_terms":["触发条件","失败边界"],"require_coverage":true,"k":1}\n');

  const result = await evaluate({ repo, cases, limit: 1 });
  assert.equal(result.metrics.coverage, 0.5);
  assert.deepEqual(result.coverage_gate, { required_case_count: 1, pass_rate: 0 });
  assert.equal(result.cases[0].coverage_required, true);
  assert.equal(result.cases[0].coverage_passed, false);
  assert.equal(result.ok, false);
});
