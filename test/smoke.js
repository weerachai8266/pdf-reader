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
// Folder picker (Split / Extract as separate files), or the files picked
// for Create PDF when a test set them.
let nextFolder = outDir;
let nextOpenPaths = null;
dialog.showOpenDialog = async () => {
    const filePaths = nextOpenPaths || [nextFolder];
    nextOpenPaths = null;
    return { canceled: false, filePaths };
};

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

// Keep Digital IDs, trusted certificates and the converter profile out of
// the real user profile.
app.setPath('userData', path.join(outDir, 'userData'));

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

    win.webContents.send('menu:command', 'save-as');
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

    // SMOKE_ONLY=doctools|convert|editing|digsig skips the slower earlier suites while iterating.
    if (!process.env.SMOKE_ONLY) {
        await testForms(win, js);
        await testPrint(win, js);
        await testOcr(win, js);
    }
    const only = process.env.SMOKE_ONLY;
    if (!only || only === 'doctools') await require('./doctools.js')({
        win, js, check, waitFor, sleep, outDir, inputPdf,
        setSavePath: (file) => { nextSavePath = file; },
        setFolder: (folder) => { nextFolder = folder; },
    });
    if (!only || only === 'convert') await require('./convert.js')({
        win, js, check, waitFor, sleep, outDir, inputPdf,
        setSavePath: (file) => { nextSavePath = file; },
        setFolder: (folder) => { nextFolder = folder; },
        setOpenPaths: (paths) => { nextOpenPaths = paths; },
    });
    if (!only || only === 'editing') await require('./editing.js')({
        win, js, check, waitFor, sleep, outDir, inputPdf,
        setSavePath: (file) => { nextSavePath = file; },
    });
    if (!only || only === 'digsig') await require('./digsig.js')({
        win, js, check, waitFor, sleep, outDir, inputPdf,
        setSavePath: (file) => { nextSavePath = file; },
        setOpenPaths: (paths) => { nextOpenPaths = paths; },
    });

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
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('app://')).webContents.send('menu:command', 'save-as');
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
    const formShown = await waitFor(win, `document.querySelectorAll('.annotationLayer input, .annotationLayer select').length >= 4`);
    check('form fields rendered', formShown, formShown ? '' : await js(`JSON.stringify({ file: document.getElementById('file-name').textContent, title: document.title, dialogs: [...document.querySelectorAll('dialog[open]')].map((d) => d.id), toast: document.getElementById('toast').textContent, busy: document.body.classList.contains('is-busy') })`));
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
    const reopened = await waitFor(win, `document.getElementById('file-name').textContent === 'form-filled.pdf' && document.querySelector('.textWidgetAnnotation input')?.value === ${JSON.stringify(THAI)}`);
    check('filled form reopens with value', reopened, reopened ? '' : await js(`JSON.stringify({ file: document.getElementById('file-name').textContent, title: document.title, dialogs: [...document.querySelectorAll('dialog[open]')].map((d) => d.id) })`));
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

// An image-only PDF, like a scanner produces: Thai + English text drawn
// into a picture, no text layer at all.
async function makeScannedPdf(file) {
    const win = new BrowserWindow({ show: false, width: 900, height: 700, useContentSize: true });
    const html = `<!doctype html><meta charset="utf-8"><style>
        body{margin:60px;font-family:Tahoma;font-size:30px;line-height:1.8;color:#111;background:#fff}</style>
        <p>ใบแจ้งหนี้ เลขที่ 2569/0457</p>
        <p>บริษัท ตัวอย่างการค้า จำกัด</p>
        <p>ยอดรวมทั้งสิ้น 1,250.50 บาท</p>
        <p>กรุณาชำระภายในวันที่ 15 พฤศจิกายน</p>
        <p>Invoice total amount due</p>`;
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await sleep(300);
    const image = await win.capturePage();
    const png = image.toPNG();
    const { width, height } = image.getSize();
    win.destroy();
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const img = await doc.embedPng(png);
    // Keep the capture's aspect ratio (top of an A4 page, like a scan).
    const w = 595;
    const h = (w * height) / width;
    page.drawImage(img, { x: 0, y: 842 - h, width: w, height: h });
    fs.writeFileSync(file, await doc.save());
}

async function testOcr(win, js) {
    const scanned = path.join(outDir, 'scanned.pdf');
    const ocrSaved = path.join(outDir, 'scanned-ocr.pdf');
    await makeScannedPdf(scanned);
    win.webContents.send('file:opened', { path: scanned, name: 'scanned.pdf', data: new Uint8Array(fs.readFileSync(scanned)) });
    check('scanned file hint shown', await waitFor(win, `document.getElementById('toast').textContent.includes('ภาพสแกน')`));

    const started = Date.now();
    await js(`document.querySelector('[data-action="ocr"]').click()`);
    await waitFor(win, `document.getElementById('dlg-ocr').open`);
    await js(`document.querySelector('#dlg-ocr button[value="ok"]').click()`);
    const finished = await waitFor(win, `!document.getElementById('dlg-progress').open && /OCR (เสร็จ|ไม่สำเร็จ)/.test(document.getElementById('toast').textContent)`, 120000);
    check('OCR finished', finished, `${((Date.now() - started) / 1000).toFixed(1)}s — ${await js(`document.getElementById('toast').textContent`)}`);

    const search = async (q) => {
        await js(`(() => { document.querySelector('[data-action="show-search"]').click();
            const i = document.getElementById('search-input'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); })()`);
        await waitFor(win, `document.getElementById('search-status').textContent !== '' && !document.getElementById('search-status').textContent.startsWith('กำลัง')`);
        await sleep(400);
        return js(`document.querySelectorAll('#search-results li').length`);
    };
    for (const q of ['ใบแจ้งหนี้', 'บริษัท', '1,250.50', 'Invoice']) {
        check(`OCR text searchable: ${q}`, (await search(q)) >= 1);
    }
    check('OCR marks document changed', await js(`document.title.startsWith('●')`));
    fs.writeFileSync(path.join(outDir, 'ocr.png'), (await win.capturePage()).toPNG());
    console.log('  OCR text layer:', await js(`document.querySelector('.textLayer')?.textContent.slice(0, 200)`));

    if (await saveAs(js, ocrSaved)) {
        win.webContents.send('file:opened', { path: ocrSaved, name: 'scanned-ocr.pdf', data: new Uint8Array(fs.readFileSync(ocrSaved)) });
        await waitFor(win, `document.getElementById('file-name').textContent === 'scanned-ocr.pdf'`);
        check('saved OCR file keeps text layer', await waitFor(win, `document.querySelector('.textLayer')?.textContent.includes('บริษัท') && !document.body.classList.contains('is-busy')`));
    } else {
        check('saved OCR file', false);
    }
}

app.whenReady().then(() => run().catch((err) => {
    console.error(err);
    app.exit(1);
}));
