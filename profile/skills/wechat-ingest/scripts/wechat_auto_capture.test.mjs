import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ingestUrl, outputNameForClaim, safeMessage, verifyPromotedRequest } from './wechat_auto_capture.mjs';
import { promoteStage, stageInput } from './wechat_ingest.mjs';
import { claim, complete, enqueue, scan } from './wechat_request_queue.mjs';

async function makeRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-auto-capture-test-'));
  await fs.writeFile(path.join(root, 'AGENTS.md'), '# fixture\n');
  await fs.mkdir(path.join(root, 'wiki'));
  await fs.mkdir(path.join(root, 'raw', 'wechat'), { recursive: true });
  await fs.mkdir(path.join(root, 'staging', 'wechat'), { recursive: true });
  return root;
}

function originHtml(url, { title = '直连采集', body = '<p>正文</p>' } = {}) {
  return `<script>window.cgiDataNew = {
    base_resp: { ret: '0' * 1, errmsg: 'ok' },
    nick_name: '测试公众号',
    title: '${title}',
    content_noencode: '${body}',
    create_time: '2026-08-23 10:00',
    link: '${url}'
  };</script>`;
}

function originFetch(url, options = {}) {
  assert.equal(options.redirect, 'manual');
  assert.match(String(options.headers?.['user-agent']), /Chrome/);
  return Promise.resolve(new Response(originHtml(url), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=UTF-8' },
  }));
}

test('automatic capture failure messages redact common secrets', () => {
  const safe = safeMessage(new Error('Bearer secret MCP_TOKEN=abc123 token:xyz'));
  assert.doesNotMatch(safe, /secret|abc123|xyz/);
  assert.match(safe, /\[REDACTED\]/);
});

test('already-promoted request is reverified and declared file imports require review', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const input = path.join(repo, 'article.md');
  const canonical = 'https://mp.weixin.qq.com/s/already-promoted';
  await fs.writeFile(input, '# 已归档\n\n正文\n');
  const staged = await stageInput({ repo, url: canonical, input });
  const promoted = await promoteStage(staged.stage, repo);
  const request = {
    status: 'promoted', canonical_url: canonical,
    result: {
      raw_bundle: path.relative(repo, promoted.raw_bundle).split(path.sep).join('/'),
      bundle_checksum: promoted.bundle_checksum, content_checksum: promoted.content_checksum,
    },
  };
  const checked = await verifyPromotedRequest(repo, request);
  assert.equal(checked.capture_exercised, false);
  assert.equal(checked.source_authenticity, 'declared-only');
  assert.equal(checked.review_required, true);
  await fs.appendFile(path.join(promoted.raw_bundle, 'article.md'), 'tampered');
  await assert.rejects(() => verifyPromotedRequest(repo, request), /清单|校验和/);
});

test('each capture claim receives a distinct safe inbox output name', () => {
  const requestId = '12345678-1234-1234-1234-123456789abc';
  const first = outputNameForClaim(requestId, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  const retry = outputNameForClaim(requestId, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  assert.notEqual(first, retry);
  assert.match(first, /^12345678-1234-1234-1234-123456789abc--.*\.zip$/);
  assert.throws(() => outputNameForClaim(requestId, '...'), /claim_id/);
});

test('queued URL uses the verified origin HTTP path before the extension fallback', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const canonical = 'https://mp.weixin.qq.com/s/direct-origin';
  const result = await ingestUrl({ url: canonical, repo, fetchImpl: originFetch });
  assert.equal(result.action, 'http-captured-promoted');
  assert.equal(result.capture_exercised, true);
  assert.equal(result.source_authenticity, 'wechat-origin-response');
  assert.equal(result.review_required, false);
  assert.equal(result.request.status, 'promoted');
  assert.equal(result.capture.method, 'wechat-origin-response');
  assert.equal((await fs.readFile(path.join(result.raw_bundle, 'article.md'), 'utf8')).includes('# 直连采集'), true);
});

test('declared-only promoted request refreshes to a new immutable origin-response bundle', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const canonical = 'https://mp.weixin.qq.com/s/upgrade-origin';
  const input = path.join(repo, 'legacy.md');
  await fs.writeFile(input, '# 旧的弱溯源内容\n');
  const staged = await stageInput({ repo, url: canonical, input });
  const old = await promoteStage(staged.stage, repo);
  const oldArticle = await fs.readFile(path.join(old.raw_bundle, 'article.md'));
  const queued = await enqueue({ url: canonical, repo });
  const claimed = await claim({ id: queued.request.request_id, repo });
  await complete({
    id: queued.request.request_id,
    claimId: claimed.lock.claim_id,
    rawBundle: old.raw_bundle,
    repo,
  });

  const result = await ingestUrl({ url: canonical, repo, fetchImpl: originFetch });
  assert.equal(result.action, 'http-captured-promoted');
  assert.notEqual(result.raw_bundle, old.raw_bundle);
  assert.equal(result.source_authenticity, 'wechat-origin-response');
  assert.equal(result.request.history.length, 1);
  assert.deepEqual(await fs.readFile(path.join(old.raw_bundle, 'article.md')), oldArticle);
});

test('origin and extension failures are both sanitized and release the exact claim', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const canonical = 'https://mp.weixin.qq.com/s/both-fail';
  await assert.rejects(
    () => ingestUrl({
      url: canonical,
      repo,
      fetchImpl: async () => new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      captureImpl: async () => { throw new Error('bridge token=super-secret'); },
    }),
    /super-secret/,
  );
  const health = await scan({ repo });
  assert.equal(health.capture_lock, null);
  assert.equal(health.by_status.failed, 1);
  assert.match(health.requests[0].failure.message, /direct HTTP failed.*extension fallback failed/);
  assert.doesNotMatch(health.requests[0].failure.message, /super-secret/);
});
