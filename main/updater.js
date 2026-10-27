'use strict';

// Auto-update via electron-updater's "generic" provider: any HTTP(S) folder
// that holds latest.yml + the installer (+ .blockmap) produced by
// `npm run dist`. Nothing happens until an update URL is configured.
//
// URL lookup order (first non-empty wins):
//   1. update.json next to the installed exe  — IT can change it per site
//      without rebuilding
//   2. config/update.json bundled in the app   — default for every install

const { app, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const STARTUP_DELAY_MS = 10_000;

function readConfig(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function loadUpdateConfig() {
    const candidates = [
        path.join(path.dirname(app.getPath('exe')), 'update.json'),
        path.join(__dirname, '..', 'config', 'update.json'),
    ];
    for (const file of candidates) {
        const cfg = readConfig(file);
        if (cfg && typeof cfg.url === 'string' && cfg.url.trim()) return { ...cfg, source: file };
    }
    return null;
}

function initUpdater(getWindow) {
    const send = (status) => getWindow()?.webContents.send('update:status', status);
    ipcMain.handle('update:check', () => check());
    ipcMain.handle('update:install', () => {
        if (autoUpdater) autoUpdater.quitAndInstall(false, true);
    });

    let autoUpdater = null;
    const cfg = app.isPackaged ? loadUpdateConfig() : null;
    if (!cfg) return;

    ({ autoUpdater } = require('electron-updater'));
    autoUpdater.setFeedURL({ provider: 'generic', url: cfg.url.trim() });
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => send({ state: 'downloading', version: info.version }));
    autoUpdater.on('download-progress', (p) => send({ state: 'downloading', percent: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => send({ state: 'ready', version: info.version }));
    autoUpdater.on('error', (err) => console.error('update error:', err?.message || err));

    async function check() {
        if (!autoUpdater) return;
        try {
            await autoUpdater.checkForUpdates();
        } catch (err) {
            // Offline or server down: try again at the next interval.
            console.error('update check failed:', err?.message || err);
        }
    }

    const hours = Math.max(1, Number(cfg.checkIntervalHours) || 4);
    setTimeout(check, STARTUP_DELAY_MS);
    setInterval(check, hours * 3_600_000);
}

module.exports = { initUpdater };
