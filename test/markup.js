'use strict';

// v0.12: underline, strikethrough, shapes, text boxes, stamps, Insert
// Pages, Flatten, Copy Text from Area. Called from smoke.js.

const path = require('node:path');
const fs = require('node:fs');
const { BrowserWindow, clipboard } = require('electron');

module.exports = async function testMarkup(t) {
    const { win, js, check, waitFor, sleep, outDir, inputPdf, setSavePath, setOpenPaths } = t;
    const open = async (file) => {
        const name = path.basename(file);
        win.webContents.send('file:opened', { path: file, name, data: new Uint8Array(fs.readFileSync(file)) });
        await sleep(300);
        await js(`document.getElementById('dlg-confirm').open && document.getElementById('dlg-confirm-ok').click()`);
        return waitFor(win, `document.getElementById('file-name').textContent === ${JSON.stringify(name)} && !document.body.classList.contains('is-busy') && !!document.querySelector('.page canvas')`);
    };
    const saveAs = async (file) => {
        setSavePath(file);
        win.webContents.send('menu:command', 'save-as');
        for (let i = 0; i < 100; i++) {
            if (fs.existsSync(file) && fs.statSync(file).size > 0) {
                await sleep(300);
                return true;
            }
            await sleep(200);
        }
        return false;
    };
    const search = async (q) => {
        await js(`(() => { document.querySelector('[data-action="show-search"]').click();
            const i = document.getElementById('search-input'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); })()`);
        await sleep(350);
        await waitFor(win, `document.getElementById('search-status').textContent !== '' && !document.getElementById('search-status').textContent.startsWith('กำลัง')`);
        await sleep(300);
        return js(`document.querySelectorAll('#search-results li').length`);
    };
    const toastText = () => js(`document.getElementById('toast').textContent`);
    // Selects the first text-layer span on page 1 containing `needle`, then
    // releases the mouse as a drag-select would.
    const selectText = (needle) => js(`(() => {
        const span = [...document.querySelectorAll('.page')[0].querySelectorAll('.textLayer span')].find((s) => s.textContent.includes(${JSON.stringify(needle)}));
        const r = document.createRange(); r.selectNodeContents(span);
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
        document.getElementById('viewer').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    })()`);
    // Real mouse drag on page 1, offsets in CSS px from its top-left corner.
    const drag = async (x1, y1, x2, y2) => {
        const o = await js(`(() => { const r = document.querySelectorAll('.page')[0].getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
        const at = (x, y) => ({ x: Math.round(o.x + x), y: Math.round(o.y + y) });
        win.webContents.sendInputEvent({ type: 'mouseDown', ...at(x1, y1), button: 'left', clickCount: 1 });
        for (let s = 1; s <= 6; s++) {
            win.webContents.sendInputEvent({ type: 'mouseMove', ...at(x1 + ((x2 - x1) * s) / 6, y1 + ((y2 - y1) * s) / 6), button: 'left' });
            await sleep(30);
        }
        win.webContents.sendInputEvent({ type: 'mouseUp', ...at(x2, y2), button: 'left', clickCount: 1 });
        await sleep(200);
    };
    const clickPage = (x, y) => js(`(() => { const r = document.querySelectorAll('.page')[0].getBoundingClientRect();
        document.querySelectorAll('.page')[0].querySelector('.annot-layer').dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + ${x}, clientY: r.top + ${y} })); })()`);
    // Drag box around a text span on page 1, in page offsets.
    const spanBox = (needle) => js(`(() => {
        const page = document.querySelectorAll('.page')[0].getBoundingClientRect();
        const span = [...document.querySelectorAll('.page')[0].querySelectorAll('.textLayer span')].find((s) => s.textContent.includes(${JSON.stringify(needle)}));
        const r = span.getBoundingClientRect();
        return { x1: r.left - page.left - 3, y1: r.top - page.top - 3, x2: r.right - page.left + 3, y2: r.bottom - page.top + 3 };
    })()`);

    // ---- underline / strikethrough ----------------------------------------------------------
    await open(inputPdf);
    await js(`document.getElementById('viewer').scrollTop = 0`);
    await js(`document.querySelector('[data-tool="underline"]').click()`);
    check('ink palette shown for underline', await js(`getComputedStyle(document.querySelector('[data-palette="ink"]')).display !== 'none' && getComputedStyle(document.querySelector('[data-palette="highlight"]')).display === 'none'`));
    await selectText('quick brown');
    check('underline drawn', await waitFor(win, `document.querySelectorAll('.annot-mark.ink-red').length >= 1`));
    await js(`document.querySelector('[data-tool="strike"]').click(); document.querySelector('[data-ink="blue"]').click()`);
    await selectText('ทดสอบภาษาไทย');
    check('strikethrough drawn in blue', await waitFor(win, `document.querySelectorAll('.annot-mark.ink-blue').length >= 1`));

    // ---- shapes -------------------------------------------------------------------------------
    await js(`document.querySelector('[data-ink="red"]').click(); document.getElementById('shape-button').click()`);
    check('shapes menu opens', await waitFor(win, `document.getElementById('shape-menu').matches(':popover-open')`));
    await js(`document.querySelector('#shape-menu [data-tool="rect"]').click()`);
    check('rectangle tool chosen, menu closed', await js(`document.body.dataset.tool === 'rect' && !document.getElementById('shape-menu').matches(':popover-open') && document.getElementById('shape-button').getAttribute('aria-pressed') === 'true'`));
    await drag(80, 420, 300, 520);
    check('rectangle drawn', await waitFor(win, `document.querySelectorAll('.annot-shape:not(.is-drawing)').length === 1`));
    win.webContents.send('menu:command', 'tool-arrow');
    await sleep(100);
    await drag(320, 560, 460, 480);
    check('arrow drawn', await waitFor(win, `document.querySelectorAll('.annot-shape:not(.is-drawing)').length === 2 && document.querySelectorAll('.annot-shape:not(.is-drawing)')[1].querySelector('.shape-stroke').getAttribute('d').split('M').length === 3`));
    win.webContents.send('menu:command', 'tool-ellipse');
    await sleep(100);
    await drag(480, 420, 560, 470);
    check('ellipse drawn', await waitFor(win, `document.querySelectorAll('.annot-shape:not(.is-drawing)').length === 3`));

    // ---- text box ----------------------------------------------------------------------------------
    win.webContents.send('menu:command', 'tool-textbox');
    await sleep(100);
    await clickPage(90, 600);
    check('text box prompt opens', await waitFor(win, `document.getElementById('dlg-prompt').open`));
    await js(`document.getElementById('dlg-prompt-textarea').value = 'กล่องข้อความทดสอบ\\nบรรทัดที่สอง Line 2';
        document.getElementById('dlg-prompt-form').requestSubmit();`);
    check('text box placed', await waitFor(win, `document.querySelector('.annot-textbox')?.textContent.includes('บรรทัดที่สอง')`));
    check('ink palette shown for the selected text box', await js(`document.body.dataset.tool === 'select' && getComputedStyle(document.querySelector('[data-palette="ink"]')).display !== 'none'`));
    await js(`document.querySelector('[data-ink="green"]').click()`);
    check('swatch recolours the selected text box', await waitFor(win, `document.querySelector('.annot-textbox').classList.contains('ink-green')`));
    check('selected swatch keeps its own colour', await js(`getComputedStyle(document.querySelector('[data-ink="green"]')).backgroundColor === 'rgb(26, 140, 51)'`));
    const before = await js(`(() => { const r = document.querySelector('.annot-textbox').getBoundingClientRect(); const p = document.querySelectorAll('.page')[0].getBoundingClientRect(); return { x: r.left - p.left, y: r.top - p.top, w: r.width, h: r.height }; })()`);
    await drag(before.x + before.w / 2, before.y + before.h / 2, before.x + before.w / 2 + 60, before.y + before.h / 2 + 30);
    const after = await js(`(() => { const r = document.querySelector('.annot-textbox').getBoundingClientRect(); const p = document.querySelectorAll('.page')[0].getBoundingClientRect(); return { x: r.left - p.left, y: r.top - p.top }; })()`);
    check('text box moves by drag', Math.abs(after.x - before.x - 60) < 3 && Math.abs(after.y - before.y - 30) < 3, JSON.stringify({ before, after }));

    // ---- stamp ------------------------------------------------------------------------------------
    await js(`document.querySelector('[data-action="stamp"]').click()`);
    check('stamp dialog opens', await waitFor(win, `document.getElementById('dlg-stamp').open`));
    await js(`document.querySelector('#stamp-presets [data-stamp="อนุมัติ"]').click()`);
    check('stamp waits to be placed', await waitFor(win, `!document.getElementById('dlg-stamp').open && document.body.dataset.tool === 'image'`));
    await clickPage(420, 680);
    check('stamp placed', await waitFor(win, `document.querySelectorAll('.annot-image').length === 1`));
    await sleep(800);
    fs.writeFileSync(path.join(outDir, 'markup.png'), (await win.capturePage()).toPNG());

    // ---- save: everything flattened into page 1 ---------------------------------------------------
    const markupPdf = path.join(outDir, 'markup.pdf');
    const saved = await saveAs(markupPdf);
    check('markup saved', saved);
    if (saved) {
        const { PDFDocument, PDFDict, PDFName } = await import('pdf-lib');
        const doc = await PDFDocument.load(fs.readFileSync(markupPdf));
        const objects = doc.context.enumerateIndirectObjects().map(([, o]) => o);
        const fonts = objects.filter((o) => o instanceof PDFDict && String(o.get(PDFName.of('Type'))) === '/Font').map((o) => String(o.get(PDFName.of('BaseFont'))));
        check('text box font embedded', fonts.some((f) => /Tahoma/i.test(f)), fonts.join(' '));
        check('stamp image embedded', objects.some((o) => o.dict && String(o.dict.get(PDFName.of('Subtype'))) === '/Image'));
        check('markup is flattened (no annotations)', !doc.getPage(0).node.Annots()?.size());
        await open(markupPdf);
        check('text box text searchable after save', (await search('กล่องข้อความทดสอบ')) === 1);
        await js(`document.getElementById('viewer').scrollTop = 0`);
        await sleep(1200);
        fs.writeFileSync(path.join(outDir, 'markup-saved.png'), (await win.capturePage()).toPNG());
    }

    // ---- copy text from area ------------------------------------------------------------------------
    await open(inputPdf);
    await js(`document.getElementById('viewer').scrollTop = 0`);
    await js(`document.querySelector('[data-tool="areatext"]').click()`);
    await clipboard.writeText('');
    const box = await spanBox('quick brown');
    await drag(box.x1, box.y1, box.x2, box.y2);
    check('area text copied', await waitFor(win, `document.getElementById('toast').textContent.startsWith('คัดลอกแล้ว')`, 10000), await toastText());
    const copied = await clipboard.readText();
    check('clipboard has the boxed line', /quick brown fox/.test(copied) && !copied.includes('ภาษาไทยเป็น'), JSON.stringify(copied));

    const scanned = path.join(outDir, 'area-scan.pdf');
    await makeScan(scanned, sleep);
    await open(scanned);
    await js(`document.getElementById('viewer').scrollTop = 0; document.querySelector('[data-tool="areatext"]').click()`);
    await clipboard.writeText('');
    const page = await js(`(() => { const r = document.querySelectorAll('.page')[0].getBoundingClientRect(); return { w: r.width, h: r.height }; })()`);
    // The scan's two lines sit in the top ~16% of the page.
    await drag(page.w * 0.03, page.h * 0.02, page.w * 0.95, page.h * 0.18);
    const ocrDone = await waitFor(win, `document.getElementById('toast').textContent.startsWith('คัดลอกแล้ว (อ่านด้วย OCR')`, 120000);
    const ocrText = await clipboard.readText();
    check('area OCR copies scanned text', ocrDone && /บริษัท/.test(ocrText) && /Invoice/.test(ocrText), JSON.stringify(ocrText) + ' / ' + await toastText());

    // ---- insert pages ---------------------------------------------------------------------------------
    await open(inputPdf);
    win.webContents.send('menu:command', 'insert-blank');
    check('insert dialog opens', await waitFor(win, `document.getElementById('dlg-insert').open && !document.getElementById('insert-count-field').hidden`));
    await js(`document.getElementById('insert-where').value = 'after'; document.getElementById('insert-page').value = '1';
        document.getElementById('insert-count').value = '2'; document.querySelector('#dlg-insert button[value="ok"]').click()`);
    check('blank pages inserted', await waitFor(win, `document.querySelectorAll('#pages .page').length === 5 && document.title.startsWith('●')`));
    setOpenPaths([inputPdf]);
    win.webContents.send('menu:command', 'insert-file');
    await waitFor(win, `document.getElementById('dlg-insert').open`);
    check('count hidden when inserting a file', await js(`document.getElementById('insert-count-field').hidden`));
    await js(`document.getElementById('insert-where').value = 'before'; document.getElementById('insert-page').value = '1';
        document.querySelector('#dlg-insert button[value="ok"]').click()`);
    check('file pages inserted', await waitFor(win, `document.querySelectorAll('#pages .page').length === 8`, 20000), await toastText());
    const insertedPdf = path.join(outDir, 'inserted.pdf');
    if (await saveAs(insertedPdf)) {
        const { PDFDocument } = await import('pdf-lib');
        const doc = await PDFDocument.load(fs.readFileSync(insertedPdf));
        check('inserted file has 8 pages', doc.getPageCount() === 8, String(doc.getPageCount()));
        await open(insertedPdf);
        check('page order: file, page 1, blank, blank, pages 2-3', await waitFor(win, `(() => {
            const text = (i) => document.querySelectorAll('.page')[i].querySelector('.textLayer')?.textContent || '';
            return document.querySelectorAll('.page')[0].querySelector('.textLayer') && text(0).includes('พิเศษ1');
        })()`, 10000));
        check('blank pages have no text', (await search('พิเศษ1')) === 2 && (await search('พิเศษ2')) === 2);
    } else {
        check('inserted file saved', false);
    }

    // ---- flatten ---------------------------------------------------------------------------------------
    const formPdf = path.join(outDir, 'flatten-form.pdf');
    await makeForm(formPdf);
    await open(formPdf);
    await waitFor(win, `!!document.querySelector('.textWidgetAnnotation input')`);
    await js(`(() => {
        const text = document.querySelector('.textWidgetAnnotation input');
        text.focus(); text.value = 'สมชาย ใจดี';
        text.dispatchEvent(new Event('input', { bubbles: true }));
        text.dispatchEvent(new Event('change', { bubbles: true }));
        text.blur();
        document.querySelector('.buttonWidgetAnnotation.checkBox input').click();
    })()`);
    await sleep(300);
    win.webContents.send('menu:command', 'flatten');
    await waitFor(win, `document.getElementById('dlg-confirm').open`);
    await js(`document.getElementById('dlg-confirm-ok').click()`);
    check('flatten finished', await waitFor(win, `/ฝังแล้ว/.test(document.getElementById('toast').textContent)`, 20000), await toastText());
    check('no form fields left after flatten', await js(`!document.querySelector('.annotationLayer input, .annotationLayer select')`));
    check('flatten marks the document changed', await js(`document.title.startsWith('●')`));
    const flatPdf = path.join(outDir, 'flattened.pdf');
    if (await saveAs(flatPdf)) {
        const { PDFDocument, PDFName } = await import('pdf-lib');
        const doc = await PDFDocument.load(fs.readFileSync(flatPdf));
        check('flattened file has no form', !doc.catalog.get(PDFName.of('AcroForm')) && !doc.getPage(0).node.Annots()?.size());
        await open(flatPdf);
        check('flattened Thai value is page text', (await search('สมชาย')) === 1);
        await sleep(800);
        fs.writeFileSync(path.join(outDir, 'flattened.png'), (await win.capturePage()).toPNG());
    } else {
        check('flattened file saved', false);
    }
};

async function makeForm(file) {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const form = doc.getForm();
    form.createTextField('fullname').addToPage(page, { x: 60, y: 720, width: 300, height: 28 });
    form.createCheckBox('agree').addToPage(page, { x: 60, y: 670, width: 20, height: 20 });
    fs.writeFileSync(file, await doc.save());
}

// An image-only page with Thai text near the top, like a scanner makes.
async function makeScan(file, sleep) {
    const win = new BrowserWindow({ show: false, width: 900, height: 500, useContentSize: true });
    const html = `<!doctype html><meta charset="utf-8"><style>
        body{margin:50px;font-family:Tahoma;font-size:30px;line-height:1.8;color:#111;background:#fff}</style>
        <p>บริษัท ตัวอย่างการค้า จำกัด</p><p>Invoice total amount due</p>`;
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await sleep(300);
    const image = await win.capturePage();
    const { width, height } = image.getSize();
    win.destroy();
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const img = await doc.embedPng(image.toPNG());
    const h = (595 * height) / width;
    page.drawImage(img, { x: 0, y: 842 - h, width: 595, height: h });
    fs.writeFileSync(file, await doc.save());
}
