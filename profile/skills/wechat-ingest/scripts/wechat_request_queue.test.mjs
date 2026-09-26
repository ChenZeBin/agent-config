import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { promoteStage, stageInput } from './wechat_ingest.mjs';
import {
  claim,
  complete,
  enqueue,
  failRequest,
  recoverLock,
  refreshPromoted,
  retry,
  scan,
} from './wechat_request_queue.mjs';

async function makeRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-request-queue-test-'));
  await fs.writeFile(path.join(root, 'AGENTS.md'), '# fixture\n');
  await fs.mkdir(path.join(root, 'wiki'));
  await fs.mkdir(path.join(root, 'raw', 'wechat'), { recursive: true });
  await fs.mkdir(path.join(root, 'staging', 'wechat'), { recursive: true });
  return root;
}

async function promoteFixture(repo, url, suffix = 'fixture') {
  const article = path.join(repo, `${suffix}.md`);
  await fs.writeFile(article, `# ${suffix}\n\n正文。\n`);
  const staged = await stageInput({ repo, url, input: article, publishedAt: '2026-08-16' });
  return await promoteStage(staged.stage, repo);
}

async function treeDigest(root) {
  const hash = createHash('sha256');
  async function walk(current, relative = '') {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = path.join(relative, entry.name);
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute, rel);
      else if (entry.isFile()) {
        hash.update(rel);
        hash.update(await fs.readFile(absolute));
      }
    }
  }
  await walk(root);
  return hash.digest('hex');
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('enqueue normalizes URL and deduplicates concurrent submissions into one job', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const variants = Array.from({ length: 12 }, (_, index) =>
    `https://mp.weixin.qq.com/s?mid=11&__biz=queue&utm_source=phone-${index}#fragment`);
  const results = await Promise.all(variants.map((url) => enqueue({ repo, url })));
  const ids = new Set(results.filter((result) => result.request).map((result) => result.request.request_id));
  assert.equal(ids.size, 1);
  assert.deepEqual(new Set(results.map((result) => result.action)), new Set(['queued', 'duplicate']));
  const status = await scan({ repo });
  assert.equal(status.ok, true);
  assert.equal(status.requests.length, 1);
  assert.equal(status.requests[0].status, 'queued');
  assert.equal(await fs.readdir(path.join(repo, 'raw', 'wechat')).then((items) => items.length), 0);
});

test('enforces HTTPS WeChat URLs and fails closed on a symlinked queue root', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await assert.rejects(() => enqueue({ repo, url: 'http://mp.weixin.qq.com/s?mid=1' }), /https/);
  await assert.rejects(() => enqueue({ repo, url: 'https://example.com/s' }), /mp.weixin.qq.com/);
  await assert.rejects(() => enqueue({ repo, url: 'https://user:pass@mp.weixin.qq.com/s?mid=1' }), /凭据/);
  await assert.rejects(() => enqueue({ repo, url: 'https://mp.weixin.qq.com/' }), /文章链接/);
  await fs.mkdir(path.join(repo, 'outside'));
  await fs.rm(path.join(repo, 'staging', 'requests'), { recursive: true });
  await fs.symlink(path.join(repo, 'outside'), path.join(repo, 'staging', 'requests'));
  await assert.rejects(() => enqueue({ repo, url: 'https://mp.weixin.qq.com/s?mid=2' }), /请求队列目录.*普通目录/);
});

test('refuses a staging parent writable by another uid boundary', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  if (process.platform === 'win32') return;
  await fs.chmod(path.join(repo, 'staging'), 0o777);
  await assert.rejects(
    () => enqueue({ repo, url: 'https://mp.weixin.qq.com/s/unsafe-parent' }),
    /staging 目录不得对 group\/other 开放写权限/,
  );
});

test('claim, failure redaction, explicit retry, and verified completion preserve raw bytes', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const url = 'https://mp.weixin.qq.com/s?__biz=queue&mid=3';
  const queued = await enqueue({ repo, url });
  const id = queued.request.request_id;

  const firstClaim = await claim({ repo });
  assert.equal(firstClaim.action, 'claimed');
  assert.equal(firstClaim.request.status, 'capturing');
  assert.equal((await claim({ repo })).action, 'locked');
  const failed = await failRequest({
    repo,
    id,
    claimId: firstClaim.lock.claim_id,
    code: 'bridge-unavailable',
    message: 'WECHATSYNC_TOKEN=super-secret Bearer another-secret',
  });
  assert.equal(failed.action, 'failed');
  assert.match(failed.request.failure.message, /REDACTED/);
  assert.doesNotMatch(failed.request.failure.message, /super-secret|another-secret/);

  const retried = await retry({ repo, id });
  assert.equal(retried.action, 'retried');
  assert.equal(retried.request.history.at(-1).event, 'failed-retry');
  assert.equal(retried.request.history.at(-1).failure.code, 'bridge-unavailable');
  const secondClaim = await claim({ repo });
  assert.equal(secondClaim.action, 'claimed');
  const raw = await promoteFixture(repo, url, 'complete-fixture');
  const rawBefore = await treeDigest(raw.raw_bundle);
  const completed = await complete({ repo, id, claimId: secondClaim.lock.claim_id, rawBundle: raw.raw_bundle });
  assert.equal(completed.action, 'promoted');
  assert.equal(completed.request.status, 'promoted');
  assert.equal(await treeDigest(raw.raw_bundle), rawBefore);
  assert.equal((await scan({ repo })).by_status.promoted, 1);
});

test('an explicitly resubmitted declared-only promoted request can refresh without losing audit history', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const url = 'https://mp.weixin.qq.com/s/refresh-unverified';
  const queued = await enqueue({ repo, url });
  const claimed = await claim({ repo, id: queued.request.request_id });
  const raw = await promoteFixture(repo, url, 'refresh-fixture');
  await complete({ repo, id: queued.request.request_id, claimId: claimed.lock.claim_id, rawBundle: raw.raw_bundle });
  await assert.rejects(
    () => refreshPromoted({ repo, id: queued.request.request_id, ack: 'wrong' }),
    /refresh-unverified-promoted/,
  );
  const refreshed = await refreshPromoted({
    repo,
    id: queued.request.request_id,
    ack: 'refresh-unverified-promoted',
  });
  assert.equal(refreshed.action, 'refreshed');
  assert.equal(refreshed.request.status, 'queued');
  assert.equal(refreshed.request.history.at(-1).event, 'promoted-authenticity-refresh');
  assert.equal(refreshed.request.history.at(-1).previous_result.bundle_checksum, raw.bundle_checksum);
  assert.equal((await claim({ repo, id: queued.request.request_id })).action, 'claimed');
});

test('claim --id selects the submitted mobile request without skipping an older queued URL', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const older = await enqueue({ repo, url: 'https://mp.weixin.qq.com/s/older' });
  const mobile = await enqueue({ repo, url: 'https://mp.weixin.qq.com/s/mobile' });
  const selected = await claim({ repo, id: mobile.request.request_id });
  assert.equal(selected.action, 'claimed');
  assert.equal(selected.request.request_id, mobile.request.request_id);
  const report = await scan({ repo });
  assert.equal(report.requests.find((item) => item.request_id === older.request.request_id).status, 'queued');
  await failRequest({
    repo,
    id: mobile.request.request_id,
    claimId: selected.lock.claim_id,
    code: 'test-stop',
    message: 'fixture stopped after targeted claim',
  });
});

test('complete refuses the wrong claim or a different verified raw URL and retains capture state', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const url = 'https://mp.weixin.qq.com/s?__biz=queue&mid=4';
  const otherUrl = 'https://mp.weixin.qq.com/s?__biz=queue&mid=other';
  const queued = await enqueue({ repo, url });
  const claimed = await claim({ repo });
  const raw = await promoteFixture(repo, otherUrl, 'other-fixture');
  await assert.rejects(
    () => complete({ repo, id: queued.request.request_id, claimId: 'not-the-owner', rawBundle: raw.raw_bundle }),
    /claim-id/,
  );
  await assert.rejects(
    () => complete({ repo, id: queued.request.request_id, claimId: claimed.lock.claim_id, rawBundle: raw.raw_bundle }),
    /URL 不匹配/,
  );
  const after = (await scan({ repo })).requests[0];
  assert.equal(after.status, 'capturing');
  assert.equal(after.claim.claim_id, claimed.lock.claim_id);
  await failRequest({ repo, id: after.request_id, claimId: claimed.lock.claim_id, code: 'wrong-source', message: 'operator cancelled' });
});

test('reports an orphan capture lock and requires exact, explicit owner recovery', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const requests = path.join(repo, 'staging', 'requests');
  const queued = await enqueue({ repo, url: 'https://mp.weixin.qq.com/s/orphan-capture' });
  const locks = path.join(requests, '.locks', 'capture.lock');
  await fs.writeFile(locks, JSON.stringify({
    claim_id: 'stale-claim',
    request_id: queued.request.request_id,
    acquired_at: '2026-08-16T00:00:00.000Z',
  }));
  await fs.writeFile(path.join(requests, 'not-a-uuid.json'), '{bad json');
  const report = await scan({ repo });
  assert.equal(report.ok, false);
  assert.equal(report.capture_lock.claim_id, 'stale-claim');
  const locked = await claim({ repo });
  assert.equal(locked.action, 'invalid-queue');
  await fs.access(locks, fsConstants.F_OK);
  await assert.rejects(
    () => recoverLock({ repo, lock: 'capture.lock', claimId: 'wrong', ack: 'reviewed-owner-not-running' }),
    /owner 不匹配/,
  );
  const recovered = await recoverLock({
    repo,
    lock: 'capture.lock',
    claimId: 'stale-claim',
    ack: 'reviewed-owner-not-running',
  });
  assert.equal(recovered.action, 'lock-recovered');
  await fs.unlink(path.join(requests, 'not-a-uuid.json'));
  assert.equal((await scan({ repo })).ok, true);
});

test('recover fences a claim paused between publishing its capture lock and changing job state', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const queued = await enqueue({ repo, url: 'https://mp.weixin.qq.com/s/recover-race' });
  const entered = deferred();
  const resume = deferred();
  const claiming = claim({
    repo,
    id: queued.request.request_id,
    beforeTransition: async (owner) => {
      entered.resolve(owner);
      await resume.promise;
    },
  });
  const owner = await entered.promise;
  let recovered;
  try {
    recovered = await recoverLock({
      repo,
      lock: 'capture.lock',
      claimId: owner.claim_id,
      ack: 'reviewed-owner-not-running',
    });
  } finally {
    resume.resolve();
  }
  const fenced = await claiming;
  assert.equal(recovered.action, 'lock-recovered');
  assert.equal(fenced.action, 'failed');
  assert.equal(fenced.lock_retained, false);
  const report = await scan({ repo });
  assert.equal(report.ok, true);
  assert.equal(report.requests[0].status, 'queued');

  const claimed = await claim({ repo, id: queued.request.request_id });
  assert.equal(claimed.action, 'claimed');
  await failRequest({
    repo,
    id: queued.request.request_id,
    claimId: claimed.lock.claim_id,
    code: 'test-stop',
    message: 'race fixture completed',
  });
});

test('recovers a missing dedupe marker and rejects every unknown queue entry', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const url = 'https://mp.weixin.qq.com/s/orphan-marker?utm_source=phone';
  const first = await enqueue({ repo, url });
  const requests = path.join(repo, 'staging', 'requests');
  const markerName = `${first.request.idempotency_key.slice('sha256:'.length)}.json`;
  await fs.unlink(path.join(requests, '.dedupe', markerName));

  const repairable = await scan({ repo });
  assert.equal(repairable.ok, true);
  assert.match(JSON.stringify(repairable.warnings), /缺少去重记录/);

  const recovered = await enqueue({ repo, url });
  assert.equal(recovered.action, 'duplicate-recovered');
  assert.equal(recovered.request.request_id, first.request.request_id);
  assert.equal((await scan({ repo })).ok, true);

  await fs.writeFile(path.join(requests, '.unexpected'), 'must not be ignored');
  const invalid = await scan({ repo });
  assert.equal(invalid.ok, false);
  assert.match(JSON.stringify(invalid.failures), /未知或非普通条目/);
  const blocked = await claim({ repo });
  assert.equal(blocked.action, 'invalid-queue');
  assert.equal(blocked.lock_retained, false);
  assert.equal((await scan({ repo })).capture_lock, null);
});

test('recovers a terminal transition whose capture lock release was interrupted', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const url = 'https://mp.weixin.qq.com/s/release-interrupted';
  const queued = await enqueue({ repo, url });
  const claimed = await claim({ repo, id: queued.request.request_id });
  const raw = await promoteFixture(repo, url, 'release-interrupted');
  const completed = await complete({
    repo,
    id: queued.request.request_id,
    claimId: claimed.lock.claim_id,
    rawBundle: raw.raw_bundle,
  });
  const captureLock = path.join(repo, 'staging', 'requests', '.locks', 'capture.lock');
  await fs.writeFile(captureLock, JSON.stringify({
    claim_id: completed.request.terminal_claim.claim_id,
    request_id: completed.request.request_id,
    acquired_at: '2026-08-16T00:00:00.000Z',
  }));
  const interrupted = await scan({ repo });
  assert.equal(interrupted.ok, false);
  assert.match(JSON.stringify(interrupted.failures), /终态请求/);
  const recovered = await recoverLock({
    repo,
    lock: 'capture.lock',
    claimId: completed.request.terminal_claim.claim_id,
    ack: 'reviewed-owner-not-running',
  });
  assert.equal(recovered.action, 'lock-recovered');
  assert.equal((await scan({ repo })).ok, true);
});

test('complete rejects a verified hidden temporary bundle instead of recording it as promoted', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const url = 'https://mp.weixin.qq.com/s/not-final';
  const queued = await enqueue({ repo, url });
  const claimed = await claim({ repo, id: queued.request.request_id });
  const raw = await promoteFixture(repo, url, 'not-final');
  const hidden = path.join(repo, 'raw', 'wechat', '.tmp-not-final');
  await fs.rename(raw.raw_bundle, hidden);
  await assert.rejects(
    () => complete({ repo, id: queued.request.request_id, claimId: claimed.lock.claim_id, rawBundle: hidden }),
    /已发布的非隐藏直接子目录/,
  );
  await failRequest({
    repo,
    id: queued.request.request_id,
    claimId: claimed.lock.claim_id,
    code: 'not-final',
    message: 'fixture intentionally used a temporary raw path',
  });
});
