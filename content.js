// content.js — FactCheck AI
// Handles area selection overlay and result toast display

(function () {
  'use strict';

  // Guard: only inject once per page load
  if (window.__factcheckInjected) return;
  window.__factcheckInjected = true;

  let overlay, selection, hint, confirmBtn, cancelBtn, sizeLabel, loadingOverlay;
  let startX, startY, isDrawing = false, selectionRect = null;

  // ── Listen for activation ─────────────────────────────────────────────────

  window.addEventListener('factcheck:activate', activate);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'factcheck:activate') activate();
    if (msg.type === 'factcheck:result')   showResultToast(msg.data);
    if (msg.type === 'factcheck:loading')  updateLoadingText(msg.text);
    if (msg.type === 'factcheck:error')    showError(msg.error);
    sendResponse({ ok: true });
    return true;
  });

  // ── Build overlay DOM ─────────────────────────────────────────────────────

  function buildOverlay() {
    // Clean up any stale elements from a previous activation
    ['factcheck-overlay', 'factcheck-hint', 'factcheck-confirm-btn',
     'factcheck-cancel-btn', 'factcheck-size-label', 'factcheck-loading-overlay']
      .forEach(id => document.getElementById(id)?.remove());

    // ── Overlay: full-screen dimmer, captures all mouse events
    overlay = document.createElement('div');
    overlay.id = 'factcheck-overlay';

    // ── Selection rect: sits inside overlay (visual only)
    selection = document.createElement('div');
    selection.id = 'factcheck-selection';
    overlay.appendChild(selection);

    // ── Size label: inside overlay
    sizeLabel = document.createElement('div');
    sizeLabel.id = 'factcheck-size-label';
    overlay.appendChild(sizeLabel);

    // ── Hint bar: OUTSIDE overlay so it doesn't eat mouse events
    hint = document.createElement('div');
    hint.id = 'factcheck-hint';
    hint.innerHTML = 'Click and drag to select area &nbsp;&middot;&nbsp; <span>ESC</span> to cancel';

    // ── Confirm / Cancel buttons: OUTSIDE overlay — critical fix
    // If they're inside the overlay div, clicking them fires mousedown on the
    // overlay first, which resets selectionRect before the click handler runs.
    confirmBtn = document.createElement('button');
    confirmBtn.id = 'factcheck-confirm-btn';
    confirmBtn.textContent = '\u2713 Fact-Check This';

    cancelBtn = document.createElement('button');
    cancelBtn.id = 'factcheck-cancel-btn';
    cancelBtn.textContent = 'Cancel';

    // ── Loading overlay: separate element, NOT torn down by deactivate()
    loadingOverlay = document.createElement('div');
    loadingOverlay.id = 'factcheck-loading-overlay';
    loadingOverlay.innerHTML =
      '<div id="factcheck-loading-card">' +
        '<div id="factcheck-loading-spinner"></div>' +
        '<div id="factcheck-loading-text">Capturing screenshot\u2026</div>' +
      '</div>';

    // Append everything to body
    document.body.appendChild(overlay);
    document.body.appendChild(hint);
    document.body.appendChild(confirmBtn);
    document.body.appendChild(cancelBtn);
    document.body.appendChild(loadingOverlay);

    // Mouse events on the overlay only
    overlay.addEventListener('mousedown', onMouseDown);
    overlay.addEventListener('mousemove', onMouseMove);
    overlay.addEventListener('mouseup',   onMouseUp);

    // Prevent confirm/cancel clicks from bubbling to overlay
    confirmBtn.addEventListener('mousedown', e => e.stopPropagation());
    cancelBtn.addEventListener('mousedown',  e => e.stopPropagation());

    confirmBtn.addEventListener('click', confirmCapture);
    cancelBtn.addEventListener('click',  deactivate);

    document.addEventListener('keydown', onKeyDown);
  }

  function activate() {
    buildOverlay();
    overlay.style.display = 'block';
    hint.style.display = 'block';
    document.body.style.overflow = 'hidden';
  }

  // Tear down the selection UI — but keep loadingOverlay alive so the
  // spinner stays visible while the background is processing
  function deactivate() {
    overlay?.remove();
    hint?.remove();
    confirmBtn?.remove();
    cancelBtn?.remove();
    overlay = selection = hint = confirmBtn = cancelBtn = sizeLabel = null;
    document.body.style.overflow = '';
    isDrawing = false;
    selectionRect = null;
    document.removeEventListener('keydown', onKeyDown);
  }

  // ── Mouse events ──────────────────────────────────────────────────────────

  function onMouseDown(e) {
    if (e.button !== 0) return;
    isDrawing = true;
    startX = e.clientX;
    startY = e.clientY;
    selectionRect = null;

    if (selection)  selection.style.display  = 'none';
    if (confirmBtn) confirmBtn.style.display = 'none';
    if (cancelBtn)  cancelBtn.style.display  = 'none';
    if (sizeLabel)  sizeLabel.style.display  = 'none';
  }

  function onMouseMove(e) {
    if (!isDrawing) return;

    const x = Math.min(e.clientX, startX);
    const y = Math.min(e.clientY, startY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);

    if (selection) {
      selection.style.display = 'block';
      selection.style.left    = x + 'px';
      selection.style.top     = y + 'px';
      selection.style.width   = w + 'px';
      selection.style.height  = h + 'px';
    }

    if (sizeLabel && w > 40 && h > 20) {
      sizeLabel.style.display = 'block';
      sizeLabel.style.left    = (x + 4) + 'px';
      sizeLabel.style.top     = (y + 4) + 'px';
      sizeLabel.textContent   = Math.round(w) + ' \u00d7 ' + Math.round(h);
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
      if (selection)  selection.style.display  = 'none';
      if (sizeLabel)  sizeLabel.style.display  = 'none';
      return;
    }

    selectionRect = { x, y, width: w, height: h };

    // Position buttons just below the drawn box, clamped to viewport
    const btnY  = Math.min(y + h + 10, window.innerHeight - 44);
    const btnRX = Math.min(x + w, window.innerWidth - 10);

    if (confirmBtn) {
      confirmBtn.style.display = 'block';
      confirmBtn.style.left    = Math.max(4, btnRX - 164) + 'px';
      confirmBtn.style.top     = btnY + 'px';
    }

    if (cancelBtn) {
      cancelBtn.style.display = 'block';
      cancelBtn.style.left    = Math.max(4, btnRX - 250) + 'px';
      cancelBtn.style.top     = btnY + 'px';
    }

    if (sizeLabel)  sizeLabel.style.display  = 'none';
    if (hint)       hint.style.display       = 'none';
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') deactivate();
    if (e.key === 'Enter' && selectionRect) confirmCapture();
  }

  // ── Confirm: send capture request to background ───────────────────────────

  async function confirmCapture() {
    if (!selectionRect) return;

    // Save rect before deactivate clears it
    const rect = {
      x:                selectionRect.x + window.scrollX,
      y:                selectionRect.y + window.scrollY,
      width:            selectionRect.width,
      height:           selectionRect.height,
      viewX:            selectionRect.x,
      viewY:            selectionRect.y,
      devicePixelRatio: window.devicePixelRatio || 1,
    };

    deactivate();                      // remove selection UI
    updateLoadingText('Capturing screenshot\u2026');  // show spinner

    // MV3 service workers can be sleeping — retry up to 3 times
    // But don't retry if the extension context was invalidated (needs page refresh)
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await sendMessageToBackground({ type: 'factcheck:capture', rect });
        return; // background acknowledged
      } catch (err) {
        lastErr = err;
        if (err.message === 'INVALIDATED') break; // no point retrying
        await sleep(300);
      }
    }

    if (lastErr?.message === 'INVALIDATED') {
      showRefreshPrompt();
    } else {
      showError(lastErr?.message || 'Extension background did not respond. Try reloading the page.');
    }
  }

  function sendMessageToBackground(msg) {
    return new Promise((resolve, reject) => {
      // Extension context invalidated = extension was reloaded, page needs refresh
      if (!chrome.runtime?.id) {
        reject(new Error('INVALIDATED'));
        return;
      }
      try {
        chrome.runtime.sendMessage(msg, (response) => {
          if (chrome.runtime.lastError) {
            const m = chrome.runtime.lastError.message || '';
            reject(new Error(m.includes('invalidated') || m.includes('context') ? 'INVALIDATED' : m));
          } else {
            resolve(response);
          }
        });
      } catch (e) {
        reject(new Error('INVALIDATED'));
      }
    });
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ── Loading state ─────────────────────────────────────────────────────────

  function updateLoadingText(text) {
    let lo = document.getElementById('factcheck-loading-overlay');
    if (!lo) {
      lo = document.createElement('div');
      lo.id = 'factcheck-loading-overlay';
      lo.innerHTML =
        '<div id="factcheck-loading-card">' +
          '<div id="factcheck-loading-spinner"></div>' +
          '<div id="factcheck-loading-text"></div>' +
        '</div>';
      document.body.appendChild(lo);
      loadingOverlay = lo;
    }
    const el = document.getElementById('factcheck-loading-text');
    if (el) el.textContent = text;
    lo.classList.add('visible');
  }

  function hideLoading() {
    document.getElementById('factcheck-loading-overlay')?.classList.remove('visible');
  }

  // ── Error toast ───────────────────────────────────────────────────────────

  function showError(msg) {
    hideLoading();
    document.getElementById('factcheck-error-toast')?.remove();

    const toast = document.createElement('div');
    toast.id = 'factcheck-error-toast';
    toast.style.cssText = [
      'position:fixed', 'top:24px', 'right:24px', 'z-index:2147483647',
      'background:#2b0d0d', 'border:1px solid #5c1a1a', 'border-radius:12px',
      'padding:14px 18px', "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      'font-size:13px', 'color:#e05555', 'max-width:300px', 'line-height:1.5',
      'box-shadow:0 10px 30px rgba(0,0,0,0.5)'
    ].join(';');
    toast.textContent = '\u26a0 ' + msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 6000);
  }

  // ── Result toast ──────────────────────────────────────────────────────────

  function showResultToast(data) {
    hideLoading();
    document.getElementById('factcheck-result-toast')?.remove();

    const overall = (data.overall_verdict || 'unverifiable').toLowerCase();
    const labels = {
      true:         '\u2713 Supported',
      false:        '\u2717 False',
      misleading:   '\u26a0 Misleading',
      unverifiable: '? Unverifiable',
    };

    const toast = document.createElement('div');
    toast.id = 'factcheck-result-toast';
    toast.classList.add('visible');

    const claimsHtml = (data.claims || []).map(c => {
      const v = (c.verdict || 'unverifiable').toLowerCase();
      return '<div class="factcheck-claim">' +
        '<div class="factcheck-claim-text">\u201c' + escHtml(c.claim) + '\u201d</div>' +
        '<div class="factcheck-claim-verdict ' + v + '">' + (labels[v] || v) + '</div>' +
        '<div class="factcheck-claim-explanation">' + escHtml(c.explanation) + '</div>' +
        '</div>';
    }).join('');

    toast.innerHTML =
      '<div class="factcheck-toast-header ' + overall + '">' +
        '<span class="factcheck-verdict-pill">' + (labels[overall] || overall) + '</span>' +
        '<span class="factcheck-toast-summary">' + escHtml(data.summary || '') + '</span>' +
        '<button class="factcheck-toast-close" id="factcheck-toast-close">\u00d7</button>' +
      '</div>' +
      '<div class="factcheck-toast-body">' +
        (claimsHtml || '<div style="color:#555;font-size:12px;padding:4px 0">No specific claims detected.</div>') +
      '</div>';

    document.body.appendChild(toast);
    document.getElementById('factcheck-toast-close')?.addEventListener('click', () => toast.remove());
    setTimeout(() => toast.remove(), 30000);
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

})();
