'use strict';

// Printing. The renderer hands over the final PDF bytes (same output as
// Save, so forms, highlights and signatures print exactly as saved). A
// hidden window renders every page at print resolution with pdf.js, then
// the Windows print dialog takes over (printer, copies, page range).

const { BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

const CANCELLED = /cancel/i;

function initPrint() {
    ipcMain.handle('print:document', async (_e, { data, password, title }) => {
        const win = new BrowserWindow({
            show: false,
            title: title || 'PDF Reader',
            webPreferences: {
                preload: path.join(__dirname, 'print-preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
            },
        });
        try {
            await win.loadURL('app://local/src/print/index.html');
            const rendered = new Promise((resolve) => win.webContents.ipc.once('print:rendered', (_ev, result) => resolve(result)));
            win.webContents.send('print:load', { data, password });
            const result = await rendered;
            if (result.error) return { ok: false, error: result.error };

            return await new Promise((resolve) => {
                win.webContents.print(
                    { silent: false, printBackground: true, margins: { marginType: 'none' } },
                    (success, reason) => resolve({ ok: success, cancelled: !success && CANCELLED.test(reason || ''), error: success ? null : reason }),
                );
            });
        } finally {
            if (!win.isDestroyed()) win.destroy();
        }
    });
}

module.exports = { initPrint };
