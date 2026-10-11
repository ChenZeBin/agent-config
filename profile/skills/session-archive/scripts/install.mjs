#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'session-archive.mjs');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--bin-dir')) throw new Error('用法: install.mjs [--bin-dir PATH]');
const bin = path.resolve(args[1] || path.join(os.homedir(), '.local', 'bin'));
await fs.mkdir(bin, { recursive: true });
if (!(await fs.lstat(bin)).isDirectory() || (await fs.lstat(bin)).isSymbolicLink()) throw new Error('bin 必须是普通目录');
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
const text = `#!/bin/sh\n# managed-by: standalone-archive-tools\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`;
for (const name of ['session-archive']) {
  const target = path.join(bin, name);
  const st = await fs.lstat(target).catch(() => null);
  if (st && (!st.isFile() || st.isSymbolicLink() || !(await fs.readFile(target, 'utf8')).includes('# managed-by: standalone-archive-tools'))) throw new Error(`拒绝覆盖非本工具入口: ${target}`);
  await fs.writeFile(target, text, { mode: 0o755 });
  await fs.chmod(target, 0o755);
}
process.stdout.write(`${JSON.stringify({ ok: true, bin, commands: ['session-archive'] })}\n`);
