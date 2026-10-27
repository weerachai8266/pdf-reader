// Annotation tools: highlight, sticky note, signature/image, redaction
// marks, eraser.
//
// Each annotation's geometry is a "quad" of three PDF-space points taken
// from the on-screen box it was created in: bottom-left, bottom-right and
// top-left as the user saw them. Mapping those back through any viewport
// gives position, size and on-screen angle, so annotations survive zooming
// and page rotation, and save.js can draw them upright.

import { on, emit } from './bus.js';
import { addAnnot, annotsFor, removeAnnot, updateAnnot } from './docstate.js';
import { getView, allViews } from './viewer.js';
import { HIGHLIGHT_COLORS, SIGNATURE_DEFAULT_WIDTH_PT } from './config.js';
import { promptText } from './dialog.js';

let tool = 'select';
let highlightColor = 'yellow';
let pendingImage = null; // { dataUrl, aspect } waiting to be placed
let selected = null; // { key, id }

export function initAnnotate(scroller) {
    on('page-rendered', (view) => drawAnnots(view));
    on('annots-changed', (key) => {
        const view = getView(key);
        if (view && view.viewport) drawAnnots(view);
    });
    scroller.addEventListener('mouseup', onMouseUp);
    scroller.addEventListener('click', onClick);
    scroller.addEventListener('pointerdown', startRedactMark);
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
    if (!createHighlightFromSelection()) setTool('highlight');
    emit('highlight-color', color);
}

export function placeImage(dataUrl, aspect) {
    pendingImage = { dataUrl, aspect };
    setTool('image');
}

// ---- geometry ---------------------------------------------------------

function quadFromViewRect(viewport, left, top, right, bottom) {
    return {
        bl: viewport.convertToPdfPoint(left, bottom),
        br: viewport.convertToPdfPoint(right, bottom),
        tl: viewport.convertToPdfPoint(left, top),
    };
}

function quadToView(viewport, quad) {
    const [blx, bly] = viewport.convertToViewportPoint(...quad.bl);
    const [brx, bry] = viewport.convertToViewportPoint(...quad.br);
    const [tlx, tly] = viewport.convertToViewportPoint(...quad.tl);
    return {
        x: blx,
        y: bly,
        w: Math.hypot(brx - blx, bry - bly),
        h: Math.hypot(tlx - blx, tly - bly),
        angle: Math.atan2(bry - bly, brx - blx),
    };
}

function placeBox(el, box) {
    el.style.left = `${box.x}px`;
    el.style.top = `${box.y - box.h}px`;
    el.style.width = `${box.w}px`;
    el.style.height = `${box.h}px`;
    el.style.setProperty('--angle', `${box.angle}rad`);
}

function pointInPage(view, clientX, clientY) {
    const r = view.div.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top, rect: r };
}

// ---- drawing ----------------------------------------------------------

function drawAnnots(view) {
    const layer = view.annotLayer;
    layer.replaceChildren();
    for (const a of annotsFor(view.entry.key)) {
        if (a.type === 'highlight') {
            for (const quad of a.quads) {
                const el = document.createElement('div');
                el.className = `annot-highlight hl-${a.color}`;
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
            el.textContent = '💬';
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
}

// ---- highlight --------------------------------------------------------

function createHighlightFromSelection() {
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
        addAnnot(view.entry.key, { type: 'highlight', color: highlightColor, quads });
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

// ---- redaction marks -----------------------------------------------------

// Drag a rectangle on the page; it becomes a redaction mark that
// redact.js turns into real removal.
function startRedactMark(e) {
    if (tool !== 'redact' || e.button !== 0) return;
    const view = viewFromEvent(e);
    if (!view || !view.viewport) return;
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
        addAnnot(view.entry.key, { type: 'redact', quad: quadFromViewRect(view.viewport, rect.left, rect.top, rect.right, rect.bottom) });
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
}

// ---- events -----------------------------------------------------------

function onMouseUp() {
    if (tool === 'highlight') createHighlightFromSelection();
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
    } else if (tool === 'image' && pendingImage) {
        const w = SIGNATURE_DEFAULT_WIDTH_PT * view.viewport.scale;
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

function onKeyDown(e) {
    if (e.target.closest('input, textarea, dialog')) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        removeAnnot(selected.key, selected.id);
        selected = null;
    } else if (e.key === 'Escape') {
        select(null);
        setTool('select');
    }
}

// ---- move / resize images ----------------------------------------------

// Inverse of quadToView: a view box (bottom-left anchor, size, angle) back
// to PDF-space corners.
function quadFromBox(viewport, box) {
    const cos = Math.cos(box.angle);
    const sin = Math.sin(box.angle);
    return {
        bl: viewport.convertToPdfPoint(box.x, box.y),
        br: viewport.convertToPdfPoint(box.x + box.w * cos, box.y + box.w * sin),
        tl: viewport.convertToPdfPoint(box.x + box.h * sin, box.y - box.h * cos),
    };
}

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

export function highlightRgb(color) {
    return HIGHLIGHT_COLORS[color] || HIGHLIGHT_COLORS.yellow;
}

