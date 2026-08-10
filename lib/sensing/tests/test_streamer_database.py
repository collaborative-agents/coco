import sqlite3

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
