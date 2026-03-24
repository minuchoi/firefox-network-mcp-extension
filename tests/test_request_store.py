from __future__ import annotations

from mcp_server.request_store import RequestStore

from tests.conftest import make_request


class TestAddAndGet:
    def test_add_and_get(self, request_store):
        req = make_request(request_id="r1")
        request_store.add(req)
        assert request_store.get("r1") is req

    def test_get_nonexistent(self, request_store):
        assert request_store.get("nope") is None

    def test_total_count(self, request_store):
        assert request_store.total_count == 0
        request_store.add(make_request())
        assert request_store.total_count == 1
        request_store.add(make_request())
        assert request_store.total_count == 2

    def test_duplicate_replaces(self, request_store):
        req1 = make_request(request_id="dup", url="https://old.com")
        req2 = make_request(request_id="dup", url="https://new.com")
        request_store.add(req1)
        request_store.add(req2)
        assert request_store.total_count == 1
        assert request_store.get("dup").url == "https://new.com"

    def test_duplicate_different_tab(self, request_store):
        req1 = make_request(request_id="dup", tab_id=1)
        req2 = make_request(request_id="dup", tab_id=2)
        request_store.add(req1)
        request_store.add(req2)
        assert request_store.total_count == 1
        assert request_store.get("dup").tab_id == 2


class TestEviction:
    def test_eviction_per_tab(self, request_store):
        ids = [f"r{i}" for i in range(6)]
        for rid in ids:
            request_store.add(make_request(request_id=rid, tab_id=1))
        assert request_store.total_count == 5
        assert request_store.get("r0") is None
        assert request_store.get("r5") is not None

    def test_tab_eviction(self, request_store):
        for tab in range(1, 5):
            request_store.add(make_request(request_id=f"t{tab}", tab_id=tab))
        assert request_store.get("t1") is None
        assert request_store.get("t2") is not None
        assert request_store.get("t4") is not None


class TestFilter:
    def test_filter_no_filters(self, request_store):
        for i in range(3):
            request_store.add(make_request(request_id=f"r{i}"))
        results = request_store.filter()
        assert len(results) == 3

    def test_filter_by_url_pattern(self, request_store):
        request_store.add(make_request(url="https://example.com/api/users"))
        request_store.add(make_request(url="https://other.com/data"))
        results = request_store.filter(url_pattern=r"example\.com")
        assert len(results) == 1
        assert "example.com" in results[0].url

    def test_filter_by_method(self, request_store):
        request_store.add(make_request(method="GET"))
        request_store.add(make_request(method="POST"))
        results = request_store.filter(method="get")
        assert len(results) == 1
        assert results[0].method == "GET"

    def test_filter_by_status_code(self, request_store):
        request_store.add(make_request(status_code=200))
        request_store.add(make_request(status_code=404))
        results = request_store.filter(status_code=404)
        assert len(results) == 1
        assert results[0].status_code == 404

    def test_filter_by_content_type(self, request_store):
        request_store.add(make_request(content_type="application/json"))
        request_store.add(make_request(content_type="text/html"))
        results = request_store.filter(content_type="json")
        assert len(results) == 1
        assert "json" in results[0].content_type

    def test_filter_by_tab_id(self, request_store):
        request_store.add(make_request(tab_id=1))
        request_store.add(make_request(tab_id=2))
        results = request_store.filter(tab_id=1)
        assert len(results) == 1
        assert results[0].tab_id == 1

    def test_filter_combined(self, request_store):
        request_store.add(make_request(method="GET", status_code=200, tab_id=1))
        request_store.add(make_request(method="POST", status_code=200, tab_id=1))
        request_store.add(make_request(method="GET", status_code=404, tab_id=1))
        results = request_store.filter(method="GET", status_code=200)
        assert len(results) == 1

    def test_filter_limit(self, request_store):
        for i in range(5):
            request_store.add(make_request())
        results = request_store.filter(limit=2)
        assert len(results) == 2

    def test_filter_newest_first(self, request_store):
        request_store.add(make_request(request_id="old", timestamp=1.0))
        request_store.add(make_request(request_id="new", timestamp=2.0))
        results = request_store.filter()
        assert results[0].request_id == "new"
        assert results[1].request_id == "old"


class TestFilterOrdering:
    def test_filter_newest_first_with_nonmonotonic_insertion(self, request_store):
        """Insertion order ≠ timestamp order; filter must use timestamps."""
        request_store.add(make_request(request_id="newer", timestamp=10.0))
        request_store.add(make_request(request_id="oldest", timestamp=1.0))
        request_store.add(make_request(request_id="middle", timestamp=5.0))
        results = request_store.filter()
        assert [r.request_id for r in results] == ["newer", "middle", "oldest"]

    def test_filter_ordering_after_duplicate_update(self, request_store):
        """Updating a duplicate must not corrupt ordering."""
        request_store.add(make_request(request_id="a", timestamp=1.0))
        request_store.add(make_request(request_id="b", timestamp=2.0))
        # Re-add 'a' with a newer timestamp
        request_store.add(make_request(request_id="a", timestamp=3.0))
        results = request_store.filter()
        assert results[0].request_id == "a"
        assert results[0].timestamp == 3.0
        assert results[1].request_id == "b"


class TestEvictionAtScale:
    def test_eviction_retains_exactly_max_per_tab(self):
        store = RequestStore(max_per_tab=500, max_tabs=20)
        for i in range(1000):
            store.add(make_request(request_id=f"r{i}", tab_id=1))
        assert store.total_count == 500
        # Oldest 500 evicted
        assert store.get("r0") is None
        assert store.get("r499") is None
        assert store.get("r500") is not None
        assert store.get("r999") is not None

    def test_eviction_retains_exactly_max_tabs(self):
        store = RequestStore(max_per_tab=5, max_tabs=20)
        for tab in range(50):
            store.add(make_request(request_id=f"t{tab}", tab_id=tab))
        # Only the last 20 tabs should remain
        assert store.get("t0") is None
        assert store.get("t29") is None
        assert store.get("t30") is not None
        assert store.get("t49") is not None


class TestSearch:
    def test_search_url(self, request_store):
        request_store.add(make_request(url="https://example.com/users"))
        request_store.add(make_request(url="https://other.com/data"))
        assert len(request_store.search("users")) == 1

    def test_search_request_headers(self, request_store):
        request_store.add(make_request(request_headers={"Authorization": "Bearer xyz"}))
        assert len(request_store.search("bearer")) == 1

    def test_search_response_headers(self, request_store):
        request_store.add(make_request(response_headers={"X-Custom": "foobar"}))
        assert len(request_store.search("foobar")) == 1

    def test_search_request_body(self, request_store):
        request_store.add(make_request(request_body='{"name": "alice"}'))
        assert len(request_store.search("alice")) == 1

    def test_search_response_body(self, request_store):
        request_store.add(make_request(response_body='{"result": "success"}'))
        assert len(request_store.search("success")) == 1

    def test_search_case_insensitive(self, request_store):
        request_store.add(make_request(url="https://Example.COM/API"))
        assert len(request_store.search("example.com/api")) == 1

    def test_search_with_tab_id(self, request_store):
        request_store.add(make_request(url="https://example.com", tab_id=1))
        request_store.add(make_request(url="https://example.com", tab_id=2))
        assert len(request_store.search("example", tab_id=1)) == 1

    def test_search_no_match(self, request_store):
        request_store.add(make_request())
        assert request_store.search("nonexistent") == []
