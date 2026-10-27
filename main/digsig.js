'use strict';

// Certificate-based digital signatures (PAdES-style adbe.pkcs7.detached).
//
// Digital IDs are PKCS#12 files (.pfx/.p12): imported from a certificate
// authority, or self-signed ones created here (like Acrobat's "Create
// Digital ID"). They live in userData/digital-ids with a small .json next
// to each so the list can be shown without the password.
//
// The renderer builds the signature dictionary and widget as an
// incremental update with a zero-filled /Contents placeholder; this module
// only computes the CMS signature over the byte ranges, and verifies
// signatures of opened files.

const { app, dialog, ipcMain } = require('electron');
const crypto = require('node:crypto');
const tls = require('node:tls');
const path = require('node:path');
const fs = require('node:fs/promises');
const forge = require('node-forge');

const { asn1, pki, pkcs12, pkcs7 } = forge;

const OID = {
    data: '1.2.840.113549.1.7.1',
    signedData: '1.2.840.113549.1.7.2',
    contentType: '1.2.840.113549.1.9.3',
    messageDigest: '1.2.840.113549.1.9.4',
    signingTime: '1.2.840.113549.1.9.5',
};
const DIGESTS = {
    '1.3.14.3.2.26': 'sha1',
    '2.16.840.1.101.3.4.2.1': 'sha256',
    '2.16.840.1.101.3.4.2.2': 'sha384',
    '2.16.840.1.101.3.4.2.3': 'sha512',
};

const idsDir = () => path.join(app.getPath('userData'), 'digital-ids');
const trustDir = () => path.join(app.getPath('userData'), 'trusted-certs');

// ---- digital IDs ------------------------------------------------------------

function certInfo(cert) {
    const x = new crypto.X509Certificate(cert);
    const cn = /(?:^|\n)CN=([^\n]+)/.exec(x.subject)?.[1] || x.subject;
    return {
        name: cn,
        subject: x.subject.replace(/\n/g, ', '),
        issuer: x.issuer.replace(/\n/g, ', '),
        validFrom: new Date(x.validFrom).toISOString(),
        validTo: new Date(x.validTo).toISOString(),
        fingerprint: x.fingerprint256,
        selfSigned: x.subject === x.issuer,
    };
}

function forgeCertDer(cert) {
    return Buffer.from(asn1.toDer(pki.certificateToAsn1(cert)).getBytes(), 'binary');
}

// Opens a PKCS#12 file. Throws a Thai message on a wrong password.
function openP12(bytes, password) {
    let p12;
    try {
        p12 = pkcs12.pkcs12FromAsn1(asn1.fromDer(Buffer.from(bytes).toString('binary')), false, password);
    } catch (err) {
        if (/mac|password|Invalid/i.test(err.message)) throw new Error('รหัสผ่าน Digital ID ไม่ถูกต้อง');
        throw new Error(`อ่านไฟล์ Digital ID ไม่ได้ (${err.message})`);
    }
    const keyBags = [
        ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []),
        ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || []),
    ];
    const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || []).map((b) => b.cert).filter(Boolean);
    const key = keyBags.find((b) => b.key)?.key;
    if (!key || !certs.length) throw new Error('ไฟล์นี้ไม่มีกุญแจสำหรับเซ็น หรือใช้กุญแจชนิดที่ยังไม่รองรับ (รองรับ RSA)');
    // The signer certificate is the one whose public key matches the key.
    const signer = certs.find((c) => c.publicKey?.n && c.publicKey.n.equals(key.n)) || certs[0];
    return { key, signer, chain: certs };
}

async function listIds() {
    await fs.mkdir(idsDir(), { recursive: true });
    const out = [];
    for (const f of await fs.readdir(idsDir())) {
        if (!f.endsWith('.json')) continue;
        try {
            const meta = JSON.parse(await fs.readFile(path.join(idsDir(), f), 'utf8'));
            out.push({ id: f.slice(0, -5), ...meta });
        } catch {}
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'th'));
}

async function storeId(p12Bytes, password, label) {
    const { signer } = openP12(p12Bytes, password);
    const info = certInfo(forgeCertDer(signer));
    const id = crypto.randomUUID();
    await fs.mkdir(idsDir(), { recursive: true });
    await fs.writeFile(path.join(idsDir(), `${id}.pfx`), Buffer.from(p12Bytes));
    await fs.writeFile(path.join(idsDir(), `${id}.json`), JSON.stringify({ ...info, label: label || info.name }, null, 2));
    // Your own IDs are trusted on this PC.
    await trustCert(forgeCertDer(signer));
    return { id, ...info };
}

// Self-signed RSA-2048 / SHA-256 ID, valid 5 years.
async function createId({ name, email, org, password }) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = pki.privateKeyFromPem(privateKey.export({ type: 'pkcs1', format: 'pem' }));
    const cert = pki.createCertificate();
    cert.publicKey = pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }));
    cert.serialNumber = '01' + crypto.randomBytes(15).toString('hex');
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 5);
    const attrs = [{ name: 'commonName', value: name }];
    if (org) attrs.push({ name: 'organizationName', value: org });
    if (email) attrs.push({ name: 'emailAddress', value: email });
    // forge writes PrintableString by default; Thai names need UTF8String.
    for (const a of attrs) a.valueTagClass = asn1.Type.UTF8;
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
        { name: 'extKeyUsage', emailProtection: true, '1.3.6.1.4.1.311.10.3.12': true },
        { name: 'subjectKeyIdentifier' },
    ]);
    cert.sign(key, forge.md.sha256.create());
    const p12 = pkcs12.toPkcs12Asn1(key, [cert], password, { algorithm: '3des', friendlyName: name });
    const bytes = Buffer.from(asn1.toDer(p12).getBytes(), 'binary');
    return storeId(bytes, password, name);
}

// ---- signing --------------------------------------------------------------------

// data: Uint8Array with the placeholder; ranges: [a, b, c, d] ByteRange.
async function sign({ id, password, data, ranges }) {
    const p12 = await fs.readFile(path.join(idsDir(), `${path.basename(id)}.pfx`));
    const { key, signer, chain } = openP12(p12, password);
    const now = new Date();
    if (now > signer.validity.notAfter) throw new Error('ใบรับรองของ Digital ID นี้หมดอายุแล้ว');

    const buf = Buffer.from(data);
    const signed = Buffer.concat([buf.subarray(ranges[0], ranges[0] + ranges[1]), buf.subarray(ranges[2], ranges[2] + ranges[3])]);
    const p7 = pkcs7.createSignedData();
    p7.content = forge.util.createBuffer(signed.toString('binary'));
    for (const c of chain) p7.addCertificate(c);
    p7.addSigner({
        key,
        certificate: signer,
        digestAlgorithm: forge.pki.oids.sha256,
        authenticatedAttributes: [
            { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
            { type: forge.pki.oids.messageDigest },
            { type: forge.pki.oids.signingTime, value: now },
        ],
    });
    p7.sign({ detached: true });
    return new Uint8Array(Buffer.from(asn1.toDer(p7.toAsn1()).getBytes(), 'binary'));
}

// ---- verification ------------------------------------------------------------------

async function trustedCerts() {
    const out = tls.rootCertificates.map((pem) => {
        try {
            return new crypto.X509Certificate(pem);
        } catch {
            return null;
        }
    }).filter(Boolean);
    try {
        for (const f of await fs.readdir(trustDir())) {
            try {
                out.push(new crypto.X509Certificate(await fs.readFile(path.join(trustDir(), f))));
            } catch {}
        }
    } catch {}
    return out;
}

async function trustCert(der) {
    await fs.mkdir(trustDir(), { recursive: true });
    const x = new crypto.X509Certificate(der);
    await fs.writeFile(path.join(trustDir(), `${x.fingerprint256.replace(/:/g, '')}.cer`), x.raw);
}

const child = (node, i) => node?.value?.[i];
const oidOf = (node) => asn1.derToOid(node.value);

// Walks a CMS SignedData by hand (generic ASN.1 only), so RSA and EC
// signers both work: node:crypto does the actual verification.
function parseCms(der) {
    const ci = asn1.fromDer(forge.util.createBuffer(der.toString('binary')), { parseAllBytes: false, strict: false });
    if (oidOf(child(ci, 0)) !== OID.signedData) throw new Error('not SignedData');
    const sd = child(child(ci, 1), 0);
    let i = 3;
    const certs = [];
    while (sd.value[i] && sd.value[i].tagClass === asn1.Class.CONTEXT_SPECIFIC) {
        if (sd.value[i].type === 0) {
            for (const c of sd.value[i].value) certs.push(Buffer.from(asn1.toDer(c).getBytes(), 'binary'));
        }
        i++;
    }
    const si = sd.value[i].value[0];
    let k = 2;
    const sid = si.value[1];
    const digestOid = oidOf(child(si.value[k++], 0));
    let signedAttrs = null;
    if (si.value[k].tagClass === asn1.Class.CONTEXT_SPECIFIC && si.value[k].type === 0) signedAttrs = si.value[k++];
    const sigAlgOid = oidOf(child(si.value[k++], 0));
    const signature = Buffer.from(si.value[k].value, 'binary');

    const attrs = {};
    if (signedAttrs) {
        for (const attr of signedAttrs.value) attrs[oidOf(attr.value[0])] = attr.value[1].value[0];
    }
    // Signed attributes are signed as a DER SET, not as the [0] they're stored in.
    const attrsDer = signedAttrs
        ? Buffer.from(asn1.toDer(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, signedAttrs.value)).getBytes(), 'binary')
        : null;
    const serial = sid.tagClass === asn1.Class.UNIVERSAL ? Buffer.from(sid.value[1].value, 'binary').toString('hex').replace(/^0+/, '').toUpperCase() : null;
    return { certs, digest: DIGESTS[digestOid], sigAlgOid, signature, attrs, attrsDer, serial };
}

function verifySignatureValue(cms, cert, digestName) {
    const pub = cert.publicKey;
    const data = cms.attrsDer;
    const rsaPss = cms.sigAlgOid === '1.2.840.113549.1.1.10';
    try {
        return crypto.verify(digestName, data, rsaPss ? { key: pub, padding: crypto.constants.RSA_PKCS1_PSS_PADDING } : pub, cms.signature);
    } catch {
        return false;
    }
}

async function chainTrusted(signer, certs, anchors) {
    let cur = signer;
    for (let depth = 0; depth < 8; depth++) {
        if (anchors.some((a) => a.fingerprint256 === cur.fingerprint256)) return true;
        const anchor = anchors.find((a) => cur.checkIssued(a) && cur.verify(a.publicKey));
        if (anchor) return true;
        const parent = certs.find((c) => c !== cur && cur.checkIssued(c) && cur.verify(c.publicKey));
        if (!parent || parent === cur) return false;
        cur = parent;
    }
    return false;
}

// One signature: { ranges, contents (Buffer), fileLength } -> result.
async function verifyOne({ ranges, contents, fileLength, data }) {
    const result = { intact: false, signatureOk: false, coversWholeFile: false, trusted: false, problems: [] };
    let cms;
    try {
        cms = parseCms(contents);
    } catch (err) {
        result.problems.push(`อ่านข้อมูลลายเซ็นไม่ได้ (${err.message})`);
        return result;
    }
    const certs = cms.certs.map((d) => new crypto.X509Certificate(d));
    const signer = certs.find((c) => !cms.serial || c.serialNumber.replace(/^0+/, '').toUpperCase() === cms.serial) || certs[0];
    if (!signer) {
        result.problems.push('ลายเซ็นไม่มีใบรับรองของผู้เซ็น');
        return result;
    }
    result.cert = certInfo(signer.raw);
    result.certDer = new Uint8Array(signer.raw);
    const signingTime = cms.attrs[OID.signingTime];
    if (signingTime) {
        try {
            result.signingTime = (signingTime.type === asn1.Type.UTCTIME ? asn1.utcTimeToDate(signingTime.value) : asn1.generalizedTimeToDate(signingTime.value)).toISOString();
        } catch {}
    }

    const digestName = cms.digest;
    if (!digestName || !cms.attrsDer) {
        result.problems.push('รูปแบบลายเซ็นที่ยังไม่รองรับ');
        return result;
    }
    const hash = crypto.createHash(digestName);
    hash.update(data.subarray(ranges[0], ranges[0] + ranges[1]));
    hash.update(data.subarray(ranges[2], ranges[2] + ranges[3]));
    const digest = hash.digest();
    const md = cms.attrs[OID.messageDigest];
    result.intact = !!md && Buffer.from(md.value, 'binary').equals(digest);
    result.signatureOk = verifySignatureValue(cms, signer, digestName);
    result.coversWholeFile = ranges[0] === 0 && ranges[2] + ranges[3] === fileLength;
    if (!result.intact) result.problems.push('เอกสารถูกแก้ไขหลังจากเซ็น');
    if (!result.signatureOk) result.problems.push('ค่าลายเซ็นไม่ตรงกับใบรับรอง');

    const anchors = await trustedCerts();
    result.trusted = await chainTrusted(signer, certs, anchors);
    const at = result.signingTime ? new Date(result.signingTime) : new Date();
    if (at < new Date(signer.validFrom) || at > new Date(signer.validTo)) {
        result.problems.push('ใบรับรองไม่อยู่ในช่วงวันที่ใช้ได้ ณ เวลาที่เซ็น');
        result.trusted = false;
    }
    return result;
}

function initDigsig(getWindow) {
    ipcMain.handle('sig:list-ids', () => listIds());

    ipcMain.handle('sig:create-id', async (_e, opts) => {
        try {
            return { id: await createId(opts) };
        } catch (err) {
            return { error: err.message };
        }
    });

    ipcMain.handle('sig:import-id', async (_e, { password }) => {
        const res = await dialog.showOpenDialog(getWindow(), {
            title: 'Import Digital ID',
            filters: [{ name: 'Digital ID (PKCS#12)', extensions: ['pfx', 'p12'] }],
            properties: ['openFile'],
        });
        if (res.canceled || !res.filePaths.length) return { cancelled: true };
        try {
            const bytes = await fs.readFile(res.filePaths[0]);
            return { id: await storeId(bytes, password, path.basename(res.filePaths[0], path.extname(res.filePaths[0]))) };
        } catch (err) {
            return { error: err.message };
        }
    });

    ipcMain.handle('sig:remove-id', async (_e, id) => {
        const base = path.join(idsDir(), path.basename(id));
        await fs.rm(`${base}.pfx`, { force: true });
        await fs.rm(`${base}.json`, { force: true });
        return true;
    });

    ipcMain.handle('sig:sign', async (_e, job) => {
        try {
            return { signature: await sign(job) };
        } catch (err) {
            return { error: err.message };
        }
    });

    // sigs: [{ ranges, contents }] found by the renderer in data.
    ipcMain.handle('sig:verify', async (_e, { data, sigs }) => {
        const buf = Buffer.from(data);
        const out = [];
        for (const s of sigs) {
            try {
                out.push(await verifyOne({ ranges: s.ranges, contents: Buffer.from(s.contents), fileLength: buf.length, data: buf }));
            } catch (err) {
                out.push({ intact: false, signatureOk: false, trusted: false, problems: [err.message] });
            }
        }
        return out;
    });

    ipcMain.handle('sig:trust', async (_e, fingerprintDer) => {
        await trustCert(Buffer.from(fingerprintDer));
        return true;
    });
}

module.exports = { initDigsig, parseCms };
