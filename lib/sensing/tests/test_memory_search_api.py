from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient
from sensing import sensing_server


def test_ask_endpoint_uses_sensing_model_and_requires_indexing(monkeypatch):
    search = AsyncMock()
    monkeypatch.setattr(
        sensing_server,
        "screen",
        SimpleNamespace(_screen_history=SimpleNamespace(search=search)),
    )
    monkeypatch.setattr(
        sensing_server,
        "_get_ai_processor",
        lambda: SimpleNamespace(_observer_model="hosted_vllm/local-model"),
    )
    answer = AsyncMock(
        return_value={
            "answer": "Saved detail [1]",
            "sources": [],
            "model": "hosted_vllm/local-model",
        }
    )
    monkeypatch.setattr(sensing_server, "answer_memory_question", answer)
    response = TestClient(sensing_server.app).post(
        "/screen-history/ask", json={"question": "What did I read?"}
    )
    assert response.status_code == 200
    answer.assert_awaited_once_with(
        "What did I read?", "hosted_vllm/local-model", search
    )
    monkeypatch.setattr(sensing_server, "screen", SimpleNamespace(_screen_history=None))
    response = TestClient(sensing_server.app).post(
        "/screen-history/ask", json={"question": "What did I read?"}
    )
    assert response.status_code == 503
