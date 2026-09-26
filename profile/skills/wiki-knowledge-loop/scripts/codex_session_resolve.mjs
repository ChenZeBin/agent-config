#!/usr/bin/env node

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_GLOBAL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function fail(message) { throw new Error(message); }
function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}
async function normalDirectory(target, label) {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail(`${label}不是普通目录`);
  return fs.realpath(target);
}
async function normalFile(target, label) {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) fail(`${label}不是普通文件`);
  return stat;
}
function strictThreadId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail('thread_id 必须是完整的小写 UUID');
  return value;
}
function codexHome(value) {
  if (typeof value !== 'string' || !value) fail('CODEX_HOME 未设置');
  return path.resolve(value);
}
async function queryRolloutPath(database, threadId, sqlite3 = 'sqlite3') {
  // threadId is validated before interpolation; the query never selects transcript fields.
  const sql = `SELECT rollout_path FROM threads WHERE id = '${threadId}' LIMIT 2;`;
  let stdout;
  try {
    ({ stdout } = await execFileAsync(sqlite3, ['-readonly', '-batch', '-noheader', database, sql], {
      encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 5_000, windowsHide: true,
    }));
  } catch { fail('无法以只读模式查询 Codex threads 数据库'); }
  if (typeof stdout !== 'string' || !stdout) fail('未找到指定 thread_id');
  if (!stdout.endsWith('\n')) fail('threads 数据库返回的 rollout_path 无效');
  const rolloutPath = stdout.slice(0, -1);
  if (!rolloutPath || /[\r\n\0]/.test(rolloutPath)) fail('threads 数据库返回的 rollout_path 无效');
  return rolloutPath;
}
async function allowedRoot(home, name) {
  const candidate = path.join(home, name);
  const stat = await fs.lstat(candidate).catch(() => null);
  if (!stat) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${name}/ 不是普通目录`);
  return { name, path: await fs.realpath(candidate) };
}
function filenameMatchesThread(realPath, threadId) {
  const filename = path.basename(realPath);
  const ids = filename.match(UUID_GLOBAL) || [];
  return filename.endsWith('.jsonl') && ids.length === 1 && ids[0] === threadId;
}

export async function resolveCodexSession({ threadId, codexHome: suppliedHome, sqlite3 = 'sqlite3' } = {}) {
  const id = strictThreadId(threadId);
  const home = codexHome(suppliedHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'));
  await normalDirectory(home, 'CODEX_HOME');
  const database = path.join(home, 'state_5.sqlite');
  await normalFile(database, 'state_5.sqlite');
  const lock = path.join(home, 'thread-writer-locks', `${id}.lock`);
  if (await fs.lstat(lock).catch(() => null)) fail('thread 正在写入，拒绝读取不稳定会话');
  const storedPath = await queryRolloutPath(database, id, sqlite3);
  if (!path.isAbsolute(storedPath)) fail('rollout_path 必须是绝对路径');
  const original = path.resolve(storedPath);
  await normalFile(original, 'rollout_path');
  const realPath = await fs.realpath(original);
  const roots = (await Promise.all([allowedRoot(home, 'sessions'), allowedRoot(home, 'archived_sessions')])).filter(Boolean);
  const matchingRoot = roots.find((root) => isInside(root.path, realPath));
  if (!matchingRoot) fail('rollout_path 超出 sessions/ 或 archived_sessions/');
  if (!filenameMatchesThread(realPath, id)) fail('rollout_path 文件名与 thread_id 不一致');
  return { ok: true, thread_id: id, rollout_path: realPath, archived: matchingRoot.name === 'archived_sessions' };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) fail('参数无效');
    const key = item.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = argv[++index];
    if (!value || value.startsWith('--') || Object.hasOwn(options, key)) fail('参数无效');
    options[key] = value;
  }
  if (!options.threadId) fail('需要 --thread-id');
  return options;
}
async function main(argv) {
  const options = parseArgs(argv);
  const result = await resolveCodexSession({ threadId: options.threadId, codexHome: options.codexHome });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
const direct = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (direct) main(process.argv.slice(2)).catch(() => { process.stdout.write(`${JSON.stringify({ ok: false })}\n`); process.exitCode = 1; });
