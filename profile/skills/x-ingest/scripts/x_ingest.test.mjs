#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureToStage, ingestUrl, parseStatusUrl, promoteStage, verifyRaw } from './x_ingest.mjs';

const ID = '1234567890123456789';
const URL = `https://x.com/Alice/status/${ID}?s=20`;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const roots = [];
async function repo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'x-ingest-test-')); roots.push(root);
  await fs.writeFile(path.join(root, 'AGENTS.md'), '# test\n'); await fs.mkdir(path.join(root, 'wiki')); await fs.mkdir(path.join(root, 'raw', 'x'), { recursive: true }); return root;
}
function response(value, init = {}) { return new Response(typeof value === 'string' ? value : JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json', ...init.headers }, ...init }); }
function post(overrides = {}) { return { id_str: ID, text: '公开帖子正文', user: { screen_name: 'Alice', name: 'Alice' }, photos: [], ...overrides }; }
function fetchMap(map) { return async (url) => { for (const [pattern, value] of Object.entries(map)) if (url.includes(pattern)) { const found = typeof value === 'function' ? value(url) : value; return found instanceof Response ? found.clone() : found; } return response({ error: 'not found' }, { status: 404 }); }; }
async function rejects(task, pattern) { await assert.rejects(task, pattern); }
async function stage(root, name, fetchImpl) { return captureToStage({ url: URL, repo: root, stage: path.join(root, 'staging', 'x', name), fetchImpl }); }

async function testUrlAndResponseGuards() {
  assert.equal(parseStatusUrl(URL).canonical_url, `https://x.com/Alice/status/${ID}`);
  for (const value of ['http://x.com/Alice/status/1', 'https://evil.test/Alice/status/1', 'https://x.com/Alice/status/abc', 'https://x.com/Alice/status/1/extra', 'https://x.com/Alice/status/1?next=https://evil.test']) await rejects(async () => parseStatusUrl(value));
  const root = await repo(); await rejects(() => stage(root, 'mismatch', fetchMap({ syndication: response(post({ id_str: '9' })), fxtwitter: response({ tweet: post({ id_str: '9' }) }) })), /所有公开后端/);
  const redirected = { ok: true, status: 200, redirected: true, headers: new Headers(), arrayBuffer: async () => Buffer.from(JSON.stringify(post())).buffer }; await rejects(() => stage(root, 'redirect', async () => redirected), /所有公开后端/);
  const huge = 'x'.repeat(2 * 1024 * 1024 + 1); await rejects(() => stage(root, 'huge', fetchMap({ syndication: response(huge), fxtwitter: response(huge) })), /所有公开后端/);
}
async function testRealFxArticleFixtureAndMedia() {
  const root = await repo(); const fixture = JSON.parse(await fs.readFile(path.join(SCRIPT_DIR, 'fixtures', 'fxtwitter-article.json'), 'utf8'));
  const staged = await stage(root, 'fx-article', fetchMap({ syndication: response({ error: 'down' }, { status: 503 }), fxtwitter: response(fixture), 'article-photo.jpg': response('photo'), 'article-video.mp4': response('video'), 'article-cover.png': response('cover') }));
  const markdown = await fs.readFile(path.join(staged.stage, 'article.md'), 'utf8'); for (const expected of ['# 真实 Draft.js 长文标题', '## X Article', '## 长文章节', '首段内容。', '  - 无序项目', '1. 有序项目', '> 引用内容', 'const answer = 42;']) assert.match(markdown, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(staged.backend, 'fxtwitter'); assert.match(staged.warnings.join('\n'), /third-party-unverified/); assert.equal((await fs.readdir(path.join(staged.stage, 'media'))).length, 3);
  const promoted = await promoteStage(staged.stage, root); const manifest = JSON.parse(await fs.readFile(promoted.manifest, 'utf8')); assert.equal(manifest.capture_scope, 'single-post'); assert.equal(manifest.source_authenticity, 'third-party-unverified'); await assert.doesNotReject(() => verifyRaw(promoted.raw_bundle, root));
}
async function testWarningsDuplicateTamperAndConcurrency() {
  const root = await repo(); const warning = await stage(root, 'warning', fetchMap({ syndication: response(post({ photos: [{ url: 'https://pbs.twimg.com/media/missing.jpg' }] })), 'missing.jpg': response('missing', { status: 404 }) })); assert.equal(warning.warnings.length, 1);
  const fetchImpl = fetchMap({ syndication: response(post()) }); const first = await stage(root, 'first', fetchImpl); const second = await stage(root, 'second', fetchImpl); const results = await Promise.all([promoteStage(first.stage, root), promoteStage(second.stage, root)]); assert.deepEqual(results.map((item) => item.action).sort(), ['duplicate-noop', 'promoted']); const raw = results.find((item) => item.action === 'promoted').raw_bundle; const manifestBefore = await fs.readFile(path.join(raw, 'manifest.json'), 'utf8'); assert.equal(JSON.parse(manifestBefore).source_authenticity, 'x-syndication'); const third = await stage(root, 'third', fetchImpl); const duplicate = await promoteStage(third.stage, root); assert.equal(duplicate.action, 'duplicate-noop'); assert.equal(await fs.readFile(path.join(raw, 'manifest.json'), 'utf8'), manifestBefore); await fs.appendFile(path.join(raw, 'article.md'), 'tamper'); await rejects(() => verifyRaw(raw, root), /文件清单|内容校验/);
}
async function testFailClosedPathsAndCleanup() {
  const noWiki = await fs.mkdtemp(path.join(os.tmpdir(), 'x-ingest-no-wiki-')); roots.push(noWiki); await fs.writeFile(path.join(noWiki, 'AGENTS.md'), '# test\n'); await rejects(() => captureToStage({ url: URL, repo: noWiki, fetchImpl: fetchMap({ syndication: response(post()) }) }), /AGENTS.md 和 wiki/);
  const stagingSymlinkRoot = await repo(); const stagingOutside = await fs.mkdtemp(path.join(os.tmpdir(), 'x-ingest-staging-outside-')); roots.push(stagingOutside); await fs.symlink(stagingOutside, path.join(stagingSymlinkRoot, 'staging')); await rejects(() => captureToStage({ url: URL, repo: stagingSymlinkRoot, fetchImpl: fetchMap({ syndication: response(post()) }) }), /暂存父目录/);
  const symlinkRoot = await repo(); const symlinkStage = await stage(symlinkRoot, 'symlink-raw', fetchMap({ syndication: response(post()) })); const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'x-ingest-outside-')); roots.push(outside); await fs.rm(path.join(symlinkRoot, 'raw'), { recursive: true }); await fs.symlink(outside, path.join(symlinkRoot, 'raw')); await rejects(() => promoteStage(symlinkStage.stage, symlinkRoot), /raw\/x/);
  for (const kind of ['.hidden', 'plain-file', 'symlink', 'missing-manifest']) { const root = await repo(); const target = path.join(root, 'raw', 'x', kind); if (kind === 'plain-file') await fs.writeFile(target, 'bad'); else if (kind === 'symlink') await fs.symlink(path.join(root, 'wiki'), target); else { await fs.mkdir(target); if (kind === '.hidden') await fs.writeFile(path.join(target, 'anything'), 'bad'); } const captured = await stage(root, `bad-${kind.replace(/[^a-z]/g, '')}`, fetchMap({ syndication: response(post()) })); await rejects(() => promoteStage(captured.stage, root), /raw\/x 包含无效条目|manifest/); }
  const cleanupRoot = await repo(); await fs.writeFile(path.join(cleanupRoot, 'raw', 'x', 'blocker'), 'bad'); await rejects(() => ingestUrl({ url: URL, repo: cleanupRoot, fetchImpl: fetchMap({ syndication: response(post()) }) }), /raw\/x 包含无效条目/); assert.deepEqual(await fs.readdir(path.join(cleanupRoot, 'staging', 'x')), []);
}
try { await testUrlAndResponseGuards(); await testRealFxArticleFixtureAndMedia(); await testWarningsDuplicateTamperAndConcurrency(); await testFailClosedPathsAndCleanup(); process.stdout.write('x-ingest tests: ok\n'); } finally { await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))); }
