/**
 * Résumé / cover-letter PDF rendering for the job-application generator.
 *
 * Pipeline: an LLM (see jobApplication.js) fills the editorial design system
 * (`resume_design_system/`) — it returns the résumé as a `<main class="page">`
 * block and the cover letter as structured fields. This module wraps those into
 * full HTML documents against the design system's CSS + bundled fonts, then
 * renders each to PDF with headless Chromium (the same browser the scraper
 * already depends on, located via findChromePath).
 *
 * Background handling follows the design system exactly. We render with
 * Chromium's PRINT media (the default for page.pdf), where the design CSS
 * resolves the chosen variant to:
 *   - `data-print="dual-pdf"` (default) → background-LESS PDF; we then call the
 *     design system's `addOcgBackground` (build/dual-mode-pdf.js) to add a
 *     view-only OCG cream layer. The single file shows warm cream on screen and
 *     prints on clean white, oxblood name preserved in both states.
 *   - `data-print="ink-only"`           → flat white, no OCG. Right for
 *     ATS / enterprise pipelines.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import electronPkg from 'electron';
import puppeteer from 'puppeteer-core';
import { findChromePath } from './stealthBrowser.js';
import { buildResumeDocument, buildCoverLetterDocument, extractVariantAttrs, isDualMode } from './resumeHtml.js';
import { logger } from '../logger.js';

const { app } = electronPkg;

// The warm cream ground (design-system `--bg`). Passed explicitly to
// addOcgBackground so the OCG layer matches the CSS token even if the module's
// default drifts. Keep in sync with `--bg` in colors_and_type.css.
const CREAM = '#F7F4ED';

// Lazily load the design system's OCG post-processor. It's a CJS/UMD module that
// require()s its vendored pdf-lib relative to itself, so it MUST be loaded via a
// CommonJS require (not import()) — under a "type":"module" tree, import() would
// mis-parse it as ESM and `module.exports`/`require` would be undefined.
let _addOcgBackground = null;
function loadAddOcgBackground() {
  if (_addOcgBackground) return _addOcgBackground;
  // __filename is a CJS global in the Rollup electron bundle (see main.js); the
  // process.cwd() fallback only matters outside the bundle (never in prod).
  const base = (typeof __filename !== 'undefined') ? __filename : path.join(process.cwd(), 'index.cjs');
  const requireCjs = createRequire(base);
  const mod = requireCjs(path.join(getDesignSystemDir(), 'build', 'dual-mode-pdf.js'));
  _addOcgBackground = mod.addOcgBackground || (mod.default && mod.default.addOcgBackground);
  if (typeof _addOcgBackground !== 'function') {
    throw new Error('dual-mode-pdf.js did not export addOcgBackground');
  }
  return _addOcgBackground;
}

// The design-system stylesheets + the fonts directory. Copied into each render's
// temp working dir so the HTML's relative `<link>` / `url("fonts/…")` references
// resolve without polluting the (tracked) source directory. cover-letter.css is
// the letter-specific surface (serif body, date/recipient, signature close) the
// cover-letter document links on top of colors_and_type.css + resume.css.
const CSS_FILES = ['colors_and_type.css', 'resume.css', 'cover-letter.css'];
const FONTS_DIR = 'fonts';

/**
 * Resolve `resume_design_system/`. In dev this is the repo root; in a packaged
 * build it must be asarUnpacked (Chromium can't read fonts via file:// from
 * inside an asar) — resolved off process.resourcesPath there. Fails loudly if
 * absent rather than rendering an unstyled page.
 */
export function getDesignSystemDir() {
  const candidates = [];
  try { if (app?.getAppPath) candidates.push(path.join(app.getAppPath(), 'resume_design_system')); } catch { /* not in electron */ }
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'resume_design_system'));
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'resume_design_system'));
  }
  candidates.push(path.join(process.cwd(), 'resume_design_system'));
  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, 'resume.css'))) return dir;
  }
  throw new Error(
    `Résumé design system not found (looked in: ${candidates.join(', ')}). ` +
    `The 'resume_design_system' folder must ship with the app.`
  );
}

/**
 * Stage a temp working dir with the design-system CSS + fonts so relative URLs
 * in the rendered HTML resolve. Returns the dir path; caller removes it.
 */
async function prepareAssetsDir() {
  const designDir = getDesignSystemDir();
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jobapp-render-'));
  await Promise.all(CSS_FILES.map(f =>
    fs.promises.copyFile(path.join(designDir, f), path.join(workDir, f))
  ));
  await fs.promises.cp(path.join(designDir, FONTS_DIR), path.join(workDir, FONTS_DIR), { recursive: true });
  return workDir;
}

/**
 * Render one HTML document (written into `workDir`) to a PDF buffer. Waits for
 * web fonts to load before printing so the editorial typography is embedded
 * rather than falling back to a system serif. Returns the PDF bytes so the
 * caller can post-process (OCG cream layer) before writing to disk.
 */
async function renderOne(browser, workDir, html, docName) {
  const htmlPath = path.join(workDir, `${docName}.html`);
  await fs.promises.writeFile(htmlPath, html, 'utf8');
  const page = await browser.newPage();
  try {
    await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0', timeout: 30000 });
    // Ensure all @font-face files are loaded before printing (font-display:swap
    // would otherwise let the PDF snapshot a system-font fallback).
    await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
    return await page.pdf({
      printBackground: true,      // bake white (ink-only) / carry colored content
      preferCSSPageSize: true,    // honor the design system's @page Letter/A4
    });
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Render the résumé + cover letter to two PDFs in a fresh temp output dir.
 * Returns the temp paths (and the workDir to clean up after the files are
 * copied to the user's chosen folder).
 *
 * @param {object}  args
 * @param {string}  args.resumeMainHtml   — model's `<main class="page">` block
 * @param {object}  args.coverLetter      — structured cover-letter fields
 * @param {string}  [args.signal]         — AbortSignal (best-effort)
 * @returns {Promise<{resumePdfPath:string, coverPdfPath:string, workDir:string}>}
 */
export async function renderApplicationPdfs({ resumeMainHtml, coverLetter, signal } = {}) {
  const executablePath = process.env.CHROME_PATH || await findChromePath();
  const workDir = await prepareAssetsDir();
  const outDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jobapp-out-'));
  const resumePdfPath = path.join(outDir, `resume-${crypto.randomBytes(4).toString('hex')}.pdf`);
  const coverPdfPath  = path.join(outDir, `cover-${crypto.randomBytes(4).toString('hex')}.pdf`);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    if (signal?.aborted) throw Object.assign(new Error('Application generation aborted'), { name: 'AbortError' });

    // One canonical variant drives BOTH documents so they match.
    const variantAttrs = extractVariantAttrs(resumeMainHtml);
    const dual = isDualMode(variantAttrs);
    const resumeDoc = buildResumeDocument(resumeMainHtml, variantAttrs);
    const coverDoc  = buildCoverLetterDocument(coverLetter, variantAttrs);

    let resumeBytes = await renderOne(browser, workDir, resumeDoc, 'resume');
    let coverBytes  = await renderOne(browser, workDir, coverDoc, 'cover');

    // Dual-pdf: the render produced a background-LESS PDF (transparent under
    // print media). Post-process to add the design system's view-only OCG cream
    // layer — the result shows warm cream on screen and prints on clean white,
    // with the oxblood name preserved in both states. ink-only skips this (it's
    // already flat white).
    if (dual) {
      const addOcgBackground = loadAddOcgBackground();
      resumeBytes = Buffer.from(await addOcgBackground(resumeBytes, { cream: CREAM }));
      coverBytes  = Buffer.from(await addOcgBackground(coverBytes, { cream: CREAM }));
    }

    await fs.promises.writeFile(resumePdfPath, resumeBytes);
    await fs.promises.writeFile(coverPdfPath, coverBytes);

    return { resumePdfPath, coverPdfPath, workDir: outDir };
  } finally {
    if (browser) await browser.close().catch(() => {});
    // The asset staging dir is disposable immediately; the output dir is
    // returned to the caller (it holds the PDFs until they're copied out).
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch((e) => {
      logger.warn(`[resumePdf] failed to clean asset dir ${workDir}: ${e?.message || e}`);
    });
  }
}
