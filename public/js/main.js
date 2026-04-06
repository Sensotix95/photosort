// App entry point — handles screen routing and wires all modules together.

import { verifyToken, exchangeSessionId, startCheckout, saveToken, getToken } from './modules/auth.js';
import { isSupported, pickFolder, scanDirectory } from './modules/folderPicker.js';
import { buildPlan } from './modules/planBuilder.js';
import { renderPreview } from './modules/previewRenderer.js';
import { executePlan } from './modules/fileCopier.js';

// ── Screen management ─────────────────────────────────────────────────────────

function show(id) {
  document.querySelectorAll('.screen').forEach(el => el.classList.add('hidden'));
  document.getElementById(id)?.classList.remove('hidden');
}

function setStatus(msg) {
  const el = document.getElementById('status-text');
  if (el) el.textContent = msg;
}

function setProgress(stage, done, total) {
  const bar   = document.getElementById('progress-bar');
  const label = document.getElementById('progress-label');
  if (!bar || !label) return;

  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  bar.style.width = `${pct}%`;

  const stageLabels = {
    model: 'Downloading AI model',
    clip:  'Classifying photos',
    exif:  'Reading metadata',
    geo:   'Looking up locations',
    tags:  'Tagging sessions',
  };
  label.textContent = `${stageLabels[stage] || stage}: ${done}${total ? ` / ${total}` : ''} ${total ? `(${pct}%)` : ''}`;
}

// ── State ─────────────────────────────────────────────────────────────────────

let sourceDirHandle = null;
let destDirHandle   = null;
let currentPlan     = null;
let paymentPopup    = null;

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Check browser support — skip in Electron (always Chromium, always supported)
  if (!window.electronAPI && !isSupported()) {
    document.getElementById('browser-warning')?.classList.remove('hidden');
    return;
  }

  // Handle Stripe redirect back with ?session_id=xxx (popup-blocked fallback)
  const params    = new URLSearchParams(location.search);
  const sessionId = params.get('session_id');
  if (sessionId) {
    history.replaceState({}, '', '/');
    try {
      setStatus('Verifying payment…');
      await exchangeSessionId(sessionId);
    } catch (err) {
      alert('Payment verification failed. Please contact support.');
      show('screen-gate');
      return;
    }
    show('screen-app');
    bindEvents();
    return;
  }

  // ── Desktop app path ───────────────────────────────────────────────────────
  if (window.electronAPI) {
    // Auto-issue a local token so the app never hits the payment gate
    if (!getToken()) {
      try {
        const r = await fetch('/api/auth/desktop-token', { method: 'POST' });
        if (r.ok) { const { token } = await r.json(); saveToken(token); }
      } catch {}
    }

    // Show settings button and version (only visible in Electron)
    document.getElementById('btn-settings')?.classList.remove('hidden');
    const versionEl = document.getElementById('app-version');
    if (versionEl) {
      const v = await window.electronAPI.getVersion();
      if (v) { versionEl.textContent = `v${v}`; versionEl.style.display = ''; }
    }

    // If no API key is saved yet, show the first-launch key setup screen
    const geminiKey = await window.electronAPI.getGeminiKey();
    if (!geminiKey) {
      show('screen-apikey');
    } else {
      show('screen-app');
    }

    bindEvents();
    return;
  }

  // ── Web app path ───────────────────────────────────────────────────────────
  const { valid } = await verifyToken();
  if (valid) {
    show('screen-app');
  } else {
    show('screen-gate');
  }

  bindEvents();
});

// ── Payment popup ─────────────────────────────────────────────────────────────

async function openPaymentPopup() {
  try {
    const res = await fetch('/api/auth/checkout-popup', { method: 'POST' });
    if (!res.ok) throw new Error('Failed to create checkout session');
    const { url } = await res.json();

    const w    = 500, h = 700;
    const left = Math.round(window.screenX + (window.outerWidth  - w) / 2);
    const top  = Math.round(window.screenY + (window.outerHeight - h) / 2);
    paymentPopup = window.open(url, 'stripe-checkout', `width=${w},height=${h},left=${left},top=${top}`);

    if (!paymentPopup) {
      // Popup blocked — fall back to full-page redirect (state will be lost)
      await startCheckout();
    }
  } catch {
    alert('Could not start checkout. Please try again.');
  }
}

// ── Copy files ────────────────────────────────────────────────────────────────

async function doCopy() {
  if (!currentPlan || !destDirHandle) return;

  show('screen-process');
  setStatus('Copying files…');

  try {
    await executePlan(currentPlan, destDirHandle, (done, total, file) => {
      setProgress('copy', done, total);
      if (file) setStatus(`Copying: ${file}`);
    });

    show('screen-done');
    document.getElementById('done-count').textContent = currentPlan.length;
    document.getElementById('done-folder').textContent = destDirHandle.name;
  } catch (err) {
    console.error('Copy error:', err);
    setStatus(`Error while copying: ${err.message}`);
  }
}

// ── Event bindings ────────────────────────────────────────────────────────────

function bindEvents() {
  // Landing CTA: start sorting directly
  document.getElementById('btn-start-free')?.addEventListener('click', () => {
    show('screen-app');
  });

  // ── API key screen (desktop) ─────────────────────────────────────────────

  // Open API key guide links in the real browser (not inside Electron's window)
  document.querySelectorAll('.apikey-external-link').forEach(link => {
    link.addEventListener('click', e => {
      if (window.electronAPI) {
        e.preventDefault();
        window.electronAPI.openExternal(link.href);
      }
    });
  });

  document.getElementById('btn-save-apikey')?.addEventListener('click', async () => {
    const input = document.getElementById('input-apikey');
    const key   = input?.value.trim();
    if (!key) { input?.focus(); return; }
    await window.electronAPI.setGeminiKey(key);
    show('screen-app');
  });

  document.getElementById('btn-skip-apikey')?.addEventListener('click', () => {
    show('screen-app');
  });

  // Settings button → back to API key screen
  document.getElementById('btn-settings')?.addEventListener('click', () => {
    window.electronAPI?.getGeminiKey().then(k => {
      const input = document.getElementById('input-apikey');
      if (input && k) input.value = k;
    });
    show('screen-apikey');
  });

  // ── Download desktop app ─────────────────────────────────────────────────

  document.getElementById('btn-download-app')?.addEventListener('click', async () => {
    // If already paid, go straight to the download page
    const { valid } = await verifyToken();
    if (valid) {
      window.location.href = '/download';
      return;
    }
    // Otherwise start a download-specific Stripe checkout (full-page redirect)
    try {
      const res = await fetch('/api/auth/checkout-download', { method: 'POST' });
      if (!res.ok) throw new Error();
      const { url } = await res.json();
      window.location.href = url;
    } catch {
      alert('Could not start checkout. Please try again.');
    }
  });

  // Payment popup: receive success message from /payment-complete
  window.addEventListener('message', async (e) => {
    if (e.origin !== window.location.origin) return;
    if (e.data?.type !== 'PAYMENT_SUCCESS') return;

    if (paymentPopup && !paymentPopup.closed) paymentPopup.close();
    paymentPopup = null;

    try {
      await exchangeSessionId(e.data.sessionId);
    } catch {
      alert('Payment verification failed. Please contact support.');
      return;
    }

    show('screen-preview');
  });

  // Step 1: pick source folder
  document.getElementById('btn-pick-source')?.addEventListener('click', async () => {
    try {
      sourceDirHandle = await pickFolder('read');
      document.getElementById('source-folder-name').textContent = sourceDirHandle.name;
      const stepDest = document.getElementById('step-dest');
      stepDest.classList.remove('hidden');
      stepDest.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch {
      // User cancelled — do nothing
    }
  });

  // Step 1b: pick destination folder
  document.getElementById('btn-pick-dest')?.addEventListener('click', async () => {
    try {
      destDirHandle = await pickFolder('readwrite');
      document.getElementById('dest-folder-name').textContent = destDirHandle.name;
      document.getElementById('btn-start').disabled = false;
    } catch {}
  });

  // Step 2: start processing
  document.getElementById('btn-start')?.addEventListener('click', async () => {
    if (!sourceDirHandle || !destDirHandle) return;

    show('screen-process');
    setStatus('Scanning folder…');

    try {
      const files = await scanDirectory(sourceDirHandle, (count) => {
        setStatus(`Scanning… ${count} files found`);
      });

      if (!files.length) {
        setStatus('No photos or videos found in the selected folder.');
        return;
      }

      setStatus(`Found ${files.length} files. Starting AI analysis…`);

      currentPlan = await buildPlan(
        files,
        (msg) => setStatus(msg),
        ({ stage, done, total }) => setProgress(stage, done, total)
      );

      show('screen-preview');
      const container = document.getElementById('preview-container');
      renderPreview(currentPlan, container);

    } catch (err) {
      console.error('Pipeline error:', err);
      setStatus(`Error: ${err.message}`);
    }
  });

  // Step 3: confirm and copy — open payment popup if not yet paid
  document.getElementById('btn-confirm')?.addEventListener('click', async () => {
    if (!currentPlan || !destDirHandle) return;

    const { valid } = await verifyToken();
    if (!valid) {
      await openPaymentPopup();
      return;
    }

    await doCopy();
  });

  // Step 3: cancel preview → go back
  document.getElementById('btn-cancel')?.addEventListener('click', () => {
    show('screen-app');
  });

  // Done: start again
  document.getElementById('btn-again')?.addEventListener('click', () => {
    sourceDirHandle = null;
    destDirHandle   = null;
    currentPlan     = null;
    document.getElementById('source-folder-name').textContent = 'None selected';
    document.getElementById('dest-folder-name').textContent   = 'None selected';
    document.getElementById('step-dest').classList.add('hidden');
    document.getElementById('btn-start').disabled = true;
    show('screen-app');
  });
}
