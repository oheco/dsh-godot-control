import { createHmac, timingSafeEqual } from 'node:crypto';

export const PROTOCOL_VERSION = 2;
export const SERVER_VERSION = '0.1.1';
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
export const MAX_HANDSHAKE_BYTES = 8192;
export const READINESS = ['ready', 'importing', 'playing', 'no_scene'];
export class GodotError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'GodotError'; this.code = code; this.details = details; }
}
export const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
export function equalProof(left, right) {
  if (!hex64(left) || !hex64(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'ascii'), Buffer.from(right, 'ascii'));
}
export function proof(token, domain, values) {
  const chunks = [Buffer.from(domain, 'ascii')];
  for (const value of values) { const bytes = Buffer.from(String(value), 'utf8'); chunks.push(Buffer.from(`\n${bytes.length}:`, 'ascii'), bytes); }
  return createHmac('sha256', Buffer.from(token, 'ascii')).update(Buffer.concat(chunks)).digest('hex');
}
export function serverProof(token, clientNonce, serverNonce, version = SERVER_VERSION) {
  return proof(token, 'godot-ai-ws-v2/server-proof', [2, clientNonce, serverNonce, version]);
}
export function clientProof(token, hello, version = SERVER_VERSION) {
  return proof(token, 'godot-ai-ws-v2/client-proof', [2, hello.client_nonce, hello.server_nonce, version, hello.session_id, hello.godot_version, hello.project_path, hello.plugin_version, hello.readiness, hello.editor_pid, hello.server_launch_mode]);
}
export function exactKeys(value, keys) { return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
export function validHello(value) {
  return exactKeys(value, ['type', 'protocol_version', 'client_nonce']) && value.type === 'auth_hello' && value.protocol_version === 2 && hex64(value.client_nonce);
}
export function validIdentity(value) {
  return exactKeys(value, ['type', 'protocol_version', 'client_nonce', 'server_nonce', 'client_proof', 'session_id', 'godot_version', 'project_path', 'plugin_version', 'readiness', 'editor_pid', 'server_launch_mode']) && value.type === 'auth_response' && value.protocol_version === 2 && hex64(value.client_nonce) && hex64(value.server_nonce) && hex64(value.client_proof) && text(value.session_id, 128) && /^[A-Za-z0-9._@-]+$/.test(value.session_id) && text(value.godot_version, 64) && /^4[.-](?:[7-9]|[1-9][0-9]+)(?:[.\-]|$)/.test(value.godot_version) && text(value.project_path, 4096) && text(value.plugin_version, 64) && READINESS.includes(value.readiness) && Number.isSafeInteger(value.editor_pid) && value.editor_pid >= 0 && text(value.server_launch_mode, 32) && /^[A-Za-z0-9._+-]+$/.test(value.server_launch_mode);
}
/** Reject duplicate keys before a parsed object crosses the WebSocket boundary. */
export function parseMessage(raw, maximum = MAX_MESSAGE_BYTES) {
  if (Buffer.byteLength(raw) > maximum) throw new GodotError('MESSAGE_TOO_LARGE', 'Godot message exceeds its byte limit.');
  const source = raw.toString('utf8'), value = JSON.parse(source);
  if (!object(value)) throw new GodotError('INVALID_MESSAGE', 'Godot messages must be JSON objects.');
  const stack = [];
  // JSON.parse validates syntax; this lexer visits strings and containers to detect duplicate property names.
  const tokens = /"(?:[^"\\]|\\.)*"|[{}\[\]]/g;
  for (const match of source.matchAll(tokens)) {
    const token = match[0];
    if (token === '{' || token === '[') {
      if (stack.length >= 64) throw new GodotError('INVALID_MESSAGE', 'JSON nesting exceeds 64 levels.');
      stack.push(token === '{' ? new Set() : null);
    } else if (token === '}' || token === ']') stack.pop();
    else if (source.slice(match.index + token.length).match(/^\s*:/)) {
      const keys = stack.at(-1), key = JSON.parse(token);
      if (!keys || keys.has(key)) throw new GodotError('INVALID_MESSAGE', 'Duplicate JSON property.');
      keys.add(key);
    }
  }
  return value;
}
