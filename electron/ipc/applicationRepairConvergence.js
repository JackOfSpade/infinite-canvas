/**
 * Host-owned repair convergence for the application blind-review loop.
 *
 * Pure: no filesystem, no store, no model call.  Given the signed findings of
 * one blind-review cycle and the documents they were written against, this
 * module derives, deterministically and only from those inputs:
 *
 *   - a bounded, deduplicated, clustered brief for the WRITER that has to
 *     repair them (typed host fields; reviewer wording is carried only as
 *     truncated, quoted data and never as an instruction);
 *   - a wording-stable fingerprint of every cluster, so the same defect raised
 *     again in a later cycle is recognised even when the reviewer rephrases it;
 *   - the recurrence streak of each fingerprint across consecutive cycles, and
 *     the typed human stop it escalates to.
 *
 * Nothing here waives, filters or resolves a finding.  A finding that cannot
 * be answered by any edit a pasted response may make ends the loop with a
 * visible needs-human condition; it is never silently dropped.
 */
import { authorityDigest } from './applicationAuthorityWorkflow.js';
import { HOST_REQUIRED_LETTER_FUNCTIONS } from './coverLetterChecks.js';

// Version 4: a record also carries the finding count of each of the consecutive
// finding-bearing cycles (`counts`), which the trend-aware stop below reads to
// tell a run that is still improving from one that has stopped improving.
// Version 3 added the number of consecutive finding-bearing cycles and a
// bounded tally of which units were raised how often (the wording-independent
// cap reads them), a fingerprint carries the career-snapshot entry a required
// presence concerns, and the brief lists only the pinned fields a cluster's
// findings concern.  Version 2 added defect-own stems, field-keyed pinned
// fingerprints and readable unit labels.  A record of another version cannot be
// compared with these.
export const REPAIR_CONVERGENCE_VERSION = 4;
export const REPAIR_BRIEF_MAX_BYTES = 12 * 1024;
export const REPAIR_BRIEF_MAX_UNITS = 6;
export const REPAIR_BRIEF_MAX_FINDING_IDS = 3;
export const REPAIR_BRIEF_MAX_RULE_IDS = 3;
// The most characters a brief row quotes of ONE reviewer field (issue or fix).
// 240 cut 14 of 22 live letter fixes, and in 11 of them what was cut held the
// "Keep / Retain / Preserve / Do not" sentences that guard the edit; 480 holds
// the longest fix measured on that run whole, and fitReviewerText keeps a longer
// one's constraint sentences ahead of its example wording.
export const REPAIR_BRIEF_TEXT_CHARS = 480;
// The characters each of issue and fix may use at each step of the byte ladder,
// widest first; the last step carries no reviewer wording at all.
export const REPAIR_BRIEF_TEXT_LADDER = Object.freeze([REPAIR_BRIEF_TEXT_CHARS, REPAIR_BRIEF_TEXT_CHARS / 2, REPAIR_BRIEF_TEXT_CHARS / 4, 0]);
export const REPAIR_UNIT_SHINGLE_WORDS = 6;
export const REPAIR_CLUSTER_TOPIC_SIMILARITY = 0.5;
// A finding must recur in this many consecutive blind cycles before the host
// stops: the first sighting plus two recurrences.  A finding about a field the
// host copies verbatim from the approved snapshot (or about the entry's
// required presence) is stopped one cycle sooner, because the writer has by
// then been shown every legal edit and none of them can change what the
// reviewer is objecting to.  A finding about a mutable field of the same unit
// (a project's description, a skill group's label) is NOT pinned: it has legal
// edits and gets the ordinary three cycles.
export const RECURRENCE_STREAK_STOP = 3;
export const PINNED_RECURRENCE_STREAK_STOP = 2;
export const RECURRENCE_MAX_FINGERPRINTS = 96;
export const RECURRENCE_STEM_LIMIT = 24;
// Two findings about one unit are "the same defect" only when the words that
// are THEIR OWN agree.  Every finding about a small unit shares that unit's
// subject words (it quotes them) and the reviewer's boilerplate ("the cited
// evidence does not establish..."), so those are removed before comparing; what
// is left is the qualifier, quantity or claim the finding objects to.
//
// Calibration (offline, numbers only).  With the unit's words and the review
// vocabulary removed, successive findings of the same defect that live
// reviewers re-worded shared 3 to 4 of their own stems at 0.25 to 0.60
// similarity, and re-worded test defects 2 shared at 0.40 to 0.67.  Findings of
// DIFFERENT defects on one unit (a scope qualifier, then a baseline period,
// then a frequency; a project's audience, then its reach) shared 0 or 1 stem at
// 0.00 to 0.14.  The floors sit in that gap and a defect must also share at
// least RECURRENCE_MIN_SHARED_STEMS stems, so a long finding that happens to
// repeat one common word cannot continue a streak.  The old 0.15 floor was
// calibrated on a pinned project whose findings now match by field, not wording.
export const RECURRENCE_EXACT_SIMILARITY = 0.2;
export const RECURRENCE_UNIT_SIMILARITY = 0.25;
export const RECURRENCE_THEME_SIMILARITY = 0.25;
export const RECURRENCE_MIN_SHARED_STEMS = 2;
export const RECURRENCE_THEME_STREAK_STOP = 4;
export const RECURRENCE_STOP_MAX_ITEMS = 6;
// A wording-independent bound.  Every recurrence rule above needs two reviews to
// agree on WHAT they object to; reviewers who re-word each time (about two in
// nine re-worded repeats were recognised offline) leave every streak at 1, so
// without a bound a job whose documents never satisfy the reviewers would run
// forever at roughly an hour of human-driven chat cycling per round.  Two
// bounds read the number of findings each CONSECUTIVE finding-bearing cycle
// reported, and neither runs while a stop that can name its cause is available.
//
// The first version of this bound was a flat count: five consecutive cycles
// that each reported something ended the job.  A measured live run was stopped
// that way with its per-cycle counts at 7, 2, 5, 6, 3, still falling, and a flat
// count cannot tell that run from one that reports six findings five times.  So
// the bound is now trend-aware:
//
//   * RECURRENCE_STALL_MIN_CYCLES (5): from the fifth consecutive cycle on, the
//     job stops when the findings are NOT improving.  The first cycle reviews the
//     first draft and each later one a repair, so five cycles are four repair
//     rounds, above the three cycles at which an anchored recurrence stops (two
//     when pinned) and the four of an unanchored theme, so the stall stop never
//     pre-empts a stop that can name its cause.  "Improving" is one precise
//     thing, findingCountsFalling(): the latest cycle's count is strictly below
//     the LOWEST of the RECURRENCE_TREND_WINDOW (2) cycles just before it, a new
//     low against the recent past.  A window, not every earlier cycle, because
//     one lucky low early in a run (the 2 in 7, 2, 5, 6, 3) would otherwise make
//     every later, honest improvement read as failure, and the live run showed
//     exactly that shape; two cycles is long enough to see over one bounce and
//     short enough that a run which has flattened (7, 6, 6, 7, 6) or turned back
//     up (..., 3, 4) is recognised the cycle it does.  And only while that latest
//     count is at least RECURRENCE_STALL_MIN_FINDINGS (3): a cycle that reports
//     one or two findings is a run about to finish, and stopping it for a
//     plateau would trade a nearly complete package for a person's hour.
//   * RECURRENCE_CYCLE_CAP (8): a hard bound whatever the trend.  A run that is
//     genuinely falling by one finding a cycle from a large first report is
//     allowed seven repair rounds, three more than the old flat bound gave, and
//     no more: a person reads each round in chat, so a run still reporting
//     something after eight cycles is a job for a person even when it is
//     improving, and the stop says that it was improving.
//
// A clean cycle completes the job and resets the count.  Nothing is waived: the
// stop is a typed terminal and every finding stays in the signed streams.
export const RECURRENCE_CYCLE_CAP = 8;
export const RECURRENCE_STALL_MIN_CYCLES = 5;
export const RECURRENCE_STALL_MIN_FINDINGS = 3;
export const RECURRENCE_TREND_WINDOW = 2;
// The per-cycle counts a record keeps: the last this many, which is far above
// the hard cap, so the bound exists only to keep a malformed record small.
export const RECURRENCE_COUNTS_MAX = 16;
export const RECURRENCE_TALLY_MAX = 24;
export const HUMAN_STOP_REASONS = Object.freeze(['no-legal-edit', 'pinned-recurrence', 'recurrence', 'cycle-cap']);

// Most severe, most specific tracks first: a cluster's displayed track is the
// first of these that raised it.
export const REPAIR_TRACK_PRIORITY = Object.freeze([
  'fact-fidelity', 'tailoring-ats', 'cross-document-coherence',
  'resume-hiring-quality', 'letter-argument-editorial', 'bundle-editorial',
]);
const DOCUMENT_ORDER = Object.freeze(['resume', 'coverLetter', 'bundle']);

// The edits a pasted response can make to each kind of unit, and the fields it
// can never change because the host copies them exactly from the approved
// career snapshot.  These describe the host's own validators, not a reviewer's
// opinion, so a reviewer cannot widen or narrow them.
const UNIT_LEGAL_EDITS = Object.freeze({
  'resume-bullet': ['rewrite-bullet-text', 'cite-other-selected-evidence', 'remove-bullet-when-role-keeps-another'],
  project: ['rewrite-description', 'qualify-scope-in-description-or-metrics', 'remove-project-when-not-host-required'],
  'skill-group': ['relabel-group-with-neutral-label'],
  education: ['omit-item-when-not-host-required'],
  credential: ['omit-item-when-not-host-required'],
  'letter-paragraph': ['rewrite-paragraph', 'merge-paragraphs', 'remove-paragraph'],
  requirement: ['rewrite-cited-proof'],
});
const UNIT_PINNED_FIELDS = Object.freeze({
  'resume-bullet': [],
  project: ['name'],
  'skill-group': ['items'],
  education: ['credential', 'institution', 'dates'],
  credential: ['name', 'issuer', 'dates'],
  'letter-paragraph': [],
  requirement: [],
});
const CLAIM_PREFIXES = Object.freeze([
  ['resume-role-', 'resume-bullet'], ['resume-project-', 'project'], ['resume-skill-', 'skill-group'],
  ['resume-education-', 'education'], ['resume-credential-', 'credential'], ['letter-', 'letter-paragraph'],
]);
// What a person calls each kind of unit, for the human-facing stop.  An
// internal claim id never reaches a person; a host label (a project's name, a
// role's header) refines this, and the unit's position is the fallback.
const UNIT_KIND_LABELS = Object.freeze({
  'resume-bullet': 'résumé bullet', project: 'résumé project', 'skill-group': 'résumé skills group',
  education: 'résumé education entry', credential: 'résumé certification', 'letter-paragraph': 'cover-letter paragraph',
});
const DOCUMENT_LABELS = Object.freeze({ resume: 'the résumé', coverLetter: 'the cover letter', bundle: 'the documents' });
export const REPAIR_LABEL_MAX_CHARS = 80;

// Which words in a finding show that it is ABOUT a pinned field rather than
// about the mutable text beside it.  A finding about a project's description
// has legal edits; only a finding that objects to the name itself (or says a
// required entry is unneeded as a whole) is one no pasted response can answer.
// These are the vocabulary of the field, never of any document, and a miss or a
// hit can only move a stop by one cycle and change the sentence that explains
// it: it never waives or hides a finding.
const PIN_FIELD_WORDS = Object.freeze({
  items: ['items', 'item', 'listed', 'entries', 'entry'],
  credential: ['credential', 'degree', 'diploma', 'major', 'qualification', 'programme', 'program'],
  institution: ['institution', 'school', 'university', 'college', 'institute', 'academy'],
  dates: ['date', 'dates', 'year', 'years', 'graduated', 'graduation', 'attended', 'enrolled', 'period', 'expires', 'expired', 'expiry', 'expiration', 'validity', 'renewed'],
  issuer: ['issuer', 'issued', 'issuing', 'authority', 'organization', 'organisation', 'accreditation'],
});

// NAME.  "name" and "title" are everywhere in a finding about the text beside
// a name ("the name of a third-party product", "the job title the quote
// states"), so a bare field word never concerns the pinned name.  It does when
// it names THE UNIT'S OWN field: the unit's noun directly followed by the field
// word ("the project name", "the project's title", "the certification name"),
// or the field word of that unit ("the name of the project").  Renaming the
// unit is also about its name, wherever the finding says it.
const NAME_FIELD_NOUNS = new Set(['name', 'title', 'heading', 'headline']);
const NAME_FIELD_VERBS = new Set(['rename', 'renamed', 'renaming', 'retitle', 'retitled', 'retitling']);
const UNIT_NOUNS = Object.freeze({
  project: Object.freeze(['project']),
  credential: Object.freeze(['certification', 'certificate', 'credential', 'license', 'licence']),
});
const OF_DETERMINERS = new Set(['the', 'this', 'that']);
// Each mention is { index, span }: where the field word sits and how many
// tokens the mention covers, so the words around it can be read.
function unitNameMentions(tokens, kind) {
  const nouns = UNIT_NOUNS[kind] || [];
  const found = [];
  if (!nouns.length) return found;
  tokens.forEach((token, index) => {
    if (nouns.includes(token)) {
      const field = index + (tokens[index + 1] === 's' ? 2 : 1);
      if (NAME_FIELD_NOUNS.has(tokens[field])) found.push({ index: field, span: 1 });
    } else if (NAME_FIELD_NOUNS.has(token) && tokens[index + 1] === 'of' && OF_DETERMINERS.has(tokens[index + 2]) && nouns.includes(tokens[index + 3])) {
      found.push({ index, span: 4 });
    }
  });
  return found;
}

// PRESERVATION.  A reviewer told never to make a rename the fix writes "keep
// the project name, qualify the description" or "the items as listed are
// fine; the label overstates them".  A field the defect says to keep, or says
// is already right, is not what it objects to.  Only the defect is read, and
// only the words right beside the mention.
const PRESERVE_BEFORE = new Set(['keep', 'keeps', 'kept', 'keeping', 'leave', 'leaves', 'leaving', 'retain', 'retains', 'retaining', 'preserve', 'preserves', 'preserving',
  'maintain', 'maintains', 'maintaining']);
const NEGATORS = new Set(['not', 'never', 'no', 'nor', 'without', 't']);
const CHANGE_VERBS = new Set(['change', 'changing', 'alter', 'altering', 'modify', 'modifying', 'edit', 'editing', 'touch', 'touching', 'rename', 'renaming', 'retitle',
  'retitling', 'replace', 'replacing', 'rewrite', 'rewriting', 'remove', 'removing', 'drop', 'dropping', 'reorder', 'reordering', 'make', 'making']);
const PRESERVE_AFTER = new Set(['unchanged', 'unaltered', 'intact', 'untouched', 'verbatim']);
const AS_PRESERVED = new Set(['is', 'listed', 'written', 'stated', 'given', 'shown', 'supplied']);
const APPROVAL_WORDS = new Set(['fine', 'accurate', 'correct', 'acceptable', 'appropriate', 'supported', 'grounded', 'right', 'ok', 'okay']);
const COPULAS = new Set(['is', 'are', 'was', 'were', 'stays', 'stay', 'remains', 'remain', 'looks', 'look', 'seems', 'seem']);
const PRESERVE_WINDOW = 4;
function preservedMention(tokens, { index, span = 1 }) {
  for (let j = index - 1; j >= Math.max(0, index - PRESERVE_WINDOW); j -= 1) {
    if (PRESERVE_BEFORE.has(tokens[j])) return true;
    if (CHANGE_VERBS.has(tokens[j]) && (NEGATORS.has(tokens[j - 1]) || NEGATORS.has(tokens[j - 2]))) return true;
  }
  if (span === 1 && tokens[index - 1] === 'as' && AS_PRESERVED.has(tokens[index])) return true;
  const after = index + span;
  for (let j = after; j < Math.min(tokens.length, after + PRESERVE_WINDOW); j += 1) if (PRESERVE_AFTER.has(tokens[j])) return true;
  if (tokens[after] === 'as' && AS_PRESERVED.has(tokens[after + 1])) return true;
  // "the name is fine", "the items listed are fine": one word may stand between.
  return [after, after + 1].some(copula => COPULAS.has(tokens[copula]) && APPROVAL_WORDS.has(tokens[copula + 1]));
}
// A rename the defect forbids ("do not rename it", "without renaming") is not
// a rename it asks for.
function negatedAt(tokens, index) { return NEGATORS.has(tokens[index - 1]) || NEGATORS.has(tokens[index - 2]); }

// A QUOTED pinned value mostly identifies the unit ("'Queue Relay' is described
// as used by every team").  It is about the value only when the value is the
// subject of the objection ("'Queue Relay' overstates the tool", "'2019' is
// not supported") or follows the field's own word ("the name 'Queue Relay'").
const QUOTE_SUBJECT_SKIPS = new Set(['is', 'are', 'was', 'were', 'be', 'being', 'been', 'itself', 'alone', 'still', 'also', 'here', 'now', 'again', 'a', 'an', 'much',
  'far', 'too', 'somewhat', 'clearly', 'both']);
const QUOTE_SUBJECT_SKIP_LIMIT = 4;
const OBJECTION_WORDS = new Set(['broad', 'broader', 'broadens', 'broadened', 'overstates', 'overstate', 'overstated', 'overclaims', 'overclaim', 'overclaimed',
  'exaggerates', 'exaggerated', 'inflates', 'inflated', 'misleading', 'misleads', 'misrepresents', 'misrepresented', 'mischaracterizes', 'mischaracterises',
  'inaccurate', 'incorrect', 'wrong', 'unsupported', 'unverified', 'unsubstantiated', 'unproven', 'implies', 'suggests', 'claims', 'omits', 'lacks', 'narrower',
  'vague', 'generic', 'ambiguous', 'overreaches', 'exceeds', 'differs', 'deviates', 'contradicts', 'conflicts', 'not', 'never', 'does', 'doesn', 'isn', 'aren',
  'invented', 'fabricated', 'absent', 'missing', 'outdated', 'false', 'untrue', 'questionable', 'dubious', 'mismatched', 'mismatches', 'inconsistent']);
function quotedMentions(text) {
  const source = String(text ?? '').normalize('NFKC');
  const found = [];
  const add = (match, inner) => {
    const start = match.index + match[0].indexOf(inner) - 1;
    found.push({ phrase: normalizedPhrase(inner), before: words(source.slice(0, start)), inner: words(inner), after: words(source.slice(start + inner.length + 2)) });
  };
  for (const match of source.matchAll(/["“”«»]([^"“”«»]{1,200})["“”«»]/gu)) add(match, match[1]);
  for (const match of source.matchAll(/(?:^|[\s([—-])['‘]([^'‘’]{1,200})['’](?=$|[\s.,;:!?)\]—-])/gu)) add(match, match[1]);
  return found.filter(mention => mention.phrase);
}
function quoteConcernsValue(mention, fieldWords) {
  const tokens = [...mention.before, ...mention.inner, ...mention.after];
  if (preservedMention(tokens, { index: mention.before.length, span: mention.inner.length })) return false;
  if (fieldWords.has(mention.before.at(-1))) return true;
  let next = 0; let skipped = 0;
  while (QUOTE_SUBJECT_SKIPS.has(mention.after[next]) && skipped < QUOTE_SUBJECT_SKIP_LIMIT) { next += 1; skipped += 1; }
  return OBJECTION_WORDS.has(mention.after[next]);
}

// Clauses of the defect: a sentence, or either side of a contrast ("the label
// is fine, but the item ... is unsupported").
const CLAUSE_CONTRASTS = new Set(['but', 'however', 'whereas', 'although', 'though', 'while', 'yet']);
function defectClauses(text) {
  const clauses = [];
  for (const part of String(text ?? '').normalize('NFKC').split(/[;!?]|\.(?=\s|$)|\s[—–]\s/u)) {
    let current = [];
    for (const token of words(part)) {
      if (CLAUSE_CONTRASTS.has(token) && current.length) { clauses.push(current); current = []; } else current.push(token);
    }
    if (current.length) clauses.push(current);
  }
  return clauses;
}

// A skill group's LABEL is its mutable field.  Items named after the label in
// one clause ("the label misdescribes the listed items") are what the label is
// wrong about, not a defect in the items; items named first ("the listed items
// include a tool the record never mentions") are the defect.
const LABEL_NOUNS = new Set(['label', 'labels', 'heading', 'category', 'categorization', 'categorisation']);
function labelMentionAt(tokens, index) {
  return LABEL_NOUNS.has(tokens[index]) || ((tokens[index] === 'group' || tokens[index] === 'groups') && NAME_FIELD_NOUNS.has(tokens[index + 1]));
}

// PRESENCE.  An entry the app requires cannot be removed by a pasted response,
// so a finding that says the entry is unneeded AS A WHOLE is unanswerable.  A
// finding that the entry merely duplicates another unit ("redundant with the
// first bullet", "repeats it") has legal fixes (give the entry content of its
// own, or change the other unit), and a finding about a PART of the entry
// ("the description is redundant") has a legal edit by definition.  Only the
// defect is read: a reviewer's remedy often offers deletion beside a legal fix.
const ENTRY_NOUNS = new Set(['project', 'entry', 'item', 'section']);
const ENTRY_PART_NOUNS = new Set(['description', 'summary', 'text', 'wording', 'claim', 'claims', 'bullet', 'bullets', 'metric', 'metrics', 'figure', 'figures',
  'sentence', 'sentences', 'line', 'lines', 'detail', 'details', 'phrase', 'phrases', 'content', 'copy', 'blurb', 'paragraph', 'paragraphs', 'name', 'title', 'label',
  'number', 'numbers', 'result', 'results', 'outcome', 'outcomes', 'qualifier', 'qualifiers', 'scope', 'impact', 'statement', 'statements', 'clause', 'tone',
  'language', 'terminology', 'formatting', 'order', 'ordering', 'placement', 'length']);
// Absolute: the entry is not needed at all.
const UNNEEDED_ABSOLUTE = new Set(['unnecessary', 'superfluous', 'needless', 'gratuitous']);
// Relational: the entry is redundant OF something, which the finding then
// names; the relation is the defect and it has a legal fix.
const UNNEEDED_RELATIONAL = new Set(['redundant', 'redundancy', 'duplicative', 'duplicate', 'duplicated', 'duplication']);
const RELATION_WORDS = new Set(['with', 'to', 'of', 'in', 'by', 'against', 'from', 'as', 'given', 'because', 'since', 'alongside', 'beside', 'compared', 'relative',
  'versus', 'vs', 'between', 'when', 'after', 'once', 'where', 'considering']);
const UNNEEDED_PHRASES = Object.freeze([['adds', 'nothing'], ['adds', 'no', 'value'], ['serves', 'no', 'purpose'], ['has', 'no', 'value'], ['no', 'added', 'value']]);
const REMOVAL_WORDS = new Set(['remove', 'removed', 'removing', 'removal', 'delete', 'deleted', 'deleting', 'drop', 'dropped', 'dropping', 'omit', 'omitted',
  'omitting', 'omission', 'eliminate', 'eliminated', 'eliminating']);
const REMOVAL_OBJECT_SKIPS = new Set(['the', 'this', 'that', 'whole', 'entire', 'entirely', 'complete', 'completely', 'separate', 'standalone', 'of']);
const REMOVAL_AUXILIARIES = new Set(['should', 'must', 'could', 'can', 'may', 'might', 'needs', 'need', 'to', 'ought', 'be', 'being', 'been', 'is', 'are', 'was', 'were',
  'will', 'would', 'entirely', 'simply', 'probably', 'just', 'best', 'better', 'also', 'either', 'completely', 'wholly', 'therefore']);
const SUBJECT_WINDOW = 6;
const REMOVAL_OBJECT_SKIP_LIMIT = 4;
function statesEntryUnneededAsAWhole(tokens) {
  // "the project description" is a part; "the project" and "the project entry" are the whole.  "project's" reads through the possessive.
  const partFollows = index => ENTRY_PART_NOUNS.has(tokens[index + (tokens[index + 1] === 's' ? 2 : 1)]);
  const isEntry = index => ENTRY_NOUNS.has(tokens[index]) && !partFollows(index);
  const entryBefore = index => {
    for (let j = index - 1; j >= Math.max(0, index - SUBJECT_WINDOW); j -= 1) {
      if (ENTRY_PART_NOUNS.has(tokens[j])) return false;
      if (isEntry(j)) return true;
    }
    return false;
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const unneeded = UNNEEDED_ABSOLUTE.has(token) || (UNNEEDED_RELATIONAL.has(token) && !RELATION_WORDS.has(tokens[index + 1]));
    if ((unneeded && (entryBefore(index) || isEntry(index + 1))) || (UNNEEDED_PHRASES.some(phrase => phrase.every((word, offset) => tokens[index + offset] === word)) && entryBefore(index))) return true;
    if (!REMOVAL_WORDS.has(token)) continue;
    // Active: "remove the project", "removal of the whole entry".
    let object = index + 1; let skipped = 0;
    while (REMOVAL_OBJECT_SKIPS.has(tokens[object]) && skipped < REMOVAL_OBJECT_SKIP_LIMIT) { object += 1; skipped += 1; }
    if (isEntry(object)) return true;
    // Passive: "the project should be removed".
    let subject = index - 1;
    while (subject >= 0 && index - subject <= SUBJECT_WINDOW && REMOVAL_AUXILIARIES.has(tokens[subject])) subject -= 1;
    if (subject >= 0 && index - subject <= SUBJECT_WINDOW && isEntry(subject)) return true;
  }
  return false;
}

function words(text) { return String(text ?? '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []; }
function utf8Bytes(value) { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
function sign(record) { return { ...record, digest: authorityDigest(record) }; }
function unsigned(record) { const { digest: _digest, ...value } = record || {}; return value; }
function uniqueSorted(values) { return [...new Set(values)].sort(); }

// Generic review vocabulary appears in nearly every finding and would make
// unrelated findings look alike; function words carry no topic.
const STOP_WORDS = new Set(`a an and are as at be been being but by can could did do does for from had has have how if in into is it its may might more most must no nor not of on or other our per same shall should so some such than that the their them then there these they this those to too via was were what when where which while who whom whose will with within without would you your
 document documents resume résumé letter cover paragraph paragraphs sentence sentences bullet bullets claim claims finding findings issue issues supplied current source evidence statement text section page line reader reviewer candidate applicant should instead rather also only each every any all both either
 make makes made use uses used using add adds added remove removes removed replace replaces replaced change changes changed state states stated`.split(/\s+/u).filter(Boolean));

/** Order-stable, wording-tolerant topic: 6-character stems of content words. */
export function topicStems(...texts) {
  const counts = new Map();
  for (const token of words(texts.join(' '))) {
    if (token.length < 4 || STOP_WORDS.has(token) || /^\d+$/u.test(token)) continue;
    const stem = Array.from(token).slice(0, 6).join('');
    counts.set(stem, (counts.get(stem) || 0) + 1);
  }
  return counts;
}
function rankedStems(counts, limit = RECURRENCE_STEM_LIMIT) {
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
    .slice(0, limit).map(([stem]) => stem).sort();
}
export function stemSimilarity(left, right) {
  const a = new Set(left || []); const b = new Set(right || []);
  if (!a.size || !b.size) return 0;
  let shared = 0; for (const stem of a) if (b.has(stem)) shared += 1;
  return shared / (a.size + b.size - shared);
}
function sharedStemCount(left, right) {
  const b = new Set(right || []); let shared = 0;
  for (const stem of new Set(left || [])) if (b.has(stem)) shared += 1;
  return shared;
}

// The vocabulary every fact-checking, editorial or recruiting finding is
// written in.  It says what KIND of finding this is, never which defect, and a
// reviewer re-uses it for every unit it reports, so it makes unrelated findings
// about one unit look alike.  Removed (with the unit's own words) before two
// findings are compared as "the same defect".
const REVIEW_VOCABULARY = `says say said saying describe describes described description descriptions project projects entry item items title heading name label labels group groups skill skills
 cited cite cites citation citations quote quoted quotes rephrase rephrased rephrasing reword reworded rewording wording phrase phrased
 unsupported supported supports supporting support establish establishes established establishing overstate overstates overstated overstating
 broaden broadens broadened broadening scope scopes imply implies implied implying suggest suggests suggested stated shows show showed shown
 still keeps keep lacks lack lacking offers offer without beyond because whereas although however though while but please ensure retain retains retained
 preserve preserving exact exactly specific specifically explicit explicitly directly only just relabel relabels neutral neutrally record records`.split(/\s+/u).filter(Boolean);
const REVIEW_STEMS = new Set(REVIEW_VOCABULARY.map(word => Array.from(word).slice(0, 6).join('')));

/**
 * The stems of a finding that are its OWN: topic stems minus the reviewer's
 * boilerplate and minus the words of the unit(s) it is about.
 */
function defectStemCounts(texts, unitStems) {
  const counts = topicStems(...texts);
  for (const stem of [...counts.keys()]) if (REVIEW_STEMS.has(stem) || unitStems?.has(stem)) counts.delete(stem);
  return counts;
}

export function normalizeRepairDocument(document) {
  if (document === 'resume') return 'resume';
  if (document === 'cover-letter' || document === 'coverLetter') return 'coverLetter';
  return 'bundle';
}
export function repairFindingOrdinal(id) {
  const match = /^(\d+)-(\d+)-/u.exec(String(id || ''));
  return match ? Number(match[1]) : null;
}
function compareFindingIds(left, right) {
  const a = String(left).split('-').map(part => (/^\d+$/u.test(part) ? Number(part) : part));
  const b = String(right).split('-').map(part => (/^\d+$/u.test(part) ? Number(part) : part));
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] === b[index]) continue;
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    if (typeof a[index] === 'number' && typeof b[index] === 'number') return a[index] - b[index];
    return String(a[index]) < String(b[index]) ? -1 : 1;
  }
  return 0;
}
export function repairUnitKind(claimId) {
  const id = String(claimId || '');
  for (const [prefix, kind] of CLAIM_PREFIXES) if (id.startsWith(prefix)) return kind;
  return null;
}
function claimEntityId(claimId, kind) {
  const id = String(claimId || '');
  for (const [prefix, claimKind] of CLAIM_PREFIXES) {
    if (claimKind === kind && id.startsWith(prefix) && kind !== 'resume-bullet') return id.slice(prefix.length);
  }
  return null;
}

function shingleSet(wordList, size) {
  const out = new Set();
  for (let index = 0; index + size <= wordList.length; index += 1) {
    const window = wordList.slice(index, index + size);
    if (window.filter(word => !STOP_WORDS.has(word)).length >= 3) out.add(window.join(' '));
  }
  return out;
}

/** Index the host-projected claims once; reused for every finding. */
export function prepareRepairClaimIndex(claims) {
  const ordinals = new Map();
  const list = (Array.isArray(claims) ? claims : []).filter(claim => typeof claim?.id === 'string' && claim.id).map((claim, order) => {
    const kind = repairUnitKind(claim.id);
    if (kind) ordinals.set(kind, (ordinals.get(kind) || 0) + 1);
    return { id: claim.id, order, kind, ordinal: kind ? ordinals.get(kind) : null, document: normalizeRepairDocument(claim.document),
      entityId: claimEntityId(claim.id, kind), shingles: shingleSet(words(claim.text), REPAIR_UNIT_SHINGLE_WORDS),
      stems: new Set(topicStems(claim.text).keys()) };
  });
  return { list, byId: new Map(list.map(claim => [claim.id, claim])) };
}

/**
 * Which host units a finding is about.  An exact host id (the fact-fidelity
 * claim id) is authoritative.  Otherwise a unit counts only when the finding
 * quotes a verbatim run of its text, and a finding that matches more than a
 * handful of units is a pattern about the document, not about any one unit.
 */
export function resolveRepairFindingUnits(finding, track, claimIndex) {
  const exact = claimIndex.byId.get(finding.targetId);
  if (exact) return { source: 'host-id', units: [exact] };
  if (track === 'tailoring-ats') return { source: 'host-requirement', units: [] };
  const document = normalizeRepairDocument(finding.document);
  const quoted = [...shingleSet(words(`${finding.targetId} ${finding.issue} ${finding.fix}`), REPAIR_UNIT_SHINGLE_WORDS)];
  if (!quoted.length) return { source: 'none', units: [] };
  const matches = claimIndex.list.filter(claim => (document === 'bundle' || claim.document === document)
    && quoted.some(shingle => claim.shingles.has(shingle)));
  return matches.length && matches.length <= REPAIR_BRIEF_MAX_UNITS
    ? { source: 'quoted-text', units: matches } : { source: 'none', units: [] };
}

function truncate(text, limit) {
  const value = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (Array.from(value).length <= limit) return value;
  const cut = Array.from(value).slice(0, limit).join('');
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > limit * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

// REVIEWER WORDING SHOWN TO THE WRITER.  The brief quotes a reviewer's issue and
// fix as data, bounded by REPAIR_BRIEF_TEXT_CHARS per field.  A cut that lands
// anywhere (the first version simply kept the leading characters) loses the part
// of a fix that matters most: reviewers end a correction with what must NOT
// change ("Keep ...", "Do not ..."), so a flat prefix cut delivered the
// instruction and dropped its guard rails, and the writer's next reword broke the
// very thing the reviewer had asked to keep.  So a field that must be cut is cut
// on a sentence or clause boundary, never inside a word, and a fix keeps its
// constraint sentences first, then its plain instruction, and only then the
// illustrative sentences (quoted or "for example" wording).  What was omitted is
// marked with an ellipsis, and the row says whether each field was cut.
//
// The constraint test reads the LEAD of a sentence or clause: it is the shape of
// an instruction, not any word of a document, so it cannot be satisfied by, or
// aimed at, any candidate or posting text.  A piece that does not fit is dropped
// or cut at a clause boundary, never inside a clause when it is a constraint:
// the front of a prohibition without its end can say the opposite.
const FIT_ELLIPSIS = '…';
// Text beyond this many limits is never read, which bounds the work on a
// pathological reviewer response (a clause-by-clause search over hundreds of
// thousands of clauses does not finish); the field is then reported as cut.
export const REPAIR_BRIEF_TEXT_READ_FACTOR = 16;
const FIT_ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|vs|etc|cf|approx|fig|inc|ltd|dr|mr|mrs|ms)\.$/iu;
const FIT_SENTENCE_BREAK = /(?<=[.!?;][)"'”’\]]*)\s+/u;
const FIT_CONSTRAINT_LEAD = String.raw`(?:keep(?:s|ing)?|retain(?:s|ing)?|preserv(?:e|es|ing)|maintain(?:s|ing)?|leav(?:e|es|ing)\s+(?!out\b)|do\s+not|don['’]t|never|must\s+not|should\s+not|shall\s+not|avoid(?:s|ing)?|without|(?:be\s+careful|take\s+care|make\s+sure)\s+not\s+to|only\s+(?:change|reword|edit|alter|touch|modify)|no\s+(?:new|additional|extra|invented)\b|not\s+(?:to|by)\b)`;
const FIT_CONJUNCTION = String.raw`(?:and|but|while|yet|then)`;
const FIT_CONSTRAINT = new RegExp(String.raw`^(?:(?:and|also|but|however|then|yet|while|please|note(?:\s+that)?)[,:]?\s+)*${FIT_CONSTRAINT_LEAD}`, 'iu');
// A constraint tacked onto an instruction ("..., and keep X", "... and keep X",
// "... — keep X", "... while keeping X") is its own piece, so it can be kept
// when the instruction it follows cannot.
const FIT_CONSTRAINT_CLAUSE_BREAK = new RegExp(String.raw`(?:(?<=[,—–])\s+(?=(?:${FIT_CONJUNCTION}\s+)?${FIT_CONSTRAINT_LEAD})|\s+(?=${FIT_CONJUNCTION}\s+${FIT_CONSTRAINT_LEAD}))`, 'iu');
// An illustrative piece LEADS with its example ("for example ...", a quoted
// replacement); a sentence that merely carries one inside its instruction is a
// plain piece, and a cut at its clause boundary drops the example first.
const FIT_EXAMPLE = /^(?:(?:and|also|or|but|then)\s+)?(?:for\s+(?:example|instance)\b|e\.g\.?|i\.e\.|such\s+as\b|like\s+["“”«»'‘]|["“”«»‘]|'(?=[^']{2,}'))/iu;
const FIT_CLAUSE_BREAK = /(?<=[,;:])\s+/u;
const FIT_SENTENCE_END = /[.!?][)"'”’\]]*$/u;
const FIT_TRAILING_PUNCTUATION = /[\s,;:—–-]+$/u;
const fitSize = text => Array.from(text).length;

function fitPieces(text, constraintsFirst) {
  const sentences = [];
  for (const part of text.split(FIT_SENTENCE_BREAK).filter(Boolean)) {
    if (sentences.length && FIT_ABBREVIATION.test(sentences[sentences.length - 1])) sentences[sentences.length - 1] += ` ${part}`;
    else sentences.push(part);
  }
  return sentences.flatMap(sentence => sentence.split(FIT_CONSTRAINT_CLAUSE_BREAK)).map(piece => ({
    text: piece,
    tier: !constraintsFirst ? 1 : FIT_CONSTRAINT.test(piece) ? 0 : FIT_EXAMPLE.test(piece) ? 2 : 1,
  }));
}

// `chosen` maps a piece index to { text, cut }.  Every gap (before the first
// chosen piece, between two, after the last) is shown as one ellipsis, and a
// piece that was itself cut carries its own.
function renderFit(chosen, pieceCount) {
  const order = [...chosen.keys()].sort((left, right) => left - right);
  const out = [];
  let previous = -1; let marked = false;
  for (const index of order) {
    const { text, cut } = chosen.get(index);
    if (index > previous + 1 && !marked) out.push(FIT_ELLIPSIS);
    out.push(cut ? `${text.replace(FIT_TRAILING_PUNCTUATION, '')}${FIT_ELLIPSIS}`
      : chosen.has(index + 1) || FIT_SENTENCE_END.test(text) ? text : text.replace(FIT_TRAILING_PUNCTUATION, ''));
    previous = index; marked = cut;
  }
  if (order.length && previous < pieceCount - 1 && !marked) out.push(FIT_ELLIPSIS);
  return out.join(' ');
}

/**
 * `value` shortened to at most `limit` characters (the ellipses included) on a
 * sentence or clause boundary, or at a word boundary when no clause of a piece
 * fits.  With `constraintsFirst` (a reviewer's fix) the sentences that say what
 * must not change are kept before the plain instruction, and the illustrative
 * ones last.  Only a single unbroken token longer than the whole limit is ever
 * cut inside itself.  Returns { text, truncated }: `truncated` is true exactly
 * when the returned text is not the whole (whitespace-normalised) value.
 */
export function fitReviewerText(value, limit, { constraintsFirst = false } = {}) {
  const whole = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (fitSize(whole) <= limit) return { text: whole, truncated: false };
  if (!(limit > 0)) return { text: '', truncated: true };
  const text = fitSize(whole) > limit * REPAIR_BRIEF_TEXT_READ_FACTOR
    ? Array.from(whole).slice(0, limit * REPAIR_BRIEF_TEXT_READ_FACTOR).join('').replace(/\s\S*$/u, '') : whole;
  const pieces = fitPieces(text, constraintsFirst);
  // A text trimmed by the read limit has one more, unread, piece after the last.
  const pieceCount = pieces.length + (text === whole ? 0 : 1);
  const order = pieces.map((_piece, index) => index).sort((left, right) => pieces[left].tier - pieces[right].tier || left - right);
  const fits = chosen => fitSize(renderFit(chosen, pieceCount)) <= limit;
  let chosen = new Map();
  for (const index of order) {
    const entire = new Map(chosen).set(index, { text: pieces[index].text, cut: false });
    if (fits(entire)) { chosen = entire; continue; }
    // A piece that does not fit may still give its leading clauses.
    const clauses = pieces[index].text.split(FIT_CLAUSE_BREAK);
    let partial = null;
    for (let count = clauses.length - 1; count >= 1 && !partial; count -= 1) {
      const trial = new Map(chosen).set(index, { text: clauses.slice(0, count).join(' '), cut: true });
      if (fits(trial)) partial = trial;
    }
    // Inside a clause only as a last resort, only for a plain piece, and only
    // when nothing at all has been kept yet.
    if (!partial && pieces[index].tier !== 0 && !chosen.size) {
      const wordsOf = pieces[index].text.split(' ');
      for (let count = wordsOf.length - 1; count >= 1 && !partial; count -= 1) {
        const trial = new Map([[index, { text: wordsOf.slice(0, count).join(' '), cut: true }]]);
        if (fits(trial)) partial = trial;
      }
    }
    if (partial) chosen = partial;
    // A constraint that does not fit leaves room for a shorter one; anything
    // else ends the selection, so the plain instruction is a prefix.
    if (pieces[index].tier !== 0) break;
  }
  if (!chosen.size) {
    const wordsOf = text.split(' ');
    let count = wordsOf.length;
    while (count > 1 && fitSize(`${wordsOf.slice(0, count).join(' ')}${FIT_ELLIPSIS}`) > limit) count -= 1;
    const head = wordsOf.slice(0, count).join(' ');
    const body = fitSize(`${head}${FIT_ELLIPSIS}`) <= limit ? head : Array.from(head).slice(0, limit - 1).join('');
    return { text: `${body.replace(FIT_TRAILING_PUNCTUATION, '')}${FIT_ELLIPSIS}`, truncated: true };
  }
  return { text: renderFit(chosen, pieceCount), truncated: true };
}

function unitPin(unit, pins) {
  const kind = unit.kind;
  const override = pins?.[unit.id] || null;
  const pinnedFields = override?.pinnedFields || UNIT_PINNED_FIELDS[kind] || [];
  // A claim whose id the host does not recognise is still a unit of text the
  // writer can rewrite; only a registered kind may declare it has no edit.
  const legalEdits = override?.legalEdits || UNIT_LEGAL_EDITS[kind] || ['rewrite-unit-text'];
  const pinnedValues = {};
  for (const [field, values] of Object.entries(override?.pinnedValues || {})) {
    const list = (Array.isArray(values) ? values : [values]).map(normalizedPhrase).filter(Boolean);
    if (list.length) pinnedValues[field] = list;
  }
  return { pinnedFields: [...pinnedFields], legalEdits: [...legalEdits], snapshotPaths: [...(override?.snapshotPaths || [])], entryPaths: [...(override?.entryPaths || [])], pinnedValues };
}

function normalizedPhrase(value) { return words(value).join(' '); }

/**
 * The pinned fields of a unit that one finding is ABOUT.  Only the DEFECT
 * (`finding.issue`) is read, never the reviewer's remedy and never the unit's
 * id: the signed review conventions tell reviewers to write remedies such as
 * "keep the project name and qualify the description", and a remedy that keeps
 * a field is no evidence the defect is in it.  A finding about the mutable text
 * beside a pinned field concerns no pinned field at all.
 *
 *   - name: the unit's own name field ("the project name", "the name of the
 *     project"), a rename, or the full pinned name in quotation marks as the
 *     subject of the objection.  A bare "name" or "title" never counts, so a
 *     finding about "the name of a third-party product" in a description is not
 *     about the project's name, and a quoted name that only identifies the unit
 *     ("'X' is described as ...") is not either.
 *   - every other copied field: a word of the field's vocabulary, or its full
 *     pinned value quoted as the subject of the objection.  For a skill group, an
 *     items word that follows the LABEL in one clause is what the label is wrong
 *     about, not a defect in the items.
 *   - a mention the defect says to keep, or says is already right ("keep the
 *     project name", "the items as listed are fine"), does not count.
 *   - presence (a required entry staying): the defect says the entry is unneeded
 *     as a whole.  "Redundant with the first bullet" or "repeats it" is a
 *     relation to another unit and is fixed by giving the entry content of its
 *     own or changing the other unit.
 */
export function pinnedFieldsConcerned({ kind, pin, finding }) {
  if (!pin?.pinnedFields?.length) return [];
  const issue = finding?.issue ?? '';
  const issueTokens = words(issue);
  const clauses = defectClauses(issue);
  const quotes = quotedMentions(issue);
  const quotesValue = (field, fieldWords) => {
    const listed = pin.pinnedValues?.[field];
    const values = (Array.isArray(listed) ? listed : [listed]).map(normalizedPhrase).filter(Boolean);
    return quotes.some(mention => values.includes(mention.phrase) && quoteConcernsValue(mention, fieldWords));
  };
  return pin.pinnedFields.filter(field => {
    if (field === 'presence') return statesEntryUnneededAsAWhole(issueTokens);
    if (field === 'name') {
      return clauses.some(tokens => unitNameMentions(tokens, kind).some(mention => !preservedMention(tokens, mention))
        || tokens.some((token, index) => NAME_FIELD_VERBS.has(token) && !negatedAt(tokens, index)))
        || quotesValue(field, NAME_FIELD_NOUNS);
    }
    const vocabulary = new Set(PIN_FIELD_WORDS[field] || []);
    const named = clauses.some(tokens => {
      let labelSeen = false;
      return tokens.some((token, index) => {
        if (field === 'items' && labelMentionAt(tokens, index)
          && !preservedMention(tokens, { index, span: token === 'group' || token === 'groups' ? 2 : 1 })) labelSeen = true;
        return vocabulary.has(token) && !labelSeen && !preservedMention(tokens, { index, span: 1 });
      });
    });
    return named || quotesValue(field, vocabulary);
  });
}

function unitLabel(unit, labels) {
  const host = typeof labels?.[unit.id] === 'string' ? labels[unit.id].replace(/\s+/gu, ' ').trim() : '';
  if (host) return Array.from(host).slice(0, REPAIR_LABEL_MAX_CHARS).join('');
  return unit.kind ? `${UNIT_KIND_LABELS[unit.kind]} ${unit.ordinal}` : 'a document claim';
}

function groupLabel(group, labels) {
  if (group.source === 'host-requirement') return 'a job requirement';
  if (!group.units.length) return DOCUMENT_LABELS[group.document] || DOCUMENT_LABELS.bundle;
  const names = group.units.slice(0, 2).map(unit => unitLabel(unit, labels));
  return group.units.length > 2 ? `${names.join(', ')}, and ${group.units.length - 2} more` : names.join(' and ');
}

/**
 * Group the findings of one cycle into clusters.  Findings about one exact
 * host unit, or quoting the same units, or (when neither) about the same
 * document, are one cluster when their topics overlap; a defect that three
 * tracks all described is one row for the writer, not three.
 *
 * `findings` carry { id, track, ruleId, document, targetId, issue, fix }.
 * `pins` optionally refines a claim id with { pinnedFields, legalEdits,
 * snapshotPaths, pinnedValues } the caller derived from the host's own
 * selection state.  `labels` maps a claim id to the readable name of its unit.
 *
 * A pin is a property of the UNIT; whether a finding is stopped as "pinned" is
 * a property of the FINDING (pinnedFieldsConcerned).  Findings merge into one
 * cluster only when they concern the same pinned fields.
 */
export function buildRepairClusters({ findings, claims, pins = {}, labels = {} } = {}) {
  const claimIndex = prepareRepairClaimIndex(claims);
  const ordered = (Array.isArray(findings) ? findings : []).filter(finding => typeof finding?.id === 'string')
    .slice().sort((left, right) => compareFindingIds(left.id, right.id));
  const groups = new Map();
  for (const finding of ordered) {
    const track = REPAIR_TRACK_PRIORITY.includes(finding.track) ? finding.track : 'bundle-editorial';
    const document = normalizeRepairDocument(finding.document);
    const resolved = resolveRepairFindingUnits(finding, track, claimIndex);
    const unitIds = resolved.units.map(unit => unit.id);
    const groupKey = resolved.source === 'host-id' ? `exact|${finding.targetId}`
      : resolved.source === 'host-requirement' ? `requirement|${finding.targetId}`
        : resolved.source === 'quoted-text' ? `units|${unitIds.join(',')}`
          : `document|${document}`;
    // Units name their own document, so a bundle-level finding that quotes a
    // paragraph joins the cluster of the paragraph-level finding that does.
    if (!groups.has(groupKey)) {
      const unitStems = new Set(resolved.units.flatMap(unit => [...unit.stems]));
      groups.set(groupKey, { source: resolved.source, document: resolved.units[0]?.document || document, units: resolved.units, anchor: finding.targetId,
        pin: resolved.source === 'host-id' && resolved.units[0] ? unitPin(resolved.units[0], pins) : null, unitStems, subclusters: [] });
    }
    const group = groups.get(groupKey);
    const concerned = group.pin ? pinnedFieldsConcerned({ kind: group.units[0].kind, pin: group.pin, finding }) : [];
    const concernKey = concerned.join('|');
    const counts = topicStems(finding.issue, finding.fix);
    const stems = rankedStems(counts);
    const defectCounts = defectStemCounts([finding.issue, finding.fix], group.unitStems);
    const home = group.subclusters.find(candidate => candidate.concernKey === concernKey && stemSimilarity(candidate.stems, stems) >= REPAIR_CLUSTER_TOPIC_SIMILARITY);
    if (home) {
      home.all.push({ ...finding, track });
      for (const [stem, count] of counts) home.counts.set(stem, (home.counts.get(stem) || 0) + count);
      for (const [stem, count] of defectCounts) home.defectCounts.set(stem, (home.defectCounts.get(stem) || 0) + count);
      home.stems = rankedStems(home.counts);
    } else group.subclusters.push({ all: [{ ...finding, track }], counts: new Map(counts), defectCounts: new Map(defectCounts), stems, concerned, concernKey });
  }
  const clusters = [];
  for (const group of groups.values()) {
    for (const sub of group.subclusters) {
      const first = sub.all[0];
      const tracks = REPAIR_TRACK_PRIORITY.filter(track => sub.all.some(finding => finding.track === track));
      const findingIds = sub.all.map(finding => finding.id);
      const units = group.units.map(unit => ({ kind: unit.kind || 'resume-bullet', id: unit.id }));
      const pin = group.pin;
      const kinds = uniqueSorted(group.units.map(unit => unit.kind).filter(Boolean));
      const legalEdits = pin ? pin.legalEdits
        : group.source === 'host-requirement' ? [...UNIT_LEGAL_EDITS.requirement]
          : uniqueSorted(kinds.flatMap(kind => UNIT_LEGAL_EDITS[kind] || []));
      // The snapshot path names a copied FIELD; a finding that says a required
      // entry is unneeded has no field to edit, only the entry itself.
      const copiedConcern = sub.concerned.some(field => field !== 'presence');
      const presenceConcern = sub.concerned.includes('presence');
      clusters.push({
        id: authorityDigest(uniqueSorted(findingIds)).slice(0, 12),
        document: group.source === 'host-requirement' ? normalizeRepairDocument(first.document) : group.document,
        track: tracks[0], tracks, source: group.source,
        anchor: group.source === 'host-id' || group.source === 'host-requirement' ? group.anchor : null,
        units, unitKind: group.source === 'host-id' ? (group.units[0].kind || null) : null,
        entityId: group.source === 'host-id' ? group.units[0].entityId : null,
        label: groupLabel(group, labels),
        findingIds, findingCount: findingIds.length,
        ruleIds: uniqueSorted(sub.all.map(finding => truncate(finding.ruleId, 48)).filter(Boolean)),
        // A finding made only of review vocabulary and the unit's own words has
        // no defect words to compare; it falls back to its whole topic so that
        // the same bare complaint, repeated verbatim, is still recognised.
        issue: first.issue, fix: first.fix, stems: sub.stems, defectStems: rankedStems(sub.defectCounts).length ? rankedStems(sub.defectCounts) : sub.stems,
        pinnedFields: pin ? pin.pinnedFields : [], concernedFields: sub.concerned,
        snapshotPaths: pin && copiedConcern ? pin.snapshotPaths : [], entryPaths: pin && presenceConcern ? pin.entryPaths : [], legalEdits,
        pinned: sub.concerned.length > 0,
      });
    }
  }
  const trackRank = cluster => Math.min(...cluster.tracks.map(track => REPAIR_TRACK_PRIORITY.indexOf(track)));
  return clusters.sort((left, right) => trackRank(left) - trackRank(right)
    || DOCUMENT_ORDER.indexOf(left.document) - DOCUMENT_ORDER.indexOf(right.document)
    || right.findingCount - left.findingCount || compareFindingIds(left.findingIds[0], right.findingIds[0]));
}

function repeatedCycles(cluster, recurrence) {
  return recurrence.get(cluster.id) || (cluster.source === 'none' ? recurrence.get(themeClusterId(cluster.document)) : 0) || 1;
}

/**
 * How many consecutive finding-bearing review cycles raised ANY of the cluster's
 * resolved units, however the reviewers worded each report, read from the signed
 * recurrence record's tally (a record's tally counts, per place, the cycles of
 * the current run of finding-bearing cycles that raised it).  A place is an
 * exact host unit (`exact|<unit id>`) or a set of quoted units
 * (`units|<id>,<id>`); the unit counts under either, and the largest count is
 * taken, so a unit that was raised once by id and once by quotation is never
 * counted twice.  A cluster that resolves no unit (a requirement, or a theme
 * about a whole document) has none to count: 0.  A cluster that does resolve a
 * unit was raised in the cycle that produced it, so the answer is at least 1
 * even for a brief built without a tally.  Pure and integer-only.
 */
export function unitRaisedCycles(cluster, tally) {
  const ids = new Set((Array.isArray(cluster?.units) ? cluster.units : []).map(unit => unit?.id).filter(id => typeof id === 'string' && id));
  if (!ids.size) return 0;
  let best = 1;
  for (const entry of Array.isArray(tally) ? tally : []) {
    if (typeof entry?.key !== 'string' || !Number.isSafeInteger(entry.cycles) || entry.cycles < 1) continue;
    const bar = entry.key.indexOf('|');
    const scope = entry.key.slice(0, bar); const place = entry.key.slice(bar + 1);
    const concerns = scope === 'exact' ? ids.has(place) : scope === 'units' ? place.split(',').some(id => ids.has(id)) : false;
    if (concerns && entry.cycles > best) best = entry.cycles;
  }
  return best;
}

/**
 * The two inputs a brief reads from the latest signed recurrence record: the
 * fingerprint streak of each cluster and the per-place tally.  A record of
 * another plan (or none) says nothing about this one.
 */
export function repairRecurrenceView(record, planDigest) {
  if (!record || record.planDigest !== planDigest) return { recurrence: new Map(), tally: [] };
  return {
    recurrence: new Map((Array.isArray(record.fingerprints) ? record.fingerprints : []).map(fingerprint => [fingerprint.clusterId, fingerprint.streak])),
    tally: Array.isArray(record.tally) ? record.tally : [],
  };
}

// Printed by the writer-stage contract: the caller interpolates these two
// sentences into the rule that explains context.blindRepairBrief.  Both are
// fixed host text: they name no document, candidate or posting, and no wording a
// writer could copy.
export const BLIND_REPAIR_RAISED_CYCLES_RULE = 'unitRaisedCycles counts the consecutive review cycles in which the cluster’s unit was raised, however the reviewers worded it. '
  + 'A unit raised in two or more cycles has failed to satisfy the reviewers by rewording: answer it by deleting or shortening the flagged sentence '
  + 'unless a function the host requires of that paragraph would be lost, and do not reuse any wording the previous repair used. '
  + `Among the functions the host requires of a cover-letter paragraph are these: ${HOST_REQUIRED_LETTER_FUNCTIONS}.`;
export const BLIND_REPAIR_TRUNCATION_RULE = 'issueTruncated and fixTruncated are true when the reviewer wording shown was shortened to fit the brief, on a sentence or clause boundary, '
  + 'with a fix’s sentences that say what must stay unchanged kept first; the whole finding stays recorded. Read a shortened fix as incomplete, and never drop a constraint it states.';

function briefCluster(cluster, textChars, streak, raised) {
  const issue = fitReviewerText(cluster.issue, textChars);
  const fix = fitReviewerText(cluster.fix, textChars, { constraintsFirst: true });
  return {
    id: cluster.id, document: cluster.document, track: cluster.track,
    unit: cluster.source === 'host-id' ? { kind: cluster.unitKind, id: cluster.units[0].id } : null,
    units: cluster.source === 'quoted-text' ? cluster.units : [],
    ...(cluster.anchor && cluster.source === 'host-requirement' ? { requirementId: cluster.anchor } : {}),
    findingCount: cluster.findingCount,
    findingIds: cluster.findingIds.slice(0, REPAIR_BRIEF_MAX_FINDING_IDS),
    ruleIds: cluster.ruleIds.slice(0, REPAIR_BRIEF_MAX_RULE_IDS),
    pinnedFields: cluster.concernedFields, legalEdits: cluster.legalEdits,
    ...(streak > 1 ? { repeatedCycles: streak } : {}),
    unitRaisedCycles: raised,
    ...(textChars > 0 ? { issue: issue.text, fix: fix.text } : {}),
    issueTruncated: issue.truncated, fixTruncated: fix.truncated,
  };
}

/**
 * The bounded table placed in front of the writer.  It shrinks by a fixed
 * ladder (REPAIR_BRIEF_TEXT_LADDER: the characters each of issue and fix may
 * use, halved at each step until the text is gone, then whole trailing
 * clusters) and says how many clusters it had to omit and how many characters
 * of each field it kept (`textChars`).  Omitted clusters are still covered by
 * the signed correction stream and by the fresh blind cycle that follows.
 *
 * `recurrence` maps a cluster id to its fingerprint streak, and `tally` is the
 * signed recurrence record's tally: both come from the latest record of this
 * plan (repairRecurrenceView).
 */
export function buildRepairBrief({ planDigest, findingAggregateDigest, findingCount, clusters, recurrence = new Map(), tally = [], maxBytes = REPAIR_BRIEF_MAX_BYTES } = {}) {
  const raised = clusters.map(cluster => unitRaisedCycles(cluster, tally));
  const rowsAt = new Map();
  const rowsFor = textChars => {
    if (!rowsAt.has(textChars)) {
      rowsAt.set(textChars, clusters.map((cluster, index) => briefCluster(cluster, textChars, repeatedCycles(cluster, recurrence), raised[index])));
    }
    return rowsAt.get(textChars);
  };
  const make = (textChars, keep) => {
    const rows = rowsFor(textChars).slice(0, keep);
    return sign({ version: REPAIR_CONVERGENCE_VERSION, kind: 'blind-repair-brief', planDigest, findingAggregateDigest, findingCount,
      clusterCount: clusters.length, omittedClusterCount: clusters.length - rows.length, textChars, clusters: rows });
  };
  for (const textChars of REPAIR_BRIEF_TEXT_LADDER) {
    const brief = make(textChars, clusters.length);
    if (utf8Bytes(brief) <= maxBytes) return brief;
  }
  const last = REPAIR_BRIEF_TEXT_LADDER[REPAIR_BRIEF_TEXT_LADDER.length - 1];
  let keep = clusters.length;
  while (keep > 0) {
    keep -= 1;
    const brief = make(last, keep);
    if (utf8Bytes(brief) <= maxBytes) return brief;
  }
  return make(last, 0);
}

/**
 * One fingerprint per anchored cluster (an exact host unit, or units the
 * findings quote), plus one per document for the findings that have no anchor
 * at all: those are only comparable as a document-wide theme.
 *
 * A fingerprint's `stems` are the defect's OWN words.  A pinned fingerprint (a
 * finding about a field no response can change) is identified by the field it
 * concerns, so it needs no wording at all to be recognised again.
 */
export function fingerprintClusters(clusters) {
  const anchored = clusters.filter(cluster => cluster.source !== 'none');
  const prints = anchored.map(cluster => ({
    clusterId: cluster.id,
    scope: cluster.source === 'host-id' || cluster.source === 'host-requirement' ? 'exact' : 'units',
    document: cluster.document, track: cluster.track, anchor: cluster.anchor, unitIds: cluster.units.map(unit => unit.id),
    stems: cluster.defectStems.slice(0, RECURRENCE_STEM_LIMIT), findingIds: cluster.findingIds.slice(0, REPAIR_BRIEF_MAX_FINDING_IDS),
    findingCount: cluster.findingCount, pinned: cluster.pinned, label: cluster.label,
    unitKind: cluster.unitKind, entityId: cluster.entityId, pinnedFields: cluster.concernedFields,
    snapshotPaths: cluster.snapshotPaths, entryPaths: cluster.entryPaths, legalEdits: cluster.legalEdits, issue: truncate(cluster.issue, 160),
    streak: 1,
  }));
  for (const document of DOCUMENT_ORDER) {
    const members = clusters.filter(cluster => cluster.source === 'none' && cluster.document === document);
    if (!members.length) continue;
    const counts = new Map();
    for (const cluster of members) for (const stem of cluster.defectStems) counts.set(stem, (counts.get(stem) || 0) + 1);
    const first = members[0];
    prints.push({
      clusterId: themeClusterId(document), scope: 'theme', document, track: first.track, anchor: null, unitIds: [],
      stems: rankedStems(counts), findingIds: first.findingIds.slice(0, REPAIR_BRIEF_MAX_FINDING_IDS),
      findingCount: members.reduce((total, cluster) => total + cluster.findingCount, 0), pinned: false, label: first.label,
      unitKind: null, entityId: null, pinnedFields: [], snapshotPaths: [], entryPaths: [], legalEdits: [], issue: truncate(first.issue, 160),
      streak: 1,
    });
  }
  return prints.slice(0, RECURRENCE_MAX_FINGERPRINTS);
}
export function themeClusterId(document) { return `theme:${document}`; }

function similarityFloor(fingerprint) {
  return fingerprint.scope === 'exact' ? RECURRENCE_EXACT_SIMILARITY
    : fingerprint.scope === 'units' ? RECURRENCE_UNIT_SIMILARITY : RECURRENCE_THEME_SIMILARITY;
}

/**
 * Does `current` continue `previous`, and how strongly (0 = it does not)?
 *
 * The same place: the same exact host unit, or a quoted unit in common, or the
 * same document theme.  Then the same defect: a pinned finding is the same when
 * it concerns a pinned field the earlier one concerned (the writer cannot
 * change that field, so a different wording is still the same objection); any
 * other finding is the same only when its own words agree.  A pinned and an
 * unpinned finding about one unit are never the same defect.
 */
function fingerprintContinuation(previous, current) {
  if (previous.scope !== current.scope || Boolean(previous.pinned) !== Boolean(current.pinned)) return 0;
  if (current.scope === 'exact') {
    if (previous.anchor !== current.anchor) return 0;
  } else {
    if (previous.document !== current.document) return 0;
    if (current.scope === 'units' && !previous.unitIds.some(id => current.unitIds.includes(id))) return 0;
  }
  if (current.pinned) return (previous.pinnedFields || []).some(field => (current.pinnedFields || []).includes(field)) ? 1 : 0;
  // Two findings are "the same words" when they share at least two stems, or
  // every stem of the shorter one if it is shorter than that.  A finding with
  // no stems at all has a similarity of zero, which no floor admits.
  const required = Math.min(RECURRENCE_MIN_SHARED_STEMS, (previous.stems || []).length, (current.stems || []).length);
  if (sharedStemCount(previous.stems, current.stems) < required) return 0;
  const similarity = stemSimilarity(previous.stems, current.stems);
  return similarity >= similarityFloor(current) ? similarity : 0;
}

/**
 * Extend each current fingerprint's streak from the immediately preceding
 * cycle: it continues only when that cycle raised the same defect about the
 * same place.  A cycle that does not raise it again resets it, so a defect the
 * writer fixed and a different one that replaced it never accumulate.
 */
export function advanceRecurrence(previousFingerprints, currentFingerprints) {
  const previous = Array.isArray(previousFingerprints) ? previousFingerprints : [];
  return currentFingerprints.map(current => {
    let best = null; let bestStrength = 0;
    for (const candidate of previous) {
      const strength = fingerprintContinuation(candidate, current);
      if (strength > bestStrength) { best = candidate; bestStrength = strength; }
    }
    return { ...current, streak: best ? Math.min(best.streak + 1, 1000) : 1 };
  });
}

/**
 * The fingerprints that end the loop.  A cluster about a unit with no legal
 * edit at all stops at once, a finding about a pinned field after the writer
 * has been shown its legal edits once, anything else after RECURRENCE_STREAK_STOP
 * cycles (a document-wide theme, the weakest evidence, after
 * RECURRENCE_THEME_STREAK_STOP).  When none of those names a cause, the
 * wording-independent bounds stop a run that keeps reporting something and is
 * not getting better (see recurrenceCapStop): `record` is the cycle's own
 * signed recurrence record, which carries the count, the per-cycle finding
 * counts and the tally those bounds read.
 */
export function repairEscalations(fingerprints, record = null) {
  const found = [];
  for (const fingerprint of fingerprints) {
    const noLegalEdit = fingerprint.scope === 'exact' && fingerprint.unitKind && fingerprint.legalEdits.length === 0;
    const reason = noLegalEdit ? 'no-legal-edit'
      : fingerprint.pinned && fingerprint.streak >= PINNED_RECURRENCE_STREAK_STOP ? 'pinned-recurrence'
        : fingerprint.streak >= (fingerprint.scope === 'theme' ? RECURRENCE_THEME_STREAK_STOP : RECURRENCE_STREAK_STOP) ? 'recurrence' : null;
    if (reason) found.push({ reason, fingerprint });
  }
  const rank = reason => HUMAN_STOP_REASONS.indexOf(reason);
  found.sort((left, right) => rank(left.reason) - rank(right.reason)
    || right.fingerprint.streak - left.fingerprint.streak
    || compareFindingIds(left.fingerprint.findingIds[0], right.fingerprint.findingIds[0]));
  if (!found.length) {
    const capped = recurrenceCapStop(record);
    if (capped) found.push({ reason: 'cycle-cap', ...capped, tally: Array.isArray(record.tally) ? record.tally : [] });
  }
  return found;
}

/**
 * Are the findings getting fewer?  True when the latest cycle's count is strictly
 * below the lowest count of the RECURRENCE_TREND_WINDOW cycles just before it
 * (fewer cycles when the run is shorter); a run with no earlier cycle to compare
 * against has not stopped improving.  `counts` is the record's per-cycle finding
 * counts, oldest first.  Pure and integer-only, so the signed record alone
 * decides it.
 */
export function findingCountsFalling(counts) {
  const list = Array.isArray(counts) ? counts : [];
  if (list.length < 2) return true;
  const recent = list.slice(Math.max(0, list.length - 1 - RECURRENCE_TREND_WINDOW), list.length - 1);
  return list[list.length - 1] < Math.min(...recent);
}

/**
 * The wording-independent stop, or null.  Two rules, in this order of meaning:
 * the HARD cap (RECURRENCE_CYCLE_CAP consecutive finding-bearing cycles, whatever
 * the trend) and the STALL stop (from RECURRENCE_STALL_MIN_CYCLES on, a latest
 * count of at least RECURRENCE_STALL_MIN_FINDINGS that is not falling).  It
 * reports which one fired (`basis`) and whether the findings were falling, so the
 * message a person reads can say so accurately.  Fail-closed in the direction
 * that matters: a record with no usable per-cycle counts can still reach the hard
 * cap, and can never reach the stall stop.
 */
function recurrenceCapStop(record) {
  const cycles = record?.findingCycles;
  if (!Number.isSafeInteger(cycles)) return null;
  const counts = Array.isArray(record.counts) ? record.counts.filter(count => Number.isSafeInteger(count)) : [];
  const falling = findingCountsFalling(counts);
  if (cycles >= RECURRENCE_CYCLE_CAP) return { cycles, counts, falling, basis: 'cap' };
  const latest = counts.length === cycles ? counts[counts.length - 1] : null;
  if (cycles >= RECURRENCE_STALL_MIN_CYCLES && Number.isSafeInteger(latest) && latest >= RECURRENCE_STALL_MIN_FINDINGS && !falling) {
    return { cycles, counts, falling, basis: 'stalled' };
  }
  return null;
}

// What a fingerprint is ABOUT, for the tally of how often each place was raised.
// A pinned and an unpinned finding about one unit are the same place here.
function fingerprintKey(fingerprint) {
  if (fingerprint.scope === 'exact') return `exact|${fingerprint.anchor}`;
  if (fingerprint.scope === 'units') return `units|${uniqueSorted(fingerprint.unitIds || []).join(',')}`;
  return `theme|${fingerprint.document}`;
}
function tallyLabel(fingerprint) {
  return fingerprint.scope === 'theme' ? `general findings about ${fingerprint.label}` : fingerprint.label;
}
// How many of the consecutive finding-bearing cycles raised each place, most
// often first, bounded and deterministic.  Places raised in an earlier cycle and
// not in this one keep their count: the cap speaks of the whole run.
function mergeTally(previous, fingerprints) {
  const counts = new Map((Array.isArray(previous) ? previous : []).map(entry => [entry.key, { key: entry.key, label: entry.label, cycles: entry.cycles }]));
  const seen = new Set();
  for (const fingerprint of fingerprints) {
    const key = fingerprintKey(fingerprint);
    if (seen.has(key)) continue;
    seen.add(key);
    counts.set(key, { key, label: truncate(tallyLabel(fingerprint), REPAIR_LABEL_MAX_CHARS * 2), cycles: (counts.get(key)?.cycles || 0) + 1 });
  }
  return [...counts.values()].sort((left, right) => right.cycles - left.cycles || (left.key < right.key ? -1 : 1)).slice(0, RECURRENCE_TALLY_MAX);
}

export function createRepairRecurrenceRecord({ planDigest, previous = null, findingCount, fingerprints }) {
  // A cycle with no finding ends the consecutive run; the tally and the
  // per-cycle counts start over.
  const bearing = findingCount > 0;
  return sign({ version: REPAIR_CONVERGENCE_VERSION, kind: 'blind-review-recurrence', planDigest,
    cycle: (previous?.cycle || 0) + 1, previousDigest: previous?.digest ?? null, findingCount,
    findingCycles: bearing ? (previous?.findingCycles || 0) + 1 : 0,
    counts: bearing ? [...(Array.isArray(previous?.counts) ? previous.counts : []), findingCount].slice(-RECURRENCE_COUNTS_MAX) : [],
    tally: bearing ? mergeTally(previous?.tally, fingerprints) : [],
    fingerprints });
}
export function assertRepairRecurrenceRecord(record) {
  if (record?.kind !== 'blind-review-recurrence' || record?.version !== REPAIR_CONVERGENCE_VERSION
    || !/^[a-f0-9]{64}$/u.test(record?.planDigest || '') || !Number.isSafeInteger(record?.cycle) || record.cycle < 1
    || !Number.isSafeInteger(record?.findingCycles) || record.findingCycles < 0 || record.findingCycles > record.cycle
    // The per-cycle counts: one per finding-bearing cycle of the run (the last
    // RECURRENCE_COUNTS_MAX of them), each a positive count, the newest being this
    // cycle's own signed findingCount, and none at all after a clean cycle.
    || !Array.isArray(record?.counts) || record.counts.length !== Math.min(record.findingCycles, RECURRENCE_COUNTS_MAX)
    || !record.counts.every(count => Number.isSafeInteger(count) && count >= 1)
    || (record.findingCycles > 0 && record.counts[record.counts.length - 1] !== record.findingCount)
    || !Array.isArray(record?.tally) || record.tally.length > RECURRENCE_TALLY_MAX
    || !record.tally.every(entry => typeof entry?.key === 'string' && typeof entry?.label === 'string' && Number.isSafeInteger(entry?.cycles) && entry.cycles >= 1 && entry.cycles <= record.findingCycles)
    || !Array.isArray(record?.fingerprints) || record.digest !== authorityDigest(unsigned(record))) {
    throw new Error('The blind-review recurrence record is malformed or unauthenticated.');
  }
  return record;
}

// Bump BLIND_REVIEW_HUMAN_STOP_VERSION in the caller with ANY change to the
// wording below: the host re-derives a stored stop from its signed recurrence
// record on every load, and a stop signed under other wording must fail closed.
const FIELD_NOUNS = Object.freeze({ items: 'items', dates: 'dates' });
function fieldList(fields) {
  const names = fields.map(field => FIELD_NOUNS[field] || field);
  return names.length > 2 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join(' and ');
}

const STOP_KEPT = 'The findings stay recorded in the blind-review receipts; the app never waives them. Then press Generate.';

// The cap names no cause: the reviewers never worded one defect the same way
// twice running.  What a person can act on is WHERE the reports keep landing,
// and whether the number of findings was coming down, so the sentence says
// which: a run that stopped because it stopped improving, one that reached the
// hard bound while still improving, and one that reached it without improving
// are three different things to a person deciding what to do next.
function describeFindingTrend({ cycles, counts, falling, basis }) {
  if (!counts.length) return '';
  // The comparison findingCountsFalling() made, stated with its own numbers, so
  // the sentence is exactly as strong as the rule that fired and no stronger.
  const latest = counts[counts.length - 1];
  const recent = counts.slice(Math.max(0, counts.length - 1 - RECURRENCE_TREND_WINDOW), counts.length - 1);
  const before = recent.length === 1 ? 'the cycle' : `the lowest of the ${recent.length} cycles`;
  const comparison = recent.length
    ? `the latest reported ${latest}, ${falling ? 'fewer than' : 'no fewer than'} ${before} just before it (${recent.join(', ')})`
    : `the latest reported ${latest}`;
  const trend = `The findings ${falling ? 'were still trending down' : 'had stopped trending down'}: the cycles reported ${counts.join(', ')} findings, and ${comparison}.`;
  return basis === 'stalled'
    ? trend
    : `${trend} The app also stops any run at ${RECURRENCE_CYCLE_CAP} consecutive cycles that each reported something, and this run reached ${cycles}.`;
}

function describeCycleCapStop({ cycles, tally, counts = [], falling = false, basis = 'cap' }) {
  const top = tally.slice(0, RECURRENCE_STOP_MAX_ITEMS);
  const listed = top.map(entry => `${entry.label} (${entry.cycles} of ${cycles} cycles)`);
  return {
    reason: 'cycle-cap', streak: cycles, trend: falling ? 'falling' : 'not-falling', basis, counts,
    message: [
      `Independent reviewers reported defects in ${cycles} consecutive review cycles, with the documents revised between them, yet no single defect was worded the same way twice running, so the app stopped instead of looping.`,
      describeFindingTrend({ cycles, counts, falling, basis }),
      listed.length ? `Most often reported: ${listed.join('; ')}.` : '',
      'Read the latest findings against the documents, and correct the source career data or the posting if a defect traces to either.',
      STOP_KEPT,
    ].filter(Boolean).join(' '),
    findings: top.map(entry => ({ key: entry.key, label: entry.label, cycles: entry.cycles })),
  };
}

/**
 * The typed, human-facing stop.  It names the finding and the unit (by what a
 * person calls it, never by an internal id) and, for a finding about a pinned
 * field, the exact career-snapshot field to edit; for a required entry said to
 * be unneeded, that the app requires it, which edit of the snapshot entry or
 * the posting ends the requirement, and that the finding needs a person's
 * judgment.  It says that the findings stay recorded, never suggests accepting a
 * flagged claim, and carries no instruction a model could follow.
 *
 * The host re-derives this text from the signed recurrence record every time
 * it reopens a stopped job, so a stored stop can neither be edited nor
 * invented.  Changing the wording below therefore requires a new terminal
 * version in the caller (BLIND_REVIEW_HUMAN_STOP_VERSION).
 */
export function describeRepairStop(escalations) {
  if (!escalations.length) return null;
  const reason = escalations[0].reason;
  if (reason === 'cycle-cap') return describeCycleCapStop(escalations[0]);
  const items = escalations.filter(entry => entry.reason === reason).slice(0, RECURRENCE_STOP_MAX_ITEMS);
  const labels = items.map(({ fingerprint }) => `${fingerprint.label} (finding ${fingerprint.findingIds[0]})`);
  const paths = uniqueSorted(items.flatMap(({ fingerprint }) => fingerprint.snapshotPaths));
  const entryPaths = uniqueSorted(items.flatMap(({ fingerprint }) => fingerprint.entryPaths || []));
  const concerned = [...new Set(items.flatMap(({ fingerprint }) => fingerprint.pinnedFields))];
  // "presence" is a host requirement, not a snapshot field: the app insists
  // the entry stay.  Every other pinned field is copied exactly from the
  // approved career snapshot.
  const copied = concerned.filter(field => field !== 'presence');
  const requiredItems = items.filter(({ fingerprint }) => fingerprint.pinnedFields.includes('presence'));
  const many = requiredItems.length > 1;
  const pinnedSentence = [
    copied.length ? `The approved career snapshot supplies its ${fieldList(copied)} verbatim, so no pasted response can change ${copied.length === 1 && !FIELD_NOUNS[copied[0]] ? 'it' : 'them'}.` : '',
    requiredItems.length ? `The app requires ${many ? 'these entries' : 'this entry'} to stay because the host selected ${many ? 'them' : 'it'} as the proof of a highest-priority requirement of the posting, so no pasted response can remove ${many ? 'them' : 'it'}. Either that selection or the finding is wrong.` : '',
  ].filter(Boolean).join(' ');
  const streak = Math.max(...items.map(({ fingerprint }) => fingerprint.streak));
  const edit = [
    paths.length ? `Edit ${paths.join(', ')} in the approved career snapshot if the finding is right` : '',
    requiredItems.length ? `If ${many ? 'these entries do' : 'this entry does'} not belong in this application, edit or remove ${entryPaths.length ? entryPaths.join(', ') : (many ? 'their entries' : 'its entry')} in the approved career snapshot, or change what the posting asks for; if ${many ? 'they do' : 'it does'} belong, the finding needs your judgment` : '',
  ].filter(Boolean).join('. ') || 'Correct the source career data or the posting if the defect traces to either';
  const kept = STOP_KEPT;
  const message = reason === 'no-legal-edit'
    ? [`Independent reviewers flagged ${labels.join('; ')}, which has no edit a pasted response may make.`, pinnedSentence,
      'The app stopped instead of asking for an edit that cannot be made.', `${edit}.`, kept].filter(Boolean).join(' ')
    : reason === 'pinned-recurrence'
      ? [`Independent reviewers flagged ${labels.join('; ')} in ${streak} consecutive review cycles, including after the writer was shown every edit the app allows for it.`,
        pinnedSentence, `${edit}.`, kept].filter(Boolean).join(' ')
      : [`Independent reviewers raised the same kind of defect about ${labels.join('; ')} in ${streak} consecutive review cycles, with the documents revised each time, so the app stopped instead of looping.`,
        `${edit}.`, kept].join(' ');
  return {
    reason, message, streak,
    findings: items.map(({ fingerprint }) => ({
      clusterId: fingerprint.clusterId, findingIds: fingerprint.findingIds, document: fingerprint.document, track: fingerprint.track,
      unit: fingerprint.scope === 'exact' ? { kind: fingerprint.unitKind, id: fingerprint.entityId || fingerprint.anchor } : null,
      pinnedFields: fingerprint.pinnedFields, snapshotPaths: fingerprint.snapshotPaths, entryPaths: fingerprint.entryPaths || [], legalEdits: fingerprint.legalEdits,
      streak: fingerprint.streak, issue: fingerprint.issue,
    })),
  };
}
