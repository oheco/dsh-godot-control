@tool
class_name DshGodotServiceLocator
extends RefCounted

var _connection: DshGodotConnection = null
var _log_buffer: DshGodotLogBuffer = null

func setup(connection: DshGodotConnection, log_buffer: DshGodotLogBuffer) -> void:
	_connection = connection
	_log_buffer = log_buffer

func get_connection() -> DshGodotConnection:
	return _connection

func get_log_buffer() -> DshGodotLogBuffer:
	return _log_buffer
