from __future__ import annotations

import pytest

from tests.conftest import make_ws_frame


@pytest.fixture(autouse=True)
def _enable_capture(ws_frame_store):
    """Enable a catch-all capture pattern so frames are stored in tests."""
    ws_frame_store.start_capture(".*")
    yield
    ws_frame_store.stop_capture(".*")


class TestAddAndGet:
    def test_add_and_get_frames(self, ws_frame_store):
        ws_frame_store.add(make_ws_frame(data="msg1"))
        ws_frame_store.add(make_ws_frame(data="msg2"))
        results = ws_frame_store.get_frames()
        assert len(results) == 2

    def test_eviction(self, ws_frame_store):
        url = "wss://example.com/ws"
        for i in range(6):
            ws_frame_store.add(make_ws_frame(connection_url=url, data=f"msg{i}"))
        results = ws_frame_store.get_frames()
        assert len(results) == 5
        data_values = [r["data"] for r in results]
        assert "msg0" not in data_values
        assert "msg5" in data_values


class TestFilters:
    def test_filter_by_url_pattern(self, ws_frame_store):
        ws_frame_store.add(make_ws_frame(connection_url="wss://example.com/ws"))
        ws_frame_store.add(make_ws_frame(connection_url="wss://other.com/ws"))
        results = ws_frame_store.get_frames(url_pattern=r"example\.com")
        assert len(results) == 1

    def test_filter_by_direction(self, ws_frame_store):
        ws_frame_store.add(make_ws_frame(direction="sent"))
        ws_frame_store.add(make_ws_frame(direction="received"))
        results = ws_frame_store.get_frames(direction="sent")
        assert len(results) == 1
        assert results[0]["direction"] == "sent"

    def test_filter_by_tab_id(self, ws_frame_store):
        ws_frame_store.add(make_ws_frame(tab_id=1))
        ws_frame_store.add(make_ws_frame(tab_id=2))
        results = ws_frame_store.get_frames(tab_id=1)
        assert len(results) == 1
        assert results[0]["tab_id"] == 1

    def test_limit(self, ws_frame_store):
        for i in range(5):
            ws_frame_store.add(make_ws_frame(data=f"msg{i}"))
        results = ws_frame_store.get_frames(limit=2)
        assert len(results) == 2

    def test_newest_first(self, ws_frame_store):
        ws_frame_store.add(make_ws_frame(data="old", timestamp=1.0))
        ws_frame_store.add(make_ws_frame(data="new", timestamp=2.0))
        results = ws_frame_store.get_frames()
        assert results[0]["data"] == "new"
        assert results[1]["data"] == "old"

    def test_frames_not_stored_without_capture(self):
        """Frames are silently dropped when no active capture matches."""
        from mcp_server.request_store import WsFrameStore
        store = WsFrameStore(max_per_connection=5)
        store.add(make_ws_frame(data="dropped"))
        assert store.get_frames() == []

    def test_frames_not_stored_when_pattern_doesnt_match(self):
        """Frames are dropped when active capture pattern doesn't match URL."""
        from mcp_server.request_store import WsFrameStore
        store = WsFrameStore(max_per_connection=5)
        store.start_capture(r"other\.com")
        store.add(make_ws_frame(connection_url="wss://example.com/ws", data="dropped"))
        assert store.get_frames() == []


class TestCrossConnectionFiltering:
    def test_frames_from_multiple_connections(self, ws_frame_store):
        ws_frame_store.add(make_ws_frame(connection_url="wss://a.com/ws", data="a1"))
        ws_frame_store.add(make_ws_frame(connection_url="wss://b.com/ws", data="b1"))
        results = ws_frame_store.get_frames()
        urls = {r["connection_url"] for r in results}
        assert urls == {"wss://a.com/ws", "wss://b.com/ws"}
        assert len(results) == 2

    def test_url_pattern_filters_across_connections(self, ws_frame_store):
        ws_frame_store.add(make_ws_frame(connection_url="wss://a.com/ws", data="a1"))
        ws_frame_store.add(make_ws_frame(connection_url="wss://b.com/ws", data="b1"))
        results = ws_frame_store.get_frames(url_pattern=r"a\.com")
        assert len(results) == 1
        assert results[0]["connection_url"] == "wss://a.com/ws"


class TestCaptures:
    def test_start_capture(self, ws_frame_store):
        ws_frame_store.start_capture("wss://example.com/*")
        assert "wss://example.com/*" in ws_frame_store.active_captures

    def test_stop_capture_active(self, ws_frame_store):
        ws_frame_store.start_capture("wss://example.com/*")
        assert ws_frame_store.stop_capture("wss://example.com/*") is True
        assert "wss://example.com/*" not in ws_frame_store.active_captures

    def test_stop_capture_inactive(self, ws_frame_store):
        assert ws_frame_store.stop_capture("wss://unknown.com/*") is False

    def test_active_captures_is_copy(self, ws_frame_store):
        ws_frame_store.start_capture("wss://example.com/*")
        captures = ws_frame_store.active_captures
        captures.add("wss://injected.com/*")
        assert "wss://injected.com/*" not in ws_frame_store.active_captures
