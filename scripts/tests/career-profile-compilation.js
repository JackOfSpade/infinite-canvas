import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { assert } from './testHelpers.js';
import { MAX_SOURCE_GROUNDING_QUOTE_CHARS } from '../../electron/ipc/applicationSourceLimits.js';
import { careerDataProjectProvenanceHeadingForName, resumeRoleLocationFailures } from '../../electron/ipc/jobApplication.js';
import {
  buildCareerProfileCompilePrompt,
  buildCareerProfilePageRepairPrompt,
  approvedCareerEvidenceCatalog,
  buildCareerProfileAuditPrompt,
  buildCareerProfilePageCompilePrompt,
  buildCareerSourceCorpus,
  CAREER_APPLICATION_HISTORICAL_PROJECTION_FORMAT,
  CAREER_APPLICATION_PROJECTION_FORMAT,
  CAREER_SNAPSHOT_HISTORICAL_MAX_SEGMENTS,
  CAREER_SNAPSHOT_COMPILATION_CONTRACT,
  CAREER_TRANSCRIPTION_POLICY_DIGEST,
  CAREER_SNAPSHOT_MAX_FILE_BYTES,
  CAREER_SNAPSHOT_SCHEMA_VERSION,
  CAREER_SNAPSHOT_SEGMENT_POLICY,
  CAREER_PROFILE_COMPILE_SCHEMA,
  CAREER_PROFILE_PAGE_SCHEMA,
  __setCareerSnapshotReadHookForTests,
  careerDataFromCareerSnapshot,
  careerAttachmentRegionPartPageId,
  canonicalCareerProfileDigest,
  careerSnapshotId,
  careerSnapshotIdForContract,
  careerSnapshotInputFingerprint,
  compileAuditedCareerSnapshot,
  emptyCareerReconciliationReceipt,
  partitionCareerSourcePages,
  projectApprovedCareerSnapshotForApplication,
  projectLegacyCareerProfile,
  readCareerSnapshot,
  readPinnedCareerSnapshot,
  segmentCareerSourceText,
  stableCareerJsonDigest,
  validateCareerProfile,
  vettedCareerSkillInventory,
  isCareerSkillIndexEligible,
  validateCareerTranscriptionAuditReceipt,
  validateCurrentCareerSnapshot,
  verbatimCareerTranscriptionAuditReceipt,
  writeCareerSnapshotAtomically,
} from '../../electron/ipc/careerSnapshot.js';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function cleanAuditHistory() {
  const emptyDigest = crypto.createHash('sha256').update('[]').digest('hex');
  return [{
    round: 0,
    deterministicFailureCount: 0,
    deterministicFailures: [],
    audits: [
      ['coverage', 'career-profile-audit-completeness'],
      ['grounding', 'career-profile-audit-grounding'],
      ['attribution', 'career-profile-audit-attribution'],
      ['metrics', 'career-profile-audit-metrics'],
      ['skills', 'career-profile-audit-skills'],
      ['conflict', 'career-profile-audit-conflicts'],
    ].map(([category, task]) => ({ category, task, findingCount: 0, findingDigest: emptyDigest, findings: [] })),
    unresolvedCount: 0,
  }];
}

function currentCleanAuditHistory(corpus, profile) {
  const pages = partitionCareerSourcePages(corpus);
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
    const receiptParts = pageAudits.map(({ pageId, pageIndex, findingCount, findingDigest, chainDigest: receiptChain }) => ({ pageId, pageIndex, findingCount, findingDigest, chainDigest: receiptChain }));
    return { category, task, findingCount: 0, findingDigest: digest(canonicalJson(receiptParts)), findings: [], pageAudits };
  });
  const deterministicFailureDigest = digest(canonicalJson([]));
  const unresolvedFindingDigest = digest(canonicalJson({
    deterministicFailureDigest,
    audits: audits.map(audit => ({ category: audit.category, findingCount: audit.findingCount, findingDigest: audit.findingDigest })),
  }));
  const profileDigest = canonicalCareerProfileDigest(profile);
  return [{
    round: 0, profileDigest, unresolvedFindingDigest,
    stateDigest: digest(canonicalJson({ profileDigest, unresolvedFindingDigest })),
    deterministicFailureCount: 0, deterministicFailureDigest, deterministicFailures: [], audits, unresolvedCount: 0,
  }];
}

function currentSnapshot(corpus, profile) {
  const pages = partitionCareerSourcePages(corpus);
  return {
    schemaVersion: CAREER_SNAPSHOT_SCHEMA_VERSION, status: 'approved', snapshotId: careerSnapshotId(corpus), inputFingerprint: corpus.inputFingerprint,
    sourceFingerprint: corpus.sourceFingerprint, compilationContract: CAREER_SNAPSHOT_COMPILATION_CONTRACT,
    pagePlan: {
      maxSegments: 32, maxSourceChars: 48_000, pageCount: pages.length,
      pageDigest: digest(canonicalJson(pages.map(page => ({ id: page.id, index: page.index, segmentIds: page.segmentIds })))),
    },
    reconciliation: emptyCareerReconciliationReceipt(),
    approvedAt: '2026-10-07T00:00:00.000Z', sources: corpus.sources, segments: corpus.segments,
    profile, auditHistory: currentCleanAuditHistory(corpus, profile),
  };
}

function sourceFiles() {
  const text = 'Ada Lovelace\r\nSoftware Engineer at Acme in Toronto\r\nJanuary 2020 to Present\r\nBuilt Python service used by 50 users.\r\nada@example.test\r\n';
  return [{ name: 'Work Experience.md', contentHash: 'a'.repeat(64), text, legacyText: text.replace(/\r\n/gu, '\n'), transcriptionAudit: verbatimCareerTranscriptionAuditReceipt() }];
}

function validProfile(corpus) {
  const evidence = corpus.segments.map(segment => segment.id);
  return {
    identity: { name: 'Ada Lovelace', contacts: ['ada@example.test'], evidenceSegmentIds: evidence },
    roles: [{
      id: 'role-acme', title: 'Software Engineer', employer: 'Acme', startDate: 'January 2020', endDate: 'Present', location: 'Toronto',
      achievementIds: ['achievement-service'], skillIds: ['skill-python'], evidenceSegmentIds: evidence,
    }],
    achievements: [{
      id: 'achievement-service', roleId: 'role-acme', claim: 'Built Python service used by 50 users.', technologies: ['Python'],
      technologyReferences: [{
        technology: 'Python', disposition: 'skill', skillId: 'skill-python', relationship: 'independent', relationshipGroup: '',
        relationshipEvidence: 'Built Python service used by 50 users.', evidenceSegmentIds: evidence,
      }],
      metrics: [{ label: 'users', value: '50', unit: 'users', evidenceSegmentIds: evidence }], evidenceSegmentIds: evidence,
    }],
    projects: [],
    skills: [{
      id: 'skill-python', name: 'Python', category: 'language', capabilityKind: 'language', supportMode: 'direct',
      directEvidenceSegmentIds: evidence, indexEligible: true, roleIds: ['role-acme'], evidenceSegmentIds: evidence,
    }],
    education: [], certifications: [], otherEvidence: [],
    segmentCoverage: corpus.segments.map(segment => ({ segmentId: segment.id, disposition: 'achievement', entityIds: ['identity', 'role-acme', 'achievement-service', 'skill-python'] })),
  };
}

function pagedSourceFiles(lines) {
  const text = lines.map(line => `${line}\n`).join('');
  return [{ name: 'Paged Career.md', contentHash: 'b'.repeat(64), text, transcriptionAudit: verbatimCareerTranscriptionAuditReceipt() }];
}

function pageTransport(profile) {
  const shard = structuredClone(profile);
  // Current v6 pages carry a source-relationship ledger and an explicit
  // support mode. Most of the older paging fixtures are intentionally about
  // other mechanics, so add the least-assertive independent/direct fixtures
  // here rather than silently exercising a historical contract. Adversarial
  // relation tests below supply their own explicit values.
  const ensureTechnologyReferences = (entity, evidenceSegmentIds) => {
    if (!Array.isArray(entity?.technologies) || Array.isArray(entity.technologyReferences)) return;
    entity.technologyReferences = entity.technologies.map(technology => ({
      technology, disposition: 'skill', relationship: 'independent', relationshipGroup: '',
      relationshipEvidence: technology, evidenceSegmentIds: [...(evidenceSegmentIds || [])],
    }));
  };
  for (const entity of [...(shard.achievements || []), ...(shard.projects || [])]) {
    ensureTechnologyReferences(entity, entity?.evidenceSegmentIds);
  }
  for (const skill of shard.skills || []) {
    if (skill?.capabilityKind == null) skill.capabilityKind = 'technology';
    if (skill?.supportMode == null) skill.supportMode = 'direct';
    if (skill?.directEvidenceSegmentIds == null) skill.directEvidenceSegmentIds = [...(skill?.evidenceSegmentIds || [])];
  }
  for (const patch of shard.projectPatches || []) {
    ensureTechnologyReferences(patch?.updates, patch?.evidenceSegmentIds);
  }
  // skillId is host-owned: page responders supply literal references and the
  // compiler binds a reconciled skill after all pages have merged.
  for (const entity of [...(shard.achievements || []), ...(shard.projects || [])]) {
    for (const reference of entity?.technologyReferences || []) delete reference.skillId;
  }
  for (const patch of shard.projectPatches || []) {
    for (const reference of patch?.updates?.technologyReferences || []) delete reference.skillId;
  }
  shard.rolePatches = Array.isArray(shard.rolePatches) ? shard.rolePatches : [];
  shard.projectPatches = Array.isArray(shard.projectPatches) ? shard.projectPatches : [];
  shard.continuationState = shard.continuationState || {
    roles: { mode: Array.isArray(shard.roles) && shard.roles.length ? 'replace' : 'inherit', ids: Array.isArray(shard.roles) ? shard.roles.map(role => role.id) : [] },
    projects: { mode: Array.isArray(shard.projects) && shard.projects.length ? 'replace' : 'inherit', ids: Array.isArray(shard.projects) ? shard.projects.map(project => project.id) : [] },
  };
  return shard;
}

function emptyPageShard(segmentId, { name = '', contacts = [] } = {}) {
  return pageTransport({
    identity: { name, contacts, evidenceSegmentIds: [segmentId] },
    roles: [], achievements: [], projects: [], skills: [], education: [], certifications: [], otherEvidence: [],
    segmentCoverage: [{ segmentId, disposition: 'context', entityIds: ['identity'] }],
  });
}

function crossPageShard(corpus, pageIndex, { changedRole = false } = {}) {
  const segmentId = corpus.segments[pageIndex].id;
  if (pageIndex === 0) return emptyPageShard(segmentId, { name: 'Ada Lovelace' });
  if (pageIndex === 1) {
    const role = {
      id: 'role-acme', title: changedRole ? 'Engineer' : 'Software Engineer', employer: 'Acme', startDate: 'January 2020', endDate: 'Present', location: 'Toronto',
      achievementIds: [], skillIds: [], evidenceSegmentIds: [segmentId],
    };
    return {
      ...emptyPageShard(segmentId), roles: [role],
      continuationState: { roles: { mode: 'replace', ids: [role.id] }, projects: { mode: 'inherit', ids: [] } },
      segmentCoverage: [{ segmentId, disposition: 'role-header', entityIds: ['identity', 'role-acme'] }],
    };
  }
  const claim = pageIndex === 2 ? 'Built Python service used by 50 users.' : 'Built Python report used by 60 users.';
  const users = pageIndex === 2 ? '50' : '60';
  const achievement = {
    id: `achievement-${pageIndex}`, roleId: 'p0002-role-acme', claim, technologies: ['Python'],
    technologyReferences: [{
      technology: 'Python', disposition: 'skill', relationship: 'independent', relationshipGroup: '',
      relationshipEvidence: claim, evidenceSegmentIds: [segmentId],
    }],
    metrics: [{ label: 'users', value: users, unit: 'users', evidenceSegmentIds: [segmentId] }], evidenceSegmentIds: [segmentId],
  };
  const skill = {
    id: `skill-python-${pageIndex}`, name: 'Python', category: 'language', capabilityKind: 'language', supportMode: 'direct',
    directEvidenceSegmentIds: [segmentId], indexEligible: true, roleIds: ['p0002-role-acme'], evidenceSegmentIds: [segmentId],
  };
  return {
    ...emptyPageShard(segmentId), achievements: [achievement], skills: [skill],
    segmentCoverage: [{ segmentId, disposition: 'achievement', entityIds: ['identity', achievement.id, skill.id] }],
  };
}

export default [
  {
    name: 'career snapshot: segmentation is bounded, stable, and losslessly reconstructs the supplied corpus',
    run: () => {
      const text = `first\r\n${'x'.repeat(600)}\nlast`;
      const pieces = segmentCareerSourceText(text, { maxChars: 256, sourceId: 'source-0007' });
      assert(pieces.length >= 3 && pieces.every((piece, index) => piece.id === `segment-${String(index + 1).padStart(4, '0')}`)
        && pieces.every(piece => piece.sourceId === 'source-0007') && pieces.map(piece => piece.text).join('') === text,
      'bounded segmentation must retain every exact character, source identity, and stable ordered ID');
      const original = sourceFiles();
      const corpus = buildCareerSourceCorpus(original);
      assert(corpus.combinedText.includes('===== FILE: Work Experience.md =====\nAda Lovelace\n')
        && corpus.sources[0].text.includes('\r\n') && corpus.sources[0].legacyText.includes('\n'),
      'compiler segments use supplied rich text while the legacy view keeps the caller-provided legacy projection');
      assert(careerDataFromCareerSnapshot({ sources: corpus.sources }) === corpus.combinedText,
        'legacy compatibility consumers must receive the same audited plain-text corpus projection');
      assert(corpus.segments.length === 5
        && corpus.segments.map(segment => segment.text).join('') === original[0].text
        && corpus.segments.every(segment => segment.text.length <= 4_000),
      'a typical free-form career file is split into exact independently attributable physical-line evidence, while pathological lines stay bounded and lossless');
      const manyLines = buildCareerSourceCorpus([{
        name: 'more-than-five-thousand-lines.md', text: 'Context\n'.repeat(5_001), transcriptionAudit: verbatimCareerTranscriptionAuditReceipt(),
      }]);
      const manyProfile = {
        identity: { name: '', contacts: [], evidenceSegmentIds: manyLines.segments.map(segment => segment.id) },
        roles: [], achievements: [], projects: [], skills: [], education: [], certifications: [], otherEvidence: [],
        segmentCoverage: manyLines.segments.map(segment => ({ segmentId: segment.id, disposition: 'context', entityIds: ['identity'] })),
      };
      const manySnapshot = currentSnapshot(manyLines, manyProfile);
      const manyPages = partitionCareerSourcePages(manyLines, { maxSegments: 32, maxSourceChars: 48_000 });
      assert(CAREER_SNAPSHOT_SEGMENT_POLICY.maxSegments === undefined
        && manyLines.segments.length === 5_001 && manyPages.length > 1
        && manySnapshot.pagePlan.pageCount === manyPages.length && validateCurrentCareerSnapshot(manySnapshot).valid,
      'current v5 must partition and validate more than 5,000 exact source lines without a corpus-wide count gate or thousands of AI calls');
      return { segments: pieces.length, normalLineSegments: corpus.segments.length, pagedLineSegments: manyLines.segments.length };
    },
  },
  {
    name: 'career snapshot: input identity is pre-AI, ordered, duplicate-basename safe, and contract-bound',
    run: () => {
      const base = sourceFiles();
      const sameRawDifferentOcr = [{ ...base[0], text: 'A different OCR projection' }];
      const input = careerSnapshotInputFingerprint(base);
      const corpus = buildCareerSourceCorpus(base);
      const changedCorpus = buildCareerSourceCorpus(sameRawDifferentOcr);
      assert(input === careerSnapshotInputFingerprint(sameRawDifferentOcr)
        && careerSnapshotId(corpus) === careerSnapshotId(changedCorpus)
        && corpus.sourceFingerprint !== changedCorpus.sourceFingerprint,
      'unchanged original content identity must hit before OCR while a changed compiled corpus remains detectable at publication');
      const duplicateNames = buildCareerSourceCorpus([
        { name: 'Work Experience.md', contentHash: 'b'.repeat(64), text: 'one' },
        { name: 'Work Experience.md', contentHash: 'c'.repeat(64), text: 'two' },
      ]);
      assert(duplicateNames.sources[0].id !== duplicateNames.sources[1].id
        && duplicateNames.sources[0].contentHash !== duplicateNames.sources[1].contentHash,
      'duplicate display basenames must remain distinct ordered source identities');
      return { snapshotId: careerSnapshotId(corpus).slice(0, 12) };
    },
  },
  {
    name: 'career snapshot: validator enforces literal grounding, typed reciprocal links, and exhaustive coverage',
    run: () => {
      const corpus = buildCareerSourceCorpus(sourceFiles());
      const profile = validProfile(corpus);
      const accepted = validateCareerProfile(profile, corpus);
      assert(accepted.valid, `a fully evidence-linked profile should validate: ${accepted.errors.join(' | ')}`);
      const broken = structuredClone(profile);
      broken.achievements[0].metrics[0].evidenceSegmentIds = ['segment-9999'];
      broken.roles[0].skillIds = ['achievement-service'];
      broken.segmentCoverage[0].entityIds = ['identity'];
      delete broken.skills[0].indexEligible;
      broken.unexpected = true;
      broken.segmentCoverage[0].disposition = 'made-up-disposition';
      broken.skills.push({ ...profile.skills[0], id: 'skill-python-duplicate', name: 'Ｐｙｔｈｏｎ' });
      broken.roles[0].skillIds.push('skill-python-duplicate');
      broken.segmentCoverage.forEach(entry => entry.entityIds.push('skill-python-duplicate'));
      const rejected = validateCareerProfile(broken, corpus);
      assert(!rejected.valid && rejected.errors.some(error => /metric cites unknown/.test(error))
        && rejected.errors.some(error => /non-skill/.test(error))
        && rejected.errors.some(error => /without reciprocal coverage/.test(error))
        && rejected.errors.some(error => /indexEligible must be a boolean/.test(error))
        && rejected.errors.some(error => /Career profile schema \$\.unexpected is not an allowed property/.test(error))
        && rejected.errors.some(error => /Career profile schema \$\.segmentCoverage\[0\]\.disposition/.test(error))
        && rejected.errors.some(error => /duplicates the Unicode\/case-insensitive skill name/.test(error))
        && CAREER_PROFILE_COMPILE_SCHEMA.properties.skills.items.required.includes('indexEligible'),
      'invalid metric provenance, wrong typed links, nonreciprocal coverage, and a missing skill index classification must block approval');
      const legacy = projectLegacyCareerProfile(profile, { referenceDate: new Date(Date.UTC(2026, 0, 1)) });
      assert(legacy.workHistory[0].location === 'Toronto' && legacy.experience_years > 5 && legacy.skills[0] === 'Python',
        'legacy projection must retain work metadata and conservatively derive rather than erase dated experience');
      return { errors: rejected.errors.length, years: legacy.experience_years };
    },
  },
  {
    name: 'career snapshot: a direct occurrence sharing qualified evidence remains usable, while a relation-only occurrence cannot become an ATS skill',
    run: () => {
      const profileFor = (text) => {
        const files = sourceFiles();
        files[0] = { ...files[0], text: files[0].text.replace('Built Python service used by 50 users.', text), legacyText: files[0].legacyText.replace('Built Python service used by 50 users.', text) };
        const corpus = buildCareerSourceCorpus(files);
        const profile = validProfile(corpus);
        const relationSegmentId = corpus.segments.find(segment => segment.text.includes(text))?.id;
        if (!relationSegmentId) throw new Error('The direct/qualified regression fixture lost its source segment.');
        const references = ['Python', 'R'].map(technology => ({
          technology, disposition: 'skill', skillId: technology === 'Python' ? 'skill-python' : 'skill-r',
          relationship: 'alternative', relationshipGroup: 'reporting-choice', relationshipEvidence: 'Python or R',
          evidenceSegmentIds: [relationSegmentId],
        }));
        profile.achievements[0] = {
          ...profile.achievements[0], claim: text, technologies: ['Python', 'R'], technologyReferences: references,
          metrics: [], evidenceSegmentIds: [relationSegmentId],
        };
        profile.skills = [
          {
            ...profile.skills[0], evidenceSegmentIds: [relationSegmentId], directEvidenceSegmentIds: [relationSegmentId],
            roleIds: ['role-acme'],
          },
          {
            id: 'skill-r', name: 'R', category: 'language', capabilityKind: 'language', supportMode: 'relationship-qualified',
            directEvidenceSegmentIds: [], indexEligible: false, roleIds: ['role-acme'], evidenceSegmentIds: [relationSegmentId],
          },
        ];
        profile.roles[0].skillIds = ['skill-python', 'skill-r'];
        profile.segmentCoverage = corpus.segments.map(segment => ({
          segmentId: segment.id, disposition: 'achievement',
          entityIds: ['identity', 'role-acme', ...(segment.id === relationSegmentId ? ['achievement-service', 'skill-python', 'skill-r'] : [])],
        }));
        return { corpus, profile };
      };
      const shared = profileFor('Built Python service; for reporting, Python or R.');
      const accepted = validateCareerProfile(shared.profile, shared.corpus);
      assert(accepted.valid, `a separately direct Python occurrence on the same physical source line should remain valid: ${accepted.errors.join(' | ')}`);
      const relationOnly = profileFor('For reporting, Python or R.');
      const rejected = validateCareerProfile(relationOnly.profile, relationOnly.corpus);
      assert(!rejected.valid && rejected.errors.some(error => /outside every literal relationshipEvidence slice/.test(error)),
        'a directEvidenceSegmentId whose only Python occurrence belongs to an alternative relation must remain ineligible for bare ATS projection');

      // The literal relation naturally crosses two physical-line segments. Its
      // exact casing, three spaces, and CRLF must be retained, while the first
      // uppercase PYTHON occurrence is independently direct evidence.
      const crossFiles = sourceFiles();
      const crossClaim = 'Built PYTHON service; for reporting, PYTHON   or\r\nR.';
      crossFiles[0] = {
        ...crossFiles[0],
        text: crossFiles[0].text.replace('Built Python service used by 50 users.\r\n', `${crossClaim}\r\n`),
        legacyText: crossFiles[0].legacyText.replace('Built Python service used by 50 users.\n', `${crossClaim.replace(/\r\n/gu, '\n')}\n`),
      };
      const crossCorpus = buildCareerSourceCorpus(crossFiles);
      const firstCrossSegment = crossCorpus.segments.find(segment => segment.text.includes('Built PYTHON service'));
      const secondCrossSegment = crossCorpus.segments.find(segment => segment.text === 'R.\r\n');
      if (!firstCrossSegment || !secondCrossSegment) throw new Error('The cross-segment relationship fixture lost a physical source line.');
      const crossEvidenceSegmentIds = [firstCrossSegment.id, secondCrossSegment.id];
      const crossProfile = validProfile(crossCorpus);
      crossProfile.achievements[0] = {
        ...crossProfile.achievements[0], claim: crossClaim, technologies: ['PYTHON', 'R'], metrics: [], evidenceSegmentIds: crossEvidenceSegmentIds,
        technologyReferences: ['PYTHON', 'R'].map(technology => ({
          technology, disposition: 'skill', skillId: technology === 'PYTHON' ? 'skill-python' : 'skill-r',
          relationship: 'alternative', relationshipGroup: 'cross-line-choice', relationshipEvidence: 'PYTHON   or\r\nR.',
          evidenceSegmentIds: crossEvidenceSegmentIds,
        })),
      };
      crossProfile.skills = [
        { ...crossProfile.skills[0], evidenceSegmentIds: crossEvidenceSegmentIds, directEvidenceSegmentIds: [firstCrossSegment.id], roleIds: ['role-acme'] },
        {
          id: 'skill-r', name: 'R', category: 'language', capabilityKind: 'language', supportMode: 'relationship-qualified',
          directEvidenceSegmentIds: [], indexEligible: false, roleIds: ['role-acme'], evidenceSegmentIds: crossEvidenceSegmentIds,
        },
      ];
      crossProfile.roles[0].skillIds = ['skill-python', 'skill-r'];
      crossProfile.segmentCoverage = crossCorpus.segments.map(segment => ({
        segmentId: segment.id, disposition: 'achievement',
        entityIds: ['identity', 'role-acme', ...(crossEvidenceSegmentIds.includes(segment.id) ? ['achievement-service', 'skill-python', 'skill-r'] : [])],
      }));
      const crossAccepted = validateCareerProfile(crossProfile, crossCorpus);
      assert(crossAccepted.valid, `a case-insensitive direct name beside an exact whitespace-preserving cross-line relation should validate: ${crossAccepted.errors.join(' | ')}`);
      const whitespaceParaphrase = structuredClone(crossProfile);
      whitespaceParaphrase.achievements[0].technologyReferences.forEach(reference => { reference.relationshipEvidence = 'PYTHON or\nR.'; });
      const whitespaceRejected = validateCareerProfile(whitespaceParaphrase, crossCorpus);
      assert(!whitespaceRejected.valid
        && whitespaceRejected.errors.some(error => /relationshipEvidence must be a literal source slice/.test(error))
        && !whitespaceRejected.errors.some(error => /outside every literal relationshipEvidence slice/.test(error)),
      'a whitespace/case-normalized paraphrase of a relationship source slice must be rejected as non-literal without falsely rejecting separately direct evidence');
      return {
        directSharedLineAccepted: accepted.valid,
        relationOnlyRejected: !rejected.valid,
        crossSegmentLiteralAccepted: crossAccepted.valid,
        whitespaceParaphraseRejected: !whitespaceRejected.valid,
      };
    },
  },
  {
    name: 'career snapshot: host derives unbounded reciprocal page coverage and rejects a genuine invalid draft before handoff acceptance',
    run: async () => {
      const corpus = buildCareerSourceCorpus(sourceFiles());
      const evidence = corpus.segments.map(segment => segment.id);
      const manyEvidence = Array.from({ length: 65 }, (_value, index) => ({
        id: `evidence-${index}`,
        kind: 'identity-note', label: 'Ada Lovelace', text: 'Ada Lovelace', evidenceSegmentIds: evidence,
      }));
      const good = pageTransport({
        identity: { name: 'Ada Lovelace', contacts: ['ada@example.test'], evidenceSegmentIds: evidence },
        roles: [], achievements: [], projects: [], skills: [], education: [], certifications: [], otherEvidence: manyEvidence,
        // The compiler owns only the one-per-segment disposition. Empty or
        // stale candidate entityIds are intentionally ignored and rebuilt by
        // the host after page IDs are qualified.
        segmentCoverage: evidence.map(segmentId => ({ segmentId, disposition: 'role-header', entityIds: [] })),
        continuationState: { roles: { mode: 'inherit', ids: [] }, projects: { mode: 'inherit', ids: [] } },
      });
      const bad = structuredClone(good);
      bad.otherEvidence[0].evidenceSegmentIds = ['segment-9999'];
      // A duplicate disposition is invalid in its own right.  The first
      // candidate entry also carries an invented inverse id to prove host
      // normalization clears *every* duplicate before choosing its map entry;
      // otherwise an irrelevant stale id changes the retry diagnostic.
      const duplicateCoverage = structuredClone(good);
      duplicateCoverage.segmentCoverage = [
        {
          segmentId: evidence[0], disposition: 'context',
          entityIds: ['invented-model-entity'],
        },
        ...duplicateCoverage.segmentCoverage,
      ];
      let domainRejection = null;
      let duplicateCoverageRejection = null;
      const result = await compileAuditedCareerSnapshot({
        sourceFiles: sourceFiles(),
        callText: async (prompt, options) => {
          if (options.task === 'career-profile-compile') {
            assert(prompt.includes('host deterministically derives coverage.entityIds'),
              'the compiler prompt must make the host-owned coverage inverse explicit');
            try { options.responseValidator(bad); } catch (error) { domainRejection = error; }
            assert(domainRejection?.code === 'CAREER_SNAPSHOT_PAGE_INVALID'
              && ['CAREER_PAGE_COVERAGE_RECIPROCITY', 'CAREER_PAGE_REFERENCE_INVALID', 'CAREER_PAGE_VALIDATION_FAILED'].includes(domainRejection?.validationDiagnostic?.reason),
            'a domain-invalid shard must reject inside the active handoff with a safe actionable correction category');
            try { options.responseValidator(duplicateCoverage); } catch (error) { duplicateCoverageRejection = error; }
            assert(duplicateCoverageRejection?.validationDiagnostic?.reason === 'CAREER_PAGE_COVERAGE_SEGMENT'
              && !duplicateCoverageRejection.message.includes('invented-model-entity'),
            'duplicate segment coverage must be rejected as a cardinality defect after every stale model inverse id is cleared, not misclassified as reciprocal coverage');
            options.responseValidator(good);
            return good;
          }
          if (options.task.startsWith('career-profile-audit-')) return { findings: [] };
          throw new Error(`Unexpected task ${options.task}`);
        },
      });
      const derivedValidation = validateCurrentCareerSnapshot(result.snapshot);
      assert(result.snapshot.status === 'approved'
        && result.profile.segmentCoverage.every(entry => entry.entityIds.length === 66)
        && result.profile.segmentCoverage.every(entry => entry.entityIds.includes('identity'))
        && derivedValidation.valid,
      'host-derived reciprocal coverage must support more than the former 64 entity response cap while a bad first draft remains repairable in its original handoff');
      return { reciprocalIdsPerSegment: result.profile.segmentCoverage[0].entityIds.length };
    },
  },
  {
    name: 'career snapshot: role links are reciprocal and cannot attribute one fact to another role',
    run: () => {
      const corpus = buildCareerSourceCorpus(sourceFiles());
      const profile = validProfile(corpus);
      const evidence = corpus.segments.map(segment => segment.id);
      profile.roles.push({
        id: 'role-other', title: 'Software Engineer', employer: 'Acme', startDate: 'January 2019', endDate: 'December 2019', location: 'Toronto',
        achievementIds: ['achievement-service'], skillIds: ['skill-python'], evidenceSegmentIds: evidence,
      });
      profile.achievements[0].roleId = 'role-other';
      profile.segmentCoverage.forEach(entry => entry.entityIds.push('role-other'));
      const rejected = validateCareerProfile(profile, corpus);
      assert(!rejected.valid
        && rejected.errors.some(error => /roles\[role-acme\]\.achievementIds links achievement achievement-service whose roleId is not role-acme/.test(error))
        && rejected.errors.some(error => /roles\[role-other\]\.skillIds links skill skill-python whose roleIds omit role-other/.test(error)),
      'a role may reference only achievements owned by it and skills that explicitly link back to it');
      return { reciprocalErrors: rejected.errors.filter(error => /links (achievement|skill)/.test(error)).length };
    },
  },
  {
    name: 'career snapshot: application projection is profile-only, deterministic, complete, and parser-shaped',
    run: () => {
      const profile = {
        identity: { name: 'Ada Lovelace', contacts: ['ada@example.test', '+1 416 555 0100'] },
        roles: [
          { id: 'role-acme-engineer', title: 'Software Engineer', employer: 'Acme', startDate: 'January 2020', endDate: 'Present', location: 'Toronto, Ontario', achievementIds: ['achievement-service'], skillIds: ['skill-python'] },
          { id: 'role-acme-intern', title: 'Engineering Intern', employer: 'Acme', startDate: 'May 2019', endDate: 'August 2019', location: 'Toronto, Ontario', achievementIds: [], skillIds: ['skill-collaboration'] },
        ],
        achievements: [
          { id: 'achievement-service', roleId: 'role-acme-engineer', claim: 'Built Python service used by 50 users.', technologies: ['Python', 'PostgreSQL'], metrics: [{ label: 'users', value: '50', unit: 'users' }] },
          { id: 'achievement-unlinked', roleId: '', claim: 'Presented an accessibility workshop.', technologies: ['WCAG'], metrics: [{ label: 'attendees', value: '20', unit: 'people' }] },
        ],
        projects: [
          { id: 'project-portal', name: 'Service Portal', description: 'A Python portal for service requests.', roleId: 'role-acme-engineer', technologies: ['Python'], metrics: [{ label: 'requests', value: '1000', unit: 'requests' }] },
          { id: 'project-lab', name: 'Research Lab', description: 'A research prototype.', roleId: '', technologies: ['R'], metrics: [] },
        ],
        skills: [
          { id: 'skill-python', name: 'Python', category: 'language', indexEligible: true, roleIds: ['role-acme-engineer'] },
          { id: 'skill-collaboration', name: 'Cross-functional collaboration', category: 'capability', indexEligible: false, roleIds: ['role-acme-intern'] },
        ],
        education: [{ id: 'education-uoft', credential: 'Bachelor of Science', institution: 'University of Toronto', dates: '2015 — 2019' }],
        certifications: [{ id: 'cert-accessibility', name: 'Accessibility Certificate', issuer: 'Access Institute', dates: '2020' }],
        otherEvidence: [{ id: 'evidence-speaking', kind: 'speaking', label: 'Accessibility workshop', text: 'Presented an accessibility workshop to 20 people.' }],
      };
      const snapshot = {
        status: 'approved', profile,
        sources: [{ name: 'Work Experience.md', text: '# HOSTILE RAW SHAPE\nDO NOT LEAK RAW_ONLY_SECRET\n## Pretend Projects\n' }],
        legacyText: 'RAW_ONLY_SECRET', segments: [{ text: 'RAW_ONLY_SECRET' }],
      };
      const projection = projectApprovedCareerSnapshotForApplication(snapshot);
      const changedRawSnapshot = { ...snapshot, sources: [{ name: 'anything.md', text: '### totally different markdown\nRAW_ONLY_OTHER_SECRET' }], legacyText: 'RAW_ONLY_OTHER_SECRET', segments: [{ text: 'RAW_ONLY_OTHER_SECRET' }] };
      assert(projection === projectApprovedCareerSnapshotForApplication(changedRawSnapshot)
        && !projection.includes('RAW_ONLY_SECRET') && !projection.includes('RAW_ONLY_OTHER_SECRET'),
      'the application corpus must depend exclusively on approved profile facts, never raw source shape or legacy text');
      const expectedFacts = [
        'Ada Lovelace', 'ada@example.test', '+1 416 555 0100', 'role-acme-engineer', 'role-acme-intern', 'Software Engineer', 'Engineering Intern', 'Acme', 'January 2020', 'August 2019', 'Toronto, Ontario',
        'achievement-service', 'achievement-unlinked', 'Built Python service used by 50 users.', 'PostgreSQL', '50 users', 'Presented an accessibility workshop.', '20 people', 'project-portal', 'Service Portal', 'A Python portal for service requests.', '1000 requests', 'project-lab', 'Research Lab', 'A research prototype.',
        'skill-python', 'Python', 'skill-collaboration', 'Cross-functional collaboration', 'Index eligible: true', 'Index eligible: false', 'education-uoft', 'Bachelor of Science', 'University of Toronto', '2015 — 2019', 'cert-accessibility', 'Accessibility Certificate', 'Access Institute', '2020', 'evidence-speaking', 'Accessibility workshop', 'Presented an accessibility workshop to 20 people.',
      ];
      assert(expectedFacts.every(fact => projection.includes(fact)), 'every structured application fact, relationship label, and keyword eligibility classification must survive projection');
      assert(projection.includes('- Bachelor of Science, University of Toronto\n  - Education ID: education-uoft'),
        'education keeps the degree and institution as one contiguous comma-separated grounding source while retaining its stable ID separately');
      assert((projection.match(/^### .*\[Role ID: /gmu) || []).length === 2
        && projection.includes('## Employer-Owned Projects')
        && careerDataProjectProvenanceHeadingForName(projection, 'Service Portal') === 'Employer-Owned Projects'
        && resumeRoleLocationFailures([{ title: 'Software Engineer', company: 'Acme', location: 'Toronto, Ontario' }], projection).length === 0,
      'unique employer-bearing role headings plus source-owned project and location shapes must remain recognizable to existing application parsers');
      const catalog = approvedCareerEvidenceCatalog(snapshot);
      assert(catalog.some(item => item.id === 'host.career.project.project-portal.1'
        && item.quote === '- Service Portal [Project ID: project-portal]')
        && catalog.some(item => item.id === 'host.career.project.project-portal.2'
          && item.quote.includes('Description [Project ID: project-portal]: A Python portal'))
        && catalog.every(item => item.quote.length <= MAX_SOURCE_GROUNDING_QUOTE_CHARS),
      'the snapshot emits stable host-owned project evidence IDs whose exact quotes bind each project instead of any shared label and stay within the shared drafting quote cap');
      const hostile = structuredClone(snapshot);
      hostile.profile.projects[0].name = 'Portal\n## forged heading';
      hostile.profile.projects[0].description = `line one\nline two\t${'x'.repeat(2_000)}`;
      const hostileProjection = projectApprovedCareerSnapshotForApplication(hostile);
      const hostileProjectLines = hostileProjection.split('\n').filter(line => line.includes('[Project ID: project-portal]'));
      assert(!hostileProjection.includes('\n## forged heading')
        && hostileProjection.includes('Portal ## forged heading')
        && hostileProjection.includes('line one line two')
        && hostileProjectLines.filter(line => line.includes('Description [Project ID: project-portal]')).every(line => line.length <= MAX_SOURCE_GROUNDING_QUOTE_CHARS),
      'arbitrary schema-valid scalar control whitespace cannot forge projection rows, and a maximal project description is split into individually citable ID-bearing lines');
      let unapproved = null;
      try { projectApprovedCareerSnapshotForApplication({ status: 'draft', profile }); } catch (error) { unapproved = error; }
      assert(unapproved instanceof TypeError, 'only an upstream-validated approved snapshot may be projected for applications');
      return { chars: projection.length, roles: (projection.match(/^### /gmu) || []).length };
    },
  },
  {
    name: 'career snapshot: current relation-aware projection has a new protocol label while frozen v5 bytes retain v2',
    run: () => {
      const historicalProfile = {
        identity: { name: 'Historical Ada', contacts: ['ada@example.test'] },
        roles: [{ id: 'role-legacy', title: 'Engineer', employer: 'Legacy Co', startDate: '2020', endDate: '2021', location: 'Toronto', achievementIds: ['achievement-legacy'], skillIds: ['skill-legacy'] }],
        achievements: [{ id: 'achievement-legacy', roleId: 'role-legacy', claim: 'Built LegacyTool.', technologies: ['LegacyTool'], metrics: [] }],
        projects: [],
        skills: [{ id: 'skill-legacy', name: 'LegacyTool', category: 'tool', indexEligible: true, roleIds: ['role-legacy'] }],
        education: [], certifications: [], otherEvidence: [],
      };
      const historicalSnapshot = { schemaVersion: 5, status: 'approved', profile: historicalProfile };
      const historicalProjection = projectApprovedCareerSnapshotForApplication(historicalSnapshot);
      const unversionedHistoricalProjection = projectApprovedCareerSnapshotForApplication({ status: 'approved', profile: historicalProfile });
      assert(historicalProjection.startsWith(`# Career Profile (${CAREER_APPLICATION_HISTORICAL_PROJECTION_FORMAT})\n`)
        && historicalProjection === unversionedHistoricalProjection
        && digest(historicalProjection) === 'af47980be09bf2294fcd390ac17b1c56cf61c79edf7ed779bc163bc2083fe35c',
      'a frozen v5 application projection must retain its exact v2 header and byte digest');

      const corpus = buildCareerSourceCorpus(sourceFiles());
      const currentProjection = projectApprovedCareerSnapshotForApplication(currentSnapshot(corpus, validProfile(corpus)));
      assert(currentProjection.startsWith(`# Career Profile (${CAREER_APPLICATION_PROJECTION_FORMAT})\n`)
        && !currentProjection.startsWith(`# Career Profile (${CAREER_APPLICATION_HISTORICAL_PROJECTION_FORMAT})\n`),
      'a validated v6 snapshot must declare its distinct relation-aware application projection protocol');
      return { historicalDigest: digest(historicalProjection).slice(0, 12), currentFormat: CAREER_APPLICATION_PROJECTION_FORMAT };
    },
  },
  {
    name: 'career snapshot: relation-qualified technology stays source-linked and out of every bare current inventory',
    run: () => {
      // None of these labels are special-cased in production code. The fixture
      // deliberately combines an alternative, an independently demonstrated
      // tool, and an artifact-like data feed so the invariant is about source
      // semantics rather than any known vendor/product vocabulary.
      const source = [
        'Ada Example\n',
        'Platform Engineer at Maple Systems\n',
        'January 2020 to Present\n',
        'Selected Cedar or Juniper based on deployment constraints.\n',
        'Maintained Spruce tooling for on-call diagnosis.\n',
        "Published Orchard telemetry feed through the public Gateway API using the Agency's daily emissions for analysts.\n",
        'ada@example.test\n',
      ].join('');
      const corpus = buildCareerSourceCorpus([{
        name: 'free-form-career.txt', text: source,
        transcriptionAudit: verbatimCareerTranscriptionAuditReceipt(),
      }]);
      const segment = literal => {
        const found = corpus.segments.find(item => item.text.includes(literal));
        if (!found) throw new Error(`Missing fixture segment for ${literal}`);
        return found.id;
      };
      const identityName = segment('Ada Example');
      const roleHeader = segment('Platform Engineer at Maple Systems');
      const roleDates = segment('January 2020 to Present');
      const relation = segment('Selected Cedar or Juniper');
      const direct = segment('Maintained Spruce tooling');
      const artifact = segment('Published Orchard telemetry feed');
      const contact = segment('ada@example.test');
      const relationEvidence = 'Selected Cedar or Juniper based on deployment constraints.';
      const directEvidence = 'Maintained Spruce tooling for on-call diagnosis.';
      const artifactEvidence = "Published Orchard telemetry feed through the public Gateway API using the Agency's daily emissions for analysts.";
      const profile = {
        identity: { name: 'Ada Example', contacts: ['ada@example.test'], evidenceSegmentIds: [identityName, contact] },
        roles: [{
          id: 'role-maple', title: 'Platform Engineer', employer: 'Maple Systems', startDate: 'January 2020', endDate: 'Present', location: '',
          achievementIds: ['achievement-choice', 'achievement-spruce', 'achievement-feed'], skillIds: ['skill-cedar', 'skill-juniper', 'skill-spruce'],
          evidenceSegmentIds: [roleHeader, roleDates],
        }],
        achievements: [{
          id: 'achievement-choice', roleId: 'role-maple', claim: relationEvidence, technologies: ['Cedar', 'Juniper'], metrics: [], evidenceSegmentIds: [relation],
          technologyReferences: [
            { technology: 'Cedar', disposition: 'skill', skillId: 'skill-cedar', relationship: 'alternative', relationshipGroup: 'runtime-choice', relationshipEvidence: relationEvidence, evidenceSegmentIds: [relation] },
            { technology: 'Juniper', disposition: 'skill', skillId: 'skill-juniper', relationship: 'alternative', relationshipGroup: 'runtime-choice', relationshipEvidence: relationEvidence, evidenceSegmentIds: [relation] },
          ],
        }, {
          id: 'achievement-spruce', roleId: 'role-maple', claim: directEvidence, technologies: ['Spruce'], metrics: [], evidenceSegmentIds: [direct],
          technologyReferences: [{ technology: 'Spruce', disposition: 'skill', skillId: 'skill-spruce', relationship: 'independent', relationshipGroup: '', relationshipEvidence: directEvidence, evidenceSegmentIds: [direct] }],
        }, {
          id: 'achievement-feed', roleId: 'role-maple', claim: artifactEvidence, technologies: ['Orchard telemetry feed', 'Gateway API', "Agency's daily emissions"], metrics: [], evidenceSegmentIds: [artifact],
          technologyReferences: [
            { technology: 'Orchard telemetry feed', disposition: 'non-skill', relationship: 'independent', relationshipGroup: '', relationshipEvidence: 'Orchard telemetry feed', evidenceSegmentIds: [artifact], nonSkillReason: 'A published data feed is an output, not a candidate capability.' },
            { technology: 'Gateway API', disposition: 'non-skill', relationship: 'independent', relationshipGroup: '', relationshipEvidence: 'Gateway API', evidenceSegmentIds: [artifact], nonSkillReason: 'A public interface owned by another organization is a source endpoint, not candidate capability evidence.' },
            { technology: "Agency's daily emissions", disposition: 'non-skill', relationship: 'independent', relationshipGroup: '', relationshipEvidence: "Agency's daily emissions", evidenceSegmentIds: [artifact], nonSkillReason: 'Organization-produced data is an external output, not a candidate capability.' },
          ],
        }],
        projects: [],
        skills: [
          { id: 'skill-cedar', name: 'Cedar', category: 'platform', capabilityKind: 'platform', supportMode: 'relationship-qualified', directEvidenceSegmentIds: [], indexEligible: false, roleIds: ['role-maple'], evidenceSegmentIds: [relation] },
          { id: 'skill-juniper', name: 'Juniper', category: 'platform', capabilityKind: 'platform', supportMode: 'relationship-qualified', directEvidenceSegmentIds: [], indexEligible: false, roleIds: ['role-maple'], evidenceSegmentIds: [relation] },
          { id: 'skill-spruce', name: 'Spruce', category: 'tool', capabilityKind: 'tool', supportMode: 'direct', directEvidenceSegmentIds: [direct], indexEligible: true, roleIds: ['role-maple'], evidenceSegmentIds: [direct] },
        ],
        education: [], certifications: [], otherEvidence: [],
        segmentCoverage: [
          { segmentId: identityName, disposition: 'identity', entityIds: ['identity'] },
          { segmentId: roleHeader, disposition: 'role-header', entityIds: ['role-maple'] },
          { segmentId: roleDates, disposition: 'role-header', entityIds: ['role-maple'] },
          { segmentId: relation, disposition: 'achievement', entityIds: ['achievement-choice', 'skill-cedar', 'skill-juniper'] },
          { segmentId: direct, disposition: 'achievement', entityIds: ['achievement-spruce', 'skill-spruce'] },
          { segmentId: artifact, disposition: 'achievement', entityIds: ['achievement-feed'] },
          { segmentId: contact, disposition: 'identity', entityIds: ['identity'] },
        ],
      };
      const validation = validateCareerProfile(profile, corpus);
      const inventory = vettedCareerSkillInventory(profile);
      const snapshot = currentSnapshot(corpus, profile);
      const projection = projectApprovedCareerSnapshotForApplication(snapshot);
      const catalog = approvedCareerEvidenceCatalog(snapshot);
      const compilePrompt = buildCareerProfileCompilePrompt(corpus);
      const auditPrompt = buildCareerProfileAuditPrompt(corpus, profile, 'skills');
      const pagePrompt = buildCareerProfilePageCompilePrompt(corpus, partitionCareerSourcePages(corpus)[0]);
      const relationAsBareDirect = structuredClone(profile);
      relationAsBareDirect.skills[0] = {
        ...relationAsBareDirect.skills[0], supportMode: 'direct', directEvidenceSegmentIds: [relation], indexEligible: true,
      };
      const missingDisposition = structuredClone(profile);
      missingDisposition.achievements[2].technologyReferences = [];
      const missingExternalDisposition = structuredClone(profile);
      missingExternalDisposition.achievements[2].technologyReferences = missingExternalDisposition.achievements[2].technologyReferences
        .filter(reference => reference.technology !== 'Gateway API');
      assert(validation.valid
        && JSON.stringify(inventory.map(skill => skill.name)) === JSON.stringify(['Spruce'])
        && !isCareerSkillIndexEligible(profile.skills[0]) && isCareerSkillIndexEligible(profile.skills[2])
        && JSON.stringify(projectLegacyCareerProfile(profile).skills) === JSON.stringify(['Spruce'])
        && projection.includes('Usage relationship [Achievement ID: achievement-choice]: alternative')
        && projection.includes('Relationship group [Achievement ID: achievement-choice]: runtime-choice')
        && projection.includes('Relationship evidence [Achievement ID: achievement-choice]: Selected Cedar or Juniper based on deployment constraints.')
        && !projection.includes('- Cedar [Skill ID: skill-cedar]')
        && !projection.includes('- Juniper [Skill ID: skill-juniper]')
        && projection.includes('- Spruce [Skill ID: skill-spruce]')
        && !catalog.some(item => /^host\.career\.skill\.(?:skill-cedar|skill-juniper)\./u.test(item.id))
        && catalog.some(item => /^host\.career\.skill\.skill-spruce\./u.test(item.id))
        && catalog.some(item => item.id.startsWith('host.career.achievement.achievement-choice.') && item.quote.includes('Usage relationship'))
        && !profile.skills.some(skill => ['Gateway API', "Agency's daily emissions"].includes(skill.name))
        && !validateCareerProfile(relationAsBareDirect, corpus).valid
        && !validateCareerProfile(missingDisposition, corpus).valid
        && !validateCareerProfile(missingExternalDisposition, corpus).valid
        && compilePrompt.includes('not as a token rule')
        && compilePrompt.includes('organization-owned system')
        && compilePrompt.includes('semantic completeness')
        && !compilePrompt.includes('For EVERY technology/tool candidate label')
        && compilePrompt.includes('data feed/dataset')
        && auditPrompt.includes('not a deterministic token checklist')
        && auditPrompt.includes('do not assume the existing technologies array is complete')
        && auditPrompt.includes('organization-owned system')
        && auditPrompt.includes('Audit EVERY skill row')
        && pagePrompt.includes('keep that group self-contained')
        && pagePrompt.includes('semantic completeness')
        && !pagePrompt.includes('For EVERY technology/tool candidate label')
        && pagePrompt.includes('directEvidenceSegmentIds'),
      'alternative/conditional semantics remain relation-aware evidence, every extracted label—including external interfaces and organization-produced data—has a skill or audited non-skill disposition, only separately direct evidence reaches inventory/catalog skill rows, and compile/audit/page prompts retain generic semantic defenses');
      return { inventory: inventory.map(skill => skill.name), catalogRows: catalog.length, relationAware: true };
    },
  },
  {
    name: 'career snapshot: current structured projections above the legacy raw freeze ceiling remain readable',
    run: async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-snapshot-large-projection-'));
      try {
        // The authoritative source remains one small, exact segment. The
        // approved structured profile is deliberately larger than the legacy
        // unpinned raw-source freeze ceiling, while remaining well inside the
        // immutable snapshot envelope.
        const payload = 'p'.repeat(1_900);
        const corpus = buildCareerSourceCorpus([{
          name: 'large-structured-projection.md', text: `Evidence ${payload}\n`,
          transcriptionAudit: verbatimCareerTranscriptionAuditReceipt(),
        }]);
        const segmentId = corpus.segments[0].id;
        const otherEvidence = Array.from({ length: 140 }, (_value, index) => ({
          id: `evidence-${index}`,
          kind: 'note',
          label: 'Evidence',
          text: payload,
          evidenceSegmentIds: [segmentId],
        }));
        const profile = {
          identity: { name: '', contacts: [], evidenceSegmentIds: [segmentId] },
          roles: [], achievements: [], projects: [], skills: [], education: [], certifications: [], otherEvidence,
          segmentCoverage: [{ segmentId, disposition: 'context', entityIds: ['identity', ...otherEvidence.map(item => item.id)] }],
        };
        const snapshot = currentSnapshot(corpus, profile);
        const projection = projectApprovedCareerSnapshotForApplication(snapshot);
        const validation = validateCurrentCareerSnapshot(snapshot);
        const written = await writeCareerSnapshotAtomically(root, snapshot);
        const loaded = await readCareerSnapshot(root, snapshot.snapshotId);
        assert(projection.length > 240_000 && validation.valid && written.created
          && loaded?.snapshotId === snapshot.snapshotId,
        'current snapshot validation, publication, and reading must page structured authority without applying the legacy 240k raw-source freeze limit');
        return { projectionChars: projection.length, snapshotId: snapshot.snapshotId.slice(0, 12) };
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'career snapshot: compiler converges beyond the former repair cap, fully re-audits in parallel, and records progress receipts',
    run: async () => {
      const corpus = buildCareerSourceCorpus(sourceFiles());
      const good = validProfile(corpus);
      const bad = structuredClone(good);
      bad.achievements[0].claim = 'Invented outcome';
      bad.skills.push({ ...good.skills[0], id: 'skill-python-duplicate', name: 'python' });
      bad.roles[0].skillIds.push('skill-python-duplicate');
      bad.segmentCoverage.forEach(entry => entry.entityIds.push('skill-python-duplicate'));
      const badVariants = Array.from({ length: 6 }, (_value, index) => {
        const variant = structuredClone(bad);
        // Each retry is substantively distinct yet still source-invalid, so
        // the state-recurrence guard—not array-order churn—proves convergence
        // can continue beyond a historic aggregate retry cap.
        variant.achievements[0].claim = `Invented outcome ${index + 1}`;
        return variant;
      });
      const tasks = [];
      let repairCalls = 0;
      const result = await compileAuditedCareerSnapshot({
        sourceFiles: sourceFiles(),
        callText: async (_prompt, options) => {
          tasks.push(options.task);
          if (options.task === 'career-profile-compile') return pageTransport(bad);
          if (options.task === 'career-profile-repair') return pageTransport(repairCalls++ < badVariants.length ? badVariants[repairCalls - 1] : good);
          return { findings: [] };
        },
      });
      const auditTasks = tasks.filter(task => task.startsWith('career-profile-audit-'));
      assert(result.snapshot.status === 'approved' && result.snapshot.auditHistory.length === 2
        && tasks[0] === 'career-profile-compile' && repairCalls === 7 && auditTasks.length === 6
        && result.snapshot.auditHistory[0].kind === 'folded' && result.snapshot.auditHistory[0].roundCount === 7
        && result.snapshot.auditHistory[1].audits.length === 6
        && validateCurrentCareerSnapshot(result.snapshot).valid
        && result.snapshot.auditHistory.slice(1).every(round => /^[a-f0-9]{64}$/.test(round.profileDigest)
          && /^[a-f0-9]{64}$/.test(round.unresolvedFindingDigest) && /^[a-f0-9]{64}$/.test(round.stateDigest)),
      'deterministic grounding or duplicate canonical-skill defects may require more than the former cap, then every independent audit reruns; old detailed rounds fold into one chained compact receipt instead of growing the snapshot without bound');
      let oversized = null;
      try { buildCareerProfileCompilePrompt(corpus, { maxPromptChars: 12 }); } catch (error) { oversized = error; }
      assert(oversized?.code === 'CAREER_SNAPSHOT_PROMPT_TOO_LARGE', 'oversized source prompts must fail explicitly, never silently truncate career evidence');
      return { tasks: tasks.length, repairCalls, auditTasks: auditTasks.length };
    },
  },
  {
    name: 'career snapshot: paged compilation namespaces cross-page roles, covers every segment, and audits every bounded page in parallel',
    run: async () => {
      const files = pagedSourceFiles([
        'Ada Lovelace',
        'Software Engineer Engineer Acme January 2020 Present Toronto',
        'Built Python service used by 50 users.',
        'Built Python report used by 60 users.',
      ]);
      const corpus = buildCareerSourceCorpus(files);
      const tasks = [];
      let activeAudits = 0;
      let maxActiveAudits = 0;
      const result = await compileAuditedCareerSnapshot({
        sourceFiles: files,
        pageMaxSegments: 1,
        pageMaxSourceChars: 1,
        workerCount: 4,
        callText: async (_prompt, options) => {
          tasks.push({ task: options.task, pageIndex: options.hints.pageIndex });
          if (options.task === 'career-profile-compile') return crossPageShard(corpus, options.hints.pageIndex);
          if (options.task.startsWith('career-profile-audit-')) {
            activeAudits += 1;
            maxActiveAudits = Math.max(maxActiveAudits, activeAudits);
            await new Promise(resolve => setTimeout(resolve, 2));
            activeAudits -= 1;
            return { findings: [] };
          }
          throw new Error(`Unexpected task ${options.task}`);
        },
      });
      const role = result.profile.roles[0];
      assert(result.profile.achievements.length === 2 && result.profile.skills.length === 1
        && result.profile.achievements.every(item => item.roleId === role.id)
        && role.achievementIds.length === 2 && role.skillIds.length === 1
        && result.profile.segmentCoverage.map(entry => entry.segmentId).join(',') === corpus.segments.map(segment => segment.id).join(',')
        && new Set(result.profile.segmentCoverage.map(entry => entry.segmentId)).size === corpus.segments.length
        && tasks.filter(entry => entry.task === 'career-profile-compile').length === 4
        && tasks.filter(entry => entry.task.startsWith('career-profile-audit-')).length === 24
        && maxActiveAudits > 1 && validateCareerProfile(result.profile, corpus).valid,
      'one-segment pages must keep an inherited role as a stable host ID, merge its reciprocal links and duplicate demonstrated skill evidence, cover every source segment exactly once, and launch all six audits across bounded pages through the worker pool');
      return { pages: 4, auditCalls: 24, maxActiveAudits };
    },
  },
  {
    name: 'career snapshot: host merge exceeds a former single-response role cap without relaxing page output caps',
    run: async () => {
      const priorResponseRoleCap = CAREER_PROFILE_PAGE_SCHEMA.properties.roles.maxItems;
      const roleCount = priorResponseRoleCap + 1;
      const files = pagedSourceFiles(Array.from({ length: roleCount }, (_value, index) => `Role ${index} Acme January 2020 Present Toronto`));
      const corpus = buildCareerSourceCorpus(files);
      let activeAudits = 0;
      let maxActiveAudits = 0;
      const result = await compileAuditedCareerSnapshot({
        sourceFiles: files,
        pageMaxSegments: 1,
        pageMaxSourceChars: 1,
        workerCount: 8,
        callText: async (_prompt, options) => {
          const segmentId = corpus.segments[options.hints.pageIndex].id;
          if (options.task === 'career-profile-compile') {
            const role = {
              id: `role-${options.hints.pageIndex}`, title: `Role ${options.hints.pageIndex}`, employer: 'Acme', startDate: 'January 2020', endDate: 'Present', location: 'Toronto',
              achievementIds: [], skillIds: [], evidenceSegmentIds: [segmentId],
            };
            return {
              ...emptyPageShard(segmentId), roles: [role],
              segmentCoverage: [{ segmentId, disposition: 'role-header', entityIds: ['identity', role.id] }],
            };
          }
          if (options.task.startsWith('career-profile-audit-')) {
            activeAudits += 1;
            maxActiveAudits = Math.max(maxActiveAudits, activeAudits);
            await new Promise(resolve => setTimeout(resolve, 1));
            activeAudits -= 1;
            return { findings: [] };
          }
          throw new Error(`Unexpected task ${options.task}`);
        },
      });
      assert(CAREER_PROFILE_COMPILE_SCHEMA.properties.roles.maxItems === undefined
        && result.profile.roles.length === roleCount && result.profile.segmentCoverage.length === roleCount
        && maxActiveAudits > 1 && validateCurrentCareerSnapshot(result.snapshot).valid,
      'the merged host schema must not retain the former 100-role response cap while each one-role page remains within the capped per-call schema and all page audits finish cleanly');
      return { roleCount, pageRoleCap: priorResponseRoleCap, maxActiveAudits };
    },
  },
  {
    name: 'career snapshot: page fragments patch host entities and active roles survive arbitrary intervening pages',
    run: async () => {
      const files = pagedSourceFiles([
        'Ada Senior Engineer',
        'Acme January 2020 Present Toronto',
        'Unrelated context one',
        'Unrelated context two',
        'Built Python service used by 50 users.',
        'Atlas',
        'Portal Python',
      ]);
      const corpus = buildCareerSourceCorpus(files);
      const shard = (pageIndex) => {
        const segmentId = corpus.segments[pageIndex].id;
        const base = {
          identity: { name: pageIndex === 0 ? 'Ada' : '', contacts: [], evidenceSegmentIds: [segmentId] },
          roles: [], achievements: [], projects: [], skills: [], education: [], certifications: [], otherEvidence: [],
          rolePatches: [], projectPatches: [],
          continuationState: { roles: { mode: 'inherit', ids: [] }, projects: { mode: 'inherit', ids: [] } },
          segmentCoverage: [{ segmentId, disposition: 'context', entityIds: ['identity'] }],
        };
        if (pageIndex === 0) {
          base.roles = [{ id: 'role-acme', title: 'Senior Engineer', employer: '', startDate: '', endDate: '', location: '', achievementIds: [], skillIds: [], evidenceSegmentIds: [segmentId] }];
          base.continuationState.roles = { mode: 'replace', ids: ['role-acme'] };
          base.segmentCoverage[0] = { segmentId, disposition: 'role-header', entityIds: ['identity', 'role-acme'] };
        }
        if (pageIndex === 1) {
          base.rolePatches = [{ targetId: 'p0001-role-acme', evidenceSegmentIds: [segmentId], updates: { employer: 'Acme', startDate: 'January 2020', endDate: 'Present', location: 'Toronto' } }];
          base.segmentCoverage[0] = { segmentId, disposition: 'role-header', entityIds: ['identity', 'p0001-role-acme'] };
        }
        if (pageIndex === 4) {
          base.achievements = [{ id: 'achievement-service', roleId: 'p0001-role-acme', claim: 'Built Python service used by 50 users.', technologies: ['Python'], metrics: [{ label: 'users', value: '50', unit: 'users', evidenceSegmentIds: [segmentId] }], evidenceSegmentIds: [segmentId] }];
          base.skills = [{ id: 'skill-python', name: 'Python', category: 'language', indexEligible: true, roleIds: ['p0001-role-acme'], evidenceSegmentIds: [segmentId] }];
          base.segmentCoverage[0] = { segmentId, disposition: 'achievement', entityIds: ['identity', 'achievement-service', 'skill-python'] };
        }
        if (pageIndex === 5) {
          base.projects = [{ id: 'project-atlas', name: 'Atlas', description: '', roleId: 'p0001-role-acme', technologies: [], metrics: [], evidenceSegmentIds: [segmentId] }];
          base.continuationState.projects = { mode: 'replace', ids: ['project-atlas'] };
          base.segmentCoverage[0] = { segmentId, disposition: 'project', entityIds: ['identity', 'project-atlas'] };
        }
        if (pageIndex === 6) {
          base.projectPatches = [{ targetId: 'p0006-project-atlas', evidenceSegmentIds: [segmentId], updates: { description: 'Portal', technologies: ['Python'] } }];
          base.segmentCoverage[0] = { segmentId, disposition: 'project', entityIds: ['identity', 'p0006-project-atlas'] };
        }
        return pageTransport(base);
      };
      let distantRoleContext = false;
      const result = await compileAuditedCareerSnapshot({
        sourceFiles: files, pageMaxSegments: 1, pageMaxSourceChars: 1,
        callText: async (prompt, options) => {
          if (options.task === 'career-profile-compile') {
            if (options.hints.pageIndex === 4) distantRoleContext = prompt.includes('p0001-role-acme');
            return shard(options.hints.pageIndex);
          }
          return { findings: [] };
        },
      });
      const [role] = result.profile.roles;
      const [project] = result.profile.projects;
      assert(distantRoleContext && role.employer === 'Acme' && role.location === 'Toronto'
        && result.profile.achievements[0].roleId === role.id && role.achievementIds.includes(result.profile.achievements[0].id)
        && project.description === 'Portal' && project.technologies.includes('Python') && project.roleId === role.id
        && result.profile.segmentCoverage.length === corpus.segments.length && validateCareerProfile(result.profile, corpus).valid,
      'role/project fragments must be host-owned patches with page-local evidence, and an explicitly inherited role must remain available after two unrelated pages without re-sending a global profile');
      return { pages: corpus.segments.length, roleId: role.id, projectId: project.id };
    },
  },
  {
    name: 'career snapshot: paged repair is scoped, abort stops later pages, and a repeated bounded state remains nonconvergent',
    run: async () => {
      const files = pagedSourceFiles([
        'Ada Lovelace',
        'Software Engineer Engineer Acme January 2020 Present Toronto',
        'Built Python service used by 50 users.',
        'Built Python report used by 60 users.',
      ]);
      const corpus = buildCareerSourceCorpus(files);
      let repairPages = [];
      let auditRound = 0;
      const repaired = await compileAuditedCareerSnapshot({
        sourceFiles: files, pageMaxSegments: 1, pageMaxSourceChars: 1,
        callText: async (_prompt, options) => {
          if (options.task === 'career-profile-compile') return crossPageShard(corpus, options.hints.pageIndex);
          if (options.task === 'career-profile-repair') {
            repairPages.push(options.hints.pageIndex);
            return crossPageShard(corpus, options.hints.pageIndex, { changedRole: options.hints.pageIndex === 1 });
          }
          if (options.task === 'career-profile-audit-completeness' && options.hints.pageIndex === 1 && auditRound++ === 0) {
            return { findings: [{ id: 'page-two-role', severity: 'warning', category: 'coverage', segmentIds: [corpus.segments[1].id], entityIds: ['p0002-role-acme'], detail: 'Repair this page role label.' }] };
          }
          return { findings: [] };
        },
      });
      const controller = new AbortController();
      let compileCalls = 0;
      let aborted = null;
      try {
        await compileAuditedCareerSnapshot({
          sourceFiles: files, signal: controller.signal, pageMaxSegments: 1, pageMaxSourceChars: 1,
          callText: async (_prompt, options) => {
            compileCalls += 1;
            controller.abort(new Error('test cancellation'));
            return crossPageShard(corpus, options.hints.pageIndex);
          },
        });
      } catch (error) { aborted = error; }
      let nonconvergent = null;
      let repeatedRepairs = 0;
      try {
        await compileAuditedCareerSnapshot({
          sourceFiles: files, pageMaxSegments: 1, pageMaxSourceChars: 1,
          callText: async (_prompt, options) => {
            if (options.task === 'career-profile-compile') return crossPageShard(corpus, options.hints.pageIndex);
            if (options.task === 'career-profile-repair') { repeatedRepairs += 1; return crossPageShard(corpus, options.hints.pageIndex); }
            if (options.task === 'career-profile-audit-completeness' && options.hints.pageIndex === 1) {
              return { findings: [{ id: 'repeat-page-two', severity: 'warning', category: 'coverage', segmentIds: [corpus.segments[1].id], entityIds: ['p0002-role-acme'], detail: 'This deliberately repeats.' }] };
            }
            return { findings: [] };
          },
        });
      } catch (error) { nonconvergent = error; }
      let largeFindingCount = 0;
      let largeFindingRepairs = 0;
      let largeFindings = null;
      try {
        await compileAuditedCareerSnapshot({
          sourceFiles: files, pageMaxSegments: 1, pageMaxSourceChars: 1,
          callText: async (_prompt, options) => {
            if (options.task === 'career-profile-compile') return crossPageShard(corpus, options.hints.pageIndex);
            if (options.task === 'career-profile-repair') { largeFindingRepairs += 1; return crossPageShard(corpus, options.hints.pageIndex); }
            if (options.task === 'career-profile-audit-completeness') {
              const findings = Array.from({ length: 200 }, (_value, index) => ({
                id: `page-${options.hints.pageIndex}-finding-${index}`, severity: 'warning', category: 'coverage',
                segmentIds: [corpus.segments[options.hints.pageIndex].id], entityIds: ['identity'], detail: `Bounded finding ${index}.`,
              }));
              largeFindingCount += findings.length;
              return { findings };
            }
            return { findings: [] };
          },
        });
      } catch (error) { largeFindings = error; }
      assert(repaired.snapshot.status === 'approved' && repairPages.join(',') === '1'
        && aborted?.message === 'test cancellation' && compileCalls === 1
        && nonconvergent?.code === 'CAREER_SNAPSHOT_PAGE_INVALID' && repeatedRepairs === 1
        && largeFindingCount >= 1 && largeFindingRepairs >= 1 && largeFindings?.code === 'CAREER_SNAPSHOT_PAGE_INVALID',
      'a finding scoped to one page must replace only that page, cancellation must prevent later page calls, and a transport that skips the response validator must still fail closed on its first unchanged replacement');
      return { repairPages, abortCompileCalls: compileCalls, repeatedRepairs, largeFindingCount };
    },
  },
  {
    name: 'career snapshot: compiler stops precise no-op and repeated unresolved convergence states',
    run: async () => {
      const corpus = buildCareerSourceCorpus(sourceFiles());
      const good = validProfile(corpus);
      const coverageFinding = (id, detail) => ({
        id, severity: 'warning', category: 'coverage', segmentIds: [corpus.segments[0].id], entityIds: ['identity'], detail,
      });
      let noOp = null;
      try {
        await compileAuditedCareerSnapshot({
          sourceFiles: sourceFiles(),
          callText: async (_prompt, options) => {
            if (options.task === 'career-profile-compile' || options.task === 'career-profile-repair') return pageTransport(good);
            return options.task === 'career-profile-audit-completeness' ? { findings: [coverageFinding('same-profile', 'Repair this coverage concern.')] } : { findings: [] };
          },
        });
      } catch (error) { noOp = error; }
      let repeated = null;
      let repairCalls = 0;
      let coverageCalls = 0;
      const reordered = structuredClone(good);
      reordered.identity.evidenceSegmentIds.reverse();
      try {
        await compileAuditedCareerSnapshot({
          sourceFiles: sourceFiles(),
          callText: async (_prompt, options) => {
            if (options.task === 'career-profile-compile') return pageTransport(good);
            if (options.task === 'career-profile-repair') return pageTransport(repairCalls++ === 0 ? reordered : good);
            if (options.task === 'career-profile-audit-completeness') {
              coverageCalls += 1;
              const findings = [coverageFinding('first', 'Repair concern one.'), coverageFinding('second', 'Repair concern two.')];
              return { findings: coverageCalls % 2 ? findings : findings.reverse() };
            }
            return { findings: [] };
          },
        });
      } catch (error) { repeated = error; }
      assert(noOp?.code === 'CAREER_SNAPSHOT_PAGE_INVALID' && noOp?.validationDiagnostic?.reason === 'CAREER_PAGE_REPAIR_NO_PROGRESS'
        && repeated?.code === 'CAREER_SNAPSHOT_PAGE_INVALID' && repeated?.validationDiagnostic?.reason === 'CAREER_PAGE_REPAIR_NO_PROGRESS'
        && repairCalls === 1 && coverageCalls === 2,
      `a non-clean no-op and an order-only replacement must both fail before a transport that bypasses responseValidator can assemble them (no-op=${noOp?.message || 'none'}; repeat=${repeated?.message || 'none'}; repairCalls=${repairCalls}; coverageCalls=${coverageCalls})`);
      return { noOpRejected: true, repeatedRejected: true, repairCalls, coverageCalls };
    },
  },
  {
    name: 'career snapshot: stale no-op repair is rejected in the same handoff and a corrected retry can recover',
    run: async () => {
      const corpus = buildCareerSourceCorpus(sourceFiles());
      const prior = validProfile(corpus);
      const corrected = structuredClone(prior);
      corrected.skills[0].indexEligible = false;
      const finding = {
        id: 'repair-must-change-canonical-profile', severity: 'warning', category: 'coverage',
        // This finding has only a source target. Changing the cited skill is
        // still a relevant repair because its evidence links it to this
        // segment; the coverage disposition itself need not change.
        segmentIds: [corpus.segments[0].id], entityIds: [],
        detail: 'Correct the skill inventory disposition.',
      };
      let audits = 0;
      let noProgressRejection = null;
      let noProgressRejections = 0;
      let repairPrompt = '';
      const result = await compileAuditedCareerSnapshot({
        sourceFiles: sourceFiles(),
        callText: async (prompt, options) => {
          if (options.task === 'career-profile-compile') return pageTransport(prior);
          if (options.task === 'career-profile-audit-completeness') {
            return audits++ === 0 ? { findings: [finding] } : { findings: [] };
          }
          if (options.task?.startsWith('career-profile-audit-')) return { findings: [] };
          if (options.task === 'career-profile-repair') {
            repairPrompt = prompt;
            // This models a stale accepted no-op reaching the new response
            // validator during recovery. The validator rejects it before a
            // durable acceptance; the same open handoff can then submit the
            // complete corrected replacement.
            for (let attempt = 0; attempt < 4; attempt += 1) {
              try { options.responseValidator(pageTransport(prior)); } catch (error) {
                noProgressRejection = error;
                noProgressRejections += 1;
              }
            }
            assert(noProgressRejection?.code === 'CAREER_SNAPSHOT_PAGE_INVALID'
              && noProgressRejection?.validationDiagnostic?.reason === 'CAREER_PAGE_REPAIR_NO_PROGRESS'
              && noProgressRejections === 4
              && /canonical career profile unchanged/.test(noProgressRejection.message),
            'a schema-valid no-op repair must remain actionable same-handoff correction work without an arbitrary retry cap before it is accepted');
            options.responseValidator(pageTransport(corrected));
            return pageTransport(corrected);
          }
          throw new Error(`Unexpected task ${options.task}`);
        },
      });
      // Durable handoff keys derive from the materialized prompt. A prior
      // repair-revision prompt cannot select the current response, so an old
      // accepted no-op is revalidated/reissued rather than silently replayed.
      const stalePrompt = repairPrompt.replace('Repair protocol revision 2.', 'Repair protocol revision 1.');
      const staleAcceptedByPrompt = new Map([[stalePrompt, pageTransport(prior)]]);
      assert(result.snapshot.status === 'approved' && result.profile.skills[0].indexEligible === false
        && repairPrompt.includes('Repair protocol revision 2.')
        && !staleAcceptedByPrompt.has(repairPrompt)
        && buildCareerProfilePageRepairPrompt(corpus, partitionCareerSourcePages(corpus)[0], pageTransport(prior), [finding]).includes('Repair protocol revision 2.'),
      'the current repair revision must reject a stale canonical no-op before acceptance, recover through the same handoff with a substantive page change, and use a distinct durable prompt identity');
      return { noOpRejectedBeforeAcceptance: true, recovered: true };
    },
  },
  {
    name: 'career snapshot: a repair cannot satisfy a cited finding with unrelated profile churn',
    run: async () => {
      const corpus = buildCareerSourceCorpus(sourceFiles());
      const prior = validProfile(corpus);
      const unrelated = structuredClone(prior);
      unrelated.skills[0].indexEligible = false;
      const targeted = structuredClone(prior);
      targeted.roles[0].title = 'Engineer';
      const finding = {
        id: 'role-title-target', severity: 'warning', category: 'coverage',
        segmentIds: [], entityIds: ['p0001-role-acme'], detail: 'Correct this role title.',
      };
      let audits = 0;
      let unrelatedRejection = null;
      const result = await compileAuditedCareerSnapshot({
        sourceFiles: sourceFiles(),
        callText: async (_prompt, options) => {
          if (options.task === 'career-profile-compile') return pageTransport(prior);
          if (options.task === 'career-profile-audit-completeness') return audits++ < 2 ? { findings: [finding] } : { findings: [] };
          if (options.task?.startsWith('career-profile-audit-')) return { findings: [] };
          if (options.task === 'career-profile-repair') {
            try { options.responseValidator(pageTransport(unrelated)); } catch (error) { unrelatedRejection = error; }
            assert(unrelatedRejection?.code === 'CAREER_SNAPSHOT_PAGE_INVALID'
              && unrelatedRejection?.validationDiagnostic?.reason === 'CAREER_PAGE_REPAIR_TARGET_MISSED',
            'a repair that changes only an uncited entity must be rejected before the handoff accepts it');
            options.responseValidator(pageTransport(targeted));
            return pageTransport(targeted);
          }
          throw new Error(`Unexpected task ${options.task}`);
        },
      });
      assert(result.snapshot.status === 'approved' && result.profile.roles[0].title === 'Engineer',
        'a source-supported change to the entity named by the finding must remain repairable after unrelated churn is rejected');
      return { unrelatedEditRejected: true, targetedRepairAccepted: true };
    },
  },
  {
    name: 'career snapshot: malformed audit responses remain closed-schema rejected',
    run: async () => {
      const corpus = buildCareerSourceCorpus(sourceFiles());
      const profile = validProfile(corpus);
      let rejection = null;
      try {
        await compileAuditedCareerSnapshot({
          sourceFiles: sourceFiles(),
          callText: async (_prompt, options) => {
            if (options.task === 'career-profile-compile') return pageTransport(profile);
            if (options.task === 'career-profile-audit-completeness') {
              return {
                findings: [{
                  id: 'bad-audit-finding', severity: 'warning', category: 'coverage',
                  segmentIds: [], entityIds: [], detail: 'This must not be accepted by the completeness audit.',
                  unexpected: true,
                }],
              };
            }
            return { findings: [] };
          },
        });
      } catch (error) {
        rejection = error;
      }
      assert(rejection?.code === 'CAREER_SNAPSHOT_AUDIT_INVALID'
        && /audit schema .*unexpected.*not an allowed property/i.test(rejection.message)
        && !/returned a finding assigned/i.test(rejection.message),
      `an audit response cannot bypass its closed schema even when its lane metadata otherwise looks valid; got ${rejection?.code || 'no-code'}: ${rejection?.message || 'no error'}`);
      return { malformedAuditRejected: true };
    },
  },
  {
    name: 'career snapshot: cross-category audit observations are host-canonicalized, repaired, and validated before acceptance',
    run: async () => {
      const corpus = buildCareerSourceCorpus(sourceFiles());
      const initial = validProfile(corpus);
      const repaired = structuredClone(initial);
      repaired.skills[0].indexEligible = false;
      let repairCalls = 0;
      let acceptedCrossCategory = false;
      let outOfPageRejectedInValidator = false;
      const result = await compileAuditedCareerSnapshot({
        sourceFiles: sourceFiles(),
        callText: async (prompt, options) => {
          if (options.task === 'career-profile-compile') return pageTransport(initial);
          if (options.task === 'career-profile-repair') {
            repairCalls += 1;
            assert(prompt.includes('"category":"grounding"') && prompt.includes('"audit":"grounding"'),
              'a valid cross-category observation must enter the bounded repair prompt under its host-attested lane');
            return pageTransport(repaired);
          }
          if (options.task === 'career-profile-audit-grounding') {
            if (!acceptedCrossCategory) {
              acceptedCrossCategory = true;
              const crossCategory = {
                findings: [{
                  id: 'cross-cutting-attribution-observation', severity: 'warning', category: 'attribution',
                  segmentIds: [corpus.segments[1].id], entityIds: ['p0001-skill-python'],
                  detail: 'The skill inventory needs a grounded review before approval.',
                }],
              };
              // Simulate the durable handoff acceptance boundary. The
              // validator must accept the legitimate cross-lane observation
              // after host canonicalization, rather than letting it abort the
              // outer compiler later.
              options.responseValidator(crossCategory);
              return crossCategory;
            }
            return { findings: [] };
          }
          if (options.task === 'career-profile-audit-coverage' || options.task === 'career-profile-audit-completeness') return { findings: [] };
          return { findings: [] };
        },
      });
      // Independently prove the same acceptance hook rejects a bounded-page
      // citation before a response can be committed. The compilation fixture
      // has one page, so any syntactically plausible unknown segment is also
      // outside the allowed set.
      let rejection = null;
      try {
        await compileAuditedCareerSnapshot({
          sourceFiles: sourceFiles(),
          callText: async (_prompt, options) => {
            if (options.task === 'career-profile-compile') return pageTransport(initial);
            if (options.task === 'career-profile-audit-grounding') {
              const invalid = { findings: [{
                id: 'outside-page', severity: 'warning', category: 'grounding',
                segmentIds: ['segment-9999'], entityIds: ['p0001-role-acme'], detail: 'This citation is not owned by this page.',
              }] };
              try { options.responseValidator(invalid); } catch (error) { outOfPageRejectedInValidator = error?.code === 'CAREER_SNAPSHOT_AUDIT_INVALID'; throw error; }
              return invalid;
            }
            return { findings: [] };
          },
        });
      } catch (error) { rejection = error; }
      assert(result.snapshot.status === 'approved' && validateCurrentCareerSnapshot(result.snapshot).valid
        && repairCalls === 1 && acceptedCrossCategory
        && result.snapshot.auditHistory[0].kind === 'folded'
        && outOfPageRejectedInValidator && rejection?.code === 'CAREER_SNAPSHOT_AUDIT_INVALID'
        && /unknown segment segment-9999/i.test(rejection.message),
      `cross-category observation must be canonicalized into its host lane and repaired, while out-of-page citations are rejected inside response acceptance (repairCalls=${repairCalls}; accepted=${acceptedCrossCategory}; validatorRejected=${outOfPageRejectedInValidator}; rejection=${rejection?.message || 'none'})`);
      return { repairedCrossCategory: true, validatorRejectedOutOfPageCitation: true };
    },
  },
  {
    name: 'career snapshot: current receipts are compact, page-complete, and cannot be stripped or tampered',
    run: async () => {
      const corpus = buildCareerSourceCorpus(sourceFiles());
      const profile = validProfile(corpus);
      const snapshot = currentSnapshot(corpus, profile);
      const strippedProgress = structuredClone(snapshot);
      delete strippedProgress.auditHistory[0].profileDigest;
      const strippedPage = structuredClone(snapshot);
      delete strippedPage.auditHistory[0].audits[0].pageAudits;
      const tamperedChain = structuredClone(snapshot);
      tamperedChain.auditHistory[0].audits[0].pageAudits[0].chainDigest = '0'.repeat(64);
      const missingReconciliation = structuredClone(snapshot);
      delete missingReconciliation.reconciliation;
      assert(validateCurrentCareerSnapshot(snapshot).valid
        && !validateCurrentCareerSnapshot(strippedProgress).valid
        && !validateCurrentCareerSnapshot(strippedPage).valid
        && !validateCurrentCareerSnapshot(tamperedChain).valid
        && !validateCurrentCareerSnapshot(missingReconciliation).valid,
      'a current contract must require chained per-page/category audit receipts, all convergence digests, and semantic reconciliation receipts; only the explicit historical reader accepts old shapes');
      return { pages: snapshot.pagePlan.pageCount, categories: snapshot.auditHistory[0].audits.length };
    },
  },
  {
    name: 'career snapshot: current v3 attachment receipts bind inventory, page parts, boundaries, coverage, and every aggregate',
    run: async () => {
      const hash = marker => marker.repeat(64);
      const compact = (marker, revisionCount = 0, findingCount = 0) => ({
        decision: 'pass', roundCount: revisionCount + 1, revisionCount, findingCount,
        findingHistoryDigest: hash(marker), stateHistoryDigest: hash(marker), samples: [hash(marker)],
      });
      const page = ({ pageId, pageIndex, regionId, regionIndex, partIndex, partCount, marker, revisionCount = 0, findingCount = 0 }) => ({
        receiptVersion: 3, pageId, pageIndex, textDigest: hash(marker),
        roundCount: revisionCount + 1, revisionCount, findingCount,
        findingHistoryDigest: hash(marker), stateHistoryDigest: hash(marker),
        findingDigestSample: [hash(marker)], stateDigestSample: [hash(marker)],
        regionId, regionIndex, partIndex, partCount,
      });
      const boundary = (index, leftPageId, rightPageId, marker, revisionCount = 0, findingCount = 0) => ({
        index, leftPageId, rightPageId, roundCount: revisionCount + 1, revisionCount, findingCount,
        findingHistoryDigest: hash(marker), stateHistoryDigest: hash(marker),
        findingDigestSample: [hash(marker)], stateDigestSample: [hash(marker)],
      });
      const makeReceipt = ({ kind = 'ai-container' } = {}) => {
        const regions = [{ id: 'region-a', index: 0 }, { id: 'region-b', index: 1 }];
        const inventoryAudit = kind === 'ai-container' ? compact('a') : null;
        const pages = [
          page({ pageId: careerAttachmentRegionPartPageId('region-a', 0), pageIndex: 0, regionId: 'region-a', regionIndex: 0, partIndex: 0, partCount: 2, marker: 'b', revisionCount: 1, findingCount: 3 }),
          page({ pageId: careerAttachmentRegionPartPageId('region-a', 1), pageIndex: 1, regionId: 'region-a', regionIndex: 0, partIndex: 1, partCount: 2, marker: 'c' }),
          page({ pageId: careerAttachmentRegionPartPageId('region-b', 0), pageIndex: 2, regionId: 'region-b', regionIndex: 1, partIndex: 0, partCount: 1, marker: 'd', findingCount: 2 }),
        ];
        const boundaries = [
          boundary(0, pages[0].pageId, pages[1].pageId, 'e', 1, 1),
          boundary(1, pages[1].pageId, pages[2].pageId, 'f'),
        ];
        const coverage = {
          ...compact('a'), expectedRegionCount: regions.length, coveredRegionCount: regions.length,
          coveredRegionDigest: stableCareerJsonDigest(regions),
        };
        const audited = [...pages, ...(inventoryAudit ? [inventoryAudit] : []), ...boundaries, coverage];
        return {
          receiptVersion: 3, mode: 'attachment', decision: 'pass', mergeMode: 'exact-concatenation-v1', documentId: 'document-1',
          policyDigest: CAREER_TRANSCRIPTION_POLICY_DIGEST,
          inventory: { version: 1, kind, regionCount: regions.length, regions, digest: stableCareerJsonDigest(regions), audit: inventoryAudit },
          pageCount: pages.length,
          roundCount: audited.reduce((sum, entry) => sum + entry.roundCount, 0),
          revisionCount: audited.reduce((sum, entry) => sum + entry.revisionCount, 0),
          findingCount: audited.reduce((sum, entry) => sum + entry.findingCount, 0),
          pageAuditDigest: stableCareerJsonDigest(pages), pages,
          boundaryCount: boundaries.length, boundaryAuditDigest: stableCareerJsonDigest(boundaries), boundaries, coverage,
        };
      };
      const receipt = makeReceipt();
      const v2Pages = [{
        receiptVersion: 2, pageId: 'legacy-page', pageIndex: 0, textDigest: hash('a'),
        roundCount: 1, revisionCount: 0, findingCount: 0,
        findingHistoryDigest: hash('b'), stateHistoryDigest: hash('c'), findingDigestSample: [], stateDigestSample: [],
      }];
      const v2Receipt = {
        receiptVersion: 2, mode: 'attachment', decision: 'pass', mergeMode: 'exact-concatenation-v1', documentId: 'legacy-document',
        pageCount: 1, roundCount: 1, revisionCount: 0, findingCount: 0,
        pageAuditDigest: digest(JSON.stringify(v2Pages)), policyDigest: hash('d'), pages: v2Pages,
      };
      const mutations = [
        value => { value.receiptVersion = 2; }, value => { value.mode = 'verbatim'; }, value => { value.decision = 'revised'; },
        value => { value.mergeMode = 'patched'; }, value => { value.documentId = 'bad id!'; }, value => { value.policyDigest = hash('0'); },
        value => { value.inventory = null; }, value => { value.pageCount = 4; }, value => { value.roundCount += 1; },
        value => { value.revisionCount += 1; }, value => { value.findingCount += 1; }, value => { value.pageAuditDigest = hash('0'); },
        value => { value.pages = []; }, value => { value.boundaryCount = 0; }, value => { value.boundaryAuditDigest = hash('0'); },
        value => { value.boundaries = []; }, value => { value.coverage = null; }, value => { value.extra = true; },
        value => { value.inventory.version = 2; }, value => { value.inventory.kind = 'unknown'; }, value => { value.inventory.regionCount = 3; },
        value => { value.inventory.regions[0].id = 'bad id!'; }, value => { value.inventory.regions[0].index = 1; },
        value => { value.inventory.digest = hash('0'); }, value => { value.inventory.audit = null; }, value => { value.inventory.extra = true; },
        value => { value.inventory.audit.decision = 'issue'; }, value => { value.inventory.audit.roundCount = 0; },
        value => { value.inventory.audit.revisionCount = 1; }, value => { value.inventory.audit.findingCount = -1; },
        value => { value.inventory.audit.findingHistoryDigest = 'not-a-digest'; }, value => { value.inventory.audit.stateHistoryDigest = 'not-a-digest'; },
        value => { value.inventory.audit.samples = Array.from({ length: 9 }, () => hash('a')); }, value => { value.inventory.audit.extra = true; },
        value => { value.pages[0].receiptVersion = 2; }, value => { value.pages[0].pageId = value.pages[1].pageId; },
        value => { value.pages[0].pageIndex = 1; }, value => { value.pages[0].textDigest = 'not-a-digest'; },
        value => { value.pages[0].roundCount = 0; }, value => { value.pages[0].revisionCount = 0; }, value => { value.pages[0].findingCount = -1; },
        value => { value.pages[0].findingHistoryDigest = 'not-a-digest'; }, value => { value.pages[0].stateHistoryDigest = 'not-a-digest'; },
        value => { value.pages[0].findingDigestSample = Array.from({ length: 9 }, () => hash('a')); }, value => { value.pages[0].stateDigestSample = ['not-a-digest']; },
        value => { value.pages[0].regionId = 'region-b'; }, value => { value.pages[0].regionIndex = 1; },
        value => { value.pages[0].partIndex = 1; }, value => { value.pages[0].partCount = 1; }, value => { value.pages[0].extra = true; },
        value => { value.boundaries[0].index = 1; }, value => { value.boundaries[0].leftPageId = 'forged-page'; },
        value => { value.boundaries[0].rightPageId = 'forged-page'; }, value => { value.boundaries[0].roundCount = 0; },
        value => { value.boundaries[0].revisionCount = 0; }, value => { value.boundaries[0].findingCount = -1; },
        value => { value.boundaries[0].findingHistoryDigest = 'not-a-digest'; }, value => { value.boundaries[0].stateHistoryDigest = 'not-a-digest'; },
        value => { value.boundaries[0].findingDigestSample = Array.from({ length: 9 }, () => hash('a')); }, value => { value.boundaries[0].stateDigestSample = ['not-a-digest']; },
        value => { value.boundaries[0].extra = true; }, value => { value.coverage.decision = 'issue'; },
        value => { value.coverage.expectedRegionCount = 3; }, value => { value.coverage.coveredRegionCount = 1; }, value => { value.coverage.coveredRegionDigest = hash('0'); },
        value => { value.coverage.roundCount = 0; }, value => { value.coverage.revisionCount = 1; }, value => { value.coverage.findingCount = -1; },
        value => { value.coverage.findingHistoryDigest = 'not-a-digest'; }, value => { value.coverage.stateHistoryDigest = 'not-a-digest'; },
        value => { value.coverage.samples = Array.from({ length: 9 }, () => hash('a')); }, value => { value.coverage.extra = true; },
        value => { delete value.inventory.digest; }, value => { delete value.pages[0].regionId; },
        value => { delete value.boundaries[0].findingHistoryDigest; }, value => { delete value.coverage.samples; },
      ];
      const legacyAttachment = {
        mode: 'attachment', decision: 'pass', roundCount: 1, revisionCount: 0, findingCount: 0,
        findingDigests: ['a'.repeat(64)], findingDigest: digest(canonicalJson(['a'.repeat(64)])), stateDigests: ['b'.repeat(64)], policyDigest: 'c'.repeat(64),
      };
      const pdfReceipt = makeReceipt({ kind: 'pdf' });
      const forgedPdfAudit = structuredClone(pdfReceipt);
      forgedPdfAudit.inventory.audit = compact('a');
      const forgedCurrentPageIds = structuredClone(receipt);
      forgedCurrentPageIds.pages.forEach((page, index) => { page.pageId = `forged-current-part-${index + 1}`; });
      forgedCurrentPageIds.boundaries.forEach((boundary, index) => {
        boundary.leftPageId = forgedCurrentPageIds.pages[index].pageId;
        boundary.rightPageId = forgedCurrentPageIds.pages[index + 1].pageId;
      });
      forgedCurrentPageIds.pageAuditDigest = stableCareerJsonDigest(forgedCurrentPageIds.pages);
      forgedCurrentPageIds.boundaryAuditDigest = stableCareerJsonDigest(forgedCurrentPageIds.boundaries);
      const historicalV3Receipt = makeReceipt();
      historicalV3Receipt.policyDigest = hash('e');
      // Host-derived page IDs are mandatory for current-policy receipts. A
      // pre-v3-policy persisted snapshot remains readable on its explicit
      // historical branch, including its older responder-local page IDs.
      const looseHistoricalV3Receipt = structuredClone(historicalV3Receipt);
      looseHistoricalV3Receipt.pages.forEach((page, index) => { page.pageId = `historical-part-${index + 1}`; });
      looseHistoricalV3Receipt.boundaries.forEach((boundary, index) => {
        boundary.leftPageId = looseHistoricalV3Receipt.pages[index].pageId;
        boundary.rightPageId = looseHistoricalV3Receipt.pages[index + 1].pageId;
      });
      looseHistoricalV3Receipt.pageAuditDigest = stableCareerJsonDigest(looseHistoricalV3Receipt.pages);
      looseHistoricalV3Receipt.boundaryAuditDigest = stableCareerJsonDigest(looseHistoricalV3Receipt.boundaries);
      const preCanonicalHistoricalV3 = makeReceipt();
      preCanonicalHistoricalV3.policyDigest = hash('f');
      preCanonicalHistoricalV3.pageAuditDigest = digest(JSON.stringify(preCanonicalHistoricalV3.pages));
      preCanonicalHistoricalV3.boundaryAuditDigest = digest(JSON.stringify(preCanonicalHistoricalV3.boundaries));
      const canonicalizedHistoricalV3 = JSON.parse(canonicalJson(preCanonicalHistoricalV3));
      let persisted = null;
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-v3-stable-receipt-'));
      try {
        const attachmentSources = sourceFiles().map(source => ({ ...source, transcriptionAudit: receipt }));
        const attachmentCorpus = buildCareerSourceCorpus(attachmentSources);
        const attachmentSnapshot = currentSnapshot(attachmentCorpus, validProfile(attachmentCorpus));
        await writeCareerSnapshotAtomically(root, attachmentSnapshot);
        persisted = await readCareerSnapshot(root, attachmentSnapshot.snapshotId);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
      assert(validateCareerTranscriptionAuditReceipt(receipt)
        && validateCareerTranscriptionAuditReceipt(pdfReceipt)
        && mutations.every(mutate => {
          const bad = structuredClone(receipt);
          mutate(bad);
          return !validateCareerTranscriptionAuditReceipt(bad);
        })
        && !validateCareerTranscriptionAuditReceipt(forgedPdfAudit)
        && !validateCareerTranscriptionAuditReceipt(forgedCurrentPageIds)
        && !validateCareerTranscriptionAuditReceipt(v2Receipt)
        && validateCareerTranscriptionAuditReceipt(v2Receipt, { requireCurrentPolicy: false })
        && !validateCareerTranscriptionAuditReceipt(historicalV3Receipt)
        && validateCareerTranscriptionAuditReceipt(historicalV3Receipt, { requireCurrentPolicy: false })
        && !validateCareerTranscriptionAuditReceipt(looseHistoricalV3Receipt)
        && validateCareerTranscriptionAuditReceipt(looseHistoricalV3Receipt, { requireCurrentPolicy: false })
        && !validateCareerTranscriptionAuditReceipt(canonicalizedHistoricalV3)
        && validateCareerTranscriptionAuditReceipt(canonicalizedHistoricalV3, { requireCurrentPolicy: false })
        && !validateCareerTranscriptionAuditReceipt(legacyAttachment)
        && validateCareerTranscriptionAuditReceipt(legacyAttachment, { requireCurrentPolicy: false })
        && persisted?.sources?.[0]?.transcriptionAudit?.pageAuditDigest === receipt.pageAuditDigest
        && validateCareerTranscriptionAuditReceipt(persisted.sources[0].transcriptionAudit),
      'current attachment evidence must be an exact v3 inventory/page/boundary/coverage receipt with every aggregate, host-derived part ID, and nested key bound; canonical receipt hashes survive persisted snapshot write/read while only the explicit historical reader accepts legacy IDs or v2/direct shapes');
      return { pages: receipt.pageCount, rejectedMutations: mutations.length, persistedRoundTrip: true };
    },
  },
  {
    name: 'career snapshot: repair findings batch under prompt limits and compile prompts expose only local source metadata',
    run: async () => {
      const corpus = buildCareerSourceCorpus(sourceFiles());
      const profile = validProfile(corpus);
      const findings = Array.from({ length: 200 }, (_value, index) => ({
        id: `bounded-${index}`, severity: 'warning', category: 'coverage', segmentIds: [corpus.segments[0].id], entityIds: ['identity'],
        detail: `Repair bounded finding ${index}: ${'evidence '.repeat(50)}`,
      }));
      const repairBatchCounts = [];
      let noProgress = null;
      try {
        await compileAuditedCareerSnapshot({
          sourceFiles: sourceFiles(), maxPromptChars: 15_000,
          callText: async (_prompt, options) => {
            if (options.task === 'career-profile-compile' || options.task === 'career-profile-repair') {
              if (options.task === 'career-profile-repair') repairBatchCounts.push(options.hints.findingBatchCount);
              return pageTransport(profile);
            }
            return options.task === 'career-profile-audit-completeness' ? { findings } : { findings: [] };
          },
        });
      } catch (error) { noProgress = error; }
      const files = Array.from({ length: 5 }, (_value, index) => {
        const text = `Source ${index + 1} context\n`;
        return { name: `source-${index + 1}.txt`, text, transcriptionAudit: verbatimCareerTranscriptionAuditReceipt() };
      });
      const manySources = buildCareerSourceCorpus(files);
      let finalCompilePrompt = '';
      await compileAuditedCareerSnapshot({
        sourceFiles: files, pageMaxSegments: 1, pageMaxSourceChars: 1,
        callText: async (prompt, options) => {
          if (options.task === 'career-profile-compile') {
            if (options.hints.pageIndex === 4) finalCompilePrompt = prompt;
            return emptyPageShard(manySources.segments[options.hints.pageIndex].id);
          }
          return { findings: [] };
        },
      });
      assert(noProgress?.code === 'CAREER_SNAPSHOT_PAGE_INVALID'
        && repairBatchCounts.length >= 1 && repairBatchCounts.every(count => count > 1)
        && finalCompilePrompt.includes('source-0005') && !finalCompilePrompt.includes('source-0001'),
      'a page repair must split an over-sized finding set into bounded batches without a global repair cap, and compile prompts must not carry unrelated source-file metadata');
      return { repairCalls: repairBatchCounts.length, repairBatchCount: repairBatchCounts[0], sourcePages: manySources.segments.length };
    },
  },
  {
    name: 'career snapshot: distant incompatible roles/projects and skill categories are never silently reconciled',
    run: async () => {
      const files = pagedSourceFiles([
        'Engineer Acme January 2020 Present Toronto Atlas First Python',
        'Engineer Acme January 2020 Present Montreal Atlas Second Python',
      ]);
      const corpus = buildCareerSourceCorpus(files);
      const conflictingShard = (pageIndex, skillCategory = 'language') => {
        const segmentId = corpus.segments[pageIndex].id;
        const location = pageIndex === 0 ? 'Toronto' : 'Montreal';
        const description = pageIndex === 0 ? 'First' : 'Second';
        const roleId = `role-${pageIndex}`;
        const projectId = `project-atlas-${pageIndex}`;
        const skillId = `skill-python-${pageIndex}`;
        return pageTransport({
          identity: { name: '', contacts: [], evidenceSegmentIds: [segmentId] },
          roles: [{ id: roleId, title: 'Engineer', employer: 'Acme', startDate: 'January 2020', endDate: 'Present', location, achievementIds: [], skillIds: [skillId], evidenceSegmentIds: [segmentId] }],
          achievements: [], projects: [{ id: projectId, name: 'Atlas', description, roleId, technologies: [], metrics: [], evidenceSegmentIds: [segmentId] }],
          skills: [{ id: skillId, name: 'Python', category: skillCategory, indexEligible: true, roleIds: [roleId], evidenceSegmentIds: [segmentId] }],
          education: [], certifications: [], otherEvidence: [], rolePatches: [], projectPatches: [],
          continuationState: { roles: { mode: 'clear', ids: [] }, projects: { mode: 'clear', ids: [] } },
          segmentCoverage: [{ segmentId, disposition: 'role-header', entityIds: ['identity', roleId, projectId, skillId] }],
        });
      };
      const rejected = [];
      let crossConflict = null;
      try {
        await compileAuditedCareerSnapshot({
          sourceFiles: files, pageMaxSegments: 1, pageMaxSourceChars: 1,
          callText: async (_prompt, options) => {
            if (options.task === 'career-profile-compile') return conflictingShard(options.hints.pageIndex);
            if (options.task === 'career-profile-repair') { rejected.push(options.hints.pageIndex); return conflictingShard(options.hints.pageIndex); }
            return { findings: [] };
          },
        });
      } catch (error) { crossConflict = error; }
      let skillCollision = null;
      try {
        await compileAuditedCareerSnapshot({
          sourceFiles: files, pageMaxSegments: 1, pageMaxSourceChars: 1,
          callText: async (_prompt, options) => {
            if (options.task === 'career-profile-compile' || options.task === 'career-profile-repair') {
              return conflictingShard(options.hints.pageIndex, options.hints.pageIndex === 0 ? 'language' : 'tool');
            }
            return { findings: [] };
          },
        });
      } catch (error) { skillCollision = error; }
      assert(crossConflict?.code === 'CAREER_SNAPSHOT_PAGE_INVALID' && rejected.length >= 1
        && skillCollision?.code === 'CAREER_SNAPSHOT_PAGE_INVALID',
      'host reconciliation must surface distant role/project disagreements to their owning pages and preserve a same-name skill category collision for repair instead of discarding an ID or controlled classification');
      return { crossConflictRejected: true, skillCollisionRejected: true };
    },
  },
  {
    name: 'career snapshot: atomic immutable storage survives concurrent identical publish and rejects collisions',
    run: async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-career-snapshot-'));
      try {
        const corpus = buildCareerSourceCorpus(sourceFiles());
        const profile = validProfile(corpus);
        const snapshot = currentSnapshot(corpus, profile);
        const writes = await Promise.all([writeCareerSnapshotAtomically(root, snapshot), writeCareerSnapshotAtomically(root, snapshot)]);
        const loaded = await readCareerSnapshot(root, snapshot.snapshotId);
        const leaf = path.join(root, 'career-snapshots', `${snapshot.snapshotId}.json`);
        const mode = (await fs.promises.stat(leaf)).mode & 0o777;
        assert(writes.filter(write => write.created).length === 1 && writes.filter(write => !write.created).length === 1
          && loaded?.snapshotId === snapshot.snapshotId && mode === 0o600,
        'same-byte concurrent publishers must atomically converge on one immutable approved snapshot');
        const conflicting = { ...snapshot, approvedAt: '2026-10-08T00:00:00.000Z' };
        let collision = null;
        try { await writeCareerSnapshotAtomically(root, conflicting); } catch (error) { collision = error; }
        assert(collision?.code === 'CAREER_SNAPSHOT_COLLISION' && (await readCareerSnapshot(root, snapshot.snapshotId))?.approvedAt === snapshot.approvedAt,
          'a divergent same-id write must never overwrite the existing approved snapshot');
        return { created: writes.filter(write => write.created).length };
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'career snapshot: read rejects an in-place mutation after descriptor open',
    run: async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-snapshot-read-race-'));
      try {
        const corpus = buildCareerSourceCorpus(sourceFiles());
        const snapshot = currentSnapshot(corpus, validProfile(corpus));
        await writeCareerSnapshotAtomically(root, snapshot);
        let restoredSizeAndMtime = false;
        __setCareerSnapshotReadHookForTests(async ({ filePath, initial }) => {
          const bytes = await fs.promises.readFile(filePath);
          await fs.promises.writeFile(filePath, bytes);
          // Preserve the easy observable fields so the descriptor/path ctime
          // check is what proves an in-place mutation was noticed.
          await fs.promises.utimes(filePath, initial.atimeMs / 1_000, initial.mtimeMs / 1_000);
          const restored = await fs.promises.stat(filePath);
          restoredSizeAndMtime = restored.size === initial.size && restored.mtimeMs === initial.mtimeMs;
        });
        let rejected = null;
        try { await readCareerSnapshot(root, snapshot.snapshotId); } catch (error) { rejected = error; }
        assert(restoredSizeAndMtime && rejected?.code === 'CAREER_SNAPSHOT_READ_INVALID',
          'a same-size/mtime-restored snapshot mutation after open must be rejected by ctime before its bytes reach the approval validator');
        return { postOpenMutationRejected: true, ctimeMutationRejected: true };
      } finally {
        __setCareerSnapshotReadHookForTests(null);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'career snapshot: a stored input fingerprint cannot override the ordered source descriptors',
    run: async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-career-snapshot-'));
      try {
        const corpus = buildCareerSourceCorpus(sourceFiles());
        const snapshotId = careerSnapshotId(corpus);
        const snapshot = currentSnapshot(corpus, validProfile(corpus));
        await writeCareerSnapshotAtomically(root, snapshot);
        const storedPath = path.join(root, 'career-snapshots', `${snapshotId}.json`);
        const tampered = JSON.parse(fs.readFileSync(storedPath, 'utf8'));
        // The descriptors still derive the original fingerprint, but a forged
        // stored override used to be fed back into the id calculation.
        tampered.inputFingerprint = 'b'.repeat(64);
        fs.writeFileSync(storedPath, `${JSON.stringify(tampered)}\n`, 'utf8');
        assert(await readCareerSnapshot(root, snapshotId) === null,
          'a stored input fingerprint that disagrees with ordered source descriptors must invalidate the snapshot');
        return { snapshotId: snapshotId.slice(0, 12) };
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'career snapshot: invalid current approval receipts cannot create an immutable collision artifact',
    run: async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-career-snapshot-'));
      try {
        const corpus = buildCareerSourceCorpus(sourceFiles());
        const snapshot = {
          schemaVersion: CAREER_SNAPSHOT_SCHEMA_VERSION, status: 'approved', snapshotId: careerSnapshotId(corpus), inputFingerprint: corpus.inputFingerprint,
          sourceFingerprint: corpus.sourceFingerprint, compilationContract: (await import('../../electron/ipc/careerSnapshot.js')).CAREER_SNAPSHOT_COMPILATION_CONTRACT,
          approvedAt: '2026-10-07T00:00:00.000Z', sources: corpus.sources, segments: corpus.segments,
          profile: validProfile(corpus), auditHistory: [],
        };
        let rejection = null;
        try { await writeCareerSnapshotAtomically(root, snapshot); } catch (error) { rejection = error; }
        assert(rejection?.code === 'CAREER_SNAPSHOT_INVALID'
          && !fs.existsSync(path.join(root, 'career-snapshots', `${snapshot.snapshotId}.json`))
          && !fs.existsSync(path.join(root, 'career-snapshots')),
        'the public writer must prove a current clean audit/profile/identity before it creates any immutable snapshot path');
        return { invalidWriteRejectedBeforeMutation: true };
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'career snapshot: storage root, leaf, and reads reject symlink traversal',
    run: async () => {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-career-snapshot-'));
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-career-outside-'));
      try {
        const corpus = buildCareerSourceCorpus(sourceFiles());
        const snapshot = currentSnapshot(corpus, validProfile(corpus));
        const symlinkedRoot = path.join(parent, 'storage-link');
        fs.symlinkSync(outside, symlinkedRoot);
        let rootRejection = null;
        try { await writeCareerSnapshotAtomically(symlinkedRoot, snapshot); } catch (error) { rootRejection = error; }
        const root = path.join(parent, 'storage');
        const leafDirectory = path.join(root, 'career-snapshots');
        fs.mkdirSync(leafDirectory, { recursive: true });
        const outsideLeaf = path.join(outside, 'snapshot.json');
        fs.writeFileSync(outsideLeaf, 'outside bytes', 'utf8');
        fs.symlinkSync(outsideLeaf, path.join(leafDirectory, `${snapshot.snapshotId}.json`));
        let leafRejection = null;
        try { await writeCareerSnapshotAtomically(root, snapshot); } catch (error) { leafRejection = error; }
        let readRejection = null;
        try { await readCareerSnapshot(root, snapshot.snapshotId); } catch (error) { readRejection = error; }
        assert(rootRejection?.code === 'CAREER_SNAPSHOT_STORAGE_UNSAFE'
          && leafRejection?.code === 'CAREER_SNAPSHOT_STORAGE_UNSAFE'
          && readRejection?.code === 'CAREER_SNAPSHOT_READ_INVALID'
          && fs.readFileSync(outsideLeaf, 'utf8') === 'outside bytes',
        'every storage read/write must reject a symlinked root or final snapshot leaf without following or changing it');
        return { rootAndLeafSymlinksRejected: true };
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'career snapshot: oversized immutable JSON is rejected before parsing',
    run: async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-career-snapshot-'));
      try {
        const snapshotId = 'a'.repeat(64);
        const storedPath = path.join(root, 'career-snapshots', `${snapshotId}.json`);
        fs.mkdirSync(path.dirname(storedPath), { recursive: true });
        // Sparse truncate keeps this boundary check inexpensive while proving
        // lstat rejects the byte overage before readFile/JSON.parse can run.
        fs.writeFileSync(storedPath, '{}', 'utf8');
        fs.truncateSync(storedPath, CAREER_SNAPSHOT_MAX_FILE_BYTES + 1);
        let rejection = null;
        try { await readPinnedCareerSnapshot(root, snapshotId); } catch (error) { rejection = error; }
        assert(rejection?.code === 'CAREER_SNAPSHOT_READ_INVALID'
          && /compatible intake ceiling/i.test(rejection.message),
        'a snapshot one byte above the documented 64 MiB compatibility ceiling is rejected before JSON parsing');
        return { rejectedBytes: CAREER_SNAPSHOT_MAX_FILE_BYTES + 1 };
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'career snapshot: pinned application reads retain compatible historical contracts without weakening current cache reads',
    run: async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-career-snapshot-'));
      try {
        const corpus = buildCareerSourceCorpus(sourceFiles());
        const historicalContract = 'c'.repeat(64);
        const snapshotId = careerSnapshotIdForContract(corpus, historicalContract);
        const snapshot = {
          schemaVersion: 2, status: 'approved', snapshotId, inputFingerprint: corpus.inputFingerprint,
          sourceFingerprint: corpus.sourceFingerprint, compilationContract: historicalContract,
          approvedAt: '2026-10-07T00:00:00.000Z', sources: corpus.sources, segments: corpus.segments,
          profile: validProfile(corpus), auditHistory: cleanAuditHistory(),
        };
        const storedPath = path.join(root, 'career-snapshots', `${snapshotId}.json`);
        fs.mkdirSync(path.dirname(storedPath), { recursive: true });
        fs.writeFileSync(storedPath, `${JSON.stringify(snapshot)}\n`, 'utf8');
        assert(await readCareerSnapshot(root, snapshotId) === null
          && (await readPinnedCareerSnapshot(root, snapshotId))?.snapshotId === snapshotId,
        'current cache reads reject an old contract while card-pinned application recovery validates and loads the same compatible snapshot');
        fs.writeFileSync(storedPath, `${JSON.stringify({ ...snapshot, auditHistory: [] })}\n`, 'utf8');
        const missingAuditRejected = await readPinnedCareerSnapshot(root, snapshotId) === null;
        const dirtyAudit = structuredClone(snapshot);
        dirtyAudit.auditHistory[0].audits[0].findingCount = 1;
        dirtyAudit.auditHistory[0].unresolvedCount = 1;
        fs.writeFileSync(storedPath, `${JSON.stringify(dirtyAudit)}\n`, 'utf8');
        assert(missingAuditRejected && await readPinnedCareerSnapshot(root, snapshotId) === null,
          'a historical pin with missing or non-clean audit history is not a compatible approved snapshot');
        fs.writeFileSync(storedPath, `${JSON.stringify(snapshot)}\n`, 'utf8');
        const tampered = { ...snapshot, compilationContract: 'd'.repeat(64) };
        fs.writeFileSync(storedPath, `${JSON.stringify(tampered)}\n`, 'utf8');
        assert(await readPinnedCareerSnapshot(root, snapshotId) === null,
          'a historical reader still recomputes the id from the stored contract and rejects tampered contract/id pairs');
        return { historicalPinned: true, auditReceiptRejected: true, tamperRejected: true };
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'career snapshot: pinned historical chunks remain source-exact across the current line-segmentation policy',
    run: async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-career-snapshot-'));
      try {
        const currentCorpus = buildCareerSourceCorpus(sourceFiles());
        const oldSegments = [{
          id: 'segment-0001', sourceId: 'source-0001', startOffset: 0,
          endOffset: currentCorpus.sources[0].text.length, text: currentCorpus.sources[0].text,
        }];
        const oldCorpus = { ...currentCorpus, segments: oldSegments };
        const historicalContract = '1'.repeat(64);
        const snapshotId = careerSnapshotIdForContract(oldCorpus, historicalContract);
        const snapshot = {
          schemaVersion: 2, status: 'approved', snapshotId, inputFingerprint: oldCorpus.inputFingerprint,
          sourceFingerprint: oldCorpus.sourceFingerprint, compilationContract: historicalContract,
          approvedAt: '2026-10-07T00:00:00.000Z', sources: oldCorpus.sources, segments: oldSegments,
          profile: validProfile(oldCorpus), auditHistory: cleanAuditHistory(),
        };
        const storedPath = path.join(root, 'career-snapshots', `${snapshotId}.json`);
        fs.mkdirSync(path.dirname(storedPath), { recursive: true });
        fs.writeFileSync(storedPath, `${JSON.stringify(snapshot)}\n`, 'utf8');
        assert(await readCareerSnapshot(root, snapshotId) === null
          && (await readPinnedCareerSnapshot(root, snapshotId))?.snapshotId === snapshotId,
        'a card pin retains a prior exact 4k-chunk evidence partition even when current imports use line-level segments');
        const tampered = structuredClone(snapshot);
        tampered.segments[0].text = `${tampered.segments[0].text}invented`;
        fs.writeFileSync(storedPath, `${JSON.stringify(tampered)}\n`, 'utf8');
        assert(await readPinnedCareerSnapshot(root, snapshotId) === null,
          'historical compatibility requires an exact source-linked, offset-contiguous, bounded segment partition');
        return { historicalChunksPinned: true, malformedChunksRejected: true };
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'career snapshot: pinned historical partitions may exceed a newer compiler chunk size but remain absolutely bounded',
    run: async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-career-snapshot-'));
      try {
        const source = sourceFiles()[0];
        const corpus = buildCareerSourceCorpus([{ ...source, text: `${source.text}${'x'.repeat(5_000)}` }]);
        const historicalSegments = [{
          id: 'segment-0001', sourceId: 'source-0001', startOffset: 0,
          endOffset: corpus.sources[0].text.length, text: corpus.sources[0].text,
        }];
        const historicalCorpus = { ...corpus, segments: historicalSegments };
        const historicalContract = '2'.repeat(64);
        const snapshotId = careerSnapshotIdForContract(historicalCorpus, historicalContract);
        const snapshot = {
          schemaVersion: 2, status: 'approved', snapshotId, inputFingerprint: historicalCorpus.inputFingerprint,
          sourceFingerprint: historicalCorpus.sourceFingerprint, compilationContract: historicalContract,
          approvedAt: '2026-10-07T00:00:00.000Z', sources: historicalCorpus.sources, segments: historicalSegments,
          profile: validProfile(historicalCorpus), auditHistory: cleanAuditHistory(),
        };
        const storedPath = path.join(root, 'career-snapshots', `${snapshotId}.json`);
        fs.mkdirSync(path.dirname(storedPath), { recursive: true });
        fs.writeFileSync(storedPath, `${JSON.stringify(snapshot)}\n`, 'utf8');
        assert(CAREER_SNAPSHOT_HISTORICAL_MAX_SEGMENTS === 5_000
          && (await readPinnedCareerSnapshot(root, snapshotId))?.snapshotId === snapshotId,
          'a compatible pin must retain an exact source-backed historical segment larger than the current compiler chunk size');
        return { largerHistoricalSegmentPinned: true };
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'career snapshot: duplicate canonical skill names repair under the current contract but remain readable for compatible historical pins',
    run: async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-career-snapshot-'));
      try {
        const corpus = buildCareerSourceCorpus(sourceFiles());
        const profile = validProfile(corpus);
        profile.skills.push({ ...profile.skills[0], id: 'skill-python-old-duplicate', name: 'python' });
        profile.roles[0].skillIds.push('skill-python-old-duplicate');
        profile.segmentCoverage.forEach(entry => entry.entityIds.push('skill-python-old-duplicate'));
        assert(!validateCareerProfile(profile, corpus).valid,
          'new current-contract compilation must reject a duplicate canonical skill name for repair');
        const historicalContract = '3'.repeat(64);
        const snapshotId = careerSnapshotIdForContract(corpus, historicalContract);
        const snapshot = {
          schemaVersion: 2, status: 'approved', snapshotId, inputFingerprint: corpus.inputFingerprint,
          sourceFingerprint: corpus.sourceFingerprint, compilationContract: historicalContract,
          approvedAt: '2026-10-07T00:00:00.000Z', sources: corpus.sources, segments: corpus.segments,
          profile, auditHistory: cleanAuditHistory(),
        };
        const storedPath = path.join(root, 'career-snapshots', `${snapshotId}.json`);
        fs.mkdirSync(path.dirname(storedPath), { recursive: true });
        fs.writeFileSync(storedPath, `${JSON.stringify(snapshot)}\n`, 'utf8');
        assert((await readPinnedCareerSnapshot(root, snapshotId))?.snapshotId === snapshotId,
          'a compatible historical pin must remain readable so its conservative application projection can deduplicate the old keyword inventory');
        return { currentDuplicateRejected: true, historicalDuplicatePinned: true };
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'career snapshot: current active role/project continuations are digest-paged without a total-entity ceiling',
    run: async () => {
      const activeEntityCount = 350;
      const detail = 'x'.repeat(2_000);
      const files = pagedSourceFiles([
        ...Array.from({ length: activeEntityCount }, (_, index) => `Role ${index} Project ${index} ${detail}`),
        // A single source page deliberately names every distinct live role.
        // It must retrieve all matching digest pages once, not re-scan the
        // whole active ledger for every preceding page.
        Array.from({ length: activeEntityCount }, (_, index) => `Role ${index} Project ${index}`).join(' '),
      ]);
      const prompts = [];
      const scanPageDigests = [];
      const scanSourcePageIndexes = [];
      let activeContextPatchCount = 0;
      let liveScans = 0;
      let maxLiveScans = 0;
      const scanPayload = prompt => {
        const start = prompt.indexOf('<UNTRUSTED_CAREER_ACTIVE_CONTEXT_LOOKUP>\n') + '<UNTRUSTED_CAREER_ACTIVE_CONTEXT_LOOKUP>\n'.length;
        return JSON.parse(prompt.slice(start, prompt.indexOf('\n</UNTRUSTED_CAREER_ACTIVE_CONTEXT_LOOKUP>')));
      };
      const compile = async (_prompt, options) => {
        prompts.push(_prompt.length);
        if (options.hints.phase === 'active-context-scan') {
          liveScans += 1;
          maxLiveScans = Math.max(maxLiveScans, liveScans);
          await new Promise(resolve => setTimeout(resolve, (options.hints.activeContextPageCount - options.hints.activeContextPageIndex) % 3));
          liveScans -= 1;
          const payload = scanPayload(_prompt);
          scanPageDigests.push(payload.contextPage.digest);
          scanSourcePageIndexes.push(options.hints.pageIndex);
          const segmentId = payload.page.segments[0].id;
          const rolePatches = payload.contextPage.entries.filter(entry => entry.kind === 'roles').map(entry => ({
            targetId: entry.id, evidenceSegmentIds: [segmentId], updates: { title: entry.context.title },
          }));
          const projectPatches = payload.contextPage.entries.filter(entry => entry.kind === 'projects').map(entry => ({
            targetId: entry.id, evidenceSegmentIds: [segmentId], updates: { name: entry.context.name },
          }));
          activeContextPatchCount += rolePatches.length + projectPatches.length;
          return {
            activeStateDigest: payload.activeState.digest,
            contextPageDigest: payload.contextPage.digest,
            rolePatches, projectPatches,
          };
        }
        if (options.task?.startsWith('career-profile-audit-')) return { findings: [] };
        const index = options.hints.pageIndex;
        const segmentId = `segment-${String(index + 1).padStart(4, '0')}`;
        if (index >= activeEntityCount) return emptyPageShard(segmentId);
        const roleId = `role-${index}`;
        const projectId = `project-${index}`;
        return pageTransport({
          identity: { name: '', contacts: [], evidenceSegmentIds: [segmentId] },
          roles: [{ id: roleId, title: `Role ${index}`, employer: '', startDate: '', endDate: '', location: '', achievementIds: [], skillIds: [], evidenceSegmentIds: [segmentId] }],
          achievements: [],
          projects: [{ id: projectId, name: `Project ${index}`, description: detail, roleId, technologies: [], metrics: [], evidenceSegmentIds: [segmentId] }],
          skills: [], education: [], certifications: [], otherEvidence: [], rolePatches: [], projectPatches: [],
          continuationState: {
            roles: { mode: index === 0 ? 'replace' : 'append', ids: [roleId] },
            projects: { mode: index === 0 ? 'replace' : 'append', ids: [projectId] },
          },
          segmentCoverage: [{ segmentId, disposition: 'role-header', entityIds: ['identity', roleId, projectId] }],
        });
      };
      const options = { sourceFiles: files, pageMaxSegments: 1, pageMaxSourceChars: 48_000, maxPromptChars: 200_000, workerCount: 3, callText: compile, now: () => '2026-10-07T00:00:00.000Z' };
      const first = await compileAuditedCareerSnapshot(options);
      const firstDigestPages = scanPageDigests.slice();
      scanPageDigests.length = 0;
      const restarted = await compileAuditedCareerSnapshot(options);
      let tampered = null;
      let tamperedSiblingStarted = 0;
      let tamperedSiblingAborted = 0;
      try {
        await compileAuditedCareerSnapshot({ ...options, callText: async (prompt, callOptions) => {
          if (callOptions.hints.phase !== 'active-context-scan') return compile(prompt, callOptions);
          const payload = scanPayload(prompt);
          if (callOptions.hints.activeContextPageIndex > 0) {
            tamperedSiblingStarted += 1;
            return new Promise((resolve, reject) => {
              const onAbort = () => {
                tamperedSiblingAborted += 1;
                reject(callOptions.signal.reason || new Error('scan aborted'));
              };
              if (callOptions.signal.aborted) onAbort();
              else callOptions.signal.addEventListener('abort', onAbort, { once: true });
            });
          }
          await new Promise(resolve => setTimeout(resolve, 5));
          return { activeStateDigest: '0'.repeat(64), contextPageDigest: payload.contextPage.digest, rolePatches: [], projectPatches: [] };
        } });
      } catch (error) { tampered = error; }
      const snapshotBytes = Buffer.byteLength(JSON.stringify(first.snapshot), 'utf8');
      const patchAuditReceipts = first.snapshot.auditHistory.at(-1).audits.map(audit => audit.pageAudits.filter(receipt => receipt.scopeKind === 'host-merged-patches'));
      const scopedReceiptTamper = structuredClone(first.snapshot);
      const scopedReceipt = scopedReceiptTamper.auditHistory.at(-1).audits[0].pageAudits.find(receipt => receipt.scopeKind === 'host-merged-patches');
      scopedReceipt.patchCoverageDigest = '0'.repeat(64);
      const completePatchAuditCoverage = receipts => {
        const byPage = new Map();
        for (const receipt of receipts) {
          const entries = byPage.get(receipt.pageIndex) || [];
          entries.push(receipt);
          byPage.set(receipt.pageIndex, entries);
        }
        return [...byPage.values()].every(entries => {
          const firstReceipt = entries[0];
          return entries.length === firstReceipt.scopeCount - 1
            && entries.reduce((total, receipt) => total + receipt.rolePatchCount, 0) === firstReceipt.aggregateRolePatchCount
            && entries.reduce((total, receipt) => total + receipt.projectPatchCount, 0) === firstReceipt.aggregateProjectPatchCount
            && entries.every(receipt => receipt.scopeIndex > 0 && receipt.scopeCount === firstReceipt.scopeCount);
        });
      };
      assert(first.profile.roles.length === activeEntityCount && first.profile.projects.length === activeEntityCount
        && first.profile.segmentCoverage.length === first.corpus.segments.length
        && first.snapshot.auditHistory.at(-1).audits.every(audit => audit.pageAudits.length >= first.snapshot.pagePlan.pageCount)
        && patchAuditReceipts.every(receipts => receipts.length > 1 && completePatchAuditCoverage(receipts))
        && validateCurrentCareerSnapshot(first.snapshot).valid && !validateCurrentCareerSnapshot(scopedReceiptTamper).valid
        && firstDigestPages.length > 1 && new Set(firstDigestPages).size === firstDigestPages.length
        && activeContextPatchCount > 200
        && snapshotBytes < 512 * 1024 * 1024
        && CAREER_PROFILE_PAGE_SCHEMA.properties.rolePatches.maxItems === 100
        && CAREER_PROFILE_PAGE_SCHEMA.properties.projectPatches.maxItems === 100
        && scanSourcePageIndexes.every(pageIndex => pageIndex >= activeEntityCount)
        && maxLiveScans > 1 && maxLiveScans <= 3
        && prompts.every(length => length <= 200_000)
        && stableCareerJsonDigest(first.snapshot.profile) === stableCareerJsonDigest(restarted.snapshot.profile)
        && tampered?.code === 'CAREER_SNAPSHOT_ACTIVE_CONTEXT_INVALID' && tamperedSiblingStarted > 0 && tamperedSiblingAborted === tamperedSiblingStarted,
        `current compilation carries more than 100 simultaneous active roles and projects through append-only host state, merges more than one response-cap of literal active-context patches without weakening raw scan caps, audits every host-merged patch under every semantic category with chained coverage receipts, scans only the final distinct-key digest pages rather than re-censusing earlier sources, remains within the prompt envelope, executes independent scans through a bounded rolling roster that drains aborted siblings, restarts deterministically, and rejects a forged page/state echo instead of dropping a tail context: ${JSON.stringify({ patchAudit: patchAuditReceipts.map(receipts => receipts.map(receipt => [receipt.pageIndex, receipt.scopeIndex, receipt.scopeCount, receipt.rolePatchCount, receipt.projectPatchCount])), valid: validateCurrentCareerSnapshot(first.snapshot).valid, promptMax: Math.max(...prompts) })}`);
      return { activeRoles: first.profile.roles.length, activeProjects: first.profile.projects.length, activeContextPatchCount, contextPages: new Set(firstDigestPages).size, snapshotBytes };
    },
  },
  {
    name: 'career snapshot: every host-merged patch is semantically audited and a late-patch finding repairs through its bounded scope',
    run: async () => {
      const roleCount = 105;
      const files = pagedSourceFiles([
        ...Array.from({ length: roleCount }, (_, index) => `Role ${index}`),
        Array.from({ length: roleCount }, (_, index) => `Role ${index} Detail ${index}`).join(' '),
      ]);
      const corpus = buildCareerSourceCorpus(files);
      const finalPageIndex = roleCount;
      const lateRoleId = `p${String(roleCount).padStart(4, '0')}-role-${roleCount - 1}`;
      let lateFindingIssued = false;
      let latePatchWasAudited = false;
      let lateRepairWasScoped = false;
      let disappearingReplayMode = false;
      let lateGroundingAuditCalls = 0;
      let earlyGroundingScopeIndex = null;
      let releaseEarlyGrounding;
      let earlyGroundingReady = new Promise(resolve => { releaseEarlyGrounding = resolve; });
      const activePayload = prompt => {
        const open = '<UNTRUSTED_CAREER_ACTIVE_CONTEXT_LOOKUP>\n';
        const start = prompt.indexOf(open) + open.length;
        return JSON.parse(prompt.slice(start, prompt.indexOf('\n</UNTRUSTED_CAREER_ACTIVE_CONTEXT_LOOKUP>')));
      };
      const compile = async (prompt, options) => {
        const pageIndex = options.hints.pageIndex;
        const segmentId = corpus.segments[pageIndex].id;
        if (options.hints.phase === 'active-context-scan') {
          const payload = activePayload(prompt);
          return {
            activeStateDigest: payload.activeState.digest,
            contextPageDigest: payload.contextPage.digest,
            rolePatches: payload.contextPage.entries.filter(entry => entry.kind === 'roles').map(entry => ({
              targetId: entry.id, evidenceSegmentIds: [segmentId], updates: { title: entry.context.title },
            })),
            projectPatches: [],
          };
        }
        if (options.task?.startsWith('career-profile-audit-')) {
          const hasLatePatch = options.hints.auditScopeKind === 'host-merged-patches' && prompt.includes(`"targetId":"${lateRoleId}"`);
          if (hasLatePatch) latePatchWasAudited = true;
          if (disappearingReplayMode && pageIndex === finalPageIndex && !hasLatePatch
            && options.hints.auditScopeKind === 'host-merged-patches'
            && options.task === 'career-profile-audit-grounding'
            && (earlyGroundingScopeIndex == null || earlyGroundingScopeIndex === options.hints.auditScopeIndex)) {
            // Fill the category-wide diagnostic sample before the late scope
            // resolves. The replay of these findings remains exact, so only
            // the late, unsampled patch is allowed to exercise fail-closed.
            earlyGroundingScopeIndex ??= options.hints.auditScopeIndex;
            const visibleTarget = /"targetId":"([^"]+)"/.exec(prompt)?.[1];
            releaseEarlyGrounding();
            return { findings: Array.from({ length: 9 }, (_, index) => ({
              id: `early-host-patch-${index}`, severity: 'warning', category: 'grounding', segmentIds: [segmentId],
              entityIds: [visibleTarget], detail: `Earlier exact finding ${index}.`,
            })) };
          }
          if (disappearingReplayMode && hasLatePatch && options.task === 'career-profile-audit-grounding') {
            await earlyGroundingReady;
            await new Promise(resolve => setTimeout(resolve, 0));
            lateGroundingAuditCalls += 1;
            if (lateGroundingAuditCalls === 1) {
              lateFindingIssued = true;
              return { findings: [{ id: 'late-host-patch', severity: 'warning', category: 'grounding', segmentIds: [segmentId], entityIds: [lateRoleId], detail: 'Late exact patch finding must not become a generic replay instruction.' }] };
            }
            return { findings: [] };
          }
          if (hasLatePatch && options.task === 'career-profile-audit-grounding' && !lateFindingIssued) {
            lateFindingIssued = true;
            return { findings: [{ id: 'late-host-patch', severity: 'warning', category: 'grounding', segmentIds: [segmentId], entityIds: [lateRoleId], detail: 'Exercise the bounded repair path for the patch after ordinal 100.' }] };
          }
          return { findings: [] };
        }
        if (options.task === 'career-profile-repair') {
          if (disappearingReplayMode) return emptyPageShard(segmentId);
          lateRepairWasScoped ||= prompt.includes('hostMergedPatchRepairScope') && prompt.includes(lateRoleId);
          const base = emptyPageShard(segmentId);
          return pageTransport({
            ...base,
            rolePatches: [{ targetId: lateRoleId, evidenceSegmentIds: [segmentId], updates: { location: `Detail ${roleCount - 1}` } }],
            segmentCoverage: [{ segmentId, disposition: 'context', entityIds: ['identity', lateRoleId] }],
          });
        }
        if (pageIndex < roleCount) {
          const roleId = `role-${pageIndex}`;
          return pageTransport({
            identity: { name: '', contacts: [], evidenceSegmentIds: [segmentId] },
            roles: [{ id: roleId, title: `Role ${pageIndex}`, employer: '', startDate: '', endDate: '', location: '', achievementIds: [], skillIds: [], evidenceSegmentIds: [segmentId] }],
            achievements: [], projects: [], skills: [], education: [], certifications: [], otherEvidence: [], rolePatches: [], projectPatches: [],
            continuationState: { roles: { mode: pageIndex === 0 ? 'replace' : 'append', ids: [roleId] }, projects: { mode: 'inherit', ids: [] } },
            segmentCoverage: [{ segmentId, disposition: 'role-header', entityIds: ['identity', roleId] }],
          });
        }
        return emptyPageShard(segmentId);
      };
      const result = await compileAuditedCareerSnapshot({
        sourceFiles: files, pageMaxSegments: 1, pageMaxSourceChars: 48_000,
        maxPromptChars: 200_000, workerCount: 3, callText: compile,
        now: () => '2026-10-07T00:00:00.000Z',
      });
      const finalAudits = result.snapshot.auditHistory.at(-1).audits;
      assert(latePatchWasAudited && lateFindingIssued && lateRepairWasScoped
        && finalAudits.every(audit => {
          const scopes = audit.pageAudits.filter(receipt => receipt.pageIndex === finalPageIndex);
          return scopes.length === 3 && scopes[0].scopeKind === 'page'
            && scopes.slice(1).reduce((total, scope) => total + scope.rolePatchCount, 0) === roleCount
            && scopes.slice(1).some(scope => scope.rolePatchCount === 5)
            && scopes.every(scope => scope.patchCoverageDigest === scopes[0].patchCoverageDigest);
        })
        && result.profile.roles.length === roleCount,
      'a patch after ordinal 100 is sent to a literal patch audit, can raise a valid finding, repairs through only its bounded patch context, and leaves six chained scopes proving exact aggregate coverage');
      // The second pass creates nine earlier exact grounding findings (larger
      // than the global diagnostic sample) then makes the ordinal-105 finding
      // disappear only during repair replay. It must fail closed instead of
      // fabricating the old category-only receipt instruction.
      disappearingReplayMode = true;
      lateFindingIssued = false;
      latePatchWasAudited = false;
      lateGroundingAuditCalls = 0;
      earlyGroundingScopeIndex = null;
      earlyGroundingReady = new Promise(resolve => { releaseEarlyGrounding = resolve; });
      let replayFailure = null;
      try {
        await compileAuditedCareerSnapshot({
          sourceFiles: files, pageMaxSegments: 1, pageMaxSourceChars: 48_000,
          maxPromptChars: 200_000, workerCount: 3, callText: compile,
          now: () => '2026-10-07T00:00:00.000Z',
        });
      } catch (error) { replayFailure = error; }
      assert(latePatchWasAudited && lateFindingIssued && lateGroundingAuditCalls === 2
        && replayFailure?.code === 'CAREER_SNAPSHOT_AUDIT_REPLAY_INCOMPLETE'
        && /Refusing a generic repair instruction/.test(replayFailure.message),
      'after more than eight earlier findings consume the bounded diagnostic sample, a vanished ordinal-105 patch finding fails closed rather than becoming a generic repair');
      return { roleCount, latePatchWasAudited, lateRepairWasScoped, replayFailure: replayFailure.code };
    },
  },
  {
    name: 'career snapshot: exact prompt sizing pages two individually capped patch arrays before an audit overflows',
    run: async () => {
      const entityCount = 100;
      const detail = 'd'.repeat(1_000);
      const files = pagedSourceFiles([
        ...Array.from({ length: entityCount }, (_, index) => `Role ${index} Project ${index} ${detail}`),
        Array.from({ length: entityCount }, (_, index) => `Role ${index} Project ${index}`).join(' '),
      ]);
      const corpus = buildCareerSourceCorpus(files);
      const promptLengths = [];
      const activePayload = prompt => {
        const open = '<UNTRUSTED_CAREER_ACTIVE_CONTEXT_LOOKUP>\n';
        const start = prompt.indexOf(open) + open.length;
        return JSON.parse(prompt.slice(start, prompt.indexOf('\n</UNTRUSTED_CAREER_ACTIVE_CONTEXT_LOOKUP>')));
      };
      const result = await compileAuditedCareerSnapshot({
        sourceFiles: files, pageMaxSegments: 1, pageMaxSourceChars: 48_000, maxPromptChars: 30_000, workerCount: 3,
        now: () => '2026-10-07T00:00:00.000Z',
        callText: async (prompt, options) => {
          promptLengths.push(prompt.length);
          const pageIndex = options.hints.pageIndex;
          const segmentId = corpus.segments[pageIndex].id;
          if (options.hints.phase === 'active-context-scan') {
            const payload = activePayload(prompt);
            return {
              activeStateDigest: payload.activeState.digest, contextPageDigest: payload.contextPage.digest,
              rolePatches: payload.contextPage.entries.filter(entry => entry.kind === 'roles').map(entry => ({ targetId: entry.id, evidenceSegmentIds: [segmentId], updates: { title: entry.context.title } })),
              projectPatches: payload.contextPage.entries.filter(entry => entry.kind === 'projects').map(entry => ({ targetId: entry.id, evidenceSegmentIds: [segmentId], updates: { name: entry.context.name } })),
            };
          }
          if (options.task?.startsWith('career-profile-audit-')) return { findings: [] };
          if (pageIndex < entityCount) {
            const roleId = `role-${pageIndex}`;
            const projectId = `project-${pageIndex}`;
            return pageTransport({
              identity: { name: '', contacts: [], evidenceSegmentIds: [segmentId] },
              roles: [{ id: roleId, title: `Role ${pageIndex}`, employer: '', startDate: '', endDate: '', location: '', achievementIds: [], skillIds: [], evidenceSegmentIds: [segmentId] }],
              achievements: [], projects: [{ id: projectId, name: `Project ${pageIndex}`, description: detail, roleId, technologies: [], metrics: [], evidenceSegmentIds: [segmentId] }], skills: [], education: [], certifications: [], otherEvidence: [], rolePatches: [], projectPatches: [],
              continuationState: { roles: { mode: pageIndex === 0 ? 'replace' : 'append', ids: [roleId] }, projects: { mode: pageIndex === 0 ? 'replace' : 'append', ids: [projectId] } },
              segmentCoverage: [{ segmentId, disposition: 'role-header', entityIds: ['identity', roleId, projectId] }],
            });
          }
          return emptyPageShard(segmentId);
        },
      });
      const finalPageIndex = entityCount;
      assert(CAREER_PROFILE_PAGE_SCHEMA.properties.rolePatches.maxItems === entityCount
        && CAREER_PROFILE_PAGE_SCHEMA.properties.projectPatches.maxItems === entityCount
        && result.snapshot.auditHistory.at(-1).audits.every(audit => {
          const scopes = audit.pageAudits.filter(receipt => receipt.pageIndex === finalPageIndex);
          return scopes.length > 2 && scopes[0].scopeKind === 'page'
            && scopes[0].aggregateRolePatchCount === entityCount && scopes[0].aggregateProjectPatchCount === entityCount
            && scopes.slice(1).reduce((total, scope) => total + scope.rolePatchCount, 0) === entityCount
            && scopes.slice(1).reduce((total, scope) => total + scope.projectPatchCount, 0) === entityCount;
        })
        && promptLengths.every(length => length <= 30_000),
      'two arrays that each satisfy their 100-item response cap are still split into exact-size literal audit scopes when their combined serialized prompt would overflow');
      return { scopes: result.snapshot.auditHistory.at(-1).audits[0].pageAudits.filter(receipt => receipt.pageIndex === finalPageIndex).length, maxPrompt: Math.max(...promptLengths) };
    },
  },
  {
    name: 'career snapshot: headerless boundary bullets route only the immediately prior active context and fail closed when that edge is ambiguous',
    run: async () => {
      const roleCount = 102;
      const headerLines = Array.from({ length: roleCount }, (_, index) => `Role ${index}`);
      const files = pagedSourceFiles([...headerLines, 'Toronto patch one', 'Toronto patch two', 'Completed a headerless continuation bullet.']);
      const corpus = buildCareerSourceCorpus(files);
      let bulletCompileCalled = false;
      const compile = async (prompt, options) => {
        if (options.task?.startsWith('career-profile-audit-')) return { findings: [] };
        const pageIndex = options.hints.pageIndex;
        const segments = corpus.segments.slice(pageIndex * 2, pageIndex * 2 + 2);
        if (pageIndex < 51) {
          const roles = segments.map((segment, offset) => {
            const index = pageIndex * 2 + offset;
            return { id: `role-${index}`, title: `Role ${index}`, employer: '', startDate: '', endDate: '', location: '', achievementIds: [], skillIds: [], evidenceSegmentIds: [segment.id] };
          });
          const projects = pageIndex === 0 ? [{ id: 'project-0', name: 'Project 0', description: '', roleId: roles[0].id, technologies: [], metrics: [], evidenceSegmentIds: [segments[0].id] }] : [];
          return pageTransport({
            identity: { name: '', contacts: [], evidenceSegmentIds: segments.map(segment => segment.id) }, roles, achievements: [], projects, skills: [], education: [], certifications: [], otherEvidence: [], rolePatches: [], projectPatches: [],
            continuationState: {
              roles: { mode: pageIndex === 0 ? 'replace' : 'append', ids: roles.map(role => role.id) },
              projects: { mode: pageIndex === 0 ? 'replace' : 'inherit', ids: projects.map(project => project.id) },
            },
            segmentCoverage: segments.map((segment, offset) => ({ segmentId: segment.id, disposition: 'role-header', entityIds: ['identity', roles[offset].id, ...(offset === 0 && pageIndex === 0 ? [projects[0].id] : [])] })),
          });
        }
        if (pageIndex === 51) {
          const rolePatches = Array.from({ length: 100 }, (_, index) => ({ targetId: `p${String(Math.floor(index / 2) + 1).padStart(4, '0')}-role-${index}`, evidenceSegmentIds: [segments[index < 50 ? 0 : 1].id], updates: { location: 'Toronto' } }));
          return pageTransport({
            identity: { name: '', contacts: [], evidenceSegmentIds: segments.map(segment => segment.id) }, roles: [], achievements: [], projects: [], skills: [], education: [], certifications: [], otherEvidence: [], rolePatches,
            projectPatches: [{ targetId: 'p0001-project-0', evidenceSegmentIds: [segments[0].id], updates: { name: 'Project 0' } }],
            continuationState: { roles: { mode: 'inherit', ids: [] }, projects: { mode: 'inherit', ids: [] } },
            segmentCoverage: segments.map((segment, offset) => ({ segmentId: segment.id, disposition: 'context', entityIds: ['identity', ...rolePatches.filter((_patch, patchIndex) => (patchIndex < 50) === (offset === 0)).map(patch => patch.targetId), ...(offset === 0 ? ['p0001-project-0'] : [])] })),
          });
        }
        bulletCompileCalled = true;
        return emptyPageShard(segments[0].id);
      };
      let ambiguous = null;
      try {
        await compileAuditedCareerSnapshot({ sourceFiles: files, pageMaxSegments: 2, pageMaxSourceChars: 48_000, callText: compile });
      } catch (error) { ambiguous = error; }
      assert(ambiguous?.code === 'CAREER_SNAPSHOT_ACTIVE_CONTEXT_AMBIGUOUS' && !bulletCompileCalled,
        'when the immediately prior shard touches more than one active-context page, a headerless following bullet must fail before compilation rather than fall back to a global context census');

      const narrowFiles = pagedSourceFiles([...headerLines, 'Completed a headerless continuation bullet.']);
      const narrowCorpus = buildCareerSourceCorpus(narrowFiles);
      let narrowContextPresent = false;
      const narrow = await compileAuditedCareerSnapshot({
        sourceFiles: narrowFiles, pageMaxSegments: 1, pageMaxSourceChars: 48_000,
        callText: async (prompt, options) => {
          if (options.task?.startsWith('career-profile-audit-')) return { findings: [] };
          const index = options.hints.pageIndex;
          const segmentId = narrowCorpus.segments[index].id;
          if (index < roleCount) {
            const roleId = `role-${index}`;
            return pageTransport({
              identity: { name: '', contacts: [], evidenceSegmentIds: [segmentId] }, roles: [{ id: roleId, title: `Role ${index}`, employer: '', startDate: '', endDate: '', location: '', achievementIds: [], skillIds: [], evidenceSegmentIds: [segmentId] }], achievements: [], projects: [], skills: [], education: [], certifications: [], otherEvidence: [], rolePatches: [], projectPatches: [],
              continuationState: { roles: { mode: index === 0 ? 'replace' : 'append', ids: [roleId] }, projects: { mode: 'inherit', ids: [] } },
              segmentCoverage: [{ segmentId, disposition: 'role-header', entityIds: ['identity', roleId] }],
            });
          }
          narrowContextPresent = prompt.includes(`p${String(roleCount).padStart(4, '0')}-role-${roleCount - 1}`);
          const achievementId = 'headerless-bullet';
          return pageTransport({
            identity: { name: '', contacts: [], evidenceSegmentIds: [segmentId] }, roles: [], achievements: [{ id: achievementId, roleId: `p${String(roleCount).padStart(4, '0')}-role-${roleCount - 1}`, claim: 'Completed a headerless continuation bullet.', technologies: [], metrics: [], evidenceSegmentIds: [segmentId] }], projects: [], skills: [], education: [], certifications: [], otherEvidence: [], rolePatches: [], projectPatches: [],
            continuationState: { roles: { mode: 'inherit', ids: [] }, projects: { mode: 'inherit', ids: [] } },
            segmentCoverage: [{ segmentId, disposition: 'achievement', entityIds: ['identity', achievementId] }],
          });
        },
      });
      assert(narrowContextPresent && narrow.profile.achievements[0].roleId === `p${String(roleCount).padStart(4, '0')}-role-${roleCount - 1}`,
        'a headerless bullet after more than 100 active roles receives only the immediately preceding appended role as bounded host context, preserving attribution without an all-active prompt');
      return { activeRoles: narrow.profile.roles.length, ambiguousRejected: true };
    },
  },
  {
    name: 'career snapshot: v4 approvals are explicit pin-only history and cannot satisfy the v5 cache contract',
    run: async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-career-snapshot-'));
      try {
        const corpus = buildCareerSourceCorpus(sourceFiles());
        const v4Contract = '4'.repeat(64);
        const snapshot = currentSnapshot(corpus, validProfile(corpus));
        snapshot.schemaVersion = 4;
        snapshot.compilationContract = v4Contract;
        snapshot.snapshotId = careerSnapshotIdForContract(corpus, v4Contract);
        const storedPath = path.join(root, 'career-snapshots', `${snapshot.snapshotId}.json`);
        fs.mkdirSync(path.dirname(storedPath), { recursive: true });
        fs.writeFileSync(storedPath, `${JSON.stringify(snapshot)}\n`, 'utf8');
        assert(await readCareerSnapshot(root, snapshot.snapshotId) === null
          && (await readPinnedCareerSnapshot(root, snapshot.snapshotId))?.snapshotId === snapshot.snapshotId
          && snapshot.snapshotId !== careerSnapshotId(corpus),
        'a structurally complete v4 approval is readable only through an explicit historical pin path; current v5 cache lookup rejects its older schema/contract identity');
        return { legacySnapshotId: snapshot.snapshotId.slice(0, 12) };
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'career snapshot: historical pins retain structurally valid old transcription receipts but reject malformed receipt identity',
    run: async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-career-snapshot-'));
      try {
        const historicalContract = 'e'.repeat(64);
        const historicalReceipt = { ...verbatimCareerTranscriptionAuditReceipt(), policyDigest: 'f'.repeat(64) };
        const historicalSources = sourceFiles().map(source => ({ ...source, transcriptionAudit: historicalReceipt }));
        const corpus = buildCareerSourceCorpus(historicalSources, { requireCurrentTranscriptionPolicy: false });
        const snapshotId = careerSnapshotIdForContract(corpus, historicalContract);
        const snapshot = {
          schemaVersion: 2, status: 'approved', snapshotId, inputFingerprint: corpus.inputFingerprint,
          sourceFingerprint: corpus.sourceFingerprint, compilationContract: historicalContract,
          approvedAt: '2026-10-07T00:00:00.000Z', sources: corpus.sources, segments: corpus.segments,
          profile: validProfile(corpus), auditHistory: cleanAuditHistory(),
        };
        const storedPath = path.join(root, 'career-snapshots', `${snapshotId}.json`);
        fs.mkdirSync(path.dirname(storedPath), { recursive: true });
        fs.writeFileSync(storedPath, `${JSON.stringify(snapshot)}\n`, 'utf8');
        assert(await readCareerSnapshot(root, snapshotId) === null
          && (await readPinnedCareerSnapshot(root, snapshotId))?.snapshotId === snapshotId,
        'new-search cache reads reject historical policy receipts while an existing pin validates their structure and contract-bound identity');
        const malformed = structuredClone(snapshot);
        malformed.sources[0].transcriptionAudit.findingDigest = '0'.repeat(64);
        fs.writeFileSync(storedPath, `${JSON.stringify(malformed)}\n`, 'utf8');
        assert(await readPinnedCareerSnapshot(root, snapshotId) === null,
          'historical compatibility never permits malformed transcription receipts or a source fingerprint/id mismatch');
        return { historicalPolicyPinned: true, malformedRejected: true };
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  },
];
