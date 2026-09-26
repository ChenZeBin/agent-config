import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildConsumptionContext } from './wiki_consume.mjs';

test('builds a read-only consumption context from a grounded source page', (t) => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'wiki-consume-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(path.join(repo, 'wiki', 'sources'), { recursive: true });
  mkdirSync(path.join(repo, 'wiki', 'concepts'), { recursive: true });
  mkdirSync(path.join(repo, 'raw'), { recursive: true });
  writeFileSync(path.join(repo, 'AGENTS.md'), '# fixture\n');
  writeFileSync(path.join(repo, 'raw', 'source.md'), '# raw\n');
  writeFileSync(path.join(repo, 'raw', 'other.md'), '# other raw\n');
  writeFileSync(path.join(repo, 'raw', 'other-2.md'), '# other raw 2\n');
  writeFileSync(path.join(repo, 'raw', 'other-3.md'), '# other raw 3\n');
  writeFileSync(path.join(repo, 'wiki', 'sources', '来源.md'), `---\ntitle: 个人知识管理\ntype: source\nstatus: active\ncreated: 2026-08-30\nupdated: 2026-08-30\nsources:\n  - ../../raw/source.md\ntags: []\n---\n\n内容\n`);
  writeFileSync(path.join(repo, 'wiki', 'concepts', '个人知识管理.md'), `---\ntitle: 个人知识管理方法\ntype: concept\nstatus: active\ncreated: 2026-08-30\nupdated: 2026-08-30\nsources:\n  - ../../raw/source.md\ntags: []\n---\n\n个人知识管理\n`);
  writeFileSync(path.join(repo, 'wiki', 'concepts', '不同来源的知识管理.md'), `---\ntitle: 个人知识管理的不同来源\ntype: concept\nstatus: active\ncreated: 2026-08-30\nupdated: 2026-08-30\nsources:\n  - ../../raw/other.md\ntags: []\n---\n\n个人知识管理\n`);
  writeFileSync(path.join(repo, 'wiki', 'concepts', '不同来源的知识管理二.md'), `---\ntitle: 个人知识管理的另一来源\ntype: concept\nstatus: active\ncreated: 2026-08-30\nupdated: 2026-08-30\nsources:\n  - ../../raw/other-2.md\ntags: []\n---\n\n个人知识管理\n`);
  writeFileSync(path.join(repo, 'wiki', 'concepts', '不同来源的知识管理三.md'), `---\ntitle: 个人知识管理的第三来源\ntype: concept\nstatus: active\ncreated: 2026-08-30\nupdated: 2026-08-30\nsources:\n  - ../../raw/other-3.md\ntags: []\n---\n\n个人知识管理\n`);
  writeFileSync(path.join(repo, 'wiki', '索引.md'), '# Wiki Index\n');
  writeFileSync(path.join(repo, 'wiki', '日志.md'), '# Log\n');

  const result = buildConsumptionContext({ repo, sourcePage: 'wiki/sources/来源.md', relatedLimit: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.title, '个人知识管理');
  assert.equal(result.raw_sources.length, 1);
  assert.equal(result.durable_write_authorized, false);
  assert.deepEqual(result.source_lineages, ['raw/source.md']);
  assert.equal(result.response_contract.required_sections.new_ideas.min_items, 3);
  assert.equal(result.response_contract.required_sections.new_ideas.max_items, 5);
  assert.equal(result.response_contract.required_sections.connections.min_items, 0);
  assert.equal(result.response_contract.required_sections.connections.allow_explicit_none, true);
  assert.equal(result.response_contract.required_sections.feynman_questions.exact_items, 3);
  assert.equal(result.response_contract.version, '1.1');
  assert.equal(result.response_contract.presentation.language, 'zh-CN');
  assert.equal(result.response_contract.presentation.headings.connections, '与已有知识的联系');
  assert.equal(result.response_contract.presentation.style.lead_with_conclusion, true);
  assert.equal(result.response_contract.presentation.style.max_sentences_per_item, 2);
  assert.equal(result.response_contract.presentation.style.explain_unfamiliar_technical_terms_on_first_use, true);
  assert.equal(result.response_contract.presentation.style.no_internal_identifiers_in_user_headings, true);
  assert.equal(result.response_contract.presentation.style.do_not_emit_absolute_local_paths, true);
  assert.equal(
    result.response_contract.presentation.relationship_display.lexical_recall,
    '只是文字相似，尚未证实相关',
  );
  assert.equal(
    result.response_contract.presentation.persistence_display['proposal-only'],
    '仅提出保存建议，等待用户授权',
  );
  assert.equal(result.response_contract.quality_evaluation.single_readability_score_is_not_sufficient, true);
  assert.equal(result.response_contract.durable_write_candidate.decision_exact_items, 1);
  assert.deepEqual(result.response_contract.durable_write_candidate.allowed_decisions, ['no-durable-value', 'proposal-only']);
  assert.equal(result.response_contract.durable_write_candidate.max_items, 1);
  assert.equal(result.response_contract.durable_write_candidate.user_authorization_required, true);
  assert.equal(result.response_contract.durable_write_candidate.durable_write_authorized, false);

  const shared = result.related.find((item) => item.path === 'wiki/concepts/个人知识管理.md');
  const lexical = result.related.find((item) => item.path === 'wiki/concepts/不同来源的知识管理.md');
  assert.equal(shared.relationship, 'shared_source_lineage');
  assert.equal(shared.relationship_label, '来自同一份原始材料');
  assert.deepEqual(shared.shared_source_lineages, ['raw/source.md']);
  assert.equal(shared.noise_risk, 'low');
  assert.equal(shared.noise_risk_label, '误关联风险较低');
  assert.equal(lexical.relationship, 'lexical_recall');
  assert.equal(lexical.relationship_label, '只是文字相似，尚未证实相关');
  assert.deepEqual(lexical.shared_source_lineages, []);
  assert.equal(lexical.noise_risk, 'high');
  assert.equal(lexical.noise_risk_label, '误关联风险较高，需先核实');
  assert.equal(result.related.filter((item) => item.relationship === 'lexical_recall').length, 2);
});

test('rejects an ungrounded source page', (t) => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'wiki-consume-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(path.join(repo, 'wiki', 'sources'), { recursive: true });
  mkdirSync(path.join(repo, 'raw'), { recursive: true });
  writeFileSync(path.join(repo, 'AGENTS.md'), '# fixture\n');
  writeFileSync(path.join(repo, 'wiki', 'sources', '来源.md'), `---\ntitle: 无依据\ntype: draft\nstatus: draft\ncreated: 2026-08-30\nupdated: 2026-08-30\nsources: []\ntags: []\n---\n`);
  assert.throws(() => buildConsumptionContext({ repo, sourcePage: 'wiki/sources/来源.md' }), /no raw sources/);
});

test('rejects raw sources that escape raw or are symbolic links', (t) => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'wiki-consume-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(path.join(repo, 'wiki', 'sources'), { recursive: true });
  mkdirSync(path.join(repo, 'raw'), { recursive: true });
  writeFileSync(path.join(repo, 'AGENTS.md'), '# fixture\n');
  writeFileSync(path.join(repo, 'outside.md'), '# outside\n');
  writeFileSync(path.join(repo, 'wiki', 'sources', '越界.md'), `---\ntitle: 越界\nsources:\n  - ../../outside.md\n---\n`);
  assert.throws(() => buildConsumptionContext({ repo, sourcePage: 'wiki/sources/越界.md' }), /source escapes raw/);

  symlinkSync(path.join(repo, 'outside.md'), path.join(repo, 'raw', '链接.md'));
  writeFileSync(path.join(repo, 'wiki', 'sources', '链接.md'), `---\ntitle: 链接\nsources:\n  - ../../raw/链接.md\n---\n`);
  assert.throws(() => buildConsumptionContext({ repo, sourcePage: 'wiki/sources/链接.md' }), /raw source must be a regular file/);
});
