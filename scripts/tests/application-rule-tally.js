import {
  SAME_RULE_STOP_LIMIT, canonicalAnswerSha256, cleanRuleTally, clearRuleTallyFamily, clearRuleTallyStep,
  emptyRuleTally, normalizedObservationFingerprint, recordRuleRejection, ruleTallyEscalationRuns,
  ruleTallyFamily, ruleTallyLastRoundIds, runBudgetTerminal, sameRuleStopTerminal, summarizeRuleTally,
  terminalStopSummary, unchangedNotice,
} from '../test-dependencies.js';
import assert from 'node:assert/strict';
const sha = canonicalAnswerSha256({ rawText: 'synthetic answer' });
const observe = (tally, ids, subject = 'candidate-1') => recordRuleRejection(tally, { family: 'fact-check', subject,
  rules: ids.map(id => ({ id, fingerprint: id === 'schema-invalid' ? '12345678' : '' })), answerSha256: sha });
export default [
  { name: 'Application rule tally: cumulative rules and consecutive ids are independent', run() {
    let value = observe(emptyRuleTally(), ['rule-a']);
    assert.equal(value.unchanged, false);
    value = observe(value.tally, ['rule-b']);
    assert.equal(value.unchanged, true);
    value = observe(value.tally, ['rule-a']);
    assert.deepEqual(value.rules, [{ key: 'rule-a', id: 'rule-a', n: 2, run: 1 }]);
    assert.deepEqual(ruleTallyEscalationRuns(value.tally, 'fact-check', 'candidate-1'), { 'rule-a': 1 });
    assert.equal(value.stop, null);
    for (let i = 0; i < 3; i++) value = observe(value.tally, ['rule-a']);
    assert.equal(value.stop.n, SAME_RULE_STOP_LIMIT);
    assert.equal(observe(value.tally, ['rule-a'], 'candidate-2').rules[0].n, 1);
    assert.deepEqual(ruleTallyLastRoundIds(value.tally, 'fact-check', 'candidate-1'), ['rule-a']);
    assert.deepEqual(clearRuleTallyFamily(value.tally, 'fact-check'), emptyRuleTally());
    assert.deepEqual(clearRuleTallyStep(value.tally, 'fact-check', 'candidate-1'), emptyRuleTally());
  } },
  { name: 'Application rule tally: rotating rules never create a flat stop', run() {
    let tally = emptyRuleTally();
    for (let i = 0; i < 20; i++) {
      const result = observe(tally, [`rule-${i}`]); tally = result.tally; assert.equal(result.stop, null);
    }
    assert.equal(summarizeRuleTally(tally, 3).length, 3);
  } },
  { name: 'Application rule tally: canonical answers ignore only transient envelope fields', run() {
    assert.equal(canonicalAnswerSha256({ parsed: { a: { z: 1, b: 2 }, handoffCode: 'x', __host: 1 } }), canonicalAnswerSha256({ parsed: { handoffCode: 'y', a: { b: 2, z: 1 } } }));
    assert.equal(canonicalAnswerSha256({ rawText: ' a\r\nb ' }), canonicalAnswerSha256({ rawText: 'a\nb' }));
    assert.notEqual(canonicalAnswerSha256({ parsed: { a: 1 } }), canonicalAnswerSha256({ parsed: { a: 2 } }));
    assert.equal(normalizedObservationFingerprint('line 3, column 9'), normalizedObservationFingerprint('line 40, column 2'));
    const quote = String.fromCharCode(0x201c), close = String.fromCharCode(0x201d);
    assert.equal(normalizedObservationFingerprint(`${quote}first${close} at 1`), normalizedObservationFingerprint(`${quote}second${close} at 99`));
  } },
  { name: 'Application rule tally: schema fingerprints are separate but keep id-based streaks', run() {
    let tally = emptyRuleTally();
    for (const fingerprint of ['11111111', '22222222']) {
      const result = recordRuleRejection(tally, { family: 'requirements', subject: 'e0-l0-u0', answerSha256: sha, rules: [{ id: 'schema-invalid', fingerprint }] });
      tally = result.tally; assert.equal(result.rules[0].n, 1);
    }
    assert.equal(tally.steps[0].rules.length, 2);
    assert.equal(tally.steps[0].runs['schema-invalid'], 2);
  } },
  { name: 'Application rule tally: legacy and malformed persistence is bounded and sanitized', run() {
    for (const value of [null, [], {}, { version: 2, steps: [] }]) assert.deepEqual(cleanRuleTally(value), emptyRuleTally());
    const good = observe(emptyRuleTally(), ['rule-a']).tally.steps[0];
    assert.equal(cleanRuleTally({ version: 1, steps: [good, { ...good, subject: undefined }, { ...good, lastRejectedSha256: 'x' }] }).steps.length, 1);
    const large = cleanRuleTally({ version: 1, steps: Array.from({ length: 40 }, (_, i) => ({ ...good, subject: `candidate-${i}`,
      rules: Array.from({ length: 40 }, (_, j) => ({ id: `rule-${j}`, key: `rule-${j}`, n: 1 })) })) });
    assert.equal(large.steps.length, 32); assert.equal(large.steps[0].rules.length, 32);
  } },
  { name: 'Application rule tally: stage families and typed stop messages use host ids and numbers', run() {
    assert.equal(ruleTallyFamily('fact-recheck'), 'fact-check'); assert.equal(ruleTallyFamily('convert'), 'documents');
    assert.equal(ruleTallyFamily('unknown'), null);
    const terminal = sameRuleStopTerminal({ stage: 'requirements', family: 'requirements', subject: 'e0-l0-u0', ruleId: 'rule-a', count: 5 });
    assert.equal(terminal.message, 'Stopped: the requirements step for e0-l0-u0 was rejected 5 times for the same rule (rule-a).');
    assert.deepEqual(terminalStopSummary(terminal), { reason: 'same-rule-repeat', stage: 'requirements', subject: 'e0-l0-u0', ruleId: 'rule-a', count: 5 });
    assert.equal(terminalStopSummary({ kind: 'write-verify-human-stop' }), null);
    assert.match(runBudgetTerminal({ stage: 'pick', runs: 120, limit: 120 }).message, /120 of 120/);
    const notice = unchangedNotice({ family: 'pick', subject: 'judge-round-0', ruleIds: ['rule-a'], n: 2 });
    assert.ok(notice.startsWith('Unchanged reply:')); assert.ok(!/^[a-z][a-z0-9-]*:\s/u.test(notice));
  } },
];
