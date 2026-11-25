from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from sensing import sensing_server


def test_search_endpoint_forwards_time_bounds_and_image_results(monkeypatch):
    result = {
        "query": "profile",
        "matches": [{"id": 5}],
        "images": [{"data": "jpeg", "mimeType": "image/jpeg"}],
    }
    search = AsyncMock(return_value=result)
    monkeypatch.setattr(
        sensing_server,
        "screen",
        SimpleNamespace(_screen_history=SimpleNamespace(search=search)),
    )
    client = TestClient(sensing_server.app)
    response = client.post(
        "/screen-history/search",
        json={
            "query": "profile",
            "top_k": 2,
            "since": "2026-11-24",
            "until": "2026-11-25",
        },
    )
    assert response.status_code == 200
    assert response.json() == result
    search.assert_awaited_once_with(
        {"query": "profile", "top_k": 2, "since": "2026-11-24", "until": "2026-11-25"}
    )


@pytest.mark.parametrize(
    "payload", [{"query": "x", "top_k": 6}, {"query": "x", "top_k": 0}, {"query": ""}]
)
def test_search_endpoint_bounds_results_before_worker_access(monkeypatch, payload):
    search = AsyncMock()
    monkeypatch.setattr(
        sensing_server,
        "screen",
        SimpleNamespace(_screen_history=SimpleNamespace(search=search)),
    )
    assert (
        TestClient(sensing_server.app)
        .post("/screen-history/search", json=payload)
        .status_code
        == 422
    )
    search.assert_not_awaited()


def test_search_endpoint_explains_disabled_indexing(monkeypatch):
    monkeypatch.setattr(sensing_server, "screen", SimpleNamespace(_screen_history=None))
    response = TestClient(sensing_server.app).post(
        "/screen-history/search", json={"query": "profile"}
    )
    assert response.status_code == 503
    assert "Enable it in Settings" in response.json()["detail"]


def test_config_endpoint_changes_collection_live(monkeypatch):
    screen = SimpleNamespace(_screen_history=object())

    async def change(enabled):
        screen._screen_history = object() if enabled else None

    screen.set_screen_history_enabled = AsyncMock(side_effect=change)
    monkeypatch.setattr(sensing_server, "screen", screen)
    client = TestClient(sensing_server.app)
    assert client.post("/screen-history/config", json={"enabled": False}).json() == {
        "enabled": False
    }
    assert client.post("/screen-history/config", json={"enabled": True}).json() == {
        "enabled": True
    }
    assert (
        client.post("/screen-history/config", json={"enabled": "false"}).status_code
        == 422
    )
