#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { verifyRaw } from './wechat_ingest.mjs';

const LOCK_NAME = 'wechat-wiki-compiler.lock';

function fail(message, details = undefined) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

async function pathExists(target) {
  try {
    await fs.access(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function findRepoRoot(start = process.cwd()) {
  let current = path.resolve(start);
  while (true) {
    if (await pathExists(path.join(current, 'AGENTS.md')) && await pathExists(path.join(current, 'wiki'))) return current;
    const parent = path.dirname(current);
    if (parent === current) fail('找不到 wiki 仓库根目录；请使用 --repo 指定');
    current = parent;
  }
}

async function plainDirectory(target, label, { create = false } = {}) {
  let stat = await fs.lstat(target).catch(() => null);
  if (!stat && create) {
    await fs.mkdir(target);
    stat = await fs.lstat(target);
  }
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail(`${label}不是普通目录: ${target}`);
  return target;
}

async function resolveRepoRoot(value) {
  const root = value ? path.resolve(value) : await findRepoRoot();
  const rootStat = await fs.lstat(root).catch(() => null);
  const agentsStat = await fs.lstat(path.join(root, 'AGENTS.md')).catch(() => null);
  const wikiStat = await fs.lstat(path.join(root, 'wiki')).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()
    || !agentsStat?.isFile() || agentsStat.isSymbolicLink()
    || !wikiStat?.isDirectory() || wikiStat.isSymbolicLink()) {
    fail(`不是有效 wiki 仓库: ${root}`);
  }
  return root;
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    fail(`${label} 无法解析: ${filePath}: ${error.message}`);
  }
}

async function listMarkdownFiles(root) {
  if (!await pathExists(root)) return [];
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`来源页目录无效: ${root}`);
  const results = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) fail(`来源页目录不允许符号链接: ${absolute}`);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && entry.name.endsWith('.md')) results.push(absolute);
    }
  }
  await walk(root);
  return results;
}

function frontmatter(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return '';
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match?.[1] || '';
}

function yamlValues(yaml, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(`^\\s*${escaped}:\\s*(.*?)\\s*$`, 'gm');
  return [...yaml.matchAll(expression)]
    .map((match) => match[1].trim())
    .filter((value) => value && value !== 'null')
    .map((value) => value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2'));
}

function yamlListValues(yaml, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lines = yaml.split(/\r?\n/);
  const values = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(new RegExp(`^(\\s*)${escaped}:\\s*(.*?)\\s*$`));
    if (!match) continue;
    const baseIndent = match[1].length;
    const inline = match[2].trim();
    if (inline && inline !== '[]') {
      if (inline.startsWith('[') && inline.endsWith(']')) {
        for (const item of inline.slice(1, -1).split(',').map((value) => value.trim()).filter(Boolean)) {
          values.push(item.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2'));
        }
      }
      continue;
    }
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (!line.trim()) continue;
      const indent = line.match(/^\s*/)[0].length;
      if (indent <= baseIndent) break;
      const item = line.match(/^\s*-\s*(.*?)\s*$/);
      if (item?.[1]) values.push(item[1].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2'));
    }
  }
  return values.filter((value) => value && value !== 'null');
}

async function sourceRecords(repoRoot) {
  const sourcesRoot = path.join(repoRoot, 'wiki', 'sources');
  const records = [];
  for (const page of await listMarkdownFiles(sourcesRoot)) {
    const yaml = frontmatter(await fs.readFile(page, 'utf8'));
    const manifests = yamlValues(yaml, 'raw_manifest');
    const checksums = yamlValues(yaml, 'raw_checksum');
    const sources = yamlListValues(yaml, 'sources');
    records.push({
      page,
      raw_manifests: manifests,
      resolved_manifests: manifests.map((value) => path.resolve(path.dirname(page), value)),
      raw_checksums: checksums,
      sources,
      resolved_sources: sources.map((value) => path.resolve(path.dirname(page), value)),
    });
  }
  return records;
}

async function ingestLogRecords(repoRoot) {
  const logPath = path.join(repoRoot, 'wiki', '日志.md');
  if (!await pathExists(logPath)) return [];
  const logStat = await fs.lstat(logPath);
  if (!logStat.isFile() || logStat.isSymbolicLink()) fail(`wiki/日志.md 不是普通文件: ${logPath}`);
  const lines = (await fs.readFile(logPath, 'utf8')).split(/\r?\n/);
  const records = [];
  let ingestHeading = null;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      ingestHeading = /^## \[\d{4}-\d{2}-\d{2}\] ingest \|/.test(line) ? line : null;
      continue;
    }
    if (!ingestHeading) continue;
    const match = line.match(/^- Raw: `([^`]*raw\/wechat\/[^`]+\/manifest\.json)` \(`(sha256:[a-f0-9]{64})`\)$/);
    if (!match) continue;
    records.push({ heading: ingestHeading, raw_manifest: match[1], raw_checksum: match[2] });
  }
  return records;
}

async function rawManifestPaths(repoRoot) {
  const rawParent = path.join(repoRoot, 'raw');
  const rawRoot = path.join(rawParent, 'wechat');
  if (!await pathExists(rawRoot)) return { manifests: [], failures: [] };
  await plainDirectory(rawParent, 'raw 目录');
  await plainDirectory(rawRoot, 'raw/wechat 目录');
  const entries = await fs.readdir(rawRoot, { withFileTypes: true });
  const manifests = [];
  const failures = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.gitkeep') continue;
    const rawBundle = path.join(rawRoot, entry.name);
    if (entry.isSymbolicLink()) {
      failures.push({ raw_bundle: rawBundle, manifest: null, error: '原文包不允许符号链接' });
      continue;
    }
    if (!entry.isDirectory()) {
      failures.push({ raw_bundle: rawBundle, manifest: null, error: 'raw/wechat 仅允许原文包目录' });
      continue;
    }
    const manifest = path.join(rawRoot, entry.name, 'manifest.json');
    const manifestStat = await fs.lstat(manifest).catch(() => null);
    if (!manifestStat) {
      failures.push({ raw_bundle: rawBundle, manifest, error: '原文包缺少 manifest.json' });
    } else if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
      failures.push({ raw_bundle: rawBundle, manifest, error: 'manifest.json 不是普通文件' });
    } else {
      manifests.push(manifest);
    }
  }
  return { manifests, failures };
}

function statusForBundle({ repoRoot, manifestPath, verified, sourcePages, logRecords }) {
  const relativeManifest = toPosix(path.relative(repoRoot, manifestPath));
  const articlePath = path.join(path.dirname(manifestPath), 'article.md');
  const sourceMatches = sourcePages.filter((record) => record.resolved_manifests.includes(manifestPath));
  const articleMatches = sourcePages.filter((record) => record.resolved_sources.includes(articlePath));
  const exactSourceMatches = sourceMatches.filter((record) => record.raw_checksums.length === 1 && record.raw_checksums[0] === verified.bundle_checksum);
  const logMatches = logRecords.filter((record) => record.raw_manifest === relativeManifest);
  const exactLogMatches = logMatches.filter((record) => record.raw_checksum === verified.bundle_checksum);

  if (!sourceMatches.length && !articleMatches.length && !logMatches.length) {
    return { state: 'pending', reasons: [] };
  }
  if (sourceMatches.length === 1 && exactSourceMatches.length === 1
    && articleMatches.length === 1 && articleMatches[0].page === sourceMatches[0].page
    && logMatches.length === 1 && exactLogMatches.length === 1) {
    return { state: 'consistent', reasons: [] };
  }

  const reasons = [];
  if (sourceMatches.length !== 1) reasons.push(`source-page-count:${sourceMatches.length}`);
  else if (exactSourceMatches.length !== 1) reasons.push('source-checksum-mismatch');
  if (articleMatches.length !== 1) reasons.push(`article-source-count:${articleMatches.length}`);
  else if (sourceMatches.length === 1 && articleMatches[0].page !== sourceMatches[0].page) reasons.push('article-source-page-mismatch');
  if (logMatches.length !== 1) reasons.push(`ingest-log-count:${logMatches.length}`);
  else if (exactLogMatches.length !== 1) reasons.push('ingest-log-checksum-mismatch');
  return { state: 'needs-review', reasons };
}

async function scanCompileQueue(repoRootInput = undefined) {
  const repoRoot = await resolveRepoRoot(repoRootInput);
  const [sourcePages, logRecords, rawScan] = await Promise.all([
    sourceRecords(repoRoot),
    ingestLogRecords(repoRoot),
    rawManifestPaths(repoRoot),
  ]);
  const bundles = [];
  const integrityFailures = [...rawScan.failures];

  for (const manifestPath of rawScan.manifests) {
    const rawBundle = path.dirname(manifestPath);
    try {
      const verified = await verifyRaw(rawBundle, repoRoot);
      const manifest = await readJson(manifestPath, 'manifest');
      const classification = statusForBundle({ repoRoot, manifestPath, verified, sourcePages, logRecords });
      bundles.push({
        raw_bundle: rawBundle,
        manifest: manifestPath,
        relative_manifest: toPosix(path.relative(repoRoot, manifestPath)),
        bundle_checksum: verified.bundle_checksum,
        content_checksum: verified.content_checksum,
        title: manifest.source?.title || 'unknown',
        ...classification,
      });
    } catch (error) {
      integrityFailures.push({ raw_bundle: rawBundle, manifest: manifestPath, error: error.message });
    }
  }
  const pending = bundles.filter((bundle) => bundle.state === 'pending');
  const needsReview = bundles.filter((bundle) => bundle.state === 'needs-review');
  const readyForClaim = integrityFailures.length === 0 && needsReview.length === 0;
  return {
    ok: readyForClaim,
    ready_for_claim: readyForClaim,
    repo_root: repoRoot,
    bundles,
    pending,
    needs_review: needsReview,
    integrity_failures: integrityFailures,
  };
}

function lockPath(repoRoot) {
  return path.join(repoRoot, 'staging', '.locks', LOCK_NAME);
}

async function readLock(lock) {
  const stat = await fs.lstat(lock).catch(() => null);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`编译锁无效: ${lock}`);
  const owner = await readJson(lock, '编译锁 owner');
  if (typeof owner.claim_id !== 'string' || !owner.claim_id) fail(`编译锁无 claim_id: ${lock}`);
  return { path: lock, ...owner };
}

async function acquireCompileLock(repoRootInput = undefined) {
  const repoRoot = await resolveRepoRoot(repoRootInput);
  const lock = lockPath(repoRoot);
  const staging = await plainDirectory(path.join(repoRoot, 'staging'), 'staging 目录', { create: true });
  const locks = await plainDirectory(path.join(staging, '.locks'), '编译锁目录', { create: true });
  const owner = {
    claim_id: randomUUID(),
    repo_root: repoRoot,
    pid: process.pid,
    acquired_at: new Date().toISOString(),
  };
  const temporary = path.join(locks, `.claim-${owner.claim_id}.json`);
  await fs.writeFile(temporary, `${JSON.stringify(owner, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  try {
    // The hard link makes a fully written owner record visible atomically while
    // retaining exclusive-create semantics for concurrent claimers.
    await fs.link(temporary, lock);
  } catch (error) {
    if (error.code === 'EEXIST') return { acquired: false, lock: await readLock(lock) };
    throw error;
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
  return { acquired: true, lock: { path: lock, ...owner } };
}

async function releaseCompileLock(repoRootInput, claimId) {
  if (!claimId) fail('release 需要 --claim-id');
  const repoRoot = await resolveRepoRoot(repoRootInput);
  const lock = lockPath(repoRoot);
  const owner = await readLock(lock);
  if (!owner) fail('没有可释放的编译锁');
  if (owner.claim_id !== claimId) fail('claim-id 与当前编译锁不匹配；锁已保留');
  await fs.unlink(lock);
  return { ok: true, action: 'released', repo_root: repoRoot, claim_id: claimId };
}

async function claimNextBundle(repoRootInput = undefined) {
  const lock = await acquireCompileLock(repoRootInput);
  if (!lock.acquired) {
    return { ok: true, action: 'locked', lock: lock.lock, lock_retained: true };
  }
  try {
    const queue = await scanCompileQueue(lock.lock.repo_root);
    if (queue.integrity_failures.length) {
      return { ...queue, ok: false, action: 'integrity-failure', lock: lock.lock, lock_retained: true };
    }
    if (queue.needs_review.length) {
      return { ...queue, ok: false, action: 'needs-review', lock: lock.lock, lock_retained: true };
    }
    if (!queue.pending.length) {
      await releaseCompileLock(lock.lock.repo_root, lock.lock.claim_id);
      return { ok: true, action: 'no-action', lock_released: true, ...queue };
    }
    return {
      ok: true,
      action: 'claimed',
      lock: lock.lock,
      lock_retained: true,
      candidate: queue.pending[0],
      pending_count: queue.pending.length,
      consistent_count: queue.bundles.filter((bundle) => bundle.state === 'consistent').length,
    };
  } catch (error) {
    return {
      ok: false,
      action: 'failed',
      error: error.message,
      details: error.details,
      lock: lock.lock,
      lock_retained: true,
    };
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith('--')) fail(`无法识别的参数: ${item}`);
    const [rawKey, inlineValue] = item.slice(2).split(/=(.*)/s, 2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const value = inlineValue ?? rest[index + 1];
    if (inlineValue === undefined) {
      if (value === undefined || value.startsWith('--')) fail(`参数缺少值: ${item}`);
      index += 1;
    }
    if (Object.hasOwn(options, key)) fail(`参数重复: ${item}`);
    options[key] = value;
  }
  return { command, options };
}

function help() {
  return `微信已冻结收件箱队列\n\n用法:\n  wechat_compile_queue.mjs scan [--repo PATH]\n  wechat_compile_queue.mjs claim [--repo PATH]\n  wechat_compile_queue.mjs release --claim-id ID [--repo PATH]\n\nclaim 只选择一个已验证、尚未编入 wiki 的 raw/wechat bundle；成功 claim 后锁会保留，必须以相同 claim-id release。任何完整性或账本不一致也会保留锁供人工审查。`;
}

async function main(argv) {
  if (!argv.length || ['help', '--help', '-h'].includes(argv[0])) {
    process.stdout.write(`${help()}\n`);
    return;
  }
  const { command, options } = parseArgs(argv);
  let result;
  if (command === 'scan') result = await scanCompileQueue(options.repo);
  else if (command === 'claim') result = await claimNextBundle(options.repo);
  else if (command === 'release') result = await releaseCompileLock(options.repo, options.claimId);
  else fail(`未知命令: ${command}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.ok === false) process.exitCode = 2;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message, details: error.details }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

export {
  acquireCompileLock,
  claimNextBundle,
  releaseCompileLock,
  scanCompileQueue,
};
