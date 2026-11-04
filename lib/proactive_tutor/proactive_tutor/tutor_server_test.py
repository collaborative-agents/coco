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


def test_user_name_endpoint_updates_tutor_context(monkeypatch) -> None:
    selected: list[str] = []

    class FakeTutor:
        def set_user_name(self, user_name: str) -> None:
            selected.append(user_name)

    monkeypatch.setattr(tutor_server, "tutor", FakeTutor())

    asyncio.run(
        tutor_server.set_user_name(tutor_server.UserNameRequest(user_name="Ada"))
    )

    assert selected == ["Ada"]


def test_observer_inspection_endpoint_works_without_tutor_and_validates_queries(
    monkeypatch, tmp_path
):
    from fastapi.testclient import TestClient

    db = tmp_path / "missing.db"
    monkeypatch.setattr(tutor_server, "tutor", None)
    monkeypatch.setattr(tutor_server, "default_memory_db_path", lambda: db)
    with TestClient(tutor_server.app) as client:
        response = client.get("/context/observer")
        assert response.status_code == 200
        assert response.json()["items"] == []
        assert not db.exists()
        assert client.get("/context/observer", params={"offset": -1}).status_code == 422
        assert (
            client.get("/context/observer", params={"limit": 1000}).status_code == 422
        )


def test_observer_mutations_validate_and_report_conflicts(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from memory import MemoryStore
    from memory.inspection import inspect_context
    from memory.models import PropositionDraft

    db = tmp_path / "memory.db"
    MemoryStore(db).insert_proposition(PropositionDraft("Original", "Observed"), [])
    insight_id = inspect_context(db)["items"][0]["id"]
    monkeypatch.setattr(tutor_server, "default_memory_db_path", lambda: db)
    with TestClient(tutor_server.app) as client:
        url = f"/context/observer/{insight_id}"
        assert (
            client.post(
                url, json={"expected": "Original", "text": "Edited"}
            ).status_code
            == 200
        )
        assert (
            client.post(url, json={"expected": "Original", "text": None}).status_code
            == 409
        )
        assert client.post(url, json={"expected": "Edited"}).status_code == 422
        assert (
            client.post(url, json={"expected": "Edited", "text": None}).status_code
            == 200
        )
        assert inspect_context(db)["total"] == 0
