'use strict';

// Native application menu (English, Acrobat-style). Commands are forwarded
// to the renderer, which owns the document; accelerators are display-only
// (registerAccelerator: false) because the renderer already handles the
// same keys and would otherwise run each command twice.

const { Menu, app, dialog } = require('electron');

function buildMenu(getWindow, { checkForUpdates }) {
    const send = (command) => () => getWindow()?.webContents.send('menu:command', command);
    const item = (label, command, accelerator) => ({
        label,
        click: send(command),
        ...(accelerator ? { accelerator, registerAccelerator: false } : {}),
    });

    const template = [
        {
            label: '&File',
            submenu: [
                item('&Open…', 'open', 'Ctrl+O'),
                item('&Create PDF from File…', 'create-pdf'),
                item('&Combine Files…', 'merge'),
                { type: 'separator' },
                item('&Save', 'save', 'Ctrl+S'),
                item('Save &As…', 'save-as', 'Ctrl+Shift+S'),
                { type: 'separator' },
                {
                    label: 'E&xport To',
                    submenu: [
                        item('&Word Document (.docx)…', 'export-docx'),
                        item('&Image (PNG/JPEG)…', 'export-images'),
                        item('Plain &Text (.txt)…', 'export-text'),
                    ],
                },
                { type: 'separator' },
                item('&Print…', 'print', 'Ctrl+P'),
                { type: 'separator' },
                { label: 'E&xit', role: 'quit' },
            ],
        },
        {
            label: '&Edit',
            submenu: [
                item('&Undo Edit', 'undo', 'Ctrl+Z'),
                { type: 'separator' },
                { label: 'Cu&t', role: 'cut' },
                { label: '&Copy', role: 'copy' },
                { label: '&Paste', role: 'paste' },
                { label: 'Select &All', role: 'selectAll' },
                { type: 'separator' },
                item('&Find…', 'find', 'Ctrl+F'),
            ],
        },
        {
            label: '&View',
            submenu: [
                item('Zoom &In', 'zoom-in', 'Ctrl+='),
                item('Zoom &Out', 'zoom-out', 'Ctrl+-'),
                item('Fit &Width', 'fit-width', 'Ctrl+0'),
                item('Fit &Page', 'fit-page'),
                { type: 'separator' },
                item('&Previous Page', 'prev-page', 'Left'),
                item('&Next Page', 'next-page', 'Right'),
                item('&First Page', 'first-page', 'Home'),
                item('&Last Page', 'last-page', 'End'),
                { type: 'separator' },
                item('Show/Hide &Sidebar', 'toggle-sidebar'),
                { label: '&Full Screen', role: 'togglefullscreen' },
            ],
        },
        {
            label: '&Tools',
            submenu: [
                item('&Select Text', 'tool-select', 'V'),
                item('&Highlight', 'tool-highlight', 'H'),
                item('Add &Note', 'tool-note', 'N'),
                item('&Fill & Sign…', 'signature'),
                item('Sign with &Certificate…', 'cert-sign'),
                { type: 'separator' },
                item('Edit &Text && Images', 'tool-edit'),
                item('Add Te&xt', 'tool-addtext'),
                item('Add &Image…', 'add-image'),
                item('&Eraser', 'tool-eraser'),
                { type: 'separator' },
                item('&Recognize Text (OCR)…', 'ocr'),
                item('Com&pare Files…', 'compare'),
            ],
        },
        {
            label: '&Document',
            submenu: [
                item('E&xtract Pages…', 'extract'),
                item('&Split Document…', 'split'),
                { type: 'separator' },
                item('Add Page &Numbers…', 'page-numbers'),
                item('&Header && Footer…', 'header-footer'),
                item('Add &Watermark…', 'watermark'),
                { type: 'separator' },
                item('&Mark for Redaction', 'tool-redact'),
                item('&Apply Redactions…', 'apply-redactions'),
                { type: 'separator' },
                item('&Reduce File Size…', 'compress'),
                item('&Protect with Password…', 'protect'),
                item('Remove Se&curity…', 'remove-security'),
            ],
        },
        {
            label: '&Help',
            submenu: [
                { label: 'Check for &Updates', click: () => checkForUpdates() },
                { type: 'separator' },
                {
                    label: '&About PDF Reader',
                    click: () => dialog.showMessageBox(getWindow(), {
                        type: 'info',
                        title: 'About PDF Reader',
                        message: `PDF Reader ${require('../package.json').version}`,
                        detail: `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
                    }),
                },
            ],
        },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu };
