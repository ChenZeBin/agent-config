import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function run(file, args, options = {}, status = 0) {
  const r = spawnSync(file, args, { encoding: 'utf8', timeout: 120000, env: { ...process.env, NODE_TEST_CONTEXT: undefined }, ...options });
  assert.equal(r.status, status, `${file} ${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
  return status === 0 ? r.stdout : r.stderr;
}
test('session byte preservation and resolver safety regressions', () => {
  const out = run(process.execPath, ['--test', path.join(pkg, 'scripts/session_ingest.test.mjs'), path.join(pkg, 'scripts/codex_session_resolve.test.mjs')], { cwd: os.tmpdir() });
  assert.match(out, /# fail 0/);
  process.stdout.write(out);
});
test('installed detached session CLI archives exact files and synthetic UUID sessions without Wiki access', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'session-archive-detached-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const copy = path.join(root, 'package');
  await fs.cp(pkg, copy, { recursive: true });
  const bin = path.join(root, 'bin');
  run(process.execPath, [path.join(copy, 'scripts/install.mjs'), '--bin-dir', bin], { cwd: root });
  const env = { ...process.env, TMPDIR: root, NODE_TEST_CONTEXT: undefined, NODE_NO_WARNINGS: '1', NODE_OPTIONS: `--permission --allow-fs-read=${root} --allow-fs-write=${root} --allow-child-process`, ARCHIVE_ROOT: path.join(root, 'data'), MY_WIKI_ROOT: '/unavailable/retired-project' };
  const cli = (args, status = 0) => JSON.parse(run(path.join(bin, 'session-archive'), args, { cwd: root, env }, status));
  assert.equal(cli(['doctor']).requires_wiki, false);
  const input = path.join(root, 'selected.jsonl');
  const bytes = Buffer.from('{"role":"user","text":"synthetic"}\r\n');
  await fs.writeFile(input, bytes);
  const args = ['ingest', '--input', input, '--source-app', 'codex', '--title', '合成测试', '--occurred-at', '2026-01-01'];
  const first = cli(args);
  assert.deepEqual(await fs.readFile(path.join(first.raw_bundle, 'session.jsonl')), bytes);
  assert.equal(cli(args).state, 'duplicate-noop');
  assert.equal(cli(['verify', '--bundle', first.raw_bundle]).state, 'verified');
  await fs.appendFile(path.join(first.raw_bundle, 'session.jsonl'), 'tamper');
  assert.equal(cli(['verify', '--bundle', first.raw_bundle], 1).ok, false);
  const home = path.join(root, 'codex-fixture');
  for (const dir of ['sessions', 'thread-writer-locks']) await fs.mkdir(path.join(home, dir), { recursive: true });
  const id = '11111111-2222-4333-8444-555555555555';
  const file = path.join(home, 'sessions', `rollout-${id}.jsonl`);
  await fs.writeFile(file, bytes);
  run('sqlite3', [path.join(home, 'state_5.sqlite'), `CREATE TABLE threads (id TEXT, rollout_path TEXT); INSERT INTO threads VALUES ('${id}', '${file.replaceAll("'", "''")}');`]);
  assert.equal(cli(['resolve', '--thread-id', id, '--codex-home', home]).rollout_path, file);
  const threaded = cli(['ingest', '--thread-id', id, '--codex-home', home, '--title', '选定UUID', '--occurred-at', '2026-01-01']);
  assert.deepEqual(await fs.readFile(path.join(threaded.raw_bundle, 'session.jsonl')), bytes);
  await fs.writeFile(path.join(home, 'thread-writer-locks', `${id}.lock`), 'active');
  assert.equal(cli(['ingest', '--thread-id', id, '--codex-home', home, '--title', '锁测试', '--occurred-at', '2026-01-01'], 1).ok, false);
  assert.equal(cli(['resolve', '--thread-id', 'recent', '--codex-home', home], 1).ok, false);
  for (const item of ['AGENTS.md', 'wiki', '.git']) await assert.rejects(fs.stat(path.join(env.ARCHIVE_ROOT, item)), { code: 'ENOENT' });
});
