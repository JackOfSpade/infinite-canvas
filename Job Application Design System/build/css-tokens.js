/* ============================================================
   build/css-tokens.js — read design-token values out of the CSS.
   ----------------------------------------------------------
   Anything that needs a token's value (a test, a PDF call site) reads
   it from `colors_and_type.css` through here instead of keeping its
   own hand-copied literal. Copies are how the PDF background colour
   and the CSS ground colour drift apart while a green test claims they
   match.

   Scope argument: tokens are redeclared by the variant blocks
   (`:root[data-page="a4"]`, `:root[data-density="compact"]`, the
   `data-print` blocks inside @media print). `tokenValue(name)` returns
   the base `:root` declaration; `tokenValue(name, 'data-page="a4"')`
   returns the value declared in the block whose selector contains that
   string.
   ============================================================ */

'use strict';

var fs   = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var TOKENS_FILE = 'colors_and_type.css';

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function stripComments(css) { return css.replace(/\/\*[\s\S]*?\*\//g, ''); }

/* Every `selector { … }` pair, flattened. At-rule wrappers (@media)
   contribute their inner blocks, which is what we want: the variant
   overrides inside @media print read as ordinary `:root[…]` blocks. */
function rules(css) {
  var out = [], re = /([^{}]+)\{([^{}]*)\}/g, m;
  while ((m = re.exec(css)) !== null) {
    out.push({ selector: m[1].replace(/\s+/g, ' ').trim(), body: m[2] });
  }
  return out;
}

/* The last declaration of `--name` inside blocks matching `scope`
   (undefined = the base `:root` block). Returns null when the token is
   not declared there.

   Note the base match: the flattened selector for the first rule in a
   file carries whatever preceded it (`@charset "utf-8"; :root`), so the
   test is "ends with :root and carries no attribute selector" rather
   than string equality. */
function tokenValue(name, scope, file) {
  var css = stripComments(read(file || TOKENS_FILE));
  var found = null;
  rules(css).forEach(function (r) {
    var match = scope
      ? r.selector.indexOf(scope) !== -1
      : /:root$/.test(r.selector) && r.selector.indexOf('[') === -1;
    if (!match) return;
    var re = new RegExp('(?:^|;)\\s*' + name + '\\s*:\\s*([^;]+)', 'g'), m;
    while ((m = re.exec(r.body)) !== null) found = m[1].trim();
  });
  return found;
}

/* #RRGGBB → [r, g, b] in [0,1], the form the PDF content stream uses. */
function hexToRgb01(hex) {
  var h = String(hex).trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error('not a 6-digit hex colour: ' + hex);
  return [parseInt(h.slice(0, 2), 16) / 255,
          parseInt(h.slice(2, 4), 16) / 255,
          parseInt(h.slice(4, 6), 16) / 255];
}

/* The exact operand string dual-mode-pdf.js writes for a fill colour,
   so a test can match the real content stream. */
function pdfRgbOperands(hex) {
  return hexToRgb01(hex).map(function (v) { return v.toFixed(4); });
}

/* Absolute CSS lengths → pt, so 0.6in and 15.24mm can be compared. */
function toPt(value) {
  var m = /^\s*(-?[\d.]+)\s*(pt|in|mm|cm|px)\s*$/.exec(String(value));
  if (!m) throw new Error('not an absolute length: ' + value);
  var n = parseFloat(m[1]);
  switch (m[2]) {
    case 'pt': return n;
    case 'in': return n * 72;
    case 'mm': return n * 72 / 25.4;
    case 'cm': return n * 720 / 25.4;
    case 'px': return n * 0.75;
  }
}

module.exports = {
  ROOT: ROOT,
  TOKENS_FILE: TOKENS_FILE,
  read: read,
  stripComments: stripComments,
  rules: rules,
  tokenValue: tokenValue,
  hexToRgb01: hexToRgb01,
  pdfRgbOperands: pdfRgbOperands,
  toPt: toPt
};
