import fs from 'node:fs';
import crypto from 'node:crypto';
import { buildInterviewAnswerEvidence, INTERVIEW_ANSWER_QUESTION_CATALOG, interviewAnswerBankApplicationDigest } from '../../electron/ipc/interviewAnswerBank.js';
import { deriveInterviewResumeConsistency } from '../../electron/ipc/interviewResumeCoverage.js';

const data = JSON.parse(fs.readFileSync(new URL('./interview-spoken-replay.json', import.meta.url), 'utf8'));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
    : JSON.stringify(value);

/** Entirely synthetic inputs. Recorded claim/citation relationships and the
 * four successive full drafts survive; private identifiers and subjects do not.
 * The returned objects are fresh so repair tests can mutate them independently.
 */
export function interviewSpokenReplayFixture() {
  const canonicalJobUrl = 'https://jobs.example.test/replay-systems-developer';
  const bundleArtifactId = sha('synthetic-spoken-replay-bundle');
  const snapshot = { snapshotId: sha('synthetic-spoken-replay-snapshot'), profile: {
    roles: [
      { id: 'role-1', title: 'Systems Developer', employer: 'Juniper Supply Cooperative' },
      { id: 'role-2', title: 'Information Developer', employer: 'Alder Records Workshop' },
      { id: 'role-3', title: 'Systems Developer', employer: 'Cobalt Dispatch Studio' },
    ], achievements: [], projects: [], otherEvidence: [],
  } };
  for (const [index, source] of data.sources.entries()) {
    const common = { id: source.key, roleId: source.roleId, evidenceSegmentIds: [`segment-${String(index + 1).padStart(4, '0')}`] };
    if (source.entityType === 'achievement') snapshot.profile.achievements.push({ ...common, claim: source.text });
    else if (source.entityType === 'project') snapshot.profile.projects.push({ ...common, name: `Replay project ${index + 1}`, description: source.text });
    else snapshot.profile.otherEvidence.push({ ...common, label: `Replay context ${index + 1}`, text: source.text });
  }
  const bundle = {
    digests: { applicationHtml: sha('synthetic-replay-html'), originalJobListing: sha('synthetic-replay-posting') },
    applicationPositioning: { resume: data.resume, coverLetter: '' },
  };
  const semantic = {
    version: 1,
    inputs: { careerSnapshotId: snapshot.snapshotId, jobUrlSha256: sha(canonicalJobUrl), applicationArtifactId: bundleArtifactId,
      applicationArtifactDigest: interviewAnswerBankApplicationDigest(bundle) },
    role: { title: 'Systems Developer', company: 'Example Studio', location: 'Remote', summary: '' },
    roleThemes: [
      'Premium consumer experiences and monetization without degrading free-user usability.',
      'Full-stack delivery spanning data models, APIs, and polished interfaces.',
      'Preact and Quartz across web and mobile.',
      'Ownership from ambiguous requirements through technical design and launch.',
      'Rapid prototyping, experimentation, and product judgment.',
      'Client/server performance and cross-functional collaboration.',
    ], companyFacts: [], recentContext: [], likelyQuestions: [], questionsToAsk: [], applicationPositioning: [], warnings: [],
  };
  const brief = { ...semantic, briefId: sha(stable(semantic)), createdAt: '2026-01-01T00:00:00.000Z', sources: [] };
  const context = { snapshot, brief, bundle, canonicalJobUrl, bundleArtifactId };
  const evidence = buildInterviewAnswerEvidence(context);
  const byKey = new Map(evidence.map(item => [item.entityId, item.id]));
  const responses = structuredClone(data.responses).map(({ recordedStep, cards }) => {
    // Retain the twelve-card replay shape while exercising the now-required
    // honest introduction fallback. The other recorded claim failures remain.
    const introIntent = INTERVIEW_ANSWER_QUESTION_CATALOG[0];
    const source = data.sources.find(item => item.key === 'source-07');
    const headline = { text: 'I built RPC APIs for the local warehouse database to provide controlled access.',
      evidenceIds: [source.key], quotes: [{ evidenceId: source.key, quote: source.text }] };
    cards[cards.length - 1] = { id: cards.at(-1).id, question: introIntent.question, variants: [...introIntent.variants],
      headline, bullets: [], example: structuredClone(headline), thinEvidence: true,
      consistency: { consistentWithResume: false, resumeQuote: '' } };
    for (const card of cards) {
      // Historical speech replay has no separately generated optional claims.
      // Explicitly exercise the current sparse-empty handoff representation.
      card.extensions = [];
      for (const claim of [card.headline, ...card.bullets, card.example]) {
        claim.evidenceIds = claim.evidenceIds.map(key => byKey.get(key));
        for (const quote of claim.quotes) quote.evidenceId = byKey.get(quote.evidenceId);
      }
      // Start locked-card comparisons from the same verified metadata the host
      // derives before its first inspection, without changing recorded speech.
      const consistency = deriveInterviewResumeConsistency([card.headline, ...card.bullets, card.example],
        evidence.filter(item => item.kind === 'career'), bundle.applicationPositioning.resume);
      if (consistency) card.consistency = consistency;
    }
    return { recordedStep, value: { cards } };
  });
  return { context, evidence, responses };
}
