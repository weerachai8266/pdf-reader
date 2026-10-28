// Signature verification UI: the status bar above the pages and the
// Signatures panel in the sidebar (like Acrobat's signature bar/panel).

import { state } from './docstate.js';
import { scrollToIndex } from './viewer.js';
import { findSignatures } from './pdfsig.js';
import { changesAfter } from './sigdiff.js';
import { icon } from './icons.js';
import { toast } from './dialog.js';

const $ = (id) => document.getElementById(id);
let checkSeq = 0;

const STATUS = {
    valid: { icon: 'shield-check', label: 'ลายเซ็นถูกต้อง' },
    changed: { icon: 'shield-check', label: 'ลายเซ็นถูกต้อง หลังเซ็นมีการกรอกฟอร์มหรือเพิ่มความเห็น แต่ไม่ได้แก้เนื้อหาเอกสาร' },
    modified: { icon: 'shield-alert', label: 'ลายเซ็นถูกต้องสำหรับฉบับที่เซ็น แต่เนื้อหาเอกสารถูกแก้ไขหลังจากเซ็น ฉบับที่เห็นอยู่จึงไม่ใช่ฉบับที่ผู้นี้เซ็น' },
    unknown: { icon: 'shield-alert', label: 'เอกสารไม่ถูกแก้ไขหลังเซ็น แต่ยังยืนยันตัวตนผู้เซ็นไม่ได้ (ใบรับรองไม่อยู่ในรายการที่เชื่อถือ)' },
    invalid: { icon: 'shield-x', label: 'ลายเซ็นไม่ถูกต้อง' },
};
const RANK = { valid: 0, changed: 1, unknown: 2, modified: 3, invalid: 4 };

// r.after: what was appended after this signature (sigdiff.js).
function statusOf(r) {
    if (!r.intact || !r.signatureOk) return 'invalid';
    if (r.after === 'modified') return 'modified';
    if (!r.trusted) return 'unknown';
    return r.after === 'filled' ? 'changed' : 'valid';
}

export function hasSignatures() {
    return (state.signatures?.length || 0) > 0;
}

export function initSignatures() {
    $('sig-banner-open').addEventListener('click', () => showSignaturePanel());
    $('sig-list').addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-sig]');
        if (!btn) return;
        const sig = state.signatures[Number(btn.dataset.sig)];
        if (btn.dataset.do === 'goto' && sig.pageIndex >= 0) scrollToIndex(sig.pageIndex);
        if (btn.dataset.do === 'trust' && sig.certDer) {
            await window.host.sigTrust(sig.certDer);
            toast(`เชื่อถือใบรับรองของ ${sig.cert?.name || 'ผู้เซ็น'} แล้ว`);
            checkSignatures();
        }
    });
}

export function showSignaturePanel() {
    document.querySelector('[data-action="show-signatures"]')?.click();
}

// Verifies the signatures of the open file (single source only: merged
// documents are a new file that nobody has signed yet).
export async function checkSignatures() {
    const my = ++checkSeq;
    state.signatures = [];
    render();
    if (state.sources.size !== 1) return;
    const [src] = state.sources.values();
    const found = await findSignatures(src.bytes);
    if (my !== checkSeq || !found.length) return;
    const results = await window.host.sigVerify({ data: src.bytes, sigs: found.map(({ ranges, contents }) => ({ ranges, contents })) });
    if (my !== checkSeq) return;
    let after = found.map(() => 'none');
    try {
        after = await changesAfter(src.bytes, found.map((f) => f.ranges[2] + f.ranges[3]));
    } catch {
        after = found.map(() => 'modified');
    }
    if (my !== checkSeq) return;
    state.signatures = found.map((f, i) => {
        const r = { ...(results[i] || {}), after: after[i] };
        if (r.coversWholeFile) r.after = 'none';
        return { ...f, ...r, status: statusOf(r) };
    });
    render();
}

function render() {
    const sigs = state.signatures || [];
    const tab = document.querySelector('[data-panel-tab="signatures"]');
    tab.hidden = !sigs.length;
    $('sig-banner').hidden = !sigs.length;
    $('sig-list').replaceChildren();
    $('sig-empty').hidden = sigs.length > 0;
    if (!sigs.length) {
        if (!document.querySelector('[data-panel="signatures"]').hidden) document.querySelector('[data-action="show-thumbs"]').click();
        return;
    }
    const worst = sigs.reduce((w, s) => (RANK[s.status] > RANK[w] ? s.status : w), 'valid');
    const banner = $('sig-banner');
    banner.dataset.status = worst;
    $('sig-banner-icon').replaceChildren(icon(STATUS[worst].icon));
    $('sig-banner-text').textContent = {
        valid: sigs.length > 1 ? `ลงนามแล้ว ${sigs.length} ลายเซ็น และลายเซ็นทั้งหมดถูกต้อง` : 'ลงนามแล้ว และลายเซ็นถูกต้อง',
        changed: 'ลงนามแล้ว ลายเซ็นทั้งหมดถูกต้อง หลังเซ็นมีการกรอกฟอร์มหรือเพิ่มความเห็น ดูรายละเอียดใน Signature Panel',
        modified: 'เนื้อหาเอกสารถูกแก้ไขหลังลงนาม ลายเซ็นบางรายการไม่ครอบคลุมฉบับที่เห็นอยู่ ดูรายละเอียดใน Signature Panel',
        unknown: 'ลงนามแล้ว แต่ยังยืนยันตัวตนผู้เซ็นอย่างน้อย 1 รายการไม่ได้',
        invalid: 'มีลายเซ็นที่ไม่ถูกต้อง เอกสารอาจถูกแก้ไขหลังเซ็น',
    }[worst];

    const fmt = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'medium' });
    sigs.forEach((s, i) => {
        const li = document.createElement('li');
        li.className = 'sig-item';
        li.dataset.status = s.status;
        const head = document.createElement('div');
        head.className = 'sig-head';
        const name = document.createElement('strong');
        name.textContent = s.cert?.name || s.signerName || s.name;
        head.append(icon(STATUS[s.status].icon), name);
        const status = document.createElement('p');
        status.className = 'sig-status';
        status.textContent = STATUS[s.status].label;
        const meta = document.createElement('dl');
        meta.className = 'sig-meta';
        const add = (k, v) => {
            if (!v) return;
            const dt = document.createElement('dt');
            dt.textContent = k;
            const dd = document.createElement('dd');
            dd.textContent = v;
            meta.append(dt, dd);
        };
        if (s.status === 'valid' && s.after === 'signed') add('หลังเซ็น', 'มีลายเซ็นถัดไปต่อท้าย ไม่มีการแก้เนื้อหา');
        add('เวลาที่เซ็น', s.signingTime ? fmt.format(new Date(s.signingTime)) : '');
        add('เหตุผล', s.reason);
        add('สถานที่', s.location);
        add('ผู้ออกใบรับรอง', s.cert ? (s.cert.selfSigned ? 'ออกเอง (self-signed)' : s.cert.issuer) : '');
        add('ใช้ได้ถึง', s.cert ? fmt.format(new Date(s.cert.validTo)) : '');
        add('ช่อง', `${s.name}${s.pageIndex >= 0 ? ` (หน้า ${s.pageIndex + 1})` : ''}`);
        add('ปัญหา', (s.problems || []).join(' / '));
        const actions = document.createElement('div');
        actions.className = 'sig-actions';
        if (s.pageIndex >= 0) actions.append(button('Go to Signature', i, 'goto'));
        if (s.status === 'unknown' && s.certDer) actions.append(button('Trust Certificate', i, 'trust'));
        li.append(head, status, meta, actions);
        $('sig-list').append(li);
    });
}

function button(label, i, what) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.dataset.sig = i;
    b.dataset.do = what;
    return b;
}
