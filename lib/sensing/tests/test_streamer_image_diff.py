from PIL import Image
from sensing.streamer import MAX_DIFF, calc_diff_scores


def _transition(before: str | None, after: str | None) -> list[dict]:
    return [
        {"state_str": {"after": before}},
        {"state_str": {"before": after}},
    ]


def test_calc_diff_scores_returns_rgb_mean_squared_error(tmp_path) -> None:
    before = tmp_path / "before.png"
    after = tmp_path / "after.png"
    Image.new("RGB", (2, 2), color=(0, 0, 0)).save(before)
    Image.new("RGB", (2, 2), color=(10, 10, 10)).save(after)

    scores = calc_diff_scores(_transition(str(before), str(after)))

    assert scores == [300.0]


def test_calc_diff_scores_normalizes_image_modes(tmp_path) -> None:
    grayscale = tmp_path / "grayscale.png"
    rgb = tmp_path / "rgb.png"
    Image.new("L", (2, 2), color=10).save(grayscale)
    Image.new("RGB", (2, 2), color=(10, 10, 10)).save(rgb)

    scores = calc_diff_scores(_transition(str(grayscale), str(rgb)))

    assert scores == [0.0]


def test_calc_diff_scores_handles_missing_invalid_and_mismatched_images(
    tmp_path,
) -> None:
    valid = tmp_path / "valid.png"
    invalid = tmp_path / "invalid.png"
    different_size = tmp_path / "different-size.png"
    Image.new("RGB", (2, 2)).save(valid)
    invalid.write_text("not an image")
    Image.new("RGB", (3, 2)).save(different_size)

    assert calc_diff_scores(_transition(None, str(valid))) == [MAX_DIFF]
    assert calc_diff_scores(_transition(str(invalid), str(valid))) == [MAX_DIFF]
    assert calc_diff_scores(_transition(str(valid), str(different_size))) == [MAX_DIFF]
