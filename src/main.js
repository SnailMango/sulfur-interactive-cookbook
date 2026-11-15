'use strict';
/**
 * SULFUR Interactive Cookbook - main process (Electron).
 *  - always-on-top, frameless, semi-transparent overlay window
 *  - global hotkey to show/hide it
 *  - system tray icon
 *  - automatic data updates (from GitHub) and app updates (electron-updater)
 */
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, shell, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { startServer } = require('./server');
const config = require('../config.json');

const DEFAULT_SETTINGS = {
  hotkey: config.hotkey || 'Control+Alt+R',
  lang: 'en',
  opacity: 0.92,
  focusOnShow: true,
  startHidden: false,
  autoUpdateData: true,
  openAtLogin: false,
  bounds: null,
};

let win = null, tray = null, server = null, settings = { ...DEFAULT_SETTINGS };
let quitting = false, hotkeyOk = true, updaterState = null;
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { settings = { ...DEFAULT_SETTINGS }; }
}
function saveSettings() {
  try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 1)); } catch { /* ignore */ }
}
const publicSettings = () => ({ ...settings, hotkeyOk, version: app.getVersion(), packaged: app.isPackaged, updater: updaterState });

/* ---------------- finestra ---------------- */
function initialBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  const def = { width: Math.min(1000, wa.width - 40), height: Math.min(680, wa.height - 40) };
  def.x = wa.x + wa.width - def.width - 20; def.y = wa.y + 20;
  const b = settings.bounds;
  if (b && b.width >= 420 && b.height >= 360) {
    const d = screen.getDisplayMatching(b).workArea;
    const visible = b.x < d.x + d.width - 80 && b.x + b.width > d.x + 80 && b.y < d.y + d.height - 40 && b.y + b.height > d.y;
    if (visible) return b;
  }
  return def;
}

function createWindow(port) {
  win = new BrowserWindow({
    ...initialBounds(),
    minWidth: 420, minHeight: 360,
    frame: false, show: false, skipTaskbar: true, alwaysOnTop: true,
    backgroundColor: '#14161a',
    title: 'SULFUR Interactive Cookbook',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setOpacity(clamp(settings.opacity, 0.3, 1));
  win.loadURL(`http://127.0.0.1:${port}/`);

  // external links (e.g. "Open on the wiki") open in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`http://127.0.0.1:${port}`)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });

  let t = null;
  const persist = () => { clearTimeout(t); t = setTimeout(() => { if (win && !win.isMinimized()) { settings.bounds = win.getBounds(); saveSettings(); } }, 400); };
  win.on('moved', persist); win.on('resized', persist);
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); hideWin(); } });
  win.once('ready-to-show', () => { if (!settings.startHidden) showWin(); });
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, Number(v) || a));

function showWin() {
  if (!win) return;
  win.setAlwaysOnTop(true, 'screen-saver');
  if (settings.focusOnShow) { win.show(); win.focus(); } else { win.showInactive(); }
  win.webContents.send('overlay:shown');
}
function hideWin() { if (win) win.hide(); }
function toggleWin() { if (!win) return; if (win.isVisible()) hideWin(); else showWin(); }

/* ---------------- scorciatoia globale ---------------- */
function registerHotkey(acc) {
  globalShortcut.unregisterAll();
  try { hotkeyOk = !!acc && globalShortcut.register(acc, toggleWin); } catch { hotkeyOk = false; }
  return hotkeyOk;
}

/* ---------------- tray ---------------- */
function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png')).resize({ width: 20, height: 20 });
  tray = new Tray(img);
  tray.setToolTip('SULFUR Interactive Cookbook');
  const L = {
    en: { toggle: 'Show / hide', update: 'Update recipe data', folder: 'Open data folder', quit: 'Quit' },
    it: { toggle: 'Mostra / nascondi', update: 'Aggiorna i dati delle ricette', folder: 'Apri la cartella dei dati', quit: 'Esci' },
  };
  const rebuild = () => { const l = L[settings.lang] || L.en; tray.setContextMenu(Menu.buildFromTemplate([
    { label: `${l.toggle}  (${settings.hotkey.replace('Control', 'Ctrl')})`, click: toggleWin },
    { label: l.update, click: () => server && server.runUpdate(false) },
    { label: l.folder, click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    { label: l.quit, click: () => { quitting = true; app.quit(); } },
  ])); };
  rebuild(); tray.on('click', toggleWin);
  return rebuild;
}

/* ---------------- aggiornamento dell'app (GitHub Releases) ---------------- */
function setupAppUpdater() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch { return; }
  const push = (state, extra) => { updaterState = { state, ...extra }; if (win) win.webContents.send('overlay:app-update', updaterState); };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (i) => push('downloading', { version: i.version }));
  autoUpdater.on('update-downloaded', (i) => push('ready', { version: i.version }));
  autoUpdater.on('error', () => { /* offline or no release yet: ignore */ });
  ipcMain.on('overlay:install-update', () => { quitting = true; autoUpdater.quitAndInstall(); });
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
}

/* ---------------- IPC ---------------- */
function setupIpc(rebuildTray) {
  ipcMain.handle('overlay:get-settings', () => publicSettings());
  ipcMain.handle('overlay:set-settings', (_e, patch) => {
    patch = patch || {};
    if (typeof patch.opacity === 'number') { settings.opacity = clamp(patch.opacity, 0.3, 1); win && win.setOpacity(settings.opacity); }
    for (const k of ['focusOnShow', 'startHidden', 'autoUpdateData']) if (typeof patch[k] === 'boolean') settings[k] = patch[k];
    if (typeof patch.openAtLogin === 'boolean') { settings.openAtLogin = patch.openAtLogin; try { app.setLoginItemSettings({ openAtLogin: patch.openAtLogin }); } catch { /* ignore */ } }
    if (typeof patch.hotkey === 'string' && patch.hotkey) {
      const prev = settings.hotkey;
      if (registerHotkey(patch.hotkey)) settings.hotkey = patch.hotkey;
      else { registerHotkey(prev); hotkeyOk = false; }   // new hotkey unavailable: restore the previous one
      hotkeyOk = globalShortcut.isRegistered(settings.hotkey);
      rebuildTray();
    }
    saveSettings();
    return publicSettings();
  });
  ipcMain.on('overlay:set-lang', (_e, l) => { if (l === 'en' || l === 'it') { settings.lang = l; saveSettings(); rebuildTray(); } });
  ipcMain.on('overlay:hide', hideWin);
  ipcMain.on('overlay:quit', () => { quitting = true; app.quit(); });
}

/* ---------------- avvio ---------------- */
if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', showWin);
  app.whenReady().then(async () => {
    loadSettings();
    server = await startServer({ dataDir: app.getPath('userData'), appDir: path.join(__dirname, '..'), config });
    if (settings.autoUpdateData) server.maybeAutoUpdate();
    const rebuildTray = createTray();
    setupIpc(rebuildTray);
    createWindow(server.port);
    registerHotkey(settings.hotkey);
    setupAppUpdater();
  });
  app.on('window-all-closed', () => { /* keep running in the tray */ });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); if (server) server.close(); });
}
