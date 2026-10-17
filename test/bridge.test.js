import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { GodotBridge } from '../server.js';
import { WebSocket } from '../tpr/ws/wrapper.mjs';
import { clientProof, parseMessage } from '../protocol.js';
import { createOperations, TOOL_SPECS } from '../operations.js';
import { toolDefinition } from '../main.js';
const token = 'a'.repeat(64), fixtureSessionId = 'fixture@0123456789abcdef';
const fixtureRoute = { sessionId: fixtureSessionId };
async function connect(bridge, { secret = token, sessionId = 'fixture@0123456789abcdef', readiness = 'ready' } = {}) {
  const peer = new WebSocket(`ws://127.0.0.1:${bridge.port}`), nonce = randomBytes(32).toString('hex');
  const ready = new Promise((resolve, reject) => {
    peer.on('message', raw => {
      const msg = JSON.parse(raw);
      if (msg.type === 'auth_challenge') {
        const response = { type: 'auth_response', protocol_version: 2, client_nonce: nonce, server_nonce: msg.server_nonce, session_id: sessionId, godot_version: '4.7.2-stable (custom_build)', project_path: '/fixture', plugin_version: '0.1.0', readiness, editor_pid: 1, server_launch_mode: 'dsh' };
        response.client_proof = clientProof(secret, response, msg.server_version); peer.send(JSON.stringify(response));
      } else if (msg.type === 'handshake_ack') resolve(peer);
    });
    peer.once('close', code => reject(Object.assign(new Error('Handshake rejected'), { code })));
    peer.once('error', reject);
  });
  await once(peer, 'open'); peer.send(JSON.stringify({ type: 'auth_hello', protocol_version: 2, client_nonce: nonce }));
  return ready;
}
async function setup(t) { const bridge = new GodotBridge({ port: 0, token }); await bridge.start(); t.after(() => bridge.close()); return bridge; }
test('strict JSON rejects duplicate escaped keys and permits nested repeated names', () => {
  assert.throws(() => parseMessage(Buffer.from('{"a":1,"\\u0061":2}')), { code: 'INVALID_MESSAGE' });
  assert.throws(() => parseMessage(Buffer.from('{"a":{"x":1,"x":2}}')), { code: 'INVALID_MESSAGE' });
  assert.deepEqual(parseMessage(Buffer.from('{"a":{"x":1},"b":{"x":2},"text":"{\\\"x\\\":1}"}')).b, { x: 2 });
  assert.throws(() => parseMessage(Buffer.from('{"value":NaN}')));
  assert.throws(() => parseMessage(Buffer.from('{}'), 1), { code: 'MESSAGE_TOO_LARGE' });
});
test('authenticated requests preserve IDs and statuses omit secrets', async t => {
  const bridge = await setup(t), peer = await connect(bridge);
  peer.on('message', raw => { const message = JSON.parse(raw); if (message.command) peer.send(JSON.stringify({ request_id: message.request_id, status: 'ok', data: { command: message.command }, readiness: 'ready' })); });
  assert.deepEqual(await bridge.request('get_editor_state', {}, fixtureRoute), { command: 'get_editor_state' });
  assert.equal(bridge.status().sessions[0].session_id, 'fixture@0123456789abcdef');
  assert.ok(!JSON.stringify(bridge.status()).includes(token)); assert.equal(bridge.pending.size, 0);
});
test('every editor tool requires an explicit session with zero, one or multiple editors', async t => {
  const bridge = await setup(t), execute = createOperations(bridge), received = [];
  const editorTools = TOOL_SPECS.filter(spec => !['godot_status', 'godot_commands'].includes(spec.name));
  const rejectImplicit = async () => {
    assert.throws(() => bridge.resolveSession(), { code: 'SESSION_REQUIRED' });
    await assert.rejects(bridge.request('get_scene_tree'), { code: 'SESSION_REQUIRED' });
    for (const spec of editorTools) {
      const args = spec.parameters.command ? { command: spec.parameters.command.enum[0] } : {};
      assert.ok(toolDefinition(spec).parameters.required.includes('session_id'), spec.name);
      await assert.rejects(execute(spec.name, args), { code: 'SESSION_REQUIRED' });
      await assert.rejects(execute(spec.name, { ...args, session_id: '' }), { code: 'INVALID_ARGUMENTS' });
      await assert.rejects(execute(spec.name, { ...args, session_id: 'missing@0123456789abcdef' }), { code: 'SESSION_NOT_FOUND' });
    }
    assert.equal(bridge.pending.size, 0);
    assert.deepEqual(received, [], 'Rejected calls must never dispatch to any editor');
    assert.ok(Array.isArray((await execute('godot_status')).sessions));
    assert.ok((await execute('godot_commands')).total_count > 0);
  };
  await rejectImplicit();
  const first = await connect(bridge);
  first.on('message', raw => { if (JSON.parse(raw).command) received.push('first'); });
  await rejectImplicit();
  const second = await connect(bridge, { sessionId: 'second@0123456789abcdef' });
  second.on('message', raw => { if (JSON.parse(raw).command) received.push('second'); });
  await rejectImplicit();
  const disconnected = once(second, 'close'); second.close(); await disconnected;
  await rejectImplicit();
});
test('wrong tokens, protocol downgrade and duplicate sessions fail closed', async t => {
  const bridge = await setup(t);
  await assert.rejects(connect(bridge, { secret: 'b'.repeat(64) }), { code: 4003 });
  await connect(bridge); await assert.rejects(connect(bridge), { code: 4001 });
  const legacy = new WebSocket(`ws://127.0.0.1:${bridge.port}`); await once(legacy, 'open');
  const closed = once(legacy, 'close'); legacy.send(JSON.stringify({ type: 'handshake', protocol_version: 1 })); assert.equal((await closed)[0], 4002);
});
test('multiple editors require explicit routing and cannot settle each other\'s requests', async t => {
  const bridge = await setup(t), first = await connect(bridge), second = await connect(bridge, { sessionId: 'other@0123456789abcdef' });
  await assert.rejects(bridge.request('get_scene_tree'), { code: 'SESSION_REQUIRED' });
  first.on('message', raw => {
    const message = JSON.parse(raw); if (!message.command) return;
    second.send(JSON.stringify({ request_id: message.request_id, status: 'ok', data: { wrong: true }, readiness: 'playing' }));
    setTimeout(() => first.send(JSON.stringify({ request_id: message.request_id, status: 'ok', data: { correct: true }, readiness: 'ready' })), 20);
  });
  assert.deepEqual(await bridge.request('get_scene_tree', {}, { sessionId: 'fixture@0123456789abcdef' }), { correct: true });
  assert.equal(bridge.status().sessions.find(value => value.session_id.startsWith('other')).readiness, 'ready');
});
test('disconnect and cancellation settle pending work without replay', async t => {
  const bridge = await setup(t), peer = await connect(bridge);
  const received = once(peer, 'message'), pending = bridge.request('create_node', {}, fixtureRoute); await received;
  peer.close(); await assert.rejects(pending, { code: 'CONNECTION_LOST' }); assert.equal(bridge.pending.size, 0);
  const replacement = await connect(bridge), controller = new AbortController();
  const request = bridge.request('create_node', {}, { ...fixtureRoute, signal: controller.signal }); controller.abort();
  await assert.rejects(request, { code: 'CANCELLED' }); assert.equal(bridge.pending.size, 0);
  replacement.close();
});
test('write tools probe live readiness and refuse importing without dispatching mutation', async t => {
  const bridge = await setup(t), peer = await connect(bridge), sent = [];
  peer.on('message', raw => { const message = JSON.parse(raw); if (!message.command) return; sent.push(message.command); peer.send(JSON.stringify({ request_id: message.request_id, status: 'ok', data: { readiness: 'importing' }, readiness: 'importing' })); });
  const execute = createOperations(bridge);
  await assert.rejects(execute('godot_node', { session_id: fixtureSessionId, command: 'create_node', params: { type: 'Node3D' } }), { code: 'EDITOR_NOT_READY' });
  assert.deepEqual(sent, ['get_editor_state']);
  await assert.rejects(execute('godot_command', { command: 'configure_client' }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(execute('godot_node', { session_id: fixtureSessionId, command: 'create_node', params: { value: Infinity } }), { code: 'INVALID_ARGUMENTS' });
});
test('malformed response fails the reserved request immediately', async t => {
  const bridge = await setup(t), peer = await connect(bridge);
  peer.on('message', raw => { const message = JSON.parse(raw); if (message.command) peer.send(JSON.stringify({ request_id: message.request_id, status: 'ok', data: [], readiness: 'ready' })); });
  await assert.rejects(bridge.request('get_scene_tree', {}, fixtureRoute), { code: 'INVALID_RESPONSE' }); assert.equal(bridge.pending.size, 0);
});
