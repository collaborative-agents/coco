import asyncio
import sqlite3
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from sensing import streamer as streamer_module
from sensing.streamer import Streamer


def _create_observations(db_path) -> None:
    with sqlite3.connect(db_path) as connection:
        connection.execute(
            "CREATE TABLE observations "
            "(id INTEGER PRIMARY KEY, content TEXT, content_type TEXT)"
        )
        connection.executemany(
            "INSERT INTO observations (id, content, content_type) VALUES (?, ?, ?)",
            [
                (1, "first input", "input_text"),
                (2, "screenshot", "input_image"),
                (3, "second input", "input_text"),
            ],
        )


def test_load_new_actions_filters_by_cursor_and_content_type(tmp_path) -> None:
    db_path = tmp_path / "actions.db"
    _create_observations(db_path)
    streamer = Streamer(str(db_path), str(tmp_path / "screens"))
    streamer._last_processed_id = 1

    actions, observation_ids = streamer._load_new_actions_from_db()

    assert actions == ["second input"]
    assert observation_ids == [3]
    assert streamer._last_processed_id_tmp == 3


def test_load_new_actions_for_periodic_delete_returns_every_row(tmp_path) -> None:
    db_path = tmp_path / "actions.db"
    _create_observations(db_path)
    streamer = Streamer(
        str(db_path),
        str(tmp_path / "screens"),
        periodic_delete=True,
    )

    actions, observation_ids = streamer._load_new_actions_from_db()

    assert actions == ["first input", "screenshot", "second input"]
    assert observation_ids == [1, 2, 3]


@pytest.mark.asyncio
async def test_process_actions_retains_before_and_mse_selected_action_frames(
    monkeypatch, tmp_path
) -> None:
    before_one = tmp_path / "before-one.jpg"
    after_one = tmp_path / "after-one.jpg"
    before_two = tmp_path / "before-two.jpg"
    after_two = tmp_path / "after-two.jpg"
    old_after = tmp_path / "old-after.jpg"
    for path in (before_one, after_one, before_two, after_two, old_after):
        path.write_bytes(path.name.encode())

    received = []

    async def process(**kwargs):
        received.append(kwargs)

    processor = SimpleNamespace(process=process)
    streamer = Streamer(
        str(tmp_path / "actions.db"),
        str(tmp_path),
        min_actions_threshold=2,
        segment_processors=[processor],
    )
    streamer._load_new_actions_from_db = MagicMock(
        return_value=(["raw-one", "raw-two"], [1, 2])
    )
    streamer._stored_actions.append(
        {
            "timestamp": 90.0,
            "action": "click(1, 2)",
            "state_str": {"before": None, "after": str(old_after)},
            "time_info": {"before": 90.0, "after": 90.5},
        }
    )
    streamer._last_processed_id_tmp = 2
    monkeypatch.setattr(
        streamer_module,
        "merge_actions",
        lambda _actions, enable_hotkey=False: (
            [
                {"before": "raw-one", "after": "raw-one"},
                {"before": "raw-two", "after": "raw-two"},
            ],
            ["click(10, 20)", "key_press('draft')"],
        ),
    )
    monkeypatch.setattr(
        streamer_module,
        "get_states",
        lambda _actions, _directory: [
            {"before": str(before_one), "after": str(after_one)},
            {"before": str(before_two), "after": str(after_two)},
        ],
    )
    monkeypatch.setattr(
        streamer_module,
        "measure_time_from_states",
        lambda _states: [
            {"before": 100.0, "after": 100.5, "range": 0.5, "diff": 0.0},
            {"before": 101.0, "after": 101.5, "range": 0.5, "diff": 0.5},
        ],
    )
    monkeypatch.setattr(
        streamer_module,
        "trigger_segmentation",
        lambda actions, **_kwargs: [actions],
    )

    await streamer._process_actions()
    await asyncio.sleep(0)

    assert len(received) == 1
    assert received[0]["type"] == "snapshot"
    assert [snapshot.image_path for snapshot in received[0]["action_snapshots"]] == [
        str(before_one),
        str(after_one),
        str(after_two),
    ]
    assert [snapshot.action for snapshot in received[0]["action_snapshots"]] == [
        None,
        "click(10, 20)",
        "key_press('draft')",
    ]
    assert [
        snapshot.associated_actions() for snapshot in received[0]["action_snapshots"]
    ] == [
        (),
        ("click(10, 20)",),
        ("key_press('draft')",),
    ]
    assert before_one.is_file()
    assert after_one.is_file()
    assert after_two.is_file()
    assert not old_after.exists()
    assert not before_two.exists()
