import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from PIL import Image
from sensing import segment_processor
from sensing.segment_processor import (
    AiTutoringProcessor,
    Snapshot,
    _classify_observation_status,
    _extract_need_support,
    _retrieve_instant_suggestion_context,
    meaningful_action_snapshots,
)


def test_need_support_yes_maps_to_actionable_status():
    observation = json.dumps(
        {
            "observation": "The user is repeatedly copying values between apps.",
            "user_intent": "Transfer evaluation results",
            "need_support": "yes",
            "rationale": "Automating the repeated transfer would save time.",
        }
    )

    assert (
        _classify_observation_status("everyday_support", observation)
        == "support_needed"
    )


def test_need_support_no_maps_to_neutral_status():
    observation = json.dumps(
        {
            "observation": "The user opened a document and is reading it.",
            "user_intent": "Review the document",
            "need_support": "no",
            "rationale": "The user is progressing normally.",
        }
    )

    assert _classify_observation_status("everyday_support", observation) == "observing"


def test_need_support_accepts_json_booleans():
    assert _extract_need_support('{"need_support": true}') == "yes"
    assert _extract_need_support('{"need_support": false}') == "no"


def test_broadcast_surfaces_support_decision_and_rationale():
    processor = AiTutoringProcessor(
        http_client=SimpleNamespace(),
        tutor_url="http://localhost:8081",
        ai_tutor_output_log="unused.log",
        observer_model="provider/observer",
    )
    queue = processor.subscribe_observations()
    observation = json.dumps(
        {
            "observation": "The user is blocked by a recurring error.",
            "user_intent": "Fix the build",
            "need_support": "yes",
            "rationale": "The same build error has persisted across frames.",
        }
    )

    retrieved_context = {
        "query": "Fix the build The user is blocked by a recurring error.",
        "results": [{"id": 7, "text": "A related build failed previously."}],
    }
    processor._broadcast_observation(
        "snapshot", observation, retrieved_context=retrieved_context
    )

    event = queue.get_nowait()
    assert event["status"] == "support_needed"
    assert event["need_support"] == "yes"
    assert event["rationale"] == "The same build error has persisted across frames."
    assert event["retrieved_context"] == retrieved_context
    assert event["proactive_allowed"] is True
    assert event["proactive_cooldown_remaining_s"] == 0


def test_confirmed_proactive_display_starts_global_cooldown(monkeypatch):
    now = [1_000.0]
    monkeypatch.setattr(segment_processor.time, "monotonic", lambda: now[0])
    processor = AiTutoringProcessor(
        http_client=SimpleNamespace(),
        tutor_url="http://localhost:8081",
        ai_tutor_output_log="unused.log",
        observer_model="provider/observer",
    )
    queue = processor.subscribe_observations()
    support_observation = json.dumps(
        {
            "observation": "The user is blocked by a recurring error.",
            "need_support": "yes",
        }
    )

    processor.record_reaction("observation-1", "shown", status="support_needed")
    processor._broadcast_observation("snapshot", support_observation)

    event = queue.get_nowait()
    assert event["proactive_allowed"] is False
    assert event["proactive_cooldown_remaining_s"] == 60

    now[0] += 60
    processor._broadcast_observation("snapshot", support_observation)

    event = queue.get_nowait()
    assert event["proactive_allowed"] is True
    assert event["proactive_cooldown_remaining_s"] == 0


def test_non_proactive_display_does_not_start_global_cooldown(monkeypatch):
    monkeypatch.setattr(segment_processor.time, "monotonic", lambda: 1_000.0)
    processor = AiTutoringProcessor(
        http_client=SimpleNamespace(),
        tutor_url="http://localhost:8081",
        ai_tutor_output_log="unused.log",
        observer_model="provider/observer",
    )

    processor.record_reaction("observation-1", "shown", status="progress")

    assert processor.proactive_cooldown_remaining_seconds() == 0


def test_retrieves_three_propositions_with_one_evidence_for_support_need():
    evidence = SimpleNamespace(
        id="evidence-1",
        content='{"observation":"A related earlier task."}',
        created_at=123.0,
        observation_type="snapshot",
        session_id="session-1",
    )
    hits = [
        SimpleNamespace(
            proposition=SimpleNamespace(
                id=index,
                text=f"Relevant proposition {index}",
                confidence=8,
                decay=5,
            ),
            score=1.0 / index,
            observations=[evidence],
        )
        for index in range(1, 4)
    ]
    store = SimpleNamespace(search=MagicMock(return_value=hits))
    observer_output = json.dumps(
        {
            "observation": "The user is drafting a detailed reply in Outlook.",
            "user_intent": "Reply to the recruiter",
            "need_support": "yes",
            "rationale": "The reply needs several missing details.",
        }
    )

    context = _retrieve_instant_suggestion_context(
        store, observer_output, end_time=456.0
    )

    assert context is not None
    assert context["query"] == (
        "Reply to the recruiter The user is drafting a detailed reply in Outlook."
    )
    assert len(context["results"]) == 3
    assert context["results"][0]["evidence"]["id"] == "evidence-1"
    store.search.assert_called_once_with(
        context["query"],
        limit=3,
        end_time=456.0,
        include_observations=1,
    )


def test_skips_instant_context_retrieval_when_support_is_not_needed():
    store = SimpleNamespace(search=MagicMock())

    context = _retrieve_instant_suggestion_context(
        store,
        json.dumps(
            {
                "observation": "The user is reading normally.",
                "user_intent": "Review a document",
                "need_support": "no",
            }
        ),
    )

    assert context is None
    store.search.assert_not_called()


def test_pause_broadcast_uses_explicit_support_status():
    processor = AiTutoringProcessor(
        http_client=SimpleNamespace(),
        tutor_url="http://localhost:8081",
        ai_tutor_output_log="unused.log",
        observer_model="provider/observer",
    )
    queue = processor.subscribe_observations()

    processor._broadcast_observation(
        "pause",
        '{"need_support":"no","rationale":"Brief idle time is not a blocker."}',
    )

    event = queue.get_nowait()
    assert event["status"] == "observing"
    assert event["need_support"] == "no"


@pytest.mark.asyncio
async def test_pause_no_support_suppresses_proactive_tutor_event():
    processor = AiTutoringProcessor(
        http_client=SimpleNamespace(),
        tutor_url="http://localhost:8081",
        ai_tutor_output_log="unused.log",
        observer_model="provider/observer",
    )
    processor._handle_observation = AsyncMock(
        return_value=(
            '{"need_support":"no","rationale":"The user is only briefly idle."}',
            "observer input",
            {},
        )
    )
    processor.broadcast_pause = MagicMock()

    await processor._handle_pause(image_path=None, timestamp=None)

    processor.broadcast_pause.assert_not_called()


@pytest.mark.asyncio
async def test_pause_yes_support_reaches_proactive_tutor():
    processor = AiTutoringProcessor(
        http_client=SimpleNamespace(),
        tutor_url="http://localhost:8081",
        ai_tutor_output_log="unused.log",
        observer_model="provider/observer",
    )
    processor._handle_observation = AsyncMock(
        return_value=(
            '{"need_support":"yes","rationale":"A persistent error is visible."}',
            "observer input",
            {},
        )
    )
    processor.broadcast_pause = MagicMock()

    await processor._handle_pause(image_path=None, timestamp=None)

    processor.broadcast_pause.assert_called_once()


@pytest.mark.asyncio
async def test_detected_actions_trigger_snapshot_observation_with_cooldown(
    tmp_path,
):
    processor = AiTutoringProcessor(
        http_client=SimpleNamespace(),
        tutor_url="http://localhost:8081",
        ai_tutor_output_log="",
        observer_model="provider/observer",
        action_snapshot_cooldown_seconds=20,
    )
    processor._handle_observation = AsyncMock(
        return_value=("observation", "observer input", {})
    )
    processor._cleanup_consumed_screenshots = MagicMock()

    await processor._handle_snapshot(str(tmp_path / "first.jpg"), "100")
    await processor._handle_snapshot(str(tmp_path / "second.jpg"), "105")
    processor._last_snapshot_trigger_at -= 21
    await processor._handle_snapshot(str(tmp_path / "third.jpg"), "121")

    assert processor._handle_observation.await_count == 2
    processor._cleanup_consumed_screenshots.assert_any_call(
        [str(tmp_path / "second.jpg")]
    )


@pytest.mark.asyncio
async def test_default_action_trigger_is_not_blocked_by_shared_timer_cursor(tmp_path):
    processor = AiTutoringProcessor(
        http_client=SimpleNamespace(),
        tutor_url="http://localhost:8081",
        ai_tutor_output_log="",
        observer_model="provider/observer",
    )
    processor._handle_observation = AsyncMock(
        return_value=("observation", "observer input", {})
    )
    processor._last_snapshot_trigger_at = time.monotonic()

    await processor._handle_action_snapshots(
        [
            Snapshot(
                str(tmp_path / "after.jpg"),
                str(time.time()),
                action="click(1, 2)",
            )
        ]
    )

    processor._handle_observation.assert_awaited_once_with(type="snapshot")


def test_meaningful_actions_select_one_ordered_frame_per_merged_node(tmp_path):
    click_frame = tmp_path / "click-after.jpg"
    typing_frame = tmp_path / "typing-after.jpg"
    consumed_frame = tmp_path / "already-consumed.jpg"
    click_frame.write_bytes(b"click")
    typing_frame.write_bytes(b"typing")
    segments = [
        [
            {
                "action": "click(10, 20)",
                "state_str": {"before": None, "after": str(click_frame)},
                "timestamp": 100.0,
                "time_info": {"before": 100.0, "after": 100.5},
            },
            {
                "action": "key_press('draft')",
                "state_str": {"before": None, "after": str(typing_frame)},
                "timestamp": 101.0,
                "time_info": {"before": 101.0, "after": 102.0},
            },
            {
                "action": "scroll(10, 20, dy=-1)",
                "state_str": {"before": None, "after": str(consumed_frame)},
                "timestamp": 103.0,
                "time_info": {"before": 103.0, "after": 103.5},
            },
        ]
    ]

    snapshots = meaningful_action_snapshots(segments)

    assert [snapshot.image_path for snapshot in snapshots] == [
        str(click_frame),
        str(typing_frame),
    ]
    assert [snapshot.action for snapshot in snapshots] == [
        "click(10, 20)",
        "key_press('draft')",
    ]
    assert [snapshot.timestamp for snapshot in snapshots] == ["100.5", "102.0"]


@pytest.mark.asyncio
async def test_action_snapshots_mse_dedup_and_forward_actions(tmp_path):
    before = tmp_path / "before.png"
    after_click = tmp_path / "after-click.png"
    after_typing = tmp_path / "after-typing.png"
    after_scroll = tmp_path / "after-scroll.png"
    Image.new("RGB", (4, 4), color=(0, 0, 0)).save(before)
    Image.new("RGB", (4, 4), color=(0, 0, 0)).save(after_click)
    Image.new("RGB", (4, 4), color=(255, 255, 255)).save(after_typing)
    Image.new("RGB", (4, 4), color=(255, 255, 255)).save(after_scroll)
    now = time.time()
    nodes = [
        {
            "action": "click(10, 20)",
            "state_str": {"before": str(before), "after": str(after_click)},
            "timestamp": now,
            "time_info": {"before": now, "after": now + 0.1},
        },
        {
            "action": "key_press('draft')",
            "state_str": {"before": str(after_click), "after": str(after_typing)},
            "timestamp": now + 1,
            "time_info": {"before": now + 1, "after": now + 1.1},
        },
        {
            "action": "scroll(10, 20, dy=-1)",
            "state_str": {"before": str(after_typing), "after": str(after_scroll)},
            "timestamp": now + 2,
            "time_info": {"before": now + 2, "after": now + 2.1},
        },
    ]

    snapshots = meaningful_action_snapshots([nodes], mse_threshold=8000)

    assert [snapshot.image_path for snapshot in snapshots] == [
        str(before),
        str(after_typing),
        str(after_scroll),
    ]
    assert [snapshot.associated_actions() for snapshot in snapshots] == [
        (),
        ("click(10, 20)", "key_press('draft')"),
        ("scroll(10, 20, dy=-1)",),
    ]

    processor = AiTutoringProcessor(
        http_client=SimpleNamespace(),
        tutor_url="http://localhost:8081",
        ai_tutor_output_log="",
        observer_model="provider/observer",
    )
    captured = {}

    async def fake_handle_observation(*, type):
        prompt, image_paths = processor._collect_images("context")
        captured.update(prompt=prompt, image_paths=image_paths, type=type)
        return "observation", prompt, {}

    processor._handle_observation = fake_handle_observation
    await processor.process(type="snapshot", action_snapshots=snapshots)

    assert captured["image_paths"] == [
        str(before),
        str(after_typing),
        str(after_scroll),
    ]
    assert "Screenshot 1 of 3 | User" not in captured["prompt"]
    assert (
        "Screenshot 2 of 3 | User actions: click(10, 20); "
        "key_press('draft')" in captured["prompt"]
    )
    assert (
        "Screenshot 3 of 3 | User action: scroll(10, 20, dy=-1)" in captured["prompt"]
    )


@pytest.mark.asyncio
async def test_action_observation_includes_frames_and_text_for_each_action(tmp_path):
    first_frame = tmp_path / "first.jpg"
    second_frame = tmp_path / "second.jpg"
    first_frame.write_bytes(b"first")
    second_frame.write_bytes(b"second")
    now = time.time()
    segments = [
        [
            {
                "action": "click(10, 20)",
                "state_str": {"before": None, "after": str(first_frame)},
                "timestamp": now,
                "time_info": {"before": now, "after": now + 0.1},
            },
            {
                "action": "key_press('<draft>')",
                "state_str": {"before": None, "after": str(second_frame)},
                "timestamp": now + 1,
                "time_info": {"before": now + 1, "after": now + 1.5},
            },
        ]
    ]
    processor = AiTutoringProcessor(
        http_client=SimpleNamespace(),
        tutor_url="http://localhost:8081",
        ai_tutor_output_log="",
        observer_model="provider/observer",
    )
    captured = {}

    async def fake_handle_observation(*, type):
        prompt, image_paths = processor._collect_images("context")
        captured.update(prompt=prompt, image_paths=image_paths, type=type)
        return "observation", prompt, {}

    processor._handle_observation = fake_handle_observation

    await processor.process(segments=segments, type="snapshot")

    assert captured["type"] == "snapshot"
    assert captured["image_paths"] == [str(first_frame), str(second_frame)]
    assert "<user_actions>" not in captured["prompt"]
    assert "Screenshot 1 of 2 | User action: click(10, 20)" in captured["prompt"]
    assert (
        "Screenshot 2 of 2 | User action: key_press('&lt;draft&gt;')"
        in captured["prompt"]
    )


def test_human_mistake_maps_to_mistake_status():
    observation = json.dumps(
        {
            "mistake_made_by_human": "The visible word 'teh' is a typo.",
            "inefficiency_patterns": "no delegation opportunity",
        }
    )

    assert _classify_observation_status("everyday_support", observation) == "mistake"


def test_no_human_mistake_is_neutral():
    observation = json.dumps(
        {
            "mistake_made_by_human": "no human mistake detected",
            "inefficiency_patterns": "no delegation opportunity",
        }
    )

    assert _classify_observation_status("everyday_support", observation) == "progress"


def test_openai_compatible_observer_does_not_inject_provider_options(monkeypatch):
    captured = {}

    def fake_chat_completion(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(content="{}"), {}

    monkeypatch.setattr(segment_processor, "chat_completion", fake_chat_completion)

    segment_processor._observe(
        "describe the screen",
        model="hosted_vllm/Qwen/Qwen3.5-35B-A3B",
    )

    assert "extra_body" not in captured
    assert "reasoning_effort" not in captured


def test_inkling_observer_disables_reasoning_effort(monkeypatch):
    captured = {}

    def fake_chat_completion(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(content="{}"), {}

    monkeypatch.setattr(segment_processor, "chat_completion", fake_chat_completion)

    segment_processor._observe(
        "describe the screen",
        model="hosted_vllm/thinkingmachines/Inkling-Small:peft:262144",
    )

    assert captured["reasoning_effort"] == "none"
    assert "extra_body" not in captured
