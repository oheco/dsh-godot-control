import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WebSocketServer } from './tpr/ws/wrapper.mjs';
import { GodotError, SERVER_VERSION, MAX_MESSAGE_BYTES, MAX_HANDSHAKE_BYTES, READINESS, hex64, object, text, equalProof, parseMessage, validHello, validIdentity, serverProof, clientProof } from './protocol.js';

export { GodotError } from './protocol.js';
export const DEFAULT_PORT = 9500;
export function connectionDirectory() {
  if (process.platform === 'openharmony' && !process.env.XDG_CONFIG_HOME) throw new GodotError('PRIVATE_CONFIG_REQUIRED', 'Set XDG_CONFIG_HOME to application-private storage.');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'dsh-godot-control');
}
export async function loadConnection({ directory = connectionDirectory(), port } = {}) {
  if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535)) throw new GodotError('INVALID_CONFIG', 'port must be an integer from 1024 to 65535.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await stat(directory)).mode & 0o077) throw new GodotError('UNSAFE_CONFIG_DIRECTORY', 'Godot pairing requires private storage with mode 0700.');
  const file = path.join(directory, 'connection.json');
  let config;
  try { config = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    config = { version: 1, port: port ?? DEFAULT_PORT, token: randomBytes(32).toString('hex') };
    try { await writeFile(file, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; config = JSON.parse(await readFile(file, 'utf8')); }
  }
  if ((await stat(file)).mode & 0o077) throw new GodotError('UNSAFE_CONFIG_FILE', 'Godot pairing file must have mode 0600.');
  if (config.version !== 1 || !hex64(config.token) || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new GodotError('INVALID_CONFIG', 'Invalid saved Godot pairing configuration.');
  if (port !== undefined && port !== config.port) throw new GodotError('PORT_CONFIG_MISMATCH', 'Update the saved pairing port and Godot settings together.');
  return { ...config, file, endpoint: `ws://127.0.0.1:${config.port}` };
}
export class GodotBridge {
  constructor({ port = DEFAULT_PORT, token, requestTimeout = 30000, maxConnections = 32, onState = () => {}, rpc } = {}) {
    if (!hex64(token)) throw new GodotError('TOKEN_REQUIRED', 'A 64-character Godot pairing token is required.');
    Object.assign(this, { port, token, requestTimeout, maxConnections, onState, rpc });
    this.sessions = new Map(); this.pending = new Map(); this.closed = false;
  }
  status() {
    return { protocol_version: 2, server_version: SERVER_VERSION, listening: !!this.server?.listening, endpoint: `ws://127.0.0.1:${this.port}`, connected: [...this.sessions.values()].some(entry => entry.ready), sessions: [...this.sessions.values()].filter(entry => entry.ready).map(entry => ({ ...entry.identity, connected_at: entry.connectedAt, last_seen: entry.lastSeen })), pending_requests: this.pending.size };
  }
  emitState() { this.onState(this.status()); }
  async start() {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false, maxFragments: 1024 });
    this.server = http.createServer((req, res) => this.http(req, res).catch(error => {
      if (!res.headersSent) { res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ ok: false, error: { code: error.code || 'HTTP_ERROR', message: error.message } })); }
      else res.destroy();
    }));
    this.server.on('upgrade', (req, socket, head) => {
      if (!['/', ''].includes(req.url) || req.headers.origin || this.wss.clients.size >= this.maxConnections) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
      this.wss.handleUpgrade(req, socket, head, ws => this.accept(ws));
    });
    try { await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.port, '127.0.0.1', resolve); }); }
    catch (error) { this.wss.close(); throw error; }
    this.port = this.server.address().port;
    this.heartbeat = setInterval(() => {
      for (const entry of this.sessions.values()) {
        if (Date.now() - entry.lastSeen > 60000) entry.peer.terminate();
        else if (entry.peer.readyState === 1) entry.peer.ping();
      }
    }, 20000); this.heartbeat.unref();
    this.emitState(); return this;
  }
  accept(peer) {
    let phase = 'hello', clientNonce = '', serverNonce = '', entry = null;
    const timer = setTimeout(() => peer.close(4003, 'Authentication timeout'), 5000); timer.unref();
    peer.on('error', () => {});
    peer.on('pong', () => { if (entry?.ready) entry.lastSeen = Date.now(); });
    peer.on('message', (raw, binary) => {
      let message;
      try { if (binary) throw new Error('Text frames required'); message = parseMessage(raw, phase === 'ready' ? MAX_MESSAGE_BYTES : MAX_HANDSHAKE_BYTES); }
      catch { if (phase !== 'ready') peer.close(4002, 'Invalid authentication message'); return; }
      if (phase === 'hello') {
        if (!validHello(message)) { peer.close(4002, 'Protocol 2 auth_hello required'); return; }
        clientNonce = message.client_nonce; serverNonce = randomBytes(32).toString('hex'); phase = 'response';
        peer.send(JSON.stringify({ type: 'auth_challenge', protocol_version: 2, client_nonce: clientNonce, server_nonce: serverNonce, server_version: SERVER_VERSION, server_proof: serverProof(this.token, clientNonce, serverNonce) })); return;
      }
      if (phase === 'response') {
        if (!validIdentity(message) || message.client_nonce !== clientNonce || message.server_nonce !== serverNonce || !equalProof(message.client_proof, clientProof(this.token, message))) { peer.close(4003, 'Editor authentication failed'); return; }
        if (this.sessions.has(message.session_id)) { peer.close(4001, 'Session already registered'); return; }
        const identity = Object.fromEntries(['session_id', 'godot_version', 'project_path', 'plugin_version', 'readiness', 'editor_pid', 'server_launch_mode'].map(key => [key, message[key]]));
        entry = { peer, identity, ready: false, connectedAt: new Date().toISOString(), lastSeen: Date.now() };
        this.sessions.set(identity.session_id, entry); phase = 'ack';
        peer.send(JSON.stringify({ type: 'handshake_ack', protocol_version: 2, server_version: SERVER_VERSION }), error => {
          if (error || peer.readyState !== 1 || this.sessions.get(identity.session_id) !== entry) { peer.terminate(); return; }
          clearTimeout(timer); entry.ready = true; phase = 'ready'; this.emitState();
        }); return;
      }
      if (phase !== 'ready') { peer.close(4002, 'Authentication ACK pending'); return; }
      entry.lastSeen = Date.now();
      if (message.type === 'event') { this.event(entry, message); return; }
      const pending = this.pending.get(message.request_id);
      if (!pending || pending.entry !== entry || pending.peer !== peer) return;
      this.pending.delete(message.request_id); pending.cleanup();
      if (!['ok', 'error'].includes(message.status) || !READINESS.includes(message.readiness) || (message.status === 'ok' && !object(message.data)) || (message.status === 'error' && (!object(message.error) || !text(message.error.code, 128) || !text(message.error.message, 16384)))) { pending.reject(new GodotError('INVALID_RESPONSE', 'Godot returned an invalid command response.')); return; }
      entry.identity.readiness = message.readiness;
      if (message.status === 'ok') pending.resolve(message.data);
      else pending.reject(new GodotError(message.error.code, message.error.message, object(message.error.data) ? message.error.data : {}));
    });
    peer.on('close', () => {
      clearTimeout(timer);
      if (!entry || this.sessions.get(entry.identity.session_id) !== entry) return;
      this.sessions.delete(entry.identity.session_id);
      for (const [id, pending] of this.pending) if (pending.entry === entry) { this.pending.delete(id); pending.cleanup(); pending.reject(new GodotError('CONNECTION_LOST', 'Godot disconnected. The operation may already have executed; inspect the scene before retrying.')); }
      this.emitState();
    });
  }
  event(entry, message) {
    if (!object(message.data)) return;
    const fields = { scene_changed: ['current_scene', value => typeof value === 'string' && value.length <= 4096], readiness_changed: ['readiness', value => READINESS.includes(value)], play_state_changed: ['play_state', value => ['stopped', 'playing'].includes(value)] };
    const rule = Object.hasOwn(fields, message.event) && fields[message.event];
    if (!rule || !rule[1](message.data[rule[0]])) return;
    entry.identity[rule[0]] = message.data[rule[0]]; this.emitState();
  }
  resolveSession(sessionId) {
    if (!sessionId) throw new GodotError('SESSION_REQUIRED', 'Use godot_status and explicitly pass session_id for every editor operation, even when only one editor is connected.');
    const entry = this.sessions.get(sessionId);
    if (!entry?.ready) throw new GodotError('SESSION_NOT_FOUND', 'The selected Godot editor is not connected. Use godot_status to refresh its session_id.');
    return entry;
  }
  request(command, params = {}, { sessionId, signal, timeout = this.requestTimeout } = {}) {
    if (signal?.aborted) return Promise.reject(new GodotError('CANCELLED', 'Godot operation cancelled before dispatch.'));
    let entry;
    try { entry = this.resolveSession(sessionId); } catch (error) { return Promise.reject(error); }
    const peer = entry.peer, requestId = randomUUID().replaceAll('-', '');
    if (peer.readyState !== 1) return Promise.reject(new GodotError('GODOT_OFFLINE', 'Godot editor is disconnected.'));
    if (this.pending.size >= 128) return Promise.reject(new GodotError('TOO_MANY_REQUESTS', 'Wait for pending Godot operations to finish.'));
    const payload = JSON.stringify({ request_id: requestId, command, params });
    if (Buffer.byteLength(payload) > MAX_MESSAGE_BYTES) return Promise.reject(new GodotError('REQUEST_TOO_LARGE', 'Godot request exceeds 4 MiB.'));
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      const cancel = (code, message) => { if (!this.pending.delete(requestId)) return; cleanup(); reject(new GodotError(code, message)); };
      const abort = () => cancel('CANCELLED', 'Godot operation cancelled; it may already have executed. Inspect scene state before retrying.');
      const timer = setTimeout(() => cancel('GODOT_TIMEOUT', 'Godot operation timed out; it may already have executed. Inspect scene state before retrying.'), timeout);
      this.pending.set(requestId, { entry, peer, resolve, reject, cleanup });
      signal?.addEventListener('abort', abort, { once: true });
      peer.send(payload, error => { if (error) cancel('SEND_FAILED', 'Unable to send Godot command.'); });
    });
  }
  async http(req, res) {
    if (![`127.0.0.1:${this.port}`, `localhost:${this.port}`].includes(req.headers.host)) { res.writeHead(403); res.end(); return; }
    if (req.url !== '/rpc' || req.method !== 'POST' || req.headers.origin || !equalProof(req.headers.authorization?.replace(/^Bearer /, ''), this.token) || !this.rpc) { res.writeHead(403); res.end(); return; }
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 1024 * 1024) throw new GodotError('REQUEST_TOO_LARGE', 'RPC request exceeds 1 MiB.'); chunks.push(chunk); }
    const request = parseMessage(Buffer.concat(chunks), 1024 * 1024);
    const controller = new AbortController(); res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    const value = await this.rpc(request.tool, request.args || {}, controller.signal);
    const payload = JSON.stringify({ ok: true, value });
    if (Buffer.byteLength(payload) > MAX_MESSAGE_BYTES) throw new GodotError('RESULT_TOO_LARGE', 'Godot result exceeds 4 MiB.');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(payload);
  }
  async close() {
    if (this.closed) return;
    this.closed = true; clearInterval(this.heartbeat);
    for (const peer of this.wss?.clients || []) peer.terminate();
    if (this.server) { this.server.closeAllConnections(); await new Promise(resolve => this.server.close(resolve)); }
    if (this.wss) await new Promise(resolve => this.wss.close(resolve));
  }
}
