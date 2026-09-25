#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const VERSION = '1.0.0';
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

const PLATFORMS = {
  wechat: {
    label: '微信公众号文章',
    rawDirectory: 'wechat',
    captureScope: 'single-article',
    script: '.agents/skills/wechat-ingest/scripts/wechat_auto_capture.mjs',
    captureCommand: 'ingest-url',
    verifyScript: '.agents/skills/wechat-ingest/scripts/wechat_ingest.mjs',
    parserScript: '.agents/skills/wechat-ingest/scripts/wechat_ingest.mjs',
    parserExport: 'canonicalizeUrl',
  },
  'wechat-channels': {
    label: '微信视频号公开分享',
    rawDirectory: 'wechat-channels',
    captureScope: 'single-public-share-preview',
    script: '.agents/skills/wechat-channels-ingest/scripts/wechat_channels_ingest.mjs',
    captureCommand: 'ingest',
    verifyScript: '.agents/skills/wechat-channels-ingest/scripts/wechat_channels_ingest.mjs',
    parserScript: '.agents/skills/wechat-channels-ingest/scripts/wechat_channels_ingest.mjs',
    parserExport: 'parseChannelsUrl',
  },
  x: {
    label: 'X/Twitter 公开单帖',
    rawDirectory: 'x',
    captureScope: 'single-post',
    script: '.agents/skills/x-ingest/scripts/x_ingest.mjs',
    captureCommand: 'ingest',
    verifyScript: '.agents/skills/x-ingest/scripts/x_ingest.mjs',
    parserScript: '.agents/skills/x-ingest/scripts/x_ingest.mjs',
    parserExport: 'parseStatusUrl',
  },
  bilibili: {
    label: 'Bilibili UGC 视频',
    rawDirectory: 'bilibili',
    captureScope: 'single-video-all-pages',
    script: '.agents/skills/bilibili-ingest/scripts/bilibili_ingest.mjs',
    captureCommand: 'ingest',
    verifyScript: '.agents/skills/bilibili-ingest/scripts/bilibili_ingest.mjs',
    parserScript: '.agents/skills/bilibili-ingest/scripts/bilibili_ingest.mjs',
    parserExport: 'parseVideoUrl',
  },
  youtube: {
    label: 'YouTube 单个公开视频',
    rawDirectory: 'youtube',
    captureScope: 'single-public-video',
    script: '.agents/skills/youtube-ingest/scripts/youtube_ingest.mjs',
    captureCommand: 'ingest',
    verifyScript: '.agents/skills/youtube-ingest/scripts/youtube_ingest.mjs',
    parserScript: '.agents/skills/youtube-ingest/scripts/youtube_ingest.mjs',
    parserExport: 'parseVideoUrl',
  },
};

const PLATFORM_BY_RAW_DIRECTORY = new Map(
  Object.entries(PLATFORMS).map(([name, value]) => [value.rawDirectory, name]),
);

class CliError extends Error {
  constructor(message, code = 'cli-error', details = undefined) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.details = details;
  }
}

async function plainDirectory(target) {
  const stat = await fs.lstat(target).catch(() => null);
  return Boolean(stat?.isDirectory() && !stat.isSymbolicLink());
}

async function regularFile(target) {
  const stat = await fs.lstat(target).catch(() => null);
  return Boolean(stat?.isFile() && !stat.isSymbolicLink());
}

async function validRepo(candidate) {
  return plainDirectory(candidate)
    && regularFile(path.join(candidate, 'AGENTS.md'))
    && plainDirectory(path.join(candidate, 'wiki'))
    && plainDirectory(path.join(candidate, '.agents', 'skills'));
}

async function discoverRepo(explicit, options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const candidates = [];
  if (explicit) candidates.push(path.resolve(cwd, explicit));
  else if (env.MY_WIKI_ROOT) candidates.push(path.resolve(env.MY_WIKI_ROOT));
  else {
    let current = cwd;
    while (true) {
      candidates.push(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    candidates.push(path.join(home, 'my-wiki'));
  }
  for (const candidate of [...new Set(candidates)]) {
    if (await validRepo(candidate)) return candidate;
  }
  const requested = explicit || env.MY_WIKI_ROOT || path.join(home, 'my-wiki');
  throw new CliError(
    `找不到有效的 my-wiki 仓库: ${requested}`,
    'repo-not-found',
    { hint: '使用 --repo PATH 或设置 MY_WIKI_ROOT。' },
  );
}

function checkedUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new CliError('链接不是有效 URL', 'invalid-url');
  }
  if (parsed.protocol !== 'https:') throw new CliError('只接受 HTTPS 链接', 'unsupported-url');
  if (parsed.username || parsed.password || parsed.port) {
    throw new CliError('链接不得包含凭据或自定义端口', 'unsafe-url');
  }
  return parsed;
}

function platformForUrl(parsed) {
  const host = parsed.hostname.toLowerCase();
  if (host === 'mp.weixin.qq.com' && (parsed.pathname === '/s' || parsed.pathname.startsWith('/s/'))) return 'wechat';
  if ((host === 'weixin.qq.com' && parsed.pathname.startsWith('/sph/'))
    || (host === 'channels.weixin.qq.com' && parsed.pathname === '/finder-preview/pages/sph')) return 'wechat-channels';
  if ((host === 'x.com' || host === 'twitter.com') && /^\/[^/]+\/status\/\d+\/?$/.test(parsed.pathname)) return 'x';
  if (host === 'www.bilibili.com' && /^\/video\/BV[0-9A-Za-z]+\/?$/.test(parsed.pathname)) return 'bilibili';
  if (host === 'youtu.be' && /^\/[^/]+\/?$/.test(parsed.pathname)) return 'youtube';
  if (host === 'www.youtube.com' && (parsed.pathname === '/watch' || /^\/shorts\/[^/]+\/?$/.test(parsed.pathname))) return 'youtube';
  throw new CliError('该 host/path 不在 my-wiki 自动解析范围内', 'unsupported-url');
}

async function importAdapter(repo, platform) {
  const spec = PLATFORMS[platform];
  const target = path.join(repo, spec.parserScript);
  if (!await regularFile(target)) throw new CliError(`缺少平台适配器: ${spec.parserScript}`, 'adapter-missing');
  return import(pathToFileURL(target).href);
}

function normalizedParserResult(platform, parsed) {
  if (typeof parsed === 'string') return { canonical_url: parsed };
  if (!parsed || typeof parsed !== 'object') throw new CliError('平台解析器返回无效结果', 'adapter-invalid-result');
  const canonical = parsed.canonical_url || parsed.original_url;
  if (typeof canonical !== 'string') throw new CliError('平台解析器未返回 canonical URL', 'adapter-invalid-result');
  const identity = {};
  for (const key of ['short_uri', 'status_id', 'bvid', 'video_id']) {
    if (parsed[key] !== undefined) identity[key] = parsed[key];
  }
  return { canonical_url: canonical, identity };
}

async function classifyUrl(value, repo) {
  const initial = checkedUrl(value);
  const platform = platformForUrl(initial);
  const spec = PLATFORMS[platform];
  const adapter = await importAdapter(repo, platform);
  const parser = adapter[spec.parserExport];
  if (typeof parser !== 'function') throw new CliError(`平台适配器未导出 ${spec.parserExport}`, 'adapter-invalid');
  let normalized;
  try {
    normalized = normalizedParserResult(platform, parser(value));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(error.message || '平台解析器拒绝该链接', 'invalid-platform-url');
  }
  return {
    ok: true,
    supported: true,
    platform,
    platform_label: spec.label,
    canonical_url: normalized.canonical_url,
    capture_scope: spec.captureScope,
    raw_directory: `raw/${spec.rawDirectory}`,
    identity: normalized.identity || {},
  };
}

function backendCommand(repo, relativeScript, command, option, value) {
  return [process.execPath, path.join(repo, relativeScript), command, option, value, '--repo', repo];
}

async function planCapture(url, repo) {
  const classification = await classifyUrl(url, repo);
  const spec = PLATFORMS[classification.platform];
  return {
    ok: true,
    action: 'capture-plan',
    dry_run: true,
    ...classification,
    command: backendCommand(repo, spec.script, spec.captureCommand, '--url', classification.canonical_url),
    mutates: ['staging/', `raw/${spec.rawDirectory}/`],
    full_wiki_compile: false,
    note: 'capture 只固化并验证 raw；“炼化”还必须继续执行 my-wiki 的 article-ingest 编译、审查与一致性门禁。',
  };
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function planVerify(rawInput, repo) {
  const rawRoot = path.join(repo, 'raw');
  const rawBundle = path.resolve(repo, rawInput);
  if (!inside(rawRoot, rawBundle)) throw new CliError('raw bundle 必须位于当前仓库 raw/ 下', 'unsafe-raw-path');
  const parts = path.relative(rawRoot, rawBundle).split(path.sep);
  if (parts.length !== 2) throw new CliError('raw bundle 必须是平台目录的直接子目录', 'invalid-raw-path');
  const platform = PLATFORM_BY_RAW_DIRECTORY.get(parts[0]);
  if (!platform) throw new CliError(`不支持的 raw 平台目录: ${parts[0]}`, 'unsupported-raw-platform');
  if (!await plainDirectory(rawBundle) || !await regularFile(path.join(rawBundle, 'manifest.json'))) {
    throw new CliError('raw bundle 或 manifest.json 不存在/不是普通文件', 'raw-bundle-invalid');
  }
  const spec = PLATFORMS[platform];
  return {
    ok: true,
    action: 'verify-plan',
    platform,
    platform_label: spec.label,
    raw_bundle: rawBundle,
    command: backendCommand(repo, spec.verifyScript, 'verify', '--raw', rawBundle),
  };
}

async function runCommand(argv, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let size = 0;
    const collect = (bucket, chunk) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        child.kill('SIGTERM');
        reject(new CliError('平台适配器输出超过安全上限', 'backend-output-too-large'));
        return;
      }
      bucket.push(chunk);
    };
    child.stdout.on('data', (chunk) => collect(stdout, chunk));
    child.stderr.on('data', (chunk) => collect(stderr, chunk));
    child.on('error', (error) => reject(new CliError(error.message, 'backend-start-failed')));
    child.on('close', (status, signal) => resolve({
      status,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

function parseBackendJson(execution, options = {}) {
  const source = execution.stdout.trim() || execution.stderr.trim();
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new CliError('平台适配器没有返回有效 JSON', 'backend-invalid-json', {
      status: execution.status,
      stderr: execution.stderr.trim().slice(0, 2000),
    });
  }
  if (!options.allowFailure && (execution.status !== 0 || value?.ok === false)) {
    throw new CliError(value?.error || `平台适配器退出码 ${execution.status}`, 'backend-failed', value);
  }
  return value;
}

async function executePlan(plan, repo) {
  const execution = await runCommand(plan.command, { cwd: repo });
  const backend = parseBackendJson(execution);
  return {
    ok: true,
    action: plan.action === 'capture-plan' ? 'captured' : 'verified',
    platform: plan.platform,
    platform_label: plan.platform_label,
    canonical_url: plan.canonical_url,
    raw_bundle: plan.raw_bundle || backend.raw_bundle,
    backend,
  };
}

async function doctor(repo) {
  const adapters = {};
  for (const [platform, spec] of Object.entries(PLATFORMS)) {
    const files = [...new Set([spec.script, spec.verifyScript, spec.parserScript])];
    const checks = await Promise.all(files.map(async (relative) => ({ relative, ok: await regularFile(path.join(repo, relative)) })));
    let importable = false;
    let error = null;
    try {
      const module = await importAdapter(repo, platform);
      importable = typeof module[spec.parserExport] === 'function';
    } catch (cause) {
      error = cause.message;
    }
    adapters[platform] = { ok: checks.every((item) => item.ok) && importable, files: checks, parser_export: spec.parserExport, importable, error };
  }
  return {
    ok: Object.values(adapters).every((item) => item.ok),
    action: 'doctor',
    version: VERSION,
    repo_root: repo,
    node: { executable: process.execPath, version: process.version },
    adapters,
    supported_platforms: Object.keys(PLATFORMS),
  };
}

function help() {
  return `my-wiki-link ${VERSION}\n\n用法:\n  my-wiki-link doctor [--repo PATH] [--json]\n  my-wiki-link classify URL [--repo PATH] [--json]\n  my-wiki-link capture URL [--dry-run] [--repo PATH] [--json]\n  my-wiki-link verify RAW_BUNDLE [--repo PATH] [--json]\n  my-wiki-link queue scan [--repo PATH] [--json]\n\n仓库发现顺序：--repo、MY_WIKI_ROOT、当前目录向上、$HOME/my-wiki。\ncapture 只完成平台采集、确定性校验和 raw 固化；它不等于完整 Wiki“炼化”。`;
}

function parseCliArgs(argv) {
  const options = { json: false, dryRun: false, help: false, repo: null };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--json') options.json = true;
    else if (item === '--dry-run') options.dryRun = true;
    else if (item === '--help' || item === '-h') options.help = true;
    else if (item === '--repo') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new CliError('--repo 缺少路径', 'invalid-arguments');
      options.repo = value;
    } else if (item.startsWith('--')) throw new CliError(`未知参数: ${item}`, 'invalid-arguments');
    else positional.push(item);
  }
  return { options, positional };
}

function human(value) {
  if (typeof value === 'string') return value;
  if (value.action === 'doctor') {
    const rows = Object.entries(value.adapters).map(([name, item]) => `  ${item.ok ? '✓' : '✗'} ${name}`).join('\n');
    return `my-wiki-link ${value.version}\n仓库: ${value.repo_root}\n适配器:\n${rows}`;
  }
  if (value.action === 'capture-plan') return `${value.platform_label}\n${value.canonical_url}\n只读计划: ${value.command.join(' ')}`;
  if (value.supported) return `${value.platform_label}\n${value.canonical_url}\n范围: ${value.capture_scope}`;
  return JSON.stringify(value, null, 2);
}

async function main(argv = process.argv.slice(2), io = {}) {
  const writeOut = io.stdout || ((value) => process.stdout.write(value));
  const writeErr = io.stderr || ((value) => process.stderr.write(value));
  let parsed;
  try {
    parsed = parseCliArgs(argv);
    const [command, ...rest] = parsed.positional;
    if (parsed.options.help || !command || command === 'help') {
      const value = help();
      writeOut(parsed.options.json ? `${JSON.stringify({ ok: true, help: value }, null, 2)}\n` : `${value}\n`);
      return 0;
    }
    if (command === 'version') {
      writeOut(parsed.options.json ? `${JSON.stringify({ ok: true, version: VERSION })}\n` : `${VERSION}\n`);
      return 0;
    }
    const repo = await discoverRepo(parsed.options.repo, io);
    let result;
    if (command === 'doctor') {
      if (rest.length) throw new CliError('doctor 不接受位置参数', 'invalid-arguments');
      result = await doctor(repo);
    } else if (command === 'classify') {
      if (rest.length !== 1) throw new CliError('用法: my-wiki-link classify URL', 'invalid-arguments');
      result = await classifyUrl(rest[0], repo);
    } else if (command === 'capture') {
      if (rest.length !== 1) throw new CliError('用法: my-wiki-link capture URL [--dry-run]', 'invalid-arguments');
      const plan = await planCapture(rest[0], repo);
      result = parsed.options.dryRun ? plan : await executePlan({ ...plan, dry_run: false }, repo);
    } else if (command === 'verify') {
      if (rest.length !== 1) throw new CliError('用法: my-wiki-link verify RAW_BUNDLE', 'invalid-arguments');
      if (parsed.options.dryRun) throw new CliError('verify 不支持 --dry-run', 'invalid-arguments');
      result = await executePlan(await planVerify(rest[0], repo), repo);
    } else if (command === 'queue') {
      if (rest.length !== 1 || rest[0] !== 'scan') throw new CliError('只支持只读命令: my-wiki-link queue scan', 'invalid-arguments');
      const queueScript = path.join(repo, '.agents/skills/article-ingest/scripts/article_compile_queue.mjs');
      const backend = parseBackendJson(
        await runCommand([process.execPath, queueScript, 'scan', '--repo', repo], { cwd: repo }),
        { allowFailure: true },
      );
      result = {
        ok: backend.ok !== false,
        action: 'queue-scan',
        backend,
      };
    } else {
      throw new CliError(`未知命令: ${command}`, 'unknown-command');
    }
    writeOut(parsed.options.json ? `${JSON.stringify(result, null, 2)}\n` : `${human(result)}\n`);
    return result.ok === false ? 2 : 0;
  } catch (error) {
    const payload = {
      ok: false,
      error: error.message || String(error),
      code: error.code || 'unexpected-error',
      ...(error.details === undefined ? {} : { details: error.details }),
    };
    const json = parsed?.options?.json || argv.includes('--json');
    writeErr(json ? `${JSON.stringify(payload, null, 2)}\n` : `错误: ${payload.error}\n`);
    return 1;
  }
}

const requestedEntrypoint = process.argv[1] ? path.resolve(process.argv[1]) : null;
const resolvedEntrypoint = requestedEntrypoint
  ? await fs.realpath(requestedEntrypoint).catch(() => requestedEntrypoint)
  : null;
const invokedDirectly = resolvedEntrypoint
  && import.meta.url === pathToFileURL(resolvedEntrypoint).href;
if (invokedDirectly) process.exitCode = await main();

export {
  CliError,
  PLATFORMS,
  VERSION,
  classifyUrl,
  discoverRepo,
  doctor,
  main,
  parseCliArgs,
  planCapture,
  planVerify,
};
