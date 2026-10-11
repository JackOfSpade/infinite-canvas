// Regression tests for the reviewer context of the letter conventions clause (blind-review prompt mode v7,
// v16 round 2 work package T3).
//
// v6 told the reviewers that read the cover letter to report a required sentence that "only echoes the
// posting's vocabulary", yet no letter-reading scope was shown the posting or the span the paragraph answers.
// The judgement could not be made, so editorial reviewers kept calling host-required, posting-grounded sentences
// abstract and could not tell a legitimate relation from a filler echo.  v7 gives the three scopes that read the
// letter (letter-argument-editorial, cross-document-coherence, bundle-editorial) bounded HOST-PROJECTED context:
// for each letter paragraph on the page, its host-verified jobNeedQuote and the career quotes it cites, and
// extends the signed clause so it says what that context is.  Every finding stays blocking.
//
// What is covered (every fixture is synthetic, in unrelated domains):
//   1  the builder projects only host-verified facts: the audit's jobNeedQuote after it is re-verified as a span of
//      the listing, and the cited CAREER quotes; never the writer's other audit fields, never posting evidence or
//      the host's role attribution; a quote that is not a listing span, or an audit that no longer binds the final
//      paragraphs, fails loudly instead of being dropped or invented;
//   2  a grounded accessor mints v7; exactly the three letter-reading scopes carry the grounding, aligned to the
//      letter page they read, the cited text equals what the fact track is shown, and the signed allowed context says so;
//   3  mutation: removing / changing the projected quote changes the reviewer context, the scope digests, the source
//      descriptor and the plan digest of exactly the letter-reading scopes;
//   4  page alignment: a paragraph lies on every page it touches, and a pair scope follows the letter page it pairs;
//   5  byte ceilings: with real worst-case contexts every scope stays inside the context ceilings and the signed
//      prompt limit (continuation page and longest finding ids included); the fit never exceeds its room and marks
//      whatever it shortens; realistic documents are grounded in full;
//   6  the fitting ladder is deterministic, monotone in its room, and never cuts inside a character;
//   7  the signed v7 clause says what the context is, waives nothing and holds nothing about any document, and the
//      v4 / v5 / v6 roots (v6 minted by the build before this one) still reconstruct and print their original prompts;
//   8  findings on a grounded scope are ordinary blocking findings with repair packets; a stale accessor is refused.
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {
  APPLICATION_BLIND_REVIEW_HOST_CONVENTIONS,
  APPLICATION_BLIND_REVIEW_LETTER_BEGINS_CHARS,
  APPLICATION_BLIND_REVIEW_LETTER_CITED_QUOTE_MAX_CHARS,
  APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS,
  APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS_TRACKS,
  APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS_V6,
  APPLICATION_BLIND_REVIEW_LETTER_GROUNDING_LIMITS,
  APPLICATION_BLIND_REVIEW_LETTER_GROUNDING_MAX_BYTES,
  APPLICATION_BLIND_REVIEW_LETTER_NEED_QUOTE_MAX_CHARS,
  APPLICATION_BLIND_REVIEW_MAX_CONTEXT_BYTES,
  APPLICATION_BLIND_REVIEW_MAX_PAIR_CONTEXT_BYTES,
  APPLICATION_BLIND_REVIEW_MAX_PROMPT_BYTES,
  APPLICATION_BLIND_REVIEW_PROMPT_MODE,
  APPLICATION_BLIND_REVIEW_UNGROUNDED_PROMPT_MODE,
  __applicationBlindReviewCutGroundingTextForTests,
  __applicationBlindReviewFitLetterGroundingForTests,
  __applicationBlindReviewPolicyForTests,
  acceptApplicationBlindReviewResponse,
  applicationBlindReviewConventionsFor,
  applicationBlindReviewDocumentPageIndex,
  applicationBlindReviewPlanHasLetterGrounding,
  applicationBlindReviewPolicyCatalogue,
  applicationBlindReviewScopeAt,
  assertApplicationBlindReviewPlan,
  buildApplicationBlindReviewLetterConventions,
  buildApplicationBlindReviewPrompt,
  createApplicationBlindRepairPackets,
  createApplicationBlindReviewPlan,
  createApplicationBlindReviewSourceAccessor,
  nextApplicationBlindReviewWork,
  validateApplicationBlindReviewReceipts,
} from '../../electron/ipc/applicationBlindReview.js';
import { APPLICATION_AUTHORITY_WORKFLOW_VERSION, authorityDigest } from '../../electron/ipc/applicationAuthorityWorkflow.js';
import {
  __blindReviewBoundedTailoringPagesForTests,
  __blindReviewDocumentProjectionForTests,
  __blindReviewFactEvidenceForTests,
  __blindReviewLetterGroundingForTests,
  __blindReviewLetterNeedQuotesForTests,
} from '../../electron/ipc/localAiApplication.js';
import * as coverLetterChecks from '../../electron/ipc/coverLetterChecks.js';

// The signed plan limit the application uses (BLIND_REVIEW_PLAN_PROMPT_BYTE_LIMIT in localAiApplication.js).
const PLAN_PROMPT_BYTE_LIMIT = APPLICATION_BLIND_REVIEW_MAX_PROMPT_BYTES - 1536;
const LETTER_TRACKS = Object.freeze(['bundle-editorial', 'cross-document-coherence', 'letter-argument-editorial']);
const PAIR_TRACKS = Object.freeze(['bundle-editorial', 'cross-document-coherence']);
const WRITER_ONLY = 'WRITER-ONLY';
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
const occurrences = (text, part) => text.split(part).length - 1;
const trackOf = prompt => /TRACK: ([^\n]+)/u.exec(prompt)[1];
const escapedBytes = value => Buffer.byteLength(JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026'), 'utf8');
const resign = record => { const { digest: _digest, ...rest } = record; return { ...record, digest: authorityDigest(rest) }; };
const relabel = (plan, mutate) => resign({ ...plan, root: resign(mutate(structuredClone(plan.root))) });

// A prompt-mode v6 plan and its six prompts, produced by the build that introduced the letter conventions clause (before v7 existed)
// from the freight-style fixture documents below, so a root signed by that build can be shown to still reconstruct.  The root records
// the validator stamp of that build, which is evidence and never a condition.
const HISTORICAL_V6 = JSON.parse('{"plan":{"version":2,"kind":"application-blind-review-plan","root":{"version":2,"kind":"application-blind-review-root","sourceDigest":"434a48699d549c67ab9ab89ab4b05eb88e2e792ab91fc0d8ff459ffbd23b86ab","sources":{"version":2,"kind":"application-blind-review-source-descriptor","documents":{"resume":{"version":2,"kind":"blind-review-document-source","document":"resume","textDigest":"51295311ca20d47f2a50d8787406a93e1dece833760312da263b20adc57c43ef","pageCount":1,"pageDigest":"fecabc375b0d10cc8f4d0c6edb49eed2239bef1a3c67d9625aa1e792c7876bfe","digest":"affa231c5e44ba79d2c12ce3b6ea72d9256a62f85697a12dd36d685c3c7d3216"},"coverLetter":{"version":2,"kind":"blind-review-document-source","document":"coverLetter","textDigest":"72e54362931d8fe23cd2b05d85f01d360f769603cc744b9dc4609a0cc4a841d7","pageCount":1,"pageDigest":"5d2061f7f43b532a72ac631de7214dee61481864e845f8f92fda207b86391771","digest":"da145bc337474a04af257f054ccdc4ea8102cd29e361156d903e7bcdbc0361b6"}},"citedEvidence":{"sourceCount":1,"pageCount":1,"pageDigest":"3e026d169767dd1ca9a006665dcd4c51a4fbd8b93268992a7ee6c514bd40ab5d"},"factClaims":{"count":1,"claimDigest":"829554c69c1db7c8bc11b1be707db7597ce60beaf27a6fd4dd3005024be7fcf2","scopeCount":1,"scopeMode":"claim-evidence-set"},"tailoring":{"pageCount":1,"pageDigest":"6e058249c33b189f49b157215e437e447df6101d737f723956fad5acb3d310c2"},"digest":"434a48699d549c67ab9ab89ab4b05eb88e2e792ab91fc0d8ff459ffbd23b86ab"},"policyDigest":"078a80642e98fe0882b9bccbcbb25081bc2ae2655b1a6226bb8316e82183486f","promptByteLimit":24576,"maxFindingsPerResponse":32,"promptMode":"artifact-repair-only-v6","validatorStamp":"ae8904e6dedd7f7a97a9cf602646f42635d437679345e47556d1c918d7f7212a","trackCounts":{"fact-fidelity":1,"resume-hiring-quality":1,"letter-argument-editorial":1,"tailoring-ats":1,"cross-document-coherence":1,"bundle-editorial":1},"scopeCount":6,"digest":"f03c5c32a6c2d4caebfa2c617cc084a9988c5e349df6ef70c7b9785134c0abb7"},"digest":"7fb4a6fe3da1276c4fed7b380269b784c10a3f297be581911f11349845adad36"},"promptSha256":["c763c4a19eb09dd9fd304fa906e3c7042a265d7361184dae73661c2cb3267024","705afd660e7add55fe9ee572eaf2151c9d9d3464165da5255b07048124ab251d","d9384950abf46a2bccf7da307bd4be0246cf6946070743851c6c37b6d09184eb","5a06e5ca0f6d5fe3277b4e99e412e82a8fb523ce0e55eb7c4fee96d937f138df","4454a11fc968f2de6db422b0d85bc1d220118805074d59cad0b1a5425ed7925e","ba3a1295cedb5c0994e9fb2841d40edf77ccb11a35eb00d42749e7ed0e25e8a3"]}');

// ---------------------------------------------------------------------------
// Synthetic careers and postings in unrelated domains.  Each has one role, two career quotes, a three-paragraph
// letter (two proof-bearing, one closing), and a posting whose requirement lines the audit maps the proof
// paragraphs to.  Nothing here resembles any real candidate or posting.
// ---------------------------------------------------------------------------
const DOMAINS = Object.freeze([
  {
    domain: 'freight routing', person: 'Mara Okonkwo', email: 'mara@example.test', title: 'Dispatch Planner', employer: 'Harbourline Freight',
    careerA: 'Consolidated partial pallets into full overnight loads for six regional depots, replacing nine weekly truck dispatches.',
    careerB: 'Built the lane-pricing sheet that dispatchers used each Monday to choose carriers.',
    bullet: 'Consolidated partial pallets into full overnight loads for six regional depots.',
    listingTitle: 'Network Planner', listingCompany: 'Tidewater Logistics',
    posting: 'You will plan overnight load consolidation across regional depots.\nYou will keep carrier pricing current for the weekly tender.\nYou will report empty-mile trends to operations leads.',
    needA: 'plan overnight load consolidation across regional depots', needB: 'keep carrier pricing current for the weekly tender',
    paragraphs: [
      'At Harbourline Freight I consolidated partial pallets into full overnight loads for six regional depots, the depot-level work this planning role runs.',
      'I also built the lane-pricing sheet that dispatchers used each Monday to choose carriers, so carrier pricing stayed current for the weekly tender.',
      'I would welcome a conversation about the role.',
    ],
  },
  {
    domain: 'clinic scheduling', person: 'Tomas Reyes', email: 'tomas@example.test', title: 'Clinic Coordinator', employer: 'Riverbend Clinics',
    careerA: 'Redesigned the appointment reminder workflow for four outpatient clinics; missed visits fell at every site.',
    careerB: 'Trained front-desk staff to reschedule cancellations from a shared waitlist the same day.',
    bullet: 'Redesigned the appointment reminder workflow for four outpatient clinics.',
    listingTitle: 'Scheduling Lead', listingCompany: 'Lakeshore Health',
    posting: 'You will own appointment reminder workflows for a network of clinics.\nYou will fill cancelled slots from a waitlist within the same day.\nYou will coach front-desk teams on scheduling standards.',
    needA: 'own appointment reminder workflows for a network of clinics', needB: 'fill cancelled slots from a waitlist within the same day',
    paragraphs: [
      'At Riverbend Clinics I redesigned the appointment reminder workflow for four outpatient clinics, and missed visits fell at every site.',
      'I trained front-desk staff to reschedule cancellations from a shared waitlist the same day, which kept cancelled slots filled.',
      'I would be glad to talk through the details.',
    ],
  },
  {
    domain: 'library cataloguing', person: 'Ines Varga', email: 'ines@example.test', title: 'Serials Cataloguer', employer: 'Eastgate Library',
    careerA: 'Converted serials cataloguing records into a unified authority file and removed duplicate publisher entries.',
    careerB: 'Wrote the style guide that catalogue staff followed when naming corporate authors.',
    bullet: 'Converted serials cataloguing records into a unified authority file.',
    listingTitle: 'Metadata Librarian', listingCompany: 'Northfield University Library',
    posting: 'You will maintain authority files for serials and monographs.\nYou will document naming standards for corporate authors.\nYou will clean duplicate records after each migration.',
    needA: 'maintain authority files for serials and monographs', needB: 'document naming standards for corporate authors',
    paragraphs: [
      'At Eastgate Library I converted serials cataloguing records into a unified authority file and removed duplicate publisher entries.',
      'I wrote the style guide that catalogue staff followed when naming corporate authors, which is the naming standard work this role documents.',
      'Thank you for considering my application.',
    ],
  },
  {
    domain: 'retail analytics', person: 'Priya Nandakumar', email: 'priya@example.test', title: 'Demand Analyst', employer: 'Fernwood Markets',
    careerA: 'Rebuilt the weekly demand forecast for ninety grocery lines, cutting spoilage on chilled goods.',
    careerB: 'Presented the markdown calendar to category managers every quarter.',
    bullet: 'Rebuilt the weekly demand forecast for ninety grocery lines.',
    listingTitle: 'Category Analyst', listingCompany: 'Summit Grocers',
    posting: 'You will forecast weekly demand for fresh and chilled categories.\nYou will present markdown plans to category managers.\nYou will reduce waste across the store network.',
    needA: 'forecast weekly demand for fresh and chilled categories', needB: 'present markdown plans to category managers',
    paragraphs: [
      'At Fernwood Markets I rebuilt the weekly demand forecast for ninety grocery lines, cutting spoilage on chilled goods.',
      'I presented the markdown calendar to category managers every quarter, which is the planning conversation this role has with them.',
      'I look forward to speaking with you.',
    ],
  },
]);

const PARAGRAPH_CITES = Object.freeze([['career-a', 'posting-1'], ['career-b', 'career-a'], ['career-a']]);
const PARAGRAPH_IDS = Object.freeze(['cover.opening', 'cover.second', 'cover.closing']);
const roleOf = domain => ({ id: 'role-1', title: domain.title, company: domain.employer, dates: '2019 – 2023', location: '' });
function auditFor(domain, mutate = entries => entries) {
  return mutate(domain.paragraphs.map((text, index) => ({
    paragraph: text, argumentativeJob: `${WRITER_ONLY} job ${index}`, relationToThesis: `${WRITER_ONLY} thesis ${index}`,
    ...(index < 2 ? { argumentMapping: { claim: `${WRITER_ONLY} claim ${index}`, proof: `${WRITER_ONLY} proof ${index}`, relevance: `${WRITER_ONLY} relevance ${index}`, jobNeedQuote: index === 0 ? domain.needA : domain.needB } } : {}),
  })));
}
function stateFor(domain, { audit = auditFor(domain), careerA = domain.careerA, withAudit = true } = {}) {
  return {
    evidencePlan: { evidence: [
      { id: 'career-a', sourceId: 'career-data', quote: careerA, roleId: 'role-1' },
      { id: 'career-b', sourceId: 'career-data', quote: domain.careerB, roleId: 'role-1' },
      { id: 'posting-1', sourceId: 'job-listing', quote: domain.posting.split('\n')[0] },
    ] },
    resume: { identity: { name: domain.person, contact: [domain.email] }, roles: [{ ...roleOf(domain), bullets: [{ id: 'bullet-1', text: domain.bullet, evidenceIds: ['career-a'] }] }] },
    coverLetter: { name: domain.person, contact: [domain.email], salutation: 'Dear Hiring Team,', closing: 'Sincerely,', signatureTitle: domain.title,
      paragraphs: domain.paragraphs.map((text, index) => ({ id: PARAGRAPH_IDS[index], text, evidenceIds: PARAGRAPH_CITES[index] })) },
    ...(withAudit ? { finalReview: { generationAudit: { coverLetterPlan: { controllingThesis: 'thesis', paragraphs: audit } } } } : {}),
  };
}
const inputFor = domain => ({ sourceRoles: [roleOf(domain)], job: { title: domain.listingTitle, company: domain.listingCompany, location: 'Remote', description: domain.posting } });

/** The production sequence minus the store: document projection, fact evidence, letter grounding, accessor, plan. */
function buildCase(domain, { state = stateFor(domain), input = inputFor(domain), mutateGrounding = rows => rows, grounded = true } = {}) {
  const projection = __blindReviewDocumentProjectionForTests(state);
  const fact = __blindReviewFactEvidenceForTests(state, input);
  const needQuotes = __blindReviewLetterNeedQuotesForTests(state, input);
  const letterGrounding = __blindReviewLetterGroundingForTests(state, fact.factClaims, needQuotes);
  const requirements = [{ id: 'req-1', text: domain.needA, priority: 'highest' }];
  const tailoringPages = __blindReviewBoundedTailoringPagesForTests(requirements, [{ requirementId: 'req-1', disposition: 'omitted-no-evidence', justification: 'No candidate evidence states this requirement.', proofs: [] }], 'req');
  const accessor = createApplicationBlindReviewSourceAccessor({
    resume: projection.resume, coverLetter: projection.coverLetter, citedEvidencePages: fact.pages, tailoringPages,
    factClaims: fact.factClaims.map(claim => ({ ...claim, pageIndex: applicationBlindReviewDocumentPageIndex(claim.document === 'resume' ? projection.resume : projection.coverLetter, claim.text) })),
    ...(grounded ? { letterGrounding: mutateGrounding(letterGrounding) } : {}),
  });
  const plan = createApplicationBlindReviewPlan({ sourceAccessor: accessor, promptByteLimit: PLAN_PROMPT_BYTE_LIMIT });
  return { domain, state, input, projection, fact, needQuotes, letterGrounding, accessor, plan };
}
function scopesOf({ plan, accessor }) {
  return Array.from({ length: plan.root.scopeCount }, (_unused, ordinal) => ({ ordinal, ...applicationBlindReviewScopeAt(plan, ordinal, { sourceAccessor: accessor }) }));
}
const promptAt = (plan, accessor, scopeOrdinal) => buildApplicationBlindReviewPrompt(plan, nextApplicationBlindReviewWork(plan, [], { scopeOrdinal, sourceAccessor: accessor }), { sourceAccessor: accessor });
const begins = text => Array.from(text).slice(0, APPLICATION_BLIND_REVIEW_LETTER_BEGINS_CHARS).join('');
/** The grounding a one-page letter must project for a case: the audit's quote and the fact track's own cited text. */
function expectedGrounding({ domain, fact }) {
  const textOf = id => fact.pages.find(page => page.id === id).text;
  return { paragraphs: domain.paragraphs.map((text, index) => ({
    begins: begins(text),
    ...(index < 2 ? { jobNeedQuote: index === 0 ? domain.needA : domain.needB } : {}),
    citedCareerQuotes: PARAGRAPH_CITES[index].filter(id => id.startsWith('career-')).map(id => ({ id, text: textOf(id) })),
  })) };
}

// ---------------------------------------------------------------------------
// Direct accessors for byte and page-alignment measurements: synthetic documents of chosen sizes, built straight
// on the public accessor so the sizes are exact.
// ---------------------------------------------------------------------------
const FILLER_WORDS = Object.freeze('ledger route depot intake cohort batch record roster tariff audit shelf ward'.split(' '));
/** Deterministic text of exactly `chars` characters that starts with `label` (an ASCII word list, never a sentence). */
function filler(label, chars) {
  let out = label; let index = 0;
  while (out.length < chars) { out += ` ${FILLER_WORDS[index % FILLER_WORDS.length]}${index}`; index += 1; }
  return out.slice(0, chars);
}
const RESUME_BULLET = 'Held the weekly planning cycle.';
function directCase({ paragraphCount = 3, paragraphChars = 400, quoteChars = 200, needChars = 90, citesPerParagraph = 2, resumeFill = 0, letterFill = 0, duplicateParagraphs = false, claimParagraphs = true } = {}) {
  const quotes = []; const paragraphs = [];
  for (let index = 0; index < paragraphCount; index += 1) {
    // Without a fact claim per paragraph the only evidence every row may cite is the résumé claim's.
    const ids = claimParagraphs ? Array.from({ length: citesPerParagraph }, (_unused, cite) => `cq-${index}-${cite}`) : ['cq-0-0'];
    if (claimParagraphs || index === 0) ids.forEach(id => quotes.push({ id, text: filler(`quote ${id}`, quoteChars) }));
    paragraphs.push({ text: filler(duplicateParagraphs ? 'Same paragraph' : `Paragraph ${index}`, paragraphChars), ids });
  }
  const coverLetter = ['Body', ...paragraphs.map(paragraph => paragraph.text), ...(letterFill ? [filler('closing filler', letterFill)] : [])].join('\n');
  const resume = ['Experience', 'Planner at Example Co', RESUME_BULLET, ...(resumeFill ? [filler('resume filler', resumeFill)] : [])].join('\n');
  const citedEvidencePages = quotes.length ? quotes : [{ id: 'cq-0-0', text: filler('quote cq-0-0', quoteChars) }];
  const accessor = createApplicationBlindReviewSourceAccessor({
    resume, coverLetter, citedEvidencePages,
    tailoringPages: [{ id: 'requirements-1', requirements: [{ id: 'requirement-1', text: 'Weekly planning.', priority: 'highest' }],
      dispositions: [{ requirementId: 'requirement-1', disposition: 'addressed-resume', justification: 'The résumé addresses it.',
        proofs: [{ document: 'resume', documentDigest: authorityDigest(resume), offset: resume.indexOf(RESUME_BULLET), quote: RESUME_BULLET }] }] }],
    factClaims: [
      { id: 'resume-claim', document: 'resume', pageIndex: 0, text: RESUME_BULLET, citedEvidenceIds: [citedEvidencePages[0].id] },
      ...(claimParagraphs ? paragraphs.map((paragraph, index) => ({ id: `letter-${index}`, document: 'coverLetter', pageIndex: applicationBlindReviewDocumentPageIndex(coverLetter, paragraph.text), text: paragraph.text, citedEvidenceIds: paragraph.ids })) : []),
    ].filter((claim, index, claims) => claims.findIndex(other => other.id === claim.id) === index),
    letterGrounding: paragraphs.map((paragraph, index) => ({ text: paragraph.text, jobNeedQuote: needChars ? filler(`need ${index}`, needChars) : null, citedEvidenceIds: paragraph.ids })),
  });
  const plan = createApplicationBlindReviewPlan({ sourceAccessor: accessor, promptByteLimit: PLAN_PROMPT_BYTE_LIMIT });
  return { plan, accessor, paragraphs, quotes: citedEvidencePages, coverLetter, resume };
}
/** The longest prompt a scope can print: the first page, or a continuation page after a response of 32 findings with the longest legal ids. */
function worstPromptBytes(plan, accessor, ordinal, track) {
  const work = nextApplicationBlindReviewWork(plan, [], { scopeOrdinal: ordinal, sourceAccessor: accessor });
  let bytes = Buffer.byteLength(buildApplicationBlindReviewPrompt(plan, work, { sourceAccessor: accessor }), 'utf8');
  const document = PAIR_TRACKS.includes(track) || track === 'resume-hiring-quality' ? 'resume' : track === 'letter-argument-editorial' ? 'cover-letter' : null;
  if (document) {
    const prefix = `${ordinal}-0-`;
    const findings = Array.from({ length: 32 }, (_unused, index) => ({ id: `${prefix}${String(index).padStart(2, '0')}${'i'.repeat(94 - prefix.length - 2)}`, ruleId: 'editorial', document, targetId: 'paragraph-1', issue: 'An issue.', fix: 'A fix.' }));
    const receipts = acceptApplicationBlindReviewResponse({ plan, receipts: [], work, sourceAccessor: accessor, response: {
      version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, scopeDigest: work.scopeDigest, pageIndex: 0, previousPageDigest: work.previousPageDigest, complete: false, decision: 'issues', findings } });
    const next = nextApplicationBlindReviewWork(plan, receipts, { scopeOrdinal: ordinal, sourceAccessor: accessor });
    bytes = Math.max(bytes, Buffer.byteLength(buildApplicationBlindReviewPrompt(plan, next, { sourceAccessor: accessor, previousReceipt: receipts[0] }), 'utf8'));
  }
  return bytes;
}
/** Per letter-reading scope: context bytes, worst prompt bytes and the grounding it carries. */
function measureLetterScopes({ plan, accessor }) {
  const rows = [];
  for (let ordinal = 0; ordinal < plan.root.scopeCount; ordinal += 1) {
    const { scope, context } = applicationBlindReviewScopeAt(plan, ordinal, { sourceAccessor: accessor });
    if (!LETTER_TRACKS.includes(scope.track)) continue;
    rows.push({ ordinal, track: scope.track, contextBytes: escapedBytes(context), baseBytes: escapedBytes({ ...context, letterGrounding: undefined }), promptBytes: worstPromptBytes(plan, accessor, ordinal, scope.track), grounding: context.letterGrounding, groundingBytes: escapedBytes(context.letterGrounding) });
  }
  return rows;
}

export default [
  {
    name: 'letter grounding builder: projects only the host-verified job-need span and the cited career quotes, never the writer\'s other audit fields, posting evidence or role attribution (4 domains, A / B)',
    run() {
      for (const domain of DOMAINS) {
        const base = buildCase(domain);
        // A: the rows are exactly the letter's paragraphs, their verified needs and their career citations.
        assert.deepEqual(base.letterGrounding.map(row => row.text), domain.paragraphs, `${domain.domain}: one row per projected paragraph, in order`);
        assert.deepEqual(base.letterGrounding.map(row => row.jobNeedQuote), [domain.needA, domain.needB, null], `${domain.domain}: the audit's need for each proof paragraph, none for the closing`);
        assert.deepEqual(base.letterGrounding.map(row => row.citedEvidenceIds), [['career-a'], ['career-b', 'career-a'], ['career-a']], `${domain.domain}: only career-data citations`);
        assert.deepEqual(base.needQuotes, [domain.needA, domain.needB, null]);
        // The fact track holds the host's role attribution for the same claims; the letter grounding must not.
        const letterClaims = base.fact.factClaims.filter(claim => claim.document === 'coverLetter');
        assert(letterClaims.length === 3 && letterClaims.every(claim => claim.citedEvidenceIds.some(id => id.startsWith('host.role-attribution.'))), `${domain.domain}: precondition: the fact track carries role attribution`);
        const serialized = JSON.stringify(base.letterGrounding);
        assert(!serialized.includes('host.role-attribution') && !serialized.includes('posting-1') && !serialized.includes(WRITER_ONLY), `${domain.domain}: no attribution, posting evidence or writer-only audit field`);
        // Even if the claims carried posting and attribution ids, the builder keeps career citations only.
        const injected = base.fact.factClaims.map(claim => (claim.document === 'coverLetter' ? { ...claim, citedEvidenceIds: [...claim.citedEvidenceIds, 'posting-1', 'host.role-attribution.zzz'] } : claim));
        assert.deepEqual(__blindReviewLetterGroundingForTests(base.state, injected, base.needQuotes), base.letterGrounding, `${domain.domain}: non-career ids are filtered by the builder itself`);
        // B (mutations): each breaks a different host guarantee and fails loudly, naming the cause.
        const mutated = (mutate, options = {}) => () => __blindReviewLetterNeedQuotesForTests(stateFor(domain, { audit: auditFor(domain, mutate), ...options }), inputFor(domain));
        assert.throws(mutated(entries => entries.map((entry, index) => (index === 0 ? { ...entry, argumentMapping: { ...entry.argumentMapping, jobNeedQuote: 'a requirement the listing never states' } } : entry))), /not a span of the job listing/u, `${domain.domain}: a need that is not a listing span is refused, not dropped`);
        assert.throws(mutated(entries => entries.map((entry, index) => (index === 1 ? { ...entry, paragraph: `${entry.paragraph} Extra.` } : entry))), /no longer matches the final cover-letter paragraph/u, `${domain.domain}: an audit entry that drifted from its paragraph is refused`);
        assert.throws(mutated(entries => entries.slice(0, 2)), /does not bind every final cover-letter paragraph/u, `${domain.domain}: an audit that lost a paragraph is refused`);
        assert.throws(() => __blindReviewLetterGroundingForTests(base.state, base.fact.factClaims, [domain.needA]), /one job-need record to each cover-letter fact claim/u, `${domain.domain}: a short need record is refused`);
        assert.throws(() => __blindReviewLetterGroundingForTests(base.state, base.fact.factClaims, [domain.needA, '   ', null]), /malformed/u, `${domain.domain}: a blank need is refused`);
        // No audit at all: nothing is invented.
        assert.deepEqual(__blindReviewLetterNeedQuotesForTests(stateFor(domain, { withAudit: false }), inputFor(domain)), [null, null, null], `${domain.domain}: with no audit there is no need to project`);
        // The gate compares with case, spacing and typographic variants folded: so does the host, and it projects the audit's own text, whitespace collapsed.
        const shouted = domain.needA.toUpperCase().replace(/ /gu, '  ');
        assert.deepEqual(__blindReviewLetterNeedQuotesForTests(stateFor(domain, { audit: auditFor(domain, entries => entries.map((entry, index) => (index === 0 ? { ...entry, argumentMapping: { ...entry.argumentMapping, jobNeedQuote: shouted } } : entry))) }), inputFor(domain))[0], domain.needA.toUpperCase(), `${domain.domain}: a variant of a listing span verifies`);
        // The posting decides: the very same audit against another posting is refused.
        const other = DOMAINS[(DOMAINS.indexOf(domain) + 1) % DOMAINS.length];
        assert.throws(() => __blindReviewLetterNeedQuotesForTests(stateFor(domain), inputFor(other)), /not a span of the job listing/u, `${domain.domain}: needs are verified against the posting in hand`);
      }
    },
  },
  {
    name: 'letter grounding: a grounded accessor mints v7, exactly the three letter-reading scopes carry the page-aligned grounding, and what they are shown is what the fact track is shown (4 domains)',
    run() {
      assert.equal(APPLICATION_BLIND_REVIEW_PROMPT_MODE, 'artifact-repair-only-v7');
      assert.deepEqual([...APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS_TRACKS], LETTER_TRACKS);
      for (const domain of DOMAINS) {
        const kase = buildCase(domain); const { plan, accessor } = kase;
        assert.equal(plan.root.promptMode, 'artifact-repair-only-v7', `${domain.domain}: a grounded accessor mints v7`);
        assert(applicationBlindReviewPlanHasLetterGrounding(plan) && plan.root.sources.letterGrounding.paragraphCount === 3, `${domain.domain}: the source descriptor binds the three paragraphs`);
        const policy = __applicationBlindReviewPolicyForTests(plan.root);
        assert.equal(policy.digest, plan.root.policyDigest);
        const signedReaders = Object.entries(policy.allowedContext).filter(([, refs]) => refs.includes('letter-paragraph-grounding')).map(([track]) => track).sort();
        assert.deepEqual(signedReaders, LETTER_TRACKS, `${domain.domain}: the signed allowed context names the grounding for exactly the letter-reading tracks`);
        const expected = expectedGrounding(kase);
        const factText = new Map();
        const seen = new Set();
        for (const { ordinal, scope, context } of scopesOf(kase)) {
          seen.add(scope.track);
          for (const page of context.citedEvidencePages || []) factText.set(page.sourceId, page.text);
          assert.deepEqual(scope.allowedContext, policy.allowedContext[scope.track], `${domain.domain}/${scope.track}: the scope signs its track's allowed context`);
          if (LETTER_TRACKS.includes(scope.track)) {
            assert.deepEqual(context.letterGrounding, expected, `${domain.domain}/${scope.track}: the projected grounding`);
            assert(scope.contextRefs.at(-1).kind === 'letter-grounding' && scope.contextRefs.length === (scope.track === 'letter-argument-editorial' ? 2 : 3), `${domain.domain}/${scope.track}: the scope binds the grounding page, after the document refs`);
            assert(!JSON.stringify(context).includes(WRITER_ONLY) && !JSON.stringify(context).includes('host.role-attribution') && !JSON.stringify(context).includes('posting-1'), `${domain.domain}/${scope.track}: nothing writer-only, posting evidence or attribution`);
            const prompt = promptAt(plan, accessor, ordinal);
            assert.equal(occurrences(prompt, APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS), 1, `${domain.domain}/${scope.track}: the v7 clause is printed once`);
            assert(!prompt.includes(APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS_V6), `${domain.domain}/${scope.track}: the v6 clause is not printed`);
            assert(prompt.indexOf(APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS) < prompt.indexOf('<untrusted-evidence-json>'), `${domain.domain}/${scope.track}: the clause is outside the evidence block`);
            assert(prompt.includes('ALLOWED HOST-PROJECTED CONTEXT ONLY:') && /ALLOWED HOST-PROJECTED CONTEXT ONLY: [^\n]*letter-paragraph-grounding/u.test(prompt), `${domain.domain}/${scope.track}: the prompt names the grounding as allowed context`);
          } else {
            assert.equal(Object.hasOwn(context, 'letterGrounding'), false, `${domain.domain}/${scope.track}: no other track carries the grounding`);
            assert(!scope.allowedContext.includes('letter-paragraph-grounding'));
            assert(!promptAt(plan, accessor, ordinal).includes('LETTER CONVENTIONS'), `${domain.domain}/${scope.track}: no letter clause`);
          }
        }
        assert.equal(seen.size, 6);
        // What the editorial reviewers see for a cited id is the very text the fact-fidelity track is shown for it.
        for (const paragraph of expected.paragraphs) for (const quote of paragraph.citedCareerQuotes) assert.equal(quote.text, factText.get(quote.id), `${domain.domain}: ${quote.id} reads identically to the fact track`);
        // Nothing else moved: a plan from the same documents without the grounding has identical contexts for every other track.
        const ungrounded = buildCase(domain, { grounded: false });
        assert.equal(ungrounded.plan.root.promptMode, 'artifact-repair-only-v6', `${domain.domain}: an ungrounded accessor mints v6`);
        const left = scopesOf(kase); const right = scopesOf(ungrounded);
        left.forEach((scope, index) => {
          const same = scope.scope.contextDigest === right[index].scope.contextDigest;
          assert.equal(same, !LETTER_TRACKS.includes(scope.scope.track), `${domain.domain}/${scope.scope.track}: only the letter-reading contexts differ`);
        });
      }
    },
  },
  {
    name: 'letter grounding mutations: removing or changing the projected need or quote changes the reviewer context, the scope digests, the source descriptor and the plan, for exactly the letter-reading scopes (4 domains)',
    run() {
      for (const domain of DOMAINS) {
        const base = buildCase(domain); const baseScopes = scopesOf(base);
        const variants = {
          'need removed': { mutateGrounding: rows => rows.map((row, index) => (index === 0 ? { ...row, jobNeedQuote: null } : row)) },
          'another need': { mutateGrounding: rows => rows.map((row, index) => (index === 0 ? { ...row, jobNeedQuote: domain.needB } : row)) },
          'a paragraph dropped': { mutateGrounding: rows => rows.slice(1) },
          'a citation dropped': { mutateGrounding: rows => rows.map((row, index) => (index === 1 ? { ...row, citedEvidenceIds: row.citedEvidenceIds.slice(0, 1) } : row)) },
          'cited quote text changed': { state: stateFor(domain, { careerA: `${domain.careerA} It ran on a fixed weekly schedule.` }) },
        };
        for (const [name, options] of Object.entries(variants)) {
          const mutated = buildCase(domain, options); const mutatedScopes = scopesOf(mutated);
          assert.notEqual(mutated.accessor.descriptor.digest, base.accessor.descriptor.digest, `${domain.domain}/${name}: the source descriptor moves`);
          assert.notEqual(mutated.plan.digest, base.plan.digest, `${domain.domain}/${name}: the plan moves`);
          baseScopes.forEach((scope, index) => {
            const track = scope.scope.track; const letterReader = LETTER_TRACKS.includes(track);
            if (name === 'cited quote text changed') {
              // The quote is also the fact track's evidence, so more than the letter readers move; the letter readers must.
              if (letterReader) assert.notEqual(scope.scope.contextDigest, mutatedScopes[index].scope.contextDigest, `${domain.domain}/${name}/${track}: the reviewer context changes`);
              return;
            }
            assert.equal(scope.scope.contextDigest === mutatedScopes[index].scope.contextDigest, !letterReader, `${domain.domain}/${name}/${track}: the reviewer context changes for exactly the letter-reading scopes`);
            assert.equal(scope.scope.digest === mutatedScopes[index].scope.digest, !letterReader, `${domain.domain}/${name}/${track}: the signed scope digest moves with the context`);
          });
        }
        // The same inputs rebuilt (a restart) reproduce every digest: the projection is a pure function of the host-owned inputs.
        const again = buildCase(domain);
        assert.equal(again.accessor.descriptor.digest, base.accessor.descriptor.digest);
        assert.equal(again.plan.digest, base.plan.digest);
        assert.deepEqual(scopesOf(again).map(row => row.scope.contextDigest), baseScopes.map(row => row.scope.contextDigest));
        // The grounding is a function of the persisted need record and the claims, never of the audit as it reads later: an audit corrupted after planning moves nothing.
        const corrupted = { ...base.state, finalReview: { generationAudit: { coverLetterPlan: { paragraphs: [] } } } };
        assert.deepEqual(__blindReviewLetterGroundingForTests(corrupted, base.fact.factClaims, base.needQuotes), base.letterGrounding, `${domain.domain}: rebuilding from the persisted record ignores a later audit`);
        // A stale accessor (the need removed) is refused by the plan that bound the original.
        const stale = buildCase(domain, variants['need removed']);
        assert.throws(() => nextApplicationBlindReviewWork(base.plan, [], { scopeOrdinal: 2, sourceAccessor: stale.accessor }), /does not match this immutable review plan/u, `${domain.domain}: a plan refuses an accessor that projects other grounding`);
      }
    },
  },
  {
    name: 'letter grounding pages: a paragraph lies on every letter page it touches, and a pair scope carries the grounding of the letter page it pairs (3 shapes)',
    run() {
      // Three 4,000-byte paragraphs: the third straddles the first page boundary (8,704 bytes).
      const three = directCase({ paragraphCount: 3, paragraphChars: 4_000, quoteChars: 100, needChars: 60, claimParagraphs: false });
      assert(three.plan.root.sources.documents.coverLetter.pageCount === 2, 'the letter spans two pages');
      const byTrack = track => scopesOf(three).filter(row => row.scope.track === track);
      const beginsOf = context => context.letterGrounding.paragraphs.map(entry => entry.begins);
      const first = byTrack('letter-argument-editorial');
      assert.equal(first.length, 2);
      assert.deepEqual(beginsOf(first[0].context), three.paragraphs.map(paragraph => begins(paragraph.text)), 'page 0 holds paragraphs 0 and 1 and the start of 2');
      assert.deepEqual(beginsOf(first[1].context), [begins(three.paragraphs[2].text)], 'page 1 holds the rest of paragraph 2 only');
      // Pair scopes: ordinal i pairs the résumé page min(i, last) with letter page min(i, last).
      for (const track of PAIR_TRACKS) {
        const pairs = byTrack(track);
        assert.equal(pairs.length, 2, `${track}: one pair per page of the longer document`);
        assert.deepEqual(beginsOf(pairs[0].context), three.paragraphs.map(paragraph => begins(paragraph.text)));
        assert.deepEqual(beginsOf(pairs[1].context), [begins(three.paragraphs[2].text)], `${track}: the second pair follows the second letter page`);
      }
      // A single page: every paragraph; identical paragraph texts map to successive occurrences, in order.
      const same = directCase({ paragraphCount: 3, paragraphChars: 200, duplicateParagraphs: true, claimParagraphs: false });
      assert.equal(same.plan.root.sources.letterGrounding.paragraphCount, 3);
      const sameContext = scopesOf(same).find(row => row.scope.track === 'letter-argument-editorial').context;
      assert.equal(sameContext.letterGrounding.paragraphs.length, 3, 'three identical paragraphs are three records');
      // A letter whose body has no paragraph rows: an empty, complete grounding (and still a v7 plan).
      const none = directCase({ paragraphCount: 0, claimParagraphs: false });
      assert.equal(none.plan.root.promptMode, 'artifact-repair-only-v7');
      assert.deepEqual(scopesOf(none).find(row => row.scope.track === 'letter-argument-editorial').context.letterGrounding, { paragraphs: [] });
      // A row that is not a line of the projected letter, or out of order, is refused when the accessor is built.
      assert.throws(() => createApplicationBlindReviewSourceAccessor({
        resume: 'Experience', coverLetter: 'Body\nOne.\nTwo.', citedEvidencePages: [{ id: 'e1', text: 'quote text' }],
        tailoringPages: [{ id: 'r', requirements: [], dispositions: [] }], factClaims: [{ id: 'c', document: 'resume', pageIndex: 0, text: 'Experience', citedEvidenceIds: ['e1'] }],
        letterGrounding: [{ text: 'Two.', jobNeedQuote: null, citedEvidenceIds: ['e1'] }, { text: 'One.', jobNeedQuote: null, citedEvidenceIds: ['e1'] }],
      }), /not a line of the host-projected letter, in order/u);
    },
  },
  {
    name: 'letter grounding bytes: with real worst-case contexts every scope stays inside the context ceilings and the signed prompt limit, a continuation page and the longest finding ids included',
    run() {
      const spare = 40;
      // A: realistic documents (a one-page résumé and letter, five paragraphs with typical quotes): grounded in FULL, nothing cut.
      const realistic = directCase({ paragraphCount: 5, paragraphChars: 520, quoteChars: 380, needChars: 140, citesPerParagraph: 2, resumeFill: 3_000 });
      for (const row of measureLetterScopes(realistic)) {
        assert.equal(row.grounding.incomplete, undefined, `realistic/${row.track}: nothing was left out`);
        assert.equal(row.grounding.paragraphs.length, 5, `realistic/${row.track}: all five paragraphs`);
        assert(row.grounding.paragraphs.every(entry => entry.jobNeedQuote.length === 140 && entry.citedCareerQuotes.length === 2 && entry.citedCareerQuotes.every(quote => quote.text.length === 380)), `realistic/${row.track}: the full needs and quotes`);
        assert(row.contextBytes <= APPLICATION_BLIND_REVIEW_MAX_CONTEXT_BYTES && row.promptBytes + spare <= PLAN_PROMPT_BYTE_LIMIT, `realistic/${row.track}: inside the ceilings (${row.contextBytes}, ${row.promptBytes})`);
      }
      // B: a full letter page with the largest legal grounding (seven paragraphs, four long quotes each, long needs).
      const fullLetter = directCase({ paragraphCount: 7, paragraphChars: 1_150, quoteChars: 900, needChars: 1_500, citesPerParagraph: 4, letterFill: 4_000 });
      assert(fullLetter.plan.root.sources.documents.coverLetter.pageCount >= 2, 'the letter fills its first page');
      const letterRows = measureLetterScopes(fullLetter).filter(row => row.track === 'letter-argument-editorial');
      assert(letterRows.length >= 2);
      for (const row of letterRows) {
        assert(row.contextBytes <= APPLICATION_BLIND_REVIEW_MAX_CONTEXT_BYTES, `letter page ${row.ordinal}: context ${row.contextBytes} inside the generic cap`);
        assert(row.groundingBytes <= APPLICATION_BLIND_REVIEW_LETTER_GROUNDING_MAX_BYTES, `letter page ${row.ordinal}: grounding ${row.groundingBytes} inside its bound`);
        assert(row.promptBytes + spare <= PLAN_PROMPT_BYTE_LIMIT, `letter page ${row.ordinal}: prompt ${row.promptBytes} inside the signed limit`);
      }
      const dense = letterRows[0].grounding;
      assert.equal(dense.incomplete, true, 'seven long paragraphs cannot all fit their bound, so the projection says it is incomplete');
      assert(dense.paragraphs.length >= 1 && dense.paragraphs.every(entry => entry.begins), 'what is kept is a leading run of paragraphs');
      // C: both documents on full pages (the tightest scopes): the context ceiling for a pair holds, the grounding degrades to what fits, and the prompt still fits.
      const fullPages = directCase({ paragraphCount: 7, paragraphChars: 1_150, quoteChars: 900, needChars: 1_500, citesPerParagraph: 4, letterFill: 9_000, resumeFill: 20_000 });
      for (const row of measureLetterScopes(fullPages)) {
        assert(row.contextBytes <= APPLICATION_BLIND_REVIEW_MAX_CONTEXT_BYTES, `full pages/${row.track}: context ${row.contextBytes} inside the generic cap`);
        assert(row.promptBytes + spare <= PLAN_PROMPT_BYTE_LIMIT, `full pages/${row.track}#${row.ordinal}: prompt ${row.promptBytes} leaves ${PLAN_PROMPT_BYTE_LIMIT - row.promptBytes} under ${PLAN_PROMPT_BYTE_LIMIT}`);
        if (PAIR_TRACKS.includes(row.track)) {
          assert(row.contextBytes <= APPLICATION_BLIND_REVIEW_MAX_PAIR_CONTEXT_BYTES, `full pages/${row.track}#${row.ordinal}: pair context ${row.contextBytes} inside the pair ceiling ${APPLICATION_BLIND_REVIEW_MAX_PAIR_CONTEXT_BYTES}`);
        }
        assert(row.grounding.incomplete === true || row.grounding.paragraphs.length === 0, `full pages/${row.track}: whatever does not fit is marked incomplete`);
      }
      const fullPairs = measureLetterScopes(fullPages).filter(row => PAIR_TRACKS.includes(row.track));
      assert(Math.max(...fullPairs.map(row => row.baseBytes)) > 17_400, 'the first pair really is the artificial worst case: both pages full');
      // D: the room a pair scope leaves for the grounding is exactly what its ceiling allows, never more, across document sizes.
      for (const resumeFill of [0, 2_000, 5_000, 8_000, 12_000, 20_000]) for (const letterFill of [0, 2_500, 5_000, 9_000]) {
        const kase = directCase({ paragraphCount: 4, paragraphChars: 700, quoteChars: 700, needChars: 400, citesPerParagraph: 3, resumeFill, letterFill });
        for (const row of measureLetterScopes(kase)) {
          const ceiling = PAIR_TRACKS.includes(row.track) ? APPLICATION_BLIND_REVIEW_MAX_PAIR_CONTEXT_BYTES : APPLICATION_BLIND_REVIEW_MAX_CONTEXT_BYTES;
          assert(row.contextBytes <= ceiling, `resume ${resumeFill} / letter ${letterFill} / ${row.track}#${row.ordinal}: ${row.contextBytes} <= ${ceiling}`);
          assert(row.promptBytes + spare <= PLAN_PROMPT_BYTE_LIMIT, `resume ${resumeFill} / letter ${letterFill} / ${row.track}#${row.ordinal}: prompt ${row.promptBytes}`);
          assert(row.groundingBytes <= APPLICATION_BLIND_REVIEW_LETTER_GROUNDING_MAX_BYTES, 'the grounding bound holds');
        }
      }
      // E: the non-context prompt of the tightest scope still leaves its ceiling room under the signed limit (so a longer clause fails here, not at a user's desk).
      const tight = measureLetterScopes(fullPages).filter(row => PAIR_TRACKS.includes(row.track)).map(row => row.promptBytes - row.contextBytes);
      const nonContext = Math.max(...tight);
      assert(nonContext + APPLICATION_BLIND_REVIEW_MAX_PAIR_CONTEXT_BYTES + spare <= PLAN_PROMPT_BYTE_LIMIT,
        `the pair ceiling ${APPLICATION_BLIND_REVIEW_MAX_PAIR_CONTEXT_BYTES} plus the worst non-context prompt ${nonContext} fits ${PLAN_PROMPT_BYTE_LIMIT} with ${spare} spare`);
      // The smallest projection (an empty, incomplete envelope) always fits beside two full pages.
      const minimalEnvelope = escapedBytes({ letterGrounding: { paragraphs: [], incomplete: true } }) - 2;
      assert(2 * 8_704 + 30 + minimalEnvelope + 1 <= APPLICATION_BLIND_REVIEW_MAX_PAIR_CONTEXT_BYTES, 'two full pages plus the smallest envelope fit the pair ceiling');
    },
  },
  {
    name: 'letter grounding fit: deterministic, monotone in its room, keeps a leading run of whole paragraphs, marks every shortening, and never cuts inside a character',
    run() {
      const fit = __applicationBlindReviewFitLetterGroundingForTests; const cut = __applicationBlindReviewCutGroundingTextForTests;
      const records = Array.from({ length: 6 }, (_unused, index) => ({
        begins: `paragraph ${index} opening words`, need: filler(`need ${index}`, 1_200),
        quotes: [0, 1, 2].map(cite => ({ id: `cq-${index}-${cite}`, text: filler(`quote ${index}-${cite}`, 800) })),
      }));
      const bytesOf = value => escapedBytes(value);
      let previousBytes = -1;
      const fullBound = fit(records, 1_000_000);
      for (let allowed = 0; allowed <= 12_000; allowed += 53) {
        const result = fit(records, allowed);
        assert.deepEqual(result, fit(records, allowed), `deterministic at ${allowed}`);
        const bytes = bytesOf(result);
        assert(bytes <= Math.max(allowed, bytesOf({ paragraphs: [], incomplete: true })), `${allowed}: ${bytes} bytes fit the room (or are the smallest envelope)`);
        assert(bytes >= previousBytes, `${allowed}: more room never yields less (${previousBytes} -> ${bytes})`);
        // A kept paragraph is a leading run of the page's, in order.
        assert.deepEqual(result.paragraphs.map(entry => entry.begins), records.slice(0, result.paragraphs.length).map(record => record.begins), `${allowed}: a leading run of whole paragraphs`);
        // The full bound (needs to 1,000 characters, quotes to 600) is the only projection that is not marked incomplete; anything shorter is.
        assert.equal(result.incomplete === true, JSON.stringify(result) !== JSON.stringify(fullBound), `${allowed}: incomplete exactly when shorter than the full bound`);
        previousBytes = bytes;
      }
      assert(fullBound.incomplete === undefined && fullBound.paragraphs.length === records.length, 'with room to spare the full bound is projected and not marked incomplete');
      const full = fullBound;
      assert(full.paragraphs.every(entry => entry.jobNeedQuote.length <= 1_001 && entry.citedCareerQuotes.every(quote => quote.text.length <= 601)), 'the full bound still caps a need at 1,000 characters and a quote at 600 (plus the ellipsis)');
      // Empty page: complete and empty; no room at all: the smallest incomplete envelope.
      assert.deepEqual(fit([], 0), { paragraphs: [] });
      assert.deepEqual(fit(records, 0), { paragraphs: [], incomplete: true });
      // The cut: whole text under the cap is untouched; over it ends in an ellipsis, on a word boundary when one is near the end, never inside a surrogate pair.
      assert.equal(cut('short text', 50), 'short text');
      const long = filler('word', 500); const cutLong = cut(long, 100);
      assert(cutLong.endsWith('…') && Array.from(cutLong).length <= 101 && long.startsWith(cutLong.slice(0, -1).trimEnd()), 'an over-long text ends in an ellipsis and is a prefix');
      assert(!/\s…$/u.test(cutLong) && /[a-z0-9]…$/u.test(cutLong), 'the cut does not leave trailing space');
      const astral = `${'a'.repeat(98)}😀😀😀😀`;
      const cutAstral = cut(astral, 99);
      assert(Array.from(cutAstral).every(character => character === '…' || character === 'a' || character === '😀') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(cutAstral), 'no lone surrogate is produced');
      assert.equal(Array.from(cut('日本語のテキスト'.repeat(40), 30)).length, 31, 'multi-byte characters are counted as characters');
    },
  },
  {
    name: 'letter conventions v7: the clause says what the grounding is, waives nothing, holds nothing about any document, is built from the letter checks\' own phrases, and is signed with its tracks and the grounding bounds',
    run() {
      const clause = APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS;
      // It keeps what v6 said (the wording was tightened to fit the signed prompt envelope; the meaning is the same) ...
      for (const part of ['one phrase naming the capability its proof shows', 'one sentence relating that proof to the job need', 'so carrying them is no defect',
        'claims more than its paragraph’s own proof supports', 'restates the proof without adding information', 'only echoes the posting’s vocabulary', 'report any other defect in it as in any sentence',
        'This waives nothing: every finding still needs a correction.']) {
        assert(clause.includes(part), `v7 keeps: ${part}`);
      }
      // ... says what a legal correction of each required function is (gapfix-v16c-letter-binding proves it against the host) ...
      for (const part of ['reword, shorten or merge into the proof sentence the claim phrase', 'reword or shorten the relevance sentence, kept apart from the proof', 'never delete the only span doing a required function']) {
        assert(clause.includes(part), `v7 states the correction: ${part}`);
      }
      assert(!clause.includes('merge it into the proof sentence or shorten it'), 'and no longer offers a merge for the relevance sentence');
      // ... and says what the new context is and what it does and does not decide.
      for (const part of ['context.letterGrounding is host-projected', 'its first words (begins)', 'the posting span the writer bound it to (jobNeedQuote: posting text, not proof)', 'the career quotes it cites (citedCareerQuotes',
        'incomplete:true means items were left out; absence proves nothing', 'A sentence grounded in a cited career quote is no abstraction or cross-document defect merely for being general',
        'one adding nothing to the cited quotes, or echoing the jobNeedQuote about the candidate, is reportable']) {
        assert(clause.includes(part), `v7 says: ${part}`);
      }
      // It exempts nothing: the denylist (the same one the v6 clause is held to) finds no waiver, and is not vacuous.
      const waivers = /\b(?:ignore|skip|exempt|exempts|pass)\b|(?:do not|never|must not|need not|no need to) (?:report|flag)|(?:not|never) a (?:finding|reason to report)/iu;
      assert(!waivers.test(clause), 'no instruction to skip a defect class or waive a finding');
      for (const waiving of [`${clause} Pass such a sentence.`, `${clause} Ignore the grounding.`, clause.replace('is reportable', 'is not a finding'), `${clause} You need not flag it.`]) assert(waivers.test(waiving), `the denylist catches: ${waiving.slice(-40)}`);
      // The relief it gives is narrow: a general sentence is only excused for GENERALITY, and only when grounded; every other defect stays reportable.
      assert(clause.indexOf('merely for being general') > clause.indexOf('A sentence grounded in a cited career quote') && !/any sentence that is general/u.test(clause));
      // Short, generic, number-free, and carrying no word of any synthetic document.
      assert(Buffer.byteLength(clause, 'utf8') <= 1_300, `the clause is short (${Buffer.byteLength(clause, 'utf8')} bytes)`);
      assert(!/\d/u.test(clause), 'no figure');
      for (const domain of DOMAINS) {
        // No employer, title or person of the set, and no three-word run of any of its texts, occurs in the clause.
        const lowered = clause.toLowerCase();
        for (const name of [domain.person, domain.employer, domain.title, domain.listingCompany, domain.listingTitle]) assert(!lowered.includes(name.toLowerCase()), `${domain.domain}: the clause names no ${name}`);
        for (const source of [domain.careerA, domain.careerB, domain.bullet, domain.posting, ...domain.paragraphs]) {
          const tokens = source.toLowerCase().match(/[a-z0-9']+/gu);
          for (let index = 0; index + 3 <= tokens.length; index += 1) assert(!lowered.includes(tokens.slice(index, index + 3).join(' ')), `${domain.domain}: the clause holds no run of this document set (${tokens.slice(index, index + 3).join(' ')})`);
        }
      }
      // Built from the letter checks' own phrases for the paragraph that owes the sentence; a different budget moves the text and the digest.
      const owingProof = coverLetterChecks.OWING_PROOF_PARAGRAPHS; const owingClaim = coverLetterChecks.OWING_CLAIM_PARAGRAPHS ?? owingProof;
      assert.equal(clause, buildApplicationBlindReviewLetterConventions({ claimParagraphs: owingClaim, proofParagraphs: owingProof }));
      const two = 'each of the first 2 proof-bearing paragraphs of the letter';
      const widened = buildApplicationBlindReviewLetterConventions({ claimParagraphs: two, proofParagraphs: two });
      assert(widened.includes(two) && widened.includes('context.letterGrounding') && widened !== clause, 'a wider budget is worded into the clause, grounding text and all');
      // v6 is frozen as a literal. v7 states the same requirement and then differs from it on purpose (gapfix-v16c-letter-binding): it says what a legal correction
      // of each required function is (v6 offered a merge for both, which the host refuses for the relevance sentence), it adds the grounding sentences, and its
      // wording was tightened to fit the signed prompt envelope.
      assert.equal(authorityDigest(APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS_V6), 'dc0cc92bccecd30c288f3eab57e1cbb718daf4295f6ee188bf14438ea2a16a58');
      assert(!APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS_V6.includes('letterGrounding'));
      const requirementOf = value => value.slice(0, value.indexOf(', so carrying them'));
      assert.equal(requirementOf(clause), requirementOf(APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS_V6), 'v7 states the same requirement as v6');
      assert(clause !== APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS_V6 && !clause.includes('merge it into the proof sentence or shorten it')
        && APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS_V6.includes('merge it into the proof sentence or shorten it'), 'v7 deliberately differs from v6 in what a correction may do');
      // The conventions helper per mode.
      assert.deepEqual(applicationBlindReviewConventionsFor('artifact-repair-only-v7', 'bundle-editorial'), [APPLICATION_BLIND_REVIEW_HOST_CONVENTIONS, APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS]);
      assert.deepEqual(applicationBlindReviewConventionsFor('artifact-repair-only-v6', 'bundle-editorial'), [APPLICATION_BLIND_REVIEW_HOST_CONVENTIONS, APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS_V6]);
      assert.deepEqual(applicationBlindReviewConventionsFor('artifact-repair-only-v7', 'fact-fidelity'), [APPLICATION_BLIND_REVIEW_HOST_CONVENTIONS]);
      assert.deepEqual(applicationBlindReviewConventionsFor('artifact-repair-only-v5', 'letter-argument-editorial'), [APPLICATION_BLIND_REVIEW_HOST_CONVENTIONS]);
      assert.deepEqual(applicationBlindReviewConventionsFor('artifact-repair-only-v4', 'letter-argument-editorial'), []);
      // Signed: the policy carries the clause digest (with its tracks) and a digest of the grounding context key and every bound.
      const plan = buildCase(DOMAINS[0]).plan; const policy = __applicationBlindReviewPolicyForTests(plan.root);
      assert.equal(policy.letterConventionsDigest, authorityDigest({ tracks: APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS_TRACKS, clause }));
      const signedGrounding = authorityDigest({ tracks: APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS_TRACKS, context: 'letter-paragraph-grounding', key: 'letterGrounding', limits: APPLICATION_BLIND_REVIEW_LETTER_GROUNDING_LIMITS });
      assert.equal(policy.letterGroundingDigest, signedGrounding, 'the v7 policy signs the grounding bounds');
      assert.equal(applicationBlindReviewPolicyCatalogue().modes['artifact-repair-only-v7'].letterGroundingDigest, signedGrounding);
      for (const key of Object.keys(APPLICATION_BLIND_REVIEW_LETTER_GROUNDING_LIMITS).filter(name => typeof APPLICATION_BLIND_REVIEW_LETTER_GROUNDING_LIMITS[name] === 'number')) {
        const moved = { ...APPLICATION_BLIND_REVIEW_LETTER_GROUNDING_LIMITS, [key]: APPLICATION_BLIND_REVIEW_LETTER_GROUNDING_LIMITS[key] + 1 };
        assert.notEqual(authorityDigest({ tracks: APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS_TRACKS, context: 'letter-paragraph-grounding', key: 'letterGrounding', limits: moved }), signedGrounding, `changing ${key} changes what v7 signs`);
      }
      assert.deepEqual(APPLICATION_BLIND_REVIEW_LETTER_GROUNDING_LIMITS.ladder[0], { need: APPLICATION_BLIND_REVIEW_LETTER_NEED_QUOTE_MAX_CHARS, quote: APPLICATION_BLIND_REVIEW_LETTER_CITED_QUOTE_MAX_CHARS, incomplete: false }, 'the first rung is the full bound and is the only complete one');
      assert(APPLICATION_BLIND_REVIEW_LETTER_GROUNDING_LIMITS.ladder.slice(1).every(rung => rung.incomplete === true), 'every shorter rung is marked incomplete');
    },
  },
  {
    name: 'prompt modes: v7 is bound to its grounding, and v6 (minted by the build before this one) and v5 still reconstruct, verify and print their original prompts byte for byte',
    run() {
      const kase = buildCase(DOMAINS[0]); const { plan } = kase;
      // A v7 root signs grounding; a root and its sources must agree.
      assertApplicationBlindReviewPlan(plan);
      const asV6 = relabel(plan, root => { root.promptMode = 'artifact-repair-only-v6'; return root; });
      assert.throws(() => assertApplicationBlindReviewPlan(asV6), /letter grounding does not match its prompt mode/u, 'a v7 root cannot be passed off as v6');
      const withoutGrounding = relabel(plan, root => { delete root.sources.letterGrounding; root.sources = resign(root.sources); root.sourceDigest = root.sources.digest; return root; });
      assert.throws(() => assertApplicationBlindReviewPlan(withoutGrounding), /letter grounding does not match its prompt mode|policy digest is stale|track counts or source bindings are stale/u, 'a v7 root whose grounding was stripped is refused');
      // A v6 plan from an ungrounded accessor cannot be relabelled v7 (its policy and sources disagree).
      const ungrounded = buildCase(DOMAINS[1], { grounded: false });
      const asV7 = relabel(ungrounded.plan, root => { root.promptMode = 'artifact-repair-only-v7'; return root; });
      assert.throws(() => assertApplicationBlindReviewPlan(asV7), /letter grounding does not match its prompt mode/u, 'a v6 root cannot be passed off as v7');
      // A v7 root that keeps its sources but is relabelled v5 or v6 fails on policy as well.
      assert.throws(() => assertApplicationBlindReviewPlan(relabel(plan, root => { root.promptMode = 'artifact-repair-only-v5'; return root; })), /letter grounding does not match its prompt mode/u);
      // The v6 plan this build mints from an ungrounded accessor prints the frozen v6 clause and no grounding.
      const letterOrdinal = scopesOf(ungrounded).find(row => row.scope.track === 'letter-argument-editorial').ordinal;
      const v6Prompt = promptAt(ungrounded.plan, ungrounded.accessor, letterOrdinal);
      assert.equal(trackOf(v6Prompt), 'letter-argument-editorial');
      assert(v6Prompt.includes(APPLICATION_BLIND_REVIEW_LETTER_CONVENTIONS_V6) && !v6Prompt.includes('context.letterGrounding') && !v6Prompt.includes('"letterGrounding"'), 'a v6 prompt is the v6 prompt');
      assert.equal(APPLICATION_BLIND_REVIEW_UNGROUNDED_PROMPT_MODE, 'artifact-repair-only-v6');
      // The pre-change build's v6 root (signed by the build that introduced the letter clause) still verifies and prints every prompt it ever printed.
      const { plan: historical, promptSha256 } = HISTORICAL_V6;
      assert.equal(historical.root.promptMode, 'artifact-repair-only-v6');
      assertApplicationBlindReviewPlan(historical);
      assert.equal(__applicationBlindReviewPolicyForTests(historical.root).digest, historical.root.policyDigest, 'the v6 policy is reconstructed to the digest the root signed');
      assert.equal(__applicationBlindReviewPolicyForTests(historical.root).letterGroundingDigest, undefined, 'v6 never signed letter grounding');
      const resume = 'Experience\nSupport Lead at Cobalt Clinics\nCoordinated weekly supply restocking for twelve clinics.';
      const coverLetter = 'Body\nI coordinated supply restocking for twelve clinics and kept every site stocked.';
      const quote = 'Coordinated weekly supply restocking for twelve clinics.';
      const accessor = createApplicationBlindReviewSourceAccessor({
        resume, coverLetter, citedEvidencePages: [{ id: 'evidence-1', text: quote }],
        tailoringPages: [{ id: 'requirements-1', requirements: [{ id: 'requirement-1', text: 'Supply coordination.', priority: 'highest' }],
          dispositions: [{ requirementId: 'requirement-1', disposition: 'addressed-resume', justification: 'The résumé addresses it.', proofs: [{ document: 'resume', documentDigest: authorityDigest(resume), offset: resume.indexOf('Coordinated'), quote }] }] }],
        factClaims: [{ id: 'resume-role-r1-b1', document: 'resume', pageIndex: 0, text: quote, citedEvidenceIds: ['evidence-1'] }],
      });
      assert.equal(historical.root.sourceDigest, accessor.descriptor.digest, 'the historical sources are rebuilt exactly (no grounding is added to them)');
      for (let ordinal = 0; ordinal < historical.root.scopeCount; ordinal += 1) {
        assert.equal(sha256(promptAt(historical, accessor, ordinal)), promptSha256[ordinal], `scope ${ordinal} prints exactly what the v6 build printed`);
      }
      // The catalogue still records v6 and v7 separately, and v7 alone signs the grounding.
      const modes = applicationBlindReviewPolicyCatalogue().modes;
      assert.equal(modes['artifact-repair-only-v6'].letterGroundingDigest, undefined);
      assert.notEqual(modes['artifact-repair-only-v6'].allowedContextDigest, modes['artifact-repair-only-v7'].allowedContextDigest, 'v7 signs a different allowed context');
      assert.notEqual(modes['artifact-repair-only-v6'].letterConventionsDigest, modes['artifact-repair-only-v7'].letterConventionsDigest, 'v7 signs the extended clause');
      assert.equal(modes['artifact-repair-only-v6'].reviewerBriefDigest, modes['artifact-repair-only-v7'].reviewerBriefDigest, 'the briefs are unchanged');
    },
  },
  {
    name: 'letter grounding review: a finding on a grounded scope is an ordinary blocking finding with a repair packet, and nothing is waived (4 domains, A / B)',
    run() {
      for (const domain of DOMAINS) {
        const kase = buildCase(domain); const { plan, accessor } = kase;
        const run = findingTrack => {
          let receipts = [];
          for (let ordinal = 0; ordinal < plan.root.scopeCount; ordinal += 1) {
            const work = nextApplicationBlindReviewWork(plan, receipts, { scopeOrdinal: ordinal, sourceAccessor: accessor });
            const { scope } = applicationBlindReviewScopeAt(plan, ordinal, { sourceAccessor: accessor });
            const flagged = scope.track === findingTrack;
            const document = flagged ? (scope.track === 'letter-argument-editorial' ? 'cover-letter' : 'bundle') : 'resume';
            receipts = acceptApplicationBlindReviewResponse({ plan, receipts, work, sourceAccessor: accessor, response: {
              version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, scopeDigest: work.scopeDigest, pageIndex: work.pageIndex, previousPageDigest: work.previousPageDigest,
              complete: true, decision: flagged ? 'issues' : 'pass',
              findings: flagged ? [{ id: `${ordinal}-0-1`, ruleId: 'editorial-echo', document, targetId: 'paragraph-1',
                issue: 'The relating sentence adds nothing beyond its jobNeedQuote.', fix: 'Reword it to say what the cited work changed, using only the cited quote.' }] : [],
            } });
          }
          return { receipts, ...validateApplicationBlindReviewReceipts(plan, receipts, { sourceAccessor: accessor }) };
        };
        for (const track of LETTER_TRACKS) {
          const flagged = run(track);
          assert.equal(flagged.coverage.clean, false, `${domain.domain}/${track}: not clean`);
          assert.equal(flagged.aggregate.findingCount, 1, `${domain.domain}/${track}: counted`);
          const packets = createApplicationBlindRepairPackets(plan, flagged.receipts, { sourceAccessor: accessor });
          assert.equal(packets.packetCount, 1, `${domain.domain}/${track}: has a repair packet`);
          assert.equal(packets.packets[0].track, track);
        }
        assert.equal(run('no-such-track').coverage.clean, true, `${domain.domain}: without the finding the review is clean`);
      }
    },
  },
];
