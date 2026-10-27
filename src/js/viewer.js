// Continuous-scroll page viewer with lazy rendering.
//
// Every page gets a correctly sized placeholder up front; only pages near
// the viewport hold a canvas + text layer, and pages that scroll far away
// release them again. That keeps opening and scrolling fast on big files.

import { pdfjsLib } from './pdfjs.js';
import { state, getPdfPage } from './docstate.js';
import { emit, on } from './bus.js';
import { RENDER_MARGIN, ZOOM_MIN, ZOOM_MAX, ZOOM_STEP } from './config.js';

const CSS_UNITS = pdfjsLib.PixelsPerInch.PDF_TO_CSS_UNITS;
const PAGE_GAP = 12;

let scroller = null;
let pagesEl = null;
let observer = null;
let zoom = 1;
let zoomMode = 'width'; // 'width' | 'page' | 'custom'
let currentIdx = 0;

const views = new Map(); // page key -> view
const baseSizes = new Map(); // "srcId:index" -> { width, height, rotate }

export function initViewer(scrollEl, pagesContainer) {
    scroller = scrollEl;
    pagesEl = pagesContainer;
    observer = new IntersectionObserver(onIntersect, { root: scroller, rootMargin: RENDER_MARGIN });
    scroller.addEventListener('scroll', onScroll, { passive: true });
    // Re-fit on window resize; deferred a frame so the layout change doesn't
    // happen inside the ResizeObserver callback.
    new ResizeObserver(() => requestAnimationFrame(() => {
        if (zoomMode !== 'custom' && views.size) applyZoom(zoomForMode(zoomMode), zoomMode);
    })).observe(scroller);
    on('pages-changed', () => rebuild());
}

const sizeKey = (entry) => `${entry.srcId}:${entry.index}`;

async function ensureBaseSizes() {
    const missing = state.pages.filter((e) => !baseSizes.has(sizeKey(e)));
    await Promise.all(missing.map(async (entry) => {
        const page = await getPdfPage(entry);
        const vp = page.getViewport({ scale: 1, rotation: 0 });
        baseSizes.set(sizeKey(entry), { width: vp.width, height: vp.height, rotate: page.rotate });
    }));
}

function totalRotation(entry) {
    const base = baseSizes.get(sizeKey(entry));
    return ((base ? base.rotate : 0) + entry.rotation) % 360;
}

function cssSize(entry, scale = displayScale()) {
    const base = baseSizes.get(sizeKey(entry));
    const swap = totalRotation(entry) % 180 !== 0;
    const w = (swap ? base.height : base.width) * scale;
    const h = (swap ? base.width : base.height) * scale;
    return { width: Math.floor(w), height: Math.floor(h) };
}

export function displayScale() {
    return zoom * CSS_UNITS;
}

export function getZoom() {
    return { zoom, mode: zoomMode };
}

function createView(entry) {
    const div = document.createElement('div');
    div.className = 'page';
    div.dataset.key = entry.key;
    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    const annotLayer = document.createElement('div');
    annotLayer.className = 'annot-layer';
    div.append(textLayer, annotLayer);
    const view = {
        entry, div, textLayerDiv: textLayer, annotLayer,
        canvas: null, task: null, textLayer: null, viewport: null,
        rendered: false, visible: false, token: 0, rotationAtBuild: entry.rotation,
    };
    views.set(entry.key, view);
    observer.observe(div);
    return view;
}

function sizeView(view) {
    const { width, height } = cssSize(view.entry);
    view.div.style.width = `${width}px`;
    view.div.style.height = `${height}px`;
    view.div.style.setProperty('--scale-factor', displayScale());
    view.div.style.setProperty('--total-scale-factor', displayScale());
}

export async function rebuild() {
    await ensureBaseSizes();
    const keep = new Set(state.pages.map((e) => e.key));
    for (const [key, view] of views) {
        if (!keep.has(key) || view.rotationAtBuild !== view.entry.rotation) destroyView(view);
    }
    const frag = document.createDocumentFragment();
    for (const entry of state.pages) {
        const view = views.get(entry.key) || createView(entry);
        view.entry = entry;
        sizeView(view);
        frag.append(view.div);
    }
    pagesEl.replaceChildren(frag);
    if (zoomMode !== 'custom') applyZoom(zoomForMode(zoomMode), zoomMode, false);
    renderVisible();
    onScroll();
    emit('layout-changed');
}

function destroyView(view) {
    cancelRender(view);
    observer.unobserve(view.div);
    view.div.remove();
    views.delete(view.entry.key);
}

function cancelRender(view) {
    view.token++;
    if (view.task) {
        view.task.cancel();
        view.task = null;
    }
    if (view.textLayer) {
        view.textLayer.cancel();
        view.textLayer = null;
    }
}

function releaseView(view) {
    if (!view.rendered && !view.canvas) return;
    cancelRender(view);
    if (view.canvas) {
        view.canvas.width = 0;
        view.canvas.height = 0;
        view.canvas.remove();
        view.canvas = null;
    }
    view.textLayerDiv.replaceChildren();
    view.rendered = false;
}

function onIntersect(entries) {
    for (const ent of entries) {
        const view = views.get(ent.target.dataset.key);
        if (!view) continue;
        view.visible = ent.isIntersecting;
        if (view.visible) renderView(view);
        else releaseView(view);
    }
}

function renderVisible() {
    for (const view of views.values()) {
        if (view.visible) renderView(view);
    }
}

async function renderView(view) {
    if (view.rendered || view.task) return;
    const token = ++view.token;
    const entry = view.entry;
    const page = await getPdfPage(entry);
    if (token !== view.token) return;

    const viewport = page.getViewport({ scale: displayScale(), rotation: totalRotation(entry) });
    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    canvas.className = 'page-canvas';
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);

    const task = page.render({
        canvasContext: canvas.getContext('2d', { alpha: false }),
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    });
    view.task = task;
    try {
        await task.promise;
    } catch (err) {
        if (!(err instanceof pdfjsLib.RenderingCancelledException)) console.error('render failed', err);
        return;
    } finally {
        if (view.task === task) view.task = null;
    }
    if (token !== view.token) return;

    if (view.canvas) view.canvas.remove();
    view.canvas = canvas;
    view.div.prepend(canvas);
    view.viewport = viewport;
    view.rendered = true;
    emit('page-rendered', view);

    const textContent = await page.getTextContent();
    if (token !== view.token) return;
    view.textLayerDiv.replaceChildren();
    const textLayer = new pdfjsLib.TextLayer({ textContentSource: textContent, container: view.textLayerDiv, viewport });
    view.textLayer = textLayer;
    try {
        await textLayer.render();
    } catch {
        return;
    }
    if (token !== view.token) return;
    emit('text-layer-rendered', view);
}

// ---- zoom -------------------------------------------------------------

// Fit against the widest page so mixed portrait/landscape documents never
// need horizontal scrolling; "page" mode also fits the current page's height.
function zoomForMode(mode) {
    const sized = state.pages.filter((e) => baseSizes.has(sizeKey(e)));
    if (!sized.length) return zoom;
    const maxW = Math.max(...sized.map((e) => cssSize(e, CSS_UNITS).width));
    const availW = scroller.clientWidth - 2 * PAGE_GAP - 16;
    const fitW = availW / maxW;
    if (mode !== 'page') return fitW;
    const cur = state.pages[currentIdx] || sized[0];
    const availH = scroller.clientHeight - 2 * PAGE_GAP;
    return Math.min(fitW, availH / cssSize(cur, CSS_UNITS).height);
}

function applyZoom(newZoom, mode, keepPosition = true) {
    newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, newZoom));
    zoomMode = mode;
    if (Math.abs(newZoom - zoom) < 1e-4 && keepPosition) {
        emit('zoom-changed', getZoom());
        return;
    }
    const anchor = keepPosition ? captureScrollAnchor() : null;
    zoom = newZoom;
    for (const view of views.values()) {
        cancelRender(view);
        view.rendered = false;
        sizeView(view);
    }
    if (anchor) restoreScrollAnchor(anchor);
    renderVisible();
    emit('zoom-changed', getZoom());
}

export function setZoom(value) {
    if (value === 'width' || value === 'page') applyZoom(zoomForMode(value), value);
    else applyZoom(Number(value), 'custom');
}

export function zoomIn() {
    applyZoom(zoom * ZOOM_STEP, 'custom');
}

export function zoomOut() {
    applyZoom(zoom / ZOOM_STEP, 'custom');
}

function captureScrollAnchor() {
    const view = views.get(state.pages[currentIdx]?.key);
    if (!view) return null;
    const offset = scroller.scrollTop - view.div.offsetTop;
    return { key: view.entry.key, ratio: offset / view.div.offsetHeight };
}

function restoreScrollAnchor({ key, ratio }) {
    const view = views.get(key);
    if (view) scroller.scrollTop = view.div.offsetTop + ratio * view.div.offsetHeight;
}

// ---- navigation -------------------------------------------------------

let scrollQueued = false;
function onScroll() {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
        scrollQueued = false;
        const idx = findPageAt(scroller.scrollTop + scroller.clientHeight * 0.3);
        if (idx !== currentIdx) {
            currentIdx = idx;
            emit('current-page', idx);
        }
    });
}

function findPageAt(y) {
    let lo = 0;
    let hi = state.pages.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        const view = views.get(state.pages[mid].key);
        if (view && view.div.offsetTop <= y) lo = mid;
        else hi = mid - 1;
    }
    return Math.max(0, lo);
}

export function currentPageIndex() {
    return currentIdx;
}

export function scrollToIndex(idx, offsetPx = 0) {
    const entry = state.pages[Math.max(0, Math.min(idx, state.pages.length - 1))];
    const view = entry && views.get(entry.key);
    if (!view) return;
    scroller.scrollTop = view.div.offsetTop - PAGE_GAP + offsetPx;
}

export function getView(key) {
    return views.get(key);
}

export function allViews() {
    return views.values();
}

export function clearViewer() {
    for (const view of [...views.values()]) destroyView(view);
    baseSizes.clear();
    currentIdx = 0;
    pagesEl.replaceChildren();
}
