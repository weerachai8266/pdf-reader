'use strict';

// File conversion with the LibreOffice bundled in the installer:
// Office/ODF/RTF/text/TIFF -> PDF, and HTML -> Word (the renderer rebuilds
// a PDF's text as HTML; LibreOffice's own PDF import scrambles Thai).
//
// soffice runs headless with its own profile under userData, one job at a
// time (a LibreOffice profile can't be used by two processes at once).
// Images that Chromium can decode are converted in the renderer instead.

const { app, dialog, ipcMain } = require('electron');
const { execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const TIMEOUT_MS = 180000;

const OFFICE_EXT = ['doc', 'docx', 'docm', 'dot', 'dotx', 'odt', 'ott', 'rtf', 'txt', 'xls', 'xlsx', 'xlsm', 'ods', 'csv', 'ppt', 'pptx', 'pps', 'ppsx', 'odp', 'odg', 'vsd', 'vsdx', 'html', 'htm', 'tif', 'tiff'];
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'];

// HTML -> other format: import filter + export filter. (execFile passes
// arguments as they are, so filter names need no quoting.)
const EXPORTS = {
    docx: { infilter: 'HTML (StarWriter)', convertTo: 'docx:MS Word 2007 XML' },
};

function sofficePath() {
    const candidates = [
        path.join(process.resourcesPath || '', 'libreoffice', 'program', 'soffice.com'),
        path.join(__dirname, '..', 'vendor', 'libreoffice', 'program', 'soffice.com'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'LibreOffice', 'program', 'soffice.com'),
    ];
    return candidates.find((p) => fsSync.existsSync(p)) || null;
}

let queue = Promise.resolve();
function serial(job) {
    const run = queue.then(job, job);
    queue = run.catch(() => {});
    return run;
}

// Runs soffice --convert-to on one file into a fresh temp folder and
// returns the bytes of the single file it produced.
function runSoffice(input, { convertTo, infilter }) {
    return serial(async () => {
        const exe = sofficePath();
        if (!exe) throw new Error('ไม่พบตัวแปลงไฟล์ (LibreOffice) ในเครื่อง ลองติดตั้งโปรแกรมใหม่');
        const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdfreader-conv-'));
        const profile = pathToFileURL(path.join(app.getPath('userData'), 'converter-profile')).href;
        const args = [
            `-env:UserInstallation=${profile}`,
            '--headless',
            '--invisible',
            '--nologo',
            '--norestore',
            '--nodefault',
            '--nolockcheck',
            ...(infilter ? [`--infilter=${infilter}`] : []),
            '--convert-to',
            convertTo,
            '--outdir',
            outDir,
            input,
        ];
        try {
            await new Promise((resolve, reject) => {
                execFile(exe, args, { timeout: TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
                    if (err) {
                        err.message = `${err.killed ? 'แปลงไฟล์นานเกินไป' : 'แปลงไฟล์ไม่สำเร็จ'} (${(stderr || stdout || err.message).toString().trim().slice(0, 300)})`;
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });
            const [produced] = await fs.readdir(outDir);
            if (!produced) throw new Error('แปลงไฟล์ไม่สำเร็จ: ไฟล์นี้อาจเสียหาย หรือมีรหัสผ่าน');
            return new Uint8Array(await fs.readFile(path.join(outDir, produced)));
        } finally {
            fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
        }
    });
}

function extOf(file) {
    return path.extname(file).slice(1).toLowerCase();
}

// One picked/dropped file, ready for the renderer: PDFs and images as raw
// bytes, everything else converted to PDF here.
async function prepareFile(filePath) {
    const ext = extOf(filePath);
    const name = path.basename(filePath);
    if (ext === 'pdf') return { kind: 'pdf', name, path: filePath, data: new Uint8Array(await fs.readFile(filePath)) };
    if (IMAGE_EXT.includes(ext)) return { kind: 'image', name, path: filePath, ext, data: new Uint8Array(await fs.readFile(filePath)) };
    if (OFFICE_EXT.includes(ext)) return { kind: 'pdf', name, path: filePath, converted: true, data: await runSoffice(filePath, { convertTo: 'pdf' }) };
    throw new Error(`ยังไม่รองรับไฟล์ .${ext}`);
}

function initConvert(getWindow) {
    ipcMain.handle('convert:available', () => Boolean(sofficePath()));

    // Pick files to create a PDF from. Returns [{ kind, name, data, ... } | { name, error }].
    ipcMain.handle('convert:pick', async (_e, { multiple = true } = {}) => {
        const res = await dialog.showOpenDialog(getWindow(), {
            title: 'Create PDF from File',
            filters: [
                { name: 'All supported files', extensions: ['pdf', ...OFFICE_EXT, ...IMAGE_EXT] },
                { name: 'Word', extensions: ['doc', 'docx', 'odt', 'rtf', 'txt'] },
                { name: 'Excel', extensions: ['xls', 'xlsx', 'ods', 'csv'] },
                { name: 'PowerPoint', extensions: ['ppt', 'pptx', 'odp'] },
                { name: 'Images', extensions: [...IMAGE_EXT, 'tif', 'tiff'] },
            ],
            properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
        });
        if (res.canceled) return [];
        return res.filePaths;
    });

    ipcMain.handle('convert:prepare', async (_e, filePath) => {
        if (typeof filePath !== 'string') return { error: 'invalid path' };
        try {
            return await prepareFile(filePath);
        } catch (err) {
            return { name: path.basename(filePath), error: err.message };
        }
    });

    // HTML text -> { data } in another format.
    ipcMain.handle('convert:export', async (_e, { html, format }) => {
        const spec = EXPORTS[format];
        if (!spec || typeof html !== 'string') return { error: `unknown format ${format}` };
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdfreader-exp-'));
        const input = path.join(dir, 'document.html');
        try {
            await fs.writeFile(input, html, 'utf8');
            return { data: await runSoffice(input, spec) };
        } catch (err) {
            return { error: err.message };
        } finally {
            fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    });
}

module.exports = { initConvert, OFFICE_EXT, IMAGE_EXT };
