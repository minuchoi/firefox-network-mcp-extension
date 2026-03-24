"""Light integration tests for the MCP server and WebSocket server."""

from __future__ import annotations

import asyncio

import pytest
import websockets
from mcp.server import Server
from mcp.types import ListToolsRequest

from mcp_server.request_store import RequestStore, WsFrameStore
from mcp_server.tools import register_tools
from mcp_server.ws_bridge import ConnectionManager, start_ws_server


EXPECTED_TOOL_NAMES = {
    "get_network_requests",
    "get_request_details",
    "search_network",
    "get_page_info",
    "query_dom",
    "get_page_html",
    "get_console_logs",
    "start_ws_capture",
    "stop_ws_capture",
    "get_ws_frames",
}


@pytest.fixture
def mcp_server(request_store, ws_frame_store):
    manager = ConnectionManager(request_store, ws_frame_store)
    mcp = Server("test-integration")
    register_tools(mcp, request_store, ws_frame_store, manager)
    return mcp


async def test_list_tools_returns_all_names(mcp_server):
    handler = mcp_server.request_handlers[ListToolsRequest]
    result = await handler(ListToolsRequest(method="tools/list"))
    names = {t.name for t in result.root.tools}
    assert names == EXPECTED_TOOL_NAMES


async def test_ws_server_shutdown(request_store, ws_frame_store):
    manager = ConnectionManager(request_store, ws_frame_store)
    shutdown_event = asyncio.Event()
    shutdown_event.set()
    await asyncio.wait_for(
        start_ws_server(manager, port=0, shutdown_event=shutdown_event),
        timeout=2.0,
    )


async def test_ws_server_accepts_connection(request_store, ws_frame_store):
    manager = ConnectionManager(request_store, ws_frame_store)
    shutdown_event = asyncio.Event()
    task = asyncio.create_task(
        start_ws_server(manager, port=17866, shutdown_event=shutdown_event)
    )
    await asyncio.sleep(0.1)  # let the server bind

    try:
        async with websockets.connect("ws://127.0.0.1:17866") as ws:
            assert ws.protocol.state.name == "OPEN"
    finally:
        shutdown_event.set()
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
