// Page content stream editing, the way Acrobat's "Edit Text & Images"
// works on the file itself: the page's drawing operators are interpreted
// to learn where every glyph and image lands, then rewritten.
//
// - Text: glyphs inside a box are removed from their Tj/TJ strings and
//   replaced by spacing, so the rest of the line stays exactly in place
//   and the old words leave the file (search and copy no longer find them).
// - Images: an image's Do is dropped, or wrapped in a cm that moves/scales
//   it, or pointed at a new image.
//
// Only the page's own content is edited; text and images inside form
// XObjects are left alone.

// ---- matrices (PDF row-vector convention: p' = p × M) ----------------------

export const IDENTITY = [1, 0, 0, 1, 0, 0];

export function mul(m, n) {
    return [
        m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
        m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
        m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
    ];
}

export function invert(m) {
    const det = m[0] * m[3] - m[1] * m[2];
    if (!det) return IDENTITY;
    return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

export function apply(m, x, y) {
    return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}

// ---- tokenizer ---------------------------------------------------------------------

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set('()<>[]{}/%'.split('').map((c) => c.charCodeAt(0)));

// s is the content as a binary string (one char per byte). Returns ops:
// [{ op, args, start, end }] where start/end delimit the op's source text.
export function parseContent(s) {
    let i = 0;
    const n = s.length;
    const ops = [];
    let args = [];
    let argStart = -1;

    const skipWs = () => {
        while (i < n) {
            const c = s.charCodeAt(i);
            if (WS.has(c)) i++;
            else if (c === 37) while (i < n && s[i] !== '\n' && s[i] !== '\r') i++;
            else break;
        }
    };

    const readLiteral = () => {
        let depth = 1;
        const bytes = [];
        i++;
        while (i < n && depth > 0) {
            const ch = s[i];
            if (ch === '\\') {
                const nx = s[i + 1];
                if (/[0-7]/.test(nx)) {
                    let oct = '';
                    i++;
                    while (oct.length < 3 && /[0-7]/.test(s[i])) oct += s[i++];
                    bytes.push(parseInt(oct, 8) & 255);
                    continue;
                }
                i += 2;
                if (nx === '\r') {
                    if (s[i] === '\n') i++;
                    continue;
                }
                if (nx === '\n') continue;
                bytes.push({ n: 10, r: 13, t: 9, b: 8, f: 12 }[nx] ?? nx.charCodeAt(0));
                continue;
            }
            if (ch === '(') depth++;
            if (ch === ')' && --depth === 0) {
                i++;
                break;
            }
            bytes.push(s.charCodeAt(i++));
        }
        return { str: bytes };
    };

    const readHex = () => {
        i++;
        let hex = '';
        while (i < n && s[i] !== '>') {
            if (!WS.has(s.charCodeAt(i))) hex += s[i];
            i++;
        }
        i++;
        if (hex.length % 2) hex += '0';
        const bytes = [];
        for (let k = 0; k < hex.length; k += 2) bytes.push(parseInt(hex.slice(k, k + 2), 16));
        return { str: bytes, hex: true };
    };

    const readValue = () => {
        skipWs();
        const c = s[i];
        if (c === '(') return readLiteral();
        if (c === '<' && s[i + 1] === '<') {
            const start = i;
            i += 2;
            let depth = 1;
            while (i < n && depth > 0) {
                if (s[i] === '<' && s[i + 1] === '<') {
                    depth++;
                    i += 2;
                } else if (s[i] === '>' && s[i + 1] === '>') {
                    depth--;
                    i += 2;
                } else if (s[i] === '(') {
                    readLiteral();
                } else {
                    i++;
                }
            }
            return { dict: s.slice(start, i) };
        }
        if (c === '<') return readHex();
        if (c === '[') {
            i++;
            const arr = [];
            for (;;) {
                skipWs();
                if (i >= n || s[i] === ']') {
                    i++;
                    break;
                }
                arr.push(readValue());
            }
            return arr;
        }
        if (c === '/') {
            const start = ++i;
            while (i < n && !WS.has(s.charCodeAt(i)) && !DELIM.has(s.charCodeAt(i))) i++;
            return { name: s.slice(start, i) };
        }
        const start = i;
        while (i < n && !WS.has(s.charCodeAt(i)) && !DELIM.has(s.charCodeAt(i))) i++;
        if (i === start) {
            i++; // stray delimiter
            return { op: s[start] };
        }
        const word = s.slice(start, i);
        const num = Number(word);
        if (word !== '' && !Number.isNaN(num) && /^[+\-.\d]/.test(word)) return num;
        return { op: word };
    };

    while (i < n) {
        skipWs();
        if (i >= n) break;
        if (argStart < 0) argStart = i;
        const v = readValue();
        if (v && typeof v === 'object' && !Array.isArray(v) && 'op' in v) {
            if (v.op === 'ID') {
                // Inline image data: binary up to whitespace + EI + whitespace.
                let j = i + 1;
                while (j < n - 2 && !(WS.has(s.charCodeAt(j - 1)) && s[j] === 'E' && s[j + 1] === 'I' && (j + 2 >= n || WS.has(s.charCodeAt(j + 2))))) j++;
                i = j + 2;
                ops.push({ op: 'BI…EI', args: [], start: argStart, end: i });
                // The BI op and its key/value pairs were already collected as one op.
                const bi = ops.findLastIndex((o) => o.op === 'BI');
                if (bi >= 0 && bi === ops.length - 2) {
                    ops[ops.length - 2].end = i;
                    ops[ops.length - 2].op = 'BI…EI';
                    ops.pop();
                }
            } else {
                ops.push({ op: v.op, args, start: argStart, end: i });
            }
            args = [];
            argStart = -1;
        } else {
            args.push(v);
        }
    }
    return ops;
}

// ---- serializing ----------------------------------------------------------------------

function fmtNum(x) {
    if (Number.isInteger(x)) return String(x);
    const r = Math.round(x * 10000) / 10000;
    return String(r === 0 ? 0 : r);
}

function hexStr(bytes) {
    return '<' + bytes.map((b) => b.toString(16).padStart(2, '0')).join('') + '>';
}

export function writeValue(v) {
    if (typeof v === 'number') return fmtNum(v);
    if (Array.isArray(v)) return '[' + v.map(writeValue).join(' ') + ']';
    if (v.name !== undefined) return '/' + v.name;
    if (v.str) return hexStr(v.str);
    if (v.dict) return v.dict;
    return '';
}

// ---- fonts ---------------------------------------------------------------------------------

function num(lib, v) {
    return v instanceof lib.PDFNumber ? v.asNumber() : undefined;
}

// What the interpreter needs from a font: bytes per code, widths, name.
export function fontInfo(lib, doc, fontDict) {
    const { PDFName, PDFArray, PDFDict } = lib;
    const get = (d, k) => d?.lookup(PDFName.of(k));
    const subtype = get(fontDict, 'Subtype')?.asString?.() || '';
    const baseFont = (get(fontDict, 'BaseFont')?.asString?.() || '').replace(/^\//, '').replace(/^[A-Z]{6}\+/, '');
    if (subtype === '/Type0') {
        const enc = get(fontDict, 'Encoding');
        const desc = get(fontDict, 'DescendantFonts');
        const cid = desc instanceof PDFArray ? desc.lookup(0, PDFDict) : null;
        const editable = enc === PDFName.of('Identity-H');
        const dw = num(lib, get(cid, 'DW')) ?? 1000;
        const widths = new Map();
        const w = get(cid, 'W');
        if (w instanceof PDFArray) {
            const a = w.asArray().map((x) => doc.context.lookup(x));
            for (let k = 0; k < a.length;) {
                const first = num(lib, a[k]);
                if (a[k + 1] instanceof PDFArray) {
                    a[k + 1].asArray().forEach((x, j) => widths.set(first + j, num(lib, doc.context.lookup(x)) ?? dw));
                    k += 2;
                } else {
                    const last = num(lib, a[k + 1]);
                    const width = num(lib, a[k + 2]);
                    for (let c = first; c <= last && c - first < 65536; c++) widths.set(c, width);
                    k += 3;
                }
            }
        }
        return { codeLen: 2, width: (c) => widths.get(c) ?? dw, baseFont, editable };
    }
    if (subtype === '/Type3') return { codeLen: 1, width: () => 0, baseFont, editable: false };
    const first = num(lib, get(fontDict, 'FirstChar')) ?? 0;
    const ws = get(fontDict, 'Widths');
    const missing = num(lib, get(get(fontDict, 'FontDescriptor'), 'MissingWidth'));
    const widths = ws instanceof PDFArray ? ws.asArray().map((x) => num(lib, doc.context.lookup(x)) ?? 0) : null;
    // Standard 14 fonts come without widths: a typical average is close
    // enough for finding which glyphs sit inside a box.
    const fallback = missing ?? (/Courier/i.test(baseFont) ? 600 : 520);
    return {
        codeLen: 1,
        width: (c) => (widths && c >= first && c - first < widths.length ? widths[c - first] : fallback),
        baseFont,
        editable: true,
    };
}

// ---- interpreter -------------------------------------------------------------------------------

// Runs the page's operators. Returns { glyphs, images } in PDF user space:
// glyphs: { op, part, index, code, origin, adv, up, size, font, color, fontName }
// images: { op, name, ctm }
export function interpret(ops, { fontFor, isImage }) {
    let gs = { ctm: IDENTITY, color: [0, 0, 0], font: null, fontName: null, size: 0, Tc: 0, Tw: 0, Th: 1, TL: 0, Ts: 0 };
    const stack = [];
    let Tm = IDENTITY;
    let Tlm = IDENTITY;
    const glyphs = [];
    const images = [];

    const showString = (opIndex, part, bytes) => {
        const font = gs.font;
        if (!font) return;
        const len = font.codeLen;
        for (let k = 0; k + len <= bytes.length; k += len) {
            const code = len === 2 ? (bytes[k] << 8) | bytes[k + 1] : bytes[k];
            const w0 = font.width(code) / 1000;
            const space = len === 1 && code === 32 ? gs.Tw : 0;
            const tx = (w0 * gs.size + gs.Tc + space) * gs.Th;
            const trm = mul([gs.size * gs.Th, 0, 0, gs.size, 0, gs.Ts], mul(Tm, gs.ctm));
            const origin = apply(trm, 0, 0);
            const advEnd = apply(mul([1, 0, 0, 1, tx, 0], mul(Tm, gs.ctm)), 0, 0);
            const upPt = apply(trm, 0, 1);
            glyphs.push({
                op: opIndex,
                part,
                index: k,
                code,
                len,
                w0: w0 * 1000,
                space,
                origin,
                adv: [advEnd[0] - origin[0], advEnd[1] - origin[1]],
                up: [upPt[0] - origin[0], upPt[1] - origin[1]],
                size: Math.hypot(upPt[0] - origin[0], upPt[1] - origin[1]),
                font,
                fontSize: gs.size,
                Tc: gs.Tc,
                Th: gs.Th,
                color: gs.color,
                fontName: gs.fontName,
            });
            Tm = mul([1, 0, 0, 1, tx, 0], Tm);
        }
    };
    const nextLine = (tx, ty) => {
        Tlm = mul([1, 0, 0, 1, tx, ty], Tlm);
        Tm = Tlm;
    };

    ops.forEach((o, idx) => {
        const a = o.args;
        switch (o.op) {
            case 'q': stack.push(gs); gs = { ...gs }; break;
            case 'Q': if (stack.length) gs = stack.pop(); break;
            case 'cm': if (a.length === 6) gs.ctm = mul(a, gs.ctm); break;
            case 'BT': Tm = IDENTITY; Tlm = IDENTITY; break;
            case 'Tf': gs.fontName = a[0]?.name; gs.font = fontFor(a[0]?.name); gs.size = a[1] ?? 0; break;
            case 'Tc': gs.Tc = a[0] ?? 0; break;
            case 'Tw': gs.Tw = a[0] ?? 0; break;
            case 'Tz': gs.Th = (a[0] ?? 100) / 100; break;
            case 'TL': gs.TL = a[0] ?? 0; break;
            case 'Ts': gs.Ts = a[0] ?? 0; break;
            case 'Td': nextLine(a[0] ?? 0, a[1] ?? 0); break;
            case 'TD': gs.TL = -(a[1] ?? 0); nextLine(a[0] ?? 0, a[1] ?? 0); break;
            case 'Tm': if (a.length === 6) { Tm = a; Tlm = a; } break;
            case 'T*': nextLine(0, -gs.TL); break;
            case 'Tj': if (a[0]?.str) showString(idx, 0, a[0].str); break;
            case "'": nextLine(0, -gs.TL); if (a[0]?.str) showString(idx, 0, a[0].str); break;
            case '"': gs.Tw = a[0] ?? 0; gs.Tc = a[1] ?? 0; nextLine(0, -gs.TL); if (a[2]?.str) showString(idx, 0, a[2].str); break;
            case 'TJ':
                (Array.isArray(a[0]) ? a[0] : []).forEach((el, part) => {
                    if (typeof el === 'number') Tm = mul([1, 0, 0, 1, (-el / 1000) * gs.size * gs.Th, 0], Tm);
                    else if (el?.str) showString(idx, part, el.str);
                });
                break;
            case 'rg': if (a.length === 3) gs.color = a; break;
            case 'g': if (a.length === 1) gs.color = [a[0], a[0], a[0]]; break;
            case 'k': if (a.length === 4) gs.color = [(1 - a[0]) * (1 - a[3]), (1 - a[1]) * (1 - a[3]), (1 - a[2]) * (1 - a[3])]; break;
            case 'sc':
            case 'scn': {
                const nums = a.filter((x) => typeof x === 'number');
                if (nums.length === 3) gs.color = nums;
                else if (nums.length === 1) gs.color = [nums[0], nums[0], nums[0]];
                break;
            }
            case 'Do': if (a[0]?.name && isImage(a[0].name)) images.push({ op: idx, name: a[0].name, ctm: gs.ctm }); break;
            default: break;
        }
    });
    return { glyphs, images };
}

// ---- rewriting -------------------------------------------------------------------------------

// Glyphs whose middle lies inside rect [x1, y1, x2, y2] (user space).
export function glyphsInRect(glyphs, rect) {
    const [x1, y1, x2, y2] = rect;
    return glyphs.filter((g) => {
        if (!g.font.editable) return false;
        const cx = g.origin[0] + g.adv[0] / 2 + g.up[0] * 0.35;
        const cy = g.origin[1] + g.adv[1] / 2 + g.up[1] * 0.35;
        return cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2;
    });
}

// Rewrites ops so the given glyphs are not drawn; every other glyph keeps
// its position (each removed glyph becomes a TJ spacing adjustment).
// Returns a Map(op index -> replacement source text).
export function removeGlyphs(ops, removed) {
    const byOp = new Map();
    for (const g of removed) {
        if (!byOp.has(g.op)) byOp.set(g.op, new Map());
        byOp.get(g.op).set(`${g.part}:${g.index}`, g);
    }
    const out = new Map();
    for (const [opIndex, gone] of byOp) {
        const o = ops[opIndex];
        let pieces;
        let prefix = '';
        if (o.op === 'TJ') pieces = o.args[0];
        else if (o.op === 'Tj') pieces = [o.args[0]];
        else if (o.op === "'") {
            pieces = [o.args[0]];
            prefix = 'T* ';
        } else if (o.op === '"') {
            pieces = [o.args[2]];
            prefix = `${fmtNum(o.args[0])} Tw ${fmtNum(o.args[1])} Tc T* `;
        } else continue;

        const arr = [];
        pieces.forEach((el, part) => {
            if (typeof el === 'number') {
                arr.push(el);
                return;
            }
            if (!el?.str) return;
            let keep = [];
            const sample = [...gone.values()].find((g) => g.part === part);
            const len = sample ? sample.len : 1;
            for (let k = 0; k + len <= el.str.length; k += len) {
                const g = gone.get(`${part}:${k}`);
                if (!g) {
                    keep.push(...el.str.slice(k, k + len));
                    continue;
                }
                if (keep.length) arr.push({ str: keep });
                keep = [];
                const size = g.fontSize || 1;
                arr.push(-(g.w0 + ((g.Tc + g.space) * 1000) / size));
            }
            if (keep.length) arr.push({ str: keep });
        });
        // Merge neighbouring numbers to keep the array short.
        const merged = [];
        for (const el of arr) {
            if (typeof el === 'number' && typeof merged[merged.length - 1] === 'number') merged[merged.length - 1] += el;
            else merged.push(el);
        }
        out.set(opIndex, `${prefix}${writeValue(merged)} TJ`);
    }
    return out;
}

// Rebuilds the content text with some ops replaced (or removed with '').
export function rebuild(s, ops, replace) {
    let out = '';
    let last = 0;
    ops.forEach((o, idx) => {
        if (!replace.has(idx)) return;
        out += s.slice(last, o.start) + replace.get(idx);
        last = o.end;
    });
    return out + s.slice(last);
}

// Lines of selectable text for the editor: glyphs grouped by baseline.
export function describeGlyphs(glyphs) {
    if (!glyphs.length) return null;
    const first = glyphs.reduce((a, b) => {
        const dir = [a.adv[0], a.adv[1]];
        return (b.origin[0] - a.origin[0]) * dir[0] + (b.origin[1] - a.origin[1]) * dir[1] < 0 ? b : a;
    });
    const sizes = glyphs.map((g) => g.size).sort((a, b) => a - b);
    return {
        origin: first.origin,
        angle: Math.atan2(first.adv[1], first.adv[0]),
        size: sizes[Math.floor(sizes.length / 2)],
        color: first.color,
        baseFont: first.font.baseFont,
    };
}
