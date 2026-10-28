// Geometry shared by the annotation tools (annotate.js, markup.js) and the
// code that writes them into the PDF (savemarkup.js).
//
// A "quad" is three PDF-space points taken from the on-screen box an
// annotation was created in: bottom-left, bottom-right and top-left as the
// user saw them. Mapping those back through any viewport gives position,
// size and on-screen angle, so annotations survive zooming and page
// rotation, and can be drawn upright when saved.

export function quadFromViewRect(viewport, left, top, right, bottom) {
    return {
        bl: viewport.convertToPdfPoint(left, bottom),
        br: viewport.convertToPdfPoint(right, bottom),
        tl: viewport.convertToPdfPoint(left, top),
    };
}

// The quad as a view box: bottom-left anchor (x, y), size, and angle.
export function quadToView(viewport, quad) {
    const [blx, bly] = viewport.convertToViewportPoint(...quad.bl);
    const [brx, bry] = viewport.convertToViewportPoint(...quad.br);
    const [tlx, tly] = viewport.convertToViewportPoint(...quad.tl);
    return {
        x: blx,
        y: bly,
        w: Math.hypot(brx - blx, bry - bly),
        h: Math.hypot(tlx - blx, tly - bly),
        angle: Math.atan2(bry - bly, brx - blx),
    };
}

// Inverse of quadToView.
export function quadFromBox(viewport, box) {
    const cos = Math.cos(box.angle);
    const sin = Math.sin(box.angle);
    return {
        bl: viewport.convertToPdfPoint(box.x, box.y),
        br: viewport.convertToPdfPoint(box.x + box.w * cos, box.y + box.w * sin),
        tl: viewport.convertToPdfPoint(box.x + box.h * sin, box.y - box.h * cos),
    };
}

export function placeBox(el, box) {
    el.style.left = `${box.x}px`;
    el.style.top = `${box.y - box.h}px`;
    el.style.width = `${box.w}px`;
    el.style.height = `${box.h}px`;
    el.style.setProperty('--angle', `${box.angle}rad`);
}

// A horizontal band of a view box, `y0` up from its bottom edge, `h` tall.
export function subBox(box, y0, h) {
    return { ...box, x: box.x + y0 * Math.sin(box.angle), y: box.y - y0 * Math.cos(box.angle), h };
}

export function pointInPage(view, clientX, clientY) {
    const r = view.div.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top, rect: r };
}

// The quad in PDF space: origin, size, angle (degrees, counter-clockwise),
// and at(x, y) mapping box-local coordinates to PDF points.
export function quadFrame(quad) {
    const [x, y] = quad.bl;
    const width = Math.hypot(quad.br[0] - x, quad.br[1] - y);
    const height = Math.hypot(quad.tl[0] - x, quad.tl[1] - y);
    const ux = width ? (quad.br[0] - x) / width : 1;
    const uy = width ? (quad.br[1] - y) / width : 0;
    const vx = height ? (quad.tl[0] - x) / height : 0;
    const vy = height ? (quad.tl[1] - y) / height : 1;
    return {
        x,
        y,
        width,
        height,
        angle: (Math.atan2(quad.br[1] - y, quad.br[0] - x) * 180) / Math.PI,
        at: (lx, ly) => [x + ux * lx + vx * ly, y + uy * lx + vy * ly],
        u: [ux, uy],
        v: [vx, vy],
    };
}

// Every point of an annotation moved by (dx, dy) in PDF space.
export function shiftAnnot(annot, dx, dy) {
    const move = ([x, y]) => [x + dx, y + dy];
    const patch = {};
    if (annot.quad) patch.quad = { bl: move(annot.quad.bl), br: move(annot.quad.br), tl: move(annot.quad.tl) };
    if (annot.from) patch.from = move(annot.from);
    if (annot.to) patch.to = move(annot.to);
    return patch;
}

// ---- underline / strikethrough ---------------------------------------------

// Where the line sits inside a text line box of height h: bottom offset
// and thickness, in the same units as h (minimum thickness `min`).
export function markLine(type, h, min) {
    const t = Math.max(h * 0.07, min);
    return { y0: type === 'underline' ? h * 0.06 : h * 0.45 - t / 2, t };
}

// ---- arrows ------------------------------------------------------------------

const HEAD_ANGLE = Math.PI / 7;

// The two back corners of an arrowhead at `to`, for a line of width w.
// Works in any coordinate system that is not mirrored differently per
// axis, so the same call serves the screen and the PDF.
export function arrowHead(from, to, w) {
    const len = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1;
    const dx = (to[0] - from[0]) / len;
    const dy = (to[1] - from[1]) / len;
    const size = Math.min(w * 5, len * 0.6);
    const corner = (a) => [
        to[0] - size * (dx * Math.cos(a) - dy * Math.sin(a)),
        to[1] - size * (dx * Math.sin(a) + dy * Math.cos(a)),
    ];
    return [corner(HEAD_ANGLE), corner(-HEAD_ANGLE)];
}

// ---- text boxes -----------------------------------------------------------

// All in points except LINE_HEIGHT (a multiple of the font size).
// BASELINE is where the first baseline sits below the top padding, as a
// multiple of the font size, matching CSS line-height 1.3 with Tahoma.
export const TEXTBOX = { pad: 4, border: 1, lineHeight: 1.3, baseline: 1.05, font: 'Tahoma' };

let measureCtx = null;

// Size of a text box for `text` at `size` pt, in points.
export function textboxSize(text, size) {
    measureCtx ??= document.createElement('canvas').getContext('2d');
    measureCtx.font = `${size}px ${TEXTBOX.font}`;
    const lines = text.split('\n');
    const width = Math.max(...lines.map((l) => measureCtx.measureText(l).width), size);
    return {
        w: width + 2 * TEXTBOX.pad + size * 0.2,
        h: lines.length * size * TEXTBOX.lineHeight + 2 * TEXTBOX.pad,
    };
}

// Resizes a text box quad to (w, h) points, keeping its top-left corner.
export function resizeQuadFromTop(quad, w, h) {
    const f = quadFrame(quad);
    const bl = [quad.tl[0] - f.v[0] * h, quad.tl[1] - f.v[1] * h];
    return { tl: quad.tl, bl, br: [bl[0] + f.u[0] * w, bl[1] + f.u[1] * w] };
}
