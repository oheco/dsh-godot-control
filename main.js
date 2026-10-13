import { GodotBridge, loadConnection, GodotError } from './server.js';
import { TOOL_SPECS, createOperations, renderResult } from './operations.js';
export const name = 'oheco-godot-control';
export const inject = ['agents'];
export function toolDefinition(spec, execute) {
  const properties = {}, required = [];
  for (const [key, value] of Object.entries(spec.parameters)) { const { required: mandatory, ...schema } = value; properties[key] = schema; if (mandatory) required.push(key); }
  return { name: spec.name, description: spec.description, parameters: { type: 'object', properties, required, additionalProperties: false }, output: { schema: {}, render: renderResult }, async execute(args, exec) { return execute(spec.name, args, exec.signal); } };
}
export function pairingHandler(connection, bridge) {
  return async endpoint => {
    if (endpoint === 'status') return { ok: true, value: bridge.status() };
    if (endpoint === 'pairing') return { ok: true, value: { endpoint: connection.endpoint, port: connection.port, token: connection.token } };
    return { ok: false, error: { code: 'NOT_FOUND', message: 'Unknown Godot pairing endpoint.' } };
  };
}
export async function apply(ctx, config = {}) {
  if (config.port !== undefined && (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535)) throw new GodotError('INVALID_CONFIG', 'port must be from 1024 to 65535.');
  const connection = await loadConnection({ port: config.port });
  const bridge = new GodotBridge({ port: connection.port, token: connection.token });
  bridge.rpc = createOperations(bridge);
  await bridge.start(); ctx.effect(() => () => bridge.close());
  ctx.inject(['connection'], uiCtx => {
    const handler = pairingHandler(connection, bridge);
    for (const endpoint of ['status', 'pairing']) uiCtx.connection.fetch.register({ path: `/api/oheco-godot-control/${endpoint}`, methods: ['POST'], requestBody: 'buffered', async fetch() { return Response.json(await handler(endpoint), { headers: { 'Cache-Control': 'no-store' } }); } });
  });
  const attached = new Map();
  const attach = agent => {
    if (attached.has(agent)) return;
    const dispose = agent.ctx.effect(() => {
      const fiber = agent.ctx.inject(['tools'], toolCtx => { const execute = createOperations(bridge); for (const spec of TOOL_SPECS) toolCtx.effect(() => toolCtx.tools.register(toolDefinition(spec, execute))); });
      return () => fiber.dispose();
    }); attached.set(agent, dispose);
  };
  ctx.effect(() => () => { for (const dispose of attached.values()) dispose(); attached.clear(); });
  ctx.on('agent/created', ({ agent }) => attach(agent));
  ctx.on('agent/disposed', ({ agent }) => { attached.get(agent)?.(); attached.delete(agent); });
  for (const agent of ctx.agents.list()) attach(agent);
}
