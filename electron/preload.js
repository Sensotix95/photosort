// Preload — exposes a safe, narrow API to the renderer process.
// contextIsolation is ON, so this is the only way renderer code can reach Electron/Node.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron:   true,
  getGeminiKey: ()      => ipcRenderer.invoke('get-gemini-key'),
  setGeminiKey: (key)   => ipcRenderer.invoke('set-gemini-key', key),
  openExternal: (url)   => ipcRenderer.invoke('open-external', url),
  getVersion:   ()      => ipcRenderer.invoke('get-version'),
});
