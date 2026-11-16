from __future__ import annotations

import pytest
from personalization.utils.llm_resilience import (
    bounded_text,
    call_with_transient_retries,
    personalization_completion_kwargs,
    transient_llm_error,
)


class GatewayError(RuntimeError):
    def __init__(self, status_code: int):
        self.status_code = status_code
        super().__init__(f"gateway returned {status_code}")


def test_bounded_text_preserves_both_ends() -> None:
    value = f"BEGIN-{'a' * 500}-END"

    bounded = bounded_text(value, 128)

    assert len(bounded) == 128
    assert bounded.startswith("BEGIN-")
    assert bounded.endswith("-END")
    assert "personalization input truncated" in bounded


def test_qwen_personalization_disables_thinking() -> None:
    assert personalization_completion_kwargs("hosted_vllm/qwen3.5-9b") == {
        "extra_body": {"chat_template_kwargs": {"enable_thinking": False}}
    }


def test_litellm_gateway_timeout_message_is_transient() -> None:
    error = RuntimeError("Server error '504 Gateway Time-out' from LiteLLM")

    assert transient_llm_error(error) is True


def test_transient_gateway_errors_retry_with_exponential_backoff() -> None:
    attempts = 0
    delays: list[float] = []

    def flaky_call() -> str:
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise GatewayError(504)
        return "complete"

    result = call_with_transient_retries(
        flaky_call,
        operation="test",
        max_attempts=3,
        base_delay_s=0.5,
        sleep=delays.append,
    )

    assert result == "complete"
    assert attempts == 3
    assert delays == [0.5, 1.0]


def test_permanent_errors_are_not_retried() -> None:
    attempts = 0

    def invalid_request() -> None:
        nonlocal attempts
        attempts += 1
        raise GatewayError(400)

    with pytest.raises(GatewayError):
        call_with_transient_retries(
            invalid_request,
            operation="test",
            max_attempts=3,
            sleep=lambda _delay: None,
        )

    assert attempts == 1
    assert transient_llm_error(GatewayError(400)) is False
