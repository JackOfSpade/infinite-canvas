import { assert, fs, getLocalApplicationHandoff, importLocalApplicationJob, os, path, PDFDocument, queueLocalApplicationJob, submitLocalApplicationHandoff, validateLocalApplicationResult } from '../test-dependencies.js';
import { APPLICATION_QUALITY_CHECKLIST_VERSION, APPLICATION_QUALITY_CRITERIA, ARGUMENT_EVIDENCE_REBIND_RULE, ARGUMENT_JOB_NEED_QUOTE_RULE, COVER_LETTER_SECONDARY_NARRATIVE_ROLES, PASTE_EVIDENCE_PRIORITIES, PASTE_FINDING_DOCUMENTS, COVER_LETTER_ARGUMENT_TEXT_LIMITS, GENERATION_AUDIT_TEXT_MINIMUMS, QUALITY_NOTE_MIN_CHARS, QUALITY_NOTE_MIN_WORDS, QUALITY_NOTE_RULE, EVIDENCE_PLAN_CRITERION_IDS, LOCAL_AI_GENERATION_AUDIT_VERSION, MAX_COVER_LETTER_PARAGRAPH_EVIDENCE_IDS, MAX_EVIDENCE_PLAN_EVIDENCE_ITEMS, MAX_EVIDENCE_PLAN_REQUIREMENT_ITEMS, MAX_SOURCE_GROUNDING_QUOTE_CHARS, MIN_SHARED_SOURCE_TERMS, MIN_SOURCE_GROUNDING_QUOTE_CHARS, MIN_SOURCE_GROUNDING_QUOTE_WORDS, PASTE_BASE_HASH_KEYS, PASTE_CHECK_PROSE_UNITS, PASTE_STABLE_ID_PATTERN, pasteRejectionCheckIds, pasteReportableCheckIds, SOURCE_TERM_OVERLAP_RULE, __setLocalAiRenderPdfForTests, localApplicationStatus, updateLocalApplicationDraft } from '../../electron/ipc/localAiApplication.js';
import { EMPTY_JOB_LISTING_BODY_NOTE, ORIGINAL_JOB_LISTING_BODY_HEADING } from '../../electron/ipc/applicationBundle.js';
import { _resetPasteHandoffDiagnostics, getPasteHandoffDiagnosticsSnapshot } from '../../electron/ipc/pasteHandoffDiagnostics.js';
import { CAREER_DATA_ROLE_SECTION_RULE, CAREER_TERM_OVERLAP_RULE, MIN_SHARED_CAREER_TERMS, careerAttestedSkillTerms, requiredCareerAttestedSkillTerms, NEUTRAL_SKILL_GROUP_LABELS, NEUTRAL_SKILL_GROUP_RULE, POSTING_NAMED_SKILLS_RULE, renderStructuredApplicationResume, SKILL_ITEM_FILTERABLE_RULE, SKILL_ITEM_GROUNDING_RULE, SKILLS_BLOCK_BUDGET_RULE, SKILLS_BLOCK_PRESENCE_RULE, STRUCTURED_RESUME_ID_PATTERN, STRUCTURED_RESUME_LIMITS } from '../../electron/ipc/structuredResume.js';
import { ADJACENT_SENTENCE_SHAPE_RULE, LETTER_PROPORTION_RULE, MIN_STANDALONE_SENTENCE_PARAGRAPH_ALLOWANCE, ARGUMENT_CLAIM_SPAN_RULE, ARGUMENT_LATER_RELEVANCE_SPAN_RULE, EXPLICIT_CLAIM_BUDGET_RULE, EXPLICIT_RELEVANCE_BUDGET_RULE, EXPLICIT_TRANSFER_BUDGET_RULE, TRANSFER_BENEFIT_SUPPORT_RULE, ARGUMENT_MAPPING_REQUIRED_RULE, ARGUMENT_SPAN_ALIGNMENT_RULE, ARGUMENT_PROOF_SPAN_RULE, ARGUMENT_RELEVANCE_SPAN_RULE, COVER_LETTER_EQUIVALENCE_CARRIERS, COVER_LETTER_LOGISTICS_PROMISE_CLASSES, COVER_LETTER_SALIENT_ECHO_PHRASES, DURATION_CLAIM_SHAPE_RULE, MAX_LETTER_FIGURES, MAX_LETTER_OFF_POSTING_TOOLS, MAX_PARAGRAPH_OFF_POSTING_TOOLS, MAX_SENTENCE_WORDS, MIN_ANCHOR_RELEVANCE_CORPUS_WORDS, MIN_ROLE_THESIS_WORDS, MIN_SHARED_SHAPE_PARAGRAPHS, DANGLING_DEMONSTRATIVE_RULE, REPEATED_PHRASE_RULE, REPEATED_TRANSFER_CARRIER_RULE, SENTENCE_SHAPE_FRAME_WORDS, SHARED_SENTENCE_SHAPE_CEILING_RULE, PAST_PROOF_VERBS, REDUNDANCY_SHINGLE_WORDS } from '../../electron/ipc/coverLetterChecks.js';
import { assemblePasteApplicationResult, MAX_UNIT_CAREER_DATA_QUOTES } from '../../electron/ipc/pasteApplicationAssembly.js';
import { extractResumeEvidence, RESUME_BULLET_CHARACTER_BUDGET } from '../../electron/ipc/jobApplication.js';
import crypto from 'node:crypto';

async function createCanvasProject() {
  const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'paste-application-flow-')));
  const canvasFilePath = path.join(root, 'Canvas.json');
  await fs.promises.writeFile(canvasFilePath, '{}', 'utf8');
  return { root, canvasFilePath };
}

function reply(handoff, fields) {
  return {
    protocol: 1,
    jobId: handoff.jobId,
    stage: handoff.stage,
    handoffCode: handoff.handoffCode,
    baseHashes: handoff.baseHashes || {},
    ...fields,
  };
}

// The résumé puts these bullets beneath Analytical Engines, so the frozen
// legacy corpus needs a deterministic role boundary too.  A bare collection
// of achievements cannot safely inherit an employer merely because a fixture
// selected it for that role.
const careerData = 'Ada Lovelace\nada@example.test\nSoftware Engineer profile\n\n## Analytical Engines\nSoftware Engineer\n2020 – 2024\n\nBuilt reporting systems that reduced manual work.\nBuilt reporting systems and reduced manual work.\nBuilt reporting systems, reducing manual work.';
const resume = {
  schemaVersion: 'structured-resume.v1',
  identity: { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: 'Software Engineer', credential: '' },
  roles: [{ id: 'role-1', title: 'Software Engineer', company: 'Analytical Engines', dates: '2020 – 2024', location: '', bullets: [{ id: 'bullet-1', text: 'Built reporting systems that reduced manual work.', evidenceIds: ['career-proof'] }] }],
};
const coverLetter = {
  name: 'Ada Lovelace', contact: ['ada@example.test'],
  paragraphs: [{ id: 'paragraph-1', text: 'My reporting-systems experience is the capability this work needs. I built reporting systems that reduced manual work. I would apply that experience to the reporting systems this role needs.', evidenceIds: ['career-proof'] }],
  roleThesis: 'I can apply reporting-system experience to this reliable reporting work.',
  // evidenceRole names the matched résumé role in full: the completion-time
  // grounding pass requires the employer too, and the cover-letter stage now
  // applies that same binding instead of deferring it.
  coverLetterArgument: { primaryEvidence: { evidence: 'Built reporting systems that reduced manual work.', evidenceRole: 'Software Engineer at Analytical Engines', relationToThesis: 'It proves direct reporting-system delivery.' } },
};
function pasteContext(prompt) {
  const marker = '\nAuthoritative context:\n';
  return JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length));
}

// Evidence-plan fixtures mirroring the measured corpus. The real listing holds
// curly apostrophes and fused "sentence.Heading" boundaries; the real career
// file writes "Typescript", "injest", and "evaulation". A quote is validated
// as a raw contiguous substring, so every one of those is a trap for a writer
// who tidies while copying.
const PLAN_EMAIL = 'ada@example.test';
const PLAN_PHONE = '555-0100';
const PLAN_COMPANY = 'Acme Reporting';
// markdownInlineText() escapes the hyphen in the listing companion, so this is
// also the title that reads differently in context.job and context.jobListing.
const PLAN_ESCAPED_TITLE = 'Intermediate Full-Stack Developer';
const VERBATIM_CAREER_LINE = 'Owned the reporting pipeline\u2019s nightly injest in Typescript.';
const VERBATIM_LISTING_LINE = 'We own reporting end to end.What You\u2019ll Bring4+ years of reporting work \u2014 including pipeline ownership.';
const VERBATIM_CAREER_DATA = ['Ada Lovelace', PLAN_EMAIL, PLAN_PHONE, 'Software Engineer profile', '', '## Analytical Engines', 'Software Engineer', '2020 – 2024', '', VERBATIM_CAREER_LINE, 'Ran the quarterly evaulation of reporting coverage.'].join('\n');
const PLAN_PROFILE = { workHistory: [{ id: 'role-1', title: 'Software Engineer', employer: 'Analytical Engines', startDate: '2020', endDate: '2024' }] };
const PLAN_IDENTITY = { name: 'Ada Lovelace', contact: [PLAN_EMAIL], subtitleRole: 'Software Engineer' };
const PLAN_REQUIREMENT = { id: 'need-1', text: 'Reporting pipeline ownership', priority: 'highest', evidenceIds: ['career-proof', 'job-proof'] };

// Work-authorization prose, in the two shapes an application actually
// produces: the candidate's own standing, and the posting's eligibility
// requirement restated in the model's own words. The pipeline reads none of
// it — work authorization is the user's to manage on the application form —
// so every line here is checked for ACCEPTANCE in each plan field it can
// enter through.
const WORK_STATUS_LINES = Object.freeze([
  'I am a Freedonian citizen.',
  'I hold permanent residency in Freedonia.',
  'I have a green card.',
  'I am authorized to work in the United States without sponsorship.',
  'My work authorization is current and requires no renewal.',
  'I will need H-1B visa sponsorship.',
  'Candidate must be located in and authorized to work in Freedonia and align working hours to the Northern Time Zone.',
  'Demonstrate authorization to work in Freedonia.',
]);

function planBody({ career = VERBATIM_CAREER_LINE, listing = VERBATIM_LISTING_LINE } = {}) {
  return {
    identity: PLAN_IDENTITY,
    evidence: [
      { id: 'career-proof', sourceId: 'career-data', quote: career, requirement: 'Pipeline ownership', priority: 'highest' },
      { id: 'job-proof', sourceId: 'job-listing', quote: listing, requirement: 'Pipeline ownership', priority: 'highest' },
    ],
    requirements: [PLAN_REQUIREMENT],
  };
}

function queuePlanJob(project, extras = {}) {
  return queueLocalApplicationJob({
    transport: 'paste', canvasFilePath: project.canvasFilePath, careerData: VERBATIM_CAREER_DATA,
    job: { title: PLAN_ESCAPED_TITLE, company: PLAN_COMPANY, snippet: VERBATIM_LISTING_LINE },
    resumeProfile: PLAN_PROFILE, ...extras,
  });
}

const checklist = () => APPLICATION_QUALITY_CRITERIA.map(({ id }) => ({ id, status: 'pass', detail: 'Checked this criterion against the current structured documents.' }));

// A four-stage flow whose accepted plan raises 13 requirements — one more than
// the literal sanitizeGenerationAudit used to cap the review audit at. The
// corpus and documents are the minimum that satisfy the completion-time
// résumé, letter, and grounding checks, so the only variable under test is
// what the audit says about the plan.
const AUDIT_WORDS = Object.freeze(['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima']);
const AUDIT_BULLET = 'Maintained internal systems with supported delivery practices.';
const AUDIT_PARAGRAPH = 'My experience delivering supported systems is a relevant capability. In my engineering role at Acme, I updated supported systems for internal users. I would apply my experience delivering supported systems to reliable system delivery this role requires.';
const AUDIT_CAREER_DATA = `Ada Lovelace\nada@example.test\nEngineer\n${AUDIT_BULLET}\n${AUDIT_PARAGRAPH}`;
// Keep the thirteenth requirement on the second source page.  This exercises
// the production listing cursor rather than smuggling thirteen items through a
// response whose per-page contract is twelve.
const AUDIT_LISTING = `Engineer role focused on reliable system delivery. The team values ${AUDIT_WORDS.slice(0, -1).map(word => `capability ${word}`).join(', ')}.\n${'Frozen listing context that does not add a requirement.\n'.repeat(300)}capability lima.`;
const AUDIT_IDENTITY = { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: 'Engineer', credential: '' };
const AUDIT_THESIS = 'Reliable system delivery is the supported capability this engineering role needs.';
const auditEvidenceId = name => `${name === 'lima' ? 'p2' : 'p1'}-job-${name}`;
const auditRequirementId = name => `${name === 'lima' ? 'p2' : 'p1'}-need-${name}`;
const AUDIT_TRANSPORT_IDS = new Map([
  ['resume-proof', 'p1-resume-proof'], ['letter-proof', 'p1-letter-proof'], ['job-proof', 'p1-job-proof'],
  ['need-1', 'p1-need-1'],
  ...AUDIT_WORDS.flatMap(word => [[`job-${word}`, auditEvidenceId(word)], [`need-${word}`, auditRequirementId(word)]]),
]);
const auditTransportFields = fields => {
  const rewrite = value => {
    if (typeof value === 'string') return AUDIT_TRANSPORT_IDS.get(value) || value;
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewrite(child)]));
  };
  return rewrite(fields);
};

function auditPlanFixture() {
  return {
    identity: AUDIT_IDENTITY,
    evidence: [
      { id: 'p1-resume-proof', sourceId: 'career-data', quote: AUDIT_BULLET, requirement: 'Reliable system delivery', priority: 'highest' },
      { id: 'p1-letter-proof', sourceId: 'career-data', quote: AUDIT_PARAGRAPH, requirement: 'Reliable system delivery', priority: 'highest' },
      { id: 'p1-job-proof', sourceId: 'job-listing', quote: 'reliable system delivery', requirement: 'Reliable system delivery', priority: 'highest' },
      ...AUDIT_WORDS.map(word => ({ id: auditEvidenceId(word), sourceId: 'job-listing', quote: `capability ${word}`, requirement: `Capability ${word} for the platform`, priority: 'supporting' })),
    ],
    // need-1 is the only requirement the plan backs with career evidence, so
    // it is the only one an "omitted-no-evidence" disposition can contradict.
    requirements: [
      { id: 'p1-need-1', text: 'Reliable system delivery', priority: 'highest', evidenceIds: ['p1-resume-proof', 'p1-job-proof'] },
      ...AUDIT_WORDS.map(word => ({ id: auditRequirementId(word), text: `Capability ${word} for the platform`, priority: 'supporting', evidenceIds: [auditEvidenceId(word)] })),
    ],
    resume: { schemaVersion: 'structured-resume.v1', identity: AUDIT_IDENTITY, roles: [{ id: 'role-1', title: 'Engineer', company: 'Acme', dates: '', location: '', bullets: [{ id: 'bullet-1', text: AUDIT_BULLET, evidenceIds: ['p1-resume-proof'] }] }] },
    coverLetter: {
      name: AUDIT_IDENTITY.name, contact: AUDIT_IDENTITY.contact,
      paragraphs: [{ id: 'paragraph-1', text: AUDIT_PARAGRAPH, evidenceIds: ['p1-letter-proof', 'p1-job-proof'] }],
      roleThesis: AUDIT_THESIS,
      coverLetterArgument: { primaryEvidence: { evidence: AUDIT_BULLET, evidenceRole: 'Engineer at Acme', relationToThesis: 'The systems work establishes the delivery capability named in the thesis.' } },
    },
    // One decision per accepted requirement, each naming its requirements[].id.
    audit: () => ({
      version: LOCAL_AI_GENERATION_AUDIT_VERSION,
      jobPriorities: [
        { requirement: 'p1-need-1', priority: 'highest', disposition: 'addressed-both', justification: 'The selected systems evidence directly addresses the stated delivery requirement.' },
        ...AUDIT_WORDS.map(word => ({ requirement: auditRequirementId(word), priority: 'supporting', disposition: 'omitted-no-evidence', justification: `Career data documents no support for capability ${word}, so the documents claim none.` })),
      ],
      resumePlan: { strategy: 'Lead with the strongest supported systems evidence for the role.', selectionRationale: 'The retained role preserves direct factual support and concise relevance.' },
      coverLetterPlan: { controllingThesis: AUDIT_THESIS, paragraphs: [{
        paragraph: AUDIT_PARAGRAPH, argumentativeJob: 'Establish the controlling evidence-to-need connection.',
        relationToThesis: 'Connect the source-supported proof to reliable system delivery.', relationToPreviousParagraph: 'opening',
        sentences: AUDIT_PARAGRAPH.split(/(?<=\.)\s+/u).map((sentence, index) => ({ sentence, function: index === 0 ? 'States the general candidate capability.' : index === 1 ? 'Supplies the source-supported candidate proof.' : 'Connects the proof to the target responsibility.', relationToPreviousSentence: index === 0 ? 'opening' : 'Develops the preceding argument step.' })),
        argumentMapping: { claim: 'My experience delivering supported systems is a relevant capability.', proof: 'In my engineering role at Acme, I updated supported systems for internal users.', relevance: 'I would apply my experience delivering supported systems to reliable system delivery this role requires.', jobNeedQuote: 'reliable system delivery' },
      }] },
      finalDecisionSummary: 'The final documents use the strongest supported evidence without introducing a second cover-letter argument.',
    }),
  };
}

// Queues the 13-requirement job and hands back the primitives every flow on it
// needs: the live handoff, a raw submit that reports whatever the host decided,
// and an asserting submit for the steps a case is not varying. Cases that test
// a rejection use `submit`; cases that only need to reach a later stage use
// `send`.
const AUDIT_JOB = Object.freeze({ title: 'Engineer', company: 'Acme', snippet: AUDIT_LISTING });

async function auditJobSteps(project, { careerData = AUDIT_CAREER_DATA, job = AUDIT_JOB } = {}) {
  const queued = await queueLocalApplicationJob({
    transport: 'paste', canvasFilePath: project.canvasFilePath, careerData,
    job,
    resumeProfile: { workHistory: [{ id: 'role-1', title: 'Engineer', employer: 'Acme', startDate: '', endDate: '' }] },
  });
  const current = async () => (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath })).handoff;
  const prompts = {};
  const submit = async (fields) => {
    const handoff = await current();
    prompts[handoff.stage] = handoff.prompt;
    const result = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(reply(handoff, auditTransportFields(fields))) });
    return { handoff, result };
  };
  const send = async (fields) => {
    const initialHandoff = await current();
    const progress = pasteContext(initialHandoff.prompt).evidencePlanProgress;
    // A few focused audit tests use a one-requirement plan with this shared,
    // deliberately two-page listing.  Preserve their small plan, but send it
    // through the real envelope and explicitly close the remaining source
    // page instead of relying on the retired implicit-complete path.
    if (initialHandoff.stage === 'evidence-plan' && progress?.pageCount > 1
      && fields.evidence && !fields.evidence.some(item => item.id.startsWith('p'))) {
      const ids = new Map([
        ...fields.evidence.map(item => [item.id, `p1-${item.id}`]),
        ...fields.requirements.map(item => [item.id, `p1-${item.id}`]),
      ]);
      const first = {
        ...fields,
        evidence: fields.evidence.map(item => ({ ...item, id: ids.get(item.id) })),
        requirements: fields.requirements.map(item => ({ ...item, id: ids.get(item.id), evidenceIds: item.evidenceIds.map(id => ids.get(id) || id) })),
        complete: false,
      };
      const firstSubmission = await submit(first);
      assert(firstSubmission.result.accepted, `the first small evidence page must be accepted: ${JSON.stringify(firstSubmission.result.validationErrors || [])}`);
      for (let index = 1; index < progress.pageCount; index++) {
        const finalPage = await submit({ identity: fields.identity, evidence: [], requirements: [], complete: index === progress.pageCount - 1 });
        assert(finalPage.result.accepted, `the ${index + 1} small evidence page must be accepted: ${JSON.stringify(finalPage.result.validationErrors || [])}`);
        if (index === progress.pageCount - 1) return finalPage.result;
      }
    }
    if (fields.evidence && fields.requirements?.length === AUDIT_WORDS.length + 1) {
      const first = {
        ...fields,
        evidence: fields.evidence.filter(item => item.id.startsWith('p1-')),
        requirements: fields.requirements.filter(item => item.id.startsWith('p1-')),
        complete: false,
      };
      const firstSubmission = await submit(first);
      assert(firstSubmission.handoff.stage === 'evidence-plan'
        && pasteContext(firstSubmission.handoff.prompt).evidencePlanProgress?.pageIndex === 0
        && firstSubmission.result.accepted,
      `the first evidence page must be accepted at cursor 0: ${JSON.stringify(firstSubmission.result.validationErrors || [])}`);
      const second = {
        ...fields,
        evidence: fields.evidence.filter(item => item.id.startsWith('p2-')),
        requirements: fields.requirements.filter(item => item.id.startsWith('p2-')),
        complete: true,
      };
      const secondSubmission = await submit(second);
      assert(secondSubmission.handoff.stage === 'evidence-plan'
        && pasteContext(secondSubmission.handoff.prompt).evidencePlanProgress?.pageIndex === 1
        && secondSubmission.result.accepted,
      `the final evidence page must be accepted at cursor 1: ${JSON.stringify(secondSubmission.result.validationErrors || [])}`);
      return secondSubmission.result;
    }
    const { handoff, result } = await submit(fields);
    assert(result.accepted || fields.decision === 'pass', `the ${handoff.stage} stage fixture must be accepted: ${JSON.stringify(result.validationErrors || [])}`);
    return result;
  };
  return { queued, current, prompts, submit, send };
}

// A 13-requirement paste job walked to its review stage, plus the passing
// review every surface test submits. Shared by the surface-boundary sweep
// below so all three surfaces grade the SAME package.
async function auditJobAtReview(project) {
  const plan = auditPlanFixture();
  const steps = await auditJobSteps(project);
  await steps.send({ identity: plan.identity, evidence: plan.evidence, requirements: plan.requirements });
  await steps.send({ resume: plan.resume });
  await steps.send({ coverLetter: plan.coverLetter });
  const jobId = steps.queued.id;
  const dir = steps.queued.folder;
  const passFields = () => ({
    decision: 'pass', findings: [], checklist: checklist(),
    qualityReview: {
      checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION,
      criteria: APPLICATION_QUALITY_CRITERIA.map(({ id, requirement }) => ({ id, status: 'pass', evidence: requirement })),
      resume: { decision: 'approved', rationale: 'The résumé preserves direct source-supported systems evidence with clear relevance.' },
      coverLetter: { decision: 'approved', rationale: 'One controlling argument uses minimum-sufficient evidence for target system delivery.' },
    },
    generationAudit: plan.audit(),
  });
  const submitPass = async () => {
    const loaded = await getLocalApplicationHandoff({ jobId, canvasFilePath: project.canvasFilePath })
      .then(value => value.handoff, error => ({ loadError: error }));
    if (loaded?.loadError) return { result: null, error: loaded.loadError };
    return submitLocalApplicationHandoff({
      jobId, canvasFilePath: project.canvasFilePath, handoffCode: loaded.handoffCode,
      response: JSON.stringify(reply(loaded, passFields())),
    }).then(result => ({ result, error: null }), error => ({ result: null, error }));
  };
  return { jobId, dir, project, plan, steps, submitPass };
}

// Queues a job, walks it to the review stage, and hands back a review submitter
// so each case only varies the generationAudit it pastes.
async function runAuditFlow(project, plan, { careerData = AUDIT_CAREER_DATA, job = AUDIT_JOB } = {}) {
  const { queued, current, prompts, send, submit } = await auditJobSteps(project, { careerData, job });
  await send({ identity: plan.identity, evidence: plan.evidence, requirements: plan.requirements });
  await send({ resume: plan.resume });
  await send({ coverLetter: plan.coverLetter });
  prompts.review = (await current()).prompt;
  return {
    queued,
    prompts,
    current,
    submit,
    reviewPrompt: prompts.review,
    review: generationAudit => send({
      decision: 'pass', findings: [], checklist: checklist(),
      qualityReview: {
        checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION,
        criteria: APPLICATION_QUALITY_CRITERIA.map(({ id, requirement }) => ({ id, status: 'pass', evidence: requirement })),
        resume: { decision: 'approved', rationale: 'The résumé preserves direct source-supported systems evidence with clear relevance.' },
        coverLetter: { decision: 'approved', rationale: 'One controlling argument uses minimum-sufficient evidence for target system delivery.' },
      },
      generationAudit,
    }),
  };
}

// Degree-gate fixtures. The corpus mirrors the real one: a work-experience
// section written as prose, and (when a case adds it) a bare "Education"
// heading whose degree and institution sit on separate lines with no comma.
const DEGREE_PROSE_CORPUS = 'Jordan Reyes\njordan@example.test\nSoftware Engineer profile\n\n## Analytical Engines\nSoftware Engineer\n2020 – 2024\n\n- Built reporting systems that reduced manual work.\n';
const SEPARATE_LINE_EDUCATION = '\n---\n\nEducation\n\nBachelor of Science in Computer Science\nHalden University — Lakeview\n*Graduated 2018*\n\n---\n';
// What a human reader picks out of that section: the degree as career data
// writes it, with no institution glued on by a dash, no dates, no GPA. The
// gate never names it — the responder chooses it and the two existing checks
// (grounding, degree shape) decide whether the choice is admissible.
const CLEAN_DEGREE = 'Bachelor of Science in Computer Science';
const DEGREE_GATE_RE = /no Education section/;

function normalizedIncludes(source, value) {
  return String(source).replace(/\s+/g, ' ').trim().includes(String(value).replace(/\s+/g, ' ').trim());
}

// The invariant that makes the whole defect class impossible: the gate states
// the requirement and copies no career-data text, so nothing it says can be
// pasted into identity.credential, frozen into trustedIdentity, and rendered
// into the résumé header. Three consecutive words is short enough to catch a
// quoted degree or institution and long enough that ordinary English in the
// message cannot collide with the corpus by accident.
function careerDataEchoes(message, careerData) {
  const words = String(careerData).replace(/\s+/g, ' ').trim().toLocaleLowerCase().split(' ').filter(Boolean);
  const haystack = ` ${String(message).replace(/\s+/g, ' ').trim().toLocaleLowerCase()} `;
  const hits = new Set();
  for (let index = 0; index + 3 <= words.length; index += 1) {
    const window = words.slice(index, index + 3).join(' ');
    if (haystack.includes(window)) hits.add(window);
  }
  return [...hits];
}

// Quoted spans are checked separately: the form template "<degree>,
// <institution>" is quoted on purpose, and it must not be career-data text.
function quotedCareerDataSpans(message, careerData) {
  return [...String(message).matchAll(/"([^"]*)"/g)].map(match => match[1]).filter(span => span && normalizedIncludes(careerData, span));
}

function degreePlan(credential) {
  return {
    identity: { name: 'Jordan Reyes', contact: ['jordan@example.test'], subtitleRole: 'Software Engineer', ...(credential === null ? {} : { credential }) },
    evidence: [
      { id: 'career-proof', sourceId: 'career-data', quote: 'Built reporting systems that reduced manual work.', requirement: 'Reporting systems', priority: 'highest' },
      { id: 'job-proof', sourceId: 'job-listing', quote: '# Reporting Engineer', requirement: 'Reporting systems', priority: 'highest' },
    ],
    requirements: [{ id: 'need-1', text: 'Reporting systems', priority: 'highest', evidenceIds: ['career-proof', 'job-proof'] }],
  };
}

// Drives the real paste submit path: queue a scratch job on the given career
// corpus, then submit one evidence plan per supplied credential against the
// same live handoff, stopping once one is accepted. `null` omits the field.
async function submitDegreePlans(careerData, credentials) {
  const project = await createCanvasProject();
  try {
    const queued = await queueLocalApplicationJob({
      transport: 'paste', canvasFilePath: project.canvasFilePath, careerData,
      job: { title: 'Reporting Engineer', company: 'Acme', snippet: 'Build reporting systems.' },
      resumeProfile: { workHistory: [{ id: 'role-1', title: 'Software Engineer', employer: 'Analytical Engines', startDate: '2020', endDate: '2024' }] },
    });
    const handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath })).handoff;
    const rounds = [];
    for (const credential of credentials) {
      const submitted = await submitLocalApplicationHandoff({
        jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoffCode,
        response: JSON.stringify(reply(handoff, degreePlan(credential))),
      });
      const errors = submitted.validationErrors || [];
      const gate = errors.find(message => DEGREE_GATE_RE.test(message)) || '';
      rounds.push({
        credential, errors, gate,
        echoes: gate ? careerDataEchoes(gate, careerData) : [],
        quoted: gate ? quotedCareerDataSpans(gate, careerData) : [],
        accepted: Boolean(submitted.accepted), nextStage: submitted.handoff?.stage || null,
      });
      if (submitted.accepted) break;
    }
    const manifest = JSON.parse(await fs.promises.readFile(path.join(queued.folder, 'manifest.json'), 'utf8'));
    return { rounds, prompt: handoff.prompt, trustedCredential: manifest.paste?.trustedIdentity?.credential ?? null };
  } finally {
    await fs.promises.rm(project.root, { recursive: true, force: true });
  }
}

// A posting long enough to arm checkAnchorRelevance: below
// MIN_ANCHOR_RELEVANCE_CORPUS_WORDS words of posting text that check skips
// entirely, and every other fixture in this file is deliberately shorter.
const BATTERY_LISTING = [
  'Engineer role focused on reliable system delivery.',
  'The team maintains internal services and supports colleagues who depend on them every working day.',
  'We value careful judgement, clear written communication, steady delivery habits, and a willingness to learn the domain in depth.',
  'You will work with product partners to keep the platform dependable for the people who rely on it each week.',
].join(' ');
const BATTERY_BULLET = 'Maintained internal systems with supported delivery practices.';
const BATTERY_LEAD = 'Reliable system delivery is the capability this engineering role needs, and my delivery experience supports it.';
const BATTERY_BODY = 'In my engineering role at Acme, I kept the internal reporting service dependable for daily users through containerized deployment.';
const BATTERY_THESIS = 'Reliable system delivery is the supported capability this engineering role needs.';

// The same word rule every threshold in the battery counts by, so a fixture
// built to sit one word either side of a ceiling really does.
function batteryWordCount(value) {
  return (String(value).match(/[\p{L}\p{N}]+/gu) || []).length;
}

function batterySentenceOf(count) {
  const head = 'In my engineering role at Acme I kept the internal reporting service dependable for daily users through containerized deployment';
  const padding = Array.from({ length: count - batteryWordCount(head) }, (_, index) => `token${index + 1}`).join(' ');
  const sentence = `${head} ${padding}.`;
  assert(batteryWordCount(sentence) === count, `the length fixture must be exactly ${count} words (built ${batteryWordCount(sentence)})`);
  return sentence;
}

// The résumé stage requires a skills block whenever the accepted plan's career
// quotes state a technology name the host recognises, so a fixture whose
// corpus happens to mention one (a scenario paragraph naming a tool) must cite
// it or the fixture never reaches the stage it is measuring.
function planSkillsBlock(evidence) {
  const listing = { sourceId: 'job-listing', quote: 'Build software.' };
  const names = requiredCareerAttestedSkillTerms([listing, ...evidence]);
  if (!names.length) return {};
  const evidenceIds = evidence
    .filter(item => item.sourceId === 'career-data' && careerAttestedSkillTerms([listing, item]).length)
    .map(item => item.id);
  return { skills: [{ id: 'skill-1', group: 'tools', items: names, evidenceIds }] };
}

// Walks one job to the cover-letter stage over a corpus that quotes each
// paragraph the scenario will submit, so per-paragraph source grounding is
// never the variable a battery probe is measuring. The argument cites the
// first résumé bullet, which is what bounds the letter's figures.
async function coverLetterBatteryStage(project, { paragraphs, proofs = paragraphs, bullets = [BATTERY_BULLET], listing = BATTERY_LISTING, thesis = BATTERY_THESIS, projects = [], sharedProof = false }) {
  const queued = await queueLocalApplicationJob({
    transport: 'paste', canvasFilePath: project.canvasFilePath,
    // All supplied scenario prose is evidence for Acme.  State that scope in
    // the source instead of letting the test use an employer-less evidence
    // corpus to manufacture a résumé attributed to Acme.
    careerData: ['Ada Lovelace', 'ada@example.test', 'Engineer profile', '', '## Acme', 'Engineer', '', ...bullets, ...projects.map(item => item.description), ...proofs].join('\n'),
    // A project now has to answer something the posting says, so a scenario
    // that ships one puts its words in the listing too and cites them below.
    job: { title: 'Engineer', company: 'Acme', snippet: [listing, ...projects.map(item => item.description)].join(' ') },
    resumeProfile: { workHistory: [{ id: 'role-1', title: 'Engineer', employer: 'Acme', startDate: '', endDate: '' }] },
  });
  const current = async () => (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath })).handoff;
  const submitStage = async (fields) => {
    const handoff = await current();
    return submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(reply(handoff, fields)) });
  };
  const sendStage = async (fields) => {
    const result = await submitStage(fields);
    assert(result.accepted, `the battery fixture must reach the letter stage: ${JSON.stringify(result.validationErrors || [])}`);
  };
  const planEvidence = [
    ...bullets.map((quote, index) => ({ id: `resume-proof-${index + 1}`, sourceId: 'career-data', quote, requirement: 'Reliable system delivery', priority: 'highest' })),
    // A named artifact only exists for the letter's checks when the frozen
    // résumé carries it, so a scenario that needs one ships it through the
    // same plan-then-résumé path every other fixture field takes.
    ...projects.map((item, index) => ({ id: `project-proof-${index + 1}`, sourceId: 'career-data', quote: item.description, requirement: 'Reliable system delivery', priority: 'highest' })),
    ...projects.map((item, index) => ({ id: `project-listing-${index + 1}`, sourceId: 'job-listing', quote: item.description, requirement: 'Reliable system delivery', priority: 'highest' })),
    // `proofs` are the career-data quotes the paragraphs cite; by default each paragraph is its own quote, so grounding is never the variable.
    ...proofs.map((quote, index) => ({ id: `letter-proof-${index + 1}`, sourceId: 'career-data', quote, requirement: 'Reliable system delivery', priority: 'highest' })),
    { id: 'job-proof', sourceId: 'job-listing', quote: 'reliable system delivery', requirement: 'Reliable system delivery', priority: 'highest' },
  ];
  await sendStage({
    identity: { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: 'Engineer' },
    evidence: planEvidence,
    requirements: [{ id: 'need-1', text: 'Reliable system delivery', priority: 'highest', evidenceIds: ['resume-proof-1', 'job-proof'] }],
  });
  await sendStage({
    resume: {
      schemaVersion: 'structured-resume.v1',
      identity: { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: 'Engineer', credential: '' },
      roles: [{ id: 'role-1', title: 'Engineer', company: 'Acme', dates: '', location: '', bullets: bullets.map((text, index) => ({ id: `bullet-${index + 1}`, text, evidenceIds: [`resume-proof-${index + 1}`] })) }],
      ...(projects.length ? { projects: projects.map((item, index) => ({ id: `project-${index + 1}`, name: item.name, description: item.description, evidenceIds: [`project-proof-${index + 1}`, `project-listing-${index + 1}`] })) } : {}),
      ...planSkillsBlock(planEvidence),
    },
  });
  const prompt = (await current()).prompt;
  const letter = (overrides = {}) => submitStage({
    coverLetter: {
      name: 'Ada Lovelace', contact: ['ada@example.test'],
      // sharedProof: every later paragraph also cites the first paragraph's quote, beside its own, so grounding is
      // never the variable and only the count of paragraphs leaning on one quote changes.
      paragraphs: paragraphs.map((text, index) => ({ id: `paragraph-${index + 1}`, text, evidenceIds: [`letter-proof-${index + 1}`, ...(sharedProof && index > 0 ? ['letter-proof-1'] : []), 'job-proof'] })),
      roleThesis: thesis,
      coverLetterArgument: { primaryEvidence: { evidence: bullets[0], evidenceRole: 'Engineer at Acme', relationToThesis: 'The systems work establishes the delivery capability named in the thesis.' } },
      ...overrides,
    },
  });
  return { prompt, letter };
}

// One scenario per disclosed clause: submit a letter that breaks the clause
// and name the check that must report it, then submit the control the clause
// tells the writer to write and require acceptance. `paragraphs` are the
// letter's paragraph texts, frozen verbatim as career-data quotes.
const COVER_LETTER_DISCLOSURE_SCENARIOS = [
  {
    clause: 'off-posting tool names, per paragraph',
    paragraphs: [`${BATTERY_LEAD} In my engineering role at Acme, I kept the internal reporting service dependable for daily users with Docker and Kubernetes.`],
    rejectedBy: 'anchor-relevance',
    control: [`${BATTERY_LEAD} In my engineering role at Acme, I kept the internal reporting service dependable for daily users with Docker.`],
  },
  {
    clause: 'off-posting tool names, across the letter',
    paragraphs: [
      `${BATTERY_LEAD} In my engineering role at Acme, I kept the internal reporting service dependable for daily users with Docker.`,
      'Kubernetes ran that same reporting service, and I handled the release steps that kept it available through each working week.',
      'Terraform described those release steps, so a colleague could repeat them without me present for the change window.',
    ],
    rejectedBy: 'anchor-relevance',
    control: [`${BATTERY_LEAD} ${BATTERY_BODY}`],
  },
  {
    clause: 'a name the posting itself uses is free',
    paragraphs: [`${BATTERY_LEAD} In my engineering role at Acme, I kept the internal reporting service dependable for daily users with Docker and Kubernetes.`],
    listing: `${BATTERY_LISTING} The stack is Docker and Kubernetes.`,
    accepted: true,
  },
  {
    clause: 'addressing the advertisement, as the duration rule invites',
    paragraphs: [`${BATTERY_LEAD} ${BATTERY_BODY} The posting asks for dependable delivery, and steady delivery is what I practised.`],
    rejectedBy: 'posting-reference',
    control: [`${BATTERY_LEAD} ${BATTERY_BODY} The job listing states that dependable delivery matters, and that is what I practised.`],
  },
  {
    clause: 'a bare listing as the attribution subject',
    paragraphs: [`${BATTERY_LEAD} ${BATTERY_BODY} The listing states that dependable delivery matters, and that is what I practised.`],
    rejectedBy: 'posting-reference',
  },
  {
    clause: 'the position as the thing that states or requires something',
    paragraphs: [`${BATTERY_LEAD} ${BATTERY_BODY} The position requires dependable delivery, and that is what I practised.`],
    rejectedBy: 'posting-reference',
    control: [`${BATTERY_LEAD} ${BATTERY_BODY} This role needs dependable delivery, and that is what I practised.`],
  },
  {
    // The same clause, with the two evasions a fixed bigram at a fixed offset
    // could not see, stacked the way the letter that shipped them did: a job
    // title between the determiner and the head noun, and a clause fronted
    // ahead of the phrase. The contract now says wherever it stands is
    // literal, so this is what that has to mean.
    clause: 'the position as the thing that requires something, behind a title and a fronted clause',
    paragraphs: [`${BATTERY_LEAD} ${BATTERY_BODY} On this team, the Senior Engineer position requires dependable delivery, and that is what I practised.`],
    rejectedBy: 'posting-reference',
    control: [`${BATTERY_LEAD} ${BATTERY_BODY} On this team, this position needs dependable delivery, and that is what I practised.`],
  },
  {
    clause: 'a run shared with a résumé bullet',
    bullets: ['Kept the internal reporting service dependable for daily users every week.'],
    paragraphs: [`${BATTERY_LEAD} I kept the internal reporting service dependable for daily users every week.`],
    rejectedBy: 'redundancy',
    control: [`${BATTERY_LEAD} I kept the internal reporting service dependable for people.`],
  },
  {
    clause: 'a figure that sits in an uncited résumé bullet',
    bullets: [BATTERY_BULLET, 'Cut nightly reporting failures from 12 to 3 last winter.'],
    paragraphs: [`${BATTERY_LEAD} Failure counts fell from 12 to 3 while I owned that service.`],
    rejectedBy: 'figure-discipline',
  },
  {
    clause: 'the letter-wide figure ceiling',
    bullets: ['Cut nightly reporting failures from 12 to 3 across 4 regions and 5 teams.'],
    paragraphs: [`${BATTERY_LEAD} Failure counts fell from 12 to 3, and the work spanned 4 regions with 5 separate teams.`],
    rejectedBy: 'figure-discipline',
    control: [`${BATTERY_LEAD} Failure counts fell from 12 to 3 while I owned that service. I would apply that experience to the reliable system delivery this role needs.`],
  },
  {
    clause: 'sentence length',
    paragraphs: [`${BATTERY_LEAD} ${batterySentenceOf(MAX_SENTENCE_WORDS + 1)}`],
    rejectedBy: 'sentence-length',
    control: [`${BATTERY_LEAD} ${batterySentenceOf(MAX_SENTENCE_WORDS)}`],
  },
  {
    clause: 'an opening demonstrative with no referent in the paragraph before',
    paragraphs: [
      `${BATTERY_LEAD} ${BATTERY_BODY}`,
      'That evaluation practice gave me the habit of checking a change before it reached the people who depend on it.',
    ],
    rejectedBy: 'opening-demonstrative',
    control: [
      `${BATTERY_LEAD} ${BATTERY_BODY}`,
      'That deployment practice gave me the habit of checking a change before it reached the people who depend on it.',
    ],
  },
  {
    // A writer who reaches for the same stock transfer frame every time closes
    // every paragraph on one shape. The relevance rule asks for no frame at all
    // (the one paragraph that owes a sentence about the target words it as it
    // likes), and the control here is the proof that the rules are satisfiable
    // together: the repair drops the lead paragraph's frame and words the last
    // paragraph's relevance in its own terms, which the transfer budget (at most
    // one paragraph carries a stock frame) asks for as well.
    clause: 'one closing shape repeated through the letter',
    paragraphs: [
      `${BATTERY_LEAD} ${BATTERY_BODY} I would apply that experience to the reliable system delivery this role needs.`,
      'My delivery practice covers the deployment step itself. I scripted that step so a colleague could repeat it without me present during the change window. I would bring that practice to the reliable system delivery this role needs.',
      'My delivery judgment covers the colleagues who depend on the service. I wrote the weekly runbook the rotation followed. I would apply that judgment to the reliable system delivery this role needs.',
    ],
    rejectedBy: 'repeated-sentence-shape',
    control: [
      `${BATTERY_LEAD} ${BATTERY_BODY}`,
      'My delivery practice covers the deployment step itself. I scripted that step so a colleague could repeat it without me present during the change window. That practice would support reliable system delivery in the role you are filling.',
      'My delivery judgment covers the colleagues who depend on the service. I wrote the weekly runbook the rotation followed. This role needs the same judgment for reliable system delivery.',
    ],
  },
  {
    // The same rule read away from the closings. The live letter of
    // 2026-09-21 cleared the closing-only reading by rotating two closings
    // and went on entering every paragraph's evidence with one frame, so the
    // clause now says every sentence is read and this pair measures that
    // through the real stage: the rejected letter and the repair differ only
    // in the shape of two middle sentences, and every closing is identical
    // across the two.
    clause: 'one evidence-sentence shape repeated through the letter',
    paragraphs: [
      `${BATTERY_LEAD} ${BATTERY_BODY} I would apply that experience to the reliable system delivery this role needs.`,
      'My delivery practice covers the deployment step itself. In my engineering role at Acme, I scripted that step so a colleague could repeat it without me present during the change window. That practice would support reliable system delivery in the role you are filling.',
      'My delivery judgment covers the colleagues who depend on the service. In my engineering role at Acme, I wrote the weekly runbook the rotation followed. This role needs the same judgment for reliable system delivery.',
    ],
    rejectedBy: 'repeated-sentence-shape',
    control: [
      `${BATTERY_LEAD} ${BATTERY_BODY}`,
      'My delivery practice covers the deployment step itself. I scripted that step so a colleague could repeat it without me present during the change window. That practice would support reliable system delivery in the role you are filling.',
      'My delivery judgment covers the colleagues who depend on the service. I wrote the weekly runbook the rotation followed. This role needs the same judgment for reliable system delivery.',
    ],
  },
  {
    // No rule requires a stock transfer frame, so a writer who reaches for one
    // form in the paragraph right after has complied with nothing. Both
    // paragraphs below hand their proof over on one form, and the repair drops
    // the first paragraph's carrier, which also leaves the letter inside the
    // transfer budget (at most one paragraph carries a stock frame).
    clause: 'one transfer carrier form in two consecutive paragraphs',
    paragraphs: [
      `${BATTERY_LEAD} ${BATTERY_BODY} That delivery experience would support reliable system delivery in the role you are filling.`,
      'My delivery practice covers the deployment step itself. I scripted that step so a colleague could repeat it without me present during the change window. That practice would support reliable system delivery in the role you are filling.',
    ],
    rejectedBy: 'repeated-transfer-carrier',
    control: [
      `${BATTERY_LEAD} ${BATTERY_BODY}`,
      'My delivery practice covers the deployment step itself. I scripted that step so a colleague could repeat it without me present during the change window. That practice would support reliable system delivery in the role you are filling.',
    ],
  },
  {
    // The shape checkDirectWelcomeClosing certifies: a one-line hook, two proofs
    // and a one-line direct welcome. Two of the four paragraphs are one
    // sentence and the paragraphs average 27 words, which the first proportion
    // limits (one standalone sentence, a mean of 30) refused; the contract now
    // prints an allowance of two and a floor of 25, and this letter is legal.
    clause: 'a one-line hook and a one-line direct welcome around two proofs',
    paragraphs: [
      BATTERY_LEAD,
      `${BATTERY_BODY} The platform that product partners rely on each week depends on that kind of dependable service.`,
      'My delivery practice covers the deployment step itself. I scripted that step so a colleague could repeat it without me present during the change window. That practice would support reliable system delivery in the role you are filling.',
      'I welcome the chance to talk about how my delivery experience would support your engineering team.',
    ],
    accepted: true,
  },
  {
    // The relevance contract: only the first proof-bearing paragraph owes a sentence about why its proof matters to the target, and it is
    // worded however the writer likes. Every later proof paragraph ends on what the work did and owes no relevance span, so this letter is
    // legal with no stock transfer frame in it at all.
    clause: 'a later proof paragraph that ends on what the work did instead of on a statement of relevance',
    paragraphs: [
      `${BATTERY_LEAD} ${BATTERY_BODY}`,
      'My delivery judgment covers the colleagues who depend on the service. I wrote the weekly runbook the rotation followed. This role needs the same judgment for reliable system delivery.',
      'My delivery practice covers the deployment step itself. I automated that step so a colleague could repeat it without me present during the change window. The colleague repeated it for the next release.',
      'My review practice covers the changes that reach the service. I tested each release note with a reviewer before the service went out. The reviewer signed every note before the release window opened.',
    ],
    accepted: true,
  },
  {
    // The same letter with a stock transfer frame in a second paragraph: two paragraphs carry one against a budget of one, and the repair
    // is the letter above, which ends that paragraph on what the work did.
    clause: 'a stock transfer frame in a second paragraph',
    paragraphs: [
      `${BATTERY_LEAD} ${BATTERY_BODY}`,
      'My delivery judgment covers the colleagues who depend on the service. I wrote the weekly runbook the rotation followed. I would apply that judgment to the reliable system delivery this role needs.',
      'My delivery practice covers the deployment step itself. I automated that step so a colleague could repeat it without me present during the change window. That practice would support reliable system delivery in the role you are filling.',
      'My review practice covers the changes that reach the service. I tested each release note with a reviewer before the service went out. The reviewer signed every note before the release window opened.',
    ],
    rejectedBy: 'transfer-carrier-budget',
    control: [
      `${BATTERY_LEAD} ${BATTERY_BODY}`,
      'My delivery judgment covers the colleagues who depend on the service. I wrote the weekly runbook the rotation followed. I would apply that judgment to the reliable system delivery this role needs.',
      'My delivery practice covers the deployment step itself. I automated that step so a colleague could repeat it without me present during the change window. The colleague repeated it for the next release.',
      'My review practice covers the changes that reach the service. I tested each release note with a reviewer before the service went out. The reviewer signed every note before the release window opened.',
    ],
  },
  {
    // A transfer sentence may name a benefit of the work only when its paragraph's proof or the quotes it cites state it. Each paragraph
    // cites its own text here, so the quotes are the letter the control prints: the rejected letter promises a benefit that no quote
    // states, and the control hands the work over to the responsibility the posting names instead (the posting's own word is free after
    // “to”, which the control's “reliable system delivery” also proves).
    clause: 'a transfer that promises a benefit its paragraph never states',
    paragraphs: [
      `${BATTERY_LEAD} ${BATTERY_BODY}`,
      'My delivery judgment covers the colleagues who depend on the service. I wrote the weekly runbook the rotation followed. I would apply that judgment so the reporting service stays available for daily users.',
    ],
    proofs: [
      `${BATTERY_LEAD} ${BATTERY_BODY}`,
      'My delivery judgment covers the colleagues who depend on the service. I wrote the weekly runbook the rotation followed. This role needs the same judgment for reliable system delivery.',
    ],
    rejectedBy: 'transfer-benefit-support',
    control: [
      `${BATTERY_LEAD} ${BATTERY_BODY}`,
      'My delivery judgment covers the colleagues who depend on the service. I wrote the weekly runbook the rotation followed. This role needs the same judgment for reliable system delivery.',
    ],
  },
  {
    // The shipped failure shape, at the size a fixture can afford: detail
    // sentences that each stand as a paragraph of their own, past the one
    // standalone sentence a letter of this length may carry. The repair the
    // clause prescribes is to append each to the paragraph it supports, and the
    // control is the letter that results (the three details removed, the
    // paragraphs they belonged to untouched), accepted in one round.
    clause: 'standalone one-sentence paragraphs past the allowance',
    paragraphs: [
      `${BATTERY_LEAD} ${BATTERY_BODY} I would apply that experience to the reliable system delivery this role needs.`,
      'My delivery practice covers the deployment step itself. I scripted that step so a colleague could repeat it without me present during the change window. That practice would support reliable system delivery in the role you are filling.',
      'My delivery judgment covers the colleagues who depend on the service. I wrote the weekly runbook the rotation followed. This role needs the same judgment for reliable system delivery.',
      'The weekly runbook lists every deployment step for the rotation.',
      'The change window leaves room for one release at a time.',
      'The reporting service keeps its release notes beside the runbook.',
    ],
    rejectedBy: 'letter-proportion',
    control: [
      `${BATTERY_LEAD} ${BATTERY_BODY}`,
      'My delivery practice covers the deployment step itself. I scripted that step so a colleague could repeat it without me present during the change window. That practice would support reliable system delivery in the role you are filling.',
      'My delivery judgment covers the colleagues who depend on the service. I wrote the weekly runbook the rotation followed. This role needs the same judgment for reliable system delivery.',
    ],
  },
  {
    // The shipped sentence this clause was written from turned its proof toward
    // the employer with a noun no earlier sentence of its paragraph had used.
    // The repair the clause prescribes is the paragraph's own noun.
    clause: 'a demonstrative opening a later sentence whose noun the paragraph never used',
    paragraphs: [
      `${BATTERY_LEAD} ${BATTERY_BODY} I would apply that experience to the reliable system delivery this role needs.`,
      'My delivery practice covers the deployment step itself. I scripted that step so a colleague could repeat it without me present during the change window. That judgment would support reliable system delivery in the role you are filling.',
    ],
    rejectedBy: 'dangling-demonstrative',
    control: [
      `${BATTERY_LEAD} ${BATTERY_BODY}`,
      'My delivery practice covers the deployment step itself. I scripted that step so a colleague could repeat it without me present during the change window. That practice would support reliable system delivery in the role you are filling.',
    ],
  },
  {
    clause: 'the infinitive after “My experience to”',
    paragraphs: [`${BATTERY_LEAD} My experience to enforce dependable delivery practices comes from the reporting service I kept available.`],
    rejectedBy: 'experience-infinitive-grammar',
    control: [`${BATTERY_LEAD} My experience enforcing dependable delivery practices comes from the reporting service I kept available.`],
  },
  {
    clause: 'a named project used before it is introduced',
    projects: [{ name: 'SlateBoard', description: 'Built SlateBoard, an overlay tool that draws release status on the screen for the colleagues who depend on it.' }],
    paragraphs: [
      `${BATTERY_LEAD} ${BATTERY_BODY}`,
      'My delivery practice covers the release status colleagues depend on. SlateBoard draws release status on the screen. I would apply that practice to the reliable system delivery this role needs.',
    ],
    rejectedBy: 'named-artifact-introduction',
    control: [
      `${BATTERY_LEAD} ${BATTERY_BODY}`,
      'My delivery practice covers the release status colleagues depend on. I built SlateBoard, an overlay tool that draws release status on the screen. I would apply that practice to the reliable system delivery this role needs.',
    ],
  },
  {
    // Measured on the live e2e letter: a repair of one paragraph tripped this
    // check on “translates directly to”, a carrier no clause named. The
    // control is the repair the clause prescribes — the shared mechanism and
    // the responsibility it serves — not a deletion of the transfer.
    clause: 'an asserted cross-domain equivalence',
    paragraphs: [`${BATTERY_LEAD} ${BATTERY_BODY} That deployment experience translates directly to the internal services this role keeps dependable.`],
    rejectedBy: 'claimed-equivalence',
    control: [`${BATTERY_LEAD} ${BATTERY_BODY} The same release discipline runs through both, and I would apply that experience to the reliable system delivery this role needs.`],
  },
  {
    clause: 'an employer named before the candidate’s role or relationship',
    paragraphs: [`${BATTERY_LEAD} At Acme, I kept the internal reporting service dependable for daily users through containerized deployment.`],
    rejectedBy: 'prior-employer-opening',
    control: [`${BATTERY_LEAD} ${BATTERY_BODY}`],
  },
  {
    clause: 'an opening that leads with prior-employer proof',
    paragraphs: [`${BATTERY_BODY} ${BATTERY_LEAD}`],
    rejectedBy: 'opening-artifact-context',
    control: [`${BATTERY_LEAD} ${BATTERY_BODY}`],
  },
  {
    clause: 'a first-person interest declaration',
    paragraphs: [`${BATTERY_LEAD} ${BATTERY_BODY} I am excited about this engineering role.`],
    rejectedBy: 'interest-framing',
    control: [`${BATTERY_LEAD} ${BATTERY_BODY}`],
  },
  {
    clause: 'a present-tense readiness bridge for work after hiring',
    paragraphs: [`${BATTERY_LEAD} ${BATTERY_BODY} That experience prepares me to contribute to this role.`],
    rejectedBy: 'prospective-contribution-tense',
    control: [`${BATTERY_LEAD} ${BATTERY_BODY} I would apply that experience to the reliable system delivery this role needs.`],
  },
  {
    clause: 'a semicolon in letter prose',
    paragraphs: [`${BATTERY_LEAD} ${BATTERY_BODY} The rotation followed my runbook; the service stayed available each week.`],
    rejectedBy: 'punctuation-style',
    control: [`${BATTERY_LEAD} ${BATTERY_BODY} The rotation followed my runbook. The service stayed available each week.`],
  },
];

// Thesis scenarios vary one field rather than the prose, so they share a
// paragraph set and are driven through the same stage.
const COVER_LETTER_THESIS_SCENARIOS = [
  { clause: 'thesis word floor', thesis: 'Delivery experience supports reliable systems' },
  { clause: 'thesis sentence count', thesis: 'Delivery experience supports reliable reporting work. It is the capability this role needs.' },
  { clause: 'thesis fit claim', thesis: 'My background makes me a strong fit for this engineering role' },
  { clause: 'thesis alignment claim', thesis: 'My experience aligns with the needs of this engineering role' },
];

// Exactly the floor the contract prints; the word-floor scenario above sits
// exactly one word under it.
const SHORTEST_LEGAL_THESIS = 'Delivery experience supports reliable reporting work';

export default [
  {
    name: 'Paste handoff reopens Unicode context written at the queue-time character limit',
    async run() {
      const project = await createCanvasProject();
      try {
        // The frozen-source ceiling is enforced in the same JavaScript string
        // units used by the source grader, so keep this astral-text corpus just
        // below that byte-safe queue-time boundary rather than relying on a
        // silent truncation of half its emoji payload.
        const unicodeCareerData = `Ada Lovelace\nada@example.test\nSoftware Engineer\nBuilt reporting systems.\n${'😀'.repeat(119_900)}`;
        const queued = await queueLocalApplicationJob({
          transport: 'paste', canvasFilePath: project.canvasFilePath, careerData: unicodeCareerData,
          job: { title: 'Reporting Engineer', company: 'Acme', snippet: 'Build reporting systems.' },
          resumeProfile: { workHistory: [{ id: 'role-1', title: 'Software Engineer', employer: 'Analytical Engines', startDate: '2020', endDate: '2024' }] },
        });
        const restored = await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath });
        assert(restored.handoff?.stage === 'evidence-plan' && restored.handoff.prompt.includes('😀'),
          'a valid UTF-8 career corpus near the character cap remains readable when the queued paste handoff reopens');
        return { careerChars: Array.from(unicodeCareerData).length };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Paste evidence-plan identity accepts frozen career-data whitespace wrapping',
    async run() {
      const project = await createCanvasProject();
      try {
        const queued = await queueLocalApplicationJob({
          transport: 'paste', canvasFilePath: project.canvasFilePath,
          careerData: 'Ada\n Lovelace\nada@example.test\nSoftware Engineer\nBuilt reporting systems.',
          job: { title: 'Reporting Engineer', company: 'Acme' },
          resumeProfile: { workHistory: [{ id: 'role-1', title: 'Software Engineer', employer: 'Analytical Engines', startDate: '2020', endDate: '2024' }] },
        });
        const handoff = await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath });
        const accepted = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoff.handoffCode, response: JSON.stringify(reply(handoff.handoff, {
          identity: { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: 'Software Engineer', credential: '' },
          evidence: [
            { id: 'career-proof', sourceId: 'career-data', quote: 'Built reporting systems.', requirement: 'Reporting systems', priority: 'highest' },
            { id: 'job-proof', sourceId: 'job-listing', quote: '# Reporting Engineer', requirement: 'Reporting systems', priority: 'highest' },
          ],
          requirements: [{ id: 'need-1', text: 'Reporting systems', priority: 'highest', evidenceIds: ['career-proof', 'job-proof'] }],
        })) });
        assert(accepted.accepted && accepted.handoff?.stage === 'resume',
          'identity fields preserve their final normalized presentation when frozen career-data wraps whitespace');
        return { accepted: true };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Paste handoff recovers the durable measured-fit event after a manifest crash window',
    async run() {
      const project = await createCanvasProject();
      try {
        const queued = await queueLocalApplicationJob({
          transport: 'paste', canvasFilePath: project.canvasFilePath, careerData,
          job: { title: 'Reporting Engineer', company: 'Acme' },
          resumeProfile: { workHistory: [{ id: 'role-1', title: 'Software Engineer', employer: 'Analytical Engines', startDate: '2020', endDate: '2024' }] },
        });
        const manifestPath = path.join(queued.folder, 'manifest.json');
        const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
        const resultRaw = '{"completed":"before-crash"}';
        const resultSha256 = crypto.createHash('sha256').update(resultRaw, 'utf8').digest('hex');
        await fs.promises.writeFile(path.join(queued.folder, 'result.json'), resultRaw, 'utf8');
        await fs.promises.writeFile(path.join(queued.folder, 'fit-feedback.json'), JSON.stringify({
          version: 1, jobId: queued.id, status: 'revision-required', revisionRound: 1, resultSha256,
          targetPageCount: 1, resume: { pageCount: 2, targetPageCount: 1, layout: {} }, coverLetter: { pageCount: 1, targetPageCount: 1, layout: {} },
        }), 'utf8');
        // Simulate the durable append succeeding immediately before a process
        // crash prevents the completed manifest from being replaced.
        const logPath = path.join(queued.folder, 'Generation Log.jsonl');
        const creationLog = await fs.promises.readFile(logPath, 'utf8');
        await fs.promises.writeFile(logPath, `${creationLog}${JSON.stringify({ at: '2026-01-01T00:00:00.000Z', type: 'host-fit-revision-requested', jobId: queued.id, sequence: 1, revision: 1, stage: 'review', fit: { resume: { pageCount: 2, targetPageCount: 1, utilization: null }, coverLetter: { pageCount: 1, targetPageCount: 1, utilization: null } }, findings: 1 })}\n`, 'utf8');
        manifest.status = 'paste-completed';
        manifest.paste = { ...manifest.paste, stage: 'completed', revision: 0, handoffCode: null, logCount: 0 };
        await fs.promises.writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
        const reopened = await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath });
        const recoveredManifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
        const events = (await fs.promises.readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        assert(reopened.handoff?.stage === 'review' && recoveredManifest.paste.requiredChangeDocuments?.includes('resume')
          && reopened.localJob.logCount === 1 && events.length === 2 && events[0].sequence === 0 && events[1].sequence === 1,
        `a matching measured failure reconstructs a review handoff without replacing or duplicating its already-appended output log event (stage=${reopened.handoff?.stage || 'none'}, required=${JSON.stringify(recoveredManifest.paste.requiredChangeDocuments || [])}, logCount=${reopened.localJob.logCount}, events=${events.length})`);
        // The chat that wrote these documents is still the chat answering, so
        // a host-reopened round is a correction like any other — and it has to
        // carry the measurement, the fresh code, and the document the host
        // requires to change, which no earlier message in that chat states.
        assert(reopened.handoff.corrections?.length === 1 && reopened.handoff.correctionPrompt.includes('Measured 2 pages')
          && reopened.handoff.correctionPrompt.includes(reopened.handoff.handoffCode)
          && recoveredManifest.paste.requiredChangeDocuments.every(document => reopened.handoff.correctionPrompt.includes(document))
          && reopened.handoff.correctionPrompt.length * 2 < reopened.handoff.prompt.length,
        `a measured reopen hands back the measurement as a correction delta (corrections=${JSON.stringify(reopened.handoff.corrections || [])}, correction=${reopened.handoff.correctionPrompt?.length}, stage=${reopened.handoff.prompt.length})`);

        // The measured finding must survive an intervening rejection for its
        // own, UNRELATED reason. rememberPasteCorrections' per-job map is
        // overwritten by every rejection this process handles; a live handoff
        // lost this exact 67%-utilization finding that way — four rejections
        // in a row for a stale-envelope defect each erased it, and every
        // following correction round asked only about the envelope and never
        // again mentioned the fit floor it was actually waiting on. Reading
        // state.findings directly (pasteHandoffRecord's `measured`, built
        // from durable state rather than the volatile corrections map) is
        // what makes it survive: prove it here with an unrelated rejection
        // that carries no mention of the measurement at all.
        const unrelated = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: reopened.handoff.handoffCode, response: '{not valid json' });
        assert(!unrelated.accepted && !/Measured/.test(unrelated.validationErrors.join(' ')),
          `the intervening rejection must be for its own reason, unrelated to the fit measurement (errors=${JSON.stringify(unrelated.validationErrors)})`);
        const afterUnrelatedRejection = await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath });
        assert(afterUnrelatedRejection.handoff.correctionPrompt?.includes('Measured 2 pages'),
          `the measured finding must survive an unrelated rejection instead of being silently dropped from the next correction round (correction=${afterUnrelatedRejection.handoff.correctionPrompt})`);

        await fs.promises.writeFile(logPath, creationLog, 'utf8');
        await fs.promises.writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
        const reopenedBeforeAppend = await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath });
        const newlyAppended = (await fs.promises.readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        assert(reopenedBeforeAppend.handoff?.stage === 'review' && reopenedBeforeAppend.localJob.logCount === 1
          && newlyAppended.length === 2 && newlyAppended[0].type === 'paste-job-created' && newlyAppended[1].type === 'host-fit-revision-requested',
        'a crash before the host-fit log append recovers by appending one new durable event after the creation record');
        return { recovered: true, events: newlyAppended.length };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Paste application flow preserves handoff identity, revisions, and accepted log history',
    async run() {
      const project = await createCanvasProject();
      try {
        const queued = await queueLocalApplicationJob({
          transport: 'paste', canvasFilePath: project.canvasFilePath, careerData,
          job: { title: 'Reporting Engineer', company: 'Acme' },
          resumeProfile: { workHistory: [{ id: 'role-1', title: 'Software Engineer', employer: 'Analytical Engines', startDate: '2020', endDate: '2024' }] },
        });
        assert(queued.mode === 'paste' && queued.status === 'queued', 'new paste transport creates a resumable paste job');
        let handoff = await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath });
        assert(handoff.handoff.stage === 'evidence-plan' && handoff.handoff.prompt.includes('ONLY one JSON object'), 'initial evidence prompt is restored from durable state');
        const unfinishedDraft = '  {"note":"😀"}\n';
        await updateLocalApplicationDraft({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoff.handoffCode, draft: unfinishedDraft });
        const restoredDraft = await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath });
        assert(restoredDraft.handoff?.draft === unfinishedDraft, 'an unfinished JSON draft reopens byte-for-byte including whitespace and Unicode');
        let oversizedDraftRejected = false;
        try {
          await updateLocalApplicationDraft({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoff.handoffCode, draft: '😀'.repeat(260_000) });
        } catch (error) { oversizedDraftRejected = /too large/i.test(String(error?.message || error)); }
        assert(oversizedDraftRejected && (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath })).handoff?.draft === unfinishedDraft,
          'a Unicode draft over the persisted byte limit is rejected without replacing the recoverable draft');

        let staleRejected = false;
        try { await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: 'stale', response: '{}' }); } catch { staleRejected = true; }
        const malformed = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoff.handoffCode, response: '{not json' });
        const primitive = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoff.handoffCode, response: 'null' });
        const array = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoff.handoffCode, response: '[]' });
        const malformedShapes = await Promise.all([
          submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoff.handoffCode, response: JSON.stringify({ ...reply(handoff.handoff, {}), evidence: 'not-an-array', requirements: {}, identity: { name: 'Ada Lovelace', contact: 'ada@example.test' } }) }),
          submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoff.handoffCode, response: JSON.stringify({ ...reply(handoff.handoff, {}), evidence: [{ id: 'invalid id', sourceId: 'career-data', quote: 'Built reporting systems that reduced manual work.', requirement: 42, priority: 'invalid' }], requirements: [{ id: 'need-1', text: 'Reporting systems', priority: 'highest', evidenceIds: ['invalid id'] }], identity: { name: 'Ada Lovelace', contact: ['ada@example.test'] } }) }),
          submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoff.handoffCode, response: JSON.stringify({ ...reply(handoff.handoff, {}), evidence: [{ id: 'career-proof', sourceId: 'career-data', quote: 'Built reporting systems that reduced manual work.', requirement: 'Reporting systems', priority: 'highest' }], requirements: [{ id: 'need-1', text: 'Reporting systems', priority: 'highest', evidenceIds: { invalid: 'shape' } }], identity: { name: 'Ada Lovelace', contact: ['ada@example.test'] } }) }),
        ]);
        const wrongHash = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoff.handoffCode, response: JSON.stringify({ ...reply(handoff.handoff, {}), baseHashes: { evidencePlan: 'wrong' } }) });
        const wrongQuote = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoff.handoffCode, response: JSON.stringify(reply(handoff.handoff, {
          identity: { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: 'Software Engineer', credential: '' },
          evidence: [{ id: 'wrong-proof', sourceId: 'career-data', quote: 'Invented source quotation.', requirement: 'Reporting systems', priority: 'highest' }],
          requirements: [{ id: 'need-1', text: 'Reporting systems', priority: 'highest', evidenceIds: ['wrong-proof'] }],
        })) });
        const afterRejectedEvidence = await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath });
        assert(staleRejected && !malformed.accepted && !primitive.accepted && !array.accepted
          && malformed.handoff?.stage === 'evidence-plan' && primitive.handoff?.handoffCode === handoff.handoff.handoffCode
          && malformedShapes.every(result => !result.accepted && result.handoff?.stage === 'evidence-plan')
          && !wrongHash.accepted && !wrongQuote.accepted
          && afterRejectedEvidence.handoff.stage === 'evidence-plan' && afterRejectedEvidence.localJob.logCount === 0,
        'malformed JSON, primitives, arrays, and wrong schema shapes return a correction handoff without throwing, advancing, or appending to the durable workflow');

        let accepted = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoff.handoffCode, response: JSON.stringify(reply(handoff.handoff, {
          identity: { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: 'Software Engineer', credential: '' },
          evidence: [
            { id: 'career-proof', sourceId: 'career-data', quote: 'Built reporting systems that reduced manual work.', requirement: 'Reporting systems', priority: 'highest' },
            { id: 'career-proof-2', sourceId: 'career-data', quote: 'Built reporting systems and reduced manual work.', requirement: 'Reporting systems', priority: 'highest' },
            { id: 'career-proof-3', sourceId: 'career-data', quote: 'Built reporting systems, reducing manual work.', requirement: 'Reporting systems', priority: 'highest' },
            { id: 'job-proof', sourceId: 'job-listing', quote: '# Reporting Engineer', requirement: 'Reporting systems', priority: 'highest' },
          ],
          requirements: [{ id: 'need-1', text: 'Reporting systems', priority: 'highest', evidenceIds: ['career-proof', 'job-proof'] }],
        })) });
        assert(accepted.accepted && accepted.handoff?.stage === 'resume', 'accepted evidence advances to the structured résumé handoff');

        handoff = await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath });
        accepted = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoff.handoffCode, response: JSON.stringify(reply(handoff.handoff, { resume })) });
        assert(accepted.accepted && accepted.handoff?.stage === 'cover-letter', 'accepted résumé advances to the structured letter handoff');

        handoff = await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath });
        accepted = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoff.handoffCode, response: JSON.stringify(reply(handoff.handoff, { coverLetter })) });
        assert(accepted.accepted && accepted.handoff?.stage === 'review', 'accepted letter advances to review-and-edit');

        handoff = await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath });
        const malformedReview = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoff.handoffCode, response: JSON.stringify(reply(handoff.handoff, {
          decision: 'revised', checklist: checklist(), findings: [{ id: 'malformed-replacement', document: 'resume', targetId: 'bullet-1', issue: 'Needs a change.', fix: 'Change it.' }],
          resume: { schemaVersion: 'structured-resume.v1', roles: 'not-an-array' },
        })) });
        assert(!malformedReview.accepted && malformedReview.handoff?.stage === 'review'
          && malformedReview.validationErrors?.some(message => /roles must retain every trusted source role/i.test(message)),
        'a malformed review replacement returns a correction handoff instead of throwing during the rendered-change comparison');
        const listingOnlyResume = structuredClone(resume);
        listingOnlyResume.roles[0].bullets[0].text = 'Built reporting systems and reduced manual work.';
        listingOnlyResume.roles[0].bullets[0].evidenceIds = ['job-proof'];
        const listingOnlyReview = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoff.handoffCode, response: JSON.stringify(reply(handoff.handoff, {
          decision: 'revised', checklist: checklist(), findings: [{ id: 'listing-only', document: 'resume', targetId: 'bullet-1', issue: 'Use a supported bullet.', fix: 'Bind it to candidate evidence.' }], resume: listingOnlyResume,
        })) });
        assert(!listingOnlyReview.accepted && listingOnlyReview.validationErrors?.some(message => /career-data evidence ID/i.test(message)),
          'a review replacement cannot bind a rendered candidate bullet only to a job listing');

        const nonEditReview = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoff.handoffCode, response: JSON.stringify(reply(handoff.handoff, {
          decision: 'revised', checklist: checklist(), findings: [{ id: 'no-change', document: 'resume', targetId: 'bullet-1', issue: 'Needs a change.', fix: 'Change it.' }], resume,
        })) });
        const afterNonEdit = await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath });
        assert(!nonEditReview.accepted && afterNonEdit.handoff.stage === 'review' && afterNonEdit.localJob.logCount === 3,
          'a review that claims an edit while returning the same document cannot advance or append to the log');

        const reorderedNoOp = structuredClone(resume);
        // Reorder the structure without changing anything the host reads: the
        // same bullet, the same text, the same single career-data binding,
        // written with its keys in another order. Raw JSON hashing would
        // accept it as a material replacement.
        //
        // Reordering is the whole of this case. CHANGING which evidence a
        // bullet cites is not a no-op and is accepted: it changes the source
        // quotes the host grades that bullet's copy against, and a rejection
        // whose repair is exactly that citation has no other way to be
        // answered. The next case covers the other half — a field the host
        // never reads cannot count as a change either.
        const [acceptedBullet] = reorderedNoOp.roles[0].bullets;
        reorderedNoOp.roles[0].bullets[0] = {
          evidenceIds: [...acceptedBullet.evidenceIds],
          text: acceptedBullet.text,
          id: acceptedBullet.id,
        };
        const semanticNoOpReview = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoff.handoffCode, response: JSON.stringify(reply(handoff.handoff, {
          decision: 'revised', checklist: checklist(), findings: [{ id: 'reordered-no-op', document: 'resume', targetId: 'bullet-1', issue: 'Needs a change.', fix: 'Change it.' }], resume: reorderedNoOp,
        })) });
        assert(!semanticNoOpReview.accepted,
          'reordering structured JSON or evidence IDs cannot masquerade as a material review replacement');

        const ignoredFieldNoOp = { ...structuredClone(resume), editorComment: 'This does not render into the résumé.' };
        const renderedNoOpReview = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoff.handoffCode, response: JSON.stringify(reply(handoff.handoff, {
          decision: 'revised', checklist: checklist(), findings: [{ id: 'ignored-render-no-op', document: 'resume', targetId: 'bullet-1', issue: 'Needs a change.', fix: 'Change it.' }], resume: ignoredFieldNoOp,
        })) });
        assert(!renderedNoOpReview.accepted,
          'an ignored structured field cannot satisfy a required rendered-document edit');

        for (let round = 1; round <= 3; round += 1) {
          handoff = await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath });
          const revisedResume = structuredClone(resume);
          const revisedPhrases = [
            'Built reporting systems and reduced manual work.',
            'Built reporting systems, reducing manual work.',
            'Built reporting systems that reduced manual work.',
          ];
          revisedResume.roles[0].bullets[0].text = revisedPhrases[round - 1];
          revisedResume.roles[0].bullets[0].evidenceIds = [round === 3 ? 'career-proof' : `career-proof-${round + 1}`];
          accepted = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoff.handoffCode, response: JSON.stringify(reply(handoff.handoff, {
            decision: 'revised', checklist: checklist(), findings: [{ id: `finding-${round}`, document: 'resume', targetId: 'bullet-1', issue: 'Sentence can be tighter.', fix: 'Use the concise source-supported wording.' }], resume: revisedResume,
          })) });
          assert(accepted.accepted && accepted.handoff?.stage === 'review' && accepted.handoff.handoffCode !== handoff.handoff.handoffCode,
            `review ${round} makes edits in the same JSON response, then emits another review prompt with a new code`);
        }

        const restored = await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath });
        const log = await fs.promises.readFile(path.join(queued.folder, 'Generation Log.jsonl'), 'utf8');
        const events = log.trim().split('\n').map(line => JSON.parse(line));
        assert(restored.handoff.stage === 'review' && restored.handoff.revision === 6 && restored.localJob.logCount === 6
          && events.filter(event => event.type === 'paste-accepted').length === 6,
        'three successive review edits remain in review with no fixed cap, and every accepted stage remains in the append-only log');

        // This is the exact shape a real rejected pass reported: three
        // successive self-driven "revised" rounds, no host rejection ever
        // recorded, each round's own findings left in state.findings by the
        // acceptance path while requiredChangeTargets stayed cleared to [].
        // The round-6 prompt must not echo round 3's already-resolved
        // self-report as if it still named something to fix.
        const restoredManifest = JSON.parse(await fs.promises.readFile(path.join(queued.folder, 'manifest.json'), 'utf8'));
        assert(restoredManifest.paste.findings.length > 0
          && restoredManifest.paste.requiredChangeDocuments.length === 0
          && restoredManifest.paste.requiredChangeTargets.length === 0,
        `the durable state reproduces the reported shape: self-reported findings with nothing outstanding (state=${JSON.stringify({ findings: restoredManifest.paste.findings.length, documents: restoredManifest.paste.requiredChangeDocuments, targets: restoredManifest.paste.requiredChangeTargets })})`);
        const restoredContext = pasteContext(restored.handoff.prompt);
        assert(!('reviewFindings' in restoredContext) && !('requiredChangeDocuments' in restoredContext) && !('requiredChangeTargets' in restoredContext),
          `an already-resolved self-report is not echoed back once nothing is outstanding, so nothing here reads as a reason decision:"pass" is illegal (context keys=${Object.keys(restoredContext).join(', ')})`);
        assert(restored.handoff.prompt.includes('Decision:"pass" is legal exactly when all of the following hold together')
          && restored.handoff.prompt.includes('context.requiredChangeDocuments and context.requiredChangeTargets are both absent from this context'),
        'the round-6-shaped prompt states affirmatively that a pass is legal, not only the conditions that would block one');
        return { acceptedStages: 6, logEvents: events.length, revision: restored.handoff.revision };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'A rejected response is answered with a correction delta, not a resend of the stage prompt',
    async run() {
      // The rejection handoff used to be the whole stage prompt with the fixes
      // appended after it. The chat answering it already holds that prompt —
      // corpus, schema contract, criteria — so the round that mattered arrived
      // behind 18k to 42k characters the chat had just read, and the person
      // pasting it had no way to see the prompt had changed at all.
      const project = await createCanvasProject();
      try {
        const queued = await queueLocalApplicationJob({
          transport: 'paste', canvasFilePath: project.canvasFilePath, careerData,
          job: { title: 'Reporting Engineer', company: 'Acme' },
          resumeProfile: { workHistory: [{ id: 'role-1', title: 'Software Engineer', employer: 'Analytical Engines', startDate: '2020', endDate: '2024' }] },
        });
        const current = async () => (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath })).handoff;
        const send = async response => {
          const handoff = await current();
          return { handoff, result: await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoffCode, response }) };
        };
        const stage1 = await current();
        assert(!stage1.correctionPrompt && !stage1.corrections,
          'a stage nobody has answered yet carries no correction prompt');

        // Malformed JSON: the parse never reaches a validator, and the one
        // reported cause still has to reach the chat.
        const malformed = await send('{not json');
        assert(!malformed.result.accepted && malformed.result.handoff.corrections?.length === 1
          && malformed.result.handoff.correctionPrompt.includes(malformed.result.validationErrors[0]),
        'a malformed paste answers with the parse failure as its single numbered fix');

        // A grounding rejection with several offenders, each named.
        const grounding = await send(JSON.stringify(reply(stage1, {
          identity: { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: 'Software Engineer' },
          evidence: [
            { id: 'wrong-1', sourceId: 'career-data', quote: 'Invented source quotation one.', requirement: 'Reporting systems', priority: 'highest' },
            { id: 'wrong-2', sourceId: 'career-data', quote: 'Invented source quotation two.', requirement: 'Reporting systems', priority: 'high' },
            { id: 'wrong-3', sourceId: 'job-listing', quote: 'Invented listing quotation three.', requirement: 'Reporting systems', priority: 'supporting' },
          ],
          requirements: [{ id: 'need-1', text: 'Reporting systems', priority: 'highest', evidenceIds: ['wrong-1', 'wrong-3'] }],
        })));
        const { handoff: groundingStage, result: groundingResult } = grounding;
        const correction = groundingResult.handoff.correctionPrompt;
        assert(groundingResult.validationErrors.length >= 3 && groundingResult.validationErrors.every(message => correction.includes(message)),
          `every reported offender is numbered in the correction prompt (errors=${JSON.stringify(groundingResult.validationErrors)})`);
        assert(['wrong-1', 'wrong-2', 'wrong-3'].every(id => correction.includes(id)),
          'each offending evidence ID the response itself supplied is named');

        // Shape: fixes first, then only the envelope a correction cannot
        // reconstruct — never the corpus, the contract, or the criteria.
        const sharedRule = groundingStage.prompt.slice(groundingStage.prompt.indexOf('Reproduce all')).split('\n')[0];
        assert(sharedRule.includes(PASTE_BASE_HASH_KEYS.join(', ')) && correction.includes(sharedRule),
          'the correction reprints the same shared-field rule the stage prompt prints, from the same builder');
        assert(correction.indexOf(groundingResult.validationErrors[0]) < correction.indexOf(sharedRule)
          && correction.indexOf(groundingResult.validationErrors[0]) < correction.indexOf(groundingStage.handoffCode),
        'the fixes lead the prompt rather than trailing the material the chat already has');
        assert(correction.includes(groundingStage.handoffCode) && PASTE_BASE_HASH_KEYS.every(key => correction.includes(key)),
          'the shared envelope a response must copy back is carried, including every baseHashes key');
        assert(!correction.includes(careerData) && !correction.includes('Authoritative context')
          && !correction.includes('Return { ...shared') && !correction.includes(pasteContext(groundingStage.prompt).criteria[0].id),
        'the correction repeats no career data, no authoritative context, no schema contract, and no criteria');
        assert(/complete corrected evidence-plan response/.test(correction) && /[Nn]ot a patch/.test(correction),
          'the correction asks for the whole stage document back rather than inviting a patch');
        const envelope = correction.length - groundingResult.handoff.corrections.join('\n').length;
        assert(correction.length * 2 < groundingStage.prompt.length && envelope < 1_800,
          `the correction is a small fraction of the stage prompt (correction=${correction.length}, stage=${groundingStage.prompt.length}, envelope=${envelope})`);
        assert((await current()).correctionPrompt === correction,
          'reopening the dialog restores the same correction rather than reverting to the stage prompt');

        // A multi-error rejection: every class reaches the chat in one round,
        // and an identical message repeated per offending row is numbered once.
        const multi = await send(JSON.stringify({
          protocol: 1, jobId: queued.id, stage: 'evidence-plan', handoffCode: stage1.handoffCode, baseHashes: { evidencePlan: 'wrong' },
          identity: { name: 'Ada Lovelace', contact: ['ada@example.test'] },
          evidence: [
            { id: 'invalid id', sourceId: 'career-data', quote: 'Built reporting systems that reduced manual work.', requirement: 42, priority: 'invalid' },
            { id: 'invalid id two', sourceId: 'career-data', quote: 'Built reporting systems and reduced manual work.', requirement: 42, priority: 'invalid' },
          ],
          requirements: [{ id: 'need-1', text: 'Reporting systems', priority: 'highest', evidenceIds: ['missing-evidence'] }],
        }));
        const multiCorrection = multi.result.handoff.correctionPrompt;
        assert(multi.result.validationErrors.length >= 5 && multi.result.validationErrors.every(message => multiCorrection.includes(message)),
          `a multi-error rejection carries every reported error (errors=${JSON.stringify(multi.result.validationErrors)})`);
        assert(multi.result.handoff.corrections.length === new Set(multi.result.validationErrors).size,
          'a message the validator reported once per offending row is numbered once');
        assert(multiCorrection.split('\n').filter(line => /^\d+\. /.test(line)).length === multi.result.handoff.corrections.length,
          'every carried fix is numbered on its own line');

        // The corrected answer is accepted in the very next round, and the
        // correction disappears with it.
        const handoff = await current();
        const accepted = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(reply(handoff, {
          identity: { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: 'Software Engineer', credential: '' },
          evidence: [
            { id: 'career-proof', sourceId: 'career-data', quote: 'Built reporting systems that reduced manual work.', requirement: 'Reporting systems', priority: 'highest' },
            { id: 'job-proof', sourceId: 'job-listing', quote: '# Reporting Engineer', requirement: 'Reporting systems', priority: 'highest' },
          ],
          requirements: [{ id: 'need-1', text: 'Reporting systems', priority: 'highest', evidenceIds: ['career-proof', 'job-proof'] }],
        })) });
        assert(accepted.accepted && accepted.handoff.stage === 'resume' && !accepted.handoff.correctionPrompt && !accepted.handoff.corrections,
          'the corrected answer is accepted next round and the next stage opens on its own prompt');
        assert(!(await current()).correctionPrompt, 'nothing is left to correct once a response is accepted');
        return { rejections: 3, corrections: multi.result.handoff.corrections.length };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'A rejected round reports its failed rules by check id and counts the items that carry none',
    run: () => {
      // The two frozen vocabularies a receipt may name: the prose checks the
      // paste batteries run, and the review criteria a host-validation
      // failure reports against.
      const reportable = new Set([...pasteReportableCheckIds(), ...APPLICATION_QUALITY_CRITERIA.map(({ id }) => id)]);
      const items = [
        'redundancy: Cover-letter paragraph "p2" reuses PRIVATE_SHINGLE from paragraph "p1".',
        'Local AI cover letter failed required checks: anchor-relevance: Cover-letter paragraph "p3" names PRIVATE_TOOL. | redundancy: again.',
        'Cover letter needs a roleThesis.',
        'not-a-real-check-id: something the pipeline never runs.',
        // A host-validation failure reports a review CRITERION in the same
        // shape. Criterion ids are a second frozen vocabulary, never a paste
        // check, so reading only PASTE_CHECK_PROSE_UNITS drops them.
        'Local AI cover letter failed required checks: cover-register: paragraph 1 closes on a deferential invitation.',
        'host-validation-3-1: the assembled package did not match.',
      ];
      const { checkIds, uncodedErrors } = pasteRejectionCheckIds(items);
      assert(checkIds.join(',') === 'anchor-relevance,cover-register,redundancy,schema-invalid',
        `check ids are deduped, sorted, and read through the document prefix, got ${JSON.stringify(checkIds)}`);
      assert(checkIds.every(id => reportable.has(id) || id === 'schema-invalid'),
        'a receipt names a known check or the stable schema fallback');
      assert(!checkIds.includes('host-validation-3-1'),
        'a per-round finding id is not a rule name and carries a round counter, so it is not retained');
      // Structural and unknown items receive a stable schema fallback, so a
      // rejection receipt never leaves the reader with an uncoded item.
      assert(uncodedErrors === 0, `every item must be attributed, got ${uncodedErrors}`);
      const joined = JSON.stringify(checkIds);
      for (const secret of ['PRIVATE_SHINGLE', 'PRIVATE_TOOL', 'p2', 'p3', 'roleThesis', 'deferential', 'host-validation-3-1']) {
        assert(!joined.includes(secret), `only the id before ": " is extracted; ${secret} leaked`);
      }
      assert(pasteRejectionCheckIds(null).checkIds.length === 0 && pasteRejectionCheckIds([]).uncodedErrors === 0,
        'a missing or empty item list yields no ids and no count');
      return { checkIds, uncodedErrors };
    },
  },  {
    name: 'A paragraph carrying several sentences unrelated to its bound quotes reports every one of them in one round',
    async run() {
      // The same first-offender cost one level up from the qualifier loop
      // above: the per-sentence grounding walk threw on the FIRST sentence
      // whose terms did not reach the paragraph's bound career-data quotes, so
      // a paragraph with three of them was rejected three times — each round
      // naming a sentence the round before had already read. Measured here on
      // the real cover-letter submit path, twice: a pathological paragraph for
      // the ceilings, then the three-sentence paragraph for the round count.
      const project = await createCanvasProject();
      try {
        const plan = auditPlanFixture();
        const steps = await auditJobSteps(project);
        await steps.send({ identity: plan.identity, evidence: plan.evidence, requirements: plan.requirements });
        await steps.send({ resume: plan.resume });
        const driftedParagraph = strays => ({
          ...plan.coverLetter,
          paragraphs: [{ id: 'paragraph-1', text: `${AUDIT_PARAGRAPH} ${strays.join(' ')}`, evidenceIds: ['letter-proof', 'job-proof'] }],
        });
        const groundingMessage = result => (result.validationErrors || [])
          .find(message => message.includes('unrelated to its bound career-data quotes'));

        // Nine unrelated sentences, each long enough that printing them whole
        // would spend the correction's per-item budget by itself.
        const many = Array.from({ length: 9 }, (_, index) => `I cultivated rare heirloom orchid varieties, tended the greenhouse humidity logs, and judged weekend flower shows for the number ${index + 1} regional horticultural society.`);
        const pathological = await steps.submit({ coverLetter: driftedParagraph(many) });
        const bounded = groundingMessage(pathological.result);
        assert(!pathological.result.accepted && bounded,
          `the pathological paragraph is rejected by the grounding walk (errors=${JSON.stringify(pathological.result.validationErrors || [])})`);
        assert((bounded.match(/sentence \d+/gu) || []).length === 5,
          `a pathological paragraph lists a bounded number of sentences rather than all nine (message=${JSON.stringify(bounded)})`);
        assert(/4 further unrelated sentence\(s\) in the same text are not listed here\./u.test(bounded),
          `the sentences the bound left out are disclosed as a count, not silently dropped (message=${JSON.stringify(bounded)})`);
        assert(pathological.result.handoff.correctionPrompt.includes(bounded),
          'the bounded message survives the correction ceilings whole, so every sentence it names is still identifiable in the round it feeds');

        const strays = [
          'I cultivated rare orchids for weekend flower shows.',
          'I catalogued antique postage stamps for a collectors club.',
          'I refereed youth basketball tournaments every winter.',
        ];
        const rejected = await steps.submit({ coverLetter: driftedParagraph(strays) });
        const message = groundingMessage(rejected.result);
        assert(!rejected.result.accepted && message,
          `the three-sentence paragraph is rejected by the same walk (errors=${JSON.stringify(rejected.result.validationErrors || [])})`);
        for (const position of ['sentence 4', 'sentence 5', 'sentence 6']) {
          assert(message.includes(position), `the one round names ${position} (message=${JSON.stringify(message)})`);
        }
        for (const stray of strays.slice(1)) {
          assert(message.includes(stray),
            `each sentence past the first is quoted, so the writer finds it without reproducing this gate's segmentation (message=${JSON.stringify(message)})`);
        }
        assert(/^unit-source-grounding: Cover-letter paragraph "paragraph-1": \(sentence 4\) is unrelated to its bound career-data quotes\./u.test(message),
          `the first sentence keeps the single-offender wording and the rest read as additions after it (message=${JSON.stringify(message)})`);

        // ONE round: the revision that answers the whole reported class is
        // accepted, with no further rejection naming a sentence this round saw.
        const repaired = await steps.submit({ coverLetter: plan.coverLetter });
        assert(repaired.result.accepted,
          `the revision answering every reported sentence is accepted in one round (errors=${JSON.stringify(repaired.result.validationErrors || [])})`);
        return { reportedSentences: 3, listedOfPathological: 5, rounds: 1 };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'A review round reports every defective decision, sentence relation, verification note and document rationale it read, not the first of each',
    async run() {
      // The same first-offender shape in the two collections a REVIEW response
      // walks. The audit binds one decision per accepted requirement — 13 of
      // them for this fixture — and the checklist binds one note per
      // criterion, and both sanitizers threw on the first bad entry, so a
      // review with two short justifications, or two boilerplate notes, cost
      // one manual copy/paste round for each.
      const project = await createCanvasProject();
      const pdf = await PDFDocument.create(); pdf.addPage([612, 792]);
      const bytes = Buffer.from(await pdf.save());
      __setLocalAiRenderPdfForTests(async () => ({ bytes, pageCount: 1, fontsLoaded: true, missingFontFaces: [], layout: { contentHeightPx: 760, typeAreaHeightPx: 800 } }));
      try {
        const plan = auditPlanFixture();
        const steps = await auditJobSteps(project);
        await steps.send({ identity: plan.identity, evidence: plan.evidence, requirements: plan.requirements });
        await steps.send({ resume: plan.resume });
        await steps.send({ coverLetter: plan.coverLetter });
        const reviewFields = (overrides = {}) => ({
          decision: 'pass', findings: [], checklist: checklist(),
          qualityReview: {
            checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION,
            criteria: APPLICATION_QUALITY_CRITERIA.map(({ id, requirement }) => ({ id, status: 'pass', evidence: requirement })),
            resume: { decision: 'approved', rationale: 'The résumé preserves direct source-supported systems evidence with clear relevance.' },
            coverLetter: { decision: 'approved', rationale: 'One controlling argument uses minimum-sufficient evidence for target system delivery.' },
          },
          generationAudit: plan.audit(),
          ...overrides,
        });

        // Two justifications under the floor, in decisions three apart.
        const shortAudit = plan.audit();
        const shortened = ['alpha', 'charlie'];
        for (const word of shortened) {
          const decision = shortAudit.jobPriorities.find(entry => entry.requirement === auditRequirementId(word));
          decision.justification = 'Too short.';
        }
        const audits = await steps.submit(reviewFields({ generationAudit: shortAudit }));
        const auditErrors = (audits.result.validationErrors || []).filter(message => message.includes('justification'));
        assert(!audits.result.accepted && auditErrors.length === shortened.length,
          `both short justifications are reported in one round (errors=${JSON.stringify(audits.result.validationErrors || [])})`);

        // One level deeper in the same audit: the sentences bound inside a
        // paragraph are their own collection, and two of them stating no
        // substantive relation used to be two rounds as well.
        const thinRelations = plan.audit();
        for (const index of [1, 2]) {
          thinRelations.coverLetterPlan.paragraphs[0].sentences[index].relationToPreviousSentence = 'Next.';
        }
        const sentenceRound = await steps.submit(reviewFields({ generationAudit: thinRelations }));
        const sentenceErrors = (sentenceRound.result.validationErrors || [])
          .filter(message => /sentence \d+ must state its substantive relation/u.test(message));
        assert(!sentenceRound.result.accepted && sentenceErrors.length === 2,
          `both sentences that state no substantive relation are reported in one round (errors=${JSON.stringify(sentenceRound.result.validationErrors || [])})`);

        // Two verification notes that repeat their own criterion id with
        // review boilerplate around it, at two different criteria.
        const notes = reviewFields();
        for (const index of [1, 4]) {
          const criterion = notes.qualityReview.criteria[index];
          criterion.evidence = `Checked the ${criterion.id.split('-').join(' ')} criterion against the final application documents.`;
        }
        const noteRound = await steps.submit(notes);
        const noteErrors = (noteRound.result.validationErrors || []).filter(message => message.includes('verification note'));
        assert(!noteRound.result.accepted && noteErrors.length === 2,
          `both boilerplate notes are reported in one round (errors=${JSON.stringify(noteRound.result.validationErrors || [])})`);
        assert(new Set(noteErrors).size === noteErrors.length,
          'the two note defects name their own criteria rather than repeating one message');

        // The review states one rationale per document, and the same rule
        // grades both: reporting the letter's and leaving the résumé's for
        // the next round spent a handoff on a defect already in hand.
        const rationales = reviewFields();
        rationales.qualityReview.resume.rationale = 'Looks fine.';
        rationales.qualityReview.coverLetter.rationale = 'Reads well.';
        const rationaleRound = await steps.submit(rationales);
        const rationaleErrors = (rationaleRound.result.validationErrors || [])
          .filter(message => /rationale is too vague/u.test(message));
        assert(!rationaleRound.result.accepted && rationaleErrors.length === 2,
          `both document rationales are reported in one round (errors=${JSON.stringify(rationaleRound.result.validationErrors || [])})`);

        const accepted = await steps.submit(reviewFields());
        assert(accepted.result.accepted,
          `the review that answers every reported class is accepted in one round (errors=${JSON.stringify(accepted.result.validationErrors || [])})`);
        return { auditDefects: auditErrors.length, noteDefects: noteErrors.length, rationaleDefects: rationaleErrors.length };
      } finally {
        __setLocalAiRenderPdfForTests(null);
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'A correction delta stays smaller than the stage prompt it replaces even when a response reports many genuinely distinct long defects',
    async run() {
      // Note 3, measured on the real submit path. Sixteen employers of five
      // bullets each, every bullet citing an unsupported "daily frequency"
      // qualifier its cited career-data quote never states — a real,
      // per-bullet source-grounding rejection (assertSupportedSourceQualifiers
      // in localAiApplication.js), not a synthetic string. Before this test's
      // ceilings existed, 80 distinct ~355-character messages packed to
      // MAX_CORRECTION_ITEMS alone already summed past the stage prompt for
      // this very round: 23,269 correction characters against a
      // 15,603-character stage prompt (ratio 1.49) — a correction delta
      // LARGER than the prompt it exists to replace. This measures the same
      // real rejection after the fix. Five bullets per role, not twenty: past
      // jobApplication.js's RESUME_ROLE_BULLET_CEILING (6) a role also trips
      // resume-role-bullet-budget, a real but different defect this count is
      // not measuring.
      const ROLES = 16;
      const BULLETS_PER_ROLE = 5;
      const parts = ['Ada Lovelace', 'ada@example.test', ''];
      for (let r = 1; r <= ROLES; r++) {
        parts.push(`Senior Engineer ${r}`, `Employer ${r} — City ${r}, Region`, '2018 - 2022', '');
        // One distinct line per bullet: structuredResume.js's
        // ROLE_BULLET_EVIDENCE_EXCLUSIVITY_RULE now rejects two bullets in one
        // role citing the same career-data ID, so this fixture — which wants
        // 20 genuinely distinct real prose defects per role — must ground each
        // bullet in its own quote rather than repeat one across all twenty.
        for (let b = 1; b <= BULLETS_PER_ROLE; b++) {
          parts.push(`- Improved the reporting pipeline for the engineering team at Employer ${r}, iteration ${b}.`);
        }
        parts.push('');
      }
      const manyDefectCareerData = parts.join('\n');
      const workHistory = [];
      for (let r = 1; r <= ROLES; r++) {
        workHistory.push({ id: `role-${r}`, title: `Senior Engineer ${r}`, employer: `Employer ${r}`, startDate: '2018', endDate: '2022' });
      }
      const project = await createCanvasProject();
      try {
        // The plan deliberately contains enough exact evidence to expose eighty
        // independent defects.  Model that honestly as four listing pages
        // rather than bypassing the page envelope's 24/12 safety bounds.
        const pagedListing = `We need a reporting engineer to own delivery.\n${'Frozen listing context.\n'.repeat(1_500)}`;
        const queued = await queueLocalApplicationJob({
          transport: 'paste', canvasFilePath: project.canvasFilePath, careerData: manyDefectCareerData,
          job: { title: 'Reporting Engineer', company: 'Acme', snippet: pagedListing },
          resumeProfile: { workHistory },
        });
        const current = async () => (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath })).handoff;

        const planPages = Array.from({ length: 4 }, () => ({ evidence: [], requirements: [] }));
        const pageForRole = roleNumber => Math.ceil(roleNumber / 4);
        const evidenceId = (roleNumber, suffix) => `p${pageForRole(roleNumber)}-${suffix}`;
        for (let r = 1; r <= ROLES; r++) {
          const page = planPages[pageForRole(r) - 1];
          // One evidence item per bullet, mirroring the career-data line added
          // above: every bullet gets its own career-data ID so twenty bullets
          // in one role read as twenty distinct accomplishments, not one
          // accomplishment fragmented across twenty citations of the same ID.
          for (let b = 1; b <= BULLETS_PER_ROLE; b++) {
            page.evidence.push({ id: evidenceId(r, `cd-body-${r}-${b}`), sourceId: 'career-data', quote: `Improved the reporting pipeline for the engineering team at Employer ${r}, iteration ${b}.`, requirement: `Employer ${r} delivery`, priority: 'highest' });
          }
          page.requirements.push({ id: `p${pageForRole(r)}-need-${r}`, text: `Employer ${r} delivery`, priority: 'highest', evidenceIds: [evidenceId(r, `cd-body-${r}-1`), 'p1-job-need'] });
        }
        planPages[0].evidence.push({ id: 'p1-job-need', sourceId: 'job-listing', quote: 'own delivery', requirement: 'Delivery ownership', priority: 'highest' });
        planPages[0].requirements.push({ id: 'p1-need-job', text: 'Delivery ownership', priority: 'highest', evidenceIds: ['p1-job-need'] });
        for (let index = 0; index < planPages.length; index++) {
          const planHandoff = await current();
          assert(pasteContext(planHandoff.prompt).evidencePlanProgress?.pageIndex === index,
            `the ${index + 1} of ${planPages.length} evidence page uses its exact cursor`);
          const planResult = await submitLocalApplicationHandoff({
            jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: planHandoff.handoffCode,
            response: JSON.stringify(reply(planHandoff, { identity: { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: 'Senior Engineer' }, ...planPages[index], complete: index === planPages.length - 1 })),
          });
          assert(planResult.accepted, `the ${index + 1} evidence page covering every employer is accepted (errors=${JSON.stringify(planResult.validationErrors || [])})`);
        }

        const resumeHandoff = await current();
        const roles = [];
        for (let r = 1; r <= ROLES; r++) {
          const bullets = [];
          for (let b = 1; b <= BULLETS_PER_ROLE; b++) {
            bullets.push({
              id: `bullet-r${r}-b${String(b).padStart(2, '0')}`,
              text: `I improved the reporting pipeline daily for the engineering team at Employer ${r}, iteration ${b}.`,
              evidenceIds: [evidenceId(r, `cd-body-${r}-${b}`)],
            });
          }
          roles.push({ id: `role-${r}`, title: `Senior Engineer ${r}`, company: `Employer ${r}`, dates: '2018 – 2022', location: '', bullets });
        }
        const resumeResult = await submitLocalApplicationHandoff({
          jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: resumeHandoff.handoffCode,
          response: JSON.stringify(reply(resumeHandoff, { resume: { schemaVersion: 'structured-resume.v1', identity: { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: 'Senior Engineer' }, roles } })),
        });
        const qualifierErrors = resumeResult.validationErrors.filter(message => message.includes('uses unsupported daily frequency'));
        const expectedErrors = ROLES * BULLETS_PER_ROLE;
        assert(!resumeResult.accepted && qualifierErrors.length === expectedErrors
          && resumeResult.validationErrors.length === expectedErrors,
        `every bullet's unsupported "daily" qualifier is its own distinct real defect (count=${resumeResult.validationErrors?.length}, qualifierErrors=${qualifierErrors.length})`);
        assert(new Set(resumeResult.validationErrors).size === resumeResult.validationErrors.length,
          'the 80 messages are genuinely distinct, not one message repeated 80 times');
        assert(resumeResult.handoff.corrections.length === expectedErrors,
          'the full undeduplicated record still carries all 80 qualifier defects, unbounded by either prompt ceiling');

        const correction = resumeResult.handoff.correctionPrompt;
        const stagePromptChars = resumeHandoff.prompt.length;
        assert(correction.length * 2 < stagePromptChars,
          `the correction stays a small fraction of the stage prompt even with 80 real distinct defects (correction=${correction.length}, stage=${stagePromptChars})`);

        const numberedLines = correction.split('\n').filter(line => /^\d+\. /.test(line));
        assert(numberedLines.length > 0 && numberedLines.length < expectedErrors,
          `the size ceiling packs fewer than all ${expectedErrors} items, not zero and not all of them (shown=${numberedLines.length})`);
        assert(new RegExp(`The app reported ${expectedErrors} items in total; the ${expectedErrors - numberedLines.length} after this list are not printed here`).test(correction),
          `the disclosed omitted count matches exactly how many of the 80 items this list actually dropped (correction tail=${JSON.stringify(correction.slice(-220))})`);
        // Every included item still names its own bullet id — nothing printed
        // is a fragment with its identifying id sheared off.
        for (const line of numberedLines) {
          assert(/Résumé bullet "bullet-r\d+-b\d+"/.test(line), `every shown item keeps its offending id (line=${JSON.stringify(line)})`);
        }
        return { defects: resumeResult.validationErrors.length, shown: numberedLines.length, correctionChars: correction.length, stageChars: stagePromptChars };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'A single abnormally long defect is clipped to keep its offending id and its repair, not silently truncated from one end',
    async run() {
      // Note 3's other half: MAX_REJECTION_ERROR_CHARS already let one item
      // run to 12,000 characters (recoverPasteHostValidationHandoff's stored
      // fit-feedback path). A single item that size would alone spend twice
      // this app's new total-list budget, so the per-item ceiling has to
      // shorten it — and shortening it by truncating from one end would as
      // likely destroy the leading id as the trailing repair, whichever one
      // did not survive the cut.
      const project = await createCanvasProject();
      try {
        const careerData = 'Ada Lovelace\nada@example.test\n\nSenior Engineer\nAnalytical Engines — Reading, Berkshire\n2018 - 2022\n\n- Built the reporting pipeline for nightly batches.\n';
        const queued = await queueLocalApplicationJob({
          transport: 'paste', canvasFilePath: project.canvasFilePath, careerData,
          job: { title: 'Reporting Engineer', company: 'Acme', snippet: 'We need a reporting engineer to own delivery.' },
          resumeProfile: { workHistory: [{ id: 'role-1', title: 'Senior Engineer', employer: 'Analytical Engines', startDate: '2018', endDate: '2022' }] },
        });
        const manifestPath = path.join(queued.folder, 'manifest.json');
        const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
        const resultRaw = '{"completed":"before-crash"}';
        const resultSha256 = crypto.createHash('sha256').update(resultRaw, 'utf8').digest('hex');
        await fs.promises.writeFile(path.join(queued.folder, 'result.json'), resultRaw, 'utf8');
        const HEAD = 'Local AI result rejected: qualityReview.sourceGrounding.resumeBullets[0] failed with the following extended diagnostic dump —';
        const TAIL = '— end of dump.';
        const longError = `${HEAD} ${'x'.repeat(11_941 - HEAD.length - TAIL.length - 2)} ${TAIL}`;
        assert(longError.length > 11_900 && longError.length <= 12_000, `the fixture sits at MAX_REJECTION_ERROR_CHARS's own ceiling (length=${longError.length})`);
        await fs.promises.writeFile(path.join(queued.folder, 'fit-feedback.json'), JSON.stringify({
          version: 1, jobId: queued.id, status: 'invalid', resultSha256, error: longError,
        }), 'utf8');
        manifest.status = 'paste-completed';
        manifest.paste = { ...manifest.paste, stage: 'completed', revision: 0, handoffCode: null, logCount: 0 };
        await fs.promises.writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

        const reopened = await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath });
        const handoff = reopened.handoff;
        assert(handoff?.stage === 'review' && handoff.corrections?.[0]?.length === longError.length,
          `the full 12,000-character defect reaches the record unclipped, exactly as MAX_REJECTION_ERROR_CHARS allows (recorded=${handoff.corrections?.[0]?.length})`);
        const correction = handoff.correctionPrompt;
        assert(correction.includes(HEAD), 'the clipped item keeps its identifying head — which document and which unit failed');
        assert(correction.includes(TAIL), 'the clipped item keeps its trailing repair context rather than losing it to a one-sided cut');
        assert(correction.includes('[shortened for length]'), 'the clip marks itself, so a shortened item is never mistaken for the whole message');
        assert(!correction.includes('x'.repeat(1_000)), 'the pathological middle run is the part actually elided, not the id or the ending');
        assert(correction.length < longError.length / 2,
          `one 12,000-character defect no longer dominates the correction the way it could before (correction=${correction.length}, source=${longError.length})`);
        return { sourceChars: longError.length, correctionChars: correction.length };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Paste evidence plan repairs ChatGPT citation markers and canonicalizes known source and priority aliases',
    async run() {
      const project = await createCanvasProject();
      try {
        const queued = await queueLocalApplicationJob({
          transport: 'paste', canvasFilePath: project.canvasFilePath, careerData,
          job: { title: 'Reporting Engineer', company: 'Acme' },
          resumeProfile: { workHistory: [{ id: 'role-1', title: 'Software Engineer', employer: 'Analytical Engines', startDate: '2020', endDate: '2024' }] },
        });
        const initial = await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath });
        // ChatGPT can append this presentation-only citation token directly to
        // a JSON string copied from its rendered answer. It is neither source
        // data nor a source alias; strip the exact token before normalizing the
        // two documented camelCase aliases.
        const response = JSON.stringify(reply(initial.handoff, {
          identity: { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: 'Software Engineer', credential: '' },
          evidence: [
            { id: 'career-proof', sourceId: 'careerData', quote: 'Built reporting systems that reduced manual work.', requirement: 'Reporting systems', priority: 'medium' },
            { id: 'job-proof', sourceId: 'jobListing :chatgpt-content-reference{index="0"}', quote: '# Reporting Engineer', requirement: 'Reporting systems', priority: 'medium' },
          ],
          requirements: [{ id: 'need-1', text: 'Reporting systems', priority: 'medium', evidenceIds: ['career-proof', 'job-proof'] }],
        // The raw clipboard text from the ChatGPT renderer contains the
        // annotation's quotes unescaped, which makes otherwise-valid JSON
        // fail its first strict parse.
        })).replace('index=\\"0\\"', 'index="0"');
        const accepted = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: initial.handoff.handoffCode, response });
        const resumed = await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath });
        const evidence = resumed.handoff?.prompt.match(/"sourceId": "(career-data|job-listing)"/g) || [];
        assert(accepted.accepted && accepted.handoff?.stage === 'resume'
          && evidence.length === 2 && resumed.handoff.prompt.includes('"priority": "supporting"')
          && resumed.handoff.prompt.includes('Use every sourceRoles[].id exactly once.')
          && resumed.handoff.prompt.includes('include no summary and at least one bullet')
          && resumed.handoff.prompt.includes('faithfully rewrite cited career evidence from that employer')
          && resumed.handoff.prompt.includes('otherwise omit them'),
        'the exact ChatGPT citation artifact, camelCase source IDs, and medium priorities normalize to the persisted evidence-plan contract, whose resume prompt describes the strict role and provenance rules');
        return { accepted: true };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Paste evidence plan rejects unknown source aliases and source quotes that do not ground after normalization',
    async run() {
      const project = await createCanvasProject();
      try {
        const queued = await queueLocalApplicationJob({
          transport: 'paste', canvasFilePath: project.canvasFilePath, careerData,
          job: { title: 'Reporting Engineer', company: 'Acme' },
          resumeProfile: { workHistory: [{ id: 'role-1', title: 'Software Engineer', employer: 'Analytical Engines', startDate: '2020', endDate: '2024' }] },
        });
        const handoff = await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath });
        const makeResponse = (sourceId, quote) => JSON.stringify(reply(handoff.handoff, {
          identity: { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: 'Software Engineer', credential: '' },
          evidence: [
            { id: 'career-proof', sourceId: 'careerData', quote: 'Built reporting systems that reduced manual work.', requirement: 'Reporting systems', priority: 'medium' },
            { id: 'job-proof', sourceId, quote, requirement: 'Reporting systems', priority: 'medium' },
          ],
          requirements: [{ id: 'need-1', text: 'Reporting systems', priority: 'medium', evidenceIds: ['career-proof', 'job-proof'] }],
        }));
        const unknownAlias = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoff.handoffCode, response: makeResponse('job_listing', '# Reporting Engineer') });
        const ungroundedQuote = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoff.handoffCode, response: makeResponse('jobListing', 'Invented listing quote.') });
        assert(!unknownAlias.accepted && unknownAlias.validationErrors?.some(error => /sourceId career-data or job-listing/i.test(error))
          && !ungroundedQuote.accepted && ungroundedQuote.validationErrors?.some(error => /does not occur in its declared frozen source/i.test(error)),
        'only exact known aliases are repaired, and normalization never permits an unknown source or ungrounded quote');
        return { rejected: 2 };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Paste application submissions record redacted accepted and rejected lifecycle receipts',
    async run() {
      _resetPasteHandoffDiagnostics();
      const project = await createCanvasProject();
      try {
        const queued = await queueLocalApplicationJob({
          transport: 'paste', canvasFilePath: project.canvasFilePath, careerData,
          job: { title: 'Reporting Engineer', company: 'Acme' },
          resumeProfile: { workHistory: [{ id: 'role-1', title: 'Software Engineer', employer: 'Analytical Engines', startDate: '2020', endDate: '2024' }] },
        });
        const handoff = await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath });
        const invalid = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoff.handoffCode, response: '{ malformed private response' });
        const accepted = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoff.handoffCode, response: JSON.stringify(reply(handoff.handoff, {
          identity: { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: 'Software Engineer', credential: '' },
          evidence: [
            { id: 'career-proof', sourceId: 'career-data', quote: 'Built reporting systems that reduced manual work.', requirement: 'Reporting systems', priority: 'highest' },
            { id: 'job-proof', sourceId: 'job-listing', quote: '# Reporting Engineer', requirement: 'Reporting systems', priority: 'highest' },
          ],
          requirements: [{ id: 'need-1', text: 'Reporting systems', priority: 'highest', evidenceIds: ['career-proof', 'job-proof'] }],
        })) });
        const receipts = getPasteHandoffDiagnosticsSnapshot().receipts;
        assert(!invalid.accepted && accepted.accepted && receipts.length === 2
          && receipts[0].stage === 'evidence-plan' && receipts[0].outcome === 'rejected' && receipts[0].reason === 'INVALID_JSON'
          && receipts[0].responseChars === '{ malformed private response'.length
          && receipts[1].stage === 'evidence-plan' && receipts[1].outcome === 'accepted' && receipts[1].reason === null
          && !Object.hasOwn(receipts[0], 'response') && !Object.hasOwn(receipts[0], 'jobId') && !Object.hasOwn(receipts[0], 'handoffCode'),
        'the production submit path records only safe lifecycle metadata for rejected and accepted paste submissions');
        return { receipts: receipts.length };
      } finally {
        _resetPasteHandoffDiagnostics();
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },  {
    name: 'Evidence-plan contract discloses the ID pattern, quote cap, item ceilings, and the context field each sourceId is checked against, and ships the listing once',
    async run() {
      // Every rejection here costs a manual copy/paste round, so each rule the
      // validator enforces must be readable in the prompt that produced the
      // response. These assertions interpolate the same constants the
      // validator uses, so a hand-copied number in the contract fails them.
      const project = await createCanvasProject();
      try {
        const longQuote = 'Built reporting systems that reduced manual work across the reporting team. '.repeat(40);
        const planCareerData = `Ada Lovelace\nada@example.test\nSoftware Engineer\nBuilt reporting systems that reduced manual work.\n${longQuote}`;
        const snippet = 'Axonify Reporting Platform. We need reporting systems experience and daily ownership of the reporting pipeline.';
        const queued = await queueLocalApplicationJob({
          transport: 'paste', canvasFilePath: project.canvasFilePath, careerData: planCareerData,
          job: { title: 'Reporting Engineer', company: 'Acme', snippet, location: 'Remote' },
          resumeProfile: { workHistory: [{ id: 'role-1', title: 'Software Engineer', employer: 'Analytical Engines', startDate: '2020', endDate: '2024' }] },
        });
        const handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath })).handoff;
        const prompt = handoff.prompt;
        assert(prompt.includes(PASTE_STABLE_ID_PATTERN)
          && prompt.includes('no spaces, no leading punctuation, 120 characters max')
          && prompt.includes(`at most ${MAX_EVIDENCE_PLAN_EVIDENCE_ITEMS} evidence items and ${MAX_EVIDENCE_PLAN_REQUIREMENT_ITEMS} requirements`)
          && prompt.includes(`No quote may exceed ${MAX_SOURCE_GROUNDING_QUOTE_CHARS} characters`)
          && prompt.includes('at least one evidence item and at least one requirement')
          && prompt.includes('needs requirement: nonempty prose')
          && prompt.includes('"career-data" quotes are checked against context.careerData')
          && prompt.includes('"job-listing" quotes against context.jobListing'),
        'the evidence-plan contract states the interpolated ID pattern, item ceilings, quote cap, minimum counts, the required requirement prose, and which context field each sourceId is checked against');

        // The posting text ships once. context.job keeps the small identifying
        // facts; the quotable copy lives only in the companion the validator
        // actually checks, so there is no uncited second copy to quote from.
        // safeJob() fills every key it knows, so the unscraped ones would ship
        // as `"salary": ""` — bytes that read like a fact to account for.
        const marker = '\nAuthoritative context:\n';
        const context = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length));
        assert(!Object.hasOwn(context.job, 'snippet')
          && context.job.title === 'Reporting Engineer' && context.job.company === 'Acme' && context.job.location === 'Remote'
          && ['url', 'source', 'posted', 'language', 'salary'].every(key => !Object.hasOwn(context.job, key))
          && !Object.values(context.job).some(value => value === '')
          && context.jobListing.includes(snippet)
          && prompt.split(JSON.stringify(snippet).slice(1, -1)).length - 1 === 1,
        `the scraped listing reaches the responder exactly once through context.jobListing, and context.job carries only the fields this scrape actually filled (job keys=${JSON.stringify(Object.keys(context.job))})`);

        const evidenceItem = (id, extra = {}) => ({ id, sourceId: 'career-data', quote: 'Built reporting systems that reduced manual work.', requirement: 'Reporting systems', priority: 'supporting', ...extra });
        const listingEvidence = { id: 'job-proof', sourceId: 'job-listing', quote: 'reporting systems experience', requirement: 'Reporting systems', priority: 'highest' };
        const need = { id: 'need-1', text: 'Reporting systems', priority: 'highest', evidenceIds: ['career-proof', 'job-proof'] };
        const submit = fields => submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(reply(handoff, {
          identity: { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: 'Software Engineer' },
          evidence: [evidenceItem('career-proof', { priority: 'highest' }), listingEvidence],
          requirements: [need],
          ...fields,
        })) });

        // Each disclosed rule is the enforced one, in both directions.
        const spacedId = await submit({ evidence: [evidenceItem('career proof', { priority: 'highest' }), listingEvidence], requirements: [{ ...need, evidenceIds: ['career proof', 'job-proof'] }] });
        assert(!spacedId.accepted && !new RegExp(PASTE_STABLE_ID_PATTERN).test('career proof'),
          'an ID the stated pattern rejects is rejected by the validator too');

        const overLongQuote = await submit({ evidence: [evidenceItem('career-proof', { priority: 'highest', quote: longQuote }), listingEvidence] });
        assert(longQuote.length > MAX_SOURCE_GROUNDING_QUOTE_CHARS && !overLongQuote.accepted
          && overLongQuote.validationErrors.some(message => message.includes(`${MAX_SOURCE_GROUNDING_QUOTE_CHARS}-character source-binding limit`)),
        `a quote past the disclosed cap is rejected even though it is an exact career-data substring (errors=${JSON.stringify(overLongQuote.validationErrors)})`);

        const bulk = Array.from({ length: MAX_EVIDENCE_PLAN_EVIDENCE_ITEMS }, (_item, index) => evidenceItem(`bulk-${index}`));
        const tooMany = await submit({ evidence: [evidenceItem('career-proof', { priority: 'highest' }), listingEvidence, ...bulk] });
        assert(!tooMany.accepted && tooMany.validationErrors.some(message => message.includes(`evidence page has ${MAX_EVIDENCE_PLAN_EVIDENCE_ITEMS + 2} items, 2 over the ${MAX_EVIDENCE_PLAN_EVIDENCE_ITEMS}-item response limit`)
          && message.includes('Continue on another page')),
        `the item-limit rejection names the overflowing array, how far over it is, and the repair (errors=${JSON.stringify(tooMany.validationErrors)})`);

        // A plan that obeys the contract as written passes on the first round.
        const accepted = await submit({});
        assert(accepted.accepted && accepted.handoff?.stage === 'resume',
          `a plan quoting context.jobListing under the disclosed limits is accepted in one round (errors=${JSON.stringify(accepted.validationErrors || [])})`);
        return { promptChars: prompt.length, evidenceLimit: MAX_EVIDENCE_PLAN_EVIDENCE_ITEMS, quoteCap: MAX_SOURCE_GROUNDING_QUOTE_CHARS };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Evidence-plan context ships only the criteria that shape the plan; the review stage still ships all of them',
    async run() {
      // Nothing at this stage enforces a criterion: the evidence-plan branch of
      // the validator never reads input.qualityChecklist, and the response
      // schema has no field that consumes one. Shipping all of them here was a
      // third of the prompt describing prose that does not exist yet. Only the
      // three that decide WHICH evidence gets selected stay.
      const project = await createCanvasProject();
      try {
        const queued = await queuePlanJob(project, { additionalNotes: '   ' });
        const handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath })).handoff;
        const planContext = pasteContext(handoff.prompt);
        const kept = APPLICATION_QUALITY_CRITERIA.filter(criterion => EVIDENCE_PLAN_CRITERION_IDS.includes(criterion.id));
        const dropped = APPLICATION_QUALITY_CRITERIA.filter(criterion => !EVIDENCE_PLAN_CRITERION_IDS.includes(criterion.id));
        assert(kept.length === EVIDENCE_PLAN_CRITERION_IDS.length && dropped.length === APPLICATION_QUALITY_CRITERIA.length - kept.length
          && JSON.stringify(planContext.criteria) === JSON.stringify(kept),
        `the allowlist names real canonical criteria and the plan ships exactly those (shipped=${JSON.stringify((planContext.criteria || []).map(item => item.id))})`);
        assert(dropped.every(criterion => !handoff.prompt.includes(criterion.id) && !handoff.prompt.includes(criterion.requirement)),
          'no dropped criterion reaches the evidence-plan responder by id or by requirement prose');
        // An empty notes field is not an instruction, and the contract never
        // refers to it: the key itself is the only thing the responder sees.
        assert(!Object.hasOwn(planContext, 'additionalNotes'),
          'a blank additionalNotes is omitted rather than printed as an empty string');

        const submitted = await submitLocalApplicationHandoff({
          jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoffCode,
          response: JSON.stringify(reply(handoff, planBody())),
        });
        // The résumé stage receives the criteria that govern the document it
        // returns — not the whole checklist, and not this stage's allowlist.
        // Which ones, and why each stage gets the set it does, is asserted in
        // full by the per-stage case further down this file.
        const resumeContext = pasteContext(submitted.handoff.prompt);
        assert(submitted.accepted && submitted.handoff.stage === 'resume'
          && JSON.stringify(resumeContext.criteria) === JSON.stringify(APPLICATION_QUALITY_CRITERIA.filter(criterion => criterion.document === 'resume' || criterion.id === 'requirement-coverage')),
        `the résumé stage — the first that drafts prose these criteria govern — receives the ones that judge a résumé (errors=${JSON.stringify(submitted.validationErrors || [])})`);

        // Advance past résumé and cover-letter to reach the review-stage
        // prompt itself. Review is the pipeline's most expensive rejection —
        // its validator hard-fails unless the returned checklist lists every
        // criterion once, in order — so a silent drop here would be the
        // costliest possible version of this bug. Nothing before this line
        // exercised that prompt at all.
        const acceptedResume = await submitLocalApplicationHandoff({
          jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: submitted.handoff.handoffCode,
          response: JSON.stringify(reply(submitted.handoff, {
            resume: {
              schemaVersion: 'structured-resume.v1',
              identity: PLAN_IDENTITY,
              roles: [{
                id: 'role-1', title: 'Software Engineer', company: 'Analytical Engines', dates: '2020 – 2024', location: '',
                bullets: [{ id: 'bullet-1', text: 'Owned the reporting pipeline’s nightly ingest end to end.', evidenceIds: ['career-proof'] }],
              }],
              // A skills row under a domain-neutral label, grounded in the plan's own career quote.
              skills: [{ id: 'skill-1', group: 'tools', items: ['TypeScript'], evidenceIds: ['career-proof'] }],
            },
          })),
        });
        assert(acceptedResume.accepted && acceptedResume.handoff?.stage === 'cover-letter',
          `a plan-conformant résumé advances to the cover-letter handoff (errors=${JSON.stringify(acceptedResume.validationErrors || [])})`);

        const acceptedCoverLetter = await submitLocalApplicationHandoff({
          jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: acceptedResume.handoff.handoffCode,
          response: JSON.stringify(reply(acceptedResume.handoff, {
            coverLetter: {
              name: PLAN_IDENTITY.name, contact: PLAN_IDENTITY.contact,
              paragraphs: [{ id: 'paragraph-1', text: 'My reporting-pipeline experience is the capability this role needs. I have owned reporting pipelines end to end. I would apply that experience to the reporting pipeline this role runs.', evidenceIds: ['career-proof'] }],
              roleThesis: 'I can extend my reporting-pipeline ownership to this role.',
              coverLetterArgument: { primaryEvidence: { evidence: VERBATIM_CAREER_LINE, evidenceRole: 'Software Engineer at Analytical Engines', relationToThesis: 'It proves direct reporting-pipeline ownership.' } },
            },
          })),
        });
        const reviewContext = pasteContext(acceptedCoverLetter.handoff.prompt);
        assert(acceptedCoverLetter.accepted && acceptedCoverLetter.handoff?.stage === 'review'
          && JSON.stringify(reviewContext.criteria) === JSON.stringify(APPLICATION_QUALITY_CRITERIA),
        `the review stage — the pipeline's most expensive rejection — still receives every canonical criterion, not the evidence-plan allowlist (shipped=${JSON.stringify((reviewContext.criteria || []).map(item => item.id))}, errors=${JSON.stringify(acceptedCoverLetter.validationErrors || [])})`);

        const notesProject = await createCanvasProject();
        try {
          const withNotes = await queuePlanJob(notesProject, { additionalNotes: 'Prefer a concise letter.' });
          const notesHandoff = (await getLocalApplicationHandoff({ jobId: withNotes.id, canvasFilePath: notesProject.canvasFilePath })).handoff;
          assert(pasteContext(notesHandoff.prompt).additionalNotes === 'Prefer a concise letter.',
            'a real note still reaches the responder');
        } finally {
          await fs.promises.rm(notesProject.root, { recursive: true, force: true });
        }
        return { shipped: EVIDENCE_PLAN_CRITERION_IDS.length, canonical: APPLICATION_QUALITY_CRITERIA.length, promptChars: handoff.prompt.length };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Evidence-plan contract states the byte-for-byte quote discipline the raw substring check enforces',
    async run() {
      // Measured on the real corpus: the listing holds curly apostrophes and
      // fused "sentence.Heading" boundaries, and the career file writes
      // "Typescript", "injest", and "evaulation". Every tidy-up a careful
      // writer performs on those misses `source.includes(quote)`, and each
      // miss is one manual copy/paste round. "character-for-character" never
      // said any of it.
      const project = await createCanvasProject();
      try {
        const queued = await queuePlanJob(project);
        const handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath })).handoff;
        const prompt = handoff.prompt;
        assert(prompt.includes('a quote is a byte-for-byte slice of its source, defects included')
          && prompt.includes('keep the source’s curly apostrophes, curly quotation marks, and em or en dashes instead of ASCII stand-ins')
          && prompt.includes('keep its spelling and capitalization even where they are plainly wrong')
          && prompt.includes('insert no space or line break at a fused boundary where a period runs straight into the next capital')
          && prompt.includes('reflow no whitespace')
          && prompt.includes('elide nothing with … or ...')
          && prompt.includes('quote one contiguous run exactly as the source bounds it')
          && prompt.includes('adding no whitespace of your own at either edge'),
        'the contract names every normalization the raw substring check rejects');

        const submit = quotes => submitLocalApplicationHandoff({
          jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoffCode,
          response: JSON.stringify(reply(handoff, planBody(quotes))),
        });
        // Each probe changes exactly one thing about an otherwise exact slice.
        const probes = [
          ['ASCII apostrophe for the curly one', { career: VERBATIM_CAREER_LINE.replace('’', "'") }],
          ['corrected spelling and casing', { career: VERBATIM_CAREER_LINE.replace('injest', 'ingest').replace('Typescript', 'TypeScript') }],
          ['corrected spelling alone', { career: 'Ran the quarterly evaluation of reporting coverage.' }],
          ['an ellipsis standing in for the middle', { career: `${VERBATIM_CAREER_LINE.slice(0, 30)}…${VERBATIM_CAREER_LINE.slice(-16)}` }],
          ['trailing whitespace', { career: `${VERBATIM_CAREER_LINE} ` }],
          ['a space inserted at the fused boundary', { listing: VERBATIM_LISTING_LINE.replace('end.What', 'end. What') }],
          ['an ASCII hyphen for the em dash', { listing: VERBATIM_LISTING_LINE.replace('—', '-') }],
        ];
        const rejections = [];
        for (const [label, quotes] of probes) {
          const result = await submit(quotes);
          const named = Object.hasOwn(quotes, 'career') ? 'career-proof' : 'job-proof';
          assert(!result.accepted && result.validationErrors.some(message => message === `Evidence quote ${named} does not occur in its declared frozen source.`),
            `${label} is rejected by the raw substring check (errors=${JSON.stringify(result.validationErrors)})`);
          rejections.push(label);
        }
        // Unchanged slices of both sources pass on the first round, so the
        // discipline the contract asks for is satisfiable as written.
        const accepted = await submit({});
        assert(accepted.accepted && accepted.handoff?.stage === 'resume',
          `the same passages quoted as they are written are accepted (errors=${JSON.stringify(accepted.validationErrors || [])})`);
        return { rejected: rejections.length };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Evidence-plan contract states the identity, requirement-text, and evidence-ID-space rules the validator enforces',
    async run() {
      const project = await createCanvasProject();
      try {
        const queued = await queuePlanJob(project);
        const handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath })).handoff;
        const prompt = handoff.prompt;
        assert(prompt.includes('identity.name must be nonempty and identity.contact must hold at least one element')
          && prompt.includes('every contact element is grounded on its own')
          && prompt.includes('one value per element')
          && prompt.includes('Every requirement needs nonempty text prose')
          && prompt.includes('evidence[].id is the entire ID space for requirements[].evidenceIds'),
        'the contract states the identity minimums, per-element contact grounding, requirement prose, and the ID space');

        const submit = fields => submitLocalApplicationHandoff({
          jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoffCode,
          response: JSON.stringify(reply(handoff, { ...planBody(), ...fields })),
        });
        // A composite contact line is grounded as one string, so it is checked
        // as one string — the career file writes the two values apart.
        const composite = await submit({ identity: { ...PLAN_IDENTITY, contact: [`${PLAN_EMAIL} · ${PLAN_PHONE}`] } });
        assert(!composite.accepted && composite.validationErrors.some(message => message.includes('Every candidate identity field must occur in career data')),
          `a composite "email · phone" contact element is rejected (errors=${JSON.stringify(composite.validationErrors)})`);

        const noName = await submit({ identity: { ...PLAN_IDENTITY, name: '' } });
        const noContact = await submit({ identity: { ...PLAN_IDENTITY, contact: [] } });
        assert([noName, noContact].every(result => !result.accepted
          && result.validationErrors.some(message => message === 'Evidence plan needs a source-supported candidate name and at least one contact value.')),
        'an empty identity.name and an empty identity.contact are each rejected');

        const blankText = await submit({ requirements: [{ ...PLAN_REQUIREMENT, text: '' }] });
        assert(!blankText.accepted && blankText.validationErrors.some(message => message.includes('Every requirement needs text, priority highest/high/supporting, and evidenceIds.')),
          `a requirement with no text prose is rejected (errors=${JSON.stringify(blankText.validationErrors)})`);

        const dangling = await submit({ requirements: [{ ...PLAN_REQUIREMENT, evidenceIds: ['job-proof', 'career-proof-2'] }] });
        assert(!dangling.accepted && dangling.validationErrors.some(message => message.startsWith('Requirement references unknown evidence career-proof-2.')
          && message.includes('may only name IDs frozen on this or an earlier evidence-plan page')),
        `a dangling evidenceId is rejected by name and points at the ID space (errors=${JSON.stringify(dangling.validationErrors)})`);

        // Split the same two values the way career data writes them and the
        // identical plan is accepted, so the disclosed rule is satisfiable.
        const accepted = await submit({ identity: { ...PLAN_IDENTITY, contact: [PLAN_EMAIL, PLAN_PHONE] } });
        assert(accepted.accepted && accepted.handoff?.stage === 'resume',
          `separate contact elements pass where the composite failed (errors=${JSON.stringify(accepted.validationErrors || [])})`);
        return { probes: 5 };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Shared-field rule states the exact baseHashes keys, including the empty strings that read as placeholders',
    async run() {
      const project = await createCanvasProject();
      try {
        const queued = await queuePlanJob(project);
        const handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath })).handoff;
        // Stated once in the shared preamble because the rejection is the same
        // on all four stages.
        assert(handoff.prompt.includes(`baseHashes must carry exactly the keys ${PASTE_BASE_HASH_KEYS.join(', ')} with those values copied verbatim`)
          && handoff.prompt.includes('an empty string is a real value to copy, not a placeholder to fill in or drop')
          && PASTE_BASE_HASH_KEYS.every(key => handoff.baseHashes[key] === ''),
        `the first handoff prints three empty hashes and says to copy them back as-is (baseHashes=${JSON.stringify(handoff.baseHashes)})`);

        const submit = baseHashes => submitLocalApplicationHandoff({
          jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoffCode,
          response: JSON.stringify({ ...reply(handoff, planBody()), baseHashes }),
        });
        const { resume: _dropped, ...missingKey } = handoff.baseHashes;
        const dropped = await submit(missingKey);
        const extra = await submit({ ...handoff.baseHashes, bundle: '' });
        assert([dropped, extra].every(result => !result.accepted
          && result.validationErrors.some(message => message.includes(`the keys ${PASTE_BASE_HASH_KEYS.join(', ')} and nothing else, empty strings included`))),
        `dropping a key and adding a fourth are both rejected with the key list (dropped=${JSON.stringify(dropped.validationErrors)}, extra=${JSON.stringify(extra.validationErrors)})`);

        const accepted = await submit(handoff.baseHashes);
        assert(accepted.accepted && accepted.handoff?.stage === 'resume',
          `the three supplied values copied verbatim are accepted (errors=${JSON.stringify(accepted.validationErrors || [])})`);
        return { keys: PASTE_BASE_HASH_KEYS.length };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Stable-ID rejections name which of the three causes failed and print the pattern',
    async run() {
      // One message covered a missing id, a pattern mismatch, and a duplicate
      // alike, and named neither the id nor the pattern, so locating the
      // repair cost its own round.
      const project = await createCanvasProject();
      try {
        const queued = await queuePlanJob(project);
        const handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath })).handoff;
        const submit = fields => submitLocalApplicationHandoff({
          jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoffCode,
          response: JSON.stringify(reply(handoff, { ...planBody(), ...fields })),
        });
        const evidence = planBody().evidence;
        const [career, listing] = evidence;
        const { id: _missing, ...idless } = career;

        const absent = await submit({ evidence: [idless, listing], requirements: [{ ...PLAN_REQUIREMENT, evidenceIds: ['job-proof'] }] });
        const malformed = await submit({ evidence: [{ ...career, id: 'career proof' }, listing], requirements: [{ ...PLAN_REQUIREMENT, evidenceIds: ['career proof', 'job-proof'] }] });
        const duplicate = await submit({ evidence: [career, { ...listing, id: career.id }], requirements: [{ ...PLAN_REQUIREMENT, evidenceIds: [career.id] }] });
        const duplicateNeed = await submit({ requirements: [PLAN_REQUIREMENT, { ...PLAN_REQUIREMENT, text: 'Second need' }] });

        const message = result => result.validationErrors.find(entry => entry.includes(' id ') || entry.includes(' id (')) || '';
        assert(!absent.accepted && message(absent) === 'One evidence item has a missing or empty id (received null). Every evidence item needs its own id matching '
          + `${PASTE_STABLE_ID_PATTERN}: no spaces, no leading punctuation, 120 characters max.`,
        `a missing id is reported as a missing id, with the pattern (errors=${JSON.stringify(absent.validationErrors)})`);
        assert(!malformed.accepted && message(malformed).startsWith('The evidence item id "career proof" does not match ')
          && message(malformed).includes(PASTE_STABLE_ID_PATTERN) && message(malformed).includes('Use "career-proof" instead.'),
        `a pattern miss names the id, the pattern, and a conforming replacement (errors=${JSON.stringify(malformed.validationErrors)})`);
        assert(!duplicate.accepted && message(duplicate) === `The evidence item id "${career.id}" is used by more than one evidence item; each id must be unique within its own array. Rename the duplicate and point every reference at the id it means.`,
          `a reused evidence id is reported as a duplicate (errors=${JSON.stringify(duplicate.validationErrors)})`);
        assert(!duplicateNeed.accepted && message(duplicateNeed) === `The requirement id "${PLAN_REQUIREMENT.id}" is used by more than one requirement; each id must be unique within its own array. Rename the duplicate and point every reference at the id it means.`,
          `the requirement array reports its own duplicate in its own words (errors=${JSON.stringify(duplicateNeed.validationErrors)})`);
        assert(new Set([message(absent), message(malformed), message(duplicate)]).size === 3,
          'the three causes no longer collapse into one message');
        return { causes: 3 };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Listing companion wording is accurate for an empty posting body and for markdown-escaped job facts',
    async run() {
      // Two overstatements were measured in the clause that routes quotes.
      // The companion does not always hold "the full posting text", and
      // context.job is not "never quotable" — some of its values occur in the
      // companion verbatim while others are escaped there.
      const project = await createCanvasProject();
      try {
        const bodied = await queuePlanJob(project);
        const bodiedPrompt = (await getLocalApplicationHandoff({ jobId: bodied.id, canvasFilePath: project.canvasFilePath })).handoff.prompt;
        assert(bodiedPrompt.includes(`The posting text this source returned sits under "${ORIGINAL_JOB_LISTING_BODY_HEADING}"`)
          && !bodiedPrompt.includes('This posting arrived with no body text')
          && !bodiedPrompt.includes('holds the full posting text') && !bodiedPrompt.includes('never quotable'),
        'a posting with a body is described as one, without the two retired overstatements');

        const emptyProject = await createCanvasProject();
        try {
          const bare = await queueLocalApplicationJob({
            transport: 'paste', canvasFilePath: emptyProject.canvasFilePath, careerData: VERBATIM_CAREER_DATA,
            job: { title: PLAN_ESCAPED_TITLE, company: PLAN_COMPANY }, resumeProfile: PLAN_PROFILE,
          });
          const handoff = (await getLocalApplicationHandoff({ jobId: bare.id, canvasFilePath: emptyProject.canvasFilePath })).handoff;
          const bareContext = pasteContext(handoff.prompt);
          assert(bareContext.jobListing.includes(EMPTY_JOB_LISTING_BODY_NOTE)
            && handoff.prompt.includes(`under "${ORIGINAL_JOB_LISTING_BODY_HEADING}" the companion reads only "${EMPTY_JOB_LISTING_BODY_NOTE}"`)
            && handoff.prompt.includes('its header lines are the whole listing, so quote those and raise only requirements they support'),
          'an empty posting body is named, and the responder is pointed at the only text it can still quote');

          // The old clause called context.job unquotable. The company value is
          // in the companion verbatim, so a plan quoting it is accepted; the
          // title is escaped there, which is the trap the new wording names.
          const submit = quote => submitLocalApplicationHandoff({
            jobId: bare.id, canvasFilePath: emptyProject.canvasFilePath, handoffCode: handoff.handoffCode,
            response: JSON.stringify(reply(handoff, planBody({ listing: quote }))),
          });
          assert(bareContext.job.title === PLAN_ESCAPED_TITLE && !bareContext.jobListing.includes(PLAN_ESCAPED_TITLE)
            && bareContext.jobListing.includes(PLAN_ESCAPED_TITLE.replace('-', '\\-'))
            && handoff.prompt.includes('take every quote from the field its sourceId names')
            && handoff.prompt.includes('the companion escapes markdown punctuation'),
          `the companion escapes the title context.job prints plainly (title=${JSON.stringify(bareContext.job.title)})`);
          const escapedTitle = await submit(PLAN_ESCAPED_TITLE);
          assert(!escapedTitle.accepted && escapedTitle.validationErrors.some(message => message === 'Evidence quote job-proof does not occur in its declared frozen source.'),
            `quoting the unescaped context.job title fails against the companion (errors=${JSON.stringify(escapedTitle.validationErrors)})`);
          const fromJobFacts = await submit(PLAN_COMPANY);
          assert(fromJobFacts.accepted && fromJobFacts.handoff?.stage === 'resume',
            `a context.job value that does occur in the companion is accepted, so "never quotable" was false (errors=${JSON.stringify(fromJobFacts.validationErrors || [])})`);
        } finally {
          await fs.promises.rm(emptyProject.root, { recursive: true, force: true });
        }
        return { escapedTitle: PLAN_ESCAPED_TITLE };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  /* Retired header-degree gate cases. Education is now an evidence-backed,
   * relevance-selected resume section; the replacement cases immediately
   * below exercise that contract through the live paste handoff. Keeping the
   * old assertions would preserve an actively harmful source-order rule. */
  /* {
    name: 'Paste evidence plan carries a career-documented degree into identity.credential',
    async run() {
      // The rendered résumé has no Education section, so a dropped credential
      // is the only way a documented degree vanishes from the PDF entirely.
      // The frozen corpus deliberately mirrors the real one: degree and
      // institution on separate lines, with no comma joining them.
      const degreeCareerData = DEGREE_PROSE_CORPUS + SEPARATE_LINE_EDUCATION;
      const { rounds, prompt, trustedCredential } = await submitDegreePlans(degreeCareerData, [null, CLEAN_DEGREE]);
      // A responder can only obey a rule the contract states. "Omit optional
      // fields when absent" read as permission to drop the degree.
      assert(prompt.includes('NO Education section')
        && prompt.includes('"<degree>, <institution>"')
        && prompt.includes('Omit identity.credential only when careerData documents no completed degree'),
      'the evidence-plan contract states the résumé has no Education section, the credential form, and the only case that may omit it');

      const [dropped, repaired] = rounds;
      assert(!dropped.accepted && dropped.gate,
        `dropping the credential on a corpus documenting a degree is rejected (errors=${JSON.stringify(dropped.errors)})`);
      // The property that retires the whole defect class: the gate asserts
      // the requirement and copies no career-data text, so there is no host
      // string to freeze into trustedIdentity and render into the header.
      assert(!dropped.echoes.length && !dropped.quoted.length,
        `the rejection copies nothing out of career data (echoes=${JSON.stringify(dropped.echoes)}, quoted=${JSON.stringify(dropped.quoted)}, gate=${JSON.stringify(dropped.gate)})`);
      // Round economics: the credential a reader picks from that corpus is
      // admissible on the very next round, so the gate costs one round, never
      // a search for the string the host had in mind.
      assert(repaired.accepted && repaired.nextStage === 'resume' && trustedCredential === CLEAN_DEGREE,
        `the degree as career data writes it is accepted in one round and frozen into the trusted identity the résumé must repeat (credential=${JSON.stringify(trustedCredential)}, errors=${JSON.stringify(repaired.errors)})`);
      return { credential: trustedCredential };
    },
  },
  {
    name: 'Paste degree gate reads the education section only, never work-experience prose',
    async run() {
      // Every one of these sat in a work-experience bullet and was quoted
      // back as the text to "copy exactly" — which froze it into
      // trustedIdentity and rendered it into the résumé header. Prose that
      // merely mentions a degree token documents no degree, so a corpus
      // without an education section must pass untouched.
      const silent = [];
      for (const prose of DEGREE_MENTIONING_PROSE) {
        const { rounds } = await submitDegreePlans(`${DEGREE_PROSE_CORPUS}- ${prose}\n`, [null]);
        assert(rounds[0].accepted && rounds[0].nextStage === 'resume' && !rounds[0].gate,
          `work-experience prose that only mentions a degree never fires the gate: ${JSON.stringify(prose)} (gate=${JSON.stringify(rounds[0].gate)}, errors=${JSON.stringify(rounds[0].errors)})`);
        silent.push(prose);
      }
      // With a real education section the gate fires — and still says nothing
      // copied from the corpus, so the prose line sharing that corpus cannot
      // reach the header even when it is the more degree-looking sentence.
      for (const prose of DEGREE_MENTIONING_PROSE) {
        const careerData = `${DEGREE_PROSE_CORPUS}- ${prose}\n${SEPARATE_LINE_EDUCATION}`;
        const { rounds, trustedCredential } = await submitDegreePlans(careerData, [null, CLEAN_DEGREE]);
        assert(rounds[0].gate && !rounds[0].echoes.length && !rounds[0].quoted.length && !rounds[0].gate.includes(prose),
          `the gate demands the degree without naming the prose beside it: ${JSON.stringify(prose)} (echoes=${JSON.stringify(rounds[0].echoes)}, quoted=${JSON.stringify(rounds[0].quoted)})`);
        assert(rounds[1].accepted && trustedCredential === CLEAN_DEGREE,
          `the education-section degree is accepted in one round beside that prose: ${JSON.stringify(prose)} (errors=${JSON.stringify(rounds[1].errors)})`);
      }
      return { prose: silent.length };
    },
  },
  {
    name: 'Paste degree gate requires the credential to be a degree, not merely a grounded string',
    async run() {
      // Presence was never the property worth checking: a grounded credential
      // that is not a degree drops the degree exactly as dropping the field
      // does, and the résumé has nowhere else to put it. Shape is the test
      // the host can apply without naming any string — "Halden University" is
      // grounded, is an education fact, and is still not a degree.
      const degreeCareerData = DEGREE_PROSE_CORPUS + SEPARATE_LINE_EDUCATION;
      for (const credential of ['Software Engineer', 'Built reporting systems', 'Jordan Reyes', 'Halden University']) {
        const { rounds, trustedCredential } = await submitDegreePlans(degreeCareerData, [credential]);
        assert(!rounds[0].accepted && rounds[0].gate && /is not itself a degree/.test(rounds[0].gate),
          `a grounded credential that is not a degree is rejected as such: ${JSON.stringify(credential)} (gate=${JSON.stringify(rounds[0].gate)})`);
        assert(!rounds[0].echoes.length && !rounds[0].quoted.length && !rounds[0].gate.includes(credential) && trustedCredential === null,
          `the rejection still copies nothing and freezes nothing (echoes=${JSON.stringify(rounds[0].echoes)}, quoted=${JSON.stringify(rounds[0].quoted)}, frozen=${JSON.stringify(trustedCredential)})`);
      }
      // A degree-shaped credential passes on the first round, in the joined
      // form when career data really states it that way.
      const joined = 'Bachelor of Science in Computer Science, Halden University';
      const { rounds, trustedCredential } = await submitDegreePlans(`${DEGREE_PROSE_CORPUS}\n## Education\n\n${joined}\n`, [joined]);
      assert(rounds[0].accepted && trustedCredential === joined,
        `a degree-shaped grounded credential is accepted (errors=${JSON.stringify(rounds[0].errors)})`);
      return { joined };
    },
  },
  {
    name: 'Paste degree gate detects a decorated education entry without quoting its markup',
    async run() {
      // A leaked "**" used to be shipped in the PDF because the quoted string
      // was copied into identity.credential. Nothing is quoted now, so the
      // only thing left to check is that decoration does not hide the entry
      // and that the plain-text degree beneath it is accepted in one round.
      const careerData = `${DEGREE_PROSE_CORPUS}\n## Education\n\n- **Bachelor of Science in Computer Science**, Halden University\n`;
      const { rounds, trustedCredential } = await submitDegreePlans(careerData, [null, CLEAN_DEGREE]);
      const [dropped, repaired] = rounds;
      assert(dropped.gate && !/[*_`#]/.test(dropped.gate) && !dropped.echoes.length && !dropped.quoted.length,
        `a bolded entry is detected and the rejection carries no markdown and no career-data text (echoes=${JSON.stringify(dropped.echoes)}, gate=${JSON.stringify(dropped.gate)})`);
      // The emphasis markers sit between the degree and the comma, so the
      // joined form does not occur in career data: the plain degree is the
      // only groundable answer, and it is accepted.
      assert(normalizedIncludes(careerData, CLEAN_DEGREE) && !normalizedIncludes(careerData, `${CLEAN_DEGREE}, Halden University`),
        'the decorated corpus grounds the degree alone and not the joined form');
      assert(repaired.accepted && trustedCredential === CLEAN_DEGREE && !/[*_`]/.test(trustedCredential),
        `the frozen credential the header renders carries no markdown (credential=${JSON.stringify(trustedCredential)}, errors=${JSON.stringify(repaired.errors)})`);
      return { credential: trustedCredential };
    },
  },
  {
    name: 'Paste degree gate reads whole education entries and the spellings they use',
    async run() {
      // Applying the unawarded test to the whole line discarded real degrees
      // over a trailing GPA clause; scoping detection to an education section
      // makes shorter spellings safe to read there. Each entry must be
      // detected, and the credential a reader picks from it accepted at once.
      const cases = [
        ['Bachelor of Science in Computer Science, Halden University, minimum GPA 3.8', 'Bachelor of Science in Computer Science, Halden University'],
        ['BS in Computer Science\nHalden University', 'BS in Computer Science'],
        ['bachelor of science in computer science, halden university', 'bachelor of science in computer science, halden university'],
        ['Bachelors of Science in Computer Science\nHalden University', 'Bachelors of Science in Computer Science'],
      ];
      for (const [entry, chosen] of cases) {
        const careerData = `${DEGREE_PROSE_CORPUS}\n## Education\n\n${entry}\n`;
        const { rounds, trustedCredential } = await submitDegreePlans(careerData, [null, chosen]);
        assert(rounds[0].gate && !rounds[0].echoes.length && !rounds[0].quoted.length,
          `the education entry is detected without naming any of it: ${JSON.stringify(entry)} (echoes=${JSON.stringify(rounds[0].echoes)}, quoted=${JSON.stringify(rounds[0].quoted)})`);
        assert(rounds[1].accepted && trustedCredential === chosen && normalizedIncludes(careerData, chosen),
          `the credential a reader picks from that entry is accepted in one round: ${JSON.stringify(entry)} (errors=${JSON.stringify(rounds[1].errors)})`);
      }
      // Nothing outside a degree may be demanded as one: a degree still
      // being earned, and a certification that happens to share an
      // abbreviation with a master's degree, both leave the plan untouched.
      const silentCorpora = [
        `${DEGREE_PROSE_CORPUS}\n## Education\n\nBachelor of Science in Computer Science (in progress)\nHalden University\n`,
        `${DEGREE_PROSE_CORPUS}\n## Education & Certifications\n\nMS Office Specialist\nHarbor Dashboards Associate Certification\n`,
        `${DEGREE_PROSE_CORPUS}\n## Education\n\nHalden University — Lakeview\nRelevant coursework: algorithms, databases\n`,
      ];
      for (const corpus of silentCorpora) {
        const { rounds } = await submitDegreePlans(corpus, [null]);
        assert(rounds[0].accepted && !rounds[0].gate,
          `an education section documenting no awarded degree demands no credential (corpus=${JSON.stringify(corpus.slice(DEGREE_PROSE_CORPUS.length))}, gate=${JSON.stringify(rounds[0].gate)})`);
      }
      return { cases: cases.length, silent: silentCorpora.length };
    },
  },
  {
    name: 'Paste degree gate names no career-data text, so no parsing slip reaches the résumé header',
    async run() {
      // Every corpus here was measured driving the previous gate into naming
      // a string and ordering it copied "exactly": a fragment cut inside a
      // parenthesis, a dash-glued institution that the Design System then
      // refused (§5.3.1) with no satisfiable alternative, dates and a GPA in
      // the header, a supervisor's degree as the candidate's own, and a
      // skills bullet reading "Education" opening a region over prose. The
      // host names nothing now, so each corpus is either silent or answered
      // in one round by the text a reader would choose.
      const fired = [];
      const silent = [];
      for (const { label, tail, credential } of DEGREE_BLOCKER_CORPORA) {
        const careerData = DEGREE_PROSE_CORPUS + tail;
        const { rounds, trustedCredential } = await submitDegreePlans(careerData, credential === null ? [null] : [null, credential]);
        if (credential === null) {
          assert(rounds[0].accepted && rounds[0].nextStage === 'resume' && !rounds[0].gate,
            `career data documenting no awarded degree demands no credential: ${label} (gate=${JSON.stringify(rounds[0].gate)}, errors=${JSON.stringify(rounds[0].errors)})`);
          silent.push(label);
          continue;
        }
        assert(rounds[0].gate && !rounds[0].echoes.length && !rounds[0].quoted.length,
          `the rejection contains no text copied out of career data: ${label} (echoes=${JSON.stringify(rounds[0].echoes)}, quoted=${JSON.stringify(rounds[0].quoted)}, gate=${JSON.stringify(rounds[0].gate)})`);
        assert(rounds[1].accepted && rounds[1].nextStage === 'resume' && trustedCredential === credential,
          `the clean credential a reader picks is accepted in one round: ${label} (credential=${JSON.stringify(trustedCredential)}, errors=${JSON.stringify(rounds[1].errors)})`);
        assert(!/[—–]/u.test(String(trustedCredential)) && !/\d{4}/.test(String(trustedCredential)) && !/GPA/i.test(String(trustedCredential)),
          `the frozen credential the header renders carries no dash, dates, or GPA: ${label} (credential=${JSON.stringify(trustedCredential)})`);
        fired.push(label);
      }
      return { fired: fired.length, silent: silent.length };
    },
  },
  {
    name: 'Paste degree gate stays silent when markdown breaks every candidate credential\'s grounding',
    async run() {
      // Detection reads markdown-stripped text (pastePlainLineText) while the
      // grounding loop the responder must pass tests raw career data. An
      // entry like "**Bachelor** of Science in Computer Science, Halden
      // University" is detectable as a degree but not quotable: the
      // asterisks sit inside the clause, so no unedited reading of it can
      // ever occur verbatim in the raw text. Demanding a credential here
      // used to wedge the job with no reachable repair; the gate must stay
      // silent instead, so the plan that omits the field is accepted.
      const careerData = `${DEGREE_PROSE_CORPUS}\n## Education\n\n**Bachelor** of Science in Computer Science, Halden University\n`;
      const { rounds } = await submitDegreePlans(careerData, [null]);
      assert(rounds[0].accepted && rounds[0].nextStage === 'resume' && !rounds[0].gate,
        `a degree that markdown decoration breaks every reading of stays silent, and the plan omitting the credential is accepted (gate=${JSON.stringify(rounds[0].gate)}, errors=${JSON.stringify(rounds[0].errors)})`);

      // Prove the wedge is really gone rather than merely quiet: no
      // plausible credential a responder might guess is rejected BY THIS
      // GATE either. The plain, markdown-stripped readings still fail an
      // unrelated and correct check (an identity field must literally occur
      // in the raw career data) — that rejection is not the wedge this fix
      // retires, and its message is generic and still names no career-data
      // span. The raw reading with its markdown intact grounds cleanly and
      // is accepted outright, proving a path through this gate is always
      // open on this corpus even without omitting the field.
      for (const credential of [CLEAN_DEGREE, `${CLEAN_DEGREE}, Halden University`]) {
        const { rounds: attempt } = await submitDegreePlans(careerData, [credential]);
        assert(!attempt[0].gate,
          `an ungroundable stripped reading is never rejected by the degree gate itself: ${JSON.stringify(credential)} (accepted=${attempt[0].accepted}, errors=${JSON.stringify(attempt[0].errors)})`);
        const joinedErrors = attempt[0].errors.join(' ');
        assert(!careerDataEchoes(joinedErrors, careerData).length && !quotedCareerDataSpans(joinedErrors, careerData).length,
          `even the unrelated rejection copies nothing out of career data: ${JSON.stringify(credential)} (errors=${JSON.stringify(attempt[0].errors)})`);
      }
      const rawCredential = '**Bachelor** of Science in Computer Science, Halden University';
      const { rounds: rawAttempt, trustedCredential: rawTrusted } = await submitDegreePlans(careerData, [rawCredential]);
      assert(rawAttempt[0].accepted && rawTrusted === rawCredential,
        `a credential that keeps the source's own markdown grounds cleanly and is accepted outright (errors=${JSON.stringify(rawAttempt[0].errors)})`);
      return { silent: true };
    },
  },
  {
    name: 'Paste degree gate does not over-suppress: it still fires when nothing breaks the entry\'s grounding',
    async run() {
      // The markdown-grounding fix above must not go too far: when a degree
      // entry sits under a nested markdown subheading with no decoration
      // inside its own clause, ingest strips only the "###" heading marks
      // (pastePlainLineText), so an unedited reading of the entry still
      // occurs verbatim in the raw text. The gate must still demand it.
      const degreeEntry = 'B.S. Computer Science, Halden University';
      const careerData = `${DEGREE_PROSE_CORPUS}\n## Education\n\n### ${degreeEntry}\n*Lakeview · Graduated 2018*\n`;
      const { rounds, trustedCredential } = await submitDegreePlans(careerData, [null, degreeEntry]);
      const [dropped, repaired] = rounds;
      assert(!dropped.accepted && dropped.gate,
        `dropping the credential still fires the gate when nothing breaks the entry's grounding (errors=${JSON.stringify(dropped.errors)})`);
      assert(!dropped.echoes.length && !dropped.quoted.length,
        `the rejection still copies nothing out of career data (echoes=${JSON.stringify(dropped.echoes)}, quoted=${JSON.stringify(dropped.quoted)}, gate=${JSON.stringify(dropped.gate)})`);
      assert(repaired.accepted && repaired.nextStage === 'resume' && trustedCredential === degreeEntry,
        `the degree as career data writes it is accepted in one round (credential=${JSON.stringify(trustedCredential)}, errors=${JSON.stringify(repaired.errors)})`);
      return { credential: trustedCredential };
    },
  },
  {
    name: 'Paste degree gate reads every education region, not only the first heading it meets',
    async run() {
      // A stray bare line reading "Education" earlier in the corpus — inside
      // a freeform Skills/Domains section, not a list item, so it really
      // does open a region of its own — used to make the scan stop there
      // before it ever reached the real "## Education" section further
      // down. The degree was then dropped with no rejection at all: the
      // exact silent drop this gate exists to prevent. The gate must keep
      // scanning past the stray, contentless region and still find, and
      // demand, the real degree beyond it.
      const careerData = `${DEGREE_PROSE_CORPUS}\n## Skills\n\nDomains\nEducation\nReporting and analytics, data visualization\n\n## Education\n\n${CLEAN_DEGREE}\nHalden University\n`;
      const { rounds, trustedCredential } = await submitDegreePlans(careerData, [null, CLEAN_DEGREE]);
      const [dropped, repaired] = rounds;
      assert(!dropped.accepted && dropped.gate,
        `a stray earlier "Education" line does not shadow the real section: the gate still fires (errors=${JSON.stringify(dropped.errors)})`);
      assert(!dropped.echoes.length && !dropped.quoted.length,
        `the rejection still copies nothing out of career data (echoes=${JSON.stringify(dropped.echoes)}, quoted=${JSON.stringify(dropped.quoted)}, gate=${JSON.stringify(dropped.gate)})`);
      assert(repaired.accepted && repaired.nextStage === 'resume' && trustedCredential === CLEAN_DEGREE,
        `the real degree past the stray heading is accepted in one round (credential=${JSON.stringify(trustedCredential)}, errors=${JSON.stringify(repaired.errors)})`);
      return { credential: trustedCredential };
    },
  }, */
  {
    name: 'Paste evidence plan leaves education out of the frozen identity header',
    async run() {
      const degreeCareerData = DEGREE_PROSE_CORPUS + SEPARATE_LINE_EDUCATION;
      const { rounds, prompt, trustedCredential } = await submitDegreePlans(degreeCareerData, [null]);
      assert(rounds[0].accepted && rounds[0].nextStage === 'resume' && !rounds[0].gate,
        `a plan with no header credential reaches the resume stage (errors=${JSON.stringify(rounds[0].errors)})`);
      assert(trustedCredential === null,
        `a degree is not frozen into identity.credential by source order (credential=${JSON.stringify(trustedCredential)})`);
      assert(prompt.includes('Education is a first-class evidence-backed résumé section.')
        && !prompt.includes('The rendered résumé has NO Education section')
        && !prompt.includes('Omit identity.credential only when careerData documents no completed degree'),
      'the evidence-plan contract directs degree evidence to resume.education instead of a required header field');
      return { headerCredential: trustedCredential };
    },
  },
  {
    name: 'Paste resume accepts cited education, rejects forged education, and preserves legacy headers',
    async run() {
      const project = await createCanvasProject();
      try {
        const degreeCareerData = DEGREE_PROSE_CORPUS + SEPARATE_LINE_EDUCATION;
        const queued = await queueLocalApplicationJob({
          transport: 'paste', canvasFilePath: project.canvasFilePath, careerData: degreeCareerData,
          job: { title: 'Reporting Engineer', company: 'Acme', snippet: 'Build reporting systems.' },
          resumeProfile: { workHistory: [{ id: 'role-1', title: 'Software Engineer', employer: 'Analytical Engines', startDate: '2020', endDate: '2024' }] },
        });
        const planHandoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath })).handoff;
        const identity = { name: 'Jordan Reyes', contact: ['jordan@example.test'], subtitleRole: 'Software Engineer' };
        const plan = {
          identity,
          evidence: [
            { id: 'career-proof', sourceId: 'career-data', quote: 'Built reporting systems that reduced manual work.', requirement: 'Reporting systems', priority: 'highest' },
            { id: 'education-proof', sourceId: 'career-data', quote: `${CLEAN_DEGREE}\nHalden University`, requirement: 'Computer science education', priority: 'supporting' },
            { id: 'job-proof', sourceId: 'job-listing', quote: '# Reporting Engineer', requirement: 'Reporting systems', priority: 'highest' },
          ],
          requirements: [
            { id: 'need-1', text: 'Reporting systems', priority: 'highest', evidenceIds: ['career-proof', 'job-proof'] },
            { id: 'need-2', text: 'Computer science education', priority: 'supporting', evidenceIds: ['education-proof', 'job-proof'] },
          ],
        };
        const planned = await submitLocalApplicationHandoff({
          jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: planHandoff.handoffCode,
          response: JSON.stringify(reply(planHandoff, plan)),
        });
        assert(planned.accepted && planned.handoff?.stage === 'resume',
          `the cited education plan opens the resume handoff (errors=${JSON.stringify(planned.validationErrors || [])})`);

        const resumeHandoff = planned.handoff;
        const baseResume = {
          schemaVersion: 'structured-resume.v1', identity,
          roles: [{ id: 'role-1', title: 'Software Engineer', company: 'Analytical Engines', dates: '2020 – 2024', location: '', bullets: [{ id: 'bullet-1', text: 'Built reporting systems that reduced manual work.', evidenceIds: ['career-proof'] }] }],
          education: [{ id: 'education-1', credential: CLEAN_DEGREE, institution: 'Halden University', evidenceIds: ['education-proof'] }],
        };
        const forged = await submitLocalApplicationHandoff({
          jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: resumeHandoff.handoffCode,
          response: JSON.stringify(reply(resumeHandoff, { resume: { ...baseResume, education: [{ ...baseResume.education[0], credential: 'Master of Science in Computer Science' }] } })),
        });
        assert(!forged.accepted && forged.handoff?.stage === 'resume'
          && forged.validationErrors.some(error => /education|evidence|career data/i.test(error)),
        `an education field not supported by its own cited evidence is rejected (errors=${JSON.stringify(forged.validationErrors || [])})`);

        const accepted = await submitLocalApplicationHandoff({
          jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: resumeHandoff.handoffCode,
          response: JSON.stringify(reply(resumeHandoff, { resume: baseResume })),
        });
        assert(accepted.accepted && accepted.handoff?.stage === 'cover-letter',
          `the same resume with exact education evidence is accepted (errors=${JSON.stringify(accepted.validationErrors || [])})`);
        const rendered = renderStructuredApplicationResume(baseResume, {
          sourceRoles: [{ id: 'role-1', title: 'Software Engineer', company: 'Analytical Engines', dates: '2020 – 2024', location: '' }],
          evidenceCatalog: plan.evidence,
          trustedIdentity: identity,
          careerData: degreeCareerData,
        });
        assert(rendered.includes('id="sec-education"') && rendered.includes('<dt>') && rendered.includes(CLEAN_DEGREE),
          'accepted education renders as a compact semantic credentials list');

        const legacyHeader = { ...baseResume, identity: { ...identity, credential: `${CLEAN_DEGREE}, Halden University` }, education: [] };
        const legacyRendered = renderStructuredApplicationResume(legacyHeader, {
          sourceRoles: [{ id: 'role-1', title: 'Software Engineer', company: 'Analytical Engines', dates: '2020 – 2024', location: '' }],
          evidenceCatalog: plan.evidence,
          trustedIdentity: legacyHeader.identity,
          careerData: degreeCareerData,
        });
        assert(legacyRendered.includes(`${CLEAN_DEGREE}, Halden University`) && !legacyRendered.includes('id="sec-education"'),
          'a historical accepted header credential remains readable without inventing an Education section');
        return { education: 'accepted', legacyHeader: 'readable' };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Paste evidence plan cannot be wedged by a degree the listing alone demands',
    async run() {
      // Career data documents no degree. The listing's own "Bachelor's degree"
      // wording lives in jobListing, which this gate never reads, so an honest
      // plan with no credential must still open the résumé stage.
      const project = await createCanvasProject();
      try {
        const queued = await queueLocalApplicationJob({
          transport: 'paste', canvasFilePath: project.canvasFilePath, careerData,
          job: { title: 'Reporting Engineer', company: 'Acme', snippet: "Bachelor's degree in Computer Science or equivalent experience required." },
          resumeProfile: { workHistory: [{ id: 'role-1', title: 'Software Engineer', employer: 'Analytical Engines', startDate: '2020', endDate: '2024' }] },
        });
        const handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath })).handoff;
        assert(handoff.prompt.includes("Bachelor's degree in Computer Science"),
          'the frozen job listing really does state a degree requirement the responder can see');
        const accepted = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(reply(handoff, {
          identity: { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: 'Software Engineer', credential: '' },
          evidence: [
            { id: 'career-proof', sourceId: 'career-data', quote: 'Built reporting systems that reduced manual work.', requirement: 'Reporting systems', priority: 'highest' },
            { id: 'job-proof', sourceId: 'job-listing', quote: '# Reporting Engineer', requirement: 'Reporting systems', priority: 'highest' },
          ],
          requirements: [{ id: 'need-1', text: 'Reporting systems', priority: 'highest', evidenceIds: ['career-proof', 'job-proof'] }],
        })) });
        assert(accepted.accepted && accepted.handoff?.stage === 'resume',
          `a candidate whose career data documents no degree still passes the evidence plan with no credential (errors=${JSON.stringify(accepted.validationErrors || [])})`);
        return { accepted: true };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'The evidence plan accepts the posting\u2019s work-authorization requirement and the career fact that answers it',
    async run() {
      // Work authorization is managed on the application form by the user, so
      // no stage of this pipeline reads it. The live e2e job froze a plan
      // whose highest-priority requirement restates a posting eligibility
      // clause and whose career evidence quotes the candidate's own standing;
      // both shapes are reproduced here, in every plan field they can enter
      // through, and all of them advance the job.
      const project = await createCanvasProject();
      try {
        const statusLine = 'Freedonian citizenship';
        const careerCorpus = [VERBATIM_CAREER_DATA, statusLine, ...WORK_STATUS_LINES].join('\n');
        const eligibilityClause = 'This role is open to candidates who are located in, and authorized to work in, Freedonia.';
        const listing = `${VERBATIM_LISTING_LINE} ${eligibilityClause}`;
        const extras = { careerData: careerCorpus, job: { title: PLAN_ESCAPED_TITLE, company: PLAN_COMPANY, snippet: listing } };
        const firstHandoff = (await getLocalApplicationHandoff({ jobId: (await queuePlanJob(project, extras)).id, canvasFilePath: project.canvasFilePath })).handoff;
        // The contract must not carry a rule no gate enforces: a responder
        // told to keep the fact out of the plan would omit the requirement
        // the posting ranks highest.
        assert(!/legal work status/iu.test(firstHandoff.prompt),
          'the evidence-plan contract states no legal-work-status rule, because no stage enforces one');

        const submit = async (fields) => {
          const queued = await queuePlanJob(project, extras);
          const handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath })).handoff;
          return submitLocalApplicationHandoff({
            jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoffCode,
            response: JSON.stringify(reply(handoff, { ...planBody(), ...fields })),
          });
        };

        // The live job's own plan shape: the candidate's standing quoted from
        // career data, backing a requirement that restates the clause.
        const livePlanShape = await submit({
          evidence: [
            { ...planBody().evidence[0], quote: statusLine, requirement: 'Demonstrate authorization to work in Freedonia.' },
            { ...planBody().evidence[1], quote: eligibilityClause, requirement: 'Be authorized to work in Freedonia.' },
          ],
          requirements: [{ ...PLAN_REQUIREMENT, text: 'Candidate must be located in and authorized to work in Freedonia and align working hours to the Northern Time Zone.' }],
        });
        assert(livePlanShape.accepted && livePlanShape.handoff?.stage === 'resume',
          `the live job's accepted plan shape passes unchanged (errors=${JSON.stringify(livePlanShape.validationErrors || [])})`);

        // Every field the fact can enter through, for both shapes.
        const submissions = [];
        for (const line of WORK_STATUS_LINES) {
          submissions.push([line, 'career-data quote', await submit({ evidence: [{ ...planBody().evidence[0], quote: line }, planBody().evidence[1]] })]);
          submissions.push([line, 'evidence requirement prose', await submit({ evidence: [planBody().evidence[0], { ...planBody().evidence[1], requirement: line }] })]);
          submissions.push([line, 'requirement text', await submit({ requirements: [{ ...PLAN_REQUIREMENT, text: line }] })]);
        }
        const rejected = submissions.filter(([, , result]) => !result.accepted);
        assert(!rejected.length,
          `no plan field rejects work-authorization prose (rejected: ${JSON.stringify(rejected.map(([line, field, result]) => [field, line, result.validationErrors]))})`);
        return { fields: 3, submissions: submissions.length };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'A completed package re-validates identically on the status poll and the import, and a rejection there still yields a handoff',
    async run() {
      // The plan-derived audit bound was added at the final submit only. The
      // status poll and the import re-grade the SAME result.json, and both
      // resolved their own options — so with no plan in hand they fell back to
      // the legacy 12-decision literal and rejected a 13-requirement package
      // the submit had just accepted. That is worse than the cap it replaced:
      // the paste state is already 'completed' with handoffCode null, so the
      // job could not be repaired, only discarded. The prior round's controls
      // missed it because they stopped at the submit.
      const project = await createCanvasProject();
      const pdf = await PDFDocument.create(); pdf.addPage([612, 792]);
      const bytes = Buffer.from(await pdf.save());
      __setLocalAiRenderPdfForTests(async () => ({ bytes, pageCount: 1, fontsLoaded: true, missingFontFaces: [], layout: { contentHeightPx: 760, typeAreaHeightPx: 800 } }));
      try {
        const plan = auditPlanFixture();
        assert(plan.requirements.length === 13, 'the fixture plan still carries more requirements than the retired literal allowed');
        const flow = await runAuditFlow(project, plan);
        const complete = await flow.review(plan.audit());
        assert(complete.accepted && complete.completed, `the final submit accepts the 13-requirement audit (errors=${JSON.stringify(complete.validationErrors || [])})`);

        const jobId = flow.queued.id;
        const { canvasFilePath } = project;
        const polled = await localApplicationStatus(jobId, canvasFilePath);
        assert(polled.status === 'completed',
          `the status poll re-grades the accepted result the same way the submit did (status=${polled.status}, message=${polled.message})`);
        const settled = await getLocalApplicationHandoff({ jobId, canvasFilePath });
        assert(settled.completed && settled.handoff === null,
          'a package both gates accept stays completed, with no handoff to answer');
        const imported = await importLocalApplicationJob({ jobId, canvasFilePath, senderId: 9912 });
        assert(imported.status === 'imported',
          `the import re-grades it the same way too (status=${imported.status})`);

        // Second half: the dead-end shape itself. Reject a completed package at
        // the poll — for any reason — and the job must still hand back a live
        // review handoff rather than parking on handoffCode null forever.
        const wedged = await createCanvasProject();
        try {
          const secondFlow = await runAuditFlow(wedged, plan);
          const second = await secondFlow.review(plan.audit());
          assert(second.accepted && second.completed, 'the second job completes before its result is corrupted');
          const folder = (await localApplicationStatus(secondFlow.queued.id, wedged.canvasFilePath)).folder;
          const resultPath = path.join(folder, 'result.json');
          const stored = JSON.parse(await fs.promises.readFile(resultPath, 'utf8'));
          stored.generationAudit.jobPriorities.pop();
          await fs.promises.writeFile(resultPath, JSON.stringify(stored), 'utf8');
          const rejected = await localApplicationStatus(secondFlow.queued.id, wedged.canvasFilePath);
          assert(rejected.status === 'invalid' && rejected.message.includes('must audit every requirement'),
            `the poll rejects the corrupted audit and says which requirement is missing (status=${rejected.status}, message=${rejected.message})`);
          const recovery = await getLocalApplicationHandoff({ jobId: secondFlow.queued.id, canvasFilePath: wedged.canvasFilePath });
          assert(!recovery.completed && recovery.handoff?.stage === 'review' && recovery.handoff.handoffCode
            && recovery.handoff.prompt.includes('must audit every requirement'),
          `a host rejection of a completed package reopens the review with the rejection in the prompt (completed=${recovery.completed}, code=${recovery.handoff?.handoffCode || 'null'})`);
          assert(recovery.handoff.corrections?.length === 1 && recovery.handoff.correctionPrompt.includes('must audit every requirement')
            && recovery.handoff.correctionPrompt.includes(recovery.handoff.handoffCode)
            && recovery.handoff.correctionPrompt.length * 2 < recovery.handoff.prompt.length,
          `the reopened round also hands back the host rejection as a correction delta (correction=${recovery.handoff.correctionPrompt?.length}, stage=${recovery.handoff.prompt.length})`);
        } finally {
          await fs.promises.rm(wedged.root, { recursive: true, force: true });
        }
        return { requirements: plan.requirements.length, gates: 3 };
      } finally {
        __setLocalAiRenderPdfForTests(null);
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Each stage ships only the criteria and plan fields it can act on, and the review still receives all 24',
    async run() {
      // Line 481 shipped the whole canonical checklist to every stage after the
      // plan, so the résumé prompt carried twelve criteria judging a letter
      // that does not exist and that a résumé response has no field to state,
      // and the letter prompt carried nine judging a résumé already frozen.
      // The accepted plan was shipped whole for the same reason — including
      // its own stage-1 protocol envelope, whose stale handoffCode and
      // all-empty baseHashes contradict the Shared fields block above them.
      const project = await createCanvasProject();
      try {
        const plan = auditPlanFixture();
        const { prompts, send, current } = await auditJobSteps(project);
        const planHandoff = await current();
        await send({ identity: plan.identity, evidence: plan.evidence, requirements: plan.requirements });
        const resumeHandoff = await current();
        await send({ resume: plan.resume });
        await send({ coverLetter: plan.coverLetter });
        prompts.review = (await current()).prompt;

        const criterionIds = stage => pasteContext(prompts[stage]).criteria.map(criterion => criterion.id);
        const canonicalIds = APPLICATION_QUALITY_CRITERIA.map(criterion => criterion.id);
        const documentOf = id => APPLICATION_QUALITY_CRITERIA.find(criterion => criterion.id === id)?.document;
        const inCanonicalOrder = ids => JSON.stringify(ids) === JSON.stringify(canonicalIds.filter(id => ids.includes(id)));

        assert(JSON.stringify(criterionIds('evidence-plan')) === JSON.stringify([...EVIDENCE_PLAN_CRITERION_IDS]),
          `the evidence-plan stage keeps its measured three criteria (got ${JSON.stringify(criterionIds('evidence-plan'))})`);

        const resumeIds = criterionIds('resume');
        assert(resumeIds.every(id => documentOf(id) === 'resume' || id === 'requirement-coverage')
          && resumeIds.filter(id => documentOf(id) === 'resume').length === canonicalIds.filter(id => documentOf(id) === 'resume').length
          && resumeIds.includes('requirement-coverage') && inCanonicalOrder(resumeIds),
          `the résumé stage ships every résumé criterion plus requirement coverage, in canonical order (got ${JSON.stringify(resumeIds)})`);
        assert(!resumeIds.some(id => documentOf(id) === 'coverLetter')
          && !prompts.resume.includes(APPLICATION_QUALITY_CRITERIA.find(criterion => criterion.id === 'cover-continuity').requirement),
          'no cover-letter criterion reaches the résumé stage, in the checklist or anywhere else in the prompt');

        const letterIds = criterionIds('cover-letter');
        assert(letterIds.every(id => documentOf(id) === 'coverLetter' || id === 'cross-document-consistency' || id === 'requirement-coverage')
          && letterIds.filter(id => documentOf(id) === 'coverLetter').length === canonicalIds.filter(id => documentOf(id) === 'coverLetter').length
          && letterIds.includes('cross-document-consistency') && inCanonicalOrder(letterIds)
          && !letterIds.some(id => documentOf(id) === 'resume'),
          `the cover-letter stage ships every letter criterion plus the two decidable cross-document ones (got ${JSON.stringify(letterIds)})`);

        // The review validator compares the pasted checklist against the whole
        // canonical list, so a filtered review prompt would reject every
        // possible answer. Assert the list AND that a full checklist is taken.
        assert(JSON.stringify(criterionIds('review')) === JSON.stringify(canonicalIds),
          `the review stage still receives all ${canonicalIds.length} criteria, in canonical order (got ${criterionIds('review').length})`);

        const resumeContext = pasteContext(prompts.resume);
        assert(JSON.stringify(Object.keys(resumeContext.evidencePlan)) === JSON.stringify(['evidence', 'requirements']),
          `the accepted plan ships as evidence and requirements only (got ${JSON.stringify(Object.keys(resumeContext.evidencePlan))})`);
        assert(resumeContext.evidencePlan.evidence.every(item => JSON.stringify(Object.keys(item)) === JSON.stringify(['id', 'sourceId', 'quote'])),
          'every evidence item ships exactly the three fields the validators read');
        assert(resumeContext.evidencePlan.requirements.length === plan.requirements.length
          && resumeContext.evidencePlan.requirements.every((item, index) => JSON.stringify(item) === JSON.stringify(plan.requirements[index])),
          'requirements survive untouched: they carry the prioritization the per-item fields only paraphrased');
        assert(!prompts.resume.includes(planHandoff.handoffCode) && !prompts.resume.includes('"stage": "evidence-plan"')
          && prompts.resume.includes(`"handoffCode": "${resumeHandoff.handoffCode}"`) && resumeHandoff.handoffCode !== planHandoff.handoffCode
          && !('identity' in resumeContext.evidencePlan) && resumeContext.trustedIdentity?.name === plan.identity.name,
          'the stale stage-1 envelope and the duplicate identity are gone; only the live shared fields and trustedIdentity remain');

        assert(!('resume' in resumeContext) && !('coverLetter' in resumeContext)
          && !('reviewFindings' in resumeContext) && !('requiredChangeDocuments' in resumeContext),
          `the résumé stage prints no empty or not-yet-written document key (got ${JSON.stringify(Object.keys(resumeContext))})`);
        const letterContext = pasteContext(prompts['cover-letter']);
        assert(letterContext.resume?.roles?.length === 1 && !('coverLetter' in letterContext) && !('reviewFindings' in letterContext),
          'the cover-letter stage sees the résumé it must agree with, and nothing that has not been written yet');
        const reviewContext = pasteContext(prompts.review);
        assert(reviewContext.resume && reviewContext.coverLetter && !('reviewFindings' in reviewContext) && !('requiredChangeDocuments' in reviewContext),
          'a first review sees both documents and no empty findings array');

        // Bytes, measured against this same context rebuilt the way it used to
        // ship, rather than asserted as a constant. The flow above already
        // proved every stage is still accepted, so the saving is not paid for
        // with a field some gate reads.
        const shipped = JSON.stringify(resumeContext, null, 2).length;
        const asShippedBefore = JSON.stringify({
          ...resumeContext, criteria: APPLICATION_QUALITY_CRITERIA,
          evidencePlan: { identity: plan.identity, evidence: plan.evidence, requirements: plan.requirements },
          resume: null, coverLetter: null, reviewFindings: [], requiredChangeDocuments: [],
        }, null, 2).length;
        assert(asShippedBefore - shipped > 3_000,
          `the résumé context sheds the material no résumé gate reads (${asShippedBefore} -> ${shipped} chars)`);

        // The drafting stages cite these IDs while they write, so both copies
        // ship there. By the review the plan's copy of a job-listing quote is
        // a second printing of a posting the same context carries in full, and
        // nothing the review returns is graded against it: a replacement's
        // grounding reads career-data quotes, and jobNeedQuote reads the
        // posting. The id and source stay so requirements[].evidenceIds still
        // resolve.
        const listingEvidence = context => context.evidencePlan.evidence.filter(item => item.sourceId === 'job-listing');
        const careerEvidence = context => context.evidencePlan.evidence.filter(item => item.sourceId === 'career-data');
        assert(listingEvidence(letterContext).every(item => typeof item.quote === 'string' && item.quote)
          && listingEvidence(resumeContext).every(item => typeof item.quote === 'string' && item.quote),
        'the two drafting stages still read every quote they cite');
        assert(listingEvidence(reviewContext).length === listingEvidence(resumeContext).length
          && listingEvidence(reviewContext).every(item => JSON.stringify(Object.keys(item)) === JSON.stringify(['id', 'sourceId']))
          && careerEvidence(reviewContext).every(item => JSON.stringify(Object.keys(item)) === JSON.stringify(['id', 'sourceId', 'quote'])),
        `the review reads every job-listing id and source without a second copy of the posting, and every career-data quote whole (got ${JSON.stringify(listingEvidence(reviewContext)[0] || null)})`);
        const reviewShipped = JSON.stringify(reviewContext, null, 2).length;
        const reviewAsShippedBefore = JSON.stringify({
          ...reviewContext,
          evidencePlan: { ...reviewContext.evidencePlan, evidence: plan.evidence.map(({ id, sourceId, quote }) => ({ id, sourceId, quote })) },
        }, null, 2).length;
        assert(reviewAsShippedBefore > reviewShipped
          && plan.requirements.flatMap(item => item.evidenceIds).every(id => reviewContext.evidencePlan.evidence.some(item => item.id === id)),
        `the review context sheds the duplicated posting quotes without leaving one requirement evidenceId unresolved (${reviewAsShippedBefore} -> ${reviewShipped} chars)`);
        return { resumeCriteria: resumeIds.length, letterCriteria: letterIds.length, reviewCriteria: criterionIds('review').length, contextChars: shipped, reviewContextChars: reviewShipped };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },  {
    name: 'Two cover-letter paragraphs failing the same structural check are reported as two distinct items, not deduped into one',
    async run() {
      // normalizePasteCorrections dedupes by exact string equality. Each
      // structural paragraph message is built from `${unit}`, which names
      // the paragraph by its own id (see the comment at this check's own
      // site), so two independently empty paragraphs must never collapse
      // into one byte-identical string that hides a sibling defect.
      const project = await createCanvasProject();
      try {
        const { letter } = await coverLetterBatteryStage(project, { paragraphs: [`${BATTERY_LEAD} ${BATTERY_BODY}`] });
        const result = await letter({
          paragraphs: [
            { id: 'paragraph-1', text: '', evidenceIds: ['job-proof'] },
            { id: 'paragraph-2', text: '', evidenceIds: ['job-proof'] },
          ],
        });
        assert(!result.accepted, 'two empty paragraphs must be rejected');
        const errors = result.validationErrors || [];
        assert(errors.includes('Cover-letter paragraph paragraph-1 has no text.') && errors.includes('Cover-letter paragraph paragraph-2 has no text.'),
          `each empty paragraph must be named by its own id as a separate item, not collapsed into one (errors=${JSON.stringify(errors)})`);
        assert(new Set(errors).size === errors.length,
          `no two distinct paragraph defects may collapse to the same message string (errors=${JSON.stringify(errors)})`);
        return { errors: errors.length };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'The import path records its quality-review rejection too, so the one host gate the recovery could not reach no longer wedges a completed package',
    async run() {
      // recoverPasteHostValidationHandoff reopens a completed package from the
      // hash-bound rejection record, and claims to cover whatever a later
      // check rejects. It could not cover this one: only the validate call was
      // wrapped in the catch that writes the record, while
      // assertLocalAiQualityReviewConsistency — the other host gate that can
      // reject an already-completed package on the import path — threw past
      // it. The job then sat on stage 'completed' with handoffCode null and
      // nothing left to repair it.
      const project = await createCanvasProject();
      const pdf = await PDFDocument.create(); pdf.addPage([612, 792]);
      const bytes = Buffer.from(await pdf.save());
      __setLocalAiRenderPdfForTests(async () => ({ bytes, pageCount: 1, fontsLoaded: true, missingFontFaces: [], layout: { contentHeightPx: 760, typeAreaHeightPx: 800 } }));
      try {
        const plan = auditPlanFixture();
        const flow = await runAuditFlow(project, plan);
        const complete = await flow.review(plan.audit());
        assert(complete.accepted && complete.completed, `the package completes before anything is tampered with (errors=${JSON.stringify(complete.validationErrors || [])})`);
        const jobId = flow.queued.id;
        const { canvasFilePath } = project;
        const settled = await localApplicationStatus(jobId, canvasFilePath);
        assert(settled.status === 'completed', `the poll that precedes an import accepts the package (status=${settled.status}, message=${settled.message})`);
        const folder = settled.folder;

        // The race the import's own recording comment already describes, on
        // the other file: a measured record left behind by an earlier result
        // lands between that poll and the import. The import then re-grades
        // the same bytes against it and the assert rejects a decision that is
        // correct for what is on disk — the one host rejection of a completed
        // package that used to leave the job folder silent.
        await fs.promises.writeFile(path.join(folder, 'fit-feedback.json'), JSON.stringify({
          version: 1, jobId, status: 'revision-required', measured: true,
          resultSha256: crypto.createHash('sha256').update('some other result').digest('hex'),
          revisionRound: 1,
          documentSha256: { resume: 'a'.repeat(64), coverLetter: 'b'.repeat(64) },
          resume: { pageCount: 2, targetPageCount: 1 }, coverLetter: { pageCount: 1, targetPageCount: 1 },
          message: 'A stale measured advisory for bytes this job no longer carries.',
        }), 'utf8');
        let importError = '';
        try {
          await importLocalApplicationJob({ jobId, canvasFilePath, senderId: 9913 });
        } catch (error) {
          importError = String(error?.message || error);
        }
        assert(/qualityReview\.resume\.decision must be changed_materially/.test(importError),
          `the import rejects the completed package at the quality-review assert (error=${importError})`);

        const recovery = await getLocalApplicationHandoff({ jobId, canvasFilePath });
        assert(!recovery.completed && recovery.handoff?.stage === 'review' && recovery.handoff.handoffCode,
          `that rejection reopens the review instead of leaving the job completed with no handoff (completed=${recovery.completed}, code=${recovery.handoff?.handoffCode || 'null'})`);
        assert(recovery.handoff.prompt.includes('must be changed_materially'),
          'the reopened prompt carries the rejection the import reported, so the round has a target');
        return { gate: 'assertLocalAiQualityReviewConsistency', reopened: true };
      } finally {
        __setLocalAiRenderPdfForTests(null);
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'A job already in flight is never told a rule the host withdrew, and the letter contract prints the grounding rule its own gate reads',
    async run() {
      // A queued job freezes the checklist into its own input.json, and every
      // later prompt printed that frozen copy verbatim. So a criterion narrowed
      // in the code went on being stated, in full, to the job in flight —
      // measured on a live mid-test job whose stage-3 prompt still named a
      // rule no gate enforces. The frozen copy still decides WHICH criteria
      // exist and in which order, because the review's checklist is compared
      // against those ids; only the wording is taken from the current canon,
      // which is also what the deterministic checks at review time apply.
      const project = await createCanvasProject();
      try {
        const plan = auditPlanFixture();
        const steps = await auditJobSteps(project);
        const inputPath = path.join(project.root, '.local-ai', 'jobs', steps.queued.id, 'input.json');
        const input = JSON.parse(await fs.promises.readFile(inputPath, 'utf8'));
        // The id AND the wording this criterion carried before the rule was
        // withdrawn. A job queued then froze both, so this is what an in-flight
        // job's input.json actually holds, and the rename has to survive it:
        // the review is required to echo the frozen id back, and the
        // completion-time sanitizer compares that answer against the canon.
        const retiredId = 'cover-legal-status';
        const withdrawn = 'The letter contains no application logistics: availability, start date, schedule, work location, relocation, commute, travel willingness, citizenship, residency, visa, sponsorship, or work-authorization statement.';
        assert(!APPLICATION_QUALITY_CRITERIA.some(item => item.id === retiredId),
          'the canon no longer carries an id that names a rule no stage enforces');
        input.qualityChecklist.criteria = input.qualityChecklist.criteria.map(item =>
          (item.id === 'cover-logistics-exclusion' ? { ...item, id: retiredId, requirement: withdrawn } : item));
        const frozenIds = input.qualityChecklist.criteria.map(item => item.id);
        assert(frozenIds.includes(retiredId), 'the simulated in-flight job is frozen on the retired spelling');
        await fs.promises.writeFile(inputPath, JSON.stringify(input, null, 2), 'utf8');

        await steps.send({ identity: plan.identity, evidence: plan.evidence, requirements: plan.requirements });
        await steps.send({ resume: plan.resume });
        const prompt = (await steps.current()).prompt;
        // A renamed criterion has a forwarding address, so the in-flight job's
        // frozen spelling still resolves to the wording the host will apply.
        const canonical = new Map([
          ...APPLICATION_QUALITY_CRITERIA.map(item => [item.id, item]),
          [retiredId, APPLICATION_QUALITY_CRITERIA.find(item => item.id === 'cover-logistics-exclusion')],
        ]);
        const shipped = pasteContext(prompt).criteria;
        assert(!/citizenship|residency|\bvisa\b|sponsorship|work.authorization|legal work status/iu.test(prompt),
          'no clause and no criterion states a work-status rule, because no stage enforces one');
        assert(shipped.length && shipped.every(item => item.requirement === canonical.get(item.id)?.requirement),
          `every criterion ships the host's current wording (stale=${JSON.stringify(shipped.filter(item => item.requirement !== canonical.get(item.id)?.requirement).map(item => item.id))})`);
        const shippedIds = shipped.map(item => item.id);
        assert(JSON.stringify(shippedIds) === JSON.stringify(frozenIds.filter(id => shippedIds.includes(id))),
          `the frozen copy still decides which criteria ship and in what order (shipped=${JSON.stringify(shippedIds)})`);

        // Two grounding rules of the same shape exist. The one printed here
        // must be the one that grades a letter paragraph: the résumé module's
        // rule drops a different word list, so a paragraph that cleared the
        // printed floor was rejected by the gate for sharing one term.
        assert(prompt.includes(`share at least ${MIN_SHARED_SOURCE_TERMS} meaningful terms with those quotes — ${SOURCE_TERM_OVERLAP_RULE}`),
          'the paragraph floor and the term rule are interpolated from the gate that rejects the paragraph');
        assert(!prompt.includes(CAREER_TERM_OVERLAP_RULE),
          'the résumé gate’s term rule is not printed beside the letter gate, where it would look live and is not');
        assert(prompt.includes(COVER_LETTER_LOGISTICS_PROMISE_CLASSES),
          'the logistics classes are the labels checkLogisticsExclusion reads, so a class added there reaches the prompt');
        assert(!prompt.includes('controllingThesis'),
          'the letter schema asks for one thesis field, not three that the host silently resolves');

        const accepted = await steps.submit({ coverLetter: plan.coverLetter });
        assert(accepted.result.accepted && accepted.result.handoff?.stage === 'review',
          `the letter fixture still passes the stage whose contract changed (errors=${JSON.stringify(accepted.result.validationErrors || [])})`);
        const reviewCriteria = pasteContext(accepted.result.handoff.prompt).criteria;
        assert(JSON.stringify(reviewCriteria.map(item => item.id)) === JSON.stringify(frozenIds)
          && reviewCriteria.every(item => item.requirement === canonical.get(item.id)?.requirement),
        'the review still receives every frozen id in order, each carrying the wording the host will apply');
        // With one thesis field in the letter, the audit's copy of it is an
        // equality the review can satisfy on sight — it was enforced silently.
        assert(accepted.result.handoff.prompt.includes('coverLetterPlan.controllingThesis must repeat the accepted letter’s roleThesis'),
          'the review contract states the audit-thesis equality its own gate enforces');

        // The frozen spelling is the only answer this job is allowed to give,
        // and the completion-time sanitizer compares that answer against the
        // current canon. A rename without a forwarding address would strand
        // the job here — every drafting round already spent, and the one
        // remaining repair not expressible in the contract it was issued.
        const pdfDoc = await PDFDocument.create(); pdfDoc.addPage([612, 792]);
        const bytes = Buffer.from(await pdfDoc.save());
        __setLocalAiRenderPdfForTests(async () => ({ bytes, pageCount: 1, fontsLoaded: true, missingFontFaces: [], layout: { contentHeightPx: 760, typeAreaHeightPx: 800 } }));
        try {
          const completed = await steps.submit({
            decision: 'pass', findings: [],
            checklist: frozenIds.map(id => ({ id, status: 'pass', detail: 'Checked this criterion against the current structured documents.' })),
            qualityReview: {
              checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION,
              criteria: frozenIds.map(id => ({ id, status: 'pass', evidence: canonical.get(id).requirement })),
              resume: { decision: 'approved', rationale: 'The résumé preserves direct source-supported systems evidence with clear relevance.' },
              coverLetter: { decision: 'approved', rationale: 'One controlling argument uses minimum-sufficient evidence for target system delivery.' },
            },
            generationAudit: plan.audit(),
          });
          assert(completed.result.accepted && completed.result.completed,
            `a review answering with its own frozen criterion ids still completes (errors=${JSON.stringify(completed.result.validationErrors || [])})`);
        } finally {
          __setLocalAiRenderPdfForTests(null);
        }
        return { criteria: shipped.length, reviewCriteria: reviewCriteria.length, retiredId };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'The cover-letter stage ships the résumé it is graded against, without the ID space it cannot cite',
    async run() {
      // The letter is measured against the RENDERED résumé: checkRedundancy
      // reads bullet text, checkFigureDiscipline reads the bullet the argument
      // quotes, and the argument's evidenceRole is matched against that
      // bullet's role. None of that reads the structured wrapper the résumé
      // stage returned — and two of its fields are outright duplicates
      // (identity repeats trustedIdentity) or uncitable (every role, bullet,
      // project and skill id belongs to a different ID space than the evidence
      // IDs a paragraph may name). This case pins what survives the projection
      // and, more importantly, that nothing the letter is graded on is hidden.
      const project = await createCanvasProject();
      try {
        const careerCorpus = [
          'Ada Lovelace', 'ada@example.test', 'Software Engineer', '',
          '## Analytical Engines — Bristol, England', '', 'Senior Engineer',
          '- Built the reporting pipeline for nightly batches.', '', '---', '',
          '## Difference Machines — Leeds, England', '', 'Software Engineer',
          '- Shipped the billing service with automated alerts.', '', '---', '',
          '## Personal Projects', '',
          '- Built a dispatch route planner with a local Llama model.', '',
        ].join('\n');
        const workHistory = [
          { id: 'role-1', title: 'Senior Engineer', employer: 'Analytical Engines', startDate: '2021', endDate: '2024' },
          { id: 'role-2', title: 'Software Engineer', employer: 'Difference Machines', startDate: '2018', endDate: '2021' },
        ];
        const queued = await queueLocalApplicationJob({
          transport: 'paste', canvasFilePath: project.canvasFilePath, careerData: careerCorpus,
          job: { title: 'Reporting Engineer', company: 'Acme', snippet: 'We own reporting and billing end to end and expect automated test coverage. You will own dispatch route planner tooling too.' },
          resumeProfile: { workHistory },
        });
        const planHandoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath })).handoff;
        const planIdentity = { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: 'Software Engineer' };
        const evidenceCatalog = [
          { id: 'cd-engines', sourceId: 'career-data', quote: 'Built the reporting pipeline for nightly batches.', requirement: 'Reporting ownership', priority: 'highest' },
          { id: 'cd-machines', sourceId: 'career-data', quote: 'Shipped the billing service with automated alerts.', requirement: 'Billing ownership', priority: 'highest' },
          { id: 'cd-projects', sourceId: 'career-data', quote: 'Built a dispatch route planner with a local Llama model.', requirement: 'Independent delivery', priority: 'supporting' },
          { id: 'job-stack', sourceId: 'job-listing', quote: 'reporting and billing end to end', requirement: 'Reporting and billing ownership', priority: 'highest' },
          { id: 'job-planner', sourceId: 'job-listing', quote: 'dispatch route planner tooling', requirement: 'Route planner ownership', priority: 'high' },
        ];
        const acceptedPlan = await submitLocalApplicationHandoff({
          jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: planHandoff.handoffCode,
          response: JSON.stringify(reply(planHandoff, {
            identity: planIdentity,
            evidence: evidenceCatalog,
            requirements: [{ id: 'need-stack', text: 'Reporting and billing ownership across the stack', priority: 'highest', evidenceIds: ['cd-engines', 'cd-machines', 'cd-projects', 'job-stack', 'job-planner'] }],
          })),
        });
        assert(acceptedPlan.accepted && acceptedPlan.handoff?.stage === 'resume',
          `the two-employer plan opens the résumé handoff (errors=${JSON.stringify(acceptedPlan.validationErrors || [])})`);

        // Ids chosen so that finding one anywhere in the cover-letter prompt is
        // proof the résumé's own ID space reached the responder.
        const acceptedResume = {
          schemaVersion: 'structured-resume.v1',
          identity: planIdentity,
          roles: [
            {
              id: 'role-1', title: 'Senior Engineer', company: 'Analytical Engines', dates: '2021 – 2024', location: 'Bristol, England',
              bullets: [{ id: 'resumeid-bullet-reporting', text: 'Built the reporting pipeline for nightly batches.', evidenceIds: ['cd-engines'] }],
            },
            {
              id: 'role-2', title: 'Software Engineer', company: 'Difference Machines', dates: '2018 – 2021', location: 'Leeds, England',
              bullets: [{ id: 'resumeid-bullet-billing', text: 'Shipped the billing service with automated alerts.', evidenceIds: ['cd-machines'] }],
            },
          ],
          projects: [{ id: 'resumeid-project-planner', name: 'dispatch route planner', description: 'Built a route planner with a local model.', evidenceIds: ['cd-projects', 'job-planner'] }],
          // Same filterable-name rule as the résumé stage case above; the corpus
          // names the model this project ran so the row has a name to carry.
          skills: [{ id: 'resumeid-skill-tools', group: 'tools', items: ['Llama'], evidenceIds: ['cd-projects'] }],
        };
        const resumeStage = acceptedPlan.handoff;
        const accepted = await submitLocalApplicationHandoff({
          jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: resumeStage.handoffCode,
          response: JSON.stringify(reply(resumeStage, { resume: acceptedResume })),
        });
        assert(accepted.accepted && accepted.handoff?.stage === 'cover-letter',
          `a résumé with roles, projects and skills advances to the cover-letter handoff (errors=${JSON.stringify(accepted.validationErrors || [])})`);

        const prompt = accepted.handoff.prompt;
        const shipped = pasteContext(prompt).resume;
        assert(!Object.hasOwn(shipped, 'schemaVersion') && !Object.hasOwn(shipped, 'identity')
          && JSON.stringify(shipped.identity ?? null) === 'null',
        `the stage-2 response wrapper is gone: schemaVersion marks a shape this stage never returns, and identity was a second copy of trustedIdentity (keys=${JSON.stringify(Object.keys(shipped))})`);
        assert(JSON.stringify(pasteContext(prompt).trustedIdentity) === JSON.stringify({ name: planIdentity.name, contact: planIdentity.contact, subtitleRole: planIdentity.subtitleRole })
          && prompt.includes('must exactly equal context.trustedIdentity'),
        'the one identity the letter must equal still ships, under the name the contract points at');

        const resumeOwnIds = ['resumeid-bullet-reporting', 'resumeid-bullet-billing', 'resumeid-project-planner', 'resumeid-skill-tools'];
        assert(resumeOwnIds.every(id => JSON.stringify(acceptedResume).includes(id) && !prompt.includes(id))
          && shipped.roles.every(role => !Object.hasOwn(role, 'id') && role.bullets.every(bullet => !Object.hasOwn(bullet, 'id')))
          && shipped.projects.every(item => !Object.hasOwn(item, 'id')) && shipped.skills.every(item => !Object.hasOwn(item, 'id')),
        'no résumé id reaches the cover-letter responder, so the only IDs in front of it are the evidence IDs a paragraph may cite');
        assert(shipped.roles.every(role => Array.isArray(role.bullets) && role.bullets.every(bullet => Array.isArray(bullet.evidenceIds) && bullet.evidenceIds.length))
          && shipped.projects.every(item => Array.isArray(item.evidenceIds) && item.evidenceIds.length)
          && shipped.skills.every(item => Array.isArray(item.evidenceIds) && item.evidenceIds.length),
        'evidenceIds survive on every unit: they name the plan’s own IDs, so they show which career quote each bullet already rewrote');

        // The real guarantee: everything the completion twin reads back off the
        // rendered document is still in front of the writer, character for
        // character. A projection that dropped a graded string would cost a
        // round, not save one.
        const graded = extractResumeEvidence(renderStructuredApplicationResume(acceptedResume, {
          sourceRoles: workHistory.map(role => ({ id: role.id, title: role.title, company: role.employer, dates: `${role.startDate} – ${role.endDate}`, location: '' })),
          evidenceCatalog, trustedIdentity: planIdentity, careerData: careerCorpus,
        }));
        const shippedText = JSON.stringify(shipped);
        assert(graded.bulletTexts.length === 2 && graded.bulletTexts.every(text => shippedText.includes(JSON.stringify(text).slice(1, -1))),
          `every rendered bullet the redundancy and figure checks read is shipped verbatim (rendered=${JSON.stringify(graded.bulletTexts)})`);
        assert(graded.roles.every(role => shipped.roles.some(item => item.title === role.title && item.company === role.company))
          && graded.projects.every(item => shipped.projects.some(entry => entry.name === item.name)),
        'every role identity the evidenceRole match is graded against, and every project name the artifact-introduction checks read, is shipped');
        return { promptChars: prompt.length, shippedKeys: Object.keys(shipped).length, strippedIds: resumeOwnIds.length };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'The cover-letter stage drops the saved work history its accepted résumé already carries, and the review still gets both',
    async run() {
      // sourceRoles and the accepted résumé are two lists of the same roles in
      // one context, and the résumé is the richer one — it fills the work
      // location the saved history leaves empty. The letter returns no roles
      // and nothing at this stage is measured against sourceRoles: the gate
      // that matches coverLetterArgument.evidenceRole reads the RENDERED
      // résumé's title and company. From here the second list is only
      // something to contradict. The review is the negative control — it may
      // return a replacement résumé, which is validated against sourceRoles
      // and needs every structured id — so both must survive there.
      const project = await createCanvasProject();
      try {
        const plan = auditPlanFixture();
        const steps = await auditJobSteps(project);
        const planContext = pasteContext((await steps.current()).prompt);
        assert(Array.isArray(planContext.sourceRoles) && planContext.sourceRoles.length === 1,
          'the evidence-plan stage still receives the saved work history it plans employer coverage from');

        await steps.send({ identity: plan.identity, evidence: plan.evidence, requirements: plan.requirements });
        assert(JSON.stringify(pasteContext((await steps.current()).prompt).sourceRoles) === JSON.stringify(planContext.sourceRoles),
          'the résumé stage — which must cover every saved role exactly once — still receives it');

        await steps.send({ resume: plan.resume });
        const coverHandoff = await steps.current();
        const coverContext = pasteContext(coverHandoff.prompt);
        assert(coverHandoff.stage === 'cover-letter' && !Object.hasOwn(coverContext, 'sourceRoles'),
          `the cover-letter stage prints one role list, not two (keys=${JSON.stringify(Object.keys(coverContext))})`);
        assert(planContext.sourceRoles.every(role => coverContext.resume.roles.some(item =>
          item.title === role.title && item.company === role.company && item.dates === role.dates)),
        'the list that remains carries every field the dropped one did, for every saved role');

        await steps.send({ coverLetter: plan.coverLetter });
        const reviewHandoff = await steps.current();
        const reviewContext = pasteContext(reviewHandoff.prompt);
        assert(reviewHandoff.stage === 'review'
          && JSON.stringify(reviewContext.sourceRoles) === JSON.stringify(planContext.sourceRoles)
          && JSON.stringify(reviewContext.resume) === JSON.stringify(plan.resume),
        `the review — which may return a replacement résumé validated against both — still receives the saved history and the full structured résumé, ids included (resume keys=${JSON.stringify(Object.keys(reviewContext.resume || {}))})`);
        return { coverContextKeys: Object.keys(coverContext).length, reviewContextKeys: Object.keys(reviewContext).length };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    // The defect class an independent verifier used to reproduce the loop the
    // case below was written for: sanitizeQualityReview raises it, but its
    // repair is a cover-letter change, so attributing by the validator that
    // raised it recorded "no document has to change" — and the deterministic
    // repeat gate only caught a byte-identical package, so a pass differing by
    // one audit word walked back into the same rejection, round after round.
    name: 'A rejection repaired only in a document’s authored contract requires that document, and moving anything else cannot answer it',
    async run() {
      const project = await createCanvasProject();
      try {
        const plan = auditPlanFixture();
        const steps = await auditJobSteps(project);
        await steps.send({ identity: plan.identity, evidence: plan.evidence, requirements: plan.requirements });
        await steps.send({ resume: plan.resume });
        await steps.send({ coverLetter: plan.coverLetter });
        const opened = await getLocalApplicationHandoff({ jobId: steps.queued.id, canvasFilePath: project.canvasFilePath });
        const manifestPath = path.join(opened.localJob.folder, 'manifest.json');
        const readPaste = async () => JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')).paste;

        // The accepted letter argues from work no final résumé bullet states —
        // what a résumé revision leaves behind. Nothing renders differently.
        const frozen = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
        frozen.paste.coverLetter = structuredClone(plan.coverLetter);
        frozen.paste.coverLetter.coverLetterArgument.primaryEvidence.evidence = 'Built a message queue that replayed failed deliveries.';
        await fs.promises.writeFile(manifestPath, JSON.stringify(frozen), 'utf8');

        const passFields = () => ({
          decision: 'pass', findings: [], checklist: checklist(),
          qualityReview: {
            checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION,
            criteria: APPLICATION_QUALITY_CRITERIA.map(({ id, requirement }) => ({ id, status: 'pass', evidence: requirement })),
            resume: { decision: 'approved', rationale: 'The résumé preserves direct source-supported systems evidence with clear relevance.' },
            coverLetter: { decision: 'approved', rationale: 'One controlling argument uses minimum-sufficient evidence for target system delivery.' },
          },
          generationAudit: plan.audit(),
        });

        const rejected = await steps.submit(passFields());
        const reopened = await readPaste();
        assert(rejected.result.accepted === false
          && rejected.result.validationErrors.some(message => /coverLetterArgument evidence 1 does not match a final résumé bullet/.test(message)),
        `the completed package is rejected for the stale argument binding (errors=${JSON.stringify(rejected.result.validationErrors || [])})`);
        assert(JSON.stringify(reopened.requiredChangeDocuments) === JSON.stringify(['coverLetter'])
          && JSON.stringify(reopened.requiredChangeTargets) === JSON.stringify(['coverLetter:authored'])
          && reopened.findings.every(finding => finding.document === 'coverLetter'),
        `the rejection requires the document whose change repairs it, not the validator's own field (state=${JSON.stringify({ documents: reopened.requiredChangeDocuments, targets: reopened.requiredChangeTargets, findings: reopened.findings.map(item => item.document) })})`);

        // Disclosure: a genuine host demand is still open here, so this is
        // exactly the case context.reviewFindings exists for, and the review
        // contract states the complete pass-eligibility rule affirmatively
        // rather than leaving a reader to infer it from the blocking cases.
        const reopenedHandoff = await steps.current();
        const reopenedContext = pasteContext(reopenedHandoff.prompt);
        assert('reviewFindings' in reopenedContext && 'requiredChangeDocuments' in reopenedContext,
          `an open host rejection ships reviewFindings alongside requiredChangeDocuments, not silently (context keys=${Object.keys(reopenedContext).join(', ')})`);
        assert(reopenedHandoff.prompt.includes('Decision:"pass" is legal exactly when all of the following hold together'),
          'the review contract states the complete pass-eligibility rule affirmatively, not only its blocking direction');

        // The verifier's loop: the same package, one audit word moved. The old
        // gate compared whole packages and let this through to be rejected
        // identically, forever.
        const reworded = passFields();
        reworded.generationAudit.finalDecisionSummary = `${reworded.generationAudit.finalDecisionSummary} Reviewed once more before returning.`;
        const moved = await steps.submit(reworded);
        const afterMoved = await readPaste();
        assert(moved.result.accepted === false
          && moved.result.validationErrors.length === 1
          && /leaves coverLetter exactly as the package/.test(moved.result.validationErrors[0])
          && moved.result.validationErrors[0].includes('roleThesis and coverLetterArgument'),
        `a package that moves something the rejection did not name answers nothing, and is told which change would (errors=${JSON.stringify(moved.result.validationErrors || [])})`);
        assert(afterMoved.revision === reopened.revision, 'a rejected non-answer advances nothing');

        // The repair the rejection names, and the only one that can work: the
        // letter's argument, with its prose untouched. Demanding a RENDERED
        // change here would have made this unreachable.
        const repair = structuredClone(frozen.paste.coverLetter);
        repair.coverLetterArgument.primaryEvidence.evidence = AUDIT_BULLET;
        const revised = await steps.submit({
          decision: 'revised',
          checklist: checklist().map(item => (item.id === 'cross-document-consistency'
            ? { id: item.id, status: 'issue', detail: 'The argument cited work no final highlight states until this revision re-cited it.' }
            : item)),
          findings: [{ id: 'review-argument-1', document: 'coverLetter', targetId: 'coverLetterArgument', issue: 'The argument cited work absent from the final résumé.', fix: 'Cite the highlight the résumé states.' }],
          coverLetter: repair,
        });
        const afterRepair = await readPaste();
        assert(revised.result.accepted && JSON.stringify(afterRepair.requiredChangeTargets) === JSON.stringify([]),
          `re-citing the argument answers the rejection with the prose untouched (errors=${JSON.stringify(revised.result.validationErrors || [])}, required=${JSON.stringify(afterRepair.requiredChangeTargets)})`);

        // The repair round leaves its own findings in state (self-authored,
        // paired with the replacement that already answers them), exactly
        // the shape a resolved self-report takes — but requiredChangeTargets
        // is now []: nothing is still outstanding, so this is the round that
        // used to echo a stale "revised" lure back into the next prompt. It
        // must not: reviewFindings is gated on the same outstanding set as
        // requiredChangeTargets, so an already-answered self-report is not
        // echoed once nothing blocks a pass.
        assert(afterRepair.findings.length > 0,
          'the repair round leaves its own findings in state, which the next assertion proves does not leak back out');
        const repairedHandoff = await steps.current();
        const repairedContext = pasteContext(repairedHandoff.prompt);
        assert(!('reviewFindings' in repairedContext) && !('requiredChangeDocuments' in repairedContext) && !('requiredChangeTargets' in repairedContext),
          `a resolved self-report is not echoed back once nothing is outstanding (context keys=${Object.keys(repairedContext).join(', ')}, findings=${JSON.stringify(afterRepair.findings)})`);

        const completed = await steps.submit(passFields());
        assert(completed.result.accepted && completed.result.completed,
          `the review that follows the repair completes the package (errors=${JSON.stringify(completed.result.validationErrors || [])})`);
        return { targets: reopened.requiredChangeTargets, rounds: 4 };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    // The poll/import rejection path persisted no hash of the package it
    // rejected, so the round it reopened had no repeat gate at all. Combined
    // with a rejection that attributed nothing, the identical package was
    // accepted on sight.
    name: 'A rejection recovered from the import path records the package it rejected, so returning it is rejected',
    async run() {
      const project = await createCanvasProject();
      try {
        const plan = auditPlanFixture();
        const steps = await auditJobSteps(project);
        await steps.send({ identity: plan.identity, evidence: plan.evidence, requirements: plan.requirements });
        await steps.send({ resume: plan.resume });
        await steps.send({ coverLetter: plan.coverLetter });
        const passFields = () => ({
          decision: 'pass', findings: [], checklist: checklist(),
          qualityReview: {
            checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION,
            criteria: APPLICATION_QUALITY_CRITERIA.map(({ id, requirement }) => ({ id, status: 'pass', evidence: requirement })),
            resume: { decision: 'approved', rationale: 'The résumé preserves direct source-supported systems evidence with clear relevance.' },
            coverLetter: { decision: 'approved', rationale: 'One controlling argument uses minimum-sufficient evidence for target system delivery.' },
          },
          generationAudit: plan.audit(),
        });
        const completed = await steps.submit(passFields());
        assert(completed.result.completed, `the fixture completes before the import rejects it (errors=${JSON.stringify(completed.result.validationErrors || [])})`);

        // What a poll or import writes when it rejects the bytes a submit
        // accepted, as a build with no repair vocabulary left it: prose only.
        const folder = completed.result.localJob.folder;
        const resultRaw = await fs.promises.readFile(path.join(folder, 'result.json'), 'utf8');
        await fs.promises.writeFile(path.join(folder, 'fit-feedback.json'), JSON.stringify({
          version: 1, jobId: steps.queued.id, status: 'invalid', measured: false,
          resultSha256: crypto.createHash('sha256').update(resultRaw).digest('hex'),
          error: 'Local AI cover letter failed required checks: cover-register: paragraph 1 closes on a deferential invitation.',
          rejectedAt: new Date().toISOString(), documentSha256: null, revisionRound: 0, priorMeasured: null,
          message: 'Infinite Canvas rejected this result.json during validation.',
        }), 'utf8');

        const reopened = await getLocalApplicationHandoff({ jobId: steps.queued.id, canvasFilePath: project.canvasFilePath });
        const paste = JSON.parse(await fs.promises.readFile(path.join(folder, 'manifest.json'), 'utf8')).paste;
        assert(reopened.handoff?.stage === 'review' && Boolean(paste.rejectedResponseSha256)
          && JSON.stringify(paste.requiredChangeTargets) === JSON.stringify(['response']),
        `the recovered round records the package it rejected and what it still owes (state=${JSON.stringify({ hash: Boolean(paste.rejectedResponseSha256), targets: paste.requiredChangeTargets })})`);

        const returned = await steps.submit(passFields());
        assert(returned.result.accepted === false
          && returned.result.validationErrors.some(message => /repeats the package the app's own checks rejected/.test(message)),
        `the identical package cannot be returned to the round that rejected it (errors=${JSON.stringify(returned.result.validationErrors || [])})`);
        return { targets: paste.requiredChangeTargets };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },  {
    name: 'An argumentMapping supplied as an array is reported as the shape it is, not discarded into "no mapping"',
    async run() {
      // projectAuditArgumentMapping returns null for anything that is not a
      // plain object, so an array-shaped mapping was dropped and the gate read
      // the paragraph as carrying none at all. The round that answers that
      // message goes looking for a mapping the audit plainly already has.
      const project = await createCanvasProject();
      try {
        const plan = auditPlanFixture();
        const steps = await auditJobSteps(project);
        await steps.send({ identity: plan.identity, evidence: plan.evidence, requirements: plan.requirements });
        await steps.send({ resume: plan.resume });
        await steps.send({ coverLetter: plan.coverLetter });
        const passFields = (generationAudit) => ({
          decision: 'pass', findings: [], checklist: checklist(),
          qualityReview: {
            checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION,
            criteria: APPLICATION_QUALITY_CRITERIA.map(({ id, requirement }) => ({ id, status: 'pass', evidence: requirement })),
            resume: { decision: 'approved', rationale: 'The résumé preserves direct source-supported systems evidence with clear relevance.' },
            coverLetter: { decision: 'approved', rationale: 'One controlling argument uses minimum-sufficient evidence for target system delivery.' },
          },
          generationAudit,
        });
        const arrayShaped = plan.audit();
        const mapping = arrayShaped.coverLetterPlan.paragraphs[0].argumentMapping;
        arrayShaped.coverLetterPlan.paragraphs[0].argumentMapping = [mapping.claim, mapping.proof, mapping.relevance, mapping.jobNeedQuote];
        const rejected = await steps.submit(passFields(arrayShaped));
        assert(rejected.result.accepted === false
          && rejected.result.validationErrors.some(message => message.includes('argumentMapping is an array')
            && message.includes('every span it does carry must copy the final paragraph')),
        `the shape is reported (errors=${JSON.stringify(rejected.result.validationErrors || [])})`);
        assert(!rejected.result.validationErrors.some(message => message.includes('has no argumentMapping')),
          `and never as the missing mapping it is not (errors=${JSON.stringify(rejected.result.validationErrors || [])})`);

        const completed = await steps.submit(passFields(plan.audit()));
        assert(completed.result.accepted && completed.result.completed,
          `supplying the same fields as an object is the one-round repair (errors=${JSON.stringify(completed.result.validationErrors || [])})`);
        return { errors: rejected.result.validationErrors.length };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    // The completion round that has no answer. A rejection here used to mint a
    // fresh handoff code, a correction prompt and a required-change target
    // against state the response never supplied, so the same round came back
    // forever — the verifier measured six of them. A fault about app-owned
    // frozen state now ends the job instead, and the job says so where a
    // person reads it.
    name: 'A completion failure in frozen state ends the job instead of opening a correction round',
    async run() {
      const project = await createCanvasProject();
      try {
        const plan = auditPlanFixture();
        const steps = await auditJobSteps(project);
        await steps.send({ identity: plan.identity, evidence: plan.evidence, requirements: plan.requirements });
        await steps.send({ resume: plan.resume });
        await steps.send({ coverLetter: plan.coverLetter });
        const jobId = steps.queued.id;
        const dir = steps.queued.folder;
        const manifestPath = path.join(dir, 'manifest.json');
        const readManifest = async () => JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
        const before = await readManifest();
        const passFields = (suffix = '') => {
          const generationAudit = plan.audit();
          generationAudit.finalDecisionSummary = `${generationAudit.finalDecisionSummary}${suffix}`;
          return {
            decision: 'pass', findings: [], checklist: checklist(),
            qualityReview: {
              checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION,
              criteria: APPLICATION_QUALITY_CRITERIA.map(({ id, requirement }) => ({ id, status: 'pass', evidence: requirement })),
              resume: { decision: 'approved', rationale: 'The résumé preserves direct source-supported systems evidence with clear relevance.' },
              coverLetter: { decision: 'approved', rationale: 'One controlling argument uses minimum-sufficient evidence for target system delivery.' },
            },
            generationAudit,
          };
        };
        // The load is inside the same capture as the submit: the frozen-state
        // gate runs in the loader now, so a corpus this app refuses is
        // observed when the dialog asks for a prompt — before a response is
        // parsed — and the round it used to cost is never minted at all.
        const submitPass = async (suffix = '') => {
          try {
            const handoff = (await getLocalApplicationHandoff({ jobId, canvasFilePath: project.canvasFilePath })).handoff;
            const result = await submitLocalApplicationHandoff({
              jobId, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoffCode,
              response: JSON.stringify(reply(handoff, passFields(suffix))),
            });
            return { result, error: null };
          } catch (error) {
            return { result: null, error };
          }
        };

        // The corpus this job froze, now carrying a byte the assembly refuses.
        // Nothing about the plan, the résumé or the letter changed.
        const careerPath = path.join(dir, 'context', 'career-data.txt');
        const corpus = await fs.promises.readFile(careerPath, 'utf8');
        await fs.promises.writeFile(careerPath, `${corpus}${String.fromCharCode(7)}`, 'utf8');

        const faulted = await submitPass();
        assert(faulted.result === null && faulted.error?.code === 'LOCAL_AI_JOB_INTEGRITY'
          && /careerData contains an unsafe control character/.test(faulted.error.message)
          && /no pasted response can repair it/.test(faulted.error.message)
          && /Press Generate on the job card/.test(faulted.error.message),
        `the gate states what it observed, that no response repairs it, and the action that does (${faulted.error?.message || JSON.stringify(faulted.result)})`);

        const broken = await readManifest();
        assert(broken.status === 'failed' && broken.paste.handoffCode === null
          && broken.paste.stage === before.paste.stage && broken.paste.revision === before.paste.revision
          && broken.paste.integrityFault?.message === faulted.error.message
          && !broken.paste.requiredChangeTargets && !broken.paste.rejectedResponseSha256,
        `the job is recorded as broken with no round reopened (${JSON.stringify({ status: broken.status, code: broken.paste.handoffCode, stage: broken.paste.stage, targets: broken.paste.requiredChangeTargets })})`);

        const status = await localApplicationStatus(jobId, project.canvasFilePath);
        assert(status.status === 'failed' && status.message === faulted.error.message,
          `the card reads the fault as a failed job carrying that same sentence (${JSON.stringify({ status: status.status, message: status.message })})`);

        // Reopening the dialog must not mint another prompt to answer.
        const reopened = await getLocalApplicationHandoff({ jobId, canvasFilePath: project.canvasFilePath })
          .then(value => ({ value, error: null }), error => ({ value: null, error }));
        assert(!reopened.value && reopened.error?.code === 'LOCAL_AI_JOB_INTEGRITY'
          && reopened.error.message === faulted.error.message,
        `a broken job hands out no prompt and repeats the sentence the user was shown (${reopened.error?.message || JSON.stringify(reopened.value)})`);

        const log = (await fs.promises.readFile(path.join(dir, 'Generation Log.jsonl'), 'utf8'))
          .split('\n').filter(Boolean).map(line => JSON.parse(line));
        assert(log.at(-1)?.type === 'job-integrity-fault'
          && !log.some(event => event.type === 'host-validation-failed'),
        `the durable log records a job-integrity fault, never a host validation round (${JSON.stringify(log.map(event => event.type))})`);

        // The regression that would cost more than the loop: a defect the next
        // response CAN repair must still reopen a round with a target that
        // names it. Same flow, same completion gate, a repairable defect.
        const repairProject = await createCanvasProject();
        try {
          const repairPlan = auditPlanFixture();
          const repairSteps = await auditJobSteps(repairProject);
          await repairSteps.send({ identity: repairPlan.identity, evidence: repairPlan.evidence, requirements: repairPlan.requirements });
          await repairSteps.send({ resume: repairPlan.resume });
          await repairSteps.send({ coverLetter: repairPlan.coverLetter });
          const repairManifestPath = path.join(repairSteps.queued.folder, 'manifest.json');
          const frozen = JSON.parse(await fs.promises.readFile(repairManifestPath, 'utf8'));
          frozen.paste.coverLetter = structuredClone(repairPlan.coverLetter);
          frozen.paste.coverLetter.coverLetterArgument.primaryEvidence.evidence = 'Built a message queue that replayed failed deliveries.';
          await fs.promises.writeFile(repairManifestPath, JSON.stringify(frozen), 'utf8');
          const rejected = await repairSteps.submit(passFields());
          const reopenedPaste = JSON.parse(await fs.promises.readFile(repairManifestPath, 'utf8')).paste;
          assert(rejected.result.accepted === false && !!rejected.result.handoff?.handoffCode
            && JSON.stringify(reopenedPaste.requiredChangeTargets) === JSON.stringify(['coverLetter:authored'])
            && !reopenedPaste.integrityFault,
          `a repairable completion defect still reopens a round naming the change that answers it (${JSON.stringify({ targets: reopenedPaste.requiredChangeTargets, handoff: Boolean(rejected.result.handoff?.handoffCode) })})`);
        } finally {
          await fs.promises.rm(repairProject.root, { recursive: true, force: true });
        }
        return { ended: true, status: status.status };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    // The surface boundary. A completed package is graded three times — once
    // by the final submit, then by every status poll and every import — and
    // the three used to reach DIFFERENT gates in a different order, because
    // only the submit runs assemblePasteApplicationResult. The measured cost
    // of that: a frozen evidence-plan quote missing from the frozen corpus
    // ended the job at submit and reopened a review round at poll/import, so
    // two human handoffs were spent correcting a package the app itself calls
    // unrepairable somewhere else. Each corruption below is introduced once
    // and driven at each surface on its own job, and the three verdicts have
    // to be the same class carrying the same sentence.
    name: 'One corruption is classified the same way at the submit, poll and import surfaces',
    async run() {
      const CONTROL_CHARACTER = String.fromCharCode(7);
      const corruptions = [
        {
          label: 'a frozen evidence-plan quote no longer occurs in the frozen career corpus',
          observation: /evidence p1-resume-proof quote no longer occurs in its frozen career-data source/,
          corrupt: async (dir) => {
            const careerPath = path.join(dir, 'context', 'career-data.txt');
            const corpus = await fs.promises.readFile(careerPath, 'utf8');
            await fs.promises.writeFile(careerPath, corpus.replace(AUDIT_BULLET, 'Maintained unrelated tooling for other teams.'), 'utf8');
          },
        },
        {
          // Invisible at poll and import until both stopped scrubbing the
          // corpus through cleanText(), which replaces this byte with a space.
          label: 'an unsafe control character in the frozen career corpus',
          observation: /careerData contains an unsafe control character/,
          corrupt: async (dir) => {
            const careerPath = path.join(dir, 'context', 'career-data.txt');
            const corpus = await fs.promises.readFile(careerPath, 'utf8');
            await fs.promises.writeFile(careerPath, `${corpus}${CONTROL_CHARACTER}`, 'utf8');
          },
        },
        {
          // The poll had no identity gate at all, so this job was reported to
          // the card as ready to import and ended one step later.
          label: 'the manifest names a different job than its folder',
          observation: /the manifest names job "11111111-1111-4111-8111-111111111111"/,
          corrupt: async (dir) => {
            const manifestPath = path.join(dir, 'manifest.json');
            const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
            await fs.promises.writeFile(manifestPath, JSON.stringify({ ...manifest, id: '11111111-1111-4111-8111-111111111111' }), 'utf8');
          },
        },
        {
          // No record can be written for this one: the record IS the manifest.
          // It still has to end the job rather than becoming an indefinite
          // renderer retry, which is what a bare Error became.
          label: 'the manifest is not readable JSON',
          observation: /This job's manifest is not readable JSON/,
          recorded: false,
          corrupt: async (dir) => fs.promises.writeFile(path.join(dir, 'manifest.json'), '{"version":1,', 'utf8'),
        },
        {
          label: 'the input record is no longer in the job folder',
          observation: /This job's input record is no longer in its folder/,
          recorded: false,
          corrupt: async (dir) => fs.promises.rm(path.join(dir, 'input.json')),
        },
        // The three frozen values the surfaces only reached through a
        // document, an assembly or a response echo. Each one is read by a
        // stage validator that grades a RESPONSE against it, so before they
        // were graded as frozen state the rejection they produced named a
        // repair in whichever document happened to be in hand.
        {
          label: 'the frozen trusted identity no longer occurs in the frozen career corpus',
          observation: /trusted candidate identity value "Someone Not In The Corpus" is absent from frozen career data/,
          corrupt: async (dir) => {
            const manifestPath = path.join(dir, 'manifest.json');
            const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
            manifest.paste.trustedIdentity = { ...manifest.paste.trustedIdentity, name: 'Someone Not In The Corpus' };
            await fs.promises.writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
          },
        },
        {
          label: 'a frozen trusted source role loses its title',
          observation: /sourceRoles\[0\]\.title is required/,
          corrupt: async (dir) => {
            const inputPath = path.join(dir, 'input.json');
            const input = JSON.parse(await fs.promises.readFile(inputPath, 'utf8'));
            await fs.promises.writeFile(inputPath, JSON.stringify({ ...input, sourceRoles: input.sourceRoles.map((role, index) => (index === 0 ? { ...role, title: '' } : role)) }), 'utf8');
          },
        },
        {
          label: 'the frozen quality checklist no longer lines up with this app\u2019s',
          observation: /position 3 reads "resume-not-a-criterion" where this app's checklist reads "resume-role-completeness"/,
          corrupt: async (dir) => {
            const inputPath = path.join(dir, 'input.json');
            const input = JSON.parse(await fs.promises.readFile(inputPath, 'utf8'));
            const criteria = input.qualityChecklist.criteria.map((criterion, index) => (index === 2 ? { ...criterion, id: 'resume-not-a-criterion' } : criterion));
            await fs.promises.writeFile(inputPath, JSON.stringify({ ...input, qualityChecklist: { ...input.qualityChecklist, criteria } }), 'utf8');
          },
        },
      ];

      // What each surface reports, normalized: a thrown job-integrity fault
      // and a status the card renders as a broken job are the same verdict
      // said two ways, and a surface that reports neither has not classified
      // this corruption at all.
      const verdict = async (surface) => {
        try {
          const value = await surface();
          if (value?.status === 'failed') return { code: 'LOCAL_AI_JOB_INTEGRITY', message: String(value.message || ''), threw: false };
          return { code: null, message: `reported ${JSON.stringify(value?.status ?? value ?? null)}`, threw: false };
        } catch (error) {
          return { code: error?.code || null, message: String(error?.message || error), threw: true };
        }
      };
      const logTypes = async (dir) => (await fs.promises.readFile(path.join(dir, 'Generation Log.jsonl'), 'utf8'))
        .split('\n').filter(Boolean).map(line => JSON.parse(line).type);

      const disagreements = [];
      const observed = {};
      for (const { label, observation, corrupt, recorded = true } of corruptions) {
        const surfaces = {};
        const evidence = {};
        const jobIds = {};
        for (const surface of ['submit', 'poll', 'import']) {
          const project = await createCanvasProject();
          try {
            const job = await auditJobAtReview(project);
            jobIds[surface] = job.jobId;
            if (surface === 'submit') {
              await corrupt(job.dir);
              surfaces.submit = await verdict(async () => {
                const { result, error } = await job.submitPass();
                if (error) throw error;
                return result;
              });
            } else {
              const completed = await job.submitPass();
              assert(completed.result?.accepted && completed.result.completed,
                `the unmodified job completes before ${surface} grades it (${completed.error?.message || JSON.stringify(completed.result?.validationErrors || [])})`);
              await corrupt(job.dir);
              surfaces[surface] = await verdict(() => (surface === 'poll'
                ? localApplicationStatus(job.jobId, project.canvasFilePath)
                : importLocalApplicationJob({ jobId: job.jobId, canvasFilePath: project.canvasFilePath })));
              // A poll or an import that reopened a review round would leave
              // exactly these two traces, and either one costs a handoff.
              const feedback = await fs.promises.readFile(path.join(job.dir, 'fit-feedback.json'), 'utf8')
                .then(text => JSON.parse(text), error => (error?.code === 'ENOENT' ? null : Promise.reject(error)));
              evidence[surface] = {
                reopened: feedback?.status === 'invalid',
                log: (await logTypes(job.dir)).filter(type => type === 'host-validation-reopened' || type === 'host-validation-failed'),
                recordedFault: recorded
                  ? await fs.promises.readFile(path.join(job.dir, 'manifest.json'), 'utf8')
                    .then(text => JSON.parse(text).paste?.integrityFault?.message || null, () => null)
                  : null,
              };
            }
          } finally {
            await fs.promises.rm(project.root, { recursive: true, force: true });
          }
        }
        observed[label] = surfaces.submit.message;
        // Each surface grades its own job, so the folder id differs by
        // construction. Everything else about the sentence must not.
        const messages = ['submit', 'poll', 'import']
          .map(surface => surfaces[surface].message.replace(jobIds[surface], '<this job>'));
        const classes = [surfaces.submit.code, surfaces.poll.code, surfaces.import.code];
        if (classes.some(code => code !== 'LOCAL_AI_JOB_INTEGRITY')) {
          disagreements.push(`${label}: classes ${JSON.stringify({ classes, messages })}`);
          continue;
        }
        if (new Set(messages).size !== 1) disagreements.push(`${label}: sentences ${JSON.stringify(messages)}`);
        if (!observation.test(messages[0])) disagreements.push(`${label}: observation ${JSON.stringify(messages[0])}`);
        if (!/no pasted response can repair it/.test(messages[0]) || !/Press Generate on the job card/.test(messages[0])) {
          disagreements.push(`${label}: action ${JSON.stringify(messages[0])}`);
        }
        for (const surface of ['poll', 'import']) {
          const trace = evidence[surface];
          if (trace.reopened || trace.log.length) disagreements.push(`${label}: ${surface} reopened a round ${JSON.stringify(trace)}`);
          if (recorded && String(trace.recordedFault).replace(jobIds[surface], '<this job>') !== messages[0]) {
            disagreements.push(`${label}: ${surface} recorded ${JSON.stringify(trace.recordedFault)}`);
          }
        }
      }
      assert(!disagreements.length,
        `every surface classifies one corruption the same way and says the same thing about it: ${JSON.stringify(disagreements, null, 1)}`);

      // The one that cost the measured handoffs: the sentence must be the
      // assembly's own observation about the plan, not a source-grounding
      // binding reported as a document the responder has to rewrite.
      const planQuote = observed['a frozen evidence-plan quote no longer occurs in the frozen career corpus'];
      assert(!/qualityReview\.sourceGrounding/.test(planQuote) && !/careerDataQuotes/.test(planQuote),
        `a broken frozen plan quote is reported as the plan, never as a projected binding (${planQuote})`);

      // The one corruption the submit surface cannot see, because it WRITES
      // result.json rather than reading it. Both re-grades still have to agree
      // with each other, and with the rest of this class: a paste job's
      // result.json is assembled by this app, so a syntax error in it reopened
      // a review round whose only effect was to make this app write the same
      // file again — a handoff spent on a file no response ever supplied.
      const regradeOnly = [];
      for (const surface of ['poll', 'import']) {
        const project = await createCanvasProject();
        try {
          const job = await auditJobAtReview(project);
          const completed = await job.submitPass();
          assert(completed.result?.completed, `the unmodified job completes before ${surface} grades it`);
          await fs.promises.writeFile(path.join(job.dir, 'result.json'), '{"version":1,', 'utf8');
          const reported = await verdict(() => (surface === 'poll'
            ? localApplicationStatus(job.jobId, project.canvasFilePath)
            : importLocalApplicationJob({ jobId: job.jobId, canvasFilePath: project.canvasFilePath })));
          const feedback = await fs.promises.readFile(path.join(job.dir, 'fit-feedback.json'), 'utf8')
            .then(text => JSON.parse(text), error => (error?.code === 'ENOENT' ? null : Promise.reject(error)));
          if (reported.code !== 'LOCAL_AI_JOB_INTEGRITY'
            || !/This job's completed application package is not readable JSON/.test(reported.message)
            || feedback?.status === 'invalid') {
            regradeOnly.push(`${surface}: ${JSON.stringify({ code: reported.code, message: reported.message, reopened: feedback?.status })}`);
          }
        } finally {
          await fs.promises.rm(project.root, { recursive: true, force: true });
        }
      }
      assert(!regradeOnly.length,
        `an assembled package that will not parse ends the job at both re-grades instead of reopening a round: ${JSON.stringify(regradeOnly)}`);
      return { corruptions: corruptions.length + 1, surfaces: 3 };
    },
  },
  {
    // The other half of the same boundary, and the one no surface asked at
    // all. Every gate above is reached only once a package exists: the submit
    // ran them inside its own `stage === 'completed'` transition, and the poll
    // returned its stage report BEFORE grading anything. So a job in the
    // middle of its authoring stages was never read against its own frozen
    // state — and that is not a corrupted-file-only path, because the measured
    // fit loop puts a completed job back into an earlier stage as normal
    // operation. What the gap cost is visible in each case below: the frozen
    // value is read by a stage validator that has no idea it is frozen, so the
    // rejection it writes names the RESPONSE, and the repair it asks for
    // cannot reach the value.
    name: 'One corruption is classified the same way at all three surfaces while the job is mid-flow',
    async run() {
      const CONTROL_CHARACTER = String.fromCharCode(7);
      const readJson = async (dir, name) => JSON.parse(await fs.promises.readFile(path.join(dir, name), 'utf8'));
      const writeJson = async (dir, name, value) => fs.promises.writeFile(path.join(dir, name), JSON.stringify(value), 'utf8');
      const corruptions = [
        {
          label: 'an unsafe control character in the frozen career corpus',
          observation: /careerData contains an unsafe control character/,
          corrupt: async (dir) => {
            const careerPath = path.join(dir, 'context', 'career-data.txt');
            await fs.promises.writeFile(careerPath, `${await fs.promises.readFile(careerPath, 'utf8')}${CONTROL_CHARACTER}`, 'utf8');
          },
        },
        {
          // Read at every authoring stage after the first: the résumé's
          // bullets and the letter's paragraphs are graded against the quotes
          // this plan holds, so a quote the corpus no longer contains was
          // reported as the document that cited it.
          label: 'a frozen evidence-plan quote no longer occurs in the frozen career corpus',
          observation: /evidence p1-resume-proof quote no longer occurs in its frozen career-data source/,
          corrupt: async (dir) => {
            const careerPath = path.join(dir, 'context', 'career-data.txt');
            const corpus = await fs.promises.readFile(careerPath, 'utf8');
            await fs.promises.writeFile(careerPath, corpus.replace(AUDIT_BULLET, 'Maintained unrelated tooling for other teams.'), 'utf8');
          },
        },
        {
          // The cover-letter stage refuses a letter whose envelope does not
          // repeat this exactly, so a corrupted identity rejected the LETTER
          // for a value the letter is required to copy verbatim.
          label: 'the frozen trusted identity no longer occurs in the frozen career corpus',
          observation: /trusted candidate identity value "Someone Not In The Corpus" is absent from frozen career data/,
          corrupt: async (dir) => {
            const manifest = await readJson(dir, 'manifest.json');
            manifest.paste.trustedIdentity = { ...manifest.paste.trustedIdentity, name: 'Someone Not In The Corpus' };
            await writeJson(dir, 'manifest.json', manifest);
          },
        },
        {
          // validateStructuredResumeDraft normalizes this list, so a broken
          // role read as "Structured résumé validation failed" in the round
          // that returned a résumé — and, at the cover-letter stage, silently
          // disabled the whole editorial battery instead, because the letter
          // twin gives up when the résumé it is judged beside cannot render.
          label: 'a frozen trusted source role loses its title',
          observation: /sourceRoles\[0\]\.title is required/,
          corrupt: async (dir) => {
            const input = await readJson(dir, 'input.json');
            await writeJson(dir, 'input.json', { ...input, sourceRoles: input.sourceRoles.map((role, index) => (index === 0 ? { ...role, title: '' } : role)) });
          },
        },
        {
          // Printed into the review prompt as the number the response must
          // carry back, and then compared against the same raw field.
          label: 'the frozen quality-checklist version is unsupported',
          observation: /the input record reads quality-checklist version 99 where this app reads 1, 2, 3 or 4/,
          corrupt: async (dir) => {
            const input = await readJson(dir, 'input.json');
            await writeJson(dir, 'input.json', { ...input, qualityChecklist: { ...input.qualityChecklist, version: 99 } });
          },
        },
        {
          // The same shape one field across: the review must echo these ids
          // exactly, and the completed package's copy of them is then read
          // against this app's canon, so the answer one accepts is the answer
          // the other refuses.
          label: 'the frozen quality checklist no longer lines up with this app\u2019s',
          observation: /position 3 reads "resume-not-a-criterion" where this app's checklist reads "resume-role-completeness"/,
          corrupt: async (dir) => {
            const input = await readJson(dir, 'input.json');
            const criteria = input.qualityChecklist.criteria.map((criterion, index) => (index === 2 ? { ...criterion, id: 'resume-not-a-criterion' } : criterion));
            await writeJson(dir, 'input.json', { ...input, qualityChecklist: { ...input.qualityChecklist, criteria } });
          },
        },
        {
          label: 'the frozen generation-audit contract disagrees with the manifest',
          observation: /generation-audit contracts do not match/,
          corrupt: async (dir) => {
            const { generationAudit: _dropped, ...manifest } = await readJson(dir, 'manifest.json');
            await writeJson(dir, 'manifest.json', manifest);
          },
        },
      ];

      const verdict = async (surface) => {
        try {
          const value = await surface();
          if (value?.status === 'failed') return { code: 'LOCAL_AI_JOB_INTEGRITY', message: String(value.message || '') };
          return { code: null, message: `reported ${JSON.stringify(value?.status ?? value?.accepted ?? null)}` };
        } catch (error) {
          return { code: error?.code || null, message: String(error?.message || error) };
        }
      };
      const logTypes = async (dir) => (await fs.promises.readFile(path.join(dir, 'Generation Log.jsonl'), 'utf8'))
        .split('\n').filter(Boolean).map(line => JSON.parse(line).type);

      const disagreements = [];
      for (const { label, observation, corrupt } of corruptions) {
        const surfaces = {};
        const jobIds = {};
        const traces = {};
        for (const surface of ['submit', 'poll', 'import']) {
          const project = await createCanvasProject();
          try {
            // Every job here stops at the review stage: nothing is completed,
            // so result.json does not exist and no gate below may depend on it.
            const job = await auditJobAtReview(project);
            jobIds[surface] = job.jobId;
            await corrupt(job.dir);
            surfaces[surface] = await verdict(async () => {
              if (surface === 'poll') return localApplicationStatus(job.jobId, project.canvasFilePath);
              if (surface === 'import') return importLocalApplicationJob({ jobId: job.jobId, canvasFilePath: project.canvasFilePath });
              const { result, error } = await job.submitPass();
              if (error) throw error;
              return result;
            });
            const feedback = await fs.promises.readFile(path.join(job.dir, 'fit-feedback.json'), 'utf8')
              .then(text => JSON.parse(text), error => (error?.code === 'ENOENT' ? null : Promise.reject(error)));
            traces[surface] = {
              reopened: feedback?.status === 'invalid',
              log: (await logTypes(job.dir)).filter(type => type === 'host-validation-reopened' || type === 'host-validation-failed'),
              recordedFault: await fs.promises.readFile(path.join(job.dir, 'manifest.json'), 'utf8')
                .then(text => JSON.parse(text).paste?.integrityFault?.message || null, () => null),
            };
          } finally {
            await fs.promises.rm(project.root, { recursive: true, force: true });
          }
        }
        const messages = ['submit', 'poll', 'import']
          .map(surface => surfaces[surface].message.replace(jobIds[surface], '<this job>'));
        const classes = ['submit', 'poll', 'import'].map(surface => surfaces[surface].code);
        if (classes.some(code => code !== 'LOCAL_AI_JOB_INTEGRITY')) {
          disagreements.push(`${label}: classes ${JSON.stringify({ classes, messages })}`);
          continue;
        }
        if (new Set(messages).size !== 1) disagreements.push(`${label}: sentences ${JSON.stringify(messages)}`);
        if (!observation.test(messages[0])) disagreements.push(`${label}: observation ${JSON.stringify(messages[0])}`);
        if (!/no pasted response can repair it/.test(messages[0]) || !/Press Generate on the job card/.test(messages[0])) {
          disagreements.push(`${label}: action ${JSON.stringify(messages[0])}`);
        }
        for (const surface of ['submit', 'poll', 'import']) {
          const trace = traces[surface];
          if (trace.reopened || trace.log.length) disagreements.push(`${label}: ${surface} reopened a round ${JSON.stringify(trace)}`);
          if (String(trace.recordedFault).replace(jobIds[surface], '<this job>') !== messages[0]) {
            disagreements.push(`${label}: ${surface} recorded ${JSON.stringify(trace.recordedFault)}`);
          }
        }
      }
      assert(!disagreements.length,
        `every surface classifies one mid-flow corruption the same way and says the same thing about it: ${JSON.stringify(disagreements, null, 1)}`);

      // The rule that keeps this gate honest: grade what is frozen, and only
      // what EXISTS. A job at its first stage has no accepted plan, no frozen
      // identity and no package, so the same gate must read its corpus and its
      // input record and stop there — and must still say the same thing about
      // the corpus, at the same three surfaces.
      const firstStage = [];
      for (const surface of ['submit', 'poll', 'import']) {
        const project = await createCanvasProject();
        try {
          const plan = auditPlanFixture();
          const steps = await auditJobSteps(project);
          const { id: jobId, folder: dir } = steps.queued;
          const healthy = await localApplicationStatus(jobId, project.canvasFilePath);
          if (healthy.stage !== 'evidence-plan' || healthy.status === 'failed') {
            firstStage.push(`a healthy first-stage job is not graded against state it does not hold yet: ${JSON.stringify({ stage: healthy.stage, status: healthy.status })}`);
          }
          const careerPath = path.join(dir, 'context', 'career-data.txt');
          await fs.promises.writeFile(careerPath, `${await fs.promises.readFile(careerPath, 'utf8')}${CONTROL_CHARACTER}`, 'utf8');
          const reported = await verdict(async () => {
            if (surface === 'poll') return localApplicationStatus(jobId, project.canvasFilePath);
            if (surface === 'import') return importLocalApplicationJob({ jobId, canvasFilePath: project.canvasFilePath });
            return steps.submit({ identity: plan.identity, evidence: plan.evidence, requirements: plan.requirements });
          });
          if (reported.code !== 'LOCAL_AI_JOB_INTEGRITY' || !/careerData contains an unsafe control character/.test(reported.message)) {
            firstStage.push(`${surface}: ${JSON.stringify(reported)}`);
          }
        } finally {
          await fs.promises.rm(project.root, { recursive: true, force: true });
        }
      }
      assert(!firstStage.length,
        `the first stage is graded against the state it already holds, and nothing else: ${JSON.stringify(firstStage, null, 1)}`);
      return { corruptions: corruptions.length, surfaces: 3 };
    },
  },
  {
    // The three loops an independent verifier reproduced after the assembly
    // was swept, and the two faults the same sweep left classified the other
    // way. Every one of them is raised by a gate OUTSIDE
    // pasteApplicationAssembly.js — the completion gate that runs immediately
    // after it, the options that gate is given, and the loader every paste
    // surface goes through — and every one grades state the app froze into
    // this job. A round that reopens on one of these asks the responder for a
    // value it was never given and never printed.
    name: 'Every completion-time fault about frozen state ends the job on its first occurrence',
    async run() {
      const walkToReview = async () => {
        const project = await createCanvasProject();
        const plan = auditPlanFixture();
        const steps = await auditJobSteps(project);
        await steps.send({ identity: plan.identity, evidence: plan.evidence, requirements: plan.requirements });
        await steps.send({ resume: plan.resume });
        await steps.send({ coverLetter: plan.coverLetter });
        const dir = steps.queued.folder;
        const readJson = async name => JSON.parse(await fs.promises.readFile(path.join(dir, name), 'utf8'));
        const writeJson = async (name, value) => fs.promises.writeFile(path.join(dir, name), JSON.stringify(value), 'utf8');
        const passFields = (suffix = '') => {
          const generationAudit = plan.audit();
          generationAudit.finalDecisionSummary = `${generationAudit.finalDecisionSummary}${suffix}`;
          return {
            decision: 'pass', findings: [], checklist: checklist(),
            qualityReview: {
              checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION,
              criteria: APPLICATION_QUALITY_CRITERIA.map(({ id, requirement }) => ({ id, status: 'pass', evidence: requirement })),
              resume: { decision: 'approved', rationale: 'The résumé preserves direct source-supported systems evidence with clear relevance.' },
              coverLetter: { decision: 'approved', rationale: 'One controlling argument uses minimum-sufficient evidence for target system delivery.' },
            },
            generationAudit,
          };
        };
        // The evasion the verifier measured: the repeat gate forbids a
        // byte-identical package, so a whitespace edit is enough to make every
        // round a "new" one. A loop that survives this survives forever.
        // `echo` is what the prompt told this round to send back: every one of
        // these prompts interpolates the frozen value it is about, so a
        // responder that obeys the prompt carries the corrupted value into the
        // response and reaches the completion gate with it.
        const submitPass = async (suffix = '', echo = fields => fields) => {
          const handoff = await getLocalApplicationHandoff({ jobId: steps.queued.id, canvasFilePath: project.canvasFilePath })
            .then(loaded => loaded.handoff, error => ({ loadError: error }));
          if (handoff?.loadError) return { result: null, error: handoff.loadError };
          return submitLocalApplicationHandoff({
            jobId: steps.queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoffCode,
            response: JSON.stringify(reply(handoff, echo(passFields(suffix)))),
          }).then(result => ({ result, error: null }), error => ({ result: null, error }));
        };
        const logTypes = async () => (await fs.promises.readFile(path.join(dir, 'Generation Log.jsonl'), 'utf8'))
          .split('\n').filter(Boolean).map(line => JSON.parse(line).type);
        return { project, plan, steps, dir, readJson, writeJson, passFields, submitPass, logTypes };
      };

      // What "the loop terminated" has to mean, checked the same way for every
      // case: the first occurrence ends the job, a second attempt is not
      // offered, and nothing was recorded that reopens a round.
      const terminates = async (job, { error, observation, echo }) => {
        const failures = [];
        if (error?.code !== 'LOCAL_AI_JOB_INTEGRITY') {
          failures.push(`class=${error?.code || 'none'} message=${error?.message || 'accepted'}`);
          return failures;
        }
        if (!observation.test(error.message)) failures.push(`observation=${error.message}`);
        if (!/no pasted response can repair it/.test(error.message)
          || !/Press Generate on the job card/.test(error.message)) failures.push(`action=${error.message}`);
        const manifest = await job.readJson('manifest.json');
        if (manifest.status !== 'failed' || manifest.paste.handoffCode !== null
          || manifest.paste.integrityFault?.message !== error.message
          || manifest.paste.requiredChangeTargets || manifest.paste.rejectedResponseSha256) {
          failures.push(`record=${JSON.stringify({ status: manifest.status, code: manifest.paste.handoffCode, targets: manifest.paste.requiredChangeTargets })}`);
        }
        const types = await job.logTypes();
        if (!types.includes('job-integrity-fault') || types.includes('host-validation-failed') || types.includes('host-validation-reopened')) {
          failures.push(`log=${JSON.stringify(types)}`);
        }
        const status = await localApplicationStatus(job.steps.queued.id, job.project.canvasFilePath);
        if (status.status !== 'failed' || status.message !== error.message) {
          failures.push(`card=${JSON.stringify({ status: status.status, message: status.message })}`);
        }
        // The loop itself: a second round must not exist to answer.
        const again = await job.submitPass(' ', echo);
        if (again.error?.code !== 'LOCAL_AI_JOB_INTEGRITY' || again.result) {
          failures.push(`round2=${again.error?.message || JSON.stringify(again.result)}`);
        }
        return failures;
      };

      const observed = {};
      const broken = [];
      // Each case corrupts exactly one app-owned frozen value and then submits
      // the same passing review the unmodified job accepts.
      const cases = [
        // Read against the INPUT RECORD, by the shared identity gate every
        // surface asks before it grades anything. It used to reach completion
        // and be reported against the assembled package that had faithfully
        // copied it — three stages later, about the wrong file.
        ['frozen input.version', /the input record reads format version 2 where this app reads version 1/, null, async (job) => {
          await job.writeJson('input.json', { ...await job.readJson('input.json'), version: 2 });
        }],
        // The prompt prints qualityReview:{checklistVersion:<input value>}, so
        // the round the responder is asked for is the round that carries 99 —
        // and validatePasteResponse then compares that echo against the same
        // raw field, rejecting the RESPONSE for a number no response chose.
        // The shared frozen-state gate reads it before any of that, in the
        // input record's own voice, at whichever surface reaches the job first.
        ['frozen input.qualityChecklist.version', /the input record reads quality-checklist version 99 where this app reads 1, 2, 3 or 4/,
          fields => ({ ...fields, qualityReview: { ...fields.qualityReview, checklistVersion: 99 } }),
          async (job) => {
            const input = await job.readJson('input.json');
            await job.writeJson('input.json', { ...input, qualityChecklist: { ...input.qualityChecklist, version: 99 } });
          }],
        ['frozen generation-audit contract', /generation-audit contracts do not match/, null, async (job) => {
          const { generationAudit: _dropped, ...manifest } = await job.readJson('manifest.json');
          await job.writeJson('manifest.json', manifest);
        }],
        ['frozen input.jobId', /the input record names job "not-this-job"/, null, async (job) => {
          await job.writeJson('input.json', { ...await job.readJson('input.json'), jobId: 'not-this-job' });
        }],
      ];
      for (const [label, observation, echo, corrupt] of cases) {
        const job = await walkToReview();
        try {
          await corrupt(job);
          const { error } = await job.submitPass('', echo || undefined);
          observed[label] = error?.message || 'no fault raised';
          const failures = await terminates(job, { error, observation, echo: echo || undefined });
          if (failures.length) broken.push(`${label}: ${failures.join(' | ')}`);
        } finally {
          await fs.promises.rm(job.project.root, { recursive: true, force: true });
        }
      }
      assert(!broken.length,
        `each completion-time frozen-state fault ends the job on its first occurrence: ${JSON.stringify(broken, null, 1)}`);
      // The one that must not read as a stale response: the prompt prints the
      // folder's job id, so "copy the current prompt and try again" routes the
      // responder to a repair that returns the same rejection forever.
      assert(!/different or stale handoff|handoff code is stale/i.test(observed['frozen input.jobId']),
        `a frozen id mismatch states what was read rather than blaming the response (${observed['frozen input.jobId']})`);

      // The poll/import door. A completed package is re-graded by every status
      // poll and every import, from the job's own durable files — so a frozen
      // value corrupted after completion is rejected there, where the paste
      // stage is already over and handoffCode is null. Both routes in: the
      // options resolved before the grade, and the grade itself, whose
      // rejection was recorded as 'invalid' — the record
      // recoverPasteHostValidationHandoff reopens a review round from.
      const doors = [
        ['options resolved before the grade', /generation-audit contracts do not match/, async (job) => {
          const { generationAudit: _dropped, ...manifest } = await job.readJson('manifest.json');
          await job.writeJson('manifest.json', manifest);
        }],
        ['the grade itself', /the input record reads quality-checklist version 99 where this app reads 1, 2, 3 or 4/, async (job) => {
          const input = await job.readJson('input.json');
          await job.writeJson('input.json', { ...input, qualityChecklist: { ...input.qualityChecklist, version: 99 } });
        }],
      ];
      const doorFailures = [];
      for (const [label, observation, corrupt] of doors) {
        const job = await walkToReview();
        try {
          const completed = await job.submitPass();
          assert(completed.result?.accepted && completed.result.completed,
            `the unmodified job completes (${completed.error?.message || JSON.stringify(completed.result?.validationErrors || [])})`);
          await corrupt(job);
          const status = await localApplicationStatus(job.steps.queued.id, job.project.canvasFilePath);
          const manifest = await job.readJson('manifest.json');
          if (status.status !== 'failed' || manifest.status !== 'failed' || manifest.paste.handoffCode !== null
            || manifest.paste.integrityFault?.message !== status.message || !observation.test(status.message)) {
            doorFailures.push(`${label}: poll=${JSON.stringify({ status: status.status, message: status.message })}`);
          }
          const feedback = await fs.promises.readFile(path.join(job.dir, 'fit-feedback.json'), 'utf8')
            .then(text => JSON.parse(text), error => (error?.code === 'ENOENT' ? null : Promise.reject(error)));
          if (feedback?.status === 'invalid') doorFailures.push(`${label}: recorded a rejection for the reopen path to mint a round from`);
          const reopened = await getLocalApplicationHandoff({ jobId: job.steps.queued.id, canvasFilePath: job.project.canvasFilePath })
            .then(value => ({ value, error: null }), error => ({ value: null, error }));
          if (reopened.value || reopened.error?.code !== 'LOCAL_AI_JOB_INTEGRITY' || reopened.error.message !== status.message) {
            doorFailures.push(`${label}: dialog=${reopened.error?.message || JSON.stringify(reopened.value?.handoff?.stage ?? null)}`);
          }
          const types = await job.logTypes();
          if (!types.includes('job-integrity-fault') || types.includes('host-validation-reopened')) {
            doorFailures.push(`${label}: log=${JSON.stringify(types)}`);
          }
          const imported = await importLocalApplicationJob({ jobId: job.steps.queued.id, canvasFilePath: job.project.canvasFilePath })
            .then(value => ({ value, error: null }), error => ({ value: null, error }));
          if (imported.value || imported.error?.code !== 'LOCAL_AI_JOB_INTEGRITY') {
            doorFailures.push(`${label}: import=${imported.error?.message || JSON.stringify(imported.value)}`);
          }
        } finally {
          await fs.promises.rm(job.project.root, { recursive: true, force: true });
        }
      }
      assert(!doorFailures.length,
        `a frozen-state rejection arriving at a re-grade ends the job rather than reopening a round: ${JSON.stringify(doorFailures, null, 1)}`);
      return { ended: cases.length + doors.length };
    },
  },  {
    name: 'jobNeedQuote is graded against the listing companion the prompt prints, and both contracts print that rule',
    async run() {
      // The review contract said "jobNeedQuote is a verbatim span of the
      // posting" while checkParagraphArgumentLinks compared it against
      // jobTextForCoverLetter(job) — title/company/location/snippet, the RAW
      // scrape. The prompt prints context.jobListing, and the companion
      // escapes markdown punctuation in its header lines, so the two copies
      // disagree on every identifying fact carrying a hyphen or a period. A
      // responder quoting the title it was SHOWN was rejected for not quoting
      // a string the prompt never carried. The fix grades the copy the prompt
      // prints; printing the raw scrape instead would re-ship the whole
      // posting a second time in every prompt.
      const COMPANION_SPAN = 'Reliable systems\\-delivery engineer';
      const RAW_SPAN = 'Reliable systems-delivery engineer';
      const job = { title: RAW_SPAN, company: 'Acme', snippet: AUDIT_LISTING };
      const plan = auditPlanFixture();
      const auditFor = (need) => {
        const value = plan.audit();
        value.coverLetterPlan.paragraphs[0].argumentMapping = {
          ...value.coverLetterPlan.paragraphs[0].argumentMapping, jobNeedQuote: need,
        };
        return value;
      };
      const project = await createCanvasProject();
      try {
        const flow = await runAuditFlow(project, plan, { job });
        const listing = pasteContext(flow.reviewPrompt).jobListing;
        const rawScrape = [job.title, job.company, job.snippet].join('\n');

        // The two copies genuinely differ on this fixture, measured rather
        // than assumed: neither span occurs in the other's copy.
        assert(listing.includes(COMPANION_SPAN) && !listing.includes(RAW_SPAN)
          && rawScrape.includes(RAW_SPAN) && !rawScrape.includes(COMPANION_SPAN),
        `the fixture separates the companion from the raw scrape (listing head=${JSON.stringify(listing.slice(0, 60))})`);

        // Disclosure: the printed rule comes from the code that chooses the
        // string, and the description that named neither copy is gone.
        assert(flow.reviewPrompt.includes(ARGUMENT_JOB_NEED_QUOTE_RULE)
          && flow.prompts['cover-letter'].includes(ARGUMENT_JOB_NEED_QUOTE_RULE)
          && ARGUMENT_JOB_NEED_QUOTE_RULE.includes('context.jobListing'),
        'both contracts print the jobNeedQuote rule, and it names the field the gate reads');
        assert(!flow.reviewPrompt.includes('jobNeedQuote is a verbatim span of the posting;')
          && !flow.prompts['cover-letter'].includes('jobNeedQuote is verbatim from the posting'),
        'the superseded description that named neither copy no longer appears in either contract');

        // A span of the copy the prompt never prints is rejected, by name...
        const rejected = await flow.review(auditFor(RAW_SPAN));
        assert(!rejected.accepted
          && rejected.validationErrors.some(message => message.includes('argumentMapping.jobNeedQuote does not occur in context.jobListing')),
        `a quote taken from the raw scrape is rejected and the rejection names the copy it was compared against (errors=${JSON.stringify(rejected.validationErrors || [])})`);

        // ...and the message's own repair — copy it out of that copy's
        // characters — is accepted in one round.
        const repaired = await flow.review(auditFor(COMPANION_SPAN));
        assert(repaired.accepted && repaired.completed,
          `the span as the companion writes it is accepted in one round (errors=${JSON.stringify(repaired.validationErrors || [])})`);
        return { companionSpan: COMPANION_SPAN };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'A review replacing the résumé alone is told in that round when the replacement breaks the accepted letter’s argument binding',
    async run() {
      // coverLetterArgument.primaryEvidence.evidence must match a final résumé
      // bullet. Every surface that graded that binding needed a LETTER in the
      // response to reach it, so a review that replaced the résumé alone —
      // shortening a bullet the accepted argument quotes — was accepted, and
      // the break surfaced a whole round later at completion, where
      // sanitizeSourceGrounding reads the same two fields.
      //
      // The matrix below is also the subset proof: for every replacement
      // bullet, the stage-time verdict is compared against the COMPLETION
      // gate's verdict on the very same pair of documents, assembled and run
      // through validateLocalApplicationResult. A twin that rejected a pairing
      // the gate accepts would cost a round for a rule the pipeline does not
      // have.
      const BINDING_MESSAGE = 'coverLetterArgument evidence 1 does not match a final résumé bullet';
      const CASES = [
        { label: 'tail reworded, binding held', bullet: 'Maintained internal systems with delivery practices.' },
        { label: 'tail replaced, binding held', bullet: 'Maintained internal systems with supported delivery routines.' },
        { label: 'tail dropped, binding broken', bullet: 'Maintained internal systems.' },
      ];
      const verdicts = [];
      for (const testCase of CASES) {
        const project = await createCanvasProject();
        try {
          const plan = auditPlanFixture();
          const replacement = {
            ...plan.resume,
            roles: [{ ...plan.resume.roles[0], bullets: [{ id: 'bullet-1', text: testCase.bullet, evidenceIds: ['p1-resume-proof'] }] }],
          };
          const flow = await runAuditFlow(project, plan);
          const context = pasteContext(flow.reviewPrompt);
          const revision = extra => ({
            decision: 'revised',
            checklist: checklist().map((item, index) => (index === 0 ? { ...item, status: 'issue', detail: 'The strongest bullet reads longer than the rendered line it has to fit.' } : item)),
            findings: [{ id: 'finding-1', document: 'resume', targetId: 'bullet-1', issue: 'The bullet runs past the line it renders on.', fix: 'Shorten the bullet to the delivery work it states.' }],
            resume: replacement,
            ...extra,
          });
          const resumeOnly = await flow.submit(revision());
          const stageBroke = !resumeOnly.result.accepted
            && resumeOnly.result.validationErrors.some(message => message.includes(BINDING_MESSAGE));

          // The same pair, graded by the completion gate itself.
          const passReview = {
            decision: 'pass', findings: [],
            checklist: APPLICATION_QUALITY_CRITERIA.map(({ id }) => ({ id, status: 'pass', detail: `Reviewed ${id} against the final documents.` })),
            qualityReview: {
              checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION,
              criteria: APPLICATION_QUALITY_CRITERIA.map(({ id, requirement }) => ({ id, status: 'pass', evidence: requirement })),
              resume: { decision: 'approved', rationale: 'The résumé preserves direct source-supported systems evidence with clear relevance.' },
              coverLetter: { decision: 'approved', rationale: 'One controlling argument uses minimum-sufficient evidence for target system delivery.' },
            },
            generationAudit: plan.audit(),
          };
          let gateBroke = false;
          let gateError = '';
          try {
            const assembled = assemblePasteApplicationResult({
              input: {
                version: 1, jobId: flow.queued.id, job: AUDIT_JOB,
                sourceRoles: context.sourceRoles,
                qualityChecklist: { version: APPLICATION_QUALITY_CHECKLIST_VERSION },
                generationAudit: { version: LOCAL_AI_GENERATION_AUDIT_VERSION, required: true },
              },
              careerData: AUDIT_CAREER_DATA,
              jobListing: context.jobListing,
              paste: {
                trustedIdentity: context.trustedIdentity,
                evidencePlan: { evidence: plan.evidence, requirements: plan.requirements },
                resume: replacement,
                coverLetter: context.coverLetter,
                finalReview: passReview,
              },
            });
            validateLocalApplicationResult(assembled, assembled.jobId, project.root, AUDIT_JOB, {
              careerData: AUDIT_CAREER_DATA,
              evidencePlan: { evidence: plan.evidence, requirements: plan.requirements },
              qualityChecklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION,
              generationAuditVersion: LOCAL_AI_GENERATION_AUDIT_VERSION,
            });
          } catch (error) {
            gateError = String(error?.message || error);
            gateBroke = gateError.includes(BINDING_MESSAGE);
          }
          verdicts.push({ ...testCase, stageBroke, gateBroke, gateError: gateError.slice(0, 200), stageErrors: resumeOnly.result.validationErrors || [] });

          if (stageBroke) {
            // The message's own repair, in the same round: return the letter
            // beside the résumé with its argument quoting the new bullet.
            const repaired = await flow.submit(revision({
              coverLetter: {
                ...plan.coverLetter,
                coverLetterArgument: {
                  primaryEvidence: { ...plan.coverLetter.coverLetterArgument.primaryEvidence, evidence: testCase.bullet },
                },
              },
            }));
            assert(repaired.result.accepted,
              `the rebind message's own repair is accepted in one round (errors=${JSON.stringify(repaired.result.validationErrors || [])})`);
          }
        } finally {
          await fs.promises.rm(project.root, { recursive: true, force: true });
        }
      }

      // Subset, measured: the stage never reports a binding the completion
      // gate accepts, and the two agree on every case in the matrix.
      const disagreements = verdicts.filter(verdict => verdict.stageBroke !== verdict.gateBroke);
      assert(!disagreements.length,
        `the review-stage twin and the completion gate return the same binding verdict on every pair: ${JSON.stringify(disagreements, null, 1)}`);
      assert(verdicts.some(verdict => verdict.stageBroke) && verdicts.some(verdict => !verdict.stageBroke),
        `the matrix is neither all-rejecting nor all-accepting: ${JSON.stringify(verdicts.map(({ label, stageBroke }) => ({ label, stageBroke })))}`);

      // The rejection also names both routes out, and the review contract
      // states the rule before the round that can break it.
      const broken = verdicts.find(verdict => verdict.stageBroke);
      assert(broken.stageErrors.some(message => message.startsWith('Résumé replacement versus the accepted cover letter — ')
        && message.includes('keep that bullet’s text as the accepted résumé states it')
        && message.includes('return the cover letter in this same response')),
      `the rejection names the pairing it measured and both repairs (errors=${JSON.stringify(broken.stageErrors)})`);
      return { cases: verdicts.map(({ label, stageBroke, gateBroke }) => ({ label, stageBroke, gateBroke })) };
    },
  },
  {
    name: 'The cover-letter stage grades the same binding in reverse, against the résumé already accepted',
    async run() {
      // The exposure DEFECT 2 names runs both ways: a letter whose argument
      // quotes a bullet the accepted résumé does not carry is the same broken
      // binding seen from the other side. That direction was already covered —
      // the cover-letter twin pairs the letter with state.resume — and this is
      // the regression guard that says so, plus the review contract's own
      // disclosure of the rule.
      const project = await createCanvasProject();
      try {
        const plan = auditPlanFixture();
        const steps = await auditJobSteps(project);
        await steps.send({ identity: plan.identity, evidence: plan.evidence, requirements: plan.requirements });
        await steps.send({ resume: plan.resume });
        const unbound = await steps.submit({
          coverLetter: {
            ...plan.coverLetter,
            coverLetterArgument: {
              primaryEvidence: { ...plan.coverLetter.coverLetterArgument.primaryEvidence, evidence: 'Automated the release pipeline for the billing ledger.' },
            },
          },
        });
        assert(!unbound.result.accepted
          && unbound.result.validationErrors.some(message => message.includes('coverLetterArgument evidence 1 does not match a final résumé bullet')),
        `a letter whose argument quotes no accepted-résumé bullet is rejected by the stage that writes it (errors=${JSON.stringify(unbound.result.validationErrors || [])})`);
        const repaired = await steps.submit({ coverLetter: plan.coverLetter });
        assert(repaired.result.accepted,
          `quoting a bullet the accepted résumé carries repairs it in one round (errors=${JSON.stringify(repaired.result.validationErrors || [])})`);
        const reviewPrompt = (await steps.current()).prompt;
        assert(reviewPrompt.includes(ARGUMENT_EVIDENCE_REBIND_RULE),
          'the review contract states the rebinding rule before the round that can break it');
        return { bothDirections: true };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'The evidence-plan repair says what an evidence item carries, so its own repair does not earn a second round',
    async run() {
      // Every one of the three role-coverage repairs ended in "add at least
      // one career-data evidence item … quoting what that section says about
      // the work itself", and none of them restated what an item IS. A
      // responder that followed the sentence literally returned {id, quote}
      // and spent the next round on sourceId, requirement and priority —
      // three fields of the same class, one round later, on a plan that is
      // frozen the moment it is accepted.
      const careerData = [
        'Ada Lovelace', 'ada@example.test', '',
        'Senior Engineer', 'Analytical Engines — Reading, Berkshire', '*2021 – 2024*', '',
        '- Built the reporting pipeline for nightly batches.', '',
        '### Senior Analyst — Beacon Labs', 'Portland, Oregon', '*2019 – 2022*', '',
        '- Ran the quarterly coverage review for the analytics team.', '',
      ].join('\n');
      const ENGINES_WORK = 'Built the reporting pipeline for nightly batches.';
      const BEACON_WORK = 'Ran the quarterly coverage review for the analytics team.';
      const project = await createCanvasProject();
      try {
        const queued = await queueLocalApplicationJob({
          transport: 'paste', canvasFilePath: project.canvasFilePath, careerData,
          job: { title: 'Analyst', company: 'Acme', snippet: 'We need reporting and analysis end to end.' },
          resumeProfile: { workHistory: [
            { id: 'role-1', title: 'Senior Engineer', employer: 'Analytical Engines', startDate: '2021', endDate: '2024' },
            { id: 'role-2', title: 'Senior Analyst', employer: 'Beacon Labs', location: 'Portland, Oregon', startDate: '2019', endDate: '2022' },
          ] },
        });
        const handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath })).handoff;
        const submit = evidence => submitLocalApplicationHandoff({
          jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoffCode,
          response: JSON.stringify(reply(handoff, {
            identity: { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: 'Senior Engineer' },
            evidence,
            requirements: [{ id: 'need-stack', text: 'Reporting and analysis ownership across the stack', priority: 'highest', evidenceIds: [...evidence.map(item => item.id)] }],
          })),
        });
        const listing = { id: 'job-stack', sourceId: 'job-listing', quote: 'reporting and analysis end to end', requirement: 'Reporting and analysis ownership', priority: 'highest' };
        const engines = { id: 'cd-engines', sourceId: 'career-data', quote: ENGINES_WORK, requirement: 'Reporting ownership', priority: 'highest' };

        const uncovered = await submit([engines, listing]);
        const coverage = (uncovered.validationErrors || []).find(message => message.includes('"Beacon Labs"'));
        assert(!uncovered.accepted && coverage,
          `an employer with no career-data quote of its own is reported by name (errors=${JSON.stringify(uncovered.validationErrors)})`);
        // Both halves of the disclosure, and the enum and pattern come from
        // the code that enforces them rather than a hand-copy beside it.
        assert(['id', 'sourceId', 'quote', 'requirement', 'priority'].every(field => coverage.includes(field))
          && coverage.includes(PASTE_STABLE_ID_PATTERN)
          && PASTE_EVIDENCE_PRIORITIES.every(priority => coverage.includes(JSON.stringify(priority))),
        `the repair states every field an added item carries, with the id pattern and priority set the validator reads (item=${JSON.stringify(coverage)})`);

        // The round the silence used to earn: the literal reading of the old
        // sentence — an item that is a quote with an id — is still rejected,
        // and on exactly the fields the message now names in advance.
        const bare = await submit([engines, { id: 'cd-beacon', quote: BEACON_WORK }, listing]);
        assert(!bare.accepted
          && bare.validationErrors.some(message => message.includes('sourceId career-data or job-listing'))
          && bare.validationErrors.some(message => message.includes('requirement and a priority of')),
        `a bare id-and-quote item is rejected on the fields the repair names (errors=${JSON.stringify(bare.validationErrors)})`);

        // Following the message as it now reads is accepted in one round.
        const repaired = await submit([
          engines,
          { id: 'cd-beacon', sourceId: 'career-data', quote: BEACON_WORK, requirement: 'Analysis coverage ownership', priority: 'high' },
          listing,
        ]);
        assert(repaired.accepted && repaired.handoff?.stage === 'resume',
          `the repair the message describes is accepted in one round (errors=${JSON.stringify(repaired.validationErrors || [])})`);
        return { fields: 5 };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Evidence-plan contract states the per-employer floor is not the target, and interpolates the evidence-item ceiling',
    async run() {
      const project = await createCanvasProject();
      try {
        const queued = await queueLocalApplicationJob({
          transport: 'paste', canvasFilePath: project.canvasFilePath, careerData,
          job: { title: 'Reporting Engineer', company: 'Acme' },
          resumeProfile: { workHistory: [{ id: 'role-1', title: 'Software Engineer', employer: 'Analytical Engines', startDate: '2020', endDate: '2024' }] },
        });
        const handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath })).handoff;
        const prompt = handoff.prompt;
        // The plan is frozen from the résumé stage on ("once this plan is
        // accepted it cannot be changed"), so an employer whose section could
        // support several distinct bullets but was only ever catalogued with
        // one quote is exactly the under-catalogued plan that leaves real
        // evidence permanently uncatalogued: nothing left off the plan now can
        // ever be chosen later, even by a revision that would have preferred
        // it.
        assert(prompt.includes('One quote per employer is the floor this stage rejects at, never the target:')
          && prompt.includes('catalogue a separate career-data evidence item for EVERY distinct accomplishment'),
        'the evidence-plan contract states the exhaustive per-employer cataloguing rule (a floor, not a target)');
        // Interpolated from the same constant the validator enforces the
        // evidence-item ceiling with, so a hand-copied number here could not
        // silently drift from the ceiling a response is actually graded
        // against; and the raw template token must not survive interpolation.
        assert(prompt.includes(`Up to ${MAX_EVIDENCE_PLAN_EVIDENCE_ITEMS} items are accepted across the whole plan`)
          && !prompt.includes('${MAX_EVIDENCE_PLAN_EVIDENCE_ITEMS}'),
        `the evidence-item ceiling is interpolated rather than left as a raw template token (prompt has raw token=${prompt.includes('${MAX_EVIDENCE_PLAN_EVIDENCE_ITEMS}')})`);
        return { promptChars: prompt.length, evidenceLimit: MAX_EVIDENCE_PLAN_EVIDENCE_ITEMS };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'An employer Markdown heading scopes its following role title and employer-naming accomplishment as one role section',
    async run() {
      // The title is deliberately followed by an accomplishment that names
      // the employer. That is the normal readable Markdown shape which used
      // to create two candidates (the heading and the title) and therefore
      // fail closed, even though the heading is the explicit boundary.
      const project = await createCanvasProject();
      try {
        const scopedCareerData = [
          'Ada Lovelace', 'ada@example.test', 'Platform Engineer profile', '',
          '## Acme Systems', 'Platform Engineer', '2020 – 2024', '',
          'Built the Acme Systems reporting pipeline for nightly batches.',
        ].join('\n');
        const queued = await queueLocalApplicationJob({
          transport: 'paste', canvasFilePath: project.canvasFilePath, careerData: scopedCareerData,
          job: { title: 'Reporting Engineer', company: 'Harborview Logistics', snippet: 'Build and maintain reporting pipelines.' },
          resumeProfile: { workHistory: [{ id: 'role-1', title: 'Platform Engineer', employer: 'Acme Systems', startDate: '2020', endDate: '2024' }] },
        });
        const planHandoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath })).handoff;
        const planned = await submitLocalApplicationHandoff({
          jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: planHandoff.handoffCode,
          response: JSON.stringify(reply(planHandoff, {
            identity: { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: 'Platform Engineer' },
            evidence: [
              { id: 'career-proof', sourceId: 'career-data', quote: 'Built the Acme Systems reporting pipeline for nightly batches.', requirement: 'Reporting pipelines', priority: 'highest' },
              { id: 'job-proof', sourceId: 'job-listing', quote: 'reporting pipelines', requirement: 'Reporting pipelines', priority: 'highest' },
            ],
            requirements: [{ id: 'need-1', text: 'Reporting pipelines', priority: 'highest', evidenceIds: ['career-proof', 'job-proof'] }],
          })),
        });
        assert(planned.accepted && planned.handoff?.stage === 'resume',
          `the heading-scoped evidence plan opens the résumé stage (errors=${JSON.stringify(planned.validationErrors || [])})`);
        const accepted = await submitLocalApplicationHandoff({
          jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: planned.handoff.handoffCode,
          response: JSON.stringify(reply(planned.handoff, {
            resume: {
              schemaVersion: 'structured-resume.v1',
              identity: { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: 'Platform Engineer' },
              roles: [{
                id: 'role-1', title: 'Platform Engineer', company: 'Acme Systems', dates: '2020 – 2024', location: '',
                bullets: [{ id: 'bullet-1', text: 'Built the Acme Systems reporting pipeline for nightly batches.', evidenceIds: ['career-proof'] }],
              }],
            },
          })),
        });
        assert(accepted.accepted && accepted.handoff?.stage === 'cover-letter',
          `the explicit heading, rather than the fallback title scan, owns this role scope (errors=${JSON.stringify(accepted.validationErrors || [])})`);
        return { scope: 'employer-markdown-heading' };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'A résumé rendering well under the old 90% fill floor now ships on a single page, with no revision reopened and no utilization finding',
    async run() {
      // The behaviour this task exists to change: utilization is a pure,
      // reported measurement now, not a shipping gate. 480/800 = 60%,
      // comfortably below the deleted floor, on exactly one page at a
      // one-page target — the exact case that used to reopen the paste
      // review with a `host-resume-utilization-*` finding and
      // RESUME_UNDERFILL_REPAIR (see the deleted "live fit loop states the
      // résumé underfill repair" test this replaces).
      const project = await createCanvasProject();
      const pdf = await PDFDocument.create(); pdf.addPage([612, 792]);
      const bytes = Buffer.from(await pdf.save());
      __setLocalAiRenderPdfForTests(async () => ({ bytes, pageCount: 1, fontsLoaded: true, missingFontFaces: [], layout: { contentHeightPx: 480, typeAreaHeightPx: 800 } }));
      try {
        const plan = auditPlanFixture();
        const flow = await runAuditFlow(project, plan);
        const complete = await flow.review(plan.audit());
        assert(complete.accepted && complete.completed,
          `the package completes structurally before the render measures it (errors=${JSON.stringify(complete.validationErrors || [])})`);
        const jobId = flow.queued.id;
        const { canvasFilePath } = project;
        const settled = await localApplicationStatus(jobId, canvasFilePath);
        assert(settled.status === 'completed', `the poll accepts the structurally-complete package (status=${settled.status})`);
        const imported = await importLocalApplicationJob({ jobId, canvasFilePath, senderId: 42179 });
        assert(imported.status === 'imported',
          `a 60%-utilization résumé still ships on its first render: there is no minimum utilization to fail (status=${imported.status}, message=${imported.localJob?.message || ''})`);
        assert(imported.resumeFit?.pageCount === 1 && imported.resumeFit?.targetMet === true
          && Math.round(imported.resumeFit.contentUtilization * 100) === 60,
        `the measurement is still reported on the shipped bundle, unfloored (resumeFit=${JSON.stringify(imported.resumeFit)})`);
        const feedbackPath = path.join(flow.queued.folder, 'fit-feedback.json');
        const feedbackExists = await fs.promises.access(feedbackPath).then(() => true, () => false);
        assert(!feedbackExists, 'no fit-feedback.json revision record is written for a document that ships on its first render');
        const manifest = JSON.parse(await fs.promises.readFile(path.join(flow.queued.folder, 'manifest.json'), 'utf8'));
        assert(!(manifest.paste?.findings || []).some(item => String(item?.id || '').startsWith('host-resume-utilization')),
          `no host-resume-utilization finding is ever recorded (findings=${JSON.stringify(manifest.paste?.findings)})`);
        return { path: 'ships-under-old-floor', utilization: 0.6 };
      } finally {
        __setLocalAiRenderPdfForTests(null);
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    // The twin reads a sentence that restates the cited work and speaks to the target the way the completion gate does: the
    // posting copy it is given is the same, so a name the posting states is free in both and the twin is never stricter.
    name: 'The drafting twin reads the posting for a sentence that restates cited work and addresses the target: a name the posting states is free, the same sentence is rejected once the posting no longer states it, and without the address (A / B / C / D)',
    run: async () => {
      const proof = `${BATTERY_LEAD} ${BATTERY_BODY}`;
      const restated = 'On the Northwind platform your team runs, daily users depend on a dependable deployment of the reporting service.';
      const paragraphs = [`${proof} ${restated}`];
      // The same sentence addressed to nobody: the posting names the platform, and that is not enough.
      const unaddressed = [`${proof} On the Northwind platform, daily users depend on a dependable deployment of the reporting service.`];
      const named = `${BATTERY_LISTING} The team runs on the Northwind platform.`;
      const project = await createCanvasProject();
      try {
        const a = await (await coverLetterBatteryStage(project, { paragraphs, proofs: [proof] })).letter();
        assert(!a.accepted && (a.validationErrors || []).some(message => /names “Northwind”/u.test(message)),
          `A: the posting does not state the name, so the restatement is rejected for it (errors=${JSON.stringify(a.validationErrors || [])})`);
        const b = await (await coverLetterBatteryStage(project, { paragraphs, proofs: [proof], listing: named })).letter();
        assert(b.accepted, `B: the posting states the name, so the identical letter is accepted (errors=${JSON.stringify(b.validationErrors || [])})`);
        const c = await (await coverLetterBatteryStage(project, { paragraphs, proofs: [proof] })).letter();
        assert(!c.accepted && (c.validationErrors || []).some(message => /names “Northwind”/u.test(message)), 'C: the posting without the name rejects it again');
        // The employer's name addresses the target too: the twin is given the job's company, as the gate is.
        const employerMarked = [`${proof} On the Northwind platform at Acme, daily users depend on a dependable deployment of the reporting service.`];
        const e = await (await coverLetterBatteryStage(project, { paragraphs: employerMarked, proofs: [proof], listing: named })).letter();
        assert(e.accepted, `E: a sentence that names the employer is addressed to the target, so the posting's name is free in it (errors=${JSON.stringify(e.validationErrors || [])})`);
        const d = await (await coverLetterBatteryStage(project, { paragraphs: unaddressed, proofs: [proof], listing: named })).letter();
        assert(!d.accepted && (d.validationErrors || []).some(message => /names “Northwind”/u.test(message)),
          `D: a sentence that addresses nobody gets no name from the posting, though the posting states it (errors=${JSON.stringify(d.validationErrors || [])})`);
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },  {
    // A host-validation failure prints a review CRITERION id (from
    // APPLICATION_QUALITY_CRITERIA, e.g. cover-register) in the exact
    // `<id>: detail` shape a paste check prints its own id in — but a
    // criterion is deliberately absent from PASTE_CHECK_PROSE_UNITS, because
    // that table enumerates the batteries alone. The function that scopes a
    // correction round's repair brief used to read only that table, so a
    // round whose one and only defect was a criterion recognised no prose
    // part at all and went out with an empty brief — silently, since the
    // numbered item list above it still named the defect just fine.
    name: 'A host rejection naming only a review criterion still scopes its repair brief to the document that criterion grades',
    async run() {
      const project = await createCanvasProject();
      try {
        const plan = auditPlanFixture();
        const steps = await auditJobSteps(project);
        await steps.send({ identity: plan.identity, evidence: plan.evidence, requirements: plan.requirements });
        await steps.send({ resume: plan.resume });
        await steps.send({ coverLetter: plan.coverLetter });
        const passFields = () => ({
          decision: 'pass', findings: [], checklist: checklist(),
          qualityReview: {
            checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION,
            criteria: APPLICATION_QUALITY_CRITERIA.map(({ id, requirement }) => ({ id, status: 'pass', evidence: requirement })),
            resume: { decision: 'approved', rationale: 'The résumé preserves direct source-supported systems evidence with clear relevance.' },
            coverLetter: { decision: 'approved', rationale: 'One controlling argument uses minimum-sufficient evidence for target system delivery.' },
          },
          generationAudit: plan.audit(),
        });
        const completed = await steps.submit(passFields());
        assert(completed.result.completed, `the fixture completes before the import rejects it (errors=${JSON.stringify(completed.result.validationErrors || [])})`);

        // The same recovered-rejection shape as the test above, but with the
        // one detail this test exists to cover: the only id in the message is
        // a review criterion, not a paste check.
        const folder = completed.result.localJob.folder;
        const resultRaw = await fs.promises.readFile(path.join(folder, 'result.json'), 'utf8');
        await fs.promises.writeFile(path.join(folder, 'fit-feedback.json'), JSON.stringify({
          version: 1, jobId: steps.queued.id, status: 'invalid', measured: false,
          resultSha256: crypto.createHash('sha256').update(resultRaw).digest('hex'),
          error: 'Local AI cover letter failed required checks: cover-register: paragraph 1 closes on a deferential invitation.',
          rejectedAt: new Date().toISOString(), documentSha256: null, revisionRound: 0, priorMeasured: null,
          message: 'Infinite Canvas rejected this result.json during validation.',
        }), 'utf8');

        const reopened = await getLocalApplicationHandoff({ jobId: steps.queued.id, canvasFilePath: project.canvasFilePath });
        const prompt = reopened.handoff?.correctionPrompt || '';
        assert(prompt.includes('cover-register: paragraph 1 closes on a deferential invitation'),
          `the reopened correction prompt still names the rejected criterion (prompt=${JSON.stringify(prompt.slice(0, 400))})`);
        assert(prompt.includes('Rules that govern this repair'),
          `a rejection naming only a criterion still carries a repair brief instead of going out empty (prompt=${JSON.stringify(prompt.slice(0, 2000))})`);
        assert(prompt.includes('every paragraph you change is measured against') && !prompt.includes('every bullet you change is measured against'),
          `the brief is scoped to the letter paragraph cover-register grades, not a résumé bullet (prompt=${JSON.stringify(prompt.slice(0, 2000))})`);
        // The brief says which quotes a claim is read against, so a rewrite that merges two proofs knows where each claim must stand.
        assert(prompt.includes('A claim is read against the quotes about the clause that makes it, so a paragraph that merges two proofs says each qualifier, figure, count, name and ownership word in the clause about the quote that states it.'),
          `the letter's repair brief states the clause-level reading of grounding (prompt=${JSON.stringify(prompt.slice(0, 2000))})`);
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'A résumé built by literally following the corrected location contract survives to completion; the old "always legal" reading now fails at the stage that writes the résumé',
    async run() {
      // This is the load-bearing half of the location-contract fix: a
      // disclosure-only assertion (the prompt states the rule) would still
      // pass if the rule it stated were wrong. Here the SAME plan and career
      // data run through the full paste pipeline twice, varying only the
      // resume.roles[0].location value — once with what the corrected
      // contract instructs a responder to copy (the employer heading's own
      // "City, Region" text), once with what the old contract's "always
      // legal" wording invited (omit it).
      //
      // structuredResume still never requires a location, so the only thing
      // that tells the two apart is resumeRoleLocationFailures
      // (jobApplication.js). It used to run three stages later, at review,
      // which is why the omitted variant reached completion at all; the
      // résumé stage now runs that same gate on the same rendered markup, so
      // the rejection lands in the round that wrote the role.
      const pdfDoc = await PDFDocument.create(); pdfDoc.addPage([612, 792]);
      const bytes = Buffer.from(await pdfDoc.save());
      __setLocalAiRenderPdfForTests(async () => ({ bytes, pageCount: 1, fontsLoaded: true, missingFontFaces: [], layout: { contentHeightPx: 760, typeAreaHeightPx: 800 } }));
      // The one addition to the proven AUDIT_* fixture: an "Employer — City,
      // Region" heading for the same "Acme" employer auditJobSteps' source
      // role names, so careerDataRoleLocation actually states a location —
      // the original AUDIT_CAREER_DATA never mentions Acme in that shape, so
      // it never triggers the gate under test either way.
      const locatedCareerData = `Ada Lovelace\nada@example.test\nEngineer\nAcme — Brookfield, Ohio\n${AUDIT_BULLET}\n${AUDIT_PARAGRAPH}`;
      const plan = auditPlanFixture();
      const reviewFields = generationAudit => ({
        decision: 'pass', findings: [], checklist: checklist(),
        qualityReview: {
          checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION,
          criteria: APPLICATION_QUALITY_CRITERIA.map(({ id, requirement }) => ({ id, status: 'pass', evidence: requirement })),
          resume: { decision: 'approved', rationale: 'The résumé preserves direct source-supported systems evidence with clear relevance.' },
          coverLetter: { decision: 'approved', rationale: 'One controlling argument uses minimum-sufficient evidence for target system delivery.' },
        },
        generationAudit,
      });
      const runLocationVariant = async (location, { stopAtResume = false } = {}) => {
        const project = await createCanvasProject();
        try {
          const { send, submit } = await auditJobSteps(project, { careerData: locatedCareerData });
          await send({ identity: plan.identity, evidence: plan.evidence, requirements: plan.requirements });
          const resume = { ...plan.resume, roles: [{ ...plan.resume.roles[0], location }] };
          if (stopAtResume) return (await submit({ resume })).result;
          await send({ resume });
          await send({ coverLetter: plan.coverLetter });
          return await send(reviewFields(plan.audit()));
        } finally {
          await fs.promises.rm(project.root, { recursive: true, force: true });
        }
      };
      try {
        const located = await runLocationVariant('Brookfield, Ohio');
        assert(located.accepted && located.completed,
          `copying the employer heading's own city and region into role.location, exactly as the corrected contract instructs, survives all the way to completion (errors=${JSON.stringify(located.validationErrors || [])})`);

        const omitted = await runLocationVariant('', { stopAtResume: true });
        assert(!omitted.accepted && omitted.handoff?.stage === 'resume'
          && omitted.validationErrors?.some(message => message.includes('Every role must show the work location') && message.includes('Brookfield, Ohio')),
        `omitting the location, the old contract's literal "always legal" reading, is rejected by the résumé stage itself with the stated work-location requirement, instead of surviving two more handoffs (errors=${JSON.stringify(omitted.validationErrors || [])})`);
      } finally {
        __setLocalAiRenderPdfForTests(null);
      }
    },
  },
  {
    name: 'A section written as a heading, a separate location line, and a dates line — with no work description — is classified by its own shape',
    async run() {
      // Note 1's exact shape: `### Title — Employer` fuses the title and the
      // employer into one markdown heading, so a location career data puts on
      // its own very next line — "City, Region" — states none of title,
      // company, or a year. Before careerSectionBodyStart checked the role's
      // OWN location value the same way it already checked title and company,
      // that location line broke the opening-block walk early: the location
      // and the dates line below it were read as body prose, and a section
      // that says nothing but its own header was reported as `reason: 'none'`
      // — told to quote what the section says about the work — instead of
      // `'none-opening-block-only'`, whose message asks for the one quote
      // this corpus actually has: the header itself.
      const careerData = [
        'Ada Lovelace', 'ada@example.test', '',
        'Senior Engineer', 'Analytical Engines — Reading, Berkshire', '*2021 – 2024*', '',
        '- Built the reporting pipeline for nightly batches.', '',
        '### Senior Analyst — Beacon Labs', 'Portland, Oregon', '*2019 – 2022*', '',
      ].join('\n');
      const ENGINES_WORK = 'Built the reporting pipeline for nightly batches.';
      const BEACON_HEADER = '### Senior Analyst — Beacon Labs\nPortland, Oregon\n*2019 – 2022*';
      const project = await createCanvasProject();
      try {
        const queued = await queueLocalApplicationJob({
          transport: 'paste', canvasFilePath: project.canvasFilePath, careerData,
          job: { title: 'Analyst', company: 'Acme', snippet: 'We need reporting and analysis end to end.' },
          resumeProfile: { workHistory: [
            { id: 'role-1', title: 'Senior Engineer', employer: 'Analytical Engines', startDate: '2021', endDate: '2024' },
            { id: 'role-2', title: 'Senior Analyst', employer: 'Beacon Labs', location: 'Portland, Oregon', startDate: '2019', endDate: '2022' },
          ] },
        });
        const handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath })).handoff;
        const submit = fields => submitLocalApplicationHandoff({
          jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoffCode,
          response: JSON.stringify(reply(handoff, {
            identity: { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: 'Senior Engineer' },
            ...fields,
          })),
        });
        const listing = { id: 'job-stack', sourceId: 'job-listing', quote: 'reporting and analysis end to end', requirement: 'Reporting and analysis ownership', priority: 'highest' };
        const uncovered = await submit({
          evidence: [{ id: 'cd-engines', sourceId: 'career-data', quote: ENGINES_WORK, requirement: 'Reporting ownership', priority: 'highest' }, listing],
          requirements: [{ id: 'need-stack', text: 'Reporting and analysis ownership across the stack', priority: 'highest', evidenceIds: ['cd-engines', 'job-stack'] }],
        });
        assert(!uncovered.accepted
          && uncovered.validationErrors.some(message => message.includes('"Beacon Labs"')
            && message.includes('states nothing beyond its own opening block')
            && message.includes('quoting that opening block itself'))
          && !uncovered.validationErrors.some(message => message.includes('Beacon Labs') && message.includes("quoting what that employer's section says about the work")),
        `the heading-plus-location-plus-dates shape with no body is classified 'none-opening-block-only', not told to quote work it never describes (errors=${JSON.stringify(uncovered.validationErrors)})`);

        // Following the message literally repairs it in one round: the
        // opening block itself — the heading, the location line, and the
        // dates the résumé already prints — is the one legal quote left.
        const repaired = await submit({
          evidence: [
            { id: 'cd-engines', sourceId: 'career-data', quote: ENGINES_WORK, requirement: 'Reporting ownership', priority: 'highest' },
            { id: 'cd-beacon-header', sourceId: 'career-data', quote: BEACON_HEADER, requirement: 'Analyst tenure', priority: 'supporting' },
            listing,
          ],
          requirements: [{ id: 'need-stack', text: 'Reporting and analysis ownership across the stack', priority: 'highest', evidenceIds: ['cd-engines', 'cd-beacon-header', 'job-stack'] }],
        });
        assert(repaired.accepted && repaired.handoff?.stage === 'resume',
          `the message's own repair — quoting the opening block itself — is accepted in one round (errors=${JSON.stringify(repaired.validationErrors || [])})`);
        return { classified: 'none-opening-block-only' };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'An experience span no cited career evidence states is rejected by the stage that writes it',
    async run() {
      // The listing demands a span of years; the career corpus states roles and
      // dates. Nothing stopped a bullet or a paragraph from adding those dates
      // up and asserting the demanded span: checkFigureDiscipline only checks
      // that a letter figure also appears in the résumé, so the same invented
      // span in both documents passed. One rule now runs at the résumé stage,
      // at the cover-letter stage, and at completion, each against the
      // career-data quotes the offending unit itself cites.
      const project = await createCanvasProject();
      try {
        const plan = auditPlanFixture();
        const spanBullet = { id: 'bullet-1', text: 'Maintained internal systems with supported delivery practices over more than four years of systems work.', evidenceIds: ['resume-proof'] };
        const spanResume = { ...plan.resume, roles: [{ ...plan.resume.roles[0], bullets: [spanBullet] }] };
        const spanParagraph = `${AUDIT_PARAGRAPH} That work spans more than four years of systems delivery.`;

        const steps = await auditJobSteps(project);
        await steps.send({ identity: plan.identity, evidence: plan.evidence, requirements: plan.requirements });
        const resumePrompt = (await steps.current()).prompt;
        assert(resumePrompt.includes('A span of experience measured in years is a claim like any other: a bullet may state one only when a career-data quote that same bullet cites states it.')
          && resumePrompt.includes('Never total a span across roles and never compute one from employment dates'),
          'the résumé contract states the rule before the stage can break it');

        const rejected = await steps.submit({ resume: spanResume });
        assert(!rejected.result.accepted && rejected.result.validationErrors.some(message => message === 'unsupported-experience-span: Resume bullet bullet-1 claims an experience span (“more than four years”) that none of the career-data evidence it cites states. A span of years is a claim like any other: state one only when a career-data quote that same unit cites states it. Do not total a span across roles and do not compute one from employment dates; a duration the posting asks for is the posting’s requirement, not a fact about the candidate. Either cite a career-data quote that states the span, or describe the work instead of its length.'),
          `a bullet asserting a span its evidence never states is rejected by bullet id (errors=${JSON.stringify(rejected.result.validationErrors)})`);
        assert(!rejected.result.validationErrors.some(message => message.includes(AUDIT_BULLET)),
          'the rejection quotes only the span the responder wrote, never a corpus passage it could paste back');
        await steps.send({ resume: plan.resume });

        const letterPrompt = (await steps.current()).prompt;
        // The letter contract states the same rule AND the shapes that trip
        // it. Its earlier explanation ("a duration the posting asks for is the
        // posting's requirement") invited the one sentence the gate rejects:
        // findUnsupportedDurationClaim reads the paragraph's own words and
        // cannot tell whose span it is, so "The posting asks for four years of
        // experience" is a claim like any other and cost a round.
        assert(letterPrompt.includes('a paragraph may state one only when a career-data quote that same paragraph cites states that same span')
          && letterPrompt.includes(DURATION_CLAIM_SHAPE_RULE)
          && letterPrompt.includes('do not write the span a posting asks for into the letter at all'),
          'the cover-letter contract states the paragraph rule, the shapes the gate reads, and that an attributed span is still a claim');
        const letterRejected = await steps.submit({ coverLetter: { ...plan.coverLetter, paragraphs: [{ ...plan.coverLetter.paragraphs[0], text: spanParagraph }] } });
        assert(!letterRejected.result.accepted && letterRejected.result.validationErrors.some(message => message.startsWith('unsupported-experience-span: Cover-letter paragraph paragraph-1 claims an experience span (“more than four years”)')),
          `the same span in a letter paragraph is rejected by paragraph id (errors=${JSON.stringify(letterRejected.result.validationErrors)})`);
        await steps.send({ coverLetter: plan.coverLetter });

        // A review may rewrite either document, so a replacement must meet
        // the same source-backed duration gate before it can be accepted.
        const reviewPrompt = (await steps.current()).prompt;
        assert(reviewPrompt.includes('Any experience span measured in years that either document states must be stated by a career-data quote the same bullet or paragraph cites'),
          'the review contract states the rule the completion pass enforces');
        const revised = await steps.submit({
          decision: 'revised', resume: spanResume,
          checklist: checklist().map(item => (item.id === 'resume-source-grounding' ? { ...item, status: 'issue' } : item)),
          findings: [{ id: 'finding-1', document: 'resume', targetId: 'bullet-1', issue: 'The bullet understates the duration of the practice.', fix: 'State the span of the practice.' }],
        });
        assert(!revised.result.accepted && revised.result.validationErrors.some(message =>
          message.startsWith('Résumé replacement — unsupported-experience-span: Resume bullet bullet-1 claims an experience span (“more than four years”)')),
        `a revised review cannot introduce an unsupported span (errors=${JSON.stringify(revised.result.validationErrors || [])})`);

        // Silent neighbours. Each is a number governing "year" that asserts no
        // span of practice, so each must reach the cover-letter stage on a
        // clean job. A false rejection here has no repair the writer can see.
        const controls = await auditJobSteps(project);
        await controls.send({ identity: plan.identity, evidence: plan.evidence, requirements: plan.requirements });
        // The posting asks for "years of <work> experience"; the two words can
        // sit several apart, so the span is still named as practice and is
        // still rejected when nothing cited states it.
        const spacedClaim = await controls.submit({
          resume: { ...plan.resume, roles: [{ ...plan.resume.roles[0], bullets: [{ id: 'bullet-1', text: 'Maintained internal systems with three years of supported delivery experience.', evidenceIds: ['resume-proof'] }] }] },
        });
        assert(!spacedClaim.result.accepted && spacedClaim.result.validationErrors.some(message => message.startsWith('unsupported-experience-span: Resume bullet bullet-1 claims an experience span (“three years”)')),
          `a span named as experience several words later is still rejected (errors=${JSON.stringify(spacedClaim.result.validationErrors)})`);
        const controlTexts = [
          'Maintained internal systems through the four-year platform rollout.',
          // "shortened", not "cut": a reduction verb is a gated qualifier in
          // its own right, and this control exists to prove the DURATION rule
          // stays silent, not to smuggle a second defect past it.
          'Maintained internal systems and shortened onboarding from three years to six weeks.',
          'Maintained internal systems running Python 3 on 24/7 paging through 2021 and 2022.',
          'Maintained internal systems for 12 teams before the 2024 release.',
          'Maintained internal systems after clearing three years of archived ticket data.',
        ];
        // One job per text rather than one role of five bullets: all five cite
        // the corpus's only career-data line, 'resume-proof', and packing them
        // into one role would now trip structuredResume.js's own
        // ROLE_BULLET_EVIDENCE_EXCLUSIVITY_RULE — a real rule, but not the one
        // this control proves silent. Each gets its own single-bullet role.
        for (const text of controlTexts) {
          const control = await auditJobSteps(project);
          await control.send({ identity: plan.identity, evidence: plan.evidence, requirements: plan.requirements });
          const controlResult = await control.submit({
            resume: { ...plan.resume, roles: [{ ...plan.resume.roles[0], bullets: [{ id: 'bullet-1', text, evidenceIds: ['resume-proof'] }] }] },
          });
          // These texts assert numbers and years the one career line never
          // states, and the claim-grounding rules now reject those on their own
          // account. What this control proves is narrower: none of them is read
          // as a span of EXPERIENCE, so the duration rule stays silent.
          assert(!(controlResult.result.validationErrors || []).some(message => /claims an experience span/u.test(message)),
            `"${text}" must stay silent under the duration rule (errors=${JSON.stringify(controlResult.result.validationErrors || [])})`);
        }

        // A span the cited evidence does state is admissible, digits or words.
        const supportingQuote = 'Ada Lovelace has 6 years of internal systems delivery.';
        const supported = await auditJobSteps(project, { careerData: `${AUDIT_CAREER_DATA}\n${supportingQuote}` });
        const supportedPlan = {
          ...plan,
          evidence: plan.evidence.map(item => (item.id === 'p1-resume-proof' ? { ...item, quote: supportingQuote } : item)),
        };
        await supported.send({ identity: plan.identity, evidence: supportedPlan.evidence, requirements: plan.requirements });
        const supportedResult = await supported.submit({
          resume: { ...plan.resume, roles: [{ ...plan.resume.roles[0], bullets: [{ id: 'bullet-1', text: 'Delivered more than four years of internal systems delivery.', evidenceIds: ['resume-proof'] }] }] },
        });
        assert(supportedResult.result.accepted,
          `a floor claim a cited quote exceeds is accepted, across the digit/word spelling (errors=${JSON.stringify(supportedResult.result.validationErrors || [])})`);
        return { rejections: 4, controls: controlTexts.length };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Every check a paste correction can report resolves to the unit that check grades',
    async run() {
      // The scope of a repair brief is keyed by check id, and a check with no
      // entry in that table produces no part and therefore no brief at all —
      // which is exactly how `opening-artifact-context`, whose message never
      // writes the word paragraph, reached a user with an empty brief and cost
      // a round. So the table is total in both directions, enumerated from the
      // batteries the pipeline actually runs rather than from a hand list:
      // adding a check without placing it fails here instead of silently
      // shipping a round with nothing in its brief, and an entry for a check
      // the pipeline dropped fails here rather than lingering as a rule no
      // message can reach.
      const reportable = pasteReportableCheckIds();
      assert(reportable.length >= 45 && new Set(reportable).size === reportable.length,
        `the enumeration reads the whole battery once (ids=${reportable.length})`);
      const unplaced = reportable.filter(id => !PASTE_CHECK_PROSE_UNITS[id]);
      assert(!unplaced.length,
        `every reportable check names the unit it grades (unplaced=${JSON.stringify(unplaced)})`);
      const orphans = Object.keys(PASTE_CHECK_PROSE_UNITS).filter(id => !reportable.includes(id));
      assert(!orphans.length,
        `no entry outlives the check it was written for (orphans=${JSON.stringify(orphans)})`);
      const illegal = Object.entries(PASTE_CHECK_PROSE_UNITS)
        .filter(([, unit]) => unit !== 'prose-unit' && unit !== 'field')
        .map(([id]) => id);
      assert(!illegal.length, `each entry is the stage's prose unit or a field (illegal=${JSON.stringify(illegal)})`);

      // The three that grade a field are the reason the table has two values
      // at all: each names a mapping, a plan shape or the thesis, and none of
      // them is repaired by rewriting a paragraph. A round carrying only those
      // prints no brief, which the thesis case below measures end to end.
      const fields = Object.entries(PASTE_CHECK_PROSE_UNITS).filter(([, unit]) => unit === 'field').map(([id]) => id).sort();
      assert(JSON.stringify(fields) === JSON.stringify(['evidence-grounding', 'mapping-narrative-structure', 'role-thesis']),
        `the field-graded checks are the argument plan's own (fields=${JSON.stringify(fields)})`);
      return { reportable: reportable.length, fields: fields.length };
    },
  },
  {
    name: 'Résumé contract defines the meaningful terms the project gate counts, names every uniqueness and per-field ceiling, and anchors the employer block the way a heading-less corpus writes it',
    async run() {
      // Four rules were enforced here with nothing said about them, and the
      // fifth was described inaccurately. The corpus below is the shape the
      // real career file uses — plain title/employer lines, no markdown
      // headings, horizontal rules between sections — which is exactly the
      // case the old "from that employer's heading" wording described wrongly:
      // careerDataRoleRegionsForSourceRoles anchors such a corpus on the line
      // that IS the role title, and bounds it by the next role or the next
      // horizontal rule, never by a heading it does not have.
      const project = await createCanvasProject();
      try {
        const headlessCareerData = [
          'Ada Lovelace', 'ada@example.test', '', '---', '', 'Work Done from Past Jobs', '',
          'Senior Engineer', 'Analytical Engines — Brookfield, Ohio', '*May, 2021 – June, 2024*', '',
          '- Built the reporting pipeline for nightly batches.', '',
          'Software Engineer', 'Difference Machines — Lakeview, Ontario', '*October, 2018 – January, 2021*', '',
          '- Shipped the billing service with automated alerts.', '', '---', '',
          'Personal Projects',
          'RouteDesk - a dispatch route planner with a local model.', '',
        ].join('\n');
        assert(!/^\s{0,3}#{1,6}\s/mu.test(headlessCareerData),
          'the corpus under test carries no markdown heading at all, so the contract sentence being checked is the one this corpus actually exercises');
        const queued = await queueLocalApplicationJob({
          transport: 'paste', canvasFilePath: project.canvasFilePath, careerData: headlessCareerData,
          job: { title: 'Reporting Engineer', company: 'Acme', snippet: 'We own reporting and billing end to end, and a dispatch route planner.' },
          resumeProfile: { workHistory: [
            { id: 'role-1', title: 'Senior Engineer', employer: 'Analytical Engines', startDate: '2021', endDate: '2024' },
            { id: 'role-2', title: 'Software Engineer', employer: 'Difference Machines', startDate: '2018', endDate: '2021' },
          ] },
        });
        const planHandoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath })).handoff;
        const acceptedPlan = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: planHandoff.handoffCode, response: JSON.stringify(reply(planHandoff, {
          identity: { name: 'Ada Lovelace', contact: ['ada@example.test'] },
          evidence: [
            { id: 'cd-engines', sourceId: 'career-data', quote: 'Built the reporting pipeline for nightly batches.', requirement: 'Reporting ownership', priority: 'highest' },
            { id: 'cd-machines', sourceId: 'career-data', quote: 'Shipped the billing service with automated alerts.', requirement: 'Billing ownership', priority: 'highest' },
            { id: 'cd-planner', sourceId: 'career-data', quote: 'RouteDesk - a dispatch route planner with a local model.', requirement: 'Independent delivery', priority: 'supporting' },
            { id: 'job-stack', sourceId: 'job-listing', quote: 'reporting and billing end to end', requirement: 'Reporting and billing ownership', priority: 'highest' },
            { id: 'job-planner', sourceId: 'job-listing', quote: 'a dispatch route planner', requirement: 'Route planner ownership', priority: 'high' },
          ],
          requirements: [{ id: 'need-stack', text: 'Reporting and billing ownership across the stack', priority: 'highest', evidenceIds: ['cd-engines', 'cd-machines', 'cd-planner', 'job-stack', 'job-planner'] }],
        })) });
        assert(acceptedPlan.accepted && acceptedPlan.handoff?.stage === 'resume', `the heading-less evidence plan opens the résumé handoff: ${JSON.stringify(acceptedPlan.validationErrors || [])}`);

        const resumeStage = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath })).handoff;
        const prompt = resumeStage.prompt;
        const chars = STRUCTURED_RESUME_LIMITS.chars;
        // Interpolated from the constants the gates read, never transcribed:
        // a hand-copied threshold or stopword list that drifts fails here.
        assert(prompt.includes(`shares at least ${MIN_SHARED_CAREER_TERMS} meaningful terms with its cited career evidence — ${CAREER_TERM_OVERLAP_RULE} —`),
          'the résumé contract defines the meaningful term the project-description gate counts, from the same set and thresholds that gate reads');
        // Two gates of the same shape grade this one document, and the bullet
        // is NOT graded by the project gate above: assertSourceQuoteLinksFinalText
        // reads the rendered bullet, drops a different word list, and counts a
        // one-character term only when it is a digit. The floors are equal
        // today, so a contract printing the other module's rule here looked
        // guarded while naming a word list the bullet was never measured by.
        assert(prompt.includes(`it must share at least ${MIN_SHARED_SOURCE_TERMS} meaningful terms with the career-data quotes it cites — ${SOURCE_TERM_OVERLAP_RULE} —`),
          'the per-bullet floor and term rule are interpolated from the gate that rejects the bullet, not from the project gate beside it');
        assert(!prompt.includes(`share at least ${MIN_SHARED_CAREER_TERMS} meaningful terms with the career-data quotes it cites, under a similar exclusion`),
          'the bullet clause no longer describes its exclusion instead of naming it');
        assert(prompt.includes('Nothing may repeat: identity.contact values, the items inside one skills group, bullet ids within their role, and — each across the whole résumé — role ids, project ids, and skill-group ids.'),
          'the résumé contract names every uniqueness rule the validator enforces, not only the three it used to admit');
        assert(prompt.includes(`Per-field character ceilings, all measured after whitespace collapsing: ${chars.shortText} for identity.name or subtitleRole, a role’s title, company, dates or location, a project name, institution, issuer, degree, or certification name; ${chars.longText} for identity.credential, one contact value, or a project’s metrics; ${chars.projectDescription} for a project description; ${chars.skillText} for a skill-group label or one of its items.`),
          'the résumé contract states every per-field character ceiling text() enforces, including evidence-backed education and certification fields');
        assert(prompt.includes('Typed role dates retain source punctuation verbatim, even if their separator would be forbidden in authored prose; never normalize them.')
          && prompt.includes('The dash-style rule still applies to bullets and every other authored copy.'),
        'the résumé contract distinguishes source-locked typed dates from authored prose, so it cannot request a normalizing rewrite and then reject the retained source spelling');
        assert(prompt.includes(`inside that one employer’s own careerData section — ${CAREER_DATA_ROLE_SECTION_RULE}`)
          && CAREER_DATA_ROLE_SECTION_RULE.includes('at the line that is exactly this role’s title with that employer named on one of the lines just below it')
          && CAREER_DATA_ROLE_SECTION_RULE.includes('the next horizontal rule')
          && CAREER_DATA_ROLE_SECTION_RULE.includes('only when the block began at a markdown heading'),
        'the bullet-scope sentence describes both anchors the region scoper actually uses, and bounds the block the way it actually bounds it');

        const sourceRoles = pasteContext(prompt).sourceRoles;
        const submitResume = resume => submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: resumeStage.handoffCode, response: JSON.stringify(reply(resumeStage, { resume })) });
        const role = (index, overrides = {}) => ({
          id: sourceRoles[index].id, title: sourceRoles[index].title, company: sourceRoles[index].company, dates: sourceRoles[index].dates,
          location: index === 0 ? 'Brookfield, Ohio' : 'Lakeview, Ontario',
          bullets: [{
            id: `bullet-${index + 1}`,
            text: index === 0 ? 'Built the reporting pipeline for nightly batches.' : 'Shipped the billing service with automated alerts.',
            evidenceIds: [index === 0 ? 'cd-engines' : 'cd-machines'],
          }],
          ...overrides,
        });
        const project1 = { id: 'project-planner', name: 'RouteDesk', description: 'Dispatch route planner that runs a local model.', evidenceIds: ['cd-planner', 'job-planner'] };
        // A skill item has to be a name a recruiter can filter on, which shows in
        // its spelling, so this group carries the product its cited quote names
        // rather than the "local model" phrase that names the activity.
        const skillGroup = { id: 'skills-tools', group: 'tools', items: ['RouteDesk'], evidenceIds: ['cd-planner'] };
        const draft = (overrides = {}) => ({
          schemaVersion: 'structured-resume.v1',
          identity: { name: 'Ada Lovelace', contact: ['ada@example.test'] },
          roles: [role(0), role(1)],
          projects: [project1],
          skills: [skillGroup],
          ...overrides,
        });
        const scopeRejection = /must cite career-data evidence only from the trusted role’s career-data section|must cite career-data evidence only from the trusted role's career-data section/;

        // The region description, exercised on the corpus shape it now
        // describes: the first employer's block ends where the second role's
        // own title line begins, and the last one ends at the horizontal rule
        // above Personal Projects.
        const crossedRoles = await submitResume(draft({ roles: [role(0, { bullets: [{ id: 'bullet-1', text: 'Shipped the billing service with automated alerts.', evidenceIds: ['cd-machines'] }] }), role(1)] }));
        assert(!crossedRoles.accepted && crossedRoles.validationErrors?.some(message => scopeRejection.test(message)),
          `in a heading-less corpus the next role's own title line still ends the block, so a bullet reaching past it is rejected (errors=${JSON.stringify(crossedRoles.validationErrors || [])})`);
        const pastTheRule = await submitResume(draft({ roles: [role(0), role(1, { bullets: [{ id: 'bullet-2', text: 'Built a dispatch route planner with a local model.', evidenceIds: ['cd-planner'] }] })] }));
        assert(!pastTheRule.accepted && pastTheRule.validationErrors?.some(message => scopeRejection.test(message)),
          `the horizontal rule ends the last employer's block, so evidence below it grounds no bullet (errors=${JSON.stringify(pastTheRule.validationErrors || [])})`);

        // Each newly disclosed rule, fired.
        const flatDescription = await submitResume(draft({ projects: [{ ...project1, description: 'Built and delivered the system using work over time.' }] }));
        assert(!flatDescription.accepted && flatDescription.validationErrors?.some(message => /projects\.project-planner\.description must share at least two distinct meaningful terms/.test(message)),
          `a description that restates the deed in résumé verbs alone shares nothing the gate counts, exactly as the stopword list now printed says (errors=${JSON.stringify(flatDescription.validationErrors || [])})`);
        const repeatedItem = await submitResume(draft({ skills: [{ ...skillGroup, items: ['RouteDesk', 'RouteDesk'] }] }));
        assert(!repeatedItem.accepted && repeatedItem.validationErrors?.some(message => /skills\[0\]\.items contains duplicate identifier "RouteDesk"/.test(message)),
          'a repeated item inside one skills group is rejected, as the contract now states');
        const repeatedProjectId = await submitResume(draft({ projects: [project1, { ...project1, name: 'RouteDesk' }] }));
        assert(!repeatedProjectId.accepted && repeatedProjectId.validationErrors?.some(message => /projects contains duplicate identifier "project-planner"/.test(message)),
          'a repeated project id is rejected, as the contract now states');
        const repeatedSkillId = await submitResume(draft({ skills: [skillGroup, { ...skillGroup, group: 'methods' }] }));
        assert(!repeatedSkillId.accepted && repeatedSkillId.validationErrors?.some(message => /skills contains duplicate identifier "skills-tools"/.test(message)),
          'a repeated skill-group id is rejected, as the contract now states');
        const repeatedRoleId = await submitResume(draft({ roles: [role(0), { ...role(0), bullets: [{ id: 'bullet-2', text: 'Built the reporting pipeline for nightly batches.', evidenceIds: ['cd-engines'] }] }] }));
        assert(!repeatedRoleId.accepted && repeatedRoleId.validationErrors?.some(message => /roles contains duplicate identifier/.test(message)),
          'a repeated role id is rejected, as the contract now states');
        const longName = await submitResume(draft({ projects: [{ ...project1, name: 'P'.repeat(chars.shortText + 1) }] }));
        assert(!longName.accepted && longName.validationErrors?.some(message => message.includes(`projects[0].name exceeds ${chars.shortText} characters`)),
          'the stated project-name ceiling is the enforced one, so the disclosed number can never drift from the gate');
        const longItem = await submitResume(draft({ skills: [{ ...skillGroup, items: ['l'.repeat(chars.skillText + 1)] }] }));
        assert(!longItem.accepted && longItem.validationErrors?.some(message => message.includes(`skills[0].items[0] exceeds ${chars.skillText} characters`)),
          'the stated skill-item ceiling is the enforced one too');

        // One draft that obeys every sentence above literally, in one round:
        // bullets inside their own plain-line block, unique ids everywhere,
        // a description that shares countable terms, every field inside its
        // stated ceiling.
        const accepted = await submitResume(draft());
        assert(accepted.accepted && accepted.handoff?.stage === 'cover-letter',
          `a résumé built by literally following the disclosed rules is accepted on the first round (errors=${JSON.stringify(accepted.validationErrors || [])})`);
        return { rejections: 7, ceilings: Object.keys(chars).length };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'The evidence-plan stage rejects a plan that would leave the résumé stage no legal answer for an employer',
    async run() {
      // Measured on the live job: the accepted plan gave one employer only its
      // date block, and the résumé stage — which must show every saved role
      // with at least one bullet, each citing career evidence from that
      // employer's own section — could only answer with a bullet restating the
      // role header. The harder version of the same defect has NO answer at
      // all: an employer the plan quotes nowhere makes every possible résumé
      // response illegal, and the plan is frozen, so stage 2 rejects forever.
      // The rejection therefore belongs at the only stage that can still edit
      // the plan.
      const careerData = [
        'Ada Lovelace', 'ada@example.test', '',
        'Work Done from Past Jobs', '',
        'Senior Engineer', 'Analytical Engines — Reading, Berkshire', '*2021 – 2024*', '',
        '- Built the reporting pipeline for nightly batches.', '',
        'Software Engineer', 'Difference Machines — Cambridge, Cambridgeshire', '*2018 – 2021*', '',
        '- Shipped the billing service with automated alerts.', '',
        'Junior Engineer', 'Spare Parts Co — Oxford, Oxfordshire', '*2016 – 2018*', '',
        '---', '', 'Personal Projects', '',
        '- Built a dispatch route planner with a local model.', '',
      ].join('\n');
      const ENGINES_WORK = 'Built the reporting pipeline for nightly batches.';
      const MACHINES_WORK = 'Shipped the billing service with automated alerts.';
      const MACHINES_HEADER = 'Software Engineer\nDifference Machines — Cambridge, Cambridgeshire\n*2018 – 2021*';
      const SPARE_HEADER = 'Junior Engineer\nSpare Parts Co — Oxford, Oxfordshire\n*2016 – 2018*';
      const PROJECT_WORK = 'Built a dispatch route planner with a local model.';
      const project = await createCanvasProject();
      try {
        const queued = await queueLocalApplicationJob({
          transport: 'paste', canvasFilePath: project.canvasFilePath, careerData,
          job: { title: 'Reporting Engineer', company: 'Acme', snippet: 'We own reporting and billing end to end and expect independent delivery.' },
          resumeProfile: { workHistory: [
            { id: 'role-1', title: 'Senior Engineer', employer: 'Analytical Engines', startDate: '2021', endDate: '2024' },
            { id: 'role-2', title: 'Software Engineer', employer: 'Difference Machines', startDate: '2018', endDate: '2021' },
            { id: 'role-3', title: 'Junior Engineer', employer: 'Spare Parts Co', startDate: '2016', endDate: '2018' },
          ] },
        });
        const handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath })).handoff;
        const prompt = handoff.prompt;

        // Disclosure first: a rule the responder is rejected by must be
        // readable in the prompt that produced the response, and the section
        // it names is interpolated from the module that cuts it, so the two
        // stages can never describe the same block two different ways.
        assert(prompt.includes('Career evidence is also planned per EMPLOYER')
          && prompt.includes('the résumé must show every saved work-history role with at least one bullet')
          && prompt.includes(CAREER_DATA_ROLE_SECTION_RULE),
        'the evidence-plan contract states the per-employer coverage rule and the section boundary the résumé gate enforces');
        assert(prompt.includes('is not enough on its own') && prompt.includes('could only restate the role header')
          && prompt.includes('once this plan is accepted it cannot be changed'),
        'the contract says the opening block alone is not enough, and why the rejection lands at this stage');

        const submit = (fields) => submitLocalApplicationHandoff({
          jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoffCode,
          response: JSON.stringify(reply(handoff, {
            identity: { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: 'Software Engineer' },
            ...fields,
          })),
        });
        const listing = { id: 'job-stack', sourceId: 'job-listing', quote: 'reporting and billing end to end', requirement: 'Reporting and billing ownership', priority: 'highest' };
        const career = (id, quote, requirement) => ({ id, sourceId: 'career-data', quote, requirement, priority: 'highest' });
        const need = ids => [{ id: 'need-stack', text: 'Reporting and billing ownership across the stack', priority: 'highest', evidenceIds: [...ids, 'job-stack'] }];

        // No career evidence at all: every bullet and every letter paragraph
        // needs a career-data ID, so nothing downstream could ever be answered.
        const noCareer = await submit({ evidence: [listing], requirements: [{ id: 'need-stack', text: 'Reporting and billing ownership across the stack', priority: 'highest', evidenceIds: ['job-stack'] }] });
        assert(!noCareer.accepted && noCareer.validationErrors.some(message => message.includes('no career-data evidence item at all')),
          `a plan with only listing evidence is rejected at the stage that can still fix it (errors=${JSON.stringify(noCareer.validationErrors)})`);

        // One employer quoted nowhere. Career evidence sitting in the
        // personal-projects block grounds no role bullet, so it does not
        // rescue the uncovered employer either.
        const uncovered = await submit({
          evidence: [career('cd-engines', ENGINES_WORK, 'Reporting ownership'), career('cd-machines', MACHINES_WORK, 'Billing ownership'), career('cd-projects', PROJECT_WORK, 'Independent delivery'), listing],
          requirements: need(['cd-engines', 'cd-machines', 'cd-projects']),
        });
        assert(!uncovered.accepted
          && uncovered.validationErrors.some(message => message.includes('"Spare Parts Co"') && message.includes('No career-data evidence item in this plan quotes the career-data section of'))
          && !uncovered.validationErrors.some(message => message.includes('"Analytical Engines"') || message.includes('"Difference Machines"')),
        `only the uncovered employer is named, and personal-projects evidence does not cover it (errors=${JSON.stringify(uncovered.validationErrors)})`);
        // That employer's section is its own header and nothing else. The
        // message used to close by telling the responder to quote what the
        // section says about the work — evidence this corpus does not contain,
        // on a plan that is frozen the moment it is accepted.
        assert(uncovered.validationErrors.some(message => message.includes('"Spare Parts Co"')
          && message.includes('states nothing beyond its own opening block')
          && message.includes('quoting that opening block itself'))
          && !uncovered.validationErrors.some(message => message.includes("quoting what that employer's section says about the work")),
        `an employer whose section is only its header is told to quote that header (errors=${JSON.stringify(uncovered.validationErrors)})`);

        // The same absence over a section that DOES describe the work keeps
        // the original repair, so the two classes are reported separately
        // rather than collapsed into whichever wording fits one of them.
        const uncoveredWithBody = await submit({
          evidence: [career('cd-engines', ENGINES_WORK, 'Reporting ownership'), career('cd-spare-dates', SPARE_HEADER, 'Early tenure'), career('cd-projects', PROJECT_WORK, 'Independent delivery'), listing],
          requirements: need(['cd-engines', 'cd-spare-dates', 'cd-projects']),
        });
        assert(!uncoveredWithBody.accepted
          && uncoveredWithBody.validationErrors.some(message => message.includes('"Difference Machines"')
            && message.includes("quoting what that employer's section says about the work"))
          && !uncoveredWithBody.validationErrors.some(message => message.includes('"Spare Parts Co"')),
        `an employer whose section describes the work is told to quote that description (errors=${JSON.stringify(uncoveredWithBody.validationErrors)})`);

        // An employer quoted only by its opening block: the live job's defect.
        const headerOnly = await submit({
          evidence: [career('cd-engines', ENGINES_WORK, 'Reporting ownership'), career('cd-machines-dates', MACHINES_HEADER, 'Billing tenure'), career('cd-spare-dates', SPARE_HEADER, 'Early tenure'), listing],
          requirements: need(['cd-engines', 'cd-machines-dates', 'cd-spare-dates']),
        });
        assert(!headerOnly.accepted
          && headerOnly.validationErrors.some(message => message.includes('"Difference Machines"') && message.includes('falls inside the section') && message.includes('opening block'))
          && !headerOnly.validationErrors.some(message => message.includes('"Spare Parts Co"')),
        `the date-block-only employer is rejected, while the employer whose section says nothing else is not (errors=${JSON.stringify(headerOnly.validationErrors)})`);

        // Following the rejection literally repairs it in one round, and the
        // employer with nothing but a header keeps its header quote.
        const repaired = await submit({
          evidence: [career('cd-engines', ENGINES_WORK, 'Reporting ownership'), career('cd-machines', MACHINES_WORK, 'Billing ownership'), career('cd-spare-dates', SPARE_HEADER, 'Early tenure'), listing],
          requirements: need(['cd-engines', 'cd-machines', 'cd-spare-dates']),
        });
        assert(repaired.accepted && repaired.handoff?.stage === 'resume',
          `the repair the message names is accepted in one round (errors=${JSON.stringify(repaired.validationErrors || [])})`);

        // What the gate prevented: under the uncovered plan the résumé stage
        // had no legal answer for that employer at all. Every citation a
        // bullet could have made is rejected, so the loop had no exit — which
        // is why this rejection cannot wait for the stage that hits it.
        const uncoveredCatalog = [
          { id: 'cd-engines', sourceId: 'career-data', quote: ENGINES_WORK },
          { id: 'cd-machines', sourceId: 'career-data', quote: MACHINES_WORK },
          { id: 'cd-projects', sourceId: 'career-data', quote: PROJECT_WORK },
          { id: 'job-stack', sourceId: 'job-listing', quote: 'reporting and billing end to end' },
        ];
        const attempt = (evidenceIds) => {
          try {
            renderStructuredApplicationResume({
              schemaVersion: 'structured-resume.v1',
              identity: { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: 'Software Engineer' },
              roles: [
                { id: 'role-1', title: 'Senior Engineer', company: 'Analytical Engines', dates: '2021 – 2024', bullets: [{ id: 'b1', text: ENGINES_WORK, evidenceIds: ['cd-engines'] }] },
                { id: 'role-2', title: 'Software Engineer', company: 'Difference Machines', dates: '2018 – 2021', bullets: [{ id: 'b2', text: MACHINES_WORK, evidenceIds: ['cd-machines'] }] },
                { id: 'role-3', title: 'Junior Engineer', company: 'Spare Parts Co', dates: '2016 – 2018', bullets: [{ id: 'b3', text: 'Supported the parts catalogue.', evidenceIds }] },
              ],
            }, {
              sourceRoles: [
                { id: 'role-1', title: 'Senior Engineer', company: 'Analytical Engines', dates: '2021 – 2024', location: '' },
                { id: 'role-2', title: 'Software Engineer', company: 'Difference Machines', dates: '2018 – 2021', location: '' },
                { id: 'role-3', title: 'Junior Engineer', company: 'Spare Parts Co', dates: '2016 – 2018', location: '' },
              ],
              evidenceCatalog: uncoveredCatalog, careerData,
            });
            return '';
          } catch (error) { return String(error?.message || error); }
        };
        const everyCitation = [['cd-engines'], ['cd-machines'], ['cd-projects'], ['job-stack'], ['cd-engines', 'cd-machines', 'cd-projects', 'job-stack'], []];
        assert(everyCitation.every(evidenceIds => attempt(evidenceIds) !== ''),
          'under the rejected plan every citation the uncovered role could make is refused, so stage 2 had no answer to reach');

        return { rejectedClasses: 4, repairedInOneRound: true };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'The résumé stage applies the source-grounding rules the assembled package applies, and a career quote too short to bind a claim is named when a bullet cites it',
    async run() {
      // Two completion-time rules with no earlier twin, both reachable from a
      // stage-accepted document. The qualifier rule reads a bullet's PROSE
      // against the quotes that bullet cites; the specificity rule reads the
      // quote itself. The second one is the expensive shape: the evidence plan
      // is frozen at stage 1, so a two-word quote accepted there and cited at
      // stage 2 used to surface only at assembly, when no round left could
      // change the plan it came from.
      const project = await createCanvasProject();
      try {
        const plan = auditPlanFixture();
        const steps = await auditJobSteps(project);
        const planPrompt = (await steps.current()).prompt;
        assert(planPrompt.includes(`at least ${MIN_SOURCE_GROUNDING_QUOTE_CHARS} characters and ${MIN_SOURCE_GROUNDING_QUOTE_WORDS} words`),
          'the evidence-plan contract states the minimum a career-data quote needs, interpolated from the constants sourceQuoteIsSpecific reads');
        await steps.send({
          identity: plan.identity,
          // A real contiguous slice of the corpus body and a legal plan quote:
          // the plan stage is not made stricter, because a quote no unit
          // ever cites is never measured against this rule.
          evidence: [...plan.evidence, { id: 'p1-short-proof', sourceId: 'career-data', quote: 'Maintained', requirement: 'Systems maintenance', priority: 'supporting' }],
          requirements: plan.requirements,
        });

        const bullet = (text, evidenceIds) => ({ ...plan.resume, roles: [{ ...plan.resume.roles[0], bullets: [{ id: 'bullet-1', text, evidenceIds }] }] });
        const qualifier = await steps.submit({ resume: bullet('Maintained internal systems and cut onboarding delays.', ['resume-proof']) });
        assert(!qualifier.result.accepted && qualifier.result.handoff?.stage === 'resume'
          && qualifier.result.validationErrors.some(message => message.startsWith('unit-source-grounding: Résumé bullet "bullet-1": uses unsupported reduction outcome')),
        `a qualifier the cited quote never states is named by bullet id in the round that wrote it (errors=${JSON.stringify(qualifier.result.validationErrors || [])})`);

        const short = await steps.submit({ resume: bullet(AUDIT_BULLET, ['p1-short-proof']) });
        assert(!short.result.accepted && short.result.validationErrors.some(message =>
          message.startsWith('Résumé bullet "bullet-1" cites a career-data quote that is too short to bind a claim')
          && message.includes(`at least ${MIN_SOURCE_GROUNDING_QUOTE_CHARS} characters and ${MIN_SOURCE_GROUNDING_QUOTE_WORDS} words`))
          && pasteRejectionCheckIds(short.result.validationErrors).checkIds.includes('unit-source-grounding'),
        `citing the two-word quote is rejected where the citation is still changeable, not after the plan is frozen (errors=${JSON.stringify(short.result.validationErrors || [])})`);

        // Never stricter than the gate it mirrors: the bullet the fixture was
        // always allowed to write still passes on the next round.
        const accepted = await steps.submit({ resume: bullet(AUDIT_BULLET, ['resume-proof']) });
        assert(accepted.result.accepted && accepted.result.handoff?.stage === 'cover-letter',
          `a bullet whose prose stays inside the quote it cites is accepted (errors=${JSON.stringify(accepted.result.validationErrors || [])})`);
        return { minQuoteChars: MIN_SOURCE_GROUNDING_QUOTE_CHARS, minQuoteWords: MIN_SOURCE_GROUNDING_QUOTE_WORDS };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
];
