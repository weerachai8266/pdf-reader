'use strict';

// v0.11: document tabs (open another file in a tab, switch, unsaved marker,
// close with prompt, reuse of an empty tab). Called from smoke.js.

const path = require('node:path');
const fs = require('node:fs');

module.exports = async function testTabs(t) {
    const { win, bw, tabs, js, check, waitFor, sleep, outDir, inputPdf, savedPdf, setOpenPaths, setMessageBoxChoice } = t;
    const strip = (code) => bw.webContents.executeJavaScript(code);
    const until = async (fn, ms = 15000) => {
        for (let n = 0; n < ms / 150; n++) {
            if (await Promise.resolve().then(fn).catch(() => false)) return true;
            await sleep(150);
        }
        return false;
    };
    const loaded = (name) => waitFor(win, `document.getElementById('file-name').textContent === ${JSON.stringify(name)} && !!document.querySelector('.page canvas')`, 20000);
    const names = () => strip(`[...document.querySelectorAll('.tab .tab-name')].map((e) => e.textContent).join('|')`);
    const menu = (command) => win.webContents.send('menu:command', command);
    const pdf = (file) => ({ path: file, name: path.basename(file), data: new Uint8Array(fs.readFileSync(file)) });

    // ---- start from a single tab showing thai.pdf ----
    setMessageBoxChoice(0);
    while (tabs.list().length > 1) tabs.closeActive();
    win.webContents.send('file:opened', pdf(inputPdf));
    await sleep(300);
    await js(`document.getElementById('dlg-confirm').open && document.getElementById('dlg-confirm-ok').click()`);
    check('one tab with thai.pdf', (await loaded('thai.pdf')) && tabs.list().length === 1);

    // ---- File > Open with a document open: new tab ----
    setOpenPaths([savedPdf]);
    menu('open');
    check('second file opens in a new tab', await until(() => tabs.list().length === 2 && tabs.list()[1].active), JSON.stringify(tabs.list()));
    check('new tab shows its file', await loaded('saved.pdf'));
    check('first tab keeps its document', (await tabs.allContents()[0].executeJavaScript(`document.getElementById('file-name').textContent`)) === 'thai.pdf');
    check('strip lists both tabs', await until(async () => (await names()) === 'thai.pdf|saved.pdf'), await names());
    check('window title follows the active tab', bw.getTitle().includes('saved.pdf'), bw.getTitle());

    // ---- the same file again switches to its tab ----
    setOpenPaths([inputPdf]);
    menu('open');
    check('reopening an open file switches to its tab', await until(() => tabs.list().length === 2 && tabs.list()[0].active), JSON.stringify(tabs.list()));

    // ---- clicking a tab in the strip ----
    await strip(`document.querySelectorAll('.tab')[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`);
    check('clicking a tab activates it', await until(() => tabs.list()[1].active));
    check('next/previous tab cycles', await until(() => {
        tabs.nextTab();
        return tabs.list()[0].active;
    }));
    tabs.prevTab();

    // ---- unsaved marker and the close prompt ----
    await waitFor(win, `!!document.querySelector('#thumbs [data-action="rotate-right"]')`);
    await js(`document.querySelector('#thumbs [data-action="rotate-right"]').click()`);
    check('unsaved tab is marked in the strip', await until(() => strip(`!!document.querySelectorAll('.tab')[1].querySelector('.tab-dirty')`)));
    await sleep(500);
    fs.writeFileSync(path.join(outDir, 'tabs.png'), (await bw.capturePage()).toPNG());
    fs.writeFileSync(path.join(outDir, 'tabs-doc.png'), (await win.capturePage()).toPNG());
    setMessageBoxChoice(1); // Cancel
    tabs.closeActive();
    check('Cancel keeps an unsaved tab open', tabs.list().length === 2);
    setMessageBoxChoice(0); // Don't Save
    await strip(`document.querySelectorAll('.tab')[1].querySelector('.tab-close').click()`);
    check('close button closes the tab', await until(() => tabs.list().length === 1 && tabs.list()[0].active && tabs.list()[0].name === 'thai.pdf'));

    // ---- closing the last tab leaves an empty one, which is reused ----
    tabs.closeActive();
    check('closing the last tab leaves an empty tab', await until(() => tabs.list().length === 1 && !tabs.list()[0].name));
    check('empty tab shows the start screen', await waitFor(win, `document.getElementById('app-version').textContent !== '' && !document.getElementById('empty-state').hidden`, 20000));
    tabs.openInTab(pdf(savedPdf));
    check('an empty tab is reused for the next file', await until(() => tabs.list().length === 1 && tabs.list()[0].name === 'saved.pdf'));
    check('reused tab shows the file', await loaded('saved.pdf'));
    tabs.newTab();
    check('New Tab adds an empty tab', await until(() => tabs.list().length === 2 && tabs.list()[1].active && !tabs.list()[1].name));
    tabs.closeActive();
};
