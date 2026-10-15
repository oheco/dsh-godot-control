@tool
extends RefCounted

const Errors := preload("res://addons/dsh_godot/utils/error_codes.gd")
const ScriptWork := preload("res://addons/dsh_godot/utils/script_work.gd")
const LogBuffer := preload("res://addons/dsh_godot/utils/editor_log_buffer.gd")
const ImportLogger := preload("res://addons/dsh_godot/runtime/validation_logger.gd")
static var _busy := false


## reimport_files() is synchronous, but its progress UI pumps editor frames.
## Keep the guard through the call, and never infer success from its signals:
## resources_reimported lists attempts and can also fire for nested textures.
static func run(params: Dictionary) -> Dictionary:
	var supplied: Variant = params.get("paths", [])
	if not supplied is Array or supplied.is_empty():
		return Errors.make(Errors.MISSING_REQUIRED_PARAM, "paths must be a non-empty array")
	var filesystem := EditorInterface.get_resource_filesystem()
	if filesystem == null:
		return Errors.make_not_ready(Errors.SUB_EDITOR_UNAVAILABLE, "EditorFileSystem not available", false)
	if _busy or filesystem.is_scanning() or filesystem.is_importing():
		return Errors.make_not_ready(Errors.SUB_EDITOR_IMPORTING, "Wait for the current resource scan or import to finish", true)

	var candidates := PackedStringArray()
	var reimported: Array[String] = []
	var skipped: Array[String] = []
	var not_found: Array[String] = []
	var failed: Array[String] = []
	var seen := {}
	for value in supplied:
		if not value is String:
			return Errors.make(Errors.INVALID_PARAMS, "Each paths entry must be a resource-path string")
		var asset: String = value
		if seen.has(asset):
			continue
		seen[asset] = true
		var path_error := DshGodotPathValidator.validate_resource_path(asset)
		if not path_error.is_empty() or not FileAccess.file_exists(asset):
			not_found.append(asset)
		elif asset.ends_with(".import") or not FileAccess.file_exists(asset + ".import"):
			filesystem.update_file(asset)
			skipped.append(asset)
		elif not _is_registered(filesystem, asset):
			failed.append(asset)
		else:
			var sidecar := ConfigFile.new()
			if sidecar.load(asset + ".import") != OK:
				failed.append(asset)
			elif str(sidecar.get_value("remap", "importer", "")) in ["keep", "skip"]:
				skipped.append(asset)
			else:
				candidates.append(asset)

	_busy = true
	var work := ScriptWork.begin("reimport")
	var logs := LogBuffer.new()
	var logger := ImportLogger.new(logs)
	OS.add_logger(logger)
	if not candidates.is_empty():
		filesystem.reimport_files(candidates)
	OS.remove_logger(logger)
	var captured: Dictionary = logs.get_since(0, 100)
	for asset in candidates:
		if _import_is_valid(filesystem, asset):
			reimported.append(asset)
		else:
			failed.append(asset)
	ScriptWork.finish(work)
	_busy = false

	return {"data": {
		"reimported": reimported,
		"reimported_count": reimported.size(),
		"skipped_non_imported": skipped,
		"skipped_non_imported_count": skipped.size(),
		"not_found": not_found,
		"not_found_count": not_found.size(),
		"failed": failed,
		"failed_count": failed.size(),
		"import_completed": true,
		"all_succeeded": failed.is_empty() and not_found.is_empty(),
		"forced": true,
		"diagnostics": captured.get("entries", []),
		"diagnostics_scope": "import_operation",
		"diagnostics_truncated": captured.get("truncated", false) or logs.total_count() > 100,
		"hint": "Scan new assets first. Non-imported files are only refreshed. Import validity does not verify every material or external dependency.",
		"undoable": false,
		"reason": "Resource import writes generated files",
	}}


static func _import_is_valid(filesystem: EditorFileSystem, asset: String) -> bool:
	var sidecar := ConfigFile.new()
	if sidecar.load(asset + ".import") != OK or not bool(sidecar.get_value("remap", "valid", true)):
		return false
	var directory := filesystem.get_filesystem_path(asset.get_base_dir())
	var index := directory.find_file_index(asset.get_file()) if directory != null else -1
	if index < 0 or not directory.get_file_import_is_valid(index):
		return false
	for output in sidecar.get_value("deps", "dest_files", PackedStringArray()):
		if not FileAccess.file_exists(str(output)):
			return false
	return true


static func _is_registered(filesystem: EditorFileSystem, asset: String) -> bool:
	var directory := filesystem.get_filesystem_path(asset.get_base_dir())
	return directory != null and directory.find_file_index(asset.get_file()) >= 0
