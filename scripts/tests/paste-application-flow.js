import { assert,      PDFDocument} from '../test-dependencies.js';
import { APPLICATION_QUALITY_CHECKLIST_VERSION, APPLICATION_QUALITY_CRITERIA, ARGUMENT_EVIDENCE_REBIND_RULE, ARGUMENT_JOB_NEED_QUOTE_RULE, COVER_LETTER_SECONDARY_NARRATIVE_ROLES, PASTE_EVIDENCE_PRIORITIES, PASTE_FINDING_DOCUMENTS, COVER_LETTER_ARGUMENT_TEXT_LIMITS, GENERATION_AUDIT_TEXT_MINIMUMS, QUALITY_NOTE_MIN_CHARS, QUALITY_NOTE_MIN_WORDS, QUALITY_NOTE_RULE, EVIDENCE_PLAN_CRITERION_IDS, LOCAL_AI_GENERATION_AUDIT_VERSION, MAX_COVER_LETTER_PARAGRAPH_EVIDENCE_IDS, MAX_EVIDENCE_PLAN_EVIDENCE_ITEMS, MAX_EVIDENCE_PLAN_REQUIREMENT_ITEMS, MAX_SOURCE_GROUNDING_QUOTE_CHARS, MIN_SHARED_SOURCE_TERMS, MIN_SOURCE_GROUNDING_QUOTE_CHARS, MIN_SOURCE_GROUNDING_QUOTE_WORDS, PASTE_BASE_HASH_KEYS, PASTE_CHECK_PROSE_UNITS, PASTE_STABLE_ID_PATTERN, pasteRejectionCheckIds, pasteReportableCheckIds, SOURCE_TERM_OVERLAP_RULE, __setLocalAiRenderPdfForTests} from '../../electron/ipc/localAiApplication.js';
import { EMPTY_JOB_LISTING_BODY_NOTE, ORIGINAL_JOB_LISTING_BODY_HEADING } from '../../electron/ipc/applicationBundle.js';
import { _resetPasteHandoffDiagnostics} from '../../electron/ipc/pasteHandoffDiagnostics.js';
import { CAREER_DATA_ROLE_SECTION_RULE, CAREER_TERM_OVERLAP_RULE, MIN_SHARED_CAREER_TERMS,   NEUTRAL_SKILL_GROUP_LABELS, NEUTRAL_SKILL_GROUP_RULE, POSTING_NAMED_SKILLS_RULE,  SKILL_ITEM_FILTERABLE_RULE, SKILL_ITEM_GROUNDING_RULE, SKILLS_BLOCK_BUDGET_RULE, SKILLS_BLOCK_PRESENCE_RULE, STRUCTURED_RESUME_ID_PATTERN, STRUCTURED_RESUME_LIMITS } from '../../electron/ipc/structuredResume.js';
import { ADJACENT_SENTENCE_SHAPE_RULE, LETTER_PROPORTION_RULE, MIN_STANDALONE_SENTENCE_PARAGRAPH_ALLOWANCE, ARGUMENT_CLAIM_SPAN_RULE, ARGUMENT_LATER_RELEVANCE_SPAN_RULE, EXPLICIT_CLAIM_BUDGET_RULE, EXPLICIT_RELEVANCE_BUDGET_RULE, EXPLICIT_TRANSFER_BUDGET_RULE, TRANSFER_BENEFIT_SUPPORT_RULE, ARGUMENT_MAPPING_REQUIRED_RULE, ARGUMENT_SPAN_ALIGNMENT_RULE, ARGUMENT_PROOF_SPAN_RULE, ARGUMENT_RELEVANCE_SPAN_RULE, COVER_LETTER_EQUIVALENCE_CARRIERS, COVER_LETTER_LOGISTICS_PROMISE_CLASSES, COVER_LETTER_SALIENT_ECHO_PHRASES, DURATION_CLAIM_SHAPE_RULE, MAX_LETTER_FIGURES, MAX_LETTER_OFF_POSTING_TOOLS, MAX_PARAGRAPH_OFF_POSTING_TOOLS, MAX_SENTENCE_WORDS, MIN_ANCHOR_RELEVANCE_CORPUS_WORDS, MIN_ROLE_THESIS_WORDS, MIN_SHARED_SHAPE_PARAGRAPHS, DANGLING_DEMONSTRATIVE_RULE, REPEATED_PHRASE_RULE, REPEATED_TRANSFER_CARRIER_RULE, SENTENCE_SHAPE_FRAME_WORDS, SHARED_SENTENCE_SHAPE_CEILING_RULE, PAST_PROOF_VERBS, REDUNDANCY_SHINGLE_WORDS } from '../../electron/ipc/coverLetterChecks.js';
import {  MAX_UNIT_CAREER_DATA_QUOTES } from '../../electron/ipc/pasteApplicationAssembly.js';
import {  RESUME_BULLET_CHARACTER_BUDGET } from '../../electron/ipc/jobApplication.js';



// The résumé puts these bullets beneath Analytical Engines, so the frozen
// legacy corpus needs a deterministic role boundary too.  A bare collection
// of achievements cannot safely inherit an employer merely because a fixture
// selected it for that role.

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


// Queues the 13-requirement job and hands back the primitives every flow on it
// needs: the live handoff, a raw submit that reports whatever the host decided,
// and an asserting submit for the steps a case is not varying. Cases that test
// a rejection use `submit`; cases that only need to reach a later stage use
// `send`.
const AUDIT_JOB = Object.freeze({ title: 'Engineer', company: 'Acme', snippet: AUDIT_LISTING });


// A 13-requirement paste job walked to its review stage, plus the passing
// review every surface test submits. Shared by the surface-boundary sweep
// below so all three surfaces grade the SAME package.

// Queues a job, walks it to the review stage, and hands back a review submitter
// so each case only varies the generationAudit it pastes.

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


// The invariant that makes the whole defect class impossible: the gate states
// the requirement and copies no career-data text, so nothing it says can be
// pasted into identity.credential, frozen into trustedIdentity, and rendered
// into the résumé header. Three consecutive words is short enough to catch a
// quoted degree or institution and long enough that ordinary English in the
// message cannot collide with the corpus by accident.

// Quoted spans are checked separately: the form template "<degree>,
// <institution>" is quoted on purpose, and it must not be career-data text.


// Drives the real paste submit path: queue a scratch job on the given career
// corpus, then submit one evidence plan per supplied credential against the
// same live handoff, stopping once one is accepted. `null` omits the field.

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

// Walks one job to the cover-letter stage over a corpus that quotes each
// paragraph the scenario will submit, so per-paragraph source grounding is
// never the variable a battery probe is measuring. The argument cites the
// first résumé bullet, which is what bounds the letter's figures.

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
      ];
