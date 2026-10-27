// Renderer entry point: wires the toolbar, keyboard and file handling to
// the viewer, annotation, search and save modules.

import { on } from './bus.js';
import { loadPdf, pdfjsLib, passwordOf } from './pdfjs.js';
import { state, resetDocument, addSource, hasDocument, setDirty, pagesChanged } from './docstate.js';
import { initViewer, rebuild, clearViewer, setZoom, zoomIn, zoomOut, scrollToIndex, currentPageIndex } from './viewer.js';
import { initAnnotate, setTool, setHighlightColor } from './annotate.js';
import { initSearch, focusSearch, resetSearch } from './search.js';
import { initThumbs, resetThumbs } from './thumbs.js';
import { initSignature, openSignatureDialog } from './signature.js';
import { askPassword, confirmDialog, progressDialog, toast } from './dialog.js';
import { buildPdf, willRewriteFile } from './save.js';
import { cleanCopiedText } from './thai.js';
import { initUpdateNotice } from './update.js';
import { resetLinkServices } from './links.js';
import { recognizeText } from './recognize.js';
import { pageHasText } from './ocr.js';
import { extractPages, splitDocument } from './extract.js';
import { headerFooter, watermark } from './stamp.js';
import { reduceFileSize } from './compress.js';
import { initProtect, protectDocument, removeSecurity } from './protect.js';
import { applyRedactions, pendingRedactions } from './redact.js';
import { CONVERTIBLE, filesToPdfs, exportWord, exportImages, exportText } from './convert.js';
import { initSignatures, checkSignatures, hasSignatures } from './signatures.js';
import { initCertSign, startCertSign } from './certsign.js';
import { initCompare, compareFiles, clearCompare } from './compare.js';
import { initEditMode, startEditTool, addImage, undoEdit } from './editmode.js';

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
    bindFormEdits(scroller);
    initUpdateNotice();
    initProtect();
    initSignatures();
    initCertSign((file) => openFile(file, { force: true }));
    initCompare();
    initEditMode(scroller);

    on('dirty-changed', updateTitle);
    for (const event of ['annots-changed', 'pages-changed', 'source-replaced']) on(event, updateRedactButton);
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
        okLabel: 'Discard',
    });
}

// Bumped by every open; a load that finishes after a newer open started
// is dropped instead of replacing the newer document.
let openSeq = 0;

// password: known password to try first (after Protect re-opens the file).
async function openFile(file, { password = null, force = false } = {}) {
    if (!force && !(await confirmDiscard())) return;
    const seq = ++openSeq;
    setBusy(true);
    try {
        const ask = password ? async (retry) => (retry ? askPassword(true) : password) : askPassword;
        const pdf = await loadPdf(file.data, ask);
        if (seq !== openSeq) {
            pdf.loadingTask.destroy();
            return;
        }
        resetDocument();
        resetLinkServices();
        clearViewer();
        resetThumbs();
        resetSearch();
        clearCompare();
        addSource({ name: file.name, bytes: file.data, pdf });
        state.filePath = file.path;
        state.fileName = file.name;
        setTool('select');
        updateRedactButton();
        await rebuild();
        scrollToIndex(0);
        updateUi();
        announceDocument(pdf);
        checkSignatures().catch((err) => console.warn('signature check failed', err));
    } catch (err) {
        if (seq === openSeq) reportLoadError(err, file.name);
    } finally {
        if (seq === openSeq) setBusy(false);
    }
}

// One hint on open: fillable form, or scanned pages that need OCR.
async function announceDocument(pdf) {
    const fields = await pdf.getFieldObjects().catch(() => null);
    if (fields && Object.keys(fields).length) {
        toast('เอกสารนี้มีฟอร์ม คลิกที่ช่องเพื่อกรอก แล้วกด Ctrl+S เพื่อบันทึก');
    } else if (state.pages.length && !(await pageHasText(state.pages[0]).catch(() => true))) {
        toast('ไฟล์นี้เป็นภาพสแกน กดปุ่ม OCR เพื่อให้ค้นหาและคัดลอกข้อความได้');
    }
}

// Picked or dropped files (PDF, Office, images) -> PDF bytes, or null.
async function convertPaths(paths, title) {
    const progress = progressDialog(title);
    try {
        return await filesToPdfs(paths, progress);
    } finally {
        progress.close();
    }
}

// File > Create PDF: the files become one new, unsaved document.
async function createPdf(paths = null) {
    paths ??= await window.host.convertPick({ multiple: true });
    if (!paths.length || !(await confirmDiscard())) return;
    const pdfs = await convertPaths(paths, 'Create PDF');
    if (!pdfs?.length) return;
    const [first, ...rest] = pdfs;
    await openFile({ path: null, name: first.name, data: first.data }, { force: true });
    if (!hasDocument() || state.fileName !== first.name) return;
    if (rest.length) await appendPdfs(rest);
    setDirty(true);
    toast(`สร้าง PDF แล้ว ${state.pages.length} หน้า กด Save เพื่อบันทึก`);
}

async function appendPdfs(pdfs) {
    for (const { name, data } of pdfs) {
        const pdf = await loadPdf(data, askPassword);
        addSource({ name, bytes: data, pdf });
    }
    pagesChanged();
}

async function mergeFiles() {
    if (!hasDocument()) return createPdf();
    const paths = await window.host.convertPick({ multiple: true });
    if (!paths.length) return;
    setBusy(true);
    try {
        const pdfs = await convertPaths(paths, 'Combine Files');
        if (!pdfs?.length) return;
        await appendPdfs(pdfs);
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
    if (pendingRedactions().marks) {
        // Saving marks without applying them would leave the content in the file.
        const apply = await confirmDialog({
            title: 'ยังไม่ได้ลบเนื้อหาที่ทำเครื่องหมาย Redact',
            message: 'กรอบ Redact ยังไม่ได้ลบเนื้อหาจริง ต้องกด Apply Redactions ก่อนบันทึก',
            okLabel: 'Apply Redactions',
        });
        if (!apply || !(await applyRedactions())) return;
    }
    if (hasSignatures() && willRewriteFile()) {
        const go = await confirmDialog({
            title: 'เอกสารนี้มีลายเซ็นดิจิทัล',
            message: 'การแก้ไขนี้ (เช่น ไฮไลต์ จัดหน้า โน้ต) จะทำให้ลายเซ็นดิจิทัลในไฟล์ที่บันทึกใช้ไม่ได้ ถ้าต้องการเก็บไฟล์ที่เซ็นแล้วไว้ ให้ใช้ Save As เป็นไฟล์ใหม่',
            okLabel: 'Save Anyway',
        });
        if (!go) return;
    }
    setBusy(true);
    try {
        const { data, warnings } = await buildPdf();
        const saved = await window.host.save({
            data,
            filePath: asNew ? null : state.filePath,
            suggestedName: state.fileName,
        });
        if (!saved) return;
        state.filePath = saved.path;
        state.fileName = saved.name;
        setDirty(false);
        if (warnings.length) toast(`บันทึกแล้ว แต่ ${warnings.join(' / ')}`, 'error');
        else toast(`บันทึกแล้ว: ${saved.name}`);
    } catch (err) {
        console.error(err);
        toast(`บันทึกไม่สำเร็จ: ${err?.message || err}`, 'error');
    } finally {
        setBusy(false);
    }
}

async function printDocument() {
    const [first] = state.sources.values();
    // null when unrestricted; an array or Set of PermissionFlag values otherwise.
    const perms = await first.pdf.getPermissions().catch(() => null);
    if (perms && ![...perms].includes(pdfjsLib.PermissionFlag.PRINT)) {
        toast('เจ้าของเอกสารไม่อนุญาตให้พิมพ์ไฟล์นี้', 'error');
        return;
    }
    setBusy(true);
    toast('กำลังเตรียมพิมพ์…');
    try {
        // Print exactly what Save would write: forms, highlights, signatures.
        const { data } = await buildPdf();
        const result = await window.host.print({ data, password: passwordOf(first.pdf), title: state.fileName });
        if (!result.ok && !result.cancelled) toast(`พิมพ์ไม่สำเร็จ: ${result.error || ''}`, 'error');
    } catch (err) {
        console.error(err);
        toast(`พิมพ์ไม่สำเร็จ: ${err?.message || err}`, 'error');
    } finally {
        setBusy(false);
    }
}

// ---- UI ---------------------------------------------------------------

function updateTitle() {
    const name = state.fileName ? `${state.dirty ? '● ' : ''}${state.fileName} — ` : '';
    // Electron mirrors document.title into the window title.
    document.title = `${name}${APP_NAME}`;
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

function updateRedactButton() {
    $('apply-redactions').hidden = !pendingRedactions().marks;
}

function setBusy(busy) {
    document.body.classList.toggle('is-busy', busy);
}

// Commands shared by toolbar buttons (data-action) and the app menu.
// Those in DOC_COMMANDS do nothing until a document is open.
const actions = {
    open: openDialog,
    merge: mergeFiles,
    'create-pdf': () => createPdf(),
    'export-docx': exportWord,
    'export-images': exportImages,
    'export-text': exportText,
    save: () => save(false),
    'save-as': () => save(true),
    print: printDocument,
    find: () => {
        showPanel('search');
        focusSearch();
    },
    'zoom-in': zoomIn,
    'zoom-out': zoomOut,
    'fit-width': () => setZoom('width'),
    'fit-page': () => setZoom('page'),
    'prev-page': () => scrollToIndex(currentPageIndex() - 1),
    'next-page': () => scrollToIndex(currentPageIndex() + 1),
    'first-page': () => scrollToIndex(0),
    'last-page': () => scrollToIndex(state.pages.length - 1),
    signature: openSignatureDialog,
    'cert-sign': startCertSign,
    'tool-edit': () => startEditTool('edit'),
    'tool-addtext': () => startEditTool('addtext'),
    'add-image': addImage,
    undo: () => undoEdit().then((done) => done || toast('ไม่มีการแก้ไขข้อความ/รูปให้ย้อนกลับ')),
    compare: compareFiles,
    'show-signatures': () => showPanel('signatures'),
    'show-compare': () => showPanel('compare'),
    ocr: recognizeText,
    extract: extractPages,
    split: splitDocument,
    'page-numbers': () => headerFooter({ pageNumbers: true }),
    'header-footer': () => headerFooter(),
    watermark,
    compress: reduceFileSize,
    protect: () => protectDocument((file, password) => openFile(file, { password, force: true })),
    'remove-security': removeSecurity,
    'apply-redactions': async () => {
        if (await applyRedactions()) setTool('select');
    },
    'tool-redact': () => setTool('redact'),
    'tool-select': () => setTool('select'),
    'tool-highlight': () => setTool('highlight'),
    'tool-note': () => setTool('note'),
    'tool-eraser': () => setTool('eraser'),
    'toggle-sidebar': () => document.body.classList.toggle('sidebar-hidden'),
    'show-thumbs': () => showPanel('thumbs'),
    'show-search': () => {
        showPanel('search');
        focusSearch();
    },
};
const ALWAYS_AVAILABLE = new Set(['open', 'toggle-sidebar', 'create-pdf']);

function runCommand(name) {
    if (!actions[name]) return;
    if (!ALWAYS_AVAILABLE.has(name) && !hasDocument()) return;
    actions[name]();
}

function bindToolbar() {
    window.host.onMenuCommand(runCommand);
    document.addEventListener('click', (e) => {
        // Buttons only: <body data-tool> carries the current tool and must not
        // count as a click on a tool button.
        const btn = e.target.closest('button');
        if (!btn || !btn.matches('[data-action], [data-tool], [data-color]') || btn.disabled || btn.closest('#thumbs')) return;
        if (btn.dataset.action && actions[btn.dataset.action]) runCommand(btn.dataset.action);
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
        } else if (ctrl && e.key.toLowerCase() === 'p') {
            e.preventDefault();
            runCommand('print');
        } else if (ctrl && e.key.toLowerCase() === 'f') {
            e.preventDefault();
            runCommand('find');
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

// A form edit by the user marks the document as changed. (pdf.js'
// annotationStorage.onSetModified can't be used: rendering a form already
// writes default radio values into storage, so merely opening a form would
// look like an edit.)
function bindFormEdits(scroller) {
    const markDirty = (e) => {
        if (e.target.closest('.annotationLayer')) setDirty(true);
    };
    scroller.addEventListener('input', markDirty);
    scroller.addEventListener('change', markDirty);
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
        const files = [...e.dataTransfer.files].filter((f) => CONVERTIBLE.test(f.name));
        if (!files.length) {
            toast('รองรับไฟล์ PDF, Word, Excel, PowerPoint และรูปภาพ', 'error');
            return;
        }
        // A single PDF opens as it is; anything else is converted first.
        if (files.length === 1 && /\.pdf$/i.test(files[0].name)) {
            const loaded = await window.host.readFile(window.host.pathForFile(files[0]));
            if (loaded) openFile(loaded);
            return;
        }
        createPdf(files.map((f) => window.host.pathForFile(f)));
    });
}

init();
