import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULT_MAX_BYTES, ingestSession, verifyBundle } from './session_ingest.mjs';

const roots = [];
async function repo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ingest-test-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'AGENTS.md'), '# fixture\n');
  await fs.mkdir(path.join(root, 'wiki'));
  return root;
}
async function externalFile(name, bytes) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ingest-input-'));
  roots.push(root);
  const file = path.join(root, name);
  await fs.writeFile(file, bytes);
  return file;
}
function options(root, input, overrides = {}) {
  return {
    repo: root,
    input,
    sourceApp: 'Claude Code',
    title: '结对调试会话',
    occurredAt: '2026-08-30T09:15:00+08:00',
    origin: 'user-provided',
    ...overrides,
  };
}
function digest(bytes) { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }

test('摄取显式 JSONL 会话，原始字节和 checksum 均可复验', async () => {
  const root = await repo();
  const bytes = Buffer.from('{"type":"user","text":"保留原始字节"}\n\xff\x00', 'binary');
  const input = await externalFile('conversation.jsonl', bytes);
  const result = await ingestSession(options(root, input));
  assert.equal(result.ok, true);
  assert.equal(result.state, 'promoted');
  assert.match(result.raw_bundle, /raw[\\/]sessions[\\/]2026-08-30--结对调试会话--[a-f0-9]{8}$/);
  assert.deepEqual(await fs.readFile(path.join(result.raw_bundle, 'session.jsonl')), bytes);
  const manifest = JSON.parse(await fs.readFile(result.manifest, 'utf8'));
  assert.equal(manifest.files.find((item) => item.path === 'session.jsonl').sha256, digest(bytes));
  assert.match(await fs.readFile(path.join(result.raw_bundle, 'article.md'), 'utf8'), /不复制会话全文/);
  const verified = await verifyBundle(result.raw_bundle, root);
  assert.equal(verified.state, 'verified');
  assert.equal(verified.bundle_checksum, result.bundle_checksum);
});

test('相同明确输入是 duplicate-noop，且不覆盖既有 manifest', async () => {
  const root = await repo();
  const input = await externalFile('session.md', '# 一次会话\n');
  const first = await ingestSession(options(root, input));
  const before = await fs.readFile(first.manifest, 'utf8');
  const second = await ingestSession(options(root, input));
  assert.equal(second.state, 'duplicate-noop');
  assert.equal(second.raw_bundle, first.raw_bundle);
  assert.equal(await fs.readFile(first.manifest, 'utf8'), before);
});

test('拒绝符号链接输入和输入目录', async () => {
  const root = await repo();
  const input = await externalFile('actual.txt', 'secret');
  const links = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ingest-links-'));
  roots.push(links);
  const link = path.join(links, 'linked.txt');
  await fs.symlink(input, link);
  await assert.rejects(() => ingestSession(options(root, link)), /不是普通文件/);
  await assert.rejects(() => ingestSession(options(root, links)), /仅支持|不是普通文件/);
});

test('默认和显式大小上限都会 fail-closed', async () => {
  const root = await repo();
  const input = await externalFile('large.txt', Buffer.alloc(DEFAULT_MAX_BYTES + 1));
  await assert.rejects(() => ingestSession(options(root, input)), /字节上限/);
  const small = await externalFile('small.txt', '12345');
  await assert.rejects(() => ingestSession(options(root, small, { maxBytes: '4' })), /字节上限/);
});

test('可选脱敏规则只影响派生元数据，绝不改写原始会话', async () => {
  const root = await repo();
  const bytes = Buffer.from('token-1234 remains in immutable raw');
  const input = await externalFile('session.txt', bytes);
  const patterns = await externalFile('patterns.txt', 'token-[0-9]+');
  const result = await ingestSession(options(root, input, { title: 'token-1234 标题', redactPatternFile: patterns }));
  const article = await fs.readFile(path.join(result.raw_bundle, 'article.md'), 'utf8');
  assert.doesNotMatch(article, /token-1234/);
  assert.deepEqual(await fs.readFile(path.join(result.raw_bundle, 'session.txt')), bytes);
  const manifest = JSON.parse(await fs.readFile(result.manifest, 'utf8'));
  assert.equal(manifest.capture.redaction.requested, true);
  assert.equal(manifest.capture.redaction.pattern_count, 1);
});

test('拒绝无效日期、来源应用和来源值', async () => {
  const root = await repo();
  const input = await externalFile('session.txt', 'plain');
  await assert.rejects(() => ingestSession(options(root, input, { occurredAt: 'tomorrow' })), /occurred-at/);
  await assert.rejects(() => ingestSession(options(root, input, { sourceApp: 'evil/app' })), /source-app/);
  await assert.rejects(() => ingestSession(options(root, input, { origin: 'javascript:alert(1)' })), /origin/);
});

test('verify 检出清单和 bundle checksum 篡改', async () => {
  const root = await repo();
  const input = await externalFile('session.json', '{"messages":[]}');
  const result = await ingestSession(options(root, input));
  await fs.appendFile(path.join(result.raw_bundle, 'session.json'), 'x');
  await assert.rejects(() => verifyBundle(result.raw_bundle, root), /文件清单|内容校验/);
});

test.after(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
});
