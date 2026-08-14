/**
 * Pure vocabulary and merge logic for the permanent skill-opportunity
 * histogram. Keeping this file free of Electron/Node APIs makes the same
 * matching rules usable by the UI, IPC layer, and unit tests.
 */

export const SKILL_OPPORTUNITY_HISTOGRAM_VERSION = 1;

/**
 * A deliberately conservative display-name key. This removes formatting
 * differences ("Node.js" / "nodejs", punctuation, accents, casing), but does
 * not pretend that distinct technologies are synonyms. Semantic de-duplication
 * (for example "Postgres" vs "PostgreSQL") is the AI analysis call's job.
 */
export function normalizeOpportunityName(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[._/]/g, '')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function stableOpportunityId(prefix, value) {
  const normalized = normalizeOpportunityName(value);
  // FNV-1a is not for security; it gives a short, deterministic, filesystem/
  // JSON-safe identity that survives restarts and role-name spelling variants.
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index++) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${String(prefix || 'item').replace(/[^a-z0-9_-]/gi, '') || 'item'}_${(hash >>> 0).toString(36)}`;
}

export function createEmptySkillOpportunityHistogram() {
  return { version: SKILL_OPPORTUNITY_HISTOGRAM_VERSION, roles: [] };
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Skill-opportunity histogram has invalid ${label}; expected a non-negative integer.`);
  }
  return value;
}

function assertAliases(aliases, label) {
  if (!Array.isArray(aliases) || aliases.some(alias => !nonEmptyString(alias))) {
    throw new Error(`Skill-opportunity histogram has invalid ${label} aliases.`);
  }
}

/** Throws rather than silently discarding a hand-edited/corrupt store. */
export function assertValidSkillOpportunityHistogram(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('Skill-opportunity histogram must be an object.');
  }
  if (snapshot.version !== SKILL_OPPORTUNITY_HISTOGRAM_VERSION) {
    throw new Error(`Skill-opportunity histogram has unsupported version ${String(snapshot.version)}.`);
  }
  if (!Array.isArray(snapshot.roles)) {
    throw new Error('Skill-opportunity histogram has invalid roles; expected an array.');
  }

  const roleIds = new Set();
  for (const role of snapshot.roles) {
    if (!role || typeof role !== 'object' || !nonEmptyString(role.id) || !nonEmptyString(role.name)) {
      throw new Error('Skill-opportunity histogram has an invalid role record.');
    }
    if (roleIds.has(role.id)) throw new Error(`Skill-opportunity histogram has duplicate role id "${role.id}".`);
    roleIds.add(role.id);
    assertAliases(role.aliases, `role "${role.id}"`);
    nonNegativeInteger(role.generationCount, `role "${role.id}" generationCount`);
    if (!Array.isArray(role.skills)) throw new Error(`Skill-opportunity histogram role "${role.id}" has invalid skills.`);

    const skillIds = new Set();
    for (const skill of role.skills) {
      if (!skill || typeof skill !== 'object' || !nonEmptyString(skill.id) || !nonEmptyString(skill.name)) {
        throw new Error(`Skill-opportunity histogram role "${role.id}" has an invalid skill record.`);
      }
      if (skillIds.has(skill.id)) throw new Error(`Skill-opportunity histogram role "${role.id}" has duplicate skill id "${skill.id}".`);
      skillIds.add(skill.id);
      assertAliases(skill.aliases, `skill "${skill.id}"`);
      nonNegativeInteger(skill.demandCount, `skill "${skill.id}" demandCount`);
      nonNegativeInteger(skill.verifyCount, `skill "${skill.id}" verifyCount`);
      nonNegativeInteger(skill.learnCount, `skill "${skill.id}" learnCount`);
      if (!nonEmptyString(skill.firstSeenAt) || !nonEmptyString(skill.lastSeenAt)) {
        throw new Error(`Skill-opportunity histogram skill "${skill.id}" is missing firstSeenAt or lastSeenAt.`);
      }
    }
  }
  return snapshot;
}

function copyHistogram(snapshot) {
  return {
    ...snapshot,
    roles: snapshot.roles.map(role => ({
      ...role,
      aliases: [...role.aliases],
      skills: role.skills.map(skill => ({ ...skill, aliases: [...skill.aliases] })),
    })),
  };
}

function mergeAliases(existingAliases, candidates, canonicalName) {
  const aliases = [];
  const seen = new Set([normalizeOpportunityName(canonicalName)]);
  for (const candidate of [...existingAliases, ...candidates]) {
    const text = nonEmptyString(candidate);
    const key = normalizeOpportunityName(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    aliases.push(text);
  }
  return aliases;
}

function roleMatchesName(role, names) {
  const candidates = [role.name, ...role.aliases].map(normalizeOpportunityName);
  return names.some(name => name && candidates.includes(name));
}

function skillMatchesName(skill, name) {
  const normalized = normalizeOpportunityName(name);
  return !!normalized && [skill.name, ...skill.aliases]
    .map(normalizeOpportunityName)
    .includes(normalized);
}

function uniqueStableId(prefix, canonicalName, existingIds) {
  const base = stableOpportunityId(prefix, canonicalName);
  if (!existingIds.has(base)) return base;
  // A pre-existing matching name should already have been resolved before this
  // point. This suffix only protects the extremely unlikely short-hash clash.
  let suffix = 2;
  while (existingIds.has(`${base}_${suffix}`)) suffix++;
  return `${base}_${suffix}`;
}

function validOpportunityItem(item) {
  return !!item
    && typeof item === 'object'
    && !!nonEmptyString(item.canonicalSkillName)
    && (item.kind === 'verify' || item.kind === 'learn')
    && (item.jobImportance === 'critical' || item.jobImportance === 'high');
}

/**
 * Validates the recordable part of an AI response. Invalid individual items
 * are ignored: a malformed recommendation must not make a completed resume
 * generation lose its entire durable demand signal. The caller still gets one
 * role-generation entry for every valid role analysis.
 */
export function normalizeSkillOpportunityAnalysis(analysis) {
  if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) {
    throw new Error('Skill-opportunity analysis must be an object.');
  }
  const rawRole = analysis.role;
  const canonicalName = nonEmptyString(rawRole?.canonicalName);
  const sourceTitle = nonEmptyString(rawRole?.sourceTitle);
  if (!canonicalName && !sourceTitle) {
    throw new Error('Skill-opportunity analysis requires role.canonicalName or role.sourceTitle.');
  }
  if (!Array.isArray(analysis.items)) throw new Error('Skill-opportunity analysis requires an items array.');
  return {
    role: {
      canonicalName: canonicalName || sourceTitle,
      sourceTitle,
      matchedRoleId: nonEmptyString(rawRole?.matchedRoleId),
    },
    // Keep the original record for callers that need to audit evidence, while
    // the store itself persists only aggregate counts and vocabulary aliases.
    items: analysis.items.filter(validOpportunityItem).map(item => ({ ...item, canonicalSkillName: item.canonicalSkillName.trim() })),
  };
}

/**
 * Applies one resume-generation analysis to a snapshot without mutating it.
 * A role receives exactly one generation increment. Each normalized skill is
 * counted once per call; if a buggy analysis emits it as both kinds, `verify`
 * wins because it is the closer, candidate-supported opportunity.
 */
export function mergeSkillOpportunityAnalysis(snapshot, analysis, now = new Date().toISOString()) {
  assertValidSkillOpportunityHistogram(snapshot);
  const normalizedAnalysis = normalizeSkillOpportunityAnalysis(analysis);
  const timestamp = nonEmptyString(now);
  if (!timestamp) throw new Error('Skill-opportunity histogram merge requires a timestamp.');

  const next = copyHistogram(snapshot);
  const { role: requestedRole } = normalizedAnalysis;
  const roleNames = [requestedRole.canonicalName, requestedRole.sourceTitle]
    .map(normalizeOpportunityName)
    .filter(Boolean);
  // IDs supplied by the AI are only hints. Accept a role ID solely if it is
  // already in this persistent snapshot; otherwise use the stable vocabulary.
  let role = next.roles.find(candidate => candidate.id === requestedRole.matchedRoleId)
    || next.roles.find(candidate => roleMatchesName(candidate, roleNames));
  if (!role) {
    const existingIds = new Set(next.roles.map(candidate => candidate.id));
    role = {
      id: uniqueStableId('role', requestedRole.canonicalName, existingIds),
      name: requestedRole.canonicalName,
      aliases: [],
      generationCount: 0,
      skills: [],
    };
    next.roles.push(role);
  }
  role.aliases = mergeAliases(role.aliases, [requestedRole.canonicalName, requestedRole.sourceTitle], role.name);
  role.generationCount += 1;

  const dedupedItems = new Map();
  for (const item of normalizedAnalysis.items) {
    const key = normalizeOpportunityName(item.canonicalSkillName);
    const current = dedupedItems.get(key);
    if (!current || (current.kind === 'learn' && item.kind === 'verify')) dedupedItems.set(key, item);
  }

  for (const item of dedupedItems.values()) {
    const trustedId = nonEmptyString(item.matchedSkillId);
    // The ID is trusted only after resolving the selected role, never against
    // another role's skill list.
    let skill = role.skills.find(candidate => candidate.id === trustedId)
      || role.skills.find(candidate => skillMatchesName(candidate, item.canonicalSkillName));
    if (!skill) {
      const existingIds = new Set(role.skills.map(candidate => candidate.id));
      skill = {
        id: uniqueStableId('skill', item.canonicalSkillName, existingIds),
        name: item.canonicalSkillName,
        aliases: [],
        demandCount: 0,
        verifyCount: 0,
        learnCount: 0,
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
      };
      role.skills.push(skill);
    }
    skill.aliases = mergeAliases(skill.aliases, [item.canonicalSkillName], skill.name);
    skill.demandCount += 1;
    if (item.kind === 'verify') skill.verifyCount += 1;
    else skill.learnCount += 1;
    skill.lastSeenAt = timestamp;
  }
  return next;
}
