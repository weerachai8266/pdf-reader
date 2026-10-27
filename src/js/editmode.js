// Edit mode (Tools > Edit Text & Images, toolbar pencil) and Add Text.
//
// - Click a line of text: an editor opens on it with the line's text, size,
//   colour and a matching font. On commit the old glyphs are removed from
//   the page content (contentedit.js) and the new text is drawn in place.
// - Click an image: drag to move, drag the corner to resize, Delete to
//   remove, or Replace it with another picture.
// - Add Text: click anywhere and type.
//
// Every change is written into the source PDF straight away (so what you
// see is the real file) and can be undone with Ctrl+Z.

import { on } from './bus.js';
import { state, replaceSource } from './docstate.js';
import { getView, allViews } from './viewer.js';
import { getTool, setTool, placeImage } from './annotate.js';
import { loadPdf } from './pdfjs.js';
import { loadSourceDoc, embedFontBytes } from './save.js';
import { parseContent, interpret, fontInfo, glyphsInRect, removeGlyphs, rebuild, describeGlyphs, mul, invert, apply } from './contentedit.js';
import { cleanCopiedText } from './thai.js';
import { icon } from './icons.js';
import { toast } from './dialog.js';

const THAI = /[ก-๛]/;
const UNDO_LIMIT = 20;
const FONTS = [
    { key: 'tahoma', label: 'Tahoma', css: 'Tahoma', thai: true },
    { key: 'laksaman', label: 'TH Sarabun New', css: "'TH Sarabun New', 'TH SarabunPSK', Laksaman, Tahoma", thai: true },
    { key: 'arial', label: 'Arial', css: 'Arial', thai: false },
    { key: 'times', label: 'Times New Roman', css: "'Times New Roman'", thai: false },
];

const undoStack = []; // { srcId, bytes }
let editor = null; // open text editor
let selectedImage = null; // { view, index, el }

export function initEditMode(scroller) {
    on('text-layer-rendered', (view) => {
        if (getTool() === 'edit') buildImageOverlays(view);
    });
    // The page content changed (edit, undo): boxes must follow the file.
    on('source-replaced', (srcId) => {
        if (getTool() !== 'edit') return;
        for (const view of allViews()) if (view.entry.srcId === srcId) buildImageOverlays(view);
    });
    on('tool-changed', (tool) => {
        closeEditor(false);
        selectImage(null);
        for (const view of allViews()) {
            if (tool === 'edit') buildImageOverlays(view);
            else view.editLayer?.replaceChildren();
        }
    });
    scroller.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
}

export function canUndo() {
    return undoStack.length > 0;
}

// ---- page model -------------------------------------------------------------------

function contentString(lib, doc, page) {
    const { PDFArray, PDFRawStream, decodePDFRawStream } = lib;
    const contents = page.node.Contents();
    if (!contents) return '';
    const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
    let s = '';
    for (const st of streams) {
        if (!(st instanceof PDFRawStream)) continue;
        const bytes = decodePDFRawStream(st).decode();
        for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
        s += '\n';
    }
    return s;
}

async function pageModel(src, index) {
    const { lib, doc } = await loadSourceDoc(src);
    const { PDFName, PDFDict } = lib;
    const page = doc.getPages()[index];
    const s = contentString(lib, doc, page);
    const ops = parseContent(s);
    const res = page.node.Resources();
    const fonts = res?.lookupMaybe(PDFName.of('Font'), PDFDict);
    const xobjects = res?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    const cache = new Map();
    const fontFor = (name) => {
        if (!cache.has(name)) {
            const dict = name && fonts?.lookupMaybe(PDFName.of(name), PDFDict);
            cache.set(name, dict ? fontInfo(lib, doc, dict) : null);
        }
        return cache.get(name);
    };
    const isImage = (name) => xobjects?.lookup(PDFName.of(name))?.dict?.get(PDFName.of('Subtype')) === PDFName.of('Image');
    const { glyphs, images } = interpret(ops, { fontFor, isImage });
    return { lib, doc, page, s, ops, glyphs, images };
}

function setContent(model, text) {
    const { lib, doc, page } = model;
    const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
    page.node.set(lib.PDFName.of('Contents'), doc.context.register(doc.context.flateStream(bytes)));
}

async function commitModel(src, model, label) {
    const bytes = await model.doc.save({ useObjectStreams: true, updateFieldAppearances: false });
    undoStack.push({ srcId: src.id, bytes: src.bytes, label });
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    replaceSource(src.id, { bytes, pdf: await loadPdf(bytes, async () => null) });
}

export async function undoEdit() {
    const last = undoStack.pop();
    if (!last) return false;
    const src = state.sources.get(last.srcId);
    if (!src) return false;
    replaceSource(src.id, { bytes: last.bytes, pdf: await loadPdf(last.bytes, async () => null) });
    toast(`ย้อนกลับ: ${last.label}`);
    return true;
}

// ---- geometry helpers ---------------------------------------------------------------

function viewRectToPdf(view, left, top, right, bottom) {
    const pts = [[left, top], [right, top], [left, bottom], [right, bottom]].map(([x, y]) => view.viewport.convertToPdfPoint(x, y));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function pdfRectToView(view, [x1, y1, x2, y2]) {
    const pts = [[x1, y1], [x2, y1], [x1, y2], [x2, y2]].map(([x, y]) => view.viewport.convertToViewportPoint(x, y));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

function relRect(view, el) {
    const p = view.div.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { left: r.left - p.left, top: r.top - p.top, right: r.right - p.left, bottom: r.bottom - p.top, height: r.height };
}

// The clicked span plus its neighbours on the same visual line.
function lineSpans(view, span) {
    const spans = view.textLayer?.textDivs || [];
    const base = relRect(view, span);
    const mid = (base.top + base.bottom) / 2;
    const row = spans
        .filter((s) => s.textContent && s.isConnected)
        .map((s) => ({ s, r: relRect(view, s) }))
        .filter(({ r }) => r.height > 0 && Math.abs((r.top + r.bottom) / 2 - mid) < base.height * 0.45)
        .sort((a, b) => a.r.left - b.r.left);
    const at = row.findIndex((x) => x.s === span);
    if (at < 0) return [{ s: span, r: base }];
    const gapMax = base.height * 1.5;
    let lo = at;
    let hi = at;
    while (lo > 0 && row[lo].r.left - row[lo - 1].r.right < gapMax) lo--;
    while (hi < row.length - 1 && row[hi + 1].r.left - row[hi].r.right < gapMax) hi++;
    return row.slice(lo, hi + 1);
}

function lineText(row) {
    let out = '';
    let prev = null;
    for (const { s, r } of row) {
        if (prev && r.left - prev.right > r.height * 0.25 && !out.endsWith(' ')) out += ' ';
        out += s.textContent;
        prev = r;
    }
    return cleanCopiedText(out).replace(/\s+/g, ' ').trim();
}

function guessFont(baseFont = '') {
    const bold = /bold|black|heavy|semibold/i.test(baseFont);
    if (/sarabun|laksaman/i.test(baseFont)) return { key: 'laksaman', bold };
    if (/times|roman|serif|angsana/i.test(baseFont)) return { key: 'times', bold };
    if (/arial|helvetica|calibri|segoe|liberation ?sans/i.test(baseFont)) return { key: 'arial', bold };
    return { key: 'tahoma', bold };
}

const toHex = (c) => '#' + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
const fromHex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

// ---- events --------------------------------------------------------------------------

function viewOf(target) {
    const pageDiv = target.closest('.page');
    return pageDiv ? getView(pageDiv.dataset.key) : null;
}

async function onClick(e) {
    const tool = getTool();
    if (tool !== 'edit' && tool !== 'addtext') return;
    if (e.target.closest('.edit-box, .edit-image')) return;
    const view = viewOf(e.target);
    if (!view?.viewport) return;
    if (editor) {
        await closeEditor(true);
        return;
    }
    selectImage(null);
    if (tool === 'addtext') {
        const p = view.div.getBoundingClientRect();
        openAddText(view, e.clientX - p.left, e.clientY - p.top);
        return;
    }
    const span = e.target.closest('.textLayer span');
    if (span) openTextEditor(view, span);
}

function onKey(e) {
    const typing = e.target.closest('input, textarea, select, [contenteditable]');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing && undoStack.length) {
        e.preventDefault();
        undoEdit();
        return;
    }
    if (!selectedImage || typing) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteImage(selectedImage.view, selectedImage.index);
    } else if (e.key === 'Escape') {
        selectImage(null);
    }
}

// ---- text editor -----------------------------------------------------------------------

async function openTextEditor(view, span) {
    const row = lineSpans(view, span);
    const box = row.reduce((b, { r }) => ({
        left: Math.min(b.left, r.left), top: Math.min(b.top, r.top), right: Math.max(b.right, r.right), bottom: Math.max(b.bottom, r.bottom),
    }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
    const pad = (box.bottom - box.top) * 0.15;
    const rect = viewRectToPdf(view, box.left - 1, box.top - pad, box.right + 1, box.bottom + pad);
    const src = state.sources.get(view.entry.srcId);
    let model;
    try {
        model = await pageModel(src, view.entry.index);
    } catch (err) {
        toast(err.message, 'error');
        return;
    }
    const glyphs = glyphsInRect(model.glyphs, rect);
    if (!glyphs.length) {
        toast('แก้ข้อความนี้ไม่ได้ (อาจอยู่ในวัตถุซ้อน หรือใช้ฟอนต์ชนิดที่ยังไม่รองรับ) ลองใช้ Add Text วางข้อความใหม่แทน', 'error');
        return;
    }
    const info = describeGlyphs(glyphs);
    const guess = guessFont(info.baseFont);
    showEditor(view, {
        mode: 'edit',
        rect,
        box,
        text: lineText(row),
        origin: info.origin,
        angle: info.angle,
        size: info.size,
        color: info.color,
        font: guess.key,
        bold: guess.bold,
    });
}

function openAddText(view, x, y) {
    const rotation = ((view.viewport.rotation % 360) + 360) % 360;
    // Upright on screen: the text runs along the screen's x axis.
    const angle = (rotation * Math.PI) / 180;
    const size = 12;
    const p = view.viewport.convertToPdfPoint(x, y);
    const up = [-Math.sin(angle), Math.cos(angle)];
    const origin = [p[0] - up[0] * size * 0.85, p[1] - up[1] * size * 0.85];
    const scale = view.viewport.scale;
    showEditor(view, {
        mode: 'add',
        rect: null,
        box: { left: x, top: y, right: x + 220, bottom: y + size * scale * 1.4 },
        text: '',
        origin,
        angle,
        size,
        color: [0, 0, 0],
        font: 'tahoma',
        bold: false,
    });
}

function showEditor(view, opts) {
    closeEditor(false);
    const scale = view.viewport.scale;
    const wrap = document.createElement('div');
    wrap.className = 'edit-box';
    wrap.style.left = `${opts.box.left}px`;
    wrap.style.top = `${opts.box.top}px`;

    const bar = document.createElement('div');
    bar.className = 'edit-bar';
    const font = document.createElement('select');
    font.title = 'Font';
    for (const f of FONTS) font.append(new Option(f.label, f.key, false, f.key === opts.font));
    const size = document.createElement('input');
    size.type = 'number';
    size.min = '4';
    size.max = '200';
    size.step = '0.5';
    size.value = String(Math.round(opts.size * 2) / 2);
    size.title = 'Font size (pt)';
    const bold = document.createElement('button');
    bold.type = 'button';
    bold.title = 'Bold';
    bold.setAttribute('aria-pressed', String(opts.bold));
    bold.append(icon('bold'));
    const color = document.createElement('input');
    color.type = 'color';
    color.value = toHex(opts.color);
    color.title = 'Color';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'edit-ok';
    ok.title = 'Apply (Enter)';
    ok.append(icon('check'));
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.title = 'Cancel (Esc)';
    cancel.append(icon('x'));
    bar.append(font, size, bold, color, ok, cancel);

    const area = document.createElement('textarea');
    area.className = 'edit-text';
    area.value = opts.text;
    area.rows = Math.max(1, opts.text.split('\n').length);
    area.spellcheck = false;
    const applyLook = () => {
        const f = FONTS.find((x) => x.key === font.value);
        area.style.fontFamily = f.css;
        area.style.fontSize = `${Number(size.value) * scale}px`;
        area.style.fontWeight = bold.getAttribute('aria-pressed') === 'true' ? '700' : '400';
        area.style.color = color.value;
        area.style.minWidth = `${Math.max(80, opts.box.right - opts.box.left + 24)}px`;
    };
    applyLook();
    for (const el of [font, size, color]) el.addEventListener('input', applyLook);
    bold.addEventListener('click', () => {
        bold.setAttribute('aria-pressed', String(bold.getAttribute('aria-pressed') !== 'true'));
        applyLook();
    });
    ok.addEventListener('click', () => closeEditor(true));
    cancel.addEventListener('click', () => closeEditor(false));
    area.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            closeEditor(true);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeEditor(false);
        }
    });

    wrap.append(bar, area);
    view.div.append(wrap);
    // Hide the original line while editing.
    if (opts.mode === 'edit') {
        const hide = document.createElement('div');
        hide.className = 'edit-cover';
        hide.style.left = `${opts.box.left - 2}px`;
        hide.style.top = `${opts.box.top - 2}px`;
        hide.style.width = `${opts.box.right - opts.box.left + 4}px`;
        hide.style.height = `${opts.box.bottom - opts.box.top + 4}px`;
        view.div.append(hide);
        opts.cover = hide;
    }
    editor = { view, opts, wrap, area, font, size, bold, color };
    area.focus();
    area.select();
}

async function closeEditor(commit) {
    if (!editor) return;
    const ed = editor;
    editor = null;
    ed.wrap.remove();
    ed.opts.cover?.remove();
    if (!commit) return;
    const text = ed.area.value.replace(/\s+$/g, '');
    const settings = {
        font: ed.font.value,
        size: Number(ed.size.value) || ed.opts.size,
        bold: ed.bold.getAttribute('aria-pressed') === 'true',
        color: fromHex(ed.color.value),
    };
    const unchanged = text === ed.opts.text && settings.font === ed.opts.font && settings.bold === ed.opts.bold &&
        Math.abs(settings.size - ed.opts.size) < 0.26 && ed.color.value === toHex(ed.opts.color);
    if (ed.opts.mode === 'edit' && unchanged) return;
    if (ed.opts.mode === 'add' && !text) return;
    try {
        await applyText(ed.view, ed.opts, text, settings);
    } catch (err) {
        console.error(err);
        toast(`แก้ข้อความไม่สำเร็จ: ${err?.message || err}`, 'error');
    }
}

async function applyText(view, opts, text, settings) {
    const src = state.sources.get(view.entry.srcId);
    const model = await pageModel(src, view.entry.index);
    const { lib, page } = model;
    if (opts.mode === 'edit') {
        const removed = glyphsInRect(model.glyphs, opts.rect);
        setContent(model, rebuild(model.s, model.ops, removeGlyphs(model.ops, removed)));
    }
    if (text) {
        let key = settings.font;
        if (THAI.test(text) && !FONTS.find((f) => f.key === key).thai) key = 'tahoma';
        const bytes = (await window.host.editFont(settings.bold ? `${key}-bold` : key)) || (await window.host.editFont(key)) || (await window.host.thaiFont());
        if (!bytes) throw new Error('ไม่พบฟอนต์ในเครื่อง');
        const font = await embedFontBytes(model.doc, bytes);
        page.drawText(text, {
            x: opts.origin[0],
            y: opts.origin[1],
            size: settings.size,
            font,
            color: lib.rgb(...settings.color),
            rotate: lib.radians(opts.angle),
            lineHeight: settings.size * 1.25,
        });
    }
    await commitModel(src, model, opts.mode === 'edit' ? 'แก้ข้อความ' : 'เพิ่มข้อความ');
}

// ---- images -------------------------------------------------------------------------------

async function buildImageOverlays(view) {
    if (!view.viewport) return;
    if (!view.editLayer) {
        view.editLayer = document.createElement('div');
        view.editLayer.className = 'edit-layer';
        view.div.append(view.editLayer);
    }
    const layer = view.editLayer;
    layer.replaceChildren();
    // Renders can overlap; only the newest analysis may draw its boxes.
    const token = (view.editToken = (view.editToken || 0) + 1);
    const src = state.sources.get(view.entry.srcId);
    let model;
    try {
        model = await pageModel(src, view.entry.index);
    } catch {
        return;
    }
    if (getTool() !== 'edit' || token !== view.editToken) return;
    layer.replaceChildren();
    model.images.forEach((img, index) => {
        const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => apply(img.ctm, x, y));
        const xs = corners.map((c) => c[0]);
        const ys = corners.map((c) => c[1]);
        const r = pdfRectToView(view, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
        if (r.right - r.left < 4 || r.bottom - r.top < 4) return;
        const el = document.createElement('div');
        el.className = 'edit-image';
        el.dataset.index = index;
        el.title = 'Image — drag to move, drag the corner to resize, Delete to remove';
        place(el, r);
        const handle = document.createElement('span');
        handle.className = 'resize-handle';
        const tools = document.createElement('div');
        tools.className = 'edit-image-tools';
        const replace = document.createElement('button');
        replace.type = 'button';
        replace.title = 'Replace Image…';
        replace.append(icon('replace'));
        replace.addEventListener('click', (e) => {
            e.stopPropagation();
            pickReplacement(view, index);
        });
        const del = document.createElement('button');
        del.type = 'button';
        del.title = 'Delete Image';
        del.append(icon('trash-2'));
        del.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteImage(view, index);
        });
        tools.append(replace, del);
        el.append(handle, tools);
        el.addEventListener('pointerdown', (e) => dragImage(e, view, index, el));
        layer.append(el);
    });
}

function place(el, r) {
    el.style.left = `${r.left}px`;
    el.style.top = `${r.top}px`;
    el.style.width = `${r.right - r.left}px`;
    el.style.height = `${r.bottom - r.top}px`;
}

function selectImage(sel) {
    document.querySelectorAll('.edit-image.is-selected').forEach((el) => el.classList.remove('is-selected'));
    selectedImage = sel;
    sel?.el.classList.add('is-selected');
}

function dragImage(e, view, index, el) {
    if (e.button !== 0 || e.target.closest('.edit-image-tools')) return;
    e.preventDefault();
    e.stopPropagation();
    selectImage({ view, index, el });
    const resizing = e.target.classList.contains('resize-handle');
    const start = { left: el.offsetLeft, top: el.offsetTop, right: el.offsetLeft + el.offsetWidth, bottom: el.offsetTop + el.offsetHeight };
    const sx = e.clientX;
    const sy = e.clientY;
    let box = start;
    try {
        el.setPointerCapture(e.pointerId);
    } catch {
        // synthetic events have no active pointer
    }
    const move = (ev) => {
        const dx = ev.clientX - sx;
        const dy = ev.clientY - sy;
        if (resizing) {
            const w = Math.max(10, start.right - start.left + dx);
            const h = w * ((start.bottom - start.top) / (start.right - start.left));
            box = { left: start.left, top: start.top, right: start.left + w, bottom: start.top + h };
        } else {
            box = { left: start.left + dx, top: start.top + dy, right: start.right + dx, bottom: start.bottom + dy };
        }
        place(el, box);
    };
    const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        if (Math.abs(box.left - start.left) + Math.abs(box.top - start.top) + Math.abs(box.right - start.right) < 2) return;
        const from = viewRectToPdf(view, start.left, start.top, start.right, start.bottom);
        const to = viewRectToPdf(view, box.left, box.top, box.right, box.bottom);
        transformImage(view, index, from, to).catch((err) => {
            console.error('image move failed', err);
            toast(`ย้ายรูปไม่สำเร็จ: ${err.message}`, 'error');
        });
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
}

function fmt(m) {
    return m.map((v) => String(Math.round(v * 10000) / 10000)).join(' ');
}

// Page-space change from box `from` to box `to`, applied before the Do.
async function transformImage(view, index, from, to) {
    const src = state.sources.get(view.entry.srcId);
    const model = await pageModel(src, view.entry.index);
    const img = model.images[index];
    if (!img) return;
    const sx = (to[2] - to[0]) / (from[2] - from[0] || 1);
    const sy = (to[3] - to[1]) / (from[3] - from[1] || 1);
    const T = [sx, 0, 0, sy, to[0] - from[0] * sx, to[1] - from[1] * sy];
    const M = mul(mul(img.ctm, T), invert(img.ctm));
    setContent(model, rebuild(model.s, model.ops, new Map([[img.op, `q ${fmt(M)} cm /${img.name} Do Q`]])));
    await commitModel(src, model, 'ย้าย/ย่อรูป');
}

async function deleteImage(view, index) {
    selectImage(null);
    const src = state.sources.get(view.entry.srcId);
    const model = await pageModel(src, view.entry.index);
    const img = model.images[index];
    if (!img) return;
    setContent(model, rebuild(model.s, model.ops, new Map([[img.op, '']])));
    await commitModel(src, model, 'ลบรูป');
    toast('ลบรูปแล้ว (Ctrl+Z เพื่อย้อนกลับ)');
}

function pickReplacement(view, index) {
    const input = document.getElementById('edit-image-file');
    input.value = '';
    const onPick = async () => {
        input.removeEventListener('change', onPick);
        const file = input.files[0];
        if (!file) return;
        try {
            await replaceImage(view, index, new Uint8Array(await file.arrayBuffer()), file.type);
        } catch (err) {
            toast(`เปลี่ยนรูปไม่สำเร็จ: ${err.message}`, 'error');
        }
    };
    input.addEventListener('change', onPick);
    input.click();
}

async function replaceImage(view, index, bytes, type) {
    const src = state.sources.get(view.entry.srcId);
    const model = await pageModel(src, view.entry.index);
    const img = model.images[index];
    if (!img) return;
    let embedded;
    if (type === 'image/jpeg') embedded = await model.doc.embedJpg(bytes);
    else if (type === 'image/png') embedded = await model.doc.embedPng(bytes);
    else {
        const bitmap = await createImageBitmap(new Blob([bytes]));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        embedded = await model.doc.embedPng(new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()));
    }
    const name = model.page.node.newXObject('ImR', embedded.ref);
    // Fit the new picture inside the old one's box, centred.
    const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => apply(img.ctm, x, y));
    const x1 = Math.min(...corners.map((c) => c[0]));
    const x2 = Math.max(...corners.map((c) => c[0]));
    const y1 = Math.min(...corners.map((c) => c[1]));
    const y2 = Math.max(...corners.map((c) => c[1]));
    const s = Math.min((x2 - x1) / embedded.width, (y2 - y1) / embedded.height);
    const w = embedded.width * s;
    const h = embedded.height * s;
    const X = [w, 0, 0, h, x1 + (x2 - x1 - w) / 2, y1 + (y2 - y1 - h) / 2];
    const M = mul(X, invert(img.ctm));
    setContent(model, rebuild(model.s, model.ops, new Map([[img.op, `q ${fmt(M)} cm ${name.toString()} Do Q`]])));
    await commitModel(src, model, 'เปลี่ยนรูป');
}

// Tools > Add Image: place a picture like a signature (flattened on save).
export function addImage() {
    const input = document.getElementById('edit-image-file');
    input.value = '';
    const onPick = async () => {
        input.removeEventListener('change', onPick);
        const file = input.files[0];
        if (!file) return;
        const bitmap = await createImageBitmap(file);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        placeImage(canvas.toDataURL('image/png'), bitmap.width / bitmap.height);
        toast('คลิกบนหน้าเพื่อวางรูป จากนั้นลากเพื่อย้าย หรือลากมุมเพื่อปรับขนาด');
    };
    input.addEventListener('change', onPick);
    input.click();
}

export function startEditTool(name) {
    setTool(name);
    if (name === 'edit') toast('คลิกที่บรรทัดข้อความเพื่อแก้ไข หรือคลิกรูปเพื่อย้าย/ย่อ/ลบ (Ctrl+Z ย้อนกลับ)');
    else if (name === 'addtext') toast('คลิกตำแหน่งบนหน้าที่จะวางข้อความใหม่');
}
