'use strict';

// Rasterises build/logo.svg into the app icons:
//   build/icon.ico  (16–256 px, PNG-compressed entries) — exe, installer, shortcuts
//   build/icon.png  (512 px) — window icon / fallback
//   src/img/logo.svg — copy used inside the UI
// Run with `npm run icons` after editing the logo.

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const SVG = path.join(ROOT, 'build', 'logo.svg');
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

function buildIco(pngs) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(pngs.length, 4);
    const dir = Buffer.alloc(16 * pngs.length);
    let offset = 6 + dir.length;
    pngs.forEach(({ size, data }, i) => {
        const o = i * 16;
        dir.writeUInt8(size >= 256 ? 0 : size, o);
        dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
        dir.writeUInt8(0, o + 2);
        dir.writeUInt8(0, o + 3);
        dir.writeUInt16LE(1, o + 4);
        dir.writeUInt16LE(32, o + 6);
        dir.writeUInt32LE(data.length, o + 8);
        dir.writeUInt32LE(offset, o + 12);
        offset += data.length;
    });
    return Buffer.concat([header, dir, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false });
    await win.loadURL('data:text/html,<!doctype html><body></body>');
    const svgUrl = 'data:image/svg+xml;base64,' + fs.readFileSync(SVG).toString('base64');
    const render = async (size) => {
        const dataUrl = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const c = document.createElement('canvas');
                c.width = c.height = ${size};
                const ctx = c.getContext('2d');
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(img, 0, 0, ${size}, ${size});
                resolve(c.toDataURL('image/png'));
            };
            img.onerror = reject;
            img.src = ${JSON.stringify(svgUrl)};
        })`);
        return Buffer.from(dataUrl.split(',')[1], 'base64');
    };

    const pngs = [];
    for (const size of ICO_SIZES) pngs.push({ size, data: await render(size) });
    fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), buildIco(pngs));
    fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), await render(512));
    fs.mkdirSync(path.join(ROOT, 'src', 'img'), { recursive: true });
    fs.copyFileSync(SVG, path.join(ROOT, 'src', 'img', 'logo.svg'));
    console.log('icons written');
    app.exit(0);
});
