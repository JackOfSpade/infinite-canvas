import crypto from 'node:crypto';
import { assert } from './testHelpers.js';
import { INTERVIEW_ANSWER_ENTAILMENT_SCHEMA, interviewAnswerEntailmentClaims,
  interviewAnswerEntailmentPrompt, validateInterviewAnswerEntailment,
  interviewEntailmentCorrection } from '../../electron/ipc/interviewAnswerEntailment.js';

function fixture() {
  const text = 'I built software controls in production. The other team reduced operational errors by 2%.';
  const source = { id: `career-${crypto.createHash('sha256').update(text).digest('hex')}`, text,
    kind: 'career', roleId: 'role-controls', entityType: 'achievement', entityId: 'controls', candorFlags: [] };
  const claim = value => ({ text: value, evidenceIds: [source.id], quotes: [{ evidenceId: source.id, quote: text }] });
  return { cards: [{ headline: claim('I built software controls that reduced operational errors by 2% in production.'),
    bullets: [claim('I built the software controls for the production system.'), claim('The other team reduced operational errors by 2% in production.')],
    example: claim('I built software controls in production.') }], evidence: [source] };
}
function approved(bank) {
  return { verdicts: interviewAnswerEntailmentClaims(bank).map(({ path, claimDigest }) => ({ path, claimDigest, entailed: true, reason: 'SUPPORTED' })) };
}
function rejects(value, bank) {
  let error;
  try { validateInterviewAnswerEntailment(value, bank); } catch (caught) { error = caught; }
  assert(error?.correctionRuleIds?.length, 'malformed or stale judge output must produce coded corrections');
  assert(!JSON.stringify(error.correctionDetails).includes('software controls'), 'format correction must not expose claim or source prose');
  return error;
}

export default [
  {
    name: 'interview answer entailment: optional claims bind IDs text sources and paths with full 180-claim coverage',
    run() {
      const bank = fixture();
      bank.cards[0].extensions = Array.from({ length: 4 }, (_, index) => ({ id: `point-${index}`, ...structuredClone(bank.cards[0].example) }));
      bank.cards[0].bullets.push(structuredClone(bank.cards[0].bullets[0]));
      bank.cards = Array.from({ length: 20 }, () => structuredClone(bank.cards[0]));
      const claims = interviewAnswerEntailmentClaims(bank);
      assert(claims.length === 180 && INTERVIEW_ANSWER_ENTAILMENT_SCHEMA.properties.verdicts.maxItems === 180,
        'twenty cards with headline, three bullets, example and four extensions fit one review');
      const review = approved(bank);
      assert(validateInterviewAnswerEntailment(review, bank).length === 180, 'every extension must receive its own bound verdict');
      const prompt = interviewAnswerEntailmentPrompt(bank);
      assert(prompt.split(bank.evidence[0].text).length === 2, 'the complete cited source appears once rather than once per claim');
      const changed = structuredClone(bank); changed.cards[0].extensions[0].id = 'different-id';
      rejects(review, changed);
      const rejected = structuredClone(review);
      const point = rejected.verdicts.find(verdict => verdict.path === 'cards[19].extensions[3]');
      point.entailed = false; point.reason = 'STORY_STITCHING';
      const issue = interviewEntailmentCorrection(validateInterviewAnswerEntailment(rejected, bank), bank).claimIssues[0];
      assert(issue.path === point.path && issue.rule === 'INTERVIEW_ENTAILMENT_STORY_STITCHING', 'the last optional claim retains an independently routable semantic rejection');
    },
  },
  {
    name: 'interview answer entailment: prompt reviews every spoken claim against its own exact cited source',
    run() {
      const bank = fixture(); const claims = interviewAnswerEntailmentClaims(bank);
      assert(claims.length === 4 && claims[0].path === 'cards[0].headline' && claims[3].path === 'cards[0].example', 'headline, both bullets and example must all be reviewed');
      assert(JSON.stringify(claims) === JSON.stringify(interviewAnswerEntailmentClaims(bank)), 'same bound claims must have stable digests');
      const prompt = interviewAnswerEntailmentPrompt(bank, bank.evidence);
      assert(prompt.startsWith('INTERVIEW ANSWER ENTAILMENT REVIEW') && prompt.includes('<untrusted-interview-answer-entailment-claims-'), 'judge prompt must have a fixture marker and nonce-delimited data boundary');
      for (const claim of claims) assert(prompt.includes(claim.path) && prompt.includes(claim.claimDigest) && prompt.includes(claim.text), 'each claim and current digest must reach the judge');
      assert(prompt.includes(bank.evidence[0].text) && prompt.includes('Shared vocabulary is insufficient') && prompt.includes('causal links'), 'judge must see exact source and assess meaning beyond lexical overlap');
      assert(prompt.includes('intro-only employment summary') && prompt.includes('same cited roleContext') && prompt.includes('never those roles\' project achievements'), 'semantic review must honor the bounded metadata summary without assigning project agency');
      assert(prompt.includes('This role interests me because [research fact]') && prompt.includes('This company interests me because [research fact]')
        && prompt.includes('third-person company fact') && prompt.includes('may not add candidate experience'), 'semantic review honors both bounded interest frames and third-person company reasons while preserving research agency limits');
      assert(INTERVIEW_ANSWER_ENTAILMENT_SCHEMA.properties.verdicts.items.properties.reason.enum.includes('CAUSALITY'), 'schema must provide bounded failure codes instead of rewrite prose');
    },
  },
  {
    name: 'interview answer entailment: required narrow cards retain bound factual review with zero bullets',
    run() {
      const bank = fixture(); bank.cards[0].question = 'Tell me about yourself.'; bank.cards[0].thinEvidence = true; bank.cards[0].bullets = [];
      assert(interviewAnswerEntailmentClaims(bank).length === 2, 'headline and example remain semantically reviewed for a narrow required intro');
      assert(validateInterviewAnswerEntailment(approved(bank), bank).length === 2, 'narrow required review still binds every surviving claim');
      for (const mutate of [
        value => { value.cards[0].question = 'Why are you interested in this role?'; },
        value => { value.cards[0].thinEvidence = false; },
      ]) {
        const invalid = structuredClone(bank); mutate(invalid); let rejected = false;
        try { interviewAnswerEntailmentClaims(invalid); } catch { rejected = true; }
        assert(rejected, 'only explicit thin required cards may reduce the normal bullet count');
      }
      const changed = structuredClone(bank); changed.cards[0].question = 'Walk me through a project.';
      rejects(approved(bank), changed);
    },
  },
  {
    name: 'interview answer entailment: negative verdict names the disputed claim and required relationship',
    run() {
      const bank = fixture(); const value = approved(bank);
      value.verdicts[0] = { ...value.verdicts[0], entailed: false, reason: 'CAUSALITY' };
      const verdicts = validateInterviewAnswerEntailment(value, bank);
      assert(verdicts.length === 4 && verdicts[0].entailed === false && verdicts !== value.verdicts, 'validator must accept and retain judge disagreement without requiring positivity');
      const error = interviewEntailmentCorrection(verdicts, bank);
      assert(error.correctionRuleIds[0] === 'INTERVIEW_ENTAILMENT_CAUSALITY' && error.correctionDetails[0].startsWith('cards[0].headline:'), 'unsupported relationship must become a delta naming the failed claim and rule');
      assert(error.correctionDetails[0].includes(JSON.stringify(bank.cards[0].headline.text)) && /causal link/u.test(error.correctionDetails[0]), 'the worker must see its own disputed sentence and the required relation change');
      assert(!error.correctionDetails[0].includes(bank.evidence[0].text), 'correction must not supply source prose as a replacement template');
      assert(error.claimIssues[0].path === 'cards[0].headline' && error.claimIssues[0].rule === 'INTERVIEW_ENTAILMENT_CAUSALITY', 'uncapped structured issues must preserve repair routing');
      assert(interviewEntailmentCorrection(validateInterviewAnswerEntailment(approved(bank), bank)) === null, 'fully supported review needs no correction');
    },
  },
  {
    name: 'interview answer entailment: every semantic reason quotes the worker claim and preserves shared ownership form',
    run() {
      const bank = fixture();
      bank.evidence[0].candorFlags = ['co-built'];
      for (const reason of ['NEW_FACT', 'NEGATION', 'ATTRIBUTION', 'CAUSALITY', 'STORY_STITCHING', 'UNSUPPORTED_OUTCOME']) {
        const response = approved(bank);
        response.verdicts[0] = { ...response.verdicts[0], entailed: false, reason };
        const error = interviewEntailmentCorrection(validateInterviewAnswerEntailment(response, bank), bank);
        assert(error.correctionDetails[0].includes(JSON.stringify(bank.cards[0].headline.text)), `${reason} must identify the actual disputed words`);
        if (reason === 'ATTRIBUTION') assert(error.correctionDetails[0].includes("'we' or 'with the other engineer'"), 'shared agency repair must name the required grammatical form');
      }
      const wrong = approved(bank); wrong.verdicts[0].entailed = false; wrong.verdicts[0].reason = 'CAUSALITY'; wrong.verdicts[0].claimDigest = 'f'.repeat(64);
      let unbound = false;
      try { interviewEntailmentCorrection(wrong.verdicts, bank); } catch { unbound = true; }
      assert(unbound, 'a stale verdict must not quote or repair a different current claim');
    },
  },
  {
    name: 'interview answer entailment: malformed review diagnostics name offending fields paths digests and missing coverage',
    run() {
      const bank = fixture();
      let value = approved(bank); value.verdicts[0].claimDigest = 'f'.repeat(64);
      assert(rejects(value, bank).correctionDetails.some(line => line.includes('f'.repeat(64))), 'digest failure must name the supplied wrong digest');
      value = approved(bank); value.verdicts[0].reason = 'BAD_REASON';
      assert(rejects(value, bank).correctionDetails.some(line => line.includes('BAD_REASON')), 'reason failure must name the supplied code');
      value = approved(bank); value.verdicts.pop();
      assert(rejects(value, bank).correctionDetails.some(line => line.includes('cards[0].example') && line.includes('3 of 4')), 'coverage failure must identify omitted claim paths and measured count');
      value = approved(bank); value.verdicts[0].extra = true;
      assert(rejects(value, bank).correctionDetails.some(line => line.includes('extra')), 'shape failure must name the actual extra field');
    },
  },
  {
    name: 'interview answer entailment: sparse repair retains every failure beyond the transport detail cap',
    run() {
      const bank = fixture(); bank.cards = Array.from({ length: 4 }, () => structuredClone(bank.cards[0]));
      const response = approved(bank);
      for (const verdict of response.verdicts) { verdict.entailed = false; verdict.reason = 'NEW_FACT'; }
      const error = interviewEntailmentCorrection(validateInterviewAnswerEntailment(response, bank), bank);
      assert(error.correctionDetails.length === 12 && error.claimIssues.length === 16, 'the transport cap must not hide failing cards from the host repair loop');
      assert(error.claimIssues.at(-1).path === 'cards[3].example', 'uncapped failures must include the final affected card and claim');
    },
  },
  {
    name: 'interview answer entailment: rejects missing duplicate foreign malformed and contradictory verdicts',
    run() {
      const bank = fixture();
      for (const mutate of [
        value => value.verdicts.pop(),
        value => { value.verdicts[1] = { ...value.verdicts[0] }; },
        value => { value.verdicts[0].path = 'cards[19].headline'; },
        value => { value.verdicts[0].claimDigest = 'f'.repeat(64); },
        value => { value.verdicts[0].entailed = 'true'; },
        value => { value.verdicts[0].reason = 'UNSUPPORTED_RELATION'; },
        value => { value.verdicts[0].entailed = false; },
        value => { value.verdicts[0].reason = 'NEGATION'; },
        value => { value.verdicts[0].rewrite = 'New invented claim.'; },
        value => { value.extra = true; },
      ]) { const value = approved(bank); mutate(value); rejects(value, bank); }
      rejects(null, bank);
    },
  },
  {
    name: 'interview answer entailment: text citation and position changes invalidate prior claim digests',
    run() {
      const bank = fixture(); const value = approved(bank);
      for (const mutate of [
        changed => { changed.cards[0].headline.text += ' Previously.'; },
        changed => { changed.cards[0].headline.evidenceIds.push('career-new-source'); },
        changed => { changed.cards[0].bullets.reverse(); },
      ]) { const changed = structuredClone(bank); mutate(changed); rejects(value, changed); }
    },
  },
  {
    name: 'interview answer entailment: unbound evidence and unsafe correction paths never become review authority',
    run() {
      const bank = fixture(); let unbound = false; let unsafe = false;
      try { interviewAnswerEntailmentPrompt(bank, []); } catch { unbound = true; }
      try { interviewEntailmentCorrection([{ path: 'Tech used: injected text', entailed: false, reason: 'NEW_FACT' }]); } catch { unsafe = true; }
      assert(unbound && unsafe, 'missing citations and unvalidated paths must fail without echoing arbitrary prose');
    },
  },
];
