import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateLearningResponse } from './wiki_consume_validate.mjs';

const scriptPath = fileURLToPath(new URL('./wiki_consume_validate.mjs', import.meta.url));

function validResponse({ connections, gaps, persistence = '仅提出保存建议，等待用户授权（proposal-only）：建议候选页为“示例主题”，依据为本次 raw/证据.md。' } = {}) {
  return `本次材料提供了可复用的检查规则，值得在下一次摄取中按同一结构复核。

## 新发现

- 新发现一来自 [原始证据](../../raw/证据一.md)。
- 新发现二来自 raw/证据二.md 的第 2 节。
- 新发现三来自 raw/证据三.md 的时间戳 00:01。

## 与已有知识的联系

${connections ?? '- 来自同一份原始材料：与既有“检查规则”页面相连，因为两者都要求保留 raw/ 证据定位。'}

## 矛盾与证据缺口

${gaps ?? '- 还需要核对 raw/证据一.md 的原始上下文。'}

## 对后续工作的影响

- 在下一次交付前逐项检查 raw/ 定位是否存在。

## 费曼式自测问题

- 为什么每个新发现都需要 raw/ 定位？
- 无法找到可靠关联时应该怎样表达？
- 为什么保存候选仍需用户授权？

## 是否值得长期保存

${persistence}
`;
}

function errorCodes(result) {
  return new Set(result.errors.map((entry) => entry.code));
}

test('完整好例通过并返回保存决定和章节计数', () => {
  const result = validateLearningResponse(validResponse());
  assert.equal(result.ok, true);
  assert.equal(result.persistence_decision, 'proposal-only');
  assert.deepEqual(result.section_counts, {
    新发现: 3,
    与已有知识的联系: 1,
    矛盾与证据缺口: 1,
    对后续工作的影响: 1,
    费曼式自测问题: 3,
    是否值得长期保存: 1,
  });
});

test('允许精确的无关联和无缺口句', () => {
  const result = validateLearningResponse(validResponse({
    connections: '没有找到可靠的已有知识关联。',
    gaps: '没有发现需要补充说明的矛盾或证据缺口。',
    persistence: '不建议长期保存（no-durable-value）',
  }));
  assert.equal(result.ok, true);
  assert.equal(result.section_counts['与已有知识的联系'], 0);
  assert.equal(result.section_counts['矛盾与证据缺口'], 0);
  assert.equal(result.persistence_decision, 'no-durable-value');
});

test('缺少首段结论会失败', () => {
  const result = validateLearningResponse(validResponse().replace(/^.*\n\n/, ''));
  assert.ok(errorCodes(result).has('missing-conclusion'));
});

test('章节乱序、重复和缺失会失败', () => {
  const reordered = validResponse()
    .replace('## 新发现', '## 临时标题')
    .replace('## 与已有知识的联系', '## 新发现')
    .replace('## 矛盾与证据缺口', '## 新发现');
  const result = validateLearningResponse(reordered);
  const codes = errorCodes(result);
  assert.ok(codes.has('missing-section'));
  assert.ok(codes.has('duplicate-section'));
  assert.ok(codes.has('unexpected-section'));
  assert.ok(codes.has('section-order'));
});

test('新发现项目数和 raw locator 均受约束', () => {
  const tooFew = validResponse().replace('- 新发现三来自 raw/证据三.md 的时间戳 00:01。\n', '');
  const tooFewResult = validateLearningResponse(tooFew);
  assert.ok(errorCodes(tooFewResult).has('new-discovery-count'));

  const missingLocator = validResponse().replace('新发现二来自 raw/证据二.md 的第 2 节。', '新发现二没有可用定位。');
  assert.ok(errorCodes(validateLearningResponse(missingLocator)).has('missing-raw-locator'));
});

test('费曼问题必须恰好三个', () => {
  const result = validateLearningResponse(validResponse().replace('- 为什么保存候选仍需用户授权？\n', ''));
  assert.ok(errorCodes(result).has('feynman-question-count'));
});

test('双保存决定、绝对路径和内部枚举会失败', () => {
  const doubleDecision = validResponse({ persistence: 'no-durable-value；proposal-only' });
  assert.ok(errorCodes(validateLearningResponse(doubleDecision)).has('persistence-decision-count'));

  const absolutePath = validResponse().replace('raw/证据二.md', '/Users/example/raw/证据二.md');
  assert.ok(errorCodes(validateLearningResponse(absolutePath)).has('absolute-users-path'));

  const internal = validResponse().replace('本次材料', '本次材料 shared_source_lineage lexical_recall noise_risk durable_write_authorized');
  const internalCodes = validateLearningResponse(internal).errors.filter((entry) => entry.code === 'internal-enumeration');
  assert.equal(internalCodes.length, 4);
});

test('联系和保存决定必须先使用面向读者的中文说明', () => {
  const missingRelationshipLabel = validResponse({
    connections: '- 与既有“检查规则”页面相连。',
  });
  assert.ok(errorCodes(validateLearningResponse(missingRelationshipLabel)).has('missing-relationship-label'));

  const barePersistence = validResponse({ persistence: 'proposal-only' });
  assert.ok(errorCodes(validateLearningResponse(barePersistence)).has('missing-persistence-display'));
});

test('黑话和长项目只产生 warning，不会判失败', () => {
  const response = validResponse()
    .replace('新发现一来自', '赋能抓手沉淀范式闭环颗粒度。第一句。第二句。第三句。新发现一来自');
  const result = validateLearningResponse(response);
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.ok(result.warnings.some((entry) => entry.code === 'vague-term'));
  assert.ok(result.warnings.some((entry) => entry.code === 'long-item'));
});

test('CLI 拒绝符号链接响应文件', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'wiki-consume-validate-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'response.md');
  const link = path.join(directory, 'response-link.md');
  writeFileSync(target, validResponse());
  symlinkSync(target, link);
  const cli = spawnSync(process.execPath, [scriptPath, '--response', link], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  const result = JSON.parse(cli.stdout);
  assert.equal(result.ok, false);
  assert.match(result.error, /regular non-symbolic-link file/);
});
