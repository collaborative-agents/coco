"""Native screen grabs isolated from sensing's event loop and thread pool.

stdin is newline JSON monitor geometry; stdout is a JSON header followed by raw
BGRA pixels. Only one grab runs at a time, on this process's main thread.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
from pathlib import Path


def serve(source, output, grab) -> None:
    for line in source:
        try:
            frame = grab(json.loads(line))
            pixels = frame.bgra
            header = {
                "width": frame.width,
                "height": frame.height,
                "bytes": len(pixels),
            }
        except Exception as exc:
            pixels = b""
            header = {"error": str(exc)}
        output.write((json.dumps(header) + "\n").encode())
        output.write(pixels)
        output.flush()


def grab_screencapture(monitor: dict):
    """macOS fallback for a blocked CGWindowListCreateImage/MSS session."""
    from mss.screenshot import ScreenShot
    from PIL import Image

    region = ",".join(
        str(int(monitor[key])) for key in ("left", "top", "width", "height")
    )
    with tempfile.TemporaryDirectory(prefix="coco-capture-") as directory:
        path = Path(directory) / "screen.png"
        subprocess.run(
            ["/usr/sbin/screencapture", "-x", "-R", region, str(path)],
            check=True,
            timeout=3,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        with Image.open(path) as image:
            image = image.convert("RGB")
            # screencapture returns Retina backing pixels. Match the logical
            # monitor dimensions used by MSS and sensing's input coordinates.
            size = (int(monitor["width"]), int(monitor["height"]))
            if image.size != size:
                image = image.resize(size, Image.Resampling.LANCZOS)
            return ScreenShot.from_size(bytearray(image.tobytes("raw", "BGRX")), *size)


def main(argv=None) -> None:
    import mss

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", choices=("mss", "screencapture"), default="mss")
    args = parser.parse_args(argv)
    pending: queue.Queue = queue.Queue(maxsize=1)

    def read_requests():
        for line in sys.stdin.buffer:
            pending.put(line)
        # Only volatile screenshot data lives here. EOF must end even a native
        # call stuck on another thread after the sensing parent has exited.
        os._exit(0)

    threading.Thread(target=read_requests, daemon=True).start()
    requests = iter(pending.get, None)
    if args.backend == "screencapture":
        serve(requests, sys.stdout.buffer, grab_screencapture)
    else:
        with mss.mss() as capture:
            serve(requests, sys.stdout.buffer, capture.grab)


if __name__ == "__main__":
    main()
