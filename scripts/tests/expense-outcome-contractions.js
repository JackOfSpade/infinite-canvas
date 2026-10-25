import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { __pasteUnitGroundingErrorsForTests } from '../../electron/ipc/localAiApplication.js';
import { namedTermFindings } from '../../electron/ipc/applicationClaimGrounding.js';
import { supportsExpensePurpose } from '../../electron/ipc/expenseOutcomeEquivalence.js';

const careers = [
  { work: 'catalog service', kind: 'hosting', place: 'library' },
  { work: 'appointment archive', kind: 'storage', place: 'clinic' },
  { work: 'fleet system', kind: 'maintenance', place: 'warehouse' },
];
const quoteFor = ({ work, kind }) => `We decided to offload ${kind} expense by shifting the ${work} to an external provider.`;
const claimFor = ({ work, kind }) => `We moved the ${work} to an external provider to reduce ${kind} expense.`;
const gate = (claim, quote) => __pasteUnitGroundingErrorsForTests({
  unitLabel: 'Résumé bullet', unitId: 'bullet-1', finalText: claim,
  evidenceIds: ['career-1'], acceptedEvidence: [{ id: 'career-1', sourceId: 'career-data', quote }],
  identityTokens: [], label: 'resumeBullets', sourceRoles: [], careerData: quote,
  authority: null, projects: [], postingText: '', targetCompany: '',
});
const nameCtx = { meaningful: value => String(value).toLowerCase().split(/\W+/u).filter(Boolean), trustedNames: [], exemptTokens: [] };

export default [{
  name: 'Expense purpose: three unrelated careers pass only for the same actor, same work and same expense',
  run() {
    for (const career of careers) {
      const quote = quoteFor(career);
      const claim = claimFor(career);
      assert.equal(supportsExpensePurpose(claim, [quote]), true, career.place);
      assert.deepEqual(gate(claim, quote), [], career.place);
      assert.equal(supportsExpensePurpose(claim, [quote.replace('the ' + career.work, 'an unrelated system')]), false,
        `${career.place}: different work cannot supply the outcome`);
      assert.equal(supportsExpensePurpose(claim, [`The vendor ${quote.toLowerCase().slice(3)}`]), false,
        `${career.place}: a different actor cannot supply the outcome`);
    }
  },
}, {
  name: 'Expense mutations: increase, no outcome, different noun, result, amount and magnitude remain blocked',
  run() {
    for (const career of careers) {
      const quote = quoteFor(career);
      const claim = claimFor(career);
      const variants = [
        [claim, `We decided to increase ${career.kind} expense while moving the ${career.work} to an external provider.`],
        [claim, `We discussed moving the ${career.work} to an external provider.`],
        [claim, `We never decided to offload ${career.kind} expense by shifting the ${career.work} to an external provider.`],
        [claim.replace(`${career.kind} expense`, `${career.kind} work`), quote],
        [claim.replace(`${career.kind} expense`, `${career.kind} burden`), quote],
        [claim.replace('to reduce', 'and reduced'), quote],
        [claim.replace('to reduce', 'to reduce by 30%'), quote],
        [claim.replace('to reduce', 'to substantially reduce'), quote],
      ];
      for (const [candidate, evidence] of variants) {
        assert.equal(supportsExpensePurpose(candidate, [evidence]), false, `${career.place}: ${candidate}`);
        assert.ok(gate(candidate, evidence).length, `${career.place}: mutation must fail the production gate`);
      }
      assert.ok(gate(`${claim} We reduced ${career.kind} expense.`, quote).length,
        `${career.place}: a purpose sentence cannot hide a later accomplished claim`);
      // A source stating the accomplished result itself is still allowed.
      const result = `We moved the ${career.work} to an external provider and reduced ${career.kind} expense.`;
      assert.deepEqual(gate(result, `We moved the ${career.work} to an external provider and reduced ${career.kind} expense.`), [],
        `${career.place}: an explicit result supports the same result`);
    }
  },
}, {
  name: 'Contractions: closed English forms are grammar, while an adjacent real name remains checked',
  run() {
    const forms = ["I've", "I'm", "I'd", "I'll", "we're", "it's", "don't", "can't", "they're"];
    for (const career of careers) {
      for (const form of forms) {
        const findings = namedTermFindings(`For this ${career.place}, ${form} working with records.`, ['I worked with records.'], nameCtx);
        assert.ok(!findings.some(item => item.term.toLowerCase() === form.toLowerCase()), `${career.place}: ${form}`);
      }
      const findings = namedTermFindings(`For this ${career.place}, I've maintained records in AlpineDB.`, ['I maintained records.'], nameCtx);
      assert.ok(findings.some(item => item.code === 'name' && item.term === 'AlpineDB'),
        `${career.place}: the proper name immediately beside a contraction must still be rejected`);
    }
  },
}, {
  name: 'Truth recall adds two new claims to the 44-case matrix',
  run() {
    const career = careers[0];
    assert.ok(gate(`We moved the ${career.work} and reduced ${career.kind} expense.`, quoteFor(career)).length,
      'intent does not prove an accomplished cost reduction');
    const findings = namedTermFindings("I've used MeridianDB for records.", ['I used records.'], nameCtx);
    assert.ok(findings.some(item => item.term === 'MeridianDB'), 'a contraction does not license a nearby product');
  },
}, {
  name: 'Sabotage: disabling either precision fence fails its positive or adjacent-name proof',
  async run() {
    const outcomeSource = fs.readFileSync(fileURLToPath(new URL('../../electron/ipc/expenseOutcomeEquivalence.js', import.meta.url)), 'utf8');
    const outcomeFence = 'if (![...claimWork].some(word => sourceWork.has(word))) continue;';
    assert.ok(outcomeSource.includes(outcomeFence));
    const sabotagedOutcome = await import(`data:text/javascript;base64,${Buffer.from(outcomeSource.replace(outcomeFence, '')).toString('base64')}`);
    assert.equal(supportsExpensePurpose('We moved an unrelated system to reduce hosting expense.', [quoteFor(careers[0])]), false);
    assert.equal(sabotagedOutcome.supportsExpensePurpose('We moved an unrelated system to reduce hosting expense.', [quoteFor(careers[0])]), true);
    const nameSource = fs.readFileSync(fileURLToPath(new URL('../../electron/ipc/applicationClaimGrounding.js', import.meta.url)), 'utf8');
    const nameFence = 'if (NAME_CONTRACTIONS.has(String(piece).toLowerCase().replace(APOSTROPHES, "\'"))) return false;';
    assert.ok(nameSource.includes(nameFence));
    const dependencyUrl = new URL('../../electron/ipc/coverLetterChecks.js', import.meta.url).href;
    const copiedNameSource = nameSource.replace("from './coverLetterChecks.js'", `from '${dependencyUrl}'`);
    const sabotagedName = await import(`data:text/javascript;base64,${Buffer.from(copiedNameSource.replace(nameFence, '')).toString('base64')}`);
    assert.ok(!namedTermFindings("For this role, I've maintained records.", ['I maintained records.'], nameCtx).some(item => item.term === "I've"));
    assert.ok(sabotagedName.namedTermFindings("For this role, I've maintained records.", ['I maintained records.'], nameCtx).some(item => item.term === "I've"));
  },
}];
