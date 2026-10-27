// Tools > Compare Files: text differences between the open document and
// another PDF, listed in the Compare panel and marked on the open pages.
//
// Diffing is two-level: lines first (fast, and keeps page structure), then
// words inside each changed block. Thai has no spaces between words, so
// words come from Intl.Segmenter('th').

import { on } from './bus.js';
import { state, getPdfPage } from './docstate.js';
import { allViews, scrollToIndex } from './viewer.js';
import { loadPdf } from './pdfjs.js';
import { cleanCopiedText } from './thai.js';
import { PAGE_SIZE } from './config.js';
import { askPassword, showFormDialog, progressDialog, toast } from './dialog.js';

const $ = (id) => document.getElementById(id);
const segmenter = new Intl.Segmenter('th', { granularity: 'word' });
// Beyond this many word edits a block is reported as replaced lines; beyond
// MAX_LINE_EDITS the files are too different to list usefully.
const MAX_WORD_EDITS = 4000;
const MAX_LINE_EDITS = 6000;

let result = null; // { otherName, otherIsOld, changes, marks: Map(pageKey -> [[start,end]]) }
let listPage = 0;

// ---- text -------------------------------------------------------------------

// Page text as lines, plus each text item's start offset (for marking).
async function pageLines(page) {
    const content = await page.getTextContent();
    let text = '';
    const starts = [];
    for (const item of content.items) {
        if (item.str === undefined) continue;
        starts.push(text.length);
        text += cleanCopiedText(item.str) + (item.hasEOL ? '\n' : '');
    }
    const lines = [];
    let at = 0;
    for (const raw of text.split('\n')) {
        const norm = raw.replace(/\s+/g, ' ').trim();
        if (norm) lines.push({ text: norm, start: at, end: at + raw.length });
        at += raw.length + 1;
    }
    return { text, starts, lines };
}

async function docLines(getPage, count, label, progress) {
    const out = [];
    for (let i = 0; i < count; i++) {
        if (progress.cancelled) return null;
        progress.update(`กำลังอ่านข้อความ${label} หน้า ${i + 1} จาก ${count}`, null);
        const { lines, starts } = await pageLines(await getPage(i));
        for (const l of lines) out.push({ ...l, page: i });
        out.push({ page: i, starts, pageEnd: true });
    }
    return out;
}

function words(line) {
    const out = [];
    for (const seg of segmenter.segment(line.text)) {
        if (!seg.segment.trim()) continue;
        out.push({ text: seg.segment, offset: seg.index });
    }
    return out;
}

// ---- diff -------------------------------------------------------------------------

// Myers' O((N+M)D) diff. Returns ops [{ op: '=', '-', '+', a, b }] or null
// when more than maxD edits are needed. Only the diagonals reached at each
// step are kept for the backtrack, so memory grows with D², not D·(N+M).
export function diff(a, b, eq = (x, y) => x === y, maxD = Infinity) {
    const n = a.length;
    const m = b.length;
    const max = Math.min(n + m, maxD);
    const offset = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace = [];
    for (let d = 0; d <= max; d++) {
        trace.push(v.slice(offset - d - 1, offset + d + 2)); // k in [-d-1, d+1]
        for (let k = -d; k <= d; k += 2) {
            let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && eq(a[x], b[y])) {
                x++;
                y++;
            }
            v[offset + k] = x;
            if (x >= n && y >= m) return backtrack(trace, n, m, d);
        }
    }
    return null;
}

function backtrack(trace, n, m, dEnd) {
    const ops = [];
    let x = n;
    let y = m;
    for (let d = dEnd; d > 0; d--) {
        const row = trace[d];
        const at = (k) => row[k + d + 1];
        const k = x - y;
        const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
        const prevX = at(prevK);
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) ops.push({ op: '=', a: --x, b: --y });
        if (x === prevX) ops.push({ op: '+', b: --y });
        else ops.push({ op: '-', a: --x });
    }
    while (x > 0 && y > 0) ops.push({ op: '=', a: --x, b: --y });
    return ops.reverse();
}

// ---- compare ------------------------------------------------------------------------

export async function compareFiles() {
    const [file] = await window.host.openDialog({ multiple: false });
    if (!file) return;
    $('cmp-other-name').textContent = file.name;
    if (!(await showFormDialog('dlg-compare'))) return;
    const otherIsOld = document.querySelector('input[name="cmp-role"]:checked').value === 'old';

    const progress = progressDialog('Compare Files');
    let other;
    try {
        other = await loadPdf(file.data, askPassword);
        const A = await docLines((i) => other.getPage(i + 1), other.numPages, ` (${file.name})`, progress);
        const B = A && (await docLines((i) => getPdfPage(state.pages[i]), state.pages.length, ' (ฉบับที่เปิดอยู่)', progress));
        if (!B) return toast('ยกเลิกแล้ว');
        progress.update('กำลังเปรียบเทียบ…', null);
        result = { otherName: file.name, otherIsOld, ...buildChanges(A, B) };
        listPage = 0;
        renderPanel();
        refreshMarks();
        document.querySelector('[data-action="show-compare"]').click();
        const n = result.changes.length;
        toast(n ? `พบความแตกต่าง ${n} จุด` : 'ข้อความของทั้งสองไฟล์ตรงกัน');
    } catch (err) {
        console.error(err);
        toast(`เปรียบเทียบไม่สำเร็จ: ${err?.message || err}`, 'error');
    } finally {
        progress.close();
        other?.loadingTask.destroy();
    }
}

// A: the other file's lines, B: the open document's lines.
function buildChanges(A, B) {
    const aLines = A.filter((l) => !l.pageEnd);
    const bLines = B.filter((l) => !l.pageEnd);
    const startsB = new Map(B.filter((l) => l.pageEnd).map((l) => [l.page, l.starts]));
    const lineOps = diff(aLines, bLines, (x, y) => x.text === y.text, MAX_LINE_EDITS);
    if (!lineOps) throw new Error('สองไฟล์นี้ต่างกันมากเกินกว่าจะเปรียบเทียบทีละจุดได้');
    const changes = [];
    const marks = new Map(); // B page index -> [[start, end]]
    const mark = (page, s, e) => {
        if (!marks.has(page)) marks.set(page, []);
        marks.get(page).push([s, e]);
    };

    // Walk runs of non-equal lines and word-diff each run.
    let i = 0;
    while (i < lineOps.length) {
        if (lineOps[i].op === '=') {
            i++;
            continue;
        }
        const del = [];
        const ins = [];
        while (i < lineOps.length && lineOps[i].op !== '=') {
            if (lineOps[i].op === '-') del.push(aLines[lineOps[i].a]);
            else ins.push(bLines[lineOps[i].b]);
            i++;
        }
        const aw = del.flatMap((l) => words(l).map((w) => ({ ...w, line: l })));
        const bw = ins.flatMap((l) => words(l).map((w) => ({ ...w, line: l })));
        const wordOps = diff(aw, bw, (x, y) => x.text === y.text, MAX_WORD_EDITS) ||
            [...aw.map((_, a) => ({ op: '-', a })), ...bw.map((_, b) => ({ op: '+', b }))];
        let k = 0;
        while (k < wordOps.length) {
            if (wordOps[k].op === '=') {
                k++;
                continue;
            }
            const dw = [];
            const iw = [];
            while (k < wordOps.length && wordOps[k].op !== '=') {
                if (wordOps[k].op === '-') dw.push(aw[wordOps[k].a]);
                else iw.push(bw[wordOps[k].b]);
                k++;
            }
            for (const w of iw) mark(w.line.page, w.line.start + w.offset, w.line.start + w.offset + w.text.length);
            const join = (ws) => ws.map((w) => w.text).join('').replace(/\s+/g, ' ');
            changes.push({
                type: dw.length && iw.length ? 'replace' : iw.length ? 'insert' : 'delete',
                aText: join(dw),
                bText: join(iw),
                aPage: dw[0]?.line.page,
                bPage: iw[0]?.line.page ?? nearestBPage(ins, bLines, lineOps, i),
            });
        }
    }
    return { changes, marks, startsB };
}

// Page in the open document closest to a deletion (for jumping there).
function nearestBPage(ins, bLines, lineOps, i) {
    for (let j = i; j < lineOps.length; j++) if (lineOps[j].op !== '-' && lineOps[j].b !== undefined) return bLines[lineOps[j].b]?.page;
    return bLines[bLines.length - 1]?.page ?? 0;
}

// ---- marks on the pages ----------------------------------------------------------------

export function initCompare() {
    on('text-layer-rendered', (view) => markView(view));
    on('pages-changed', () => clearCompare());
    $('cmp-clear').addEventListener('click', () => clearCompare());
    $('cmp-list').addEventListener('click', (e) => {
        const li = e.target.closest('li[data-change]');
        if (!li) return;
        const c = result.changes[Number(li.dataset.change)];
        if (c.bPage !== undefined) scrollToIndex(c.bPage);
    });
    $('cmp-pager').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-list-page]');
        if (!b || b.disabled) return;
        listPage = Number(b.dataset.listPage);
        renderPanel();
    });
}

export function clearCompare() {
    result = null;
    refreshMarks();
    renderPanel();
}

function refreshMarks() {
    for (const view of allViews()) markView(view);
}

function markView(view) {
    if (!view.textLayer) return;
    const divs = view.textLayer.textDivs;
    divs.forEach((d) => d.classList.remove('compare-diff'));
    if (!result) return;
    const page = state.pages.indexOf(view.entry);
    const ranges = result.marks.get(page);
    const starts = result.startsB.get(page);
    if (!ranges || !starts) return;
    for (const [s, e] of ranges) {
        for (let k = 0; k < starts.length; k++) {
            const itemEnd = k + 1 < starts.length ? starts[k + 1] : Infinity;
            if (starts[k] < e && itemEnd > s) divs[k]?.classList.add('compare-diff');
        }
    }
}

// ---- panel ------------------------------------------------------------------------------

function renderPanel() {
    const list = $('cmp-list');
    const pager = $('cmp-pager');
    list.replaceChildren();
    pager.replaceChildren();
    document.querySelector('[data-panel-tab="compare"]').hidden = !result;
    $('cmp-clear').hidden = !result;
    if (!result) {
        $('cmp-summary').textContent = '';
        $('cmp-empty').hidden = true;
        return;
    }
    const { changes, otherIsOld, otherName } = result;
    const counts = { insert: 0, delete: 0, replace: 0 };
    for (const c of changes) counts[c.type]++;
    // "Inserted" means: in the open document but not in the other file.
    const label = otherIsOld
        ? { insert: 'เพิ่ม', delete: 'ลบ', replace: 'แก้ไข' }
        : { insert: 'ลบ', delete: 'เพิ่ม', replace: 'แก้ไข' };
    $('cmp-summary').textContent = changes.length
        ? `เทียบกับ ${otherName}: ${changes.length} จุด (${label.insert} ${counts.insert} · ${label.delete} ${counts.delete} · แก้ไข ${counts.replace})`
        : `เทียบกับ ${otherName}`;
    $('cmp-empty').hidden = changes.length > 0;
    if (!changes.length) return;

    const pages = Math.ceil(changes.length / PAGE_SIZE);
    listPage = Math.min(listPage, pages - 1);
    const from = listPage * PAGE_SIZE;
    changes.slice(from, from + PAGE_SIZE).forEach((c, n) => {
        const li = document.createElement('li');
        li.dataset.change = from + n;
        li.dataset.type = c.type;
        const head = document.createElement('span');
        head.className = 'cmp-head';
        head.textContent = `${label[c.type]}${c.bPage !== undefined ? ` · หน้า ${c.bPage + 1}` : ''}`;
        li.append(head);
        // Old text struck through, new text underlined, whichever file is which.
        const oldText = otherIsOld ? c.aText : c.bText;
        const newText = otherIsOld ? c.bText : c.aText;
        if (oldText) {
            const del = document.createElement('del');
            del.textContent = oldText.length > 160 ? `${oldText.slice(0, 160)}…` : oldText;
            li.append(del);
        }
        if (newText) {
            const ins = document.createElement('ins');
            ins.textContent = newText.length > 160 ? `${newText.slice(0, 160)}…` : newText;
            li.append(ins);
        }
        list.append(li);
    });
    if (pages > 1) {
        const btn = (text, target, disabled, active = false) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = text;
            b.dataset.listPage = target;
            b.disabled = disabled;
            if (active) b.className = 'is-active';
            return b;
        };
        pager.append(btn('‹ Prev', listPage - 1, listPage === 0));
        const first = Math.max(0, Math.min(listPage - 2, pages - 5));
        for (let p = first; p < Math.min(pages, first + 5); p++) pager.append(btn(String(p + 1), p, false, p === listPage));
        pager.append(btn('Next ›', listPage + 1, listPage >= pages - 1));
    }
}

