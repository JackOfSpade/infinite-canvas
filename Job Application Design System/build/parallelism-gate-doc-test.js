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
var ok = H.ok, fail = H.fail, assert = H.assert;
var GREEN = H.GREEN, RED = H.RED, RESET = H.RESET;

function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

var style = read('STYLE.md');
var skill = read('SKILL.md');
var readme = read('readme.md');

console.log('§11.2.3 failure-mode count');
assert(/(Five|Six) failure modes/i.test(style), 'STYLE.md §11.2.3 counts at least five failure modes',
  'expected "Five" or "Six failure modes" — count did not update alongside the new rule');
assert(!/Four failure modes/i.test(style), 'STYLE.md §11.2.3 no longer says "Four failure modes"',
  'stale "Four failure modes" language found');
assert(!/bans four sentence shapes/i.test(skill), 'SKILL.md no longer says "bans four sentence shapes"',
  'stale "bans four sentence shapes" language found');
assert(/bans (five|six) sentence shapes/i.test(skill), 'SKILL.md counts at least five banned sentence shapes',
  'expected "bans five/six sentence shapes" in the evidence-synthesis gate step');

console.log('\nRule 5 — parallel construction, STYLE.md §11.2.3');
assert(/grammatically parallel/i.test(style), 'STYLE.md states the rule: "Keep coordinated elements grammatically parallel"',
  'no "grammatically parallel" language found');
assert(/from X through\/to Y/.test(style) || /`from X through\/to Y`/.test(style),
  'STYLE.md names the from/through coordination shape', 'coordination-shape notation not found');
['both X and Y', 'either X or Y', 'not only X but also Y'].forEach(function (shape) {
  assert(style.indexOf(shape) !== -1, 'STYLE.md names the "' + shape + '" coordination shape',
    'shape "' + shape + '" not found in §11.2.3');
});
assert(/noun phrase.{0,40}gerund phrase|gerund phrase.{0,40}noun phrase/i.test(style),
  'STYLE.md names the noun-phrase / gerund-phrase mismatch as the common failure',
  'no noun-phrase/gerund-phrase language found');
assert(/noun\s+phrase\s+with\s+noun\s+phrase[^\p{L}\p{N}]+action\s+with\s+action/iu.test(style),
  'STYLE.md gives the general repair: coordinate like grammatical forms',
  'general parallel-construction repair missing');
assert(/Padding the seam[^.]*not a repair/i.test(style),
  'STYLE.md rejects bureaucratic padding as a non-repair',
  'padding non-repair principle missing');

console.log('\nScope — applies beyond the cover letter');
assert(/r\u00e9sum\u00e9 bullets, role summaries, and\s*project descriptions/i.test(style) ||
  /bullets, role summaries, and\s*project descriptions/i.test(style),
  'STYLE.md §11.2.3 Rule 5 states it applies to résumé bullets, role summaries, and project descriptions',
  'no explicit résumé-scope statement found near Rule 5');
assert(/broken parallel(ism)?/i.test(style) && /\u00a75\.3/.test(style),
  'STYLE.md §5.3 résumé bullet rules mention broken parallelism',
  'résumé bullet-rules section (§5.3) does not mention parallelism');

console.log('\nSKILL.md pipeline coverage');
assert(/no coordinated (phrase|construction)/i.test(skill),
  'SKILL.md mentions the coordinated-phrase / parallelism check',
  'no "no coordinated phrase/construction" language found in SKILL.md');
assert(/noun phrase spliced to a gerund phrase/i.test(skill),
  'SKILL.md names the grammatical mismatch without embedding a domain-specific specimen',
  'general mismatch description missing in SKILL.md');

console.log('\nreadme.md coverage');
assert(/broken parallelism|coordinated (phrase|construction)/i.test(readme),
  'readme.md documents the parallelism rule alongside the other prose-shape rules',
  'no parallelism language found in readme.md');
assert(!/^### Colon dumps, overloaded sentences, metaphors\s*$/im.test(readme) ||
  /broken parallelism/i.test(readme),
  'readme.md\'s colon/overload/metaphor section covers parallelism too',
  'readme.md section header not updated to include parallelism');

H.report();
