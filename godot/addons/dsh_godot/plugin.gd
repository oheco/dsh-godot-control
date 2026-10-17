@tool
extends EditorPlugin

const Connection := preload("res://addons/dsh_godot/connection.gd")
const Dispatcher := preload("res://addons/dsh_godot/dispatcher.gd")
const LogBuffer := preload("res://addons/dsh_godot/utils/log_buffer.gd")
const GameLogBuffer := preload("res://addons/dsh_godot/utils/game_log_buffer.gd")
const EditorLogBuffer := preload("res://addons/dsh_godot/utils/editor_log_buffer.gd")
const SurfacedErrorTracker := preload("res://addons/dsh_godot/utils/surfaced_error_tracker.gd")
const EditorLogger := preload("res://addons/dsh_godot/runtime/editor_logger.gd")
const DebuggerPlugin := preload("res://addons/dsh_godot/debugger/mcp_debugger_plugin.gd")
const VisionRoutingScript := preload("res://addons/dsh_godot/vision_routing.gd")
const ExportPlugin := preload("res://addons/dsh_godot/export/mcp_export_plugin.gd")
const HANDLERS_DIR := "res://addons/dsh_godot/handlers/"
const GAME_HELPER_AUTOLOAD_NAME := "_dsh_godot_game_helper"
const GAME_HELPER_AUTOLOAD_PATH := "res://addons/dsh_godot/runtime/game_helper.gd"

var _connection
var _dispatcher
var _log_buffer
var _game_log_buffer
var _editor_log_buffer
var _surfaced_error_tracker
var _editor_logger: Logger
var _debugger_plugin
var _vision_routing
var _export_plugin
var _dock: VBoxContainer
var _port_input: SpinBox
var _token_input: LineEdit
var _status_label: Label
var _refresh_elapsed := 0.0
var _pairing_stamp := ""

func _enter_tree() -> void:
	var version := Engine.get_version_info()
	if int(version.major) != 4 or int(version.minor) < 7:
		push_error("DSH Godot requires Godot 4.7 or newer within 4.x.")
		return
	# Export cleanup must also run when the interactive bridge is disabled.
	_export_plugin = ExportPlugin.new()
	add_export_plugin(_export_plugin)
	if DisplayServer.get_name() == "headless" and OS.get_environment("DSH_GODOT_ALLOW_HEADLESS") != "1":
		return
	_log_buffer = LogBuffer.new()
	_game_log_buffer = GameLogBuffer.new()
	_editor_log_buffer = EditorLogBuffer.new()
	_surfaced_error_tracker = SurfacedErrorTracker.new(_editor_log_buffer, _game_log_buffer)
	_editor_logger = EditorLogger.new(_editor_log_buffer)
	OS.add_logger(_editor_logger)
	_dispatcher = Dispatcher.new(_log_buffer, _surfaced_error_tracker)
	_connection = Connection.new()
	_connection.log_buffer = _log_buffer
	_connection.surfaced_error_tracker = _surfaced_error_tracker
	_dispatcher.pause_target = _connection
	_debugger_plugin = DebuggerPlugin.new(_log_buffer, _game_log_buffer, _editor_log_buffer, _surfaced_error_tracker)
	_vision_routing = VisionRoutingScript.new()
	_vision_routing.log_buffer = _log_buffer
	_debugger_plugin.vision_routing = _vision_routing
	add_debugger_plugin(_debugger_plugin)
	_connection.debugger_plugin = _debugger_plugin
	_register_handlers()
	_connection.dispatcher = _dispatcher
	var pairing := _load_pairing()
	_pairing_stamp = _pairing_source_stamp()
	_connection.connect_blocked = pairing.is_empty()
	_connection.connect_block_reason = "Pair this editor with DSH in the DSH Godot dock."
	if not pairing.is_empty():
		_connection.ws_port = int(pairing.port)
		_connection.auth_token = str(pairing.token)
	add_child(_connection)
	_build_dock(pairing)
	_ensure_game_helper_autoload()
	set_process(true)
	print("DSH Godot | plugin loaded (session %s, PID %d)" % [_connection.get_session_id(), OS.get_process_id()])

func _register_handlers() -> void:
	var undo := get_undo_redo()
	_dispatcher.register_lazy_handler("editor", HANDLERS_DIR + "editor_handler.gd", [_log_buffer, _connection, _debugger_plugin, _game_log_buffer, _editor_log_buffer, null, _surfaced_error_tracker, _vision_routing])
	_dispatcher.register_lazy_handler("scene", HANDLERS_DIR + "scene_handler.gd", [_connection])
	_dispatcher.register_lazy_handler("node", HANDLERS_DIR + "node_handler.gd", [undo])
	_dispatcher.register_lazy_handler("project", HANDLERS_DIR + "project_handler.gd", [_connection, _debugger_plugin, _editor_log_buffer])
	_dispatcher.register_lazy_handler("script", HANDLERS_DIR + "script_handler.gd", [undo, _connection])
	_dispatcher.register_lazy_handler("resource", HANDLERS_DIR + "resource_handler.gd", [undo, _connection])
	_dispatcher.register_lazy_handler("api", HANDLERS_DIR + "api_handler.gd", [])
	_dispatcher.register_lazy_handler("filesystem", HANDLERS_DIR + "filesystem_handler.gd", [_connection])
	_dispatcher.register_lazy_handler("signal", HANDLERS_DIR + "signal_handler.gd", [undo])
	_dispatcher.register_lazy_handler("autoload", HANDLERS_DIR + "autoload_handler.gd", [])
	_dispatcher.register_lazy_handler("input", HANDLERS_DIR + "input_handler.gd", [])
	_dispatcher.register_lazy_handler("test", HANDLERS_DIR + "test_handler.gd", [undo, _log_buffer, _dispatcher, _connection])
	_dispatcher.register_lazy_handler("batch", HANDLERS_DIR + "batch_handler.gd", [_dispatcher, undo])
	_dispatcher.register_lazy_handler("ui", HANDLERS_DIR + "ui_handler.gd", [undo])
	_dispatcher.register_lazy_handler("theme", HANDLERS_DIR + "theme_handler.gd", [undo, _connection])
	_dispatcher.register_lazy_handler("animation", HANDLERS_DIR + "animation_handler.gd", [undo])
	_dispatcher.register_lazy_handler("material", HANDLERS_DIR + "material_handler.gd", [undo, _connection])
	_dispatcher.register_lazy_handler("shader", HANDLERS_DIR + "shader_handler.gd", [])
	_dispatcher.register_lazy_handler("visual_shader", HANDLERS_DIR + "visual_shader_handler.gd", [])
	_dispatcher.register_lazy_handler("particle", HANDLERS_DIR + "particle_handler.gd", [undo])
	_dispatcher.register_lazy_handler("camera", HANDLERS_DIR + "camera_handler.gd", [undo])
	_dispatcher.register_lazy_handler("audio", HANDLERS_DIR + "audio_handler.gd", [undo])
	_dispatcher.register_lazy_handler(
		"physics_shape", HANDLERS_DIR + "physics_shape_handler.gd", [undo, _connection]
	)
	_dispatcher.register_lazy_handler("environment", HANDLERS_DIR + "environment_handler.gd", [undo, _connection])
	_dispatcher.register_lazy_handler("texture", HANDLERS_DIR + "texture_handler.gd", [undo, _connection])
	_dispatcher.register_lazy_handler("curve", HANDLERS_DIR + "curve_handler.gd", [undo, _connection])
	_dispatcher.register_lazy_handler("control_draw_recipe", HANDLERS_DIR + "control_draw_recipe_handler.gd", [undo])
	_dispatcher.register_lazy_handler("tilemap", HANDLERS_DIR + "tilemap_handler.gd", [undo])
	_dispatcher.register_lazy_handler("tileset", HANDLERS_DIR + "tileset_handler.gd", [])
	_dispatcher.register_lazy_handler("gridmap", HANDLERS_DIR + "gridmap_handler.gd", [undo])
	_dispatcher.register_lazy_handler("navigation", HANDLERS_DIR + "navigation_handler.gd", [undo, _connection])
	_dispatcher.register_lazy_handler("csg", HANDLERS_DIR + "csg_handler.gd", [undo])

	_dispatcher.register_lazy("get_editor_state", "editor", &"get_editor_state")
	_dispatcher.register_lazy("get_scene_tree", "scene", &"get_scene_tree")
	_dispatcher.register_lazy("get_open_scenes", "scene", &"get_open_scenes")
	_dispatcher.register_lazy("find_nodes", "scene", &"find_nodes")
	_dispatcher.register_lazy("create_scene", "scene", &"create_scene")
	_dispatcher.register_lazy("open_scene", "scene", &"open_scene")
	_dispatcher.register_lazy("save_scene", "scene", &"save_scene")
	_dispatcher.register_lazy("save_scene_as", "scene", &"save_scene_as")
	_dispatcher.register_lazy("get_selection", "editor", &"get_selection")
	_dispatcher.register_lazy("create_node", "node", &"create_node")
	_dispatcher.register_lazy("delete_node", "node", &"delete_node")
	_dispatcher.register_lazy("reparent_node", "node", &"reparent_node")
	_dispatcher.register_lazy("set_property", "node", &"set_property")
	_dispatcher.register_lazy("rename_node", "node", &"rename_node")
	_dispatcher.register_lazy("duplicate_node", "node", &"duplicate_node")
	_dispatcher.register_lazy("move_node", "node", &"move_node")
	_dispatcher.register_lazy("add_to_group", "node", &"add_to_group")
	_dispatcher.register_lazy("remove_from_group", "node", &"remove_from_group")
	_dispatcher.register_lazy("set_selection", "node", &"set_selection")
	_dispatcher.register_lazy("get_node_properties", "node", &"get_node_properties")
	_dispatcher.register_lazy("get_children", "node", &"get_children")
	_dispatcher.register_lazy("get_groups", "node", &"get_groups")
	_dispatcher.register_lazy("get_logs", "editor", &"get_logs")
	_dispatcher.register_lazy("clear_logs", "editor", &"clear_logs")
	_dispatcher.register_lazy("take_screenshot", "editor", &"take_screenshot")
	_dispatcher.register_lazy("get_performance_monitors", "editor", &"get_performance_monitors")
	_dispatcher.register_lazy("reload_plugin", "editor", &"reload_plugin")
	_dispatcher.register_lazy("quit_editor", "editor", &"quit_editor")
	_dispatcher.register_lazy("game_eval", "editor", &"game_eval")
	_dispatcher.register_lazy("game_command", "editor", &"game_command")
	_dispatcher.register_lazy("game_debug_control", "editor", &"game_debug_control")
	_dispatcher.register_lazy("get_project_setting", "project", &"get_project_setting")
	_dispatcher.register_lazy("set_project_setting", "project", &"set_project_setting")
	_dispatcher.register_lazy("set_main_scene", "project", &"set_main_scene")
	_dispatcher.register_lazy("run_project", "project", &"run_project")
	_dispatcher.register_lazy("stop_project", "project", &"stop_project")
	_dispatcher.register_lazy("search_filesystem", "project", &"search_filesystem")
	_dispatcher.register_lazy("create_script", "script", &"create_script")
	_dispatcher.register_lazy("patch_script", "script", &"patch_script")
	_dispatcher.register_lazy("read_script", "script", &"read_script")
	_dispatcher.register_lazy("attach_script", "script", &"attach_script")
	_dispatcher.register_lazy("detach_script", "script", &"detach_script")
	_dispatcher.register_lazy("find_symbols", "script", &"find_symbols")
	_dispatcher.register_lazy("search_resources", "resource", &"search_resources")
	_dispatcher.register_lazy("load_resource", "resource", &"load_resource")
	_dispatcher.register_lazy("inspect_resource", "resource", &"inspect_resource")
	_dispatcher.register_lazy("assign_resource", "resource", &"assign_resource")
	_dispatcher.register_lazy("create_resource", "resource", &"create_resource")
	_dispatcher.register_lazy("get_resource_info", "resource", &"get_resource_info")
	_dispatcher.register_lazy("get_class_info", "api", &"get_class_info")
	_dispatcher.register_lazy("read_file", "filesystem", &"read_file")
	_dispatcher.register_lazy("write_file", "filesystem", &"write_file")
	_dispatcher.register_lazy("reimport", "filesystem", &"reimport")
	_dispatcher.register_lazy("scan_filesystem", "filesystem", &"scan_filesystem")
	_dispatcher.register_lazy("move_file", "filesystem", &"move_file")
	_dispatcher.register_lazy("rename_file", "filesystem", &"rename_file")
	_dispatcher.register_lazy("remove_file", "filesystem", &"remove_file")
	_dispatcher.register_lazy("list_signals", "signal", &"list_signals")
	_dispatcher.register_lazy("connect_signal", "signal", &"connect_signal")
	_dispatcher.register_lazy("disconnect_signal", "signal", &"disconnect_signal")
	_dispatcher.register_lazy("list_autoloads", "autoload", &"list_autoloads")
	_dispatcher.register_lazy("add_autoload", "autoload", &"add_autoload")
	_dispatcher.register_lazy("remove_autoload", "autoload", &"remove_autoload")
	_dispatcher.register_lazy("list_actions", "input", &"list_actions")
	_dispatcher.register_lazy("add_action", "input", &"add_action")
	_dispatcher.register_lazy("ensure_action", "input", &"ensure_action")
	_dispatcher.register_lazy("remove_action", "input", &"remove_action")
	_dispatcher.register_lazy("bind_event", "input", &"bind_event")
	_dispatcher.register_lazy("ensure_binding", "input", &"ensure_binding")
	_dispatcher.register_lazy("run_tests", "test", &"run_tests")
	_dispatcher.register_lazy("get_test_results", "test", &"get_test_results")
	_dispatcher.register_lazy("batch_execute", "batch", &"batch_execute")
	_dispatcher.register_lazy("set_anchor_preset", "ui", &"set_anchor_preset")
	_dispatcher.register_lazy("set_text", "ui", &"set_text")
	_dispatcher.register_lazy("set_richtext", "ui", &"set_richtext")
	_dispatcher.register_lazy("build_layout", "ui", &"build_layout")
	_dispatcher.register_lazy("create_theme", "theme", &"create_theme")
	_dispatcher.register_lazy("theme_set_color", "theme", &"set_color")
	_dispatcher.register_lazy("theme_set_constant", "theme", &"set_constant")
	_dispatcher.register_lazy("theme_set_font_size", "theme", &"set_font_size")
	_dispatcher.register_lazy("theme_set_stylebox_flat", "theme", &"set_stylebox_flat")
	_dispatcher.register_lazy("theme_set_stylebox_texture", "theme", &"set_stylebox_texture")
	_dispatcher.register_lazy("theme_set_font", "theme", &"set_font")
	_dispatcher.register_lazy("theme_set_icon", "theme", &"set_icon")
	_dispatcher.register_lazy("theme_stylebox_override", "theme", &"stylebox_override")
	_dispatcher.register_lazy("apply_theme", "theme", &"apply_theme")
	_dispatcher.register_lazy("animation_player_create", "animation", &"create_player")
	_dispatcher.register_lazy("animation_create", "animation", &"create_animation")
	_dispatcher.register_lazy("animation_add_property_track", "animation", &"add_property_track")
	_dispatcher.register_lazy("animation_add_method_track", "animation", &"add_method_track")
	_dispatcher.register_lazy("animation_set_autoplay", "animation", &"set_autoplay")
	_dispatcher.register_lazy("animation_play", "animation", &"play")
	_dispatcher.register_lazy("animation_stop", "animation", &"stop")
	_dispatcher.register_lazy("animation_list", "animation", &"list_animations")
	_dispatcher.register_lazy("animation_get", "animation", &"get_animation")
	_dispatcher.register_lazy("animation_create_simple", "animation", &"create_simple")
	_dispatcher.register_lazy("animation_delete", "animation", &"delete_animation")
	_dispatcher.register_lazy("animation_validate", "animation", &"validate_animation")
	_dispatcher.register_lazy("animation_preset_fade", "animation", &"preset_fade")
	_dispatcher.register_lazy("animation_preset_slide", "animation", &"preset_slide")
	_dispatcher.register_lazy("animation_preset_shake", "animation", &"preset_shake")
	_dispatcher.register_lazy("animation_preset_pulse", "animation", &"preset_pulse")
	_dispatcher.register_lazy("material_create", "material", &"create_material")
	_dispatcher.register_lazy("visual_shader_create_graph", "visual_shader", &"create_graph")
	_dispatcher.register_lazy("visual_shader_get", "visual_shader", &"get_graph")
	_dispatcher.register_lazy("visual_shader_node_catalog", "visual_shader", &"node_catalog")
	_dispatcher.register_lazy("visual_shader_edit", "visual_shader", &"edit_graph")
	_dispatcher.register_lazy("material_set_param", "material", &"set_param")
	_dispatcher.register_lazy("material_set_shader_param", "material", &"set_shader_param")
	_dispatcher.register_lazy("material_get", "material", &"get_material")
	_dispatcher.register_lazy("material_list", "material", &"list_materials")
	_dispatcher.register_lazy("material_assign", "material", &"assign_material")
	_dispatcher.register_lazy("material_apply_to_node", "material", &"apply_to_node")
	_dispatcher.register_lazy("material_apply_preset", "material", &"apply_preset")
	_dispatcher.register_lazy("shader_create", "shader", &"create_shader")
	_dispatcher.register_lazy("shader_get", "shader", &"get_shader")
	_dispatcher.register_lazy("shader_validate", "shader", &"validate_shader")
	_dispatcher.register_lazy("shader_patch", "shader", &"patch_shader")
	_dispatcher.register_lazy("particle_create", "particle", &"create_particle")
	_dispatcher.register_lazy("particle_set_main", "particle", &"set_main")
	_dispatcher.register_lazy("particle_set_process", "particle", &"set_process")
	_dispatcher.register_lazy("particle_set_draw_pass", "particle", &"set_draw_pass")
	_dispatcher.register_lazy("particle_restart", "particle", &"restart_particle")
	_dispatcher.register_lazy("particle_get", "particle", &"get_particle")
	_dispatcher.register_lazy("particle_apply_preset", "particle", &"apply_preset")
	_dispatcher.register_lazy("camera_create", "camera", &"create_camera")
	_dispatcher.register_lazy("camera_configure", "camera", &"configure")
	_dispatcher.register_lazy("camera_set_limits_2d", "camera", &"set_limits_2d")
	_dispatcher.register_lazy("camera_set_damping_2d", "camera", &"set_damping_2d")
	_dispatcher.register_lazy("camera_follow_2d", "camera", &"follow_2d")
	_dispatcher.register_lazy("camera_get", "camera", &"get_camera")
	_dispatcher.register_lazy("camera_list", "camera", &"list_cameras")
	_dispatcher.register_lazy("camera_apply_preset", "camera", &"apply_preset")
	_dispatcher.register_lazy("audio_player_create", "audio", &"create_player")
	_dispatcher.register_lazy("audio_player_set_stream", "audio", &"set_stream")
	_dispatcher.register_lazy("audio_player_set_playback", "audio", &"set_playback")
	_dispatcher.register_lazy("audio_play", "audio", &"play")
	_dispatcher.register_lazy("audio_stop", "audio", &"stop")
	_dispatcher.register_lazy("audio_list", "audio", &"list_streams")
	_dispatcher.register_lazy("physics_shape_autofit", "physics_shape", &"autofit")
	_dispatcher.register_lazy("physics_shape_generate", "physics_shape", &"generate")
	_dispatcher.register_lazy("environment_create", "environment", &"create_environment")
	_dispatcher.register_lazy("gradient_texture_create", "texture", &"create_gradient_texture")
	_dispatcher.register_lazy("noise_texture_create", "texture", &"create_noise_texture")
	_dispatcher.register_lazy("curve_set_points", "curve", &"set_points")
	_dispatcher.register_lazy("control_draw_recipe", "control_draw_recipe", &"control_draw_recipe")
	_dispatcher.register_lazy("tilemap_set_cell", "tilemap", &"set_cell")
	_dispatcher.register_lazy("tilemap_set_cells_rect", "tilemap", &"set_cells_rect")
	_dispatcher.register_lazy("tilemap_clear", "tilemap", &"clear_layer")
	_dispatcher.register_lazy("tilemap_get_cells", "tilemap", &"get_used_cells")
	_dispatcher.register_lazy("tileset_get_atlas_tiles", "tileset", &"get_atlas_tiles")
	_dispatcher.register_lazy("tileset_get_atlas_image", "tileset", &"get_atlas_image")
	_dispatcher.register_lazy("gridmap_set_item", "gridmap", &"set_item")
	_dispatcher.register_lazy("gridmap_fill", "gridmap", &"fill")
	_dispatcher.register_lazy("gridmap_clear", "gridmap", &"clear_layer")
	_dispatcher.register_lazy("gridmap_get_used_cells", "gridmap", &"get_used_cells")
	_dispatcher.register_lazy("gridmap_list_library_items", "gridmap", &"list_library_items")
	_dispatcher.register_lazy("navigation_bake", "navigation", &"bake")
	_dispatcher.register_lazy("navigation_path_get", "navigation", &"path_get")
	_dispatcher.register_lazy("csg_create", "csg", &"create")
	_dispatcher.register_lazy("csg_set_operation", "csg", &"set_operation")


func _pairing_file() -> String:
	return "res://.godot/dsh-godot-control/connection.cfg"

func _legacy_pairing_file() -> String:
	return EditorInterface.get_editor_paths().get_config_dir().path_join("dsh-godot-control/connection.cfg")

func _valid_pairing(port: int, token: String) -> bool:
	return port >= 1024 and port <= 65535 and Connection._is_lower_hex_64(token)

func _load_pairing() -> Dictionary:
	var env_token := OS.get_environment("DSH_GODOT_TOKEN")
	if not env_token.is_empty():
		var env_port := int(OS.get_environment("DSH_GODOT_WS_PORT"))
		return {"port": env_port, "token": env_token} if _valid_pairing(env_port, env_token) else {}
	# A present project file owns this project's choice, even if malformed.
	# Never silently connect to the legacy service when the override is invalid.
	var file := _pairing_file()
	if not FileAccess.file_exists(file):
		file = _legacy_pairing_file()
	var config := ConfigFile.new()
	if config.load(file) != OK:
		return {}
	var port := int(config.get_value("connection", "port", 0))
	var token := str(config.get_value("connection", "token", ""))
	return {"port": port, "token": token} if _valid_pairing(port, token) else {}

func _pairing_source_stamp() -> String:
	if not OS.get_environment("DSH_GODOT_TOKEN").is_empty():
		return "environment"
	var file := _pairing_file() if FileAccess.file_exists(_pairing_file()) else _legacy_pairing_file()
	return file + ":" + FileAccess.get_sha256(file) if FileAccess.file_exists(file) else "missing"

func _refresh_pairing() -> void:
	var stamp := _pairing_source_stamp()
	if stamp == _pairing_stamp:
		return
	_pairing_stamp = stamp
	var pairing := _load_pairing()
	_connection.disconnect_from_server("Pairing file changed")
	if pairing.is_empty():
		_connection.revoke_transport("Project pairing is missing or invalid. Save pairing in the dock.")
	else:
		_connection.authorize_transport(int(pairing.port), str(pairing.token))
		_port_input.value = int(pairing.port)

func _save_pairing() -> void:
	var port := int(_port_input.value)
	var token := _token_input.text.strip_edges()
	if not _valid_pairing(port, token):
		_status_label.text = _label("请输入有效端口和 64 位连接令牌。", "Enter a valid port and 64-character pairing token.")
		return
	var file := _pairing_file()
	var error := DirAccess.make_dir_recursive_absolute(file.get_base_dir())
	if error != OK:
		_status_label.text = error_string(error)
		return
	var config := ConfigFile.new()
	config.set_value("connection", "port", port)
	config.set_value("connection", "token", token)
	error = config.save(file)
	if error != OK:
		_status_label.text = error_string(error)
		return
	_pairing_stamp = _pairing_source_stamp()
	_connection.disconnect_from_server("Pairing changed")
	_connection.authorize_transport(port, token)
	_token_input.text = ""
	_status_label.text = _label("项目配对已保存，正在连接 DSH。", "Project pairing saved. Connecting to DSH.")

func _label(zh: String, en: String) -> String:
	return zh if TranslationServer.get_locale().begins_with("zh") else en

func _build_dock(pairing: Dictionary) -> void:
	_dock = VBoxContainer.new()
	_dock.name = "DSH Godot"
	var intro := Label.new()
	intro.text = _label("从 DSH 配对面板复制端口和令牌，保存到当前项目的 .godot 目录。", "Copy the DSH port and token. Pairing is saved in this project's .godot directory.")
	intro.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_dock.add_child(intro)
	_port_input = SpinBox.new()
	_port_input.min_value = 1024
	_port_input.max_value = 65535
	_port_input.value = int(pairing.get("port", 9500))
	_port_input.prefix = _label("端口 ", "Port ")
	_dock.add_child(_port_input)
	_token_input = LineEdit.new()
	_token_input.secret = true
	_token_input.placeholder_text = _label("DSH 连接令牌", "DSH pairing token")
	_dock.add_child(_token_input)
	var save := Button.new()
	save.text = _label("保存配对并连接", "Save pairing and connect")
	save.pressed.connect(_save_pairing)
	_dock.add_child(save)
	_status_label = Label.new()
	_status_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_dock.add_child(_status_label)
	add_control_to_dock(DOCK_SLOT_RIGHT_BL, _dock)

func _process(delta: float) -> void:
	if _vision_routing != null:
		_vision_routing.poll_completed()
	_refresh_elapsed += delta
	if _status_label != null and _connection != null and _refresh_elapsed >= 1.0:
		_refresh_elapsed = 0.0
		_refresh_pairing()
		var status: Dictionary = _connection.get_transport_status()
		_status_label.text = _connection_status_text(status)

func _connection_status_text(status: Dictionary) -> String:
	var phases := {
		"connected": _label("已连接", "Connected"),
		"connecting": _label("正在连接", "Connecting"),
		"authenticating": _label("正在认证", "Authenticating"),
		"retrying": _label("等待重试", "Waiting to retry"),
		"closing": _label("正在断开", "Disconnecting"),
		"blocked": _label("需要配对", "Pairing required"),
		"waiting": _label("等待连接", "Waiting"),
	}
	var phase := str(status.get("phase", "waiting"))
	var lines: Array[String] = [_label("DSH 连接：", "DSH connection: ") + str(phases.get(phase, phase))]
	lines.append(str(status.get("endpoint", "")))
	lines.append("PID: %d" % int(status.get("editor_pid", 0)))
	lines.append("Session ID: %s" % str(status.get("session_id", "")))
	if status.has("retry_in_sec"):
		lines.append(_label("下次重试：%d 秒", "Retry in %d s") % int(ceil(float(status.retry_in_sec))))
	var reason := str(status.get("reason", ""))
	if not reason.is_empty():
		lines.append(_label("原因：", "Reason: ") + reason)
	return "\n".join(lines)

func _ensure_game_helper_autoload() -> void:
	var key := "autoload/" + GAME_HELPER_AUTOLOAD_NAME
	var value := "*" + GAME_HELPER_AUTOLOAD_PATH
	if ProjectSettings.get_setting(key, "") != value:
		ProjectSettings.set_setting(key, value)
		ProjectSettings.set_as_basic(key, true)
		ProjectSettings.save()

func _disable_plugin() -> void:
	var key := "autoload/" + GAME_HELPER_AUTOLOAD_NAME
	if ProjectSettings.has_setting(key):
		ProjectSettings.clear(key)
		ProjectSettings.save()

func _exit_tree() -> void:
	set_process(false)
	if _connection != null:
		_connection.teardown()
	if _vision_routing != null:
		_vision_routing.shutdown()
	if _dispatcher != null:
		_dispatcher.release_after_teardown()
	if _dock != null:
		remove_control_from_docks(_dock)
		_dock.queue_free()
	if _connection != null:
		_connection.queue_free()
	if _debugger_plugin != null:
		remove_debugger_plugin(_debugger_plugin)
	if _export_plugin != null:
		remove_export_plugin(_export_plugin)
	if _editor_logger != null:
		OS.remove_logger(_editor_logger)
	_connection = null
	_dispatcher = null
	_vision_routing = null
	_debugger_plugin = null
	_export_plugin = null
	_editor_logger = null
	_log_buffer = null
	_game_log_buffer = null
	_editor_log_buffer = null
	_surfaced_error_tracker = null
