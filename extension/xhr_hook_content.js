// Content script: sets up the DOM attribute relay AND injects the page-world
// XHR/fetch hook via <script> tag. Dynamically registered via
// browser.contentScripts.register() at document_start for guaranteed
// pre-page-script timing. Only active when network capability is enabled.
(function() {
  // --- Relay: content script context, bridges DOM attribute -> runtime.sendMessage ---
  // Uses dispatchEvent(new Event()) as a synchronous signal, with data passed via a
  // hidden DOM element attribute. This avoids both:
  //   - postMessage being async (macrotask — races with navigation)
  //   - CustomEvent.detail being invisible through Firefox Xray wrappers
  if (!window.__browserBridgeXhrRelay) {
    window.__browserBridgeXhrRelay = true;
    document.addEventListener("__bb_body", function() {
      try {
        var el = document.getElementById("__bb_data");
        if (!el) return;
        var raw = el.getAttribute("data-body");
        if (!raw) return;
        el.removeAttribute("data-body");
        var data = JSON.parse(raw);
        browser.runtime.sendMessage({
          type: "xhr_body_relay",
          method: data.method,
          url: data.url,
          timestamp: data.timestamp,
          status: data.status,
          response_body: data.response_body,
        });
      } catch(e) {}
    });
  }

  // --- Create hidden data element for page -> content script communication ---
  if (!document.getElementById("__bb_data")) {
    var d = document.createElement("div");
    d.id = "__bb_data";
    d.style.display = "none";
    (document.documentElement || document).appendChild(d);
  }

  // --- Inject page-world hook via <script> tag ---
  if (!document.getElementById("__browserBridgeXhrHook")) {
    var s = document.createElement("script");
    s.id = "__browserBridgeXhrHook";
    s.textContent = '(' + function() {
      if (window.__browserBridgeXhrCapture) return;
      window.__browserBridgeXhrCapture = true;

      var MAX_BODY = 1048576;
      var XHR = XMLHttpRequest.prototype;
      var origOpen = XHR.open;
      var origSend = XHR.send;
      var xhrMeta = new WeakMap();

      XHR.open = function(method, url) {
        // Resolve to absolute URL to match webRequest's full URLs
        var resolvedUrl;
        try { resolvedUrl = new URL(typeof url === "string" ? url : String(url), location.href).href; }
        catch(e) { resolvedUrl = typeof url === "string" ? url : String(url); }
        xhrMeta.set(this, { method: method, url: resolvedUrl, timestamp: Date.now() });
        return origOpen.apply(this, arguments);
      };

      XHR.send = function() {
        var meta = xhrMeta.get(this);
        // Only intercept mutating methods — GET/HEAD are handled by filterResponseData
        var um = meta && meta.method.toUpperCase();
        if (meta && um !== "GET" && um !== "HEAD") {
          var xhr = this;
          xhr.addEventListener("load", function() {
            try {
              // Extract body based on responseType — responseText throws for
              // non-"" / non-"text" types (arraybuffer, blob, document, json)
              var body;
              var rt = xhr.responseType;
              if (!rt || rt === "" || rt === "text") {
                body = xhr.responseText;
              } else if (rt === "json") {
                body = xhr.response != null ? JSON.stringify(xhr.response) : null;
              } else if (rt === "document") {
                body = xhr.response ? new XMLSerializer().serializeToString(xhr.response) : null;
              } else {
                // arraybuffer, blob — skip, not text-representable
                body = null;
              }
              if (body && body.length > 0) {
                var el = document.getElementById("__bb_data");
                if (el) {
                  el.setAttribute("data-body", JSON.stringify({
                    method: meta.method,
                    url: meta.url,
                    timestamp: meta.timestamp,
                    status: xhr.status,
                    response_body: body.length > MAX_BODY ? body.slice(0, MAX_BODY) : body,
                  }));
                  document.dispatchEvent(new Event("__bb_body"));
                }
              }
            } catch(e) {}
          });
        }
        return origSend.apply(this, arguments);
      };

      var origFetch = window.fetch;
      if (origFetch) {
        window.fetch = function(input, init) {
          var method = (init && init.method) || "GET";
          var rawUrl = typeof input === "string" ? input : (input && input.url ? input.url : String(input));
          var url;
          try { url = new URL(rawUrl, location.href).href; } catch(e) { url = rawUrl; }
          var timestamp = Date.now();
          var upperMethod = method.toUpperCase();
          // Only intercept mutating methods — GET/HEAD bodies are captured by
          // filterResponseData or the cache fallback, so skip them entirely
          // to avoid cloning/reading every response on every page.
          if (upperMethod === "GET" || upperMethod === "HEAD") {
            return origFetch.apply(this, arguments);
          }
          return origFetch.apply(this, arguments).then(function(response) {
            var cloned = response.clone();
            // Inline the body read so the caller's await/then cannot resolve
            // (and navigate away) before we capture the body.
            return cloned.text().then(function(text) {
              if (text && text.length > 0) {
                var el = document.getElementById("__bb_data");
                if (el) {
                  el.setAttribute("data-body", JSON.stringify({
                    method: upperMethod,
                    url: url,
                    timestamp: timestamp,
                    status: cloned.status,
                    response_body: text.length > MAX_BODY ? text.slice(0, MAX_BODY) : text,
                  }));
                  document.dispatchEvent(new Event("__bb_body"));
                }
              }
              return response;
            }).catch(function() { return response; });
          });
        };
      }
    } + ')();';
    (document.documentElement || document).appendChild(s);
    s.remove();
  }
})();
