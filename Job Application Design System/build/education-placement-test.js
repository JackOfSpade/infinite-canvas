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
   build/education-placement-check.html.

   Run from the project root:  node build/education-placement-test.js
   Exit code 0 on success, 1 on first failure.
   ============================================================ */

'use strict';

var fs   = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');

var H = require('./harness.js');
var ok = H.ok, fail = H.fail, header = H.header, assert = H.assert;
var GREEN = H.GREEN, RED = H.RED, DIM = H.DIM, RESET = H.RESET;

function read(rel)   { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }
function listPreviews() {
  return fs.readdirSync(path.join(ROOT, 'preview'))
    .filter(function (f) { return /\.html$/.test(f); })
    .map(function (f) { return 'preview/' + f; });
}

/* Markers of the removed section, in markup and in CSS. */
var SECTION_MARKERS = [
  /id\s*=\s*"sec-education"/i,
  /aria-labelledby\s*=\s*"sec-education"/i,
  /<h2[^>]*>\s*Education\s*<\/h2>/i,
  /class\s*=\s*"[^"]*\bedu-(line|school|degree|meta)\b/i,
  /\.edu-(line|school|degree|meta)\b/
];

/* ---- the template ------------------------------------------------- */

header(DIM + 'education placement' + RESET + '\nresume.html — no dedicated Education section');

var resumeHtml = read('resume.html');

SECTION_MARKERS.forEach(function (re) {
  assert(!re.test(resumeHtml), 'resume.html carries no ' + re.source.slice(0, 42) + '…',
    'matched: ' + (resumeHtml.match(re) || [''])[0]);
});
/* The word may still appear in a comment explaining the rule, but never as
   a section heading or a landmark label. */
assert(!/<section[^>]*>[\s\S]{0,400}?>\s*Education\s*</i.test(resumeHtml),
  'no <section> in resume.html introduces an Education heading');
assert(read('resume.css').indexOf('.edu-') === -1,
  'resume.css defines no .edu-* rules');

header('resume.html — header subtitle carries role + degree + institution');

var tagline = (resumeHtml.match(/<p class="tagline">([\s\S]*?)<\/p>/i) || [])[1];
assert(!!tagline, 'the subtitle (.tagline) is present');
tagline = tagline || '';

assert(/<span class="subtitle-role"[^>]*>([^<]+)<\/span>/i.test(tagline),
  'subtitle has a .subtitle-role span (current professional role)');
assert(/itemprop="jobTitle"/.test(tagline), '.subtitle-role carries itemprop="jobTitle"');
assert(/<span class="sep"[^>]*>·<\/span>/i.test(tagline),
  'role and credential are joined by the mid-dot .sep (never a dash)');

var credential = (tagline.match(/<span class="credential">([\s\S]*?)<\/span>/i) || [])[1] || '';
assert(credential.trim().length > 0, 'subtitle has a .credential span');
assert(/^[^,<>]+,\s*[^,<>]+$/.test(credential.trim()),
  'credential reads "<degree>, <institution>" — plain text, comma-separated',
  JSON.stringify(credential.trim()));
assert(!/<(img|svg|span|div)\b/i.test(credential),
  'credential is plain ATS-readable text (no nested markup, no image)');
assert(!/[—–]/.test(tagline), 'subtitle contains no em or en dash (§5.3.1)');

/* A specialisation / marketing tagline is the shape this rule replaced. */
var MARKETING = /(full-stack delivery|data integration|backend|driving growth|passionate|results-driven|specialising|specializing)/i;
assert(!MARKETING.test(tagline.replace(/<[^>]+>/g, ' ')),
  'subtitle is not a specialisation / marketing tagline', (tagline.match(MARKETING) || [''])[0]);

/* Degree text must be inside <main>, not in chrome. */
var main = (resumeHtml.match(/<main[\s\S]*?<\/main>/i) || [''])[0];
assert(main.indexOf(credential.trim()) !== -1, 'the degree + institution text sits inside <main>');

header('role-only subtitle stays valid (no documented degree)');

/* Nothing in the CSS may require the credential span: no rule may target
   .credential as a structural dependency (e.g. `.tagline .role + .sep`
   collapsing, or `:has()` layout switching), and .role must not be styled
   differently from .credential. */
var resumeCss = read('resume.css');
assert(!/:has\([^)]*credential/.test(resumeCss),
  'no :has() rule branches layout on the credential being present');
assert(!/\.credential\s*\+|\+\s*\.credential|\.credential\s*~/.test(resumeCss),
  'no sibling-combinator rule depends on the credential span');
var taglineRule = (resumeCss.match(/\.tagline\s+\.subtitle-role[^{]*\{([^}]*)\}/) || [])[1] || '';
['font-family', 'font-size', 'font-style', 'font-weight', 'letter-spacing', 'color'].forEach(function (p) {
  assert(new RegExp(p + '\\s*:\\s*inherit').test(taglineRule),
    '.subtitle-role / .credential inherit ' + p + ' from the subtitle (one continuous run)');
});

/* No subtitle span may reuse a BLOCK-component class name: `.role`,
   `.project`, `.section` etc. carry margins, break rules, and :last-child
   behaviour, and consumers restyle them per §5.2. A collision there is
   invisible today (inline boxes drop vertical margins) and breaks the header
   the moment the component gains padding or the span becomes inline-block. */
var BLOCK_COMPONENTS = ['role', 'role-header', 'role-meta', 'section', 'project',
                        'projects', 'highlights', 'skills', 'page', 'resume-header'];
(function () {
  var spans = tagline.match(/class="([^"]+)"/g) || [];
  var clash = [];
  spans.forEach(function (attr) {
    attr.replace(/class="|"/g, '').split(/\s+/).forEach(function (c) {
      if (BLOCK_COMPONENTS.indexOf(c) !== -1) clash.push(c);
    });
  });
  assert(clash.length === 0,
    'no .tagline descendant reuses a block-component class name', clash.join(', '));
})();
['resume.html', 'cover-letter.html', 'preview/component-header.html'].forEach(function (rel) {
  assert(!/<span class="role"/.test(read(rel)),
    rel + ' uses .subtitle-role, not .role, in the subtitle');
});
/* And the documented contract says the role stands alone. */
assert(/no degree documented[\s\S]{0,120}role alone/i.test(read('STYLE.md').replace(/\*\*/g, '')),
  'STYLE.md §5.8 states that a candidate with no degree gets a role-only subtitle');

header('previews — no Education card, no Education section markup');

assert(!exists('preview/component-education.html'),
  'preview/component-education.html is removed');
listPreviews().forEach(function (rel) {
  var src = read(rel);
  var hit = SECTION_MARKERS.filter(function (re) { return re.test(src); });
  assert(hit.length === 0, rel + ' shows no Education section markup',
    hit.map(function (r) { return r.source; }).join(' | '));
});
/* The manifest is compiler-generated; it must simply no longer list the card. */
if (exists('_ds_manifest.json')) {
  assert(read('_ds_manifest.json').indexOf('component-education') === -1,
    '_ds_manifest.json no longer references an Education component card');
}

header('documentation — Education removed, §5.8 documented');

assert(/### 5\.8 Header subtitle/.test(read('STYLE.md')), 'STYLE.md documents §5.8 Header subtitle');
[['STYLE.md', '`.edu-school`'],
 ['STYLE.md', '"Education". **Never**'],
 ['SKILL.md', 'skills, education'],
 ['CONTENT_RULES.md', 'skills, education'],
 ['CONTENT_RULES.md', '**Skills**, **Education**']
].forEach(function (pair) {
  assert(read(pair[0]).indexOf(pair[1]) === -1, pair[0] + ' no longer says "' + pair[1] + '"');
});
['STYLE.md', 'SKILL.md', 'CONTENT_RULES.md'].forEach(function (doc) {
  assert(/no Education section/i.test(read(doc)),
    doc + ' states that no Education section exists');
});
assert(/highest completed degree/i.test(read('SKILL.md')),
  'SKILL.md pipeline names the highest-completed-degree subtitle pattern');

H.report();
