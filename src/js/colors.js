// Annotation colours. A colour is either a preset name from config.js
// ('yellow', 'red', ...) or a '#rrggbb' string picked with More Colors.

import { HIGHLIGHT_COLORS, INK_COLORS } from './config.js';

const HEX = /^#[0-9a-f]{6}$/i;

export function isCustomColor(color) {
    return typeof color === 'string' && HEX.test(color);
}

// '#rrggbb' -> [r, g, b] in 0..1, as pdf-lib's rgb() takes them.
export function hexToRgb(hex) {
    return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
}

export function highlightRgb(color) {
    return HIGHLIGHT_COLORS[color] || (isCustomColor(color) ? hexToRgb(color) : HIGHLIGHT_COLORS.yellow);
}

export function inkRgb(color) {
    return INK_COLORS[color] || (isCustomColor(color) ? hexToRgb(color) : INK_COLORS.red);
}

// Colours an on-screen annotation element. Presets use their class
// (`hl-yellow`, `ink-red`); a custom colour gets `<prefix>-custom` plus the
// colour in the `--<prefix>` custom property that class reads.
export function paintColor(el, prefix, color) {
    if (isCustomColor(color)) {
        el.classList.add(`${prefix}-custom`);
        el.style.setProperty(`--${prefix}`, color);
    } else {
        el.classList.add(`${prefix}-${color}`);
    }
}
