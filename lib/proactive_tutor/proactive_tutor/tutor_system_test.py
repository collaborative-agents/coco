"""
Test file for TutorSystem functionality.

```
cd lib/proactive_tutor
uv run python -m pytest proactive_tutor/tutor_system_test.py
```
"""

import json
import os

import pytest
from proactive_tutor.tutor_system import TutorSystem
from py_utils.training_recorder import TrainingRecorder

MODEL = "gemini/gemini-3-flash-preview"

requires_llm = pytest.mark.skipif(
    os.getenv("RUN_LIVE_TUTOR_TESTS") != "1",
    reason="RUN_LIVE_TUTOR_TESTS=1 not set",
)


def _make_tutor_system() -> TutorSystem:
    return TutorSystem(model_name=MODEL)


# ------------------------------------------------------------------
# Unit tests (no LLM needed)
# ------------------------------------------------------------------


def test_initialization():
    """TutorSystem creates its tutor agent from prompt files."""
    ts = _make_tutor_system()
    assert ts.tutor_agent is not None
    assert ts.problem_statement == ""
    assert ts.conversation_history == []
    assert ts.image_num == 0


def test_memory_tool_is_limited_to_everyday_support():
    everyday = TutorSystem(model_name=MODEL, scenario="everyday_support")
    student = TutorSystem(model_name=MODEL, scenario="student_learning")

    assert everyday.tutor_agent.enable_memory_tool is True
    assert student.tutor_agent.enable_memory_tool is False

    everyday.set_scenario("student_learning")
    assert everyday.tutor_agent.enable_memory_tool is False


def test_handle_problem_statement():
    """handle_problem_statement stores the problem text."""
    ts = _make_tutor_system()
    ts.handle_problem_statement("Solve the equation: 2x + 5 = 13")
    assert ts.problem_statement == "Solve the equation: 2x + 5 = 13"


def test_get_kargs():
    """get_kargs returns the expected context dict."""
    ts = _make_tutor_system()
    ts.problem_statement = "Test problem"
    ts.conversation_history = ["entry1"]
    ts.image_num = 3

    kargs = ts.get_kargs()
    assert kargs["conversation_history"] == ["entry1"]
    assert kargs["problem_statement"] == "Test problem"
    assert kargs["image_num"] == 3
    assert kargs["curriculum_state"] == ts.curriculum_state
    assert kargs["competency_counts"] == ts.competency_counts


def test_handle_user_prompt_with_metrics_logs_tutor_call(tmp_path):
    """Metrics returned by the tutor agent are returned and recorded."""
    metrics = {
        "call_id": "call-test",
        "operation": "tutor",
        "model": "fake-model",
        "provider": "fake",
        "modality": "llm",
        "prompt_tokens": 12,
        "completion_tokens": 5,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
        "input_tokens": 12,
        "output_tokens": 5,
        "total_tokens": 17,
        "duration_ms": 42.5,
        "started_at": 100.0,
        "ended_at": 100.0425,
        "success": True,
        "error": None,
    }

    class FakeTutorAgent:
        model = "fake-model"

        def chat_with_metrics(self, messages, image_paths=None):
            assert messages[-1] == {
                "role": "user",
                "content": "Explain the next step",
            }
            assert image_paths == ["screen.png"]
            return '{"guidance": "Use metrics."}', metrics

    ts = _make_tutor_system()
    ts.tutor_agent = FakeTutorAgent()
    ts._recorder = TrainingRecorder(str(tmp_path), retain_screenshots=False)

    guidance, returned_metrics = ts.handle_user_prompt_with_metrics(
        obs="The user is comparing two AI responses.",
        image_paths=["screen.png"],
        user_text="Explain the next step",
    )

    assert guidance == '{"guidance": "Use metrics."}'
    assert returned_metrics == metrics
    assert len(ts.conversation_history) == 2

    rows = [
        json.loads(line)
        for line in (tmp_path / "tutor_calls.jsonl").read_text().splitlines()
    ]
    assert len(rows) == 1
    assert rows[0]["trigger"] == "user_prompt"
    assert rows[0]["llm_metrics"] == metrics
    assert rows[0]["image_paths"] == ["screen.png"]


def test_everyday_chat_preserves_message_boundaries_and_omits_supplied_observation():
    calls = []

    class FakeChatAgent:
        model = "fake-model"

        def chat_with_metrics(self, messages, image_paths=None):
            calls.append(messages)
            return f"reply {len(calls)}", {
                "call_id": f"call-{len(calls)}",
                "operation": "tutor",
                "model": "fake-model",
                "provider": "fake",
                "modality": "llm",
                "prompt_tokens": 1,
                "completion_tokens": 1,
                "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": 0,
                "input_tokens": 1,
                "output_tokens": 1,
                "total_tokens": 2,
                "duration_ms": 1.0,
                "started_at": 1.0,
                "ended_at": 2.0,
                "success": True,
                "error": None,
            }

    ts = _make_tutor_system()
    ts.memory = "The user prefers concise answers."
    ts.tutor_agent = FakeChatAgent()

    ts.handle_user_prompt_with_metrics(
        obs="SCREEN OBSERVATION MUST NOT BE INJECTED",
        user_text="First question",
    )
    ts.handle_user_prompt_with_metrics(
        obs="ANOTHER SCREEN OBSERVATION",
        user_text="Follow-up question",
    )

    assert [message["role"] for message in calls[0]] == ["system", "user"]
    assert [message["role"] for message in calls[1]] == [
        "system",
        "user",
        "assistant",
        "user",
    ]
    assert calls[1][0]["content"].endswith("The user prefers concise answers.")
    assert calls[1][1:] == [
        {"role": "user", "content": "First question"},
        {"role": "assistant", "content": "reply 1"},
        {"role": "user", "content": "Follow-up question"},
    ]
    assert all("SCREEN OBSERVATION" not in str(call) for call in calls)


# ------------------------------------------------------------------
# Integration tests (real LLM calls)
# ------------------------------------------------------------------


@requires_llm
def test_handle_user_prompt():
    """handle_user_prompt returns a non-empty string and appends to history."""
    ts = _make_tutor_system()

    result = ts.handle_user_prompt(
        obs="The student wrote x=3 but the answer is x=4.",
        user_text="Problem: Solve 2x + 5 = 13",
    )

    assert isinstance(result, str)
    assert len(result) > 0
    assert len(ts.conversation_history) == 1


@requires_llm
def test_handle_pause():
    """handle_pause returns a non-empty string and appends to history."""
    ts = _make_tutor_system()

    result = ts.handle_pause(
        obs="Student has stopped writing for 30 seconds.",
        evidence="Problem: Solve 2x + 5 = 13",
    )

    assert isinstance(result, str)
    assert len(result) > 0
    assert len(ts.conversation_history) == 1


@requires_llm
def test_conversation_history_accumulates():
    """Multiple events accumulate in conversation_history."""
    ts = _make_tutor_system()

    ts.handle_user_prompt(obs="obs1", user_text="Problem: Solve x+1=2")
    ts.handle_pause(obs="obs2", evidence="Problem: Solve x+1=2")

    assert len(ts.conversation_history) == 2
    for entry in ts.conversation_history:
        assert isinstance(entry, str)
        assert len(entry) > 0


if __name__ == "__main__":
    import sys

    sys.exit(pytest.main([__file__, "-v"]))
