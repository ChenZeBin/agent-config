#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { verifyRaw as verifyWechatRaw } from '../../wechat-ingest/scripts/wechat_ingest.mjs';
import { verifyRaw as verifyXRaw } from '../../x-ingest/scripts/x_ingest.mjs';
import { verifyRaw as verifyBilibiliRaw } from '../../bilibili-ingest/scripts/bilibili_ingest.mjs';
import { verifyRaw as verifyYoutubeRaw } from '../../youtube-ingest/scripts/youtube_ingest.mjs';
import { verifyRaw as verifyWechatChannelsRaw } from '../../wechat-channels-ingest/scripts/wechat_channels_ingest.mjs';

const LOCK_NAME = 'article-wiki-compiler.lock';
const PLATFORMS = [
  { platform: 'wechat', directory: 'wechat', verify: verifyWechatRaw },
  { platform: 'x', directory: 'x', verify: verifyXRaw },
  { platform: 'bilibili', directory: 'bilibili', verify: verifyBilibiliRaw },
  { platform: 'youtube', directory: 'youtube', verify: verifyYoutubeRaw },
  { platform: 'wechat-channels', directory: 'wechat-channels', verify: verifyWechatChannelsRaw },
];
const VALID_SOURCE_STATUSES = new Set(['active', 'needs-review', 'superseded']);
const VALID_CONTENT_STATUSES = new Set(['active', 'draft', 'needs-review', 'superseded']);
// yt-dlp is a credential-free extraction tool, not an independently authenticated
// YouTube response. YouTube bundles therefore remain needs-review even when their
// local bytes and video-ID binding verify deterministically.
const TRUSTED_AUTHENTICITY = new Set(['browser-extension-verified', 'wechat-origin-response', 'wechat-channels-origin-api', 'x-syndication']);
const QUALITY_REVIEWS_DIRECTORY = 'quality-reviews';
const QUALITY_RUBRIC = '.agents/skills/wiki-knowledge-loop/references/quality-rubric.md';
const QUALITY_DIMENSIONS = [
  'source_coverage',
  'claim_support',
  'uncertainty',
  'knowledge_integration',
  'reusability',
  'information_discipline',
];
const QUALITY_HARD_GATES = [
  'raw_integrity',
  'provenance_consistency',
  'valid_evidence_anchors',
  'no_unsupported_material_claims',
  'wiki_bookkeeping_sync',
  'positive_knowledge_value',
  'coverage_map_complete',
  'integration_decision',
];
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SHARED_CANONICAL_PAGE_STALE = 'shared-canonical-page-stale';

function fail(message, details) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

function posix(value) {
  return value.split(path.sep).join('/');
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function exists(target) {
  try {
    await fs.access(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function regularFile(target, label) {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) fail(label + '不是普通文件: ' + target);
  return stat;
}

async function regularFileInside(root, target, label) {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  if (!inside(absoluteRoot, absoluteTarget)) fail(label + '越界: ' + target);
  const [realRoot, realTarget] = await Promise.all([
    fs.realpath(absoluteRoot),
    fs.realpath(absoluteTarget).catch(() => null),
  ]);
  const expectedTarget = path.resolve(realRoot, path.relative(absoluteRoot, absoluteTarget));
  if (!realTarget || realTarget !== expectedTarget || !inside(realRoot, realTarget)) fail(label + '路径含符号链接或不存在: ' + target);
  return regularFile(absoluteTarget, label);
}

async function plainDirectory(target, label, create = false) {
  let stat = await fs.lstat(target).catch(() => null);
  if (!stat && create) {
    await fs.mkdir(target);
    stat = await fs.lstat(target);
  }
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail(label + '不是普通目录: ' + target);
  return target;
}

async function resolveRepoRoot(input) {
  let current = path.resolve(input || process.cwd());
  while (true) {
    const rootStat = await fs.lstat(current).catch(() => null);
    const agentsStat = await fs.lstat(path.join(current, 'AGENTS.md')).catch(() => null);
    const wikiStat = await fs.lstat(path.join(current, 'wiki')).catch(() => null);
    if (rootStat?.isDirectory() && !rootStat.isSymbolicLink()
      && agentsStat?.isFile() && !agentsStat.isSymbolicLink()
      && wikiStat?.isDirectory() && !wikiStat.isSymbolicLink()) return current;
    const parent = path.dirname(current);
    if (parent === current || input) fail('不是有效 wiki 仓库: ' + current);
    current = parent;
  }
}

async function readJson(target, label) {
  await regularFile(target, label);
  try {
    return JSON.parse(await fs.readFile(target, 'utf8'));
  } catch (error) {
    fail(label + '无法解析: ' + target + ': ' + error.message);
  }
}

async function sha256(target, label) {
  await regularFile(target, label);
  return 'sha256:' + createHash('sha256').update(await fs.readFile(target)).digest('hex');
}

async function markdownFiles(root) {
  if (!await exists(root)) return [];
  await plainDirectory(root, '来源页目录');
  const results = [];
  async function walk(current) {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) fail('来源页目录不允许符号链接: ' + absolute);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && entry.name.endsWith('.md')) results.push(absolute);
      else if (!entry.isFile()) fail('来源页目录含特殊文件: ' + absolute);
    }
  }
  await walk(root);
  return results;
}

function frontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match?.[1] || '';
}

function unquote(value) {
  const trimmed = String(value || '').trim();
  const match = trimmed.match(/^(?:"([\s\S]*)"|'([\s\S]*)')$/);
  return match ? match[1] ?? match[2] : trimmed;
}

function scalar(yaml, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = yaml.match(new RegExp('^\\s*' + escaped + ':\\s*(.*?)\\s*$', 'm'));
  const value = unquote(match?.[1]);
  return value && value !== 'null' ? value : null;
}

function list(yaml, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lines = yaml.split(/\r?\n/);
  const values = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(new RegExp('^(\\s*)' + escaped + ':\\s*(.*?)\\s*$'));
    if (!match) continue;
    const indent = match[1].length;
    const inline = match[2].trim();
    if (inline.startsWith('[') && inline.endsWith(']')) {
      for (const value of inline.slice(1, -1).split(',').map(unquote).filter(Boolean)) values.push(value);
      continue;
    }
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (!lines[cursor].trim()) continue;
      const currentIndent = lines[cursor].match(/^\s*/)[0].length;
      if (currentIndent <= indent) break;
      const item = lines[cursor].match(/^\s*-\s*(.*?)\s*$/);
      if (item?.[1]) values.push(unquote(item[1]));
    }
  }
  return values.filter((value) => value && value !== 'null');
}

async function sourceRecords(repoRoot) {
  const records = [];
  for (const page of await markdownFiles(path.join(repoRoot, 'wiki', 'sources'))) {
    const text = await fs.readFile(page, 'utf8');
    const yaml = frontmatter(text);
    const rawManifest = scalar(yaml, 'raw_manifest');
    const rawChecksum = scalar(yaml, 'raw_checksum');
    const sources = list(yaml, 'sources');
    records.push({
      page,
      type: scalar(yaml, 'type'),
      status: scalar(yaml, 'status'),
      raw_manifest: rawManifest,
      resolved_manifest: rawManifest ? path.resolve(path.dirname(page), rawManifest) : null,
      raw_checksum: rawChecksum,
      resolved_sources: sources.map((value) => path.resolve(path.dirname(page), value)),
      text,
    });
  }
  return records;
}

async function wikiContentBaseline(repoRoot) {
  const baseline = {};
  for (const category of ['sources', 'concepts', 'entities', 'analyses']) {
    for (const page of await markdownFiles(path.join(repoRoot, 'wiki', category))) {
      baseline[posix(path.relative(repoRoot, page))] = await sha256(page, 'Wiki 内容页');
    }
  }
  return baseline;
}

function visibleMarkdownBody(text) {
  return text
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

async function bodyQualityReasons(repoRoot, page) {
  const body = visibleMarkdownBody(page.text);
  const substantiveLines = body.split(/\r?\n/).map((line) => line.trim()).filter((line) => line
    && !/^#{1,6}\s/.test(line)
    && !/^(?:---|\*\*\*|___)$/.test(line)
    && !/^\[\^[^\]]+\]:/.test(line));
  const visible = substantiveLines.join(' ')
    .replace(/!?\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/[`*_>#|~\[\](){}/\\-]/g, ' ');
  const semanticCharacters = [...visible.matchAll(/[\p{L}\p{N}]/gu)].length;
  const reasons = [];
  if (!substantiveLines.length || semanticCharacters === 0) reasons.push('source-page-empty-body');
  else if (substantiveLines.length < 3 || semanticCharacters < 80) reasons.push('source-page-thin-body');
  const rawRoot = path.join(repoRoot, 'raw');
  let validRawLocator = false;
  for (const match of body.matchAll(/(?<!!)\[[^\]\n]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
    const target = match[1].replace(/^<|>$/g, '').split('#', 1)[0];
    if (!target || /^(?:[a-z]+:|#)/i.test(target)) continue;
    const resolved = path.resolve(path.dirname(page.page), target);
    if (!inside(rawRoot, resolved)) continue;
    try {
      await regularFileInside(rawRoot, resolved, '来源页 raw locator');
      validRawLocator = true;
      break;
    } catch {
      // Continue: another precise raw locator may still be valid.
    }
  }
  if (!validRawLocator) reasons.push('source-page-raw-locator-missing');
  return reasons;
}

function linkedCanonicalPages(repoRoot, page) {
  const wikiRoot = path.join(repoRoot, 'wiki');
  const body = visibleMarkdownBody(page.text);
  const pages = new Set();
  for (const match of body.matchAll(/(?<!!)\[[^\]\n]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
    const target = match[1].replace(/^<|>$/g, '').split('#', 1)[0];
    if (!target || /^(?:[a-z]+:|#)/i.test(target)) continue;
    const resolved = path.resolve(path.dirname(page.page), target);
    const relative = posix(path.relative(repoRoot, resolved));
    if (inside(wikiRoot, resolved) && canonicalContentPage(relative)) pages.add(relative);
  }
  return [...pages].sort();
}

function canonicalContentPage(relative) {
  return typeof relative === 'string'
    && relative === path.posix.normalize(relative)
    && /^wiki\/(?:concepts|entities|analyses)\/.+\.md$/.test(relative);
}

function canonicalPageType(relative) {
  const category = relative.split('/')[1];
  return { concepts: 'concept', entities: 'entity', analyses: 'analysis' }[category] || null;
}

function markdownLinkTargets(text) {
  return [...text.matchAll(/(?<!!)\[[^\]\n]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)]
    .map((match) => match[1].replace(/^<|>$/g, '').split('#', 1)[0])
    .filter((target) => target && !/^(?:[a-z]+:|#)/i.test(target));
}

async function canonicalPageIntegrityReasons(repoRoot, relative) {
  const reasons = [];
  const wikiRoot = path.join(repoRoot, 'wiki');
  const rawRoot = path.join(repoRoot, 'raw');
  const page = path.resolve(repoRoot, relative);
  let text;
  try {
    await regularFileInside(wikiRoot, page, '共享 canonical 页');
    text = await fs.readFile(page, 'utf8');
  } catch {
    return ['shared-canonical-page-invalid-file:' + relative];
  }
  const yaml = frontmatter(text);
  if (!yaml) return ['shared-canonical-page-missing-frontmatter:' + relative];
  const type = scalar(yaml, 'type');
  const status = scalar(yaml, 'status');
  for (const key of ['title', 'type', 'status', 'created', 'updated']) {
    if (!scalar(yaml, key)) reasons.push('shared-canonical-page-missing-frontmatter-field:' + relative + ':' + key);
  }
  if (type !== canonicalPageType(relative)) reasons.push('shared-canonical-page-type-invalid:' + relative);
  if (!VALID_CONTENT_STATUSES.has(status)) reasons.push('shared-canonical-page-status-invalid:' + relative);
  const sources = list(yaml, 'sources');
  const declaredRawSources = new Set();
  if (!sources.length && status !== 'draft') reasons.push('shared-canonical-page-missing-sources:' + relative);
  for (const source of sources) {
    if (path.isAbsolute(source)) {
      reasons.push('shared-canonical-page-raw-source-invalid:' + relative + ':' + source);
      continue;
    }
    const sourcePath = path.resolve(path.dirname(page), source);
    try {
      await regularFileInside(rawRoot, sourcePath, '共享 canonical 页 raw source');
      declaredRawSources.add(sourcePath);
    } catch {
      reasons.push('shared-canonical-page-raw-source-invalid:' + relative + ':' + source);
    }
  }
  let validRawLocator = false;
  for (const target of markdownLinkTargets(visibleMarkdownBody(text))) {
    const targetPath = path.resolve(path.dirname(page), target);
    try {
      await regularFileInside(repoRoot, targetPath, '共享 canonical 页相对链接');
      if (inside(rawRoot, targetPath) && declaredRawSources.has(targetPath)) validRawLocator = true;
    } catch {
      reasons.push('shared-canonical-page-broken-relative-link:' + relative + ':' + target);
    }
  }
  if (sources.length && !validRawLocator) reasons.push('shared-canonical-page-raw-locator-missing:' + relative);
  return reasons;
}

function scoreMap(scores) {
  if (Array.isArray(scores)) {
    return Object.fromEntries(scores
      .filter((item) => item && typeof item.dimension === 'string')
      .map((item) => [item.dimension, item.score]));
  }
  return scores && typeof scores === 'object' ? scores : {};
}

function hasLineLocator(locator) {
  return locator && typeof locator === 'object' && !Array.isArray(locator)
    && locator.kind === 'lines' && Number.isInteger(locator.start) && Number.isInteger(locator.end)
    && locator.start >= 1 && locator.end >= locator.start;
}

async function evidenceRecordValid(repoRoot, rawBundle, boundWikiPages, record, kind) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || typeof record.path !== 'string' || path.isAbsolute(record.path) || !hasLineLocator(record.locator)) return false;
  const root = kind === 'raw' ? rawBundle : path.join(repoRoot, 'wiki');
  if (!record.path.startsWith(kind === 'raw' ? 'raw/' : 'wiki/')) return false;
  const absolute = path.resolve(repoRoot, record.path);
  if (!inside(root, absolute)) return false;
  if (kind === 'wiki' && !boundWikiPages.has(record.path)) return false;
  try {
    await regularFileInside(root, absolute, `质量 receipt ${kind} evidence`);
    const lineCount = (await fs.readFile(absolute, 'utf8')).split(/\r?\n/).length;
    return record.locator.end <= lineCount;
  } catch {
    return false;
  }
}

async function validEvidence(repoRoot, rawBundle, boundWikiPages, evidence) {
  // Versioned structural evidence prevents a reviewer assertion from being
  // mistaken for an independently checkable locator.
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) || evidence.version !== 1
    || !Array.isArray(evidence.raw) || evidence.raw.length === 0
    || !Array.isArray(evidence.wiki) || evidence.wiki.length === 0) return false;
  const [raw, wiki] = await Promise.all([
    Promise.all(evidence.raw.map((record) => evidenceRecordValid(repoRoot, rawBundle, boundWikiPages, record, 'raw'))),
    Promise.all(evidence.wiki.map((record) => evidenceRecordValid(repoRoot, rawBundle, boundWikiPages, record, 'wiki'))),
  ]);
  return raw.every(Boolean) && wiki.every(Boolean);
}

async function qualityReceipts(repoRoot) {
  const directory = path.join(repoRoot, QUALITY_REVIEWS_DIRECTORY);
  const stat = await fs.lstat(directory).catch(() => null);
  if (!stat) return { receipts: [], directory_error: null };
  if (!stat.isDirectory() || stat.isSymbolicLink()) return { receipts: [], directory_error: 'quality-receipts-directory-invalid' };
  const receipts = [];
  let directoryError = null;
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) {
      directoryError ||= 'quality-receipts-entry-invalid:' + entry.name;
      continue;
    }
    const receiptPath = path.join(directory, entry.name);
    try {
      receipts.push({ path: receiptPath, value: await readJson(receiptPath, '质量 receipt') });
    } catch {
      directoryError ||= 'quality-receipt-malformed:' + entry.name;
    }
  }
  return { receipts, directory_error: directoryError };
}

async function semanticQuality(repoRoot, platform, verified, page, receipts) {
  if (!page) return { semantic_quality: 'not-applicable', semantic_quality_reasons: [], quality_receipt: null };
  const reasons = await bodyQualityReasons(repoRoot, page);
  if (receipts.directory_error) reasons.push(receipts.directory_error);
  const relativePage = posix(path.relative(repoRoot, page.page));
  const matches = receipts.receipts.filter((receipt) => receipt.value?.platform === platform
    && receipt.value?.bundle_checksum === verified.bundle_checksum);
  if (matches.length === 0) reasons.push('quality-receipt-missing');
  else if (matches.length !== 1) reasons.push('quality-receipt-count:' + matches.length);
  const match = matches.length === 1 ? matches[0] : null;
  if (match) {
    const receipt = match.value;
    if (receipt.source_page !== relativePage) reasons.push('quality-receipt-source-page-mismatch');
    const [pageChecksum, rubricChecksum] = await Promise.all([
      sha256(page.page, '来源页'),
      sha256(path.join(repoRoot, QUALITY_RUBRIC), '质量规则'),
    ]);
    if (receipt.source_page_sha256 !== pageChecksum) reasons.push('quality-receipt-source-page-hash-mismatch');
    if (receipt.rubric_sha256 !== rubricChecksum) reasons.push('quality-receipt-rubric-hash-mismatch');
    if (receipt.status !== 'pass') reasons.push('quality-receipt-status:' + (receipt.status || 'missing'));
    if (typeof receipt.reviewer !== 'string' || !receipt.reviewer.trim()) reasons.push('quality-receipt-reviewer-missing');
    if (typeof receipt.compiler !== 'string' || !receipt.compiler.trim()) reasons.push('quality-receipt-compiler-missing');
    if (typeof receipt.reviewer === 'string' && typeof receipt.compiler === 'string'
      && receipt.reviewer.trim() && receipt.reviewer.trim() === receipt.compiler.trim()) reasons.push('quality-receipt-reviewer-equals-compiler');
    if (receipt.compiler_model !== 'gpt-5.6-sol') reasons.push('quality-receipt-compiler-model-invalid');
    if (receipt.compiler_reasoning !== 'max') reasons.push('quality-receipt-compiler-reasoning-invalid');
    if (!Array.isArray(receipt.coverage_map) || receipt.coverage_map.length === 0
      || receipt.coverage_map.some((item) => !item || typeof item.source_scope !== 'string' || !item.source_scope.trim()
        || (!(typeof item.wiki_location === 'string' && item.wiki_location.trim())
          && !(typeof item.omission_reason === 'string' && item.omission_reason.trim())))) reasons.push('quality-receipt-coverage-map-invalid');
    const integration = receipt.integration_decision;
    const hasIntegratedPages = Array.isArray(integration?.updated_pages) && integration.updated_pages.length > 0
      && integration.updated_pages.every((value) => typeof value === 'string' && value.startsWith('wiki/'));
    const hasNoUpdateRationale = typeof integration?.no_update_rationale === 'string' && integration.no_update_rationale.trim();
    if (!hasIntegratedPages && !hasNoUpdateRationale) reasons.push('quality-receipt-integration-decision-missing');
    const wikiPages = Array.isArray(receipt.wiki_pages) ? receipt.wiki_pages : [];
    const seenWikiPages = new Set();
    // Keep structural receipt binding separate from freshness. A later update to
    // a shared canonical page must invalidate the receipt, but it must not turn
    // otherwise valid evidence locators into a malformed-receipt diagnosis.
    const structurallyBoundWikiPages = new Set();
    let sourceBound = false;
    if (!wikiPages.length) reasons.push('quality-receipt-wiki-pages-missing');
    for (const record of wikiPages) {
      const relative = record?.path;
      if (typeof relative !== 'string' || path.isAbsolute(relative) || !relative.startsWith('wiki/')
        || relative === 'wiki/索引.md' || relative === 'wiki/日志.md' || seenWikiPages.has(relative)) {
        reasons.push('quality-receipt-wiki-page-invalid');
        continue;
      }
      seenWikiPages.add(relative);
      const absolute = path.resolve(repoRoot, relative);
      if (!inside(path.join(repoRoot, 'wiki'), absolute)) {
        reasons.push('quality-receipt-wiki-page-outside');
        continue;
      }
      try {
        await regularFileInside(path.join(repoRoot, 'wiki'), absolute, '质量 receipt Wiki 页');
        const current = await sha256(absolute, '质量 receipt Wiki 页');
        if (typeof record.sha256 !== 'string' || !SHA256_DIGEST.test(record.sha256)) {
          reasons.push('quality-receipt-wiki-page-hash-invalid:' + relative);
          continue;
        }
        structurallyBoundWikiPages.add(relative);
        if (record.sha256 !== current) reasons.push('quality-receipt-wiki-page-hash-mismatch:' + relative);
        if (relative === relativePage && record.sha256 === pageChecksum) sourceBound = true;
      } catch {
        reasons.push('quality-receipt-wiki-page-missing:' + relative);
      }
    }
    if (!sourceBound) reasons.push('quality-receipt-source-page-not-bound');
    for (const relative of linkedCanonicalPages(repoRoot, page)) {
      if (!seenWikiPages.has(relative)) reasons.push('quality-receipt-linked-page-not-bound:' + relative);
    }
    if (Array.isArray(integration?.updated_pages)) {
      for (const relative of integration.updated_pages) {
        if (typeof relative === 'string' && !seenWikiPages.has(relative)) reasons.push('quality-receipt-updated-page-not-bound:' + relative);
      }
    }
    // verifyRaw returns no manifest path; the source page's declared manifest
    // is the receipt locator boundary (and is separately checked above).
    const receiptRawBundle = page.resolved_manifest ? path.dirname(page.resolved_manifest) : path.join(repoRoot, 'raw');
    const hardGateEntries = Array.isArray(receipt.hard_gates) ? receipt.hard_gates : [];
    const hardGateNames = hardGateEntries.map((item) => item?.name);
    const hardGateSchemaValid = hardGateEntries.length === QUALITY_HARD_GATES.length
      && new Set(hardGateNames).size === QUALITY_HARD_GATES.length
      && QUALITY_HARD_GATES.every((name) => hardGateNames.includes(name));
    const hardGateEvidence = hardGateSchemaValid
      ? await Promise.all(hardGateEntries.map((item) => item?.passed === true
        && validEvidence(repoRoot, receiptRawBundle, structurallyBoundWikiPages, item.evidence)))
      : [];
    if (!hardGateSchemaValid || !hardGateEvidence.every(Boolean)) reasons.push('quality-receipt-hard-gates-incomplete');
    if (hardGateSchemaValid && !hardGateEvidence.every(Boolean)) reasons.push('quality-receipt-hard-gate-evidence-invalid');
    if (!Array.isArray(receipt.unsupported_claims) || receipt.unsupported_claims.length) reasons.push('quality-receipt-unsupported-claims-present');
    const scoreEntries = Array.isArray(receipt.scores) ? receipt.scores : [];
    const scoreNames = scoreEntries.map((item) => item?.dimension);
    const scoreSchemaValid = scoreEntries.length === QUALITY_DIMENSIONS.length
      && new Set(scoreNames).size === QUALITY_DIMENSIONS.length
      && QUALITY_DIMENSIONS.every((dimension) => scoreNames.includes(dimension));
    const scoreEvidence = scoreSchemaValid
      ? await Promise.all(scoreEntries.map((item) => validEvidence(repoRoot, receiptRawBundle, structurallyBoundWikiPages, item.evidence)))
      : [];
    if (!scoreSchemaValid || !scoreEvidence.every(Boolean)) reasons.push('quality-receipt-score-evidence-missing');
    if (scoreSchemaValid && !scoreEvidence.every(Boolean)) reasons.push('quality-receipt-score-evidence-invalid');
    const scores = scoreMap(receipt.scores);
    const scoreValues = QUALITY_DIMENSIONS.map((dimension) => scores[dimension]);
    if (!scoreValues.every((score) => Number.isInteger(score) && score >= 0 && score <= 2)) reasons.push('quality-receipt-scores-invalid');
    else {
      const total = scoreValues.reduce((sum, score) => sum + score, 0);
      if (!Number.isInteger(receipt.total_score) || receipt.total_score !== total || total < 10) reasons.push('quality-receipt-total-score-insufficient');
      if (scores.source_coverage !== 2) reasons.push('quality-receipt-source-coverage-insufficient');
      if (scores.reusability !== 2) reasons.push('quality-receipt-reusability-insufficient');
      if (scores.knowledge_integration !== 2) reasons.push('quality-receipt-knowledge-integration-insufficient');
      if (scoreValues.some((score) => score === 0)) reasons.push('quality-receipt-zero-score');
    }
  }
  const staleCanonicalPages = reasons.flatMap((reason) => {
    const prefix = 'quality-receipt-wiki-page-hash-mismatch:';
    if (!reason.startsWith(prefix)) return [];
    const relative = reason.slice(prefix.length);
    return relative !== relativePage && canonicalContentPage(relative) ? [relative] : [];
  });
  const sharedCanonicalPageStale = reasons.length > 0 && staleCanonicalPages.length === reasons.length;
  if (sharedCanonicalPageStale) {
    for (const relative of staleCanonicalPages) reasons.push(...await canonicalPageIntegrityReasons(repoRoot, relative));
  }
  return {
    semantic_quality: reasons.length ? 'needs-review' : 'pass',
    semantic_quality_reasons: reasons,
    quality_receipt: match ? posix(path.relative(repoRoot, match.path)) : null,
    review_isolation: sharedCanonicalPageStale && reasons.length === staleCanonicalPages.length ? SHARED_CANONICAL_PAGE_STALE : null,
  };
}

async function indexRecords(repoRoot) {
  const indexPath = path.join(repoRoot, 'wiki', '索引.md');
  if (!await exists(indexPath)) return [];
  await regularFile(indexPath, 'wiki/索引.md');
  const text = await fs.readFile(indexPath, 'utf8');
  return [...text.matchAll(/^- \[[^\]\n]+\]\(([^)\n]+)\) — .+ Updated \d{4}-\d{2}-\d{2}; [1-9]\d* sources?\.$/gm)]
    .map((match) => match[1].trim())
    .filter((value) => value && !/^[a-z]+:/i.test(value) && !value.startsWith('#'))
    .map((value) => path.resolve(path.dirname(indexPath), value.split('#', 1)[0]));
}

async function logRecords(repoRoot) {
  const logPath = path.join(repoRoot, 'wiki', '日志.md');
  if (!await exists(logPath)) return [];
  await regularFile(logPath, 'wiki/日志.md');
  const records = [];
  let heading = null;
  for (const line of (await fs.readFile(logPath, 'utf8')).split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      heading = /^## \[\d{4}-\d{2}-\d{2}\] ingest \|/.test(line) ? line : null;
      continue;
    }
    if (!heading) continue;
    const match = line.match(/^- Raw: `(raw\/(wechat|wechat-channels|x|bilibili|youtube)\/[^`\s]+\/manifest\.json)` \(`(sha256:[a-f0-9]{64})`\)$/);
    if (match) records.push({ heading, raw_manifest: match[1], platform: match[2], raw_checksum: match[3] });
  }
  return records;
}

function authenticity(manifest, platform) {
  if (typeof manifest.source_authenticity === 'string' && manifest.source_authenticity) {
    return manifest.source_authenticity;
  }
  if (platform === 'wechat' && manifest.capture?.method === 'wechatsync-url-zip') {
    return 'browser-extension-verified';
  }
  return 'declared-only';
}

async function rawManifests(repoRoot) {
  const rawRoot = path.join(repoRoot, 'raw');
  if (!await exists(rawRoot)) return { manifests: [], failures: [] };
  await plainDirectory(rawRoot, 'raw 目录');
  const manifests = [];
  const failures = [];
  for (const adapter of PLATFORMS) {
    const platformRoot = path.join(rawRoot, adapter.directory);
    if (!await exists(platformRoot)) continue;
    await plainDirectory(platformRoot, 'raw/' + adapter.directory + ' 目录');
    for (const entry of (await fs.readdir(platformRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.gitkeep') continue;
      const bundle = path.join(platformRoot, entry.name);
      if (entry.name.startsWith('.') || entry.isSymbolicLink() || !entry.isDirectory()) {
        failures.push({ platform: adapter.platform, raw_bundle: bundle, manifest: null, error: 'raw/' + adapter.directory + ' 包含无效条目' });
        continue;
      }
      const manifest = path.join(bundle, 'manifest.json');
      const stat = await fs.lstat(manifest).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) {
        failures.push({ platform: adapter.platform, raw_bundle: bundle, manifest, error: '原文包缺少普通文件 manifest.json' });
      } else {
        manifests.push({ ...adapter, raw_bundle: bundle, manifest });
      }
    }
  }
  return { manifests, failures };
}

async function classify(context) {
  const { repoRoot, platform, trustState, manifestPath, articlePath, verified, sourcePages, indexPages, logs } = context;
  const relativeManifest = posix(path.relative(repoRoot, manifestPath));
  const manifestMatches = sourcePages.filter((record) => record.resolved_manifest === manifestPath);
  const articleMatches = sourcePages.filter((record) => record.resolved_sources.includes(articlePath));
  const logMatches = logs.filter((record) => record.raw_manifest === relativeManifest);
  const touched = manifestMatches.length || articleMatches.length || logMatches.length;
  const archiveOnlyReason = platform === 'youtube' && verified.transcript_available !== true
    ? 'youtube-transcript-unavailable-not-content-compiled'
    : platform === 'wechat-channels' && verified.transcript_available !== true
      ? 'wechat-channels-media-and-transcript-unavailable-not-content-compiled'
      : null;
  if (!touched && archiveOnlyReason) return {
    state: 'archive-only',
    bookkeeping_state: 'pending',
    semantic_quality: 'not-applicable',
    semantic_quality_reasons: [archiveOnlyReason],
    quality_receipt: null,
    review_isolation: null,
    bookkeeping_reasons: [],
    reasons: [archiveOnlyReason],
    source_page: null,
    source_status: null,
  };
  if (!touched) return {
    state: 'pending',
    bookkeeping_state: 'pending',
    semantic_quality: 'not-applicable',
    semantic_quality_reasons: [],
    quality_receipt: null,
    review_isolation: null,
    bookkeeping_reasons: [],
    reasons: [],
    source_page: null,
    source_status: null,
  };
  const reasons = [];
  if (manifestMatches.length !== 1) reasons.push('source-page-count:' + manifestMatches.length);
  const page = manifestMatches.length === 1 ? manifestMatches[0] : null;
  if (page) {
    if (page.type !== 'source') reasons.push('source-type:' + (page.type || 'missing'));
    if (!VALID_SOURCE_STATUSES.has(page.status)) reasons.push('source-status:' + (page.status || 'missing'));
    if (platform === 'bilibili' && trustState === 'needs-review' && !['needs-review', 'superseded'].includes(page.status)) reasons.push('bilibili-unverified-subtitle-requires-needs-review');
    if (platform === 'youtube' && trustState === 'needs-review' && !['needs-review', 'superseded'].includes(page.status)) reasons.push('youtube-limited-evidence-requires-needs-review');
    if (platform === 'wechat-channels' && !['needs-review', 'superseded'].includes(page.status)) reasons.push('wechat-channels-metadata-only-requires-needs-review');
    if (page.raw_checksum !== verified.bundle_checksum) reasons.push('source-checksum-mismatch');
    const indexCount = indexPages.filter((value) => value === page.page).length;
    if (indexCount !== 1) reasons.push('index-entry-count:' + indexCount);
  }
  if (articleMatches.length !== 1) reasons.push('article-source-count:' + articleMatches.length);
  else if (page && articleMatches[0].page !== page.page) reasons.push('article-source-page-mismatch');
  const exactLogs = logMatches.filter((record) => record.raw_checksum === verified.bundle_checksum);
  if (logMatches.length !== 1) reasons.push('ingest-log-count:' + logMatches.length);
  else if (exactLogs.length !== 1) reasons.push('ingest-log-checksum-mismatch');
  const bookkeeping_state = reasons.length ? 'needs-review' : 'consistent';
  if (archiveOnlyReason) return {
    state: 'archive-only',
    bookkeeping_state,
    semantic_quality: 'not-applicable',
    semantic_quality_reasons: [archiveOnlyReason],
    quality_receipt: null,
    review_isolation: null,
    bookkeeping_reasons: reasons,
    reasons: [...reasons, archiveOnlyReason],
    source_page: page?.page || null,
    source_status: page?.status || null,
  };
  const quality = await semanticQuality(repoRoot, platform, verified, page, context.receipts);
  return {
    state: bookkeeping_state === 'consistent' && quality.semantic_quality === 'pass' ? 'consistent' : 'needs-review',
    bookkeeping_state,
    ...quality,
    bookkeeping_reasons: reasons,
    reasons: [...reasons, ...quality.semantic_quality_reasons],
    source_page: page?.page || null,
    source_status: page?.status || null,
  };
}

async function scanCompileQueue(repoInput) {
  const repoRoot = await resolveRepoRoot(repoInput);
  const [sources, indexes, logs, raw, receipts] = await Promise.all([
    sourceRecords(repoRoot),
    indexRecords(repoRoot),
    logRecords(repoRoot),
    rawManifests(repoRoot),
    qualityReceipts(repoRoot),
  ]);
  const bundles = [];
  const integrityFailures = [...raw.failures];
  if (receipts.directory_error) {
    integrityFailures.push({
      platform: 'quality-reviews',
      raw_bundle: null,
      manifest: null,
      error: receipts.directory_error,
    });
  }
  for (const candidate of raw.manifests) {
    try {
      const verified = await candidate.verify(candidate.raw_bundle, repoRoot);
      const manifest = await readJson(candidate.manifest, 'manifest');
      const trust = authenticity(manifest, candidate.platform);
      const trustState = TRUSTED_AUTHENTICITY.has(trust) ? 'verified' : 'needs-review';
      const classification = await classify({
        repoRoot,
        platform: candidate.platform,
        trustState,
        manifestPath: candidate.manifest,
        articlePath: path.join(candidate.raw_bundle, 'article.md'),
        verified,
        sourcePages: sources,
        indexPages: indexes,
        logs,
        receipts,
      });
      bundles.push({
        platform: candidate.platform,
        raw_bundle: candidate.raw_bundle,
        manifest: candidate.manifest,
        relative_manifest: posix(path.relative(repoRoot, candidate.manifest)),
        bundle_checksum: verified.bundle_checksum,
        content_checksum: verified.content_checksum,
        title: manifest.source?.title || manifest.normalized?.title || 'unknown',
        source_authenticity: trust,
        metadata_authenticity: verified.metadata_authenticity || null,
        content_authenticity: verified.content_authenticity || null,
        subtitle_authenticity: verified.subtitle_authenticity || null,
        transcript_available: verified.transcript_available ?? null,
        subtitle_kind: verified.subtitle_kind || null,
        subtitle_language: verified.subtitle_language || null,
        stable_track_id: verified.stable_track_id || null,
        translation_state: verified.translation_state || null,
        source_language: verified.source_language || null,
        trust_state: trustState,
        ...classification,
      });
    } catch (error) {
      integrityFailures.push({
        platform: candidate.platform,
        raw_bundle: candidate.raw_bundle,
        manifest: candidate.manifest,
        error: error.message,
      });
    }
  }
  bundles.sort((a, b) => a.relative_manifest.localeCompare(b.relative_manifest));
  const pending = bundles.filter((item) => item.state === 'pending');
  const archiveOnly = bundles.filter((item) => item.state === 'archive-only');
  const needsReview = bundles.filter((item) => item.state === 'needs-review');
  const isolatedNeedsReview = needsReview.filter((item) => item.review_isolation === SHARED_CANONICAL_PAGE_STALE
    && item.bookkeeping_state === 'consistent');
  const blockingNeedsReview = needsReview.filter((item) => !isolatedNeedsReview.includes(item));
  const consistent = bundles.filter((item) => item.state === 'consistent');
  return {
    ok: integrityFailures.length === 0 && needsReview.length === 0,
    ready_for_claim: integrityFailures.length === 0 && blockingNeedsReview.length === 0,
    repo_root: repoRoot,
    bundles,
    pending,
    archive_only: archiveOnly,
    needs_review: needsReview,
    isolated_needs_review: isolatedNeedsReview,
    blocking_needs_review: blockingNeedsReview,
    consistent,
    integrity_failures: integrityFailures,
  };
}

function lockPath(repoRoot) {
  return path.join(repoRoot, 'staging', '.locks', LOCK_NAME);
}

async function readLock(target) {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) fail('编译锁无效: ' + target);
  const owner = await readJson(target, '编译锁 owner');
  if (typeof owner.claim_id !== 'string' || !owner.claim_id) fail('编译锁无 claim_id: ' + target);
  return { path: target, ...owner };
}

async function writeLockOwner(target, owner) {
  const current = await readLock(target);
  if (!current || current.claim_id !== owner.claim_id) fail('编译锁 owner 已变化，拒绝更新');
  const temporary = path.join(path.dirname(target), '.owner-' + owner.claim_id + '.json');
  await fs.writeFile(temporary, JSON.stringify(owner, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  try {
    await fs.rename(temporary, target);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
  return { path: target, ...owner };
}

async function acquireCompileLock(repoInput) {
  const repoRoot = await resolveRepoRoot(repoInput);
  const staging = await plainDirectory(path.join(repoRoot, 'staging'), 'staging 目录', true);
  const locks = await plainDirectory(path.join(staging, '.locks'), '编译锁目录', true);
  const target = path.join(locks, LOCK_NAME);
  const owner = { claim_id: randomUUID(), repo_root: repoRoot, pid: process.pid, acquired_at: new Date().toISOString() };
  const temporary = path.join(locks, '.claim-' + owner.claim_id + '.json');
  await fs.writeFile(temporary, JSON.stringify(owner, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  try {
    await fs.link(temporary, target);
  } catch (error) {
    if (error.code === 'EEXIST') return { acquired: false, lock: await readLock(target) };
    throw error;
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
  return { acquired: true, lock: { path: target, ...owner } };
}

async function releaseCompileLock(repoInput, claimId, options = {}) {
  if (!claimId) fail('release 需要 --claim-id');
  const repoRoot = await resolveRepoRoot(repoInput);
  const target = lockPath(repoRoot);
  const owner = await readLock(target);
  if (!owner) fail('没有可释放的编译锁');
  if (owner.claim_id !== claimId) fail('claim-id 与当前编译锁不匹配；锁已保留');
  if (!options.internal && owner.candidate_manifest) {
    const scan = await scanCompileQueue(repoRoot);
    const candidate = scan.bundles.find((item) => item.relative_manifest === owner.candidate_manifest);
    if (!candidate || candidate.bundle_checksum !== owner.candidate_checksum || candidate.state !== 'consistent') {
      fail('候选 bundle 尚未达到 consistent；编译锁已保留', { candidate });
    }
    if (owner.wiki_baseline && typeof owner.wiki_baseline === 'object' && !Array.isArray(owner.wiki_baseline)) {
      const current = await wikiContentBaseline(repoRoot);
      const allContentPages = new Set([...Object.keys(owner.wiki_baseline), ...Object.keys(current)]);
      const changed = [...allContentPages].filter((relative) => owner.wiki_baseline[relative] !== current[relative]);
      const deleted = changed.filter((relative) => !Object.hasOwn(current, relative));
      if (deleted.length) fail('编译期间删除了既有 Wiki 内容页；编译锁已保留', { deleted });
      const receiptPath = path.resolve(repoRoot, candidate.quality_receipt || '');
      await regularFileInside(path.join(repoRoot, QUALITY_REVIEWS_DIRECTORY), receiptPath, '质量 receipt');
      const receipt = await readJson(receiptPath, '质量 receipt');
      const bound = new Set(Array.isArray(receipt.wiki_pages) ? receipt.wiki_pages.map((item) => item?.path).filter(Boolean) : []);
      const unbound = changed.filter((relative) => !bound.has(relative));
      if (unbound.length) fail('编译期间变化的 Wiki 内容页未全部绑定到质量 receipt；编译锁已保留', { unbound });
    }
  }
  await fs.unlink(target);
  return { ok: true, action: 'released', repo_root: repoRoot, claim_id: claimId };
}

async function claimNextBundle(repoInput) {
  const acquired = await acquireCompileLock(repoInput);
  if (!acquired.acquired) return { ok: true, action: 'locked', lock: acquired.lock, lock_retained: true };
  try {
    const queue = await scanCompileQueue(acquired.lock.repo_root);
    if (queue.integrity_failures.length) {
      return { ...queue, ok: false, action: 'integrity-failure', lock: acquired.lock, lock_retained: true };
    }
    if (queue.blocking_needs_review.length) {
      return { ...queue, ok: false, action: 'needs-review', lock: acquired.lock, lock_retained: true };
    }
    if (!queue.pending.length) {
      await releaseCompileLock(acquired.lock.repo_root, acquired.lock.claim_id, { internal: true });
      if (queue.isolated_needs_review.length) {
        return {
          ...queue,
          ok: false,
          action: 'needs-review',
          review_status: SHARED_CANONICAL_PAGE_STALE,
          lock_released: true,
          lock_retained: false,
        };
      }
      return { ...queue, ok: true, action: 'no-action', lock_released: true };
    }
    const candidate = queue.pending[0];
    const wikiBaseline = await wikiContentBaseline(acquired.lock.repo_root);
    const owner = await writeLockOwner(acquired.lock.path, {
      ...acquired.lock,
      path: undefined,
      candidate_manifest: candidate.relative_manifest,
      candidate_checksum: candidate.bundle_checksum,
      candidate_platform: candidate.platform,
      wiki_baseline: wikiBaseline,
    });
    return {
      ok: true,
      action: 'claimed',
      lock: owner,
      lock_retained: true,
      candidate,
      pending_count: queue.pending.length,
      consistent_count: queue.consistent.length,
    };
  } catch (error) {
    return { ok: false, action: 'failed', error: error.message, details: error.details, lock: acquired.lock, lock_retained: true };
  }
}

function parseArgs(argv) {
  const command = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) fail('无法识别的参数: ' + item);
    const split = item.slice(2).split(/=(.*)/s, 2);
    const key = split[0].replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const value = split[1] ?? argv[++index];
    if (!value || value.startsWith('--') || Object.hasOwn(options, key)) fail('参数无效或重复: ' + item);
    options[key] = value;
  }
  return { command, options };
}

async function main(argv) {
  if (!argv.length || ['help', '--help', '-h'].includes(argv[0])) {
    process.stdout.write('文章 Wiki 编译队列\n\n用法:\n  article_compile_queue.mjs scan [--repo PATH]\n  article_compile_queue.mjs claim [--repo PATH]\n  article_compile_queue.mjs release --claim-id ID [--repo PATH]\n');
    return;
  }
  const parsed = parseArgs(argv);
  let result;
  if (parsed.command === 'scan') result = await scanCompileQueue(parsed.options.repo);
  else if (parsed.command === 'claim') result = await claimNextBundle(parsed.options.repo);
  else if (parsed.command === 'release') result = await releaseCompileLock(parsed.options.repo, parsed.options.claimId);
  else fail('未知命令: ' + parsed.command);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.ok === false) process.exitCode = 2;
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (direct) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(JSON.stringify({ ok: false, error: error.message, details: error.details }, null, 2) + '\n');
    process.exitCode = 1;
  });
}

export { acquireCompileLock, claimNextBundle, releaseCompileLock, scanCompileQueue };
