extends SceneTree

const PROBE_LINES := 5000


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	await process_frame
	var helper: Node = root.get_node_or_null("_mcp_game_helper")
	if helper == null:
		push_error("game logger driver requires the _mcp_game_helper autoload")
		quit(2)
		return
	var logger: Object = helper.get("_logger")
	if logger == null:
		push_error("game logger driver requires an attached logger")
		quit(2)
		return
	if EngineDebugger.is_active():
		push_error("game logger driver must run without an active debugger")
		quit(2)
		return

	for i in PROBE_LINES:
		print("probe line %d" % i)
	for _frame in 5:
		await process_frame

	var pending := (logger.get("_pending") as Array).size()
	var outbound := (helper.get("_pending_outbound") as Array).size()
	print("GAME_LOGGER_PENDING=%d OUTBOUND=%d" % [pending, outbound])
	quit(0 if pending == 0 and outbound == 0 else 1)
