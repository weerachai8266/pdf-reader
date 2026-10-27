'use strict';

// v0.9: Edit Text & Images, Add Text, Undo. Called from smoke.js.

const path = require('node:path');
const fs = require('node:fs');
const { BrowserWindow } = require('electron');

module.exports = async function testEditing(t) {
    const { win, js, check, waitFor, sleep, outDir, setSavePath, inputPdf } = t;
    const open = async (file) => {
        const name = path.basename(file);
        win.webContents.send('file:opened', { path: file, name, data: new Uint8Array(fs.readFileSync(file)) });
        await sleep(300);
        await js(`document.getElementById('dlg-confirm').open && document.getElementById('dlg-confirm-ok').click()`);
        return waitFor(win, `document.getElementById('file-name').textContent === ${JSON.stringify(name)} && !document.body.classList.contains('is-busy') && !!document.querySelector('.page .textLayer span, .page canvas')`);
    };
    const search = async (q) => {
        await js(`(() => { document.querySelector('[data-action="show-search"]').click();
            const i = document.getElementById('search-input'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); })()`);
        await sleep(350);
        await waitFor(win, `document.getElementById('search-status').textContent !== '' && !document.getElementById('search-status').textContent.startsWith('กำลัง')`);
        await sleep(300);
        return js(`document.querySelectorAll('#search-results li').length`);
    };
    const firstPageText = () => js(`document.querySelectorAll('.page')[0].querySelector('.textLayer')?.textContent || ''`);
    const waitRerender = (needle, present = true) =>
        waitFor(win, `${present ? '' : '!'}(document.querySelectorAll('.page')[0].querySelector('.textLayer')?.textContent || '').includes(${JSON.stringify(needle)})`, 20000);

    // ---- edit a line of text ---------------------------------------------------------
    await open(inputPdf);
    await js(`document.querySelector('[data-tool="edit"]').click(); document.getElementById('viewer').scrollTop = 0`);
    await sleep(500);
    await js(`[...document.querySelectorAll('.page')[0].querySelectorAll('.textLayer span')].find((s) => s.textContent.includes('quick brown')).click()`);
    check('text editor opens on the clicked line', await waitFor(win, `!!document.querySelector('.edit-box textarea')`, 15000));
    const original = await js(`document.querySelector('.edit-box textarea')?.value || ''`);
    check('editor holds the line text', original.includes('quick brown fox') && original.includes('dog.'), original);
    await js(`(() => { const a = document.querySelector('.edit-box textarea'); a.value = 'The slow red fox แก้ไขแล้ว';
        a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    check('edited text appears on the page', await waitRerender('แก้ไขแล้ว'), (await firstPageText()).slice(-80));
    check('old words are gone from the file', !(await firstPageText()).includes('quick brown'));
    check('other lines untouched', (await firstPageText()).includes('ทดสอบภาษาไทย'));
    await sleep(800);
    fs.writeFileSync(path.join(outDir, 'edited-text.png'), (await win.capturePage()).toPNG());

    // ---- undo ------------------------------------------------------------------------------
    win.webContents.send('menu:command', 'undo');
    check('undo brings the old line back', await waitRerender('quick brown'));
    check('undo removes the edit', !(await firstPageText()).includes('แก้ไขแล้ว'));

    // Redo the edit for the save check below.
    await js(`[...document.querySelectorAll('.page')[0].querySelectorAll('.textLayer span')].find((s) => s.textContent.includes('quick brown')).click()`);
    await waitFor(win, `!!document.querySelector('.edit-box textarea')`, 15000);
    await js(`(() => { const a = document.querySelector('.edit-box textarea'); a.value = 'ข้อความที่แก้ใหม่ 2026';
        a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    await waitRerender('ข้อความที่แก้ใหม่');

    // ---- add text ---------------------------------------------------------------------------
    await js(`document.querySelector('[data-tool="addtext"]').click(); document.getElementById('viewer').scrollTop = 0`);
    await sleep(300);
    const p = await js(`(() => { const r = document.querySelectorAll('.page')[0].getBoundingClientRect(); return { x: Math.round(r.left + 80), y: Math.round(Math.max(r.top, 50) + 440) }; })()`);
    await js(`document.elementFromPoint(${p.x}, ${p.y}).dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: ${p.x}, clientY: ${p.y} }))`);
    const opened = await waitFor(win, `!!document.querySelector('.edit-box textarea')`, 10000);
    check('add-text editor opens', opened);
    await js(`(() => { const a = document.querySelector('.edit-box textarea'); a.value = 'เพิ่มข้อความ Added note';
        a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    check('added text is real page text', await waitRerender('Added note'));

    const edited = path.join(outDir, 'edited.pdf');
    setSavePath(edited);
    win.webContents.send('menu:command', 'save-as');
    for (let n = 0; n < 100 && !(fs.existsSync(edited) && fs.statSync(edited).size); n++) await sleep(200);
    await sleep(300);
    await open(edited);
    const counts = [await search('ข้อความที่แก้ใหม่'), await search('quick brown'), await search('Added note')];
    // "quick brown" is still on pages 2 and 3; only page 1 was edited.
    check('edits survive save and reopen', counts.join() === '1,2,1', counts.join());

    // ---- images: move and delete ----------------------------------------------------------------
    const picture = path.join(outDir, 'picture.pdf');
    await makePicturePdf(picture, sleep);
    await open(picture);
    await js(`document.querySelector('[data-tool="select"]').click()`);
    await js(`document.querySelector('[data-tool="edit"]').click()`);
    check('image found in edit mode', await waitFor(win, `document.querySelectorAll('.edit-image').length === 1`, 15000));
    const before = await js(`(() => { const r = document.querySelector('.edit-image').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width }; })()`);
    const sx = Math.round(before.x + 30);
    const sy = Math.round(before.y + 30);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: sx, y: sy, button: 'left', clickCount: 1 });
    for (let s = 1; s <= 5; s++) {
        win.webContents.sendInputEvent({ type: 'mouseMove', x: sx + s * 20, y: sy + s * 10, button: 'left' });
        await sleep(30);
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: sx + 100, y: sy + 50, button: 'left', clickCount: 1 });
    const moved = await waitFor(win, `(() => { const el = document.querySelector('.edit-image'); if (!el) return false;
        const r = el.getBoundingClientRect(); return Math.abs(r.left - ${before.x} - 100) < 6 && Math.abs(r.top - ${before.y} - 50) < 6; })()`, 15000);
    const movedInFile = await waitFor(win, `(async () => {
        const { state } = await import('./js/docstate.js');
        const { loadSourceDoc } = await import('./js/save.js');
        const [src] = state.sources.values();
        const { doc, lib } = await loadSourceDoc(src);
        const c = doc.getPages()[0].node.Contents();
        const arr = c instanceof lib.PDFArray ? c.asArray().map((r) => doc.context.lookup(r)) : [c];
        return arr.map((st) => new TextDecoder('latin1').decode(lib.decodePDFRawStream(st).decode())).join('').includes(' cm /Image');
    })()`, 15000);
    check('image move written to the file', movedInFile);
    check('image moved in the file', moved, JSON.stringify(await js(`(() => { const r = document.querySelector('.edit-image')?.getBoundingClientRect(); return r && [r.left, r.top]; })()`)));
    await js(`document.querySelector('.edit-image').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))`);
    await js(`document.querySelector('.edit-image .edit-image-tools button[title="Delete Image"]').click()`);
    check('image deleted', await waitFor(win, `document.querySelectorAll('.edit-image').length === 0 && /ลบรูปแล้ว/.test(document.getElementById('toast').textContent)`, 15000),
        await js(`document.querySelectorAll('.edit-image').length + ' | ' + document.getElementById('toast').textContent`));
    win.webContents.send('menu:command', 'undo');
    check('undo restores the image', await waitFor(win, `document.querySelectorAll('.edit-image').length === 1`, 15000));
    await js(`document.querySelector('[data-tool="select"]').click()`);
};

// A page with one picture.
async function makePicturePdf(file, sleep) {
    const win = new BrowserWindow({ show: false, width: 300, height: 200, useContentSize: true });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="margin:0;background:linear-gradient(135deg,#2f6fde,#ffd233);font:40px Tahoma;color:#fff;display:grid;place-items:center;height:100vh">รูปทดสอบ</body>'));
    await sleep(300);
    const png = (await win.capturePage()).toPNG();
    win.destroy();
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const img = await doc.embedPng(png);
    page.drawImage(img, { x: 100, y: 500, width: 300, height: 200 });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('Caption under the picture', { x: 100, y: 470, size: 14, font });
    fs.writeFileSync(file, await doc.save());
}
