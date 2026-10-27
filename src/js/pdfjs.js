import * as pdfjsLib from '../../node_modules/pdfjs-dist/build/pdf.mjs';

const BASE = new URL('../../node_modules/pdfjs-dist/', import.meta.url).href;

pdfjsLib.GlobalWorkerOptions.workerSrc = BASE + 'build/pdf.worker.mjs';

export { pdfjsLib };

// Loads a PDF from bytes. pdf.js transfers the buffer to its worker, so we
// always hand it a copy and keep the caller's bytes intact for saving.
export function loadPdf(bytes, askPassword) {
    const task = pdfjsLib.getDocument({
        data: bytes.slice(),
        cMapUrl: BASE + 'cmaps/',
        cMapPacked: true,
        standardFontDataUrl: BASE + 'standard_fonts/',
        wasmUrl: BASE + 'wasm/',
        iccUrl: BASE + 'iccs/',
        isEvalSupported: false,
        enableXfa: false,
    });
    let password = null;
    task.onPassword = async (update, reason) => {
        const retry = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
        const pw = await askPassword(retry);
        if (pw === null) {
            task.destroy();
            return;
        }
        password = pw;
        update(pw);
    };
    return task.promise.then((pdf) => {
        passwords.set(pdf, password);
        return pdf;
    });
}

// Password the user typed to open a document (needed to print it again).
const passwords = new WeakMap();
export function passwordOf(pdf) {
    return passwords.get(pdf) ?? null;
}
