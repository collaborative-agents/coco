"""Validation helpers for microphone input accepted by the tutor service."""

import base64
import io
import math
import struct
import wave

MAX_AUDIO_BYTES = 10 * 1024 * 1024
MIN_ACTIVE_WINDOW_RMS = 0.008
ACTIVE_WINDOW_SECONDS = 0.02
MIN_CONSECUTIVE_ACTIVE_WINDOWS = 4


def _contains_speech_like_signal(raw: bytes) -> bool:
    """Return whether a PCM WAV contains sustained non-silent audio.

    This is intentionally a conservative signal gate rather than speech
    recognition. The renderer performs adaptive voice activity detection; this
    server-side check prevents older or malformed clients from sending silence
    to an LLM, where it can otherwise produce a plausible fake transcript.
    """
    try:
        with wave.open(io.BytesIO(raw), "rb") as wav:
            channels = wav.getnchannels()
            sample_width = wav.getsampwidth()
            sample_rate = wav.getframerate()
            frame_count = wav.getnframes()
            compression = wav.getcomptype()
            pcm = wav.readframes(frame_count)
    except (EOFError, wave.Error) as exc:
        raise ValueError("audio_data must contain a readable WAV recording") from exc

    if (
        channels < 1
        or sample_width != 2
        or sample_rate < 8_000
        or sample_rate > 96_000
        or compression != "NONE"
        or frame_count == 0
    ):
        raise ValueError("audio_data must contain uncompressed 16-bit PCM WAV audio")

    samples_per_window = max(
        channels,
        round(sample_rate * ACTIVE_WINDOW_SECONDS) * channels,
    )
    active_run = 0
    sample_count = len(pcm) // 2
    for start in range(0, sample_count, samples_per_window):
        end = min(sample_count, start + samples_per_window)
        count = end - start
        if count <= 0:
            continue
        values = struct.unpack_from(f"<{count}h", pcm, start * 2)
        rms = math.sqrt(sum(value * value for value in values) / count) / 32768.0
        if rms >= MIN_ACTIVE_WINDOW_RMS:
            active_run += 1
            if active_run >= MIN_CONSECUTIVE_ACTIVE_WINDOWS:
                return True
        else:
            active_run = 0
    return False


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
    if not _contains_speech_like_signal(raw):
        raise ValueError("No speech was detected in the voice recording")
