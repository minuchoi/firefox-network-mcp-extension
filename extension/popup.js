// Popup script: communicates with background.js to display and toggle capabilities

const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const toggles = document.querySelectorAll("input[data-capability]");
const tabSelect = document.getElementById("tab-select");
const capabilitiesDiv = document.getElementById("capabilities");
const connectionInfo = document.getElementById("connection-info");
const wsCaptureIndicator = document.getElementById("ws-capture-indicator");
const wsCaptureText = document.getElementById("ws-capture-text");
const statRequests = document.getElementById("stat-requests");
const statWs = document.getElementById("stat-ws");
const statConsole = document.getElementById("stat-console");
const clearBtn = document.getElementById("clear-btn");

function updateUI(response) {
  if (response.connected !== undefined) {
    if (response.connected) {
      statusDot.classList.add("connected");
      statusText.textContent = "Connected";
      capabilitiesDiv.classList.remove("disabled");
      tabSelect.disabled = false;
      for (const toggle of toggles) toggle.disabled = false;
    } else {
      statusDot.classList.remove("connected");
      statusText.textContent = "Disconnected";
      capabilitiesDiv.classList.add("disabled");
      tabSelect.disabled = true;
      for (const toggle of toggles) toggle.disabled = true;
    }
  }

  if (response.capabilities) {
    for (const toggle of toggles) {
      const name = toggle.dataset.capability;
      if (name in response.capabilities) {
        toggle.checked = response.capabilities[name];
      }
    }
  }

  if (response.wsUrl) {
    connectionInfo.textContent = response.wsUrl;
  }

  if (response.stats) {
    statRequests.textContent = response.stats.pendingRequests;
    statWs.textContent = response.stats.trackedWsConnections;
    statConsole.textContent = response.stats.consoleInjectedTabs;

    const patterns = response.stats.wsCapturingPatterns || [];
    if (patterns.length > 0) {
      wsCaptureIndicator.classList.add("active");
      wsCaptureText.textContent = `WS capture: ${patterns.join(", ")}`;
    } else {
      wsCaptureIndicator.classList.remove("active");
    }
  }
}

function truncate(str, maxLen) {
  return str.length > maxLen ? str.slice(0, maxLen) + "\u2026" : str;
}

function loadTabs() {
  browser.runtime.sendMessage({ type: "get_tabs" }).then((response) => {
    if (!response || !response.tabs) return;
    const { tabs, monitoredTabId } = response;

    // Clear existing options except "All Tabs"
    tabSelect.length = 1;

    for (const tab of tabs) {
      const opt = document.createElement("option");
      opt.value = String(tab.id);
      const label = tab.title || tab.url || `Tab ${tab.id}`;
      opt.textContent = truncate(label, 40);
      opt.title = tab.title || tab.url;
      tabSelect.appendChild(opt);
    }

    // Validate monitored tab still exists in the list
    const valueToSet = monitoredTabId === null ? "all" : String(monitoredTabId);
    const validValues = new Set(Array.from(tabSelect.options).map((o) => o.value));
    tabSelect.value = validValues.has(valueToSet) ? valueToSet : "all";
  }).catch((err) => {
    console.error("[BrowserBridge Popup] Failed to load tabs:", err);
  });
}

function refreshStatus() {
  browser.runtime.sendMessage({ type: "get_status" }).then((response) => {
    if (response) {
      updateUI(response);
    }
  }).catch((err) => {
    console.error("[BrowserBridge Popup] Failed to get status:", err);
    updateUI({ connected: false });
  });
}

// Initial load
refreshStatus();
loadTabs();

// Refresh stats periodically while popup is open
const statsInterval = setInterval(refreshStatus, 2000);
window.addEventListener("unload", () => clearInterval(statsInterval));

// Handle tab selector changes
tabSelect.addEventListener("change", () => {
  const value = tabSelect.value;
  const tabId = value === "all" ? null : Number(value);

  browser.runtime.sendMessage({
    type: "set_monitored_tab",
    tabId,
  }).catch((err) => {
    console.error("[BrowserBridge Popup] Failed to set monitored tab:", err);
  });
});

// Handle toggle changes
for (const toggle of toggles) {
  toggle.addEventListener("change", () => {
    const name = toggle.dataset.capability;
    const enabled = toggle.checked;

    browser.runtime.sendMessage({
      type: "set_capability",
      name,
      enabled,
    }).then((response) => {
      if (response && response.capabilities) {
        updateUI({ capabilities: response.capabilities });
      }
    }).catch((err) => {
      console.error("[BrowserBridge Popup] Failed to set capability:", err);
      // Revert toggle on error
      toggle.checked = !enabled;
    });
  });
}

// Handle clear button
clearBtn.addEventListener("click", () => {
  browser.runtime.sendMessage({ type: "clear_data" }).then(() => {
    refreshStatus();
  }).catch((err) => {
    console.error("[BrowserBridge Popup] Failed to clear data:", err);
  });
});
