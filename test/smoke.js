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

let nextSavePath = savedPdf;
dialog.showSaveDialog = async () => ({ canceled: false, filePath: nextSavePath });

// Printing is redirected to a PDF file so the test can inspect the job
// without a printer or the Windows print dialog.
const printOut = path.join(outDir, 'printed.pdf');
app.on('web-contents-created', (_e, wc) => {
    wc.print = (_options, callback) => {
        wc.printToPDF({ margins: { marginType: 'none' }, pageSize: 'A4' }).then((buf) => {
            fs.writeFileSync(printOut, buf);
            callback(true, '');
        }, (err) => callback(false, String(err)));
    };
});

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

    await testForms(win, js);
    await testPrint(win, js);

    console.log(`\nscreenshot: ${shot}\noutput dir: ${outDir}`);
    const failed = results.filter((r) => !r.ok).length;
    console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
    win.removeAllListeners('close');
    app.exit(failed ? 1 : 0);
}

async function makeFormPdf(file) {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const form = doc.getForm();
    const name = form.createTextField('fullname');
    name.addToPage(page, { x: 60, y: 720, width: 300, height: 28 });
    const agree = form.createCheckBox('agree');
    agree.addToPage(page, { x: 60, y: 670, width: 20, height: 20 });
    const province = form.createDropdown('province');
    province.addOptions(['Bangkok', 'Chiang Mai', 'Phuket']);
    province.addToPage(page, { x: 60, y: 610, width: 200, height: 26 });
    const gender = form.createRadioGroup('gender');
    gender.addOptionToPage('male', page, { x: 60, y: 560, width: 18, height: 18 });
    gender.addOptionToPage('female', page, { x: 120, y: 560, width: 18, height: 18 });
    fs.writeFileSync(file, await doc.save());
}

async function saveAs(js, file) {
    nextSavePath = file;
    await js(`document.querySelector('[data-action="save-as"]').click()`);
    for (let t = 0; t < 60; t++) {
        if (fs.existsSync(file) && fs.statSync(file).size > 0) {
            await sleep(300);
            return true;
        }
        await sleep(200);
    }
    return false;
}

async function testForms(win, js) {
    const { PDFDocument } = await import('pdf-lib');
    const formPdf = path.join(outDir, 'form.pdf');
    const filledPdf = path.join(outDir, 'form-filled.pdf');
    const rotatedPdf = path.join(outDir, 'form-rotated.pdf');
    const THAI = 'สมชาย ใจดี น้ำใจ';
    await makeFormPdf(formPdf);
    const original = fs.readFileSync(formPdf);

    win.webContents.send('file:opened', { path: formPdf, name: 'form.pdf', data: new Uint8Array(original) });
    check('form fields rendered', await waitFor(win, `document.querySelectorAll('.annotationLayer input, .annotationLayer select').length >= 4`));
    const typeName = (value) => js(`(() => {
        const text = document.querySelector('.textWidgetAnnotation input');
        text.focus(); text.value = ${JSON.stringify(value)};
        text.dispatchEvent(new Event('input', { bubbles: true }));
        text.dispatchEvent(new Event('change', { bubbles: true }));
        text.blur();
    })()`);
    await typeName('John Smith');
    await js(`(() => {
        document.querySelector('.buttonWidgetAnnotation.checkBox input').click();
        const sel = document.querySelector('.choiceWidgetAnnotation select');
        sel.value = 'Chiang Mai';
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelectorAll('.buttonWidgetAnnotation.radioButton input')[1].click();
    })()`);
    check('filling marks dirty', await waitFor(win, `document.title.startsWith('●')`));
    check('checkbox shows checked', await js(`document.querySelector('.buttonWidgetAnnotation.checkBox input').checked && getComputedStyle(document.querySelector('.buttonWidgetAnnotation.checkBox input')).appearance === 'auto'`));

    // Latin-only values: pdf.js incremental save.
    const latinPdf = path.join(outDir, 'form-latin.pdf');
    if (await saveAs(js, latinPdf)) {
        const bytes = fs.readFileSync(latinPdf);
        check('latin form saved as incremental update', bytes.subarray(0, original.length).equals(original));
        const form = (await PDFDocument.load(bytes)).getForm();
        check('latin text value saved', form.getTextField('fullname').getText() === 'John Smith');
        check('checkbox saved', form.getCheckBox('agree').isChecked());
        check('dropdown saved', form.getDropdown('province').getSelected()[0] === 'Chiang Mai');
        check('radio saved', form.getRadioGroup('gender').getSelected() === 'female', String(form.getRadioGroup('gender').getSelected()));
    } else {
        check('latin form saved', false);
    }

    // Thai value: appearance must be drawn with an embedded Thai font.
    await typeName(THAI);
    const ok = await saveAs(js, filledPdf);
    check('Thai form saved', ok);
    if (ok) {
        const doc = await PDFDocument.load(fs.readFileSync(filledPdf));
        const form = doc.getForm();
        check('Thai text value saved', form.getTextField('fullname').getText() === THAI, form.getTextField('fullname').getText());
        check('other fields kept', form.getCheckBox('agree').isChecked() && form.getRadioGroup('gender').getSelected() === 'female');
        const { PDFDict, PDFName } = await import('pdf-lib');
        const fonts = doc.context.enumerateIndirectObjects()
            .map(([, obj]) => obj)
            .filter((obj) => obj instanceof PDFDict && obj.get(PDFName.of('Type'))?.toString() === '/Font')
            .map((obj) => String(obj.get(PDFName.of('BaseFont'))));
        check('Thai font embedded for field', fonts.some((f) => /Tahoma/i.test(f)), fonts.join(' '));
    }

    // Form values must also survive the pdf-lib path (page rotated).
    await js(`document.querySelector('#thumbs .thumb [data-action="rotate-right"]').click()`);
    await waitFor(win, `document.title.startsWith('●')`);
    const ok2 = await saveAs(js, rotatedPdf);
    if (ok2) {
        const doc = await PDFDocument.load(fs.readFileSync(rotatedPdf));
        check('form survives page rotation save', doc.getForm().getTextField('fullname').getText() === THAI && doc.getPage(0).getRotation().angle === 90);
    } else {
        check('form survives page rotation save', false, 'not saved');
    }

    // Reopen the filled file; the thumbnail shows the generated appearance.
    win.webContents.send('file:opened', { path: filledPdf, name: 'form-filled.pdf', data: new Uint8Array(fs.readFileSync(filledPdf)) });
    check('filled form reopens with value', await waitFor(win, `document.querySelector('.textWidgetAnnotation input')?.value === ${JSON.stringify(THAI)}`));
    await sleep(500);
    check('opening a form does not mark it changed', await js(`!document.title.startsWith('●')`));
    await sleep(1200);
    fs.writeFileSync(path.join(outDir, 'form.png'), (await win.capturePage()).toPNG());
}

async function testPrint(win, js) {
    // saved.pdf: 2 pages, page 1 rotated to landscape, with highlight + note.
    win.webContents.send('file:opened', { path: savedPdf, name: 'saved.pdf', data: new Uint8Array(fs.readFileSync(savedPdf)) });
    await waitFor(win, `document.getElementById('file-name').textContent === 'saved.pdf' && !!document.querySelector('.page canvas')`);
    await js(`document.querySelector('[data-action="print"]').click()`);
    let printed = false;
    for (let t = 0; t < 150 && !printed; t++) {
        printed = fs.existsSync(printOut) && fs.statSync(printOut).size > 0;
        await sleep(200);
    }
    check('print job produced', printed);
    if (printed) {
        const { PDFDocument } = await import('pdf-lib');
        await sleep(300);
        const doc = await PDFDocument.load(fs.readFileSync(printOut));
        check('print has one sheet per page', doc.getPageCount() === 2, String(doc.getPageCount()));
    }
    check('app not busy after print', await waitFor(win, `!document.body.classList.contains('is-busy')`));
}

app.whenReady().then(() => run().catch((err) => {
    console.error(err);
    app.exit(1);
}));
