// Text recognition (Acrobat's "Recognize Text"): renders scanned pages,
// runs Tesseract (WebAssembly, fully offline) on them, and returns word
// boxes in PDF user space. ocrlayer.js turns those into an invisible text
// layer so the page becomes searchable and selectable.

import Tesseract from '../../node_modules/tesseract.js/dist/tesseract.esm.min.js';
import { getPdfPage } from './docstate.js';

const OCR_DPI = 300;
const LANGS = 'tha+eng';
const BASE = new URL('../../', import.meta.url).href;
// A page with fewer visible characters than this is treated as scanned.
const MIN_TEXT_CHARS = 20;

export async function pageHasText(entry) {
    const page = await getPdfPage(entry);
    const content = await page.getTextContent();
    let count = 0;
    for (const item of content.items) count += (item.str || '').replace(/\s+/g, '').length;
    return count >= MIN_TEXT_CHARS;
}

async function createScheduler(workers) {
    const scheduler = Tesseract.createScheduler();
    const options = {
        workerPath: BASE + 'node_modules/tesseract.js/dist/worker.min.js',
        corePath: BASE + 'node_modules/tesseract.js-core/',
        langPath: BASE + 'ocr-lang',
        workerBlobURL: false,
        cacheMethod: 'none',
        gzip: true,
    };
    await Promise.all(Array.from({ length: workers }, async () => {
        scheduler.addWorker(await Tesseract.createWorker(LANGS, Tesseract.OEM.LSTM_ONLY, options));
    }));
    return scheduler;
}

async function renderForOcr(entry) {
    const page = await getPdfPage(entry);
    // The source page's own orientation (not our extra rotation), so the
    // boxes map straight back into the source's user space.
    const viewport = page.getViewport({ scale: OCR_DPI / 72, rotation: page.rotate });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, annotationMode: 0 }).promise;
    return { canvas, viewport };
}

// A gap wider than this fraction of the line height is a real space.
const SPACE_GAP_RATIO = 0.3;

// Tesseract reports Thai as one "word" per character cluster (even single
// tone marks), so laying them out one by one would put spaces inside Thai
// words. Instead merge each line into runs of touching words; a real gap
// starts a new run. Each run becomes one stretched string in the text layer.
function wordsFrom(data, viewport) {
    const runs = [];
    for (const block of data.blocks || []) {
        for (const para of block.paragraphs) {
            for (const line of para.lines) {
                const lineH = line.bbox.y1 - line.bbox.y0;
                let run = null;
                for (const word of line.words) {
                    const text = word.text.trim();
                    if (!text || word.confidence < 15) continue;
                    const { x0, x1 } = word.bbox;
                    if (run && x0 - run.x1 <= lineH * SPACE_GAP_RATIO) {
                        run.text += text;
                        run.x1 = Math.max(run.x1, x1);
                    } else {
                        run = { text, x0, x1, y0: line.bbox.y0, y1: line.bbox.y1 };
                        runs.push(run);
                    }
                }
            }
        }
    }
    return runs.map(({ text, x0, x1, y0, y1 }) => ({
        text,
        bl: viewport.convertToPdfPoint(x0, y1),
        br: viewport.convertToPdfPoint(x1, y1),
        tl: viewport.convertToPdfPoint(x0, y0),
    }));
}

// entries: page entries to recognise. Returns Map(entry.key -> words).
// onProgress(done, total); isCancelled() is polled between pages.
export async function recognize(entries, { onProgress, isCancelled }) {
    const workers = Math.max(1, Math.min(2, entries.length, Math.floor((navigator.hardwareConcurrency || 2) / 2)));
    const scheduler = await createScheduler(workers);
    const results = new Map();
    let done = 0;
    let next = 0;
    onProgress(0, entries.length);
    // One page in flight per worker: 300 dpi canvases are ~35 MB each.
    const lane = async () => {
        while (next < entries.length && !isCancelled()) {
            const entry = entries[next++];
            const { canvas, viewport } = await renderForOcr(entry);
            if (isCancelled()) return;
            const { data } = await scheduler.addJob('recognize', canvas, {}, { blocks: true, text: false });
            canvas.width = 0;
            results.set(entry.key, wordsFrom(data, viewport));
            onProgress(++done, entries.length);
        }
    };
    try {
        await Promise.all(Array.from({ length: workers }, lane));
    } finally {
        await scheduler.terminate();
    }
    return results;
}
