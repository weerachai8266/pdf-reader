'use strict';

// v0.6 document tools, driven through the real UI: extract, split, page
// numbers, header/footer, watermark, redaction, reduce size, password
// protection and removing it again. Called from smoke.js.

const path = require('node:path');
const fs = require('node:fs');
const { BrowserWindow } = require('electron');

module.exports = async function testDocTools(t) {
    const { win, js, check, waitFor, sleep, outDir, setSavePath, setFolder, inputPdf } = t;
    const { PDFDocument } = await import('pdf-lib');
    const pageCount = async (file) => (await PDFDocument.load(fs.readFileSync(file), { ignoreEncryption: true })).getPageCount();

    const open = async (file, name = path.basename(file)) => {
        win.webContents.send('file:opened', { path: file, name, data: new Uint8Array(fs.readFileSync(file)) });
        // A dirty document asks first; these tests always discard.
        await waitFor(win, `document.getElementById('dlg-confirm').open || document.getElementById('file-name').textContent === ${JSON.stringify(name)}`);
        await js(`document.getElementById('dlg-confirm').open && document.getElementById('dlg-confirm-ok').click()`);
        const ok = await waitFor(win, `document.getElementById('file-name').textContent === ${JSON.stringify(name)} && !!document.querySelector('.page canvas') && !document.body.classList.contains('is-busy')`);
        if (!ok) console.log('  open failed:', name, await js(`[document.getElementById('file-name').textContent, document.title, document.getElementById('toast').textContent, [...document.querySelectorAll('dialog[open]')].map((d) => d.id).join()].join(' | ')`));
        await sleep(300);
        return ok;
    };
    const menu = (name) => win.webContents.send('menu:command', name);
    const okDialog = (id) => js(`document.querySelector('#${id} button[value="ok"]').click()`);
    const toastText = () => js(`document.getElementById('toast').textContent`);
    const waitToast = (re, ms = 30000) => waitFor(win, `!document.getElementById('dlg-progress').open && ${re}.test(document.getElementById('toast').textContent)`, ms);
    const waitFile = async (file, ms = 20000) => {
        for (let n = 0; n < ms / 200; n++) {
            if (fs.existsSync(file) && fs.statSync(file).size > 0) {
                await sleep(300);
                return true;
            }
            await sleep(200);
        }
        return false;
    };
    const pageText = (idx) => js(`document.querySelectorAll('.page')[${idx}]?.querySelector('.textLayer')?.textContent || ''`);
    const search = async (q) => {
        await js(`(() => { document.querySelector('[data-action="show-search"]').click();
            const i = document.getElementById('search-input'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); })()`);
        await waitFor(win, `document.getElementById('search-status').textContent !== '' && !document.getElementById('search-status').textContent.startsWith('กำลัง')`);
        await sleep(400);
        return js(`document.querySelectorAll('#search-results li').length`);
    };

    // ---- extract & split ---------------------------------------------------
    check('open thai.pdf for tools', await open(inputPdf, 'thai.pdf'));
    const extracted = path.join(outDir, 'extracted.pdf');
    setSavePath(extracted);
    menu('extract');
    await waitFor(win, `document.getElementById('dlg-extract').open`);
    await js(`document.getElementById('extract-range').value = '9'`);
    await okDialog('dlg-extract');
    check('extract rejects bad range', await js(`document.getElementById('dlg-extract').open && !document.querySelector('#dlg-extract [data-error]').hidden`));
    await js(`document.getElementById('extract-range').value = '2-'`);
    await okDialog('dlg-extract');
    check('extract pages 2-3', (await waitFile(extracted)) && (await pageCount(extracted)) === 2);

    const splitDir = path.join(outDir, 'split');
    fs.mkdirSync(splitDir);
    setFolder(splitDir);
    menu('split');
    await waitFor(win, `document.getElementById('dlg-split').open`);
    await okDialog('dlg-split');
    await waitToast(/แยกเป็น/);
    const parts = fs.readdirSync(splitDir).filter((f) => f.endsWith('.pdf')).sort();
    check('split into one file per page', parts.length === 3 && parts[0] === 'thai_part01.pdf', parts.join(', '));

    // ---- page numbers, header/footer, watermark ------------------------------
    menu('page-numbers');
    await waitFor(win, `document.getElementById('dlg-header').open`);
    check('page numbers preset filled', (await js(`document.getElementById('hf-footer-center').value`)) === '{page} / {total}');
    await js(`document.getElementById('hf-header-right').value = 'เอกสารภายใน {file}'`);
    await okDialog('dlg-header');
    await waitToast(/ใส่เลขหน้าแล้ว/);
    check('page number on page 1', await waitFor(win, `document.querySelectorAll('.page')[0].querySelector('.textLayer')?.textContent.includes('1 / 3')`));
    check('Thai header on page 1', (await pageText(0)).includes('เอกสารภายใน thai'), (await pageText(0)).slice(-60));

    menu('watermark');
    await waitFor(win, `document.getElementById('dlg-watermark').open`);
    await okDialog('dlg-watermark');
    await waitToast(/ใส่ลายน้ำแล้ว/);
    check('watermark text on page', await waitFor(win, `document.querySelectorAll('.page')[0].querySelector('.textLayer')?.textContent.includes('ลับ')`));
    await sleep(800);
    fs.writeFileSync(path.join(outDir, 'stamped.png'), (await win.capturePage()).toPNG());

    // ---- redaction -------------------------------------------------------------
    await js(`document.querySelector('[data-tool="redact"]').click()`);
    await js(`document.getElementById('viewer').scrollTop = 0`);
    await sleep(500);
    const rect = await js(`(() => {
        // Thai text comes as one span per character cluster: cover every
        // span after "dog." on that line (the word คำค้นหาพิเศษ1).
        const all = [...document.querySelectorAll('.page')[0].querySelectorAll('.textLayer span')];
        const anchor = all.find((s) => s.textContent.endsWith('dog.')).getBoundingClientRect();
        const rs = all.map((s) => s.getBoundingClientRect())
            .filter((x) => x.width > 0 && Math.abs(x.top - anchor.top) < anchor.height / 2 && x.left >= anchor.right + 2);
        const r = { left: Math.min(...rs.map((x) => x.left)), top: Math.min(...rs.map((x) => x.top)), right: Math.max(...rs.map((x) => x.right)), bottom: Math.max(...rs.map((x) => x.bottom)) };
        return { x1: Math.round(r.left - 4), y1: Math.round(r.top - 4), x2: Math.round(r.right + 4), y2: Math.round(r.bottom + 4) };
    })()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: rect.x1, y: rect.y1, button: 'left', clickCount: 1 });
    for (let s = 1; s <= 5; s++) {
        win.webContents.sendInputEvent({ type: 'mouseMove', x: rect.x1 + ((rect.x2 - rect.x1) * s) / 5, y: rect.y1 + ((rect.y2 - rect.y1) * s) / 5, button: 'left' });
        await sleep(30);
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: rect.x2, y: rect.y2, button: 'left', clickCount: 1 });
    check('redaction mark drawn', await waitFor(win, `!!document.querySelector('.annot-redact:not(.is-drawing)') && !document.getElementById('apply-redactions').hidden`));
    await js(`document.getElementById('apply-redactions').click()`);
    await waitFor(win, `document.getElementById('dlg-redact').open`);
    await okDialog('dlg-redact');
    check('redaction applied', await waitToast(/ลบเนื้อหา/, 120000), await toastText());
    await js(`document.getElementById('viewer').scrollTop = 0`);
    await sleep(1200);
    fs.writeFileSync(path.join(outDir, 'redacted.png'), (await win.capturePage()).toPNG());
    check('redacted word gone', (await search('พิเศษ1')) === 0);
    check('other pages untouched', (await search('พิเศษ2')) === 1);
    check('redacted page searchable again (OCR)', (await search('ภาษาไทย')) >= 3);
    const redacted = path.join(outDir, 'redacted.pdf');
    setSavePath(redacted);
    await js(`document.querySelector('[data-action="save-as"]').click()`);
    if (await waitFile(redacted)) {
        // Page 1 must be just the scan image plus the OCR font: the original
        // fonts and the stamped text are gone.
        const doc = await PDFDocument.load(fs.readFileSync(redacted));
        const { PDFName } = require('pdf-lib');
        const res = doc.getPage(0).node.Resources();
        const keys = (name) => res?.lookup(PDFName.of(name))?.keys().map(String) || [];
        check('redacted page holds only the image', keys('XObject').join() === '/Im0' && keys('Font').length <= 1, `XObject ${keys('XObject')} Font ${keys('Font')}`);
        check('redacted file has 3 pages', doc.getPageCount() === 3);
    } else {
        check('redacted file saved', false);
    }

    // ---- reduce file size --------------------------------------------------------
    const photo = path.join(outDir, 'photo.pdf');
    await makePhotoPdf(photo, sleep);
    await open(photo);
    const reduced = path.join(outDir, 'photo_reduced.pdf');
    setSavePath(reduced);
    menu('compress');
    await waitFor(win, `document.getElementById('dlg-compress').open`);
    await okDialog('dlg-compress');
    const shrunk = await waitFile(reduced, 60000);
    const before = fs.statSync(photo).size;
    const after = shrunk ? fs.statSync(reduced).size : before;
    check('reduce file size', shrunk && after < before * 0.6, `${before} -> ${after} bytes — ${await toastText()}`);

    // ---- protect & remove security -------------------------------------------------
    await open(inputPdf, 'thai.pdf');
    const locked = path.join(outDir, 'locked.pdf');
    setSavePath(locked);
    menu('protect');
    await waitFor(win, `document.getElementById('dlg-protect').open`);
    await js(`(() => {
        const set = (id, v) => { document.getElementById(id).value = v; };
        set('prot-open-pw', 'open123'); set('prot-open-pw2', 'open123');
        const perm = document.getElementById('prot-perm-on'); perm.checked = true; perm.dispatchEvent(new Event('change', { bubbles: true }));
        set('prot-perm-pw', 'owner456'); set('prot-perm-pw2', 'owner999');
        document.getElementById('prot-print').value = 'none';
    })()`);
    await okDialog('dlg-protect');
    check('protect rejects mismatched passwords', await js(`document.getElementById('dlg-protect').open && /ไม่ตรงกัน/.test(document.querySelector('#dlg-protect [data-error]').textContent)`));
    await js(`document.getElementById('prot-perm-pw2').value = 'owner456'`);
    await okDialog('dlg-protect');
    const lockedOk = await waitFile(locked);
    check('protected file written', lockedOk);
    const createQpdf = require('@neslinesli93/qpdf-wasm');
    const showEncryption = async (file, password) => {
        const lines = [];
        const log = console.log;
        console.log = (...a) => lines.push(a.join(' '));
        try {
            const q = await createQpdf({});
            q.FS.writeFile('/f.pdf', new Uint8Array(fs.readFileSync(file)));
            const code = q.callMain([`--password=${password}`, '--show-encryption', '/f.pdf']);
            return { code, text: lines.join('\n') };
        } finally {
            console.log = log;
        }
    };
    if (lockedOk) {
        const noPw = await showEncryption(locked, '');
        check('protected file needs a password', noPw.code === 2, noPw.text.split('\n')[0]);
        const owner = await showEncryption(locked, 'owner456');
        check('AES-256 with print disabled', /AESv3/.test(owner.text) && /print high resolution: not allowed/.test(owner.text));
    }
    check('protected file reopened without asking', await waitFor(win, `document.getElementById('file-name').textContent === 'locked.pdf' && !!document.querySelector('.page canvas') && !document.getElementById('dlg-prompt').open`));
    await js(`document.querySelector('[data-action="print"]').click()`);
    check('print blocked by permissions', await waitFor(win, `/ไม่อนุญาตให้พิมพ์/.test(document.getElementById('toast').textContent)`));

    menu('remove-security');
    check('remove security asks for permissions password', await waitFor(win, `document.getElementById('dlg-prompt').open`));
    await js(`document.getElementById('dlg-prompt-input').value = 'owner456'; document.querySelector('#dlg-prompt-form button[type="submit"]').click()`);
    check('security removed', await waitToast(/ปลดรหัสผ่านแล้ว/));
    const unlocked = path.join(outDir, 'unlocked.pdf');
    setSavePath(unlocked);
    await js(`document.querySelector('[data-action="save-as"]').click()`);
    if (await waitFile(unlocked)) {
        const plain = await showEncryption(unlocked, '');
        check('saved file has no password', /File is not encrypted/.test(plain.text) && (await pageCount(unlocked)) === 3, plain.text.split('\n')[0]);
    } else {
        check('unlocked file saved', false);
    }
};

// One large, noisy photo on a small page: plenty to downsample.
async function makePhotoPdf(file, sleep) {
    const win = new BrowserWindow({ show: false, width: 1200, height: 900, useContentSize: true });
    const html = `<!doctype html><body style="margin:0"><canvas id="c" width="1200" height="900"></canvas><script>
        const c = document.getElementById('c').getContext('2d');
        const img = c.createImageData(1200, 900);
        for (let i = 0; i < img.data.length; i += 4) {
            const x = (i / 4) % 1200, y = Math.floor(i / 4 / 1200);
            img.data[i] = (x * 0.2 + Math.random() * 80) | 0;
            img.data[i + 1] = (y * 0.25 + Math.random() * 80) | 0;
            img.data[i + 2] = (128 + Math.random() * 120) | 0;
            img.data[i + 3] = 255;
        }
        c.putImageData(img, 0, 0);
    </script>`;
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await sleep(400);
    const jpeg = (await win.capturePage()).toJPEG(95);
    win.destroy();
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const page = doc.addPage([288, 216]); // 4 x 3 inches
    const img = await doc.embedJpg(jpeg);
    page.drawImage(img, { x: 0, y: 0, width: 288, height: 216 });
    fs.writeFileSync(file, await doc.save());
}
