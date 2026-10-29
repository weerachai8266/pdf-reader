---
name: pdf-reader-dev
description: Working rules, architecture map, test/build/release workflow and hard-won gotchas for the PDF Reader desktop app at C:\dev\pdf-reader (Electron + pdf.js + pdf-lib + qpdf-wasm + tesseract.js + bundled LibreOffice; an in-house Acrobat replacement for 200+ Thai office PCs). Load it before touching any file in that repo, and whenever the user mentions the PDF Reader, the "โปรแกรมอ่าน PDF", Acrobat replacement, its installer, OCR, signing, conversion, editing, or says "ทำต่อ" about this project.
---

# PDF Reader: how to work on it

An original PDF app written from scratch to replace Adobe Acrobat on 200+ PCs in a Thai organisation. The user wants "everything Acrobat does", built on open-source libraries.

**Never extract, decompile or redistribute Adobe/Acrobat binaries or code.** Acrobat may be used only as a feature inventory.

**Talk to the user in Thai** — progress notes, questions, and especially long end-of-task summaries. Code, identifiers and commit tags stay ASCII/English, but **commit and tag messages are Thai**.

---

## 1. Rules that override the global CLAUDE.md for this project

| Topic | This project | Why |
|---|---|---|
| UI font | Windows system fonts: `'Segoe UI', 'Leelawadee UI', Tahoma` (no Kanit, no web font) | User: Kanit/heavy fonts looked too thick; offline desktop app |
| Language | **Menus and buttons in English**; toasts, dialog messages and hints in **Thai** | User's explicit choice |
| Smallest text | `--fs-xs` 14px for chrome (toolbar, status bar); `--fs-sm` 15px for body text | Compact UI, but never under 14px |
| Icons | Lucide line icons from `src/img/icons.svg` only. Never emoji or text glyphs | User: emoji looked unprofessional |
| Toolbar | One row, 40px; icon-only buttons with `title`/`aria-label` naming the command and shortcut. Rare commands live in the menus | User: toolbar was too big |
| Packaging | **Everything in ONE installer** (OCR data, qpdf, LibreOffice, fonts). Size is not a concern | User decision |

Still enforced from the global rules:
- **No `<style>`/`<script>` blocks or `style=`/`on*=` attributes in HTML.** JS may set `el.style.*` at runtime. The CSP in `src/index.html` forbids inline scripts anyway.
- **Every list is paginated** with `PAGE_SIZE` from `src/js/config.js`.
- **Every change bumps the version, commits and tags** (§5).
- **Values someone chose are decisions, not defects** — ask before changing them.

---

## 2. Architecture map

```
main/            Electron main process (CommonJS)
  main.js        app:// protocol (serves src/ + node_modules/ only), IPC: file:*, tabs:*, doc:info, font:thai, font:get
  tabs.js        window = tab strip page (src/tabs/); each document is a WebContentsView running src/index.html.
                 openInTab: same path -> activate, empty active tab -> reuse, else new tab. Menu commands go to the active tab
  menu.js        English menu; sends 'menu:command' to the renderer (accelerators are display-only)
  print.js       printers (+ default from HKCU ...\Windows\Device), driver Properties (printui /e), silent print to the
                 chosen printer; hidden window lays out sheets at 300 dpi (src/js/printlayout.js, shared with the preview)
  convert.js     LibreOffice headless (serial queue, own profile in userData): Office/TIFF -> PDF, HTML -> DOCX
  digsig.js      node-forge: Digital IDs (.pfx in userData/digital-ids), CMS sign, verify (node:crypto, RSA+EC)
  updater.js     electron-updater, generic provider (URL from update.json next to exe or config/update.json)
src/index.html   single page: toolbar, sidebar (icon tabs: Pages/Find/Signatures/Compare), viewer, all <dialog>s
src/js/          ES modules (renderer, sandboxed; talks to main only via window.host from preload.js)
  app.js         entry: actions map + runCommand (toolbar data-action/data-tool, menu), open/save/print, keyboard
  docstate.js    model: sources Map (bytes + pdf.js doc) + ordered page entries {key, srcId, index, rotation};
                 annotations keyed by page key; replaceSource() swaps a source's bytes (OCR, stamps, redaction, edits)
  viewer.js      lazy rendering (IntersectionObserver), emits page-rendered / text-layer-rendered
  save.js        buildPdf(): fast path = pdf.js incremental save (Latin form values only); otherwise pdf-lib rebuild,
                 then qpdf optimize (drops orphaned objects, e.g. deleted pages). embedThaiFont / embedFontBytes
  annotate.js    highlight / note / image (signature) / redact marks / certsign drag box
  ocr.js, ocrlayer.js, recognize.js   tesseract.js (tha+eng best_int) -> invisible text layer
  stamp.js       header/footer, page numbers, watermark          extract.js  extract / split
  compress.js    image downsampling + qpdf                       protect.js  AES-256 encrypt / remove security
  redact.js      rasterize page + paint boxes + qpdf + optional OCR
  convert.js, pdf2html.js, tounicode.js   Create PDF / Export (Word via HTML -> LibreOffice, images, text)
  pdfsig.js, certsign.js, signatures.js   incremental-update signing writer, sign UI, verification bar/panel
  sigdiff.js     what changed after each signature (later signature / form+comments / content), by object diff
  printdialog.js Acrobat-style Print dialog + live sheet preview (options remembered in localStorage)
  compare.js     two-level Myers diff (lines, then Intl.Segmenter('th') words)
  contentedit.js, editmode.js   content-stream interpreter/rewriter; Edit Text & Images, Add Text, undo
  qpdf.js + workers/qpdf-worker.js   qpdf WebAssembly in a worker (renderer CSP blocks wasm on the main thread)
tools/           make-icons.js, make-icon-sprite.js, fetch-libreoffice.ps1, lo-fonts.xcd
vendor/          (gitignored) LibreOffice + Laksaman, produced by tools/fetch-libreoffice.ps1
test/            smoke.js (+ doctools/convert/editing/digsig modules), packaged.mjs
```

The page model in one breath:
- A document is an ordered list of page entries pointing into one or more source PDFs.
- Reordering, rotating and deleting only edit that list.
- Tools that must change real PDF content load the source with pdf-lib, change it, save, then `replaceSource()`, which re-renders and refreshes the thumbnails.
- Saving assembles everything (`buildPdf`).

---

## 3. Test and build workflow

Always unset `ELECTRON_RUN_AS_NODE` first: the VS Code host sets it, and Electron then runs as plain Node.

```powershell
cd C:\dev\pdf-reader
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm test                                   # full end-to-end suite (~3 min), must print ALL PASSED
$env:SMOKE_ONLY='editing'; npx electron test/smoke.js   # quick: print | doctools | convert | editing | digsig | tabs
npm run dist                               # NSIS installer -> dist\PDF-Reader-Setup-<ver>.exe (~250 MB)
node test/packaged.mjs <file.pdf> [--ocr] [--signed] [--convert <file.docx>]   # drives the built exe over CDP
```

- **First build on a machine:** `powershell -ExecutionPolicy Bypass -File tools\fetch-libreoffice.ps1`. It downloads LibreOffice 26.2.6 and TLWG fonts, checks their SHA-256, unpacks them without installing, and trims them to about 520 MB.
- **Test isolation:** tests set `userData` to a temp folder, so Digital IDs and trust settings never touch the real profile.
- **Mocked dialogs:** save dialogs use `setSavePath`; folder and file pickers use `setFolder` / `setOpenPaths`; unsaved-changes prompts (`showMessageBoxSync`) use `setMessageBoxChoice`.
- **Tabs in tests:** `win` in the harness is a shim whose `webContents` is the *active tab's* document; the real BrowserWindow (`bw`) only shows the tab strip. `packaged.mjs` picks the CDP target whose URL ends in `/src/index.html`.
- **Test output:** each run writes screenshots to `%TEMP%\pdf-reader-smoke-*`. Look at them (`Read` the PNG) after UI changes.
- **Driving the UI from tests:** use real input events (`sendInputEvent`) for drags. Use `elementFromPoint(...).dispatchEvent(new MouseEvent('click', …))` for a click at a point.
- **Saving from tests:** send Save As through the menu: `win.webContents.send('menu:command', 'save-as')`.
- **Pure modules in Node:** `.js` files in this repo are CommonJS to Node, so copy a module to the scratchpad as `.mjs` before importing it. Use `pdfjs-dist/legacy/build/pdf.mjs` for text extraction.

---

## 4. Gotchas (each one cost real time)

**Tooling**
- **The Write tool turns `\uXXXX` escapes into literal characters**, even NUL. For regexes with escapes, write through Python using `chr(92)`, then check the file with `ascii()`.
- **Bash heredocs break on backslashes, backticks and some Thai text.** Put long patches in a scratchpad `.py` file and run it with `$env:PYTHONIOENCODING='utf-8'; python file.py`. Use the PowerShell tool for anything with backticks.
- **Commit messages:** PowerShell `git commit -F -` with a here-string failed once and created the tag on the old commit. Write the message to a scratchpad file, run `git commit -F file`, and tag only if `$?`.

**Thai and PDF quirks**
- **Chromium's `printToPDF` loses some tone marks** (ที่ → ที, น้ำ → นำ) in the test PDFs. Test assertions must use words that survive this. The app's search has a tone-insensitive fallback for it.
- **LibreOffice PDFs map a whole Thai cluster onto its first glyph** and rely on `/ActualText`, which pdf.js ignores. `tounicode.js` rewrites the ToUnicode CMap after every Office→PDF conversion.
- **LibreOffice's PDF import scrambles Thai vowel order**, so PDF→Word goes pdf.js → `pdf2html.js` → LibreOffice HTML→DOCX. There is no PPTX export for the same reason.
- **Tesseract returns Thai one character cluster at a time.** Words are merged into runs before writing the text layer.
- **Thai fonts for pdf-lib:** Tahoma subset works; Leelawadee breaks in fontkit. Laksaman is the GPL twin of TH Sarabun New.

**Libraries**
- **Printing:** `webContents.print({ silent: false })` from a hidden window never showed the Windows dialog reliably (callback only after a long wait). The app uses its own dialog + `silent: true` + `deviceName`. Electron 45 printer info has no `isDefault`. The smoke test replaces `wc.print` with printToPDF, so it never reaches a real printer — test real printers by hand.
- **pdf-lib:** `dict.lookup(key, Type)` throws when the key is missing; use `lookupMaybe`.
- **pdf-lib `page.node.addAnnot()` normalizes the page** (wraps /Contents in q/Q, fills /Resources). In an incremental update that counts as a content change; push onto /Annots directly instead.
- **pdf-lib keeps every parsed object, including orphans.** That is why every pdf-lib save goes through qpdf optimize, and why redaction calls it explicitly.
- **pdf.js v6:** `getPermissions()` may return a Set, so spread it before `.includes`.
- **qpdf.js** binds `console.log` at instance creation. The worker captures output by swapping console methods. `--is-encrypted` reports "invalid password" for files with an open password; treat that as encrypted.

**LibreOffice bundle**
- **Python must stay in the bundle:** LibreOffice aborts while creating its profile without it.
- **Font substitution:** only the VCL `FontSubstitutions` table (`tools/lo-fonts.xcd`) works headless; the Common replacement table does nothing.
- **This dev PC has TH Sarabun New installed per-user**, so font fallback tests must use TH SarabunPSK.

**App code**
- **`<body data-tool>` holds the current tool.** Click delegation must use `e.target.closest('button')`, never `closest('[data-tool]')`, which matches body and re-fires setTool on every click.
- **Async work tied to a page or file needs a sequence token:** `openSeq` in openFile, `editToken` for image overlays, `checkSeq` for signatures. Without it, a slower stale job overwrites a newer one.
- **Signing appends an incremental update.** Any later full rewrite (non-form changes plus Save) invalidates signatures; the app warns via `willRewriteFile()`.

---

## 5. Release routine (every change)

1. **Bump `package.json` version** — the single source of truth. It shows bottom-right in the status bar.
2. **`npm test` → ALL PASSED.** For UI changes, look at the screenshots.
3. **`npm run dist`, then `node test/packaged.mjs …`** with the flags relevant to the change.
4. **Update `README.md`** (features and limitations, in Thai) and `DEPLOY.md` if build/deploy steps changed.
5. **`git add -A`, commit with a Thai message, then tag:**
   - The message ends with the attribution line from the current system reminder (currently `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).
   - Then run `git tag -a vX.Y.Z -m "<Thai summary>"`.
   - Push only when the user asks, and state the version. The GitHub repo is public.
6. **Update memory** (`pdf-reader-project.md`) with anything non-obvious learned.
7. **Report to the user in Thai:** what changed, test results, installer path and size, limitations, and what's next.

---

## 6. Status (v0.11.0, 2026-10-28) and backlog

**Done:**
- viewing and Thai search
- highlight, notes, Fill & Sign
- page management, combine
- forms, including Thai appearances
- print
- OCR
- extract and split
- page numbers, header/footer, watermark
- redact, compress, password protection
- Office/image → PDF; PDF → Word, images, text
- Laksaman fallback for TH Sarabun
- certificate signatures and verification, incl. telling later signatures / form fills / content edits apart
- compare files
- edit text and images, add text, add image, undo
- Acrobat-style Print dialog (v0.10), document tabs (v0.11)

**Open items to raise with the user:**
1. **Update server**: live at `https://192.168.0.44/pdf-reader/` since v0.16.0 (Apache, `/var/www/html/pdf-reader`, ssh weerachai@; self-signed cert pinned in `config/update.json`, see DEPLOY.md before touching it). Release = `npm run dist`, `npm run publish:update`, then `gh release create`. Installer still unsigned. Diagnose a PC with `%APPDATA%\PDF Reader\logs\updater.log`.
2. **Code-signing certificate**, to avoid SmartScreen warnings. Steps are in DEPLOY.md.
3. **App name and branding**; it is still "PDF Reader".
4. **Real organisation files:** forms (JS/XFA), scans, a physical printer.
5. **Smart card / USB token signing** via the Windows certificate store. It needs a native module.
6. **Editing gaps:** no paragraph reflow, a trusted timestamp (TSA), and revocation checks (TSA/revocation only matter if the org uses CA-issued certificates and the PCs can reach the network).
