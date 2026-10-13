@tool
extends McpTestSuite

const GameLogger := preload("res://addons/godot_ai/runtime/game_logger.gd")


func suite_name() -> String:
	return "game_log_queue"


func test_pending_queue_is_bounded_during_a_burst() -> void:
	var logger = GameLogger.new()
	for i in 9000:
		logger._log_message("probe line %d" % i, false)

	var pending: Array = logger.get("_pending")
	assert_true(pending.size() <= 8192, "pending queue must stay bounded during a log burst")
	assert_true(String(pending[-1][1]).ends_with("probe line 8999"), "newest line survives the trim")
	assert_false(String(pending[0][1]).ends_with("probe line 0"), "oldest lines are dropped first")


func test_drain_reports_how_many_lines_a_burst_dropped() -> void:
	var logger = GameLogger.new()
	for i in 9000:
		logger._log_message("probe line %d" % i, false)

	var drained: Array = logger.drain()
	## 9000 lines cross the 8192 trim threshold once, keeping the newest 4096
	## and then appending the remaining 808: 4096 lines were dropped.
	assert_eq(String(drained[0][0]), "warn", "the drop marker is a warn entry")
	assert_contains(String(drained[0][1]), "dropped 4096 older game log lines")
	assert_eq(drained.size(), 4905, "marker plus the 4904 surviving lines")
	assert_true(String(drained[-1][1]).ends_with("probe line 8999"), "newest line survives")

	logger._log_message("after", false)
	var next: Array = logger.drain()
	assert_eq(next.size(), 1, "the marker is reported once, not on every drain")


func test_drain_adds_no_marker_when_nothing_was_dropped() -> void:
	var logger = GameLogger.new()
	logger._log_message("probe", false)
	var drained: Array = logger.drain()
	assert_eq(drained.size(), 1)
	assert_eq(String(drained[0][1]), "probe")


func test_clear_releases_pending_lines() -> void:
	var logger = GameLogger.new()
	logger._log_message("probe", false)
	assert_true(logger.has_pending(), "probe must enter the queue")
	logger.clear()
	assert_false(logger.has_pending(), "clear must release queued lines")


func test_clear_forgets_dropped_lines_nobody_could_have_read() -> void:
	var logger = GameLogger.new()
	for i in 9000:
		logger._log_message("probe line %d" % i, false)
	logger.clear()
	logger._log_message("after", false)
	var drained: Array = logger.drain()
	assert_eq(drained.size(), 1, "a cleared queue carries no stale drop marker")
