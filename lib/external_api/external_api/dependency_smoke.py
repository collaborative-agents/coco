"""Exercise real SDK tool-call paths against a loopback-only API, without keys."""

from __future__ import annotations

import asyncio
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import version
from threading import Thread


def main() -> None:
    # Avoid downloading pricing metadata during this offline model check.
    os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
    import litellm
    from mcp.server.fastmcp import FastMCP
    from mcp.types import CallToolResult, TextContent

    # Exercise the MCP API Coco actually uses, rather than requiring MCP 2 types.
    FastMCP("dependency-smoke")
    CallToolResult(content=[TextContent(type="text", text="OK")])
    print(f"Dependency smoke: litellm={version('litellm')}, mcp={version('mcp')}")
    requests: list[dict] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(request)
            response = {
                "id": "smoke-completion",
                "object": "chat.completion",
                "created": 1,
                "model": "gpt-4o-mini",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "tool_calls",
                        "message": {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": "smoke-tool",
                                    "type": "function",
                                    "function": {
                                        "name": "get_context",
                                        "arguments": "{}",
                                    },
                                }
                            ],
                        },
                    }
                ],
                "usage": {
                    "prompt_tokens": 1,
                    "completion_tokens": 1,
                    "total_tokens": 2,
                },
            }
            body = json.dumps(response).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        kwargs = {
            "model": "openai/gpt-4o-mini",
            "api_base": f"http://127.0.0.1:{server.server_port}/v1",
            "api_key": "local-smoke-only",
            "messages": [{"role": "user", "content": "Get context."}],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "get_context",
                        "description": "Get context",
                        "parameters": {"type": "object", "properties": {}},
                    },
                }
            ],
            "timeout": 15,
            "num_retries": 0,
        }
        # Do not mock completion or use mock_response: those bypass SDK imports.
        sync_result = litellm.completion(**kwargs)

        async def call_async():
            return await litellm.acompletion(**kwargs)

        async_result = asyncio.run(call_async())
        for result in (sync_result, async_result):
            call = result.choices[0].message.tool_calls[0]
            if (
                call.function.name != "get_context"
                or json.loads(call.function.arguments) != {}
            ):
                raise RuntimeError("SDK did not preserve the tool call")
        if len(requests) != 2 or any(
            r.get("tools") != kwargs["tools"] for r in requests
        ):
            raise RuntimeError("SDK did not send both tool requests to the local API")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    print("Dependency smoke passed: synchronous and asynchronous function-tool calls.")


if __name__ == "__main__":
    main()
