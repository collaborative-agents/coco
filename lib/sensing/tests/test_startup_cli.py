"""Keep the sensing entry point compatible with the desktop launcher."""

import chz
import pytest
from sensing import sensing_server


@pytest.mark.parametrize("scenario", ["everyday_support", "student_learning"])
def test_desktop_scenario_argument_reaches_startup(monkeypatch, scenario):
    captured = {}

    async def start(**kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(sensing_server, "main_async", start)
    chz.entrypoint(
        sensing_server.main,
        argv=[
            "--port=8080",
            "--ai_tutoring=True",
            "--observer_model=gemini/gemini-2.5-pro",
            "--check_interval=15",
            "--mse_threshold=8000",
            "--observer_interval_seconds=3600",
            f"--scenario={scenario}",
        ],
        allow_hyphens=True,
    )
    assert captured["scenario"] == scenario
    assert captured["observer_interval_seconds"] == 3600
    assert captured["enable_judge"] is False
