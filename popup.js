const PROVIDERS = {
  claude:       { label: "Claude",     color: "#8b6fff" },
  openai:       { label: "ChatGPT",    color: "#19c37d" },
  deepseek:     { label: "DeepSeek",  color: "#4d9fff" },
  huggingface:  { label: "HF / Llama", color: "#ffcc00" },
};

const captureBtn         = document.getElementById("captureBtn");
const statusEl           = document.getElementById("status");
const statusText         = document.getElementById("statusText");
const resultCard         = document.getElementById("resultCard");
const verdictBar         = document.getElementById("verdictBar");
const verdictBadge       = document.getElementById("verdictBadge");
const verdictSummary     = document.getElementById("verdictSummary");
const resultBody         = document.getElementById("resultBody");
const historySection     = document.getElementById("historySection");
const historyList        = document.getElementById("historyList");
const settingsToggle     = document.getElementById("settingsToggle");
const settingsPanel      = document.getElementById("settingsPanel");
const mainPanel          = document.getElementById("mainPanel");
const headerProviderLabel= document.getElementById("headerProviderLabel");
const providerPillDot    = document.getElementById("providerPillDot");
const providerPillLabel  = document.getElementById("providerPillLabel");

let isSelecting = false;

async function init() {
  // Wire up HuggingFace custom model input
  const hfSelect = document.getElementById("huggingface-model");
  const hfCustom = document.getElementById("huggingface-model-custom");
  if (hfSelect) {
    hfSelect.addEventListener("change", () => {
      hfCustom.style.display = hfSelect.value === "custom" ? "block" : "none";
    });
  }

  const stored = await chrome.storage.local.get(null);

  // Restore saved keys and models for each provider
  for (const pid of Object.keys(PROVIDERS)) {
    const keyEl   = document.getElementById(`${pid}-key`);
    const modelEl = document.getElementById(`${pid}-model`);
    if (keyEl   && stored[`${pid}_key`])   keyEl.value = stored[`${pid}_key`];
    if (modelEl && stored[`${pid}_model`]) {
      const savedModel = stored[`${pid}_model`];
      const optionExists = [...(modelEl.options || [])].some((o) => o.value === savedModel);
      if (optionExists) {
        modelEl.value = savedModel;
      } else if (pid === "huggingface") {
        modelEl.value = "custom";
        const customEl = document.getElementById("huggingface-model-custom");
        if (customEl) {
          customEl.value = savedModel;
          customEl.style.display = "block";
        }
      } else {
        modelEl.value = savedModel;
      }
    }
  }

  if (stored.activeProvider) {
    updateActiveProvider(stored.activeProvider);
    markUseBtn(stored.activeProvider);
    renderHistory(stored.history || []);
  } else {
    openSettings();
  }
}

function openSettings() {
  settingsPanel.classList.add("visible");
  mainPanel.style.display = "none";
  historySection.classList.remove("visible");
}

async function closeSettings() {
  settingsPanel.classList.remove("visible");
  mainPanel.style.display = "block";

  // Restore history when returning to main panel
  const { history = [] } = await chrome.storage.local.get("history");
  renderHistory(history);
}

settingsToggle.addEventListener("click", () => {
  if (settingsPanel.classList.contains("visible")) {
    closeSettings();
  } else {
    openSettings();
  }
});

document.getElementById("providerPill").addEventListener("click", () => openSettings());

document.getElementById("providerTabs").addEventListener("click", (e) => {
  const tab = e.target.closest("[data-provider]");
  if (!tab) return;
  const pid = tab.dataset.provider;

  document.querySelectorAll(".provider-tab").forEach((t) => t.classList.remove("active"));
  document.querySelectorAll(".provider-form").forEach((f) => f.classList.remove("active"));
  tab.classList.add("active");
  document.getElementById(`form-${pid}`).classList.add("active");
});

document.querySelectorAll("[data-save]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const pid    = btn.dataset.save;
    const keyEl  = document.getElementById(`${pid}-key`);
    const modelEl= document.getElementById(`${pid}-model`);
    const key    = keyEl?.value.trim();

    let model = modelEl?.value.trim();
    if (pid === "huggingface" && model === "custom") {
      const customEl = document.getElementById("huggingface-model-custom");
      model = customEl?.value.trim() || "";
      if (!model) {
        setStatus("Enter a custom model ID", "error");
        await closeSettings();
        return;
      }
      if (!model.includes(":")) model += ":auto";
    }

    if (!key) {
      setStatus("API key cannot be empty", "error");
      await closeSettings();
      return;
    }

    const toSave = {};
    toSave[`${pid}_key`]   = key;
    if (model) toSave[`${pid}_model`] = model;
    await chrome.storage.local.set(toSave);

    setStatus(`${PROVIDERS[pid].label} credentials saved ✓`, "success");
    await closeSettings();
  });
});

document.querySelectorAll("[data-use]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const pid = btn.dataset.use;

    // Accept either the currently-typed key or a previously saved one
    const keyEl = document.getElementById(`${pid}-key`);
    const typedKey = keyEl?.value.trim();
    const stored = await chrome.storage.local.get(`${pid}_key`);
    const key = typedKey || stored[`${pid}_key`];

    if (!key) {
      setStatus(`Enter + save a key for ${PROVIDERS[pid].label} first`, "error");
      return; // stay in settings so user can type the key
    }

    await chrome.storage.local.set({ activeProvider: pid });
    updateActiveProvider(pid);
    markUseBtn(pid);
    setStatus(`Now using ${PROVIDERS[pid].label}`, "success");
    await closeSettings();
  });
});

function updateActiveProvider(pid) {
  const p = PROVIDERS[pid];
  if (!p) return;
  headerProviderLabel.textContent = `Using ${p.label}`;
  providerPillDot.style.background = p.color;
  providerPillLabel.textContent = p.label;
}

function markUseBtn(activePid) {
  document.querySelectorAll("[data-use]").forEach((btn) => {
    const isActive = btn.dataset.use === activePid;
    btn.classList.toggle("is-active", isActive);
    btn.textContent = isActive ? "✓ Currently active" : "Set as active provider";
  });
}

captureBtn.addEventListener("click", async () => {
  const { activeProvider } = await chrome.storage.local.get("activeProvider");
  if (!activeProvider) {
    openSettings();
    return;
  }

  const keyData = await chrome.storage.local.get(`${activeProvider}_key`);
  if (!keyData[`${activeProvider}_key`]) {
    openSettings();
    return;
  }

  if (isSelecting) return;
  isSelecting = true;
  captureBtn.disabled = true;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.dispatchEvent(new CustomEvent("factcheck:activate")),
    });
    setStatus("Draw a box around the content", "selecting");
    window.close();
  } catch (err) {
    setStatus("Cannot run on this page", "error");
    captureBtn.disabled = false;
    isSelecting = false;
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "factcheck:result") showResult(msg.data);
  if (msg.type === "factcheck:error")  setStatus(msg.error, "error");
  if (msg.type === "factcheck:status") setStatus(msg.text, msg.style || "loading");
});

function showResult(data) {
  captureBtn.disabled = false;
  isSelecting = false;
  const overall = (data.overall_verdict || "unverifiable").toLowerCase();
  setStatus("Fact-check complete ✓", "success");

  verdictBar.className = `verdict-bar ${overall}`;
  verdictBadge.textContent = labelFor(overall);
  verdictSummary.textContent = data.summary || "";

  resultBody.innerHTML = "";
  (data.claims || []).forEach((claim) => {
    const v = (claim.verdict || "unverifiable").toLowerCase();
    const div = document.createElement("div");
    div.className = "claim-item";
    div.innerHTML = `
      <div class="claim-text">"${escHtml(claim.claim)}"</div>
      <div class="claim-verdict ${v}">${labelFor(v)}</div>
      <div class="claim-explanation">${escHtml(claim.explanation)}</div>
    `;
    resultBody.appendChild(div);
  });

  resultCard.classList.add("visible");
  saveHistory({ overall, summary: data.summary, time: Date.now() });
}

function labelFor(v) {
  return (
    {
      true:         "✓ Supported",
      false:        "✗ False",
      misleading:   "⚠ Misleading",
      unverifiable: "? Unverifiable",
    }[v] || v
  );
}

function setStatus(text, type = "") {
  statusText.textContent = text;
  statusEl.className = `status ${type}`;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function saveHistory(entry) {
  const { history = [] } = await chrome.storage.local.get("history");
  history.unshift(entry);
  if (history.length > 10) history.pop();
  await chrome.storage.local.set({ history });
  renderHistory(history);
}

function renderHistory(history) {
  if (!history || !history.length) return;
  historySection.classList.add("visible");
  historyList.innerHTML = "";
  history.slice(0, 5).forEach((item) => {
    const div = document.createElement("div");
    div.className = "history-item";
    div.innerHTML = `
      <div class="history-dot ${item.overall}"></div>
      <span class="history-snippet">${escHtml(item.summary || "No summary")}</span>
      <span class="history-time">${timeAgo(item.time)}</span>
    `;
    historyList.appendChild(div);
  });
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)    return "now";
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

init();