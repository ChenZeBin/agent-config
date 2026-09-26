import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { promoteStage, stageInput } from './wechat_ingest.mjs';
import { claimNextBundle, releaseCompileLock, scanCompileQueue } from './wechat_compile_queue.mjs';

async function makeRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-compile-queue-test-'));
  await fs.writeFile(path.join(root, 'AGENTS.md'), '# fixture\n');
  await fs.mkdir(path.join(root, 'wiki', 'sources'), { recursive: true });
  await fs.writeFile(path.join(root, 'wiki', '索引.md'), '# Index\n');
  await fs.writeFile(path.join(root, 'wiki', '日志.md'), '# Log\n');
  await fs.mkdir(path.join(root, 'raw', 'wechat'), { recursive: true });
  await fs.mkdir(path.join(root, 'staging', 'wechat'), { recursive: true });
  return root;
}

async function addBundle(repo, suffix = '1') {
  const input = path.join(repo, `article-${suffix}.md`);
  await fs.writeFile(input, `# Queue article ${suffix}\n\nFixture body ${suffix}.\n`);
  const staged = await stageInput({
    repo,
    url: `https://mp.weixin.qq.com/s?__biz=queue&mid=${suffix}`,
    input,
    publishedAt: '2026-08-16',
  });
  return await promoteStage(staged.stage, repo);
}

async function markConsistent(repo, bundle) {
  const relativeManifest = path.relative(path.join(repo, 'wiki', 'sources'), bundle.manifest).split(path.sep).join('/');
  const relativeArticle = path.relative(path.join(repo, 'wiki', 'sources'), bundle.article).split(path.sep).join('/');
  await fs.writeFile(path.join(repo, 'wiki', 'sources', 'queue.md'), `---\ntitle: Queue\ntype: source\nstatus: active\ncreated: 2026-08-16\nupdated: 2026-08-16\nsources:\n  - ${relativeArticle}\ntags: []\nprovenance:\n  raw_manifest: ${relativeManifest}\n  raw_checksum: ${bundle.bundle_checksum}\n---\n`);
  const logRelative = path.relative(repo, bundle.manifest).split(path.sep).join('/');
  await fs.appendFile(path.join(repo, 'wiki', '日志.md'), `\n## [2026-08-16] ingest | Queue article\n\n- Raw: \`${logRelative}\` (\`${bundle.bundle_checksum}\`)\n- Wiki: created \`wiki/sources/queue.md\`\n- Notes: fixture\n`);
}

test('consistent raw bundle produces NO_ACTION and releases its lock', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const bundle = await addBundle(repo);
  await markConsistent(repo, bundle);
  const result = await claimNextBundle(repo);
  assert.equal(result.action, 'no-action');
  assert.equal(result.lock_released, true);
  assert.equal(result.bundles[0].state, 'consistent');
  await assert.rejects(() => releaseCompileLock(repo, 'anything'), /没有可释放/);
});

test('unreferenced verified bundle is pending and only one bundle is claimed', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const first = await addBundle(repo, '1');
  await addBundle(repo, '2');
  const result = await claimNextBundle(repo);
  assert.equal(result.action, 'claimed');
  assert.equal(result.pending_count, 2);
  assert.equal(result.candidate.manifest, first.manifest);
  await releaseCompileLock(repo, result.lock.claim_id);
});

test('partial source/log bookkeeping stops for review and retains the lock', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const bundle = await addBundle(repo);
  const relativeManifest = path.relative(path.join(repo, 'wiki', 'sources'), bundle.manifest).split(path.sep).join('/');
  await fs.writeFile(path.join(repo, 'wiki', 'sources', 'partial.md'), `---\ntitle: Partial\nraw_manifest: ${relativeManifest}\nraw_checksum: ${bundle.bundle_checksum}\n---\n`);
  const result = await claimNextBundle(repo);
  assert.equal(result.action, 'needs-review');
  assert.equal(result.ok, false);
  assert.equal(result.lock_retained, true);
  assert.equal(result.needs_review[0].state, 'needs-review');
  assert.match(result.needs_review[0].reasons.join(','), /ingest-log-count:0/);
  await releaseCompileLock(repo, result.lock.claim_id);
  const scan = await scanCompileQueue(repo);
  assert.equal(scan.ok, false);
  assert.equal(scan.ready_for_claim, false);
});

test('an article source reference without provenance is needs-review, not pending', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const bundle = await addBundle(repo);
  const relativeArticle = path.relative(path.join(repo, 'wiki', 'sources'), bundle.article).split(path.sep).join('/');
  await fs.writeFile(path.join(repo, 'wiki', 'sources', 'interrupted.md'), `---\ntitle: Interrupted\nsources:\n  - ${relativeArticle}\n---\n`);
  const scan = await scanCompileQueue(repo);
  assert.equal(scan.pending.length, 0);
  assert.equal(scan.needs_review.length, 1);
  assert.match(scan.needs_review[0].reasons.join(','), /source-page-count:0/);
});

test('concurrent claim observes the existing lock without taking it', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await addBundle(repo);
  const first = await claimNextBundle(repo);
  const second = await claimNextBundle(repo);
  assert.equal(first.action, 'claimed');
  assert.equal(second.action, 'locked');
  assert.equal(second.lock.claim_id, first.lock.claim_id);
  await releaseCompileLock(repo, first.lock.claim_id);
});

test('tampered raw bundle is an integrity failure and retains the lock', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const bundle = await addBundle(repo);
  await fs.appendFile(bundle.article, '\nTampered.\n');
  const result = await claimNextBundle(repo);
  assert.equal(result.action, 'integrity-failure');
  assert.equal(result.lock_retained, true);
  assert.equal(result.integrity_failures.length, 1);
  await releaseCompileLock(repo, result.lock.claim_id);
});

test('a raw bundle directory without manifest is an integrity failure, not silently skipped', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, 'raw', 'wechat', 'incomplete-bundle'));
  await fs.writeFile(path.join(repo, 'raw', 'wechat', 'incomplete-bundle', 'article.md'), '# Incomplete\n');
  const result = await claimNextBundle(repo);
  assert.equal(result.action, 'integrity-failure');
  assert.equal(result.ok, false);
  assert.match(result.integrity_failures[0].error, /manifest/);
  await releaseCompileLock(repo, result.lock.claim_id);
});

test('a hidden raw entry other than .gitkeep is an integrity failure', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, 'raw', 'wechat', '.gitkeep'), '');
  await fs.writeFile(path.join(repo, 'raw', 'wechat', '.unexpected'), 'hidden');
  const scan = await scanCompileQueue(repo);
  assert.equal(scan.ok, false);
  assert.match(scan.integrity_failures[0].error, /raw\/wechat/);
});

test('scan is read-only and classifies an empty inbox', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const scan = await scanCompileQueue(repo);
  assert.equal(scan.ok, true);
  assert.deepEqual(scan.pending, []);
  assert.deepEqual(scan.needs_review, []);
});
