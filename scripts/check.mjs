import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_VERSION } from '../protocol.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
assert.equal(SERVER_VERSION, manifest.version, 'Server status version must match the package.');
assert.equal(manifest.name, '@oheco/dsh-godot-control'); assert.equal(manifest.type, 'module'); assert.ok(manifest.dsh.bundle);
for (const name of manifest.files) assert.ok((await stat(path.join(root, name))).isFile() || (await stat(path.join(root, name))).isDirectory(), `Missing shipped input: ${name}`);
const files = ['main.js', 'server.js', 'protocol.js', 'operations.js', 'client.mjs'];
for (const folder of ['scripts', 'test']) for (const name of await readdir(path.join(root, folder))) if (/\.(?:js|mjs)$/.test(name)) files.push(path.join(folder, name));
for (const name of files) { const result = spawnSync(process.execPath, ['--check', path.join(root, name)], { encoding: 'utf8' }); assert.equal(result.status, 0, `${name}: ${result.stderr}`); }
const commands = JSON.parse(await readFile(path.join(root, 'commands.json'), 'utf8'));
assert.equal(commands.length, 161); assert.equal(new Set(commands.map(command => command.command)).size, commands.length);
for (const name of ['configure_client', 'remove_client', 'check_client_status']) assert.ok(!commands.some(command => command.command === name));
const plugin = await readFile(path.join(root, 'godot/addons/dsh_godot/plugin.gd'), 'utf8');
assert.ok(!plugin.includes('@REGISTRATION@')); assert.ok(plugin.includes('EditorPlugin')); assert.ok(!plugin.includes('ServerLifecycle.new'));
const validator = await readFile(path.join(root, 'godot/addons/dsh_godot/utils/path_validator.gd'), 'utf8');
assert.ok(validator.includes('segments[1].to_lower() == "dsh_godot"'), 'Derived addon must protect its own loaded directory.');
assert.equal(await readFile(path.join(root, 'godot/resource_reimport.gd'), 'utf8'), await readFile(path.join(root, 'godot/addons/dsh_godot/utils/resource_reimport.gd'), 'utf8'), 'Rebuild generated addon after changing resource import source.');
async function checkAddonBranding(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await checkAddonBranding(filename);
    else if (entry.name.endsWith('.gd')) assert.doesNotMatch(await readFile(filename, 'utf8'), /\bMCP\s*(?:\||:|debugger:)|registered mcp capture/, `Old plugin log or undo label: ${filename}`);
  }
}
await checkAddonBranding(path.join(root, 'godot/addons/dsh_godot'));
for (const dependency of Object.values(JSON.parse(await readFile(path.join(root, 'dependencies.json'), 'utf8')))) { assert.match(dependency.sha256, /^[0-9a-f]{64}$/); assert.equal(dependency.license, 'MIT'); await stat(path.join(root, dependency.directory, 'LICENSE')); }
console.log(`Checked ${files.length} JavaScript modules, package inputs, ${commands.length} commands, independent addon namespace and dependency records.`);
