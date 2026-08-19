"""Validation helpers for microphone input accepted by the tutor service."""

import base64

MAX_AUDIO_BYTES = 10 * 1024 * 1024


def validate_wav_base64(audio_data: str) -> None:
    """Reject malformed or unexpectedly large audio before model inference."""
    try:
        raw = base64.b64decode(audio_data, validate=True)
    except ValueError as exc:
        raise ValueError("audio_data must be valid base64") from exc
    if len(raw) > MAX_AUDIO_BYTES:
        raise ValueError("audio recording is too large")
    if len(raw) < 44 or raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        raise ValueError("audio_data must contain a WAV recording")
