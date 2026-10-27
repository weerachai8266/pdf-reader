'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('host', {
    version: () => ipcRenderer.invoke('app:version'),
    pendingFile: () => ipcRenderer.invoke('file:pending'),
    openDialog: (opts) => ipcRenderer.invoke('file:open-dialog', opts),
    readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),
    pathForFile: (file) => webUtils.getPathForFile(file),
    save: (payload) => ipcRenderer.invoke('file:save', payload),
    saveMany: (payload) => ipcRenderer.invoke('file:save-many', payload),
    setDirty: (dirty) => ipcRenderer.send('doc:dirty', dirty),
    thaiFont: () => ipcRenderer.invoke('font:thai'),
    onFileOpened: (cb) => ipcRenderer.on('file:opened', (_e, file) => cb(file)),
    onUpdateStatus: (cb) => ipcRenderer.on('update:status', (_e, status) => cb(status)),
    installUpdate: () => ipcRenderer.invoke('update:install'),
    print: (job) => ipcRenderer.invoke('print:document', job),
    sigListIds: () => ipcRenderer.invoke('sig:list-ids'),
    sigCreateId: (opts) => ipcRenderer.invoke('sig:create-id', opts),
    sigImportId: (opts) => ipcRenderer.invoke('sig:import-id', opts),
    sigRemoveId: (id) => ipcRenderer.invoke('sig:remove-id', id),
    sigSign: (job) => ipcRenderer.invoke('sig:sign', job),
    sigVerify: (job) => ipcRenderer.invoke('sig:verify', job),
    sigTrust: (certDer) => ipcRenderer.invoke('sig:trust', certDer),
    convertAvailable: () => ipcRenderer.invoke('convert:available'),
    convertPick: (opts) => ipcRenderer.invoke('convert:pick', opts),
    convertPrepare: (filePath) => ipcRenderer.invoke('convert:prepare', filePath),
    convertExport: (job) => ipcRenderer.invoke('convert:export', job),
    onMenuCommand: (cb) => ipcRenderer.on('menu:command', (_e, command) => cb(command)),
});
