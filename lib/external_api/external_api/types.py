from typing import Literal, TypedDict


class TokenUsage(TypedDict):
    completion_tokens: int
    prompt_tokens: int
    cache_creation_input_tokens: int
    cache_read_input_tokens: int


class LLMCallMetrics(TokenUsage):
    """Normalized observability data for one completed model call.

    ``input_tokens`` / ``output_tokens`` mirror the provider-neutral
    ``prompt_tokens`` / ``completion_tokens`` names so frontend and logging code
    can use either vocabulary without re-mapping.
    """

    call_id: str
    operation: str | None
    model: str
    provider: str
    modality: Literal["llm", "vlm"]
    input_tokens: int
    output_tokens: int
    total_tokens: int
    duration_ms: float
    started_at: float
    ended_at: float
    success: bool
    error: str | None
