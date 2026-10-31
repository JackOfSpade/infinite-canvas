import fs from 'node:fs';
import crypto from 'node:crypto';
import { buildInterviewAnswerEvidence, interviewAnswerBankApplicationDigest } from '../../electron/ipc/interviewAnswerBank.js';

const data = JSON.parse(fs.readFileSync(new URL('./interview-answer-v5-replay.json', import.meta.url), 'utf8'));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
    : JSON.stringify(value);

/** Rebuild real content-addressed evidence after consistent synthetic subject
 * substitutions. The sparse recorded repairs remain sparse; no calibrated
 * replacement memorized speech or corrected citations are added by the fixture.
 * Dedicated extension points are identified synthetic additions in the JSON. */
export function interviewAnswerV5ReplayFixture() {
  const fixture = structuredClone(data);
  const snapshot = { snapshotId: sha('synthetic-live-v5-snapshot'), profile: {
    roles: fixture.roles, achievements: [], projects: [], otherEvidence: [],
  } };
  const career = fixture.sources.filter(source => source.kind === 'career');
  for (const [index, source] of career.entries()) {
    const common = { id: source.key, roleId: source.roleId, evidenceSegmentIds: [`segment-${String(index + 1).padStart(4, '0')}`] };
    if (source.entityType === 'achievement') snapshot.profile.achievements.push({ ...common, claim: source.text });
    else if (source.entityType === 'project') snapshot.profile.projects.push({ ...common, name: `Synthetic project ${index + 1}`, description: source.text });
    else snapshot.profile.otherEvidence.push({ ...common, label: `Synthetic context ${index + 1}`, text: source.text });
  }
  const canonicalJobUrl = 'https://jobs.example.test/synthetic-live-v5';
  const bundleArtifactId = sha('synthetic-live-v5-bundle');
  const bundle = { digests: { applicationHtml: sha('synthetic-live-v5-html') },
    listingText: 'Full-stack systems development for a subscription product.',
    applicationPositioning: { resume: fixture.resume, coverLetter: '' } };
  const roleSource = fixture.sources.find(source => source.researchType === 'role');
  const sourceUrl = 'https://company.example.test/product';
  const researchSourceId = sha(sourceUrl).slice(0, 16);
  const semantic = { version: 1,
    inputs: { careerSnapshotId: snapshot.snapshotId, jobUrlSha256: sha(canonicalJobUrl), applicationArtifactId: bundleArtifactId,
      applicationArtifactDigest: interviewAnswerBankApplicationDigest(bundle) },
    role: { title: 'Systems Developer', company: 'Cedar', location: 'Remote', summary: roleSource.text },
    roleThemes: [], companyFacts: fixture.sources.filter(source => source.researchType === 'company').map(source => ({
      sourceId: researchSourceId, fact: source.text, sourceUrl, sourceDate: 'unknown',
    })), recentContext: [], likelyQuestions: [], questionsToAsk: [], applicationPositioning: [], warnings: [],
  };
  const brief = { ...semantic, briefId: sha(stable(semantic)), createdAt: '2026-01-01T00:00:00.000Z',
    sources: [{ sourceId: researchSourceId, sourceUrl, sourceDate: 'unknown' }] };
  const context = { snapshot, brief, bundle, canonicalJobUrl, bundleArtifactId };
  const evidence = buildInterviewAnswerEvidence(context);
  const byKey = new Map(evidence.map(source => [source.entityId, source.id]));
  byKey.set(fixture.sources.find(source => source.researchType === 'company').key,
    evidence.find(source => source.entityId === researchSourceId).id);
  byKey.set(roleSource.key, evidence.find(source => source.sourceField === 'roleContext').id);
  for (const response of fixture.responses) for (const card of response.cards) {
    for (const claim of [card.headline, ...card.bullets, card.example, ...(card.extensions || [])]) {
      claim.evidenceIds = claim.evidenceIds.map(key => byKey.get(key));
      claim.quotes.forEach(quote => { quote.evidenceId = byKey.get(quote.evidenceId); });
    }
  }
  for (const review of fixture.recordedReviews) review.evidenceIds = review.evidenceIds.map(key => byKey.get(key));
  return { ...fixture, context, evidence };
}
