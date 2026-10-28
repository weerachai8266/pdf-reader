// Tools > Stamp: ready-made office stamps (อนุมัติ, สำเนาถูกต้อง, ลับ …),
// a custom text stamp, or an image of the organisation's own rubber stamp.
// Text stamps are drawn on a canvas (so Thai is shaped by the system font)
// and placed like a signature image: click to place, drag to move, drag the
// corner to resize. Image stamps are remembered in localStorage (a
// per-machine convenience; the app works the same without it).

import { placeImage } from './annotate.js';
import { STAMP_PX_TO_PT } from './config.js';
import { toast } from './dialog.js';

const STORE_KEY = 'pdf-reader.stamps';
const MAX_SAVED = 6;
// Placed width of an image stamp, in points.
const IMAGE_STAMP_WIDTH_PT = 110;
const $ = (id) => document.getElementById(id);

const INK = { red: '#c8102e', blue: '#1d3fbb', green: '#1a7a33' };
const FONT = "'Leelawadee UI', Tahoma, sans-serif";

export function initStamps() {
    $('stamp-presets').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-stamp]');
        if (btn) useText(btn.dataset.stamp);
    });
    $('stamp-custom-use').addEventListener('click', () => {
        const text = $('stamp-custom').value.trim();
        if (text) useText(text);
        else toast('พิมพ์ข้อความของตราประทับก่อน', 'error');
    });
    $('stamp-color').addEventListener('change', showColor);
    $('stamp-image').addEventListener('change', useImageFile);
    $('stamp-saved').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-index]');
        if (!btn) return;
        const index = Number(btn.dataset.index);
        if (e.target.closest('.sig-remove')) {
            removeSaved(index);
            return;
        }
        const item = loadSaved()[index];
        if (item) finish(item.dataUrl, item.aspect, IMAGE_STAMP_WIDTH_PT);
    });
}

export function openStampDialog() {
    showColor();
    renderSaved();
    $('dlg-stamp').showModal();
}

function showColor() {
    $('stamp-presets').dataset.color = $('stamp-color').value;
}

// Date in Thai, Buddhist era: "28 ต.ค. 2569".
function thaiDate(d = new Date()) {
    return new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
}

// A rubber-stamp look: bold text in a double rounded frame, with an
// optional date line underneath.
export function renderTextStamp(text, color, date) {
    const ink = INK[color] || INK.red;
    const size = 72;
    const dateSize = 34;
    const padX = 40;
    const padY = 26;
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = `bold ${size}px ${FONT}`;
    const textW = ctx.measureText(text).width;
    ctx.font = `${dateSize}px ${FONT}`;
    const dateW = date ? ctx.measureText(date).width : 0;
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(Math.max(textW, dateW) + padX * 2);
    canvas.height = Math.ceil(padY * 2 + size * 1.25 + (date ? dateSize * 1.4 : 0));
    const c = canvas.getContext('2d');
    c.strokeStyle = ink;
    c.fillStyle = ink;
    const frame = (inset, width, radius) => {
        c.lineWidth = width;
        c.beginPath();
        c.roundRect(inset, inset, canvas.width - inset * 2, canvas.height - inset * 2, radius);
        c.stroke();
    };
    frame(5, 8, 22);
    frame(16, 3, 14);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = `bold ${size}px ${FONT}`;
    c.fillText(text, canvas.width / 2, padY + size * 0.66);
    if (date) {
        c.font = `${dateSize}px ${FONT}`;
        c.fillText(date, canvas.width / 2, padY + size * 1.25 + dateSize * 0.6);
    }
    return { dataUrl: canvas.toDataURL('image/png'), aspect: canvas.width / canvas.height, widthPt: canvas.width * STAMP_PX_TO_PT };
}

function useText(text) {
    const date = $('stamp-date').checked ? thaiDate() : '';
    const { dataUrl, aspect, widthPt } = renderTextStamp(text, $('stamp-color').value, date);
    finish(dataUrl, aspect, widthPt);
}

function useImageFile(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        const img = new Image();
        img.onload = () => {
            // PNG keeps transparency and is the one format save.js embeds.
            const c = document.createElement('canvas');
            c.width = img.naturalWidth;
            c.height = img.naturalHeight;
            c.getContext('2d').drawImage(img, 0, 0);
            const item = { dataUrl: c.toDataURL('image/png'), aspect: c.width / c.height };
            storeSaved([item, ...loadSaved().filter((s) => s.dataUrl !== item.dataUrl)].slice(0, MAX_SAVED));
            finish(item.dataUrl, item.aspect, IMAGE_STAMP_WIDTH_PT);
        };
        img.onerror = () => toast('เปิดรูปนี้ไม่ได้', 'error');
        img.src = reader.result;
    };
    reader.readAsDataURL(file);
}

function finish(dataUrl, aspect, widthPt) {
    $('dlg-stamp').close();
    placeImage(dataUrl, aspect, widthPt);
    toast('คลิกบนหน้าเพื่อวางตราประทับ');
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
        // Storage full or blocked: the stamp just won't be remembered.
    }
}

function removeSaved(index) {
    const list = loadSaved();
    list.splice(index, 1);
    storeSaved(list);
    renderSaved();
}

function renderSaved() {
    const list = loadSaved();
    const box = $('stamp-saved');
    box.replaceChildren();
    $('stamp-saved-empty').hidden = list.length > 0;
    list.forEach((item, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sig-saved-item';
        btn.dataset.index = i;
        btn.title = 'Use this stamp';
        const img = document.createElement('img');
        img.src = item.dataUrl;
        img.alt = 'ตราประทับที่บันทึกไว้';
        const rm = document.createElement('span');
        rm.className = 'sig-remove';
        rm.title = 'Remove';
        rm.textContent = '×';
        btn.append(img, rm);
        box.append(btn);
    });
}
