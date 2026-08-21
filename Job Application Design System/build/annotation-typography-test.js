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

var fs   = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');

var H = require('./harness.js');
var ok = H.ok, fail = H.fail, header = H.header, assert = H.assert;
var GREEN = H.GREEN, RED = H.RED, DIM = H.DIM, RESET = H.RESET;

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
assert(missingByClass.length === 0,
  'each annotation class inherits the parent bullet type explicitly (' + REQUIRED_INHERITS.join(', ') + ')',
  'not inherited: ' + missingByClass.join(', '));

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

/* 5. Bullet-body <strong>/<b> render at the bullet's own weight — no
      inline emphasis inside .highlights li (STYLE.md §5.4.1). The tags
      stay in the markup (the host app keys off them, and any
      data-achievement-id, as semantic metadata) but must resolve to
      `inherit` for font-weight and color, scoped to .highlights li only. */
var highlightsBoldRules = parseRules(resumeCss).filter(function (r) {
  return /\.highlights\s+li\b/.test(r.selector) &&
    (selectorTargetsTag(r.selector, 'b') || selectorTargetsTag(r.selector, 'strong'));
});
assert(highlightsBoldRules.length > 0,
  'resume.css has a .highlights li b/strong override rule',
  'no rule matched .highlights li b / .highlights li strong');

var highlightsBoldOffenders = [];
highlightsBoldRules.forEach(function (r) {
  declarations(r.body).forEach(function (d) {
    if ((d.prop === 'font-weight' || d.prop === 'color') && !isInherit(d.value)) {
      highlightsBoldOffenders.push(r.selector + ' { ' + d.prop + ': ' + d.value + ' }');
    }
  });
});
assert(highlightsBoldOffenders.length === 0,
  '.highlights li b/strong sets font-weight and color to inherit only',
  highlightsBoldOffenders.join('  |  '));

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
assert(highlightsMissing.length === 0,
  '.highlights li b and strong each explicitly inherit font-weight and color',
  'not inherited: ' + highlightsMissing.join(', '));

/* Structural/global bold is untouched: the base rule (name, role title,
   employer, project name) and the cover letter's own rule still set a
   real weight, not inherit — this decision is scoped to résumé bullets. */
var globalStrongRules = parseRules(read('colors_and_type.css'))
  .filter(function (r) { return /(^|[\s,])(b|strong)(?![\w-])/.test(r.selector); });
assert(globalStrongRules.some(function (r) {
  return declarations(r.body).some(function (d) { return d.prop === 'font-weight' && !isInherit(d.value); });
}), 'global b, strong rule (colors_and_type.css) still sets its own weight');

var letterStrongRules = parseRules(read('cover-letter.css')).filter(function (r) { return /\bstrong\b/.test(r.selector); });
assert(letterStrongRules.some(function (r) {
  return declarations(r.body).some(function (d) { return d.prop === 'font-weight' && !isInherit(d.value); });
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
  assert(/class="(scope|tradeoff|annotation-label)"/.test(read(rel)),
    rel + ' still demonstrates an annotation span');
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

H.report();
