#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { inspectHealth } from './wiki_health.mjs';
import { frontmatter, list, recall, resolveRepo, scalar } from './wiki_recall.mjs';

function fail(message) { throw new Error(message); }

function expectedValues(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [value];
  return [];
}

function normalizeExpected(value) {
  return expectedValues(value).filter((item) => typeof item === 'string' && item.trim()).map((item) => {
    const clean = item.trim().replace(/^\.\//, '');
    return clean.startsWith('wiki/') ? clean : `wiki/${clean}`;
  });
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function rawLocatorEvidence(repoRoot, relativePage, text) {
  const page = path.join(repoRoot, relativePage);
  const parsed = frontmatter(text);
  const allowed = new Set(list(parsed.yaml || '', 'sources').map((value) => path.resolve(path.dirname(page), value)));
  const manifest = scalar(parsed.yaml || '', 'raw_manifest');
  if (manifest) allowed.add(path.resolve(path.dirname(page), manifest));
  const rawRoot = path.join(repoRoot, 'raw');
  const realRawRoot = await fs.realpath(rawRoot).catch(() => null);
  if (!realRawRoot) return { has_raw_locator: false, grounded_terms: [], substantive_character_count: 0 };
  const body = (parsed.body || '').replace(/<!--[\s\S]*?-->/g, '');
  const validLinks = [];
  for (const match of body.matchAll(/(?<!!)\[[^\]\n]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
    const target = match[1].replace(/^<|>$/g, '').split('#', 1)[0];
    if (!target || /^(?:[a-z]+:|#)/i.test(target)) continue;
    const resolved = path.resolve(path.dirname(page), target);
    if (!inside(rawRoot, resolved) || !allowed.has(resolved)) continue;
    const stat = await fs.lstat(resolved).catch(() => null);
    const real = await fs.realpath(resolved).catch(() => null);
    const expected = path.resolve(realRawRoot, path.relative(rawRoot, resolved));
    if (stat?.isFile() && !stat.isSymbolicLink() && real === expected && inside(realRawRoot, real)) {
      validLinks.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  const validFootnotes = new Set();
  for (const link of validLinks) {
    const lineStart = body.lastIndexOf('\n', link.start - 1) + 1;
    const lineEndIndex = body.indexOf('\n', link.end);
    const lineEnd = lineEndIndex === -1 ? body.length : lineEndIndex;
    const definition = body.slice(lineStart, lineEnd).match(/^\s*\[\^([^\]]+)\]:/);
    if (definition) validFootnotes.add(definition[1]);
  }
  let blockCursor = 0;
  const blocks = body.split(/\n\s*\n/).map((block) => {
    const start = body.indexOf(block, blockCursor);
    const end = start + block.length;
    blockCursor = end;
    const directEvidence = validLinks.some((link) => link.start >= start && link.end <= end && !/^\s*\[\^/m.test(block));
    const footnotes = [...block.matchAll(/\[\^([^\]]+)\]/g)].map((match) => match[1]);
    const grounded = directEvidence || footnotes.some((label) => validFootnotes.has(label));
    const visible = block
      .split(/\r?\n/)
      .filter((line) => !/^\s*#{1,6}\s/.test(line) && !/^\s*\[\^[^\]]+\]:/.test(line))
      .join('\n')
      .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
      .replace(/\[[^\]]*\]\([^)]+\)/g, '')
      .replace(/\[\^[^\]]+\]/g, '')
      .replace(/[`*>|#]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const semanticCharacterCount = (visible.match(/[\p{L}\p{N}]/gu) || []).length;
    return { grounded, visible, normalized: visible.toLocaleLowerCase(), semantic_character_count: semanticCharacterCount };
  }).filter((block) => block.semantic_character_count >= 24);
  return {
    has_raw_locator: validLinks.length > 0,
    blocks,
    substantive_character_count: blocks.filter((block) => block.grounded).reduce((total, block) => total + block.semantic_character_count, 0),
  };
}

async function readRelevantPage(repoRoot, relative, caseId) {
  const wikiRoot = path.join(repoRoot, 'wiki');
  const target = path.resolve(repoRoot, relative);
  if (!inside(wikiRoot, target)) fail(`case ${caseId} 的 relevant 越出 wiki/: ${relative}`);
  const stat = await fs.lstat(target).catch(() => null);
  const realWikiRoot = await fs.realpath(wikiRoot).catch(() => null);
  const real = await fs.realpath(target).catch(() => null);
  const expected = realWikiRoot ? path.resolve(realWikiRoot, path.relative(wikiRoot, target)) : null;
  if (!stat?.isFile() || stat.isSymbolicLink() || !realWikiRoot || real !== expected || !inside(realWikiRoot, real)) {
    fail(`case ${caseId} 的 relevant 页面不存在或不安全: ${relative}`);
  }
  return fs.readFile(target, 'utf8');
}

async function readCases(casesPath) {
  const text = await fs.readFile(casesPath, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') fail(`case 文件不存在: ${casesPath}`);
    throw error;
  });
  const cases = [];
  for (const [offset, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let value;
    try { value = JSON.parse(line); } catch { fail(`case JSONL 第 ${offset + 1} 行无法解析`); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.query !== 'string' || !value.query.trim()) fail(`case JSONL 第 ${offset + 1} 行缺少 query`);
    const expected = normalizeExpected(value.relevant ?? value.relevant_paths ?? value.expected);
    if (!expected.length) fail(`case JSONL 第 ${offset + 1} 行缺少 relevant`);
    const preferred = normalizeExpected(value.canonical ?? value.canonical_paths ?? value.preferred ?? value.preferred_paths);
    const answerTerms = Array.isArray(value.answer_terms)
      ? value.answer_terms.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
      : [];
    if (value.mode !== undefined && !['task', 'source'].includes(value.mode)) fail(`case JSONL 第 ${offset + 1} 行的 mode 必须是 task 或 source`);
    for (const key of ['require_coverage', 'require_full_coverage']) {
      if (value[key] !== undefined && typeof value[key] !== 'boolean') fail(`case JSONL 第 ${offset + 1} 行的 ${key} 必须是布尔值`);
    }
    if (value.require_coverage !== undefined && value.require_full_coverage !== undefined
      && value.require_coverage !== value.require_full_coverage) fail(`case JSONL 第 ${offset + 1} 行的 coverage 要求互相冲突`);
    cases.push({
      id: typeof value.id === 'string' ? value.id : String(offset + 1),
      query: value.query,
      relevant: [...new Set(expected)].sort(),
      preferred: [...new Set(preferred)].sort(),
      k: value.k,
      answer_terms: [...new Set(answerTerms)],
      mode: value.mode,
      require_coverage: value.require_coverage ?? value.require_full_coverage ?? false,
    });
  }
  return cases;
}

async function evaluate({ repo, cases, limit = 10, mode = 'task', includeHealth = false } = {}) {
  if (!cases) fail('--cases 不能为空');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('--limit 必须是 1 至 100 的整数');
  if (!['task', 'source'].includes(mode)) fail('--mode 必须是 task 或 source');
  const repoRoot = await resolveRepo(repo);
  const absoluteCases = path.resolve(cases);
  const loaded = await readCases(absoluteCases);
  let health = null;
  if (includeHealth) health = await inspectHealth({ repo: repoRoot, includeCompile: true });
  if (!loaded.length) {
    return {
      ok: false,
      status: 'skipped',
      reason: 'empty-case-set',
      repo_root: repoRoot,
      cases_path: absoluteCases,
      metrics: { case_count: 0, evaluated_count: 0, skipped_count: 0, hit_at_k: null, mrr: null, coverage: null, answerability_case_count: 0, answerability_pass_rate: null },
      coverage_gate: { required_case_count: 0, pass_rate: null },
      canonical_navigation: { case_count: 0, gated_case_count: 0, canonical_top_1_pass_rate: null, mean_navigation_cost: null },
      ...(health ? { health } : {}),
    };
  }
  const details = [];
  let hits = 0;
  let reciprocalRanks = 0;
  let covered = 0;
  let relevantTotal = 0;
  let answerabilityCases = 0;
  let answerabilityPasses = 0;
  let coverageRequiredCases = 0;
  let coveragePasses = 0;
  let canonicalCases = 0;
  let canonicalTop1Passes = 0;
  let canonicalGateCases = 0;
  let canonicalGatePasses = 0;
  let navigationCostTotal = 0;
  let navigationCostMeasured = 0;
  for (const item of loaded) {
    const k = item.k === undefined ? limit : Number(item.k);
    if (!Number.isInteger(k) || k < 1 || k > limit) fail(`case ${item.id} 的 k 必须是 1 至 --limit`);
    const texts = await Promise.all(item.relevant.map((relative) => readRelevantPage(repoRoot, relative, item.id)));
    await Promise.all(item.preferred.filter((relative) => !item.relevant.includes(relative))
      .map((relative) => readRelevantPage(repoRoot, relative, item.id)));
    const retrievalMode = item.mode || mode;
    const result = await recall({ repo: repoRoot, query: item.query, limit, mode: retrievalMode });
    const ranked = result.candidates.map((candidate) => candidate.path);
    const rank = ranked.findIndex((candidate) => item.relevant.includes(candidate));
    const matched = item.relevant.filter((candidate) => ranked.includes(candidate));
    hits += rank >= 0 && rank < k ? 1 : 0;
    reciprocalRanks += rank >= 0 ? 1 / (rank + 1) : 0;
    covered += matched.length;
    relevantTotal += item.relevant.length;
    const coverageRequired = retrievalMode === 'source' || item.require_coverage;
    const coveragePassed = matched.length === item.relevant.length;
    if (coverageRequired) {
      coverageRequiredCases += 1;
      if (coveragePassed) coveragePasses += 1;
    }
    let canonicalNavigation = null;
    if (item.preferred.length) {
      canonicalCases += 1;
      const preferredRank = ranked.findIndex((candidate) => item.preferred.includes(candidate));
      const canonicalTop1 = preferredRank === 0;
      if (canonicalTop1) canonicalTop1Passes += 1;
      // Source retrieval intentionally prioritizes provenance pages, so the
      // task-navigation Top-1 requirement does not apply in source mode.
      const canonicalGateRequired = retrievalMode === 'task';
      if (canonicalGateRequired) {
        canonicalGateCases += 1;
        if (canonicalTop1) canonicalGatePasses += 1;
      }
      if (preferredRank >= 0) {
        // Rank one needs no follow-up navigation; rank n costs n - 1 hops.
        navigationCostTotal += preferredRank;
        navigationCostMeasured += 1;
      }
      canonicalNavigation = {
        preferred: item.preferred,
        first_preferred_rank: preferredRank >= 0 ? preferredRank + 1 : null,
        canonical_top_1: canonicalTop1,
        gate_required: canonicalGateRequired,
        navigation_cost: preferredRank >= 0 ? preferredRank : null,
      };
    }
    let answerability = null;
    if (item.answer_terms.length) {
      answerabilityCases += 1;
      const evidence = await Promise.all(texts.map((text, index) => rawLocatorEvidence(repoRoot, item.relevant[index], text)));
      const groundedTerms = item.answer_terms.filter((term) => {
        const normalized = term.toLocaleLowerCase();
        return evidence.some((page) => page.blocks.some((block) => block.grounded && block.normalized.includes(normalized)));
      });
      const missingTerms = item.answer_terms.filter((term) => !groundedTerms.includes(term));
      const hasRawLocator = evidence.some((page) => page.has_raw_locator);
      const substantiveCharacterCount = evidence.reduce((total, page) => total + page.substantive_character_count, 0);
      const passed = missingTerms.length === 0 && hasRawLocator && substantiveCharacterCount >= 80;
      if (passed) answerabilityPasses += 1;
      answerability = { passed, missing_terms: missingTerms, grounded_terms: groundedTerms, has_raw_locator: hasRawLocator, substantive_character_count: substantiveCharacterCount };
    }
    details.push({ id: item.id, query: item.query, mode: retrievalMode, relevant: item.relevant, first_relevant_rank: rank >= 0 ? rank + 1 : null, hit_at_k: rank >= 0 && rank < k, coverage_required: coverageRequired, coverage_passed: coveragePassed, answerability, canonical_navigation: canonicalNavigation, retrieved: ranked });
  }
  const caseCount = loaded.length;
  const answerabilityPassRate = answerabilityCases ? answerabilityPasses / answerabilityCases : null;
  const hitAtK = hits / caseCount;
  const coverage = relevantTotal ? covered / relevantTotal : null;
  const coverageGatePassRate = coverageRequiredCases ? coveragePasses / coverageRequiredCases : null;
  const canonicalTop1PassRate = canonicalCases ? canonicalTop1Passes / canonicalCases : null;
  const meanNavigationCost = navigationCostMeasured ? navigationCostTotal / navigationCostMeasured : null;
  return {
    ok: (health ? health.ok : true) && hitAtK === 1
      && (coverageGatePassRate === null || coverageGatePassRate === 1)
      && (answerabilityPassRate === null || answerabilityPassRate === 1)
      && (canonicalGateCases === 0 || canonicalGatePasses === canonicalGateCases),
    status: 'ok',
    mode,
    retrieval_mode: 'retrieval-only-ranking-with-deterministic-answerability-guards',
    repo_root: repoRoot,
    cases_path: absoluteCases,
    metrics: {
      case_count: caseCount,
      evaluated_count: caseCount,
      skipped_count: 0,
      hit_at_k: hitAtK,
      mrr: reciprocalRanks / caseCount,
      coverage,
      answerability_case_count: answerabilityCases,
      answerability_pass_rate: answerabilityPassRate,
    },
    coverage_gate: {
      required_case_count: coverageRequiredCases,
      pass_rate: coverageGatePassRate,
    },
    canonical_navigation: {
      case_count: canonicalCases,
      gated_case_count: canonicalGateCases,
      canonical_top_1_pass_rate: canonicalTop1PassRate,
      mean_navigation_cost: meanNavigationCost,
    },
    cases: details,
    ...(health ? { health } : {}),
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--health') { options.health = true; continue; }
    if (!item.startsWith('--')) fail(`无法识别的参数: ${item}`);
    const [key, inline] = item.slice(2).split(/=(.*)/s, 2);
    if (!['repo', 'cases', 'limit', 'mode'].includes(key) || Object.hasOwn(options, key)) fail(`参数无效或重复: ${item}`);
    const value = inline ?? argv[++index];
    if (!value || value.startsWith('--')) fail(`参数缺少值: ${item}`);
    options[key] = value;
  }
  return { repo: options.repo, cases: options.cases, limit: options.limit === undefined ? 10 : Number(options.limit), mode: options.mode || 'task', includeHealth: Boolean(options.health) };
}

async function main(argv) {
  if (!argv.length || ['--help', '-h', 'help'].includes(argv[0])) {
    process.stdout.write('用法: wiki_eval.mjs --cases CASES.jsonl [--repo PATH] [--limit 10] [--mode task|source] [--health]\n');
    return;
  }
  const result = await evaluate(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 2;
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (direct) main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
});

export { evaluate, readCases };
