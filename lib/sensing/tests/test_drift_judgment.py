"""Unit tests for ProgressJudgment.from_llm_output and _lenient_json_loads.

Exercises the parser against the kinds of imperfect JSON that LLMs commonly
emit: clean output, markdown-fenced blocks, surrounding prose, trailing
commas, Python-style booleans, single-quoted strings, and totally garbled
output (which should fall back safely to ``making_progress=True``).

Run with:
    pytest lib/sensing/tests/test_drift_judgment.py -v
"""

from __future__ import annotations

import pytest
from sensing.progress_detector import (
    ProgressJudgment,
    _lenient_json_loads,
    _salvage_truncated_judgment,
)

# ---------------------------------------------------------------------------
# _lenient_json_loads
# ---------------------------------------------------------------------------


class TestLenientJsonLoads:
    def test_strict_json(self):
        assert _lenient_json_loads('{"a": 1, "b": "x"}') == {"a": 1, "b": "x"}

    def test_trailing_comma_object(self):
        assert _lenient_json_loads('{"a": 1, "b": 2,}') == {"a": 1, "b": 2}

    def test_trailing_comma_array(self):
        assert _lenient_json_loads('{"xs": [1, 2, 3,]}') == {"xs": [1, 2, 3]}

    def test_python_booleans_and_none(self):
        out = _lenient_json_loads('{"making_progress": True, "x": False, "y": None}')
        assert out == {"making_progress": True, "x": False, "y": None}

    def test_single_quotes(self):
        assert _lenient_json_loads("{'a': 'hi', 'b': 2}") == {"a": "hi", "b": 2}

    def test_combined_quirks(self):
        # Trailing comma + python booleans simultaneously
        out = _lenient_json_loads('{"making_progress": False, "confidence": 0.9,}')
        assert out == {"making_progress": False, "confidence": 0.9}

    def test_empty_returns_none(self):
        assert _lenient_json_loads("") is None

    def test_unrecoverable_returns_none(self):
        assert _lenient_json_loads("definitely not json {{{") is None


# ---------------------------------------------------------------------------
# ProgressJudgment.from_llm_output
# ---------------------------------------------------------------------------


class TestProgressJudgmentFromLlmOutput:
    def test_clean_json_making_progress(self):
        text = (
            '{"making_progress": true, "confidence": 0.95, '
            '"struggle_category": "none", "evidence": "Editing the target file.", '
            '"should_intervene": false}'
        )
        j = ProgressJudgment.from_llm_output(text)
        assert j.making_progress is True
        assert j.confidence == pytest.approx(0.95)
        assert j.struggle_category == "none"
        assert j.evidence.startswith("Editing")
        assert j.should_intervene is False

    def test_clean_json_struggling(self):
        text = (
            '{"making_progress": false, "confidence": 0.8, '
            '"struggle_category": "going_in_circles", '
            '"evidence": "Switched between same 3 tabs five times.", '
            '"should_intervene": true}'
        )
        j = ProgressJudgment.from_llm_output(text)
        assert j.making_progress is False
        assert j.should_intervene is True
        assert j.struggle_category == "going_in_circles"

    def test_markdown_fence(self):
        text = (
            "Sure, here is my judgment:\n"
            "```json\n"
            '{"making_progress": false, "confidence": 0.7, '
            '"struggle_category": "stuck_on_concept", "evidence": "Same error for 3 minutes.", '
            '"should_intervene": true}\n'
            "```"
        )
        j = ProgressJudgment.from_llm_output(text)
        assert j.making_progress is False
        assert j.struggle_category == "stuck_on_concept"

    def test_prose_around_json(self):
        text = (
            "I think the user is stuck. "
            '{"making_progress": false, "confidence": 0.6, '
            '"struggle_category": "tool_friction", "evidence": "Repeatedly opens same dialog.", '
            '"should_intervene": false} '
            "Hope that helps."
        )
        j = ProgressJudgment.from_llm_output(text)
        assert j.making_progress is False
        assert j.struggle_category == "tool_friction"

    def test_trailing_comma_recovered(self):
        # The exact failure pattern that prompted the lenient parser.
        text = '{\n  "making_progress": true,\n  "confidence": 0.9,\n}'
        j = ProgressJudgment.from_llm_output(text)
        assert j.making_progress is True
        assert j.confidence == pytest.approx(0.9)

    def test_python_booleans_recovered(self):
        text = '{"making_progress": False, "confidence": 0.5, "should_intervene": True}'
        j = ProgressJudgment.from_llm_output(text)
        assert j.making_progress is False
        assert j.should_intervene is True

    def test_unparseable_defaults_to_making_progress(self):
        # Conservative fallback: never fire a false struggle nudge on garbage.
        j = ProgressJudgment.from_llm_output("the model went off the rails ¯\\_(ツ)_/¯")
        assert j.making_progress is True
        assert j.should_intervene is False
        assert j.raw  # raw is preserved for logging

    def test_missing_fields_use_defaults(self):
        # Only making_progress supplied; everything else falls back to defaults.
        j = ProgressJudgment.from_llm_output('{"making_progress": false}')
        assert j.making_progress is False
        assert j.confidence == 0.0
        assert j.struggle_category == "none"
        assert j.evidence == ""
        assert j.should_intervene is False

    def test_raw_is_preserved(self):
        text = '{"making_progress": true}'
        j = ProgressJudgment.from_llm_output(text)
        assert j.raw == text

    def test_truncated_struggle_is_salvaged(self):
        # The exact failure pattern from the live log: token cap hit mid-string.
        text = '{"making_progress": false, "confidence": 0.9, "struggle_category": "'
        j = ProgressJudgment.from_llm_output(text)
        assert j.making_progress is False
        assert j.confidence == pytest.approx(0.9)
        # Implied should_intervene=True so the struggle streak counter advances.
        assert j.should_intervene is True


# ---------------------------------------------------------------------------
# _salvage_truncated_judgment
# ---------------------------------------------------------------------------


class TestSalvageTruncatedJudgment:
    def test_recovers_making_progress_false(self):
        out = _salvage_truncated_judgment(
            '{"making_progress": false, "confidence": 0.9, "struggle_category": "going'
        )
        assert out is not None
        assert out["making_progress"] is False
        assert out["confidence"] == pytest.approx(0.9)
        assert out["should_intervene"] is True  # implied for struggling

    def test_recovers_making_progress_true(self):
        out = _salvage_truncated_judgment(
            '{"making_progress": true, "confidence": 0.4,'
        )
        assert out is not None
        assert out["making_progress"] is True
        # No should_intervene implied for making-progress; absence is the default.
        assert "should_intervene" not in out

    def test_explicit_should_intervene_preserved(self):
        out = _salvage_truncated_judgment(
            '{"making_progress": false, "should_intervene": false, "evidence": "border'
        )
        assert out is not None
        assert out["making_progress"] is False
        assert out["should_intervene"] is False  # not overridden by the implied default

    def test_returns_none_when_no_making_progress(self):
        # No recognizable making_progress field → can't salvage anything meaningful.
        assert (
            _salvage_truncated_judgment('{"confidence": 0.5, "evidence": "stuff"')
            is None
        )
        assert _salvage_truncated_judgment("totally garbled output") is None

    def test_recovers_struggle_category(self):
        out = _salvage_truncated_judgment(
            '{"making_progress": false, "struggle_category": "wrong_approach", "evidence": "yt'
        )
        assert out is not None
        assert out["struggle_category"] == "wrong_approach"
