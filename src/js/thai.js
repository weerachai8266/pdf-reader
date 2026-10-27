// Text normalisation for searching and copying Thai PDFs.
//
// Thai PDFs are often "broken" in predictable ways: SARA AM stored as
// NIKHAHIT + SARA AA, legacy PUA glyphs for shifted vowels/tone marks,
// zero-width characters between glyphs, and tone marks that lost their
// Unicode mapping and come out as U+0000. We normalise page text and the
// query the same way so they still match.

const PUA_MAP = new Map([
    // Common Thai PUA glyphs (Mac/Windows legacy fonts) back to real code points.
    [0xf700, 0x0e10], [0xf701, 0x0e34], [0xf702, 0x0e35], [0xf703, 0x0e36],
    [0xf704, 0x0e37], [0xf705, 0x0e48], [0xf706, 0x0e49], [0xf707, 0x0e4a],
    [0xf708, 0x0e4b], [0xf709, 0x0e4c], [0xf70a, 0x0e48], [0xf70b, 0x0e49],
    [0xf70c, 0x0e4a], [0xf70d, 0x0e4b], [0xf70e, 0x0e4c], [0xf70f, 0x0e0d],
    [0xf710, 0x0e31], [0xf711, 0x0e4d], [0xf712, 0x0e47], [0xf713, 0x0e48],
    [0xf714, 0x0e49], [0xf715, 0x0e4a], [0xf716, 0x0e4b], [0xf717, 0x0e4c],
    [0xf718, 0x0e38], [0xf719, 0x0e39], [0xf71a, 0x0e3a],
]);

const DROP = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u00ad\u200b-\u200d\ufeff]/g;
const TONE_MARKS = /[\u0e48-\u0e4b]/g;

function fixGlyphs(str) {
    let out = '';
    for (const ch of str.normalize('NFC')) {
        const cp = ch.codePointAt(0);
        out += PUA_MAP.has(cp) ? String.fromCodePoint(PUA_MAP.get(cp)) : ch;
    }
    return out
        .replace(DROP, '')
        // Tone mark typed before NIKHAHIT + SARA AA, or plain NIKHAHIT + SARA AA.
        .replace(/([\u0e48-\u0e4b]?)\u0e4d\u0e32/g, '$1\u0e33');
}

// Strict form: exact Thai spelling, case- and whitespace-insensitive.
export function normalizeText(str) {
    return fixGlyphs(str).replace(/\s+/g, ' ').toLowerCase();
}

// Loose form: also ignores tone marks, for PDFs whose tone marks were lost.
export function looseText(str) {
    return normalizeText(str).replace(TONE_MARKS, '');
}

// Clean text copied out of the text layer.
export function cleanCopiedText(str) {
    return fixGlyphs(str);
}
