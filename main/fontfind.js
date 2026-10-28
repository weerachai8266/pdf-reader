'use strict';

// Finds an installed font by the name a PDF gives it (BaseFont such as
// "THSarabunNew-Bold", "ArialMT", "Tahoma,Bold"), for Edit Text when the
// font embedded in the PDF lacks the characters the user typed. Fonts are
// looked up in the machine and per-user font lists in the registry (fonts
// installed "for this user only" live outside C:\Windows\Fonts).

const { ipcMain } = require('electron');
const { execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');

const KEY = 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts';
const FONTS_DIR = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');

let installed = null; // Promise<Map(normalized name -> { name, file })>

function regQuery(hive) {
    return new Promise((resolve) => {
        execFile('reg', ['query', `${hive}\\${KEY}`], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
    });
}

// "TH Sarabun New Bold" / "THSarabunNew-Bold" / "ArialMT" -> "thsarabunnewbold" / "arial"
function normalize(name) {
    return name
        .replace(/^[A-Z]{6}\+/, '')
        .replace(/\s*\((TrueType|OpenType)\)\s*$/i, '')
        .replace(/[,\-_ ]/g, '')
        .replace(/(PSMT|MT|PS)$/i, '')
        .replace(/(PSMT|MT|PS)(?=(bold|italic|regular)+$)/i, '')
        .replace(/regular$/i, '')
        .toLowerCase();
}

async function loadInstalled() {
    const map = new Map();
    for (const hive of ['HKLM', 'HKCU']) {
        for (const line of (await regQuery(hive)).split(/\r?\n/)) {
            const m = line.match(/^\s+(.+?)\s+REG_SZ\s+(.+)$/);
            if (!m) continue;
            const file = path.isAbsolute(m[2]) ? m[2] : path.join(FONTS_DIR, m[2]);
            if (!/\.(ttf|otf)$/i.test(file)) continue; // .ttc collections can't be embedded
            // One registry entry may list several faces: "Arial & Arial Bold".
            for (const name of m[1].replace(/\s*\((TrueType|OpenType)\)\s*$/i, '').split(' & ')) {
                const key = normalize(name);
                if (key && !map.has(key)) map.set(key, { name, file });
            }
        }
    }
    return map;
}

// { name, bytes } for the installed font matching baseFont, or null.
async function findFont(baseFont, bold = false) {
    installed ??= loadInstalled();
    const fonts = await installed;
    const want = normalize(String(baseFont || ''));
    if (!want) return null;
    const family = want.replace(/(bold|italic|oblique)+$/, '');
    const isBold = bold || /bold/.test(want);
    const candidates = isBold ? [`${family}bold`, want] : [want, family];
    for (const key of candidates) {
        const hit = fonts.get(key);
        if (!hit) continue;
        try {
            return { name: hit.name, bytes: new Uint8Array(await fs.readFile(hit.file)) };
        } catch {}
    }
    return null;
}

function initFontFind() {
    ipcMain.handle('font:find', (_e, { baseFont, bold }) => findFont(baseFont, bold));
}

module.exports = { initFontFind, findFont, normalize };
