// Document > Reduce File Size: downsample and re-encode large images as
// JPEG, then let qpdf drop unused objects and pack the rest. Writes a new
// file; the open document is unchanged.

import { state } from './docstate.js';
import { buildEditable } from './save.js';
import { optimize } from './qpdf.js';
import { siblingPath } from './extract.js';
import { showFormDialog, progressDialog, toast } from './dialog.js';

const $ = (id) => document.getElementById(id);

// dpi: image resolution cap relative to the largest page; quality: JPEG.
const PRESETS = {
    high: { dpi: 200, quality: 0.85 },
    standard: { dpi: 150, quality: 0.75 },
    small: { dpi: 100, quality: 0.6 },
};
// Images already this small are left alone.
const MIN_PIXELS = 300 * 300;

const mb = (n) => `${(n / 1048576).toFixed(n < 10485760 ? 2 : 1)} MB`;

export async function reduceFileSize() {
    if (!(await showFormDialog('dlg-compress'))) return;
    const preset = PRESETS[document.querySelector('input[name="compress-level"]:checked').value] || PRESETS.standard;

    const progress = progressDialog('Reduce File Size');
    try {
        progress.update('กำลังเตรียมเอกสาร…', null);
        const { lib, doc } = await buildEditable();
        const before = (await doc.save({ useObjectStreams: true })).length;
        const longestInch = Math.max(...doc.getPages().map((p) => Math.max(p.getWidth(), p.getHeight()))) / 72;
        const maxSide = Math.round(longestInch * preset.dpi);

        const images = findImages(lib, doc);
        let changed = 0;
        for (const [n, image] of images.entries()) {
            if (progress.cancelled) return toast('ยกเลิกแล้ว');
            progress.update(`กำลังย่อรูปภาพ ${n + 1} จาก ${images.length}`, images.length ? n / images.length : null);
            if (await recompress(lib, doc, image, maxSide, preset.quality)) changed++;
        }

        progress.update('กำลังจัดระเบียบไฟล์…', null);
        const data = await optimize(await doc.save({ useObjectStreams: true, updateFieldAppearances: false }));
        progress.close();
        if (data.length >= before * 0.98) {
            toast(`ไฟล์นี้เล็กที่สุดแล้ว (${mb(before)}) ลดขนาดเพิ่มไม่ได้`);
            return;
        }
        const name = (state.fileName || 'document.pdf').replace(/\.pdf$/i, '');
        const saved = await window.host.save({ data, filePath: null, suggestedName: siblingPath(`${name}_reduced.pdf`) });
        if (!saved) return;
        const pct = Math.round((1 - data.length / before) * 100);
        toast(`ลดขนาดจาก ${mb(before)} เหลือ ${mb(data.length)} (−${pct}%, ย่อรูป ${changed} รูป) บันทึกเป็น ${saved.name}`);
    } catch (err) {
        console.error(err);
        toast(`ลดขนาดไฟล์ไม่สำเร็จ: ${err?.message || err}`, 'error');
    } finally {
        progress.close();
    }
}

// Image XObjects we know how to decode exactly: baseline JPEG, or 8-bit
// RGB/gray Flate without predictors. Masks, CMYK, Decode arrays and
// colour-key masks are skipped.
function findImages(lib, doc) {
    const { PDFName, PDFRawStream, PDFArray, PDFNumber } = lib;
    const name = (dict, key) => dict.lookup(PDFName.of(key));
    const out = [];
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
        if (!(obj instanceof PDFRawStream)) continue;
        const dict = obj.dict;
        if (name(dict, 'Subtype') !== PDFName.of('Image')) continue;
        if (name(dict, 'ImageMask') || dict.get(PDFName.of('Decode')) || name(dict, 'Mask') instanceof PDFArray) continue;
        if (name(dict, 'Type') && name(dict, 'Type') !== PDFName.of('XObject')) continue;

        let filter = name(dict, 'Filter');
        if (filter instanceof PDFArray) filter = filter.size() === 1 ? filter.lookup(0) : null;
        const kind = filter === PDFName.of('DCTDecode') ? 'jpeg' : filter === PDFName.of('FlateDecode') ? 'flate' : null;
        if (!kind) continue;

        const width = name(dict, 'Width');
        const height = name(dict, 'Height');
        if (!(width instanceof PDFNumber) || !(height instanceof PDFNumber)) continue;

        const channels = colorChannels(lib, dict.get(PDFName.of('ColorSpace')), doc);
        if (!channels) continue;
        if (kind === 'flate') {
            const bpc = name(dict, 'BitsPerComponent');
            if (!(bpc instanceof PDFNumber) || bpc.asNumber() !== 8 || dict.get(PDFName.of('DecodeParms'))) continue;
        }
        out.push({ ref, obj, kind, channels, width: width.asNumber(), height: height.asNumber() });
    }
    return out;
}

// 1 (gray) or 3 (RGB) for device or ICC colour spaces, otherwise null.
function colorChannels(lib, cs, doc) {
    const { PDFName, PDFArray, PDFNumber, PDFRef } = lib;
    if (cs instanceof PDFRef) cs = doc.context.lookup(cs);
    if (cs === PDFName.of('DeviceRGB')) return 3;
    if (cs === PDFName.of('DeviceGray')) return 1;
    if (cs instanceof PDFArray && cs.lookup(0) === PDFName.of('ICCBased')) {
        const n = cs.lookup(1)?.dict?.lookup(PDFName.of('N'));
        if (n instanceof PDFNumber && (n.asNumber() === 3 || n.asNumber() === 1)) return n.asNumber();
    }
    return null;
}

async function decode(lib, image) {
    if (image.kind === 'jpeg') {
        return createImageBitmap(new Blob([image.obj.contents], { type: 'image/jpeg' }));
    }
    const raw = lib.decodePDFRawStream(image.obj).decode();
    const { width, height, channels } = image;
    if (raw.length < width * height * channels) return null;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0, j = 0; i < width * height; i++, j += channels) {
        const r = raw[j];
        rgba[i * 4] = r;
        rgba[i * 4 + 1] = channels === 3 ? raw[j + 1] : r;
        rgba[i * 4 + 2] = channels === 3 ? raw[j + 2] : r;
        rgba[i * 4 + 3] = 255;
    }
    return createImageBitmap(new ImageData(rgba, width, height));
}

// Replaces the image stream with a smaller JPEG. Returns true if replaced.
async function recompress(lib, doc, image, maxSide, quality) {
    const { width, height } = image;
    if (width * height < MIN_PIXELS) return false;
    const scale = Math.min(1, maxSide / Math.max(width, height));
    // Flate images are only worth touching when they shrink a lot (JPEG
    // would blur sharp screenshots and line art for little gain).
    if (image.kind === 'flate' && scale > 0.75) return false;

    let bitmap;
    try {
        bitmap = await decode(lib, image);
    } catch (err) {
        console.warn('image decode failed', err);
        return false;
    }
    if (!bitmap) return false;
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const jpeg = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality })).arrayBuffer());
    if (jpeg.length >= image.obj.contents.length * 0.9) return false;

    const { PDFName } = lib;
    const old = image.obj.dict;
    const extra = {};
    for (const key of ['SMask', 'Interpolate', 'Intent', 'Metadata']) {
        const v = old.get(PDFName.of(key));
        if (v) extra[key] = v;
    }
    const stream = doc.context.stream(jpeg, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: w,
        Height: h,
        ColorSpace: 'DeviceRGB',
        BitsPerComponent: 8,
        Filter: 'DCTDecode',
        ...extra,
    });
    doc.context.assign(image.ref, stream);
    return true;
}
