"""Build supervised examples from labeled personalization moments."""

from __future__ import annotations

import json
from collections.abc import Iterable

from personalization.schemas import JsonDict, LabeledMoment, SFTExample, stable_id

DEFAULT_OBSERVER_SFT_SYSTEM = """\
You are a personalized proactive desktop assistant.

Given the current desktop context, decide whether this user needs proactive help
right now. Be conservative: help only when the expected benefit outweighs the
interruption cost. Return only a JSON object with observation, user_intent,
need_support, rationale, suggestion_type, and suggestion.
"""


def build_sft_examples(
    labeled_moments: Iterable[LabeledMoment],
    *,
    split: str = "train",
    system_prompt: str = DEFAULT_OBSERVER_SFT_SYSTEM,
    require_images: bool = False,
    min_confidence: float = 0.0,
) -> list[SFTExample]:
    examples: list[SFTExample] = []
    for moment in labeled_moments:
        if moment.label_confidence < min_confidence:
            continue
        images = list(moment.image_paths)
        if require_images and not images:
            continue
        assistant = _assistant_target(moment)
        examples.append(
            SFTExample(
                example_id=stable_id("sft", moment.moment_id, split),
                split=split,
                source_moment_id=moment.moment_id,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": moment.observer_input},
                    {"role": "assistant", "content": json.dumps(assistant)},
                ],
                images=images,
                metadata={
                    "observation_id": moment.observation_id,
                    "session_id": moment.session_id,
                    "ts": moment.ts,
                    "need_support": moment.need_support,
                    "label_confidence": moment.label_confidence,
                    "label_sources": moment.label_sources,
                    "label_rationale": moment.label_rationale,
                    "has_images": bool(images),
                },
            )
        )
    return examples


def _assistant_target(moment: LabeledMoment) -> JsonDict:
    if moment.need_support == "no":
        return {
            "observation": moment.target_observation or "",
            "user_intent": moment.target_user_intent or "",
            "need_support": "no",
            "rationale": moment.label_rationale,
            "suggestion_type": "none",
            "suggestion": "",
        }
    return {
        "observation": moment.target_observation or "",
        "user_intent": moment.target_user_intent or "",
        "need_support": "yes",
        "rationale": moment.label_rationale,
        "suggestion_type": moment.target_suggestion_type,
        "suggestion": moment.target_suggestion,
    }


def temporal_split(
    labeled_moments: list[LabeledMoment],
    *,
    eval_fraction: float = 0.2,
) -> tuple[list[LabeledMoment], list[LabeledMoment]]:
    """Split by time so future behavior does not leak into training examples."""
    if not labeled_moments:
        return [], []
    ordered = sorted(labeled_moments, key=lambda m: m.ts)
    n_eval = max(1, round(len(ordered) * eval_fraction)) if len(ordered) > 1 else 0
    if n_eval == 0:
        return ordered, []
    return ordered[:-n_eval], ordered[-n_eval:]
