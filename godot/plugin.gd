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

func _enter_tree() -> void:
	var version := Engine.get_version_info()
	if int(version.major) != 4 or int(version.minor) < 7:
		push_error("DSH Godot requires Godot 4.7 or newer within 4.x.")
		return
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
	_export_plugin = ExportPlugin.new()
	add_export_plugin(_export_plugin)
	_register_handlers()
	_connection.dispatcher = _dispatcher
	var pairing := _load_pairing()
	_connection.connect_blocked = pairing.is_empty()
	_connection.connect_block_reason = "Pair this editor with DSH in the DSH Godot dock."
	if not pairing.is_empty():
		_connection.ws_port = int(pairing.port)
		_connection.auth_token = str(pairing.token)
	add_child(_connection)
	_build_dock(pairing)
	_ensure_game_helper_autoload()
	set_process(true)
	print("DSH Godot | plugin loaded; no Python or MCP backend")

func _register_handlers() -> void:
	# @REGISTRATION@

func _pairing_file() -> String:
	return EditorInterface.get_editor_paths().get_config_dir().path_join("dsh-godot-control/connection.cfg")

func _valid_pairing(port: int, token: String) -> bool:
	return port >= 1024 and port <= 65535 and Connection._is_lower_hex_64(token)

func _load_pairing() -> Dictionary:
	var env_token := OS.get_environment("DSH_GODOT_TOKEN")
	if not env_token.is_empty():
		var env_port := int(OS.get_environment("DSH_GODOT_WS_PORT"))
		return {"port": env_port, "token": env_token} if _valid_pairing(env_port, env_token) else {}
	var file := _pairing_file()
	if not FileAccess.file_exists(file):
		return {}
	if OS.get_name() != "Windows" and FileAccess.get_unix_permissions(file) & 0x3f:
		push_error("DSH Godot pairing file is not private.")
		return {}
	var config := ConfigFile.new()
	if config.load(file) != OK:
		return {}
	var port := int(config.get_value("connection", "port", 0))
	var token := str(config.get_value("connection", "token", ""))
	return {"port": port, "token": token} if _valid_pairing(port, token) else {}

func _save_pairing() -> void:
	var port := int(_port_input.value)
	var token := _token_input.text.strip_edges()
	if not _valid_pairing(port, token):
		_status_label.text = _label("请输入有效端口和 64 位连接令牌。", "Enter a valid port and 64-character pairing token.")
		return
	var file := _pairing_file()
	var directory := file.get_base_dir()
	var error := DirAccess.make_dir_recursive_absolute(directory)
	if error != OK:
		_status_label.text = error_string(error)
		return
	if OS.get_name() != "Windows":
		FileAccess.set_unix_permissions(directory, 0x1c0)
		if FileAccess.get_unix_permissions(directory) & 0x3f:
			_status_label.text = _label("配置目录无法保护令牌，请使用应用私有存储。", "Pairing requires application-private storage.")
			return
	var config := ConfigFile.new()
	config.set_value("connection", "port", port)
	config.set_value("connection", "token", token)
	error = config.save(file)
	if error == OK and OS.get_name() != "Windows":
		FileAccess.set_unix_permissions(file, 0x180)
		if FileAccess.get_unix_permissions(file) & 0x3f:
			error = ERR_UNAUTHORIZED
	if error != OK:
		_status_label.text = error_string(error)
		return
	_connection.disconnect_from_server("Pairing changed")
	_connection.authorize_transport(port, token)
	_token_input.text = ""
	_status_label.text = _label("配对已保存，正在连接 DSH。", "Pairing saved. Connecting to DSH.")

func _label(zh: String, en: String) -> String:
	return zh if TranslationServer.get_locale().begins_with("zh") else en

func _build_dock(pairing: Dictionary) -> void:
	_dock = VBoxContainer.new()
	_dock.name = "DSH Godot"
	var intro := Label.new()
	intro.text = _label("从 DSH 插件配对面板复制端口和令牌。", "Copy the port and token from DSH's pairing panel.")
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
		var status: Dictionary = _connection.get_transport_status()
		_status_label.text = _label("连接状态：", "Connection: ") + str(status.get("phase", "waiting"))

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
