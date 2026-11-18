/*
 * Desktop app shell (Electron).
 * - Starts the agent server inside the app and opens the game window.
 * - Stores Alpaca keys encrypted with Windows' built-in protection (safeStorage / DPAPI).
 * - Auto-updates from GitHub Releases in the background (only changed blocks are downloaded).
 */
'use strict';
const { app, BrowserWindow, ipcMain, safeStorage, shell, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { startServer } = require('../server.js');

let autoUpdater = null;
try { autoUpdater = require('electron-updater').autoUpdater; } catch (_) { /* dev without deps */ }

const pkg = require('../package.json');
const userDir = app.getPath('userData');
const secretsPath = path.join(userDir, 'secrets.bin');
const prefsPath = path.join(userDir, 'prefs.json');

let win = null, srv = null;
let updateState = { state: 'idle' };

// ---------- single instance ----------
// If the app is already open, a second launch (e.g. double-clicking the shortcut again)
// just brings the existing window forward and exits immediately.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.exit(0);
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });

// ---------- prefs + secrets ----------
function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } }
function writeJson(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

function loadSecrets() {
  try {
    if (!fs.existsSync(secretsPath)) return {};
    const buf = fs.readFileSync(secretsPath);
    const txt = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
    return JSON.parse(txt);
  } catch (e) { console.error('could not read keys', e.message); return {}; }
}
function saveSecrets(obj) {
  fs.mkdirSync(userDir, { recursive: true });
  const txt = JSON.stringify(obj);
  fs.writeFileSync(secretsPath, safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(txt) : Buffer.from(txt, 'utf8'));
}

// The update source: baked in at build time (package.json "build.publish"), or set in-app.
function updateSource() {
  const prefs = readJson(prefsPath, {});
  if (prefs.updateRepo) { const [owner, repo] = prefs.updateRepo.split('/'); if (owner && repo) return { owner, repo }; }
  const pub = pkg.build && pkg.build.publish;
  const p = Array.isArray(pub) ? pub[0] : pub;
  if (p && p.owner && p.repo && !/YOUR_GITHUB/i.test(p.owner)) return { owner: p.owner, repo: p.repo };
  return null;
}

// ---------- updates ----------
function sendUpdate(s) { updateState = s; if (win && !win.isDestroyed()) win.webContents.send('update', s); }
function setupUpdater() {
  if (!autoUpdater) return sendUpdate({ state: 'unavailable', message: 'Updater not installed' });
  if (!app.isPackaged) return sendUpdate({ state: 'dev', message: 'Updates only run in the installed app' });
  const src = updateSource();
  if (!src) return sendUpdate({ state: 'not-configured' });
  autoUpdater.setFeedURL({ provider: 'github', owner: src.owner, repo: src.repo, releaseType: 'release' });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.removeAllListeners();
  autoUpdater.on('checking-for-update', () => sendUpdate({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => sendUpdate({ state: 'current', checkedAt: Date.now() }));
  autoUpdater.on('update-available', (i) => sendUpdate({ state: 'downloading', version: i.version, percent: 0, notes: notes(i) }));
  autoUpdater.on('download-progress', (p) => sendUpdate({ state: 'downloading', version: updateState.version, percent: Math.round(p.percent), notes: updateState.notes }));
  autoUpdater.on('update-downloaded', (i) => sendUpdate({ state: 'ready', version: i.version, notes: notes(i) }));
  autoUpdater.on('error', (e) => sendUpdate({ state: 'error', message: friendly(e) }));
  check();
}
function notes(i) {
  const n = i.releaseNotes;
  if (!n) return '';
  const txt = Array.isArray(n) ? n.map((x) => x.note).join('\n') : String(n);
  return txt.replace(/<[^>]+>/g, '').trim().slice(0, 600);
}
function friendly(e) {
  const m = String((e && e.message) || e);
  if (/404|Cannot find latest|No published versions/i.test(m)) return 'No releases published yet on ' + JSON.stringify(updateSource());
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|net::/i.test(m)) return 'Offline: will try again later';
  return m.split('\n')[0].slice(0, 200);
}
function check() { if (autoUpdater && app.isPackaged && updateSource()) autoUpdater.checkForUpdates().catch((e) => sendUpdate({ state: 'error', message: friendly(e) })); }

// ---------- window ----------
async function createWindow() {
  const secrets = loadSecrets();
  srv = await startServer({ env: secrets, dataDir: path.join(userDir, 'data'), port: 3777 });
  win = new BrowserWindow({
    width: 1520, height: 960, minWidth: 900, minHeight: 600,
    backgroundColor: '#090a1a', title: 'Trading Agent Arena', autoHideMenuBar: true, show: false,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  // only our local page loads in the app; other links open in your normal browser
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(srv.url)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  win.webContents.on('did-finish-load', () => sendUpdate(updateState));
  await win.loadURL(srv.url);
  setupUpdater();
  setInterval(check, 3 * 60 * 60 * 1000); // every 3 hours
}

function closeServer() { if (srv) { const s = srv; srv = null; s.close(); } }
function restartApp() {
  closeServer();
  app.relaunch(); app.exit(0);
}

// ---------- IPC (the page talks to the shell through preload.js) ----------
ipcMain.handle('app:info', () => {
  const s = loadSecrets();
  const src = updateSource();
  return {
    version: app.getVersion(),
    packaged: app.isPackaged,
    keys: { paper: !!(s.ALPACA_PAPER_KEY_ID && s.ALPACA_PAPER_SECRET), live: !!(s.ALPACA_LIVE_KEY_ID && s.ALPACA_LIVE_SECRET), allowLive: s.ALLOW_LIVE === 'true', encrypted: safeStorage.isEncryptionAvailable() },
    updateRepo: src ? `${src.owner}/${src.repo}` : '',
    update: updateState,
  };
});
ipcMain.handle('keys:save', async (_e, k) => {
  const s = loadSecrets();
  const set = (name, v) => { if (typeof v === 'string' && v.trim()) s[name] = v.trim(); };
  set('ALPACA_PAPER_KEY_ID', k.paperId); set('ALPACA_PAPER_SECRET', k.paperSecret);
  set('ALPACA_LIVE_KEY_ID', k.liveId); set('ALPACA_LIVE_SECRET', k.liveSecret);
  if (k.clearPaper) { delete s.ALPACA_PAPER_KEY_ID; delete s.ALPACA_PAPER_SECRET; }
  if (k.clearLive) { delete s.ALPACA_LIVE_KEY_ID; delete s.ALPACA_LIVE_SECRET; s.ALLOW_LIVE = 'false'; }
  if (typeof k.allowLive === 'boolean') s.ALLOW_LIVE = k.allowLive ? 'true' : 'false';
  saveSecrets(s);
  setTimeout(restartApp, 300); // reconnect with the new keys
  return { ok: true };
});
ipcMain.handle('update:check', () => { check(); return updateState; });
ipcMain.handle('update:install', () => {
  if (updateState.state !== 'ready') return false;
  closeServer(); // save progress first
  setImmediate(() => autoUpdater.quitAndInstall(true, true)); // silent install, then reopen
  return true;
});
ipcMain.handle('update:setRepo', (_e, repo) => {
  const v = String(repo || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (v && !/^[\w.-]+\/[\w.-]+$/.test(v)) throw new Error('Use the form owner/repo');
  const prefs = readJson(prefsPath, {}); prefs.updateRepo = v; writeJson(prefsPath, prefs);
  setupUpdater();
  return updateSource();
});
ipcMain.handle('app:openData', () => shell.openPath(userDir));

// ---------- lifecycle ----------
if (gotLock) app.whenReady().then(createWindow).catch((e) => {
  dialog.showErrorBox('Trading Agent Arena could not start', String(e && e.stack || e));
  app.quit();
});
app.on('window-all-closed', () => { closeServer(); app.quit(); });
app.on('before-quit', () => { if (srv) srv.saveNow(); });
