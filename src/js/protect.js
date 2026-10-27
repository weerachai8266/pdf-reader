// Document > Protect with Password / Remove Security (qpdf, AES-256).
//
// Protecting writes the encrypted file and then reopens it, so the window
// always shows what is on disk and a later Ctrl+S can't quietly write an
// unprotected copy over it.

import { state, replaceSource } from './docstate.js';
import { loadPdf, passwordOf } from './pdfjs.js';
import { buildPdf, sourceBytes } from './save.js';
import { encrypt, decrypt, isEncrypted, passwordKind } from './qpdf.js';
import { showFormDialog, promptText, progressDialog, toast } from './dialog.js';

const $ = (id) => document.getElementById(id);

function syncProtectForm() {
    const open = $('prot-open-on').checked;
    const perm = $('prot-perm-on').checked;
    for (const id of ['prot-open-pw', 'prot-open-pw2']) $(id).disabled = !open;
    for (const id of ['prot-perm-pw', 'prot-perm-pw2', 'prot-print', 'prot-modify', 'prot-copy']) $(id).disabled = !perm;
}

export function initProtect() {
    $('dlg-protect').addEventListener('change', syncProtectForm);
}

function validateProtect() {
    const open = $('prot-open-on').checked;
    const perm = $('prot-perm-on').checked;
    if (!open && !perm) return 'เลือกอย่างน้อย 1 อย่าง: รหัสผ่านเปิดไฟล์ หรือ จำกัดสิทธิ์';
    if (open) {
        if (!$('prot-open-pw').value) return 'กรอกรหัสผ่านสำหรับเปิดไฟล์';
        if ($('prot-open-pw').value !== $('prot-open-pw2').value) return 'รหัสผ่านเปิดไฟล์ทั้งสองช่องไม่ตรงกัน';
    }
    if (perm) {
        if (!$('prot-perm-pw').value) return 'กรอกรหัสผ่านสำหรับเปลี่ยนสิทธิ์';
        if ($('prot-perm-pw').value !== $('prot-perm-pw2').value) return 'รหัสผ่านเปลี่ยนสิทธิ์ทั้งสองช่องไม่ตรงกัน';
        if (open && $('prot-perm-pw').value === $('prot-open-pw').value) return 'รหัสผ่านเปลี่ยนสิทธิ์ต้องไม่ซ้ำกับรหัสผ่านเปิดไฟล์';
    }
    return null;
}

// reopen(file, password): replaces the open document without asking.
export async function protectDocument(reopen) {
    for (const id of ['prot-open-pw', 'prot-open-pw2', 'prot-perm-pw', 'prot-perm-pw2']) $(id).value = '';
    syncProtectForm();
    if (!(await showFormDialog('dlg-protect', validateProtect))) return;

    const open = $('prot-open-on').checked;
    const perm = $('prot-perm-on').checked;
    const userPassword = open ? $('prot-open-pw').value : '';
    const ownerPassword = perm ? $('prot-perm-pw').value : userPassword;
    const perms = perm
        ? { print: $('prot-print').value, modify: $('prot-modify').value, extract: $('prot-copy').checked }
        : { print: 'full', modify: 'all', extract: true };

    const progress = progressDialog('Protect with Password');
    try {
        progress.update('กำลังเข้ารหัสเอกสาร (AES-256)…', null);
        const { data } = await buildPdf();
        if (await isEncrypted(data)) throw new Error('ไฟล์นี้มีรหัสผ่านอยู่แล้ว ให้ใช้ Remove Security ก่อนตั้งใหม่');
        const encrypted = await encrypt(data, { userPassword, ownerPassword, perms });
        progress.close();
        const saved = await window.host.save({ data: encrypted, filePath: null, suggestedName: state.filePath || state.fileName });
        if (!saved) return;
        await reopen({ path: saved.path, name: saved.name, data: encrypted }, userPassword);
        toast(open ? `ตั้งรหัสผ่านแล้ว: ${saved.name}` : `จำกัดสิทธิ์แล้ว: ${saved.name}`);
    } catch (err) {
        console.error(err);
        toast(`ตั้งรหัสผ่านไม่สำเร็จ: ${err?.message || err}`, 'error');
    } finally {
        progress.close();
    }
}

// Decrypts every encrypted source. Needs the permissions (owner) password
// unless the user already opened the file with it.
export async function removeSecurity() {
    let removed = 0;
    try {
        for (const src of [...state.sources.values()]) {
            const bytes = await sourceBytes(src);
            if (!(await isEncrypted(bytes))) continue;
            let password = passwordOf(src.pdf) ?? '';
            let retry = false;
            while ((await passwordKind(bytes, password)) !== 'owner') {
                const typed = await promptText({
                    title: 'Remove Security',
                    label: retry
                        ? 'รหัสผ่านไม่ถูกต้อง ต้องใช้รหัสผ่านเปลี่ยนสิทธิ์ (permissions password)'
                        : `"${src.name}" จำกัดสิทธิ์ไว้ กรอกรหัสผ่านเปลี่ยนสิทธิ์เพื่อปลดล็อก`,
                    password: true,
                });
                if (!typed) return;
                password = typed;
                retry = true;
            }
            const plain = await decrypt(bytes, password);
            replaceSource(src.id, { bytes: plain, pdf: await loadPdf(plain, async () => null) });
            removed++;
        }
        toast(removed ? 'ปลดรหัสผ่านแล้ว กด Save เพื่อบันทึกไฟล์ที่ไม่มีรหัสผ่าน' : 'เอกสารนี้ไม่มีการตั้งรหัสผ่านหรือจำกัดสิทธิ์');
    } catch (err) {
        console.error(err);
        toast(`ปลดรหัสผ่านไม่สำเร็จ: ${err?.message || err}`, 'error');
    }
}
