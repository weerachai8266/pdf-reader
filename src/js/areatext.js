// Tools > Copy Text from Area: drag a box on the page and the text inside
// it goes to the clipboard. Pages with a text layer (including one added by
// OCR) are read directly; on a scanned page without one, only the boxed
// area is run through OCR.

import { on } from './bus.js';
import { getPdfPage } from './docstate.js';
import { recognizeArea } from './ocr.js';
import { cleanCopiedText } from './thai.js';
import { progressDialog, toast } from './dialog.js';

const segmenter = new Intl.Segmenter('th', { granularity: 'grapheme' });

export function initAreaText() {
    on('area-text', ({ entry, quad }) => copyArea(entry, quad).catch((err) => {
        console.error(err);
        toast(`คัดลอกข้อความไม่สำเร็จ: ${err?.message || err}`, 'error');
    }));
}

// [x1, y1, x2, y2] in PDF user space. Page rotation is a multiple of 90°,
// so the on-screen box is axis-aligned here too.
function quadRect({ bl, br, tl }) {
    const xs = [bl[0], br[0], tl[0], br[0] + tl[0] - bl[0]];
    const ys = [bl[1], br[1], tl[1], br[1] + tl[1] - bl[1]];
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

async function copyArea(entry, quad) {
    const rect = quadRect(quad);
    let text = await textInRect(entry, rect);
    let viaOcr = false;
    if (!text.trim()) {
        const progress = progressDialog('Copy Text from Area');
        progress.update('ไม่มีข้อความในพื้นที่นี้ กำลังอ่านด้วย OCR…', null);
        try {
            text = cleanCopiedText(await recognizeArea(entry, rect));
            viaOcr = true;
        } finally {
            progress.close();
        }
    }
    text = text.trim();
    if (!text) {
        toast('ไม่พบข้อความในพื้นที่ที่เลือก', 'error');
        return;
    }
    await window.host.copyText(text);
    const preview = text.length > 40 ? `${text.slice(0, 40).replace(/\n/g, ' ')}…` : text.replace(/\n/g, ' ');
    toast(`คัดลอกแล้ว${viaOcr ? ' (อ่านด้วย OCR ควรตรวจทาน)' : ''}: ${preview}`);
}

// Text of the page's text layer whose characters fall inside rect, in
// reading order. A text item that crosses the box edge contributes only
// the characters inside (assuming evenly spaced characters).
export async function textInRect(entry, [x1, y1, x2, y2]) {
    const page = await getPdfPage(entry);
    const content = await page.getTextContent();
    const inside = (x, y) => x >= x1 && x <= x2 && y >= y1 && y <= y2;
    const pieces = [];
    for (const item of content.items) {
        if (!item.str || !item.str.trim()) continue;
        const [a, b, c, d, e, f] = item.transform;
        const scale = Math.hypot(a, b);
        if (!scale) continue;
        const u = [a / scale, b / scale];
        const v = [-u[1], u[0]];
        const height = item.height || Math.hypot(c, d) || scale;
        const graphemes = [...segmenter.segment(item.str)].map((s) => s.segment);
        const step = item.width / graphemes.length;
        let first = -1;
        let last = -1;
        graphemes.forEach((g, i) => {
            const along = step * (i + 0.5);
            const cx = e + u[0] * along + v[0] * height * 0.35;
            const cy = f + u[1] * along + v[1] * height * 0.35;
            if (inside(cx, cy)) {
                if (first < 0) first = i;
                last = i;
            }
        });
        if (first < 0) continue;
        pieces.push({
            text: graphemes.slice(first, last + 1).join(''),
            // Position along the line and across it (baseline), and extent.
            start: e * u[0] + f * u[1] + step * first,
            end: e * u[0] + f * u[1] + step * (last + 1),
            line: e * v[0] + f * v[1],
            height,
        });
    }
    return cleanCopiedText(joinLines(pieces));
}

function joinLines(pieces) {
    // Top line first (larger "across" value), then left to right.
    pieces.sort((p, q) => q.line - p.line || p.start - q.start);
    const lines = [];
    for (const p of pieces) {
        const line = lines[lines.length - 1];
        if (line && Math.abs(line.at - p.line) < Math.min(line.height, p.height) * 0.5) line.items.push(p);
        else lines.push({ at: p.line, height: p.height, items: [p] });
    }
    return lines.map(({ items }) => {
        items.sort((p, q) => p.start - q.start);
        let out = '';
        let prevEnd = null;
        for (const p of items) {
            const gap = prevEnd === null ? 0 : p.start - prevEnd;
            if (out && gap > p.height * 0.25 && !/\s$/.test(out) && !/^\s/.test(p.text)) out += ' ';
            out += p.text;
            prevEnd = p.end;
        }
        return out.trim();
    }).filter(Boolean).join('\n');
}
