"""Shared helpers for selecting and encoding local images."""

from __future__ import annotations

import base64
import mimetypes
from pathlib import Path
from typing import TypeVar

T = TypeVar("T")


def sample_frames(frames: list[T], max_images: int) -> list[T]:
    """Evenly subsample frames to at most ``max_images`` (0 = keep all)."""
    n = len(frames)
    if max_images <= 0 or n <= max_images:
        return frames
    if max_images == 1:
        return frames[:1]
    indexes = sorted({round(i * (n - 1) / (max_images - 1)) for i in range(max_images)})
    return [frames[index] for index in indexes]


def image_data_url(path: str | Path) -> str:
    """Encode a local image as a data URL."""
    image_path = Path(path).expanduser()
    mime = mimetypes.guess_type(image_path.name)[0] or "image/png"
    encoded = base64.b64encode(image_path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{encoded}"
