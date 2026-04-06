// Electron main process — starts the local Express server, then opens a BrowserWindow.

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const { fork } = require('child_process');
const path = require('path');
const fs   = require('fs');

const PORT = 3847; // Fixed port to avoid clashing with dev server on 3000

// ── Settings (stored in OS user-data dir, survives app updates) ───────────────

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch { return {}; }
}

function writeSettings(patch) {
  const current = readSettings();
  fs.writeFileSync(settingsPath(), JSON.stringify({ ...current, ...patch }, null, 2));
}

// ── Express server ────────────────────────────────────────────────────────────

let serverProcess = null;

function startServer() {
  return new Promise((resolve) => {
    serverProcess = fork(path.join(__dirname, '../server/index.js'), [], {
      env: {
        ...process.env,
        PORT:         String(PORT),
        DESKTOP_MODE: 'true',
        JWT_SECRET:   'desktop-local-only-secret',
        // No GEMINI_API_KEY — users supply their own key via the settings screen
        // No Stripe keys — no payment wall in the desktop app (already purchased)
      },
      silent: true,
    });

    serverProcess.stdout?.on('data', d => {
      if (d.toString().includes('running at')) resolve();
    });
    serverProcess.stderr?.on('data', d => console.error('[server]', d.toString().trim()));
    serverProcess.on('error', err => { console.error('Server error:', err); resolve(); });

    // Fallback: open window even if we never see the startup line
    setTimeout(resolve, 4000);
  });
}

// ── Window ────────────────────────────────────────────────────────────────────

let mainWindow = null;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width:   980,
    height:  740,
    minWidth:  680,
    minHeight: 520,
    title: 'SortMyPics',
    webPreferences: {
      // app.getAppPath() resolves correctly both in dev and inside a packaged asar
      preload:          path.join(app.getAppPath(), 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  await mainWindow.loadURL(`http://localhost:${PORT}`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  await startServer();
  await createWindow();
  app.on('activate', () => { if (!mainWindow) createWindow(); });

  // Check for updates silently after the window is ready.
  // Downloads in the background; prompts the user to restart when ready.
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  serverProcess?.kill();
});

// ── IPC handlers (called from the renderer via preload) ───────────────────────

ipcMain.handle('get-gemini-key', ()        => readSettings().geminiApiKey || '');
ipcMain.handle('set-gemini-key', (_e, key) => { writeSettings({ geminiApiKey: key.trim() }); return true; });
ipcMain.handle('open-external',  (_e, url) => shell.openExternal(url));
ipcMain.handle('get-version',    ()        => app.getVersion());
