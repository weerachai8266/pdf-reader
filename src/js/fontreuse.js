// Writing new text with a font that is already in the PDF, so an edited
// line keeps its original typeface: the new text uses the page's own font
// resource instead of embedding another font.
//
// Text is turned back into the font's codes through its ToUnicode CMap
// (or, for simple fonts without one, its WinAnsi encoding). Embedded fonts
// are usually subsets, so only characters the document already used can
// be written; encode() returns null when a character is missing and the
// caller falls back to a system font.
//
// Thai: a subset often holds several glyphs for the same tone mark or
// vowel (normal, raised over an upper vowel, shifted left after ป ฝ ฟ).
// The font program's positioning tables are not in the PDF, so each mark
// gets the glyph the document itself used in the same context.

import { parseCMap } from './tounicode.js';

const UPPER_VOWELS = new Set(['ั', 'ิ', 'ี', 'ึ', 'ื', '็']);
const TALL = new Set(['ป', 'ฝ', 'ฟ', 'ฬ']);
// Advance (thousandths of an em) used for a space the subset has no glyph for.
const SPACE_GAP = 250;

// WinAnsiEncoding codes 0x80-0x9F; everything else in 0x20-0xFF is Latin-1.
const WIN_ANSI_HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';

// Context of a character for choosing between glyph variants.
function contextOf(prev) {
    if (!prev) return 'base';
    if (UPPER_VOWELS.has(prev)) return 'upper';
    if (TALL.has(prev)) return 'tall';
    return 'base';
}

function streamText(lib, stream) {
    const bytes = lib.decodePDFRawStream(stream).decode();
    let out = '';
    for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return out;
}

// code -> text for a font dict: ToUnicode, else WinAnsi for simple fonts.
function codeMap(lib, fontDict, info) {
    const { PDFName, PDFRawStream } = lib;
    const tu = fontDict.lookupMaybe(PDFName.of('ToUnicode'), PDFRawStream);
    if (tu) return parseCMap(streamText(lib, tu));
    if (info.codeLen !== 1) return null;
    const map = new Map();
    for (let c = 32; c < 256; c++) {
        if (c === 127 || [0x81, 0x8d, 0x8f, 0x90, 0x9d].includes(c)) continue;
        if (info.width(c) <= 0 && c !== 32) continue;
        map.set(c, c >= 128 && c < 160 ? WIN_ANSI_HIGH[c - 128] : String.fromCharCode(c));
    }
    return map;
}

// An encoder for one font of a page, or null when the font can't be reused.
// pageGlyphs: the page's interpreted glyphs, to learn which variant of a
// glyph the document uses where.
export function fontEncoder(lib, fontDict, info, pageGlyphs, fontName) {
    if (!info?.editable) return null;
    const map = codeMap(lib, fontDict, info);
    if (!map?.size) return null;

    // text -> code -> { ctx -> count }
    const seen = new Map();
    let prev = '';
    for (const g of pageGlyphs) {
        if (g.fontName !== fontName) continue;
        const text = map.get(g.code);
        if (!text) continue;
        if (!seen.has(text)) seen.set(text, new Map());
        const byCode = seen.get(text);
        if (!byCode.has(g.code)) byCode.set(g.code, new Map());
        const ctx = contextOf(prev);
        byCode.get(g.code).set(ctx, (byCode.get(g.code).get(ctx) || 0) + 1);
        prev = text[text.length - 1];
    }

    const reverse = new Map(); // text -> [codes]
    let longest = 1;
    for (const [code, text] of map) {
        if (!text || /^\u0000+$/.test(text)) continue;
        if (!reverse.has(text)) reverse.set(text, []);
        reverse.get(text).push(code);
        longest = Math.max(longest, text.length);
    }

    const pick = (text, ctx) => {
        const codes = reverse.get(text);
        const counts = seen.get(text);
        const score = (code) => {
            const c = counts?.get(code);
            if (!c) return 0;
            return (c.get(ctx) || 0) * 1000 + [...c.values()].reduce((a, b) => a + b, 0);
        };
        return [...codes].sort((a, b) => score(b) - score(a) || a - b)[0];
    };

    return {
        codeLen: info.codeLen,
        // TJ array items for `text`: code arrays and spacing numbers, or
        // null if some character has no glyph in this font.
        encode(text) {
            const out = [];
            let run = [];
            let before = '';
            for (let i = 0; i < text.length;) {
                let matched = null;
                for (let n = Math.min(longest, text.length - i); n >= 1; n--) {
                    if (reverse.has(text.slice(i, i + n))) {
                        matched = text.slice(i, i + n);
                        break;
                    }
                }
                if (!matched && text[i] === ' ') {
                    if (run.length) out.push(run);
                    run = [];
                    out.push(-SPACE_GAP);
                    before = ' ';
                    i++;
                    continue;
                }
                if (!matched) {
                    // Some fonts only have the parts (LibreOffice writes ำ
                    // as ํ + า): try the compatibility decomposition.
                    const parts = text[i].normalize('NFKD');
                    if (parts !== text[i] && [...parts].every((p) => reverse.has(p))) {
                        for (const p of parts) {
                            run.push(pick(p, contextOf(before)));
                            before = p;
                        }
                        i++;
                        continue;
                    }
                    return null;
                }
                run.push(pick(matched, contextOf(before)));
                before = matched[matched.length - 1];
                i += matched.length;
            }
            if (run.length) out.push(run);
            return out;
        },
    };
}

const hex = (codes, len) => `<${codes.map((c) => c.toString(16).padStart(len * 2, '0')).join('')}>`;
const num = (x) => (Math.abs(x) < 1e-6 ? '0' : String(Math.round(x * 1000) / 1000));

// Content-stream operators drawing encoded lines with the font resource
// `fontName`. origin is the first baseline start; angle in radians; lines
// step down by size * lineHeight.
export function textOperators({ fontName, codeLen, lines, origin, angle, size, hScale = 1, color, lineHeight = 1.25 }) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    let out = `q BT /${fontName} 1 Tf ${color.map(num).join(' ')} rg\n`;
    lines.forEach((items, i) => {
        if (!items.length) return;
        const x = origin[0] + sin * size * lineHeight * i;
        const y = origin[1] - cos * size * lineHeight * i;
        out += `${num(size * hScale * cos)} ${num(size * hScale * sin)} ${num(-size * sin)} ${num(size * cos)} ${num(x)} ${num(y)} Tm `;
        out += `[${items.map((it) => (typeof it === 'number' ? num(it) : hex(it, codeLen))).join(' ')}] TJ\n`;
    });
    return `${out}ET Q\n`;
}
