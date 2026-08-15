/* @ds-bundle: {"format":4,"namespace":"EditorialResumeDesignSystem_895a4b","components":[],"sourceHashes":{"build/dual-mode-pdf.js":"1d2037abaecf","build/test.js":"706e82230b48"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.EditorialResumeDesignSystem_895a4b = window.EditorialResumeDesignSystem_895a4b || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// build/dual-mode-pdf.js
try { (() => {
/* ============================================================
   dual-mode-pdf.js
   ----------------------------------------------------------
   Pure module. Wraps an Optional Content Group (PDF spec §8.11)
   around a warm-cream background rectangle so that the resulting
   PDF shows cream when viewed and prints on white.

   Designed for agent invocation, not human UIs. Two access paths:

     Node:
       const { addOcgBackground } = require('./build/dual-mode-pdf.js');
       const out = await addOcgBackground(rawBytes);
       fs.writeFileSync('resume.pdf', out);

     Browser (also Puppeteer / Playwright contexts):
       <script src="https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js"></script>
       <script src="build/dual-mode-pdf.js"></script>
       <script>
         const out = await DualModePdf.addOcgBackground(bytes);
       </script>

   The transform is pure: bytes in, bytes out. No filesystem, no
   network, no globals beyond `PDFLib`. Idempotent guarded — running
   twice on the same PDF throws rather than stacking layers.

   Verified round-trip: Adobe Reader, Chrome / Edge PDFium, macOS
   Preview, Firefox PDF.js.

   ----------------------------------------------------------
   Structure: PDFLib classes are destructured once at module init;
   every helper closes over them. `addOcgBackground` is a thin
   orchestrator over four single-purpose helpers:

     hasOcgNamed()           — idempotency guard
     registerCreamOcg()      — build the OCG + wire it into /OCProperties
     assertNormalPage()      — reject rotated / cropped pages
     prependCreamRectangle() — draw the cream behind one page's content
   ============================================================ */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    // Node — pdf-lib resolved from the npm package (`npm i pdf-lib@1.17.1`).
    module.exports = factory(require('pdf-lib'));
  } else {
    // Browser / Puppeteer — pdf-lib must be loaded first as a
    // global. Export onto the host object as `DualModePdf`.
    root.DualModePdf = factory(root.PDFLib);
  }
})(typeof self !== 'undefined' ? self : this, function (PDFLib) {
  'use strict';

  if (!PDFLib) {
    throw new Error('dual-mode-pdf: PDFLib not found. Load pdf-lib 1.17.1 from CDN ' + 'before this module, or `require("pdf-lib")` in Node.');
  }

  // PDFLib classes — destructured once, shared by every helper below.
  var PDFDocument = PDFLib.PDFDocument;
  var PDFName = PDFLib.PDFName;
  var PDFArray = PDFLib.PDFArray;
  var PDFDict = PDFLib.PDFDict;
  var PDFString = PDFLib.PDFString;
  var PDFRawStream = PDFLib.PDFRawStream;

  // ----- Constants -------------------------------------------------------

  /* CREAM_RGB must match `--bg` in colors_and_type.css.
   *
   * Single source of truth lives in the CSS token; this constant is the
   * floating-point mirror used when drawing the PDF rectangle. If you
   * change --bg, update this too — or, preferably, pass the cream you
   * want into addOcgBackground({ cream }) at the call site and let this
   * default fall through.
   *
   * Format: [r, g, b] in [0, 1].  #F7F4ED → [247/255, 244/255, 237/255].
   */
  var DEFAULT_CREAM_RGB = [0xF7 / 255, 0xF4 / 255, 0xED / 255];

  /* Layer name. Shown in viewer Layers panels (Acrobat, Preview).
   * The idempotency guard matches on this string, so it must be stable
   * across versions of the module. Treat it as a wire format. */
  var DEFAULT_LAYER_NAME = 'Editorial cream background';

  /* Marked-content name registered on each page's /Resources
   * /Properties dict. Any unique name; "Bg" keeps the content stream
   * short and grep-friendly. */
  var OCG_MC_NAME = 'Bg';

  /* Tolerance (PDF units) when comparing CropBox to MediaBox. */
  var BOX_EPSILON = 0.5;

  // ----- Colour helpers --------------------------------------------------

  /* Parse a "#rrggbb" hex string into [r, g, b] in [0, 1]. Accepts the
   * exact format the CSS design tokens use; rejects everything else
   * so a typo'd value fails loudly instead of rendering wrong. */
  function parseHexColor(hex) {
    if (typeof hex !== 'string') {
      throw new TypeError('cream must be a "#RRGGBB" string or [r,g,b] array');
    }
    var m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) {
      throw new RangeError('cream must match /^#[0-9a-f]{6}$/ — got: ' + hex);
    }
    var n = parseInt(m[1], 16);
    return [(n >> 16 & 0xFF) / 255, (n >> 8 & 0xFF) / 255, (n & 0xFF) / 255];
  }

  /* Coerce a user-supplied colour to [r, g, b] floats. */
  function coerceColor(input, fallback) {
    if (input == null) return fallback;
    if (typeof input === 'string') return parseHexColor(input);
    if (Array.isArray(input) && input.length === 3 && input.every(function (v) {
      return typeof v === 'number' && v >= 0 && v <= 1;
    })) {
      return input.slice();
    }
    throw new TypeError('cream must be a "#RRGGBB" string or [r,g,b] floats in [0,1]; got: ' + JSON.stringify(input));
  }

  // ----- OCG helpers -----------------------------------------------------

  /* Read a PDF name/string object as plain text (PDFString → asString,
   * everything else → String()). Used to compare OCG /Name values. */
  function pdfTextValue(obj) {
    if (!obj) return '';
    return typeof obj.asString === 'function' ? obj.asString() : String(obj);
  }

  /* Idempotency guard. True if any OCG already registered in the
   * document carries `layerName`. Lets the input legitimately carry
   * unrelated OCGs (watermarks, accessibility layers) without
   * triggering a false rejection — only OUR layer name blocks. */
  function hasOcgNamed(ocProps, ctx, layerName) {
    var ocgs = ocProps.lookup(PDFName.of('OCGs'));
    if (!ocgs || typeof ocgs.size !== 'function') return false;
    for (var i = 0; i < ocgs.size(); i++) {
      var ocg = ctx.lookup(ocgs.get(i));
      var name = ocg && ocg.lookup ? ocg.lookup(PDFName.of('Name')) : null;
      if (pdfTextValue(name) === layerName) return true;
    }
    return false;
  }

  /* Ensure `dict` has an array under `name`, creating an empty one if
   * absent or malformed. Returns the array so the caller can push. */
  function ensureArray(dict, name, ctx) {
    var arr = dict.lookup(PDFName.of(name));
    if (!(arr instanceof PDFArray)) {
      arr = PDFArray.withContext(ctx);
      dict.set(PDFName.of(name), arr);
    }
    return arr;
  }

  /* Build the view-on / print-off OCG and wire it into the catalog's
   * /OCProperties. Returns the registered OCG reference.
   *
   * The OCG dictionary:
   *   << /Type /OCG
   *      /Name (Editorial cream background)
   *      /Usage << /Print << /PrintState /OFF >>
   *                /View  << /ViewState  /ON  >> >> >>
   *
   * /Usage drives automatic show/hide based on viewer intent.
   * /Print /PrintState /OFF is the load-bearing declaration — it
   * tells the print pipeline to skip this content.
   *
   * If the document already has /OCProperties (carrying OCGs from
   * other sources) we merge into it rather than overwriting; the
   * caller has already confirmed no existing OCG uses our name. The
   * merge is defensive — any missing /OCGs, /D, /Order or /ON
   * structure is created, so even a malformed-but-present
   * /OCProperties yields a spec-valid result (PDF §8.11.2 requires
   * every OCG to be listed in /OCGs). */
  function registerCreamOcg(pdf, ctx, layerName, existingOcProps) {
    var ocgRef = ctx.register(ctx.obj({
      Type: 'OCG',
      Name: PDFString.of(layerName),
      Usage: {
        Print: {
          PrintState: 'OFF'
        },
        View: {
          ViewState: 'ON'
        }
      }
    }));
    if (existingOcProps) {
      ensureArray(existingOcProps, 'OCGs', ctx).push(ocgRef);
      var dDict = existingOcProps.lookup(PDFName.of('D'));
      if (!(dDict instanceof PDFDict)) {
        dDict = ctx.obj({
          BaseState: 'ON'
        });
        existingOcProps.set(PDFName.of('D'), dDict);
      }
      ensureArray(dDict, 'Order', ctx).push(ocgRef);
      ensureArray(dDict, 'ON', ctx).push(ocgRef);
    } else {
      pdf.catalog.set(PDFName.of('OCProperties'), ctx.obj({
        OCGs: [ocgRef],
        D: {
          Order: [ocgRef],
          ON: [ocgRef],
          OFF: [],
          BaseState: 'ON'
        }
      }));
    }
    return ocgRef;
  }

  // ----- Page helpers ----------------------------------------------------

  /* Page sanity check. The cream rectangle is drawn from (0,0) to
   * (width,height) in MediaBox coordinates with no rotation transform.
   * If the input PDF has /Rotate or a CropBox smaller than MediaBox,
   * the rectangle's positioning becomes unpredictable. Chrome's print-
   * to-PDF doesn't emit either of those for the design system's
   * resume.html, so this is a defensive assert — better to fail loudly
   * than ship a PDF with a misaligned background.
   *
   * Signature matches Array#forEach's (element, index) so it can be
   * passed directly: `pages.forEach(assertNormalPage)`. */
  function assertNormalPage(page, idx) {
    var node = page.node;
    var rotate = node.lookup(PDFName.of('Rotate'));
    if (rotate && typeof rotate.asNumber === 'function' && rotate.asNumber() !== 0) {
      throw new Error('dual-mode-pdf: page ' + (idx + 1) + ' has /Rotate ' + rotate.asNumber() + '; rotated pages are not supported. Re-render the source PDF without rotation.');
    }
    var cropBox = node.lookup(PDFName.of('CropBox'));
    var mediaBox = node.lookup(PDFName.of('MediaBox'));
    if (cropBox && mediaBox) {
      for (var i = 0; i < 4; i++) {
        if (Math.abs(mediaBox.get(i).asNumber() - cropBox.get(i).asNumber()) > BOX_EPSILON) {
          throw new Error('dual-mode-pdf: page ' + (idx + 1) + ' has CropBox ≠ MediaBox; ' + 'this is not supported. Re-render the source PDF without a crop box.');
        }
      }
    }
  }

  /* Draw the cream rectangle into one page, inside the OCG's
   * marked-content section, BENEATH all existing content.
   *
   * PDF graphics operators used:
   *   q             — save graphics state
   *   /OC /Bg BDC   — begin marked content, tag /OC, props /Bg
   *   r g b rg      — set non-stroking colour (RGB, [0,1])
   *   x y w h re    — rectangle (x,y), size w×h
   *   f             — fill the current path
   *   EMC           — end marked content
   *   Q             — restore graphics state
   *
   * The save/restore wrapper guarantees we leave graphics state
   * untouched for whatever follows — critical since we PREPEND this
   * to the page's existing content streams (PDF z-order is drawing
   * order: first drawn = bottom). */
  function prependCreamRectangle(page, ctx, ocgRef, cream, encoder) {
    var node = page.node;
    var size = page.getSize();

    // Ensure /Resources exists.
    var resources = node.Resources();
    if (!resources) {
      resources = ctx.obj({});
      node.set(PDFName.of('Resources'), resources);
    }

    // Ensure /Resources /Properties exists, bind /Bg → OCG. Content
    // streams reference OCGs through Properties, not directly.
    var properties = resources.lookup(PDFName.of('Properties'));
    if (!(properties instanceof PDFDict)) {
      properties = ctx.obj({});
      resources.set(PDFName.of('Properties'), properties);
    }
    properties.set(PDFName.of(OCG_MC_NAME), ocgRef);

    // Build the content stream (no filter — ~100 bytes, compression
    // isn't worth the debugging cost).
    var ops = 'q\n' + '/OC /' + OCG_MC_NAME + ' BDC\n' + cream[0].toFixed(4) + ' ' + cream[1].toFixed(4) + ' ' + cream[2].toFixed(4) + ' rg\n' + '0 0 ' + size.width.toFixed(2) + ' ' + size.height.toFixed(2) + ' re\n' + 'f\n' + 'EMC\n' + 'Q\n';
    var opBytes = encoder.encode(ops);
    var streamRef = ctx.register(PDFRawStream.of(ctx.obj({
      Length: opBytes.length
    }), opBytes));

    // Prepend to /Contents. May be a single stream/ref, an array of
    // refs, or absent.
    var existing = node.get(PDFName.of('Contents'));
    var newContents = PDFArray.withContext(ctx);
    newContents.push(streamRef);
    if (existing instanceof PDFArray) {
      for (var i = 0; i < existing.size(); i++) newContents.push(existing.get(i));
    } else if (existing) {
      newContents.push(existing);
    }
    node.set(PDFName.of('Contents'), newContents);
  }

  // ----- The transform ---------------------------------------------------

  /**
   * Add a view-only OCG layer containing a cream rectangle to every
   * page of the PDF.
   *
   * @param  {Uint8Array | ArrayBuffer | Buffer} inputBytes
   *         Raw bytes of a PDF generated from the editorial design
   *         system with `data-print="dual-pdf"` set (so the page
   *         content stream has no baked-in background fill).
   * @param  {Object} [opts]
   * @param  {string | number[]} [opts.cream]  Background colour for the
   *         OCG layer. "#RRGGBB" hex string OR [r,g,b] in [0,1].
   *         Default: `#F7F4ED` — must match `--bg` in
   *         `colors_and_type.css`. Pass the actual `--bg` value from
   *         the active theme if you've forked the colour palette.
   * @param  {string} [opts.layerName]  Human-readable label shown in
   *         viewer Layers panels and used by the idempotency guard.
   *         Default: "Editorial cream background". Override only if
   *         you need to coexist with another OCG of the same name.
   * @return {Promise<Uint8Array>}
   *         Bytes of the rewritten dual-mode PDF.
   * @throws {Error}
   *         - If the input PDF already contains an OCG with the
   *           target layer name (idempotency guard — regenerate from
   *           source rather than stacking layers).
   *         - If any page has /Rotate ≠ 0 or CropBox ≠ MediaBox
   *           (defensive: rectangle positioning is undefined).
   */
  async function addOcgBackground(inputBytes, opts) {
    opts = opts || {};
    var cream = coerceColor(opts.cream, DEFAULT_CREAM_RGB);
    var layerName = typeof opts.layerName === 'string' && opts.layerName.length ? opts.layerName : DEFAULT_LAYER_NAME;

    // ignoreEncryption lets us read fields out of mildly-protected
    // PDFs. Résumé PDFs aren't encrypted in practice; the option
    // costs nothing.
    var pdf = await PDFDocument.load(inputBytes, {
      ignoreEncryption: true
    });
    var ctx = pdf.context;
    var existingOcProps = pdf.catalog.lookup(PDFName.of('OCProperties'));
    if (existingOcProps && hasOcgNamed(existingOcProps, ctx, layerName)) {
      throw new Error('dual-mode-pdf: input PDF already has an OCG named "' + layerName + '" — looks pre-processed. Re-generate from source HTML.');
    }
    var pages = pdf.getPages();
    pages.forEach(assertNormalPage); // fail loudly before mutating

    var ocgRef = registerCreamOcg(pdf, ctx, layerName, existingOcProps);
    var encoder = new TextEncoder();
    for (var i = 0; i < pages.length; i++) {
      prependCreamRectangle(pages[i], ctx, ocgRef, cream, encoder);
    }

    // useObjectStreams: true (the default) is fine — every viewer in
    // the compatibility table has supported them since 2003. Saves
    // ~20% on output size.
    return await pdf.save();
  }
  return {
    addOcgBackground: addOcgBackground,
    // Exposed for tests + agents that want to introspect.
    DEFAULT_CREAM_RGB: DEFAULT_CREAM_RGB.slice(),
    DEFAULT_LAYER_NAME: DEFAULT_LAYER_NAME
  };
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "build/dual-mode-pdf.js", error: String((e && e.message) || e) }); }

// build/test.js
try { (() => {
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

   No external deps beyond the pdf-lib npm package (`npm i pdf-lib@1.17.1`).
   No filesystem side effects (everything in memory).
   ============================================================ */

'use strict';

var PDFLib = require('pdf-lib');
var Mod = require('./dual-mode-pdf.js');
var addOcgBackground = Mod.addOcgBackground;

// PDFLib classes — destructured once to keep assertions readable.
var PDFDocument = PDFLib.PDFDocument;
var PDFName = PDFLib.PDFName;
var PDFArray = PDFLib.PDFArray;
var PDFDict = PDFLib.PDFDict;
var PDFString = PDFLib.PDFString;
var degrees = PDFLib.degrees;

// ----- Tiny assertion harness ------------------------------------------

var GREEN = '\x1b[32m',
  RED = '\x1b[31m',
  DIM = '\x1b[2m',
  RESET = '\x1b[0m';
var passed = 0,
  failed = 0,
  failures = [];
function ok(name) {
  console.log('  ' + GREEN + '✓' + RESET + ' ' + name);
  passed++;
}
function fail(name, m) {
  console.log('  ' + RED + '✗' + RESET + ' ' + name + ' — ' + m);
  failed++;
  failures.push(name);
}
function header(s) {
  console.log('\n' + s);
}
function assert(cond, name, msg) {
  if (cond) ok(name);else fail(name, msg || 'assertion failed');
}

/* Run `fn` and report whether it threw and (optionally) whether the
 * thrown message matched `pattern`. Collapses the repeated
 * try/catch/flag dance used by every "should throw" assertion. */
async function expectThrow(fn, name, pattern) {
  var threw = false,
    msg = '';
  try {
    await fn();
  } catch (e) {
    threw = true;
    msg = e.message;
  }
  assert(threw && (!pattern || pattern.test(msg)), name, threw ? 'wrong message: ' + msg : 'did not throw');
}

// ----- Fixtures --------------------------------------------------------

async function buildBasePdf(opts) {
  opts = opts || {};
  var pdf = await PDFDocument.create();
  for (var i = 0; i < (opts.pages || 1); i++) {
    var p = pdf.addPage([612, 792]); // US Letter
    p.drawText('Page ' + (i + 1) + ' — test content', {
      x: 72,
      y: 720,
      size: 14
    });
    if (opts.rotate) p.setRotation(degrees(opts.rotate));
  }
  return await pdf.save();
}

/* Build a PDF that already carries a well-formed OCG named `name`,
 * as if produced by another tool — exercises the real merge path. */
async function buildPdfWithOcg(name) {
  var doc = await PDFDocument.create();
  var ctx = doc.context;
  doc.addPage([612, 792]).drawText('x', {
    x: 72,
    y: 720,
    size: 12
  });
  var other = ctx.register(ctx.obj({
    Type: 'OCG',
    Name: PDFString.of(name)
  }));
  doc.catalog.set(PDFName.of('OCProperties'), ctx.obj({
    OCGs: [other],
    D: {
      Order: [other],
      ON: [other],
      OFF: [],
      BaseState: 'ON'
    }
  }));
  return await doc.save();
}

/* Build a PDF whose /OCProperties is present but EMPTY (no /OCGs,
 * no /D) — exercises the defensive merge path. */
async function buildPdfWithEmptyOcProps() {
  var doc = await PDFDocument.create();
  var ctx = doc.context;
  doc.addPage([612, 792]).drawText('x', {
    x: 72,
    y: 720,
    size: 12
  });
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
    viewState: usage && String(usage.lookup(PDFName.of('View')).lookup(PDFName.of('ViewState')))
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
function latin1(bytes) {
  return Buffer.from(bytes).toString('latin1');
}

// ----- Suite -----------------------------------------------------------

async function run() {
  console.log(DIM + 'dual-mode-pdf self-test' + RESET);
  header('Module surface');
  assert(typeof addOcgBackground === 'function', 'addOcgBackground is exported as a function');
  assert(Array.isArray(Mod.DEFAULT_CREAM_RGB) && Mod.DEFAULT_CREAM_RGB.length === 3, 'DEFAULT_CREAM_RGB is exposed');
  assert(typeof Mod.DEFAULT_LAYER_NAME === 'string' && Mod.DEFAULT_LAYER_NAME.length > 0, 'DEFAULT_LAYER_NAME is exposed');
  assert(Math.abs(Mod.DEFAULT_CREAM_RGB[0] - 0xF7 / 255) < 1e-6, 'DEFAULT_CREAM_RGB matches CSS --bg (#F7F4ED)');
  header('Round-trip — single page');
  var base1 = await buildBasePdf({
    pages: 1
  });
  var out1 = await addOcgBackground(base1);
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
  assert(contents instanceof PDFArray && contents.size() === 2, 'page 0 /Contents is a 2-entry array (cream rect prepended + original)');
  header('Round-trip — multi-page');
  var out3 = await addOcgBackground(await buildBasePdf({
    pages: 3
  }));
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
  assert(/0\.9686\s+0\.9569\s+0\.9294\s+rg/.test(raw), 'content stream paints the cream colour matching --bg (#F7F4ED → 0.9686 0.9569 0.9294)');
  header('Idempotency guard');
  await expectThrow(function () {
    return addOcgBackground(out1);
  }, 'second call on output PDF throws (idempotency guard fires)', /already has an OCG/);
  header('Idempotency guard is layer-name-specific');
  // A PDF with a DIFFERENT-named OCG should pass; re-adding the SAME
  // name should be blocked.
  var customOut = await addOcgBackground(base1, {
    layerName: 'Other layer'
  });
  await expectThrow(function () {
    return addOcgBackground(customOut, {
      layerName: 'Other layer'
    });
  }, 'guard fires when re-adding the same-named layer', /already has an OCG/);
  var passedThrough = false;
  try {
    await addOcgBackground(customOut);
    passedThrough = true;
  } catch {/* ignore */}
  assert(passedThrough, 'PDF with unrelated OCGs (different layer name) does NOT trigger the guard');
  header('Custom cream colour');
  var pinkRaw = latin1(await addOcgBackground(base1, {
    cream: '#FFE4E1'
  })); // → 1.0000 0.8941 0.8824
  assert(/1\.0000\s+0\.8941\s+0\.8824\s+rg/.test(pinkRaw), 'cream:"#FFE4E1" string param renders correct RGB');
  var arrRaw = latin1(await addOcgBackground(base1, {
    cream: [0.5, 0.25, 0.125]
  }));
  assert(/0\.5000\s+0\.2500\s+0\.1250\s+rg/.test(arrRaw), 'cream:[r,g,b] array param renders correct RGB');
  await expectThrow(function () {
    return addOcgBackground(base1, {
      cream: '#GGGGGG'
    });
  }, 'cream:"#GGGGGG" (invalid hex) throws');
  await expectThrow(function () {
    return addOcgBackground(base1, {
      cream: [2, 0, 0]
    });
  }, 'cream:[2,0,0] (out of [0,1] range) throws');
  header('Page sanity assertions');
  var rotated = await buildBasePdf({
    pages: 1,
    rotate: 90
  });
  await expectThrow(function () {
    return addOcgBackground(rotated);
  }, 'page with /Rotate 90 is rejected with clear message', /Rotate/);
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
  assert(mOcgs.size() === 2 && mNames.indexOf('Watermark') !== -1 && mNames.indexOf('Editorial cream background') !== -1, 'well-formed merge: both OCGs listed in /OCGs', JSON.stringify(mNames));
  assert(mOcp.lookup(PDFName.of('D')).lookup(PDFName.of('ON')).size() === 2, 'well-formed merge: both OCGs listed in /D/ON');

  // (b) Malformed: /OCProperties present but EMPTY (no /OCGs, no /D).
  //     Our OCG must still be registered in a freshly-created /OCGs —
  //     otherwise the page's /Bg binding references an unlisted OCG
  //     (PDF §8.11.2 violation). Regression guard for that bug.
  var malformed = await buildPdfWithEmptyOcProps();
  var fixedUp = await addOcgBackground(malformed);
  var fPdf = await PDFLib.PDFDocument.load(fixedUp);
  var fOcgs = fPdf.catalog.lookup(PDFName.of('OCProperties')).lookup(PDFName.of('OCGs'));
  assert(fOcgs && typeof fOcgs.size === 'function' && fOcgs.size() >= 1, 'malformed /OCProperties: our OCG is still listed in /OCGs', 'OCGs=' + (fOcgs ? fOcgs.size() : 'MISSING'));
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
})(); } catch (e) { __ds_ns.__errors.push({ path: "build/test.js", error: String((e && e.message) || e) }); }

})();
