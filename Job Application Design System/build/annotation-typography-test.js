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

var fs   = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');

var GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', RESET = '\x1b[0m';
var passed = 0, failed = 0, failures = [];

function ok(name)      { console.log('  ' + GREEN + '✓' + RESET + ' ' + name); passed++; }
function fail(name, m) { console.log('  ' + RED + '✗' + RESET + ' ' + name + ' — ' + m); failed++; failures.push(name); }
function header(s)     { console.log('\n' + s); }
function assert(cond, name, msg) { if (cond) ok(name); else fail(name, msg || 'assertion failed'); }

/* The classes under guard, and the properties that would break a
   continuous read if they took any value other than `inherit`. */
var ANNOTATION_CLASSES = ['scope', 'tradeoff', 'annotation-label'];
var GUARDED_PROPS = ['font', 'font-family', 'font-size', 'font-style',
                     'font-weight', 'font-variant', 'line-height',
                     'letter-spacing', 'word-spacing', 'color'];
/* Every guarded longhand must be pinned to the parent bullet. `font`
   (shorthand) is accepted in place of the individual font longhands. */
var REQUIRED_INHERITS = ['font-family', 'font-size', 'font-style',
                         'font-weight', 'letter-spacing', 'color'];

/* Strip comments, then split into { selector, decls } rule objects.
   Deliberately naive — enough for these hand-written stylesheets, and
   it never has to resolve the cascade: the contract is "no rule in the
   system gives these classes a non-inherit value", which is a purely
   textual property. @media / @page blocks are flattened by pulling out
   their inner rules. */
function parseRules(css) {
  var src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  var rules = [], re = /([^{}]+)\{([^{}]*)\}/g, m;
  while ((m = re.exec(src)) !== null) {
    var sel = m[1].replace(/\s+/g, ' ').trim();
    if (!sel || sel.charAt(0) === '@') continue;      // at-rule preamble
    rules.push({ selector: sel, body: m[2] });
  }
  return rules;
}

function declarations(body) {
  return body.split(';').map(function (d) { return d.trim(); })
    .filter(Boolean)
    .map(function (d) {
      var i = d.indexOf(':');
      if (i === -1) return null;
      return { prop: d.slice(0, i).trim().toLowerCase(), value: d.slice(i + 1).trim() };
    })
    .filter(Boolean);
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

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

/* ---- the source of truth: the résumé stylesheet -------------------- */

header(DIM + 'inline annotation typography' + RESET + '\nresume.css — the annotation rule');

var resumeCss = read('resume.css');
var resumeRules = annotationRules(parseRules(resumeCss));

assert(resumeRules.length > 0, 'resume.css still styles the annotation classes (rule present)',
  'no rule matched .scope / .tradeoff / .annotation-label');

/* 1. Every guarded property that IS declared must be `inherit`. */
var offenders = [];
resumeRules.forEach(function (r) {
  declarations(r.body).forEach(function (d) {
    if (GUARDED_PROPS.indexOf(d.prop) !== -1 && !isInherit(d.value)) {
      offenders.push(r.selector + ' { ' + d.prop + ': ' + d.value + ' }');
    }
  });
});
assert(offenders.length === 0,
  'no font-size / font-style / font-family / color / tracking override on the annotation classes',
  offenders.join('  |  '));

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
assert(missing.length === 0,
  'annotation spans inherit the parent bullet type explicitly (' + REQUIRED_INHERITS.join(', ') + ')',
  'not inherited: ' + missing.join(', '));

/* 3. The specific bug this test exists for: italic on .tradeoff. */
var italic = resumeRules.filter(function (r) {
  return /\.tradeoff(?![\w-])/.test(r.selector) &&
    declarations(r.body).some(function (d) {
      return d.prop === 'font-style' && /italic|oblique/i.test(d.value);
    });
});
assert(italic.length === 0, '.tradeoff does not apply italic styling',
  italic.map(function (r) { return r.selector; }).join(', '));

/* 4. No caption token smuggled in by name. */
assert(!/\.(scope|tradeoff|annotation-label)[^{}]*\{[^{}]*--fs-caption/.test(
        resumeCss.replace(/\/\*[\s\S]*?\*\//g, '')),
  'annotation classes do not reference --fs-caption');

/* 5. <strong> in a bullet is NOT part of this contract — genuine metrics
      keep their weight. Guard against an over-broad "inherit everything"
      fix that flattens them too. */
var strongRules = parseRules(resumeCss).concat(parseRules(read('cover-letter.css')))
  .filter(function (r) { return /\bstrong\b/.test(r.selector); });
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
var STALE = [
  ['STYLE.md', 'italic `--ink-meta`'],
  ['STYLE.md', 'scope chip, trade-off note'],
  ['SKILL.md', 'annotation** (italic'],
  ['colors_and_type.css', 'scope chip, tradeoff note']
];
STALE.forEach(function (pair) {
  assert(read(pair[0]).indexOf(pair[1]) === -1,
    pair[0] + ' no longer says "' + pair[1] + '"');
});
/* And the replacement claim is actually documented. */
assert(/inherit the owning\s+bullet's/i.test(read('STYLE.md').replace(/[’']/g, "'")),
  'STYLE.md §5.4 states the spans inherit the owning bullet’s type');

console.log('\n' + (failed === 0 ? GREEN : RED) + passed + ' passed, ' + failed + ' failed' + RESET);
if (failed > 0) {
  console.log(RED + 'Failures: ' + failures.join(', ') + RESET);
  process.exit(1);
}
