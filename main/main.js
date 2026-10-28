'use strict';

const { app, dialog, ipcMain, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { initUpdater } = require('./updater');
const { buildMenu } = require('./menu');
const { initPrint } = require('./print');
const { initConvert } = require('./convert');
const { initDigsig } = require('./digsig');
const tabs = require('./tabs');

const APP_ROOT = path.join(__dirname, '..');

// Serve the renderer from app://local/ so ES modules, the pdf.js worker and
// fetch() of cmaps/fonts all work without file:// CORS restrictions.
protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const pendingPath = findPdfArg(process.argv);

function findPdfArg(argv) {
    return argv.slice(1).find((a) => a.toLowerCase().endsWith('.pdf')) || null;
}

function registerAppProtocol() {
    protocol.handle('app', (request) => {
        let { pathname } = new URL(request.url);
        // tesseract.js wants every language file under one folder; each
        // language package keeps its own, so map /ocr-lang/<lang>.traineddata.gz.
        const lang = /^\/ocr-lang\/([a-z_]+)\.traineddata\.gz$/.exec(pathname);
        if (lang) pathname = `/node_modules/@tesseract.js-data/${lang[1]}/4.0.0_best_int/${lang[1]}.traineddata.gz`;
        const target = path.normalize(path.join(APP_ROOT, decodeURIComponent(pathname)));
        const allowed = [path.join(APP_ROOT, 'src'), path.join(APP_ROOT, 'node_modules')];
        if (!allowed.some((dir) => target.startsWith(dir + path.sep))) {
            return new Response('Not found', { status: 404 });
        }
        return net.fetch(pathToFileURL(target).toString()).catch(() => new Response('Not found', { status: 404 }));
    });
}

async function readPdf(filePath) {
    const data = await fs.readFile(filePath);
    return { path: filePath, name: path.basename(filePath), data: new Uint8Array(data) };
}

// package.json is the version source of truth (also correct when the app
// is launched through another entry script, e.g. the smoke test).
ipcMain.handle('app:version', () => require('../package.json').version);

// The file a document tab was opened with (asked once by its renderer).
ipcMain.handle('file:pending', async (e) => {
    const file = tabs.takePending(e.sender);
    if (file?.path && !file.data && !file.createPaths) return readPdf(file.path);
    return file;
});

// A tab that already shows a document opens another file in a tab.
// file: { path, name, data } or { createPaths }.
ipcMain.handle('tabs:open', (_e, file) => {
    if (file && (file.data || Array.isArray(file.createPaths))) tabs.openInTab(file);
});

const fromStrip = (e) => e.sender === tabs.getWindow()?.webContents;
ipcMain.on('tabs:ready', (e) => fromStrip(e) && tabs.refresh());
ipcMain.on('tabs:activate', (e, id) => fromStrip(e) && tabs.activate(id));
ipcMain.on('tabs:close', (e, id) => fromStrip(e) && tabs.closeTab(id));
ipcMain.on('tabs:new', (e) => fromStrip(e) && tabs.newTab());

ipcMain.handle('file:open-dialog', async (_e, { multiple = false } = {}) => {
    const res = await dialog.showOpenDialog(tabs.getWindow(), {
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
        properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
    });
    if (res.canceled) return [];
    return Promise.all(res.filePaths.map(readPdf));
});

ipcMain.handle('file:read', async (_e, filePath) => {
    if (typeof filePath !== 'string' || !filePath.toLowerCase().endsWith('.pdf')) return null;
    return readPdf(filePath);
});

ipcMain.handle('file:save', async (_e, { data, filePath, suggestedName }) => {
    let target = filePath;
    if (!target) {
        // The suggested name's extension picks the file type (PDF, DOCX, TXT…).
        const ext = path.extname(suggestedName || '').slice(1).toLowerCase() || 'pdf';
        const res = await dialog.showSaveDialog(tabs.getWindow(), {
            defaultPath: suggestedName || 'document.pdf',
            filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
        });
        if (res.canceled || !res.filePath) return null;
        target = res.filePath;
    }
    await fs.writeFile(target, Buffer.from(data));
    return { path: target, name: path.basename(target) };
});

// Thai font for drawing form-field appearances. Tahoma ships with every
// Windows, allows editable embedding (OS/2 fsType), and is the only Thai
// system font that both subsets correctly with fontkit and positions
// stacked marks (e.g. น้ำ) correctly; Leelawadee UI fails at both.
// Writes several new files into a folder the user picks. Existing files
// are never overwritten: "name.pdf" becomes "name (2).pdf".
ipcMain.handle('file:save-many', async (_e, { files, title }) => {
    const res = await dialog.showOpenDialog(tabs.getWindow(), {
        title: title || 'Choose folder',
        properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return null;
    const folder = res.filePaths[0];
    for (const file of files) {
        const ext = path.extname(file.name);
        const stem = path.basename(file.name, ext);
        let target = path.join(folder, path.basename(file.name));
        for (let n = 2; await fs.access(target).then(() => true, () => false); n++) {
            target = path.join(folder, `${stem} (${n})${ext}`);
        }
        await fs.writeFile(target, Buffer.from(file.data));
    }
    return { folder, count: files.length };
});

// Fonts for text typed into a PDF (Edit Text / Add Text). Windows fonts,
// plus Laksaman (TH Sarabun New's free twin) bundled with the converter.
const EDIT_FONTS = {
    tahoma: ['win', 'tahoma.ttf'],
    'tahoma-bold': ['win', 'tahomabd.ttf'],
    arial: ['win', 'arial.ttf'],
    'arial-bold': ['win', 'arialbd.ttf'],
    times: ['win', 'times.ttf'],
    'times-bold': ['win', 'timesbd.ttf'],
    laksaman: ['lo', 'Laksaman.ttf'],
    'laksaman-bold': ['lo', 'Laksaman-Bold.ttf'],
};

ipcMain.handle('font:get', async (_e, key) => {
    const spec = EDIT_FONTS[key];
    if (!spec) return null;
    const dirs = spec[0] === 'win'
        ? [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts')]
        : [
            path.join(process.resourcesPath || '', 'libreoffice', 'share', 'fonts', 'truetype'),
            path.join(APP_ROOT, 'vendor', 'libreoffice', 'share', 'fonts', 'truetype'),
        ];
    for (const dir of dirs) {
        try {
            return new Uint8Array(await fs.readFile(path.join(dir, spec[1])));
        } catch {}
    }
    return null;
});

ipcMain.handle('font:thai', async () => {
    const fontsDir = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
    try {
        return new Uint8Array(await fs.readFile(path.join(fontsDir, 'tahoma.ttf')));
    } catch {
        return null;
    }
});

// Name, path and unsaved state of a tab's document (tab label, window title,
// unsaved-changes prompt on close).
ipcMain.on('doc:info', (e, info) => tabs.setDocInfo(e.sender, info || {}));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    // A PDF double-clicked while the app runs opens in a tab of this window.
    app.on('second-instance', async (_e, argv) => {
        const win = tabs.getWindow();
        if (!win) return;
        if (win.isMinimized()) win.restore();
        win.focus();
        const p = findPdfArg(argv);
        if (p) tabs.openInTab(await readPdf(p));
    });

    app.whenReady().then(() => {
        registerAppProtocol();
        tabs.createWindow();
        tabs.newTab(pendingPath ? { path: pendingPath, name: path.basename(pendingPath) } : null);
        initPrint();
        initConvert(tabs.getWindow);
        initDigsig(tabs.getWindow);
        const updater = initUpdater(tabs.getWindow, (channel, value) => tabs.allContents().forEach((wc) => wc.send(channel, value)));
        buildMenu(tabs.getWindow, { getContents: tabs.activeContents, tabs, checkForUpdates: () => updater.checkNow() });
    });

    app.on('window-all-closed', () => app.quit());
}
