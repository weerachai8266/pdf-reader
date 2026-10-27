// Thin promise wrapper around the qpdf worker. qpdf rewrites a file keeping
// only objects that are still referenced (so deleted pages and redacted
// content really leave the file), compresses, encrypts and decrypts.
//
// Exit codes: 0 ok, 3 ok with warnings, 2 error.

let worker = null;
let nextId = 1;
const jobs = new Map();

function getWorker() {
    if (worker) return worker;
    worker = new Worker(new URL('./workers/qpdf-worker.js', import.meta.url));
    worker.onmessage = ({ data }) => {
        const job = jobs.get(data.id);
        jobs.delete(data.id);
        job?.resolve(data);
    };
    worker.onerror = (e) => {
        for (const job of jobs.values()) job.reject(new Error(e.message || 'qpdf worker failed'));
        jobs.clear();
        worker = null;
    };
    return worker;
}

// Runs qpdf with args on input bytes (written as /in.pdf). Returns
// { code, output, log }; output is /out.pdf when the args write one.
export function runQpdf(args, input) {
    return new Promise((resolve, reject) => {
        const id = nextId++;
        jobs.set(id, { resolve, reject });
        getWorker().postMessage({ id, args, inputs: { '/in.pdf': input.slice() }, output: '/out.pdf' });
    });
}

async function rewrite(args, input, failMessage) {
    const { code, output, log } = await runQpdf(args, input);
    if (code === 2 || !output) {
        console.warn('qpdf failed', args.filter((a) => !a.startsWith('--password')), log);
        throw new Error(failMessage);
    }
    return output;
}

// Drops unreferenced objects and packs the file (object streams, max flate).
export function optimize(input) {
    return rewrite(
        ['/in.pdf', '--object-streams=generate', '--compress-streams=y', '--recompress-flate', '--compression-level=9', '/out.pdf'],
        input,
        'จัดระเบียบไฟล์ไม่สำเร็จ',
    );
}

// perms: { print: 'none'|'low'|'full', modify: 'none'|'form'|'annotate'|'assembly'|'all', extract: bool }
export function encrypt(input, { userPassword, ownerPassword, perms }) {
    return rewrite(
        [
            '/in.pdf',
            '--object-streams=generate',
            '--encrypt',
            userPassword,
            ownerPassword,
            '256',
            `--print=${perms.print}`,
            `--modify=${perms.modify}`,
            `--extract=${perms.extract ? 'y' : 'n'}`,
            '--',
            '/out.pdf',
        ],
        input,
        'ตั้งรหัสผ่านไม่สำเร็จ',
    );
}

export function decrypt(input, password) {
    return rewrite([`--password=${password}`, '/in.pdf', '--decrypt', '--object-streams=generate', '/out.pdf'], input, 'ปลดรหัสผ่านไม่สำเร็จ');
}

// Which password unlocks the file: 'owner', 'user' or null (wrong).
// Files with only permission restrictions open with an empty user password.
export async function passwordKind(input, password) {
    const { code, log } = await runQpdf([`--password=${password}`, '--show-encryption', '/in.pdf'], input);
    if (code === 2) return null;
    if (/Supplied password is owner password/.test(log)) return 'owner';
    if (/Supplied password is user password/.test(log)) return 'user';
    return /File is not encrypted/.test(log) ? 'owner' : null;
}

// Without the right password qpdf can't open a file that has an open
// password, and says so instead of answering: that also means encrypted.
export async function isEncrypted(input) {
    const { code, log } = await runQpdf(['--is-encrypted', '/in.pdf'], input);
    return code === 0 || /invalid password/.test(log);
}
