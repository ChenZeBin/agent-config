import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();
const configRoot = path.resolve(import.meta.dirname, '../../../..');
const skillRoot = path.resolve(import.meta.dirname, '..');
const cli = path.join(home, '.local', 'bin', 'my-wiki-link');
const installedSkill = path.join(home, '.agents', 'skills', 'my-wiki-link');
const evalResult = path.join(home, '.local', 'state', 'my-wiki-link-skill-eval', 'iteration-1', 'result.json');
const extensionId = 'banfcmclfmmlbkhionmemhibbjedhikm';

function run(args, cwd = os.tmpdir(), allowedStatuses = [0]) {
  const result = spawnSync(cli, args, { cwd, encoding: 'utf8', timeout: 120_000 });
  assert.ok(allowedStatuses.includes(result.status), `${args.join(' ')} failed:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

assert.ok(fs.existsSync(cli), 'global CLI entrypoint is missing');
const cliStat = await fsp.lstat(cli);
assert.ok(cliStat.isSymbolicLink() || cliStat.isFile(), 'CLI entrypoint must be a file or symlink');
const sourceReal = await fsp.realpath(cli);
assert.equal(sourceReal, path.join(skillRoot, 'scripts', 'my-wiki-link.mjs'));

const doctor = run(['doctor', '--json']);
assert.equal(doctor.ok, true);
assert.equal(doctor.repo_root, path.join(home, 'my-wiki'));
assert.ok(Object.values(doctor.adapters).every((item) => item.ok));

const classified = run(['classify', 'https://youtu.be/dQw4w9WgXcQ?si=fixture', '--json']);
assert.equal(classified.platform, 'youtube');
assert.equal(classified.canonical_url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');

const planned = run(['capture', 'https://x.com/Alice/status/1234567890123456789', '--dry-run', '--json']);
assert.equal(planned.action, 'capture-plan');
assert.equal(planned.full_wiki_compile, false);

const wechatRaw = path.join(home, 'my-wiki', 'raw', 'wechat');
const rawEntry = (await fsp.readdir(wechatRaw, { withFileTypes: true }))
  .filter((item) => item.isDirectory() && !item.isSymbolicLink())
  .sort((a, b) => a.name.localeCompare(b.name))[0];
assert.ok(rawEntry, 'expected a WeChat raw bundle for read-only E2E verification');
const verified = run(['verify', path.join(wechatRaw, rawEntry.name), '--json']);
assert.equal(verified.action, 'verified');
assert.equal(verified.backend.ok, true);

const queue = run(['queue', 'scan', '--json'], os.tmpdir(), [0, 2]);
assert.equal(queue.action, 'queue-scan');
assert.ok(Array.isArray(queue.backend.bundles));
assert.ok(Array.isArray(queue.backend.integrity_failures));

assert.ok(fs.existsSync(installedSkill), 'managed global Skill link is missing');
assert.equal(await fsp.realpath(installedSkill), skillRoot);
assert.equal(await fsp.realpath(path.join(home, '.codex', 'AGENTS.md')), path.join(configRoot, 'profile', 'AGENTS.md'));

const result = JSON.parse(await fsp.readFile(evalResult, 'utf8'));
const serialized = JSON.stringify(result);
assert.match(serialized, /PASS|passed|success/i, 'skill-up result does not contain a passing decision');
assert.doesNotMatch(serialized, /"status"\s*:\s*"FAIL"/i, 'skill-up result contains a failed case');

const chromeRoot = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
const profiles = (await fsp.readdir(chromeRoot, { withFileTypes: true }))
  .filter((item) => item.isDirectory() && !item.isSymbolicLink())
  .map((item) => path.join(chromeRoot, item.name, 'Extensions', extensionId));
let extensionManifest = null;
for (const base of profiles) {
  const versions = await fsp.readdir(base, { withFileTypes: true }).catch(() => []);
  for (const version of versions.filter((item) => item.isDirectory() && !item.isSymbolicLink())) {
    const manifestPath = path.join(base, version.name, 'manifest.json');
    if (fs.existsSync(manifestPath)) extensionManifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  }
}
assert.ok(extensionManifest, `Chrome extension ${extensionId} is not installed`);
assert.equal(typeof extensionManifest.version, 'string');
assert.match(String(extensionManifest.name), /MD|message/i);

process.stdout.write(`${JSON.stringify({
  ok: true,
  cli,
  skill: installedSkill,
  extension_id: extensionId,
  extension_version: extensionManifest.version,
  skill_eval: evalResult,
}, null, 2)}\n`);
