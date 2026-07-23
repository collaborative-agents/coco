"""System activity checks used to suspend sensing while nobody is present."""

from __future__ import annotations

import time
from collections.abc import Callable


def macos_user_idle_seconds() -> float:
    """Return seconds since the last keyboard, mouse, or trackpad event."""
    import Quartz

    return float(
        Quartz.CGEventSourceSecondsSinceLastEventType(
            Quartz.kCGEventSourceStateCombinedSessionState,
            Quartz.kCGAnyInputEventType,
        )
    )


def macos_display_is_asleep() -> bool:
    """Return whether macOS reports the main display as asleep."""
    import Quartz

    return bool(Quartz.CGDisplayIsAsleep(Quartz.CGMainDisplayID()))


class SensingActivityMonitor:
    """Tracks whether expensive sensing work should be suspended.

    The system-wide idle counter is preferable to timestamps from our pynput
    listeners: it includes keyboard activity and remains meaningful across a
    laptop sleep/wake cycle. Providers are injectable to keep the policy easy
    to test and to allow a safe local fallback if a platform API fails.
    """

    def __init__(
        self,
        idle_timeout_seconds: float,
        *,
        idle_seconds: Callable[[], float] = macos_user_idle_seconds,
        display_is_asleep: Callable[[], bool] = macos_display_is_asleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.idle_timeout_seconds = idle_timeout_seconds
        self._idle_seconds = idle_seconds
        self._display_is_asleep = display_is_asleep
        self._clock = clock
        self._last_local_activity = clock()
        self._paused = False
        self.reason: str | None = None

    @property
    def paused(self) -> bool:
        return self._paused

    def note_activity(self) -> bool:
        """Record input and return True when it wakes a paused monitor."""
        was_paused = self._paused
        self._last_local_activity = self._clock()
        self._paused = False
        self.reason = None
        return was_paused

    def refresh(self) -> bool:
        """Refresh platform state and return whether sensing should pause."""
        try:
            display_asleep = self._display_is_asleep()
        except Exception:
            display_asleep = False

        if display_asleep:
            self._paused = True
            self.reason = "display_sleep"
            return True

        try:
            idle_for = self._idle_seconds()
        except Exception:
            idle_for = self._clock() - self._last_local_activity

        if self.idle_timeout_seconds > 0 and idle_for >= self.idle_timeout_seconds:
            self._paused = True
            self.reason = "user_idle"
        else:
            self._paused = False
            self.reason = None
        return self._paused
