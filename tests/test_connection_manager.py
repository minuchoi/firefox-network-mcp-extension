"""Tests for ConnectionManager."""

from __future__ import annotations

import asyncio
import json
import time
from unittest.mock import AsyncMock, patch

import pytest


async def test_initially_not_connected(manager):
    assert manager.connected is False


async def test_register_sets_connected(manager, mock_ws):
    await manager.register(mock_ws)
    assert manager.connected is True


async def test_unregister_clears_connection(manager, mock_ws):
    await manager.register(mock_ws)
    await manager.unregister(mock_ws)
    assert manager.connected is False


async def test_unregister_wrong_ws_noop(manager, mock_ws):
    await manager.register(mock_ws)
    other_ws = AsyncMock()
    await manager.unregister(other_ws)
    assert manager.connected is True


async def test_register_replaces_existing(manager, mock_ws):
    first_ws = AsyncMock()
    first_ws.close = AsyncMock()
    await manager.register(first_ws)
    await manager.register(mock_ws)

    first_ws.close.assert_awaited_once()
    assert manager._connection is mock_ws


async def test_send_request_not_connected(manager):
    with pytest.raises(ConnectionError):
        await manager.send_request("some_action")


async def test_send_request_sends_json(manager, mock_ws):
    await manager.register(mock_ws)

    with patch("mcp_server.ws_bridge.REQUEST_TIMEOUT", 0.01):
        with pytest.raises(TimeoutError):
            await manager.send_request("test_action", {"key": "value"})

    sent_json = json.loads(mock_ws.send.call_args[0][0])
    assert sent_json["action"] == "test_action"
    assert sent_json["key"] == "value"
    assert "msg_id" in sent_json


async def test_send_request_receives_response(manager, mock_ws):
    await manager.register(mock_ws)
    task = asyncio.create_task(manager.send_request("test_action"))
    await asyncio.sleep(0)

    sent_json = json.loads(mock_ws.send.call_args[0][0])
    msg_id = sent_json["msg_id"]

    await manager.handle_message(json.dumps({"msg_id": msg_id, "result": "ok"}))

    result = await task
    assert result["result"] == "ok"


async def test_send_request_timeout(manager, mock_ws):
    await manager.register(mock_ws)
    with patch("mcp_server.ws_bridge.REQUEST_TIMEOUT", 0.01):
        with pytest.raises(TimeoutError):
            await manager.send_request("slow_action")


async def test_unregister_cancels_pending(manager, mock_ws):
    await manager.register(mock_ws)
    task = asyncio.create_task(manager.send_request("pending_action"))
    await asyncio.sleep(0)

    await manager.unregister(mock_ws)

    with pytest.raises(ConnectionError):
        await task


async def test_handle_message_invalid_json(manager):
    await manager.handle_message("not json at all{{{")


async def test_handle_message_hello(manager):
    await manager.handle_message(json.dumps({"type": "hello", "version": "1.0"}))


async def test_handle_message_network_event(manager, mock_ws, request_store):
    await manager.register(mock_ws)
    event = {
        "type": "network_event",
        "url": "https://example.com/api",
        "method": "POST",
        "tab_id": 1,
        "timestamp": time.time(),
        "status_code": 200,
        "request_id": "req-42",
    }
    await manager.handle_message(json.dumps(event))

    results = request_store.filter(tab_id=1)
    assert len(results) == 1
    assert results[0].url == "https://example.com/api"
    assert results[0].method == "POST"
    assert results[0].status_code == 200


async def test_handle_message_network_event_missing_url(manager, request_store):
    event = {
        "type": "network_event",
        "method": "GET",
        "tab_id": 1,
        "timestamp": time.time(),
    }
    await manager.handle_message(json.dumps(event))

    results = request_store.filter(tab_id=1)
    assert len(results) == 0


async def test_handle_message_network_event_malformed_tab_id(manager, request_store):
    event = {
        "type": "network_event",
        "url": "https://example.com/api",
        "method": "GET",
        "tab_id": "not_a_number",
        "timestamp": time.time(),
    }
    await manager.handle_message(json.dumps(event))

    assert request_store.total_count == 0


async def test_handle_message_ws_frame(manager, ws_frame_store):
    ws_frame_store.start_capture(".*")
    frame = {
        "type": "ws_frame",
        "connection_url": "wss://example.com/ws",
        "direction": "received",
        "data": "hello world",
        "timestamp": time.time(),
        "tab_id": 1,
    }
    await manager.handle_message(json.dumps(frame))

    frames = ws_frame_store.get_frames(url_pattern="wss://example.com/ws")
    assert len(frames) == 1
    assert frames[0]["data"] == "hello world"
    assert frames[0]["direction"] == "received"


async def test_handle_message_ws_frame_invalid_direction(manager, ws_frame_store):
    frame = {
        "type": "ws_frame",
        "connection_url": "wss://example.com/ws",
        "direction": "invalid",
        "data": "hello",
        "timestamp": time.time(),
        "tab_id": 1,
    }
    await manager.handle_message(json.dumps(frame))

    frames = ws_frame_store.get_frames(url_pattern="wss://example.com/ws")
    assert len(frames) == 0


async def test_handle_message_resolves_pending(manager, mock_ws):
    await manager.register(mock_ws)
    task = asyncio.create_task(manager.send_request("query"))
    await asyncio.sleep(0)

    sent_json = json.loads(mock_ws.send.call_args[0][0])
    msg_id = sent_json["msg_id"]

    await manager.handle_message(json.dumps({"msg_id": msg_id, "status": "done"}))

    result = await task
    assert result["status"] == "done"
    assert msg_id not in manager._pending


async def test_register_replaces_even_if_close_fails(manager, mock_ws):
    """New connection is registered even if closing the old one raises."""
    first_ws = AsyncMock()
    first_ws.close = AsyncMock(side_effect=Exception("close failed"))
    await manager.register(first_ws)
    await manager.register(mock_ws)

    first_ws.close.assert_awaited_once()
    assert manager._connection is mock_ws
    assert manager.connected is True


async def test_concurrent_send_requests_resolve_independently(manager, mock_ws):
    """Multiple concurrent requests each get the correct response."""
    await manager.register(mock_ws)

    task_a = asyncio.create_task(manager.send_request("action_a"))
    await asyncio.sleep(0)
    task_b = asyncio.create_task(manager.send_request("action_b"))
    await asyncio.sleep(0)

    # Extract both msg_ids from the two send calls
    calls = mock_ws.send.call_args_list
    msg_id_a = json.loads(calls[0][0][0])["msg_id"]
    msg_id_b = json.loads(calls[1][0][0])["msg_id"]

    # Respond out of order: B first, then A
    await manager.handle_message(json.dumps({"msg_id": msg_id_b, "result": "b"}))
    await manager.handle_message(json.dumps({"msg_id": msg_id_a, "result": "a"}))

    result_a = await task_a
    result_b = await task_b
    assert result_a["result"] == "a"
    assert result_b["result"] == "b"
    assert len(manager._pending) == 0


async def test_send_request_cleaned_up_on_send_failure(manager, mock_ws):
    """If ws.send() raises, the pending future is cleaned up."""
    await manager.register(mock_ws)
    mock_ws.send.side_effect = Exception("send failed")

    with pytest.raises(ConnectionError, match="Failed to send"):
        await manager.send_request("test_action")

    assert len(manager._pending) == 0
