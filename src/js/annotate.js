// Annotation tools: highlight, underline, strikethrough, sticky note,
// signature/image/stamp, shapes, text boxes, redaction marks, eraser, and
// the area drag used by Copy Text from Area and certificate signing.
//
// Geometry is kept in PDF space (see annotgeom.js), so annotations survive
// zooming and page rotation. Ink markup (underline, shapes, text boxes) is
// drawn and created by markup.js.

import { on, emit } from './bus.js';
import { addAnnot, annotsFor, removeAnnot, updateAnnot } from './docstate.js';
import { getView, allViews } from './viewer.js';
import { SIGNATURE_DEFAULT_WIDTH_PT } from './config.js';
import { paintColor } from './colors.js';
import { promptText } from './dialog.js';
import { icon } from './icons.js';
import { quadFromViewRect, quadToView, quadFromBox, placeBox, pointInPage } from './annotgeom.js';
import {
    TEXT_MARKUP, BOX_SHAPES, LINE_SHAPES, INK_TYPES, drawMarkup, startLineDrag, addBoxShape,
    createTextbox, editTextbox, getInkColor, setInkColorValue,
} from './markup.js';

// Tools that drag out a rectangle on the page.
const BOX_TOOLS = new Set(['redact', 'certsign', 'areatext', ...BOX_SHAPES]);

let tool = 'select';
let highlightColor = 'yellow';
let pendingImage = null; // { dataUrl, aspect, widthPt } waiting to be placed
let selected = null; // { key, id }

export function initAnnotate(scroller) {
    on('page-rendered', (view) => drawAnnots(view));
    on('annots-changed', (key) => {
        const view = getView(key);
        if (view && view.viewport) drawAnnots(view);
    });
    scroller.addEventListener('mouseup', onMouseUp);
    scroller.addEventListener('click', onClick);
    scroller.addEventListener('pointerdown', onPointerDown);
    scroller.addEventListener('dblclick', onDoubleClick);
    document.addEventListener('keydown', onKeyDown);
}

export function setTool(name) {
    tool = name;
    if (name !== 'image') pendingImage = null;
    document.body.dataset.tool = name;
    emit('tool-changed', name);
}

export function getTool() {
    return tool;
}

export function setHighlightColor(color) {
    highlightColor = color;
    // Applying a colour to an existing text selection is the fastest workflow.
    if (!createTextMarkup('highlight')) setTool('highlight');
    emit('highlight-color', color);
}

// Ink colour (underline, strikethrough, shapes, text boxes): recolours the
// selected ink annotation, or marks the current text selection.
export function setInkColor(color) {
    setInkColorValue(color);
    const annot = selected && annotsFor(selected.key).find((a) => a.id === selected.id);
    if (annot && INK_TYPES.has(annot.type)) updateAnnot(selected.key, selected.id, { color });
    else if (tool === 'underline' || tool === 'strike') createTextMarkup(tool);
}

// widthPt: placed width on the page (signatures use the default).
export function placeImage(dataUrl, aspect, widthPt = SIGNATURE_DEFAULT_WIDTH_PT) {
    pendingImage = { dataUrl, aspect, widthPt };
    setTool('image');
}

// ---- drawing ----------------------------------------------------------

function drawAnnots(view) {
    const layer = view.annotLayer;
    layer.replaceChildren();
    for (const a of annotsFor(view.entry.key)) {
        if (a.type === 'highlight') {
            for (const quad of a.quads) {
                const el = document.createElement('div');
                el.className = 'annot-highlight';
                paintColor(el, 'hl', a.color);
                el.dataset.id = a.id;
                placeBox(el, quadToView(view.viewport, quad));
                layer.append(el);
            }
        } else if (a.type === 'note') {
            const [x, y] = view.viewport.convertToViewportPoint(...a.at);
            const el = document.createElement('button');
            el.type = 'button';
            el.className = 'annot-note';
            el.dataset.id = a.id;
            el.title = a.text;
            el.style.left = `${x}px`;
            el.style.top = `${y}px`;
            el.append(icon('message-square-text'));
            layer.append(el);
        } else if (a.type === 'redact') {
            const el = document.createElement('div');
            el.className = 'annot-redact';
            el.dataset.id = a.id;
            el.title = 'Redaction mark (Apply Redactions to remove)';
            placeBox(el, quadToView(view.viewport, a.quad));
            layer.append(el);
        } else if (a.type === 'image') {
            const el = document.createElement('div');
            el.className = 'annot-image';
            el.dataset.id = a.id;
            placeBox(el, quadToView(view.viewport, a.quad));
            const img = document.createElement('img');
            img.src = a.dataUrl;
            img.alt = '';
            img.draggable = false;
            const handle = document.createElement('span');
            handle.className = 'resize-handle';
            el.append(img, handle);
            el.addEventListener('pointerdown', (e) => startDrag(e, view, a));
            layer.append(el);
        } else {
            const els = drawMarkup(view, a, select);
            if (els) layer.append(...els);
        }
    }
    if (selected && selected.key === view.entry.key) markSelected();
}

function markSelected() {
    document.querySelectorAll('.annot-layer .is-selected').forEach((el) => el.classList.remove('is-selected'));
    if (!selected) return;
    const view = getView(selected.key);
    view?.annotLayer.querySelectorAll(`[data-id="${selected.id}"]`).forEach((el) => el.classList.add('is-selected'));
}

function select(key, id) {
    selected = key ? { key, id } : null;
    markSelected();
    // Shows the ink swatches so the selection can be recoloured.
    const annot = key && annotsFor(key).find((a) => a.id === id);
    document.body.classList.toggle('ink-selected', !!annot && INK_TYPES.has(annot.type));
}

// ---- highlight, underline, strikethrough ---------------------------------

// Marks the current text selection; false when nothing is selected.
function createTextMarkup(type) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
    const rects = [];
    for (let i = 0; i < sel.rangeCount; i++) rects.push(...sel.getRangeAt(i).getClientRects());
    const byPage = new Map();
    for (const view of allViews()) {
        if (!view.viewport) continue;
        const pr = view.div.getBoundingClientRect();
        for (const r of rects) {
            if (r.width < 1 || r.height < 1) continue;
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            if (cx < pr.left || cx > pr.right || cy < pr.top || cy > pr.bottom) continue;
            const list = byPage.get(view) || [];
            list.push({ left: r.left - pr.left, top: r.top - pr.top, right: r.right - pr.left, bottom: r.bottom - pr.top });
            byPage.set(view, list);
        }
    }
    if (!byPage.size) return false;
    for (const [view, list] of byPage) {
        const quads = mergeLineRects(list).map((r) => quadFromViewRect(view.viewport, r.left, r.top, r.right, r.bottom));
        const color = type === 'highlight' ? highlightColor : getInkColor();
        addAnnot(view.entry.key, { type, color, quads });
    }
    sel.removeAllRanges();
    return true;
}

// Chromium returns one rect per text span (often overlapping). Merge rects
// that sit on the same line so a highlight is one clean bar per line.
function mergeLineRects(rects) {
    const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left);
    const out = [];
    for (const r of sorted) {
        const last = out[out.length - 1];
        const sameLine = last && Math.abs(last.top - r.top) < (r.bottom - r.top) * 0.5 && r.left <= last.right + 4;
        if (sameLine) {
            last.right = Math.max(last.right, r.right);
            last.top = Math.min(last.top, r.top);
            last.bottom = Math.max(last.bottom, r.bottom);
        } else {
            out.push({ ...r });
        }
    }
    return out;
}

// ---- area drags -----------------------------------------------------------

function onPointerDown(e) {
    if (e.button !== 0) return;
    const view = viewFromEvent(e);
    if (!view || !view.viewport) return;
    if (BOX_TOOLS.has(tool)) startAreaDrag(e, view);
    else if (LINE_SHAPES.has(tool)) startLineDrag(e, view, tool);
}

// Drag a rectangle on the page. It becomes a redaction mark (redact.js
// turns it into real removal), a rectangle or ellipse, the area of a
// certificate signature (certsign.js) or of Copy Text from Area
// (areatext.js).
function startAreaDrag(e, view) {
    e.preventDefault();
    const start = pointInPage(view, e.clientX, e.clientY);
    const box = document.createElement('div');
    box.className = 'annot-redact is-drawing';
    view.annotLayer.append(box);
    const target = e.target;
    target.setPointerCapture(e.pointerId);
    let rect = null;

    const move = (ev) => {
        const p = pointInPage(view, ev.clientX, ev.clientY);
        const clamp = (v, max) => Math.min(Math.max(v, 0), max);
        const x2 = clamp(p.x, p.rect.width);
        const y2 = clamp(p.y, p.rect.height);
        rect = { left: Math.min(start.x, x2), top: Math.min(start.y, y2), right: Math.max(start.x, x2), bottom: Math.max(start.y, y2) };
        placeBox(box, { x: rect.left, y: rect.bottom, w: rect.right - rect.left, h: rect.bottom - rect.top, angle: 0 });
    };
    const up = () => {
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', up);
        box.remove();
        if (!rect || rect.right - rect.left < 3 || rect.bottom - rect.top < 3) return;
        const quad = quadFromViewRect(view.viewport, rect.left, rect.top, rect.right, rect.bottom);
        if (tool === 'certsign') emit('cert-sign-area', { entry: view.entry, quad });
        else if (tool === 'areatext') emit('area-text', { entry: view.entry, quad });
        else if (BOX_SHAPES.has(tool)) addBoxShape(view, tool, quad);
        else addAnnot(view.entry.key, { type: 'redact', quad });
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
}

// ---- events -----------------------------------------------------------

function onMouseUp() {
    if (TEXT_MARKUP.has(tool)) createTextMarkup(tool);
}

function viewFromEvent(e) {
    const pageDiv = e.target.closest('.page');
    return pageDiv ? getView(pageDiv.dataset.key) : null;
}

async function onClick(e) {
    const view = viewFromEvent(e);
    if (!view || !view.viewport) return;
    const key = view.entry.key;
    const annotEl = e.target.closest('[data-id]');

    if (tool === 'eraser') {
        if (annotEl) removeAnnot(key, annotEl.dataset.id);
        return;
    }

    if (annotEl && annotEl.classList.contains('annot-note')) {
        await editNote(key, annotEl.dataset.id);
        return;
    }
    if (annotEl) {
        select(key, annotEl.dataset.id);
        return;
    }
    select(null);

    const { x, y } = pointInPage(view, e.clientX, e.clientY);
    if (tool === 'note') {
        const text = await promptText({ title: 'เพิ่มโน้ต', label: 'ข้อความ', multiline: true });
        if (text) addAnnot(key, { type: 'note', at: view.viewport.convertToPdfPoint(x, y), text });
        setTool('select');
    } else if (tool === 'textbox') {
        const annot = await createTextbox(view, x, y);
        setTool('select');
        if (annot) select(key, annot.id);
    } else if (tool === 'image' && pendingImage) {
        const w = pendingImage.widthPt * view.viewport.scale;
        const h = w / pendingImage.aspect;
        const quad = quadFromViewRect(view.viewport, x - w / 2, y - h / 2, x + w / 2, y + h / 2);
        const annot = addAnnot(key, { type: 'image', dataUrl: pendingImage.dataUrl, quad });
        select(key, annot.id);
        setTool('select');
    }
}

async function editNote(key, id) {
    const annot = annotsFor(key).find((a) => a.id === id);
    if (!annot) return;
    const text = await promptText({ title: 'แก้ไขโน้ต', label: 'ข้อความ', value: annot.text, multiline: true, allowDelete: true });
    if (text === null) return;
    if (text === '') removeAnnot(key, id);
    else updateAnnot(key, id, { text });
}

function onDoubleClick(e) {
    const el = e.target.closest('.annot-textbox');
    const view = el && viewFromEvent(e);
    if (view && tool === 'select') editTextbox(view.entry.key, el.dataset.id);
}

function onKeyDown(e) {
    if (e.target.closest('input, textarea, dialog')) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        removeAnnot(selected.key, selected.id);
        select(null);
    } else if (e.key === 'Escape') {
        select(null);
        setTool('select');
    }
}

// ---- move / resize images ----------------------------------------------

function startDrag(e, view, annot) {
    if (tool === 'eraser' || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    select(view.entry.key, annot.id);
    const el = e.currentTarget;
    const resizing = e.target.classList.contains('resize-handle');
    const start = quadToView(view.viewport, annot.quad);
    const sx = e.clientX;
    const sy = e.clientY;
    el.setPointerCapture(e.pointerId);
    let box = start;

    const move = (ev) => {
        const dx = ev.clientX - sx;
        const dy = ev.clientY - sy;
        if (resizing) {
            // Keep the aspect ratio and the top-left corner where it is.
            const w = Math.max(20, start.w + dx);
            const h = w * (start.h / start.w);
            const sin = Math.sin(start.angle);
            const cos = Math.cos(start.angle);
            const tlx = start.x + start.h * sin;
            const tly = start.y - start.h * cos;
            box = { ...start, x: tlx - h * sin, y: tly + h * cos, w, h };
        } else {
            box = { ...start, x: start.x + dx, y: start.y + dy };
        }
        placeBox(el, box);
    };
    const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        if (box !== start) updateAnnot(view.entry.key, annot.id, { quad: quadFromBox(view.viewport, box) });
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
}


