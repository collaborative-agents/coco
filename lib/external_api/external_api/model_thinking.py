"""Identify hosted Qwen models with chat-template thinking controls."""

import re


def is_hosted_qwen(model: str) -> bool:
    return bool(re.match(r"hosted_vllm/(?:.*/)?qwen3[.\-]", model, re.I))
