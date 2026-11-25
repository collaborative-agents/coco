import httpx
import pytest
from proactive_tutor.tools.screen_history import ScreenHistoryToolProvider


def test_search_routes_to_sensing_and_preserves_image_evidence(monkeypatch):
    monkeypatch.setenv("SENSING_PORT", "49153")
    calls = []
    result = {
        "matches": [{"time": "2026-11-24 11:14:19", "score": 0.5}],
        "images": [{"mimeType": "image/jpeg", "data": "encoded-image"}],
        "count": 1,
    }

    def post(url, **kwargs):
        calls.append((url, kwargs))
        return httpx.Response(200, json=result)

    monkeypatch.setattr("proactive_tutor.tools.screen_history.httpx.post", post)
    provider = ScreenHistoryToolProvider()
    definition = provider.definitions()[0]
    assert definition.read_only
    arguments = {"query": "internship end date", "top_k": 1, "since": "2026-11-24"}
    assert provider.execute(definition.name, arguments) == result
    assert calls[0][0] == "http://127.0.0.1:49153/screen-history/search"
    assert calls[0][1]["json"] == arguments


@pytest.mark.parametrize(
    "arguments",
    [
        {},
        {"query": " "},
        {"query": "x", "path": "/etc/passwd"},
        {"query": "x", "top_k": 0},
        {"query": "x", "top_k": 6},
        {"query": "x", "top_k": True},
    ],
)
def test_search_rejects_invalid_arguments_before_accessing_history(
    arguments, monkeypatch
):
    def refuse(*args, **kwargs):
        raise AssertionError("Invalid arguments reached sensing")

    monkeypatch.setattr("proactive_tutor.tools.screen_history.httpx.post", refuse)
    assert "error" in ScreenHistoryToolProvider().execute(
        "search_screen_history", arguments
    )


def test_disabled_history_returns_actionable_error(monkeypatch):
    monkeypatch.setattr(
        "proactive_tutor.tools.screen_history.httpx.post",
        lambda *args, **kwargs: httpx.Response(
            503,
            json={
                "detail": "Screen history indexing is disabled. Enable it in Settings first."
            },
        ),
    )
    result = ScreenHistoryToolProvider().execute(
        "search_screen_history", {"query": "profile"}
    )
    assert "Enable it in Settings" in result["error"]
