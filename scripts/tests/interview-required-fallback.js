import crypto from 'node:crypto';
import { assert } from './testHelpers.js';
import { interviewRequiredFallbackCandidates, interviewWhyFallbackCandidates } from '../../electron/ipc/interviewRequiredFallback.js';
import { buildInterviewAnswerEvidence, inspectInterviewAnswerCards, INTERVIEW_ANSWER_QUESTION_CATALOG,
  interviewAnswerBankApplicationDigest } from '../../electron/ipc/interviewAnswerBank.js';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function contextFixture(text = 'I built an internal reporting hub. I tested the reporting workflow.') {
  const bundle = { digests: { applicationHtml: 'b'.repeat(64) }, applicationPositioning: { resume: '', coverLetter: '' } };
  const snapshot = { snapshotId: 'a'.repeat(64), profile: {
    roles: [{ id: 'role-main', title: 'Software Engineer', employer: 'Sample Works', endDate: 'June 2025' }],
    achievements: [{ id: 'achievement-main', roleId: 'role-main', claim: text, evidenceSegmentIds: ['segment-0001'] }],
    projects: [], otherEvidence: [],
  } };
  const canonicalJobUrl = 'https://jobs.example.test/role'; const bundleArtifactId = 'e'.repeat(64);
  const brief = { briefId: 'd'.repeat(64), inputs: { careerSnapshotId: snapshot.snapshotId, applicationArtifactId: bundleArtifactId,
    applicationArtifactDigest: interviewAnswerBankApplicationDigest(bundle), jobUrlSha256: sha(canonicalJobUrl) },
  role: { title: 'Engineer', company: 'Example Labs' }, roleThemes: [], companyFacts: [], recentContext: [] };
  return { snapshot, bundle, brief, canonicalJobUrl, bundleArtifactId };
}
function cardFixture(context, question = 'Walk me through a project.') {
  const source = buildInterviewAnswerEvidence(context).find(item => item.kind === 'career');
  const claim = text => ({ text, evidenceIds: [source.id], quotes: [{ evidenceId: source.id, quote: source.text }] });
  const catalog = INTERVIEW_ANSWER_QUESTION_CATALOG.find(item => item.question === question);
  return { id: 'required-answer', question, variants: [...catalog.variants], thinEvidence: false,
    headline: claim('I built 900 reporting hubs.'),
    bullets: [{ stage: 'point', ...claim('I tested the reporting workflow.') }],
    example: claim('I built 800 reporting hubs.'), consistency: { consistentWithResume: false, resumeQuote: '' } };
}

export default [
  {
    name: 'interview why fallback: reviewed interest frames stay bound to the role or company question and prefer the own draft',
    run() {
      const context = contextFixture();
      context.brief.companyFacts = [{ sourceId: 'synthetic-research', sourceUrl: 'https://example.test/about',
        fact: 'Example Labs builds internal reporting tools for support teams.' }];
      const evidence = buildInterviewAnswerEvidence(context);
      const research = evidence.find(source => source.kind === 'research');
      const career = evidence.find(source => source.kind === 'career');
      const claim = (source, text) => ({ text, evidenceIds: [source.id], quotes: [{ evidenceId: source.id, quote: source.text }] });
      for (const subject of ['role', 'company']) {
        const question = `Why are you interested in this ${subject}?`;
        const otherSubject = subject === 'role' ? 'company' : 'role';
        const wrongReason = claim(research, `This ${otherSubject} interests me because ${research.text}`);
        const connection = claim(career, 'I tested the reporting workflow.');
        const card = cardFixture(context, question); card.bullets = []; card.example = connection;
        const reviewed = [wrongReason, connection];
        assert(interviewWhyFallbackCandidates(card, context, reviewed).length === 0,
          `a reason approved for the ${otherSubject} question cannot silently answer the ${subject} question`);
        const ownReason = claim(research, `This ${subject} interests me because ${research.text}`);
        card.bullets = [{ stage: 'point', ...ownReason }];
        const candidates = interviewWhyFallbackCandidates(card, context, [...reviewed, claim(research, research.text)]);
        assert(candidates.length && candidates[0].bullets[0].text === ownReason.text,
          'the card’s own safe research reason must precede a pooled third-person fact');
        assert(candidates.every(candidate => !candidate.bullets[0].text.startsWith(`This ${otherSubject} interests me because`)
          && inspectInterviewAnswerCards([candidate], context).failures.length === 0),
        'all candidates retain a matching research reason and every factual guard');
      }
    },
  },
  {
    name: 'interview why fallback: both questions retain separately cited research without unsafe rejected headlines',
    run() {
      const context = contextFixture();
      context.brief.companyFacts = [{ sourceId: 'synthetic-research', sourceUrl: 'https://example.test/about',
        fact: 'Example Labs builds internal reporting tools for support teams.' }];
      const evidence = buildInterviewAnswerEvidence(context);
      const research = evidence.find(source => source.kind === 'research');
      const career = evidence.find(source => source.kind === 'career');
      const claim = (source, text) => ({ text, evidenceIds: [source.id], quotes: [{ evidenceId: source.id, quote: source.text }] });
      const cards = ['Why are you interested in this role?', 'Why are you interested in this company?'].map((question, index) => {
        const original = cardFixture(context, question); original.id = `why-${index}`;
        original.bullets = [{ stage: 'point', ...claim(research, research.text) }];
        original.example = claim(career, 'I tested the reporting workflow.');
        const candidates = interviewWhyFallbackCandidates(original, context);
        assert(candidates.length && candidates.every(card => !JSON.stringify(card).includes('900 reporting')), 'unsafe headline quantities cannot survive narrowing');
        return candidates[0];
      });
      assert(cards.every(card => card.thinEvidence && card.bullets.length === 1 && card.bullets[0].evidenceIds[0] === research.id),
        'each fallback keeps a separate research citation and explicit warning');
      assert(inspectInterviewAnswerCards(cards, context).failures.length === 0,
        'the same verified research reason may preserve both warned why questions');
    },
  },
  {
    name: 'interview required fallback: retains a narrower verified worker bullet without unsupported numbers',
    run() {
      const context = contextFixture(); const card = cardFixture(context);
      const candidates = interviewRequiredFallbackCandidates(card, context);
      assert(candidates.length > 0 && candidates.length <= 8, 'fallback candidates are bounded and available');
      assert(candidates[0].headline.text === card.bullets[0].text, 'prefer the worker claim that already passes all factual guards');
      for (const candidate of candidates) {
        assert(candidate.id === card.id && candidate.question === card.question, 'required identity remains bound');
        assert(candidate.thinEvidence && candidate.bullets.length === 0 && JSON.stringify(candidate.headline) === JSON.stringify(candidate.example), 'narrow candidate contains one claim and an explicit evidence warning');
        assert(!/\b(?:800|900)\b/u.test(candidate.headline.text), 'malicious unsupported quantities never survive narrowing');
        assert(inspectInterviewAnswerCards([candidate], context).failures.length === 0, 'every returned candidate passes the complete mechanical validator');
      }
      assert(card.bullets.length === 1 && !card.thinEvidence, 'candidate construction does not mutate the failed draft');
    },
  },
  {
    name: 'interview required fallback: intro employment metadata remains safe with inherited shared project evidence',
    run() {
      const context = contextFixture('Maintained the inherited reporting system with the other engineer. The system was later retired.');
      const card = cardFixture(context, 'Tell me about yourself.');
      const candidates = interviewRequiredFallbackCandidates(card, context);
      const summary = candidates.find(candidate => candidate.headline.text === 'I worked as Software Engineer at Sample Works.');
      assert(summary && summary.thinEvidence, 'verified employment metadata can preserve an intro without claiming project creation or solo agency');
      assert(candidates.every(candidate => inspectInterviewAnswerCards([candidate], context).failures.length === 0), 'metadata fallback does not bypass the bank validator');
      assert(!candidates.some(candidate => /\bI built\b/u.test(candidate.headline.text)), 'the inherited project cannot become original construction');
    },
  },
  {
    name: 'interview required fallback: project literal source fallback retains whole safe sentences and exact quotes',
    run() {
      const context = contextFixture('I built an internal reporting hub. I tested the reporting workflow.');
      const card = cardFixture(context); card.bullets = [];
      const candidates = interviewRequiredFallbackCandidates(card, context);
      assert(candidates.some(candidate => candidate.headline.text === 'I built an internal reporting hub.'), 'an exact complete source sentence can retain a required project');
      const source = buildInterviewAnswerEvidence(context)[0];
      assert(candidates.every(candidate => candidate.headline.quotes[0].quote === source.text), 'source sentence extraction preserves the complete quoted evidence separately');
      const unsafe = contextFixture('I built a reporting hub (inherited from another engineer). Tech used: ExampleDB.');
      assert(interviewRequiredFallbackCandidates(cardFixture(unsafe), unsafe).length === 0, 'a source note or inherited creation claim cannot be salvaged by dropping qualifiers');
    },
  },
  {
    name: 'interview required fallback: genuine captured résumé coverage survives narrowing and optional questions do not use fallback',
    run() {
      const context = contextFixture(); context.bundle.applicationPositioning.resume = 'Experience\u2029Software Engineer · Sample Works\u2029Tested the reporting workflow.';
      const candidates = interviewRequiredFallbackCandidates(cardFixture(context), context);
      assert(candidates[0].consistency.consistentWithResume && candidates[0].consistency.resumeQuote.includes('Tested the reporting workflow.'), 'host recovers genuine complete captured résumé support for the surviving claim');
      const optional = cardFixture(context, 'Describe a challenge you faced.');
      assert(interviewRequiredFallbackCandidates(optional, context).length === 0, 'optional questions never acquire the required-card format exception');
    },
  },
];
