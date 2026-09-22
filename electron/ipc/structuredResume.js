/**
 * Deterministic renderer for the paste-back application's structured résumé
 * contract. Local AI supplies copy and verified identifiers; this module owns
 * the document structure so an untrusted paste cannot alter the design system.
 */
import { careerDataProjectProvenanceHeadingForName, resumeProjectProvenanceFailures } from './jobApplication.js';

export const STRUCTURED_RESUME_SCHEMA_VERSION = 'structured-resume.v1';

export class StructuredResumeValidationError extends Error {
  constructor(message) {
    super(`Structured résumé validation failed: ${message}`);
    this.name = 'StructuredResumeValidationError';
    this.code = 'STRUCTURED_RESUME_INVALID';
    this.detail = message;
  }
}

// A grounding input this app failed to supply is a host defect, not a defect
// in the pasted résumé. It carries its own code so the paste stages rethrow it
// instead of listing it among the corrections a responder is asked to make —
// no revision can supply an argument the host never passed.
export class StructuredResumeConfigurationError extends Error {
  constructor(message) {
    super(`Structured résumé validation is misconfigured: ${message}`);
    this.name = 'StructuredResumeConfigurationError';
    this.code = 'STRUCTURED_RESUME_CONFIGURATION';
    this.detail = message;
  }
}

function configurationFault(message) {
  throw new StructuredResumeConfigurationError(message);
}

const MAX_TEXT = 8_000;
const MAX_CONTACT = 12;
const MAX_ROLES = 32;
const MAX_BULLETS_PER_ROLE = 24;
const MAX_PROJECTS = 24;
const MAX_SKILL_GROUPS = 24;
const MAX_SKILL_ITEMS_PER_GROUP = 48;
// Per-field character ceilings. text()'s `max` used to be a literal at every
// call site, so the résumé contract could state only the two a reader could
// find (bullet text and ids) and every other field was enforced silently.
// Naming them here is what lets the prompt print the same numbers the gate
// reads.
const MAX_SHORT_TEXT = 300; // identity.name/subtitleRole, a role's title, company, dates, location, a project name
const MAX_LONG_TEXT = 500; // identity.credential, one contact value, a project's metrics
const MAX_PROJECT_DESCRIPTION = 1_200;
const MAX_SKILL_TEXT = 200; // a skill group's label and each of its items
const MAX_ID_TEXT = 120;
// The résumé prompt states these ceilings so a responder is never rejected by
// one it was not told. Exporting the numbers the gates actually read is what
// keeps the two in step: a hand-copied literal in the prompt can drift from
// the constant here without any test noticing.
export const STRUCTURED_RESUME_LIMITS = Object.freeze({
  roles: MAX_ROLES,
  bulletsPerRole: MAX_BULLETS_PER_ROLE,
  projects: MAX_PROJECTS,
  skillGroups: MAX_SKILL_GROUPS,
  skillItemsPerGroup: MAX_SKILL_ITEMS_PER_GROUP,
  contactValues: MAX_CONTACT,
  textChars: MAX_TEXT,
  chars: Object.freeze({
    shortText: MAX_SHORT_TEXT,
    longText: MAX_LONG_TEXT,
    projectDescription: MAX_PROJECT_DESCRIPTION,
    skillText: MAX_SKILL_TEXT,
    id: MAX_ID_TEXT,
  }),
});
// A neutral category label names a KIND of skill and claims nothing about
// proficiency or importance. The gate exists to block editorializing headings
// ("Expert Technologies", "Core Strengths", "Leadership"), not to force a
// resume's ordinary taxonomy through a vocabulary too small to name it.
export const NEUTRAL_SKILL_GROUP_LABELS = Object.freeze([
  'skills', 'technical skills', 'tools', 'languages', 'programming languages', 'technologies',
  'frameworks', 'libraries', 'databases', 'platforms', 'infrastructure', 'integration',
  'systems', 'methods', 'methodologies', 'practices', 'competencies', 'web development',
].sort());
const NEUTRAL_SKILL_GROUPS = new Set(NEUTRAL_SKILL_GROUP_LABELS);
// "Infrastructure & Integration" or "Tools / Platforms" joins neutral category
// nouns with a neutral connector; the compound still claims nothing.
const NEUTRAL_GROUP_CONNECTORS = Object.freeze(['&', '/', ',', 'and']);
const NEUTRAL_GROUP_CONNECTOR_RE = /\s*(?:&|\/|,|\band\b)\s*/u;
const MAX_NEUTRAL_GROUP_PARTS = 3;
// Both the rejection message and the résumé prompt state this rule, and a
// responder that follows it must never be rejected.  Deriving the sentence
// from the same constants the gate reads is what keeps that true: a hand-worded
// "two of those joined by & or /" silently understates a gate that accepts
// three parts joined four ways.
export const NEUTRAL_SKILL_GROUP_RULE = `one of ${NEUTRAL_SKILL_GROUP_LABELS.join(', ')}, or up to ${MAX_NEUTRAL_GROUP_PARTS} of those joined by ${NEUTRAL_GROUP_CONNECTORS.map(connector => `"${connector}"`).join(', ')}`;

function isNeutralSkillGroupLabel(label) {
  const parts = String(label).toLocaleLowerCase().split(NEUTRAL_GROUP_CONNECTOR_RE).map(part => part.trim()).filter(Boolean);
  return parts.length > 0 && parts.length <= MAX_NEUTRAL_GROUP_PARTS && parts.every(part => NEUTRAL_SKILL_GROUPS.has(part));
}
const GROUNDING_STOPWORDS = new Set(['about', 'after', 'against', 'built', 'build', 'created', 'create', 'delivered', 'developed', 'for', 'from', 'into', 'made', 'manual', 'over', 'reduced', 'system', 'systems', 'that', 'the', 'this', 'through', 'using', 'with', 'work']);
// “At least two meaningful terms” is unsatisfiable while “meaningful” is
// undefined: the list below deliberately drops the résumé verbs a writer
// reaches for first (built, created, delivered, developed, made, using), so a
// description can restate its evidence in good faith and still share nothing
// the gate counts. The prompt therefore states what counts, derived from the
// same set and thresholds the gate reads rather than hand-listed beside them.
const MIN_GROUNDING_TERM_CHARS = 3;
export const MIN_SHARED_CAREER_TERMS = 2;
export const CAREER_TERM_OVERLAP_RULE = `a term is a run of letters or digits at least ${MIN_GROUNDING_TERM_CHARS} characters long, compared case-insensitively and counted once however often it repeats, and these ${GROUNDING_STOPWORDS.size} words never count: ${[...GROUNDING_STOPWORDS].sort().join(', ')}`;
// Source profile IDs include UUIDs and can validly begin with a digit.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
export const STRUCTURED_RESUME_ID_PATTERN = ID_RE.source;

function fail(message) { throw new StructuredResumeValidationError(message); }

// Repeated same-class defects used to cost one manual copy/paste handoff
// round each, because the first offender threw. Checks that walk a collection
// collect every offender for that check, and ONE drain at the end of the
// draft reports them together — across the bullets of a role, across the
// roles, and across roles, projects, and skills alike, because the rule a
// responder has to relearn is the same rule wherever it fired. Batching stays
// local to those collection checks: structural and shape checks that later
// code depends on still fail fast, so nothing downstream runs on data an
// earlier check already rejected.
const MAX_LISTED_OFFENDERS = 8;
// An offender string embeds text the response itself supplied (a skill item,
// a project name, an evidence ID). Clipping each one keeps a pathological
// draft — 32 roles of 24 bullets, every field at its ceiling — from turning
// one rejection into a megabyte of correction prompt. The locating label is
// written first, so a clipped offender still says where it is.
const MAX_OFFENDER_CHARS = 120;

function clipOffender(value) {
  const offender = String(value ?? '');
  return offender.length > MAX_OFFENDER_CHARS ? `${offender.slice(0, MAX_OFFENDER_CHARS - 1)}…` : offender;
}

/**
 * Report every collected offense as one message. Offenses are
 * `{ rule, offender, message }`; the first offense of a rule keeps its full
 * single-offender wording and every sibling offender is named after it, so one
 * correction round can fix the whole class.
 */
function failOffenses(offenses) {
  if (!offenses?.length) return;
  const byRule = new Map();
  for (const offense of offenses) {
    if (!byRule.has(offense.rule)) byRule.set(offense.rule, []);
    byRule.get(offense.rule).push(offense);
  }
  fail([...byRule.values()].map(([first, ...rest]) => {
    if (!rest.length) return first.message;
    const shown = rest.slice(0, MAX_LISTED_OFFENDERS).map(offense => clipOffender(offense.offender));
    const remaining = rest.length - shown.length;
    return `${first.message} The same rule also rejects ${rest.length} more in this response: ${shown.join('; ')}${remaining > 0 ? `, and ${remaining} more` : ''}. Fix all of them before resubmitting.`;
  }).join(' '));
}

function offend(collect, rule, offender, message) {
  if (collect) collect.push({ rule, offender, message });
  else fail(message);
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  return value;
}

/**
 * The one definition of "an unsafe control character" this pipeline grades
 * text against: every C0 control except tab, newline and carriage return,
 * plus DEL.
 *
 * Exported because three places read this rule and all three must agree. Two
 * of them GRADE text — here, and the paste assembly's frozen-source checks.
 * The third WRITES it: localAiApplication's cleanText composes the career
 * corpus and the listing companion a job freezes, and a writer that passes a
 * character the graders reject freezes a job no pasted response can finish,
 * which regenerating reproduces because it rebuilds the same file through the
 * same writer. Hand-copied character sets are how that happens; one predicate
 * is how it cannot.
 */
export function isUnsafeControlCharacter(char) {
  const code = String(char).charCodeAt(0);
  return code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13);
}

function text(value, label, { required = false, max = MAX_TEXT } = {}) {
  if (value == null || value === '') {
    if (required) fail(`${label} is required.`);
    return '';
  }
  if (typeof value !== 'string') fail(`${label} must be a string.`);
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned && required) fail(`${label} is required.`);
  if (cleaned.length > max) fail(`${label} exceeds ${max} characters.`);
  if ([...cleaned].some(character => isUnsafeControlCharacter(character))) fail(`${label} contains an unsafe control character.`);
  return cleaned;
}

function id(value, label) {
  const cleaned = text(value, label, { required: true, max: MAX_ID_TEXT });
  if (!ID_RE.test(cleaned)) fail(`${label} must use a stable identifier.`);
  return cleaned;
}

function unique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) fail(`${label} contains duplicate identifier "${value}".`);
    seen.add(value);
  }
  return seen;
}

function equalSourceValue(value, sourceValue, label) {
  if (value !== sourceValue) fail(`${label} must exactly match its trusted source role.`);
}

// An identity field is copied from the trusted identity, not from a source
// role, and its repair differs by case: supply the trusted value, or omit the
// field entirely when the trusted identity carries no such value.
function equalTrustedIdentityValue(value, trustedValue, label) {
  if (value === trustedValue) return;
  const field = label.startsWith('identity.') ? label.slice('identity.'.length) : label;
  if (!trustedValue) fail(`${label} must be omitted: trustedIdentity has no ${field} value, so supplying one is rejected.`);
  fail(`${label} must be copied from trustedIdentity exactly as "${trustedValue}".`);
}

/**
 * The trusted role list this renderer requires, validated.
 *
 * Exported because the paste assembly grades it BEFORE handing it here: the
 * list comes from the job's own frozen input record, not from any response, so
 * a defect in it reported through a résumé would tell a responder to rewrite a
 * document over a value it never supplied. Assembly calls this to raise that
 * defect as what it is; this renderer still normalizes the same list itself,
 * and normalizing an accepted list twice cannot disagree with itself.
 */
export function assertTrustedSourceRoles(sourceRoles) {
  normalizeSourceRoles(sourceRoles);
}

function normalizeSourceRoles(sourceRoles) {
  if (!Array.isArray(sourceRoles) || !sourceRoles.length) fail('trusted sourceRoles must be a nonempty array.');
  if (sourceRoles.length > MAX_ROLES) fail(`trusted sourceRoles cannot exceed ${MAX_ROLES} roles.`);
  const normalized = sourceRoles.map((raw, index) => {
    const source = record(raw, `sourceRoles[${index}]`);
    return {
      id: id(source.id, `sourceRoles[${index}].id`),
      title: text(source.title, `sourceRoles[${index}].title`, { required: true, max: MAX_SHORT_TEXT }),
      company: text(source.company, `sourceRoles[${index}].company`, { max: MAX_SHORT_TEXT }),
      dates: text(source.dates, `sourceRoles[${index}].dates`, { max: MAX_SHORT_TEXT }),
      location: text(source.location, `sourceRoles[${index}].location`, { max: MAX_SHORT_TEXT }),
    };
  });
  unique(normalized.map(role => role.id), 'trusted sourceRoles');
  return normalized;
}

const UNKNOWN_EVIDENCE_RULE = 'evidence-id-is-verified';
const CAREER_EVIDENCE_RULE = 'evidence-includes-career-data';

// `collect` batches only the two grounding checks. The shape checks above them
// guard the reads that follow, so they keep throwing on the first defect.
function normalizeEvidenceIds(value, label, allowedEvidenceIds, careerEvidenceIds, { requireCareerEvidence, collect = null } = {}) {
  // Both of these decide whether the career-evidence rule below runs at all,
  // and neither is visible in the verdict when it is missing: an omitted
  // careerEvidenceIds and a defaulted requireCareerEvidence each leave a gate
  // that accepts listing-only evidence for rendered candidate content while
  // still reporting as a completed check.
  if (careerEvidenceIds !== null && !(careerEvidenceIds instanceof Set)) {
    configurationFault(`${label} was graded without the career-data evidence IDs; pass the Set, or null for a string-only evidence list that cannot name its sources.`);
  }
  if (typeof requireCareerEvidence !== 'boolean') {
    configurationFault(`${label} was graded without stating whether career-data evidence is required for it.`);
  }
  if (!Array.isArray(value) || !value.length) fail(`${label} must contain at least one verified evidence ID.`);
  const ids = value.map((entry, index) => id(entry, `${label}[${index}]`));
  unique(ids, label);
  let unknownCited = false;
  for (const evidenceId of ids) {
    if (allowedEvidenceIds.has(evidenceId)) continue;
    unknownCited = true;
    offend(collect, UNKNOWN_EVIDENCE_RULE, `${label} "${evidenceId}"`, `${label} references unknown evidence ID "${evidenceId}".`);
  }
  // An unknown ID cannot be classified as career evidence, so the check below
  // would restate the same defect. Fail-fast callers never reach it at all.
  if (!unknownCited && requireCareerEvidence && careerEvidenceIds && !ids.some(evidenceId => careerEvidenceIds.has(evidenceId))) {
    offend(collect, CAREER_EVIDENCE_RULE, label,
      `${label} needs at least one career-data evidence ID; job-listing evidence alone cannot support rendered candidate content.`);
  }
  return ids;
}

function normalizeIdentity(raw, trustedIdentity) {
  const identity = record(raw, 'identity');
  if (!Array.isArray(identity.contact) || !identity.contact.length || identity.contact.length > MAX_CONTACT) {
    fail(`identity.contact must contain between 1 and ${MAX_CONTACT} contact values.`);
  }
  const contact = identity.contact.map((entry, index) => text(entry, `identity.contact[${index}]`, { required: true, max: MAX_LONG_TEXT }));
  unique(contact, 'identity.contact');
  const normalized = {
    name: text(identity.name, 'identity.name', { required: true, max: MAX_SHORT_TEXT }),
    subtitleRole: text(identity.subtitleRole, 'identity.subtitleRole', { max: MAX_SHORT_TEXT }),
    credential: text(identity.credential, 'identity.credential', { max: MAX_LONG_TEXT }),
    contact,
  };
  if (trustedIdentity != null) {
    const trusted = record(trustedIdentity, 'trustedIdentity');
    const trustedContact = Array.isArray(trusted.contact)
      ? trusted.contact.map((entry, index) => text(entry, `trustedIdentity.contact[${index}]`, { required: true, max: MAX_LONG_TEXT }))
      : fail('trustedIdentity.contact must be an array.');
    for (const key of ['name', 'subtitleRole', 'credential']) {
      equalTrustedIdentityValue(normalized[key], text(trusted[key], `trustedIdentity.${key}`, { required: key === 'name', max: key === 'credential' ? MAX_LONG_TEXT : MAX_SHORT_TEXT }), `identity.${key}`);
    }
    if (normalized.contact.length !== trustedContact.length || normalized.contact.some((entry, index) => entry !== trustedContact[index])) {
      fail(`identity.contact must repeat trustedIdentity.contact element-for-element in the same order \u2014 exactly these ${trustedContact.length} value(s), unchanged and unreordered: ${trustedContact.map(entry => `"${entry}"`).join(', ')}.`);
    }
  }
  return normalized;
}

const ROLE_BULLET_SCOPE_RULE = 'bullet-cites-own-role-career-section';
// The evidence plan can no longer starve an employer, but it can still be
// spent badly: a plan that carries real work evidence for an employer does not
// stop the résumé from citing that employer's opening block instead, and a
// bullet whose every cited quote sits inside that block has nothing to rewrite
// but the title, employer and dates the résumé already prints. Measured on the
// live run as "Held a <title> role with <employer> in <city> from <month> to
// <month>" — and no gate saw it, because the one gate that reads bullet prose
// asks for shared terms between the bullet and its cited quote, which a role
// header restating its own date block satisfies maximally.
//
// This fires only where the accepted plan already carries a quote from that
// same section below its opening block, so the repair is always available in
// this stage, in one round, without reopening the frozen plan: cite that item
// instead. Where the plan carries no such quote — an employer whose career
// data says nothing beyond its header — restating the header is the only legal
// answer the host left, so this stays silent rather than rejecting a bullet
// that cannot be written any other way.
const ROLE_BULLET_OPENING_BLOCK_RULE = 'bullet-cites-past-its-section-opening-block';

function normalizeRole(raw, index, sourceById, allowedEvidenceIds, careerEvidenceIds, careerData, careerEvidenceQuotesById, careerDataRoleRegions, offenses) {
  const role = record(raw, `roles[${index}]`);
  const roleId = id(role.id, `roles[${index}].id`);
  const source = sourceById.get(roleId);
  if (!source) fail(`roles[${index}].id does not identify a trusted source role.`);
  const normalized = {
    id: roleId,
    title: text(role.title, `roles[${index}].title`, { required: true, max: MAX_SHORT_TEXT }),
    company: text(role.company, `roles[${index}].company`, { max: MAX_SHORT_TEXT }),
    dates: text(role.dates, `roles[${index}].dates`, { max: MAX_SHORT_TEXT }),
    location: text(role.location, `roles[${index}].location`, { max: MAX_SHORT_TEXT }),
    summary: text(role.summary, `roles[${index}].summary`, { max: 700 }),
  };
  if (normalized.summary) fail(`roles[${index}].summary is unsupported; place source-bound claims in bullets.`);
  equalSourceValue(normalized.title, source.title, `roles[${index}].title`);
  equalSourceValue(normalized.company, source.company, `roles[${index}].company`);
  equalSourceValue(normalized.dates, source.dates, `roles[${index}].dates`);
  if (source.location) {
    equalSourceValue(normalized.location, source.location, `roles[${index}].location`);
  } else if (normalized.location && !occursInRoleCareerRegion(normalized.location, careerDataRoleRegions?.get(roleId), careerData)) {
    fail(`roles[${index}].location must be omitted, or occur as a case-sensitive literal inside that employer's frozen career-data section, because its trusted source role has no location field.`);
  }
  if (!Array.isArray(role.bullets) || !role.bullets.length || role.bullets.length > MAX_BULLETS_PER_ROLE) {
    fail(`roles[${index}].bullets must contain between 1 and ${MAX_BULLETS_PER_ROLE} bullets.`);
  }
  // Every bullet of this role is checked before reporting, and the collector
  // is the draft's, not this role's: the same rule firing in role 2 and in
  // role 3 is one class of defect and costs one correction round, not one
  // manual handoff round per role.
  const bulletOffenses = offenses;
  const evidenceAccepted = [];
  normalized.bullets = role.bullets.map((rawBullet, bulletIndex) => {
    const bullet = record(rawBullet, `roles[${index}].bullets[${bulletIndex}]`);
    const offensesBefore = bulletOffenses.length;
    const normalizedBullet = {
      id: id(bullet.id, `roles[${index}].bullets[${bulletIndex}].id`),
      text: text(bullet.text, `roles[${index}].bullets[${bulletIndex}].text`, { required: true }),
      evidenceIds: normalizeEvidenceIds(bullet.evidenceIds, `roles[${index}].bullets[${bulletIndex}].evidenceIds`, allowedEvidenceIds, careerEvidenceIds, { requireCareerEvidence: true, collect: bulletOffenses }),
    };
    evidenceAccepted[bulletIndex] = bulletOffenses.length === offensesBefore;
    return normalizedBullet;
  });
  const careerRegion = careerDataRoleRegions?.get(roleId);
  if (careerRegion) {
    const bodyStart = careerSectionBodyStart(careerRegion, source);
    const planBodyQuotes = [...(careerEvidenceQuotesById?.values() || [])]
      .filter(quote => quoteReachesSectionBody(quote, careerRegion, bodyStart));
    for (const [bulletIndex, bullet] of normalized.bullets.entries()) {
      // A bullet whose evidence IDs were already rejected would fail this too;
      // reporting it twice would only obscure the real correction.
      if (!evidenceAccepted[bulletIndex]) continue;
      const citedCareerEvidenceIds = bullet.evidenceIds.filter(evidenceId => careerEvidenceIds?.has(evidenceId));
      const careerQuotes = careerQuotesForEvidenceIds(citedCareerEvidenceIds, careerEvidenceQuotesById);
      if (!citedCareerEvidenceIds.length || careerQuotes.length !== citedCareerEvidenceIds.length
        || careerQuotes.some(quote => !occursInRoleCareerRegion(quote, careerRegion, ''))) {
        offend(bulletOffenses, ROLE_BULLET_SCOPE_RULE, `roles[${index}].bullets[${bulletIndex}]`,
          `roles[${index}].bullets[${bulletIndex}] must cite career-data evidence only from the trusted role's career-data section.`);
      } else if (planBodyQuotes.length && !careerQuotes.some(quote => quoteReachesSectionBody(quote, careerRegion, bodyStart))) {
        offend(bulletOffenses, ROLE_BULLET_OPENING_BLOCK_RULE, `roles[${index}].bullets[${bulletIndex}]`,
          `roles[${index}].bullets[${bulletIndex}] cites career-data evidence only from inside that employer's career-data section opening block — ${CAREER_SECTION_OPENING_BLOCK_RULE}. `
          + 'The résumé prints those three from the saved work history already, so this bullet has nothing else to rewrite and can only restate the role header. '
          + `The accepted evidence plan carries ${planBodyQuotes.length === 1 ? 'one career-data item' : `${planBodyQuotes.length} career-data items`} quoting that same section below its opening block: cite ${planBodyQuotes.length === 1 ? 'it' : 'at least one of them'} here instead, and write the bullet from what it says about the work.`);
      }
    }
  }
  unique(normalized.bullets.map(bullet => bullet.id), `roles[${index}].bullets`);
  return normalized;
}

function occursInCareerData(value, careerData) {
  return String(careerData || '').toLocaleLowerCase().includes(String(value || '').toLocaleLowerCase());
}

function occursInRoleCareerRegion(value, region, careerData) {
  return String(region ?? careerData ?? '').includes(String(value || ''));
}

function roleMatchText(value) {
  return String(value || '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function containsRoleMatch(haystack, needle) {
  const normalizedNeedle = roleMatchText(needle);
  if (!normalizedNeedle) return false;
  return ` ${roleMatchText(haystack)} `.includes(` ${normalizedNeedle} `);
}

function careerDataLines(value) {
  const source = String(value || '');
  return [...source.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/gu)]
    .filter(match => match[0].length > 0)
    .map((match, index) => ({ text: match[0].replace(/(?:\r\n|\n|\r)$/u, ''), start: match.index, index }));
}

function markdownHeading(line) {
  const match = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
  return match ? { level: match[1].length, label: match[2] } : null;
}

// The boundary the loop below actually cuts on, in prose. Both the résumé
// contract and the evidence-plan contract have to describe this same section
// to a responder, and a section described two slightly different ways in two
// prompts is a rejection waiting to happen — so both interpolate this.
export const CAREER_DATA_ROLE_SECTION_RULE = 'the block that begins at that employer’s own markdown heading, or, where careerData writes no markdown headings at all, at the line that is exactly this role’s title with that employer named on one of the lines just below it, and that runs to whichever comes first: the next role’s own beginning, the next horizontal rule, or, only when the block began at a markdown heading, the next markdown heading at the same or a higher level';

// A role is scoped only when the frozen career source gives us a unique,
// recognizable boundary. Markdown imports usually name the employer in a
// heading; text extraction often removes that formatting, leaving a title
// line immediately followed by an employer line.
function careerDataRoleRegionsForSourceRoles(careerData, sourceRoles) {
  const lines = careerDataLines(careerData);
  const candidatesByRole = new Map(sourceRoles.map(role => [role.id, []]));
  for (const role of sourceRoles) {
    const candidates = candidatesByRole.get(role.id);
    for (let index = 0; index < lines.length; index += 1) {
      const heading = markdownHeading(lines[index].text);
      const headingMatch = heading && (role.company
        ? containsRoleMatch(heading.label, role.company)
        : containsRoleMatch(heading.label, role.title));
      if (headingMatch) candidates.push(lines[index].start);
      if (!role.company || roleMatchText(lines[index].text) !== roleMatchText(role.title)) continue;
      let companyLine = '';
      let seen = 0;
      for (let cursor = index + 1; cursor < lines.length && seen < 3; cursor += 1) {
        if (!lines[cursor].text.trim()) continue;
        seen += 1;
        if (containsRoleMatch(lines[cursor].text, role.company)) {
          companyLine = lines[cursor].text;
          break;
        }
      }
      if (companyLine) candidates.push(lines[index].start);
    }
  }
  const uniqueCandidates = new Map([...candidatesByRole.entries()].map(([roleId, starts]) => [roleId, [...new Set(starts)]]));
  const claimedStarts = new Map();
  for (const [roleId, starts] of uniqueCandidates) {
    if (starts.length === 1) claimedStarts.set(starts[0], [...(claimedStarts.get(starts[0]) || []), roleId]);
  }
  const scoped = [...uniqueCandidates.entries()]
    .filter(([, starts]) => starts.length === 1 && claimedStarts.get(starts[0])?.length === 1)
    .map(([roleId, starts]) => ({ roleId, start: starts[0] }))
    .sort((left, right) => left.start - right.start);
  const regions = new Map();
  for (let index = 0; index < scoped.length; index += 1) {
    const current = scoped[index];
    const currentHeading = markdownHeading(lines.find(line => line.start === current.start)?.text || '');
    const nextRole = scoped[index + 1]?.start ?? Infinity;
    const boundaries = lines.filter((line) => {
      if (/^\s*---+\s*$/u.test(line.text)) return true;
      const heading = markdownHeading(line.text);
      return Boolean(currentHeading && heading && heading.level <= currentHeading.level);
    }).map(line => line.start);
    const nextBoundary = boundaries.find(start => start > current.start) ?? Infinity;
    const end = Math.min(nextRole, nextBoundary, String(careerData || '').length);
    if (end > current.start) regions.set(current.roleId, String(careerData || '').slice(current.start, end));
  }
  return regions;
}

// A section's opening block: the run of lines at its start that only restate
// the role's own identity — its heading, its title, its employer line, its
// location line, its dates. The résumé prints all of that from the trusted
// source role already, so a bullet grounded on nothing else can only restate
// the header. The run stops at the first blank line, the first list item, and
// the first line that states none of those facts, which keeps it from
// swallowing prose.
//
// Four places have to describe this same block to a responder or name it in a
// rejection — the evidence-plan contract, the résumé contract, and the gate on
// each of those stages. Three of them were already spelling it two different
// ways ("the lines stating…" against "the lines that state…"), which is the
// drift a shared constant exists to stop, so all four interpolate this.
export const CAREER_SECTION_OPENING_BLOCK_RULE = 'the lines at its start that state the role title, the employer, the location, and the dates';
const CAREER_SECTION_LIST_ITEM_RE = /^\s{0,3}(?:[-*+•—–]|\d{1,3}[.)])\s/u;
const CAREER_SECTION_YEAR_RE = /\d{4}/u;

// A heading that fuses the title and the employer on one markdown line
// ("### Title — Employer") leaves the location on its own line right below
// it ("City, Region"), one line before the dates. That location line states
// none of title, company, or a year, so — before this checked the role's own
// location too — it read as the first line of BODY prose: the walk stopped
// there, and everything below it, including the dates line, counted as
// content the section "says about the work." A three-line section with
// nothing else was reported as `reason: 'none'` — quote the work this
// employer never described — instead of `'none-opening-block-only'`, because
// `sectionHasBody` saw that location-plus-dates text and called it a body.
// Checking the role's OWN location value (sourceRoles carries one) closes
// that gap the same way title/company already do, rather than guessing at
// location shapes from the text alone.
function careerSectionBodyStart(region, role) {
  let bodyStart = 0;
  for (const line of careerDataLines(region)) {
    if (!line.text.trim() || CAREER_SECTION_LIST_ITEM_RE.test(line.text)) break;
    const statesRoleIdentity = Boolean(markdownHeading(line.text))
      || containsRoleMatch(line.text, role.title)
      || (role.company && containsRoleMatch(line.text, role.company))
      || (role.location && containsRoleMatch(line.text, role.location))
      || CAREER_SECTION_YEAR_RE.test(line.text);
    if (!statesRoleIdentity) break;
    bodyStart = line.start + line.text.length;
  }
  return bodyStart;
}

function quoteReachesSectionBody(quote, region, bodyStart) {
  if (!quote) return false;
  for (let index = region.indexOf(quote); index >= 0; index = region.indexOf(quote, index + 1)) {
    if (index + quote.length > bodyStart) return true;
  }
  return false;
}

/**
 * Which trusted source roles an accepted evidence plan would leave the résumé
 * stage unable to answer. That stage requires every source role to render at
 * least one bullet and every bullet to cite career-data evidence from that
 * employer's own section, so the plan decides — before it is frozen — whether
 * a legal résumé exists at all. Only roles this module can actually scope are
 * reported, because those are the only ones the résumé gate binds. Never
 * throws: it reads a candidate response.
 *
 * Returns `[{ id, label, reason }]` with reason `'none'` (the plan quotes that
 * section nowhere, and the section carries text below its opening block),
 * `'none-opening-block-only'` (the plan quotes it nowhere and the section
 * states nothing beyond its opening block, so the block itself is the only
 * quote available), or `'header-only'` (the plan quotes only its opening
 * block, while the section carries other text a quote could come from).
 * The two `'none'` reasons have different repairs, which is why they are
 * different reasons: a caller that reports them as one tells the responder to
 * quote work description that, for the second, this corpus does not contain.
 */
export function structuredResumeRoleEvidenceGaps(sourceRoles, careerEvidence, careerData) {
  const roles = (Array.isArray(sourceRoles) ? sourceRoles : [])
    .filter(role => role && typeof role === 'object' && !Array.isArray(role))
    .map(role => ({ id: String(role.id ?? ''), title: String(role.title ?? ''), company: String(role.company ?? ''), location: String(role.location ?? '') }))
    .filter(role => role.id && (role.title || role.company));
  const quotes = (Array.isArray(careerEvidence) ? careerEvidence : [])
    .map(item => (typeof item === 'string' ? item : item?.quote))
    .filter(quote => typeof quote === 'string' && quote);
  if (!roles.length) return [];
  const regions = careerDataRoleRegionsForSourceRoles(typeof careerData === 'string' ? careerData : '', roles);
  const gaps = [];
  for (const role of roles) {
    const region = regions.get(role.id);
    if (!region) continue;
    const label = role.company || role.title;
    const inSection = quotes.filter(quote => region.includes(quote));
    const bodyStart = careerSectionBodyStart(region, role);
    // Measured before the plan is examined, because it decides which repair
    // exists for BOTH outcomes below, not just the header-only one.
    const sectionHasBody = Boolean(region.slice(bodyStart).trim());
    if (!inSection.length) {
      gaps.push({ id: role.id, label, reason: sectionHasBody ? 'none' : 'none-opening-block-only' });
      continue;
    }
    // Nothing outside the opening block means the opening block is all this
    // section says, and a rejection would have no repair. Stay silent.
    if (!sectionHasBody) continue;
    if (!inSection.some(quote => quoteReachesSectionBody(quote, region, bodyStart))) {
      gaps.push({ id: role.id, label, reason: 'header-only' });
    }
  }
  return gaps;
}

function meaningfulTokens(value) {
  return [...new Set(String(value || '').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter(token => token.length >= MIN_GROUNDING_TERM_CHARS && !GROUNDING_STOPWORDS.has(token)) || [])];
}

function hasCareerOverlap(value, careerQuotes) {
  const tokens = meaningfulTokens(value);
  if (tokens.length < MIN_SHARED_CAREER_TERMS) return false;
  const sourceTokens = new Set(meaningfulTokens(careerQuotes.join(' ')));
  const shared = tokens.filter(token => sourceTokens.has(token));
  return shared.length >= MIN_SHARED_CAREER_TERMS;
}

function careerQuotesForEvidenceIds(evidenceIds, careerEvidenceQuotesById) {
  return evidenceIds.flatMap(evidenceId => careerEvidenceQuotesById?.get(evidenceId) || []);
}

function occursInQuotedCareerEvidence(value, quotes) {
  const literal = String(value || '').trim();
  if (!literal) return false;
  // Do not let a short skill (Go) match inside a longer token (Google). The
  // same Unicode-aware boundaries retain literal symbolic names such as C++,
  // C#, .NET, and Node.js.
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const exactTerm = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'iu');
  return quotes.some(quote => exactTerm.test(String(quote)));
}

const PROJECT_OCCURRENCE_RULE = 'project-field-occurs-in-cited-career-evidence';
const PROJECT_DESCRIPTION_RULE = 'project-description-shares-career-evidence-terms';
const SKILL_ITEM_RULE = 'skill-item-occurs-in-cited-career-evidence';
const SKILL_GROUP_RULE = 'skill-group-is-neutral-or-in-career-data';

function normalizeProjects(value, allowedEvidenceIds, careerEvidenceIds, careerEvidenceQuotesById, careerData, offenses) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_PROJECTS) fail(`projects must be an array with at most ${MAX_PROJECTS} projects.`);
  const projectOffenses = offenses;
  const evidenceAccepted = [];
  const projects = value.map((raw, index) => {
    const project = record(raw, `projects[${index}]`);
    const offensesBefore = projectOffenses.length;
    const normalized = {
      id: id(project.id, `projects[${index}].id`),
      name: text(project.name, `projects[${index}].name`, { required: true, max: MAX_SHORT_TEXT }),
      description: text(project.description, `projects[${index}].description`, { max: MAX_PROJECT_DESCRIPTION }),
      metrics: text(project.metrics, `projects[${index}].metrics`, { max: MAX_LONG_TEXT }),
      evidenceIds: normalizeEvidenceIds(project.evidenceIds, `projects[${index}].evidenceIds`, allowedEvidenceIds, careerEvidenceIds, { requireCareerEvidence: true, collect: projectOffenses }),
    };
    evidenceAccepted[index] = projectOffenses.length === offensesBefore;
    return normalized;
  });
  // Every project is checked before reporting: an ungrounded name, metric and
  // description across several projects is one class of defect and costs one
  // correction round, not one manual handoff round each.
  for (const [index, project] of projects.entries()) {
    // A project whose evidence IDs were already rejected has no cited career
    // evidence to be measured against; the checks below would only restate
    // that defect as a second one.
    if (!evidenceAccepted[index]) continue;
    const careerQuotes = careerQuotesForEvidenceIds(project.evidenceIds, careerEvidenceQuotesById);
    for (const [field, value] of Object.entries({ name: project.name, metrics: project.metrics })) {
      if (value && !(careerQuotes.length ? occursInQuotedCareerEvidence(value, careerQuotes) : occursInCareerData(value, careerData))) {
        offend(projectOffenses, PROJECT_OCCURRENCE_RULE, `projects.${project.id}.${field} "${value}"`,
          `projects.${project.id}.${field} must occur in its cited career-data evidence.`);
      }
    }
    if (project.description && !hasCareerOverlap(project.description, careerQuotes.length ? careerQuotes : [careerData])) {
      offend(projectOffenses, PROJECT_DESCRIPTION_RULE, `projects.${project.id}.description`,
        `projects.${project.id}.description must share at least two distinct meaningful terms with its cited career-data evidence.`);
    }
  }
  unique(projects.map(project => project.id), 'projects');
  return projects;
}

function normalizeSkills(value, allowedEvidenceIds, careerEvidenceIds, careerEvidenceQuotesById, careerData, offenses) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_SKILL_GROUPS) fail(`skills must be an array with at most ${MAX_SKILL_GROUPS} groups.`);
  // Ungrounded items and non-neutral group labels are collected across every
  // group before reporting. Three bad group labels are one defect class and
  // cost one correction round, not three manual copy/paste handoff rounds.
  const skillOffenses = offenses;
  const skills = value.map((raw, index) => {
    const group = record(raw, `skills[${index}]`);
    if (!Array.isArray(group.items) || !group.items.length || group.items.length > MAX_SKILL_ITEMS_PER_GROUP) fail(`skills[${index}].items must contain between 1 and ${MAX_SKILL_ITEMS_PER_GROUP} values.`);
    const items = group.items.map((entry, itemIndex) => text(entry, `skills[${index}].items[${itemIndex}]`, { required: true, max: MAX_SKILL_TEXT }));
    unique(items, `skills[${index}].items`);
    const offensesBefore = skillOffenses.length;
    const evidenceIds = normalizeEvidenceIds(group.evidenceIds, `skills[${index}].evidenceIds`, allowedEvidenceIds, careerEvidenceIds, { requireCareerEvidence: true, collect: skillOffenses });
    const careerQuotes = careerQuotesForEvidenceIds(evidenceIds, careerEvidenceQuotesById);
    // Items are measured against the evidence this group cites, so a group
    // whose citation was already rejected has nothing left to measure them
    // against; restating that as an item defect would hide the real repair.
    if (skillOffenses.length === offensesBefore) {
      for (const item of items) {
        if (!(careerQuotes.length ? occursInQuotedCareerEvidence(item, careerQuotes) : occursInCareerData(item, careerData))) {
          offend(skillOffenses, SKILL_ITEM_RULE, `skills[${index}] item "${item}"`,
            `skills[${index}] item "${item}" must occur in its cited career-data evidence.`);
        }
      }
    }
    const groupName = text(group.group, `skills[${index}].group`, { required: true, max: MAX_SKILL_TEXT });
    if (!isNeutralSkillGroupLabel(groupName) && !occursInCareerData(groupName, careerData)) {
      offend(skillOffenses, SKILL_GROUP_RULE, `skills[${index}].group "${groupName}"`,
        `skills[${index}].group "${groupName}" must be a neutral category label \u2014 ${NEUTRAL_SKILL_GROUP_RULE} \u2014 or a label that occurs in frozen career data.`);
    }
    return {
      id: id(group.id, `skills[${index}].id`), group: groupName, items,
      evidenceIds,
    };
  });
  unique(skills.map(group => group.id), 'skills');
  return skills;
}

/** Validate a paste response and normalize it into the only renderer input. */
export function validateStructuredResumeDraft(raw, { sourceRoles, evidenceIds, evidenceCatalog, trustedIdentity, careerData } = {}) {
  // The frozen corpus is what the grounding rules below read: role-bullet
  // scope, the blank-trusted-location provenance rule, project and skill
  // occurrence, and the rendered project provenance heading. Defaulting it to
  // an empty string kept the function's name and dropped two of those rules,
  // so a caller that forgot the corpus received a validator that could not
  // fail them — indistinguishable from a résumé that passed.
  if (typeof careerData !== 'string' || !careerData.trim()) {
    configurationFault('careerData must be the frozen career-data corpus this résumé is graded against; without it the role-scope and provenance rules cannot run.');
  }
  const draft = record(raw, 'structured résumé');
  if (draft.schemaVersion !== STRUCTURED_RESUME_SCHEMA_VERSION) fail(`schemaVersion must be "${STRUCTURED_RESUME_SCHEMA_VERSION}".`);
  const verifiedEvidence = evidenceIds ?? evidenceCatalog;
  if (!Array.isArray(verifiedEvidence)) fail('verified evidenceIds must be supplied by the host.');
  const allowedEvidenceIds = unique(verifiedEvidence.map((entry, index) => id(typeof entry === 'string' ? entry : entry?.id, `verified evidenceIds[${index}]`)), 'verified evidenceIds');
  // String-only callers retain backward-compatible ID checking. The paste
  // workflow supplies the source-tagged catalog, letting rendered projects and
  // skill groups require candidate evidence rather than a listing-only link.
  const careerEvidenceIds = verifiedEvidence.some(entry => entry && typeof entry === 'object')
    ? new Set(verifiedEvidence.filter(entry => entry?.sourceId === 'career-data').map(entry => id(entry.id, 'verified evidenceCatalog id')))
    : null;
  const careerEvidenceQuotesById = new Map(verifiedEvidence
    .filter(entry => entry?.sourceId === 'career-data' && typeof entry?.quote === 'string')
    .map(entry => [id(entry.id, 'verified evidenceCatalog id'), entry.quote]));
  const normalizedSourceRoles = normalizeSourceRoles(sourceRoles);
  const sourceById = new Map(normalizedSourceRoles.map(role => [role.id, role]));
  const careerDataRoleRegions = careerEvidenceIds
    ? careerDataRoleRegionsForSourceRoles(careerData, normalizedSourceRoles)
    : new Map();
  if (!Array.isArray(draft.roles) || draft.roles.length !== normalizedSourceRoles.length) {
    fail('roles must retain every trusted source role exactly once.');
  }
  // One collector for every collection this draft walks. Draining it once,
  // after roles, projects and skills have all been measured, is what makes a
  // grounding rule that fires in three roles — or in a role and again in a
  // skill group — one correction round instead of three manual handoffs.
  const offenses = [];
  const roles = draft.roles.map((role, index) => normalizeRole(
    role, index, sourceById, allowedEvidenceIds, careerEvidenceIds, careerData,
    careerEvidenceQuotesById, careerDataRoleRegions, offenses,
  ));
  const roleIds = unique(roles.map(role => role.id), 'roles');
  for (const role of normalizedSourceRoles) if (!roleIds.has(role.id)) fail(`roles is missing trusted source role "${role.id}".`);
  const projects = normalizeProjects(draft.projects, allowedEvidenceIds, careerEvidenceIds, careerEvidenceQuotesById, careerData, offenses);
  const skills = normalizeSkills(draft.skills, allowedEvidenceIds, careerEvidenceIds, careerEvidenceQuotesById, careerData, offenses);
  failOffenses(offenses);
  return {
    schemaVersion: STRUCTURED_RESUME_SCHEMA_VERSION,
    identity: normalizeIdentity(draft.identity, trustedIdentity),
    roles,
    projects,
    skills,
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function separator() { return '<span class="sep" aria-hidden="true">·</span>'; }
function sectionHead(title, id) { return `<div class="section-head"><h2 id="${id}">${escapeHtml(title)}</h2><span class="rule" aria-hidden="true"></span></div>`; }

function renderRole(role) {
  const company = role.company ? `${separator()}<span class="company">${escapeHtml(role.company)}</span>` : '';
  const dates = role.dates ? `<p class="role-dates">${escapeHtml(role.dates)}</p>` : '';
  const summary = role.summary ? `<p class="role-summary">${escapeHtml(role.summary)}</p>` : '';
  const location = role.location ? `<p class="role-location">${escapeHtml(role.location)}</p>` : '';
  const meta = summary || location ? `<div class="role-meta meta-row">${summary}${location}</div>` : '';
  const bullets = role.bullets.map(bullet => {
    return `<li>${escapeHtml(bullet.text)}</li>`;
  }).join('');
  return `<article class="role" itemprop="hasOccupation" itemscope itemtype="https://schema.org/EmployeeRole"><div class="role-header meta-row"><p class="role-title-line"><span class="title">${escapeHtml(role.title)}</span>${company}</p>${dates}</div>${meta}<ul class="highlights">${bullets}</ul></article>`;
}

function sourceProjectHeadings(careerData, projects) {
  return projects.map(project => careerDataProjectProvenanceHeadingForName(careerData, project.name) || 'Selected Systems');
}

function renderProjects(projects, careerData) {
  const headings = sourceProjectHeadings(careerData, projects);
  const groups = new Map();
  projects.forEach((project, index) => {
    const heading = headings[index];
    if (!groups.has(heading)) groups.set(heading, []);
    groups.get(heading).push(project);
  });
  return [...groups.entries()].map(([heading, entries], index) =>
    `<section class="section projects" aria-labelledby="sec-projects-${index}">${sectionHead(heading, `sec-projects-${index}`)}${entries.map(project => `<article class="project"><span class="project-name">${escapeHtml(project.name)}</span>${project.description ? `${separator()}<span class="project-desc">${escapeHtml(project.description)}</span>` : ''}${project.metrics ? `<span class="project-metrics">${escapeHtml(project.metrics)}</span>` : ''}</article>`).join('')}</section>`).join('');
}

/** Build design-system-safe HTML after validating against trusted IDs. */
export function renderStructuredResume(raw, context = {}) {
  const draft = validateStructuredResumeDraft(raw, context);
  const subtitle = draft.identity.subtitleRole
    ? `<span class="subtitle-role" itemprop="jobTitle">${escapeHtml(draft.identity.subtitleRole)}</span>${draft.identity.credential ? `${separator()}<span class="credential">${escapeHtml(draft.identity.credential)}</span>` : ''}`
    : (draft.identity.credential ? `<span class="credential">${escapeHtml(draft.identity.credential)}</span>` : '');
  const header = `<header class="resume-header"><h1 class="name" itemprop="name">${escapeHtml(draft.identity.name)}</h1>${subtitle ? `<p class="tagline">${subtitle}</p>` : ''}<p class="contact" role="group" aria-label="Contact">${draft.identity.contact.map(escapeHtml).join(separator())}</p></header>`;
  const experience = `<section class="section" aria-labelledby="sec-experience">${sectionHead('Experience', 'sec-experience')}${draft.roles.map(renderRole).join('')}</section>`;
  const projects = draft.projects.length ? renderProjects(draft.projects, context.careerData) : '';
  const skills = draft.skills.length ? `<section class="section" aria-labelledby="sec-skills">${sectionHead('Skills', 'sec-skills')}<dl class="skills">${draft.skills.map(group => `<dt>${escapeHtml(group.group)}</dt><dd>${group.items.map(escapeHtml).join(' · ')}</dd>`).join('')}</dl></section>` : '';
  const resumeMainHtml = `<main class="page" role="document" itemscope itemtype="https://schema.org/Person">${header}${experience}${projects}${skills}</main>`;
  // Catch a provenance-bearing project section mismatch before the result is
  // imported, so the next review can remove or revise it instead of reaching
  // a terminal-looking paste that the final renderer will always reject.
  // validateStructuredResumeDraft above has already refused a missing or blank
  // corpus, so this runs whenever there is a project to check.
  const projectFailures = draft.projects.length
    ? resumeProjectProvenanceFailures(resumeMainHtml, context.careerData)
    : [];
  if (projectFailures.length) fail(projectFailures.join(' '));
  return { draft, resumeMainHtml };
}

/** Paste-workflow adapter: only returns markup accepted by the legacy validator. */
export function validateStructuredApplicationResume(resume, context = {}) {
  return validateStructuredResumeDraft(resume, context);
}

export function renderStructuredApplicationResume(resume, { sourceRoles, evidenceCatalog, trustedIdentity, careerData } = {}) {
  return renderStructuredResume(resume, { sourceRoles, evidenceCatalog, trustedIdentity, careerData }).resumeMainHtml;
}
