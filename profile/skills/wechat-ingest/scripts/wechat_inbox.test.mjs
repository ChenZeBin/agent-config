import assert from 'node:assert/strict';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { scanInbox } from './wechat_inbox.mjs';
import { verifyRaw } from './wechat_ingest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function makeRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-inbox-test-'));
  await fs.writeFile(path.join(root, 'AGENTS.md'), '# fixture\n');
  await fs.mkdir(path.join(root, 'wiki'));
  await fs.mkdir(path.join(root, 'raw', 'wechat'), { recursive: true });
  await fs.mkdir(path.join(root, 'staging', 'wechat'), { recursive: true });
  await fs.mkdir(path.join(root, 'staging', 'inbox'), { recursive: true });
  return root;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  const local = [];
  const central = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data || '');
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);

    const directory = entry.name.endsWith('/');
    const mode = entry.mode ?? (directory ? 0o040755 : 0o100644);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE((3 << 8) | 20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE((mode << 16) >>> 0, 38);
    record.writeUInt32LE(localOffset, 42);
    central.push(record, name);
    localOffset += header.length + name.length + data.length;
  }
  const localBuffer = Buffer.concat(local);
  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(localBuffer.length, 16);
  return Buffer.concat([localBuffer, centralBuffer, eocd]);
}

async function regularFiles(root) {
  const result = {};
  async function walk(current, relative = '') {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const rel = path.join(relative, entry.name);
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target, rel);
      else if (entry.isFile()) result[rel] = (await fs.readFile(target)).toString('hex');
    }
  }
  await walk(root);
  return result;
}

test('scans a markdown inbox export safely and leaves its input untouched on re-run', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const inbox = path.join(repo, 'staging', 'inbox');
  await fs.writeFile(path.join(inbox, 'story.md'), '# 收件箱文章\n\n![图](assets/pic.bin)\n');
  await fs.writeFile(path.join(inbox, 'story.json'), JSON.stringify({
    origin_url: 'https://mp.weixin.qq.com/s?mid=7&__biz=box&utm_source=phone',
    publisher: '测试号',
    published_at: '2026-08-16',
  }));
  await fs.mkdir(path.join(inbox, 'story.assets'));
  await fs.writeFile(path.join(inbox, 'story.assets', 'pic.bin'), 'picture');
  const before = await regularFiles(inbox);

  const first = await scanInbox({ repo });
  assert.equal(first.ok, true);
  assert.equal(first.succeeded, 1);
  assert.equal(first.entries[0].status, 'promoted');
  assert.equal(await fs.stat(first.entries[0].raw_bundle).then((stat) => stat.isDirectory()), true);
  assert.deepEqual(await regularFiles(inbox), before);

  const second = await scanInbox({ repo });
  assert.equal(second.ok, true);
  assert.equal(second.entries[0].status, 'duplicate-noop');
  assert.equal(second.entries[0].raw_bundle, first.entries[0].raw_bundle);
  assert.deepEqual(await regularFiles(inbox), before);
});

test('accepts a narrowly defined ZIP bundle and rejects traversal and symlink entries without modifying inbox', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const inbox = path.join(repo, 'staging', 'inbox');
  const origin = JSON.stringify({ origin_url: 'https://mp.weixin.qq.com/s?__biz=zip&mid=8' });
  await fs.writeFile(path.join(inbox, 'valid.zip'), storedZip([
    { name: 'article.md', data: '# ZIP 文章\n\n![图](assets/pic.bin)\n' },
    { name: 'origin.json', data: origin },
    { name: 'assets/', data: '' },
    { name: 'assets/pic.bin', data: 'picture' },
  ]));
  await fs.writeFile(path.join(inbox, 'native.json'), origin);
  await fs.writeFile(path.join(inbox, 'native.zip'), storedZip([
    { name: 'article.md', data: '# 原生导出\n\n![图](images/pic.bin)\n' },
    { name: 'images/', data: '' },
    { name: 'images/pic.bin', data: 'native-picture' },
  ]));
  await fs.writeFile(path.join(inbox, 'traversal.zip'), storedZip([
    { name: 'article.md', data: '# 坏 ZIP\n' },
    { name: 'origin.json', data: origin },
    { name: '../escape.md', data: 'no' },
  ]));
  await fs.writeFile(path.join(inbox, 'symlink.zip'), storedZip([
    { name: 'article.md', data: '# 坏 ZIP\n' },
    { name: 'origin.json', data: origin },
    { name: 'assets/link', data: 'outside', mode: 0o120777 },
  ]));
  const before = await regularFiles(inbox);

  const result = await scanInbox({ repo });
  assert.equal(result.ok, false);
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 2);
  assert.equal(result.entries.find((entry) => entry.input === 'valid.zip').status, 'promoted');
  assert.equal(result.entries.find((entry) => entry.input === 'native.zip').status, 'promoted');
  const nativeBundle = result.entries.find((entry) => entry.input === 'native.zip').raw_bundle;
  assert.equal(await fs.readFile(path.join(nativeBundle, 'images', 'pic.bin'), 'utf8'), 'native-picture');
  assert.match(result.entries.find((entry) => entry.input === 'traversal.zip').error, /路径越界/);
  assert.match(result.entries.find((entry) => entry.input === 'symlink.zip').error, /符号链接或特殊文件/);
  assert.deepEqual(await regularFiles(inbox), before);
  await assert.rejects(fs.access(path.join(repo, 'escape.md'), fsConstants.F_OK));
});

test('native WechatSync ZIP requires an explicit same-name origin sidecar', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const inbox = path.join(repo, 'staging', 'inbox');
  await fs.writeFile(path.join(inbox, 'orphan.zip'), storedZip([
    { name: 'article.md', data: '# No origin\n' },
  ]));
  const result = await scanInbox({ repo });
  assert.equal(result.ok, false);
  assert.match(result.entries[0].error, /orphan\.json/);
  assert.deepEqual(await fs.readdir(path.join(repo, 'raw', 'wechat')), []);
});

test('target scan promotes its exact good ZIP without being blocked by other bad inbox files', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const inbox = path.join(repo, 'staging', 'inbox');
  await fs.writeFile(path.join(inbox, 'bad.zip'), Buffer.from('not-a-zip'));
  await fs.writeFile(path.join(inbox, 'good.zip'), storedZip([
    { name: 'article.md', data: '# Target ZIP\n\n正文\n' },
    { name: 'origin.json', data: JSON.stringify({
      origin_url: 'https://mp.weixin.qq.com/s/target',
      capture_method: 'wechatsync-url-zip', source_authenticity: 'browser-extension-verified',
      provenance_evidence: {
        submitted_url: 'https://mp.weixin.qq.com/s/target', page_url: 'https://mp.weixin.qq.com/s/target',
        article_url: 'https://mp.weixin.qq.com/s/target', zip_origin_url: 'https://mp.weixin.qq.com/s/target',
        verified_at: '2026-08-16T00:00:00.000Z',
      },
    }) },
  ]));
  const targeted = await scanInbox({ repo, target: 'good.zip' });
  assert.equal(targeted.ok, true);
  assert.equal(targeted.processed, 1);
  assert.equal(targeted.entries[0].input, 'good.zip');
  assert.equal(targeted.entries[0].status, 'promoted');
  assert.equal((await verifyRaw(targeted.entries[0].raw_bundle, repo)).source_authenticity, 'declared-only');
  const full = await scanInbox({ repo });
  assert.equal(full.ok, false);
  await assert.rejects(() => scanInbox({ repo, target: '../good.zip' }), /--target/);
});

test('requires explicit origin sidecar and rejects a symlinked inbox item', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const inbox = path.join(repo, 'staging', 'inbox');
  await fs.writeFile(path.join(inbox, 'missing.md'), '# 没有来源\n');
  await fs.writeFile(path.join(repo, 'outside.md'), '# 外部\n');
  await fs.symlink(path.join(repo, 'outside.md'), path.join(inbox, 'linked.md'));

  const result = await scanInbox({ repo });
  assert.equal(result.ok, false);
  assert.equal(result.failed, 2);
  assert.match(result.entries.find((entry) => entry.input === 'missing.md').error, /origin sidecar/);
  assert.match(result.entries.find((entry) => entry.input === 'linked.md').error, /符号链接/);
  const rawEntries = await fs.readdir(path.join(repo, 'raw', 'wechat'));
  assert.deepEqual(rawEntries, []);
});

// Ensure this test file still resolves the sibling script when copied by a test runner.
assert.ok(HERE.endsWith(path.join('wechat-ingest', 'scripts')));
