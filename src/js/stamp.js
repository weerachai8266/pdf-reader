// Document > Header & Footer / Page Numbers / Watermark.
//
// Text is drawn into each source PDF (like OCR, via replaceSource), placed
// relative to the page as the user sees it: a page shown rotated still gets
// its footer along the bottom edge of the screen, upright.

import { state, replaceSource } from './docstate.js';
import { loadPdf } from './pdfjs.js';
import { loadSourceDoc, embedThaiFont } from './save.js';
import { showFormDialog, progressDialog, toast } from './dialog.js';

const $ = (id) => document.getElementById(id);
const NON_LATIN1 = /[^\u0000-\u00ff]/;

const COLORS = {
    black: [0, 0, 0],
    gray: [0.5, 0.5, 0.5],
    red: [0.8, 0.1, 0.1],
    blue: [0.1, 0.25, 0.7],
};

// ---- geometry -----------------------------------------------------------

// Maps "visual" coordinates (origin bottom-left of the page as displayed,
// y up) to PDF user space for a page whose display rotation is `rot`.
function visualFrame(page, rot) {
    const { x: x0, y: y0, width: w, height: h } = page.getCropBox();
    const swap = rot % 180 !== 0;
    const map = {
        0: (vx, vy) => [x0 + vx, y0 + vy],
        90: (vx, vy) => [x0 + w - vy, y0 + vx],
        180: (vx, vy) => [x0 + w - vx, y0 + h - vy],
        270: (vx, vy) => [x0 + vy, y0 + h - vx],
    }[rot];
    return { width: swap ? h : w, height: swap ? w : h, toUser: map, angle: rot };
}

// ---- shared apply ---------------------------------------------------------

// draw(lib, page, frame, font, pageNumber) for every page of the document,
// one source at a time.
async function stampAll(title, draw) {
    const progress = progressDialog(title);
    try {
        const total = state.pages.length;
        let done = 0;
        for (const src of [...state.sources.values()]) {
            const entries = state.pages.map((entry, pos) => ({ entry, pos })).filter(({ entry }) => entry.srcId === src.id);
            if (!entries.length) continue;
            const { lib, doc } = await loadSourceDoc(src);
            const fonts = await stampFonts(lib, doc);
            const pages = doc.getPages();
            for (const { entry, pos } of entries) {
                const page = pages[entry.index];
                const rot = (((page.getRotation().angle + entry.rotation) % 360) + 360) % 360;
                draw(lib, page, visualFrame(page, rot), fonts, pos);
                progress.update(`กำลังใส่ข้อความ หน้า ${++done} จาก ${total}`, done / total);
            }
            const bytes = await doc.save({ useObjectStreams: true, updateFieldAppearances: false });
            replaceSource(src.id, { bytes, pdf: await loadPdf(bytes, async () => null) });
        }
        return true;
    } catch (err) {
        console.error(err);
        toast(`${title} ไม่สำเร็จ: ${err?.message || err}`, 'error');
        return false;
    } finally {
        progress.close();
    }
}

// Tahoma for Thai, Helvetica for everything when Tahoma is missing.
async function stampFonts(lib, doc) {
    const thai = await embedThaiFont(doc);
    const latin = thai || (await doc.embedFont(lib.StandardFonts.Helvetica));
    return (text) => {
        if (NON_LATIN1.test(text) && !thai) throw new Error('ไม่พบฟอนต์ Tahoma ในเครื่อง จึงใส่ข้อความภาษาไทยไม่ได้');
        return latin;
    };
}

// Draws text with its baseline origin at visual (vx, vy), along visual
// angle `deg` (counter-clockwise).
function drawVisualText(lib, page, frame, { text, font, size, vx, vy, deg = 0, color, opacity = 1 }) {
    const [x, y] = frame.toUser(vx, vy);
    page.drawText(text, {
        x,
        y,
        size,
        font,
        color: lib.rgb(...color),
        opacity,
        rotate: lib.degrees(frame.angle + deg),
    });
}

// ---- header & footer ------------------------------------------------------

const SLOTS = ['hf-header-left', 'hf-header-center', 'hf-header-right', 'hf-footer-left', 'hf-footer-center', 'hf-footer-right'];

function formatDate(d) {
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

export function expandTokens(template, { page, total, date, file }) {
    return template
        .replaceAll('{page}', String(page))
        .replaceAll('{total}', String(total))
        .replaceAll('{date}', date)
        .replaceAll('{file}', file);
}

export async function headerFooter({ pageNumbers = false } = {}) {
    $('dlg-header-title').textContent = pageNumbers ? 'Add Page Numbers' : 'Header & Footer';
    if (pageNumbers && SLOTS.every((id) => !$(id).value.trim())) $('hf-footer-center').value = '{page} / {total}';
    const ok = await showFormDialog('dlg-header', () =>
        SLOTS.some((id) => $(id).value.trim()) ? null : 'กรอกข้อความอย่างน้อย 1 ช่อง');
    if (!ok) return;

    const size = Number($('hf-size').value) || 10;
    const margin = Number($('hf-margin').value) * 72 / 25.4; // mm -> pt
    const start = Math.trunc(Number($('hf-start').value)) || 1;
    const color = COLORS[$('hf-color').value] || COLORS.black;
    const values = Object.fromEntries(SLOTS.map((id) => [id, $(id).value.trim()]));
    const tokens = { total: state.pages.length + start - 1, date: formatDate(new Date()), file: (state.fileName || '').replace(/\.pdf$/i, '') };

    const done = await stampAll(pageNumbers ? 'Add Page Numbers' : 'Header & Footer', (lib, page, frame, fontFor, pos) => {
        for (const id of SLOTS) {
            if (!values[id]) continue;
            const text = expandTokens(values[id], { ...tokens, page: pos + start });
            const font = fontFor(text);
            const width = font.widthOfTextAtSize(text, size);
            const align = id.split('-')[2];
            const vx = align === 'left' ? margin : align === 'right' ? frame.width - margin - width : (frame.width - width) / 2;
            const vy = id.startsWith('hf-header') ? frame.height - margin - size * 0.8 : margin;
            drawVisualText(lib, page, frame, { text, font, size, vx, vy, color });
        }
    });
    if (done) toast(pageNumbers ? 'ใส่เลขหน้าแล้ว' : 'ใส่ header/footer แล้ว');
}

// ---- watermark -------------------------------------------------------------

export async function watermark() {
    const ok = await showFormDialog('dlg-watermark', () => ($('wm-text').value.trim() ? null : 'กรอกข้อความลายน้ำ'));
    if (!ok) return;

    const text = $('wm-text').value.trim();
    const deg = Number($('wm-angle').value);
    const opacity = Number($('wm-opacity').value) / 100;
    const sizeChoice = $('wm-size').value;
    const color = COLORS[$('wm-color').value] || COLORS.gray;

    const done = await stampAll('Add Watermark', (lib, page, frame, fontFor) => {
        const font = fontFor(text);
        const rad = (deg * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        // "Auto" fits the text across 80% of the page along its angle.
        const reach = Math.abs(cos) > 1e-6 && Math.abs(sin) > 1e-6
            ? Math.min(frame.width / Math.abs(cos), frame.height / Math.abs(sin))
            : Math.abs(cos) > 0.5 ? frame.width : frame.height;
        const size = sizeChoice === 'auto' ? (0.8 * reach) / font.widthOfTextAtSize(text, 1) : Number(sizeChoice);
        const width = font.widthOfTextAtSize(text, size);
        const capHeight = size * 0.7;
        // Centre of the text box at the page centre.
        const vx = frame.width / 2 - (width / 2) * cos + (capHeight / 2) * sin;
        const vy = frame.height / 2 - (width / 2) * sin - (capHeight / 2) * cos;
        drawVisualText(lib, page, frame, { text, font, size, vx, vy, deg, color, opacity });
    });
    if (done) toast('ใส่ลายน้ำแล้ว');
}
