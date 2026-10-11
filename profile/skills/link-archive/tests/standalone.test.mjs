import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function run(file, args, options = {}, status = 0) {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: 120000, env: { ...process.env, NODE_TEST_CONTEXT: undefined }, ...options });
  assert.equal(result.status, status, `${file} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
test('all five adapter regression suites run from the standalone package', async () => {
  const files = [];
  for (const dir of await fs.readdir(path.join(pkg, 'adapters'))) {
    for (const name of await fs.readdir(path.join(pkg, 'adapters', dir))) {
      if (name.endsWith('.test.mjs')) files.push(path.join(pkg, 'adapters', dir, name));
    }
  }
  assert.ok(files.length >= 9);
  const output = run(process.execPath, ['--test', ...files], { cwd: os.tmpdir() });
  assert.match(output, /# fail 0/);
  process.stdout.write(output);
});
test('detached installed CLI captures, deduplicates and verifies with filesystem access limited to its temporary package and data', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'link-archive-detached-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const copy = path.join(root, 'package');
  await fs.cp(pkg, copy, { recursive: true });
  const bin = path.join(root, 'bin');
  run(process.execPath, [path.join(copy, 'scripts/install.mjs'), '--bin-dir', bin], { cwd: root });
  const preload = path.join(root, 'mock-network.mjs');
  // A real CLI + real adapter process, with synthetic responses. No live services or
  // personal data. The Node permission model denies every file outside this root.
  await fs.writeFile(preload, `import fs from 'node:fs';
import assert from 'node:assert/strict';
assert.throws(() => fs.readFileSync(process.env.FORBIDDEN_FILE), { code: 'ERR_ACCESS_DENIED' });
globalThis.fetch = async (input) => {
 const url = String(input);
 if (url.includes('syndication.twimg.com')) return new Response(JSON.stringify({id_str:'1234567890123456789',text:'Synthetic archive fixture',user:{screen_name:'Alice',name:'Alice'},photos:[]}), {headers:{'content-type':'application/json'}});
 if (url.startsWith('https://mp.weixin.qq.com/s/fixture')) return new Response("<html><script>window.cgiDataNew={title:'Fixture',nick_name:'Fixture author',content_noencode:'<p>Archive text</p>',create_time:'2026-01-01 12:00',link:'https://mp.weixin.qq.com/s/fixture'};</script></html>",{headers:{'content-type':'text/html'}});
 throw new Error('Unexpected network request in fixture: '+url);
};
`);
  const env = { ...process.env, TMPDIR: root, NODE_TEST_CONTEXT: undefined, NODE_NO_WARNINGS: '1', NODE_OPTIONS: `--permission --allow-fs-read=${root} --allow-fs-write=${root} --allow-child-process --import=${preload}`, FORBIDDEN_FILE: path.join(pkg, 'SKILL.md'), MY_WIKI_ROOT: '/unavailable/retired-project', ARCHIVE_ROOT: path.join(root, 'default-data') };
  const cli = (args, status = 0, command = 'link-archive') => {
    const output = run(path.join(bin, command), args, { cwd: root, env }, status);
    return status === 0 ? JSON.parse(output) : output;
  };
  const doctor = cli(['doctor', '--json']);
  assert.equal(Object.values(doctor.adapters).filter(a => a.ok).length, 5);
  const urls = ['https://mp.weixin.qq.com/s/fixture', 'https://x.com/Alice/status/1234567890123456789', 'https://www.bilibili.com/video/BV1zUh56RE8k/', 'https://youtu.be/dQw4w9WgXcQ', 'https://weixin.qq.com/sph/AyN0KgKSs2'];
  for (const url of urls) {
    assert.equal(cli(['classify', url, '--json']).supported, true);
    assert.equal(cli(['capture', url, '--dry-run', '--json']).dry_run, true);
  }
  await assert.rejects(fs.stat(env.ARCHIVE_ROOT), { code: 'ENOENT' });
  for (const url of urls.slice(0, 2)) {
    const first = cli(['capture', url, '--json']);
    assert.equal(first.ok, true);
    assert.ok(first.raw_bundle.startsWith(env.ARCHIVE_ROOT));
    const manifest = path.join(first.raw_bundle, 'manifest.json');
    const bytes = await fs.readFile(manifest);
    const again = cli(['capture', url, '--json'], 0, 'my-wiki-link');
    assert.equal(again.raw_bundle, first.raw_bundle);
    assert.deepEqual(await fs.readFile(manifest), bytes);
    assert.equal(cli(['verify', first.raw_bundle, '--json']).backend.ok, true);
    assert.equal(cli(['verify', path.relative(root, first.raw_bundle), '--json']).backend.ok, true);
    await fs.appendFile(path.join(first.raw_bundle, 'article.md'), '\ntamper');
    cli(['verify', first.raw_bundle, '--json'], 1);
  }
  for (const item of ['AGENTS.md', 'wiki', '.agents', '.git']) await assert.rejects(fs.stat(path.join(env.ARCHIVE_ROOT, item)), { code: 'ENOENT' });
  cli(['classify', 'https://example.org/article', '--json'], 1);
  // Explicit output overrides the environment; dry-run must not initialize it.
  const custom = path.join(root, 'custom-data');
  const plan = cli(['capture', urls[1], '--output', custom, '--dry-run', '--json']);
  assert.ok(plan.command.includes(custom));
  await assert.rejects(fs.stat(custom), { code: 'ENOENT' });
  cli(['init', '--output', custom, '--json']);
  await fs.access(path.join(custom, '.archive-store.json'));
});
