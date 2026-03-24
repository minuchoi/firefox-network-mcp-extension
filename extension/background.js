// Background script: WebSocket client, webRequest listeners, content script dispatch
// Firefox Manifest V2

const WS_URL = "ws://127.0.0.1:7865";
const MAX_BODY_SIZE = 1024 * 1024; // 1 MB
const SKIP_CONTENT_TYPES = /^(image|font)\//i;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const FILTER_FALLBACK_TIMEOUT_MS = 5000;
const PENDING_REQUEST_TIMEOUT_MS = 30000;
const MAX_WS_CONNECTIONS = 200;
const MAX_SEND_BUFFER = 200;
const MAX_PENDING_REQUESTS = 5000;
const sendBuffer = [];

let ws = null;
let reconnectDelay = RECONNECT_BASE_MS;

// In-flight request data, keyed by "tabId:requestId" to avoid cross-tab collision
const pendingRequests = new Map();

// Tracked WS connections for frame capture
const trackedWsConnections = new Map(); // url -> Set<tabId>
const wsCapturingPatterns = new Set();

// Console log injection tracking
const consoleInjectedTabs = new Set();

// Tab monitoring: null means all tabs
let monitoredTabId = null;

function isTabMonitored(tabId) {
  return monitoredTabId === null || monitoredTabId === tabId;
}

function pendingKey(tabId, requestId) {
  return `${tabId}:${requestId}`;
}

// ─── Capability Toggles ─────────────────────────────────────────────────────

const capabilities = { network: true, dom: true, console: true, websocket: true };

async function loadCapabilities() {
  try {
    const stored = await browser.storage.local.get("capabilities");
    if (stored.capabilities) {
      Object.assign(capabilities, stored.capabilities);
    }
  } catch (err) {
    console.warn("[BrowserBridge] Failed to load capabilities:", err);
  }
}

async function saveCapabilities() {
  try {
    await browser.storage.local.set({ capabilities: { ...capabilities } });
  } catch (err) {
    console.warn("[BrowserBridge] Failed to save capabilities:", err);
  }
}

// ─── WebSocket Client ────────────────────────────────────────────────────────

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("[BrowserBridge] Connected to MCP server");
    reconnectDelay = RECONNECT_BASE_MS;
    ws.send(JSON.stringify({ type: "hello", version: "0.1.0" }));
    updateBadge(true);

    // Drain buffered events
    while (sendBuffer.length > 0 && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(sendBuffer.shift()));
    }
  };

  ws.onmessage = (event) => {
    handleServerMessage(event.data).catch(err => {
      console.error("[BrowserBridge] Message handler error:", err);
    });
  };

  ws.onclose = () => {
    console.log("[BrowserBridge] Disconnected, reconnecting...");
    updateBadge(false);
    scheduleReconnect();
  };

  ws.onerror = () => {
    ws.close();
  };
}

function scheduleReconnect() {
  setTimeout(() => {
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  } else if (data.type === "network_event" || data.type === "ws_frame") {
    if (sendBuffer.length < MAX_SEND_BUFFER) {
      sendBuffer.push(data);
    } else {
      console.warn("[BrowserBridge] Send buffer full, dropping event:", data.type, data.url || data.connection_url || "");
    }
  }
}

function updateBadge(connected) {
  const color = connected ? "#4CAF50" : "#F44336";
  const text = connected ? "ON" : "OFF";
  browser.browserAction.setBadgeBackgroundColor({ color });
  browser.browserAction.setBadgeText({ text });
}

function isConnected() {
  return ws && ws.readyState === WebSocket.OPEN;
}

// ─── Target Tab Resolution ──────────────────────────────────────────────────

async function getTargetTab() {
  if (monitoredTabId !== null) {
    try {
      const tab = await browser.tabs.get(monitoredTabId);
      return tab;
    } catch {
      // Monitored tab no longer exists, fall back to active
      monitoredTabId = null;
    }
  }
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs.length ? tabs[0] : null;
}

// ─── Server Message Handler ──────────────────────────────────────────────────

async function handleServerMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (err) {
    console.warn("[BrowserBridge] Failed to parse server message:", err.message, raw.slice(0, 100));
    return;
  }

  const { msg_id, action } = msg;
  if (!msg_id || !action) return;

  let response;
  try {
    switch (action) {
      case "get_page_info":
        if (!capabilities.dom) {
          response = { error: "Capability disabled by user: dom" };
          break;
        }
        response = await handleGetPageInfo();
        break;
      case "query_dom":
        if (!capabilities.dom) {
          response = { error: "Capability disabled by user: dom" };
          break;
        }
        response = await handleQueryDom(msg);
        break;
      case "get_page_html":
        if (!capabilities.dom) {
          response = { error: "Capability disabled by user: dom" };
          break;
        }
        response = await handleGetPageHtml(msg);
        break;
      case "get_console_logs":
        if (!capabilities.console) {
          response = { error: "Capability disabled by user: console" };
          break;
        }
        response = await handleGetConsoleLogs(msg);
        break;
      case "start_ws_capture":
        if (!capabilities.websocket) {
          response = { error: "Capability disabled by user: websocket" };
          break;
        }
        response = await handleStartWsCapture(msg);
        break;
      case "stop_ws_capture":
        if (!capabilities.websocket) {
          response = { error: "Capability disabled by user: websocket" };
          break;
        }
        response = await handleStopWsCapture(msg);
        break;
      default:
        response = { error: `Unknown action: ${action}` };
    }
  } catch (err) {
    response = { error: err.message };
  }

  response.msg_id = msg_id;
  send(response);
}

// ─── Tab Validation ─────────────────────────────────────────────────────────

const PRIVILEGED_PREFIXES = ["about:", "data:", "file:", "moz-extension:", "chrome:"];

function isPrivilegedTab(tab) {
  if (!tab.url) return false;
  return PRIVILEGED_PREFIXES.some((p) => tab.url.startsWith(p));
}

// ─── Page Info ───────────────────────────────────────────────────────────────

async function handleGetPageInfo() {
  const tab = await getTargetTab();
  if (!tab) return { error: "No active tab" };
  return { url: tab.url, title: tab.title, tab_id: tab.id };
}

// ─── DOM Queries ─────────────────────────────────────────────────────────────

async function handleQueryDom(msg) {
  const tab = await getTargetTab();
  if (!tab) return { error: "No active tab" };
  if (isPrivilegedTab(tab)) return { error: `Cannot query privileged page: ${tab.url.split(":")[0]}:` };

  const code = `
    (function() {
      try {
        const MAX_RESULTS = 50;
        const selector = ${JSON.stringify(msg.selector)};
        const nodes = document.querySelectorAll(selector);
        const elements = [];
        for (let i = 0; i < Math.min(nodes.length, MAX_RESULTS); i++) {
          const el = nodes[i];
          const attrs = {};
          for (const attr of el.attributes) {
            attrs[attr.name] = attr.value;
          }
          elements.push({
            tag: el.tagName.toLowerCase(),
            text: (el.textContent || "").slice(0, 200),
            attributes: attrs,
            outerHTML: el.outerHTML.slice(0, 1000),
          });
        }
        return { count: nodes.length, elements };
      } catch (err) {
        return { error: err.message };
      }
    })();
  `;

  try {
    const results = await browser.tabs.executeScript(tab.id, { code });
    if (!results || !results[0] || typeof results[0] !== "object") return { error: "Script execution failed" };
    const data = results[0];
    if (data.error) return { error: data.error };
    return { count: data.count || 0, elements: Array.isArray(data.elements) ? data.elements : [] };
  } catch (err) {
    return { error: err.message };
  }
}

// ─── Page HTML ───────────────────────────────────────────────────────────────

async function handleGetPageHtml(msg) {
  const tab = await getTargetTab();
  if (!tab) return { error: "No active tab" };
  if (isPrivilegedTab(tab)) return { error: `Cannot query privileged page: ${tab.url.split(":")[0]}:` };

  const selector = msg.selector || null;
  const code = `
    (function() {
      const MAX_SIZE = 500 * 1024;
      try {
        let html;
        const selector = ${JSON.stringify(selector)};
        if (selector) {
          const el = document.querySelector(selector);
          if (!el) return { error: "No element found for selector: " + selector };
          html = el.outerHTML;
        } else {
          html = document.documentElement.outerHTML;
        }
        const truncated = html.length > MAX_SIZE;
        return { html: html.slice(0, MAX_SIZE), truncated };
      } catch (err) {
        return { error: err.message };
      }
    })();
  `;

  try {
    const results = await browser.tabs.executeScript(tab.id, { code });
    if (!results || !results[0]) return { error: "Script execution failed" };
    return results[0];
  } catch (err) {
    return { error: err.message };
  }
}

// ─── Console Logs ────────────────────────────────────────────────────────────

const CONSOLE_INJECT_CODE = `
  (function() {
    if (window.__browserBridgeConsoleLogs) return;
    window.__browserBridgeConsoleLogs = [];
    const MAX_LOGS = 500;
    const levels = ["log", "warn", "error", "info", "debug"];
    for (const level of levels) {
      const original = console[level].bind(console);
      console[level] = function(...args) {
        const entry = {
          level,
          timestamp: Date.now(),
          args: args.map(function(a) {
            try {
              return typeof a === "object" ? JSON.stringify(a).slice(0, 1000) : String(a).slice(0, 1000);
            } catch(e) {
              return String(a).slice(0, 1000);
            }
          }),
        };
        const logs = window.__browserBridgeConsoleLogs;
        logs.push(entry);
        if (logs.length > MAX_LOGS) logs.shift();
        original.apply(console, args);
      };
    }
  })();
`;

async function injectConsoleCapture(tabId) {
  if (consoleInjectedTabs.has(tabId)) return;
  try {
    await browser.tabs.executeScript(tabId, { code: CONSOLE_INJECT_CODE, runAt: "document_start" });
    consoleInjectedTabs.add(tabId);
  } catch {
    // Tab may not be ready yet or is a privileged page — silently ignore
  }
}

async function handleGetConsoleLogs(msg) {
  const tab = await getTargetTab();
  if (!tab) return { error: "No active tab" };

  const tabId = tab.id;

  // Inject console capture if not already done for this tab
  if (!consoleInjectedTabs.has(tabId)) {
    try {
      await browser.tabs.executeScript(tabId, { code: CONSOLE_INJECT_CODE, runAt: "document_start" });
      consoleInjectedTabs.add(tabId);
    } catch (err) {
      return { error: "Failed to inject console capture: " + err.message };
    }
  }

  const level = msg.level || null;
  const limit = msg.limit || 100;
  const readCode = `
    (function() {
      const logs = window.__browserBridgeConsoleLogs || [];
      const level = ${JSON.stringify(level)};
      const limit = ${JSON.stringify(limit)};
      let filtered = level ? logs.filter(function(l) { return l.level === level; }) : logs;
      filtered = filtered.slice(-limit);
      return { logs: filtered, count: filtered.length };
    })();
  `;

  try {
    const results = await browser.tabs.executeScript(tabId, { code: readCode });
    if (!results || !results[0]) return { error: "Script execution failed" };
    return results[0];
  } catch (err) {
    return { error: err.message };
  }
}

// ─── Response Body Decoding ──────────────────────────────────────────────────

/**
 * Combines raw response chunks, decompresses if needed (gzip/deflate/br),
 * and decodes to text. Sets pending.response_body.
 */
async function decodeResponseBody(chunks, pending) {
  const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
  const combined = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  // Determine content encoding from response headers
  const encoding = (pending.response_headers || {})["content-encoding"] || "";
  const normalizedEncoding = encoding.trim().toLowerCase();

  let bytes = combined;

  // Decompress if content-encoding indicates compression
  if (normalizedEncoding && normalizedEncoding !== "identity") {
    const decompressFormat =
      normalizedEncoding === "gzip" || normalizedEncoding === "x-gzip" ? "gzip" :
      normalizedEncoding === "deflate" ? "deflate" :
      null; // brotli ("br") is not supported by DecompressionStream

    if (decompressFormat) {
      let writer = null;
      let reader = null;
      try {
        const ds = new DecompressionStream(decompressFormat);
        writer = ds.writable.getWriter();
        reader = ds.readable.getReader();

        const writePromise = writer.write(combined).then(() => writer.close());
        writer = null; // writer.close() handles cleanup on success
        const decompressedChunks = [];
        let readDone = false;
        while (!readDone) {
          const { value, done } = await reader.read();
          if (done) {
            readDone = true;
          } else {
            decompressedChunks.push(value);
          }
        }
        reader = null; // successfully consumed
        await writePromise;

        const decompressedLen = decompressedChunks.reduce((acc, c) => acc + c.length, 0);
        bytes = new Uint8Array(decompressedLen);
        let dOffset = 0;
        for (const chunk of decompressedChunks) {
          bytes.set(chunk, dOffset);
          dOffset += chunk.length;
        }
      } catch (err) {
        console.debug("[BrowserBridge] Decompression failed for", pending.url, normalizedEncoding, err.message);
        // Fall through and try decoding the raw bytes anyway
      } finally {
        try { if (writer) writer.close(); } catch {}
        try { if (reader) reader.cancel(); } catch {}
      }
    }
  }

  // Try decoding as text
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    pending.response_body = decoder.decode(bytes).slice(0, MAX_BODY_SIZE);
    pending.response_body_truncated = pending.response_body_truncated || bytes.length > MAX_BODY_SIZE;
  } catch {
    // Not valid UTF-8 — try latin1 as last resort
    try {
      const decoder = new TextDecoder("iso-8859-1");
      pending.response_body = decoder.decode(bytes).slice(0, MAX_BODY_SIZE);
    } catch {
      // Truly binary — base64 encode first 10KB
      try {
        let binary = "";
        for (let i = 0; i < Math.min(bytes.length, 10000); i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        pending.response_body = "[base64] " + btoa(binary);
      } catch {
        pending.response_body = "[binary data]";
      }
    }
  }
}

// ─── Network Capture ─────────────────────────────────────────────────────────

/**
 * Sends a completed network entry if both the response filter and
 * onCompleted have finished. Falls back after FILTER_FALLBACK_TIMEOUT_MS
 * for cases where filterResponseData never fires.
 */
async function maybeSendEntry(key) {
  const entry = pendingRequests.get(key);
  if (!entry) return;
  if (!entry._filterDone || !entry._completeDone) return;

  // Clear timers
  if (entry._fallbackTimer) {
    clearTimeout(entry._fallbackTimer);
    entry._fallbackTimer = null;
  }
  if (entry._hardTimer) {
    clearTimeout(entry._hardTimer);
    entry._hardTimer = null;
  }

  pendingRequests.delete(key);

  // Decode raw response body now that headers (content-encoding) are available
  const chunks = entry._rawChunks;
  if (chunks && chunks.length > 0 && !SKIP_CONTENT_TYPES.test(entry.content_type || "")) {
    await decodeResponseBody(chunks, entry);
  }
  delete entry._rawChunks;

  // If we still have no body, try fetching from cache as fallback
  // Only refetch for safe methods to avoid unintended side effects
  if (!entry.response_body && entry.url) {
    const skipType = SKIP_CONTENT_TYPES.test(entry.content_type || "");
    const safeMethod = entry.method === "GET" || entry.method === "HEAD";
    if (!skipType && safeMethod) {
      await fetchBodyFallback(entry);
    }
  }

  sendEntry(entry);
}

async function fetchBodyFallback(entry) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(entry.url, { cache: "force-cache", signal: controller.signal });
    clearTimeout(timeout);
    if (resp.ok) {
      const text = await resp.text();
      entry.response_body = text.slice(0, MAX_BODY_SIZE);
      entry.response_body_truncated = text.length > MAX_BODY_SIZE;
    }
  } catch {
    // Fallback failed — send without body
  }
}

function sendEntry(entry) {
  // Remove internal tracking flags before sending
  delete entry._filterDone;
  delete entry._completeDone;
  delete entry._fallbackTimer;
  delete entry._hardTimer;
  delete entry._filterFailed;
  send({
    type: "network_event",
    ...entry,
  });
}

function cleanupEntry(key) {
  const entry = pendingRequests.get(key);
  if (!entry) return;
  if (entry._fallbackTimer) clearTimeout(entry._fallbackTimer);
  if (entry._hardTimer) clearTimeout(entry._hardTimer);
  pendingRequests.delete(key);
}

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!isTabMonitored(details.tabId)) return;

    // Track WebSocket upgrade requests regardless of network capability
    if (details.url.startsWith("ws://") || details.url.startsWith("wss://")) {
      if (capabilities.websocket) {
        if (trackedWsConnections.size >= MAX_WS_CONNECTIONS) {
          const firstKey = trackedWsConnections.keys().next().value;
          trackedWsConnections.delete(firstKey);
        }
        const tabIds = trackedWsConnections.get(details.url);
        if (tabIds) {
          tabIds.add(details.tabId);
        } else {
          trackedWsConnections.set(details.url, new Set([details.tabId]));
        }
      }
      return;
    }

    if (!capabilities.network) return;

    const key = pendingKey(details.tabId, details.requestId);

    const entry = {
      request_id: String(details.requestId),
      tab_id: details.tabId,
      url: details.url,
      method: details.method,
      timestamp: details.timeStamp,
      request_body: null,
      request_headers: {},
      status_code: null,
      response_headers: {},
      response_body: null,
      content_type: null,
      ip: null,
      response_body_truncated: false,
      _filterDone: false,
      _completeDone: false,
      _filterFailed: false,
      _fallbackTimer: null,
      _hardTimer: null,
    };

    // Capture request body
    if (details.requestBody) {
      if (details.requestBody.formData) {
        entry.request_body = JSON.stringify(details.requestBody.formData);
      } else if (details.requestBody.raw) {
        try {
          const decoder = new TextDecoder();
          const parts = details.requestBody.raw.map((p) =>
            p.bytes ? decoder.decode(p.bytes) : p.file ? `[file: ${p.file}]` : ""
          );
          entry.request_body = parts.join("");
        } catch {
          entry.request_body = "[binary data]";
        }
      }
    }

    // Evict oldest entry if we've hit the size cap
    if (pendingRequests.size >= MAX_PENDING_REQUESTS) {
      const oldestKey = pendingRequests.keys().next().value;
      cleanupEntry(oldestKey);
    }

    pendingRequests.set(key, entry);

    // Hard timeout: evict orphaned entries that never complete
    entry._hardTimer = setTimeout(() => {
      cleanupEntry(key);
    }, PENDING_REQUEST_TIMEOUT_MS);

    // Set up response body capture via filterResponseData (Firefox-specific)
    try {
      const filter = browser.webRequest.filterResponseData(details.requestId);
      const chunks = [];
      let totalSize = 0;
      let truncated = false;

      filter.ondata = (event) => {
        // CRITICAL: always pass data through to avoid hanging the browser
        filter.write(event.data);

        if (!truncated && totalSize < MAX_BODY_SIZE) {
          chunks.push(new Uint8Array(event.data));
          totalSize += event.data.byteLength;
          if (totalSize >= MAX_BODY_SIZE) {
            truncated = true;
          }
        }
      };

      filter.onstop = () => {
        filter.close();

        const pending = pendingRequests.get(key);
        if (pending) {
          pending.response_body_truncated = truncated;
          // Store raw chunks — decoding happens in maybeSendEntry once headers are available
          pending._rawChunks = chunks;
          pending._filterDone = true;
          // Filter completed but captured no data — treat as failure so fallback can try
          if (chunks.length === 0) {
            pending._filterFailed = true;
          }
          maybeSendEntry(key);
        }
      };

      filter.onerror = (event) => {
        console.warn("[BrowserBridge] Response filter error for", details.url, filter.error);
        try { filter.close(); } catch {}
        const pending = pendingRequests.get(key);
        if (pending) {
          pending._filterDone = true;
          pending._filterFailed = true;
          maybeSendEntry(key);
        }
      };
    } catch (err) {
      // filterResponseData not available (cached, service worker, etc.)
      console.debug("[BrowserBridge] filterResponseData unavailable for", details.url, err.message);
      entry._filterDone = true;
      entry._filterFailed = true;
    }
  },
  { urls: ["<all_urls>"] },
  ["requestBody"]
);

browser.webRequest.onSendHeaders.addListener(
  (details) => {
    if (!capabilities.network) return;

    const key = pendingKey(details.tabId, details.requestId);
    const entry = pendingRequests.get(key);
    if (entry && details.requestHeaders) {
      const headers = {};
      for (const h of details.requestHeaders) {
        headers[h.name.toLowerCase()] = h.value || "";
      }
      entry.request_headers = headers;
    }
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders"]
);

browser.webRequest.onCompleted.addListener(
  (details) => {
    if (!capabilities.network) return;

    const key = pendingKey(details.tabId, details.requestId);
    const entry = pendingRequests.get(key);
    if (!entry) return;

    entry.status_code = details.statusCode;
    entry.ip = details.ip || null;

    if (details.responseHeaders) {
      const headers = {};
      for (const h of details.responseHeaders) {
        headers[h.name.toLowerCase()] = h.value || "";
        if (h.name.toLowerCase() === "content-type") {
          entry.content_type = h.value;
        }
      }
      entry.response_headers = headers;
    }

    entry._completeDone = true;

    // If filter is already done, send immediately
    if (entry._filterDone) {
      maybeSendEntry(key);
    } else {
      // Set a fallback timeout in case the filter never fires
      entry._fallbackTimer = setTimeout(() => {
        const pending = pendingRequests.get(key);
        if (pending && !pending._filterDone) {
          pending._filterDone = true;
          pending._filterFailed = true;
          maybeSendEntry(key);
        }
      }, FILTER_FALLBACK_TIMEOUT_MS);
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

browser.webRequest.onErrorOccurred.addListener(
  (details) => {
    const key = pendingKey(details.tabId, details.requestId);
    cleanupEntry(key);
  },
  { urls: ["<all_urls>"] }
);

// Re-inject console capture on navigation when capability is on, and clean up stale WS connections
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    consoleInjectedTabs.delete(tabId);

    // Re-inject console capture eagerly if the capability is enabled
    if (capabilities.console) {
      // Small delay to let the new document start loading
      setTimeout(() => injectConsoleCapture(tabId), 100);
    }

    // Clean up tracked WS connections for this tab on navigation
    for (const [url, tabIds] of trackedWsConnections) {
      tabIds.delete(tabId);
      if (tabIds.size === 0) {
        trackedWsConnections.delete(url);
      }
    }
  }
});

// Clean up tab-associated state on tab close
browser.tabs.onRemoved.addListener((tabId) => {
  consoleInjectedTabs.delete(tabId);
  if (monitoredTabId === tabId) {
    monitoredTabId = null;
  }
  for (const [url, tabIds] of trackedWsConnections) {
    tabIds.delete(tabId);
    if (tabIds.size === 0) {
      trackedWsConnections.delete(url);
    }
  }
});

// ─── WebSocket Frame Capture ─────────────────────────────────────────────────

async function handleStartWsCapture(msg) {
  const urlPattern = msg.url_pattern;
  try {
    new RegExp(urlPattern);
  } catch (e) {
    return { error: `Invalid regex pattern: ${e.message}` };
  }
  wsCapturingPatterns.add(urlPattern);

  const tab = await getTargetTab();
  if (!tab) return { error: "No active tab" };

  const tabId = tab.id;

  // Inject relay + WS constructor override in a single executeScript call
  const combinedCode = `
    (function() {
      // --- Relay: content script context, bridges postMessage -> runtime.sendMessage ---
      if (!window.__browserBridgeWsRelay) {
        window.__browserBridgeWsRelay = true;
        window.addEventListener("message", function(event) {
          if (event.source !== window) return;
          if (!event.data || !event.data.__browserBridgeWsFrame) return;
          browser.runtime.sendMessage({
            type: "ws_frame_relay",
            connection_url: event.data.url,
            direction: event.data.direction,
            data: event.data.data,
            timestamp: event.data.timestamp,
          });
        });
      }

      // --- WS constructor override: page context via wrappedJSObject for Firefox ---
      const w = window.wrappedJSObject || window;
      if (w.__browserBridgeWsCapture) {
        w.__browserBridgeWsCapture.patterns.add(${JSON.stringify(urlPattern)});
        return;
      }

      const patterns = new Set([${JSON.stringify(urlPattern)}]);
      const OriginalWebSocket = w.WebSocket;

      w.__browserBridgeWsCapture = { patterns, original: OriginalWebSocket };

      const NewWebSocket = function(url, protocols) {
        const socket = protocols
          ? new OriginalWebSocket(url, protocols)
          : new OriginalWebSocket(url);

        let capturing = false;
        for (const pattern of patterns) {
          if (new RegExp(pattern, "i").test(url)) {
            capturing = true;
            break;
          }
        }

        if (capturing) {
          const originalSend = socket.send.bind(socket);
          socket.send = function(data) {
            window.postMessage({
              __browserBridgeWsFrame: true,
              direction: "sent",
              data: typeof data === "string" ? data : "[binary]",
              url: url,
              timestamp: Date.now(),
            }, "*");
            return originalSend(data);
          };

          socket.addEventListener("message", function(event) {
            window.postMessage({
              __browserBridgeWsFrame: true,
              direction: "received",
              data: typeof event.data === "string" ? event.data : "[binary]",
              url: url,
              timestamp: Date.now(),
            }, "*");
          });
        }

        return socket;
      };
      NewWebSocket.prototype = OriginalWebSocket.prototype;
      NewWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
      NewWebSocket.OPEN = OriginalWebSocket.OPEN;
      NewWebSocket.CLOSING = OriginalWebSocket.CLOSING;
      NewWebSocket.CLOSED = OriginalWebSocket.CLOSED;
      w.WebSocket = NewWebSocket;
    })();
  `;
  await browser.tabs.executeScript(tabId, { code: combinedCode });

  // Count matched connections
  const regex = new RegExp(urlPattern, "i");
  let matched = 0;
  for (const url of trackedWsConnections.keys()) {
    if (regex.test(url)) matched++;
  }

  return { matched_connections: matched };
}

async function handleStopWsCapture(msg) {
  const urlPattern = msg.url_pattern;
  wsCapturingPatterns.delete(urlPattern);

  const tab = await getTargetTab();
  if (!tab) return { status: "stopped" };

  const code = `
    (function() {
      const w = window.wrappedJSObject || window;
      if (w.__browserBridgeWsCapture) {
        w.__browserBridgeWsCapture.patterns.delete(${JSON.stringify(urlPattern)});
        if (w.__browserBridgeWsCapture.patterns.size === 0) {
          w.WebSocket = w.__browserBridgeWsCapture.original;
          delete w.__browserBridgeWsCapture;
        }
      }
    })();
  `;
  await browser.tabs.executeScript(tab.id, { code });

  return { status: "stopped" };
}

// Listen for WS frame messages relayed from content scripts via runtime messaging
// AND messages from the popup UI
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "ws_frame_relay") {
    send({
      type: "ws_frame",
      connection_url: msg.connection_url,
      direction: msg.direction,
      data: (msg.data || "").slice(0, MAX_BODY_SIZE),
      timestamp: msg.timestamp,
      tab_id: sender.tab ? sender.tab.id : -1,
    });
    return;
  }

  // Popup messages
  if (msg.type === "get_status") {
    sendResponse({
      connected: isConnected(),
      capabilities: { ...capabilities },
      monitoredTabId,
      stats: {
        pendingRequests: pendingRequests.size,
        trackedWsConnections: trackedWsConnections.size,
        wsCapturingPatterns: [...wsCapturingPatterns],
        consoleInjectedTabs: consoleInjectedTabs.size,
      },
      wsUrl: WS_URL,
    });
    return;
  }

  if (msg.type === "clear_data") {
    pendingRequests.clear();
    trackedWsConnections.clear();
    wsCapturingPatterns.clear();
    consoleInjectedTabs.clear();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "set_capability") {
    const { name, enabled } = msg;
    if (name in capabilities) {
      capabilities[name] = enabled;
      saveCapabilities().then(async () => {
        // Eagerly inject console capture into the active tab when toggled on
        if (name === "console" && enabled) {
          const tab = await getTargetTab();
          if (tab) {
            await injectConsoleCapture(tab.id);
          }
        }
        sendResponse({ ok: true, capabilities: { ...capabilities } });
      }).catch((err) => {
        console.error("[BrowserBridge] Failed to save capability:", err);
        sendResponse({ ok: false, error: err.message });
      });
    } else {
      sendResponse({ ok: false, error: `Unknown capability: ${name}` });
    }
    return true; // async sendResponse
  }

  if (msg.type === "get_tabs") {
    browser.tabs.query({}).then((tabs) => {
      const tabList = tabs.map((t) => ({ id: t.id, title: t.title || "", url: t.url || "" }));
      sendResponse({ tabs: tabList, monitoredTabId });
    }).catch((err) => {
      console.error("[BrowserBridge] Failed to query tabs:", err);
      sendResponse({ tabs: [], monitoredTabId });
    });
    return true; // async sendResponse
  }

  if (msg.type === "set_monitored_tab") {
    monitoredTabId = msg.tabId; // null = all tabs
    sendResponse({ ok: true, monitoredTabId });
    return;
  }
});

// ─── Init ────────────────────────────────────────────────────────────────────

loadCapabilities().then(async () => {
  connect();

  // Eagerly inject console capture into the active tab on startup
  if (capabilities.console) {
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      if (tabs.length > 0) {
        await injectConsoleCapture(tabs[0].id);
      }
    } catch {
      // May fail on privileged pages — ignore
    }
  }
});
