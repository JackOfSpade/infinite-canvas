import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WRITE_VERIFY_BRIEF, WRITE_VERIFY_BRIEF_MAX_CHARS, WRITE_VERIFY_JUDGE_RUBRIC, WRITE_VERIFY_SHORTLIST_STEP,
  WRITE_VERIFY_PROTOCOL, WRITE_VERIFY_DEFAULT_CANDIDATES, WRITE_VERIFY_STAGES, WRITE_VERIFY_MAX_FIT_CORRECTIONS, acceptedWriteVerifyCandidates,
  WRITE_VERIFY_DROPPED_FINDINGS_HEADING, WRITE_VERIFY_DROPPED_FINDINGS_MAX, droppedCandidateFindings,
  WRITE_VERIFY_PRIOR_ROUND_FINDINGS_MAX, WRITE_VERIFY_PRIOR_ROUNDS_HEADING, priorRoundFindings,
  factCorrectionTransition, fullApprovedHand, initialWriteVerifyState, isWriteVerifyJob,
  validateWriteVerifyRanking, writeVerifyCandidateCount,
  writeVerifyChangedFindingErrors, writeVerifyFactFindingErrors, writeVerifyUnitText, writeVerifyUnitListing,
  writeVerifyRankingErrors, writeVerifyRankingShapeError, writeVerifyRankingReasonErrors, WRITE_VERIFY_REJECTION_HEADING,
  writeVerifyNextAfterCandidate, writeVerifySourcePrompt, writeVerifyStageKey, writeVerifyPrompt,
} from '../../electron/ipc/applicationWriteVerify.js';
import {
  APPLICATION_V2_LIMITS, ApplicationV2LimitError,
  assertApplicationV2PromptLimit, assertApplicationV2ReplyLimit,
} from '../../electron/ipc/applicationV2Limits.js';
import { extractEditorialPlanSource } from '../../electron/ipc/applicationEditorialPlan.js';
import { classifySubmission } from '../../electron/ipc/handoffBridge/preflight.js';
import { createSyntheticPreflightSource } from '../../electron/ipc/handoffBridge/sources/syntheticPreflight.js';
import { createHandoffCodeGuard } from '../../electron/ipc/handoffBridge/lanes.js';
import { __persistedValidatorBuildForTests, __setApplicationValidatorStampForTests, applicationValidatorStamp, pasteRejectionCheckIds } from '../../electron/ipc/localAiApplication.js';
import { writeVerifyLengthBudgetForStructure, writeVerifyLengthBudgets } from '../../electron/ipc/applicationV2LengthBudget.js';
import { makeServedBody } from '../../electron/ipc/handoffBridge/framing.js';
import { normalizeCurrentHandoff } from '../../electron/ipc/handoffBridge/lanes.js';
import { __pasteUnitGroundingErrorsForTests } from '../../electron/ipc/localAiApplication.js';
import { buildApplicationCareerAuthority } from '../../electron/ipc/applicationCareerAuthority.js';
import { approvedCareerEvidenceCatalog, CAREER_SNAPSHOT_STATUS_APPROVED } from '../../electron/ipc/careerSnapshot.js';
import { assessStrengthFamily, credentialFindings, CLAIM_GROUNDING_RULE } from '../../electron/ipc/applicationClaimGrounding.js';
import {
  LETTER_TERM_FORMS_RULE, MIN_SHARED_SOURCE_TERMS, SOURCE_FIGURE_GROUNDING_RULE, SOURCE_TERM_OVERLAP_RULE, writeVerifyGroundingContract,
} from '../../electron/ipc/localAiApplication.js';
import { MAX_REQUIREMENTS_REEPOCHS, requirementsAdjudicationBindings, requirementsBindingErrors, requirementsAuditCapTerminal, requirementsSingletonBinding } from '../../electron/ipc/applicationRequirementsAuditPolicy.js';
import { applicationProtocolSetting } from '../../electron/ipc/applicationProtocolSetting.js';
import { v2RejectionEvidencePaths } from '../../electron/ipc/applicationV2RejectionEvidence.js';
import { archiveV2Content, v2EvidenceArchiveDirectory, V2_EVIDENCE_MAX_BYTES } from '../../electron/ipc/applicationV2EvidenceArchive.js';
import { splitWriteVerifyWriterResponse, v2WriterShortlistEvidencePaths } from '../../electron/ipc/applicationV2WriterShortlist.js';

const domains = [
  ['freight', 'dispatch'], ['clinic', 'scheduling'], ['library', 'cataloguing'],
];
const JOB_ID = '11111111-1111-4111-8111-111111111111';

export default [
  {
    name: 'v2 newest fit observations supersede older measurements and legacy newest rows stay excluded',
    run() {
      const content = { kind: 'content', errors: ['unit-source-grounding: b1 synthetic defect'] };
      const old = { kind: 'fit', errors: ['measured-one-page-fit: older measurement'] };
      const current = { kind: 'fit', errors: ['measured-one-page-fit: current measurement'] };
      assert.deepEqual(priorRoundFindings([old, content, current], []), [...content.errors, ...current.errors]);
      assert.deepEqual(priorRoundFindings([old, content, { kind: 'fit', errors: ['legacy fit-feedback.json'] }], []), content.errors);
      assert.deepEqual(priorRoundFindings([old, content, current], current.errors), content.errors);
    },
  },

  {
    name: 'v2 correction details preserve strict spans, bound output, and register each rule',
    run: () => {
      const text = `The team's ledger rebuild used five engineers.`;
      const docs = { resume: { roles: [{ bullets: [{ id: 'b1', text }] }] } };
      const check = (finding, ids) => {
        const errors = writeVerifyFactFindingErrors([finding], docs);
        assert.equal(errors.length, 1);
        assert.deepEqual(pasteRejectionCheckIds(errors).checkIds.sort(), ids.sort());
        assert.ok(!errors[0].includes(text));
        return errors[0];
      };
      check({ id: 'roleThesis', claim: 'x', reason: 'bad' }, ['fact-finding-unit']);
      check({ id: 'b1', claim: ' ', reason: ' ' }, ['fact-finding-claim', 'fact-finding-reason']);
      check(null, ['fact-finding-shape']);
      assert.match(check({ id: 'b1', claim: 'ledger...engineers', reason: 'bad' }, ['fact-finding-span']), /one unbroken span/);
      assert.match(check({ id: 'b1', claim: `team${String.fromCharCode(0x2019)}s ledger`, reason: 'bad' }, ['fact-finding-span']), /matches once whitespace/);
      assert.deepEqual(writeVerifyFactFindingErrors([{ id: 'b1', claim: "team's ledger", reason: 'bad' }], docs), []);
      assert.match(writeVerifyFactFindingErrors(null, docs)[0], /^fact-findings-shape:/);
      const many = writeVerifyFactFindingErrors(Array.from({ length: 25 }, () => ({ id: 'b1', claim: 'wrong', reason: 'bad' })), docs);
      assert.equal(many.length, 21);
      assert.match(many[20], /5 more findings/);
    },
  },
  {
    name: 'v2 unit listing includes delivered authored units and ranking errors identify set defects',
    run: () => {
      const docs = { resume: { roles: [{ bullets: [{ id: 'b1', text: 'Synthetic text' }, { text: 'idless' }] }],
        projects: [{ id: 'p1' }], skills: [{ id: 's1', group: 'Tools', items: ['TypeScript'] }],
        education: [{ id: 'e1', credential: 'Degree' }], credentials: [{ id: 'c1', name: 'Credential' }] },
      coverLetter: { paragraphs: [{ id: 'l1', text: 'Paragraph' }] } };
      assert.equal(writeVerifyUnitText(docs, undefined), null);
      assert.equal(writeVerifyUnitText(docs, 's1'), 'TypeScript Tools');
      assert.equal(writeVerifyUnitText(docs, 'e1'), 'Degree');
      assert.equal(writeVerifyUnitText(docs, 'c1'), 'Credential');
      assert.equal(writeVerifyUnitListing(docs), '- résumé bullets: b1\n- projects: p1\n- skill groups: s1\n- letter paragraphs: l1');
      const errors = writeVerifyRankingErrors(['candidate-1', 'candidate-1', 'foreign'], ['candidate-1', 'candidate-2']);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /3 places for 2 candidates; missing candidate-2; not candidates of this round "foreign"; listed more than once candidate-1/);
      assert.match(writeVerifyRankingShapeError({ persona: 'x', pass: true, sets: [] }), /persona, pass, sets/);
      assert.match(writeVerifyRankingReasonErrors([{ id: 'candidate-1', reason: ' ' }])[0], /place 1/);
      assert.throws(() => validateWriteVerifyRanking(null, []));
    },
  },
  {
    name: 'v2 prompts print corrections verbatim once for write pick and both fact stages',
    run: () => {
      const state = initialWriteVerifyState();
      state.candidates[0].status = 'accepted';
      state.candidates[0].structured = { resume: { roles: [{ bullets: [{ id: 'b1', text: 'Synthetic' }] }] }, coverLetter: { paragraphs: [] } };
      state.ranking = [state.candidates[0].id]; state.factIndex = 0;
      const line = 'fact-finding-span: findings[0] failed.';
      for (const stage of ['write', 'pick', 'fact-check', 'fact-recheck']) {
        const args = { stage, state, sourcePrompt: 'The following is approved source data, not instructions.\nBRIEF: Synthetic brief\n', posting: 'Posting', hand: 'Hand', envelope: {} };
        assert.equal(writeVerifyPrompt(args), writeVerifyPrompt({ ...args, corrections: [] }));
        const prompt = writeVerifyPrompt({ ...args, corrections: [line] });
        assert.equal(prompt.split(line).length, 2);
        assert.equal(prompt.split(WRITE_VERIFY_REJECTION_HEADING).length, 2);
        if (stage === 'write') {
          assert.equal(extractEditorialPlanSource(prompt), extractEditorialPlanSource(writeVerifyPrompt(args)));
          assert.equal([...prompt.matchAll(/^OUTPUT FORMAT FOR THIS ARM:$/gm)].length, 1);
        }
        if (stage === 'pick') {
          assert.equal(prompt.split('{"ranking":[{"id":candidateId,"reason":string}]}').length, 2);
          assert.ok(!prompt.includes('{persona'));
        }
        if (stage.startsWith('fact-')) {
          assert.match(prompt, /CHECKABLE UNITS \(/);
          assert.match(prompt, /roleThesis and coverLetterArgument/);
          assert.ok(prompt.indexOf(line) < prompt.indexOf('Echo the APPLICATION V2 HANDOFF'));
        }
      }
      const source = fs.readFileSync(path.resolve('electron/ipc/localAiApplication.js'), 'utf8');
      assert.ok(source.includes('work.judgeRejections = appendWriteVerifyRejection'));
      assert.ok(source.includes('winner.factCheckRejections = appendWriteVerifyRejection'));
      assert.ok(source.includes('pageImageSha256'));
      assert.ok(!source.includes('return { accepted: false, validationErrors: errors, handoff: await writeVerifyHandoffRecord({ jobId, input, state, corrections: errors }) }'));
    },
  },

  {
    name: 'v2 fact prompts flag employment only at the frozen target and retain the generic empty-company fallback',
    run() {
      const state = initialWriteVerifyState(1);
      state.candidates[0].structured = { resume: { roles: [{ company: 'Cedar Works', bullets: [] }] }, coverLetter: { paragraphs: [] } };
      state.ranking = [state.candidates[0].id]; state.factIndex = 0;
      for (const stage of ['fact-check', 'fact-recheck']) {
        for (const targetCompany of ['Northwind Labs', 'Northwind Labs - Platform', '', '   ']) {
          const target = targetCompany.trim() ? JSON.stringify(targetCompany.trim()) : 'the employer this letter is addressed to';
          const expected = `List only actual inflation of ownership, scope, metrics, dates, tools or employment. Employment inflation is any statement or implication that the candidate works at, worked at, joined, left, or was otherwise employed by or affiliated with ${target}, unless ${target} is one of the résumé role companies. Applying to ${target}, wanting to join it, or describing what you would do there is not employment.`;
          const prompt = writeVerifyPrompt({ stage, state, targetCompany, hand: 'Synthetic approved career quotes.', envelope: {} });
          assert.ok(prompt.includes(expected), `${stage}: ${targetCompany || 'empty company'}`);
          assert.equal(prompt.split('Employment inflation is ').length, 2, 'the target-only category occurs exactly once');
          assert.ok(!prompt.includes('dates or tools.'));
        }
      }
      const hostSource = fs.readFileSync(path.resolve('electron/ipc/localAiApplication.js'), 'utf8');
      assert.match(hostSource, /writeVerifyPrompt\(\{ stage: state\.stage, state: state\.writeVerify, \.\.\.context,\s*targetCompany: input\.job\?\.company \|\| ''/u,
        'the host passes its frozen salutation identity, without a poster or model substitution');
    },
  },
  {
    name: 'v2 judge rubric carries grading text only and the pick prompt owns its output format',
    run: () => {
      assert.ok(!WRITE_VERIFY_JUDGE_RUBRIC.includes('Return JSON only'));
      assert.ok(!WRITE_VERIFY_JUDGE_RUBRIC.includes('persona'));
      assert.ok(WRITE_VERIFY_JUDGE_RUBRIC.endsWith('compare the play of the fixed hand.'));
    },
  },
  {
    name: 'v2 fact findings give one learnable line per bad finding without expected source text',
    run: () => {
      for (const domain of ['ledger', 'orchard', 'library']) {
        const text = `I led five engineers on the ${domain} rebuild.`;
        const documents = { resume: { roles: [{ bullets: [{ id: 'bullet-1', text }] }] } };
        const errors = writeVerifyFactFindingErrors([{ id: 'bullet-1', claim: 'led a team of five', reason: 'inflated' }], documents);
        assert.equal(errors.length, 1);
        assert.ok(errors[0].startsWith('fact-finding-span: findings[0].claim'));
        assert.ok(errors[0].includes('its first 4 of 18 characters'));
        assert.ok(!errors[0].includes(text));
        assert.deepEqual(pasteRejectionCheckIds(errors).checkIds, ['fact-finding-span']);
      }
    },
  },

  {
    name: 'write-verify brief: one punctuation rule for both documents, printed once, inside a fixed size budget',
    run() {
      assert.ok(WRITE_VERIFY_BRIEF.length <= WRITE_VERIFY_BRIEF_MAX_CHARS, `the brief is ${WRITE_VERIFY_BRIEF.length} characters against a budget of ${WRITE_VERIFY_BRIEF_MAX_CHARS}`);
      // The rule names the marks the candidate-copy gate refuses and the one it allows, so the writer learns it before writing, not from a rejection.
      for (const mark of ['em dash', 'semicolon', 'hyphen']) assert.ok(WRITE_VERIFY_BRIEF.includes(mark), `the brief names the ${mark}`);
      assert.ok(!/\bcolons?\b/u.test(WRITE_VERIFY_BRIEF), 'the brief no longer bans colons (user decision, 2026-10-20)');
      assert.ok(/either document/u.test(WRITE_VERIFY_BRIEF), 'the rule covers the résumé and the letter alike');
      for (const domain of ['tidal-survey', 'bakehouse', 'observatory']) {
        const prompt = writeVerifySourcePrompt({ posting: `${domain} posting`, requirements: [], listingEvidence: [], identity: {},
          sourceRoles: [], profile: { roles: [], achievements: [], projects: [], skills: [] }, catalog: [] });
        assert.equal(prompt.split(`BRIEF: ${WRITE_VERIFY_BRIEF}`).length, 2, `${domain}: the brief prints exactly once`);
      }
    },
  },
  {
    name: 'write-verify brief frames the letter as a persuasive essay with a hedged thesis, point-first body paragraphs and an argued close',
    run() {
      assert.equal(WRITE_VERIFY_BRIEF_MAX_CHARS, 970, 'the brief budget is fixed at 970 characters (raised on 2026-10-21 for the explicit-link, link-pattern and need-it-meets wording)');
      assert.ok(WRITE_VERIFY_BRIEF.length <= WRITE_VERIFY_BRIEF_MAX_CHARS, `the brief is ${WRITE_VERIFY_BRIEF.length} characters`);
      assert.match(WRITE_VERIFY_BRIEF, /as the cover letter a persuasive essay to the hiring manager/u, 'the letter is written as an essay to a named reader');
      assert.ok(WRITE_VERIFY_BRIEF.includes(" Open on a thesis: the role's main need as you read the posting, framed once as your reading, not a probability, then that you meet it, stated as fact. "), 'the thesis is the writer\u2019s reading, framed once and not as a probability, then the claim of meeting it as fact');
      assert.ok(WRITE_VERIFY_BRIEF.includes(' Start each body paragraph with its full point in one or two sentences'), 'each body paragraph leads with its full point');
      assert.ok(WRITE_VERIFY_BRIEF.includes('Start each body paragraph with its full point in one or two sentences, the kind of work you did and, stated outright for a reader who has not memorized the posting, which of this job\'s needs it meets, then prove it with specific examples, the first set in its time and place. Do not open consecutive paragraphs with the same word or link two paragraphs to the job with the same sentence pattern.'), 'the point states the kind of work and, outright, which of this job\u2019s needs it meets, proved with specific examples, then the paragraph-opener rule');
      assert.equal(WRITE_VERIFY_BRIEF.split("which of this job's needs it meets").length, 2, 'the need-it-meets phrase appears exactly once');
      assert.ok(WRITE_VERIFY_BRIEF.includes('Do not open consecutive paragraphs with the same word or link two paragraphs to the job with the same sentence pattern.'), 'the brief forbids consecutive paragraphs opening with the same word');
      assert.equal(WRITE_VERIFY_BRIEF.includes('where this job needs it'), false, 'the old where-this-job-needs-it wording is gone (user decision, 2026-10-20)');
      assert.equal(WRITE_VERIFY_BRIEF.length, 968, 'the brief is exactly 968 characters after the equal-length unused-proof closing swap');
      assert.equal(WRITE_VERIFY_BRIEF.includes('the need it serves'), false, 'the need-it-serves wording was replaced so the point says the work meets the need (user decision, 2026-10-21)');
      assert.equal(WRITE_VERIFY_BRIEF.includes('in plain words'), false, 'the plain-words wording was replaced by the explicit-link wording (user decision, 2026-10-21)');
      assert.equal(WRITE_VERIFY_BRIEF.includes('a claim about your work this job needs'), false, 'the implicit-link wording is gone');
      assert.match(WRITE_VERIFY_JUDGE_RUBRIC, /The point must name both the candidate's work and the specific part of this job it serves/u);
      assert.match(WRITE_VERIFY_JUDGE_RUBRIC, /a final sentence that only restates the relevance/u);
      assert.match(WRITE_VERIFY_SHORTLIST_STEP, /a line reading exactly EDITORIAL SUMMARY, give a short explanation of the finished application/u);
      assert.ok(WRITE_VERIFY_SHORTLIST_STEP.indexOf('EDITORIAL SUMMARY') > WRITE_VERIFY_SHORTLIST_STEP.indexOf('EVIDENCE SHORTLIST'), 'the explanation follows the evidence appendix');
      assert.match(WRITE_VERIFY_SHORTLIST_STEP, /After the complete letter, add two editorial appendices/u);
      assert.ok(WRITE_VERIFY_BRIEF.includes(' Close on a wider point from unused proof. '), 'the close draws a wider point from proof the body has not used');
      assert.equal(WRITE_VERIFY_BRIEF.includes('End on your argument, not stock courtesy.'), false, 'the old closing sentence is replaced');
      // Sabotage: the replaced letter sentences must be gone, so the brief carries one letter instruction set, not two.
      assert.equal(WRITE_VERIFY_BRIEF.includes('your hedged read'), false, 'the old hedged-read wording is gone');
      assert.equal(WRITE_VERIFY_BRIEF.includes('your read of what the role most needs, hedged once'), false, 'the old thesis wording is gone');
      assert.equal(WRITE_VERIFY_BRIEF.includes('hedged once'), false, 'the hedged-once thesis rule is gone (user decision, 2026-10-20)');
      assert.equal(WRITE_VERIFY_BRIEF.includes('most likely'), false, 'the brief asks for no probability phrase');
      assert.equal(WRITE_VERIFY_BRIEF.includes('Each body paragraph argues one point for it'), false, 'the old paragraph wording is gone');
      assert.equal(WRITE_VERIFY_BRIEF.includes('Lead with the strongest true evidence.'), false, 'the evidence-first sentence is gone');
      assert.equal(WRITE_VERIFY_BRIEF.includes('The letter adds what the quoted evidence states beyond the résumé.'), false);
      assert.match(WRITE_VERIFY_JUDGE_RUBRIC, /the letter argues rather than lists/u, 'the panel that picks the draft rewards the same structure');
      assert.ok(WRITE_VERIFY_JUDGE_RUBRIC.includes('states its full point in its first one or two sentences'), 'the panel rewards point-first paragraphs');
      assert.ok(WRITE_VERIFY_JUDGE_RUBRIC.includes('opens on evidence or only on what the role needs'), 'the panel marks evidence-first paragraphs down');
      assert.ok(WRITE_VERIFY_JUDGE_RUBRIC.includes("a closing of stock courtesy rather than the letter's own argument"), 'the panel marks a courtesy close down');
      assert.ok(WRITE_VERIFY_JUDGE_RUBRIC.includes("a close that retells details or examples the body already gave, however it frames them, or rests on a maxim any applicant could write, instead of drawing a wider point from proof the body has not used"), 'the panel marks an example-recap close down');
      assert.ok(WRITE_VERIFY_JUDGE_RUBRIC.includes('framed once as that reading rather than as a probability'), 'the panel rewards a thesis framed as a reading, not a probability');
      assert.ok(WRITE_VERIFY_JUDGE_RUBRIC.includes('same connective or sentence pattern linking the candidate\'s work to the job in two or more paragraphs'), 'the panel marks a repeated connective down');
      assert.ok(WRITE_VERIFY_JUDGE_RUBRIC.includes('past or present perfect'), 'the panel checks the tense of past work');
      assert.ok(WRITE_VERIFY_JUDGE_RUBRIC.includes('only echoes the posting\'s words without saying which need they answer'), 'the panel marks an echo-only link down');
      assert.ok(WRITE_VERIFY_JUDGE_RUBRIC.includes('names the need with a label instead of plain words'), 'the panel marks a labelled rather than plainly stated need down');
      assert.ok(WRITE_VERIFY_JUDGE_RUBRIC.includes('consecutive paragraphs opening with the same word'), 'the panel marks repeated paragraph openers down');
      assert.match(WRITE_VERIFY_JUDGE_RUBRIC, /two unrelated pieces of work side by side, scores low/u);
    },
  },
  {
    name: 'write-verify brief ends on the word-for-word grounding sentence inside its budget',
    run() {
      const sentence = 'Use a name, acronym, count, year or qualifier word (led, solely, reduced, daily) only where a quote the unit cites states it word for word.';
      assert.ok(WRITE_VERIFY_BRIEF.length <= WRITE_VERIFY_BRIEF_MAX_CHARS, `the brief is ${WRITE_VERIFY_BRIEF.length} characters`);
      assert.ok(WRITE_VERIFY_BRIEF.endsWith(` ${sentence}`), 'the new sentence is the last one');
      assert.equal(WRITE_VERIFY_BRIEF.split('word for word').length, 2, 'stated once');
      // Sabotage: the replaced sentence must be gone.
      assert.equal(WRITE_VERIFY_BRIEF.includes('Never claim more than a cited quote states.'), false);
    },
  },
  {
    name: 'v2 grounding contract is composed from the gate constants and printed once right after the brief only when supplied',
    run() {
      const contract = writeVerifyGroundingContract();
      assert.ok(contract.startsWith(`${CLAIM_GROUNDING_RULE}. Qualifier words are matched by word form, never by meaning, in these families: `), 'claim rule first, then the word-form families');
      assert.equal(contract.split(CLAIM_GROUNDING_RULE).length, 2, 'the claim rule prints once');
      assert.ok(contract.includes('sole ownership (single-handedly, solely, sole, independently, alone, on my own)'), 'sole-ownership forms');
      assert.ok(contract.includes('reduction outcome (reduce(d/s/ing), reduction(s)'), 'reduction forms');
      const employerLicence = 'Name the employer only in a short sentence of its own about its need or your wish to join it';
      assert.equal(contract.includes(employerLicence), false, 'Amendment 6 removes the employer naming instruction');
      assert.equal(WRITE_VERIFY_BRIEF.includes(employerLicence), false, 'the own-sentence rule remains outside the brief');
      assert.ok(contract.includes(`. ${SOURCE_FIGURE_GROUNDING_RULE}. Every sentence about the candidate's own work must share at least ${MIN_SHARED_SOURCE_TERMS} meaningful terms with the quotes its unit cites, where ${SOURCE_TERM_OVERLAP_RULE}, and ${LETTER_TERM_FORMS_RULE}.`), 'figure rule then the unchanged career overlap floor');
      assert.ok(contract.endsWith(`where ${SOURCE_TERM_OVERLAP_RULE}, and ${LETTER_TERM_FORMS_RULE}.`), 'ends on the unchanged career overlap rule, the letter word-form clause and a period');
      assert.equal(/job-listing IDs|closed intent vocabulary/u.test(contract), false, 'no paragraph may substitute listing citations for career evidence');
      assert.ok(contract.includes(`${MIN_SHARED_SOURCE_TERMS} meaningful terms`));
      assert.ok(contract.includes('word form'));
      const heading = 'GROUNDING CONTRACT (deterministic checks read every unit against the quotes it cites, literally): ';
      for (const [domain] of domains) {
        const base = { posting: `${domain} posting`, requirements: [], listingEvidence: [], identity: {},
          sourceRoles: [], profile: { roles: [], achievements: [], projects: [], skills: [] }, catalog: [] };
        const briefLine = `BRIEF: ${WRITE_VERIFY_BRIEF}`;
        const withContract = writeVerifySourcePrompt({ ...base, groundingContract: contract });
        const without = writeVerifySourcePrompt(base);
        assert.equal(withContract.split(heading).length, 2, `${domain}: the section prints exactly once`);
        const briefAt = withContract.indexOf(briefLine);
        assert.ok(briefAt >= 0, domain);
        assert.equal(withContract.indexOf(`${briefLine}\n\n${heading}${contract}\n\n`), briefAt, `${domain}: the section follows the brief line directly`);
        assert.equal(without.includes('GROUNDING CONTRACT'), false, `${domain}: omitted contract prints nothing`);
        assert.equal(writeVerifySourcePrompt({ ...base, groundingContract: '' }), without, `${domain}: an empty contract prints nothing`);
        assert.equal(withContract.replace(`${heading}${contract}\n\n`, ''), without, `${domain}: the section is the only difference`);
      }
      const hostSource = fs.readFileSync(new URL('../../electron/ipc/localAiApplication.js', import.meta.url), 'utf8');
      assert.match(hostSource, /lengthBudget,\s*careerSkillEvidence: hydrated\.skillEvidence,\s*groundingContract: writeVerifyGroundingContract\(\),\s*\}\);/u,
        'the frozen context supplies the same hydrated skill projection and the grounding contract');
    },
  },
  {
    name: 'v2 accepted submissions clear the stale correction list before rejection bookkeeping',
    run() {
      const hostSource = fs.readFileSync(new URL('../../electron/ipc/localAiApplication.js', import.meta.url), 'utf8');
      assert.match(hostSource, /\n {2}if \(!errors\.length\) work\.lastCorrections = \[\];\n {2}if \(errors\.length && \['convert', 'verify-correction', 'fit-correction'\]\.includes\(outgoingStage\)\) \{/u);
      assert.equal(hostSource.split('if (!errors.length) work.lastCorrections = [];').length, 2, 'cleared in exactly one place');
      // Rejection paths still carry their own corrections.
      assert.equal(hostSource.split('candidate.corrections += 1; candidate.status = \'correcting\'; work.lastCorrections = errors;').length, 2);
    },
  },
  {
    name: 'v2 prior-round findings keep earlier content and newest fit rounds, deduplicated, bounded and excluding the current corrections',
    run() {
      for (const [domain, action] of domains) {
        const t = n => `unit-source-grounding: ${domain} ${action} finding ${n}`;
        const rows = [
          { round: 0, checkIds: ['schema-invalid'], errors: [`${domain} plain-text format`] },
          { round: 0, kind: 'content', checkIds: [], errors: [t(1), '  ', t(2)] },
          { round: 0, kind: 'fit', checkIds: ['measured-one-page-fit'], errors: [`${domain} render one line shorter`] },
          { round: 1, kind: 'content', checkIds: [], errors: [` ${t(1)} `, t(3), t(4)] },
        ];
        assert.deepEqual(priorRoundFindings(rows, [t(4)]), [t(2), `${domain} render one line shorter`, t(1), t(3)], domain);
        assert.deepEqual(priorRoundFindings(rows, [t(4)], 2), [t(1), t(3)], `${domain}: newest win the bound, oldest first`);
        assert.deepEqual(priorRoundFindings(rows, [t(4)], 0), [], domain);
        assert.deepEqual(priorRoundFindings(rows, []), [t(2), `${domain} render one line shorter`, t(1), t(3), t(4)], domain);
        assert.deepEqual(priorRoundFindings([], [t(1)]), [], domain);
        assert.deepEqual(priorRoundFindings(undefined, undefined), [], domain);
        const many = [{ kind: 'content', errors: Array.from({ length: WRITE_VERIFY_PRIOR_ROUND_FINDINGS_MAX + 3 }, (_, index) => t(`m${index}`)) }];
        const bounded = priorRoundFindings(many, []);
        assert.equal(bounded.length, WRITE_VERIFY_PRIOR_ROUND_FINDINGS_MAX, domain);
        assert.deepEqual(bounded, many[0].errors.slice(3), domain);
        assert.throws(() => priorRoundFindings(rows, [], -1), /non-negative integer/u, domain);
        assert.throws(() => priorRoundFindings(rows, [], 1.5), /non-negative integer/u, domain);
      }
      assert.equal(WRITE_VERIFY_PRIOR_ROUND_FINDINGS_MAX, 12);
      assert.equal(WRITE_VERIFY_PRIOR_ROUNDS_HEADING, 'EARLIER ROUNDS OF THIS SAME DRAFT (ALREADY REPORTED; KEEP THEM SATISFIED)');
    },
  },
  {
    name: 'v2 verify and fit correction prompts carry the earlier content rounds of the same draft',
    run() {
      const intro = 'Earlier rounds of this same draft were returned for the findings below; the unit each names was then repaired and the rewrite tripped the current rejection text. Keep every one of these satisfied together with the current rejection text; change nothing that already passes.';
      for (const [domain, action] of domains) {
        const t = n => `unit-source-grounding: Résumé bullet "b${n}": ${domain} ${action} detail ${n}`;
        const sourcePrompt = `${domain} posting and full grouped catalog`;
        for (const stage of ['verify-correction', 'fit-correction']) {
          const envelope = { protocol: 'paste-application.v1', jobId: JOB_ID, stage };
          const state = initialWriteVerifyState(1);
          const candidate = state.candidates[0];
          candidate.structured = { resume: { roles: [{ id: `role-${domain}`, bullets: [] }] }, coverLetter: { paragraphs: [] } };
          const current = [t('now'), `other-check: ${domain} second current finding`];
          const docs = `CURRENT STRUCTURED DOCUMENTS:\n${JSON.stringify(candidate.structured)}`;
          const legacy = `${docs}\n\nCorrect the complete documents and return only the production JSON shapes. The rejection text follows verbatim:\n${current.join('\n')}\n\nOUTPUT FORMAT:\n`;
          const fresh = writeVerifyPrompt({ stage, state, sourcePrompt, envelope, corrections: current });
          assert.ok(fresh.includes(legacy), `${domain} ${stage}: no earlier rounds keeps the prompt as before`);
          assert.equal(fresh.includes(WRITE_VERIFY_PRIOR_ROUNDS_HEADING), false, `${domain} ${stage}`);
          // Fit and write-stage rows are not grounding observations.
          candidate.rejections.push({ round: 0, checkIds: ['schema-invalid'], errors: [`${domain} plain text format`] });
          assert.equal(writeVerifyPrompt({ stage, state, sourcePrompt, envelope, corrections: current }), fresh, `${domain} ${stage}: non-content rows change nothing`);
          candidate.rejections.push({ round: 0, kind: 'fit', checkIds: ['measured-one-page-fit'], errors: [`${domain} shorten by one line`] });
          candidate.rejections.push({ round: 0, kind: 'content', checkIds: [], errors: [t(1), t(2)] });
          candidate.rejections.push({ round: 1, kind: 'content', checkIds: [], errors: [t(3), current[0]] });
          const prompt = writeVerifyPrompt({ stage, state, sourcePrompt, envelope, corrections: current });
          assert.equal(prompt.split(WRITE_VERIFY_PRIOR_ROUNDS_HEADING).length, 2, `${domain} ${stage}: heading once`);
          const docsAt = prompt.indexOf(docs);
          const headingAt = prompt.indexOf(WRITE_VERIFY_PRIOR_ROUNDS_HEADING);
          const correctAt = prompt.indexOf('Correct the complete documents');
          assert.ok(docsAt >= 0 && docsAt < headingAt && headingAt < correctAt, `${domain} ${stage}: between documents and correction instruction`);
          const section = prompt.slice(headingAt, correctAt);
          assert.equal(section, `${WRITE_VERIFY_PRIOR_ROUNDS_HEADING}:\n${intro}\n- ${domain} shorten by one line\n- ${t(1)}\n- ${t(2)}\n- ${t(3)}\n\n`, `${domain} ${stage}: exact section`);
          for (const text of [t(1), t(2), t(3)]) assert.ok(prompt.includes(`\n- ${text}`), `${domain} ${stage}`);
          for (const text of current) assert.equal(section.includes(text), false, `${domain} ${stage}: current corrections stay out of the section`);
          assert.equal(prompt.split(current[0]).length, 2, `${domain} ${stage}: the current correction prints once`);
          assert.ok(prompt.includes(`${docs}\n\n${section}Correct the complete documents and return only the production JSON shapes. The rejection text follows verbatim:\n${current.join('\n')}\n\nOUTPUT FORMAT:\n`), `${domain} ${stage}`);
          // Sabotage: removing the section restores the earlier prompt byte for byte.
          assert.equal(prompt.replace(`${section}`, ''), fresh, `${domain} ${stage}`);
        }
      }
    },
  },
  {
    name: 'v2 fact-correction prompt prints every finding, the verbatim rejection only when present, and earlier fact rounds',
    run() {
      const findingsHeading = 'FACT-CHECK FINDINGS TO CORRECT (every flagged span must change; a span returned unchanged is rejected):';
      for (const [domain, action] of domains) {
        const sourcePrompt = `${domain} posting and full grouped catalog`;
        const envelope = { protocol: 'paste-application.v1', jobId: JOB_ID, stage: 'fact-correction' };
        const state = initialWriteVerifyState(2);
        const claim = `led the ${domain} ${action} team`;
        const winner = state.candidates[1];
        winner.status = 'accepted';
        winner.structured = { resume: { roles: [{ id: `role-${domain}`, bullets: [{ id: 'b1', text: `I ${claim}.`, evidenceIds: [] }] }] }, coverLetter: { paragraphs: [] } };
        state.candidates[0].rejections.push({ round: 0, kind: 'content', checkIds: [], errors: [`${domain} other candidate finding`] });
        state.ranking = ['candidate-2', 'candidate-1']; state.factIndex = 0;
        state.factFindings = [
          { id: 'b1', checkId: 'unsupported-scope', claim, quote: `I worked on ${domain} ${action}.`, reason: 'The quote states no leadership.' },
          { id: 'p1', checkId: 'unsupported-metric', claim: `cut ${action} time by half`, quote: '', reason: 'No cited quote states a reduction.' },
        ];
        const docs = `CURRENT STRUCTURED DOCUMENTS:\n${JSON.stringify(winner.structured)}`;
        const findings = `${findingsHeading}\n- b1: the span ${JSON.stringify(claim)} is not supported. The quote states no leadership. Cited quote: ${JSON.stringify(`I worked on ${domain} ${action}.`)}\n- p1: the span ${JSON.stringify(`cut ${action} time by half`)} is not supported. No cited quote states a reduction.`;
        const first = writeVerifyPrompt({ stage: 'fact-correction', state, sourcePrompt, envelope });
        assert.ok(first.includes(`${docs}\n\n${findings}\n\nCorrect the complete documents and return only the production JSON shapes.\n\nOUTPUT FORMAT:\n`), `${domain}: first round shows every finding and no rejection sentence`);
        assert.equal(first.includes('The rejection text follows verbatim'), false, domain);
        assert.equal(first.includes(WRITE_VERIFY_PRIOR_ROUNDS_HEADING), false, domain);
        assert.equal(first.includes('other candidate finding'), false, `${domain}: another candidate's rounds never ride along`);
        // Second round: the writer returned the span unchanged.
        const unchanged = writeVerifyChangedFindingErrors(state.factFindings, winner.structured);
        assert.ok(unchanged.length >= 1 && unchanged.every(error => error.startsWith('fact-check-unchanged:')), domain);
        winner.factCorrectionRejections = [{ round: 1, checkIds: ['fact-check-unchanged'], errors: unchanged }];
        const second = writeVerifyPrompt({ stage: 'fact-correction', state, sourcePrompt, envelope, corrections: unchanged });
        assert.ok(second.includes(`${docs}\n\n${findings}\n\nCorrect the complete documents and return only the production JSON shapes. The rejection text follows verbatim:\n${unchanged.join('\n')}\n\nOUTPUT FORMAT:\n`), `${domain}: second round prints the unchanged text verbatim`);
        assert.equal(second.includes(WRITE_VERIFY_PRIOR_ROUNDS_HEADING), false, `${domain}: the current round is not repeated as an earlier one`);
        // Third round: a different gate rejected; the unchanged round is now earlier.
        const grounding = `unit-source-grounding: Résumé bullet "b1": ${domain} names a title the quotes do not state`;
        winner.factCorrectionRejections.push({ round: 2, checkIds: ['unit-source-grounding'], errors: [grounding] });
        const third = writeVerifyPrompt({ stage: 'fact-correction', state, sourcePrompt, envelope, corrections: [grounding] });
        const findingsAt = third.indexOf(findingsHeading);
        const headingAt = third.indexOf(WRITE_VERIFY_PRIOR_ROUNDS_HEADING);
        const correctAt = third.indexOf('Correct the complete documents');
        assert.ok(third.indexOf(docs) < findingsAt && findingsAt < headingAt && headingAt < correctAt, `${domain}: findings, then earlier rounds, then the instruction`);
        const section = third.slice(headingAt, correctAt);
        for (const text of unchanged) assert.ok(section.includes(`\n- ${text}`), domain);
        assert.equal(section.includes(grounding), false, `${domain}: the current correction stays out of the section`);
        assert.equal(third.split(WRITE_VERIFY_PRIOR_ROUNDS_HEADING).length, 2, domain);
        for (const missing of [[], undefined, null]) {
          state.factFindings = missing;
          assert.throws(() => writeVerifyPrompt({ stage: 'fact-correction', state, sourcePrompt, envelope }), /^Error: Fact correction requires the fact-check findings\.$/u, domain);
        }
      }
    },
  },
  { name: 'commercial licensing does not claim a professional credential', run() {
    for (const noun of ['approaches', 'models', 'costs', 'fees', 'terms', 'agreements']) {
      assert.deepEqual(credentialFindings(`I evaluated vendors and their licensing ${noun}.`, ['I evaluated vendor costs and tradeoffs.']), []);
      assert.ok(credentialFindings(`I evaluated licensing ${noun} and hold a nursing license.`, ['I evaluated vendor costs.']).length);
    }
    assert.ok(credentialFindings('I hold a professional license.', ['I evaluated vendor costs.']).length);
    assert.ok(credentialFindings('I completed nursing licensing.', ['I evaluated vendor costs.']).length);
  } },
  { name: 'v2 rejection diagnostics name each fixed envelope field without retaining its value', run() {
    const names = { protocol: 'protocol', jobId: 'job-id', stage: 'stage', handoffCode: 'code', baseHashes: 'base-hashes' };
    for (const [field, suffix] of Object.entries(names)) {
      const diagnostic = pasteRejectionCheckIds([`Application v2 response must echo the current ${field} exactly.`]);
      assert.deepEqual(diagnostic.checkIds, [`handoff-echo-${suffix}`]);
      assert.equal(diagnostic.uncodedErrors, 0);
    }
    assert.deepEqual(pasteRejectionCheckIds(['Application v2 response must echo the current private-field exactly.']).checkIds, ['schema-invalid']);
  } },
  {
    name: 'v2 approved hand preserves standalone achievements alongside employer evidence',
    run() {
      for (const [domain] of domains) {
        for (const roles of [[], [{ id: 'employer' }]]) {
          const profile = { roles, achievements: [{ id: 'independent' }, { id: 'also-independent', roleId: null }], projects: [] };
          const catalog = profile.achievements.flatMap(unit => [1, 2].map(index => ({
            id: `host.career.achievement.${unit.id}.${index}`, quote: `${domain} independent evidence ${index}`,
            cleanQuote: `${domain} approved independent evidence ${index}`,
          })));
          const hand = fullApprovedHand(profile, catalog);
          for (const row of catalog) {
            assert.equal(hand.split(`[${row.id}]`).length - 1, 1);
            assert.ok(hand.includes(row.cleanQuote));
          }
          assert.ok(hand.includes('## Standalone achievements'));
          assert.throws(() => fullApprovedHand(profile, [...catalog, { id: 'host.career.achievement.missing.1', quote: 'unknown' }]), /omitted/);
        }
      }
    },
  },
  {
    name: 'v2 archives each handoff and accepted candidate outside the removable job with a hard cap',
    async run() {
      const hostSource = fs.readFileSync(new URL('../../electron/ipc/localAiApplication.js', import.meta.url), 'utf8');
      assert.match(hostSource, /kind: 'prompt'[\s\S]*?return record;/u);
      assert.match(hostSource, /assertApplicationV2ReplyLimit\(rawText\);\s*await archiveV2Content\(/u);
      assert.match(hostSource, /kind: 'candidate-final'[\s\S]*?structured: gate\.structured/u);
      for (const [domain] of domains) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), `v2-content-archive-${domain}-`));
        const jobDir = path.join(root, '.local-ai', 'jobs', JOB_ID);
        try {
          const prompt = await archiveV2Content({ jobDir, jobId: JOB_ID, stage: 'write', revision: 1,
            kind: 'prompt', candidateId: 'candidate-1', content: { prompt: `${domain} prompt` } });
          const reply = await archiveV2Content({ jobDir, jobId: JOB_ID, stage: 'write', revision: 1,
            kind: 'reply', candidateId: 'candidate-1', content: { response: `${domain} reply` } });
          const final = await archiveV2Content({ jobDir, jobId: JOB_ID, stage: 'convert', revision: 2,
            kind: 'candidate-final', candidateId: 'candidate-1', content: { plainText: domain, structured: { resume: {}, coverLetter: {} } } });
          const archive = v2EvidenceArchiveDirectory(jobDir, JOB_ID);
          assert.ok([prompt, reply, final].every(file => file.startsWith(`${archive}${path.sep}`)));
          assert.equal((await archiveV2Content({ jobDir, jobId: JOB_ID, stage: 'write', revision: 1,
            kind: 'prompt', candidateId: 'candidate-1', content: { prompt: `${domain} prompt` } })), prompt);
          fs.rmSync(jobDir, { recursive: true, force: true });
          assert.equal(JSON.parse(fs.readFileSync(final, 'utf8')).content.plainText, domain);
          await assert.rejects(archiveV2Content({ jobDir, jobId: JOB_ID, stage: 'convert', revision: 3,
            kind: 'reply', candidateId: 'candidate-1', content: { response: 'x'.repeat(V2_EVIDENCE_MAX_BYTES) } }), /cap/);
          const outside = path.join(root, 'outside');
          fs.mkdirSync(outside);
          fs.rmSync(archive, { recursive: true });
          fs.symlinkSync(outside, archive);
          await assert.rejects(archiveV2Content({ jobDir, jobId: JOB_ID, stage: 'pick', revision: 4,
            kind: 'prompt', content: { prompt: 'judge' } }), /regular directory/);
          // Sabotage proof: writing only under jobs would erase the accepted document on save.
          const sabotaged = path.join(jobDir, 'evidence.json');
          assert.equal(fs.existsSync(sabotaged), false);
          assert.equal(fs.readdirSync(outside).length, 0);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
      }
    },
  },
  {
    name: 'v2 fresh write carries the deduplicated, bounded findings of every dropped candidate and an undropped flow carries none',
    run() {
      for (const [domain, action] of domains) {
        const finding = (unit, detail) => `unit-source-grounding: Résumé bullet ${JSON.stringify(unit)}: ${domain} ${detail}`;
        const state = initialWriteVerifyState(4);
        const envelope = { protocol: 'paste-application.v1', jobId: JOB_ID, stage: 'write' };
        const sourcePrompt = `${domain} posting and full grouped catalog`;
        // Nothing dropped yet: a corrected-but-live candidate contributes nothing.
        state.candidates[0].status = 'correcting'; state.candidates[0].corrections = 2;
        state.candidates[0].rejections.push({ round: 1, checkIds: ['unit-source-grounding'], errors: [finding('b1', `${action} scope the quotes do not state`)] });
        assert.deepEqual(droppedCandidateFindings(state), [], `${domain}: correction rounds never feed the dropped list`);
        const untouched = writeVerifyPrompt({ stage: 'write', state, sourcePrompt, envelope, droppedFindings: droppedCandidateFindings(state) });
        assert.ok(!untouched.includes(WRITE_VERIFY_DROPPED_FINDINGS_HEADING), `${domain}: an undropped flow prints no dropped-draft section`);
        assert.equal(untouched, writeVerifyPrompt({ stage: 'write', state, sourcePrompt, envelope }), `${domain}: the default is the same prompt as before`);
        // Two drops repeat one finding and add a prefix-less one; the same text under a different check id stays distinct.
        const shared = finding('b1', `${action} scope the quotes do not state`);
        state.candidates[0].status = 'dropped'; state.candidates[0].dropReason = [shared, `cover letter ${domain} paragraph repeats the ${action} bullet`, '  '];
        state.candidates[1].status = 'dropped'; state.candidates[1].dropReason = [finding('b2', `${action} population the quotes do not name`), shared, `other-check: ${domain} ${action} scope the quotes do not state`];
        state.ordinal = 2;
        const rows = droppedCandidateFindings(state);
        assert.deepEqual(rows.map(row => [row.candidateId, row.checkId]),
          [['candidate-1', null], ['candidate-2', 'unit-source-grounding'], ['candidate-2', 'unit-source-grounding'], ['candidate-2', 'other-check']],
          `${domain}: dedup keeps the newest occurrence of a (check id, text) pair, oldest first, blanks dropped`);
        assert.equal(rows.filter(row => row.text === shared).length, 1, `${domain}: a finding two candidates shared prints once`);
        const prompt = writeVerifyPrompt({ stage: 'write', state, sourcePrompt, envelope, droppedFindings: rows });
        const sectionAt = prompt.indexOf(WRITE_VERIFY_DROPPED_FINDINGS_HEADING);
        assert.ok(sectionAt > prompt.indexOf(sourcePrompt) && sectionAt < prompt.indexOf('OUTPUT FORMAT FOR THIS ARM'), `${domain}: observations sit between the source data and the output format`);
        for (const row of rows) assert.ok(prompt.includes(`\n- ${row.text}`), `${domain}: every dropped finding prints verbatim`);
        assert.equal(prompt.split(shared).length, 2, `${domain}: the shared finding prints exactly once`);
        assert.ok(/none is text to reuse or a claim to make/u.test(prompt), `${domain}: the section is framed as observations, not replacement wording`);
        for (const stage of ['convert']) {
          state.candidates[2].plainText = `${domain} draft`;
          assert.ok(!writeVerifyPrompt({ stage, state, sourcePrompt, envelope, droppedFindings: rows }).includes(WRITE_VERIFY_DROPPED_FINDINGS_HEADING), `${domain}: only the write stage carries the section`);
        }
        // Bound: many distinct findings keep only the newest WRITE_VERIFY_DROPPED_FINDINGS_MAX.
        state.candidates[2].status = 'dropped';
        state.candidates[2].dropReason = Array.from({ length: WRITE_VERIFY_DROPPED_FINDINGS_MAX + 3 }, (_, index) => finding(`c${index}`, `${action} detail ${index} beyond the quotes`));
        const bounded = droppedCandidateFindings(state);
        assert.equal(bounded.length, WRITE_VERIFY_DROPPED_FINDINGS_MAX, `${domain}: the list is bounded`);
        assert.ok(bounded.every(row => row.candidateId === 'candidate-3'), `${domain}: the newest findings win the bound`);
        assert.equal(bounded.at(-1).text, state.candidates[2].dropReason.at(-1), `${domain}: order stays oldest first within the bound`);
        assert.equal(droppedCandidateFindings(state, 2).length, 2, `${domain}: the bound is a parameter`);
        assert.throws(() => droppedCandidateFindings(state, -1), /non-negative integer/u, domain);
      }
    },
  },
  {
    name: 'v2 writer appendices stay outside conversion and historical replies remain readable across three synthetic careers',
    run() {
      for (const [domain, action] of domains) {
        const ids = Array.from({ length: 6 }, (_, index) => `host.career.achievement.${domain}-${index + 1}.1`);
        const state = initialWriteVerifyState(1);
        const envelope = { protocol: 'paste-application.v1', jobId: JOB_ID, stage: 'write' };
        const writePrompt = writeVerifyPrompt({ stage: 'write', state, sourcePrompt: `${domain} posting and full grouped catalog`, envelope });
        assert.ok(writePrompt.includes('After the complete letter, add two editorial appendices'), domain);
        assert.ok(writePrompt.includes('EDITORIAL SUMMARY'), domain);
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
        // A reply with no recognizable legacy working-notes heading is held to the live
        // contract (documents first), never steered back to the retired layout.
        assert.throws(() => splitWriteVerifyWriterResponse(response.replace('EVIDENCE SHORTLIST (WORKING NOTES)', 'WORKING NOTES'), ids), /start with a standalone RÉSUMÉ heading/u, domain);
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
    name: 'application protocol setting is v2-only',
    run() {
      assert.equal(applicationProtocolSetting(undefined), WRITE_VERIFY_PROTOCOL);
      assert.equal(applicationProtocolSetting('unexpected'), WRITE_VERIFY_PROTOCOL);
      assert.equal(applicationProtocolSetting(WRITE_VERIFY_PROTOCOL), WRITE_VERIFY_PROTOCOL);
      assert.equal(applicationProtocolSetting('legacy'), WRITE_VERIFY_PROTOCOL);
    },
  },
  {
    name: 'v2 manifests classify a matching, stale, or absent validator stamp without changing the manifest',
    run() {
      const current = applicationValidatorStamp();
      const manifest = { validatorStamp: current, paste: { writeVerify: { version: WRITE_VERIFY_PROTOCOL } } };
      const before = JSON.stringify(manifest);
      assert.match(current, /^[0-9a-f]{64}$/u);
      assert.equal(__persistedValidatorBuildForTests(manifest).kind, 'same-build');
      try {
        __setApplicationValidatorStampForTests('a1'.repeat(32));
        assert.equal(__persistedValidatorBuildForTests(manifest).kind, 'other-build');
        assert.equal(JSON.stringify(manifest), before);
      } finally { __setApplicationValidatorStampForTests(null); }
      assert.equal(__persistedValidatorBuildForTests({ paste: manifest.paste }).kind, 'unstamped');
      assert.equal(__persistedValidatorBuildForTests(manifest).kind, 'same-build');
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
    name: 'writer skill index permits declared fill and posting-named attested skills while preserving legacy projections',
    run() {
      const profile = {
        roles: [], achievements: [], projects: [], education: [], certifications: [], otherEvidence: [],
        skills: [
          { id: 'skill-runtime', name: 'Aster Runtime', indexEligible: true },
          { id: 'skill-queue', name: 'Cirrus Queue', indexEligible: true },
          { id: 'skill-query', name: 'Boreal Query', indexEligible: true },
          { id: 'skill-excluded', name: 'Meadow Wire', indexEligible: false },
        ],
      };
      const catalog = profile.skills.map(skill => ({
        id: `host.career.skill.${skill.id}.1`, sourceId: 'career-data',
        quote: `Used ${skill.name} to maintain the dispatch service.`,
      }));
      const careerSkillEvidence = { skills: [
        { id: 'skill-runtime', declaredInSkillsSection: false },
        { id: 'skill-queue', declaredInSkillsSection: true },
        { id: 'skill-query' },
        { id: 'skill-excluded', declaredInSkillsSection: true },
      ] };
      const index = (listingEvidence, projection = careerSkillEvidence) => {
        const prompt = writeVerifySourcePrompt({
          posting: 'Aster Runtime and Meadow Wire appear outside the accepted listing quotes.',
          requirements: [], listingEvidence, identity: {}, sourceRoles: [], profile, catalog,
          careerSkillEvidence: projection,
        });
        const marker = 'INDEX-ELIGIBLE SKILLS (exact item names and their only permitted skill-group citation IDs):\n';
        assert.equal(prompt.split(marker).length, 2, 'the permitted index is printed exactly once');
        return JSON.parse(prompt.split(marker)[1]);
      };
      const names = rows => rows.map(row => row.name);
      assert.deepEqual(names(index([])), ['Cirrus Queue', 'Boreal Query'],
        'a modern non-declared skill is omitted without a cited posting name, declared fill is retained, and an undefined flag keeps its former behavior');
      const named = index([{ id: 'listing-runtime', quote: 'Maintain aster runtime and Meadow Wire for dispatch.' }]);
      assert.deepEqual(names(named), ['Aster Runtime', 'Cirrus Queue', 'Boreal Query'],
        'a whole-term posting name admits the career-attested non-declared skill, while eligibility still excludes a false-eligible row');
      assert.deepEqual(named[0].evidenceIds, ['host.career.skill.skill-runtime.1'],
        'the new posting permission retains the existing career-only skill citation IDs');
      assert.deepEqual(names(index([{ quote: 'Maintain Aster RuntimePlus for dispatch.' }])), ['Cirrus Queue', 'Boreal Query'],
        'a longer posting name does not admit a non-declared subterm');
      assert.deepEqual(names(index([], null)), ['Aster Runtime', 'Cirrus Queue', 'Boreal Query'],
        'a job with no frozen declaration projection retains the complete earlier eligible index');
      assert.deepEqual(names(index([], { skills: profile.skills.map(skill => ({ id: skill.id })) })), ['Aster Runtime', 'Cirrus Queue', 'Boreal Query'],
        'an older frozen projection without declaration flags retains its earlier index');
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
        assert.ok(prompt.includes('TRUSTED EDUCATION AND CREDENTIAL FIELDS'), domain);
        assert.ok(prompt.includes('do not append a location to either field'), domain);
      }
    },
  },
  {
    name: 'requirements adjudication preserves bindings and verifies legacy capped terminals',
    run() {
      const postings = [
        { domain: 'freight', unit: 'u-freight', quote: 'Priorities may shift as freight volumes change.' },
        { domain: 'clinic', unit: 'u-clinic', quote: 'This clinic role operates in a changing environment.' },
        { domain: 'library', unit: 'u-library', quote: 'Library projects vary from one season to another.' },
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
        assert.equal(requirementsAuditCapTerminal(2, [posting.unit]), null);
        assert.equal(requirementsAuditCapTerminal(1, [posting.unit], bindings), null);
        assert.deepEqual(requirementsSingletonBinding([posting.unit], bindings, mutation), null);
        assert.deepEqual(requirementsSingletonBinding([posting.unit], bindings,
          [{ unitId: posting.unit, disposition: 'not-a-requirement' }]), bindings[0]);
        const multi = [posting.unit, `${posting.unit}-other`];
        const terminal = requirementsAuditCapTerminal(2, multi);
        assert.equal(terminal.reason, 'audit-re-epoch-cap');
        assert.equal(requirementsAuditCapTerminal(1, multi, bindings).reason, 'prior-adjudication-conflict');
        // Mutation and sabotage proofs: a changed discovery row cannot inherit the
        // binding, and removing either the singleton gate or multi-unit cap fails.
        const assertBinding = gate => assert.match(gate(mutation, bindings)[0], /prior independent adjudicator.*binding disposition/);
        const assertCap = gate => assert.equal(gate(2, multi)?.kind, 'requirements-audit-disagreement');
        const assertSingleton = gate => assert.deepEqual(gate([posting.unit], bindings,
          [{ unitId: posting.unit, disposition: 'not-a-requirement' }]), bindings[0]);
        assertBinding(requirementsBindingErrors);
        assertCap(requirementsAuditCapTerminal);
        assertSingleton(requirementsSingletonBinding);
        assert.throws(() => assertBinding(() => []), /string/);
        assert.throws(() => assertCap(() => null), /requirements-audit-disagreement/);
        assert.throws(() => assertSingleton(() => null), /deep-equal/);
      }
      assert.throws(() => requirementsAdjudicationBindings([
        { rows: [{ unitId: 'u-one', disposition: 'requirement' }] },
        { rows: [{ unitId: 'u-one', disposition: 'not-a-requirement' }] },
      ]), /conflicting binding decisions/);
      const source = fs.readFileSync(new URL('../../electron/ipc/localAiApplication.js', import.meta.url), 'utf8');
      assert.ok(source.includes('requirementsBindingErrors(coverage, source.bindingRows)')
        && source.includes('requirementsBindingErrors(Array.isArray(rows) ? rows : [], page.bindingRows)')
        && source.includes('bindingRows: Number.isSafeInteger(epoch) ? await authorityPriorAdjudicationBindings(store, epoch, units) : []')
        && source.includes('bindingRows = await authorityPriorAdjudicationBindings(store, epoch.epoch, windowUnits)'),
      'production discovery and audit must enforce the same signed bindings');
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
        const fragment = title.split(' ').slice(-2).join(' ');
        assert.deepEqual(errors(`I maintained ${work}. The ${fragment} team appeals to me because it involves this work.`), [],
          `${title}: contiguous target-title fragment is licensed in a target reference`);
        assert.deepEqual(errors(`I am interested in the ${fragment} role because it connects to the ${work} I maintained.`), [],
          `${title}: explicit target reference remains licensed when a separate clause mentions past work`);
        assert.ok(errors(`I maintained ${work} on the ${fragment} team.`).some(error => error.includes('names')),
          `${title}: fragment in past-experience mutation fails`);
        assert.ok(errors(`I maintained ${work}. The Orbital Systems team appeals to me because it involves this work.`)
          .some(error => error.includes('names')), `${title}: invented fragment fails`);
        assert.deepEqual(errors(`I maintained ${work}. I would bring this work to ${company}.`), [], `${company}: target employer is licensed`);
        const taggedErrors = text => __pasteUnitGroundingErrorsForTests({ ...args, targetCompany: `${company} - Operations Tools`, finalText: text });
        assert.deepEqual(taggedErrors(`I maintained ${work}. I would bring this work to ${company}'s team.`), [],
          'the exact employer prefix and possessive in a forward reference are licensed');
        assert.ok(taggedErrors(`I maintained ${work} at ${company}.`).some(error => error.includes('states work at')),
          'a display-name prefix does not license a past-employment claim');
        assert.ok(errors(`I worked as a ${title} on ${work}.`).some(error => error.includes('names')), `${title}: past title mutation fails`);
        assert.ok(errors(`I maintained ${work} at ${company}.`).some(error => error.includes('states work at')), `${company}: past employer mutation fails`);
        assert.ok(errors(`I maintained ${work}. The Orbital Systems Engineer role appeals to me because it involves this work.`)
          .some(error => error.includes('Orbital Systems Engineer')), `${title}: unlisted title mutation fails`);
        assert.ok(__pasteUnitGroundingErrorsForTests({ ...args, targetTitle: '', finalText: target })
          .some(error => error.includes('names')), `${title}: removing the frozen-title binding restores rejection`);
        assert.ok(__pasteUnitGroundingErrorsForTests({ ...args, targetTitle: '',
          finalText: `I maintained ${work}. The ${fragment} team appeals to me because it involves this work.` })
          .some(error => error.includes('names')), `${title}: sabotage removing frozen title rejects fragment`);
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
      assert.equal(WRITE_VERIFY_DEFAULT_CANDIDATES, 5);
      assert.equal(writeVerifyCandidateCount(), 5);
      assert.equal(initialWriteVerifyState().candidates.length, 5);
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
    name: 'v2 default N sabotage: reverting to three fails the five-candidate contract while the judge cutoff stays six',
    async run() {
      const moduleUrl = new URL('../../electron/ipc/applicationWriteVerify.js', import.meta.url);
      const source = fs.readFileSync(moduleUrl, 'utf8');
      assert.ok(source.includes('export const WRITE_VERIFY_DEFAULT_CANDIDATES = 5;'), 'the default declaration is present for sabotage');
      const sabotaged = source.replace('export const WRITE_VERIFY_DEFAULT_CANDIDATES = 5;', 'export const WRITE_VERIFY_DEFAULT_CANDIDATES = 3;')
        .replace(/from '(\.\/[^']+)'/gu, (_, relative) => `from '${new URL(relative, moduleUrl).href}'`);
      const mutant = await import(`data:text/javascript;base64,${Buffer.from(sabotaged).toString('base64')}`);
      assert.equal(mutant.writeVerifyCandidateCount(), 3, 'the sabotage actually changes the default');
      assert.throws(() => assert.equal(mutant.initialWriteVerifyState().candidates.length, 5), /3 !== 5/u,
        'the five-candidate contract rejects the sabotaged default');
      const host = fs.readFileSync(new URL('../../electron/ipc/localAiApplication.js', import.meta.url), 'utf8');
      assert.match(host, /acceptedWriteVerifyCandidates\(work\)\.length > 6/u, 'seven accepted candidates still trigger elimination');
      assert.match(host, /winners\.length > 6/u, 'elimination still ends at six winners');
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
      assert.equal(APPLICATION_V2_LIMITS.bridgeToolResultBytes, 8 * 1024 * 1024);
      assert.equal(APPLICATION_V2_LIMITS.bridgeToolTextBytes, 2 * 1024 * 1024);
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
    name: 'v2 measured capacity provides upper estimates without minimum content targets',
    run() {
      const roleHeavy = writeVerifyLengthBudgetForStructure({ roles: 3, education: 1, skillsRows: 3, projects: 0 });
      const projectHeavy = writeVerifyLengthBudgetForStructure({ roles: 3, education: 1, skillsRows: 1, projects: 3 });
      assert.ok(roleHeavy.maxCharacters > 1095);
      assert.equal('minCharacters' in roleHeavy, false);
      assert.equal('minBullets' in roleHeavy, false);
      const prompt = writeVerifySourcePrompt({ posting: '', requirements: [], listingEvidence: [], identity: {},
        sourceRoles: [], profile: { roles: [], achievements: [], projects: [], skills: [] }, catalog: [], lengthBudget: [roleHeavy] });
      assert.ok(prompt.includes('upper estimates') && prompt.includes('up to'));
      assert.ok(!prompt.includes('85–100%') && !prompt.includes('drafting targets'));
      assert.ok(projectHeavy.maxCharacters !== roleHeavy.maxCharacters);
      assert.ok(projectHeavy.maxBullets < roleHeavy.maxBullets);
      // At most one Personal Projects entry, and only from unlinked projects.
      const variants = writeVerifyLengthBudgets({ education: [{}], skills: [{}, {}, {}], projects: [{}, {}, { roleId: 'r1' }] }, [{}, {}, {}]);
      assert.deepEqual(variants, [roleHeavy, writeVerifyLengthBudgetForStructure({ roles: 3, education: 1, skillsRows: 1, projects: 1 })]);
      assert.deepEqual(writeVerifyLengthBudgets({ education: [{}], skills: [{}], projects: [{ roleId: 'r1' }] }, [{}]).length, 1);
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
