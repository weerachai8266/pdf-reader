// Rebuilds a PDF's text as flowing HTML (paragraphs, headings, bold,
// alignment, page breaks) for Export to Word. LibreOffice then turns the
// HTML into .docx. Going through pdf.js keeps Thai intact, which
// LibreOffice's own PDF import does not.
//
// This recovers text and its basic formatting, not the exact layout:
// tables become lines of text and images are not carried over.

import { cleanCopiedText } from './thai.js';

const THAI = /[ก-๛]/;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Real font name ("ABCDEF+THSarabunNew-Bold") once the page's fonts are
// loaded; needs the document opened with fontExtraProperties.
function fontInfo(page, fontName, cache) {
    if (cache.has(fontName)) return cache.get(fontName);
    let name = '';
    try {
        name = page.commonObjs.get(fontName)?.name || '';
    } catch {}
    const base = name.replace(/^[A-Z]{6}\+/, '');
    const info = {
        bold: /bold|black|heavy|semibold|demi/i.test(base),
        italic: /italic|oblique/i.test(base),
        family: familyFor(base),
    };
    cache.set(fontName, info);
    return info;
}

// A family LibreOffice/Word can find on a Windows PC.
function familyFor(base) {
    if (/sarabun/i.test(base)) return 'TH Sarabun New';
    if (/angsana/i.test(base)) return 'Angsana New';
    if (/cordia/i.test(base)) return 'Cordia New';
    if (/tahoma/i.test(base)) return 'Tahoma';
    if (/leelawadee/i.test(base)) return 'Leelawadee UI';
    if (/times/i.test(base)) return 'Times New Roman';
    if (/arial|helvetica/i.test(base)) return 'Arial';
    if (/calibri/i.test(base)) return 'Calibri';
    const plain = base.split(/[-,]/)[0];
    return plain && /^[\w ]+$/.test(plain) ? plain.replace(/([a-z])([A-Z])/g, '$1 $2') : '';
}

// Text items -> lines (top to bottom), each { y, x1, x2, size, runs }.
function buildLines(items, page, fontCache) {
    const pieces = items
        .filter((it) => it.str && it.str.trim() !== '')
        .map((it) => {
            const [a, b, , , x, y] = it.transform;
            const size = Math.hypot(a, b) || it.height || 10;
            return { str: it.str, x, y, width: it.width, size, font: fontInfo(page, it.fontName, fontCache) };
        });
    pieces.sort((p, q) => q.y - p.y || p.x - q.x);

    const lines = [];
    for (const p of pieces) {
        const line = lines.find((l) => Math.abs(l.y - p.y) < Math.min(l.size, p.size) * 0.5);
        if (line) line.pieces.push(p);
        else lines.push({ y: p.y, size: p.size, pieces: [p] });
    }
    for (const line of lines) {
        line.pieces.sort((p, q) => p.x - q.x);
        line.size = Math.max(...line.pieces.map((p) => p.size));
        line.x1 = line.pieces[0].x;
        line.x2 = Math.max(...line.pieces.map((p) => p.x + p.width));
        line.runs = [];
        let prevEnd = null;
        for (const p of line.pieces) {
            // A visible gap between pieces is a space (Thai clusters touch).
            const gap = prevEnd === null ? 0 : p.x - prevEnd;
            const space = prevEnd !== null && gap > p.size * 0.22 ? ' ' : '';
            const last = line.runs[line.runs.length - 1];
            if (last && last.font.bold === p.font.bold && last.font.italic === p.font.italic && last.font.family === p.font.family) {
                last.text += space + p.str;
            } else {
                line.runs.push({ text: space + p.str, font: p.font });
            }
            prevEnd = p.x + p.width;
        }
    }
    lines.sort((l, m) => m.y - l.y);
    return lines;
}

function alignment(line, pageWidth) {
    const left = line.x1;
    const right = pageWidth - line.x2;
    const width = line.x2 - line.x1;
    if (width < pageWidth * 0.7 && Math.abs(left - right) < pageWidth * 0.05 && left > pageWidth * 0.15) return 'center';
    if (width < pageWidth * 0.6 && right < pageWidth * 0.15 && left > pageWidth * 0.4) return 'right';
    return 'left';
}

// Consecutive lines with the same size, alignment and normal spacing form
// one paragraph.
function buildParagraphs(lines, pageWidth) {
    const paras = [];
    let prev = null;
    for (const line of lines) {
        const align = alignment(line, pageWidth);
        const cur = paras[paras.length - 1];
        const gap = prev ? prev.y - line.y : Infinity;
        const sameStyle = cur && Math.abs(cur.size - line.size) < 0.6 && cur.align === align && align === 'left';
        const indentJump = prev && line.x1 > prev.x1 + line.size * 1.5; // new first-line indent
        if (sameStyle && gap < line.size * 1.75 && !indentJump) {
            const lastRun = cur.runs[cur.runs.length - 1];
            const first = line.runs[0];
            // Thai wraps without a space; other scripts need one.
            const joiner = THAI.test(lastRun.text.slice(-1)) && THAI.test(first.text.trimStart()[0] || '') ? '' : ' ';
            first.text = joiner + first.text.trimStart();
            cur.runs.push(...line.runs);
        } else {
            paras.push({ size: line.size, align, indent: line.x1, runs: [...line.runs] });
        }
        prev = line;
    }
    return paras;
}

function paragraphHtml(para, bodySize, pageBreak) {
    const ratio = para.size / bodySize;
    const allBold = para.runs.every((r) => r.font.bold);
    const tag = ratio > 1.6 ? 'h1' : ratio > 1.3 ? 'h2' : ratio > 1.12 && allBold ? 'h3' : 'p';
    const style = [`font-size:${para.size.toFixed(1)}pt`];
    if (para.align !== 'left') style.push(`text-align:${para.align}`);
    if (pageBreak) style.push('page-break-before:always');
    const body = para.runs.map((r) => {
        let html = esc(cleanCopiedText(r.text));
        const css = r.font.family ? ` style="font-family:'${r.font.family}'"` : '';
        if (css) html = `<span${css}>${html}</span>`;
        if (r.font.bold && tag === 'p') html = `<b>${html}</b>`;
        if (r.font.italic) html = `<i>${html}</i>`;
        return html;
    }).join('');
    return `<${tag} style="${style.join(';')}">${body}</${tag}>`;
}

// pdf: a pdf.js document opened with fontExtraProperties: true.
export async function pdfToHtml(pdf, { title = '', onPage = () => {}, isCancelled = () => false } = {}) {
    const fontCache = new Map();
    const pages = [];
    const sizes = new Map(); // rounded size -> characters, to find body text size
    for (let i = 1; i <= pdf.numPages; i++) {
        if (isCancelled()) return null;
        onPage(i, pdf.numPages);
        const page = await pdf.getPage(i);
        await page.getOperatorList(); // loads fonts so their names are known
        const { items } = await page.getTextContent();
        const [x0, , x1] = page.view;
        const lines = buildLines(items, page, fontCache);
        const paras = buildParagraphs(lines.map((l) => ({ ...l, x1: l.x1 - x0, x2: l.x2 - x0 })), x1 - x0);
        for (const p of paras) {
            const n = p.runs.reduce((sum, r) => sum + r.text.length, 0);
            const key = Math.round(p.size);
            sizes.set(key, (sizes.get(key) || 0) + n);
        }
        pages.push(paras);
        page.cleanup();
    }
    const bodySize = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 12;
    const body = pages.map((paras, n) => paras.map((p, k) => paragraphHtml(p, bodySize, n > 0 && k === 0)).join('\n')).join('\n');
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body { font-family: Tahoma, sans-serif; } p, h1, h2, h3 { margin: 0 0 6pt; }</style>
</head><body>
${body}
</body></html>`;
}
