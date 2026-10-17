import { readFile, readdir, mkdir, writeFile, copyFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'tpr/godot-ai/plugin/addons/godot_ai');
const output = path.join(root, 'godot/addons/dsh_godot');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const original = await readFile(path.join(source, 'plugin.gd'), 'utf8');
// Adapt display text without renaming upstream protocol/configuration identifiers.
const transform = text => text.replaceAll('godot_ai', 'dsh_godot').replace(/\bMcp(?=[A-Z])/g, 'DshGodot').replaceAll('_mcp_game_helper', '_dsh_godot_game_helper').replaceAll('mcp:', 'dsh_godot:').replaceAll('CAPTURE_PREFIX := "mcp"', 'CAPTURE_PREFIX := "dsh_godot"').replaceAll('"mcp" capture', '"dsh_godot" capture')
  .replaceAll('MCP |', 'DSH Godot |').replaceAll('MCP:', 'DSH Godot:').replaceAll('MCP debugger:', 'DSH Godot | debugger:')
  .replaceAll('[dsh_godot game_helper] registered mcp capture', 'DSH Godot | game helper registered debugger capture')
  .replaceAll('the MCP transport was paused', 'the DSH transport was paused');
function replaceRequired(content, before, after) {
  if (content.split(before).length !== 2) throw new Error(`Upstream adaptation anchor changed: ${before}`);
  return content.replace(before, after);
}
function adaptConnection(content) {
  for (const [before, after] of [
    ['var launch_mode := ClientConfigurator.get_server_launch_mode()', 'var launch_mode := "dsh"'],
    ['"connected to server; authenticating"', '"connected to DSH; authenticating"'],
    ['"authenticated with server"', '"authenticated with DSH (session %s, PID %d)" % [_session_id, OS.get_process_id()]'],
    ['"connecting to server (attempt %d)"', '"connecting to DSH (attempt %d)"'],
    ['"v4 editor handshake timed out"', '"DSH editor handshake timed out"'],
    ['"v4 websocket handshake failed: %s"', '"websocket handshake with DSH failed: %s"'],
    ['The editor and server use different Godot AI major protocols; update/restart both sides.', 'The editor and DSH use different connection protocols; update the DSH plugin and project addon together.'],
    ['The v4 editor capability was rejected; restart the managed server from this Godot editor.', 'DSH rejected authentication. Check the port and pairing token against the DSH Godot pairing panel.'],
    ['The v4 handshake closed before authentication; update/restart both editor and server.', 'The connection to DSH closed before authentication. Check the DSH service and this project\'s pairing.'],
    ['\treturn snapshot\n\n\nfunc _log_blocked_notice_once()', '\tif snapshot.phase == "retrying" and not snapshot.has("reason"):\n\t\tsnapshot["reason_code"] = "dsh_unreachable"\n\t\tsnapshot["reason"] = "Cannot reach DSH. Check that DSH Godot Control is enabled and the pairing port matches."\n\tsnapshot["endpoint"] = "ws://127.0.0.1:%d" % ws_port\n\tsnapshot["editor_pid"] = OS.get_process_id()\n\tsnapshot["session_id"] = _session_id\n\treturn snapshot\n\n\nfunc _log_blocked_notice_once()'],
    ['\tif code == CLOSE_CODE_PROTOCOL_MISMATCH:\n\t\treturn {', '\tif code == CLOSE_CODE_DUPLICATE_SESSION:\n\t\treturn {\n\t\t\t"reason_code": "duplicate_session",\n\t\t\t"reason": "This session ID is already connected to DSH; retrying with a new ID.",\n\t\t}\n\tif code == CLOSE_CODE_PROTOCOL_MISMATCH:\n\t\treturn {'],
  ]) content = replaceRequired(content, before, after);
  return content;
}
function adaptFilesystem(content) {
  content = content.replace('`write_file`/`reimport` register single', '`write_file` registers single').replace('used by write_file/reimport/script_create', 'used by write_file/script_create');
  const start = content.indexOf('func reimport(params: Dictionary) -> Dictionary:');
  const end = content.indexOf('## Force a full EditorFileSystem scan', start);
  if (start < 0 || end < start) throw new Error('Upstream reimport boundaries changed; review the adaptation.');
  content = content.slice(0, start) + 'func reimport(params: Dictionary) -> Dictionary:\n\treturn preload("res://addons/dsh_godot/utils/resource_reimport.gd").run(params)\n\n\n' + content.slice(end);
  const scan = content.indexOf('func scan_filesystem(');
  const guard = '\n\tif efs.is_importing():\n\t\treturn ErrorCodes.make_not_ready(ErrorCodes.SUB_EDITOR_IMPORTING, "Wait for resource import before scanning", true)\n';
  return content.slice(0, scan) + content.slice(scan).replace('\n\tvar request_id:', guard + '\n\tvar request_id:');
}
async function materialize(relative = '') {
  for (const entry of await readdir(path.join(source, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name), target = path.join(output, name);
    if (entry.isDirectory()) { await mkdir(target, { recursive: true }); await materialize(name); }
    else if (!['plugin.gd', 'plugin.cfg'].includes(name) && !entry.name.endsWith('.uid')) {
      if (entry.name.endsWith('.gd')) {
        let content = transform(await readFile(path.join(source, name), 'utf8'));
        if (name === 'connection.gd') content = adaptConnection(content);
        if (name === 'handlers/filesystem_handler.gd') content = adaptFilesystem(content);
        await writeFile(target, content);
      } else await copyFile(path.join(source, name), target);
    }
  }
}
let existing;
try { existing = await realpath(output); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (existing) {
  if (existing !== output || path.relative(root, existing) !== 'godot/addons/dsh_godot') throw new Error('Refusing to replace an unexpected generated addon directory.');
  console.log(`Regenerating verified addon directory: ${existing}`);
  await rm(existing, { recursive: true });
}
await mkdir(output, { recursive: true }); await materialize();
await copyFile(path.join(root, 'godot/resource_reimport.gd'), path.join(output, 'utils/resource_reimport.gd'));
let registration = original.slice(original.indexOf('\tvar undo := get_undo_redo()'), original.indexOf('\n\t_connection.dispatcher = _dispatcher'));
registration = registration.replace(/\n\t_dispatcher\.register_lazy_handler\(\n\t\t"client",[\s\S]*?\n\t\)/, '').replace(/\n\t_dispatcher\.register_lazy\("(?:configure_client|remove_client|check_client_status)"[^\n]*/g, '');
const template = await readFile(path.join(root, 'godot/plugin.gd'), 'utf8');
await writeFile(path.join(output, 'plugin.gd'), template.replace('\t# @REGISTRATION@', transform(registration)));
await writeFile(path.join(output, 'plugin.cfg'), `[plugin]\nname="DSH Godot Control"\ndescription="Connect this Godot editor to DSH for editor and runtime tools."\nauthor="oheco; Godot AI contributors"\nversion="${manifest.version}"\nscript="plugin.gd"\n`);
await copyFile(path.join(root, 'tpr/godot-ai/LICENSE'), path.join(output, 'LICENSE.godot-ai'));
const commands = [];
const readers = new Set(['load_resource', 'shader_validate', 'animation_validate', 'visual_shader_node_catalog', 'visual_shader_get', 'material_get', 'material_list', 'particle_get', 'camera_get', 'camera_list', 'audio_list', 'tilemap_get_cells', 'tileset_get_atlas_tiles', 'tileset_get_atlas_image', 'gridmap_get_used_cells', 'gridmap_list_library_items', 'navigation_path_get', 'animation_list', 'animation_get']);
const whilePlaying = new Set(['stop_project', 'game_eval', 'game_command', 'game_debug_control', 'take_screenshot', 'get_performance_monitors', 'clear_logs', 'quit_editor']);
const withoutScene = new Set(['create_scene', 'open_scene', 'create_script', 'patch_script', 'write_file', 'move_file', 'rename_file', 'remove_file', 'scan_filesystem', 'reimport', 'set_project_setting', 'set_main_scene', 'add_autoload', 'remove_autoload', 'add_action', 'ensure_action', 'remove_action', 'bind_event', 'ensure_binding', 'quit_editor', 'reload_plugin']);
for (const match of registration.matchAll(/register_lazy\("([^"]+)", "([^"]+)", &"([^"]+)"\)/g)) {
  const [, command, group, method] = match;
  const handler = await readFile(path.join(source, 'handlers', `${group}_handler.gd`), 'utf8');
  const start = handler.indexOf(`func ${method}(`), next = handler.indexOf('\nfunc ', start + 1);
  const body = handler.slice(start, next < 0 ? handler.length : next);
  const hints = [...new Set([...body.matchAll(/params(?:\.get\(|\[)"([^"]+)"/g)].map(match => match[1]))];
  if (group === 'node' && method !== 'create_node' && !hints.includes('path')) hints.unshift('path');
  commands.push({ command, group, method, parameter_hints: hints, read_only: /^(get_|find_|search_|list_|read_|inspect_)/.test(command) || readers.has(command), allow_playing: whilePlaying.has(command), allow_no_scene: withoutScene.has(command) });
}
await writeFile(path.join(root, 'commands.json'), JSON.stringify(commands, null, 2) + '\n');
console.log(`Built ${commands.length} editor commands from Godot AI v4.3.0.`);
