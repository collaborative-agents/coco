import base64

import pytest
from proactive_tutor.audio_input import validate_wav_base64


def test_validate_wav_base64_accepts_wav_header():
    header = b"RIFF" + (36).to_bytes(4, "little") + b"WAVE" + bytes(36)
    validate_wav_base64(base64.b64encode(header).decode("ascii"))


def test_validate_wav_base64_rejects_non_wav_data():
    with pytest.raises(ValueError, match="WAV"):
        validate_wav_base64(base64.b64encode(b"not audio").decode("ascii"))
