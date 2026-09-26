#!/usr/bin/env node

// URL request queue: mutable staging state only.  It never creates, changes,
// moves, or repairs raw bundles; complete() merely verifies a bundle promoted
// by the existing ingest workflow.
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { canonicalizeUrl, readStableRegularFile, verifyRaw } from './wechat_ingest.mjs';

const SCHEMA_VERSION = 1;
const MAX_URL_BYTES = 4096;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_FAILURE_BYTES = 1000;
const JOB_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const CHECKSUM = /^sha256:[a-f0-9]{64}$/;
const STATUSES = new Set(['queued', 'capturing', 'promoted', 'failed']);

function fail(message, details = undefined) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertInside(parent, child, label) {
  if (!isInside(parent, child)) fail(`${label} 超出允许目录: ${child}`);
}

function isoNow() {
  return new Date().toISOString();
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function redact(value) {
  return String(value)
    .replace(/\b(wechatsync_token|mcp_token|access_token|refresh_token|authorization|token)\s*([=:])\s*([^\s,;]+)/gi, '$1$2[REDACTED]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]');
}

function redactValue(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      /(?:token|authorization|password|secret)/i.test(key) ? '[REDACTED]' : redactValue(item),
    ]));
  }
  return value;
}

function boundedText(value, label, maxBytes = MAX_FAILURE_BYTES) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) fail(`${label} 必须是非空文本`);
  const text = redact(value).trim();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) return Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  return text;
}

function checkedWechatUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value, 'utf8') > MAX_URL_BYTES) {
    fail('URL 必须是非空且不超过 4096 字节的文本');
  }
  const canonical = canonicalizeUrl(value.trim());
  const parsed = new URL(canonical);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'mp.weixin.qq.com') {
    fail('URL 必须是 https://mp.weixin.qq.com/...');
  }
  if (parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) {
    fail('URL 不能包含凭据或非默认端口');
  }
  if (!/^\/s(?:\/|$)/.test(parsed.pathname)) fail('URL 必须是 mp.weixin.qq.com/s 文章链接');
  return { origin: value.trim(), canonical };
}

async function pathExists(target) {
  try {
    await fs.access(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensurePlainDirectory(target, label, { create = false } = {}) {
  let stat = await fs.lstat(target).catch(() => null);
  if (!stat && create) {
    try {
      await fs.mkdir(target, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    stat = await fs.lstat(target).catch(() => null);
  }
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail(`${label}不是普通目录: ${target}`);
  return target;
}

async function ensurePrivateDirectory(target, label) {
  const stat = await fs.lstat(target);
  if (process.platform !== 'win32') {
    if ((stat.mode & 0o077) !== 0) fail(`${label}必须仅当前用户可访问（0700）: ${target}`);
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail(`${label}不属于当前用户: ${target}`);
  }
}

async function ensureOwnerControlledDirectory(target, label) {
  const stat = await fs.lstat(target);
  if (process.platform !== 'win32') {
    if ((stat.mode & 0o022) !== 0) fail(`${label}不得对 group/other 开放写权限: ${target}`);
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail(`${label}不属于当前用户: ${target}`);
  }
}

async function directoryIdentity(target, label) {
  const stat = await fs.lstat(target, { bigint: true }).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail(`${label}不是普通目录: ${target}`);
  return { dev: stat.dev, ino: stat.ino };
}

async function assertDirectoryIdentity(target, expected, label) {
  const current = await directoryIdentity(target, label);
  if (current.dev !== expected.dev || current.ino !== expected.ino) fail(`${label}在操作期间被替换: ${target}`);
}

async function assertLayoutStable(layout, names) {
  for (const name of names) await assertDirectoryIdentity(layout[name], layout.identities[name], `${name} 目录`);
}

async function resolveRepoRoot(value) {
  const root = path.resolve(value || process.cwd());
  const rootStat = await fs.lstat(root).catch(() => null);
  const agents = path.join(root, 'AGENTS.md');
  const wiki = path.join(root, 'wiki');
  const [agentsStat, wikiStat] = await Promise.all([fs.lstat(agents).catch(() => null), fs.lstat(wiki).catch(() => null)]);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()
    || !agentsStat?.isFile() || agentsStat.isSymbolicLink()
    || !wikiStat?.isDirectory() || wikiStat.isSymbolicLink()) {
    fail(`不是有效 wiki 仓库: ${root}`);
  }
  return root;
}

async function queueLayout(repoRootInput = undefined) {
  const repoRoot = await resolveRepoRoot(repoRootInput);
  const staging = await ensurePlainDirectory(path.join(repoRoot, 'staging'), 'staging 目录', { create: true });
  await ensureOwnerControlledDirectory(repoRoot, '仓库根目录');
  await ensureOwnerControlledDirectory(staging, 'staging 目录');
  const requests = await ensurePlainDirectory(path.join(staging, 'requests'), '请求队列目录', { create: true });
  const temporary = await ensurePlainDirectory(path.join(requests, '.tmp'), '请求临时目录', { create: true });
  const locks = await ensurePlainDirectory(path.join(requests, '.locks'), '请求锁目录', { create: true });
  const dedupe = await ensurePlainDirectory(path.join(requests, '.dedupe'), '请求去重目录', { create: true });
  for (const [label, target] of Object.entries({ requests, temporary, locks, dedupe })) {
    await ensurePrivateDirectory(target, `${label} 目录`);
  }
  const identities = {};
  for (const [name, target] of Object.entries({ staging, requests, temporary, locks, dedupe })) {
    identities[name] = await directoryIdentity(target, `${name} 目录`);
  }
  return { repoRoot, staging, requests, temporary, locks, dedupe, identities };
}

function assertJobId(id) {
  if (typeof id !== 'string' || !JOB_ID.test(id)) fail('无效 request id');
  return id.toLowerCase();
}

function jobPath(layout, id) {
  const job = path.join(layout.requests, `${assertJobId(id)}.json`);
  assertInside(layout.requests, job, '请求文件');
  return job;
}

function parseJson(buffer, label) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    fail(`${label} 不是有效 JSON: ${redact(error.message)}`);
  }
}

function validateJob(job, label = '请求') {
  if (!job || Array.isArray(job) || typeof job !== 'object') fail(`${label} 必须是 JSON 对象`);
  if (job.schema_version !== SCHEMA_VERSION) fail(`${label} schema 不受支持`);
  assertJobId(job.request_id);
  if (!Number.isSafeInteger(job.revision) || job.revision < 0) fail(`${label} revision 无效`);
  if (!STATUSES.has(job.status)) fail(`${label} status 无效`);
  const source = checkedWechatUrl(job.origin_url);
  if (job.canonical_url !== source.canonical) fail(`${label} canonical_url 不匹配`);
  if (job.idempotency_key !== `sha256:${sha256(source.canonical)}`) fail(`${label} idempotency_key 不匹配`);
  if (typeof job.submitted_at !== 'string' || typeof job.updated_at !== 'string') fail(`${label} 时间字段无效`);
  if (!Number.isSafeInteger(job.attempts) || job.attempts < 0) fail(`${label} attempts 无效`);
  if (job.history !== undefined) {
    if (!Array.isArray(job.history) || job.history.length > 100) fail(`${label} history 无效`);
    for (const record of job.history) {
      if (!record || Array.isArray(record) || typeof record !== 'object'
        || typeof record.event !== 'string' || typeof record.at !== 'string') {
        fail(`${label} history 条目无效`);
      }
    }
  }
  const validClaim = (claim) => claim && typeof claim.claim_id === 'string' && claim.claim_id;
  if (job.status === 'capturing') {
    if (!validClaim(job.claim)) fail(`${label} capturing 状态缺少 claim`);
    if (job.terminal_claim !== null || job.result !== null || job.failure !== null) {
      fail(`${label} capturing 状态含有终态字段`);
    }
  } else if (job.claim !== null) {
    fail(`${label} 非 capturing 状态不能保留 claim`);
  }
  if (job.status === 'queued' && (job.terminal_claim !== null || job.result !== null || job.failure !== null)) {
    fail(`${label} queued 状态含有终态字段`);
  }
  if (job.status === 'promoted') {
    if (!validClaim(job.terminal_claim) || job.failure !== null) fail(`${label} promoted 状态缺少终态 claim 记录`);
    if (!job.result || typeof job.result.raw_bundle !== 'string' || !CHECKSUM.test(job.result.bundle_checksum || '')) {
      fail(`${label} promoted 状态缺少已验证结果`);
    }
    const normalizedRaw = path.posix.normalize(job.result.raw_bundle);
    if (path.posix.isAbsolute(job.result.raw_bundle) || normalizedRaw !== job.result.raw_bundle
      || job.result.raw_bundle.includes('\\')
      || normalizedRaw === '..' || normalizedRaw.startsWith('../')
      || !/^raw\/wechat\/[^./][^/]*$/.test(job.result.raw_bundle)
      || !CHECKSUM.test(job.result.content_checksum || '')) {
      fail(`${label} promoted 结果路径或校验和无效`);
    }
  }
  if (job.status === 'failed') {
    if (!validClaim(job.terminal_claim) || job.result !== null
      || !job.failure || typeof job.failure.code !== 'string' || typeof job.failure.message !== 'string') {
      fail(`${label} failed 状态缺少终态 claim 或 failure`);
    }
  }
  return job;
}

async function readJob(layout, id) {
  const target = jobPath(layout, id);
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat) fail(`请求不存在: ${id}`);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`请求不是普通文件: ${target}`);
  return validateJob(parseJson(await readStableRegularFile(target, '请求文件', MAX_JSON_BYTES), '请求文件'));
}

async function writeExclusiveJson(target, value, label) {
  const payload = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  let handle;
  try {
    handle = await fs.open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0), 0o600);
    await handle.writeFile(payload);
    await handle.sync();
  } catch (error) {
    fail(`${label} 无法安全创建: ${target}: ${redact(error.message)}`);
  } finally {
    await handle?.close();
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function publishExclusiveJson(layout, target, value, label) {
  await assertLayoutStable(layout, ['staging', 'requests', 'temporary']);
  const temporary = path.join(layout.temporary, `.publish-${randomUUID()}.json`);
  assertInside(layout.temporary, temporary, '临时发布文件');
  await writeExclusiveJson(temporary, value, label);
  try {
    await assertLayoutStable(layout, ['staging', 'requests', 'temporary']);
    await fs.link(temporary, target);
    await syncDirectory(path.dirname(target));
  } catch (error) {
    if (error.code === 'EEXIST') fail(`${label} 已存在: ${target}`);
    throw error;
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

async function writeJobAtomic(layout, job, expectedRevision) {
  validateJob(job);
  const target = jobPath(layout, job.request_id);
  const current = await readJob(layout, job.request_id);
  if (current.revision !== expectedRevision) fail(`请求 revision 已变化: ${job.request_id}`);
  await ensurePlainDirectory(layout.requests, '请求队列目录');
  await ensurePlainDirectory(layout.temporary, '请求临时目录');
  await assertLayoutStable(layout, ['staging', 'requests', 'temporary']);
  const temporary = path.join(layout.temporary, `${job.request_id}-${randomUUID()}.json`);
  assertInside(layout.temporary, temporary, '请求临时文件');
  await writeExclusiveJson(temporary, job, '请求临时文件');
  try {
    const check = await readJob(layout, job.request_id);
    if (check.revision !== expectedRevision) fail(`请求 revision 已变化: ${job.request_id}`);
    await assertLayoutStable(layout, ['staging', 'requests', 'temporary']);
    await fs.rename(temporary, target);
    await syncDirectory(layout.requests);
    const written = await readJob(layout, job.request_id);
    if (written.revision !== job.revision || written.status !== job.status) fail(`请求状态写入校验失败: ${job.request_id}`);
    return written;
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

function makeJob({ id, origin, canonical }) {
  const now = isoNow();
  return {
    schema_version: SCHEMA_VERSION,
    request_id: id,
    revision: 0,
    status: 'queued',
    origin_url: origin,
    canonical_url: canonical,
    idempotency_key: `sha256:${sha256(canonical)}`,
    submitted_at: now,
    updated_at: now,
    attempts: 0,
    claim: null,
    terminal_claim: null,
    result: null,
    failure: null,
    history: [],
  };
}

function appendHistory(job, record) {
  const history = Array.isArray(job.history) ? job.history : [];
  return [...history, { at: isoNow(), ...redactValue(record) }].slice(-100);
}

function lockDirectory(layout, name) {
  const lock = path.join(layout.locks, name);
  assertInside(layout.locks, lock, '请求锁');
  return lock;
}

async function readLockOwner(lock, label) {
  const stat = await fs.lstat(lock).catch(() => null);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label}无效: ${lock}`);
  const value = parseJson(await readStableRegularFile(lock, label, MAX_JSON_BYTES), label);
  if (!value || typeof value.claim_id !== 'string' || !value.claim_id) fail(`${label} owner 无 claim_id`);
  return { path: lock, ...value };
}

async function acquireLock(layout, name, owner, label) {
  await ensurePlainDirectory(layout.locks, '请求锁目录');
  await assertLayoutStable(layout, ['staging', 'requests', 'temporary', 'locks']);
  const lock = lockDirectory(layout, name);
  const temporary = path.join(layout.temporary, `.lock-${randomUUID()}.json`);
  assertInside(layout.temporary, temporary, '临时锁 owner');
  await writeExclusiveJson(temporary, owner, label);
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        // A hard link publishes a complete owner record atomically. A process
        // can die on either side without leaving an ownerless final lock.
        await assertLayoutStable(layout, ['staging', 'requests', 'temporary', 'locks']);
        await fs.link(temporary, lock);
        await syncDirectory(layout.locks);
        return { acquired: true, lock: { path: lock, ...owner } };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const existing = await readLockOwner(lock, label);
          if (existing) return { acquired: false, lock: existing };
        } catch (readError) {
          if (attempt === 7 || !/无法安全打开|在读取期间发生变化|不存在/.test(readError.message)) throw readError;
        }
      }
      await wait(2);
    }
    fail(`${label}状态持续变化，无法安全获取`);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

async function releaseLock(layout, name, claimId, label) {
  await assertLayoutStable(layout, ['staging', 'requests', 'locks']);
  const lock = lockDirectory(layout, name);
  const owner = await readLockOwner(lock, label);
  if (!owner) fail(`${label}不存在`);
  if (owner.claim_id !== claimId) fail(`${label} claim-id 不匹配；锁已保留`);
  await assertLayoutStable(layout, ['staging', 'requests', 'locks']);
  await fs.unlink(lock);
  await syncDirectory(layout.locks);
}

async function withTransientJobLock(layout, id, operation) {
  const claimId = randomUUID();
  const acquired = await acquireLock(layout, `job-${assertJobId(id)}.lock`, {
    claim_id: claimId, pid: process.pid, acquired_at: isoNow(),
  }, '请求 job 锁');
  if (!acquired.acquired) return { locked: true, lock: acquired.lock };
  let operationError;
  try {
    return await operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await releaseLock(layout, `job-${id}.lock`, claimId, '请求 job 锁');
    } catch (releaseError) {
      if (!operationError) throw releaseError;
    }
  }
}

async function readDedupe(layout, canonical) {
  const key = sha256(canonical);
  const marker = path.join(layout.dedupe, `${key}.json`);
  assertInside(layout.dedupe, marker, '去重记录');
  if (!await pathExists(marker)) return null;
  const stat = await fs.lstat(marker);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`去重记录不是普通文件: ${marker}`);
  const record = parseJson(await readStableRegularFile(marker, '去重记录', MAX_JSON_BYTES), '去重记录');
  if (record.schema_version !== SCHEMA_VERSION || record.canonical_url !== canonical || typeof record.request_id !== 'string') {
    fail(`去重记录无效: ${marker}`);
  }
  assertJobId(record.request_id);
  return record;
}

async function queueEntries(layout) {
  const entries = await fs.readdir(layout.requests, { withFileTypes: true });
  const jobs = [];
  const failures = [];
  const knownDirectories = new Set(['.tmp', '.locks', '.dedupe']);
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(layout.requests, entry.name);
    if (knownDirectories.has(entry.name)) {
      const stat = await fs.lstat(absolute).catch(() => null);
      if (!stat?.isDirectory() || stat.isSymbolicLink()) failures.push({ entry: entry.name, error: '保留条目不是普通目录' });
      continue;
    }
    const match = /^([0-9a-f-]+)\.json$/i.exec(entry.name);
    if (!match || !JOB_ID.test(match[1]) || entry.isSymbolicLink() || !entry.isFile()) {
      failures.push({ entry: entry.name, error: '请求队列包含未知或非普通条目' });
      continue;
    }
    try {
      jobs.push(await readJob(layout, match[1]));
    } catch (error) {
      failures.push({ entry: entry.name, error: redact(error.message) });
    }
  }
  return { jobs, failures };
}

async function validateDedupeIndex(layout, jobs) {
  const failures = [];
  const warnings = [];
  const markers = new Map();
  const entries = await fs.readdir(layout.dedupe, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const match = /^([a-f0-9]{64})\.json$/.exec(entry.name);
    const absolute = path.join(layout.dedupe, entry.name);
    if (!match || entry.isSymbolicLink() || !entry.isFile()) {
      failures.push({ entry: `.dedupe/${entry.name}`, error: '去重目录包含未知或非普通条目' });
      continue;
    }
    try {
      const record = parseJson(await readStableRegularFile(absolute, '去重记录', MAX_JSON_BYTES), '去重记录');
      const source = checkedWechatUrl(record.canonical_url);
      if (record.schema_version !== SCHEMA_VERSION || source.canonical !== record.canonical_url
        || match[1] !== sha256(record.canonical_url) || !JOB_ID.test(record.request_id || '')) {
        fail('去重记录字段无效');
      }
      const job = jobs.find((candidate) => candidate.request_id === record.request_id);
      if (!job || job.canonical_url !== record.canonical_url) fail('去重记录没有匹配请求');
      markers.set(record.canonical_url, record.request_id);
    } catch (error) {
      failures.push({ entry: `.dedupe/${entry.name}`, error: redact(error.message) });
    }
  }
  for (const job of jobs) {
    if (markers.get(job.canonical_url) !== job.request_id) {
      warnings.push({ entry: `${job.request_id}.json`, warning: '请求缺少去重记录；再次 enqueue 同一 URL 会确定性补齐' });
    }
  }
  const canonicalCounts = new Map();
  for (const job of jobs) canonicalCounts.set(job.canonical_url, (canonicalCounts.get(job.canonical_url) || 0) + 1);
  for (const [canonical, count] of canonicalCounts) {
    if (count > 1) failures.push({ entry: canonical, error: `同一 canonical URL 存在 ${count} 个请求` });
  }
  return { failures, warnings };
}

async function validateLockIndex(layout) {
  const failures = [];
  const owners = new Map();
  const entries = await fs.readdir(layout.locks, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(layout.locks, entry.name);
    const jobMatch = /^job-(.+)\.lock$/.exec(entry.name);
    const validName = entry.name === 'capture.lock'
      || (jobMatch && JOB_ID.test(jobMatch[1]))
      || /^dedupe-[a-f0-9]{64}\.lock$/.test(entry.name);
    if (!validName || entry.isSymbolicLink() || !entry.isFile()) {
      failures.push({ entry: `.locks/${entry.name}`, error: '锁目录包含未知或非普通条目' });
      continue;
    }
    try {
      owners.set(entry.name, await readLockOwner(absolute, '请求锁'));
    } catch (error) {
      failures.push({ entry: `.locks/${entry.name}`, error: redact(error.message) });
    }
  }
  return { failures, owners };
}

async function findJobByCanonical(layout, canonical) {
  const listed = await queueEntries(layout);
  if (listed.failures.length) fail('请求队列包含无效条目', listed.failures);
  const matches = listed.jobs.filter((job) => job.canonical_url === canonical);
  if (matches.length > 1) fail('同一 canonical URL 存在多个请求');
  return matches[0] || null;
}

async function acquireDedupeLock(layout, canonical) {
  const name = `dedupe-${sha256(canonical)}.lock`;
  let last;
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const acquired = await acquireLock(layout, name, {
      claim_id: randomUUID(), pid: process.pid, acquired_at: isoNow(),
    }, '请求去重锁');
    if (acquired.acquired) return acquired;
    last = acquired;
    await wait(4);
  }
  return last;
}

async function enqueue(options = {}) {
  const layout = await queueLayout(options.repo);
  const { origin, canonical } = checkedWechatUrl(options.url);
  const dedupeLock = await acquireDedupeLock(layout, canonical);
  if (!dedupeLock.acquired) return { ok: true, action: 'locked', canonical_url: canonical, lock: dedupeLock.lock };
  let operationError;
  try {
    const duplicate = await readDedupe(layout, canonical);
    if (duplicate) {
      const job = await readJob(layout, duplicate.request_id);
      return { ok: true, action: 'duplicate', request: job };
    }
    const recovered = await findJobByCanonical(layout, canonical);
    if (recovered) {
      const marker = path.join(layout.dedupe, `${sha256(canonical)}.json`);
      await publishExclusiveJson(layout, marker, {
        schema_version: SCHEMA_VERSION, request_id: recovered.request_id, canonical_url: canonical,
      }, '去重记录');
      return { ok: true, action: 'duplicate-recovered', request: recovered };
    }
    const id = randomUUID();
    const job = makeJob({ id, origin, canonical });
    await publishExclusiveJson(layout, jobPath(layout, id), job, '请求文件');
    const marker = path.join(layout.dedupe, `${sha256(canonical)}.json`);
    await publishExclusiveJson(layout, marker, {
      schema_version: SCHEMA_VERSION, request_id: id, canonical_url: canonical,
    }, '去重记录');
    return { ok: true, action: 'queued', request: await readJob(layout, id) };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await releaseLock(layout, `dedupe-${sha256(canonical)}.lock`, dedupeLock.lock.claim_id, '请求去重锁');
    } catch (releaseError) {
      if (!operationError) throw releaseError;
    }
  }
}

async function scan(options = {}) {
  const layout = await queueLayout(options.repo);
  const listed = await queueEntries(layout);
  const requests = listed.jobs;
  const lockIndex = await validateLockIndex(layout);
  const dedupeIndex = await validateDedupeIndex(layout, requests);
  const captureLock = lockIndex.owners.get('capture.lock') || null;
  const capturing = requests.filter((request) => request.status === 'capturing');
  const relationshipFailures = [];
  if (captureLock) {
    const boundRequestValid = JOB_ID.test(captureLock.request_id || '');
    const activeMatches = capturing.filter((request) => request.request_id === captureLock.request_id
      && request.claim?.claim_id === captureLock.claim_id);
    const terminalMatches = requests.filter((request) => ['promoted', 'failed'].includes(request.status)
      && request.request_id === captureLock.request_id
      && request.terminal_claim?.claim_id === captureLock.claim_id);
    if (!boundRequestValid || activeMatches.length !== 1 || terminalMatches.length) {
      relationshipFailures.push({
        entry: '.locks/capture.lock',
        error: !boundRequestValid
          ? '全局 capture 锁缺少有效 request_id 绑定'
          : terminalMatches.length
          ? '全局 capture 锁已对应终态请求，需显式 recover'
          : '全局 capture 锁未唯一对应 capturing 请求',
      });
    }
  } else if (capturing.length) {
    relationshipFailures.push({ entry: 'capturing', error: 'capturing 请求缺少全局 capture 锁' });
  }
  if (capturing.length > 1) relationshipFailures.push({ entry: 'capturing', error: '同时存在多个 capturing 请求' });
  const failures = [
    ...listed.failures,
    ...dedupeIndex.failures,
    ...lockIndex.failures,
    ...relationshipFailures,
  ];
  requests.sort((left, right) => left.submitted_at.localeCompare(right.submitted_at) || left.request_id.localeCompare(right.request_id));
  const byStatus = Object.fromEntries([...STATUSES].map((status) => [status, requests.filter((request) => request.status === status).length]));
  return {
    ok: failures.length === 0,
    action: 'scanned',
    repo_root: layout.repoRoot,
    requests,
    by_status: byStatus,
    failures,
    warnings: dedupeIndex.warnings,
    capture_lock: captureLock,
    locks: [...lockIndex.owners.entries()].map(([name, owner]) => ({ name, ...owner })),
  };
}

async function claim(options = {}) {
  const layout = await queueLayout(options.repo);
  const requestedId = options.id === undefined ? null : assertJobId(options.id);
  const report = await scan({ repo: layout.repoRoot });
  if (!report.ok) return { ok: false, action: 'invalid-queue', failures: report.failures, lock_retained: false };
  if (report.capture_lock) return { ok: true, action: 'locked', lock: report.capture_lock, lock_retained: true };
  const candidate = requestedId
    ? report.requests.find((request) => request.request_id === requestedId)
    : report.requests.find((request) => request.status === 'queued');
  if (!candidate) {
    return requestedId
      ? { ok: false, action: 'not-found', request_id: requestedId, lock_retained: false }
      : { ok: true, action: 'no-action', lock_retained: false };
  }
  if (candidate.status !== 'queued') {
    return { ok: true, action: 'not-queued', request: candidate, lock_retained: false };
  }
  const owner = {
    claim_id: randomUUID(),
    request_id: candidate.request_id,
    pid: process.pid,
    acquired_at: isoNow(),
  };
  const capture = await acquireLock(layout, 'capture.lock', owner, '全局 capture 锁');
  if (!capture.acquired) return { ok: true, action: 'locked', lock: capture.lock, lock_retained: true };
  try {
    if (typeof options.beforeTransition === 'function') await options.beforeTransition({ ...owner });
    const changed = await withTransientJobLock(layout, candidate.request_id, async () => {
      const currentCapture = await readLockOwner(lockDirectory(layout, 'capture.lock'), '全局 capture 锁');
      if (currentCapture?.claim_id !== owner.claim_id || currentCapture.request_id !== candidate.request_id) {
        fail('全局 capture 锁已被恢复或替换，已拒绝过期 claim');
      }
      const current = await readJob(layout, candidate.request_id);
      if (current.status !== 'queued') fail(`请求已不在 queued 状态: ${current.request_id}`);
      return await writeJobAtomic(layout, {
        ...current,
        revision: current.revision + 1,
        status: 'capturing',
        updated_at: isoNow(),
        attempts: current.attempts + 1,
        claim: { claim_id: owner.claim_id, pid: process.pid, claimed_at: isoNow() },
        terminal_claim: null,
        result: null,
        failure: null,
      }, current.revision);
    });
    if (changed.locked) {
      await releaseLock(layout, 'capture.lock', owner.claim_id, '全局 capture 锁');
      return { ok: false, action: 'job-locked', lock: changed.lock, lock_released: true };
    }
    return { ok: true, action: 'claimed', request: changed, lock: capture.lock, lock_retained: true };
  } catch (error) {
    const current = await readLockOwner(lockDirectory(layout, 'capture.lock'), '全局 capture 锁').catch(() => null);
    const retained = current?.claim_id === owner.claim_id;
    return {
      ok: false,
      action: 'failed',
      error: redact(error.message),
      lock: retained ? current : null,
      lock_retained: retained,
    };
  }
}

async function requireClaim(layout, id, claimId) {
  if (typeof claimId !== 'string' || !claimId) fail('需要 claim-id');
  const capture = await readLockOwner(lockDirectory(layout, 'capture.lock'), '全局 capture 锁');
  if (!capture || capture.claim_id !== claimId || capture.request_id !== id) {
    fail('全局 capture 锁不存在或 claim-id/request-id 不匹配');
  }
  const job = await readJob(layout, id);
  if (job.status !== 'capturing' || job.claim?.claim_id !== claimId) fail('请求不属于该 capturing claim');
  return { job, capture };
}

async function complete(options = {}) {
  const layout = await queueLayout(options.repo);
  const id = assertJobId(options.id);
  const health = await scan({ repo: layout.repoRoot });
  if (!health.ok) fail('请求队列完整性校验失败', health.failures);
  const result = await withTransientJobLock(layout, id, async () => {
    const { job } = await requireClaim(layout, id, options.claimId);
    if (!options.rawBundle) fail('complete 需要 --raw-bundle');
    const rawBundle = path.resolve(options.rawBundle);
    const rawRoot = path.join(layout.repoRoot, 'raw', 'wechat');
    if (path.dirname(rawBundle) !== rawRoot || path.basename(rawBundle).startsWith('.')) {
      fail('complete 只接受 raw/wechat 下已发布的非隐藏直接子目录');
    }
    const [rawRootReal, rawReal] = await Promise.all([
      fs.realpath(rawRoot).catch(() => null),
      fs.realpath(rawBundle).catch(() => null),
    ]);
    if (!rawRootReal || !rawReal || path.dirname(rawReal) !== rawRootReal || path.basename(rawReal) !== path.basename(rawBundle)) {
      fail('raw bundle 真实路径不是 raw/wechat 的直接子目录');
    }
    const first = await verifyRaw(rawBundle, layout.repoRoot);
    const manifestPath = path.join(rawBundle, 'manifest.json');
    const manifest = parseJson(await readStableRegularFile(manifestPath, 'raw manifest', MAX_JSON_BYTES), 'raw manifest');
    if (manifest.source?.canonical_url !== job.canonical_url) fail('raw manifest URL 与请求 URL 不匹配');
    const verified = await verifyRaw(rawBundle, layout.repoRoot);
    if (first.bundle_checksum !== verified.bundle_checksum) fail('raw bundle 在 complete 校验期间发生变化');
    const relativeRaw = path.relative(layout.repoRoot, rawBundle).split(path.sep).join('/');
    const promoted = await writeJobAtomic(layout, {
      ...job,
      revision: job.revision + 1,
      status: 'promoted',
      updated_at: isoNow(),
      claim: null,
      terminal_claim: job.claim,
      result: {
        raw_bundle: relativeRaw,
        bundle_checksum: verified.bundle_checksum,
        content_checksum: verified.content_checksum,
        completed_at: isoNow(),
      },
      failure: null,
    }, job.revision);
    await releaseLock(layout, 'capture.lock', options.claimId, '全局 capture 锁');
    return { ok: true, action: 'promoted', request: promoted, lock_released: true };
  });
  if (result.locked) return { ok: false, action: 'job-locked', lock: result.lock };
  return result;
}

async function failRequest(options = {}) {
  const layout = await queueLayout(options.repo);
  const id = assertJobId(options.id);
  const health = await scan({ repo: layout.repoRoot });
  if (!health.ok) fail('请求队列完整性校验失败', health.failures);
  const code = typeof options.code === 'string' && /^[a-z0-9-]{1,64}$/.test(options.code) ? options.code : fail('failure code 无效');
  const message = boundedText(options.message, 'failure message');
  const result = await withTransientJobLock(layout, id, async () => {
    const { job } = await requireClaim(layout, id, options.claimId);
    const failed = await writeJobAtomic(layout, {
      ...job,
      revision: job.revision + 1,
      status: 'failed',
      updated_at: isoNow(),
      claim: null,
      terminal_claim: job.claim,
      result: null,
      failure: { code, message, failed_at: isoNow() },
    }, job.revision);
    await releaseLock(layout, 'capture.lock', options.claimId, '全局 capture 锁');
    return { ok: true, action: 'failed', request: failed, lock_released: true };
  });
  if (result.locked) return { ok: false, action: 'job-locked', lock: result.lock };
  return result;
}

async function retry(options = {}) {
  const layout = await queueLayout(options.repo);
  const id = assertJobId(options.id);
  const health = await scan({ repo: layout.repoRoot });
  if (!health.ok) fail('请求队列完整性校验失败', health.failures);
  const result = await withTransientJobLock(layout, id, async () => {
    const job = await readJob(layout, id);
    if (job.status !== 'failed') fail('只有 failed 请求可 retry');
    const queued = await writeJobAtomic(layout, {
      ...job,
      revision: job.revision + 1,
      status: 'queued',
      updated_at: isoNow(),
      claim: null,
      terminal_claim: null,
      result: null,
      failure: null,
      history: appendHistory(job, {
        event: 'failed-retry',
        terminal_claim: job.terminal_claim,
        failure: job.failure,
      }),
    }, job.revision);
    return { ok: true, action: 'retried', request: queued };
  });
  if (result.locked) return { ok: false, action: 'job-locked', lock: result.lock };
  return result;
}

async function refreshPromoted(options = {}) {
  if (options.ack !== 'refresh-unverified-promoted') {
    fail('refresh 需要 --ack refresh-unverified-promoted');
  }
  const layout = await queueLayout(options.repo);
  const id = assertJobId(options.id);
  const health = await scan({ repo: layout.repoRoot });
  if (!health.ok) fail('请求队列完整性校验失败', health.failures);
  if (health.capture_lock) return { ok: true, action: 'locked', lock: health.capture_lock };
  const result = await withTransientJobLock(layout, id, async () => {
    const job = await readJob(layout, id);
    if (job.status !== 'promoted') fail('只有 promoted 请求可 refresh');
    const rawBundle = path.resolve(layout.repoRoot, job.result.raw_bundle);
    const verified = await verifyRaw(rawBundle, layout.repoRoot);
    if (verified.bundle_checksum !== job.result.bundle_checksum
      || verified.content_checksum !== job.result.content_checksum
      || verified.canonical_url !== job.canonical_url) {
      fail('promoted 请求的既有 raw 复验失败');
    }
    if (verified.source_authenticity !== 'declared-only') {
      fail('只允许刷新 declared-only 的 promoted 请求');
    }
    const queued = await writeJobAtomic(layout, {
      ...job,
      revision: job.revision + 1,
      status: 'queued',
      updated_at: isoNow(),
      claim: null,
      terminal_claim: null,
      result: null,
      failure: null,
      history: appendHistory(job, {
        event: 'promoted-authenticity-refresh',
        previous_terminal_claim: job.terminal_claim,
        previous_result: job.result,
        previous_source_authenticity: verified.source_authenticity,
      }),
    }, job.revision);
    return { ok: true, action: 'refreshed', request: queued };
  });
  if (result.locked) return { ok: false, action: 'job-locked', lock: result.lock };
  return result;
}

function checkedRecoverLockName(value) {
  if (value === 'capture.lock' || /^dedupe-[a-f0-9]{64}\.lock$/.test(value || '')) return value;
  const match = /^job-(.+)\.lock$/.exec(value || '');
  if (match && JOB_ID.test(match[1])) return value;
  fail('recover 的 --lock 无效');
}

async function recoverLock(options = {}) {
  const layout = await queueLayout(options.repo);
  if (options.ack !== 'reviewed-owner-not-running') {
    fail('recover 需要 --ack reviewed-owner-not-running；不会按时间自动抢锁');
  }
  const name = checkedRecoverLockName(options.lock);
  if (typeof options.claimId !== 'string' || !options.claimId) fail('recover 需要 --claim-id');
  const owner = await readLockOwner(lockDirectory(layout, name), '请求锁');
  if (!owner || owner.claim_id !== options.claimId) fail('recover claim-id 与当前锁 owner 不匹配');
  if (name === 'capture.lock') {
    if (!JOB_ID.test(owner.request_id || '')) fail('capture 锁缺少可同步的 request_id，已拒绝恢复');
    const synchronized = await withTransientJobLock(layout, owner.request_id, async () => {
      const currentOwner = await readLockOwner(lockDirectory(layout, name), '请求锁');
      if (!currentOwner || currentOwner.claim_id !== options.claimId || currentOwner.request_id !== owner.request_id) {
        fail('recover 期间 capture 锁 owner 已变化');
      }
      const job = await readJob(layout, owner.request_id);
      if (job.status === 'capturing') {
        fail(job.claim?.claim_id === owner.claim_id
          ? `capture 仍属于活动请求 ${job.request_id}；请使用 complete 或 fail`
          : 'capture 锁与 capturing 请求冲突，已拒绝恢复');
      }
      if (['promoted', 'failed'].includes(job.status) && job.terminal_claim?.claim_id !== owner.claim_id) {
        fail('capture 锁与终态请求的 claim 不匹配');
      }
      await releaseLock(layout, name, options.claimId, '请求锁');
      return { ok: true, action: 'lock-recovered', lock: name, claim_id: options.claimId };
    });
    if (synchronized.locked) fail('request job 锁正在使用，已拒绝恢复');
    return synchronized;
  }
  await releaseLock(layout, name, options.claimId, '请求锁');
  return { ok: true, action: 'lock-recovered', lock: name, claim_id: options.claimId };
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
  return `微信 URL 请求队列\n\n用法:\n  wechat_request_queue.mjs enqueue --url URL [--repo PATH]\n  wechat_request_queue.mjs scan [--repo PATH]\n  wechat_request_queue.mjs claim [--id ID] [--repo PATH]\n  wechat_request_queue.mjs complete --id ID --claim-id ID --raw-bundle PATH [--repo PATH]\n  wechat_request_queue.mjs fail --id ID --claim-id ID --code CODE --message TEXT [--repo PATH]\n  wechat_request_queue.mjs retry --id ID [--repo PATH]\n  wechat_request_queue.mjs refresh --id ID --ack refresh-unverified-promoted [--repo PATH]\n  wechat_request_queue.mjs recover --lock LOCK --claim-id ID --ack reviewed-owner-not-running [--repo PATH]\n\n请求只存在 staging/requests；claim 可领取指定请求，且不会按时间自动回收既有锁；complete 仅验证既有 raw bundle。`;
}

async function main(argv) {
  if (!argv.length || ['help', '--help', '-h'].includes(argv[0])) {
    process.stdout.write(`${help()}\n`);
    return;
  }
  const { command, options } = parseArgs(argv);
  let result;
  if (command === 'enqueue') result = await enqueue(options);
  else if (command === 'scan') result = await scan(options);
  else if (command === 'claim') result = await claim(options);
  else if (command === 'complete') result = await complete(options);
  else if (command === 'fail') result = await failRequest(options);
  else if (command === 'retry') result = await retry(options);
  else if (command === 'refresh') result = await refreshPromoted(options);
  else if (command === 'recover') result = await recoverLock(options);
  else fail(`未知命令: ${command}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.ok === false) process.exitCode = 2;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: redact(error.message), details: redactValue(error.details) }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

export { claim, complete, enqueue, failRequest, recoverLock, refreshPromoted, retry, scan };
