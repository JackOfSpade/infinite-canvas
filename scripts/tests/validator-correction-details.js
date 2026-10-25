import { readFileSync } from 'node:fs';
import * as officialPosting from '../../electron/ipc/officialPostingBridge.js';
import { validateGapReviewSubmission as gapValidator, w4Lines as lines, __rejectionCauseKeysForTests as causeKeys, diagnoseCompensationExperienceBandLadder, isValidCompensationExperienceBandLadder } from '../test-dependencies.js';
import {
  assert, w4Jobs as jobs, w4Scoring as scoring, w4Preferences as prefs,
  w4Taxonomy as taxonomy, w4Location as location, w4Consolidation as consolidation,
  w4Interview as interview, w4Marketplace as market, w4Hub as hub, w4Text as text,
} from '../test-dependencies.js';

const A = 'a'.repeat(24), B = 'b'.repeat(24), C = 'c'.repeat(24);
const source = 'ZQX-SENTINEL-RESEARCH Alpha duty one. Beta duty two. https://source.example.test/a 2026-01-01';
const inventory = ['one', 'two', 'three'].map((id, index) => ({ id, requirementText: 'Synthetic duty', priority: 'required', jobEvidence: `Duty ${index}` }));
const plan = () => ({ version: 1, summary: '', titles: [], warnings: [], softPreferences: [{ id: 'p1', criterion: 'Alpha role', category: 'role' }], strictRequirements: [], direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: true } });
const listing = (index, fields = {}) => ({ index, listingId: 'wrong', matches: [{ preferenceId: 'p1', outcome: 'confirmed', evidenceQuote: '' }], ...fields });
const gapRow = id => ({ id, verdict: 'confirmed', priority: 'unchanged', status: 'unchanged', jobEvidence: '', candidateEvidence: '', duplicateOf: '', explanation: 'Synthetic' });
const requests = [{ researchId: A, group: { jobs: [{ marketCurrency: 'USD' }] } }, { researchId: B, group: { jobs: [{ marketCurrency: 'USD' }] } }];
const sections = new Map([[A, source], [B, source]]);
const range = () => ({ comparable: true, min: -1, max: -2, currency: 'EUR', sourceName: '', sourceUrl: 'https://wrong.example.test', evidenceQuote: '', sourceDate: '' });
const cohort = id => ({ researchId: id, assessments: [{ index: 0, comparableRanges: [range(), range()] }] });
const ladder = id => ({ researchId: id, roleFamily: 'Synthetic role', bands: [{ label: '', minYears: 2, maxYears: 5 }], sources: [{ name: '', url: 'bad' }], evidenceQuote: '', sourceDate: '' });
const mark = (label, id, body) => `BEGIN ${label} ${id}\n${body}\nEND ${label} ${id}`;
const expectedHub = [A, B].map(scanId => ({ scanId, prepared: { llmInputs: [{ spec: { url: `https://hub.example.test/${scanId}` } }] } }));
const priceItems = [A, B].map(itemId => ({ itemId, soldComps: [], activeComps: [] }));
const badPrice = itemId => ({ itemId, compSourceUrls: ['https://wrong.example.test'], compSources: ['wrong'], pricing: { market_summary: { sold_count: 3, active_count: 2 }, comp_breakdown: { anchor_count: 3, adjusted_count: 1, bound_count: 0 } } });

export const w4ReproCases = [
  { name: 'scoring strict', minimum: 2, call: () => jobs.validateJobScoringSubmission({ scores: [{ index: 0, matchScore: -1 }, { index: 1, matchScore: -1 }, { index: 2, matchScore: 80, requirementAssessments: [{ jobEvidence: '', status: 'direct', candidateEvidence: '' }] }] }, [{}, {}, {}], { requireComplete: true }) },
  { name: 'scoring structural', minimum: 2, call: () => jobs.validateJobScoringSubmission({ scores: [{ index: 0 }, { index: 0 }, { index: 9 }] }, [{}]) },
  { name: 'inventory', minimum: 2, call: () => scoring.normalizeScoringInventory({ requirements: [{ requirementText: '', priority: 'required', jobEvidence: 'Alpha duty one.' }, { requirementText: 'Beta', priority: 'required', jobEvidence: 'invented' }, { requirementText: 'Gamma', priority: 'required', jobEvidence: 'invented too' }] }, source) },
  { name: 'page evidence', minimum: 2, call: () => scoring.validateScoringPageEvidence({ assessments: [{ requirementId: 'wrong', status: 'direct' }, { requirementId: 'wrong-again', status: 'direct' }, { requirementId: 'three', status: 'direct', candidateEvidence: 'invented' }] }, inventory, { id: 'page-1', digest: 'd', text: 'ZQX-SENTINEL-CAREER Alpha career text.' }) },
  { name: 'synthesis', minimum: 2, call: () => scoring.composeScoringSynthesis({ matchScore: 80, confidence: 'high', assessments: [{ requirementId: 'one', status: 'not_documented', candidateEvidence: '' }, { requirementId: 'two', status: 'direct', candidateEvidence: 'invented' }, { requirementId: 'three', status: 'not_documented', candidateEvidence: '' }] }, inventory, inventory.map(row => ({ ...row, observations: [{ status: 'direct', candidateEvidence: 'Alpha career text.' }] }))) },
  { name: 'gap review', minimum: 2, call: () => jobsGap({ reviews: [{ index: 0, rows: [gapRow('wrong'), gapRow('wrong-again')] }] }) },
  { name: 'preference plan', minimum: 2, call: () => prefs.validateJobPreferencePlanSubmission({ ...plan(), softPreferences: [{ id: 'p1', criterion: 'Alpha role', category: 'role' }, { id: 'p2', criterion: 'alpha role', category: 'role' }, { id: 'p3', criterion: 'ALPHA ROLE', category: 'role' }], direction: { ...plan().direction, roleDirections: ['Missing role'] } }) },
  ...[true, false].map(requireComplete => ({ name: `listing v2 ${requireComplete}`, minimum: 2, call: () => prefs.validateJobPreferenceListingSubmission({ assessments: [listing(0), listing(1)] }, [{}, {}], plan(), { requireComplete, listingIds: ['ZQX-SENTINEL-LISTING-0', 'ZQX-SENTINEL-LISTING-1'] }) })),
  ...[true, false].map(requireComplete => ({ name: `listing legacy ${requireComplete}`, minimum: 2, call: () => prefs.validateLegacyJobPreferenceListingSubmission({ assessments: [{ index: 0, matches: [{ preferenceId: 'wrong', outcome: 'confirmed', evidenceQuote: '' }] }, { index: 1, matches: [] }] }, [{}, {}], plan(), { requireComplete }) })),
  { name: 'research single', minimum: 1, call: () => prefs.validateJobPreferenceResearchSubmission({ assessments: [{ preferenceId: 'p1', outcome: 'confirmed', evidenceQuote: 'invented', sourceUrls: [] }] }, { preferenceId: 'p1', groundedResearch: source }) },
  { name: 'research batch', minimum: 2, call: () => prefs.validateJobPreferenceResearchBatchSubmission({ assessments: [{ researchId: A, preferenceId: 'p1', outcome: 'confirmed', evidenceQuote: 'invented', sourceUrls: [] }, { researchId: B, preferenceId: 'p2', outcome: 'confirmed', evidenceQuote: 'invented', sourceUrls: [] }] }, { requests: [{ researchId: A, match: { preferenceId: 'p1' } }, { researchId: B, match: { preferenceId: 'p2' } }], groundedResearchById: sections }) },
  { name: 'consolidation', minimum: 2, call: () => consolidation.__locationConsolidationConfirmationForTests.validateConfirmation({ confirmations: [{ pairId: 'wrong', sameJob: true }, { pairId: '0:1', sameJob: 'yes' }] }, [{ id: '0:1' }, { id: '1:2' }]) },
  { name: 'lookup rows', minimum: 2, call: () => location.parseJobLocationLookupBatch(`${mark('JOB LOCATION LOOKUP', A, 'nothing')}\n${mark('JOB LOCATION LOOKUP', B, 'RESULT: FOUND')}`, [{ id: A }, { id: B }]) },
  { name: 'compensation single', minimum: 2, call: () => jobs.validateCompensationEvidenceSubmission([{ index: 0, comparableRanges: [range(), range()] }], ['USD'], source) },
  { name: 'compensation batch', minimum: 2, call: () => jobs.validateCompensationEvidenceBatchSubmission({ cohorts: [cohort(A), cohort(B)] }, requests, sections) },
  { name: 'compensation coverage', repro: 'R6', minimum: 1, call: () => jobs.validateCompensationEvidenceBatchSubmission({ cohorts: [{ researchId: A, assessments: [] }, { researchId: B, assessments: [{ index: 0, comparableRanges: [] }] }] }, requests, sections) },
  { name: 'ladder single', minimum: 2, call: () => jobs.validateRoleFamilyExperienceBandsSubmission(ladder(A), 'ZQX-SENTINEL-ROLE', source) },
  { name: 'ladder batch', minimum: 2, call: () => jobs.validateRoleFamilyExperienceBandsBatchSubmission({ ladders: [ladder(A), ladder(B)] }, [{ researchId: A, role: 'Synthetic role' }, { researchId: B, role: 'Synthetic role' }], sections) },
  { name: 'interview', minimum: 2, call: () => interview.validateInterviewBriefAssessment({ companyFacts: [{ fact: 'invented', evidenceQuote: '', sourceUrl: '', sourceDate: '' }, { fact: 'invented too', evidenceQuote: '', sourceUrl: '', sourceDate: '' }], recentContext: [], applicationPositioning: [{ documentKind: 'resume', point: 'invented', evidenceQuote: '' }] }, { rawResearch: source, bundle: { job: {}, listingText: '', digests: {}, applicationPositioning: { resume: 'ZQX-SENTINEL-APPLICATION' } }, snapshotId: 'x', canonicalJobUrl: 'https://example.test/job', bundleArtifactId: 'b', createdAt: '2026-01-01' }) },
  { name: 'price', minimum: 2, call: () => market.validateBatchPriceSynthesisSubmission({ items: priceItems.map(row => badPrice(row.itemId)) }, priceItems) },
  { name: 'hub', minimum: 2, call: () => hub.validateHubScanBatchSubmission({ platforms: [{ scanId: 'wrong', attention: [] }, { scanId: A, attention: 'bad' }] }, expectedHub) },
  { name: 'grounded text', minimum: 1, call: () => text.validateGroundedResearchText('') },
  { name: 'interview text', minimum: 1, call: () => interview.validateGroundedResearchText('') },
  { name: 'compensation sections', minimum: 2, call: () => jobs.parseCompensationResearchSections('Unwanted preface\nBEGIN COMPENSATION RESEARCH malformed', [A, B]) },
  { name: 'preference sections', minimum: 2, call: () => prefs.parseJobPreferenceResearchSections(`BEGIN RESEARCH foreign\ntext\nEND RESEARCH foreign`, [A, B]) },
  { name: 'lookup sections', minimum: 2, call: () => location.parseJobLocationLookupSections('Unwanted preface\nBEGIN JOB LOCATION LOOKUP malformed', [A, B]) },
  { name: 'taxonomy plan', minimum: 2, call: () => taxonomy.runBoundedJobTaxonomy([{ careerDirection: 'Alpha' }], { callText: async (_prompt, options) => { const value = { roleFamilies: ['Same', 'same'], salaryRanges: [{ minSalary: -1, maxSalary: 0 }, { minSalary: 0, maxSalary: 0 }], directionRoleIndexes: [{ direction: 'Foreign', roleIndex: 99 }] }; options.responseValidator(value); return value; } }) },
  { name: 'taxonomy chunk', minimum: 2, call: async () => {
    const list = Array.from({ length: 30 }, (_, i) => ({ title: `Synthetic ${i}`, careerDirection: `Direction ${i}` }));
    const directions = taxonomy.buildJobTaxonomyPlanSummary(list).commonSuggestedDirections;
    return taxonomy.runBoundedJobTaxonomy(list, { callText: async (_prompt, options) => { const value = options.task === 'job-taxonomy-plan' ? { roleFamilies: ['Other'], salaryRanges: [{ minSalary: 1, maxSalary: 0 }, { minSalary: 0, maxSalary: 0 }], directionRoleIndexes: directions.map(row => ({ direction: row.direction, roleIndex: 0 })) } : { roleByIndex: [999, 'wrong', 999] }; options.responseValidator(value); return value; } });
  } },
];
function jobsGap(value) { return prefsGap(value); }
function prefsGap(value) { return gapValidator(value, [{ index: 0, jobText: 'Alpha duty one.', rows: [{ id: 'r1', priority: 'required' }, { id: 'r2', priority: 'required' }] }]); }

export async function captureW4Failure(spec) {
  try { await spec.call(); } catch (error) { return error; }
  throw new Error(`${spec.name}: malformed fixture unexpectedly accepted`);
}
const legacy = JSON.parse(readFileSync(new URL('./fixtures/validator-corrections/legacy.json', import.meta.url), 'utf8'));
export default [
  { name: 'W4 correction formatter groups in scan order, caps entities and rules, and rejects unknown templates', run: () => {
    const c = lines.collector(); c.add('a', 'first'); c.add('b', 'second'); c.add('a', 'third');
    const rendered = c.render({ a: 'Rule {ids}; value {value}', b: 'Other {ids}; {"scores":[]}' }).problems;
    assert(rendered.length === 2 && rendered[0].line.includes('[first, third]') && rendered[1].line.includes('{"scores":[]}'), 'groups aggregate with literal JSON fragments intact');
    for (const templates of [{}, { a: '{absent}', b: 'b' }]) { let error; try { c.render(templates); } catch (e) { error = e; } assert(error instanceof TypeError, 'unknown rule or placeholder fails loudly'); }
    const many = lines.collector(); for (let i = 0; i < 20; i++) many.add(`r${i}`, i);
    assert(many.render(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`r${i}`, 'Rule {ids}']))).problems.length === 12, 'twelve groups maximum');
    const q = lines.quoted("a'b\n" + 'x'.repeat(200));
    assert(!q.includes("'") && JSON.parse(q).length === 80 && !q.includes('\n'), 'own values bounded before JSON quoting');
    const bracketed = lines.bracket(Array.from({ length: 20 }, (_, i) => 'a'.repeat(35) + i));
    assert(bracketed.length <= 122 && bracketed.includes('more'), 'bounded entity list includes omitted count');
  } },
  { name: 'W4 all templates obey the line grammar and retain stable distinct cause keys without metadata', run: () => {
    const allKeys = new Map();
    for (const [id, template] of Object.entries(lines.VALIDATION_TEMPLATES)) {
      assert(!template.includes("'") && template.length <= 260, `${id}: safe fixed sentence`);
      const render = (variant) => {
        const c = lines.collector();
        for (let i = 0; i < 20; i++) c.add(id, variant === 1 ? 'a'.repeat(24) + i : 'b'.repeat(24) + i, { value: variant === 1 ? 'own answer one' : 'different answer', raw: variant * 123, list: [variant === 1 ? 'aa' : 'bb'] });
        return c.render({ [id]: template }, { total: variant * 7, max: variant * 8, expected: variant * 2, families: variant * 9, familyMax: variant * 8, label: 'COMPENSATION RESEARCH' }).problems[0].line;
      };
      const one = render(1), two = render(2);
      assert(!one.includes("'") && one.length <= 600, `${id}: rendered bound`);
      const key = causeKeys('VALIDATION_FAILED', null, [one])[0];
      assert(key === causeKeys('VALIDATION_FAILED', null, [two])[0], `${id}: own values and numbers cannot evade same-rule counting`);
      assert(!allKeys.has(key), `${id} collides with ${allKeys.get(key)}`); allKeys.set(key, id);
    }
    for (const area of [jobs, scoring, prefs, taxonomy, location, consolidation, interview, market, hub, text, officialPosting]) {
      const maps = Object.entries(area).filter(([name]) => name.endsWith('_CORRECTION_TEMPLATES'));
      assert(maps.length > 0 && maps.every(([, map]) => Object.isFrozen(map)), 'each area exports frozen templates');
    }
  } },
  { name: 'W4 ladder diagnosis agrees with the existing truth gate including numeric coercion', run: () => {
    const samples = [null, [], [{ label: 'all', minYears: 0, maxYears: 99 }], [{ label: 'all', minYears: '0', maxYears: '99' }], [{ label: '', minYears: 0, maxYears: 99 }], [{ label: 'a', minYears: 0, maxYears: 4 }, { label: 'b', minYears: 6, maxYears: 99 }], [{ label: 'a', minYears: 1, maxYears: 99 }], [{ label: 'a', minYears: 0, maxYears: 98 }], [{ label: 'a', minYears: 0.1, maxYears: 99 }]];
    const expected = [false, false, true, true, false, false, false, false, false];
    for (const [i, bands] of samples.entries()) assert((diagnoseCompensationExperienceBandLadder(bands).length === 0) === expected[i] && isValidCompensationExperienceBandLadder(bands) === expected[i], 'same legacy truth values, including numeric coercion');
  } },
  { name: 'W4 section teaching respects parser leniency and trims compensation marker lines', run: () => {
    const marked = mark('COMPENSATION RESEARCH', A, 'Synthetic evidence').split('\n').map(line => '  ' + line + '  ').join('\n');
    assert(jobs.parseCompensationResearchSections(marked, [A]).has(A), 'marker whitespace is permitted');
    const research = 'A harmless preface\n' + mark('RESEARCH', A, 'Synthetic evidence') + '\nConclusion';
    assert(prefs.parseJobPreferenceResearchSections(research, [A]).has(A), 'preference prose remains presentation only');
    assert(lines.diagnoseMarkedSections(research, { expectedIds: [A], label: 'RESEARCH', outsideTextAllowed: true, ordered: true, caseInsensitive: false }).length === 0, 'no false preface guidance');
  } },
  { name: 'W4 ladder correction entities retain cohort identity when grouping bands', run: async () => {
    const error = await captureW4Failure(w4ReproCases.find(spec => spec.name === 'ladder batch'));
    assert(error.correctionDetails.find(line => line.startsWith('bands ')).includes(A + ':bands.0'), 'band index must retain the researchId namespace');
  } },
  ...w4ReproCases.map(spec => ({ name: `W4 repro ${spec.repro || 'R2'}: ${spec.name} reports all violated rules without changing its first legacy failure`, run: async () => {
    const error = await captureW4Failure(spec);
    const before = legacy[spec.name];
    assert(error.message === before.message && (error.code ?? null) === before.code && JSON.stringify(error.validationDiagnostic ?? null) === JSON.stringify(before.diagnostic), `${spec.name}: legacy error fields changed`);
    assert(Array.isArray(error.correctionDetails) && error.correctionDetails.length >= spec.minimum && error.correctionDetails.length <= 12, `${spec.name}: expected distinct aggregated correction rules, got ${JSON.stringify(error.correctionDetails)}`);
    assert(error.correctionRuleIds.length === error.correctionDetails.length && new Set(error.correctionRuleIds).size === error.correctionRuleIds.length, 'one line per rule, ids parallel and distinct');
    assert(error.correctionDetails.every(line => !line.includes('ZQX-SENTINEL-')), 'corrections never disclose expected source strings');
  } })),
  { name: 'W4 repro R5: taxonomy hidden range rules are stated in the builder', run: () => {
    const prompt = taxonomy.buildJobTaxonomyPlanPrompt({});
    assert(prompt.includes('Unspecified entry (minSalary=0, maxSalary=0) LAST') && prompt.includes('must equal the minSalary of the range listed just before it'), 'taxonomy builder must teach the exact ordering and contiguity rules');
  } },
  { name: 'W4 repro R5: display-only suffixes teach their hidden validator rules', run: () => {
    for (const [name, phrase, count] of [['COMPENSATION_SECTION_FORMAT_SUFFIX', 'nothing outside', 5], ['ROLE_FAMILY_LADDER_SUFFIX', 'whole numbers', 2], ['COHORT_PROVENANCE_SUFFIX', 'at least 8 characters', 1]]) {
      assert(typeof jobs[name] === 'string' && jobs[name].includes(phrase), `${name} must expose its rule`);
      const sourceText = readFileSync(new URL('../../electron/ipc/jobs.js', import.meta.url), 'utf8');
      assert(sourceText.split(`displayOnlyPromptSuffix: ${name}`).length - 1 === count, `${name} must be wired at every v2 call site`);
    }
  } },
];
