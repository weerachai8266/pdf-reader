'use strict';

// v0.7 conversion: Create PDF from Word + images, Export to Word / Text /
// Images. Needs LibreOffice in vendor/libreoffice (tools/fetch-libreoffice.ps1).
// Called from smoke.js.

const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { BrowserWindow } = require('electron');

const SOFFICE = path.join(__dirname, '..', 'vendor', 'libreoffice', 'program', 'soffice.com');

module.exports = async function testConvert(t) {
    const { win, js, check, waitFor, sleep, outDir, setSavePath, setFolder, setOpenPaths, inputPdf } = t;
    if (!fs.existsSync(SOFFICE)) {
        check('LibreOffice present (run tools/fetch-libreoffice.ps1)', false);
        return;
    }
    const menu = (name) => win.webContents.send('menu:command', name);
    const toastText = () => js(`document.getElementById('toast').textContent`);
    const waitToast = (re, ms = 60000) => waitFor(win, `!document.getElementById('dlg-progress').open && ${re}.test(document.getElementById('toast').textContent)`, ms);
    const waitFile = async (file, ms = 60000) => {
        for (let n = 0; n < ms / 200; n++) {
            if (fs.existsSync(file) && fs.statSync(file).size > 0) {
                await sleep(300);
                return true;
            }
            await sleep(200);
        }
        return false;
    };
    const discardIfAsked = () => js(`document.getElementById('dlg-confirm').open && document.getElementById('dlg-confirm-ok').click()`);

    // ---- fixtures: a Thai .docx (made by LibreOffice from HTML) and images ----
    const fixtures = path.join(outDir, 'convert-in');
    fs.mkdirSync(fixtures);
    const memoHtml = path.join(fixtures, 'memo.html');
    fs.writeFileSync(memoHtml, `<!doctype html><meta charset="utf-8"><body>
        <h1 style="font-family:Tahoma">บันทึกข้อความ</h1>
        <p style="font-family:Tahoma">เรื่อง ขออนุมัติจัดซื้อวัสดุสำนักงาน ประจำปีงบประมาณ 2570</p>
        <p style="font-family:Leelawadee UI">ที่นี่มีน้ำใจ ผู้ใหญ่ใจดี</p>
        <p>Total budget 12,500 THB</p></body>`);
    execFileSync(SOFFICE, [
        `-env:UserInstallation=file:///${outDir.replace(/\\/g, '/')}/lo-profile`,
        '--headless', '--norestore', '--convert-to', 'docx:MS Word 2007 XML', '--outdir', fixtures, memoHtml,
    ], { timeout: 120000, windowsHide: true });
    const memoDocx = path.join(fixtures, 'memo.docx');
    check('fixture docx created', fs.existsSync(memoDocx));
    const [png, jpg] = await makeImages(fixtures, sleep);

    // ---- Create PDF from Word + two images -------------------------------------
    setOpenPaths([memoDocx, png, jpg]);
    menu('create-pdf');
    await sleep(300);
    await discardIfAsked();
    const created = await waitToast(/สร้าง PDF แล้ว/, 120000);
    check('Create PDF from docx + images', created, await toastText());
    const pages = await js(`document.getElementById('page-count').textContent`);
    check('created document has docx page + 2 image pages', pages === '3', pages);
    check('created document is untitled and unsaved', await js(`document.getElementById('file-name').textContent === 'memo.pdf' && document.title.startsWith('●')`));
    await waitFor(win, `document.querySelectorAll('.page')[0].querySelector('.textLayer')?.textContent.length > 10`, 20000);
    await js(`(() => { document.querySelector('[data-action="show-search"]').click();
        const i = document.getElementById('search-input'); i.value = 'ขออนุมัติจัดซื้อวัสดุสำนักงาน'; i.dispatchEvent(new Event('input')); })()`);
    await waitFor(win, `document.getElementById('search-status').textContent !== '' && !document.getElementById('search-status').textContent.startsWith('กำลัง')`);
    await sleep(400);
    check('converted Thai text is searchable', (await js(`document.querySelectorAll('#search-results li').length`)) === 1, await js(`document.getElementById('search-status').textContent`));
    await js(`(() => { const i = document.getElementById('search-input'); i.value = 'ที่นี่มีน้ำใจ'; i.dispatchEvent(new Event('input')); })()`);
    await sleep(800);
    check('converted Thai with stacked marks is searchable', (await js(`document.querySelectorAll('#search-results li').length`)) === 1, await js(`document.getElementById('search-status').textContent`));
    const createdPdf = path.join(outDir, 'created.pdf');
    setSavePath(createdPdf);
    await js(`document.querySelector('[data-action="save"]').click()`);
    check('Save asks where to put the new PDF', await waitFile(createdPdf));
    await sleep(800);
    fs.writeFileSync(path.join(outDir, 'created.png'), (await win.capturePage()).toPNG());

    // ---- exports from the Thai test document -------------------------------------
    win.webContents.send('file:opened', { path: inputPdf, name: 'thai.pdf', data: new Uint8Array(fs.readFileSync(inputPdf)) });
    await sleep(300);
    await discardIfAsked();
    await waitFor(win, `document.getElementById('file-name').textContent === 'thai.pdf' && !document.body.classList.contains('is-busy')`);

    const docx = path.join(outDir, 'thai.docx');
    setSavePath(docx);
    menu('export-docx');
    if (await waitFile(docx, 120000)) {
        const xml = readZipEntry(fs.readFileSync(docx), 'word/document.xml');
        const text = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');
        check('Word export keeps Thai text', text.includes('ภาษาไทยเป็นภาษา') && text.includes('สระล่าง และวรรณยุกต์') && text.includes('ทดสอบภาษาไทย'), text.slice(0, 120));
        check('Word export keeps page breaks', (xml.match(/w:pageBreakBefore|w:br w:type="page"/g) || []).length >= 2);
        check('Word export makes headings', /w:pStyle w:val="(Heading|heading)/.test(xml));
    } else {
        check('Word export written', false, await toastText());
    }

    const txt = path.join(outDir, 'thai.txt');
    setSavePath(txt);
    menu('export-text');
    if (await waitFile(txt)) {
        const raw = fs.readFileSync(txt);
        const text = raw.toString('utf8');
        check('text export has BOM and Thai', raw[0] === 0xef && text.includes('คำค้นหาพิเศษ2') && text.includes('ผู้ใหญ่'), text.slice(1, 80));
    } else {
        check('text export written', false);
    }

    const imgDir = path.join(outDir, 'images');
    fs.mkdirSync(imgDir);
    setFolder(imgDir);
    menu('export-images');
    await waitFor(win, `document.getElementById('dlg-export-image').open`);
    await js(`document.getElementById('img-export-range').value = '1-2'; document.getElementById('img-export-dpi').value = '96'`);
    await js(`document.querySelector('#dlg-export-image button[value="ok"]').click()`);
    await waitToast(/บันทึกรูปภาพ/);
    const imgs = fs.readdirSync(imgDir).filter((f) => f.endsWith('.png'));
    check('image export writes one PNG per page', imgs.length === 2, imgs.join(', '));
};

// A wide PNG (landscape page) and a tall JPEG (portrait page).
async function makeImages(dir, sleep) {
    const shot = async (w, h, color, label) => {
        const win = new BrowserWindow({ show: false, width: w, height: h, useContentSize: true });
        await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
            `<body style="margin:0;background:${color};font:60px Tahoma;display:grid;place-items:center;height:100vh">${label}</body>`));
        await sleep(300);
        const img = await win.capturePage();
        win.destroy();
        return img;
    };
    const png = path.join(dir, 'wide.png');
    fs.writeFileSync(png, (await shot(900, 500, '#cde', 'ภาพแนวนอน')).toPNG());
    const jpg = path.join(dir, 'tall.jpg');
    fs.writeFileSync(jpg, (await shot(500, 700, '#fdc', 'ภาพแนวตั้ง')).toJPEG(90));
    return [png, jpg];
}

// Minimal zip reader for one entry (stored or deflated).
function readZipEntry(buf, name) {
    let eocd = buf.length - 22;
    while (eocd > 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
    let off = buf.readUInt32LE(eocd + 16);
    const count = buf.readUInt16LE(eocd + 10);
    for (let i = 0; i < count; i++) {
        const method = buf.readUInt16LE(off + 10);
        const size = buf.readUInt32LE(off + 20);
        const nameLen = buf.readUInt16LE(off + 28);
        const extraLen = buf.readUInt16LE(off + 30);
        const commentLen = buf.readUInt16LE(off + 32);
        const local = buf.readUInt32LE(off + 42);
        const entry = buf.toString('utf8', off + 46, off + 46 + nameLen);
        if (entry === name) {
            const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
            const data = buf.subarray(start, start + size);
            return (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
        }
        off += 46 + nameLen + extraLen + commentLen;
    }
    return '';
}
