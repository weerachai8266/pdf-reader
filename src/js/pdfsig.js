// PDF plumbing for certificate signatures: find existing signatures, and
// append a new signature field as an incremental update.
//
// An incremental update leaves every byte of the existing file untouched
// and appends only new or changed objects plus a new cross-reference
// section, so earlier signatures stay valid (the same way Acrobat signs).

import { loadPdfLib } from './save.js';

// Bytes reserved for the CMS signature (hex-encoded in the file: x2).
// Enough for RSA-4096 with a few chain certificates.
const SIG_BYTES = 16384;
const RANGE_PLACEHOLDER = '1111111111';

const enc = new TextEncoder();
const ascii = (s) => enc.encode(s);

function concat(parts) {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    return out;
}

function indexOfBytes(hay, needle, from = 0) {
    outer: for (let i = from; i <= hay.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
        return i;
    }
    return -1;
}

function lastIndexOfBytes(hay, needle) {
    outer: for (let i = hay.length - needle.length; i >= 0; i--) {
        for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
        return i;
    }
    return -1;
}

function serialize(obj) {
    const buf = new Uint8Array(obj.sizeInBytes());
    obj.copyBytesInto(buf, 0);
    return buf;
}

// ---- finding signatures ----------------------------------------------------------

function textOf(lib, value) {
    if (value instanceof lib.PDFString || value instanceof lib.PDFHexString) return value.decodeText();
    return '';
}

// [{ name, ranges, contents, reason, location, signerName, time, pageIndex, rect }]
export async function findSignatures(bytes) {
    const lib = await loadPdfLib();
    let doc;
    try {
        doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
    } catch {
        return []; // encrypted or unreadable: nothing we can verify
    }
    const { PDFName, PDFDict, PDFArray, PDFNumber, PDFRef } = lib;
    const catalogForm = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
    if (!catalogForm) return [];
    const pages = doc.getPages();
    const pageIndexOf = (ref) => pages.findIndex((p) => p.ref === ref);
    const out = [];
    const walk = (fieldRefOrDict, parentName = '') => {
        const field = fieldRefOrDict instanceof PDFRef ? doc.context.lookupMaybe(fieldRefOrDict, PDFDict) : fieldRefOrDict;
        if (!field) return;
        const partial = textOf(lib, field.lookup(PDFName.of('T')));
        const name = parentName && partial ? `${parentName}.${partial}` : partial || parentName;
        const kids = field.lookupMaybe(PDFName.of('Kids'), PDFArray);
        const ft = field.lookup(PDFName.of('FT'));
        const v = field.lookup(PDFName.of('V'));
        if (ft === PDFName.of('Sig') && v instanceof PDFDict) {
            const br = v.lookupMaybe(PDFName.of('ByteRange'), PDFArray);
            const contents = v.lookup(PDFName.of('Contents'));
            if (br && br.size() === 4 && contents) {
                const widget = kids ? kids.lookupMaybe(0, PDFDict) : field;
                const rect = widget?.lookupMaybe(PDFName.of('Rect'), PDFArray);
                const pref = widget?.get(PDFName.of('P'));
                let pageIndex = pref instanceof PDFRef ? pageIndexOf(pref) : -1;
                if (pageIndex < 0 && widget) {
                    const wref = kids ? kids.get(0) : fieldRefOrDict;
                    pageIndex = pages.findIndex((p) => p.node.Annots()?.asArray().some((a) => a === wref));
                }
                out.push({
                    name,
                    ranges: br.asArray().map((n) => (n instanceof PDFNumber ? n.asNumber() : 0)),
                    contents: contents.asBytes(),
                    reason: textOf(lib, v.lookup(PDFName.of('Reason'))),
                    location: textOf(lib, v.lookup(PDFName.of('Location'))),
                    signerName: textOf(lib, v.lookup(PDFName.of('Name'))),
                    pageIndex,
                    rect: rect ? rect.asArray().map((n) => n.asNumber?.() ?? 0) : null,
                });
            }
        }
        if (kids && ft !== PDFName.of('Sig')) for (const kid of kids.asArray()) walk(kid, name);
    };
    const fields = catalogForm.lookupMaybe(PDFName.of('Fields'), PDFArray);
    for (const ref of fields ? fields.asArray() : []) walk(ref);
    // Oldest first: the earlier a signature, the shorter its byte range.
    return out.sort((a, b) => a.ranges[2] + a.ranges[3] - (b.ranges[2] + b.ranges[3]));
}

// ---- signing ------------------------------------------------------------------------

function pdfDate(d) {
    const pad = (n) => String(Math.abs(n)).padStart(2, '0');
    const tz = -d.getTimezoneOffset();
    return `D:${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${tz >= 0 ? '+' : '-'}${pad(Math.trunc(tz / 60))}'${pad(tz % 60)}'`;
}

// Appearance lines, drawn upright for the page's rotation.
function appearanceStream(lib, doc, font, { width, height, rotation, lines }) {
    const swap = rotation % 180 !== 0;
    const vw = swap ? height : width;
    const vh = swap ? width : height;
    const pad = Math.min(vw, vh) * 0.08;
    const longest = Math.max(...lines.map((l) => font.widthOfTextAtSize(l.text, 1) * (l.scale || 1)));
    const totalScale = lines.reduce((n, l) => n + (l.scale || 1), 0);
    const size = Math.max(4, Math.min((vh - 2 * pad) / (totalScale * 1.25), (vw - 2 * pad) / longest));
    const ops = [lib.pushGraphicsState()];
    // Thin frame, like Acrobat's.
    ops.push(lib.setStrokingRgbColor(0.55, 0.6, 0.68), lib.setLineWidth(0.6), lib.rectangle(0.5, 0.5, vw - 1, vh - 1), lib.stroke());
    let y = vh - pad;
    for (const line of lines) {
        const s = size * (line.scale || 1);
        y -= s * 1.05;
        ops.push(
            lib.beginText(),
            lib.setFillingRgbColor(...(line.color || [0.1, 0.1, 0.1])),
            lib.setFontAndSize('F1', s),
            lib.moveText(pad, y),
            lib.showText(font.encodeText(line.text)),
            lib.endText(),
        );
        y -= s * 0.2;
    }
    ops.push(lib.popGraphicsState());
    const matrix = { 0: [1, 0, 0, 1, 0, 0], 90: [0, 1, -1, 0, 0, 0], 180: [-1, 0, 0, -1, 0, 0], 270: [0, -1, 1, 0, 0, 0] }[rotation] || [1, 0, 0, 1, 0, 0];
    return doc.context.formXObject(ops, {
        BBox: [0, 0, vw, vh],
        Matrix: matrix,
        Resources: { Font: { F1: font.ref } },
    });
}

// Adds a signature field (visible when rect is given) as an incremental
// update and returns { data, ranges, contentsStart, contentsEnd }:
// data with a zero-filled /Contents for the CMS signature.
export async function prepareSignature(bytes, { pageIndex, rect, signerName, reason, location, embedFont }) {
    const lib = await loadPdfLib();
    const { PDFName, PDFDict, PDFArray, PDFHexString, PDFRef } = lib;
    const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
    const ctx = doc.context;
    const firstNew = ctx.largestObjectNumber + 1;

    // Objects that may change; compared before/after to find what to write.
    const page = doc.getPages()[pageIndex];
    const candidates = new Set([ctx.trailerInfo.Root, page.ref]);
    const formRef = doc.catalog.get(PDFName.of('AcroForm'));
    if (formRef instanceof PDFRef) {
        candidates.add(formRef);
        const fieldsRef = ctx.lookup(formRef, PDFDict).get(PDFName.of('Fields'));
        if (fieldsRef instanceof PDFRef) candidates.add(fieldsRef);
    }
    const annotsRef = page.node.get(PDFName.of('Annots'));
    if (annotsRef instanceof PDFRef) candidates.add(annotsRef);
    const before = new Map([...candidates].filter(Boolean).map((ref) => [ref, serialize(ctx.lookup(ref))]));

    // Unique field name: Signature1, Signature2, …
    const form = doc.getForm();
    const names = new Set(form.getFields().map((f) => f.getName()));
    let n = 1;
    while (names.has(`Signature${n}`)) n++;
    const now = new Date();

    const sigDict = ctx.obj({
        Type: 'Sig',
        Filter: 'Adobe.PPKLite',
        SubFilter: 'adbe.pkcs7.detached',
        ByteRange: [0, Number(RANGE_PLACEHOLDER), Number(RANGE_PLACEHOLDER), Number(RANGE_PLACEHOLDER)],
        Contents: PDFHexString.of('0'.repeat(SIG_BYTES * 2)),
        M: lib.PDFString.of(pdfDate(now)),
        Name: PDFHexString.fromText(signerName),
        ...(reason ? { Reason: PDFHexString.fromText(reason) } : {}),
        ...(location ? { Location: PDFHexString.fromText(location) } : {}),
    });
    const sigRef = ctx.register(sigDict);

    const widget = {
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Sig',
        T: PDFHexString.fromText(`Signature${n}`),
        V: sigRef,
        F: 132, // Print + Locked
        P: page.ref,
        Rect: rect || [0, 0, 0, 0],
    };
    if (rect) {
        const font = await embedFont(doc);
        const width = Math.abs(rect[2] - rect[0]);
        const height = Math.abs(rect[3] - rect[1]);
        const when = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'medium' }).format(now);
        const lines = [
            { text: signerName, scale: 1.6, color: [0.05, 0.1, 0.3] },
            { text: `ลงนามดิจิทัลโดย ${signerName}` },
            { text: `วันที่ ${when}` },
            ...(reason ? [{ text: `เหตุผล ${reason}` }] : []),
            ...(location ? [{ text: `สถานที่ ${location}` }] : []),
        ];
        const ap = appearanceStream(lib, doc, font, { width, height, rotation: page.getRotation().angle % 360, lines });
        widget.AP = { N: ctx.register(ap) };
    }
    const widgetRef = ctx.register(ctx.obj(widget));
    page.node.addAnnot(widgetRef);
    form.acroForm.addField(widgetRef);
    form.acroForm.dict.set(PDFName.of('SigFlags'), ctx.obj(3));
    await doc.flush(); // embeds the font subset

    // Collect new and changed objects.
    const write = [];
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
        if (ref.objectNumber >= firstNew) write.push([ref, obj]);
    }
    const formNowRef = doc.catalog.get(PDFName.of('AcroForm'));
    if (formNowRef instanceof PDFRef && !before.has(formNowRef) && formNowRef.objectNumber < firstNew) write.push([formNowRef, ctx.lookup(formNowRef)]);
    for (const [ref, old] of before) {
        const cur = serialize(ctx.lookup(ref));
        if (cur.length !== old.length || cur.some((b, i) => b !== old[i])) write.push([ref, ctx.lookup(ref)]);
    }
    write.sort((a, b) => a[0].objectNumber - b[0].objectNumber);

    // ---- assemble the update -------------------------------------------------------
    const base = bytes[bytes.length - 1] === 0x0a ? bytes : concat([bytes, ascii('\n')]);
    const parts = [base];
    let offset = base.length;
    const offsets = [];
    for (const [ref, obj] of write) {
        const head = ascii(`${ref.objectNumber} ${ref.generationNumber} obj\n`);
        const body = serialize(obj);
        const tail = ascii('\nendobj\n');
        offsets.push([ref, offset]);
        parts.push(head, body, tail);
        offset += head.length + body.length + tail.length;
    }

    const prev = previousXref(bytes);
    const trailer = ctx.trailerInfo;
    const size = Math.max(ctx.largestObjectNumber + 1, firstNew);
    const xrefIsStream = bytes.slice(prev, prev + 4).every((b, i) => b === 'xref'.charCodeAt(i)) === false;
    if (xrefIsStream) {
        // Update with a cross-reference stream (the previous one was a stream).
        const xrefNum = size;
        const entries = [...offsets, [PDFRef.of(xrefNum), offset]].sort((a, b) => a[0].objectNumber - b[0].objectNumber);
        const index = [];
        const rows = [];
        for (const [ref, off] of entries) {
            index.push(ref.objectNumber, 1);
            rows.push(1, (off >>> 24) & 255, (off >>> 16) & 255, (off >>> 8) & 255, off & 255, (ref.generationNumber >> 8) & 255, ref.generationNumber & 255);
        }
        const dict = {
            Type: 'XRef',
            Size: xrefNum + 1,
            W: [1, 4, 2],
            Index: index,
            Root: trailer.Root,
            Prev: prev,
            ...(trailer.Info ? { Info: trailer.Info } : {}),
            ...(trailer.ID ? { ID: trailer.ID } : {}),
        };
        const stream = ctx.stream(new Uint8Array(rows), dict);
        parts.push(ascii(`${xrefNum} 0 obj\n`), serialize(stream), ascii(`\nendobj\nstartxref\n${offset}\n%%EOF\n`));
    } else {
        // Classic xref table: one subsection per object.
        let table = 'xref\n';
        for (const [ref, off] of offsets) {
            table += `${ref.objectNumber} 1\n${String(off).padStart(10, '0')} ${String(ref.generationNumber).padStart(5, '0')} n\r\n`;
        }
        const trailerDict = ctx.obj({
            Size: size,
            Root: trailer.Root,
            Prev: prev,
            ...(trailer.Info ? { Info: trailer.Info } : {}),
            ...(trailer.ID ? { ID: trailer.ID } : {}),
        });
        parts.push(ascii(table), ascii('trailer\n'), serialize(trailerDict), ascii(`\nstartxref\n${offset}\n%%EOF\n`));
    }
    const data = concat(parts);

    // Fill in the byte ranges around the /Contents placeholder.
    const zeros = ascii('<' + '0'.repeat(64));
    const contentsStart = indexOfBytes(data, zeros, base.length);
    const contentsEnd = contentsStart + SIG_BYTES * 2 + 2;
    const ranges = [0, contentsStart, contentsEnd, data.length - contentsEnd];
    const placeholder = ascii(`0 ${RANGE_PLACEHOLDER} ${RANGE_PLACEHOLDER} ${RANGE_PLACEHOLDER}`);
    const at = indexOfBytes(data, placeholder, base.length);
    if (contentsStart < 0 || at < 0) throw new Error('สร้างช่องลายเซ็นไม่สำเร็จ');
    const filled = ascii(ranges.join(' ').padEnd(placeholder.length, ' '));
    data.set(filled, at);
    return { data, ranges, contentsStart, contentsEnd };
}

// Writes the DER signature into the placeholder.
export function insertSignature(prepared, der) {
    const hex = [...der].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    if (hex.length > prepared.contentsEnd - prepared.contentsStart - 2) throw new Error('ลายเซ็นใหญ่เกินพื้นที่ที่จองไว้');
    prepared.data.set(ascii(hex), prepared.contentsStart + 1);
    return prepared.data;
}

// Offset of the last cross-reference section (startxref value).
function previousXref(bytes) {
    const tail = bytes.subarray(Math.max(0, bytes.length - 2048));
    const at = lastIndexOfBytes(tail, ascii('startxref'));
    if (at < 0) throw new Error('ไฟล์ PDF ไม่สมบูรณ์ (ไม่พบ startxref)');
    const m = /startxref\s+(\d+)/.exec(new TextDecoder('latin1').decode(tail.subarray(at, at + 40)));
    return Number(m[1]);
}
