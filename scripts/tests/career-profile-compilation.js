import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import nodeAssert from 'node:assert';
import { assert } from './testHelpers.js';
import { MAX_SOURCE_GROUNDING_QUOTE_CHARS } from '../../electron/ipc/applicationSourceLimits.js';
import { careerDataProjectProvenanceHeadingForName, resumeRoleLocationFailures } from '../../electron/ipc/jobApplication.js';
import {
  buildCareerProfileCompilePrompt,
  approvedCareerEvidenceCatalog,
  buildCareerProfileAuditPrompt,
  buildCareerProfilePageCompilePrompt,
  buildCareerSourceCorpus,
  CAREER_APPLICATION_HISTORICAL_PROJECTION_FORMAT,
  CAREER_APPLICATION_PROJECTION_FORMAT,
  CAREER_SNAPSHOT_HISTORICAL_MAX_SEGMENTS,
  CAREER_SNAPSHOT_PINNED_LEGACY_V6_CONTRACTS,
  CAREER_SNAPSHOT_COMPILATION_CONTRACT,
  CAREER_TRANSCRIPTION_POLICY_DIGEST,
  CAREER_SNAPSHOT_MAX_FILE_BYTES,
  CAREER_SNAPSHOT_SCHEMA_VERSION,
  CAREER_SNAPSHOT_SEGMENT_POLICY,
  CAREER_PROFILE_COMPILE_SCHEMA,
  CAREER_PROFILE_PAGE_SCHEMA,
  __ownedDeterministicFindingsForTests,
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

// ── Field-level edit protocol harness ──────────────────────────────────────
// One page (sourceFiles) compiled from validProfile. Each fake responder
// returns a list of candidate answers; the harness tries them in order through
// the real responseValidator, exactly as the durable handoff re-prompts the
// same worker after a rejected answer.
const EDIT_LANES = [
  ['coverage', 'career-profile-audit-completeness'],
  ['grounding', 'career-profile-audit-grounding'],
  ['attribution', 'career-profile-audit-attribution'],
  ['metrics', 'career-profile-audit-metrics'],
  ['skills', 'career-profile-audit-skills'],
  ['conflict', 'career-profile-audit-conflicts'],
];
const EDIT_LANE_BY_TASK = new Map(EDIT_LANES.map(([lane, task]) => [task, lane]));
const EDIT_SKILL = 'p0001-skill-python';
const NO_CHALLENGE = Object.freeze({ decisionId: '', evidenceSegmentIds: [] });

function categoryEdit(value, entityId = EDIT_SKILL) {
  return { op: 'set', group: 'skills', entityId, field: 'category', valueJson: JSON.stringify(value) };
}

function editFinding({ id = 'skill-category', category = 'skills', segmentIds, edits, sourceQuote = 'Built Python service', challenge = NO_CHALLENGE, entityIds = [EDIT_SKILL] }) {
  return { id, severity: 'warning', category, segmentIds, entityIds, detail: 'The skill category must follow the source.', edits, sourceQuote, challenge: structuredClone(challenge) };
}

function auditPayload(prompt) {
  const match = prompt.match(/<UNTRUSTED_CAREER_PAGE_AUDIT_INPUT>\n([\s\S]*)\n<\/UNTRUSTED_CAREER_PAGE_AUDIT_INPUT>/u);
  // Host-merged patch-scope prompts use a different envelope.
  return match ? JSON.parse(match[1]) : null;
}

function adjudicationPayload(prompt) {
  const match = prompt.match(/<UNTRUSTED_CAREER_ADJUDICATION_INPUT>\n([\s\S]*)\n<\/UNTRUSTED_CAREER_ADJUDICATION_INPUT>/u);
  return JSON.parse(match[1]);
}

function fieldEdit(field, value, entityId = EDIT_SKILL) {
  return { op: 'set', group: 'skills', entityId, field, valueJson: JSON.stringify(value) };
}

// Shared fake callText harness. `round` counts calls per lane AND per
// page/scope, so on a single page it is the compile round; multi-page tests
// pass `files` + `pageMaxSegments` and read `pageIndex`/`scopeKind`.
async function runEditProtocol({
  audit = () => [{ findings: [] }], repair = () => [], adjudicate = () => [], compile = null,
  files = sourceFiles(), pageMaxSegments = undefined,
} = {}) {
  const corpus = buildCareerSourceCorpus(files);
  const log = { calls: [], rejected: [], progress: [] };
  const roundsByLane = new Map();
  const result = await compileAuditedCareerSnapshot({
    sourceFiles: files,
    ...(pageMaxSegments === undefined ? {} : { pageMaxSegments, pageMaxSourceChars: 1 }),
    onProgress: event => log.progress.push(event),
    callText: async (prompt, options) => {
      const phase = options.hints?.phase || '';
      const pageIndex = options.hints?.pageIndex ?? 0;
      log.calls.push({ task: options.task, phase, prompt, options, pageIndex });
      if (options.task === 'career-profile-compile') return compile ? compile(corpus, pageIndex, prompt, options) : pageTransport(validProfile(corpus));
      let candidates;
      if (EDIT_LANE_BY_TASK.has(options.task)) {
        const lane = EDIT_LANE_BY_TASK.get(options.task);
        const scopeKind = options.hints?.auditScopeKind || '';
        const scopeIndex = options.hints?.auditScopeIndex ?? 0;
        const key = `${lane}\u0000${pageIndex}\u0000${scopeKind}\u0000${scopeIndex}`;
        const round = roundsByLane.get(key) || 0;
        roundsByLane.set(key, round + 1);
        candidates = audit({ lane, round, payload: auditPayload(prompt), prompt, corpus, pageIndex, scopeKind, scopeIndex, options });
      } else if (options.task === 'career-profile-repair' && phase === 'adjudication') candidates = adjudicate({ prompt, corpus, pageIndex });
      else if (options.task === 'career-profile-repair' && phase === 'edit-repair') candidates = repair({ prompt, corpus, pageIndex });
      else throw new Error(`Unexpected task ${options.task}/${phase}`);
      for (const candidate of candidates) {
        try {
          options.responseValidator(candidate);
          return candidate;
        } catch (error) {
          log.rejected.push({ task: options.task, phase, pageIndex, message: error.message });
        }
      }
      throw new Error(`No ${options.task}/${phase} candidate was accepted: ${log.rejected.map(item => item.message).join(' || ')}`);
    },
  });
  return { result, corpus, log };
}

const convergencePayloads = log => log.progress.filter(event => Object.hasOwn(event, 'convergence')).map(event => event.convergence);
const finalSkill = result => result.profile.skills.find(skill => skill.name === 'Python');
const finalDecisionLog = result => result.snapshot.auditHistory[result.snapshot.auditHistory.length - 1].decisionLog;

const editProtocolTests = [
  {
    name: 'career snapshot edits: one audit sample per page/scope/lane per round, clean edits apply without any repair call, and convergence progress is exact',
    run: async () => {
      const { result, corpus, log } = await runEditProtocol({
        audit: ({ lane, round, corpus: source }) => (lane === 'skills' && round === 0
          ? [{ findings: [editFinding({ segmentIds: [source.segments[3].id], edits: [categoryEdit('programming language')] })] }]
          : [{ findings: [] }]),
      });
      const auditCalls = log.calls.filter(call => EDIT_LANE_BY_TASK.has(call.task));
      const repairCalls = log.calls.filter(call => call.task === 'career-profile-repair');
      const convergence = convergencePayloads(log);
      const expected = {
        round: 1,
        findings: { blocker: 0, warning: 1 },
        byCategory: { skills: { blocker: 0, warning: 1 } },
        editsApplied: 1,
        decisionsTotal: 1,
        challengesAccepted: 0,
        adjudications: 0,
        findingsRejected: 0,
        editRepairs: 0,
        deterministicErrors: 0,
      };
      assert(auditCalls.length === 12 && repairCalls.length === 0
        && auditCalls.every(call => call.options.responseSchema.properties.findings.items.required.includes('edits'))
        && finalSkill(result).category === 'programming language'
        && convergence.length === 1 && canonicalJson(convergence[0]) === canonicalJson(expected)
        && validateCurrentCareerSnapshot(result.snapshot).valid && corpus.segments.length === 5,
      `two rounds must run exactly 6 lanes x 1 page x 1 scope audits each, apply the finding edit with zero repair calls, and emit one exact convergence payload (audits=${auditCalls.length}, repairs=${repairCalls.length}, convergence=${canonicalJson(convergence)})`);
      return { auditCalls: auditCalls.length, convergence: convergence[0] };
    },
  },
  {
    name: 'career snapshot edits: responseValidator rejects no-op, unknown-entity, unverifiable-quote and out-of-page challenge findings, then accepts the corrected answer',
    run: async () => {
      const { result, log } = await runEditProtocol({
        audit: ({ lane, round, corpus: source }) => {
          if (lane !== 'skills' || round !== 0) return [{ findings: [] }];
          const segmentIds = [source.segments[3].id];
          return [
            { findings: [editFinding({ id: 'noop-edit', segmentIds, edits: [categoryEdit('language')] })] },
            { findings: [editFinding({ id: 'unknown-entity', segmentIds, edits: [categoryEdit('programming language', 'p0001-skill-missing')] })] },
            { findings: [editFinding({ id: 'bad-quote', segmentIds, sourceQuote: 'Invented a quantum compiler', edits: [categoryEdit('programming language')] })] },
            { findings: [editFinding({ id: 'outside-evidence', segmentIds, challenge: { decisionId: '', evidenceSegmentIds: ['segment-9999'] }, edits: [categoryEdit('programming language')] })] },
            { findings: [editFinding({ id: 'corrected', segmentIds, edits: [categoryEdit('programming language')] })] },
          ];
        },
      });
      const ids = ['noop-edit', 'unknown-entity', 'bad-quote', 'outside-evidence'];
      assert(log.rejected.length === 4
        && ids.every((id, index) => log.rejected[index].message.includes(`skills finding ${id}`))
        && log.rejected[2].message.includes('sourceQuote is not a verbatim quote')
        && log.rejected[3].message.includes('challenge evidence segment-9999 is not a segment of page-0001')
        && finalSkill(result).category === 'programming language'
        && convergencePayloads(log)[0].findingsRejected === 4,
      `each invalid finding must be rejected in order with its own id and the corrected answer applied (${log.rejected.map(item => item.message).join(' || ')})`);
      return { rejected: log.rejected.length };
    },
  },
  {
    name: 'career snapshot edits: the decision log settles a target, rejects unchallenged or re-interpreting challenges, and adjudicates a new-evidence challenge once',
    run: async () => {
      let settledId = '';
      const { result, log } = await runEditProtocol({
        audit: ({ lane, round, payload, corpus: source }) => {
          if (lane !== 'skills') return [{ findings: [] }];
          const service = source.segments[3].id;
          const title = source.segments[1].id;
          if (round === 0) return [{ findings: [editFinding({ segmentIds: [service], edits: [categoryEdit('programming language')] })] }];
          if (round === 1) {
            settledId = payload.settledDecisions.find(decision => decision.targetKey.endsWith('\u0000category')).id;
            return [
              { findings: [editFinding({ id: 'unchallenged', segmentIds: [service], edits: [categoryEdit('language')] })] },
              { findings: [editFinding({ id: 'considered-only', segmentIds: [service], challenge: { decisionId: settledId, evidenceSegmentIds: [service] }, edits: [categoryEdit('language')] })] },
              { findings: [editFinding({ id: 'new-evidence', segmentIds: [service], challenge: { decisionId: settledId, evidenceSegmentIds: [title] }, edits: [categoryEdit('language')] })] },
            ];
          }
          if (round === 2) {
            return [
              { findings: [editFinding({ id: 'repeat-challenge', segmentIds: [service], challenge: { decisionId: settledId, evidenceSegmentIds: [title] }, edits: [categoryEdit('language')] })] },
              { findings: [] },
            ];
          }
          return [{ findings: [] }];
        },
        adjudicate: ({ corpus: source }) => [{ ruling: 'keep', valueJson: '', rationale: 'The source supports the settled category.', sourceQuote: 'Built Python service', evidenceSegmentIds: [source.segments[3].id] }],
      });
      const adjudications = log.calls.filter(call => call.phase === 'adjudication');
      const auditRejections = log.rejected.filter(item => item.task === 'career-profile-audit-skills').map(item => item.message);
      const decision = finalDecisionLog(result).targets.find(target => target.targetKey.endsWith('\u0000category'));
      assert(adjudications.length === 1 && adjudications[0].task === 'career-profile-repair'
        && adjudications[0].options.hints.phase === 'adjudication'
        && auditRejections.length === 3
        && auditRejections[0].includes('skills finding unchallenged')
        && auditRejections[1].includes('skills finding considered-only')
        && auditRejections[2].includes('skills finding repeat-challenge')
        && finalSkill(result).category === 'programming language'
        && decision.current.origin === 'adjudication' && decision.current.valueJson === '"programming language"'
        && decision.supersededDecisionIds.includes(settledId)
        && validateCurrentCareerSnapshot(result.snapshot).valid,
      `a settled target needs a new-evidence challenge, which gets exactly one adjudication; keep retains the value and the same challenge cannot reopen (${auditRejections.join(' || ')})`);
      return { adjudications: adjudications.length, rejected: auditRejections.length };
    },
  },
  {
    name: 'career snapshot edits: two lanes proposing different values for one target get exactly one adjudication whose change ruling is applied',
    run: async () => {
      const { result, log } = await runEditProtocol({
        audit: ({ lane, round, corpus: source }) => {
          if (round !== 0 || !['skills', 'metrics'].includes(lane)) return [{ findings: [] }];
          const value = lane === 'skills' ? 'programming language' : 'scripting language';
          return [{ findings: [editFinding({ id: `${lane}-category`, category: lane, segmentIds: [source.segments[3].id], edits: [categoryEdit(value)] })] }];
        },
        adjudicate: ({ prompt, corpus: source }) => {
          assert(prompt.includes('scripting language') && prompt.includes('programming language'), 'the adjudication input must carry both competing proposals');
          return [
            { ruling: 'change', valueJson: '"systems language"', rationale: 'Not proposed.', sourceQuote: 'Built Python service', evidenceSegmentIds: [source.segments[3].id] },
            { ruling: 'change', valueJson: JSON.stringify([categoryEdit('scripting language')]), rationale: 'The metrics reading fits.', sourceQuote: 'Built Python service', evidenceSegmentIds: [source.segments[3].id] },
          ];
        },
      });
      const adjudications = log.calls.filter(call => call.phase === 'adjudication');
      const decision = finalDecisionLog(result).targets.find(target => target.targetKey.endsWith('\u0000category'));
      const convergence = convergencePayloads(log)[0];
      assert(adjudications.length === 1 && log.rejected.length === 1 && log.rejected[0].phase === 'adjudication'
        && finalSkill(result).category === 'scripting language'
        && decision.current.origin === 'adjudication' && decision.current.valueJson === '"scripting language"'
        && convergence.adjudications === 1 && convergence.editsApplied === 1
        && canonicalJson(convergence.byCategory) === canonicalJson({ metrics: { blocker: 0, warning: 1 }, skills: { blocker: 0, warning: 1 } }),
      `a same-round conflict must be adjudicated once, an unproposed ruling rejected, and the ruled value applied with adjudication origin (${canonicalJson(convergence)})`);
      return { adjudications: adjudications.length };
    },
  },
  {
    name: 'career snapshot edits: a cross-category audit observation is host-canonicalized to the invoked lane before acceptance',
    run: async () => {
      const { result, log } = await runEditProtocol({
        audit: ({ lane, round, corpus: source }) => (lane === 'skills' && round === 0
          ? [{ findings: [editFinding({ id: 'cross-lane', category: 'grounding', segmentIds: [source.segments[3].id], edits: [categoryEdit('programming language')] })] }]
          : [{ findings: [] }]),
      });
      const convergence = convergencePayloads(log)[0];
      const decision = finalDecisionLog(result).targets.find(target => target.targetKey === `skills\u0000${EDIT_SKILL}\u0000category`);
      nodeAssert.deepStrictEqual(convergence.byCategory, { skills: { blocker: 0, warning: 1 } });
      nodeAssert.deepStrictEqual([convergence.editsApplied, convergence.findingsRejected, convergence.adjudications], [1, 0, 0]);
      nodeAssert.deepStrictEqual([decision.current.origin, decision.current.valueJson], ['audit', '"programming language"']);
      nodeAssert.strictEqual(finalSkill(result).category, 'programming language');
      return { byCategory: convergence.byCategory };
    },
  },
  {
    name: 'career snapshot edits: a losing finding loses every edit, including uncontested siblings, and the winner applies whole',
    run: async () => {
      const { result, log } = await runEditProtocol({
        audit: ({ lane, round, corpus: source }) => {
          if (round !== 0 || !['skills', 'metrics'].includes(lane)) return [{ findings: [] }];
          const segmentIds = [source.segments[3].id];
          const edits = lane === 'skills'
            ? [categoryEdit('programming language'), fieldEdit('indexEligible', false)]
            : [categoryEdit('scripting language')];
          return [{ findings: [editFinding({ id: `${lane}-coordinated`, category: lane, segmentIds, edits })] }];
        },
        adjudicate: ({ corpus: source }) => [
          { ruling: 'change', valueJson: JSON.stringify([categoryEdit('scripting language'), fieldEdit('indexEligible', false)]), rationale: 'A mixed array is no proposal.', sourceQuote: 'Built Python service', evidenceSegmentIds: [source.segments[3].id] },
          { ruling: 'change', valueJson: JSON.stringify([categoryEdit('scripting language')]), rationale: 'The metrics reading fits.', sourceQuote: 'Built Python service', evidenceSegmentIds: [source.segments[3].id] },
        ],
      });
      const adjudications = log.calls.filter(call => call.phase === 'adjudication');
      const input = adjudicationPayload(adjudications[0].prompt);
      const targets = finalDecisionLog(result).targets;
      const category = targets.find(target => target.targetKey === `skills\u0000${EDIT_SKILL}\u0000category`);
      const eligible = targets.find(target => target.targetKey === `skills\u0000${EDIT_SKILL}\u0000indexEligible`);
      const convergence = convergencePayloads(log)[0];
      nodeAssert.strictEqual(adjudications.length, 1);
      nodeAssert.deepStrictEqual(input.proposals.map(proposal => [proposal.findingId, proposal.lane, proposal.edits]).sort(), [
        ['metrics-coordinated', 'metrics', [categoryEdit('scripting language')]],
        ['skills-coordinated', 'skills', [categoryEdit('programming language'), fieldEdit('indexEligible', false)]],
      ]);
      nodeAssert.deepStrictEqual(input.targets.map(target => [target.field, target.currentValueJson]), [['category', '"language"'], ['indexEligible', 'true']]);
      nodeAssert.deepStrictEqual(log.rejected.map(item => item.phase), ['adjudication']);
      nodeAssert.strictEqual(finalSkill(result).category, 'scripting language');
      nodeAssert.strictEqual(finalSkill(result).indexEligible, true);
      nodeAssert.deepStrictEqual([category.current.origin, category.current.valueJson, eligible.current.origin, eligible.current.valueJson],
        ['adjudication', '"scripting language"', 'adjudication', 'true']);
      nodeAssert.strictEqual(category.current.groupId, eligible.current.groupId);
      nodeAssert.deepStrictEqual([convergence.adjudications, convergence.editsApplied], [1, 1]);
      return { adjudications: adjudications.length };
    },
  },
  {
    name: 'career snapshot edits: a coordinated fix settles under one groupId, a stale reversal is rejected, and a groupId challenge with new evidence is adjudicated once for the whole cluster',
    run: async () => {
      let settled = [];
      const { result, log } = await runEditProtocol({
        audit: ({ lane, round, payload, corpus: source }) => {
          const service = source.segments[3].id;
          if (round === 0 && lane === 'skills') {
            return [{ findings: [editFinding({ id: 'qualify', segmentIds: [service], edits: [categoryEdit('scripting language'), fieldEdit('capabilityKind', 'technology')] })] }];
          }
          if (round !== 1 || !['skills', 'metrics'].includes(lane)) return [{ findings: [] }];
          settled = payload.settledDecisions.filter(decision => decision.targetKey.startsWith(`skills\u0000${EDIT_SKILL}\u0000`));
          const groupId = settled[0].groupId;
          if (lane === 'metrics') {
            return [{ findings: [editFinding({ id: 'other-reading', category: 'metrics', segmentIds: [service], challenge: { decisionId: groupId, evidenceSegmentIds: [source.segments[2].id] }, edits: [categoryEdit('systems language'), fieldEdit('capabilityKind', 'tool'), fieldEdit('indexEligible', false)] })] }];
          }
          const reverse = [categoryEdit('language'), fieldEdit('capabilityKind', 'language')];
          return [
            { findings: [editFinding({ id: 'reverse-unchallenged', segmentIds: [service], edits: reverse })] },
            { findings: [editFinding({ id: 'reverse-stale', segmentIds: [service], challenge: { decisionId: groupId, evidenceSegmentIds: [service] }, edits: reverse })] },
            { findings: [editFinding({ id: 'reverse', segmentIds: [service], challenge: { decisionId: groupId, evidenceSegmentIds: [source.segments[1].id] }, edits: reverse })] },
          ];
        },
        adjudicate: ({ corpus: source }) => [{
          ruling: 'change', valueJson: JSON.stringify([categoryEdit('language'), fieldEdit('capabilityKind', 'language')]),
          rationale: 'The source states a language used directly.', sourceQuote: 'Built Python service', evidenceSegmentIds: [source.segments[3].id],
        }],
      });
      const adjudications = log.calls.filter(call => call.phase === 'adjudication');
      const auditRejections = log.rejected.filter(item => item.phase !== 'adjudication').map(item => item.message);
      const targets = finalDecisionLog(result).targets.filter(target => target.targetKey.startsWith(`skills\u0000${EDIT_SKILL}\u0000`));
      nodeAssert.deepStrictEqual(settled.map(decision => decision.targetKey.split('\u0000')[2]), ['capabilityKind', 'category']);
      assert(/^group-[0-9a-f]{16}$/u.test(settled[0].groupId) && settled[0].groupId === settled[1].groupId
        && settled.every(decision => decision.id !== decision.groupId && decision.origin === 'audit'),
      `one finding's decisions must share one host groupId (${canonicalJson(settled)})`);
      nodeAssert.strictEqual(auditRejections.length, 2);
      assert(auditRejections[0].includes('skills finding reverse-unchallenged') && auditRejections[0].includes(`or ${settled[0].groupId}`)
        && auditRejections[1].includes('skills finding reverse-stale') && auditRejections[1].includes('cites no new evidence'),
      `stale reversals must be rejected (${auditRejections.join(' || ')})`);
      nodeAssert.strictEqual(adjudications.length, 1);
      const input = adjudicationPayload(adjudications[0].prompt);
      nodeAssert.deepStrictEqual(input.proposals.map(proposal => proposal.findingId).sort(), ['other-reading', 'reverse']);
      nodeAssert.deepStrictEqual(input.targets.map(target => target.field), ['capabilityKind', 'category', 'indexEligible']);
      nodeAssert.deepStrictEqual(input.currentDecisions.map(decision => decision.groupId), [settled[0].groupId, settled[0].groupId]);
      const skill = finalSkill(result);
      nodeAssert.deepStrictEqual([skill.category, skill.capabilityKind, skill.indexEligible], ['language', 'language', true]);
      nodeAssert.deepStrictEqual(targets.map(target => [target.targetKey.split('\u0000')[2], target.current.origin, target.current.valueJson]), [
        ['capabilityKind', 'adjudication', '"language"'],
        ['category', 'adjudication', '"language"'],
        ['indexEligible', 'adjudication', 'true'],
      ]);
      const rulingGroup = targets[0].current.groupId;
      assert(rulingGroup !== settled[0].groupId && targets.every(target => target.current.groupId === rulingGroup)
        && settled.every(decision => targets.some(target => target.supersededDecisionIds.includes(decision.id))),
      'one ruling settles every cluster target under one new groupId and supersedes the coordinated decisions');
      const challenged = convergencePayloads(log)[1];
      nodeAssert.deepStrictEqual([challenged.adjudications, challenged.challengesAccepted, challenged.editsApplied], [1, 2, 2]);
      assert(result.snapshot.status === 'approved' && validateCurrentCareerSnapshot(result.snapshot).valid, 'the coordinated reversal converges to an approved snapshot');
      return { adjudications: adjudications.length };
    },
  },
  {
    name: 'career snapshot edits: an adversarial flip-flop auditor that never cites new evidence cannot stop approval within four rounds',
    run: async () => {
      const { result, log } = await runEditProtocol({
        audit: ({ lane, round, payload, corpus: source }) => {
          if (lane !== 'skills') return [{ findings: [] }];
          const service = source.segments[3].id;
          const value = round % 2 === 0 ? 'programming language' : 'language';
          const settled = (payload.settledDecisions || []).find(decision => decision.targetKey.endsWith('\u0000category'));
          return [
            { findings: [editFinding({ id: 'flip', segmentIds: [service], edits: [categoryEdit(value)] })] },
            ...(settled ? [{ findings: [editFinding({ id: 'flip-challenge', segmentIds: [service], challenge: { decisionId: settled.id, evidenceSegmentIds: [service] }, edits: [categoryEdit(value)] })] }] : []),
            { findings: [] },
          ];
        },
      });
      const rounds = result.snapshot.auditHistory.reduce((total, round) => total + (round.kind === 'folded' ? round.roundCount : 1), 0);
      assert(result.snapshot.status === 'approved' && rounds <= 4 && rounds === 2
        && finalSkill(result).category === 'programming language'
        && log.rejected.filter(item => item.task === 'career-profile-audit-skills').length === 2
        && log.calls.every(call => call.task !== 'career-profile-repair'),
      `the decision log must reject every re-litigation and approve by construction (rounds=${rounds})`);
      return { rounds };
    },
  },
  {
    name: 'career snapshot edits: a deterministic error goes to a minimal edit-repair that cannot touch an unrelated settled target',
    run: async () => {
      let claimEdit = null;
      const { result, log } = await runEditProtocol({
        audit: ({ lane, round, corpus: source }) => {
          const service = source.segments[3].id;
          if (lane === 'skills' && round === 0) return [{ findings: [editFinding({ segmentIds: [service], edits: [categoryEdit('programming language')] })] }];
          if (lane === 'coverage' && round === 1) {
            claimEdit = value => ({ op: 'set', group: 'achievements', entityId: 'p0001-achievement-service', field: 'claim', valueJson: JSON.stringify(value) });
            return [{ findings: [editFinding({ id: 'claim-wording', category: 'coverage', segmentIds: [service], entityIds: [], edits: [claimEdit('Invented outcome')] })] }];
          }
          return [{ findings: [] }];
        },
        repair: ({ prompt }) => {
          assert(prompt.includes('Return the minimal field-level edits') && !prompt.includes('Return one complete'), 'edit-repair must ask for edits, not a full shard');
          return [
            { edits: [categoryEdit('tool'), claimEdit('Built Python service used by 50 users.')], notes: 'also retune the category' },
            { edits: [claimEdit('Built Python service used by 50 users.')], notes: 'restore the literal source claim' },
          ];
        },
      });
      const repairs = log.calls.filter(call => call.phase === 'edit-repair');
      const repairRejections = log.rejected.filter(item => item.phase === 'edit-repair').map(item => item.message);
      const convergence = convergencePayloads(log);
      assert(repairs.length === 1 && repairs[0].task === 'career-profile-repair'
        && repairRejections.length === 1 && repairRejections[0].includes('may not change a settled target')
        && finalSkill(result).category === 'programming language'
        && result.profile.achievements[0].claim === 'Built Python service used by 50 users.'
        && convergence.length === 3 && convergence[2].editRepairs === 1 && convergence[2].deterministicErrors > 0 && convergence[2].findingsRejected === 1
        && convergence[1].editsApplied === 1 && convergence[1].editRepairs === 0,
      `the deterministic invented-claim error must be fixed by one edit-repair whose settled-target edit is rejected first (${repairRejections.join(' || ')}; ${canonicalJson(convergence)})`);
      return { repairs: repairs.length };
    },
  },
  {
    name: 'career snapshot edits: the contract bump keeps the prior contract pin-readable but not cache-readable',
    run: async () => {
      const previous = '2a819982e81b806e5ad0d919cf482532b01a52ed84c8eb94603c8f918b27888b';
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-career-snapshot-'));
      try {
        const corpus = buildCareerSourceCorpus(sourceFiles());
        const directory = path.join(root, 'career-snapshots');
        fs.mkdirSync(directory, { recursive: true });
        const snapshot = currentSnapshot(corpus, validProfile(corpus));
        snapshot.compilationContract = previous;
        snapshot.snapshotId = careerSnapshotIdForContract(corpus, previous);
        fs.writeFileSync(path.join(directory, `${snapshot.snapshotId}.json`), `${JSON.stringify(snapshot)}\n`, 'utf8');
        const pinned = await readPinnedCareerSnapshot(root, snapshot.snapshotId);
        const cached = await readCareerSnapshot(root, snapshot.snapshotId);
        assert(CAREER_SNAPSHOT_COMPILATION_CONTRACT !== previous && CAREER_SNAPSHOT_PINNED_LEGACY_V6_CONTRACTS.includes(previous)
          && !CAREER_SNAPSHOT_PINNED_LEGACY_V6_CONTRACTS.includes(CAREER_SNAPSHOT_COMPILATION_CONTRACT)
          && pinned?.snapshotId === snapshot.snapshotId && cached === null,
        'the edit-protocol contract must differ from the whole-page contract, which stays pin-readable only');
        return { pinned: true };
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'career snapshot edits: the final round decision log is validated strictly and a malformed log is rejected',
    run: async () => {
      const { result } = await runEditProtocol({
        audit: ({ lane, round, corpus: source }) => (lane === 'skills' && round === 0
          ? [{ findings: [editFinding({ segmentIds: [source.segments[3].id], edits: [categoryEdit('programming language')] })] }]
          : [{ findings: [] }]),
      });
      const log = finalDecisionLog(result);
      const withLog = snapshot => validateCurrentCareerSnapshot(snapshot).valid;
      const mutate = change => {
        const copy = structuredClone(result.snapshot);
        change(copy.auditHistory[copy.auditHistory.length - 1]);
        return copy;
      };
      const withoutLog = mutate(round => { delete round.decisionLog; });
      const wrongVersion = mutate(round => { round.decisionLog.version = 2; });
      const badIndex = mutate(round => { round.decisionLog.targets[0].pageIndex = '0'; });
      const extraKey = mutate(round => { round.decisionLog.extra = true; });
      const unsorted = mutate(round => { round.decisionLog.targets.push(structuredClone(round.decisionLog.targets[0])); });
      const badEvidence = mutate(round => { round.decisionLog.targets[0].consideredEvidenceSegmentIds = [7]; });
      assert(log.version === 1 && log.targets.length === 1 && log.targets[0].current.origin === 'audit'
        && withLog(result.snapshot) && withLog(withoutLog)
        && [wrongVersion, badIndex, extraKey, unsorted, badEvidence].every(snapshot => !withLog(snapshot)),
      'a present decision log must be exact while a final round without one still validates');
      return { targets: log.targets.length };
    },
  },
];

// ── Restored regression coverage under the edit protocol ──────────────────
const INTEGRATION_SKILL = 'p0001-skill-salesforce-integration';
const INTEGRATION_ACHIEVEMENT = 'p0001-achievement-billing';
const INTEGRATION_CLAIM = 'Built Python billing service with optional Salesforce integration for 50 users.';

function integrationFiles() {
  return pagedSourceFiles([
    'Ada Lovelace',
    'Integration Engineer at Acme in Toronto',
    'January 2020 to Present',
    INTEGRATION_CLAIM,
    'ada@example.test',
  ]).map(file => ({ ...file, contentHash: 'c'.repeat(64) }));
}

function integrationReferences(service, qualified) {
  return [
    {
      technology: 'Python', disposition: 'skill', relationship: 'independent', relationshipGroup: '',
      relationshipEvidence: 'Built Python billing service', evidenceSegmentIds: [service],
    },
    qualified
      ? {
        technology: 'Salesforce integration', disposition: 'skill', relationship: 'optional', relationshipGroup: 'optional-salesforce',
        relationshipEvidence: 'optional Salesforce integration', evidenceSegmentIds: [service],
      }
      : {
        technology: 'Salesforce integration', disposition: 'skill', relationship: 'independent', relationshipGroup: '',
        relationshipEvidence: 'Salesforce integration', evidenceSegmentIds: [service],
      },
  ];
}

// The incident's compile output: the optional integration was flattened into
// a direct, indexable skill with an independent ledger record.
function integrationProfile(corpus) {
  const evidence = corpus.segments.map(segment => segment.id);
  const service = corpus.segments[3].id;
  const entityIds = ['identity', 'role-acme', 'achievement-billing', 'skill-python', 'skill-salesforce-integration'];
  return pageTransport({
    identity: { name: 'Ada Lovelace', contacts: ['ada@example.test'], evidenceSegmentIds: evidence },
    roles: [{
      id: 'role-acme', title: 'Integration Engineer', employer: 'Acme', startDate: 'January 2020', endDate: 'Present', location: 'Toronto',
      achievementIds: ['achievement-billing'], skillIds: ['skill-python', 'skill-salesforce-integration'], evidenceSegmentIds: evidence,
    }],
    achievements: [{
      id: 'achievement-billing', roleId: 'role-acme', claim: INTEGRATION_CLAIM, technologies: ['Python', 'Salesforce integration'],
      technologyReferences: integrationReferences(service, false),
      metrics: [{ label: 'users', value: '50', unit: 'users', evidenceSegmentIds: [service] }], evidenceSegmentIds: evidence,
    }],
    projects: [],
    skills: [
      {
        id: 'skill-python', name: 'Python', category: 'language', capabilityKind: 'language', supportMode: 'direct',
        directEvidenceSegmentIds: [service], indexEligible: true, roleIds: ['role-acme'], evidenceSegmentIds: [service],
      },
      {
        id: 'skill-salesforce-integration', name: 'Salesforce integration', category: 'integration', capabilityKind: 'capability', supportMode: 'direct',
        directEvidenceSegmentIds: [service], indexEligible: true, roleIds: ['role-acme'], evidenceSegmentIds: [service],
      },
    ],
    education: [], certifications: [], otherEvidence: [],
    segmentCoverage: corpus.segments.map(segment => ({ segmentId: segment.id, disposition: 'achievement', entityIds })),
  });
}

function referencesEdit(references, entityId = INTEGRATION_ACHIEVEMENT) {
  return { op: 'set', group: 'achievements', entityId, field: 'technologyReferences', valueJson: JSON.stringify(references) };
}

function qualifyIntegrationEdits(service) {
  return [
    fieldEdit('supportMode', 'relationship-qualified', INTEGRATION_SKILL),
    fieldEdit('directEvidenceSegmentIds', [], INTEGRATION_SKILL),
    fieldEdit('indexEligible', false, INTEGRATION_SKILL),
    referencesEdit(integrationReferences(service, true)),
  ];
}

function directIntegrationEdits(service) {
  return [
    fieldEdit('supportMode', 'direct', INTEGRATION_SKILL),
    fieldEdit('directEvidenceSegmentIds', [service], INTEGRATION_SKILL),
    fieldEdit('indexEligible', true, INTEGRATION_SKILL),
    referencesEdit(integrationReferences(service, false)),
  ];
}

const INTEGRATION_TARGET_KEYS = [
  `achievements\u0000${INTEGRATION_ACHIEVEMENT}\u0000technologyReferences`,
  `skills\u0000${INTEGRATION_SKILL}\u0000directEvidenceSegmentIds`,
  `skills\u0000${INTEGRATION_SKILL}\u0000indexEligible`,
  `skills\u0000${INTEGRATION_SKILL}\u0000supportMode`,
];

function integrationFinding({ id, segmentIds, edits, challenge = NO_CHALLENGE, sourceQuote = 'optional Salesforce integration' }) {
  return {
    id, severity: 'blocker', category: 'skills', segmentIds, entityIds: [INTEGRATION_SKILL, INTEGRATION_ACHIEVEMENT],
    detail: 'The Salesforce integration is stated as optional, so it is relationship-qualified rather than direct experience.',
    edits, sourceQuote, challenge: structuredClone(challenge),
  };
}

function integrationState(result) {
  const skill = result.profile.skills.find(item => item.name === 'Salesforce integration');
  const reference = result.profile.achievements[0].technologyReferences.find(item => item.technology === 'Salesforce integration');
  return {
    supportMode: skill.supportMode, directEvidenceSegmentIds: skill.directEvidenceSegmentIds, indexEligible: skill.indexEligible,
    relationship: reference.relationship, relationshipGroup: reference.relationshipGroup, relationshipEvidence: reference.relationshipEvidence,
    boundToSkill: reference.skillId === skill.id,
  };
}

function integrationTargets(result) {
  return finalDecisionLog(result).targets
    .filter(target => INTEGRATION_TARGET_KEYS.includes(target.targetKey))
    .sort((left, right) => left.targetKey.localeCompare(right.targetKey));
}

const removeEdit = (group, entityId) => ({ op: 'remove', group, entityId, field: '', valueJson: '' });

function duplicateSkillPageShard(corpus, pageIndex) {
  if (pageIndex !== 2) return crossPageShard(corpus, pageIndex);
  const segmentId = corpus.segments[2].id;
  const claim = 'Built optional Python export for the billing team.';
  const achievement = {
    id: 'achievement-2', roleId: 'p0002-role-acme', claim, technologies: ['Python'],
    technologyReferences: [{
      technology: 'Python', disposition: 'skill', relationship: 'optional', relationshipGroup: 'optional-python',
      relationshipEvidence: 'optional Python export', evidenceSegmentIds: [segmentId],
    }],
    metrics: [], evidenceSegmentIds: [segmentId],
  };
  const skill = {
    id: 'skill-python-2', name: 'Python', category: 'language', capabilityKind: 'language', supportMode: 'relationship-qualified',
    directEvidenceSegmentIds: [], indexEligible: false, roleIds: ['p0002-role-acme'], evidenceSegmentIds: [segmentId],
  };
  return {
    ...emptyPageShard(segmentId), achievements: [achievement], skills: [skill],
    segmentCoverage: [{ segmentId, disposition: 'achievement', entityIds: ['identity', achievement.id, skill.id] }],
  };
}

function duplicateSkillFiles() {
  return pagedSourceFiles([
    'Ada Lovelace',
    'Software Engineer at Acme in Toronto from January 2020 to Present',
    'Built optional Python export for the billing team.',
    'Built Python report used by 60 users.',
  ]);
}

const PATCH_ROLE_COUNT = 101;

// Page schemas cap roles per page, so the live roles span two pages and the
// third page continues all of them (more patches than one page may carry).
const PATCH_ROLE_PAGES = [[0, 51], [51, PATCH_ROLE_COUNT]];
const patchRoleNames = ([start, end]) => Array.from({ length: end - start }, (_, offset) => `Role ${start + offset}`).join(' ');

function patchScopeFiles() {
  const all = patchRoleNames([0, PATCH_ROLE_COUNT]);
  return pagedSourceFiles([...PATCH_ROLE_PAGES.map(patchRoleNames), `${all} in Toronto`]).map(file => ({ ...file, contentHash: 'd'.repeat(64) }));
}

function scanLookup(prompt) {
  const open = '<UNTRUSTED_CAREER_ACTIVE_CONTEXT_LOOKUP>\n';
  const start = prompt.indexOf(open) + open.length;
  return JSON.parse(prompt.slice(start, prompt.indexOf('\n</UNTRUSTED_CAREER_ACTIVE_CONTEXT_LOOKUP>')));
}

function patchScopeCompile(corpus, pageIndex, prompt, options) {
  if (options.hints?.phase === 'active-context-scan') {
    const payload = scanLookup(prompt);
    const segmentId = payload.page.segments[0].id;
    return {
      activeStateDigest: payload.activeState.digest,
      contextPageDigest: payload.contextPage.digest,
      rolePatches: payload.contextPage.entries.filter(entry => entry.kind === 'roles').map(entry => ({
        targetId: entry.id, evidenceSegmentIds: [segmentId], updates: { title: entry.context.title },
      })),
      projectPatches: [],
    };
  }
  const segmentId = corpus.segments[pageIndex].id;
  if (pageIndex >= PATCH_ROLE_PAGES.length) return emptyPageShard(segmentId);
  const [start, end] = PATCH_ROLE_PAGES[pageIndex];
  const roles = Array.from({ length: end - start }, (_, offset) => ({
    id: `role-${start + offset}`, title: `Role ${start + offset}`, employer: '', startDate: '', endDate: '', location: '',
    achievementIds: [], skillIds: [], evidenceSegmentIds: [segmentId],
  }));
  return pageTransport({
    identity: { name: '', contacts: [], evidenceSegmentIds: [segmentId] },
    roles, achievements: [], projects: [], skills: [], education: [], certifications: [], otherEvidence: [],
    continuationState: { roles: { mode: pageIndex === 0 ? 'replace' : 'append', ids: roles.map(role => role.id) }, projects: { mode: 'inherit', ids: [] } },
    segmentCoverage: [{ segmentId, disposition: 'role-header', entityIds: ['identity', ...roles.map(role => role.id)] }],
  });
}

const restoredEditProtocolTests = [
  {
    name: 'career snapshot edits: the real incident — an optional integration skill is moved to relationship-qualified as one unit and an adversarial reversal on considered evidence is rejected every round',
    run: async () => {
      let settledGroupIds = [];
      const { result, log, corpus } = await runEditProtocol({
        files: integrationFiles(),
        compile: source => integrationProfile(source),
        audit: ({ lane, round, payload, corpus: source }) => {
          const service = source.segments[3].id;
          if (lane !== 'skills') return [{ findings: [] }];
          if (round === 0) return [{ findings: [integrationFinding({ id: 'optional-integration', segmentIds: [service], edits: qualifyIntegrationEdits(service) })] }];
          const settled = payload.settledDecisions.filter(decision => INTEGRATION_TARGET_KEYS.includes(decision.targetKey));
          settledGroupIds = settled.map(decision => decision.groupId);
          return [
            { findings: [integrationFinding({ id: 'reverse-unchallenged', segmentIds: [service], sourceQuote: 'Salesforce integration', edits: directIntegrationEdits(service) })] },
            { findings: [integrationFinding({ id: 'reverse-stale', segmentIds: [service], sourceQuote: 'Salesforce integration', challenge: { decisionId: settled[0].groupId, evidenceSegmentIds: [service] }, edits: directIntegrationEdits(service) })] },
            { findings: [] },
          ];
        },
      });
      const service = corpus.segments[3].id;
      const skillsCalls = log.calls.filter(call => call.task === 'career-profile-audit-skills').length;
      const skillsRejections = log.rejected.filter(item => item.task === 'career-profile-audit-skills');
      const targets = integrationTargets(result);
      nodeAssert.strictEqual(result.snapshot.status, 'approved');
      nodeAssert.ok(validateCurrentCareerSnapshot(result.snapshot).valid);
      nodeAssert.deepStrictEqual(integrationState(result), {
        supportMode: 'relationship-qualified', directEvidenceSegmentIds: [], indexEligible: false,
        relationship: 'optional', relationshipGroup: 'optional-salesforce', relationshipEvidence: 'optional Salesforce integration', boundToSkill: true,
      });
      nodeAssert.deepStrictEqual(targets.map(target => target.targetKey), INTEGRATION_TARGET_KEYS);
      nodeAssert.strictEqual(new Set(targets.map(target => target.current.groupId)).size, 1);
      nodeAssert.ok(/^group-[0-9a-f]{16}$/u.test(targets[0].current.groupId));
      nodeAssert.deepStrictEqual(targets.map(target => target.current.origin), ['audit', 'audit', 'audit', 'audit']);
      nodeAssert.deepStrictEqual(targets.map(target => target.current.valueJson), [
        canonicalJson(integrationReferences(service, true)), '[]', 'false', '"relationship-qualified"',
      ]);
      nodeAssert.deepStrictEqual(settledGroupIds, targets.map(target => target.current.groupId));
      nodeAssert.ok(skillsCalls >= 2);
      nodeAssert.strictEqual(skillsRejections.length, 2 * (skillsCalls - 1));
      nodeAssert.ok(skillsRejections.every((item, index) => (index % 2 === 0
        ? item.message.includes('skills finding reverse-unchallenged')
        : item.message.includes('skills finding reverse-stale') && item.message.includes('cites no new evidence'))),
      skillsRejections.map(item => item.message).join(' || '));
      nodeAssert.strictEqual(log.calls.filter(call => call.task === 'career-profile-repair').length, 0);
      nodeAssert.strictEqual(convergencePayloads(log)[0].editsApplied, 4);
      return { skillsCalls, rejections: skillsRejections.length };
    },
  },
  {
    name: 'career snapshot edits: the real incident — a groupId challenge citing a new page segment is adjudicated once and its change ruling applies every reverse edit together',
    run: async () => {
      let firstGroupId = '';
      const { result, log, corpus } = await runEditProtocol({
        files: integrationFiles(),
        compile: source => integrationProfile(source),
        audit: ({ lane, round, payload, corpus: source }) => {
          const service = source.segments[3].id;
          if (lane !== 'skills') return [{ findings: [] }];
          if (round === 0) return [{ findings: [integrationFinding({ id: 'optional-integration', segmentIds: [service], edits: qualifyIntegrationEdits(service) })] }];
          if (round !== 1) return [{ findings: [] }];
          firstGroupId = payload.settledDecisions.find(decision => INTEGRATION_TARGET_KEYS.includes(decision.targetKey)).groupId;
          return [
            { findings: [integrationFinding({ id: 'reverse-stale', segmentIds: [service], sourceQuote: 'Salesforce integration', challenge: { decisionId: firstGroupId, evidenceSegmentIds: [service] }, edits: directIntegrationEdits(service) })] },
            { findings: [integrationFinding({ id: 'reverse-new-evidence', segmentIds: [service], sourceQuote: 'Salesforce integration', challenge: { decisionId: firstGroupId, evidenceSegmentIds: [source.segments[1].id] }, edits: directIntegrationEdits(service) })] },
          ];
        },
        adjudicate: ({ corpus: source }) => [{
          ruling: 'change', valueJson: JSON.stringify(directIntegrationEdits(source.segments[3].id)),
          rationale: 'The integration role establishes direct integration work.', sourceQuote: 'Salesforce integration', evidenceSegmentIds: [source.segments[3].id],
        }],
      });
      const service = corpus.segments[3].id;
      const adjudications = log.calls.filter(call => call.phase === 'adjudication');
      nodeAssert.strictEqual(adjudications.length, 1);
      nodeAssert.strictEqual(adjudications[0].task, 'career-profile-repair');
      const input = adjudicationPayload(adjudications[0].prompt);
      nodeAssert.deepStrictEqual(input.proposals.map(proposal => proposal.findingId), ['reverse-new-evidence']);
      nodeAssert.strictEqual(input.targets.length, 4);
      nodeAssert.deepStrictEqual(input.currentDecisions.map(decision => decision.groupId), [firstGroupId, firstGroupId, firstGroupId, firstGroupId]);
      nodeAssert.strictEqual(log.rejected.filter(item => item.task === 'career-profile-audit-skills').length, 1);
      nodeAssert.strictEqual(log.calls.filter(call => call.phase === 'edit-repair').length, 0);
      nodeAssert.strictEqual(result.snapshot.status, 'approved');
      nodeAssert.deepStrictEqual(integrationState(result), {
        supportMode: 'direct', directEvidenceSegmentIds: [service], indexEligible: true,
        relationship: 'independent', relationshipGroup: '', relationshipEvidence: 'Salesforce integration', boundToSkill: true,
      });
      const targets = integrationTargets(result);
      nodeAssert.deepStrictEqual(targets.map(target => target.targetKey), INTEGRATION_TARGET_KEYS);
      nodeAssert.strictEqual(new Set(targets.map(target => target.current.groupId)).size, 1);
      nodeAssert.notStrictEqual(targets[0].current.groupId, firstGroupId);
      nodeAssert.deepStrictEqual(targets.map(target => target.supersededDecisionIds.length), [1, 1, 1, 1]);
      nodeAssert.deepStrictEqual(targets.map(target => target.current.valueJson), [
        canonicalJson(integrationReferences(service, false)), JSON.stringify([service]), 'true', '"direct"',
      ]);
      return { adjudications: adjudications.length };
    },
  },
  {
    name: 'career snapshot edits: a cross-category observation is recorded under the invoked lane in receipts and decisions',
    run: async () => {
      const settledSeenByLane = {};
      const { result, log } = await runEditProtocol({
        audit: ({ lane, round, payload, corpus: source }) => {
          if (round === 1) settledSeenByLane[lane] = payload.settledDecisions.map(decision => [decision.targetKey, decision.origin, decision.valueJson]);
          return lane === 'metrics' && round === 0
            ? [{ findings: [editFinding({ id: 'other-lane', category: 'conflict', segmentIds: [source.segments[3].id], edits: [categoryEdit('programming language')] })] }]
            : [{ findings: [] }];
        },
      });
      const targetKey = `skills\u0000${EDIT_SKILL}\u0000category`;
      const decision = finalDecisionLog(result).targets.find(target => target.targetKey === targetKey);
      const [convergence] = convergencePayloads(log);
      // The round receipt (convergence progress) and the settled ledger both
      // record the finding under the invoked metrics lane, never 'conflict'.
      nodeAssert.deepStrictEqual(convergence.byCategory, { metrics: { blocker: 0, warning: 1 } });
      nodeAssert.deepStrictEqual([convergence.editsApplied, convergence.findingsRejected, convergence.adjudications], [1, 0, 0]);
      nodeAssert.deepStrictEqual([decision.current.category, decision.current.origin, decision.current.valueJson], ['metrics', 'audit', '"programming language"']);
      nodeAssert.deepStrictEqual(Object.keys(settledSeenByLane).sort(), EDIT_LANES.map(([lane]) => lane).sort());
      nodeAssert.ok(Object.values(settledSeenByLane).every(entries => canonicalJson(entries) === canonicalJson([[targetKey, 'audit', '"programming language"']])), canonicalJson(settledSeenByLane));
      nodeAssert.strictEqual(log.rejected.length, 0);
      nodeAssert.strictEqual(finalSkill(result).category, 'programming language');
      return { byCategory: convergence.byCategory };
    },
  },
  {
    name: 'career snapshot edits: an unreconcilable same-name skill is edit-repaired only on the page whose row is redundant',
    run: async () => {
      const ownedPages = __ownedDeterministicFindingsForTests(
        ['skills[p0003-skill-python-2].name duplicates the Unicode/case-insensitive skill name used by skills[p0004-skill-python-3].'],
        1, partitionCareerSourcePages(buildCareerSourceCorpus(duplicateSkillFiles()), { maxSegments: 1, maxSourceChars: 1 }),
      ).map(finding => finding.pageIndex);
      const { result, log } = await runEditProtocol({
        files: duplicateSkillFiles(),
        pageMaxSegments: 1,
        compile: (source, pageIndex) => duplicateSkillPageShard(source, pageIndex),
        repair: () => [{ edits: [removeEdit('skills', 'p0003-skill-python-2')], notes: 'The direct Python row on the later page subsumes this optional row.' }],
      });
      const repairs = log.calls.filter(call => call.phase === 'edit-repair');
      nodeAssert.deepStrictEqual(ownedPages, [2]);
      nodeAssert.deepStrictEqual(repairs.map(call => [call.task, call.pageIndex]), [['career-profile-repair', 2]]);
      nodeAssert.strictEqual(log.rejected.length, 0);
      nodeAssert.strictEqual(result.snapshot.status, 'approved');
      const skills = result.profile.skills.map(skill => [skill.id, skill.name, skill.supportMode, skill.indexEligible]);
      nodeAssert.deepStrictEqual(skills, [['p0004-skill-python-3', 'Python', 'direct', true]]);
      const optionalReference = result.profile.achievements.find(item => item.id === 'p0003-achievement-2').technologyReferences[0];
      nodeAssert.deepStrictEqual([optionalReference.relationship, optionalReference.skillId], ['optional', 'p0004-skill-python-3']);
      return { repairs: repairs.length };
    },
  },
  {
    name: 'career snapshot edits: every host-merged patch scope is audited for all six lanes and a rolePatches edit addressed by targetId is applied and settled',
    run: async () => {
      let fixed = null;
      const { result, log, corpus } = await runEditProtocol({
        files: patchScopeFiles(),
        pageMaxSegments: 1,
        compile: patchScopeCompile,
        audit: ({ lane, round, scopeKind, scopeIndex, prompt, corpus: source }) => {
          if (lane !== 'attribution' || round !== 0 || scopeKind !== 'host-merged-patches' || fixed) return [{ findings: [] }];
          if (!prompt.includes('"targetId":"p0001-role-0"')) return [{ findings: [] }];
          fixed = { scopeIndex };
          return [{ findings: [{
            id: 'role-location', severity: 'warning', category: 'attribution', segmentIds: [source.segments[2].id], entityIds: ['p0001-role-0'],
            detail: 'The continuation states the role location.', sourceQuote: 'in Toronto', challenge: structuredClone(NO_CHALLENGE),
            edits: [{ op: 'set', group: 'rolePatches', entityId: 'p0001-role-0', field: 'updates', valueJson: JSON.stringify({ title: 'Role 0', location: 'Toronto' }) }],
          }] }];
        },
      });
      const patchAudits = log.calls.filter(call => EDIT_LANE_BY_TASK.has(call.task) && call.options.hints.auditScopeKind === 'host-merged-patches');
      const scopeIndexes = [...new Set(patchAudits.map(call => call.options.hints.auditScopeIndex))].sort((a, b) => a - b);
      const lanesByScope = scopeIndexes.map(index => [...new Set(patchAudits
        .filter(call => call.options.hints.auditScopeIndex === index).map(call => EDIT_LANE_BY_TASK.get(call.task)))].sort());
      nodeAssert.ok(fixed, 'a patch scope must carry the role-0 patch');
      nodeAssert.ok(scopeIndexes.length >= 2, `patch scopes=${scopeIndexes.length}`);
      const allLanes = EDIT_LANES.map(([lane]) => lane).sort();
      nodeAssert.ok(lanesByScope.every(lanes => canonicalJson(lanes) === canonicalJson(allLanes)), canonicalJson(lanesByScope));
      const perScopeLaneCounts = scopeIndexes.flatMap(index => allLanes.map(lane => patchAudits
        .filter(call => call.options.hints.auditScopeIndex === index && EDIT_LANE_BY_TASK.get(call.task) === lane).length));
      nodeAssert.strictEqual(new Set(perScopeLaneCounts).size, 1, canonicalJson(perScopeLaneCounts));
      const role = result.profile.roles.find(item => item.id === 'p0001-role-0');
      nodeAssert.deepStrictEqual([role.title, role.location], ['Role 0', 'Toronto']);
      nodeAssert.ok(role.evidenceSegmentIds.includes(corpus.segments[2].id));
      const decision = finalDecisionLog(result).targets.find(target => target.targetKey === 'rolePatches\u0000p0001-role-0\u0000updates');
      nodeAssert.deepStrictEqual([decision.pageIndex, decision.current.origin, decision.current.category, decision.current.valueJson],
        [2, 'audit', 'attribution', canonicalJson({ title: 'Role 0', location: 'Toronto' })]);
      nodeAssert.strictEqual(log.calls.filter(call => call.task === 'career-profile-repair').length, 0);
      nodeAssert.strictEqual(result.snapshot.status, 'approved');
      return { patchScopes: scopeIndexes.length };
    },
  },
];

export default [
  ...editProtocolTests,
  ...restoredEditProtocolTests,
  {
    name: 'career snapshot: a deterministic finding goes to the page that owns its cited segment, not to the page whose id a merged skill kept',
    run: () => {
      const pages = [
        { index: 0, segmentIds: ['segment-0001', 'segment-0002'] },
        { index: 1, segmentIds: ['segment-0003', 'segment-0004'] },
      ];
      const owners = detail => __ownedDeterministicFindingsForTests([detail], 0, pages).map(finding => finding.pageIndex);
      // Page two's evidence was reconciled into page one's skill id; only page two can reread segment-0004.
      const merged = owners('skills[p0001-skill-react].directEvidenceSegmentIds segment-0004 shares relationship-qualified evidence but has no whole-term skill occurrence outside every literal relationshipEvidence slice.');
      assert(merged.length === 1 && merged[0] === 1, `a merged skill's foreign-page evidence finding is owned by the evidence page only (got ${merged})`);
      const entityOnly = owners('roles[p0001-role-acme].skillIds links skill p0002-skill-react whose roleIds omit p0001-role-acme.');
      assert(entityOnly.length === 2 && entityOnly.includes(0) && entityOnly.includes(1), 'with no cited segment, every named entity page still owns the finding');
      const duplicate = owners('skills[p0002-skill-react].name duplicates the Unicode/case-insensitive skill name used by skills[p0001-skill-react].');
      assert(duplicate.length === 1 && duplicate[0] === 1, 'a duplicate-name finding stays with the redundant row');
    },
  },
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
            assert(Array.isArray(domainRejection.correctionDetails) && domainRejection.correctionDetails.length >= 1
              && domainRejection.correctionDetails.length <= 12
              && domainRejection.correctionDetails.every(line => typeof line === 'string' && domainRejection.message.includes(line))
              && !duplicateCoverageRejection.correctionDetails.some(line => line.includes('invented-model-entity')),
            'a page rejection carries its exact failing rules for the answering chat, and nothing its own message does not say');
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
        'Used Cedar or Juniper SDK based on deployment constraints.\n',
        'Maintained Spruce tooling for on-call diagnosis.\n',
        "Published Orchard telemetry feed through the public Gateway API using the Agency's daily bulletins for analysts.\n",
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
      const relation = segment('Used Cedar or Juniper SDK');
      const direct = segment('Maintained Spruce tooling');
      const artifact = segment('Published Orchard telemetry feed');
      const contact = segment('ada@example.test');
      const relationEvidence = 'Used Cedar or Juniper SDK based on deployment constraints.';
      const directEvidence = 'Maintained Spruce tooling for on-call diagnosis.';
      const artifactEvidence = "Published Orchard telemetry feed through the public Gateway API using the Agency's daily bulletins for analysts.";
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
          id: 'achievement-feed', roleId: 'role-maple', claim: artifactEvidence, technologies: ['Orchard telemetry feed', 'Gateway API', "Agency's daily bulletins"], metrics: [], evidenceSegmentIds: [artifact],
          technologyReferences: [
            { technology: 'Orchard telemetry feed', disposition: 'non-skill', relationship: 'independent', relationshipGroup: '', relationshipEvidence: 'Orchard telemetry feed', evidenceSegmentIds: [artifact], nonSkillReason: 'A published data feed is an output, not a candidate capability.' },
            { technology: 'Gateway API', disposition: 'non-skill', relationship: 'independent', relationshipGroup: '', relationshipEvidence: 'Gateway API', evidenceSegmentIds: [artifact], nonSkillReason: 'A public interface owned by another organization is a source endpoint, not candidate capability evidence.' },
            { technology: "Agency's daily bulletins", disposition: 'non-skill', relationship: 'independent', relationshipGroup: '', relationshipEvidence: "Agency's daily bulletins", evidenceSegmentIds: [artifact], nonSkillReason: 'Organization-produced data is an external output, not a candidate capability.' },
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
        && projection.includes('Relationship evidence [Achievement ID: achievement-choice]: Used Cedar or Juniper SDK based on deployment constraints.')
        && !projection.includes('- Cedar [Skill ID: skill-cedar]')
        && !projection.includes('- Juniper [Skill ID: skill-juniper]')
        && projection.includes('- Spruce [Skill ID: skill-spruce]')
        && !catalog.some(item => /^host\.career\.skill\.(?:skill-cedar|skill-juniper)\./u.test(item.id))
        && catalog.some(item => /^host\.career\.skill\.skill-spruce\./u.test(item.id))
        && catalog.some(item => item.id.startsWith('host.career.achievement.achievement-choice.') && item.quote.includes('Usage relationship'))
        && !profile.skills.some(skill => ['Gateway API', "Agency's daily bulletins"].includes(skill.name))
        && !validateCareerProfile(relationAsBareDirect, corpus).valid
        && !validateCareerProfile(missingDisposition, corpus).valid
        && !validateCareerProfile(missingExternalDisposition, corpus).valid
        && compilePrompt.includes('not as a token rule')
        && compilePrompt.includes('interacts with, consumes, connects to, automates, or access-controls')
        && compilePrompt.includes('separate bounded capability skill')
        && compilePrompt.includes('organization-owned system')
        && compilePrompt.includes('semantic completeness')
        && !compilePrompt.includes('For EVERY technology/tool candidate label')
        && compilePrompt.includes('data feed/dataset')
        && auditPrompt.includes('not a deterministic token checklist')
        && auditPrompt.includes('interacts with, consumes, connects to, automates, or access-controls')
        && auditPrompt.includes('A non-skill requires positive source semantics')
        && auditPrompt.includes('do not assume the existing technologies array is complete')
        && auditPrompt.includes('organization-owned system')
        && auditPrompt.includes('Audit EVERY skill row')
        && pagePrompt.includes('keep that group self-contained')
        && pagePrompt.includes('separate bounded capability skill')
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
        const leaf = path.join(root, 'career-snapshots', `${snapshot.snapshotId}.json`);
        // Use a timestamp the platform can restore exactly through utimes;
        // Linux-created mtimes may carry nanoseconds that its double-based
        // utimes API cannot reproduce after the intentional in-place write.
        await fs.promises.utimes(leaf, 1_700_000_000, 1_700_000_000);
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
    name: 'career snapshot: only retained prior v6 contracts remain pin-readable after a current contract bump',
    run: async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-career-snapshot-'));
      try {
        const corpus = buildCareerSourceCorpus(sourceFiles());
        const directory = path.join(root, 'career-snapshots');
        fs.mkdirSync(directory, { recursive: true });
        const retainedSnapshots = [];
        for (const priorContract of CAREER_SNAPSHOT_PINNED_LEGACY_V6_CONTRACTS) {
          const snapshot = currentSnapshot(corpus, validProfile(corpus));
          snapshot.compilationContract = priorContract;
          snapshot.snapshotId = careerSnapshotIdForContract(corpus, priorContract);
          fs.writeFileSync(path.join(directory, `${snapshot.snapshotId}.json`), `${JSON.stringify(snapshot)}\n`, 'utf8');
          retainedSnapshots.push(snapshot);
        }
        const oldV6Pinned = await Promise.all(retainedSnapshots.map(snapshot => readPinnedCareerSnapshot(root, snapshot.snapshotId)));
        const currentCacheRejected = (await Promise.all(retainedSnapshots.map(snapshot => readCareerSnapshot(root, snapshot.snapshotId))))
          .every(snapshot => snapshot === null);
        const snapshot = retainedSnapshots[0];

        // An arbitrary prior-looking v6 digest cannot turn a same-shape file
        // into historical data; the allow-list is contract-bound, not merely
        // schema-bound.
        const unknownContract = 'f'.repeat(64);
        const unknown = { ...snapshot, compilationContract: unknownContract, snapshotId: careerSnapshotIdForContract(corpus, unknownContract) };
        fs.writeFileSync(path.join(directory, `${unknown.snapshotId}.json`), `${JSON.stringify(unknown)}\n`, 'utf8');
        const arbitraryV6Rejected = await readPinnedCareerSnapshot(root, unknown.snapshotId) === null;

        // A retained contract does not waive the complete paged audit chain.
        const malformed = { ...snapshot, auditHistory: [] };
        fs.writeFileSync(path.join(directory, `${snapshot.snapshotId}.json`), `${JSON.stringify(malformed)}\n`, 'utf8');
        const malformedRetainedV6Rejected = await readPinnedCareerSnapshot(root, snapshot.snapshotId) === null;
        assert(oldV6Pinned.every((pinned, index) => pinned?.snapshotId === retainedSnapshots[index].snapshotId)
          && CAREER_SNAPSHOT_PINNED_LEGACY_V6_CONTRACTS.includes('a526f744741d46de51478c5799268bcc1bb1ef2c182472599c9410533c46306b')
          && currentCacheRejected && arbitraryV6Rejected && malformedRetainedV6Rejected,
        'a finite prior-v6 contract allow-list preserves existing card pins while fresh cache reads, arbitrary v6 contracts, and malformed retained records remain rejected');
        return { priorV6Pinned: oldV6Pinned.length, currentCacheRejected, arbitraryV6Rejected, malformedRetainedV6Rejected };
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
