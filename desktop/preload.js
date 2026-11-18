// Exposes a small, safe API from the desktop shell to the game page.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  info: () => ipcRenderer.invoke('app:info'),
  saveKeys: (k) => ipcRenderer.invoke('keys:save', k),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  setUpdateRepo: (r) => ipcRenderer.invoke('update:setRepo', r),
  openDataFolder: () => ipcRenderer.invoke('app:openData'),
  onUpdate: (cb) => ipcRenderer.on('update', (_e, s) => cb(s)),
});
