// Promise-based modal dialogs (Electron has no window.prompt).

const $ = (id) => document.getElementById(id);

export function promptText({ title, label, value = '', multiline = false, allowDelete = false, password = false }) {
    const dlg = $('dlg-prompt');
    const input = multiline ? $('dlg-prompt-textarea') : $('dlg-prompt-input');
    $('dlg-prompt-title').textContent = title;
    $('dlg-prompt-label').textContent = label;
    $('dlg-prompt-input').hidden = multiline;
    $('dlg-prompt-textarea').hidden = !multiline;
    $('dlg-prompt-input').type = password ? 'password' : 'text';
    $('dlg-prompt-delete').hidden = !allowDelete;
    input.value = value;

    return new Promise((resolve) => {
        const finish = (result) => {
            dlg.removeEventListener('close', onClose);
            form.removeEventListener('submit', onSubmit);
            $('dlg-prompt-delete').removeEventListener('click', onDelete);
            $('dlg-prompt-cancel').removeEventListener('click', onClose);
            input.removeEventListener('keydown', onKey);
            if (dlg.open) dlg.close();
            resolve(result);
        };
        const form = $('dlg-prompt-form');
        const onSubmit = (e) => {
            e.preventDefault();
            finish(input.value.trim());
        };
        const onDelete = () => finish('');
        const onClose = () => finish(null);
        // Ctrl+Enter submits a multi-line note.
        const onKey = (e) => {
            if (multiline && e.key === 'Enter' && e.ctrlKey) onSubmit(e);
        };
        form.addEventListener('submit', onSubmit);
        $('dlg-prompt-delete').addEventListener('click', onDelete);
        $('dlg-prompt-cancel').addEventListener('click', onClose);
        dlg.addEventListener('close', onClose);
        input.addEventListener('keydown', onKey);
        dlg.showModal();
        input.focus();
        input.select();
    });
}

export function confirmDialog({ title, message, okLabel = 'ตกลง' }) {
    const dlg = $('dlg-confirm');
    $('dlg-confirm-title').textContent = title;
    $('dlg-confirm-message').textContent = message;
    $('dlg-confirm-ok').textContent = okLabel;
    dlg.returnValue = '';
    return new Promise((resolve) => {
        dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
        dlg.showModal();
    });
}

export async function askPassword(retry) {
    const pw = await promptText({
        title: 'ไฟล์นี้มีรหัสผ่าน',
        label: retry ? 'รหัสผ่านไม่ถูกต้อง ลองใหม่อีกครั้ง' : 'กรอกรหัสผ่านเพื่อเปิดไฟล์',
        password: true,
    });
    return pw ? pw : null;
}

let toastTimer = null;
export function toast(message, kind = 'info') {
    const el = $('toast');
    el.textContent = message;
    el.dataset.kind = kind;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        el.hidden = true;
    }, kind === 'error' ? 6000 : 2500);
}
