// Document > Apply Redactions.
//
// Marked areas are removed for real, not just covered: each affected page
// is rendered to an image with the areas painted black, and that image
// replaces the page's content, resources, annotations and form fields.
// qpdf then rewrites the file so the old content objects are gone. The
// page object itself is kept, so bookmarks and links to it still work.
// Optionally OCR puts searchable text back (without the redacted words).

import { state, replaceSource, annotsFor, removeAnnot } from './docstate.js';
import { loadPdf, pdfjsLib } from './pdfjs.js';
import { loadSourceDoc } from './save.js';
import { optimize } from './qpdf.js';
import { ocrEntries } from './recognize.js';
import { showFormDialog, progressDialog, toast } from './dialog.js';

const $ = (id) => document.getElementById(id);
const RASTER_DPI = 300;
const JPEG_QUALITY = 0.88;

export function pendingRedactions() {
    let marks = 0;
    const entries = [];
    for (const entry of state.pages) {
        const n = annotsFor(entry.key).filter((a) => a.type === 'redact').length;
        if (n) {
            marks += n;
            entries.push(entry);
        }
    }
    return { marks, entries };
}

export async function applyRedactions() {
    const { marks, entries } = pendingRedactions();
    if (!marks) {
        toast('ยังไม่มีพื้นที่ที่ทำเครื่องหมายไว้ เลือกเครื่องมือ Redact แล้วลากคลุมส่วนที่ต้องการลบ');
        return false;
    }
    $('redact-summary').textContent = `จะลบเนื้อหาใต้กรอบ ${marks} จุด ใน ${entries.length} หน้าออกจากไฟล์อย่างถาวร`;
    if (!(await showFormDialog('dlg-redact'))) return false;
    const runOcr = $('redact-ocr').checked;

    const progress = progressDialog('Apply Redactions');
    try {
        const bySource = new Map();
        for (const entry of entries) {
            if (!bySource.has(entry.srcId)) bySource.set(entry.srcId, []);
            bySource.get(entry.srcId).push(entry);
        }
        let done = 0;
        for (const [srcId, list] of bySource) {
            const src = state.sources.get(srcId);
            const { lib, doc } = await loadSourceDoc(src);
            for (const entry of list) {
                progress.update(`กำลังลบเนื้อหา หน้า ${state.pages.indexOf(entry) + 1}`, done++ / entries.length);
                const quads = annotsFor(entry.key).filter((a) => a.type === 'redact').map((a) => a.quad);
                const image = await renderRedacted(src.pdf, entry.index, quads);
                rasterizePage(lib, doc, doc.getPages()[entry.index], image);
            }
            progress.update('กำลังเขียนไฟล์ใหม่…', null);
            const bytes = await optimize(await doc.save({ useObjectStreams: true, updateFieldAppearances: false }));
            replaceSource(srcId, { bytes, pdf: await loadPdf(bytes, async () => null) });
        }
        for (const entry of entries) {
            for (const a of annotsFor(entry.key).filter((x) => x.type === 'redact')) removeAnnot(entry.key, a.id);
        }

        if (runOcr) {
            const found = await ocrEntries(entries, progress);
            if (found === null) {
                toast('ลบเนื้อหาแล้ว (ยกเลิก OCR) กด Save เพื่อบันทึก');
                return true;
            }
        }
        toast(`ลบเนื้อหา ${marks} จุดแล้ว กด Save เพื่อบันทึก`);
        return true;
    } catch (err) {
        console.error(err);
        toast(`Redact ไม่สำเร็จ: ${err?.message || err}`, 'error');
        return false;
    } finally {
        progress.close();
    }
}

// The page as the source draws it (forms and comments included), unrotated,
// with every quad filled black. Returns { jpeg, width, height } in pixels.
async function renderRedacted(pdf, index, quads) {
    const page = await pdf.getPage(index + 1);
    const viewport = page.getViewport({ scale: RASTER_DPI / 72, rotation: 0 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({
        canvasContext: ctx,
        viewport,
        annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE,
        annotationStorage: pdf.annotationStorage,
    }).promise;

    ctx.fillStyle = '#000';
    for (const q of quads) {
        const tr = [q.br[0] + q.tl[0] - q.bl[0], q.br[1] + q.tl[1] - q.bl[1]];
        ctx.beginPath();
        for (const [i, pt] of [q.bl, q.br, tr, q.tl].entries()) {
            const [x, y] = viewport.convertToViewportPoint(...pt);
            if (i) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
        }
        ctx.closePath();
        ctx.fill();
    }
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    const size = { width: canvas.width, height: canvas.height };
    canvas.width = 0;
    return { jpeg: new Uint8Array(await blob.arrayBuffer()), ...size };
}

// Swaps the page's content for a single image filling its crop box.
function rasterizePage(lib, doc, page, image) {
    const { PDFName } = lib;
    removeFieldsOnPage(lib, doc, page);
    const { x, y, width, height } = page.getCropBox();
    const node = page.node;
    for (const key of ['Annots', 'Thumb', 'PieceInfo', 'Metadata', 'AA', 'B', 'StructParents', 'BleedBox', 'TrimBox', 'ArtBox']) {
        node.delete(PDFName.of(key));
    }
    node.set(PDFName.of('MediaBox'), doc.context.obj([x, y, x + width, y + height]));
    node.set(PDFName.of('CropBox'), doc.context.obj([x, y, x + width, y + height]));

    const imageStream = doc.context.stream(image.jpeg, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: image.width,
        Height: image.height,
        ColorSpace: 'DeviceRGB',
        BitsPerComponent: 8,
        Filter: 'DCTDecode',
    });
    const imageRef = doc.context.register(imageStream);
    // Own Resources (not inherited from the page tree) with only the image.
    node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { Im0: imageRef } }));
    const content = doc.context.contentStream([
        lib.pushGraphicsState(),
        lib.concatTransformationMatrix(width, 0, 0, height, x, y),
        lib.drawObject('Im0'),
        lib.popGraphicsState(),
    ]);
    node.set(PDFName.of('Contents'), doc.context.register(content));
}

// Form fields with a widget on this page would keep their values (and
// point at a page that no longer shows them), so they go too.
function removeFieldsOnPage(lib, doc, page) {
    let form;
    try {
        form = doc.getForm();
    } catch {
        return;
    }
    const annots = page.node.Annots();
    const onPage = new Set(annots ? annots.asArray().map((ref) => ref.toString()) : []);
    for (const field of form.getFields()) {
        const widgets = field.acroField.getWidgets();
        const here = widgets.some((w) => w.P() === page.ref || onPage.has(doc.context.getObjectRef(w.dict)?.toString()));
        if (!here) continue;
        try {
            form.removeField(field);
        } catch (err) {
            console.warn('could not remove field', field.getName(), err);
        }
    }
}
