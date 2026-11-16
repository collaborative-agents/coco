import pytest
from external_api.qwen_thinking import QwenThinkingParser


@pytest.mark.parametrize(
    "enabled,text,reasoning,answer",
    [
        (True, "<think>Check this.</think>Answer.", "Check this.", "Answer."),
        (True, "Check this.</think>Answer.", "Check this.", "Answer."),
        (False, "<think>Check this.</think>Answer.", "Check this.", "Answer."),
        (
            False,
            "Answer with <think> as an example.",
            "",
            "Answer with <think> as an example.",
        ),
        (True, "Unfinished thought</thi", "Unfinished thought</thi", ""),
        (False, "<think></think>Answer.", "", "Answer."),
    ],
)
def test_qwen_thinking_at_every_chunk_boundary(enabled, text, reasoning, answer):
    for split in range(len(text) + 1):
        parser = QwenThinkingParser(enabled)
        deltas = parser.feed(text[:split]) + parser.feed(text[split:])
        deltas += parser.feed("", final=True)
        assert "".join(d.get("reasoning_content", "") for d in deltas) == reasoning
        assert "".join(d.get("content", "") for d in deltas) == answer
