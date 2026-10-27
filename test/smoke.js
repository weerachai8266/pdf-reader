'use strict';

// End-to-end smoke test: builds a Thai PDF, opens it in the real app,
// searches, highlights, adds a note, rotates and deletes a page, saves,
// and checks the saved file. Run with `npm test`.

const { app, BrowserWindow, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-reader-smoke-'));
const inputPdf = path.join(outDir, 'thai.pdf');
const savedPdf = path.join(outDir, 'saved.pdf');
const shot = path.join(outDir, 'screenshot.png');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

dialog.showSaveDialog = async () => ({ canceled: false, filePath: savedPdf });

// main.js must be loaded before the app is ready (it registers app://).
require('../main/main.js');

async function makeThaiPdf() {
    const win = new BrowserWindow({ show: false });
    const body = [1, 2, 3].map((n) => `
        <section>
            <h1>หน้าที่ ${n}: ทดสอบภาษาไทย</h1>
            <p>ภาษาไทยเป็นภาษาที่มีสระบน สระล่าง และวรรณยุกต์ เช่น น้ำ ผู้ใหญ่ กำลัง ปฏิบัติ ฤดูกาล</p>
            <p>The quick brown fox jumps over the lazy dog. คำค้นหาพิเศษ${n}</p>
        </section>`).join('');
    const html = `<!doctype html><meta charset="utf-8"><style>
        body{font-family:Tahoma,'Leelawadee UI',sans-serif;font-size:20px}
        section{page-break-after:always}</style>${body}`;
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    fs.writeFileSync(inputPdf, await win.webContents.printToPDF({ pageSize: 'A4' }));
    win.destroy();
}

async function waitFor(win, expr, timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (await win.webContents.executeJavaScript(expr).catch(() => false)) return true;
        await sleep(150);
    }
    return false;
}

async function run() {
    await makeThaiPdf();
    let win;
    for (let t = 0; t < 50 && !win; t++) {
        win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('app://'));
        await sleep(100);
    }
    const js = (code) => win.webContents.executeJavaScript(code);
    win.on('closed', () => console.log('main window closed'));
    win.webContents.on('render-process-gone', (_e, d) => console.log('renderer gone', d));
    win.webContents.on('console-message', (e) => {
        if (e.level === 'error' || e.level === 'warning') console.log(`[renderer ${e.level}] ${e.message}`);
    });
    await waitFor(win, `document.getElementById('app-version').textContent !== ''`);
    win.webContents.send('file:opened', { path: inputPdf, name: 'thai.pdf', data: new Uint8Array(fs.readFileSync(inputPdf)) });

    check('pages laid out', await waitFor(win, `document.querySelectorAll('#pages .page').length === 3`));
    check('first page rendered', await waitFor(win, `!!document.querySelector('.page canvas')`));
    check('text layer has Thai', await waitFor(win, `document.querySelector('.textLayer')?.textContent.includes('ภาษาไทย')`));
    check('thumbnails rendered', await waitFor(win, `document.querySelectorAll('#thumbs canvas').length >= 1`));
    check('version shown', await waitFor(win, `/^v0\\.\\d+\\.\\d+$/.test(document.getElementById('app-version').textContent)`));

    const search = (q) => js(`(() => {
        document.querySelector('[data-action="show-search"]').click();
        const i = document.getElementById('search-input'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input'));
    })()`);
    // The generated PDF loses tone marks (Chrome maps them to U+0000), so
    // this exercises the tone-insensitive fallback.
    await search('น้ำ');
    check('search "น้ำ" finds 3', await waitFor(win, `document.querySelectorAll('#search-results li').length === 3`),
        await js(`document.getElementById('search-status').textContent`));
    await search('ภาษาไทย');
    check('search "ภาษาไทย" exact', await waitFor(win, `document.querySelectorAll('#search-results li').length >= 3 && !document.getElementById('search-status').textContent.includes('ไม่สน')`),
        await js(`document.getElementById('search-status').textContent`));
    await search('คำค้นหาพิเศษ2');
    check('search finds page 2 only', await waitFor(win, `document.querySelectorAll('#search-results li').length === 1 && document.querySelector('.hit-page').textContent === 'หน้า 2'`));

    // Highlight: select the first Thai span on page 1, then click a colour.
    await js(`(() => {
        const span = [...document.querySelector('.page .textLayer').querySelectorAll('span')].find(s => s.textContent.includes('ภาษาไทย'));
        const r = document.createRange(); r.selectNodeContents(span);
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
        document.querySelector('[data-color="green"]').click();
    })()`);
    check('highlight drawn', await waitFor(win, `document.querySelectorAll('.annot-highlight.hl-green').length >= 1`));

    // Note: choose tool, click page, fill dialog.
    await js(`document.querySelector('[data-tool="note"]').click();
        const p = document.querySelector('.page'); const r = p.getBoundingClientRect();
        document.querySelector('.page .annot-layer').dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 60, clientY: r.top + 60 }));`);
    await waitFor(win, `document.getElementById('dlg-prompt').open`);
    await js(`document.getElementById('dlg-prompt-textarea').value = 'โน้ตทดสอบ ภาษาไทย';
        document.getElementById('dlg-prompt-form').requestSubmit();`);
    check('note placed', await waitFor(win, `document.querySelectorAll('.annot-note').length === 1`));

    // Page management: rotate page 1, delete page 3.
    await js(`document.querySelector('#thumbs .thumb [data-action="rotate-right"]').click()`);
    await waitFor(win, `document.querySelector('#thumbs .thumb').dataset.rotation === '90'`);
    await js(`document.querySelectorAll('#thumbs .thumb')[2].querySelector('[data-action="delete"]').click()`);
    check('page deleted', await waitFor(win, `document.querySelectorAll('#pages .page').length === 2`));
    check('highlight survives rotation', await waitFor(win, `document.querySelectorAll('.annot-highlight').length >= 1`));

    await sleep(800);
    fs.writeFileSync(shot, (await win.capturePage()).toPNG());

    await js(`document.querySelector('[data-action="save-as"]').click()`);
    const savedOk = await (async () => {
        for (let t = 0; t < 60; t++) {
            if (fs.existsSync(savedPdf) && fs.statSync(savedPdf).size > 0) return true;
            await sleep(200);
        }
        return false;
    })();
    check('file saved', savedOk);
    if (savedOk) {
        const { PDFDocument, PDFName } = await import('pdf-lib');
        await sleep(300);
        const doc = await PDFDocument.load(fs.readFileSync(savedPdf));
        check('saved has 2 pages', doc.getPageCount() === 2, String(doc.getPageCount()));
        check('page 1 rotated 90', doc.getPage(0).getRotation().angle === 90);
        const annots = doc.getPage(0).node.Annots();
        check('note saved as /Text annotation', !!annots && annots.size() === 1);
    }
    check('dirty cleared after save', await waitFor(win, `!document.title.startsWith('●')`));

    // Reopen the saved file to eyeball the flattened highlight and the note.
    if (savedOk) {
        win.webContents.send('file:opened', { path: savedPdf, name: 'saved.pdf', data: new Uint8Array(fs.readFileSync(savedPdf)) });
        check('saved file reopens', await waitFor(win, `document.getElementById('file-name').textContent === 'saved.pdf' && !!document.querySelector('.page canvas')`));
        await js(`document.querySelector('#viewer').scrollTop = 0`);
        await sleep(1200);
        fs.writeFileSync(path.join(outDir, 'reopened.png'), (await win.capturePage()).toPNG());
    }

    console.log(`\nscreenshot: ${shot}\noutput dir: ${outDir}`);
    const failed = results.filter((r) => !r.ok).length;
    console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
    win.removeAllListeners('close');
    app.exit(failed ? 1 : 0);
}

app.whenReady().then(() => run().catch((err) => {
    console.error(err);
    app.exit(1);
}));
