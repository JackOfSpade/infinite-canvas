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
var ok = H.ok, fail = H.fail, assert = H.assert;
var GREEN = H.GREEN, RED = H.RED, RESET = H.RESET;

function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

var skill = read('SKILL.md');
var style = read('STYLE.md');
var readme = read('CONTENT_RULES.md');

// ---- forbidden: title-based / two-page-default language ----------------
var FORBIDDEN = [
  [/2\s+for\s+principal/i, 'SKILL.md'],
  [/1\.4\s+pages/i, 'STYLE.md'],
  [/2\.0\s+pages/i, 'STYLE.md'],
  [/does not\*\* compress content to fit one page/i, 'STYLE.md'],
  [/staff\+\s+candidates have content/i, 'STYLE.md'],
  [/not a one-pager/i, 'STYLE.md'],
];
FORBIDDEN.forEach(function (pair) {
  var re = pair[0], file = pair[1];
  var text = file === 'SKILL.md' ? skill : file === 'STYLE.md' ? style : readme;
  assert(!re.test(text), file + ' no longer contains ' + re,
    'found forbidden title/two-page-default language matching ' + re);
});

// ---- required: one-page default + explicit-override language ----------
console.log('');
assert(/one page.{0,40}default/i.test(skill) || /default.{0,40}one page/i.test(skill),
  'SKILL.md states one page is the default', 'no "one page ... default" language found');
/* Proximity, not two independent word searches: the previous version
   passed as long as "explicit" and "override" each appeared anywhere in
   the file, so deleting the sentence it guards changed nothing. */
assert(/explicit(ly)?[^.\n]{0,140}(override|request(ed|s)?)/i.test(skill) ||
       /(override|request(ed|s)?)[^.\n]{0,140}explicit(ly)?/i.test(skill),
  'SKILL.md ties multi-page to an explicit override/request in one sentence',
  'no sentence pairs "explicit" with "override"/"requested"');
assert(/absent that explicit override/i.test(skill),
  'SKILL.md keeps the "absent that explicit override, one page" clause',
  'the clause the one-page default rests on is gone');
assert(/never infer/i.test(skill) || /never.{0,20}inferred/i.test(skill),
  'SKILL.md bans inferring page count from title', 'no "never infer[red]" language found');
['Senior Staff', 'Principal', 'Director', 'VP', 'executive'].forEach(function (term) {
  assert(skill.indexOf(term) !== -1, 'SKILL.md names "' + term + '" as a non-signal for page count',
    'title term "' + term + '" not found near the page-count rule');
});

console.log('');
assert(/one well-filled page/i.test(style) || /one page.{0,40}default/i.test(style),
  'STYLE.md §6 states one well-filled page is the default shape', 'no matching language found in STYLE.md §6');
assert(/explicit host\/user override|explicit.{0,20}override/i.test(style),
  'STYLE.md frames multi-page as an explicit-override case', 'no "explicit ... override" language found');
assert(/retain(ing)? every documented role/i.test(style) || /every documented role/i.test(style),
  'STYLE.md requires retaining every documented role when cutting', 'no "every documented role" language found');
assert(/at least one factual\s+bullet per role/i.test(style),
  'STYLE.md requires at least one factual bullet per role', 'no "at least one factual bullet per role" language found');

console.log('');
assert(/length is \*\*one page\*\*/i.test(style),
  'STYLE.md §11.4 still requires the cover letter to be one page', 'cover-letter one-page rule missing');

H.report();
