// Document > Rotate Pages: rotate all, the current, or a range of pages at
// once, optionally only odd or even pages. Like the thumbnail buttons it only
// edits the page list; Save applies the rotation.

import { once } from './bus.js';
import { state, rotatePages } from './docstate.js';
import { parseRanges } from './extract.js';
import { currentPageIndex, scrollToIndex } from './viewer.js';
import { showFormDialog, toast } from './dialog.js';

const $ = (id) => document.getElementById(id);

// 0-based indices to rotate, or a Thai error message.
function selectedPages(total, current) {
    const scope = document.querySelector('input[name="rotate-scope"]:checked').value;
    let indices;
    if (scope === 'all') indices = [...Array(total).keys()];
    else if (scope === 'current') indices = [current];
    else {
        indices = parseRanges($('rotate-range').value, total);
        if (!indices) return `ช่วงหน้าไม่ถูกต้อง ตัวอย่าง: 1-3, 5, 8- (มีทั้งหมด ${total} หน้า)`;
    }
    const parity = $('rotate-parity').value;
    // Page numbers are 1-based: odd pages are even indices.
    if (parity !== 'all') indices = indices.filter((i) => (i % 2 === 0) === (parity === 'odd'));
    return indices.length ? indices : 'ไม่มีหน้าที่ตรงกับเงื่อนไขที่เลือก';
}

export async function rotatePagesDialog() {
    const total = state.pages.length;
    const current = currentPageIndex();
    $('rotate-total').textContent = String(total);
    $('rotate-current').textContent = String(current + 1);
    // Typing a range picks the range option.
    $('rotate-range').oninput = () => {
        document.querySelector('input[name="rotate-scope"][value="range"]').checked = true;
    };
    const ok = await showFormDialog('dlg-rotate', () => {
        const result = selectedPages(total, current);
        return typeof result === 'string' ? result : null;
    });
    if (!ok) return;
    const indices = selectedPages(total, current);
    once('layout-changed', () => scrollToIndex(current));
    rotatePages(indices, Number($('rotate-direction').value));
    toast(`หมุนแล้ว ${indices.length} หน้า`);
}
