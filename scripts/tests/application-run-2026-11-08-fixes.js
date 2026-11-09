import { assert } from './testHelpers.js';
import {
  __authorityRequirementsWindowIdPrefixForTests as windowPrefix,
  __pastePromptForTests,
} from '../../electron/ipc/localAiApplication.js';

const input = { jobId: 'window-prefix-test', job: { company: 'Quillfeather', title: 'Nurse' }, authorityProtocol: 'requirements-ledger.v3', listingCoverageVersion: 1, careerAuthority: { version: 1 }, __careerAuthorityIndex: { identity: { name: 'Riley Sample', contact: ['riley@example.test'] } }, hostCareerEvidenceCatalog: [], sourceRoles: [], careerSkillEvidence: { skills: [] } };

const stateFor = unitStart => ({ stage: 'requirements', handoffCode: 'window-prefix-code', baseHashes: {}, authorityStore: { receipt: () => ({ digest: 'c'.repeat(64), streams: {} }) }, authorityListingPage: { text: 'Quillfeather seeks a nurse who delivers patient-focused care.', index: 0, pageCount: 1, digest: 'd'.repeat(64), requirementsStream: 'requirements', sourceCoverage: { unitStart, unitCount: 106, units: [{ id: 'u00000052' }] } } });

const equals = (actual, expected, message) => assert(actual === expected, `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

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
];
