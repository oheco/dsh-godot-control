#!/usr/bin/env node
/** Verify the installed native tools through the existing DSH model session and real Godot. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, cp, writeFile, readFile, realpath, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { authenticateDSH } from './dsh-manager.mjs';
import { loadConnection, connectionDirectory } from '../server.js';
import { TOOL_SPECS } from '../operations.js';
import { WebSocket } from '../tpr/ws/wrapper.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pid = process.argv[2];
assert.match(pid || '', /^\d+$/, 'Usage: node scripts/dsh-e2e.mjs <existing-host-pid>');
assert.ok(process.env.TMPDIR && process.env.XDG_CACHE_HOME, 'TMPDIR and XDG_CACHE_HOME are required.');
const base = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080';
assert.equal(new URL(base).hostname, '127.0.0.1', 'Only the existing loopback DSH host is allowed.');
assert.equal(new URL(base).protocol, 'http:');
const startupTimeout = Math.max(90000, Number(process.env.GODOT_STARTUP_TIMEOUT_MS || 120000));
const modelTimeout = Math.max(90000, Number(process.env.DSH_E2E_MODEL_TIMEOUT_MS || 300000));
assert.ok(Number.isFinite(startupTimeout) && Number.isFinite(modelTimeout), 'Timeouts must be finite.');
const tmpRoot = await realpath(process.env.TMPDIR);
const cacheRoot = await realpath(process.env.XDG_CACHE_HOME);
const work = await mkdtemp(path.join(tmpRoot, 'dsh-godot-e2e-'));
const ownedRealpath = await realpath(work);
assert.equal(path.dirname(ownedRealpath), tmpRoot);
const evidence = path.join(cacheRoot, 'dsh-godot-control', 'verification', path.basename(work));
await mkdir(evidence, { recursive: true, mode: 0o700 });
const evidenceRealpath = await realpath(evidence);
assert.ok(evidenceRealpath.startsWith(cacheRoot + path.sep), 'Reports must stay inside XDG_CACHE_HOME.');
const reportPath = path.join(evidenceRealpath, 'report.json');
const project = path.join(work, 'project');
const engine = process.env.GODOT_BIN || '/data/storage/el2/base/haps/entry/cache/godot-editor-window-mode-20261012/editor-cli-complete/godot';
const report = {
  started_at: new Date().toISOString(), ok: false,
  host: { pid: Number(pid), base }, engine,
  isolated_project: project, startup_timeout_ms: startupTimeout, model_timeout_ms: modelTimeout,
  steps: [], authentication: {}, logs: {}, cleanup: {},
  scope: 'Installed native DSH tools, authenticated model transcript, real isolated Godot editor and scene mutation.',
};
const secrets = new Set();
const children = new Set();
const follows = new Set();
let client, connection, editor, godotSessionId, dshSessionId;
let promptSubmitted = false, turnEnded = false, interrupted;
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  interrupted = signal;
  abort.abort(new Error(`Verification interrupted by ${signal}.`));
});

function safeText(input) {
  let text = String(input);
  for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]');
  return text.replace(/([?&](?:token|key|secret)=)[^\s&#]+/gi, '$1[REDACTED]')
    .replace(/\b(Bearer\s+)\S+/gi, '$1[REDACTED]');
}
function sanitize(value) {
  if (typeof value === 'string') return safeText(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /^(token|cookie|authorization|password|secret|api[_-]?key|client_proof|server_proof)$/i.test(key) ? '[REDACTED]' : sanitize(item)]));
  return value;
}
function errorInfo(error) { return { code: error.code || error.name || 'VERIFICATION_FAILED', message: safeText(error.message || error) }; }
function log(message) { console.log(safeText(message)); }
async function step(name, operation) {
  abort.signal.throwIfAborted();
  const started = Date.now();
  await operation();
  report.steps.push({ name, ok: true, duration_ms: Date.now() - started });
  log(`PASS ${name}`);
}
async function bounded(promise, timeout, label, ignoreAbort = false) {
  let timer;
  const cancelled = () => rejectCancellation(abort.signal.reason);
  let rejectCancellation;
  const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
  if (!ignoreAbort) {
    abort.signal.addEventListener('abort', cancelled, { once: true });
    if (abort.signal.aborted) cancelled();
  }
  try {
    return await Promise.race([promise, cancellation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeout} ms.`)), timeout);
    })]);
  } finally { clearTimeout(timer); abort.signal.removeEventListener('abort', cancelled); }
}
async function request(method, args) { return bounded(client.request(method, args), 30000, method); }
async function rpc(tool, args = {}) {
  const response = await fetch(`http://127.0.0.1:${connection.port}/rpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` },
    body: JSON.stringify({ tool, args }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(35000)]),
  });
  const result = await response.json();
  assert.ok(response.ok && result.ok === true, `Native ${tool} failed: ${JSON.stringify(sanitize(result.error || { status: response.status }))}`);
  return result.value;
}
function child(args, name, env) {
  const processChild = spawn(engine, args, { env, cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
  const capture = { process: processChild, tail: '', total_bytes: 0, script_error: false };
  const append = data => {
    capture.total_bytes += data.length;
    const combined = safeText(capture.tail + data.toString());
    capture.script_error ||= /SCRIPT ERROR|Parse Error|Failed to load script/.test(combined);
    capture.tail = combined.slice(-24576);
  };
  processChild.stdout.on('data', append); processChild.stderr.on('data', append);
  capture.done = new Promise(resolve => {
    processChild.once('error', error => { capture.error = errorInfo(error); resolve({ code: null, error: capture.error }); });
    processChild.once('close', (code, signal) => { capture.exit = { code, signal }; resolve(capture.exit); });
  });
  capture.name = name; children.add(capture);
  return capture;
}
async function saveChildLog(capture) {
  report.logs[capture.name] = { total_bytes: capture.total_bytes, retained_characters: capture.tail.length, truncated: capture.total_bytes > Buffer.byteLength(capture.tail), exit: capture.exit || null, error: capture.error || null };
  await writeFile(path.join(evidenceRealpath, capture.name), safeText(capture.tail), { mode: 0o600 });
}
async function stopChild(capture) {
  if (capture.process.exitCode === null && capture.process.signalCode === null && !capture.error) {
    capture.process.kill('SIGTERM');
    let timer;
    const stopped = await Promise.race([capture.done.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 7000); })]);
    clearTimeout(timer);
    if (!stopped) {
      capture.process.kill('SIGKILL');
      await bounded(capture.done, 7000, 'Godot child shutdown', true);
    }
  }
  await capture.done;
  await saveChildLog(capture);
}
async function run(args, name, env, timeout) {
  const capture = child(args, name, env);
  try {
    const exit = await bounded(capture.done, timeout, name);
    assert.equal(exit.code, 0, `${name}: ${JSON.stringify(exit)}\n${capture.tail.slice(-4000)}`);
    assert.equal(capture.script_error, false, `${name}: Godot script error\n${capture.tail.slice(-4000)}`);
    return capture.tail;
  } finally { await stopChild(capture); }
}

/** Wire vocabulary follows gateway/stream-protocol.ts and session-controller/src/types.ts. */
class Follow {
  constructor() {
    this.streamId = randomUUID(); this.events = []; this.snapshot = null; this.error = null;
    this.ended = false; this.cancelled = false; this.bytes = 0;
    const url = new URL('/api/remote.mux', client.base); url.protocol = 'ws:';
    this.socket = new WebSocket(url, { headers: { Cookie: client.cookie, Origin: new URL(client.base).origin }, handshakeTimeout: 15000, maxPayload: 32 * 1024 * 1024, perMessageDeflate: false });
    follows.add(this);
    this.opened = new Promise((resolve, reject) => {
      this.socket.once('open', resolve); this.socket.once('error', reject);
      this.socket.once('close', () => { if (this.socket.readyState !== WebSocket.OPEN) reject(new Error('Follow WebSocket closed before opening.')); });
    });
    this.socket.on('error', error => { this.error = error; });
    this.socket.on('close', () => { if (!this.cancelled) this.error ||= new Error('Follow WebSocket closed before cancellation.'); });
    this.socket.on('message', (raw, binary) => {
      try {
        assert.equal(binary, false, 'Remote mux must return text frames.');
        const frame = JSON.parse(raw.toString());
        assert.equal(frame.streamId, this.streamId, 'Unexpected logical stream identity.');
        if (frame.type === 'error') throw Object.assign(new Error(frame.error.message), { code: frame.error.code });
        if (frame.type === 'end') { this.ended = true; return; }
        assert.equal(frame.type, 'item', 'Unexpected remote stream frame; inspect DSH stream protocol.');
        const value = frame.value;
        if (!this.snapshot) {
          assert.equal(value.type, 'snapshot', 'Follow must start with a snapshot.');
          assert.equal(value.header.id, dshSessionId);
          assert.equal(value.header.cwd, project);
          assert.ok(Number.isSafeInteger(value.cursor) && value.cursor >= -1);
          assert.ok(Array.isArray(value.records));
          assert.equal(value.hasMore, false, 'Fresh verification Session history must be complete.');
          this.snapshot = value;
          for (const record of value.records) this.acceptRecord(record);
          if (this.events.length) assert.equal(this.events.at(-1).seq, value.cursor);
          this.nextSeq = value.cursor + 1;
        } else {
          assert.equal(value.type, 'event', 'Unexpected follow item; inspect SessionFollowFrame.');
          assert.equal(value.event.seq, this.nextSeq, 'Durable transcript sequence gap.');
          this.nextSeq++;
          this.acceptRecord(value);
        }
      } catch (error) { this.error ||= error; }
    });
  }
  acceptRecord(record) {
    assert.equal(record.type, 'event');
    assert.ok(record.event && typeof record.event.type === 'string' && Number.isSafeInteger(record.event.seq));
    this.bytes += Buffer.byteLength(JSON.stringify(record));
    assert.ok(this.bytes <= 32 * 1024 * 1024 && this.events.length < 10000, 'Verification transcript exceeded its limit.');
    this.events.push(record.event);
    if (record.event.type === 'tool/call') {
      assert.ok(['godot_status', 'godot_scene_tree', 'godot_node'].includes(record.event.data.name), `Model used an unauthorized tool: ${record.event.data.name}`);
      log(`MODEL ${record.event.data.name} call (${record.event.seq})`);
    }
    if (record.event.type === 'tool/result') log(`MODEL tool result (${record.event.seq}), isError=${record.event.data.message.isError}`);
  }
  async start() {
    await bounded(this.opened, 16000, 'Authenticated WebSocket connection');
    this.socket.send(JSON.stringify({ type: 'open', streamId: this.streamId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: dshSessionId }, maxMessages: 100 } } } }));
    await this.wait(() => this.snapshot, 30000, 'Follow opening snapshot');
    return this;
  }
  async wait(condition, timeout, label) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      abort.signal.throwIfAborted();
      if (this.error) throw this.error;
      const value = condition(); if (value) return value;
      assert.equal(this.ended, false, `${label}: follow stream ended early.`);
      if (editor?.exit || editor?.error) throw new Error(`Godot editor exited during ${label}.`);
      await delay(200, undefined, { signal: abort.signal });
    }
    throw new Error(`${label} timed out after ${timeout} ms.`);
  }
  async close() {
    if (this.cancelled) return;
    this.cancelled = true;
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'cancel', streamId: this.streamId }));
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise(resolve => this.socket.once('close', resolve));
    this.socket.close();
    let timer;
    await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => { this.socket.terminate(); resolve(); }, 2000); })]);
    clearTimeout(timer);
  }
}
function resultValue(event) {
  const message = event.data.message;
  assert.equal(message.role, 'tool');
  assert.equal(message.isError, false, 'Every Godot result must explicitly have isError=false.');
  assert.equal(message.source.kind, 'tool');
  assert.equal(message.source.callId, message.toolCallId);
  assert.ok(message.content.every(block => block.type === 'text'));
  return JSON.parse(message.content.map(block => block.text).join(''));
}
function verifyTranscript(events) {
  const calls = events.filter(event => event.type === 'tool/call');
  assert.ok(calls.length >= 4, 'Expected state, initial scene, node creation and confirmation calls.');
  assert.equal(calls[0].data.name, 'godot_status');
  const pairs = calls.map(call => {
    assert.ok(['godot_status', 'godot_scene_tree', 'godot_node'].includes(call.data.name));
    const matches = events.filter(event => event.type === 'tool/result' && event.data.message.toolCallId === call.data.callId);
    assert.equal(matches.length, 1, `Missing or repeated tool result for ${call.data.name}.`);
    const result = matches[0]; assert.ok(result.seq > call.seq);
    const args = JSON.parse(call.data.arguments);
    if (call.data.name !== 'godot_status') {
      assert.equal(args.session_id, godotSessionId, 'Every editor call must explicitly select the owned Godot editor.');
    }
    return { call, result, args, value: resultValue(result) };
  });
  const status = pairs[0].value;
  assert.ok(status.sessions.some(session => session.session_id === godotSessionId && path.resolve(session.project_path) === project));
  const create = pairs.find(pair => pair.call.data.name === 'godot_node' && pair.args.command === 'create_node');
  assert.ok(create, 'The model must create the node through the native Godot tool.');
  assert.deepEqual({ type: create.args.params.type, name: create.args.params.name, parent_path: create.args.params.parent_path }, { type: 'Node3D', name: 'DSHVerified', parent_path: '/Main' });
  assert.equal(create.value.path, '/Main/DSHVerified');
  assert.equal(create.value.undoable, true);
  const before = pairs.find(pair => pair.call.data.name === 'godot_scene_tree' && pair.result.seq < create.call.seq);
  assert.ok(before && before.value.nodes.some(node => node.name === 'Main' && node.type === 'Node3D'));
  assert.equal(before.value.nodes.some(node => node.name === 'DSHVerified'), false);
  const after = pairs.find(pair => pair.call.seq > create.result.seq && (
    pair.call.data.name === 'godot_scene_tree' && pair.value.nodes.some(node => node.path === '/Main/DSHVerified' && node.type === 'Node3D') ||
    pair.call.data.name === 'godot_node' && pair.args.command === 'get_node_properties' && pair.args.params.path === '/Main/DSHVerified' && pair.value.path === '/Main/DSHVerified' ||
    pair.call.data.name === 'godot_node' && pair.args.command === 'get_children' && pair.args.params.path === '/Main' && JSON.stringify(pair.value).includes('/Main/DSHVerified')
  ));
  assert.ok(after, 'The model must read and confirm its newly created node.');
  for (const pair of pairs.filter(pair => pair.call.data.name === 'godot_node')) {
    assert.ok(['create_node', 'get_node_properties', 'get_children'].includes(pair.args.command), 'Only the requested creation and confirmation are allowed.');
    if (pair.args.command === 'create_node') assert.equal(pair, create, 'Only one node creation is allowed.');
  }
  const headers = events.filter(event => event.type === 'request/header');
  const expected = TOOL_SPECS.map(spec => spec.name).sort();
  const actual = headers[0]?.data.header.tools?.filter(tool => expected.includes(tool.name));
  assert.deepEqual(actual?.map(tool => tool.name).sort(), expected, 'All nine native Godot tools must be present in the model request header.');
  const route = headers[0].data.header.config;
  return {
    model: { provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort },
    native_tool_names: expected, native_tool_schemas: actual,
    pairs: pairs.map(pair => ({ call_id: pair.call.data.callId, tool: pair.call.data.name, command: pair.args.command, call_seq: pair.call.seq, result_seq: pair.result.seq, isError: pair.result.data.message.isError })),
    creation_seq: create.call.seq, confirmation_seq: after.result.seq,
  };
}
function transcriptEvidence(events) {
  return {
    event_index: events.map(event => ({ seq: event.seq, type: event.type, time: event.time })),
    tool_events: events.filter(event => ['tool/call', 'tool/result'].includes(event.type)),
    terminal_events: events.filter(event => event.type === 'turn/end'),
    assistant_results: events.filter(event => event.type === 'assistant/message').flatMap(event => event.data.message.content.filter(block => block.type === 'text').map(block => block.text)).slice(-4),
  };
}

try {
  await step('authenticate existing DSH host without exposing credentials', async () => {
    client = await bounded(authenticateDSH(pid, base), 20000, 'DSH authentication');
    secrets.add(client.cookie); secrets.add(client.cookie.split('=').slice(1).join('='));
    report.authentication.dsh_cookie_obtained = true;
    report.authentication.origin = new URL(base).origin;
    const bundles = await request('pluginManager/listBundles', {});
    const bundle = bundles.find(row => row.name === '@oheco/dsh-godot-control');
    assert.ok(bundle?.installed && bundle.enabled && !bundle.error);
    assert.equal(bundle.version, '0.1.0');
    const entries = await request('pluginManager/listPlugins', {});
    const plugin = entries.find(entry => bundle.rows.some(row => row.entryId === entry.entryId));
    assert.equal(plugin?.enabled, true);
    assert.equal(plugin?.fiberPhase, 'active');
    report.installed_bundle = { name: bundle.name, version: bundle.version, installed: bundle.installed, enabled: bundle.enabled };
    report.plugin = { moduleName: plugin.moduleName, entryId: plugin.entryId, fiberPhase: plugin.fiberPhase };
    // Refuse missing pairing storage before loadConnection can create a new config.
    await stat(path.join(connectionDirectory(), 'connection.json'));
    connection = await loadConnection(); secrets.add(connection.token);
    const status = await rpc('godot_status');
    assert.equal(status.listening, true);
    report.existing_godot_session_count = status.sessions.length;
    report.authentication.native_rpc_authenticated = true;
    report.authentication.native_endpoint = connection.endpoint;
  });
  await step('prepare owned isolated Godot project in TMPDIR', async () => {
    await mkdir(project, { mode: 0o700 });
    for (const name of ['dotnet', 'data', 'cache', 'tmp']) await mkdir(path.join(work, name), { mode: 0o700 });
    await cp(path.join(source, 'godot', 'addons'), path.join(project, 'addons'), { recursive: true });
    await writeFile(path.join(project, 'project.godot'), '[application]\nconfig/name="DSH Godot E2E Verification"\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n[editor_plugins]\nenabled=PackedStringArray("res://addons/dsh_godot/plugin.cfg")\n');
    await writeFile(path.join(project, 'main.tscn'), '[gd_scene format=3]\n[node name="Main" type="Node3D"]\n');
    await writeFile(path.join(project, 'bootstrap.gd'), 'extends SceneTree\nfunc _initialize() -> void:\n\tcall_deferred("start")\nfunc start() -> void:\n\tprint("DSH_E2E_BOOTSTRAP")\n\tEditorInterface.open_scene_from_path("res://main.tscn")\n');
    report.source_script_sha256 = createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex');
    report.engine_sha256 = createHash('sha256').update(await readFile(engine)).digest('hex');
  });
  const dotnet = process.env.DOTNET_ROOT || '/storage/Users/currentUser/.oheco/packages/dotnet-sdk/10.0.401-ohos.2';
  const env = {
    ...process.env, GODOT_SHARP_ROOT: process.env.GODOT_SHARP_ROOT || '/storage/Users/currentUser/dev/ohos/godot-editor/bin/GodotSharp',
    DOTNET_ROOT: dotnet, DOTNET_ROOT_ARM64: process.env.DOTNET_ROOT_ARM64 || dotnet,
    DOTNET_CLI_HOME: path.join(work, 'dotnet'), GODOT_OHOS_DATA_DIR: path.join(work, 'data'), GODOT_OHOS_CACHE_DIR: path.join(work, 'cache'),
    TMPDIR: path.join(work, 'tmp'), XDG_CONFIG_HOME: path.join(work, 'data'), XDG_CACHE_HOME: path.join(work, 'cache'),
    DSH_GODOT_ALLOW_HEADLESS: '0', DSH_GODOT_TOKEN: '', DSH_GODOT_WS_PORT: '',
  };
  await step('import addon with actual headless Godot and isolated caches', async () => {
    report.engine_version = (await run(['--version'], 'version.log', env, 30000)).trim();
    await run(['--headless', '--editor', '--path', project, '--import', '--quit'], 'import.log', env, Math.max(180000, startupTimeout));
  });
  await step('authenticate actual Godot editor to installed native DSH plugin', async () => {
    editor = child(['--headless', '--editor', '--path', project, '--script', 'res://bootstrap.gd'], 'editor.log', { ...env, DSH_GODOT_ALLOW_HEADLESS: '1', DSH_GODOT_TOKEN: connection.token, DSH_GODOT_WS_PORT: String(connection.port) });
    report.editor_pid = editor.process.pid;
    const deadline = Date.now() + startupTimeout;
    while (Date.now() < deadline) {
      abort.signal.throwIfAborted();
      if (editor.exit || editor.error) throw new Error(`Godot editor exited before authentication: ${editor.tail.slice(-4000)}`);
      const status = await rpc('godot_status');
      report.last_godot_status = status;
      const own = status.sessions.find(session => path.resolve(session.project_path) === project && session.editor_pid === editor.process.pid && session.readiness === 'ready');
      if (own) {
        assert.equal(own.server_launch_mode, 'dsh');
        godotSessionId = own.session_id; report.godot_session = own;
        report.authentication.godot_mutual_hmac_authenticated = true;
        break;
      }
      await delay(500, undefined, { signal: abort.signal });
    }
    assert.ok(godotSessionId, `Godot authentication/startup timed out: ${editor.tail.slice(-4000)}`);
    report.initial_tree = await rpc('godot_scene_tree', { session_id: godotSessionId });
    assert.equal(report.initial_tree.nodes[0].name, 'Main');
    assert.equal(report.initial_tree.nodes[0].type, 'Node3D');
    assert.equal(report.initial_tree.nodes.some(node => node.name === 'DSHVerified'), false);
  });
  await step('create independent DSH Session in isolated project', async () => {
    const created = await request('session/create', { request: { cwd: project } });
    assert.ok(typeof created.sessionId === 'string' && created.sessionId);
    dshSessionId = created.sessionId; report.dsh_session = created;
  });
  let follow;
  await step('open authenticated session/follow mux and receive durable snapshot', async () => {
    follow = await new Follow().start();
    report.authentication.mux_cookie_and_origin_authenticated = true;
    report.follow_snapshot = { cursor: follow.snapshot.cursor, record_count: follow.snapshot.records.length, hasMore: follow.snapshot.hasMore, header: follow.snapshot.header };
  });
  await step('prompt real model and await native Godot calls and completed turn', async () => {
    const prompt = '隔离验收，仅用godot_status、godot_scene_tree、godot_node工具。先查询Godot状态，再读取Main场景，在Main下创建Node3D DSHVerified节点并读取确认；返回简短结果。不要运行其他工具、不写文件、不改其他项目。';
    const text = prompt + `\n本次唯一允许的 Godot 项目是 ${project}，唯一允许的 Godot session_id 是 ${godotSessionId}。所有场景与节点调用都显式传此 session_id。create_node 参数为 type=Node3D,name=DSHVerified,parent_path=/Main；随后用 godot_scene_tree 或 get_node_properties 确认。`;
    report.prompt = { requestId: randomUUID(), text };
    promptSubmitted = true;
    const receipt = await request('session/prompt', { request: { requestId: report.prompt.requestId, sessionId: dshSessionId, mode: 'queue', content: [{ type: 'text', text }] } });
    assert.equal(receipt.accepted, true); report.prompt.accepted = true;
    const end = await follow.wait(() => follow.events.find(event => event.type === 'turn/end'), modelTimeout, 'Real model Godot verification');
    turnEnded = true;
    report.turn_end = end;
    assert.equal(end.data.reason.kind, 'completed', `Model turn failed: ${JSON.stringify(sanitize(end.data.reason))}`);
    report.model_verification = verifyTranscript(follow.events);
  });
  await step('read durable history again and pair successful native tool results', async () => {
    const page = await request('session/page', { request: { address: { kind: 'session', sessionId: dshSessionId }, throughSeq: report.turn_end.seq, maxMessages: 100 } });
    assert.equal(page.hasMore, false);
    assert.ok(page.records.every(record => record.type === 'event'));
    const events = page.records.map(record => record.event);
    const replayed = verifyTranscript(events);
    assert.deepEqual(replayed.pairs, report.model_verification.pairs);
    report.durable_readback = { throughSeq: report.turn_end.seq, record_count: events.length, hasMore: page.hasMore, ...transcriptEvidence(events) };
    report.authentication.durable_transcript_readback_authenticated = true;
  });
  await step('independently confirm model-created node in real Godot scene', async () => {
    report.final_tree = await rpc('godot_scene_tree', { session_id: godotSessionId });
    const verified = report.final_tree.nodes.find(node => node.path === '/Main/DSHVerified');
    assert.ok(verified); assert.equal(verified.name, 'DSHVerified'); assert.equal(verified.type, 'Node3D');
    assert.equal(editor.script_error, false, editor.tail.slice(-4000));
  });
  report.ok = true;
} catch (error) {
  report.error = errorInfo(error); process.exitCode = 1;
  log(`FAIL ${report.error.code}: ${report.error.message}`);
} finally {
  const failures = [];
  // Cancellation and child shutdown must still run after an interrupt aborts normal waits.
  if (promptSubmitted && !turnEnded && client && dshSessionId) {
    try {
      const result = await bounded(client.request('session/cancel', { request: { sessionId: dshSessionId } }), 15000, 'Owned model turn cancellation', true);
      report.cleanup.own_model_turn_cancelled = result.accepted === true;
      const deadline = Date.now() + 15000;
      while ([...follows].every(follow => !follow.events.some(event => event.type === 'turn/end')) && Date.now() < deadline) await delay(100);
      report.cleanup.own_model_turn_settled = [...follows].some(follow => follow.events.some(event => event.type === 'turn/end'));
      assert.equal(report.cleanup.own_model_turn_settled, true, 'Cancelled model turn did not settle.');
    } catch (error) { failures.push(errorInfo(error)); }
  }
  for (const follow of follows) {
    report.live_transcript ||= transcriptEvidence(follow.events);
    try { await follow.close(); } catch (error) { failures.push(errorInfo(error)); }
  }
  report.cleanup.follow_stream_cancelled = [...follows].every(follow => follow.cancelled);
  for (const capture of children) {
    try { await stopChild(capture); } catch (error) { failures.push(errorInfo(error)); }
  }
  report.cleanup.owned_godot_children_stopped = [...children].every(capture => capture.exit || capture.error);
  if (connection && godotSessionId && !abort.signal.aborted) {
    try {
      const deadline = Date.now() + 5000;
      let status;
      do { status = await rpc('godot_status'); if (!status.sessions.some(session => session.session_id === godotSessionId)) break; await delay(100); } while (Date.now() < deadline);
      assert.equal(status.sessions.some(session => session.session_id === godotSessionId), false);
      report.cleanup.owned_godot_session_disconnected = true;
      report.cleanup.installed_plugin_still_listening = status.listening === true;
    } catch (error) { failures.push(errorInfo(error)); }
  }
  if (report.cleanup.owned_godot_children_stopped && (!promptSubmitted || turnEnded || report.cleanup.own_model_turn_settled)) {
    try {
      const resolved = await realpath(work), parent = await realpath(process.env.TMPDIR);
      assert.equal(resolved, ownedRealpath, 'Owned temporary directory realpath changed.');
      assert.equal(parent, tmpRoot, 'TMPDIR realpath changed.');
      assert.equal(path.dirname(resolved), parent);
      assert.ok(path.basename(resolved).startsWith('dsh-godot-e2e-'));
      report.cleanup.validated_realpath = resolved;
      await rm(resolved, { recursive: true });
      report.cleanup.owned_project_removed = true;
    } catch (error) { failures.push(errorInfo(error)); }
  }
  report.cleanup.existing_dsh_sessions_preserved = true;
  report.cleanup.verification_dsh_session_retained = dshSessionId || null;
  if (failures.length) { report.cleanup.errors = failures; report.ok = false; process.exitCode = 1; }
  if (interrupted) { report.interrupted = interrupted; report.ok = false; process.exitCode = 1; }
  report.finished_at = new Date().toISOString();
  const finalReport = JSON.stringify(sanitize(report), null, 2) + '\n';
  for (const secret of secrets) if (secret) assert.equal(finalReport.includes(secret), false, 'Report contains authentication material.');
  await writeFile(reportPath, finalReport, { mode: 0o600 });
  const summary = { ok: report.ok, passed_steps: report.steps.length, dsh_session_id: dshSessionId || null, successful_model_tool_calls: report.model_verification?.pairs.length || 0, node: report.ok ? '/Main/DSHVerified' : null, cleanup: report.cleanup, report: reportPath };
  await writeFile(path.join(evidenceRealpath, 'summary.log'), JSON.stringify(sanitize(summary), null, 2) + '\n', { mode: 0o600 });
  log(JSON.stringify(sanitize(summary)));
}
