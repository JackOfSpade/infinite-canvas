/**
 * Local render → page-count pipeline for the résumé/cover-letter documents
 * `resumeHtml.js` builds. Two exports:
 *
 *   renderPdf(html, { signal })  — hidden BrowserWindow → PDF bytes + page count
 *   applyDualPdf(bytes)          — OCG cream-layer post-process (dual-pdf variant only)
 *
 * jobApplication.js is the only caller — it drives the render → page-count →
 * fit loop (SKILL.md §5's "compact-density algorithm") around `renderPdf`,
 * deciding when to re-render with `data-density="compact"` or ask the model
 * for a length revision. This module itself makes no fit decisions; it only
 * renders whatever HTML it's given, once, and reports back what came out.
 *
 * Why `webContents.printToPDF` and not puppeteer-core/playwright (both are
 * already an `npm i` away in this repo's package.json): Electron ships its
 * own Chromium, so a hidden BrowserWindow gets print-to-PDF for free without
 * managing a separate Chromium — puppeteer-core/playwright would mean
 * downloading/managing a SEPARATE Chromium (or pointing at system Chrome —
 * exactly the CDP-fingerprint problem the marketplace scrapers fight
 * elsewhere in this app) for a fully offline, self-authored, trusted HTML
 * document. Not worth it here.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import electronPkg from 'electron';
// Namespace import as well as the named one: `PDFLib` is handed wholesale to
// the design system's UMD module (see getDualModePdf below), which expects the
// same shape the CDN build exposes as a global.
import * as PDFLib from 'pdf-lib';
import { PDFDocument } from 'pdf-lib';
import { logger } from '../logger.js';
import { getDesignSystemDir } from './resumeHtml.js';

const { BrowserWindow } = electronPkg;

// Hard ceiling on one render (load + fonts-ready + printToPDF). Without this,
// a printToPDF call that never resolves — a hung page, a Chromium print
// pipeline that never reaches "ready" — would hang the fit loop and, by
// extension, the user's Generate click indefinitely. Same failure shape
// REFRESH_TIMEOUT_MS guards against in browserViewMonitor.js; not imported
// from there — that timeout is tuned for a LIVE network page reload, this one
// for an offline, self-authored document with no network dependency besides
// the design system's Google Fonts @import, so the values (and what a
// timeout here actually diagnoses) don't share enough to be worth coupling.
const RENDER_TIMEOUT_MS = 20_000;

function throwIfAborted(signal) {
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
}

function abortError() {
  return Object.assign(new Error('aborted'), { name: 'AbortError' });
}

// Destroying a BrowserWindow normally makes the in-flight Electron operation
// reject, but that is not guaranteed for every load/print state. Race each
// wait with AbortSignal too, so cancellation never waits for the render timeout.
function withTimeout(promise, ms, label, signal) {
  if (signal?.aborted) return Promise.reject(abortError());

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, abortError());

    timer = setTimeout(() => finish(reject, new Error(`${label} timed out after ${ms}ms`)), ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      value => finish(resolve, value),
      error => finish(reject, error),
    );
  });
}

/**
 * Render one self-contained HTML document to PDF bytes + page count.
 *
 * Loads from a TEMP FILE, not a `data:` URL. The résumé/cover-letter HTML
 * already inlines the whole design-system CSS (colors_and_type.css +
 * resume.css, tens of KB) plus the model's markup; base64-encoding that into
 * a data: URL bloats it ~33% further and risks the length ceilings some
 * `loadURL` paths hit well under Chromium's own (very large) limit. A temp
 * file has no such ceiling — that's what `win.loadFile()` is for. The
 * tradeoff is a disk write + cleanup per render attempt (the fit loop in
 * jobApplication.js can call this up to a handful of times per Generate
 * click) — negligible next to the LLM calls already on that path.
 *
 * @param {string} html
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @param {'resume'|'cover'} [opts.document] Which panel to print from a
 * combined application workspace. The generated tabs are switched inside the
 * isolated render window before font readiness/printing is measured. Omit for
 * a standalone résumé or cover-letter document.
 * @returns {Promise<{bytes: Uint8Array, pageCount: number}>}
 */
export async function renderPdf(html, { signal, document = null } = {}) {
  throwIfAborted(signal);

  let tempDir = null;
  let win = null;
  // Force-destroy immediately on abort rather than waiting for the current
  // await to reject on its own — a cancelled generation must not leave a
  // hidden BrowserWindow alive for the duration of whatever step happened to
  // be in flight (see the finally block below for why a leaked one matters).
  const onAbort = () => { if (win && !win.isDestroyed()) win.destroy(); };

  try {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jobapp-render-'));
    const tempPath = path.join(tempDir, `${crypto.randomUUID()}.html`);
    await fs.promises.writeFile(tempPath, String(html || ''), 'utf8');
    throwIfAborted(signal);

    win = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        // No preload — this is our own trusted, self-authored HTML (built by
        // resumeHtml.js from the model's markup + the design system's CSS),
        // not a page we need to script the way browserViewMonitor.js does
        // for hostile third-party sites.
      },
    });
    signal?.addEventListener('abort', onAbort);
    throwIfAborted(signal);

    const wc = win.webContents;

    // did-finish-load AND document.fonts.ready — the design system's own
    // font-load check (resumeHtml.js's injected `ic-font-warning` banner)
    // exists precisely because fonts loading late RESIZES the page (fallback
    // metrics differ from Source Serif 4 / Inter / IBM Plex Mono), which
    // changes what fits on a page. Printing before fonts settle would size —
    // and page-count — the résumé against fallback-font metrics, giving a
    // pass/fail verdict that doesn't match what the user's own screen (or a
    // later, fully-loaded print) would show.
    await withTimeout(new Promise((resolve, reject) => {
      wc.once('did-finish-load', resolve);
      wc.once('did-fail-load', (_e, code, desc) => reject(new Error(`did-fail-load ${code}: ${desc || 'unknown'}`)));
      win.loadFile(tempPath).catch(reject);
    }), RENDER_TIMEOUT_MS, 'renderPdf: did-finish-load', signal);
    throwIfAborted(signal);

    if (document === 'cover' || document === 'resume') {
      // Application.html keeps both documents in one self-contained editor.
      // Its tab script is synchronous, so selecting cover before the font
      // check guarantees printToPDF sees the cover panel rather than hidden
      // résumé content. No caller-controlled JavaScript is interpolated here.
      const tabId = document === 'cover' ? 'ic-cover-tab' : 'ic-resume-tab';
      const label = document === 'cover' ? 'cover letter' : 'résumé';
      await withTimeout(
        wc.executeJavaScript(`(function () { var tab = document.getElementById(${JSON.stringify(tabId)}); if (!tab) throw new Error(${JSON.stringify(`${label} panel is unavailable.`)}); tab.click(); })()`),
        RENDER_TIMEOUT_MS,
        `renderPdf: select ${label}`,
        signal,
      );
      throwIfAborted(signal);
    }

    // `document.fonts.ready` is NOT a success signal — per spec it resolves
    // when font loading FINISHES, including when every @font-face failed. The
    // design system pulls Source Serif 4 / Inter / IBM Plex Mono from the
    // Google Fonts CDN (`@import url(https://fonts.googleapis.com/...)` in
    // colors_and_type.css), so an offline machine, a blocked CDN, or a captive
    // portal resolves `ready` against SYSTEM FALLBACK metrics. Page count
    // measured there is measured against the wrong typography — which would
    // drive the compact-density decision (and potentially an LLM revision that
    // cuts real content) off a number the user will never see.
    //
    // So: after `ready`, actually verify the display family loaded, using the
    // SAME check as the document's own `ic-font-warning` banner
    // (resumeHtml.js §5.3) — read the computed weight off a real on-page
    // element rather than letting the shorthand default to 400, because
    // resume.css renders .name at 600 and browsers only fetch the weights
    // actually used. Report it; the caller decides what a false means.
    const fontsLoaded = await withTimeout(
      wc.executeJavaScript(`document.fonts.ready.then(function () {
        try {
          var ffDisplay = getComputedStyle(document.documentElement).getPropertyValue('--ff-display');
          var firstFamily = (ffDisplay.split(',')[0] || '').trim().replace(/^["']|["']$/g, '');
          if (!firstFamily || !document.fonts || !document.fonts.check) return true;
          var ffEl = document.querySelector('.name') || document.querySelector('.letter-body') || document.documentElement;
          var ffWeight = (getComputedStyle(ffEl).fontWeight || '400').trim() || '400';
          return document.fonts.check(ffWeight + ' 12px "' + firstFamily + '"');
        } catch (e) { return true; }
      })`),
      RENDER_TIMEOUT_MS,
      'renderPdf: document.fonts.ready',
      signal,
    );
    throwIfAborted(signal);

    // printBackground + preferCSSPageSize are both REQUIRED (SKILL.md §5,
    // step 5): printBackground so the dual-pdf variant's background rule (and
    // any accent fills) actually render into the content stream at all;
    // preferCSSPageSize so the design system's CSS-named pages (`@page
    // letter` / `@page a4`, switched by `data-page`) size the PDF instead of
    // whatever default page size Electron would otherwise pick.
    const pdfBuffer = await withTimeout(
      wc.printToPDF({ printBackground: true, preferCSSPageSize: true }),
      RENDER_TIMEOUT_MS,
      'renderPdf: printToPDF',
      signal,
    );
    throwIfAborted(signal);

    // pdfBuffer is a Node Buffer (a Uint8Array subclass) — fine to hand back
    // as-is; pdf-lib and fs.writeFile both accept it directly.
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    throwIfAborted(signal);
    const pageCount = pdfDoc.getPageCount();
    if (!fontsLoaded) {
      logger.warn(
        '[ResumeRender] Web fonts did not load in the render window (offline, or fonts.googleapis.com unreachable). '
        + `Page count ${pageCount} was measured against fallback typefaces and does NOT reflect the real document — the fit loop will not act on it.`,
      );
    }
    return { bytes: pdfBuffer, pageCount, fontsLoaded };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // A leaked hidden BrowserWindow keeps the whole Electron process alive
    // (it only quits once every window is gone) with NO visible symptom — a
    // show:false window has no taskbar/dock entry, so this failure mode looks
    // like "the app just never exits" with no obvious cause. Always destroy,
    // on every exit path (success, thrown error, or abort).
    if (win && !win.isDestroyed()) win.destroy();
    if (tempDir) await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Dual-mode (OCG cream layer) post-process
// ---------------------------------------------------------------------------

// resume_design_system/build/dual-mode-pdf.js is a UMD module owned by the
// design system (read-only from this repo's side, same as the CSS/HTML files
// — see resumeHtml.js's getDesignSystemDir() doc-comment). It isn't published
// to npm, so a static ESM `import` can't reach it, and it's resolved through
// getDesignSystemDir() rather than a path relative to this file for the same
// reason resumeHtml.js resolves the CSS that way: in a packaged app it lives
// in Contents/Resources, not next to this module.
//
// ── Why we evaluate it instead of `require()`-ing it ──────────────────────
// SKILL.md §6's Node sample is a bare `require('./build/dual-mode-pdf.js')`,
// and that is exactly what does NOT work in a packaged build. The UMD's Node
// branch runs `require('pdf-lib')` from ITS OWN location — and the design
// system ships via electron-builder `extraResources` to
// `Contents/Resources/resume_design_system/`, a SIBLING of `app.asar`, while
// `pdf-lib` lives inside `app.asar/node_modules`. Node's resolver only walks
// UPWARD through ancestor directories, and `app.asar/node_modules` is never an
// ancestor of `resume_design_system/build/`, so the inner require throws
// MODULE_NOT_FOUND. (Confirmed against a real packaged build: it appears to
// work from a dev checkout only because the repo's own root node_modules
// happens to sit in the ancestor chain — a coincidence that vanishes the
// moment the .app is moved to /Applications.) The failure is silent-ish:
// applyDualPdf throws, the caller degrades to the flat PDF, and dual-mode
// output would simply never exist in production.
//
// So take the UMD's OTHER branch instead. Evaluated in THIS realm (not a `vm`
// context) on purpose, for two reasons: the module needs Node globals the
// design system's browser branch assumes are present (`TextEncoder`), and a
// separate realm would give it a different `Uint8Array` identity than the
// `pdf-lib` instance we hand it, which is the classic cross-realm
// `instanceof` trap. Handing in our OWN already-imported pdf-lib also pins the
// exact version this app ships rather than whatever the resolver might find.
//
// Evaluating a file is the same trust level as requiring it — this is a
// vendored, read-only asset at a path getDesignSystemDir() validated, never
// user input.
let _dualModePdf = null;
function getDualModePdf() {
  if (_dualModePdf) return _dualModePdf;
  const modulePath = path.join(getDesignSystemDir(), 'build', 'dual-mode-pdf.js');
  const src = fs.readFileSync(modulePath, 'utf8');
  // The UMD picks its root as `typeof self !== 'undefined' ? self : this`, then
  // does `root.DualModePdf = factory(root.PDFLib)` — so seed `self` with our
  // pdf-lib and read the module back off it.
  const root = { PDFLib };
  _dualModePdf = new Function('self', `${src}\n;return self.DualModePdf;`)(root);
  if (typeof _dualModePdf?.addOcgBackground !== 'function') {
    _dualModePdf = null;
    throw new Error(`dual-mode-pdf.js at ${modulePath} did not export addOcgBackground — the design system's build/ folder may be stale or partially copied.`);
  }
  return _dualModePdf;
}

/**
 * Post-process PDF bytes with the design system's view-cream/print-white OCG
 * layer. Caller's responsibility to only call this for the `dual-pdf` variant
 * (resumeHtml.js's `isDualMode()`) — SKILL.md §5 step 6 is explicit that
 * running this on an `ink-only` PDF produces an incorrect dual state (a cream
 * layer over an already-white page). This function does not re-check the
 * variant itself; it has no access to it, only bytes in / bytes out, mirroring
 * `addOcgBackground`'s own pure (bytes → bytes) contract.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
export async function applyDualPdf(bytes) {
  const { addOcgBackground } = getDualModePdf();
  return await addOcgBackground(bytes);
}
