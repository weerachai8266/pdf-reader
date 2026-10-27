// Repairs text extraction in PDFs written by LibreOffice for Thai (and
// other scripts that stack marks).
//
// LibreOffice maps a whole glyph cluster ("รื่") onto the cluster's first
// glyph in the font's ToUnicode CMap, leaves the mark glyphs unmapped, and
// puts the real text in an /ActualText span around the cluster. Readers
// that ignore ActualText (pdf.js, so search, copy and export) then read the
// base glyph as the whole cluster everywhere it appears ("น" -> "นุ") and
// the marks as junk. We work out one character per glyph code by lining
// up each span's glyphs with its ActualText, and write a corrected CMap.
// Content streams are not touched, so the page looks exactly the same.

const SARA_AM = 'ำ';
const NIKHAHIT = 'ํ';
const SARA_AA = 'า';

// ---- content stream scanning -------------------------------------------------

// Hex/literal string bytes -> array of single-byte codes.
function stringCodes(token) {
    if (token.startsWith('<')) {
        const hex = token.slice(1, -1).replace(/\s+/g, '');
        const out = [];
        for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2).padEnd(2, '0'), 16));
        return out;
    }
    const out = [];
    const body = token.slice(1, -1);
    for (let i = 0; i < body.length; i++) {
        let c = body.charCodeAt(i);
        if (c === 92 && i + 1 < body.length) {
            const next = body[++i];
            if (/[0-7]/.test(next)) {
                let oct = next;
                while (oct.length < 3 && /[0-7]/.test(body[i + 1])) oct += body[++i];
                c = parseInt(oct, 8);
            } else {
                c = { n: 10, r: 13, t: 9, b: 8, f: 12 }[next] ?? next.charCodeAt(0);
            }
        }
        out.push(c & 0xff);
    }
    return out;
}

function hexToText(hex) {
    const clean = hex.replace(/\s+/g, '');
    let start = 0;
    if (clean.startsWith('FEFF') || clean.startsWith('feff')) start = 4;
    let s = '';
    for (let i = start; i + 4 <= clean.length; i += 4) s += String.fromCharCode(parseInt(clean.slice(i, i + 4), 16));
    return s;
}

const TOKEN = /<<|>>|<[0-9A-Fa-f\s]*>|\((?:\\.|[^\\)])*\)|\/[^\s/<>()[\]{}]+|\[|\]|[^\s/<>()[\]{}]+/g;

// Finds ActualText spans: [{ font, codes, text }] where font is the
// resource name in use when the span's glyphs were shown.
export function findActualTextSpans(content) {
    const spans = [];
    let font = null;
    let span = null;
    let depth = 0; // marked-content nesting inside the current span
    let operands = [];
    let pendingActual = null;
    for (const m of content.matchAll(TOKEN)) {
        const t = m[0];
        if (t === 'BDC' || t === 'BMC') {
            if (span) depth++;
            else if (pendingActual !== null && t === 'BDC') {
                span = { font, codes: [], text: pendingActual };
                depth = 0;
            }
            pendingActual = null;
            operands = [];
        } else if (t === 'EMC') {
            if (span && depth === 0) {
                spans.push(span);
                span = null;
            } else if (span) {
                depth--;
            }
            operands = [];
        } else if (t === 'Tf') {
            const name = operands.find((o) => o.startsWith('/'));
            if (name) font = name.slice(1);
            if (span && !span.codes.length) span.font = font;
            operands = [];
        } else if (t === 'Tj' || t === 'TJ' || t === "'" || t === '"') {
            if (span) {
                for (const o of operands) if (o.startsWith('<') || o.startsWith('(')) span.codes.push(...stringCodes(o));
            }
            operands = [];
        } else if (t === '/ActualText') {
            operands.push(t);
        } else if (/^[A-Za-z'"*]+$/.test(t) && t !== 'true' && t !== 'false' && t !== 'null') {
            operands = [];
        } else {
            if (operands[operands.length - 1] === '/ActualText' && t.startsWith('<') && !t.startsWith('<<')) {
                pendingActual = hexToText(t.slice(1, -1));
            } else if (operands[operands.length - 1] === '/ActualText' && t.startsWith('(')) {
                pendingActual = String.fromCharCode(...stringCodes(t));
            }
            operands.push(t);
        }
    }
    return spans;
}

// ---- CMap -------------------------------------------------------------------------

// bfchar / bfrange entries of a ToUnicode CMap -> Map(code -> string).
export function parseCMap(text) {
    const map = new Map();
    for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
        for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
            map.set(parseInt(m[1], 16), hexToText(m[2]));
        }
    }
    for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
        for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[[^\]]*\])/g)) {
            const lo = parseInt(m[1], 16);
            const hi = parseInt(m[2], 16);
            if (m[3].startsWith('[')) {
                [...m[3].matchAll(/<([0-9A-Fa-f]*)>/g)].forEach((d, i) => map.set(lo + i, hexToText(d[1])));
            } else {
                const base = hexToText(m[3].slice(1, -1));
                for (let c = lo; c <= hi && c - lo < 256; c++) {
                    map.set(c, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (c - lo)));
                }
            }
        }
    }
    return map;
}

export function writeCMap(map) {
    const hex4 = (s) => [...s].map((ch) => ch.codePointAt(0).toString(16).padStart(4, '0')).join('').toUpperCase();
    const entries = [...map.entries()].sort((a, b) => a[0] - b[0]);
    const chunks = [];
    for (let i = 0; i < entries.length; i += 100) {
        const part = entries.slice(i, i + 100);
        chunks.push(`${part.length} beginbfchar\n${part.map(([c, s]) => `<${c.toString(16).padStart(2, '0').toUpperCase()}> <${hex4(s)}>`).join('\n')}\nendbfchar`);
    }
    return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<00> <FF>
endcodespacerange
${chunks.join('\n')}
endcmap
CMapName currentdict /CIDFont defineresource pop
end
end
`;
}

// ---- solving ----------------------------------------------------------------------

// One character per glyph code, from the original (cluster) mapping and
// the ActualText spans. Returns a new Map, or null when nothing changed.
export function solveMapping(original, spans) {
    const known = new Map();
    const clusterCodes = new Set();
    for (const [code, str] of original) {
        const chars = [...str];
        if (chars.length === 1) known.set(code, str);
        else if (chars.length > 1) clusterCodes.add(code);
    }
    // The first glyph of a cluster is its first character (Thai base
    // consonant or leading vowel).
    for (const code of clusterCodes) {
        if (!known.has(code)) known.set(code, [...original.get(code)][0]);
    }
    const pending = spans
        .filter((s) => s.codes.length && s.text)
        .map((s) => ({ codes: [...s.codes], chars: [...s.text] }));

    // Repeatedly take out the glyphs we already know and match what is left.
    for (let round = 0; round < 6; round++) {
        let progress = false;
        for (const s of pending) {
            let codes = [...s.codes];
            let chars = [...s.chars];
            for (const code of [...codes]) {
                const ch = known.get(code);
                const at = ch === undefined ? -1 : chars.indexOf(ch);
                if (at >= 0) {
                    chars.splice(at, 1);
                    codes.splice(codes.indexOf(code), 1);
                }
            }
            // SARA AM is often drawn as NIKHAHIT + SARA AA.
            if (codes.length === chars.length + 1 && chars.includes(SARA_AM)) {
                chars.splice(chars.indexOf(SARA_AM), 1, NIKHAHIT, SARA_AA);
                for (const code of [...codes]) {
                    const at = chars.indexOf(known.get(code));
                    if (known.has(code) && at >= 0) {
                        chars.splice(at, 1);
                        codes.splice(codes.indexOf(code), 1);
                    }
                }
            }
            const unknown = [...new Set(codes.filter((c) => !known.has(c)))];
            if (unknown.length && unknown.length === chars.length && codes.length === chars.length) {
                codes.forEach((c, i) => {
                    if (!known.has(c)) known.set(c, chars[i]);
                });
                progress = true;
            }
        }
        if (!progress) break;
    }

    let changed = false;
    for (const [code, str] of original) if (known.get(code) !== str) changed = true;
    for (const code of known.keys()) if (!original.has(code)) changed = true;
    return changed ? known : null;
}

// ---- document --------------------------------------------------------------------

// Fixes every simple font that LibreOffice wrote with ActualText spans.
// Returns the number of fonts repaired.
export function repairActualTextFonts(lib, doc) {
    const { PDFName, PDFDict, PDFArray, PDFRawStream, PDFRef, decodePDFRawStream } = lib;
    const spansByFont = new Map(); // font dict ref string -> { ref, spans }

    // Byte-for-byte (TextDecoder's "latin1" is really windows-1252).
    const decode = (stream) => {
        const bytes = decodePDFRawStream(stream).decode();
        let out = '';
        for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
        return out;
    };

    for (const page of doc.getPages()) {
        const contents = page.node.Contents();
        if (!contents) continue;
        const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
        const text = streams.filter((s) => s instanceof PDFRawStream).map(decode).join('\n');
        if (!text.includes('/ActualText')) continue;
        const fonts = page.node.Resources()?.lookup(PDFName.of('Font'), PDFDict);
        if (!fonts) continue;
        for (const span of findActualTextSpans(text)) {
            if (!span.font) continue;
            const ref = fonts.get(PDFName.of(span.font));
            if (!(ref instanceof PDFRef)) continue;
            const key = ref.toString();
            if (!spansByFont.has(key)) spansByFont.set(key, { ref, spans: [] });
            spansByFont.get(key).spans.push(span);
        }
    }

    let repaired = 0;
    for (const { ref, spans } of spansByFont.values()) {
        const font = doc.context.lookup(ref, PDFDict);
        const subtype = font.get(PDFName.of('Subtype'));
        if (subtype !== PDFName.of('TrueType') && subtype !== PDFName.of('Type1')) continue; // single-byte codes only
        const tuRef = font.get(PDFName.of('ToUnicode'));
        const tu = tuRef && doc.context.lookup(tuRef);
        if (!(tu instanceof PDFRawStream)) continue;
        const fixed = solveMapping(parseCMap(decode(tu)), spans);
        if (!fixed) continue;
        const stream = doc.context.flateStream(writeCMap(fixed));
        font.set(PDFName.of('ToUnicode'), doc.context.register(stream));
        repaired++;
    }
    return repaired;
}
