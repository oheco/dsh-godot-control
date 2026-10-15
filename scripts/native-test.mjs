import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, mkdtemp, cp, realpath, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GodotBridge } from '../server.js';
import { createOperations } from '../operations.js';
import { setupResourceFixture, verifyResourceReimport } from './native-resource-fixture.mjs';
import { setupPairingFixture, verifyPairingFixture } from './native-pairing-fixture.mjs';
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.TMPDIR || !process.env.XDG_CACHE_HOME) throw new Error('TMPDIR and XDG_CACHE_HOME are required.');
const work = await mkdtemp(path.join(process.env.TMPDIR, 'dsh-godot-native-'));
const evidence = path.join(process.env.XDG_CACHE_HOME, 'dsh-godot-control', 'verification', path.basename(work));
await mkdir(evidence, { recursive: true, mode: 0o700 });
const engine = process.env.GODOT_BIN || '/data/storage/el2/base/haps/entry/cache/godot-editor-window-mode-20261012/editor-cli-complete/godot';
const report = { started_at: new Date().toISOString(), engine, steps: [], ok: false };
const token = randomBytes(32).toString('hex'), bridge = new GodotBridge({ port: 0, token });
const execute = createOperations(bridge); await bridge.start();
const project = path.join(work, 'project with spaces'); await mkdir(project, { recursive: true });
await cp(path.join(source, 'godot/addons'), path.join(project, 'addons'), { recursive: true });
await writeFile(path.join(project, 'project.godot'), '[application]\nconfig/name="DSH Godot Verification"\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n[editor]\nrun/main_run_args="--headless"\n[editor_plugins]\nenabled=PackedStringArray("res://addons/dsh_godot/plugin.cfg")\n');
await writeFile(path.join(project, 'main.tscn'), '[gd_scene format=3]\n[node name="Main" type="Node3D"]\n');
await writeFile(path.join(project, 'bootstrap.gd'), 'extends SceneTree\nfunc _initialize() -> void:\n\tcall_deferred("start")\nfunc start() -> void:\n\tprint("DSH_TEST_BOOTSTRAP")\n\tEditorInterface.open_scene_from_path("res://main.tscn")\n\tawait create_timer(5).timeout\n\tvar queue: Array[Node] = [root]\n\twhile not queue.is_empty():\n\t\tvar node: Node = queue.pop_front()\n\t\tvar script: Script = node.get_script()\n\t\tif script != null and script.resource_path == "res://addons/dsh_godot/plugin.gd":\n\t\t\tvar connection = node.get("_connection")\n\t\t\tprint("DSH_TEST_CONNECTION ", JSON.stringify(connection.get_transport_status()) if connection != null else "missing")\n\t\tfor child in node.get_children():\n\t\t\tqueue.append(child)\n');
await setupResourceFixture(project);
await setupPairingFixture(project);
const pairingDirectory = path.join(project, '.godot/dsh-godot-control');
const pairingFile = path.join(pairingDirectory, 'connection.cfg');
async function pair(port, secret) {
  await mkdir(pairingDirectory, { recursive: true });
  await writeFile(pairingFile, `[connection]\nport=${port}\ntoken="${secret}"\n`);
}
report.transport_attempts = [];
bridge.server.on('upgrade', req => { if (report.transport_attempts.length < 10) report.transport_attempts.push({ origin: req.headers.origin || null, path: req.url }); });
const dotnet = '/storage/Users/currentUser/.oheco/packages/dotnet-sdk/10.0.401-ohos.2';
const env = { ...process.env, GODOT_SHARP_ROOT: '/storage/Users/currentUser/dev/ohos/godot-editor/bin/GodotSharp', DOTNET_ROOT: dotnet, DOTNET_ROOT_ARM64: dotnet, DOTNET_CLI_HOME: path.join(work, 'dotnet'), GODOT_OHOS_DATA_DIR: path.join(work, 'data'), GODOT_OHOS_CACHE_DIR: path.join(work, 'cache') };
delete env.DSH_GODOT_TOKEN;
delete env.DSH_GODOT_WS_PORT;
let editor, log = '';
async function run(args, name, extraEnv = {}) {
  const child = spawn(engine, args, { env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const [code, signal] = await once(child, 'exit'); await writeFile(path.join(evidence, name), output);
  assert.equal(code, 0, `${name}: exit ${code} ${signal}\n${output.slice(-6000)}`); assert.ok(!/SCRIPT ERROR|Parse Error|Failed to load script/.test(output), output.slice(-12000)); return output;
}
async function step(name, operation) { await operation(); report.steps.push(name); console.log('PASS', name); }
try {
  report.engine_version = (await run(['--version'], 'version.log')).trim();
  report.engine_sha256 = createHash('sha256').update(await readFile(engine)).digest('hex');
  await step('clean addon import on real Godot', () => run(['--headless', '--editor', '--path', project, '--import', '--quit'], 'import.log'));
  await pair(bridge.port, token);
  editor = spawn(engine, ['--headless', '--editor', '--path', project, '--script', 'res://bootstrap.gd'], { env: { ...env, DSH_GODOT_ALLOW_HEADLESS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  editor.stdout.on('data', data => { log += data; }); editor.stderr.on('data', data => { log += data; });
  report.editor_pid = editor.pid;
  const deadline = Date.now() + Number(process.env.GODOT_STARTUP_TIMEOUT_MS || 90000);
  while (!bridge.status().connected && Date.now() < deadline && editor.exitCode === null) await delay(100);
  assert.ok(bridge.status().connected, `Editor failed to authenticate:\n${log}`);
  while (bridge.status().sessions[0].readiness !== 'ready' && Date.now() < deadline) await delay(100);
  await step('mutual HMAC handshake with actual GDScript', async () => { assert.equal(bridge.status().sessions[0].readiness, 'ready'); assert.equal(bridge.status().sessions[0].server_launch_mode, 'dsh'); report.session = bridge.status().sessions[0]; });
  await verifyPairingFixture({ execute, report });
  await step('project-local pairing reloads without restarting editor', async () => {
    const alternate = new GodotBridge({ port: 0, token: randomBytes(32).toString('hex') });
    await alternate.start();
    try {
      await pair(alternate.port, alternate.token);
      const until = Date.now() + 20000;
      while ((!alternate.status().connected || bridge.status().connected) && Date.now() < until && editor.exitCode === null) await delay(100);
      assert.equal(alternate.status().connected, true);
      assert.equal(bridge.status().connected, false);
      assert.equal(alternate.status().sessions[0].editor_pid, report.session.editor_pid);
      await pair(bridge.port, token);
      const restored = Date.now() + 20000;
      while (!bridge.status().connected && Date.now() < restored && editor.exitCode === null) await delay(100);
      assert.equal(bridge.status().connected, true);
      assert.equal(bridge.status().sessions[0].editor_pid, report.session.editor_pid);
    } finally { await alternate.close(); }
  });
  await verifyResourceReimport({ project, execute, report });
  await step('read live scene hierarchy', async () => { const tree = await execute('godot_scene_tree'); assert.equal(tree.nodes[0].name, 'Main'); report.initial_tree = tree; });
  await step('create node with undo support', async () => { const node = await execute('godot_node', { command: 'create_node', params: { type: 'Node3D', name: 'Player', parent_path: '/Main' } }); assert.equal(node.path, '/Main/Player'); assert.equal(node.undoable, true); });
  await step('typed vector property round trip', async () => { await execute('godot_node', { command: 'set_property', params: { path: '/Main/Player', property: 'position', value: { x: 1, y: 2, z: 3 } } }); const props = await execute('godot_node', { command: 'get_node_properties', params: { path: '/Main/Player', fields: ['position'] } }); report.properties = props; assert.equal(props.properties[0].type, 'Vector3'); assert.deepEqual(props.properties[0].value, { x: 1, y: 2, z: 3 }); });
  await step('create, read and attach a real script', async () => {
    const content = 'extends Node3D\n@export var speed: float = 3.5\n';
    const created = await execute('godot_script', { command: 'create_script', params: { path: 'res://player.gd', content } });
    assert.equal(created.committed, true); assert.equal(created.language, 'gdscript');
    const script = await execute('godot_script', { command: 'read_script', params: { path: 'res://player.gd' } }); assert.equal(script.content, content);
    await execute('godot_script', { command: 'attach_script', params: { path: '/Main/Player', script_path: 'res://player.gd' } });
    const props = await execute('godot_node', { command: 'get_node_properties', params: { path: '/Main/Player', fields: ['speed'] } }); assert.equal(props.properties[0].value, 3.5);
  });
  await step('refuse overwriting the loaded standalone addon', async () => {
    const filename = path.join(project, 'addons/dsh_godot/plugin.gd'), original = await readFile(filename);
    await assert.rejects(execute('godot_command', { command: 'write_file', params: { path: 'res://addons/dsh_godot/plugin.gd', content: 'corrupted' } }), { code: 'VALUE_OUT_OF_RANGE' });
    assert.deepEqual(await readFile(filename), original);
  });
  await step('structured editor errors preserve code', async () => { await assert.rejects(execute('godot_node', { command: 'get_node_properties', params: { path: '/Main/Missing' } }), { code: 'NODE_NOT_FOUND' }); });
  await step('persist scene and verify saved node', async () => { await execute('godot_scene', { command: 'save_scene' }); assert.ok((await readFile(path.join(project, 'main.tscn'), 'utf8')).includes('Player')); });
  await step('read editor state and logs', async () => { const state = await execute('godot_editor', { command: 'get_editor_state' }); assert.equal(state.project_name, 'DSH Godot Verification'); await execute('godot_editor', { command: 'get_logs', params: { source: 'editor', count: 20 } }); });
  await step('delete node and verify hierarchy', async () => { await execute('godot_node', { command: 'delete_node', params: { path: '/Main/Player' } }); const tree = await execute('godot_scene_tree'); assert.equal(tree.nodes.some(node => node.name === 'Player'), false); });
  await step('reload plugin and reconnect without restarting editor', async () => {
    const previous = bridge.resolveSession();
    const result = await execute('godot_editor', { command: 'reload_plugin' });
    assert.equal(result.status, 'reloading');
    const until = Date.now() + 90000;
    while ((bridge.sessions.get(report.session.session_id) === previous || !bridge.status().connected) && Date.now() < until && editor.exitCode === null) await delay(100);
    assert.equal(bridge.status().connected, true);
    assert.notEqual(bridge.resolveSession(), previous);
    assert.equal(bridge.status().sessions[0].editor_pid, report.session.editor_pid);
  });
  await step('runtime helper announces readiness and evaluates over corrected debugger channel', async () => {
    try {
      await execute('godot_project', { command: 'run_project', params: { mode: 'main' }, timeout_ms: 60000 });
      const until = Date.now() + 60000;
      let state;
      do {
        state = await execute('godot_editor', { command: 'get_editor_state' });
        if (state.helper_live && state.game_capture_ready) break;
        await delay(200);
      } while (Date.now() < until && editor.exitCode === null);
      assert.equal(state.helper_live, true, JSON.stringify(state));
      assert.equal(state.game_capture_ready, true);
      const evaluated = await execute('godot_editor', { command: 'game_eval', params: { code: 'return {"answer": 2 + 3}' }, timeout_ms: 60000 });
      assert.deepEqual(evaluated.result, { answer: 5 });
      report.runtime_bridge = { helper_live: state.helper_live, game_capture_ready: state.game_capture_ready, evaluated: evaluated.result };
    } finally { await execute('godot_project', { command: 'stop_project' }); }
  });
  await writeFile(path.join(evidence, 'editor.log'), log);
  assert.ok(!/SCRIPT ERROR|Parse Error|Failed to load script/.test(log), log.slice(-12000));
  report.ok = true;
} catch (error) { report.error = { code: error.code || 'ASSERTION_FAILED', message: error.message }; console.error(report.error.message); process.exitCode = 1; }
finally {
  if (editor && editor.exitCode === null) { const exited = once(editor, 'exit'); editor.kill('SIGTERM'); await exited; }
  await writeFile(path.join(evidence, 'editor.log'), log);
  await bridge.close(); report.finished_at = new Date().toISOString(); await writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const resolved = await realpath(work), parent = await realpath(process.env.TMPDIR);
  assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith('dsh-godot-native-')); await rm(resolved, { recursive: true });
  console.log(JSON.stringify({ ok: report.ok, steps: report.steps.length, report: path.join(evidence, 'report.json') }));
}
