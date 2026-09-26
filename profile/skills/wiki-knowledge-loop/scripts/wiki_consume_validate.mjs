#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SECTION_TITLES = [
  '新发现',
  '与已有知识的联系',
  '矛盾与证据缺口',
  '对后续工作的影响',
  '费曼式自测问题',
  '是否值得长期保存',
];
const EXPLICIT_NONE = {
  '与已有知识的联系': '没有找到可靠的已有知识关联。',
  '矛盾与证据缺口': '没有发现需要补充说明的矛盾或证据缺口。',
};
const FORBIDDEN_INTERNAL_TERMS = [
  'shared_source_lineage',
  'lexical_recall',
  'noise_risk',
  'durable_write_authorized',
];
const RELATIONSHIP_LABELS = ['来自同一份原始材料', '只是文字相似，尚未证实相关'];
const PERSISTENCE_DISPLAY = {
  'no-durable-value': '不建议长期保存',
  'proposal-only': '仅提出保存建议，等待用户授权',
};
const VAGUE_TERMS = ['赋能', '抓手', '沉淀', '范式', '闭环', '颗粒度'];
const LIST_ITEM = /^(?:[-*+]\s+|\d+[.)]\s+)(.*)$/;

function issue(code, message, extra = {}) {
  return { code, message, ...extra };
}

function headingsOf(markdown) {
  const headings = [];
  let inFence = false;
  let offset = 0;
  for (const [lineIndex, line] of markdown.split(/\r?\n/).entries()) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence) {
      const match = line.match(/^##\s+(.+?)\s*$/);
      if (match) headings.push({ title: match[1], index: offset, line: lineIndex + 1, end: offset + line.length });
    }
    const newlineStart = offset + line.length;
    const newlineLength = markdown.startsWith('\r\n', newlineStart) ? 2 : (markdown.startsWith('\n', newlineStart) ? 1 : 0);
    offset = newlineStart + newlineLength;
  }
  return headings;
}

function sectionBodies(markdown, headings) {
  const bodies = new Map();
  for (let index = 0; index < headings.length; index += 1) {
    const current = headings[index];
    const next = headings[index + 1];
    if (!bodies.has(current.title)) {
      const bodyStart = current.end + (markdown.startsWith('\r\n', current.end) ? 2 : (markdown.startsWith('\n', current.end) ? 1 : 0));
      bodies.set(current.title, markdown.slice(bodyStart, next?.index ?? markdown.length));
    }
  }
  return bodies;
}

function listItems(body) {
  const items = [];
  let current;
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(LIST_ITEM);
    if (match) {
      if (current) items.push(current.trim());
      current = match[1];
    } else if (current && line.trim()) {
      current += `\n${line.trim()}`;
    }
  }
  if (current) items.push(current.trim());
  return items;
}

function sentenceEndCount(item) {
  return (item.match(/[。！？!?]/g) || []).length
    + (item.match(/\.(?=\s|$|["')\]）】])/g) || []).length;
}

function addLongItemWarnings(warnings, section, items) {
  items.forEach((item, index) => {
    const endings = sentenceEndCount(item);
    if (endings > 2) {
      warnings.push(issue('long-item', '单个项目包含超过两个句末标点，建议拆分。', {
        section,
        item: index + 1,
        sentence_endings: endings,
      }));
    }
  });
}

/**
 * Deterministically validate an ephemeral post-ingest learning response.
 * This function is pure: it neither reads files nor changes process state.
 */
export function validateLearningResponse(markdown) {
  const text = typeof markdown === 'string' ? markdown : '';
  const errors = [];
  const warnings = [];
  const headings = headingsOf(text);
  const bodies = sectionBodies(text, headings);
  const sectionCounts = Object.fromEntries(SECTION_TITLES.map((title) => [title, 0]));

  if (typeof markdown !== 'string') {
    errors.push(issue('invalid-markdown', 'Markdown 回答必须是字符串。'));
  }

  const firstHeading = headings[0];
  const conclusion = firstHeading ? text.slice(0, firstHeading.index).replace(/<!--([\s\S]*?)-->/g, '').trim() : '';
  if (!conclusion) errors.push(issue('missing-conclusion', '首个 ## 标题前必须有非空结论。'));

  const actualTitles = headings.map((heading) => heading.title);
  for (const title of SECTION_TITLES) {
    const count = actualTitles.filter((actual) => actual === title).length;
    if (count === 0) errors.push(issue('missing-section', `缺少章节：${title}。`, { section: title }));
    if (count > 1) errors.push(issue('duplicate-section', `章节只能出现一次：${title}。`, { section: title, count }));
  }
  for (const heading of headings) {
    if (!SECTION_TITLES.includes(heading.title)) {
      errors.push(issue('unexpected-section', `不允许的 ## 章节：${heading.title}。`, { section: heading.title, line: heading.line }));
    }
  }
  if (actualTitles.join('\u0000') !== SECTION_TITLES.join('\u0000')) {
    errors.push(issue('section-order', '六个 ## 章节必须各出现一次且顺序固定。'));
  }

  for (const term of FORBIDDEN_INTERNAL_TERMS) {
    if (text.includes(term)) errors.push(issue('internal-enumeration', `回答不得向用户展示内部枚举：${term}。`, { term }));
  }
  if (text.includes('/Users/')) errors.push(issue('absolute-users-path', '回答不得包含 /Users/ 绝对路径。'));

  for (const term of VAGUE_TERMS) {
    let start = 0;
    while (true) {
      const index = text.indexOf(term, start);
      if (index < 0) break;
      warnings.push(issue('vague-term', `疑似空泛词：${term}。`, { term, index }));
      start = index + term.length;
    }
  }

  const allItems = new Map();
  for (const title of SECTION_TITLES) {
    const items = listItems(bodies.get(title) || '');
    allItems.set(title, items);
    sectionCounts[title] = items.length;
    addLongItemWarnings(warnings, title, items);
  }

  const discoveries = allItems.get('新发现');
  if (discoveries.length < 3 || discoveries.length > 5) {
    errors.push(issue('new-discovery-count', '“新发现”必须有 3–5 个项目。', { count: discoveries.length }));
  }
  discoveries.forEach((item, index) => {
    if (!/raw\/[^\s)\]，。；;]+/.test(item)) {
      errors.push(issue('missing-raw-locator', '“新发现”的每个项目必须包含 raw/ 定位。', { item: index + 1 }));
    }
  });

  for (const title of ['与已有知识的联系', '矛盾与证据缺口']) {
    const body = (bodies.get(title) || '').trim();
    const items = allItems.get(title);
    if (body !== EXPLICIT_NONE[title] && items.length === 0) {
      errors.push(issue('missing-section-content', `“${title}”必须包含项目，或使用规定的无结果句。`, { section: title }));
    }
  }

  const connections = allItems.get('与已有知识的联系');
  connections.forEach((item, index) => {
    if (!RELATIONSHIP_LABELS.some((label) => item.includes(label))) {
      errors.push(issue('missing-relationship-label', '知识联系必须使用契约提供的中文关系说明。', { item: index + 1 }));
    }
  });

  const futureActions = allItems.get('对后续工作的影响');
  if (futureActions.length < 1) {
    errors.push(issue('future-action-count', '“对后续工作的影响”至少需要一个项目。', { count: futureActions.length }));
  }

  const feynmanQuestions = allItems.get('费曼式自测问题');
  if (feynmanQuestions.length !== 3) {
    errors.push(issue('feynman-question-count', '“费曼式自测问题”必须恰好有 3 个项目。', { count: feynmanQuestions.length }));
  }

  const persistenceBody = bodies.get('是否值得长期保存') || '';
  const persistenceMatches = [...persistenceBody.matchAll(/\b(no-durable-value|proposal-only)\b/g)].map((match) => match[1]);
  sectionCounts['是否值得长期保存'] = persistenceMatches.length;
  const persistenceDecision = persistenceMatches.length === 1 ? persistenceMatches[0] : null;
  if (persistenceMatches.length !== 1) {
    errors.push(issue('persistence-decision-count', '“是否值得长期保存”必须且只能出现一次 no-durable-value 或 proposal-only。', {
      count: persistenceMatches.length,
    }));
  }
  if (persistenceDecision) {
    const machineValueIndex = persistenceBody.indexOf(persistenceDecision);
    const displayValue = PERSISTENCE_DISPLAY[persistenceDecision];
    const displayValueIndex = persistenceBody.indexOf(displayValue);
    if (displayValueIndex < 0 || displayValueIndex > machineValueIndex) {
      errors.push(issue('missing-persistence-display', `保存决定必须先写中文说明“${displayValue}”，再写机器值 ${persistenceDecision}。`, {
        persistence_decision: persistenceDecision,
      }));
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    section_counts: sectionCounts,
    persistence_decision: persistenceDecision,
  };
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--response' || !argv[1]) {
    throw new Error('usage: node wiki_consume_validate.mjs --response <file>');
  }
  return { response: argv[1] };
}

function main() {
  try {
    const { response } = parseArgs(process.argv.slice(2));
    const responsePath = path.resolve(response);
    if (!existsSync(responsePath)) throw new Error('response file not found');
    const stat = lstatSync(responsePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('response file must be a regular non-symbolic-link file');
    const result = validateLearningResponse(readFileSync(responsePath, 'utf8'));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
