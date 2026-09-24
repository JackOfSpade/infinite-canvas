/* ============================================================
   build/bullet-redundancy-gate-doc-test.js — static regression for
   the one-accomplishment-one-bullet rule (STYLE.md §5.3, SKILL.md
   "## Do not let one bullet restate another" + its negative-space
   line, readme.md "### Bullet ordering: relevance to the job, not
   chronology").

   Guards the DOCS, not a render: fails if a future edit drops the
   rule that two bullets reporting one accomplishment's build,
   deployment, or feature must be combined into one bullet; the
   explicit cross-reference to SKILL.md's "Do not let a project
   section restate the bullets" test (the same carries-something-
   no-other-entry-carries test applied bullet-to-bullet instead of
   project-to-bullet-corpus); the "subject is the previous bullet's
   object" tell; or the rule that a short page is repaired with an
   unused accomplishment, never a split bullet.

   Assertions run against whitespace-normalized text (line wraps
   collapsed to single spaces) so a future rewrap of the prose can't
   break the gate on its own.

   Run from the project root:  node build/bullet-redundancy-gate-doc-test.js
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
function norm(s) { return s.replace(/\s+/g, ' '); }

var skill = read('SKILL.md');
var style = read('STYLE.md');
var readme = read('readme.md');
var engineering = read('ENGINEERING.md');

var skillN = norm(skill);
var styleN = norm(style);
var readmeN = norm(readme);

console.log('SKILL.md — "## Do not let one bullet restate another"');
assert(/## Do not let one bullet restate another/.test(skillN),
  'SKILL.md carries the "Do not let one bullet restate another" section',
  'section heading missing from SKILL.md');
assert(/One accomplishment, one bullet\./.test(skillN),
  'SKILL.md states "One accomplishment, one bullet." as its own rule',
  'the one-accomplishment-one-bullet rule sentence is missing from SKILL.md');
assert(/applies to a project entry against the bullet corpus, applied here bullet-to-bullet within one role/.test(skillN),
  'SKILL.md explicitly ties the new rule to the project-restatement test, applied bullet-to-bullet',
  'no explicit cross-reference from the new section to "Do not let a project section restate the bullets"');
assert(/subject is the previous bullet's object/.test(skillN),
  'SKILL.md names the "subject is the previous bullet\'s object" tell',
  'the previous-bullet-object symptom check is missing from SKILL.md');
assert(/internal-tools hub/.test(skillN),
  'SKILL.md cites the shipped internal-tools-hub case as the worked example',
  'the internal-tools-hub example is missing from SKILL.md');
assert(/Splitting a bullet is never the repair for a short page/i.test(skillN),
  'SKILL.md states that splitting a bullet is never the repair for a short page',
  'no "never the repair for a short page" language found in SKILL.md');
assert(/74\.1%/.test(skillN),
  'SKILL.md cites the measured 74.1% type-area figure from the real case',
  'the 74.1% figure is missing from SKILL.md');

console.log('\nSKILL.md — negative-space line');
var negSpaceStart = skillN.indexOf('## Negative space');
var negSpace = negSpaceStart !== -1 ? skillN.slice(negSpaceStart, negSpaceStart + 1200) : '';
assert(/No bullet whose accomplishment already appears, in whole or in part, in another bullet in the same role/.test(negSpace),
  'SKILL.md negative-space checklist bans a bullet whose accomplishment repeats another bullet\'s',
  'negative-space line for bullet-to-bullet redundancy missing near "## Negative space"');

console.log('\nSTYLE.md §5.3 — the rule itself');
var s53Start = styleN.indexOf('### 5.3 Bullet conventions');
var s53End = styleN.indexOf('### 5.3.1');
var section53 = s53Start !== -1 && s53End > s53Start ? styleN.slice(s53Start, s53End) : '';
assert(section53.length > 0, 'STYLE.md §5.3 section is found', '§5.3 Bullet conventions section not found');
assert(/\*\*One accomplishment, one bullet\.\*\*/.test(section53),
  'STYLE.md §5.3 states "One accomplishment, one bullet." as a bulleted rule',
  'the one-accomplishment-one-bullet rule is missing from STYLE.md §5.3');
assert(/combine them into a single bullet whose trailing clause carries the supporting mechanism/.test(section53),
  'STYLE.md §5.3 prescribes combining redundant bullets with a trailing supporting clause',
  'the combine-into-one-bullet repair is missing from STYLE.md §5.3');
assert(/Do not let one bullet restate another/.test(section53),
  'STYLE.md §5.3 cross-references SKILL.md\'s "Do not let one bullet restate another"',
  'no cross-reference to SKILL.md\'s new section found in STYLE.md §5.3');
assert(/subject is the previous bullet's object/.test(section53),
  'STYLE.md §5.3 names the "subject is the previous bullet\'s object" tell',
  'the previous-bullet-object symptom check is missing from STYLE.md §5.3');
assert(/is padding, never a repair for a short page/.test(section53),
  'STYLE.md §5.3 ties the rule to the general never-pad-a-page principle',
  'no "padding, never a repair for a short page" language found in STYLE.md §5.3');
assert(/source-supported accomplishment the page doesn't carry yet/.test(section53),
  'STYLE.md §5.3 still prescribes a source-supported accomplishment as the repair',
  'the source-supported-accomplishment repair is missing from STYLE.md §5.3');

console.log('\nreadme.md — "Bullet ordering" section');
var roStart = readmeN.indexOf('### Bullet ordering: relevance to the job, not chronology');
var roEnd = readmeN.indexOf('### Cover letter opening');
var roSection = roStart !== -1 && roEnd > roStart ? readmeN.slice(roStart, roEnd) : '';
assert(roSection.length > 0, 'readme.md "Bullet ordering" section is found',
  '"### Bullet ordering: relevance to the job, not chronology" section not found');
assert(/One accomplishment gets one bullet/.test(roSection),
  'readme.md states "One accomplishment gets one bullet" in the Bullet ordering section',
  'the one-accomplishment-one-bullet statement is missing from readme.md');
assert(/Do not let a project section restate the bullets/.test(roSection),
  'readme.md cross-references SKILL.md\'s "Do not let a project section restate the bullets"',
  'no cross-reference to the project-restatement test found in readme.md');
assert(/internal-tools hub/.test(roSection),
  'readme.md cites the shipped internal-tools-hub case as the worked example',
  'the internal-tools-hub example is missing from readme.md');
assert(/subject is the previous bullet's object/.test(roSection),
  'readme.md names the "subject is the previous bullet\'s object" tell',
  'the previous-bullet-object symptom check is missing from readme.md');
assert(/never the fix for a short page/.test(roSection),
  'readme.md states splitting a bullet is never the fix for a short page',
  'no "never the fix for a short page" language found in readme.md');

console.log('\nENGINEERING.md test index');
assert(/bullet-redundancy-gate-doc-test\.js/.test(engineering),
  'ENGINEERING.md automated-suites index lists this test',
  'test not listed in the ENGINEERING.md automated-suites index');

console.log('\nSKILL.md files table');
assert(/build\/bullet-redundancy-gate-doc-test\.js/.test(skillN),
  'SKILL.md files table lists this test',
  'test not listed in the SKILL.md files table');

H.report();
