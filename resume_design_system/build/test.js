#!/usr/bin/env node
/* ============================================================
   build/test.js — self-verification
   ----------------------------------------------------------
   Round-trips a synthetic PDF through `addOcgBackground()` and
   asserts on the structural properties that make the dual-mode
   contract work: OCG dictionary, /PrintState /OFF flag, per-page
   marked-content stream, idempotency guard, custom-cream param,
   rotation/box assertions, layer-name idempotency boundary.

   Run from the project root:    node build/test.js
   Exit code 0 on success, non-zero on first failure.

   No external deps beyond the vendored pdf-lib. No filesystem
   side effects (everything in memory).
   ============================================================ */

'use strict';

var PDFLib = require('./vendor/pdf-lib.min.js');
var Mod    = require('./dual-mode-pdf.js');
var addOcgBackground = Mod.addOcgBackground;

// PDFLib classes — destructured once to keep assertions readable.
var PDFDocument = PDFLib.PDFDocument;
var PDFName     = PDFLib.PDFName;
var PDFArray    = PDFLib.PDFArray;
var PDFDict     = PDFLib.PDFDict;
var PDFString   = PDFLib.PDFString;
var degrees     = PDFLib.degrees;

// ----- Tiny assertion harness ------------------------------------------

var GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', RESET = '\x1b[0m';
var passed = 0, failed = 0, failures = [];

function ok(name)      { console.log('  ' + GREEN + '✓' + RESET + ' ' + name); passed++; }
function fail(name, m) { console.log('  ' + RED + '✗' + RESET + ' ' + name + ' — ' + m); failed++; failures.push(name); }
function header(s)     { console.log('\n' + s); }
function assert(cond, name, msg) { if (cond) ok(name); else fail(name, msg || 'assertion failed'); }

/* Run `fn` and report whether it threw and (optionally) whether the
 * thrown message matched `pattern`. Collapses the repeated
 * try/catch/flag dance used by every "should throw" assertion. */
async function expectThrow(fn, name, pattern) {
  var threw = false, msg = '';
  try { await fn(); } catch (e) { threw = true; msg = e.message; }
  assert(threw && (!pattern || pattern.test(msg)), name,
    threw ? 'wrong message: ' + msg : 'did not throw');
}

// ----- Fixtures --------------------------------------------------------

async function buildBasePdf(opts) {
  opts = opts || {};
  var pdf = await PDFDocument.create();
  for (var i = 0; i < (opts.pages || 1); i++) {
    var p = pdf.addPage([612, 792]); // US Letter
    p.drawText('Page ' + (i + 1) + ' — test content', { x: 72, y: 720, size: 14 });
    if (opts.rotate) p.setRotation(degrees(opts.rotate));
  }
  return await pdf.save();
}

/* Build a PDF that already carries a well-formed OCG named `name`,
 * as if produced by another tool — exercises the real merge path. */
async function buildPdfWithOcg(name) {
  var doc = await PDFDocument.create();
  var ctx = doc.context;
  doc.addPage([612, 792]).drawText('x', { x: 72, y: 720, size: 12 });
  var other = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of(name) }));
  doc.catalog.set(PDFName.of('OCProperties'), ctx.obj({
    OCGs: [other],
    D: { Order: [other], ON: [other], OFF: [], BaseState: 'ON' }
  }));
  return await doc.save();
}

/* Build a PDF whose /OCProperties is present but EMPTY (no /OCGs,
 * no /D) — exercises the defensive merge path. */
async function buildPdfWithEmptyOcProps() {
  var doc = await PDFDocument.create();
  var ctx = doc.context;
  doc.addPage([612, 792]).drawText('x', { x: 72, y: 720, size: 12 });
  doc.catalog.set(PDFName.of('OCProperties'), ctx.obj({}));
  return await doc.save();
}

/* Read the first OCG of a produced PDF and return the handles tests
 * care about. Centralises the catalog → OCGs → OCG → Usage walk. */
async function inspectFirstOcg(bytes) {
  var pdf = await PDFDocument.load(bytes);
  var ocProps = pdf.catalog.lookup(PDFName.of('OCProperties'));
  var ocgs = ocProps && ocProps.lookup(PDFName.of('OCGs'));
  var ocg = ocgs && pdf.context.lookup(ocgs.get(0));
  var usage = ocg && ocg.lookup(PDFName.of('Usage'));
  return {
    pdf: pdf,
    ocProps: ocProps,
    ocgCount: ocgs ? ocgs.size() : 0,
    printState: usage && String(usage.lookup(PDFName.of('Print')).lookup(PDFName.of('PrintState'))),
    viewState:  usage && String(usage.lookup(PDFName.of('View')).lookup(PDFName.of('ViewState')))
  };
}

/* True if every page carries the /Resources/Properties/Bg → OCG binding. */
function everyPageHasBgBinding(pdf) {
  return pdf.getPages().every(function (p) {
    var res = p.node.Resources();
    var props = res && res.lookup(PDFName.of('Properties'));
    return !!(props && props.lookup(PDFName.of('Bg')));
  });
}

function latin1(bytes) { return Buffer.from(bytes).toString('latin1'); }

// ----- Suite -----------------------------------------------------------

async function run() {
  console.log(DIM + 'dual-mode-pdf self-test' + RESET);

  header('Module surface');
  assert(typeof addOcgBackground === 'function', 'addOcgBackground is exported as a function');
  assert(Array.isArray(Mod.DEFAULT_CREAM_RGB) && Mod.DEFAULT_CREAM_RGB.length === 3, 'DEFAULT_CREAM_RGB is exposed');
  assert(typeof Mod.DEFAULT_LAYER_NAME === 'string' && Mod.DEFAULT_LAYER_NAME.length > 0, 'DEFAULT_LAYER_NAME is exposed');
  assert(Math.abs(Mod.DEFAULT_CREAM_RGB[0] - 0xF7 / 255) < 1e-6, 'DEFAULT_CREAM_RGB matches CSS --bg (#F7F4ED)');

  header('Round-trip — single page');
  var base1 = await buildBasePdf({ pages: 1 });
  var out1  = await addOcgBackground(base1);
  assert(out1.length > base1.length, 'output PDF is larger than input (cream layer added)');

  var info1 = await inspectFirstOcg(out1);
  assert(!!info1.ocProps, '/OCProperties registered on catalog');
  assert(info1.ocgCount === 1, 'exactly one OCG registered');
  assert(info1.printState === '/OFF', '/Usage/Print/PrintState is /OFF (load-bearing!)');
  assert(info1.viewState === '/ON', '/Usage/View/ViewState is /ON');

  var page0 = info1.pdf.getPages()[0];
  var resProps = page0.node.Resources().lookup(PDFName.of('Properties'));
  assert(!!resProps.lookup(PDFName.of('Bg')), 'page 0 /Resources/Properties/Bg → OCG binding present');

  var contents = page0.node.get(PDFName.of('Contents'));
  assert(contents instanceof PDFArray && contents.size() === 2,
    'page 0 /Contents is a 2-entry array (cream rect prepended + original)');

  header('Round-trip — multi-page');
  var out3 = await addOcgBackground(await buildBasePdf({ pages: 3 }));
  var pdf3 = await PDFDocument.load(out3);
  assert(pdf3.getPages().length === 3, '3-page input → 3-page output');
  assert(everyPageHasBgBinding(pdf3), 'every page has the OCG marked-content binding');

  header('Raw byte sanity (content streams only)');
  // Content streams are NOT compressed into object streams, so these
  // markers survive in raw bytes. (OCG dictionary markers like
  // /Type /OCG and /PrintState /OFF DO get object-streamed when
  // useObjectStreams is on — verify those through structural
  // inspection above, not raw text search.)
  var raw = latin1(out1);
  assert(raw.indexOf('/OC /Bg BDC') !== -1, 'content stream contains /OC /Bg BDC marker');
  assert(raw.indexOf('EMC') !== -1, 'content stream contains EMC terminator');
  assert(/0\.9686\s+0\.9569\s+0\.9294\s+rg/.test(raw),
    'content stream paints the cream colour matching --bg (#F7F4ED → 0.9686 0.9569 0.9294)');

  header('Idempotency guard');
  await expectThrow(function () { return addOcgBackground(out1); },
    'second call on output PDF throws (idempotency guard fires)', /already has an OCG/);

  header('Idempotency guard is layer-name-specific');
  // A PDF with a DIFFERENT-named OCG should pass; re-adding the SAME
  // name should be blocked.
  var customOut = await addOcgBackground(base1, { layerName: 'Other layer' });
  await expectThrow(function () { return addOcgBackground(customOut, { layerName: 'Other layer' }); },
    'guard fires when re-adding the same-named layer', /already has an OCG/);
  var passedThrough = false;
  try { await addOcgBackground(customOut); passedThrough = true; } catch { /* ignore */ }
  assert(passedThrough, 'PDF with unrelated OCGs (different layer name) does NOT trigger the guard');

  header('Custom cream colour');
  var pinkRaw = latin1(await addOcgBackground(base1, { cream: '#FFE4E1' }));   // → 1.0000 0.8941 0.8824
  assert(/1\.0000\s+0\.8941\s+0\.8824\s+rg/.test(pinkRaw), 'cream:"#FFE4E1" string param renders correct RGB');
  var arrRaw = latin1(await addOcgBackground(base1, { cream: [0.5, 0.25, 0.125] }));
  assert(/0\.5000\s+0\.2500\s+0\.1250\s+rg/.test(arrRaw), 'cream:[r,g,b] array param renders correct RGB');
  await expectThrow(function () { return addOcgBackground(base1, { cream: '#GGGGGG' }); }, 'cream:"#GGGGGG" (invalid hex) throws');
  await expectThrow(function () { return addOcgBackground(base1, { cream: [2, 0, 0] }); }, 'cream:[2,0,0] (out of [0,1] range) throws');

  header('Page sanity assertions');
  var rotated = await buildBasePdf({ pages: 1, rotate: 90 });
  await expectThrow(function () { return addOcgBackground(rotated); },
    'page with /Rotate 90 is rejected with clear message', /Rotate/);

  header('Input flexibility');
  var ab = base1.buffer.slice(base1.byteOffset, base1.byteOffset + base1.byteLength);
  var abOut = await addOcgBackground(ab);
  assert(abOut instanceof Uint8Array && abOut.length > base1.length, 'accepts ArrayBuffer input');
  var bufOut = await addOcgBackground(Buffer.from(base1));
  assert(bufOut instanceof Uint8Array && bufOut.length > base1.length, 'accepts Node Buffer input');

  header('Merge into existing /OCProperties');
  // (a) Well-formed: input already carries an unrelated OCG. Both must
  //     end up listed in /OCGs and /D/ON.
  var withOcg = await buildPdfWithOcg('Watermark');
  var merged = await addOcgBackground(withOcg);
  var mPdf = await PDFLib.PDFDocument.load(merged);
  var mOcp = mPdf.catalog.lookup(PDFName.of('OCProperties'));
  var mOcgs = mOcp.lookup(PDFName.of('OCGs'));
  var mNames = [];
  for (var mi = 0; mi < mOcgs.size(); mi++) {
    mNames.push(mPdf.context.lookup(mOcgs.get(mi)).lookup(PDFName.of('Name')).asString());
  }
  assert(mOcgs.size() === 2 && mNames.indexOf('Watermark') !== -1 &&
         mNames.indexOf('Editorial cream background') !== -1,
    'well-formed merge: both OCGs listed in /OCGs', JSON.stringify(mNames));
  assert(mOcp.lookup(PDFName.of('D')).lookup(PDFName.of('ON')).size() === 2,
    'well-formed merge: both OCGs listed in /D/ON');

  // (b) Malformed: /OCProperties present but EMPTY (no /OCGs, no /D).
  //     Our OCG must still be registered in a freshly-created /OCGs —
  //     otherwise the page's /Bg binding references an unlisted OCG
  //     (PDF §8.11.2 violation). Regression guard for that bug.
  var malformed = await buildPdfWithEmptyOcProps();
  var fixedUp = await addOcgBackground(malformed);
  var fPdf = await PDFLib.PDFDocument.load(fixedUp);
  var fOcgs = fPdf.catalog.lookup(PDFName.of('OCProperties')).lookup(PDFName.of('OCGs'));
  assert(fOcgs && typeof fOcgs.size === 'function' && fOcgs.size() >= 1,
    'malformed /OCProperties: our OCG is still listed in /OCGs',
    'OCGs=' + (fOcgs ? fOcgs.size() : 'MISSING'));

  console.log('\n' + (failed === 0 ? GREEN : RED) + passed + ' passed, ' + failed + ' failed' + RESET);
  if (failed > 0) {
    console.log(RED + 'Failures: ' + failures.join(', ') + RESET);
    process.exit(1);
  }
}

run().catch(function (e) {
  console.error('\n' + RED + 'Test runner crashed:' + RESET);
  console.error(e.stack || e.message || e);
  process.exit(2);
});
