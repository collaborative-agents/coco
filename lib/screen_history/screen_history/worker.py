"""Index Coco's sensing screenshots with StreamEmbed in a separate worker process.

Paper: Real-time Indexing from Pixels for Screenshot Retrieval
https://arxiv.org/abs/2611.18516
Source: https://github.com/StarTrail-org/StreamEmbed
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import logging
import os
import queue
import sys
import threading
from pathlib import Path

import streamembed as se
from PIL import Image

from screen_history.status import write_status

logger = logging.getLogger("coco.screen_history")


def read_groups(
    stream,
    pending: queue.Queue,
    ended: threading.Event,
    queries: queue.Queue | None = None,
    respond=None,
) -> None:
    """Drain the pipe independently of model startup; retain only recent groups."""
    try:
        for line in stream:
            if queries is not None and line.lstrip().startswith(b"{"):
                try:
                    request = json.loads(line)
                    if request.get("type") != "search":
                        raise ValueError("Unknown worker request")
                    queries.put_nowait(request)
                except queue.Full:
                    respond(
                        {
                            "id": request.get("id"),
                            "error": "Screen history search is busy; retry shortly",
                        }
                    )
                except (ValueError, TypeError):
                    logger.exception("Discarding invalid screen history request")
                continue
            if pending.full():
                try:
                    pending.get_nowait()
                except queue.Empty:
                    pass
            pending.put_nowait(line)
    finally:
        ended.set()


def frame_iterator(pending: queue.Queue, ended: threading.Event, index_dir: Path):
    mapping_path = index_dir / "display-tags.json"
    tags = json.loads(mapping_path.read_text()) if mapping_path.exists() else {}
    while not ended.is_set():
        try:
            line = pending.get(timeout=0.5)
        except queue.Empty:
            # A heartbeat allows StreamEmbed to unload during long idle periods
            # and avoids its stalled-frame-source watchdog.
            yield None
            continue
        try:
            frames = []
            for item in json.loads(line):
                monitor_id = str(item["monitor_id"])
                # StreamEmbed's index reconstructs display identity from a one-
                # or two-digit filename suffix. Preserve that convention.
                if monitor_id not in tags:
                    tag = str(len(tags) + 1)
                    if int(tag) > 99:
                        raise ValueError(
                            "Screen history supports 99 distinct display identities"
                        )
                    tags[monitor_id] = tag
                    staging = mapping_path.with_suffix(".tmp")
                    staging.write_text(json.dumps(tags))
                    staging.chmod(0o600)
                    staging.replace(mapping_path)
                tag = tags[monitor_id]
                with Image.open(io.BytesIO(base64.b64decode(item["png"]))) as image:
                    frames.append(
                        (
                            image.convert("RGB"),
                            float(item["timestamp"]),
                            monitor_id,
                            None,
                            tag,
                        )
                    )
            if frames:
                yield frames
        except Exception:
            logger.exception("Discarding invalid screen history capture group")


def search_screens(query: str, top_k: int = 3, since=None, until=None) -> dict:
    if not isinstance(query, str) or not query.strip():
        raise ValueError("query must be a nonempty string")
    if isinstance(top_k, bool) or not isinstance(top_k, int) or not 1 <= top_k <= 5:
        raise ValueError("top_k must be between 1 and 5")
    results = se.query_index(query.strip(), top_k=top_k, since=since, until=until)
    matches, images = [], []
    for result in results:
        try:
            with Image.open(result.path) as source:
                image = source.convert("RGB")
                if image.width > 1280:
                    image = image.resize(
                        (1280, max(1, image.height * 1280 // image.width)),
                        Image.Resampling.LANCZOS,
                    )
                with io.BytesIO() as buffer:
                    image.save(buffer, "JPEG", quality=80)
                    images.append(
                        {
                            "mimeType": "image/jpeg",
                            "data": base64.b64encode(buffer.getvalue()).decode("ascii"),
                        }
                    )
            matches.append(result.to_dict())
        except (OSError, ValueError):
            # Retention can delete a hit after retrieval. Return only matches
            # whose image evidence is still available, in the same order.
            logger.warning(
                "Screen history image is no longer available: %s", result.path
            )
    return {
        "query": query.strip(),
        "matches": matches,
        "images": images,
        "count": len(matches),
        "evidence": "Historical screenshots, ordered by similarity. Scores are not confidence probabilities. Images correspond to matches in order; inspect them before answering.",
    }


def serve_queries(queries: queue.Queue, ended: threading.Event, respond) -> None:
    while not ended.is_set():
        try:
            request = queries.get(timeout=0.5)
        except queue.Empty:
            continue
        try:
            result = search_screens(**request["arguments"])
        except Exception as exc:
            result = {"error": str(exc)}
        respond({"id": request["id"], "result": result})


def run(index_dir: Path, stream, output=None) -> None:
    # Do not inherit the standalone capture application's settings by default.
    os.environ.setdefault("STREAMEMBED_CONFIG", str(index_dir / "streamembed.toml"))

    index_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    index_dir.chmod(0o700)
    pending: queue.Queue = queue.Queue(maxsize=1)
    queries: queue.Queue = queue.Queue(maxsize=4)
    ended = threading.Event()
    output_lock = threading.Lock()

    def respond(response):
        if output is not None:
            with output_lock:
                output.write((json.dumps(response) + "\n").encode())
                output.flush()

    reader = threading.Thread(
        target=read_groups, args=(stream, pending, ended, queries, respond), daemon=True
    )
    capture = None
    try:
        write_status(index_dir, "loading", {})
        reader.start()
        se.configure(
            index_dir=index_dir,
            capture_dir=index_dir / "captures",
            width=1280,
            capture_width=1280,
        )
        if ended.is_set():
            write_status(index_dir, "stopped", {})
            return
        capture = se.build_index_from_now(
            frames=frame_iterator(pending, ended, index_dir),
            interval=0,
        )
        # query_index uses the encoder already loaded above. Serial queries
        # share that model with indexing, which yields to waiting questions.
        threading.Thread(
            target=serve_queries, args=(queries, ended, respond), daemon=True
        ).start()
        while capture.running and not ended.is_set():
            write_status(index_dir, "indexing", capture.stats)
            ended.wait(1)
        if capture.running:
            capture.stop()
        if not ended.is_set():
            raise RuntimeError("StreamEmbed ingestion stopped unexpectedly")
        write_status(index_dir, "stopped", capture.stats)
    except BaseException as exc:
        write_status(index_dir, "error", capture.stats if capture else {}, str(exc))
        raise
    finally:
        ended.set()
        if capture is not None and capture.running:
            capture.stop()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index-dir", required=True, type=Path)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    run(args.index_dir, sys.stdin.buffer, sys.stdout.buffer)


if __name__ == "__main__":
    main()
