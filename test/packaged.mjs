// Checks the packaged build (dist/win-unpacked) really opens and renders a
// PDF from inside app.asar. Drives it over the DevTools protocol.
// Usage: node test/packaged.mjs <file.pdf>

import { spawn } from 'node:child_process';
import path from 'node:path';

const exe = path.resolve('dist/win-unpacked/PDF Reader.exe');
const pdf = path.resolve(process.argv[2]);
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(exe, [`--remote-debugging-port=${PORT}`, pdf], { env, stdio: 'ignore' });

let target;
for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
        target = list.find((t) => t.url.startsWith('app://'));
    } catch {}
}
if (!target) {
    console.log('FAIL  window did not appear');
    child.kill();
    process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const evaluate = (expression) => new Promise((resolve) => {
    const my = ++id;
    const onMsg = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id !== my) return;
        ws.removeEventListener('message', onMsg);
        resolve(msg.result?.result?.value);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
});

async function waitFor(expr, ms = 15000) {
    for (let t = 0; t < ms; t += 200) {
        if (await evaluate(expr)) return true;
        await sleep(200);
    }
    return false;
}

const checks = [
    ['pages laid out', `document.querySelectorAll('#pages .page').length > 0`],
    ['canvas rendered', `!!document.querySelector('.page canvas')`],
    ['text or form fields present', `document.querySelector('.textLayer')?.textContent.length > 0 || !!document.querySelector('.annotationLayer input')`],
    ['logo loads', `document.querySelector('.empty-logo').complete && document.querySelector('.empty-logo').naturalWidth > 0`],
    ['version shown', `document.getElementById('app-version').textContent.startsWith('v')`],
].filter(([name]) => !(process.argv.includes('--ocr') && name.startsWith('text'))); // scans have no text yet
let failed = 0;
for (const [name, expr] of checks) {
    const ok = await waitFor(expr);
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
// --ocr: run Recognize Text on the (scanned) file and expect a text layer.
if (process.argv.includes('--ocr')) {
    await evaluate(`document.querySelector('[data-action="ocr"]').click()`);
    await waitFor(`document.getElementById('dlg-ocr').open`);
    await evaluate(`document.querySelector('#dlg-ocr button[value="ok"]').click()`);
    const ok = await waitFor(`/OCR เสร็จ/.test(document.getElementById('toast').textContent) && document.querySelector('.textLayer')?.textContent.length > 0`, 120000);
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  OCR in packaged build`, await evaluate(`document.getElementById('toast').textContent`));
}
console.log('version:', await evaluate(`document.getElementById('app-version').textContent`));
console.log('font:', await evaluate(`getComputedStyle(document.body).fontFamily`));
ws.close();
child.kill();
process.exit(failed ? 1 : 0);
