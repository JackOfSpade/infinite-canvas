// Résumé-side check dispositions (v17, task D2).
//
// The redesign principle: TRUTH (facts, scope, dates, metrics, skills, evidence
// grounding) and HYGIENE (schema, safety, identity, host-owned fields) reject a
// document; TASTE (cadence, wording, layout proxies, how complete a selection is)
// never does. electron/ipc/resumeCheckDispositions.js is the one table that says
// which résumé check is which, and this file holds the table to what the code
// actually does:
//
//   1. THE TABLE. Frozen, three values only, every row classified and justified,
//      unknown ids fail closed to 'gate', and no TRUTH row is ever softened.
//   2. DRIFT. Every id the rendered-résumé prose checks emit and every rule id
//      the structured-résumé validator can emit is classified, and every
//      classified id is emitted: in both directions, so a rule added without a
//      decision, or a decision about a rule that no longer exists, fails here.
//   3. BEHAVIOUR. For every structured-résumé rule, on three careers from
//      unrelated fields, a draft that violates ONLY that rule is rejected when
//      the table says 'gate' and accepted-with-an-advisory when it says
//      'advisory'; the same draft with the one violation repaired (the evidence
//      or the flag flipped) is clean. A gate violation still blocks when
//      advisories ride along, and advisories never contribute to the rejection.
//   4. PROSE CHECKS. The rendered-résumé checks still measure everything; only
//      the partition decides what blocks. Flipping one table entry flips the
//      outcome, and an unclassified check id blocks.
//   5. PRECISION. The project-description floor accepts an honest restatement
//      (a plural for a singular) and a short description that is wholly
//      grounded, and still refuses one that shares nothing; a lowercase tool name
//      that the evidence states is a good keyword; a label that grades the
//      candidate's skill is still a strength claim; a project the approved
//      record links to a listed role is advised about, and only as far as the
//      record's own link goes.
//
// Every career here is invented and the three share no employer, tool, school,
// date or wording with any real person or posting: freight yard dispatch, a
// bakehouse, an observatory workshop. The rules under test decide from the
// evidence handed to them and never from a vocabulary of real products.
import { assert } from './testHelpers.js';
import {
  RESUME_CHECK_CLASSES,
  RESUME_CHECK_DISPOSITIONS,
  RESUME_CHECK_DISPOSITION_VALUES,
  RESUME_CHECK_RATIONALES,
  partitionResumeCheckResults,
  resumeCheckDisposition,
} from '../../electron/ipc/resumeCheckDispositions.js';
import {
  CAREER_SNAPSHOT_SKILL_EVIDENCE_VERSION,
  STRUCTURED_RESUME_RULE_IDS,
  STRUCTURED_RESUME_SCHEMA_VERSION,
  renderStructuredApplicationResume,
  renderStructuredResume,
  validateStructuredApplicationResume,
} from '../../electron/ipc/structuredResume.js';
import * as jobApplication from '../../electron/ipc/jobApplication.js';

const { evaluateResumeProseChecks } = jobApplication;

// ---- synthetic careers -------------------------------------------------------

const CAREERS = [
  {
    key: 'freight-yard',
    name: 'Mara Quillon',
    email: 'mara.quillon@example.test',
    prefix: 'BP',
    roles: [
      { id: 'role-dispatch', title: 'Dispatch Coordinator', company: 'Tidewater Freight Cooperative', dates: '2019 – 2023', a: 'Scheduled berth windows for forty container vessels each week.', b: 'Retired the paper tally sheets by moving yard counts into a shared ledger.' },
      { id: 'role-yard', title: 'Yard Clerk', company: 'Saltmarsh Cargo Depot', dates: '2016 – 2019', a: 'Reconciled gate manifests against stacked container counts every shift.' },
    ],
    tools: ['BerthPlan', 'YardLedger', 'TallyDesk', 'CraneRota', 'GateScan', 'ManifestDesk'],
    lowerTool: 'yardsheet',
    levelLine: 'Passed the advanced crane-signalling course.',
    project: {
      slug: 'tide-notes', name: 'Tide Table Notes',
      line: 'Tide Table Notes: a notebook that predicts berth delays from published tide tables.',
      description: 'Predicts berth delays from published tide tables.',
      foldOnly: 'Berth delay estimates', oneTerm: 'Notebook', oneTermUnrelated: 'Telescope',
      listing: 'Experience predicting berth delays from published tide tables', unrelatedListing: 'Comfort with weekend rota coverage',
    },
    education: { credential: 'Certificate in Maritime Logistics', institution: 'Northgate Maritime Institute', range: '2014 – 2015', line: 'Certificate in Maritime Logistics, Northgate Maritime Institute, 2014 – 2015' },
    certification: { name: 'Dangerous Goods Handling Permit', issuer: 'Regional Port Authority', range: '2020 – 2022', line: 'Dangerous Goods Handling Permit, Regional Port Authority, 2020 – 2022' },
  },
  {
    key: 'bakehouse',
    name: 'Odalys Ferreira',
    email: 'odalys.ferreira@example.test',
    prefix: 'PT',
    roles: [
      { id: 'role-lead', title: 'Production Lead', company: 'Copperleaf Bakehouse', dates: '2018 – 2024', a: 'Shortened the overnight proofing schedule from nine hours to six.', b: 'Trained eleven apprentices on allergen-safe batch labelling.' },
      { id: 'role-counter', title: 'Counter Baker', company: 'Millrace Pastry Counter', dates: '2014 – 2018', a: 'Costed the weekly pastry menu against flour and butter prices.' },
    ],
    tools: ['ProofTrack', 'OvenSync', 'BatchLabel', 'CostSheet', 'FlourLog', 'DoughCalc'],
    lowerTool: 'oventimer',
    levelLine: 'Earned an advanced sourdough certificate in a weekend intensive.',
    project: {
      slug: 'rye-starter', name: 'Rye Starter Journal',
      line: 'Rye Starter Journal: a daily log relating starter temperature to loaf rise.',
      description: 'Logs starter temperature against loaf rise daily.',
      foldOnly: 'Daily logs of starters', oneTerm: 'Starters', oneTermUnrelated: 'Spectrometer',
      listing: 'Experience relating dough temperature to rise times', unrelatedListing: 'Willingness to cover early weekend shifts',
    },
    education: { credential: 'Diploma in Baking and Pastry', institution: 'Harbourside Culinary School', range: '2012 – 2014', line: 'Diploma in Baking and Pastry, Harbourside Culinary School, 2012 – 2014' },
    certification: { name: 'Food Allergen Handling Card', issuer: 'County Food Safety Board', range: '2021 – 2023', line: 'Food Allergen Handling Card, County Food Safety Board, 2021 – 2023' },
  },
  {
    key: 'observatory',
    name: 'Tobias Wren',
    email: 'tobias.wren@example.test',
    prefix: 'SC',
    roles: [
      { id: 'role-tech', title: 'Instrument Technician', company: 'Lowmoor Observatory', dates: '2017 – 2024', a: 'Aligned the spectrograph optics before each observing run.', b: 'Replaced the cooling loop on the detector during a single maintenance night.' },
      { id: 'role-lab', title: 'Lab Assistant', company: 'Fenwick Optics Lab', dates: '2013 – 2017', a: 'Calibrated photodiodes against a reference lamp each week.' },
    ],
    tools: ['SpectraCal', 'PhotonLog', 'DarkFrame', 'FlatMaker', 'LoopTune', 'ChipTemp'],
    lowerTool: 'darkbox',
    levelLine: 'Completed the advanced vacuum-systems workshop.',
    project: {
      slug: 'sky-glow', name: 'Sky Glow Atlas',
      line: 'Sky Glow Atlas: maps night sky brightness across county roads with a handheld meter.',
      description: 'Maps night sky brightness along county roads using a handheld meter.',
      foldOnly: 'Road map of county nights', oneTerm: 'Handheld', oneTermUnrelated: 'Violin',
      listing: 'Experience mapping sky brightness with handheld meters', unrelatedListing: 'Availability for overnight observing runs',
    },
    education: { credential: 'Diploma in Applied Optics', institution: 'Harlow Technical College', range: '2011 – 2013', line: 'Diploma in Applied Optics, Harlow Technical College, 2011 – 2013' },
    certification: { name: 'Cryogenic Safety Card', issuer: 'Institute of Laboratory Safety', range: '2019 – 2021', line: 'Cryogenic Safety Card, Institute of Laboratory Safety, 2019 – 2021' },
  },
];

function approvedSkill(slug, name) {
  return {
    id: `skill-${slug}`, name, capabilityKind: 'tool', supportMode: 'direct', indexEligible: true,
    directEvidenceSegmentIds: [`segment-${slug}`], evidenceSegmentIds: [`segment-${slug}`],
  };
}
const inventoryOf = names => ({
  version: CAREER_SNAPSHOT_SKILL_EVIDENCE_VERSION,
  skills: names.map(name => approvedSkill(name.toLowerCase().replace(/[^a-z0-9]+/gu, '-'), name)),
});

/** Everything one career needs to build a draft and the context that grades it. */
function kitOf(spec) {
  const [r1, r2] = spec.roles;
  const extra = Array.from({ length: 21 }, (unused, index) => `${spec.prefix}${String(index + 1).padStart(2, '0')}`);
  const toolsLine = `Tools used: ${spec.tools.join(', ')}, and ${spec.lowerTool}.`;
  const extraLine = `Also used: ${extra.join(', ')}.`;
  const careerData = [
    spec.name, spec.email, '',
    `## ${r1.company}`, r1.title, `*${r1.dates}*`, '',
    `- ${r1.a}`, `- ${r1.b}`, `- ${toolsLine}`, `- ${extraLine}`, `- ${spec.levelLine}`, '', '---', '',
    `## ${r2.company}`, r2.title, `*${r2.dates}*`, '',
    `- ${r2.a}`, '', '---', '',
    '# Personal Projects', `- ${spec.project.line}`, '', '---', '',
    '# Education', spec.education.line, '',
    '# Certifications', spec.certification.line,
  ].join('\n');
  const career = (id, quote) => ({ id, sourceId: 'career-data', quote });
  const listing = (id, quote) => ({ id, sourceId: 'job-listing', quote, priority: 'high' });
  const projectEvidenceId = `host.career.project.${spec.project.slug}.1`;
  const kit = {
    spec,
    sourceRoles: spec.roles.map(role => ({ id: role.id, title: role.title, company: role.company, dates: role.dates, location: '' })),
    careerData,
    ids: { title: `${spec.key}-title`, r1a: `${spec.key}-r1a`, r1b: `${spec.key}-r1b`, tools: `${spec.key}-tools`, extra: `${spec.key}-extra`, level: `${spec.key}-level`, r2a: `${spec.key}-r2a`, project: projectEvidenceId, edu: `${spec.key}-edu`, cert: `${spec.key}-cert` },
    extra,
    catalog: [
      career(`${spec.key}-title`, r1.title), career(`${spec.key}-r1a`, r1.a), career(`${spec.key}-r1b`, r1.b),
      career(`${spec.key}-tools`, toolsLine), career(`${spec.key}-extra`, extraLine), career(`${spec.key}-level`, spec.levelLine),
      career(`${spec.key}-r2a`, r2.a), career(projectEvidenceId, spec.project.line),
      career(`${spec.key}-edu`, spec.education.line), career(`${spec.key}-cert`, spec.certification.line),
      listing('job-match', spec.project.listing), listing('job-other', spec.project.unrelatedListing),
    ],
  };
  // The legacy (pre-snapshot) context and the approved-authority context grade
  // the same draft; only the second carries an inventory of approved skills.
  kit.legacy = overrides => ({ sourceRoles: kit.sourceRoles, evidenceCatalog: kit.catalog, careerData, ...overrides });
  kit.authority = (overrides = {}) => ({
    sourceRoles: kit.sourceRoles, evidenceCatalog: kit.catalog, careerData, authorityMode: true,
    careerSkillEvidence: inventoryOf(spec.tools), ...overrides,
  });
  return kit;
}

const KITS = CAREERS.map(kitOf);

/** A clean, fully grounded draft: one bullet per role, each citing its own body quote. */
function baseDraft(kit) {
  const [r1, r2] = kit.spec.roles;
  return {
    schemaVersion: STRUCTURED_RESUME_SCHEMA_VERSION,
    identity: { name: kit.spec.name, contact: [kit.spec.email] },
    roles: [
      { id: r1.id, title: r1.title, company: r1.company, dates: r1.dates, location: '', bullets: [{ id: 'b1', text: r1.a, evidenceIds: [kit.ids.r1a] }] },
      { id: r2.id, title: r2.title, company: r2.company, dates: r2.dates, location: '', bullets: [{ id: 'b2', text: r2.a, evidenceIds: [kit.ids.r2a] }] },
    ],
  };
}

const group = (index, label, items, evidenceIds) => ({ id: `skills-${index}`, group: label, items, evidenceIds });

/** Run the structured validator and report what it did, in one shape. */
function outcomeOf(draft, context) {
  try {
    const validated = validateStructuredApplicationResume(draft, context);
    return { thrown: false, rules: [], advisoryIds: validated.advisories.map(entry => entry.id), validated };
  } catch (error) {
    if (error?.code !== 'STRUCTURED_RESUME_INVALID') throw error;
    return { thrown: true, rules: error.rules, advisoryIds: error.advisories.map(entry => entry.id), error };
  }
}

// ---- one scenario per structured-résumé rule ----------------------------------
//
// Each scenario builds a pair from the same career: `bad` violates exactly the
// rule under test and `good` is the same draft with that one violation repaired
// (the cited evidence, the label, or the inventory flipped). `mode` picks the
// grading context the rule exists in.
const SCENARIOS = [
  {
    rule: 'evidence-id-is-verified', mode: 'legacy',
    build(kit, fixed) {
      const draft = baseDraft(kit);
      draft.roles[0].bullets[0].evidenceIds = [fixed ? kit.ids.r1a : 'an-id-the-host-never-issued'];
      return { draft };
    },
  },
  {
    rule: 'evidence-includes-career-data', mode: 'legacy',
    build(kit, fixed) {
      const draft = baseDraft(kit);
      draft.roles[0].bullets[0].evidenceIds = fixed ? [kit.ids.r1a, 'job-match'] : ['job-match'];
      return { draft };
    },
  },
  {
    rule: 'approved-skill-spelling', mode: 'authority',
    build(kit, fixed) {
      const draft = baseDraft(kit);
      const tool = kit.spec.tools[0];
      draft.roles[0].bullets[0] = { id: 'b1', text: `${kit.spec.roles[0].a} Planned it in ${fixed ? tool : tool.toLowerCase()}.`, evidenceIds: [kit.ids.r1a, kit.ids.tools] };
      return { draft };
    },
  },
  {
    rule: 'prose-names-approved-skill-its-evidence-does-not-state', mode: 'authority',
    build(kit, fixed) {
      const draft = baseDraft(kit);
      draft.roles[0].bullets[0] = { id: 'b1', text: `${kit.spec.roles[0].a} Planned it in ${kit.spec.tools[0]}.`, evidenceIds: fixed ? [kit.ids.r1a, kit.ids.tools] : [kit.ids.r1a] };
      return { draft };
    },
  },
  {
    rule: 'bullet-cites-own-role-career-section', mode: 'legacy',
    build(kit, fixed) {
      const draft = baseDraft(kit);
      draft.roles[1].bullets[0].evidenceIds = [fixed ? kit.ids.r2a : kit.ids.r1a];
      return { draft };
    },
  },
  {
    rule: 'bullet-cites-past-its-section-opening-block', mode: 'legacy',
    build(kit, fixed) {
      const draft = baseDraft(kit);
      draft.roles[0].bullets[0].evidenceIds = [fixed ? kit.ids.r1a : kit.ids.title];
      return { draft };
    },
  },
  {
    rule: 'bullet-cites-evidence-already-spent-in-role', mode: 'legacy',
    build(kit, fixed) {
      const draft = baseDraft(kit);
      draft.roles[0].bullets.push({ id: 'b1-second', text: kit.spec.roles[0].b, evidenceIds: [fixed ? kit.ids.r1b : kit.ids.r1a] });
      return { draft };
    },
  },
  {
    rule: 'project-field-occurs-in-cited-career-evidence', mode: 'legacy',
    build(kit, fixed) {
      const draft = baseDraft(kit);
      draft.projects = [{ id: 'p1', name: fixed ? kit.spec.project.name : 'Invented Almanac Of Nothing', description: kit.spec.project.description, evidenceIds: [kit.ids.project, 'job-match'] }];
      return { draft };
    },
  },
  {
    rule: 'project-description-shares-career-evidence-terms', mode: 'legacy',
    build(kit, fixed) {
      const draft = baseDraft(kit);
      draft.projects = [{ id: 'p1', name: kit.spec.project.name, description: fixed ? kit.spec.project.description : 'Gleaming tapestry of boundless ambition.', evidenceIds: [kit.ids.project, 'job-match'] }];
      return { draft };
    },
  },
  {
    rule: 'project-cites-job-listing-evidence', mode: 'legacy',
    build(kit, fixed) {
      const draft = baseDraft(kit);
      draft.projects = [{ id: 'p1', name: kit.spec.project.name, description: kit.spec.project.description, evidenceIds: fixed ? [kit.ids.project, 'job-match'] : [kit.ids.project] }];
      return { draft };
    },
  },
  {
    rule: 'project-shares-job-listing-evidence-terms', mode: 'legacy',
    build(kit, fixed) {
      const draft = baseDraft(kit);
      draft.projects = [{ id: 'p1', name: kit.spec.project.name, description: kit.spec.project.description, evidenceIds: [kit.ids.project, fixed ? 'job-match' : 'job-other'] }];
      return { draft };
    },
  },
  {
    rule: 'project-is-work-done-for-a-listed-employer', mode: 'authority',
    build(kit, fixed) {
      const draft = baseDraft(kit);
      draft.projects = [{ id: 'p1', name: kit.spec.project.name, description: kit.spec.project.description, evidenceIds: [kit.ids.project, 'job-match'] }];
      // The approved record's own link is the evidence: flip it and the advice goes.
      return { draft, overrides: { projectRoleOf: entityId => (!fixed && entityId === kit.spec.project.slug ? kit.spec.roles[0].id : null) } };
    },
  },
  {
    rule: 'skill-item-occurs-in-cited-career-evidence', mode: 'legacy',
    build(kit, fixed) {
      const draft = baseDraft(kit);
      draft.skills = [group(0, 'tools', [fixed ? kit.spec.tools[0] : 'Zxqv9'], [kit.ids.tools])];
      return { draft };
    },
  },
  {
    rule: 'skill-item-is-a-filterable-name', mode: 'authority',
    build(kit, fixed) {
      const draft = baseDraft(kit);
      draft.skills = [group(0, 'tools', [kit.spec.tools[2]], [kit.ids.tools])];
      // The item is stated by the cited quote either way; whether it is an
      // APPROVED, index-eligible skill is the only thing that flips.
      const names = fixed ? kit.spec.tools : kit.spec.tools.filter(name => name !== kit.spec.tools[2]);
      return { draft, overrides: { careerSkillEvidence: inventoryOf(names) } };
    },
  },
  {
    rule: 'skill-item-looks-like-a-filterable-name', mode: 'legacy',
    build(kit, fixed) {
      const draft = baseDraft(kit);
      draft.skills = [group(0, 'tools', [fixed ? kit.spec.tools[0] : kit.spec.lowerTool], [kit.ids.tools])];
      return { draft };
    },
  },
  {
    rule: 'skill-group-is-neutral-or-in-career-data', mode: 'legacy',
    build(kit, fixed) {
      const draft = baseDraft(kit);
      draft.skills = [group(0, fixed ? 'tools' : 'Bespoke Wizardry', [kit.spec.tools[0]], [kit.ids.tools])];
      return { draft };
    },
  },
  {
    rule: 'skill-group-label-claims-a-level', mode: 'legacy',
    build(kit, fixed) {
      const draft = baseDraft(kit);
      draft.skills = [group(0, fixed ? 'tools' : 'Expert tools', [kit.spec.tools[0]], [kit.ids.tools])];
      return { draft };
    },
  },
  {
    rule: 'skills-block-big-enough-to-split-is-split', mode: 'legacy',
    build(kit, fixed) {
      const draft = baseDraft(kit);
      const tools = kit.spec.tools;
      draft.skills = fixed
        ? [group(0, 'tools', tools.slice(0, 3), [kit.ids.tools]), group(1, 'methods', tools.slice(3), [kit.ids.tools])]
        : [group(0, 'tools', tools, [kit.ids.tools])];
      return { draft };
    },
  },
  {
    rule: 'skills-block-within-design-row-budget', mode: 'legacy',
    build(kit, fixed) {
      const draft = baseDraft(kit);
      const [a, b, c, d] = kit.spec.tools;
      draft.skills = [group(0, 'tools', [a], [kit.ids.tools]), group(1, 'methods', [b], [kit.ids.tools]), group(2, 'systems', [c], [kit.ids.tools])];
      if (!fixed) draft.skills.push(group(3, 'practices', [d], [kit.ids.tools]));
      return { draft };
    },
  },
  {
    rule: 'skills-block-within-design-term-budget', mode: 'legacy',
    build(kit, fixed) {
      const draft = baseDraft(kit);
      const per = fixed ? 6 : 7;
      draft.skills = [0, 1, 2].map(index => group(index, ['tools', 'methods', 'systems'][index], kit.extra.slice(index * per, index * per + per), [kit.ids.extra]));
      return { draft };
    },
  },
  {
    rule: 'skills-row-within-design-character-budget', mode: 'legacy',
    build(kit, fixed) {
      const draft = baseDraft(kit);
      const tools = kit.spec.tools;
      draft.skills = fixed
        ? [group(0, 'tools', tools.slice(0, 3), [kit.ids.tools]), group(1, 'methods', tools.slice(3), [kit.ids.tools])]
        : [group(0, 'tools', tools, [kit.ids.tools])];
      return { draft };
    },
  },
  {
    rule: 'skill-block-omits-posting-named-attested-term', mode: 'authority',
    build(kit, fixed) {
      const draft = baseDraft(kit);
      const tools = kit.spec.tools;
      draft.skills = [
        group(0, 'tools', fixed ? tools.slice(0, 3) : tools.slice(1, 3), [kit.ids.tools]),
        group(1, 'methods', tools.slice(3), [kit.ids.tools]),
      ];
      // The posting names the first tool and the career quote states it.
      const named = { id: 'job-names-tool', sourceId: 'job-listing', quote: `Hands-on use of ${tools[0]} is required`, priority: 'highest' };
      return { draft, overrides: { evidenceCatalog: [...kit.catalog, named] } };
    },
  },
  {
    rule: 'skills-block-omits-prioritized-career-attested-term', mode: 'authority',
    build(kit, fixed) {
      const draft = baseDraft(kit);
      const tools = kit.spec.tools;
      draft.skills = fixed
        ? [group(0, 'tools', tools.slice(0, 3), [kit.ids.tools]), group(1, 'methods', tools.slice(3), [kit.ids.tools])]
        : [group(0, 'tools', tools.slice(0, 2), [kit.ids.tools])];
      return { draft };
    },
  },
  {
    rule: 'education-field-occurs-in-cited-career-evidence', mode: 'legacy',
    build(kit, fixed) {
      const draft = baseDraft(kit);
      draft.education = [{ id: 'edu-1', credential: fixed ? kit.spec.education.credential : 'Master of Invented Studies', institution: kit.spec.education.institution, evidenceIds: [kit.ids.edu] }];
      return { draft };
    },
  },
  {
    rule: 'certification-field-occurs-in-cited-career-evidence', mode: 'legacy',
    build(kit, fixed) {
      const draft = baseDraft(kit);
      draft.credentials = [{ id: 'cert-1', name: fixed ? kit.spec.certification.name : 'Licence To Invent Things', issuer: kit.spec.certification.issuer, evidenceIds: [kit.ids.cert] }];
      return { draft };
    },
  },
  {
    rule: 'education-dates-state-one-end-of-a-range', mode: 'legacy',
    build(kit, fixed) {
      const draft = baseDraft(kit);
      const { range } = kit.spec.education;
      draft.education = [{ id: 'edu-1', credential: kit.spec.education.credential, institution: kit.spec.education.institution, dates: fixed ? range : range.slice(0, 4), evidenceIds: [kit.ids.edu] }];
      return { draft };
    },
  },
  {
    rule: 'certification-dates-state-one-end-of-a-range', mode: 'legacy',
    build(kit, fixed) {
      const draft = baseDraft(kit);
      const { range } = kit.spec.certification;
      draft.credentials = [{ id: 'cert-1', name: kit.spec.certification.name, issuer: kit.spec.certification.issuer, dates: fixed ? range : range.slice(0, 4), evidenceIds: [kit.ids.cert] }];
      return { draft };
    },
  },
];

const contextFor = (kit, scenario, overrides = {}) => (scenario.mode === 'authority' ? kit.authority(overrides) : kit.legacy(overrides));

/** Every rule id the scenarios saw the validator emit, for the drift test. */
let observedRules = null;
function runScenarioBattery() {
  if (observedRules) return observedRules;
  const seen = new Set();
  for (const scenario of SCENARIOS) {
    for (const kit of KITS) {
      for (const fixed of [false, true]) {
        const { draft, overrides } = scenario.build(kit, fixed);
        const result = outcomeOf(draft, contextFor(kit, scenario, overrides));
        for (const id of [...result.rules, ...result.advisoryIds]) seen.add(id);
      }
    }
  }
  observedRules = seen;
  return seen;
}

// ---- tests --------------------------------------------------------------------

export default [
  {
    name: 'The résumé check disposition table is frozen, justified, fails closed, and never softens a TRUTH rule',
    run() {
      for (const table of [RESUME_CHECK_DISPOSITIONS, RESUME_CHECK_CLASSES, RESUME_CHECK_RATIONALES, RESUME_CHECK_DISPOSITION_VALUES]) {
        assert(Object.isFrozen(table), 'every exported table is frozen');
      }
      assert(JSON.stringify([...RESUME_CHECK_DISPOSITION_VALUES]) === JSON.stringify(['gate', 'advisory', 'off']), 'a check has exactly three possible dispositions');
      const ids = Object.keys(RESUME_CHECK_DISPOSITIONS);
      assert(ids.length > 20, 'the table classifies the prose checks and the structured-résumé rules');
      assert(JSON.stringify(Object.keys(RESUME_CHECK_CLASSES).sort()) === JSON.stringify([...ids].sort())
        && JSON.stringify(Object.keys(RESUME_CHECK_RATIONALES).sort()) === JSON.stringify([...ids].sort()),
      'every id has a class and a stated reason, and nothing has a reason without a disposition');
      for (const id of ids) {
        assert(RESUME_CHECK_DISPOSITION_VALUES.includes(RESUME_CHECK_DISPOSITIONS[id]), `${id}: its disposition is one of the three`);
        assert(['TRUTH', 'HYGIENE', 'TASTE', 'MIXED'].includes(RESUME_CHECK_CLASSES[id]), `${id}: it carries one of the audit's four classes`);
        assert(typeof RESUME_CHECK_RATIONALES[id] === 'string' && RESUME_CHECK_RATIONALES[id].length > 20, `${id}: it states why`);
      }
      // The principle, as an invariant the table must keep: no TRUTH row is ever
      // anything but a gate; a TASTE row never blocks; the only HYGIENE row that
      // does not block is the bullet-count ceiling, whose reason is spelled out.
      for (const id of ids) {
        if (RESUME_CHECK_CLASSES[id] === 'TRUTH') assert(RESUME_CHECK_DISPOSITIONS[id] === 'gate', `${id}: a TRUTH rule rejects`);
        if (RESUME_CHECK_CLASSES[id] === 'TASTE') assert(RESUME_CHECK_DISPOSITIONS[id] !== 'gate', `${id}: a TASTE rule never rejects`);
        if (RESUME_CHECK_CLASSES[id] === 'HYGIENE' && RESUME_CHECK_DISPOSITIONS[id] !== 'gate') {
          assert(id === 'resume-role-bullet-budget' && /fit/u.test(RESUME_CHECK_RATIONALES[id]), `${id}: a HYGIENE row that does not block must say why (page fit is measured elsewhere)`);
        }
      }

      // Fail closed: nothing the table does not list, and no value it does not
      // allow, can ever be anything but a gate.
      for (const unknown of ['a-check-nobody-classified', '', 'constructor', '__proto__', 'toString', 'hasOwnProperty', undefined, null, 42, {}]) {
        assert(resumeCheckDisposition(unknown) === 'gate', `${String(unknown)}: an unclassified id is a gate`);
      }
      assert(resumeCheckDisposition('resume-bullet-length', { 'resume-bullet-length': 'sometimes' }) === 'gate', 'a value outside the three is a gate');
      assert(resumeCheckDisposition('resume-bullet-length', null) === 'gate' && resumeCheckDisposition('resume-bullet-length', 'a string') === 'gate', 'a missing table is a gate');

      // Mutation: the answer follows the table it is given, and only that entry.
      const flipped = { ...RESUME_CHECK_DISPOSITIONS, 'resume-bullet-length': 'gate', 'prose-names-approved-skill-its-evidence-does-not-state': 'off' };
      assert(resumeCheckDisposition('resume-bullet-length') === 'advisory' && resumeCheckDisposition('resume-bullet-length', flipped) === 'gate',
        'flipping one entry flips that check’s answer');
      assert(resumeCheckDisposition('prose-names-approved-skill-its-evidence-does-not-state', flipped) === 'off'
        && resumeCheckDisposition('resume-bullet-opening-variety', flipped) === resumeCheckDisposition('resume-bullet-opening-variety'),
      'and leaves every other entry alone');
      return { rows: ids.length };
    },
  },
  {
    name: 'Drift: every résumé check id the code can emit is classified, and every classified id is emitted',
    run() {
      const proseIds = evaluateResumeProseChecks('').map(check => check.id);
      assert(proseIds.length === new Set(proseIds).size, 'the prose checks emit distinct ids');
      for (const id of proseIds) assert(Object.hasOwn(RESUME_CHECK_DISPOSITIONS, id), `${id}: a rendered-résumé prose check is emitted without a disposition`);

      const ruleIds = [...STRUCTURED_RESUME_RULE_IDS];
      assert(ruleIds.length === new Set(ruleIds).size, 'the structured-résumé validator declares distinct rule ids');
      for (const id of ruleIds) assert(Object.hasOwn(RESUME_CHECK_DISPOSITIONS, id), `${id}: a structured-résumé rule is declared without a disposition`);

      // Every id the table classifies belongs to a check that exists, so a rule
      // that is removed leaves no orphan decision behind. The two families are
      // disjoint, so one table can key both.
      assert(proseIds.every(id => !ruleIds.includes(id)), 'a prose check and a validator rule never share an id');
      const emitted = new Set([...proseIds, ...ruleIds]);
      for (const id of Object.keys(RESUME_CHECK_DISPOSITIONS)) assert(emitted.has(id), `${id}: classified but no résumé check emits it`);

      // The validator's declared list is also the list it really emits: the
      // scenario battery drives it into every rule on three careers and nothing
      // outside the list ever comes out, and nothing in the list is unreachable.
      const seen = runScenarioBattery();
      for (const id of seen) assert(ruleIds.includes(id), `${id}: the validator emitted a rule id its declared list does not hold`);
      for (const id of ruleIds) assert(seen.has(id), `${id}: declared but no scenario could make the validator emit it`);
      assert(SCENARIOS.length === ruleIds.length && new Set(SCENARIOS.map(scenario => scenario.rule)).size === ruleIds.length,
        'there is exactly one scenario per declared rule');
      return { prose: proseIds.length, rules: ruleIds.length };
    },
  },
  {
    name: 'Each structured-résumé rule does what the table says on three unrelated careers, and flips with the evidence',
    run() {
      let gates = 0;
      let advisories = 0;
      for (const scenario of SCENARIOS) {
        const disposition = RESUME_CHECK_DISPOSITIONS[scenario.rule];
        for (const kit of KITS) {
          const label = `${scenario.rule} / ${kit.spec.key}`;
          const bad = scenario.build(kit, false);
          const badResult = outcomeOf(bad.draft, contextFor(kit, scenario, bad.overrides));
          const good = scenario.build(kit, true);
          const goodResult = outcomeOf(good.draft, contextFor(kit, scenario, good.overrides));

          if (disposition === 'gate') {
            assert(badResult.thrown && badResult.rules.includes(scenario.rule), `${label}: a violation of a gate rule rejects the draft and names the rule (rules=${JSON.stringify(badResult.rules)})`);
            assert(badResult.error.checks.every(check => check.passed === false && typeof check.detail === 'string' && check.detail.length > 0), `${label}: a rejection carries a check-shaped record per rule`);
            gates += 1;
          } else {
            assert(!badResult.thrown, `${label}: a violation of an ${disposition} rule never rejects the draft (rules=${JSON.stringify(badResult.rules)})`);
            if (disposition === 'advisory') {
              assert(badResult.advisoryIds.includes(scenario.rule), `${label}: it is reported as an advisory (advisories=${JSON.stringify(badResult.advisoryIds)})`);
              const entry = badResult.validated.advisories.find(item => item.id === scenario.rule);
              assert(entry.passed === false && entry.disposition === 'advisory' && entry.detail.length > 0, `${label}: the advisory is a check-shaped record with its detail`);
              advisories += 1;
            } else {
              assert(!badResult.advisoryIds.includes(scenario.rule), `${label}: an off rule is not reported`);
            }
          }
          // The repaired twin is the mutation: flip the one thing that was wrong
          // and the outcome flips with it, whatever the disposition.
          assert(!goodResult.thrown, `${label}: with the violation repaired the draft is accepted (rules=${JSON.stringify(goodResult.rules)})`);
          assert(!goodResult.advisoryIds.includes(scenario.rule), `${label}: with the violation repaired the rule no longer speaks (advisories=${JSON.stringify(goodResult.advisoryIds)})`);
        }
      }
      assert(gates >= 3 * 12 && advisories >= 3 * 11, `the battery exercises both kinds of rule (gates=${gates}, advisories=${advisories})`);
      return { gates, advisories };
    },
  },
  {
    name: 'An advisory never contributes to a rejection, a gate violation still blocks beside advisories, and an advisory-only draft renders',
    run() {
      for (const kit of KITS) {
        const label = kit.spec.key;
        const tools = kit.spec.tools;
        const draft = baseDraft(kit);
        // Three advisory-class defects in one draft: a label outside the vocabulary,
        // a block that should have been split, and a bullet that restates the header.
        draft.skills = [group(0, 'Bespoke Wizardry', tools, [kit.ids.tools])];
        draft.roles[0].bullets[0].evidenceIds = [kit.ids.title];
        const advisoryOnly = outcomeOf(draft, kit.legacy());
        assert(!advisoryOnly.thrown, `${label}: advisory-class defects alone never reject`);
        for (const id of ['skill-group-is-neutral-or-in-career-data', 'skills-block-big-enough-to-split-is-split', 'bullet-cites-past-its-section-opening-block']) {
          assert(advisoryOnly.advisoryIds.includes(id), `${label}: ${id} is reported`);
        }
        const partition = partitionResumeCheckResults(advisoryOnly.validated.advisories);
        assert(partition.blocking.length === 0 && partition.advisory.length === advisoryOnly.validated.advisories.length,
          `${label}: the draft's own advisories partition as advisory, never blocking`);
        const html = renderStructuredApplicationResume(draft, kit.legacy());
        assert(html.includes(kit.spec.roles[0].company) && html.includes(kit.spec.tools[0]), `${label}: an advisory-only draft still renders`);
        // Two groups under one label render as one row, items in order, no repeat.
        const splitLabel = baseDraft(kit);
        splitLabel.skills = [group(0, 'tools', [tools[0], tools[1]], [kit.ids.tools]), group(1, 'Tools', [tools[1], tools[2]], [kit.ids.tools])];
        const splitHtml = renderStructuredApplicationResume(splitLabel, kit.legacy());
        assert((splitHtml.match(/<dt>/g) || []).length === 1 && splitHtml.includes(`<dd>${[tools[0], tools[1], tools[2]].join(' · ')}</dd>`),
          `${label}: same-label skill groups merge into one rendered row`);
        const rendered = renderStructuredResume(draft, kit.legacy());
        assert(rendered.advisories === rendered.draft.advisories && rendered.advisories.length === advisoryOnly.validated.advisories.length,
          `${label}: the render result carries the same advisories`);

        // Add ONE gate violation to the same draft: it blocks, names only itself,
        // and the advisories ride along without being part of the rejection.
        const withGate = structuredClone(draft);
        withGate.roles[1].bullets[0].evidenceIds = [kit.ids.r1a];
        const blocked = outcomeOf(withGate, kit.legacy());
        assert(blocked.thrown && JSON.stringify(blocked.rules) === JSON.stringify(['bullet-cites-own-role-career-section']),
          `${label}: only the gate rule rejects (rules=${JSON.stringify(blocked.rules)})`);
        assert(!blocked.error.message.includes('Bespoke Wizardry') && !blocked.error.detail.includes('also applies to'),
          `${label}: the rejection text carries no advisory wording`);
        assert(blocked.advisoryIds.includes('skill-group-is-neutral-or-in-career-data'), `${label}: the advisories still ride along on the error`);
        // Mutation: repair the one gate violation and the draft is accepted again.
        withGate.roles[1].bullets[0].evidenceIds = [kit.ids.r2a];
        assert(!outcomeOf(withGate, kit.legacy()).thrown, `${label}: repairing the gate violation lets the same draft through`);

        // An advisory collection is one bounded finding that never says "rejects".
        const many = baseDraft(kit);
        many.skills = Array.from({ length: 12 }, (unused, index) => group(index, `Invented Specialty ${index}`, [kit.extra[index]], [kit.ids.extra]));
        const advised = outcomeOf(many, kit.legacy());
        const labelAdvice = advised.validated.advisories.filter(entry => entry.id === 'skill-group-is-neutral-or-in-career-data');
        assert(!advised.thrown && labelAdvice.length === 1 && /and 3 more/u.test(labelAdvice[0].detail) && !/rejects/u.test(labelAdvice[0].detail) && labelAdvice[0].detail.length < 2_000,
          `${label}: twelve invented labels are one bounded advisory that does not claim to reject`);
      }
    },
  },
  {
    name: 'The rendered-résumé prose checks measure everything and the partition alone decides what blocks',
    run() {
      for (const kit of KITS) {
        const label = kit.spec.key;
        const [r1] = kit.spec.roles;
        const overlong = `${r1.a} ${r1.b} ${kit.spec.levelLine} ${kit.spec.levelLine}`;
        const draft = baseDraft(kit);
        // Seven bullets (past the six-bullet ceiling), three of them opening on
        // the same word, one on a pronoun, one far past the character budget:
        // every one of them real {id,text,evidenceIds} bullets that render.
        draft.roles[0].bullets = [
          { id: 'b1', text: `Built ${r1.a.toLowerCase()}`, evidenceIds: [kit.ids.r1a] },
          { id: 'b2', text: `Built ${r1.b.toLowerCase()}`, evidenceIds: [kit.ids.r1b] },
          { id: 'b3', text: `Built ${kit.spec.levelLine.toLowerCase()}`, evidenceIds: [kit.ids.level] },
          { id: 'b4', text: `It ${r1.a.toLowerCase()}`, evidenceIds: [kit.ids.tools] },
          { id: 'b5', text: overlong, evidenceIds: [kit.ids.extra] },
          { id: 'b6', text: `Kept ${r1.b.toLowerCase()}`, evidenceIds: [kit.ids.title, kit.ids.r1b] },
          { id: 'b7', text: `Ran ${r1.a.toLowerCase()}`, evidenceIds: [kit.ids.r1a, kit.ids.tools] },
        ];
        const html = renderStructuredApplicationResume(draft, kit.legacy());
        const checks = evaluateResumeProseChecks(html);
        const failed = new Set(checks.filter(check => !check.passed).map(check => check.id));
        for (const id of ['resume-bullet-length', 'resume-role-bullet-budget', 'resume-bullet-opening-variety', 'resume-bullet-self-containment']) {
          assert(failed.has(id), `${label}: the check still measures ${id} (failed=${JSON.stringify([...failed])})`);
        }

        const partition = partitionResumeCheckResults(checks);
        assert(partition.blocking.length === 0, `${label}: no rendered-résumé prose check blocks (blocking=${JSON.stringify(partition.blocking.map(check => check.id))})`);
        assert(['resume-bullet-length', 'resume-role-bullet-budget', 'resume-bullet-self-containment'].every(id => partition.advisory.some(check => check.id === id)),
          `${label}: the length, bullet-count and self-containment findings are advisories`);
        assert(partition.off.some(check => check.id === 'resume-bullet-opening-variety') && !partition.advisory.some(check => check.id === 'resume-bullet-opening-variety'),
          `${label}: the opening-variety finding is switched off, not reported`);
        assert(partition.passed.every(check => check.passed === true) && partition.advisory.every(check => check.passed === false && check.disposition === 'advisory'),
          `${label}: copies carry their disposition and passed checks are kept apart`);
        assert(partition.passed.length + partition.advisory.length + partition.off.length + partition.blocking.length === checks.length, `${label}: the partition loses nothing`);

        // Mutation 1: flip the table entry, and the same finding now blocks.
        const strict = { ...RESUME_CHECK_DISPOSITIONS, 'resume-bullet-length': 'gate' };
        const flipped = partitionResumeCheckResults(checks, strict);
        assert(flipped.blocking.length === 1 && flipped.blocking[0].id === 'resume-bullet-length' && !flipped.advisory.some(check => check.id === 'resume-bullet-length'),
          `${label}: flipping only resume-bullet-length to gate makes exactly that finding block`);
        // Mutation 2: flip the evidence, and the finding disappears. Shorten the
        // overlong bullet below the budget and drop to the ceiling.
        const repaired = structuredClone(draft);
        repaired.roles[0].bullets[4].text = r1.a;
        repaired.roles[0].bullets.pop();
        const repairedChecks = evaluateResumeProseChecks(renderStructuredApplicationResume(repaired, kit.legacy()));
        assert(repairedChecks.find(check => check.id === 'resume-bullet-length').passed && repairedChecks.find(check => check.id === 'resume-role-bullet-budget').passed,
          `${label}: the same résumé with the bullet shortened and the count at the ceiling no longer trips either`);
      }
      // A check nobody classified blocks, and so does a failure that names no id.
      const unknown = partitionResumeCheckResults([
        { id: 'a-check-added-later', passed: false, detail: 'x' },
        { passed: false, detail: 'no id at all' },
        { id: 'resume-bullet-length', passed: true, detail: 'fine' },
        null, 'not a check', 7,
      ]);
      assert(unknown.blocking.length === 2 && unknown.passed.length === 1 && unknown.advisory.length === 0,
        'an unclassified or unattributable failure is a gate; malformed entries are ignored; a pass is a pass');
      assert(partitionResumeCheckResults(undefined).blocking.length === 0 && partitionResumeCheckResults('x').passed.length === 0, 'a non-array partitions to nothing');
      // The re-export on jobApplication.js is the same table, not a copy.
      assert(jobApplication.RESUME_CHECK_DISPOSITIONS === RESUME_CHECK_DISPOSITIONS && jobApplication.partitionResumeCheckResults === partitionResumeCheckResults,
        'jobApplication.js re-exports the one table');
    },
  },
  {
    name: 'Precision: the project-description floor accepts honest restatements and grounded short descriptions and still refuses description that shares nothing',
    run() {
      for (const kit of KITS) {
        const label = kit.spec.key;
        const withDescription = description => {
          const draft = baseDraft(kit);
          draft.projects = [{ id: 'p1', name: kit.spec.project.name, description, evidenceIds: [kit.ids.project, 'job-match'] }];
          return outcomeOf(draft, kit.legacy());
        };
        const { foldOnly, oneTerm, oneTermUnrelated } = kit.spec.project;
        // A plural for a singular (and the reverse) is the same term: the floor
        // of two shared terms is met by one exact match and one inflection.
        const folded = withDescription(foldOnly);
        assert(!folded.thrown, `${label}: "${foldOnly}" restates its evidence with a plural and is accepted (rules=${JSON.stringify(folded.rules)})`);
        // A description with a single countable term cannot be held to two: that
        // one has to match, and it is judged on that.
        assert(!withDescription(oneTerm).thrown, `${label}: a one-term description whose term the evidence states is accepted`);
        assert(withDescription(oneTermUnrelated).rules.includes('project-description-shares-career-evidence-terms'), `${label}: a one-term description whose term the evidence never states is refused`);
        // Nothing countable asserts nothing the evidence could support.
        assert(withDescription('An AI of it.').rules.includes('project-description-shares-career-evidence-terms'), `${label}: a description with no countable term is refused`);
        // Sharing nothing is still refused, and so is sharing only ONE term when
        // the description holds several.
        assert(withDescription('Gleaming tapestry of boundless ambition.').rules.includes('project-description-shares-career-evidence-terms'), `${label}: a description that shares nothing is refused`);
        const firstWord = kit.spec.project.line.split(/[\s:]+/u)[2] || kit.spec.project.name.split(' ')[0];
        assert(withDescription(`${firstWord} gleaming tapestry boundless ambition`).rules.includes('project-description-shares-career-evidence-terms'),
          `${label}: one shared term among four is not the floor of two`);
        // Mutation: the same description flips with the evidence it cites.
        const draft = baseDraft(kit);
        draft.projects = [{ id: 'p1', name: kit.spec.project.name, description: foldOnly, evidenceIds: [kit.ids.project, 'job-match'] }];
        const elsewhere = structuredClone(draft);
        elsewhere.projects[0].evidenceIds = [kit.ids.r1a, 'job-match'];
        assert(outcomeOf(elsewhere, kit.legacy()).rules.includes('project-field-occurs-in-cited-career-evidence')
          || outcomeOf(elsewhere, kit.legacy()).rules.includes('project-description-shares-career-evidence-terms'),
        `${label}: cite other evidence and the same project is refused`);
      }
    },
  },
  {
    name: 'Precision: a lowercase tool name the evidence states is a good keyword in a pre-snapshot job, and the approved inventory stays a hard gate',
    run() {
      for (const kit of KITS) {
        const label = kit.spec.key;
        const { lowerTool } = kit.spec;
        const draft = baseDraft(kit);
        draft.skills = [group(0, 'tools', [lowerTool], [kit.ids.tools])];
        const legacy = outcomeOf(draft, kit.legacy());
        assert(!legacy.thrown && legacy.advisoryIds.includes('skill-item-looks-like-a-filterable-name'),
          `${label}: the capitalisation guess only advises (rules=${JSON.stringify(legacy.rules)})`);
        assert(!legacy.advisoryIds.includes('skill-item-is-a-filterable-name'), `${label}: and it is not filed under the approved-inventory rule`);
        // Truth is untouched: an item the evidence never states is still refused.
        const invented = structuredClone(draft);
        invented.skills[0].items = [`${lowerTool}zz`];
        assert(outcomeOf(invented, kit.legacy()).rules.includes('skill-item-occurs-in-cited-career-evidence'), `${label}: a lowercase item the evidence never states is still a gate`);
        // With an approved inventory the same lowercase name is judged by the
        // inventory: refused when it is not approved, accepted once it is.
        const notApproved = outcomeOf(draft, kit.authority());
        assert(notApproved.thrown && notApproved.rules.includes('skill-item-is-a-filterable-name'), `${label}: an item outside the approved inventory is refused`);
        const approved = outcomeOf(draft, kit.authority({ careerSkillEvidence: inventoryOf([...kit.spec.tools, lowerTool]) }));
        assert(!approved.thrown, `${label}: the same item is accepted once the inventory approves it (rules=${JSON.stringify(approved.rules)})`);
      }
    },
  },
  {
    name: 'A skills-row label that grades the candidate is a strength claim the cited evidence must state; an invented label that grades nothing only advises',
    run() {
      for (const kit of KITS) {
        const label = kit.spec.key;
        const withLabel = (text, evidenceIds) => {
          const draft = baseDraft(kit);
          draft.skills = [group(0, text, [kit.spec.tools[0]], evidenceIds)];
          return outcomeOf(draft, kit.legacy());
        };
        const levelWords = ['Expert', 'Advanced', 'Proficient', 'Fluent', 'Mastery of', 'Seasoned', 'Accomplished'];
        for (const word of levelWords) {
          const result = withLabel(`${word} tools`, [kit.ids.tools]);
          assert(result.thrown && result.rules.includes('skill-group-label-claims-a-level'), `${label}: "${word} tools" grades the candidate and is refused when the evidence does not say so`);
        }
        // Evidence flip: a group that cites a quote stating the level may use it.
        const supported = withLabel('Advanced tools', [kit.ids.tools, kit.ids.level]);
        assert(!supported.thrown && !supported.advisoryIds.includes('skill-group-label-claims-a-level'),
          `${label}: the same label is accepted when a cited career quote states the level (rules=${JSON.stringify(supported.rules)})`);
        // A label outside the vocabulary that grades nothing is vocabulary only.
        const invented = withLabel('Bespoke Wizardry', [kit.ids.tools]);
        assert(!invented.thrown && invented.advisoryIds.includes('skill-group-is-neutral-or-in-career-data'), `${label}: an invented label advises and never rejects`);
        // The ceiling the vocabulary states is the advisory's trigger: a label
        // joining more neutral labels than the rule allows is advised about, one
        // within it is not.
        const within = withLabel('tools, methods and systems', [kit.ids.tools]);
        const beyond = withLabel('tools, methods, systems and practices', [kit.ids.tools]);
        assert(!within.advisoryIds.includes('skill-group-is-neutral-or-in-career-data') && beyond.advisoryIds.includes('skill-group-is-neutral-or-in-career-data') && !beyond.thrown,
          `${label}: three neutral labels joined are inside the vocabulary and four are advised about`);
      }
    },
  },
  {
    name: 'A project the approved record links to a listed role is advised about, only as far as that record’s own link goes',
    run() {
      for (const kit of KITS) {
        const label = kit.spec.key;
        const [r1, r2] = kit.spec.roles;
        const { slug } = kit.spec.project;
        const draft = baseDraft(kit);
        draft.projects = [{ id: 'p1', name: kit.spec.project.name, description: kit.spec.project.description, evidenceIds: [kit.ids.project, 'job-match'] }];
        const rule = 'project-is-work-done-for-a-listed-employer';
        const linked = outcomeOf(draft, kit.authority({ projectRoleOf: entityId => (entityId === slug ? r1.id : null) }));
        assert(!linked.thrown && linked.advisoryIds.includes(rule), `${label}: a project linked to a listed role is advised about, never rejected`);
        const entry = linked.validated.advisories.find(item => item.id === rule);
        assert(entry.detail.includes(r1.title) && entry.detail.includes(r1.company) && entry.detail.includes('projects.p1'), `${label}: the advice names the project and the role the record links it to`);
        // The same link to the other listed role names that one instead.
        const other = outcomeOf(draft, kit.authority({ projectRoleOf: entityId => (entityId === slug ? r2.id : null) }));
        assert(other.validated.advisories.find(item => item.id === rule).detail.includes(r2.company), `${label}: the role named follows the record’s link`);
        // Mutation: take the link away, point it at a role the résumé does not list,
        // or make the lookup fail, and the advice goes. Nothing is inferred from wording.
        for (const [why, lookup] of [
          ['no link in the record', () => null],
          ['a link to a role the résumé does not list', () => 'a-role-this-resume-does-not-hold'],
          ['a link for some other project', entityId => (entityId === `${slug}-other` ? r1.id : null)],
          ['a lookup that throws', () => { throw new Error('record unavailable'); }],
        ]) {
          const result = outcomeOf(draft, kit.authority({ projectRoleOf: lookup }));
          assert(!result.thrown && !result.advisoryIds.includes(rule), `${label}: ${why}: no advice`);
        }
        assert(!outcomeOf(draft, kit.authority()).advisoryIds.includes(rule), `${label}: with no lookup supplied the check has nothing to read and says nothing`);
        // A project whose evidence is not an approved project quote is not read at all.
        const notAProject = structuredClone(draft);
        notAProject.projects[0].evidenceIds = [kit.ids.tools, 'job-match'];
        assert(!outcomeOf(notAProject, kit.authority({ projectRoleOf: () => r1.id })).advisoryIds.includes(rule), `${label}: evidence that is not an approved project quote carries no link`);
        // A lookup that is not a function is this app's defect, not the draft's.
        let configuration = '';
        try { validateStructuredApplicationResume(draft, kit.authority({ projectRoleOf: { [slug]: r1.id } })); } catch (error) { configuration = error?.code || ''; }
        assert(configuration === 'STRUCTURED_RESUME_CONFIGURATION', `${label}: a lookup that is not a function is a host fault`);
      }
    },
  },
];
