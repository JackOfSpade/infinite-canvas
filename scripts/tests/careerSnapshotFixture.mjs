// A deliberately complete v5 snapshot fixture for integration tests that
// exercise the main-process pinned-snapshot gate.  Tests must not bypass that
// gate with an arbitrary-looking digest: production derives the pin from the
// immutable approved record, so the fixture does too.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import electronPkg from 'electron';
import {
  CAREER_SNAPSHOT_COMPILATION_CONTRACT,
  CAREER_SNAPSHOT_SCHEMA_VERSION,
  CAREER_SNAPSHOT_STATUS_APPROVED,
  buildCareerSourceCorpus,
  canonicalCareerProfileDigest,
  careerSnapshotId,
  careerSnapshotStorageRoot,
  emptyCareerReconciliationReceipt,
  partitionCareerSourcePages,
  verbatimCareerTranscriptionAuditReceipt,
  writeCareerSnapshotAtomically,
} from '../../electron/ipc/careerSnapshot.js';

const digest = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const canonicalJson = value => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};

function cleanAuditHistory(corpus, profile) {
  const pages = partitionCareerSourcePages(corpus);
  const deterministicFailureDigest = digest(canonicalJson([]));
  const audits = [
    ['coverage', 'career-profile-audit-completeness'],
    ['grounding', 'career-profile-audit-grounding'],
    ['attribution', 'career-profile-audit-attribution'],
    ['metrics', 'career-profile-audit-metrics'],
    ['skills', 'career-profile-audit-skills'],
    ['conflict', 'career-profile-audit-conflicts'],
  ].map(([category, task]) => {
    let chainDigest = digest(canonicalJson({ category, task, seed: 'career-page-audit-v1' }));
    const pageAudits = pages.map(page => {
      const findingDigest = digest(canonicalJson([]));
      chainDigest = digest(canonicalJson({ prior: chainDigest, pageId: page.id, pageIndex: page.index, findingCount: 0, findingDigest }));
      return { pageId: page.id, pageIndex: page.index, findingCount: 0, findingDigest, chainDigest };
    });
    const receipt = pageAudits.map(({ pageId, pageIndex, findingCount, findingDigest, chainDigest }) => ({ pageId, pageIndex, findingCount, findingDigest, chainDigest }));
    return { category, task, findingCount: 0, findingDigest: digest(canonicalJson(receipt)), findings: [], pageAudits };
  });
  // Production convergence uses the semantic (order-insensitive) profile
  // digest. Fixtures must issue the same receipt rather than a raw JSON hash.
  const profileDigest = canonicalCareerProfileDigest(profile);
  const unresolvedFindingDigest = digest(canonicalJson({
    deterministicFailureDigest,
    audits: audits.map(audit => ({ category: audit.category, findingCount: audit.findingCount, findingDigest: audit.findingDigest })),
  }));
  return [{
    round: 0, profileDigest, unresolvedFindingDigest,
    stateDigest: digest(canonicalJson({ profileDigest, unresolvedFindingDigest })),
    deterministicFailureCount: 0, deterministicFailureDigest, deterministicFailures: [], audits, unresolvedCount: 0,
  }];
}

/** Publish a real approved snapshot in the isolated Electron test userData. */
export async function writeApprovedCareerSnapshotFixture({ sourceName = 'Work Experience.md' } = {}) {
  const text = 'Ada Lovelace\nSoftware Engineer at Acme\nJanuary 2020 to Present\nBuilt a Python service used by 50 users.\nada@example.test\n';
  const corpus = buildCareerSourceCorpus([{
    name: sourceName, contentHash: digest(text), text, legacyText: text,
    transcriptionAudit: verbatimCareerTranscriptionAuditReceipt(),
  }]);
  const evidenceSegmentIds = corpus.segments.map(segment => segment.id);
  const profile = {
    identity: { name: 'Ada Lovelace', contacts: ['ada@example.test'], evidenceSegmentIds },
    roles: [{ id: 'role-acme', title: 'Software Engineer', employer: 'Acme', startDate: 'January 2020', endDate: 'Present', location: '', achievementIds: ['achievement-service'], skillIds: ['skill-python'], evidenceSegmentIds }],
    achievements: [{
      id: 'achievement-service', roleId: 'role-acme', claim: 'Built a Python service used by 50 users.', technologies: ['Python'],
      technologyReferences: [{ technology: 'Python', disposition: 'skill', skillId: 'skill-python', relationship: 'independent', relationshipGroup: '', relationshipEvidence: 'Built a Python service used by 50 users.', evidenceSegmentIds }],
      metrics: [{ label: 'users', value: '50', unit: 'users', evidenceSegmentIds }], evidenceSegmentIds,
    }],
    projects: [], skills: [{ id: 'skill-python', name: 'Python', category: 'language', capabilityKind: 'language', supportMode: 'direct', directEvidenceSegmentIds: evidenceSegmentIds, indexEligible: true, roleIds: ['role-acme'], evidenceSegmentIds }], education: [], certifications: [], otherEvidence: [],
    segmentCoverage: corpus.segments.map(segment => ({ segmentId: segment.id, disposition: 'achievement', entityIds: ['identity', 'role-acme', 'achievement-service', 'skill-python'] })),
  };
  const snapshotId = careerSnapshotId(corpus);
  const pages = partitionCareerSourcePages(corpus);
  const root = careerSnapshotStorageRoot(electronPkg.app.getPath('userData'));
  // The stub deliberately leaves userData absent; production Electron creates it.
  await fs.promises.mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
  await writeCareerSnapshotAtomically(root, {
    schemaVersion: CAREER_SNAPSHOT_SCHEMA_VERSION, status: CAREER_SNAPSHOT_STATUS_APPROVED,
    snapshotId, inputFingerprint: corpus.inputFingerprint, sourceFingerprint: corpus.sourceFingerprint,
    compilationContract: CAREER_SNAPSHOT_COMPILATION_CONTRACT,
    pagePlan: { maxSegments: 32, maxSourceChars: 48_000, pageCount: pages.length, pageDigest: digest(canonicalJson(pages.map(page => ({ id: page.id, index: page.index, segmentIds: page.segmentIds })))) },
    reconciliation: emptyCareerReconciliationReceipt(), approvedAt: '2026-10-07T00:00:00.000Z',
    sources: corpus.sources, segments: corpus.segments, profile, auditHistory: cleanAuditHistory(corpus, profile),
  });
  return { snapshotId, profile, careerData: text };
}
