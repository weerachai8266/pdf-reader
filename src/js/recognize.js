// Tools > Recognize Text: options dialog → OCR → invisible text layer →
// reload the affected sources so search and selection work immediately.

import { state, replaceSource } from './docstate.js';
import { currentPageIndex } from './viewer.js';
import { loadPdf } from './pdfjs.js';
import { recognize, pageHasText } from './ocr.js';
import { addTextLayer } from './ocrlayer.js';
import { showFormDialog, progressDialog, toast } from './dialog.js';

const $ = (id) => document.getElementById(id);

export async function recognizeText() {
    if (!(await showFormDialog('dlg-ocr'))) return;
    const scope = document.querySelector('input[name="ocr-scope"]:checked').value;
    const skipText = $('ocr-skip-text').checked;

    let entries = scope === 'current' ? [state.pages[currentPageIndex()]] : [...state.pages];
    const progress = progressDialog('Recognize Text (OCR)');
    try {
        if (skipText) {
            progress.update('กำลังตรวจว่าหน้าไหนเป็นภาพสแกน…', null);
            const scanned = [];
            for (const entry of entries) {
                if (progress.cancelled) break;
                if (!(await pageHasText(entry))) scanned.push(entry);
            }
            entries = scanned;
        }
        if (progress.cancelled) return toast('ยกเลิก OCR แล้ว');
        if (!entries.length) return toast('ทุกหน้าที่เลือกมีข้อความอยู่แล้ว ไม่ต้องทำ OCR');

        progress.update('กำลังโหลดตัวอ่านภาษาไทย/อังกฤษ…', null);
        const words = await recognize(entries, {
            onProgress: (done, total) => progress.update(`กำลังอ่านข้อความ หน้า ${done} จาก ${total}`, total ? done / total : null),
            isCancelled: () => progress.cancelled,
        });
        if (progress.cancelled) return toast('ยกเลิก OCR แล้ว เอกสารไม่ถูกเปลี่ยน');

        progress.update('กำลังฝังข้อความลงในเอกสาร…', null);
        const bySource = new Map(); // srcId -> Map(page index -> words)
        for (const entry of entries) {
            if (!bySource.has(entry.srcId)) bySource.set(entry.srcId, new Map());
            bySource.get(entry.srcId).set(entry.index, words.get(entry.key) || []);
        }
        for (const [srcId, wordsByIndex] of bySource) {
            const bytes = await addTextLayer(state.sources.get(srcId), wordsByIndex);
            const pdf = await loadPdf(bytes, async () => null);
            replaceSource(srcId, { bytes, pdf });
        }
        const found = [...words.values()].reduce((n, list) => n + list.length, 0);
        toast(found ? `OCR เสร็จแล้ว ${entries.length} หน้า (${found} คำ) ค้นหาและคัดลอกข้อความได้แล้ว` : 'OCR เสร็จแล้ว แต่ไม่พบข้อความในหน้าที่เลือก');
    } catch (err) {
        console.error(err);
        toast(`OCR ไม่สำเร็จ: ${err?.message || err}`, 'error');
    } finally {
        progress.close();
    }
}
