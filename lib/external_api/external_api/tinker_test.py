"""
`uv run pytest lib/external_api/external_api/tinker_test.py`
"""

import pytest
from dotenv import load_dotenv
from external_api.tinker_api import (
    TinkerSampler,
    get_text_from_output,
    get_tinker_completion_sync,
)
from tinker import ServiceClient
from tinker_cookbook import renderers


@pytest.fixture
def tinker_service_account():
    load_dotenv()
    return ServiceClient()


def test_text_only_query(tinker_service_account):
    """Test completion with text-only query."""
    messages = [
        renderers.Message(
            role="user",
            content="What's the capital of France?",
        )
    ]

    output = get_tinker_completion_sync(
        messages,
        service_account=tinker_service_account,
        model_name="Qwen/Qwen3-4B-Instruct-2507",
    )

    assert output["role"] == "assistant"
    text = get_text_from_output(output)

    # Verify the response contains "Paris"
    assert "Paris" in text or "paris" in text.lower()


def test_text_only_query_thinking_model(tinker_service_account):
    """Test completion with text-only query."""
    messages = [
        renderers.Message(
            role="user",
            content="What's the capital of France?",
        )
    ]

    output = get_tinker_completion_sync(
        messages,
        service_account=tinker_service_account,
        model_name="moonshotai/Kimi-K2.6",
    )

    assert output["role"] == "assistant"
    # Thinking models return content as a list of parts; collapse to text.
    text = get_text_from_output(output)

    # Verify the response contains "Paris"
    assert "Paris" in text or "paris" in text.lower()


def test_reuse_sampler(tinker_service_account):
    """Pre-built TinkerSampler is reused across calls instead of being rebuilt."""
    sampler = TinkerSampler(
        service_account=tinker_service_account,
        model_name="Qwen/Qwen3-4B-Instruct-2507",
    )
    sampling_client_id = id(sampler.sampling_client)

    messages = [renderers.Message(role="user", content="What's the capital of France?")]
    first = get_tinker_completion_sync(messages, sampler=sampler)
    second = get_tinker_completion_sync(messages, sampler=sampler)

    assert first["role"] == "assistant"
    assert second["role"] == "assistant"
    assert "paris" in get_text_from_output(first).lower()
    assert "paris" in get_text_from_output(second).lower()
    # The same SamplingClient instance was reused for both calls.
    assert id(sampler.sampling_client) == sampling_client_id


if __name__ == "__main__":
    test_text_only_query(tinker_service_account())
    test_text_only_query_thinking_model(tinker_service_account())
    test_reuse_sampler(tinker_service_account())
