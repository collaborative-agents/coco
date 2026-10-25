from __future__ import annotations

import platform
import threading
from datetime import datetime, timedelta
from typing import Any, Protocol

from proactive_tutor.tools.base import ToolDefinition, ToolProvider, object_schema


def _parse_datetime(value: Any, field: str) -> datetime:
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"{field} is required")
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{field} must be an ISO 8601 date-time") from exc
    if parsed.tzinfo is None:
        parsed = parsed.astimezone()
    return parsed


class AppleCalendarBackend(Protocol):
    def list_calendars(self) -> list[dict[str, Any]]: ...

    def list_events(
        self,
        start: datetime,
        end: datetime,
        calendar_names: list[str] | None,
    ) -> list[dict[str, Any]]: ...


class AppleCalendarPermissionError(RuntimeError):
    """Calendar access could not be granted to the process running Coco."""

    def __init__(self, message: str, authorization: str):
        super().__init__(message)
        self.authorization = authorization


class EventKitCalendarBackend:
    """Read Apple Calendar through macOS EventKit."""

    _PERMISSION_TIMEOUT_SECONDS = 30.0

    @staticmethod
    def _modules():
        try:
            import EventKit
            import Foundation
        except ImportError as exc:
            raise RuntimeError(
                "Apple Calendar support is not installed in this Coco build"
            ) from exc
        return EventKit, Foundation

    def _authorized_store(self):
        event_kit, _ = self._modules()
        event_type = event_kit.EKEntityTypeEvent
        status = event_kit.EKEventStore.authorizationStatusForEntityType_(event_type)
        authorized_statuses = {
            value
            for value in (
                getattr(event_kit, "EKAuthorizationStatusAuthorized", None),
                getattr(event_kit, "EKAuthorizationStatusFullAccess", None),
            )
            if value is not None
        }
        if status in authorized_statuses:
            return event_kit.EKEventStore.alloc().init()
        denied_statuses = {
            value
            for value in (
                getattr(event_kit, "EKAuthorizationStatusDenied", None),
                getattr(event_kit, "EKAuthorizationStatusRestricted", None),
                getattr(event_kit, "EKAuthorizationStatusWriteOnly", None),
            )
            if value is not None
        }
        if status in denied_statuses:
            raise AppleCalendarPermissionError(
                "Apple Calendar access is disabled. Allow Coco in System Settings "
                "→ Privacy & Security → Calendars.",
                authorization="denied",
            )

        not_determined = getattr(
            event_kit,
            "EKAuthorizationStatusNotDetermined",
            0,
        )
        if status != not_determined:
            raise AppleCalendarPermissionError(
                f"Apple Calendar returned an unsupported authorization status: {status}",
                authorization="unknown",
            )

        # Request access from the same EventKit store that will service this tool
        # call. macOS displays its native permission dialog; once the callback
        # succeeds, the original tool call continues instead of asking the user to
        # retry it.
        store = event_kit.EKEventStore.alloc().init()
        completed = threading.Event()
        outcome: dict[str, Any] = {}

        def completion(granted, error) -> None:
            outcome["granted"] = bool(granted)
            outcome["error"] = error
            completed.set()

        if hasattr(store, "requestFullAccessToEventsWithCompletion_"):
            store.requestFullAccessToEventsWithCompletion_(completion)
        else:
            store.requestAccessToEntityType_completion_(event_type, completion)
        if not completed.wait(self._PERMISSION_TIMEOUT_SECONDS):
            raise AppleCalendarPermissionError(
                "Timed out while requesting Apple Calendar access",
                authorization="not_determined",
            )
        if not outcome.get("granted"):
            error = outcome.get("error")
            final_status = event_kit.EKEventStore.authorizationStatusForEntityType_(
                event_type
            )
            if final_status == not_determined:
                raise AppleCalendarPermissionError(
                    "macOS could not display the Apple Calendar permission prompt. "
                    "Run a signed Coco app with the Calendar entitlement.",
                    authorization="not_determined",
                )
            detail = str(error) if error is not None else "permission was not granted"
            raise AppleCalendarPermissionError(
                f"Apple Calendar access failed: {detail}",
                authorization="denied",
            )
        return store

    @staticmethod
    def _calendar_record(calendar) -> dict[str, Any]:
        source = calendar.source()
        return {
            "id": str(calendar.calendarIdentifier()),
            "name": str(calendar.title()),
            "source": str(source.title()) if source is not None else None,
            "read_only": not bool(calendar.allowsContentModifications()),
        }

    def list_calendars(self) -> list[dict[str, Any]]:
        event_kit, _ = self._modules()
        store = self._authorized_store()
        calendars = store.calendarsForEntityType_(event_kit.EKEntityTypeEvent) or []
        return sorted(
            (self._calendar_record(calendar) for calendar in calendars),
            key=lambda item: (str(item["source"]), str(item["name"])),
        )

    def list_events(
        self,
        start: datetime,
        end: datetime,
        calendar_names: list[str] | None,
    ) -> list[dict[str, Any]]:
        if end <= start:
            raise ValueError("end must be later than start")
        event_kit, foundation = self._modules()
        store = self._authorized_store()
        calendars = list(
            store.calendarsForEntityType_(event_kit.EKEntityTypeEvent) or []
        )
        if calendar_names:
            requested = {name.casefold() for name in calendar_names}
            calendars = [
                calendar
                for calendar in calendars
                if str(calendar.title()).casefold() in requested
            ]
            if not calendars:
                raise ValueError("none of the requested Apple calendars were found")
        start_date = foundation.NSDate.dateWithTimeIntervalSince1970_(start.timestamp())
        end_date = foundation.NSDate.dateWithTimeIntervalSince1970_(end.timestamp())
        predicate = store.predicateForEventsWithStartDate_endDate_calendars_(
            start_date,
            end_date,
            calendars,
        )
        events = store.eventsMatchingPredicate_(predicate) or []
        local_tz = datetime.now().astimezone().tzinfo
        records: list[dict[str, Any]] = []
        for event in events:
            event_start = datetime.fromtimestamp(
                float(event.startDate().timeIntervalSince1970()),
                tz=local_tz,
            )
            event_end = datetime.fromtimestamp(
                float(event.endDate().timeIntervalSince1970()),
                tz=local_tz,
            )
            calendar = event.calendar()
            url = event.URL()
            records.append(
                {
                    "id": str(event.eventIdentifier()),
                    "title": str(event.title() or "(untitled event)"),
                    "start": event_start.isoformat(timespec="seconds"),
                    "end": event_end.isoformat(timespec="seconds"),
                    "all_day": bool(event.isAllDay()),
                    "calendar": str(calendar.title()) if calendar else None,
                    "location": str(event.location()) if event.location() else None,
                    "url": str(url.absoluteString()) if url is not None else None,
                }
            )
        return sorted(records, key=lambda item: (item["start"], item["end"]))


class AppleCalendarProvider(ToolProvider):
    """Read-only Apple Calendar tools available on macOS."""

    def __init__(self, backend: AppleCalendarBackend | None = None):
        self._backend = backend or EventKitCalendarBackend()

    def definitions(self) -> list[ToolDefinition]:
        if platform.system() != "Darwin":
            return []
        interval_properties = {
            "start": {
                "type": "string",
                "description": "Inclusive ISO 8601 start date-time with UTC offset.",
            },
            "end": {
                "type": "string",
                "description": "Exclusive ISO 8601 end date-time with UTC offset.",
            },
            "calendar_names": {
                "type": ["array", "null"],
                "items": {"type": "string"},
                "description": "Optional exact Apple Calendar names to include.",
            },
        }
        return [
            ToolDefinition(
                name="apple_calendar_list_calendars",
                description="List calendars available in the macOS Calendar app.",
                parameters=object_schema({}),
                source="apple_calendar",
            ),
            ToolDefinition(
                name="apple_calendar_list_events",
                description=(
                    "List Apple Calendar events that overlap a bounded time range."
                ),
                parameters=object_schema(
                    {
                        **interval_properties,
                        "query": {
                            "type": ["string", "null"],
                            "description": (
                                "Optional case-insensitive text filter over title, "
                                "location, and calendar name."
                            ),
                        },
                        "limit": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 100,
                            "default": 50,
                        },
                    },
                    ["start", "end"],
                ),
                source="apple_calendar",
            ),
            ToolDefinition(
                name="apple_calendar_find_free_time",
                description=(
                    "Find free gaps in Apple Calendar within a bounded time range."
                ),
                parameters=object_schema(
                    {
                        **interval_properties,
                        "duration_minutes": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 1440,
                        },
                        "limit": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 20,
                            "default": 10,
                        },
                    },
                    ["start", "end", "duration_minutes"],
                ),
                source="apple_calendar",
            ),
        ]

    def execute(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        try:
            if name == "apple_calendar_list_calendars":
                calendars = self._backend.list_calendars()
                return {
                    "source": "apple_calendar",
                    "count": len(calendars),
                    "calendars": calendars,
                }
            start = _parse_datetime(arguments.get("start"), "start")
            end = _parse_datetime(arguments.get("end"), "end")
            if end <= start:
                return {"error": "end must be later than start"}
            calendar_names = arguments.get("calendar_names")
            if calendar_names is not None and not isinstance(calendar_names, list):
                return {"error": "calendar_names must be an array or null"}
            if calendar_names is not None and not all(
                isinstance(name, str) and name.strip() for name in calendar_names
            ):
                return {"error": "calendar_names must contain non-empty strings"}
            events = self._backend.list_events(start, end, calendar_names)
            if name == "apple_calendar_list_events":
                query = str(arguments.get("query") or "").strip().casefold()
                if query:
                    events = [
                        event
                        for event in events
                        if query
                        in " ".join(
                            str(event.get(field) or "")
                            for field in ("title", "location", "calendar")
                        ).casefold()
                    ]
                limit = max(1, min(int(arguments.get("limit", 50)), 100))
                events = events[:limit]
                return {
                    "source": "apple_calendar",
                    "count": len(events),
                    "events": events,
                }
            if name != "apple_calendar_find_free_time":
                return {"error": f"tool is not available: {name}"}
            duration_minutes = int(arguments["duration_minutes"])
            if not 1 <= duration_minutes <= 1440:
                return {"error": "duration_minutes must be between 1 and 1440"}
            duration = timedelta(minutes=duration_minutes)
            busy = sorted(
                (
                    max(start, _parse_datetime(event["start"], "event.start")),
                    min(end, _parse_datetime(event["end"], "event.end")),
                )
                for event in events
            )
            merged: list[tuple[datetime, datetime]] = []
            for busy_start, busy_end in busy:
                if busy_end <= busy_start:
                    continue
                if merged and busy_start <= merged[-1][1]:
                    merged[-1] = (merged[-1][0], max(merged[-1][1], busy_end))
                else:
                    merged.append((busy_start, busy_end))
            cursor = start
            slots: list[dict[str, str]] = []
            for busy_start, busy_end in [*merged, (end, end)]:
                if busy_start - cursor >= duration:
                    slots.append(
                        {
                            "start": cursor.isoformat(timespec="seconds"),
                            "end": busy_start.isoformat(timespec="seconds"),
                        }
                    )
                cursor = max(cursor, busy_end)
            limit = max(1, min(int(arguments.get("limit", 10)), 20))
            return {
                "source": "apple_calendar",
                "duration_minutes": duration_minutes,
                "count": min(len(slots), limit),
                "slots": slots[:limit],
            }
        except AppleCalendarPermissionError as exc:
            return {
                "error": str(exc),
                "error_code": "apple_calendar_permission_required",
                "authorization": exc.authorization,
            }
        except (TypeError, ValueError, OSError, RuntimeError) as exc:
            return {"error": str(exc)}

    def instructions(self) -> str:
        if platform.system() != "Darwin":
            return ""
        return """
- Apple Calendar data is private. Use apple_calendar_* only when the user asks about their schedule, events, calendars, or availability, and request the smallest useful time range.
- For a generic "my calendar" request on macOS, prefer Apple Calendar because it can already contain synced iCloud, Google, and Exchange calendars. Do not also query Google Calendar unless the user requests that source or a cross-source check.
- Use ISO 8601 boundaries with the local UTC offset from current_datetime. Never invent an event or availability absent from the result.
- apple_calendar_find_free_time returns free gaps, not a claim that invitees are available.
"""
