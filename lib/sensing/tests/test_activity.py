from sensing.activity import SensingActivityMonitor


def test_pauses_after_system_idle_timeout_and_resumes_on_input():
    idle = [0.0]
    monitor = SensingActivityMonitor(
        300.0,
        idle_seconds=lambda: idle[0],
        display_is_asleep=lambda: False,
    )

    assert monitor.refresh() is False
    idle[0] = 300.0
    assert monitor.refresh() is True
    assert monitor.reason == "user_idle"
    assert monitor.note_activity() is True
    assert monitor.paused is False


def test_pauses_immediately_when_display_sleeps():
    asleep = [False]
    monitor = SensingActivityMonitor(
        300.0,
        idle_seconds=lambda: 0.0,
        display_is_asleep=lambda: asleep[0],
    )

    asleep[0] = True
    assert monitor.refresh() is True
    assert monitor.reason == "display_sleep"


def test_platform_idle_failure_uses_local_activity_clock():
    now = [10.0]

    def unavailable():
        raise RuntimeError("platform API unavailable")

    monitor = SensingActivityMonitor(
        5.0,
        idle_seconds=unavailable,
        display_is_asleep=lambda: False,
        clock=lambda: now[0],
    )

    now[0] = 16.0
    assert monitor.refresh() is True
    monitor.note_activity()
    assert monitor.refresh() is False
