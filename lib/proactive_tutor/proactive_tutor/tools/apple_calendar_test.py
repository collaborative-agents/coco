from __future__ import annotations

from datetime import datetime
from typing import Any

from proactive_tutor.tools import apple_calendar as apple_calendar_module
from proactive_tutor.tools.apple_calendar import (
    AppleCalendarProvider,
    EventKitCalendarBackend,
)


class _FakeCalendarBackend:
    def __init__(self):
        self.calls: list[tuple[datetime, datetime, list[str] | None]] = []

    def list_calendars(self) -> list[dict[str, Any]]:
        return [
            {
                "id": "work-id",
                "name": "Work",
                "source": "iCloud",
                "read_only": False,
            }
        ]

    def list_events(
        self,
        start: datetime,
        end: datetime,
        calendar_names: list[str] | None,
    ) -> list[dict[str, Any]]:
        self.calls.append((start, end, calendar_names))
        return [
            {
                "id": "one",
                "title": "Design review",
                "start": "2026-08-31T10:00:00-07:00",
                "end": "2026-08-31T11:00:00-07:00",
                "all_day": False,
                "calendar": "Work",
                "location": "Voyager",
                "url": None,
            },
            {
                "id": "two",
                "title": "Lunch",
                "start": "2026-08-31T12:00:00-07:00",
                "end": "2026-08-31T13:30:00-07:00",
                "all_day": False,
                "calendar": "Personal",
                "location": None,
                "url": None,
            },
        ]


class _FakeEventStore:
    authorization_status = 0
    request_count = 0
    request_granted = True

    @classmethod
    def authorizationStatusForEntityType_(cls, _event_type):
        return cls.authorization_status

    @classmethod
    def alloc(cls):
        return cls()

    def init(self):
        return self

    def requestFullAccessToEventsWithCompletion_(self, completion) -> None:
        type(self).request_count += 1
        if type(self).request_granted:
            type(self).authorization_status = 3
        completion(type(self).request_granted, None)

    def calendarsForEntityType_(self, _event_type):
        return []


class _FakeEventKit:
    EKEntityTypeEvent = 0
    EKAuthorizationStatusNotDetermined = 0
    EKAuthorizationStatusRestricted = 1
    EKAuthorizationStatusDenied = 2
    EKAuthorizationStatusAuthorized = 3
    EKAuthorizationStatusFullAccess = 3
    EKAuthorizationStatusWriteOnly = 4
    EKEventStore = _FakeEventStore


def _provider(monkeypatch) -> tuple[AppleCalendarProvider, _FakeCalendarBackend]:
    monkeypatch.setattr(apple_calendar_module.platform, "system", lambda: "Darwin")
    backend = _FakeCalendarBackend()
    return AppleCalendarProvider(backend), backend


def test_apple_calendar_tools_are_only_advertised_on_macos(monkeypatch) -> None:
    provider = AppleCalendarProvider(_FakeCalendarBackend())
    monkeypatch.setattr(apple_calendar_module.platform, "system", lambda: "Linux")

    assert provider.definitions() == []
    assert provider.instructions() == ""


def test_first_eventkit_call_requests_permission_and_continues(monkeypatch) -> None:
    _FakeEventStore.authorization_status = (
        _FakeEventKit.EKAuthorizationStatusNotDetermined
    )
    _FakeEventStore.request_count = 0
    _FakeEventStore.request_granted = True
    backend = EventKitCalendarBackend()
    monkeypatch.setattr(backend, "_modules", lambda: (_FakeEventKit, object()))

    assert backend.list_calendars() == []
    assert _FakeEventStore.request_count == 1


def test_suppressed_eventkit_prompt_is_not_reported_as_user_denial(
    monkeypatch,
) -> None:
    _FakeEventStore.authorization_status = (
        _FakeEventKit.EKAuthorizationStatusNotDetermined
    )
    _FakeEventStore.request_count = 0
    _FakeEventStore.request_granted = False
    backend = EventKitCalendarBackend()
    monkeypatch.setattr(backend, "_modules", lambda: (_FakeEventKit, object()))

    result = AppleCalendarProvider(backend).execute(
        "apple_calendar_list_calendars",
        {},
    )

    assert result["error_code"] == "apple_calendar_permission_required"
    assert result["authorization"] == "not_determined"
    assert "signed Coco app" in result["error"]
    assert _FakeEventStore.request_count == 1


def test_eventkit_denial_is_returned_as_structured_permission_error(
    monkeypatch,
) -> None:
    _FakeEventStore.authorization_status = _FakeEventKit.EKAuthorizationStatusDenied
    _FakeEventStore.request_count = 0
    _FakeEventStore.request_granted = True
    backend = EventKitCalendarBackend()
    monkeypatch.setattr(backend, "_modules", lambda: (_FakeEventKit, object()))

    result = AppleCalendarProvider(backend).execute(
        "apple_calendar_list_calendars",
        {},
    )

    assert result["error_code"] == "apple_calendar_permission_required"
    assert result["authorization"] == "denied"
    assert _FakeEventStore.request_count == 0


def test_list_calendars_and_filtered_events(monkeypatch) -> None:
    provider, backend = _provider(monkeypatch)

    calendars = provider.execute("apple_calendar_list_calendars", {})
    events = provider.execute(
        "apple_calendar_list_events",
        {
            "start": "2026-08-31T09:00:00-07:00",
            "end": "2026-08-31T17:00:00-07:00",
            "calendar_names": ["Work"],
            "query": "voyager",
            "limit": 5,
        },
    )

    assert calendars["calendars"][0]["name"] == "Work"
    assert events["count"] == 1
    assert events["events"][0]["title"] == "Design review"
    assert backend.calls[0][2] == ["Work"]


def test_find_free_time_merges_busy_intervals(monkeypatch) -> None:
    provider, _ = _provider(monkeypatch)

    result = provider.execute(
        "apple_calendar_find_free_time",
        {
            "start": "2026-08-31T09:00:00-07:00",
            "end": "2026-08-31T17:00:00-07:00",
            "duration_minutes": 60,
        },
    )

    assert result == {
        "source": "apple_calendar",
        "duration_minutes": 60,
        "count": 3,
        "slots": [
            {
                "start": "2026-08-31T09:00:00-07:00",
                "end": "2026-08-31T10:00:00-07:00",
            },
            {
                "start": "2026-08-31T11:00:00-07:00",
                "end": "2026-08-31T12:00:00-07:00",
            },
            {
                "start": "2026-08-31T13:30:00-07:00",
                "end": "2026-08-31T17:00:00-07:00",
            },
        ],
    }


def test_apple_calendar_rejects_invalid_ranges_and_filters(monkeypatch) -> None:
    provider, _ = _provider(monkeypatch)

    backwards = provider.execute(
        "apple_calendar_list_events",
        {
            "start": "2026-08-31T17:00:00-07:00",
            "end": "2026-08-31T09:00:00-07:00",
        },
    )
    invalid_names = provider.execute(
        "apple_calendar_list_events",
        {
            "start": "2026-08-31T09:00:00-07:00",
            "end": "2026-08-31T17:00:00-07:00",
            "calendar_names": [7],
        },
    )

    assert backwards == {"error": "end must be later than start"}
    assert invalid_names == {"error": "calendar_names must contain non-empty strings"}
