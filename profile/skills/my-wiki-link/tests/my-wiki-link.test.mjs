import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  classifyUrl,
  discoverRepo,
  doctor,
  main,
  parseCliArgs,
  planCapture,
  planVerify,
} from '../scripts/my-wiki-link.mjs';

const repo = path.join(os.homedir(), 'my-wiki');

test('discoverRepo finds the default home repository', async () => {
  assert.equal(await discoverRepo(null, { cwd: os.tmpdir(), env: {}, home: os.homedir() }), repo);
});

test('parseCliArgs accepts global flags in any position', () => {
  assert.deepEqual(parseCliArgs(['capture', '--json', 'https://example.com', '--dry-run', '--repo', '/tmp/wiki']), {
    options: { json: true, dryRun: true, help: false, repo: '/tmp/wiki' },
    positional: ['capture', 'https://example.com'],
  });
});

test('classifyUrl covers all supported URL families and canonicalizes variants', async () => {
  const cases = [
    ['wechat', 'https://mp.weixin.qq.com/s/example?utm_source=share'],
    ['wechat-channels', 'https://weixin.qq.com/sph/fixture-short-uri'],
    ['x', 'https://twitter.com/Alice/status/1234567890123456789?s=20'],
    ['bilibili', 'https://www.bilibili.com/video/BV1xx411c7mD?spm_id_from=333.1007.0.0'],
    ['youtube', 'https://youtu.be/dQw4w9WgXcQ?si=fixture'],
    ['youtube', 'https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share'],
  ];
  for (const [expected, url] of cases) {
    const result = await classifyUrl(url, repo);
    assert.equal(result.platform, expected);
    assert.equal(result.supported, true);
    assert.match(result.canonical_url, /^https:\/\//);
  }
});

test('classifyUrl rejects insecure, credentialed, ported and unsupported URLs', async () => {
  const values = [
    'http://x.com/alice/status/1234567890123456789',
    'https://user:pass@x.com/alice/status/1234567890123456789',
    'https://x.com:8443/alice/status/1234567890123456789',
    'https://x.com/alice',
    'https://example.com/article',
  ];
  for (const value of values) await assert.rejects(() => classifyUrl(value, repo));
});

test('planCapture reuses the platform adapter and remains non-mutating', async () => {
  const result = await planCapture('https://x.com/Alice/status/1234567890123456789', repo);
  assert.equal(result.action, 'capture-plan');
  assert.equal(result.dry_run, true);
  assert.equal(result.full_wiki_compile, false);
  assert.equal(result.command[0], process.execPath);
  assert.match(result.command[1], /x-ingest\/scripts\/x_ingest\.mjs$/);
  assert.deepEqual(result.command.slice(2, 5), ['ingest', '--url', 'https://x.com/Alice/status/1234567890123456789']);
});

test('planVerify accepts a direct raw platform child and rejects traversal', async () => {
  const base = path.join(repo, 'raw', 'wechat');
  const entries = (await fs.readdir(base, { withFileTypes: true })).filter((item) => item.isDirectory() && !item.isSymbolicLink());
  assert.ok(entries.length > 0, 'expected at least one immutable WeChat bundle');
  const planned = await planVerify(path.join(base, entries[0].name), repo);
  assert.equal(planned.platform, 'wechat');
  assert.match(planned.command[1], /wechat-ingest\/scripts\/wechat_ingest\.mjs$/);
  await assert.rejects(() => planVerify('/tmp/not-a-bundle', repo));
});

test('doctor imports every current adapter', async () => {
  const result = await doctor(repo);
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.adapters).sort(), ['bilibili', 'wechat', 'wechat-channels', 'x', 'youtube']);
  assert.ok(Object.values(result.adapters).every((item) => item.ok));
});

test('main emits structured JSON without network or mutation', async () => {
  let stdout = '';
  let stderr = '';
  const status = await main(
    ['capture', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', '--dry-run', '--json', '--repo', repo],
    { cwd: os.tmpdir(), env: {}, home: os.homedir(), stdout: (value) => { stdout += value; }, stderr: (value) => { stderr += value; } },
  );
  assert.equal(status, 0);
  assert.equal(stderr, '');
  const value = JSON.parse(stdout);
  assert.equal(value.platform, 'youtube');
  assert.equal(value.action, 'capture-plan');
});

test('main returns a non-zero JSON error for unsupported URLs', async () => {
  let stdout = '';
  let stderr = '';
  const status = await main(
    ['classify', 'https://example.com/article', '--json', '--repo', repo],
    { stdout: (value) => { stdout += value; }, stderr: (value) => { stderr += value; } },
  );
  assert.equal(status, 1);
  assert.equal(stdout, '');
  assert.equal(JSON.parse(stderr).ok, false);
});
