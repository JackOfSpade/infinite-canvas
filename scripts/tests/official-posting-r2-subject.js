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

// Baseline-derived pins deliberately replace the stricter Amendment-5 own-sentence matrix.
const BASELINE_VERDICTS = [
  [
    "I built dispatch rosters for freight routes that Northwind Labs relies on.",
    "Northwind Labs",
    false,
    false
  ],
  [
    "I built dispatch rosters for freight routes, which Northwind Labs uses.",
    "Northwind Labs",
    false,
    false
  ],
  [
    "I built dispatch rosters for freight routes, which Northwind Labs depends on.",
    "Northwind Labs",
    false,
    false
  ],
  [
    "I built dispatch rosters for freight routes, and Northwind Labs ships them to carriers.",
    "Northwind Labs",
    false,
    false
  ],
  [
    "I built dispatch rosters for freight routes, and Northwind Labs deploys them.",
    "Northwind Labs",
    false,
    false
  ],
  [
    "I built dispatch rosters for freight routes, so Northwind Labs runs them every day.",
    "Northwind Labs",
    false,
    false
  ],
  [
    "I built dispatch rosters for freight routes, and Northwind Labs needs the same.",
    "Northwind Labs",
    false,
    false
  ],
  [
    "I run dispatch rosters for freight routes, and Northwind Labs needs the same.",
    "Northwind Labs",
    true,
    true
  ],
  [
    "I rebuilt dispatch rosters for freight routes, and Northwind Labs needs the same.",
    "Northwind Labs",
    true,
    true
  ],
  [
    "I cut dispatch rosters for freight routes, and Northwind Labs needs the same.",
    "Northwind Labs",
    true,
    true
  ],
  [
    "I built dispatch rosters for freight routes. Northwind Labs needs reliable rosters.",
    "Northwind Labs",
    true,
    true
  ],
  [
    "I built dispatch rosters for freight routes. Northwind Labs's mission is clear.",
    "Northwind Labs",
    true,
    true
  ],
  [
    "I built dispatch rosters for freight routes, which meets Northwind Labs's need for dispatch rosters.",
    "Northwind Labs",
    false,
    false
  ],
  [
    "I admire dispatch rosters for freight routes, and Northwind Labs needs reliable rosters.",
    "Northwind Labs",
    true,
    true
  ],
  [
    "My background aligns with dispatch rosters for freight routes, and Northwind Labs needs reliable rosters.",
    "Northwind Labs",
    true,
    true
  ],
  [
    "I am excited to join Northwind Labs.",
    "Northwind Labs, Inc.",
    false,
    false
  ],
  [
    "I built dispatch rosters for freight routes. Northwind Labs's mission is clear.",
    "Northwind Labs, Inc.",
    true,
    true
  ],
  [
    "I rebuilt dispatch rosters for freight routes at Northwind Labs.",
    "Northwind Labs, Inc.",
    false,
    false
  ],
  [
    "I built dispatch rosters for freight routes, which meets Northwind Labs's need for dispatch rosters.",
    "Northwind Labs, Inc.",
    false,
    false
  ],
  [
    "I am excited to join Northwind Labs.",
    "Northwind Labs (NWL)",
    false,
    false
  ],
  [
    "I built dispatch rosters for freight routes. Northwind Labs's mission is clear.",
    "Northwind Labs (NWL)",
    true,
    true
  ],
  [
    "I rebuilt dispatch rosters for freight routes at Northwind Labs.",
    "Northwind Labs (NWL)",
    false,
    false
  ],
  [
    "I built dispatch rosters for freight routes, which meets Northwind Labs's need for dispatch rosters.",
    "Northwind Labs (NWL)",
    false,
    false
  ]
];
export default [{
  name: 'Amendment 7 restores baseline no-title addressing without treating a pre-dash prefix as the full target',
  run() {
    const text = 'Northwind Labs needs dispatch rosters for freight routes.';
    const options = { identityTokens: [], targetCompany: 'Northwind Labs - Freight Platform', postingText: text };
    assert.throws(() => assertSourceQuoteLinksFinalText(text, [QUOTE], 'coverLetterParagraphs', 0, options), /names/u);
    assert.doesNotThrow(() => assertSourceQuoteLinksFinalText(text, [QUOTE], 'coverLetterParagraphs', 0, { ...options, targetTitle: 'Freight Systems Engineer' }));
  },
}, {
  name: 'Amendment 6 restores all 23 employer-subject and suffix pins to measured pre-feature verdicts',
  run() {
    for (const [text, company, assembly, drafting] of BASELINE_VERDICTS) {
      const errors = gates(text, company);
      assert.equal(errors.assembly.length === 0, assembly, `assembly: ${company}: ${text}`);
      assert.equal(errors.drafting.length === 0, drafting, `drafting: ${company}: ${text}`);
    }
  },
}];
