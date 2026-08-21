/* ============================================================
   build/test.js — self-verification
   ----------------------------------------------------------
   Round-trips a synthetic PDF through `addOcgBackground()` and
   asserts on the structural properties that make the dual-mode
   contract work: OCG dictionary, /PrintState /OFF flag, per-page
   marked-content stream, /D/AS Print auto-state, idempotency guard, custom-cream param,
   rotation/box assertions, layer-name idempotency boundary.

   Run from the project root:    node build/test.js
   Exit code 0 on success, non-zero on first failure.

   No external deps beyond the pdf-lib npm package (`npm i pdf-lib@1.17.1`).
   No filesystem side effects (everything in memory).
   ============================================================ */

'use strict';

var PDFLib = require('pdf-lib');
var Mod    = require('./dual-mode-pdf.js');
var Tokens = require('./css-tokens.js');

/* The cream colour is READ FROM THE CSS, never restated here. Two
   assertions below used to compare a hardcoded #F7F4ED against the
   module's hardcoded copy of the same value — the pair could drift from
   the actual --bg token in lockstep while reporting a match. */
var CSS_BG      = Tokens.tokenValue('--bg');
var CSS_BG_RGB  = Tokens.hexToRgb01(CSS_BG);
var CSS_BG_OPS  = Tokens.pdfRgbOperands(CSS_BG);
var addOcgBackground = Mod.addOcgBackground;

// PDFLib classes — destructured once to keep assertions readable.
var PDFDocument = PDFLib.PDFDocument;
var PDFName     = PDFLib.PDFName;
var PDFArray    = PDFLib.PDFArray;
var PDFDict     = PDFLib.PDFDict;
var PDFRawStream = PDFLib.PDFRawStream;
var PDFString   = PDFLib.PDFString;
var degrees     = PDFLib.degrees;

// ----- Tiny assertion harness ------------------------------------------

var H = require('./harness.js');
var ok = H.ok, fail = H.fail, header = H.header, assert = H.assert;
var GREEN = H.GREEN, RED = H.RED, DIM = H.DIM, RESET = H.RESET;

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
    if (opts.mediaBox) {
      p.setMediaBox(opts.mediaBox.x, opts.mediaBox.y, opts.mediaBox.width, opts.mediaBox.height);
    }
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

/* Build a PDF that already carries an unrelated OCG AND a Print
 * auto-state rule governing it — exercises the /AS merge path (we
 * must join the existing rule, not author a second equivalent one). */
async function buildPdfWithPrintAutoState(name) {
  var doc = await PDFDocument.create();
  var ctx = doc.context;
  doc.addPage([612, 792]).drawText('x', { x: 72, y: 720, size: 12 });
  var other = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of(name) }));
  doc.catalog.set(PDFName.of('OCProperties'), ctx.obj({
    OCGs: [other],
    D: {
      Order: [other], ON: [other], OFF: [], BaseState: 'ON',
      AS: [{ Event: 'Print', Category: ['Print'], OCGs: [other] }]
    }
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

/* Build a PDF whose catalog points /OCProperties at the wrong object
 * type. The transform should replace it with a valid dictionary rather
 * than crashing while trying to call `.lookup()` on a PDF name. */
async function buildPdfWithNonDictOcProps() {
  var doc = await PDFDocument.create();
  doc.addPage([612, 792]).drawText('x', { x: 72, y: 720, size: 12 });
  doc.catalog.set(PDFName.of('OCProperties'), PDFName.of('Broken'));
  return await doc.save();
}

/* A valid but uncommon /Contents shape: an indirect reference to an
 * array of streams. The rewritten page must flatten that array instead
 * of producing an invalid nested /Contents array. */
async function buildPdfWithIndirectContentsArray() {
  var doc = await PDFDocument.create();
  var ctx = doc.context;
  var page = doc.addPage([612, 792]);
  var bytes = new TextEncoder().encode('q\nQ\n');
  var stream = ctx.register(PDFRawStream.of(ctx.obj({ Length: bytes.length }), bytes));
  var contents = PDFArray.withContext(ctx);
  contents.push(stream);
  page.node.set(PDFName.of('Contents'), ctx.register(contents));
  return await doc.save();
}

/* An unrelated input OCG already owns the short page-resource name
 * /Bg. The new layer must choose another name and leave /Bg intact. */
async function buildPdfWithBgResourceCollision() {
  var doc = await PDFDocument.create();
  var ctx = doc.context;
  var page = doc.addPage([612, 792]);
  page.drawText('x', { x: 72, y: 720, size: 12 });
  var other = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Watermark') }));
  doc.catalog.set(PDFName.of('OCProperties'), ctx.obj({
    OCGs: [other],
    D: { Order: [other], ON: [other], OFF: [], BaseState: 'ON' }
  }));
  page.node.Resources().set(PDFName.of('Properties'), ctx.obj({ Bg: other }));
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

/* Reference (as a "n 0 R" string) of the OCG named `name`, or null. */
function ocgRefByName(pdf, name) {
  var ocProps = pdf.catalog.lookup(PDFName.of('OCProperties'));
  var ocgs = ocProps && ocProps.lookup(PDFName.of('OCGs'));
  if (!ocgs) return null;
  for (var i = 0; i < ocgs.size(); i++) {
    var ocg = pdf.context.lookup(ocgs.get(i));
    var nm = ocg && ocg.lookup(PDFName.of('Name'));
    if (nm && nm.asString() === name) return String(ocgs.get(i));
  }
  return null;
}

/* Flatten /OCProperties /D /AS into plain JS for assertions:
 * [{ event: '/Print', categories: ['/Print'], ocgRefs: ['5 0 R'] }] */
function readAutoStates(pdf) {
  var ocProps = pdf.catalog.lookup(PDFName.of('OCProperties'));
  var dDict = ocProps && ocProps.lookup(PDFName.of('D'));
  var asArr = dDict && dDict.lookup(PDFName.of('AS'));
  var entries = [];
  if (!(asArr instanceof PDFArray)) return entries;
  for (var i = 0; i < asArr.size(); i++) {
    var e = pdf.context.lookup(asArr.get(i));
    if (!(e instanceof PDFDict)) continue;
    var cats = [], cat = e.lookup(PDFName.of('Category'));
    if (cat instanceof PDFArray) {
      for (var c = 0; c < cat.size(); c++) cats.push(String(pdf.context.lookup(cat.get(c))));
    }
    var refs = [], og = e.lookup(PDFName.of('OCGs'));
    if (og instanceof PDFArray) {
      for (var g = 0; g < og.size(); g++) refs.push(String(og.get(g)));
    }
    entries.push({ event: String(e.lookup(PDFName.of('Event'))), categories: cats, ocgRefs: refs });
  }
  return entries;
}

/* The Print/Print auto-state entries of a produced PDF. */
function printAutoStates(pdf) {
  return readAutoStates(pdf).filter(function (e) {
    return e.event === '/Print' && e.categories.indexOf('/Print') !== -1;
  });
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
  assert(Mod.DEFAULT_CREAM_RGB.every(function (v, i) { return Math.abs(v - CSS_BG_RGB[i]) < 1e-6; }),
    'DEFAULT_CREAM_RGB matches the --bg token parsed from colors_and_type.css (' + CSS_BG + ')',
    'module: ' + JSON.stringify(Mod.DEFAULT_CREAM_RGB) + ' vs CSS: ' + JSON.stringify(CSS_BG_RGB));

  header('Round-trip — single page');
  var base1 = await buildBasePdf({ pages: 1 });
  var out1  = await addOcgBackground(base1);
  assert(out1.length > base1.length, 'output PDF is larger than input (cream layer added)');

  var info1 = await inspectFirstOcg(out1);
  assert(!!info1.ocProps, '/OCProperties registered on catalog');
  assert(info1.ocgCount === 1, 'exactly one OCG registered');
  assert(info1.printState === '/OFF', '/Usage/Print/PrintState is /OFF (load-bearing!)');
  assert(info1.viewState === '/ON', '/Usage/View/ViewState is /ON');

  header('Print auto-state (/OCProperties /D /AS)');
  var creamRef1 = ocgRefByName(info1.pdf, Mod.DEFAULT_LAYER_NAME);
  var as1 = printAutoStates(info1.pdf);
  assert(!!creamRef1, 'cream OCG is resolvable by name in /OCGs');
  assert(as1.length === 1, '/D/AS has exactly one Print auto-state entry',
    'found ' + as1.length + ': ' + JSON.stringify(readAutoStates(info1.pdf)));
  assert(as1.length === 1 && as1[0].categories.length === 1 && as1[0].categories[0] === '/Print',
    'Print auto-state /Category is [ /Print ]', JSON.stringify(as1[0] && as1[0].categories));
  assert(as1.length === 1 && as1[0].ocgRefs.length === 1 && as1[0].ocgRefs[0] === creamRef1,
    'Print auto-state /OCGs references the cream OCG',
    JSON.stringify(as1[0] && as1[0].ocgRefs) + ' vs cream ' + creamRef1);

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
  assert(new RegExp(CSS_BG_OPS.join('\\s+') + '\\s+rg').test(raw),
    'content stream paints the cream colour read from --bg (' + CSS_BG + ' → ' + CSS_BG_OPS.join(' ') + ')');

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
  var fullTurn = await buildBasePdf({ pages: 1, rotate: 360 });
  assert((await addOcgBackground(fullTurn)).length > fullTurn.length,
    'page with an effective /Rotate 0 (stored as 360) is accepted');

  var offsetBox = await buildBasePdf({
    pages: 1,
    mediaBox: { x: 10, y: 20, width: 612, height: 792 }
  });
  var offsetRaw = latin1(await addOcgBackground(offsetBox));
  assert(/10\.00\s+20\.00\s+612\.00\s+792\.00\s+re/.test(offsetRaw),
    'non-zero MediaBox origin is preserved when drawing the background');

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
  var mCreamRef = ocgRefByName(mPdf, 'Editorial cream background');
  var mAs = printAutoStates(mPdf);
  assert(mAs.length === 1 && mAs[0].ocgRefs.indexOf(mCreamRef) !== -1,
    'well-formed merge: /D/AS carries one Print rule governing the cream OCG',
    JSON.stringify(mAs));

  // (a2) Input already has its OWN Print auto-state rule. We must join
  //      it (one rule, two OCGs) instead of authoring a duplicate.
  var withAs = await buildPdfWithPrintAutoState('Watermark');
  var mergedAs = await addOcgBackground(withAs);
  var aPdf = await PDFLib.PDFDocument.load(mergedAs);
  var aCreamRef = ocgRefByName(aPdf, 'Editorial cream background');
  var aOther = ocgRefByName(aPdf, 'Watermark');
  var aAs = printAutoStates(aPdf);
  assert(aAs.length === 1, 'existing Print auto-state: no duplicate equivalent entry added',
    'found ' + aAs.length + ': ' + JSON.stringify(aAs));
  assert(aAs.length === 1 && aAs[0].ocgRefs.indexOf(aCreamRef) !== -1 &&
         aAs[0].ocgRefs.indexOf(aOther) !== -1,
    'existing Print auto-state: cream OCG appended alongside the original',
    JSON.stringify(aAs));

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
  var fAs = printAutoStates(fPdf);
  assert(fAs.length === 1 && fAs[0].ocgRefs[0] === ocgRefByName(fPdf, 'Editorial cream background'),
    'malformed /OCProperties: Print auto-state authored on the created /D',
    JSON.stringify(fAs));

  // (c) Malformed: /OCProperties is present but is not a dictionary.
  //     Replace it with a valid structure instead of throwing a TypeError.
  var wrongType = await addOcgBackground(await buildPdfWithNonDictOcProps());
  var wtPdf = await PDFDocument.load(wrongType);
  var wtProps = wtPdf.catalog.lookup(PDFName.of('OCProperties'));
  assert(wtProps instanceof PDFDict && wtProps.lookup(PDFName.of('OCGs')).size() === 1,
    'non-dictionary /OCProperties is replaced with a valid one-OCG dictionary');

  header('Page resource and content preservation');

  var collided = await addOcgBackground(await buildPdfWithBgResourceCollision());
  var cPdf = await PDFDocument.load(collided);
  var cPage = cPdf.getPages()[0];
  var cProps = cPage.node.Resources().lookup(PDFName.of('Properties'));
  var cOtherRef = ocgRefByName(cPdf, 'Watermark');
  var cCreamRef = ocgRefByName(cPdf, 'Editorial cream background');
  assert(String(cProps.get(PDFName.of('Bg'))) === cOtherRef,
    'an existing /Resources/Properties/Bg binding is preserved');
  assert(String(cProps.get(PDFName.of('Bg1'))) === cCreamRef,
    'the cream layer uses the next free resource name after /Bg');
  assert(latin1(collided).indexOf('/OC /Bg1 BDC') !== -1,
    'the prepended stream references the collision-free /Bg1 binding');

  var indirect = await addOcgBackground(await buildPdfWithIndirectContentsArray());
  var iPdf = await PDFDocument.load(indirect);
  var iContents = iPdf.context.lookup(iPdf.getPages()[0].node.get(PDFName.of('Contents')));
  var resolvedStreams = [];
  for (var ii = 0; ii < iContents.size(); ii++) {
    resolvedStreams.push(iPdf.context.lookup(iContents.get(ii)) instanceof PDFRawStream);
  }
  assert(iContents.size() === 2 && resolvedStreams.every(Boolean),
    'indirect /Contents arrays are flattened to two stream entries, never nested',
    'size=' + iContents.size() + ', streams=' + JSON.stringify(resolvedStreams));

  H.report();
}

run().catch(function (e) {
  console.error('\n' + RED + 'Test runner crashed:' + RESET);
  console.error(e.stack || e.message || e);
  process.exit(2);
});
