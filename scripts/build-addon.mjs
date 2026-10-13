import { readFile, readdir, mkdir, writeFile, copyFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'tpr/godot-ai/plugin/addons/godot_ai');
const output = path.join(root, 'godot/addons/dsh_godot');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const original = await readFile(path.join(source, 'plugin.gd'), 'utf8');
const transform = text => text.replaceAll('godot_ai', 'dsh_godot').replace(/\bMcp(?=[A-Z])/g, 'DshGodot').replaceAll('_mcp_game_helper', '_dsh_godot_game_helper').replaceAll('mcp:', 'dsh_godot:');
async function materialize(relative = '') {
  for (const entry of await readdir(path.join(source, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name), target = path.join(output, name);
    if (entry.isDirectory()) { await mkdir(target, { recursive: true }); await materialize(name); }
    else if (!['plugin.gd', 'plugin.cfg'].includes(name) && !entry.name.endsWith('.uid')) {
      if (entry.name.endsWith('.gd')) {
        let content = transform(await readFile(path.join(source, name), 'utf8'));
        if (name === 'connection.gd') content = content.replace('var launch_mode := ClientConfigurator.get_server_launch_mode()', 'var launch_mode := "dsh"');
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
let registration = original.slice(original.indexOf('\tvar undo := get_undo_redo()'), original.indexOf('\n\t_connection.dispatcher = _dispatcher'));
registration = registration.replace(/\n\t_dispatcher\.register_lazy_handler\(\n\t\t"client",[\s\S]*?\n\t\)/, '').replace(/\n\t_dispatcher\.register_lazy\("(?:configure_client|remove_client|check_client_status)"[^\n]*/g, '');
const template = await readFile(path.join(root, 'godot/plugin.gd'), 'utf8');
await writeFile(path.join(output, 'plugin.gd'), template.replace('\t# @REGISTRATION@', transform(registration)));
await writeFile(path.join(output, 'plugin.cfg'), `[plugin]\nname="DSH Godot Control"\ndescription="Native DSH editor tools; no Python or MCP server."\nauthor="oheco; Godot AI contributors"\nversion="${manifest.version}"\nscript="plugin.gd"\n`);
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
