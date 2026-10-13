"""Regression coverage for the detached GameLogger queue (#1123)."""

import os
import subprocess

import pytest

from tests.integration._self_update_fixture import ROOT, godot_bin_or_skip

pytestmark = pytest.mark.editor


def test_game_logger_queue_does_not_grow_without_debugger() -> None:
    """A headless game process must not retain logs without a debugger."""
    godot = godot_bin_or_skip()
    env = os.environ.copy()
    env["GODOT_AI_ALLOW_HEADLESS"] = "1"
    env["GODOT_AI_DISABLE_TELEMETRY"] = "true"

    result = subprocess.run(
        [
            godot,
            "--headless",
            "--path",
            str(ROOT / "test_project"),
            "--script",
            "res://tests/mcp_game_logger_queue_driver.gd",
        ],
        capture_output=True,
        text=True,
        timeout=60,
        env=env,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert "GAME_LOGGER_PENDING=0 OUTBOUND=0" in result.stdout
