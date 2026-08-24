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
var ok = H.ok, fail = H.fail, assert = H.assert;
var GREEN = H.GREEN, RED = H.RED, RESET = H.RESET;

function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

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
assert(/Six failure modes/i.test(style), 'STYLE.md §11.2.3 says "Six failure modes"',
  'count did not keep pace with the added rule');
assert(!/(Four|Five) failure modes/i.test(style), 'STYLE.md carries no stale failure-mode count',
  'stale "Four/Five failure modes" language found');
assert(/bans six sentence shapes/i.test(skill), 'SKILL.md says "bans six sentence shapes"',
  'evidence-synthesis gate step still advertises the old count');
assert(!/bans (four|five) sentence shapes/i.test(skill), 'SKILL.md carries no stale shape count',
  'stale "bans four/five sentence shapes" language found');
assert(/earned generalization/i.test(style), 'STYLE.md §11.2.3 heading names earned generalization',
  'section heading not updated');

console.log('\nRule 6 — the rule itself, STYLE.md §11.2.3');
assert(rule6.length > 0, 'STYLE.md states Rule 6 as a numbered rule in §11.2.3',
  'no "**6. Earn the generalization" block found before "Synthesize, don\'t list"');
assert(/only when it explicitly names/i.test(rule6),
  'Rule 6 requires the generalization to explicitly name its concrete connector',
  'no "only when it explicitly names" requirement found');
['responsibility', 'system', 'decision', 'process', 'mechanism'].forEach(function (noun) {
  assert(new RegExp('\\b' + noun + '\\b', 'i').test(rule6),
    'Rule 6 names "' + noun + '" as an allowed concrete connector',
    'connector "' + noun + '" missing from the rule');
});

console.log('\nRule 6 — evidence scope ceiling');
assert(/one example\s+supports a claim about that example/i.test(rule6),
  'Rule 6 limits a single example to a claim about that example',
  'single-example scope ceiling missing');
assert(/one\s+role\s+supports\s+a\s+claim\s+about\s+that\s+role/i.test(rule6),
  'Rule 6 limits one role to a claim about that role',
  'single-role scope ceiling missing');
assert(/general working style|general(ise|ize)? about .{0,30}career|working style/i.test(rule6),
  'Rule 6 rejects a general-working-style claim drawn from one role',
  'no working-style breadth language found');
assert(/career-wide breadth[^.]*requires\s+source evidence[^.]*career-wide/i.test(rule6),
  'Rule 6 requires career-wide evidence for career-wide breadth',
  'career-wide evidence requirement missing');

console.log('\nRule 6 — bridge nouns must define themselves');
['shape', 'pattern', 'approach'].forEach(function (noun) {
  assert(new RegExp('"' + noun + '"').test(rule6),
    'Rule 6 names "' + noun + '" as a bridge noun under the rule',
    'bridge noun "' + noun + '" not listed');
});
assert(/immediately defines/i.test(rule6),
  'Rule 6 permits a bridge noun only when the sentence immediately defines it',
  'no "immediately defines" condition found');

console.log('\nRule 6 — one antecedent at paragraph boundaries');
assert(/paragraph boundar/i.test(rule6), 'Rule 6 covers paragraph boundaries explicitly',
  'no paragraph-boundary language found');
assert(/exactly one/i.test(rule6) && /antecedent/i.test(rule6),
  'Rule 6 requires exactly one plausible antecedent for a backward reference',
  'no "exactly one … antecedent" requirement found');
assert(/repeat the precise noun phrase/i.test(rule6),
  'Rule 6 prescribes repeating the precise noun phrase when antecedents are ambiguous',
  'no noun-phrase-repetition repair found');

console.log('\nRule 6 — repairs, and what is not a repair');
assert(/[Rr]ewrite it as a concrete, evidence-scoped conclusion/.test(rule6),
  'Rule 6 offers the evidence-scoped rewrite as repair 1', 'rewrite repair missing');
assert(/\*\*Delete it\.\*\*/.test(rule6),
  'Rule 6 offers deletion as repair 2 for synthesis that adds no supported reasoning',
  'delete repair missing');
assert(/Filler is not a repair/i.test(rule6),
  'Rule 6 forbids solving the problem with filler transitions',
  'no "filler is not a repair" prohibition found');
assert(/That said|Additionally|In this\s+way/.test(rule6),
  'Rule 6 names the filler-transition shapes it rejects', 'no filler examples given');
assert(/name the\s+responsibility or mechanism/i.test(rule6) &&
  /keep the breadth inside what the\s+evidence supports/i.test(rule6),
  'Rule 6 defines the evidence-scoped repair without prescribing copy',
  'semantic rewrite instructions missing');
assert(/transition earns its place by naming the thing it carries\s+forward/i.test(rule6),
  'Rule 6 defines an explicit-transition repair without prescribing copy',
  'semantic transition repair missing');

console.log('\nRule 6 — stated scope across surfaces');
assert(/Rule 6 \(earned generalization\) binds/i.test(style),
  'STYLE.md §11.2.3 states Rule 6\'s scope in the section\'s Scope paragraph',
  'no Rule 6 scope statement found');
assert(/every generated prose surface/i.test(style),
  'STYLE.md says the scope/bridge-noun clauses bind every generated prose surface',
  'no "every generated prose surface" statement found');
assert(/multi-paragraph/i.test(style),
  'STYLE.md ties the paragraph-boundary clause to the multi-paragraph (letter) surface',
  'no multi-paragraph scoping found');
assert(/\u00a711\.2\.3 Rule 6/.test(style),
  'STYLE.md §11.4 content rules cross-reference Rule 6',
  'no §11.2.3 Rule 6 cross-reference in the letter content rules');
assert(/no unearned generalization/i.test(style),
  'STYLE.md §5.3 résumé bullet rules name the generalization rule',
  'résumé bullet rules do not mention unearned generalization');

console.log('\nSKILL.md pipeline coverage');
assert(/no unearned generalization/i.test(skill),
  'SKILL.md résumé content rules name the generalization rule',
  'no "no unearned generalization" language in SKILL.md');
assert(/no conclusion wider\s+than the evidence/i.test(skill),
  'SKILL.md prose-fields paragraph scopes conclusions to their evidence',
  'prose-fields paragraph does not cover generalization');
assert(/most of my work\|throughout my career/.test(skill),
  'SKILL.md ships a triage grep for breadth past the evidence',
  'breadth-escalation triage grep missing');
assert(/plausible\s+antecedent/i.test(skill),
  'SKILL.md gate step names the one-antecedent check',
  'no antecedent check in the pipeline gate');
assert(/never by\s+inserting a filler transition/i.test(skill),
  'SKILL.md forbids the filler-transition non-repair',
  'no filler-transition prohibition in SKILL.md');
assert(/synthesis-scope-gate-doc-test\.js/.test(skill),
  'SKILL.md files table lists this test', 'test not listed in the SKILL.md files table');

console.log('\nreadme.md coverage');
assert(/unearned generalization/i.test(readme),
  'readme.md documents the generalization rule alongside the other prose-shape rules',
  'no "unearned generalization" language in readme.md');
assert(/Five prose failures/i.test(readme),
  'readme.md prose-shape section counts five banned shapes',
  'readme.md still counts four prose failures');
assert(/exactly one plausible antecedent/i.test(readme),
  'readme.md states the one-antecedent rule for paragraph transitions',
  'no antecedent rule in readme.md');
assert(/repeat the\s+precise noun phrase instead/i.test(readme) &&
  /filler transition that names nothing[^.]*leaves the ambiguity in place/i.test(readme),
  'readme.md defines the explicit-transition repair without prescribing copy',
  'semantic transition repair missing in readme.md');

console.log('\nENGINEERING.md test index');
assert(/synthesis-scope-gate-doc-test\.js/.test(engineering),
  'ENGINEERING.md automated-suites index lists this test', 'test not listed in the ENGINEERING.md automated-suites index');

H.report();
