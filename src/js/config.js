// Single source for tunable values used across the renderer.
export const PAGE_SIZE = 30;

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 5;
export const ZOOM_STEP = 1.2;

// How far outside the viewport pages start rendering (and stay rendered).
export const RENDER_MARGIN = '150% 0px';

export const HIGHLIGHT_COLORS = {
    yellow: [1, 0.92, 0.23],
    green: [0.55, 0.9, 0.45],
    pink: [1, 0.55, 0.75],
    blue: [0.5, 0.78, 1],
};
export const HIGHLIGHT_OPACITY = 0.4;

export const NOTE_ICON_PX = 26;
export const SIGNATURE_DEFAULT_WIDTH_PT = 150;

// Underline, strikethrough, shapes and text boxes.
export const INK_COLORS = {
    red: [0.85, 0.1, 0.1],
    blue: [0.1, 0.3, 0.85],
    green: [0.1, 0.55, 0.2],
    black: [0.1, 0.1, 0.1],
};
export const SHAPE_LINE_WIDTH_PT = 2;
export const TEXTBOX_FONT_PT = 12;
// Stamps are drawn on a canvas; this maps its pixels to points on the page.
export const STAMP_PX_TO_PT = 0.3;
