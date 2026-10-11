#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const EXPECTED_VERSION = '2.0.9';
const EXPECTED_SHA256 = '1c45a07a8323cdc2a92c38349381e1d24d560b19c0b59a2567479ab6661de4b8';
const V1_PATCHED_SHA256 = 'f59384e58c89e9f395a74a22a2a24a36382713ef2b15dcc87c226480587e0f52';
const CHUNK = 'assets/index.ts-Bw-475TG.js';
const MARKER = '/* codex-wechat-extract-url-v1 */';
const ZIP_MARKER = '/* codex-wechat-export-url-zip-v1 */';
const ANCHOR = 'case"extractArticle":{';

const INSERTION = String.raw`case"extractUrl":{/* codex-wechat-extract-url-v1 */const $raw=e==null?void 0:e.url;if(typeof $raw!=="string")throw new Error("Missing url parameter");let $wanted;try{$wanted=new URL($raw)}catch{throw new Error("Invalid url parameter")}if($wanted.protocol!=="https:"||$wanted.hostname!=="mp.weixin.qq.com"||$wanted.username||$wanted.password||$wanted.port||!($wanted.pathname==="/s"||$wanted.pathname.startsWith("/s/")))throw new Error("Only https://mp.weixin.qq.com/s article URLs are allowed");$wanted.hash="";const $tab=await chrome.tabs.create({url:$wanted.toString(),active:!1});if(!$tab.id)throw new Error("Failed to create capture tab");const $tabId=$tab.id;try{await new Promise(async($resolve,$reject)=>{let $done=!1;const $finish=$error=>{if($done)return;$done=!0,clearTimeout($timer),chrome.tabs.onUpdated.removeListener($listener),$error?$reject($error):$resolve()},$timer=setTimeout(()=>$finish(new Error("Article tab load timeout")),6e4),$listener=($id,$change)=>{$id===$tabId&&$change.status==="complete"&&$finish()};chrome.tabs.onUpdated.addListener($listener);try{const $current=await chrome.tabs.get($tabId);$current.status==="complete"&&$finish()}catch($error){$finish($error)}});const $loaded=await chrome.tabs.get($tabId),$actual=new URL($loaded.url||"");if($actual.protocol!=="https:"||$actual.hostname!=="mp.weixin.qq.com"||!($actual.pathname==="/s"||$actual.pathname.startsWith("/s/")))throw new Error("Capture tab navigated outside the allowed article origin");let $response=null;for(let $attempt=0;$attempt<20&&!($response!=null&&$response.article);$attempt++){try{$response=await chrome.tabs.sendMessage($tabId,{type:"EXTRACT_ARTICLE"})}catch{}$response!=null&&$response.article||await new Promise($resolve=>setTimeout($resolve,250))}if(!($response!=null&&$response.article))throw new Error("Article extraction returned no content");const $meta=(await chrome.scripting.executeScript({target:{tabId:$tabId},func:()=>({url:window.location.href,title:(document.querySelector("#activity-name")?.textContent||document.title||"").trim(),publisher:(document.querySelector("#js_name")?.textContent||"").trim(),published_text:(document.querySelector("#publish_time")?.textContent||document.querySelector(".rich_media_meta_text")?.textContent||"").trim()})}))[0]?.result||{};return{article:$response.article,page:$meta}}finally{await chrome.tabs.remove($tabId).catch(()=>{})}}`;

const ZIP_INSERTION = String.raw`case"exportUrlZip":{/* codex-wechat-export-url-zip-v1 */const $captured=await this.handleMethod("extractUrl",e),$article=$captured.article,$page=$captured.page||{},$title=String($article.title||$page.title||"").trim();let $markdown=String($article.markdown||$article.content||"");if(!$title||!$markdown.trim())throw new Error("Article title or markdown is empty");$markdown.startsWith("# ")||($markdown="# "+$title+"\n\n"+$markdown);const $archive=new sr,$images=$archive.folder("images"),$adapter=await je("zip-download"),$processed=await $adapter.processImagesForZip($markdown,$images);$archive.file("article.md",$processed.processedMarkdown);const $origin={origin_url:String($page.url||$article.source?.url||""),title:$title,retrieved:new Date().toISOString()};String($page.publisher||"").trim()&&($origin.publisher=String($page.publisher).trim());const $date=String($page.published_text||"").match(/\b(20\d{2})[年\/.\-](\d{1,2})[月\/.\-](\d{1,2})日?\b/);if($date){const $value=$date[1]+"-"+$date[2].padStart(2,"0")+"-"+$date[3].padStart(2,"0"),$parsed=new Date($value+"T00:00:00Z");!Number.isNaN($parsed.getTime())&&$parsed.toISOString().slice(0,10)===$value&&($origin.published_at=$value)}$archive.file("origin.json",JSON.stringify($origin,null,2)+"\n");const $base64=await $archive.generateAsync({type:"base64",compression:"DEFLATE",compressionOptions:{level:6}});return{...$captured,archive_base64:$base64,image_count:$processed.imageCount}}`;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fail(message) {
  throw new Error(message);
}

function injectExtractUrl(source) {
  if (source.includes(MARKER)) return { action: 'already-patched', source };
  const first = source.indexOf(ANCHOR);
  if (first < 0 || source.indexOf(ANCHOR, first + ANCHOR.length) >= 0) fail('无法唯一定位 extractArticle 桥接方法');
  return { action: 'patched', source: `${source.slice(0, first)}${INSERTION}${source.slice(first)}` };
}

function injectZipExport(source) {
  if (source.includes(ZIP_MARKER)) return { action: 'already-patched', source };
  const first = source.indexOf(ANCHOR);
  if (first < 0 || source.indexOf(ANCHOR, first + ANCHOR.length) >= 0) fail('无法唯一定位 extractArticle 桥接方法');
  return { action: 'patched', source: `${source.slice(0, first)}${ZIP_INSERTION}${source.slice(first)}` };
}

async function readPlainFile(file, label) {
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) fail(`${label}不是普通文件: ${file}`);
  const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat({ bigint: true });
    const data = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail(`${label}读取期间发生变化`);
    return { data, stat: before };
  } finally {
    await handle.close();
  }
}

async function patchExtension(extensionRoot, backupRoot) {
  const root = path.resolve(extensionRoot);
  const rootStat = await fs.lstat(root).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) fail(`扩展目录无效: ${root}`);
  const manifestPath = path.join(root, 'manifest.json');
  const { data: manifestBytes } = await readPlainFile(manifestPath, 'manifest');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.name !== '文章同步助手' || manifest.version !== EXPECTED_VERSION) {
    fail(`只支持文章同步助手 ${EXPECTED_VERSION}，当前为 ${manifest.name || 'unknown'} ${manifest.version || 'unknown'}`);
  }
  for (const permission of ['tabs', 'scripting']) {
    if (!manifest.permissions?.includes(permission)) fail(`扩展缺少必要权限: ${permission}`);
  }
  const chunkPath = path.join(root, CHUNK);
  const { data, stat } = await readPlainFile(chunkPath, 'service worker chunk');
  const source = data.toString('utf8');
  if (source.includes(ZIP_MARKER)) return { ok: true, action: 'already-patched', extension_root: root, chunk: chunkPath };
  const digest = sha256(data);
  if (![EXPECTED_SHA256, V1_PATCHED_SHA256].includes(digest)) fail(`扩展代码哈希不受支持: sha256:${digest}`);
  const withUrlCapture = source.includes(MARKER) ? source : injectExtractUrl(source).source;
  const patched = injectZipExport(withUrlCapture).source;

  const backups = path.resolve(backupRoot);
  await fs.mkdir(backups, { recursive: true, mode: 0o700 });
  const backup = path.join(backups, `${EXPECTED_SHA256}.js`);
  if (digest === EXPECTED_SHA256) {
    try {
      await fs.writeFile(backup, data, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  const existingBackup = await fs.readFile(backup).catch(() => null);
  if (!existingBackup || sha256(existingBackup) !== EXPECTED_SHA256) fail(`缺少可信原版备份: ${backup}`);

  const temporary = path.join(path.dirname(chunkPath), `.${path.basename(chunkPath)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, Number(stat.mode & 0o777n));
    await handle.writeFile(patched, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    const current = await readPlainFile(chunkPath, 'service worker chunk');
    if (sha256(current.data) !== digest) fail('扩展代码在写入前发生变化');
    await fs.rename(temporary, chunkPath);
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
  return {
    ok: true,
    action: 'patched',
    extension_root: root,
    chunk: chunkPath,
    backup,
    source_sha256: `sha256:${digest}`,
    original_backup_sha256: `sha256:${EXPECTED_SHA256}`,
    patched_sha256: `sha256:${sha256(Buffer.from(patched))}`,
    next_step: '在 chrome://extensions 中对“文章同步助手”点击一次重新加载。',
  };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!key?.startsWith('--') || !value) fail('参数格式错误');
    options[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  return { command, options };
}

async function main(argv) {
  const { command, options } = parseArgs(argv);
  if (command !== 'patch' || !options.extension || !options.backupRoot) {
    fail('用法: wechat_extension_patch.mjs patch --extension PATH --backup-root PATH');
  }
  process.stdout.write(`${JSON.stringify(await patchExtension(options.extension, options.backupRoot), null, 2)}\n`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

export {
  EXPECTED_SHA256,
  INSERTION,
  MARKER,
  ZIP_INSERTION,
  ZIP_MARKER,
  injectExtractUrl,
  injectZipExport,
  patchExtension,
  sha256,
};
