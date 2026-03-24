"""Entry point: runs MCP stdio server and WebSocket server concurrently."""

from __future__ import annotations

import asyncio
import logging
import signal
import sys

from mcp.server import Server
from mcp.server.stdio import stdio_server

from .request_store import RequestStore, WsFrameStore
from .tools import register_tools
from .ws_bridge import ConnectionManager, start_ws_server

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger(__name__)


def main() -> None:
    """Sync entry point for the console script."""
    asyncio.run(_async_main())


async def _async_main() -> None:
    request_store = RequestStore()
    ws_frame_store = WsFrameStore()
    manager = ConnectionManager(request_store, ws_frame_store)

    mcp = Server("browser-bridge")
    register_tools(mcp, request_store, ws_frame_store, manager)

    shutdown_event = asyncio.Event()

    # Ensure clean shutdown on SIGTERM/SIGINT so the port is released
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, shutdown_event.set)

    # Start WebSocket server as a background task
    ws_task = asyncio.create_task(
        start_ws_server(manager, shutdown_event=shutdown_event)
    )

    logger.info("Starting MCP stdio server")
    async with stdio_server() as (read_stream, write_stream):
        await mcp.run(
            read_stream,
            write_stream,
            mcp.create_initialization_options(),
        )

    # Signal the WS server to shut down gracefully, then cancel as fallback
    shutdown_event.set()
    try:
        await asyncio.wait_for(ws_task, timeout=5.0)
    except asyncio.TimeoutError:
        logger.warning("WebSocket server did not shut down cleanly, cancelling")
        ws_task.cancel()
        try:
            await ws_task
        except asyncio.CancelledError:
            pass
    except asyncio.CancelledError:
        pass


if __name__ == "__main__":
    main()
