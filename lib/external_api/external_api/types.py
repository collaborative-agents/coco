from typing import TypedDict


class TokenUsage(TypedDict):
    completion_tokens: int
    prompt_tokens: int
    cache_creation_input_tokens: int
    cache_read_input_tokens: int
