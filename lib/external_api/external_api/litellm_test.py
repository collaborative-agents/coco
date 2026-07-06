"""
`uv run pytest lib/external_api/external_api/litellm_test.py`
"""

from external_api.litellm_api import (
    ImageURL,
    ImageURLContent,
    LiteLLMMessage,
    TextContent,
    get_litellm_completion,
)


def test_text_only_query():
    """Test completion with text-only query."""
    messages = [
        LiteLLMMessage(
            role="user",
            content=[TextContent(text="What's the capital of France?")],
        )
    ]

    output, _ = get_litellm_completion(messages, model="gemini/gemini-3-flash-preview")

    assert isinstance(output, LiteLLMMessage)
    assert output.role == "assistant"
    assert isinstance(output.content, list)

    # Verify the response contains "Paris"
    response_text = ""
    for content_block in output.content:
        if isinstance(content_block, TextContent):
            response_text += content_block.text
        elif isinstance(content_block, str):
            response_text += content_block

    assert "Paris" in response_text or "paris" in response_text.lower()


def test_image_query():
    """Test completion with image query."""
    messages = [
        LiteLLMMessage(
            role="user",
            content=[
                TextContent(text="Describe this image"),
                ImageURLContent(
                    image_url=ImageURL(
                        url="https://images.dog.ceo/breeds/sheepdog-indian/Himalayan_Sheepdog.jpg"
                    ),
                ),
            ],
        )
    ]

    output, _ = get_litellm_completion(messages, model="gemini/gemini-3-flash-preview")

    # Verify output structure
    assert isinstance(output, LiteLLMMessage)
    assert output.role == "assistant"
    assert isinstance(output.content, list)

    # Verify the response is not empty
    response_text = ""
    for content_block in output.content:
        if isinstance(content_block, TextContent):
            response_text += content_block.text
        elif isinstance(content_block, str):
            response_text += content_block

    assert len(response_text) > 0


if __name__ == "__main__":
    test_image_query()
    test_text_only_query()
