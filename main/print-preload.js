'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('printHost', {
    onLoad: (cb) => ipcRenderer.on('print:load', (_e, job) => cb(job)),
    rendered: (result) => ipcRenderer.send('print:rendered', result),
});
