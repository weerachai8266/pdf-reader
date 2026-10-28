// Ink markup: underline, strikethrough, shapes (rectangle, ellipse, line,
// arrow) and text boxes. annotate.js owns the tools and events; this module
// draws these annotations on screen, creates lines and text boxes, and
// moves shapes and text boxes. savemarkup.js writes them into the PDF.
//
// Shapes with a box (rectangle, ellipse) and text boxes keep a quad like
// the other annotations; lines and arrows keep two PDF points.

import { addAnnot, annotsFor, removeAnnot, updateAnnot } from './docstate.js';
import { SHAPE_LINE_WIDTH_PT, TEXTBOX_FONT_PT } from './config.js';
import {
    quadToView, quadFromViewRect, placeBox, subBox, pointInPage, shiftAnnot, markLine, arrowHead,
    TEXTBOX, textboxSize, resizeQuadFromTop,
} from './annotgeom.js';
import { promptText } from './dialog.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export const TEXT_MARKUP = new Set(['highlight', 'underline', 'strike']);
export const BOX_SHAPES = new Set(['rect', 'ellipse']);
export const LINE_SHAPES = new Set(['line', 'arrow']);
// Annotation types whose colour comes from the ink swatches.
export const INK_TYPES = new Set(['underline', 'strike', 'shape', 'textbox']);

let inkColor = 'red';

export function getInkColor() {
    return inkColor;
}

export function setInkColorValue(color) {
    inkColor = color;
}

// ---- drawing ----------------------------------------------------------

// Elements for one annotation of an ink type, or null for other types.
export function drawMarkup(view, annot, onSelect) {
    if (annot.type === 'underline' || annot.type === 'strike') return markLines(view, annot);
    if (annot.type === 'shape') return [movable(shapeSvg(view, annot), view, annot, onSelect)];
    if (annot.type === 'textbox') return [movable(textboxEl(view, annot), view, annot, onSelect)];
    return null;
}

function markLines(view, annot) {
    return annot.quads.map((quad) => {
        const box = quadToView(view.viewport, quad);
        const { y0, t } = markLine(annot.type, box.h, 1);
        const el = document.createElement('div');
        el.className = `annot-mark ink-${annot.color}`;
        el.dataset.id = annot.id;
        placeBox(el, subBox(box, y0, t));
        return el;
    });
}

// SVG path data, in view pixels, plus the points that bound it.
function shapePath(viewport, annot) {
    const pt = (p) => viewport.convertToViewportPoint(...p);
    const w = SHAPE_LINE_WIDTH_PT * viewport.scale;
    if (BOX_SHAPES.has(annot.shape)) {
        const [bl, br, tl] = [pt(annot.quad.bl), pt(annot.quad.br), pt(annot.quad.tl)];
        const tr = [br[0] + tl[0] - bl[0], br[1] + tl[1] - bl[1]];
        const points = [bl, br, tr, tl];
        if (annot.shape === 'rect') return { d: `M${points.map((p) => p.join(' ')).join(' L')} Z`, points, w };
        const rx = Math.hypot(br[0] - bl[0], br[1] - bl[1]) / 2;
        const ry = Math.hypot(tl[0] - bl[0], tl[1] - bl[1]) / 2;
        const c = [(bl[0] + tr[0]) / 2, (bl[1] + tr[1]) / 2];
        const a = Math.atan2(br[1] - bl[1], br[0] - bl[0]);
        const deg = (a * 180) / Math.PI;
        const p1 = [c[0] - rx * Math.cos(a), c[1] - rx * Math.sin(a)];
        const p2 = [c[0] + rx * Math.cos(a), c[1] + rx * Math.sin(a)];
        const arc = (p) => `A${rx} ${ry} ${deg} 1 0 ${p[0]} ${p[1]}`;
        return { d: `M${p1.join(' ')} ${arc(p2)} ${arc(p1)} Z`, points, w };
    }
    const from = pt(annot.from);
    const to = pt(annot.to);
    let d = `M${from.join(' ')} L${to.join(' ')}`;
    const points = [from, to];
    if (annot.shape === 'arrow') {
        const [left, right] = arrowHead(from, to, w);
        d += ` M${left.join(' ')} L${to.join(' ')} L${right.join(' ')}`;
        points.push(left, right);
    }
    return { d, points, w };
}

// An <svg> just big enough for the shape, drawn in view coordinates. A
// wide transparent copy of the stroke makes thin lines easy to click.
function shapeSvg(view, annot) {
    const { d, points, w } = shapePath(view.viewport, annot);
    const m = w + 8;
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const left = Math.min(...xs) - m;
    const top = Math.min(...ys) - m;
    const width = Math.max(...xs) + m - left;
    const height = Math.max(...ys) + m - top;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', `annot-shape ink-${annot.color}`);
    svg.setAttribute('viewBox', `${left} ${top} ${width} ${height}`);
    svg.dataset.id = annot.id;
    svg.style.left = `${left}px`;
    svg.style.top = `${top}px`;
    svg.style.width = `${width}px`;
    svg.style.height = `${height}px`;
    for (const cls of ['shape-hit', 'shape-stroke']) {
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('class', cls);
        path.setAttribute('d', d);
        path.setAttribute('stroke-width', String(cls === 'shape-hit' ? Math.max(12, w + 8) : w));
        svg.append(path);
    }
    return svg;
}

function textboxEl(view, annot) {
    const s = view.viewport.scale;
    const el = document.createElement('div');
    el.className = `annot-textbox ink-${annot.color}`;
    el.dataset.id = annot.id;
    el.title = 'ดับเบิลคลิกเพื่อแก้ข้อความ ลากเพื่อย้าย';
    placeBox(el, quadToView(view.viewport, annot.quad));
    el.style.fontSize = `${annot.size * s}px`;
    el.style.padding = `${TEXTBOX.pad * s}px`;
    el.style.borderWidth = `${Math.max(1, TEXTBOX.border * s)}px`;
    el.textContent = annot.text;
    return el;
}

// ---- moving -------------------------------------------------------------

function movable(el, view, annot, onSelect) {
    el.addEventListener('pointerdown', (e) => startMove(e, view, annot, onSelect));
    return el;
}

// Drag with the Select tool moves the annotation; other tools (the eraser)
// get the plain click.
function startMove(e, view, annot, onSelect) {
    if (document.body.dataset.tool !== 'select' || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect(view.entry.key, annot.id);
    const el = e.currentTarget;
    const sx = e.clientX;
    const sy = e.clientY;
    let dx = 0;
    let dy = 0;
    el.setPointerCapture(e.pointerId);
    const move = (ev) => {
        dx = ev.clientX - sx;
        dy = ev.clientY - sy;
        el.style.translate = `${dx}px ${dy}px`;
    };
    const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.style.translate = '';
        if (Math.hypot(dx, dy) < 2) return;
        const [x0, y0] = view.viewport.convertToPdfPoint(0, 0);
        const [x1, y1] = view.viewport.convertToPdfPoint(dx, dy);
        updateAnnot(view.entry.key, annot.id, shiftAnnot(annot, x1 - x0, y1 - y0));
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
}

// ---- creating -------------------------------------------------------------

// Drag out a line or arrow (tool 'line' / 'arrow').
export function startLineDrag(e, view, shape) {
    e.preventDefault();
    const start = pointInPage(view, e.clientX, e.clientY);
    const from = view.viewport.convertToPdfPoint(start.x, start.y);
    const preview = { type: 'shape', shape, color: inkColor, from, to: from, id: 'drawing' };
    let svg = null;
    let end = start;
    // Listen on the window: the preview is redrawn under the pointer on
    // every move, which can swallow the captured pointerup.
    const move = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        end = pointInPage(view, ev.clientX, ev.clientY);
        preview.to = view.viewport.convertToPdfPoint(end.x, end.y);
        svg?.remove();
        svg = shapeSvg(view, preview);
        svg.classList.add('is-drawing');
        view.annotLayer.append(svg);
    };
    const up = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        svg?.remove();
        if (Math.hypot(end.x - start.x, end.y - start.y) < 4) return;
        addAnnot(view.entry.key, { type: 'shape', shape, color: inkColor, from, to: preview.to });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
}

export function addBoxShape(view, shape, quad) {
    return addAnnot(view.entry.key, { type: 'shape', shape, color: inkColor, quad });
}

// Text box with its top-left corner at view point (x, y).
export async function createTextbox(view, x, y) {
    const text = await promptText({ title: 'เพิ่มกล่องข้อความ', label: 'ข้อความ (Ctrl+Enter เพื่อเพิ่ม)', multiline: true });
    if (!text) return null;
    const size = TEXTBOX_FONT_PT;
    const { w, h } = textboxSize(text, size);
    const s = view.viewport.scale;
    const quad = quadFromViewRect(view.viewport, x, y, x + w * s, y + h * s);
    return addAnnot(view.entry.key, { type: 'textbox', text, color: inkColor, size, quad });
}

export async function editTextbox(key, id) {
    const annot = annotsFor(key).find((a) => a.id === id);
    if (!annot) return;
    const text = await promptText({ title: 'แก้กล่องข้อความ', label: 'ข้อความ', value: annot.text, multiline: true, allowDelete: true });
    if (text === null) return;
    if (text === '') {
        removeAnnot(key, id);
        return;
    }
    const { w, h } = textboxSize(text, annot.size);
    updateAnnot(key, id, { text, quad: resizeQuadFromTop(annot.quad, w, h) });
}
