"""
`uv run pytest lib/external_api/external_api/lm_studio_api_test.py`

These tests require a local LM Studio server reachable at ``localhost:1234``
with ``nvidia/nemotron-3-nano-omni`` (or an equivalent multimodal model)
loaded. Edit the HOST / MODEL constants below to point at a different server
or model.
"""

from external_api.lm_studio_api import (
    ImageContent,
    LMStudioMessage,
    TextContent,
    get_lm_studio_completion,
)

HOST = "localhost:1234"
MODEL = "nvidia/nemotron-3-nano-omni"


def test_text_only_query():
    """Test completion with text-only query."""
    messages = [
        LMStudioMessage(
            role="user",
            content=[TextContent(text="What's the capital of France?")],
        )
    ]

    output, _ = get_lm_studio_completion(messages, model=MODEL, host=HOST)

    assert isinstance(output, LMStudioMessage)
    assert output.role == "assistant"
    assert isinstance(output.content, list)

    # Verify the response contains "Paris"
    response_text = ""
    for content_block in output.content:
        if isinstance(content_block, TextContent):
            response_text += content_block.text

    assert "Paris" in response_text or "paris" in response_text.lower()


def test_image_query():
    """Test completion with image query."""
    messages = [
        LMStudioMessage(
            role="user",
            content=[
                TextContent(text="Describe this image"),
                ImageContent(
                    source="https://images.dog.ceo/breeds/sheepdog-indian/Himalayan_Sheepdog.jpg"
                ),
            ],
        )
    ]

    output, _ = get_lm_studio_completion(messages, model=MODEL, host=HOST)

    # Verify output structure
    assert isinstance(output, LMStudioMessage)
    assert output.role == "assistant"
    assert isinstance(output.content, list)

    # Verify the response is not empty
    response_text = ""
    for content_block in output.content:
        if isinstance(content_block, TextContent):
            response_text += content_block.text

    assert len(response_text) > 0


if __name__ == "__main__":
    test_image_query()
    test_text_only_query()
