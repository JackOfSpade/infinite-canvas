/* ============================================================
   build/annotation-budget-test.js — bullet-length + annotation
   restraint regression
   ----------------------------------------------------------
   Guards STYLE.md §5.3 / §5.4: EVERY bullet (<li>), annotated or not,
   stays within one renderer-verified budget — the same budget, not a
   bigger one for annotated bullets. `.scope` / `.tradeoff` are
   optional semantic annotations, not a substitute for evidence and
   not a licence to turn a 1-2-line bullet into a paragraph. Three
   things are mechanically enforced per bullet:

     1. At most one annotation total (.scope + .tradeoff combined),
        and at most one .tradeoff specifically — "Use at most one of
        these per bullet" (STYLE.md §5.4).
     2. Every bullet's full visible text (main sentence + label +
        annotation, if any) stays under MAX_BULLET_VISIBLE_CHARS —
        past this it reliably overflows 2 wrapped lines, whether or
        not it carries an annotation.
     3. A .tradeoff annotation's own text (excluding the
        " · trade-off: " label) stays under MAX_TRADEOFF_TEXT_CHARS —
        past this it is doing the work of a second sentence, not a
        concise decision/constraint note.

   MAX_BULLET_VISIBLE_CHARS is NOT an independent guess: it is
   calibrated with margin below the render-measured floor in
   build/bullet-length-check.html, which actually renders worst-case
   bullet text in the real page structure across Letter/A4 ×
   default/compact density and measures wrapped-line count. Static
   character counting here is a fast proxy for that render truth —
   if you change type scale, margins, or density tokens, re-run the
   .html companion before trusting a new number here.

   Section 1 runs these checks against the shipped sample documents,
   every bullet. Section 2 is a self-test of the checker: synthetic
   fixtures prove it actually flags the violations it claims to catch,
   not just that today's sample happens to pass.

   Run from the project root:
     node build/annotation-budget-test.js                  # the shipped samples
     node build/annotation-budget-test.js out/filled.html  # any filled document

   Exit code 0 on success, 1 on any violation.
   ============================================================ */

'use strict';

var fs   = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');

var H = require('./harness.js');
var ok = H.ok, fail = H.fail, header = H.header, assert = H.assert;
var GREEN = H.GREEN, RED = H.RED, DIM = H.DIM, RESET = H.RESET;

function read(rel) { return fs.readFileSync(path.isAbsolute(rel) ? rel : path.join(ROOT, rel), 'utf8'); }

/* Targets — same contract as ats-parse-test.js: file paths on the
   command line, defaulting to the shipped samples. Without argv this
   gate ignored its arguments entirely, so the pipeline's per-candidate
   invocation (SKILL.md §The pipeline, step 4) silently re-checked the
   two shipped templates and exited 0 — a 300-character generated bullet
   passed a gate that never looked at it. */
var targets = process.argv.slice(2);
if (targets.length === 0) targets = ['resume.html', 'cover-letter.html'];

/* Budgets. See build/bullet-length-check.html for the render measurement
   these are calibrated against: at Letter, default density (the
   tightest of the four supported configs), worst-case bullet text
   holds 2 wrapped lines up to ~195-206 visible characters depending on
   word mix; compact density and A4 are each a little more forgiving.
   180 leaves ~15-25 characters of margin below that floor. Keep these
   numbers in sync with STYLE.md §5.4 if either changes, and re-run the
   .html render check before raising them. */
var MAX_BULLET_VISIBLE_CHARS = 180; // one budget, every bullet, annotated or not
var MAX_TRADEOFF_TEXT_CHARS  = 100; // the .tradeoff clause alone, excluding its label
var MAX_ANNOTATIONS_PER_BULLET = 1; // .scope + .tradeoff combined
var MAX_TRADEOFF_PER_BULLET    = 1;

function stripTags(s) {
  return s.replace(/<[^>]+>/g, '')
    .replace(/&ldquo;/g, '\u201c').replace(/&rdquo;/g, '\u201d')
    .replace(/&lsquo;/g, '\u2018').replace(/&rsquo;/g, '\u2019')
    .replace(/&mdash;/g, '\u2014').replace(/&ndash;/g, '\u2013')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/* Depth-aware extraction of the outer <span class="scope|tradeoff">…
   </span> block(s) in a bullet's raw HTML. A naive non-greedy regex
   breaks the moment the annotation contains a nested span (nowrap,
   annotation-label) — real bullets always nest annotation-label, and
   sometimes nowrap too — so this walks tag-by-tag instead. Returns an
   array of { cls, raw } for every top-level annotation span found. */
function extractAnnotationSpans(raw) {
  var out = [];
  var openRe = /<span\b[^>]*>/gi;
  var m;
  while ((m = openRe.exec(raw)) !== null) {
    var classAttr = /\bclass\s*=\s*(["'])(.*?)\1/i.exec(m[0]);
    var classes = classAttr ? classAttr[2].split(/\s+/) : [];
    var annotationClasses = classes.filter(function (name) {
      return name === 'tradeoff' || name === 'scope';
    });
    if (annotationClasses.length === 0) continue;
    var cls = annotationClasses[0];
    var scanFrom = openRe.lastIndex;
    var depth = 1;
    var tagRe = /<span\b[^>]*>|<\/span>/gi;
    tagRe.lastIndex = scanFrom;
    var t, end = -1;
    while ((t = tagRe.exec(raw)) !== null) {
      if (/^<span\b/i.test(t[0])) depth++;
      else depth--;
      if (depth === 0) { end = t.index; break; }
    }
    out.push({
      cls: cls,
      raw: end === -1 ? '' : raw.slice(scanFrom, end),
      malformed: end === -1,
      conflictingClasses: annotationClasses.length > 1
    });
    if (end === -1) break;
    openRe.lastIndex = tagRe.lastIndex;
  }
  return out;
}

function annotationBodyText(spanRaw) {
  return stripTags(spanRaw.replace(/<span class="annotation-label">[\s\S]*?<\/span>/, ''));
}

/* Analyze one bullet's raw <li> inner HTML. Returns a list of
   violation strings (empty = compliant). Runs on EVERY bullet — the
   whole-bullet length cap applies whether or not it carries an
   annotation; the annotation-specific checks only fire when one is
   present. */
function analyzeBullet(raw) {
  var violations = [];
  var spans = extractAnnotationSpans(raw);

  if (spans.length > 0) {
    var tradeoffs = spans.filter(function (s) { return s.cls === 'tradeoff'; });
    var total = spans.length;

    if (tradeoffs.length > MAX_TRADEOFF_PER_BULLET) {
      violations.push('bullet carries ' + tradeoffs.length + ' .tradeoff annotations (max ' +
        MAX_TRADEOFF_PER_BULLET + ')');
    }
    if (total > MAX_ANNOTATIONS_PER_BULLET) {
      violations.push('bullet carries ' + total + ' annotations total (.scope + .tradeoff, max ' +
        MAX_ANNOTATIONS_PER_BULLET + ')');
    }
    spans.forEach(function (s) {
      if (s.malformed) violations.push('annotation span is not closed');
      if (s.conflictingClasses) violations.push('annotation span carries both .scope and .tradeoff classes');
    });
    tradeoffs.forEach(function (s) {
      var len = annotationBodyText(s.raw).length;
      if (len > MAX_TRADEOFF_TEXT_CHARS) {
        violations.push('.tradeoff text is ' + len + ' chars (budget ' + MAX_TRADEOFF_TEXT_CHARS +
          ') — not a concise decision/constraint note');
      }
    });
  }

  var fullLen = stripTags(raw).length;
  if (fullLen > MAX_BULLET_VISIBLE_CHARS) {
    violations.push('bullet is ' + fullLen + ' visible chars (budget ' + MAX_BULLET_VISIBLE_CHARS +
      ') — reliably overflows 2 wrapped lines, see build/bullet-length-check.html' +
      (spans.length > 0 ? ' (the annotation counts toward this same cap, not a separate one)' : ''));
  }

  return violations;
}

function bulletsIn(html) {
  var out = [], re = /<li\b[^>]*>([\s\S]*?)<\/li>/gi, m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

/* ---- Section 1: the target documents must stay compliant ----------- */

header(DIM + 'bullet length + annotation restraint' + RESET + '\n' + targets.join(', ') + ' — every bullet');

targets.forEach(function (rel) {
  var html = read(rel);
  var bullets = bulletsIn(html);
  bullets.forEach(function (raw, i) {
    var v = analyzeBullet(raw);
    var annotated = /class="(tradeoff|scope)"/.test(raw);
    var label = rel + ' — bullet #' + (i + 1) + (annotated ? ' (annotated)' : '') +
      ' (' + stripTags(raw).slice(0, 44) + '…)';
    assert(v.length === 0, label, v.join('; '));
  });
  if (bullets.length === 0) {
    ok(rel + ' — no bullets to check (nothing to violate)');
  }
});

/* ---- Section 2: the checker must actually catch what it claims ----- */

header('checker self-test — synthetic fixtures');

var FIXTURES = [
  {
    name: 'two .tradeoff spans in one bullet is rejected',
    li: 'Shipped the thing.' +
        '<span class="tradeoff"><span class="annotation-label"> · trade-off: </span>gave up X for Y.</span>' +
        '<span class="tradeoff"><span class="annotation-label"> · trade-off: </span>also gave up Z.</span>',
    expectViolation: true
  },
  {
    name: '.scope + .tradeoff combined on one bullet is rejected (max one annotation)',
    li: 'Shipped the thing.' +
        '<span class="scope"><span class="annotation-label"> · </span>4 engineers</span>' +
        '<span class="tradeoff"><span class="annotation-label"> · trade-off: </span>gave up X for Y.</span>',
    expectViolation: true
  },
  {
    name: 'an oversized .tradeoff blows the whole-bullet budget and is rejected',
    li: 'Owned the multi-region replication design for the storage platform, spanning three ' +
        'regions with active/active writes and bounded staleness.' +
        '<span class="tradeoff"><span class="annotation-label"> · trade-off: </span>picked CRDT ' +
        'eventual convergence over Raft for metadata because operator pain on quorum loss ' +
        'outweighed the consistency benefit at our read/write ratio.</span>',
    expectViolation: true
  },
  {
    name: 'a verbose .tradeoff text alone (short main sentence) is rejected on text-length',
    li: 'Chose a new datastore.' +
        '<span class="tradeoff"><span class="annotation-label"> · trade-off: </span>this trade-off ' +
        'annotation rambles on at considerable length about the reasoning behind the decision, far ' +
        'past what a single inline clause should ever need to say to a reader skimming the page.</span>',
    expectViolation: true
  },
  {
    name: 'a plain bullet (no annotation) over the whole-bullet budget is rejected — same cap, not a lighter one',
    li: 'Designed the sharding strategy for the timeseries write path, sustaining massive query ' +
        'volume at very low tail latency across a large multi-tenant dataset while replacing the ' +
        'prior scheme after it misbalanced badly under skewed tenant load in production.',
    expectViolation: true
  },
  {
    name: 'a nested nowrap span inside .tradeoff is parsed correctly (depth-aware, not naive regex)',
    li: 'Cut cold-start time sharply across the fleet.' +
        '<span class="tradeoff"><span class="annotation-label"> · trade-off: </span>accepted ' +
        '<span class="nowrap">+20 ms</span> tail latency for the win.</span>',
    expectViolation: false
  },
  {
    name: 'a single concise .tradeoff on a short bullet is accepted (the good pattern)',
    li: 'Owned the multi-region replication design: 3-region active/active, bounded staleness ' +
        'under 200 ms.' +
        '<span class="tradeoff"><span class="annotation-label"> · trade-off: </span>chose CRDT ' +
        'over Raft; accepted slower convergence under partition.</span>',
    expectViolation: false
  },
  {
    name: 'a plain bullet at budget with no annotation is accepted',
    li: 'Designed the sharding strategy for the timeseries write path, sustaining 1.4M QPS at ' +
        'p99 38 ms across 19 PB; replaced the prior scheme after it misbalanced under tenant skew.',
    expectViolation: false
  },
  {
    name: 'an unclosed annotation is rejected instead of silently ignored',
    li: 'Shipped the thing.<span class="tradeoff"><span class="annotation-label"> · trade-off: </span>gave up X for Y.',
    expectViolation: true
  }
];

FIXTURES.forEach(function (f) {
  var v = analyzeBullet(f.li);
  if (f.expectViolation) {
    assert(v.length > 0, f.name, 'expected a violation, checker found none');
  } else {
    assert(v.length === 0, f.name, 'expected no violation, checker found: ' + v.join('; '));
  }
});

assert(bulletsIn('<ul><li class="featured">Text</li></ul>').length === 1,
  'bullet extraction includes <li> elements that carry attributes');

H.report();
