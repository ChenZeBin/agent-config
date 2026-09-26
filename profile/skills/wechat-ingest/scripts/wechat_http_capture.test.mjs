import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { captureHttpToStage, canonicalWeChatUrl, markdownFromHtml, parseCgiDataNew } from './wechat_http_capture.mjs';

async function makeRepo() {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-http-capture-test-'));
  await fs.writeFile(path.join(repo, 'AGENTS.md'), '# fixture\n');
  await fs.mkdir(path.join(repo, 'wiki'));
  await fs.mkdir(path.join(repo, 'staging', 'wechat'), { recursive: true });
  return repo;
}

function fixture({ link = 'https://mp.weixin.qq.com/s/example', content = '<h2>小节</h2><p>正文 &amp; <code>x</code></p>' } = {}) {
  return String.raw`<html><script>window.cgiDataNew = {title:'\u6d4b\u8bd5\'\x20\u6807\u9898',nick_name:'\u53d1\u5e03\u8005',content_noencode:'${content.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}',create_time:'2026-08-17 17:47',link:'${link}'};</script></html>`;
}

function htmlResponse(html, init = {}) {
  return new Response(Buffer.from(html, 'utf8'), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...(init.headers || {}) } });
}

test('canonical URL rejects credentials, ports, and non-article paths', () => {
  assert.equal(canonicalWeChatUrl('https://MP.WEIXIN.QQ.COM/s/a?utm_source=x&b=2&a=1'), 'https://mp.weixin.qq.com/s/a?a=1&b=2');
  for (const value of ['http://mp.weixin.qq.com/s/a', 'https://a@mp.weixin.qq.com/s/a', 'https://mp.weixin.qq.com:444/s/a', 'https://mp.weixin.qq.com:443/s/a', 'https://mp.weixin.qq.com/cgi-bin/x']) {
    assert.throws(() => canonicalWeChatUrl(value));
  }
});

test('safe cgiDataNew parsing decodes supported literals without execution', () => {
  const parsed = parseCgiDataNew(fixture({ content: '<p>hello</p>' }));
  assert.equal(parsed.title, "测试' 标题");
  assert.equal(parsed.nick_name, '发布者');
  assert.equal(parsed.content_noencode, '<p>hello</p>');
  assert.equal(parseCgiDataNew("window.cgiDataNew={ignored:'\\q',title:'x',nick_name:'n',content_noencode:'c',create_time:'2026-08-17 00:00',link:'https://mp.weixin.qq.com/s/a'}").title, 'x');
  assert.equal(parseCgiDataNew("window.cgiDataNew={base_resp:{ret:'0' * 1},title:'x',nick_name:'n',content_noencode:'c',create_time:'2026-08-17 00:00',link:'https://mp.weixin.qq.com/s/a'}").title, 'x');
  assert.throws(() => parseCgiDataNew("window.cgiDataNew={title:'x\\q',nick_name:'n',content_noencode:'c',create_time:'2026-08-17 00:00',link:'https://mp.weixin.qq.com/s/a'}"), /不允许的转义/);
  assert.throws(() => parseCgiDataNew("window.cgiDataNew={title:'x',nick_name:'n',content_noencode:'c',create_time:'2026-08-17 00:00',link:'https://mp.weixin.qq.com/s/a"), /未闭合/);
});

test('HTTP capture stages exact source HTML and controlled origin provenance', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const url = 'https://mp.weixin.qq.com/s/example';
  const html = fixture({ content: '<h2>小节</h2><p>正文 &amp; <code>x</code></p><script>remove()</script><style>.x{}</style>' });
  const staged = await captureHttpToStage({ url, repo, fetchImpl: async (requested) => {
    assert.equal(requested, url);
    return htmlResponse(html);
  } });
  assert.equal(staged.canonical_url, url);
  assert.equal(staged.source_authenticity, 'wechat-origin-response');
  assert.match(staged.stage, /staging\/wechat/);
  const savedHtml = await fs.readFile(path.join(staged.stage, 'responses', 'wechat.html'));
  assert.equal(savedHtml.toString('utf8'), html);
  assert.equal(staged.capture.capture.provenance_evidence.html_sha256, `sha256:${createHash('sha256').update(savedHtml).digest('hex')}`);
  const markdown = await fs.readFile(path.join(staged.stage, 'article.md'), 'utf8');
  assert.match(markdown, /^# 测试' 标题/m);
  assert.match(markdown, /## 小节/);
  assert.match(markdown, /正文 & `x`/);
  assert.doesNotMatch(markdown, /remove\(\)|\.x\{\}/);
});

test('capture rejects a cgi embedded-link mismatch and outside redirect', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await assert.rejects(
    () => captureHttpToStage({ url: 'https://mp.weixin.qq.com/s/example', repo, fetchImpl: async () => htmlResponse(fixture({ link: 'https://mp.weixin.qq.com/s/other' })) }),
    /不一致/,
  );
  await assert.rejects(
    () => captureHttpToStage({ url: 'https://mp.weixin.qq.com/s/example', repo, fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://evil.example/s/a' } }) }),
    /只允许/,
  );
  assert.deepEqual(await fs.readdir(path.join(repo, 'staging', 'wechat')), []);
});

test('capture refuses oversized response before staging', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await assert.rejects(
    () => captureHttpToStage({ url: 'https://mp.weixin.qq.com/s/example', repo, fetchImpl: async () => htmlResponse('x', { headers: { 'content-length': String(21 * 1024 * 1024) } }) }),
    /上限/,
  );
});

test('capture requires an HTML origin response', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await assert.rejects(
    () => captureHttpToStage({
      url: 'https://mp.weixin.qq.com/s/example',
      repo,
      fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    }),
    /响应类型异常/,
  );
});

test('image whitelist localizes permitted images and retains failed remote references with warnings', async (t) => {
  const repo = await makeRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const url = 'https://mp.weixin.qq.com/s/example';
  const allowed = 'https://mmbiz.qpic.cn/mmbiz_png/a.png';
  const blocked = 'https://evil.example/unsafe.png';
  const html = fixture({ content: `<p><img data-src="${allowed}"><img src="${blocked}"></p>` });
  const staged = await captureHttpToStage({ url, repo, fetchImpl: async (requested) => {
    if (requested === url) return htmlResponse(html);
    if (requested === allowed) return new Response(Buffer.from([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } });
    throw new Error(`unexpected ${requested}`);
  } });
  const markdown = await fs.readFile(path.join(staged.stage, 'article.md'), 'utf8');
  assert.match(markdown, /responses\/images\/image-001\.png/);
  assert.match(markdown, /https:\/\/evil\.example\/unsafe\.png/);
  assert.equal((await fs.readFile(path.join(staged.stage, 'responses', 'images', 'image-001.png'))).length, 3);
  assert.match(staged.warnings.join('\n'), /非白名单图片/);
});

test('converter strips executable/style markup', () => {
  const rendered = markdownFromHtml('<p>A<br>B <a href="https://example.com/x">link</a></p><blockquote>C</blockquote><pre><code>D</code></pre><script>alert(1)</script><style>x</style>');
  assert.match(rendered.body, /A\nB/);
  assert.match(rendered.body, /> C/);
  assert.match(rendered.body, /\[link\]\(https:\/\/example\.com\/x\)/);
  assert.match(rendered.body, /```/);
  assert.doesNotMatch(rendered.body, /alert|style/);
});

test('module contains no dynamic page-code execution primitive', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = await fs.readFile(path.join(here, 'wechat_http_capture.mjs'), 'utf8');
  assert.doesNotMatch(source, /\beval\s*\(/);
  assert.doesNotMatch(source, /\bFunction\s*\(/);
});
