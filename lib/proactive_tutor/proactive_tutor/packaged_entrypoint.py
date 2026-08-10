"""Lightweight dispatcher for the frozen tutor service executable."""

import sys


def main() -> None:
    """Run either the MCP stdio server or the normal tutor HTTP server."""
    if sys.argv[1:] == ["--memory-mcp"]:
        # Keep this branch free of tutor imports. Tutor logging uses stdout,
        # which would corrupt the memory server's JSON-RPC stdio transport.
        from memory_mcp.server import main as memory_mcp_main

        memory_mcp_main()
        return

    if sys.argv[1:2] == ["--test-model-connection"]:
        from proactive_tutor.model_connection_test import main as test_model_main

        test_model_main(sys.argv[2:])
        return

    import chz
    from proactive_tutor.tutor_server import main as tutor_main

    chz.entrypoint(tutor_main, allow_hyphens=True)


if __name__ == "__main__":
    main()
