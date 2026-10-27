// Page thumbnails: navigate, drag to reorder, rotate, delete.

import { on } from './bus.js';
import { state, getPdfPage, movePage, rotatePage, deletePage } from './docstate.js';
import { scrollToIndex } from './viewer.js';
import { toast } from './dialog.js';

const THUMB_WIDTH = 132;
const $ = (id) => document.getElementById(id);

let list;
let observer;
let dragFrom = -1;
const rendered = new Map(); // "key:rotation" -> canvas

export function initThumbs() {
    list = $('thumbs');
    observer = new IntersectionObserver(onIntersect, { root: list.parentElement, rootMargin: '200px 0px' });
    on('layout-changed', rebuildThumbs);
    on('current-page', markCurrent);

    list.addEventListener('click', (e) => {
        const item = e.target.closest('.thumb');
        if (!item) return;
        const idx = Number(item.dataset.idx);
        const action = e.target.closest('[data-action]')?.dataset.action;
        if (action === 'rotate-left') rotatePage(idx, -90);
        else if (action === 'rotate-right') rotatePage(idx, 90);
        else if (action === 'delete') {
            if (!deletePage(idx)) toast('ต้องเหลืออย่างน้อย 1 หน้า', 'error');
        } else scrollToIndex(idx);
    });

    list.addEventListener('dragstart', (e) => {
        const item = e.target.closest('.thumb');
        if (!item) return;
        dragFrom = Number(item.dataset.idx);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/x-page', String(dragFrom));
        item.classList.add('is-dragging');
    });
    list.addEventListener('dragover', (e) => {
        if (dragFrom < 0) return;
        e.preventDefault();
        const item = e.target.closest('.thumb');
        list.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
        if (item) item.classList.add(isAfter(e, item) ? 'drop-after' : 'drop-before');
    });
    list.addEventListener('drop', (e) => {
        if (dragFrom < 0) return;
        e.preventDefault();
        const item = e.target.closest('.thumb');
        if (item) {
            let to = Number(item.dataset.idx) + (isAfter(e, item) ? 1 : 0);
            if (to > dragFrom) to--;
            movePage(dragFrom, to);
        }
        endDrag();
    });
    list.addEventListener('dragend', endDrag);
}

function isAfter(e, item) {
    const r = item.getBoundingClientRect();
    return e.clientY > r.top + r.height / 2;
}

function endDrag() {
    dragFrom = -1;
    list.querySelectorAll('.is-dragging, .drop-before, .drop-after').forEach((el) => el.classList.remove('is-dragging', 'drop-before', 'drop-after'));
}

function rebuildThumbs() {
    observer.disconnect();
    const frag = document.createDocumentFragment();
    state.pages.forEach((entry, idx) => {
        const li = document.createElement('li');
        li.className = 'thumb';
        li.draggable = true;
        li.dataset.idx = idx;
        li.dataset.key = entry.key;
        li.dataset.rotation = entry.rotation;
        li.innerHTML = `
            <div class="thumb-canvas"></div>
            <div class="thumb-bar">
                <span class="thumb-num">${idx + 1}</span>
                <span class="thumb-actions">
                    <button type="button" data-action="rotate-left" title="Rotate left">⟲</button>
                    <button type="button" data-action="rotate-right" title="Rotate right">⟳</button>
                    <button type="button" data-action="delete" title="Delete page">🗑</button>
                </span>
            </div>`;
        const cached = rendered.get(`${entry.key}:${entry.rotation}`);
        if (cached) li.querySelector('.thumb-canvas').append(cached);
        frag.append(li);
        observer.observe(li);
    });
    list.replaceChildren(frag);
    $('page-count').textContent = state.pages.length;
}

function onIntersect(entries) {
    for (const ent of entries) {
        if (ent.isIntersecting) renderThumb(ent.target);
    }
}

async function renderThumb(li) {
    const entry = state.pages.find((p) => p.key === li.dataset.key);
    if (!entry) return;
    const cacheKey = `${entry.key}:${entry.rotation}`;
    if (rendered.has(cacheKey)) return;
    rendered.set(cacheKey, null);
    const page = await getPdfPage(entry);
    const rotation = (page.rotate + entry.rotation) % 360;
    const base = page.getViewport({ scale: 1, rotation });
    const dpr = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: (THUMB_WIDTH / base.width) * dpr, rotation });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport }).promise;
    rendered.set(cacheKey, canvas);
    const target = list.querySelector(`.thumb[data-key="${entry.key}"][data-rotation="${entry.rotation}"] .thumb-canvas`);
    if (target && !target.firstChild) target.append(canvas);
}

function markCurrent(idx) {
    list.querySelector('.thumb.is-current')?.classList.remove('is-current');
    const item = list.children[idx];
    if (!item) return;
    item.classList.add('is-current');
    item.scrollIntoView({ block: 'nearest' });
}

export function resetThumbs() {
    rendered.clear();
    list.replaceChildren();
}
