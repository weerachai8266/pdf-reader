// Tools > Sign with Certificate: drag where the signature goes (or sign
// invisibly), pick a Digital ID, and the signed file is saved and reopened.

import { on } from './bus.js';
import { state } from './docstate.js';
import { setTool } from './annotate.js';
import { buildPdf, embedThaiFont, willRewriteFile } from './save.js';
import { isEncrypted } from './qpdf.js';
import { prepareSignature, insertSignature } from './pdfsig.js';
import { hasSignatures } from './signatures.js';
import { siblingPath } from './extract.js';
import { showFormDialog, promptText, confirmDialog, progressDialog, toast } from './dialog.js';

const $ = (id) => document.getElementById(id);
let reopen = null;

export function initCertSign(reopenFile) {
    reopen = reopenFile;
    on('cert-sign-area', ({ entry, quad }) => {
        setTool('select');
        signDocument(entry, quad);
    });
    $('cs-new-id').addEventListener('click', createId);
    $('cs-import-id').addEventListener('click', importId);
    $('cs-invisible').addEventListener('click', () => {
        $('dlg-cs-where').close('invisible');
    });
}

// Step 1: where. Drag a box on a page, or choose an invisible signature.
export async function startCertSign() {
    if (!(await checkCanSign())) return;
    const dlg = $('dlg-cs-where');
    dlg.returnValue = '';
    dlg.showModal();
    const choice = await new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue), { once: true }));
    if (choice === 'ok') {
        setTool('certsign');
        toast('ลากกรอบบนหน้าตรงตำแหน่งที่จะวางลายเซ็น (Esc เพื่อยกเลิก)');
    } else if (choice === 'invisible') {
        signDocument(null, null);
    }
}

async function checkCanSign() {
    if (hasSignatures() && willRewriteFile()) {
        return confirmDialog({
            title: 'เอกสารนี้มีลายเซ็นดิจิทัลอยู่แล้ว',
            message: 'การแก้ไขที่ยังไม่ได้บันทึก (เช่น ไฮไลต์ จัดหน้า) จะทำให้ลายเซ็นเดิมใช้ไม่ได้ ถ้าต้องการให้ลายเซ็นเดิมยังถูกต้อง ให้เปิดไฟล์ใหม่โดยไม่บันทึกการแก้ไข แล้วจึงเซ็น ต้องการเซ็นต่อหรือไม่?',
            okLabel: 'Sign Anyway',
        });
    }
    return true;
}

async function fillIds(selectId = null) {
    const ids = await window.host.sigListIds();
    const select = $('cs-id');
    select.replaceChildren(...ids.map((id) => {
        const o = document.createElement('option');
        o.value = id.id;
        o.textContent = `${id.label || id.name}${id.selfSigned ? '' : ` — ${id.issuer.split(',')[0]}`}`;
        o.dataset.name = id.name;
        return o;
    }));
    if (selectId) select.value = selectId;
    $('cs-no-ids').hidden = ids.length > 0;
    select.hidden = !ids.length;
    return ids;
}

async function createId() {
    for (const k of ['nid-name', 'nid-org', 'nid-email', 'nid-pw', 'nid-pw2']) $(k).value = '';
    const ok = await showFormDialog('dlg-new-id', () => {
        if (!$('nid-name').value.trim()) return 'กรอกชื่อ';
        if ($('nid-pw').value.length < 6) return 'รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร';
        if ($('nid-pw').value !== $('nid-pw2').value) return 'รหัสผ่านทั้งสองช่องไม่ตรงกัน';
        return null;
    });
    if (!ok) return;
    const res = await window.host.sigCreateId({
        name: $('nid-name').value.trim(),
        org: $('nid-org').value.trim(),
        email: $('nid-email').value.trim(),
        password: $('nid-pw').value,
    });
    if (res.error) return toast(`สร้าง Digital ID ไม่สำเร็จ: ${res.error}`, 'error');
    await fillIds(res.id.id);
    toast(`สร้าง Digital ID "${res.id.name}" แล้ว`);
}

async function importId() {
    const password = await promptText({ title: 'Import Digital ID', label: 'รหัสผ่านของไฟล์ .pfx / .p12 (กรอกก่อน แล้วเลือกไฟล์)', password: true });
    if (password === null) return;
    const res = await window.host.sigImportId({ password });
    if (res.cancelled) return;
    if (res.error) return toast(`นำเข้า Digital ID ไม่สำเร็จ: ${res.error}`, 'error');
    await fillIds(res.id.id);
    toast(`นำเข้า Digital ID "${res.id.name}" แล้ว`);
}

function quadRect(quad) {
    const tr = [quad.br[0] + quad.tl[0] - quad.bl[0], quad.br[1] + quad.tl[1] - quad.bl[1]];
    const xs = [quad.bl[0], quad.br[0], quad.tl[0], tr[0]];
    const ys = [quad.bl[1], quad.br[1], quad.tl[1], tr[1]];
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// Step 2: which ID, then sign, save and reopen.
async function signDocument(entry, quad) {
    await fillIds();
    $('cs-password').value = '';
    const ok = await showFormDialog('dlg-certsign', () => {
        if (!$('cs-id').value) return 'เลือกหรือสร้าง Digital ID ก่อน';
        if (!$('cs-password').value) return 'กรอกรหัสผ่านของ Digital ID';
        return null;
    });
    if (!ok) return;
    const idOption = $('cs-id').selectedOptions[0];
    const progress = progressDialog('Sign with Certificate');
    try {
        progress.update('กำลังเตรียมเอกสาร…', null);
        const { data } = await buildPdf();
        if (await isEncrypted(data)) throw new Error('ไฟล์นี้มีรหัสผ่าน ให้ใช้ Document → Remove Security ก่อน');
        const pageIndex = entry ? state.pages.indexOf(entry) : 0;
        const prepared = await prepareSignature(data, {
            pageIndex,
            rect: quad ? quadRect(quad) : null,
            signerName: idOption.dataset.name,
            reason: $('cs-reason').value.trim(),
            location: $('cs-location').value.trim(),
            embedFont: embedThaiFont,
        });
        progress.update('กำลังเซ็น…', null);
        const res = await window.host.sigSign({ id: idOption.value, password: $('cs-password').value, data: prepared.data, ranges: prepared.ranges });
        if (res.error) throw new Error(res.error);
        const signed = insertSignature(prepared, res.signature);
        progress.close();
        const stem = (state.fileName || 'document.pdf').replace(/\.pdf$/i, '');
        const saved = await window.host.save({ data: signed, filePath: null, suggestedName: siblingPath(`${stem}_signed.pdf`) });
        if (!saved) return toast('ยังไม่ได้บันทึก เอกสารที่เซ็นแล้วจึงไม่ถูกเก็บ', 'error');
        await reopen({ path: saved.path, name: saved.name, data: signed });
        toast(`เซ็นและบันทึกแล้ว: ${saved.name}`);
    } catch (err) {
        console.error(err);
        toast(`เซ็นไม่สำเร็จ: ${err?.message || err}`, 'error');
    } finally {
        progress.close();
    }
}
