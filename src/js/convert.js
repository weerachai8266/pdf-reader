// File > Create PDF / Export To.
//
// Office files (and TIFF) are converted to PDF by LibreOffice in the main
// process; images Chromium can decode become PDF pages here with pdf-lib.
// Export to Word rebuilds the text here and lets LibreOffice write the
// .docx; export to images and plain text is done here with pdf.js.

import { state } from './docstate.js';
import { loadPdf } from './pdfjs.js';
import { buildPdf, loadPdfLib } from './save.js';
import { isEncrypted } from './qpdf.js';
import { parseRanges, siblingPath } from './extract.js';
import { cleanCopiedText } from './thai.js';
import { pdfToHtml } from './pdf2html.js';
import { repairActualTextFonts } from './tounicode.js';
import { showFormDialog, progressDialog, toast } from './dialog.js';

const $ = (id) => document.getElementById(id);

export const CONVERTIBLE = /\.(pdf|docx?|docm|dotx?|odt|ott|rtf|txt|xlsx?|xlsm|ods|csv|pptx?|ppsx?|odp|odg|vsdx?|html?|tiff?|jpe?g|png|gif|bmp|webp)$/i;

// A4 in points; images are fitted onto a portrait or landscape A4 page.
const A4 = [595.28, 841.89];

// ---- create -------------------------------------------------------------

// Converts files (paths) into PDFs. Returns [{ name, data }] in the same
// order; consecutive images become pages of one PDF. Files that fail are
// reported and skipped.
export async function filesToPdfs(paths, progress) {
    const out = [];
    const failed = [];
    let images = [];
    const flushImages = async () => {
        if (!images.length) return;
        out.push({ name: images[0].name.replace(/\.[^.]+$/, '.pdf'), data: await imagesToPdf(images) });
        images = [];
    };
    for (const [n, filePath] of paths.entries()) {
        if (progress.cancelled) return null;
        const label = filePath.split(/[\\/]/).pop();
        const slow = !/\.(pdf|jpe?g|png|gif|bmp|webp)$/i.test(filePath);
        progress.update(`${slow ? 'กำลังแปลง' : 'กำลังเปิด'} ${label} (${n + 1}/${paths.length})${slow && n === 0 ? ' — ครั้งแรกอาจใช้เวลาสักครู่' : ''}`, n / paths.length);
        const file = await window.host.convertPrepare(filePath);
        if (file.error) {
            failed.push(`${file.name}: ${file.error}`);
            continue;
        }
        if (file.kind === 'image') {
            images.push(file);
            continue;
        }
        await flushImages();
        out.push({ name: file.name.replace(/\.[^.]+$/, '.pdf'), data: file.converted ? await repairText(file.data) : file.data });
    }
    await flushImages();
    if (failed.length) toast(`แปลงไม่ได้ ${failed.length} ไฟล์ — ${failed.join(' / ')}`, 'error');
    return out;
}

// LibreOffice's Thai text only reads back correctly through ActualText,
// which most readers ignore: rewrite the fonts' ToUnicode maps.
async function repairText(data) {
    try {
        const lib = await loadPdfLib();
        const doc = await lib.PDFDocument.load(data, { updateMetadata: false });
        if (!repairActualTextFonts(lib, doc)) return data;
        return await doc.save({ useObjectStreams: true, updateFieldAppearances: false });
    } catch (err) {
        console.warn('ToUnicode repair failed, keeping the converted file as is', err);
        return data;
    }
}

async function imagesToPdf(images) {
    const lib = await loadPdfLib();
    const doc = await lib.PDFDocument.create();
    for (const file of images) {
        const { image, width, height } = await embedImage(lib, doc, file);
        const landscape = width > height;
        const [pw, ph] = landscape ? [A4[1], A4[0]] : A4;
        const scale = Math.min(pw / width, ph / height);
        const w = width * scale;
        const h = height * scale;
        doc.addPage([pw, ph]).drawImage(image, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
    }
    return doc.save({ useObjectStreams: true });
}

// JPEG/PNG are embedded as they are (no quality loss) unless a JPEG has
// an EXIF rotation; everything else is re-encoded through a canvas.
async function embedImage(lib, doc, file) {
    const ext = file.ext;
    if ((ext === 'jpg' || ext === 'jpeg') && exifOrientation(file.data) <= 1) {
        const image = await doc.embedJpg(file.data);
        return { image, width: image.width, height: image.height };
    }
    if (ext === 'png') {
        const image = await doc.embedPng(file.data);
        return { image, width: image.width, height: image.height };
    }
    const bitmap = await createImageBitmap(new Blob([file.data]), { imageOrientation: 'from-image' });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    const photo = ext === 'jpg' || ext === 'jpeg';
    if (photo) {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, bitmap.width, bitmap.height);
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await canvas.convertToBlob(photo ? { type: 'image/jpeg', quality: 0.92 } : { type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const image = photo ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    return { image, width: image.width, height: image.height };
}

// EXIF orientation tag (1 = upright) of a JPEG, 1 when absent.
function exifOrientation(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint16(0) !== 0xffd8) return 1;
    let off = 2;
    while (off + 4 < view.byteLength) {
        const marker = view.getUint16(off);
        const len = view.getUint16(off + 2);
        if (marker === 0xffe1 && view.getUint32(off + 4) === 0x45786966) {
            const tiff = off + 10;
            const little = view.getUint16(tiff) === 0x4949;
            const ifd = tiff + view.getUint32(tiff + 4, little);
            const count = view.getUint16(ifd, little);
            for (let i = 0; i < count; i++) {
                const entry = ifd + 2 + i * 12;
                if (entry + 10 > view.byteLength) break;
                if (view.getUint16(entry, little) === 0x0112) return view.getUint16(entry + 8, little);
            }
            return 1;
        }
        if ((marker & 0xff00) !== 0xff00) break;
        off += 2 + len;
    }
    return 1;
}

// ---- export ---------------------------------------------------------------

const stem = () => (state.fileName || 'document.pdf').replace(/\.pdf$/i, '');

// What Save would write, unencrypted (LibreOffice can't open protected files).
async function exportSource() {
    const { data } = await buildPdf();
    if (await isEncrypted(data)) throw new Error('ไฟล์นี้มีรหัสผ่าน ให้ใช้ Document → Remove Security ก่อน');
    return data;
}

// PDF -> Word: text and formatting rebuilt by pdf2html.js, then turned
// into .docx by LibreOffice.
export async function exportWord() {
    const progress = progressDialog('Export to Word');
    let pdf;
    try {
        pdf = await loadPdf(await exportSource(), async () => null, { fontExtraProperties: true });
        const html = await pdfToHtml(pdf, {
            title: stem(),
            onPage: (n, total) => progress.update(`กำลังอ่านข้อความหน้า ${n} จาก ${total}`, n / total),
            isCancelled: () => progress.cancelled,
        });
        if (!html) return toast('ยกเลิกแล้ว');
        if (!/<(p|h\d)[ >]/.test(html)) {
            progress.close();
            toast('ไม่พบข้อความในเอกสาร ถ้าเป็นไฟล์สแกนให้ทำ OCR ก่อน', 'error');
            return;
        }
        progress.update('กำลังสร้างไฟล์ Word… (ครั้งแรกอาจใช้เวลาสักครู่)', null);
        const res = await window.host.convertExport({ html, format: 'docx' });
        if (res.error) throw new Error(res.error);
        progress.close();
        const saved = await window.host.save({ data: res.data, filePath: null, suggestedName: siblingPath(`${stem()}.docx`) });
        if (saved) toast(`บันทึกเป็น Word แล้ว: ${saved.name}`);
    } catch (err) {
        console.error(err);
        toast(`แปลงเป็น Word ไม่สำเร็จ: ${err?.message || err}`, 'error');
    } finally {
        progress.close();
        pdf?.loadingTask.destroy();
    }
}

export async function exportImages() {
    const total = state.pages.length;
    $('img-export-range').value = total > 1 ? `1-${total}` : '1';
    const ok = await showFormDialog('dlg-export-image', () =>
        parseRanges($('img-export-range').value, total) ? null : `ช่วงหน้าไม่ถูกต้อง (มีทั้งหมด ${total} หน้า)`);
    if (!ok) return;
    const indices = parseRanges($('img-export-range').value, total);
    const format = $('img-export-format').value;
    const dpi = Number($('img-export-dpi').value);

    const progress = progressDialog('Export to Images');
    let pdf;
    try {
        pdf = await loadPdf(await exportSource(), async () => null);
        const files = [];
        const pad = String(total).length;
        for (const [n, idx] of indices.entries()) {
            if (progress.cancelled) return toast('ยกเลิกแล้ว');
            progress.update(`กำลังสร้างภาพหน้า ${idx + 1} (${n + 1}/${indices.length})`, n / indices.length);
            files.push({
                name: `${stem()}_page${String(idx + 1).padStart(pad, '0')}.${format === 'jpeg' ? 'jpg' : 'png'}`,
                data: await renderPage(pdf, idx, dpi, format),
            });
        }
        progress.close();
        const res = await window.host.saveMany({ files, title: 'เลือกโฟลเดอร์สำหรับเก็บรูปภาพ' });
        if (res) toast(`บันทึกรูปภาพ ${res.count} ไฟล์ไว้ที่ ${res.folder}`);
    } catch (err) {
        console.error(err);
        toast(`แปลงเป็นรูปภาพไม่สำเร็จ: ${err?.message || err}`, 'error');
    } finally {
        progress.close();
        pdf?.loadingTask.destroy();
    }
}

async function renderPage(pdf, index, dpi, format) {
    const page = await pdf.getPage(index + 1);
    const viewport = page.getViewport({ scale: dpi / 72 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, format === 'jpeg' ? 'image/jpeg' : 'image/png', 0.9));
    canvas.width = 0;
    return new Uint8Array(await blob.arrayBuffer());
}

// Plain text, one block per page, UTF-8 with BOM so Notepad shows Thai.
export async function exportText() {
    const progress = progressDialog('Export to Text');
    let pdf;
    try {
        pdf = await loadPdf(await exportSource(), async () => null);
        const pages = [];
        for (let i = 1; i <= pdf.numPages; i++) {
            if (progress.cancelled) return toast('ยกเลิกแล้ว');
            progress.update(`กำลังอ่านข้อความหน้า ${i} จาก ${pdf.numPages}`, i / pdf.numPages);
            const content = await (await pdf.getPage(i)).getTextContent();
            pages.push(content.items.map((it) => it.str + (it.hasEOL ? '\n' : '')).join(''));
        }
        const text = cleanCopiedText(pages.join('\n\n\f')).replace(/\r?\n/g, '\r\n');
        if (!text.trim()) {
            progress.close();
            toast('ไม่พบข้อความในเอกสาร ถ้าเป็นไฟล์สแกนให้ทำ OCR ก่อน', 'error');
            return;
        }
        const body = new TextEncoder().encode(text);
        const data = new Uint8Array(body.length + 3);
        data.set([0xef, 0xbb, 0xbf]);
        data.set(body, 3);
        progress.close();
        const saved = await window.host.save({ data, filePath: null, suggestedName: siblingPath(`${stem()}.txt`) });
        if (saved) toast(`บันทึกข้อความแล้ว: ${saved.name}`);
    } catch (err) {
        console.error(err);
        toast(`แปลงเป็นข้อความไม่สำเร็จ: ${err?.message || err}`, 'error');
    } finally {
        progress.close();
        pdf?.loadingTask.destroy();
    }
}
