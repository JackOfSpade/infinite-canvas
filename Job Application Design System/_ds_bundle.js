/* @ds-bundle: {"format":4,"namespace":"JobApplicationDesignSystem_895a4b","components":[],"sourceHashes":{"build/annotation-typography-test.js":"235419a376f0","build/ats-parse-test.js":"626764bd6f39","build/dual-mode-pdf.js":"1d2037abaecf","build/education-placement-test.js":"4b27301f2b83","build/test.js":"706e82230b48"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.JobApplicationDesignSystem_895a4b = window.JobApplicationDesignSystem_895a4b || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// build/annotation-typography-test.js
try { (() => {
/* ============================================================
   build/annotation-typography-test.js — typography regression
   ----------------------------------------------------------
   Guards STYLE.md §5.4: the inline annotation spans (.scope,
   .tradeoff, .annotation-label) are SEMANTIC ONLY. They can begin
   mid-bullet, so any font / colour / tracking of their own makes a
   single bullet visibly switch type partway through a sentence.

   This test is static (parses the CSS sources) so it runs in CI with
   no browser. The computed-style companion — same contract, measured
   in a real engine — is build/annotation-typography-test.html.

   Run from the project root:  node build/annotation-typography-test.js
   Exit code 0 on success, 1 on first failure.
   ============================================================ */

'use strict';

var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');
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

/* The classes under guard, and the properties that would break a
   continuous read if they took any value other than `inherit`. */
var ANNOTATION_CLASSES = ['scope', 'tradeoff', 'annotation-label'];
var GUARDED_PROPS = ['font', 'font-family', 'font-size', 'font-style', 'font-weight', 'font-variant', 'line-height', 'letter-spacing', 'word-spacing', 'color'];
/* Every guarded longhand must be pinned to the parent bullet. `font`
   (shorthand) is accepted in place of the individual font longhands. */
var REQUIRED_INHERITS = ['font-family', 'font-size', 'font-style', 'font-weight', 'letter-spacing', 'color'];

/* Strip comments, then split into { selector, decls } rule objects.
   Deliberately naive — enough for these hand-written stylesheets, and
   it never has to resolve the cascade: the contract is "no rule in the
   system gives these classes a non-inherit value", which is a purely
   textual property. @media / @page blocks are flattened by pulling out
   their inner rules. */
function parseRules(css) {
  var src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  var rules = [],
    re = /([^{}]+)\{([^{}]*)\}/g,
    m;
  while ((m = re.exec(src)) !== null) {
    var sel = m[1].replace(/\s+/g, ' ').trim();
    if (!sel || sel.charAt(0) === '@') continue; // at-rule preamble
    rules.push({
      selector: sel,
      body: m[2]
    });
  }
  return rules;
}
function declarations(body) {
  return body.split(';').map(function (d) {
    return d.trim();
  }).filter(Boolean).map(function (d) {
    var i = d.indexOf(':');
    if (i === -1) return null;
    return {
      prop: d.slice(0, i).trim().toLowerCase(),
      value: d.slice(i + 1).trim()
    };
  }).filter(Boolean);
}

/* Rules whose selector list touches one of the annotation classes. */
function annotationRules(rules) {
  return rules.filter(function (r) {
    return ANNOTATION_CLASSES.some(function (c) {
      return new RegExp('\\.' + c + '(?![\\w-])').test(r.selector);
    });
  });
}
function isInherit(value) {
  return /^inherit$/i.test(value.replace(/\s*!important\s*$/i, '').trim());
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/* ---- the source of truth: the résumé stylesheet -------------------- */

header(DIM + 'inline annotation typography' + RESET + '\nresume.css — the annotation rule');
var resumeCss = read('resume.css');
var resumeRules = annotationRules(parseRules(resumeCss));
assert(resumeRules.length > 0, 'resume.css still styles the annotation classes (rule present)', 'no rule matched .scope / .tradeoff / .annotation-label');

/* 1. Every guarded property that IS declared must be `inherit`. */
var offenders = [];
resumeRules.forEach(function (r) {
  declarations(r.body).forEach(function (d) {
    if (GUARDED_PROPS.indexOf(d.prop) !== -1 && !isInherit(d.value)) {
      offenders.push(r.selector + ' { ' + d.prop + ': ' + d.value + ' }');
    }
  });
});
assert(offenders.length === 0, 'no font-size / font-style / font-family / color / tracking override on the annotation classes', offenders.join('  |  '));

/* 2. …and the load-bearing ones must actually be declared, so the spans
      are pinned even if a future rule elsewhere targets a bare span. */
var declared = {};
resumeRules.forEach(function (r) {
  declarations(r.body).forEach(function (d) {
    if (isInherit(d.value)) declared[d.prop] = true;
  });
});
var missing = REQUIRED_INHERITS.filter(function (p) {
  return !declared[p] && !(declared.font && p.indexOf('font-') === 0);
});
assert(missing.length === 0, 'annotation spans inherit the parent bullet type explicitly (' + REQUIRED_INHERITS.join(', ') + ')', 'not inherited: ' + missing.join(', '));

/* 3. The specific bug this test exists for: italic on .tradeoff. */
var italic = resumeRules.filter(function (r) {
  return /\.tradeoff(?![\w-])/.test(r.selector) && declarations(r.body).some(function (d) {
    return d.prop === 'font-style' && /italic|oblique/i.test(d.value);
  });
});
assert(italic.length === 0, '.tradeoff does not apply italic styling', italic.map(function (r) {
  return r.selector;
}).join(', '));

/* 4. No caption token smuggled in by name. */
assert(!/\.(scope|tradeoff|annotation-label)[^{}]*\{[^{}]*--fs-caption/.test(resumeCss.replace(/\/\*[\s\S]*?\*\//g, '')), 'annotation classes do not reference --fs-caption');

/* 5. <strong> in a bullet is NOT part of this contract — genuine metrics
      keep their weight. Guard against an over-broad "inherit everything"
      fix that flattens them too. */
var strongRules = parseRules(resumeCss).concat(parseRules(read('cover-letter.css'))).filter(function (r) {
  return /\bstrong\b/.test(r.selector);
});
assert(strongRules.some(function (r) {
  return declarations(r.body).some(function (d) {
    return d.prop === 'font-weight' && !isInherit(d.value);
  });
}), '<strong> still carries its own weight (metrics untouched)');

/* ---- preview cards must not re-teach the old treatment ------------- */

header('preview cards — no caption/italic annotation treatment');
['preview/component-bullet.html', 'preview/color-ink-roles.html'].forEach(function (rel) {
  var css = (read(rel).match(/<style[^>]*>([\s\S]*?)<\/style>/i) || ['', ''])[1];
  var bad = [];
  annotationRules(parseRules(css)).forEach(function (r) {
    declarations(r.body).forEach(function (d) {
      if (GUARDED_PROPS.indexOf(d.prop) !== -1 && !isInherit(d.value)) {
        bad.push(r.selector + ' { ' + d.prop + ': ' + d.value + ' }');
      }
    });
  });
  assert(bad.length === 0, rel + ' renders annotations in the bullet’s own type', bad.join('  |  '));
});

/* ---- the documentation must not claim the old treatment ------------ */

header('documentation — no stale caption/italic claim');

/* Literal stale phrases, not heuristics — each one is a sentence that
   used to describe the buggy treatment. */
var STALE = [['STYLE.md', 'italic `--ink-meta`'], ['STYLE.md', 'scope chip, trade-off note'], ['SKILL.md', 'annotation** (italic'], ['colors_and_type.css', 'scope chip, tradeoff note']];
STALE.forEach(function (pair) {
  assert(read(pair[0]).indexOf(pair[1]) === -1, pair[0] + ' no longer says "' + pair[1] + '"');
});
/* And the replacement claim is actually documented. */
assert(/inherit the owning\s+bullet's/i.test(read('STYLE.md').replace(/[’']/g, "'")), 'STYLE.md §5.4 states the spans inherit the owning bullet’s type');
console.log('\n' + (failed === 0 ? GREEN : RED) + passed + ' passed, ' + failed + ' failed' + RESET);
if (failed > 0) {
  console.log(RED + 'Failures: ' + failures.join(', ') + RESET);
  process.exit(1);
}
})(); } catch (e) { __ds_ns.__errors.push({ path: "build/annotation-typography-test.js", error: String((e && e.message) || e) }); }

// build/ats-parse-test.js
try { (() => {
/* ============================================================
   build/ats-parse-test.js — parse-safety gate
   ----------------------------------------------------------
   Enforces the hard hazards in STYLE.md §8.1: the set of things that
   silently destroy a résumé's PDF text layer while looking perfect on
   screen. Every check here is FREE — none of them trades away any of
   the system's typography. Beauty-versus-parsing trade-offs are
   deliberately NOT enforced (see §8.1 for what is kept and why).

   Static: parses the shipped HTML + the résumé stylesheet, so it runs
   in CI with no browser and no PDF toolchain.

   Run from the project root:
     node build/ats-parse-test.js                  # the shipped samples
     node build/ats-parse-test.js out/filled.html  # any filled document

   Exit code 0 on success, 1 on any hazard found.
   ============================================================ */

'use strict';

var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');
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
function read(rel) {
  return fs.readFileSync(path.isAbsolute(rel) ? rel : path.join(ROOT, rel), 'utf8');
}
/* Candidate copy only. Stripped, because none of it reaches the text layer
   of the printed document: HTML comments (documentation prose), the date
   script, and <template> content (the offline-bundle splash mark, which is
   inert markup outside the document flow). */
function copyOf(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<template[\s\S]*?<\/template>/gi, '');
}
function mainOf(html) {
  return (copyOf(html).match(/<main[\s\S]*?<\/main>/i) || [''])[0];
}
var targets = process.argv.slice(2);
if (targets.length === 0) targets = ['resume.html', 'cover-letter.html'];

/* ---- per-document hazards ----------------------------------------- */

/* Each hazard: [label, regexp over candidate copy, why]. A match fails. */
var HAZARDS = [['no <table> (cell reading order interleaves lines)', /<table[\s>]/i], ['no <img> / <svg> / <canvas> (text in them extracts as nothing)', /<(img|svg|canvas|picture)[\s>]/i, 'main'], ['no position:absolute / fixed on content', /position\s*:\s*(absolute|fixed)/i], ['no CSS columns (real columns interleave on parse)', /column-(count|width)\s*:/i], ['no hidden or zero-size text (reads as keyword stuffing)', /(visibility\s*:\s*hidden|opacity\s*:\s*0(?!\.)|font-size\s*:\s*0(px|pt)?\s*[;"'])/i], ['no tabular figures (every digit drops from the PDF)', /(tabular-nums|["']tnum["'])/i], ['no &nbsp; in candidate copy (use class="nowrap")', /&nbsp;|&#160;|&#xa0;|\u00a0/i], ['no <font> / <center> / inline text-align hacks', /<(font|center)[\s>]/i]];
targets.forEach(function (rel) {
  header(DIM + 'parse safety' + RESET + '\n' + rel);
  var html = read(rel),
    copy = copyOf(html),
    main = mainOf(html);
  HAZARDS.forEach(function (h) {
    /* Most hazards are illegal anywhere in the file; imagery is judged
       inside <main> only, since the document body is what gets printed. */
    var m = (h[2] === 'main' ? main : copy).match(h[1]);
    assert(!m, h[0], m ? 'found ' + JSON.stringify(String(m[0]).slice(0, 40)) : '');
  });

  /* Contact details must sit inside <main>, not in page chrome. */
  assert(/<main[\s>]/i.test(copy), 'document has a <main> landmark');
  assert(/mailto:/i.test(main), 'email is inside <main>', 'no mailto: link within <main>');
  var telOutside = /tel:/i.test(copy) && !/tel:/i.test(main);
  assert(!telOutside, 'phone (when present) is inside <main>');

  /* Reading order: the name must be the first text in <main>, and the
     contact block must precede the first section heading. */
  var nameAt = main.search(/class="name"/);
  var contactAt = main.search(/class="contact"/);
  var firstH2 = main.search(/<h2[\s>]/i);
  assert(nameAt !== -1 && (contactAt === -1 || nameAt < contactAt), 'name precedes the contact block in source order');
  assert(contactAt === -1 || firstH2 === -1 || contactAt < firstH2, 'contact block precedes the first section heading');

  /* Headings must be real heading elements, not styled divs. */
  var fakeHeads = copy.match(/<(div|p|span)[^>]*class="[^"]*section-head[^"]*"[^>]*>\s*<(?!h[1-6])/gi) || [];
  assert(fakeHeads.length === 0, 'section heads contain a real <h2>', fakeHeads.length + ' styled non-heading(s)');

  /* Dates are machine-readable where the system says they are. */
  if (/class="role-dates"/.test(copy)) {
    assert(/<time datetime="/.test(copy), 'role dates carry <time datetime>');
  }

  /* Every number a screener reads must be real text, not a symbol-only
     claim: a line whose ONLY figure is a signed delta written with the
     true minus (−) is unmatchable by a `-74%` pattern, so §8.1 requires
     the direction in words somewhere on the line. Advisory-strength: we
     check the weaker invariant that digits exist alongside it. */
  var minusLines = copy.match(/[^\n]*\u2212[^\n]*/g) || [];
  var bareMinus = minusLines.filter(function (l) {
    return !/\d/.test(l.replace(/\u2212/g, ''));
  });
  assert(bareMinus.length === 0, 'no line carries a minus sign with no extractable digits');
});

/* ---- stylesheet-level hazards ------------------------------------- */

/* Every sheet a shipped document loads is scanned, not just resume.css —
   a hazard added to the letter surface or the token sheet reaches the
   page just as surely. */
var SHEETS = ['colors_and_type.css', 'resume.css', 'cover-letter.css'];
header('stylesheets — no hazard in any sheet a document loads');
SHEETS.forEach(function (sheet) {
  /* Comments stripped: the sheets document several hazards in prose ("do
     not reintroduce tabular-nums"), and a doc comment must never trip a
     check that is looking for a real declaration. */
  var s = read(sheet).replace(/\/\*[\s\S]*?\*\//g, '');
  assert(!/tabular-nums|["']tnum["']/.test(s), sheet + ': no rule enables tabular figures');
  assert(!/column-(count|width)\s*:/.test(s), sheet + ': no CSS multi-column rule');
  /* `position: absolute` is legitimate on the bullet pseudo-element and
     nowhere else, so skip ::before/::after rules and flag the rest. */
  var positioned = (s.match(/([^{}]+)\{[^}]*position\s*:\s*(absolute|fixed)[^}]*\}/g) || []).map(function (r) {
    return r.slice(0, r.indexOf('{')).replace(/\s+/g, ' ').trim();
  }).filter(function (sel) {
    return !/::?(before|after)\b/.test(sel);
  });
  assert(positioned.length === 0, sheet + ': no rule positions content absolutely (bullet pseudo-element excepted)', positioned.join(' | '));
  assert(!/visibility\s*:\s*hidden|font-size\s*:\s*0(px|pt)?\s*[;}]/.test(s), sheet + ': no rule hides text');
});
header('resume.css — parse-safe rules are in place');
var css = read('resume.css').replace(/\/\*[\s\S]*?\*\//g, '');
assert(/\.nowrap\s*\{[^}]*white-space\s*:\s*nowrap/.test(css), '.nowrap utility exists (the parse-safe replacement for &nbsp;)');
assert(/font-variant-numeric\s*:\s*normal/.test(css), 'proportional numerals are pinned (tabular figures would empty the text layer)');

/* CSS `content` is DECORATIVE ONLY: the bullet glyph, nothing else. Any
   other value is text meaning that copy-paste and PDF extraction drop —
   the exact failure the annotation labels were moved into markup to avoid
   (§5.4). Whitelist by EXACT value: a substring test would wave through
   `content: " · trade-off: "`, which is the case this check exists for. */
var DECORATIVE = /^("|')(\\2022|\u2022|\s*)\1$/;
var contents = (css.match(/content\s*:\s*("[^"]*"|'[^']*')/g) || []).map(function (d) {
  return d.replace(/content\s*:\s*/, '').trim();
});
var meaningful = contents.filter(function (v) {
  return !DECORATIVE.test(v);
});
assert(meaningful.length === 0, 'CSS content is decorative only (bullet glyph); no text meaning lives in CSS', meaningful.join(' | '));
/* Guard the guard: the whitelist must actually reject a real label. */
assert(!DECORATIVE.test('" \u00b7 trade-off: "') && DECORATIVE.test('"\\2022"'), 'the decorative whitelist rejects a multi-word label and accepts the bullet glyph');

/* Single column, and no positioned content — covered per-sheet above. */
assert(true, 'stylesheet hazards checked across ' + SHEETS.length + ' sheets');
console.log('\n' + (failed === 0 ? GREEN : RED) + passed + ' passed, ' + failed + ' failed' + RESET);
if (failed > 0) {
  console.log(RED + 'Failures: ' + failures.join(', ') + RESET);
  process.exit(1);
}
})(); } catch (e) { __ds_ns.__errors.push({ path: "build/ats-parse-test.js", error: String((e && e.message) || e) }); }

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

// build/education-placement-test.js
try { (() => {
/* ============================================================
   build/education-placement-test.js — structural regression
   ----------------------------------------------------------
   Guards STYLE.md §5.8: education has exactly ONE home in this
   system — the header subtitle,
     [current professional role] · [highest completed degree], [institution]
   — and the dedicated Education section is gone for good. No
   alternate section, no early-career exception, no toggle, no
   variant.

   Static (parses the shipped sources), so it runs in CI with no
   browser. The rendered/computed-style companion is
   build/education-placement-test.html.

   Run from the project root:  node build/education-placement-test.js
   Exit code 0 on success, 1 on first failure.
   ============================================================ */

'use strict';

var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');
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
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}
function listPreviews() {
  return fs.readdirSync(path.join(ROOT, 'preview')).filter(function (f) {
    return /\.html$/.test(f);
  }).map(function (f) {
    return 'preview/' + f;
  });
}

/* Markers of the removed section, in markup and in CSS. */
var SECTION_MARKERS = [/id\s*=\s*"sec-education"/i, /aria-labelledby\s*=\s*"sec-education"/i, /<h2[^>]*>\s*Education\s*<\/h2>/i, /class\s*=\s*"[^"]*\bedu-(line|school|degree|meta)\b/i, /\.edu-(line|school|degree|meta)\b/];

/* ---- the template ------------------------------------------------- */

header(DIM + 'education placement' + RESET + '\nresume.html — no dedicated Education section');
var resumeHtml = read('resume.html');
SECTION_MARKERS.forEach(function (re) {
  assert(!re.test(resumeHtml), 'resume.html carries no ' + re.source.slice(0, 42) + '…', 'matched: ' + (resumeHtml.match(re) || [''])[0]);
});
/* The word may still appear in a comment explaining the rule, but never as
   a section heading or a landmark label. */
assert(!/<section[^>]*>[\s\S]{0,400}?>\s*Education\s*</i.test(resumeHtml), 'no <section> in resume.html introduces an Education heading');
assert(read('resume.css').indexOf('.edu-') === -1, 'resume.css defines no .edu-* rules');
header('resume.html — header subtitle carries role + degree + institution');
var tagline = (resumeHtml.match(/<p class="tagline">([\s\S]*?)<\/p>/i) || [])[1];
assert(!!tagline, 'the subtitle (.tagline) is present');
tagline = tagline || '';
assert(/<span class="subtitle-role"[^>]*>([^<]+)<\/span>/i.test(tagline), 'subtitle has a .subtitle-role span (current professional role)');
assert(/itemprop="jobTitle"/.test(tagline), '.subtitle-role carries itemprop="jobTitle"');
assert(/<span class="sep"[^>]*>·<\/span>/i.test(tagline), 'role and credential are joined by the mid-dot .sep (never a dash)');
var credential = (tagline.match(/<span class="credential">([\s\S]*?)<\/span>/i) || [])[1] || '';
assert(credential.trim().length > 0, 'subtitle has a .credential span');
assert(/^[^,<>]+,\s*[^,<>]+$/.test(credential.trim()), 'credential reads "<degree>, <institution>" — plain text, comma-separated', JSON.stringify(credential.trim()));
assert(!/<(img|svg|span|div)\b/i.test(credential), 'credential is plain ATS-readable text (no nested markup, no image)');
assert(!/[—–]/.test(tagline), 'subtitle contains no em or en dash (§5.3.1)');

/* A specialisation / marketing tagline is the shape this rule replaced. */
var MARKETING = /(full-stack delivery|data integration|backend|driving growth|passionate|results-driven|specialising|specializing)/i;
assert(!MARKETING.test(tagline.replace(/<[^>]+>/g, ' ')), 'subtitle is not a specialisation / marketing tagline', (tagline.match(MARKETING) || [''])[0]);

/* Degree text must be inside <main>, not in chrome. */
var main = (resumeHtml.match(/<main[\s\S]*?<\/main>/i) || [''])[0];
assert(main.indexOf(credential.trim()) !== -1, 'the degree + institution text sits inside <main>');
header('role-only subtitle stays valid (no documented degree)');

/* Nothing in the CSS may require the credential span: no rule may target
   .credential as a structural dependency (e.g. `.tagline .role + .sep`
   collapsing, or `:has()` layout switching), and .role must not be styled
   differently from .credential. */
var resumeCss = read('resume.css');
assert(!/:has\([^)]*credential/.test(resumeCss), 'no :has() rule branches layout on the credential being present');
assert(!/\.credential\s*\+|\+\s*\.credential|\.credential\s*~/.test(resumeCss), 'no sibling-combinator rule depends on the credential span');
var taglineRule = (resumeCss.match(/\.tagline\s+\.subtitle-role[^{]*\{([^}]*)\}/) || [])[1] || '';
['font-family', 'font-size', 'font-style', 'font-weight', 'letter-spacing', 'color'].forEach(function (p) {
  assert(new RegExp(p + '\\s*:\\s*inherit').test(taglineRule), '.subtitle-role / .credential inherit ' + p + ' from the subtitle (one continuous run)');
});

/* No subtitle span may reuse a BLOCK-component class name: `.role`,
   `.project`, `.section` etc. carry margins, break rules, and :last-child
   behaviour, and consumers restyle them per §5.2. A collision there is
   invisible today (inline boxes drop vertical margins) and breaks the header
   the moment the component gains padding or the span becomes inline-block. */
var BLOCK_COMPONENTS = ['role', 'role-header', 'role-meta', 'section', 'project', 'projects', 'highlights', 'skills', 'page', 'resume-header'];
(function () {
  var spans = tagline.match(/class="([^"]+)"/g) || [];
  var clash = [];
  spans.forEach(function (attr) {
    attr.replace(/class="|"/g, '').split(/\s+/).forEach(function (c) {
      if (BLOCK_COMPONENTS.indexOf(c) !== -1) clash.push(c);
    });
  });
  assert(clash.length === 0, 'no .tagline descendant reuses a block-component class name', clash.join(', '));
})();
['resume.html', 'cover-letter.html', 'preview/component-header.html'].forEach(function (rel) {
  assert(!/<span class="role"/.test(read(rel)), rel + ' uses .subtitle-role, not .role, in the subtitle');
});
/* And the documented contract says the role stands alone. */
assert(/no degree documented[\s\S]{0,120}role alone/i.test(read('STYLE.md').replace(/\*\*/g, '')), 'STYLE.md §5.8 states that a candidate with no degree gets a role-only subtitle');
header('previews — no Education card, no Education section markup');
assert(!exists('preview/component-education.html'), 'preview/component-education.html is removed');
listPreviews().forEach(function (rel) {
  var src = read(rel);
  var hit = SECTION_MARKERS.filter(function (re) {
    return re.test(src);
  });
  assert(hit.length === 0, rel + ' shows no Education section markup', hit.map(function (r) {
    return r.source;
  }).join(' | '));
});
/* The manifest is compiler-generated; it must simply no longer list the card. */
if (exists('_ds_manifest.json')) {
  assert(read('_ds_manifest.json').indexOf('component-education') === -1, '_ds_manifest.json no longer references an Education component card');
}
header('documentation — Education removed, §5.8 documented');
assert(/### 5\.8 Header subtitle/.test(read('STYLE.md')), 'STYLE.md documents §5.8 Header subtitle');
[['STYLE.md', '`.edu-school`'], ['STYLE.md', '"Education". **Never**'], ['SKILL.md', 'skills, education'], ['readme.md', 'skills, education'], ['readme.md', '**Skills**, **Education**']].forEach(function (pair) {
  assert(read(pair[0]).indexOf(pair[1]) === -1, pair[0] + ' no longer says "' + pair[1] + '"');
});
['STYLE.md', 'SKILL.md', 'readme.md'].forEach(function (doc) {
  assert(/no Education section/i.test(read(doc)), doc + ' states that no Education section exists');
});
assert(/highest completed degree/i.test(read('SKILL.md')), 'SKILL.md pipeline names the highest-completed-degree subtitle pattern');
console.log('\n' + (failed === 0 ? GREEN : RED) + passed + ' passed, ' + failed + ' failed' + RESET);
if (failed > 0) {
  console.log(RED + 'Failures: ' + failures.join(', ') + RESET);
  process.exit(1);
}
})(); } catch (e) { __ds_ns.__errors.push({ path: "build/education-placement-test.js", error: String((e && e.message) || e) }); }

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
