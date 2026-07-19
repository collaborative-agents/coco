"""Interactive inspection for user feedback signal conversion.

Run with:

```
uv run coco-personalization inspect-feedback \
  --records-root "$HOME/Library/Application Support/coco/coco-records"
```

The inspector shows each feedback row, the derived short-window signal, the
linked observation, and any screenshot paths retained for that observation.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from personalization.records import flatten_sessions, load_records
from personalization.schemas import FeedbackEvent, ObservationRecord, ShortWindowSignal
from personalization.signals.user_feedback import feedback_to_short_window_signal


@dataclass(slots=True)
class FeedbackInspectionRow:
    index: int
    event: FeedbackEvent
    signal: ShortWindowSignal | None
    observation: ObservationRecord | None


def load_feedback_inspection_rows(
    records_root: str | Path,
) -> list[FeedbackInspectionRow]:
    """Load real Coco records and convert every feedback row for inspection."""
    records = flatten_sessions(load_records(records_root))
    observations = {obs.observation_id: obs for obs in records.observations}
    rows: list[FeedbackInspectionRow] = []
    for i, event in enumerate(records.feedback, start=1):
        rows.append(
            FeedbackInspectionRow(
                index=i,
                event=event,
                signal=feedback_to_short_window_signal(event),
                observation=observations.get(event.observation_id or ""),
            )
        )
    return rows


def format_feedback_signal_table(
    rows: list[FeedbackInspectionRow],
    *,
    limit: int = 80,
    now: float | None = None,
) -> str:
    """Render feedback-to-signal conversion as two compact image-status tables."""
    if not rows:
        return "No feedback rows found."

    now_ts = datetime.now().timestamp() if now is None else now
    rows_with_images = [row for row in rows if _has_existing_image(row.observation)]
    rows_missing_images = [
        row for row in rows if not _has_existing_image(row.observation)
    ]
    lines = [
        _format_table_section(
            "Rows with available screenshots",
            rows_with_images,
            limit=limit,
            now_ts=now_ts,
        ),
        "",
        _format_table_section(
            "Rows with missing screenshots",
            rows_missing_images,
            limit=limit,
            now_ts=now_ts,
        ),
    ]
    return "\n".join(lines).rstrip()


def _format_table_section(
    title: str,
    rows: list[FeedbackInspectionRow],
    *,
    limit: int,
    now_ts: float,
) -> str:
    header = [
        "#",
        "time",
        "kind",
        "surface",
        "status",
        "obs",
        "polarity",
        "conf",
        "scope",
        "ttl",
        "images",
        "evidence",
    ]
    lines = [f"{title} ({len(rows)})", _table_line(header), _table_rule(header)]
    if not rows:
        lines.append("(none)")
        return "\n".join(lines)

    body: list[list[str]] = []
    for row in rows[:limit]:
        event = row.event
        signal = row.signal
        ttl = ""
        if signal is not None:
            ttl_delta = signal.expires_at - now_ts
            ttl = f"{ttl_delta / 60:.1f}m"
        body.append(
            [
                str(row.index),
                _format_ts(event.ts),
                event.kind,
                event.surface,
                event.status or "",
                _short_id(event.observation_id),
                signal.polarity if signal else "ignored",
                f"{signal.confidence:.2f}" if signal else "",
                signal.scope if signal else "",
                ttl,
                _image_count_label(row.observation),
                _clip(signal.evidence if signal else event.text or "", 72),
            ]
        )

    lines.extend(_table_line(row) for row in body)
    if len(rows) > limit:
        lines.append(f"... {len(rows) - limit} more rows not shown")
    return "\n".join(lines)


def format_feedback_detail(row: FeedbackInspectionRow) -> str:
    """Render one feedback row with raw event, signal, observation, and images."""
    parts = [
        f"Feedback row #{row.index}",
        "",
        "[event]",
        json.dumps(row.event.to_dict(), indent=2, default=str),
        "",
        "[short_window_signal]",
        json.dumps(row.signal.to_dict(), indent=2, default=str)
        if row.signal
        else "(no signal: feedback kind is not mapped)",
        "",
        "[linked_observation]",
        _format_observation(row.observation),
        "",
        "[images]",
        _format_images(_image_paths(row.observation)),
    ]
    return "\n".join(parts)


def inspect_feedback_interactively(records_root: str | Path, *, limit: int = 80) -> int:
    """Open an interactive terminal loop for feedback inspection."""
    root = Path(records_root).expanduser()
    rows = load_feedback_inspection_rows(root)
    if not rows:
        print(f"No feedback rows found under {root}")
        return 1

    while True:
        print()
        print(f"Feedback conversion from: {root}")
        print(format_feedback_signal_table(rows, limit=limit))
        print()
        raw = input("Enter row # to inspect, r to reload, or q to quit: ").strip()
        if raw.lower() in {"q", "quit", "exit"}:
            return 0
        if raw.lower() in {"r", "reload"}:
            rows = load_feedback_inspection_rows(root)
            continue
        if not raw.isdigit():
            print("Please enter a row number, r, or q.")
            continue
        idx = int(raw)
        row = next((item for item in rows if item.index == idx), None)
        if row is None:
            print(f"No row with index {idx}.")
            continue
        print()
        print(format_feedback_detail(row))
        image_paths = _image_paths(row.observation)
        existing = [path for path in image_paths if path.is_file()]
        if existing:
            choice = input("Open existing image files? [y/N]: ").strip().lower()
            if choice in {"y", "yes"}:
                open_image_paths(existing)
        input("Press Enter to return to the table...")


def open_image_paths(paths: list[Path]) -> None:
    """Open image files with the OS default viewer."""
    if not paths:
        return
    system = platform.system().lower()
    if system == "darwin":
        command = ["open", *[str(path) for path in paths]]
    elif system == "linux":
        opener = shutil.which("xdg-open")
        if opener is None:
            print("xdg-open not found; image paths are listed above.")
            return
        for path in paths:
            subprocess.Popen([opener, str(path)])  # noqa: S603
        return
    elif system == "windows":
        for path in paths:
            os.startfile(path)  # type: ignore[attr-defined]  # noqa: S606
        return
    else:
        print("No known image opener for this platform; image paths are listed above.")
        return
    subprocess.run(command, check=False)  # noqa: S603


def resolve_default_records_root() -> Path | None:
    """Find a likely Coco records root from env vars or common local paths."""
    for key in ("COCO_PERSONALIZATION_RECORDS_ROOT", "COCO_RECORDS_ROOT"):
        value = os.getenv(key)
        if value:
            path = Path(value).expanduser()
            if path.exists():
                return path

    candidates = [
        Path("~/Library/Application Support/coco/coco-records").expanduser(),
        Path("~/Downloads/coco-records").expanduser(),
    ]
    return next((path for path in candidates if path.exists()), None)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Inspect user feedback signals")
    parser.add_argument(
        "--records-root",
        help="Coco records root or session directory. Defaults to common local paths.",
    )
    parser.add_argument("--limit", type=int, default=80, help="Rows to show per table")
    args = parser.parse_args(argv)

    records_root = Path(args.records_root).expanduser() if args.records_root else None
    if records_root is None:
        records_root = resolve_default_records_root()
    if records_root is None:
        print(
            "No records root found. Pass --records-root or set "
            "COCO_PERSONALIZATION_RECORDS_ROOT."
        )
        return 2
    return inspect_feedback_interactively(records_root, limit=args.limit)


def _format_observation(observation: ObservationRecord | None) -> str:
    if observation is None:
        return "(no observation found for this feedback row)"
    return json.dumps(
        {
            "observation_id": observation.observation_id,
            "session_id": observation.session_id,
            "ts": observation.ts,
            "type": observation.type,
            "model": observation.model,
            "observer_output": observation.observer_output,
            "retained_screenshots": observation.retained_screenshots,
            "screenshot_paths": observation.screenshot_paths,
        },
        indent=2,
        default=str,
    )


def _image_paths(observation: ObservationRecord | None) -> list[Path]:
    if observation is None:
        return []
    paths = observation.retained_screenshots or observation.screenshot_paths
    return [Path(path).expanduser() for path in paths]


def _has_existing_image(observation: ObservationRecord | None) -> bool:
    return any(path.is_file() for path in _image_paths(observation))


def _image_count_label(observation: ObservationRecord | None) -> str:
    paths = _image_paths(observation)
    if not paths:
        return "0/0"
    existing = sum(1 for path in paths if path.is_file())
    return f"{existing}/{len(paths)}"


def _format_images(paths: list[Path]) -> str:
    if not paths:
        return "(no image paths on this observation)"
    lines = []
    for i, path in enumerate(paths, start=1):
        status = "exists" if path.is_file() else "missing"
        lines.append(f"{i}. [{status}] {path}")
    return "\n".join(lines)


def _format_ts(ts: float) -> str:
    if not ts:
        return ""
    return datetime.fromtimestamp(ts).strftime("%m-%d %H:%M:%S")


def _short_id(value: str | None, *, n: int = 10) -> str:
    if not value:
        return ""
    return value if len(value) <= n else value[:n]


def _clip(value: str, width: int) -> str:
    text = " ".join(str(value).split())
    if len(text) <= width:
        return text
    return text[: max(0, width - 1)] + "..."


def _table_line(values: list[str]) -> str:
    widths = [3, 14, 11, 8, 13, 10, 8, 4, 11, 7, 6, 72]
    return " | ".join(
        value.ljust(width) for value, width in zip(values, widths, strict=True)
    )


def _table_rule(values: list[str]) -> str:
    widths = [3, 14, 11, 8, 13, 10, 8, 4, 11, 7, 6, 72]
    return "-+-".join("-" * width for _value, width in zip(values, widths, strict=True))


if __name__ == "__main__":
    raise SystemExit(main())
