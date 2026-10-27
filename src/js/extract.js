// Document > Extract Pages / Split Document. Both work on what Save would
// write (merged pages, rotation, highlights, signatures, form values) and
// produce new files; the open document only changes when the user asks to
// delete the extracted pages.

import { state, pagesChanged } from './docstate.js';
import { buildEditable } from './save.js';
import { showFormDialog, progressDialog, toast } from './dialog.js';

const $ = (id) => document.getElementById(id);

// "1-3, 5, 8-" -> sorted unique 0-based indices, or null when invalid.
export function parseRanges(text, total) {
    const out = new Set();
    for (const part of text.split(/[,\s]+/).filter(Boolean)) {
        const m = /^(\d*)(?:(-)(\d*))?$/.exec(part);
        if (!m || (!m[1] && !m[3])) return null;
        const from = m[1] ? Number(m[1]) : 1;
        const to = m[2] ? (m[3] ? Number(m[3]) : total) : from;
        if (from < 1 || to > total || from > to) return null;
        for (let n = from; n <= to; n++) out.add(n - 1);
    }
    return out.size ? [...out].sort((a, b) => a - b) : null;
}

function baseName() {
    return (state.fileName || 'document.pdf').replace(/\.pdf$/i, '');
}

// Default save location next to the open file.
export function siblingPath(name) {
    if (!state.filePath) return name;
    const sep = Math.max(state.filePath.lastIndexOf('\\'), state.filePath.lastIndexOf('/'));
    return state.filePath.slice(0, sep + 1) + name;
}

async function copyToNewDoc(lib, doc, indices) {
    const out = await lib.PDFDocument.create();
    const pages = await out.copyPages(doc, indices);
    pages.forEach((p) => out.addPage(p));
    return out.save({ useObjectStreams: true });
}

function rangeLabel(indices) {
    const parts = [];
    for (let i = 0; i < indices.length; i++) {
        let j = i;
        while (j + 1 < indices.length && indices[j + 1] === indices[j] + 1) j++;
        parts.push(i === j ? `${indices[i] + 1}` : `${indices[i] + 1}-${indices[j] + 1}`);
        i = j;
    }
    return parts.join(',');
}

export async function extractPages() {
    const total = state.pages.length;
    $('extract-total').textContent = String(total);
    const ok = await showFormDialog('dlg-extract', () =>
        parseRanges($('extract-range').value, total) ? null : `ช่วงหน้าไม่ถูกต้อง ตัวอย่าง: 1-3, 5 (มีทั้งหมด ${total} หน้า)`);
    if (!ok) return;
    const indices = parseRanges($('extract-range').value, total);
    const separate = $('extract-separate').checked;
    const remove = $('extract-delete').checked;
    if (remove && indices.length === total) {
        toast('ลบทุกหน้าออกจากเอกสารไม่ได้ ระบบจะดึงหน้าออกมาโดยไม่ลบ', 'error');
    }

    const progress = progressDialog('Extract Pages');
    let written = 0;
    try {
        const { lib, doc } = await buildEditable();
        if (separate) {
            const files = [];
            for (const idx of indices) {
                if (progress.cancelled) return;
                progress.update(`กำลังแยกหน้า ${idx + 1}`, files.length / indices.length);
                files.push({ name: `${baseName()}_page${idx + 1}.pdf`, data: await copyToNewDoc(lib, doc, [idx]) });
            }
            progress.close();
            const res = await window.host.saveMany({ files, title: 'เลือกโฟลเดอร์สำหรับเก็บไฟล์' });
            if (!res) return;
            written = res.count;
            toast(`บันทึก ${res.count} ไฟล์ไว้ที่ ${res.folder}`);
        } else {
            const data = await copyToNewDoc(lib, doc, indices);
            progress.close();
            const saved = await window.host.save({ data, filePath: null, suggestedName: siblingPath(`${baseName()}_pages_${rangeLabel(indices)}.pdf`) });
            if (!saved) return;
            written = 1;
            toast(`บันทึกแล้ว: ${saved.name}`);
        }
        if (written && remove && indices.length < total) {
            const drop = new Set(indices.map((i) => state.pages[i].key));
            for (const key of drop) state.annots.delete(key);
            state.pages = state.pages.filter((p) => !drop.has(p.key));
            pagesChanged();
        }
    } catch (err) {
        console.error(err);
        toast(`ดึงหน้าไม่สำเร็จ: ${err?.message || err}`, 'error');
    } finally {
        progress.close();
    }
}

export async function splitDocument() {
    const total = state.pages.length;
    $('split-total').textContent = String(total);
    const ok = await showFormDialog('dlg-split', () => {
        const mode = document.querySelector('input[name="split-mode"]:checked').value;
        if (mode === 'every') {
            const n = Number($('split-every').value);
            return Number.isInteger(n) && n >= 1 && n < total ? null : `จำนวนหน้าต่อไฟล์ต้องอยู่ระหว่าง 1 ถึง ${total - 1}`;
        }
        return parseRanges($('split-ranges').value.replaceAll(';', ','), total) ? null : 'ช่วงหน้าไม่ถูกต้อง';
    });
    if (!ok) return;

    const mode = document.querySelector('input[name="split-mode"]:checked').value;
    let groups;
    if (mode === 'every') {
        const n = Number($('split-every').value);
        groups = [];
        for (let i = 0; i < total; i += n) groups.push(Array.from({ length: Math.min(n, total - i) }, (_, k) => i + k));
    } else {
        // Each ';'-separated range becomes one file.
        groups = $('split-ranges').value.split(';').map((r) => parseRanges(r, total)).filter(Boolean);
    }

    const progress = progressDialog('Split Document');
    try {
        const { lib, doc } = await buildEditable();
        const files = [];
        const width = String(groups.length).length;
        for (const [n, indices] of groups.entries()) {
            if (progress.cancelled) return;
            progress.update(`กำลังสร้างไฟล์ ${n + 1} จาก ${groups.length}`, n / groups.length);
            files.push({ name: `${baseName()}_part${String(n + 1).padStart(Math.max(2, width), '0')}.pdf`, data: await copyToNewDoc(lib, doc, indices) });
        }
        progress.close();
        const res = await window.host.saveMany({ files, title: 'เลือกโฟลเดอร์สำหรับเก็บไฟล์ที่แยก' });
        if (res) toast(`แยกเป็น ${res.count} ไฟล์ ไว้ที่ ${res.folder}`);
    } catch (err) {
        console.error(err);
        toast(`แยกไฟล์ไม่สำเร็จ: ${err?.message || err}`, 'error');
    } finally {
        progress.close();
    }
}
