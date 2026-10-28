'use strict';

// Document tabs. The window's own page is the tab strip (src/tabs/index.html);
// every open document runs the full app page in its own WebContentsView, so
// documents never share renderer state (undo, search, OCR, zoom…).
//
// Opening a file: a tab that already shows the same file is activated; an
// empty active tab is reused; otherwise a new tab is created.

const { BrowserWindow, WebContentsView, dialog, shell } = require('electron');
const path = require('node:path');

const APP_ROOT = path.join(__dirname, '..');
const APP_NAME = 'PDF Reader';
const STRIP_H = 36; // keep in sync with --tabs-h in src/css/tabs/index.css

let win = null;
let tabs = []; // { id, view, name, path, dirty, ready, pending }
let activeId = null;
let nextId = 1;

const DOC_PREFS = {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
};

function createWindow() {
    win = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 720,
        minHeight: 480,
        backgroundColor: '#3b3f46',
        icon: path.join(APP_ROOT, 'build', 'icon.ico'),
        show: false,
        webPreferences: { ...DOC_PREFS, preload: path.join(__dirname, 'tabs-preload.js') },
    });
    win.loadURL('app://local/src/tabs/index.html');
    win.once('ready-to-show', () => win.show());
    win.on('page-title-updated', (e) => e.preventDefault());
    win.on('resize', layout);
    win.on('close', (e) => {
        const dirty = tabs.filter((t) => t.dirty);
        if (!dirty.length) return;
        const choice = dialog.showMessageBoxSync(win, {
            type: 'warning',
            buttons: ["Don't Save", 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            message: dirty.length === 1
                ? `เอกสาร ${dirty[0].name || ''} มีการแก้ไขที่ยังไม่ได้บันทึก`
                : `มี ${dirty.length} เอกสารที่ยังไม่ได้บันทึกการแก้ไข`,
        });
        if (choice !== 0) e.preventDefault();
    });
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    return win;
}

function guard(wc) {
    wc.on('will-navigate', (e) => e.preventDefault());
    // Links inside PDFs open in the default browser / mail client.
    wc.setWindowOpenHandler(({ url }) => {
        if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
}

function layout() {
    if (!win || win.isDestroyed()) return;
    const { width, height } = win.getContentBounds();
    for (const t of tabs) {
        t.view.setBounds({ x: 0, y: STRIP_H, width, height: Math.max(0, height - STRIP_H) });
        t.view.setVisible(t.id === activeId);
    }
}

function sendState() {
    if (!win || win.isDestroyed()) return;
    const active = activeTab();
    win.setTitle(active?.name ? `${active.dirty ? '● ' : ''}${active.name} — ${APP_NAME}` : APP_NAME);
    win.webContents.send('tabs:state', {
        active: activeId,
        tabs: tabs.map(({ id, name, path: p, dirty }) => ({ id, name, path: p, dirty })),
    });
}

function activeTab() {
    return tabs.find((t) => t.id === activeId) || null;
}

function tabOf(wc) {
    return tabs.find((t) => t.view.webContents === wc) || null;
}

// file: { path, name, data } to load, or { createPaths } (Create PDF from
// Office/image files), or null for an empty tab.
function newTab(file = null) {
    const view = new WebContentsView({ webPreferences: DOC_PREFS });
    view.setBackgroundColor('#3b3f46');
    const tab = { id: nextId++, view, name: file?.name || '', path: file?.path || null, dirty: false, ready: false, pending: file };
    guard(view.webContents);
    view.webContents.on('render-process-gone', () => {
        tab.ready = false;
    });
    if (process.argv.includes('--devtools')) view.webContents.openDevTools({ mode: 'detach' });
    view.webContents.loadURL('app://local/src/index.html');
    tabs.push(tab);
    win.contentView.addChildView(view);
    activate(tab.id);
    return tab;
}

function activate(id) {
    if (!tabs.some((t) => t.id === id)) return;
    activeId = id;
    layout();
    activeTab().view.webContents.focus();
    sendState();
}

function samePath(a, b) {
    return !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function openInTab(file) {
    if (file.path) {
        const open = tabs.find((t) => samePath(t.path, file.path));
        if (open) return activate(open.id);
    }
    const cur = activeTab();
    if (cur && !cur.name && !cur.pending && !file.createPaths) {
        cur.name = file.name;
        cur.path = file.path || null;
        if (cur.ready) cur.view.webContents.send('file:opened', file);
        else cur.pending = file;
        sendState();
        return;
    }
    newTab(file);
}

function closeTab(id) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    if (tab.dirty) {
        const choice = dialog.showMessageBoxSync(win, {
            type: 'warning',
            buttons: ["Don't Save", 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            message: `เอกสาร ${tab.name || ''} มีการแก้ไขที่ยังไม่ได้บันทึก`,
        });
        if (choice !== 0) return;
    }
    const index = tabs.indexOf(tab);
    tabs = tabs.filter((t) => t !== tab);
    win.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
    if (!tabs.length) {
        newTab();
        return;
    }
    if (activeId === id) activate(tabs[Math.min(index, tabs.length - 1)].id);
    else sendState();
}

function cycle(step) {
    if (tabs.length < 2) return;
    const i = tabs.findIndex((t) => t.id === activeId);
    activate(tabs[(i + step + tabs.length) % tabs.length].id);
}

// ---- reports from a document tab ----

// The renderer asks once on start-up for the file this tab was opened with.
function takePending(wc) {
    const tab = tabOf(wc);
    if (!tab) return null;
    tab.ready = true;
    const file = tab.pending;
    tab.pending = null;
    return file;
}

function setDocInfo(wc, { name, path: p, dirty }) {
    const tab = tabOf(wc);
    if (!tab) return;
    tab.name = name || '';
    tab.path = p || null;
    tab.dirty = Boolean(dirty);
    sendState();
}

module.exports = {
    createWindow,
    newTab,
    openInTab,
    closeTab,
    activate,
    nextTab: () => cycle(1),
    prevTab: () => cycle(-1),
    closeActive: () => activeId && closeTab(activeId),
    takePending,
    setDocInfo,
    refresh: sendState,
    getWindow: () => win,
    activeContents: () => activeTab()?.view.webContents || null,
    allContents: () => tabs.map((t) => t.view.webContents),
    list: () => tabs.map(({ id, name, path: p, dirty }) => ({ id, name, path: p, dirty, active: id === activeId })),
};
