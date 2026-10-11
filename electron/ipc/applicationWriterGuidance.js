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
// Each rule is its own exported sentence, composed into one brief by a single
// builder, and the prompts print that brief. Truth rules live with their checks;
// this module supplies positive writing guidance only.

// ---------------------------------------------------------------------------
// The cover letter.
// ---------------------------------------------------------------------------

// What a body paragraph is for. The résumé already says what was done, so a
// paragraph that says it again adds nothing; what a paragraph can add is the
// context the cited quote itself states, and nothing it does not state.
export const LETTER_PROOF_ADDS_RULE = 'Add the reasons, decisions, constraints and outcomes that the cited career evidence states, instead of restating résumé bullets. Never claim more than a cited quote states.';

// The opening names the target and speaks from the candidate's side. The role and
// the employer come from the job record alone (context.job); anything said about
// the employer beyond the posting's own text is a claim the candidate cannot back.
export const LETTER_OPENING_RULE = 'Name the role and company once in the opening, using the job record. Lead with the strongest true evidence for the posting, and make no unsupported assertion about the employer.';

// A specific closing is a writing goal, not a deterministic grammar.
export const LETTER_CLOSING_RULE = 'Make the closing specific to evidence the letter has already shown.';

// How many proof paragraphs a letter has is a function of the evidence, not a
// target. A quote that states only an achievement has nothing to add, so a third
// paragraph built on it can only restate.
export const LETTER_PROOF_COUNT_RULE = 'Use as many proof paragraphs as the evidence warrants, keeping the strongest distinct points.';

// jobNeedQuote is a verbatim span of the posting. Two paragraphs bound to one span
// make the letter say one posting phrase twice; the review's argument-links check
// rejects exactly that degenerate case (checkParagraphArgumentLinks), and nothing else
// about how a quote relates to its paragraph.
export const LETTER_JOB_NEED_BINDING_RULE = 'When recording a jobNeedQuote, copy an exact span of the posting and connect it honestly to the paragraph’s evidence.';

export const LETTER_NO_POSTING_ECHO_RULE = 'Write plain, natural English without echoing the posting as filler.';

// The claim span is owed by a bounded number of paragraphs (the constant behind
// OWING_CLAIM_PARAGRAPHS); the rule for its shape is printed by the contract. What
// the contract could not say is where it goes: a span is a phrase inside a sentence
// the paragraph needs, and a sentence written only to carry one is the abstract
// filler the reviewers keep flagging.
export const LETTER_CLAIM_PLACEMENT_RULE = 'Frame adjacent experience honestly; explain the connection without presenting different work as equivalent.';

export const COVER_LETTER_GUIDANCE_RULES = Object.freeze([
  LETTER_PROOF_ADDS_RULE, LETTER_OPENING_RULE, LETTER_CLOSING_RULE, LETTER_PROOF_COUNT_RULE,
  LETTER_JOB_NEED_BINDING_RULE, LETTER_NO_POSTING_ECHO_RULE, LETTER_CLAIM_PLACEMENT_RULE,
]);

// One block, printed by the cover-letter writer and by the review that may rewrite
// the letter. No host check counts these sentences (a few are backed by one); the
// independent reviewers read for them after the checks pass.
export const COVER_LETTER_WRITER_GUIDANCE = 'Letter writing guidance: '
  + COVER_LETTER_GUIDANCE_RULES.join(' ');

// What a correction round restates. A rewrite of a flagged paragraph is invited to
// restate its bullet, to echo the posting, and to reuse one posting phrase for two
// paragraphs; the other rules govern the whole letter and are already in the stage
// prompt the responder holds.
export const LETTER_REWRITE_BRIEF_RULE = [LETTER_PROOF_ADDS_RULE, LETTER_JOB_NEED_BINDING_RULE, LETTER_NO_POSTING_ECHO_RULE].join(' ');

// ---------------------------------------------------------------------------
// The résumé.
// ---------------------------------------------------------------------------

export const RESUME_LEAD_BULLET_RULE = 'Lead with the strongest true evidence for the posting, and order the remaining bullets by value to the reader.';

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
