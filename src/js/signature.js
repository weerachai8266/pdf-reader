// Signature pad: draw, type or load an image, then place it on a page.
// Recent signatures are remembered in localStorage (a per-machine
// convenience only; the app works the same if storage is unavailable).

import { placeImage } from './annotate.js';

const STORE_KEY = 'pdf-reader.signatures';
const MAX_SAVED = 6;
const $ = (id) => document.getElementById(id);

let pad;
let ctx;
let drawing = false;
let hasInk = false;
let last = null;

export function initSignature() {
    pad = $('sig-pad');
    ctx = pad.getContext('2d');
    pad.addEventListener('pointerdown', (e) => {
        drawing = true;
        hasInk = true;
        last = point(e);
        pad.setPointerCapture(e.pointerId);
    });
    pad.addEventListener('pointermove', (e) => {
        if (!drawing) return;
        const p = point(e);
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        last = p;
    });
    pad.addEventListener('pointerup', () => {
        drawing = false;
    });
    $('sig-clear').addEventListener('click', clearPad);
    $('sig-color').addEventListener('change', applyPen);
    $('sig-use').addEventListener('click', useDrawn);
    $('sig-image').addEventListener('change', useImageFile);
    $('sig-saved').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-index]');
        if (!btn) return;
        const item = loadSaved()[Number(btn.dataset.index)];
        if (e.target.closest('.sig-remove')) {
            removeSaved(Number(btn.dataset.index));
            return;
        }
        if (item) finish(item.dataUrl, item.aspect, false);
    });
}

export function openSignatureDialog() {
    clearPad();
    renderSaved();
    $('dlg-signature').showModal();
}

function point(e) {
    const r = pad.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * pad.width) / r.width, y: ((e.clientY - r.top) * pad.height) / r.height };
}

function applyPen() {
    ctx.strokeStyle = $('sig-color').value;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
}

function clearPad() {
    ctx.clearRect(0, 0, pad.width, pad.height);
    hasInk = false;
    applyPen();
}

// Crop the drawing to its ink so it places tightly on the page.
function croppedDataUrl() {
    const { width, height } = pad;
    const data = ctx.getImageData(0, 0, width, height).data;
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (data[(y * width + x) * 4 + 3] > 0) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }
    if (maxX < 0) return null;
    const pad8 = 8;
    minX = Math.max(0, minX - pad8);
    minY = Math.max(0, minY - pad8);
    maxX = Math.min(width - 1, maxX + pad8);
    maxY = Math.min(height - 1, maxY + pad8);
    const out = document.createElement('canvas');
    out.width = maxX - minX + 1;
    out.height = maxY - minY + 1;
    out.getContext('2d').drawImage(pad, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
    return { dataUrl: out.toDataURL('image/png'), aspect: out.width / out.height };
}

function useDrawn() {
    if (!hasInk) return;
    const result = croppedDataUrl();
    if (result) finish(result.dataUrl, result.aspect, true);
}

function useImageFile(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        const img = new Image();
        img.onload = () => {
            // Normalise to PNG so save.js only has to embed one format.
            const c = document.createElement('canvas');
            c.width = img.naturalWidth;
            c.height = img.naturalHeight;
            c.getContext('2d').drawImage(img, 0, 0);
            finish(c.toDataURL('image/png'), c.width / c.height, true);
        };
        img.src = reader.result;
    };
    reader.readAsDataURL(file);
}

function finish(dataUrl, aspect, remember) {
    if (remember) saveSignature({ dataUrl, aspect });
    $('dlg-signature').close();
    placeImage(dataUrl, aspect);
}

function loadSaved() {
    try {
        return JSON.parse(localStorage.getItem(STORE_KEY)) || [];
    } catch {
        return [];
    }
}

function storeSaved(list) {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(list));
    } catch {
        // Storage full or blocked: signatures just won't be remembered.
    }
}

function saveSignature(item) {
    storeSaved([item, ...loadSaved().filter((s) => s.dataUrl !== item.dataUrl)].slice(0, MAX_SAVED));
}

function removeSaved(index) {
    const list = loadSaved();
    list.splice(index, 1);
    storeSaved(list);
    renderSaved();
}

function renderSaved() {
    const list = loadSaved();
    const box = $('sig-saved');
    box.replaceChildren();
    $('sig-saved-empty').hidden = list.length > 0;
    list.forEach((item, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sig-saved-item';
        btn.dataset.index = i;
        btn.title = 'ใช้ลายเซ็นนี้';
        const img = document.createElement('img');
        img.src = item.dataUrl;
        img.alt = 'ลายเซ็นที่บันทึกไว้';
        const rm = document.createElement('span');
        rm.className = 'sig-remove';
        rm.title = 'ลบ';
        rm.textContent = '×';
        btn.append(img, rm);
        box.append(btn);
    });
}
