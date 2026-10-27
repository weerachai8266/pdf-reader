// Writes OCR results into a source PDF as an invisible text layer (text
// render mode 3), the same technique Acrobat uses for searchable scans:
// the page still looks exactly like the scan, but text can be searched,
// selected and copied. Each word is stretched to its scanned box.

import { sourceBytes, embedThaiFont, loadPdfLib } from './save.js';

// Fraction of the word box height used as font size, and where the
// baseline sits above the box bottom (room for Thai below-base vowels).
const SIZE_RATIO = 0.8;
const BASELINE_RATIO = 0.2;

// wordsByIndex: Map(source page index -> words from ocr.js)
export async function addTextLayer(src, wordsByIndex) {
    const lib = await loadPdfLib();
    let doc;
    try {
        doc = await lib.PDFDocument.load(await sourceBytes(src), { updateMetadata: false });
    } catch (err) {
        if (err instanceof lib.EncryptedPDFError) throw new Error('ไฟล์มีรหัสผ่าน ยังทำ OCR ไม่ได้');
        throw err;
    }
    const font = await embedThaiFont(doc);
    if (!font) throw new Error('ไม่พบฟอนต์ Tahoma ในเครื่อง');

    const pages = doc.getPages();
    for (const [index, words] of wordsByIndex) {
        if (!words.length) continue;
        const page = pages[index];
        const fontKey = page.node.newFontDictionary(font.name, font.ref);
        const ops = [lib.pushGraphicsState(), lib.beginText(), lib.setTextRenderingMode(lib.TextRenderingMode.Invisible)];
        for (const word of words) {
            const op = wordOperators(lib, font, fontKey, word);
            if (op) ops.push(...op);
        }
        ops.push(lib.endText(), lib.popGraphicsState());
        page.pushOperators(...ops);
    }
    doc.setModificationDate(new Date());
    return doc.save({ useObjectStreams: true, updateFieldAppearances: false });
}

function wordOperators(lib, font, fontKey, { text, bl, br, tl }) {
    const w = Math.hypot(br[0] - bl[0], br[1] - bl[1]);
    const h = Math.hypot(tl[0] - bl[0], tl[1] - bl[1]);
    if (w < 1 || h < 1) return null;
    let encoded;
    let natural;
    try {
        encoded = font.encodeText(text);
        natural = font.widthOfTextAtSize(text, 1);
    } catch {
        return null; // character missing from the font
    }
    if (natural <= 0) return null;
    const size = h * SIZE_RATIO;
    const cos = (br[0] - bl[0]) / w;
    const sin = (br[1] - bl[1]) / w;
    // Baseline origin: up from the box bottom along the page's "up" vector.
    const ux = (tl[0] - bl[0]) / h;
    const uy = (tl[1] - bl[1]) / h;
    const x = bl[0] + ux * h * BASELINE_RATIO;
    const y = bl[1] + uy * h * BASELINE_RATIO;
    return [
        lib.setFontAndSize(fontKey, size),
        lib.setCharacterSqueeze((100 * w) / (natural * size)),
        lib.setTextMatrix(cos, sin, -sin, cos, x, y),
        lib.showText(encoded),
    ];
}
