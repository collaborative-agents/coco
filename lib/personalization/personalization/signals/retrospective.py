"""Large-context discovery of high-value missed support opportunities."""

from __future__ import annotations

import json
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from external_api.llm import chat_completion
from tqdm import tqdm

from personalization.records import write_jsonl
from personalization.schemas import (
    ObservationRecord,
    SessionRecords,
    ShortWindowSignal,
    stable_id,
)
from personalization.signals.missed_opportunities import (
    no_suggestion_observation_ids,
)
from personalization.signals.user_feedback import DEFAULT_SIGNAL_TTL_S
from personalization.utils.llm_io import parse_json_object, response_text
from personalization.utils.observer_output import (
    observer_observation,
    observer_user_intent,
    original_need_support,
)

RETROSPECTIVE_CATEGORIES = {"repetitive_work", "stuck", "anticipate_need"}
_MODEL_JSON_MAX_ATTEMPTS = 3
_MODEL_MAX_OUTPUT_TOKENS = 8192
# Keep the complete system + user input comfortably below the remaining input
# side of a 32K context window. Observation fields are truncated before packing,
# and the timeline is split at record boundaries when this limit is reached.
_DEFAULT_MAX_INPUT_CHARS = 48_000

DISCOVERY_SYSTEM_PROMPT = """\
You retrospectively inspect a large chronological desktop-work timeline to discover a small set of HIGH-LEVEL, reusable proactive-support opportunities.

Use these retrospective principles:
- Later behavior may reveal repetitive work, stuckness, or an anticipatable need, but assistance must have been inferable before the later behavior.
- A later manual invocation of chatbot (e.g. ChatGPT), AI agent, or another assistance tool can be positive evidence that Coco missed an earlier opportunity to provide the same coherent support. Infer the opportunity at the earlier trigger; do not propose interrupting after equivalent assistance is already active.
- Do not treat every AI-tool use as a missed opportunity. It must reveal a reusable, high-value need that was inferable from the preceding workflow.
- Support must save substantial time, prevent a meaningful error, or unblock a task strongly enough to justify interruption.
- Respect stated user preferences and prior negative feedback. Never infer a preference merely from silence.
- Be conservative and use only supplied evidence.

Reason across the WHOLE timeline instead of labeling each observation independently. Merge repeated local symptoms into the underlying workflow. We want rules at this level:

1. If the user spends a sustained period reading a PDF for a project, it may be helpful to suggest working together to create structured notes, comparisons, or a project-specific synthesis.
2. If the user frequently launches, monitors, or records experiments manually, suggest using an agent to launch the experiments, monitor failures, and organize the results for review.

Do not produce narrow opportunities such as fixing one SSH failure, correcting one command, flagging one typo, or explaining one transient error. Those events may be evidence of a broader workflow, but the proposed support must remain useful if the local symptom disappears.

At this stage, find the opportunity and its supporting evidence only.
Do NOT select a correction target or trigger. evidence_observation_ids must contain at least three UNIQUE supplied IDs establishing what the user later did or that the workflow recurred.
Evidence is behavioral proof, not a label target: an evidence observation may have original_need_support="yes" or "no" and does not need to be a candidate_no_intervention moment. Later manual AI use is valid evidence.
Prefer evidence distributed across time rather than several nearly identical adjacent screens. Describe when Coco should offer help, what coherent work it should do, and why the benefit clears the interruption cost. A later stage will inspect the entire chunk to find an earlier no-intervention trigger.

Return only this JSON object:
{
  "support_opportunities": [
    {
      "category": "repetitive_work" | "stuck" | "anticipate_need",
      "workflow_pattern": "<general recurring or sustained user workflow>",
      "evidence_observation_ids": ["<at least three unique supplied IDs>"],
      "evidence_summary": "<how the cited observations establish the pattern>",
      "when_to_offer": "If the user ..., offer ...",
      "support_strategy": "<collaboration, synthesis, automation, or delegation>",
      "why_high_value": "<why benefit clearly exceeds interruption cost>",
      "why_not_incident_specific": "<why useful beyond one local symptom>"
    }
  ]
}

Return an empty list if no workflow-level opportunity is sufficiently supported.
"""

_EVIDENCE_VERIFICATION_SYSTEM_PROMPT = """\
You verify the evidence for workflow-level support opportunities proposed from a long desktop timeline. At this stage, judge the opportunity and evidence only. Do NOT select a trigger observation.

Return exactly one decision for EVERY supplied opportunity. Never omit a proposal. A rejected proposal must have accepted=false and a concrete decision_rationale explaining which evidence or quality requirement failed.
This lets the caller distinguish deliberate rejection from a truncated or incomplete response.

For every accepted opportunity:
1. Evidence must contain at least three UNIQUE supplied observation IDs. Evidence is behavioral proof rather than a need_support label target; it may come from observations whose original_need_support is either yes or no.
2. The cited observations must genuinely establish that the workflow continued or recurred, rather than showing unrelated adjacent activity.
3. Keep support at workflow level: collaboration on an artifact, synthesis, automation, or delegation of a coherent task. Reject direct SSH repair, one-command correction, one-typo correction, and other incident-specific help.
4. Later manual use of ChatGPT, an AI agent, or another assistance tool can CONFIRM that support was needed. Do not reject a proposal merely because the user eventually sought equivalent help manually.
5. The original Observer prediction and rationale are fallible evidence, not user feedback, and must not veto their own retrospective correction. Reject for preference conflict only when the supplied evidence identifies direct user feedback or a durable explicit preference that clearly applies.
6. Assign confidence conservatively. Confidence must be at least 0.75 only when the evidence clearly satisfies every condition.

You may rewrite an accepted proposal to make its pattern and strategy broader, but may not invent evidence IDs or facts. Rejected decisions need only the opportunity_id, accepted, and decision_rationale fields. Return only this JSON object:
{
  "opportunity_decisions": [
    {
      "opportunity_id": "<exact supplied opportunity_id>",
      "accepted": true,
      "decision_rationale": "<specific reason for accepting or rejecting>",
      "workflow_level_opportunity": true,
      "incident_specific": false,
      "category": "repetitive_work" | "stuck" | "anticipate_need",
      "confidence": 0.0,
      "workflow_pattern": "<reusable workflow pattern>",
      "evidence_observation_ids": ["<at least three unique supplied IDs>"],
      "evidence_summary": "<how evidence establishes the pattern>",
      "when_to_offer": "If the user ..., offer ...",
      "support_strategy": "<workflow-level help>",
      "why_high_value": "<benefit versus interruption cost>"
    }
  ]
}

Include rejected proposals with accepted=false. The decision list must have the same number of entries and opportunity IDs as the supplied proposal list.
"""

_TRIGGER_GROUNDING_SYSTEM_PROMPT = """\
You ground verified workflow-level support opportunities to earlier missed intervention moments. Evidence discovery and verification have already finished for ALL chunks.
You receive every verified opportunity with its evidence summary, IDs, and timestamps, plus one target chronological chunk whose observations include candidate_no_intervention. You do not receive the full evidence observations again.
Label triggers only in that target chunk; use the verified evidence summaries and timing to judge what happened afterward.

Return exactly one decision for EVERY supplied verified opportunity. Never omit one. For an accepted decision:
1. Select trigger_observation_id from an observation whose candidate_no_intervention is true.
2. Select the earliest moment where the verified broad need was already inferable and valuable enough to interrupt. The trigger is separate from the evidence and need not appear in evidence_observation_ids.
3. At least two verified evidence observations must occur after the trigger.
4. Later manual ChatGPT or agent use is positive evidence of an earlier need. Reject as redundant only if equivalent help was already active at the proposed trigger.
5. Observer predictions and rationales are fallible and cannot veto their own correction. Only direct user feedback or a durable explicit preference may impose a preference veto.
6. Set confidence to at least 0.75 only if the trigger is clearly supported.
7. Write rationale to explain why need_support="yes" at the selected trigger. Ground it in what was observable at that trigger and the applicable support opportunity. Later evidence may disambiguate the need, but do not describe future behavior as if it were already visible.

Return only this JSON object:
{
  "trigger_decisions": [
    {
      "opportunity_id": "<exact supplied opportunity_id>",
      "accepted": true,
      "decision_rationale": "<specific reason for accepting or rejecting>",
      "trigger_observation_id": "<exact supplied eligible ID>",
      "rationale": "<why proactive support is needed at this trigger>",
      "confidence": 0.0
    }
  ]
}

Rejected decisions need only opportunity_id, accepted=false, and a concrete decision_rationale. The list must contain exactly one decision per supplied verified opportunity.
"""

_DISCOVERY_TEXT_FIELDS = {
    "workflow_pattern",
    "evidence_summary",
    "when_to_offer",
    "support_strategy",
    "why_high_value",
    "why_not_incident_specific",
}
_CURATED_TEXT_FIELDS = {
    "workflow_pattern",
    "evidence_summary",
    "when_to_offer",
    "support_strategy",
    "why_high_value",
}


def derive_retrospective_signals(
    records: SessionRecords | Iterable[SessionRecords],
    *,
    model: str,
    min_confidence: float = 0.75,
    max_observations: int = 300,
    trigger_max_observations: int = 50,
    max_field_chars: int = 700,
    max_input_chars: int = _DEFAULT_MAX_INPUT_CHARS,
    max_opportunities: int = 8,
    min_pattern_span_s: float = 5 * 60,
    ttl_s: float = DEFAULT_SIGNAL_TTL_S,
    candidate_since_ts: float | None = None,
    show_progress: bool = False,
    trace_out: str | Path | None = None,
) -> list[ShortWindowSignal]:
    """Discover chunk-level workflow patterns, then ground missed moments."""
    _validate_config(
        model=model,
        min_confidence=min_confidence,
        max_observations=max_observations,
        trigger_max_observations=trigger_max_observations,
        max_field_chars=max_field_chars,
        max_input_chars=max_input_chars,
        max_opportunities=max_opportunities,
        min_pattern_span_s=min_pattern_span_s,
    )
    record_sets = [records] if isinstance(records, SessionRecords) else list(records)
    observations, eligible_ids = _collect_observations(
        record_sets,
        candidate_since_ts=candidate_since_ts,
    )
    if len(observations) < 3 or not eligible_ids:
        _write_empty_trace(
            trace_out,
            model=model,
            source_observation_count=len(observations),
            reason="fewer than three observations or no eligible no-intervention moments",
        )
        return []

    compact_observations = [
        _compact_observation(
            observation,
            candidate_no_intervention=(observation.observation_id in eligible_ids),
            max_field_chars=max_field_chars,
        )
        for observation in observations
    ]
    chunks = _chunk_compact_observations(
        compact_observations,
        source_count=len(observations),
        max_observations=max_observations,
        max_opportunities=max_opportunities,
        max_input_chars=max_input_chars,
    )
    progress = tqdm(
        total=2 * len(chunks),
        desc="Mining workflow opportunities",
        unit="stage",
        disable=not show_progress,
    )
    trace_rows: list[dict[str, Any]] = []
    all_signals: list[ShortWindowSignal] = []
    all_verified_opportunities: list[dict[str, Any]] = []
    observations_by_id = {
        observation.observation_id: observation for observation in observations
    }
    # Phase 1: discover and verify evidence across every chunk before choosing
    # any correction targets.
    for chunk_index, (compact, discovery_user_prompt) in enumerate(chunks, start=1):
        chunk_ids = {str(row["observation_id"]) for row in compact}
        trace_row: dict[str, Any] = {
            "strategy": "large_context_chunks",
            "status": "discovery_running",
            "chunk_index": chunk_index,
            "chunk_count": len(chunks),
            "model": model,
            "source_observation_count": len(observations),
            "provided_observation_count": len(compact),
            "input_chars": len(DISCOVERY_SYSTEM_PROMPT) + len(discovery_user_prompt),
            "system_prompt": DISCOVERY_SYSTEM_PROMPT,
            "user_prompt": discovery_user_prompt,
            "input": json.loads(discovery_user_prompt),
            "raw_output": "",
            "parsed_output": None,
            "discovery_attempts": [],
            "opportunity_reviews": [],
            "curation_system_prompt": _EVIDENCE_VERIFICATION_SYSTEM_PROMPT,
            "curation_user_prompt": "",
            "curation_raw_output": "",
            "curation_parsed_output": None,
            "curation_attempts": [],
            "curation_reviews": [],
            "trigger_system_prompt": _TRIGGER_GROUNDING_SYSTEM_PROMPT,
            "trigger_user_prompt": "",
            "trigger_raw_output": "",
            "trigger_parsed_output": None,
            "trigger_attempts": [],
            "trigger_reviews": [],
            "accepted_signals": [],
            "trigger_runs": [],
        }
        trace_rows.append(trace_row)
        _write_trace_snapshots(trace_out, trace_rows)

        discovery_raw, discovery_parsed, discovery_attempts = _complete_json(
            model=model,
            system_prompt=DISCOVERY_SYSTEM_PROMPT,
            user_prompt=discovery_user_prompt,
            operation="personalization.retrospective.discover",
            required_list_field="support_opportunities",
        )
        progress.update(1)
        candidates, discovery_reviews = _review_discovery(
            discovery_parsed,
            observation_ids=chunk_ids,
            opportunity_id_prefix=f"chunk-{chunk_index}",
        )
        trace_row.update(
            {
                "status": "discovery_complete",
                "raw_output": discovery_raw,
                "parsed_output": discovery_parsed,
                "discovery_attempts": discovery_attempts,
                "opportunity_reviews": discovery_reviews,
            }
        )
        _write_trace_snapshots(trace_out, trace_rows)

        curation_user_prompt = ""
        curation_raw = ""
        curation_parsed: dict[str, Any] | None = None
        curation_attempts: list[dict[str, Any]] = []
        verified_opportunities: list[dict[str, Any]] = []
        curation_reviews: list[dict[str, Any]] = []
        if candidates:
            curation_payload = _verification_payload(
                candidates,
                observations_by_id={str(row["observation_id"]): row for row in compact},
            )
            curation_user_prompt = json.dumps(
                curation_payload,
                ensure_ascii=False,
                separators=(",", ":"),
            )
            trace_row.update(
                {
                    "status": "curation_running",
                    "curation_user_prompt": curation_user_prompt,
                }
            )
            _write_trace_snapshots(trace_out, trace_rows)
            progress.set_description(
                f"Verifying workflow evidence ({chunk_index}/{len(chunks)})"
            )
            curation_raw, curation_parsed, curation_attempts = _complete_json(
                model=model,
                system_prompt=_EVIDENCE_VERIFICATION_SYSTEM_PROMPT,
                user_prompt=curation_user_prompt,
                operation="personalization.retrospective.verify_evidence",
                required_list_field="opportunity_decisions",
            )
            verified_opportunities, curation_reviews = (
                _validated_verified_opportunities(
                    curation_parsed,
                    candidates=candidates,
                    observations_by_id={
                        observation_id: observations_by_id[observation_id]
                        for observation_id in chunk_ids
                    },
                    min_confidence=min_confidence,
                    min_pattern_span_s=min_pattern_span_s,
                )
            )
            all_verified_opportunities.extend(verified_opportunities)
        progress.update(1)
        trace_row.update(
            {
                "status": "evidence_verification_complete",
                "curation_user_prompt": curation_user_prompt,
                "curation_raw_output": curation_raw,
                "curation_parsed_output": curation_parsed,
                "curation_attempts": curation_attempts,
                "curation_reviews": curation_reviews,
            }
        )
        _write_trace_snapshots(trace_out, trace_rows)

    # Phase 2: every trigger-labeling call sees all verified opportunities,
    # while candidate triggers are scoped to smaller chunks. Keeping these
    # chunks independent prevents the target timeline from dominating the
    # request and causing otherwise valid endpoints to return empty content.
    trigger_chunks = _chunk_trigger_observations(
        compact_observations,
        opportunities=all_verified_opportunities,
        eligible_ids=eligible_ids,
        max_observations=trigger_max_observations,
        max_input_chars=max_input_chars,
    )
    progress.total += len(trigger_chunks)
    progress.refresh()
    discovery_trace_by_observation_id: dict[str, int] = {}
    for trace_index, (compact, _prompt) in enumerate(chunks):
        for row in compact:
            discovery_trace_by_observation_id.setdefault(
                str(row["observation_id"]), trace_index
            )

    for chunk_index, compact in enumerate(trigger_chunks, start=1):
        trace_index = discovery_trace_by_observation_id[
            str(compact[0]["observation_id"])
        ]
        trace_row = trace_rows[trace_index]
        chunk_ids = {str(row["observation_id"]) for row in compact}
        eligible_chunk_ids = eligible_ids & chunk_ids
        trigger_user_prompt = ""
        trigger_raw = ""
        trigger_parsed: dict[str, Any] | None = None
        trigger_attempts: list[dict[str, Any]] = []
        trigger_reviews: list[dict[str, Any]] = []
        accepted_signals: list[ShortWindowSignal] = []
        if all_verified_opportunities:
            trigger_user_prompt = json.dumps(
                _trigger_payload(
                    all_verified_opportunities,
                    timeline=compact,
                    eligible_ids=eligible_chunk_ids,
                ),
                ensure_ascii=False,
                separators=(",", ":"),
            )
            if (
                len(_TRIGGER_GROUNDING_SYSTEM_PROMPT) + len(trigger_user_prompt)
                > max_input_chars
            ):
                raise ValueError(
                    "verified opportunities and target chunk exceed "
                    "max_input_chars; "
                    "use a smaller "
                    "--retrospective-trigger-max-observations value"
                )
            trace_row.update(
                {
                    "status": "trigger_grounding_running",
                    "grounding_opportunities": all_verified_opportunities,
                    "trigger_user_prompt": trigger_user_prompt,
                }
            )
            _write_trace_snapshots(trace_out, trace_rows)
            progress.set_description(
                f"Labeling missed triggers ({chunk_index}/{len(trigger_chunks)})"
            )
            trigger_raw, trigger_parsed, trigger_attempts = _complete_json(
                model=model,
                system_prompt=_TRIGGER_GROUNDING_SYSTEM_PROMPT,
                user_prompt=trigger_user_prompt,
                operation="personalization.retrospective.ground_triggers",
                required_list_field="trigger_decisions",
            )
            accepted_signals, trigger_reviews = _validated_trigger_signals(
                trigger_parsed,
                opportunities=all_verified_opportunities,
                observations_by_id=observations_by_id,
                eligible_ids=eligible_chunk_ids,
                min_confidence=min_confidence,
                ttl_s=ttl_s,
            )
            all_signals.extend(accepted_signals)
        progress.update(1)
        trigger_run = {
            "trigger_chunk_index": chunk_index,
            "trigger_chunk_count": len(trigger_chunks),
            "provided_observation_count": len(compact),
            "observation_ids": sorted(chunk_ids),
            "trigger_user_prompt": trigger_user_prompt,
            "trigger_raw_output": trigger_raw,
            "trigger_parsed_output": trigger_parsed,
            "trigger_attempts": trigger_attempts,
            "trigger_reviews": trigger_reviews,
            "accepted_signals": [signal.to_dict() for signal in accepted_signals],
        }
        trace_row["trigger_runs"].append(trigger_run)
        prior_decisions = (trace_row.get("trigger_parsed_output") or {}).get(
            "trigger_decisions", []
        )
        new_decisions = (
            trigger_parsed.get("trigger_decisions", []) if trigger_parsed else []
        )
        trace_row.update(
            {
                "grounding_opportunities": all_verified_opportunities,
                "trigger_user_prompt": trigger_user_prompt,
                "trigger_raw_output": trigger_raw,
                "trigger_parsed_output": {
                    "trigger_decisions": [*prior_decisions, *new_decisions]
                },
                "trigger_attempts": [
                    *trace_row["trigger_attempts"],
                    *(
                        {**attempt, "trigger_chunk_index": chunk_index}
                        for attempt in trigger_attempts
                    ),
                ],
                "trigger_reviews": [
                    *trace_row["trigger_reviews"],
                    *trigger_reviews,
                ],
                "accepted_signals": [
                    *trace_row["accepted_signals"],
                    *(signal.to_dict() for signal in accepted_signals),
                ],
            }
        )
        _write_trace_snapshots(trace_out, trace_rows)
    for trace_row in trace_rows:
        trace_row["status"] = "complete"
    _write_trace_snapshots(trace_out, trace_rows)
    progress.close()
    return sorted(_deduplicate_signals(all_signals), key=lambda signal: signal.ts)


def _validate_config(
    *,
    model: str,
    min_confidence: float,
    max_observations: int,
    trigger_max_observations: int,
    max_field_chars: int,
    max_input_chars: int,
    max_opportunities: int,
    min_pattern_span_s: float,
) -> None:
    if not model:
        raise ValueError("model is required")
    if not 0.0 <= min_confidence <= 1.0:
        raise ValueError("min_confidence must be between 0 and 1")
    if max_observations < 3:
        raise ValueError("max_observations must be at least 3")
    if trigger_max_observations < 1:
        raise ValueError("trigger_max_observations must be at least 1")
    for name, value in (
        ("max_field_chars", max_field_chars),
        ("max_input_chars", max_input_chars),
        ("max_opportunities", max_opportunities),
    ):
        if value < 1:
            raise ValueError(f"{name} must be at least 1")
    if min_pattern_span_s < 0:
        raise ValueError("min_pattern_span_s must be non-negative")


def _collect_observations(
    record_sets: list[SessionRecords],
    *,
    candidate_since_ts: float | None,
) -> tuple[list[ObservationRecord], set[str]]:
    by_id: dict[str, ObservationRecord] = {}
    eligible_ids: set[str] = set()
    for record_set in record_sets:
        silent_ids = no_suggestion_observation_ids(record_set)
        for observation in record_set.observations:
            if candidate_since_ts is not None and observation.ts < candidate_since_ts:
                continue
            by_id.setdefault(observation.observation_id, observation)
            if observation.observation_id in silent_ids:
                eligible_ids.add(observation.observation_id)
    observations = sorted(by_id.values(), key=lambda observation: observation.ts)
    return observations, eligible_ids & set(by_id)


def _compact_observation(
    observation: ObservationRecord,
    *,
    candidate_no_intervention: bool,
    max_field_chars: int,
) -> dict[str, Any]:
    parsed = parse_json_object(observation.observer_output) or {}
    return {
        "observation_id": observation.observation_id,
        "ts": observation.ts,
        "session_id": observation.session_id,
        "type": observation.type,
        "candidate_no_intervention": candidate_no_intervention,
        "observation": _truncate(
            parsed.get("observation")
            or observer_observation(observation.observer_output),
            max_field_chars,
        ),
        "user_intent": _truncate(
            parsed.get("user_intent")
            or observer_user_intent(observation.observer_output),
            max_field_chars,
        ),
        "original_need_support": original_need_support(observation.observer_output),
        "observer_rationale": _truncate(
            parsed.get("rationale"),
            max_field_chars,
        ),
    }


def _discovery_user_prompt(
    observations: list[dict[str, Any]],
    *,
    source_count: int,
    max_opportunities: int,
    chunk_index: int,
    chunk_count: int,
) -> str:
    return json.dumps(
        {
            "task": (
                f"Identify at most {max_opportunities} distinct workflow-level "
                "support opportunities across this timeline."
            ),
            "source_observation_count": source_count,
            "provided_observation_count": len(observations),
            "selection": "contiguous chronological chunk",
            "chunk_index": chunk_index,
            "chunk_count": chunk_count,
            "timeline": [_evidence_view(row) for row in observations],
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _chunk_compact_observations(
    observations: list[dict[str, Any]],
    *,
    source_count: int,
    max_observations: int,
    max_opportunities: int,
    max_input_chars: int,
) -> list[tuple[list[dict[str, Any]], str]]:
    """Pack every observation into chronological, input-bounded chunks."""
    raw_chunks: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    for observation in observations:
        candidate = [*current, observation]
        prompt = _discovery_user_prompt(
            candidate,
            source_count=source_count,
            max_opportunities=max_opportunities,
            chunk_index=999_999,
            chunk_count=999_999,
        )
        fits = len(DISCOVERY_SYSTEM_PROMPT) + len(prompt) <= max_input_chars
        if len(candidate) <= max_observations and fits:
            current = candidate
            continue
        if not current:
            raise ValueError("max_input_chars is too small for one compact observation")
        raw_chunks.append(current)
        current = [observation]
    if current:
        raw_chunks.append(current)

    # A discovery requires three evidence IDs. If the final chunk contains only
    # one or two new observations, overlap the minimum preceding context rather
    # than silently dropping those tail observations.
    if len(raw_chunks) > 1 and len(raw_chunks[-1]) < 3:
        needed = 3 - len(raw_chunks[-1])
        raw_chunks[-1] = [*raw_chunks[-2][-needed:], *raw_chunks[-1]]

    chunk_count = len(raw_chunks)
    chunks: list[tuple[list[dict[str, Any]], str]] = []
    for index, chunk in enumerate(raw_chunks, start=1):
        prompt = _discovery_user_prompt(
            chunk,
            source_count=source_count,
            max_opportunities=max_opportunities,
            chunk_index=index,
            chunk_count=chunk_count,
        )
        if len(DISCOVERY_SYSTEM_PROMPT) + len(prompt) > max_input_chars:
            raise ValueError("chunk exceeds max_input_chars")
        chunks.append((chunk, prompt))
    return chunks


def _chunk_trigger_observations(
    observations: list[dict[str, Any]],
    *,
    opportunities: list[dict[str, Any]],
    eligible_ids: set[str],
    max_observations: int,
    max_input_chars: int,
) -> list[list[dict[str, Any]]]:
    """Pack the complete timeline into small trigger-grounding chunks."""
    chunks: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    for observation in observations:
        candidate = [*current, observation]
        candidate_ids = {str(row["observation_id"]) for row in candidate}
        prompt = json.dumps(
            _trigger_payload(
                opportunities,
                timeline=candidate,
                eligible_ids=eligible_ids & candidate_ids,
            ),
            ensure_ascii=False,
            separators=(",", ":"),
        )
        fits = len(_TRIGGER_GROUNDING_SYSTEM_PROMPT) + len(prompt) <= max_input_chars
        if len(candidate) <= max_observations and fits:
            current = candidate
            continue
        if not current:
            raise ValueError("max_input_chars is too small for one trigger observation")
        chunks.append(current)
        current = [observation]
    if current:
        chunks.append(current)
    return chunks


def _review_discovery(
    parsed: dict[str, Any] | None,
    *,
    observation_ids: set[str],
    opportunity_id_prefix: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    opportunities = parsed.get("support_opportunities") if parsed else None
    if not isinstance(opportunities, list):
        return [], []
    candidates: list[dict[str, Any]] = []
    reviews: list[dict[str, Any]] = []
    for index, opportunity in enumerate(opportunities):
        reasons: list[str] = []
        if not isinstance(opportunity, dict):
            reviews.append(
                {"index": index, "valid": False, "reasons": ["not an object"]}
            )
            continue
        if opportunity.get("category") not in RETROSPECTIVE_CATEGORIES:
            reasons.append("unsupported category")
        for field in _DISCOVERY_TEXT_FIELDS:
            if not str(opportunity.get(field) or "").strip():
                reasons.append(f"{field} is empty")
        raw_evidence = opportunity.get("evidence_observation_ids")
        if not isinstance(raw_evidence, list):
            reasons.append("evidence_observation_ids is not a list")
            evidence_ids: list[str] = []
        else:
            evidence_ids = []
            unresolved_ids: list[str] = []
            for value in raw_evidence:
                raw_id = str(value)
                resolved = _resolve_observation_id(raw_id, observation_ids)
                if resolved is None:
                    unresolved_ids.append(raw_id)
                else:
                    evidence_ids.append(resolved)
            unique_ids = set(evidence_ids)
            if len(unique_ids) < 3:
                reasons.append("fewer than three unique evidence IDs")
            if len(unique_ids) != len(evidence_ids):
                reasons.append("duplicate evidence IDs")
            if unresolved_ids:
                reasons.append(
                    f"unknown or ambiguous evidence IDs: {', '.join(unresolved_ids)}"
                )
        opportunity_id = f"{opportunity_id_prefix}-opportunity-{index}"
        review = {
            "index": index,
            "opportunity_id": opportunity_id,
            "workflow_pattern": opportunity.get("workflow_pattern"),
            "valid": not reasons,
            "reasons": reasons,
            "unique_evidence_count": len(set(evidence_ids)),
        }
        reviews.append(review)
        if not reasons:
            candidates.append(
                {
                    **opportunity,
                    "opportunity_id": opportunity_id,
                    "evidence_observation_ids": list(dict.fromkeys(evidence_ids)),
                }
            )
    return candidates, reviews


def _verification_payload(
    candidates: list[dict[str, Any]],
    *,
    observations_by_id: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    payload: list[dict[str, Any]] = []
    for candidate in candidates:
        evidence_ids = candidate["evidence_observation_ids"]
        payload.append(
            {
                **candidate,
                "evidence_observations": [
                    _evidence_view(observations_by_id[observation_id])
                    for observation_id in evidence_ids
                    if observation_id in observations_by_id
                ],
            }
        )
    return {"proposed_opportunities": payload}


def _evidence_view(observation: dict[str, Any]) -> dict[str, Any]:
    """Hide trigger eligibility from discovery and evidence verification."""
    return {
        key: value
        for key, value in observation.items()
        if key != "candidate_no_intervention"
    }


def _validated_verified_opportunities(
    parsed: dict[str, Any] | None,
    *,
    candidates: list[dict[str, Any]],
    observations_by_id: dict[str, ObservationRecord],
    min_confidence: float,
    min_pattern_span_s: float,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    candidates_by_id = {
        str(candidate["opportunity_id"]): candidate for candidate in candidates
    }
    decisions = parsed.get("opportunity_decisions") if parsed else None
    if not isinstance(decisions, list):
        return [], [
            {
                "opportunity_id": opportunity_id,
                "accepted": False,
                "decision_rationale": "",
                "valid": False,
                "reasons": ["evidence verification is missing opportunity_decisions"],
            }
            for opportunity_id in candidates_by_id
        ]

    decision_ids = [
        str(decision.get("opportunity_id") or "")
        for decision in decisions
        if isinstance(decision, dict)
    ]
    duplicate_ids = {
        opportunity_id
        for opportunity_id in decision_ids
        if opportunity_id and decision_ids.count(opportunity_id) > 1
    }
    missing_ids = set(candidates_by_id) - set(decision_ids)
    unknown_ids = set(decision_ids) - set(candidates_by_id)
    malformed_decisions = any(
        not isinstance(decision, dict)
        or not isinstance(decision.get("accepted"), bool)
        or not str(decision.get("decision_rationale") or "").strip()
        for decision in decisions
    )
    response_incomplete = bool(
        len(decisions) != len(candidates_by_id)
        or missing_ids
        or duplicate_ids
        or unknown_ids
        or malformed_decisions
    )
    verified: list[dict[str, Any]] = []
    reviews: list[dict[str, Any]] = []
    for index, opportunity in enumerate(decisions):
        reasons: list[str] = []
        if not isinstance(opportunity, dict):
            reviews.append(
                {
                    "index": index,
                    "accepted": False,
                    "decision_rationale": "",
                    "valid": False,
                    "reasons": ["not an object"],
                }
            )
            continue
        opportunity_id = str(opportunity.get("opportunity_id") or "")
        source = candidates_by_id.get(opportunity_id)
        if source is None:
            reasons.append("unknown opportunity_id")
        if opportunity_id in duplicate_ids:
            reasons.append("duplicate opportunity_id")
        accepted = opportunity.get("accepted")
        if not isinstance(accepted, bool):
            reasons.append("accepted is not a boolean")
            accepted = False
        decision_rationale = str(opportunity.get("decision_rationale") or "").strip()
        if not decision_rationale:
            reasons.append("decision_rationale is empty")
        if not accepted:
            reviews.append(
                {
                    "index": index,
                    "opportunity_id": opportunity_id,
                    "accepted": False,
                    "decision_rationale": decision_rationale,
                    "valid": not reasons,
                    "reasons": reasons,
                }
            )
            continue
        if opportunity.get("workflow_level_opportunity") is not True:
            reasons.append("workflow_level_opportunity is not true")
        if opportunity.get("incident_specific") is not False:
            reasons.append("incident_specific is not false")
        category = str(opportunity.get("category") or "")
        if category not in RETROSPECTIVE_CATEGORIES:
            reasons.append("unsupported category")
        for field in _CURATED_TEXT_FIELDS:
            if not str(opportunity.get(field) or "").strip():
                reasons.append(f"{field} is empty")
        try:
            confidence = float(opportunity.get("confidence"))
        except (TypeError, ValueError):
            confidence = 0.0
            reasons.append("confidence is missing or invalid")
        else:
            if not min_confidence <= confidence <= 1.0:
                reasons.append("confidence is below threshold or above 1")
        raw_evidence = opportunity.get("evidence_observation_ids")
        if not isinstance(raw_evidence, list):
            evidence_ids: list[str] = []
            reasons.append("evidence_observation_ids is not a list")
        else:
            evidence_ids = []
            unresolved_ids: list[str] = []
            for value in raw_evidence:
                raw_id = str(value)
                resolved = _resolve_observation_id(
                    raw_id,
                    set(observations_by_id),
                )
                if resolved is None:
                    unresolved_ids.append(raw_id)
                else:
                    evidence_ids.append(resolved)
            if unresolved_ids:
                reasons.append("evidence contains unknown or ambiguous IDs")
            if len(set(evidence_ids)) < 3:
                reasons.append("fewer than three unique evidence IDs")
            if len(set(evidence_ids)) != len(evidence_ids):
                reasons.append("duplicate evidence IDs")
            unknown = set(evidence_ids) - set(observations_by_id)
            if unknown:
                reasons.append("evidence contains unknown observation IDs")
            if source is not None and not set(evidence_ids).issubset(
                set(source["evidence_observation_ids"])
            ):
                reasons.append("curator introduced evidence absent from proposal")
        if evidence_ids and all(
            observation_id in observations_by_id for observation_id in evidence_ids
        ):
            evidence_times = [
                observations_by_id[observation_id].ts for observation_id in evidence_ids
            ]
            if max(evidence_times) - min(evidence_times) < min_pattern_span_s:
                reasons.append("evidence span is below minimum")
        review = {
            "index": index,
            "opportunity_id": opportunity_id,
            "accepted": True,
            "decision_rationale": decision_rationale,
            "valid": not reasons,
            "reasons": reasons,
        }
        reviews.append(review)
        if reasons:
            continue
        verified.append(
            {
                **source,
                **opportunity,
                "opportunity_id": opportunity_id,
                "evidence_observation_ids": evidence_ids,
                "evidence_observation_timestamps": [
                    {
                        "observation_id": observation_id,
                        "ts": observations_by_id[observation_id].ts,
                    }
                    for observation_id in evidence_ids
                ],
                "evidence_confidence": confidence,
            }
        )
    for opportunity_id in sorted(missing_ids):
        reviews.append(
            {
                "opportunity_id": opportunity_id,
                "accepted": False,
                "decision_rationale": "",
                "valid": False,
                "reasons": ["evidence verification omitted this opportunity"],
            }
        )
    if response_incomplete:
        for review in reviews:
            if review.get("accepted") is True:
                review["valid"] = False
                review.setdefault("reasons", []).append(
                    "evidence verification did not contain exactly one decision "
                    "for every proposal"
                )
        return [], reviews
    return verified, reviews


def _trigger_payload(
    opportunities: list[dict[str, Any]],
    *,
    timeline: list[dict[str, Any]],
    eligible_ids: set[str],
) -> dict[str, Any]:
    return {
        "verified_opportunities": opportunities,
        "eligible_trigger_observation_ids": [
            str(row["observation_id"])
            for row in timeline
            if str(row["observation_id"]) in eligible_ids
        ],
        "timeline": timeline,
    }


def _validated_trigger_signals(
    parsed: dict[str, Any] | None,
    *,
    opportunities: list[dict[str, Any]],
    observations_by_id: dict[str, ObservationRecord],
    eligible_ids: set[str],
    min_confidence: float,
    ttl_s: float,
) -> tuple[list[ShortWindowSignal], list[dict[str, Any]]]:
    opportunities_by_id = {
        str(opportunity["opportunity_id"]): opportunity for opportunity in opportunities
    }
    decisions = parsed.get("trigger_decisions") if parsed else None
    if not isinstance(decisions, list):
        return [], [
            {
                "opportunity_id": opportunity_id,
                "accepted": False,
                "decision_rationale": "",
                "valid": False,
                "reasons": ["trigger grounding is missing trigger_decisions"],
            }
            for opportunity_id in opportunities_by_id
        ]

    decision_ids = [
        str(decision.get("opportunity_id") or "")
        for decision in decisions
        if isinstance(decision, dict)
    ]
    duplicate_ids = {
        opportunity_id
        for opportunity_id in decision_ids
        if opportunity_id and decision_ids.count(opportunity_id) > 1
    }
    missing_ids = set(opportunities_by_id) - set(decision_ids)
    unknown_ids = set(decision_ids) - set(opportunities_by_id)
    malformed = any(
        not isinstance(decision, dict)
        or not isinstance(decision.get("accepted"), bool)
        or not str(decision.get("decision_rationale") or "").strip()
        for decision in decisions
    )
    response_incomplete = bool(
        len(decisions) != len(opportunities_by_id)
        or missing_ids
        or duplicate_ids
        or unknown_ids
        or malformed
    )
    signals: list[ShortWindowSignal] = []
    reviews: list[dict[str, Any]] = []
    for index, decision in enumerate(decisions):
        reasons: list[str] = []
        if not isinstance(decision, dict):
            reviews.append(
                {
                    "index": index,
                    "accepted": False,
                    "decision_rationale": "",
                    "valid": False,
                    "reasons": ["not an object"],
                }
            )
            continue
        opportunity_id = str(decision.get("opportunity_id") or "")
        source = opportunities_by_id.get(opportunity_id)
        if source is None:
            reasons.append("unknown opportunity_id")
        if opportunity_id in duplicate_ids:
            reasons.append("duplicate opportunity_id")
        accepted = decision.get("accepted")
        if not isinstance(accepted, bool):
            reasons.append("accepted is not a boolean")
            accepted = False
        decision_rationale = str(decision.get("decision_rationale") or "").strip()
        if not decision_rationale:
            reasons.append("decision_rationale is empty")
        if not accepted:
            reviews.append(
                {
                    "index": index,
                    "opportunity_id": opportunity_id,
                    "accepted": False,
                    "decision_rationale": decision_rationale,
                    "valid": not reasons,
                    "reasons": reasons,
                }
            )
            continue
        raw_trigger_id = str(decision.get("trigger_observation_id") or "")
        trigger_id = (
            _resolve_observation_id(raw_trigger_id, set(observations_by_id)) or ""
        )
        if trigger_id not in eligible_ids:
            reasons.append("trigger is not an eligible no-intervention observation")
        rationale = str(decision.get("rationale") or "").strip()
        if not rationale:
            reasons.append("rationale is empty")
        try:
            trigger_confidence = float(decision.get("confidence"))
        except (TypeError, ValueError):
            trigger_confidence = 0.0
            reasons.append("confidence is missing or invalid")
        else:
            if not min_confidence <= trigger_confidence <= 1.0:
                reasons.append("confidence is below threshold or above 1")
        evidence_ids = (
            list(source.get("evidence_observation_ids", [])) if source else []
        )
        if trigger_id in observations_by_id:
            trigger_ts = observations_by_id[trigger_id].ts
            later_ids = [
                observation_id
                for observation_id in evidence_ids
                if observation_id in observations_by_id
                and observations_by_id[observation_id].ts > trigger_ts
            ]
            if len(later_ids) < 2:
                reasons.append("fewer than two cited observations follow trigger")
        review = {
            "index": index,
            "opportunity_id": opportunity_id,
            "trigger_observation_id": trigger_id,
            "accepted": True,
            "decision_rationale": decision_rationale,
            "valid": not reasons,
            "reasons": reasons,
        }
        reviews.append(review)
        if reasons or source is None:
            continue
        trigger = observations_by_id[trigger_id]
        category = str(source["category"])
        workflow_pattern = str(source["workflow_pattern"]).strip()
        evidence_summary = str(source["evidence_summary"]).strip()
        when_to_offer = str(source["when_to_offer"]).strip()
        support_strategy = str(source["support_strategy"]).strip()
        why_high_value = str(source["why_high_value"]).strip()
        confidence = min(float(source["evidence_confidence"]), trigger_confidence)
        signals.append(
            ShortWindowSignal(
                signal_id=stable_id(
                    "sig", trigger.session_id, trigger_id, category, workflow_pattern
                ),
                session_id=trigger.session_id,
                observation_id=trigger_id,
                ts=trigger.ts,
                kind=f"retrospective:{category}",
                polarity="positive",
                scope="observation",
                expires_at=trigger.ts + ttl_s,
                confidence=confidence,
                evidence=(
                    f"Workflow pattern: {workflow_pattern} Evidence: "
                    f"{evidence_summary} Trigger rule: {when_to_offer} "
                    f"High-value workflow support: {support_strategy} "
                    f"Why high value: {why_high_value} Revised rationale: "
                    f"{rationale}"
                ),
                source_record_ids=list(dict.fromkeys([trigger_id, *evidence_ids])),
                target_rationale=rationale,
            )
        )
    for opportunity_id in sorted(missing_ids):
        reviews.append(
            {
                "opportunity_id": opportunity_id,
                "accepted": False,
                "decision_rationale": "",
                "valid": False,
                "reasons": ["trigger grounding omitted this opportunity"],
            }
        )
    if response_incomplete:
        for review in reviews:
            if review.get("accepted") is True:
                review["valid"] = False
                review.setdefault("reasons", []).append(
                    "trigger grounding did not contain exactly one decision "
                    "for every verified opportunity"
                )
        return [], reviews
    return signals, reviews


def _deduplicate_signals(
    signals: list[ShortWindowSignal],
) -> list[ShortWindowSignal]:
    best_by_trigger_and_kind: dict[tuple[str | None, str], ShortWindowSignal] = {}
    for signal in signals:
        key = (signal.observation_id, signal.kind)
        current = best_by_trigger_and_kind.get(key)
        if current is None or signal.confidence > current.confidence:
            best_by_trigger_and_kind[key] = signal
    return list(best_by_trigger_and_kind.values())


def _resolve_observation_id(value: str, valid_ids: set[str]) -> str | None:
    """Resolve exact IDs and unique model-emitted UUID prefixes."""
    if value in valid_ids:
        return value
    if len(value) < 6:
        return None
    matches = [
        observation_id
        for observation_id in valid_ids
        if observation_id.startswith(value)
    ]
    return matches[0] if len(matches) == 1 else None


def _extra_body_for_model(model: str) -> dict[str, Any] | None:
    lowered = model.lower()
    if model.startswith("hosted_vllm/") and "qwen" in lowered:
        return {"chat_template_kwargs": {"enable_thinking": False}}
    return None


def _complete(
    *,
    model: str,
    system_prompt: str,
    user_prompt: str,
    operation: str,
) -> str:
    response, _metrics = chat_completion(
        [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        model=model,
        temperature=0.0,
        # Preserve enough room for complete structured opportunity output. The
        # input side is truncated and chunked before requests reach this point.
        max_tokens=_MODEL_MAX_OUTPUT_TOKENS,
        extra_body=_extra_body_for_model(model),
        operation=operation,
    )
    return response_text(response)


def _complete_json(
    *,
    model: str,
    system_prompt: str,
    user_prompt: str,
    operation: str,
    required_list_field: str,
    max_attempts: int = _MODEL_JSON_MAX_ATTEMPTS,
) -> tuple[str, dict[str, Any] | None, list[dict[str, Any]]]:
    """Retry empty, unparseable, or schema-incomplete JSON responses."""
    attempts: list[dict[str, Any]] = []
    raw = ""
    parsed: dict[str, Any] | None = None
    for attempt_number in range(1, max_attempts + 1):
        retry_instruction = ""
        if attempt_number > 1:
            retry_instruction = (
                "\n\nRETRY REQUIREMENT: The previous response was empty or "
                "invalid. Return only one JSON object containing a list field "
                f'named "{required_list_field}". Do not return commentary.'
            )
        raw = _complete(
            model=model,
            system_prompt=system_prompt,
            user_prompt=user_prompt + retry_instruction,
            operation=operation,
        )
        parsed = parse_json_object(raw)
        if not raw.strip():
            failure = "empty response"
        elif parsed is None:
            failure = "response did not contain a parseable JSON object"
        elif not isinstance(parsed.get(required_list_field), list):
            failure = f"{required_list_field} is missing or is not a list"
        else:
            failure = ""
        attempts.append(
            {
                "attempt": attempt_number,
                "valid": not failure,
                "failure": failure,
                "raw_output": raw,
            }
        )
        if not failure:
            return raw, parsed, attempts
    return raw, None, attempts


def _write_empty_trace(
    trace_out: str | Path | None,
    *,
    model: str,
    source_observation_count: int,
    reason: str,
    timeline: list[dict[str, Any]] | None = None,
) -> None:
    if trace_out is None:
        return
    write_jsonl(
        trace_out,
        [
            {
                "strategy": "large_context",
                "model": model,
                "source_observation_count": source_observation_count,
                "provided_observation_count": len(timeline or []),
                "skip_reason": reason,
                "input": {"timeline": timeline or []},
                "raw_output": "",
                "accepted_signals": [],
            }
        ],
    )


def _write_trace_snapshots(
    trace_out: str | Path | None,
    trace_rows: list[dict[str, Any]],
) -> None:
    if trace_out is not None:
        write_jsonl(trace_out, trace_rows)


def _truncate(value: Any, limit: int) -> str:
    text = str(value or "").strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"
