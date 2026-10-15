import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, open, copyFile, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function files(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name), absolute = path.join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Addon trees must not contain symlinks: ${absolute}`);
    if (entry.isDirectory()) result.push(...await files(absolute, relative));
    else if (entry.isFile() && !entry.name.endsWith('.uid')) result.push(relative);
  }
  return result.sort();
}
async function confinedDirectory(directory) {
  await mkdir(directory, { recursive: true });
  assert.equal(await realpath(directory), directory, `Unexpected directory link: ${directory}`);
}
async function writeMetadata(filename, content) {
  try {
    const info = await lstat(filename);
    assert.ok(info.isFile() && !info.isSymbolicLink(), `Refusing a nonregular metadata file: ${filename}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o666);
  try { await handle.writeFile(content); } finally { await handle.close(); }
}
export async function installAddon(projectPath, { check = false, pair = false } = {}) {
  assert.ok(!(check && pair), '--check and --pair cannot be combined');
  const project = await realpath(path.resolve(projectPath));
  assert.ok((await lstat(path.join(project, 'project.godot'))).isFile(), 'Choose a Godot project root');
  const source = path.join(root, 'godot/addons/dsh_godot');
  const target = path.join(project, 'addons/dsh_godot');
  const names = await files(source), hashes = {};
  for (const name of names) hashes[name] = digest(await readFile(path.join(source, name)));
  let existing = [];
  try {
    assert.equal(await realpath(target), target, 'Refusing to update an addon symlink');
    existing = await files(target);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const extra = existing.filter(name => !names.includes(name));
  assert.deepEqual(extra, [], 'Unexpected files in installed addon; reconcile them in the repository before syncing');
  if (!check) {
    await confinedDirectory(path.join(project, 'addons'));
    await confinedDirectory(target);
    for (const name of names) {
      const destination = path.join(target, name);
      await confinedDirectory(path.dirname(destination));
      await copyFile(path.join(source, name), destination);
    }
  }
  for (const name of names) assert.equal(digest(await readFile(path.join(target, name))), hashes[name], `Installed addon differs from repository: ${name}`);
  const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
  const sourceHash = digest(Buffer.from(JSON.stringify(hashes)));
  if (!check) {
    const metadata = path.join(project, '.godot/dsh-godot-control');
    await confinedDirectory(path.join(project, '.godot'));
    await confinedDirectory(metadata);
    await writeMetadata(path.join(metadata, 'addon-source.json'), JSON.stringify({ version, sha256: sourceHash, files: hashes }, null, 2) + '\n');
    if (pair) {
      const { loadConnection } = await import('../server.js');
      const connection = await loadConnection();
      await writeMetadata(path.join(metadata, 'connection.cfg'), `[connection]\nport=${connection.port}\ntoken="${connection.token}"\n`);
    }
  }
  return { project, version, files: names.length, sha256: sourceHash, checked: check, paired: pair };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), check = args.includes('--check'), pair = args.includes('--pair');
  const index = args.indexOf('--project'), project = index >= 0 ? args[index + 1] : undefined;
  const allowed = new Set(['--project', '--check', '--pair', project]);
  assert.ok(project && args.every(value => allowed.has(value)), 'Usage: node scripts/install-addon.mjs --project <project-root> [--check | --pair]');
  console.log(JSON.stringify(await installAddon(project, { check, pair }), null, 2));
}
