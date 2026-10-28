'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tabsHost', {
    onState: (cb) => ipcRenderer.on('tabs:state', (_e, state) => cb(state)),
    ready: () => ipcRenderer.send('tabs:ready'),
    activate: (id) => ipcRenderer.send('tabs:activate', id),
    close: (id) => ipcRenderer.send('tabs:close', id),
    newTab: () => ipcRenderer.send('tabs:new'),
});
