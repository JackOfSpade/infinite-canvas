/* ============================================================
   build/fit-estimate-test.js — static one-page fit gate
   ----------------------------------------------------------
   THE PROBLEM THIS SOLVES. This system's fit rules were published in
   CHARACTERS and TERMS, while its measurement rules lived in browser
   fixtures no automated consumer can run (`build/*-check.html`, see
   MANUAL-CHECKS.md). A host that renders and measures hands the agent
   back PIXELS. Nothing bridged the two, so a revision round after an
   overflow was guess-and-render.

   The bridge is the LINE-YIELD model (STYLE.md §6): page capacity and
   every block's cost are expressed in BASELINES — multiples of
   `--fs-body × --lh-body` — so the whole model is one arithmetic step
   away from both a character count and a pixel measurement:

       linesOverflowing = ceil((contentHeightPx - typeAreaHeightPx)
                               / baselinePx)

   This gate is that model applied statically, with no browser: it reads
   a filled document's markup, estimates the rendered line total, and
   compares it against the capacity it computes FROM THE TOKENS. It is
   the fit check the automated consumer can actually run, alongside
   `ats-parse-test.js` and `annotation-budget-test.js`.

   WHAT IT CAN AND CANNOT KNOW. Character counts cannot pin a line count
   in a proportional font — the same 178 characters wrap to 2 lines in
   ordinary bullet prose and 3 in long compound technical terms. So the
   estimate is a BAND, computed from the measured word-mix spread, and
   the gate fails only when the OPTIMISTIC bound already exceeds
   capacity: that document cannot fit one page under any word mix, which
   is a fact a static check can honestly assert. When the band straddles
   capacity it says so and passes, because only a render can settle it.

   It also enforces the per-row single-line budgets (STYLE.md §5.2a,
   §5.4, §5.6, §5.8). Those were the genuinely unbudgeted regions: the
   role title line and role summary are the highest-frequency rows on
   the page (3-5 roles x 2) and had no published length at all, so a
   long "Title · Company" silently cost a line per role.

   DERIVATION. Every constant below was measured in
   `build/line-yield-check.html` against the real stylesheets at the real
   page width, in Chrome with the CDN families, across all four render
   configs. Re-run that fixture after any type-scale, margin, spacing, or
   density change and update the tables here. The CAPACITY numbers are
   not measured at all — they are exact token arithmetic, which is why
   `token-sync-test.js` can guard them.

   Run from the project root:
     node build/fit-estimate-test.js                   # the shipped sample
     node build/fit-estimate-test.js out/filled.html   # any filled document
     node build/fit-estimate-test.js <(printf '%s' "$HTML")   # from a pipe

   Exit code 0 on success, 1 on any violation.
   ============================================================ */

'use strict';

var fs   = require('fs');
var path = require('path');

var H = require('./harness.js');
var T = require('./css-tokens.js');
var ok = H.ok, fail = H.fail, header = H.header, assert = H.assert;
var DIM = H.DIM, RESET = H.RESET;

var ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.isAbsolute(rel) ? rel : path.join(ROOT, rel), 'utf8'); }

var targets = process.argv.slice(2);
if (targets.length === 0) targets = ['resume.html'];

/* ---- capacity: exact token arithmetic, never a literal -------------- */

/* The four supported configs. `--margin-top` for a4-compact resolves to
   compact's 0.6in: the compact block is declared after the a4 block at
   equal specificity, so it wins on load order. That is also why
   `@page a4-compact` says 15.24mm. Same resolution as token-sync-test.js. */
var CONFIGS = [
  { name: 'Letter / default', page: null,             density: null },
  { name: 'Letter / compact', page: null,             density: 'compact' },
  { name: 'A4 / default',     page: 'data-page="a4"', density: null },
  { name: 'A4 / compact',     page: 'data-page="a4"', density: 'compact' }
];

function tok(name, cfg) {
  var v = null;
  if (cfg.density) v = T.tokenValue(name, 'data-density="compact"');
  if (v === null && cfg.page) v = T.tokenValue(name, cfg.page);
  if (v === null) v = T.tokenValue(name);
  return v;
}
function capacityOf(cfg) {
  var pageH = T.toPt(cfg.page ? T.tokenValue('--page-h', cfg.page) : T.tokenValue('--page-h'));
  var mTop  = T.toPt(tok('--margin-top', cfg));
  var mBot  = T.toPt(tok('--margin-bot', cfg));
  var fs_   = T.toPt(tok('--fs-body', cfg));
  var lh    = parseFloat(tok('--lh-body', cfg));
  return { typeAreaPt: pageH - mTop - mBot, baselinePt: fs_ * lh,
           lines: (pageH - mTop - mBot) / (fs_ * lh) };
}

/* ---- the measured cost table, in baselines ------------------------- */

/* Letter and A4 are identical here (only the capacity differs); compact
   costs slightly MORE per block, because --fs-display and --fs-h3 do not
   shrink with the baseline. Compact's gain is capacity, not density of
   the fixed furniture. */
var COST = {
  'default': {
    headerBlock: 7.24,        // name + 1-line tagline + 1-line contact + gap to first section
    taglineExtraLine: 1.07,
    contactExtraLine: 0.96,
    sectionHead: 1.68,        // heading + rule + its gap to the section body
    sectionGap: 2.00,         // section <-> section: --vr-2, exactly 2 baselines by construction
    roleHeader: 2.02,         // 1-line "Title · Company" row
    titleExtraLine: 1.07,
    roleMeta: 2.00,           // 1-line summary + location row; a location-only
                              // row costs the same, which is why §5.2b folds it
    summaryExtraLine: 0.93,
    bulletLine: 1.00,         // exactly one baseline: li line-height IS --lh-body
    bulletGap: 0.40,
    roleGap: 1.62,
    skillsRow: 0.93,
    skillsRowGap: 0.40,
    subsectionHead: 2.18,
    projectLine: 1.00,
    projectMetrics: 1.01,
    projectGap: 0.81
  },
  compact: {
    headerBlock: 7.37, taglineExtraLine: 1.21, contactExtraLine: 1.03,
    sectionHead: 1.60, sectionGap: 2.00,
    roleHeader: 2.19, titleExtraLine: 1.21,
    roleMeta: 2.14, summaryExtraLine: 0.99,
    bulletLine: 1.00, bulletGap: 0.46, roleGap: 1.37,
    skillsRow: 0.94, skillsRowGap: 0.46,
    subsectionHead: 2.29, projectLine: 1.00, projectMetrics: 1.01, projectGap: 0.61
  }
};

/* ---- the measured character bands, Letter/default ------------------ */

/* min = the tightest word order measured, max = the most forgiving. The
   PUBLISHED authoring budget sits below `min` with margin; the estimator
   uses the band itself, because its job is to bound a real document
   rather than to advise an author. */
var BAND = {
  bulletOneLine:  { min:  87, max:  95 },
  bulletTwoLine:  { min: 176, max: 200 },
  roleTitle:      { min:  60, max:  70 },
  /* §5.2b's fold moves the location into the `auto` dates cell, narrowing the
     `1fr` title track by ~104px for a `City, ST` string (518.33 -> 414.24px at
     Letter/default). Measured 2026-09-04 by the same method as the row above —
     8 shuffles of TITLEWORDS grown a word at a time in a real render of
     resume.html with a folded `May 2023 - Jun 2026 - Brooklyn, NY` cell:
     47/55/56 at Letter/default, A4/default and Letter/compact, 50/55/60 at
     A4/compact. A LONGER location narrows the track further and this floor
     with it; re-measure before folding an unusually long city or region. */
  roleTitleFolded: { min:  47, max:  56 },
  roleSummary:    { min:  75, max:  84 },
  tagline:        { min:  84, max:  93 },
  skillsRow:      { min:  70, max:  80 }
};

/* The published authoring budgets — margin below the measured floors. */
var BUDGET = {
  roleTitle:   56,   // STYLE.md §5.2a
  roleTitleFolded: 44,   // STYLE.md §5.2a, same margin below its floor as roleTitle
  roleSummary: 70,   // STYLE.md §5.2a
  tagline:     78,   // STYLE.md §5.8
  skillsRow:   64,   // STYLE.md §5.6
  skillsRows:   3    // STYLE.md §5.6 — rows, the unit that matters
};

/* A `.role-dates` cell that carries more than its date range is a §5.2b fold:
   the location was moved up into it and the `.role-meta` row dropped. Detected
   on the separator the fold is specified to use, not on "contains letters" —
   the range itself is "May 2023 - Jun 2026". */
function foldedDatesCell(roleHtml) {
  var cell = /<p[^>]*class="[^"]*\brole-dates\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(roleHtml);
  return Boolean(cell) && /\u00b7/.test(stripTags(cell[1]));
}

/* ---- markup reading (regex, like every other gate here) ------------ */

function stripTags(s) {
  return s.replace(/<[^>]+>/g, '')
    .replace(/&ldquo;|&rdquo;/g, '"').replace(/&lsquo;|&rsquo;/g, "'")
    .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function withoutComments(html) { return html.replace(/<!--[\s\S]*?-->/g, ''); }
/* A filled document INLINES colors_and_type.css into a <style>, and that CSS
   discusses `<main class="page">…</main>` in prose inside a /* *\/ comment. A
   non-greedy <main> scan locks onto that ~291-char decoy, the `if (!main)`
   guard cannot fire because a "main" WAS found, and the no-highlights
   early-return then reports a green check on a document never examined.
   Same decoy class as electron/ipc/jobApplication.js:956. Strip <style> (and
   <script>) before scanning. */
function withoutInertBlocks(html) {
  return withoutComments(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '');
}
function mainOf(html) { return (withoutInertBlocks(html).match(/<main[\s\S]*?<\/main>/i) || [''])[0]; }

/* Text of the first element carrying `cls`, or null. */
function textOf(scope, cls) {
  var re = new RegExp('<(\\w+)[^>]*class="[^"]*\\b' + cls + '\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/\\1>');
  var m = re.exec(scope);
  return m ? stripTags(m[2]) : null;
}
function allTextOf(scope, cls) {
  var re = new RegExp('<(\\w+)[^>]*class="[^"]*\\b' + cls + '\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/\\1>', 'g');
  var out = [], m;
  while ((m = re.exec(scope)) !== null) out.push(stripTags(m[2]));
  return out;
}
function count(scope, re) { return (scope.match(re) || []).length; }

/* Slice the document into role blocks. `<article class="role" …>` is the
   documented shape (STYLE.md §5.2); each slice runs to the next one. */
function rolesIn(main) {
  var starts = [], re = /<article[^>]*class="[^"]*\brole\b[^"]*"[^>]*>/g, m;
  while ((m = re.exec(main)) !== null) starts.push(m.index);
  return starts.map(function (s, i) {
    return main.slice(s, i + 1 < starts.length ? starts[i + 1] : main.length);
  });
}
function bulletsIn(scope) {
  /* The sanitizer preserves id and data-achievement-id on any element, so a
     bare `<li>` match drops every annotated bullet. annotation-budget-test.js
     already tolerates attributes and asserts exactly this. */
  var out = [], re = /<li\b[^>]*>([\s\S]*?)<\/li>/g, m;
  while ((m = re.exec(scope)) !== null) out.push(stripTags(m[1]));
  return out;
}

/* Lines a row of `chars` occupies, given a one-line threshold. Optimistic
   passes the band's max, pessimistic its min. */
function rowLines(chars, threshold) {
  if (chars <= threshold) return 1;
  return 1 + Math.ceil((chars - threshold) / threshold);
}
/* A bullet has two measured thresholds, and the ladder between them is
   not linear (the two-line floor exceeds twice the one-line floor,
   because a wrapped pair shares its slack differently). Extrapolate past
   two lines from the increment between them. */
function bulletLines(chars, oneLine, twoLine) {
  if (chars <= oneLine) return 1;
  if (chars <= twoLine) return 2;
  return 2 + Math.ceil((chars - twoLine) / (twoLine - oneLine));
}

/* Estimate the ink span of one document, in baselines. `pick` selects the
   optimistic ('max') or pessimistic ('min') edge of every band. */
function estimate(main, cost, pick) {
  var t = 0;
  var edge = function (b) { return BAND[b][pick]; };

  /* Header block. */
  if (/class="[^"]*\bresume-header\b/.test(main) || /class="[^"]*\btagline\b/.test(main)) {
    t += cost.headerBlock;
    var tag = textOf(main, 'tagline');
    if (tag) t += (rowLines(tag.length, edge('tagline')) - 1) * cost.taglineExtraLine;
  }

  /* One section head per section, plus the gap between sections. */
  var sections = count(main, /<section[^>]*class="[^"]*\bsection\b[^"]*"/g);
  t += sections * cost.sectionHead + Math.max(0, sections - 1) * cost.sectionGap;
  t += count(main, /class="[^"]*\bsubsection-head\b/g) * cost.subsectionHead;

  /* Roles. */
  var roles = rolesIn(main);
  roles.forEach(function (role, ri) {
    t += cost.roleHeader;
    var title = textOf(role, 'role-title-line');
    /* A folded location shares the dates cell, so the title has materially less
       room than the unfolded budget assumes. Charging the wide edge here
       reported green on a document whose titles wrap. */
    var titleEdge = edge(foldedDatesCell(role) ? 'roleTitleFolded' : 'roleTitle');
    if (title) t += (rowLines(title.length, titleEdge) - 1) * cost.titleExtraLine;

    if (/class="[^"]*\brole-meta\b/.test(role)) {
      t += cost.roleMeta;
      var sum = textOf(role, 'role-summary');
      if (sum) t += (rowLines(sum.length, edge('roleSummary')) - 1) * cost.summaryExtraLine;
    }

    var bl = bulletsIn(role);
    bl.forEach(function (b, bi) {
      t += bulletLines(b.length, edge('bulletOneLine'), edge('bulletTwoLine')) * cost.bulletLine;
      if (bi < bl.length - 1) t += cost.bulletGap;
    });
    if (ri < roles.length - 1) t += cost.roleGap;
  });

  /* Projects / Selected Systems. */
  /* `\bproject\b` also matches project-name / project-desc / project-metrics,
     and the documented markup gives every entry all four — so N entries were
     costing 4N. Match the block class as a whole token instead. */
  var projects = count(main, /class="(?:[^"]*\s)?project(?:\s[^"]*)?"/g);
  if (projects) {
    t += projects * cost.projectLine +
         count(main, /class="[^"]*\bproject-metrics\b/g) * cost.projectMetrics +
         Math.max(0, projects - 1) * cost.projectGap;
  }

  /* Skills. */
  var skillRows = count(main, /<dt[\s>]/g);
  if (skillRows) t += skillRows * cost.skillsRow + Math.max(0, skillRows - 1) * cost.skillsRowGap;

  return { lines: Math.round(t * 100) / 100, roles: roles.length,
           bullets: roles.reduce(function (n, r) { return n + bulletsIn(r).length; }, 0),
           sections: sections, skillRows: skillRows };
}

/* ---- Section 1: capacity, published --------------------------------- */

header(DIM + 'page capacity — exact token arithmetic' + RESET);

var caps = {};
CONFIGS.forEach(function (cfg) {
  var c = capacityOf(cfg);
  caps[cfg.name] = c;
  ok(cfg.name + ': type area ' + c.typeAreaPt.toFixed(2) + 'pt / baseline ' +
     c.baselinePt.toFixed(4) + 'pt = ' + c.lines.toFixed(2) + ' lines');
});
/* Letter/default is the tightest capacity of the four, so it is the
   config the gate judges against — the same choice §5.4 makes for the
   bullet budget. */
var CAP = caps['Letter / default'].lines;
assert(CAP > 40 && CAP < 60, 'Letter/default capacity is in the plausible range (' + CAP.toFixed(2) + ' lines)',
  'token arithmetic produced ' + CAP + ' — a token or this gate is wrong');

/* ---- Section 2: the target documents -------------------------------- */

targets.forEach(function (rel) {
  var html = read(rel), main = mainOf(html);
  header(DIM + 'fit estimate' + RESET + '\n' + rel);

  if (!main) { fail(rel + ' has a <main> element', 'none found'); return; }

  /* A letter has no role/bullet structure to model. Say so and move on
     rather than reporting a meaningless number: the letter's one-page
     rule is guarded by build/cover-letter-one-page-check.html. */
  if (!/class="[^"]*\bhighlights\b/.test(main)) {
    ok(rel + ' — no résumé role structure; nothing to estimate ' +
       '(letter fit: build/cover-letter-one-page-check.html)');
    return;
  }

  /* --- per-row single-line budgets (the previously unbudgeted rows) --- */
  var tagline = textOf(main, 'tagline');
  if (tagline !== null) {
    assert(tagline.length <= BUDGET.tagline,
      'tagline is ' + tagline.length + ' chars (budget ' + BUDGET.tagline + ', one line)',
      'wraps to a second line and costs one line of page: "' + tagline.slice(0, 60) + '…"');
  }
  allTextOf(main, 'role-title-line').forEach(function (t, i) {
    assert(t.length <= BUDGET.roleTitle,
      'role-title-line #' + (i + 1) + ' is ' + t.length + ' chars (budget ' + BUDGET.roleTitle + ', one line)',
      'wraps and costs one line per role: "' + t + '" — shorten the title or the company, ' +
      'or drop a middle word (STYLE.md §5.2a)');
  });
  allTextOf(main, 'role-summary').forEach(function (t, i) {
    assert(t.length <= BUDGET.roleSummary,
      'role-summary #' + (i + 1) + ' is ' + t.length + ' chars (budget ' + BUDGET.roleSummary + ', one line)',
      'wraps and costs one line per role: "' + t + '" (STYLE.md §5.2a)');
  });
  /* Skills rows: `<dd>` carries no class, so it is matched by tag. */
  var dds = [];
  var ddRe = /<dd[^>]*>([\s\S]*?)<\/dd>/g, m, i = 0;
  while ((m = ddRe.exec(main)) !== null) {
    var text = stripTags(m[1]); i++;
    assert(text.length <= BUDGET.skillsRow,
      'skills row #' + i + ' is ' + text.length + ' chars (budget ' + BUDGET.skillsRow + ', one line)',
      'wraps to a second line: "' + text.slice(0, 60) + '…" — cut a term (STYLE.md §5.6)');
    dds.push(text);
  }
  assert(dds.length <= BUDGET.skillsRows,
    'skills block is ' + dds.length + ' rows (budget ' + BUDGET.skillsRows + ')',
    'a fourth row buys page space with the weakest content on the page (STYLE.md §5.6)');

  /* --- the fit band --- */
  var cost = COST['default'];
  var lo = estimate(main, cost, 'max');   // optimistic word mix -> fewest lines
  var hi = estimate(main, cost, 'min');   // pessimistic word mix -> most lines

  ok(rel + ' — ' + lo.roles + ' roles, ' + lo.bullets + ' bullets, ' +
     lo.sections + ' sections, ' + lo.skillRows + ' skills rows');
  ok('estimated ink span ' + lo.lines + '–' + hi.lines + ' lines against ' +
     CAP.toFixed(2) + ' lines of capacity (Letter / default)');
  ok('estimated utilization ' + (lo.lines / CAP * 100).toFixed(1) + '–' +
     (hi.lines / CAP * 100).toFixed(1) + '% of the type area');

  /* Fail only on what a static check can honestly assert. */
  var over = lo.lines - CAP;
  assert(lo.lines <= CAP,
    rel + ' can fit one page at default density',
    'the OPTIMISTIC estimate already overflows by ' + over.toFixed(2) + ' lines (~' +
    Math.ceil(over) + ' line' + (Math.ceil(over) === 1 ? '' : 's') +
    '). Compact density buys about ' +
    (caps['Letter / compact'].lines - CAP).toFixed(1) +
    ' lines of capacity; a 2-line bullet trimmed under ' + BAND.bulletOneLine.min +
    ' chars gives back 1.00, deleting a non-final bullet 1.40–2.40, folding a lone location ' +
    'into .role-dates and dropping its role-meta row 2.00 (STYLE.md §5.2b — a stated location is ' +
    'never deleted to buy the line), dropping a Skills row 1.33. See STYLE.md §6.');

  if (lo.lines <= CAP && hi.lines > CAP) {
    ok('NOTE: the band straddles capacity — word mix decides. Render at default ' +
       'density and measure before applying compact (SKILL.md §The pipeline, step 5).');
  } else if (hi.lines < 0.90 * CAP) {
    ok('NOTE: even the pessimistic estimate leaves headroom (' +
       (hi.lines / CAP * 100).toFixed(1) + '% of capacity). If genuinely distinct, ' +
       'source-supported evidence exists, add it — never filler (STYLE.md §6).');
  }
});

/* ---- Section 3: the estimator must actually catch what it claims ---- */

header('checker self-test — synthetic fixtures');

function doc(body) { return '<main class="page">' + body + '</main>'; }
function role(title, summary, bullets) {
  return '<article class="role"><div class="role-header meta-row">' +
    '<p class="role-title-line">' + title + '</p>' +
    '<p class="role-dates">Mar 2022 – Present</p></div>' +
    (summary === null ? '' : '<div class="role-meta meta-row"><p class="role-summary">' + summary +
      '</p><p class="role-location">Brooklyn, NY</p></div>') +
    '<ul class="highlights">' + bullets.map(function (b) { return '<li>' + b + '</li>'; }).join('') +
    '</ul></article>';
}
function chars(n) { var s = ''; while (s.length < n) s += 'word '; return s.slice(0, n); }

var HEADER = '<header class="resume-header"><h1 class="name">A B</h1>' +
  '<p class="tagline">Staff Engineer · B.S. Computer Science, Some University</p>' +
  '<p class="contact"><a href="mailto:a@b.dev">a@b.dev</a></p></header>';
var SKILLS = '<section class="section"><div class="section-head"><h2>Skills</h2></div>' +
  '<dl class="skills"><dt>Languages</dt><dd>' + chars(40) + '</dd>' +
  '<dt>Data</dt><dd>' + chars(40) + '</dd>' +
  '<dt>Infra</dt><dd>' + chars(40) + '</dd></dl></section>';

var FIXTURES = [
  {
    name: 'the shipped sample shape (3 roles, 4/1/1 two-line bullets) fits',
    html: doc(HEADER + '<section class="section"><div class="section-head"><h2>Experience</h2></div>' +
      role('Staff Engineer · Tessera Labs', 'Storage platform · tech lead, team of 8', [chars(174), chars(173), chars(178), chars(174)]) +
      role('Senior Software Engineer · Helix Cloud', 'Edge Compute · tech lead, team of 12', [chars(129)]) +
      role('Software Engineer · Cardinal Systems', 'Search & ingestion · IC on a 6-person team', [chars(173)]) +
      '</section>' + SKILLS),
    fits: true
  },
  {
    name: '4 roles x 3 two-line bullets cannot fit one page (the §6 table\'s own minimum)',
    html: doc(HEADER + '<section class="section"><div class="section-head"><h2>Experience</h2></div>' +
      [0,1,2,3].map(function () {
        return role('Staff Engineer · Company', 'Platform · tech lead', [chars(174), chars(174), chars(174)]);
      }).join('') + '</section>' + SKILLS),
    fits: false
  },
  {
    name: '5 roles x 3 one-line bullets cannot fit one page either',
    html: doc(HEADER + '<section class="section"><div class="section-head"><h2>Experience</h2></div>' +
      [0,1,2,3,4].map(function () {
        return role('Staff Engineer · Company', 'Platform · tech lead', [chars(80), chars(80), chars(80)]);
      }).join('') + '</section>' + SKILLS),
    fits: false
  },
  {
    name: 'a role with no meta row at all (no summary, no stated location) is what makes 4 roles x 3 one-line bullets fit',
    html: doc(HEADER + '<section class="section"><div class="section-head"><h2>Experience</h2></div>' +
      [0,1,2,3].map(function () {
        return role('Staff Engineer · Company', null, [chars(80), chars(80), chars(80)]);
      }).join('') + '</section>' + SKILLS),
    fits: true
  }
];

FIXTURES.forEach(function (f) {
  var main = mainOf(f.html);
  var lo = estimate(main, COST['default'], 'max');
  var fits = lo.lines <= CAP;
  assert(fits === f.fits, f.name,
    'estimator says ' + lo.lines + ' lines vs ' + CAP.toFixed(2) + ' capacity (expected ' +
    (f.fits ? 'fits' : 'does not fit') + ')');
});

/* The estimator's own arithmetic, checked against the render. The shipped
   sample measures 44.70 lines of ink in build/line-yield-check.html; the
   static model must reproduce that within a quarter of a line, or the
   cost table has drifted from the stylesheets. */
var MEASURED_SAMPLE_LINES = 44.70;
var sampleLo = estimate(mainOf(read('resume.html')), COST['default'], 'max');
assert(Math.abs(sampleLo.lines - MEASURED_SAMPLE_LINES) < 0.25,
  'the static model reproduces the measured render of resume.html (' +
  sampleLo.lines + ' vs ' + MEASURED_SAMPLE_LINES + ' lines)',
  'drift of ' + Math.abs(sampleLo.lines - MEASURED_SAMPLE_LINES).toFixed(2) +
  ' lines — re-run build/line-yield-check.html and update the COST table');

/* Guard the ladder: a bullet under the one-line floor must cost 1 line,
   and one at the two-line floor must cost 2. A future edit that makes
   this linear would silently over-count every long bullet. */
assert(bulletLines(80, 95, 200) === 1 && bulletLines(174, 95, 200) === 2 &&
       bulletLines(178, 95, 200) === 2 && bulletLines(260, 95, 200) === 3,
  'the bullet line ladder is stepwise, not a linear chars-per-line rate');

H.report();
