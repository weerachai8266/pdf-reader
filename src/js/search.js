// Full-text search with Thai-aware normalisation (see thai.js).

import { on } from './bus.js';
import { state, getPdfPage } from './docstate.js';
import { getView, scrollToIndex } from './viewer.js';
import { normalizeText, looseText } from './thai.js';
import { PAGE_SIZE } from './config.js';

const $ = (id) => document.getElementById(id);
const textCache = new Map(); // "srcId:index" -> { strict: {text, starts}, loose: {text, starts} }

let results = []; // { key, start, end, snippet }
let current = -1;
let listPage = 0;
let token = 0;
let pendingScroll = false;
let searchMode = 'strict';

export function initSearch() {
    const input = $('search-input');
    let debounce = null;
    input.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => runSearch(input.value), 250);
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
        }
    });
    $('search-prev').addEventListener('click', () => step(-1));
    $('search-next').addEventListener('click', () => step(1));
    $('search-results').addEventListener('click', (e) => {
        const li = e.target.closest('[data-hit]');
        if (li) goTo(Number(li.dataset.hit));
    });
    $('search-pager').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-list-page]');
        if (!btn) return;
        listPage = Number(btn.dataset.listPage);
        renderList();
    });
    on('text-layer-rendered', (view) => applyMarks(view));
    on('pages-changed', () => runSearch(input.value));
}

export function focusSearch() {
    $('search-input').focus();
    $('search-input').select();
}

export function resetSearch() {
    textCache.clear();
    $('search-input').value = '';
    runSearch('');
}

async function pageText(entry) {
    const cacheKey = `${entry.srcId}:${entry.index}`;
    if (textCache.has(cacheKey)) return textCache.get(cacheKey);
    const page = await getPdfPage(entry);
    const content = await page.getTextContent();
    const build = (norm) => {
        let text = '';
        const starts = [];
        for (const item of content.items) {
            if (item.str === undefined) continue;
            starts.push(text.length);
            text += norm(item.str) + (item.hasEOL ? ' ' : '');
        }
        return { text, starts };
    };
    const entryText = { strict: build(normalizeText), loose: build(looseText) };
    textCache.set(cacheKey, entryText);
    return entryText;
}

async function runSearch(rawQuery) {
    const my = ++token;
    results = [];
    current = -1;
    listPage = 0;
    clearAllMarks();
    if (!normalizeText(rawQuery).trim() || !state.pages.length) {
        setStatus('');
        renderList();
        return;
    }
    // Exact spelling first; if nothing matches, retry ignoring tone marks,
    // which many Thai PDFs lose when they are generated.
    for (const mode of ['strict', 'loose']) {
        const query = (mode === 'strict' ? normalizeText : looseText)(rawQuery).trim();
        if (mode === 'loose' && query === normalizeText(rawQuery).trim()) break;
        searchMode = mode;
        if (!(await collect(query, mode, my))) return;
        if (results.length) break;
    }
    const suffix = searchMode === 'loose' && results.length ? ' (ไม่สนวรรณยุกต์)' : '';
    setStatus(results.length ? `พบ ${results.length} ตำแหน่ง${suffix}` : 'ไม่พบข้อความนี้');
    renderList();
    if (results.length) goTo(0);
}

async function collect(query, mode, my) {
    for (let i = 0; i < state.pages.length; i++) {
        const entry = state.pages[i];
        const { text } = (await pageText(entry))[mode];
        if (my !== token) return false;
        let from = 0;
        let at;
        while ((at = text.indexOf(query, from)) !== -1) {
            results.push({ key: entry.key, start: at, end: at + query.length, snippet: makeSnippet(text, at, query.length) });
            from = at + query.length;
        }
        if (i % 20 === 19) {
            setStatus(`กำลังค้นหา… หน้า ${i + 1}/${state.pages.length}`);
            renderList();
        }
    }
    return true;
}

function makeSnippet(text, at, len) {
    const s = Math.max(0, at - 30);
    const e = Math.min(text.length, at + len + 30);
    return { before: (s > 0 ? '…' : '') + text.slice(s, at), match: text.slice(at, at + len), after: text.slice(at + len, e) + (e < text.length ? '…' : '') };
}

function pageIndexOf(key) {
    return state.pages.findIndex((p) => p.key === key);
}

function step(dir) {
    if (!results.length) return;
    goTo((current + dir + results.length) % results.length);
}

function goTo(i) {
    const prev = results[current];
    current = i;
    const hit = results[i];
    listPage = Math.floor(i / PAGE_SIZE);
    renderList();
    setStatus(`${i + 1} / ${results.length}`);
    if (prev && prev.key !== hit.key) {
        const pv = getView(prev.key);
        if (pv) applyMarks(pv);
    }
    pendingScroll = true;
    scrollToIndex(pageIndexOf(hit.key));
    const view = getView(hit.key);
    if (view && view.textLayer) applyMarks(view);
}

function itemRange(starts, start, end) {
    let first = 0;
    while (first + 1 < starts.length && starts[first + 1] <= start) first++;
    let last = first;
    while (last + 1 < starts.length && starts[last + 1] < end) last++;
    return [first, last];
}

function clearAllMarks() {
    document.querySelectorAll('.textLayer .search-hit').forEach((el) => el.classList.remove('search-hit', 'is-current'));
}

async function applyMarks(view) {
    if (!view.textLayer) return;
    const divs = view.textLayer.textDivs;
    divs.forEach((d) => d.classList.remove('search-hit', 'is-current'));
    const hits = results.filter((r) => r.key === view.entry.key);
    if (!hits.length) return;
    const { starts } = (await pageText(view.entry))[searchMode];
    let currentEl = null;
    for (const hit of hits) {
        const [a, b] = itemRange(starts, hit.start, hit.end);
        const isCurrent = results[current] === hit;
        for (let k = a; k <= b; k++) {
            const d = divs[k];
            if (!d) continue;
            d.classList.add('search-hit');
            if (isCurrent) {
                d.classList.add('is-current');
                currentEl ??= d;
            }
        }
    }
    if (currentEl && pendingScroll) {
        pendingScroll = false;
        currentEl.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
}

function setStatus(text) {
    $('search-status').textContent = text;
}

function renderList() {
    const list = $('search-results');
    const pager = $('search-pager');
    list.replaceChildren();
    pager.replaceChildren();
    const hasQuery = $('search-input').value.trim() !== '';
    $('search-empty').hidden = results.length > 0 || !hasQuery;
    if (!results.length) return;

    const pages = Math.ceil(results.length / PAGE_SIZE);
    listPage = Math.min(listPage, pages - 1);
    const from = listPage * PAGE_SIZE;
    results.slice(from, from + PAGE_SIZE).forEach((hit, n) => {
        const i = from + n;
        const li = document.createElement('li');
        li.dataset.hit = i;
        li.className = i === current ? 'is-current' : '';
        const pageNo = document.createElement('span');
        pageNo.className = 'hit-page';
        pageNo.textContent = `หน้า ${pageIndexOf(hit.key) + 1}`;
        const snip = document.createElement('span');
        snip.className = 'hit-snippet';
        const mark = document.createElement('mark');
        mark.textContent = hit.snippet.match;
        snip.append(hit.snippet.before, mark, hit.snippet.after);
        li.append(pageNo, snip);
        list.append(li);
    });

    if (pages > 1) renderPager(pager, pages);
}

function renderPager(pager, pages) {
    const btn = (label, target, disabled = false, active = false) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
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
