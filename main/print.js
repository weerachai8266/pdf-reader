'use strict';

// Printing, the Acrobat way: the app's own Print dialog (src/js/printdialog.js)
// picks the printer and the options, and the job goes straight to that
// printer. The Windows print dialog is not used: opened from the hidden
// render window it did not come up reliably.
//
// The renderer hands over the final PDF bytes (same output as Save, so
// forms, highlights and signatures print exactly as saved). A hidden
// window lays every chosen page out on paper at 300 dpi
// (src/js/print/index.js), then webContents.print sends it silently.

const { BrowserWindow, ipcMain } = require('electron');
const { execFile, spawn } = require('node:child_process');
const path = require('node:path');

const MICRONS_PER_POINT = 25400 / 72;
const DUPLEX = new Set(['simplex', 'longEdge', 'shortEdge']);

// Electron no longer reports the default printer; Windows keeps it per user.
function defaultPrinter() {
    return new Promise((resolve) => {
        execFile('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Windows', '/v', 'Device'], { windowsHide: true }, (err, out) => {
            const m = !err && /Device\s+REG_SZ\s+([^,\r\n]+)/.exec(out);
            resolve(m ? m[1].trim() : null);
        });
    });
}

async function listPrinters(wc) {
    const [printers, def] = await Promise.all([wc.getPrintersAsync(), defaultPrinter()]);
    return printers.map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: p.name === def }));
}

async function isPrinter(wc, name) {
    return (await wc.getPrintersAsync()).some((p) => p.name === name);
}

function initPrint() {
    ipcMain.handle('print:printers', (e) => listPrinters(e.sender));

    // The printer driver's own preferences window (paper tray, quality…).
    // Settings made there apply to the next job, as with Acrobat's Properties.
    ipcMain.handle('print:properties', async (e, name) => {
        if (!(await isPrinter(e.sender, name))) return false;
        spawn('rundll32.exe', ['printui.dll,PrintUIEntry', '/e', '/n', name], { detached: true, stdio: 'ignore' }).unref();
        return true;
    });

    // job: { data, password, title, printer, copies, collate, grayscale, duplex,
    //        pages (0-based), layout (printlayout.js opts), paperSize [w, h] pt }
    ipcMain.handle('print:document', async (e, job) => {
        if (!(await isPrinter(e.sender, job.printer))) return { ok: false, error: 'ไม่พบเครื่องพิมพ์ที่เลือก' };
        const pages = (job.pages || []).filter((n) => Number.isInteger(n) && n >= 0);
        if (!pages.length) return { ok: false, error: 'ไม่มีหน้าที่จะพิมพ์' };
        const win = new BrowserWindow({
            show: false,
            title: job.title || 'PDF Reader',
            webPreferences: {
                preload: path.join(__dirname, 'print-preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
            },
        });
        const sender = e.sender;
        try {
            await win.loadURL('app://local/src/print/index.html');
            win.webContents.ipc.on('print:progress', (_ev, status) => {
                if (!sender.isDestroyed()) sender.send('print:progress', status);
            });
            const rendered = new Promise((resolve) => win.webContents.ipc.once('print:rendered', (_ev, result) => resolve(result)));
            win.webContents.send('print:load', {
                data: job.data,
                password: job.password,
                pages,
                layout: job.layout,
                grayscale: Boolean(job.grayscale),
            });
            const result = await rendered;
            if (result.error) return { ok: false, error: result.error };

            const [w, h] = job.paperSize;
            return await new Promise((resolve) => {
                win.webContents.print(
                    {
                        silent: true,
                        deviceName: job.printer,
                        copies: Math.min(999, Math.max(1, Math.round(Number(job.copies) || 1))),
                        collate: job.collate !== false,
                        color: !job.grayscale,
                        duplexMode: DUPLEX.has(job.duplex) ? job.duplex : 'simplex',
                        landscape: false, // landscape sheets are already turned onto portrait paper
                        pageSize: { width: Math.round(w * MICRONS_PER_POINT), height: Math.round(h * MICRONS_PER_POINT) },
                        margins: { marginType: 'none' },
                        printBackground: true,
                    },
                    (success, reason) => resolve({ ok: success, error: success ? null : reason }),
                );
            });
        } finally {
            if (!win.isDestroyed()) win.destroy();
        }
    });
}

module.exports = { initPrint };
