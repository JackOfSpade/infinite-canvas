import fs from 'node:fs';
import { assert } from './testHelpers.js';
import { authorityDigest, validateBlindReviewerResponse } from '../../electron/ipc/applicationAuthorityWorkflow.js';
import {
  APPLICATION_BLIND_REVIEW_PANEL_PROMPT_MODE, applicationBlindReviewFindingKind,
  refinementCandidatePosition, selectRefinementWinner, signedRefinementRecord,
  assertSignedRefinementRecord,
} from '../../electron/ipc/applicationRefinement.js';

const DOMAINS = Object.freeze([
  { key: 'orchard logistics', source: 'coordinated harvest pickups', proposed: 'led a regional transport network' },
  { key: 'museum conservation', source: 'evaluated storage conditions', proposed: 'built a public exhibition platform' },
  { key: 'coastal surveying', source: 'supported shoreline measurements', proposed: 'owned a marine simulation program' },
]);

export default [{
  name: 'V8 finding kind preserves historical blocking and makes fact-fidelity impossible to demote across three unrelated careers',
  run() {
    for (const domain of DOMAINS) {
      const finding = { issue: `${domain.proposed} exceeds ${domain.source}`, kind: 'editorial' };
      assert(applicationBlindReviewFindingKind('artifact-repair-only-v7', 'letter-argument-editorial', finding) === 'truth', `${domain.key}: historical plans still block`);
      assert(applicationBlindReviewFindingKind(APPLICATION_BLIND_REVIEW_PANEL_PROMPT_MODE, 'fact-fidelity', finding) === 'truth', `${domain.key}: fact track cannot demote`);
      assert(applicationBlindReviewFindingKind(APPLICATION_BLIND_REVIEW_PANEL_PROMPT_MODE, 'holistic-letter', finding) === 'editorial', `${domain.key}: style track advises by default`);
      assert(applicationBlindReviewFindingKind(APPLICATION_BLIND_REVIEW_PANEL_PROMPT_MODE, 'holistic-letter', { ...finding, kind: 'truth' }) === 'truth', `${domain.key}: reviewer escalation flips the class`);
    }
  },
}, {
  name: 'Two opposite position-swapped judges promote only a supported candidate they both allow',
  run() {
    for (const domain of DOMAINS) {
      const candidateDigest = authorityDigest(domain.proposed);
      const incumbentDigest = authorityDigest(domain.source);
      const a = refinementCandidatePosition({ candidateDigest, incumbentDigest, round: 1, judgeIndex: 0 });
      const b = refinementCandidatePosition({ candidateDigest, incumbentDigest, round: 1, judgeIndex: 1 });
      assert(a !== b && a === refinementCandidatePosition({ candidateDigest, incumbentDigest, round: 1, judgeIndex: 0 }), `${domain.key}: assignment is stable and swapped`);
      const first = { candidatePosition: a, verdict: a, candidateUnsupportedClaim: false };
      const second = { candidatePosition: b, verdict: 'tie', candidateUnsupportedClaim: false };
      assert(selectRefinementWinner([first, second]) === 'candidate', `${domain.key}: one preference and one tie promotes`);
      assert(selectRefinementWinner([{ ...first, verdict: 'tie' }, second]) === 'incumbent', `${domain.key}: two ties retain`);
      assert(selectRefinementWinner([first, { ...second, verdict: a }]) === 'incumbent', `${domain.key}: position disagreement retains`);
      assert(selectRefinementWinner([first, { ...second, candidateUnsupportedClaim: true }]) === 'incumbent', `${domain.key}: unsupported claim retains`);
      assert(selectRefinementWinner([first, { ...second, candidatePosition: a }]) === 'incumbent', `${domain.key}: non-swapped positions retain`);
    }
  },
}, {
  name: 'Optional reviewer kind and severity are signed only for v8 scopes; a fact finding is normalized to truth',
  run() {
    for (const domain of DOMAINS) {
      const scopeFor = promptMode => {
        const value = { kind: 'blind-review-scope', track: 'fact-fidelity', ...(promptMode ? { promptMode } : {}) };
        return { ...value, digest: authorityDigest(value) };
      };
      const responseFor = scope => ({ version: 1, scopeDigest: scope.digest, pageIndex: 0, previousPageDigest: null, complete: true, decision: 'issues',
        findings: [{ id: '0-0-1', ruleId: 'scope', document: 'resume', targetId: 'bullet-1', issue: domain.proposed, fix: domain.source, kind: 'editorial', severity: 'major' }] });
      const old = scopeFor(null);
      const oldFinding = validateBlindReviewerResponse({ scope: old, response: responseFor(old) }).findings[0];
      assert(!Object.hasOwn(oldFinding, 'kind') && !Object.hasOwn(oldFinding, 'severity'), `${domain.key}: old signed bytes omit new fields`);
      const panel = scopeFor(APPLICATION_BLIND_REVIEW_PANEL_PROMPT_MODE);
      const panelFinding = validateBlindReviewerResponse({ scope: panel, response: responseFor(panel) }).findings[0];
      assert(panelFinding.kind === 'truth' && panelFinding.severity === 'major', `${domain.key}: fact finding cannot demote`);
      let rejected = false;
      try { validateBlindReviewerResponse({ scope: panel, response: { ...responseFor(panel), findings: [{ ...responseFor(panel).findings[0], severity: 'unknown' }] } }); } catch { rejected = true; }
      assert(rejected, `${domain.key}: unknown severity is rejected`);
    }
  },
}, {
  name: 'The refinement judge is present in every closed application stage list and review progress map',
  run() {
    for (const relative of [
      '../../electron/ipc/localAiApplication.js',
      '../../electron/ipc/handoffBridge/controller.js',
      '../../electron/ipc/handoffBridge/telemetry.js',
      '../../src/utils/handoffBridgeStatus.js',
      '../../src/utils/bridgeJobProgress.js',
      '../../src/utils/applicationHandoffDock.js',
    ]) {
      const source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
      assert(source.includes("'refinement-judge'"), `${relative}: missing refinement judge stage`);
    }
  },
}, {
  name: 'Refinement records bind their content and reject mutations over three unrelated careers',
  run() {
    for (const domain of DOMAINS) {
      const record = signedRefinementRecord('outcome', { candidateDigest: authorityDigest(domain.proposed), incumbentDigest: authorityDigest(domain.source), winner: 'incumbent' });
      assert(assertSignedRefinementRecord(record) === record, `${domain.key}: original record verifies`);
      let rejected = false;
      try { assertSignedRefinementRecord({ ...record, winner: 'candidate' }); } catch { rejected = true; }
      assert(rejected, `${domain.key}: changing the winner breaks the digest`);
    }
  },
}];
