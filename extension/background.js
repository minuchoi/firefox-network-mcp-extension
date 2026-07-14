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

// Dynamic content script registration handle (browser.contentScripts.register)
let xhrHookRegistration = null;
// Guards against concurrent registerXhrHookContentScript() calls double-registering
let xhrHookRegistering = false;
// Whether webRequest listeners are currently registered
let webRequestListenersActive = false;
// Buffer for XHR-captured bodies awaiting correlation with webRequest entries
// Key: "tabId:method:url", Value: { response_body, timestamp }
const xhrBodyBuffer = new Map();
const XHR_BODY_BUFFER_MAX = 500;

// Tab monitoring: always a specific tab ID (set to active tab on startup)
let monitoredTabId = null;

function isTabMonitored(tabId) {
  // Only the explicitly selected tab is monitored. A null id means "none"
  // (e.g. immediately after the monitored tab was closed), never "all tabs" —
  // the latter would reintroduce the browser-wide capture slowdown.
  return monitoredTabId !== null && monitoredTabId === tabId;
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
      case "get_screenshot":
        if (!capabilities.dom) {
          response = { error: "Capability disabled by user: dom" };
          break;
        }
        response = await handleGetScreenshot(msg);
        break;
      case "get_storage":
        if (!capabilities.dom) {
          response = { error: "Capability disabled by user: dom" };
          break;
        }
        response = await handleGetStorage(msg);
        break;
      case "get_capture_status":
        // Intentionally ungated: diagnostics must work even when capture is off.
        response = await handleGetCaptureStatus();
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

// Content scripts run in an isolated compartment, so overriding `console` here
// would NOT intercept the page's own console.* calls (Firefox Xray isolation —
// the same reason the XHR hook must run page-world). Inject the override via a
// <script> tag so it runs in the page world and stores logs on the page window;
// the read path pulls them back via window.wrappedJSObject.
const CONSOLE_INJECT_CODE = `
  (function() {
    if (window.__bbConsoleInjected) return;
    window.__bbConsoleInjected = true;
    var s = document.createElement("script");
    s.textContent = '(' + function() {
      if (window.__browserBridgeConsoleLogs) return;
      window.__browserBridgeConsoleLogs = [];
      var MAX_LOGS = 500;
      var levels = ["log", "warn", "error", "info", "debug"];
      levels.forEach(function(level) {
        var original = console[level].bind(console);
        console[level] = function() {
          var args = Array.prototype.slice.call(arguments);
          try {
            var entry = {
              level: level,
              timestamp: Date.now(),
              args: args.map(function(a) {
                try {
                  return typeof a === "object" ? JSON.stringify(a).slice(0, 1000) : String(a).slice(0, 1000);
                } catch(e) {
                  return String(a).slice(0, 1000);
                }
              }),
            };
            var logs = window.__browserBridgeConsoleLogs;
            logs.push(entry);
            if (logs.length > MAX_LOGS) logs.shift();
          } catch(e) {}
          return original.apply(console, args);
        };
      });
    } + ')();';
    (document.documentElement || document).appendChild(s);
    s.remove();
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
      // Logs live on the page world; read them through wrappedJSObject and copy
      // primitives out so the returned value is a clean content-script object.
      var page = window.wrappedJSObject;
      var raw = page ? page.__browserBridgeConsoleLogs : window.__browserBridgeConsoleLogs;
      if (!raw) return { logs: [], count: 0 };
      var level = ${JSON.stringify(level)};
      var limit = ${JSON.stringify(limit)};
      var out = [];
      for (var i = 0; i < raw.length; i++) {
        var l = raw[i];
        if (level && String(l.level) !== level) continue;
        var args = [];
        for (var j = 0; j < l.args.length; j++) args.push(String(l.args[j]));
        out.push({ level: String(l.level), timestamp: Number(l.timestamp), args: args });
      }
      if (out.length > limit) out = out.slice(out.length - limit);
      return { logs: out, count: out.length };
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

// ─── Screenshot ──────────────────────────────────────────────────────────────

async function handleGetScreenshot(msg) {
  const tab = await getTargetTab();
  if (!tab) return { error: "No active tab" };

  const format = msg.format === "jpeg" ? "jpeg" : "png";
  const options = { format };
  if (format === "jpeg") {
    const q = Number(msg.quality);
    options.quality = Number.isFinite(q) ? Math.max(0, Math.min(100, q)) : 80;
  }

  try {
    // captureTab (Firefox 82+) grabs a specific tab regardless of which tab is
    // active; fall back to the active tab of the window otherwise.
    const dataUrl = browser.tabs.captureTab
      ? await browser.tabs.captureTab(tab.id, options)
      : await browser.tabs.captureVisibleTab(tab.windowId, options);
    const comma = dataUrl.indexOf(",");
    return {
      data: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
      mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
    };
  } catch (err) {
    return { error: err.message };
  }
}

// ─── Storage / Cookies ───────────────────────────────────────────────────────

async function handleGetStorage(msg) {
  const tab = await getTargetTab();
  if (!tab) return { error: "No active tab" };

  const MAX_VALUE = 10000; // truncate large values to keep the payload sane
  const result = { url: tab.url };

  // localStorage / sessionStorage: content scripts share the page origin, so
  // window.localStorage here IS the page's storage (no page-world injection).
  const readCode = `
    (function() {
      var MAX = ${MAX_VALUE};
      function dump(s) {
        var out = {};
        try {
          for (var i = 0; i < s.length; i++) {
            var k = s.key(i);
            var v = s.getItem(k);
            out[k] = (v != null && v.length > MAX) ? v.slice(0, MAX) + "\\u2026[truncated]" : v;
          }
        } catch(e) { return { __error: String(e) }; }
        return out;
      }
      return { local: dump(window.localStorage), session: dump(window.sessionStorage) };
    })();
  `;
  try {
    const results = await browser.tabs.executeScript(tab.id, { code: readCode });
    if (results && results[0]) {
      result.local_storage = results[0].local;
      result.session_storage = results[0].session;
    }
  } catch (err) {
    result.storage_error = err.message;
  }

  // Cookies via the cookies API — includes HttpOnly cookies that document.cookie
  // cannot see (the common case for session/auth debugging).
  try {
    const cookies = await browser.cookies.getAll({ url: tab.url });
    result.cookies = cookies.map((c) => ({
      name: c.name,
      value: c.value.length > MAX_VALUE ? c.value.slice(0, MAX_VALUE) + "…[truncated]" : c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      session: c.session,
      expirationDate: c.expirationDate || null,
    }));
  } catch (err) {
    result.cookies_error = err.message;
  }

  return result;
}

// ─── Capture Diagnostics ──────────────────────────────────────────────────────

async function handleGetCaptureStatus() {
  const status = {
    connected: isConnected(),
    monitored_tab_id: monitoredTabId,
    capabilities: { ...capabilities },
    web_request_listeners_active: webRequestListenersActive,
    xhr_hook_registered: xhrHookRegistration !== null,
    tracked_ws_connections: trackedWsConnections.size,
    ws_capturing_patterns: [...wsCapturingPatterns],
    pending_requests: pendingRequests.size,
    console_injected_tabs: consoleInjectedTabs.size,
  };

  const warnings = [];
  if (monitoredTabId === null) {
    warnings.push("No tab is monitored; network and console capture are inactive until a tab is selected.");
  }

  const tab = await getTargetTab();
  if (tab) {
    status.tab = { id: tab.id, url: tab.url, title: tab.title };
    try {
      const results = await browser.tabs.executeScript(tab.id, { code: `
        (function() {
          var page = window.wrappedJSObject;
          return {
            xhr_relay_present: !!window.__browserBridgeXhrRelay,
            xhr_page_hook_present: !!(page && page.__browserBridgeXhrCapture),
            console_hook_present: !!(page && page.__browserBridgeConsoleLogs),
            ws_capture_present: !!(page && page.__browserBridgeWsCapture),
          };
        })();
      ` });
      status.tab_hooks = (results && results[0]) || null;
    } catch (err) {
      status.tab_hooks = { error: err.message };
    }

    const h = status.tab_hooks;
    if (h && !h.error) {
      if (capabilities.network && h.xhr_relay_present && !h.xhr_page_hook_present) {
        warnings.push("XHR/fetch page-world hook not present despite network capture on. The page's Content-Security-Policy may block inline <script> injection; filterResponseData still works as primary body capture.");
      }
      if (capabilities.console && !h.console_hook_present) {
        warnings.push("Console hook not present on this tab. It injects on toggle-on, navigation, or first get_console_logs, and a strict CSP can block it.");
      }
    }
    if (tab.id !== monitoredTabId && monitoredTabId !== null) {
      warnings.push("Target tab differs from the monitored tab.");
    }
  }

  status.warnings = warnings;
  return status;
}

// ─── XHR/Fetch Response Body Capture ────────────────────────────────────────

// The page-world XHR/fetch hook lives in xhr_hook_content.js. The code below
// only correlates the bodies it relays back with webRequest entries.
// XHR/fetch hook is registered dynamically via browser.contentScripts.register()
// when network capability is enabled, and unregistered when disabled. This avoids
// wrapping XHR/fetch on every page when network capture is off. The hook runs at
// document_start for guaranteed pre-page-script timing, passes through GET/HEAD
// with zero overhead, and only captures bodies for mutating methods (POST/PUT/DELETE/PATCH).

function correlateXhrBody(msg, tabId) {
  const { method, url, timestamp, status, response_body } = msg;
  if (!response_body || !url) return;

  const TOLERANCE_MS = 5000;

  // Strategy 1: Try to match a pending webRequest entry that has no body yet
  for (const [key, entry] of pendingRequests) {
    if (entry.tab_id !== tabId) continue;
    if (entry.method !== method) continue;
    if (entry.url !== url) continue;
    if (Math.abs(entry.timestamp - timestamp) > TOLERANCE_MS) continue;
    if (entry.response_body) continue;

    entry._xhrBody = response_body;
    return;
  }

  // Strategy 2: Buffer for later correlation, and also send patch to server
  // for entries already dispatched
  const bufferKey = tabId + ":" + method + ":" + url;
  xhrBodyBuffer.set(bufferKey, { response_body, timestamp, received: Date.now() });
  if (xhrBodyBuffer.size > XHR_BODY_BUFFER_MAX) {
    const firstKey = xhrBodyBuffer.keys().next().value;
    xhrBodyBuffer.delete(firstKey);
  }

  send({
    type: "xhr_body_patch",
    tab_id: tabId,
    method: method,
    url: url,
    timestamp: timestamp,
    status_code: status,
    response_body: (response_body || "").slice(0, MAX_BODY_SIZE),
  });
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
      const decompressedChunks = [];
      let writer = null;
      let reader = null;
      try {
        const ds = new DecompressionStream(decompressFormat);
        writer = ds.writable.getWriter();
        reader = ds.readable.getReader();

        const writePromise = writer.write(combined).then(() => writer.close());
        writer = null; // writer.close() handles cleanup on success
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
      } catch (err) {
        console.debug("[BrowserBridge] Decompression failed for", pending.url, normalizedEncoding, err.message);
        // A body truncated at MAX_BODY_SIZE is an incomplete compressed stream:
        // it decompresses partially, then throws. Keep the partial output below.
      } finally {
        try { if (writer) writer.close(); } catch {}
        try { if (reader) reader.cancel(); } catch {}
      }

      if (decompressedChunks.length > 0) {
        const decompressedLen = decompressedChunks.reduce((acc, c) => acc + c.length, 0);
        bytes = new Uint8Array(decompressedLen);
        let dOffset = 0;
        for (const chunk of decompressedChunks) {
          bytes.set(chunk, dOffset);
          dOffset += chunk.length;
        }
      } else if (pending.response_body_truncated) {
        // Truncated compressed stream we could not decompress at all. Decoding
        // the raw compressed bytes would emit garbage, so bail with a marker.
        pending.response_body = "[truncated compressed response, not decoded]";
        return;
      }
      // else: bytes stays as the raw combined bytes and we fall through to the
      // text decode (e.g. a mislabeled content-encoding that was not compressed).
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

  // If XHR hook captured a body for this entry, use it
  if (!entry.response_body && entry._xhrBody) {
    entry.response_body = entry._xhrBody.slice(0, MAX_BODY_SIZE);
    entry.response_body_truncated = entry._xhrBody.length > MAX_BODY_SIZE;
  }

  // Check the XHR body buffer for a match (XHR load event may fire before webRequest completes)
  if (!entry.response_body && entry.url) {
    const bufferKey = entry.tab_id + ":" + entry.method + ":" + entry.url;
    const buffered = xhrBodyBuffer.get(bufferKey);
    if (buffered && Math.abs(entry.timestamp - buffered.timestamp) < 5000) {
      entry.response_body = buffered.response_body.slice(0, MAX_BODY_SIZE);
      entry.response_body_truncated = buffered.response_body.length > MAX_BODY_SIZE;
      xhrBodyBuffer.delete(bufferKey);
    }
  }
  delete entry._xhrBody;

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

  delete entry._xhrBody;
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

// Skip response body capture for URLs that are obviously binary assets or
// static resources. filterResponseData has significant per-request IPC
// overhead, so avoid it for resources we'd never inspect for API debugging.
const SKIP_URL_EXTS = /\.(png|jpe?g|gif|webp|avif|ico|svg|woff2?|ttf|otf|eot|mp[34]|webm|ogg|wav|flac|pdf|zip|gz|br|wasm|js|mjs|css)(\?|$)/i;

// ─── Named webRequest handlers (for dynamic add/remove) ─────────────────────

function onBeforeRequestHandler(details) {
  if (!isTabMonitored(details.tabId)) return;

  // Track WebSocket upgrade requests regardless of network capability
  if (details.url.startsWith("ws://") || details.url.startsWith("wss://")) {
    if (capabilities.websocket) {
      const tabIds = trackedWsConnections.get(details.url);
      if (tabIds) {
        tabIds.add(details.tabId);
      } else {
        // Only evict when actually adding a new URL, so a reconnect to an
        // already-tracked URL never drops an unrelated connection.
        if (trackedWsConnections.size >= MAX_WS_CONNECTIONS) {
          const firstKey = trackedWsConnections.keys().next().value;
          trackedWsConnections.delete(firstKey);
        }
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

  // A redirect reuses the same requestId, so this key may already hold the
  // previous hop. Clear it (and its timers) first so its stale filter/timer
  // callbacks cannot corrupt this hop's entry.
  if (pendingRequests.has(key)) cleanupEntry(key);
  pendingRequests.set(key, entry);

  // Hard timeout: evict orphaned entries that never complete
  entry._hardTimer = setTimeout(() => {
    if (pendingRequests.get(key) === entry) cleanupEntry(key);
  }, PENDING_REQUEST_TIMEOUT_MS);

  if (SKIP_URL_EXTS.test(details.url)) {
    entry._filterDone = true;
  }

  // Set up response body capture via filterResponseData (Firefox-specific)
  if (!entry._filterDone) try {
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

      // If a redirect hop replaced the entry under this shared key, this is a
      // stale callback for a superseded hop — do not touch the newer entry.
      if (pendingRequests.get(key) !== entry) return;
      entry.response_body_truncated = truncated;
      // Store raw chunks; decoding happens in maybeSendEntry once headers arrive
      entry._rawChunks = chunks;
      entry._filterDone = true;
      maybeSendEntry(key);
    };

    filter.onerror = (event) => {
      console.warn("[BrowserBridge] Response filter error for", details.url, filter.error);
      try { filter.close(); } catch {}
      if (pendingRequests.get(key) !== entry) return;
      entry._filterDone = true;
      maybeSendEntry(key);
    };
  } catch (err) {
    // filterResponseData not available (cached, service worker, etc.)
    console.debug("[BrowserBridge] filterResponseData unavailable for", details.url, err.message);
    entry._filterDone = true;
  }
}

function onSendHeadersHandler(details) {
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
}

function onCompletedHandler(details) {
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
        maybeSendEntry(key);
      }
    }, FILTER_FALLBACK_TIMEOUT_MS);
  }
}

function onErrorOccurredHandler(details) {
  const key = pendingKey(details.tabId, details.requestId);
  cleanupEntry(key);
}

// ─── Dynamic webRequest listener registration ────────────────────────────────

function registerWebRequestListeners() {
  if (webRequestListenersActive) return;
  browser.webRequest.onBeforeRequest.addListener(
    onBeforeRequestHandler,
    { urls: ["<all_urls>"] },
    ["requestBody"]
  );
  browser.webRequest.onSendHeaders.addListener(
    onSendHeadersHandler,
    { urls: ["<all_urls>"] },
    ["requestHeaders"]
  );
  browser.webRequest.onCompleted.addListener(
    onCompletedHandler,
    { urls: ["<all_urls>"] },
    ["responseHeaders"]
  );
  browser.webRequest.onErrorOccurred.addListener(
    onErrorOccurredHandler,
    { urls: ["<all_urls>"] }
  );
  webRequestListenersActive = true;
  console.log("[BrowserBridge] webRequest listeners registered");
}

function unregisterWebRequestListeners() {
  if (!webRequestListenersActive) return;
  browser.webRequest.onBeforeRequest.removeListener(onBeforeRequestHandler);
  browser.webRequest.onSendHeaders.removeListener(onSendHeadersHandler);
  browser.webRequest.onCompleted.removeListener(onCompletedHandler);
  browser.webRequest.onErrorOccurred.removeListener(onErrorOccurredHandler);
  webRequestListenersActive = false;
  console.log("[BrowserBridge] webRequest listeners unregistered");
}

// ─── Dynamic XHR/fetch content script registration ───────────────────────────

async function registerXhrHookContentScript() {
  // Guard on the in-flight flag too: contentScripts.register() is async, so two
  // overlapping calls (e.g. startup + a rapid toggle) would both pass a bare
  // `if (xhrHookRegistration)` check and double-register, leaking the first handle.
  if (xhrHookRegistration || xhrHookRegistering) return;
  xhrHookRegistering = true;
  try {
    const reg = await browser.contentScripts.register({
      matches: ["<all_urls>"],
      js: [{ file: "xhr_hook_content.js" }],
      runAt: "document_start",
      allFrames: false,
    });
    // If network capture was toggled off while we were registering, undo it.
    if (!capabilities.network) {
      try { await reg.unregister(); } catch {}
      return;
    }
    xhrHookRegistration = reg;
    console.log("[BrowserBridge] XHR/fetch content script registered");
  } catch (err) {
    console.error("[BrowserBridge] Failed to register XHR hook content script:", err);
  } finally {
    xhrHookRegistering = false;
  }
}

async function unregisterXhrHookContentScript() {
  if (!xhrHookRegistration) return;
  try {
    await xhrHookRegistration.unregister();
  } catch (err) {
    console.warn("[BrowserBridge] Failed to unregister XHR hook content script:", err);
  }
  xhrHookRegistration = null;
  console.log("[BrowserBridge] XHR/fetch content script unregistered");
}

// ─── Capability-driven listener management ───────────────────────────────────
// Registers or unregisters webRequest listeners and XHR hook based on whether
// network or websocket capabilities are enabled. Called on capability toggle
// and on startup after loading persisted capabilities.

function updateListenerRegistrations() {
  const needWebRequest = capabilities.network || capabilities.websocket;
  if (needWebRequest) {
    registerWebRequestListeners();
  } else {
    unregisterWebRequestListeners();
  }

  if (capabilities.network) {
    registerXhrHookContentScript();
  } else {
    unregisterXhrHookContentScript();
  }
}

// Re-inject captures on navigation when capabilities are on, and clean up stale WS connections
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    consoleInjectedTabs.delete(tabId);

    // Only inject into monitored tabs to avoid unnecessary IPC across all tabs
    if (!isTabMonitored(tabId)) {
      // Still clean up WS connections for unmonitored tabs (below)
    } else {
      // Re-inject console capture eagerly if the capability is enabled
      if (capabilities.console) {
        // Small delay to let the new document start loading
        setTimeout(() => injectConsoleCapture(tabId), 100);
      }

      // XHR/fetch hook is handled by the dynamically registered content script
      // (registerXhrHookContentScript) which runs at document_start. No need
      // for executeScript here — it would race with page scripts and lose.
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
    // Re-select the active tab so we keep monitoring a single tab rather than
    // sitting in the "none" state (which would show a stale tab in the popup).
    browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      if (tabs.length > 0) {
        monitoredTabId = tabs[0].id;
        if (capabilities.console) injectConsoleCapture(monitoredTabId).catch(() => {});
      }
    }).catch(() => {});
  }
  // Clean up pending requests for the closed tab
  for (const [key, entry] of pendingRequests) {
    if (entry.tab_id === tabId) cleanupEntry(key);
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

  // Inject the content-script relay + a page-world WS constructor override.
  const combinedCode = `
    (function() {
      // --- Relay: content-script context, bridges postMessage -> runtime.sendMessage ---
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

      // --- WS constructor override: injected into the PAGE world via <script>.
      // Assigning a content-script function onto the page window (even via
      // wrappedJSObject) does not work under Firefox Xray wrappers, so the hook
      // must be defined in the page context itself. ---
      var s = document.createElement("script");
      s.textContent = "(" + function(pattern) {
        if (window.__browserBridgeWsCapture) {
          window.__browserBridgeWsCapture.patterns.push(pattern);
          return;
        }
        var patterns = [pattern];
        var OriginalWebSocket = window.WebSocket;
        window.__browserBridgeWsCapture = { patterns: patterns, original: OriginalWebSocket };

        var NewWebSocket = function(url, protocols) {
          var socket = protocols ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);
          var capturing = false;
          for (var i = 0; i < patterns.length; i++) {
            try { if (new RegExp(patterns[i], "i").test(url)) { capturing = true; break; } } catch(e) {}
          }
          if (capturing) {
            var originalSend = socket.send.bind(socket);
            socket.send = function(data) {
              try {
                window.postMessage({ __browserBridgeWsFrame: true, direction: "sent", data: typeof data === "string" ? data : "[binary]", url: url, timestamp: Date.now() }, "*");
              } catch(e) {}
              return originalSend(data);
            };
            socket.addEventListener("message", function(event) {
              window.postMessage({ __browserBridgeWsFrame: true, direction: "received", data: typeof event.data === "string" ? event.data : "[binary]", url: url, timestamp: Date.now() }, "*");
            });
          }
          return socket;
        };
        NewWebSocket.prototype = OriginalWebSocket.prototype;
        NewWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
        NewWebSocket.OPEN = OriginalWebSocket.OPEN;
        NewWebSocket.CLOSING = OriginalWebSocket.CLOSING;
        NewWebSocket.CLOSED = OriginalWebSocket.CLOSED;
        window.WebSocket = NewWebSocket;
      } + ")(" + ${JSON.stringify(JSON.stringify(urlPattern))} + ");";
      (document.documentElement || document).appendChild(s);
      s.remove();
    })();
  `;
  await browser.tabs.executeScript(tabId, { code: combinedCode });

  // Count already-open connections that match. Note these were constructed
  // before the hook installed, so they will NOT emit frames until reload.
  const regex = new RegExp(urlPattern, "i");
  let matched = 0;
  for (const url of trackedWsConnections.keys()) {
    if (regex.test(url)) matched++;
  }

  return {
    matched_connections: matched,
    note: "Only WebSockets opened after capture starts are captured; reload the page to capture pre-existing connections.",
  };
}

async function handleStopWsCapture(msg) {
  const urlPattern = msg.url_pattern;
  wsCapturingPatterns.delete(urlPattern);

  const tab = await getTargetTab();
  if (!tab) return { status: "stopped" };

  const code = `
    (function() {
      var s = document.createElement("script");
      s.textContent = "(" + function(pattern) {
        var cap = window.__browserBridgeWsCapture;
        if (!cap) return;
        cap.patterns = cap.patterns.filter(function(p) { return p !== pattern; });
        if (cap.patterns.length === 0) {
          window.WebSocket = cap.original;
          delete window.__browserBridgeWsCapture;
        }
      } + ")(" + ${JSON.stringify(JSON.stringify(urlPattern))} + ");";
      (document.documentElement || document).appendChild(s);
      s.remove();
    })();
  `;
  await browser.tabs.executeScript(tab.id, { code });

  return { status: "stopped" };
}

// Listen for WS frame messages relayed from content scripts via runtime messaging
// AND messages from the popup UI
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "xhr_body_relay") {
    if (capabilities.network) {
      correlateXhrBody(msg, sender.tab ? sender.tab.id : -1);
    }
    return;
  }

  if (msg.type === "ws_frame_relay") {
    // Gate on capability and an active matching pattern so frames from sockets
    // that were captured before stop_ws_capture (whose live send/message hooks
    // keep firing) are dropped instead of forwarded after capture stopped.
    if (!capabilities.websocket) return;
    const url = msg.connection_url || "";
    let matches = false;
    for (const p of wsCapturingPatterns) {
      try { if (new RegExp(p, "i").test(url)) { matches = true; break; } } catch {}
    }
    if (!matches) return;
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
    xhrBodyBuffer.clear();
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
        // Update webRequest listeners and XHR hook based on new capability state
        if (name === "network" || name === "websocket") {
          updateListenerRegistrations();
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
    monitoredTabId = msg.tabId;
    // Eagerly inject console capture into the newly selected tab (matches the
    // console-toggle and startup paths); otherwise logs before the next
    // navigation are lost.
    if (capabilities.console && monitoredTabId !== null) {
      injectConsoleCapture(monitoredTabId).catch(() => {});
    }
    sendResponse({ ok: true, monitoredTabId });
    return;
  }
});

// ─── Init ────────────────────────────────────────────────────────────────────

loadCapabilities().then(async () => {
  connect();

  // Auto-select the active tab on startup so we never monitor all tabs
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs.length > 0) {
      monitoredTabId = tabs[0].id;
    }
  } catch {
    // Will remain null until a tab is selected via popup
  }

  // Register webRequest listeners and XHR hook based on persisted capabilities
  updateListenerRegistrations();

  // Eagerly inject console capture into the monitored tab on startup
  if (capabilities.console && monitoredTabId !== null) {
    try {
      await injectConsoleCapture(monitoredTabId);
    } catch {
      // May fail on privileged pages — ignore
    }
  }
});
