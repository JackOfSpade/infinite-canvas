// Writer guidance for the cover letter and the résumé, and the one fact a writer
// was never told: which posting requirements the approved evidence does not
// support.
//
// The failure these tests pin. A live run ended in a human stop after five
// blind-review rounds, and an independent panel scored the stopped documents
// barely above the first accepted drafts. What the panel kept finding was never
// a rule the host could enforce without naming a string for the writer to copy:
// the letter restated the résumé bullets one for one, opened on an abstract
// assertion about the employer's domain, echoed the posting's vocabulary as
// filler, closed on a sentence that tied nothing to the role, bound two
// paragraphs to one posting phrase, and padded a third proof the evidence did
// not need; the résumé promoted maintenance work into work the candidate built;
// and the writer was never told which highest-priority requirements had no
// support at all. The lever is GUIDANCE in the writer's contract, not a new gate
// (an honest, wide-gap letter passes every existing gate), so nothing below
// asserts that a gate rejects anything; each test proves the guidance is there,
// is built from the code that owns the rule, is generic, and cannot be
// satisfied by a name, phrase or technology it was written against.
//
// What each group proves:
//   rules      each rule is its own generic sentence set, composed once, and no
//              rule carries a quotation, a number, or a word of any fixture
//   closing    the closing grammar printed in the stage contract is the check's
//              own wording (read from the check), and a closing written to it is
//              accepted by the whole deterministic battery while the same
//              closing missing its employer half is not (A / B / C)
//   opening    an opening that names the role and the employer from the job
//              record and speaks from the candidate's side passes the whole
//              battery (three domains), so the guidance sends no writer into a
//              rejection
//   mutation   changing a constant in a temporary copy of the module that owns
//              it changes what the guidance prints, and the real modules stay
//              untouched
//   bounded    the unsupported-requirement context is bounded, ordered, de-
//              duplicated, filtered by priority, and absent when empty
//   store      it is derived from the store's reduction receipt, and flipping
//              one match or one priority flips the verdict
//   flow       through the real current-authority protocol it reaches the
//              résumé, the letter and the review, with its rule, and is absent
//              when every requirement is supported
//   prompts    the stage contracts print the guidance once, in the stages that
//              write the document it governs, and no stage prints a string from
//              any fixture
//   builder    a temporary copy of the prompt builder, wired to a temporary copy
//              of the guidance module whose every rule is marked, prints each
//              mark where it belongs and nowhere else, correction rounds included
//   brief      the correction round restates only what a rewrite is invited to
//              forget, last, so the byte ceiling gives it up first
//   wiring     the blind repair brief carries the typed fields and the rule
//              sentences, and unitRaisedCycles reads the signed tally across
//              real cycles
//   docs       the documents say what the code does
//
// Every fixture is SYNTHETIC: invented careers in unrelated fields (freight
// dispatch, clinic scheduling, library cataloguing, civil site inspection, retail
// analytics). Nothing in production names any of them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import electronPkg from 'electron';
import { assert } from './testHelpers.js';
import { currentAuthorityFlowKit as kit } from './local-ai-application.js';
import { FLOW_SPECS, createFlow } from './gapfix-repair-convergence.js';
import { getLocalApplicationHandoff, queueLocalApplicationJob, submitLocalApplicationHandoff } from '../test-dependencies.js';
import * as guidance from '../../electron/ipc/applicationWriterGuidance.js';
import {
  APPLICATION_QUALITY_CRITERIA, __currentAuthorityDraftSelectionForTests, __currentAuthorityUnsupportedNeedsForTests, pasteCorrectionPrompt,
} from '../../electron/ipc/localAiApplication.js';
import {
  OWING_CLAIM_PARAGRAPHS, checkDirectWelcomeClosing, closingContributionParts, evaluateCoverLetterChecks,
} from '../../electron/ipc/coverLetterChecks.js';
import { BLIND_REPAIR_RAISED_CYCLES_RULE, BLIND_REPAIR_TRUNCATION_RULE } from '../../electron/ipc/applicationRepairConvergence.js';
import { createAuthorityLedgerStore } from '../../electron/ipc/applicationAuthorityLedgerStore.js';
import { createStoreAuthorityWorkflowRoot, createStoreMatchReceipt, storeRequirementCatalogPairDescriptor } from '../../electron/ipc/applicationAuthorityWorkflow.js';
import {
  CAREER_SNAPSHOT_COMPILATION_CONTRACT, CAREER_SNAPSHOT_SCHEMA_VERSION, CAREER_SNAPSHOT_STATUS_APPROVED, approvedCareerEvidenceCatalog,
  buildCareerSourceCorpus, careerSnapshotId, careerSnapshotStorageRoot, emptyCareerReconciliationReceipt, partitionCareerSourcePages,
  verbatimCareerTranscriptionAuditReceipt, writeCareerSnapshotAtomically,
} from '../../electron/ipc/careerSnapshot.js';
import { buildApplicationCareerAuthority } from '../../electron/ipc/applicationCareerAuthority.js';
import { APPLICATION_COVER_LETTER_SCHEMA, APPLICATION_DIRECT_COVER_LETTER_SCHEMA } from '../../electron/ipc/aiSchemas.js';

const read = file => fs.readFileSync(path.resolve(file), 'utf8');
const count = (text, part) => text.split(part).length - 1;
const CONTEXT_MARKER = '\n\nAuthoritative context:\n';
const contractOf = prompt => prompt.slice(0, prompt.lastIndexOf(CONTEXT_MARKER));
const contextOf = prompt => JSON.parse(prompt.slice(prompt.lastIndexOf(CONTEXT_MARKER) + CONTEXT_MARKER.length));
const words = text => String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------
// Each domain is a candidate, a posting, a bullet, and the paragraph the legacy
// walker submits as the letter. `vocabulary` is what no production sentence may
// contain.
const DOMAINS = Object.freeze([
  {
    key: 'freight dispatch', name: 'Dara Okafor', email: 'dara@example.test', employer: 'Meridian Freight', title: 'Dispatch Planner',
    vocabulary: ['freight', 'pallet', 'depot', 'dock', 'dispatch', 'drivers', 'meridian', 'okafor'],
    listing: ['Dispatch planner role focused on reliable pallet routing.',
      'The team schedules loading docks and supports drivers who depend on those schedules every working day.',
      'We value careful judgement, clear written handoffs, steady planning habits, and a willingness to learn the depot network in depth.',
      'You will work with warehouse partners to keep the delivery network dependable for the customers who rely on it each week.'].join(' '),
    bullet: 'Maintained pallet routing schedules with supported dispatch practices.',
    lead: 'Reliable pallet routing is the capability this dispatch role needs, and my planning experience supports it.',
    body: 'In my planning role at Meridian Freight, I kept the depot loading schedule dependable for daily drivers through shared route sheets.',
    thesis: 'Reliable pallet routing is the supported capability this dispatch role needs.',
    // A letter written to the guidance: the opening names role and employer, two proofs add the reason or outcome, the close ties one item to the role.
    guided: [
      'For the Dispatch Planner role at Meridian Freight, the closest capability my work shows is keeping depot loading schedules dependable for the drivers who read them.',
      'I rebuilt the dock schedule at a regional depot after drivers lost hours waiting at full bays. The change moved morning arrivals into staggered slots, and waiting time dropped within a month.',
      'I wrote the handoff sheet that night supervisors used when a route changed. Because the sheet listed the reason for each change, drivers stopped phoning the office for clarification.',
    ],
    asset: 'dock scheduling', employerSide: 'your depot network',
    closing: 'My dock scheduling work could support your depot network and the customers who rely on it.',
  },
  {
    key: 'clinic scheduling', name: 'Imani Rahman', email: 'imani@example.test', employer: 'Harborview Clinic', title: 'Scheduling Coordinator',
    vocabulary: ['clinic', 'nurse', 'nurses', 'appointment', 'appointments', 'patients', 'patient', 'harborview', 'rahman', 'exam'],
    listing: ['Scheduling coordinator role focused on reliable appointment booking.',
      'The team manages exam rooms and supports nurses who depend on those bookings every working day.',
      'We value careful judgement, clear written messages, steady booking habits, and a willingness to learn the patient flow in depth.',
      'You will work with front desk partners to keep the appointment calendar dependable for the patients who rely on it each week.'].join(' '),
    bullet: 'Maintained appointment calendars with supported booking practices.',
    lead: 'Reliable appointment booking is the capability this coordinator role needs, and my scheduling experience supports it.',
    body: 'In my scheduling role at Harborview Clinic, I kept the exam room calendar dependable for daily nurses through shared booking sheets.',
    thesis: 'Reliable appointment booking is the supported capability this coordinator role needs.',
    guided: [
      'For the Scheduling Coordinator role at Harborview Clinic, the closest capability my work shows is keeping exam room calendars dependable for the nurses who rely on them.',
      'I rebuilt the Monday booking template after double bookings filled the waiting room. The template reserved the first hour for urgent visits, and walk-in waits shortened within a month.',
      'I wrote the reminder script that front desk staff read before every call. Because the script gave the reason for each rescheduling, patients stopped calling back to ask why.',
    ],
    asset: 'calendar management', employerSide: 'your front desk',
    closing: 'My calendar management work could support your front desk and the patients who rely on it.',
  },
  {
    key: 'library cataloguing', name: 'Tomas Lindqvist', email: 'tomas@example.test', employer: 'Eastgate Library', title: 'Collections Cataloguer',
    vocabulary: ['library', 'cataloguer', 'shelving', 'readers', 'eastgate', 'lindqvist', 'accession'],
    listing: ['Collections cataloguer role focused on reliable record keeping.',
      'The team organises shelving sections and supports readers who depend on those records every working day.',
      'We value careful judgement, clear written notes, steady cataloguing habits, and a willingness to learn the collection in depth.',
      'You will work with branch partners to keep the catalogue dependable for the readers who rely on it each week.'].join(' '),
    bullet: 'Maintained catalogue records with supported cataloguing practices.',
    lead: 'Reliable record keeping is the capability this cataloguer role needs, and my cataloguing experience supports it.',
    body: 'In my cataloguing role at Eastgate Library, I kept the shelving records dependable for daily readers through shared index cards.',
    thesis: 'Reliable record keeping is the supported capability this cataloguer role needs.',
    guided: [
      'For the Collections Cataloguer role at Eastgate Library, the closest capability my work shows is keeping shelving records dependable for the readers who search them.',
      'I rebuilt the subject headings for the local history shelves after readers could not find maps. The new headings grouped maps by parish, and requests for staff help fell within a term.',
      'I wrote the accession checklist that volunteers used for every donated box. Because the checklist recorded where each item came from, later questions about a donor took minutes.',
    ],
    asset: 'cataloguing', employerSide: 'your branch teams',
    closing: 'My cataloguing work could support your branch teams and the readers who rely on the collection.',
  },
]);

// Two further careers for the pure functions: a requirement list is not a letter.
const REQUIREMENT_SETS = Object.freeze([
  { key: 'civil site inspection', rows: [
    { id: 'r-1', text: 'Inspect concrete pours against the engineer’s drawings', priority: 'highest' },
    { id: 'r-2', text: 'Hold a current confined space entry permit', priority: 'high' },
    { id: 'r-3', text: 'Report weekly progress to the owner’s representative', priority: 'supporting' },
    { id: 'r-4', text: 'Operate a total station', priority: 'highest' },
  ] },
  { key: 'retail analytics', rows: [
    { id: 'q-1', text: 'Forecast weekly basket size by store format', priority: 'high' },
    { id: 'q-2', text: 'Build dashboards for regional managers', priority: 'supporting' },
    { id: 'q-3', text: 'Negotiate vendor rebates', priority: 'highest' },
  ] },
  { key: 'freight dispatch', rows: [
    { id: 'p-1', text: 'Hold a hazardous materials endorsement', priority: 'highest' },
    { id: 'p-2', text: 'Plan backhaul loads for regional carriers', priority: 'high' },
  ] },
]);

// ---------------------------------------------------------------------------
// The legacy walker: queue a paste job over a plain-text career, accept the
// evidence plan, the résumé and the letter, and keep the prompt of every stage.
// `api` is the module under test, so a temporary copy of the builder can be
// driven by the same code.
// ---------------------------------------------------------------------------
const reply = (handoff, fields) => ({ protocol: 1, jobId: handoff.jobId, stage: handoff.stage, handoffCode: handoff.handoffCode, baseHashes: handoff.baseHashes || {}, ...fields });

async function walk(domain, api = { queueLocalApplicationJob, getLocalApplicationHandoff, submitLocalApplicationHandoff }, { probe = false } = {}) {
  const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'v16-prompts-')));
  const canvasFilePath = path.join(root, 'Canvas.json');
  await fs.promises.writeFile(canvasFilePath, '{}', 'utf8');
  const paragraph = `${domain.lead} ${domain.body}`;
  const queued = await api.queueLocalApplicationJob({
    transport: 'paste', canvasFilePath,
    careerData: [domain.name, domain.email, `${domain.title} profile`, '', `## ${domain.employer}`, domain.title, '', domain.bullet, paragraph].join('\n'),
    job: { title: domain.title, company: domain.employer, snippet: domain.listing },
    resumeProfile: { workHistory: [{ id: 'role-1', title: domain.title, employer: domain.employer, startDate: '', endDate: '' }] },
  });
  const current = async () => (await api.getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
  const submit = async fields => {
    const handoff = await current();
    return api.submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(reply(handoff, fields)) });
  };
  const out = { root, prompts: {}, corrections: {} };
  const must = (result, stage) => assert(result.accepted, `${domain.key}: the ${stage} fixture is accepted (${JSON.stringify(result.validationErrors || [])})`);
  out.prompts['evidence-plan'] = (await current()).prompt;
  const evidence = [
    { id: 'resume-proof-1', sourceId: 'career-data', quote: domain.bullet, requirement: 'Reliable delivery', priority: 'highest' },
    { id: 'letter-proof-1', sourceId: 'career-data', quote: paragraph, requirement: 'Reliable delivery', priority: 'highest' },
    { id: 'job-proof', sourceId: 'job-listing', quote: `${domain.listing.split('. ')[0]}.`, requirement: 'Reliable delivery', priority: 'highest' },
  ];
  must(await submit({ identity: { name: domain.name, contact: [domain.email], subtitleRole: domain.title }, evidence,
    requirements: [{ id: 'need-1', text: 'Reliable delivery', priority: 'highest', evidenceIds: ['resume-proof-1', 'job-proof'] }] }), 'evidence-plan');
  out.prompts.resume = (await current()).prompt;
  const resumeWith = text => ({ resume: { schemaVersion: 'structured-resume.v1', identity: { name: domain.name, contact: [domain.email], subtitleRole: domain.title, credential: '' },
    roles: [{ id: 'role-1', title: domain.title, company: domain.employer, dates: '', location: '', bullets: [{ id: 'bullet-1', text, evidenceIds: ['resume-proof-1'] }] }] } });
  if (probe) {
    // A bullet far over its visible-character budget: the host rejects it, and the rejection is a correction about a résumé bullet.
    const rejected = await submit(resumeWith(Array.from({ length: 5 }, () => domain.bullet).join(' ')));
    assert(!rejected.accepted && rejected.handoff?.correctionPrompt, `${domain.key}: the over-long bullet is rejected with a correction round`);
    out.corrections.bullet = rejected.handoff.correctionPrompt;
  }
  must(await submit(resumeWith(domain.bullet)), 'resume');
  out.prompts['cover-letter'] = (await current()).prompt;
  const letterFields = (text, extra = {}) => ({ coverLetter: { name: domain.name, contact: [domain.email],
    paragraphs: [{ id: 'paragraph-1', text, evidenceIds: ['letter-proof-1', 'job-proof'] }], roleThesis: domain.thesis,
    coverLetterArgument: { primaryEvidence: { evidence: domain.bullet, evidenceRole: `${domain.title} at ${domain.employer}`, relationToThesis: 'The systems work establishes the delivery capability named in the thesis.' } }, ...extra } });
  if (probe) {
    // A stock phrase the host rejects by name: a correction about a letter paragraph.
    const rejected = await submit(letterFields(`${paragraph} I have a proven track record.`));
    assert(!rejected.accepted && rejected.handoff?.correctionPrompt, `${domain.key}: the stock phrase is rejected with a correction round`);
    out.corrections.paragraph = rejected.handoff.correctionPrompt;
  }
  must(await submit(letterFields(paragraph)), 'cover-letter');
  out.prompts.review = (await current()).prompt;
  return out;
}

const cleanup = outs => Promise.all(outs.map(out => fs.promises.rm(out.root, { recursive: true, force: true })));

// ---------------------------------------------------------------------------
// Temporary copies of the modules under mutation. Relative imports become
// absolute URLs so a copy can live outside the repository; the real files are
// never written.
// ---------------------------------------------------------------------------
const IPC = path.resolve('electron/ipc');
const absolutize = text => text.replace(/from '(\.{1,2}\/[^']+)'/gu, (_match, relative) => `from '${pathToFileURL(path.resolve(IPC, relative)).href}'`);
const realUrl = file => pathToFileURL(path.resolve(IPC, file)).href;
async function loadCopy(dir, name, source) {
  const file = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(file, source, 'utf8');
  return { url: pathToFileURL(file).href, module: await import(`${pathToFileURL(file).href}?copy=${name}`) };
}

// Every exported rule of the guidance module, by name.
const RULE_NAMES = Object.freeze(Object.keys(guidance).filter(name => /_RULE$/u.test(name) && !/^(?:COVER_LETTER|LETTER_REWRITE_BRIEF)/u.test(name) || /^LETTER_[A-Z_]+_RULE$/u.test(name))
  .filter(name => !['LETTER_REWRITE_BRIEF_RULE'].includes(name)));
const LETTER_RULES = Object.freeze(['LETTER_PROOF_ADDS_RULE', 'LETTER_OPENING_RULE', 'LETTER_CLOSING_RULE', 'LETTER_PROOF_COUNT_RULE',
  'LETTER_JOB_NEED_BINDING_RULE', 'LETTER_NO_POSTING_ECHO_RULE', 'LETTER_CLAIM_PLACEMENT_RULE']);
const RESUME_RULES = Object.freeze(['RESUME_LEAD_BULLET_RULE', 'RESUME_SUPPORT_VERB_RULE']);

// The current-authority protocol replaces the phrase that names the posting, in the
// cover-letter and review contracts, with the listing proof the writer is given.
const forCurrentAuthority = text => text.replaceAll('the posting text', 'the receipt-selected listing proof text').replaceAll('the posting', 'the receipt-selected listing proof');

// ---------------------------------------------------------------------------
// The real current-authority protocol over a synthetic career whose posting asks for
// one thing the career supports, one it does not (high priority) and one it does not
// (supporting priority). Only the model is scripted: each response is a plain reply
// to the prompt the host issued. Adapted from the driver in
// gapfix-repair-convergence.js, which matches every requirement.
// ---------------------------------------------------------------------------
const GAP_SPECS = Object.freeze([
  { id: 'gap-freight', name: 'Dara Okafor', email: 'dara@example.test', title: 'Dispatch Planner', employer: 'Meridian Freight', tech: 'Routing', users: 40, start: 'March 2019',
    gap: 'Hazardous materials endorsement', gapQuote: 'A hazardous materials endorsement is required.', lowGap: 'Forklift licensing', lowQuote: 'Forklift licensing is a plus.' },
  { id: 'gap-clinic', name: 'Imani Rahman', email: 'imani@example.test', title: 'Scheduling Coordinator', employer: 'Harborview Clinic', tech: 'Booking', users: 65, start: 'June 2018',
    gap: 'Insurance pre-authorization experience', gapQuote: 'Insurance pre-authorization experience is required.', lowGap: 'Spanish fluency', lowQuote: 'Spanish fluency is a plus.' },
  { id: 'gap-library', name: 'Tomas Lindqvist', email: 'tomas@example.test', title: 'Collections Cataloguer', employer: 'Eastgate Library', tech: 'Cataloguing', users: 30, start: 'January 2017',
    gap: 'Rare book conservation training', gapQuote: 'Rare book conservation training is required.', lowGap: 'Grant writing', lowQuote: 'Grant writing is a plus.' },
]);

async function createGapFlow(spec, { matchGap = false } = {}) {
  const project = await kit.createCanvasProject();
  const need = `Reliable ${spec.tech} service delivery`;
  const bullet = `Built ${spec.tech} service used by ${spec.users} users.`;
  const paragraph = `I built ${spec.tech} service used by ${spec.users} users. The engineering was in matching the constraints those teams set rather than my own preferences. I would apply that delivery work to the reliable ${spec.tech} service delivery this role requires.`;
  const listing = `${need} is required. ${spec.gapQuote} ${spec.lowQuote}`;
  const thesis = `${need} is the supported capability this engineering role needs.`;
  const roleId = `role-${spec.employer.toLowerCase().replace(/[^a-z0-9]+/gu, '-')}`; const skillId = `skill-${spec.tech.toLowerCase()}`;
  const sourceText = `${spec.name}\n${spec.email}\n${spec.title} at ${spec.employer}\n${spec.start} to Present\n${bullet}\n${paragraph}\n`;
  const corpus = buildCareerSourceCorpus([{ name: `${spec.id} career.md`, contentHash: kit.sha256(sourceText), text: sourceText, legacyText: sourceText, transcriptionAudit: verbatimCareerTranscriptionAuditReceipt() }]);
  const evidence = corpus.segments.map(segment => segment.id);
  const achievementKey = `achievement-${spec.id}`;
  const profile = {
    identity: { name: spec.name, contacts: [spec.email], evidenceSegmentIds: evidence },
    roles: [{ id: roleId, title: spec.title, employer: spec.employer, startDate: spec.start, endDate: 'Present', location: '', achievementIds: [achievementKey], skillIds: [skillId], evidenceSegmentIds: evidence }],
    achievements: [{ id: achievementKey, roleId, claim: paragraph, technologies: [spec.tech],
      technologyReferences: [{ technology: spec.tech, disposition: 'skill', skillId, relationship: 'independent', relationshipGroup: '', relationshipEvidence: paragraph, evidenceSegmentIds: evidence }],
      metrics: [{ label: 'users', value: String(spec.users), unit: 'users', evidenceSegmentIds: evidence }], evidenceSegmentIds: evidence }],
    projects: [],
    skills: [{ id: skillId, name: spec.tech, category: 'language', capabilityKind: 'language', supportMode: 'direct', directEvidenceSegmentIds: evidence, indexEligible: true, roleIds: [roleId], evidenceSegmentIds: evidence }],
    education: [], certifications: [], otherEvidence: [],
    segmentCoverage: corpus.segments.map(segment => ({ segmentId: segment.id, disposition: 'achievement', entityIds: ['identity', roleId, achievementKey, skillId] })),
  };
  const snapshotId = careerSnapshotId(corpus); const snapshotRoot = careerSnapshotStorageRoot(electronPkg.app.getPath('userData'));
  await fs.promises.mkdir(path.dirname(snapshotRoot), { recursive: true, mode: 0o700 });
  const pages = partitionCareerSourcePages(corpus);
  await writeCareerSnapshotAtomically(snapshotRoot, { schemaVersion: CAREER_SNAPSHOT_SCHEMA_VERSION, status: CAREER_SNAPSHOT_STATUS_APPROVED, snapshotId,
    inputFingerprint: corpus.inputFingerprint, sourceFingerprint: corpus.sourceFingerprint, compilationContract: CAREER_SNAPSHOT_COMPILATION_CONTRACT,
    pagePlan: { maxSegments: 32, maxSourceChars: 48_000, pageCount: pages.length, pageDigest: kit.sha256(kit.canonicalJson(pages.map(page => ({ id: page.id, index: page.index, segmentIds: page.segmentIds })))) },
    reconciliation: emptyCareerReconciliationReceipt(), approvedAt: '2026-10-07T00:00:00.000Z', sources: corpus.sources, segments: corpus.segments, profile, auditHistory: kit.cleanCareerSnapshotAuditHistory(corpus, profile) });
  const queued = await queueLocalApplicationJob({ transport: 'paste', canvasFilePath: project.canvasFilePath, careerSnapshotId: snapshotId, job: { title: spec.title, company: spec.employer, snippet: listing } });
  // prompts: what a reopened dialog mints; returned: the handoff the submit that opened the stage handed back, which is what the app shows first.
  const flow = { prompts: {}, returned: {}, cleanup: () => fs.promises.rm(project.root, { recursive: true, force: true }) };
  const current = async () => (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath })).handoff;
  const submit = (handoff, fields) => submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoffCode,
    response: JSON.stringify({ protocol: 1, jobId: queued.id, stage: handoff.stage, handoffCode: handoff.handoffCode, baseHashes: handoff.baseHashes, ...fields }) });
  const digestIn = (prompt, key) => { const match = new RegExp(`${key}:"([a-f0-9]{64})"`, 'u').exec(prompt); assert(match, `fixture must expose ${key}`); return match[1]; };
  const ok = (result, label) => assert(result.accepted, `${spec.id}: ${label} (${JSON.stringify(result.validationErrors || [])})`);
  try {
    let handoff = await current(); const requirementContext = contextOf(handoff.prompt);
    const requirementEvidence = [
      { id: 'p1-listing', sourceId: 'job-listing', quote: `${need} is required.`, requirement: need, priority: 'highest' },
      { id: 'p1-gap-listing', sourceId: 'job-listing', quote: spec.gapQuote, requirement: spec.gap, priority: 'high' },
      { id: 'p1-low-listing', sourceId: 'job-listing', quote: spec.lowQuote, requirement: spec.lowGap, priority: 'supporting' },
    ];
    const requirementRecords = [
      { id: 'p1-requirement', text: need, priority: 'highest', evidenceIds: ['p1-listing'] },
      { id: 'p1-gap', text: spec.gap, priority: 'high', evidenceIds: ['p1-gap-listing'] },
      { id: 'p1-low', text: spec.lowGap, priority: 'supporting', evidenceIds: ['p1-low-listing'] },
    ];
    ok(await submit(handoff, { storeDigest: requirementContext.authorityStore.digest, complete: true, identity: requirementContext.trustedIdentity,
      evidence: requirementEvidence, requirements: requirementRecords, ...kit.listingCoverageFields(requirementContext, requirementEvidence, requirementRecords) }), 'the requirements are accepted');
    handoff = await current();
    ok(await submit(handoff, kit.listingSemanticAuditFields(contextOf(handoff.prompt), requirementEvidence, requirementRecords)), 'the audit is accepted');
    handoff = await current(); const matchContext = contextOf(handoff.prompt);
    const matchResult = await submit(handoff, { version: 1, rootDigest: matchContext.pair.rootDigest, pairDigest: matchContext.pair.digest,
      rows: matchContext.requirements.map(requirement => {
        const matched = requirement.id === 'p1-requirement' || (matchGap && requirement.id === 'p1-gap');
        return { requirementId: requirement.id, localStatus: matched ? 'matched' : 'no-match', candidateEvidenceIds: matched ? matchContext.catalog.map(item => item.id) : [] };
      }) });
    ok(matchResult, 'the match is accepted');
    flow.returned.resume = matchResult.handoff?.prompt;
    const achievementId = matchContext.catalog.find(item => new RegExp(`${spec.tech} service used by ${spec.users} users`, 'iu').test(item.quote))?.id;
    const skillEvidenceId = matchContext.catalog.find(item => String(item?.id || '').startsWith(`host.career.skill.${skillId}.`))?.id;
    assert(achievementId && skillEvidenceId, `${spec.id}: the fixture selects its achievement and its skill`);
    const identity = { name: spec.name, contact: [spec.email] };
    handoff = await current(); flow.prompts.resume = handoff.prompt;
    const resumeResult = await submit(handoff, { resume: { schemaVersion: 'structured-resume.v1', identity, roles: [{ id: roleId, title: spec.title, company: spec.employer, dates: `${spec.start} – Present`, location: '', bullets: [{ id: 'bullet-1', text: bullet, evidenceIds: [achievementId] }] }],
      skills: [{ id: 'skills-main', group: 'Languages', items: [spec.tech], evidenceIds: [skillEvidenceId] }] } });
    ok(resumeResult, 'the résumé is accepted');
    flow.returned['cover-letter'] = resumeResult.handoff?.prompt;
    handoff = await current(); flow.prompts['cover-letter'] = handoff.prompt;
    ok(await submit(handoff, { coverLetter: { name: spec.name, contact: [spec.email], paragraphs: [{ id: 'paragraph-1', text: paragraph, evidenceIds: [achievementId] }], roleThesis: thesis,
      coverLetterArgument: { primaryEvidence: { evidence: bullet, evidenceRole: `${spec.title} at ${spec.employer}`, relationToThesis: `The ${spec.tech} service delivery establishes the supported capability this role needs.` } } } }), 'the letter is accepted');
    while ((await current()).stage === 'requirement-disposition') {
      handoff = await current(); const context = contextOf(handoff.prompt);
      const dispositionResult = await submit(handoff, { version: 1, rootDigest: digestIn(handoff.prompt, 'rootDigest'), requirementPageDigest: digestIn(handoff.prompt, 'requirementPageDigest'), reductionDigest: digestIn(handoff.prompt, 'reductionDigest'), finalReferencesDigest: digestIn(handoff.prompt, 'finalReferencesDigest'),
        rows: context.requirements.map(requirement => {
          const unsupported = context.reduction.find(row => row.requirementId === requirement.id)?.finalStatus === 'unsupported';
          return unsupported
            ? { requirementId: requirement.id, priority: requirement.priority, disposition: 'omitted-no-evidence', justification: 'No approved career evidence supports this requirement, so neither document claims it.', documentRefs: [], proofs: [] }
            : { requirementId: requirement.id, priority: requirement.priority, disposition: 'addressed-both', justification: 'The final résumé and letter each cite the exact selected service evidence for this requirement.', documentRefs: ['resume', 'cover-letter'], proofs: context.proofCandidates.find(row => row.requirementId === requirement.id).candidates };
        }) });
      ok(dispositionResult, 'the dispositions are accepted');
      if (dispositionResult.handoff?.stage === 'review') flow.returned.review = dispositionResult.handoff.prompt;
    }
    handoff = await current();
    assert(handoff.stage === 'review', `${spec.id}: the flow reaches the review (${handoff.stage})`);
    flow.prompts.review = handoff.prompt;
    return flow;
  } catch (error) {
    await flow.cleanup();
    throw error;
  }
}

// The blind-review drivers, adapted from gapfix-repair-convergence.js (they use only the flow object that module's createFlow returns).
async function runBlindCycle(flow, reviewer) {
  const review = await flow.current();
  assert(review.stage === 'review', `expected a review handoff before blind review, found ${review.stage}`);
  const reviewContext = flow.contextOf(review);
  flow.accepted = await flow.submit(review, flow.quality(reviewContext.coverLetter.paragraphs[0].text, reviewContext.resume.roles[0].bullets[0].text));
  assert(flow.accepted.accepted && flow.accepted.handoff?.stage === 'blind-review', `the review pass must enter blind review (${JSON.stringify(flow.accepted.validationErrors || [])})`);
  while (flow.accepted.handoff?.stage === 'blind-review') {
    const handoff = await flow.current(); const prompt = handoff.prompt;
    const track = /TRACK: ([^\n]+)/u.exec(prompt)[1]; const scopeDigest = /"scopeDigest":"([a-f0-9]{64})"/u.exec(prompt)[1];
    const pageIndex = Number(/"pageIndex":(\d+)/u.exec(prompt)[1]); const predecessor = /"previousPageDigest":(null|"[a-f0-9]{64}")/u.exec(prompt)[1];
    const scopeOrdinal = Number(/Each finding id MUST begin "(\d+)-\d+-"/u.exec(prompt)[1]);
    const context = JSON.parse(/<untrusted-evidence-json>\n([\s\S]*?)\n<\/untrusted-evidence-json>/u.exec(prompt)[1]);
    const findings = (reviewer({ track, scopeOrdinal, context, prompt }) || []).map((finding, index) => ({ id: `${scopeOrdinal}-${pageIndex}-${index + 1}`, ruleId: 'review-rule', ...finding }));
    flow.accepted = await flow.submit(handoff, { version: 1, scopeDigest, pageIndex, previousPageDigest: predecessor === 'null' ? null : JSON.parse(predecessor),
      complete: true, decision: findings.length ? 'issues' : 'pass', findings });
  }
}

async function acknowledgeRepairPages(flow) {
  while (flow.accepted.handoff?.stage === 'blind-repair-context') {
    const handoff = await flow.current(); const context = flow.contextOf(handoff);
    const ids = context.packets.map(packet => packet.finding.id);
    flow.accepted = await flow.submit(handoff, { version: 1, planDigest: context.planDigest, pageIndex: context.pageIndex, pageDigest: context.pageDigest, acknowledgedFindingIds: ids });
  }
}

// A minimal local edit to the flagged paragraph that keeps every deterministic check and the argument mapping satisfied.
const LOCAL_EDITS = Object.freeze([(text, spec) => text.replace(`I built ${spec.tech} service`, `I built the ${spec.tech} service`)]);

async function answerRepair(flow, { paragraph }) {
  const handoff = await flow.current();
  assert(handoff.stage === 'review', `expected the repair review, found ${handoff.stage}`);
  const documents = flow.documentsFor({ paragraph });
  flow.accepted = await flow.submit(handoff, { ...flow.quality(paragraph), decision: 'revised',
    findings: [{ id: 'writer-note-1', document: 'coverLetter', targetId: 'paragraph-1', issue: 'Reworked the flagged text.', fix: 'Replaced it with a tighter supported statement.' }], coverLetter: documents.coverLetter });
  assert(flow.accepted.accepted && flow.accepted.handoff?.stage === 'requirement-disposition', `the repair must be accepted and restart disposition (${JSON.stringify(flow.accepted.validationErrors || [])})`);
  await flow.completeDispositions();
}

export default [
  {
    name: 'Guidance rules: every rule is its own generic sentence set, composed once into the block that is printed, and none carries a quotation, a number, or a word of any fixture (5 domains)',
    run() {
      assert(JSON.stringify([...LETTER_RULES].sort()) === JSON.stringify(RULE_NAMES.filter(name => name.startsWith('LETTER_')).sort()), `the letter rules are exactly the exported LETTER_*_RULE constants (${RULE_NAMES})`);
      // A: the block is the rules, once each, in the order the array gives.
      for (const name of LETTER_RULES) {
        assert(typeof guidance[name] === 'string' && guidance[name].length > 80, `${name} is a sentence set`);
        assert(count(guidance.COVER_LETTER_WRITER_GUIDANCE, guidance[name]) === 1, `${name} is printed once in the letter block`);
        assert(guidance.COVER_LETTER_GUIDANCE_RULES.includes(guidance[name]), `${name} is one of the composed rules`);
      }
      assert(guidance.COVER_LETTER_GUIDANCE_RULES.length === LETTER_RULES.length, 'the block holds exactly the letter rules');
      assert(guidance.COVER_LETTER_WRITER_GUIDANCE.endsWith(guidance.COVER_LETTER_GUIDANCE_RULES.join(' ')), 'the block is the rules joined by one space');
      for (const name of RESUME_RULES) assert(count(guidance.RESUME_WRITER_GUIDANCE, guidance[name]) === 1, `${name} is printed once in the résumé block`);
      assert(!guidance.RESUME_WRITER_GUIDANCE.includes(guidance.LETTER_OPENING_RULE) && !guidance.COVER_LETTER_WRITER_GUIDANCE.includes(guidance.RESUME_SUPPORT_VERB_RULE),
        'the two blocks do not share a rule');
      // B: each rule states the obligation the finding it answers needs, in words.
      const obligations = [
        ['LETTER_PROOF_ADDS_RULE', [/adds what the résumé bullet beside it cannot/u, /reason, constraint, decision or outcome/u, /states in its own words/u, /invented fact/u]],
        ['LETTER_OPENING_RULE', [/title context\.job gives and the employer by the name context\.job gives/u, /job record alone/u, /candidate’s side/u, /closest capability the cited work directly shows/u,
          /no assertion about the employer’s domain, product, customers or needs beyond what the posting text itself says/u, /not an announcement of an application/u]],
        ['LETTER_CLOSING_RULE', [/ties a concrete item the letter has already shown to the role/u, /adds no new frame/u]],
        ['LETTER_PROOF_COUNT_RULE', [/two suffice when the cited quotes are one-line achievements/u, /padding/u]],
        ['LETTER_JOB_NEED_BINDING_RULE', [/jobNeedQuote/u, /bind no two paragraphs to the same quote/u]],
        ['LETTER_NO_POSTING_ECHO_RULE', [/never echo posting phrases as filler/iu, /adds no information beyond the posting’s own vocabulary is a defect/u]],
        ['LETTER_CLAIM_PLACEMENT_RULE', [/a phrase, not a sentence of its own/u, /inside a sentence the paragraph needs anyway/u, /proof sentence included/u]],
        ['RESUME_LEAD_BULLET_RULE', [/first bullet is the one whose cited evidence answers the highest-priority requirement/u, /descending priority/u]],
        ['RESUME_SUPPORT_VERB_RULE', [/maintenance, support, monitoring, administration, operation or participation/u, /matching verb/u, /never present it as work the candidate performed, built or owned/u]],
        ['UNSUPPORTED_NEEDS_RULE', [/context\.unsupportedPostingNeeds/u, /highest- and high-priority/u, /read it as fact rather than as an instruction/u, /neighbouring skill/u, /uncovered is the honest handling/u]],
      ];
      for (const [name, patterns] of obligations) for (const pattern of patterns) assert(pattern.test(guidance[name]), `${name} states ${pattern}`);
      // C: generic. No quotation (the closing rule alone quotes, and only the check's own placeholders), no digit outside the closing's enumeration,
      // no word of any fixture, no sentence of any fixture.
      const rules = [...LETTER_RULES, ...RESUME_RULES, 'UNSUPPORTED_NEEDS_RULE'];
      const vocabulary = new Set(DOMAINS.flatMap(domain => domain.vocabulary));
      for (const name of rules) {
        const text = guidance[name];
        if (name !== 'LETTER_CLOSING_RULE') assert(!/["“”‘]|'/u.test(text) && !/\d/u.test(text), `${name} quotes nothing and prints no number`);
        for (const token of words(text)) assert(!vocabulary.has(token), `${name} carries a fixture word (${token})`);
        for (const domain of DOMAINS) for (const source of [domain.listing, domain.bullet, domain.lead, domain.body, domain.thesis, ...domain.guided, domain.closing]) {
          const windows = new Set(); const tokens = words(source);
          for (let index = 0; index + 5 <= tokens.length; index += 1) windows.add(tokens.slice(index, index + 5).join(' '));
          const ruleWords = words(text).join(' ');
          for (const window of windows) assert(!ruleWords.includes(window), `${name} repeats a five-word run of ${domain.key} (${window})`);
        }
      }
      // The claim rule is built from the constant that counts the paragraphs, so its own phrase is the one the other rules print.
      assert(guidance.LETTER_CLAIM_PLACEMENT_RULE.includes(OWING_CLAIM_PARAGRAPHS), 'the claim placement rule names the paragraphs from the constant');
    },
  },
  {
    name: 'Closing: the grammar the stage contract prints is the check’s own wording, and a closing written to it passes the whole battery while the same closing without its employer half does not (A / B / C, 3 domains)',
    run() {
      const parts = closingContributionParts();
      assert(parts.length === 3 && parts.every(part => part.length > 40), 'the check reports three parts');
      for (const [index, part] of parts.entries()) assert(guidance.LETTER_CLOSING_RULE.includes(`(${index + 1}) ${part}`), `the printed rule carries part ${index + 1} exactly as the check words it`);
      // The words are the ones the check emits when a closing is missing every part, so a writer reads the same sentence in the contract and in a rejection.
      const emitted = checkDirectWelcomeClosing(['I welcome a conversation.'], '');
      assert(!emitted.passed && parts.every(part => emitted.detail.includes(part)), `the rejection prints the same three parts (${emitted.detail})`);
      for (const domain of DOMAINS) {
        const battery = closing => evaluateCoverLetterChecks({
          plan: {}, paragraphs: [...domain.guided, closing], evidence: { roles: [{ company: 'Regional Haulage' }], projects: [], bullets: [] },
          jobText: domain.listing, researchText: '', companyName: domain.employer,
        });
        const failed = results => results.filter(check => !check.passed).map(check => `${check.id}: ${check.detail}`);
        // A: the letter written to the guidance passes every check the battery runs.
        assert(failed(battery(domain.closing)).length === 0, `${domain.key}/A: a letter with a named opening, two proofs that add their reason, and a three-part close passes (${failed(battery(domain.closing))})`);
        // B: an invitation that names the asset and never reaches the employer is the defect the contract now states in advance.
        const withoutEmployer = failed(battery(`I welcome a conversation about my ${domain.asset} work.`));
        assert(withoutEmployer.some(message => message.startsWith('direct-welcome-closing:')), `${domain.key}/B: an invitation with no employer side is rejected (${withoutEmployer})`);
        // C: giving the same invitation the employer's side is accepted.
        const repaired = failed(battery(`I welcome a conversation about applying my ${domain.asset} work to ${domain.employerSide}.`));
        assert(!repaired.some(message => message.startsWith('direct-welcome-closing:')), `${domain.key}/C: the same invitation reaching the employer is accepted (${repaired})`);
      }
    },
  },
  {
    name: 'Opening: an opening that names the role and the employer from the job record and states the closest capability passes the whole battery, and one that announces the application does not (A / B, 3 domains)',
    run() {
      for (const domain of DOMAINS) {
        const battery = paragraphs => evaluateCoverLetterChecks({
          plan: {}, paragraphs, evidence: { roles: [{ company: 'Regional Haulage' }], projects: [], bullets: [] },
          jobText: domain.listing, researchText: '', companyName: domain.employer,
        });
        const failed = paragraphs => battery(paragraphs).filter(check => !check.passed).map(check => check.id);
        const rest = [...domain.guided.slice(1), domain.closing];
        assert(domain.guided[0].includes(domain.title) && domain.guided[0].includes(domain.employer), `${domain.key}: the guided opening names the title and the employer`);
        assert(failed([domain.guided[0], ...rest]).length === 0, `${domain.key}/A: a named, candidate-side opening passes (${failed([domain.guided[0], ...rest])})`);
        // B: the announcement the rule says this is not.
        const announced = `I am applying for the ${domain.title} role at ${domain.employer}.`;
        assert(failed([announced, ...rest]).length > 0, `${domain.key}/B: an announcement of the application is still rejected by the battery (${failed([announced, ...rest])})`);
      }
    },
  },
  {
    name: 'Mutation: rewriting the claim budget and the closing wording in a temporary copy of the checks changes what the guidance prints, the real modules are unchanged (A / B / C)',
    async run() {
      const source = read('electron/ipc/coverLetterChecks.js');
      const budget = 'export const MAX_EXPLICIT_CLAIM_PARAGRAPHS = 1;';
      const action = 'say what that asset does for the target work';
      assert(count(source, budget) === 1 && count(source, action) === 1, 'each mutated declaration is written once');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v16-guidance-mutation-'));
      try {
        const guidanceSource = absolutize(read('electron/ipc/applicationWriterGuidance.js'));
        const build = async (name, mutate) => {
          const checks = await loadCopy(dir, `checks-${name}`, absolutize(mutate(source)));
          const copy = await loadCopy(dir, `guidance-${name}`, guidanceSource.replace(realUrl('coverLetterChecks.js'), checks.url));
          return copy.module;
        };
        const control = await build('control', text => text);
        const two = await build('two', text => text.replace(budget, 'export const MAX_EXPLICIT_CLAIM_PARAGRAPHS = 2;'));
        const reworded = await build('reworded', text => text.replace(action, 'state what that asset changes for the target work'));
        // A: the copy with the real number prints the real text.
        assert(control.LETTER_CLAIM_PLACEMENT_RULE === guidance.LETTER_CLAIM_PLACEMENT_RULE && control.LETTER_CLOSING_RULE === guidance.LETTER_CLOSING_RULE
          && control.COVER_LETTER_WRITER_GUIDANCE === guidance.COVER_LETTER_WRITER_GUIDANCE, 'an unmutated copy prints exactly what the real module prints');
        // B: the number moves the phrase; the closing wording follows the check.
        assert(two.LETTER_CLAIM_PLACEMENT_RULE.includes('each of the first 2 proof-bearing paragraphs of the letter') && !two.LETTER_CLAIM_PLACEMENT_RULE.includes(OWING_CLAIM_PARAGRAPHS)
          && two.COVER_LETTER_WRITER_GUIDANCE.includes('each of the first 2 proof-bearing paragraphs'), 'the claim budget reaches the printed guidance from the constant');
        assert(reworded.LETTER_CLOSING_RULE.includes('state what that asset changes for the target work') && !reworded.LETTER_CLOSING_RULE.includes(action)
          && reworded.COVER_LETTER_WRITER_GUIDANCE.includes('state what that asset changes for the target work'), 'the closing wording reaches the printed guidance from the check');
        // C: the rest of the guidance is untouched by either mutation, and the real module is as it was.
        for (const name of LETTER_RULES.filter(rule => !['LETTER_CLAIM_PLACEMENT_RULE', 'LETTER_CLOSING_RULE'].includes(rule))) {
          assert(two[name] === guidance[name] && reworded[name] === guidance[name], `${name} does not move with a number or a wording it is not built from`);
        }
        assert(guidance.LETTER_CLAIM_PLACEMENT_RULE.includes(OWING_CLAIM_PARAGRAPHS) && guidance.LETTER_CLOSING_RULE.includes(action), 'the real module is unchanged by the temporary copies');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Unsupported needs, bounded: only the highest and high priorities, in priority then arrival order, de-duplicated, clipped on a word boundary, capped with the remainder counted, and absent when empty (3 careers, A / B / C)',
    run() {
      for (const set of REQUIREMENT_SETS) {
        const rows = set.rows.map(({ id, text, priority }) => ({ id, text, priority, candidateSupport: 'unsupported' }));
        const fromPlan = guidance.unsupportedNeedsFromPlan(rows);
        assert(fromPlan.length === rows.length && fromPlan.every(row => Object.keys(row).sort().join() === 'id,priority,text'), `${set.key}/A: the plan adapter keeps id, text and priority of what the plan marked unsupported`);
        const bounded = guidance.boundedUnsupportedNeeds(fromPlan);
        const expected = set.rows.filter(row => row.priority !== 'supporting');
        const order = expected.filter(row => row.priority === 'highest').concat(expected.filter(row => row.priority === 'high'));
        assert(JSON.stringify(bounded.requirements.map(row => row.id)) === JSON.stringify(order.map(row => row.id)) && bounded.omitted === 0,
          `${set.key}/A: highest before high, arrival order within a priority, supporting never listed (${JSON.stringify(bounded)})`);
        // B: flipping the plan's mark removes the row; an absent mark lists nothing.
        const supported = rows.map(row => (row.id === order[0].id ? { ...row, candidateSupport: 'supported' } : row));
        assert(!guidance.unsupportedNeedsFromPlan(supported).some(row => row.id === order[0].id), `${set.key}/B: a requirement the plan marks supported is not listed`);
        assert(guidance.unsupportedNeedsFromPlan(set.rows).length === 0 && guidance.boundedUnsupportedNeeds([]) === null && guidance.boundedUnsupportedNeeds(null) === null && guidance.boundedUnsupportedNeeds(undefined) === null,
          `${set.key}/B: with no mark, an empty list or no list, nothing is printed`);
        assert(guidance.boundedUnsupportedNeeds(set.rows.map(row => ({ ...row, priority: 'supporting' }))) === null, `${set.key}/B: a list of only supporting priorities prints nothing`);
        // C: de-duplicated by id, malformed rows ignored, and the flip back restores the verdict.
        const messy = [...fromPlan, { ...fromPlan[0], text: 'a duplicate id with other text' }, null, { id: '', text: 'no id', priority: 'high' }, { id: 'x', text: '   ', priority: 'high' }, { id: 'y', text: 'bad priority', priority: 'urgent' }];
        assert(guidance.boundedUnsupportedNeeds(messy).requirements.length === order.length, `${set.key}/C: duplicates and malformed rows are ignored`);
        assert(guidance.boundedUnsupportedNeeds(guidance.unsupportedNeedsFromPlan(rows)).requirements.some(row => row.id === order[0].id), `${set.key}/C: restoring the mark restores the row`);
      }
      // The cap and the clip.
      const many = Array.from({ length: guidance.UNSUPPORTED_NEEDS_MAX_ROWS + 5 }, (_unused, index) => ({ id: `n-${index}`, text: `Requirement number ${index}`, priority: index % 2 ? 'high' : 'highest' }));
      const capped = guidance.boundedUnsupportedNeeds(many);
      assert(capped.requirements.length === guidance.UNSUPPORTED_NEEDS_MAX_ROWS && capped.omitted === 5, `at most ${guidance.UNSUPPORTED_NEEDS_MAX_ROWS} print and the rest are counted (${capped.requirements.length}/${capped.omitted})`);
      assert(capped.requirements.every((row, index, list) => index === 0 || list[index - 1].priority === 'highest' || row.priority === 'high'), 'the cap keeps the highest priorities first');
      const long = guidance.boundedUnsupportedNeeds([{ id: 'l', priority: 'high', text: `${'word '.repeat(200)}tail` }]).requirements[0].text;
      assert(long.length <= guidance.UNSUPPORTED_NEED_TEXT_CHARS && long.endsWith('…') && !long.includes('wor…') && /word…$/u.test(long), `a long requirement is clipped on a word boundary (${long.length})`);
      assert(guidance.boundedUnsupportedNeeds([{ id: 's', priority: 'high', text: 'two\n   lines\tand   spaces' }]).requirements[0].text === 'two lines and spaces', 'whitespace is flattened');
    },
  },
  {
    name: 'Unsupported needs, from the store: the reduction receipt names the requirements no catalog evidence matched, flipping one match removes it, and only highest and high priorities are kept (3 careers, A / B / C)',
    async run() {
      const CAREERS = [
        { key: 'civil site inspection', title: 'Site Inspector', employer: 'Lakeshore Civil', claim: 'Inspected concrete pours against engineer drawings for twelve bridge decks.',
          reqs: [{ text: 'Inspect concrete pours against engineer drawings', priority: 'highest', matches: true }, { text: 'Hold a confined space entry permit', priority: 'high', matches: false },
            { text: 'Operate a total station', priority: 'highest', matches: false }, { text: 'Report weekly progress to owners', priority: 'supporting', matches: false }] },
        { key: 'retail analytics', title: 'Merchandise Analyst', employer: 'Brightfield Stores', claim: 'Forecast weekly basket size by store format for ninety grocery stores.',
          reqs: [{ text: 'Forecast weekly basket size by store format', priority: 'high', matches: true }, { text: 'Negotiate vendor rebates', priority: 'highest', matches: false }] },
        { key: 'clinic scheduling', title: 'Booking Lead', employer: 'Willowbrook Clinic', claim: 'Scheduled appointment slots across eight exam rooms using a shared calendar.',
          reqs: [{ text: 'Schedule appointment slots across exam rooms', priority: 'highest', matches: true }, { text: 'Hold a medical coding certificate', priority: 'high', matches: false },
            { text: 'Verify insurance eligibility', priority: 'high', matches: false }] },
      ];
      for (const career of CAREERS) {
        const snapshot = {
          snapshotId: `v16-${career.key.replace(/\W+/gu, '-')}`, status: CAREER_SNAPSHOT_STATUS_APPROVED,
          profile: {
            identity: { name: 'Synthetic Candidate', contacts: ['candidate@example.test'] },
            roles: [{ id: 'role-1', title: career.title, employer: career.employer, startDate: '2019', endDate: '2024', location: '', achievementIds: ['ach-1'], skillIds: [] }],
            achievements: [{ id: 'ach-1', roleId: 'role-1', claim: career.claim }],
            projects: [], skills: [], education: [], certifications: [], otherEvidence: [],
          },
        };
        const authority = buildApplicationCareerAuthority(snapshot);
        const catalog = approvedCareerEvidenceCatalog(snapshot);
        const achievementId = catalog.find(item => String(item.id).startsWith('host.career.achievement.ach-1'))?.id;
        assert(achievementId, `${career.key}: the fixture exposes its achievement`);
        const run = async (reqs, { priorities = null } = {}) => {
          const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'v16-unsupported-'));
          try {
            const store = await createAuthorityLedgerStore(root, { namespace: 'v16', genesis: { jobId: 'v16' } });
            await store.appendReceiptPage('requirements', reqs.flatMap((req, index) => [
              { id: `listing-${index}`, kind: 'listing-evidence', item: { id: `listing-${index}`, sourceId: 'job-listing', quote: `Need ${req.text}.`, requirement: req.text, priority: priorities?.[index] || req.priority } },
              { id: `requirement-${index}`, kind: 'requirement', item: { id: `requirement-${index}`, text: req.text, priority: priorities?.[index] || req.priority, evidenceIds: [`listing-${index}`] } },
            ]));
            await store.appendReceiptPage('catalog', catalog.map(item => ({ id: `catalog:${item.id}`, kind: 'catalog-evidence', item })));
            const receipt = store.receipt();
            const workflow = { root: createStoreAuthorityWorkflowRoot({ requirements: receipt.streams.requirements, catalog: receipt.streams.catalog, rolesDigest: 'roles', skillsDigest: 'skills', catalogPageSize: 24 }) };
            const requirementPage = await store.getReceiptPage('requirements', 0); const catalogPage = await store.getReceiptPage('catalog', 0);
            const pair = storeRequirementCatalogPairDescriptor(workflow.root, { requirementPage, catalogPage });
            await store.appendReceiptPage('matches', [{ id: 'match:0', receipt: createStoreMatchReceipt({ root: workflow.root, pair, response: {
              version: 1, rootDigest: workflow.root.digest, pairDigest: pair.digest,
              rows: reqs.map((req, index) => ({ requirementId: `requirement-${index}`, candidateEvidenceIds: req.matches ? [achievementId] : [], localStatus: req.matches ? 'matched' : 'no-match' })),
            } }) }]);
            const input = { careerAuthority: { snapshotId: authority.snapshotId }, sourceRoles: authority.sourceRoles, careerSkillEvidence: { version: 1, skills: [] }, hostCareerEvidenceCatalog: catalog };
            Object.defineProperty(input, '__careerAuthorityIndex', { value: authority, enumerable: false });
            const selection = await __currentAuthorityDraftSelectionForTests(store, workflow, input);
            await store.appendReceiptPages(selection.transactionEntries);
            return await __currentAuthorityUnsupportedNeedsForTests(store, input, workflow);
          } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
        };
        const expected = career.reqs.filter(req => !req.matches && req.priority !== 'supporting').map(req => req.text).sort();
        // A: the unsupported, listed priorities are exactly the unmatched ones.
        const baseline = await run(career.reqs);
        assert(JSON.stringify(baseline.map(row => row.text).sort()) === JSON.stringify(expected), `${career.key}/A: the store names the unmatched highest and high requirements (${JSON.stringify(baseline)})`);
        assert(baseline.every(row => /^requirement-\d+$/u.test(row.id) && ['highest', 'high'].includes(row.priority)), `${career.key}/A: rows carry the requirement id and its priority`);
        // B: matching one of them removes exactly that one.
        const flipIndex = career.reqs.findIndex(req => !req.matches && req.priority !== 'supporting');
        const flipped = await run(career.reqs.map((req, index) => (index === flipIndex ? { ...req, matches: true } : req)));
        assert(flipped.length === baseline.length - 1 && !flipped.some(row => row.text === career.reqs[flipIndex].text), `${career.key}/B: a matched requirement leaves the list (${JSON.stringify(flipped)})`);
        // C: demoting one to a supporting priority removes it; restoring it puts it back.
        const demoted = await run(career.reqs, { priorities: career.reqs.map((req, index) => (index === flipIndex ? 'supporting' : req.priority)) });
        assert(demoted.length === baseline.length - 1, `${career.key}/C: a supporting priority is not kept (${JSON.stringify(demoted)})`);
        assert((await run(career.reqs)).length === baseline.length, `${career.key}/C: restoring the priority restores the row`);
        // The bounded context the prompt prints is the same rows, by id.
        const printed = guidance.boundedUnsupportedNeeds(baseline);
        assert(printed.omitted === 0 && printed.requirements.length === baseline.length, `${career.key}: the prompt context lists every row`);
      }
    },
  },
  {
    name: 'Unsupported needs, through the real protocol: the résumé, the letter and the review each carry the unsupported highest and high requirements with their rule, and a flow whose requirements are all supported carries neither (3 careers, A / B / C)',
    async run() {
      for (const spec of GAP_SPECS) {
        const gapped = await createGapFlow(spec);
        const supported = spec === GAP_SPECS[0] ? await createGapFlow(spec, { matchGap: true }) : null;
        try {
          for (const stage of ['resume', 'cover-letter', 'review']) {
            const prompt = gapped.prompts[stage];
            const printed = contextOf(prompt).unsupportedPostingNeeds;
            // The handoff the accepting submit returned is the first prompt the app shows; it must carry the same list a reopened dialog does.
            assert(gapped.returned[stage] && JSON.stringify(contextOf(gapped.returned[stage]).unsupportedPostingNeeds) === JSON.stringify(printed) && count(contractOf(gapped.returned[stage]), guidance.UNSUPPORTED_NEEDS_RULE) === 1,
              `${spec.id}/${stage}/A: the handoff the previous submit returned carries the same list and rule`);
            // A: exactly the unmatched high-priority requirement, by the id and text the listing page recorded; the supporting-priority one is not listed.
            assert(printed && printed.omitted === 0 && printed.requirements.length === 1, `${spec.id}/${stage}/A: one requirement is listed (${JSON.stringify(printed)})`);
            assert(printed.requirements[0].id === 'p1-gap' && printed.requirements[0].priority === 'high' && printed.requirements[0].text === spec.gap, `${spec.id}/${stage}/A: it is the unmatched high requirement (${JSON.stringify(printed.requirements[0])})`);
            assert(!JSON.stringify(printed).includes(spec.lowGap), `${spec.id}/${stage}/A: a supporting-priority gap is not listed`);
            // The rule that explains the key is printed once, with it, and in the contract (never in the data).
            assert(count(contractOf(prompt), guidance.UNSUPPORTED_NEEDS_RULE) === 1, `${spec.id}/${stage}/A: the rule is printed once in the contract`);
            // The listed requirement is a requirement the writer's own evidence plan never prints: the draft view carries supported ones only.
            const plan = contextOf(prompt).evidencePlan;
            assert(!plan.requirements.some(requirement => requirement.id === 'p1-gap'), `${spec.id}/${stage}/A: the draft evidence plan lists only supported requirements`);
          }
          // The guidance for the document each stage writes is printed there too, in the form this protocol gives it.
          assert(count(contractOf(gapped.prompts['cover-letter']), forCurrentAuthority(guidance.COVER_LETTER_WRITER_GUIDANCE)) === 1, `${spec.id}: the letter guidance reaches the current-authority cover-letter stage`);
          assert(count(contractOf(gapped.prompts.resume), forCurrentAuthority(guidance.RESUME_WRITER_GUIDANCE)) === 1, `${spec.id}: the résumé guidance reaches the current-authority résumé stage`);
          assert(count(contractOf(gapped.prompts.review), forCurrentAuthority(guidance.COVER_LETTER_WRITER_GUIDANCE)) === 1 && count(contractOf(gapped.prompts.review), forCurrentAuthority(guidance.RESUME_WRITER_GUIDANCE)) === 1,
            `${spec.id}: the review that may rewrite either document carries both blocks`);
          assert(!contractOf(gapped.prompts.resume).includes(forCurrentAuthority(guidance.LETTER_OPENING_RULE)), `${spec.id}: the résumé stage prints no letter rule`);
          // B: the same career with the gap matched lists nothing, and prints no rule that describes a key it does not carry.
          if (supported) {
            for (const stage of ['resume', 'cover-letter', 'review']) {
              assert(contextOf(supported.prompts[stage]).unsupportedPostingNeeds === undefined, `${spec.id}/${stage}/B: with every requirement supported the key is absent`);
              assert(!supported.prompts[stage].includes(guidance.UNSUPPORTED_NEEDS_RULE), `${spec.id}/${stage}/B: and so is the rule`);
            }
            // C: and the verdict is the match, not the career: the gapped flow of the same spec still lists it.
            assert(contextOf(gapped.prompts.resume).unsupportedPostingNeeds.requirements[0].id === 'p1-gap', `${spec.id}/C: flipping the match back lists the requirement again`);
          }
        } finally {
          await gapped.cleanup();
          if (supported) await supported.cleanup();
        }
      }
    },
  },
  {
    name: 'Stage prompts: the letter guidance is printed once in the cover-letter stage and the review, the résumé guidance once in the résumé stage and the review, neither before the plan, and no contract carries a string from any fixture (3 domains)',
    async run() {
      const outs = [];
      try {
        for (const domain of DOMAINS) {
          const out = await walk(domain);
          outs.push(out);
          const heads = Object.fromEntries(Object.entries(out.prompts).map(([stage, prompt]) => [stage, contractOf(prompt)]));
          // A: where each block is printed, exactly once.
          const expected = { 'evidence-plan': [0, 0], resume: [0, 1], 'cover-letter': [1, 0], review: [1, 1] };
          for (const [stage, [letter, resume]] of Object.entries(expected)) {
            assert(count(heads[stage], guidance.COVER_LETTER_WRITER_GUIDANCE) === letter, `${domain.key}/${stage}/A: the letter guidance is printed ${letter} time(s)`);
            assert(count(heads[stage], guidance.RESUME_WRITER_GUIDANCE) === resume, `${domain.key}/${stage}/A: the résumé guidance is printed ${resume} time(s)`);
            for (const name of LETTER_RULES) assert(count(heads[stage], guidance[name]) === letter, `${domain.key}/${stage}/A: ${name} is printed ${letter} time(s)`);
          }
          // B: no unsupported-needs rule without the key it explains (the legacy walker has no gap).
          for (const [stage, prompt] of Object.entries(out.prompts)) assert(!prompt.includes('unsupportedPostingNeeds'), `${domain.key}/${stage}/B: nothing describes a key that is not carried`);
          // C: no contract names a candidate, an employer, a title, or a five-word run of any posting, bullet or letter of any fixture.
          const fixtureWords = new Set(DOMAINS.flatMap(item => item.vocabulary));
          for (const [stage, head] of Object.entries(heads)) {
            const headWords = words(head);
            for (const token of headWords) assert(!fixtureWords.has(token), `${domain.key}/${stage}/C: the contract carries a fixture word (${token})`);
            const joined = headWords.join(' ');
            for (const other of DOMAINS) for (const source of [other.listing, other.bullet, other.lead, other.body, other.thesis, ...other.guided, other.closing]) {
              const tokens = words(source);
              for (let index = 0; index + 5 <= tokens.length; index += 1) assert(!joined.includes(tokens.slice(index, index + 5).join(' ')), `${domain.key}/${stage}/C: the contract repeats a run of ${other.key} (${tokens.slice(index, index + 5).join(' ')})`);
            }
          }
          // The résumé guidance names the order of a role's bullets and the verb that keeps the candidate's part; the letter guidance does not.
          assert(heads.resume.includes('the first bullet is the one whose cited evidence answers the highest-priority requirement') && !heads.resume.includes('Letter writing guidance'), `${domain.key}: the résumé stage carries the résumé block only`);
          // The opening policy no longer says a role title is allowed only when it distinguishes the target responsibility, and it says where the role and the
          // employer are named once: in the guidance's opening rule, not again in the opening-context rule.
          assert(!heads['cover-letter'].includes('A role title belongs there only when it distinguishes') && !heads['cover-letter'].includes('The role title and the employer’s name belong in the opening')
            && heads['cover-letter'].split(guidance.LETTER_OPENING_RULE).length === 2,
          `${domain.key}: the opening rule places the role title and the employer once, where the guidance does`);
        }
        // Three domains' contracts are the same text apart from the job-specific stage numbers they print, so the guidance is not a function of the career.
        const lettersOf = outs.map(out => contractOf(out.prompts['cover-letter']).slice(contractOf(out.prompts['cover-letter']).indexOf('Letter writing guidance')));
        assert(lettersOf.every(text => text === lettersOf[0] && text.length > 2500), 'the letter guidance and what follows it is the same for every career');
      } finally {
        await cleanup(outs);
      }
    },
  },
  {
    name: 'Prompt builder, mutated: in a temporary copy of the builder wired to a temporary copy of the guidance whose every rule is marked, each mark is printed where it belongs and nowhere else, correction rounds included (3 domains, A / B / C)',
    async run() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v16-builder-mutation-'));
      const outs = [];
      try {
        const ALL_RULES = [...LETTER_RULES, ...RESUME_RULES, 'UNSUPPORTED_NEEDS_RULE'];
        const mark = name => `@@${name}@@`;
        // Every rule's declaration gets a mark in front of its text; the composed blocks then carry the marks without being touched.
        let marked = read('electron/ipc/applicationWriterGuidance.js');
        for (const name of ALL_RULES) {
          const declaration = `export const ${name} = `;
          assert(count(marked, declaration) === 1, `${name} is declared once`);
          marked = marked.replace(declaration, `${declaration}'${mark(name)} ' + `);
        }
        const guidanceCopy = await loadCopy(dir, 'guidance-marked', absolutize(marked));
        const builderSource = absolutize(read('electron/ipc/localAiApplication.js')).replace(realUrl('applicationWriterGuidance.js'), guidanceCopy.url);
        assert(builderSource.includes(guidanceCopy.url) && !builderSource.includes(realUrl('applicationWriterGuidance.js')), 'the copy of the builder reads the marked guidance');
        const builder = await loadCopy(dir, 'builder-marked', builderSource);
        // The plain-text career jobs this walker queues exist only as a fixture path; the strict queue export wants an approved snapshot.
        const api = { queueLocalApplicationJob: builder.module.__queueLegacyLocalApplicationFixtureForTests, getLocalApplicationHandoff: builder.module.getLocalApplicationHandoff,
          submitLocalApplicationHandoff: builder.module.submitLocalApplicationHandoff };
        assert(Object.values(api).every(fn => typeof fn === 'function') && builder.module.pasteCorrectionPrompt !== pasteCorrectionPrompt && builder.module.getLocalApplicationHandoff !== getLocalApplicationHandoff,
          'the copy is a separate instance of the builder');
        for (const domain of DOMAINS) {
          const out = await walk(domain, api, { probe: true });
          outs.push(out);
          const heads = Object.fromEntries(Object.entries(out.prompts).map(([stage, prompt]) => [stage, contractOf(prompt)]));
          const has = (head, name) => count(head, mark(name));
          // A: the marks in each stage's contract are the rules that stage prints, once.
          for (const name of LETTER_RULES) {
            assert(has(heads['cover-letter'], name) === 1 && has(heads.review, name) === 1, `${domain.key}/A: ${name} is printed once in the letter stage and once in the review`);
            assert(has(heads.resume, name) === 0 && has(heads['evidence-plan'], name) === 0, `${domain.key}/A: ${name} is printed in neither the résumé stage nor the plan`);
          }
          for (const name of RESUME_RULES) {
            assert(has(heads.resume, name) === 1 && has(heads.review, name) === 1, `${domain.key}/A: ${name} is printed once in the résumé stage and once in the review`);
            assert(has(heads['cover-letter'], name) === 0 && has(heads['evidence-plan'], name) === 0, `${domain.key}/A: ${name} is printed in neither the letter stage nor the plan`);
          }
          for (const stage of Object.keys(heads)) assert(has(heads[stage], 'UNSUPPORTED_NEEDS_RULE') === 0, `${domain.key}/A: ${stage}: the unsupported-needs rule is not printed without the key it explains`);
          // B: a letter-paragraph correction restates the three rules a rewrite is invited to forget, and not the others; a bullet correction restates the verb rule only.
          const paragraphCorrection = out.corrections.paragraph; const bulletCorrection = out.corrections.bullet;
          for (const name of ['LETTER_PROOF_ADDS_RULE', 'LETTER_JOB_NEED_BINDING_RULE', 'LETTER_NO_POSTING_ECHO_RULE']) assert(has(paragraphCorrection, name) === 1, `${domain.key}/B: the paragraph correction restates ${name} once`);
          for (const name of ['LETTER_OPENING_RULE', 'LETTER_CLOSING_RULE', 'LETTER_PROOF_COUNT_RULE', 'LETTER_CLAIM_PLACEMENT_RULE', ...RESUME_RULES]) assert(has(paragraphCorrection, name) === 0, `${domain.key}/B: the paragraph correction does not restate ${name}`);
          assert(has(bulletCorrection, 'RESUME_SUPPORT_VERB_RULE') === 1 && has(bulletCorrection, 'RESUME_LEAD_BULLET_RULE') === 0 && LETTER_RULES.every(name => has(bulletCorrection, name) === 0),
            `${domain.key}/B: the bullet correction restates the verb rule and nothing about a letter`);
          // C: the marks come from the copy: the real builder's prompts carry none.
          const real = await walk(domain);
          outs.push(real);
          for (const prompt of Object.values(real.prompts)) assert(!prompt.includes('@@'), `${domain.key}/C: the real builder prints no mark`);
        }
      } finally {
        await cleanup(outs);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Correction brief: the letter-writing entry is the last of six, the bullet entry is the last of two, a round that names no prose unit prints neither, and the byte ceiling holds all six (A / B / C)',
    run() {
      const input = { jobId: 'brief-job', qualityChecklist: { criteria: [], version: 4 }, generationAudit: { required: true, version: 1 } };
      const state = stage => ({ stage, handoffCode: 'h', baseHashes: {}, reviewBaseline: null, findings: [] });
      const correct = (stage, items) => pasteCorrectionPrompt({ input, state: state(stage), corrections: items, stagePromptChars: 0 }).prompt;
      const lines = prompt => prompt.split('\n').filter(line => line.startsWith('- '));
      // A: a letter paragraph repair carries six entries and the guidance is the last of them.
      const letter = correct('cover-letter', ['generic-phrases: paragraph 1 uses a stock phrase']);
      assert(lines(letter).length === 6 && lines(letter).at(-1) === `- ${guidance.LETTER_REWRITE_BRIEF_RULE}`, `a letter repair ends on the letter-writing guidance (${lines(letter).length} entries)`);
      assert(guidance.LETTER_REWRITE_BRIEF_RULE === [guidance.LETTER_PROOF_ADDS_RULE, guidance.LETTER_JOB_NEED_BINDING_RULE, guidance.LETTER_NO_POSTING_ECHO_RULE].join(' '), 'the brief entry is the three rules a rewrite forgets, composed from their constants');
      // B: a bullet repair carries the verb rule as its last entry; a thesis-only repair carries no brief at all.
      const bullet = correct('resume', ['resume-bullet-length: bullet 1 is 226 visible characters (budget 180); cut it to 180 or fewer']);
      assert(lines(bullet).at(-1) === `- ${guidance.RESUME_SUPPORT_VERB_RULE}` && !bullet.includes(guidance.LETTER_REWRITE_BRIEF_RULE), 'a bullet repair ends on the verb rule and prints no letter guidance');
      const thesis = correct('cover-letter', ['role-thesis: the thesis is a claim of fit']);
      assert(lines(thesis).length === 0 && !thesis.includes(guidance.LETTER_REWRITE_BRIEF_RULE), 'a round that names no prose unit prints no brief');
      // C: the entry is guidance, so it is the first thing a tight stage-prompt share gives up, and the ceiling no longer drops it when the argument entry is also in play.
      const full = pasteCorrectionPrompt({ input, state: state('cover-letter'), corrections: ['generic-phrases: paragraph 1 uses a stock phrase'], stagePromptChars: 0 }).prompt;
      const roomy = pasteCorrectionPrompt({ input, state: state('cover-letter'), corrections: ['generic-phrases: paragraph 1 uses a stock phrase'], stagePromptChars: full.length * 4 }).prompt;
      assert(roomy === full, 'a roomy stage prompt leaves the correction whole');
      const tight = pasteCorrectionPrompt({ input, state: state('cover-letter'), corrections: ['generic-phrases: paragraph 1 uses a stock phrase'], stagePromptChars: Math.floor(full.length * 1.5) }).prompt;
      assert(lines(tight).length === 0 && tight.length < full.length, 'when the share is tight the whole brief gives way, not the numbered defect list');
      assert(tight.includes('generic-phrases: paragraph 1 uses a stock phrase'), 'the defect list survives every trim');
    },
  },
  {
    name: 'Blind repair brief: the writer’s rule prints the two fixed sentences once, and a real repair cycle shows the typed fields, the 480-character rung, and unitRaisedCycles read from the signed tally across cycles (3 careers, A / B / C)',
    async run() {
      for (const spec of FLOW_SPECS) {
        const flow = await createFlow(spec);
        try {
          // Two cycles re-raise the same unit with different words; the first fix is 300 characters, which the old 240-character limit cut and the new limit shows whole.
          const midFix = `Rewrite this paragraph so that it states the delivery claim once, with the proof beside it. Keep the first sentence and the figure exactly as they are. ${'Name the constraint the team set before the claim. '.repeat(3)}`.trim();
          assert(midFix.length > 240 && midFix.length <= 480, `the fixture fix sits between the old and the new limit (${midFix.length})`);
          const longFix = `${'Reword the claim in plain words. '.repeat(25)}Keep the figure exactly as it is.`;
          assert(longFix.length > 480, 'the long fix exceeds the limit');
          await runBlindCycle(flow, ({ track, context }) => (track === 'fact-fidelity' && context.claim.id.startsWith('letter-')
            ? [{ document: 'cover-letter', targetId: context.claim.id, issue: 'The paragraph repeats one delivery claim without a distinct proof.', fix: midFix }] : []));
          await acknowledgeRepairPages(flow);
          const first = await flow.current(); const firstBrief = contextOf(first.prompt).blindRepairBrief;
          const row = firstBrief.clusters.find(cluster => cluster.unit?.kind === 'letter-paragraph');
          // A: the typed fields exist, the rung is the widest, the 300-character fix is shown whole, and the unit has been raised once.
          assert(firstBrief.textChars === 480 && row.fixTruncated === false && row.issueTruncated === false && row.fix === midFix && row.unitRaisedCycles === 1,
            `${spec.id}/A: first cycle: the fix is whole at the widest rung and the unit is raised once (${JSON.stringify({ textChars: firstBrief.textChars, raised: row.unitRaisedCycles, truncated: row.fixTruncated, length: row.fix.length })})`);
          assert(count(contractOf(first.prompt), BLIND_REPAIR_RAISED_CYCLES_RULE) === 1 && count(contractOf(first.prompt), BLIND_REPAIR_TRUNCATION_RULE) === 1, `${spec.id}/A: the two fixed sentences are printed once in the contract`);
          for (const key of ['unitRaisedCycles', 'issueTruncated', 'fixTruncated']) assert(BLIND_REPAIR_RAISED_CYCLES_RULE.includes(key) || BLIND_REPAIR_TRUNCATION_RULE.includes(key), `${spec.id}/A: the rule names the key ${key} the rows carry`);
          // B: the same unit raised in a second cycle, worded differently and with a fix the limit cuts, is counted twice and flagged cut.
          await answerRepair(flow, { paragraph: LOCAL_EDITS[0](flow.texts.paragraph, spec) });
          await runBlindCycle(flow, ({ track, context }) => (track === 'fact-fidelity' && context.claim.id.startsWith('letter-')
            ? [{ document: 'cover-letter', targetId: context.claim.id, issue: 'Still no distinct proof appears for the repeated delivery claim here.', fix: longFix }] : []));
          await acknowledgeRepairPages(flow);
          const second = await flow.current(); const secondBrief = contextOf(second.prompt).blindRepairBrief;
          const again = secondBrief.clusters.find(cluster => cluster.unit?.kind === 'letter-paragraph');
          assert(again.unitRaisedCycles === 2 && again.fixTruncated === true && again.fix.length <= 480 && again.fix.includes('Keep the figure exactly as it is'),
            `${spec.id}/B: second cycle: raised twice, the long fix is flagged cut and keeps its constraint (${JSON.stringify({ raised: again.unitRaisedCycles, truncated: again.fixTruncated, length: again.fix.length })})`);
          // C: the count is the tally's, not the wording's: a clean cycle in between would have reset it, and the row after a clean cycle starts again at one.
          assert(again.unitRaisedCycles > row.unitRaisedCycles, `${spec.id}/C: the count grew with the cycle although the wording changed`);
        } finally { await flow.cleanup(); }
      }
    },
  },
  {
    name: 'Quality criteria and documents: the canonical criteria and every document that describes the letter contract say what the code does (A / B)',
    run() {
      const criterion = id => APPLICATION_QUALITY_CRITERIA.find(item => item.id === id)?.requirement || '';
      // A: the criteria the review grades by carry the same guidance, without losing what the earlier tests pinned.
      assert(criterion('cover-opening').includes('names the target role by the job record’s title and the employer by name') && criterion('cover-opening').includes('beyond what the posting text states')
        && criterion('cover-opening').includes('opening demonstrates interest implicitly') && !criterion('cover-opening').includes('name the role only when it distinguishes'), 'cover-opening names the role and the employer from the job record, candidate side only');
      assert(criterion('cover-minimum-evidence').includes('strongest two or three proofs') && criterion('cover-minimum-evidence').includes('two paragraphs suffice when the cited quotes are one-line achievements')
        && criterion('cover-minimum-evidence').includes('never restates the bullet or adds a fact the quote does not state'), 'cover-minimum-evidence scales the proof count and says what a paragraph adds');
      assert(criterion('resume-priority-alignment').includes('Within a role, the first bullet is the one that answers the highest-priority requirement that role’s evidence supports'), 'resume-priority-alignment orders each role');
      assert(criterion('resume-source-grounding').includes('maintenance, support, monitoring, administration, operation or participation') && criterion('resume-source-grounding').includes('never as work the candidate performed, built or owned'), 'resume-source-grounding keeps the candidate’s part');
      assert(criterion('cover-register').includes('direct present tense') && criterion('cover-register').includes('tying one concrete item the letter has already shown to the role'), 'cover-register keeps its pinned wording and ties the close to one item');
      // The two paragraph schemas that describe a letter's body carry the same sentence about what a paragraph adds.
      for (const [label, schema] of [['the letter schema', APPLICATION_COVER_LETTER_SCHEMA], ['the direct letter schema', APPLICATION_DIRECT_COVER_LETTER_SCHEMA]]) {
        const description = schema.properties.paragraphs.description;
        assert(description.includes('Each paragraph adds what its résumé bullet cannot, the reason, constraint, decision or outcome that the career-data quote behind it states, and never restates the bullet or adds a fact that quote does not state.')
          && description.includes('no fixed claim-proof-relevance sentence pattern applies'), `${label} tells the writer what a paragraph adds and keeps its earlier sentence`);
      }
      // B: the documents, one statement each, and none of the superseded wording.
      const routine = read('local_ai/LOCAL_AI_APPLICATION_ROUTINE.md').replace(/\s+/gu, ' ');
      const pasteBack = read('local_ai/PASTE_BACK_APPLICATION.md').replace(/\s+/gu, ' ');
      const docs = Object.fromEntries(['SKILL', 'STYLE', 'CONTENT_RULES'].map(name => [name, read(`Job Application Design System/${name}.md`).replace(/\s+/gu, ' ')]));
      assert(routine.includes('let the number follow the evidence: two suffice when the cited quotes are one-line achievements') && routine.includes('adds what the résumé bullet beside it cannot')
        && routine.includes('bind no two paragraphs to the same quote') && routine.includes('adds no information beyond the posting\'s own vocabulary is a defect')
        && routine.includes('three things in it') && routine.includes('reach the employer\'s side in the same sentence') && routine.includes('Name the target role by the title the job record gives and the employer by name in the opening')
        && routine.includes('context.unsupportedPostingNeeds') && routine.includes('the first bullet is the one whose cited evidence answers the highest-priority requirement that role\'s evidence supports')
        && routine.includes('is never presented as work the candidate performed, built or owned'), 'the routine states the letter and résumé guidance');
      assert(!routine.includes('checks two things') && !routine.includes('may appear only when it distinguishes the target responsibility'), 'the routine no longer states the superseded closing count or opening policy');
      assert(pasteBack.includes('`unitRaisedCycles`') && pasteBack.includes('`issueTruncated` and `fixTruncated`') && pasteBack.includes('`context.unsupportedPostingNeeds`') && pasteBack.includes('two suffice when the cited quotes are one-line achievements'),
        'the paste-back guide describes the brief fields, the unsupported-needs context and the proof count');
      const opening = 'by the title the job record gives and the employer by name';
      const statements = {
        SKILL: [`Name the target role ${opening} in the opening`, 'adds what its résumé bullet cannot', 'two suffice when the cited quotes are one-line achievements', 'no two paragraphs to the same quote', 'never a sentence written only to carry it',
          'the first bullet answers the highest-priority requirement that role\'s evidence supports', 'maintenance, support, monitoring, administration, operation or participation', 'is not claimed, implied or approximated in either document'],
        STYLE: [`Name the target role ${opening} in the opening`, 'also adds what its résumé bullet cannot', 'two suffice when the cited quotes are one-line achievements', 'no two paragraphs share one quote', 'never a sentence of its own',
          'ties one concrete item the letter has already shown to the role', 'Never answer a requirement the evidence does not support', 'Never promote the candidate\'s part', 'maintenance, support, monitoring, administration, operation or participation'],
        CONTENT_RULES: [`Name the role ${opening} there`, 'Each body paragraph adds what its résumé bullet cannot', 'Two proof paragraphs suffice when the cited quotes are one-line achievements', 'ties one concrete item the letter has already shown to the role',
          'The first bullet answers the highest-priority requirement that role\'s evidence supports', 'maintenance, support, monitoring, administration, operation or participation'],
      };
      for (const [name, required] of Object.entries(statements)) for (const statement of required) assert(docs[name].includes(statement), `${name}.md says: ${statement}`);
      for (const [name, text] of Object.entries(docs)) assert(!text.includes('role title belongs there only when it distinguishes'), `${name}.md no longer limits the role title to the responsibility it distinguishes`);
    },
  },
];
