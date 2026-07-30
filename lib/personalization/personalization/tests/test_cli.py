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
