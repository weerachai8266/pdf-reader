// Renderer entry point: wires the toolbar, keyboard and file handling to
// the viewer, annotation, search and save modules.

import { on } from './bus.js';
import { loadPdf } from './pdfjs.js';
import { state, resetDocument, addSource, hasDocument, setDirty, pagesChanged } from './docstate.js';
import { initViewer, rebuild, clearViewer, setZoom, zoomIn, zoomOut, scrollToIndex, currentPageIndex } from './viewer.js';
import { initAnnotate, setTool, setHighlightColor } from './annotate.js';
import { initSearch, focusSearch, resetSearch } from './search.js';
import { initThumbs, resetThumbs } from './thumbs.js';
import { initSignature, openSignatureDialog } from './signature.js';
import { askPassword, confirmDialog, toast } from './dialog.js';
import { buildPdf } from './save.js';
import { cleanCopiedText } from './thai.js';

const $ = (id) => document.getElementById(id);
const APP_NAME = 'PDF Reader';

async function init() {
    const scroller = $('viewer');
    initViewer(scroller, $('pages'));
    initAnnotate(scroller);
    initSearch();
    initThumbs();
    initSignature();
    bindToolbar();
    bindKeyboard(scroller);
    bindDragDrop();
    bindCopy();

    on('dirty-changed', updateTitle);
    on('current-page', (idx) => {
        $('page-input').value = idx + 1;
    });
    on('zoom-changed', ({ zoom, mode }) => {
        const select = $('zoom-select');
        const custom = select.querySelector('[data-custom]');
        if (mode === 'width' || mode === 'page') {
            select.value = mode;
        } else {
            custom.value = String(zoom);
            custom.textContent = `${Math.round(zoom * 100)}%`;
            select.value = String(zoom);
        }
    });
    on('tool-changed', (tool) => {
        document.querySelectorAll('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === tool)));
    });

    $('app-version').textContent = `v${await window.host.version()}`;
    window.host.onFileOpened((file) => openFile(file));
    const pending = await window.host.pendingFile();
    if (pending) openFile(pending);
    updateUi();
}

// ---- files ------------------------------------------------------------

async function confirmDiscard() {
    if (!state.dirty) return true;
    return confirmDialog({
        title: 'ยังไม่ได้บันทึก',
        message: 'เอกสารนี้มีการแก้ไขที่ยังไม่ได้บันทึก ต้องการทิ้งการแก้ไขหรือไม่?',
        okLabel: 'ทิ้งการแก้ไข',
    });
}

async function openFile(file) {
    if (!(await confirmDiscard())) return;
    setBusy(true);
    try {
        const pdf = await loadPdf(file.data, askPassword);
        resetDocument();
        clearViewer();
        resetThumbs();
        resetSearch();
        addSource({ name: file.name, bytes: file.data, pdf });
        state.filePath = file.path;
        state.fileName = file.name;
        setTool('select');
        await rebuild();
        scrollToIndex(0);
        updateUi();
    } catch (err) {
        reportLoadError(err, file.name);
    } finally {
        setBusy(false);
    }
}

async function mergeFiles() {
    if (!hasDocument()) return openDialog();
    const files = await window.host.openDialog({ multiple: true });
    if (!files.length) return;
    setBusy(true);
    try {
        for (const file of files) {
            const pdf = await loadPdf(file.data, askPassword);
            addSource({ name: file.name, bytes: file.data, pdf });
        }
        pagesChanged();
        toast(`รวมไฟล์แล้ว ทั้งหมด ${state.pages.length} หน้า`);
    } catch (err) {
        reportLoadError(err);
    } finally {
        setBusy(false);
    }
}

function reportLoadError(err, name = '') {
    if (err?.name === 'PasswordException' || err?.message?.includes('Worker was destroyed')) return;
    console.error(err);
    toast(`เปิดไฟล์ ${name} ไม่ได้: ${err?.message || err}`, 'error');
}

async function openDialog() {
    const [file] = await window.host.openDialog({ multiple: false });
    if (file) openFile(file);
}

async function save(asNew) {
    if (!hasDocument()) return;
    setBusy(true);
    try {
        const data = await buildPdf();
        const saved = await window.host.save({
            data,
            filePath: asNew ? null : state.filePath,
            suggestedName: state.fileName,
        });
        if (!saved) return;
        state.filePath = saved.path;
        state.fileName = saved.name;
        setDirty(false);
        toast(`บันทึกแล้ว: ${saved.name}`);
    } catch (err) {
        console.error(err);
        toast(`บันทึกไม่สำเร็จ: ${err?.message || err}`, 'error');
    } finally {
        setBusy(false);
    }
}

// ---- UI ---------------------------------------------------------------

function updateTitle() {
    const name = state.fileName ? `${state.dirty ? '● ' : ''}${state.fileName} — ` : '';
    window.host.setTitle(`${name}${APP_NAME}`);
    $('file-name').textContent = state.fileName || 'ยังไม่ได้เปิดไฟล์';
}

function updateUi() {
    const has = hasDocument();
    document.body.classList.toggle('has-doc', has);
    $('empty-state').hidden = has;
    document.querySelectorAll('[data-needs-doc]').forEach((el) => {
        el.disabled = !has;
    });
    updateTitle();
}

function setBusy(busy) {
    document.body.classList.toggle('is-busy', busy);
}

function bindToolbar() {
    const actions = {
        open: openDialog,
        merge: mergeFiles,
        save: () => save(false),
        'save-as': () => save(true),
        'zoom-in': zoomIn,
        'zoom-out': zoomOut,
        'prev-page': () => scrollToIndex(currentPageIndex() - 1),
        'next-page': () => scrollToIndex(currentPageIndex() + 1),
        signature: openSignatureDialog,
        'toggle-sidebar': () => document.body.classList.toggle('sidebar-hidden'),
        'show-thumbs': () => showPanel('thumbs'),
        'show-search': () => {
            showPanel('search');
            focusSearch();
        },
    };
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action], [data-tool], [data-color]');
        if (!btn || btn.disabled || btn.closest('#thumbs')) return;
        if (btn.dataset.action && actions[btn.dataset.action]) actions[btn.dataset.action]();
        else if (btn.dataset.tool) setTool(btn.dataset.tool);
        else if (btn.dataset.color) {
            document.querySelectorAll('[data-color]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
            setHighlightColor(btn.dataset.color);
        }
    });
    // Keep the text selection alive when a toolbar button is pressed, so
    // "select text, then click a highlight colour" works.
    $('toolbar').addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) e.preventDefault();
    });
    $('zoom-select').addEventListener('change', (e) => setZoom(e.target.value));
    $('page-input').addEventListener('change', (e) => {
        scrollToIndex(Number(e.target.value) - 1);
    });
}

function showPanel(name) {
    document.body.classList.remove('sidebar-hidden');
    document.querySelectorAll('[data-panel]').forEach((p) => {
        p.hidden = p.dataset.panel !== name;
    });
    document.querySelectorAll('[data-panel-tab]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.panelTab === name)));
}

function bindKeyboard(scroller) {
    document.addEventListener('keydown', (e) => {
        const ctrl = e.ctrlKey || e.metaKey;
        const typing = e.target.closest('input, textarea, select');
        if (ctrl && e.key.toLowerCase() === 'o') {
            e.preventDefault();
            openDialog();
        } else if (ctrl && e.key.toLowerCase() === 's') {
            e.preventDefault();
            save(e.shiftKey);
        } else if (ctrl && e.key.toLowerCase() === 'f') {
            e.preventDefault();
            if (hasDocument()) {
                showPanel('search');
                focusSearch();
            }
        } else if (ctrl && (e.key === '=' || e.key === '+')) {
            e.preventDefault();
            zoomIn();
        } else if (ctrl && e.key === '-') {
            e.preventDefault();
            zoomOut();
        } else if (ctrl && e.key === '0') {
            e.preventDefault();
            setZoom('width');
        } else if (!typing && !ctrl && hasDocument()) {
            if (e.key === 'ArrowRight') {
                scrollToIndex(currentPageIndex() + 1);
            } else if (e.key === 'ArrowLeft') {
                scrollToIndex(currentPageIndex() - 1);
            } else if (e.key === 'Home') {
                scrollToIndex(0);
            } else if (e.key === 'End') {
                scrollToIndex(state.pages.length - 1);
            } else if (e.key === 'h') {
                setTool('highlight');
            } else if (e.key === 'n') {
                setTool('note');
            } else if (e.key === 'v') {
                setTool('select');
            }
        }
    });
    scroller.addEventListener('wheel', (e) => {
        if (!e.ctrlKey || !hasDocument()) return;
        e.preventDefault();
        if (e.deltaY < 0) zoomIn();
        else zoomOut();
    }, { passive: false });
}

// Copying from the text layer: fix SARA AM, strip stray NULs and
// zero-width characters that broken Thai PDFs carry.
function bindCopy() {
    document.addEventListener('copy', (e) => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.anchorNode?.parentElement?.closest('.textLayer')) return;
        e.clipboardData.setData('text/plain', cleanCopiedText(sel.toString()));
        e.preventDefault();
    });
}

function bindDragDrop() {
    const hasFiles = (e) => [...e.dataTransfer.types].includes('Files');
    document.addEventListener('dragover', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        document.body.classList.add('is-dropping');
    });
    document.addEventListener('dragleave', (e) => {
        if (!e.relatedTarget) document.body.classList.remove('is-dropping');
    });
    document.addEventListener('drop', async (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        document.body.classList.remove('is-dropping');
        const file = [...e.dataTransfer.files].find((f) => f.name.toLowerCase().endsWith('.pdf'));
        if (!file) {
            toast('รองรับเฉพาะไฟล์ .pdf', 'error');
            return;
        }
        const loaded = await window.host.readFile(window.host.pathForFile(file));
        if (loaded) openFile(loaded);
    });
}

init();
