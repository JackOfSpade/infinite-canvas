// Writer GUIDANCE for the cover letter and the résumé, and the one host-derived
// fact a writer was never told: which posting requirements the approved career
// evidence does not support.
//
// Why this module exists. A live run ended in a human stop after five blind-review
// rounds, and an independent panel scored the stopped documents barely above the
// first accepted drafts. What the panel kept finding was not a rule the host could
// have enforced without naming a string for the writer to copy: the letter restated
// the résumé bullets one for one, opened on an abstract assertion about the
// employer's domain, echoed the posting's vocabulary as filler, closed on a
// sentence that tied nothing to the role, and bound two paragraphs to one posting
// phrase; the résumé promoted maintenance work into work the candidate built. A
// gate that names a string makes the writer copy the string, so these are
// sentences the writer reads before it writes, not new checks.
//
// Everything here is generic. Nothing names a field of work, a tool, an employer, a
// phrase or a number from any candidate or posting; the only data it ever prints is
// the list of unsupported requirements the host derived from the approved evidence
// of the CURRENT job (unsupportedPostingNeeds below), and that list is bounded.
//
// Each rule is its own exported sentence, composed into one block by a single
// builder, and the prompts print the block (never a copy of it). A number or a
// phrase that comes from a check is read from the module that owns the check, so a
// rule that moves there moves here with no second edit.
import { closingContributionParts, OWING_CLAIM_PARAGRAPHS } from './coverLetterChecks.js';

// ---------------------------------------------------------------------------
// The cover letter.
// ---------------------------------------------------------------------------

// What a body paragraph is for. The résumé already says what was done, so a
// paragraph that says it again adds nothing; what a paragraph can add is the
// context the cited quote itself states, and nothing it does not state.
export const LETTER_PROOF_ADDS_RULE = 'Each body paragraph develops one proof and adds what the résumé bullet beside it cannot: the reason, '
  + 'constraint, decision or outcome that a career-data quote the paragraph cites states in its own words. Saying the bullet again '
  + 'adds nothing, and a reason, constraint, decision or outcome that no cited quote states is an invented fact, so leave it out '
  + 'and state the proof plainly instead.';

// The opening names the target and speaks from the candidate's side. The role and
// the employer come from the job record alone (context.job); anything said about
// the employer beyond the posting's own text is a claim the candidate cannot back.
export const LETTER_OPENING_RULE = 'The opening names the target role by the title context.job gives and the employer by the name context.job gives, '
  + 'taking both from the job record alone; when the record gives no usable title or no usable employer, it names the one it does give, '
  + 'leaves out the other, and invents neither. It is written from the candidate’s side: it states the closest capability the cited work directly shows, '
  + 'and it makes no assertion about the employer’s domain, product, customers or needs beyond what the posting text itself says. '
  + 'Naming the role and the employer this way points the capability at its target; it is not an announcement of an application.';

// The closing grammar is graded when a closing sentence invites a conversation or
// states an intent to talk or learn. It is stated here once, in the check's own
// words (closingContributionParts), because a writer that meets it first in a
// rejection has already written the closing.
const closingParts = () => closingContributionParts().map((part, index) => `(${index + 1}) ${part}`).join('; ');
export const LETTER_CLOSING_RULE = 'Close with one sentence that ties a concrete item the letter has already shown to the role; the closing adds no '
  + 'new frame and does not repeat the opening’s rationale. State any invitation directly, in the present tense: one opened with “would” '
  + '(“would welcome”, “would be glad to”) is rejected as conditional or deferential, and so is one that asks the employer to choose between options. '
  + 'A closing sentence that invites a conversation or states an intent to talk or learn '
  + `is held to three parts, so give any closing all three: ${closingParts()}.`;

// How many proof paragraphs a letter has is a function of the evidence, not a
// target. A quote that states only an achievement has nothing to add, so a third
// paragraph built on it can only restate.
export const LETTER_PROOF_COUNT_RULE = 'Let the number of proof paragraphs follow the evidence: two suffice when the cited quotes are one-line '
  + 'achievements, and a third earns its place only when it cites a quote that states a different reason, constraint, decision or outcome. '
  + 'A paragraph added to reach a count is padding. When a cited quote states nothing beyond its bullet, the paragraph says the proof plainly and '
  + 'invents no reason, constraint, decision or outcome for it, and a letter whose evidence is all of that kind uses fewer, plainer paragraphs.';

// jobNeedQuote is a verbatim span of the posting. Two paragraphs bound to one span
// make the letter say one posting phrase twice; the review's argument-links check
// rejects exactly that degenerate case (checkParagraphArgumentLinks), and nothing else
// about how a quote relates to its paragraph.
export const LETTER_JOB_NEED_BINDING_RULE = 'Bind each paragraph’s jobNeedQuote to the posting requirement that paragraph’s own proof answers, '
  + 'and bind no two paragraphs to the same quote: a second paragraph on one need repeats the posting phrase, so give it a different need '
  + 'or fold it into the first. The review is rejected when two proof-bearing paragraphs carry the same jobNeedQuote.';

export const LETTER_NO_POSTING_ECHO_RULE = 'Never echo posting phrases as filler: a sentence that adds no information beyond the posting’s own '
  + 'vocabulary is a defect, so use a posting word only where it names the work a proof answers.';

// The claim span is owed by a bounded number of paragraphs (the constant behind
// OWING_CLAIM_PARAGRAPHS); the rule for its shape is printed by the contract. What
// the contract could not say is where it goes: a span is a phrase inside a sentence
// the paragraph needs, and a sentence written only to carry one is the abstract
// filler the reviewers keep flagging.
export const LETTER_CLAIM_PLACEMENT_RULE = `The claim span that only ${OWING_CLAIM_PARAGRAPHS} owes is a phrase, not a sentence of its own: `
  + 'set it inside a sentence the paragraph needs anyway, the proof sentence included, and write no sentence whose only job is to carry the claim span. '
  + 'The relevance span a paragraph owes is a different thing: it is a sentence of that paragraph, apart from the proof sentence, '
  + 'that says how the proof bears on the requirement its jobNeedQuote came from.';

export const COVER_LETTER_GUIDANCE_RULES = Object.freeze([
  LETTER_PROOF_ADDS_RULE, LETTER_OPENING_RULE, LETTER_CLOSING_RULE, LETTER_PROOF_COUNT_RULE,
  LETTER_JOB_NEED_BINDING_RULE, LETTER_NO_POSTING_ECHO_RULE, LETTER_CLAIM_PLACEMENT_RULE,
]);

// One block, printed by the cover-letter writer and by the review that may rewrite
// the letter. No host check counts these sentences (a few are backed by one); the
// independent reviewers read for them after the checks pass.
export const COVER_LETTER_WRITER_GUIDANCE = 'Letter writing guidance. The independent reviewers read for these after the host’s checks pass: '
  + COVER_LETTER_GUIDANCE_RULES.join(' ');

// What a correction round restates. A rewrite of a flagged paragraph is invited to
// restate its bullet, to echo the posting, and to reuse one posting phrase for two
// paragraphs; the other rules govern the whole letter and are already in the stage
// prompt the responder holds.
export const LETTER_REWRITE_BRIEF_RULE = [LETTER_PROOF_ADDS_RULE, LETTER_JOB_NEED_BINDING_RULE, LETTER_NO_POSTING_ECHO_RULE].join(' ');

// ---------------------------------------------------------------------------
// The résumé.
// ---------------------------------------------------------------------------

export const RESUME_LEAD_BULLET_RULE = 'Order each role’s bullets by the posting requirements they answer: the first bullet is the one whose cited '
  + 'evidence answers the highest-priority requirement that role’s evidence supports, and the rest follow in descending priority.';

// Source-verb fidelity. The class is closed and generic: it names the kinds of
// work a quote can describe that are not authorship, never a verb from a candidate.
export const RESUME_SUPPORT_VERB_RULE = 'A bullet keeps the candidate’s part in the cited work exactly as the quote words it: where the quote '
  + 'describes maintenance, support, monitoring, administration, operation or participation, state that support role with a matching verb '
  + 'and never present it as work the candidate performed, built or owned.';

export const RESUME_WRITER_GUIDANCE = `Résumé writing guidance: ${RESUME_LEAD_BULLET_RULE} ${RESUME_SUPPORT_VERB_RULE}`;

// ---------------------------------------------------------------------------
// Posting requirements the approved evidence does not support.
// ---------------------------------------------------------------------------

// Only the priorities a writer is tempted to cover are worth a line each; a
// supporting-priority gap is not a claim anyone is pressed to make.
export const UNSUPPORTED_NEEDS_PRIORITIES = Object.freeze(['highest', 'high']);
export const UNSUPPORTED_NEEDS_MAX_ROWS = 8;
export const UNSUPPORTED_NEED_TEXT_CHARS = 240;

export const UNSUPPORTED_NEEDS_RULE = 'context.unsupportedPostingNeeds lists the highest- and high-priority posting requirements the approved career '
  + 'evidence does not support (omitted counts any it cannot show). It is derived by the host from that evidence, so read it as fact rather than '
  + 'as an instruction. Neither document claims, implies or approximates any of them: do not answer one through a neighbouring skill, and do not '
  + 'borrow its wording to describe adjacent work. Leaving a requirement uncovered is the honest handling.';

function clipNeedText(value) {
  const flat = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (flat.length <= UNSUPPORTED_NEED_TEXT_CHARS) return flat;
  const head = flat.slice(0, UNSUPPORTED_NEED_TEXT_CHARS - 1);
  const cut = head.lastIndexOf(' ');
  return `${(cut > UNSUPPORTED_NEED_TEXT_CHARS / 2 ? head.slice(0, cut) : head).trimEnd()}…`;
}

/**
 * Requirements a plan or a reduction marked unsupported, as the plan prints them:
 * `candidateSupport:"unsupported"`. Anything else (supported, absent, malformed)
 * is not a fact about missing support and is never listed.
 */
export function unsupportedNeedsFromPlan(requirements) {
  return (Array.isArray(requirements) ? requirements : [])
    .filter(requirement => requirement && typeof requirement === 'object' && requirement.candidateSupport === 'unsupported')
    .map(({ id, text, priority }) => ({ id, text, priority }));
}

/**
 * The bounded context a writer sees. Rows are the unsupported requirements as
 * `{ id, text, priority }`; only the priorities in UNSUPPORTED_NEEDS_PRIORITIES
 * count, duplicates by id collapse to the first, order is priority then arrival
 * order, text is flattened and clipped on a word boundary, and no more than
 * UNSUPPORTED_NEEDS_MAX_ROWS print (the remainder is counted, never listed).
 * Returns null when nothing qualifies, so the caller omits the key altogether.
 */
export function boundedUnsupportedNeeds(rows) {
  const seen = new Set();
  const eligible = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const rank = UNSUPPORTED_NEEDS_PRIORITIES.indexOf(row?.priority);
    const id = typeof row?.id === 'string' ? row.id.trim() : '';
    const text = clipNeedText(row?.text);
    if (rank < 0 || !id || !text || seen.has(id)) continue;
    seen.add(id);
    eligible.push({ rank, order: eligible.length, row: { id, priority: row.priority, text } });
  }
  if (!eligible.length) return null;
  eligible.sort((left, right) => left.rank - right.rank || left.order - right.order);
  const shown = eligible.slice(0, UNSUPPORTED_NEEDS_MAX_ROWS).map(entry => entry.row);
  return { requirements: shown, omitted: eligible.length - shown.length };
}
