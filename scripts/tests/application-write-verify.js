import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WRITE_VERIFY_PROTOCOL, WRITE_VERIFY_STAGES, WRITE_VERIFY_MAX_FIT_CORRECTIONS, acceptedWriteVerifyCandidates,
  factCorrectionTransition, fullApprovedHand, initialWriteVerifyState, isWriteVerifyJob,
  validateWriteVerifyRanking, writeVerifyCandidateCount,
  writeVerifyChangedFindingErrors, writeVerifyFactFindingErrors,
  writeVerifyNextAfterCandidate, writeVerifySourcePrompt, writeVerifyStageKey, writeVerifyPrompt,
} from '../../electron/ipc/applicationWriteVerify.js';
import {
  APPLICATION_V2_LIMITS, ApplicationV2LimitError,
  assertApplicationV2PromptLimit, assertApplicationV2ReplyLimit,
} from '../../electron/ipc/applicationV2Limits.js';
import { classifySubmission } from '../../electron/ipc/handoffBridge/preflight.js';
import { createSyntheticPreflightSource } from '../../electron/ipc/handoffBridge/sources/syntheticPreflight.js';
import { createHandoffCodeGuard } from '../../electron/ipc/handoffBridge/lanes.js';
import { pasteRejectionCheckIds } from '../../electron/ipc/localAiApplication.js';
import { writeVerifyLengthBudgetForStructure, writeVerifyLengthBudgets } from '../../electron/ipc/applicationV2LengthBudget.js';
import { makeServedBody } from '../../electron/ipc/handoffBridge/framing.js';
import { normalizeCurrentHandoff } from '../../electron/ipc/handoffBridge/lanes.js';
import { __pasteUnitGroundingErrorsForTests } from '../../electron/ipc/localAiApplication.js';
import { buildApplicationCareerAuthority } from '../../electron/ipc/applicationCareerAuthority.js';
import { approvedCareerEvidenceCatalog, CAREER_SNAPSHOT_STATUS_APPROVED } from '../../electron/ipc/careerSnapshot.js';
import { assessStrengthFamily } from '../../electron/ipc/applicationClaimGrounding.js';
import { MAX_REQUIREMENTS_REEPOCHS, requirementsAdjudicationBindings, requirementsBindingErrors, requirementsAuditCapTerminal } from '../../electron/ipc/applicationRequirementsAuditPolicy.js';
import { applicationProtocolSetting } from '../../electron/ipc/applicationProtocolSetting.js';
import { v2RejectionEvidencePaths } from '../../electron/ipc/applicationV2RejectionEvidence.js';
import { splitWriteVerifyWriterResponse, v2WriterShortlistEvidencePaths } from '../../electron/ipc/applicationV2WriterShortlist.js';

const domains = [
  ['freight', 'dispatch'], ['clinic', 'scheduling'], ['library', 'cataloguing'],
];
const JOB_ID = '11111111-1111-4111-8111-111111111111';

export default [
  {
    name: 'v2 writer shortlist is a working step retained outside conversion across three synthetic careers',
    run() {
      for (const [domain, action] of domains) {
        const ids = Array.from({ length: 6 }, (_, index) => `host.career.achievement.${domain}-${index + 1}.1`);
        const state = initialWriteVerifyState(1);
        const envelope = { protocol: 'paste-application.v1', jobId: JOB_ID, stage: 'write' };
        const writePrompt = writeVerifyPrompt({ stage: 'write', state, sourcePrompt: `${domain} posting and full grouped catalog`, envelope });
        assert.ok(writePrompt.includes('Before the résumé, list the 6–10 strongest true evidence items'), domain);
        assert.ok(writePrompt.includes('EVIDENCE SHORTLIST (WORKING NOTES)'), domain);
        const response = `EVIDENCE SHORTLIST (WORKING NOTES)\n\n${ids.map((id, index) => `${index + 1}. ${id} — ${action} reason ${index + 1}.`).join('\n')}\n\nRÉSUMÉ\n${action} work.\n\nCOVER LETTER\nI would bring ${action} experience.`;
        const separated = splitWriteVerifyWriterResponse(response, ids);
        assert.equal(separated.shortlist.split('\n').length, 6, domain);
        assert.ok(separated.shortlist.includes(ids[0]), domain);
        assert.ok(!separated.plainText.includes('EVIDENCE SHORTLIST') && !separated.plainText.includes(ids[0]), domain);
        const withWorkingNote = response.replace('\n\nRÉSUMÉ', '\n\nThe source supports a short application.\n\nRÉSUMÉ');
        assert.ok(!splitWriteVerifyWriterResponse(withWorkingNote, ids).plainText.includes('The source supports'), domain);
        state.candidates[0].plainText = separated.plainText;
        const convertPrompt = writeVerifyPrompt({ stage: 'convert', state, sourcePrompt: `${domain} posting and full grouped catalog`, envelope });
        assert.ok(convertPrompt.includes(`RÉSUMÉ\n${action} work.`), domain);
        assert.ok(!convertPrompt.includes('EVIDENCE SHORTLIST') && !convertPrompt.includes(`${action} reason`), domain);
        assert.throws(() => splitWriteVerifyWriterResponse(response.replace(ids[0], 'host.career.achievement.invented.1'), ids), /approved catalog ID/, domain);
        assert.throws(() => splitWriteVerifyWriterResponse(response.replace(ids[1], ids[0]), ids), /must be distinct/, domain);
        assert.throws(() => splitWriteVerifyWriterResponse(response.replace('EVIDENCE SHORTLIST (WORKING NOTES)', 'WORKING NOTES'), ids), /must begin with EVIDENCE SHORTLIST/, domain);
        assert.throws(() => splitWriteVerifyWriterResponse(`${response}\n${ids[0]}`, ids), /must not contain catalog evidence IDs/, domain);
        assert.throws(() => splitWriteVerifyWriterResponse(`${response}\nEVIDENCE SHORTLIST (WORKING NOTES)`, ids), /must stay before the résumé/, domain);
        assert.throws(() => splitWriteVerifyWriterResponse(response.replace('COVER LETTER\n', 'This résumé mentions a cover letter.\n'), ids), /nonempty résumé and cover letter sections/, domain);
        assert.throws(() => splitWriteVerifyWriterResponse(response.replace(`RÉSUMÉ\n${action} work.`, 'RÉSUMÉ'), ids), /nonempty résumé and cover letter sections/, domain);
        assert.throws(() => splitWriteVerifyWriterResponse(response.replace(`I would bring ${action} experience.`, ''), ids), /nonempty résumé and cover letter sections/, domain);
        assert.ok(writePrompt.includes('standalone COVER LETTER heading'), domain);
        // Sabotage: storing the unseparated response would send working notes to conversion.
        state.candidates[0].plainText = response;
        const sabotagedPrompt = writeVerifyPrompt({ stage: 'convert', state, sourcePrompt: `${domain} posting and full grouped catalog`, envelope });
        assert.ok(sabotagedPrompt.includes('EVIDENCE SHORTLIST') && sabotagedPrompt.includes(`${action} reason`), domain);
        const paths = v2WriterShortlistEvidencePaths(path.join(os.tmpdir(), '.local-ai', 'jobs', JOB_ID), JOB_ID,
          `revision-1-write-${'a'.repeat(64)}.json`);
        assert.ok(paths.retained.includes(`${path.sep}.local-ai${path.sep}writer-shortlists${path.sep}`), domain);
        assert.ok(!paths.retained.includes(`${path.sep}jobs${path.sep}`), domain);
      }
    },
  },
  {
    name: 'v2 rejection evidence remains outside the removed private job directory',
    async run() {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-rejection-evidence-'));
      const jobDir = path.join(root, '.local-ai', 'jobs', JOB_ID);
      const filename = `revision-2-convert-${'a'.repeat(64)}.json`;
      try {
        for (const [domain] of domains) {
          const paths = v2RejectionEvidencePaths(jobDir, JOB_ID, filename);
          assert(paths.working.startsWith(jobDir + path.sep), domain);
          assert(!paths.retained.startsWith(jobDir + path.sep), domain);
          fs.mkdirSync(path.dirname(paths.working), { recursive: true });
          fs.mkdirSync(path.dirname(paths.retained), { recursive: true });
          fs.writeFileSync(paths.working, domain);
          fs.writeFileSync(paths.retained, domain);
          fs.rmSync(jobDir, { recursive: true, force: true });
          assert.equal(fs.readFileSync(paths.retained, 'utf8'), domain);
          // Sabotage: retaining a second copy below jobs/<id> loses the proof.
          assert(!paths.retained.includes(`${path.sep}jobs${path.sep}${JOB_ID}${path.sep}`), domain);
        }
        assert.throws(() => v2RejectionEvidencePaths(jobDir, JOB_ID, '../escape.json'));
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'application protocol setting defaults to v2 and preserves explicit legacy',
    run() {
      assert.equal(applicationProtocolSetting(undefined), WRITE_VERIFY_PROTOCOL);
      assert.equal(applicationProtocolSetting('unexpected'), WRITE_VERIFY_PROTOCOL);
      assert.equal(applicationProtocolSetting(WRITE_VERIFY_PROTOCOL), WRITE_VERIFY_PROTOCOL);
      assert.equal(applicationProtocolSetting('legacy'), 'legacy');
    },
  },
  {
    name: 'fact-check correction retries format and truth failures before recheck or ranked fallback',
    run() {
      for (const [domain] of domains) {
        const first = factCorrectionTransition({ priorRound: 0, failed: true, factIndex: 0, rankedCount: 2 });
        assert.deepEqual(first, { round: 1, factIndex: 0, nextStage: 'fact-correction' }, domain);
        const recovered = factCorrectionTransition({ priorRound: first.round, failed: false, factIndex: 0, rankedCount: 2 });
        assert.equal(recovered.nextStage, 'fact-recheck', domain);
        const second = factCorrectionTransition({ priorRound: first.round, failed: true, factIndex: 0, rankedCount: 2 });
        assert.equal(second.nextStage, 'fact-correction', domain);
        const exhausted = factCorrectionTransition({ priorRound: second.round, failed: true, factIndex: 0, rankedCount: 2 });
        assert.deepEqual(exhausted, { round: 3, factIndex: 1, nextStage: 'fact-check' }, domain);
        const terminal = factCorrectionTransition({ priorRound: second.round, failed: true, factIndex: 1, rankedCount: 2 });
        assert.equal(terminal.nextStage, 'write-verify-human-stop', domain);
        // Sabotage: restoring the one-attempt policy must fail this proof.
        assert.notEqual(factCorrectionTransition({ priorRound: 0, failed: true, factIndex: 0,
          rankedCount: 2, maxRounds: 1 }).nextStage, first.nextStage, domain);
      }
    },
  },
  {
    name: 'converter instructions require full catalog ids and entity-correct citations across three careers',
    run() {
      for (const [domain, action] of domains) {
        const roleId = `role-${domain}`;
        const skillId = `skill-${domain}`;
        const profile = {
          roles: [{ id: roleId }], achievements: [{ id: `achievement-${domain}`, roleId }],
          projects: [{ id: `project-${domain}`, roleId, name: `${domain} console` }],
          skills: [{ id: skillId, name: `${action} systems`, indexEligible: true }],
          education: [], certifications: [], otherEvidence: [],
        };
        const catalog = [
          { id: `host.career.role.${roleId}.1`, quote: `${domain} role` },
          { id: `host.career.achievement.achievement-${domain}.1`, quote: `${action} work` },
          { id: `host.career.project.project-${domain}.1`, quote: `${domain} project` },
          { id: `host.career.skill.${skillId}.1`, quote: `${action} skill` },
        ];
        const sourcePrompt = writeVerifySourcePrompt({ posting: `${domain} posting`, requirements: [],
          listingEvidence: [], identity: {}, sourceRoles: [], profile, catalog });
        const state = initialWriteVerifyState(1);
        state.candidates[0].plainText = `${domain} résumé and letter`;
        const prompt = writeVerifyPrompt({ stage: 'convert', state, sourcePrompt,
          envelope: { protocol: 'paste-application.v1', jobId: JOB_ID, stage: 'convert' } });
        assert.ok(prompt.includes(`host.career.skill.${skillId}.1`), domain);
        assert.ok(prompt.includes('a short entity ID such as p0001-ach-2 is never a catalog citation ID'), domain);
        assert.ok(prompt.includes('Achievement or project quote IDs cannot be skill-group citations'), domain);
        assert.ok(prompt.includes('A project needs project quote IDs'), domain);
        assert.ok(prompt.includes('written as "Title at Company"'), domain);
      }
    },
  },
  {
    name: 'requirements adjudication binds a disputed unit and stops after two re-epochs across three synthetic postings',
    run() {
      const postings = [
        { domain: 'freight', unit: 'u-freight', quote: 'Maintain route manifests for freight dispatch.' },
        { domain: 'clinic', unit: 'u-clinic', quote: 'Coordinate appointment schedules for clinic visits.' },
        { domain: 'library', unit: 'u-library', quote: 'Preserve catalog records for circulating books.' },
      ];
      assert.equal(MAX_REQUIREMENTS_REEPOCHS, 2);
      for (const posting of postings) {
        const prior = [{ rows: [{ unitId: posting.unit, disposition: 'not-a-requirement' }] }];
        const bindings = requirementsAdjudicationBindings(prior, [{ id: posting.unit, text: posting.quote }]);
        assert.deepEqual(bindings, [{ unitId: posting.unit, disposition: 'not-a-requirement' }]);
        assert.deepEqual(requirementsBindingErrors([{ unitId: posting.unit, disposition: 'not-a-requirement' }], bindings), []);
        const mutation = [{ unitId: posting.unit, disposition: 'requirement' }];
        assert.match(requirementsBindingErrors(mutation, bindings)[0], /prior independent adjudicator.*binding disposition/);
        assert.equal(requirementsAuditCapTerminal(0, [posting.unit]), null);
        assert.equal(requirementsAuditCapTerminal(1, [posting.unit]), null);
        const terminal = requirementsAuditCapTerminal(2, [posting.unit]);
        assert.equal(terminal.kind, 'requirements-audit-disagreement');
        assert.equal(terminal.reason, 'audit-re-epoch-cap');
        assert.deepEqual(terminal.disputedUnitIds, [posting.unit]);
        assert.ok(terminal.message.includes(posting.unit));
        const repeated = requirementsAuditCapTerminal(1, [posting.unit], bindings);
        assert.equal(repeated.reason, 'prior-adjudication-conflict');
        assert.ok(repeated.message.includes(posting.unit));
        // Sabotage proof: the same assertions reject a binding bypass and an unbounded audit loop.
        const assertBinding = gate => assert.match(gate(mutation, bindings)[0], /prior independent adjudicator.*binding disposition/);
        const assertCap = gate => assert.equal(gate(2, [posting.unit])?.kind, 'requirements-audit-disagreement');
        assertBinding(requirementsBindingErrors);
        assertCap(requirementsAuditCapTerminal);
        assert.throws(() => assertBinding(() => []), /string/);
        assert.throws(() => assertCap(() => null), /requirements-audit-disagreement/);
      }
      assert.throws(() => requirementsAdjudicationBindings([
        { rows: [{ unitId: 'u-one', disposition: 'requirement' }] },
        { rows: [{ unitId: 'u-one', disposition: 'not-a-requirement' }] },
      ]), /conflicting binding decisions/);
      const source = fs.readFileSync(new URL('../../electron/ipc/localAiApplication.js', import.meta.url), 'utf8');
      assert.ok(source.includes('requirementsBindingErrors(coverage, source.bindingRows)')
        && source.includes('requirementsAuditCapTerminal(page.epoch, disagreement.differingUnitIds, bindingRows)')
        && source.includes('bindingRows = await authorityPriorAdjudicationBindings(store, epoch.epoch, windowUnits)'),
      'production discovery and audit paths must invoke both binding and cap checks');
    },
  },
  {
    name: 'v2 frozen target title and company license only target references across three synthetic jobs',
    run() {
      const jobs = [
        { title: 'Freight Systems Engineer', company: 'Harbor Logistics', work: 'dispatch rosters for freight routes' },
        { title: 'Clinic Operations Analyst', company: 'Cedar Care', work: 'intake schedules for clinic visits' },
        { title: 'Library Catalog Specialist', company: 'Willow Libraries', work: 'catalog records for library books' },
      ];
      for (const { title, company, work } of jobs) {
        const args = {
          unitLabel: 'Cover-letter paragraph', unitId: 'p1', label: 'coverLetterParagraphs',
          evidenceIds: ['e1'], acceptedEvidence: [{ id: 'e1', sourceId: 'career-data',
            quote: `I maintained ${work} and coordinated updates with the team during regular operations.` }],
          identityTokens: [], targetTitle: title, targetCompany: company,
          postingText: `${title} at ${company}`,
        };
        const target = `I maintained ${work}. The ${title} role appeals to me because it involves this work.`;
        const errors = text => __pasteUnitGroundingErrorsForTests({ ...args, finalText: text });
        assert.deepEqual(errors(target), [], `${title}: target title is licensed`);
        assert.deepEqual(errors(`I maintained ${work}. I would bring this work to ${company}.`), [], `${company}: target employer is licensed`);
        assert.ok(errors(`I worked as a ${title} on ${work}.`).some(error => error.includes('names')), `${title}: past title mutation fails`);
        assert.ok(errors(`I maintained ${work} at ${company}.`).some(error => error.includes('names')), `${company}: past employer mutation fails`);
        assert.ok(errors(`I maintained ${work}. The Orbital Systems Engineer role appeals to me because it involves this work.`)
          .some(error => error.includes('Orbital Systems Engineer')), `${title}: unlisted title mutation fails`);
        assert.ok(__pasteUnitGroundingErrorsForTests({ ...args, targetTitle: '', finalText: target })
          .some(error => error.includes('names')), `${title}: removing the frozen-title binding restores rejection`);
      }
    },
  },
  {
    name: 'v2 authorship disposition is scoped to a bound approved entity across three synthetic domains',
    run() {
      for (const [domain, object] of [['freight', 'dispatch rosters for freight routes'], ['clinic', 'intake forms for clinic visits'], ['library', 'catalogue cards for library books']]) {
        const segment = `segment-${domain}`;
        const achievement = (id, claim, disposition, technology = object) => ({ id, roleId: 'role-a', claim, technologies: [technology],
          technologyReferences: [{ technology, disposition: 'non-skill', nonSkillReason: disposition,
            relationship: 'independent', relationshipGroup: '', relationshipEvidence: technology, evidenceSegmentIds: [segment] }],
          metrics: [], evidenceSegmentIds: [segment] });
        const profile = { identity: { name: 'Pat Example', contacts: ['pat@example.test'], evidenceSegmentIds: [segment] },
          roles: [{ id: 'role-a', title: 'Coordinator', employer: 'Harbor Services', startDate: 'March 2019', endDate: 'Present', location: '',
            achievementIds: ['ach-a', 'ach-b'], skillIds: [], evidenceSegmentIds: [segment] }],
          achievements: [achievement('ach-a', `- Maintained ${object}.`, 'Authored outputs.'),
            achievement('ach-b', '- Maintained unrelated records for the department.', 'Authored outputs.', 'unrelated records')],
          projects: [], skills: [], education: [], certifications: [], otherEvidence: [], segmentCoverage: [] };
        const snapshot = { snapshotId: `synthetic-${domain}`, status: CAREER_SNAPSHOT_STATUS_APPROVED, profile };
        const catalog = approvedCareerEvidenceCatalog(snapshot);
        const authority = buildApplicationCareerAuthority(snapshot);
        const detail = catalog.find(row => row.id.startsWith('host.career.achievement.ach-a.') && row.quote.includes(`Maintained ${object}`));
        const sibling = catalog.find(row => row.id.startsWith('host.career.achievement.ach-a.') && row.quote.includes('Authored outputs.'));
        const foreign = catalog.find(row => row.id.startsWith('host.career.achievement.ach-b.') && row.quote.includes('Authored outputs.'));
        const attempt = evidenceIds => __pasteUnitGroundingErrorsForTests({ unitLabel: 'Bullet', unitId: 'b1',
          finalText: `Built ${object}.`, evidenceIds, acceptedEvidence: catalog, identityTokens: [], label: 'resumeBullets',
          sourceRoles: authority.sourceRoles, careerData: '', authority, projects: [], targetCompany: '' });
        assert.deepEqual(attempt([detail.id, sibling.id]), [], `${domain}: bound same-entity authorship passes`);
        assert.ok(attempt([detail.id]).some(error => error.includes('implementation authorship')), `${domain}: removing sibling fails`);
        assert.ok(attempt([detail.id, foreign.id]).some(error => error.includes('implementation authorship')), `${domain}: foreign entity fails`);
        const sabotage = assessStrengthFamily('author', `Built ${object}.`, [detail.quote, sibling.quote],
          { meaningful: value => String(value).toLowerCase().match(/[a-z]+/gu) || [], trustedNames: [] });
        assert.ok(sabotage?.match, `${domain}: removing entity-bound sibling context restores the false rejection`);
      }
    },
  },
  {
    name: 'v2 approved hand includes every full quote, grouped by authority entity for three unrelated synthetic careers',
    run() {
      for (const [domain, work] of domains) {
        const role = { id: `role-${domain}` };
        const achievement = { id: `achievement-${domain}`, roleId: role.id };
        const skill = { id: `skill-${domain}` };
        const profile = { roles: [role], achievements: [achievement], projects: [], skills: [skill], education: [], certifications: [], otherEvidence: [] };
        const catalog = [
          { id: `host.career.role.${role.id}.1`, quote: `${domain} role quote` },
          { id: `host.career.achievement.${achievement.id}.1`, quote: `${work} achievement full quote` },
          { id: `host.career.skill.${skill.id}.1`, quote: `${work} skill quote` },
        ];
        const hand = fullApprovedHand(profile, catalog);
        for (const row of catalog) assert.ok(hand.includes(`[${row.id}] ${row.quote}`));
        assert.ok(hand.indexOf(catalog[0].id) < hand.indexOf(catalog[1].id));
        assert.ok(hand.indexOf(catalog[1].id) < hand.indexOf(catalog[2].id));
        assert.throws(() => fullApprovedHand(profile, [...catalog, { id: 'host.career.other.unowned.1', quote: 'orphan' }]), /omitted/);
      }
    },
  },
  {
    name: 'v2 candidate count, drop, accepted-only rank, and fresh stage keys fail closed',
    run() {
      assert.equal(writeVerifyCandidateCount(), 3);
      assert.equal(initialWriteVerifyState().candidates.length, 3);
      assert.equal(writeVerifyCandidateCount(8), 8);
      assert.throws(() => writeVerifyCandidateCount(0));
      const state = initialWriteVerifyState(5);
      assert.equal(state.version, WRITE_VERIFY_PROTOCOL);
      assert.equal(state.candidates.length, 5);
      assert.ok(WRITE_VERIFY_STAGES.includes('fact-recheck'));
      assert.ok(WRITE_VERIFY_STAGES.includes('fit-correction'));
      assert.equal(WRITE_VERIFY_MAX_FIT_CORRECTIONS, 4);
      assert.equal(isWriteVerifyJob({ applicationProtocol: WRITE_VERIFY_PROTOCOL }), true);
      assert.equal(isWriteVerifyJob({ authorityProtocol: 'requirements-ledger.v3' }), false);
      state.candidates.forEach(row => { row.status = 'dropped'; });
      assert.equal(writeVerifyNextAfterCandidate(state), 'write-verify-human-stop');
      state.candidates[2].status = 'accepted';
      assert.equal(writeVerifyNextAfterCandidate(state), 'fact-check');
      assert.deepEqual(state.ranking, ['candidate-3']);
      state.candidates[4].status = 'accepted';
      assert.equal(writeVerifyNextAfterCandidate(state), 'pick');
      const inFlight = structuredClone(state);
      inFlight.selectionPolicy = 'first-accepted';
      assert.equal(writeVerifyNextAfterCandidate(inFlight), 'fact-check');
      assert.deepEqual(inFlight.ranking, ['candidate-3']);
      assert.deepEqual(acceptedWriteVerifyCandidates(state).map(row => row.id), ['candidate-3', 'candidate-5']);
      assert.throws(() => validateWriteVerifyRanking(['candidate-1'], ['candidate-3']));
      state.ordinal = 2;
      assert.notEqual(writeVerifyStageKey(state, 'write', JOB_ID), writeVerifyStageKey(state, 'convert', JOB_ID));
      assert.notEqual(writeVerifyStageKey(state, 'fact-check', JOB_ID), writeVerifyStageKey(state, 'fact-recheck', JOB_ID));
      const prompt = writeVerifyPrompt({ stage: 'pick', state, posting: 'Synthetic dispatch posting',
        hand: 'Synthetic freight evidence', envelope: { jobId: 'synthetic' } });
      assert.ok(prompt.includes('do not score candidate-job fit') && prompt.includes('strongest true evidence'));
      assert.ok(prompt.includes('candidate-3:') && !prompt.includes('candidate-1:'));
      assert.ok(prompt.includes('page PNGs') && prompt.includes('evidenceSelection 0-20'));
      state.ranking = ['candidate-5', 'candidate-3'];
      state.factIndex = 1;
      assert.equal(writeVerifyStageKey(state, 'fact-check', JOB_ID), `v2:${JOB_ID}:candidate-3:fact-check`);
      const absentCandidate = structuredClone(state);
      absentCandidate.ordinal = 99;
      assert.throws(() => writeVerifyStageKey(absentCandidate, 'write', JOB_ID), /current candidate/);
      const unrankedCandidate = structuredClone(state);
      unrankedCandidate.ranking = ['candidate-1'];
      unrankedCandidate.factIndex = 0;
      assert.throws(() => writeVerifyStageKey(unrankedCandidate, 'fact-check', JOB_ID), /ranked accepted candidate/);
      const invalidJudge = structuredClone(state);
      invalidJudge.elimination = { round: -1 };
      assert.throws(() => writeVerifyStageKey(invalidJudge, 'pick', JOB_ID), /valid judge round/);
      const images = [{ candidateId: 'candidate-3', document: 'resume', mimeType: 'image/png', data: 'aGVsbG8=' },
        { candidateId: 'candidate-3', document: 'cover-letter', mimeType: 'image/png', data: 'aGVsbG8=' },
        { candidateId: 'candidate-5', document: 'resume', mimeType: 'image/png', data: 'aGVsbG8=' },
        { candidateId: 'candidate-5', document: 'cover-letter', mimeType: 'image/png', data: 'aGVsbG8=' }];
      const current = normalizeCurrentHandoff({ code: 'code', stage: 'pick', prompt, pageImages: images });
      const served = makeServedBody({ lane: { current }, remaining: {} });
      assert.deepEqual(served.pageImageOrder, images.map(({ candidateId, document }) => ({ candidateId, document })));
      assert.deepEqual([...new Set(served.pageImageOrder.map(row => row.candidateId))], acceptedWriteVerifyCandidates(state).map(row => row.id));
    },
  },
  {
    name: 'v2 measured-fit rejection has its own check id and separate round cap',
    run() {
      const wording = 'résumé is 2 pages (target: 1). Continue the Local AI routine with measured revision 1 using fit-feedback.json; there is no fixed revision limit.';
      assert.deepEqual(pasteRejectionCheckIds([wording]).checkIds, ['measured-one-page-fit']);
      const state = initialWriteVerifyState(1);
      state.candidates[0].status = 'fit-correcting';
      state.candidates[0].corrections = 3;
      state.candidates[0].fitCorrections = 2;
      assert.equal(writeVerifyNextAfterCandidate(state), 'fit-correction');
      assert.equal(state.candidates[0].corrections, 3);
    },
  },
  {
    name: 'v2 fact finding blocks an unchanged span and requires a fresh whole-document recheck',
    run() {
      const documents = { resume: { roles: [{ bullets: [{ id: 'bullet-1', text: 'Built a service used by 40 people.' }] }] }, coverLetter: { paragraphs: [] } };
      const findings = [{ id: 'bullet-1', claim: '40 people', reason: 'Source says 4 people.' }];
      assert.deepEqual(writeVerifyFactFindingErrors(findings, documents), []);
      assert.equal(writeVerifyChangedFindingErrors(findings, documents).length, 1);
      const corrected = structuredClone(documents);
      corrected.resume.roles[0].bullets[0].text = 'Built a service used by 4 people.';
      assert.deepEqual(writeVerifyChangedFindingErrors(findings, corrected), []);
      assert.deepEqual(writeVerifyChangedFindingErrors(findings, { resume: { roles: [] }, coverLetter: { paragraphs: [] } }), []);
      assert.equal(writeVerifyFactFindingErrors([{ ...findings[0], claim: 'fifty people' }], documents).length, 1);
    },
  },
  {
    name: 'v2 prompt, transport, and plain-text bridge limits are explicit',
    run() {
      assert.equal(APPLICATION_V2_LIMITS.chatReplyTokens, 16_384);
      assert.equal(APPLICATION_V2_LIMITS.chatPromptChars, 250_000);
      assert.equal(APPLICATION_V2_LIMITS.bridgeRequestBytes, 2 * 1024 * 1024);
      assert.equal(APPLICATION_V2_LIMITS.bridgeToolResultBytes, 2 * 1024 * 1024);
      assert.equal(assertApplicationV2PromptLimit('x'.repeat(250_000)).chars, 250_000);
      assert.throws(() => assertApplicationV2PromptLimit('x'.repeat(250_001)), ApplicationV2LimitError);
      assert.throws(() => assertApplicationV2ReplyLimit('x'.repeat(2 * 1024 * 1024)), ApplicationV2LimitError);
      const plain = 'Résumé\nA concise role accomplishment.\nCover letter\nA sourced argument for the role.';
      const lane = { jobId: 'job-1', current: { stage: 'write', code: 'code-1' }, acceptedFingerprints: new Set() };
      assert.equal(classifySubmission({ response: plain, lane }), 'pass');
      lane.current.stage = 'convert';
      assert.equal(classifySubmission({ response: plain, lane }), 'junk');
    },
  },
  {
    name: 'v2 measured character ranges respond to trusted role, project, skill and education structure',
    run() {
      const roleHeavy = writeVerifyLengthBudgetForStructure({ roles: 3, education: 1, skillsRows: 3, projects: 0 });
      const projectHeavy = writeVerifyLengthBudgetForStructure({ roles: 3, education: 1, skillsRows: 1, projects: 3 });
      assert.ok(roleHeavy.minCharacters >= roleHeavy.maxCharacters * 0.84 && roleHeavy.maxCharacters > 1095);
      assert.ok(projectHeavy.maxCharacters !== roleHeavy.maxCharacters);
      assert.ok(projectHeavy.maxBullets < roleHeavy.maxBullets);
      const variants = writeVerifyLengthBudgets({ education: [{}], skills: [{}, {}, {}], projects: [{}, {}, {}] }, [{}, {}, {}]);
      assert.deepEqual(variants, [roleHeavy, projectHeavy]);
      assert.throws(() => writeVerifyLengthBudgetForStructure({ roles: -1, education: 0, skillsRows: 0, projects: 0 }));
    },
  },
  {
    name: 'v2 synthetic checksum ramp is inaccessible outside test mode and never claims an application job',
    async run() {
      assert.throws(() => createSyntheticPreflightSource({ testMode: false, codeGuard: createHandoffCodeGuard() }), /requires test mode/);
      const probe = createSyntheticPreflightSource({ testMode: true, codeGuard: createHandoffCodeGuard() });
      const lane = { jobId: probe.jobId, canvasFilePath: probe.canvasFilePath };
      for (const size of [140_000, 200_000, 300_000]) {
        const read = await probe.source.read(lane);
        assert.equal(read.kind, 'open');
        assert.ok(read.handoff.prompt.includes('NO APPLICATION JOB'));
        assert.ok(read.handoff.prompt.length > size);
        const digest = /SHA256=([a-f0-9]{64})$/.exec(read.handoff.prompt)?.[1];
        assert.ok(digest);
        const rejected = await probe.source.submit(lane, { code: read.handoff.code, text: 'SHA256=wrong' });
        assert.equal(rejected.kind, 'rejected');
        const accepted = await probe.source.submit(lane, { code: read.handoff.code, text: `SHA256=${digest}` });
        assert.equal(accepted.kind, 'accepted');
      }
      assert.equal(probe.progress().completed, 3);
    },
  },
];
