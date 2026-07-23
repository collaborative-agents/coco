"""Tests for the memory module.

```
uv run pytest lib/memory/memory/tests/test_memory.py
```
"""

from __future__ import annotations

import json
import time

from memory import MemoryEngine, MemoryStore, ObservationInput
from memory import engine as memory_engine_module


def _obs(identifier: str, content: str) -> ObservationInput:
    return ObservationInput(id=identifier, content=content, created_at=time.time())


def test_hosted_vllm_engine_disables_thinking(monkeypatch, tmp_path):
    captured = {}

    def fake_prompt_to_text(model, system, prompt, *, extra_body=None):
        captured.update(
            model=model,
            system=system,
            prompt=prompt,
            extra_body=extra_body,
        )
        return "{}"

    monkeypatch.setattr(memory_engine_module, "prompt_to_text", fake_prompt_to_text)
    engine = MemoryEngine(
        MemoryStore(tmp_path / "memory.db"),
        user_name="User",
        model="hosted_vllm/Qwen/Qwen3.5-9B",
    )

    assert engine._complete("system", "prompt") == "{}"
    assert captured["extra_body"] == {
        "chat_template_kwargs": {"enable_thinking": False}
    }


def test_store_searches_propositions_and_returns_evidence(tmp_path):
    store = MemoryStore(tmp_path / "memory.db")
    store.add_observation(_obs("o1", "Debugging OAuth callback in VS Code"))
    from memory.models import PropositionDraft

    store.insert_proposition(
        PropositionDraft(
            "User is debugging OAuth", "VS Code showed callback errors", 8, 3
        ),
        ["o1"],
    )

    hits = store.search("OAuth VS Code", include_observations=1)

    assert hits[0].proposition.confidence == 8
    assert hits[0].observations[0].id == "o1"


def test_store_can_find_proposition_through_supporting_observation(tmp_path):
    store = MemoryStore(tmp_path / "memory.db")
    store.add_observation(_obs("o1", "Investigating a Keycloak callback failure"))
    from memory.models import PropositionDraft

    store.insert_proposition(
        PropositionDraft("User is debugging authentication", "Observed an auth error"),
        ["o1"],
    )

    hits = store.search("Keycloak")

    assert hits[0].proposition.text == "User is debugging authentication"


def test_direct_proposition_match_outranks_incidental_observation_match(tmp_path):
    store = MemoryStore(tmp_path / "memory.db")
    store.add_observation(
        _obs(
            "finance",
            "The Schwab account is foregrounded; a collaborative agent diagram "
            "remains incidentally visible in the background.",
        )
    )
    store.add_observation(_obs("agent", "Designing a collaborative agent system"))
    from memory.models import PropositionDraft

    store.insert_proposition(
        PropositionDraft(
            "User logged into a Charles Schwab brokerage account",
            "The account summary is in the foreground",
        ),
        ["finance"],
    )
    direct_id = store.insert_proposition(
        PropositionDraft(
            "User is designing a Collaborative Agent system",
            "The diagram explicitly describes agent collaboration",
        ),
        ["agent"],
    )

    hits = store.search("Collaborative Agent", limit=2)

    assert hits[0].proposition.id == direct_id


def test_engine_generates_and_marks_batch_processed(tmp_path):
    store = MemoryStore(tmp_path / "memory.db")
    store.add_observation(_obs("o1", "Working in VS Code on auth.py"))

    def complete(system: str, _prompt: str) -> str:
        assert "grounded model" in system
        return json.dumps(
            {
                "propositions": [
                    {
                        "proposition": "User is editing auth.py in VS Code",
                        "reasoning": "The observation explicitly says so",
                        "confidence": 9,
                        "decay": 3,
                    }
                ]
            }
        )

    engine = MemoryEngine(
        store, user_name="User", model="fake", min_batch_size=1, completion=complete
    )
    assert engine.process_pending_once() == 1
    assert store.pending_observations(10) == []
    assert store.search("auth VS Code")[0].proposition.confidence == 9


def test_engine_retries_invalid_json_with_smaller_batch(tmp_path):
    store = MemoryStore(tmp_path / "memory.db")
    for index in range(4):
        store.add_observation(_obs(f"o{index}", f"Working on task {index}"))

    attempted_batch_sizes = []

    def complete(system: str, prompt: str) -> str:
        assert "grounded model" in system
        batch_size = prompt.count("[observation_id=o")
        attempted_batch_sizes.append(batch_size)
        if batch_size > 2:
            return "The response was truncated before the JSON."
        return json.dumps(
            {
                "propositions": [
                    {
                        "proposition": "User is working on a task",
                        "reasoning": "The observations explicitly say so",
                        "observation_ids": ["o0"],
                    }
                ]
            }
        )

    engine = MemoryEngine(
        store,
        user_name="User",
        model="fake",
        min_batch_size=1,
        max_batch_size=4,
        completion=complete,
    )

    assert engine.process_pending_once(force=True) == 2
    assert attempted_batch_sizes == [4, 2]
    assert [item.id for item in store.pending_observations(10)] == ["o2", "o3"]


def test_engine_retains_unparseable_observation_without_proposition(caplog, tmp_path):
    store = MemoryStore(tmp_path / "memory.db")
    observation = _obs("unparseable", "Raw observation remains available")
    store.add_observation(observation)

    engine = MemoryEngine(
        store,
        user_name="User",
        model="fake",
        min_batch_size=1,
        completion=lambda _system, _prompt: "not valid JSON",
    )

    assert engine.process_pending_once(force=True) == 1
    assert store.pending_observations(10) == []
    assert store.search("") == []
    assert store.add_observation(observation) is False
    assert "unparseable" in caplog.text
    assert "without a proposition" in caplog.text


def test_engine_skips_draft_when_relation_response_is_invalid(caplog, tmp_path):
    store = MemoryStore(tmp_path / "memory.db")
    old_observation = _obs("old", "Using OAuth in project Alpha")
    new_observation = _obs("new", "Troubleshooting an OAuth callback in project Beta")
    store.add_observation(old_observation)
    from memory.models import PropositionDraft

    store.insert_proposition(
        PropositionDraft("User uses OAuth in project Alpha", "Observed directly"),
        ["old"],
    )
    store.mark_processed(["old"])
    store.add_observation(new_observation)

    def complete(system: str, _prompt: str) -> str:
        if "grounded model" in system:
            return json.dumps(
                {
                    "propositions": [
                        {
                            "proposition": "User troubleshoots an OAuth callback in project Beta",
                            "reasoning": "The callback was visible",
                            "observation_ids": ["new"],
                        }
                    ]
                }
            )
        assert "Classify" in system
        return "relation response was not JSON"

    engine = MemoryEngine(
        store,
        user_name="User",
        model="fake",
        min_batch_size=1,
        completion=complete,
    )

    assert engine.process_pending_once(force=True) == 1
    assert store.pending_observations(10) == []
    assert len(store.search("", limit=10)) == 1
    assert store.add_observation(new_observation) is False
    assert "memory merge returned invalid JSON" in caplog.text
    assert "new" in caplog.text


def test_identical_proposition_accumulates_new_evidence(tmp_path):
    store = MemoryStore(tmp_path / "memory.db")
    store.add_observation(_obs("old", "Using VS Code for OAuth work"))
    from memory.models import PropositionDraft

    pid = store.insert_proposition(
        PropositionDraft("User works on OAuth in VS Code", "Observed directly", 8, 4),
        ["old"],
    )
    store.mark_processed(["old"])
    store.add_observation(_obs("new", "Debugging OAuth in VS Code again"))

    def complete(system: str, _prompt: str) -> str:
        if "Classify" in system:
            return json.dumps({"label": "IDENTICAL", "target_ids": [pid]})
        return json.dumps(
            {
                "propositions": [
                    {
                        "proposition": "User works on OAuth in VS Code",
                        "reasoning": "Observed again",
                        "confidence": 9,
                        "decay": 4,
                    }
                ]
            }
        )

    engine = MemoryEngine(
        store, user_name="User", model="fake", min_batch_size=1, completion=complete
    )
    engine.process_pending_once()

    hit = store.search("OAuth VS Code", include_observations=5)[0]
    assert {item.id for item in hit.observations} == {"old", "new"}
    assert len(store.search("OAuth VS Code", limit=10)) == 1
    assert len(hit.updates) == 1
    assert hit.updates[0].relation == "IDENTICAL"


def test_propositions_link_only_their_cited_observations(tmp_path):
    store = MemoryStore(tmp_path / "memory.db")
    store.add_observation(_obs("auth", "Debugging a Keycloak OAuth callback"))
    store.add_observation(_obs("slides", "Designing presentation slides in Figma"))

    def complete(system: str, _prompt: str) -> str:
        if "grounded model" in system:
            return json.dumps(
                {
                    "propositions": [
                        {
                            "proposition": "User is debugging Keycloak OAuth",
                            "reasoning": "The callback failed",
                            "confidence": 8,
                            "decay": 3,
                            "observation_ids": ["auth"],
                        },
                        {
                            "proposition": "User is designing slides in Figma",
                            "reasoning": "A presentation was visible",
                            "confidence": 7,
                            "decay": 2,
                            "observation_ids": ["slides"],
                        },
                    ]
                }
            )
        return json.dumps({"label": "UNRELATED", "target_ids": []})

    engine = MemoryEngine(
        store, user_name="User", model="fake", min_batch_size=2, completion=complete
    )
    engine.process_pending_once()

    hits = store.search("", limit=10, include_observations=5)
    evidence = {
        hit.proposition.text: {item.id for item in hit.observations} for hit in hits
    }
    assert evidence["User is debugging Keycloak OAuth"] == {"auth"}
    assert evidence["User is designing slides in Figma"] == {"slides"}


def test_similar_claim_revises_and_replaces_original(tmp_path):
    store = MemoryStore(tmp_path / "memory.db")
    store.add_observation(_obs("old", "Editing a Coco diagram in Figma"))
    from memory.models import PropositionDraft

    old_pid = store.insert_proposition(
        PropositionDraft("User edits the Coco diagram in Figma", "Observed in Figma"),
        ["old"],
    )
    store.mark_processed(["old"])
    store.add_observation(
        _obs("new", "Refining the Coco collaboration-layer diagram in Figma")
    )

    def complete(system: str, _prompt: str) -> str:
        if "grounded model" in system:
            return json.dumps(
                {
                    "propositions": [
                        {
                            "proposition": "User refines a Coco collaboration diagram in Figma",
                            "reasoning": "The diagram was edited again",
                            "observation_ids": ["new"],
                        }
                    ]
                }
            )
        if "Classify" in system:
            return json.dumps({"label": "SIMILAR", "target_ids": [old_pid]})
        assert "Consolidate" in system
        return json.dumps(
            {
                "propositions": [
                    {
                        "proposition": "User refines Coco's collaboration-layer diagram in Figma",
                        "reasoning": "The old and new observations show continued editing.",
                        "confidence": 8,
                        "decay": 4,
                        "observation_ids": ["old", "new"],
                    }
                ]
            }
        )

    engine = MemoryEngine(
        store, user_name="User", model="fake", min_batch_size=1, completion=complete
    )
    engine.process_pending_once()

    hits = store.search("", limit=10, include_observations=5)
    assert len(hits) == 1
    assert hits[0].proposition.id != old_pid
    assert hits[0].proposition.text.startswith("User refines")
    assert {item.id for item in hits[0].observations} == {"old", "new"}
    assert hits[0].updates == []
    assert store.propositions_by_id([old_pid]) == []


def test_update_text_is_searchable_through_original_proposition(tmp_path):
    store = MemoryStore(tmp_path / "memory.db")
    store.add_observation(_obs("o1", "Authentication work"))
    from memory.models import PropositionDraft

    pid = store.insert_proposition(
        PropositionDraft("User is debugging authentication", "Observed"), ["o1"]
    )
    store.insert_update(
        target_ids=[pid],
        relation="SIMILAR",
        summary="The failure specifically involves Keycloak callbacks.",
        reasoning="The latest screen names Keycloak.",
        observation_ids=["o1"],
    )

    hit = store.search("Keycloak")[0]

    assert hit.proposition.id == pid
    assert hit.updates[0].summary.startswith("The failure specifically")


def test_reset_derived_memory_keeps_raw_observations(tmp_path):
    store = MemoryStore(tmp_path / "memory.db")
    store.add_observation(_obs("o1", "Working in Figma"))
    from memory.models import PropositionDraft

    store.insert_proposition(PropositionDraft("User uses Figma", "Observed"), ["o1"])
    store.mark_processed(["o1"])

    store.reset_derived_memory()

    assert store.search("") == []
    assert [item.id for item in store.pending_observations(10)] == ["o1"]
