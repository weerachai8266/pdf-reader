// Toolbar colour swatches: the preset highlight and ink colours plus a
// More Colors swatch per palette that opens the system colour picker. The
// last picked custom colour of each palette is remembered on this PC.

import { setHighlightColor, setInkColor } from './annotate.js';

const STORE_KEY = 'customColors';

export function initSwatches() {
    const saved = loadSaved();
    document.querySelectorAll('.swatch[data-pick]').forEach((btn) => {
        const input = btn.nextElementSibling;
        if (saved[btn.dataset.pick]) showCustom(btn, saved[btn.dataset.pick]);
        // 'change' fires once when the picker closes with a new colour;
        // 'input' would fire while dragging and create a mark every time.
        input.addEventListener('change', () => {
            showCustom(btn, input.value);
            useColor(btn, input.value);
            saved[btn.dataset.pick] = input.value;
            save(saved);
        });
    });
}

// Called by the toolbar click delegation for any .swatch button.
export function onSwatchClick(btn) {
    if (btn.dataset.color) useColor(btn, btn.dataset.color);
    else if (btn.dataset.ink) useColor(btn, btn.dataset.ink);
    else if (btn.dataset.pick) {
        // The swatch already holds a colour: use it now; the picker then
        // lets the user change it.
        if (btn.dataset.value && btn.getAttribute('aria-pressed') !== 'true') useColor(btn, btn.dataset.value);
        btn.nextElementSibling.showPicker();
    }
}

function useColor(btn, color) {
    const palette = btn.closest('.color-swatches');
    palette.querySelectorAll('.swatch').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    if (palette.dataset.palette === 'ink') setInkColor(color);
    else setHighlightColor(color);
}

function showCustom(btn, color) {
    btn.dataset.value = color;
    btn.nextElementSibling.value = color;
    btn.style.setProperty('--swatch', color);
    btn.title = `More Colors… (${color})`;
}

function loadSaved() {
    try {
        return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
    } catch {
        return {};
    }
}

function save(colors) {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(colors));
    } catch {}
}
