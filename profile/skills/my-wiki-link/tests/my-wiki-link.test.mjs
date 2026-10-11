import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
test('legacy CLI delegates to independent classifier without a repository', () => {
  const cli = path.resolve(import.meta.dirname, '../scripts/my-wiki-link.mjs');
  const r = spawnSync(process.execPath, [cli, 'classify', 'https://youtu.be/dQw4w9WgXcQ', '--json'], { cwd: os.tmpdir(), encoding: 'utf8', env: {...process.env, NODE_TEST_CONTEXT: undefined, MY_WIKI_ROOT: '/unavailable/retired-project'} });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).platform, 'youtube');
});
