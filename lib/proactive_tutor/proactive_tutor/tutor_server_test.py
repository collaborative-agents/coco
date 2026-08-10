import asyncio
import sys

import chz
import memory_mcp.server as memory_mcp_server
from proactive_tutor import model_connection_test, packaged_entrypoint, tutor_server


def test_memory_mcp_entrypoint_mode_bypasses_tutor_cli(monkeypatch) -> None:
    calls: list[str] = []
    monkeypatch.setattr(sys, "argv", ["tutor-server", "--memory-mcp"])
    monkeypatch.setattr(memory_mcp_server, "main", lambda: calls.append("memory"))
    monkeypatch.setattr(
        chz,
        "entrypoint",
        lambda *args, **kwargs: calls.append("tutor"),
    )

    packaged_entrypoint.main()

    assert calls == ["memory"]


def test_normal_entrypoint_mode_uses_tutor_cli(monkeypatch) -> None:
    calls: list[tuple[object, bool]] = []
    monkeypatch.setattr(sys, "argv", ["tutor-server", "model_name=test-model"])
    monkeypatch.setattr(
        chz,
        "entrypoint",
        lambda entrypoint, *, allow_hyphens: calls.append((entrypoint, allow_hyphens)),
    )

    packaged_entrypoint.main()

    assert calls == [(tutor_server.main, True)]


def test_model_connection_entrypoint_bypasses_tutor_server(monkeypatch) -> None:
    calls: list[list[str] | None] = []
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "tutor-server",
            "--test-model-connection",
            "--model",
            "gemini/test",
            "--include-image",
        ],
    )
    monkeypatch.setattr(
        model_connection_test,
        "main",
        lambda argv=None: calls.append(argv),
    )

    packaged_entrypoint.main()

    assert calls == [["--model", "gemini/test", "--include-image"]]


def test_model_switch_updates_session_and_stateless_suggestions(monkeypatch) -> None:
    selected: list[str] = []

    class FakeTutor:
        def set_model(self, model: str) -> None:
            selected.append(model)

    monkeypatch.setattr(tutor_server, "tutor", FakeTutor())
    monkeypatch.setattr(tutor_server, "configured_model_name", "old-model")

    asyncio.run(tutor_server.set_model(tutor_server.ModelRequest(model="new-model")))

    assert selected == ["new-model"]
    assert tutor_server.configured_model_name == "new-model"
