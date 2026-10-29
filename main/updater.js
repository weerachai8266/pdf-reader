'use strict';

// Auto-update via electron-updater's "generic" provider: any HTTP(S) folder
// that holds latest.yml + the installer (+ .blockmap) produced by
// `npm run dist`. Nothing happens until an update URL is configured.
//
// URL lookup order (first non-empty wins):
//   1. update.json next to the installed exe  — IT can change it per site
//      without rebuilding
//   2. config/update.json bundled in the app   — default for every install

const { app, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const STARTUP_DELAY_MS = 10_000;
const LOG_MAX_BYTES = 1_000_000;

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

// electron-updater's log, kept in userData/logs/updater.log so a PC that
// does not update can be diagnosed. Starts over once it passes LOG_MAX_BYTES.
function fileLogger() {
    const file = path.join(app.getPath('userData'), 'logs', 'updater.log');
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (fs.statSync(file, { throwIfNoEntry: false })?.size > LOG_MAX_BYTES) fs.rmSync(file);
    } catch {}
    const write = (level) => (...args) => {
        const text = args.map((a) => (a instanceof Error ? a.stack || a.message : String(a))).join(' ');
        try {
            fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${text}\n`);
        } catch {}
    };
    return { info: write('info'), warn: write('warn'), error: write('error'), debug: () => {} };
}

// A manual (re)install refreshes installer.exe in electron-updater's cache
// but leaves the blockmap of the last auto-update beside it, so the next
// differential download fails its checksum and falls back to the full
// 250 MB. Drop a blockmap older than the installer; electron-updater then
// fetches the right one from the server. (After an auto-update the cached
// blockmap is also a few seconds older than installer.exe; removing it then
// only costs one ~270 KB download, since the server keeps every blockmap.)
function dropStaleBlockmap(log) {
    // updaterCacheDirName in app-update.yml (electron-builder: <name>-updater).
    const dir = path.join(process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local'), 'pdf-reader-updater');
    try {
        const installer = fs.statSync(path.join(dir, 'installer.exe'), { throwIfNoEntry: false });
        const blockmap = path.join(dir, 'current.blockmap');
        const map = fs.statSync(blockmap, { throwIfNoEntry: false });
        if (installer && map && map.mtimeMs < installer.mtimeMs) {
            fs.rmSync(blockmap);
            log.info('removed cached blockmap older than installer.exe; the old blockmap comes from the server');
        }
    } catch (err) {
        log.warn('cannot check cached blockmap:', err?.message || err);
    }
}

// Returns { checkNow } for the Help > Check for Updates menu item.
// broadcast(channel, value): to every document tab.
function initUpdater(getWindow, broadcast) {
    const send = (status) => broadcast('update:status', status);
    let autoUpdater = null;
    ipcMain.handle('update:install', () => {
        if (autoUpdater) autoUpdater.quitAndInstall(false, true);
    });

    const cfg = app.isPackaged ? loadUpdateConfig() : null;
    const notify = (message) => dialog.showMessageBox(getWindow(), { type: 'info', title: 'Check for Updates', message });

    if (!cfg) {
        return {
            checkNow: () => notify(app.isPackaged
                ? 'ยังไม่ได้ตั้งค่าเซิร์ฟเวอร์อัปเดต (config/update.json หรือ update.json ข้างไฟล์โปรแกรม)'
                : 'การอัปเดตใช้ได้เฉพาะโปรแกรมที่ติดตั้งแล้ว'),
        };
    }

    ({ autoUpdater } = require('electron-updater'));
    const log = fileLogger();
    autoUpdater.logger = log;
    log.info(`v${app.getVersion()} feed ${cfg.url.trim()} (from ${cfg.source})`);
    dropStaleBlockmap(log);
    // One range per request: electron-updater joins multiple ranges with ", "
    // and Apache 2.4 (our server) answers that with the whole 250 MB file,
    // which silently turns every differential update into a full download.
    autoUpdater.setFeedURL({ provider: 'generic', url: cfg.url.trim(), useMultipleRangeRequest: false });
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => send({ state: 'downloading', version: info.version }));
    autoUpdater.on('download-progress', (p) => send({ state: 'downloading', percent: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => send({ state: 'ready', version: info.version }));
    autoUpdater.on('error', (err) => log.error('update error:', err?.message || err));

    async function check() {
        try {
            return await autoUpdater.checkForUpdates();
        } catch (err) {
            // Offline or server down: try again at the next interval.
            log.error('update check failed:', err?.message || err);
            return { error: err };
        }
    }

    const hours = Math.max(1, Number(cfg.checkIntervalHours) || 4);
    setTimeout(check, STARTUP_DELAY_MS);
    setInterval(check, hours * 3_600_000);

    return {
        async checkNow() {
            const result = await check();
            if (result?.error) return notify(`ติดต่อเซิร์ฟเวอร์อัปเดตไม่ได้: ${result.error.message || result.error}`);
            if (!result?.isUpdateAvailable) return notify(`ใช้เวอร์ชันล่าสุดอยู่แล้ว (${app.getVersion()})`);
            return notify(`พบเวอร์ชัน ${result.updateInfo.version} กำลังดาวน์โหลด ดูสถานะได้ที่แถบล่าง`);
        },
    };
}

module.exports = { initUpdater };
