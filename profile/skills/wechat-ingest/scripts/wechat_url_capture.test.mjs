import assert from 'node:assert/strict';
import test from 'node:test';

import { parseZipArchive, readOrigin } from './wechat_inbox.mjs';
import {
  canonicalWeChatUrl,
  makeStoredZip,
  normalizePublishedAt,
} from './wechat_url_capture.mjs';
import {
  injectExtractUrl,
  injectZipExport,
  MARKER,
  ZIP_MARKER,
} from './wechat_extension_patch.mjs';

test('canonicalWeChatUrl accepts only the intended HTTPS article origin', () => {
  assert.equal(
    canonicalWeChatUrl('https://MP.WEIXIN.QQ.COM/s/abc?utm_source=x&b=2&a=1#frag'),
    'https://mp.weixin.qq.com/s/abc?a=1&b=2',
  );
  for (const invalid of [
    'http://mp.weixin.qq.com/s/abc',
    'https://evil.example/s/abc',
    'https://user@mp.weixin.qq.com/s/abc',
    'https://mp.weixin.qq.com:444/s/abc',
    'https://mp.weixin.qq.com/cgi-bin/appmsg',
  ]) assert.throws(() => canonicalWeChatUrl(invalid));
});

test('stored ZIP is accepted by the deterministic inbox parser', () => {
  const origin = {
    origin_url: 'https://mp.weixin.qq.com/s/abc',
    title: '测试文章',
    retrieved: '2026-08-16T00:00:00.000Z',
  };
  const archive = makeStoredZip([
    ['article.md', '# 测试文章\n\n正文\n'],
    ['origin.json', `${JSON.stringify(origin)}\n`],
  ]);
  const entries = parseZipArchive(archive);
  assert.deepEqual(entries.map((entry) => entry.path), ['article.md', 'origin.json']);
  assert.equal(entries.every((entry) => entry.method === 0), true);
  assert.equal(readOrigin(Buffer.from(JSON.stringify(origin)), 'origin').url, origin.origin_url);
});

test('controlled URL-ZIP provenance requires four matching URLs and can ignore untrusted upstream claims', () => {
  const url = 'https://mp.weixin.qq.com/s/verified';
  const controlled = {
    origin_url: url,
    capture_method: 'wechatsync-url-zip',
    source_authenticity: 'browser-extension-verified',
    provenance_evidence: {
      submitted_url: url, page_url: url, article_url: url, zip_origin_url: url,
      verified_at: '2026-08-16T00:00:00.000Z',
    },
  };
  assert.equal(readOrigin(Buffer.from(JSON.stringify(controlled)), 'origin').sourceAuthenticity, 'browser-extension-verified');
  assert.throws(() => readOrigin(Buffer.from(JSON.stringify({
    ...controlled,
    provenance_evidence: { ...controlled.provenance_evidence, page_url: 'https://mp.weixin.qq.com/s/other' },
  })), 'origin'), /不一致/);
  assert.equal(readOrigin(Buffer.from(JSON.stringify({
    ...controlled,
    provenance_evidence: { page_url: 'https://mp.weixin.qq.com/s/other' },
  })), 'upstream origin', { ignoreCaptureFields: true }).url, url);
});

test('publication date normalization is conservative', () => {
  assert.equal(normalizePublishedAt('2026年8月6日 09:30'), '2026-08-06');
  assert.equal(normalizePublishedAt('2026-02-30'), undefined);
  assert.equal(normalizePublishedAt('昨天'), undefined);
});

test('extension patch is unique, syntactically valid, and idempotent', () => {
  const original = 'class Bridge{async handleMethod(o,e){switch(o){case"extractArticle":{return null}}}}';
  const first = injectExtractUrl(original);
  assert.equal(first.action, 'patched');
  assert.match(first.source, new RegExp(MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const zip = injectZipExport(first.source);
  assert.equal(zip.action, 'patched');
  assert.match(zip.source, new RegExp(ZIP_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotThrow(() => new Function(zip.source));
  const second = injectExtractUrl(zip.source);
  const zipSecond = injectZipExport(second.source);
  assert.equal(second.action, 'already-patched');
  assert.equal(zipSecond.action, 'already-patched');
  assert.equal(zipSecond.source, zip.source);
  assert.throws(() => injectExtractUrl(`${original}${original}`), /唯一定位/);
  assert.throws(() => injectZipExport(`${original}${original}`), /唯一定位/);
});
