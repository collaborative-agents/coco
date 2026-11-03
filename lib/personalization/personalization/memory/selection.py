"""Training-sample selection for self-evolving memory."""

from __future__ import annotations

import random
from dataclasses import dataclass

from personalization.schemas import LabeledMoment
from personalization.utils.observer_output import original_need_support


@dataclass(frozen=True, slots=True)
class EvolutionSelection:
    moments: list[LabeledMoment]
    input_count: int
    original_disagreements: int
    unknown_original_predictions: int
    correct_available: int
    correct_retained: int
    adjacent_correct_anchors: int


def select_evolution_moments(
    moments: list[LabeledMoment],
    *,
    correct_sample_rate: float = 0.5,
    seed: int = 42,
) -> EvolutionSelection:
    """Retain every original error and downsample matching predictions.

    Correct examples immediately adjacent to an error in the same session are
    always retained. Remaining correct examples are sampled deterministically,
    and the returned moments preserve their original order.
    """
    if not 0.0 <= correct_sample_rate <= 1.0:
        raise ValueError("correct_sample_rate must be between 0 and 1")

    correct: list[int] = []
    disagreements: list[int] = []
    unknown: list[int] = []
    for index, moment in enumerate(moments):
        original = original_need_support(moment.observer_output)
        if original is None:
            unknown.append(index)
        elif original == moment.need_support:
            correct.append(index)
        else:
            disagreements.append(index)

    correct_set = set(correct)
    anchors: set[int] = set()
    for index in disagreements:
        for neighbor in (index - 1, index + 1):
            if (
                neighbor in correct_set
                and moments[neighbor].session_id == moments[index].session_id
            ):
                anchors.add(neighbor)

    target_correct = round(len(correct) * correct_sample_rate)
    additional_needed = max(0, target_correct - len(anchors))
    candidates = [index for index in correct if index not in anchors]
    rng = random.Random(seed)
    sampled = set(rng.sample(candidates, min(additional_needed, len(candidates))))
    retained_correct = anchors | sampled
    retained = set(disagreements) | set(unknown) | retained_correct

    return EvolutionSelection(
        moments=[moment for index, moment in enumerate(moments) if index in retained],
        input_count=len(moments),
        original_disagreements=len(disagreements),
        unknown_original_predictions=len(unknown),
        correct_available=len(correct),
        correct_retained=len(retained_correct),
        adjacent_correct_anchors=len(anchors),
    )
