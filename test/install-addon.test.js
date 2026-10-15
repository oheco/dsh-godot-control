import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm, realpath, rename, symlink } from 'node:fs/promises';
import path from 'node:path';
import { installAddon } from '../scripts/install-addon.mjs';

test('repository sync supports spaces and detects divergent project copies', async () => {
  const parent = await realpath(process.env.TMPDIR);
  const work = await mkdtemp(path.join(parent, 'dsh addon sync '));
  try {
    await writeFile(path.join(work, 'project.godot'), 'config_version=5\n');
    const installed = await installAddon(work);
    assert.ok(installed.files >= 159);
    assert.equal((await installAddon(work, { check: true })).sha256, installed.sha256);
    const metadata = JSON.parse(await readFile(path.join(work, '.godot/dsh-godot-control/addon-source.json'), 'utf8'));
    assert.equal(metadata.sha256, installed.sha256);
    await writeFile(path.join(work, 'addons/dsh_godot/plugin.gd.uid'), 'uid://generated-by-godot\n');
    await installAddon(work, { check: true });
    await writeFile(path.join(work, 'addons/dsh_godot/plugin.gd'), 'local edit');
    await assert.rejects(installAddon(work, { check: true }), /differs from repository/);
    await installAddon(work);
    await installAddon(work, { check: true });
    const victim = path.join(work, 'outside.txt');
    await writeFile(victim, 'preserve this file');
    const metadataFile = path.join(work, '.godot/dsh-godot-control/addon-source.json');
    await rename(metadataFile, metadataFile + '.original');
    await symlink(victim, metadataFile);
    await assert.rejects(installAddon(work), /nonregular metadata file/);
    assert.equal(await readFile(victim, 'utf8'), 'preserve this file');
    await rename(metadataFile, metadataFile + '.symlink');
    await rename(metadataFile + '.original', metadataFile);
    const pairing = path.join(work, '.godot/dsh-godot-control/connection.cfg');
    await symlink(victim, pairing);
    const configHome = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = path.join(work, 'isolated DSH config');
      await assert.rejects(installAddon(work, { pair: true }), /nonregular metadata file/);
    } finally {
      if (configHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = configHome;
    }
    assert.equal(await readFile(victim, 'utf8'), 'preserve this file');
    await writeFile(path.join(work, 'addons/dsh_godot/unknown.gd'), 'unexpected local file');
    await assert.rejects(installAddon(work), /Unexpected files/);
    const empty = path.join(work, 'not a project'); await mkdir(empty);
    await assert.rejects(installAddon(empty), { code: 'ENOENT' });
  } finally {
    assert.equal(path.dirname(await realpath(work)), parent);
    assert.ok(path.basename(work).startsWith('dsh addon sync '));
    await rm(work, { recursive: true });
  }
});

test('both generated debugger bridge halves receive the sent namespace', async () => {
  for (const relative of ['debugger/mcp_debugger_plugin.gd', 'runtime/game_helper.gd']) {
    const content = await readFile(new URL('../godot/addons/dsh_godot/' + relative, import.meta.url), 'utf8');
    assert.match(content, /const CAPTURE_PREFIX := "dsh_godot"/);
    assert.doesNotMatch(content, /const CAPTURE_PREFIX := "mcp"/);
  }
});
