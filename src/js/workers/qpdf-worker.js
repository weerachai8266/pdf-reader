// Runs qpdf (WebAssembly) off the UI thread. One fresh qpdf instance per
// job, so no file or state leaks from one document into the next.
//
// Message in:  { id, args, inputs: { '/in.pdf': Uint8Array }, output }
// Message out: { id, code, output: Uint8Array | null, log }

const QPDF = new URL('../../../node_modules/@neslinesli93/qpdf-wasm/dist/', self.location.href).href;

// qpdf.js binds console.log/error when an instance is created; route them
// into the current job's log so callers can read qpdf's text output.
let sink = null;
console.log = (...a) => sink?.push(a.join(' '));
console.error = (...a) => sink?.push(a.join(' '));

importScripts(QPDF + 'qpdf.js');

self.onmessage = async ({ data: { id, args, inputs, output } }) => {
    const log = [];
    sink = log;
    try {
        const qpdf = await self.Module({ locateFile: () => QPDF + 'qpdf.wasm' });
        for (const [path, bytes] of Object.entries(inputs)) qpdf.FS.writeFile(path, bytes);
        let code;
        try {
            code = qpdf.callMain(args);
        } catch (err) {
            // Emscripten reports exit() as a thrown ExitStatus.
            code = typeof err?.status === 'number' ? err.status : 2;
            if (code !== err?.status) log.push(String(err?.message || err));
        }
        let out = null;
        if (output && code !== 2) {
            try {
                out = qpdf.FS.readFile(output);
            } catch {}
        }
        self.postMessage({ id, code, output: out, log: log.join('\n') }, out ? [out.buffer] : []);
    } catch (err) {
        self.postMessage({ id, code: 2, output: null, log: `${log.join('\n')}\n${err?.message || err}` });
    } finally {
        sink = null;
    }
};
