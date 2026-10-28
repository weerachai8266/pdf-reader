// Print layout shared by the Print dialog preview and the hidden print
// window, so the preview shows exactly what reaches the paper.
//
// Sizes are in PDF points (1/72 inch). A "sheet" is one side of paper in
// the orientation the user sees; a landscape sheet is turned a quarter
// turn when it is sent to the printer, which always gets portrait paper.

// Portrait paper sizes.
export const PAPERS = {
    A4: [595.28, 841.89],
    A3: [841.89, 1190.55],
    A5: [419.53, 595.28],
    Letter: [612, 792],
    Legal: [612, 1008],
};

// Most printers cannot print the outer ~4 mm; Fit and Shrink keep clear of it.
const MARGIN = 12;

// opts: { paper, orientation: 'auto'|'portrait'|'landscape',
//         sizing: 'fit'|'actual'|'shrink'|'custom', scale (percent, custom only) }
// pageW / pageH: the page as displayed (after its rotation).
// -> { sheetW, sheetH, landscape, scale, x, y, w, h } with x/y from the top-left.
export function placePage(pageW, pageH, opts) {
    const [pw, ph] = PAPERS[opts.paper] || PAPERS.A4;
    const landscape = opts.orientation === 'landscape' || (opts.orientation !== 'portrait' && pageW > pageH);
    const sheetW = landscape ? ph : pw;
    const sheetH = landscape ? pw : ph;
    const fit = Math.min((sheetW - 2 * MARGIN) / pageW, (sheetH - 2 * MARGIN) / pageH);
    const scale = {
        fit,
        actual: 1,
        shrink: Math.min(1, fit),
        custom: Math.max(0.01, (Number(opts.scale) || 100) / 100),
    }[opts.sizing] ?? fit;
    const w = pageW * scale;
    const h = pageH * scale;
    return { sheetW, sheetH, landscape, scale, x: (sheetW - w) / 2, y: (sheetH - h) / 2, w, h };
}

// Which pages print, in order (0-based), or null when the range is invalid.
// sel: { range: 'all'|'current'|'pages', pages (text like "1-3, 5"), current,
//        subset: 'all'|'odd'|'even', reverse }
export function selectPages(total, sel, parseRanges) {
    let list;
    if (sel.range === 'current') list = [Math.min(Math.max(sel.current, 0), total - 1)];
    else if (sel.range === 'pages') list = parseRanges(sel.pages || '', total);
    else list = Array.from({ length: total }, (_, i) => i);
    if (!list) return null;
    // Odd/even go by page number, as on the printed page.
    if (sel.subset === 'odd') list = list.filter((i) => i % 2 === 0);
    if (sel.subset === 'even') list = list.filter((i) => i % 2 === 1);
    if (sel.reverse) list = [...list].reverse();
    return list.length ? list : null;
}

// Draws one page onto a sheet canvas. pdfPage: a pdf.js page; dpi: output
// resolution; annotations: pdf.js AnnotationMode value.
export async function renderSheet(pdfPage, opts, { dpi, annotationMode, grayscale }) {
    const base = pdfPage.getViewport({ scale: 1 });
    const place = placePage(base.width, base.height, opts);
    const k = dpi / 72;
    const sheet = document.createElement('canvas');
    sheet.width = Math.round(place.sheetW * k);
    sheet.height = Math.round(place.sheetH * k);
    const ctx = sheet.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, sheet.width, sheet.height);

    const viewport = pdfPage.getViewport({ scale: place.scale * k });
    const page = document.createElement('canvas');
    page.width = Math.max(1, Math.round(viewport.width));
    page.height = Math.max(1, Math.round(viewport.height));
    const pctx = page.getContext('2d', { alpha: false });
    pctx.fillStyle = '#fff';
    pctx.fillRect(0, 0, page.width, page.height);
    await pdfPage.render({ canvasContext: pctx, viewport, annotationMode, intent: 'print' }).promise;

    if (grayscale) ctx.filter = 'grayscale(1)';
    ctx.drawImage(page, Math.round(place.x * k), Math.round(place.y * k));
    ctx.filter = 'none';
    page.width = 0;
    return { canvas: sheet, place };
}

// Turns a landscape sheet a quarter counter-clockwise onto portrait paper
// (the sheet's top ends up on the paper's left edge, as Acrobat prints).
export function toPortrait(canvas) {
    if (canvas.width <= canvas.height) return canvas;
    const out = document.createElement('canvas');
    out.width = canvas.height;
    out.height = canvas.width;
    const ctx = out.getContext('2d', { alpha: false });
    ctx.translate(0, out.height);
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(canvas, 0, 0);
    canvas.width = 0;
    return out;
}
