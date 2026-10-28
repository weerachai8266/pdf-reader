// Document > Insert Pages: pages from other files (PDF, Office, images) or
// blank pages, before or after a chosen page. Inserted pages become a new
// source in the page list, like Combine Files, so nothing is written until
// Save.

import { once } from './bus.js';
import { state, addSource, getPdfPage, pagesChanged } from './docstate.js';
import { loadPdf } from './pdfjs.js';
import { loadPdfLib } from './save.js';
import { filesToPdfs } from './convert.js';
import { currentPageIndex, scrollToIndex } from './viewer.js';
import { askPassword, showFormDialog, progressDialog, toast } from './dialog.js';

const $ = (id) => document.getElementById(id);
const MAX_BLANK = 100;

// Asks where to insert; returns the page-list index, or null if cancelled.
async function askPosition(blank) {
    const total = state.pages.length;
    $('dlg-insert-title').textContent = blank ? 'Insert Blank Pages' : 'Insert Pages from File';
    $('insert-count-field').hidden = !blank;
    $('insert-page').max = String(total);
    $('insert-page').value = String(currentPageIndex() + 1);
    $('insert-total').textContent = `จากทั้งหมด ${total} หน้า`;
    const ok = await showFormDialog('dlg-insert', () => {
        const page = Number($('insert-page').value);
        if (!Number.isInteger(page) || page < 1 || page > total) return `เลขหน้าต้องอยู่ระหว่าง 1 ถึง ${total}`;
        const count = Number($('insert-count').value);
        if (blank && (!Number.isInteger(count) || count < 1 || count > MAX_BLANK)) return `จำนวนหน้าต้องอยู่ระหว่าง 1 ถึง ${MAX_BLANK}`;
        return null;
    });
    if (!ok) return null;
    const page = Number($('insert-page').value);
    return $('insert-where').value === 'before' ? page - 1 : page;
}

// The viewer rebuilds asynchronously after a page change; scroll once it has.
function showInserted(at) {
    once('layout-changed', () => scrollToIndex(at));
    pagesChanged();
}

export async function insertFromFile() {
    const paths = await window.host.convertPick({ multiple: true });
    if (!paths.length) return;
    const at = await askPosition(false);
    if (at === null) return;
    const progress = progressDialog('Insert Pages');
    try {
        const pdfs = await filesToPdfs(paths, progress);
        if (!pdfs?.length) return;
        let pos = at;
        let added = 0;
        for (const { name, data } of pdfs) {
            const pdf = await loadPdf(data, askPassword);
            const entries = addSource({ name, bytes: data, pdf }, pos);
            pos += entries.length;
            added += entries.length;
        }
        showInserted(at);
        toast(`แทรกแล้ว ${added} หน้า ทั้งหมด ${state.pages.length} หน้า`);
    } catch (err) {
        if (err?.name === 'PasswordException') return;
        console.error(err);
        toast(`แทรกหน้าไม่สำเร็จ: ${err?.message || err}`, 'error');
    } finally {
        progress.close();
    }
}

export async function insertBlank() {
    const at = await askPosition(true);
    if (at === null) return;
    const count = Number($('insert-count').value);
    try {
        // Same size and orientation as the page it is inserted next to, as
        // the user sees it.
        const ref = state.pages[Math.min(Math.max(at - 1, 0), state.pages.length - 1)];
        const page = await getPdfPage(ref);
        const { width, height } = page.getViewport({ scale: 1, rotation: (page.rotate + ref.rotation) % 360 });
        const { PDFDocument } = await loadPdfLib();
        const doc = await PDFDocument.create();
        for (let i = 0; i < count; i++) doc.addPage([width, height]);
        const bytes = await doc.save();
        addSource({ name: 'Blank Page', bytes, pdf: await loadPdf(bytes, async () => null) }, at);
        showInserted(at);
        toast(`แทรกหน้าว่าง ${count} หน้าแล้ว`);
    } catch (err) {
        console.error(err);
        toast(`แทรกหน้าว่างไม่สำเร็จ: ${err?.message || err}`, 'error');
    }
}
