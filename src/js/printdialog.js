// File > Print: Acrobat-style Print dialog. Printer and options on the
// left, a live preview of each sheet on the right (drawn by printlayout.js,
// exactly like the real job), then the job goes straight to the chosen
// printer without the Windows print dialog.

import { loadPdf, pdfjsLib } from './pdfjs.js';
import { PAPERS, placePage, selectPages, renderSheet } from './printlayout.js';
import { parseRanges } from './extract.js';
import { showFormDialog, toast } from './dialog.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'print-options';
// Room for the sheet inside .print-preview-box (CSS px).
const PREVIEW_W = 280;
const PREVIEW_H = 360;
const MM_PER_POINT = 25.4 / 72;

// While the dialog is open: { pdf, total, current, list, at, seq }.
let view = null;
let redrawTimer = null;

const checked = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value;

function readForm() {
    return {
        printer: $('pr-printer').value,
        copies: Number($('pr-copies').value),
        collate: $('pr-collate').checked,
        grayscale: $('pr-gray').checked,
        range: checked('pr-range'),
        pages: $('pr-pages').value,
        subset: $('pr-subset').value,
        reverse: $('pr-reverse').checked,
        sizing: $('pr-sizing').value,
        scale: Number($('pr-scale').value),
        paper: $('pr-paper').value,
        orientation: $('pr-orientation').value,
        duplex: $('pr-duplex').checked,
        flip: $('pr-flip').value,
    };
}

const layoutOf = (o) => ({ paper: o.paper, orientation: o.orientation, sizing: o.sizing, scale: o.scale });

// Remembered between jobs (like Acrobat): printer and page handling, not the page range.
function loadSaved() {
    try {
        return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
    } catch {
        return {};
    }
}

function save(o) {
    const { printer, collate, grayscale, sizing, scale, paper, orientation, duplex, flip } = o;
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify({ printer, collate, grayscale, sizing, scale, paper, orientation, duplex, flip }));
    } catch {}
}

function restore(saved) {
    const set = (id, value) => {
        if (value !== undefined) $(id)[typeof value === 'boolean' ? 'checked' : 'value'] = value;
    };
    set('pr-collate', saved.collate);
    set('pr-gray', saved.grayscale);
    set('pr-sizing', saved.sizing);
    set('pr-scale', saved.scale);
    set('pr-paper', saved.paper);
    set('pr-orientation', saved.orientation);
    set('pr-duplex', saved.duplex);
    set('pr-flip', saved.flip);
}

function fillPrinters(printers, saved) {
    const select = $('pr-printer');
    select.replaceChildren(...printers.map((p) => {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.isDefault ? `${p.displayName} (ค่าเริ่มต้น)` : p.displayName;
        return opt;
    }));
    const pick = printers.find((p) => p.name === saved.printer) || printers.find((p) => p.isDefault) || printers[0];
    if (pick) select.value = pick.name;
    $('pr-props').disabled = !pick;
}

function syncFields() {
    const o = readForm();
    $('pr-scale-field').hidden = o.sizing !== 'custom';
    $('pr-flip-field').hidden = !o.duplex;
}

function pageList(o) {
    return selectPages(view.total, { ...o, current: view.current }, parseRanges);
}

function scheduleRedraw(resetSheet = false) {
    if (!view) return;
    if (resetSheet) view.at = 0;
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(drawPreview, 120);
}

async function drawPreview() {
    if (!view) return;
    const seq = ++view.seq;
    const o = readForm();
    const list = pageList(o);
    view.list = list;
    const out = $('pr-canvas');
    if (!list) {
        out.width = 0;
        out.height = 0;
        $('pr-scale-info').textContent = '';
        $('pr-paper-info').textContent = '';
        $('pr-sheet-info').textContent = 'ช่วงหน้าไม่ถูกต้อง';
        $('pr-prev').disabled = true;
        $('pr-next').disabled = true;
        return;
    }
    view.at = Math.min(view.at, list.length - 1);
    $('pr-prev').disabled = view.at <= 0;
    $('pr-next').disabled = view.at >= list.length - 1;
    $('pr-sheet-info').textContent = `แผ่นที่ ${view.at + 1} จาก ${list.length} (หน้า ${list[view.at] + 1})`;

    const page = await view.pdf.getPage(list[view.at] + 1);
    if (seq !== view?.seq) return;
    const layout = layoutOf(o);
    const base = page.getViewport({ scale: 1 });
    const place = placePage(base.width, base.height, layout);
    const fit = Math.min(PREVIEW_W / place.sheetW, PREVIEW_H / place.sheetH);
    const { canvas } = await renderSheet(page, layout, {
        dpi: 72 * fit * (window.devicePixelRatio || 1),
        annotationMode: pdfjsLib.AnnotationMode.ENABLE,
        grayscale: o.grayscale,
    });
    if (seq !== view?.seq) {
        canvas.width = 0;
        return;
    }
    out.width = canvas.width;
    out.height = canvas.height;
    out.getContext('2d').drawImage(canvas, 0, 0);
    canvas.width = 0;
    out.style.width = `${Math.round(place.sheetW * fit)}px`;
    out.style.height = `${Math.round(place.sheetH * fit)}px`;
    $('pr-scale-info').textContent = `สเกล ${Math.round(place.scale * 100)}%`;
    const mm = (pt) => Math.round(pt * MM_PER_POINT);
    $('pr-paper-info').textContent = `${o.paper} ${mm(place.sheetW)} × ${mm(place.sheetH)} มม. ${place.landscape ? '(แนวนอน)' : '(แนวตั้ง)'}`;
}

function validate() {
    const o = readForm();
    if (!o.printer) return 'ไม่พบเครื่องพิมพ์ในเครื่องนี้';
    if (!Number.isInteger(o.copies) || o.copies < 1 || o.copies > 999) return 'จำนวนสำเนาต้องอยู่ระหว่าง 1–999';
    if (o.sizing === 'custom' && !(o.scale >= 1 && o.scale <= 1000)) return 'สเกลต้องอยู่ระหว่าง 1–1000%';
    if (!pageList(o)) return 'ช่วงหน้าไม่ถูกต้อง เช่น 1-3, 5';
    return null;
}

export function initPrintDialog() {
    const dlg = $('dlg-print');
    dlg.addEventListener('input', (e) => {
        if (e.target.id === 'pr-pages') document.querySelector('input[name="pr-range"][value="pages"]').checked = true;
        syncFields();
        scheduleRedraw(e.target.closest('#pr-pages, [name="pr-range"], #pr-subset, #pr-reverse') !== null);
    });
    dlg.addEventListener('change', () => {
        syncFields();
        scheduleRedraw();
    });
    $('pr-pages').addEventListener('focus', () => {
        document.querySelector('input[name="pr-range"][value="pages"]').checked = true;
        scheduleRedraw(true);
    });
    $('pr-prev').addEventListener('click', () => {
        if (!view || view.at <= 0) return;
        view.at--;
        drawPreview();
    });
    $('pr-next').addEventListener('click', () => {
        if (!view || !view.list || view.at >= view.list.length - 1) return;
        view.at++;
        drawPreview();
    });
    $('pr-props').addEventListener('click', () => {
        const name = $('pr-printer').value;
        if (name) window.host.printerProperties(name);
    });
    window.host.onPrintProgress(({ done, total }) => toast(`กำลังเตรียมพิมพ์ ${done}/${total} แผ่น…`));
}

// data: the bytes Save would write. current: 0-based page shown in the viewer.
// Resolves once the job is handed to the printer (or the dialog is cancelled).
export async function printWithDialog({ data, password, title, current, setBusy }) {
    const saved = loadSaved();
    const [printers, pdf] = await Promise.all([
        window.host.printers(),
        loadPdf(data, async () => password ?? null),
    ]);
    fillPrinters(printers, saved);
    restore(saved);
    $('pr-copies').value = '1';
    $('pr-pages').value = pdf.numPages > 1 ? `1-${pdf.numPages}` : '1';
    $('pr-subset').value = 'all';
    $('pr-reverse').checked = false;
    document.querySelector('input[name="pr-range"][value="all"]').checked = true;
    syncFields();
    view = { pdf, total: pdf.numPages, current, list: null, at: 0, seq: 0 };
    drawPreview();

    const ok = await showFormDialog('dlg-print', validate);
    const o = readForm();
    const list = pageList(o);
    clearTimeout(redrawTimer);
    view = null;
    pdf.loadingTask.destroy();
    if (!ok || !list) return;
    save(o);

    setBusy(true);
    toast('กำลังเตรียมพิมพ์…');
    try {
        const result = await window.host.print({
            data,
            password,
            title,
            printer: o.printer,
            copies: o.copies,
            collate: o.collate,
            grayscale: o.grayscale,
            duplex: o.duplex ? o.flip : 'simplex',
            pages: list,
            layout: layoutOf(o),
            paperSize: PAPERS[o.paper],
        });
        if (result.ok) toast(`ส่งงานพิมพ์ไปที่ ${o.printer} แล้ว (${list.length} แผ่น${o.copies > 1 ? ` × ${o.copies} ชุด` : ''})`);
        else toast(`พิมพ์ไม่สำเร็จ: ${result.error || 'เครื่องพิมพ์ไม่ตอบสนอง'}`, 'error');
    } finally {
        setBusy(false);
    }
}
