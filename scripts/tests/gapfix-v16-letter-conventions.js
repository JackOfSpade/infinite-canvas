// Regression tests for the signed letter conventions clause of blind-review
// prompt mode v6 (v16 work package F2).  v7 (v16 round 2, T3) extends the clause and
// adds the host-projected letter grounding; this file keeps proving the v6 text and
// behaviour, which a plan minted from an accessor WITHOUT letter grounding still has
// (and which every v6 root keeps), and gapfix-v16b-reviewer-context.js proves v7.
//
// The editorial reviewers that read the cover letter never see the host's
// authoring contract.  That contract requires, in the first proof-bearing body
// paragraph, one phrase naming the capability the proof shows and one sentence
// relating the proof to the job need.  A reviewer that reads either as
// unexplained abstraction proposed deleting it, the host refused the deletion
// (the paragraph would then lack the required function), the writer could only
// reword it, and the next reviewer flagged the new wording: a loop no response
// could end.  v6 tells exactly the scopes that read the letter what those two
// things are and what a legal correction looks like, WITHOUT exempting either
// from review: every finding stays blocking.
//
// What is covered:
//   1  a v5 root minted before v6 still verifies and prints its original
//      prompts byte for byte (nothing it signed is reconstructed differently);
//   2  v6 prints the letter clause to exactly the tracks whose signed allowed
//      context includes the cover letter, once, after the host conventions and
//      outside the untrusted-evidence block;
//   3  the clause is part of the SIGNED policy, and its wording follows the
//      letter checks' own budget phrases (mutate them and the text and digest
//      move);
//   4  the clause waives nothing and holds nothing specific to any document;
//   5  a finding about the required phrase or sentence is still an ordinary
//      blocking finding with a repair packet;
//   6  the prompts still fit the signed byte limit, with a continuation page.
//
// Every fixture is synthetic and drawn from unrelated domains.
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {
  APPLICATION_BLIND_REVIEW_HOST_CONVENTIONS,
  APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS,
  APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS_TRACKS,
  APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS_V6,
  APPLICATION_BLIND_REVIEW_MAX_PROMPT_BYTES,
  APPLICATION_BLIND_REVIEW_PROMPT_MODE,
  APPLICATION_BLIND_REVIEW_UNGROUNDED_PROMPT_MODE,
  __applicationBlindReviewPolicyForTests,
  acceptApplicationBlindReviewResponse,
  applicationBlindReviewConventionsFor,
  applicationBlindReviewPolicyCatalogue,
  applicationBlindReviewScopeAt,
  applicationBlindReviewValidatorStamp,
  assertApplicationBlindReviewPlan,
  buildApplicationBlindReviewLetterConventions,
  buildApplicationBlindReviewPrompt,
  createApplicationBlindRepairPackets,
  createApplicationBlindReviewPlan,
  createApplicationBlindReviewSourceAccessor,
  nextApplicationBlindReviewWork,
  validateApplicationBlindReviewReceipts,
} from '../../electron/ipc/applicationBlindReview.js';
import { APPLICATION_AUTHORITY_WORKFLOW_VERSION, authorityDigest } from '../../electron/ipc/applicationAuthorityWorkflow.js';
import * as coverLetterChecks from '../../electron/ipc/coverLetterChecks.js';

// The signed plan limit of the application (BLIND_REVIEW_PLAN_PROMPT_BYTE_LIMIT in localAiApplication.js asserts this equality in its own test).
const PLAN_PROMPT_BYTE_LIMIT = APPLICATION_BLIND_REVIEW_MAX_PROMPT_BYTES - 1536;

const DOMAINS = Object.freeze([
  {
    domain: 'freight routing', title: 'Dispatch Planner', employer: 'Harbourline Freight',
    bullet: 'Consolidated partial pallets into full overnight loads for six regional depots.',
    paragraph: 'I consolidated partial pallets into full overnight loads for six regional depots, and the new schedule cut empty trailer miles.',
    requirement: 'Overnight load consolidation across depots.',
  },
  {
    domain: 'clinic scheduling', title: 'Clinic Coordinator', employer: 'Riverbend Clinics',
    bullet: 'Redesigned the appointment reminder workflow for four outpatient clinics.',
    paragraph: 'I redesigned the appointment reminder workflow for four outpatient clinics, and missed visits fell at every site.',
    requirement: 'Appointment reminder workflow design.',
  },
  {
    domain: 'library cataloguing', title: 'Serials Cataloguer', employer: 'Eastgate Library',
    bullet: 'Converted serials cataloguing records into a unified authority file.',
    paragraph: 'I converted serials cataloguing records into a unified authority file, and the cleaned file removed duplicate publisher entries.',
    requirement: 'Authority file migration for serials records.',
  },
  {
    domain: 'civil engineering', title: 'Drainage Designer', employer: 'Cairnwall Engineering',
    bullet: 'Produced culvert drainage calculations for a county road widening.',
    paragraph: 'I produced culvert drainage calculations for a county road widening, and the inspector accepted the revised calculations.',
    requirement: 'Culvert drainage calculation for road projects.',
  },
]);

function documentsFor(domain, { pages = 1 } = {}) {
  const fill = label => (pages > 1 ? `\n${Array.from({ length: pages }, (_unused, index) => `${label} ${index} ${'w'.repeat(9_000)}`).join('\n')}` : '');
  const resume = `Experience\n${domain.title} at ${domain.employer}\n${domain.bullet}${fill('resume')}`;
  const coverLetter = `Body\n${domain.paragraph}${fill('letter')}`;
  return { resume, coverLetter };
}
function accessorFor(domain, options) {
  const { resume, coverLetter } = documentsFor(domain, options);
  return createApplicationBlindReviewSourceAccessor({
    resume, coverLetter, citedEvidencePages: [{ id: 'evidence-1', text: domain.bullet }],
    tailoringPages: [{ id: 'requirements-1', requirements: [{ id: 'requirement-1', text: domain.requirement, priority: 'highest' }],
      dispositions: [{ requirementId: 'requirement-1', disposition: 'addressed-resume', justification: 'The résumé addresses it.',
        proofs: [{ document: 'resume', documentDigest: authorityDigest(resume), offset: resume.indexOf(domain.bullet), quote: domain.bullet }] }] }],
    factClaims: [{ id: 'resume-role-r1-b1', document: 'resume', pageIndex: 0, text: domain.bullet, citedEvidenceIds: ['evidence-1'] }],
  });
}
const promptAt = (plan, accessor, scopeOrdinal) => buildApplicationBlindReviewPrompt(plan, nextApplicationBlindReviewWork(plan, [], { scopeOrdinal, sourceAccessor: accessor }), { sourceAccessor: accessor });
const trackOf = prompt => /TRACK: ([^\n]+)/u.exec(prompt)[1];
const occurrences = (text, part) => text.split(part).length - 1;
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
const LETTER_TRACKS = Object.freeze(['bundle-editorial', 'cross-document-coherence', 'letter-argument-editorial']);

// A prompt-mode v5 plan and its six prompts, produced by the build that preceded
// v6 from the first domain's documents (the freight fixture below), so a root
// signed by that build can be shown to still reconstruct.  The root records the
// validator stamp of that build, which is evidence and never a condition.
const HISTORICAL_V5 = JSON.parse('{"plan":{"version":2,"kind":"application-blind-review-plan","root":{"version":2,"kind":"application-blind-review-root","sourceDigest":"434a48699d549c67ab9ab89ab4b05eb88e2e792ab91fc0d8ff459ffbd23b86ab","sources":{"version":2,"kind":"application-blind-review-source-descriptor","documents":{"resume":{"version":2,"kind":"blind-review-document-source","document":"resume","textDigest":"51295311ca20d47f2a50d8787406a93e1dece833760312da263b20adc57c43ef","pageCount":1,"pageDigest":"fecabc375b0d10cc8f4d0c6edb49eed2239bef1a3c67d9625aa1e792c7876bfe","digest":"affa231c5e44ba79d2c12ce3b6ea72d9256a62f85697a12dd36d685c3c7d3216"},"coverLetter":{"version":2,"kind":"blind-review-document-source","document":"coverLetter","textDigest":"72e54362931d8fe23cd2b05d85f01d360f769603cc744b9dc4609a0cc4a841d7","pageCount":1,"pageDigest":"5d2061f7f43b532a72ac631de7214dee61481864e845f8f92fda207b86391771","digest":"da145bc337474a04af257f054ccdc4ea8102cd29e361156d903e7bcdbc0361b6"}},"citedEvidence":{"sourceCount":1,"pageCount":1,"pageDigest":"3e026d169767dd1ca9a006665dcd4c51a4fbd8b93268992a7ee6c514bd40ab5d"},"factClaims":{"count":1,"claimDigest":"829554c69c1db7c8bc11b1be707db7597ce60beaf27a6fd4dd3005024be7fcf2","scopeCount":1,"scopeMode":"claim-evidence-set"},"tailoring":{"pageCount":1,"pageDigest":"6e058249c33b189f49b157215e437e447df6101d737f723956fad5acb3d310c2"},"digest":"434a48699d549c67ab9ab89ab4b05eb88e2e792ab91fc0d8ff459ffbd23b86ab"},"policyDigest":"52721efbd2130495957d320656aca939352d565c2ead90f0a3b209d3d96c07d6","promptByteLimit":24576,"maxFindingsPerResponse":32,"promptMode":"artifact-repair-only-v5","validatorStamp":"0c756560ed62a1551fc07c20e5788c104ce2920b5f73114fb87cdd06173e1d8d","trackCounts":{"fact-fidelity":1,"resume-hiring-quality":1,"letter-argument-editorial":1,"tailoring-ats":1,"cross-document-coherence":1,"bundle-editorial":1},"scopeCount":6,"digest":"81798b5bcfc7aee584d8944c405fec9866c847f1c72d14faaa93c930ad4bd32e"},"digest":"880b84735c8eea6832aa0e3d876ccd0497a159cf3b1e98306f040714835a2eee"},"promptSha256":["fadd3b4d9d53a9b28356494e007f5a295fb29d498a02a7b5d0aa71454b189d88","92b0af0c2333a9e45e66e7cc63eb858faff2a82f4e9717be68744b20caba278b","27f4ec4f30a9592fc4cf095b2332fddc655c024ec8cb30e90952bd6ab191b03b","ca6f6ebd0192c1f604e170c0d8f685d3a2c9105d8a0f38514d64365e91540ea6","883c377fd63a22f80b25d15dc88c3743977e71c97954d91c3b1ab84ed2111110","4d1055a704a5614ae0d205f9843aef112db40ea23e9ac264c1293d7080ac57cc"]}');

export default [
  {
    name: 'letter conventions: a v5 root minted before v6 still verifies, signs no letter conventions, and prints every prompt it ever printed byte for byte',
    run() {
      // The fixture documents are the pre-v6 build's conventions fixture; rebuild its accessor from the same text.
      const resume = 'Experience\nSupport Lead at Cobalt Clinics\nCoordinated weekly supply restocking for twelve clinics.';
      const coverLetter = 'Body\nI coordinated supply restocking for twelve clinics and kept every site stocked.';
      const accessor = createApplicationBlindReviewSourceAccessor({
        resume, coverLetter, citedEvidencePages: [{ id: 'evidence-1', text: 'Coordinated weekly supply restocking for twelve clinics.' }],
        tailoringPages: [{ id: 'requirements-1', requirements: [{ id: 'requirement-1', text: 'Supply coordination.', priority: 'highest' }],
          dispositions: [{ requirementId: 'requirement-1', disposition: 'addressed-resume', justification: 'The résumé addresses it.',
            proofs: [{ document: 'resume', documentDigest: authorityDigest(resume), offset: resume.indexOf('Coordinated'), quote: 'Coordinated weekly supply restocking for twelve clinics.' }] }] }],
        factClaims: [{ id: 'resume-role-r1-b1', document: 'resume', pageIndex: 0, text: 'Coordinated weekly supply restocking for twelve clinics.', citedEvidenceIds: ['evidence-1'] }],
      });
      const plan = HISTORICAL_V5.plan;
      assert.equal(plan.root.promptMode, 'artifact-repair-only-v5');
      assert.equal(plan.root.sourceDigest, accessor.descriptor.digest, 'the fixture rebuilds the historical source descriptor exactly');
      assertApplicationBlindReviewPlan(plan);
      const policy = __applicationBlindReviewPolicyForTests(plan.root);
      assert.equal(policy.digest, plan.root.policyDigest, 'the v5 policy is reconstructed to the digest the root signed');
      assert.equal(policy.conventionsDigest, authorityDigest(APPLICATION_BLIND_REVIEW_HOST_CONVENTIONS), 'v5 keeps signing the unchanged host conventions');
      assert.equal(policy.letterConventionsDigest, undefined, 'v5 never signed the letter conventions');
      assert.notEqual(plan.root.validatorStamp, applicationBlindReviewValidatorStamp(), 'the build that minted the root is a different build from this one');
      for (let ordinal = 0; ordinal < plan.root.scopeCount; ordinal += 1) {
        const prompt = promptAt(plan, accessor, ordinal);
        assert.equal(sha256(prompt), HISTORICAL_V5.promptSha256[ordinal], `scope ${ordinal} (${trackOf(prompt)}) prints exactly the prompt the v5 build printed`);
        assert(!prompt.includes('LETTER CONVENTIONS') && prompt.includes('HOST CONVENTIONS (signed)'), `scope ${ordinal} carries the host conventions and no letter conventions`);
      }
      // Mutation: the same root relabelled v6 (re-signed) is no longer reconstructable, because v6 signs one more digest.
      const resign = record => { const { digest: _digest, ...rest } = record; return { ...record, digest: authorityDigest(rest) }; };
      const relabelled = resign({ ...plan, root: resign({ ...plan.root, promptMode: APPLICATION_BLIND_REVIEW_UNGROUNDED_PROMPT_MODE }) });
      assert.throws(() => assertApplicationBlindReviewPlan(relabelled), /policy digest is stale/u, 'a v5 root cannot be passed off as v6');
      // ... and relabelled v7 (the current mode) it is refused too: v7 roots bind letter grounding, which a v5 root's sources cannot have.
      const relabelledV7 = resign({ ...plan, root: resign({ ...plan.root, promptMode: APPLICATION_BLIND_REVIEW_PROMPT_MODE }) });
      assert.throws(() => assertApplicationBlindReviewPlan(relabelledV7), /letter grounding does not match its prompt mode/u, 'a v5 root cannot be passed off as v7');
      // The catalogue still carries v5 exactly as it signed it.
      const modes = applicationBlindReviewPolicyCatalogue().modes;
      assert.equal(modes['artifact-repair-only-v5'].conventionsDigest, authorityDigest(APPLICATION_BLIND_REVIEW_HOST_CONVENTIONS));
      assert.equal(modes['artifact-repair-only-v5'].letterConventionsDigest, undefined);
    },
  },
  {
    name: 'letter conventions: v6 prints the letter clause to exactly the scopes whose signed context includes the cover letter, once, after the host conventions and outside the evidence block (4 domains)',
    run() {
      assert.equal(APPLICATION_BLIND_REVIEW_UNGROUNDED_PROMPT_MODE, 'artifact-repair-only-v6');
      assert.notEqual(APPLICATION_BLIND_REVIEW_PROMPT_MODE, APPLICATION_BLIND_REVIEW_UNGROUNDED_PROMPT_MODE, 'v7 is the current mode, minted only from an accessor that carries letter grounding');
      assert.deepEqual([...APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS_TRACKS], LETTER_TRACKS, 'the clause reaches the letter, pair and bundle editorial tracks');
      for (const domain of DOMAINS) {
        const accessor = accessorFor(domain);
        const plan = createApplicationBlindReviewPlan({ sourceAccessor: accessor });
        assert.equal(plan.root.promptMode, 'artifact-repair-only-v6', `${domain.domain}: an accessor with no letter grounding mints v6`);
        const policy = __applicationBlindReviewPolicyForTests(plan.root);
        const signedReaders = Object.entries(policy.allowedContext).filter(([, refs]) => refs.includes('cover-letter')).map(([track]) => track).sort();
        assert.deepEqual(signedReaders, LETTER_TRACKS, `${domain.domain}: the tracks are exactly those whose SIGNED allowed context includes the letter`);
        const seen = new Set();
        for (let ordinal = 0; ordinal < plan.root.scopeCount; ordinal += 1) {
          const prompt = promptAt(plan, accessor, ordinal); const track = trackOf(prompt); seen.add(track);
          const reads = policy.allowedContext[track].includes('cover-letter');
          assert.equal(occurrences(prompt, APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS_V6), reads ? 1 : 0, `${domain.domain}/${track}: the letter clause is printed ${reads ? 'once' : 'never'}`);
          assert.equal(occurrences(prompt, APPLICATION_BLIND_REVIEW_HOST_CONVENTIONS), 1, `${domain.domain}/${track}: the host conventions are still printed once to every track`);
          if (reads) {
            const at = prompt.indexOf(APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS_V6);
            assert(prompt.indexOf(APPLICATION_BLIND_REVIEW_HOST_CONVENTIONS) < at && at < prompt.indexOf('<untrusted-evidence-json>'), `${domain.domain}/${track}: after the host conventions, before the untrusted evidence`);
            assert(!prompt.slice(prompt.indexOf('<untrusted-evidence-json>')).includes('LETTER CONVENTIONS'), `${domain.domain}/${track}: never inside the evidence block`);
          }
          assert.deepEqual(applicationBlindReviewConventionsFor('artifact-repair-only-v6', track), reads ? [APPLICATION_BLIND_REVIEW_HOST_CONVENTIONS, APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS_V6] : [APPLICATION_BLIND_REVIEW_HOST_CONVENTIONS], `${domain.domain}/${track}: the helper agrees with the prompt`);
        }
        assert.equal(seen.size, 6, `${domain.domain}: all six tracks were checked`);
      }
      // Earlier modes get none of it from the helper: v4 neither clause, v5 the host conventions only.
      assert.deepEqual(applicationBlindReviewConventionsFor('artifact-repair-only-v4', 'letter-argument-editorial'), []);
      assert.deepEqual(applicationBlindReviewConventionsFor('artifact-repair-only-v5', 'letter-argument-editorial'), [APPLICATION_BLIND_REVIEW_HOST_CONVENTIONS]);
      assert.deepEqual(applicationBlindReviewConventionsFor('artifact-repair-only-v3', 'letter-argument-editorial'), []);
    },
  },
  {
    name: 'letter conventions: the clause is signed with its tracks, and its wording follows the letter checks\' own budget phrases (mutating either moves the text and the digest)',
    run() {
      const domain = DOMAINS[0];
      const plan = createApplicationBlindReviewPlan({ sourceAccessor: accessorFor(domain) });
      const policy = __applicationBlindReviewPolicyForTests(plan.root);
      const signed = authorityDigest({ tracks: APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS_TRACKS, clause: APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS_V6 });
      assert.equal(policy.letterConventionsDigest, signed, 'the v6 policy signs the tracks and the frozen v6 clause together');
      assert.equal(policy.letterGroundingDigest, undefined, 'v6 signs no letter grounding');
      assert.equal(policy.digest, plan.root.policyDigest);
      // The digest moves with the clause and with the track list (the pins are not vacuous).
      assert.notEqual(authorityDigest({ tracks: APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS_TRACKS, clause: `${APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS_V6} ` }), signed);
      assert.notEqual(authorityDigest({ tracks: LETTER_TRACKS.slice(1), clause: APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS_V6 }), signed);
      // The clause names the paragraph the way the gate that enforces the requirement does.
      const owingProof = coverLetterChecks.OWING_PROOF_PARAGRAPHS; const owingClaim = coverLetterChecks.OWING_CLAIM_PARAGRAPHS ?? owingProof;
      assert(typeof owingProof === 'string' && APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS.includes(owingProof), `the clause uses the letter checks' phrase for the paragraph that owes the sentence (${owingProof})`);
      assert.equal(APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS, buildApplicationBlindReviewLetterConventions({ claimParagraphs: owingClaim, proofParagraphs: owingProof }), 'the constant is the builder applied to those phrases');
      // Mutation A: another budget (two paragraphs owe both) changes the text and the signed digest.
      const two = 'each of the first 2 proof-bearing paragraphs of the letter';
      const widened = buildApplicationBlindReviewLetterConventions({ claimParagraphs: two, proofParagraphs: two });
      assert(widened.includes(two) && widened !== APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS, 'a wider budget is worded into the clause');
      assert.notEqual(authorityDigest({ tracks: APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS_TRACKS, clause: widened }), signed);
      // Mutation B: different budgets for the claim and the relating sentence are worded separately, each with its own paragraphs.
      const split = buildApplicationBlindReviewLetterConventions({ claimParagraphs: two, proofParagraphs: 'the first proof-bearing paragraph of the letter' });
      assert(split.includes(`${two} to carry one phrase`) && split.includes('the first proof-bearing paragraph of the letter to carry one sentence'), 'the two requirements keep their own paragraphs when the budgets differ');
      // Mutation C: with no budget phrase at all the builder falls back to the generic wording rather than naming nothing.
      const generic = buildApplicationBlindReviewLetterConventions({ claimParagraphs: undefined, proofParagraphs: undefined });
      assert(generic.includes('proof-bearing paragraph'), 'a missing phrase never leaves the requirement unnamed');
    },
  },
  {
    name: 'letter conventions: the clause waives nothing, says what a legal correction is, and holds nothing specific to any document (4 domains, A / B)',
    run() {
      const clause = APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS_V6;
      // The function the host requires, named generically.
      for (const part of ['one phrase naming the capability its proof shows', 'one sentence relating that proof to the job need', 'so carrying them is not a defect']) {
        assert(clause.includes(part), `the clause states the requirement: ${part}`);
      }
      // When it IS a defect: the three reasons, plus every other defect as usual.
      for (const part of ['claims more than that paragraph’s own proof supports', 'restates the proof without adding information', 'only echoes the posting’s vocabulary', 'report any other defect in it as in any other sentence']) {
        assert(clause.includes(part), `the clause keeps these reportable: ${part}`);
      }
      // What a correction may and may not do.
      for (const part of ['must reword it, merge it into the proof sentence or shorten it', 'must not delete the only phrase or sentence that performs a required function']) {
        assert(clause.includes(part), `the clause confines the correction: ${part}`);
      }
      // It never tells a reviewer to skip, pass, ignore or exempt, and says that every finding still needs a correction.
      const waivers = /\b(?:ignore|skip|exempt|exempts|pass)\b|(?:do not|never|must not|need not|no need to) (?:report|flag)|(?:not|never) a (?:finding|reason to report)/iu;
      assert(!waivers.test(clause), 'no instruction to skip a defect class or waive a finding');
      assert(clause.includes('This waives nothing: every finding still needs a correction.'), 'the clause says it waives nothing');
      // B (mutation): the denylist is not vacuous - clauses that DO waive are caught by it.
      for (const waiving of [clause.replace('This waives nothing: every finding still needs a correction.', 'Pass such a sentence.'), `${clause} Ignore the first sentence.`,
        clause.replace('Report such a phrase or sentence when it', 'Never report such a phrase or sentence when it'), `${clause} You need not flag it.`]) {
        assert(waivers.test(waiving), `the check catches: ${waiving.slice(-60)}`);
      }
      // Short enough for the prompt envelope, and generic: it is one constant for every document and every candidate.
      assert(Buffer.byteLength(clause, 'utf8') <= 800, `the clause is short (${Buffer.byteLength(clause, 'utf8')} bytes)`);
      assert(!/\d/u.test(clause), 'no figure');
      for (const domain of DOMAINS) {
        const words = new Set([domain.title, domain.employer, domain.bullet, domain.requirement].join(' ').toLowerCase().match(/[a-z]{5,}/gu));
        const shared = clause.toLowerCase().match(/[a-z]{5,}/gu).filter(word => words.has(word) && !['paragraph', 'letter'].includes(word));
        assert(shared.length === 0, `${domain.domain}: the clause shares no content word with this document set (${shared})`);
        const prompts = [];
        const accessor = accessorFor(domain);
        const plan = createApplicationBlindReviewPlan({ sourceAccessor: accessor });
        for (let ordinal = 0; ordinal < plan.root.scopeCount; ordinal += 1) prompts.push(promptAt(plan, accessor, ordinal));
        assert(prompts.filter(prompt => prompt.includes(clause)).length === 3, `${domain.domain}: the very same clause bytes reach exactly three scopes`);
      }
    },
  },
  {
    name: 'letter conventions: a finding about the required phrase or sentence is an ordinary blocking finding with a repair packet; nothing is waived (4 domains, A / B)',
    run() {
      for (const domain of DOMAINS) {
        const accessor = accessorFor(domain);
        const plan = createApplicationBlindReviewPlan({ sourceAccessor: accessor });
        const run = findingScope => {
          let receipts = [];
          for (let ordinal = 0; ordinal < plan.root.scopeCount; ordinal += 1) {
            const work = nextApplicationBlindReviewWork(plan, receipts, { scopeOrdinal: ordinal, sourceAccessor: accessor });
            const { scope } = applicationBlindReviewScopeAt(plan, ordinal, { sourceAccessor: accessor });
            const flagged = scope.track === findingScope;
            receipts = acceptApplicationBlindReviewResponse({ plan, receipts, work, sourceAccessor: accessor, response: {
              version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, scopeDigest: work.scopeDigest, pageIndex: work.pageIndex, previousPageDigest: work.previousPageDigest,
              complete: true, decision: flagged ? 'issues' : 'pass',
              findings: flagged ? [{ id: `${ordinal}-0-1`, ruleId: 'editorial-abstraction', document: 'cover-letter', targetId: 'paragraph-1',
                issue: 'The sentence relating the proof to the job need restates the proof without adding information.', fix: 'Merge that sentence into the proof sentence, keeping the proof as written.' }] : [],
            } });
          }
          return { receipts, ...validateApplicationBlindReviewReceipts(plan, receipts, { sourceAccessor: accessor }) };
        };
        // A: on every letter-reading track the finding is recorded, counted and turned into a repair packet.
        for (const track of LETTER_TRACKS) {
          const flagged = run(track);
          assert.equal(flagged.coverage.clean, false, `${domain.domain}/${track}: the review is not clean`);
          assert.equal(flagged.aggregate.findingCount, 1, `${domain.domain}/${track}: the finding is counted`);
          const packets = createApplicationBlindRepairPackets(plan, flagged.receipts, { sourceAccessor: accessor });
          assert.equal(packets.packetCount, 1, `${domain.domain}/${track}: it has a repair packet`);
          assert.equal(packets.packets[0].track, track);
        }
        // B (mutation): remove the finding and the same review is clean, so the verdict is a function of the finding alone.
        assert.equal(run('no-such-track').coverage.clean, true, `${domain.domain}: without the finding the review is clean`);
      }
    },
  },
  {
    name: 'letter conventions: every letter-reading scope still fits the signed prompt limit with maximal pages, a continuation page and a longest finding id (4 domains)',
    run() {
      const spareBytes = 100;
      for (const domain of DOMAINS) {
        const accessor = accessorFor(domain, { pages: 3 });
        const plan = createApplicationBlindReviewPlan({ sourceAccessor: accessor, promptByteLimit: PLAN_PROMPT_BYTE_LIMIT });
        assert(plan.root.sources.documents.resume.pageCount >= 3 && plan.root.sources.documents.coverLetter.pageCount >= 3, `${domain.domain}: the documents span several full pages`);
        const worst = new Map();
        for (let ordinal = 0; ordinal < plan.root.scopeCount; ordinal += 1) {
          const { scope } = applicationBlindReviewScopeAt(plan, ordinal, { sourceAccessor: accessor });
          const work = nextApplicationBlindReviewWork(plan, [], { scopeOrdinal: ordinal, sourceAccessor: accessor });
          const first = buildApplicationBlindReviewPrompt(plan, work, { sourceAccessor: accessor });
          // A continuation page: the previous page carried the most findings, each with the longest legal id (96 bytes counting the JSON quotes).
          const allowed = scope.track === 'cross-document-coherence' || scope.track === 'bundle-editorial' ? 'resume' : scope.track === 'letter-argument-editorial' ? 'cover-letter' : scope.track === 'resume-hiring-quality' ? 'resume' : null;
          let bytes = Buffer.byteLength(first, 'utf8');
          if (allowed) {
            const prefix = `${ordinal}-0-`;
            const findings = Array.from({ length: 32 }, (_unused, index) => ({ id: `${prefix}${String(index).padStart(2, '0')}${'i'.repeat(94 - prefix.length - 2)}`, ruleId: 'editorial', document: allowed, targetId: 'paragraph-1', issue: 'An issue.', fix: 'A fix.' }));
            const receipts = acceptApplicationBlindReviewResponse({ plan, receipts: [], work, sourceAccessor: accessor, response: {
              version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, scopeDigest: work.scopeDigest, pageIndex: 0, previousPageDigest: work.previousPageDigest, complete: false, decision: 'issues', findings } });
            const next = nextApplicationBlindReviewWork(plan, receipts, { scopeOrdinal: ordinal, sourceAccessor: accessor });
            bytes = Math.max(bytes, Buffer.byteLength(buildApplicationBlindReviewPrompt(plan, next, { sourceAccessor: accessor, previousReceipt: receipts[0] }), 'utf8'));
          }
          worst.set(scope.track, Math.max(worst.get(scope.track) || 0, bytes));
        }
        for (const [track, bytes] of worst) {
          assert(bytes + spareBytes <= PLAN_PROMPT_BYTE_LIMIT, `${domain.domain}/${track}: ${bytes} bytes leaves at least ${spareBytes} under ${PLAN_PROMPT_BYTE_LIMIT}`);
        }
        assert(LETTER_TRACKS.every(track => worst.has(track)), `${domain.domain}: all three letter-reading tracks were measured`);
      }
    },
  },
];
