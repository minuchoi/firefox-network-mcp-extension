from __future__ import annotations

from mcp_server.request_store import (
    MAX_REGEX_CACHE_SIZE,
    MAX_REGEX_PATTERN_LENGTH,
    _REGEX_CACHE,
    _safe_regex_search,
)


class TestSafeRegexSearch:
    def test_basic_match(self):
        assert _safe_regex_search(r"foo", "foobar") is True

    def test_no_match(self):
        assert _safe_regex_search(r"xyz", "foobar") is False

    def test_case_insensitive(self):
        assert _safe_regex_search(r"foo", "FOOBAR") is True

    def test_invalid_regex(self):
        assert _safe_regex_search(r"[invalid", "text") is False

    def test_invalid_regex_cached(self):
        _safe_regex_search(r"[bad", "text")
        assert r"[bad" in _REGEX_CACHE
        assert _REGEX_CACHE[r"[bad"] is None
        assert _safe_regex_search(r"[bad", "text") is False

    def test_pattern_too_long(self):
        pattern = "a" * (MAX_REGEX_PATTERN_LENGTH + 1)
        assert _safe_regex_search(pattern, "aaa") is False

    def test_cache_eviction(self):
        for i in range(MAX_REGEX_CACHE_SIZE + 1):
            _safe_regex_search(f"pattern{i}", "text")
        assert len(_REGEX_CACHE) == MAX_REGEX_CACHE_SIZE
        assert "pattern0" not in _REGEX_CACHE
        assert f"pattern{MAX_REGEX_CACHE_SIZE}" in _REGEX_CACHE

    def test_recursion_error(self):
        assert _safe_regex_search(r"(a*)*b", "a" * 25) is False

    def test_lru_eviction_keeps_recently_used(self):
        """Recently accessed patterns survive eviction (LRU, not FIFO)."""
        # Fill cache to capacity
        for i in range(MAX_REGEX_CACHE_SIZE):
            _safe_regex_search(f"pattern{i}", "text")
        # Re-access pattern0 so it becomes recently used
        _safe_regex_search("pattern0", "text")
        # Add one more to trigger eviction
        _safe_regex_search("new_pattern", "text")
        # pattern0 should survive (recently used), pattern1 should be evicted (oldest unused)
        assert "pattern0" in _REGEX_CACHE
        assert "pattern1" not in _REGEX_CACHE
        assert "new_pattern" in _REGEX_CACHE
