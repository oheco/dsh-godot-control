import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

const scriptErrors = /SCRIPT ERROR|Parse Error|Failed to load script/;
const oldBrand = /\bMCP\b/i;
const marker = 'DshMultiRouteProbe';
const markerPath = `/Main/${marker}`;
const positions = [{ x: 11, y: 12, z: 13 }, { x: -21, y: -22, z: -23 }, { x: 31, y: 32, z: 33 }];

export function assertDshPluginLogs(output, label, { expectPrefix = false } = {}) {
  assert.doesNotMatch(output, oldBrand, `${label}: obsolete plugin branding in native output`);
  if (expectPrefix) assert.match(output, /DSH Godot \|/, `${label}: expected a DSH Godot plugin log`);
}

// The probe only instantiates the plugin off-tree and calls its pure formatter.
// It never enables/disables the plugin or changes project/editor settings.
export async function setupDockStatusFixture(project) {
  await writeFile(path.join(project, 'dock-status-probe.gd'), `@tool
extends Node

@export var dock_status_checks: String:
\tget:
\t\tvar plugin = load("res://addons/dsh_godot/plugin.gd").new()
\t\tvar result := {"formatter_available": plugin.has_method("_connection_status_text")}
\t\tif result["formatter_available"]:
\t\t\tresult["blocked"] = plugin._connection_status_text({"phase": "blocked", "reason": "DSH_NATIVE_PAIRING_REQUIRED", "reason_code": "connection_blocked"})
\t\t\tresult["backoff"] = plugin._connection_status_text({"phase": "retrying", "reason": "DSH_NATIVE_RETRY_REASON", "reason_code": "connection_lost", "retry_in_sec": 4.0, "endpoint": "ws://127.0.0.1:19500"})
\t\t\tresult["connected"] = plugin._connection_status_text({"phase": "connected", "reason": "", "endpoint": "ws://127.0.0.1:19500", "editor_pid": 19501, "session_id": "native-dock@0123456789abcdef"})
\t\tplugin.free()
\t\treturn JSON.stringify(result)
`);
}

export async function verifyDockStatusFixture({ execute, report }) {
  const node = await execute('godot_node', { command: 'create_node', params: { type: 'Node', name: 'DockStatusProbe', parent_path: '/Main' } });
  try {
    await execute('godot_script', { command: 'attach_script', params: { path: node.path, script_path: 'res://dock-status-probe.gd' } });
    const properties = await execute('godot_node', { command: 'get_node_properties', params: { path: node.path, fields: ['dock_status_checks'] } });
    const checks = JSON.parse(properties.properties.find(entry => entry.name === 'dock_status_checks').value);
    assert.equal(checks.formatter_available, true, 'Godot dock exposes its connection status formatter');
    assert.match(checks.blocked, /DSH_NATIVE_PAIRING_REQUIRED/, 'Dock must show the pairing failure reason');
    assert.match(checks.backoff, /DSH_NATIVE_RETRY_REASON/, 'Dock must show the reconnect failure reason');
    assert.match(checks.backoff, /\b4\b/, 'Dock must show the reconnect delay');
    assert.match(checks.connected, /ws:\/\/127\.0\.0\.1:19500/, 'Dock must show the DSH endpoint');
    assert.match(checks.connected, /PID: 19501/, 'Dock must show the editor PID');
    assert.match(checks.connected, /native-dock@0123456789abcdef/, 'Dock must show the editor session ID');
    assert.notEqual(checks.blocked, checks.connected);
    assertDshPluginLogs(JSON.stringify(checks), 'dock status formatter');
    report.dock_status = checks;
    report.steps.push('native dock formatter shows pairing and reconnect failure reasons');
    console.log('PASS native dock formatter shows pairing and reconnect failure reasons');
  } finally {
    await execute('godot_node', { command: 'delete_node', params: { path: node.path } });
  }
}

async function until(description, predicate, { timeout = 15000, process: record } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    if (record?.finished) throw new Error(`${description}: editor exited (${record.code ?? record.error?.message ?? record.signal})\n${record.output.slice(-6000)}`);
    await delay(100);
  }
  throw new Error(`${description}: timed out after ${timeout} ms${record ? `\n${record.output.slice(-6000)}` : ''}`);
}

async function finishesWithin(promise, timeout) {
  let timer;
  try {
    return await Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), timeout); timer.unref(); })]);
  } finally { clearTimeout(timer); }
}

async function stop(record) {
  if (record.finished) return;
  record.child.kill('SIGTERM');
  if (!await finishesWithin(record.closed, 10000)) {
    record.child.kill('SIGKILL');
    assert.ok(await finishesWithin(record.closed, 10000), `Cannot stop fixture editor PID ${record.child.pid}`);
  }
}

// Runs late in native-test, after the original editor's reload/runtime checks.
// All auxiliary processes and their private Godot state belong to this fixture.
export async function verifyMultipleEditors({ work, source, evidence, engine, env, bridge, execute, editor, project, report }) {
  const sessions = () => bridge.status().sessions;
  const matchesProject = (session, target) => path.resolve(session.project_path) === path.resolve(target);
  const first = sessions().find(session => session.editor_pid === editor.pid && matchesProject(session, project));
  assert.ok(first, 'Original native editor must still be connected');
  assert.equal(sessions().length, 1, 'Multi-editor fixture starts with a single native editor');
  const directory = await mkdtemp(path.join(work, 'multi-editors-'));
  const secondProject = path.join(directory, 'second project');
  const records = [];
  const redact = text => String(text).replaceAll(bridge.token, '[redacted]');
  const startupTimeout = Number(process.env.GODOT_STARTUP_TIMEOUT_MS || 90000);
  const result = report.multi_editor = { initial_session: first, same_project: {}, cleanup: {} };
  const pass = name => { report.steps.push(name); console.log('PASS', name); };
  const explicit = (session, tool, args = {}) => execute(tool, { ...args, session_id: session.session_id });
  const state = session => explicit(session, 'godot_editor', { command: 'get_editor_state' });
  const tree = session => explicit(session, 'godot_scene_tree');
  const position = async session => {
    const value = await explicit(session, 'godot_node', { command: 'get_node_properties', params: { path: markerPath, fields: ['position'] } });
    return value.properties.find(entry => entry.name === 'position').value;
  };
  const setPosition = (session, value) => explicit(session, 'godot_node', { command: 'set_property', params: { path: markerPath, property: 'position', value } });
  const createMarker = session => explicit(session, 'godot_node', { command: 'create_node', params: { type: 'Node3D', name: marker, parent_path: '/Main' } });
  let firstMarker = false;
  async function launch(target, label, { importing = false } = {}) {
    const privateRoot = path.join(directory, label);
    await mkdir(privateRoot, { recursive: true });
    const childEnv = { ...env, GODOT_OHOS_DATA_DIR: path.join(privateRoot, 'data'), GODOT_OHOS_CACHE_DIR: path.join(privateRoot, 'cache'), DOTNET_CLI_HOME: path.join(privateRoot, 'dotnet'), DSH_GODOT_ALLOW_HEADLESS: importing ? '0' : '1' };
    // Do not inherit a caller's pairing override; use only the isolated project file.
    delete childEnv.DSH_GODOT_TOKEN;
    delete childEnv.DSH_GODOT_WS_PORT;
    const args = ['--headless', '--editor', '--path', target, ...(importing ? ['--import', '--quit'] : ['--script', 'res://bootstrap.gd'])];
    const child = spawn(engine, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const record = { child, label, output: '', finished: false, code: null, signal: null, error: null };
    records.push(record);
    child.stdout.on('data', data => { record.output += data; });
    child.stderr.on('data', data => { record.output += data; });
    record.closed = new Promise(resolve => {
      child.once('error', error => { record.error = error; });
      child.once('close', (code, signal) => { record.code = code; record.signal = signal; record.output = redact(record.output); record.finished = true; resolve(); });
    });
    if (importing) {
      assert.ok(await finishesWithin(record.closed, startupTimeout), `${label}: import timed out`);
      assert.equal(record.code, 0, `${label}: ${record.error?.message || record.output.slice(-6000)}`);
      assert.doesNotMatch(record.output, scriptErrors, label);
      assertDshPluginLogs(record.output, label);
      return record;
    }
    record.session = await until(`${label}: authenticate and open scene`, () => sessions().find(session => session.editor_pid === child.pid && matchesProject(session, target) && session.readiness === 'ready'), { timeout: startupTimeout, process: record });
    assert.equal(record.session.server_launch_mode, 'dsh');
    return record;
  }
  async function disconnect(record) {
    await stop(record);
    await until(`${record.label}: remove closed session`, () => !sessions().some(session => session.editor_pid === record.child.pid));
    assert.doesNotMatch(record.output, scriptErrors, record.label);
    assertDshPluginLogs(record.output, record.label, { expectPrefix: true });
  }
  try {
    await mkdir(secondProject, { recursive: true });
    await cp(path.join(source, 'godot/addons'), path.join(secondProject, 'addons'), { recursive: true });
    await writeFile(path.join(secondProject, 'project.godot'), '[application]\nconfig/name="DSH Godot Second Editor"\nrun/main_scene="res://main.tscn"\n[autoload]\n_dsh_godot_game_helper="*res://addons/dsh_godot/runtime/game_helper.gd"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n[editor_plugins]\nenabled=PackedStringArray("res://addons/dsh_godot/plugin.cfg")\n');
    await writeFile(path.join(secondProject, 'main.tscn'), '[gd_scene format=3]\n[node name="Main" type="Node3D"]\n');
    await writeFile(path.join(secondProject, 'bootstrap.gd'), 'extends SceneTree\nfunc _initialize() -> void:\n\tcall_deferred("start")\nfunc start() -> void:\n\tEditorInterface.open_scene_from_path("res://main.tscn")\n');
    await launch(secondProject, 'multi-import', { importing: true });
    const pairingDirectory = path.join(secondProject, '.godot/dsh-godot-control');
    await mkdir(pairingDirectory, { recursive: true });
    await writeFile(path.join(pairingDirectory, 'connection.cfg'), `[connection]\nport=${bridge.port}\ntoken="${bridge.token}"\n`);
    const secondary = await launch(secondProject, 'multi-second');
    const second = secondary.session;
    assert.equal(sessions().length, 2);
    assert.notEqual(second.session_id, first.session_id);
    result.second_session = second;
    await assert.rejects(execute('godot_scene_tree'), { code: 'SESSION_REQUIRED' });
    await assert.rejects(execute('godot_node', { command: 'create_node', params: { type: 'Node3D', name: 'MustNotDispatch', parent_path: '/Main' } }), { code: 'SESSION_REQUIRED' });
    const [firstState, secondState] = await Promise.all([state(first), state(second)]);
    assert.equal(firstState.project_name, 'DSH Godot Verification');
    assert.equal(secondState.project_name, 'DSH Godot Second Editor');
    for (const hierarchy of await Promise.all([tree(first), tree(second)])) {
      assert.equal(hierarchy.nodes[0].name, 'Main');
      assert.equal(hierarchy.nodes.some(node => node.name === 'MustNotDispatch' || node.name === marker), false);
    }
    await createMarker(first); firstMarker = true;
    await createMarker(second);
    await Promise.all([setPosition(first, positions[0]), setPosition(second, positions[1])]);
    assert.deepEqual(await position(first), positions[0]);
    assert.deepEqual(await position(second), positions[1]);
    result.independent_positions = { initial: positions[0], second: positions[1] };
    pass('two real editors require explicit session IDs and route reads and mutations independently');

    await disconnect(secondary);
    assert.equal(sessions().length, 1);
    assert.equal(sessions()[0].session_id, first.session_id);
    assert.deepEqual(await position(first), positions[0]);
    assert.equal((await state(first)).project_name, 'DSH Godot Verification');
    await assert.rejects(execute('godot_scene_tree'), { code: 'SESSION_REQUIRED' });
    await assert.rejects(execute('godot_node', { command: 'create_node', params: { type: 'Node3D', name: 'MustNotDispatch', parent_path: '/Main' } }), { code: 'SESSION_REQUIRED' });
    await assert.rejects(tree(second), { code: 'SESSION_NOT_FOUND' });
    pass('closing the second real editor preserves the first and still forbids implicit routing');

    const restarted = await launch(secondProject, 'multi-restarted');
    const replacement = restarted.session;
    assert.equal(sessions().length, 2);
    assert.notEqual(replacement.session_id, second.session_id, 'A fresh editor launch gets a fresh session ID');
    assert.notEqual(replacement.session_id, first.session_id);
    assert.equal((await state(replacement)).project_name, 'DSH Godot Second Editor');
    await assert.rejects(tree(second), { code: 'SESSION_NOT_FOUND' });
    assert.equal((await tree(replacement)).nodes.some(node => node.name === marker), false, 'Unsaved marker from the exited editor cannot leak into the new editor');
    await createMarker(replacement);
    await setPosition(replacement, positions[2]);
    assert.deepEqual(await position(replacement), positions[2]);
    assert.deepEqual(await position(first), positions[0]);
    result.restarted_session = replacement;
    result.restarted_position = positions[2];
    await disconnect(restarted);
    await explicit(first, 'godot_node', { command: 'delete_node', params: { path: markerPath } }); firstMarker = false;
    pass('restarting the second real editor replaces its session ID and accepts explicit routing');

    // The initial plugin has already persisted its helper autoload. The twin
    // only reads the shared project; independent Godot state avoids global
    // editor settings collisions. Verify project settings bytes AND mtime.
    const settingsFile = path.join(project, 'project.godot');
    const settings = await readFile(settingsFile);
    const settingsStat = await stat(settingsFile, { bigint: true });
    assert.match(settings.toString(), /^_dsh_godot_game_helper="\*res:\/\/addons\/dsh_godot\/runtime\/game_helper\.gd"$/m, 'Persist the helper before starting a same-project twin');
    const twin = await launch(project, 'multi-same-project');
    assert.equal(sessions().length, 2);
    assert.notEqual(twin.session.session_id, first.session_id);
    assert.notEqual(twin.session.editor_pid, first.editor_pid);
    assert.equal(path.resolve(twin.session.project_path), path.resolve(first.project_path));
    const [originalState, twinState] = await Promise.all([state(first), state(twin.session)]);
    assert.equal(originalState.project_name, twinState.project_name);
    assert.equal((await tree(twin.session)).nodes[0].name, 'Main');
    result.same_project = { session: twin.session, read_only: true };
    await disconnect(twin);
    assert.deepEqual(await readFile(settingsFile), settings, 'Same-project identity check must not rewrite project settings');
    assert.equal((await stat(settingsFile, { bigint: true })).mtimeNs, settingsStat.mtimeNs, 'Same-project identity check must not save project settings');
    pass('same-project real editors have distinct identities without writing project settings');

    const logs = await explicit(first, 'godot_editor', { command: 'get_logs', params: { source: 'plugin', count: 500 } });
    assert.ok(logs.lines.length > 0);
    for (const entry of logs.lines) {
      assert.match(entry.text, /^DSH Godot \|/);
      assertDshPluginLogs(entry.text, 'plugin log buffer');
    }
    result.plugin_log_lines_checked = logs.lines.length;
    pass('native plugin log buffer consistently identifies DSH Godot');
  } finally {
    const stopped = await Promise.allSettled(records.map(stop));
    result.cleanup.children = records.map(record => ({ label: record.label, pid: record.child.pid, stopped: record.finished, exit_code: record.code, signal: record.signal }));
    await Promise.all(records.map(record => writeFile(path.join(evidence, `${record.label}.log`), redact(record.output))));
    const failures = stopped.filter(value => value.status === 'rejected').map(value => value.reason);
    if (!failures.length) {
      try {
        await until('multi-editor fixture restores its original single editor', () => sessions().length === 1 && sessions()[0].session_id === first.session_id);
        result.cleanup.single_editor_restored = true;
        if (firstMarker) await explicit(first, 'godot_node', { command: 'delete_node', params: { path: markerPath } });
      } finally {
        const resolved = await realpath(directory), parent = await realpath(work);
        assert.equal(path.dirname(resolved), parent);
        assert.ok(path.basename(resolved).startsWith('multi-editors-'));
        await rm(resolved, { recursive: true });
        result.cleanup.directory_removed = true;
      }
    }
    assert.equal(failures.length, 0, failures.map(error => redact(error.message)).join('\n'));
    assert.ok(!JSON.stringify(result).includes(bridge.token), 'Native multi-editor report must not include pairing credentials');
  }
}
