// Document > Flatten Form & Comments: form fields and comments become part
// of the page, as they look now, and can no longer be edited (by anyone,
// in any program). Each annotation's appearance stream is drawn into the
// page content, then the annotation and the form are removed. Links stay;
// comments without an appearance (some sticky notes) stay as comments.
//
// The flattened file replaces the open document (unsaved until Save).

import { state } from './docstate.js';
import { buildEditable } from './save.js';
import { optimize } from './qpdf.js';
import { pendingRedactions } from './redact.js';
import { hasSignatures } from './signatures.js';
import { confirmDialog, progressDialog, toast } from './dialog.js';

// Annotation flags (PDF 32000 12.5.3).
const HIDDEN = 2;
const NO_VIEW = 32;

// reopen(file): opens the flattened bytes in place of the current document.
export async function flattenDocument(reopen) {
    if (pendingRedactions().marks) {
        toast('มีกรอบ Redact ที่ยังไม่ได้ Apply ให้กด Apply Redactions ก่อน', 'error');
        return;
    }
    const go = await confirmDialog({
        title: 'Flatten Form & Comments',
        message: 'ช่องฟอร์ม ไฮไลต์ ตราประทับ และคอมเมนต์ทั้งหมดจะถูกฝังลงในเนื้อหน้าตามที่เห็นตอนนี้ และจะแก้ไขหรือลบไม่ได้อีก'
            + (hasSignatures() ? ' ลายเซ็นดิจิทัลในไฟล์จะใช้ไม่ได้ด้วย' : ''),
        okLabel: 'Flatten',
    });
    if (!go) return;

    const progress = progressDialog('Flatten');
    try {
        progress.update('กำลังเตรียมเอกสาร…', null);
        const { lib, doc } = await buildEditable();
        let count = 0;
        const pages = doc.getPages();
        pages.forEach((page, i) => {
            progress.update(`กำลังฝังลงในหน้า ${i + 1} จาก ${pages.length}`, i / pages.length);
            count += flattenPage(lib, doc, page);
        });
        doc.catalog.delete(lib.PDFName.of('AcroForm'));
        progress.update('กำลังเขียนไฟล์ใหม่…', null);
        const data = await optimize(await doc.save({ useObjectStreams: true, updateFieldAppearances: false }));
        progress.close();
        await reopen({ path: state.filePath, name: state.fileName, data });
        toast(count ? `ฝังแล้ว ${count} รายการ กด Save เพื่อบันทึก` : 'ไม่มีฟอร์มหรือคอมเมนต์ให้ฝัง');
    } catch (err) {
        console.error(err);
        toast(`Flatten ไม่สำเร็จ: ${err?.message || err}`, 'error');
    } finally {
        progress.close();
    }
}

// Draws and removes the page's annotations; returns how many were drawn.
export function flattenPage(lib, doc, page) {
    const { PDFName, PDFArray, PDFDict, PDFRef, PDFNumber } = lib;
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) return 0;
    const keep = [];
    const removed = new Set();
    let drawn = 0;
    let isolated = false;
    for (let i = 0; i < annots.size(); i++) {
        const ref = annots.get(i);
        const annot = annots.lookup(i);
        if (!(annot instanceof PDFDict)) continue;
        const subtype = annot.lookupMaybe(PDFName.of('Subtype'), PDFName);
        if (subtype === PDFName.of('Link') || subtype === PDFName.of('Popup')) {
            keep.push(ref);
            continue;
        }
        const appearance = normalAppearance(lib, doc, annot);
        const flags = annot.lookupMaybe(PDFName.of('F'), PDFNumber)?.asNumber() || 0;
        const visible = !(flags & HIDDEN) && !(flags & NO_VIEW);
        // Form widgets always go (the form itself is removed); other
        // comments only once their look is in the page.
        if (!appearance && subtype !== PDFName.of('Widget')) {
            keep.push(ref);
            continue;
        }
        if (appearance && visible) {
            if (!isolated) isolateContent(lib, doc, page);
            isolated = true;
            if (drawAppearance(lib, doc, page, annot, appearance)) drawn++;
        }
        if (ref instanceof PDFRef) removed.add(ref.toString());
    }
    // A popup belongs to its parent comment; drop it with the parent.
    const kept = keep.filter((ref) => {
        const parent = doc.context.lookup(ref)?.get?.(PDFName.of('Parent'));
        return !(parent instanceof PDFRef && removed.has(parent.toString()));
    });
    if (kept.length) page.node.set(PDFName.of('Annots'), doc.context.obj(kept));
    else page.node.delete(PDFName.of('Annots'));
    return drawn;
}

// Wraps the existing page content in q ... Q so whatever graphics state it
// leaves behind (a stray cm, clip or colour) can't shift what is drawn after.
function isolateContent(lib, doc, page) {
    page.node.normalize();
    const contents = page.node.Contents();
    if (!(contents instanceof lib.PDFArray)) return;
    const stream = (op) => doc.context.register(doc.context.contentStream([op]));
    contents.insert(0, stream(lib.pushGraphicsState()));
    contents.push(stream(lib.popGraphicsState()));
}

// The annotation's normal appearance stream (for its current state, for
// check boxes and radio buttons), as a reference, or null.
function normalAppearance(lib, doc, annot) {
    const { PDFName, PDFDict, PDFRef, PDFStream } = lib;
    const ap = annot.lookupMaybe(PDFName.of('AP'), PDFDict);
    if (!ap) return null;
    let entry = ap.get(PDFName.of('N'));
    let obj = entry instanceof PDFRef ? doc.context.lookup(entry) : entry;
    if (obj instanceof PDFDict) {
        const state = annot.lookupMaybe(PDFName.of('AS'), PDFName);
        entry = state ? obj.get(state) : null;
        obj = entry instanceof PDFRef ? doc.context.lookup(entry) : entry;
    }
    if (!(obj instanceof PDFStream)) return null;
    return entry instanceof PDFRef ? entry : doc.context.register(obj);
}

// Paints the appearance (a form XObject) so that its bounding box, after
// its own Matrix, fills the annotation's Rect (PDF 32000 12.5.5).
function drawAppearance(lib, doc, page, annot, ref) {
    const { PDFName, PDFArray, PDFNumber } = lib;
    const nums = (arr) => (arr instanceof PDFArray ? arr.asArray().map((n) => (n instanceof PDFNumber ? n.asNumber() : 0)) : null);
    const rect = nums(annot.lookupMaybe(PDFName.of('Rect'), PDFArray));
    const stream = doc.context.lookup(ref);
    const bbox = nums(stream.dict.lookupMaybe(PDFName.of('BBox'), PDFArray));
    if (!rect || rect.length !== 4 || !bbox || bbox.length !== 4) return false;
    const m = nums(stream.dict.lookupMaybe(PDFName.of('Matrix'), PDFArray)) || [1, 0, 0, 1, 0, 0];
    const corners = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[3]]]
        .map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
    const bx1 = Math.min(...corners.map((c) => c[0]));
    const bx2 = Math.max(...corners.map((c) => c[0]));
    const by1 = Math.min(...corners.map((c) => c[1]));
    const by2 = Math.max(...corners.map((c) => c[1]));
    const [rx1, rx2] = [Math.min(rect[0], rect[2]), Math.max(rect[0], rect[2])];
    const [ry1, ry2] = [Math.min(rect[1], rect[3]), Math.max(rect[1], rect[3])];
    if (bx2 - bx1 <= 0 || by2 - by1 <= 0 || rx2 - rx1 <= 0 || ry2 - ry1 <= 0) return false;
    const sx = (rx2 - rx1) / (bx2 - bx1);
    const sy = (ry2 - ry1) / (by2 - by1);

    stream.dict.set(PDFName.of('Type'), PDFName.of('XObject'));
    stream.dict.set(PDFName.of('Subtype'), PDFName.of('Form'));
    const name = page.node.newXObject('Flat', ref);
    page.pushOperators(
        lib.pushGraphicsState(),
        lib.concatTransformationMatrix(sx, 0, 0, sy, rx1 - bx1 * sx, ry1 - by1 * sy),
        lib.drawObject(name),
        lib.popGraphicsState(),
    );
    return true;
}
