/**
 * Deterministic renderer for the paste-back application's structured résumé
 * contract. Local AI supplies copy and verified identifiers; this module owns
 * the document structure so an untrusted paste cannot alter the design system.
 */
import { careerDataProjectProvenanceHeadingForName, resumeProjectProvenanceFailures } from './jobApplication.js';
import { titleCaseSkillGroupLabel } from './skillGroupLabel.js';
import { CAREER_SNAPSHOT_CAPABILITY_KINDS, isCareerSkillIndexEligible } from './careerSnapshot.js';

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
// Education and credentials are first-class, compact résumé sections. These
// are structural safety bounds, not an instruction to silently discard a
// candidate's history: authority selection decides relevance before a draft
// reaches this renderer.
const MAX_EDUCATION = 12;
const MAX_CREDENTIALS = 16;
// Structural ceilings, not the design budget: they exist so a pathological
// paste cannot turn one rejection into a megabyte of correction prompt. The
// design system's own budget for this block is 8x tighter and is enforced
// separately below (MAX_DESIGN_SKILL_*), because a résumé that cleared these
// still rendered one row of 11 terms.
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
  education: MAX_EDUCATION,
  credentials: MAX_CREDENTIALS,
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
//
// 'skills', 'technical skills' and 'technologies' were removed from this list:
// each names the SECTION, not a kind of skill. A row labelled with one of them
// restates the <h2>Skills</h2> printed directly above it and gives a parser no
// category axis it did not already have, which is the whole reason the `dt`
// labels are load-bearing (STYLE.md §5.6). 'tools' stays: it is a real domain
// beside Languages and Frameworks. The vocabulary that remains can still
// express a real split (languages / frameworks / infrastructure / platforms /
// integration), which matters because career data carrying no skills section
// of its own leaves this list as the whole vocabulary a responder may draw a
// label from.
//
// SURVEY of every label the design system ships or documents as a skills-row
// `<dt>`, because that is the set this vocabulary has to be able to express:
//   Languages            resume.html:197, preview/component-skills.html:20,
//                        build/multi-page-fragmentation-check.html:227,
//                        uploads/Application.html:1536,
//                        handoff/Application-paginated-example.html:1550,
//                        build/fit-estimate-test.js:441
//   Data & Storage       resume.html:200, preview/component-skills.html:22,
//                        build/multi-page-fragmentation-check.html:229,
//                        build/line-yield-check.html:86
//   Infrastructure       resume.html:203, preview/component-skills.html:24,
//                        build/multi-page-fragmentation-check.html:231
//   Web & Data           uploads/Application.html:1539,
//                        handoff/Application-paginated-example.html:1553
//   Infrastructure & AI  uploads/Application.html:1542,
//                        handoff/Application-paginated-example.html:1556
//   AI/ML                STYLE.md:833 and SKILL.md:696-697 — the `dt`-casing rule's
//                        own example of a label that keeps its own spelling
// STYLE.md §5.6 (STYLE.md:826-828, 843-855) and SKILL.md's Skills-block
// section (SKILL.md:693-701) document the first three in prose and name no
// further domain; the last three come from the two Application fixtures, which
// are real generated output. 'languages' and 'infrastructure' were already
// here; 'data', 'storage', 'web', 'ai' and 'ml' are exactly what that survey
// adds, and every one of those exemplar rows is now reachable.
//
// This was already the case before the section-head synonyms came out, and it
// went from latent to acute with them: a candidate whose career data carries no
// skills section leaves the "occurs verbatim in career data" escape hatch empty,
// so this list IS the whole vocabulary, and a list of single nouns could not
// name a compound domain the design system ships on its own sample page.
// Nothing beyond the survey was added: the list is printed verbatim into the
// résumé prompt and is what a responder picks from, so an entry the design
// system never uses is a domain this app invented and then asked for.
// scripts/tests/paste-application-assembly.js drives every label above through
// the real validator, so an exemplar this vocabulary cannot express fails the
// suite here instead of costing the user a manual correction round.
export const NEUTRAL_SKILL_GROUP_LABELS = Object.freeze([
  'tools', 'languages', 'programming languages',
  'frameworks', 'libraries', 'databases', 'platforms', 'infrastructure', 'integration',
  'systems', 'methods', 'methodologies', 'practices', 'competencies', 'web development',
  // The survey's additions. 'data' and 'storage' carry "Data & Storage" (the
  // shipped sample's own middle row); 'web' carries "Web & Data"; 'ai' carries
  // "Infrastructure & AI"; 'ml' carries the documented "AI/ML", which 'ai'
  // alone leaves half-reachable.
  'data', 'storage', 'web', 'ai', 'ml',
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

// The one separator a rendered skills row is joined by. The row-length gate
// below measures the exact string the renderer emits rather than a second
// guess at it, so the budget can never be enforced against a row nobody sees.
const SKILL_ITEM_SEPARATOR = ' · ';
// The design system's own budget for this block, which the structural ceilings
// above are 8x looser than: a résumé that cleared MAX_SKILL_GROUPS and
// MAX_SKILL_ITEMS_PER_GROUP still rendered ONE row of 11 terms behind a
// 120-character `dd`, and nothing in this app measured it.
//
// Source of truth: "Job Application Design System/build/fit-estimate-test.js"
// lines 171-172 (`skillsRow: 64`, `skillsRows: 3`), which in turn cite
// STYLE.md §5.6 (STYLE.md:797-807) and SKILL.md:670-674 / 755-756: "3 rows,
// one line each, 16-20 terms" and "no skills block over 3 rows / 20 terms".
// That file is a CommonJS build script that runs its whole suite on load and
// exports nothing, so it cannot be imported here. The numbers are restated
// instead, and scripts/tests/paste-application-assembly.js reads that file as
// text and fails the moment either side drifts from the other.
const MAX_DESIGN_SKILL_GROUPS = 3;
const MAX_DESIGN_SKILL_ITEMS = 20;
const MAX_DESIGN_SKILL_ROW_CHARS = 64;
// A block big enough to split must be split. The shipped 3-row sample carries
// 16 terms across 3 rows (5/5/6), so six items is one full row's worth past a
// single row: enough vocabulary to name a second domain, and past the point
// where one `dt` can honestly cover everything under it. Below that a single
// group is still a real answer, so the gate stands down.
const MIN_SPLIT_SKILL_ITEMS = 6;
const MIN_SPLIT_SKILL_GROUPS = 2;
export const STRUCTURED_RESUME_SKILLS_BUDGET = Object.freeze({
  groups: MAX_DESIGN_SKILL_GROUPS,
  items: MAX_DESIGN_SKILL_ITEMS,
  rowChars: MAX_DESIGN_SKILL_ROW_CHARS,
  splitAtItems: MIN_SPLIT_SKILL_ITEMS,
  splitIntoGroups: MIN_SPLIT_SKILL_GROUPS,
});
// The résumé prompt states this budget and the gates read the same constants,
// so the shape a responder is told to write can never drift from the shape it
// is graded by. The rendered row is described by the separator the renderer
// actually joins with, because that is what the character count is measured
// on. The separator prints with its own spaces: a responder counting the row
// without them undercounts by two characters per gap and is rejected for a row
// it had measured as fitting.
export const SKILLS_BLOCK_BUDGET_RULE = `at most ${MAX_DESIGN_SKILL_GROUPS} groups and ${MAX_DESIGN_SKILL_ITEMS} items across the whole block; each group renders as one row of its items joined by "${SKILL_ITEM_SEPARATOR}", separator spaces included, and that row is at most ${MAX_DESIGN_SKILL_ROW_CHARS} characters; and a block carrying ${MIN_SPLIT_SKILL_ITEMS} items or more is sorted into at least ${MIN_SPLIT_SKILL_GROUPS} groups, because one row carrying everything restates the section head instead of sorting anything`;
// STYLE.md §5.6 and SKILL.md:676-688 already say this block holds only nouns a
// recruiter can filter on and never concepts, and prose is all that rule ever
// was: the shipped defect rendered "connectors", "prompt harnessing" and
// "model delegation" beside React and Django. A named product, language,
// platform or acronym shows its name in its own spelling. React, TypeScript,
// Next.js, Django, Nginx, Gunicorn, Docker Compose, MCP, gRPC and iOS all
// carry an uppercase letter or a digit; a lowercase common noun or a concept
// phrase carries neither, which makes the distinction decidable here.
//
// The one real cost: an all-lowercase product name (npm, ffmpeg) is rejected
// with them. That class is commodity tooling, which SKILL.md:687 already bans
// from this block, so nothing the design system wanted kept is refused here.
const FILTERABLE_SKILL_ITEM_RE = /[\p{Lu}\p{Lt}\p{N}]/u;
export const SKILL_ITEM_FILTERABLE_RULE = 'each item is a named product, language, platform or acronym a recruiter can filter on, and a name shows in its spelling: every item carries at least one uppercase letter or digit. Use the canonical spelling “TypeScript”, never “Typescript”. A lowercase common noun, and any phrase naming a concept or an activity rather than a product, belongs in a bullet where it is evidence';
// Grounding compares a career-data quote against the item WITHOUT regard to
// letter case, which is the fact the comparison below has always used but the
// résumé prompt once contradicted. Reading "Tech used: python" grounds the
// item "Python" (the capitalization the item must show), and reading
// "Typescript" grounds "TypeScript"; the résumé contract interpolates this so
// the filterable-noun rule and this one can never disagree on what lands.
export const SKILL_ITEM_GROUNDING_RULE = 'a skill item is grounded when a career-data quote its own group cites contains that name as a whole term, compared without regard to letter case, so a quote reading “Tech used: python” grounds the item “Python” (which is the capitalization the item must show) and a quote reading “Typescript” grounds “TypeScript”';
// A posting can name a technology the candidate corpus went on to attest, and
// nothing below ever required that technology to reach the rendered block: a
// résumé shipped "Programming Languages: SQL" while "Are proficient in Python
// and TypeScript" sat in the posting and both names sat in career data. The
// block is the index a recruiter filters on, so a posting-named, career-attested
// name that is missing must be named. The vocabulary is CLOSED and host-owned
// (never derived from the corpus): a derived list would let a posting quote
// name a commodity word and silently re-open the filterable-noun gate this
// exists beside. Ambiguous/commodity names (Go, R, C, Git, npm, Jira) are
// deliberately absent for the same reason.
export const POSTING_NAMED_SKILL_TERMS = Object.freeze([
  'Python', 'TypeScript', 'JavaScript', 'Java', 'Kotlin', 'Swift', 'Scala', 'Ruby', 'PHP', 'Rust',
  'Golang', 'C++', 'C#', 'Perl', 'Haskell', 'Elixir', 'Erlang', 'Clojure', 'Objective-C', 'MATLAB',
  'Bash', 'PowerShell', 'SQL', 'Dart', 'Lua', 'Julia', 'Groovy', 'HTML', 'CSS',
  'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'Cassandra', 'DynamoDB', 'Elasticsearch', 'SQLite', 'Snowflake', 'BigQuery',
  'Redshift', 'Kafka', 'Spark', 'Airflow', 'Hadoop', 'Tableau', 'Power BI', 'AWS', 'GCP', 'Azure',
  'Docker Compose', 'Docker', 'Kubernetes', 'Terraform', 'Ansible', 'Jenkins', 'Nginx', 'Gunicorn', 'React', 'Angular', 'Vue', 'Node.js', 'Next.js',
  'Django', 'Flask', 'FastAPI', 'Spring', 'Rails', 'GraphQL', 'TensorFlow', 'PyTorch', 'Pandas', 'NumPy',
]);
// Names that are also ordinary English words are matched CASE-SENSITIVELY on
// BOTH the listing side and the career side: a posting writing "a spring
// release" must not demand the framework Spring, and a career line writing
// a swift migration must not attest Swift. Every other
// name is matched case-insensitively, because the corpus's own casing is
// unreliable (the reported package spelled TypeScript "Typescript").
const POSTING_NAMED_SKILL_CASE_SENSITIVE = new Set(['Ruby', 'Swift', 'Rust', 'Dart', 'Julia', 'Spark', 'Spring', 'Flask', 'Angular', 'Azure', 'Groovy']);
// The one ceiling the résumé prompt and the gate share, so a responder is
// never asked to carry more names than the gate will ever demand.
export const MAX_REQUIRED_POSTING_SKILL_TERMS = 10;
// The full plan deliberately catalogs more than the final résumé uses, so the
// skills index needs a relevance-preserving ceiling rather than an instruction
// to dump every historical technology onto every application. Ten terms fit
// comfortably inside the design system's three-row / twenty-term budget and
// are enough to prevent the one-token block that exposed this gap.
export const MAX_REQUIRED_CAREER_SKILL_TERMS = 10;

// Snapshot-backed jobs carry this small, immutable projection of the approved
// career profile.  It intentionally contains only profile-declared skills and
// their audited segment IDs: the profile validator has already established
// that each name is literally demonstrated by those segments.  Do not infer
// names from raw career text here; an incidental mention is not a skill.
// v2 is a distinct current wire contract. It carries the support metadata
// needed to prove that a bare skills item came from separate direct evidence.
// v1 remains an explicit read-only compatibility format for jobs frozen from
// v5-or-earlier career snapshots; do not treat v1 as an extensible v2 object.
export const CAREER_SNAPSHOT_SKILL_EVIDENCE_VERSION = 'career-snapshot-skills.v2';
export const CAREER_SNAPSHOT_HISTORICAL_SKILL_EVIDENCE_VERSION = 'career-snapshot-skills.v1';
const CURRENT_CAPABILITY_KINDS = new Set(CAREER_SNAPSHOT_CAPABILITY_KINDS);

function snapshotCareerSkills(careerSkillEvidence) {
  if (careerSkillEvidence == null) return null;
  const version = careerSkillEvidence?.version;
  const current = version === CAREER_SNAPSHOT_SKILL_EVIDENCE_VERSION;
  const historical = version === CAREER_SNAPSHOT_HISTORICAL_SKILL_EVIDENCE_VERSION;
  if (!careerSkillEvidence || (!current && !historical)
    || !Array.isArray(careerSkillEvidence.skills)) {
    configurationFault('careerSkillEvidence must be the frozen v2 approved-snapshot skill projection, an explicit historical v1 projection, or null for a legacy job.');
  }
  const ids = new Set();
  const names = new Set();
  return careerSkillEvidence.skills.map((skill, index) => {
    const id = typeof skill?.id === 'string' ? skill.id.trim() : '';
    const name = typeof skill?.name === 'string' ? skill.name.trim() : '';
    const evidenceSegmentIds = Array.isArray(skill?.evidenceSegmentIds) ? skill.evidenceSegmentIds : [];
    if (!id || !name || ids.has(id) || names.has(name.toLocaleLowerCase())
      || !evidenceSegmentIds.length || evidenceSegmentIds.some(segmentId => typeof segmentId !== 'string' || !segmentId.trim())) {
      configurationFault(`careerSkillEvidence.skills[${index}] is not an approved, evidence-linked skill.`);
    }
    const carriesCurrentSupport = skill && typeof skill === 'object'
      && (skill.supportMode != null || skill.directEvidenceSegmentIds != null || skill.capabilityKind != null);
    const directEvidenceSegmentIds = Array.isArray(skill?.directEvidenceSegmentIds)
      ? skill.directEvidenceSegmentIds
      : [];
    if (current) {
      if (!carriesCurrentSupport || !CURRENT_CAPABILITY_KINDS.has(skill?.capabilityKind)
        || typeof skill?.indexEligible !== 'boolean') {
        configurationFault(`careerSkillEvidence.skills[${index}] is missing complete v2 taxonomy/support metadata.`);
      }
      if (!['direct', 'relationship-qualified'].includes(skill?.supportMode)
        || !Array.isArray(skill?.directEvidenceSegmentIds)
        || directEvidenceSegmentIds.some(segmentId => typeof segmentId !== 'string' || !segmentId.trim())
        || new Set(directEvidenceSegmentIds).size !== directEvidenceSegmentIds.length
        || directEvidenceSegmentIds.some(segmentId => !evidenceSegmentIds.includes(segmentId))) {
        configurationFault(`careerSkillEvidence.skills[${index}] has an invalid current support-mode projection.`);
      }
      // v2 is the centralized, direct inventory rather than a general
      // profile-skill transport. A relationship-qualified or false-eligible
      // row would be easy for downstream term matching to flatten into a
      // standalone skill, so it belongs only in the relation-aware career
      // evidence catalog. The historical v1 path below intentionally retains
      // its frozen shape and behavior.
      if (skill.supportMode !== 'direct' || skill.indexEligible !== true || !directEvidenceSegmentIds.length) {
        configurationFault(`careerSkillEvidence.skills[${index}] must be a direct, index-eligible v2 inventory skill with separately cited direct evidence.`);
      }
      if (skill.indexEligible !== isCareerSkillIndexEligible({ ...skill, name, evidenceSegmentIds, directEvidenceSegmentIds })) {
        configurationFault(`careerSkillEvidence.skills[${index}] has an eligibility value inconsistent with its audited v2 support metadata.`);
      }
    } else if (carriesCurrentSupport) {
      configurationFault(`careerSkillEvidence.skills[${index}] mixes v1 with v2 support metadata.`);
    }
    ids.add(id); names.add(name.toLocaleLowerCase());
    const normalized = {
      id,
      name,
      // Older approved snapshots have no editorial eligibility classification.
      // `null` deliberately means "may be rendered only under its exact
      // approved spelling, but is not forced into every ATS index". A future
      // profile projection can opt a skill in with true or exclude it with
      // false without reintroducing a hardcoded vocabulary.
      indexEligible: current
        ? isCareerSkillIndexEligible({ ...skill, name, evidenceSegmentIds, directEvidenceSegmentIds })
        : skill.indexEligible === true ? true : skill.indexEligible === false ? false : null,
      evidenceSegmentIds: [...new Set(evidenceSegmentIds)],
    };
    if (current) {
      normalized.capabilityKind = skill.capabilityKind;
      normalized.supportMode = skill.supportMode;
      normalized.directEvidenceSegmentIds = [...directEvidenceSegmentIds];
    }
    return normalized;
  });
}

// A one- or two-character profile skill (for example C or R) is real only in
// its displayed capitalization.  This prevents ordinary prose such as "we
// can" or "are" from becoming a job requirement while retaining arbitrary
// novel product and technology names in the ordinary case-insensitive path.
function snapshotSkillTermOccurs(name, text) {
  const flags = [...String(name || '')].length <= 2 ? 'u' : 'iu';
  return quotedEvidenceHasTerm(name, [String(text ?? '')], flags);
}

function snapshotSkillEvidenceSupports(skill, careerEntries) {
  return careerEntries.some(entry => snapshotSkillTermOccurs(skill.name, entry.quote));
}

function snapshotRequiredSkillTerms(evidenceCatalog, careerSkillEvidence, { postingOnly = false } = {}) {
  const skills = snapshotCareerSkills(careerSkillEvidence);
  if (skills == null || !Array.isArray(evidenceCatalog)) return null;
  const entries = evidenceCatalog.filter(entry => entry && typeof entry.quote === 'string');
  const listingEntries = entries.filter(entry => entry.sourceId === 'job-listing');
  const careerEntries = entries.filter(entry => entry.sourceId === 'career-data');
  if (!listingEntries.length || !careerEntries.length) return [];
  const ranked = skills
    .filter(skill => skill.indexEligible === true)
    // A profile skill remains source-limited: only require it where the
    // accepted plan carries career evidence that actually names it.
    .filter(skill => snapshotSkillEvidenceSupports(skill, careerEntries))
    .filter(skill => !postingOnly || listingEntries.some(entry => snapshotSkillTermOccurs(skill.name, entry.quote)))
    .map((skill, index) => {
      const listingMatches = listingEntries.filter(entry => snapshotSkillTermOccurs(skill.name, entry.quote));
      return {
        name: skill.name,
        bestPriority: listingMatches.length
          ? listingMatches.reduce((best, entry) => Math.min(best, PRIORITY_RANK.get(entry.priority) ?? 3), 3)
          : 4,
        firstListingIndex: listingMatches.length ? listingEntries.indexOf(listingMatches[0]) : Number.MAX_SAFE_INTEGER,
        index,
      };
    })
    .sort((left, right) => left.bestPriority - right.bestPriority
      || left.firstListingIndex - right.firstListingIndex || left.index - right.index)
    .map(entry => entry.name);
  return ranked.slice(0, postingOnly ? MAX_REQUIRED_POSTING_SKILL_TERMS : MAX_REQUIRED_CAREER_SKILL_TERMS);
}

function postingNamedSkillTermOccurs(name, text) {
  const flags = POSTING_NAMED_SKILL_CASE_SENSITIVE.has(name) ? 'u' : 'iu';
  return quotedEvidenceHasTerm(name, [String(text ?? '')], flags);
}

// Prefer the precise product name when the same source text also makes its
// parent token match. “Docker Compose” should produce one useful ATS term, not
// the redundant pair “Docker Compose · Docker”. A standalone Docker mention
// remains Docker because the more specific name is then absent.
function preferSpecificSkillTerms(names) {
  const uniqueNames = [...new Set(names)];
  if (uniqueNames.includes('Docker Compose')) {
    return uniqueNames.filter(name => name !== 'Docker');
  }
  return uniqueNames;
}

const PRIORITY_RANK = new Map([['highest', 0], ['high', 1], ['supporting', 2]]);

/**
 * The canonical posting-named technology names that are REQUIRED for this
 * résumé: at least one accepted job-listing quote states the name and at
 * least one accepted career-data quote also states it, matched as a whole
 * term under the same per-name case rule. A string-only evidence list cannot
 * say which quotes came from the posting, so the rule stands down ([]) when
 * either source is absent — the same stand-down the project/listing rules use.
 * Deliberately never throws: it reads a candidate response.
 */
export function postingNamedAttestedSkillTerms(evidenceCatalog, careerSkillEvidence = null) {
  const snapshotTerms = snapshotRequiredSkillTerms(evidenceCatalog, careerSkillEvidence, { postingOnly: true });
  if (snapshotTerms != null) return snapshotTerms;
  if (!Array.isArray(evidenceCatalog)) return [];
  const entries = evidenceCatalog.filter(entry => entry && typeof entry.quote === 'string');
  const listingEntries = entries.filter(entry => entry.sourceId === 'job-listing');
  const careerEntries = entries.filter(entry => entry.sourceId === 'career-data');
  if (!listingEntries.length || !careerEntries.length) return [];
  const required = [];
  for (const name of POSTING_NAMED_SKILL_TERMS) {
    if (!listingEntries.some(entry => postingNamedSkillTermOccurs(name, entry.quote))) continue;
    if (!careerEntries.some(entry => postingNamedSkillTermOccurs(name, entry.quote))) continue;
    // Best (lowest-rank) priority across the listing entries naming it; an
    // unranked entry ranks below the lowest ranked one, so an accidental
    // mention can never outrank an explicit requirement.
    const bestPriority = listingEntries
      .filter(entry => postingNamedSkillTermOccurs(name, entry.quote))
      .reduce((best, entry) => Math.min(best, PRIORITY_RANK.get(entry.priority) ?? 3), 3);
    const firstListingIndex = listingEntries.findIndex(entry => postingNamedSkillTermOccurs(name, entry.quote));
    const vocabularyIndex = POSTING_NAMED_SKILL_TERMS.indexOf(name);
    required.push({ name, bestPriority, firstListingIndex, vocabularyIndex });
  }
  required.sort((left, right) =>
    left.bestPriority - right.bestPriority
    || left.firstListingIndex - right.firstListingIndex
    || left.vocabularyIndex - right.vocabularyIndex);
  return preferSpecificSkillTerms(required.map(entry => entry.name))
    .slice(0, MAX_REQUIRED_POSTING_SKILL_TERMS);
}

/** Required posting-named terms no skills item carries as a whole term. */
export function missingPostingNamedSkillTerms(skills, evidenceCatalog, careerSkillEvidence = null) {
  const required = postingNamedAttestedSkillTerms(evidenceCatalog, careerSkillEvidence);
  if (!required.length) return [];
  const items = (Array.isArray(skills) ? skills : [])
    .flatMap(group => (group && Array.isArray(group.items) ? group.items : []))
    .filter(item => typeof item === 'string');
  return required.filter(name => !items.some(item => (careerSkillEvidence != null ? snapshotSkillTermOccurs(name, item) : postingNamedSkillTermOccurs(name, item))));
}

export const POSTING_NAMED_SKILLS_RULE = `the skills block is the index a recruiter or applicant-tracking filter reads, so it carries every technology name from this list — ${POSTING_NAMED_SKILL_TERMS.join(', ')} — that one of the accepted plan’s job-listing quotes states and that one of the accepted plan’s career-data quotes also states, each matched as a whole term without regard to letter case (the ordinary-English-word names are matched case-sensitively), and never more than ${MAX_REQUIRED_POSTING_SKILL_TERMS} such names, highest-priority first; write each in the capitalization the list shows even where the career data writes it in lowercase, file it under the group that fits it, and cite the career-data quote that states it; to make room, drop terms this posting never asks about, never a name it asks for`;
const POSTING_NAMED_SKILL_TERM_RULE = 'skill-block-omits-posting-named-attested-term';

/**
 * Vocabulary names the accepted plan's career-data quotes state, whether or
 * not the posting names them. The posting-named rule above is silent for a
 * posting that names no technology at all (a generic "Full Stack Developer"
 * listing), and a silent gate plus an optional schema field let a résumé ship
 * with no Skills section: the design system says never to delete it, because
 * its terms are what an applicant-tracking filter reads off the section header
 * and a stack-shaped résumé without one reads as an omission. This is the
 * floor beneath that rule, and like it stands down ([]) without BOTH halves of
 * a source-tagged catalog, since a string-only list cannot say the catalog came
 * from the paste workflow. It is satisfiable by construction: a name returned
 * here sits inside a plan quote a skill group may cite, carries an uppercase
 * letter (the filterable-item rule) and is matched under the same per-name
 * case rule the coverage gate uses. Deliberately never throws.
 */
export function careerAttestedSkillTerms(evidenceCatalog, careerSkillEvidence = null) {
  const snapshotTerms = snapshotRequiredSkillTerms(evidenceCatalog, careerSkillEvidence);
  if (snapshotTerms != null) return snapshotTerms;
  if (!Array.isArray(evidenceCatalog)) return [];
  const entries = evidenceCatalog.filter(entry => entry && typeof entry.quote === 'string');
  if (!entries.some(entry => entry.sourceId === 'job-listing')) return [];
  const careerEntries = entries.filter(entry => entry.sourceId === 'career-data');
  return preferSpecificSkillTerms(POSTING_NAMED_SKILL_TERMS
    .filter(name => careerEntries.some(entry => postingNamedSkillTermOccurs(name, entry.quote))));
}

/**
 * A bounded, deterministic skill index for this résumé. Posting-named terms
 * come first; the remainder are ranked by the accepted career evidence's own
 * priority and order. This uses the plan rather than raw careerData so every
 * required term is guaranteed to have a citation the skills group can carry.
 */
export function requiredCareerAttestedSkillTerms(evidenceCatalog, careerSkillEvidence = null) {
  const snapshotTerms = snapshotRequiredSkillTerms(evidenceCatalog, careerSkillEvidence);
  if (snapshotTerms != null) return snapshotTerms;
  if (!Array.isArray(evidenceCatalog)) return [];
  const entries = evidenceCatalog.filter(entry => entry && typeof entry.quote === 'string');
  if (!entries.some(entry => entry.sourceId === 'job-listing')) return [];
  const careerEntries = entries.filter(entry => entry.sourceId === 'career-data');
  if (!careerEntries.length) return [];
  const postingRequired = postingNamedAttestedSkillTerms(entries);
  const postingSet = new Set(postingRequired);
  const remainder = careerAttestedSkillTerms(entries)
    .filter(name => !postingSet.has(name))
    .map(name => {
      const matches = careerEntries.filter(entry => postingNamedSkillTermOccurs(name, entry.quote));
      return {
        name,
        bestPriority: matches.reduce((best, entry) => Math.min(best, PRIORITY_RANK.get(entry.priority) ?? 3), 3),
        firstCareerIndex: careerEntries.findIndex(entry => postingNamedSkillTermOccurs(name, entry.quote)),
        vocabularyIndex: POSTING_NAMED_SKILL_TERMS.indexOf(name),
      };
    })
    .sort((left, right) => left.bestPriority - right.bestPriority
      || left.firstCareerIndex - right.firstCareerIndex
      || left.vocabularyIndex - right.vocabularyIndex)
    .map(entry => entry.name);
  return preferSpecificSkillTerms([...postingRequired, ...remainder])
    .slice(0, MAX_REQUIRED_CAREER_SKILL_TERMS);
}

export function missingRequiredCareerSkillTerms(skills, evidenceCatalog, careerSkillEvidence = null) {
  const required = requiredCareerAttestedSkillTerms(evidenceCatalog, careerSkillEvidence);
  const items = (Array.isArray(skills) ? skills : [])
    .flatMap(group => (group && Array.isArray(group.items) ? group.items : []))
    .filter(item => typeof item === 'string');
  return required.filter(name => !items.some(item => (careerSkillEvidence != null ? snapshotSkillTermOccurs(name, item) : postingNamedSkillTermOccurs(name, item))));
}

// Kept under its established exported name because queued prompts interpolate
// it, but this is now a completeness rule rather than a mere presence floor.
export const SKILLS_BLOCK_PRESENCE_RULE = `the skills block is not optional once the accepted plan’s career-data quotes state a technology name from the coverage list above. It carries the complete prioritized index returned by the same rule: every posting-named, career-attested name first, then the highest-priority remaining career-attested names in evidence order, up to ${MAX_REQUIRED_CAREER_SKILL_TERMS} names total. This is a bounded recruiter and applicant-tracking index, not permission to ship one token or to dump every historical keyword. Write each name in the capitalization the list shows, file it under the neutral domain label that fits it, and cite the career-data quote that states it. Where page space is short, tighten a bullet or drop a project rather than hollowing out this block`;
const SKILLS_BLOCK_PRESENCE_RULE_ID = 'skills-block-omits-prioritized-career-attested-term';
const TYPESCRIPT_TOKEN_RE = /\btypescript\b/giu;
const TYPESCRIPT_SPELLING_RULE = 'canonical-typescript-spelling';

function hasNonCanonicalTypeScript(value) {
  return [...String(value || '').matchAll(TYPESCRIPT_TOKEN_RE)]
    .some(match => match[0] !== 'TypeScript');
}

/* A browser renderer does not repair prose, so an apparently harmless
 * misspelling in structured copy reaches both the HTML and the PDF.  Reject
 * it at the structured-resume boundary, which is exercised before a résumé
 * draft is persisted and again for every review replacement.  That keeps the
 * accepted review, its audit, and the recruiter-facing render on identical
 * text; a late display-only rewrite would not. */
function collectNonCanonicalTypeScriptOffenses(roles, projects, skills, offenses) {
  for (const [roleIndex, role] of roles.entries()) {
    for (const [bulletIndex, bullet] of role.bullets.entries()) {
      if (hasNonCanonicalTypeScript(bullet.text)) {
        offend(offenses, TYPESCRIPT_SPELLING_RULE, `roles[${roleIndex}].bullets[${bulletIndex}].text`,
          `roles[${roleIndex}].bullets[${bulletIndex}].text uses “Typescript”; write the canonical product name “TypeScript”.`);
      }
    }
  }
  for (const [groupIndex, group] of skills.entries()) {
    for (const [itemIndex, item] of group.items.entries()) {
      if (hasNonCanonicalTypeScript(item)) {
        offend(offenses, TYPESCRIPT_SPELLING_RULE, `skills[${groupIndex}].items[${itemIndex}]`,
          `skills[${groupIndex}].items[${itemIndex}] uses “Typescript”; write the canonical product name “TypeScript”.`);
      }
    }
  }
  for (const [projectIndex, project] of projects.entries()) {
    for (const [field, value] of Object.entries({
      name: project.name,
      description: project.description,
      metrics: project.metrics,
    })) {
      if (hasNonCanonicalTypeScript(value)) {
        offend(offenses, TYPESCRIPT_SPELLING_RULE, `projects[${projectIndex}].${field}`,
          `projects[${projectIndex}].${field} uses “Typescript”; write the canonical product name “TypeScript”.`);
      }
    }
  }
}
// The `<dt>` casing rule lives in its own import-free module and is
// re-exported here, where the résumé contract's consumers read it: the second
// renderer that writes into this same `<dl class="skills">` is resumeHtml.js,
// and an import edge from there to this module closes a cycle that kills the
// suite at module link. See skillGroupLabel.js for the whole reason and the
// rule itself.
export { titleCaseSkillGroupLabel };
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
  // A valid approved career can be project-, education-, certification-, or
  // standalone-evidence-led. Requiring a historical employer record here
  // turned that truthful profile into a renderer configuration error.
  if (!Array.isArray(sourceRoles)) fail('trusted sourceRoles must be an array.');
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

// The contact row on a résumé or a cover letter is how a reader reaches the
// candidate. Career data commonly states work-authorization facts in the same
// header block, and the evidence-plan responder, told to copy identity out of
// career data, carries them straight onto both documents — a shipped letterhead
// read `… · Canadian citizenship · Willing to work anywhere. Can obtain TN-Visa
// without sponsorship.` Those questions belong on the employer's own
// application form, which is where they are actually answered.
//
// Scoped to the contact row, and deliberately NOT a prose classifier: reading
// this vocabulary over career prose measured 15 false positives on 24 ordinary
// lines (`citizen developers`, `Visa payment network`), which is why the
// legal-status GATES were deleted on 2026-09-21. A contact element is a short
// channel value, never a sentence about the work, so those second readings do
// not arise here. This also drops rather than rejects: the failure mode is one
// missing line a reader can see, never a refused round or a rewritten document.
const APPLICATION_LOGISTICS_CONTACT_RE = new RegExp([
  'citizen(?:ship)?', 'nationality', 'permanent resident(?:ncy|s)?', 'green card',
  'work(?:ing)? (?:status|authori[sz]ation|permit|eligibility)',
  '(?:authori[sz]ed|eligible|permitted) to work', 'right to work',
  'visas?', 'sponsor(?:s|ed|ing|ship)?', 'relocat\\w*',
  'willing to (?:work|relocate|travel|commute)',
  'notice period', 'start date', 'availability',
].join('|'), 'iu');

// A value that carries an email address, a link, or a phone number IS a way to
// reach the candidate, whatever else it says, so it is never dropped. This is
// what keeps the rule above from ever costing a real contact channel.
const CONTACT_CHANNEL_RE = /@[\w-]+\.[a-z]{2,}|https?:\/\/|\b[\w-]+\.(?:com|net|org|io|dev|me|co|ca|uk)\b|\d[\d\s().+-]{6,}\d/iu;

function isReachableContactValue(value) {
  const entry = String(value ?? '');
  if (CONTACT_CHANNEL_RE.test(entry)) return true;
  return !APPLICATION_LOGISTICS_CONTACT_RE.test(entry);
}

/**
 * Keep only the contact values that are ways to reach the candidate.
 *
 * The app owns this row rather than the responder — `pasteApplicationAssembly.js`
 * has said so in a comment since before this existed: "A backend-projected
 * identity is preferred because it prevents an AI from choosing which contact
 * fragments to expose." Applied where the identity is frozen, so every later
 * stage repeats an already-projected list and no round is spent on it.
 *
 * Never returns empty: a contact row is required, and a career file with no
 * reachable value at all is a different problem than this one solves.
 */
export function projectContactChannels(contact) {
  if (!Array.isArray(contact)) return contact;
  const kept = contact.filter(isReachableContactValue);
  return kept.length ? kept : contact;
}

/** Project a frozen identity's contact row. Idempotent; other fields are untouched. */
export function projectTrustedIdentity(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return identity;
  const contact = projectContactChannels(identity.contact);
  return contact === identity.contact ? identity : { ...identity, contact };
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
      ? projectContactChannels(trusted.contact.map((entry, index) => text(entry, `trustedIdentity.contact[${index}]`, { required: true, max: MAX_LONG_TEXT })))
      : fail('trustedIdentity.contact must be an array.');
    for (const key of ['name', 'subtitleRole', 'credential']) {
      equalTrustedIdentityValue(normalized[key], text(trusted[key], `trustedIdentity.${key}`, { required: key === 'name', max: key === 'credential' ? MAX_LONG_TEXT : MAX_SHORT_TEXT }), `identity.${key}`);
    }
    // Compare what the app will actually render. A responder that echoed an
    // identity frozen before this projection existed still matches, and the
    // rendered row is the projected one either way.
    normalized.contact = projectContactChannels(normalized.contact);
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

const ROLE_BULLET_EVIDENCE_REUSE_RULE = 'bullet-cites-evidence-already-spent-in-role';
// A shipped résumé once padded a starved role by splitting one accomplishment
// into several bullets instead of writing a second one: nine bullets across a
// single role cited only four distinct career-data evidence IDs, one ID
// backing three bullets at once. No grounding rule saw it, because every one
// of those nine bullets, read alone, cited real evidence — the defect only
// exists ACROSS a role's bullets, in an ID an earlier bullet had already
// spent, and nothing before this compared a bullet's citation to its
// siblings'.
//
// A later bullet whose career-data IDs are a SUBSET of an earlier bullet's is
// not a second accomplishment; it reports the same one a second time under a
// different sentence. A later bullet that cites even one career-data ID no
// earlier bullet in the role cites still passes, because it carries a fact
// the role did not already have on the page.
export const ROLE_BULLET_EVIDENCE_EXCLUSIVITY_RULE = 'each bullet must cite at least one career-data evidence id that no earlier bullet in that same role already cites, because a later bullet whose career-data ids are all already cited by an earlier one reports that same source accomplishment a second time rather than a new one';

function normalizeRole(raw, index, sourceById, allowedEvidenceIds, careerEvidenceIds, careerData, careerEvidenceQuotesById, careerDataRoleRegions, offenses, authorityMode = false) {
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
  } else if (normalized.location && authorityMode) {
    fail(`roles[${index}].location must be omitted because its approved structured authority role has no location field.`);
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
  // As with roles and skills, a sparse array must be rejected at the boundary
  // rather than carried as a hole into later prose and spelling checks.
  normalized.bullets = Array.from(role.bullets, (rawBullet, bulletIndex) => {
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
        || careerQuotes.some(quote => !careerQuoteOccursInRoleCareerRegion(quote, careerRegion))) {
        offend(bulletOffenses, ROLE_BULLET_SCOPE_RULE, `roles[${index}].bullets[${bulletIndex}]`,
          `roles[${index}].bullets[${bulletIndex}] must cite career-data evidence only from the trusted role's career-data section.`);
      } else if (planBodyQuotes.length && !careerQuotes.some(quote => quoteReachesSectionBody(quote, careerRegion, bodyStart))) {
        offend(bulletOffenses, ROLE_BULLET_OPENING_BLOCK_RULE, `roles[${index}].bullets[${bulletIndex}]`,
          `roles[${index}].bullets[${bulletIndex}] cites career-data evidence only from inside that employer's career-data section opening block — ${CAREER_SECTION_OPENING_BLOCK_RULE}. `
          + 'The résumé prints those three from the saved work history already, so this bullet has nothing else to rewrite and can only restate the role header. '
          + `The accepted evidence plan carries ${planBodyQuotes.length === 1 ? 'one career-data item' : `${planBodyQuotes.length} career-data items`} quoting that same section below its opening block: cite ${planBodyQuotes.length === 1 ? 'it' : 'at least one of them'} here instead, and write the bullet from what it says about the work.`);
      }
    }
  } else if (!authorityMode && careerEvidenceIds) {
    // A role heading on the rendered résumé is itself an employer attribution.
    // When the saved free-text career data has no unique section boundary, a
    // citation cannot inherit that attribution merely by being selected for the
    // role.  Require the cited record to name the employer itself.  Structured
    // authority jobs take the other safe route: their immutable achievement /
    // skill relationship is validated by applicationCareerAuthority.js.
    for (const [bulletIndex, bullet] of normalized.bullets.entries()) {
      if (!evidenceAccepted[bulletIndex]) continue;
      const citedCareerEvidenceIds = bullet.evidenceIds.filter(evidenceId => careerEvidenceIds.has(evidenceId));
      const careerQuotes = careerQuotesForEvidenceIds(citedCareerEvidenceIds, careerEvidenceQuotesById);
      if (!citedCareerEvidenceIds.length || careerQuotes.length !== citedCareerEvidenceIds.length
        || !careerQuotes.some(quote => quoteExplicitlyEstablishesRoleScope(quote, source))) {
        offend(bulletOffenses, ROLE_BULLET_SCOPE_RULE, `roles[${index}].bullets[${bulletIndex}]`,
          `roles[${index}].bullets[${bulletIndex}] is nested under ${JSON.stringify(source.company || source.title)}, but its cited career-data evidence has no uniquely recognized role section and does not explicitly name that role's employer. Cite evidence that names the employer, or use an approved structured role relationship.`);
      }
    }
  }
  // Scoping a bullet to its own role's career section (above) cannot catch two
  // bullets IN that same role citing the same career-data ID: each one, read
  // alone, is properly grounded. Only comparing a role's bullets against each
  // other catches it. `careerEvidenceIds` is null for the legacy string-only
  // evidence lists, which cannot say which IDs are career-data at all, so this
  // stands down exactly where the career-evidence rule above already does.
  if (careerEvidenceIds) {
    const careerIdsByBullet = normalized.bullets.map((bullet, bulletIndex) =>
      (evidenceAccepted[bulletIndex] ? new Set(bullet.evidenceIds.filter(evidenceId => careerEvidenceIds.has(evidenceId))) : null));
    for (const [bulletIndex, bullet] of normalized.bullets.entries()) {
      const laterIds = careerIdsByBullet[bulletIndex];
      if (!laterIds) continue;
      for (let earlierIndex = 0; earlierIndex < bulletIndex; earlierIndex += 1) {
        const earlierIds = careerIdsByBullet[earlierIndex];
        if (!earlierIds || ![...laterIds].every(evidenceId => earlierIds.has(evidenceId))) continue;
        const earlierBullet = normalized.bullets[earlierIndex];
        const shared = [...laterIds];
        offend(bulletOffenses, ROLE_BULLET_EVIDENCE_REUSE_RULE, `roles[${index}].bullets[${bulletIndex}]`,
          `roles[${index}] bullets "${earlierBullet.id}" and "${bullet.id}" both rest on career-data evidence ${shared.length === 1 ? 'id' : 'ids'} ${shared.map(evidenceId => `"${evidenceId}"`).join(', ')} with no career-data id of its own beyond ${shared.length === 1 ? 'that one' : 'those'}: two bullets reporting one source accomplishment, not two. Combine "${earlierBullet.id}" and "${bullet.id}" into a single bullet, or cite a career-data evidence id that no other bullet in roles[${index}] cites.`);
        // One offense per fragmented bullet is enough to fix it; the earliest
        // match already names the accomplishment it duplicates.
        break;
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

// Evidence-plan/assembly source matching treats a line wrap as whitespace,
// while location metadata intentionally remains a case-sensitive literal.
// Keep those contracts separate: a wrapped approved quote can still inherit a
// uniquely identified legacy role section, but a location may not become a
// fuzzy match merely because this provenance helper was introduced.
function careerQuoteOccursInRoleCareerRegion(quote, region) {
  const source = String(region || '');
  const candidate = String(quote || '');
  if (source.includes(candidate)) return true;
  const collapseWhitespace = value => String(value || '').replace(/\s+/gu, ' ').trim();
  const normalizedCandidate = collapseWhitespace(candidate);
  return Boolean(normalizedCandidate && collapseWhitespace(source).includes(normalizedCandidate));
}

function roleMatchText(value) {
  return String(value || '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function containsRoleMatch(haystack, needle) {
  const normalizedNeedle = roleMatchText(needle);
  if (!normalizedNeedle) return false;
  return ` ${roleMatchText(haystack)} `.includes(` ${normalizedNeedle} `);
}

// This is deliberately a scope test, not a keyword policy: the source may
// write the employer with punctuation or casing different from the rendered
// role, but it must still carry the employer's complete normalized name. A
// title alone is often shared by several jobs and cannot establish employer
// attribution. Roles without employers are intentionally out of scope here.
function quoteExplicitlyEstablishesRoleScope(quote, role) {
  const company = String(role?.company || '').trim();
  return Boolean(company && containsRoleMatch(quote, company));
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
    // Snapshot projections carry an immutable role ID in their heading. It is
    // the only reliable discriminator when one employer appears in multiple
    // roles, so do not mix its exact match with legacy fuzzy candidates.
    const roleMarker = `[Role ID: ${role.id}]`;
    const markedStarts = lines
      .filter(line => markdownHeading(line.text)?.label.includes(roleMarker))
      .map(line => line.start);
    if (markedStarts.length) {
      candidates.push(...markedStarts);
      continue;
    }
    // An employer-named Markdown heading is the explicit, high-confidence
    // section form.  Its immediately following title line is descriptive
    // content, not a second possible section boundary.  Treating both as
    // candidates made the ordinary, readable form
    //
    //   ## Employer
    //   Role title
    //   accomplishment mentioning Employer
    //
    // ambiguous merely because the fallback title/employer scan could see
    // the employer later in that same section.  The fallback is for sources
    // *without* an employer heading; it must not compete with one.  Multiple
    // employer headings remain multiple candidates and therefore correctly
    // fail closed below.
    const headingStarts = lines
      .filter(line => {
        const heading = markdownHeading(line.text);
        return Boolean(heading && (role.company
          ? containsRoleMatch(heading.label, role.company)
          : containsRoleMatch(heading.label, role.title)));
      })
      .map(line => line.start);
    if (headingStarts.length) {
      candidates.push(...headingStarts);
      continue;
    }
    for (let index = 0; index < lines.length; index += 1) {
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

// A legacy text import has no entity IDs to relate an evidence record to a
// role.  Its only safe substitute is a uniquely recognized role section.  The
// application pipeline also uses this when a cover-letter sentence names a
// prior employer: a quote may inherit that employer only from this exact,
// deterministic relationship, never from its position in an evidence plan.
export function careerQuoteHasDeterministicRoleScope(sourceRoles, roleId, quote, careerData) {
  if (typeof quote !== 'string' || !quote || typeof careerData !== 'string' || !careerData) return false;
  const roles = (Array.isArray(sourceRoles) ? sourceRoles : [])
    .filter(role => role && typeof role === 'object' && !Array.isArray(role))
    .map(role => ({
      id: String(role.id || ''), title: String(role.title || ''), company: String(role.company || ''),
      location: String(role.location || ''),
    }))
    .filter(role => role.id && (role.title || role.company));
  const region = careerDataRoleRegionsForSourceRoles(careerData, roles).get(String(roleId || ''));
  return Boolean(region && careerQuoteOccursInRoleCareerRegion(quote, region));
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

function quotedEvidenceHasTerm(value, quotes, flags) {
  const literal = String(value || '').trim();
  if (!literal) return false;
  // Do not let a short skill (Go) match inside a longer token (Google). The
  // same Unicode-aware boundaries retain literal symbolic names such as C++,
  // C#, .NET, and Node.js.
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const exactTerm = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, flags);
  return quotes.some(quote => exactTerm.test(String(quote)));
}

function occursInQuotedCareerEvidence(value, quotes) {
  return quotedEvidenceHasTerm(value, quotes, 'iu');
}

/* The source corpus from the reported package has the one known legacy
 * spelling, `Typescript`; its canonical recruiter-facing rendering is
 * `TypeScript`. Preserve that explicit source-to-display equivalence before
 * applying the established skill-grounding comparator. No other new
 * equivalence is introduced, so existing grounding behaviour stays intact. */
function occursInQuotedSkillEvidence(value, quotes) {
  if (String(value || '').trim() === 'TypeScript'
    && quotedEvidenceHasTerm('Typescript', quotes, 'u')) return true;
  return occursInQuotedCareerEvidence(value, quotes);
}

const PROJECT_OCCURRENCE_RULE = 'project-field-occurs-in-cited-career-evidence';
const PROJECT_DESCRIPTION_RULE = 'project-description-shares-career-evidence-terms';
const PROJECT_LISTING_EVIDENCE_RULE = 'project-cites-job-listing-evidence';
const PROJECT_LISTING_OVERLAP_RULE = 'project-shares-job-listing-evidence-terms';
// Grounding says a project is TRUE; these say it belongs on THIS résumé. They
// are different questions and only the first was ever asked, so a project the
// corpus supports rendered for every posting alike — the one thing a tailored
// résumé is not supposed to do.
//
// Deliberately NOT the plan's priority ranking, which was measured against a
// real accepted plan and does not discriminate: 17 of its 19 evidence items
// were already ranked highest or high, so a priority gate would have read as
// principled while refusing nothing. The binding signal is the posting's own
// words. A project must cite a job-listing quote and share vocabulary with it,
// which is the same pair of tests its career-data side already passes — true
// AND asked for, rather than true alone. A project answering nothing the
// posting says has no listing quote to cite honestly, and that is the case
// this exists to catch.
export const PROJECT_JOB_RELEVANCE_RULE_TEXT = 'a project is carried only when it answers something this posting actually says: it cites at least one job-listing evidence item beside its career-data evidence, and its name and description share at least two meaningful terms with one of those cited listing quotes';
const SKILL_ITEM_RULE = 'skill-item-occurs-in-cited-career-evidence';
const SKILL_GROUP_RULE = 'skill-group-is-neutral-or-in-career-data';
const SKILL_ITEM_FILTERABLE_NOUN_RULE = 'skill-item-is-a-filterable-name';
const SKILLS_BLOCK_SPLIT_RULE = 'skills-block-big-enough-to-split-is-split';
const SKILLS_BLOCK_ROWS_RULE = 'skills-block-within-design-row-budget';
const SKILLS_BLOCK_ITEMS_RULE = 'skills-block-within-design-term-budget';
const SKILLS_ROW_LENGTH_RULE = 'skills-row-within-design-character-budget';

function normalizeProjects(value, allowedEvidenceIds, careerEvidenceIds, careerEvidenceQuotesById, careerData, listingEvidenceQuotesById, offenses, authorityMode = false) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_PROJECTS) fail(`projects must be an array with at most ${MAX_PROJECTS} projects.`);
  const projectOffenses = offenses;
  const evidenceAccepted = [];
  // `map` skips a hole, then the grounding pass below dereferences the
  // unvalidated hole as though it were a project. Consume every declared
  // index so malformed in-memory drafts fail at the same boundary as roles,
  // bullets, and skills.
  const projects = Array.from(value, (raw, index) => {
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
      // Current-authority work must never recover a missing approved quote by
      // rereading a raw career projection.  The authority's signed catalog is
      // the complete fact boundary; a selected ID without its quote is a
      // broken host projection, not permission to search unrelated text.
      if (value && !(careerQuotes.length
        ? occursInQuotedCareerEvidence(value, careerQuotes)
        : !authorityMode && occursInCareerData(value, careerData))) {
        offend(projectOffenses, PROJECT_OCCURRENCE_RULE, `projects.${project.id}.${field} "${value}"`,
          `projects.${project.id}.${field} must occur in its cited career-data evidence.`);
      }
    }
    if (project.description && !hasCareerOverlap(project.description, careerQuotes.length
      ? careerQuotes
      : authorityMode ? [] : [careerData])) {
      offend(projectOffenses, PROJECT_DESCRIPTION_RULE, `projects.${project.id}.description`,
        `projects.${project.id}.description must share at least two distinct meaningful terms with its cited career-data evidence.`);
    }
    // Only gradeable when the caller supplied the source-tagged catalog. A
    // string-only evidence list cannot say which quotes came from the posting,
    // and a rule that cannot read its input must not invent a verdict — the
    // same reason the career-evidence rule above stands down without one.
    if (listingEvidenceQuotesById && listingEvidenceQuotesById.size) {
      const listingQuotes = project.evidenceIds
        .map(evidenceId => listingEvidenceQuotesById.get(evidenceId))
        .filter(quote => typeof quote === 'string' && quote);
      if (!listingQuotes.length) {
        offend(projectOffenses, PROJECT_LISTING_EVIDENCE_RULE, `projects.${project.id}`,
          `projects.${project.id} cites no job-listing evidence, so nothing ties it to this posting; cite the listing quote it answers, or omit the project from this résumé.`);
      } else if (!hasCareerOverlap(`${project.name} ${project.description || ''}`, listingQuotes)) {
        offend(projectOffenses, PROJECT_LISTING_OVERLAP_RULE, `projects.${project.id}`,
          `projects.${project.id} must share at least two distinct meaningful terms with a job-listing quote it cites; a listing citation it has no words in common with does not make it relevant to this posting.`);
      }
    }
  }
  unique(projects.map(project => project.id), 'projects');
  return projects;
}

function normalizeSkills(value, allowedEvidenceIds, careerEvidenceIds, careerEvidenceQuotesById, careerData, offenses, careerSkillEvidence = null, authorityMode = false) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_SKILL_GROUPS) fail(`skills must be an array with at most ${MAX_SKILL_GROUPS} groups.`);
  // Ungrounded items and non-neutral group labels are collected across every
  // group before reporting. Three bad group labels are one defect class and
  // cost one correction round, not three manual copy/paste handoff rounds.
  const skillOffenses = offenses;
  // Array.from, not map: map SKIPS a hole and leaves one in its result, so a
  // sparse array (JSON cannot write one, but a fuzzed or mutated draft can)
  // used to reach the block-level checks below as an entry nothing had
  // validated. Array.from reads a hole as undefined, which record() and text()
  // already reject by name.
  const skills = Array.from(value, (raw, index) => {
    const group = record(raw, `skills[${index}]`);
    if (!Array.isArray(group.items) || !group.items.length || group.items.length > MAX_SKILL_ITEMS_PER_GROUP) fail(`skills[${index}].items must contain between 1 and ${MAX_SKILL_ITEMS_PER_GROUP} values.`);
    const items = Array.from(group.items, (entry, itemIndex) => text(entry, `skills[${index}].items[${itemIndex}]`, { required: true, max: MAX_SKILL_TEXT }));
    unique(items, `skills[${index}].items`);
    const offensesBefore = skillOffenses.length;
    const evidenceIds = normalizeEvidenceIds(group.evidenceIds, `skills[${index}].evidenceIds`, allowedEvidenceIds, careerEvidenceIds, { requireCareerEvidence: true, collect: skillOffenses });
    const careerQuotes = careerQuotesForEvidenceIds(evidenceIds, careerEvidenceQuotesById);
    // Items are measured against the evidence this group cites, so a group
    // whose citation was already rejected has nothing left to measure them
    // against; restating that as an item defect would hide the real repair.
    if (skillOffenses.length === offensesBefore) {
      for (const item of items) {
        if (!(careerQuotes.length
          ? occursInQuotedSkillEvidence(item, careerQuotes)
          : !authorityMode && occursInCareerData(item, careerData))) {
          offend(skillOffenses, SKILL_ITEM_RULE, `skills[${index}] item "${item}"`,
            `skills[${index}] item "${item}" must occur in its cited career-data evidence.`);
        }
      }
    }
    // Grounding says an item is TRUE of the candidate; this says it is a NAME
    // the block can be filtered on. They are different defects with different
    // repairs, so an item carrying both is named by both: the two rules batch
    // separately and the whole response still costs one correction round.
    const approvedSnapshotSkills = snapshotCareerSkills(careerSkillEvidence);
    for (const item of items) {
      const approved = approvedSnapshotSkills?.find(skill => skill.name === item) || null;
      if (approvedSnapshotSkills && (!approved || approved.indexEligible === false)) {
        offend(skillOffenses, SKILL_ITEM_FILTERABLE_NOUN_RULE, `skills[${index}] item "${item}"`,
          `skills[${index}] item "${item}" is not an exact, index-eligible approved snapshot skill. Keep the approved spelling of a supported skill; do not infer aliases, normalize capitalization, or turn an ambiguous source mention into a keyword.`);
      } else if (!approvedSnapshotSkills && !FILTERABLE_SKILL_ITEM_RE.test(item)) {
        offend(skillOffenses, SKILL_ITEM_FILTERABLE_NOUN_RULE, `skills[${index}] item "${item}"`,
          `skills[${index}] item "${item}" must be a name a recruiter can filter on rather than a concept or an activity: ${SKILL_ITEM_FILTERABLE_RULE}.`);
      }
    }
    const groupName = text(group.group, `skills[${index}].group`, { required: true, max: MAX_SKILL_TEXT });
    if (!isNeutralSkillGroupLabel(groupName) && (authorityMode || !occursInCareerData(groupName, careerData))) {
      offend(skillOffenses, SKILL_GROUP_RULE, `skills[${index}].group "${groupName}"`,
        `skills[${index}].group "${groupName}" must be a neutral category label \u2014 ${NEUTRAL_SKILL_GROUP_RULE} \u2014 or a label that occurs in frozen career data.`);
    }
    return {
      id: id(group.id, `skills[${index}].id`), group: groupName, items,
      evidenceIds,
    };
  });
  // The design system's shape for this block (STYLE.md §5.6, SKILL.md:670-674),
  // measured on what renders rather than on the structural ceilings above.
  // Every one of these batches, so a block that breaks all four still costs
  // one correction round.
  if (skills.length) {
    const totalItems = skills.reduce((count, group) => count + group.items.length, 0);
    // A2 removed the section-head synonyms from the label vocabulary, so a
    // single row can no longer be labelled with a word that means "skills".
    // This is the other half of that: a block with enough terms to sort must
    // actually sort them, instead of bolting one honest label onto a keyword
    // run.
    if (totalItems >= MIN_SPLIT_SKILL_ITEMS && skills.length < MIN_SPLIT_SKILL_GROUPS) {
      offend(skillOffenses, SKILLS_BLOCK_SPLIT_RULE, `skills[0].group "${skills[0].group}"`,
        `skills[0].group "${skills[0].group}" carries all ${totalItems} items of this block under one label; a block of ${MIN_SPLIT_SKILL_ITEMS} items or more must name at least ${MIN_SPLIT_SKILL_GROUPS} groups, so sort these items by the kind of skill they actually are.`);
    }
    if (skills.length > MAX_DESIGN_SKILL_GROUPS) {
      offend(skillOffenses, SKILLS_BLOCK_ROWS_RULE, `skills (${skills.length} groups)`,
        `skills renders ${skills.length} rows but this block carries at most ${MAX_DESIGN_SKILL_GROUPS}; a further row buys page space with the weakest content on the page, so keep the domains this posting asks about and drop the rest.`);
    }
    if (totalItems > MAX_DESIGN_SKILL_ITEMS) {
      offend(skillOffenses, SKILLS_BLOCK_ITEMS_RULE, `skills (${totalItems} items)`,
        `skills lists ${totalItems} items but this block carries at most ${MAX_DESIGN_SKILL_ITEMS} in total; drop the terms this posting never asks about rather than dropping a domain.`);
    }
    for (const [index, group] of skills.entries()) {
      // The exact string the renderer emits for this row, so the budget is
      // enforced against what a reader sees and not against the items alone.
      const rowChars = group.items.join(SKILL_ITEM_SEPARATOR).length;
      if (rowChars > MAX_DESIGN_SKILL_ROW_CHARS) {
        offend(skillOffenses, SKILLS_ROW_LENGTH_RULE, `skills[${index}].items (${rowChars} characters)`,
          `skills[${index}].items renders a row of ${rowChars} characters but a row holds at most ${MAX_DESIGN_SKILL_ROW_CHARS}, which is one line at this block's measure; move a term into another group or drop it.`);
      }
    }
  }
  unique(skills.map(group => group.id), 'skills');
  return skills;
}

// Education and certifications deliberately use their own normalizer rather
// than the project one. A credential is not a project with a different label:
// its issuer/institution and date are independently factual fields, and all
// visible fields must be bound to the item's own cited career evidence.
function normalizeCredentialItems(value, kind, allowedEvidenceIds, careerEvidenceIds, careerEvidenceQuotesById, careerData, offenses, authorityMode = false) {
  const isEducation = kind === 'education';
  const label = isEducation ? 'education' : 'credentials';
  const maximum = isEducation ? MAX_EDUCATION : MAX_CREDENTIALS;
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > maximum) fail(`${label} must be an array with at most ${maximum} items.`);
  const fieldNames = isEducation
    ? [['credential', MAX_SHORT_TEXT], ['institution', MAX_SHORT_TEXT], ['dates', MAX_SHORT_TEXT]]
    : [['name', MAX_SHORT_TEXT], ['issuer', MAX_SHORT_TEXT], ['dates', MAX_SHORT_TEXT]];
  const rule = `${kind}-field-occurs-in-cited-career-evidence`;
  const items = Array.from(value, (raw, index) => {
    const item = record(raw, `${label}[${index}]`);
    const before = offenses.length;
    const normalized = { id: id(item.id, `${label}[${index}].id`) };
    for (const [field, max] of fieldNames) {
      // A degree/certificate name is the identifying fact; institution/issuer
      // and dates are optional only because source files often omit them.
      normalized[field] = text(item[field], `${label}[${index}].${field}`, { required: field === (isEducation ? 'credential' : 'name'), max });
    }
    normalized.evidenceIds = normalizeEvidenceIds(item.evidenceIds, `${label}[${index}].evidenceIds`, allowedEvidenceIds, careerEvidenceIds, { requireCareerEvidence: true, collect: offenses });
    const accepted = offenses.length === before;
    if (accepted) {
      const quotes = careerQuotesForEvidenceIds(normalized.evidenceIds, careerEvidenceQuotesById);
      for (const [field] of fieldNames) {
        const fieldValue = normalized[field];
        if (fieldValue && !(quotes.length
          ? occursInQuotedCareerEvidence(fieldValue, quotes)
          : !authorityMode && occursInCareerData(fieldValue, careerData))) {
          offend(offenses, rule, `${label}.${normalized.id}.${field}`,
            `${label}.${normalized.id}.${field} must occur in its cited career-data evidence.`);
        }
      }
    }
    return normalized;
  });
  unique(items.map(item => item.id), label);
  return items;
}

/** Validate a paste response and normalize it into the only renderer input. */
export function validateStructuredResumeDraft(raw, { sourceRoles, evidenceIds, evidenceCatalog, trustedIdentity, careerData, careerSkillEvidence = null, authorityMode = false } = {}) {
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
  // The posting's own half of the catalog, which nothing rendered has ever
  // been measured against until now: it is what says a project answers this
  // job rather than merely being true of the candidate.
  const listingEvidenceQuotesById = new Map(verifiedEvidence
    .filter(entry => entry?.sourceId === 'job-listing' && typeof entry?.quote === 'string')
    .map(entry => [id(entry.id, 'verified evidenceCatalog id'), entry.quote]));
  const normalizedSourceRoles = normalizeSourceRoles(sourceRoles);
  const sourceById = new Map(normalizedSourceRoles.map(role => [role.id, role]));
  const careerDataRoleRegions = careerEvidenceIds && !authorityMode
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
  // Array.from, not map: map skips a sparse-array hole, leaving an undefined
  // role for later collection-level checks to dereference. Treat the hole as
  // an invalid record at its own index, just as normalizeSkills already does.
  const roles = Array.from(draft.roles, (role, index) => normalizeRole(
    role, index, sourceById, allowedEvidenceIds, careerEvidenceIds, careerData,
    careerEvidenceQuotesById, careerDataRoleRegions, offenses, authorityMode,
  ));
  const roleIds = unique(roles.map(role => role.id), 'roles');
  for (const role of normalizedSourceRoles) if (!roleIds.has(role.id)) fail(`roles is missing trusted source role "${role.id}".`);
  const projects = normalizeProjects(draft.projects, allowedEvidenceIds, careerEvidenceIds, careerEvidenceQuotesById, careerData, listingEvidenceQuotesById, offenses, authorityMode);
  const skills = normalizeSkills(draft.skills, allowedEvidenceIds, careerEvidenceIds, careerEvidenceQuotesById, careerData, offenses, careerSkillEvidence, authorityMode);
  const education = normalizeCredentialItems(draft.education, 'education', allowedEvidenceIds, careerEvidenceIds, careerEvidenceQuotesById, careerData, offenses, authorityMode);
  const credentials = normalizeCredentialItems(draft.credentials, 'certification', allowedEvidenceIds, careerEvidenceIds, careerEvidenceQuotesById, careerData, offenses, authorityMode);
  if (!roles.length && !projects.length && !education.length && !credentials.length) {
    fail('A résumé without work-history roles must contain at least one evidence-backed project, education item, or credential.');
  }
  // Only gradeable when the caller supplied the source-tagged catalog: a
  // string-only evidence list cannot say which quotes came from the posting,
  // and a rule that cannot read its input must not invent a verdict — the
  // same stand-down the project/listing rules use. It fires even when the
  // draft carries no skills block at all, because an absent block means every
  // required name is missing. The message names only the host's canonical
  // vocabulary spellings and never interpolates the grounding or coverage
  // rules: those cite the corpus's lowercase example and must not leak into
  // rejection prose.
  if (careerEvidenceIds) {
    const missing = missingPostingNamedSkillTerms(skills, verifiedEvidence, careerSkillEvidence);
    if (missing.length) {
      offend(offenses, POSTING_NAMED_SKILL_TERM_RULE, 'skills',
        `skills omits ${missing.join(', ')}: ${missing.length === 1 ? 'a technology name' : 'technology names'} this posting’s own requirement quotes state and your cited career-data evidence also states. The skills block is the index a recruiter filters on, so add ${missing.length === 1 ? 'it' : 'each'} to the group that fits, written in its canonical capitalization even where the career data spells it in lowercase (grounding ignores letter case), and cite the career-data quote that states it; make room by dropping terms this posting never asks about.`);
    }
    // Do not report a posting-named term twice. The established posting rule
    // above gives those omissions their more useful, job-specific wording; this
    // rule names only the additional prioritized career terms that kept an
    // otherwise valid block from collapsing to one token.
    const postingRequired = new Set(postingNamedAttestedSkillTerms(verifiedEvidence, careerSkillEvidence));
    const missingCareer = missingRequiredCareerSkillTerms(skills, verifiedEvidence, careerSkillEvidence)
      .filter(name => !postingRequired.has(name));
    if (missingCareer.length) {
      offend(offenses, SKILLS_BLOCK_PRESENCE_RULE_ID, 'skills',
        `skills omits ${missingCareer.join(', ')} from the bounded career-attested index. The accepted plan supports ${missingCareer.length === 1 ? 'this technology' : 'these technologies'}, and the skills section is the recruiter and applicant-tracking index for them; add ${missingCareer.length === 1 ? 'it' : 'each'} under the neutral domain label that fits, cite the career-data quote that states it, and keep every posting-named term. The index stops at ${MAX_REQUIRED_CAREER_SKILL_TERMS} prioritized names, so page fit is not a reason to reduce it to one token.`);
    }
  }
  collectNonCanonicalTypeScriptOffenses(roles, projects, skills, offenses);
  failOffenses(offenses);
  return {
    schemaVersion: STRUCTURED_RESUME_SCHEMA_VERSION,
    identity: normalizeIdentity(draft.identity, trustedIdentity),
    roles,
    projects,
    skills,
    education,
    credentials,
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function separator() { return '<span class="sep" aria-hidden="true">·</span>'; }
function sectionHead(title, id) { return `<div class="section-head"><h2 id="${id}">${escapeHtml(title)}</h2><span class="rule" aria-hidden="true"></span></div>`; }

// Role metadata remains source-locked in the structured draft. This is only a
// narrow display projection for the conventional written-month form, so a
// source such as "May, 2023" reads as "May 2023" without teaching the model
// that it may rewrite source dates. It deliberately does not try to parse or
// repair other punctuation, numeric dates, or free-form date text.
const MONTH_YEAR_DISPLAY_RE = /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s*,\s*(\d{4})\b/giu;
export function formatRoleDateForPresentation(value) {
  return String(value ?? '').replace(MONTH_YEAR_DISPLAY_RE, '$1 $2');
}

// A second role row exists to carry a scope summary and a location together.
// This schema rejects `roles[].summary` outright (see normalizeRole), so that
// row could only ever hold one right-aligned city — and it still spent a whole
// line plus two stacked margins on it, ~29.8pt per role, roughly 2 baselines
// (`build/fit-estimate-test.js` COST.roleMeta). STYLE.md §5.2b is the
// sanctioned remedy: fold a LONE location up into the dates cell, where it
// costs zero lines and changes no typography, because both cells already share
// one rule. `resumeRoleDatesAndLocation` reads that shape back.
//
// Fold only what that reader can parse back: it splits on the LAST `·`,
// requires a digit in the head, and refuses a tail carrying a bare four-digit
// year (which would read as a second date range). A location that would break
// either condition keeps its own row rather than becoming unreadable.
function foldableRoleLocation(dates, location) {
  return Boolean(dates) && Boolean(location)
    && /\d/.test(dates) && !/\b\d{4}\b/.test(location) && !location.includes('\u00b7');
}

function renderRole(role) {
  const company = role.company ? `${separator()}<span class="company">${escapeHtml(role.company)}</span>` : '';
  const displayDates = formatRoleDateForPresentation(role.dates);
  const folded = !role.summary && foldableRoleLocation(displayDates, role.location);
  const datesCell = folded ? `${escapeHtml(displayDates)}${separator()}${escapeHtml(role.location)}` : escapeHtml(displayDates);
  const dates = role.dates ? `<p class="role-dates">${datesCell}</p>` : '';
  const summary = role.summary ? `<p class="role-summary">${escapeHtml(role.summary)}</p>` : '';
  // A row still carrying a second cell is the grid doing its job; leave it.
  const location = role.location && !folded ? `<p class="role-location">${escapeHtml(role.location)}</p>` : '';
  const meta = summary || location ? `<div class="role-meta meta-row">${summary}${location}</div>` : '';
  const bullets = role.bullets.map(bullet => {
    return `<li>${escapeHtml(bullet.text)}</li>`;
  }).join('');
  return `<article class="role" itemprop="hasOccupation" itemscope itemtype="https://schema.org/EmployeeRole"><div class="role-header meta-row"><p class="role-title-line"><span class="title">${escapeHtml(role.title)}</span>${company}</p>${dates}</div>${meta}<ul class="highlights">${bullets}</ul></article>`;
}

function sourceProjectHeadings(careerData, projects, authorityMode = false) {
  // The authority gives each project an exact typed identity; do not infer an
  // employer/personal provenance heading by reparsing its display text. A
  // plain Projects label preserves the project's visible name and supported
  // facts without inventing a generic domain category such as “Systems”.
  if (authorityMode) return projects.map(() => 'Projects');
  return projects.map(project => careerDataProjectProvenanceHeadingForName(careerData, project.name) || 'Selected Systems');
}

function renderProjects(projects, careerData, authorityMode = false) {
  const headings = sourceProjectHeadings(careerData, projects, authorityMode);
  const groups = new Map();
  projects.forEach((project, index) => {
    const heading = headings[index];
    if (!groups.has(heading)) groups.set(heading, []);
    groups.get(heading).push(project);
  });
  return [...groups.entries()].map(([heading, entries], index) =>
    `<section class="section projects" aria-labelledby="sec-projects-${index}">${sectionHead(heading, `sec-projects-${index}`)}${entries.map(project => `<article class="project"><span class="project-name">${escapeHtml(project.name)}</span>${project.description ? `${separator()}<span class="project-desc">${escapeHtml(project.description)}</span>` : ''}${project.metrics ? `<span class="project-metrics">${escapeHtml(project.metrics)}</span>` : ''}</article>`).join('')}</section>`).join('');
}

function renderEducation(items) {
  return `<section class="section education" aria-labelledby="sec-education">${sectionHead('Education', 'sec-education')}<dl class="credentials-list">${items.map(item => `<div class="credential-item"><dt>${escapeHtml(item.credential)}</dt><dd>${[item.institution, item.dates].filter(Boolean).map(escapeHtml).join(' · ')}</dd></div>`).join('')}</dl></section>`;
}

function renderCredentials(items) {
  return `<section class="section certifications" aria-labelledby="sec-credentials">${sectionHead('Certifications', 'sec-credentials')}<dl class="credentials-list">${items.map(item => `<div class="credential-item"><dt>${escapeHtml(item.name)}</dt><dd>${[item.issuer, item.dates].filter(Boolean).map(escapeHtml).join(' · ')}</dd></div>`).join('')}</dl></section>`;
}

/** Build design-system-safe HTML after validating against trusted IDs. */
export function renderStructuredResume(raw, context = {}) {
  const draft = validateStructuredResumeDraft(raw, context);
  const subtitle = draft.identity.subtitleRole
    ? `<span class="subtitle-role" itemprop="jobTitle">${escapeHtml(draft.identity.subtitleRole)}</span>${draft.identity.credential ? `${separator()}<span class="credential">${escapeHtml(draft.identity.credential)}</span>` : ''}`
    : (draft.identity.credential ? `<span class="credential">${escapeHtml(draft.identity.credential)}</span>` : '');
  const header = `<header class="resume-header"><h1 class="name" itemprop="name">${escapeHtml(draft.identity.name)}</h1>${subtitle ? `<p class="tagline">${subtitle}</p>` : ''}<p class="contact" role="group" aria-label="Contact">${draft.identity.contact.map(escapeHtml).join(separator())}</p></header>`;
  const experience = draft.roles.length ? `<section class="section" aria-labelledby="sec-experience">${sectionHead('Experience', 'sec-experience')}${draft.roles.map(renderRole).join('')}</section>` : '';
  const projects = draft.projects.length ? renderProjects(draft.projects, context.careerData, context.authorityMode === true) : '';
  const skills = draft.skills.length ? `<section class="section" aria-labelledby="sec-skills">${sectionHead('Skills', 'sec-skills')}<dl class="skills">${draft.skills.map(group => `<dt>${escapeHtml(titleCaseSkillGroupLabel(group.group))}</dt><dd>${group.items.map(escapeHtml).join(SKILL_ITEM_SEPARATOR)}</dd>`).join('')}</dl></section>` : '';
  const education = draft.education.length ? renderEducation(draft.education) : '';
  const credentials = draft.credentials.length ? renderCredentials(draft.credentials) : '';
  const resumeMainHtml = `<main class="page" role="document" itemscope itemtype="https://schema.org/Person">${header}${experience}${projects}${education}${credentials}${skills}</main>`;
  // Catch a provenance-bearing project section mismatch before the result is
  // imported, so the next review can remove or revise it instead of reaching
  // a terminal-looking paste that the final renderer will always reject.
  // validateStructuredResumeDraft above has already refused a missing or blank
  // corpus, so this runs whenever there is a project to check.
  const projectFailures = draft.projects.length && context.authorityMode !== true
    ? resumeProjectProvenanceFailures(resumeMainHtml, context.careerData)
    : [];
  if (projectFailures.length) fail(projectFailures.join(' '));
  return { draft, resumeMainHtml };
}

/** Paste-workflow adapter: only returns markup accepted by the legacy validator. */
export function validateStructuredApplicationResume(resume, context = {}) {
  return validateStructuredResumeDraft(resume, context);
}

export function renderStructuredApplicationResume(resume, { sourceRoles, evidenceCatalog, trustedIdentity, careerData, careerSkillEvidence = null, authorityMode = false } = {}) {
  return renderStructuredResume(resume, { sourceRoles, evidenceCatalog, trustedIdentity, careerData, careerSkillEvidence, authorityMode }).resumeMainHtml;
}
