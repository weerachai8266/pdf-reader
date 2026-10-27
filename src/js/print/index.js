// Hidden print window: renders each page of the given PDF to an image at
// print resolution, then tells the main process it can open the dialog.

import { pdfjsLib, loadPdf } from '../pdfjs.js';

const PRINT_DPI = 300;

async function renderPage(pdf, number) {
    const page = await pdf.getPage(number);
    const viewport = page.getViewport({ scale: PRINT_DPI / 72 });
    let canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // The bytes are already the saved output, so field values are in the
    // file; the print intent drops annotations flagged as non-printing.
    await page.render({ canvasContext: ctx, viewport, annotationMode: pdfjsLib.AnnotationMode.ENABLE, intent: 'print' }).promise;
    page.cleanup();

    // Landscape pages are turned a quarter counter-clockwise to fit portrait
    // paper (Acrobat's "auto portrait/landscape": the page top ends up on
    // the left edge of the sheet).
    if (canvas.width > canvas.height) {
        const rotated = document.createElement('canvas');
        rotated.width = canvas.height;
        rotated.height = canvas.width;
        const rctx = rotated.getContext('2d', { alpha: false });
        rctx.translate(0, rotated.height);
        rctx.rotate(-Math.PI / 2);
        rctx.drawImage(canvas, 0, 0);
        canvas.width = 0;
        canvas = rotated;
    }

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    canvas.width = 0;
    const img = new Image();
    img.src = URL.createObjectURL(blob);
    img.alt = '';
    await img.decode();
    return img;
}

window.printHost.onLoad(async ({ data, password }) => {
    try {
        const pdf = await loadPdf(data, async () => password ?? null);
        const sheets = document.getElementById('sheets');
        for (let n = 1; n <= pdf.numPages; n++) {
            const sheet = document.createElement('section');
            sheet.className = 'sheet';
            sheet.append(await renderPage(pdf, n));
            sheets.append(sheet);
        }
        window.printHost.rendered({ pages: pdf.numPages });
    } catch (err) {
        window.printHost.rendered({ error: err?.message || String(err) });
    }
});
