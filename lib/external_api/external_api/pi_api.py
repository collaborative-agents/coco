"""Authenticated local transport to Pi-owned inference and credentials."""

import json
import os
from collections.abc import Callable, Sequence
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from external_api.litellm_api import LiteLLMMessage
from external_api.types import TokenUsage


def get_pi_completion(
    messages: Sequence[LiteLLMMessage | dict],
    *,
    model: str,
    on_chunk: Callable[[str], None] | None = None,
    **options: Any,
) -> tuple[LiteLLMMessage, TokenUsage]:
    url = os.environ.get("COCO_PI_INFERENCE_URL", "")
    token = os.environ.get("COCO_PI_BRIDGE_TOKEN", "")
    if not url.startswith("http://127.0.0.1:") or not token:
        raise RuntimeError(
            "Pi inference is unavailable. Start Coco and connect a Pi provider."
        )
    payload = {
        "model": model,
        "messages": [
            {
                **message.model_dump(exclude_none=True),
                **({"pi_message": message.pi_message} if message.pi_message else {}),
            }
            if isinstance(message, LiteLLMMessage)
            else message
            for message in messages
        ],
        **options,
    }
    request = Request(
        url,
        data=json.dumps(payload).encode(),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
    )
    try:
        with urlopen(request, timeout=130) as response:
            result = json.load(response)
    except HTTPError as exc:
        try:
            detail = json.load(exc).get("error", "Pi inference failed.")
        except (ValueError, AttributeError):
            detail = f"Pi inference failed (HTTP {exc.code})."
        raise RuntimeError(detail) from exc
    output = LiteLLMMessage.model_validate(result["message"])
    if on_chunk is not None:
        text = "".join(block.text for block in output.content if hasattr(block, "text"))
        if text:
            on_chunk(text)
    return output, result["usage"]
