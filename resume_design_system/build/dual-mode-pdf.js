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
       <script src="build/vendor/pdf-lib.min.js"></script>
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
    // Node — pdf-lib resolved from local vendor dir.
    module.exports = factory(require('./vendor/pdf-lib.min.js'));
  } else {
    // Browser / Puppeteer — pdf-lib must be loaded first as a
    // global. Export onto the host object as `DualModePdf`.
    root.DualModePdf = factory(root.PDFLib);
  }
}(typeof self !== 'undefined' ? self : this, function (PDFLib) {
  'use strict';

  if (!PDFLib) {
    throw new Error(
      'dual-mode-pdf: PDFLib not found. Load build/vendor/pdf-lib.min.js ' +
      'before this module, or require pdf-lib in Node.'
    );
  }

  // PDFLib classes — destructured once, shared by every helper below.
  var PDFDocument  = PDFLib.PDFDocument;
  var PDFName      = PDFLib.PDFName;
  var PDFArray     = PDFLib.PDFArray;
  var PDFDict      = PDFLib.PDFDict;
  var PDFString    = PDFLib.PDFString;
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
    return [((n >> 16) & 0xFF) / 255, ((n >> 8) & 0xFF) / 255, (n & 0xFF) / 255];
  }

  /* Coerce a user-supplied colour to [r, g, b] floats. */
  function coerceColor(input, fallback) {
    if (input == null) return fallback;
    if (typeof input === 'string') return parseHexColor(input);
    if (Array.isArray(input) && input.length === 3 &&
        input.every(function (v) { return typeof v === 'number' && v >= 0 && v <= 1; })) {
      return input.slice();
    }
    throw new TypeError(
      'cream must be a "#RRGGBB" string or [r,g,b] floats in [0,1]; got: ' +
      JSON.stringify(input)
    );
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
        Print: { PrintState: 'OFF' },
        View:  { ViewState:  'ON'  }
      }
    }));

    if (existingOcProps) {
      ensureArray(existingOcProps, 'OCGs', ctx).push(ocgRef);

      var dDict = existingOcProps.lookup(PDFName.of('D'));
      if (!(dDict instanceof PDFDict)) {
        dDict = ctx.obj({ BaseState: 'ON' });
        existingOcProps.set(PDFName.of('D'), dDict);
      }
      ensureArray(dDict, 'Order', ctx).push(ocgRef);
      ensureArray(dDict, 'ON', ctx).push(ocgRef);
    } else {
      pdf.catalog.set(PDFName.of('OCProperties'), ctx.obj({
        OCGs: [ocgRef],
        D: { Order: [ocgRef], ON: [ocgRef], OFF: [], BaseState: 'ON' }
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
      throw new Error(
        'dual-mode-pdf: page ' + (idx + 1) + ' has /Rotate ' + rotate.asNumber() +
        '; rotated pages are not supported. Re-render the source PDF without rotation.'
      );
    }

    var cropBox = node.lookup(PDFName.of('CropBox'));
    var mediaBox = node.lookup(PDFName.of('MediaBox'));
    if (cropBox && mediaBox) {
      for (var i = 0; i < 4; i++) {
        if (Math.abs(mediaBox.get(i).asNumber() - cropBox.get(i).asNumber()) > BOX_EPSILON) {
          throw new Error(
            'dual-mode-pdf: page ' + (idx + 1) + ' has CropBox ≠ MediaBox; ' +
            'this is not supported. Re-render the source PDF without a crop box.'
          );
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
    var ops =
      'q\n' +
      '/OC /' + OCG_MC_NAME + ' BDC\n' +
      cream[0].toFixed(4) + ' ' + cream[1].toFixed(4) + ' ' + cream[2].toFixed(4) + ' rg\n' +
      '0 0 ' + size.width.toFixed(2) + ' ' + size.height.toFixed(2) + ' re\n' +
      'f\n' +
      'EMC\n' +
      'Q\n';
    var opBytes = encoder.encode(ops);
    var streamRef = ctx.register(
      PDFRawStream.of(ctx.obj({ Length: opBytes.length }), opBytes)
    );

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
    var layerName = (typeof opts.layerName === 'string' && opts.layerName.length)
      ? opts.layerName
      : DEFAULT_LAYER_NAME;

    // ignoreEncryption lets us read fields out of mildly-protected
    // PDFs. Résumé PDFs aren't encrypted in practice; the option
    // costs nothing.
    var pdf = await PDFDocument.load(inputBytes, { ignoreEncryption: true });
    var ctx = pdf.context;
    var existingOcProps = pdf.catalog.lookup(PDFName.of('OCProperties'));

    if (existingOcProps && hasOcgNamed(existingOcProps, ctx, layerName)) {
      throw new Error(
        'dual-mode-pdf: input PDF already has an OCG named "' + layerName +
        '" — looks pre-processed. Re-generate from source HTML.'
      );
    }

    var pages = pdf.getPages();
    pages.forEach(assertNormalPage);          // fail loudly before mutating

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
}));
