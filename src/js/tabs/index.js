// Tab strip: shows the documents main/tabs.js reports and sends back
// clicks (activate, close, new tab). Each tab's document lives in its own view.

const ICONS = '../img/icons.svg';
const list = document.getElementById('tab-list');

function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `${ICONS}#i-${name}`);
    svg.append(use);
    return svg;
}

function render({ tabs, active }) {
    list.replaceChildren(...tabs.map((t) => {
        const tab = document.createElement('div');
        tab.className = 'tab';
        tab.role = 'tab';
        tab.dataset.id = t.id;
        tab.setAttribute('aria-selected', String(t.id === active));
        tab.title = t.path || t.name || 'New Tab';
        const name = document.createElement('span');
        name.className = 'tab-name';
        name.textContent = t.name || 'New Tab';
        tab.append(icon('file-text'), name);
        if (t.dirty) {
            const dot = document.createElement('span');
            dot.className = 'tab-dirty';
            dot.title = 'ยังไม่ได้บันทึก';
            tab.append(dot);
        }
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'tab-close';
        close.title = 'Close Tab (Ctrl+W)';
        close.setAttribute('aria-label', `Close ${t.name || 'New Tab'}`);
        close.append(icon('x'));
        tab.append(close);
        return tab;
    }));
}

list.addEventListener('mousedown', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab || e.target.closest('.tab-close')) return;
    if (e.button === 0) window.tabsHost.activate(Number(tab.dataset.id));
});
// Middle click closes, like a browser.
list.addEventListener('auxclick', (e) => {
    const tab = e.target.closest('.tab');
    if (tab && e.button === 1) window.tabsHost.close(Number(tab.dataset.id));
});
list.addEventListener('click', (e) => {
    const close = e.target.closest('.tab-close');
    if (close) window.tabsHost.close(Number(close.closest('.tab').dataset.id));
});
document.getElementById('tab-new').addEventListener('click', () => window.tabsHost.newTab());

window.tabsHost.onState(render);
window.tabsHost.ready();
