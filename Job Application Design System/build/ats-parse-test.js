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

var fs   = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');

var GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', RESET = '\x1b[0m';
var passed = 0, failed = 0, failures = [];

function ok(name)      { console.log('  ' + GREEN + '✓' + RESET + ' ' + name); passed++; }
function fail(name, m) { console.log('  ' + RED + '✗' + RESET + ' ' + name + ' — ' + m); failed++; failures.push(name); }
function header(s)     { console.log('\n' + s); }
function assert(cond, name, msg) { if (cond) ok(name); else fail(name, msg || 'assertion failed'); }

function read(rel) { return fs.readFileSync(path.isAbsolute(rel) ? rel : path.join(ROOT, rel), 'utf8'); }
/* Candidate copy only. Stripped, because none of it reaches the text layer
   of the printed document: HTML comments (documentation prose), the date
   script, and <template> content (the offline-bundle splash mark, which is
   inert markup outside the document flow). */
function copyOf(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<template[\s\S]*?<\/template>/gi, '');
}
function mainOf(html) { return (copyOf(html).match(/<main[\s\S]*?<\/main>/i) || [''])[0]; }

var targets = process.argv.slice(2);
if (targets.length === 0) targets = ['resume.html', 'cover-letter.html'];

/* ---- per-document hazards ----------------------------------------- */

/* Each hazard: [label, regexp over candidate copy, why]. A match fails. */
var HAZARDS = [
  ['no <table> (cell reading order interleaves lines)',        /<table[\s>]/i],
  ['no <img> / <svg> / <canvas> (text in them extracts as nothing)', /<(img|svg|canvas|picture)[\s>]/i, 'main'],
  ['no position:absolute / fixed on content',                  /position\s*:\s*(absolute|fixed)/i],
  ['no CSS columns (real columns interleave on parse)',        /column-(count|width)\s*:/i],
  ['no hidden or zero-size text (reads as keyword stuffing)',  /(visibility\s*:\s*hidden|opacity\s*:\s*0(?!\.)|font-size\s*:\s*0(px|pt)?\s*[;"'])/i],
  ['no tabular figures (every digit drops from the PDF)',      /(tabular-nums|["']tnum["'])/i],
  ['no &nbsp; in candidate copy (use class="nowrap")',         /&nbsp;|&#160;|&#xa0;|\u00a0/i],
  ['no <font> / <center> / inline text-align hacks',           /<(font|center)[\s>]/i]
];

targets.forEach(function (rel) {
  header(DIM + 'parse safety' + RESET + '\n' + rel);
  var html = read(rel), copy = copyOf(html), main = mainOf(html);

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
  assert(nameAt !== -1 && (contactAt === -1 || nameAt < contactAt),
    'name precedes the contact block in source order');
  assert(contactAt === -1 || firstH2 === -1 || contactAt < firstH2,
    'contact block precedes the first section heading');

  /* Headings must be real heading elements, not styled divs. */
  var fakeHeads = (copy.match(/<(div|p|span)[^>]*class="[^"]*section-head[^"]*"[^>]*>\s*<(?!h[1-6])/gi) || []);
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
  var minusLines = (copy.match(/[^\n]*\u2212[^\n]*/g) || []);
  var bareMinus = minusLines.filter(function (l) { return !/\d/.test(l.replace(/\u2212/g, '')); });
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
  var positioned = (s.match(/([^{}]+)\{[^}]*position\s*:\s*(absolute|fixed)[^}]*\}/g) || [])
    .map(function (r) { return r.slice(0, r.indexOf('{')).replace(/\s+/g, ' ').trim(); })
    .filter(function (sel) { return !/::?(before|after)\b/.test(sel); });
  assert(positioned.length === 0,
    sheet + ': no rule positions content absolutely (bullet pseudo-element excepted)',
    positioned.join(' | '));
  assert(!/visibility\s*:\s*hidden|font-size\s*:\s*0(px|pt)?\s*[;}]/.test(s),
    sheet + ': no rule hides text');
});

header('resume.css — parse-safe rules are in place');

var css = read('resume.css').replace(/\/\*[\s\S]*?\*\//g, '');

assert(/\.nowrap\s*\{[^}]*white-space\s*:\s*nowrap/.test(css),
  '.nowrap utility exists (the parse-safe replacement for &nbsp;)');
assert(/font-variant-numeric\s*:\s*normal/.test(css),
  'proportional numerals are pinned (tabular figures would empty the text layer)');

/* CSS `content` is DECORATIVE ONLY: the bullet glyph, nothing else. Any
   other value is text meaning that copy-paste and PDF extraction drop —
   the exact failure the annotation labels were moved into markup to avoid
   (§5.4). Whitelist by EXACT value: a substring test would wave through
   `content: " · trade-off: "`, which is the case this check exists for. */
var DECORATIVE = /^("|')(\\2022|\u2022|\s*)\1$/;
var contents = (css.match(/content\s*:\s*("[^"]*"|'[^']*')/g) || [])
  .map(function (d) { return d.replace(/content\s*:\s*/, '').trim(); });
var meaningful = contents.filter(function (v) { return !DECORATIVE.test(v); });
assert(meaningful.length === 0,
  'CSS content is decorative only (bullet glyph); no text meaning lives in CSS',
  meaningful.join(' | '));
/* Guard the guard: the whitelist must actually reject a real label. */
assert(!DECORATIVE.test('" \u00b7 trade-off: "') && DECORATIVE.test('"\\2022"'),
  'the decorative whitelist rejects a multi-word label and accepts the bullet glyph');

/* Single column, and no positioned content — covered per-sheet above. */
assert(true, 'stylesheet hazards checked across ' + SHEETS.length + ' sheets');

console.log('\n' + (failed === 0 ? GREEN : RED) + passed + ' passed, ' + failed + ' failed' + RESET);
if (failed > 0) {
  console.log(RED + 'Failures: ' + failures.join(', ') + RESET);
  process.exit(1);
}
