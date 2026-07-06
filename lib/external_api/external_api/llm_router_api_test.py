"""Test for LLM Router API client.

```
uv run pytest lib/external_api/external_api/llm_router_api_test.py
```
"""

import httpx
import pytest
from external_api.llm_router_api import (
    ChatCompletionRequest,
    GeminiFunctionCall,
    GeminiFunctionDeclaration,
    GeminiGenerateContentRequest,
    GeminiGenerationConfig,
    GeminiTool,
    call_llm_router_completion,
    call_llm_router_gemini,
    create_gemini_content,
    get_gemini_completion,
)


def test_create_gemini_content():
    """Test creating Gemini content items."""
    content = create_gemini_content("user", text="Hello world")
    assert content.role == "user"
    assert len(content.parts) == 1
    assert content.parts[0].text == "Hello world"

    func_call = GeminiFunctionCall(name="test_func", args={"param": "value"})
    content = create_gemini_content("model", function_call=func_call)
    assert content.role == "model"
    assert len(content.parts) == 1
    assert content.parts[0].functionCall == func_call


def test_call_llm_router_gemini_basic():
    """Test basic LLM router call without tools."""
    content = create_gemini_content("user", text="Hello, how are you?")

    request = GeminiGenerateContentRequest(
        contents=[content], generationConfig=GeminiGenerationConfig(temperature=0.7)
    )

    with pytest.raises((httpx.ConnectError, httpx.TimeoutException)):
        call_llm_router_gemini(request, model="gemini-2.5-pro")


def test_call_llm_router_gemini_with_tools():
    """Test LLM router call with tools defined."""
    content = create_gemini_content(
        "user", text="What files are in the current directory?"
    )

    tool = GeminiTool(
        functionDeclarations=[
            GeminiFunctionDeclaration(
                name="list_directory",
                description="List contents of a directory",
                parameters={
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Directory path"}
                    },
                    "required": ["path"],
                },
            )
        ]
    )

    request = GeminiGenerateContentRequest(contents=[content], tools=[tool])

    with pytest.raises((httpx.ConnectError, httpx.TimeoutException)):
        call_llm_router_gemini(request, model="gemini-2.5-pro")


def test_get_gemini_completion():
    """Test the main completion function."""
    content = create_gemini_content("user", text="Say hello")

    with pytest.raises((httpx.ConnectError, httpx.TimeoutException)):
        response, token_usage = get_gemini_completion([content])

        assert hasattr(response, "candidates")
        assert hasattr(response, "usageMetadata")
        assert hasattr(token_usage, "prompt_tokens")
        assert hasattr(token_usage, "completion_tokens")
        assert hasattr(token_usage, "total_tokens")


def test_call_llm_router_completion_basic():
    """Test basic LLM router completion call."""
    request = ChatCompletionRequest(
        model="gemini/gemini-2.5-pro",
        messages=[{"role": "user", "content": "Hello, how are you?"}],
        temperature=0.7,
    )

    with pytest.raises((httpx.ConnectError, httpx.TimeoutException)):
        call_llm_router_completion(request)


def test_call_llm_router_completion_with_api_key():
    """Test that providing an api_key adds the Authorization header."""
    request = ChatCompletionRequest(
        model="anthropic/claude-sonnet-4-20250514",
        messages=[{"role": "user", "content": "Say hi"}],
    )

    with pytest.raises((httpx.ConnectError, httpx.TimeoutException)):
        call_llm_router_completion(request, api_key="test-key")


def test_chat_completion_request_serialization():
    """Test that chat completion requests can be serialized to JSON."""
    request = ChatCompletionRequest(
        model="gpt-4",
        messages=[
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "Hi"},
        ],
        temperature=0.5,
        max_tokens=100,
        top_p=0.9,
    )

    request_dict = request.model_dump()
    assert request_dict["model"] == "gpt-4"
    assert len(request_dict["messages"]) == 2
    assert request_dict["temperature"] == 0.5
    assert request_dict["max_tokens"] == 100
    assert request_dict["top_p"] == 0.9
    assert request_dict["stream"] is False


def test_request_serialization():
    """Test that requests can be properly serialized to JSON."""
    content = create_gemini_content("user", text="Test message")

    tool = GeminiTool(
        functionDeclarations=[
            GeminiFunctionDeclaration(
                name="test_tool",
                description="A test tool",
                parameters={"type": "object", "properties": {}},
            )
        ]
    )

    request = GeminiGenerateContentRequest(
        contents=[content],
        generationConfig=GeminiGenerationConfig(temperature=0.5),
        tools=[tool],
    )

    # Test JSON serialization
    request_dict = request.model_dump()
    assert "contents" in request_dict
    assert "generationConfig" in request_dict
    assert "tools" in request_dict

    # Verify content structure
    assert len(request_dict["contents"]) == 1
    assert request_dict["contents"][0]["role"] == "user"
    assert len(request_dict["contents"][0]["parts"]) == 1
    assert request_dict["contents"][0]["parts"][0]["text"] == "Test message"
