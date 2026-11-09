import { assert } from './testHelpers.js';
import strict from 'node:assert/strict';
import {
  __authorityRequirementsWindowIdPrefixForTests as windowPrefix,
  __pastePromptForTests,
  assertSourceQuoteLinksFinalText,
  __pasteUnitGroundingErrorsForTests,
} from '../../electron/ipc/localAiApplication.js';

const input = { jobId: 'window-prefix-test', job: { company: 'Quillfeather', title: 'Nurse' }, authorityProtocol: 'requirements-ledger.v3', listingCoverageVersion: 1, careerAuthority: { version: 1 }, __careerAuthorityIndex: { identity: { name: 'Riley Sample', contact: ['riley@example.test'] } }, hostCareerEvidenceCatalog: [], sourceRoles: [], careerSkillEvidence: { skills: [] } };

const stateFor = unitStart => ({ stage: 'requirements', handoffCode: 'window-prefix-code', baseHashes: {}, authorityStore: { receipt: () => ({ digest: 'c'.repeat(64), streams: {} }) }, authorityListingPage: { text: 'Quillfeather seeks a nurse who delivers patient-focused care.', index: 0, pageCount: 1, digest: 'd'.repeat(64), requirementsStream: 'requirements', sourceCoverage: { unitStart, unitCount: 106, units: [{ id: 'u00000052' }] } } });

const equals = (actual, expected, message) => assert(actual === expected, `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

// Copied from scripts/tests/official-posting-r2-subject.js lines 1-19: the same
// two gates (cover-letter assembly and drafting) over the same invented employer,
// invented work, and invented quotes.
const GATE_COMPANY = 'Northwind Labs';
const GATE_WORK = 'dispatch rosters for freight routes';
const GATE_QUOTE = `I built and rebuilt ${GATE_WORK}. I now run ${GATE_WORK}. My work on ${GATE_WORK} cut triage time. I maintained ${GATE_WORK} and coordinated updates with the team during regular operations.`;

function gateVerdicts(text, targetCompany = GATE_COMPANY) {
  const options = { identityTokens: [], targetTitle: 'Freight Systems Engineer', targetCompany,
    postingText: `${GATE_COMPANY} needs reliable dispatch rosters for freight routes.` };
  let assembly = [];
  try { assertSourceQuoteLinksFinalText(text, [GATE_QUOTE], 'coverLetterParagraphs', 0, options); }
  catch (error) { assembly = error.validationFailures || [error.message]; }
  const drafting = __pasteUnitGroundingErrorsForTests({ unitLabel: 'Cover-letter paragraph', unitId: 'p1',
    finalText: text, evidenceIds: ['career-one'], acceptedEvidence: [{ id: 'career-one', sourceId: 'career-data', quote: GATE_QUOTE }],
    label: 'coverLetterParagraphs', ...options });
  return { assembly, drafting };
}

export default [
  {
    name: 'continuation cursor windows keep requirement IDs distinct from the first window',
    run() {
      equals(windowPrefix({ index: 0 }), 'p1-', 'a page without sourceCoverage keeps the bare epoch/page prefix');
      equals(windowPrefix({ index: 0, sourceCoverage: { unitStart: 0 } }), 'p1-', 'window 0 keeps the stored first-window prefix');
      equals(windowPrefix({ index: 0, sourceCoverage: { unitStart: 51 } }), 'p1-u51-', 'a continuation window appends its own unit start');
      equals(windowPrefix({ epoch: 1, index: 0, sourceCoverage: { unitStart: 51 } }), 'e1-p1-u51-', 'a later epoch keeps the epoch namespace ahead of the window suffix');

      const continuation = __pastePromptForTests({ input, state: stateFor(51) });
      assert(continuation.includes('Every new ID in this response begins p1-u51-.'), 'the requirements contract names the continuation window prefix');
      assert(continuation.includes('every new evidence/requirement id in this response begins p1-u51-.'), 'the response scaffold names the continuation window prefix');
      assert(!continuation.includes('on page N'), 'the requirements contract no longer tells the model a placeholder page prefix');
      assert(!continuation.includes('begins p1-.'), 'the continuation prompt never offers the first-window-only prefix to a later window');

      const firstWindow = __pastePromptForTests({ input, state: stateFor(0) });
      assert(firstWindow.includes('Every new ID in this response begins p1-.'), 'window 0 keeps the bare first-window prefix');
      assert(!firstWindow.includes('p1-u'), 'window 0 carries no continuation window suffix');
    },
  },
  {
    name: 'an employer possessive opening a clause as its own need subject is licensed in both gates, and a relative clause or a non-need noun is not',
    run() {
      const ACCEPTED = [
        "As I read your posting, Northwind Labs's main need is engineers who build user-focused dispatch rosters for freight routes.",
        "As I read the posting, Northwind Labs's mission is dispatch rosters for freight routes that work.",
      ];
      for (const text of ACCEPTED) {
        const { assembly, drafting } = gateVerdicts(text);
        strict.deepEqual(assembly, [], `assembly should accept: ${text}`);
        strict.deepEqual(drafting, [], `drafting should accept: ${text}`);
      }

      const REJECTED = [
        "I built dispatch rosters for freight routes, which meets Northwind Labs's need for dispatch rosters.",
        'I rebuilt dispatch rosters for freight routes at Northwind Labs.',
        "As I read your posting, Northwind Labs's platform is what I built for freight routes.",
      ];
      for (const text of REJECTED) {
        const { assembly, drafting } = gateVerdicts(text);
        strict.ok(assembly.length > 0, `assembly should reject: ${text}`);
        strict.ok(drafting.length > 0, `drafting should reject: ${text}`);
      }

      // The platform sentence is rejected for the possessive name it cannot
      // ground, not for an incidental defect: the message names the employer.
      const platform = gateVerdicts(REJECTED[2]);
      strict.ok(platform.assembly.some(message => message.includes("Northwind Labs's")),
        `platform rejection should name the employer possessive: ${JSON.stringify(platform.assembly)}`);
      strict.ok(platform.drafting.some(message => message.includes("Northwind Labs's")),
        `platform drafting rejection should name the employer possessive: ${JSON.stringify(platform.drafting)}`);
    },
  },
];
