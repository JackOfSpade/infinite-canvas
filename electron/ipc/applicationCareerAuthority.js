import crypto from 'node:crypto';
import { approvedCareerEvidenceCatalog, CAREER_SNAPSHOT_STATUS_APPROVED, isCareerSkillIndexEligible, projectLegacyCareerProfile, vettedCareerSkillInventory } from './careerSnapshot.js';

const privateState = new WeakMap();

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function requiredId(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} needs a stable nonempty id.`);
  return value.trim();
}

function uniqueMap(items, key, label) {
  const map = new Map();
  for (const item of items || []) {
    const id = requiredId(item?.[key], label);
    if (map.has(id)) throw new Error(`${label} contains duplicate id ${JSON.stringify(id)}.`);
    map.set(id, deepFreeze(structuredClone(item)));
  }
  return map;
}

function assertUniqueIndexEligibleSkillNames(skills) {
  const names = new Map();
  for (const skill of skills.values()) {
    // A qualified choice/condition is relation-aware evidence only; it cannot
    // participate in the bare ATS/skills inventory or its collision set.
    if (!isCareerSkillIndexEligible(skill)) continue;
    const normalized = String(skill.name || '').trim().normalize('NFKC').toLowerCase();
    if (!normalized) throw new Error(`Approved skill ${JSON.stringify(skill.id)} has no stable name.`);
    if (names.has(normalized)) throw new Error(`Approved skills ${JSON.stringify(names.get(normalized))} and ${JSON.stringify(skill.id)} collide by exact application skill name.`);
    names.set(normalized, skill.id);
  }
}

// A v6 profile carries an explicit support classification. Its application
// authority must not retain a resolver path to relationship-only or otherwise
// non-indexable labels: a caller that already knows the opaque ID could
// otherwise bypass the catalog's direct-only skill rows. Historical profiles
// intentionally lack this metadata and retain their frozen compatibility map.
function profileUsesCurrentSkillSupport(profile) {
  return (profile?.skills || []).some(skill => (
    skill?.capabilityKind != null || skill?.supportMode != null || skill?.directEvidenceSegmentIds != null
  ));
}

function applicationAuthoritySkills(profile, allSkillsById) {
  if (!profileUsesCurrentSkillSupport(profile)) return allSkillsById;
  const inventoryIds = new Set(vettedCareerSkillInventory(profile, { allowHistorical: false }).map(skill => skill.id));
  return new Map([...allSkillsById].filter(([id]) => inventoryIds.has(id)));
}

function assertNoEntityIdCollisions(entityMaps) {
  const owners = new Map();
  for (const [kind, entities] of Object.entries(entityMaps)) {
    for (const id of entities.keys()) {
      if (owners.has(id)) throw new Error(`Approved entity id ${JSON.stringify(id)} collides between ${owners.get(id)} and ${kind}.`);
      owners.set(id, kind);
    }
  }
}

function catalogMeta(id) {
  // Catalog IDs are an authority namespace, not an unstructured hint.  Keep
  // the exact grammar here so a future catalog producer cannot accidentally
  // turn a prefix collision into a valid evidence reference.
  const match = /^host\.career\.(role|achievement|project|skill|education|certification|other)\.([a-z][a-z0-9-]{0,79})\.(?:[1-9]\d*)(?:\.[1-9]\d*)?$/u.exec(id);
  if (!match) throw new Error(`authority catalog id ${JSON.stringify(id)} has an unrecognized namespace.`);
  return { kind: match[1], entityId: match[2] };
}

function sourceRoles(profile) {
  const legacy = projectLegacyCareerProfile(profile);
  return (legacy.workHistory || []).map((role, index) => ({
    id: String(role?.id || `source-role-${index + 1}`), title: String(role?.title || ''),
    company: String(role?.employer || ''), dates: [role?.startDate, role?.endDate].filter(Boolean).join(' – '), location: String(role?.location || ''),
  }));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function stateOf(authority) {
  const state = privateState.get(authority);
  if (!state) throw new Error('A built application career authority is required.');
  return state;
}

/** Build a compact, immutable, structured authority for application validators. */
export function buildApplicationCareerAuthority(snapshot) {
  if (!snapshot || snapshot.status !== CAREER_SNAPSHOT_STATUS_APPROVED || !snapshot.profile) throw new Error('An approved snapshot is required.');
  const profile = snapshot.profile;
  const rolesById = uniqueMap(profile.roles, 'id', 'snapshot roles');
  const projectsById = uniqueMap(profile.projects, 'id', 'snapshot projects');
  const allSkillsById = uniqueMap(profile.skills, 'id', 'snapshot skills');
  const skillsById = applicationAuthoritySkills(profile, allSkillsById);
  assertUniqueIndexEligibleSkillNames(skillsById);
  const achievementsById = uniqueMap(profile.achievements, 'id', 'snapshot achievements');
  const educationById = uniqueMap(profile.education, 'id', 'snapshot education');
  const certificationsById = uniqueMap(profile.certifications, 'id', 'snapshot certifications');
  const otherEvidenceById = uniqueMap(profile.otherEvidence, 'id', 'snapshot other evidence');
  // Keep the full profile in the ID-integrity check even when a current
  // relationship-only skill is deliberately absent from application authority.
  // Filtering must not make a malformed cross-entity ID collision disappear.
  const allEntityMaps = { role: rolesById, achievement: achievementsById, project: projectsById, skill: allSkillsById, education: educationById, certification: certificationsById, other: otherEvidenceById };
  assertNoEntityIdCollisions(allEntityMaps);
  const entityMaps = { role: rolesById, achievement: achievementsById, project: projectsById, skill: skillsById, education: educationById, certification: certificationsById, other: otherEvidenceById };
  const catalogById = new Map();
  for (const raw of approvedCareerEvidenceCatalog(snapshot)) {
    const id = requiredId(raw?.id, 'authority catalog evidence');
    if (catalogById.has(id)) throw new Error(`authority catalog collision for ${JSON.stringify(id)}.`);
    if (raw?.sourceId !== 'career-data' || typeof raw?.quote !== 'string' || !raw.quote) throw new Error(`authority catalog ${JSON.stringify(id)} is malformed.`);
    const meta = catalogMeta(id);
    if (!entityMaps[meta.kind]?.has(meta.entityId)) throw new Error(`authority catalog ${JSON.stringify(id)} references an unknown ${meta.kind} entity.`);
    catalogById.set(id, Object.freeze({ id, sourceId: raw.sourceId, quote: raw.quote, ...meta }));
  }
  // Application identity is host-owned, but education is not an identity
  // decoration. Selecting the first completed degree by source order both
  // duplicates the first-class Education section and hides a later degree
  // whose evidence actually matched this job. The authority selection phase
  // ranks education records from exhaustive requirement matches instead.
  const identity = deepFreeze({
    name: String(profile.identity?.name || ''), contact: Object.freeze([...(profile.identity?.contacts || [])].map(String)),
  });
  const roles = sourceRoles(profile);
  const authority = {
    snapshotId: String(snapshot.snapshotId || ''), identity, sourceRoles: Object.freeze(roles.map(deepFreeze)),
    digests: Object.freeze({ snapshot: digest(snapshot), catalog: digest([...catalogById.values()]), sourceRoles: digest(roles), skills: digest(profile.skills || []) }),
    // Small immutable projections make education/certification selectable by
    // the application authority without exposing the mutable snapshot profile.
    sourceEducation: Object.freeze([...educationById.values()].map(deepFreeze)),
    sourceCertifications: Object.freeze([...certificationsById.values()].map(deepFreeze)),
    counts: Object.freeze({ catalog: catalogById.size, roles: rolesById.size, projects: projectsById.size, skills: skillsById.size, education: educationById.size, certifications: certificationsById.size }),
  };
  privateState.set(authority, { rolesById, projectsById, skillsById, achievementsById, educationById, certificationsById, catalogById });
  return Object.freeze(authority);
}

export function resolveAuthorityEvidence(authority, id, quote = undefined) {
  const unit = stateOf(authority).catalogById.get(id);
  if (!unit) throw new Error(`Unknown authority evidence id ${JSON.stringify(id)}.`);
  if (quote !== undefined && quote !== unit.quote) throw new Error(`Authority evidence ${JSON.stringify(id)} quote does not exactly match its approved catalog entry.`);
  return unit;
}

export function resolveAuthorityRole(authority, id) {
  const role = stateOf(authority).rolesById.get(id);
  if (!role) throw new Error(`Unknown authority role ${JSON.stringify(id)}.`);
  return role;
}

export function resolveAuthorityProject(authority, id) {
  const project = stateOf(authority).projectsById.get(id);
  if (!project) throw new Error(`Unknown authority project ${JSON.stringify(id)}.`);
  return project;
}

export function resolveAuthoritySkill(authority, id) {
  const skill = stateOf(authority).skillsById.get(id);
  if (!skill) throw new Error(`Unknown authority skill ${JSON.stringify(id)}.`);
  return skill;
}

export function resolveAuthorityEducation(authority, id) {
  const education = stateOf(authority).educationById.get(id);
  if (!education) throw new Error(`Unknown authority education ${JSON.stringify(id)}.`);
  return education;
}

export function resolveAuthorityCertification(authority, id) {
  const certification = stateOf(authority).certificationsById.get(id);
  if (!certification) throw new Error(`Unknown authority certification ${JSON.stringify(id)}.`);
  return certification;
}

export function validateAuthorityRoleEvidence(authority, roleId, evidenceIds) {
  const state = stateOf(authority);
  if (!Array.isArray(evidenceIds) || !evidenceIds.length) throw new Error('Role evidence must be nonempty.');
  const role = resolveAuthorityRole(authority, roleId);
  for (const id of evidenceIds || []) {
    const unit = resolveAuthorityEvidence(authority, id);
    if (unit.kind === 'achievement' && state.achievementsById.get(unit.entityId)?.roleId === roleId && (role.achievementIds || []).includes(unit.entityId)) continue;
    if (unit.kind === 'skill' && (state.skillsById.get(unit.entityId)?.roleIds || []).includes(roleId) && (role.skillIds || []).includes(unit.entityId)) continue;
    // Header-only role records restate fields already rendered. They are legal
    // only when this role genuinely carries no substantive linked evidence.
    if (unit.kind === 'role' && unit.entityId === roleId && ![...state.achievementsById.values()].some(item => item.roleId === roleId)
      && ![...state.skillsById.values()].some(item => (item.roleIds || []).includes(roleId))) continue;
    throw new Error(`Authority evidence ${JSON.stringify(id)} does not belong to role ${JSON.stringify(roleId)}.`);
  }
  return role;
}

export function validateAuthorityProjectEvidence(authority, projectId, evidenceIds) {
  if (!Array.isArray(evidenceIds) || !evidenceIds.length) throw new Error('Project evidence must be nonempty.');
  const project = resolveAuthorityProject(authority, projectId);
  for (const id of evidenceIds || []) {
    const unit = resolveAuthorityEvidence(authority, id);
    if (unit.kind !== 'project' || unit.entityId !== projectId) throw new Error(`Authority evidence ${JSON.stringify(id)} does not belong to project ${JSON.stringify(projectId)}.`);
  }
  return project;
}

function validateAuthorityEntityEvidence(authority, entityId, evidenceIds, kind, resolve) {
  if (!Array.isArray(evidenceIds) || !evidenceIds.length) throw new Error(`${kind} evidence must be nonempty.`);
  const entity = resolve(authority, entityId);
  for (const id of evidenceIds) {
    const unit = resolveAuthorityEvidence(authority, id);
    if (unit.kind !== kind || unit.entityId !== entityId) throw new Error(`Authority evidence ${JSON.stringify(id)} does not belong to ${kind} ${JSON.stringify(entityId)}.`);
  }
  return entity;
}

export function validateAuthorityEducationEvidence(authority, educationId, evidenceIds) {
  return validateAuthorityEntityEvidence(authority, educationId, evidenceIds, 'education', resolveAuthorityEducation);
}

export function validateAuthorityCertificationEvidence(authority, certificationId, evidenceIds) {
  return validateAuthorityEntityEvidence(authority, certificationId, evidenceIds, 'certification', resolveAuthorityCertification);
}

export function validateAuthoritySkill(authority, skillId, name, evidenceIds) {
  if (!Array.isArray(evidenceIds) || !evidenceIds.length) throw new Error('Skill evidence must be nonempty.');
  const skill = resolveAuthoritySkill(authority, skillId);
  if (skill.name !== name || !isCareerSkillIndexEligible(skill)) throw new Error(`Skill ${JSON.stringify(skillId)} is not an exact index-eligible approved skill.`);
  for (const id of evidenceIds || []) {
    const unit = resolveAuthorityEvidence(authority, id);
    if (unit.kind !== 'skill' || unit.entityId !== skillId) throw new Error(`Authority evidence ${JSON.stringify(id)} does not belong to skill ${JSON.stringify(skillId)}.`);
  }
  return skill;
}

export function validateAuthoritySkillGroup(authority, items, evidenceIds) {
  if (!Array.isArray(items) || !items.length) throw new Error('Skill group items must be nonempty.');
  if (!Array.isArray(evidenceIds) || !evidenceIds.length) throw new Error('Skill group evidence must be nonempty.');
  const state = stateOf(authority);
  const selected = new Map();
  for (const name of items) {
    const matching = [...state.skillsById.values()].find(skill => skill.name === name && isCareerSkillIndexEligible(skill));
    if (!matching) throw new Error(`Skill item ${JSON.stringify(name)} is not an exact index-eligible approved skill.`);
    selected.set(matching.id, matching);
  }
  const bySkill = new Map([...selected.keys()].map(id => [id, []]));
  for (const id of evidenceIds) {
    const unit = resolveAuthorityEvidence(authority, id);
    if (unit.kind !== 'skill' || !selected.has(unit.entityId)) throw new Error(`Authority evidence ${JSON.stringify(id)} does not belong to this skill group.`);
    bySkill.get(unit.entityId).push(id);
  }
  for (const skill of selected.values()) validateAuthoritySkill(authority, skill.id, skill.name, bySkill.get(skill.id));
}

export function validateAuthorityIdentityAndLocation(authority, identity, roleId, location) {
  if (identity?.name !== authority?.identity?.name || canonical(identity?.contact || []) !== canonical(authority.identity.contact)) throw new Error('Identity does not exactly match approved authority identity.');
  if (identity?.credential !== authority.identity.credential) throw new Error('Identity credential does not exactly match approved authority identity.');
  // The current host identity projection intentionally has no subtitle.  Do
  // not let a caller add one merely because a downstream schema permits it.
  if (identity?.subtitleRole !== undefined) throw new Error('Identity subtitleRole is not approved by authority identity.');
  const role = resolveAuthorityRole(authority, roleId);
  if (String(location ?? '') !== String(role.location || '')) throw new Error(`Role ${JSON.stringify(roleId)} location does not exactly match approved authority.`);
}

export function authorityCareerQuotes(authority, evidenceIds) {
  return [...new Set((evidenceIds || []).map(id => resolveAuthorityEvidence(authority, id).quote))];
}
