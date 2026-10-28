// What changed after a signature: compares the signed revision (the file up
// to the end of the signature's byte range) with the whole file, object by
// object. Later signatures and form/comment changes are allowed the way
// Acrobat allows them; anything that touches page content is not.
//
// pdf-lib parses object bodies in file order and later definitions replace
// earlier ones, so loading a prefix of the file yields exactly that revision.

import { loadPdfLib } from './save.js';

// Least to most serious.
const RANK = { none: 0, signed: 1, filled: 2, modified: 3 };
const worse = (a, b) => (RANK[b] > RANK[a] ? b : a);

// Catalog keys whose change does not alter what the pages show.
const CATALOG_FREE = new Set(['AcroForm', 'DSS', 'Perms', 'Metadata', 'Extensions']);
// Keys that point back up the tree (walking them would reach every page).
const BACK_KEYS = new Set(['Parent', 'P', 'Annots']);
const WALK_LIMIT = 50000;

const keyOf = (ref) => `${ref.objectNumber} ${ref.generationNumber}`;

function bytesOf(obj) {
    const buf = new Uint8Array(obj.sizeInBytes());
    obj.copyBytesInto(buf, 0);
    return buf;
}

function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

const same = (a, b) => sameBytes(bytesOf(a), bytesOf(b));

async function load(lib, bytes) {
    return lib.PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
}

function objects(doc) {
    const map = new Map();
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) map.set(keyOf(ref), obj);
    return map;
}

// [oldValue, newValue] of every key that differs, except the free ones.
function changedKeys(lib, a, b, free) {
    const names = new Set([...a.keys(), ...b.keys()].map((k) => k.decodeText()));
    const out = [];
    for (const name of names) {
        if (free.has(name)) continue;
        const key = lib.PDFName.of(name);
        const x = a.get(key);
        const y = b.get(key);
        if (!x || !y || !same(x, y)) out.push(name);
    }
    return out;
}

// Refs reachable from what the pages show, and from the catalog outside the
// form: a change to any of them changes the document itself.
function contentRefs(lib, doc) {
    const { PDFName, PDFDict, PDFArray, PDFRef, PDFStream } = lib;
    const seen = new Set();
    const pageNodes = new Set();
    const walk = (value) => {
        const stack = [value];
        while (stack.length && seen.size < WALK_LIMIT) {
            let v = stack.pop();
            if (v instanceof PDFRef) {
                const k = keyOf(v);
                if (seen.has(k) || pageNodes.has(k)) continue;
                seen.add(k);
                v = doc.context.lookup(v);
            }
            if (v instanceof PDFStream) v = v.dict;
            if (v instanceof PDFDict) {
                const type = v.get(PDFName.of('Type'));
                if (type === PDFName.of('Page') || type === PDFName.of('Pages')) continue;
                for (const [k, x] of v.entries()) if (!BACK_KEYS.has(k.decodeText())) stack.push(x);
            } else if (v instanceof PDFArray) {
                stack.push(...v.asArray());
            }
        }
    };
    const collectPages = (ref, depth = 0) => {
        if (!(ref instanceof PDFRef) || depth > 64 || pageNodes.has(keyOf(ref))) return;
        pageNodes.add(keyOf(ref));
        const node = doc.context.lookupMaybe(ref, PDFDict);
        const kids = node?.lookupMaybe(PDFName.of('Kids'), PDFArray);
        for (const kid of kids ? kids.asArray() : []) collectPages(kid, depth + 1);
    };
    const catalog = doc.catalog;
    collectPages(catalog.get(PDFName.of('Pages')));
    for (const k of pageNodes) {
        const [num, gen] = k.split(' ').map(Number);
        const node = doc.context.lookupMaybe(PDFRef.of(num, gen), PDFDict);
        if (!node) continue;
        for (const [name, v] of node.entries()) {
            if (!['Parent', 'Kids', 'Annots'].includes(name.decodeText())) walk(v);
        }
    }
    for (const [name, v] of catalog.entries()) {
        if (!CATALOG_FREE.has(name.decodeText()) && name.decodeText() !== 'Pages') walk(v);
    }
    return { content: seen, pageNodes };
}

function isSignatureThing(lib, ctx, dict) {
    const { PDFName, PDFDict } = lib;
    if (dict.get(PDFName.of('Type')) === PDFName.of('Sig')) return true;
    for (let d = dict, n = 0; d && n < 16; n++) {
        const ft = d.get(PDFName.of('FT'));
        if (ft) return ft === PDFName.of('Sig');
        d = d.lookupMaybe(PDFName.of('Parent'), PDFDict);
    }
    return false;
}

// A changed or added annotation / form field.
function kindOfDict(lib, ctx, value) {
    let dict = value instanceof lib.PDFRef ? ctx.lookup(value) : value;
    if (dict instanceof lib.PDFStream) dict = dict.dict;
    if (!(dict instanceof lib.PDFDict)) return 'filled';
    return isSignatureThing(lib, ctx, dict) ? 'signed' : 'filled';
}

function annotsChange(lib, ctx, oldArr, newArr) {
    const before = new Set((oldArr?.asArray() || []).map((r) => (r instanceof lib.PDFRef ? keyOf(r) : '')));
    const after = newArr?.asArray() || [];
    let kind = after.length < before.size ? 'filled' : 'none';
    for (const r of after) {
        if (r instanceof lib.PDFRef && before.has(keyOf(r))) continue;
        kind = worse(kind, kindOfDict(lib, ctx, r));
    }
    return kind;
}

// bytes: the whole file; ends: for each signature, where its revision ends
// (ranges[2] + ranges[3]). Returns 'none' | 'signed' | 'filled' | 'modified'
// per signature.
export async function changesAfter(bytes, ends) {
    const lib = await loadPdfLib();
    const doc = await load(lib, bytes);
    const now = objects(doc);
    const out = [];
    for (const end of ends) {
        if (end >= bytes.length) {
            out.push('none');
            continue;
        }
        let old;
        try {
            old = await load(lib, bytes.subarray(0, end));
        } catch {
            out.push('modified');
            continue;
        }
        out.push(compare(lib, old, doc, now));
    }
    return out;
}

function compare(lib, old, doc, now) {
    const { PDFName, PDFDict, PDFArray } = lib;
    const ctx = doc.context;
    // Pages added, removed or reordered.
    const oldPages = old.getPages().map((p) => keyOf(p.ref));
    const newPages = doc.getPages().map((p) => keyOf(p.ref));
    if (oldPages.join() !== newPages.join()) return 'modified';

    const { content, pageNodes } = contentRefs(lib, old);
    const ignore = new Set();
    for (const d of [old, doc]) {
        const info = d.context.trailerInfo.Info;
        if (info) ignore.add(keyOf(info));
        const meta = d.catalog.get(PDFName.of('Metadata'));
        if (meta instanceof lib.PDFRef) ignore.add(keyOf(meta));
    }
    const oldRoot = old.context.trailerInfo.Root;
    const newRoot = doc.context.trailerInfo.Root;
    const form = old.catalog.get(PDFName.of('AcroForm'));
    const formKey = form instanceof lib.PDFRef ? keyOf(form) : '';
    // Indirect /Annots arrays: key -> page node key.
    const annotsArrays = new Set();
    for (const k of pageNodes) {
        const [num, gen] = k.split(' ').map(Number);
        const a = old.context.lookupMaybe(lib.PDFRef.of(num, gen), PDFDict)?.get(PDFName.of('Annots'));
        if (a instanceof lib.PDFRef) annotsArrays.add(keyOf(a));
    }

    let kind = 'none';
    const catalogDiff = changedKeys(lib, old.catalog, doc.catalog, CATALOG_FREE);
    if (catalogDiff.length) return 'modified';
    if (keyOf(oldRoot) !== keyOf(newRoot) || !same(old.catalog, doc.catalog)) kind = 'signed';

    for (const [ref, before] of old.context.enumerateIndirectObjects()) {
        const k = keyOf(ref);
        if (ignore.has(k) || k === keyOf(oldRoot)) continue;
        const after = now.get(k);
        if (after && same(before, after)) continue;
        if (content.has(k)) return 'modified';
        if (pageNodes.has(k)) {
            if (!(after instanceof PDFDict) || !(before instanceof PDFDict)) return 'modified';
            const type = before.get(PDFName.of('Type'));
            const free = new Set(type === PDFName.of('Pages') ? [] : ['Annots']);
            if (changedKeys(lib, before, after, free).length) return 'modified';
            const oa = before.lookupMaybe(PDFName.of('Annots'), PDFArray);
            const na = after.lookupMaybe(PDFName.of('Annots'), PDFArray);
            if (!(before.get(PDFName.of('Annots')) instanceof lib.PDFRef)) kind = worse(kind, annotsChange(lib, ctx, oa, na));
            continue;
        }
        if (!after) {
            kind = worse(kind, 'filled');
            continue;
        }
        if (annotsArrays.has(k)) {
            kind = worse(kind, annotsChange(lib, ctx, before instanceof PDFArray ? before : null, after instanceof PDFArray ? after : null));
            continue;
        }
        if (k === formKey) {
            kind = worse(kind, 'signed');
            continue;
        }
        if (before instanceof lib.PDFRawStream || before instanceof PDFDict) {
            const dict = before instanceof PDFDict ? before : before.dict;
            const type = dict.get(PDFName.of('Type'));
            if (type === PDFName.of('XRef') || type === PDFName.of('ObjStm')) continue;
            kind = worse(kind, before instanceof PDFDict ? kindOfDict(lib, ctx, after) : 'filled');
            continue;
        }
        kind = worse(kind, 'filled');
    }
    return kind;
}
