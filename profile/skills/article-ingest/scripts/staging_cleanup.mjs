#!/usr/bin/env node

// Delete only stale, already-promoted capture stages.  This intentionally does
// not touch inboxes, request history, extension backups, logs, or raw bundles.
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { scanCompileQueue } from './article_compile_queue.mjs';
import { scan as scanRequestQueue } from '../../wechat-ingest/scripts/wechat_request_queue.mjs';
import { validateStage as validateWechatStage } from '../../wechat-ingest/scripts/wechat_ingest.mjs';
import { validateStage as validateXStage } from '../../x-ingest/scripts/x_ingest.mjs';
import { validateStage as validateBilibiliStage } from '../../bilibili-ingest/scripts/bilibili_ingest.mjs';
import { validateStage as validateYoutubeStage } from '../../youtube-ingest/scripts/youtube_ingest.mjs';
import { validateStage as validateWechatChannelsStage } from '../../wechat-channels-ingest/scripts/wechat_channels_ingest.mjs';

const DEFAULT_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 3650;
const COMPILE_LOCK = 'article-wiki-compiler.lock';
const PLATFORMS = [
  { platform: 'wechat', stageDirectory: 'wechat', validate: validateWechatStage },
  { platform: 'x', stageDirectory: 'x', validate: validateXStage },
  { platform: 'bilibili', stageDirectory: 'bilibili', validate: validateBilibiliStage },
  { platform: 'youtube', stageDirectory: 'youtube', validate: validateYoutubeStage },
  { platform: 'wechat-channels', stageDirectory: 'wechat-channels', validate: validateWechatChannelsStage },
];

function fail(message, details = undefined) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function posix(value) {
  return value.split(path.sep).join('/');
}

async function lstat(target) {
  return fs.lstat(target, { bigint: true }).catch(() => null);
}

async function plainOwnedDirectory(target, label, { required = true } = {}) {
  const stat = await lstat(target);
  if (!stat && !required) return null;
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail(`${label}不是当前用户控制的普通目录: ${target}`);
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())) fail(`${label}不属于当前用户: ${target}`);
    if ((stat.mode & 0o022n) !== 0n) fail(`${label}对 group/other 开放写权限: ${target}`);
  }
  return { dev: stat.dev, ino: stat.ino, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}

async function regularFile(target, label) {
  const stat = await lstat(target);
  if (!stat?.isFile() || stat.isSymbolicLink()) fail(`${label}不是普通文件: ${target}`);
  return stat;
}

async function resolveRepo(input) {
  const repo = path.resolve(input || process.cwd());
  await plainOwnedDirectory(repo, '仓库根目录');
  const agents = await lstat(path.join(repo, 'AGENTS.md'));
  const wiki = await lstat(path.join(repo, 'wiki'));
  if (!agents?.isFile() || agents.isSymbolicLink() || !wiki?.isDirectory() || wiki.isSymbolicLink()) fail(`不是有效 wiki 仓库: ${repo}`);
  return repo;
}

async function stableDirectory(target, expected, label) {
  const current = await plainOwnedDirectory(target, label);
  if (current.dev !== expected.dev || current.ino !== expected.ino) fail(`${label}在操作期间被替换: ${target}`);
}

async function walkStage(stage, root = stage, files = []) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(root, entry.name);
    if (!inside(stage, absolute)) fail(`暂存目录遍历越界: ${absolute}`);
    const stat = await lstat(absolute);
    if (!stat || stat.isSymbolicLink()) fail(`暂存目录包含符号链接或消失条目: ${absolute}`);
    if (stat.isDirectory()) await walkStage(stage, absolute, files);
    else if (stat.isFile()) files.push({ path: absolute, size: stat.size, mtimeNs: stat.mtimeNs });
    else fail(`暂存目录包含特殊文件: ${absolute}`);
  }
  return files;
}

async function stageSnapshot(stage) {
  const stat = await lstat(stage);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail(`候选不是普通目录: ${stage}`);
  const files = await walkStage(stage);
  if (!files.length) fail(`候选暂存目录为空: ${stage}`);
  const maxFileMtimeNs = files.reduce((current, file) => file.mtimeNs > current ? file.mtimeNs : current, 0n);
  return {
    dev: stat.dev,
    ino: stat.ino,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    max_file_mtime_ns: maxFileMtimeNs,
    bytes: files.reduce((total, file) => total + file.size, 0n),
    file_count: files.length,
  };
}

function sameSnapshot(left, right) {
  return left.dev === right.dev && left.ino === right.ino
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
    && left.max_file_mtime_ns === right.max_file_mtime_ns
    && left.bytes === right.bytes && left.file_count === right.file_count;
}

function sameIsolatedSnapshot(left, right) {
  return left.dev === right.dev && left.ino === right.ino
    && left.mtimeNs === right.mtimeNs
    && left.max_file_mtime_ns === right.max_file_mtime_ns
    && left.bytes === right.bytes && left.file_count === right.file_count;
}

async function atomicQuarantineDelete({ candidate, platformBase, expectedSnapshot, testHook }) {
  if (typeof testHook?.beforeDelete === 'function') {
    await testHook.beforeDelete({
      candidate: { platform: candidate.platform, stage: candidate.stage, raw_bundle: candidate.raw_bundle },
    });
  }
  const quarantine = path.join(platformBase, `.cleanup-quarantine-${randomUUID()}`);
  await fs.mkdir(quarantine, { mode: 0o700 });
  const isolated = path.join(quarantine, path.basename(candidate.stage));
  let isolatedPresent = false;
  try {
    await plainOwnedDirectory(quarantine, '清理隔离目录');
    await fs.rename(candidate.stage, isolated);
    isolatedPresent = true;
    const isolatedSnapshot = await stageSnapshot(isolated);
    if (!sameIsolatedSnapshot(expectedSnapshot, isolatedSnapshot)) {
      const original = await lstat(candidate.stage);
      if (!original) {
        await fs.rename(isolated, candidate.stage);
        isolatedPresent = false;
      }
      throw new Error('原子隔离对象与已验证候选身份不一致；未删除');
    }
    await fs.rm(isolated, { recursive: true, force: false, maxRetries: 0 });
    isolatedPresent = false;
  } finally {
    if (!isolatedPresent) await fs.rmdir(quarantine).catch(() => {});
  }
}

async function assertReadonlyRequestLayout(repo) {
  const requests = path.join(repo, 'staging', 'requests');
  await plainOwnedDirectory(requests, 'staging/requests');
  for (const name of ['.tmp', '.locks', '.dedupe']) {
    const target = path.join(requests, name);
    const stat = await lstat(target);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) fail(`请求队列缺少安全目录: ${target}`);
    if (process.platform !== 'win32' && ((stat.mode & 0o077n) !== 0n || (typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())))) {
      fail(`请求队列目录不满足私有所有权: ${target}`);
    }
  }
}

async function assertNoActiveClaims(repo) {
  await assertReadonlyRequestLayout(repo);
  const requestReport = await scanRequestQueue({ repo });
  if (!requestReport.ok) fail('请求队列完整性校验失败', requestReport.failures);
  if (requestReport.capture_lock || requestReport.requests.some((request) => request.status === 'capturing') || requestReport.locks.length) {
    fail('请求队列存在活动 claim 或锁，已全局停止清理', {
      capture_lock: requestReport.capture_lock,
      capturing: requestReport.requests.filter((request) => request.status === 'capturing').map((request) => request.request_id),
      locks: requestReport.locks.map((lock) => lock.name),
    });
  }
  const locks = path.join(repo, 'staging', '.locks');
  const lockStat = await lstat(locks);
  if (!lockStat) return;
  if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) fail(`编译锁目录不是普通目录: ${locks}`);
  for (const entry of await fs.readdir(locks, { withFileTypes: true })) {
    const target = path.join(locks, entry.name);
    if (entry.name !== COMPILE_LOCK || entry.isSymbolicLink() || !entry.isFile()) fail(`编译锁目录包含未知或非普通条目: ${target}`);
    await regularFile(target, '编译锁');
    fail('存在活动编译 claim，已全局停止清理', { lock: target });
  }
}

function stageIdentity(validation, platform) {
  if (platform === 'wechat') return {
    canonical_url: validation.capture.source.canonical_url,
    content_checksum: validation.content_checksum,
  };
  return {
    canonical_url: validation.capture.source.canonical_url,
    content_checksum: validation.content_checksum,
  };
}

async function readManifestCanonical(bundle) {
  const manifest = path.join(bundle.raw_bundle, 'manifest.json');
  await regularFile(manifest, 'raw manifest');
  let value;
  try {
    value = JSON.parse(await fs.readFile(manifest, 'utf8'));
  } catch (error) {
    fail(`raw manifest 无法解析: ${manifest}: ${error.message}`);
  }
  if (typeof value?.source?.canonical_url !== 'string') fail(`raw manifest 缺少 canonical URL: ${manifest}`);
  return value.source.canonical_url;
}

async function matchingBundle(queue, identity, platform) {
  const candidates = [];
  for (const bundle of queue.bundles.filter((item) => item.platform === platform && item.content_checksum === identity.content_checksum)) {
    if (await readManifestCanonical(bundle) === identity.canonical_url) candidates.push(bundle);
  }
  if (candidates.length !== 1) return { bundle: null, reason: candidates.length ? 'multiple-matching-raw-bundles' : 'no-matching-verified-raw-bundle' };
  const bundle = candidates[0];
  if (bundle.state !== 'consistent') return { bundle: null, reason: `compile-state-${bundle.state}` };
  return { bundle, reason: null };
}

function parseRetention(value) {
  const source = value ?? String(DEFAULT_RETENTION_DAYS);
  if (!/^[1-9]\d*$/.test(source)) fail('--retention-days 必须是合理正整数');
  const days = Number(source);
  if (!Number.isSafeInteger(days) || days > MAX_RETENTION_DAYS) fail(`--retention-days 必须介于 1 和 ${MAX_RETENTION_DAYS}`);
  return days;
}

function parseNow(value) {
  if (value === undefined) return new Date();
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value))) fail('--now 必须是有效 ISO 时间');
  return new Date(value);
}

async function queueForCleanup(repo) {
  const queue = await scanCompileQueue(repo);
  if (queue.integrity_failures.length) fail('raw 或编译队列完整性校验失败', queue.integrity_failures);
  return queue;
}

async function inspectCandidate({ repo, base, platform, entry, cutoffNs, queue }) {
  const stage = path.resolve(base, entry.name);
  if (!inside(base, stage) || stage === base) return { retained: { platform, stage, reason: 'boundary-path-rejected' } };
  if (entry.isSymbolicLink() || !entry.isDirectory()) return { retained: { platform, stage, reason: 'not-a-direct-normal-directory' } };
  let snapshot;
  try {
    snapshot = await stageSnapshot(stage);
  } catch (error) {
    return { retained: { platform, stage, reason: 'unsafe-stage-structure', detail: error.message } };
  }
  if (snapshot.mtimeNs >= cutoffNs || snapshot.max_file_mtime_ns >= cutoffNs) {
    return { retained: { platform, stage, reason: 'within-retention-window' } };
  }
  let validation;
  try {
    validation = await PLATFORMS.find((item) => item.platform === platform).validate(stage, repo);
  } catch (error) {
    return { retained: { platform, stage, reason: 'stage-validation-failed', detail: error.message } };
  }
  const identity = stageIdentity(validation, platform);
  const matched = await matchingBundle(queue, identity, platform);
  if (!matched.bundle) return { retained: { platform, stage, reason: matched.reason } };
  return {
    eligible: {
      platform,
      stage,
      snapshot,
      identity,
      raw_bundle: matched.bundle.raw_bundle,
      bundle_checksum: matched.bundle.bundle_checksum,
      bytes: snapshot.bytes,
    },
  };
}

async function runCleanup(options = {}) {
  const repo = await resolveRepo(options.repo);
  const retentionDays = parseRetention(options.retentionDays);
  const now = parseNow(options.now);
  const cutoffNs = BigInt(now.getTime() - retentionDays * 24 * 60 * 60 * 1000) * 1_000_000n;
  const staging = path.join(repo, 'staging');
  const raw = path.join(repo, 'raw');
  const stagingIdentity = await plainOwnedDirectory(staging, 'staging');
  const rawIdentity = await plainOwnedDirectory(raw, 'raw');
  await assertNoActiveClaims(repo);
  const queue = await queueForCleanup(repo);
  const eligible = [];
  const retained = [];
  const stageBaseIdentities = new Map();
  for (const adapter of PLATFORMS) {
    const base = path.join(staging, adapter.stageDirectory);
    const baseIdentity = await plainOwnedDirectory(base, `staging/${adapter.stageDirectory}`, { required: false });
    if (!baseIdentity) continue;
    stageBaseIdentities.set(adapter.platform, baseIdentity);
    for (const entry of (await fs.readdir(base, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === '.gitkeep') continue;
      const result = await inspectCandidate({ repo, base, platform: adapter.platform, entry, cutoffNs, queue });
      if (result.eligible) eligible.push(result.eligible);
      else retained.push(result.retained);
    }
  }
  const mode = options.apply ? 'apply' : 'dry-run';
  const deleted = [];
  let bytesReclaimed = 0n;
  if (options.apply) {
    for (const candidate of eligible) {
      try {
        // Re-check the whole destructive boundary for every candidate. A lock,
        // queue/raw change, or replaced platform base after one deletion stops
        // the remaining candidates rather than using stale preflight state.
        await stableDirectory(staging, stagingIdentity, 'staging');
        await stableDirectory(raw, rawIdentity, 'raw');
        const platformBase = path.join(staging, candidate.platform);
        await stableDirectory(platformBase, stageBaseIdentities.get(candidate.platform), `staging/${candidate.platform}`);
        await assertNoActiveClaims(repo);
        const freshQueue = await queueForCleanup(repo);
        const current = await stageSnapshot(candidate.stage);
        if (!sameSnapshot(candidate.snapshot, current)) throw new Error('候选在删除前发生变化');
        if (current.mtimeNs >= cutoffNs || current.max_file_mtime_ns >= cutoffNs) throw new Error('候选在删除前回到保留期内');
        const validation = await PLATFORMS.find((item) => item.platform === candidate.platform).validate(candidate.stage, repo);
        const identity = stageIdentity(validation, candidate.platform);
        if (identity.canonical_url !== candidate.identity.canonical_url || identity.content_checksum !== candidate.identity.content_checksum) throw new Error('候选内容校验和或 canonical URL 已变化');
        const matched = await matchingBundle(freshQueue, identity, candidate.platform);
        if (!matched.bundle || matched.bundle.raw_bundle !== candidate.raw_bundle || matched.bundle.bundle_checksum !== candidate.bundle_checksum) throw new Error(matched.reason || '匹配 raw bundle 已变化');
        const directParent = path.dirname(candidate.stage);
        if (!inside(path.join(staging, candidate.platform), candidate.stage) || directParent !== path.join(staging, candidate.platform)) throw new Error('删除边界校验失败');
        await atomicQuarantineDelete({
          candidate,
          platformBase,
          expectedSnapshot: current,
          testHook: options.testHook,
        });
        deleted.push({ platform: candidate.platform, stage: candidate.stage, raw_bundle: candidate.raw_bundle });
        bytesReclaimed += candidate.bytes;
        if (typeof options.testHook?.afterDelete === 'function') {
          await options.testHook.afterDelete({
            deleted: [...deleted],
            candidate: { platform: candidate.platform, stage: candidate.stage, raw_bundle: candidate.raw_bundle },
          });
        }
      } catch (error) {
        const existingDetails = error?.details;
        if (error && typeof error === 'object') {
          error.details = {
            partial_progress: {
              deleted: [...deleted],
              bytes_reclaimed: Number(bytesReclaimed),
              stopped_before: { platform: candidate.platform, stage: candidate.stage },
            },
            ...(existingDetails === undefined ? {} : { cause_details: existingDetails }),
          };
          throw error;
        }
        fail(String(error), {
          partial_progress: {
            deleted: [...deleted],
            bytes_reclaimed: Number(bytesReclaimed),
            stopped_before: { platform: candidate.platform, stage: candidate.stage },
          },
        });
      }
    }
  }
  return {
    ok: true,
    mode,
    repo_root: repo,
    retention_days: retentionDays,
    cutoff: new Date(Number(cutoffNs / 1_000_000n)).toISOString(),
    eligible: eligible.map((item) => ({ platform: item.platform, stage: item.stage, raw_bundle: item.raw_bundle, bundle_checksum: item.bundle_checksum, bytes: Number(item.bytes) })),
    deleted,
    retained,
    bytes_reclaimed: Number(bytesReclaimed),
  };
}

function parseArgs(argv) {
  const options = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--apply') {
      if (options.apply) fail('参数重复: --apply');
      options.apply = true;
      continue;
    }
    if (!['--repo', '--retention-days', '--now'].includes(item) || Object.hasOwn(options, item.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase()))) fail(`无效或重复参数: ${item}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) fail(`参数缺少值: ${item}`);
    options[item.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = value;
  }
  return options;
}

async function main(argv) {
  if (!argv.length || ['help', '--help', '-h'].includes(argv[0])) {
    process.stdout.write('安全暂存清理器\n\n用法:\n  staging_cleanup.mjs [--repo PATH] [--retention-days 30] [--now ISO] [--apply]\n\n默认 dry-run；只有 --apply 才会删除已验证且已编译一致的 staging/wechat、staging/x、staging/bilibili 或 staging/youtube 直接子目录。\n');
    return;
  }
  const result = await runCleanup(parseArgs(argv));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (direct) {
  main(process.argv.slice(2)).catch((error) => {
    process.stdout.write(JSON.stringify({ ok: false, mode: 'fail-closed', error: error.message, details: error.details }, null, 2) + '\n');
    process.exitCode = 2;
  });
}

export { runCleanup };
