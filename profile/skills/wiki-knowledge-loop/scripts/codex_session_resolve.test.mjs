import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { resolveCodexSession } from './codex_session_resolve.mjs';

const execFileAsync = promisify(execFile);
const roots = [];
const ACTIVE_ID = '01a051ba-1561-7400-8305-aed737fb0617';
const ARCHIVED_ID = '01a051ba-1561-7400-8305-aed737fb0618';
const OTHER_ID = '01a051ba-1561-7400-8305-aed737fb0619';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-session-resolve-'));
  roots.push(root);
  await fs.mkdir(path.join(root, 'sessions'));
  await fs.mkdir(path.join(root, 'archived_sessions'));
  await fs.mkdir(path.join(root, 'thread-writer-locks'));
  const database = path.join(root, 'state_5.sqlite');
  await execFileAsync('sqlite3', [database, 'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL);']);
  return { root, database };
}
async function insert(database, id, rolloutPath) {
  await execFileAsync('sqlite3', [database, `INSERT INTO threads (id, rollout_path) VALUES ('${id}', '${rolloutPath.replace(/'/g, "''")}');`]);
}
async function rollout(root, directory, id, suffix = '') {
  const target = path.join(root, directory, `rollout-2026-08-30T10-00-00-${id}${suffix}.jsonl`);
  await fs.writeFile(target, 'this must not be read by resolver');
  return target;
}

test('解析普通 sessions rollout，只返回允许的元数据', async () => {
  const { root, database } = await fixture();
  const file = await rollout(root, 'sessions', ACTIVE_ID);
  await insert(database, ACTIVE_ID, file);
  const result = await resolveCodexSession({ threadId: ACTIVE_ID, codexHome: root });
  assert.deepEqual(result, { ok: true, thread_id: ACTIVE_ID, rollout_path: await fs.realpath(file), archived: false });
  assert.deepEqual(Object.keys(result).sort(), ['archived', 'ok', 'rollout_path', 'thread_id']);
});

test('解析 archived_sessions rollout', async () => {
  const { root, database } = await fixture();
  const file = await rollout(root, 'archived_sessions', ARCHIVED_ID);
  await insert(database, ARCHIVED_ID, file);
  const result = await resolveCodexSession({ threadId: ARCHIVED_ID, codexHome: root });
  assert.equal(result.archived, true);
  assert.equal(result.rollout_path, await fs.realpath(file));
});

test('缺失 thread、越界路径和 UUID 不匹配均 fail-closed', async () => {
  const { root, database } = await fixture();
  await assert.rejects(() => resolveCodexSession({ threadId: ACTIVE_ID, codexHome: root }), /未找到/);
  const outside = path.join(root, 'outside.jsonl');
  await fs.writeFile(outside, 'not a session');
  await insert(database, ACTIVE_ID, outside);
  await assert.rejects(() => resolveCodexSession({ threadId: ACTIVE_ID, codexHome: root }), /超出/);
  const mismatch = await rollout(root, 'sessions', OTHER_ID);
  await insert(database, ARCHIVED_ID, mismatch);
  await assert.rejects(() => resolveCodexSession({ threadId: ARCHIVED_ID, codexHome: root }), /文件名与 thread_id/);
});

test('活跃 writer lock 存在时拒绝解析', async () => {
  const { root, database } = await fixture();
  const file = await rollout(root, 'sessions', ACTIVE_ID);
  await insert(database, ACTIVE_ID, file);
  await fs.writeFile(path.join(root, 'thread-writer-locks', `${ACTIVE_ID}.lock`), 'locked');
  await assert.rejects(() => resolveCodexSession({ threadId: ACTIVE_ID, codexHome: root }), /正在写入/);
});

test.after(async () => { await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))); });
