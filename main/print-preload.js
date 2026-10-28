'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('printHost', {
    onLoad: (cb) => ipcRenderer.on('print:load', (_e, job) => cb(job)),
    progress: (status) => ipcRenderer.send('print:progress', status),
    rendered: (result) => ipcRenderer.send('print:rendered', result),
});
