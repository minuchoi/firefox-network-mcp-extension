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

    async def _run_mcp() -> None:
        async with stdio_server() as (read_stream, write_stream):
            await mcp.run(
                read_stream,
                write_stream,
                mcp.create_initialization_options(),
            )

    logger.info("Starting MCP stdio server")
    mcp_task = asyncio.create_task(_run_mcp(), name="mcp")
    ws_task = asyncio.create_task(
        start_ws_server(manager, shutdown_event=shutdown_event), name="ws"
    )

    # Ensure shutdown on SIGTERM/SIGINT. Setting the event alone is not enough:
    # mcp.run() blocks on stdin, so the main coroutine must be interrupted too.
    loop = asyncio.get_running_loop()

    def _handle_signal() -> None:
        shutdown_event.set()
        mcp_task.cancel()

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, _handle_signal)
        except NotImplementedError:
            pass  # signal handlers are unsupported on some platforms

    # Run until either task finishes. If the WS server dies first (e.g. port
    # 7865 already bound), surface it instead of silently running MCP with a
    # dead bridge and re-raising the OSError only at shutdown.
    done, _pending = await asyncio.wait(
        {mcp_task, ws_task}, return_when=asyncio.FIRST_COMPLETED
    )
    if ws_task in done and not ws_task.cancelled() and ws_task.exception():
        logger.error("WebSocket server failed: %s", ws_task.exception())

    # Graceful shutdown of whatever is still running
    shutdown_event.set()
    mcp_task.cancel()
    await asyncio.gather(mcp_task, ws_task, return_exceptions=True)


if __name__ == "__main__":
    main()
