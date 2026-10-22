// Adaptability family: SKILLS / TECHNOLOGIES / TOOLS.
//
// The production rule is that a skill (or technology, or tool) may appear in a
// career profile, or in generated application text, only while CURRENT source
// evidence supports it. Nothing in production may know which skills any
// person has. These tests therefore never assert "Python is allowed"; they
// build several unrelated SYNTHETIC careers, run their source text through the
// real production path (corpus -> audited compile -> approved snapshot ->
// application projection / authority / structured-résumé validation), and
// compare what production decides with an oracle that is computed from the
// synthetic spec itself:
//
//   A  source without the evidence          -> claim rejected
//   B  A plus a sentence that demonstrates  -> recompiled (new snapshot id),
//      direct use                              claim admitted everywhere
//   C  B with that sentence removed         -> unavailable again
//
// plus near-miss mutations (sibling skill, over-specific name, stem inside a
// longer word), mere mentions (employer system, evaluated-but-rejected
// product, vendor), alternative/conditional relationships, case/Unicode
// canonicalization, skills that are stated as a bare skills-section line or
// inside a project entry rather than a role duty, and a prompt-skeleton check
// that production prompts carry no candidate vocabulary.
//
// Every rejection is made to be about the item under test and nothing else:
// a rejected claim must be refused by the approved-inventory rule (or the
// literal-grounding rule) NAMING THAT ITEM, every acceptance has a control in
// which the same slot admits a real skill, and a profile edit is a single
// edit to a faithful, valid profile with every validation error attributed to
// the edited entity. These tests were checked by mutating production (whole-
// term grounding, eligibility, ledger, relationship, merge, authority and
// projection rules, one at a time and in combination) on a scratch copy:
// each such regression fails at least one test here.
//
// Everything here is invented. No fixture reuses a real person's facts.
// Tests tagged `[fixed defect]` guard production gaps this mutation sweep found
// and that have since been fixed: their title names the defect that used to
// exist and the body asserts the corrected behaviour (the comment above each such
// test describes the defect as it was before the fix). `knownGaps` is empty.
import crypto from 'node:crypto';
import { assert } from './testHelpers.js';
import {
  approvedCareerEvidenceCatalog,
  buildCareerProfileAuditPrompt,
  buildCareerProfileCompilePrompt,
  buildCareerProfilePageCompilePrompt,
  buildCareerSourceCorpus,
  careerSnapshotId,
  compileAuditedCareerSnapshot,
  isCareerSkillIndexEligible,
  partitionCareerSourcePages,
  projectApprovedCareerSnapshotForApplication,
  projectLegacyCareerProfile,
  validateCareerProfile,
  validateCurrentCareerSnapshot,
  verbatimCareerTranscriptionAuditReceipt,
  vettedCareerSkillInventory,
} from '../../electron/ipc/careerSnapshot.js';
import { buildApplicationCareerAuthority, validateAuthorityRoleEvidence, validateAuthoritySkillGroup } from '../../electron/ipc/applicationCareerAuthority.js';
import { postingNamedAttestedSkillTerms, requiredCareerAttestedSkillTerms, validateStructuredApplicationResume } from '../../electron/ipc/structuredResume.js';
import { __snapshotCareerSkillEvidenceForTests, assertSourceQuoteLinksFinalText } from '../../electron/ipc/localAiApplication.js';

// ---------------------------------------------------------------------------
// Synthetic candidates. Six unrelated kinds of work are covered on purpose:
// clinical, culinary, structural engineering, analytics, logistics, software.
// Product names are invented so no test can pass by recognizing a vocabulary.
//
// A note on what is simulated: whether a sentence is a real use, a mere
// mention, or a choice between alternatives is a SEMANTIC judgement that
// production deliberately leaves to the model plus an independent audit. The
// spec's `uses` annotations stand in for that judgement (a responder). What is
// under test is everything production does deterministically around it:
// literal grounding, ledger/skill-row consistency, relationship rules, the
// compile/repair/audit loop, snapshot identity, and the application-side
// admission that is derived only from the approved snapshot.
// ---------------------------------------------------------------------------

const bullet = (text, uses = [], extra = {}) => ({ text, uses, ...extra });
const skillUse = (label, name, kind, category, extra = {}) => ({ label, name, kind, category, disposition: 'skill', relationship: 'independent', group: '', ...extra });
const mentionUse = (label, reason) => ({ label, name: label, disposition: 'non-skill', relationship: 'independent', group: '', reason });

function candidate(spec) {
  const [firstMention] = spec.mentions;
  return {
    key: spec.key,
    name: spec.name,
    contact: spec.contact,
    role: spec.role,
    // Baseline direct skill, plain duties, and three kinds of mere mention.
    practice: bullet(spec.practice.text, [skillUse(spec.practice.label, spec.practice.name, spec.practice.kind, spec.practice.category)]),
    filler: bullet(spec.filler.text),
    // The same duty sentence, but its capability is a soft/conceptual one the
    // extractor correctly marks as not an index-eligible skills-block term.
    softFiller: bullet(spec.filler.text, [skillUse(spec.filler.label, spec.filler.name, 'capability', 'practice', { indexEligible: false })]),
    softName: spec.filler.name,
    mentions: spec.mentions.map(item => bullet(item.text, [mentionUse(item.label, item.reason)])),
    // The employer system that was only mentioned in A is actually operated in B.
    upgrade: bullet(spec.upgrade.text, [skillUse(firstMention.label, firstMention.label, spec.upgrade.kind, spec.upgrade.category)]),
    // A genuinely new skill, spelled in lower case mid-sentence in the source.
    added: bullet(spec.added.text, [skillUse(spec.added.label, spec.added.name, spec.added.kind, spec.added.category)]),
    addedName: spec.added.name,
    // A source-stated choice between two tools: neither is simultaneous experience.
    alternative: bullet(spec.alternative.text, [
      skillUse(spec.alternative.a.label, spec.alternative.a.name, spec.alternative.kind, spec.alternative.category, { relationship: 'alternative', group: 'tool-choice', slice: spec.alternative.slice }),
      skillUse(spec.alternative.b.label, spec.alternative.b.name, spec.alternative.kind, spec.alternative.category, { relationship: 'alternative', group: 'tool-choice', slice: spec.alternative.slice }),
    ]),
    // A separate sentence that states direct use of the first alternative.
    altDirect: bullet(spec.alternative.directText, [skillUse(spec.alternative.a.label, spec.alternative.a.name, spec.alternative.kind, spec.alternative.category)]),
    altNames: [spec.alternative.a.name, spec.alternative.b.name],
    // A skills-section style line: the skills are stated as a bare list, not as
    // duties, so no achievement or ledger entry exists for them. The source
    // spells them in lower case; the approved row keeps the canonical spelling.
    listed: bullet(spec.listed.text, spec.listed.items.map(item => skillUse(item.label, item.name, item.kind, item.category)), { list: true }),
    // The same skill, stated inside a project entry instead of a role duty: once as a mere
    // evaluation that was not adopted, once as the work the project actually did.
    projectMention: bullet(`Project Pilot rollout: the team evaluated ${spec.added.label} but did not adopt it.`, [mentionUse(spec.added.label, 'evaluated option that was not adopted')], { project: { name: 'Pilot rollout', description: `the team evaluated ${spec.added.label} but did not adopt it.` } }),
    projectUse: bullet(`Project Pilot rollout: ${spec.added.text}`, [skillUse(spec.added.label, spec.added.name, spec.added.kind, spec.added.category)], { project: { name: 'Pilot rollout', description: spec.added.text } }),
    nearMiss: spec.nearMiss,
    listing: spec.listing,
  };
}

const CANDIDATES = [
  candidate({
    key: 'nurse',
    name: 'Imogen Farrow-Quill',
    contact: 'imogen.farrow@example.test',
    role: { title: 'Charge Nurse', employer: 'Larkfield Regional Hospital', location: 'Duluth, Minnesota', startDate: 'March 2018', endDate: 'Present' },
    practice: { text: 'Placed peripheral IV lines and performed venipuncture for adult inpatients on a step-down unit.', label: 'venipuncture', name: 'Venipuncture', kind: 'method', category: 'clinical' },
    filler: { text: 'Taught wound care technique to new graduate nurses during orientation.', label: 'wound care technique', name: 'Wound care technique' },
    mentions: [
      { text: 'The unit charting system, Lumenchart, was selected by hospital IT before I joined.', label: 'Lumenchart', reason: 'organization-owned system selected by the employer' },
      { text: 'Our committee considered Rhythmwatch bedside monitors but the hospital kept its existing monitors.', label: 'Rhythmwatch', reason: 'evaluated product that was not adopted' },
      { text: 'Infusion pumps were supplied under contract by Dosevane Medical.', label: 'Dosevane Medical', reason: 'vendor organization' },
    ],
    upgrade: { text: 'Entered and reconciled medication orders in Lumenchart on every shift.', kind: 'tool', category: 'clinical systems' },
    added: { text: 'Watched continuous telemetry monitoring for cardiac patients and escalated arrhythmias to physicians.', label: 'telemetry monitoring', name: 'Telemetry monitoring', kind: 'method', category: 'clinical' },
    alternative: {
      text: 'Checked blood pressure with either a manual sphygmomanometer or an automated cuff depending on the patient.',
      slice: 'either a manual sphygmomanometer or an automated cuff depending on the patient',
      a: { label: 'manual sphygmomanometer', name: 'Manual sphygmomanometer' }, b: { label: 'automated cuff', name: 'Automated cuff' },
      kind: 'tool', category: 'clinical',
      directText: 'Calibrated the manual sphygmomanometer against the unit reference gauge each month.',
    },
    listed: { text: 'Core competencies: telemetry monitoring, arterial line insertion.', items: [{ label: 'telemetry monitoring', name: 'Telemetry monitoring', kind: 'method', category: 'clinical' }, { label: 'arterial line insertion', name: 'Arterial line insertion', kind: 'method', category: 'clinical' }] },
    nearMiss: { sibling: 'Arterial line insertion', extension: 'Telemetry monitoring certification', embedded: 'Monitor' },
    listing: {
      requires: 'Required: continuous telemetry monitoring experience on a cardiac step-down unit.',
      unrelated: 'Preferred: arterial line insertion experience in a critical care setting.',
    },
  }),
  candidate({
    key: 'pastry-chef',
    name: 'Tobias Renwick-Salt',
    contact: 'tobias.renwick@example.test',
    role: { title: 'Pastry Chef', employer: 'Maison Ardent Bakery', location: 'Portland, Oregon', startDate: 'June 2016', endDate: 'August 2023' },
    practice: { text: 'Performed dough lamination daily for croissant and danish production at a forty-seat cafe.', label: 'dough lamination', name: 'Dough lamination', kind: 'method', category: 'culinary' },
    filler: { text: 'Trained two apprentices on allergen labelling procedures.', label: 'allergen labelling procedures', name: 'Allergen labelling procedures' },
    mentions: [
      { text: 'The bakery ordering portal, Flourline, was set up by the owner accountant.', label: 'Flourline', reason: 'organization-owned system set up by the employer' },
      { text: 'We considered a Nordhaus deck oven but kept the original oven.', label: 'Nordhaus deck oven', reason: 'evaluated equipment that was not adopted' },
      { text: 'Chocolate couverture was supplied by Valtier Cacao.', label: 'Valtier Cacao', reason: 'supplier organization' },
    ],
    upgrade: { text: 'Placed weekly dry-goods orders through Flourline and reconciled the invoices.', kind: 'tool', category: 'kitchen systems' },
    added: { text: 'Handled chocolate tempering for showpieces and bonbons.', label: 'chocolate tempering', name: 'Chocolate tempering', kind: 'method', category: 'culinary' },
    alternative: {
      text: 'Baked sourdough in either a convection oven or a rotating rack oven depending on the daily volume.',
      slice: 'either a convection oven or a rotating rack oven depending on the daily volume',
      a: { label: 'convection oven', name: 'Convection oven' }, b: { label: 'rotating rack oven', name: 'Rotating rack oven' },
      kind: 'tool', category: 'culinary',
      directText: 'Cleaned and descaled the convection oven at the close of every week.',
    },
    listed: { text: 'Core competencies: chocolate tempering, sugar pulling.', items: [{ label: 'chocolate tempering', name: 'Chocolate tempering', kind: 'method', category: 'culinary' }, { label: 'sugar pulling', name: 'Sugar pulling', kind: 'method', category: 'culinary' }] },
    nearMiss: { sibling: 'Sugar pulling', extension: 'Chocolate tempering by machine', embedded: 'Temper' },
    listing: {
      requires: 'Required: chocolate tempering for plated desserts and retail confections.',
      unrelated: 'Preferred: sugar pulling for display pieces.',
    },
  }),
  candidate({
    key: 'structural-engineer',
    name: 'Odalys Brandt-Meyer',
    contact: 'odalys.brandt@example.test',
    role: { title: 'Structural Engineer', employer: 'Kestrel Span Consultants', location: 'Calgary, Alberta', startDate: 'September 2014', endDate: 'Present' },
    practice: { text: 'Prepared steel connection designs using limit states design for mid-rise office frames.', label: 'limit states design', name: 'Limit states design', kind: 'method', category: 'engineering' },
    filler: { text: 'Performed shop drawing review for two fabricators each month.', label: 'shop drawing review', name: 'Shop drawing review' },
    mentions: [
      { text: 'The firm drafting standard, Spanbook, was written by the principal before I joined.', label: 'Spanbook', reason: 'organization-owned standard written by the employer' },
      { text: 'We evaluated Trussolve for roof truss design but the firm kept its spreadsheets.', label: 'Trussolve', reason: 'evaluated product that was not adopted' },
      { text: 'Anchor bolts were supplied by Holdfast Fabrication.', label: 'Holdfast Fabrication', reason: 'supplier organization' },
    ],
    upgrade: { text: 'Applied the Spanbook details to every connection drawing I issued.', kind: 'method', category: 'engineering standards' },
    added: { text: 'Ran finite element analysis on a concrete transfer slab to check punching shear.', label: 'finite element analysis', name: 'Finite element analysis', kind: 'method', category: 'engineering' },
    alternative: {
      text: 'Checked timber joists using either a span table or a spreadsheet check depending on the load case.',
      slice: 'either a span table or a spreadsheet check depending on the load case',
      a: { label: 'span table', name: 'Span table' }, b: { label: 'spreadsheet check', name: 'Spreadsheet check' },
      kind: 'method', category: 'engineering',
      directText: 'Maintained the office span table after each code amendment.',
    },
    listed: { text: 'Core competencies: finite element analysis, seismic base isolation design.', items: [{ label: 'finite element analysis', name: 'Finite element analysis', kind: 'method', category: 'engineering' }, { label: 'seismic base isolation design', name: 'Seismic base isolation design', kind: 'method', category: 'engineering' }] },
    nearMiss: { sibling: 'Seismic base isolation design', extension: 'Finite element analysis with nonlinear solvers', embedded: 'Punch' },
    listing: {
      requires: 'Required: finite element analysis of concrete floor systems.',
      unrelated: 'Preferred: seismic base isolation design for hospital buildings.',
    },
  }),
  candidate({
    key: 'data-analyst',
    name: 'Kestrel Vanterpool',
    contact: 'kestrel.vanterpool@example.test',
    role: { title: 'Data Analyst', employer: 'Pinecrest Logistics', location: 'Austin, Texas', startDate: 'January 2019', endDate: 'Present' },
    practice: { text: 'Built weekly pivot tables summarizing on-time delivery by depot for regional managers.', label: 'pivot tables', name: 'Pivot tables', kind: 'tool', category: 'analytics' },
    filler: { text: 'Led data cleaning before every weekly report.', label: 'data cleaning', name: 'Data cleaning' },
    mentions: [
      { text: 'The warehouse system, Stockwell, was licensed by corporate procurement.', label: 'Stockwell', reason: 'organization-owned system licensed by the employer' },
      { text: 'I reviewed Dashmark as a possible dashboard replacement but the team stayed with its current reports.', label: 'Dashmark', reason: 'evaluated product that was not adopted' },
      { text: 'Carrier scan data arrived as a nightly feed from Routecast.', label: 'Routecast', reason: 'external data source and vendor' },
    ],
    upgrade: { text: 'Configured Stockwell exports and scheduled them for the reporting team.', kind: 'tool', category: 'analytics systems' },
    added: { text: 'Fitted regression analysis models to forecast peak-season volume.', label: 'regression analysis', name: 'Regression analysis', kind: 'method', category: 'analytics' },
    alternative: {
      text: 'Produced the monthly deck in either Quillsheet or Brightgrid depending on the client licence.',
      slice: 'either Quillsheet or Brightgrid depending on the client licence',
      a: { label: 'Quillsheet', name: 'Quillsheet' }, b: { label: 'Brightgrid', name: 'Brightgrid' },
      kind: 'tool', category: 'analytics',
      directText: 'Trained three colleagues on Quillsheet formulas.',
    },
    listed: { text: 'Core competencies: regression analysis, time series forecasting.', items: [{ label: 'regression analysis', name: 'Regression analysis', kind: 'method', category: 'analytics' }, { label: 'time series forecasting', name: 'Time series forecasting', kind: 'method', category: 'analytics' }] },
    nearMiss: { sibling: 'Time series forecasting', extension: 'Regression analysis with Bayesian priors', embedded: 'Model' },
    listing: {
      requires: 'Required: regression analysis to support demand planning.',
      unrelated: 'Preferred: time series forecasting for retail demand.',
    },
  }),
  candidate({
    key: 'warehouse-supervisor',
    name: 'Lucan Marchetti-Oyelaran',
    contact: 'lucan.marchetti@example.test',
    role: { title: 'Warehouse Supervisor', employer: 'Harbourline Distribution', location: 'Savannah, Georgia', startDate: 'April 2015', endDate: 'Present' },
    practice: { text: 'Performed forklift operation on a sit-down counterbalance truck to stage outbound pallets.', label: 'forklift operation', name: 'Forklift operation', kind: 'method', category: 'logistics' },
    filler: { text: 'Planned shift coverage for eleven loaders and pickers.', label: 'shift coverage', name: 'Shift coverage' },
    mentions: [
      { text: 'The yard system, Dockwise, was chosen by the regional office.', label: 'Dockwise', reason: 'organization-owned system chosen by the employer' },
      { text: 'The team considered Rackpulse slotting software but decided to slot by hand.', label: 'Rackpulse', reason: 'evaluated product that was not adopted' },
      { text: 'Pallet wrap was bought from Ironweave Packaging.', label: 'Ironweave Packaging', reason: 'supplier organization' },
    ],
    upgrade: { text: 'Scheduled dock appointments in Dockwise for all inbound carriers.', kind: 'tool', category: 'logistics systems' },
    added: { text: 'Ran cycle counting each shift to reconcile pick locations.', label: 'cycle counting', name: 'Cycle counting', kind: 'method', category: 'logistics' },
    alternative: {
      text: 'Labelled outbound pallets with either a thermal printer or handwritten tags depending on the carrier.',
      slice: 'either a thermal printer or handwritten tags depending on the carrier',
      a: { label: 'thermal printer', name: 'Thermal printer' }, b: { label: 'handwritten tags', name: 'Handwritten tags' },
      kind: 'tool', category: 'logistics',
      directText: 'Replaced the thermal printer ribbon and platen on the shipping desk.',
    },
    listed: { text: 'Core competencies: cycle counting, slotting optimization.', items: [{ label: 'cycle counting', name: 'Cycle counting', kind: 'method', category: 'logistics' }, { label: 'slotting optimization', name: 'Slotting optimization', kind: 'method', category: 'logistics' }] },
    nearMiss: { sibling: 'Slotting optimization', extension: 'Cycle counting by RFID', embedded: 'Count' },
    listing: {
      requires: 'Required: cycle counting experience in a high-volume distribution centre.',
      unrelated: 'Preferred: slotting optimization for fast-moving pick faces.',
    },
  }),
  candidate({
    key: 'software-engineer',
    name: 'Wren Ashdown-Pike',
    contact: 'wren.ashdown@example.test',
    role: { title: 'Software Engineer', employer: 'Tidewater Apps', location: 'Halifax, Nova Scotia', startDate: 'July 2020', endDate: 'Present' },
    practice: { text: 'Wrote Rust command-line tools to validate nightly data exports.', label: 'Rust', name: 'Rust', kind: 'language', category: 'language' },
    filler: { text: 'Led code review for the mobile team each week.', label: 'code review', name: 'Code review' },
    mentions: [
      { text: 'The company deployment platform, Launchpadia, was built by the infrastructure team.', label: 'Launchpadia', reason: 'organization-owned platform built by another team' },
      { text: 'We considered Graphweave for the query layer but decided to keep REST endpoints.', label: 'Graphweave', reason: 'evaluated product that was not adopted' },
      { text: 'Payments were handled through a third-party integration with Coinlark.', label: 'Coinlark', reason: 'third-party service the candidate did not operate' },
    ],
    upgrade: { text: 'Shipped weekly releases to production through Launchpadia.', kind: 'platform', category: 'deployment' },
    added: { text: 'Tuned PostgreSQL indexes for the reporting queries.', label: 'PostgreSQL', name: 'PostgreSQL', kind: 'technology', category: 'database' },
    alternative: {
      text: 'Wrote integration tests in either Jest or Vitest depending on the package.',
      slice: 'either Jest or Vitest depending on the package',
      a: { label: 'Jest', name: 'Jest' }, b: { label: 'Vitest', name: 'Vitest' },
      kind: 'framework', category: 'testing',
      directText: 'Upgraded Jest across the monorepo to remove deprecated matchers.',
    },
    listed: { text: 'Core competencies: PostgreSQL, Redis.', items: [{ label: 'PostgreSQL', name: 'PostgreSQL', kind: 'technology', category: 'database' }, { label: 'Redis', name: 'Redis', kind: 'technology', category: 'database' }] },
    nearMiss: { sibling: 'Redis', extension: 'PostgreSQL 16', embedded: 'Postgres' },
    listing: {
      requires: 'Required: PostgreSQL performance tuning for reporting workloads.',
      unrelated: 'Preferred: Redis caching for session storage.',
    },
  }),
];

// ---------------------------------------------------------------------------
// Scenario sources. A scenario is just the ordered list of bullets after the
// four header lines. A mutation is therefore a change to SOURCE TEXT.
// ---------------------------------------------------------------------------

const ROLE_ID = 'role-1';
const canon = value => String(value || '').normalize('NFKC').toLocaleLowerCase();
const slug = value => canon(value).replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
const sha256 = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

function bulletsFor(c, scenario) {
  const base = [c.practice, c.filler, ...c.mentions];
  switch (scenario) {
    case 'A': return base;
    case 'added': return [...base, c.added];
    case 'upgrade': return [...base, c.upgrade];
    case 'alt': return [...base, c.alternative];
    case 'altDirect': return [...base, c.alternative, c.altDirect];
    case 'both': return [...base, c.added, c.upgrade];
    case 'soft': return [c.practice, c.softFiller, ...c.mentions];
    case 'listed': return [...base, c.listed];
    case 'projectMention': return [...base, c.projectMention];
    case 'projectUse': return [...base, c.projectUse];
    default: throw new Error(`unknown scenario ${scenario}`);
  }
}

function sourceTextFor(c, bullets) {
  const r = c.role;
  return [c.name, c.contact, `${r.title} at ${r.employer}, ${r.location}`, `${r.startDate} to ${r.endDate}`, ...bullets.map(item => item.text)].join('\n') + '\n';
}

const fileOf = (name, text) => ({ name, text, legacyText: text, contentHash: sha256(text), transcriptionAudit: verbatimCareerTranscriptionAuditReceipt() });

// `secondFileFrom: n` moves bullets n.. into a second career file, the way a
// person adds evidence by adding a file rather than editing one.
function sourceFilesFor(c, bullets, { secondFileFrom = null } = {}) {
  if (secondFileFrom == null) return [fileOf(`${c.key}-career.md`, sourceTextFor(c, bullets))];
  return [
    fileOf(`${c.key}-career.md`, sourceTextFor(c, bullets.slice(0, secondFileFrom))),
    fileOf(`${c.key}-addendum.md`, `${bullets.slice(secondFileFrom).map(item => item.text).join('\n')}\n`),
  ];
}

// Test-side oracle: derived purely from the spec bullets, never from production.
function oracle(bullets) {
  const supported = new Set();
  const qualifiedOnly = new Set();
  const seenSkill = new Set();
  for (const item of bullets) for (const use of item.uses) {
    if (use.disposition !== 'skill') continue;
    seenSkill.add(canon(use.name));
    if (use.relationship === 'independent' && use.indexEligible !== false) supported.add(canon(use.name));
  }
  for (const key of seenSkill) if (!supported.has(key)) qualifiedOnly.add(key);
  return { supported, qualifiedOnly };
}

function universe(c) {
  const names = new Set([c.practice.uses[0].name, c.addedName, c.softName, ...c.altNames, ...Object.values(c.nearMiss)]);
  for (const item of c.mentions) names.add(item.uses[0].name);
  return [...names];
}

// Own whole-term occurrence test used only to tie the oracle to the SOURCE TEXT.
function occursIn(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(text);
}

// Why the oracle says a name is (not) admissible, computed from the source text
// plus the spec's semantic annotations: 'absent' means the text never states it.
function explain(c, bullets, name) {
  const text = sourceTextFor(c, bullets);
  const key = canon(name);
  const uses = bullets.flatMap(item => item.uses).filter(use => canon(use.name) === key);
  if (!occursIn(text, name)) return 'absent';
  if (uses.some(use => use.disposition === 'skill' && use.relationship === 'independent' && use.indexEligible !== false)) return 'supported';
  if (uses.some(use => use.disposition === 'skill' && use.relationship === 'independent')) return 'soft';
  if (uses.some(use => use.disposition === 'skill')) return 'qualified';
  return 'mention';
}

// The spec must describe its own source text truthfully, or the oracle is meaningless.
function assertFixturesConsistent() {
  for (const c of CANDIDATES) {
    for (const scenario of ['A', 'added', 'upgrade', 'alt', 'altDirect', 'both', 'soft', 'listed', 'projectMention', 'projectUse']) {
      const bullets = bulletsFor(c, scenario);
      const text = sourceTextFor(c, bullets);
      for (const item of bullets) {
        assert(text.includes(`${item.text}\n`), `${c.key}/${scenario}: bullet text is a physical source line`);
        for (const use of item.uses) {
          assert(occursIn(item.text, use.label), `${c.key}/${scenario}: label ${use.label} must literally occur in its own sentence`);
          if (use.slice) assert(item.text.includes(use.slice) && occursIn(use.slice, use.label), `${c.key}/${scenario}: relationship slice must be a literal part of the sentence naming ${use.label}`);
          if (use.relationship === 'alternative') assert(/\beither\b[\s\S]*\bor\b/iu.test(use.slice), `${c.key}/${scenario}: an alternative is stated as a choice in the source`);
        }
      }
    }
    // The denied probes are genuinely absent from the baseline text.
    const baseline = bulletsFor(c, 'A');
    for (const name of [c.addedName, c.nearMiss.sibling, c.nearMiss.extension, c.nearMiss.embedded, ...c.altNames]) {
      assert(explain(c, baseline, name) === 'absent', `${c.key}: ${name} must not occur in baseline source A`);
    }
    // Every near-miss claim (changed extent, sibling, stem inside a longer word)
    // must also be absent as a whole term from every scenario that is mutated
    // from A, otherwise its rejection could be a fixture accident.
    for (const scenario of ['added', 'upgrade', 'alt', 'altDirect', 'both', 'soft', 'listed', 'projectMention', 'projectUse']) {
      const text = sourceTextFor(c, bulletsFor(c, scenario));
      for (const name of [c.nearMiss.extension, c.nearMiss.embedded]) {
        assert(!occursIn(text, name), `${c.key}/${scenario}: near-miss ${name} must not occur as a whole term in the source text`);
      }
      if (scenario !== 'listed') assert(!occursIn(text, c.nearMiss.sibling), `${c.key}/${scenario}: sibling ${c.nearMiss.sibling} must not occur in the source text`);
    }
    // The skills-section line states the added skill and the sibling, and nothing else of the denied set.
    assert(occursIn(sourceTextFor(c, bulletsFor(c, 'listed')), c.addedName) && occursIn(sourceTextFor(c, bulletsFor(c, 'listed')), c.nearMiss.sibling), `${c.key}: the skills-section line names the added skill and the sibling`);
    for (const item of c.mentions) assert(explain(c, baseline, item.uses[0].name) === 'mention', `${c.key}: ${item.uses[0].name} occurs in A only as a mention`);
  }
}

// ---------------------------------------------------------------------------
// The profile an honest extractor would return for a scenario. The builder is
// the "responder" stand-in; the production code under test is the validator,
// the compiler loop, the snapshot, and everything downstream of it.
// ---------------------------------------------------------------------------

function buildProfile(c, bullets, corpus) {
  const seg = corpus.segments.map(item => item.id);
  assert(seg.length === 4 + bullets.length, 'fixture: one source segment per physical line');
  const skills = new Map();
  const dispositions = new Map();
  const ensureRow = (use, segmentId, { direct }) => {
    const key = canon(use.name);
    const row = skills.get(key) || { id: `skill-${slug(use.name)}`, name: use.name, category: use.category, capabilityKind: use.kind, evidence: [], direct: [], indexable: true, roleIds: [ROLE_ID] };
    if (use.indexEligible === false) row.indexable = false;
    if (!row.evidence.includes(segmentId)) row.evidence.push(segmentId);
    if (direct && !row.direct.includes(segmentId)) row.direct.push(segmentId);
    skills.set(key, row);
    return row;
  };
  const ledgerFor = (item, segmentId) => item.uses.map(use => {
    const reference = {
      technology: use.label, disposition: use.disposition, relationship: use.relationship,
      relationshipGroup: use.group, relationshipEvidence: use.slice || item.text, evidenceSegmentIds: [segmentId],
    };
    if (use.disposition === 'non-skill') reference.nonSkillReason = use.reason;
    else reference.skillId = ensureRow(use, segmentId, { direct: use.relationship === 'independent' }).id;
    return reference;
  });
  const achievements = [];
  const projects = [];
  bullets.forEach((item, index) => {
    const segmentId = seg[4 + index];
    if (item.list) {
      // A bare skills-section line: no duty, no ledger, a role-less direct skill row.
      dispositions.set(segmentId, 'skill-evidence');
      for (const use of item.uses) ensureRow(use, segmentId, { direct: true }).roleIds = [];
      return;
    }
    if (item.project) {
      dispositions.set(segmentId, 'project');
      projects.push({
        id: `proj-${index + 1}`, name: item.project.name, description: item.project.description, roleId: ROLE_ID,
        technologies: item.uses.map(use => use.label), technologyReferences: ledgerFor(item, segmentId), metrics: [], evidenceSegmentIds: [segmentId],
      });
      return;
    }
    achievements.push({
      id: `ach-${index + 1}`, roleId: ROLE_ID, claim: item.text, technologies: item.uses.map(use => use.label),
      technologyReferences: ledgerFor(item, segmentId), metrics: [], evidenceSegmentIds: [segmentId],
    });
  });
  const skillRows = [...skills.values()].map(row => ({
    id: row.id, name: row.name, category: row.category, capabilityKind: row.capabilityKind,
    supportMode: row.direct.length ? 'direct' : 'relationship-qualified', directEvidenceSegmentIds: [...row.direct],
    indexEligible: row.direct.length > 0 && row.indexable, roleIds: [...row.roleIds], evidenceSegmentIds: [...row.evidence],
  }));
  const profile = {
    identity: { name: c.name, contacts: [c.contact], evidenceSegmentIds: [seg[0], seg[1]] },
    roles: [{
      id: ROLE_ID, title: c.role.title, employer: c.role.employer, startDate: c.role.startDate, endDate: c.role.endDate, location: c.role.location,
      achievementIds: achievements.map(item => item.id), skillIds: skillRows.filter(row => row.roleIds.includes(ROLE_ID)).map(row => row.id), evidenceSegmentIds: [seg[2], seg[3]],
    }],
    achievements, projects, skills: skillRows, education: [], certifications: [], otherEvidence: [],
    segmentCoverage: [],
  };
  profile.segmentCoverage = coverageFor(profile, seg, dispositions);
  return profile;
}

function coverageFor(profile, seg, dispositions = new Map()) {
  const owners = [['identity', profile.identity], ...['roles', 'achievements', 'projects', 'skills'].flatMap(group => profile[group].map(entity => [entity.id, entity]))];
  return seg.map((segmentId, index) => ({
    segmentId,
    disposition: index < 2 ? 'identity' : index < 4 ? 'role-header' : dispositions.get(segmentId) || 'achievement',
    entityIds: owners.filter(([, entity]) => entity.evidenceSegmentIds.includes(segmentId)).map(([id]) => id),
  }));
}

// Same reciprocal inverse index for hand-built profiles with arbitrary layouts.
function coverageForAny(profile, seg) {
  const owners = [['identity', profile.identity], ...['roles', 'achievements', 'projects', 'skills', 'education', 'certifications', 'otherEvidence'].flatMap(group => profile[group].map(entity => [entity.id, entity]))];
  return seg.map(segmentId => ({
    segmentId, disposition: 'context',
    entityIds: owners.filter(([, entity]) => entity.evidenceSegmentIds.includes(segmentId)).map(([id]) => id),
  }));
}

// What a page-sized model response looks like: host owns skillId binding and
// the coverage inverse; the responder owns the rest.
function pageShard(profile) {
  const shard = structuredClone(profile);
  for (const entity of [...shard.achievements, ...shard.projects]) for (const reference of entity.technologyReferences) delete reference.skillId;
  shard.rolePatches = [];
  shard.projectPatches = [];
  shard.continuationState = {
    roles: { mode: 'replace', ids: shard.roles.map(role => role.id) },
    projects: shard.projects.length ? { mode: 'replace', ids: shard.projects.map(project => project.id) } : { mode: 'inherit', ids: [] },
  };
  return shard;
}

const FIXED_NOW = () => '2026-10-09T00:00:00.000Z';

async function compileScenario(c, bullets, { transformShard = value => value, secondFileFrom = null, capture = null } = {}) {
  const files = sourceFilesFor(c, bullets, { secondFileFrom });
  const corpus = buildCareerSourceCorpus(files);
  const profile = buildProfile(c, bullets, corpus);
  const shard = transformShard(pageShard(profile));
  const calls = { compile: 0, repair: 0, audit: 0 };
  const result = await compileAuditedCareerSnapshot({
    sourceFiles: files, now: FIXED_NOW,
    callText: async (prompt, options) => {
      if (capture) capture.push({ task: options.task, prompt });
      if (options.task === 'career-profile-compile') { calls.compile += 1; return shard; }
      if (options.task === 'career-profile-repair') { calls.repair += 1; return shard; }
      calls.audit += 1;
      return { findings: [] };
    },
  });
  return { ...result, files, calls, builtProfile: profile };
}

// ---------------------------------------------------------------------------
// Production views of an approved snapshot, and the skill-admission probes.
// ---------------------------------------------------------------------------

function productionView(snapshot, listingQuotes = []) {
  const validation = validateCurrentCareerSnapshot(snapshot);
  assert(validation.valid, `fixture snapshot must satisfy the production snapshot contract: ${validation.errors?.join('; ')}`);
  const authority = buildApplicationCareerAuthority(snapshot);
  const catalog = approvedCareerEvidenceCatalog(snapshot);
  const listing = listingQuotes.map((quote, index) => ({ id: `listing-need-${index + 1}`, sourceId: 'job-listing', quote, priority: 'highest' }));
  return {
    snapshot, authority, catalog, listing,
    careerData: projectApprovedCareerSnapshotForApplication(snapshot),
    careerSkillEvidence: __snapshotCareerSkillEvidenceForTests(snapshot),
  };
}

const namesOf = items => new Set(items.map(canon));

function inventoryNames(view) {
  return {
    vetted: namesOf(vettedCareerSkillInventory(view.snapshot.profile).map(skill => skill.name)),
    legacy: namesOf(projectLegacyCareerProfile(view.snapshot.profile).skills),
    wire: namesOf(view.careerSkillEvidence.skills.map(skill => skill.name)),
  };
}

// An attacker (or a careless responder) that knows opaque IDs: cite the
// profile row's own skill catalog lines when they exist, otherwise forge the
// id that row would have had.
function skillEvidenceIdsFor(view, name) {
  const row = view.snapshot.profile.skills.find(skill => canon(skill.name) === canon(name));
  if (!row) return [];
  const real = view.catalog.filter(entry => entry.id.startsWith(`host.career.skill.${row.id}.`)).map(entry => entry.id);
  return real.length ? real : [`host.career.skill.${row.id}.1`];
}

// The caller supplies the evidence a careless or hostile responder would: the
// real skill-row catalog lines when the row exists, otherwise a forged id.
// production checks the NAME against the approved inventory before it looks at
// any evidence id, so a rejection here is about the skill itself.
function authorityVerdict(view, name, evidenceIds = null) {
  let ids = evidenceIds || skillEvidenceIdsFor(view, name);
  if (!ids.length) ids = [`host.career.skill.skill-${slug(name)}.1`];
  try { validateAuthoritySkillGroup(view.authority, [name], ids); return { admitted: true, message: '' }; } catch (error) { return { admitted: false, message: String(error?.message || error) }; }
}

const authorityAdmits = (view, name) => authorityVerdict(view, name).admitted;

const SKILL_ROW_CHARS = 64;
const CORE_SKILL_GROUP_LABELS = ['Competencies', 'Tools'];

// A rendered-skills attempt: everything production says is REQUIRED for this
// listing, plus the one item under test in its own group, citing the best
// evidence a responder could find (the quotes that literally name it).
// `wire` replaces the projection the validator receives (tamper tests);
// `evidenceFor` replaces the evidence a group cites for an item.
function resumeAttempt(view, name, { omit = [], items = null, wire = null, evidenceFor = null } = {}) {
  const role = view.authority.sourceRoles[0];
  const evidenceCatalog = [...view.catalog, ...view.listing];
  const required = requiredCareerAttestedSkillTerms(evidenceCatalog, view.careerSkillEvidence);
  const baseItems = items || required.filter(item => !omit.some(skipped => canon(skipped) === canon(item)));
  const claimEvidence = itemName => {
    if (evidenceFor) {
      const chosen = evidenceFor(itemName);
      if (chosen) return chosen;
    }
    const ids = skillEvidenceIdsFor(view, itemName).filter(id => view.catalog.some(entry => entry.id === id));
    if (ids.length) return ids;
    const naming = view.catalog.filter(entry => entry.sourceId === 'career-data' && new RegExp(`(^|[^\\p{L}\\p{N}])${itemName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(entry.quote)).map(entry => entry.id);
    return naming.length ? naming : [view.catalog.find(entry => entry.id.startsWith('host.career.achievement.')).id];
  };
  // The design-system budget is one printed line per row (64 characters, three rows at most). Pack the
  // required items under it so that no rejection below can be about row length instead of the item.
  const rows = [];
  for (const item of baseItems) {
    const last = rows.at(-1);
    if (last && [...last, item].join(' \u00b7 ').length <= SKILL_ROW_CHARS) last.push(item); else rows.push([item]);
  }
  assert(rows.length <= CORE_SKILL_GROUP_LABELS.length, `fixture: the required skills fit ${CORE_SKILL_GROUP_LABELS.length} rows (${JSON.stringify(baseItems)})`);
  const skills = rows.map((row, index) => ({ id: `skills-core-${index + 1}`, group: CORE_SKILL_GROUP_LABELS[index], items: row, evidenceIds: [...new Set(row.flatMap(claimEvidence))] }));
  if (name && !baseItems.some(item => canon(item) === canon(name))) skills.push({ id: 'skills-probe', group: 'Methods', items: [name], evidenceIds: claimEvidence(name) });
  const achievement = view.catalog.find(entry => entry.id.startsWith('host.career.achievement.') && entry.id.endsWith('.1'));
  const draft = {
    schemaVersion: 'structured-resume.v1',
    identity: { name: view.authority.identity.name, contact: [...view.authority.identity.contact] },
    roles: [{ id: role.id, title: role.title, company: role.company, dates: role.dates, location: role.location, bullets: [{ id: 'bullet-1', text: 'Delivered the duties this role documents.', evidenceIds: [achievement.id] }] }],
    skills,
  };
  try {
    const validated = validateStructuredApplicationResume(draft, {
      sourceRoles: view.authority.sourceRoles, evidenceCatalog, trustedIdentity: view.authority.identity,
      careerData: view.careerData, careerSkillEvidence: wire || view.careerSkillEvidence, authorityMode: true,
    });
    // Index completeness (a skills block that leaves out a name the posting and
    // the career data both state) is TASTE: it advises, so an accepted draft is
    // still told what its block omits, and `advice` is where that is observed.
    return { accepted: true, message: '', advice: validated.advisories.map(entry => entry.detail).join(' '), required };
  } catch (error) {
    return { accepted: false, message: String(error?.message || error), advice: '', required };
  }
}

function neutralListing() {
  return ['This posting asks for careful, source-backed work and does not name any tool.'];
}

function expectAdmission(view, name, expected, label) {
  const authority = authorityVerdict(view, name);
  const resume = resumeAttempt(view, name);
  assert(authority.admitted === expected, `${label}: authority admission of ${JSON.stringify(name)} was ${authority.admitted}, expected ${expected} (${authority.message.slice(0, 200)})`);
  assert(resume.accepted === expected, `${label}: résumé admission of ${JSON.stringify(name)} was ${resume.accepted}, expected ${expected} (${resume.message.slice(0, 220)})`);
  if (expected) {
    // Control: the probe slot itself is not what makes a rejection happen. The
    // very same skill, moved out of the required core group into the probe
    // group, is accepted, so every rejection below is about the item.
    const moved = resumeAttempt(view, name, { omit: [name] });
    assert(moved.accepted, `${label}: ${JSON.stringify(name)} must also be accepted when it is the single item of the probe group (${moved.message.slice(0, 200)})`);
  } else {
    // Isolation: both gates must reject THIS item, by the approved-inventory rule, and not because of some other defect in the draft.
    assert(authority.message.includes(`Skill item ${JSON.stringify(name)} is not an exact index-eligible approved skill`), `${label}: authority must refuse ${JSON.stringify(name)} by the approved-inventory rule (${authority.message.slice(0, 200)})`);
    assert(resume.message.includes(`item "${name}" is not an exact, index-eligible approved snapshot skill`), `${label}: résumé must refuse ${JSON.stringify(name)} by the approved-inventory rule (${resume.message.slice(0, 260)})`);
  }
}

function assertViewMatchesOracle(c, bullets, view, label) {
  const { supported } = oracle(bullets);
  const inventories = inventoryNames(view);
  for (const [kind, names] of Object.entries(inventories)) {
    assert(names.size === supported.size && [...supported].every(name => names.has(name)),
      `${label}: ${kind} skill inventory ${JSON.stringify([...names])} must equal the source-evidenced set ${JSON.stringify([...supported])}`);
  }
  // What a skills block MUST carry is derived by production from the same approved snapshot.
  const required = namesOf(resumeAttempt(view, null).required);
  assert(required.size === supported.size && [...supported].every(name => required.has(name)),
    `${label}: required skills ${JSON.stringify([...required])} must equal the source-evidenced set ${JSON.stringify([...supported])}`);
  for (const name of universe(c)) {
    const why = explain(c, bullets, name);
    // The oracle's verdict must follow from the source text and the spec's annotations.
    assert((why === 'supported') === supported.has(canon(name)), `${label} ${c.key}: oracle verdict for ${name} is incoherent with its explanation (${why})`);
    expectAdmission(view, name, why === 'supported', `${label} ${c.key} (${why})`);
  }
}

const errorsOf = result => result.errors.join(' | ');

// ---------------------------------------------------------------------------
// Mutation helpers (all operate on SOURCE TEXT or on a responder's claims).
// ---------------------------------------------------------------------------

const NEUTRAL_LINE = bullet('Attended weekly staff meetings and recorded the action items.');

function withoutBullet(bullets, removed) {
  return bullets.filter(item => item !== removed);
}

function replaceBullet(bullets, removed, replacement) {
  return bullets.map(item => (item === removed ? replacement : item));
}

// A responder claim that no source line backs: an extra direct skill row that
// cites the given segments, kept reciprocal so ONLY grounding can reject it.
function withForgedSkill(profile, corpus, { id, name, cite }) {
  const forged = structuredClone(profile);
  forged.skills.push({
    id, name, category: 'claimed', capabilityKind: 'capability', supportMode: 'direct',
    directEvidenceSegmentIds: [...cite], indexEligible: true, roleIds: [ROLE_ID], evidenceSegmentIds: [...cite],
  });
  forged.roles[0].skillIds.push(id);
  forged.segmentCoverage = coverageFor(forged, corpus.segments.map(item => item.id));
  return forged;
}

// Segment ids of the physical source lines holding exactly these texts.
function segmentsOf(corpus, texts) {
  return texts.map(text => {
    const found = corpus.segments.filter(segment => segment.text.trim() === text);
    assert(found.length === 1, `fixture: exactly one source segment holds ${JSON.stringify(text)}`);
    return found[0].id;
  });
}

// Apply ONE edit to a copy of a faithful profile, keep the reciprocal coverage
// index honest, and run the real deterministic validator. The caller asserts the
// specific reason, and that nothing else became invalid.
function validateTampered(profile, corpus, mutate) {
  const copy = structuredClone(profile);
  mutate(copy);
  copy.segmentCoverage = coverageFor(copy, corpus.segments.map(item => item.id));
  return validateCareerProfile(copy, corpus);
}

function achievementSegments(profile) {
  return profile.achievements.flatMap(item => item.evidenceSegmentIds);
}

function fullWidth(value) {
  return [...value].map(char => (char >= '!' && char <= '~' ? String.fromCodePoint(char.codePointAt(0) + 0xFEE0) : char)).join('');
}

function stripUntrusted(prompt) {
  // The data blocks start at the beginning of a line; the instructions mention the tag names inline.
  return prompt.replace(/^<(UNTRUSTED_[A-Z_]+)>$[\s\S]*?^<\/\1>$/gmu, '<$1/>');
}

async function expectCompileFailure(run) {
  try { await run(); } catch (error) { return error; }
  throw new Error('expected the production compile loop to refuse approval, but it approved a snapshot');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

export default [
  {
    name: 'adaptability skills: synthetic fixture matrix is domain-diverse and every baseline compiles to an approved snapshot whose skill inventory is exactly the source-evidenced set',
    run: async () => {
      assert(CANDIDATES.length >= 6 && new Set(CANDIDATES.map(c => c.role.title)).size === CANDIDATES.length, 'fixture matrix needs six unrelated careers');
      assert(CANDIDATES.every(c => c.contact.endsWith('@example.test')), 'fixture contacts use the reserved synthetic domain');
      assertFixturesConsistent();
      for (const c of CANDIDATES) {
        const bullets = bulletsFor(c, 'A');
        const compiled = await compileScenario(c, bullets);
        const view = productionView(compiled.snapshot, neutralListing());
        const { supported } = oracle(bullets);
        // The only skill a baseline source demonstrates is its practiced skill.
        assert(supported.size === 1 && supported.has(canon(c.practice.uses[0].name)), `${c.key}: oracle sanity`);
        assertViewMatchesOracle(c, bullets, view, 'baseline');
        // Mentions never even reach a skill row: they stay in the technology ledger.
        const ledger = compiled.profile.achievements.flatMap(item => item.technologyReferences);
        for (const mention of c.mentions) {
          const label = mention.uses[0].label;
          assert(ledger.some(reference => reference.technology === label && reference.disposition === 'non-skill'), `${c.key}: ${label} keeps its explicit non-skill disposition`);
          assert(!compiled.profile.skills.some(skill => canon(skill.name) === canon(label)), `${c.key}: ${label} must not be a skill row`);
        }
        // The compile path is content-addressed: same text, same id.
        assert(compiled.snapshotId === careerSnapshotId(buildCareerSourceCorpus(sourceFilesFor(c, bullets))), `${c.key}: snapshot id is derived from the source corpus`);
      }
    },
  },
  {
    name: 'adaptability skills: (a) a skill absent from the source, and near-miss claims about present text, are rejected by deterministic profile validation in every domain',
    run: () => {
      for (const c of CANDIDATES) {
        // Source A does not mention the added skill anywhere.
        const aBullets = bulletsFor(c, 'A');
        const aCorpus = buildCareerSourceCorpus(sourceFilesFor(c, aBullets));
        const aProfile = buildProfile(c, aBullets, aCorpus);
        assert(validateCareerProfile(aProfile, aCorpus).valid, `${c.key}: faithful baseline profile is valid`);
        const absent = validateCareerProfile(withForgedSkill(aProfile, aCorpus, { id: 'skill-forged-absent', name: c.addedName, cite: achievementSegments(aProfile) }), aCorpus);
        assert(!absent.valid && absent.errors.some(error => error.includes('skills[skill-forged-absent].name is not grounded')),
          `${c.key}: a skill absent from source A must fail literal grounding (${errorsOf(absent).slice(0, 200)})`);
        // Isolation: the forged row is the ONLY thing wrong with an otherwise faithful profile.
        assert(absent.errors.every(error => error.includes('skills[skill-forged-absent]')), `${c.key}: every validation error names the forged row, nothing else is broken (${errorsOf(absent).slice(0, 300)})`);

        // Source B demonstrates it, so the same claim becomes valid, and each
        // near-miss of that very text is still refused.
        const bBullets = bulletsFor(c, 'added');
        const bCorpus = buildCareerSourceCorpus(sourceFilesFor(c, bBullets));
        const bProfile = buildProfile(c, bBullets, bCorpus);
        assert(validateCareerProfile(bProfile, bCorpus).valid, `${c.key}: faithful B profile is valid`);
        for (const [kind, claim] of Object.entries(c.nearMiss)) {
          const result = validateCareerProfile(withForgedSkill(bProfile, bCorpus, { id: `skill-forged-${kind}`, name: claim, cite: achievementSegments(bProfile) }), bCorpus);
          assert(!result.valid && result.errors.some(error => error.includes(`skills[skill-forged-${kind}].name is not grounded`)),
            `${c.key}: near-miss ${kind} claim ${JSON.stringify(claim)} must be rejected (${errorsOf(result).slice(0, 200)})`);
          assert(result.errors.every(error => error.includes(`skills[skill-forged-${kind}]`)), `${c.key}: near-miss ${kind}: the forged row is the only defect (${errorsOf(result).slice(0, 300)})`);
        }
      }
    },
  },
  {
    name: 'adaptability skills: the compile loop never approves an ungrounded skill; a responder that repairs it is approved without the skill',
    run: async () => {
      for (const c of CANDIDATES) {
        const bullets = bulletsFor(c, 'A');
        const forgeShard = shard => {
          const seg = shard.achievements.map(item => item.evidenceSegmentIds[0]);
          shard.skills.push({
            id: 'skill-forged', name: c.addedName, category: 'claimed', capabilityKind: 'capability', supportMode: 'direct',
            directEvidenceSegmentIds: seg, indexEligible: true, roleIds: [ROLE_ID], evidenceSegmentIds: seg,
          });
          shard.roles[0].skillIds.push('skill-forged');
          return shard;
        };
        const groundingFinding = 'skills[p0001-skill-forged].name is not grounded in its cited source segment(s).';
        const files = sourceFilesFor(c, bullets);
        const corpus = buildCareerSourceCorpus(files);
        const faithful = pageShard(buildProfile(c, bullets, corpus));
        const run = async repairShard => {
          const repairPrompts = [];
          const outcome = await compileAuditedCareerSnapshot({
            sourceFiles: files, now: FIXED_NOW,
            callText: async (prompt, options) => {
              if (options.task === 'career-profile-compile') return forgeShard(structuredClone(faithful));
              if (options.task === 'career-profile-repair') { repairPrompts.push(prompt); return repairShard(); }
              return { findings: [] };
            },
          }).then(result => ({ result }), error => ({ error }));
          return { ...outcome, repairPrompts };
        };

        // 1) A responder that insists on the forged skill is refused outright, and the
        //    reason handed to its repair round is the literal-grounding finding about that row.
        const insisting = await run(() => forgeShard(structuredClone(faithful)));
        assert(insisting.error && /^CAREER_SNAPSHOT_[A-Z_]+$/u.test(String(insisting.error.code)) && !insisting.result,
          `${c.key}: insisting on an ungrounded skill must end in a typed hard refusal, never an approved snapshot (${insisting.error?.code})`);
        assert(insisting.repairPrompts.length >= 1 && insisting.repairPrompts[0].includes(groundingFinding),
          `${c.key}: the repair round was told that the forged skill is ungrounded`);

        // 2) A responder that drops it on the targeted repair round is approved.
        const repaired = await run(() => structuredClone(faithful));
        assert(!repaired.error, `${c.key}: a responder that drops the forged skill is approved (${repaired.error?.message})`);
        const { result } = repaired;
        assert(repaired.repairPrompts.length >= 1 && repaired.repairPrompts[0].includes(groundingFinding), `${c.key}: deterministic failure of the grounding rule triggered the repair round`);
        // Production folds the failed round into a tamper-evident prefix and approves only a clean final round.
        const history = result.snapshot.auditHistory;
        assert(history[0].kind === 'folded' && history[0].roundCount >= 1 && history.at(-1).deterministicFailureCount === 0 && history.at(-1).unresolvedCount === 0,
          `${c.key}: the failed first round is folded into the retained audit history and the approved round is clean`);
        assert(!result.profile.skills.some(skill => skill.id.endsWith('skill-forged')), `${c.key}: the forged row is gone from the approved profile`);
        const view = productionView(result.snapshot, neutralListing());
        assertViewMatchesOracle(c, bullets, view, 'after repair');
        expectAdmission(view, c.addedName, false, `${c.key} forged skill after repair`);
      }
    },
  },
  {
    name: 'adaptability skills: (a)(b)(c) recompilation cycle A -> B -> C admits a directly demonstrated skill only while its sentence exists, and near-misses stay rejected',
    run: async () => {
      for (const c of CANDIDATES) {
        const A = await compileScenario(c, bulletsFor(c, 'A'));
        const bBullets = bulletsFor(c, 'added');
        const B = await compileScenario(c, bBullets);
        // C is B with the evidence removed; C' replaces it with unrelated text.
        const C = await compileScenario(c, withoutBullet(bBullets, c.added));
        const replacedBullets = replaceBullet(bBullets, c.added, NEUTRAL_LINE);
        const Cprime = await compileScenario(c, replacedBullets);

        assert(new Set([A.snapshotId, B.snapshotId, Cprime.snapshotId]).size === 3, `${c.key}: each distinct source gets its own snapshot id`);
        assert(C.snapshotId === A.snapshotId, `${c.key}: removing the evidence returns to the original content-addressed snapshot, never a stale B`);

        const viewA = productionView(A.snapshot, [c.listing.requires]);
        const viewB = productionView(B.snapshot, [c.listing.requires]);
        const viewC = productionView(C.snapshot, [c.listing.requires]);
        const viewCprime = productionView(Cprime.snapshot, [c.listing.requires]);
        assertViewMatchesOracle(c, bulletsFor(c, 'A'), viewA, 'A');
        assertViewMatchesOracle(c, bBullets, viewB, 'B');
        assertViewMatchesOracle(c, withoutBullet(bBullets, c.added), viewC, 'C');
        assertViewMatchesOracle(c, replacedBullets, viewCprime, 'C-prime');

        // Dynamic constraint: the same skill flips A:no, B:yes, C:no, with no code change.
        expectAdmission(viewA, c.addedName, false, `${c.key} A`);
        expectAdmission(viewB, c.addedName, true, `${c.key} B`);
        expectAdmission(viewC, c.addedName, false, `${c.key} C`);
        expectAdmission(viewCprime, c.addedName, false, `${c.key} C-prime`);
        for (const claim of Object.values(c.nearMiss)) expectAdmission(viewB, claim, false, `${c.key} B near-miss ${claim}`);

        // Previously supported evidence is untouched by the mutation.
        expectAdmission(viewB, c.practice.uses[0].name, true, `${c.key} B retained`);
        expectAdmission(viewCprime, c.practice.uses[0].name, true, `${c.key} C-prime retained`);

        // The frozen skill projection moves with the source.
        assert(viewA.authority.digests.skills !== viewB.authority.digests.skills && viewA.authority.digests.skills === viewC.authority.digests.skills,
          `${c.key}: authority skill digest changes with the source and reverts when the evidence is removed`);
        assert(!viewA.catalog.some(entry => entry.quote.includes(c.addedName)) && viewB.catalog.some(entry => entry.id.includes('.skill.') && entry.quote.includes(c.addedName)),
          `${c.key}: the approved evidence catalog gains, then loses, the skill line`);

        // A responder that keeps asserting B's skill after the sentence was
        // removed (stale claim) cannot stay valid against the new corpus.
        const cPrimeCorpus = buildCareerSourceCorpus(sourceFilesFor(c, replacedBullets));
        const stale = validateCareerProfile(B.builtProfile, cPrimeCorpus);
        const staleRow = `skills[${B.builtProfile.skills.find(skill => canon(skill.name) === canon(c.addedName)).id}]`;
        assert(!stale.valid && stale.errors.includes(`${staleRow}.name is not grounded in its cited source segment(s).`) && stale.errors.includes(`${staleRow}.directEvidenceSegmentIds do not literally demonstrate the skill name.`),
          `${c.key}: B's skill row fails against corpus C-prime because its sentence is gone (${errorsOf(stale).slice(0, 300)})`);
        assert(validateCareerProfile(B.builtProfile, buildCareerSourceCorpus(sourceFilesFor(c, bBullets))).valid, `${c.key}: control: the same B profile is valid against B's own corpus`);
      }
    },
  },
  {
    name: 'adaptability skills: a mere mention (employer system, rejected evaluation, vendor) is grounded text but never a skill; direct use of the same label admits it and removing that use reverts',
    run: async () => {
      for (const c of CANDIDATES) {
        const A = await compileScenario(c, bulletsFor(c, 'A'));
        const viewA = productionView(A.snapshot, neutralListing());
        for (const mention of c.mentions) {
          const label = mention.uses[0].label;
          const attempt = resumeAttempt(viewA, label);
          // The rail that matters: the label IS quoted by approved career evidence...
          assert(viewA.catalog.some(entry => entry.sourceId === 'career-data' && entry.quote.includes(label)), `${c.key}: approved catalog quotes the mention ${label}`);
          // ...so grounding passes, and only the approved-inventory gate refuses it.
          assert(!attempt.accepted && !/must occur in its cited career-data evidence/u.test(attempt.message)
            && attempt.message.includes(`item "${label}" is not an exact, index-eligible approved snapshot skill`),
          `${c.key}: mention ${label} must be refused as a non-approved skill, not as ungrounded (${attempt.message.slice(0, 240)})`);
          assert(authorityAdmits(viewA, label) === false, `${c.key}: authority refuses ${label}`);
        }

        // B: the candidate actually operated the employer system.
        const upBullets = bulletsFor(c, 'upgrade');
        const B = await compileScenario(c, upBullets);
        const viewB = productionView(B.snapshot, neutralListing());
        assertViewMatchesOracle(c, upBullets, viewB, 'mention upgraded to use');
        const upgraded = c.mentions[0].uses[0].label;
        expectAdmission(viewB, upgraded, true, `${c.key} upgraded`);
        // The other two mentions are still only mentions.
        for (const mention of c.mentions.slice(1)) expectAdmission(viewB, mention.uses[0].label, false, `${c.key} other mention`);
        // The skill's direct evidence is the use sentence, never the mention line.
        const row = B.profile.skills.find(skill => canon(skill.name) === canon(upgraded));
        const direct = B.snapshot.segments.filter(segment => row.directEvidenceSegmentIds.includes(segment.id)).map(segment => segment.text);
        assert(direct.length === 1 && direct[0].includes(c.upgrade.text), `${c.key}: direct evidence of ${upgraded} is exactly the use sentence`);

        // C: delete the use sentence; the mention alone cannot keep it.
        const C = await compileScenario(c, withoutBullet(upBullets, c.upgrade));
        assert(C.snapshotId === A.snapshotId, `${c.key}: reverting the source reverts the snapshot id`);
        expectAdmission(productionView(C.snapshot, neutralListing()), upgraded, false, `${c.key} C`);
      }
    },
  },
  {
    name: 'adaptability skills: flipping a mention to a skill disposition needs a vetted skill row; the ledger alone cannot mint a skill',
    run: async () => {
      for (const c of CANDIDATES) {
        const bullets = bulletsFor(c, 'A');
        const mentionBullet = c.mentions[0];
        const label = mentionBullet.uses[0].label;
        const flip = shard => {
          const achievement = shard.achievements.find(item => item.claim === mentionBullet.text);
          const [reference] = achievement.technologyReferences;
          reference.disposition = 'skill';
          delete reference.nonSkillReason;
          return shard;
        };
        const seen = [];
        const error = await expectCompileFailure(() => compileScenario(c, bullets, { transformShard: flip, capture: seen }));
        assert(/CAREER_SNAPSHOT_[A-Z_]+/u.test(String(error.code)), `${c.key}: refusal for ${label} is a typed hard error`);
        assert(seen.some(entry => entry.task === 'career-profile-repair' && entry.prompt.includes('technologyReferences[0].skillId must resolve to one exact source-linked approved skill')),
          `${c.key}: the repair round was told that ${label} has no approved skill row to bind to`);
        // Direct validation names the missing vetted skill.
        const corpus = buildCareerSourceCorpus(sourceFilesFor(c, bullets));
        const profile = buildProfile(c, bullets, corpus);
        const reference = profile.achievements.find(item => item.claim === mentionBullet.text).technologyReferences[0];
        reference.disposition = 'skill'; delete reference.nonSkillReason;
        const result = validateCareerProfile(profile, corpus);
        assert(!result.valid && result.errors.some(item => item.includes('skillId must resolve to one exact source-linked approved skill')), `${c.key}: ${errorsOf(result).slice(0, 200)}`);
      }
    },
  },
  {
    name: 'adaptability skills: alternatives stay relationship-qualified (never bare skills); one separate direct sentence upgrades exactly that skill and removing it downgrades it',
    run: async () => {
      for (const c of CANDIDATES) {
        const [nameA, nameB] = c.altNames;
        const altBullets = bulletsFor(c, 'alt');
        const alt = await compileScenario(c, altBullets);
        // Production keeps both rows in the profile but marks them qualified.
        const rows = alt.profile.skills.filter(skill => c.altNames.some(name => canon(name) === canon(skill.name)));
        assert(rows.length === 2 && rows.every(row => row.supportMode === 'relationship-qualified' && row.indexEligible === false && row.directEvidenceSegmentIds.length === 0),
          `${c.key}: both alternatives are relationship-qualified rows`);
        const viewAlt = productionView(alt.snapshot, neutralListing());
        assertViewMatchesOracle(c, altBullets, viewAlt, 'alternatives');
        for (const name of c.altNames) {
          assert(authorityAdmits(viewAlt, name) === false, `${c.key}: an opaque id known to the caller still cannot promote ${name}`);
          assert(!viewAlt.catalog.some(entry => entry.id.includes('.skill.') && entry.quote.includes(name)), `${c.key}: ${name} has no standalone catalog skill line`);
        }
        // The relationship-aware achievement evidence is still there for honest prose:
        // each alternative label keeps its own ledger line, an `alternative` relation line,
        // the shared group and the literal slice, but no standalone skill line.
        for (const use of c.alternative.uses) {
          const prefix = viewAlt.catalog.find(entry => entry.id.includes('.achievement.') && entry.quote.includes('- Technology [') && entry.quote.endsWith(`: ${use.label}`)).id.replace(/\.\d+$/u, '');
          const lines = viewAlt.catalog.filter(entry => entry.id.startsWith(`${prefix}.`)).map(entry => entry.quote);
          assert(lines.some(line => /Usage relationship.*: alternative$/u.test(line)) && lines.some(line => line.includes(`: ${use.group}`)) && lines.some(line => line.endsWith(use.slice)),
            `${c.key}: the relation-aware evidence for ${use.label} keeps its alternative relation, group and literal slice (${JSON.stringify(lines).slice(0, 300)})`);
        }

        // Near-miss on the relationship: the SAME ledger, but a responder
        // flattens both alternatives into direct, index-eligible skills.
        const corpus = buildCareerSourceCorpus(sourceFilesFor(c, altBullets));
        const flattened = buildProfile(c, altBullets, corpus);
        for (const row of flattened.skills) if (c.altNames.some(name => canon(name) === canon(row.name))) {
          row.supportMode = 'direct'; row.directEvidenceSegmentIds = [...row.evidenceSegmentIds]; row.indexEligible = true;
        }
        const flatResult = validateCareerProfile(flattened, corpus);
        assert(!flatResult.valid && flatResult.errors.filter(error => /shares relationship-qualified evidence but has no whole-term skill occurrence outside every literal relationshipEvidence slice/u.test(error)).length === 2,
          `${c.key}: flattening an alternative into bare skills is refused for both labels (${errorsOf(flatResult).slice(0, 240)})`);

        // B: a separate sentence states direct use of one alternative only.
        const directBullets = bulletsFor(c, 'altDirect');
        const direct = await compileScenario(c, directBullets);
        const viewDirect = productionView(direct.snapshot, neutralListing());
        assertViewMatchesOracle(c, directBullets, viewDirect, 'alternative upgraded');
        expectAdmission(viewDirect, nameA, true, `${c.key} upgraded alternative`);
        expectAdmission(viewDirect, nameB, false, `${c.key} sibling alternative`);
        const directRow = direct.profile.skills.find(skill => canon(skill.name) === canon(nameA));
        assert(directRow.supportMode === 'direct' && directRow.directEvidenceSegmentIds.length === 1, `${c.key}: ${nameA} has exactly its separate sentence as direct evidence`);

        // C: delete the direct sentence; back to qualified-only.
        const reverted = await compileScenario(c, withoutBullet(directBullets, c.altDirect));
        assert(reverted.snapshotId === alt.snapshotId, `${c.key}: reverted source yields the earlier snapshot`);
        expectAdmission(productionView(reverted.snapshot, neutralListing()), nameA, false, `${c.key} downgraded alternative`);
      }
    },
  },
  {
    name: 'adaptability skills: case and Unicode spellings resolve to one canonical skill; a duplicate spelling is rejected; a ledger label in another case binds to the same skill',
    run: async () => {
      for (const c of CANDIDATES) {
        const bBullets = bulletsFor(c, 'added');
        const corpus = buildCareerSourceCorpus(sourceFilesFor(c, bBullets));
        const profile = buildProfile(c, bBullets, corpus);
        const addedSegment = profile.achievements.at(-1).evidenceSegmentIds;
        // A differently cased or width-folded second row is the SAME skill and
        // may not be admitted as a second ATS keyword.
        for (const [kind, variant] of [['upper-case', c.addedName.toUpperCase()], ['full-width', fullWidth(c.addedName)]]) {
          const result = validateCareerProfile(withForgedSkill(profile, corpus, { id: `skill-variant-${kind}`, name: variant, cite: addedSegment }), corpus);
          assert(!result.valid && result.errors.some(error => error.includes(`skills[skill-variant-${kind}].name duplicates the Unicode/case-insensitive skill name`)),
            `${c.key}: ${kind} duplicate spelling of ${c.addedName} must be refused (${errorsOf(result).slice(0, 200)})`);
        }

        // The ledger label is the source's own spelling; whatever its case, the
        // host binds it to the single canonical skill row by normalized name.
        const upperLedger = shard => {
          for (const achievement of shard.achievements) {
            achievement.technologies = achievement.technologies.map(label => label.toUpperCase());
            for (const reference of achievement.technologyReferences) reference.technology = reference.technology.toUpperCase();
          }
          return shard;
        };
        const compiled = await compileScenario(c, bBullets, { transformShard: upperLedger });
        const row = compiled.profile.skills.find(skill => canon(skill.name) === canon(c.addedName));
        const bound = compiled.profile.achievements.flatMap(item => item.technologyReferences).filter(reference => reference.disposition === 'skill' && canon(reference.technology) === canon(c.addedName));
        assert(row && bound.length === 1 && bound[0].skillId === row.id, `${c.key}: an upper-case ledger label binds to the canonical ${c.addedName} row`);
        expectAdmission(productionView(compiled.snapshot, neutralListing()), c.addedName, true, `${c.key} canonical spelling`);
        // The row name production keeps is the responder's canonical spelling,
        // not a lower-cased copy of the source line.
        assert(row.name === c.addedName, `${c.key}: canonical spelling ${c.addedName} retained`);
      }
    },
  },
  {
    name: 'adaptability skills: a soft or conceptual capability stays in the profile but is never a bare skills-block or authority term',
    run: async () => {
      for (const c of CANDIDATES) {
        const bullets = bulletsFor(c, 'soft');
        const compiled = await compileScenario(c, bullets);
        const row = compiled.profile.skills.find(skill => canon(skill.name) === canon(c.softName));
        assert(row && row.indexEligible === false && row.supportMode === 'direct', `${c.key}: ${c.softName} is retained as an approved non-indexable capability`);
        const view = productionView(compiled.snapshot, neutralListing());
        assertViewMatchesOracle(c, bullets, view, 'soft capability');
        assert(!view.catalog.some(entry => entry.id.includes('.skill.') && entry.quote.includes(c.softName)), `${c.key}: no standalone catalog skill line for ${c.softName}`);
        // Its prose is still approved achievement evidence for honest bullets.
        assert(view.catalog.some(entry => entry.id.includes('.achievement.') && entry.quote.includes(c.filler.text)), `${c.key}: the duty sentence itself remains citable`);
        const claim = resumeAttempt(view, c.softName);
        assert(!claim.accepted && claim.message.includes(`item "${c.softName}" is not an exact, index-eligible approved snapshot skill`), `${c.key}: ${c.softName} is refused as a skills-block item (${claim.message.slice(0, 200)})`);
      }
    },
  },
  {
    name: 'adaptability skills: evidence added as a second career file admits the skill, dropping that file removes it again, and independent additions compose',
    run: async () => {
      for (const c of CANDIDATES) {
        const A = await compileScenario(c, bulletsFor(c, 'A'));
        const addedBullets = bulletsFor(c, 'added');
        const split = addedBullets.length - 1;
        const B = await compileScenario(c, addedBullets, { secondFileFrom: split });
        assert(B.snapshot.sources.length === 2 && B.snapshot.sources[1].name === `${c.key}-addendum.md`, `${c.key}: the evidence lives in a second source file`);
        assertViewMatchesOracle(c, addedBullets, productionView(B.snapshot, neutralListing()), 'second file');
        const C = await compileScenario(c, withoutBullet(addedBullets, c.added));
        assert(C.snapshotId === A.snapshotId && B.snapshotId !== A.snapshotId, `${c.key}: dropping the second file returns to the first file's snapshot id`);
        expectAdmission(productionView(C.snapshot, neutralListing()), c.addedName, false, `${c.key} file dropped`);

        // Two independent additions: both admitted; removing either leaves the other.
        const bothBullets = bulletsFor(c, 'both');
        const both = await compileScenario(c, bothBullets);
        const viewBoth = productionView(both.snapshot, neutralListing());
        assertViewMatchesOracle(c, bothBullets, viewBoth, 'both additions');
        expectAdmission(viewBoth, c.addedName, true, `${c.key} both: added`);
        expectAdmission(viewBoth, c.mentions[0].uses[0].label, true, `${c.key} both: upgraded mention`);
        const withoutAdded = await compileScenario(c, withoutBullet(bothBullets, c.added));
        const withoutUpgrade = await compileScenario(c, withoutBullet(bothBullets, c.upgrade));
        assert(withoutAdded.snapshotId === (await compileScenario(c, bulletsFor(c, 'upgrade'))).snapshotId && withoutUpgrade.snapshotId === (await compileScenario(c, bulletsFor(c, 'added'))).snapshotId,
          `${c.key}: removing one addition yields exactly the corresponding single-addition snapshot`);
        assertViewMatchesOracle(c, withoutBullet(bothBullets, c.added), productionView(withoutAdded.snapshot, neutralListing()), 'only the upgrade remains');
        assertViewMatchesOracle(c, withoutBullet(bothBullets, c.upgrade), productionView(withoutUpgrade.snapshot, neutralListing()), 'only the new skill remains');
      }
    },
  },
  {
    name: 'adaptability skills: there is no fixed vocabulary - arbitrary invented names, including digits, dots and plus signs, obey the same evidence rule',
    run: async () => {
      const syllables = ['qal', 'tri', 'vey', 'ron', 'mox', 'zun', 'kel', 'dra', 'fio', 'pex', 'lum', 'nar'];
      const shapes = [name => name, name => `${name}.js`, name => `${name} 2`, name => `${name}++`];
      const c = CANDIDATES.at(-1);
      let checked = 0;
      for (let index = 0; index < 12; index += 1) {
        const stem = `${syllables[index]}${syllables[(index * 5 + 3) % syllables.length]}`;
        const label = shapes[index % shapes.length](`${stem[0].toUpperCase()}${stem.slice(1)}`);
        const mentionOnly = bullet(`The deployment platform ${label} was chosen by the infrastructure team.`, [mentionUse(label, 'organization-owned platform')]);
        const used = bullet(`Operated ${label} for the weekly release train.`, [skillUse(label, label, 'platform', 'deployment')]);
        const before = [c.practice, c.filler, mentionOnly];
        const A = await compileScenario(c, before);
        const B = await compileScenario(c, [...before, used]);
        const C = await compileScenario(c, withoutBullet([...before, used], used));
        const [viewA, viewB, viewC] = [A, B, C].map(result => productionView(result.snapshot, neutralListing()));
        expectAdmission(viewA, label, false, `A ${label}`);
        expectAdmission(viewB, label, true, `B ${label}`);
        expectAdmission(viewC, label, false, `C ${label}`);
        expectAdmission(viewB, c.practice.uses[0].name, true, `B retained for ${label}`);
        assert(C.snapshotId === A.snapshotId && A.snapshotId !== B.snapshotId, `${label}: ids follow the source text`);
        assert(inventoryNames(viewB).vetted.has(canon(label)) && !inventoryNames(viewA).vetted.has(canon(label)), `${label}: inventory follows the source text`);
        checked += 1;
      }
      assert(checked === 12, 'every generated name was exercised');
    },
  },
  {
    name: 'adaptability skills: a skill spelled in another case or labeled differently on a later source page merges into one canonical skill; an ineligible duplicate is refused rather than doubled',
    run: async () => {
      for (const c of CANDIDATES) {
        const practice = c.practice.uses[0];
        const label = practice.label;
        const secondLine = `Reviewed ${label.toUpperCase()} refresher checks with new staff.`;
        const baseBullets = [c.practice];
        const pageOneCorpus = buildCareerSourceCorpus(sourceFilesFor(c, baseBullets));
        const pageOneShard = pageShard(buildProfile(c, baseBullets, pageOneCorpus));
        const allLines = [...sourceTextFor(c, baseBullets).split('\n').slice(0, -1), secondLine];
        const text = `${allLines.join('\n')}\n`;
        const files = [{ name: `${c.key}-paged.md`, text, legacyText: text, contentHash: sha256(text), transcriptionAudit: verbatimCareerTranscriptionAuditReceipt() }];
        const corpus = buildCareerSourceCorpus(files);
        const secondSegment = corpus.segments.at(-1).id;
        assert(corpus.segments.length === 6 && partitionCareerSourcePages(corpus, { maxSegments: 5 }).length === 2, `${c.key}: two source pages`);
        const pageTwoShard = (name, category, { capabilityKind = practice.kind, indexEligible = true } = {}) => ({
          identity: { name: '', contacts: [], evidenceSegmentIds: [secondSegment] },
          roles: [],
          achievements: [{
            id: 'ach-2', roleId: 'p0001-role-1', claim: secondLine, technologies: [label.toUpperCase()],
            technologyReferences: [{ technology: label.toUpperCase(), disposition: 'skill', relationship: 'independent', relationshipGroup: '', relationshipEvidence: secondLine, evidenceSegmentIds: [secondSegment] }],
            metrics: [], evidenceSegmentIds: [secondSegment],
          }],
          projects: [],
          skills: [{
            id: 'skill-2', name, category, capabilityKind, supportMode: 'direct', directEvidenceSegmentIds: [secondSegment],
            indexEligible, roleIds: ['p0001-role-1'], evidenceSegmentIds: [secondSegment],
          }],
          education: [], certifications: [], otherEvidence: [],
          segmentCoverage: [{ segmentId: secondSegment, disposition: 'achievement', entityIds: [] }],
          rolePatches: [], projectPatches: [],
          continuationState: { roles: { mode: 'inherit', ids: [] }, projects: { mode: 'inherit', ids: [] } },
        });
        const compilePaged = shardTwo => compileAuditedCareerSnapshot({
          sourceFiles: files, pageMaxSegments: 5, now: FIXED_NOW,
          callText: async (_prompt, options) => {
            if (options.task === 'career-profile-compile' || options.task === 'career-profile-repair') return options.hints.pageIndex === 0 ? pageOneShard : shardTwo;
            return { findings: [] };
          },
        });

        // Compatible spelling (same category, same support): one skill, one receipt.
        const merged = await compilePaged(pageTwoShard(practice.name.toLowerCase(), practice.category));
        const matching = merged.profile.skills.filter(skill => canon(skill.name) === canon(practice.name));
        assert(matching.length === 1 && matching[0].name === practice.name && merged.snapshot.reconciliation.skillMerges.length === 1,
          `${c.key}: ${practice.name} and its lower-case spelling reconcile into one canonical skill`);
        assert(matching[0].evidenceSegmentIds.includes(secondSegment) && matching[0].directEvidenceSegmentIds.length === 2, `${c.key}: both pages' direct evidence is unioned`);
        const boundIds = new Set(merged.profile.achievements.flatMap(item => item.technologyReferences).map(reference => reference.skillId));
        assert(boundIds.size === 1 && boundIds.has(matching[0].id), `${c.key}: every ledger label, in either case, binds to the one skill id`);
        const view = productionView(merged.snapshot, neutralListing());
        assert(inventoryNames(view).vetted.size === 1, `${c.key}: exactly one ATS keyword results`);
        expectAdmission(view, practice.name, true, `${c.key} merged`);

        // Category and capability kind are labels each page picks on its own: a later page
        // wording them differently still merges, keeping the earlier page's labels.
        const otherKind = practice.kind === 'capability' ? 'method' : 'capability';
        for (const [kind, shard] of [
          ['category', pageTwoShard(practice.name.toLowerCase(), `${practice.category} (alternate classification)`)],
          ['capability kind', pageTwoShard(practice.name.toLowerCase(), practice.category, { capabilityKind: otherKind })],
        ]) {
          const relabeled = await compilePaged(shard);
          const rows = relabeled.profile.skills.filter(skill => canon(skill.name) === canon(practice.name));
          assert(rows.length === 1 && rows[0].category === practice.category && rows[0].capabilityKind === practice.kind
            && relabeled.snapshot.reconciliation.skillMerges.length === 1,
          `${c.key}: a later page's different ${kind} merges into the earlier page's skill and keeps its labels`);
        }

        // Incompatible same-name rows are never silently doubled into two keywords. The variant
        // differs from the compatible control above in one eligibility-governing field.
        const incompatible = [
          ['index eligibility', pageTwoShard(practice.name.toLowerCase(), practice.category, { indexEligible: false })],
        ];
        for (const [kind, shard] of incompatible) {
          const doubled = await expectCompileFailure(() => compilePaged(shard));
          assert(/^CAREER_SNAPSHOT_[A-Z_]+$/u.test(String(doubled.code)), `${c.key}: a same-name row with another ${kind} is a typed refusal (${doubled.code})`);
        }
      }
    },
  },
  {
    name: 'adaptability skills: a job-listing requirement never becomes candidate experience, and recompilation moves what a skills block must and may contain',
    run: async () => {
      for (const c of CANDIDATES) {
        const listing = [c.listing.requires, c.listing.unrelated];
        const bBullets = bulletsFor(c, 'added');
        const A = productionView((await compileScenario(c, bulletsFor(c, 'A'))).snapshot, listing);
        const B = productionView((await compileScenario(c, bBullets)).snapshot, listing);
        const C = productionView((await compileScenario(c, withoutBullet(bBullets, c.added))).snapshot, listing);
        const named = (view, name) => resumeAttempt(view, null).required.some(item => canon(item) === canon(name));

        for (const [label, view] of [['A', A], ['C', C]]) {
          // The listing names the skill, yet it is neither required nor claimable.
          assert(!named(view, c.addedName), `${c.key} ${label}: the posting alone must not make ${c.addedName} required`);
          assert(resumeAttempt(view, null).accepted, `${c.key} ${label}: a skills block without the unsupported name is complete`);
          const claim = resumeAttempt(view, c.addedName);
          assert(!claim.accepted && claim.message.includes(`item "${c.addedName}" must occur in its cited career-data evidence`), `${c.key} ${label}: claiming a listing-only skill is refused (${claim.message.slice(0, 200)})`);
          const sibling = resumeAttempt(view, c.nearMiss.sibling);
          assert(!sibling.accepted && sibling.message.includes(`item "${c.nearMiss.sibling}" must occur in its cited career-data evidence`), `${c.key} ${label}: a second listing-only skill is refused (${sibling.message.slice(0, 200)})`);
        }
        // B: now career-attested AND posting-named, so it is required.
        assert(named(B, c.addedName) && !named(B, c.nearMiss.sibling), `${c.key} B: recompiled evidence makes exactly the supported name required`);
        assert(resumeAttempt(B, null).accepted, `${c.key} B: complete block accepted`);
        const omitted = resumeAttempt(B, null, { omit: [c.addedName] });
        assert(omitted.accepted && omitted.advice.includes(`skills omits ${c.addedName}`), `${c.key} B: omitting the now-supported posting-named skill is reported by name (${omitted.advice.slice(0, 200)})`);
        const stillRefused = resumeAttempt(B, c.nearMiss.sibling);
        assert(!stillRefused.accepted && stillRefused.message.includes(`item "${c.nearMiss.sibling}"`), `${c.key} B: the other listing-only name remains refused (${stillRefused.message.slice(0, 200)})`);
      }

      // Unrelated postings: every other domain's listing, applied to every
      // candidate, changes neither what is required nor what may be claimed.
      for (const c of CANDIDATES) {
        const compiled = await compileScenario(c, bulletsFor(c, 'added'));
        const baseline = resumeAttempt(productionView(compiled.snapshot, neutralListing()), null).required;
        for (const other of CANDIDATES.filter(item => item !== c)) {
          const view = productionView(compiled.snapshot, [other.listing.requires, other.listing.unrelated]);
          const attempt = resumeAttempt(view, null);
          assert(attempt.accepted && attempt.required.length === baseline.length && attempt.required.every(name => baseline.includes(name)),
            `${c.key} vs ${other.key}'s posting: the required skill set is unchanged (${JSON.stringify(attempt.required)})`);
          for (const claim of [other.addedName, other.nearMiss.sibling]) {
            const attempt2 = resumeAttempt(view, claim);
            assert(!attempt2.accepted && attempt2.message.includes(`item "${claim}"`), `${c.key} vs ${other.key}'s posting: ${claim} is named by the posting but is not this candidate's skill (${attempt2.message.slice(0, 160)})`);
          }
        }
      }
    },
  },
  {
    name: 'adaptability skills: a skills-lane audit finding blocks approval of a mention promoted to a skill, and the repaired snapshot excludes it',
    run: async () => {
      for (const c of CANDIDATES) {
        const bullets = bulletsFor(c, 'A');
        const mention = c.mentions[0];
        const label = mention.uses[0].label;
        const files = sourceFilesFor(c, bullets);
        const corpus = buildCareerSourceCorpus(files);
        const faithfulFull = buildProfile(c, bullets, corpus);
        const faithful = pageShard(faithfulFull);
        const mentionSegment = faithful.achievements.find(item => item.claim === mention.text).evidenceSegmentIds[0];
        // Forge the promotion on the complete (host-bound) profile, then page-shard it the way a responder would answer.
        const promotedFull = structuredClone(faithfulFull);
        promotedFull.skills.push({
          id: 'skill-promoted', name: label, category: 'tool', capabilityKind: 'tool', supportMode: 'direct',
          directEvidenceSegmentIds: [mentionSegment], indexEligible: true, roleIds: [ROLE_ID], evidenceSegmentIds: [mentionSegment],
        });
        promotedFull.roles[0].skillIds.push('skill-promoted');
        // The coverage entityIds are the reciprocal inverse of evidence; keep the complete profile consistent with the new row.
        promotedFull.segmentCoverage.find(entry => entry.segmentId === mentionSegment).entityIds.push('skill-promoted');
        // Keep the forged profile internally CONSISTENT: the technology ledger agrees with the promoted row (the
        // mention's own reference is now an independent skill disposition bound to skill-promoted). Deterministic
        // validation rejects a skill whose only evidence is a line the ledger calls non-skill, so a ledger that still
        // said non-skill would fail BEFORE any audit ran (the compiler runs no AI audit while deterministic validation
        // fails). With the ledger agreeing there is no deterministic contradiction left: whether an organization-owned
        // system is really the candidate's capability is a semantic judgement only the independent skills-lane audit can make.
        const promotedReference = promotedFull.achievements.find(item => item.claim === mention.text).technologyReferences
          .find(reference => canon(reference.technology) === canon(label));
        promotedReference.disposition = 'skill';
        delete promotedReference.nonSkillReason;
        promotedReference.skillId = 'skill-promoted';
        // Sanity: the consistent forgery passes deterministic validation, so only the audit lane can object.
        const sanity = validateCareerProfile(promotedFull, corpus);
        assert(sanity.valid, `${c.key}: the forged promotion must be invisible to deterministic validation (${errorsOf(sanity).slice(0, 300)})`);
        const promoted = pageShard(promotedFull);
        const lane = { flagged: 0, repairs: 0, repairPrompt: '' };
        const detail = 'The label is an organization-owned system or evaluation the candidate did not operate.';
        const result = await compileAuditedCareerSnapshot({
          sourceFiles: files, now: FIXED_NOW,
          callText: async (prompt, options) => {
            if (options.task === 'career-profile-compile') return promoted;
            if (options.task === 'career-profile-repair') { lane.repairs += 1; lane.repairPrompt = prompt; return faithful; }
            if (options.task === 'career-profile-audit-skills' && new RegExp(`"name":"${label}"`, 'u').test(prompt)) {
              lane.flagged += 1;
              return { findings: [{ id: 'mention-promoted', severity: 'blocker', category: 'skills', segmentIds: [mentionSegment], entityIds: ['p0001-skill-promoted'], detail }] };
            }
            return { findings: [] };
          },
        });
        assert(lane.flagged >= 1 && lane.repairs >= 1, `${c.key}: the skills lane flagged and the repair round ran`);
        // The audit finding itself (not an unrelated defect) is what the repair round was asked to resolve.
        assert(lane.repairPrompt.includes(detail), `${c.key}: the repair round received the skills-lane finding`);
        assert(result.snapshot.auditHistory[0].kind === 'folded' && result.snapshot.auditHistory.at(-1).unresolvedCount === 0, `${c.key}: the unresolved round is retained and the approved round is clean`);
        const repairedView = productionView(result.snapshot, neutralListing());
        assertViewMatchesOracle(c, bullets, repairedView, 'repaired');
        expectAdmission(repairedView, label, false, `${c.key} audited-out mention`);
      }
    },
  },
  {
    name: 'adaptability skills: a skills-section line (a bare list, no duty sentence) is direct evidence only while that line exists, and listing fewer skills admits fewer',
    run: async () => {
      for (const c of CANDIDATES) {
        const A = await compileScenario(c, bulletsFor(c, 'A'));
        const listedBullets = bulletsFor(c, 'listed');
        const L = await compileScenario(c, listedBullets);
        const [first, second] = c.listed.uses;
        // Partial list: the same line shortened to the second skill only.
        const partial = bullet(`Core competencies: ${second.label}.`, [second], { list: true });
        const partialBullets = replaceBullet(listedBullets, c.listed, partial);
        const P = await compileScenario(c, partialBullets);
        const C = await compileScenario(c, withoutBullet(listedBullets, c.listed));
        assert(C.snapshotId === A.snapshotId && new Set([A.snapshotId, L.snapshotId, P.snapshotId]).size === 3, `${c.key}: ids follow the skills-section text and revert when the line is removed`);

        // The list line produced role-less skill rows with that one segment as direct evidence and no ledger entry at all.
        for (const use of c.listed.uses) {
          const row = L.profile.skills.find(skill => canon(skill.name) === canon(use.name));
          assert(row && row.supportMode === 'direct' && row.directEvidenceSegmentIds.length === 1 && row.roleIds.length === 0, `${c.key}: ${use.name} is a role-less direct row backed by the list line`);
          assert(L.snapshot.segments.find(segment => segment.id === row.directEvidenceSegmentIds[0]).text.includes(c.listed.text), `${c.key}: the direct evidence of ${use.name} is the skills-section line`);
          assert(!L.profile.achievements.some(item => item.technologies.some(label => canon(label) === canon(use.name))), `${c.key}: no duty sentence or ledger entry exists for ${use.name}`);
        }
        const names = c.listed.uses.map(use => use.name);
        const viewL = productionView(L.snapshot, [c.listing.requires, c.listing.unrelated]);
        assertViewMatchesOracle(c, listedBullets, viewL, 'skills-section line');
        for (const name of names) expectAdmission(viewL, name, true, `${c.key} listed ${name}`);
        // The posting names both listed skills, so a complete skills block must now carry them.
        const omitted = resumeAttempt(viewL, null, { omit: [first.name] });
        assert(omitted.accepted && omitted.advice.includes(`skills omits ${first.name}`), `${c.key}: a skills block that leaves out a listed, posting-named skill is reported by name (${omitted.advice.slice(0, 200)})`);

        // A competency listed outside any role is not attributed to the employer: its catalog lines are not
        // admissible evidence for the role's bullets, while a skill demonstrated in the role's duty is.
        const roleId = viewL.authority.sourceRoles[0].id;
        const accepted = (name) => { try { validateAuthorityRoleEvidence(viewL.authority, roleId, skillEvidenceIdsFor(viewL, name)); return ''; } catch (error) { return String(error?.message || error); } };
        assert(accepted(c.practice.uses[0].name) === '', `${c.key}: control: a skill demonstrated in the role is admissible role evidence (${accepted(c.practice.uses[0].name)})`);
        for (const name of names) assert(/does not belong to role/u.test(accepted(name)), `${c.key}: ${name} was only listed, so it cannot be cited as this employer's evidence (${accepted(name)})`);

        const viewP = productionView(P.snapshot, [c.listing.requires, c.listing.unrelated]);
        assertViewMatchesOracle(c, partialBullets, viewP, 'shortened skills-section line');
        expectAdmission(viewP, first.name, false, `${c.key} dropped from the list`);
        expectAdmission(viewP, second.name, true, `${c.key} kept in the list`);

        const viewC = productionView(C.snapshot, [c.listing.requires, c.listing.unrelated]);
        for (const name of names) expectAdmission(viewC, name, false, `${c.key} list removed ${name}`);
      }
    },
  },
  {
    name: 'adaptability skills: every way of faking direct skill support is refused by profile validation, each for its own reason and nothing else',
    run: async () => {
      for (const c of CANDIDATES) {
        const bBullets = bulletsFor(c, 'added');
        const corpus = buildCareerSourceCorpus(sourceFilesFor(c, bBullets));
        const profile = buildProfile(c, bBullets, corpus);
        const [practiceSeg, fillerSeg] = segmentsOf(corpus, [c.practice.text, c.filler.text]);
        const [addedSeg] = segmentsOf(corpus, [c.added.text]);
        const rowId = `skill-${slug(c.addedName)}`;
        const label = `skills[${rowId}]`;
        const control = validateTampered(profile, corpus, () => {});
        assert(control.valid, `${c.key}: re-deriving coverage after a no-op edit leaves the faithful profile valid (${errorsOf(control).slice(0, 200)})`);

        const cases = [
          ['direct evidence that does not state the skill', `${label}.directEvidenceSegmentIds do not literally demonstrate the skill name`, p => {
            const row = p.skills.find(item => item.id === rowId);
            row.evidenceSegmentIds = [addedSeg, fillerSeg]; row.directEvidenceSegmentIds = [fillerSeg];
          }],
          ['direct support without any direct evidence', `${label}.supportMode direct requires one or more separate literal directEvidenceSegmentIds`, p => {
            const row = p.skills.find(item => item.id === rowId);
            row.directEvidenceSegmentIds = []; row.indexEligible = false;
          }],
          ['direct evidence the skill record never cited', `${label}.directEvidenceSegmentIds ${practiceSeg} is not also cited by the skill record`, p => {
            p.skills.find(item => item.id === rowId).directEvidenceSegmentIds = [addedSeg, practiceSeg];
          }],
          ['relationship-qualified row with no relationship to qualify', `${label}.supportMode relationship-qualified needs a linked alternative, conditional, optional, or ambiguous technology reference`, p => {
            const row = p.skills.find(item => item.id === rowId);
            row.supportMode = 'relationship-qualified'; row.directEvidenceSegmentIds = []; row.indexEligible = false;
          }],
        ];
        for (const [kind, expected, mutate] of cases) {
          const result = validateTampered(profile, corpus, mutate);
          assert(!result.valid && result.errors.some(error => error.includes(expected)), `${c.key}: ${kind} must fail with its own reason (${errorsOf(result).slice(0, 300)})`);
          assert(result.errors.every(error => error.includes(label)), `${c.key}: ${kind}: only the tampered skill row is flagged (${errorsOf(result).slice(0, 300)})`);
        }

        // Alternatives: the qualified row may neither be index-eligible nor carry direct evidence.
        const altBullets = bulletsFor(c, 'alt');
        const altCorpus = buildCareerSourceCorpus(sourceFilesFor(c, altBullets));
        const altProfile = buildProfile(c, altBullets, altCorpus);
        const altRowId = `skill-${slug(c.altNames[0])}`;
        const altLabel = `skills[${altRowId}]`;
        assert(validateTampered(altProfile, altCorpus, () => {}).valid, `${c.key}: faithful alternatives profile is valid`);
        const qualifiedCases = [
          ['qualified but index-eligible', `${altLabel}.supportMode relationship-qualified cannot be indexEligible`, p => { p.skills.find(item => item.id === altRowId).indexEligible = true; }],
          ['qualified but carrying direct evidence', `${altLabel}.supportMode relationship-qualified must not carry directEvidenceSegmentIds`, p => {
            const row = p.skills.find(item => item.id === altRowId);
            row.directEvidenceSegmentIds = [...row.evidenceSegmentIds];
          }],
        ];
        for (const [kind, expected, mutate] of qualifiedCases) {
          const result = validateTampered(altProfile, altCorpus, mutate);
          assert(!result.valid && result.errors.some(error => error.includes(expected)), `${c.key}: ${kind} must fail with its own reason (${errorsOf(result).slice(0, 300)})`);
          assert(result.errors.every(error => error.includes(altLabel)), `${c.key}: ${kind}: only the tampered skill row is flagged (${errorsOf(result).slice(0, 300)})`);
        }
      }
    },
  },
  {
    name: 'adaptability skills: the technology ledger is checked label by label - an ungrounded, undisposed, mis-bound, mis-sliced or half-grouped label is refused for its own reason',
    run: async () => {
      for (const c of CANDIDATES) {
        const bullets = bulletsFor(c, 'added');
        const corpus = buildCareerSourceCorpus(sourceFilesFor(c, bullets));
        const profile = buildProfile(c, bullets, corpus);
        const mentionId = profile.achievements.find(item => item.claim === c.mentions[0].text).id;
        const addedAchievementId = profile.achievements.find(item => item.claim === c.added.text).id;
        const practiceRowId = `skill-${slug(c.practice.uses[0].name)}`;
        const ledgerOf = (p, id) => p.achievements.find(item => item.id === id);
        const flagged = id => `achievements[${id}]`;
        assert(validateTampered(profile, corpus, () => {}).valid, `${c.key}: faithful profile is valid before any ledger edit`);
        const cases = [
          ['a non-skill label that still binds a skill id', [`${flagged(mentionId)}.technologyReferences[0] must not bind skillId for a non-skill disposition.`], p => { ledgerOf(p, mentionId).technologyReferences[0].skillId = practiceRowId; }, mentionId],
          ['a ledger label the source never states', [`${flagged(mentionId)}.technologyReferences[1].technology is not literally grounded in its cited source segment(s). Copy the label exactly, as whole words, from a cited segment (name a demonstrated action by the source's own contiguous wording, never a paraphrase), or drop the label and its technologyReferences record.`, `${flagged(mentionId)} technology ${JSON.stringify(c.nearMiss.sibling)} is not grounded.`], p => {
            const entity = ledgerOf(p, mentionId);
            entity.technologies.push(c.nearMiss.sibling);
            entity.technologyReferences.push({ technology: c.nearMiss.sibling, disposition: 'non-skill', nonSkillReason: 'not stated', relationship: 'independent', relationshipGroup: '', relationshipEvidence: c.mentions[0].text, evidenceSegmentIds: [...entity.evidenceSegmentIds] });
          }, mentionId],
          ['a technology label with no disposition at all', [`${flagged(mentionId)}.technologies label ${JSON.stringify(c.mentions[0].uses[0].label)} has no source-linked skill or non-skill disposition.`], p => { ledgerOf(p, mentionId).technologyReferences = []; }, mentionId],
          ['a non-skill disposition that does not say why', [`${flagged(mentionId)}.technologyReferences[0].nonSkillReason is required for an explicit non-skill disposition.`], p => { ledgerOf(p, mentionId).technologyReferences[0].nonSkillReason = ''; }, mentionId],
          ['a skill label bound to a different skill', [`${flagged(addedAchievementId)}.technologyReferences[0].skillId does not have the same normalized label as its technology.`], p => { ledgerOf(p, addedAchievementId).technologyReferences[0].skillId = practiceRowId; }, addedAchievementId],
        ];
        for (const [kind, expectedErrors, mutate, achievementId] of cases) {
          const result = validateTampered(profile, corpus, mutate);
          for (const expected of expectedErrors) assert(!result.valid && result.errors.includes(expected), `${c.key}: ${kind} must fail with ${JSON.stringify(expected)} (${errorsOf(result).slice(0, 400)})`);
          assert(result.errors.every(error => error.startsWith(flagged(achievementId))), `${c.key}: ${kind}: only that achievement is flagged (${errorsOf(result).slice(0, 300)})`);
        }

        // A project carries the same ledger, so the same rules bind it.
        const projectBullets = bulletsFor(c, 'projectMention');
        const projectCorpus = buildCareerSourceCorpus(sourceFilesFor(c, projectBullets));
        const projectProfile = buildProfile(c, projectBullets, projectCorpus);
        const projectId = projectProfile.projects[0].id;
        const projectLabel = `projects[${projectId}]`;
        assert(validateTampered(projectProfile, projectCorpus, () => {}).valid, `${c.key}: faithful project profile is valid`);
        const projectCases = [
          ['a non-skill project label that still binds a skill id', [`${projectLabel}.technologyReferences[0] must not bind skillId for a non-skill disposition.`], p => { p.projects[0].technologyReferences[0].skillId = practiceRowId; }],
          ['a project ledger label the source never states', [`${projectLabel}.technologyReferences[1].technology is not literally grounded in its cited source segment(s). Copy the label exactly, as whole words, from a cited segment (name a demonstrated action by the source's own contiguous wording, never a paraphrase), or drop the label and its technologyReferences record.`, `${projectLabel} technology ${JSON.stringify(c.nearMiss.sibling)} is not grounded.`], p => {
            const entity = p.projects[0];
            entity.technologies.push(c.nearMiss.sibling);
            entity.technologyReferences.push({ technology: c.nearMiss.sibling, disposition: 'non-skill', nonSkillReason: 'not stated', relationship: 'independent', relationshipGroup: '', relationshipEvidence: c.projectMention.text, evidenceSegmentIds: [...entity.evidenceSegmentIds] });
          }],
          ['a project technology label with no disposition', [`${projectLabel}.technologies label ${JSON.stringify(c.projectMention.uses[0].label)} has no source-linked skill or non-skill disposition.`], p => { p.projects[0].technologyReferences = []; }],
        ];
        for (const [kind, expectedErrors, mutate] of projectCases) {
          const result = validateTampered(projectProfile, projectCorpus, mutate);
          for (const expected of expectedErrors) assert(!result.valid && result.errors.includes(expected), `${c.key}: ${kind} must fail with ${JSON.stringify(expected)} (${errorsOf(result).slice(0, 400)})`);
          assert(result.errors.every(error => error.startsWith(projectLabel)), `${c.key}: ${kind}: only that project is flagged (${errorsOf(result).slice(0, 300)})`);
        }

        // Relationship ledger of an alternative: literal slice, and a group of at least two labels.
        const altBullets = bulletsFor(c, 'alt');
        const altCorpus = buildCareerSourceCorpus(sourceFilesFor(c, altBullets));
        const altProfile = buildProfile(c, altBullets, altCorpus);
        const altAchievementId = altProfile.achievements.find(item => item.claim === c.alternative.text).id;
        assert(validateTampered(altProfile, altCorpus, () => {}).valid, `${c.key}: faithful alternatives profile is valid`);
        const paraphrased = validateTampered(altProfile, altCorpus, p => {
          for (const reference of ledgerOf(p, altAchievementId).technologyReferences) reference.relationshipEvidence = `${c.alternative.uses[0].slice} (paraphrased)`;
        });
        assert(!paraphrased.valid && paraphrased.errors.some(error => error.startsWith(`${flagged(altAchievementId)}.technologyReferences[0].relationshipEvidence must be a literal source slice grounded in its cited segment(s)`)),
          `${c.key}: a paraphrased relationship slice is refused (${errorsOf(paraphrased).slice(0, 300)})`);
        const halfSlice = validateTampered(altProfile, altCorpus, p => {
          // A literal source slice, but one that names only the first alternative.
          for (const reference of ledgerOf(p, altAchievementId).technologyReferences) reference.relationshipEvidence = c.alternative.uses[0].label;
        });
        assert(!halfSlice.valid && halfSlice.errors.some(error => error.startsWith(`${flagged(altAchievementId)}.technologyReferences[1].relationshipEvidence does not literally include its grouped technology label`)),
          `${c.key}: a shared relationship slice must contain every label it governs (${errorsOf(halfSlice).slice(0, 300)})`);
        const lonely = validateTampered(altProfile, altCorpus, p => {
          const [, second] = ledgerOf(p, altAchievementId).technologyReferences;
          second.relationship = 'independent'; second.relationshipGroup = '';
        });
        assert(!lonely.valid && lonely.errors.some(error => error.includes(`${flagged(altAchievementId)}.technologyReferences alternative group "tool-choice" needs at least two labels.`)),
          `${c.key}: an alternative group of one label is refused (${errorsOf(lonely).slice(0, 300)})`);
      }
    },
  },
  {
    name: 'adaptability skills: eligibility fails closed - a row that merely claims indexEligible, or is only partly current, is never part of the inventory, the authority or the résumé projection',
    run: async () => {
      for (const c of CANDIDATES) {
        const bullets = bulletsFor(c, 'added');
        const B = await compileScenario(c, bullets);
        const view = productionView(B.snapshot, [c.listing.requires]);
        const row = B.profile.skills.find(skill => canon(skill.name) === canon(c.addedName));
        const { capabilityKind, supportMode, directEvidenceSegmentIds } = row;
        assert(isCareerSkillIndexEligible(row) && supportMode === 'direct' && directEvidenceSegmentIds.length === 1 && capabilityKind, `${c.key}: control row is a current, direct, eligible skill`);

        // Unit rules on rows derived from a real compile.
        const variants = {
          'claims eligibility but is only relationship-qualified': { ...row, supportMode: 'relationship-qualified' },
          'claims eligibility but has no direct evidence': { ...row, directEvidenceSegmentIds: [] },
          'carries a capability kind but no support mode': { ...row, supportMode: undefined },
          'is direct and supported but not marked index-eligible': { ...row, indexEligible: false },
        };
        for (const [kind, variant] of Object.entries(variants)) {
          assert(!isCareerSkillIndexEligible(variant) && !isCareerSkillIndexEligible(variant, { allowHistorical: false }), `${c.key}: a row that ${kind} must not be index-eligible`);
          assert(!vettedCareerSkillInventory({ skills: [variant] }).some(skill => skill.id === row.id), `${c.key}: a row that ${kind} must not enter the vetted inventory`);
        }
        const historical = { id: row.id, name: row.name, category: row.category, indexEligible: true, roleIds: row.roleIds, evidenceSegmentIds: row.evidenceSegmentIds };
        assert(isCareerSkillIndexEligible(historical) && !isCareerSkillIndexEligible(historical, { allowHistorical: false }), `${c.key}: only the explicit historical compatibility branch honours a row with no current support metadata`);
        const spelledTwice = vettedCareerSkillInventory({ skills: [row, { ...row, id: `${row.id}-again`, name: row.name.toUpperCase() }] });
        assert(spelledTwice.length === 1 && spelledTwice[0].id === row.id, `${c.key}: the vetted inventory keeps one row per Unicode/case-equivalent name`);

        // A current profile that hides one historical-shaped row: the authority must not resolve it.
        const tampered = structuredClone(B.snapshot);
        const tamperedRow = tampered.profile.skills.find(skill => skill.id === row.id);
        delete tamperedRow.capabilityKind; delete tamperedRow.supportMode; delete tamperedRow.directEvidenceSegmentIds;
        assert(!validateCurrentCareerSnapshot(tampered).valid, `${c.key}: a current snapshot with a partly historical skill row is not a valid snapshot`);
        let reason = '';
        try { buildApplicationCareerAuthority(tampered); } catch (error) { reason = String(error?.message || error); }
        assert(/references an unknown skill entity/u.test(reason), `${c.key}: the authority refuses to resolve the partly historical row, as the evidence catalog and the authority disagree about it (${reason.slice(0, 200)})`);

        // The résumé validator's projection is the same direct inventory: any other shape is a configuration fault, not a skill.
        const wireCases = {
          'index-ineligible': wire => { wire.skills.find(skill => canon(skill.name) === canon(c.addedName)).indexEligible = false; },
          'relationship-qualified': wire => { wire.skills.find(skill => canon(skill.name) === canon(c.addedName)).supportMode = 'relationship-qualified'; },
          'without direct evidence': wire => { wire.skills.find(skill => canon(skill.name) === canon(c.addedName)).directEvidenceSegmentIds = []; },
          'with direct evidence the row never cited': wire => { wire.skills.find(skill => canon(skill.name) === canon(c.addedName)).directEvidenceSegmentIds = ['segment-9999']; },
        };
        for (const [kind, mutate] of Object.entries(wireCases)) {
          const wire = structuredClone(view.careerSkillEvidence);
          mutate(wire);
          const attempt = resumeAttempt(view, null, { wire });
          assert(!attempt.accepted && /careerSkillEvidence\.skills\[\d+\] (must be a direct, index-eligible v2 inventory skill|has an invalid current support-mode projection)/u.test(attempt.message),
            `${c.key}: a ${kind} projection row is a configuration fault, not a usable skill (${attempt.message.slice(0, 220)})`);
        }
        assert(resumeAttempt(view, null, { wire: structuredClone(view.careerSkillEvidence) }).accepted, `${c.key}: the untouched projection is accepted`);
      }
    },
  },
  {
    name: 'adaptability skills: what a skills block must carry is limited to skills the posting names (posting-named) or the cited career evidence states (career-attested), never both lists merged',
    run: async () => {
      for (const c of CANDIDATES) {
        const B = await compileScenario(c, bulletsFor(c, 'both'));
        const named = (view, name) => resumeAttempt(view, null).required.some(item => canon(item) === canon(name));
        const postingNames = (view, wire = view.careerSkillEvidence) => postingNamedAttestedSkillTerms([...view.catalog, ...view.listing], wire).map(canon);
        const neutral = productionView(B.snapshot, neutralListing());
        const asking = productionView(B.snapshot, [c.listing.requires, c.listing.unrelated]);
        // Career-attested: every supported skill is required, whatever the posting says.
        for (const view of [neutral, asking]) {
          assert(named(view, c.practice.uses[0].name) && named(view, c.addedName) && named(view, c.mentions[0].uses[0].label), `${c.key}: all three supported skills are in the career-attested index`);
          assert(!named(view, c.nearMiss.sibling) && !named(view, c.mentions[1].uses[0].label), `${c.key}: unsupported names never enter the index`);
        }
        // Posting-named: only the supported skill the posting itself names, never the posting's unsupported sibling.
        assert(JSON.stringify(postingNames(neutral)) === '[]', `${c.key}: a posting that names no skill makes none posting-named`);
        assert(JSON.stringify(postingNames(asking)) === JSON.stringify([canon(c.addedName)]), `${c.key}: exactly the supported skill the posting names is posting-named (${JSON.stringify(postingNames(asking))})`);
        // Source-limited: a skill is required only where the accepted plan's career quotes actually name it.
        const planWithoutIt = { ...asking, catalog: asking.catalog.filter(entry => !occursIn(entry.quote, c.addedName)) };
        assert(planWithoutIt.catalog.length < asking.catalog.length && planWithoutIt.catalog.length > 0, `${c.key}: control: the plan lost only the quotes that name ${c.addedName}`);
        const limited = requiredCareerAttestedSkillTerms([...planWithoutIt.catalog, ...asking.listing], asking.careerSkillEvidence).map(canon);
        assert(!limited.includes(canon(c.addedName)) && limited.includes(canon(c.practice.uses[0].name)), `${c.key}: a skill the accepted plan never quotes is not required even though the approved inventory holds it (${JSON.stringify(limited)})`);
        assert(postingNamedAttestedSkillTerms([...planWithoutIt.catalog, ...asking.listing], asking.careerSkillEvidence).length === 0, `${c.key}: and it is not posting-named either, since the plan carries no career quote for it`);
        // Word boundaries: the name inside a longer word is no evidence for it, the name set off by punctuation is.
        const decoy = quote => [...planWithoutIt.catalog, { id: 'decoy-quote', sourceId: 'career-data', quote }, ...asking.listing];
        for (const quote of [`${c.addedName}ish routines`, `pre${c.addedName} routines`, `${c.addedName}2 routines`]) {
          assert(!requiredCareerAttestedSkillTerms(decoy(quote), asking.careerSkillEvidence).map(canon).includes(canon(c.addedName)), `${c.key}: ${JSON.stringify(quote)} does not state ${c.addedName}`);
        }
        for (const quote of [`routines (${c.addedName}), daily`, `Routines: ${c.addedName.toUpperCase()}.`]) {
          assert(requiredCareerAttestedSkillTerms(decoy(quote), asking.careerSkillEvidence).map(canon).includes(canon(c.addedName)), `${c.key}: ${JSON.stringify(quote)} does state ${c.addedName}`);
        }
      }
    },
  },
  {
    name: 'adaptability skills: an approved skill still cannot be claimed with evidence that does not state it',
    run: async () => {
      for (const c of CANDIDATES) {
        const B = await compileScenario(c, bulletsFor(c, 'added'));
        const view = productionView(B.snapshot, [c.listing.requires]);
        const idOf = (needle, kind) => view.catalog.find(entry => entry.id.includes(`.${kind}.`) && entry.quote.includes(needle)).id;
        const fillerLine = idOf(c.filler.text, 'achievement');
        const practiceSkillLine = skillEvidenceIdsFor(view, c.practice.uses[0].name)[0];
        const addedSkillLine = skillEvidenceIdsFor(view, c.addedName)[0];
        const addedRowId = view.snapshot.profile.skills.find(skill => canon(skill.name) === canon(c.addedName)).id;
        expectAdmission(view, c.addedName, true, `${c.key} control`);

        // Résumé: the group cites an unrelated duty line for the added skill.
        const wrongEvidence = resumeAttempt(view, c.addedName, { evidenceFor: name => (canon(name) === canon(c.addedName) ? [fillerLine] : null) });
        assert(!wrongEvidence.accepted && wrongEvidence.message.includes(`item "${c.addedName}" must occur in its cited career-data evidence`)
          && !wrongEvidence.message.includes('is not an exact, index-eligible approved snapshot skill'),
        `${c.key}: an approved skill cited with a line that does not state it is refused for lack of evidence, not for lack of approval (${wrongEvidence.message.slice(0, 240)})`);

        // Authority: evidence must be skill lines of exactly the selected skills.
        const refusal = (items, ids) => { try { validateAuthoritySkillGroup(view.authority, items, ids); return ''; } catch (error) { return String(error?.message || error); } };
        assert(refusal([c.addedName], [addedSkillLine]) === '', `${c.key}: control: the skill's own catalog line is accepted`);
        assert(/does not belong to this skill group/u.test(refusal([c.addedName], [fillerLine])), `${c.key}: a duty line is not skill evidence`);
        assert(/does not belong to this skill group/u.test(refusal([c.addedName], [practiceSkillLine])), `${c.key}: another skill's catalog line is not this skill's evidence`);
        assert(/does not belong to this skill group/u.test(refusal([c.addedName], [addedSkillLine, practiceSkillLine])), `${c.key}: foreign evidence cannot ride along with real evidence`);
        assert(/Skill evidence must be nonempty/u.test(refusal([c.addedName, c.practice.uses[0].name], [addedSkillLine])), `${c.key}: every selected skill needs its own evidence (${refusal([c.addedName, c.practice.uses[0].name], [addedSkillLine])})`);
        assert(refusal([c.addedName, c.practice.uses[0].name], [addedSkillLine, practiceSkillLine]) === '', `${c.key}: control: both skills with their own evidence are accepted`);
        assert(/Unknown authority evidence id/u.test(refusal([c.addedName], [`host.career.skill.${addedRowId}.99`])), `${c.key}: an invented catalog id is unknown evidence`);
      }
    },
  },
  {
    name: 'adaptability skills: a skill stated inside a project entry obeys the same rule - an evaluation that was not adopted is no skill, the project actually doing the work is, and removing the line reverts',
    run: async () => {
      for (const c of CANDIDATES) {
        const A = await compileScenario(c, bulletsFor(c, 'A'));
        const mentionBullets = bulletsFor(c, 'projectMention');
        const M = await compileScenario(c, mentionBullets);
        const useBullets = bulletsFor(c, 'projectUse');
        const U = await compileScenario(c, useBullets);
        const C = await compileScenario(c, withoutBullet(useBullets, c.projectUse));
        assert(C.snapshotId === A.snapshotId && new Set([A.snapshotId, M.snapshotId, U.snapshotId]).size === 3, `${c.key}: snapshot ids follow the project line`);

        // The ledger lives on the project entity, and there are no duty sentences about the skill at all.
        assert(M.profile.projects.length === 1 && M.profile.projects[0].technologyReferences.length === 1 && M.profile.projects[0].technologyReferences[0].disposition === 'non-skill', `${c.key}: the evaluated option is a non-skill ledger entry of the project`);
        assert(!M.profile.skills.some(skill => canon(skill.name) === canon(c.addedName)), `${c.key}: an evaluated option never becomes a skill row`);
        const row = U.profile.skills.find(skill => canon(skill.name) === canon(c.addedName));
        assert(U.profile.projects.length === 1 && U.profile.projects[0].technologyReferences[0].skillId === row.id && row.directEvidenceSegmentIds.length === 1, `${c.key}: the project's own work is the skill's one direct evidence`);
        assert(!U.profile.achievements.some(item => item.technologies.some(label => canon(label) === canon(c.addedName))), `${c.key}: no role duty sentence supports the skill, only the project does`);

        const viewM = productionView(M.snapshot, [c.listing.requires]);
        assertViewMatchesOracle(c, mentionBullets, viewM, 'project mention');
        expectAdmission(viewM, c.addedName, false, `${c.key} project mention`);
        assert(viewM.catalog.some(entry => entry.id.includes('.project.') && entry.quote.includes('Non-skill')), `${c.key}: the approved project evidence still carries the mention, labelled non-skill`);

        const viewU = productionView(U.snapshot, [c.listing.requires]);
        assertViewMatchesOracle(c, useBullets, viewU, 'project use');
        expectAdmission(viewU, c.addedName, true, `${c.key} project use`);
        assert(viewU.catalog.some(entry => entry.id.includes('.project.') && entry.quote.includes(c.added.text)) && !viewU.catalog.some(entry => entry.id.includes('.achievement.') && entry.quote.includes(c.addedName)),
          `${c.key}: the approved evidence quotes the project line, never a role duty, for ${c.addedName}`);

        expectAdmission(productionView(C.snapshot, [c.listing.requires]), c.addedName, false, `${c.key} project line removed`);
      }
    },
  },
  {
    name: 'adaptability skills: production prompts are candidate-independent and carry the generic mention/relationship rules, not a vocabulary',
    run: () => {
      const skeletons = CANDIDATES.map(c => {
        const bullets = bulletsFor(c, 'added');
        const corpus = buildCareerSourceCorpus(sourceFilesFor(c, bullets));
        const profile = buildProfile(c, bullets, corpus);
        const page = partitionCareerSourcePages(corpus)[0];
        const raw = {
          compile: buildCareerProfileCompilePrompt(corpus),
          pageCompile: buildCareerProfilePageCompilePrompt(corpus, page),
          skillsAudit: buildCareerProfileAuditPrompt(corpus, profile, 'skills'),
        };
        for (const prompt of Object.values(raw)) assert(prompt.includes(c.name) || prompt.includes(c.addedName), `${c.key}: the candidate's own data does reach the untrusted block`);
        const skeleton = Object.fromEntries(Object.entries(raw).map(([key, prompt]) => [key, stripUntrusted(prompt)]));
        for (const prompt of Object.values(skeleton)) {
          assert(prompt.length > 1500 && !prompt.includes(c.name) && !prompt.includes(c.contact), `${c.key}: stripping must remove exactly the untrusted data and keep the instructions`);
        }
        return { c, skeleton };
      });
      // Canary against a baked-in vocabulary: instructions never enumerate three or more capitalised names in a row.
      for (const { c, skeleton } of skeletons) for (const [key, prompt] of Object.entries(skeleton)) {
        assert(!/\b[A-Z][\w+#.]*(?:, [A-Z][\w+#.]*){2,}/u.test(prompt), `${c.key}: the ${key} instructions contain an enumerated name list (${(/\b[A-Z][\w+#.]*(?:, [A-Z][\w+#.]*){2,}/u.exec(prompt) || [''])[0]})`);
      }
      const [first, ...rest] = skeletons;
      for (const other of rest) for (const key of Object.keys(first.skeleton)) {
        assert(other.skeleton[key] === first.skeleton[key], `${other.c.key}: ${key} prompt skeleton differs from ${first.c.key}; production instructions must not depend on the candidate`);
      }
      for (const { c, skeleton } of skeletons) for (const prompt of Object.values(skeleton)) {
        for (const name of universe(c)) assert(!prompt.includes(name), `${c.key}: no candidate skill name may appear in production instructions (${name})`);
      }
      const { compile, pageCompile, skillsAudit } = first.skeleton;
      assert(/not merely mentioned incidentally|mentioned incidentally/u.test(skillsAudit) && /organization-owned system/u.test(skillsAudit) && /non-skill/u.test(skillsAudit) && /never with a fixed product list/u.test(skillsAudit),
        'the skills audit mandate states the mention, ownership, non-skill and no-fixed-list rules');
      for (const prompt of [compile, pageCompile]) {
        assert(/vendor\/customer\/organization name/u.test(prompt) && /relationshipEvidence/u.test(prompt) && /Alternatives are not simultaneous use|alternatives, conditional or optional/u.test(prompt) && /hard-coded vocabulary|fixed token rule/u.test(prompt),
          'compile prompts forbid vendor/organization skills, preserve relationship evidence, and refuse a fixed vocabulary or token rule');
      }
    },
  },
  {
    // careerSnapshot.js validateCareerProfile -> validateSkillSupportMode /
    // relationshipQualifiedEvidenceBySkillId consult the technology ledger only
    // for disposition === 'skill'. A deliberate non-skill disposition is never
    // compared with the skills inventory.
    name: 'adaptability skills [fixed defect]: a label the ledger classifies non-skill at its only source line can still be a direct, index-eligible skill row (validateCareerProfile accepts the contradiction)',
    run: async () => {
      const c = CANDIDATES[0];
      const bullets = bulletsFor(c, 'A');
      const corpus = buildCareerSourceCorpus(sourceFilesFor(c, bullets));
      const profile = buildProfile(c, bullets, corpus);
      const mention = c.mentions[0];
      const segment = profile.achievements.find(item => item.claim === mention.text).evidenceSegmentIds;
      const contradiction = withForgedSkill(profile, corpus, { id: 'skill-contradiction', name: mention.uses[0].label, cite: segment });
      const ledger = contradiction.achievements.find(item => item.claim === mention.text).technologyReferences[0];
      assert(ledger.disposition === 'non-skill', 'precondition: the ledger still says non-skill');
      const result = validateCareerProfile(contradiction, corpus);
      assert(!result.valid, 'a direct skill row whose only evidence is the line its own ledger calls non-skill must fail deterministic validation');
    },
  },
  {
    // careerSnapshot.js validateCareerProfile checks that skill.roleIds and
    // role.skillIds are reciprocal, never that the skill's evidence belongs to
    // that role's achievements/projects. applicationCareerAuthority.js
    // validateAuthorityRoleEvidence then trusts the same link.
    name: 'adaptability skills [fixed defect]: a skill evidenced only under one employer can be attributed to another employer and both the snapshot and the application authority accept it',
    run: async () => {
      const lines = [
        'Odalys Brandt-Meyer', 'odalys.brandt@example.test',
        'Structural Engineer at Kestrel Span Consultants, Calgary, Alberta', 'September 2014 to June 2019',
        'Ran finite element analysis on a concrete transfer slab.',
        'Site Inspector at Northgate Builders, Edmonton, Alberta', 'July 2019 to Present',
        'Walked sites to record rebar placement.',
      ];
      const text = `${lines.join('\n')}\n`;
      const corpus = buildCareerSourceCorpus([{ name: 'two-roles.md', text, legacyText: text, contentHash: sha256(text), transcriptionAudit: verbatimCareerTranscriptionAuditReceipt() }]);
      const s = corpus.segments.map(item => item.id);
      const profile = {
        identity: { name: lines[0], contacts: [lines[1]], evidenceSegmentIds: [s[0], s[1]] },
        roles: [
          { id: 'role-first', title: 'Structural Engineer', employer: 'Kestrel Span Consultants', startDate: 'September 2014', endDate: 'June 2019', location: 'Calgary, Alberta', achievementIds: ['ach-first'], skillIds: [], evidenceSegmentIds: [s[2], s[3]] },
          { id: 'role-second', title: 'Site Inspector', employer: 'Northgate Builders', startDate: 'July 2019', endDate: 'Present', location: 'Edmonton, Alberta', achievementIds: ['ach-second'], skillIds: ['skill-fea'], evidenceSegmentIds: [s[5], s[6]] },
        ],
        achievements: [
          { id: 'ach-first', roleId: 'role-first', claim: lines[4], technologies: ['finite element analysis'], technologyReferences: [{ technology: 'finite element analysis', disposition: 'skill', skillId: 'skill-fea', relationship: 'independent', relationshipGroup: '', relationshipEvidence: lines[4], evidenceSegmentIds: [s[4]] }], metrics: [], evidenceSegmentIds: [s[4]] },
          { id: 'ach-second', roleId: 'role-second', claim: lines[7], technologies: [], technologyReferences: [], metrics: [], evidenceSegmentIds: [s[7]] },
        ],
        projects: [],
        // The only evidence for this skill is the FIRST employer's bullet, yet it is linked to the SECOND role.
        skills: [{ id: 'skill-fea', name: 'Finite element analysis', category: 'engineering', capabilityKind: 'method', supportMode: 'direct', directEvidenceSegmentIds: [s[4]], indexEligible: true, roleIds: ['role-second'], evidenceSegmentIds: [s[4]] }],
        education: [], certifications: [], otherEvidence: [], segmentCoverage: [],
      };
      profile.segmentCoverage = coverageForAny(profile, s);
      const result = validateCareerProfile(profile, corpus);
      assert(!result.valid, 'a skill whose evidence lies in the first employer\'s bullet must not validate when linked only to the second employer');
    },
  },
  {
    // careerSnapshot.js validateCareerProfile (skills loop) grounds a skill name by
    // whole-term occurrence in ANY cited segment and lets any segment be direct
    // evidence, including the identity and role-header lines. Nothing deterministic
    // distinguishes a candidate activity from an employer, a person or a place; only
    // the semantic skills-lane audit can, and with a silent auditor the row is approved
    // and enters the vetted inventory, the authority and the required skills block.
    name: "adaptability skills [fixed defect]: an employer name, the candidate's own name or a city becomes an approved, index-eligible skill when its only evidence is an identity or role-header line",
    run: async () => {
      const violations = [];
      for (const c of CANDIDATES) {
        const bullets = bulletsFor(c, 'A');
        for (const [kind, name, segmentOf] of [
          ['employer', c.role.employer, shard => shard.roles[0].evidenceSegmentIds[0]],
          ['person name', c.name, shard => shard.identity.evidenceSegmentIds[0]],
          ['city', c.role.location, shard => shard.roles[0].evidenceSegmentIds[0]],
        ]) {
          const forge = shard => {
            const segmentId = segmentOf(shard);
            shard.skills.push({ id: 'skill-forged', name, category: 'claimed', capabilityKind: 'capability', supportMode: 'direct', directEvidenceSegmentIds: [segmentId], indexEligible: true, roleIds: [ROLE_ID], evidenceSegmentIds: [segmentId] });
            shard.roles[0].skillIds.push('skill-forged');
            return shard;
          };
          let approved = null;
          try { approved = await compileScenario(c, bullets, { transformShard: forge }); } catch { continue; /* refused, as it should be */ }
          if (vettedCareerSkillInventory(approved.snapshot.profile).some(skill => canon(skill.name) === canon(name))) violations.push(`${c.key}/${kind} ${JSON.stringify(name)}`);
        }
      }
      assert(violations.length === 0, `an organisation, a person or a place is not a candidate skill, yet the approved inventory holds: ${violations.join('; ')}`);
    },
  },
  {
    // structuredResume.js collectNonCanonicalTypeScriptOffenses /
    // occursInQuotedSkillEvidence hard-code one technology's spelling for every
    // job, including snapshot-backed ones whose approved inventory is the sole
    // authority. A source that spells the name another way yields an approved
    // skill that no spelling can render.
    name: 'adaptability skills [fixed defect]: a hard-coded technology spelling rule makes an approved skill unrenderable under every spelling',
    run: async () => {
      const c = CANDIDATES.at(-1);
      const spelledBySource = 'Typescript';
      const bullets = [bullet(`Wrote ${spelledBySource} services for the mobile backend.`, [skillUse(spelledBySource, spelledBySource, 'language', 'language')])];
      const compiled = await compileScenario(c, bullets);
      const view = productionView(compiled.snapshot, neutralListing());
      assert(inventoryNames(view).vetted.has(canon(spelledBySource)), 'precondition: production approved the skill under the source spelling');
      const attempt = resumeAttempt(view, spelledBySource, { items: [spelledBySource] });
      assert(attempt.accepted, `an approved, source-evidenced skill must be renderable under its approved spelling (${attempt.message.slice(0, 200)})`);
    },
  },
  {
    // careerSnapshot.js scalarInEvidence(wholeTerm) and structuredResume.js
    // quotedEvidenceHasTerm treat every non-letter/non-digit character as a word
    // boundary, so punctuation that is PART of a different name does not stop a
    // shorter claim from being "literally grounded".
    name: 'adaptability skills [fixed defect]: a shorter skill is grounded by a different symbol- or delimiter-joined name (C by C++, R by R&D)',
    run: () => {
      const c = CANDIDATES.at(-1);
      const violations = [];
      for (const [sourceName, claim] of [['C++', 'C'], ['R&D', 'R']]) {
        const bullets = [bullet(`Maintained ${sourceName} tooling for the platform team.`, [skillUse(sourceName, sourceName, 'language', 'language')])];
        const corpus = buildCareerSourceCorpus(sourceFilesFor(c, bullets));
        const profile = buildProfile(c, bullets, corpus);
        assert(validateCareerProfile(profile, corpus).valid, `precondition: faithful ${sourceName} profile is valid`);
        const lastSegment = [corpus.segments.at(-1).id];
        const forged = withForgedSkill(profile, corpus, { id: 'skill-shorter', name: claim, cite: lastSegment });
        if (validateCareerProfile(forged, corpus).valid) violations.push(`${JSON.stringify(claim)} accepted from the text ${JSON.stringify(sourceName)}`);
      }
      assert(violations.length === 0, `a different, shorter name must not be grounded by a longer symbol-joined one: ${violations.join('; ')}`);
    },
  },
  {
    // localAiApplication.js assertSourceQuoteLinksFinalText is the final prose
    // grounding gate for résumé bullets and letter paragraphs. It requires a
    // token overlap with the bound quotes, supported figures and a closed list
    // of qualifier words, but nothing compares a TOOL or TECHNOLOGY NAME in the
    // prose with the cited quotes. The skills block is gated by the approved
    // inventory; the prose around it is not.
    name: 'adaptability skills [fixed defect]: résumé bullet and cover-letter prose may name a tool or technology that none of its bound career quotes states',
    run: async () => {
      const violations = [];
      for (const c of CANDIDATES) {
        const view = productionView((await compileScenario(c, bulletsFor(c, 'A'))).snapshot, neutralListing());
        const entry = view.catalog.find(item => item.id.includes('.achievement.') && item.quote.includes(c.practice.text));
        const quotes = [entry.quote];
        const identityTokens = c.role.employer.toLowerCase().split(/\s+/u);
        assertSourceQuoteLinksFinalText(c.practice.text, quotes, 'resumeBullets', 0, { identityTokens }); // precondition: faithful text passes
        const inflated = `${c.practice.text.replace(/\.$/u, '')} and tuned ${c.nearMiss.sibling} dashboards in ${c.mentions[1].uses[0].label}.`;
        for (const label of ['resumeBullets', 'coverLetterParagraphs']) {
          try { assertSourceQuoteLinksFinalText(inflated, quotes, label, 0, { identityTokens }); violations.push(`${c.key}/${label}`); } catch { /* rejected, as it should be */ }
        }
      }
      assert(violations.length === 0, `prose naming a tool no bound quote states must be rejected; accepted for: ${violations.join(', ')}`);
    },
  },
  {
    // structuredResume.js normalizeSkills requires item === approved.name and
    // applicationCareerAuthority.js validateAuthoritySkillGroup requires
    // skill.name === name, although careerSnapshot.js canonicalSkillName
    // already defines the case/Unicode-equivalence key used everywhere else.
    // This fails closed (safe), but it is not the "resolves to the same
    // canonical skill" behavior the family invariant describes.
    name: 'adaptability skills [fixed defect]: (policy, fails closed) a case-variant spelling of an approved skill is rejected at the application layer instead of resolving to the canonical skill',
    run: async () => {
      const c = CANDIDATES[0];
      const compiled = await compileScenario(c, bulletsFor(c, 'A'));
      const view = productionView(compiled.snapshot, neutralListing());
      const variant = c.practice.uses[0].label; // the source's own lower-case spelling
      assert(canon(variant) === canon(c.practice.uses[0].name) && variant !== c.practice.uses[0].name, 'precondition: the variant differs only by case');
      assert(authorityAdmits(view, variant) === true, 'authority should resolve the case variant to the canonical approved skill');
      assert(resumeAttempt(view, variant, { items: [variant] }).accepted === true, 'résumé validation should resolve the case variant to the canonical approved skill');
    },
  },
];

// ---------------------------------------------------------------------------
// Known gaps: none. Every gap this file recorded was fixed in production and its
// assertion moved into the default export above ([fixed defect]). A production
// behavior that violates a stated invariant but is not yet fixed goes here: the
// registry does not run `knownGaps`, so each entry must throw today.
// ---------------------------------------------------------------------------

export const knownGaps = [];
