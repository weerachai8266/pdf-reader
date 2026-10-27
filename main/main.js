'use strict';

const { app, BrowserWindow, dialog, ipcMain, protocol, net, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { initUpdater } = require('./updater');
const { buildMenu } = require('./menu');
const { initPrint } = require('./print');
const { initConvert } = require('./convert');
const { initDigsig } = require('./digsig');

const APP_ROOT = path.join(__dirname, '..');

// Serve the renderer from app://local/ so ES modules, the pdf.js worker and
// fetch() of cmaps/fonts all work without file:// CORS restrictions.
protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let mainWindow = null;
let isDirty = false;
let pendingPath = findPdfArg(process.argv);

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

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 720,
        minHeight: 480,
        backgroundColor: '#3b3f46',
        icon: path.join(APP_ROOT, 'build', 'icon.ico'),
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    mainWindow.loadURL('app://local/src/index.html');
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('close', (e) => {
        if (!isDirty) return;
        const choice = dialog.showMessageBoxSync(mainWindow, {
            type: 'warning',
            buttons: ["Don't Save", 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            message: 'เอกสารมีการแก้ไขที่ยังไม่ได้บันทึก',
        });
        if (choice !== 0) e.preventDefault();
    });
    mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
    // Links inside PDFs open in the default browser / mail client.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    if (process.argv.includes('--devtools')) mainWindow.webContents.openDevTools();
}

async function readPdf(filePath) {
    const data = await fs.readFile(filePath);
    return { path: filePath, name: path.basename(filePath), data: new Uint8Array(data) };
}

// package.json is the version source of truth (also correct when the app
// is launched through another entry script, e.g. the smoke test).
ipcMain.handle('app:version', () => require('../package.json').version);

ipcMain.handle('file:pending', async () => {
    if (!pendingPath) return null;
    const p = pendingPath;
    pendingPath = null;
    return readPdf(p);
});

ipcMain.handle('file:open-dialog', async (_e, { multiple = false } = {}) => {
    const res = await dialog.showOpenDialog(mainWindow, {
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
        const res = await dialog.showSaveDialog(mainWindow, {
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
    const res = await dialog.showOpenDialog(mainWindow, {
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

ipcMain.handle('font:thai', async () => {
    const fontsDir = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
    try {
        return new Uint8Array(await fs.readFile(path.join(fontsDir, 'tahoma.ttf')));
    } catch {
        return null;
    }
});

ipcMain.on('doc:dirty', (_e, dirty) => {
    isDirty = Boolean(dirty);
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', async (_e, argv) => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
        const p = findPdfArg(argv);
        if (p) mainWindow.webContents.send('file:opened', await readPdf(p));
    });

    app.whenReady().then(() => {
        registerAppProtocol();
        createWindow();
        initPrint();
        initConvert(() => mainWindow);
        initDigsig(() => mainWindow);
        const updater = initUpdater(() => mainWindow);
        buildMenu(() => mainWindow, { checkForUpdates: () => updater.checkNow() });
    });

    app.on('window-all-closed', () => app.quit());
}
