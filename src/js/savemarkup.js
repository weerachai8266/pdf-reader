// Writes ink markup (underline, strikethrough, shapes, text boxes) into a
// page when saving. Like highlights, everything is flattened into the page
// content, so every viewer and printer shows it the same way.

import { SHAPE_LINE_WIDTH_PT } from './config.js';
import { inkRgb } from './colors.js';
import { quadFrame, markLine, arrowHead, TEXTBOX } from './annotgeom.js';

export const MARKUP_TYPES = new Set(['underline', 'strike', 'shape', 'textbox']);

// fontFor(text): an embedded font that can draw `text`.
export async function drawMarkup(lib, page, annot, fontFor) {
    const color = lib.rgb(...inkRgb(annot.color));
    if (annot.type === 'underline' || annot.type === 'strike') {
        for (const quad of annot.quads) {
            const f = quadFrame(quad);
            const { y0, t } = markLine(annot.type, f.height, 0.6);
            const [x, y] = f.at(0, y0);
            page.drawRectangle({ x, y, width: f.width, height: t, rotate: lib.degrees(f.angle), color });
        }
    } else if (annot.type === 'shape') {
        drawShape(lib, page, annot, color);
    } else if (annot.type === 'textbox') {
        await drawTextbox(lib, page, annot, color, fontFor);
    }
}

function drawShape(lib, page, annot, color) {
    const w = SHAPE_LINE_WIDTH_PT;
    if (annot.shape === 'rect' || annot.shape === 'ellipse') {
        const f = quadFrame(annot.quad);
        if (annot.shape === 'rect') {
            page.drawRectangle({ x: f.x, y: f.y, width: f.width, height: f.height, rotate: lib.degrees(f.angle), borderColor: color, borderWidth: w });
        } else {
            const [cx, cy] = f.at(f.width / 2, f.height / 2);
            page.drawEllipse({ x: cx, y: cy, xScale: f.width / 2, yScale: f.height / 2, rotate: lib.degrees(f.angle), borderColor: color, borderWidth: w });
        }
        return;
    }
    const line = (a, b) => page.drawLine({
        start: { x: a[0], y: a[1] },
        end: { x: b[0], y: b[1] },
        thickness: w,
        color,
        lineCap: lib.LineCapStyle.Round,
    });
    line(annot.from, annot.to);
    if (annot.shape === 'arrow') {
        for (const corner of arrowHead(annot.from, annot.to, w)) line(corner, annot.to);
    }
}

// White box with an ink border and ink text, laid out like the on-screen
// box in markup.js (same font, padding and line height).
async function drawTextbox(lib, page, annot, color, fontFor) {
    const f = quadFrame(annot.quad);
    page.drawRectangle({
        x: f.x,
        y: f.y,
        width: f.width,
        height: f.height,
        rotate: lib.degrees(f.angle),
        color: lib.rgb(1, 1, 1),
        borderColor: color,
        borderWidth: TEXTBOX.border,
    });
    const font = await fontFor(annot.text);
    annot.text.split('\n').forEach((text, i) => {
        if (!text) return;
        const [x, y] = f.at(TEXTBOX.pad, f.height - TEXTBOX.pad - annot.size * (TEXTBOX.baseline + TEXTBOX.lineHeight * i));
        page.drawText(text, { x, y, size: annot.size, font, color, rotate: lib.degrees(f.angle) });
    });
}
