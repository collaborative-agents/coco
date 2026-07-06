import logging
from typing import Any

import httpx
from external_api.types import TokenUsage
from pydantic import BaseModel

logging.getLogger("httpx").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)


class GeminiFunctionCall(BaseModel):
    name: str
    args: dict[str, Any]


class GeminiPart(BaseModel):
    text: str | None = None
    functionCall: GeminiFunctionCall | None = None
    functionResponse: dict[str, Any] | None = None


class GeminiContent(BaseModel):
    role: str | None = None  # "user" or "model"
    parts: list[GeminiPart]


class GeminiGenerationConfig(BaseModel):
    temperature: float | None = None
    maxOutputTokens: int | None = None
    topP: float | None = None
    topK: int | None = None


class GeminiFunctionDeclaration(BaseModel):
    name: str
    description: str | None = None
    parameters: dict[str, Any] | None = None


class GeminiTool(BaseModel):
    functionDeclarations: list[GeminiFunctionDeclaration] | None = None


class GeminiGenerateContentRequest(BaseModel):
    contents: list[GeminiContent]
    generationConfig: GeminiGenerationConfig | None = None
    tools: list[GeminiTool] | None = None


class GeminiGenerateContentResponse(BaseModel):
    candidates: list[dict[str, Any]]
    usageMetadata: dict[str, Any]


class ChatCompletionRequest(BaseModel):
    """OpenAI-compatible chat completion request accepted by the LLM router's
    /v1/chat/completions endpoint (universal LiteLLM proxy)."""

    model: str
    messages: list[dict[str, Any]]
    temperature: float | None = None
    max_tokens: int | None = None
    top_p: float | None = None
    stream: bool | None = False


def call_llm_router_completion(
    request: ChatCompletionRequest,
    router_url: str = "http://localhost:8001",
    api_key: str | None = None,
) -> dict[str, Any]:
    url = f"{router_url}/v1/chat/completions"

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    logger.info(f"Calling LLM router completion at {url} for model {request.model}")

    with httpx.Client(timeout=60.0) as client:
        response = client.post(url, json=request.model_dump(), headers=headers)
        response.raise_for_status()
        return response.json()


def call_llm_router_gemini(
    request: GeminiGenerateContentRequest,
    model: str = "gemini-2.5-pro",
    router_url: str = "http://localhost:8001",
) -> GeminiGenerateContentResponse:
    url = f"{router_url}/v1beta/models/{model}:generateContent"

    request_dict = request.model_dump()

    logger.info(f"Calling LLM router at {url} for model {model}")

    with httpx.Client(timeout=60.0) as client:
        response = client.post(
            url, json=request_dict, headers={"Content-Type": "application/json"}
        )
        response.raise_for_status()

        result = response.json()
        return GeminiGenerateContentResponse(**result)


def get_gemini_completion(
    contents: list[GeminiContent],
    model: str = "gemini-2.5-pro",
    generation_config: GeminiGenerationConfig | None = None,
    tools: list[GeminiTool] | None = None,
    router_url: str = "http://localhost:8001",
) -> tuple[GeminiGenerateContentResponse, TokenUsage]:
    request = GeminiGenerateContentRequest(
        contents=contents, generationConfig=generation_config, tools=tools
    )

    response = call_llm_router_gemini(request, model, router_url)

    # Extract token usage
    usage_metadata = response.usageMetadata
    token_usage = TokenUsage(
        prompt_tokens=usage_metadata.get("promptTokenCount", 0),
        completion_tokens=usage_metadata.get("candidatesTokenCount", 0),
        cache_creation_input_tokens=0,  # Not provided by Gemini API
        cache_read_input_tokens=0,  # Not provided by Gemini API
    )

    return response, token_usage


def create_gemini_content(
    role: str,
    text: str | None = None,
    function_call: GeminiFunctionCall | None = None,
    function_response: dict[str, Any] | None = None,
) -> GeminiContent:
    """
    Helper function to create Gemini content items.

    Args:
        role: Role of the content ("user" or "model")
        text: Text content (optional)
        function_call: Function call content (optional)
        function_response: Function response content (optional)

    Returns:
        GeminiContent: The created content item
    """
    parts = []
    if text:
        parts.append(GeminiPart(text=text))
    if function_call:
        parts.append(GeminiPart(functionCall=function_call))
    if function_response:
        parts.append(GeminiPart(functionResponse=function_response))

    return GeminiContent(role=role, parts=parts)
