import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const MARKER = '.archive-store.json';
export function defaultRoot() {
  return path.resolve(process.env.ARCHIVE_ROOT || path.join(os.homedir(), 'codex-resource', 'archive'));
}
async function plainDirectory(target) {
  const st = await fs.lstat(target).catch(() => null);
  if (!st?.isDirectory() || st.isSymbolicLink()) throw new Error(`归档目录不存在或不是普通目录: ${target}`);
}
async function validMarker(root) {
  const file = path.join(root, MARKER);
  const st = await fs.lstat(file).catch(() => null);
  if (!st) return false;
  if (!st.isFile() || st.isSymbolicLink()) throw new Error('归档标记必须是普通文件');
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  if (value.kind !== 'agent-archive' || value.version !== 1) throw new Error('不支持的归档目录格式');
  return true;
}
export async function resolveArchiveRoot(value = defaultRoot()) {
  let current = path.resolve(value);
  await plainDirectory(current);
  while (true) {
    if (await validMarker(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error('找不到 .archive-store.json；先运行 init --output PATH');
    current = await fs.realpath(parent);
    await plainDirectory(current);
  }
}
export async function initArchiveRoot(value = defaultRoot()) {
  const root = path.resolve(value);
  // Reject a symlink at the selected root and never replace existing files.
  async function ensure(target) {
    const st = await fs.lstat(target).catch(() => null);
    if (st) return plainDirectory(target);
    const parent = path.dirname(target);
    if (parent === target) throw new Error('无效归档路径');
    await ensure(parent);
    await fs.mkdir(target, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    await plainDirectory(target);
  }
  await ensure(root);
  const file = path.join(root, MARKER);
  try { await fs.writeFile(file, '{"kind":"agent-archive","version":1}\n', { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  await validMarker(root);
  for (const dir of ['raw', 'staging']) {
    await fs.mkdir(path.join(root, dir), { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    await plainDirectory(path.join(root, dir));
  }
  return root;
}
