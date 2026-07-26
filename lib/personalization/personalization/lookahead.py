"""Look-ahead critique for memory-worthy observer notes.

Given future moments where user interaction established that support was needed,
this pipeline queries Coco memory with the revised user intent and asks a
configurable teacher/VLM what retrieved earlier notes should have captured. The
future event is supervision, not information that may leak into the rewritten
past observation.
"""

from __future__ import annotations

import base64
import json
import mimetypes
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from external_api.llm import chat_completion
from memory.models import PropositionHit
from memory.store import MemoryStore
from tqdm import tqdm

from personalization.labeling import observer_observation, observer_user_intent
from personalization.memory.utils import parse_json_obj, sample_frames
from personalization.schemas import LabeledMoment, ObservationRecord, SessionRecords

_TEACHER_SYSTEM = """\
You are the look-ahead critique stage for a proactive desktop assistant's
note-taking system. Earlier observer notes may later be stored in user memory.
You are given a FUTURE moment where interaction evidence established that the
user needed support, plus several PAST observations retrieved from Coco memory.

For every past candidate:
1. Judge how useful that past moment is for understanding or helping with the
   future need.
2. Critique what its original observation omitted, overemphasized, or described
   too vaguely.
3. Rewrite the past observation so it retains the minimum sufficient facts that
   would be maximally useful for the future need.

Rules:
- HINDSIGHT WITHOUT LEAKAGE: use the future need only to decide which
  contemporaneous facts mattered. The improved past observation must contain
  only facts visible in its past screenshots, action context, or original
  observer output. Never mention the future event or imply it was already known.
- Preserve concrete screenshot details that carry future value: application and
  file names, commands, errors, artifacts, workflow state, repeated attempts,
  relevant values, and meaningful changes over time.
- Do not invent a detail. Do not preserve incidental or sensitive details that
  are unnecessary for understanding the work.
- Optimize for both future helpfulness and token efficiency. Prefer precise
  evidence over generic interpretation or narrative filler.
- Keep each improved observation within {max_observation_words} words.
- Return one result for every supplied past observation_id, in the same order.

Return only this JSON object:
{
  "critiques": [
    {
      "observation_id": "<exact supplied id>",
      "useful_for_future_need": true,
      "helpfulness_score": 1,
      "critique": "<what should have been noted differently; 1-2 sentences>",
      "improved_observation": "<grounded, concise replacement note>"
    }
  ]
}

helpfulness_score is an integer from 1 (little future value) to 5 (critical).
"""


@dataclass(slots=True)
class ObservationContext:
    record: ObservationRecord
    session_path: str

    @property
    def observation(self) -> str:
        return observer_observation(self.record.observer_output)

    @property
    def user_intent(self) -> str | None:
        return observer_user_intent(self.record.observer_output)


@dataclass(slots=True)
class RetrievedObservation:
    context: ObservationContext
    relevance_score: float
    seconds_before_need: float
    memory_observation_content: str
    memory_propositions: list[dict[str, Any]]


@dataclass(slots=True)
class LookAheadTask:
    future_label: LabeledMoment
    future_context: ObservationContext
    past: list[RetrievedObservation]
    future_was_revised: bool = False


def build_lookahead_tasks(
    sessions: list[SessionRecords],
    memory_store: MemoryStore,
    labeled: list[LabeledMoment],
    *,
    revised: list[LabeledMoment] | None = None,
    limit: int,
    max_past_observations: int = 4,
    memory_proposition_limit: int = 12,
    memory_evidence_limit: int = 10,
) -> tuple[list[LookAheadTask], int]:
    """Build tasks by querying Coco memory with each future revised intent."""
    merged = {row.moment_id: row for row in labeled}
    revised_by_id = {row.moment_id: row for row in revised or []}
    merged.update(revised_by_id)
    contexts_by_observation: dict[str, ObservationContext] = {}
    for session in sessions:
        for record in session.observations:
            context = ObservationContext(record=record, session_path=session.path)
            if context.record.observation_id:
                contexts_by_observation[context.record.observation_id] = context

    eligible_tasks: list[LookAheadTask] = []
    future_labels = sorted(
        (row for row in merged.values() if row.need_support == "yes"),
        key=lambda row: row.ts,
    )
    for future_label in future_labels:
        future_context = contexts_by_observation.get(future_label.observation_id)
        if future_context is None:
            continue
        retrieved = retrieve_observations_from_memory(
            memory_store,
            contexts_by_observation,
            future_label,
            future_ts=future_context.record.ts,
            limit=max_past_observations,
            proposition_limit=memory_proposition_limit,
            evidence_limit=memory_evidence_limit,
        )
        if retrieved:
            eligible_tasks.append(
                LookAheadTask(
                    future_label=future_label,
                    future_context=future_context,
                    past=retrieved,
                    future_was_revised=future_label.moment_id in revised_by_id,
                )
            )
    return eligible_tasks[:limit], len(eligible_tasks)


def retrieve_observations_from_memory(
    memory_store: MemoryStore,
    contexts_by_observation: dict[str, ObservationContext],
    future_label: LabeledMoment,
    *,
    future_ts: float,
    limit: int,
    proposition_limit: int,
    evidence_limit: int,
) -> list[RetrievedObservation]:
    """Use future intent to retrieve proposition evidence from Coco memory."""
    intent = str(future_label.target_user_intent or "").strip()
    if not intent or limit <= 0:
        return []
    hits = memory_store.search(
        intent,
        limit=proposition_limit,
        include_observations=0,
    )
    retrieved: dict[str, RetrievedObservation] = {}
    for hit in hits:
        proposition = _proposition_payload(hit)
        evidence_ids = memory_store.related_observation_ids([hit.proposition.id])
        historical_evidence = [
            observation
            for observation in memory_store.observations_by_id(evidence_ids)
            if observation.created_at < future_ts
        ][:evidence_limit]
        for memory_observation in historical_evidence:
            context = contexts_by_observation.get(memory_observation.id)
            if context is None or context.record.ts >= future_ts:
                continue
            existing = retrieved.get(memory_observation.id)
            if existing is None:
                retrieved[memory_observation.id] = RetrievedObservation(
                    context=context,
                    relevance_score=round(hit.score, 6),
                    seconds_before_need=round(
                        max(0.0, future_ts - context.record.ts),
                        3,
                    ),
                    memory_observation_content=memory_observation.content,
                    memory_propositions=[proposition],
                )
            else:
                existing.relevance_score = max(
                    existing.relevance_score,
                    round(hit.score, 6),
                )
                if proposition["id"] not in {
                    item["id"] for item in existing.memory_propositions
                }:
                    existing.memory_propositions.append(proposition)
    ranked = list(retrieved.values())
    ranked.sort(
        key=lambda item: (
            item.relevance_score,
            item.context.record.ts,
        ),
        reverse=True,
    )
    return ranked[:limit]


def run_lookahead_critique(
    tasks: list[LookAheadTask],
    *,
    model: str,
    concurrency: int = 4,
    max_action_chars: int = 5000,
    max_observation_words: int = 80,
    max_tokens: int = 4096,
    include_images: bool = False,
    max_images_per_moment: int = 2,
    show_progress: bool = False,
    retries: int = 2,
) -> list[dict[str, Any]]:
    if not model:
        raise ValueError("model is required")
    if concurrency < 1:
        raise ValueError("concurrency must be at least 1")
    if retries < 0:
        raise ValueError("retries must be at least 0")
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {
            pool.submit(
                critique_task,
                task,
                model=model,
                max_action_chars=max_action_chars,
                max_observation_words=max_observation_words,
                max_tokens=max_tokens,
                include_images=include_images,
                max_images_per_moment=max_images_per_moment,
                retries=retries,
            ): index
            for index, task in enumerate(tasks)
        }
        artifacts: list[dict[str, Any] | None] = [None] * len(tasks)
        with tqdm(
            total=len(tasks),
            desc="Critiquing observations",
            unit="moment",
            disable=not show_progress,
        ) as progress:
            for future in as_completed(futures):
                artifacts[futures[future]] = future.result()
                progress.update()
    return [artifact for artifact in artifacts if artifact is not None]


def critique_task(
    task: LookAheadTask,
    *,
    model: str,
    max_action_chars: int,
    max_observation_words: int,
    max_tokens: int,
    include_images: bool,
    max_images_per_moment: int,
    retries: int = 2,
) -> dict[str, Any]:
    if retries < 0:
        raise ValueError("retries must be at least 0")
    base_messages = _teacher_messages(
        task,
        max_action_chars=max_action_chars,
        max_observation_words=max_observation_words,
        include_images=include_images,
        max_images_per_moment=max_images_per_moment,
    )
    raw_attempts: list[str] = []
    metrics_attempts: list[dict[str, Any]] = []
    critiques: list[dict[str, Any]] | None = None
    last_error: ValueError | None = None
    for attempt in range(retries + 1):
        messages = list(base_messages)
        if raw_attempts:
            messages.extend(
                [
                    {"role": "assistant", "content": raw_attempts[-1]},
                    {
                        "role": "user",
                        "content": _retry_prompt(task, last_error),
                    },
                ]
            )
        response, metrics = chat_completion(
            messages,
            model=model,
            temperature=0.0,
            max_tokens=max_tokens,
            operation="personalization.lookahead_observation_critique",
        )
        raw = _response_text(response)
        raw_attempts.append(raw)
        metrics_attempts.append(dict(metrics))
        try:
            parsed = parse_json_obj(raw)
            critiques = _validated_critiques(
                parsed,
                task,
                max_observation_words,
            )
            break
        except ValueError as error:
            last_error = error
            if attempt == retries:
                raise ValueError(
                    "look-ahead teacher returned an invalid response after "
                    f"{retries + 1} attempts: {error}"
                ) from error

    if critiques is None:
        raise RuntimeError("look-ahead critique completed without a result")
    return {
        "future_moment": _future_payload(task),
        "retrieved_past": [_past_payload(item, max_action_chars) for item in task.past],
        "critiques": critiques,
        "teacher_model": model,
        "teacher_config": {
            "max_action_chars": max_action_chars,
            "max_observation_words": max_observation_words,
            "max_tokens": max_tokens,
            "include_images": include_images,
            "max_images_per_moment": max_images_per_moment,
            "retries": retries,
        },
        "teacher_attempts": len(raw_attempts),
        "teacher_raw": raw_attempts[-1],
        "teacher_raw_attempts": raw_attempts,
        "llm_metrics": metrics_attempts[-1],
        "llm_metrics_attempts": metrics_attempts,
    }


def _retry_prompt(task: LookAheadTask, error: ValueError | None) -> str:
    expected_ids = [retrieved.context.record.observation_id for retrieved in task.past]
    return (
        "Your previous response was invalid and could not be stored.\n"
        f"Validation error: {error}\n"
        "Return only one valid JSON object with a `critiques` list. Include "
        "exactly one complete critique for every observation_id, in this order: "
        f"{json.dumps(expected_ids)}. Do not use Markdown fences or add prose."
    )


def _teacher_messages(
    task: LookAheadTask,
    *,
    max_action_chars: int,
    max_observation_words: int,
    include_images: bool,
    max_images_per_moment: int,
) -> list[dict[str, Any]]:
    future = task.future_label
    content: list[dict[str, Any]] = [
        {
            "type": "text",
            "text": (
                "<future_support_need>\n"
                f"observation_id: {future.observation_id}\n"
                f"observation: {future.target_observation or ''}\n"
                f"user_intent: {future.target_user_intent or ''}\n"
                f"label_rationale: {future.label_rationale}\n"
                f"suggestion: {future.target_suggestion or '(none)'}\n"
                "future_action_context:\n"
                f"{_truncate_middle(task.future_context.record.observer_input, max_action_chars)}\n"
                "</future_support_need>\n\n"
                "The following candidates were retrieved from Coco memory and "
                "occurred before this future support need."
            ),
        }
    ]
    for index, item in enumerate(task.past, 1):
        record = item.context.record
        content.append(
            {
                "type": "text",
                "text": (
                    f'\n<past_candidate index="{index}">\n'
                    f"observation_id: {record.observation_id}\n"
                    f"seconds_before_future_need: {item.seconds_before_need}\n"
                    f"retrieval_score: {item.relevance_score}\n"
                    "matched_memory_propositions:\n"
                    f"{json.dumps(item.memory_propositions, ensure_ascii=False)}\n"
                    f"original_observation: {item.context.observation}\n"
                    f"original_user_intent: {item.context.user_intent or ''}\n"
                    "past_action_context:\n"
                    f"{_truncate_middle(record.observer_input, max_action_chars)}\n"
                    "</past_candidate>"
                ),
            }
        )
        if include_images:
            for path in _existing_frames(record, max_images_per_moment):
                content.extend(
                    [
                        {
                            "type": "text",
                            "text": (
                                f"Retained frame for past observation "
                                f"{record.observation_id}: {path.name}"
                            ),
                        },
                        _image_content(path),
                    ]
                )

    if include_images:
        for path in _existing_frames(
            task.future_context.record,
            max_images_per_moment,
        ):
            content.extend(
                [
                    {
                        "type": "text",
                        "text": f"Retained frame for future support need: {path.name}",
                    },
                    _image_content(path),
                ]
            )
    content.append(
        {
            "type": "text",
            "text": (
                "\nCritique every supplied past candidate. Return only the required "
                "JSON object."
            ),
        }
    )
    return [
        {
            "role": "system",
            "content": _TEACHER_SYSTEM.replace(
                "{max_observation_words}",
                str(max_observation_words),
            ),
        },
        {"role": "user", "content": content},
    ]


def _validated_critiques(
    parsed: dict[str, Any] | None,
    task: LookAheadTask,
    max_observation_words: int,
) -> list[dict[str, Any]]:
    raw_critiques = parsed.get("critiques") if parsed else None
    if not isinstance(raw_critiques, list):
        raise ValueError("teacher returned invalid JSON: critiques must be a list")
    by_id = {
        str(item.get("observation_id")): item
        for item in raw_critiques
        if isinstance(item, dict) and item.get("observation_id")
    }
    output: list[dict[str, Any]] = []
    for retrieved in task.past:
        observation_id = retrieved.context.record.observation_id
        item = by_id.get(observation_id)
        if item is None:
            raise ValueError(
                f"teacher omitted critique for past observation {observation_id}"
            )
        critique = str(item.get("critique") or "").strip()
        improved = str(item.get("improved_observation") or "").strip()
        if not critique or not improved:
            raise ValueError(
                f"teacher returned empty critique or improved observation "
                f"for {observation_id}"
            )
        try:
            helpfulness = int(item.get("helpfulness_score"))
        except (TypeError, ValueError):
            helpfulness = 0
        helpfulness = min(5, max(1, helpfulness))
        word_count = len(improved.split())
        output.append(
            {
                "observation_id": observation_id,
                "useful_for_future_need": _as_bool(item.get("useful_for_future_need")),
                "helpfulness_score": helpfulness,
                "critique": critique,
                "original_observation": retrieved.context.observation,
                "improved_observation": improved,
                "improved_observation_word_count": word_count,
                "within_word_budget": word_count <= max_observation_words,
            }
        )
    return output


def _future_payload(task: LookAheadTask) -> dict[str, Any]:
    label = task.future_label
    return {
        "moment_id": label.moment_id,
        "observation_id": label.observation_id,
        "session_path": task.future_context.session_path,
        "ts": label.ts,
        "need_support": label.need_support,
        "label_confidence": label.label_confidence,
        "label_sources": label.label_sources,
        "label_rationale": label.label_rationale,
        "observation": label.target_observation,
        "user_intent": label.target_user_intent,
        "suggestion": label.target_suggestion,
        "used_revised_label_target": task.future_was_revised,
        "memory_query": label.target_user_intent,
        "frame_paths": [
            str(path) for path in _existing_frames(task.future_context.record, 0)
        ],
    }


def _past_payload(
    item: RetrievedObservation,
    max_action_chars: int,
) -> dict[str, Any]:
    record = item.context.record
    return {
        "observation_id": record.observation_id,
        "ts": record.ts,
        "seconds_before_future_need": item.seconds_before_need,
        "retrieval_score": item.relevance_score,
        "memory_observation_content": item.memory_observation_content,
        "memory_propositions": item.memory_propositions,
        "original_observation": item.context.observation,
        "original_user_intent": item.context.user_intent,
        "action_context": _truncate_middle(record.observer_input, max_action_chars),
        "frame_paths": [str(path) for path in _existing_frames(record, 0)],
    }


def _proposition_payload(hit: PropositionHit) -> dict[str, Any]:
    proposition = hit.proposition
    return {
        "id": proposition.id,
        "text": proposition.text,
        "reasoning": proposition.reasoning,
        "score": round(hit.score, 6),
        "confidence": proposition.confidence,
        "durability": proposition.decay,
    }


def _truncate_middle(text: str, limit: int) -> str:
    if limit <= 0 or len(text) <= limit:
        return text
    marker = "\n… [middle omitted for token efficiency] …\n"
    remaining = max(0, limit - len(marker))
    head = remaining // 2
    tail = remaining - head
    tail_text = text[-tail:] if tail else ""
    return text[:head] + marker + tail_text


def _existing_frames(record: ObservationRecord, max_images: int) -> list[Path]:
    raw = record.retained_screenshots or record.screenshot_paths
    paths = [Path(path).expanduser() for path in raw]
    return sample_frames([path for path in paths if path.is_file()], max_images)


def _image_content(path: Path) -> dict[str, Any]:
    mime = mimetypes.guess_type(path.name)[0] or "image/png"
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return {
        "type": "image_url",
        "image_url": {"url": f"data:{mime};base64,{encoded}"},
    }


def _response_text(response: Any) -> str:
    content = response.content
    if isinstance(content, str):
        return content
    first = content[0] if content else None
    if isinstance(first, str):
        return first
    return str(getattr(first, "text", "") or "")


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes"}


def validate_lookahead_config(**values: int | float) -> None:
    positive = {
        "limit",
        "max_past_observations",
        "memory_proposition_limit",
        "memory_evidence_limit",
        "max_action_chars",
        "max_observation_words",
        "max_tokens",
        "concurrency",
        "max_images_per_moment",
    }
    for name, value in values.items():
        if name in positive and value < 1:
            raise ValueError(f"{name} must be at least 1")
        if name not in positive and value < 0:
            raise ValueError(f"{name} must be non-negative")
