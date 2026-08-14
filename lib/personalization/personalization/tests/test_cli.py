from types import SimpleNamespace

from personalization import cli


def test_self_evolve_accepts_labeled_input(monkeypatch):
    captured = {}

    def fake_command(args):
        captured["args"] = args
        return 0

    monkeypatch.setattr(cli, "_cmd_self_evolve", fake_command)

    result = cli.main(
        [
            "self-evolve",
            "--labeled",
            "reviewed.jsonl",
            "--image-root",
            "dataset",
            "--out-dir",
            "memory",
            "--prediction-model",
            "fake/model",
        ]
    )

    assert result == 0
    assert captured["args"].labeled == "reviewed.jsonl"
    assert captured["args"].records_root is None
    assert captured["args"].image_root == "dataset"
    assert captured["args"].shuffle is False
    assert captured["args"].correct_sample_rate == 0.5


def test_self_evolve_accepts_records_input(monkeypatch):
    captured = {}

    def fake_command(args):
        captured["args"] = args
        return 0

    monkeypatch.setattr(cli, "_cmd_self_evolve", fake_command)

    result = cli.main(
        [
            "self-evolve",
            "--records-root",
            "records",
            "--out-dir",
            "memory",
            "--prediction-model",
            "fake/model",
        ]
    )

    assert result == 0
    assert captured["args"].records_root == "records"
    assert captured["args"].labeled is None


def test_label_last_days_filters_output_after_labeling(monkeypatch):
    captured = {}
    labeled = [
        SimpleNamespace(ts=100_000.0, moment_id="old"),
        SimpleNamespace(ts=150_000.0, moment_id="recent"),
    ]
    monkeypatch.setattr(cli, "_load_flat_records", lambda _root: ([], object()))
    monkeypatch.setattr(cli, "label_records", lambda _records, **_kwargs: labeled)
    monkeypatch.setattr(cli.time, "time", lambda: 200_000.0)
    monkeypatch.setattr(
        cli,
        "write_labeled_moments",
        lambda path, moments: captured.update(path=path, moments=moments),
    )

    result = cli._cmd_label(
        SimpleNamespace(
            records_root="records",
            out="recent.jsonl",
            min_abs_score=0.45,
            include_unverified_no_support=True,
            unverified_no_support_confidence=0.25,
            require_saved_images=True,
            last_days=1,
        )
    )

    assert result == 0
    assert captured["path"] == "recent.jsonl"
    assert [moment.moment_id for moment in captured["moments"]] == ["recent"]


def test_label_cli_accepts_last_days(monkeypatch):
    captured = {}
    monkeypatch.setattr(
        cli,
        "_cmd_label",
        lambda args: captured.update(args=args) or 0,
    )

    result = cli.main(
        [
            "label",
            "--records-root",
            "records",
            "--out",
            "labeled.jsonl",
            "--last-days",
            "4",
        ]
    )

    assert result == 0
    assert captured["args"].last_days == 4
