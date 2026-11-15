'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Minimal API exposed to the UI (the page has no direct access to Node).
contextBridge.exposeInMainWorld('overlay', {
  getSettings: () => ipcRenderer.invoke('overlay:get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('overlay:set-settings', patch),
  setLang: (lang) => ipcRenderer.send('overlay:set-lang', lang),
  hide: () => ipcRenderer.send('overlay:hide'),
  quit: () => ipcRenderer.send('overlay:quit'),
  installUpdate: () => ipcRenderer.send('overlay:install-update'),
  onShown: (cb) => ipcRenderer.on('overlay:shown', () => cb()),
  onAppUpdate: (cb) => ipcRenderer.on('overlay:app-update', (_e, m) => cb(m)),
});
