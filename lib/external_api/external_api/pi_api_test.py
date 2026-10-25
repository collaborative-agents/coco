import io
import json
from urllib.error import HTTPError

import pytest
from external_api import pi_api
from external_api.litellm_api import LiteLLMMessage
from external_api.llm import chat_completion


def test_pi_route_preserves_tool_signatures_images_and_metrics(monkeypatch):
    monkeypatch.setenv("COCO_PI_INFERENCE_URL", "http://127.0.0.1:12345/completion")
    monkeypatch.setenv("COCO_PI_BRIDGE_TOKEN", "local-secret")
    original = {
        "role": "assistant",
        "content": [{"type": "text", "text": "signed", "textSignature": "signature"}],
    }

    def respond(request, timeout):
        payload = json.loads(request.data)
        assert request.get_header("Authorization") == "Bearer local-secret"
        assert payload["model"] == "pi/test/vendor/model"
        assert payload["messages"][0]["content"][0]["type"] == "image_url"
        assert payload["messages"][1]["pi_message"] == original
        assert timeout == 130
        return io.BytesIO(
            json.dumps(
                {
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "Done"}],
                        "tool_calls": [],
                        "pi_message": original,
                    },
                    "usage": {
                        "prompt_tokens": 10,
                        "completion_tokens": 2,
                        "cache_read_input_tokens": 3,
                        "cache_creation_input_tokens": 0,
                    },
                }
            ).encode()
        )

    monkeypatch.setattr(pi_api, "urlopen", respond)
    chunks = []
    result, metrics = chat_completion(
        [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": "data:image/png;base64,YQ=="},
                    }
                ],
            },
            LiteLLMMessage(role="assistant", pi_message=original),
        ],
        model="pi/test/vendor/model",
        operation="observer",
        on_chunk=chunks.append,
    )
    assert result.pi_message == original
    assert "pi_message" not in result.model_dump()
    assert chunks == ["Done"]
    assert metrics["provider"] == "pi"
    assert metrics["modality"] == "vlm"
    assert metrics["operation"] == "observer"
    assert metrics["prompt_tokens"] == 10


def test_pi_route_fails_without_bridge_and_propagates_errors(monkeypatch):
    monkeypatch.delenv("COCO_PI_INFERENCE_URL", raising=False)
    with pytest.raises(RuntimeError, match="Start Coco"):
        pi_api.get_pi_completion([], model="pi/test/model")
    monkeypatch.setenv("COCO_PI_INFERENCE_URL", "http://127.0.0.1:12345/completion")
    monkeypatch.setenv("COCO_PI_BRIDGE_TOKEN", "local-secret")

    def fail(request, timeout):
        raise HTTPError(
            request.full_url,
            502,
            "Bad gateway",
            {},
            io.BytesIO(b'{"error":"Sign in to Pi"}'),
        )

    monkeypatch.setattr(pi_api, "urlopen", fail)
    with pytest.raises(RuntimeError, match="Sign in to Pi"):
        pi_api.get_pi_completion([], model="pi/test/model")
