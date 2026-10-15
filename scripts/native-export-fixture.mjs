import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function verifyHeadlessExport({ work, source, run, report }) {
  const project = path.join(work, 'headless export with spaces');
  await mkdir(project);
  await cp(path.join(source, 'godot/addons'), path.join(project, 'addons'), { recursive: true });
  const config = '[application]\nconfig/name="Headless export cleanup"\nrun/main_scene="res://main.tscn"\n[autoload]\n_dsh_godot_game_helper="*res://addons/dsh_godot/runtime/game_helper.gd"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n[editor_plugins]\nenabled=PackedStringArray("res://addons/dsh_godot/plugin.cfg")\n';
  await writeFile(path.join(project, 'project.godot'), config);
  await writeFile(path.join(project, 'main.gd'), 'extends Node\nfunc _ready() -> void:\n\tprint("HEADLESS_EXPORT_GAME_READY")\n');
  await writeFile(path.join(project, 'main.tscn'), '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://main.gd" id="1"]\n[node name="Main" type="Node"]\nscript = ExtResource("1")\n');
  await writeFile(path.join(project, 'export_presets.cfg'), '[preset.0]\nname="Headless cleanup"\nplatform="OpenHarmony"\nrunnable=true\nexport_filter="all_resources"\nexclude_filter="addons/dsh_godot/*"\nscript_export_mode=2\n[preset.0.options]\narchitectures/arm64=true\narchitectures/x86_64=false\n');
  const pack = path.join(project, 'game.pck');
  const output = await run(['--headless', '--path', project, '--export-pack', 'Headless cleanup', pack], 'headless-export.log', { DSH_GODOT_ALLOW_HEADLESS: '0' });
  assert.match(output, /export: stripping autoload\/_dsh_godot_game_helper/);
  assert.doesNotMatch(output, /DSH Godot \| plugin loaded/);
  assert.equal((await readFile(pack)).includes(Buffer.from('autoload/_dsh_godot_game_helper')), false);
  assert.equal(await readFile(path.join(project, 'project.godot'), 'utf8'), config);
  const runtime = await run(['--headless', '--main-pack', pack, '--quit-after', '2'], 'headless-export-runtime.log', { DSH_GODOT_ALLOW_HEADLESS: '0' });
  assert.match(runtime, /HEADLESS_EXPORT_GAME_READY/);
  assert.doesNotMatch(runtime, /ERROR:|autoload|dsh_godot/);
  report.headless_export = { bridgeDisabled: true, helperExcluded: true, sourceSettingsUnchanged: true, exportedPackStarts: true };
}
