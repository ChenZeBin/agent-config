import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const sourceSkills = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const installedSkills = path.join(os.homedir(), '.config/agent-config/profile/skills');
const bin = path.join(os.homedir(), '.local/bin');
async function files(root, dir = '') {
  const result = [];
  for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false);
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await files(root, relative));
    else { assert.equal(entry.isFile(), true); result.push(relative); }
  }
  return result.sort();
}
async function snapshot(bundle) {
  const result = [];
  for (const file of await files(bundle)) {
    const bytes = await fs.readFile(path.join(bundle, file));
    result.push({path:file, sha256:createHash('sha256').update(bytes).digest('hex'), encoding:'base64', bytes:bytes.toString('base64')});
  }
  return result;
}
for (const name of ['link-archive', 'session-archive']) {
  const source = path.join(sourceSkills, name), installed = path.join(installedSkills, name);
  assert.equal(await fs.realpath(path.join(os.homedir(), '.agents/skills', name)), installed);
  const inventory = await files(source);
  assert.deepEqual(await files(installed), inventory);
  for (const file of inventory) assert.deepEqual(await fs.readFile(path.join(installed, file)), await fs.readFile(path.join(source, file)), `installed file differs: ${name}/${file}`);
}
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'global-archive-acceptance-')));
const blocked = path.join(os.homedir(), 'my-wiki');
const profile = `(version 1) (allow default) (deny file-read* file-write* (subpath ${JSON.stringify(blocked)}))`;
function execute(command, args, status = 0) {
  const r = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, command, ...args], { cwd: root, encoding: 'utf8', timeout: 120000, env: {...process.env, NODE_TEST_CONTEXT: undefined, NODE_OPTIONS: '', ARCHIVE_ROOT: path.join(root, 'archive'), MY_WIKI_ROOT: blocked} });
  assert.equal(r.status, status, `${command}: ${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout || r.stderr);
}
try {
  const probe = execute(process.execPath, ['-e', `try {require('node:fs').readFileSync(${JSON.stringify(path.join(blocked, 'README.md'))}); process.exit(1);} catch(e) {if(!['EPERM','EACCES','ENOENT'].includes(e.code))process.exit(2);console.log(JSON.stringify({denied:true,code:e.code}));}`]);
  assert.equal(probe.denied, true, 'the old project must really be unreadable');
  const cli = (name, args, status = 0) => execute(path.join(bin, name), args, status);
  assert.equal(cli('link-archive', ['doctor', '--json']).ok, true);
  assert.equal(cli('session-archive', ['doctor']).requires_wiki, false);
  assert.equal(cli('my-wiki-link', ['classify', 'https://youtu.be/dQw4w9WgXcQ', '--json']).platform, 'youtube');
  // This check uses a real public network response. No mock fetch or prior project data.
  const captured = cli('link-archive', ['capture', 'https://x.com/jack/status/20', '--json']);
  assert.equal(captured.ok, true);
  assert.equal(cli('link-archive', ['verify', captured.raw_bundle, '--json']).backend.ok, true);
  assert.equal(cli('link-archive', ['verify', path.relative(root, captured.raw_bundle), '--json']).backend.ok, true);
  // Bind the exact network evidence to the gate's stdout, not just a digest.
  // An optional external directory also retains the readable original bundle.
  const capturedFiles = await snapshot(captured.raw_bundle);
  let retainedBundle = null;
  if (process.argv[2]) {
    const destination = path.resolve(process.argv[2]);
    await fs.mkdir(destination, {recursive:true, mode:0o700});
    const run = await fs.mkdtemp(path.join(destination, 'capture-'));
    retainedBundle = path.join(run, path.basename(captured.raw_bundle));
    await fs.cp(captured.raw_bundle, retainedBundle, {recursive:true, errorOnExist:true, force:false});
  }
  const duplicate = cli('my-wiki-link', ['capture', 'https://x.com/jack/status/20', '--json']);
  assert.equal(cli('link-archive', ['verify', duplicate.raw_bundle, '--json']).backend.ok, true);
  const firstManifest = JSON.parse(await fs.readFile(path.join(captured.raw_bundle, 'manifest.json'), 'utf8'));
  const repeatManifest = JSON.parse(await fs.readFile(path.join(duplicate.raw_bundle, 'manifest.json'), 'utf8'));
  const contentChanged = firstManifest.content_checksum !== repeatManifest.content_checksum;
  // Engagement counts may change between live requests. Deduplication is exact
  // content reuse, so a changed response must produce a distinct immutable bundle.
  assert.equal(duplicate.backend.action, contentChanged ? 'promoted' : 'duplicate-noop');
  assert.equal(duplicate.raw_bundle === captured.raw_bundle, !contentChanged);
  assert.deepEqual(await snapshot(captured.raw_bundle), capturedFiles);
  const repeatFiles = await snapshot(duplicate.raw_bundle);
  const input = path.join(root, 'explicit-fixture.jsonl');
  const bytes = Buffer.from('{"role":"user","text":"Synthetic global install acceptance fixture"}\n');
  await fs.writeFile(input, bytes);
  const sessionArgs = ['ingest', '--input', input, '--source-app', 'other', '--title', '全局安装合成验收', '--occurred-at', '2026-01-01'];
  const session = cli('session-archive', sessionArgs);
  assert.deepEqual(await fs.readFile(path.join(session.raw_bundle, 'session.jsonl')), bytes);
  assert.equal(cli('session-archive', ['verify', '--bundle', session.raw_bundle]).state, 'verified');
  assert.equal(cli('session-archive', sessionArgs).state, 'duplicate-noop');
  await fs.appendFile(path.join(session.raw_bundle, 'session.jsonl'), 'tamper');
  assert.equal(cli('session-archive', ['verify', '--bundle', session.raw_bundle], 1).ok, false);
  console.log(JSON.stringify({ok:true, installed_commands:['link-archive','session-archive','my-wiki-link'], original_project_access:probe.code === 'ENOENT' ? 'absent' : 'denied-by-macos-sandbox', source_equals_installed:true, live_capture:{url:'https://x.com/jack/status/20', platform:captured.platform, backend:captured.backend.backend, warnings:captured.backend.warnings, checksum:captured.backend.bundle_checksum, retained_bundle:retainedBundle, files:capturedFiles}, repeat_capture:{action:duplicate.backend.action, content_changed:contentChanged, checksum:duplicate.backend.bundle_checksum, files:repeatFiles}, session:'synthetic bytes preserved; duplicate reused; tampering rejected'},null,2));
} finally { await fs.rm(root, { recursive:true, force:true }); }
