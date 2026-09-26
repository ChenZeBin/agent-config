#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function fail(message, details = {}) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: message, ...details }, null, 2)}\n`);
  process.exitCode = 1;
}

function argsOf(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`unexpected argument: ${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${key}`);
    out[key.slice(2)] = value;
    i += 1;
  }
  return out;
}

function inside(parent, candidate) {
  const rel = path.relative(parent, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function scalar(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*["']?(.*?)["']?\\s*$`, 'm'));
  return match?.[1]?.trim() || '';
}

function list(frontmatter, key) {
  const lines = frontmatter.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^${key}:\\s*$`).test(line));
  if (start < 0) return [];
  const values = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const match = lines[i].match(/^\s+-\s+(.+?)\s*$/);
    if (match) values.push(match[1].replace(/^['"]|['"]$/g, ''));
    else if (/^[A-Za-z_][\w-]*:/.test(lines[i])) break;
  }
  return values;
}

function rawLineage(repoRoot, rawPath) {
  const relative = path.relative(path.join(repoRoot, 'raw'), rawPath).split(path.sep).join('/');
  const segments = relative.split('/');
  if (segments.length >= 2 && ['wechat', 'wechat-channels', 'x', 'bilibili', 'youtube', 'sessions'].includes(segments[0])) {
    return `raw/${segments[0]}/${segments[1]}`;
  }
  return `raw/${relative}`;
}

const RELATIONSHIP_DISPLAY = {
  shared_source_lineage: '来自同一份原始材料',
  lexical_recall: '只是文字相似，尚未证实相关',
};

const NOISE_RISK_DISPLAY = {
  low: '误关联风险较低',
  high: '误关联风险较高，需先核实',
};

function responseContract() {
  return {
    version: '1.1',
    response_kind: 'immediate_learning_response',
    required_sections: {
      new_ideas: {
        min_items: 3,
        max_items: 5,
        require_raw_locator: true,
      },
      connections: {
        min_items: 0,
        allow_explicit_none: true,
        require_related_candidate_reference: true,
        require_relationship_label: true,
      },
      contradictions_and_gaps: {
        min_items: 1,
        allow_explicit_none: true,
        require_raw_locator_or_explicit_gap: true,
      },
      future_actions: {
        min_items: 1,
        require_concrete_next_step: true,
      },
      feynman_questions: {
        exact_items: 3,
      },
    },
    related_candidate_policy: {
      prioritize_shared_source_lineage: true,
      maximum_lexical_candidates: 2,
      lexical_candidates_must_be_labeled: true,
      verify_raw_evidence_before_making_source_backed_connection: true,
    },
    presentation: {
      language: 'zh-CN',
      default_audience: '了解基本技术，但不熟悉本仓库内部名称的读者',
      headings: {
        new_ideas: '新发现',
        connections: '与已有知识的联系',
        contradictions_and_gaps: '矛盾与证据缺口',
        future_actions: '对后续工作的影响',
        feynman_questions: '费曼式自测问题',
        persistence_decision: '是否值得长期保存',
      },
      style: {
        lead_with_conclusion: true,
        max_sentences_per_item: 2,
        use_plain_specific_words: true,
        use_concrete_verbs_for_actions: true,
        explain_unfamiliar_technical_terms_on_first_use: true,
        preserve_exact_source_terms_code_and_locators: true,
        warn_on_empty_jargon_when_plain_alternative_exists: true,
        no_internal_identifiers_in_user_headings: true,
        do_not_emit_absolute_local_paths: true,
      },
      relationship_display: RELATIONSHIP_DISPLAY,
      noise_risk_display: NOISE_RISK_DISPLAY,
      persistence_display: {
        'no-durable-value': '不建议长期保存',
        'proposal-only': '仅提出保存建议，等待用户授权',
      },
      explicit_none_text: {
        connections: '没有找到可靠的已有知识关联。',
        contradictions_and_gaps: '没有发现需要补充说明的矛盾或证据缺口。',
      },
      examples: [
        {
          avoid: '建立摄取后消费闭环，提升知识复用与召回效能。',
          prefer: '文章入库后，立即告诉读者有哪些新结论，以后遇到什么问题可以用上它。',
        },
        {
          avoid: '对召回候选进行语义过滤。',
          prefer: '只引用真正相关的旧知识；找不到就明确说没有。',
        },
      ],
    },
    quality_evaluation: {
      validator_script: '.agents/skills/wiki-knowledge-loop/scripts/wiki_consume_validate.mjs',
      deterministic_checks: [
        'required-sections-and-counts',
        'raw-locators',
        'single-persistence-decision',
        'no-absolute-local-paths',
        'no-user-visible-internal-identifiers',
      ],
      semantic_dimensions: [
        'plainness',
        'audience-fit',
        'informativeness',
        'faithfulness',
        'coherence',
        'usefulness',
      ],
      require_representative_output_fixtures: true,
      require_human_paraphrase_spot_check: true,
      jargon_and_sentence_length_are_warnings: true,
      single_readability_score_is_not_sufficient: true,
    },
    durable_write_candidate: {
      decision_exact_items: 1,
      allowed_decisions: ['no-durable-value', 'proposal-only'],
      max_items: 1,
      user_authorization_required: true,
      durable_write_authorized: false,
    },
  };
}

export function buildConsumptionContext({ repo, sourcePage, relatedLimit = 5, query }) {
  const repoRoot = realpathSync(repo);
  const sourcesRoot = realpathSync(path.join(repoRoot, 'wiki', 'sources'));
  const requested = path.resolve(repoRoot, sourcePage);
  if (!existsSync(requested)) throw new Error(`source page not found: ${sourcePage}`);
  const requestedStat = lstatSync(requested);
  if (!requestedStat.isFile() || requestedStat.isSymbolicLink()) throw new Error('source page must be a regular file');
  const pagePath = realpathSync(requested);
  if (!inside(sourcesRoot, pagePath)) throw new Error('source page must be below wiki/sources');

  const text = readFileSync(pagePath, 'utf8');
  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) throw new Error('source page has no YAML frontmatter');
  const title = scalar(fmMatch[1], 'title');
  if (!title) throw new Error('source page has no title');

  const rawRoot = realpathSync(path.join(repoRoot, 'raw'));
  const rawSources = list(fmMatch[1], 'sources').map((entry) => {
    const resolved = path.resolve(path.dirname(pagePath), entry);
    if (!existsSync(resolved)) throw new Error(`raw source not found: ${entry}`);
    const stat = lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`raw source must be a regular file: ${entry}`);
    const real = realpathSync(resolved);
    if (!inside(rawRoot, real)) throw new Error(`source escapes raw/: ${entry}`);
    return real;
  });
  if (rawSources.length === 0) throw new Error('source page has no raw sources');

  const recallPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'wiki_recall.mjs');
  if (!existsSync(recallPath)) throw new Error('wiki_recall.mjs is missing');
  const recall = spawnSync(process.execPath, [
    recallPath,
    '--repo', repoRoot,
    '--query', query || title,
    '--limit', String(Math.max(relatedLimit + 3, 8)),
  ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (recall.status !== 0) throw new Error(`recall failed: ${recall.stdout || recall.stderr}`);
  const payload = JSON.parse(recall.stdout);
  const results = payload.candidates || payload.results || payload.data?.results || [];
  const sourceLineages = [...new Set(rawSources.map((rawSource) => rawLineage(repoRoot, rawSource)))].sort();
  const relatedCandidates = results
    .filter((item) => {
      const candidate = item.path || item.file || item.absolute_path;
      return candidate && path.resolve(repoRoot, candidate) !== pagePath;
    })
    .map((item) => {
      const candidateLineages = Array.isArray(item.evidence_lineages) ? item.evidence_lineages : [];
      const sharedSourceLineages = candidateLineages.filter((lineage) => sourceLineages.includes(lineage)).sort();
      const relationship = sharedSourceLineages.length > 0 ? 'shared_source_lineage' : 'lexical_recall';
      return {
        ...item,
        relationship,
        relationship_label: RELATIONSHIP_DISPLAY[relationship],
        shared_source_lineages: sharedSourceLineages,
        noise_risk: relationship === 'shared_source_lineage' ? 'low' : 'high',
        noise_risk_label: relationship === 'shared_source_lineage'
          ? NOISE_RISK_DISPLAY.low
          : NOISE_RISK_DISPLAY.high,
      };
    })
    .sort((left, right) => {
      const relationOrder = Number(right.relationship === 'shared_source_lineage') - Number(left.relationship === 'shared_source_lineage');
      if (relationOrder) return relationOrder;
      return (right.score || 0) - (left.score || 0) || String(left.path || '').localeCompare(String(right.path || ''));
    });
  const related = [];
  for (const candidate of relatedCandidates) {
    if (related.length >= relatedLimit) break;
    if (candidate.relationship === 'lexical_recall'
      && related.filter((item) => item.relationship === 'lexical_recall').length >= 2) continue;
    related.push(candidate);
  }

  return {
    ok: true,
    mode: 'consume',
    source_page: pagePath,
    title,
    raw_sources: rawSources,
    source_lineages: sourceLineages,
    related,
    sections: ['new_ideas', 'connections', 'contradictions_and_gaps', 'future_actions', 'feynman_questions'],
    response_contract: responseContract(),
    durable_write_authorized: false,
  };
}

function main() {
  let args;
  try {
    args = argsOf(process.argv.slice(2));
    if (!args.repo || !args['source-page']) throw new Error('required: --repo and --source-page');
    const relatedLimit = Number.parseInt(args['related-limit'] || '5', 10);
    if (!Number.isInteger(relatedLimit) || relatedLimit < 0 || relatedLimit > 20) {
      throw new Error('--related-limit must be an integer from 0 to 20');
    }
    const result = buildConsumptionContext({
      repo: args.repo,
      sourcePage: args['source-page'],
      relatedLimit,
      query: args.query,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    fail(error.message);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
