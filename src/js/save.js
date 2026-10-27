// Turns the in-memory document (page list + annotations) into PDF bytes.
//
// The first source is edited in place so its forms, bookmarks and metadata
// survive; pages from merged files are copied in. pdf-lib is imported only
// when saving so it doesn't slow down startup.

import { state } from './docstate.js';
import { HIGHLIGHT_COLORS, HIGHLIGHT_OPACITY, NOTE_ICON_PX } from './config.js';
import { optimize } from './qpdf.js';

export const ENCRYPTED_HINT = 'ไฟล์นี้มีรหัสผ่าน ให้ใช้ Document → Remove Security ก่อน';

const NOTE_COLOR = [1, 0.82, 0.2];
// Characters outside Latin-1 can't be drawn with the standard PDF fonts
// pdf.js uses for field appearances (Thai comes out as garbage).
const NON_LATIN1 = /[^\u0000-\u00ff]/;

// Bytes of a source with any filled-in form values written by pdf.js.
export async function sourceBytes(src) {
    return src.pdf.annotationStorage.size > 0 ? src.pdf.saveDocument() : src.bytes;
}

function hasNonLatinFormValues(src) {
    const { map } = src.pdf.annotationStorage.serializable;
    if (!map) return false;
    for (const entry of map.values()) {
        const values = [].concat(entry?.value ?? []);
        if (values.some((v) => typeof v === 'string' && NON_LATIN1.test(v))) return true;
    }
    return false;
}

// True when the only possible change is form filling: one file, pages in
// their original order and rotation, and none of our own annotations.
function onlyFormChanges() {
    if (state.sources.size !== 1) return false;
    const [src] = state.sources.values();
    if (state.pages.length !== src.pdf.numPages) return false;
    const pagesUntouched = state.pages.every((p, i) => p.index === i && p.rotation === 0);
    const noAnnots = [...state.annots.values()].every((list) => list.length === 0);
    return pagesUntouched && noAnnots;
}

// True when Save would rewrite the whole file (anything beyond filling
// Latin form values), which breaks existing digital signatures.
export function willRewriteFile() {
    const [firstSrc] = state.sources.values();
    return !(onlyFormChanges() && firstSrc && !hasNonLatinFormValues(firstSrc));
}

// Returns { data, warnings }.
export async function buildPdf() {
    const formOnly = onlyFormChanges();
    const [firstSrc] = state.sources.values();

    // Fast path: pdf.js writes an incremental update, keeping the file exactly
    // as it was apart from the field values (also works for encrypted files).
    // Thai values need appearances drawn with a Thai font, which only the
    // pdf-lib path below can do.
    if (formOnly && !hasNonLatinFormValues(firstSrc)) {
        return { data: await sourceBytes(firstSrc), warnings: [] };
    }

    const lib = await loadPdfLib();
    const { PDFDocument } = lib;

    const docs = new Map();
    for (const src of state.sources.values()) {
        try {
            docs.set(src.id, await PDFDocument.load(await sourceBytes(src), { updateMetadata: false }));
        } catch (err) {
            if (!(err instanceof lib.EncryptedPDFError)) throw err;
            if (formOnly) {
                return {
                    data: await sourceBytes(firstSrc),
                    warnings: ['ไฟล์มีรหัสผ่าน: บันทึกค่าในฟอร์มแล้ว แต่ข้อความภาษาไทยในช่องอาจแสดงไม่ถูกต้องในโปรแกรมอื่น'],
                };
            }
            throw new Error(`"${src.name}": ${ENCRYPTED_HINT} (ตอนนี้บันทึกได้เฉพาะการกรอกฟอร์ม)`);
        }
    }

    const [baseId] = state.sources.keys();
    const base = docs.get(baseId);
    const basePages = base.getPages();

    // Copy foreign pages in one call per source.
    const foreign = new Map(); // "srcId:index" -> PDFPage
    for (const [srcId, doc] of docs) {
        if (srcId === baseId) continue;
        const indices = state.pages.filter((p) => p.srcId === srcId).map((p) => p.index);
        if (!indices.length) continue;
        const copied = await base.copyPages(doc, indices);
        indices.forEach((idx, n) => foreign.set(`${srcId}:${idx}`, copied[n]));
    }

    for (let i = base.getPageCount() - 1; i >= 0; i--) base.removePage(i);

    const imageCache = new Map();
    for (const entry of state.pages) {
        const page = entry.srcId === baseId ? basePages[entry.index] : foreign.get(`${entry.srcId}:${entry.index}`);
        base.addPage(page);
        if (entry.rotation) {
            page.setRotation(lib.degrees((page.getRotation().angle + entry.rotation) % 360));
        }
        for (const annot of state.annots.get(entry.key) || []) {
            if (annot.type === 'highlight') drawHighlight(lib, page, annot);
            else if (annot.type === 'note') addNote(lib, base, page, annot);
            else if (annot.type === 'image') await drawImage(lib, base, page, annot, imageCache);
        }
    }

    const warnings = await fixNonLatinAppearances(lib, base);
    base.setModificationDate(new Date());
    // Appearances are handled above; pdf-lib's own pass would use Helvetica.
    const saved = await base.save({ useObjectStreams: true, updateFieldAppearances: false });
    // pdf-lib keeps every object it parsed, including those of deleted pages;
    // qpdf writes only what is still referenced.
    let data = saved;
    try {
        data = await optimize(saved);
    } catch (err) {
        console.warn('optimize after save failed, keeping pdf-lib output', err);
    }
    return { data, warnings };
}

// The current document (merged pages, annotations, form values) as an
// unencrypted pdf-lib document, for tools that produce new files.
export async function buildEditable() {
    const { data, warnings } = await buildPdf();
    const lib = await loadPdfLib();
    try {
        return { lib, doc: await lib.PDFDocument.load(data, { updateMetadata: false }), warnings };
    } catch (err) {
        if (err instanceof lib.EncryptedPDFError) throw new Error(ENCRYPTED_HINT);
        throw err;
    }
}

// A source as a pdf-lib document, for tools that edit it in place.
export async function loadSourceDoc(src) {
    const lib = await loadPdfLib();
    try {
        return { lib, doc: await lib.PDFDocument.load(await sourceBytes(src), { updateMetadata: false }) };
    } catch (err) {
        if (err instanceof lib.EncryptedPDFError) throw new Error(ENCRYPTED_HINT);
        throw err;
    }
}

// ---- Thai form field appearances ---------------------------------------

function fieldText(lib, field) {
    if (field instanceof lib.PDFTextField) return field.getText() || '';
    if (field instanceof lib.PDFDropdown || field instanceof lib.PDFOptionList) return field.getSelected().join('');
    return '';
}

// Redraw fields whose value needs a Thai font, embedding a subset of
// Windows' Tahoma (see main.js for why Tahoma).
async function fixNonLatinAppearances(lib, doc) {
    let fields;
    try {
        fields = doc.getForm().getFields();
    } catch {
        return [];
    }
    const targets = fields.filter((f) => {
        try {
            return NON_LATIN1.test(fieldText(lib, f));
        } catch {
            return false;
        }
    });
    if (!targets.length) return [];

    const font = await embedThaiFont(doc);
    if (!font) return ['ไม่พบฟอนต์ภาษาไทยในเครื่อง ข้อความไทยในฟอร์มอาจแสดงไม่ถูกต้องในโปรแกรมอื่น'];

    const failed = [];
    for (const field of targets) {
        try {
            field.updateAppearances(font);
        } catch (err) {
            console.warn('appearance update failed', field.getName(), err);
            failed.push(field.getName());
        }
    }
    return failed.length ? [`สร้างหน้าตาช่อง ${failed.join(', ')} ไม่สำเร็จ`] : [];
}

// Subset of Windows' Tahoma embedded in doc, or null if the font is missing.
export async function embedThaiFont(doc) {
    const fontBytes = await window.host.thaiFont();
    if (!fontBytes) return null;
    await loadFontkit();
    doc.registerFontkit(self.fontkit);
    return doc.embedFont(fontBytes, { subset: true });
}

export function loadPdfLib() {
    return import('../../node_modules/pdf-lib/dist/pdf-lib.esm.min.js');
}

let fontkitPromise = null;
function loadFontkit() {
    fontkitPromise ??= new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = new URL('../../node_modules/@pdf-lib/fontkit/dist/fontkit.umd.min.js', import.meta.url).href;
        script.onload = resolve;
        script.onerror = () => reject(new Error('โหลด fontkit ไม่สำเร็จ'));
        document.head.append(script);
    });
    return fontkitPromise;
}

function quadBox(quad) {
    const [x, y] = quad.bl;
    return {
        x,
        y,
        width: Math.hypot(quad.br[0] - x, quad.br[1] - y),
        height: Math.hypot(quad.tl[0] - x, quad.tl[1] - y),
        angle: (Math.atan2(quad.br[1] - y, quad.br[0] - x) * 180) / Math.PI,
    };
}

// Highlights are flattened into the page as multiply-blended rectangles,
// which every PDF viewer and printer renders identically.
function drawHighlight(lib, page, annot) {
    const [r, g, b] = HIGHLIGHT_COLORS[annot.color] || HIGHLIGHT_COLORS.yellow;
    for (const quad of annot.quads) {
        const box = quadBox(quad);
        page.drawRectangle({
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            rotate: lib.degrees(box.angle),
            color: lib.rgb(r, g, b),
            opacity: HIGHLIGHT_OPACITY,
            blendMode: lib.BlendMode.Multiply,
        });
    }
}

// Notes stay real /Text annotations so other readers show them as comments.
function addNote(lib, doc, page, annot) {
    const [x, y] = annot.at;
    const size = NOTE_ICON_PX * 0.75;
    const dict = doc.context.obj({
        Type: 'Annot',
        Subtype: 'Text',
        Rect: [x, y - size, x + size, y],
        Contents: lib.PDFHexString.fromText(annot.text),
        Name: 'Comment',
        C: NOTE_COLOR,
        F: 4,
        M: lib.PDFString.fromDate(new Date()),
    });
    page.node.addAnnot(doc.context.register(dict));
}

async function drawImage(lib, doc, page, annot, cache) {
    let image = cache.get(annot.dataUrl);
    if (!image) {
        image = await doc.embedPng(annot.dataUrl);
        cache.set(annot.dataUrl, image);
    }
    const box = quadBox(annot.quad);
    page.drawImage(image, {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        rotate: lib.degrees(box.angle),
    });
}
