// App entry point — handles screen routing and wires all modules together.

import { verifyToken, exchangeSessionId, startCheckout, saveToken } from './modules/auth.js';
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

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Check browser support
  if (!isSupported()) {
    document.getElementById('browser-warning')?.classList.remove('hidden');
    return;
  }

  // Handle Stripe redirect back with ?session_id=xxx
  const params    = new URLSearchParams(location.search);
  const sessionId = params.get('session_id');
  if (sessionId) {
    history.replaceState({}, '', '/'); // clean URL
    try {
      setStatus('Verifying payment…');
      await exchangeSessionId(sessionId);
    } catch (err) {
      alert('Payment verification failed. Please contact support.');
      show('screen-gate');
      return;
    }
  }

  // Check for existing token
  const { valid } = await verifyToken();
  if (valid) {
    show('screen-app');
  } else {
    show('screen-gate');
  }

  bindEvents();
});

// ── Event bindings ────────────────────────────────────────────────────────────

function bindEvents() {
  // Gate: test access toggle
  document.getElementById('link-test-access')?.addEventListener('click', (e) => {
    e.preventDefault();
    const form = document.getElementById('test-access-form');
    form.style.display = form.style.display === 'none' ? 'block' : 'none';
  });

  // Gate: test login submit
  document.getElementById('btn-test-login')?.addEventListener('click', async () => {
    const password = document.getElementById('test-password-input').value;
    const errEl    = document.getElementById('test-login-error');
    errEl.style.display = 'none';
    try {
      const res = await fetch('/api/auth/test-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) { errEl.style.display = 'block'; return; }
      const { token } = await res.json();
      saveToken(token);
      show('screen-app');
    } catch {
      errEl.style.display = 'block';
    }
  });

  // Allow pressing Enter in the password field
  document.getElementById('test-password-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-test-login').click();
  });

  // Gate: buy button
  document.getElementById('btn-buy')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Redirecting to checkout…';
    try {
      await startCheckout();
    } catch {
      e.target.disabled = false;
      e.target.textContent = 'Get PhotoSort';
    }
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

    const homeCity = document.getElementById('home-city-input')?.value.trim() || '';

    show('screen-process');
    setStatus('Scanning folder…');

    try {
      // Scan files
      const files = await scanDirectory(sourceDirHandle, (count) => {
        setStatus(`Scanning… ${count} files found`);
      });

      if (!files.length) {
        setStatus('No photos or videos found in the selected folder.');
        return;
      }

      setStatus(`Found ${files.length} files. Starting AI analysis…`);

      // Run full pipeline
      currentPlan = await buildPlan(
        files,
        homeCity,
        (msg) => setStatus(msg),
        ({ stage, done, total }) => setProgress(stage, done, total)
      );

      // Show preview
      show('screen-preview');
      const container = document.getElementById('preview-container');
      renderPreview(currentPlan, container);

    } catch (err) {
      console.error('Pipeline error:', err);
      setStatus(`Error: ${err.message}`);
    }
  });

  // Step 3: confirm and copy
  document.getElementById('btn-confirm')?.addEventListener('click', async () => {
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
