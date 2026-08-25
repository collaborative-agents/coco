import base64
import io
import math
import struct
import wave

import pytest
from proactive_tutor.audio_input import validate_wav_base64


def _wav_base64(samples: list[int], sample_rate: int = 16_000) -> str:
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(b"".join(struct.pack("<h", sample) for sample in samples))
    return base64.b64encode(output.getvalue()).decode("ascii")


def test_rejects_silent_wav_before_model_inference():
    with pytest.raises(ValueError, match="No speech was detected"):
        validate_wav_base64(_wav_base64([0] * 8_000))


def test_rejects_non_wav_data():
    with pytest.raises(ValueError, match="WAV"):
        validate_wav_base64(base64.b64encode(b"not audio").decode("ascii"))


def test_accepts_sustained_voice_like_signal():
    sample_rate = 16_000
    samples = [
        int(0.1 * 32767 * math.sin(2 * math.pi * 220 * i / sample_rate))
        for i in range(sample_rate // 5)
    ]
    validate_wav_base64(_wav_base64(samples))
