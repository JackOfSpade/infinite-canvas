import {
  assert,
  selectCorrectionDetails,
  validationFailure,
  validationFailureCollector,
  VALIDATION_DETAIL_LIMIT,
  VALIDATION_RULE_ID_RE,
  VALIDATION_SUMMARY_RULE_ID,
} from '../test-dependencies.js';

const entry = (line, ruleId) => ({ line, ruleId });

export default [
  {
    name: 'validation failure helper: a one-line budget contains only the omitted-problems summary',
    run: () => {
      const result = selectCorrectionDetails([entry('one', 'RULE_ONE'), entry('two', 'RULE_TWO')], 1);
      assert(result.lines.length === 1 && result.ruleIds[0] === VALIDATION_SUMMARY_RULE_ID
        && result.lines[0].startsWith('2 more problems were found'), 'the custom limit is an actual bound');
    },
  },
  {
    name: 'validation failure helper: constants match the documented contract',
    run: () => {
      assert(VALIDATION_DETAIL_LIMIT === 12, 'the correction line limit is twelve');
      assert(VALIDATION_SUMMARY_RULE_ID === 'VALIDATION_MORE_PROBLEMS', 'the summary rule id is fixed');
      assert(VALIDATION_RULE_ID_RE.test('SCORING_ROWS_MISSING') && VALIDATION_RULE_ID_RE.test('ABC')
        && !VALIDATION_RULE_ID_RE.test('AB') && !VALIDATION_RULE_ID_RE.test('lower_case')
        && !VALIDATION_RULE_ID_RE.test('1ABC') && !VALIDATION_RULE_ID_RE.test('HAS SPACE')
        && !VALIDATION_RULE_ID_RE.test(`A${'B'.repeat(64)}`),
      'rule ids are upper snake case of 3 to 64 characters starting with a letter');
    },
  },
  {
    name: 'validation failure helper: an invalid rule id becomes null and the arrays stay parallel',
    run: () => {
      const { lines, ruleIds } = selectCorrectionDetails([
        entry('first', 'GOOD_RULE'),
        entry('second', 'bad rule'),
        entry('third', 42),
        entry('fourth', 'AB'),
        entry('fifth'),
        entry('sixth', 'ANOTHER_GOOD_RULE'),
      ]);
      assert(lines.join('|') === 'first|second|third|fourth|fifth|sixth', 'every line is kept in order');
      assert(ruleIds.length === lines.length
        && ruleIds[0] === 'GOOD_RULE' && ruleIds[1] === null && ruleIds[2] === null
        && ruleIds[3] === null && ruleIds[4] === null && ruleIds[5] === 'ANOTHER_GOOD_RULE',
      `invalid ids are null and valid ids stay at their own line (got ${JSON.stringify(ruleIds)})`);
    },
  },
  {
    name: 'validation failure helper: blank and non-string lines are dropped, kept lines are trimmed, ids stay aligned',
    run: () => {
      const { lines, ruleIds } = selectCorrectionDetails([
        entry('  padded line  ', 'RULE_ONE'),
        entry('', 'RULE_DROPPED_A'),
        entry('   ', 'RULE_DROPPED_B'),
        entry(7, 'RULE_DROPPED_C'),
        null,
        entry('kept after skips', 'RULE_TWO'),
      ]);
      assert(lines.length === 2 && lines[0] === 'padded line' && lines[1] === 'kept after skips',
        `blank and non-string entries are dropped and lines trimmed (got ${JSON.stringify(lines)})`);
      assert(ruleIds[0] === 'RULE_ONE' && ruleIds[1] === 'RULE_TWO',
        'a skipped entry never shifts the id of a later line');
      const empty = selectCorrectionDetails([]);
      assert(empty.lines.length === 0 && empty.ruleIds.length === 0, 'no entries gives empty arrays');
    },
  },
  {
    name: 'validation failure helper: more than twelve entries keep one line per distinct rule and end with the summary entry',
    run: () => {
      const entries = [];
      for (let i = 0; i < 10; i += 1) entries.push(entry(`alpha ${i}`, 'RULE_ALPHA'));
      for (let i = 0; i < 6; i += 1) entries.push(entry(`bravo ${i}`, 'RULE_BRAVO'));
      for (let i = 0; i < 4; i += 1) entries.push(entry(`charlie ${i}`, 'RULE_CHARLIE'));
      const { lines, ruleIds } = selectCorrectionDetails(entries);
      assert(lines.length === 12 && ruleIds.length === 12, `the total length is the limit (got ${lines.length})`);
      assert(ruleIds[11] === VALIDATION_SUMMARY_RULE_ID && /^9 more problems were found beyond the ones listed/.test(lines[11]),
        `the final entry reports the nine omitted problems (got ${lines[11]})`);
      assert(lines.includes('alpha 0') && lines.includes('bravo 0') && lines.includes('charlie 0'),
        'the first line of every distinct rule is kept');
      assert(!lines.includes('charlie 3') && !lines.includes('bravo 5'), 'late repeats are the ones omitted');
      const listed = lines.slice(0, 11);
      const order = listed.map(line => entries.findIndex(candidate => candidate.line === line));
      assert(order.every((position, index) => position >= 0 && (index === 0 || position > order[index - 1])),
        'listed lines keep their original order');
      assert(ruleIds.slice(0, 11).every(id => id !== VALIDATION_SUMMARY_RULE_ID), 'only the last entry is the summary');
    },
  },
  {
    name: 'validation failure helper: twenty distinct rules still produce exactly twelve entries',
    run: () => {
      const entries = Array.from({ length: 20 }, (_, i) => entry(`line ${i}`, `RULE_NUMBER_${i}`));
      const { lines, ruleIds } = selectCorrectionDetails(entries);
      assert(lines.length === 12 && ruleIds.length === 12, 'twenty distinct rules are capped at twelve entries');
      assert(lines.slice(0, 11).join('|') === entries.slice(0, 11).map(item => item.line).join('|'),
        'the first eleven distinct rules are listed in order');
      assert(ruleIds[11] === VALIDATION_SUMMARY_RULE_ID && lines[11].startsWith('9 more problems were found'),
        `nine rules were omitted (got ${lines[11]})`);
    },
  },
  {
    name: 'validation failure helper: exactly twelve entries are returned whole and thirteen cap with a two-problem summary',
    run: () => {
      const twelve = Array.from({ length: 12 }, (_, i) => entry(`line ${i}`, 'SAME_RULE_ID'));
      const whole = selectCorrectionDetails(twelve);
      assert(whole.lines.length === 12 && !whole.ruleIds.includes(VALIDATION_SUMMARY_RULE_ID), 'twelve entries need no summary');
      const thirteen = Array.from({ length: 13 }, (_, i) => entry(`line ${i}`, 'SAME_RULE_ID'));
      const capped = selectCorrectionDetails(thirteen);
      assert(capped.lines.length === 12 && capped.lines[11].startsWith('2 more problems were found')
        && capped.ruleIds[11] === VALIDATION_SUMMARY_RULE_ID,
      `thirteen entries keep eleven and summarize two (got ${capped.lines[11]})`);
      assert(capped.lines.slice(0, 11).join('|') === thirteen.slice(0, 11).map(item => item.line).join('|'),
        'the same rule fills the remaining budget in order');
    },
  },
  {
    name: 'validation failure helper: null-id lines are distinct by text and a custom limit is honoured',
    run: () => {
      const entries = [
        entry('same text'), entry('same text'), entry('same text'),
        entry('other text'), entry('third text'),
      ];
      const { lines, ruleIds } = selectCorrectionDetails(entries, 4);
      assert(lines.length === 4 && ruleIds[3] === VALIDATION_SUMMARY_RULE_ID, 'a limit of four lists three entries and the summary');
      assert(lines[0] === 'same text' && lines.includes('other text') && lines.includes('third text'),
        `pass one prefers distinct texts over repeats of the same text (got ${JSON.stringify(lines)})`);
      assert(lines[3].startsWith('2 more problems were found'), 'two problems were omitted');
    },
  },
  {
    name: 'validation failure helper: validationFailure builds a capped error without throwing',
    run: () => {
      const details = Array.from({ length: 15 }, (_, i) => `problem ${i}`);
      const ruleIds = details.map((_, i) => `RULE_${i}`);
      const error = validationFailure({ message: 'Whole message', details, ruleIds, code: 'CUSTOM_CODE' });
      assert(error instanceof Error && error.message === 'Whole message' && error.code === 'CUSTOM_CODE',
        'the message and code are applied');
      assert(error.correctionDetails.length === 12 && error.correctionRuleIds.length === 12
        && error.correctionRuleIds[11] === VALIDATION_SUMMARY_RULE_ID
        && error.correctionDetails[11].startsWith('4 more problems were found'),
      'details are capped through selectCorrectionDetails');
      const joined = validationFailure({ details: ['one', 'two'], ruleIds: ['RULE_ONE'] });
      assert(joined.message === 'one | two' && joined.code === 'VALIDATION_FAILED'
        && joined.correctionRuleIds[0] === 'RULE_ONE' && joined.correctionRuleIds[1] === null,
      'without a message the lines are joined and a missing id is null');
      const plain = validationFailure({ message: 'nothing to say' });
      assert(!('correctionDetails' in plain) && !('correctionRuleIds' in plain) && !('validationDiagnostic' in plain),
        'no details means no correction properties and no diagnostic');
    },
  },
  {
    name: 'validation failure helper: the diagnostic exists only when a reason is given',
    run: () => {
      const without = validationFailure({ message: 'm', details: ['x'], ruleIds: ['RULE_X'] });
      assert(!('validationDiagnostic' in without), 'a null reason omits the diagnostic property entirely');
      const withReason = validationFailure({ message: 'm', reason: 'SOME_REASON', counts: { rows: 2 } });
      assert(withReason.validationDiagnostic.stage === 'domain' && withReason.validationDiagnostic.reason === 'SOME_REASON'
        && withReason.validationDiagnostic.counts.rows === 2, 'the diagnostic carries stage, reason and counts');
      const defaults = validationFailure({ message: 'm', reason: 'SOME_REASON', stage: 'schema' });
      assert(defaults.validationDiagnostic.stage === 'schema' && Object.keys(defaults.validationDiagnostic.counts).length === 0,
        'counts default to an empty object and the stage is honoured');
    },
  },
  {
    name: 'validation failure helper: the collector message is uncapped while the correction details are capped',
    run: () => {
      const collector = validationFailureCollector({ prefix: 'Invalid thing: ', separator: '; ', suffix: '.' });
      const lines = [];
      for (let i = 0; i < 15; i += 1) {
        lines.push(`problem ${i}`);
        collector.add(`RULE_NUMBER_${i}`, `problem ${i}`);
      }
      assert(collector.size === 15, 'size counts every added problem');
      const error = collector.toError();
      assert(error.message === `Invalid thing: ${lines.join('; ')}.`, 'the message is prefix + all lines + suffix');
      assert(error.correctionDetails.length === 12 && error.correctionRuleIds[11] === VALIDATION_SUMMARY_RULE_ID,
        'details are capped with the summary entry');
      assert(error.code === 'VALIDATION_FAILED' && !('validationDiagnostic' in error), 'defaults: code and no diagnostic');
      const defaultSeparator = validationFailureCollector();
      defaultSeparator.add('RULE_ONE', 'a');
      defaultSeparator.add('RULE_TWO', 'b');
      assert(defaultSeparator.toError().message === 'a | b', 'the default separator is a pipe');
    },
  },
  {
    name: 'validation failure helper: throwIfAny throws nothing when empty and the collected error otherwise',
    run: () => {
      const empty = validationFailureCollector({ prefix: 'x: ' });
      empty.throwIfAny();
      assert(empty.size === 0, 'an empty collector does not throw');
      const withProblem = validationFailureCollector({ prefix: 'x: ', code: 'CUSTOM_CODE', reason: 'SOME_REASON', counts: { n: 1 } });
      withProblem.add('RULE_ONE', 'broken');
      let thrown = null;
      try { withProblem.throwIfAny(); } catch (error) { thrown = error; }
      assert(thrown instanceof Error && thrown.message === 'x: broken' && thrown.code === 'CUSTOM_CODE'
        && thrown.correctionDetails[0] === 'broken' && thrown.correctionRuleIds[0] === 'RULE_ONE'
        && thrown.validationDiagnostic.reason === 'SOME_REASON' && thrown.validationDiagnostic.counts.n === 1,
      'a non-empty collector throws the built error');
    },
  },
  {
    name: 'validation failure helper: collector ids that fail the rule pattern become null',
    run: () => {
      const collector = validationFailureCollector();
      collector.add('not valid', 'one');
      collector.add('GOOD_RULE', 'two');
      const error = collector.toError();
      assert(error.correctionRuleIds[0] === null && error.correctionRuleIds[1] === 'GOOD_RULE', 'a bad id is treated as null');
    },
  },
];
