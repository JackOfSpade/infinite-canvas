/* ============================================================
   build/token-sync-test.js — token/literal sync gate
   ----------------------------------------------------------
   The system has a handful of places where a token value MUST be
   restated as a literal, because the context cannot read a custom
   property:

     - `build/dual-mode-pdf.js`'s DEFAULT_CREAM_RGB (it paints --bg
       into the PDF as an OCG background layer)
     - the `@page` margin boxes in `resume.css` (custom properties do
       not cascade into @page across engines) — footer ink, family,
       tracking, and the four paper/density margin pairs
     - STYLE.md §3.1's colour table, which readers trust as the spec

   Every one of those is a copy, and a copy with no guard drifts
   silently: retune --bg and the printed PDF background no longer
   matches the HTML while the suite stays green. This file is the
   guard. It reads the tokens from the CSS (never a literal of its own)
   and fails if any copy disagrees.

   Run from the project root:  node build/token-sync-test.js
   Exit code 0 on success, 1 on any drift.
   ============================================================ */

'use strict';

var H = require('./harness.js');
var T = require('./css-tokens.js');
var crypto = require('crypto');
var ok = H.ok, header = H.header, assert = H.assert;
var DIM = H.DIM, RESET = H.RESET;

var TOL_PT = 0.01;

function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }

/* The balanced body of `@page <name> { … }`, margin boxes included. */
function atPage(css, name) {
  var re = new RegExp('@page\\s+' + name + '\\s*\\{');
  var m = re.exec(css);
  if (!m) return null;
  var start = m.index + m[0].length - 1, depth = 0;
  for (var i = start; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') { depth--; if (depth === 0) return css.slice(start + 1, i); }
  }
  return null;
}

var resumeCss = T.stripComments(T.read('resume.css'));

/* ---- 1. --bg ↔ the PDF module's cream ------------------------------ */

header(DIM + 'token sync' + RESET + '\n--bg ↔ build/dual-mode-pdf.js DEFAULT_CREAM_RGB');

var bg = T.tokenValue('--bg');
assert(/^#[0-9a-f]{6}$/i.test(bg || ''), '--bg parses out of colors_and_type.css as a hex colour', 'got ' + bg);

/* Read the module's default as SOURCE TEXT rather than requiring it:
   this gate must run in a checkout with no npm install (pdf-lib is a
   dependency of the module's call path, not of this check). */
var modSrc = T.read('build/dual-mode-pdf.js');
var creamDecl = /DEFAULT_CREAM_RGB\s*=\s*\[\s*0x([0-9a-f]{2})\s*\/\s*255\s*,\s*0x([0-9a-f]{2})\s*\/\s*255\s*,\s*0x([0-9a-f]{2})\s*\/\s*255\s*\]/i.exec(modSrc);
assert(!!creamDecl, 'DEFAULT_CREAM_RGB is declared as three 0xNN/255 bytes (parseable)',
  'declaration shape changed — update this gate alongside it');
if (creamDecl) {
  var modHex = ('#' + creamDecl[1] + creamDecl[2] + creamDecl[3]).toUpperCase();
  assert(modHex === bg.toUpperCase(),
    'DEFAULT_CREAM_RGB is the same colour as --bg (' + bg + ')',
    'module says ' + modHex + ', CSS says ' + bg);
}

/* ---- 2. @page margin boxes ↔ the ink / mono / tracking tokens ------ */

header('resume.css @page footers ↔ tokens');

var ink3 = T.tokenValue('--ink-3');
var ffMono = T.tokenValue('--ff-mono').replace(/\s*\/\*.*$/, '');
var trMono = T.tokenValue('--tr-mono');

var PAGES = ['letter', 'a4', 'letter-compact', 'a4-compact'];
var footerColors = [], footerFamilies = [], footerTracking = [];

PAGES.forEach(function (name) {
  var body = atPage(resumeCss, name);
  assert(!!body, '@page ' + name + ' block exists', 'not found in resume.css');
  if (!body) return;
  var c = /color\s*:\s*(#[0-9a-f]{6})/i.exec(body);
  var f = /font-family\s*:\s*([^;]+);/i.exec(body);
  var l = /letter-spacing\s*:\s*([^;]+);/i.exec(body);
  if (c) footerColors.push([name, c[1]]);
  if (f) footerFamilies.push([name, f[1]]);
  if (l) footerTracking.push([name, l[1]]);
});

/* Guard the guard: if a refactor deletes the footers, the loops below
   would pass by having nothing to check. */
assert(footerColors.length === PAGES.length,
  'all ' + PAGES.length + ' running footers declare an ink colour',
  'found ' + footerColors.length);
assert(footerFamilies.length === PAGES.length,
  'all ' + PAGES.length + ' running footers declare a font family',
  'found ' + footerFamilies.length);
assert(footerTracking.length === PAGES.length,
  'all ' + PAGES.length + ' running footers declare letter spacing',
  'found ' + footerTracking.length);

footerColors.forEach(function (pair) {
  assert(pair[1].toUpperCase() === ink3.toUpperCase(),
    '@page ' + pair[0] + ' footer ink is --ink-3 (' + ink3 + ')', 'literal is ' + pair[1]);
});
footerFamilies.forEach(function (pair) {
  assert(norm(pair[1]) === norm(ffMono),
    '@page ' + pair[0] + ' footer family matches --ff-mono', 'literal is ' + norm(pair[1]));
});
footerTracking.forEach(function (pair) {
  assert(norm(pair[1]) === norm(trMono),
    '@page ' + pair[0] + ' footer tracking matches --tr-mono (' + trMono + ')', 'literal is ' + norm(pair[1]));
});

/* ---- 3. @page vertical margins ↔ the margin tokens ----------------- */

header('resume.css @page margins ↔ --margin-top / --margin-bot');

/* Effective token value per variant. Compact is declared after the a4
   block at equal specificity, so a4 + compact resolves to compact's
   0.6in — which is why @page a4-compact says 15.24mm. */
var marginsFor = {
  'letter': {
    top: T.tokenValue('--margin-top'),
    bottom: T.tokenValue('--margin-bot')
  },
  'a4': {
    top: T.tokenValue('--margin-top', 'data-page="a4"'),
    bottom: T.tokenValue('--margin-bot', 'data-page="a4"')
  },
  'letter-compact': {
    top: T.tokenValue('--margin-top', 'data-density="compact"'),
    bottom: T.tokenValue('--margin-bot', 'data-density="compact"')
  },
  'a4-compact': {
    top: T.tokenValue('--margin-top', 'data-density="compact"'),
    bottom: T.tokenValue('--margin-bot', 'data-density="compact"')
  }
};

function verticalShorthandValues(value) {
  var parts = norm(value).split(' ');
  if (parts.length === 1) return { top: parts[0], bottom: parts[0] };
  if (parts.length === 2) return { top: parts[0], bottom: parts[0] };
  if (parts.length === 3) return { top: parts[0], bottom: parts[2] };
  return { top: parts[0], bottom: parts[2] };
}

PAGES.forEach(function (name) {
  var body = atPage(resumeCss, name);
  if (!body) return;
  var m = /margin\s*:\s*([^;]+);/.exec(body);   // top-level margin precedes the margin box
  if (!m) { assert(false, '@page ' + name + ' declares a vertical margin', 'no margin shorthand found'); return; }
  var actual = verticalShorthandValues(m[1]);
  var expected = marginsFor[name];
  ['top', 'bottom'].forEach(function (edge) {
    assert(Math.abs(T.toPt(actual[edge]) - T.toPt(expected[edge])) < TOL_PT,
      '@page ' + name + ' ' + edge + ' margin (' + actual[edge] + ') == --margin-' +
        (edge === 'bottom' ? 'bot' : 'top') + ' for that variant (' + expected[edge] + ')',
      T.toPt(actual[edge]).toFixed(3) + 'pt vs ' + T.toPt(expected[edge]).toFixed(3) + 'pt');
  });
});

/* ---- 4. STYLE.md §3.1's colour table ------------------------------- */

header('STYLE.md §3.1 colour table ↔ tokens');

var style = T.read('STYLE.md');
['--bg', '--ink-1', '--ink-2', '--ink-3', '--ink-4', '--accent'].forEach(function (name) {
  var value = T.tokenValue(name);
  var row = style.split('\n').filter(function (l) {
    return l.indexOf('`' + name + '`') !== -1 && /#[0-9a-f]{6}/i.test(l);
  })[0];
  assert(!!row, 'STYLE.md documents a hex for ' + name, 'no table row with a hex found');
  if (row) {
    var documented = /#[0-9a-f]{6}/i.exec(row)[0];
    assert(documented.toUpperCase() === value.toUpperCase(),
      'STYLE.md §3.1 lists ' + name + ' as ' + value, 'doc says ' + documented + ', CSS says ' + value);
  }
});

/* ---- 5. The reference cards must read the tokens, not copy them ---- */

header('preview cards + thumbnail read the live tokens');

/* A card that prints a token's value as a hardcoded hex documents
   whatever the value USED to be. The cards fill their labels from
   getComputedStyle instead, so this is a no-hardcoded-hex rule.
   Exception: anti-patterns.html demonstrates banned treatments (a
   gradient header), which are not token values by definition. */
var TOKEN_HEXES = ['--bg', '--ink-1', '--ink-2', '--ink-3', '--ink-4', '--accent']
  .map(function (n) { return T.tokenValue(n).toUpperCase(); });
var HEX_EXEMPT = ['preview/anti-patterns.html'];

var fs = require('fs');
var pathMod = require('path');
var cards = fs.readdirSync(pathMod.join(T.ROOT, 'preview'))
  .filter(function (f) { return /\.html$/.test(f); })
  .map(function (f) { return 'preview/' + f; })
  .concat(['thumbnail.html', 'resume.html', 'cover-letter.html']);

cards.forEach(function (rel) {
  if (HEX_EXEMPT.indexOf(rel) !== -1) { ok(rel + ' (exempt — demonstrates a banned treatment)'); return; }
  var src = T.read(rel).toUpperCase();
  var copied = TOKEN_HEXES.filter(function (hex) { return src.indexOf(hex) !== -1; });
  assert(copied.length === 0, rel + ' hardcodes no token hex', 'copied: ' + copied.join(', '));
});

/* And the one card that renders the name must read the size token, not
   restate it (it drifted to 26pt against a 28pt --fs-display). */
assert(/var\(--fs-display\)/.test(T.read('preview/component-header.html')),
  'preview/component-header.html sizes the name from --fs-display');

/* ---- 6. The generated design-system bundle must match its sources -- */

header('_ds_bundle.js source hashes');

var bundle = T.read('_ds_bundle.js');
var bundleHeader = /\/\* @ds-bundle: (\{.*\}) \*\//.exec(bundle);
assert(!!bundleHeader, '_ds_bundle.js carries a parseable @ds-bundle header');
if (bundleHeader) {
  var sourceHashes = JSON.parse(bundleHeader[1]).sourceHashes || {};
  var mismatches = [];
  Object.keys(sourceHashes).forEach(function (rel) {
    var absolute = pathMod.join(T.ROOT, rel);
    if (!fs.existsSync(absolute)) {
      mismatches.push(rel + ' is missing');
      return;
    }
    var actual = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex').slice(0, 12);
    if (actual !== sourceHashes[rel]) {
      mismatches.push(rel + ': header=' + sourceHashes[rel] + ', source=' + actual);
    }
  });
  assert(Object.keys(sourceHashes).length > 0,
    '_ds_bundle.js declares at least one bundled source hash');
  assert(mismatches.length === 0,
    '_ds_bundle.js was regenerated after every bundled source edit',
    mismatches.join(' | '));
}

H.report();
