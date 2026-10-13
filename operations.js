import { readFile } from 'node:fs/promises';
import { GodotError, object } from './protocol.js';
export const COMMANDS = JSON.parse(await readFile(new URL('./commands.json', import.meta.url), 'utf8'));
const byCommand = new Map(COMMANDS.map(command => [command.command, command]));
const session = { type: 'string', description: 'Godot session_id from godot_status. Required when multiple editors are connected.' };
const params = { type: 'object', additionalProperties: true, description: 'Command parameters. Use godot_commands for parameter hints; node paths look like /Main/Player.' };
const timeout = { type: 'integer', description: 'Operation timeout in milliseconds, from 500 to 120000; default 30000.' };
const domain = (name, description, groups) => ({ name, description, parameters: { command: { type: 'string', required: true, enum: COMMANDS.filter(value => groups.includes(value.group)).map(value => value.command) }, params, session_id: session, timeout_ms: timeout } });
export const TOOL_SPECS = [
  { name: 'godot_status', description: 'List connected Godot editors, project paths, session IDs and readiness. Pair the Godot addon with DSH before using editor tools.', parameters: {} },
  { name: 'godot_commands', description: 'Inspect available Godot commands, parameter hints and readiness requirements. Query one command for details or a group for its operation list.', parameters: { command: { type: 'string', enum: COMMANDS.map(value => value.command) }, group: { type: 'string', enum: [...new Set(COMMANDS.map(value => value.group))] }, offset: { type: 'integer' }, limit: { type: 'integer', description: 'Maximum catalog entries; default 25, at most 50.' } } },
  { name: 'godot_scene_tree', description: 'Read the current scene hierarchy, with node types and paths. Depth defaults to 10 and page size to 100.', parameters: { session_id: session, depth: { type: 'integer' }, offset: { type: 'integer' }, limit: { type: 'integer' } } },
  domain('godot_scene', 'Create, open or save scenes; inspect open scenes and find nodes. Mutations affect the selected Godot editor.', ['scene']),
  domain('godot_node', 'Create and edit nodes, properties, hierarchy, groups and selection with Godot undo support. Use godot_commands for each command\'s parameter names.', ['node']),
  domain('godot_script', 'Read, create, patch and attach GDScript files. File writes persist immediately; attaching a script changes the scene.', ['script']),
  domain('godot_project', 'Inspect and edit project settings, configure the main scene, start or stop the game and search project files.', ['project']),
  domain('godot_editor', 'Read editor state, selection, logs and performance; control game debugging or capture screenshots. Quit and reload commands affect the editor.', ['editor']),
  { name: 'godot_command', description: 'Execute an available Godot editor command for resources, animation, materials, shaders, UI, audio, physics, tiles or other domains. Use godot_commands to inspect its parameters. On timeout or disconnect, inspect scene state before retrying a mutation.', parameters: { command: { type: 'string', required: true, enum: COMMANDS.map(value => value.command) }, params, session_id: session, timeout_ms: timeout } },
];
export function validateToolArgs(name, args) {
  const spec = TOOL_SPECS.find(value => value.name === name);
  if (!spec) throw new GodotError('UNKNOWN_GODOT_TOOL', 'Unknown Godot tool.');
  if (!object(args)) throw new GodotError('INVALID_ARGUMENTS', 'Tool arguments must be an object.');
  for (const key of Object.keys(args)) if (!Object.hasOwn(spec.parameters, key)) throw new GodotError('INVALID_ARGUMENTS', `Unknown argument: ${key}`);
  for (const [key, rule] of Object.entries(spec.parameters)) {
    const value = args[key];
    if (value === undefined) { if (rule.required) throw new GodotError('INVALID_ARGUMENTS', `Missing argument: ${key}`); continue; }
    const valid = rule.type === 'integer' ? Number.isInteger(value) : rule.type === 'object' ? object(value) : typeof value === rule.type;
    if (!valid || (rule.enum && !rule.enum.includes(value))) throw new GodotError('INVALID_ARGUMENTS', `Invalid argument: ${key}`);
  }
  if (args.session_id !== undefined && (args.session_id.length < 1 || args.session_id.length > 128)) throw new GodotError('INVALID_ARGUMENTS', 'session_id must be a nonempty Godot session ID.');
  if (args.timeout_ms !== undefined && (args.timeout_ms < 500 || args.timeout_ms > 120000)) throw new GodotError('INVALID_ARGUMENTS', 'timeout_ms must be from 500 to 120000.');
  for (const key of ['offset', 'depth']) if (args[key] !== undefined && (args[key] < 0 || args[key] > 100000)) throw new GodotError('INVALID_ARGUMENTS', `Invalid ${key}.`);
  const maximum = name === 'godot_commands' ? 50 : 1000;
  if (args.limit !== undefined && (args.limit < 1 || args.limit > maximum)) throw new GodotError('INVALID_ARGUMENTS', `limit must be from 1 to ${maximum}.`);
  if (args.params !== undefined) {
    const visit = (value, depth = 0) => {
      if (depth > 64 || typeof value === 'number' && !Number.isFinite(value) || value === undefined || typeof value === 'function' || typeof value === 'bigint') throw new GodotError('INVALID_ARGUMENTS', 'Command parameters must contain finite JSON values.');
      if (value && typeof value === 'object') for (const item of Object.values(value)) visit(item, depth + 1);
    };
    visit(args.params);
  }
}
export function createOperations(bridge) {
  return async function execute(name, input = {}, signal) {
    validateToolArgs(name, input); signal?.throwIfAborted();
    if (name === 'godot_status') return bridge.status();
    if (name === 'godot_commands') {
      const selected = COMMANDS.filter(value => (!input.command || value.command === input.command) && (!input.group || value.group === input.group));
      const offset = input.offset ?? 0, limit = input.limit ?? 25;
      return { commands: selected.slice(offset, offset + limit), groups: [...new Set(COMMANDS.map(value => value.group))], total_count: selected.length, offset, has_more: offset + limit < selected.length, node_value_format: 'Vector properties use component objects, e.g. {"x":1,"y":2,"z":3}; colors use {"r":1,"g":0,"b":0,"a":1}. Parameter hints name fields; constraints are enforced by the editor handler.' };
    }
    const command = name === 'godot_scene_tree' ? 'get_scene_tree' : input.command;
    const parameters = name === 'godot_scene_tree' ? { depth: input.depth ?? 10, offset: input.offset ?? 0, limit: input.limit ?? 100 } : input.params ?? {};
    const spec = byCommand.get(command);
    const entry = bridge.resolveSession(input.session_id), sessionId = entry.identity.session_id;
    const requestOptions = { sessionId, signal, timeout: input.timeout_ms ?? 30000 };
    if (!spec.read_only) {
      const state = await bridge.request('get_editor_state', {}, requestOptions);
      const readiness = state.readiness;
      if (!(readiness === 'ready' || readiness === 'playing' && spec.allow_playing || readiness === 'no_scene' && spec.allow_no_scene)) throw new GodotError('EDITOR_NOT_READY', `Godot editor is ${readiness}; ${command} cannot run now.`, { readiness, retryable: readiness === 'importing' });
    }
    return bridge.request(command, parameters, requestOptions);
  };
}
export function renderResult(_args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }]; }
