'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('host', {
    version: () => ipcRenderer.invoke('app:version'),
    pendingFile: () => ipcRenderer.invoke('file:pending'),
    openDialog: (opts) => ipcRenderer.invoke('file:open-dialog', opts),
    readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),
    pathForFile: (file) => webUtils.getPathForFile(file),
    save: (payload) => ipcRenderer.invoke('file:save', payload),
    setDirty: (dirty) => ipcRenderer.send('doc:dirty', dirty),
    setTitle: (title) => ipcRenderer.send('window:set-title', title),
    onFileOpened: (cb) => ipcRenderer.on('file:opened', (_e, file) => cb(file)),
});
