"""Contract tests for the GDScript source emitted by game_eval."""

from pathlib import Path

from tests.unit._gdscript_text import get_func_block

PLUGIN_ROOT = Path(__file__).resolve().parents[2] / "plugin" / "addons" / "godot_ai"
GAME_HELPER = PLUGIN_ROOT / "runtime" / "game_helper.gd"


def _builder_block() -> str:
    source = GAME_HELPER.read_text(encoding="utf-8")
    return get_func_block(source, "func _build_eval_script_source(")


def test_game_eval_execute_wrapper_declares_a_return_type() -> None:
    """Strictly typed projects reject an `execute()` without a return type."""
    assert '"func execute() -> Variant:\\n"' in _builder_block()


def test_game_eval_run_function_stays_untyped_and_silences_the_warning() -> None:
    """Caller code need not return on every path, so the inner function cannot
    declare a return type; it suppresses the strict-typing warning instead."""
    block = _builder_block()

    assert '"@warning_ignore(\\"untyped_declaration\\") func %s():\\n"' in block
    assert "func %s() -> " not in block
