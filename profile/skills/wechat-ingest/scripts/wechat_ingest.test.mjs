import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  canonicalizeUrl,
  diagnosticExcerpt,
  promoteStage,
  stageInput,
  titlesEquivalent,
  validateStage,
  verifyRaw,
} from './wechat_ingest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(HERE, 'loopback-preload.cjs');

async function makeRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-ingest-test-'));
  await fs.writeFile(path.join(root, 'AGENTS.md'), '# fixture\n');
  await fs.mkdir(path.join(root, 'wiki'));
  await fs.mkdir(path.join(root, 'raw', 'wechat'), { recursive: true });
  await fs.mkdir(path.join(root, 'staging', 'wechat'), { recursive: true });
  return root;
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

test('stage, promote, deduplicate, version, and detect tampering', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const fixture = path.join(repo, 'fixture');
  const assets = path.join(fixture, 'assets');
  await fs.mkdir(assets, { recursive: true });
  const input = path.join(fixture, 'article.md');
  await fs.writeFile(input, '# 一篇测试文章\n\n正文。\n\n![本地图](assets/pic.png)\n\n![远程图](https://example.com/image.png)\n');
  await fs.writeFile(path.join(assets, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const firstStage = await stageInput({
    repo,
    url: 'https://mp.weixin.qq.com/s?__biz=test&mid=1&utm_source=phone#fragment',
    input,
    assets,
    publisher: '测试号',
    publishedAt: '2026-08-16',
  });
  assert.equal(firstStage.ok, true);
  assert.equal(firstStage.totals.asset_count, 1);
  assert.match(firstStage.warnings.join('\n'), /远程图片 URL/);
  assert.equal(firstStage.capture.source.canonical_url, 'https://mp.weixin.qq.com/s?__biz=test&mid=1');

  const promoted = await promoteStage(firstStage.stage, repo);
  assert.equal(promoted.action, 'promoted');
  assert.match(promoted.bundle_checksum, /^sha256:[a-f0-9]{64}$/);
  assert.equal((await verifyRaw(promoted.raw_bundle, repo)).ok, true);

  const duplicateStage = await stageInput({
    repo,
    url: 'https://mp.weixin.qq.com/s?mid=1&__biz=test&utm_medium=chat',
    input,
    assets,
    publisher: '测试号',
    publishedAt: '2026-08-16',
  });
  const duplicate = await promoteStage(duplicateStage.stage, repo);
  assert.equal(duplicate.action, 'duplicate-noop');
  assert.equal(duplicate.raw_bundle, promoted.raw_bundle);

  await fs.writeFile(input, '# 一篇测试文章\n\n正文已经更新。\n');
  const changedStage = await stageInput({
    repo,
    url: firstStage.capture.source.canonical_url,
    input,
    publisher: '测试号',
    publishedAt: '2026-08-16',
  });
  const changed = await promoteStage(changedStage.stage, repo);
  assert.equal(changed.action, 'promoted');
  assert.notEqual(changed.raw_bundle, promoted.raw_bundle);

  await fs.appendFile(path.join(promoted.raw_bundle, 'article.md'), '\n篡改\n');
  await assert.rejects(() => verifyRaw(promoted.raw_bundle, repo), /清单|校验和/);
});

test('concurrent promotion of identical content is idempotent', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const input = path.join(repo, 'parallel.md');
  await fs.writeFile(input, '# 并发归档\n\n同一份内容。\n');
  const options = { repo, url: 'https://mp.weixin.qq.com/s/parallel', input, publishedAt: '2026-08-16' };
  const [firstStage, secondStage] = await Promise.all([stageInput(options), stageInput(options)]);
  const results = await Promise.all([
    promoteStage(firstStage.stage, repo),
    promoteStage(secondStage.stage, repo),
  ]);
  assert.deepEqual(results.map((result) => result.action).sort(), ['duplicate-noop', 'promoted']);
  assert.equal(results[0].raw_bundle, results[1].raw_bundle);
  assert.equal((await verifyRaw(results[0].raw_bundle, repo)).ok, true);
});

test('stronger URL-ZIP provenance creates an immutable upgraded bundle and leaves no raw temporary directory', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const input = path.join(repo, 'article.md');
  const url = 'https://mp.weixin.qq.com/s/provenance';
  await fs.writeFile(input, '# 真实性升级\n\n正文。\n');
  const weak = await promoteStage(await stageInput({ repo, url, input }).then((value) => value.stage), repo);
  const evidence = Object.fromEntries([
    'submitted_url', 'page_url', 'article_url', 'zip_origin_url',
  ].map((key) => [key, url]));
  evidence.verified_at = '2026-08-16T00:00:00.000Z';
  const strongOptions = {
    repo, url, input, captureMethod: 'wechatsync-url-zip',
    sourceAuthenticity: 'browser-extension-verified', provenanceEvidence: evidence,
  };
  const strongStage = await stageInput(strongOptions);
  const strong = await promoteStage(strongStage.stage, repo);
  assert.equal(strong.action, 'promoted');
  assert.notEqual(strong.raw_bundle, weak.raw_bundle);
  assert.equal((await verifyRaw(strong.raw_bundle, repo)).source_authenticity, 'browser-extension-verified');
  assert.equal((await verifyRaw(weak.raw_bundle, repo)).source_authenticity, 'declared-only');
  assert.equal((await fs.readdir(path.join(repo, 'raw', 'wechat'))).every((name) => !name.startsWith('.')), true);

  const [left, right] = await Promise.all([stageInput(strongOptions), stageInput(strongOptions)]);
  const concurrent = await Promise.all([promoteStage(left.stage, repo), promoteStage(right.stage, repo)]);
  assert.equal(concurrent.every((result) => result.action === 'duplicate-noop'), true);
  assert.equal(concurrent[0].raw_bundle, strong.raw_bundle);
  assert.equal(concurrent[1].raw_bundle, strong.raw_bundle);
});

test('rejects symlinks and paths outside the staging inbox', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const fixture = path.join(repo, 'fixture');
  const assets = path.join(fixture, 'assets');
  await fs.mkdir(assets, { recursive: true });
  const input = path.join(fixture, 'article.md');
  const target = path.join(fixture, 'target.png');
  await fs.writeFile(input, '# 测试\n\n正文。\n');
  await fs.writeFile(target, 'image');
  await fs.symlink(target, path.join(assets, 'linked.png'));
  await assert.rejects(() => stageInput({ repo, url: 'https://mp.weixin.qq.com/s/a', input, assets }), /符号链接/);
  await assert.rejects(() => validateStage(fixture, repo), /超出允许目录/);
});

test('rejects symlinked staging and raw parent directories', async (t) => {
  const stagingRepo = await makeRepo();
  const rawRepo = await makeRepo();
  t.after(() => fs.rm(stagingRepo, { recursive: true, force: true }));
  t.after(() => fs.rm(rawRepo, { recursive: true, force: true }));

  const stagingOutside = path.join(stagingRepo, 'outside-staging');
  const stagingInput = path.join(stagingRepo, 'article.md');
  await fs.writeFile(stagingInput, '# Staging symlink\n');
  await fs.rm(path.join(stagingRepo, 'staging'), { recursive: true });
  await fs.mkdir(stagingOutside);
  await fs.symlink(stagingOutside, path.join(stagingRepo, 'staging'));
  await assert.rejects(
    () => stageInput({ repo: stagingRepo, url: 'https://mp.weixin.qq.com/s/staging-link', input: stagingInput }),
    /暂存根目录.*普通目录/,
  );

  const rawOutside = path.join(rawRepo, 'outside-raw');
  const rawInput = path.join(rawRepo, 'article.md');
  await fs.writeFile(rawInput, '# Raw symlink\n');
  const staged = await stageInput({ repo: rawRepo, url: 'https://mp.weixin.qq.com/s/raw-link', input: rawInput });
  await fs.rm(path.join(rawRepo, 'raw'), { recursive: true });
  await fs.mkdir(path.join(rawOutside, 'wechat'), { recursive: true });
  await fs.symlink(rawOutside, path.join(rawRepo, 'raw'));
  await assert.rejects(() => promoteStage(staged.stage, rawRepo), /原文包根目录.*普通目录/);
});

test('requires local image paths to resolve and supports explicit attachment mapping', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const fixture = path.join(repo, 'flat-fixture');
  const attachments = path.join(fixture, 'exported-files');
  const input = path.join(fixture, 'article.md');
  await fs.mkdir(attachments, { recursive: true });
  await fs.writeFile(input, '# 平铺附件\n\n![附件](image.bin)\n');
  await fs.writeFile(path.join(attachments, 'image.bin'), 'image');

  await assert.rejects(
    () => stageInput({ repo, url: 'https://mp.weixin.qq.com/s/flat', input, assets: attachments }),
    /本地图片缺失/,
  );
  const mapped = await stageInput({
    repo,
    url: 'https://mp.weixin.qq.com/s/flat',
    input,
    assets: attachments,
    assetsAt: '.',
  });
  const promoted = await promoteStage(mapped.stage, repo);
  assert.equal((await verifyRaw(promoted.raw_bundle, repo)).ok, true);
  assert.equal(await fs.readFile(path.join(promoted.raw_bundle, 'image.bin'), 'utf8'), 'image');
});

test('raw verification rejects a symlinked attachment directory', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const fixture = path.join(repo, 'symlink-fixture');
  const assets = path.join(fixture, 'assets');
  const input = path.join(fixture, 'article.md');
  await fs.mkdir(assets, { recursive: true });
  await fs.writeFile(input, '# 符号链接替换\n\n![图](assets/pic.bin)\n');
  await fs.writeFile(path.join(assets, 'pic.bin'), 'same-bytes');
  const staged = await stageInput({ repo, url: 'https://mp.weixin.qq.com/s/link', input, assets });
  const promoted = await promoteStage(staged.stage, repo);
  const archivedAssets = path.join(promoted.raw_bundle, 'assets');
  const outsideAssets = path.join(repo, 'outside-assets');
  await fs.rename(archivedAssets, outsideAssets);
  await fs.symlink(outsideAssets, archivedAssets);
  await assert.rejects(() => verifyRaw(promoted.raw_bundle, repo), /符号链接/);
});

test('canonical URL strips fragments and common tracking parameters only', () => {
  assert.equal(
    canonicalizeUrl('HTTPS://MP.WEIXIN.QQ.COM/s?__biz=x&mid=2&utm_campaign=a&source=share#part'),
    'https://mp.weixin.qq.com/s?__biz=x&mid=2',
  );
  assert.throws(() => canonicalizeUrl('file:///tmp/article.md'), /http 或 https/);
});

test('verified and extracted titles must match after harmless normalization', () => {
  assert.equal(titlesEquivalent(' 一篇　测试文章 ', '一篇 测试文章'), true);
  assert.equal(titlesEquivalent('同一标题', '另一标题'), false);
});

test('capture diagnostics redact the exact bridge secret and common token formats', () => {
  const secret = 'bridge-secret-123';
  const excerpt = diagnosticExcerpt(
    `noise ${secret} WECHATSYNC_TOKEN=another-secret Authorization: Bearer third-secret`,
    [secret],
  );
  assert.doesNotMatch(excerpt, /bridge-secret-123|another-secret|third-secret/);
  assert.match(excerpt, /\[REDACTED\]/);
});

test('rejects impossible publication dates', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const input = path.join(repo, 'article.md');
  await fs.writeFile(input, '# 日期测试\n\n正文。\n');
  await assert.rejects(
    () => stageInput({ repo, url: 'https://mp.weixin.qq.com/s/date', input, publishedAt: '2026-02-30' }),
    /日期不存在/,
  );
});

test('loopback preload binds both bridge listeners to 127.0.0.1', async () => {
  const port = await freePort();
  const code = `
    const net = require('node:net');
    const servers = [net.createServer(), net.createServer()];
    let ready = 0;
    for (const [index, server] of servers.entries()) {
      server.listen(${port} + index, () => {
        ready += 1;
        if (ready === 2) {
          console.log(JSON.stringify(servers.map((item) => item.address().address)));
          for (const item of servers) item.close();
        }
      });
    }
  `;
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--require', PRELOAD, '-e', code], {
      env: { ...process.env, SYNC_WS_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => status === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
  });
  assert.deepEqual(JSON.parse(output), ['127.0.0.1', '127.0.0.1']);
});
