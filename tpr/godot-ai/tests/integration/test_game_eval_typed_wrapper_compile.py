"""Compiler-backed coverage for the generated game_eval wrapper (#1119)."""

import shutil
import subprocess
from pathlib import Path

import pytest

from tests.integration._self_update_fixture import PLUGIN_ROOT, godot_bin_or_skip

pytestmark = pytest.mark.editor

PROJECT_SETTINGS = """\
config_version=5

[application]
config/name="typed-eval-wrapper-check"
{debug_section}"""

STRICT_DEBUG_SECTION = """
[debug]
gdscript/warnings/untyped_declaration=2
gdscript/warnings/unreachable_code=2
"""

# Every body is valid caller code. Only the first returns on every path; the
# rest are the shapes a declared return type on the inner function rejects.
CHECK_SCRIPT = """\
extends SceneTree

const GameHelper := preload("res://addons/godot_ai/runtime/game_helper.gd")

const BODIES: Dictionary[String, String] = {
	"return_value": "return 1",
	"no_return": "print(1)",
	"conditional_return": "if true:\\n\\treturn 1",
	"bare_return": "print(1)\\nreturn",
	"await_no_return": "await get_tree().process_frame",
}


func _initialize() -> void:
	var failed := false
	for body_name: String in BODIES:
		var source := GameHelper._build_eval_script_source("_mcp_run_test", BODIES[body_name])
		var script := GDScript.new()
		script.source_code = source
		var error := script.reload()
		if error != OK:
			push_error("game_eval wrapper failed to compile for %s: %d" % [body_name, error])
			failed = true
		else:
			print("GAME_EVAL_WRAPPER_COMPILES %s" % body_name)
	quit(1 if failed else 0)
"""

BODY_NAMES = [
    "return_value",
    "no_return",
    "conditional_return",
    "bare_return",
    "await_no_return",
]


@pytest.mark.parametrize(
    "debug_section",
    [STRICT_DEBUG_SECTION, ""],
    ids=["strict_warnings_as_errors", "default_warnings"],
)
def test_generated_game_eval_wrapper_compiles(tmp_path: Path, debug_section: str) -> None:
    """The wrapper must compile for every caller-code shape, in a project that
    treats untyped declarations as errors and in a default one."""
    godot = godot_bin_or_skip()
    project = tmp_path / "typed-eval-project"
    project.mkdir()
    (project / "project.godot").write_text(
        PROJECT_SETTINGS.format(debug_section=debug_section), encoding="utf-8"
    )

    addons = project / "addons"
    addons.mkdir()
    shutil.copytree(PLUGIN_ROOT, addons / "godot_ai")

    (project / "check.gd").write_text(CHECK_SCRIPT, encoding="utf-8")

    result = subprocess.run(
        [godot, "--headless", "--path", str(project), "--script", "res://check.gd"],
        capture_output=True,
        text=True,
        timeout=60,
    )

    output = result.stdout + result.stderr
    assert result.returncode == 0, output
    for name in BODY_NAMES:
        assert f"GAME_EVAL_WRAPPER_COMPILES {name}" in result.stdout, output
