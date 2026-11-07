'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Narrow capabilities only. The diary page never receives Node.js or ipcRenderer.
contextBridge.exposeInMainWorld('stillwaterDesktop', Object.freeze({
  isDesktop: true,
  getInfo: () => ipcRenderer.invoke('diary:info'),
  saveFile: (name, bytes) => ipcRenderer.invoke('diary:save-file', { name, bytes }),
  printDocument: name => ipcRenderer.invoke('diary:print', { name }),
  onPrepareClose: callback => {
    ipcRenderer.on('diary:prepare-close', async (_event, token) => {
      try {
        const result = await callback();
        ipcRenderer.send('diary:close-ready', token, result);
      } catch (error) {
        ipcRenderer.send('diary:close-ready', token, { ok: false, message: error.message || 'Your last changes could not be saved.' });
      }
    });
  },
  onMenuAction: callback => {
    ipcRenderer.on('diary:menu-action', (_event, action) => callback(action));
  }
}));
