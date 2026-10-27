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
                item('&Combine Files…', 'merge'),
                { type: 'separator' },
                item('&Save', 'save', 'Ctrl+S'),
                item('Save &As…', 'save-as', 'Ctrl+Shift+S'),
                { type: 'separator' },
                item('&Print…', 'print', 'Ctrl+P'),
                { type: 'separator' },
                { label: 'E&xit', role: 'quit' },
            ],
        },
        {
            label: '&Edit',
            submenu: [
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
                item('&Eraser', 'tool-eraser'),
                { type: 'separator' },
                item('&Recognize Text (OCR)…', 'ocr'),
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
