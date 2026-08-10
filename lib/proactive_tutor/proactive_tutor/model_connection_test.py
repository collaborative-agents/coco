"""One-shot text or vision smoke test used by desktop model setup."""

from __future__ import annotations

import argparse
import base64
import json
import struct
import zlib

from external_api.llm import chat_completion


def _png_data_url() -> str:
    """Return a tiny valid 32x32 red PNG without filesystem dependencies."""

    width = height = 32
    raw = b"".join(b"\x00" + b"\xff\x00\x00" * width for _ in range(height))

    def chunk(kind: bytes, data: bytes) -> bytes:
        payload = kind + data
        return (
            struct.pack(">I", len(data))
            + payload
            + struct.pack(">I", zlib.crc32(payload))
        )

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )
    return f"data:image/png;base64,{base64.b64encode(png).decode('ascii')}"


def test_connection(model: str, include_image: bool) -> str:
    content: list[dict[str, object]] = [{"type": "text", "text": "Reply only OK."}]
    if include_image:
        content.append({"type": "image_url", "image_url": {"url": _png_data_url()}})
    kwargs: dict[str, object] = {}
    if (
        model.removeprefix("hosted_vllm/")
        .lower()
        .startswith("thinkingmachines/inkling")
    ):
        kwargs["reasoning_effort"] = "none"
    response, _ = chat_completion(
        [{"role": "user", "content": content}],
        model=model,
        max_tokens=8,
        temperature=0,
        operation="connection_test",
        **kwargs,
    )
    return response.content[0].text  # type: ignore[union-attr]


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--include-image", action="store_true")
    args = parser.parse_args(argv)
    try:
        reply = test_connection(args.model, args.include_image)
        print(json.dumps({"success": True, "reply": reply[:80]}))
    except Exception as exc:
        print(json.dumps({"success": False, "error": str(exc)}))
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
