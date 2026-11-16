from types import SimpleNamespace

from personalization.utils.llm_io import parse_json_object, response_text
from personalization.utils.media import image_data_url, sample_frames


def test_model_response_helpers_parse_json_and_text():
    assert parse_json_object('before ```json\n{"ok": true}\n``` after') == {"ok": True}
    assert response_text(SimpleNamespace(content="plain")) == "plain"
    assert (
        response_text(SimpleNamespace(content=[SimpleNamespace(text="structured")]))
        == "structured"
    )


def test_media_helpers_sample_and_encode(tmp_path):
    assert sample_frames(["a", "b", "c"], 1) == ["a"]
    assert sample_frames(["a", "b", "c"], 2) == ["a", "c"]

    image = tmp_path / "frame.png"
    image.write_bytes(b"png")
    assert image_data_url(image) == "data:image/png;base64,cG5n"
