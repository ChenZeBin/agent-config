#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { scanInbox } from './wechat_inbox.mjs';
import { promoteStage, verifyRaw } from './wechat_ingest.mjs';
import {
  claim,
  complete,
  enqueue,
  failRequest,
  refreshPromoted,
  retry,
} from './wechat_request_queue.mjs';
import { captureUrlToInbox } from './wechat_url_capture.mjs';
import { captureHttpToStage } from './wechat_http_capture.mjs';

function fail(message, details = undefined) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

async function exists(target) {
  return fs.access(target).then(() => true, () => false);
}

function safeMessage(error) {
  return String(error?.message || error || 'unknown capture failure')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(wechatsync_token|mcp_token|access_token|refresh_token|authorization|token)\s*([=:])\s*([^\s,;]+)/gi, '$1$2[REDACTED]')
    .slice(0, 500);
}

async function promoteInboxCandidate(repoRoot, outputName) {
  const scan = await scanInbox({ repo: repoRoot, target: outputName, urlZipVerified: true });
  if (!scan.ok) fail('inbox 扫描包含失败条目', scan.entries.filter((entry) => ['failed', 'rejected'].includes(entry.status)));
  const candidate = scan.entries.find((entry) => entry.input === outputName);
  if (!candidate) fail(`inbox 扫描未返回候选: ${outputName}`);
  if (!['promoted', 'duplicate-noop'].includes(candidate.status) || !candidate.raw_bundle) {
    fail(`inbox 候选未晋升: ${candidate.status}`, candidate);
  }
  return candidate;
}

async function verifyPromotedRequest(repoRoot, request) {
  const result = request?.result;
  const rawBundle = result?.raw_bundle;
  if (typeof rawBundle !== 'string' || !/^raw\/wechat\/[^./][^/]*$/.test(rawBundle)) {
    fail('promoted 请求缺少安全的 raw_bundle');
  }
  const rawRoot = path.join(repoRoot, 'raw', 'wechat');
  const rawPath = path.resolve(repoRoot, rawBundle);
  if (path.dirname(rawPath) !== rawRoot || path.basename(rawPath).startsWith('.')) fail('promoted raw_bundle 越出 raw/wechat 直接子目录');
  const [rawRootReal, rawReal] = await Promise.all([fs.realpath(rawRoot), fs.realpath(rawPath)]);
  if (path.dirname(rawReal) !== rawRootReal || path.basename(rawReal) !== path.basename(rawPath)) {
    fail('promoted raw_bundle 真实路径无效');
  }
  const verified = await verifyRaw(rawPath, repoRoot);
  if (result.bundle_checksum && result.bundle_checksum !== verified.bundle_checksum) fail('promoted bundle_checksum 不匹配');
  if (result.content_checksum && result.content_checksum !== verified.content_checksum) fail('promoted content_checksum 不匹配');
  if (verified.canonical_url !== request.canonical_url) fail('promoted manifest canonical_url 与请求不匹配');
  return {
    ok: true,
    action: 'already-promoted',
    capture_exercised: false,
    raw_bundle: rawPath,
    bundle_checksum: verified.bundle_checksum,
    content_checksum: verified.content_checksum,
    source_authenticity: verified.source_authenticity,
    review_required: !['browser-extension-verified', 'wechat-origin-response'].includes(verified.source_authenticity),
    request,
  };
}

function outputNameForClaim(requestId, claimId) {
  const safeClaim = String(claimId || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 32);
  if (!safeClaim) fail('claim_id 无法生成安全输出名');
  return `${requestId}--${safeClaim}.zip`;
}

async function ingestUrl(options = {}) {
  if (!options.url) fail('ingest-url 需要 --url');
  const repoRoot = path.resolve(options.repo || process.cwd());
  let queued = await enqueue({ url: options.url, repo: repoRoot });
  if (queued.action === 'locked') fail('URL 去重锁正在使用', queued.lock);
  let request = queued.request;
  if (!request) fail(`enqueue 未返回请求: ${queued.action}`);

  if (request.status === 'promoted') {
    const verified = await verifyPromotedRequest(repoRoot, request);
    if (!verified.review_required) return verified;
    const refreshed = await refreshPromoted({
      id: request.request_id,
      repo: repoRoot,
      ack: 'refresh-unverified-promoted',
    });
    if (refreshed.action === 'locked') fail('未验证 promoted 请求等待刷新，但 capture 锁正在使用', refreshed.lock);
    if (refreshed.action !== 'refreshed') fail(`无法刷新未验证 promoted 请求: ${refreshed.action}`, refreshed);
    request = refreshed.request;
  }
  if (request.status === 'failed') {
    queued = await retry({ id: request.request_id, repo: repoRoot });
    request = queued.request;
  }
  if (request.status === 'capturing') fail('该 URL 正由另一任务采集', { request_id: request.request_id });
  if (request.status !== 'queued') fail(`请求状态不可采集: ${request.status}`);

  const claimed = await claim({ id: request.request_id, repo: repoRoot });
  if (claimed.action !== 'claimed') fail(`无法领取 URL 请求: ${claimed.action}`, claimed);
  const claimId = claimed.lock?.claim_id;
  if (!claimId) fail('claim 未返回 claim_id');
  const outputName = outputNameForClaim(request.request_id, claimId);
  const outputPath = path.join(repoRoot, 'staging', 'inbox', outputName);
  let directFailure = null;
  try {
    let direct = null;
    try {
      const staged = await captureHttpToStage({
        url: request.canonical_url,
        repo: repoRoot,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      try {
        const promoted = await promoteStage(staged.stage, repoRoot);
        const verified = await verifyRaw(promoted.raw_bundle, repoRoot);
        direct = { staged, promoted, verified };
      } finally {
        await fs.rm(staged.stage, { recursive: true, force: true });
      }
    } catch (error) {
      directFailure = safeMessage(error);
    }
    if (direct) {
      const completed = await complete({
        id: request.request_id,
        claimId,
        rawBundle: direct.promoted.raw_bundle,
        repo: repoRoot,
      });
      return {
        ok: true,
        action: 'http-captured-promoted',
        capture_exercised: true,
        raw_bundle: direct.promoted.raw_bundle,
        bundle_checksum: direct.verified.bundle_checksum,
        content_checksum: direct.verified.content_checksum,
        source_authenticity: direct.verified.source_authenticity,
        review_required: false,
        request: completed.request,
        capture: {
          method: 'wechat-origin-response',
          canonical_url: stagedCanonicalUrl(direct.staged, request.canonical_url),
          warnings: direct.promoted.warnings || direct.staged.warnings || [],
        },
      };
    }
    if (await exists(outputPath)) fail(`拒绝复用既有 inbox 输出: ${outputName}`);
    const capture = await (options.captureImpl || captureUrlToInbox)({
      url: request.canonical_url,
      output: outputName,
      repo: repoRoot,
      port: options.port,
      timeout: options.timeout,
    });
    const candidate = await promoteInboxCandidate(repoRoot, outputName);
    const completed = await complete({
      id: request.request_id,
      claimId,
      rawBundle: candidate.raw_bundle,
      repo: repoRoot,
    });
    return {
      ok: true,
      action: 'captured-promoted',
      capture_exercised: true,
      raw_bundle: candidate.raw_bundle,
      bundle_checksum: candidate.bundle_checksum,
      content_checksum: completed.request.result.content_checksum,
      source_authenticity: (await verifyRaw(candidate.raw_bundle, repoRoot)).source_authenticity,
      review_required: false,
      request: completed.request,
      capture,
      fallback: { direct_http_failure: directFailure },
      inbox: { input: outputName, status: candidate.status },
    };
  } catch (error) {
    let recorded = null;
    const failureMessage = directFailure
      ? safeMessage(`direct HTTP failed: ${directFailure}; extension fallback failed: ${safeMessage(error)}`)
      : safeMessage(error);
    try {
      recorded = await failRequest({
        id: request.request_id,
        claimId,
        code: 'automatic-capture-failed',
        message: failureMessage,
        repo: repoRoot,
      });
    } catch (recordError) {
      error.details = { ...(error.details || {}), failure_record_error: safeMessage(recordError) };
    }
    const failureRecordError = error.details?.failure_record_error;
    error.details = {
      ...(failureRecordError ? { failure_record_error: safeMessage(failureRecordError) } : {}),
      ...(directFailure ? { direct_http_failure: directFailure } : {}),
      request_id: request.request_id,
      failure_recorded: recorded?.action === 'failed',
    };
    throw error;
  }
}

function stagedCanonicalUrl(staged, fallback) {
  return typeof staged?.canonical_url === 'string' ? staged.canonical_url : fallback;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith('--')) fail(`无法识别的参数: ${item}`);
    const key = item.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) fail(`参数缺少值: ${item}`);
    if (Object.hasOwn(options, key)) fail(`参数重复: ${item}`);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

async function main(argv) {
  const { command, options } = parseArgs(argv);
  if (command !== 'ingest-url') fail('用法: wechat_auto_capture.mjs ingest-url --url URL [--repo PATH] [--timeout MS]');
  process.stdout.write(`${JSON.stringify(await ingestUrl(options), null, 2)}\n`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: safeMessage(error), details: error.details }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

export { ingestUrl, outputNameForClaim, promoteInboxCandidate, safeMessage, verifyPromotedRequest };
