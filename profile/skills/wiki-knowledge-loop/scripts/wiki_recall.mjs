#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CONTENT_DIRECTORIES = new Set(['sources', 'entities', 'concepts', 'analyses']);

function fail(message) {
  throw new Error(message);
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function posix(value) {
  return value.split(path.sep).join('/');
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function regularFile(target, label) {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) fail(`${label}不是普通文件: ${target}`);
}

async function resolveRepo(input) {
  let current = path.resolve(input || process.cwd());
  while (true) {
    const [root, agents, wiki] = await Promise.all([
      fs.lstat(current).catch(() => null),
      fs.lstat(path.join(current, 'AGENTS.md')).catch(() => null),
      fs.lstat(path.join(current, 'wiki')).catch(() => null),
    ]);
    if (root?.isDirectory() && !root.isSymbolicLink()
      && agents?.isFile() && !agents.isSymbolicLink()
      && wiki?.isDirectory() && !wiki.isSymbolicLink()) return current;
    const parent = path.dirname(current);
    if (parent === current || input) fail(`不是有效 wiki 仓库: ${current}`);
    current = parent;
  }
}

function frontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return { yaml: match?.[1] || '', body: match ? text.slice(match[0].length) : text };
}

function unquote(value) {
  const trimmed = String(value || '').trim();
  const match = trimmed.match(/^(?:"([\s\S]*)"|'([\s\S]*)')$/);
  return match ? match[1] ?? match[2] : trimmed;
}

function scalar(yaml, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = yaml.match(new RegExp(`^\\s*${escaped}:\\s*(.*?)\\s*$`, 'm'));
  const value = unquote(match?.[1]);
  return value && value !== 'null' ? value : '';
}

function list(yaml, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lines = yaml.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(new RegExp(`^(\\s*)${escaped}:\\s*(.*?)\\s*$`));
    if (!match) continue;
    const indent = match[1].length;
    const inline = match[2].trim();
    if (inline.startsWith('[') && inline.endsWith(']')) return inline.slice(1, -1).split(',').map(unquote).filter(Boolean);
    const values = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (!lines[cursor].trim()) continue;
      if (lines[cursor].match(/^\s*/)[0].length <= indent) break;
      const item = lines[cursor].match(/^\s*-\s*(.*?)\s*$/);
      if (item?.[1]) values.push(unquote(item[1]));
    }
    return values;
  }
  return [];
}

function indexEntries(indexText) {
  const entries = new Map();
  for (const match of indexText.matchAll(/^- \[([^\]\n]+)\]\(([^)\n]+)\)\s*—\s*(.+?)\s+Updated \d{4}-\d{2}-\d{2};\s+\d+ sources?\.$/gm)) {
    const target = match[2].trim().split('#', 1)[0];
    if (!target || /^(?:[a-z]+:|#)/i.test(target)) continue;
    const existing = entries.get(target) || [];
    existing.push({ title: match[1].trim(), summary: match[3].trim() });
    entries.set(target, existing);
  }
  return entries;
}

async function wikiPages(repoRoot) {
  const wikiRoot = path.join(repoRoot, 'wiki');
  const pages = [];
  for (const directory of [...CONTENT_DIRECTORIES].sort(compare)) {
    const base = path.join(wikiRoot, directory);
    const stat = await fs.lstat(base).catch(() => null);
    if (!stat) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`Wiki 分类目录无效: ${base}`);
    async function walk(current) {
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => compare(left.name, right.name))) {
        const absolute = path.join(current, entry.name);
        if (entry.isSymbolicLink()) fail(`Wiki 不允许符号链接: ${absolute}`);
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.isFile() && entry.name.endsWith('.md')) pages.push(absolute);
        else if (!entry.isFile()) fail(`Wiki 含特殊文件: ${absolute}`);
      }
    }
    await walk(base);
  }
  return pages.sort(compare);
}

function queryTerms(query) {
  const normalized = query.trim().toLocaleLowerCase('und');
  const stopwords = new Set(['的', '了', '把', '成', '和', '与', '在', '为', '是', '及', '一个', '一种', '怎么', '如何']);
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
  const terms = new Set(
    [...segmenter.segment(normalized)]
      .filter((segment) => segment.isWordLike)
      .map((segment) => segment.segment.trim())
      .filter((term) => term && !stopwords.has(term)),
  );
  return [...terms].sort(compare);
}

function matchingFields(terms, fields) {
  const matches = [];
  let score = 0;
  for (const term of terms) {
    let best = 0;
    for (const field of fields) {
      if (!field.text.toLocaleLowerCase('und').includes(term)) continue;
      matches.push(field.name);
      best = Math.max(best, field.weight);
    }
    score += best;
  }
  return { score, matches: [...new Set(matches)].sort(compare) };
}

function evidenceLineage(repoRoot, page, parsed) {
  const rawRoot = path.join(repoRoot, 'raw');
  const values = [
    ...list(parsed.yaml, 'sources'),
    scalar(parsed.yaml, 'raw_manifest'),
  ].filter(Boolean);
  const lineages = new Set();
  for (const value of values) {
    const resolved = path.resolve(path.dirname(page), value);
    if (!inside(rawRoot, resolved)) continue;
    const relative = posix(path.relative(rawRoot, resolved));
    const segments = relative.split('/');
    // Platform bundles are a single independent source even when multiple
    // derivative pages cite article.md, manifests, responses, or subtitles.
    if (segments.length >= 2 && ['wechat', 'wechat-channels', 'x', 'bilibili', 'youtube', 'sessions'].includes(segments[0])) {
      lineages.add(`raw/${segments[0]}/${segments[1]}`);
    } else {
      lineages.add(`raw/${relative}`);
    }
  }
  return [...lineages].sort(compare);
}

function modeAdjustment(type, status, mode) {
  if (mode === 'source') return type === 'source' ? 90 : 0;
  if (status === 'superseded') return -Infinity;
  // Task recall should lead with reusable canonical knowledge, not a source
  // page that happens to repeat the same words.
  if (type === 'concept' || type === 'analysis') return 50;
  if (type === 'entity') return 15;
  if (type === 'source') return -25;
  return 0;
}

async function recall({ repo, query, limit = 10, mode = 'task' } = {}) {
  if (typeof query !== 'string' || !query.trim()) fail('--query 不能为空');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('--limit 必须是 1 至 100 的整数');
  if (!['task', 'source'].includes(mode)) fail('--mode 必须是 task 或 source');
  const repoRoot = await resolveRepo(repo);
  const indexPath = path.join(repoRoot, 'wiki', '索引.md');
  await regularFile(indexPath, 'wiki/索引.md');
  const index = indexEntries(await fs.readFile(indexPath, 'utf8'));
  const terms = queryTerms(query);
  const candidates = [];
  for (const page of await wikiPages(repoRoot)) {
    const relative = posix(path.relative(path.join(repoRoot, 'wiki'), page));
    const text = await fs.readFile(page, 'utf8');
    const parsed = frontmatter(text);
    const entries = index.get(relative) || [];
    const type = scalar(parsed.yaml, 'type') || null;
    const status = scalar(parsed.yaml, 'status') || null;
    const result = matchingFields(terms, [
      ...entries.map((entry) => ({ name: 'index_title', text: entry.title, weight: 100 })),
      { name: 'title', text: scalar(parsed.yaml, 'title'), weight: 80 },
      { name: 'tags', text: list(parsed.yaml, 'tags').join(' '), weight: 60 },
      ...entries.map((entry) => ({ name: 'index_summary', text: entry.summary, weight: 80 })),
      { name: 'heading', text: [...parsed.body.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => match[1]).join(' '), weight: 30 },
      { name: 'body', text: parsed.body, weight: 10 },
    ]);
    if (!result.score) continue;
    const adjustment = modeAdjustment(type, status, mode);
    if (adjustment === -Infinity) continue;
    candidates.push({
      path: `wiki/${relative}`,
      title: scalar(parsed.yaml, 'title') || path.basename(page, '.md'),
      type,
      status,
      score: result.score + adjustment,
      matches: result.matches,
      evidence_lineages: evidenceLineage(repoRoot, page, parsed),
    });
  }
  candidates.sort((left, right) => right.score - left.score || compare(left.path, right.path));
  const selected = candidates.slice(0, limit);
  const independentLineages = new Set(selected.flatMap((candidate) => candidate.evidence_lineages));
  return {
    ok: true,
    repo_root: repoRoot,
    query,
    limit,
    mode,
    candidate_count: candidates.length,
    independent_source_count: independentLineages.size,
    candidates: selected.map((candidate) => ({
      ...candidate,
      independent_source_count: candidate.evidence_lineages.length,
    })),
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) fail(`无法识别的参数: ${item}`);
    const [key, inline] = item.slice(2).split(/=(.*)/s, 2);
    if (!['repo', 'query', 'limit', 'mode'].includes(key) || Object.hasOwn(options, key)) fail(`参数无效或重复: ${item}`);
    const value = inline ?? argv[++index];
    if (!value || value.startsWith('--')) fail(`参数缺少值: ${item}`);
    options[key] = value;
  }
  return { repo: options.repo, query: options.query, limit: options.limit === undefined ? 10 : Number(options.limit), mode: options.mode || 'task' };
}

async function main(argv) {
  if (!argv.length || ['--help', '-h', 'help'].includes(argv[0])) {
    process.stdout.write('用法: wiki_recall.mjs --query QUERY [--repo PATH] [--limit 10] [--mode task|source]\n');
    return;
  }
  process.stdout.write(`${JSON.stringify(await recall(parseArgs(argv)), null, 2)}\n`);
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (direct) main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
});

export { frontmatter, list, recall, resolveRepo, scalar, wikiPages };
