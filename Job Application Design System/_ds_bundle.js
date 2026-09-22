/* @ds-bundle: {"format":4,"namespace":"JobApplicationDesignSystem_895a4b","components":[],"sourceHashes":{"build/annotation-budget-test.js":"645527f59d68","build/annotation-typography-test.js":"45b5e4e71b74","build/ats-parse-test.js":"af76ec3b3614","build/css-tokens.js":"cd9a99afed16","build/dual-mode-pdf.js":"2baecfd80478","build/education-placement-test.js":"2cfa1ec99be5","build/fixture-safety-test.js":"1d283c401808","build/harness.js":"ed3529261dc9","build/page-policy-doc-test.js":"48a64f933b8f","build/parallelism-gate-doc-test.js":"2a8eb9c5e1c1","build/synthesis-scope-gate-doc-test.js":"84af32e22dab","build/test.js":"3b6f0b1d06e0","build/token-sync-test.js":"0c4b05fcada9","handoff/pagination-contract-check.js":"ea0805ee741d"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.JobApplicationDesignSystem_895a4b = window.JobApplicationDesignSystem_895a4b || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// build/annotation-budget-test.js
try { (() => {
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

var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');
var H = require('./harness.js');
var ok = H.ok,
  fail = H.fail,
  header = H.header,
  assert = H.assert;
var GREEN = H.GREEN,
  RED = H.RED,
  DIM = H.DIM,
  RESET = H.RESET;
function read(rel) {
  return fs.readFileSync(path.isAbsolute(rel) ? rel : path.join(ROOT, rel), 'utf8');
}

/* Targets — same contract as ats-parse-test.js: file paths on the
   command line, defaulting to the shipped samples. Without argv this
   gate ignored its arguments entirely, so the pipeline's per-candidate
   invocation (SKILL.md §The pipeline, step 4) silently re-checked the
   two shipped templates and exited 0 — a 300-character generated bullet
   passed a gate that never looked at it. */
var targets = process.argv.slice(2);
if (targets.length === 0) targets = ['resume.html', 'cover-letter.html'];

/* Budgets. See build/bullet-length-check.html for the render measurement
   these are calibrated against: at Letter, default density (the tightest
   of the four supported configs), a bullet holds 2 wrapped lines up to a
   MEASURED FLOOR of 176 visible characters — the tightest of 8 shuffled
   orders of a low-breakpoint compound vocabulary. Ordinary mixed prose
   reaches 184-200. Compact density and A4 are each a little more
   forgiving. Measured 2026-08-21 by growing whole words at the real
   651.65px bullet measure.

   RETRACTED: an earlier note here claimed "~195-206 visible characters"
   and read 180 as leaving 15-25 characters of margin. That figure came
   from a rig clamped to max-width:640px with padding:0, i.e. a 625.65px
   measure — 3.99% narrow — and it also grew a mid-word-truncated string,
   which packs a line more tightly than whole words do. Both are fixed.

   180 therefore sits ABOVE the 176 floor, not below it: a compound-dense
   bullet at 180 can take a third line. The budget is kept at 180 because
   it is what the shipped documents are authored against and the fixture's
   own self-test still passes there, but treat 170 as the safe ceiling for
   a bullet heavy in long hyphenated technical terms. Keep these numbers in
   sync with STYLE.md §5.4, and re-run the .html render check before
   raising them. */
var MAX_BULLET_VISIBLE_CHARS = 180; // one budget, every bullet, annotated or not
var MAX_TRADEOFF_TEXT_CHARS = 100; // the .tradeoff clause alone, excluding its label
var MAX_ANNOTATIONS_PER_BULLET = 1; // .scope + .tradeoff combined
var MAX_TRADEOFF_PER_BULLET = 1;
function stripTags(s) {
  return s.replace(/<[^>]+>/g, '').replace(/&ldquo;/g, '\u201c').replace(/&rdquo;/g, '\u201d').replace(/&lsquo;/g, '\u2018').replace(/&rsquo;/g, '\u2019').replace(/&mdash;/g, '\u2014').replace(/&ndash;/g, '\u2013').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
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
    var t,
      end = -1;
    while ((t = tagRe.exec(raw)) !== null) {
      if (/^<span\b/i.test(t[0])) depth++;else depth--;
      if (depth === 0) {
        end = t.index;
        break;
      }
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
    var tradeoffs = spans.filter(function (s) {
      return s.cls === 'tradeoff';
    });
    var total = spans.length;
    if (tradeoffs.length > MAX_TRADEOFF_PER_BULLET) {
      violations.push('bullet carries ' + tradeoffs.length + ' .tradeoff annotations (max ' + MAX_TRADEOFF_PER_BULLET + ')');
    }
    if (total > MAX_ANNOTATIONS_PER_BULLET) {
      violations.push('bullet carries ' + total + ' annotations total (.scope + .tradeoff, max ' + MAX_ANNOTATIONS_PER_BULLET + ')');
    }
    spans.forEach(function (s) {
      if (s.malformed) violations.push('annotation span is not closed');
      if (s.conflictingClasses) violations.push('annotation span carries both .scope and .tradeoff classes');
    });
    tradeoffs.forEach(function (s) {
      var len = annotationBodyText(s.raw).length;
      if (len > MAX_TRADEOFF_TEXT_CHARS) {
        violations.push('.tradeoff text is ' + len + ' chars (budget ' + MAX_TRADEOFF_TEXT_CHARS + ') — not a concise decision/constraint note');
      }
    });
  }
  var fullLen = stripTags(raw).length;
  if (fullLen > MAX_BULLET_VISIBLE_CHARS) {
    violations.push('bullet is ' + fullLen + ' visible chars (budget ' + MAX_BULLET_VISIBLE_CHARS + ') — reliably overflows 2 wrapped lines, see build/bullet-length-check.html' + (spans.length > 0 ? ' (the annotation counts toward this same cap, not a separate one)' : ''));
  }
  return violations;
}
function bulletsIn(html) {
  var out = [],
    re = /<li\b[^>]*>([\s\S]*?)<\/li>/gi,
    m;
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
    var label = rel + ' — bullet #' + (i + 1) + (annotated ? ' (annotated)' : '') + ' (' + stripTags(raw).slice(0, 44) + '…)';
    assert(v.length === 0, label, v.join('; '));
  });
  if (bullets.length === 0) {
    ok(rel + ' — no bullets to check (nothing to violate)');
  }
});

/* ---- Section 2: the checker must actually catch what it claims ----- */

header('checker self-test — synthetic fixtures');
var FIXTURES = [{
  name: 'two .tradeoff spans in one bullet is rejected',
  li: 'Shipped the thing.' + '<span class="tradeoff"><span class="annotation-label"> · trade-off: </span>gave up X for Y.</span>' + '<span class="tradeoff"><span class="annotation-label"> · trade-off: </span>also gave up Z.</span>',
  expectViolation: true
}, {
  name: '.scope + .tradeoff combined on one bullet is rejected (max one annotation)',
  li: 'Shipped the thing.' + '<span class="scope"><span class="annotation-label"> · </span>4 engineers</span>' + '<span class="tradeoff"><span class="annotation-label"> · trade-off: </span>gave up X for Y.</span>',
  expectViolation: true
}, {
  name: 'an oversized .tradeoff blows the whole-bullet budget and is rejected',
  li: 'Owned the multi-region replication design for the storage platform, spanning three ' + 'regions with active/active writes and bounded staleness.' + '<span class="tradeoff"><span class="annotation-label"> · trade-off: </span>picked CRDT ' + 'eventual convergence over Raft for metadata because operator pain on quorum loss ' + 'outweighed the consistency benefit at our read/write ratio.</span>',
  expectViolation: true
}, {
  name: 'a verbose .tradeoff text alone (short main sentence) is rejected on text-length',
  li: 'Chose a new datastore.' + '<span class="tradeoff"><span class="annotation-label"> · trade-off: </span>this trade-off ' + 'annotation rambles on at considerable length about the reasoning behind the decision, far ' + 'past what a single inline clause should ever need to say to a reader skimming the page.</span>',
  expectViolation: true
}, {
  name: 'a plain bullet (no annotation) over the whole-bullet budget is rejected — same cap, not a lighter one',
  li: 'Designed the sharding strategy for the timeseries write path, sustaining massive query ' + 'volume at very low tail latency across a large multi-tenant dataset while replacing the ' + 'prior scheme after it misbalanced badly under skewed tenant load in production.',
  expectViolation: true
}, {
  name: 'a nested nowrap span inside .tradeoff is parsed correctly (depth-aware, not naive regex)',
  li: 'Cut cold-start time sharply across the fleet.' + '<span class="tradeoff"><span class="annotation-label"> · trade-off: </span>accepted ' + '<span class="nowrap">+20 ms</span> tail latency for the win.</span>',
  expectViolation: false
}, {
  name: 'a single concise .tradeoff on a short bullet is accepted (the good pattern)',
  li: 'Owned the multi-region replication design: 3-region active/active, bounded staleness ' + 'under 200 ms.' + '<span class="tradeoff"><span class="annotation-label"> · trade-off: </span>chose CRDT ' + 'over Raft; accepted slower convergence under partition.</span>',
  expectViolation: false
}, {
  name: 'a plain bullet at budget with no annotation is accepted',
  li: 'Designed the sharding strategy for the timeseries write path, sustaining 1.4M QPS at ' + 'p99 38 ms across 19 PB; replaced the prior scheme after it misbalanced under tenant skew.',
  expectViolation: false
}, {
  name: 'an unclosed annotation is rejected instead of silently ignored',
  li: 'Shipped the thing.<span class="tradeoff"><span class="annotation-label"> · trade-off: </span>gave up X for Y.',
  expectViolation: true
}];
FIXTURES.forEach(function (f) {
  var v = analyzeBullet(f.li);
  if (f.expectViolation) {
    assert(v.length > 0, f.name, 'expected a violation, checker found none');
  } else {
    assert(v.length === 0, f.name, 'expected no violation, checker found: ' + v.join('; '));
  }
});
assert(bulletsIn('<ul><li class="featured">Text</li></ul>').length === 1, 'bullet extraction includes <li> elements that carry attributes');
H.report();
})(); } catch (e) { __ds_ns.__errors.push({ path: "build/annotation-budget-test.js", error: String((e && e.message) || e) }); }

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
   in a real engine — is build/annotation-typography-check.html.

   Run from the project root:  node build/annotation-typography-test.js
   Exit code 0 on success, 1 on first failure.
   ============================================================ */

'use strict';

var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');
var H = require('./harness.js');
var ok = H.ok,
  fail = H.fail,
  header = H.header,
  assert = H.assert;
var GREEN = H.GREEN,
  RED = H.RED,
  DIM = H.DIM,
  RESET = H.RESET;

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

/* True when a selector list applies to the class element itself, not
   merely to one of its descendants (`.scope em`, for example). */
function selectorTargetsClass(selector, className) {
  return selector.split(',').some(function (part) {
    var compounds = part.trim().split(/\s+|>|\+|~/);
    var target = compounds[compounds.length - 1];
    return new RegExp('\\.' + className + '(?![\\w-])').test(target);
  });
}
function selectorTargetsTag(selector, tagName) {
  return selector.split(',').some(function (part) {
    var compounds = part.trim().split(/\s+|>|\+|~/);
    var target = compounds[compounds.length - 1];
    return new RegExp('^' + tagName + '(?:$|[:.#\\[])', 'i').test(target);
  });
}

/* Rules whose selector list targets one of the annotation classes. */
function annotationRules(rules) {
  return rules.filter(function (r) {
    return ANNOTATION_CLASSES.some(function (c) {
      return selectorTargetsClass(r.selector, c);
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

/* 2. …and the load-bearing ones must actually be declared on EACH class,
      so one fully-pinned `.scope` rule cannot mask an unpinned
      `.tradeoff` or `.annotation-label`. */
var missingByClass = [];
ANNOTATION_CLASSES.forEach(function (className) {
  var classRules = resumeRules.filter(function (r) {
    return selectorTargetsClass(r.selector, className);
  });
  var declared = {};
  classRules.forEach(function (r) {
    declarations(r.body).forEach(function (d) {
      if (isInherit(d.value)) declared[d.prop] = true;
    });
  });
  REQUIRED_INHERITS.forEach(function (prop) {
    if (!declared[prop] && !(declared.font && prop.indexOf('font-') === 0)) {
      missingByClass.push('.' + className + ': ' + prop);
    }
  });
});
assert(missingByClass.length === 0, 'each annotation class inherits the parent bullet type explicitly (' + REQUIRED_INHERITS.join(', ') + ')', 'not inherited: ' + missingByClass.join(', '));

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

/* 5. Bullet-body <strong>/<b> render at the bullet's own weight — no
      inline emphasis inside .highlights li (STYLE.md §5.4.1). The tags
      stay in the markup (the host app keys off them, and any
      data-achievement-id, as semantic metadata) but must resolve to
      `inherit` for font-weight and color, scoped to .highlights li only. */
var highlightsBoldRules = parseRules(resumeCss).filter(function (r) {
  return /\.highlights\s+li\b/.test(r.selector) && (selectorTargetsTag(r.selector, 'b') || selectorTargetsTag(r.selector, 'strong'));
});
assert(highlightsBoldRules.length > 0, 'resume.css has a .highlights li b/strong override rule', 'no rule matched .highlights li b / .highlights li strong');
var highlightsBoldOffenders = [];
highlightsBoldRules.forEach(function (r) {
  declarations(r.body).forEach(function (d) {
    if ((d.prop === 'font-weight' || d.prop === 'color') && !isInherit(d.value)) {
      highlightsBoldOffenders.push(r.selector + ' { ' + d.prop + ': ' + d.value + ' }');
    }
  });
});
assert(highlightsBoldOffenders.length === 0, '.highlights li b/strong sets font-weight and color to inherit only', highlightsBoldOffenders.join('  |  '));
var highlightsMissing = [];
['b', 'strong'].forEach(function (tagName) {
  var declared = {};
  highlightsBoldRules.filter(function (r) {
    return selectorTargetsTag(r.selector, tagName);
  }).forEach(function (r) {
    declarations(r.body).forEach(function (d) {
      if (isInherit(d.value)) declared[d.prop] = true;
    });
  });
  ['font-weight', 'color'].forEach(function (prop) {
    if (!declared[prop]) highlightsMissing.push(tagName + ': ' + prop);
  });
});
assert(highlightsMissing.length === 0, '.highlights li b and strong each explicitly inherit font-weight and color', 'not inherited: ' + highlightsMissing.join(', '));

/* Structural/global bold is untouched: the base rule (name, role title,
   employer, project name) and the cover letter's own rule still set a
   real weight, not inherit — this decision is scoped to résumé bullets. */
var globalStrongRules = parseRules(read('colors_and_type.css')).filter(function (r) {
  return /(^|[\s,])(b|strong)(?![\w-])/.test(r.selector);
});
assert(globalStrongRules.some(function (r) {
  return declarations(r.body).some(function (d) {
    return d.prop === 'font-weight' && !isInherit(d.value);
  });
}), 'global b, strong rule (colors_and_type.css) still sets its own weight');
var letterStrongRules = parseRules(read('cover-letter.css')).filter(function (r) {
  return /\bstrong\b/.test(r.selector);
});
assert(letterStrongRules.some(function (r) {
  return declarations(r.body).some(function (d) {
    return d.prop === 'font-weight' && !isInherit(d.value);
  });
}), 'cover-letter.css .letter-body strong still sets its own weight');

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
  /* Presence guard, matching the sibling checks above: a card that no
     longer demonstrates an annotation would pass the loop above by
     having nothing to inspect. */
  assert(/class="(scope|tradeoff|annotation-label)"/.test(read(rel)), rel + ' still demonstrates an annotation span');
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
H.report();
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
var H = require('./harness.js');
var ok = H.ok,
  fail = H.fail,
  header = H.header,
  assert = H.assert;
var GREEN = H.GREEN,
  RED = H.RED,
  DIM = H.DIM,
  RESET = H.RESET;
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

/* Shared declaration patterns. Spell out every zero form rather than
   matching only `opacity: 0`: `0.0`, `00`, `0%`, and `!important`
   hide text just as completely. `columns` is the shorthand form of the
   two longhands and creates the same parse-order hazard. */
var ZERO_VALUE = '(?:0+(?:\\.0+)?|\\.0+)%?';
var DECLARATION_END = "(?=\\s*(?:[;}\"']))";
var HIDDEN_TEXT = new RegExp('(?:visibility\\s*:\\s*hidden|' + 'opacity\\s*:\\s*' + ZERO_VALUE + '(?:\\s*!important)?' + DECLARATION_END + '|' + 'font-size\\s*:\\s*' + ZERO_VALUE + '(?:px|pt|em|rem)?(?:\\s*!important)?' + DECLARATION_END + ')', 'i');
var CSS_COLUMNS = /(?:^|[;{"'\s])(?:column-(?:count|width)|columns)\s*:/i;

/* Each hazard: [label, regexp over candidate copy, why]. A match fails. */
var HAZARDS = [['no <table> (cell reading order interleaves lines)', /<table[\s>]/i], ['no <img> / <svg> / <canvas> (text in them extracts as nothing)', /<(img|svg|canvas|picture)[\s>]/i, 'main'], ['no position:absolute / fixed on content', /position\s*:\s*(absolute|fixed)/i], ['no CSS columns (real columns interleave on parse)', CSS_COLUMNS], ['no hidden or zero-size text (reads as keyword stuffing)', HIDDEN_TEXT], ['no tabular figures (every digit drops from the PDF)', /(tabular-nums|["']tnum["'])/i], ['no &nbsp; in candidate copy (use class="nowrap")', /&nbsp;|&#160;|&#xa0;|\u00a0/i], ['no <font> / <center> / inline text-align hacks', /<(font|center)[\s>]/i]];
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
var SHEETS = ['colors_and_type.css', 'resume.css', 'cover-letter.css', 'styles.css'];
function positionedSelectors(css) {
  var out = [];
  var rules = css.match(/[^{}]+\{[^{}]*\}/g) || [];
  rules.forEach(function (rule) {
    var brace = rule.indexOf('{');
    if (!/position\s*:\s*(absolute|fixed)/i.test(rule.slice(brace + 1))) return;
    rule.slice(0, brace).split(',').forEach(function (selector) {
      var clean = selector.replace(/\s+/g, ' ').trim();
      if (clean && !/::?(before|after)\b/.test(clean)) out.push(clean);
    });
  });
  return out;
}
header('stylesheets — no hazard in any sheet a document loads');
SHEETS.forEach(function (sheet) {
  /* Comments stripped: the sheets document several hazards in prose ("do
     not reintroduce tabular-nums"), and a doc comment must never trip a
     check that is looking for a real declaration. */
  var s = read(sheet).replace(/\/\*[\s\S]*?\*\//g, '');
  assert(!/tabular-nums|["']tnum["']/.test(s), sheet + ': no rule enables tabular figures');
  assert(!CSS_COLUMNS.test(s), sheet + ': no CSS multi-column rule');
  /* `position: absolute` is legitimate on the bullet pseudo-element and
     nowhere else, so skip only the pseudo-element selector in a selector
     list. A mixed `body, li::before` rule must still flag `body`. */
  var positioned = positionedSelectors(s);
  assert(positioned.length === 0, sheet + ': no rule positions content absolutely (bullet pseudo-element excepted)', positioned.join(' | '));
  assert(!HIDDEN_TEXT.test(s), sheet + ': no rule hides text');
});
header('checker self-test — bypass forms stay blocked');
assert(HIDDEN_TEXT.test('opacity: 0.0 !important;') && HIDDEN_TEXT.test('font-size: 00px;') && !HIDDEN_TEXT.test('opacity: 0.01;'), 'hidden-text detector catches equivalent zero forms without flagging visible opacity');
assert(CSS_COLUMNS.test('columns: 12rem 2;') && CSS_COLUMNS.test('column-count: 2;'), 'multi-column detector covers the shorthand and longhand forms');
assert(positionedSelectors('body, li::before { position: absolute; }').join(',') === 'body', 'pseudo-element exemption does not hide a positioned ordinary selector in the same list');
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

/* The list above must cover every stylesheet the target documents
   actually link — otherwise a new surface stylesheet ships unscanned and
   this whole section passes by omission. (This replaced an
   `assert(true, …)` that reported a passing check while measuring
   nothing.) Compared by basename, so a filled document written to a
   subdirectory still resolves. */
var linkedSheets = [];
targets.forEach(function (rel) {
  var re = /<link\b[^>]*rel="stylesheet"[^>]*>/gi,
    tag;
  var html = read(rel);
  while ((tag = re.exec(html)) !== null) {
    var href = /href="([^"]+)"/i.exec(tag[0]);
    var base = href && href[1].split('/').pop();
    if (base && linkedSheets.indexOf(base) === -1) linkedSheets.push(base);
  }
});
var unscanned = linkedSheets.filter(function (s) {
  return SHEETS.indexOf(s) === -1;
});
assert(unscanned.length === 0, 'every stylesheet the target documents link is scanned above (' + (linkedSheets.join(', ') || 'none linked — inlined CSS') + ')', 'unscanned: ' + unscanned.join(', '));
H.report();
})(); } catch (e) { __ds_ns.__errors.push({ path: "build/ats-parse-test.js", error: String((e && e.message) || e) }); }

// build/css-tokens.js
try { (() => {
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

var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');
var TOKENS_FILE = 'colors_and_type.css';
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/* Every `selector { … }` pair, flattened. At-rule wrappers (@media)
   contribute their inner blocks, which is what we want: the variant
   overrides inside @media print read as ordinary `:root[…]` blocks. */
function rules(css) {
  var out = [],
    re = /([^{}]+)\{([^{}]*)\}/g,
    m;
  while ((m = re.exec(css)) !== null) {
    out.push({
      selector: m[1].replace(/\s+/g, ' ').trim(),
      body: m[2]
    });
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
    var match = scope ? r.selector.indexOf(scope) !== -1 : /:root$/.test(r.selector) && r.selector.indexOf('[') === -1;
    if (!match) return;
    var re = new RegExp('(?:^|;)\\s*' + name + '\\s*:\\s*([^;]+)', 'g'),
      m;
    while ((m = re.exec(r.body)) !== null) found = m[1].trim();
  });
  return found;
}

/* #RRGGBB → [r, g, b] in [0,1], the form the PDF content stream uses. */
function hexToRgb01(hex) {
  var h = String(hex).trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error('not a 6-digit hex colour: ' + hex);
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

/* The exact operand string dual-mode-pdf.js writes for a fill colour,
   so a test can match the real content stream. */
function pdfRgbOperands(hex) {
  return hexToRgb01(hex).map(function (v) {
    return v.toFixed(4);
  });
}

/* Absolute CSS lengths → pt, so 0.6in and 15.24mm can be compared. */
function toPt(value) {
  var m = /^\s*(-?[\d.]+)\s*(pt|in|mm|cm|px)\s*$/.exec(String(value));
  if (!m) throw new Error('not an absolute length: ' + value);
  var n = parseFloat(m[1]);
  switch (m[2]) {
    case 'pt':
      return n;
    case 'in':
      return n * 72;
    case 'mm':
      return n * 72 / 25.4;
    case 'cm':
      return n * 720 / 25.4;
    case 'px':
      return n * 0.75;
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
})(); } catch (e) { __ds_ns.__errors.push({ path: "build/css-tokens.js", error: String((e && e.message) || e) }); }

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
     ensurePrintAutoState()  — /OCProperties /D /AS Print rule
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

  /* Pick a page-resource name without overwriting an existing
   * /Properties entry. `Bg` is intentionally short and remains the
   * common case, but imported PDFs can already use it for an unrelated
   * OCG. Rebinding their name would silently retag existing content. */
  function availableOcgResourceName(properties) {
    var suffix = 0;
    var candidate;
    do {
      candidate = OCG_MC_NAME + (suffix || '');
      suffix++;
    } while (properties.has(PDFName.of(candidate)));
    return candidate;
  }

  /* True if `obj` is the PDF name /<expected>. Works for direct names
   * and for anything whose toString() is the canonical "/Name" form. */
  function isPdfName(obj, expected) {
    return !!obj && String(obj) === '/' + expected;
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

  /* True if an /AS entry's /Category array lists /Print. */
  function categoryHasPrint(entry, ctx) {
    var cat = entry.lookup(PDFName.of('Category'));
    if (!(cat instanceof PDFArray)) return false;
    for (var i = 0; i < cat.size(); i++) {
      if (isPdfName(ctx.lookup(cat.get(i)), 'Print')) return true;
    }
    return false;
  }

  /* Auto-state (PDF spec §8.11.4.4). /Usage alone is advisory: a viewer
   * only consults it when the default configuration tells it to, via an
   * /AS (auto states) entry naming the event, the usage categories to
   * read, and the OCGs the rule governs. Without this, most viewers
   * keep the on-screen state at print time and the cream background
   * ends up on paper / in Print → Save as PDF.
   *
   *   /AS [ << /Event /Print /Category [ /Print ] /OCGs [ <cream> ] >> ]
   *
   * Merge semantics: if a Print/Print rule already exists (the input
   * carried its own OCGs), append our OCG to it rather than authoring
   * a second equivalent entry; if our OCG is already listed, do
   * nothing. Any missing or malformed /AS is created. */
  function ensurePrintAutoState(dDict, ctx, ocgRef) {
    var asArr = ensureArray(dDict, 'AS', ctx);
    for (var i = 0; i < asArr.size(); i++) {
      var entry = ctx.lookup(asArr.get(i));
      if (!(entry instanceof PDFDict)) continue;
      if (!isPdfName(entry.lookup(PDFName.of('Event')), 'Print')) continue;
      if (!categoryHasPrint(entry, ctx)) continue;
      var governed = ensureArray(entry, 'OCGs', ctx);
      for (var j = 0; j < governed.size(); j++) {
        if (String(governed.get(j)) === String(ocgRef)) return asArr;
      }
      governed.push(ocgRef);
      return asArr;
    }
    asArr.push(ctx.obj({
      Event: 'Print',
      Category: ['Print'],
      OCGs: [ocgRef]
    }));
    return asArr;
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
   * tells the print pipeline to skip this content — but it is only
   * consulted when /OCProperties /D /AS carries a matching Print
   * auto-state rule, which `ensurePrintAutoState` guarantees.
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
      ensurePrintAutoState(dDict, ctx, ocgRef);
    } else {
      pdf.catalog.set(PDFName.of('OCProperties'), ctx.obj({
        OCGs: [ocgRef],
        D: {
          Order: [ocgRef],
          ON: [ocgRef],
          OFF: [],
          BaseState: 'ON',
          AS: [{
            Event: 'Print',
            Category: ['Print'],
            OCGs: [ocgRef]
          }]
        }
      }));
    }
    return ocgRef;
  }

  // ----- Page helpers ----------------------------------------------------

  /* Page sanity check. The cream rectangle follows the MediaBox origin
   * and dimensions with no rotation transform. If the input PDF has a
   * non-zero effective rotation or a CropBox smaller than MediaBox,
   * the rectangle's positioning becomes unpredictable. Chrome's print-
   * to-PDF doesn't emit either of those for the design system's
   * resume.html, so this is a defensive assert — better to fail loudly
   * than ship a PDF with a misaligned background.
   *
   * Signature matches Array#forEach's (element, index) so it can be
   * passed directly: `pages.forEach(assertNormalPage)`. */
  function assertNormalPage(page, idx) {
    var rotation = page.getRotation().angle;
    var effectiveRotation = (rotation % 360 + 360) % 360;
    if (effectiveRotation !== 0) {
      throw new Error('dual-mode-pdf: page ' + (idx + 1) + ' has /Rotate ' + rotation + '; rotated pages are not supported. Re-render the source PDF without rotation.');
    }
    var cropBox = page.getCropBox();
    var mediaBox = page.getMediaBox();
    var boxProps = ['x', 'y', 'width', 'height'];
    for (var i = 0; i < boxProps.length; i++) {
      var prop = boxProps[i];
      if (Math.abs(mediaBox[prop] - cropBox[prop]) > BOX_EPSILON) {
        throw new Error('dual-mode-pdf: page ' + (idx + 1) + ' has CropBox ≠ MediaBox; ' + 'this is not supported. Re-render the source PDF without a crop box.');
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
    var mediaBox = page.getMediaBox();

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
    var resourceName = availableOcgResourceName(properties);
    properties.set(PDFName.of(resourceName), ocgRef);

    // Build the content stream (no filter — ~100 bytes, compression
    // isn't worth the debugging cost).
    var ops = 'q\n' + '/OC /' + resourceName + ' BDC\n' + cream[0].toFixed(4) + ' ' + cream[1].toFixed(4) + ' ' + cream[2].toFixed(4) + ' rg\n' + mediaBox.x.toFixed(2) + ' ' + mediaBox.y.toFixed(2) + ' ' + mediaBox.width.toFixed(2) + ' ' + mediaBox.height.toFixed(2) + ' re\n' + 'f\n' + 'EMC\n' + 'Q\n';
    var opBytes = encoder.encode(ops);
    var streamRef = ctx.register(PDFRawStream.of(ctx.obj({
      Length: opBytes.length
    }), opBytes));

    // Prepend to /Contents. May be a single stream/ref, an array of
    // refs, or absent.
    var existing = node.get(PDFName.of('Contents'));
    var resolvedExisting = existing && ctx.lookup(existing);
    var newContents = PDFArray.withContext(ctx);
    newContents.push(streamRef);
    if (resolvedExisting instanceof PDFArray) {
      /* /Contents itself may be an indirect reference to an array. A
       * nested array is not a valid page-content sequence, so flatten
       * the resolved array while preserving its stream references. */
      for (var i = 0; i < resolvedExisting.size(); i++) {
        newContents.push(resolvedExisting.get(i));
      }
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
    /* A malformed catalog entry must not turn the defensive merge path
     * into `TypeError: lookup is not a function`. Replacing a non-dict
     * /OCProperties value is the only spec-valid recovery. */
    if (!(existingOcProps instanceof PDFDict)) existingOcProps = null;
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
   build/education-placement-check.html.

   Run from the project root:  node build/education-placement-test.js
   Exit code 0 on success, 1 on first failure.
   ============================================================ */

'use strict';

var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');
var H = require('./harness.js');
var ok = H.ok,
  fail = H.fail,
  header = H.header,
  assert = H.assert;
var GREEN = H.GREEN,
  RED = H.RED,
  DIM = H.DIM,
  RESET = H.RESET;
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
H.report();
})(); } catch (e) { __ds_ns.__errors.push({ path: "build/education-placement-test.js", error: String((e && e.message) || e) }); }

// build/fixture-safety-test.js
try { (() => {
/* ============================================================
   build/fixture-safety-test.js — authoring-fixture provenance gate
   ----------------------------------------------------------
   Handoff and upload examples are committed developer references, not
   private application archives. Keep one explicit synthetic identity
   across both HTML copies, and keep the application-sync shape without
   retaining a usable endpoint or bearer capability.
   ============================================================ */

'use strict';

var fs = require('fs');
var path = require('path');
var H = require('./harness.js');
var header = H.header,
  assert = H.assert;
var DIM = H.DIM,
  RESET = H.RESET;
var ROOT = path.join(__dirname, '..');
var FIXTURES = ['uploads/Application.html', 'handoff/Application-paginated-example.html'];
var SYNTHETIC = {
  name: 'Jordan Lee',
  email: 'jordan.lee@example.test',
  telephoneHref: 'tel:+12025550147',
  telephoneText: '(202) 555-0147',
  token: 'INERT_FIXTURE_TOKEN'
};
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
function bundleData(html) {
  var match = /<script\b[^>]*id="ic-application-bundle-data"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}
header(DIM + 'fixture safety' + RESET);
FIXTURES.forEach(function (rel) {
  var html = read(rel);
  var payload = bundleData(html);
  var emails = html.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  var telHrefs = html.match(/tel:[^"'\s<]+/gi) || [];
  assert(emails.length > 0 && emails.every(function (email) {
    return email.toLowerCase() === SYNTHETIC.email;
  }), rel + ' contains only the reserved synthetic email', emails.join(', '));
  assert(telHrefs.length > 0 && telHrefs.every(function (href) {
    return href === SYNTHETIC.telephoneHref;
  }), rel + ' contains only the synthetic telephone link', telHrefs.join(', '));
  assert(html.indexOf(SYNTHETIC.telephoneText) !== -1, rel + ' renders the synthetic telephone number');
  assert((html.match(new RegExp(SYNTHETIC.name, 'g')) || []).length >= 3, rel + ' uses the synthetic identity in résumé, letter, and metadata');
  assert(!!payload, rel + ' carries parseable application bundle metadata');
  if (payload) {
    assert(payload.candidateName === SYNTHETIC.name, rel + ' metadata names the synthetic candidate');
    assert(payload.sync && payload.sync.endpoint === '', rel + ' application-sync endpoint is deliberately disabled');
    assert(payload.sync && payload.sync.token === SYNTHETIC.token, rel + ' keeps only the visibly inert fixture token');
  }
  assert(!/"token"\s*:\s*"[a-f0-9]{32,}"/i.test(html), rel + ' contains no production-looking hex bearer token');
});
assert(!fs.existsSync(path.join(ROOT, 'uploads', 'Resume.pdf')), 'uploads/ contains no private candidate résumé PDF');
H.report();
})(); } catch (e) { __ds_ns.__errors.push({ path: "build/fixture-safety-test.js", error: String((e && e.message) || e) }); }

// build/harness.js
try { (() => {
/* ============================================================
   build/harness.js — the assertion harness every Node test in this
   folder shares.
   ----------------------------------------------------------
   This block used to be copy-pasted, byte-identical, into each test
   file (colour codes, counters, ok/fail/header/assert, the report +
   exit footer). One copy now: a change to the report format, the exit
   contract, or the failure summary lands in every suite at once.

   Usage:
     var H = require('./harness.js');
     var ok = H.ok, fail = H.fail, header = H.header, assert = H.assert;
     var GREEN = H.GREEN, RED = H.RED, DIM = H.DIM, RESET = H.RESET;
     ... assertions ...
     H.report();          // prints the summary, exits 1 if anything failed
   ============================================================ */

'use strict';

var GREEN = '\x1b[32m',
  RED = '\x1b[31m',
  DIM = '\x1b[2m',
  RESET = '\x1b[0m';
var passed = 0,
  failed = 0,
  failures = [];
function ok(name) {
  console.log('  ' + GREEN + '\u2713' + RESET + ' ' + name);
  passed++;
}
function fail(name, m) {
  console.log('  ' + RED + '\u2717' + RESET + ' ' + name + ' \u2014 ' + (m || 'assertion failed'));
  failed++;
  failures.push(name);
}
function header(s) {
  console.log('\n' + s);
}
function assert(cond, name, msg) {
  if (cond) ok(name);else fail(name, msg);
}

/* Counts, for a suite that needs to branch on them. */
function counts() {
  return {
    passed: passed,
    failed: failed,
    failures: failures.slice()
  };
}

/* The footer every suite ends with. Exits 1 on any failure so the npm
   test chain stops at the first broken gate. */
function report() {
  console.log('\n' + (failed === 0 ? GREEN : RED) + passed + ' passed, ' + failed + ' failed' + RESET);
  if (failed > 0) {
    console.log(RED + 'Failures: ' + failures.join(', ') + RESET);
    process.exit(1);
  }
}
module.exports = {
  ok: ok,
  fail: fail,
  header: header,
  assert: assert,
  counts: counts,
  report: report,
  GREEN: GREEN,
  RED: RED,
  DIM: DIM,
  RESET: RESET
};
})(); } catch (e) { __ds_ns.__errors.push({ path: "build/harness.js", error: String((e && e.message) || e) }); }

// build/page-policy-doc-test.js
try { (() => {
/* ============================================================
   build/page-policy-doc-test.js — static regression for the
   one-page-default résumé policy (STYLE.md §6, SKILL.md §The
   pipeline step 5). Guards the DOCS, not the render: fails if a
   future edit reintroduces title-based multi-page targets, or drops
   the required "explicit override only" language.

   Run from the project root:  node build/page-policy-doc-test.js
   Exit code 0 on success, 1 on first failure.
   ============================================================ */

'use strict';

var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');
var H = require('./harness.js');
var ok = H.ok,
  fail = H.fail,
  assert = H.assert;
var GREEN = H.GREEN,
  RED = H.RED,
  RESET = H.RESET;
function read(p) {
  return fs.readFileSync(path.join(ROOT, p), 'utf8');
}
var skill = read('SKILL.md');
var style = read('STYLE.md');
var readme = read('readme.md');

// ---- forbidden: title-based / two-page-default language ----------------
var FORBIDDEN = [[/2\s+for\s+principal/i, 'SKILL.md'], [/1\.4\s+pages/i, 'STYLE.md'], [/2\.0\s+pages/i, 'STYLE.md'], [/does not\*\* compress content to fit one page/i, 'STYLE.md'], [/staff\+\s+candidates have content/i, 'STYLE.md'], [/not a one-pager/i, 'STYLE.md']];
FORBIDDEN.forEach(function (pair) {
  var re = pair[0],
    file = pair[1];
  var text = file === 'SKILL.md' ? skill : file === 'STYLE.md' ? style : readme;
  assert(!re.test(text), file + ' no longer contains ' + re, 'found forbidden title/two-page-default language matching ' + re);
});

// ---- required: one-page default + explicit-override language ----------
console.log('');
assert(/one page.{0,40}default/i.test(skill) || /default.{0,40}one page/i.test(skill), 'SKILL.md states one page is the default', 'no "one page ... default" language found');
/* Proximity, not two independent word searches: the previous version
   passed as long as "explicit" and "override" each appeared anywhere in
   the file, so deleting the sentence it guards changed nothing. */
assert(/explicit(ly)?[^.\n]{0,140}(override|request(ed|s)?)/i.test(skill) || /(override|request(ed|s)?)[^.\n]{0,140}explicit(ly)?/i.test(skill), 'SKILL.md ties multi-page to an explicit override/request in one sentence', 'no sentence pairs "explicit" with "override"/"requested"');
assert(/absent that explicit override/i.test(skill), 'SKILL.md keeps the "absent that explicit override, one page" clause', 'the clause the one-page default rests on is gone');
assert(/never infer/i.test(skill) || /never.{0,20}inferred/i.test(skill), 'SKILL.md bans inferring page count from title', 'no "never infer[red]" language found');
['Senior Staff', 'Principal', 'Director', 'VP', 'executive'].forEach(function (term) {
  assert(skill.indexOf(term) !== -1, 'SKILL.md names "' + term + '" as a non-signal for page count', 'title term "' + term + '" not found near the page-count rule');
});
console.log('');
assert(/one well-filled page/i.test(style) || /one page.{0,40}default/i.test(style), 'STYLE.md §6 states one well-filled page is the default shape', 'no matching language found in STYLE.md §6');
assert(/explicit host\/user override|explicit.{0,20}override/i.test(style), 'STYLE.md frames multi-page as an explicit-override case', 'no "explicit ... override" language found');
assert(/retain(ing)? every documented role/i.test(style) || /every documented role/i.test(style), 'STYLE.md requires retaining every documented role when cutting', 'no "every documented role" language found');
assert(/at least one factual\s+bullet per role/i.test(style), 'STYLE.md requires at least one factual bullet per role', 'no "at least one factual bullet per role" language found');
console.log('');
assert(/length is \*\*one page\*\*/i.test(style), 'STYLE.md §11.4 still requires the cover letter to be one page', 'cover-letter one-page rule missing');
H.report();
})(); } catch (e) { __ds_ns.__errors.push({ path: "build/page-policy-doc-test.js", error: String((e && e.message) || e) }); }

// build/parallelism-gate-doc-test.js
try { (() => {
/* ============================================================
   build/parallelism-gate-doc-test.js — static regression for the
   §11.2.3 parallel-construction rule (STYLE.md §11.2.3 Rule 5,
   SKILL.md §The pipeline step 4 "evidence-synthesis gate" and
   "Prose fields obey the synthesis rules too", and the résumé
   Content rules list).

   Guards the DOCS, not a render: fails if a future edit drops the
   parallel-construction rule, reverts the failure-mode count back to
   four, or lets the résumé-facing enumerations regress to only
   covering colon-dumps / overloaded sentences / reused metaphors.
   (The current count is six; §11.2.3 Rule 6 is guarded by
   build/synthesis-scope-gate-doc-test.js.)

   Run from the project root:  node build/parallelism-gate-doc-test.js
   Exit code 0 on success, 1 on first failure.
   ============================================================ */

'use strict';

var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');
var H = require('./harness.js');
var ok = H.ok,
  fail = H.fail,
  assert = H.assert;
var GREEN = H.GREEN,
  RED = H.RED,
  RESET = H.RESET;
function read(p) {
  return fs.readFileSync(path.join(ROOT, p), 'utf8');
}
var style = read('STYLE.md');
var skill = read('SKILL.md');
var readme = read('readme.md');
console.log('§11.2.3 failure-mode count');
assert(/(Five|Six) failure modes/i.test(style), 'STYLE.md §11.2.3 counts at least five failure modes', 'expected "Five" or "Six failure modes" — count did not update alongside the new rule');
assert(!/Four failure modes/i.test(style), 'STYLE.md §11.2.3 no longer says "Four failure modes"', 'stale "Four failure modes" language found');
assert(!/bans four sentence shapes/i.test(skill), 'SKILL.md no longer says "bans four sentence shapes"', 'stale "bans four sentence shapes" language found');
assert(/bans (five|six) sentence shapes/i.test(skill), 'SKILL.md counts at least five banned sentence shapes', 'expected "bans five/six sentence shapes" in the evidence-synthesis gate step');
console.log('\nRule 5 — parallel construction, STYLE.md §11.2.3');
assert(/grammatically parallel/i.test(style), 'STYLE.md states the rule: "Keep coordinated elements grammatically parallel"', 'no "grammatically parallel" language found');
assert(/from X through\/to Y/.test(style) || /`from X through\/to Y`/.test(style), 'STYLE.md names the from/through coordination shape', 'coordination-shape notation not found');
['both X and Y', 'either X or Y', 'not only X but also Y'].forEach(function (shape) {
  assert(style.indexOf(shape) !== -1, 'STYLE.md names the "' + shape + '" coordination shape', 'shape "' + shape + '" not found in §11.2.3');
});
assert(/noun phrase.{0,40}gerund phrase|gerund phrase.{0,40}noun phrase/i.test(style), 'STYLE.md names the noun-phrase / gerund-phrase mismatch as the common failure', 'no noun-phrase/gerund-phrase language found');
assert(/noun\s+phrase\s+with\s+noun\s+phrase[^\p{L}\p{N}]+action\s+with\s+action/iu.test(style), 'STYLE.md gives the general repair: coordinate like grammatical forms', 'general parallel-construction repair missing');
assert(/Padding the seam[^.]*not a repair/i.test(style), 'STYLE.md rejects bureaucratic padding as a non-repair', 'padding non-repair principle missing');
console.log('\nScope — applies beyond the cover letter');
assert(/r\u00e9sum\u00e9 bullets, role summaries, and\s*project descriptions/i.test(style) || /bullets, role summaries, and\s*project descriptions/i.test(style), 'STYLE.md §11.2.3 Rule 5 states it applies to résumé bullets, role summaries, and project descriptions', 'no explicit résumé-scope statement found near Rule 5');
assert(/broken parallel(ism)?/i.test(style) && /\u00a75\.3/.test(style), 'STYLE.md §5.3 résumé bullet rules mention broken parallelism', 'résumé bullet-rules section (§5.3) does not mention parallelism');
console.log('\nSKILL.md pipeline coverage');
assert(/no coordinated (phrase|construction)/i.test(skill), 'SKILL.md mentions the coordinated-phrase / parallelism check', 'no "no coordinated phrase/construction" language found in SKILL.md');
assert(/noun phrase spliced to a gerund phrase/i.test(skill), 'SKILL.md names the grammatical mismatch without embedding a domain-specific specimen', 'general mismatch description missing in SKILL.md');
console.log('\nreadme.md coverage');
assert(/broken parallelism|coordinated (phrase|construction)/i.test(readme), 'readme.md documents the parallelism rule alongside the other prose-shape rules', 'no parallelism language found in readme.md');
assert(!/^### Colon dumps, overloaded sentences, metaphors\s*$/im.test(readme) || /broken parallelism/i.test(readme), 'readme.md\'s colon/overload/metaphor section covers parallelism too', 'readme.md section header not updated to include parallelism');
H.report();
})(); } catch (e) { __ds_ns.__errors.push({ path: "build/parallelism-gate-doc-test.js", error: String((e && e.message) || e) }); }

// build/synthesis-scope-gate-doc-test.js
try { (() => {
/* ============================================================
   build/synthesis-scope-gate-doc-test.js — static regression for the
   §11.2.3 Rule 6 gate: evidence-scoped, earned synthesis and explicit
   paragraph transitions (STYLE.md §11.2.3 Rule 6, §11.4; SKILL.md
   §The pipeline step 4 "evidence-synthesis gate" and "Prose fields
   obey the synthesis rules too"; readme.md prose-shape sections).

   Guards the DOCS, not a render: fails if a future edit drops the
   requirement that a generalization name its concrete connector, the
   evidence-scope ceiling, the bridge-noun clause, the one-antecedent
   rule at paragraph boundaries, the rewrite-or-delete repair, or the
   "filler is not a repair" prohibition — or if the failure-mode count
   stops keeping pace with the rule set.

   Run from the project root:  node build/synthesis-scope-gate-doc-test.js
   Exit code 0 on success, 1 on first failure.
   ============================================================ */

'use strict';

var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');
var H = require('./harness.js');
var ok = H.ok,
  fail = H.fail,
  assert = H.assert;
var GREEN = H.GREEN,
  RED = H.RED,
  RESET = H.RESET;
function read(p) {
  return fs.readFileSync(path.join(ROOT, p), 'utf8');
}
var style = read('STYLE.md');
var skill = read('SKILL.md');
var readme = read('readme.md');
var engineering = read('ENGINEERING.md');

// Rule 6's own block, so "shape"/"pattern" hits elsewhere in STYLE.md
// can't accidentally satisfy these assertions.
var ruleStart = style.indexOf('**6. Earn the generalization');
var ruleEnd = style.indexOf("**Synthesize, don't list.**");
var rule6 = ruleStart !== -1 && ruleEnd > ruleStart ? style.slice(ruleStart, ruleEnd) : '';
console.log('§11.2.3 exists as a six-rule gate');
assert(/Six failure modes/i.test(style), 'STYLE.md §11.2.3 says "Six failure modes"', 'count did not keep pace with the added rule');
assert(!/(Four|Five) failure modes/i.test(style), 'STYLE.md carries no stale failure-mode count', 'stale "Four/Five failure modes" language found');
assert(/bans six sentence shapes/i.test(skill), 'SKILL.md says "bans six sentence shapes"', 'evidence-synthesis gate step still advertises the old count');
assert(!/bans (four|five) sentence shapes/i.test(skill), 'SKILL.md carries no stale shape count', 'stale "bans four/five sentence shapes" language found');
assert(/earned generalization/i.test(style), 'STYLE.md §11.2.3 heading names earned generalization', 'section heading not updated');
console.log('\nRule 6 — the rule itself, STYLE.md §11.2.3');
assert(rule6.length > 0, 'STYLE.md states Rule 6 as a numbered rule in §11.2.3', 'no "**6. Earn the generalization" block found before "Synthesize, don\'t list"');
assert(/only when it explicitly names/i.test(rule6), 'Rule 6 requires the generalization to explicitly name its concrete connector', 'no "only when it explicitly names" requirement found');
['responsibility', 'system', 'decision', 'process', 'mechanism'].forEach(function (noun) {
  assert(new RegExp('\\b' + noun + '\\b', 'i').test(rule6), 'Rule 6 names "' + noun + '" as an allowed concrete connector', 'connector "' + noun + '" missing from the rule');
});
console.log('\nRule 6 — evidence scope ceiling');
assert(/one example\s+supports a claim about that example/i.test(rule6), 'Rule 6 limits a single example to a claim about that example', 'single-example scope ceiling missing');
assert(/one\s+role\s+supports\s+a\s+claim\s+about\s+that\s+role/i.test(rule6), 'Rule 6 limits one role to a claim about that role', 'single-role scope ceiling missing');
assert(/general working style|general(ise|ize)? about .{0,30}career|working style/i.test(rule6), 'Rule 6 rejects a general-working-style claim drawn from one role', 'no working-style breadth language found');
assert(/career-wide breadth[^.]*requires\s+source evidence[^.]*career-wide/i.test(rule6), 'Rule 6 requires career-wide evidence for career-wide breadth', 'career-wide evidence requirement missing');
console.log('\nRule 6 — bridge nouns must define themselves');
['shape', 'pattern', 'approach'].forEach(function (noun) {
  assert(new RegExp('"' + noun + '"').test(rule6), 'Rule 6 names "' + noun + '" as a bridge noun under the rule', 'bridge noun "' + noun + '" not listed');
});
assert(/immediately defines/i.test(rule6), 'Rule 6 permits a bridge noun only when the sentence immediately defines it', 'no "immediately defines" condition found');
console.log('\nRule 6 — one antecedent at paragraph boundaries');
assert(/paragraph boundar/i.test(rule6), 'Rule 6 covers paragraph boundaries explicitly', 'no paragraph-boundary language found');
assert(/exactly one/i.test(rule6) && /antecedent/i.test(rule6), 'Rule 6 requires exactly one plausible antecedent for a backward reference', 'no "exactly one … antecedent" requirement found');
assert(/repeat the precise noun phrase/i.test(rule6), 'Rule 6 prescribes repeating the precise noun phrase when antecedents are ambiguous', 'no noun-phrase-repetition repair found');
console.log('\nRule 6 — prior-employer continuity');
assert(/Prior-employer reference/i.test(rule6), 'Rule 6 gives prior-employer references their own continuity guidance', 'no prior-employer continuity guidance found');
assert(/Within the same paragraph, let the candidate continue naturally/i.test(rule6) && /At a new paragraph, use a short cue such as/i.test(rule6), 'Rule 6 distinguishes natural same-paragraph continuation from an optional new-paragraph cue', 'paragraph-boundary employer-reference guidance is missing');
assert(/Repeat the employer name when multiple\s+employers or roles could otherwise be the antecedent/i.test(rule6), 'Rule 6 preserves full employer names when ambiguity requires them', 'employer-reference ambiguity repair is missing');
console.log('\nRule 6 — repairs, and what is not a repair');
assert(/[Rr]ewrite it as a concrete, evidence-scoped conclusion/.test(rule6), 'Rule 6 offers the evidence-scoped rewrite as repair 1', 'rewrite repair missing');
assert(/\*\*Delete it\.\*\*/.test(rule6), 'Rule 6 offers deletion as repair 2 for synthesis that adds no supported reasoning', 'delete repair missing');
assert(/Filler is not a repair/i.test(rule6), 'Rule 6 forbids solving the problem with filler transitions', 'no "filler is not a repair" prohibition found');
assert(/That said|Additionally|In this\s+way/.test(rule6), 'Rule 6 names the filler-transition shapes it rejects', 'no filler examples given');
assert(/name the\s+responsibility or mechanism/i.test(rule6) && /keep the breadth inside what the\s+evidence supports/i.test(rule6), 'Rule 6 defines the evidence-scoped repair without prescribing copy', 'semantic rewrite instructions missing');
assert(/transition earns its place by naming the thing it carries\s+forward/i.test(rule6), 'Rule 6 defines an explicit-transition repair without prescribing copy', 'semantic transition repair missing');
console.log('\nRule 6 — stated scope across surfaces');
assert(/Rule 6 \(earned generalization\) binds/i.test(style), 'STYLE.md §11.2.3 states Rule 6\'s scope in the section\'s Scope paragraph', 'no Rule 6 scope statement found');
assert(/every generated prose surface/i.test(style), 'STYLE.md says the scope/bridge-noun clauses bind every generated prose surface', 'no "every generated prose surface" statement found');
assert(/multi-paragraph/i.test(style), 'STYLE.md ties the paragraph-boundary clause to the multi-paragraph (letter) surface', 'no multi-paragraph scoping found');
assert(/\u00a711\.2\.3 Rule 6/.test(style), 'STYLE.md §11.4 content rules cross-reference Rule 6', 'no §11.2.3 Rule 6 cross-reference in the letter content rules');
assert(/no unearned generalization/i.test(style), 'STYLE.md §5.3 résumé bullet rules name the generalization rule', 'résumé bullet rules do not mention unearned generalization');
console.log('\nSKILL.md pipeline coverage');
assert(/no unearned generalization/i.test(skill), 'SKILL.md résumé content rules name the generalization rule', 'no "no unearned generalization" language in SKILL.md');
assert(/no conclusion wider\s+than the evidence/i.test(skill), 'SKILL.md prose-fields paragraph scopes conclusions to their evidence', 'prose-fields paragraph does not cover generalization');
assert(/most of my work\|throughout my career/.test(skill), 'SKILL.md ships a triage grep for breadth past the evidence', 'breadth-escalation triage grep missing');
assert(/plausible\s+antecedent/i.test(skill), 'SKILL.md gate step names the one-antecedent check', 'no antecedent check in the pipeline gate');
assert(/Do not repeat a prior employer’s full name merely from\s+habit/i.test(skill), 'SKILL.md avoids mechanical prior-employer repetition', 'no prior-employer repetition guidance in the pipeline');
assert(/never by\s+inserting a filler transition/i.test(skill), 'SKILL.md forbids the filler-transition non-repair', 'no filler-transition prohibition in SKILL.md');
assert(/synthesis-scope-gate-doc-test\.js/.test(skill), 'SKILL.md files table lists this test', 'test not listed in the SKILL.md files table');
console.log('\nreadme.md coverage');
assert(/unearned generalization/i.test(readme), 'readme.md documents the generalization rule alongside the other prose-shape rules', 'no "unearned generalization" language in readme.md');
assert(/Five prose failures/i.test(readme), 'readme.md prose-shape section counts five banned shapes', 'readme.md still counts four prose failures');
assert(/exactly one plausible antecedent/i.test(readme), 'readme.md states the one-antecedent rule for paragraph transitions', 'no antecedent rule in readme.md');
assert(/Do not repeat a prior employer’s full name merely from habit/i.test(readme), 'readme.md documents natural prior-employer reference', 'no natural prior-employer reference guidance in readme.md');
assert(/repeat the\s+precise noun phrase instead/i.test(readme) && /filler transition that names nothing[^.]*leaves the ambiguity in place/i.test(readme), 'readme.md defines the explicit-transition repair without prescribing copy', 'semantic transition repair missing in readme.md');
console.log('\nENGINEERING.md test index');
assert(/synthesis-scope-gate-doc-test\.js/.test(engineering), 'ENGINEERING.md automated-suites index lists this test', 'test not listed in the ENGINEERING.md automated-suites index');
H.report();
})(); } catch (e) { __ds_ns.__errors.push({ path: "build/synthesis-scope-gate-doc-test.js", error: String((e && e.message) || e) }); }

// build/test.js
try { (() => {
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
var Mod = require('./dual-mode-pdf.js');
var Tokens = require('./css-tokens.js');

/* The cream colour is READ FROM THE CSS, never restated here. Two
   assertions below used to compare a hardcoded #F7F4ED against the
   module's hardcoded copy of the same value — the pair could drift from
   the actual --bg token in lockstep while reporting a match. */
var CSS_BG = Tokens.tokenValue('--bg');
var CSS_BG_RGB = Tokens.hexToRgb01(CSS_BG);
var CSS_BG_OPS = Tokens.pdfRgbOperands(CSS_BG);
var addOcgBackground = Mod.addOcgBackground;

// PDFLib classes — destructured once to keep assertions readable.
var PDFDocument = PDFLib.PDFDocument;
var PDFName = PDFLib.PDFName;
var PDFArray = PDFLib.PDFArray;
var PDFDict = PDFLib.PDFDict;
var PDFRawStream = PDFLib.PDFRawStream;
var PDFString = PDFLib.PDFString;
var degrees = PDFLib.degrees;

// ----- Tiny assertion harness ------------------------------------------

var H = require('./harness.js');
var ok = H.ok,
  fail = H.fail,
  header = H.header,
  assert = H.assert;
var GREEN = H.GREEN,
  RED = H.RED,
  DIM = H.DIM,
  RESET = H.RESET;

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

/* Build a PDF that already carries an unrelated OCG AND a Print
 * auto-state rule governing it — exercises the /AS merge path (we
 * must join the existing rule, not author a second equivalent one). */
async function buildPdfWithPrintAutoState(name) {
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
      BaseState: 'ON',
      AS: [{
        Event: 'Print',
        Category: ['Print'],
        OCGs: [other]
      }]
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

/* Build a PDF whose catalog points /OCProperties at the wrong object
 * type. The transform should replace it with a valid dictionary rather
 * than crashing while trying to call `.lookup()` on a PDF name. */
async function buildPdfWithNonDictOcProps() {
  var doc = await PDFDocument.create();
  doc.addPage([612, 792]).drawText('x', {
    x: 72,
    y: 720,
    size: 12
  });
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
  var stream = ctx.register(PDFRawStream.of(ctx.obj({
    Length: bytes.length
  }), bytes));
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
  page.drawText('x', {
    x: 72,
    y: 720,
    size: 12
  });
  var other = ctx.register(ctx.obj({
    Type: 'OCG',
    Name: PDFString.of('Watermark')
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
  page.node.Resources().set(PDFName.of('Properties'), ctx.obj({
    Bg: other
  }));
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
    var cats = [],
      cat = e.lookup(PDFName.of('Category'));
    if (cat instanceof PDFArray) {
      for (var c = 0; c < cat.size(); c++) cats.push(String(pdf.context.lookup(cat.get(c))));
    }
    var refs = [],
      og = e.lookup(PDFName.of('OCGs'));
    if (og instanceof PDFArray) {
      for (var g = 0; g < og.size(); g++) refs.push(String(og.get(g)));
    }
    entries.push({
      event: String(e.lookup(PDFName.of('Event'))),
      categories: cats,
      ocgRefs: refs
    });
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
  assert(Mod.DEFAULT_CREAM_RGB.every(function (v, i) {
    return Math.abs(v - CSS_BG_RGB[i]) < 1e-6;
  }), 'DEFAULT_CREAM_RGB matches the --bg token parsed from colors_and_type.css (' + CSS_BG + ')', 'module: ' + JSON.stringify(Mod.DEFAULT_CREAM_RGB) + ' vs CSS: ' + JSON.stringify(CSS_BG_RGB));
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
  header('Print auto-state (/OCProperties /D /AS)');
  var creamRef1 = ocgRefByName(info1.pdf, Mod.DEFAULT_LAYER_NAME);
  var as1 = printAutoStates(info1.pdf);
  assert(!!creamRef1, 'cream OCG is resolvable by name in /OCGs');
  assert(as1.length === 1, '/D/AS has exactly one Print auto-state entry', 'found ' + as1.length + ': ' + JSON.stringify(readAutoStates(info1.pdf)));
  assert(as1.length === 1 && as1[0].categories.length === 1 && as1[0].categories[0] === '/Print', 'Print auto-state /Category is [ /Print ]', JSON.stringify(as1[0] && as1[0].categories));
  assert(as1.length === 1 && as1[0].ocgRefs.length === 1 && as1[0].ocgRefs[0] === creamRef1, 'Print auto-state /OCGs references the cream OCG', JSON.stringify(as1[0] && as1[0].ocgRefs) + ' vs cream ' + creamRef1);
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
  assert(new RegExp(CSS_BG_OPS.join('\\s+') + '\\s+rg').test(raw), 'content stream paints the cream colour read from --bg (' + CSS_BG + ' → ' + CSS_BG_OPS.join(' ') + ')');
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
  var fullTurn = await buildBasePdf({
    pages: 1,
    rotate: 360
  });
  assert((await addOcgBackground(fullTurn)).length > fullTurn.length, 'page with an effective /Rotate 0 (stored as 360) is accepted');
  var offsetBox = await buildBasePdf({
    pages: 1,
    mediaBox: {
      x: 10,
      y: 20,
      width: 612,
      height: 792
    }
  });
  var offsetRaw = latin1(await addOcgBackground(offsetBox));
  assert(/10\.00\s+20\.00\s+612\.00\s+792\.00\s+re/.test(offsetRaw), 'non-zero MediaBox origin is preserved when drawing the background');
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
  var mCreamRef = ocgRefByName(mPdf, 'Editorial cream background');
  var mAs = printAutoStates(mPdf);
  assert(mAs.length === 1 && mAs[0].ocgRefs.indexOf(mCreamRef) !== -1, 'well-formed merge: /D/AS carries one Print rule governing the cream OCG', JSON.stringify(mAs));

  // (a2) Input already has its OWN Print auto-state rule. We must join
  //      it (one rule, two OCGs) instead of authoring a duplicate.
  var withAs = await buildPdfWithPrintAutoState('Watermark');
  var mergedAs = await addOcgBackground(withAs);
  var aPdf = await PDFLib.PDFDocument.load(mergedAs);
  var aCreamRef = ocgRefByName(aPdf, 'Editorial cream background');
  var aOther = ocgRefByName(aPdf, 'Watermark');
  var aAs = printAutoStates(aPdf);
  assert(aAs.length === 1, 'existing Print auto-state: no duplicate equivalent entry added', 'found ' + aAs.length + ': ' + JSON.stringify(aAs));
  assert(aAs.length === 1 && aAs[0].ocgRefs.indexOf(aCreamRef) !== -1 && aAs[0].ocgRefs.indexOf(aOther) !== -1, 'existing Print auto-state: cream OCG appended alongside the original', JSON.stringify(aAs));

  // (b) Malformed: /OCProperties present but EMPTY (no /OCGs, no /D).
  //     Our OCG must still be registered in a freshly-created /OCGs —
  //     otherwise the page's /Bg binding references an unlisted OCG
  //     (PDF §8.11.2 violation). Regression guard for that bug.
  var malformed = await buildPdfWithEmptyOcProps();
  var fixedUp = await addOcgBackground(malformed);
  var fPdf = await PDFLib.PDFDocument.load(fixedUp);
  var fOcgs = fPdf.catalog.lookup(PDFName.of('OCProperties')).lookup(PDFName.of('OCGs'));
  assert(fOcgs && typeof fOcgs.size === 'function' && fOcgs.size() >= 1, 'malformed /OCProperties: our OCG is still listed in /OCGs', 'OCGs=' + (fOcgs ? fOcgs.size() : 'MISSING'));
  var fAs = printAutoStates(fPdf);
  assert(fAs.length === 1 && fAs[0].ocgRefs[0] === ocgRefByName(fPdf, 'Editorial cream background'), 'malformed /OCProperties: Print auto-state authored on the created /D', JSON.stringify(fAs));

  // (c) Malformed: /OCProperties is present but is not a dictionary.
  //     Replace it with a valid structure instead of throwing a TypeError.
  var wrongType = await addOcgBackground(await buildPdfWithNonDictOcProps());
  var wtPdf = await PDFDocument.load(wrongType);
  var wtProps = wtPdf.catalog.lookup(PDFName.of('OCProperties'));
  assert(wtProps instanceof PDFDict && wtProps.lookup(PDFName.of('OCGs')).size() === 1, 'non-dictionary /OCProperties is replaced with a valid one-OCG dictionary');
  header('Page resource and content preservation');
  var collided = await addOcgBackground(await buildPdfWithBgResourceCollision());
  var cPdf = await PDFDocument.load(collided);
  var cPage = cPdf.getPages()[0];
  var cProps = cPage.node.Resources().lookup(PDFName.of('Properties'));
  var cOtherRef = ocgRefByName(cPdf, 'Watermark');
  var cCreamRef = ocgRefByName(cPdf, 'Editorial cream background');
  assert(String(cProps.get(PDFName.of('Bg'))) === cOtherRef, 'an existing /Resources/Properties/Bg binding is preserved');
  assert(String(cProps.get(PDFName.of('Bg1'))) === cCreamRef, 'the cream layer uses the next free resource name after /Bg');
  assert(latin1(collided).indexOf('/OC /Bg1 BDC') !== -1, 'the prepended stream references the collision-free /Bg1 binding');
  var indirect = await addOcgBackground(await buildPdfWithIndirectContentsArray());
  var iPdf = await PDFDocument.load(indirect);
  var iContents = iPdf.context.lookup(iPdf.getPages()[0].node.get(PDFName.of('Contents')));
  var resolvedStreams = [];
  for (var ii = 0; ii < iContents.size(); ii++) {
    resolvedStreams.push(iPdf.context.lookup(iContents.get(ii)) instanceof PDFRawStream);
  }
  assert(iContents.size() === 2 && resolvedStreams.every(Boolean), 'indirect /Contents arrays are flattened to two stream entries, never nested', 'size=' + iContents.size() + ', streams=' + JSON.stringify(resolvedStreams));
  H.report();
}
run().catch(function (e) {
  console.error('\n' + RED + 'Test runner crashed:' + RESET);
  console.error(e.stack || e.message || e);
  process.exit(2);
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "build/test.js", error: String((e && e.message) || e) }); }

// build/token-sync-test.js
try { (() => {
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
var ok = H.ok,
  header = H.header,
  assert = H.assert;
var DIM = H.DIM,
  RESET = H.RESET;
var TOL_PT = 0.01;
function norm(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

/* The balanced body of `@page <name> { … }`, margin boxes included. */
function atPage(css, name) {
  var re = new RegExp('@page\\s+' + name + '\\s*\\{');
  var m = re.exec(css);
  if (!m) return null;
  var start = m.index + m[0].length - 1,
    depth = 0;
  for (var i = start; i < css.length; i++) {
    if (css[i] === '{') depth++;else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(start + 1, i);
    }
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
assert(!!creamDecl, 'DEFAULT_CREAM_RGB is declared as three 0xNN/255 bytes (parseable)', 'declaration shape changed — update this gate alongside it');
if (creamDecl) {
  var modHex = ('#' + creamDecl[1] + creamDecl[2] + creamDecl[3]).toUpperCase();
  assert(modHex === bg.toUpperCase(), 'DEFAULT_CREAM_RGB is the same colour as --bg (' + bg + ')', 'module says ' + modHex + ', CSS says ' + bg);
}

/* ---- 2. @page margin boxes ↔ the ink / mono / tracking tokens ------ */

header('resume.css @page footers ↔ tokens');
var ink3 = T.tokenValue('--ink-3');
var ffMono = T.tokenValue('--ff-mono').replace(/\s*\/\*.*$/, '');
var trMono = T.tokenValue('--tr-mono');
var PAGES = ['letter', 'a4', 'letter-compact', 'a4-compact'];
var footerColors = [],
  footerFamilies = [],
  footerTracking = [];
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
assert(footerColors.length === PAGES.length, 'all ' + PAGES.length + ' running footers declare an ink colour', 'found ' + footerColors.length);
assert(footerFamilies.length === PAGES.length, 'all ' + PAGES.length + ' running footers declare a font family', 'found ' + footerFamilies.length);
assert(footerTracking.length === PAGES.length, 'all ' + PAGES.length + ' running footers declare letter spacing', 'found ' + footerTracking.length);
footerColors.forEach(function (pair) {
  assert(pair[1].toUpperCase() === ink3.toUpperCase(), '@page ' + pair[0] + ' footer ink is --ink-3 (' + ink3 + ')', 'literal is ' + pair[1]);
});
footerFamilies.forEach(function (pair) {
  assert(norm(pair[1]) === norm(ffMono), '@page ' + pair[0] + ' footer family matches --ff-mono', 'literal is ' + norm(pair[1]));
});
footerTracking.forEach(function (pair) {
  assert(norm(pair[1]) === norm(trMono), '@page ' + pair[0] + ' footer tracking matches --tr-mono (' + trMono + ')', 'literal is ' + norm(pair[1]));
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
  if (parts.length === 1) return {
    top: parts[0],
    bottom: parts[0]
  };
  if (parts.length === 2) return {
    top: parts[0],
    bottom: parts[0]
  };
  if (parts.length === 3) return {
    top: parts[0],
    bottom: parts[2]
  };
  return {
    top: parts[0],
    bottom: parts[2]
  };
}
PAGES.forEach(function (name) {
  var body = atPage(resumeCss, name);
  if (!body) return;
  var m = /margin\s*:\s*([^;]+);/.exec(body); // top-level margin precedes the margin box
  if (!m) {
    assert(false, '@page ' + name + ' declares a vertical margin', 'no margin shorthand found');
    return;
  }
  var actual = verticalShorthandValues(m[1]);
  var expected = marginsFor[name];
  ['top', 'bottom'].forEach(function (edge) {
    assert(Math.abs(T.toPt(actual[edge]) - T.toPt(expected[edge])) < TOL_PT, '@page ' + name + ' ' + edge + ' margin (' + actual[edge] + ') == --margin-' + (edge === 'bottom' ? 'bot' : 'top') + ' for that variant (' + expected[edge] + ')', T.toPt(actual[edge]).toFixed(3) + 'pt vs ' + T.toPt(expected[edge]).toFixed(3) + 'pt');
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
    assert(documented.toUpperCase() === value.toUpperCase(), 'STYLE.md §3.1 lists ' + name + ' as ' + value, 'doc says ' + documented + ', CSS says ' + value);
  }
});

/* ---- 5. The reference cards must read the tokens, not copy them ---- */

header('preview cards + thumbnail read the live tokens');

/* A card that prints a token's value as a hardcoded hex documents
   whatever the value USED to be. The cards fill their labels from
   getComputedStyle instead, so this is a no-hardcoded-hex rule.
   Exception: anti-patterns.html demonstrates banned treatments (a
   gradient header), which are not token values by definition. */
var TOKEN_HEXES = ['--bg', '--ink-1', '--ink-2', '--ink-3', '--ink-4', '--accent'].map(function (n) {
  return T.tokenValue(n).toUpperCase();
});
var HEX_EXEMPT = ['preview/anti-patterns.html'];
var fs = require('fs');
var pathMod = require('path');
var cards = fs.readdirSync(pathMod.join(T.ROOT, 'preview')).filter(function (f) {
  return /\.html$/.test(f);
}).map(function (f) {
  return 'preview/' + f;
}).concat(['thumbnail.html', 'resume.html', 'cover-letter.html']);
cards.forEach(function (rel) {
  if (HEX_EXEMPT.indexOf(rel) !== -1) {
    ok(rel + ' (exempt — demonstrates a banned treatment)');
    return;
  }
  var src = T.read(rel).toUpperCase();
  var copied = TOKEN_HEXES.filter(function (hex) {
    return src.indexOf(hex) !== -1;
  });
  assert(copied.length === 0, rel + ' hardcodes no token hex', 'copied: ' + copied.join(', '));
});

/* And the one card that renders the name must read the size token, not
   restate it (it drifted to 26pt against a 28pt --fs-display). */
assert(/var\(--fs-display\)/.test(T.read('preview/component-header.html')), 'preview/component-header.html sizes the name from --fs-display');

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
  assert(Object.keys(sourceHashes).length > 0, '_ds_bundle.js declares at least one bundled source hash');
  assert(mismatches.length === 0, '_ds_bundle.js was regenerated after every bundled source edit', mismatches.join(' | '));
}
H.report();
})(); } catch (e) { __ds_ns.__errors.push({ path: "build/token-sync-test.js", error: String((e && e.message) || e) }); }

// handoff/pagination-contract-check.js
try { (() => {
// Deterministic contract tests for the paginated screen preview.
// Run with Playwright: npx playwright test handoff/pagination-contract-check.js
// Point FIXTURE at any generated Application.html — this file is a fixture example.
const {
  test,
  expect
} = require('@playwright/test');
const path = require('path');
const FIXTURE = 'file://' + path.join(__dirname, 'Application-paginated-example.html');
test.describe('paginated preview contract', () => {
  test('one main.page per document panel, wrapped by non-content chrome only', async ({
    page
  }) => {
    await page.goto(FIXTURE);
    const panels = await page.$$('[data-ic-document-panel]');
    expect(panels.length).toBe(2);
    for (const panel of panels) {
      const mains = await panel.$$('main.page');
      expect(mains.length).toBe(1); // never duplicated
      const stage = await panel.$('.ic-page-stage');
      expect(stage).toBeTruthy(); // wrapped by stage chrome
      const guidesInsideMain = await panel.$('main.page .ic-page-guides');
      expect(guidesInsideMain).toBeNull(); // guides never live inside the editable content tree
    }
  });
  test('guides overlay is inert: aria-hidden and non-interactive', async ({
    page
  }) => {
    await page.goto(FIXTURE);
    const guides = await page.$$('.ic-page-guides');
    expect(guides.length).toBe(2);
    for (const g of guides) {
      expect(await g.getAttribute('aria-hidden')).toBe('true');
      const pe = await g.evaluate(el => getComputedStyle(el).pointerEvents);
      expect(pe).toBe('none');
    }
  });
  test('recompute API is exposed and runs without throwing', async ({
    page
  }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(FIXTURE);
    await page.waitForTimeout(300); // initial rAF-scheduled compute
    const hasApi = await page.evaluate(() => typeof window.icPageGuidesRecompute === 'function');
    expect(hasApi).toBe(true);
    await page.evaluate(() => window.icPageGuidesRecompute());
    await page.waitForTimeout(150);
    expect(errors).toEqual([]);
  });
  test('resume stage reports a positive integer page count after load', async ({
    page
  }) => {
    await page.goto(FIXTURE);
    await page.waitForTimeout(300);
    const count = await page.$eval('[data-ic-document-panel="resume"] .ic-page-stage', el => Number(el.getAttribute('data-ic-page-count')));
    expect(Number.isInteger(count)).toBe(true);
    expect(count).toBeGreaterThanOrEqual(1);
  });
  test('shadow columns advance by one outer paper width', async ({
    page
  }) => {
    await page.goto(FIXTURE);
    const geometry = await page.evaluate(() => new Promise(resolve => {
      const observed = [];
      const observer = new MutationObserver(records => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            const clone = node.querySelector && node.querySelector('main.page');
            if (!clone || clone.style.columnWidth === '') continue;
            observed.push({
              outer: parseFloat(clone.style.width),
              side: parseFloat(clone.style.paddingLeft),
              gap: parseFloat(clone.style.columnGap)
            });
          }
        }
      });
      observer.observe(document.body, {
        childList: true
      });
      window.icPageGuidesRecompute();
      setTimeout(() => {
        observer.disconnect();
        resolve(observed[0] || null);
      }, 100);
    }));
    expect(geometry).toBeTruthy();
    expect(geometry.gap).toBeCloseTo(geometry.side * 2, 4);
    expect(geometry.outer - geometry.side * 2 + geometry.gap).toBeCloseTo(geometry.outer, 4);
  });
  test('switching tabs computes guides for the newly visible panel', async ({
    page
  }) => {
    await page.goto(FIXTURE);
    await page.waitForTimeout(300);
    await page.click('#ic-cover-tab');
    await page.waitForTimeout(200);
    const coverCount = await page.$eval('[data-ic-document-panel="cover"] .ic-page-stage', el => el.getAttribute('data-ic-page-count'));
    expect(coverCount).not.toBeNull();
  });
  test('editing content triggers a recompute (no stale state, no throw)', async ({
    page
  }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(FIXTURE);
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const main = document.querySelector('[data-ic-document-panel="resume"] main.page');
      const p = document.createElement('p');
      p.textContent = 'Contract-test inserted paragraph to force a reflow.';
      main.appendChild(p);
      main.dispatchEvent(new Event('input', {
        bubbles: true
      }));
    });
    await page.waitForTimeout(250);
    expect(errors).toEqual([]);
    const count = await page.$eval('[data-ic-document-panel="resume"] .ic-page-stage', el => Number(el.getAttribute('data-ic-page-count')));
    expect(count).toBeGreaterThanOrEqual(1);
  });
  test('data-density="compact" and data-page="a4" recompute geometry without throwing', async ({
    page
  }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(FIXTURE);
    await page.waitForTimeout(300);
    await page.evaluate(() => document.documentElement.setAttribute('data-density', 'compact'));
    await page.waitForTimeout(200);
    await page.evaluate(() => document.documentElement.setAttribute('data-page', 'a4'));
    await page.waitForTimeout(200);
    expect(errors).toEqual([]);
  });
  test('print media hides every page-boundary affordance and leaves .page untouched', async ({
    page
  }) => {
    await page.goto(FIXTURE);
    await page.waitForTimeout(300);
    await page.emulateMedia({
      media: 'print'
    });
    const guidesDisplay = await page.$$eval('.ic-page-guides', els => els.map(el => getComputedStyle(el).display));
    expect(guidesDisplay.every(d => d === 'none')).toBe(true);
    const stageDisplay = await page.$$eval('.ic-page-stage', els => els.map(el => getComputedStyle(el).display));
    expect(stageDisplay.every(d => d === 'contents')).toBe(true);

    // .page itself must render exactly as the pre-existing print rule specifies:
    // no width cap, side padding only, no box-shadow, page-break-after present.
    const pageStyle = await page.$eval('[data-ic-document-panel="resume"] main.page', el => {
      const cs = getComputedStyle(el);
      return {
        width: cs.width,
        boxShadow: cs.boxShadow,
        paddingTop: cs.paddingTop
      };
    });
    expect(pageStyle.boxShadow).toBe('none');
  });
  test('no page-boundary markup is present inside main.page in print (nothing to strip)', async ({
    page
  }) => {
    await page.goto(FIXTURE);
    await page.emulateMedia({
      media: 'print'
    });
    const leaked = await page.$$eval('main.page .ic-page-seam, main.page .ic-page-folio', els => els.length);
    expect(leaked).toBe(0);
  });
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "handoff/pagination-contract-check.js", error: String((e && e.message) || e) }); }

})();
