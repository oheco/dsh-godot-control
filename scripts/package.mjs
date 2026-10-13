import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { zipSync, unzipSync } from '../tpr/fflate/esm/index.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (!process.env.XDG_CACHE_HOME) throw new Error('XDG_CACHE_HOME is required for release output.');
const directory = path.resolve(process.env.XDG_CACHE_HOME, 'dsh-godot-control', 'releases', manifest.version);
await mkdir(directory, { recursive: true });
const archiveRoot = `dsh-godot-control-${manifest.version}`, entries = {}, inventory = [];
const digest = data => createHash('sha256').update(data).digest('hex');
async function add(relative) {
  const absolute = path.join(root, relative), { lstat } = await import('node:fs/promises'), info = await lstat(absolute);
  assert.ok(!info.isSymbolicLink(), `Release must not contain symlinks: ${relative}`);
  if (info.isDirectory()) { for (const entry of (await readdir(absolute)).sort()) { if (['.git', '.godot', '__pycache__', 'node_modules', '.DS_Store'].includes(entry)) continue; await add(path.join(relative, entry)); } }
  else if (info.isFile()) { const data = await readFile(absolute), name = relative.split(path.sep).join('/'); entries[`${archiveRoot}/${name}`] = [new Uint8Array(data), { mtime: new Date('2026-01-01T00:00:00Z'), os: 3, attrs: 0o100644 << 16 }]; inventory.push({ path: name, sha256: digest(data), size: data.length }); }
}
for (const name of ['package.json', ...manifest.files].sort()) await add(name);
const record = Buffer.from(JSON.stringify({ name: manifest.name, version: manifest.version, files: inventory.sort((a, b) => a.path.localeCompare(b.path, 'en')) }, null, 2) + '\n');
entries[`${archiveRoot}/SOURCE-MANIFEST.json`] = [new Uint8Array(record), { mtime: new Date('2026-01-01T00:00:00Z'), os: 3, attrs: 0o100644 << 16 }];
const zipped = zipSync(entries, { level: 8 }), unpacked = unzipSync(zipped);
for (const file of inventory) assert.equal(digest(unpacked[`${archiveRoot}/${file.path}`]), file.sha256, `ZIP roundtrip mismatch: ${file.path}`);
assert.equal(Object.keys(unpacked).length, inventory.length + 1);
const name = `${archiveRoot}-ohos-arm64.zip`, filename = path.join(directory, name), hash = digest(zipped);
await writeFile(filename, zipped); await writeFile(path.join(directory, 'SHA256SUMS'), `${hash}  ${name}\n`);
const result = { version: manifest.version, filename, sha256: hash, size: zipped.length, file_count: inventory.length + 1 };
await writeFile(path.join(directory, 'artifact.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
