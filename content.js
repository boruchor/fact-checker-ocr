// Handles area selection overlay and result toast display

(function () {
  "use strict";

  if (window.__factcheckInjected) return;
  window.__factcheckInjected = true;

  let overlay, selection, hint, confirmBtn, cancelBtn, sizeLabel, loadingOverlay;
  let startX, startY, isDrawing = false, selectionRect = null;

  window.addEventListener("factcheck:activate", activate);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "factcheck:activate") activate();
    if (msg.type === "factcheck:result") showResultToast(msg.data);
    if (msg.type === "factcheck:loading") updateLoadingText(msg.text);
    if (msg.type === "factcheck:error") showError(msg.error);
    if (msg.type === "factcheck:needtext") showManualTextPrompt(msg.imageDataUrl, msg.message);
    sendResponse({ ok: true });
    return true;
  });

  function buildOverlay() {
    // Clean up any existing elements
    [
      "factcheck-overlay",
      "factcheck-hint",
      "factcheck-confirm-btn",
      "factcheck-cancel-btn",
      "factcheck-size-label",
      "factcheck-loading-overlay",
    ].forEach((id) => document.getElementById(id)?.remove());

    // Main overlay (fullscreen darkening + crosshair)
    overlay = document.createElement("div");
    overlay.id = "factcheck-overlay";

    // Selection rectangle drawn inside the overlay
    selection = document.createElement("div");
    selection.id = "factcheck-selection";
    overlay.appendChild(selection);

    // Size label inside overlay
    sizeLabel = document.createElement("div");
    sizeLabel.id = "factcheck-size-label";
    overlay.appendChild(sizeLabel);

    // Hint bar — fixed, outside overlay so it doesn't interfere
    hint = document.createElement("div");
    hint.id = "factcheck-hint";
    hint.innerHTML =
      "Click and drag to select area &nbsp;&middot;&nbsp; <span>ESC</span> to cancel &nbsp;&middot;&nbsp; <span>Enter</span> to confirm";

    // Confirm button — FIXED position so it renders on top of everything
    confirmBtn = document.createElement("button");
    confirmBtn.id = "factcheck-confirm-btn";
    confirmBtn.textContent = "✓ Fact-Check This";

    // Cancel button — FIXED position
    cancelBtn = document.createElement("button");
    cancelBtn.id = "factcheck-cancel-btn";
    cancelBtn.textContent = "Cancel";

    // Loading overlay
    loadingOverlay = document.createElement("div");
    loadingOverlay.id = "factcheck-loading-overlay";
    loadingOverlay.innerHTML =
      '<div id="factcheck-loading-card">' +
      '<div id="factcheck-loading-spinner"></div>' +
      '<div id="factcheck-loading-text">Capturing screenshot…</div>' +
      "</div>";

    document.body.appendChild(overlay);
    document.body.appendChild(hint);
    document.body.appendChild(confirmBtn);
    document.body.appendChild(cancelBtn);
    document.body.appendChild(loadingOverlay);

    // Overlay handles drawing
    overlay.addEventListener("mousedown", onMouseDown);
    overlay.addEventListener("mousemove", onMouseMove);
    overlay.addEventListener("mouseup", onMouseUp);

    // Prevent mousedown on buttons from propagating to overlay (which would restart drawing)
    confirmBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    cancelBtn.addEventListener("mousedown", (e) => e.stopPropagation());

    confirmBtn.addEventListener("click", confirmCapture);
    cancelBtn.addEventListener("click", deactivate);

    document.addEventListener("keydown", onKeyDown);
  }

  function activate() {
    buildOverlay();
    overlay.style.display = "block";
    hint.style.display = "block";
    document.body.style.overflow = "hidden";
  }

  function deactivate() {
    overlay?.remove();
    hint?.remove();
    confirmBtn?.remove();
    cancelBtn?.remove();
    // sizeLabel is a child of overlay, removed with it
    overlay = selection = hint = confirmBtn = cancelBtn = sizeLabel = null;
    document.body.style.overflow = "";
    isDrawing = false;
    selectionRect = null;
    document.removeEventListener("keydown", onKeyDown);
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    isDrawing = true;
    startX = e.clientX;
    startY = e.clientY;
    selectionRect = null;

    if (selection) selection.style.display = "none";
    if (confirmBtn) {
      confirmBtn.style.display = "none";
      confirmBtn.style.opacity = "0";
    }
    if (cancelBtn) {
      cancelBtn.style.display = "none";
      cancelBtn.style.opacity = "0";
    }
    if (sizeLabel) sizeLabel.style.display = "none";
  }

  function onMouseMove(e) {
    if (!isDrawing) return;

    const x = Math.min(e.clientX, startX);
    const y = Math.min(e.clientY, startY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);

    if (selection) {
      selection.style.display = "block";
      selection.style.left = x + "px";
      selection.style.top = y + "px";
      selection.style.width = w + "px";
      selection.style.height = h + "px";
    }

    if (sizeLabel && w > 40 && h > 20) {
      sizeLabel.style.display = "block";
      sizeLabel.style.left = x + 4 + "px";
      sizeLabel.style.top = y + 4 + "px";
      sizeLabel.textContent = Math.round(w) + " × " + Math.round(h);
    }
  }

  function onMouseUp(e) {
    if (!isDrawing) return;
    isDrawing = false;

    const x = Math.min(e.clientX, startX);
    const y = Math.min(e.clientY, startY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);

    if (w < 20 || h < 20) {
      if (selection) selection.style.display = "none";
      if (sizeLabel) sizeLabel.style.display = "none";
      return;
    }

    selectionRect = { x, y, width: w, height: h };

    positionButtons(x, y, w, h);

    if (sizeLabel) sizeLabel.style.display = "none";
    if (hint) hint.style.display = "none";
  }

  function positionButtons(x, y, w, h) {
    const BTN_HEIGHT = 36;
    const CONFIRM_WIDTH = 150;
    const CANCEL_WIDTH = 80;
    const GAP = 8;
    const MARGIN = 8;

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Try to place buttons below the selection; if no room, place above
    let btnTop = y + h + 10;
    if (btnTop + BTN_HEIGHT > vh - MARGIN) {
      btnTop = Math.max(MARGIN, y - BTN_HEIGHT - 10);
    }

    // Right-align to the right edge of selection, clamped to viewport
    let confirmLeft = Math.min(x + w - CONFIRM_WIDTH, vw - CONFIRM_WIDTH - MARGIN);
    confirmLeft = Math.max(MARGIN, confirmLeft);

    let cancelLeft = Math.min(x + w - CONFIRM_WIDTH - GAP - CANCEL_WIDTH, vw - CONFIRM_WIDTH - GAP - CANCEL_WIDTH - MARGIN);
    cancelLeft = Math.max(MARGIN, cancelLeft);

    if (confirmBtn) {
      confirmBtn.style.display = "block";
      confirmBtn.style.opacity = "1";
      confirmBtn.style.left = confirmLeft + "px";
      confirmBtn.style.top = btnTop + "px";
    }

    if (cancelBtn) {
      cancelBtn.style.display = "block";
      cancelBtn.style.opacity = "1";
      cancelBtn.style.left = cancelLeft + "px";
      cancelBtn.style.top = btnTop + "px";
    }
  }

  function onKeyDown(e) {
    if (e.key === "Escape") {
      deactivate();
    }
    if (e.key === "Enter" && selectionRect) {
      e.preventDefault();
      confirmCapture();
    }
  }

  async function confirmCapture() {
    if (!selectionRect) return;

    const rect = {
      x: selectionRect.x + window.scrollX,
      y: selectionRect.y + window.scrollY,
      width: selectionRect.width,
      height: selectionRect.height,
      viewX: selectionRect.x,
      viewY: selectionRect.y,
      devicePixelRatio: window.devicePixelRatio || 1,
    };

    // Hide the overlay BEFORE capturing so it doesn't appear in screenshot
    deactivate();

    // Give the browser time to repaint without the overlay before screenshot
    await sleep(150);

    updateLoadingText("Capturing screenshot…");

    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await sendMessageToBackground({ type: "factcheck:capture", rect });
        return;
      } catch (err) {
        lastErr = err;
        if (err.message === "INVALIDATED") break;
        await sleep(300);
      }
    }

    if (lastErr?.message === "INVALIDATED") {
      showError(
        "Extension was updated or reloaded. Please refresh this page and try again."
      );
    } else {
      showError(
        lastErr?.message ||
          "Extension background did not respond. Try reloading the page."
      );
    }
  }

  function sendMessageToBackground(msg) {
    return new Promise((resolve, reject) => {
      if (!chrome.runtime?.id) {
        reject(new Error("INVALIDATED"));
        return;
      }
      try {
        chrome.runtime.sendMessage(msg, (response) => {
          if (chrome.runtime.lastError) {
            const m = chrome.runtime.lastError.message || "";
            reject(
              new Error(
                m.includes("invalidated") || m.includes("context")
                  ? "INVALIDATED"
                  : m
              )
            );
          } else {
            resolve(response);
          }
        });
      } catch (e) {
        reject(new Error("INVALIDATED"));
      }
    });
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function updateLoadingText(text) {
    let lo = document.getElementById("factcheck-loading-overlay");
    if (!lo) {
      lo = document.createElement("div");
      lo.id = "factcheck-loading-overlay";
      lo.innerHTML =
        '<div id="factcheck-loading-card">' +
        '<div id="factcheck-loading-spinner"></div>' +
        '<div id="factcheck-loading-text"></div>' +
        "</div>";
      document.body.appendChild(lo);
      loadingOverlay = lo;
    }
    const el = document.getElementById("factcheck-loading-text");
    if (el) el.textContent = text;
    lo.classList.add("visible");
  }

  function hideLoading() {
    document.getElementById("factcheck-loading-overlay")?.classList.remove("visible");
  }

  function showError(msg) {
    hideLoading();
    document.getElementById("factcheck-error-toast")?.remove();

    const toast = document.createElement("div");
    toast.id = "factcheck-error-toast";
    toast.style.cssText = [
      "position:fixed",
      "top:24px",
      "right:24px",
      "z-index:2147483647",
      "background:#2b0d0d",
      "border:1px solid #5c1a1a",
      "border-radius:12px",
      "padding:14px 18px",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "font-size:13px",
      "color:#e05555",
      "max-width:320px",
      "line-height:1.5",
      "box-shadow:0 10px 30px rgba(0,0,0,0.5)",
      "cursor:pointer",
    ].join(";");
    toast.textContent = "⚠ " + msg;
    toast.addEventListener("click", () => toast.remove());
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 8000);
  }

  function showManualTextPrompt(imageDataUrl, message) {
    hideLoading();
    document.getElementById("factcheck-manual-prompt")?.remove();

    const wrap = document.createElement("div");
    wrap.id = "factcheck-manual-prompt";
    wrap.style.cssText = [
      "position:fixed",
      "top:24px",
      "right:24px",
      "z-index:2147483647",
      "background:#0f0f10",
      "border:1px solid #2a2a2e",
      "border-radius:14px",
      "padding:16px",
      "width:320px",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "box-shadow:0 20px 60px rgba(0,0,0,0.5)",
    ].join(";");

    wrap.innerHTML = `
      <div style="font-size:12px;color:#888;margin-bottom:10px;line-height:1.5">${escHtml(message)}</div>
      <textarea id="factcheck-manual-textarea"
        style="width:100%;height:100px;background:#1a1a1c;border:1px solid #2a2a2e;border-radius:7px;
               color:#e8e6e0;font-size:12px;padding:8px;resize:vertical;outline:none;
               font-family:inherit;box-sizing:border-box"
        placeholder="Paste the text here…"></textarea>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button id="factcheck-manual-submit"
          style="flex:1;padding:8px;background:#5b4fcf;border:none;border-radius:7px;
                 color:#fff;font-size:12px;font-weight:600;cursor:pointer">
          Fact-Check
        </button>
        <button id="factcheck-manual-cancel"
          style="padding:8px 12px;background:#1a1a1c;border:1px solid #2a2a2e;border-radius:7px;
                 color:#888;font-size:12px;cursor:pointer">
          Cancel
        </button>
      </div>
    `;

    document.body.appendChild(wrap);

    document.getElementById("factcheck-manual-submit").addEventListener("click", async () => {
      const text = document.getElementById("factcheck-manual-textarea").value.trim();
      if (!text) return;
      wrap.remove();
      updateLoadingText("Fact-checking text…");
      try {
        await sendMessageToBackground({ type: "factcheck:manualtext", text });
      } catch (err) {
        showError(err.message || "Failed to send text for fact-checking.");
      }
    });

    document.getElementById("factcheck-manual-cancel").addEventListener("click", () => {
      wrap.remove();
    });
  }

  function showResultToast(data) {
    hideLoading();
    document.getElementById("factcheck-result-toast")?.remove();

    const overall = (data.overall_verdict || "unverifiable").toLowerCase();
    const labels = {
      true: "✓ Supported",
      false: "✗ False",
      misleading: "⚠ Misleading",
      unverifiable: "? Unverifiable",
    };

    const toast = document.createElement("div");
    toast.id = "factcheck-result-toast";
    toast.classList.add("visible");

    const claimsHtml = (data.claims || [])
      .map((c) => {
        const v = (c.verdict || "unverifiable").toLowerCase();
        return (
          '<div class="factcheck-claim">' +
          '<div class="factcheck-claim-text">\u201c' + escHtml(c.claim) + "\u201d</div>" +
          '<div class="factcheck-claim-verdict ' + v + '">' + (labels[v] || v) + "</div>" +
          '<div class="factcheck-claim-explanation">' + escHtml(c.explanation) + "</div>" +
          "</div>"
        );
      })
      .join("");

    toast.innerHTML =
      '<div class="factcheck-toast-header ' + overall + '">' +
      '<span class="factcheck-verdict-pill">' + (labels[overall] || overall) + "</span>" +
      '<span class="factcheck-toast-summary">' + escHtml(data.summary || "") + "</span>" +
      '<button class="factcheck-toast-close" id="factcheck-toast-close">\u00d7</button>' +
      "</div>" +
      '<div class="factcheck-toast-body">' +
      (claimsHtml ||
        '<div style="color:#555;font-size:12px;padding:4px 0">No specific claims detected.</div>') +
      "</div>";

    document.body.appendChild(toast);
    document.getElementById("factcheck-toast-close")?.addEventListener("click", () => toast.remove());
    setTimeout(() => toast.remove(), 30000);
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
})();