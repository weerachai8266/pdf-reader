'use strict';

// v0.8: certificate signatures (create ID, sign visibly, sign again,
// verify, detect tampering) and Compare Files. Called from smoke.js.

const path = require('node:path');
const fs = require('node:fs');
const { BrowserWindow } = require('electron');

module.exports = async function testDigsig(t) {
    const { win, js, check, waitFor, sleep, outDir, setSavePath, setOpenPaths, inputPdf } = t;
    const waitFile = async (file, ms = 30000) => {
        for (let n = 0; n < ms / 200; n++) {
            if (fs.existsSync(file) && fs.statSync(file).size > 0) {
                await sleep(300);
                return true;
            }
            await sleep(200);
        }
        return false;
    };
    const open = async (file) => {
        const name = path.basename(file);
        win.webContents.send('file:opened', { path: file, name, data: new Uint8Array(fs.readFileSync(file)) });
        await sleep(300);
        await js(`document.getElementById('dlg-confirm').open && document.getElementById('dlg-confirm-ok').click()`);
        return waitFor(win, `document.getElementById('file-name').textContent === ${JSON.stringify(name)} && !document.body.classList.contains('is-busy') && !!document.querySelector('.page canvas')`);
    };
    const toastText = () => js(`document.getElementById('toast').textContent`);
    const banner = () => js(`document.getElementById('sig-banner').hidden ? 'hidden' : document.getElementById('sig-banner').dataset.status`);

    // ---- sign with a new self-signed Digital ID, visible box on page 1 ----------
    await open(inputPdf);
    await js(`document.querySelector('[data-action="cert-sign"]').click()`);
    await waitFor(win, `document.getElementById('dlg-cs-where').open`);
    await js(`document.querySelector('#dlg-cs-where button[value="ok"]').click()`);
    await js(`document.getElementById('viewer').scrollTop = 0`);
    await sleep(400);
    const r = await js(`(() => { const p = document.querySelectorAll('.page')[0].getBoundingClientRect();
        return { x: Math.round(p.left + p.width * 0.55), y: Math.round(Math.max(p.top, 60) + 420) }; })()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    for (let s = 1; s <= 5; s++) {
        win.webContents.sendInputEvent({ type: 'mouseMove', x: r.x + s * 50, y: r.y + s * 16, button: 'left' });
        await sleep(30);
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: r.x + 250, y: r.y + 80, button: 'left', clickCount: 1 });
    check('signature dialog opens after dragging the box', await waitFor(win, `document.getElementById('dlg-certsign').open`));
    check('no Digital ID yet', await js(`!document.getElementById('cs-no-ids').hidden && document.getElementById('cs-id').hidden`));

    await js(`document.getElementById('cs-new-id').click()`);
    await waitFor(win, `document.getElementById('dlg-new-id').open`);
    await js(`(() => { const set = (id, v) => { document.getElementById(id).value = v; };
        set('nid-name', 'สมชาย ใจดี'); set('nid-org', 'สำนักงานทดสอบ'); set('nid-email', 'somchai@example.org');
        set('nid-pw', 'secret123'); set('nid-pw2', 'secret123');
        document.querySelector('#dlg-new-id button[value="ok"]').click(); })()`);
    check('Digital ID created', await waitFor(win, `!document.getElementById('cs-id').hidden && document.getElementById('cs-id').options.length === 1`, 30000), await toastText());

    const signed1 = path.join(outDir, 'signed1.pdf');
    setSavePath(signed1);
    await js(`document.getElementById('cs-password').value = 'wrong-pw'; document.getElementById('cs-reason').value = 'อนุมัติ'; document.querySelector('#dlg-certsign button[value="ok"]').click()`);
    check('wrong Digital ID password is refused', await waitFor(win, `/รหัสผ่าน Digital ID ไม่ถูกต้อง/.test(document.getElementById('toast').textContent)`, 30000), await toastText());

    // Again with the right password (invisible this time is fine for the retry).
    await js(`document.querySelector('[data-action="cert-sign"]').click()`);
    await waitFor(win, `document.getElementById('dlg-cs-where').open`);
    await js(`document.getElementById('cs-invisible').click()`);
    await waitFor(win, `document.getElementById('dlg-certsign').open`);
    await js(`document.getElementById('cs-password').value = 'secret123'; document.getElementById('cs-reason').value = 'อนุมัติ'; document.querySelector('#dlg-certsign button[value="ok"]').click()`);
    check('signed file saved', await waitFile(signed1));
    check('signed file reopened', await waitFor(win, `document.getElementById('file-name').textContent === 'signed1.pdf'`, 20000));
    check('banner: signed and valid', await waitFor(win, `document.getElementById('sig-banner').dataset.status === 'valid' && !document.getElementById('sig-banner').hidden`, 20000), await banner());
    await js(`document.getElementById('sig-banner-open').click()`);
    const panel = await js(`document.getElementById('sig-list').textContent`);
    check('signature panel shows signer and reason', panel.includes('สมชาย ใจดี') && panel.includes('อนุมัติ'), panel.slice(0, 120));

    // ---- a second, visible signature keeps the first one valid ---------------------
    await js(`document.querySelector('[data-action="cert-sign"]').click()`);
    await waitFor(win, `document.getElementById('dlg-cs-where').open`);
    await js(`document.querySelector('#dlg-cs-where button[value="ok"]').click()`);
    await js(`document.getElementById('viewer').scrollTop = 0`);
    await sleep(400);
    const r2 = await js(`(() => { const p = document.querySelectorAll('.page')[0].getBoundingClientRect();
        return { x: Math.round(p.left + p.width * 0.1), y: Math.round(Math.max(p.top, 60) + 420) }; })()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: r2.x, y: r2.y, button: 'left', clickCount: 1 });
    for (let s = 1; s <= 5; s++) {
        win.webContents.sendInputEvent({ type: 'mouseMove', x: r2.x + s * 56, y: r2.y + s * 18, button: 'left' });
        await sleep(30);
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: r2.x + 280, y: r2.y + 90, button: 'left', clickCount: 1 });
    await waitFor(win, `document.getElementById('dlg-certsign').open`);
    const signed2 = path.join(outDir, 'signed2.pdf');
    setSavePath(signed2);
    await js(`document.getElementById('cs-password').value = 'secret123'; document.getElementById('cs-reason').value = 'ตรวจแล้ว'; document.querySelector('#dlg-certsign button[value="ok"]').click()`);
    check('second signature saved', await waitFile(signed2));
    await waitFor(win, `document.getElementById('file-name').textContent === 'signed2.pdf'`, 20000);
    check('two signatures listed', await waitFor(win, `document.querySelectorAll('#sig-list .sig-item').length === 2`, 20000));
    const statuses = await js(`[...document.querySelectorAll('#sig-list .sig-item')].map((li) => li.dataset.status).join(',')`);
    check('both signatures verify (first: changed after, second: valid)', statuses === 'changed,valid', statuses);
    const orig = fs.readFileSync(signed1);
    check('second signature appended without touching the first file bytes', fs.readFileSync(signed2).subarray(0, orig.length).equals(orig));
    await sleep(1000);
    fs.writeFileSync(path.join(outDir, 'signed.png'), (await win.capturePage()).toPNG());

    // ---- tampering is detected ---------------------------------------------------------
    const tampered = path.join(outDir, 'tampered.pdf');
    const bytes = Buffer.from(fs.readFileSync(signed1));
    const at = bytes.indexOf('/Producer');
    const target = at > 0 ? at + 1 : 20;
    bytes[target] = bytes[target] === 0x50 ? 0x51 : 0x50; // P -> Q, inside the signed range
    fs.writeFileSync(tampered, bytes);
    await open(tampered);
    check('tampered file: signature invalid', await waitFor(win, `document.getElementById('sig-banner').dataset.status === 'invalid'`, 20000), await banner());

    // ---- unsigned file: no banner ---------------------------------------------------------
    await open(inputPdf);
    check('unsigned file has no signature banner', await waitFor(win, `document.getElementById('sig-banner').hidden`, 10000));

    // ---- compare files ------------------------------------------------------------------------
    const v2 = path.join(outDir, 'thai-v2.pdf');
    await makeVersion2(v2);
    await open(v2);
    setOpenPaths([inputPdf]);
    await js(`document.querySelector('[data-action="show-thumbs"]').click()`);
    win.webContents.send('menu:command', 'compare');
    check('compare dialog opens', await waitFor(win, `document.getElementById('dlg-compare').open`));
    await js(`document.querySelector('#dlg-compare button[value="ok"]').click()`);
    check('compare finished', await waitFor(win, `/พบความแตกต่าง|ตรงกัน/.test(document.getElementById('toast').textContent) && !document.getElementById('dlg-progress').open`, 30000), await toastText());
    const list = await js(`document.getElementById('cmp-list').textContent`);
    const summary = await js(`document.getElementById('cmp-summary').textContent`);
    check('compare lists the changed Thai word', list.includes('ใหม่') && list.includes('พิเศษ'), `${summary} | ${list.slice(0, 160)}`);
    check('compare lists the added sentence', list.includes('ในฉบับแก้ไข'));
    check('changed words are marked on the page', await waitFor(win, `document.querySelectorAll('.textLayer .compare-diff').length > 0`, 10000));
    await sleep(600);
    fs.writeFileSync(path.join(outDir, 'compare.png'), (await win.capturePage()).toPNG());
};

// thai.pdf with one word changed on page 2 and a sentence added on page 3.
async function makeVersion2(file) {
    const win = new BrowserWindow({ show: false });
    const body = [1, 2, 3].map((n) => `
        <section>
            <h1>หน้าที่ ${n}: ทดสอบภาษาไทย</h1>
            <p>ภาษาไทยเป็นภาษาที่มีสระบน สระล่าง และวรรณยุกต์ เช่น น้ำ ผู้ใหญ่ กำลัง ปฏิบัติ ฤดูกาล</p>
            <p>The quick brown fox jumps over the lazy dog. ${n === 2 ? 'คำค้นหาใหม่2' : `คำค้นหาพิเศษ${n}`}</p>
            ${n === 3 ? '<p>ประโยคที่เพิ่มเข้ามาในฉบับแก้ไข</p>' : ''}
        </section>`).join('');
    const html = `<!doctype html><meta charset="utf-8"><style>
        body{font-family:Tahoma,'Leelawadee UI',sans-serif;font-size:20px}
        section{page-break-after:always}</style>${body}`;
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    fs.writeFileSync(file, await win.webContents.printToPDF({ pageSize: 'A4' }));
    win.destroy();
}
