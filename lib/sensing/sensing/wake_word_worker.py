"""Local streaming wake-word worker used by the Coco desktop app.

The worker accepts 16 kHz mono signed-16-bit PCM on stdin and emits newline-
delimited JSON on stdout. Audio is decoded in memory and is never saved.
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path

import numpy as np
import sherpa_onnx

SAMPLE_RATE = 16_000
KEYWORDS = {
    "COCO": "▁CO CO",
    "HI COCO": "▁HI ▁CO CO",
    "HEY COCO": "▁HE Y ▁CO CO",
}
MODEL_SUFFIX = "epoch-12-avg-2-chunk-16-left-64.int8.onnx"


def _emit(message_type: str, **payload: object) -> None:
    print(json.dumps({"type": message_type, **payload}), flush=True)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Coco local wake-word worker")
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--threshold", type=float, default=0.25)
    parser.add_argument("--score", type=float, default=1.0)
    parser.add_argument("--threads", type=int, default=1)
    return parser.parse_args()


def _keyword_file(state_dir: Path) -> Path:
    state_dir.mkdir(parents=True, exist_ok=True)
    keyword_path = state_dir / "keywords.txt"
    contents = "\n".join(KEYWORDS.values()) + "\n"
    if not keyword_path.is_file() or keyword_path.read_text("utf-8") != contents:
        keyword_path.write_text(contents, encoding="utf-8")
    return keyword_path


def _spotter(args: argparse.Namespace) -> sherpa_onnx.KeywordSpotter:
    model_dir = args.model_dir.expanduser().resolve()
    files = {
        "tokens": model_dir / "tokens.txt",
        "encoder": model_dir / f"encoder-{MODEL_SUFFIX}",
        "decoder": model_dir / f"decoder-{MODEL_SUFFIX}",
        "joiner": model_dir / f"joiner-{MODEL_SUFFIX}",
    }
    missing = [str(path) for path in files.values() if not path.is_file()]
    if missing:
        raise FileNotFoundError(f"wake-word model files are missing: {missing}")

    return sherpa_onnx.KeywordSpotter(
        **{name: str(path) for name, path in files.items()},
        keywords_file=str(_keyword_file(args.state_dir)),
        num_threads=args.threads,
        provider="cpu",
        keywords_score=args.score,
        keywords_threshold=args.threshold,
    )


def run() -> int:
    args = _parse_args()
    spotter = _spotter(args)
    stream = spotter.create_stream()
    _emit("ready", keywords=list(KEYWORDS))

    # Renderer frames are normally much larger than this. A bounded read keeps
    # latency low while retaining natural stdin backpressure.
    carry = b""
    while raw_chunk := sys.stdin.buffer.read(4096):
        chunk = carry + raw_chunk
        if len(chunk) % 2:
            chunk, carry = chunk[:-1], chunk[-1:]
        else:
            carry = b""
        if not chunk:
            continue
        samples = np.frombuffer(chunk, dtype="<i2").astype(np.float32) / 32768.0
        stream.accept_waveform(SAMPLE_RATE, samples)
        while spotter.is_ready(stream):
            spotter.decode_stream(stream)
            result = spotter.get_result(stream)
            if result:
                normalized = " ".join(result.upper().split())
                _emit("detected", keyword=normalized)
                spotter.reset_stream(stream)
    return 0


def main() -> int:
    try:
        return run()
    except Exception as error:  # noqa: BLE001 - process boundary
        _emit("error", detail=str(error))
        traceback.print_exc(file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
