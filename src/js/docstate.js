// Document model.
//
// A document is an ordered list of page entries, each pointing at a page of
// one of the loaded source PDFs. Merging adds a source; reordering, rotating
// and deleting only edit the list. Annotations hang off the page entry, so
// they travel with the page. Everything is applied to real PDF bytes only
// when saving (see save.js).
//
// Annotation geometry is stored in the source page's unrotated PDF user
// space, so it stays correct whatever the zoom or extra rotation.

import { emit } from './bus.js';

let nextId = 1;
const uid = (prefix) => `${prefix}${nextId++}`;

export const state = {
    sources: new Map(), // id -> { id, name, bytes, pdf }
    pages: [], // { key, srcId, index, rotation }
    annots: new Map(), // page key -> [annotation]
    filePath: null,
    fileName: null,
    dirty: false,
};

export function resetDocument() {
    for (const src of state.sources.values()) src.pdf.loadingTask.destroy();
    state.sources.clear();
    state.pages = [];
    state.annots.clear();
    state.filePath = null;
    state.fileName = null;
    setDirty(false);
}

export function hasDocument() {
    return state.pages.length > 0;
}

export function addSource({ name, bytes, pdf }, insertAt = state.pages.length) {
    const id = uid('s');
    state.sources.set(id, { id, name, bytes, pdf, fieldObjects: null });
    const entries = [];
    for (let i = 0; i < pdf.numPages; i++) {
        entries.push({ key: uid('p'), srcId: id, index: i, rotation: 0 });
    }
    state.pages.splice(insertAt, 0, ...entries);
    return entries;
}

// Swap a source's bytes/document (e.g. after OCR added a text layer).
// Page entries and annotations stay as they are.
export function replaceSource(srcId, { bytes, pdf }) {
    const src = state.sources.get(srcId);
    const old = src.pdf;
    src.bytes = bytes;
    src.pdf = pdf;
    src.fieldObjects = null;
    setDirty(true);
    emit('source-replaced', srcId);
    old.loadingTask.destroy();
}

export function getPdfPage(entry) {
    return state.sources.get(entry.srcId).pdf.getPage(entry.index + 1);
}

export function setDirty(dirty) {
    state.dirty = dirty;
    emit('dirty-changed', dirty);
}

export function pagesChanged() {
    setDirty(true);
    emit('pages-changed');
}

export function movePage(fromIdx, toIdx) {
    if (fromIdx === toIdx) return;
    const [entry] = state.pages.splice(fromIdx, 1);
    state.pages.splice(toIdx, 0, entry);
    pagesChanged();
}

export function rotatePage(idx, delta) {
    rotatePages([idx], delta);
}

// One pages-changed for the whole batch, so the viewer rebuilds once.
export function rotatePages(indices, delta) {
    for (const idx of indices) {
        const entry = state.pages[idx];
        entry.rotation = (((entry.rotation + delta) % 360) + 360) % 360;
    }
    pagesChanged();
}

export function deletePage(idx) {
    if (state.pages.length <= 1) return false;
    const [entry] = state.pages.splice(idx, 1);
    state.annots.delete(entry.key);
    pagesChanged();
    return true;
}

export function annotsFor(key) {
    return state.annots.get(key) || [];
}

export function addAnnot(key, annot) {
    const list = state.annots.get(key) || [];
    annot.id = uid('a');
    list.push(annot);
    state.annots.set(key, list);
    setDirty(true);
    emit('annots-changed', key);
    return annot;
}

export function updateAnnot(key, id, patch) {
    const annot = annotsFor(key).find((a) => a.id === id);
    if (!annot) return;
    Object.assign(annot, patch);
    setDirty(true);
    emit('annots-changed', key);
}

export function removeAnnot(key, id) {
    const list = annotsFor(key).filter((a) => a.id !== id);
    state.annots.set(key, list);
    setDirty(true);
    emit('annots-changed', key);
}
