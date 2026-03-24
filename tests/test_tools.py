"""Tests for the MCP tool dispatch layer."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock

import pytest
from mcp.server import Server
from mcp.types import CallToolRequest, CallToolRequestParams

from mcp_server.request_store import RequestStore, WsFrameStore
from mcp_server.tools import _error_response, _require_param, register_tools
from mcp_server.ws_bridge import ConnectionManager

from tests.conftest import make_request, make_ws_frame


# ─── Fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture
def mcp_env(request_store, ws_frame_store):
    manager = ConnectionManager(request_store, ws_frame_store)
    manager.send_request = AsyncMock()
    mcp = Server("test")
    register_tools(mcp, request_store, ws_frame_store, manager)
    return mcp, request_store, ws_frame_store, manager


async def _call(mcp: Server, name: str, arguments: dict | None = None) -> dict | str:
    handler = mcp.request_handlers[CallToolRequest]
    req = CallToolRequest(
        method="tools/call",
        params=CallToolRequestParams(name=name, arguments=arguments or {}),
    )
    result = await handler(req)
    text = result.root.content[0].text
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


# ─── Module-level helpers ────────────────────────────────────────────────────


def test_error_response_structure():
    resp = _error_response("some_code", "something went wrong")
    assert resp == {"error": {"code": "some_code", "message": "something went wrong"}}


def test_require_param_present():
    assert _require_param({"key": "val"}, "key") == "val"


def test_require_param_missing():
    with pytest.raises(ValueError, match="Missing required parameter: key"):
        _require_param({}, "key")


# ─── get_network_requests ────────────────────────────────────────────────────


async def test_get_network_requests_empty(mcp_env):
    mcp, *_ = mcp_env
    result = await _call(mcp, "get_network_requests")
    assert result["total_captured"] == 0
    assert result["returned"] == 0
    assert result["requests"] == []


async def test_get_network_requests_with_data(mcp_env):
    mcp, store, *_ = mcp_env
    store.add(make_request(url="https://example.com/a", method="GET"))
    store.add(make_request(url="https://example.com/b", method="POST"))
    result = await _call(mcp, "get_network_requests")
    assert result["total_captured"] == 2
    assert result["returned"] == 2
    urls = [r["url"] for r in result["requests"]]
    assert "https://example.com/a" in urls
    assert "https://example.com/b" in urls


async def test_get_network_requests_limit_clamped(mcp_env):
    mcp, store, *_ = mcp_env
    for i in range(5):
        store.add(make_request(url=f"https://example.com/{i}"))

    result_neg = await _call(mcp, "get_network_requests", {"limit": -1})
    assert result_neg["returned"] == 1  # clamped to min 1

    result_huge = await _call(mcp, "get_network_requests", {"limit": 99999})
    assert result_huge["returned"] == 5  # clamped to 500, but only 5 exist


# ─── get_request_details ─────────────────────────────────────────────────────


async def test_get_request_details_found(mcp_env):
    mcp, store, *_ = mcp_env
    store.add(make_request(request_id="abc123", url="https://example.com/detail"))
    result = await _call(mcp, "get_request_details", {"request_id": "abc123"})
    assert result["request_id"] == "abc123"
    assert result["url"] == "https://example.com/detail"
    assert "request_headers" in result


async def test_get_request_details_not_found(mcp_env):
    mcp, *_ = mcp_env
    result = await _call(mcp, "get_request_details", {"request_id": "nonexistent"})
    assert result["error"]["code"] == "not_found"


# ─── search_network ─────────────────────────────────────────────────────────


async def test_search_network(mcp_env):
    mcp, store, *_ = mcp_env
    store.add(make_request(url="https://example.com/api/users"))
    store.add(make_request(url="https://example.com/api/posts"))
    result = await _call(mcp, "search_network", {"query": "users"})
    assert result["results"] == 1
    assert result["requests"][0]["url"] == "https://example.com/api/users"


# ─── get_page_info ───────────────────────────────────────────────────────────


async def test_get_page_info_delegates(mcp_env):
    mcp, _, _, manager = mcp_env
    manager.send_request.return_value = {
        "url": "https://example.com",
        "title": "Example",
        "tab_id": 42,
    }
    result = await _call(mcp, "get_page_info")
    assert result == {"url": "https://example.com", "title": "Example", "tab_id": 42}
    manager.send_request.assert_awaited_once_with("get_page_info")


# ─── query_dom ───────────────────────────────────────────────────────────────


async def test_query_dom_extension_error(mcp_env):
    mcp, _, _, manager = mcp_env
    manager.send_request.return_value = {"error": "No active tab"}
    result = await _call(mcp, "query_dom", {"selector": "div"})
    assert result["error"]["code"] == "extension_error"
    assert result["error"]["message"] == "No active tab"


# ─── start_ws_capture ────────────────────────────────────────────────────────


async def test_start_ws_capture_registers_after_success(mcp_env):
    mcp, _, ws_store, manager = mcp_env
    manager.send_request.return_value = {"matched_connections": 3}
    result = await _call(mcp, "start_ws_capture", {"url_pattern": "wss://test.*"})
    assert result["status"] == "capturing"
    assert result["matched_connections"] == 3
    assert "wss://test.*" in ws_store.active_captures


async def test_start_ws_capture_no_register_on_error(mcp_env):
    mcp, _, ws_store, manager = mcp_env
    manager.send_request.return_value = {"error": "injection failed"}
    result = await _call(mcp, "start_ws_capture", {"url_pattern": "wss://fail.*"})
    assert result["error"]["code"] == "extension_error"
    assert "wss://fail.*" not in ws_store.active_captures


# ─── stop_ws_capture ─────────────────────────────────────────────────────────


async def test_stop_ws_capture(mcp_env):
    mcp, _, ws_store, manager = mcp_env
    ws_store.start_capture("wss://test.*")
    manager.send_request.return_value = {}
    result = await _call(mcp, "stop_ws_capture", {"url_pattern": "wss://test.*"})
    assert result["status"] == "stopped"
    assert result["was_active"] is True
    assert "wss://test.*" not in ws_store.active_captures


# ─── get_ws_frames ───────────────────────────────────────────────────────────


async def test_get_ws_frames(mcp_env):
    mcp, _, ws_store, _ = mcp_env
    ws_store.start_capture("wss://example.com/ws")
    ws_store.add(make_ws_frame(connection_url="wss://example.com/ws", data="frame1"))
    ws_store.add(make_ws_frame(connection_url="wss://example.com/ws", data="frame2"))
    result = await _call(mcp, "get_ws_frames", {"url_pattern": "wss://example.com/ws"})
    assert result["returned"] == 2
    assert "wss://example.com/ws" in result["active_captures"]


# ─── Unknown tool ────────────────────────────────────────────────────────────


async def test_unknown_tool_returns_error(mcp_env):
    mcp, *_ = mcp_env
    result = await _call(mcp, "totally_bogus_tool")
    assert result["error"]["code"] == "unknown_tool"


# ─── Error handling ──────────────────────────────────────────────────────────


async def test_connection_error_handling(mcp_env):
    mcp, _, _, manager = mcp_env
    manager.send_request.side_effect = ConnectionError("No extension connected")
    result = await _call(mcp, "get_page_info")
    assert result["error"]["code"] == "connection_error"


async def test_timeout_error_handling(mcp_env):
    mcp, _, _, manager = mcp_env
    manager.send_request.side_effect = TimeoutError("timed out")
    result = await _call(mcp, "get_page_info")
    assert result["error"]["code"] == "timeout"


# ─── Missing required params ────────────────────────────────────────────────
# The MCP framework validates required params from the JSON schema before
# our dispatch code runs, returning a plain-text error (not JSON).


async def test_query_dom_missing_selector(mcp_env):
    mcp, *_ = mcp_env
    result = await _call(mcp, "query_dom", {})
    assert isinstance(result, str)
    assert "selector" in result.lower() or "required" in result.lower()


async def test_search_network_missing_query(mcp_env):
    mcp, *_ = mcp_env
    result = await _call(mcp, "search_network", {})
    assert isinstance(result, str)
    assert "query" in result.lower() or "required" in result.lower()


async def test_get_request_details_missing_id(mcp_env):
    mcp, *_ = mcp_env
    result = await _call(mcp, "get_request_details", {})
    assert isinstance(result, str)
    assert "request_id" in result.lower() or "required" in result.lower()


async def test_start_ws_capture_missing_pattern(mcp_env):
    mcp, *_ = mcp_env
    result = await _call(mcp, "start_ws_capture", {})
    assert isinstance(result, str)
    assert "url_pattern" in result.lower() or "required" in result.lower()


async def test_stop_ws_capture_missing_pattern(mcp_env):
    mcp, *_ = mcp_env
    result = await _call(mcp, "stop_ws_capture", {})
    assert isinstance(result, str)
    assert "url_pattern" in result.lower() or "required" in result.lower()


# ─── Limit clamping edge case ───────────────────────────────────────────────


async def test_get_network_requests_limit_zero_clamped(mcp_env):
    mcp, store, *_ = mcp_env
    store.add(make_request())
    result = await _call(mcp, "get_network_requests", {"limit": 0})
    assert result["returned"] == 1  # clamped to min 1
