from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import Callable

from external_api.llm import prompt_to_text

from memory.models import ObservationInput, ObservationRecord, PropositionDraft
from memory.prompts import (
    PROPOSE_PROMPT,
    PROPOSE_SYSTEM,
    RELATION_PROMPT,
    RELATION_SYSTEM,
    REVISE_PROMPT,
    REVISE_SYSTEM,
    UPDATE_PROMPT,
    UPDATE_SYSTEM,
)
from memory.store import MemoryStore

logger = logging.getLogger(__name__)

Completion = Callable[[str, str], str]


def _json_object(text: str) -> dict:
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    candidates = [fenced.group(1)] if fenced else []
    brace = re.search(r"\{.*\}", text, re.DOTALL)
    if brace:
        candidates.append(brace.group(0))
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            continue
    raise ValueError("model response did not contain a valid JSON object")


def _score(value: object) -> int | None:
    try:
        return max(1, min(10, int(value)))
    except (TypeError, ValueError):
        return None


def _drafts(payload: dict) -> list[PropositionDraft]:
    result: list[PropositionDraft] = []
    items = payload.get("propositions")
    if not isinstance(items, list):
        return result
    for item in items:
        if not isinstance(item, dict):
            continue
        text = str(item.get("proposition") or item.get("text") or "").strip()
        reasoning = str(item.get("reasoning") or "").strip()
        if text:
            raw_ids = item.get("observation_ids")
            observation_ids = (
                tuple(dict.fromkeys(str(value) for value in raw_ids if value))
                if isinstance(raw_ids, list)
                else ()
            )
            result.append(
                PropositionDraft(
                    text=text,
                    reasoning=reasoning,
                    confidence=_score(item.get("confidence")),
                    decay=_score(item.get("decay")),
                    observation_ids=observation_ids,
                )
            )
    return result


_TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9_.-]+")
_STOPWORDS = {
    "about",
    "also",
    "been",
    "from",
    "into",
    "that",
    "their",
    "this",
    "user",
    "using",
    "with",
    "working",
}


def _tokens(text: str) -> set[str]:
    return {
        token
        for token in _TOKEN_RE.findall(text.lower())
        if token not in _STOPWORDS and len(token) > 2
    }


def _similarity(left: str, right: str) -> float:
    left_tokens, right_tokens = _tokens(left), _tokens(right)
    if not left_tokens or not right_tokens:
        return 0.0
    return len(left_tokens & right_tokens) / min(len(left_tokens), len(right_tokens))


def _dedupe_drafts(
    drafts: list[PropositionDraft], *, limit: int
) -> list[PropositionDraft]:
    unique: list[PropositionDraft] = []
    for draft in drafts:
        duplicate_index = next(
            (
                index
                for index, existing in enumerate(unique)
                if _similarity(draft.text, existing.text) >= 0.72
            ),
            None,
        )
        if duplicate_index is None:
            unique.append(draft)
        else:
            existing = unique[duplicate_index]
            preferred = (
                draft
                if (draft.confidence or 0) > (existing.confidence or 0)
                else existing
            )
            unique[duplicate_index] = PropositionDraft(
                text=preferred.text,
                reasoning=preferred.reasoning,
                confidence=preferred.confidence,
                decay=preferred.decay,
                observation_ids=tuple(
                    dict.fromkeys([*existing.observation_ids, *draft.observation_ids])
                ),
            )
    return unique[:limit]


class MemoryEngine:
    """Background GUM pipeline over semantic observer outputs."""

    def __init__(
        self,
        store: MemoryStore,
        *,
        user_name: str,
        model: str,
        min_batch_size: int = 5,
        max_batch_size: int = 50,
        max_propositions: int = 5,
        poll_interval_seconds: float = 5.0,
        completion: Completion | None = None,
    ):
        self.store = store
        self.user_name = user_name
        self.model = model
        self.min_batch_size = max(1, min_batch_size)
        self.max_batch_size = max(self.min_batch_size, max_batch_size)
        self.max_propositions = max(1, max_propositions)
        self.poll_interval_seconds = poll_interval_seconds
        self._completion = completion or self._complete
        self._task: asyncio.Task | None = None
        self._wake = asyncio.Event()

    def _complete(self, system: str, prompt: str) -> str:
        if not self.model:
            raise RuntimeError("MEMORY_MODEL is empty")
        return prompt_to_text(self.model, system, prompt)

    async def add_observation(self, observation: ObservationInput) -> bool:
        inserted = await asyncio.to_thread(self.store.add_observation, observation)
        if inserted:
            self._wake.set()
        return inserted

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name="memory-engine")

    async def stop(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None

    async def _run(self) -> None:
        while True:
            try:
                processed = await asyncio.to_thread(self.process_pending_once)
                if processed:
                    continue
                self._wake.clear()
                try:
                    await asyncio.wait_for(
                        self._wake.wait(), timeout=self.poll_interval_seconds
                    )
                except TimeoutError:
                    pass
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("memory proposition processing failed; will retry")
                await asyncio.sleep(self.poll_interval_seconds)

    def process_pending_once(self, *, force: bool = False) -> int:
        observations = self.store.pending_observations(self.max_batch_size)
        if not observations or (not force and len(observations) < self.min_batch_size):
            return 0
        observation_ids = [item.id for item in observations]
        try:
            for draft in self._generate(observations):
                self._merge_draft(draft, observations)
        except Exception:
            # Leave processed_at unset so the batch is retried after transient LLM errors.
            raise
        self.store.mark_processed(observation_ids)
        return len(observations)

    def _generate(
        self, observations: list[ObservationRecord]
    ) -> list[PropositionDraft]:
        body = "\n\n".join(
            f"[observation_id={item.id}] [{item.observer_name} @ {item.created_at:.3f}] "
            f"{item.content}"
            for item in observations
        )
        prompt = PROPOSE_PROMPT.format(
            user_name=self.user_name,
            observations=body,
            max_propositions=self.max_propositions,
        )
        return _dedupe_drafts(
            _drafts(_json_object(self._completion(PROPOSE_SYSTEM, prompt))),
            limit=self.max_propositions,
        )

    @staticmethod
    def _evidence_ids(
        draft: PropositionDraft,
        observations: list[ObservationRecord],
        *,
        limit: int = 5,
    ) -> list[str]:
        valid = {item.id for item in observations}
        cited = [item for item in draft.observation_ids if item in valid]
        if cited:
            return list(dict.fromkeys(cited))[:limit]

        # Models occasionally omit citations. Ground the proposition in the
        # observations with the strongest lexical overlap instead of attaching
        # the entire batch.
        proposition_tokens = _tokens(f"{draft.text} {draft.reasoning}")
        ranked = sorted(
            (
                (len(proposition_tokens & _tokens(item.content)), item.id)
                for item in observations
            ),
            reverse=True,
        )
        positive = [item_id for score, item_id in ranked if score > 0]
        return (positive or [observations[0].id])[:limit]

    def _merge_draft(
        self, draft: PropositionDraft, observations: list[ObservationRecord]
    ) -> None:
        current_ids = self._evidence_ids(draft, observations)
        candidates = self.store.search(
            f"{draft.text} {draft.reasoning}", limit=5, include_observations=0
        )
        if not candidates:
            self.store.insert_proposition(draft, current_ids)
            return

        deterministic_duplicate = next(
            (
                hit.proposition.id
                for hit in candidates
                if _similarity(draft.text, hit.proposition.text) >= 0.85
            ),
            None,
        )
        if deterministic_duplicate is not None:
            self._record_update(
                draft,
                observations,
                target_ids={deterministic_duplicate},
                relation="IDENTICAL",
            )
            return

        existing = "\n\n".join(
            f"[{hit.proposition.id}] {hit.proposition.text}\n"
            f"Reasoning: {hit.proposition.reasoning}"
            for hit in candidates
        )
        relation = _json_object(
            self._completion(
                RELATION_SYSTEM,
                RELATION_PROMPT.format(
                    new_text=draft.text,
                    new_reasoning=draft.reasoning,
                    existing=existing,
                ),
            )
        )
        label = str(relation.get("label") or "UNRELATED").upper()
        valid_ids = {hit.proposition.id for hit in candidates}
        target_ids = {
            int(item)
            for item in relation.get("target_ids", [])
            if str(item).isdigit() and int(item) in valid_ids
        }
        if not target_ids or label not in {"IDENTICAL", "SIMILAR"}:
            self.store.insert_proposition(draft, current_ids)
            return
        if label == "IDENTICAL":
            self._record_update(
                draft,
                observations,
                target_ids=target_ids,
                relation="IDENTICAL",
            )
            return
        self._revise_similar(draft, observations, target_ids=target_ids)

    def _revise_similar(
        self,
        draft: PropositionDraft,
        observations: list[ObservationRecord],
        *,
        target_ids: set[int],
    ) -> None:
        selected = self.store.propositions_by_id(target_ids)
        old_evidence_ids = self.store.related_observation_ids(target_ids)
        old_evidence = self.store.observations_by_id(old_evidence_ids)
        current_evidence_ids = self._evidence_ids(draft, observations)
        current_by_id = {item.id: item for item in observations}
        all_evidence = {item.id: item for item in old_evidence}
        all_evidence.update(
            (item_id, current_by_id[item_id])
            for item_id in current_evidence_ids
            if item_id in current_by_id
        )
        proposition_body = "\n\n".join(
            f"[{item.id}] {item.text}\nReasoning: {item.reasoning}" for item in selected
        )
        observation_body = "\n".join(
            f"[observation_id={item.id}] {item.content}"
            for item in all_evidence.values()
        )
        revised = _dedupe_drafts(
            _drafts(
                _json_object(
                    self._completion(
                        REVISE_SYSTEM,
                        REVISE_PROMPT.format(
                            propositions=proposition_body,
                            new_text=draft.text,
                            new_reasoning=draft.reasoning,
                            observations=observation_body,
                            max_propositions=self.max_propositions,
                        ),
                    )
                )
            ),
            limit=self.max_propositions,
        )
        if not revised:
            raise ValueError("model returned no propositions for a SIMILAR revision")
        evidence = list(all_evidence.values())
        replacements = [(item, self._evidence_ids(item, evidence)) for item in revised]
        self.store.replace_propositions(target_ids, replacements)

    def _record_update(
        self,
        draft: PropositionDraft,
        observations: list[ObservationRecord],
        *,
        target_ids: set[int],
        relation: str,
    ) -> None:
        evidence_ids = self._evidence_ids(draft, observations)
        evidence_by_id = {item.id: item for item in observations}
        evidence = [evidence_by_id[item] for item in evidence_ids]
        selected = self.store.propositions_by_id(target_ids)
        proposition_body = "\n\n".join(
            f"[{item.id}] {item.text}\nReasoning: {item.reasoning}" for item in selected
        )
        observation_body = "\n".join(
            f"[observation_id={item.id}] {item.content}" for item in evidence
        )
        payload = _json_object(
            self._completion(
                UPDATE_SYSTEM,
                UPDATE_PROMPT.format(
                    relation=relation,
                    propositions=proposition_body,
                    new_text=draft.text,
                    new_reasoning=draft.reasoning,
                    observations=observation_body,
                ),
            )
        )
        summary = str(payload.get("summary") or "").strip()
        reasoning = str(payload.get("reasoning") or "").strip()
        if not summary:
            summary = draft.text
        raw_ids = payload.get("observation_ids")
        update_draft = PropositionDraft(
            text=summary,
            reasoning=reasoning,
            observation_ids=(
                tuple(str(item) for item in raw_ids if item)
                if isinstance(raw_ids, list)
                else tuple(evidence_ids)
            ),
        )
        update_evidence_ids = self._evidence_ids(update_draft, evidence)
        self.store.insert_update(
            target_ids=target_ids,
            relation=relation,
            summary=summary,
            reasoning=reasoning,
            observation_ids=update_evidence_ids,
        )
