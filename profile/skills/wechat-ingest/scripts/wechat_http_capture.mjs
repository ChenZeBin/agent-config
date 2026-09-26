#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { stageInput, validateStage } from './wechat_ingest.mjs';

const MAX_HTML_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES = 100 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const IMAGE_HOSTS = new Set(['mmbiz.qpic.cn', 'mmbiz.qlogo.cn', 'wx.qlogo.cn']);
const ORIGIN_HEADERS = Object.freeze({
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.5',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
});

function fail(message, details = undefined) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

function sha256(data) {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

function canonicalWeChatUrl(raw) {
  const authority = String(raw).match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i)?.[1];
  const hostPort = authority?.slice(authority.lastIndexOf('@') + 1);
  if (hostPort && /:\d*$/.test(hostPort)) fail('微信 URL 不允许凭据或非默认端口');
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`无效 URL: ${raw}`);
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'mp.weixin.qq.com') {
    fail('只允许无凭据的 https://mp.weixin.qq.com/s 文章 URL');
  }
  if (url.username || url.password || url.port) fail('微信 URL 不允许凭据或非默认端口');
  if (!(url.pathname === '/s' || url.pathname.startsWith('/s/'))) fail('只允许 mp.weixin.qq.com/s 文章路径');
  url.hostname = 'mp.weixin.qq.com';
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || ['spm', 'from', 'source'].includes(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.toString();
}

function validDate(raw) {
  const match = String(raw || '').match(/^(20\d{2})-(\d{2})-(\d{2})(?:\s+|T)/);
  if (!match) return undefined;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date ? undefined : date;
}

function skipWhitespace(source, index) {
  while (index < source.length && /\s/.test(source[index])) index += 1;
  return index;
}

function scanJsString(source, index) {
  const quote = source[index];
  if (quote !== "'" && quote !== '"') fail('cgiDataNew 字段不是受支持的字符串');
  let value = '';
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (char === quote) return { value, end: cursor + 1 };
    if (char === '\\') {
      const escaped = source[++cursor];
      if (escaped === undefined) fail('cgiDataNew 字符串转义不完整');
      if (escaped === '\\' || escaped === "'" || escaped === '"') value += escaped;
      else if (escaped === 'n') value += '\n';
      else if (escaped === 'r') value += '\r';
      else if (escaped === 't') value += '\t';
      else if (escaped === 'b') value += '\b';
      else if (escaped === 'f') value += '\f';
      else if (escaped === 'v') value += '\v';
      else if (escaped === 'x') {
        const hex = source.slice(cursor + 1, cursor + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) fail('cgiDataNew 包含畸形 \\x 转义');
        value += String.fromCharCode(Number.parseInt(hex, 16));
        cursor += 2;
      } else if (escaped === 'u') {
        const hex = source.slice(cursor + 1, cursor + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('cgiDataNew 包含畸形 \\u 转义');
        value += String.fromCharCode(Number.parseInt(hex, 16));
        cursor += 4;
      } else {
        fail(`cgiDataNew 包含不允许的转义: \\${escaped}`);
      }
      continue;
    }
    if (char === '\n' || char === '\r' || char === '\0') fail('cgiDataNew 字符串包含未转义控制字符');
    value += char;
  }
  fail('cgiDataNew 字符串未闭合');
}

function skipJsString(source, index) {
  const quote = source[index];
  if (quote !== "'" && quote !== '"') fail('JavaScript 字符串无效');
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === quote) return cursor + 1;
    if (source[cursor] === '\\') {
      cursor += 1;
      if (cursor >= source.length) fail('JavaScript 字符串转义不完整');
    }
  }
  fail('JavaScript 字符串未闭合');
}

function skipJsValue(source, index) {
  index = skipWhitespace(source, index);
  const pairs = new Map([['{', '}'], ['[', ']'], ['(', ')']]);
  const closer = [];
  for (; index < source.length; index += 1) {
    const char = source[index];
    if (char === "'" || char === '"') {
      index = skipJsString(source, index) - 1;
    } else if (pairs.has(char)) closer.push(pairs.get(char));
    else if (closer.length && char === closer.at(-1)) closer.pop();
    else if (!closer.length && (char === ',' || char === '}')) return index;
  }
  fail('cgiDataNew 值未闭合');
}

function readObjectKey(source, index) {
  index = skipWhitespace(source, index);
  if (source[index] === "'" || source[index] === '"') return scanJsString(source, index);
  const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(index));
  if (!match) fail('cgiDataNew 对象键无效');
  return { value: match[0], end: index + match[0].length };
}

function locateCgiObject(source) {
  const match = /\bwindow\.cgiDataNew\s*=\s*\{/.exec(source);
  if (!match) fail('页面未包含 window.cgiDataNew');
  return match.index + match[0].lastIndexOf('{');
}

function parseCgiDataNew(source) {
  let index = locateCgiObject(source) + 1;
  const fields = {};
  const wanted = new Set(['title', 'nick_name', 'content_noencode', 'create_time', 'link']);
  while (true) {
    index = skipWhitespace(source, index);
    if (source[index] === '}') break;
    const key = readObjectKey(source, index);
    index = skipWhitespace(source, key.end);
    if (source[index] !== ':') fail(`cgiDataNew.${key.value} 缺少冒号`);
    index = skipWhitespace(source, index + 1);
    if (wanted.has(key.value)) {
      const string = scanJsString(source, index);
      fields[key.value] = string.value;
      index = string.end;
    } else {
      index = skipJsValue(source, index);
    }
    index = skipWhitespace(source, index);
    if (source[index] === ',') {
      index += 1;
      continue;
    }
    if (source[index] === '}') break;
    fail('cgiDataNew 对象分隔符无效');
  }
  for (const key of wanted) {
    if (!fields[key]) fail(`cgiDataNew 缺少 ${key}`);
  }
  return fields;
}

function decodeEntities(value) {
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|nbsp|amp|lt|gt|quot|apos);/gi, (_, token) => {
    const lower = token.toLowerCase();
    if (lower === 'nbsp') return ' ';
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    const number = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isInteger(number) && number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : _;
  });
}

function attributes(raw) {
  const result = {};
  for (const match of raw.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    result[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4]);
  }
  return result;
}

function markdownFromHtml(html) {
  const images = [];
  let output = '';
  let ignored = null;
  let pre = false;
  let code = false;
  let blockquote = false;
  const anchors = [];
  const append = (text) => { output += text; };
  const ensureBreak = (count = 2) => {
    const suffix = '\n'.repeat(count);
    if (!output.endsWith(suffix)) output = output.replace(/\n*$/, '') + suffix;
  };
  const tokens = html.match(/<!--[\s\S]*?-->|<[^>]*>|[^<]+/g) || [];
  for (const token of tokens) {
    if (!token.startsWith('<')) {
      if (!ignored) append(decodeEntities(token).replace(/\r\n?/g, '\n'));
      continue;
    }
    const nameMatch = /^<\s*(\/?)\s*([a-z0-9-]+)/i.exec(token);
    if (!nameMatch) continue;
    const closing = Boolean(nameMatch[1]);
    const name = nameMatch[2].toLowerCase();
    if (name === 'script' || name === 'style') {
      if (!closing) ignored = name;
      else if (ignored === name) ignored = null;
      continue;
    }
    if (ignored) continue;
    if (/^h[1-6]$/.test(name)) {
      if (!closing) { ensureBreak(); append(`${'#'.repeat(Number(name[1]))} `); } else ensureBreak();
    } else if (['p', 'div', 'section', 'article', 'figure'].includes(name)) {
      if (!closing) ensureBreak(); else ensureBreak();
    } else if (name === 'br') append('\n');
    else if (name === 'li' && !closing) { ensureBreak(1); append('- '); }
    else if (name === 'blockquote') {
      if (!closing) { ensureBreak(); append('> '); blockquote = true; } else { blockquote = false; ensureBreak(); }
    } else if (name === 'pre') {
      if (!closing) { ensureBreak(); append('```\n'); pre = true; } else { if (!output.endsWith('\n')) append('\n'); append('```\n\n'); pre = false; }
    } else if (name === 'code' && !pre) {
      if (!closing) { append('`'); code = true; } else if (code) { append('`'); code = false; }
    } else if (name === 'a') {
      if (!closing) {
        const href = attributes(token).href;
        const safeHref = href && /^https?:\/\//i.test(href) ? href : null;
        anchors.push(safeHref);
        if (safeHref) append('[');
      } else {
        const href = anchors.pop();
        if (href) append(`](${href})`);
      }
    } else if (name === 'img' && !closing) {
      const attrs = attributes(token);
      const url = attrs['data-src'] || attrs.src;
      if (url) {
        const marker = `@@WECHAT_IMAGE_${images.length}@@`;
        images.push(url);
        append(`![](${marker})`);
      }
    }
    if (blockquote && token === '<br>') append('> ');
  }
  return { body: output.replace(/\n{3,}/g, '\n\n').trim(), images };
}

function allowedImageUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && IMAGE_HOSTS.has(url.hostname.toLowerCase()) ? url : null;
  } catch {
    return null;
  }
}

async function readResponse(response, maxBytes, label) {
  const length = response.headers?.get?.('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > maxBytes) fail(`${label}超过 ${maxBytes} 字节上限`);
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        size += chunk.length;
        if (size > maxBytes) fail(`${label}超过 ${maxBytes} 字节上限`);
        chunks.push(chunk);
      }
    } finally {
      await reader.cancel?.().catch(() => {});
    }
    return Buffer.concat(chunks, size);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) fail(`${label}超过 ${maxBytes} 字节上限`);
  return buffer;
}

async function fetchOrigin(url, fetchImpl) {
  let current = canonicalWeChatUrl(url);
  const deadline = Date.now() + TIMEOUT_MS;
  for (let hop = 0; hop <= 3; hop += 1) {
    const controller = new AbortController();
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail('微信原站请求失败: 超时');
    const timer = setTimeout(() => controller.abort(), remaining);
    let response;
    try {
      response = await fetchImpl(current, { headers: ORIGIN_HEADERS, redirect: 'manual', signal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      fail(`微信原站请求失败: ${error?.name === 'AbortError' ? '超时' : error.message}`);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      clearTimeout(timer);
      if (hop === 3) fail('微信原站重定向超过 3 次');
      const location = response.headers?.get?.('location');
      if (!location) fail('微信原站重定向缺少 Location');
      await response.body?.cancel?.().catch(() => {});
      current = canonicalWeChatUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) {
      clearTimeout(timer);
      await response.body?.cancel?.().catch(() => {});
      fail(`微信原站响应异常: HTTP ${response.status}`);
    }
    const contentType = response.headers?.get?.('content-type') || '';
    if (!/^text\/html(?:\s*;|$)/i.test(contentType)) {
      clearTimeout(timer);
      await response.body?.cancel?.().catch(() => {});
      fail(`微信原站响应类型异常: ${contentType || 'missing Content-Type'}`);
    }
    return { response, responseUrl: current, close: () => { clearTimeout(timer); controller.abort(); } };
  }
  fail('微信原站重定向异常');
}

function suffixForImage(url, contentType) {
  const fromUrl = path.extname(url.pathname).toLowerCase();
  if (/^\.(?:png|jpe?g|gif|webp|bmp|avif)$/i.test(fromUrl)) return fromUrl === '.jpeg' ? '.jpg' : fromUrl;
  const type = String(contentType || '').split(';', 1)[0].toLowerCase();
  return ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif' })[type] || '.bin';
}

async function downloadImages(urls, tempRoot, fetchImpl, warnings) {
  const replacements = new Map();
  let total = 0;
  const imageDir = path.join(tempRoot, 'responses', 'images');
  for (let index = 0; index < urls.length; index += 1) {
    const raw = urls[index];
    const allowed = allowedImageUrl(raw);
    if (!allowed) {
      warnings.push(`未下载非白名单图片: ${raw.slice(0, 200)}`);
      replacements.set(index, raw);
      continue;
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let response;
      try {
        response = await fetchImpl(allowed.toString(), {
          headers: { ...ORIGIN_HEADERS, accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
          redirect: 'manual',
          signal: controller.signal,
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) throw new Error('图片响应包含重定向');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (!/^image\//i.test(response.headers?.get?.('content-type') || '')) throw new Error('图片响应类型不是 image/*');
        const remaining = Math.min(MAX_IMAGE_BYTES, MAX_IMAGE_TOTAL_BYTES - total);
        if (remaining <= 0) throw new Error('图片总量超过 100 MiB 上限');
        const bytes = await readResponse(response, remaining, '图片');
        total += bytes.length;
        await fs.mkdir(imageDir, { recursive: true, mode: 0o700 });
        const file = `image-${String(index + 1).padStart(3, '0')}${suffixForImage(allowed, response.headers?.get?.('content-type'))}`;
        await fs.writeFile(path.join(imageDir, file), bytes, { flag: 'wx', mode: 0o600 });
        replacements.set(index, `responses/images/${file}`);
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    } catch (error) {
      warnings.push(`图片下载失败，保留远程引用: ${raw.slice(0, 200)} (${String(error?.message || error).slice(0, 160)})`);
      replacements.set(index, raw);
    }
  }
  return replacements;
}

async function captureHttpToStage({ url, repo, fetchImpl = fetch } = {}) {
  if (typeof fetchImpl !== 'function') fail('fetchImpl 必须是函数');
  const submittedUrl = canonicalWeChatUrl(url);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-http-capture-'));
  let stage;
  try {
    const origin = await fetchOrigin(submittedUrl, fetchImpl);
    let html;
    try {
      html = await readResponse(origin.response, MAX_HTML_BYTES, '微信 HTML');
    } finally {
      origin.close();
    }
    const { responseUrl } = origin;
    let htmlText;
    try {
      htmlText = new TextDecoder('utf-8', { fatal: true }).decode(html);
    } catch {
      fail('微信 HTML 不是有效 UTF-8');
    }
    const data = parseCgiDataNew(htmlText);
    const embeddedUrl = canonicalWeChatUrl(data.link);
    if (submittedUrl !== responseUrl || responseUrl !== embeddedUrl) fail('提交 URL、响应 URL 与 cgiDataNew.link 不一致');
    const rendered = markdownFromHtml(data.content_noencode);
    const warnings = [];
    const replacements = await downloadImages(rendered.images, temporary, fetchImpl, warnings);
    const body = rendered.body.replace(/@@WECHAT_IMAGE_(\d+)@@/g, (_, index) => replacements.get(Number(index)) || '');
    const publishedAt = validDate(data.create_time);
    if (!publishedAt) warnings.push('页面 create_time 无法解析为有效日期');
    const markdown = [
      `# ${data.title.trim()}`,
      '',
      `- Publisher: ${data.nick_name.trim() || 'unknown'}`,
      `- Published: ${publishedAt || 'unknown'}`,
      `- Source: ${submittedUrl}`,
      '',
      body,
      '',
    ].join('\n');
    const input = path.join(temporary, 'article.md');
    const responseDir = path.join(temporary, 'responses');
    await fs.mkdir(responseDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(input, markdown, { encoding: 'utf8', mode: 0o600 });
    await fs.writeFile(path.join(responseDir, 'wechat.html'), html, { flag: 'wx', mode: 0o600 });
    const verifiedAt = new Date().toISOString();
    const staged = await stageInput({
      repo,
      url: submittedUrl,
      canonicalUrl: submittedUrl,
      input,
      assets: responseDir,
      assetsAt: 'responses',
      title: data.title.trim(),
      publisher: data.nick_name.trim() || 'unknown',
      ...(publishedAt ? { publishedAt } : {}),
      captureMethod: 'wechat-origin-response',
      sourceAuthenticity: 'wechat-origin-response',
      provenanceEvidence: {
        submitted_url: submittedUrl,
        response_url: responseUrl,
        embedded_url: embeddedUrl,
        verified_at: verifiedAt,
        html_sha256: sha256(html),
      },
    });
    stage = staged.stage;
    if (warnings.length) {
      const capturePath = path.join(stage, 'capture.json');
      const capture = JSON.parse(await fs.readFile(capturePath, 'utf8'));
      capture.warnings = [...new Set([...(capture.warnings || []), ...warnings])];
      await fs.writeFile(capturePath, `${JSON.stringify(capture, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    }
    const validation = await validateStage(stage, repo);
    return {
      ...validation,
      canonical_url: submittedUrl,
      title: data.title.trim(),
      source_authenticity: 'wechat-origin-response',
      warnings: validation.warnings,
    };
  } catch (error) {
    if (stage) await fs.rm(stage, { recursive: true, force: true });
    throw error;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (!['--url', '--repo'].includes(flag)) fail(`未知参数: ${flag}`);
    const value = rest[index + 1];
    if (!value || value.startsWith('--') || options[flag.slice(2)]) fail(`参数无效: ${flag}`);
    options[flag.slice(2)] = value;
    index += 1;
  }
  if (command !== 'capture' || !options.url) fail('用法: wechat_http_capture.mjs capture --url URL [--repo PATH]');
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  process.stdout.write(`${JSON.stringify(await captureHttpToStage(options), null, 2)}\n`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

export { canonicalWeChatUrl, captureHttpToStage, markdownFromHtml, parseCgiDataNew };
