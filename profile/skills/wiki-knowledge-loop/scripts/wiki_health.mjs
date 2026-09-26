#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { scanCompileQueue } from '../../article-ingest/scripts/article_compile_queue.mjs';
import { frontmatter, list, resolveRepo, scalar, wikiPages } from './wiki_recall.mjs';

const TYPES = new Set(['source', 'entity', 'concept', 'analysis']);
const STATUSES = new Set(['active', 'draft', 'needs-review', 'superseded']);
const CHINESE = /[\p{Script=Han}]/u;

function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function posix(value) { return value.split(path.sep).join('/'); }
function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function issue(severity, code, page, details = {}) { return { severity, code, page, ...details }; }

async function existingRegular(target) {
  const stat = await fs.lstat(target).catch(() => null);
  return Boolean(stat?.isFile() && !stat.isSymbolicLink());
}

function markdownLinks(text) {
  return [...text.matchAll(/(?<!!)\[[^\]\n]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)].map((match) => match[1]);
}

function indexTargets(text) {
  return [...text.matchAll(/^- \[[^\]\n]+\]\(([^)\n]+)\)\s*—\s*.+?\s+Updated \d{4}-\d{2}-\d{2};\s+\d+ sources?\.$/gm)]
    .map((match) => match[1].trim().split('#', 1)[0])
    .filter((value) => value && !/^(?:[a-z]+:|#)/i.test(value));
}

function basenameAllowed(file) {
  const base = path.basename(file, '.md');
  return base === '.目录占位' || CHINESE.test(base);
}

async function inspectHealth({ repo, includeCompile = true } = {}) {
  const repoRoot = await resolveRepo(repo);
  const wikiRoot = path.join(repoRoot, 'wiki');
  const indexPath = path.join(wikiRoot, '索引.md');
  const logPath = path.join(wikiRoot, '日志.md');
  const issues = [];
  const pages = await wikiPages(repoRoot);
  const pageSet = new Set(pages.map((page) => path.resolve(page)));
  const inbound = new Map(pages.map((page) => [path.resolve(page), 0]));
  const indexed = new Map();
  let indexText = '';

  if (!await existingRegular(indexPath)) issues.push(issue('error', 'missing-index', 'wiki/索引.md'));
  else {
    indexText = await fs.readFile(indexPath, 'utf8');
    for (const target of indexTargets(indexText)) {
      const resolved = path.resolve(wikiRoot, target);
      const key = posix(path.relative(wikiRoot, resolved));
      indexed.set(key, (indexed.get(key) || 0) + 1);
      if (!inside(wikiRoot, resolved) || !pageSet.has(resolved)) issues.push(issue('error', 'broken-index-link', 'wiki/索引.md', { target }));
    }
  }
  if (!await existingRegular(logPath)) issues.push(issue('error', 'missing-log', 'wiki/日志.md'));

  for (const page of pages) {
    const relative = posix(path.relative(repoRoot, page));
    const contentRelative = posix(path.relative(wikiRoot, page));
    if (!basenameAllowed(page)) issues.push(issue('error', 'non-chinese-basename', relative));
    const text = await fs.readFile(page, 'utf8');
    const parsed = frontmatter(text);
    if (!parsed.yaml) {
      issues.push(issue('error', 'missing-frontmatter', relative));
      continue;
    }
    const type = scalar(parsed.yaml, 'type');
    const status = scalar(parsed.yaml, 'status');
    for (const key of ['title', 'type', 'status', 'created', 'updated']) if (!scalar(parsed.yaml, key)) issues.push(issue('error', 'missing-frontmatter-field', relative, { field: key }));
    if (type && !TYPES.has(type)) issues.push(issue('error', 'invalid-type', relative, { type }));
    if (status && !STATUSES.has(status)) issues.push(issue('error', 'invalid-status', relative, { status }));
    const sources = list(parsed.yaml, 'sources');
    if (!sources.length && status !== 'draft') issues.push(issue('error', 'missing-sources', relative));
    for (const source of sources) {
      if (path.isAbsolute(source)) {
        issues.push(issue('error', 'absolute-source-path', relative, { source }));
        continue;
      }
      const resolved = path.resolve(path.dirname(page), source);
      if (!inside(path.join(repoRoot, 'raw'), resolved)) issues.push(issue('error', 'source-outside-raw', relative, { source }));
      else if (!await existingRegular(resolved)) issues.push(issue('error', 'missing-raw-source', relative, { source }));
    }
    if (type === 'source') {
      const manifest = scalar(parsed.yaml, 'raw_manifest');
      const checksum = scalar(parsed.yaml, 'raw_checksum');
      if (manifest && path.isAbsolute(manifest)) issues.push(issue('error', 'absolute-raw-manifest', relative, { raw_manifest: manifest }));
      else if (manifest) {
        const resolved = path.resolve(path.dirname(page), manifest);
        if (!inside(path.join(repoRoot, 'raw'), resolved)) issues.push(issue('error', 'raw-manifest-outside-raw', relative, { raw_manifest: manifest }));
        else if (!await existingRegular(resolved)) issues.push(issue('error', 'missing-raw-manifest', relative, { raw_manifest: manifest }));
      }
      if (!checksum) issues.push(issue('error', 'missing-raw-checksum', relative));
    }
    for (const target of markdownLinks(parsed.body)) {
      if (/^(?:[a-z]+:|#)/i.test(target)) continue;
      const clean = target.split('#', 1)[0];
      if (!clean) continue;
      const resolved = path.resolve(path.dirname(page), clean);
      if (!inside(repoRoot, resolved) || !await existingRegular(resolved)) issues.push(issue('error', 'broken-relative-link', relative, { target }));
      else if (pageSet.has(resolved)) inbound.set(resolved, (inbound.get(resolved) || 0) + 1);
    }
    const indexCount = indexed.get(contentRelative) || 0;
    if (indexCount === 0) issues.push(issue('warning', 'missing-index-entry', relative));
    else if (indexCount > 1) issues.push(issue('warning', 'duplicate-index-entry', relative, { count: indexCount }));
  }
  for (const [page, count] of inbound) {
    if (!count) issues.push(issue('warning', 'orphan-page', posix(path.relative(repoRoot, page))));
  }

  let compileQueue = null;
  if (includeCompile) {
    try {
      const result = await scanCompileQueue(repoRoot);
      compileQueue = {
        ok: result.ok,
        ready_for_claim: result.ready_for_claim,
        bundle_count: result.bundles.length,
        consistent_count: result.consistent.length,
        pending_count: result.pending.length,
        archive_only_count: result.archive_only.length,
        needs_review_count: result.needs_review.length,
        isolated_needs_review_count: result.isolated_needs_review.length,
        blocking_needs_review_count: result.blocking_needs_review.length,
        integrity_failures: result.integrity_failures,
      };
      for (const failure of result.integrity_failures) issues.push(issue('error', 'compile-integrity-failure', failure.relative_manifest || 'raw', { platform: failure.platform, error: failure.error }));
      for (const bundle of result.archive_only) issues.push(issue('warning', 'compile-archive-only', bundle.relative_manifest, { reasons: bundle.reasons }));
      for (const bundle of result.needs_review) issues.push(issue('warning', 'compile-needs-review', bundle.relative_manifest, { reasons: bundle.reasons }));
    } catch (error) {
      issues.push(issue('error', 'compile-scan-failed', 'raw', { error: error.message }));
    }
  }
  issues.sort((left, right) => compare(left.severity, right.severity) || compare(left.code, right.code) || compare(left.page, right.page));
  const errors = issues.filter((item) => item.severity === 'error');
  const warnings = issues.filter((item) => item.severity === 'warning');
  return {
    ok: errors.length === 0,
    repo_root: repoRoot,
    page_count: pages.length,
    summary: { errors: errors.length, warnings: warnings.length },
    issues,
    compile_queue: compileQueue,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) throw new Error(`无法识别的参数: ${item}`);
    if (item === '--no-compile') { options.noCompile = true; continue; }
    if (item !== '--repo' || options.repo) throw new Error(`参数无效或重复: ${item}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error('--repo 缺少值');
    options.repo = value;
  }
  return { repo: options.repo, includeCompile: !options.noCompile };
}

async function main(argv) {
  if (!argv.length || ['--help', '-h', 'help'].includes(argv[0])) {
    process.stdout.write('用法: wiki_health.mjs [--repo PATH] [--no-compile]\n');
    return;
  }
  const result = await inspectHealth(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 2;
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (direct) main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
});

export { inspectHealth };
