import assert from 'node:assert/strict';
import { assertSourceQuoteLinksFinalText, __pasteUnitGroundingErrorsForTests } from '../../electron/ipc/localAiApplication.js';

const COMPANY = 'Northwind Labs';
const WORK = 'dispatch rosters for freight routes';
const QUOTE = `I built and rebuilt ${WORK}. I now run ${WORK}. My work on ${WORK} cut triage time. I maintained ${WORK} and coordinated updates with the team during regular operations.`;

function gates(text, targetCompany = COMPANY) {
  const options = { identityTokens: [], targetTitle: 'Freight Systems Engineer', targetCompany,
    postingText: `${COMPANY} needs reliable dispatch rosters for freight routes.` };
  let assembly = [];
  try { assertSourceQuoteLinksFinalText(text, [QUOTE], 'coverLetterParagraphs', 0, options); }
  catch (error) { assembly = error.validationFailures || [error.message]; }
  const drafting = __pasteUnitGroundingErrorsForTests({ unitLabel: 'Cover-letter paragraph', unitId: 'p1',
    finalText: text, evidenceIds: ['career-one'], acceptedEvidence: [{ id: 'career-one', sourceId: 'career-data', quote: QUOTE }],
    label: 'coverLetterParagraphs', ...options });
  return { assembly, drafting };
}

export default [
  {
    name: 'employer SUBJECT never attributes earlier first-person work to the target',
    run() {
      const tails = ['that Northwind Labs relies on.', ', which Northwind Labs uses.',
        ', which Northwind Labs depends on.', ', and Northwind Labs ships them to carriers.',
        ', and Northwind Labs deploys them.', ', so Northwind Labs runs them every day.',
        ', and Northwind Labs needs the same.'];
      for (const tail of tails) for (const [gate, errors] of Object.entries(gates(`I built ${WORK}${tail.startsWith(',') ? '' : ' '}${tail}`))) {
        assert.ok(errors.length, `${gate}: ${tail}`);
      }
      for (const verb of ['run', 'rebuilt', 'cut']) {
        const text = `I ${verb} ${WORK}, and ${COMPANY} needs the same.`;
        for (const [gate, errors] of Object.entries(gates(text))) assert.ok(errors.length, `${gate}: ${text}`);
      }
    },
  },
  {
    name: 'standalone closed employer need clauses remain licensed',
    run() {
      for (const text of [`I built ${WORK}. ${COMPANY} needs reliable rosters.`, `I built ${WORK}. ${COMPANY}'s mission is clear.`,
        `I built ${WORK}, which meets ${COMPANY}'s need for dispatch rosters.`,
        `I admire ${WORK}, and ${COMPANY} needs reliable rosters.`,
        `My background aligns with ${WORK}, and ${COMPANY} needs reliable rosters.`]) {
        for (const [gate, errors] of Object.entries(gates(text))) assert.deepEqual(errors, [], `${gate}: ${text}`);
      }
    },
  },
  {
    name: 'legal and parenthetical target names share join and need licences without freeing employment',
    run() {
      for (const company of [`${COMPANY}, Inc.`, `${COMPANY} (NWL)`]) {
        for (const text of [`I am excited to join ${COMPANY}.`, `I built ${WORK}. ${COMPANY}'s mission is clear.`,
          `I built ${WORK}, which meets ${COMPANY}'s need for dispatch rosters.`]) {
          for (const [gate, errors] of Object.entries(gates(text, company))) assert.deepEqual(errors, [], `${gate}: ${company}: ${text}`);
        }
        for (const [gate, errors] of Object.entries(gates(`I rebuilt ${WORK} at ${COMPANY}.`, company))) {
          assert.ok(errors.length, `${gate}: ${company}`);
        }
      }
    },
  },
];
