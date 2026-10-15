import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function setupPairingFixture(project) {
  await writeFile(path.join(project, 'pairing-probe.gd'), `@tool
extends Node

@export var pairing_checks: String:
	get:
		return JSON.stringify(_check())

func _write(file: String, port: int, secret: String) -> void:
	var config := ConfigFile.new()
	config.set_value("connection", "port", port)
	config.set_value("connection", "token", secret)
	config.save(file)

func _check() -> Dictionary:
	var plugin = load("res://addons/dsh_godot/plugin.gd").new()
	var project_file: String = plugin._pairing_file()
	var legacy_file: String = plugin._legacy_pairing_file()
	var result := {"project_path": project_file == "res://.godot/dsh-godot-control/connection.cfg"}
	# This probe may only mutate the native harness's isolated configuration.
	if not legacy_file.begins_with(OS.get_environment("GODOT_OHOS_DATA_DIR").trim_suffix("/") + "/"):
		plugin.free()
		return result
	var original := FileAccess.get_file_as_bytes(project_file)
	var had_legacy := FileAccess.file_exists(legacy_file)
	var legacy_original := FileAccess.get_file_as_bytes(legacy_file) if had_legacy else PackedByteArray()
	DirAccess.make_dir_recursive_absolute(legacy_file.get_base_dir())
	_write(legacy_file, 18501, "b".repeat(64))
	# Resolve and check exact paths before deleting test-owned files.
	var absolute := ProjectSettings.globalize_path(project_file)
	if absolute != ProjectSettings.globalize_path("res://").path_join(".godot/dsh-godot-control/connection.cfg"):
		plugin.free()
		return result
	DirAccess.remove_absolute(absolute)
	var loaded: Dictionary = plugin._load_pairing()
	result["legacy_fallback"] = int(loaded.get("port", 0)) == 18501
	_write(project_file, 18502, "c".repeat(64))
	FileAccess.set_unix_permissions(project_file, 0x1b6)
	loaded = plugin._load_pairing()
	result["project_overrides_legacy"] = int(loaded.get("port", 0)) == 18502
	_write(project_file, 0, "invalid")
	result["invalid_project_does_not_fallback"] = plugin._load_pairing().is_empty()
	var old_token := OS.get_environment("DSH_GODOT_TOKEN")
	var old_port := OS.get_environment("DSH_GODOT_WS_PORT")
	OS.set_environment("DSH_GODOT_TOKEN", "d".repeat(64))
	OS.set_environment("DSH_GODOT_WS_PORT", "18503")
	loaded = plugin._load_pairing()
	result["environment_override"] = int(loaded.get("port", 0)) == 18503
	if old_token.is_empty(): OS.unset_environment("DSH_GODOT_TOKEN")
	else: OS.set_environment("DSH_GODOT_TOKEN", old_token)
	if old_port.is_empty(): OS.unset_environment("DSH_GODOT_WS_PORT")
	else: OS.set_environment("DSH_GODOT_WS_PORT", old_port)
	var file := FileAccess.open(project_file, FileAccess.WRITE)
	file.store_buffer(original)
	file.close()
	if had_legacy:
		file = FileAccess.open(legacy_file, FileAccess.WRITE)
		file.store_buffer(legacy_original)
		file.close()
	else:
		DirAccess.remove_absolute(legacy_file)
	plugin.free()
	return result
`);
}
export async function verifyPairingFixture({ execute, report }) {
  const created = await execute('godot_node', { command: 'create_node', params: { type: 'Node', name: 'PairingProbe' } });
  try {
    await execute('godot_script', { command: 'attach_script', params: { path: created.path, script_path: 'res://pairing-probe.gd' } });
    const properties = await execute('godot_node', { command: 'get_node_properties', params: { path: created.path, fields: ['pairing_checks'] } });
    const checks = JSON.parse(properties.properties.find(entry => entry.name === 'pairing_checks').value);
    for (const name of ['project_path', 'legacy_fallback', 'project_overrides_legacy', 'invalid_project_does_not_fallback', 'environment_override']) assert.equal(checks[name], true, name);
    report.pairing_precedence = checks;
    report.steps.push('project pairing precedence, permissive mode, legacy fallback and invalid override');
    console.log('PASS project pairing precedence, permissive mode, legacy fallback and invalid override');
  } finally { await execute('godot_node', { command: 'delete_node', params: { path: created.path } }); }
}
