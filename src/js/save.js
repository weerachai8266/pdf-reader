// Turns the in-memory document (page list + annotations) into PDF bytes.
//
// The first source is edited in place so its forms, bookmarks and metadata
// survive; pages from merged files are copied in. pdf-lib is imported only
// when saving so it doesn't slow down startup.

import { state } from './docstate.js';
import { HIGHLIGHT_COLORS, HIGHLIGHT_OPACITY, NOTE_ICON_PX } from './config.js';

const NOTE_COLOR = [1, 0.82, 0.2];

export async function buildPdf() {
    const lib = await import('../../node_modules/pdf-lib/dist/pdf-lib.esm.min.js');
    const { PDFDocument } = lib;

    const docs = new Map();
    for (const src of state.sources.values()) {
        try {
            docs.set(src.id, await PDFDocument.load(src.bytes, { updateMetadata: false }));
        } catch (err) {
            if (err instanceof lib.EncryptedPDFError) {
                throw new Error(`ไฟล์ "${src.name}" ถูกเข้ารหัส ยังบันทึกการแก้ไขไม่ได้`);
            }
            throw err;
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

    base.setModificationDate(new Date());
    return base.save({ useObjectStreams: true });
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
