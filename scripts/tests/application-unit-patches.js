import { __setLocalAiRenderPdfForTests, __setApplicationV2PagePngForTests, w5Policy, w5Limits, w5Findings as findingsApi, w5CoverChecks as checks, w5Careers, w5UnitResume, w5AuthorityKit, validateStructuredApplicationResume, __pasteFailedCheckErrorsForTests, __pasteUnitGroundingErrorsForTests, __validateAuthorityResumeArtifactsForTests } from '../test-dependencies.js';
import nodeAssert from 'node:assert/strict';
import { assert, fs, path, currentAuthorityFlowKit, getLocalApplicationHandoff, submitLocalApplicationHandoff } from '../test-dependencies.js';

const { createCanvasProject, queueDiscardFixture, listingCoverageFields, listingSemanticAuditFields, atomicReplaceJson, sha256, canonicalJson } = currentAuthorityFlowKit;
const clone = value => structuredClone(value);
const contextOf = handoff => JSON.parse(handoff.prompt.slice(handoff.prompt.lastIndexOf('\n\nAuthoritative context:\n') + '\n\nAuthoritative context:\n'.length));
const envelope = (queued, handoff, fields) => JSON.stringify({ protocol: 1, jobId: queued.id, stage: handoff.stage, handoffCode: handoff.handoffCode, baseHashes: handoff.baseHashes, ...fields });

function documents(evidenceId) {
  const evidenceIds = [evidenceId];
  return {
    resume: { name: 'Ada Lovelace', contact: 'ada@example.test', roles: [{ id: 'role-acme', title: 'Engineer', company: 'Acme', dates: '', bullets: [
      { id: 'b-1', text: 'Built reliable services.', evidenceIds }, { id: 'b-2', text: 'Delivered a synthetic unsupported outcome.', evidenceIds },
    ] }], projects: [], skills: [], education: [], credentials: [] },
    coverLetter: { name: 'Ada Lovelace', contact: 'ada@example.test', roleThesis: 'My prior work is relevant to the role.',
      coverLetterArgument: { primaryEvidence: { evidence: 'Built reliable services.', evidenceRole: 'Engineer at Acme', relationToThesis: 'The prior delivery supports the thesis.' } },
      paragraphs: [
        { id: 'p-1', text: 'My synthetic first paragraph makes a claim.', evidenceIds },
        { id: 'p-2', text: 'My synthetic second paragraph makes a claim.', evidenceIds },
        { id: 'p-3', text: 'My synthetic third paragraph makes a claim.', evidenceIds },
      ] },
  };
}

async function withSeededJob({ stage = 'verify-correction', corrections = ['unit-source-grounding: Cover-letter paragraph "p-3": synthetic unsupported claim.'], configure = () => {} } = {}, run) {
  const project = await createCanvasProject();
  try {
    const queued = await queueDiscardFixture(project), args = { jobId: queued.id, canvasFilePath: project.canvasFilePath };
    let handoff = (await getLocalApplicationHandoff(args)).handoff, context = contextOf(handoff);
    const quote = context.requirementsProgress.sourceCoverage.units.find(unit => unit.text.includes('reliable system delivery')).text;
    const evidence = [{ id: 'p1-e1', quote, requirement: 'Reliable system delivery', priority: 'high' }];
    const requirements = [{ id: 'p1-r1', text: 'Reliable system delivery', priority: 'high', evidenceIds: ['p1-e1'] }];
    const discovered = await submitLocalApplicationHandoff({ ...args, handoffCode: handoff.handoffCode,
      response: envelope(queued, handoff, { storeDigest: context.authorityStore.digest, complete: true, identity: context.trustedIdentity,
        evidence, requirements, ...listingCoverageFields(context, evidence, requirements) }) });
    assert(discovered.accepted, `seed discovery: ${JSON.stringify(discovered.validationErrors)}`);
    handoff = discovered.handoff;
    while (handoff.stage === 'requirements-audit') {
      context = contextOf(handoff);
      const audited = await submitLocalApplicationHandoff({ ...args, handoffCode: handoff.handoffCode,
        response: envelope(queued, handoff, listingSemanticAuditFields(context, evidence, requirements)) });
      assert(audited.accepted, `seed independent audit: ${JSON.stringify(audited.validationErrors)}`); handoff = audited.handoff;
    }
    assert(handoff.stage === 'write', 'real v2 job reaches the writer before seeding');
    const catalogIds = [...handoff.prompt.matchAll(/\[(host\.career\.[^\]\s]+)\]/gu)].map(match => match[1]);
    assert(catalogIds.length, 'source ids come from the real writer hand');
    const docs = documents(catalogIds.find(id => id.includes('achievement')) || catalogIds[0]);
    const file = path.join(queued.folder, 'manifest.json');
    const manifest = JSON.parse(await fs.promises.readFile(file, 'utf8')), work = manifest.paste.writeVerify;
    manifest.paste.stage = stage; work.ordinal = 0; work.lastCorrections = corrections;
    Object.assign(work.candidates[0], { status: stage === 'fit-correction' ? 'fit-correcting' : 'correcting', corrections: 1, fitCorrections: 0,
      rejections: [], plainText: 'Synthetic writer draft.', structured: docs });
    configure({ manifest, work, docs, catalogIds });
    await atomicReplaceJson(file, manifest);
    const read = () => fs.promises.readFile(file, 'utf8').then(JSON.parse);
    const submit = async fields => {
      const current = (await getLocalApplicationHandoff(args)).handoff;
      return submitLocalApplicationHandoff({ ...args, handoffCode: current.handoffCode, response: envelope(queued, current, fields) });
    };
    // Prove the manifest seed is accepted by the real reader before testing patches.
    assert((await getLocalApplicationHandoff(args)).handoff.stage === stage, 'hand-edited candidate state survives the real frozen-state reader');
    await run({ project, queued, args, docs, submit, read, catalogIds, file });
  } finally { await fs.promises.rm(project.root, { recursive: true, force: true }); }
}

const unitApi = () => import('../../electron/ipc/applicationUnitPatches.js');
const pureOptions = (docs, api, extra = {}) => ({ registry: api.applicationUnitRegistry(docs), open: api.applicationUnitRegistry(docs).rows.map(row => row.id),
  argumentMatches: (evidence, bullet) => !!evidence && (evidence === bullet || bullet.includes(evidence)), roleLabel: role => `${role.title} at ${role.company}`, ...extra });
const pureTests = [
  { name: 'W5 registry: shared kinds cover both documents and pseudo-units in stable order', run: async () => {
    const api = await unitApi(), docs = documents('e-career'), registry = api.applicationUnitRegistry(docs);
    nodeAssert.deepEqual(registry.rows.map(row => row.id), ['b-1', 'b-2', 'p-1', 'p-2', 'p-3', '@roleThesis', '@argument.primary']);
    nodeAssert.deepEqual(registry.errors, []);
    for (const mutate of [d => { d.coverLetter.paragraphs[0].id = 'b-1'; }, d => { d.resume.roles[0].bullets[0].id = ''; }, d => { d.resume.roles[0].bullets[0].id = '@forged'; }, d => { delete d.coverLetter.roleThesis; }, d => { delete d.coverLetter.coverLetterArgument.primaryEvidence; }, d => { d.coverLetter.paragraphs[0] = null; }]) {
      const bad = clone(docs); mutate(bad); assert(api.applicationUnitRegistry(bad).errors.length, 'ambiguous or missing units select document mode');
    }
    assert(api.applicationUnitRegistry({ resume: { roles: [{ id: 'r', bullets: [] }] }, coverLetter: { paragraphs: [] } }).errors.length, 'minimal documents return registry errors without throwing');
    assert(api.structuredDocumentDigest({ ...docs, resume: { ...docs.resume, name: 'Another synthetic name' } }) !== api.structuredDocumentDigest(docs), 'whole-document digest includes non-unit fields');
  } },
  ...['dispatch', 'laboratory', 'library'].map(domain => ({ name: `W5 merge: one ${domain} unit changes and every other unit stays byte-identical`, run: async () => {
    const api = await unitApi(), docs = documents('e-career'), original = clone(docs);
    const result = api.mergeUnitPatches(docs, [{ unit: 'p-3', op: 'set', fields: { text: `Revised synthetic ${domain} statement.` } }], pureOptions(docs, api, { open: ['p-3'] }));
    nodeAssert.deepEqual(result.errors, []); nodeAssert.deepEqual(result.changed, ['p-3']); nodeAssert.deepEqual(docs, original);
    for (const row of api.applicationUnitRegistry(docs).rows.filter(row => row.id !== 'p-3')) nodeAssert.deepEqual(api.applicationUnitRegistry(result.documents).rows.find(next => next.id === row.id), row);
  } })),
  ...[
    ['shape', [], /patches is not a non-empty array/],
    ['shape-entry', [{ unit: 'p-3', op: 'set', fields: {}, extra: true }], /is not an object/],
    ['unknown', [{ unit: 'unknown', op: 'remove' }], /names unit "unknown"/],
    ['settled', [{ unit: 'b-1', op: 'set', fields: { text: 'Changed.' } }], /settled.*p-3/],
    ['duplicate', [{ unit: 'p-3', op: 'remove' }, { unit: 'p-3', op: 'remove' }], /both name unit "p-3"/],
    ['field', [{ unit: 'p-3', op: 'set', fields: { name: 'Bad field' } }], /sets field "name"/],
    ['value', [{ unit: 'p-3', op: 'set', fields: { evidenceIds: [] } }], /non-empty array/],
    ['no-op', [{ unit: 'p-3', op: 'set', fields: { text: documents('e-career').coverLetter.paragraphs[2].text } }], /already equal/],
  ].map(([name, patches, message]) => ({ name: `W5 merge refuses ${name} without partial application`, run: async () => {
    const api = await unitApi(), docs = documents('e-career'), result = api.mergeUnitPatches(docs, patches, pureOptions(docs, api, { open: ['p-3'] }));
    assert(result.errors.some(error => error.text.startsWith('unit-patch: ') && message.test(error.text)), `${name}: ${JSON.stringify(result.errors)}`); nodeAssert.deepEqual(result.documents, docs);
  } })),
  { name: 'W5 merge: all errors are returned, floors hold, and known-bad unit state is refused', run: async () => {
    const api = await unitApi(), docs = documents('e-career');
    const errors = api.mergeUnitPatches(docs, [{ unit: 'unknown', op: 'remove' }, { unit: 'p-3', op: 'set', fields: { text: ' ' } }], pureOptions(docs, api));
    assert(errors.errors.length === 2 && errors.documents === docs, 'all-or-nothing collection');
    const one = clone(docs); one.resume.roles[0].bullets.pop(); one.coverLetter.paragraphs = [one.coverLetter.paragraphs[0]];
    for (const id of ['b-1', 'p-1', '@roleThesis', '@argument.primary']) assert(api.mergeUnitPatches(one, [{ unit: id, op: 'remove' }], pureOptions(one, api)).errors.length, 'last required unit cannot be removed');
    const revised = clone(docs); revised.coverLetter.paragraphs[2].text = 'Known bad synthetic text.';
    const row = api.applicationUnitRegistry(revised).rows.find(row => row.id === 'p-3');
    const result = api.mergeUnitPatches(docs, [{ unit: 'p-3', op: 'set', fields: { text: row.fields.text } }], pureOptions(docs, api, { knownBad: { 'p-3': [{ digest12: api.unitDigest(row).slice(0, 12), checkId: 'unit-source-grounding', round: 1 }] } }));
    assert(result.errors.some(error => error.text.includes('already held when check')), 'class-U repetition has a check-specific refusal');
  } },
  { name: 'W5 argument binding: a broken binding follows its bullet, compatible text stays, and removals can rebind atomically', run: async () => {
    const api = await unitApi(), docs = documents('e-career');
    const moved = api.mergeUnitPatches(docs, [{ unit: 'b-1', op: 'set', fields: { text: 'Maintained the synthetic service fleet.' } }], pureOptions(docs, api));
    assert(!moved.errors.length && moved.documents.coverLetter.coverLetterArgument.primaryEvidence.evidence === 'Maintained the synthetic service fleet.', 'host mechanically follows a changed bound bullet');
    const compatible = api.mergeUnitPatches(docs, [{ unit: 'b-1', op: 'set', fields: { text: docs.resume.roles[0].bullets[0].text + ' More detail.' } }], pureOptions(docs, api));
    assert(compatible.documents.coverLetter.coverLetterArgument.primaryEvidence.evidence === docs.coverLetter.coverLetterArgument.primaryEvidence.evidence, 'still-matching evidence stays byte-identical');
    const refused = api.mergeUnitPatches(docs, [{ unit: 'b-1', op: 'remove' }], pureOptions(docs, api)); assert(refused.errors.some(error => error.text.includes('bound to')), 'bound bullet cannot disappear alone');
    const rebound = api.mergeUnitPatches(docs, [{ unit: 'b-1', op: 'remove' }, { unit: '@argument.primary', op: 'set', fields: { bullet: 'b-2' } }], pureOptions(docs, api));
    assert(!rebound.errors.length && rebound.documents.coverLetter.coverLetterArgument.primaryEvidence.evidence === docs.resume.roles[0].bullets[1].text && rebound.documents.coverLetter.coverLetterArgument.primaryEvidence.evidenceRole === 'Engineer at Acme', 'one answer can rebind and remove');
    assert(api.openUnits({ tier: 'content', registry: api.applicationUnitRegistry(docs), findings: [{ scope: 'unit', units: ['b-1'], implicated: [] }], argumentBindings: { primary: 'b-1' } }).includes('@argument.primary'), 'open bound bullet opens the slot');
  } },
  { name: 'W5 fit patches: strings cannot grow, item arrays keep order, and every failing document must shrink', run: async () => {
    const api = await unitApi(), docs = documents('e-career'); docs.resume.skills = [{ id: 's-1', group: 'Tools', items: ['Alpha', 'Beta', 'Gamma'], evidenceIds: ['e-career'] }];
    const opts = pureOptions(docs, api, { shortenOnly: true, open: ['b-1', 's-1', '@argument.primary'] });
    for (const patch of [{ unit: 'b-1', op: 'set', fields: { text: docs.resume.roles[0].bullets[0].text + ' Longer.' } }, { unit: 's-1', op: 'set', fields: { items: ['Gamma', 'Alpha'] } }, { unit: 's-1', op: 'set', fields: { evidenceIds: ['e-other'] } }]) assert(api.mergeUnitPatches(docs, [patch], opts).errors.length, 'fit length or ordered subset rule refuses the patch');
    const shorter = api.mergeUnitPatches(docs, [{ unit: 's-1', op: 'set', fields: { items: ['Alpha', 'Gamma'] } }], opts); assert(!shorter.errors.length, 'ordered subset removes rendered characters');
    const removed = api.mergeUnitPatches(docs, [{ unit: 's-1', op: 'remove' }], opts); assert(!removed.errors.length && removed.removed.includes('s-1'), 'removing an optional unit shrinks the document');
  } },
];

const locatorTests = [
  { name: 'W5 locator: real figure-discipline messages name every paragraph holding an absent figure', run: async () => {
    const api = await unitApi(), docs = documents('e1'), registry = api.applicationUnitRegistry(docs);
    const row = checks.checkFigureDiscipline(['The synthetic fleet served 17 regions.', 'The archive held 29 cards.'], {});
    const errors = __pasteFailedCheckErrorsForTests([row]);
    assert(errors.length && !row.passed, 'real gate produces a figure finding');
    const located = findingsApi.locateGateFindings({ errors, documents: docs, registry });
    const shared = ['A synthetic fleet served 17 regions.', 'The archive retained its cards.'];
    assert(checks.checkFigureDiscipline(shared, {}, null, { citations: [[], ['The fleet served 17 regions.']] }).passed, 'another paragraph cited quote can license a figure');
    assert(!checks.checkFigureDiscipline(shared, {}, null, { citations: [[], []] }).passed, 'removing that citation can reopen a settled paragraph');
    nodeAssert.deepEqual(located.map(row => row.units), [['p-1', 'p-2']]); assert(located[0].scope === 'unit-context', 'figures also depend on other paragraphs citations');
  } },
  { name: 'W5 locator: structured offenses keep all unit ids beyond the display offender cap', run: async () => {
    const api = await unitApi(), docs = documents('career-proof');
    const resume = { schemaVersion: 'structured-resume.v1', identity: { name: 'Ada Lovelace', contact: ['ada@example.test'] },
      roles: [{ id: 'role-1', title: 'Engineer', company: 'Acme', dates: '', location: '', bullets: [{ id: 'b-1', text: 'Built reporting systems.', evidenceIds: ['career-proof'] }] }],
      skills: Array.from({ length: 20 }, (_, i) => ({ id: `skills-${i}`, group: `Expert Specialty ${i}`, items: ['JavaScript'], evidenceIds: ['career-proof'] })),
    };
    let error; try { validateStructuredApplicationResume(resume, { sourceRoles: [{ id: 'role-1', title: 'Engineer', company: 'Acme', dates: '', location: '' }],
      evidenceCatalog: [{ id: 'career-proof', sourceId: 'career-data', quote: 'Built JavaScript reporting systems that reduced manual work.' }],
      careerData: 'Ada Lovelace\nada@example.test\n## Acme\nEngineer\n\nBuilt JavaScript reporting systems that reduced manual work.' }); } catch (caught) { error = caught; }
    assert(error?.checks?.length, 'real structured gate produces offenses'); docs.resume = resume;
    const errors = error.checks.map(row => `${row.id}: ${row.detail}`), located = findingsApi.locateGateFindings({ errors, documents: docs, registry: api.applicationUnitRegistry(docs) });
    const level = located.find(row => row.checkId === 'skill-group-label-claims-a-level');
    nodeAssert.deepEqual(level?.units, resume.skills.map(row => row.id));
    assert(located.length === errors.length, 'one finding per error segment');
  } },
  { name: 'W5 locator: evidence-grounding paths never locate the paragraph mentioned as a negative explanation', run: async () => {
    const api = await unitApi(), docs = documents('e1');
    const row = checks.checkEvidenceGrounding({ mappings: [{ evidence: 'Unrelated synthetic source evidence entirely distinct.' }] }, { bulletTexts: ['Built reliable services for local customers.'] });
    const errors = __pasteFailedCheckErrorsForTests([row]), located = findingsApi.locateGateFindings({ errors, documents: docs, registry: api.applicationUnitRegistry(docs) });
    assert(errors.length && errors[0].includes('not cover-letter paragraph'), 'real evidence gate explains the non-rendered mapping');
    nodeAssert.deepEqual(located[0].units, ['@argument.primary']); assert(located[0].scope === 'field', 'argument source path wins by check-id dispatch');
  } },
  { name: 'W5 locator: real company and unit-grounding errors map across three unrelated synthetic careers', run: async () => {
    const api = await unitApi();
    for (const career of w5Careers) {
      const docs = documents('e1'), registry = api.applicationUnitRegistry(docs);
      const company = checks.checkTargetCompanyBinding(["I would bring my practice to Other Company's platform team."], career.role.employer, ['Prior Employer']);
      const rows = findingsApi.locateGateFindings({ errors: __pasteFailedCheckErrorsForTests([company]), documents: docs, registry });
      nodeAssert.deepEqual(rows[0]?.units, ['p-1']);
      for (const [unitLabel, unitId, label] of [['Resume bullet', 'b-1', 'resumeBullets'], ['Cover-letter paragraph', 'p-1', 'coverLetterParagraphs']]) {
        const errors = __pasteUnitGroundingErrorsForTests({ unitLabel, unitId, label, finalText: 'I led 900 experts at NebulaCorp.',
          evidenceIds: ['e1'], acceptedEvidence: [{ id: 'e1', sourceId: 'career-data', quote: career.bullet }], identityTokens: [], targetTitle: '', targetCompany: '' });
        assert(errors.length, 'real grounding rejects invented ownership and figures');
        assert(findingsApi.locateGateFindings({ errors, documents: docs, registry }).every(row => row.units.includes(unitId)), 'all grounding observations retain their unit');
      }
      const kit = w5AuthorityKit(career), resume = w5UnitResume(career); resume.roles[0].bullets[0].evidenceIds = ['unknown']; resume.projects[0].evidenceIds = ['unknown'];
      const errors = __validateAuthorityResumeArtifactsForTests(resume, kit.acceptedEvidence, kit.authority, kit.sourceRoles);
      docs.resume = resume;
      const located = findingsApi.locateGateFindings({ errors: [errors.join(' ')], documents: docs, registry: api.applicationUnitRegistry(docs) });
      assert(located[0].units.includes('bullet-1') && located[0].units.includes('project-1'), `joined authority errors name both units: ${errors.join(' ')}`);
    }
  } },
  { name: 'W5 locator: quoted paragraph ordinals stay content, dash location recomputes, and completion records stay total', run: async () => {
    const api = await unitApi(), docs = documents('e1');
    const quote = String.fromCharCode(8220) + 'paragraph 3' + String.fromCharCode(8221);
    const errors = [`Local AI cover letter failed required checks: target-company-binding: paragraph 1 says ${quote} | ended-role-current-employment: paragraph 2 claims current work`];
    const located = findingsApi.locateGateFindings({ errors, documents: docs, registry: api.applicationUnitRegistry(docs) });
    nodeAssert.deepEqual(located.map(row => row.units), [['p-1'], ['p-2']]); assert(located.length === 2, 'joined error segments are never dropped');
    docs.resume.roles[0].bullets[0].text += String.fromCharCode(8212) + 'a clause'; docs.coverLetter.paragraphs[2].text += '; another clause';
    const dash = findingsApi.locateGateFindings({ errors: ['candidate-dash-punctuation: candidate copy contains an em dash.'], documents: docs, registry: api.applicationUnitRegistry(docs) });
    nodeAssert.deepEqual(dash[0].units, ['b-1', 'p-3']);
    const clean = documents('e1');
    assert(findingsApi.locateGateFindings({ errors: ['candidate-dash-punctuation: host copy contains an em dash.'], documents: clean, registry: api.applicationUnitRegistry(clean) })[0].scope === 'document', 'host-only marks never invent an editable target');
    const message = 'Local AI qualityReview.sourceGrounding.coverLetterParagraphs[1] (cover-letter paragraph 2) is invalid.';
    const completion = findingsApi.locateGateFindings({ errors: [message], documents: clean, registry: api.applicationUnitRegistry(clean), meta: { [message]: { repairs: ['coverLetter:rendered'] } } });
    nodeAssert.deepEqual(completion[0].units, ['p-2']);
    const authored = findingsApi.locateGateFindings({ errors: ['Synthetic completion field failed.'], documents: clean, registry: api.applicationUnitRegistry(clean), meta: { 'Synthetic completion field failed.': { repairs: ['coverLetter:authored'] } } });
    nodeAssert.deepEqual(authored[0].units, ['@roleThesis', '@argument.primary']);
  } },
  { name: 'W5 locator: real transfer, thesis, target-scope and technology-role failures map to their exact units', run: async () => {
    const api = await unitApi(), docs = documents('e1'), registry = api.applicationUnitRegistry(docs);
    const evidence = { bulletTexts: ['Built a cold-chain integration that raised temperature alerts and flagged recalled lots.'] };
    const posting = 'Northgate Care and Learning runs residential homes and community classes across the region. This engineer joins the platform team that keeps stock counting, resident scheduling, and learner attendance records accurate for site managers. You will design web workflows that let managers see shortages early, plan rotas, and confirm who attended each session. We value clear reporting, careful access control, and software that front-line staff can trust during a busy shift.';
    const targetText = "For this role's attendance reporting, I would bring experience building temperature alerts and recalled lots flagging in web workflows.";
    const cases = [
      [checks.checkRoleThesis({ roleThesis: '' }), ['@roleThesis']],
      [checks.checkTargetClaimScope({ roleThesis: targetText }, [], evidence, posting), ['@roleThesis']],
      [checks.checkTargetClaimScope({}, [targetText], evidence, posting), ['p-1']],
      [checks.checkContainerizationTechnologyRoles(['I containerized the simulation pipeline using Slurm.'], { bulletTexts: ['Containerized the simulation pipeline in Apptainer images, submitting each run through Slurm.'] }), ['p-1']],
      [checks.checkEndedRoleCurrentEmployment(['As an Engineer at Acme, I build reliable services.'], { roles: [{ title: 'Engineer', company: 'Acme', dates: 'January 2018 to December 2020' }] }, '2026-10-23'), ['p-1']],
      [checks.checkTransferBenefitSupport(['The role needs steady work.', 'My tracking practice grew from the desk. I built a tracking sheet that grouped every request by owner. Tracking at that level gives fault-tolerant request handling.'], { citations: [[], []], jobText: '' }), ['p-2']],
    ];
    for (const [check, ids] of cases) {
      assert(!check.passed, `real ${check.id} gate fails: ${check.detail}`);
      const errors = __pasteFailedCheckErrorsForTests([check]), findings = findingsApi.locateGateFindings({ errors, documents: docs, registry });
      nodeAssert.deepEqual(findings[0].units, ids); assert(findings.length === errors.length, 'each real error segment has one finding');
    }
    docs.resume.projects = [{ id: 'project-1', name: 'Synthetic', description: 'Synthetic project.', evidenceIds: ['e1'] }];
    const pairs = findingsApi.locateGateFindings({ errors: ['Resume role role-acme bullet b-1 duplicates project project-1.'], documents: docs, registry: api.applicationUnitRegistry(docs) });
    nodeAssert.deepEqual(pairs[0].units, ['b-1', 'project-1']); assert(pairs[0].scope === 'cross', 'duplicate pair opens both units');
  } },
  { name: 'W5 inventory: every actual gate and named source has a scope and promotion of an advisory fails closed', run: () => {
    nodeAssert.deepEqual(findingsApi.gateFindingInventoryErrors(), []);
    assert(findingsApi.gateFindingInventoryErrors({ letter: { ...checks.CHECK_DISPOSITIONS, 'figure-count': 'gate' } }).some(error => error.includes('figure-count')), 'promoting an uninventoried check requires an explicit scope');
    assert(findingsApi.gateFindingInventoryErrors({ inventory: { ...findingsApi.GATE_FINDING_SCOPES, invented: { scope: 'unit' } } }).some(error => error.includes('Unknown')), 'inventory is total in the other direction');
    assert(findingsApi.GATE_FINDING_SCOPES['paragraph-argument-links'].unreachable.includes('generationAudit'), 'unreachable rule carries its reason');
  } },
];

const promptTests = [
  { name: 'W5 prompts: bootstrap and persisted unit state give the same patch instructions and verbatim corrections', run: async () => {
    const docs = documents('e1'), state = w5Policy.initialWriteVerifyState(), corrections = ['unit-source-grounding: Cover-letter paragraph "p-3": synthetic claim.'];
    Object.assign(state.candidates[0], { structured: docs, status: 'correcting' });
    const args = { stage: 'verify-correction', state, sourcePrompt: 'Synthetic source.', envelope: { protocol: 1 }, corrections };
    const prompt = w5Policy.writeVerifyPrompt(args);
    assert(prompt.includes('[p-3] OPEN (unit-source-grounding)') && prompt.includes('[b-1] settled'), 'the current open set is explicit');
    assert(prompt.includes('UNITS OPEN THIS ROUND: p-3.') && !prompt.includes('production shapes'), 'patch output replaces the complete document format');
    assert(corrections.every(item => prompt.includes(item)), 'runner never needs to append a conflicting complete-response instruction');
    const api = await unitApi(); assert(prompt.includes(JSON.stringify(api.UNIT_PATCH_SCHEMA)), 'full patch envelope schema is printed');
    assert(prompt.includes('"protocol":{"const":1}'), 'schema echoes the actual shipped numeric protocol');
    state.candidates[0].unitState = findingsApi.bootstrapApplicationUnitState({ documents: docs, corrections, status: 'correcting' });
    nodeAssert.deepEqual(w5Policy.writeVerifyPrompt(args), prompt);
    assert(w5Policy.WRITE_VERIFY_BRIEF.length <= 970, 'writer brief budget remains fixed');
    const convert = w5Policy.writeVerifyPrompt({ ...args, stage: 'convert' });
    assert(convert.includes(corrections[0]) && !w5Policy.writeVerifyPrompt({ ...args, stage: 'convert', corrections: [] }).includes(corrections[0]), 'convert teaches only present corrections');
    const large = clone(docs); large.resume.roles[0].bullets = Array.from({ length: 40 }, (_, i) => ({ id: `b${i}`, text: 'Synthetic statement. '.repeat(20), evidenceIds: ['e1'] }));
    state.candidates[0].structured = large; delete state.candidates[0].unitState;
    assert(w5Policy.writeVerifyPrompt({ ...args, sourcePrompt: 'Synthetic source. '.repeat(5000) }).length < w5Limits.chatPromptChars / 2, 'large synthetic patch prompt stays below half the existing ceiling');
    delete state.candidates[0].structured;
    nodeAssert.throws(() => w5Policy.writeVerifyPrompt(args), /requires current structured/);
  } },
  { name: 'W5 prompts: fit measurements and fact recheck session keys stay scoped to their existing budgets', run: () => {
    const docs = documents('e1'), state = w5Policy.initialWriteVerifyState();
    Object.assign(state.candidates[0], { structured: docs, status: 'fit-correcting' });
    const unitState = findingsApi.bootstrapApplicationUnitState({ documents: docs, status: 'fit-correcting', corrections: ['measured-one-page-fit: resume renders 2 pages.'] });
    unitState.fitMeasurement = [{ document: 'resume', pageCount: 2, contentHeightPx: 1100, typeAreaHeightPx: 900 }]; state.candidates[0].unitState = unitState;
    const prompt = w5Policy.writeVerifyPrompt({ stage: 'fit-correction', state, sourcePrompt: '', envelope: {} });
    assert(prompt.includes('content 1100px of a 900px type area') && prompt.includes('UNIT SIZES:') && prompt.includes('OPEN (measured-one-page-fit)'), 'fit uses shared measured data');
    state.candidates[0].status = 'accepted'; state.ranking = ['candidate-1']; state.factIndex = 0;
    assert(w5Policy.writeVerifyStageKey(state, 'fact-recheck', 'job') === 'v2:job:candidate-1:fact-recheck', 'legacy first key remains');
    state.factRecheckReopens = 2;
    assert(w5Policy.writeVerifyStageKey(state, 'fact-recheck', 'job').endsWith(':r2') && !w5Policy.writeVerifyStageKey(state, 'fact-correction', 'job').endsWith(':r2'), 'only reopened recheck starts a new session');
    state.factFindings = [{ id: 'b-1', claim: 'Built reliable services.', reason: 'Synthetic finding.' }]; delete state.candidates[0].unitState;
    assert(w5Policy.writeVerifyPrompt({ stage: 'fact-correction', state, sourcePrompt: '', envelope: {} }).includes('[@argument.primary] OPEN (fact-check)'), 'bound argument slot opens with the fact bullet');
  } },
  { name: 'W5 diagnostics: mode counts and terminal reasons contain closed metadata only', run: () => {
    nodeAssert.deepEqual(findingsApi.applicationUnitDiagnostics({ unitModeCounts: { patch: 2, document: 3, environment: -1, PRIVATE: 50 }, candidates: [{ stopReason: { kind: 'document-repeat', prose: 'PRIVATE' } }, { stopReason: { kind: 'fit-no-progress' } }] }),
      { unitPatchDiagnostics: { modes: { patch: 2, document: 3, environment: 0 }, stops: { 'document-repeat': 1, 'fit-no-progress': 1 } } });
  } },
];

export default [
  ...promptTests,
  ...locatorTests,
  ...pureTests,
  ...['whole-document', 'patch'].map(form => ({ name: `W5 R1 unit patches: ${form} changes to settled units are refused on the real v2 path`, run: () => withSeededJob({}, async ({ docs, submit, read }) => {
    const changed = clone(docs); changed.coverLetter.paragraphs[2].text = 'A revised synthetic third paragraph.'; changed.resume.roles[0].bullets[0].text = 'A rewritten settled bullet.';
    const result = await submit(form === 'whole-document' ? changed : { patches: [{ unit: 'p-3', op: 'set', fields: { text: changed.coverLetter.paragraphs[2].text } }, { unit: 'b-1', op: 'set', fields: { text: changed.resume.roles[0].bullets[0].text } }] });
    const candidate = (await read()).paste.writeVerify.candidates[0];
    assert(!result.accepted && result.validationErrors.some(error => error.startsWith('unit-patch: ') && error.includes('p-3')), 'round explains its unit-patch format or settled-unit violation');
    assert(candidate.corrections === 2, 'refusal spends the existing content budget'); nodeAssert.deepEqual(candidate.structured, docs);
  }) })),
  { name: 'W5 R2 unit patches: an unchanged field has its own no-op correction', run: () => withSeededJob({}, async ({ docs, submit, read }) => {
    const result = await submit({ patches: [{ unit: 'p-3', op: 'set', fields: { text: docs.coverLetter.paragraphs[2].text } }] });
    assert(result.validationErrors.some(error => error.startsWith('unit-patch: ') && error.includes('"p-3"') && error.includes('text') && error.includes('already equal')), 'no-op names the unit and field');
    nodeAssert.deepEqual((await read()).paste.writeVerify.candidates[0].structured, docs);
  }) },
  { name: 'W5 R3 unit patches: returning to an earlier document stops the candidate before its remaining budget is spent', run: () => withSeededJob({ configure: ({ docs }) => { docs.resume.schemaVersion = 'structured-resume.v1'; docs.resume.identity = { name: 'Ada Lovelace', contact: ['ada@example.test'] }; docs.coverLetter.contact = ['ada@example.test']; } }, async ({ docs, submit, read }) => {
    await submit({ patches: [{ unit: 'p-3', op: 'set', fields: { text: 'A different unsupported synthetic claim.' } }] });
    const result = await submit({ patches: [{ unit: 'p-3', op: 'set', fields: { text: docs.coverLetter.paragraphs[2].text } }] });
    const candidate = (await read()).paste.writeVerify.candidates[0];
    assert(candidate.status === 'dropped' && candidate.stopReason?.kind === 'document-repeat' && candidate.stopReason.earlierRound === 0 && candidate.corrections < 3, `document oscillation stops before exhausting content rounds: ${JSON.stringify({candidate,errors:result.validationErrors})}`);
    assert(candidate.rejections.at(-1).checkIds.includes('document-repeat') && result.handoff?.stage === 'write', 'named stop advances to the next candidate');
  }) },
  { name: 'W5 R4 fact recheck: an unchanged unit reopens once while changed units and exhausted budgets fall back', run: async () => {
    for (const [id, priorRound, reopen] of [['p-1', 1, true], ['b-1', 1, false], ['p-1', 2, false]]) await withSeededJob({ stage: 'fact-recheck', corrections: [], configure: ({ work, docs }) => {
      const winner = work.candidates[0]; winner.status = 'accepted';
      Object.assign(work.candidates[1], { status: 'accepted', structured: clone(docs), plainText: 'Second synthetic draft.' });
      work.ranking = ['candidate-1', 'candidate-2']; work.factIndex = 0; work.factCorrectionRound = priorRound;
      work.factFindings = [{ id: 'b-1', claim: docs.resume.roles[0].bullets[0].text, reason: 'Synthetic finding.' }];
      const baseline = row => sha256(canonicalJson({ text: row.text, evidenceIds: row.evidenceIds }));
      winner.factBaseline = { round: 0, unitDigests: { 'p-1': baseline(docs.coverLetter.paragraphs[0]), 'b-1': sha256('different baseline') } };
    } }, async ({ docs, submit, read }) => {
      const row = id === 'b-1' ? docs.resume.roles[0].bullets[0] : docs.coverLetter.paragraphs[0];
      const result = await submit({ findings: [{ id, claim: row.text, reason: 'A synthetic fact-check finding.' }] });
      const work = (await read()).paste.writeVerify;
      assert(result.accepted, `valid finding is accepted: ${JSON.stringify(result.validationErrors)}`);
      if (reopen) assert(work.factIndex === 0 && work.factCorrectionRound === 2 && result.handoff.stage === 'fact-correction' && work.factFindings[0].id === id, 'unchanged unit gets another correction within the existing budget');
      else assert(work.factIndex === 1 && work.candidates[0].factFailure.step === 'second-fact-check' && result.handoff.stage === 'fact-check', 'changed unit or spent budget retains ranked fallback');
    });
  } },
  { name: 'W5 R5 fit correction: a lengthening refusal spends only the fit budget', run: () => withSeededJob({ stage: 'fit-correction', corrections: ['measured-one-page-fit: resume renders 2 pages against 1.'] }, async ({ docs, submit, read }) => {
    const result = await submit({ patches: [{ unit: 'b-1', op: 'set', fields: { text: docs.resume.roles[0].bullets[0].text + ' A longer synthetic clause.' } }] });
    const candidate = (await read()).paste.writeVerify.candidates[0];
    assert(result.validationErrors.some(error => error.startsWith('unit-patch: ') && error.includes('characters')), 'fit refusal reports measured character counts');
    assert(candidate.status === 'fit-correcting' && candidate.fitCorrections === 1 && candidate.corrections === 1, 'fit format refusal retains the separate fit budget');
  }) },
  { name: 'W5 live path: merged raw rejection persists and all untouched units remain identical', run: () => withSeededJob({}, async ({ docs, submit, read }) => {
    await submit({ patches: [{ unit: 'p-3', op: 'set', fields: { text: 'A revised synthetic paragraph that still fails gates.' } }] });
    const work = (await read()).paste.writeVerify, candidate = work.candidates[0];
    assert(candidate.structured.coverLetter.paragraphs[2].text.startsWith('A revised'), 'rejected merged raw document is the next base');
    const expected = clone(docs); expected.coverLetter.paragraphs[2].text = candidate.structured.coverLetter.paragraphs[2].text;
    nodeAssert.deepEqual(candidate.structured, expected); assert(candidate.unitState.digests.length === 2 && candidate.unitState.round === 1 && work.unitModeCounts.patch === 1, 'manifest keeps digest and mode counts');
  }) },
  { name: 'W5 live path: document-mode diff protects settled units and permits a required new paragraph', run: () => withSeededJob({ configure: ({ work, docs }) => {
    const units = findingsApi.bootstrapApplicationUnitState({ documents: docs, corrections: ['unit-source-grounding: Cover-letter paragraph "p-3": bad.'] });
    units.mode = 'document'; units.findings.push({ checkId: 'shape', scope: 'structure', units: ['p-3'] }); work.candidates[0].unitState = units;
  } }, async ({ docs, submit, read }) => {
    const bad = clone(docs); bad.resume.roles[0].bullets[0].text = 'A settled rewrite.';
    const rejected = await submit(bad); assert(rejected.validationErrors.some(error => error.startsWith('unit-patch: ') && error.includes('b-1')), 'document round protects settled units');
    const added = clone(docs); added.coverLetter.paragraphs.push({ id: 'p-4', text: 'A required new synthetic paragraph.', evidenceIds: docs.coverLetter.paragraphs[0].evidenceIds });
    await submit(added);
    assert((await read()).paste.writeVerify.candidates[0].structured.coverLetter.paragraphs.length === 4, 'structure round merges an added paragraph before normal gates');
  }) },
  { name: 'W5 live path: legacy environment retry can re-gate an identical document', run: () => withSeededJob({ stage: 'fit-correction', corrections: ['measured-one-page-fit: resume render failed; fonts not loaded.'] }, async ({ docs, submit, read }) => {
    const result = await submit(docs);
    assert(!result.validationErrors.some(error => /^(?:unit-patch|document-repeat):/u.test(error)), 'identical environment retry reaches the unchanged gates');
    assert((await read()).paste.writeVerify.candidates[0].unitState.round === 1, 're-gating is recorded');
  }) },
  { name: 'W5 live path: a legacy fact recheck without a baseline retains ranked fallback', run: () => withSeededJob({ stage: 'fact-recheck', corrections: [], configure: ({ work, docs }) => {
    work.candidates[0].status = 'accepted'; Object.assign(work.candidates[1], { status: 'accepted', structured: clone(docs) });
    work.ranking = ['candidate-1', 'candidate-2']; work.factIndex = 0;
  } }, async ({ docs, submit, read }) => {
    const result = await submit({ findings: [{ id: 'p-1', claim: docs.coverLetter.paragraphs[0].text, reason: 'Synthetic old-job finding.' }] });
    assert(result.handoff.stage === 'fact-check' && (await read()).paste.writeVerify.factIndex === 1, 'old job never invents a baseline after the fact');
  }) },

  { name: 'W5 live consumers: merged candidate reaches pick, final archive and result.json', run: async () => {
    __setLocalAiRenderPdfForTests(async () => ({ pageCount: 1, fontsLoaded: true, bytes: Buffer.from('%PDF-1.4 synthetic'), layout: { contentHeightPx: 400, typeAreaHeightPx: 900, horizontalOverflowCount: 0 } }));
    __setApplicationV2PagePngForTests(async () => Buffer.from('synthetic PNG').toString('base64'));
    try { await withSeededJob({ configure: ({ work, docs }) => {
      docs.resume.schemaVersion = 'structured-resume.v1'; docs.resume.identity = { name: 'Ada Lovelace', contact: ['ada@example.test'] };
      docs.resume.roles[0].bullets.forEach(row => { row.text = 'Built reliable services.'; });
      docs.coverLetter.contact = ['ada@example.test']; docs.coverLetter.salutation = 'Dear hiring manager,'; docs.coverLetter.closing = 'Sincerely,';
      docs.coverLetter.paragraphs.forEach(row => { row.text = 'I built reliable services.'; });
      work.candidates.slice(1).forEach(row => { row.status = 'dropped'; });
      Object.assign(work.candidates[1], { status: 'accepted', structured: clone(docs), plainText: 'Other synthetic candidate.' });
    } }, async ({ docs, submit, read, queued }) => {
      const patched = await submit({ patches: [{ unit: 'p-3', op: 'set', fields: { text: 'Built reliable services.' } }] });
      assert(patched.accepted && patched.handoff?.stage === 'pick', `patched candidate reaches pick: ${JSON.stringify(patched.validationErrors)}`);
      const winner = (await read()).paste.writeVerify.candidates[0];
      assert(patched.handoff.prompt.includes(JSON.stringify(winner.structured)), 'judge receives merged canonical documents');
      const ranked = await submit({ ranking: [{ id: 'candidate-1', reason: 'The supported synthetic candidate.' }, { id: 'candidate-2', reason: 'The alternative synthetic candidate.' }] });
      assert(ranked.handoff.stage === 'fact-check', 'ranked candidate reaches fact check');
      const done = await submit({ findings: [] }); assert(done.accepted && done.completed, `final result completes: ${JSON.stringify(done.validationErrors)}`);
      const result = JSON.parse(await fs.promises.readFile(path.join(queued.folder, 'result.json'), 'utf8'));
      nodeAssert.equal(result.coverLetter.paragraphs[2], winner.structured.coverLetter.paragraphs[2].text, 'result package carries the exact patched paragraph');
      assert(JSON.stringify(result).includes('Built reliable services.'), 'result package contains merged prose');
      assert(!JSON.stringify(result).includes('My synthetic third paragraph'), 'old prose is absent from the result');
      const directory = path.join(path.dirname(path.dirname(queued.folder)), 'evidence-archive', queued.id);
      const filename = (await fs.promises.readdir(directory)).find(name => name.includes('-candidate-final-'));
      const archived = JSON.parse(await fs.promises.readFile(path.join(directory, filename), 'utf8'));
      nodeAssert.deepEqual(archived.content.structured, winner.structured);
      nodeAssert.deepEqual(winner.structured.coverLetter.paragraphs[2].text, 'Built reliable services.');
      nodeAssert.deepEqual(winner.structured.coverLetter.paragraphs[0], docs.coverLetter.paragraphs[0]);
    }); } finally { __setLocalAiRenderPdfForTests(null); __setApplicationV2PagePngForTests(null); }
  } },

  { name: 'W5 live path: malformed conversion stays in convert with its original correction budget', run: () => withSeededJob({ stage: 'convert', configure: ({ work }) => { delete work.candidates[0].structured; work.candidates[0].status = 'written'; } }, async ({ submit, read }) => {
    const result = await submit({ wrong: true }), candidate = (await read()).paste.writeVerify.candidates[0];
    assert(!result.accepted && result.handoff.stage === 'convert' && candidate.status === 'written' && candidate.corrections === 2, 'no correction prompt is built without a base document');
    assert(result.handoff.prompt.includes('Conversion must return both production structured documents.'), 'convert teaches the structural refusal');
  }) },
  { name: 'W5 live path: a rejected fact patch keeps the ranked winner base and its fact targets open', run: () => withSeededJob({ stage: 'fact-correction', corrections: [], configure: ({ work, docs }) => {
    work.candidates[0].status = 'accepted'; work.ranking = ['candidate-1']; work.factIndex = 0; work.factCorrectionRound = 0;
    work.factFindings = [{ id: 'p-3', claim: docs.coverLetter.paragraphs[2].text, reason: 'Synthetic unsupported claim.' }];
  } }, async ({ docs, submit, read }) => {
    const result = await submit({ patches: [{ unit: 'p-3', op: 'set', fields: { text: 'A different synthetic unsupported claim.' } }] });
    const work = (await read()).paste.writeVerify;
    assert(!result.accepted && result.handoff.stage === 'fact-correction' && work.factCorrectionRound === 1, 'failed deterministic fact repair spends its original budget');
    nodeAssert.deepEqual(work.candidates[0].structured, docs);
    assert(work.candidates[0].unitState.open.includes('p-3') && work.candidates[0].unitState.digests.length === 2, 'fact target remains open and gated proposal is recorded');
  }) },

  { name: 'W5 live path: terminal fact repeat at the budget boundary advances exactly one ranked candidate', run: async () => {
    const api = await unitApi();
    await withSeededJob({ stage: 'fact-correction', corrections: [], configure: ({ work, docs }) => {
      work.candidates[0].status = 'accepted';
      for (const candidate of work.candidates.slice(1, 3)) Object.assign(candidate, { status: 'accepted', structured: clone(docs) });
      work.ranking = ['candidate-1', 'candidate-2', 'candidate-3']; work.factIndex = 0; work.factCorrectionRound = 2;
      work.factFindings = [{ id: 'p-3', claim: docs.coverLetter.paragraphs[2].text, reason: 'Synthetic unsupported claim.' }];
      const earlier = clone(docs); earlier.coverLetter.paragraphs[2].text = 'An earlier synthetic unsupported claim.';
      const units = findingsApi.bootstrapApplicationUnitState({ documents: docs, tier: 'fact', factFindings: work.factFindings });
      units.digests.unshift(api.structuredDocumentDigest(earlier)); units.round = 1; work.candidates[0].unitState = units;
    } }, async ({ submit, read }) => {
      const result = await submit({ patches: [{ unit: 'p-3', op: 'set', fields: { text: 'An earlier synthetic unsupported claim.' } }] });
      const work = (await read()).paste.writeVerify;
      assert(work.factIndex === 1 && result.handoff.stage === 'fact-check', 'ordinary budget bookkeeping and terminal override must not each advance the ranking');
      assert(work.candidates[0].factFailure.step === 'document-repeat', 'repeat keeps its named fact stop');
    });
  } },

  { name: 'W5 locator live path: truth bullet labels and authored argument failures retain their own targets', run: async () => {
    for (const kind of ['citation', 'argument-shape', 'argument-role']) await withSeededJob({ configure: ({ docs }) => {
      docs.resume.schemaVersion = 'structured-resume.v1'; docs.resume.identity = { name: 'Ada Lovelace', contact: ['ada@example.test'] };
      docs.resume.roles[0].bullets.forEach(row => { row.text = 'Built reliable services.'; });
      docs.coverLetter.contact = ['ada@example.test']; docs.coverLetter.paragraphs.forEach(row => { row.text = 'I built reliable services.'; });
      if (kind === 'citation') docs.resume.roles[0].bullets[0].evidenceIds = ['unknown'];
      if (kind === 'argument-shape') docs.coverLetter.coverLetterArgument.primaryEvidence.relationToThesis = 'x';
      if (kind === 'argument-role') docs.coverLetter.coverLetterArgument.primaryEvidence.evidenceRole = 'A different synthetic role';
    } }, async ({ submit, read }) => {
      const result = await submit({ patches: [{ unit: 'p-3', op: 'set', fields: { text: 'Built reliable services.' } }] });
      const findings = (await read()).paste.writeVerify.candidates[0].unitState.findings;
      assert(!result.accepted, `real ${kind} gate rejects`);
      if (kind === 'citation') assert(findings.some(row => row.checkId === 'evidence-id-is-verified' && row.scope === 'unit' && row.units.includes('b-1')), 'truth-gate bullet label locates without a structured-offense Units suffix');
      else assert(findings.some(row => row.scope === 'field' && row.units.includes('@argument.primary')), `real ${kind} failure locates the authored primary slot: ${JSON.stringify(result.validationErrors)}`);
    });
  } },
  { name: 'W5 argument binding: explicit same-bullet rebinding repairs a stale role and a truly unchanged binding refuses', run: async () => {
    const api = await unitApi(), docs = documents('e1'); docs.coverLetter.coverLetterArgument.primaryEvidence.evidenceRole = 'Wrong synthetic role';
    const patch = [{ unit: '@argument.primary', op: 'set', fields: { bullet: 'b-1' } }];
    const fixed = api.mergeUnitPatches(docs, patch, pureOptions(docs, api, { open: ['@argument.primary'] }));
    assert(!fixed.errors.length && fixed.documents.coverLetter.coverLetterArgument.primaryEvidence.evidenceRole === 'Engineer at Acme', 'explicit rebinding makes a real host-derived role change');
    assert(api.mergeUnitPatches(fixed.documents, patch, pureOptions(fixed.documents, api, { open: ['@argument.primary'] })).errors.some(row => row.code === 'no-op'), 'already correct same binding remains a no-op');
  } },

];
