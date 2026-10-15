import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const directory = 'resource-fixture';
const resource = name => `res://${directory}/${name}`;
const model = resource('triangle.gltf'), image = resource('palette.png');
const script = resource('probe.gd'), scene = resource('probe.tscn');
const missing = resource('missing.png');
// Standard 1 x 1 RGBA PNG (opaque red), including valid chunk CRCs.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const originals = new Map();
const disk = (project, name) => path.join(project, directory, name);

const probe = `@tool
extends Node

var _started: Array[String] = []
var _finished: Array[String] = []

@export var material_snapshot: String:
	get:
		return JSON.stringify(_snapshot())

func _on_reimporting(paths: PackedStringArray) -> void:
	for imported_path in paths:
		_started.append(imported_path)

func _on_reimported(paths: PackedStringArray) -> void:
	for imported_path in paths:
		_finished.append(imported_path)

func _snapshot() -> Dictionary:
	var filesystem := EditorInterface.get_resource_filesystem()
	if not filesystem.resources_reimporting.is_connected(_on_reimporting):
		filesystem.resources_reimporting.connect(_on_reimporting)
		filesystem.resources_reimported.connect(_on_reimported)
	var result := {
		"loaded": false, "mesh_found": false, "material_class": "",
		"has_albedo_texture": false, "texture_width": 0, "texture_height": 0,
		"imports_started": _started.duplicate(), "imports_finished": _finished.duplicate(),
		"is_importing": filesystem.is_importing(), "is_scanning": filesystem.is_scanning(),
	}
	# Bypass both the scene cache and external dependency caches on every read.
	var packed := ResourceLoader.load("${model}", "PackedScene", ResourceLoader.CACHE_MODE_IGNORE_DEEP) as PackedScene
	if packed == null:
		return result
	result["loaded"] = true
	var instance := packed.instantiate()
	var queue: Array[Node] = [instance]
	while not queue.is_empty():
		var node: Node = queue.pop_front()
		for child in node.get_children():
			queue.append(child)
		if node is MeshInstance3D and node.mesh != null and node.mesh.get_surface_count() > 0:
			result["mesh_found"] = true
			var material: Material = node.mesh.surface_get_material(0)
			result["material_class"] = material.get_class() if material != null else ""
			if material is StandardMaterial3D:
				var texture: Texture2D = material.albedo_texture
				result["has_albedo_texture"] = texture != null
				if texture != null:
					result["texture_width"] = texture.get_width()
					result["texture_height"] = texture.get_height()
			break
	instance.free()
	return result
`;

async function sourceSnapshot(project) {
  const snapshot = {};
  for (const name of ['triangle.gltf', 'triangle.bin']) {
    const filename = disk(project, name);
    snapshot[name] = {
      sha256: createHash('sha256').update(await readFile(filename)).digest('hex'),
      mtime_ns: (await stat(filename, { bigint: true })).mtimeNs.toString(),
    };
  }
  return snapshot;
}

// Call before native-test's initial --import, while palette.png is still absent.
export async function setupResourceFixture(project) {
  project = path.resolve(project);
  await mkdir(disk(project, ''), { recursive: true });
  await assert.rejects(readFile(disk(project, 'palette.png')), { code: 'ENOENT' });
  const binary = Buffer.alloc(104);
  const floats = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
  floats.forEach((value, index) => binary.writeFloatLE(value, index * 4));
  [0, 1, 2].forEach((value, index) => binary.writeUInt16LE(value, 96 + index * 2));
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Triangle', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    buffers: [{ uri: 'triangle.bin', byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
      { buffer: 0, byteOffset: 36, byteLength: 36, target: 34962 },
      { buffer: 0, byteOffset: 72, byteLength: 24, target: 34962 },
      { buffer: 0, byteOffset: 96, byteLength: 6, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC2' },
      { bufferView: 3, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    images: [{ uri: 'palette.png' }], textures: [{ source: 0 }],
    materials: [{ name: 'FixtureMaterial', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 } }],
  };
  await Promise.all([
    writeFile(disk(project, 'triangle.gltf'), JSON.stringify(gltf, null, 2) + '\n'),
    writeFile(disk(project, 'triangle.bin'), binary),
    writeFile(disk(project, 'probe.gd'), probe),
    writeFile(disk(project, 'probe.tscn'), '[gd_scene format=3]\n[node name="ResourceFixtureProbe" type="Node"]\n'),
  ]);
  const sources = await sourceSnapshot(project);
  originals.set(project, sources);
  return { model, image, script, scene, sources };
}

function expectMaterial(snapshot, textured) {
  assert.equal(snapshot.loaded, true, 'Imported GLTF must actually load as PackedScene');
  assert.equal(snapshot.mesh_found, true, 'Imported triangle must contain a mesh surface');
  assert.equal(snapshot.material_class, 'StandardMaterial3D');
  assert.equal(snapshot.has_albedo_texture, textured, 'Inspect actual imported material albedo_texture');
  assert.equal(snapshot.is_importing, false, 'Command must finish importing before replying');
  assert.equal(snapshot.is_scanning, false);
  if (textured) {
    assert.equal(snapshot.texture_width, 1);
    assert.equal(snapshot.texture_height, 1);
  }
}

function expectReimport(result, { reimported = [], skipped_non_imported = [], not_found = [], failed = [], all_succeeded }) {
  assert.equal(result.import_completed, true);
  assert.equal(result.all_succeeded, all_succeeded);
  for (const [name, expected] of Object.entries({ reimported, skipped_non_imported, not_found, failed })) {
    const actual = result[name];
    assert.ok(Array.isArray(actual), `${name} must be a string array`);
    assert.ok(actual.every(value => typeof value === 'string'), `${name} must contain only strings`);
    assert.equal(result[`${name}_count`], actual.length, `${name}_count`);
    assert.equal(actual.length, expected.length, name);
    expected.forEach((value, index) => {
      // Existing not_found diagnostics append a parenthesized explanation.
      if (name === 'not_found' || name === 'failed') assert.ok(actual[index] === value || actual[index].startsWith(`${value} (`), `${name}: ${actual[index]}`);
      else assert.equal(actual[index], value, name);
    });
  }
}

const importCount = (snapshot, name, field) => snapshot[field].filter(value => value === name).length;

// Call after the bridge handshake, using the same live editor and module instance.
export async function verifyResourceReimport({ project, execute, report }) {
  project = path.resolve(project);
  const original = originals.get(project);
  assert.ok(original, 'Call setupResourceFixture(project) before initial --import');
  const evidence = report.resource_reimport = { sources_before_import: original };
  const command = (name, params = {}) => execute('godot_command', { command: name, params, timeout_ms: 60000 });
  const step = async (name, operation) => {
    await operation();
    (report.steps ??= []).push(name);
    console.log('PASS', name);
  };
  const node = await execute('godot_node', { command: 'create_node', params: { scene_path: scene, name: 'ResourceFixtureProbe' } });
  await execute('godot_script', { command: 'attach_script', params: { path: node.path, script_path: script } });
  const snapshot = async () => {
    const result = await execute('godot_node', { command: 'get_node_properties', params: { path: node.path, fields: ['material_snapshot'] } });
    const property = result.properties.find(value => value.name === 'material_snapshot');
    assert.ok(property, 'Probe getter must be visible through get_node_properties');
    assert.equal(property.type, 'String');
    return JSON.parse(property.value);
  };
  await step('imported GLTF loads without its missing image', async () => {
    assert.deepEqual(await sourceSnapshot(project), original);
    evidence.initial = await snapshot();
    expectMaterial(evidence.initial, false);
  });
  await step('scan imports PNG while unchanged GLTF material stays untextured', async () => {
    await writeFile(disk(project, 'palette.png'), png);
    evidence.scan = await command('scan_filesystem');
    assert.equal(evidence.scan.scan_completed, true);
    evidence.after_scan = await snapshot();
    expectMaterial(evidence.after_scan, false);
    assert.match(await readFile(disk(project, 'palette.png.import'), 'utf8'), /^importer="texture"$/m);
    assert.deepEqual(await sourceSnapshot(project), original);
  });
  await step('forced mixed reimport repairs actual material and imports duplicate model once', async () => {
    evidence.mixed = await command('reimport', { paths: [model, script, missing, model] });
    expectReimport(evidence.mixed, { reimported: [model], skipped_non_imported: [script], not_found: [missing], all_succeeded: false });
    evidence.repaired = await snapshot();
    expectMaterial(evidence.repaired, true);
    for (const field of ['imports_started', 'imports_finished']) {
      assert.equal(importCount(evidence.repaired, model, field) - importCount(evidence.after_scan, model, field), 1, `Exactly one real model import: ${field}`);
    }
    assert.deepEqual(await sourceSnapshot(project), original);
  });
  await step('corrupt imported PNG returns per-file failure without counting success', async () => {
    await writeFile(disk(project, 'palette.png'), 'not a PNG\n');
    try {
      evidence.failed = await command('reimport', { paths: [image] });
      expectReimport(evidence.failed, { failed: [image], all_succeeded: false });
    } finally {
      await writeFile(disk(project, 'palette.png'), png);
    }
  });
  await step('restored PNG reimports successfully in the same editor', async () => {
    evidence.recovered = await command('reimport', { paths: [image] });
    expectReimport(evidence.recovered, { reimported: [image], all_succeeded: true });
    evidence.final = await snapshot();
    expectMaterial(evidence.final, true);
    for (const field of ['imports_started', 'imports_finished']) {
      assert.equal(importCount(evidence.final, image, field) - importCount(evidence.repaired, image, field), 2, `Both PNG import attempts actually ran: ${field}`);
    }
    evidence.sources_after_reimport = await sourceSnapshot(project);
    assert.deepEqual(evidence.sources_after_reimport, original);
    assert.deepEqual(await readFile(disk(project, 'palette.png')), png);
  });
  await execute('godot_node', { command: 'delete_node', params: { path: node.path } });
  return evidence;
}
