import json
import socket
from unittest.mock import AsyncMock

import httpx
import pytest
from screen_history import memory_search


def private_dns(*args, **kwargs):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.4", 8000))]


@pytest.mark.asyncio
async def test_rejects_cloud_model_before_accessing_any_memory(monkeypatch):
    search = AsyncMock()
    with pytest.raises(ValueError, match="local or private-network"):
        await memory_search.answer_memory_question(
            "private question", "openai/gpt-5", search
        )
    search.assert_not_awaited()


@pytest.mark.asyncio
async def test_rejects_public_endpoint_even_for_self_hosted_provider(monkeypatch):
    monkeypatch.setenv("HOSTED_VLLM_API_BASE", "https://example.com/v1")
    monkeypatch.setattr(
        memory_search.socket,
        "getaddrinfo",
        lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))],
    )
    search = AsyncMock()
    with pytest.raises(ValueError, match="public address"):
        await memory_search.answer_memory_question(
            "private question", "hosted_vllm/model", search
        )
    search.assert_not_awaited()


@pytest.mark.asyncio
async def test_local_model_searches_and_reads_images_before_answering(monkeypatch):
    monkeypatch.setenv("HOSTED_VLLM_API_BASE", "http://private-host:8000/v1")
    monkeypatch.setattr(memory_search.socket, "getaddrinfo", private_dns)
    requests = []

    def respond(request):
        body = json.loads(request.content)
        requests.append(body)
        if len(requests) == 1:
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {
                            "message": {
                                "role": "assistant",
                                "content": None,
                                "tool_calls": [
                                    {
                                        "id": "search-1",
                                        "type": "function",
                                        "function": {
                                            "name": "search_screen_history",
                                            "arguments": json.dumps(
                                                {
                                                    "query": "internship end date",
                                                    "since": "2026-11-24",
                                                    "top_k": 1,
                                                }
                                            ),
                                        },
                                    }
                                ],
                            }
                        }
                    ]
                },
            )
        assert "data:image/jpeg;base64,c2NyZWVu" in json.dumps(body["messages"])
        assert "Historical source [1]" in json.dumps(body["messages"])
        return httpx.Response(
            200,
            json={
                "choices": [
                    {"message": {"content": "Your internship ends December 18 [1]."}}
                ]
            },
        )

    client = httpx.AsyncClient
    options = []

    def create_client(**kwargs):
        options.append(kwargs)
        return client(transport=httpx.MockTransport(respond), **kwargs)

    monkeypatch.setattr(memory_search.httpx, "AsyncClient", create_client)
    search = AsyncMock(
        return_value={
            "matches": [
                {
                    "id": 7,
                    "path": "/history/email.webp",
                    "time": "2026-11-24 11:14:19",
                    "ts": 100,
                    "score": 0.5,
                }
            ],
            "images": [{"mimeType": "image/jpeg", "data": "c2NyZWVu"}],
        }
    )
    result = await memory_search.answer_memory_question(
        "When does my internship end?", "hosted_vllm/Qwen", search
    )
    assert result["answer"] == "Your internship ends December 18 [1]."
    assert result["sources"][0]["number"] == 1
    assert result["sources"][0]["image_url"] == "data:image/jpeg;base64,c2NyZWVu"
    search.assert_awaited_once_with(
        {"query": "internship end date", "since": "2026-11-24", "top_k": 1}
    )
    assert requests[0]["tool_choice"]["function"]["name"] == "search_screen_history"
    assert options[0]["trust_env"] is False
    assert options[0]["follow_redirects"] is False


@pytest.mark.asyncio
async def test_no_evidence_never_surfaces_a_model_guess(monkeypatch):
    monkeypatch.setenv("HOSTED_VLLM_API_BASE", "http://localhost:8000/v1")
    monkeypatch.setattr(memory_search.socket, "getaddrinfo", private_dns)
    calls = 0

    def respond(request):
        nonlocal calls
        calls += 1
        message = (
            {
                "tool_calls": [
                    {
                        "id": "1",
                        "function": {
                            "name": "search_screen_history",
                            "arguments": '{"query":"missing"}',
                        },
                    }
                ]
            }
            if calls == 1
            else {"content": "Unsupported personal fact."}
        )
        return httpx.Response(200, json={"choices": [{"message": message}]})

    client = httpx.AsyncClient
    monkeypatch.setattr(
        memory_search.httpx,
        "AsyncClient",
        lambda **kwargs: client(transport=httpx.MockTransport(respond), **kwargs),
    )
    result = await memory_search.answer_memory_question(
        "unknown",
        "hosted_vllm/model",
        AsyncMock(return_value={"matches": [], "images": []}),
    )
    assert result["sources"] == []
    assert "Unsupported personal fact" not in result["answer"]
    assert "couldn't find" in result["answer"]


@pytest.mark.asyncio
async def test_redirect_does_not_send_question_to_a_second_endpoint(monkeypatch):
    monkeypatch.setenv("HOSTED_VLLM_API_BASE", "http://localhost:8000/v1")
    monkeypatch.setattr(memory_search.socket, "getaddrinfo", private_dns)
    requests = []

    def redirect(request):
        requests.append(str(request.url))
        return httpx.Response(
            307,
            headers={"Location": "https://public-provider.example/v1/chat/completions"},
        )

    client = httpx.AsyncClient
    monkeypatch.setattr(
        memory_search.httpx,
        "AsyncClient",
        lambda **kwargs: client(transport=httpx.MockTransport(redirect), **kwargs),
    )
    with pytest.raises(ValueError, match="HTTP 307"):
        await memory_search.answer_memory_question(
            "private", "hosted_vllm/model", AsyncMock()
        )
    assert requests == ["http://localhost:8000/v1/chat/completions"]
