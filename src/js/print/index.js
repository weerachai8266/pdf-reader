// Hidden print window: lays out each chosen page on a sheet of the chosen
// paper at print resolution (printlayout.js, same as the dialog preview),
// then tells the main process it can send the job to the printer.

import { pdfjsLib, loadPdf } from '../pdfjs.js';
import { renderSheet, toPortrait } from '../printlayout.js';

const PRINT_DPI = 300;

// job: { data, password, pages (0-based), layout, grayscale }
window.printHost.onLoad(async (job) => {
    try {
        const pdf = await loadPdf(job.data, async () => job.password ?? null);
        const sheets = document.getElementById('sheets');
        for (const [n, index] of job.pages.entries()) {
            const page = await pdf.getPage(index + 1);
            const { canvas } = await renderSheet(page, job.layout, {
                dpi: PRINT_DPI,
                // The bytes are the saved output, so form values are in the file; the
                // print intent drops annotations flagged as non-printing.
                annotationMode: pdfjsLib.AnnotationMode.ENABLE,
                grayscale: job.grayscale,
            });
            page.cleanup();
            const portrait = toPortrait(canvas);
            const blob = await new Promise((resolve) => portrait.toBlob(resolve, 'image/png'));
            portrait.width = 0;
            const img = new Image();
            img.src = URL.createObjectURL(blob);
            img.alt = '';
            await img.decode();
            const sheet = document.createElement('section');
            sheet.className = 'sheet';
            sheet.append(img);
            sheets.append(sheet);
            window.printHost.progress({ done: n + 1, total: job.pages.length });
        }
        window.printHost.rendered({ sheets: job.pages.length });
    } catch (err) {
        window.printHost.rendered({ error: err?.message || String(err) });
    }
});
