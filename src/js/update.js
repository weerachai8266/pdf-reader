// Status-bar notice for background updates (see main/updater.js).

const $ = (id) => document.getElementById(id);

export function initUpdateNotice() {
    let version = '';
    window.host.onUpdateStatus((status) => {
        if (status.version) version = status.version;
        $('update-notice').hidden = false;
        if (status.state === 'downloading') {
            const pct = status.percent != null ? ` ${status.percent}%` : '';
            $('update-text').textContent = `กำลังดาวน์โหลดเวอร์ชันใหม่ v${version}${pct}`;
            $('update-install').hidden = true;
        } else if (status.state === 'ready') {
            $('update-text').textContent = `v${version} พร้อมติดตั้ง (จะติดตั้งเองเมื่อปิดโปรแกรม)`;
            $('update-install').hidden = false;
        }
    });
    $('update-install').addEventListener('click', () => window.host.installUpdate());
}
