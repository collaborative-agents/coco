import json

from sensing.support_feedback import SupportFeedback


def policy():
    now = [1000.0]
    return SupportFeedback(clock=lambda: now[0]), now


def test_same_task_across_apps_stays_suppressed():
    feedback, now = policy()
    feedback.observe("one", json.dumps({"user_intent": "Debug login"}))
    feedback.record("one", "dismiss", "Add response logging")
    now[0] += 121
    feedback.observe(
        "two",
        json.dumps(
            {
                "current_task": "Debug login using browser docs",
                "task_continuity": "same",
                "repeats_dismissed_support": "yes",
            }
        ),
    )
    assert feedback.blocked()
    assert "Add response logging" in feedback.context()
    now[0] += 1800
    assert not feedback.blocked()


def test_three_rejections_do_not_add_a_longer_pause():
    feedback, now = policy()
    for index in range(3):
        feedback.record(str(index), "dismiss")
        now[0] += 10
    feedback.observe(
        "new",
        json.dumps(
            {
                "current_task": "Write email",
                "task_continuity": "new",
                "repeats_dismissed_support": "no",
            }
        ),
    )
    assert feedback.blocked()
    now[0] += 121
    assert not feedback.blocked()


def test_different_help_allowed_after_minimum_cooldown():
    feedback, now = policy()
    feedback.record("one", "dismiss")
    feedback.observe("new", json.dumps({"repeats_dismissed_support": "no"}))
    assert feedback.blocked()
    now[0] += 121
    assert not feedback.blocked()


def test_one_suggestion_is_not_counted_twice_and_expiration_is_not_rejection():
    feedback, now = policy()
    for kind in ("shown", "expired", "engage"):
        feedback.record("ignored", kind)
    assert not feedback.blocked()
    for kind in ("dismiss", "dismiss", "thumbs_down"):
        feedback.record("same", kind)
    assert len(feedback.dismissals) == 1
    assert feedback.cooldown_until == now[0] + 120


def test_unknown_or_malformed_judgment_does_not_bypass_suppression():
    feedback, now = policy()
    feedback.record("one", "thumbs_down")
    now[0] += 121
    feedback.observe("bad", "not json")
    assert feedback.blocked()
    for index in range(30):
        feedback.observe(str(index), "{}")
    assert "thumbs_down" in feedback.context()


def test_processor_gates_bubbles_invites_and_pause_but_not_user_prompt():
    from types import SimpleNamespace

    from sensing.segment_processor import AiTutoringProcessor

    processor = AiTutoringProcessor(
        http_client=SimpleNamespace(),
        tutor_url="http://localhost:8081",
        ai_tutor_output_log="unused",
        observer_model="test",
    )
    queue = processor.subscribe_observations()
    pause_queue = processor.subscribe_pause()
    processor.record_reaction("dismissed", "dismiss", "Add logs")
    raw = json.dumps({"status": "inefficient", "user_intent": "Debug login"})
    processor._broadcast_observation("snapshot", raw)
    assert queue.get_nowait()["status"] == "observing"
    processor.broadcast_invite(raw, "Debug login")
    assert queue.empty()
    processor.broadcast_pause({"data": {}})
    assert pause_queue.empty()
    processor._broadcast_observation("user_prompt", raw)
    assert queue.get_nowait()["status"] == "inefficient"
