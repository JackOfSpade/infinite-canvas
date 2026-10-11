import { resolveAuthorityCertification, resolveAuthorityEducation, resolveAuthorityEvidence, resolveAuthorityProject, validateAuthoritySkillGroup } from './applicationCareerAuthority.js';
import { hostOwnedValueSha256, hostOwnedSurfaceKey, sameHostOwnedValue } from './hostOwnedText.js';
import { formatRoleDateForPresentation } from './structuredResume.js';

/**
 * Host-owned résumé fields are WRITTEN BY THE HOST.
 *
 * A role's title/company/dates/location, a project's name, and an education or
 * certification record's identity fields are copied from the approved career
 * snapshot, and the validators demand that copy byte for byte. A writer that
 * restates one in another surface form (capitalization, a hyphen where the
 * snapshot has an en dash, a curly quote, a doubled space) has still named that
 * entity. Rejecting it asks the writer to guess which character differs; a
 * strong model keeps "fixing" the wrong thing and the loop never closes.
 *
 * This runs on the parsed response BEFORE any validator, hash or renderer sees
 * it, so every later stage reads exactly what the writer would have written had
 * it copied the approved text. It changes only the surface form:
 *  - a value is replaced only when it equals the approved value after
 *    conservative normalization (hostOwnedSurfaceKey), never when it differs;
 *    a `dates` value is also compared in its display form on both sides
 *    (formatRoleDateForPresentation), so a writer that tidies the stray comma a
 *    source leaves after a month ("June, 2011" written "June 2011") has still
 *    copied the date; a shifted month or year never normalizes to the approved
 *    one, so it is left for the validators to refuse;
 *  - the entity is never chosen here: a role is the one its id names, and a
 *    project/education/credential is the one its cited evidence resolves to,
 *    and only when that evidence resolves to exactly one approved entity.
 *  - a skill item is written as the approved inventory spells it (a case or
 *    spacing variant of an approved name denotes that skill, exactly as the
 *    validators and the renderer already read it), and only when the WHOLE
 *    group is one the authority accepts: every item an index-eligible approved
 *    skill, no repeats, every cited evidence ID belonging to one of them.
 * Every replacement is returned as a typed event carrying hashes only, so the
 * Generation Log records that the host wrote the field without recording text.
 */

export const HOST_FIELD_CANONICALIZED_EVENT = 'host-field-canonicalized';

const ROLE_FIELDS = Object.freeze(['title', 'company', 'dates', 'location']);
// A role field the approved record leaves empty may be omitted by the writer:
// the exact-match gate reads an omitted company or dates as a mismatch against
// the empty approved value, although nothing differs. An omitted location is
// already read as empty, so it needs no rewrite.
const ROLE_FIELDS_OMITTABLE_WHEN_EMPTY = Object.freeze(['company', 'dates']);
const EDUCATION_FIELDS = Object.freeze(['credential', 'institution', 'dates']);
const CERTIFICATION_FIELDS = Object.freeze(['name', 'issuer', 'dates']);

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// The one host-owned field whose surface form the renderer also tidies. The
// comparison is symmetric: both spellings are folded the way every other field
// is, then shown the way a reader will see them, and compared. The display
// projection can change a glyph but never a digit, month or word, so equal
// displays are the same date and different dates never collapse.
function sameHostOwnedDate(written, approved) {
  if (sameHostOwnedValue(written, approved)) return true;
  if (typeof written !== 'string' || typeof approved !== 'string') return false;
  return formatRoleDateForPresentation(hostOwnedSurfaceKey(written)) === formatRoleDateForPresentation(hostOwnedSurfaceKey(approved));
}

function boundedId(value) {
  return typeof value === 'string' ? value.slice(0, 80) : null;
}

// The citations of one unit that the accepted plan marks as career data.
function careerEvidenceIdsOf(evidenceIds, acceptedEvidence) {
  const sourceById = new Map((Array.isArray(acceptedEvidence) ? acceptedEvidence : []).map(item => [item?.id, item?.sourceId]));
  return (Array.isArray(evidenceIds) ? evidenceIds : []).filter(id => sourceById.get(id) === 'career-data');
}

// The single approved entity every career-data citation of one unit resolves
// to, as { entityId }, or null when the citations are empty, include anything
// the authority does not know, or span more than one entity or kind.
function singleAuthorityEntity(authority, evidenceIds, acceptedEvidence, kind) {
  if (!authority) return null;
  const sourceById = new Map((Array.isArray(acceptedEvidence) ? acceptedEvidence : []).map(item => [item?.id, item?.sourceId]));
  const careerIds = (Array.isArray(evidenceIds) ? evidenceIds : []).filter(id => sourceById.get(id) === 'career-data');
  if (!careerIds.length) return null;
  let entityId = null;
  for (const id of careerIds) {
    let unit;
    try { unit = resolveAuthorityEvidence(authority, id); } catch { return null; }
    if (unit.kind !== kind) return null;
    if (entityId !== null && unit.entityId !== entityId) return null;
    entityId = unit.entityId;
  }
  return entityId;
}

/**
 * @returns {{ resume: object, events: object[] }} the résumé with the host-owned
 * fields written as approved (a copy when anything changed, otherwise the very
 * same object) and one typed event per field the host rewrote.
 */
export function canonicalizeHostOwnedResumeFields(resume, { authority = null, acceptedEvidence = [], sourceRoles = [] } = {}) {
  if (!isObject(resume)) return { resume, events: [] };
  const events = [];

  // Replaces `unit[field]` with `approved` when it is the same host-owned
  // value in a different surface form. Returns the (possibly new) unit.
  const snapUnit = (unit, unitKind, fields, approvedOf, { omittableFields = [] } = {}) => {
    let next = unit;
    for (const field of fields) {
      const approved = approvedOf(field);
      if (typeof approved !== 'string') continue;
      const written = unit[field];
      let different;
      if (typeof written === 'string') different = written !== approved && (field === 'dates' ? sameHostOwnedDate : sameHostOwnedValue)(written, approved);
      else different = written == null && approved === '' && omittableFields.includes(field);
      if (!different) continue;
      if (next === unit) next = { ...unit };
      next[field] = approved;
      events.push({
        type: HOST_FIELD_CANONICALIZED_EVENT, document: 'resume', unit: unitKind, unitId: boundedId(unit.id), field,
        fromSha256: typeof written === 'string' ? hostOwnedValueSha256(written) : null,
        toSha256: hostOwnedValueSha256(approved),
      });
    }
    return next;
  };

  // Walks one section and keeps the original array when no unit changed.
  const snapSection = (section, snap) => {
    if (!Array.isArray(section)) return section;
    let changed = false;
    const mapped = section.map(unit => {
      if (!isObject(unit)) return unit;
      const next = snap(unit);
      if (next !== unit) changed = true;
      return next;
    });
    return changed ? mapped : section;
  };

  const roleCatalog = new Map((Array.isArray(sourceRoles) ? sourceRoles : []).filter(isObject).map(role => [role.id, role]));
  const writtenRoleIds = new Map();
  for (const role of Array.isArray(resume.roles) ? resume.roles : []) {
    if (isObject(role)) writtenRoleIds.set(role.id, (writtenRoleIds.get(role.id) || 0) + 1);
  }
  const roles = snapSection(resume.roles, role => {
    const source = roleCatalog.get(role.id);
    // A role id the response repeats does not name one unambiguous entity.
    if (!source || writtenRoleIds.get(role.id) !== 1) return role;
    return snapUnit(role, 'role', ROLE_FIELDS, field => (typeof source[field] === 'string' ? source[field] : (field === 'location' ? '' : undefined)), {
      omittableFields: ROLE_FIELDS_OMITTABLE_WHEN_EMPTY,
    });
  });

  const projects = snapSection(resume.projects, project => {
    const entityId = singleAuthorityEntity(authority, project.evidenceIds, acceptedEvidence, 'project');
    if (entityId === null) return project;
    let approved;
    try { approved = resolveAuthorityProject(authority, entityId); } catch { return project; }
    return snapUnit(project, 'project', ['name'], () => approved?.name);
  });
  const education = snapSection(resume.education, item => {
    const entityId = singleAuthorityEntity(authority, item.evidenceIds, acceptedEvidence, 'education');
    if (entityId === null) return item;
    let approved;
    try { approved = resolveAuthorityEducation(authority, entityId); } catch { return item; }
    return snapUnit(item, 'education', EDUCATION_FIELDS, field => approved?.[field]);
  });
  const credentials = snapSection(resume.credentials, item => {
    const entityId = singleAuthorityEntity(authority, item.evidenceIds, acceptedEvidence, 'certification');
    if (entityId === null) return item;
    let approved;
    try { approved = resolveAuthorityCertification(authority, entityId); } catch { return item; }
    return snapUnit(item, 'credential', CERTIFICATION_FIELDS, field => approved?.[field]);
  });

  // Skill items are the one host-owned text that is a list. The group is
  // judged by the authority's own group gate, which names the approved skill
  // each item denotes and refuses the whole group on anything else; the host
  // only copies the approved spellings that gate returns, item by item.
  const skills = snapSection(resume.skills, group => {
    if (!authority || !Array.isArray(group.items) || !group.items.length) return group;
    const careerIds = careerEvidenceIdsOf(group.evidenceIds, acceptedEvidence);
    if (!careerIds.length) return group;
    let approvedNames;
    try { approvedNames = validateAuthoritySkillGroup(authority, group.items, careerIds); } catch { return group; }
    if (approvedNames.length !== group.items.length) return group;
    let items = group.items;
    approvedNames.forEach((approved, index) => {
      const written = group.items[index];
      if (typeof written !== 'string' || typeof approved !== 'string' || written === approved) return;
      if (items === group.items) items = [...group.items];
      items[index] = approved;
      events.push({
        type: HOST_FIELD_CANONICALIZED_EVENT, document: 'resume', unit: 'skill', unitId: boundedId(group.id), field: 'items',
        fromSha256: hostOwnedValueSha256(written), toSha256: hostOwnedValueSha256(approved),
      });
    });
    return items === group.items ? group : { ...group, items };
  });

  if (!events.length) return { resume, events };
  return {
    resume: {
      ...resume,
      ...(roles !== resume.roles ? { roles } : {}),
      ...(projects !== resume.projects ? { projects } : {}),
      ...(education !== resume.education ? { education } : {}),
      ...(credentials !== resume.credentials ? { credentials } : {}),
      ...(skills !== resume.skills ? { skills } : {}),
    },
    events,
  };
}
