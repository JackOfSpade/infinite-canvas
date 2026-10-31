// Deterministic, dependency-free checks for the cover-letter argument harness.
// Keep this module free of Electron/LLM/fs imports: the checks are deliberately
// usable from the Node smoke suite and from the application pipeline.
import { enDashIsRange } from './dashRanges.js';
import { careerRoleDateInputs, parseCareerDate } from './jobFitAssessment.js';

const MIN_EVIDENCE_SHINGLE_WORDS = 5;
const MIN_EVIDENCE_TOKEN_OVERLAP = 0.6;
// The cover-letter contract prints this, so a writer knows how long a run it
// may share with a bullet before the letter is restating the résumé.
export const REDUNDANCY_SHINGLE_WORDS = 8;
const MAX_REDUNDANCY_PHRASE_WORDS = 24;
const MAX_CHECK_DETAIL_VALUE_CHARS = 160;
export const MAX_LETTER_FIGURES = 3;
const MAX_FIGURE_DETAIL_ITEMS = 12;
const MAX_GENERIC_OBSERVATIONS = 12;
export const MAX_LOGISTICS_CONTAINMENT_OBSERVATIONS = 8;
export const MAX_HYPHENATION_OBSERVATIONS = 8;
export const MAX_ANCHOR_RELEVANCE_OBSERVATIONS = 8;
const MAX_ADDITIVE_SEAM_OBSERVATIONS = 4;
const MAX_RESPONSIBILITY_TRANSITION_OBSERVATIONS = 4;
const MAX_POSTING_REFERENCE_OBSERVATIONS = 4;
const MAX_CLAIMED_EQUIVALENCE_OBSERVATIONS = 4;
const MAX_SENTENCE_LENGTH_OBSERVATIONS = 5;
const MAX_PUNCTUATION_OBSERVATIONS = 8;
const MAX_PLAIN_REGISTER_OBSERVATIONS = 4;
const MAX_OPENING_DEMONSTRATIVE_OBSERVATIONS = 4;
const MAX_PARAGRAPH_OPENER_OBSERVATIONS = 4;
const MAX_PARALLEL_STRUCTURE_OBSERVATIONS = 8;
const MAX_EXPERIENCE_FRAMING_OBSERVATIONS = 4;
const MAX_REFERENCE_CLARITY_OBSERVATIONS = 8;
const MAX_COPY_PRECISION_OBSERVATIONS = 4;
const MAX_STANDALONE_INTRODUCTION_OBSERVATIONS = 4;
const MAX_TARGET_CLAIM_SCOPE_OBSERVATIONS = 4;
export const MAX_SENTENCE_WORDS = 40;
// One off-posting tool name is a paragraph's single concrete anchor; a second
// one is a stack list. Across the letter, three names is a stack tour even
// when they are spread one per paragraph.
export const MAX_PARAGRAPH_OFF_POSTING_TOOLS = 1;
export const MAX_LETTER_OFF_POSTING_TOOLS = 2;
// Absence of a tool name is evidence only when the corpus is an actual posting
// description. The pipeline builds that corpus from title/company/location/
// salary/description, and an unscraped description is a first-class supported
// state, so a job with no description still supplies roughly ten to
// twenty-five words of metadata: non-empty, but silent about the stack. Below
// this floor the check skips rather than reading every name in the letter as
// off-posting.
export const MIN_ANCHOR_RELEVANCE_CORPUS_WORDS = 60;
// A thesis shorter than this is a fragment, not a controlling claim. Exported
// so the cover-letter contract prints the floor the thesis gate applies
// rather than a hand-copied number beside it.
export const MIN_ROLE_THESIS_WORDS = 6;
// How much of a sentence is compared as a shape. Five skeleton elements is
// what separated a template from parallelism on the measured corpus: four
// elements admitted frames too short to be distinctive, and six stopped
// judging sentences whose whole skeleton is shorter than that, which is most
// short sentences. Exported so the letter contract prints the window this
// check actually reads.
export const SENTENCE_SHAPE_FRAME_WORDS = 5;
// A window that is mostly wildcard carries no shape worth comparing, so a
// frame needs this many literal function words among its elements before two
// paragraphs sharing it means anything.
const MIN_SENTENCE_SHAPE_FUNCTION_WORDS = 3;
// Below this many paragraphs, a shared sentence shape is the whole letter
// speaking with one voice rather than a template, and there is no repair to
// ask for. Exported for the same reason as the window above.
export const MIN_SHARED_SHAPE_PARAGRAPHS = 3;
// The most repeated shapes one rejection names. Every shape over the ceiling
// is the same defect class, so the message carries them together and one round
// can clear them; the cap only bounds a letter templated at more positions
// than a message can usefully list, and that letter is told more remain.
const MAX_REPEATED_SHAPE_OBSERVATIONS = 4;
// How long a verbatim run has to be before the letter is restating itself.
// Two floors, because the distance between the two occurrences is what decides
// when an echo reads as restatement: inside one paragraph the first statement
// is still in the reader's head when the second arrives, so three words
// already land as the same thing said twice, while across paragraphs the
// reader has moved on and three words of ordinary English recur without
// anybody noticing. Exported so the letter contract prints the two floors this
// check actually applies instead of a hand-copied pair beside them.
export const MIN_SAME_PARAGRAPH_REPEAT_WORDS = 3;
export const MIN_CROSS_PARAGRAPH_REPEAT_WORDS = 4;
// How much of a run has to be CONTENT before repeating it is the letter saying
// one thing twice. A run at either floor above is short enough to be nothing
// but the syntax English gives a sentence, and the first build of this check had
// no such test, so a sweep of the reported runs found six inside one paragraph
// ("one of the", "in order to", "there was no", "that had to be", "as well as
// the", "i worked on the") and four across paragraphs at the wider floor
// ("i was able to", "at the same time", "the work had to", "was one of the
// things"). The check's own message used to call a reported run "the same
// statement made twice", which is simply untrue of every one of those, and each
// would have cost a manual handoff round; the message states what it measured
// now, for a second reason recorded above checkRepeatedPhrase.
//
// Two, not one, and not "every word is a function word". Measured: all ten of
// those runs carry either no content word or exactly one, while the three real
// repeats in the same letter carry two (a sentence frame around a topic noun),
// three (a topic phrase restated across a clause boundary) and three (a
// compound product category named twice in three sentences). So two is the
// boundary the measurement draws, and the stricter
// all-function-words test would have excused only three of the ten. The reason
// it lands there rather than anywhere else: one content word inside a run this
// short is a topic word sitting in the frame the language gives it, and a topic
// recurs in a paragraph about it; a statement takes two content terms, a thing
// and what is said of it, before saying it again can be saying it twice.
export const MIN_REPEAT_CONTENT_WORDS = 2;
// The most repeated runs one rejection names. Every run over a floor is the
// same defect class, so they travel in one message and one handoff round can
// clear the class; the cap only bounds a letter that restates itself at more
// places than a message can usefully list, and that letter is told more
// remain.
const MAX_REPEATED_PHRASE_OBSERVATIONS = 4;
// longestSharedRun answers with ONE run per pair of spans, so a run this check
// excuses would stand in front of every shorter repeat in the same pair and
// hide it. An excused run is blanked out of both spans and the pair is asked
// again, up to this many times. Three is past anything the measured letters
// have shown in one sentence pair, and the bound is what keeps a pathological
// span from looping.
const MAX_EXCUSED_RUN_PEELS = 3;
const OBSERVATION_SNIPPET_WORDS = 8;

export const BANNED_GENERIC_PHRASES = Object.freeze([
  'writing to express my interest',
  'proven track record',
  'fast-paced environment',
  'passionate about',
  'hit the ground running',
  'align with your values',
  'team player',
  'i believe i would be a great fit',
  'dynamic environment',
  'wealth of experience',
]);

// Keep these deliberately narrow.  The literal list above catches stock
// wording; these patterns close the common modifier insertion escape hatches
// without attempting to score prose sentiment or style.  They are expressed
// over `genericWords(...).join(' ')`, so punctuation and hyphen variants do
// not create a second way around the check.
export const BANNED_GENERIC_PATTERNS = Object.freeze([
  { phrase: 'proven … track record', pattern: /\bproven(?:\s+\p{L}+){0,3}\s+track record\b/u },
  { phrase: 'more than basic presence', pattern: /\bmore than(?:\s+just)?\s+basic presence\b/u },
  { phrase: 'primary line of defense', pattern: /\b(?:the )?primary line of defense\b/u },
  { phrase: 'exact foundation', pattern: /\b(?:this|that|the) exact foundation\b/u },
  // Hollow balance: a claimed view of “downsides and trade-offs” asserts
  // judgment without exercising any. Only the fixed doublet is listed, and
  // deliberately so: a wider “<downside noun> … as well as <upside noun>”
  // frame also fires on sentences that state a real judgment (“I documented
  // the benefits of the rollout as well as its limitations”),
  // and this id is not a soft check everywhere. localAiApplication.js throws on
  // it and rejects a completed Local AI run, so an entry here has to be as
  // literal as “hit the ground running”.
  { phrase: 'downsides and trade-offs', pattern: /\b(?:downsides?|drawbacks?) and trade offs?\b/u },
]);

export const BANNED_OPENERS = Object.freeze([
  'i am writing to express my interest',
  'i am writing to apply',
  "i'm writing to apply",
  'i am applying for',
  "i'm applying for",
  'i would like to apply',
  "i'd like to apply",
  'i am eager to apply',
  "i'm eager to apply",
  'i am submitting my application',
  "i'm submitting my application",
  'please accept my application',
  'i am excited to apply',
  'i believe i would be a great fit',
]);

// This is deliberately a small, explicit lexicon rather than an attempted
// part-of-speech tagger. `My experience to date` is grammatical, while the
// high-frequency cover-letter verbs below are not grammatical after "My
// experience to". Keeping the set narrow prevents a prose-quality check from
// turning defensible constructions into revision work.
const EXPERIENCE_TO_GERUNDS = Object.freeze({
  analyze: 'analyzing', apply: 'applying', assess: 'assessing', build: 'building',
  communicate: 'communicating', conduct: 'conducting', coordinate: 'coordinating',
  create: 'creating', deliver: 'delivering', develop: 'developing', enforce: 'enforcing',
  ensure: 'ensuring', handle: 'handling', implement: 'implementing', improve: 'improving',
  investigate: 'investigating', lead: 'leading', maintain: 'maintaining', manage: 'managing',
  monitor: 'monitoring', operate: 'operating', patrol: 'patrolling', perform: 'performing',
  protect: 'protecting', resolve: 'resolving', respond: 'responding', secure: 'securing',
  supervise: 'supervising', support: 'supporting', train: 'training', work: 'working',
});

function text(value) {
  // Normalize typographic variants before every comparison.  The model and the
  // résumé renderer do not necessarily choose the same apostrophe/dash glyph;
  // treating those glyphs as different would let copied prose evade the
  // shingle check and would reject otherwise-verbatim evidence.
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

// Job boards often append an all-caps shorthand to the employer's display
// name. It is useful metadata, but spelling it out in a salutation is an
// unnecessary introduction to the team receiving the letter. This is strictly
// a salutation display rule. The body identity helper below exposes the same
// normalized spelling while callers retain the unmodified job.company value.
const TRAILING_PARENTHESIZED_ACRONYM_RE = /^(.*?)\s+\(\s*([A-Z0-9.&/+_-]+)\s*\)$/u;

// The same display rule covers a legal-entity suffix: "Dear Reddit, Inc.
// Hiring Team" reads like a contract, not a letter. Only abbreviated or purely
// legal forms strip; "Company" and "Co." stay because they are often part of
// the name people actually say ("The Walt Disney Company").
const SALUTATION_LEGAL_SUFFIX_RE = /[,\s]+(?:incorporated|corporation|limited|l\.l\.c\.?|llc|inc\.?|ltd\.?|corp\.?|plc|gmbh|pbc)\s*$/iu;

export function normalizedCompanyDisplayName(value = '') {
  const company = text(value);
  const match = TRAILING_PARENTHESIZED_ACRONYM_RE.exec(company);
  // Require an actual initialism rather than removing a one-letter or numeric qualifier.
  const acronymCharacters = match ? match[2].replace(/[^A-Z0-9]/g, '') : '';
  const withoutAcronym = match && acronymCharacters.length >= 2 && /[A-Z]/.test(acronymCharacters) ? text(match[1]) : company;
  const withoutSuffix = withoutAcronym.replace(SALUTATION_LEGAL_SUFFIX_RE, '').trim();
  return withoutSuffix || withoutAcronym;
}

/** Body identity variants share the salutation's exact suffix/initialism
 * normalization without changing its punctuation-based neutral greeting. */
export function targetCompanyNames(value = '') {
  return targetCompanyNameForms(value).map(form => form.name);
}

/** Frozen, pre-separator and normalized display forms of the target name. */
export function targetCompanyNameForms(value = '') {
  const company = typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/gu, ' ').trim() : '';
  const forms = [company, company.split(/\s+[-–—|]\s+/u)[0]];
  return [...new Set(forms.flatMap(name => [name, normalizedCompanyDisplayName(name)]).filter(Boolean))]
    .map(name => ({ name }));
}

// A salutation greets the employer by its main name. Any trailing
// parenthetical a board appends ("(A Parent Lab)", "(Canada)") and branding
// pictographs are display decoration there; the job company value and the
// body identity forms above keep them.
const SALUTATION_TRAILING_PARENTHETICAL_RE = /\s*\([^()]*\)\s*$/u;
const SALUTATION_PICTOGRAPH_RE = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;

function salutationCompanyName(value = '') {
  const plain = text(text(value).replace(SALUTATION_PICTOGRAPH_RE, ' '));
  const mainName = text(plain.replace(SALUTATION_TRAILING_PARENTHETICAL_RE, '')) || plain;
  const displayName = normalizedCompanyDisplayName(mainName);
  // The host owns this field, so a writer cannot repair punctuation copied
  // from a board's employer display name. Use the neutral salutation instead
  // of altering the employer's name or spending every correction on it.
  return /[\u2014\u2013;]|\s-\s/u.test(displayName) ? '' : displayName;
}

// Cover letters identify their preparation period without implying a
// day-specific event. Keep the presentation format shared by API and Local AI
// authoring paths so their envelopes satisfy the same document contract.
export function formatCoverLetterDate(date = new Date()) {
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
}

function normalized(value) {
  // Locale-sensitive lowercasing makes check results depend on the host
  // locale (notably for `I` in a Turkish locale). These checks need stable,
  // document-independent comparison semantics.
  return text(value).toLowerCase();
}

// Named rather than inlined because two readers need the same token
// boundaries: `words()` below, and the repetition check, which has to know
// where each token starts in the source string so it can drop the words a
// stock carrier occupies. A second copy of this pattern would be a second
// tokenizer, and the two would disagree on the first hyphenated or possessive
// word that mattered.
const WORD_TOKEN_RE = /[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu;

function words(value) {
  return normalized(value).match(WORD_TOKEN_RE) || [];
}

function wordCount(value) {
  return words(value).length;
}

// Generic-phrase matching is intentionally stricter than a substring search:
// “unproven track record” and “team players” are not the banned clichés. For
// this one check, treat a hyphen as a separator too so `fast paced` cannot
// evade the configured `fast-paced environment` wording.
function genericWords(value) {
  return words(value).flatMap(word => word.split('-').filter(Boolean));
}

function containsWordSequence(haystack, needle) {
  if (!needle.length || needle.length > haystack.length) return false;
  return haystack.some((_, index) => needle.every((word, offset) => haystack[index + offset] === word));
}

function longestSharedRun(leftWords, rightWords) {
  if (!leftWords.length || !rightWords.length) return { length: 0, words: [] };
  const rightIndexes = new Map();
  rightWords.forEach((word, index) => {
    const indexes = rightIndexes.get(word) || [];
    indexes.push(index);
    rightIndexes.set(word, indexes);
  });
  let longest = { length: 0, words: [] };
  leftWords.forEach((word, leftIndex) => {
    for (const rightIndex of rightIndexes.get(word) || []) {
      let run = 0;
      while (leftWords[leftIndex + run] && leftWords[leftIndex + run] === rightWords[rightIndex + run]) run++;
      if (run > longest.length) {
        longest = { length: run, words: leftWords.slice(leftIndex, leftIndex + run) };
      }
    }
  });
  return longest;
}

function sharedRunLength(leftWords, rightWords) {
  return longestSharedRun(leftWords, rightWords).length;
}

export function boundedDetailValue(value) {
  const full = text(value);
  const visible = full.slice(0, MAX_CHECK_DETAIL_VALUE_CHARS);
  return `${visible}${full.length > visible.length ? ' …' : ''}`;
}

function quotedRunPhrase(runWords) {
  const phrase = runWords.slice(0, MAX_REDUNDANCY_PHRASE_WORDS).join(' ');
  const visible = boundedDetailValue(phrase);
  return `“${visible}${runWords.length > MAX_REDUNDANCY_PHRASE_WORDS && !visible.endsWith(' …') ? ' …' : ''}”`;
}

function tokenOverlap(leftWords, rightWords) {
  if (!leftWords.length) return 0;
  const remaining = new Map();
  rightWords.forEach(word => remaining.set(word, (remaining.get(word) || 0) + 1));
  let matches = 0;
  leftWords.forEach(word => {
    const count = remaining.get(word) || 0;
    if (count > 0) {
      matches++;
      remaining.set(word, count - 1);
    }
  });
  return matches / leftWords.length;
}

function result(id, passed, detail) {
  return { id, passed, detail };
}

// How many observations a failed row carries, kept OFF the row's enumerable
// fields so a row still serialises, compares and spreads as { id, passed,
// detail }. A row whose count is lost (a spread copy, a structured clone)
// counts as one observation, which only understates an advisory record.
function withObservationCount(row, count) {
  Object.defineProperty(row, 'observationCount', { value: count, enumerable: false });
  return row;
}

// A row that mixes a truth/hygiene half with a taste half keeps its legacy
// shape (id, passed = every half passed, detail = every observation) and
// carries its halves as `parts`: [{ id, passed, detail, observationCount }],
// each under an id of its own so the disposition table can give each half a
// different verdict (see partitionCheckResults). Non-enumerable for the same
// reason as the count above, and with the same fail-safe: a copy that loses
// `parts` is read as the whole row under the whole row's id, which is the
// pre-split behaviour.
function withParts(row, parts) {
  Object.defineProperty(row, 'parts', {
    value: Object.freeze(parts.map(part => Object.freeze({
      id: part.id,
      passed: part.passed,
      detail: part.detail,
      observationCount: part.passed ? 0 : Math.max(1, part.observationCount ?? 1),
    }))),
    enumerable: false,
  });
  return row;
}

function bulletTexts(evidence) {
  return Array.isArray(evidence?.bulletTexts) ? evidence.bulletTexts.filter(Boolean).map(text) : [];
}

const GENERIC_THESIS_PATTERNS = Object.freeze([
  { label: 'generic fit claim', pattern: /\b(?:strong|great|ideal|excellent|perfect)\s+(?:fit|candidate)\b/iu },
  { label: 'generic qualification claim', pattern: /\b(?:qualified|well[- ]suited)\s+for\b/iu },
  { label: 'generic alignment claim', pattern: /\b(?:background|experience|skills|qualifications)\b.{0,60}\b(?:aligns?|matches?|fits?)\b/iu },
  { label: 'generic blend claim', pattern: /\b(?:unique|strong)\s+blend\s+of\b/iu },
]);

// Intl.Segmenter ends a sentence after any period that is followed by a
// capital letter, an opening bracket or a digit, and it has no list of
// abbreviations (the ICU suppression data is not reachable through the
// locale tag on this runtime). A person's title, a place, a degree and a
// section number are each written with such a period, so “Dr. Rao”,
// “St. Louis”, “E.T.H. Zurich”, “B.Com. (Hons.)” and “Sec. 4.2” each came back
// as two sentences, and every count that reads sentences (the six-sentence
// paragraph ceiling, the share of sentences in the writer's voice, the
// standalone-sentence allowance) was inflated by the credentials and
// affiliations a candidate legitimately names. The guard below joins a segment
// back onto the one after it when the segment ends in an abbreviation AND the
// next one does not open the way a sentence opens. It reads only the shape of
// the last token and the first word of the next segment, so it names no
// person, employer or field.
//
// Words that are an abbreviation only when written with a period: titles,
// ranks, company suffixes, document-structure labels and the Latin shorthand
// that carries its own periods is matched by shape instead (below).
const SENTENCE_ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'mx', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'ft', 'gen', 'gov', 'hon', 'rev', 'lt', 'col', 'sgt', 'capt', 'cmdr', 'sen', 'rep', 'pres',
  'inc', 'ltd', 'co', 'corp', 'llc', 'plc', 'dept', 'univ', 'assn', 'assoc',
  'sec', 'fig', 'no', 'nos', 'vol', 'eq', 'art', 'ch', 'pp', 'ref', 'approx', 'est', 'vs', 'ave', 'blvd', 'rd',
]);
// A month written short is an abbreviation only before the day or year it
// names, never before a word.
const MONTH_ABBREVIATIONS = new Set(['jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec']);
// The words a sentence opens with. A period after an abbreviation followed by
// one of these ends the sentence (“… worked at Acme Inc. Our team …”), and
// that is the only evidence of an end this guard honours; anything else
// capitalised is read as the name or noun the abbreviation introduces.
const SENTENCE_OPENERS = new Set([
  'i', 'we', 'my', 'our', 'me', 'us', 'he', 'she', 'they', 'it', 'its', 'you', 'your', 'there', 'here',
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'each', 'every', 'all', 'both', 'some', 'many', 'most', 'one', 'two', 'three', 'no', 'not',
  'in', 'at', 'on', 'as', 'after', 'before', 'during', 'since', 'for', 'with', 'from', 'by', 'to', 'of', 'over', 'under', 'through', 'across', 'within', 'without', 'about',
  'and', 'but', 'so', 'or', 'yet', 'if', 'when', 'while', 'because', 'although', 'though', 'once', 'until', 'whether',
  'then', 'now', 'today', 'previously', 'recently', 'later', 'earlier', 'currently', 'also', 'however', 'finally', 'first', 'second', 'next', 'last', 'overall', 'additionally', 'meanwhile', 'together',
  'what', 'why', 'how', 'who', 'where', 'which', 'thank', 'please', 'dear', 'sincerely', 'regards',
]);

// A company suffix ends the name before it, and a title (“Mr.”, “Dr.”) opens the
// name of a person: “… worked at Acme Corp. Mr. Singh hired me” has its end
// after “Corp.”, where “… Corp. Singh” would continue a name.
const COMPANY_SUFFIX_ABBREVIATIONS = new Set(['inc', 'ltd', 'co', 'corp', 'llc', 'plc']);
const TITLE_ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'mx', 'dr', 'prof', 'sr', 'jr']);

function endsInAbbreviationPeriod(segment) {
  // The token the segment ends on, without the brackets and quotes that can
  // follow its period: “… (see Sec.” and “… from E.T.H.” end on a period.
  const token = String(segment).trimEnd().split(/\s+/u).pop() || '';
  const core = token.replace(/^[(["'“‘]+/u, '');
  if (!core.endsWith('.')) return null;
  const bare = core.slice(0, -1);
  if (!bare) return null;
  const lower = bare.toLowerCase();
  if (COMPANY_SUFFIX_ABBREVIATIONS.has(lower)) return 'company';
  if (SENTENCE_ABBREVIATIONS.has(lower)) return 'word';
  if (MONTH_ABBREVIATIONS.has(lower)) return 'month';
  // A run of dotted letters (“E.T.H.”, “B.Com.”, “U.S.”, “Ph.D.”, “e.g.”).
  if (/^(?:\p{L}{1,4}\.)+\p{L}{1,4}$/u.test(bare)) return 'dotted';
  // A single capital initial (“J. Smith”).
  if (/^\p{Lu}$/u.test(bare)) return 'initial';
  return null;
}

function firstWordOf(segment) {
  // A currency symbol is part of the amount that follows it (“approx. $2M”), not a word of its own.
  return (String(segment).replace(/^[\s("'“‘[$€£¥]+/u, '').match(/^[\p{L}\p{N}][\p{L}\p{N}'-]*/u) || [''])[0];
}

// Abbreviations that open a PERSON's name ("Dr. Fielding", "Sen. Harding"):
// the capitalized word after them is that name whatever its ending.
const PERSON_TITLE_ABBREVIATIONS = new Set([...TITLE_ABBREVIATIONS, 'gen', 'gov', 'hon', 'rev', 'lt', 'col', 'sgt', 'capt', 'cmdr', 'sen', 'rep', 'pres']);
// A capitalized gerund or participle ("Leading its refund queue ...",
// "Enrolling 140 patients ...", "Trained by ...") opens a sentence the way a
// pronoun does; a name or a noun an abbreviation introduces rarely has that shape.
const CAPITALIZED_VERB_FORM = /^\p{Lu}\p{Ll}+(?:ing|ed)$/u;

/**
 * How the segment after an abbreviation period relates to it: 'join' (the
 * period is inside the sentence: “Dr. Rao”, “Sec. 4.2”), 'end' (a word that
 * opens a sentence follows), or 'likely-end' (the guard reads a sentence end
 * from the shape of the next word rather than from the opener list: a
 * capitalized gerund, or any capitalized word after a company suffix, which
 * ends the name it closes: “… at Acme Corp. Acme's leads …”). A reader that
 * must never let a misread boundary hide a claim treats 'likely-end' as
 * uncertain; null when the segment does not end in an abbreviation.
 */
function abbreviationBoundary(previous, next) {
  const kind = endsInAbbreviationPeriod(previous);
  if (!kind) return null;
  const first = firstWordOf(next);
  if (!first) return 'end';
  // A month written short is an abbreviation only before the day or year it names.
  if (kind === 'month') return /^\p{N}/u.test(first) ? 'join' : 'end';
  // A digit is never an opener, so “Sec. 4.2” joins; a word that opens a
  // sentence ends this one. “No” opens “No. 2” and also a sentence, so the
  // opener list is consulted for it like for any other.
  if (/^\p{N}/u.test(first)) return 'join';
  if (SENTENCE_OPENERS.has(first.toLowerCase())) return 'end';
  if (kind === 'company') {
    // A title opens a new name, so it cannot continue a company's.
    if (TITLE_ABBREVIATIONS.has(first.toLowerCase())) return 'end';
    // A company suffix closes the name: what continues the sentence after it is
    // lowercase, a figure, a bracket or another suffix (“Co. Ltd.”), never a capitalized word.
    if (COMPANY_SUFFIX_ABBREVIATIONS.has(first.toLowerCase().replace(/\.$/u, '')) || /^\s*[([]/u.test(String(next))) return 'join';
    return /^\p{Ll}/u.test(first) ? 'join' : 'likely-end';
  }
  const bare = String(previous).trimEnd().split(/\s+/u).pop().replace(/^[(["'“‘]+/u, '').slice(0, -1).toLowerCase();
  if (CAPITALIZED_VERB_FORM.test(first) && !(kind === 'word' && PERSON_TITLE_ABBREVIATIONS.has(bare))) return 'likely-end';
  return 'join';
}

function joinAbbreviationSegments(segments) {
  const joined = [];
  for (const segment of segments) {
    const last = joined.length - 1;
    const boundary = last >= 0 ? abbreviationBoundary(joined[last].text, segment) : null;
    if (last >= 0 && /(?:^|\s)\.$/u.test(joined[last].text) && /^\p{L}/u.test(segment)) {
      // A word that opens with its period (".NET") is one token, not a sentence end.
      joined[last].text = `${joined[last].text}${segment}`;
    } else if (boundary === 'join') {
      joined[last].text = `${joined[last].text}${/\s$/u.test(joined[last].text) ? '' : ' '}${segment}`;
    } else {
      joined.push({ text: segment, uncertainStart: boundary === 'likely-end' });
    }
  }
  return joined;
}

function joinAbbreviationSplits(segments) {
  return joinAbbreviationSegments(segments).map(segment => segment.text);
}

/**
 * Shared segmentation for every sentence-level check. Intl.Segmenter knows
 * that “Inc.” and “e.g.” are not sentence ends when a lowercase word follows;
 * joinAbbreviationSplits() covers the rest of what a person's letter writes
 * with a period (titles, places, degrees, section numbers) and the regex
 * fallback keeps the checks working on a runtime without ICU sentence data
 * rather than letting a missing segmenter silently disable them.
 */
export function sentences(value) {
  const source = text(value);
  if (!source) return [];
  return joinAbbreviationSplits(rawSentenceSegments(source)).map(text).filter(Boolean);
}

function rawSentenceSegments(source) {
  return typeof Intl?.Segmenter === 'function'
    ? Array.from(new Intl.Segmenter('en', { granularity: 'sentence' }).segment(source)).map(segment => String(segment?.segment ?? ''))
    : source.split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}])/u);
}

/**
 * The same segmentation as sentences(), for a caller that normalizes the text
 * its own way (the per-sentence claim grounding): `source` is split and joined
 * exactly as sentences() splits and joins it, without this module's
 * normalization, and each segment says whether its start is a boundary the
 * abbreviation guard only INFERRED (`uncertainStart`; see abbreviationBoundary),
 * so a reader that must not let a misread boundary hide a claim can judge the
 * two sides together.
 */
export function sentenceSegments(source) {
  const value = String(source ?? '');
  if (!value.trim()) return [];
  return joinAbbreviationSegments(rawSentenceSegments(value))
    .map(segment => ({ text: segment.text.trim(), uncertainStart: segment.uncertainStart }))
    .filter(segment => segment.text);
}

function sentenceCount(value) {
  return sentences(value).length;
}

/**
 * Enforce only thesis defects code can identify without pretending to judge
 * semantic persuasiveness. Cohesion between the thesis and mappings remains a
 * planner responsibility; this gate catches missing, list-like, and clearly
 * generic output so the existing convergence loop can request one better plan.
 */
export function checkRoleThesis(plan = {}) {
  const thesis = text(plan?.roleThesis);
  // Two halves under two ids (see CHECK_DISPOSITIONS): a thesis that is
  // present is the host's record of the letter's claim and is hygiene; whether
  // it is one sentence, long enough and free of stock language is taste. The
  // row's own shape is unchanged: it fails when either half does.
  const split = (passed, shapeDetail, detail) => withParts(result('role-thesis', passed, detail), [
    { id: 'role-thesis', passed: Boolean(thesis), detail: thesis ? 'roleThesis is present' : detail },
    { id: 'role-thesis-shape', passed: !shapeDetail, detail: shapeDetail || (thesis ? detail : 'not judged: there is no roleThesis') },
  ]);
  const shapeFailure = detail => split(false, detail, detail);
  if (!thesis) return split(false, '', 'roleThesis is missing');
  const count = sentenceCount(thesis);
  if (count !== 1) return shapeFailure(`roleThesis contains ${count} sentences; exactly one controlling claim is required`);
  const countWords = wordCount(thesis);
  if (countWords < MIN_ROLE_THESIS_WORDS) return shapeFailure(`roleThesis has only ${countWords} words; it does not establish a specific controlling claim`);
  const genericLanguage = checkGenericPhrases([thesis]);
  if (!genericLanguage.passed) return shapeFailure(`roleThesis is generic: ${genericLanguage.detail}`);
  const genericPattern = GENERIC_THESIS_PATTERNS.find(item => item.pattern.test(thesis));
  if (genericPattern) return shapeFailure(`roleThesis contains a ${genericPattern.label}`);
  return split(true, '', 'roleThesis is one non-generic controlling claim');
}

const SECONDARY_NARRATIVE_ROLES = new Set(['foundation', 'corroborates', 'deepens', 'extends', 'qualifies']);

/**
 * The schema makes the relationship visible to the provider; this gate keeps
 * a malformed or partial response from quietly restoring a two-proof résumé
 * tour. The first mapping establishes the argument, and any second mapping
 * must state why it follows rather than becoming another primary claim.
 */
export function checkMappingNarrativeStructure(plan = {}) {
  const mappings = Array.isArray(plan?.mappings) ? plan.mappings : [];
  if (!mappings.length) return result('mapping-narrative-structure', false, 'plan has no primary mapping');
  const primary = mappings[0] || {};
  if (text(primary.narrativeRole) !== 'primary') {
    return result('mapping-narrative-structure', false, 'first mapping must use narrativeRole “primary”');
  }
  if (!text(primary.relationToPrevious)) {
    return result('mapping-narrative-structure', false, 'primary mapping must state how it establishes the roleThesis');
  }
  if (mappings.length < 2) return result('mapping-narrative-structure', true, 'one primary mapping supplies the minimum sufficient evidence');
  const secondary = mappings[1] || {};
  const role = text(secondary.narrativeRole);
  if (!SECONDARY_NARRATIVE_ROLES.has(role)) {
    return result('mapping-narrative-structure', false, 'second mapping must provide foundation, corroboration, deepening, extension, or qualification—not another primary argument');
  }
  if (!text(secondary.relationToPrevious)) {
    return result('mapping-narrative-structure', false, 'second mapping must state its relationToPrevious');
  }
  return result('mapping-narrative-structure', true, `second mapping explicitly uses “${role}” to support the primary proof`);
}

export function checkEvidenceGrounding(plan = {}, evidence = {}) {
  const mappings = Array.isArray(plan?.mappings) ? plan.mappings : [];
  const bullets = bulletTexts(evidence);
  for (let mappingIndex = 0; mappingIndex < mappings.length; mappingIndex++) {
    const evidenceText = text(mappings[mappingIndex]?.evidence);
    const evidenceWords = words(evidenceText);
    let grounded = false;
    let bestRun = 0;
    let bestOverlap = 0;
    for (const bullet of bullets) {
      const bulletWords = words(bullet);
      const run = sharedRunLength(evidenceWords, bulletWords);
      const overlap = tokenOverlap(evidenceWords, bulletWords);
      bestRun = Math.max(bestRun, run);
      bestOverlap = Math.max(bestOverlap, overlap);
      if (run >= MIN_EVIDENCE_SHINGLE_WORDS || overlap >= MIN_EVIDENCE_TOKEN_OVERLAP) {
        grounded = true;
        break;
      }
    }
    if (!grounded) {
      const evidencePath = mappingIndex === 0
        ? 'coverLetterArgument.primaryEvidence.evidence'
        : mappingIndex === 1
          ? 'coverLetterArgument.secondaryEvidence.evidence'
          : `coverLetterArgument.mappings[${mappingIndex}].evidence`;
      return result('evidence-grounding', false,
        `${evidencePath} (mapping ${mappingIndex + 1}; non-rendered argument evidence, not cover-letter paragraph ${mappingIndex + 1}) is insufficiently grounded in final résumé bullets: best contiguous run is ${bestRun} words (need ${MIN_EVIDENCE_SHINGLE_WORDS}) and best token overlap is ${Math.round(bestOverlap * 100)}% (need ${Math.round(MIN_EVIDENCE_TOKEN_OVERLAP * 100)}%)`);
    }
  }
  return result('evidence-grounding', true, `${mappings.length} mapping(s) grounded in résumé bullets`);
}

export function checkNeedGrounding(needs = [], jobText = '', researchText = '') {
  const posting = normalized(jobText);
  const research = normalized(researchText);
  const list = Array.isArray(needs) ? needs : [];
  for (let index = 0; index < list.length; index++) {
    const need = list[index] || {};
    const quote = normalized(need.quote);
    if (need.source !== 'posting' && need.source !== 'research') {
      return result('need-grounding', false, `need ${index + 1} has invalid source “${boundedDetailValue(need.source) || 'missing'}”`);
    }
    const source = need.source === 'research' ? research : posting;
    if (!quote || !source.includes(quote)) {
      return result('need-grounding', false, `need ${index + 1} quote is not present in its ${need.source || 'provided'} source text`);
    }
  }
  return result('need-grounding', true, `${list.length} need quote(s) grounded in source text`);
}

// The writer audit binds each proof-bearing final paragraph to these three
// exact spans. This check intentionally validates the binding and the one
// thing a span-only contract cannot prove: that the purported relevance says,
// in the writer's own words, how the proof bears on an actual responsibility
// in the posting. It recognises that statement by the words it shares with the
// quote the paragraph cites, never by a phrase, a modal or a sentence frame,
// because a closed list of accepted frames is what made every letter close its
// proofs on the same few sentences. It does not attempt to infer claims from
// prose or impose sentence order; relevance may precede the proof.
//
// The stock transfer frames a letter keeps reaching for, as a DETECTOR. These
// shapes (“I would apply that X to Y” and its few siblings) are not how a
// relevance span is recognised and nothing requires one: they are the sentences
// independent reviewers flagged as formulaic round after round, so the host
// counts them (checkTransferCarrierBudget), refuses to let one form repeat in
// neighbouring paragraphs (checkRepeatedTransferCarrier), refuses one as a
// capability claim, and keeps their words out of the repeat comparison because
// those two checks already police them. The nouns each shape accepts are arrays
// so the demonstrative check reads the SAME lists the detector is built from.
// The verb-object shape takes a singular noun; the noun-phrase-subject shape
// also takes plurals.
const TRANSFER_CUE_OBJECT_NOUNS = Object.freeze(['experience', 'work', 'capability', 'practice', 'approach', 'judgment']);
const TRANSFER_CUE_SUBJECT_NOUNS = Object.freeze([
  'pattern', 'patterns', 'practice', 'practices', 'experience', 'work', 'capability', 'capabilities',
  'approach', 'approaches', 'judgment', 'judgments',
]);
const FORMULAIC_TRANSFER_FRAME = new RegExp(String.raw`\b(?:i\s+would\s+(?:apply|bring|use|contribute)|i\s+can\s+(?:apply|bring|use)|(?:would\s+)?(?:apply|bring|use|contribute)\s+(?:that|this|my|the)\s+(?:${TRANSFER_CUE_OBJECT_NOUNS.join('|')})|(?:that|this|these|those|the)\s+(?:[\p{L}'’-]+\s+){0,5}(?:${TRANSFER_CUE_SUBJECT_NOUNS.join('|')})\s+would\s+(?:help|support|enable)|help(?:ing)?\s+(?:this|the|your)\s+(?:role|team|work)|support(?:ing)?\s+(?:this|the|your)\s+(?:role|team|work))\b`, 'iu');
// How many proof-bearing paragraphs of ONE letter owe a sentence about the
// target, and how many paragraphs may carry a stock transfer frame at all.
//
// The argument gate used to demand a transfer sentence in one of a closed set of
// frames in EVERY proof-bearing paragraph, and then in the first two. A letter
// of two or three proofs therefore closed each of them on the same kind of
// sentence, and independent reviewers read that cadence as formulaic and as
// speculative scaffolding in every round. The cause was the host, not the
// writer: a closed list of accepted frames leaves a writer who can produce any
// natural sentence with the few it lists. The sentence is also the one place a
// writer is obliged to say what the work will do for the employer, so it was
// where benefits the proof never showed crept in (see checkTransferBenefitSupport).
//
// One, because a letter needs to say once, in its writer's own words, how the
// work it describes bears on the role; a second statement of it adds cadence,
// not information, and the other proofs earn their place by what they show. The
// first proof-bearing paragraph owes that sentence (explicitTransferOwed),
// written in any wording that names the responsibility the paragraph answers
// (checkParagraphArgumentLinks), and a letter may carry a stock transfer frame
// in at most that many paragraphs (checkTransferCarrierBudget). One number is
// both counts, so the two can never disagree.
export const MAX_EXPLICIT_TRANSFER_PARAGRAPHS = 1;
// How many proof-bearing paragraphs of ONE letter owe a claim span.
//
// The argument gate used to demand a claim span (a sentence or phrase asserting
// the candidate capability, in a closed grammar) in EVERY proof-bearing
// paragraph. A claim is the most abstract span a paragraph carries, so a letter
// with three proofs held three abstractions about the candidate on top of the
// three things the candidate did, and the host would not let a writer delete
// one: a paragraph without a claim span was reported as a claim gap. Independent
// reviewers flag an abstract sentence that restates what the proof already
// shows, and the only remedy they can name is the one the host refuses, so the
// writer could only reword it and the next reviewer flagged the new wording.
//
// One, for the same reason the transfer sentence is one: a letter needs to say
// once what capability its proofs add up to; each further proof earns its place
// by what it shows. The first proof-bearing paragraph owes the claim span
// (explicitClaimOwed), and a later one keeps its proof span, its jobNeedQuote and
// its relevance span exactly as before and may leave the claim out. A later
// paragraph that does record a claim span is held to the same shape as ever. One
// number is every count, so the gate, the drafting-stage reporter and the
// printed rule can never disagree.
export const MAX_EXPLICIT_CLAIM_PARAGRAPHS = 1;
// How many proof-bearing paragraphs of ONE letter owe a relevance span.
//
// The claim budget above lifted the claim half of a deadlock and left the other
// half standing: every later proof-bearing paragraph still had to record a
// relevance span carrying at least two content words (or one of nine letters)
// of its jobNeedQuote. A reviewer's natural remedy for a later paragraph that
// echoes the posting's vocabulary is to delete the echoing sentence, and that
// deletion was still host-illegal because it took the relevance span with it, so
// the writer could only reword the sentence and the next reviewer flagged the new
// wording. A later paragraph's jobNeedQuote still binds its proof to the posting
// requirement it answers, and that binding is graded as ever; the relevance span
// is the one extra statement that this budget removes from it.
//
// The relevance span is the carrier of the sentence about the target that
// MAX_EXPLICIT_TRANSFER_PARAGRAPHS paragraphs owe, so it is owed exactly where
// that sentence is: the number is derived, never typed twice, and a paragraph
// that owes the sentence can never be a paragraph that owes no span to carry it.
// A later paragraph that does record a relevance span is held to the same shape
// as ever (it names a responsibility of its jobNeedQuote). One function counts it
// (explicitRelevanceOwed), read by the gate and the drafting-stage reporter, so
// the two can never disagree.
export const MAX_EXPLICIT_RELEVANCE_PARAGRAPHS = MAX_EXPLICIT_TRANSFER_PARAGRAPHS;
const GENERIC_ARGUMENT_RELEVANCE = /\b(?:experience|background|skills?|capabilit(?:y|ies)|work)\b[^.!?]{0,50}\b(?:relevant|applicable|valuable|useful|beneficial|transferable|well[- ]suited|fit)\b|\b(?:innovative|dynamic|fast[- ]paced)\s+(?:team|environment|work)\b/iu;
// The final alternative is the abstraction beat that sits between a
// paragraph's proof and its transfer: a sentence whose subject is the WORK
// and whose predicate says what the work consisted of. Every shape before it
// makes the CANDIDATE the subject (“my experience …”, “I build …”), which is the
// register that yields generic capability assertions; without a work-subject
// shape a writer reaching for the general point had no legal span and wrote
// none, leaving the transfer to reach back to a bare mechanism. The gerund
// must take an object because a gerund with one is a verb while a bare one is
// usually an adjective — that is what separates “was in absorbing those
// differences” from “was mostly rewarding”.
const CANDIDATE_CAPABILITY_CUE = /\b(?:my|i(?:'m| am| have))\b[^.!?]{0,100}\b(?:experience|background|skill|capabilit(?:y|ies)|practice|approach|judgment|foundation)\b|\b(?:i\s+(?:have\s+)?(?:worked\s+on|build|design|implement|maintain|improve|secure|have\s+built))\b[^.!?]{0,120}\b(?:interface|interfaces|workflow|workflows|service|services|system|systems|application|applications|software|access)\b|\bmy\b[^.!?]{0,60}\bwork\s+spans\b|\b(?:designing|building|implementing|maintaining|improving|securing)\b[^.!?]{0,80}\b(?:is|has been|remains)\b[^.!?]{0,80}\b(?:a|the)\b[^.!?]{0,40}\b(?:capability|skill|foundation|strength)\b|\b(?:the|that)\s+(?:engineering|work|hard\s+part|difficulty|challenge|problem)\b[^.!?]{0,40}\b(?:was|lay|sat)\b[^.!?]{0,60}?\b(?:in|largely|mostly|mainly|less|chiefly|really)\b[^.!?]{0,60}?\b[\p{L}]+ing\s+(?:the|a|an|this|that|these|those|his|her|their|its|our|my|what|how|which|each|every|all|both|one|several|many|most|some|any)\b/iu;
// The two cues above are matched on the literal word form, not on meaning, and
// every mapping span must be an exact span of the final paragraph — so a
// paragraph written without one of these shapes has no legal span to offer,
// and the review that has to record the mapping can only repair it by
// rewriting the letter. Both rules are therefore stated once here and read by
// two consumers: the cover-letter contract, which prints them to the stage
// that writes those paragraphs, and the stage gate that reports a paragraph
// offering neither. They describe the regexes directly above; a form added
// there belongs in the matching sentence here, and nothing below names text
// from the career corpus or the posting for a writer to copy.
export const ARGUMENT_CLAIM_SPAN_RULE = 'a claim span is a short phrase stating the candidate capability itself; it can sit inline in any sentence of '
  + 'the paragraph, the proof sentence included, and needs no sentence of its own; it names the capability with the nouns of the evidence '
  + 'this paragraph cites (what was built, run or changed), not an abstraction about how the candidate works or thinks, and asserts no '
  + 'more than that evidence shows; its shape is one of these: my, I am, '
  + 'I’m or I have, followed within the span by experience, background, skill, capability, practice, approach, judgment or '
  + 'foundation; I build, design, implement, maintain, improve, secure or worked on, followed within the span by an interface, '
  + 'workflow, service, system, application, software or access; my … work spans; or designing, building, implementing, '
  + 'maintaining, improving or securing something is, has been or remains a capability, skill, foundation or strength; or the or '
  + 'that engineering, work, hard part, difficulty, challenge or problem was, lay or sat in, largely, mostly, mainly, less, '
  + 'chiefly or really doing something, where that gerund is followed by its own object rather than standing alone as a mood — and it '
  + 'names the capability rather than one particular past action, and never the transfer';
// How the rules below, and the prompts and documents that print them, name the
// paragraphs that owe the sentence, from the constant.
const owingParagraphsPhrase = limit => (limit === 1
  ? 'the first proof-bearing paragraph of the letter'
  : `each of the first ${limit} proof-bearing paragraphs of the letter`);
export const OWING_PROOF_PARAGRAPHS = owingParagraphsPhrase(MAX_EXPLICIT_TRANSFER_PARAGRAPHS);
export const OWING_CLAIM_PARAGRAPHS = owingParagraphsPhrase(MAX_EXPLICIT_CLAIM_PARAGRAPHS);
export const OWING_RELEVANCE_PARAGRAPHS = owingParagraphsPhrase(MAX_EXPLICIT_RELEVANCE_PARAGRAPHS);
export const ARGUMENT_RELEVANCE_SPAN_RULE = `in ${OWING_PROOF_PARAGRAPHS} a relevance span says, in the writer's own words, how that proof bears on the work the paragraph's jobNeedQuote came from: `
  + 'it is a sentence, or part of one, other than the sentence the proof span sits in, it carries at least two content words of that quote '
  + '(or one of nine letters or more), and it is no generic relevance label (a sentence that only calls the experience or work relevant, '
  + 'applicable, valuable, useful, transferable or a fit); it needs no stock phrase, no would or can, and it need not repeat any word of the proof';
// What a relevance span is in a proof-bearing paragraph that does not owe one
// (every one after the first MAX_EXPLICIT_RELEVANCE_PARAGRAPHS). Such a paragraph
// owes its proof span and its jobNeedQuote and may leave the relevance span out
// (EXPLICIT_RELEVANCE_BUDGET_RULE); if it records one, the span only has to name
// the responsibility the paragraph answers: no sentence about the target is owed,
// so a paragraph may end on what the work did.
export const ARGUMENT_LATER_RELEVANCE_SPAN_RULE = 'in a later proof-bearing paragraph that records a relevance span, it is any span of that paragraph '
  + 'that names the responsibility its jobNeedQuote came from, by carrying at least two content words of that quote (or one of nine '
  + 'letters or more) and no generic relevance label; it needs no sentence about the target, no particular wording and no sentence '
  + 'apart from the proof';
// Printed beside the relevance rules so a writer is told which paragraph owes the
// sentence about the target, and the one ceiling the host does count: stock
// transfer frames. What a later paragraph owes is stated once, by the claim and
// relevance budget rules below, which read the same way.
export const EXPLICIT_TRANSFER_BUDGET_RULE = `only ${OWING_PROOF_PARAGRAPHS} owes a sentence about why its proof matters to the target, `
  + 'and it is yours to word; a later proof-bearing paragraph owes no such sentence and ends on what the work did, '
  + 'and the stock transfer frame (I would or can apply, bring, use or contribute your '
  + 'experience, work, capability, practice, approach or judgment, or that or this practice would help, support or enable) '
  + `appears in at most ${MAX_EXPLICIT_TRANSFER_PARAGRAPHS} of the letter's paragraphs, the opening and the closing counted, and no paragraph needs it`;
// The claim span's counterpart of the budget rule above, printed beside it: which
// paragraph owes a claim span, and what every other proof-bearing paragraph does
// instead. A claim a later paragraph chooses to record is held to the shape
// ARGUMENT_CLAIM_SPAN_RULE gives, so leaving it out is always the safe answer.
export const EXPLICIT_CLAIM_BUDGET_RULE = `only ${OWING_CLAIM_PARAGRAPHS} owes a claim span; a later proof-bearing paragraph `
  + 'owes only its proof span and its jobNeedQuote, may leave the claim out, and is held to the same shape for a claim span it records';
// The relevance span's counterpart: the same two clauses, for the field the claim
// budget leaves in place. Without it the contract said that a later paragraph may
// omit its claim and said nothing of its relevance, which the gate then demanded.
export const EXPLICIT_RELEVANCE_BUDGET_RULE = `only ${OWING_RELEVANCE_PARAGRAPHS} owes a relevance span; a later proof-bearing paragraph `
  + 'owes only its proof span and its jobNeedQuote, may leave the relevance out, and is held to the same shape for a relevance span it records';
// The three budget sentences, in the order every contract, brief and document
// prints them. Built here so a stage that prints the pair of spans can never print
// one budget and forget another: this is the one string those stages read.
export const ARGUMENT_SPAN_BUDGET_RULES = `Also, ${EXPLICIT_TRANSFER_BUDGET_RULE}. Likewise, ${EXPLICIT_CLAIM_BUDGET_RULE}. Likewise, ${EXPLICIT_RELEVANCE_BUDGET_RULE}.`;

const ARGUMENT_STOP_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'to', 'with',
  'you', 'your', 'will', 'would', 'this', 'that', 'these', 'those', 'our', 'their', 'be', 'is', 'are',
  'role', 'team', 'work', 'responsibilities', 'responsibility', 'experience', 'skills', 'ability', 'candidate',
]);
// The closed verb list a proof span must use. A contract that told a writer
// only "state a first-person past action" left every verb outside this list
// looking legal when it is not — an ANTI-disclosure, because the closed list
// below is what actually decides the rejection. Exported so ARGUMENT_PROOF_
// SPAN_RULE is built FROM this array rather than transcribed by hand: a verb
// added or removed here reaches the printed rule with no second edit, and
// nothing else can drift out of step with the regex it also builds.
export const PAST_PROOF_VERBS = Object.freeze([
  'built', 'created', 'developed', 'designed', 'implemented', 'delivered', 'maintained', 'improved', 'led',
  'owned', 'supported', 'integrated', 'migrated', 'automated', 'reworked', 'updated', 'configured', 'deployed',
  'tested', 'resolved', 'reduced', 'increased', 'wrote',
]);
const PAST_PROOF_CUE = new RegExp(`\\b(?:i|we)\\s+(?:(?:have|has)\\s+)?(?:also\\s+)?(?:${PAST_PROOF_VERBS.join('|')})\\b`, 'iu');
// Interpolated by the review contract in place of the vague "states a
// first-person past action of the candidate's" it used to print: that
// sentence let a responder use any past-tense verb that reads naturally in
// the letter, while checkParagraphArgumentLinks (below) rejects every one of
// them that is not in PAST_PROOF_VERBS. Matching the sibling rules'
// convention, this names the shape the regex accepts and defers the
// enumeration to the list itself.
export const ARGUMENT_PROOF_SPAN_RULE = 'a proof span states, in the first person singular or plural (I or we — optionally with have or has, and optionally also) '
  + `one completed action using one of this closed list of verbs: ${PAST_PROOF_VERBS.join(', ')}`;
// Present perfect can summarize a repeatable capability (“I have built
// workflows …”) or identify one completed artifact. Keep this deliberately
// narrow so the claim field can use the former without allowing a named
// employer/project proof to masquerade as the candidate's general point.
const GENERAL_PRESENT_PERFECT_CAPABILITY = /\b(?:i|we)\s+have\s+(?:built|created|developed|designed|implemented|maintained|improved|integrated|automated|updated)\s+(?:secure\s+|web\s+|software\s+|user(?:-facing)?\s+|access(?:-controlled)?\s+)?(?:workflows?|interfaces?|services?|systems?|applications?)\b/iu;

/** Shared proof boundary for the writer audit and Local-AI result sanitizer. */
export function paragraphHasCandidatePastProof(paragraph = '') {
  return PAST_PROOF_CUE.test(text(paragraph));
}

/**
 * Which paragraphs of a letter owe a sentence of their own about the target:
 * the first MAX_EXPLICIT_TRANSFER_PARAGRAPHS proof-bearing ones, counted in
 * letter order by the same boundary that decides which paragraphs owe an
 * argumentMapping at all. One function answers it for the completion gate, for
 * the drafting-stage span reporter and for the carrier budget, which is what
 * keeps the reporter a subset of the gate: they read the same paragraphs
 * through the same count. Returns one boolean per paragraph, in order.
 */
export function explicitTransferOwed(paragraphs = []) {
  return firstProofBearingParagraphs(paragraphs, MAX_EXPLICIT_TRANSFER_PARAGRAPHS);
}

/**
 * Which paragraphs of a letter owe a claim span: the first
 * MAX_EXPLICIT_CLAIM_PARAGRAPHS proof-bearing ones, counted in letter order by
 * the same boundary as explicitTransferOwed and for the same reason, read by the
 * same two consumers: the completion gate (checkParagraphArgumentLinks) and the
 * drafting-stage span reporter (paragraphArgumentSpanGaps). Returns one boolean
 * per paragraph, in order.
 */
export function explicitClaimOwed(paragraphs = []) {
  return firstProofBearingParagraphs(paragraphs, MAX_EXPLICIT_CLAIM_PARAGRAPHS);
}

/**
 * Which paragraphs of a letter owe a relevance span: the first
 * MAX_EXPLICIT_RELEVANCE_PARAGRAPHS proof-bearing ones, counted in letter order
 * by the same boundary as explicitTransferOwed and explicitClaimOwed (one helper,
 * no second count) and read by the same two consumers: the completion gate
 * (checkParagraphArgumentLinks) and the drafting-stage span reporter
 * (paragraphArgumentSpanGaps). A paragraph past it owes its proof span and its
 * jobNeedQuote and nothing else; a relevance span it records is graded as ever.
 * Returns one boolean per paragraph, in order.
 */
export function explicitRelevanceOwed(paragraphs = []) {
  return firstProofBearingParagraphs(paragraphs, MAX_EXPLICIT_RELEVANCE_PARAGRAPHS);
}

// One boolean per paragraph: true for the first `limit` proof-bearing ones.
function firstProofBearingParagraphs(paragraphs, limit) {
  let proofBearing = 0;
  return (Array.isArray(paragraphs) ? paragraphs : []).map(paragraph => {
    if (!paragraphHasCandidatePastProof(paragraph)) return false;
    proofBearing += 1;
    return proofBearing <= limit;
  });
}

function isGeneralPresentPerfectCapability(claim = '') {
  return GENERAL_PRESENT_PERFECT_CAPABILITY.test(text(claim));
}

function normalizedArgumentTerm(word) {
  const value = String(word || '').toLowerCase();
  if (/ies$/u.test(value) && value.length > 4) return `${value.slice(0, -3)}y`;
  // Keep words such as access, business, and analysis intact. This is a small
  // lexical overlap aid, not an English stemmer.
  if (/s$/u.test(value) && !/(?:ss|us|is)$/u.test(value) && value.length > 4) return value.slice(0, -1);
  return value;
}

function argumentContentWords(value) {
  return words(value)
    .flatMap(word => word.split('-'))
    .map(normalizedArgumentTerm)
    .filter(word => word.length >= 4 && !ARGUMENT_STOP_WORDS.has(word));
}

function normalizedSpanIsInParagraph(span, paragraph) {
  const normalizedSpan = normalized(span);
  return Boolean(normalizedSpan) && normalized(paragraph).includes(normalizedSpan);
}

// Where a mapping span may begin and end inside its paragraph.
//
// Substring containment alone accepts a cut that lands between two letters, so
// “systems delivery path” taken out of the middle of “microsystems delivery
// path” is as legal at completion as the word it was carved from. The
// drafting-stage reporter could not see that span — it enumerates what a
// paragraph offers by walking whole words — so the two sides answered the same
// question differently, and by the time the gate answered it the letter had
// been frozen for three stages. Both sides now read this one predicate: a span
// is copied out of the paragraph wherever the cut does not fall between two
// letters or digits, which drops a trailing comma or enters a hyphenated
// compound at its second half, and never starts or ends mid-word.
const SPAN_WORD_CHARACTER = /[\p{L}\p{N}]/u;
function isSpanWordCharacter(character) {
  return typeof character === 'string' && SPAN_WORD_CHARACTER.test(character);
}
function spanBoundaryIsWordAligned(source, index) {
  return !(isSpanWordCharacter(source[index - 1]) && isSpanWordCharacter(source[index]));
}
function wordAlignedSpanIsInParagraph(span, paragraph) {
  const normalizedSpan = normalized(span);
  const normalizedParagraph = normalized(paragraph);
  if (!normalizedSpan) return false;
  for (let at = normalizedParagraph.indexOf(normalizedSpan); at >= 0; at = normalizedParagraph.indexOf(normalizedSpan, at + 1)) {
    if (spanBoundaryIsWordAligned(normalizedParagraph, at)
      && spanBoundaryIsWordAligned(normalizedParagraph, at + normalizedSpan.length)) return true;
  }
  return false;
}

// Every span of a text the predicate above admits, up to the punctuation at
// its edges: a span that opens on “(” or closes on “,” carries the same words
// as the one inside it, and every rule these spans are tried against reads
// words — so a candidate with punctuation edges is never the one that
// qualifies when the trimmed one does not, and enumerating both would only
// square the work.
function wordAlignedSpanBounds(value) {
  const source = String(value);
  const starts = [];
  const ends = [];
  for (let index = 0; index < source.length; index += 1) {
    if (!isSpanWordCharacter(source[index])) continue;
    if (!isSpanWordCharacter(source[index - 1])) starts.push(index);
    if (!isSpanWordCharacter(source[index + 1])) ends.push(index + 1);
  }
  const spans = [];
  for (const start of starts) {
    for (const end of ends) if (end > start) spans.push({ start, end });
  }
  return spans;
}

// Printed by the review contract beside the three span rules, from the
// predicate that decides it. Silence here was the ANTI-disclosure: a writer
// told only "an exact span" may read the letters back out of the middle of a
// word, and the reporter that is supposed to name an unmappable paragraph
// three stages earlier cannot see that span at all.
export const ARGUMENT_SPAN_ALIGNMENT_RULE = 'each of those spans is copied out of the paragraph on word '
  + 'boundaries: a cut may fall anywhere the paragraph is not between two letters or digits — dropping a trailing '
  + 'comma, or entering a hyphenated compound at its second half, is fine — and a span that begins or ends inside a '
  + 'word is rejected even though its letters do appear there';

function relevanceNeedOverlap(relevance, jobNeedQuote) {
  const needTerms = new Set(argumentContentWords(jobNeedQuote));
  const relevanceTerms = argumentContentWords(relevance);
  // Two shared content words make accidental overlap unlikely. One unusually
  // specific shared term is enough for short requirement quotes such as
  // a short product name or a single term such as “authorization”.
  const matches = [...new Set(relevanceTerms.filter(term => needTerms.has(term)))];
  return { needTerms: [...needTerms], matches };
}

function relevanceNamesNeed(relevance, jobNeedQuote) {
  const { matches } = relevanceNeedOverlap(relevance, jobNeedQuote);
  return matches.length >= 2 || matches.some(term => term.length >= 9);
}

// The rule above is lexical by design: it prevents an audit from calling a
// generic “this role” bridge an argument to a particular responsibility. A
// bare failure, however, makes a writer guess which literal terms the host
// kept after stop-word filtering and singularization. That was enough to
// repeat an otherwise-identical review correction. Keep the explanation
// generated from the same overlap calculation rather than maintaining a
// second list of target words or weakening the semantic floor.
function relevanceNeedRepairHint(relevance, jobNeedQuote, where = 'in the exact relevance span', subject = 'this relevance') {
  const { needTerms, matches } = relevanceNeedOverlap(relevance, jobNeedQuote);
  // The input audit field is already bounded to 1,000 characters. Bound this
  // presentation too: it is a correction aid, not a copy of the listing.
  const eligible = needTerms.slice(0, 16);
  const displayed = eligible.length ? eligible.map(term => JSON.stringify(term)).join(', ') : '(none after the standard content-word filter)';
  const current = matches.length ? matches.map(term => JSON.stringify(term)).join(', ') : 'none';
  const omitted = needTerms.length - eligible.length;
  return ` Its exact jobNeedQuote yields these eligible responsibility terms after the same content-word filter: ${displayed}${omitted > 0 ? ` (${omitted} more omitted)` : ''}; ${subject} currently matches ${current}. Include at least two distinct eligible terms, or one eligible term of nine or more letters, ${where}.`;
}

// Back-references a letter uses to point at the work it just described. No rule
// asks for one any more; repeatComparisonSentence keeps the ones it can read out
// of the repeat comparison, because a writer who points back at the proof is not
// restating it.
const DIRECT_PROOF_ANAPHORA = /\b(?:(?:that|this)\s+(?:experience|work)|(?:those|these)\s+patterns)\b/iu;
const DIRECT_PROOF_ARTIFACT_REFERENCE = /\bthe\s+(?:system|application|interface|workflow|service|tool)\b/iu;
const DIRECT_PROOF_PRONOUN_REFERENCE = /\bi\s+(?:would|can|will)\s+(?:apply|bring|use|contribute)\s+it\b/iu;

export const ARGUMENT_MAPPING_REQUIRED_RULE = 'a paragraph needs an argumentMapping exactly when its own words put I '
  + 'or we — optionally with have or has, and optionally also — directly in front of one of the verbs the proof-span '
  + 'rule below closes over, and that list is the whole test: a paragraph that states an action of yours in any other '
  + 'verb carries no span that can serve as its proof, so its argumentMapping is omitted rather than supplied, and '
  + 'supplying one anyway is rejected for a proof that states no candidate past action';

// Where the sentences of a paragraph sit in its normalized text. The relevance
// obligation is judged by sentence: a paragraph that owes a statement of why its
// proof matters to the target owes it in a sentence other than the one that
// carries the proof, because a proof sentence that happens to name the posting's
// words has told the reader what was done, not why it matters. A sentence that
// cannot be placed is left out, which can only make the verdicts below more
// lenient.
function sentenceBoxes(paragraph) {
  const source = normalized(paragraph);
  const boxes = [];
  let from = 0;
  sentences(paragraph).forEach((sentence, index) => {
    const needle = normalized(sentence);
    const start = source.indexOf(needle, from);
    if (start < 0) return;
    boxes.push({ index, start, end: start + needle.length });
    from = start + needle.length;
  });
  return boxes;
}

/** Every position a word-aligned span occupies in its paragraph (the span may repeat). */
function wordAlignedSpanRanges(span, paragraph) {
  const needle = normalized(span);
  const source = normalized(paragraph);
  const found = [];
  if (!needle) return found;
  for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + 1)) {
    if (spanBoundaryIsWordAligned(source, at) && spanBoundaryIsWordAligned(source, at + needle.length)) {
      found.push({ start: at, end: at + needle.length });
    }
  }
  return found;
}

/** The sentences a character range touches. */
function sentenceIndexesTouched(boxes, range) {
  return boxes.filter(box => box.start < range.end && box.end > range.start).map(box => box.index);
}

/**
 * The words of a span that lie outside the given sentences, in paragraph order.
 * This is what a span says BEYOND the sentences its proof sits in: a relevance
 * span that reaches from the proof sentence into the next one is judged on the
 * next one alone.
 */
function textOutsideSentences(source, boxes, range, excluded) {
  return boxes
    .filter(box => !excluded.has(box.index))
    .map(box => source.slice(Math.max(box.start, range.start), Math.min(box.end, range.end)))
    .filter(piece => /[\p{L}\p{N}]/u.test(piece))
    .join(' ');
}

/**
 * Does the relevance span say something beyond the sentence its proof sits in,
 * and does that part name the responsibility its jobNeedQuote came from?
 *
 * A proof sentence can share two words with a posting quote and still say
 * nothing about why the work matters: it says what was done. The obligation of
 * the paragraph that owes the statement is therefore judged on the part of the
 * relevance span that lies outside every sentence the proof span touches. There
 * is no phrase, modal or shared noun to find in it, only the words it shares
 * with the quote, which is how it is recognised whatever the writer's wording.
 * `applicable` is false when either span cannot be placed in the paragraph,
 * because the containment observations report that and a second verdict would
 * name a repair that does not exist.
 */
function relevanceBeyondProof(paragraph, proof, relevance, jobNeedQuote) {
  const relevanceRanges = wordAlignedSpanRanges(relevance, paragraph);
  const proofRanges = wordAlignedSpanRanges(proof, paragraph);
  if (!relevanceRanges.length || !proofRanges.length) return { applicable: false };
  const source = normalized(paragraph);
  const boxes = sentenceBoxes(paragraph);
  let reached = false;
  let longest = '';
  for (const relevanceRange of relevanceRanges) {
    for (const proofRange of proofRanges) {
      const excluded = new Set(sentenceIndexesTouched(boxes, proofRange));
      const apart = textOutsideSentences(source, boxes, relevanceRange, excluded);
      if (!apart) continue;
      reached = true;
      if (!jobNeedQuote || relevanceNamesNeed(apart, jobNeedQuote)) return { applicable: true, ok: true };
      if (apart.length > longest.length) longest = apart;
    }
  }
  return { applicable: true, ok: false, reached, apart: longest };
}

// What the jobNeedQuote observation calls the posting copy it compared
// against, for a caller that has only one. A pipeline that prints a DIFFERENT
// copy to the responder than it grades against must pass its own label, or the
// rejection sends the writer back to the copy the gate never reads.
const DEFAULT_POSTING_QUOTE_LABEL = 'the job posting';

// The plan's verb matters. “Use a tool” is not evidence that the candidate
// would be hired to build, introduce, or integrate that tool. These are
// deliberately ordinary verb families rather than a product-name lexicon, and
// the check reads only the target-facing relevance span that already names the
// mapped need.
const REQUIREMENT_USE_CUE = /\b(?:use|using|used|leverage|leveraging|work(?:ing)?\s+with|experience\s+with|proficien(?:t|cy)\s+(?:with|in)|familiar(?:ity)?\s+with)\b/iu;
const REQUIREMENT_TOOL_WORKFLOW_SUBJECT_CUE = /\b(?:tool|platform|workflow|framework|technology|software)\b/iu;
const REQUIREMENT_CONSTRUCTION_CUE = /\b(?:build|built|building|develop|developed|developing|implement|implemented|implementing|integrat(?:e|ed|ing|ion)|introduc(?:e|ed|ing|tion)|creat(?:e|ed|ing|ion))\b/iu;
const TARGET_CONSTRUCTION_CUE = /\b(?:build|building|develop|developing|implement|implementing|integrat(?:e|ing)|introduc(?:e|ing)|creat(?:e|ing))\b/iu;

function requirementUseOnly(jobNeedQuote) {
  return REQUIREMENT_USE_CUE.test(jobNeedQuote)
    && REQUIREMENT_TOOL_WORKFLOW_SUBJECT_CUE.test(jobNeedQuote)
    && !REQUIREMENT_CONSTRUCTION_CUE.test(jobNeedQuote);
}

// Narrow product-scope guard, one instance of a general invariant: using a
// tool in your own process is real experience, but it is not evidence of having
// built a product that is powered by that tool. The proof announces the
// instrument itself as a compound modifier (“<tool>-assisted <activity>”), and
// the guard learns the tool from that proof rather than from a list. A claim,
// the proof, or the relevance that then asserts building or shipping a product
// “powered by”, “based on”, “driven by” or “enabled by” the SAME tool is the
// overreach; a direct build in the proof itself, or the posting merely asking
// for the work prospectively, is not. The routine covers the broader judgment;
// this catches the high-confidence overclaim without guessing at tool brands.
const ASSISTED_PRACTICE_CUE = /\b([\p{L}][\p{L}\p{N}]*)[- ](?:assisted|aided|augmented)\s+[\p{L}][\p{L}-]*/iu;
// A tool whose own name is only a pointer to a technology family: the terms a
// product built on that family is described with. Consulted only for the tool
// the proof itself names, so it never fires without evidence of that practice.
const ASSISTED_TOOL_FAMILY_TERMS = Object.freeze({
  ai: ['llm', 'inference', 'machine[- ]learning'],
  ml: ['inference', 'machine[- ]learning'],
});
const BUILT_PRODUCT_THING = '(?:interaction|interface|product|application|feature|integration|experience|service|platform)s?';
const BUILD_OR_SHIP_VERB = '(?:build(?:ing|s|t)?|ship(?:ping|ped|s)?|develop(?:ing|ed|s)?)';

function toolProductCues(tool) {
  const key = String(tool || '').toLowerCase();
  // “<tool>-powered”, “<tool>-driven” and the like are the product-scope
  // marker whatever the tool is. A tool that points at a technology family also
  // brings that family's own terms, but only beside a product noun.
  const compound = `\\b${escapeRegExp(key)}[- ](?:powered|based|driven|enabled|native)\\b`;
  const family = ASSISTED_TOOL_FAMILY_TERMS[key] || [];
  const familyTerms = family.length ? `(?:${family.join('|')})` : '';
  const scopePatterns = [
    compound,
    ...(familyTerms ? [`\\b${familyTerms}\\b[^.!?]{0,80}\\b${BUILT_PRODUCT_THING}\\b`, `\\b${BUILT_PRODUCT_THING}\\b[^.!?]{0,80}\\b${familyTerms}\\b`] : []),
  ];
  const scoped = `(?:${[compound, ...(familyTerms ? [`\\b${familyTerms}\\b`] : [])].join('|')})`;
  const authored = '\\b(?:i|we)\\s+(?:built|developed|designed|implemented|shipped|created)\\b[^.!?]{0,100}';
  const claimNoun = '(?:experience|capability|background|track\\s+record|work)';
  return {
    scope: new RegExp(scopePatterns.join('|'), 'iu'),
    direct: new RegExp(scopePatterns.map(pattern => `${authored}(?:${pattern})`).join('|'), 'iu'),
    shipment: new RegExp(`\\b(?:my|that|this|the)\\s+${claimNoun}\\b[^.!?]{0,80}\\b${BUILD_OR_SHIP_VERB}\\b[^.!?]{0,80}${scoped}|${scoped}[^.!?]{0,80}\\b${BUILD_OR_SHIP_VERB}\\b[^.!?]{0,80}\\b${claimNoun}\\b`, 'iu'),
  };
}

function requirementUseObjectPhrases(jobNeedQuote) {
  const tokens = words(jobNeedQuote);
  const starts = [];
  for (let index = 0; index < tokens.length; index++) {
    if (['use', 'using', 'used', 'leverage', 'leveraging'].includes(tokens[index])) starts.push(index + 1);
    if (['with', 'in'].includes(tokens[index]) && index > 0
      && ['work', 'working', 'experience', 'proficient', 'proficiency', 'familiar', 'familiarity'].includes(tokens[index - 1])) starts.push(index + 1);
  }
  const stop = new Set(['to', 'for', 'with', 'in', 'on', 'at', 'from', 'by', 'and', 'or', 'that', 'which', 'who']);
  const articles = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'your', 'our']);
  const phrases = new Set();
  for (const start of starts) {
    const parts = [];
    for (let index = start; index < tokens.length && parts.length < 3; index++) {
      if (stop.has(tokens[index])) break;
      if (!parts.length && articles.has(tokens[index])) continue;
      parts.push(tokens[index]);
    }
    if (parts.length) phrases.add(parts.join(' '));
  }
  return [...phrases];
}

function constructionGovernsRequirementObject(relevance, jobNeedQuote) {
  const source = normalized(relevance);
  for (const phrase of requirementUseObjectPhrases(jobNeedQuote)) {
    const phraseWords = phrase.split(' ');
    const object = phraseWords.map(escapeRegExp).join('\\s+');
    // A bare “tool” is too ambiguous: “build review tools” need not mean build
    // the tool the posting asks the candidate to use. Its determiner is what
    // makes the old tool itself the grammatical object.
    const modifier = phraseWords.length === 1 && /^(?:tool|tools|platform|workflow|framework|technology|software)$/u.test(phrase)
      ? '(?:the|this|that|these|those|same)\\s+'
      : '(?:(?:the|a|an|this|that|these|those|your|our)\\s+)?';
    const pattern = new RegExp(`\\b(?:build|building|develop|developing|implement|implementing|integrat(?:e|ing)|introduc(?:e|ing)|creat(?:e|ing))\\s+${modifier}(?:[\\p{L}\\p{N}'’-]+\\s+){0,3}${object}\\b`, 'iu');
    if (pattern.test(source)) return true;
  }
  return false;
}

// The recorded relevance span is read first, and its message is the one a writer has always been given.
// The rest of the paragraph is read the same way evidenceScopeObservation reads it: the budgets let a
// later paragraph leave its claim and its relevance out, so a sentence that turns a use requirement
// into building it is exactly as much an overreach when no span records it. The claim, the proof span
// and every sentence of the paragraph (the first-person proof sentences among them) are therefore read
// against the paragraph's own jobNeedQuote. A past-tense proof (“built”) never matches the construction
// cue, so the candidate's completed work is not what is held to the posting's modality.
function requirementModalityObservation(label, jobNeedQuote, relevance, { claim = '', proof = '', paragraph = '' } = {}) {
  if (!requirementUseOnly(jobNeedQuote)) return '';
  const promotes = value => TARGET_CONSTRUCTION_CUE.test(value) && constructionGovernsRequirementObject(value, jobNeedQuote);
  const repair = 'preserve the posting’s modality unless its own quoted need separately asks for construction or integration';
  if (relevance && promotes(relevance)) return `${label} argumentMapping.relevance turns a use/workflow requirement into building or integrating it; ${repair}`;
  const promoted = [claim, proof, ...sentences(paragraph)].find(value => value && promotes(value));
  return promoted ? `${label} says “${boundedDetailValue(promoted)}”, which turns a use/workflow requirement into building or integrating it; ${repair}` : '';
}

// What the guard reads is the whole paragraph, not only the spans the mapping
// records. The claim span used to be the one place a capability sentence was
// certain to be mapped (every proof-bearing paragraph had to record one), so the
// overreach had nowhere to hide. A later paragraph may now leave its claim and its
// relevance out, and a capability sentence the mapping does not name (“my
// experience shipping <product> …”) is exactly as much a promotion of the
// practice as one it does. So the practice is learned from the proof span AND from
// every sentence of the paragraph that carries a first-person proof verb, and the
// promotion is looked for in the recorded spans AND in every sentence of the
// paragraph. A direct build in any of the proof sentences still answers it.
function evidenceScopeObservation(label, claim, proof, relevance, paragraph = '') {
  const sentenceList = sentences(paragraph);
  const proofTexts = [proof, ...sentenceList.filter(sentence => paragraphHasCandidatePastProof(sentence))];
  let practice = null;
  for (const value of proofTexts) {
    practice = ASSISTED_PRACTICE_CUE.exec(value);
    if (practice) break;
  }
  if (!practice) return '';
  const cues = toolProductCues(practice[1]);
  if (proofTexts.some(value => cues.direct.test(value))) return '';
  if (![claim, proof, relevance, ...sentenceList].some(value => cues.scope.test(value) && cues.shipment.test(value))) return '';
  return `${label} treats a tool-assisted practice (“${boundedDetailValue(practice[0])}”) as evidence of shipping a product powered by that tool; keep every claim, relevance and sentence of the paragraph at the supported practice scope unless a cited proof directly describes building that product capability`;
}

/**
 * Verify a Local-AI generation-audit paragraph mapping.
 *
 * `plan.paragraphs` must mirror final cover-letter paragraphs. Entries without
 * `argumentMapping` are permitted only for non-proof paragraphs such as an
 * opening or closing. The host decides which audit versions require this
 * contract; this pure helper reports a useful failure for a missing mapping.
 *
 * `postingQuoteText` is the ONE string jobNeedQuote is graded as a span of,
 * and it is separate from `jobText` because a caller can hold two copies of
 * the same posting that are not the same characters. The paste pipeline does:
 * it prints a rendered listing companion to the responder and used to grade
 * this field against the raw scrape, which escapes nothing — so a quote copied
 * out of the copy the responder was SHOWN could be rejected for not occurring
 * in a copy it never saw. Callers that hold one copy pass `jobText` alone and
 * get the same string for both.
 */
export function checkParagraphArgumentLinks({
  plan = {}, paragraphs = [], jobText = '',
  postingQuoteText = jobText, postingQuoteLabel = DEFAULT_POSTING_QUOTE_LABEL,
} = {}) {
  const finalParagraphs = Array.isArray(paragraphs) ? paragraphs.map(text) : [];
  const plannedParagraphs = Array.isArray(plan?.paragraphs) ? plan.paragraphs : [];
  if (!plannedParagraphs.length) {
    return argumentLinksRow([{ kind: PROVENANCE, message: 'coverLetterPlan has no paragraph-level argument mappings' }], 0);
  }
  if (plannedParagraphs.length !== finalParagraphs.length) {
    return argumentLinksRow([{ kind: PROVENANCE, message: `coverLetterPlan has ${plannedParagraphs.length} paragraph record(s), but the final letter has ${finalParagraphs.length} paragraph(s)` }], 0);
  }
  // Every observation is tagged with what kind of fact it is about (see
  // argumentLinksRow): PROVENANCE observations say a recorded span or quote is
  // not what it claims to be, or that the letter promotes a tool use into a
  // product build; SHAPE observations say a mapping does not meet the span
  // grammar the audit asks for. The tag is the only thing that differs between
  // them here, so the legacy aggregate (every observation, in this order) and
  // the two halves are all read off one list.
  const observations = [];
  const observe = (kind, message) => observations.push({ kind, message });
  // Only the first MAX_EXPLICIT_TRANSFER_PARAGRAPHS proof-bearing paragraphs owe
  // a relevance span that stands apart from the proof, written in any wording
  // that names the responsibility the paragraph answers; a later one owes no
  // such sentence (see EXPLICIT_TRANSFER_BUDGET_RULE), and a relevance span it
  // records only has to name the responsibility it answers.
  const owesTransfer = explicitTransferOwed(finalParagraphs);
  // Likewise only the first MAX_EXPLICIT_CLAIM_PARAGRAPHS proof-bearing paragraphs
  // owe a claim span; a later one may leave it out, and one it does record is
  // graded exactly as before (see EXPLICIT_CLAIM_BUDGET_RULE).
  const owesClaim = explicitClaimOwed(finalParagraphs);
  // And the relevance span, which is the carrier of the transfer sentence: the
  // paragraph that owes the sentence owes a span to carry it, and a later one
  // may leave it out exactly as it may leave out its claim (see
  // EXPLICIT_RELEVANCE_BUDGET_RULE). A span it records is graded exactly as before.
  const owesRelevance = explicitRelevanceOwed(finalParagraphs);
  plannedParagraphs.forEach((planned, index) => {
    const mapping = planned?.argumentMapping;
    const paragraph = finalParagraphs[index] || '';
    if (mapping == null) {
      if (paragraphHasCandidatePastProof(paragraph)) {
        observe(SHAPE, `paragraph ${index + 1} contains a candidate past action but has no argumentMapping`);
      }
      // Leaving the mapping out is a shape matter (the audit's grammar is not
      // required of a writer), but it must not be a way past the truth read:
      // the scope guard reads the paragraph's own sentences and needs no span.
      const unmappedScope = evidenceScopeObservation(`paragraph ${index + 1}`, '', '', '', paragraph);
      if (unmappedScope) observe(PROVENANCE, unmappedScope);
      return;
    }
    const claim = text(mapping.claim);
    const proof = text(mapping.proof);
    const relevance = text(mapping.relevance);
    const jobNeedQuote = text(mapping.jobNeedQuote);
    const label = `paragraph ${index + 1}`;
    for (const [field, span] of [['claim', claim], ['proof', proof], ['relevance', relevance]]) {
      if (!span) {
        // The proof span and the jobNeedQuote (below) are owed by every
        // proof-bearing paragraph; the claim and the relevance only by the
        // paragraphs their budgets name.
        const owed = field === 'claim' ? owesClaim[index] : field === 'relevance' ? owesRelevance[index] : true;
        if (owed) observe(SHAPE, `${label} argumentMapping.${field} is missing`);
      } else if (!normalizedSpanIsInParagraph(span, paragraph)) observe(PROVENANCE, `${label} argumentMapping.${field} is not an exact normalized span of the final paragraph`);
      // Reported separately from containment because the repair is a different
      // one: the words are there, the cut is not on their boundaries. Extend
      // or trim the field to whole words; nothing in the letter has to change.
      else if (!wordAlignedSpanIsInParagraph(span, paragraph)) observe(PROVENANCE, `${label} argumentMapping.${field} begins or ends inside a word of the final paragraph; copy it out on word boundaries`);
    }
    if (!jobNeedQuote) observe(SHAPE, `${label} argumentMapping.jobNeedQuote is missing`);
    // Names the copy it was compared against, because that is the whole
    // repair: the words can be in the posting and still not be in this copy of
    // it, and a reader told only "the job posting" re-copies from whichever
    // one is nearest.
    else if (!normalized(postingQuoteText).includes(normalized(jobNeedQuote))) observe(PROVENANCE, `${label} argumentMapping.jobNeedQuote does not occur in ${postingQuoteLabel}; it is compared as a substring of that copy with only letter case ignored, so copy the span out of that copy's own characters`);
    if (claim && proof && normalized(claim) === normalized(proof)) observe(SHAPE, `${label} argumentMapping.claim duplicates its proof instead of stating the candidate capability it demonstrates`);
    if (claim && relevance && normalized(claim) === normalized(relevance)) observe(SHAPE, `${label} argumentMapping.claim duplicates its relevance instead of separating the candidate capability from the target transfer`);
    // A paragraph past the budget owes no sentence about the target to separate
    // from its proof: its relevance span is the part of the paragraph that names
    // the responsibility, and that can be the proof sentence itself.
    if (owesTransfer[index] && proof && relevance && normalized(proof) === normalized(relevance)) observe(SHAPE, `${label} argumentMapping.proof duplicates its relevance instead of separating past evidence from the statement of why it matters to the target work`);
    if (claim && (!CANDIDATE_CAPABILITY_CUE.test(claim)
      || (paragraphHasCandidatePastProof(claim) && !isGeneralPresentPerfectCapability(claim))
      || FORMULAIC_TRANSFER_FRAME.test(claim))) {
      observe(SHAPE, `${label} argumentMapping.claim must state a general candidate capability, not a past proof or target-facing transfer`);
    }
    if (proof && !paragraphHasCandidatePastProof(proof)) observe(SHAPE, `${label} argumentMapping.proof does not state a candidate past action`);
    if (relevance) {
      if (GENERIC_ARGUMENT_RELEVANCE.test(relevance)) observe(SHAPE, `${label} argumentMapping.relevance uses a generic relevance label instead of explaining the transfer to target work`);
      if (jobNeedQuote && !relevanceNamesNeed(relevance, jobNeedQuote)) observe(SHAPE, `${label} argumentMapping.relevance does not name a concrete responsibility from its jobNeedQuote.${relevanceNeedRepairHint(relevance, jobNeedQuote)}`);
      else if (owesTransfer[index] && proof && normalized(proof) !== normalized(relevance)) {
        // The paragraph that owes a statement of why its proof matters owes it in
        // a sentence of its own, in whatever words the writer chooses: what is
        // judged is the part of the relevance span outside the proof's sentence,
        // and only for the words it shares with the quote it answers.
        const beyond = relevanceBeyondProof(paragraph, proof, relevance, jobNeedQuote);
        if (beyond.applicable && !beyond.ok) {
          observe(SHAPE, beyond.reached
            ? `${label} argumentMapping.relevance reaches outside its proof's sentence, but the part outside it names no concrete responsibility from its jobNeedQuote, so no sentence says how the proof bears on the target work.${relevanceNeedRepairHint(beyond.apart, jobNeedQuote, 'in the part of the relevance span outside the proof span’s sentence', 'that part')}`
            : `${label} argumentMapping.relevance sits inside the sentence its proof span comes from, so it restates the proof instead of saying how the proof bears on the target work; this paragraph owes one sentence of its own, in the writer's own words and with no particular phrase required, about the responsibility its jobNeedQuote came from, and the relevance span must be that sentence or reach into it.${jobNeedQuote ? relevanceNeedRepairHint('', jobNeedQuote, 'in the part of the relevance span outside the proof span’s sentence', 'that part') : ''}`);
        }
      }
    }
    // Outside the relevance branch on purpose, like the scope guard below: a paragraph that records no
    // relevance span is still read for a sentence that turns a use requirement into building it.
    const modality = requirementModalityObservation(label, jobNeedQuote, relevance, { claim, proof, paragraph });
    if (modality) observe(PROVENANCE, modality);
    // Outside the relevance branch on purpose: a paragraph that records no relevance
    // span (or no claim span) is still read for the promotion in its own sentences.
    const scope = evidenceScopeObservation(label, claim, proof, relevance, paragraph);
    if (scope) observe(PROVENANCE, scope);
  });
  // A posting requirement answered twice. jobNeedQuote is graded as a verbatim span of the posting and,
  // for a paragraph that owes no relevance span, as nothing more, so nothing but the writer's own
  // care keeps two paragraphs from claiming one requirement.
  // This reads the degenerate case alone: two or more proof-bearing paragraphs bound to the SAME span.
  // It asks nothing of how a quote and a paragraph share words, so a proof that shares none with any
  // sentence of the posting stays writable; it is reported here, at the review, because the drafting
  // stage cannot see a quote the review has not chosen yet.
  const paragraphsByQuote = new Map();
  plannedParagraphs.forEach((planned, index) => {
    if (planned?.argumentMapping == null) return;
    const key = words(planned.argumentMapping.jobNeedQuote).join(' ');
    if (key) paragraphsByQuote.set(key, [...(paragraphsByQuote.get(key) || []), index + 1]);
  });
  for (const ordinals of paragraphsByQuote.values()) {
    if (ordinals.length < 2) continue;
    observe(SHAPE, `paragraphs ${ordinals.length === 2 ? ordinals.join(' and ') : `${ordinals.slice(0, -1).join(', ')} and ${ordinals.at(-1)}`} bind the same argumentMapping.jobNeedQuote, so one posting requirement is answered more than once; bind each proof-bearing paragraph to the requirement its own proof answers, giving a paragraph that repeats a requirement another span of the posting it also answers, or folding it into the first`);
  }
  const mappedCount = plannedParagraphs.filter(item => item?.argumentMapping != null).length;
  if (!mappedCount && finalParagraphs.some(paragraphHasCandidatePastProof)) {
    observe(SHAPE, 'coverLetterPlan has no argumentMapping for a proof-bearing paragraph');
  }
  return argumentLinksRow(observations, mappedCount);
}

// What kind of fact an argument-mapping observation is about. A mapping is the
// review's audit of the letter, and two different things can be wrong with it.
//
// PROVENANCE: the audit says something false about where its words come from
// or what they license. A recorded span that is not a span of the paragraph, a
// jobNeedQuote that is not a span of the posting copy the writer was shown, a
// use requirement promoted into a build, a tool-assisted practice promoted into
// a product the tool powers. These are checkable against the letter and the
// posting, they have one repair, and each is a claim about a source.
//
// SHAPE: the audit does not meet the grammar the host asks of it: a claim span
// must match a closed capability grammar, a proof span must use one of a closed
// list of verbs, a relevance span must carry words of the quote, a paragraph
// that states an action owes a mapping at all, and no two paragraphs may bind
// one quote. Each is a statement about how a writer worded something, decided
// by literal word form, and a letter that fails one is not thereby false.
const PROVENANCE = 'provenance';
const SHAPE = 'shape';

// One row, two halves. The row is the legacy aggregate (every observation, in
// the order the checks ran, capped as it always was) so a reader of the single
// verdict is unchanged; `parts` carries the same observations under the two ids
// the disposition table gives different verdicts.
function argumentLinksRow(observations, mappedCount) {
  const messages = kind => observations.filter(observation => observation.kind === kind).map(observation => observation.message);
  const provenance = messages(PROVENANCE);
  const shape = messages(SHAPE);
  const row = observations.length
    ? result('paragraph-argument-links', false, observations.map(observation => observation.message).slice(0, 12).join('; '))
    : result('paragraph-argument-links', true, `${mappedCount} proof-bearing paragraph argument mapping(s) bind exact claim, proof, relevance, and job-need spans`);
  return withParts(row, [
    {
      id: 'paragraph-argument-links',
      passed: !provenance.length,
      detail: provenance.length ? provenance.slice(0, 12).join('; ') : 'every recorded span is an exact span of its paragraph and every job-need quote is a span of the posting',
      observationCount: provenance.length,
    },
    {
      id: 'paragraph-argument-shape',
      passed: !shape.length,
      detail: shape.length ? shape.slice(0, 12).join('; ') : 'every recorded mapping meets the span grammar',
      observationCount: shape.length,
    },
  ]);
}

// A jobNeedQuote reaches checkParagraphArgumentLinks only after the generation
// -audit sanitizer has truncated the field, so no quote the gate can accept is
// longer than this. localAiApplication.js reads the same constant to do that
// truncating, and the enumeration below reads it to bound the quotes it
// considers reachable: a quote longer than this is one the gate never sees.
export const MAX_ARGUMENT_MAPPING_FIELD_CHARS = 1_000;
// Beyond this the span enumeration is quadratic in a paragraph no cover letter
// writes. Past it the reporter falls back to the sentence-count verdict, which
// is the weaker one, so the subset relation holds either way.
const MAX_SPAN_ENUMERATION_WORDS = 200;

// Every content-word occurrence of the posting, with the character offsets a
// quote containing it would have to span.
function postingTermOccurrences(posting) {
  const source = normalized(posting);
  const occurrences = [];
  const pattern = /[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu;
  let match = pattern.exec(source);
  while (match) {
    for (const term of argumentContentWords(match[0])) {
      occurrences.push({ term, start: match.index, end: match.index + match[0].length });
    }
    match = pattern.exec(source);
  }
  return occurrences;
}

// Is there a verbatim posting span this relevance span would satisfy
// relevanceNamesNeed() against? That function wants two distinct relevance
// terms inside the quote, or one of nine letters or more — so the question is
// whether the posting carries one such term at all, or carries two of them
// close enough together for one quote to cover both.
function relevanceCanNameSomeNeed(relevance, occurrences) {
  const terms = new Set(argumentContentWords(relevance));
  const hits = occurrences.filter(occurrence => terms.has(occurrence.term));
  if (hits.some(occurrence => occurrence.term.length >= 9)) return true;
  for (let index = 0; index < hits.length; index += 1) {
    for (let next = index + 1; next < hits.length; next += 1) {
      if (hits[next].end - hits[index].start > MAX_ARGUMENT_MAPPING_FIELD_CHARS) break;
      if (hits[next].term !== hits[index].term) return true;
    }
  }
  return false;
}

// Does this paragraph carry a span that could be a legal relevance field?
//
// `apart` is the obligation of a paragraph that owes a sentence about the
// target: the span must say something outside the sentence its proof sits in,
// and the gate judges only that outside part (relevanceBeyondProof). The
// reporter does not know which span the audit will call the proof, so it grants
// the writer the best choice: for each sentence that states a candidate past
// action it asks whether some legal span, judged on the part outside THAT
// sentence, could name a responsibility of the posting. Every proof span lies in
// at least one such sentence and touching more sentences only removes words from
// the outside part, so a paragraph that fails here fails the gate whatever proof
// the audit picks. A paragraph with nothing but its proof sentence has no
// outside part at all, which is decided even when no posting copy is available.
// A paragraph past the budget only has to carry a span that names some
// responsibility of the posting, the same enumeration with the whole span as
// the part judged, so the reporter for such a paragraph is a subset of the gate
// for the same reason.
function paragraphOffersRelevanceSpan(paragraph, postingQuoteText, { apart = true } = {}) {
  const source = normalized(paragraph);
  const boxes = apart ? sentenceBoxes(paragraph) : [];
  if (apart && boxes.length < 2) return false;
  const posting = text(postingQuoteText);
  const words = String(paragraph).split(/\s+/u).filter(Boolean);
  if (!posting || words.length > MAX_SPAN_ENUMERATION_WORDS) return true;
  const occurrences = postingTermOccurrences(posting);
  if (!occurrences.length) return true;
  const proofSentences = apart
    ? boxes.filter(box => paragraphHasCandidatePastProof(source.slice(box.start, box.end))).map(box => new Set([box.index]))
    : [];
  // No sentence reads as a proof on its own (the cue straddles a sentence break):
  // nothing can be said to be outside it, so the whole span is judged, which is
  // the weaker verdict and therefore still a subset.
  const exclusions = proofSentences.length ? proofSentences : [new Set()];
  const spans = wordAlignedSpanBounds(source);
  for (const excluded of exclusions) {
    for (const span of spans) {
      const relevance = source.slice(span.start, span.end);
      if (GENERIC_ARGUMENT_RELEVANCE.test(relevance)) continue;
      const judged = excluded.size ? textOutsideSentences(source, boxes, span, excluded) : relevance;
      if (judged && relevanceCanNameSomeNeed(judged, occurrences)) return true;
    }
  }
  return false;
}

/**
 * Which argumentMapping spans a final cover-letter paragraph cannot supply.
 *
 * checkParagraphArgumentLinks() runs only once the review has written the
 * audit, but half of what it reads is the LETTER, which is written three
 * stages earlier. This reports the part of that verdict the letter alone
 * decides, so the stage that writes a paragraph is the stage told it cannot be
 * mapped.
 *
 * It is a strict subset of that gate, by construction rather than by care:
 * a mapping is required for exactly the paragraphs this returns spans for
 * (`paragraphHasCandidatePastProof`), every span must be an exact normalized
 * span of its paragraph, and `normalized()` is `text()` lowercased. A paragraph
 * reported here therefore has no span that could satisfy that field, and the
 * gate must report the same field. The reverse does not hold, and must not: a
 * paragraph that offers a span whose OTHER conditions fail is the review's to
 * report, not this stage's.
 *
 * "By construction" is exact only because both sides read one predicate for
 * what counts as a span of a paragraph. This enumeration used to walk whole
 * words while the gate took any substring, so a span cut out of the middle of
 * a word — “systems delivery path” inside “microsystems delivery path” — was
 * legal at completion and invisible here: the letter was reported unmappable
 * at the stage that could still rewrite it, for a field the gate would have
 * accepted. `wordAlignedSpanBounds` now enumerates exactly what
 * `wordAlignedSpanIsInParagraph` admits there.
 *
 * The relevance half needs the posting to reach that same standard. A span is
 * recognised by what it shares with the posting, in whatever wording the writer
 * chose, and the gate rejects a span that reads as a generic relevance label or
 * names nothing from the posting. A paragraph whose spans are all generic, or
 * share too little with the posting, has no legal relevance span at all — and
 * used to be reported by nobody until the completion gate read it, with the
 * letter frozen and the only repair a rewrite. With `postingQuoteText` supplied,
 * the candidate spans are enumerated instead of guessed. That argument holds
 * only while this reads the SAME posting copy checkParagraphArgumentLinks grades
 * jobNeedQuote against: a copy with fewer terms in it would report a paragraph
 * the gate can map.
 *
 * Only the first MAX_EXPLICIT_TRANSFER_PARAGRAPHS proof-bearing paragraphs of a
 * letter owe a sentence of their own about the target, so the caller passes
 * `owesTransfer` from the letter-wide explicitTransferOwed() count, the very
 * count the gate reads. Such a paragraph is reported when no span of it, judged
 * on the part outside its proof sentence, could name a responsibility of the
 * posting. A paragraph that owes a relevance span but not that sentence (a
 * budget wider than the transfer budget) is reported only when no span of it
 * could name any responsibility of the posting at all, which is a subset of
 * what the gate asks of it.
 *
 * The claim half has its own budget: only the first MAX_EXPLICIT_CLAIM_PARAGRAPHS
 * proof-bearing paragraphs owe a claim span, so the caller passes `owesClaim`
 * from the letter-wide explicitClaimOwed() count, the very count the gate reads.
 * A paragraph past it is never reported for its claim: the gate does not ask it
 * for one.
 *
 * The relevance half has one too, for the same reason: only the first
 * MAX_EXPLICIT_RELEVANCE_PARAGRAPHS proof-bearing paragraphs owe a relevance
 * span, so the caller passes `owesRelevance` from explicitRelevanceOwed(). A
 * paragraph past it is never reported for its relevance: the gate asks it for
 * nothing there, and a later paragraph therefore has no gap at all (its proof
 * span is a span of the very sentence that made it proof-bearing). The
 * `owesTransfer` flag only chooses WHICH relevance rule a paragraph that owes a
 * span is held to: the sentence apart from the proof, or any span naming the
 * responsibility.
 *
 * Returns `[{ field, rule }]`, empty when the paragraph states no past action
 * of the candidate's or already offers every span it owes.
 */
export function paragraphArgumentSpanGaps(paragraph = '', postingQuoteText = '', { owesTransfer = true, owesClaim = true, owesRelevance = true } = {}) {
  const value = text(paragraph);
  if (!paragraphHasCandidatePastProof(value)) return [];
  const gaps = [];
  // `owesClaim` is that paragraph's entry of explicitClaimOwed() over the whole
  // letter, the one count the gate reads too: a paragraph past the claim budget
  // may leave the claim out, so no gap is reported for it.
  if (owesClaim !== false && !CANDIDATE_CAPABILITY_CUE.test(value)) gaps.push({ field: 'claim', rule: ARGUMENT_CLAIM_SPAN_RULE });
  // `owesRelevance` is that paragraph's entry of explicitRelevanceOwed(), the
  // count the gate reads for the relevance span: a paragraph that owes none is
  // never reported for it. `owesTransfer` is that paragraph's entry of
  // explicitTransferOwed() over the whole letter, the one count the gate reads
  // too. A paragraph that owes a span but not the sentence apart from its proof
  // is reported only when no span of it could name a responsibility at all.
  if (owesRelevance !== false && !paragraphOffersRelevanceSpan(value, postingQuoteText, { apart: owesTransfer !== false })) {
    gaps.push({ field: 'relevance', rule: owesTransfer !== false ? ARGUMENT_RELEVANCE_SPAN_RULE : ARGUMENT_LATER_RELEVANCE_SPAN_RULE });
  }
  return gaps;
}

/**
 * The drafting-stage twin of the argument audit, as a check row.
 *
 * paragraphArgumentSpanGaps asks, of each paragraph that states an action of
 * the candidate's own, whether the paragraph could supply a claim span and a
 * relevance span at all. Those spans are the shape mandates of the audit
 * (CLAIM and RELEVANCE grammar), so a paragraph that cannot supply one is not
 * thereby false, and the twin was measured rejecting paragraphs that were not
 * defective. It carries the id `paragraph-argument-span-gaps`, which the
 * disposition table keeps OFF: the row exists so the id is named and a caller
 * that wants the observation can still read it, and a caller that partitions
 * by disposition drops it. `postingQuoteText` is the posting copy
 * checkParagraphArgumentLinks grades jobNeedQuote against.
 */
export function checkParagraphArgumentSpanGaps(paragraphs = [], postingQuoteText = '') {
  const list = (Array.isArray(paragraphs) ? paragraphs : []).map(text);
  const owesTransfer = explicitTransferOwed(list);
  const owesClaim = explicitClaimOwed(list);
  const owesRelevance = explicitRelevanceOwed(list);
  const observations = [];
  list.forEach((paragraph, index) => {
    const gaps = paragraphArgumentSpanGaps(paragraph, postingQuoteText, {
      owesTransfer: owesTransfer[index], owesClaim: owesClaim[index], owesRelevance: owesRelevance[index],
    });
    if (gaps.length) observations.push(`paragraph ${index + 1} contains no span that could be its ${gaps.map(gap => gap.field).join(' or its ')}`);
  });
  return observationResult('paragraph-argument-span-gaps', observations, MAX_GENERIC_OBSERVATIONS,
    `${list.length} paragraph(s) each offer the spans their audit mapping would record`);
}

// Deliberately wider than PAST_PROOF_CUE's closed verb list. That list decides
// which paragraph owes an argumentMapping, a question about one paragraph's
// argument; this one asks whether the candidate ever acts anywhere in the
// letter, and “I kept the service dependable” is first-person agency even
// though "kept" is not a proof verb. Reading the narrow list here would
// misreport ordinary first-person prose as evasion. Present-tense lookalikes
// ending in -ed are excluded so “I need …” is not read as a past action.
const FIRST_PERSON_AGENCY_CUE = /\b(?:i|we)\s+(?:(?:have|had|also|then|later|personally)\s+){0,2}(?!need|exceed|proceed|succeed|speed)(?:[\p{L}]+ed|built|kept|wrote|led|ran|made|took|gave|held|sent|drove|brought|taught|met|set|put|began|chose|found|grew|knew|left|paid|read|said|saw|sold|spent|stood|told|won|rebuilt|oversaw)\b/iu;

/**
 * A letter in which no paragraph ever makes the candidate the subject of a
 * completed action. Every span rule above is gated on that cue, so a writer
 * who describes the artifact acting instead — “my app connected …”, “a
 * project moved …”, “pipelines handled …” — owes no argumentMapping on any
 * paragraph, and the claim/proof/relevance triad that carries the argument is
 * never demanded. The letter then reads as a tour of systems that happen to
 * exist rather than work the candidate did, which is the same defect from the
 * reader's side. One first-person proof somewhere in an evidence-bearing
 * letter is the floor, not a style preference: below it the whole argument
 * battery silently has nothing to grade.
 */
export function checkCandidateAgency(paragraphs = []) {
  const list = (Array.isArray(paragraphs) ? paragraphs : []).map(text).filter(Boolean);
  if (!list.length) return result('candidate-agency', true, 'no paragraphs to read for candidate agency');
  const proofCount = list.filter(paragraph => FIRST_PERSON_AGENCY_CUE.test(paragraph)).length;
  if (proofCount) {
    return result('candidate-agency', true,
      `${proofCount} paragraph(s) state a completed action in the candidate's own first person`);
  }
  return result('candidate-agency', false,
    'no paragraph states a completed action in the candidate\u2019s own first person; the letter attributes every action to an artifact, project or system, so no paragraph owes an argumentMapping and the claim, proof and relevance spans go ungraded');
}

// ---------------------------------------------------------------------------
// LETTER PROPORTION
//
// Every other check in this module grades a paragraph, a sentence or a pair of
// them. None grades how much letter there is, and the resulting blind spot is
// measured: a letter cut into dozens of one-sentence paragraphs, each an
// impersonal restatement of one detail of a project the résumé already lists,
// passed every paragraph-level check. It was cheaper to pass that way than to
// write a real letter, because the template checks relax as the paragraph
// count grows (sharedSentenceShapeCeiling is "all but two"), a three-word
// repeat is a defect inside one paragraph but not across two, and the prompts
// offered "split the paragraph" as the repair for almost every cohesion
// defect. Blind reviewers then reported "inventory", "fragmentation" and
// "robotic pattern" on such a letter in every round, and no round could repair
// it, because the host had no rule that a repair could satisfy.
//
// This check is that rule. It reads STRUCTURE only: counts of paragraphs,
// sentences and words, which paragraphs state a first-person action, and, when
// the caller can say which career-data quote each paragraph cites, how many
// paragraphs lean on one quote. It reads no wording from the letter and names
// no domain, employer or tool, so it cannot reject a letter for what it says,
// only for how it is cut. Truthfulness is graded elsewhere and is not touched.
//
// Every threshold below is a ceiling or floor a competent short letter sits
// well inside. The margins were measured on synthetic letters in unrelated
// fields (scripts/tests/gapfix-letter-proportion.js: five letters of 3 to 6
// paragraphs and 230 to 394 words, and a four-paragraph letter whose one-line
// hook and one-line direct welcome checkDirectWelcomeClosing certifies), each
// authored to pass the whole editorial battery. An atomised letter breaks most
// of the limits at once: far too many paragraphs, nearly all of them one
// sentence, a paragraph mean of about half the floor, almost no paragraph
// stating an action of the writer's own, a small share of sentences in the
// writer's voice, and one quote under many paragraphs. Below, "judged" means
// these limits apply.

// Apply proportion advice only when there is enough text to assess it.
// This threshold never requires a shorter letter to be expanded.
export const LETTER_PROPORTION_MIN_JUDGED_WORDS = 90;
// The design system's letter is "3-4 paragraphs" and a persuasive one-page
// letter is an opening that states the thesis, one to three proofs and a
// close. Seven is two paragraphs past the longest of those, so a legitimate
// letter is never near it; an inventory grows with the career's detail and
// passes it at once. One page is also the render target, which is enforced
// only after every review round, so this is the early form of that limit.
export const MAX_LETTER_BODY_PARAGRAPHS = 7;
// A paragraph carries a proof and the reason it transfers. At the letter's
// measure a typeset line holds about 15 words, so a mean of 25 is a little under
// two lines per paragraph: a letter whose paragraphs average less than that is
// mostly fragments, whatever the sentence count. Two shapes fix the number. An
// atomised letter is paragraphs of one short sentence each, and a sentence of a
// dozen words is half of it. The shortest honest letter the rest of the battery
// certifies, a one-line hook, two proof paragraphs of about 36 to 45 words and a
// one-line direct welcome of 14 to 20, has a mean of roughly 25 to 32 words; the
// floor is the bottom of that range, so it does not reject the shape the other
// checks accept. Letters with proof paragraphs of the usual 45 to 80 words
// average well over it.
export const MIN_MEAN_PARAGRAPH_WORDS = 25;
// Anti-evasion for the two limits above. Without a ceiling here a detail dump
// satisfies the paragraph count by regrouping into a few walls of text. The
// sentence-length rule caps one sentence at MAX_SENTENCE_WORDS (40), so seven
// sentences is routinely past 100 words in one paragraph, which is no longer
// one argumentative job. Measured good letters stop at 5.
export const MAX_PARAGRAPH_SENTENCES = 6;
// A standalone sentence is an emphasis: a one-line hook that opens the letter
// and a one-line direct welcome that closes it, which is the shape
// checkDirectWelcomeClosing certifies. Two are always allowed, because a
// four-paragraph letter that uses both would otherwise be told it has too many
// (and the repair for that was to cut a real paragraph or to pad the hook).
// Past that, one more is allowed for every SINGLE_SENTENCE_PARAGRAPH_SHARE_DIVISOR
// paragraphs. Within the paragraph ceiling the divisor never raises the number
// of standalone sentences, which is deliberate: a letter of seven paragraphs may
// have two, and the third one-line paragraph of a letter is the start of the
// inventory shape this check exists to refuse. Counting in thirds rather than
// halves keeps the allowance low for any larger ceiling a later change sets.
export const MIN_STANDALONE_SENTENCE_PARAGRAPH_ALLOWANCE = 2;
export const SINGLE_SENTENCE_PARAGRAPH_SHARE_DIVISOR = 3;
// The share of body paragraphs that must state an action of the writer's own: I
// or we as the subject of a verb that says what they did or do (see
// PROPORTION_NON_ACTION_WORDS for what does not count). The narrower cue
// checkCandidateAgency reads is satisfied by ONE paragraph anywhere, which is
// what lets a letter of artifact-as-actor detail sentences through. The usual
// letter has this in every proof paragraph and lacks it only in a closing, so
// 40% leaves room for a thesis opening and a closing that make no claim of
// their own; an atomised letter has a small fraction of that.
export const MIN_FIRST_PERSON_ACTION_PARAGRAPH_SHARE = 0.4;
// The share of all sentences in the writer's own voice (I, we, my, our, me).
// This reads inside paragraphs, so it also refuses a first-person opening
// followed by a run of sentences about what a system "does" or "includes",
// which the paragraph share above cannot see. Measured good letters: 46% and
// up. 30% leaves room for transfer sentences that speak to the employer.
export const MIN_FIRST_PERSON_SENTENCE_SHARE = 0.3;
// Most paragraphs that may cite one career-data quote. A quote supports one
// proof; a proof is one paragraph, a second may return to it for the transfer
// and a closing may gather it with others. The fifth paragraph on one quote is
// a feature list of the same bullet, which an atomised letter spreads across
// many paragraphs. Measured good letters stop at 3.
export const MAX_PARAGRAPHS_PER_CITED_QUOTE = 4;

const FIRST_PERSON_VOICE_CUE = /\b(?:i|we|my|our|me)\b/iu;
const MAX_PROPORTION_PARAGRAPH_REFERENCES = 5;

/** Two standalone sentences are always allowed, then one more per divisor paragraphs; see MIN_STANDALONE_SENTENCE_PARAGRAPH_ALLOWANCE. */
export function letterSingleSentenceAllowance(paragraphCount) {
  return Math.max(MIN_STANDALONE_SENTENCE_PARAGRAPH_ALLOWANCE, Math.floor(paragraphCount / SINGLE_SENTENCE_PARAGRAPH_SHARE_DIVISOR));
}

/** Paragraphs that must state a first-person action, for a letter of this many. */
export function letterFirstPersonActionParagraphFloor(paragraphCount) {
  return Math.ceil(paragraphCount * MIN_FIRST_PERSON_ACTION_PARAGRAPH_SHARE);
}

// WHAT COUNTS AS AN ACTION OF THE WRITER'S OWN, for this check only. The cue
// checkCandidateAgency reads is a closed list of past-tense verbs with at most
// two helper words between the subject and the verb; it answers a different
// question (does the candidate act anywhere in the letter) and stays as it is.
// Used here, it rejected honest prose in three ways the message could not
// explain, because the paragraph it named already satisfied the message's own
// wording: an adverb between subject and verb (“I carefully fixed”), a verb that
// is not in the list (“I cut”, “I rewrote”), and a letter written from a current
// role (“I review”, “I lead”). So the proportion cue reads the OTHER side of the
// question: a first-person subject followed, after any adverbs, by a word that is
// not on a CLOSED list of words that name no action. A list of what is not an
// action can be exhaustive where a list of verbs cannot, and a word missing from
// it errs towards counting a real verb. What the list holds, by kind:
//   - helpers and modals: the speaker is not yet doing anything (“I would”,
//     “I can”, “I will”, “we have”), and the copulas (“I am”, “we are”, “I was”);
//   - negation and the function words that join clauses instead of acting;
//   - verbs of attitude or presence (want, hope, believe, look, welcome, like,
//     love, enjoy, appreciate, think, know, feel, see, seem, understand, expect,
//     trust, prefer, agree, wish, value) with their inflections: the closing of a
//     letter says them and they state no work;
//   - the letter's own verbs about the letter or about holdings (write, submit,
//     enclose, attach, thank, express, bring, offer, possess): a claim to hold
//     something or to be writing, not a thing done.
// A contraction (“I'd”, “I'm”, “we're”, “I'll”) never reaches the verb at all,
// because the subject must be followed by whitespace, so “I'd built” does not
// count and is not one of the forms the message promises. “I've” and “we've”
// are the perfect: “I've built” is read as “I have built”, and after “have” or
// “had” only a participle counts (“I have experience” states no work).
export const PROPORTION_NON_ACTION_WORDS = new Set([
  // helpers, modals and copulas
  'am', 'are', 'is', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'having', 'do', 'does', 'did',
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must', 'ought', 'cannot', 'need', 'needs',
  // negation and function words
  'not', 'no', 'never', 'and', 'or', 'but', 'nor', 'so', 'yet', 'as', 'if', 'than', 'that', 'which', 'who', 'whom', 'whose', 'when', 'while', 'where', 'whether', 'because',
  'although', 'though', 'since', 'after', 'before', 'until', 'in', 'on', 'at', 'to', 'of', 'for', 'with', 'without', 'by', 'from', 'into', 'onto', 'over', 'under', 'about',
  'between', 'among', 'through', 'during', 'within', 'upon', 'via', 'per', 'the', 'a', 'an', 'this', 'these', 'those', 'my', 'our', 'your', 'their', 'his', 'her', 'its',
  'me', 'us', 'you', 'him', 'them', 'it', 'i', 'we', 'they', 'he', 'she', 'both', 'each', 'every', 'all', 'some', 'any', 'one',
  // attitude, presence and perception
  'want', 'wants', 'wanted', 'wanting', 'hope', 'hopes', 'hoped', 'hoping', 'believe', 'believes', 'believed', 'believing', 'look', 'looks', 'looked', 'looking',
  'welcome', 'welcomes', 'welcomed', 'welcoming', 'wish', 'wishes', 'wished', 'wishing', 'like', 'likes', 'liked', 'love', 'loves', 'loved', 'enjoy', 'enjoys', 'enjoyed',
  'appreciate', 'appreciates', 'appreciated', 'think', 'thinks', 'thought', 'know', 'knows', 'knew', 'feel', 'feels', 'felt', 'see', 'sees', 'seem', 'seems', 'seemed',
  'understand', 'understands', 'understood', 'expect', 'expects', 'expected', 'trust', 'trusts', 'trusted', 'prefer', 'prefers', 'preferred', 'agree', 'agrees', 'agreed',
  'value', 'values', 'valued', 'recognize', 'recognizes', 'recognise', 'recognises', 'remain', 'remains', 'remained',
  // the letter's own verbs and statements of holding
  'write', 'writes', 'submit', 'submits', 'enclose', 'encloses', 'enclosed', 'attach', 'attaches', 'attached', 'thank', 'thanks', 'express', 'expresses',
  'bring', 'brings', 'offer', 'offers', 'possess', 'possesses',
]);
// Adverbs that may stand between the subject and the verb. Any word ending in
// -ly is one, except the verbs and nouns that end that way; the short list
// after it is the adverbs that do not.
const PROPORTION_LY_NOT_ADVERBS = new Set(['apply', 'supply', 'reply', 'rely', 'imply', 'comply', 'multiply', 'ally', 'rally', 'tally', 'fly', 'bully', 'family', 'assembly', 'italy']);
const PROPORTION_PLAIN_ADVERBS = new Set(['also', 'then', 'later', 'just', 'still', 'now', 'often', 'always', 'usually', 'again', 'first', 'once', 'twice', 'even', 'soon', 'already', 'next', 'previously', 'very', 'quite', 'much', 'too', 'almost', 'nearly']);
// The helper words after which only a participle states work done.
const PROPORTION_PERFECT_HELPERS = new Set(['have', 'had']);
const PROPORTION_PARTICIPLE = /^(?!need$|exceed$|proceed$|succeed$|speed$)(?:[\p{L}]+ed|built|kept|wrote|written|led|ran|run|made|took|taken|gave|given|held|sent|drove|driven|brought|taught|met|set|put|began|begun|chose|chosen|found|grew|grown|knew|known|left|paid|read|said|saw|seen|sold|spent|stood|told|won|rebuilt|oversaw|overseen|cut|done|did|caught|rewrote|rewritten|got|gotten|became|become)$/iu;

function isProportionAdverb(word) {
  const lower = word.toLowerCase();
  if (PROPORTION_PLAIN_ADVERBS.has(lower)) return true;
  return /^\p{L}{3,}ly$/u.test(lower) && !PROPORTION_LY_NOT_ADVERBS.has(lower);
}

function proportionWordTokens(rest) {
  return (rest.match(/\S+/gu) || []).slice(0, 6)
    .map(token => token.replace(/^[("'“‘[]+/u, '').replace(/[)"'”’\],.;:!?]+$/u, ''))
    .filter(token => token !== '');
}

/**
 * Does the paragraph say “I” or “we” and then a word that names something done?
 * See PROPORTION_NON_ACTION_WORDS for the whole definition.
 */
export function paragraphStatesFirstPersonAction(paragraph) {
  // “I've built” is the same claim as “I have built”; the subject must be
  // followed by whitespace, which an apostrophe is not, so the contraction is
  // expanded first. “I'd” is left alone and therefore never counts.
  const source = String(paragraph ?? '').replace(/\b(i|we)['’]ve\b/giu, '$1 have');
  for (const match of source.matchAll(/\b(?:i|we)\s+(?=\S)/giu)) {
    const tokens = proportionWordTokens(source.slice(match.index + match[0].length, match.index + match[0].length + 120));
    let perfect = false;
    for (let position = 0; position < Math.min(tokens.length, 4); position += 1) {
      const word = tokens[position];
      const lower = word.toLowerCase();
      if (PROPORTION_PERFECT_HELPERS.has(lower)) { perfect = true; continue; }
      if (isProportionAdverb(word)) continue;
      if (!/^\p{L}[\p{L}-]*$/u.test(word) || PROPORTION_NON_ACTION_WORDS.has(lower)) break;
      if (!perfect || PROPORTION_PARTICIPLE.test(word)) return true;
      break;
    }
  }
  return false;
}

function citationKey(value) {
  return text(value).toLowerCase();
}

function paragraphReferences(ordinals) {
  const visible = ordinals.slice(0, MAX_PROPORTION_PARAGRAPH_REFERENCES);
  const hidden = ordinals.length - visible.length;
  const labels = visible.map(String);
  // “4, 7 and 9”, or, when the list is cut, “4, 7, 8, 9 and 34 more”: one
  // conjunction either way.
  if (hidden) return `${labels.join(', ')} and ${hidden} more`;
  return labels.length < 2 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * The measured structure of a letter and every proportion limit it breaks.
 * Pure over the paragraphs (and, optionally, the quotes each cites), so the
 * message below and the tests read the same numbers.
 *
 * `citations` is parallel to `paragraphs`: for paragraph i, the career-data
 * quotes (or any stable per-quote key) it cites. When it is absent or does not
 * line up with the paragraphs, the quote limit is not judged rather than
 * guessed; the structural limits do not need it.
 */
export function analyzeLetterProportion(paragraphs = [], { citations = null } = {}) {
  const source = Array.isArray(paragraphs) ? paragraphs : [];
  const body = [];
  source.forEach((paragraph, sourceIndex) => {
    const value = text(paragraph);
    if (value) body.push({ value, sourceIndex });
  });
  const units = body.map(({ value, sourceIndex }, index) => {
    const own = sentences(value);
    return {
      ordinal: index + 1,
      sourceIndex,
      words: wordCount(value),
      sentences: own.length || 1,
      firstPersonSentences: own.filter(sentence => FIRST_PERSON_VOICE_CUE.test(sentence)).length,
      statesAction: paragraphStatesFirstPersonAction(value),
    };
  });
  const paragraphCount = units.length;
  const totalWords = units.reduce((sum, unit) => sum + unit.words, 0);
  const totalSentences = units.reduce((sum, unit) => sum + unit.sentences, 0);
  const firstPersonSentences = units.reduce((sum, unit) => sum + unit.firstPersonSentences, 0);
  const metrics = {
    paragraphCount,
    totalWords,
    totalSentences,
    meanParagraphWords: paragraphCount ? totalWords / paragraphCount : 0,
    firstPersonSentences,
    actionParagraphs: units.filter(unit => unit.statesAction).length,
    quoteLimitJudged: false,
  };
  if (!paragraphCount || totalWords < LETTER_PROPORTION_MIN_JUDGED_WORDS) {
    return { judged: false, metrics, violations: [] };
  }
  const violations = [];
  if (paragraphCount > MAX_LETTER_BODY_PARAGRAPHS) {
    violations.push({ gate: 'paragraph-count', paragraphCount, limit: MAX_LETTER_BODY_PARAGRAPHS });
  }
  const singles = units.filter(unit => unit.sentences === 1);
  const allowance = letterSingleSentenceAllowance(paragraphCount);
  if (singles.length > allowance) {
    violations.push({ gate: 'single-sentence-paragraphs', ordinals: singles.map(unit => unit.ordinal), allowance, paragraphCount });
  }
  if (metrics.meanParagraphWords < MIN_MEAN_PARAGRAPH_WORDS) {
    violations.push({ gate: 'paragraph-length', mean: metrics.meanParagraphWords, limit: MIN_MEAN_PARAGRAPH_WORDS });
  }
  const long = units.filter(unit => unit.sentences > MAX_PARAGRAPH_SENTENCES);
  if (long.length) {
    violations.push({ gate: 'paragraph-sentences', ordinals: long.map(unit => unit.ordinal), counts: long.map(unit => unit.sentences), limit: MAX_PARAGRAPH_SENTENCES });
  }
  const required = letterFirstPersonActionParagraphFloor(paragraphCount);
  if (metrics.actionParagraphs < required) {
    violations.push({
      gate: 'first-person-action-paragraphs',
      ordinals: units.filter(unit => !unit.statesAction).map(unit => unit.ordinal),
      have: metrics.actionParagraphs,
      required,
      paragraphCount,
    });
  }
  if (totalSentences && firstPersonSentences / totalSentences < MIN_FIRST_PERSON_SENTENCE_SHARE) {
    violations.push({ gate: 'first-person-voice', have: firstPersonSentences, totalSentences, share: MIN_FIRST_PERSON_SENTENCE_SHARE });
  }
  if (Array.isArray(citations) && citations.length === source.length) {
    metrics.quoteLimitJudged = true;
    const byQuote = new Map();
    for (const unit of units) {
      const own = Array.isArray(citations[unit.sourceIndex]) ? citations[unit.sourceIndex] : [];
      for (const key of new Set(own.map(citationKey).filter(Boolean))) {
        byQuote.set(key, [...(byQuote.get(key) || []), unit.ordinal]);
      }
    }
    const over = [...byQuote.values()].filter(ordinals => ordinals.length > MAX_PARAGRAPHS_PER_CITED_QUOTE);
    if (over.length) {
      const worst = over.reduce((best, ordinals) => (ordinals.length > best.length ? ordinals : best));
      violations.push({ gate: 'quote-reuse', ordinals: worst, quotes: over.length, limit: MAX_PARAGRAPHS_PER_CITED_QUOTE });
    }
  }
  return { judged: true, metrics, violations };
}

// What the action floor counts, stated once for the message and the printed
// rule, from the words the cue is tested on. The examples are checked against
// paragraphStatesFirstPersonAction in the tests, so neither list can drift from
// the cue and a rejected paragraph is told something true about itself.
export const PROPORTION_ACTION_EXAMPLES = Object.freeze(['I carefully fixed', 'I review']);
export const PROPORTION_NON_ACTION_EXAMPLES = Object.freeze(['would', 'can', 'am', 'want', 'hope', 'believe', 'look', 'welcome']);
export const PROPORTION_ACTION_STATEMENT =
  `I or we, then a verb for what you did or do, even after an adverb: ${PROPORTION_ACTION_EXAMPLES.map(example => `“${example}”`).join(', ')}; `
  + `“I’d” and ${PROPORTION_NON_ACTION_EXAMPLES.join(', ')} state none`;

/**
 * The instruction for each limit names the OPERATION that repairs it (merge,
 * append, delete, rewrite with the writer as the subject), and each clause is
 * printed only when its own limit failed: a single message for all of them
 * would leave the writer rewriting the half that already passed. No clause
 * quotes or names anything from the letter, so there is nothing in it to copy
 * into a document; paragraphs are named by number.
 */
function describeLetterProportionViolation(violation) {
  const many = violation.ordinals ? violation.ordinals.length > 1 : false;
  switch (violation.gate) {
    case 'paragraph-count':
      return `${violation.paragraphCount} body paragraphs against a ceiling of ${violation.limit}: merge at least ${violation.paragraphCount - violation.limit} into the paragraph each supports, or delete those that only add a detail the résumé lists`;
    case 'single-sentence-paragraphs':
      return `paragraphs ${paragraphReferences(violation.ordinals)} are single sentences against an allowance of ${violation.allowance}: append each extra one to the paragraph it supports, or delete it when the paragraph before it already makes the point`;
    case 'paragraph-length':
      return `paragraphs average ${violation.mean.toFixed(1)} words against a minimum of ${violation.limit}: combine short neighbours until each develops one proof in two to four sentences`;
    case 'paragraph-sentences':
      return `paragraph${many ? 's' : ''} ${paragraphReferences(violation.ordinals)} run${many ? '' : 's'} ${many ? `${Math.min(...violation.counts)} to ${Math.max(...violation.counts)}` : violation.counts[0]} sentences against a ceiling of ${violation.limit}: keep the sentences that carry its one proof and delete those that only list more features of the same work`;
    case 'first-person-action-paragraphs':
      return `${violation.have} of ${violation.paragraphCount} paragraphs state an action of your own (${PROPORTION_ACTION_STATEMENT}) against a minimum of ${violation.required}; paragraph${many ? 's' : ''} ${paragraphReferences(violation.ordinals)} ${many ? 'do' : 'does'} not: rewrite each to say what you did, or fold its one detail into a paragraph that does`;
    case 'first-person-voice':
      return `${violation.have} of ${violation.totalSentences} sentences speak in your own voice (I, we, my or our) against a minimum of ${Math.round(violation.share * 100)}%: delete sentences that restate a résumé detail and rewrite the rest to say what you did`;
    case 'quote-reuse':
      return `paragraphs ${paragraphReferences(violation.ordinals)} cite the same career-data quote against a maximum of ${violation.limit}: merge the others into the paragraph that develops that proof, or delete them`;
    default:
      return String(violation.gate);
  }
}

/**
 * The letter is cut into too many pieces, or is an inventory of one source,
 * or is written about systems rather than by a person. See the block comment
 * above for what each limit protects and why it sits where it does.
 */
export function checkLetterProportion(paragraphs = [], options = {}) {
  const analysis = analyzeLetterProportion(paragraphs, options);
  const { metrics } = analysis;
  // The paragraph ceiling is the one proportion limit that is a property of the
  // page rather than of the writing: a letter cut into more body paragraphs
  // than any one-page letter holds cannot be set on its page however well each
  // is written (the atomised letter this check was built for). It is its own
  // half, under its own id, so it can hold as hygiene while every other
  // proportion limit, each a count over how the letter is worded and cut, is
  // advisory. The row's own shape is unchanged.
  const split = (row, ceiling, rest) => withParts(row, [
    { id: 'letter-paragraph-ceiling', passed: !ceiling, detail: ceiling || `${metrics.paragraphCount} body paragraph(s), within the ceiling of ${MAX_LETTER_BODY_PARAGRAPHS}`, observationCount: 1 },
    { id: 'letter-proportion', passed: !rest.length, detail: rest.length ? rest.join('; ') : 'within the other letter proportion limits', observationCount: rest.length },
  ]);
  if (!analysis.judged) {
    return split(result('letter-proportion', true,
      `skipped: the letter has ${metrics.paragraphCount} paragraph(s) and ${metrics.totalWords} words, and proportion is judged from ${LETTER_PROPORTION_MIN_JUDGED_WORDS} words`), '', []);
  }
  if (!analysis.violations.length) {
    return split(result('letter-proportion', true,
      `${metrics.paragraphCount} paragraph(s), ${metrics.totalWords} words and ${metrics.totalSentences} sentences are within the letter proportion limits`), '', []);
  }
  const ceiling = analysis.violations.filter(violation => violation.gate === 'paragraph-count').map(describeLetterProportionViolation).join('; ');
  const rest = analysis.violations.filter(violation => violation.gate !== 'paragraph-count').map(describeLetterProportionViolation);
  return split(result('letter-proportion', false,
    `${analysis.violations.map(describeLetterProportionViolation).join('; ')};`
    + ' a merge is read as one paragraph by the repeated-phrase and sentence-shape checks, so reword any repeat'), ceiling, rest);
}

/** The limits the contract prints, derived from the constants so prose and gate cannot drift. */
export const LETTER_PROPORTION_RULE =
  `a letter of ${LETTER_PROPORTION_MIN_JUDGED_WORDS} words or more is graded for proportion: at most ${MAX_LETTER_BODY_PARAGRAPHS} body paragraphs`
  + `, an average of at least ${MIN_MEAN_PARAGRAPH_WORDS} words per paragraph and no paragraph past ${MAX_PARAGRAPH_SENTENCES} sentences`
  + `, at most ${MIN_STANDALONE_SENTENCE_PARAGRAPH_ALLOWANCE} standalone one-sentence paragraphs (a one-line hook and a one-line closing, never a detail of the evidence)`
  + `, at least ${Math.round(MIN_FIRST_PERSON_ACTION_PARAGRAPH_SHARE * 100)}% of paragraphs stating an action of your own (${PROPORTION_ACTION_STATEMENT})`
  + `, at least ${Math.round(MIN_FIRST_PERSON_SENTENCE_SHARE * 100)}% of all sentences in your own voice (I, we, my or our)`
  + `, and no career-data quote cited by more than ${MAX_PARAGRAPHS_PER_CITED_QUOTE} paragraphs`
  + '. A persuasive letter selects the strongest two or three proofs, develops each in one paragraph of two to four sentences, and binds each to the work it answers; detail beyond those proofs stays in the résumé and does not get a paragraph of its own';

const PERFORMANCE_NEED_KINDS = new Set(['capability', 'domain', 'scale']);
const ELIGIBILITY_NEED_KINDS = new Set(['credential', 'logistics']);

/**
 * A requirements list dominated by credentials/age/other screens gives the
 * argument planner no view of the work the person would actually perform.
 * This is intentionally a portfolio check, not a claim that eligibility is
 * unimportant: only lists of three or more need two supported work-oriented
 * requirements.
 */
export function checkNeedsPortfolio(needs = []) {
  const list = Array.isArray(needs) ? needs : [];
  if (list.length < 3) return result('needs-portfolio', true, `${list.length} need(s); performance portfolio minimum does not apply`);
  const performanceCount = list.filter(need => PERFORMANCE_NEED_KINDS.has(text(need?.kind))).length;
  return performanceCount >= 2
    ? result('needs-portfolio', true, `${performanceCount} performance-oriented need(s) in ${list.length}-need portfolio`)
    : result('needs-portfolio', false,
      `needs portfolio has ${performanceCount} performance-oriented need(s) (capability/domain/scale); at least 2 are required when ${list.length} needs are extracted`);
}

function needsPortfolioQuality(needs, check) {
  const list = Array.isArray(needs) ? needs : [];
  const performanceCount = list.filter(need => PERFORMANCE_NEED_KINDS.has(text(need?.kind))).length;
  return (check?.passed ? 100000 : 0) + performanceCount * 100 + list.length;
}

/** Keeps the best completed needs pass while the convergence loop continues. */
export function selectBetterLetterNeeds(firstNeeds, firstCheck, retryNeeds, retryCheck) {
  return needsPortfolioQuality(retryNeeds, retryCheck) > needsPortfolioQuality(firstNeeds, firstCheck)
    ? { needs: retryNeeds, check: retryCheck, selected: 'retry' }
    : { needs: firstNeeds, check: firstCheck, selected: 'first' };
}

/**
 * Legacy compatibility entry point. Career-data support never makes logistics
 * cover-letter material; any nonempty plan value is now rejected outright.
 */
export function checkLogisticsGrounding(plan = {}, careerData = '') {
  void careerData;
  return checkLogisticsExclusion(plan);
}

function droppedNeed(plan, needIndex) {
  return (Array.isArray(plan?.droppedNeeds) ? plan.droppedNeeds : [])
    .find(item => Number(item?.needIndex) === needIndex && text(item?.reason));
}

function mappedNeedIndexes(plan) {
  return new Set((Array.isArray(plan?.mappings) ? plan.mappings : [])
    .map(mapping => Number(mapping?.needIndex))
    .filter(Number.isInteger));
}

/** Every employer need must be either argued or consciously recorded as dropped. */
export function checkAllNeedDisposition(plan = {}, needs = []) {
  const rankedNeeds = Array.isArray(needs) ? needs : [];
  if (!rankedNeeds.length) return result('all-needs-disposition', true, 'skipped: ranked needs unavailable');
  const mapped = mappedNeedIndexes(plan);
  const missing = rankedNeeds.findIndex((_, index) => !mapped.has(index) && !droppedNeed(plan, index));
  return missing === -1
    ? result('all-needs-disposition', true, `${rankedNeeds.length} ranked need(s) are mapped or recorded as dropped`)
    : result('all-needs-disposition', false, `need ${missing + 1} is neither mapped nor recorded as dropped`);
}

/**
 * Surface every consciously dropped eligibility screen. This is a status, not
 * a repair instruction: prose cannot truthfully create a credential, driver
 * authorization, or other logistical qualification. `item.reason` is
 * curly-quoted below though this check is not (yet) in PASTE_CHECK_PROSE_UNITS'
 * fingerprinted battery — see checkPriorEmployerOpening's comment above; the
 * same bare-interpolation defect would reappear the day this check joins that
 * battery, so it is fixed here on the same audit pass rather than left for a
 * second incident to find.
 */
export function checkEligibilityNeedDisposition(plan = {}, needs = []) {
  const rankedNeeds = Array.isArray(needs) ? needs : [];
  const mapped = mappedNeedIndexes(plan);
  const dropped = rankedNeeds.flatMap((need, index) => {
    if (mapped.has(index) || !ELIGIBILITY_NEED_KINDS.has(text(need?.kind))) return [];
    const item = droppedNeed(plan, index);
    return item ? [{ index, kind: text(need?.kind), reason: text(item.reason) }] : [];
  });
  if (!dropped.length) return result('eligibility-need-disposition', true, 'no eligibility need is honestly dropped');
  return result('eligibility-need-disposition', false,
    `${dropped.length} eligibility need(s) honestly dropped: ${dropped.map(item => `#${item.index + 1} ${item.kind} — “${boundedDetailValue(item.reason)}”`).join('; ')}`);
}

/**
 * A truthful plan may leave a hard credential or eligibility screen unargued.
 * That cannot be fixed by asking the model to invent a qualification, but it
 * must remain visible beside the shipped letter rather than only in telemetry.
 * `dropped.reason` is curly-quoted below — see checkEligibilityNeedDisposition's
 * comment above.
 */
export function checkTopNeedDisposition(plan = {}, needs = []) {
  const rankedNeeds = Array.isArray(needs) ? needs : [];
  if (!rankedNeeds.length) return result('top-need-disposition', true, 'skipped: ranked needs unavailable');
  const mappings = Array.isArray(plan?.mappings) ? plan.mappings : [];
  if (mappings.some(mapping => Number(mapping?.needIndex) === 0)) {
    return result('top-need-disposition', true, 'top-ranked need is argued');
  }
  const dropped = droppedNeed(plan, 0);
  if (dropped) {
    const kind = text(rankedNeeds[0]?.kind) || 'requirement';
    return result('top-need-disposition', false,
      `top-ranked ${kind} need is not argued (honestly dropped): ${dropped.reason ? `“${boundedDetailValue(dropped.reason)}”` : 'no reason recorded'}`);
  }
  return result('top-need-disposition', false, 'top-ranked need is neither argued nor recorded as dropped');
}

export function checkRedundancy(paragraphs = [], evidence = {}) {
  const bullets = bulletTexts(evidence);
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  for (let paragraphIndex = 0; paragraphIndex < list.length; paragraphIndex++) {
    const paragraphWords = words(list[paragraphIndex]);
    for (let bulletIndex = 0; bulletIndex < bullets.length; bulletIndex++) {
      const run = longestSharedRun(paragraphWords, words(bullets[bulletIndex]));
      if (run.length >= REDUNDANCY_SHINGLE_WORDS) {
        return result('redundancy', false,
          `paragraph ${paragraphIndex + 1} shares a ${run.length}-word run ${quotedRunPhrase(run.words)} with résumé bullet ${bulletIndex + 1}`);
      }
    }
  }
  return result('redundancy', true, `${list.length} paragraph(s) have no ${REDUNDANCY_SHINGLE_WORDS}-word résumé run`);
}

// Wording a résumé repeats is that résumé's refrain, and a letter that picks the
// refrain up again is echoing the document it is supposed to complement even
// when the run is far shorter than the verbatim floor. No phrase list decides
// this, because which phrases are a refrain depends entirely on the résumé in
// front of the check: a short run of words counts only when TWO OR MORE of the
// current résumé bullets already contain it. This check used to reject one fixed
// three-word phrase lifted from a single candidate's source, which no other
// résumé shares and which a decision about what a letter may say cannot rest
// on. A single bullet's wording is deliberately not read here: the repo's own
// accepted letters restate one bullet's facts in runs up to the verbatim floor,
// and every rule tried on a single bullet below that floor rejected letters the
// pipeline accepts.
const MIN_REFRAIN_WORDS = 3;
const MAX_REFRAIN_OBSERVATIONS = 4;

// The cover-letter contract prints this value as the object of “the list read
// is …” after the run length checkRedundancy rejects, so a threshold stated
// alone is not read as a promise that anything shorter is safe. It is short on
// purpose: the correction brief is capped (MAX_CORRECTION_BRIEF_CHARS) and
// drops whole rules from its end, so a longer value here costs a rule.
export const COVER_LETTER_SALIENT_ECHO_PHRASES = 'wording two of your résumé bullets share';

/**
 * Runs of MIN_REFRAIN_WORDS to REDUNDANCY_SHINGLE_WORDS - 1 words, bounded by
 * content words with a function word inside (a phrase, not a compound noun or
 * a list of names), that at least two distinct bullets contain. A longer
 * refrain absorbs the shorter runs inside it.
 */
function resumeRefrains(bullets) {
  const found = new Map();
  bullets.forEach((bulletWords, bulletIndex) => {
    for (let length = MIN_REFRAIN_WORDS; length < REDUNDANCY_SHINGLE_WORDS; length++) {
      for (let start = 0; start + length <= bulletWords.length; start++) {
        const run = bulletWords.slice(start, start + length);
        if (FRAME_FUNCTION_WORDS.has(run[0]) || FRAME_FUNCTION_WORDS.has(run[run.length - 1])) continue;
        if (!run.slice(1, -1).some(word => FRAME_FUNCTION_WORDS.has(word))) continue;
        if (runContentWordCount(run) < MIN_REPEAT_CONTENT_WORDS) continue;
        const key = run.join(' ');
        const entry = found.get(key) || { run, bullets: new Set() };
        entry.bullets.add(bulletIndex);
        found.set(key, entry);
      }
    }
  });
  const shared = [...found.values()].filter(entry => entry.bullets.size >= 2);
  return shared.filter(entry => !shared.some(other => other !== entry
    && other.run.length > entry.run.length && containsWordSequence(other.run, entry.run)
    && [...entry.bullets].every(index => other.bullets.has(index))));
}

export function checkSalientPhraseEcho(paragraphs = [], evidence = {}, jobText = '') {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const bullets = bulletTexts(evidence).map(genericWords);
  const refrains = bullets.length >= 2 ? resumeRefrains(bullets) : [];
  const postingWords = new Set(genericWords(jobText));
  const nameWords = capitalizedSourceWords([...list.map(text), ...bulletTexts(evidence)]);
  const observations = [];
  list.forEach((paragraph, paragraphIndex) => {
    const paragraphWords = genericWords(paragraph);
    for (const { run, bullets: sharedBy } of refrains) {
      if (!containsWordSequence(paragraphWords, run)) continue;
      // A refrain whose every content word is a name or the posting's own vocabulary
      // is not the résumé's wording to avoid: names recur by design.
      if (run.filter(word => !FRAME_FUNCTION_WORDS.has(word)).every(word => nameWords.has(word) || postingWords.has(word))) continue;
      observations.push(`paragraph ${paragraphIndex + 1} repeats ${quotedRunPhrase(run)}, wording that résumé bullets ${[...sharedBy].map(index => index + 1).join(' and ')} already share; keep the fact but say it in the letter’s own construction`);
    }
  });
  return observationResult('salient-phrase-echo', observations, MAX_REFRAIN_OBSERVATIONS,
    `${list.length} paragraph(s) avoid wording the résumé repeats across bullets`);
}

export function checkGenericPhrases(paragraphs = []) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const observations = [];
  const seen = new Set();
  const observe = (paragraphIndex, kind, phrase) => {
    const key = `${paragraphIndex}:${kind}:${phrase}`;
    if (!seen.has(key)) {
      seen.add(key);
      observations.push(`paragraph ${paragraphIndex + 1} contains ${kind} “${phrase}”`);
    }
  };
  for (let index = 0; index < list.length; index++) {
    const paragraphWords = genericWords(list[index]);
    for (const phrase of BANNED_GENERIC_PHRASES) {
      if (containsWordSequence(paragraphWords, genericWords(phrase))) {
        observe(index, 'banned phrase', phrase);
      }
    }
    const genericText = paragraphWords.join(' ');
    for (const { phrase, pattern } of BANNED_GENERIC_PATTERNS) {
      if (pattern.test(genericText)) {
        observe(index, 'banned generic pattern', phrase);
      }
    }
  }
  const firstSentenceWords = genericWords(normalized(list[0]).split(/[.!?]/, 1)[0]);
  for (const opener of BANNED_OPENERS) {
    const openerWords = genericWords(opener);
    if (openerWords.every((word, index) => firstSentenceWords[index] === word)) {
      observe(0, 'banned opener', opener);
    }
  }
  if (observations.length) {
    const visible = observations.slice(0, MAX_GENERIC_OBSERVATIONS);
    return result('generic-phrases', false,
      `generic phrasing observations: ${visible.join('; ')}${observations.length > visible.length ? `; ${observations.length - visible.length} additional observation(s) omitted` : ''}`);
  }
  return result('generic-phrases', true, `${list.length} paragraph(s) contain no banned generic phrase or opener`);
}

// A good opening interprets the target work and connects it to the candidate;
// it does not spend its first sentence lightly rewriting one sentence from the
// advertisement. Keep this detector conservative: it ignores function words,
// compares against each posting sentence independently, and fires only when
// nearly all of an opening's substantive terms map to one listing sentence.
const OPENING_RESTATEMENT_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'each', 'for', 'from', 'had', 'has',
  'have', 'i', 'in', 'into', 'is', 'it', 'its', 'more', 'most', 'my', 'of',
  'on', 'or', 'our', 'should', 'that', 'the', 'their', 'these', 'they', 'this',
  'those', 'to', 'was', 'we', 'were', 'which', 'who', 'will', 'with', 'would',
  'you', 'your',
]);
// A compressed job-listing sentence can be persuasive-looking at only four
// content terms.  Requiring seven terms before comparing it left exactly that
// weak form unexamined.  The comparison therefore starts at four terms, but
// demands that nearly all of them map to one substantive listing sentence.
const MIN_OPENING_RESTATEMENT_TERMS = 4;
const MIN_OPENING_RESTATEMENT_SHARED_TERMS = 4;
const MIN_OPENING_RESTATEMENT_OPENING_SHARE = 0.75;
const MIN_OPENING_RESTATEMENT_POSTING_SHARE = 0.15;
const MIN_OPENING_RESTATEMENT_FUZZY_TERM_CHARS = 5;
const MIN_OPENING_RESTATEMENT_FUZZY_TERM_SIMILARITY = 0.6;

// Inflection changes such as "validate" / "validates" must not make a
// sentence copied from a posting look original.  Do not hand-maintain suffix
// rewrites: they are English-specific, brittle, and made a direct paraphrase
// invisible.  Character trigrams provide a narrow spelling-similarity bridge
// only for longer content words; short/acronym terms still require an exact
// match, which keeps the comparison conservative.
function termTrigrams(value) {
  const bounded = `^${value}$`;
  const grams = new Set();
  for (let index = 0; index <= bounded.length - 3; index++) grams.add(bounded.slice(index, index + 3));
  return grams;
}

function termSimilarity(left, right) {
  if (left === right) return 1;
  if (left.length < MIN_OPENING_RESTATEMENT_FUZZY_TERM_CHARS
    || right.length < MIN_OPENING_RESTATEMENT_FUZZY_TERM_CHARS) return 0;
  const leftTrigrams = termTrigrams(left);
  const rightTrigrams = termTrigrams(right);
  let shared = 0;
  for (const gram of leftTrigrams) if (rightTrigrams.has(gram)) shared += 1;
  return (2 * shared) / (leftTrigrams.size + rightTrigrams.size);
}

function openingRestatementTerms(value) {
  return [...new Set(genericWords(value)
    .filter(word => !OPENING_RESTATEMENT_STOP_WORDS.has(word))
    .filter(word => word.length >= 3))];
}

function matchedRestatementTerms(openingTerms, postingTerms) {
  // Match one term at most once.  Exact matches win, then the few high-signal
  // spelling-near pairs left by ordinary inflection.  Greedy ordering is safe
  // here because both sides are unique, tiny term sets from a single sentence.
  const candidates = [];
  for (let openingIndex = 0; openingIndex < openingTerms.length; openingIndex++) {
    for (let postingIndex = 0; postingIndex < postingTerms.length; postingIndex++) {
      const similarity = termSimilarity(openingTerms[openingIndex], postingTerms[postingIndex]);
      if (similarity >= MIN_OPENING_RESTATEMENT_FUZZY_TERM_SIMILARITY) {
        candidates.push({ openingIndex, postingIndex, similarity });
      }
    }
  }
  candidates.sort((left, right) => right.similarity - left.similarity);
  const openingMatched = new Set();
  const postingMatched = new Set();
  for (const candidate of candidates) {
    if (openingMatched.has(candidate.openingIndex) || postingMatched.has(candidate.postingIndex)) continue;
    openingMatched.add(candidate.openingIndex);
    postingMatched.add(candidate.postingIndex);
  }
  return openingMatched.size;
}

export function checkOpeningPostingRestatement(paragraphs = [], jobText = '') {
  const opening = sentences(Array.isArray(paragraphs) ? paragraphs[0] : '')[0] || '';
  const openingTerms = openingRestatementTerms(opening);
  if (openingTerms.length < MIN_OPENING_RESTATEMENT_TERMS) {
    return result('opening-posting-restatement', true, 'opening sentence is too short for a reliable posting-restatement comparison');
  }
  let strongest = null;
  for (const postingSentence of sentences(jobText)) {
    const postingTerms = openingRestatementTerms(postingSentence);
    if (postingTerms.length < MIN_OPENING_RESTATEMENT_TERMS) continue;
    const sharedCount = matchedRestatementTerms(openingTerms, postingTerms);
    const candidate = {
      postingSentence,
      sharedCount,
      openingShare: sharedCount / openingTerms.length,
      postingShare: sharedCount / postingTerms.length,
    };
    if (!strongest || candidate.openingShare > strongest.openingShare
      || (candidate.openingShare === strongest.openingShare && candidate.postingShare > strongest.postingShare)) strongest = candidate;
  }
  const restates = strongest
    && strongest.sharedCount >= MIN_OPENING_RESTATEMENT_SHARED_TERMS
    && strongest.openingShare >= MIN_OPENING_RESTATEMENT_OPENING_SHARE
    && strongest.postingShare >= MIN_OPENING_RESTATEMENT_POSTING_SHARE;
  if (!restates) {
    return result('opening-posting-restatement', true, 'opening sentence synthesizes the target work rather than closely paraphrasing one posting sentence');
  }
  return result('opening-posting-restatement', false,
    `opening sentence closely restates one posting sentence (${strongest.sharedCount} matched content terms); replace the advertisement paraphrase with a candidate-specific observation and supported capability`);
}

// A sentence can avoid a near-verbatim advertisement paraphrase while still
// making the advertisement, rather than the candidate, do the opening work.
// Keep this to paragraph openings: a source attribution in the middle of a
// sentence can be necessary when a listing-only employer assertion needs its
// provenance stated plainly. The prefix itself is enough — report/reporting
// verbs vary too much to make “Company's posting places …” an escape hatch.
const OPENING_JOB_SUMMARY_SCAFFOLD = /^(?:(?:the|this)\s+(?:(?:job|role|position)\s+)?(?:posting|listing|description)\b|(?:[\p{L}][\p{L}&.'’-]*(?:\s+[\p{L}][\p{L}&.'’-]*){0,5})['’]s\s+(?:posting|listing|job\s+description)\b|(?:this|the)\s+(?:role|position|job)\s+(?:calls?\s+for|requires?|asks?\s+for|seeks?|highlights?))\b/iu;

/** Keeps the opening candidate-first instead of using requirement-reporting scaffolding. */
export function checkOpeningJobSummaryScaffolding(paragraphs = []) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const observations = [];
  list.forEach((paragraph, index) => {
    const opening = sentences(paragraph)[0] || '';
    const match = OPENING_JOB_SUMMARY_SCAFFOLD.exec(text(opening));
    if (match) observations.push(`paragraph ${index + 1} begins with job-summary scaffolding (“${boundedDetailValue(match[0])}”)`);
  });
  return observationResult('opening-job-summary-scaffolding', observations, MAX_GENERIC_OBSERVATIONS,
    `${list.length} paragraph(s) begin with a candidate capability, evidence, or target-work thesis rather than requirement-reporting scaffolding`);
}

// The letter should demonstrate interest through a concrete view of the target
// work and a relevant contribution. These are deliberately narrow
// first-person declarations: ordinary uses of “interest”, and facts attributed
// to a source, remain valid prose.
const DECLARED_FIRST_PERSON_INTEREST = /\b(?:i(?:'m| am)\s+(?:interested\s+in|excited\s+about|enthusiastic\s+about|passionate\s+about|drawn\s+to|motivated\s+by)|my\s+interests?\s+in|[\p{L}][^.!?]{0,160}\binterests?\s+me)\b/iu;

/** Keeps motivation implicit in final cover prose without banning “interest”. */
export function checkInterestFraming(paragraphs = []) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const declarationIndex = list.findIndex(paragraph => DECLARED_FIRST_PERSON_INTEREST.test(text(paragraph)));
  if (declarationIndex !== -1) {
    return result('interest-framing', false,
      `paragraph ${declarationIndex + 1} declares the candidate’s interest or enthusiasm; name the target work and relevant capability directly so the connection shows the reason to care`);
  }
  return result('interest-framing', true, 'motivation is conveyed through target work and candidate contribution rather than an explicit first-person interest declaration');
}

/**
 * Catch the specific malformed construction that otherwise reads plausibly to
 * a loose style check: “My experience to enforce …”. It is limited to the
 * beginning of a sentence and the explicit verb set above, so valid phrases
 * such as “My experience to date …” remain untouched.
 */
export function checkExperienceInfinitiveGrammar(paragraphs = []) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  for (let index = 0; index < list.length; index++) {
    const match = /(?:^|[.!?]\s+)my\s+experience\s+to\s+([\p{L}][\p{L}'-]*)\b/iu.exec(text(list[index]));
    const verb = normalized(match?.[1]);
    const gerund = EXPERIENCE_TO_GERUNDS[verb];
    if (gerund) {
      return result('experience-infinitive-grammar', false,
        `paragraph ${index + 1} starts a sentence “My experience to ${verb}”; use “My experience ${gerund} …” instead`);
    }
  }
  return result('experience-infinitive-grammar', true, 'no sentence starts with “My experience to” followed by a covered verb');
}

// ---------------------------------------------------------------------------
// Letter figures.
//
// A figure is a quantitative claim: a number written in digits or in words,
// with the currency, percent, multiplier, magnitude or duration unit that gives
// it its meaning. Two spellings of the same quantity must compare equal, and
// two different quantities must never collapse into one, so every figure is
// reduced to a key of (sign, currency, value after any magnitude, kind):
//
//   97%  = 97 percent = ninety-seven percent        $2.4M = $2,400,000 = 2.4 million dollars
//   30x  = 30X = 30 times = thirty-fold             3 years = three-year = 3-yr = 3+ years
//   2 million  !=  2 thousand  !=  2                30x  !=  3x  !=  30%
//
// The letter is then held to the keys its own evidence states.
// ---------------------------------------------------------------------------
const SPELLED_SMALL_VALUES = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
});
const SPELLED_TENS_VALUES = Object.freeze({
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
});
const SPELLED_MAGNITUDE_VALUES = Object.freeze({ thousand: 3, million: 6, billion: 9, trillion: 12 });
const FIGURE_DURATION_UNITS = Object.freeze({
  year: 'year', years: 'year', yr: 'year', yrs: 'year',
  month: 'month', months: 'month', mo: 'month', mos: 'month',
  week: 'week', weeks: 'week', wk: 'week', wks: 'week',
  day: 'day', days: 'day',
  hour: 'hour', hours: 'hour', hr: 'hour', hrs: 'hour',
  minute: 'minute', minutes: 'minute', min: 'minute', mins: 'minute',
});
const FIGURE_DURATION_UNIT_SOURCE = `(?:${Object.keys(FIGURE_DURATION_UNITS).sort((a, b) => b.length - a.length).join('|')})`;
const FIGURE_MAGNITUDE_WORD_SOURCE = `(?:${Object.keys(SPELLED_MAGNITUDE_VALUES).join('|')})`;
const FIGURE_CURRENCY_WORDS = Object.freeze({ dollar: '$', dollars: '$', euro: '€', euros: '€' });
const FIGURE_CURRENCY_WORD_SOURCE = '(?:dollars?|euros?)';
const FIGURE_PERCENT_WORD_SOURCE = '(?:percent|per\\s*cent)';
const FIGURE_NUMBER_SOURCE = '\\d(?:[\\d,]*\\d)?(?:\\.\\d+)?';
// What may follow a digit run and become part of the same figure.
const FIGURE_SUFFIX_SOURCE = '(?:'
  + '\\s?%'
  + `|\\s*-?\\s*${FIGURE_PERCENT_WORD_SOURCE}\\b`
  + `|\\s*${FIGURE_MAGNITUDE_WORD_SOURCE}\\b(?:\\s+${FIGURE_CURRENCY_WORD_SOURCE}\\b)?`
  + '|[kKmMbB]'
  + '|[xX×]'
  + '|\\s*-?\\s*(?:times|fold)\\b'
  + `|\\s+${FIGURE_CURRENCY_WORD_SOURCE}\\b`
  + `|\\s*-?\\s*${FIGURE_DURATION_UNIT_SOURCE}\\b`
  + ')';
// A signed figure stays intact: starting the matcher at the digit after a minus
// sign made `-32%` indistinguishable from `32%`, which can reverse the meaning
// of a résumé-backed metric. The unsigned branch refuses to begin immediately
// after +/- so it cannot evade the signed branch.
const DIGIT_FIGURE_RE = new RegExp(
  '(?<![\\p{L}\\p{N}])'
  + '(?:(?<sign>[+-])(?<signedCurrency>[$€£])?|(?<![+-])(?<currency>[$€£])?)'
  + `(?<number>${FIGURE_NUMBER_SOURCE})`
  + `(?:\\+(?![$€£]?\\d))?(?<suffix>${FIGURE_SUFFIX_SOURCE})?`
  + '(?![\\p{L}\\p{N}])',
  'giu');
// `10-20%`, `3-5 years`, `3 to 5 years` state the same unit on both ends.
const FIGURE_RANGE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(${FIGURE_NUMBER_SOURCE})\\s*(?:-|\\bto\\b)\\s*((?:[$€£])?${FIGURE_NUMBER_SOURCE})(${FIGURE_SUFFIX_SOURCE})(?![\\p{L}\\p{N}])`,
  'giu');
const SPELLED_WORD_SOURCE = `(?:${[...Object.keys(SPELLED_SMALL_VALUES), ...Object.keys(SPELLED_TENS_VALUES), 'hundred', ...Object.keys(SPELLED_MAGNITUDE_VALUES)].join('|')})`;
const SPELLED_SCALE_WORD_SOURCE = `(?:hundred|${FIGURE_MAGNITUDE_WORD_SOURCE})`;
const SPELLED_RUN_RE = new RegExp(
  `(?<![\\p{L}\\p{N}-])(?:a\\s+(?=${SPELLED_SCALE_WORD_SOURCE}\\b))?${SPELLED_WORD_SOURCE}`
  + `(?:(?:(?<=\\b${SPELLED_SCALE_WORD_SOURCE})\\s+and\\s+|[\\s-]+)${SPELLED_WORD_SOURCE})*\\b`,
  'giu');
const SPELLED_SUFFIX_RE = new RegExp(
  `^(?:\\s*-?\\s*(?<percent>${FIGURE_PERCENT_WORD_SOURCE})\\b`
  + '|\\s*-?\\s*(?<times>times|fold)\\b'
  + `|\\s*-?\\s*(?<unit>${FIGURE_DURATION_UNIT_SOURCE})\\b`
  + `|\\s+(?<currency>${FIGURE_CURRENCY_WORD_SOURCE})\\b)`,
  'iu');
const SPELLED_FOLD_RE = new RegExp(`(?<![\\p{L}\\p{N}-])(${['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'twenty', 'thirty', 'forty', 'fifty', 'hundred', 'thousand'].join('|')})fold\\b`, 'giu');

// Decimal arithmetic on strings: `2.4` x 10^6 must be exactly `2400000`.
function canonicalDecimal(numberText) {
  const [integer, fraction = ''] = String(numberText).split('.');
  const whole = integer.replace(/^0+(?=\d)/u, '');
  const tail = fraction.replace(/0+$/u, '');
  return tail ? `${whole}.${tail}` : whole;
}

function shiftDecimal(numberText, places) {
  const [integer, fraction = ''] = canonicalDecimal(numberText).split('.');
  const padded = fraction.padEnd(places, '0');
  return canonicalDecimal(`${integer}${padded.slice(0, places)}${padded.length > places ? `.${padded.slice(places)}` : ''}`);
}

function spelledNumberValue(run) {
  const tokens = run.toLowerCase().replace(/^a\s+/u, 'one ').split(/[\s-]+/u).filter(token => token && token !== 'and');
  let total = 0;
  let current = 0;
  let last = null;
  let lastMagnitude = Infinity;
  for (const token of tokens) {
    if (Object.hasOwn(SPELLED_SMALL_VALUES, token)) {
      const value = SPELLED_SMALL_VALUES[token];
      if (value < 10 && last === 'tens') last = 'small';
      else if (last === null || last === 'hundred' || last === 'magnitude') last = value < 10 ? 'small' : 'teen';
      else return null;
      current += value;
    } else if (Object.hasOwn(SPELLED_TENS_VALUES, token)) {
      if (!(last === null || last === 'hundred' || last === 'magnitude')) return null;
      current += SPELLED_TENS_VALUES[token];
      last = 'tens';
    } else if (token === 'hundred') {
      if (!(last === null || last === 'small')) return null;
      current = (current || 1) * 100;
      last = 'hundred';
    } else if (Object.hasOwn(SPELLED_MAGNITUDE_VALUES, token)) {
      const places = SPELLED_MAGNITUDE_VALUES[token];
      if (last === 'magnitude' || places >= lastMagnitude) return null;
      total += (current || 1) * 10 ** places;
      current = 0;
      lastMagnitude = places;
      last = 'magnitude';
    } else {
      return null;
    }
  }
  return total + current;
}

function figureKey({ sign = '', currency = '', value, kind = '' }) {
  return `${sign}${currency}${value}${kind}`;
}

function digitFigureToken(match) {
  const { sign = '', signedCurrency, currency, number, suffix = '' } = match.groups;
  let value = canonicalDecimal(number.replace(/,/gu, ''));
  let symbol = signedCurrency || currency || '';
  let kind = '';
  const rest = suffix.toLowerCase().replace(/[\s-]+/gu, ' ').trim();
  if (rest) {
    const [first, second] = rest.split(' ');
    if (first === '%' || /^per ?cent|^percent/u.test(rest)) kind = '%';
    else if (Object.hasOwn(SPELLED_MAGNITUDE_VALUES, first)) {
      value = shiftDecimal(value, SPELLED_MAGNITUDE_VALUES[first]);
      if (!symbol && Object.hasOwn(FIGURE_CURRENCY_WORDS, second)) symbol = FIGURE_CURRENCY_WORDS[second];
    } else if (first === 'k') value = shiftDecimal(value, 3);
    else if (first === 'm') value = shiftDecimal(value, 6);
    else if (first === 'b') value = shiftDecimal(value, 9);
    else if (first === 'x' || first === '×' || first === 'times' || first === 'fold') kind = 'x';
    else if (Object.hasOwn(FIGURE_CURRENCY_WORDS, first)) {
      if (!symbol) symbol = FIGURE_CURRENCY_WORDS[first];
    } else if (Object.hasOwn(FIGURE_DURATION_UNITS, first)) kind = ` ${FIGURE_DURATION_UNITS[first]}`;
  }
  return { raw: match[0], key: figureKey({ sign, currency: symbol, value, kind }) };
}

function spelledFigureTokens(figureText) {
  const tokens = [];
  for (const match of figureText.matchAll(SPELLED_RUN_RE)) {
    const run = match[0];
    // “2 million” is one digit figure; its magnitude word is not a second one.
    if (/\d[\s-]*$/u.test(figureText.slice(Math.max(0, match.index - 8), match.index))) continue;
    const value = spelledNumberValue(run);
    if (!value) continue;
    const rest = figureText.slice(match.index + run.length, match.index + run.length + 32);
    // “thirty-first” is an ordinal, not thirty of anything.
    if (/^-(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)\b/iu.test(rest)) continue;
    const after = SPELLED_SUFFIX_RE.exec(rest);
    // A quantity written as words is still a quantitative claim when it carries
    // a unit, a percentage, a multiplier or a magnitude, or when it is large
    // enough that no idiom explains it (“forty nurses”). Small numbers without
    // one stay prose: “one of the team” is not a figure.
    if (!after && value <= 20) continue;
    let kind = '';
    let currency = '';
    if (after?.groups.percent) kind = '%';
    else if (after?.groups.times) kind = 'x';
    else if (after?.groups.unit) kind = ` ${FIGURE_DURATION_UNITS[after.groups.unit.toLowerCase()]}`;
    else if (after?.groups.currency) currency = FIGURE_CURRENCY_WORDS[after.groups.currency.toLowerCase()];
    tokens.push({ raw: `${run}${after ? after[0] : ''}`, key: figureKey({ currency, value: String(value), kind }) });
  }
  for (const match of figureText.matchAll(SPELLED_FOLD_RE)) {
    const word = match[1].toLowerCase();
    const value = Object.hasOwn(SPELLED_SMALL_VALUES, word) ? SPELLED_SMALL_VALUES[word]
      : Object.hasOwn(SPELLED_TENS_VALUES, word) ? SPELLED_TENS_VALUES[word]
        : word === 'hundred' ? 100 : 1000;
    tokens.push({ raw: match[0], key: figureKey({ value: String(value), kind: 'x' }) });
  }
  return tokens;
}

function figureTokens(value) {
  // Before matching, turn a dash *between two digits* into a separator:
  // `2024-2025` and `10–20%` are ranges, not a positive number followed by a
  // negative one. A real unary minus (`-32%`) has no digit immediately before
  // it and remains intact. A range that shares a unit states it on both ends.
  const figureText = text(value)
    .replace(FIGURE_RANGE_RE, (_match, left, right, suffix) => `${left}${suffix} ${right}${suffix}`)
    .replace(/(\d)\s*-\s*(?=(?:[$€£])?\d)/gu, '$1 ');
  return [...figureText.matchAll(DIGIT_FIGURE_RE)].map(digitFigureToken).concat(spelledFigureTokens(figureText));
}

function boundedQuotedList(values) {
  const visible = values.slice(0, MAX_FIGURE_DETAIL_ITEMS);
  return `[${visible.map(value => `“${boundedDetailValue(value)}”`).join(', ')}${values.length > visible.length ? ', …' : ''}]`;
}

function capitalizedBigrams(value) {
  // JavaScript's `\b` is ASCII-word based, so it fails for names such as
  // “Équipe Atlas”. Use Unicode letter/number boundaries instead.
  return [...text(value).matchAll(/(?=(?<![\p{L}\p{N}])(\p{Lu}[\p{L}'-]*\s+\p{Lu}[\p{L}'-]*)(?![\p{L}\p{N}]))/gu)]
    .map(match => match[1]);
}

/**
 * `companyName` is optional for unit use, but callers with a job should pass it
 * so a company name alone cannot satisfy the research-detail requirement.
 */
export function checkCompanySpecificity(paragraphs = [], researchText = '', companyName = '', plannedDetail = '') {
  const research = text(researchText);
  if (!research) return result('company-specificity', true, 'skipped: research unavailable');
  const letter = text((Array.isArray(paragraphs) ? paragraphs : []).join(' '));
  const normalizedResearch = normalized(research);
  const normalizedCompany = normalized(companyName);
  const plannedBigrams = capitalizedBigrams(plannedDetail).filter(bigram =>
    normalizedResearch.includes(normalized(bigram)) && !normalizedCompany.includes(normalized(bigram)));
  if (text(plannedDetail) && !plannedBigrams.length) {
    return result('company-specificity', false, 'planned company hook has no research-sourced capitalized detail outside the company name');
  }
  const allowedBigrams = plannedBigrams.length ? plannedBigrams : capitalizedBigrams(letter);
  const detailBigram = allowedBigrams.find(bigram =>
    normalizedResearch.includes(normalized(bigram))
      && !normalizedCompany.includes(normalized(bigram))
      && normalized(letter).includes(normalized(bigram)));
  if (detailBigram) return result('company-specificity', true, `uses research-sourced capitalized detail “${boundedDetailValue(detailBigram)}”`);
  return result('company-specificity', false, plannedBigrams.length
    ? `planned research detail “${boundedDetailValue(plannedBigrams[0])}” does not appear in the letter`
    : 'no research-sourced capitalized detail appears in the letter');
}

export function checkShape(planOrParagraphs = {}, paragraphs = []) {
  // Keep the established `(plan, paragraphs)` call shape while also allowing
  // the now-sufficient `(paragraphs)` form. The prose plan no longer dictates
  // a paragraph or word quota; it remains a semantic-planning input only.
  const sourceParagraphs = Array.isArray(planOrParagraphs) ? planOrParagraphs : paragraphs;
  const list = Array.isArray(sourceParagraphs) ? sourceParagraphs.filter(paragraph => text(paragraph)) : [];
  if (!list.length) return result('shape', false, 'letter has no usable body paragraphs');
  const count = list.reduce((total, paragraph) => total + wordCount(paragraph), 0);
  return result('shape', true, `letter has ${list.length} paragraph(s) and ${count} words`);
}

// Everything the fitted résumé states, as one string: bullets, role headers,
// skills and education. Tolerant of a partially persisted or legacy payload.
function resumeEvidenceText(evidence) {
  const roles = Array.isArray(evidence?.roles) ? evidence.roles : [];
  const skills = Array.isArray(evidence?.skills) ? evidence.skills : [];
  const education = Array.isArray(evidence?.education) ? evidence.education : [];
  return [
    ...bulletTexts(evidence),
    ...roles.flatMap(role => [
      role?.title || '', role?.company || '', role?.dates || '', role?.location || '', role?.summary || '',
      ...(Array.isArray(role?.bullets) ? role.bullets : []).map(bullet => bullet?.text || ''),
    ]),
    ...skills.flatMap(skill => [skill?.group || '', ...(Array.isArray(skill?.items) ? skill.items : [])]),
    ...education,
  ].join(' ');
}

/**
 * Every figure in the letter must be a figure the approved evidence states.
 *
 * Two halves, under two ids (CHECK_DISPOSITIONS). A figure the evidence never
 * states is a fabricated metric, a fact about the candidate nobody approved:
 * that is `figure-discipline`, and it is the only half that rejects. How many
 * figures a letter carries is a preference about density, with no fact in it:
 * that is `figure-count`, advisory. The row keeps its legacy shape (one id, and
 * it fails when either half does); `parts` carries the halves.
 *
 * What licenses a figure. With the plan's mappings, the evidence those mappings
 * select; without them, the whole résumé evidence. In both cases also the
 * career-data quotes the letter's paragraphs cite (`citations`: for paragraph i,
 * the quotes it cites), because a paragraph that cites a quote has told the
 * reader and the grounding checks which accomplishment it is about, so a number
 * that quote states is stated by approved evidence. Without that, a true figure
 * from a bullet the argument did not quote was refused although the paragraph
 * cited it. What is still refused is the coincidence this scoping exists for:
 * a figure that sits somewhere else in the résumé and in nothing the letter
 * cites or maps.
 */
export function checkFigureDiscipline(paragraphs = [], evidence = {}, plan = null, { citations = null } = {}) {
  const letterTokens = figureTokens((Array.isArray(paragraphs) ? paragraphs : []).join(' '));
  const letterFigures = letterTokens.map(token => token.raw);
  // These checks must remain diagnostic-only. A partially persisted or legacy
  // evidence payload therefore cannot turn a recoverable letter defect into a
  // thrown application-generation failure.
  const résuméText = resumeEvidenceText(evidence);
  const mappings = Array.isArray(plan?.mappings) ? plan.mappings : [];
  // Planned prose may use figures only from the evidence anchors the planner
  // selected. Treating every number anywhere in the résumé as permission let
  // an unrelated/research-only figure pass by coincidence. The direct fallback
  // has no mappings, so it retains the full fitted-résumé evidence boundary.
  const citedText = (Array.isArray(citations) ? citations : [])
    .flatMap(quotes => (Array.isArray(quotes) ? quotes : []))
    .filter(quote => typeof quote === 'string')
    .join(' ');
  const permittedFigureText = `${mappings.length
    ? mappings.map(mapping => text(mapping?.evidence)).join(' ')
    : résuméText} ${citedText}`;
  const résuméFigures = new Set(figureTokens(permittedFigureText).map(token => token.key));
  const missingFigures = [];
  const seenMissing = new Set();
  for (const { raw, key } of letterTokens) {
    if (!résuméFigures.has(key) && !seenMissing.has(key)) {
      seenMissing.add(key);
      missingFigures.push(raw);
    }
  }
  const countObservation = letterFigures.length > MAX_LETTER_FIGURES
    ? `letter contains ${letterFigures.length} figures ${boundedQuotedList(letterFigures)}; maximum is ${MAX_LETTER_FIGURES}`
    : '';
  const absentParagraphs = (Array.isArray(paragraphs) ? paragraphs : []).flatMap((paragraph, index) => {
    const absent = figureTokens(paragraph).filter(token => !résuméFigures.has(token.key)).map(token => token.raw);
    return absent.length ? [`paragraph ${index + 1}: ${boundedQuotedList(absent)}`] : [];
  });
  const absentObservation = missingFigures.length
    ? `figures absent from résumé evidence: ${boundedQuotedList(missingFigures)}${absentParagraphs.length ? `; absent in ${absentParagraphs.join('; ')}` : ''}`
    : '';
  const observations = [countObservation, absentObservation].filter(Boolean);
  const row = observations.length
    ? result('figure-discipline', false, observations.join('; '))
    : result('figure-discipline', true, `${letterFigures.length} figure(s) appear in résumé evidence`);
  return withParts(row, [
    { id: 'figure-discipline', passed: !absentObservation, detail: absentObservation || `${letterFigures.length} figure(s) appear in approved evidence`, observationCount: missingFigures.length },
    { id: 'figure-count', passed: !countObservation, detail: countObservation || `${letterFigures.length} figure(s), within the ${MAX_LETTER_FIGURES} the letter is advised to carry`, observationCount: 1 },
  ]);
}

/**
 * Some postings contain an application instruction that is neither a role
 * capability nor cover-letter argument material.  A request for a portfolio,
 * repository, shipped-work link, or demo must remain visible when the résumé
 * has no clickable http(s) link; silently omitting it can invalidate an
 * otherwise polished application.
 */
export function checkRequestedWorkSampleLink(jobText = '', resumeMainHtml = '') {
  const posting = normalized(jobText);
  const requestsLink = /\b(?:include|provide|submit|share|send|attach)\b[^.!?\n]{0,100}\b(?:link|url)\b[^.!?\n]{0,100}\b(?:built|build|shipped|portfolio|repo(?:sitory)?|github|demo|work sample|project)\b/u.test(posting)
    || /\b(?:portfolio|repo(?:sitory)?|github|demo|work sample|project)\b[^.!?\n]{0,100}\b(?:link|url)\b/u.test(posting);
  if (!requestsLink) return result('work-sample-link', true, 'posting does not request a portfolio, repository, demo, or shipped-work link');

  const markup = String(resumeMainHtml || '');
  const hasHttpLink = /<a\b[^>]*\bhref\s*=\s*(?:"https?:\/\/[^"\s]+"|'https?:\/\/[^'\s]+'|https?:\/\/[^\s>]+)/iu.test(markup);
  return hasHttpLink
    ? result('work-sample-link', true, 'posting-requested work-sample link is present in the résumé')
    : result('work-sample-link', false, 'posting requests a portfolio, repository, demo, or shipped-work link, but the résumé has no clickable http(s) link');
}

/** Legacy compatibility entry point; sourced logistics are no longer letter material. */
export function checkLogisticsContainment(plan = {}, paragraphs = []) {
  return checkLogisticsExclusion(plan, paragraphs);
}

// A cover letter argues fit; it is not an application-form substitute. Keep
// this deliberately promise-shaped so a factual discussion of a system's
// geographic data or availability does not become a false positive.
const COVER_LETTER_LOGISTICS_PROMISES = Object.freeze([
  { label: 'availability', pattern: /\b(?:I(?:\s+am|['’]m)\s+available|my\s+availability|available\s+(?:to|for)\s+(?:start|work|relocat(?:e|ing)|travel|shifts?|full[- ]time|part[- ]time|immediately|on))/iu },
  { label: 'start date', pattern: /\b(?:I\s+(?:can|will|would|am\s+(?:able|ready|prepared)\s+to)\s+start\b|my\s+(?:available\s+)?start\s+date\b)/iu },
  { label: 'work location', pattern: /\b(?:I(?:\s+am|['’]m)\s+(?:based|located|living|residing)\s+in|I\s+live\s+in|my\s+current\s+(?:location|base)\s+is|(?:based|located)\s+in\s+[^,.!?]{1,80},\s+I\b)/iu },
  { label: 'work-location willingness', pattern: /\bI(?:\s+am|['’]m)\s+(?:(?:willing|able|prepared|ready)\s+to\s+work(?:ing)?|open\s+to\s+(?:work(?:ing)?\s+|an?\s+)?)\s*(?:anywhere|on[- ]site|hybrid|remotely?|remote|in[- ]office)\b|\bI\s+(?:can|will|would|currently)\s+work\s+(?:anywhere|on[- ]site|hybrid|remotely?|in[- ]office)\b/iu },
  { label: 'relocation', pattern: /\b(?:I(?:\s+am|['’]m)\s+)?(?:willing|able|prepared|ready|open)\s+to\s+(?:relocat(?:e|ing)|relocation)\b|\bI\s+(?:can|will|would)\s+relocat(?:e|ing)\b/iu },
  { label: 'commute', pattern: /\bI\s+(?:(?:can|will|would)\s+|am\s+willing\s+to\s+)?commut(?:e|ing)\b/iu },
  { label: 'commute distance', pattern: /\b(?:I\s+live|I(?:\s+am|['’]m)\s+(?:located|based))\b[^.!?]{0,70}\b(?:\d+|one|two|three|four|five|ten|fifteen|twenty|thirty|forty|fifty|sixty)[- ]?(?:minute|hour|mile|kilomet(?:er|re))s?\b[^.!?]{0,40}\b(?:from|away)\b/iu },
  { label: 'travel willingness', pattern: /\bI\s+(?:(?:can|will|would)\s+|am\s+(?:willing|able|prepared|ready|open)\s+to\s+)?travel\b|\bI\s+(?:can|will|would)\s+work\b[^.!?]{0,90}\b(?:and\s+)?travel\b/iu },
  { label: 'schedule availability', pattern: /\bI\s+(?:can|will|would|am\s+able\s+to)\s+(?:start|work)\b[^.!?]{0,70}\b(?:weekends?|evenings?|overnights?|shifts?|on[- ]call|full[- ]time|part[- ]time)\b/iu },
]);

// The cover-letter contract discloses what this check reads, so the class
// names are derived from the table itself rather than transcribed beside it: a
// promise class added above reaches the prompt without a second edit here, and
// a contract that names a class this table does not carry cannot survive.
export const COVER_LETTER_LOGISTICS_PROMISE_CLASSES =
  COVER_LETTER_LOGISTICS_PROMISES.map(promise => promise.label).join(', ');

/**
 * Excludes application logistics from both the argument plan and rendered
 * prose: the availability, location, relocation, commute, travel and schedule
 * promises an application form collects on its own.
 */
export function checkLogisticsExclusion(plan = {}, paragraphs = []) {
  const planLogistics = text(plan?.logistics);
  if (planLogistics) {
    return result('logistics-exclusion', false,
      'argument plan contains logistics; availability, location, relocation, commute, travel, and schedule details belong in application fields, not the cover letter');
  }
  const observations = [];
  for (let index = 0; index < (Array.isArray(paragraphs) ? paragraphs : []).length; index++) {
    const paragraph = text(paragraphs[index]);
    for (const promise of COVER_LETTER_LOGISTICS_PROMISES) {
      const match = promise.pattern.exec(paragraph);
      if (match) observations.push(`paragraph ${index + 1} makes a ${promise.label} promise (“${boundedDetailValue(match[0])}”); move it to the application fields`);
    }
  }
  return observationResult('logistics-exclusion', observations, MAX_LOGISTICS_CONTAINMENT_OBSERVATIONS,
    `${Array.isArray(paragraphs) ? paragraphs.length : 0} paragraph(s) omit application logistics`);
}

// ---------------------------------------------------------------------------
// Letter register and style checks.
//
// The writer prompt already states these rules in prose, but a prompt-level
// ban is instance-level: banning a colon used to unload tools taught the model
// to unload after a semicolon instead. The rules below are therefore
// deterministic and punctuation-agnostic where the defect is, and closed
// lists where the defect is lexical. Every one of them is narrow by design —
// when a construction is defensible in ordinary register the rule is dropped
// rather than widened, because a false positive costs a real revision cycle.
// All of them read body paragraphs only; the envelope (contact block, date,
// salutation) is never prose and must not be scored as prose.
// ---------------------------------------------------------------------------

/**
 * Shared observation tail for the checks below: identical cap-and-join
 * behaviour to checkGenericPhrases/checkLogisticsContainment so a defect list
 * can never flood the revision prompt or the audit line.
 */
function observationResult(id, observations, cap, passedDetail) {
  if (!observations.length) return result(id, true, passedDetail);
  const visible = observations.slice(0, cap);
  const omitted = observations.length - visible.length;
  // The count is kept beside the row, not in it: the row's three fields are the
  // contract every consumer and test reads, and an advisory record
  // (partitionCheckResults) needs how many observations there were, not what
  // they said. It counts the omitted ones too.
  return withObservationCount(result(id, false,
    `${visible.join('; ')}${omitted ? `; ${omitted} additional observation(s) omitted` : ''}`), observations.length);
}

/** Opening words of a sentence, bounded like every other quoted detail value. */
function leadingWordsSnippet(value, limit = OBSERVATION_SNIPPET_WORDS) {
  const parts = text(value).split(' ').filter(Boolean);
  const visible = boundedDetailValue(parts.slice(0, limit).join(' '));
  return `${visible}${parts.length > limit && !visible.endsWith(' …') ? ' …' : ''}`;
}

// Asymmetric on purpose: only a MISSING hyphen is flagged. Over-hyphenation
// (“worked end-to-end with the team”) is defensible style, and an inverse rule
// would need part-of-speech tagging to separate an attributive modifier from
// an adverbial. Each pattern that is only wrong attributively carries its own
// following-noun list so the bare adverbial/noun uses stay legal. `<noun>` and
// `<prefix>` in a suggestion are filled from the match, so the revision prompt
// receives the concrete corrected phrase rather than a template.
export const COMPOUND_HYPHENATION_RULES = Object.freeze([
  // Merriam-Webster hyphenates “in-house” in every position, so this rule
  // needs no following-noun guard.
  { label: 'in-house', pattern: /\bin house\b/iu, suggestion: 'in-house' },
  // Attributive only: “laid the cards end to end” is an adverbial and legal.
  { label: 'end-to-end <noun>', suggestion: 'end-to-end <noun>', pattern: /\bend to end\s+(?:ownership|delivery|development|design|testing|solutions?|systems?|processes?|process|responsibility|pipelines?|experience)\b/iu },
  // The noun phrase “the full stack” stays legal; only the modifier is flagged.
  { label: 'full-stack <noun>', suggestion: 'full-stack <noun>', pattern: /\bfull stack\s+(?:engineers?|engineering|developers?|development|applications?|web|work|experience|roles?|positions?|teams?)\b/iu },
  // Conjugated verbs (“guests checked in luggage”, “checking out a book”)
  // never produce the bare “check in”/“check out” form required here.
  // The suggestion carries only the direction(s) the letter actually wrote:
  // the revision prompt applies a hyphenation suggestion verbatim, so offering
  // the paired form to a paragraph that named one direction would hand the
  // reviser a responsibility the résumé never evidenced — which the grounding
  // audit would then report as an unsupported claim on the next iteration.
  {
    label: 'check-in / check-out <noun>',
    suggestion: '<compound> <noun>',
    pattern: /\bcheck (?:in|out)(?:\s+and\s+check (?:in|out))?\s+(?:system|systems|process|processes|desk|station|kiosk|flow|workflow|tracking)\b/iu,
    compound: value => value
      .replace(/\b(check)\s+(in|out)\b/giu, (_, head, direction) => `${head}-${direction.toLowerCase()}`)
      .replace(/\s+and\s+/giu, ' / '),
  },
  { label: '<prefix>-wide', suggestion: '<prefix>-wide', pattern: /\b(?:district|company|organization|organisation|enterprise) wide\b/iu },
  { label: 'third-party <noun>', suggestion: 'third-party <noun>', pattern: /\bthird party\s+(?:integrations?|products?|solutions?|tools?|services?|APIs?|vendors?|systems?|software)\b/iu },
  { label: 'real-time <noun>', suggestion: 'real-time <noun>', pattern: /\breal time\s+(?:streaming|data|updates?|aggregations?|systems?|monitoring|dashboards?)\b/iu },
  { label: 'open-source <noun>', suggestion: 'open-source <noun>', pattern: /\bopen source\s+(?:projects?|software|tools?|libraries|library|contributions?)\b/iu },
]);

// Every covered pattern places the compound head first and, when it requires
// one, the governed noun last, so most rules need no per-rule code at all. A
// rule whose corrected form depends on the alternative that matched supplies
// its own `compound` transform for the words between head and noun.
function hyphenationSuggestion(rule, matched) {
  const parts = text(matched).split(' ').filter(Boolean);
  const modifier = parts.slice(0, -1).join(' ');
  return rule.suggestion
    .replace('<prefix>', parts[0] || '')
    // A rule whose corrected form depends on which alternative matched fills
    // <compound> from the words the letter actually wrote.
    .replace('<compound>', rule.compound ? rule.compound(modifier) : modifier)
    .replace('<noun>', parts[parts.length - 1] || '');
}

/**
 * One spelling of a compound throughout: a letter that wrote both “kept in
 * house” and “shared in-house core” reads as two authors. The rule list is
 * closed on purpose — it names the compounds this pipeline actually produces
 * instead of attempting general English orthography.
 *
 * Deliberately absent from the cover-letter contract, unlike the other checks
 * this stage runs: each observation already prints the corrected spelling, so
 * the repair needs no foresight, and the only disclosure short enough to be
 * worth its bytes (“hyphenate compound modifiers”) would describe general
 * orthography rather than the eight patterns actually read.
 */
export function checkCompoundHyphenation(paragraphs = []) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const observations = [];
  for (let index = 0; index < list.length; index++) {
    const paragraph = text(list[index]);
    for (const rule of COMPOUND_HYPHENATION_RULES) {
      // One report per paragraph and rule: the patterns are not global, so a
      // repeated compound produces guidance once rather than per occurrence.
      const match = rule.pattern.exec(paragraph);
      if (!match) continue;
      observations.push(`paragraph ${index + 1} writes “${boundedDetailValue(match[0])}”; write “${hyphenationSuggestion(rule, match[0])}” (hyphenate the compound modifier)`);
    }
  }
  return observationResult('compound-hyphenation', observations, MAX_HYPHENATION_OBSERVATIONS,
    `${list.length} paragraph(s) hyphenate the covered compound modifiers`);
}

const MAX_ENTAILED_PREMISE_OBSERVATIONS = 4;

// “Before <thing> was <acquired>, <subject> had to <select> <it>”: the
// subordinate clause supplies the acquisition and the main clause claims only
// the selection that acquisition already implies. Two small event classes carry
// the entailment, both generic English with nothing from any one document: a
// completed acquisition or adoption (the setup), and a selection verb
// (the obligation). The pronoun object is required and is what binds the
// obligation back to the thing the setup acquired, so a different, informative
// claim that names its own object (“before <thing> was <acquired>, I had to
// evaluate the market”) does not match.
const ACQUISITION_EVENT = '(?:adopted|adoption|purchased|bought|procured|licensed|deployed|implemented|rolled out|brought in|onboarded|installed|selected|chosen|approved|introduced)';
const SELECTION_OBLIGATION = '(?:choose|select|pick|approve|decide\\s+on)';
const ENTAILED_ACQUISITION_PREMISE = new RegExp(
  String.raw`\b(?:before|prior to)\b[^,.;:!?]{0,90}?\b${ACQUISITION_EVENT}\b[^,.;:!?]{0,40},\s*[^,.;:!?]{0,60}?\b(?:had|needed)\s+to\s+${SELECTION_OBLIGATION}\s+(?:them|it|those|these|one)\b`, 'iu');

// An endpoint that names a date, a month, a weekday, or any number belongs to
// an enumerable series, which is the one span where `through` is the precise
// preposition rather than a second reading waiting to happen.
const ENUMERABLE_SPAN_ENDPOINT = /\d|\b(?:january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/iu;

/**
 * A process range promises grammatically parallel endpoints. This deliberately
 * checks the high-confidence generated-prose failures only: a noun-like left
 * endpoint followed by a gerund right endpoint, a contentless stewardship verb
 * that spans the range instead of naming the work, and `through` standing in
 * for the terminus preposition `to`. Wider coordination needs a prose audit;
 * these narrow forms are safe enough to reject before publication.
 */
export function checkParallelStructure(passages = []) {
  const list = Array.isArray(passages) ? passages : [];
  const observations = [];
  const processRange = /\bfrom\s+([^,.;:!?]{1,80}?)\s+(to|through)\s+([\p{L}][\p{L}'’-]*ing)\b/giu;
  // A stewardship verb plus a quantified or pronoun object lets the endpoints
  // stand in for the work itself: “running each from X through Y” and “carrying
  // each one from X to Y” are one defect with two verbs, and anchoring the
  // pattern on `ran` alone let the second wording ship. The verb list is closed
  // and the object is required. Verbs that name a real transfer (moved,
  // migrated, ported) stay out on purpose: “moved each record from the intake
  // system to the warehouse” states an action between two real endpoints.
  const stewardedRange = new RegExp(String.raw`\b(?:ran|run|runs|running|carried|carry|carries|carrying|took|take|takes|taking|owned|own|owns|owning|drove|drive|drives|driving|guided|guide|guides|guiding|handled|handle|handles|handling|managed|manage|manages|managing|shepherded|shepherd|shepherds|shepherding|ushered|usher|ushers|ushering|walked|walk|walks|walking|steered|steer|steers|steering)\b\s+(?:(?:each|every|all)(?:\s+[\p{L}'’-]+){0,2}|it|them|one)\s+from\s+([^,.;:!?]{1,60}?)\s+(?:to|through)\s+([^,.;:!?]{1,60})`, 'giu');
  // `through` is the inclusive-range preposition of an enumerable series
  // (“2019 through 2023”, “Monday through Friday”), where no other reading is
  // available. Between prose endpoints it keeps a live path reading, because an
  // item can literally pass through a review stage, so a span between abstract
  // endpoints reads unambiguously only with `to`.
  const spanTerminus = /\bfrom\s+([^,.;:!?]{1,60}?)\s+through\s+([^,.;:!?]{1,60}?)(?=\s*(?:[,.;:!?]|$))/giu;
  for (let index = 0; index < list.length; index++) {
    const passage = text(list[index]);
    const opaque = stewardedRange.exec(passage);
    if (opaque) {
      observations.push(`passage ${index + 1} uses “${boundedDetailValue(opaque[0])}”; name the process steps with explicit action verbs instead of “run each from X through Y”`);
      stewardedRange.lastIndex = 0;
    }
    let span;
    while ((span = spanTerminus.exec(passage))) {
      if (ENUMERABLE_SPAN_ENDPOINT.test(span[1]) || ENUMERABLE_SPAN_ENDPOINT.test(span[2])) continue;
      observations.push(`passage ${index + 1} spans “${boundedDetailValue(span[0])}”; end a span with “to” (“from X to Y”) and keep “through” for inclusive numeric or calendar ranges`);
      if (observations.length >= MAX_PARALLEL_STRUCTURE_OBSERVATIONS) break;
    }
    let match;
    while ((match = processRange.exec(passage))) {
      const leftWords = words(match[1]);
      if (leftWords[0]?.endsWith('ing')) continue;
      observations.push(`passage ${index + 1} uses “${boundedDetailValue(match[0])}”; coordinate parallel nouns or parallel actions`);
      if (observations.length >= MAX_PARALLEL_STRUCTURE_OBSERVATIONS) break;
    }
    if (observations.length >= MAX_PARALLEL_STRUCTURE_OBSERVATIONS) break;
  }
  return observationResult('parallel-structure', observations, MAX_PARALLEL_STRUCTURE_OBSERVATIONS,
    `${list.length} passage(s) keep process-range endpoints grammatically parallel`);
}

/**
 * A setup clause that only restates what its own subordinate clause already
 * entails spends a line to reach the next claim: when a thing was adopted, the
 * obligation to have chosen it tells a reader nothing. The pattern stays
 * closed to that entailment: a completed acquisition event followed by an
 * obligation to select the same thing, referred to by a pronoun, because the
 * general form (a premise the page already supports) needs a reading of the
 * argument, not a match. That general form is stated in the letter prompt
 * instead.
 */
export function checkEntailedPremise(passages = []) {
  const list = Array.isArray(passages) ? passages : [];
  const observations = [];
  for (let index = 0; index < list.length; index++) {
    const match = ENTAILED_ACQUISITION_PREMISE.exec(text(list[index]));
    if (!match) continue;
    observations.push(`passage ${index + 1} sets up with “${boundedDetailValue(match[0])}”; the acquisition already entails the choice, so open with the claim that adds information and drop the restated precondition`);
    if (observations.length >= MAX_ENTAILED_PREMISE_OBSERVATIONS) break;
  }
  return observationResult('entailed-premise', observations, MAX_ENTAILED_PREMISE_OBSERVATIONS,
    `${list.length} passage(s) open their setup clauses with information the sentence does not already entail`);
}

// A role noun in front of the employer (“<modifiers> role at X”) introduces the
// employer only when the role is the candidate's. Without that anchor the branch
// accepted a third party's role (“her role at X made …”, “a former manager's
// tenure at X ended before I …”, “the open position at X attracted applicants,
// and I …”), which says nothing of the candidate's part. A role is the
// candidate's when the sentence ties it to them in one of four ways, each read
// off the role phrase itself and never off an "I" somewhere else in the sentence:
//   - the phrase carries the candidate's own possessive (“my first job at X”);
//   - the phrase fronts the sentence and the main clause that follows it is the
//     candidate's (“In an earlier … role at X, I …”);
//   - the phrase is the subject of a verb that acts on the candidate (“… with X
//     taught me …”, “… at X gave me …”);
//   - the phrase is followed by a relative clause in the candidate's voice
//     (“a position at X, where I …”).
// A modifier that names another person (a possessive “'s”, her, his, their, its,
// your, whose) vetoes the role outright.
const THIRD_PARTY_ROLE_MODIFIER = /['’]s\b|\b(?:her|hers|his|their|theirs|its|your|whose|who)\b/iu;
const CANDIDATE_ACTED_ON_VERBS = 'taught|gave|let|led|showed|introduced|trained|prepared|brought|put|allowed|helped|exposed|handed|made';
function framedRoleIsCandidates(sentence, framedRoleNoun, preposition, name) {
  const value = text(sentence);
  const role = new RegExp(`\\b((?:[\\p{L}'’-]+\\s+){0,5})${framedRoleNoun}\\s+${preposition}\\s+${name}\\b`, 'giu');
  for (const match of value.matchAll(role)) {
    if (THIRD_PARTY_ROLE_MODIFIER.test(match[1])) continue;
    const after = value.slice(match.index + match[0].length);
    if (/\b(?:my|our)\b/iu.test(match[1])) return true;
    if (new RegExp(`^[^.!?;]{0,70}\\b(?:${CANDIDATE_ACTED_ON_VERBS})\\s+(?:me|us)\\b`, 'iu').test(after)) return true;
    if (/^[^.!?;]{0,25}\bwhere\s+(?:I|we)\b/iu.test(after)) return true;
    // Fronted: nothing but a fronting preposition and the role phrase before the
    // employer, and the clause after the comma is the candidate's.
    const before = value.slice(0, match.index + match[1].length);
    if (/^(?:in|during|through|throughout|while|after|before|from|early|late|over|across|within)\b/iu.test(`${before}x`)
      && !/[.!?,;]/u.test(before) && !THIRD_PARTY_ROLE_MODIFIER.test(before)
      && /^[^.!?,;]{0,40},\s*(?:I|we|my|our)\b/iu.test(after)) return true;
  }
  return false;
}

/**
 * The first cover-letter sentence must orient an unfamiliar prior employer.
 * A bare "At <employer>" opener assumes the reader already knows why that
 * organization belongs in the argument; naming the prior role or relationship
 * supplies that missing context. Later evidence paragraphs may use the shorter
 * form once the letter's argument is established.
 *
 * `employer` is curly-quoted in the observation below for the reason stated
 * on contributionHalfRequirement's 'target' case above: checkObservationFingerprint
 * (localAiApplication.js) strips only curly-quoted spans before hashing, and
 * this check is one of PASTE_CHECK_PROSE_UNITS' fingerprinted battery, so an
 * employer name interpolated bare would destabilize this branch's fingerprint
 * per job and carry job content into a digest whose header promises it never
 * does. checkNamedArtifactIntroduction, checkOpeningArtifactContext,
 * checkOpeningEmployerShorthand, and checkAdjacentEmployerRepetition below
 * carry the identical note rather than repeating this paragraph.
 */
export function checkPriorEmployerOpening(paragraphs = [], employerNames = []) {
  const passages = Array.isArray(paragraphs) ? paragraphs : [];
  const observations = [];
  for (const employer of (Array.isArray(employerNames) ? employerNames : [])
    .map(text).filter(Boolean).sort((left, right) => right.length - left.length)) {
    const employerReference = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(employer)}(?![\\p{L}\\p{N}])`, 'iu');
    // The contract asks only that the candidate's role or relationship appear
    // in the sentence that first names the employer. Requiring `at`/`with` and
    // a fixed left-to-right order rejected sentences that plainly satisfy it —
    // "as a data engineer for X", "At X I served as…", "X hired me as…" — so
    // the preposition class includes `for`, an employer-first branch mirrors
    // each relationship frame, and the employer-as-subject frame is accepted.
    const name = escapeRegExp(employer);
    const preposition = '(?:at|with|for)';
    const roleNoun = '(?:role|work|position|tenure)';
    // A role noun that governs the preposition and the employer directly,
    // behind up to five modifier words: “an earlier <field> role at X”, “a
    // <field> internship with X”. The noun is what asserts a relationship, so
    // it is required and sits immediately before the preposition: a bare
    // “At X, I …” has none, and a modifier that merely precedes the employer
    // (“a <field> setting at X”) is no role. The list differs from `roleNoun`
    // above, which only follows “my”: without that possessive “work at X” names
    // a place the work happened, not the candidate's part in it. The role must
    // also be the CANDIDATE's: see framedRoleIsCandidates.
    const framedRoleNoun = '(?:role|position|job|tenure|internship|engagement)s?';
    const relationship = new RegExp(
      `(?:\\b(?:as|while\\s+working\\s+as)\\s+(?:an?\\s+|the\\s+)?[\\p{L}'’-]+(?:\\s+[\\p{L}'’-]+){0,5}\\s+${preposition}\\s+${name}\\b`
      + `|\\bmy(?:\\s+[\\p{L}'’-]+){0,5}\\s+${roleNoun}\\b[^.!?]{0,70}\\b${preposition}\\s+${name}\\b`
      + `|\\bI\\s+(?:worked|served|was\\s+employed)\\b[^.!?]{0,70}\\b${preposition}\\s+${name}\\b`
      // Employer-first orderings of the same three frames. Each one still has
      // to assert a ROLE: the bare copulas ("…and I am glad it is") and the
      // conjunction "as" ("…as traffic grew") are among the commonest words in
      // English, and admitting them made this branch fire on any first-person
      // aside within 70 characters of the employer's name.
      + `|\\b${preposition}\\s+${name}\\b[^.!?]{0,70}\\bI\\s+(?:worked|served|was\\s+employed`
      + `|(?:was|am)\\s+(?:an?|the)\\s+[\\p{L}'’-]+|held\\s+(?:an?|the)\\s+(?:[\\p{L}'’-]+\\s+){0,3}${roleNoun})\\b`
      + `|\\b${preposition}\\s+${name}\\b[^.!?]{0,70}\\bmy(?:\\s+[\\p{L}'’-]+){0,5}\\s+${roleNoun}\\b`
      + `|\\b${preposition}\\s+${name}\\b[^.!?]{0,70}\\b(?:as|while\\s+working\\s+as)\\s+(?:an?|the)\\s+[\\p{L}'’-]+`
      // Employer as the subject that established the relationship. Only
      // unambiguous employment verbs — "brought me to this field" is not one.
      + `|\\b${name}\\b[^.!?]{0,70}\\b(?:hired|employed|contracted)\\s+me\\b`
      + ')',
      'iu',
    );
    let first = null;
    for (let index = 0; index < passages.length && !first; index++) {
      const sentence = sentences(passages[index]).find(item => employerReference.test(text(item)));
      if (sentence) first = { index, sentence: text(sentence) };
    }
    if (!first || relationship.test(first.sentence) || framedRoleIsCandidates(first.sentence, framedRoleNoun, preposition, name)) continue;
    observations.push(`paragraph ${first.index + 1} first names “${employer}” without the candidate's role or relationship; introduce that context before relying on the employer as evidence`);
  }
  return observationResult('prior-employer-opening', observations, MAX_EXPERIENCE_FRAMING_OBSERVATIONS,
    'each prior employer is introduced with the candidate\'s role or relationship before its evidence');
}

// These checks receive project names from the structured résumé markup, never
// arbitrary capitalization in prose. That makes the check strict for a known
// artifact such as a named personal project without mistaking a target company, city, or
// ordinary capitalized phrase for a candidate project.
const ARTIFACT_DESCRIPTOR = /\b(?:project|product|system|tool|application|app|server|service|platform|overlay|workflow|library|framework|extension|plugin|integration|dashboard|website|utility|prototype)\b/iu;
const ARTIFACT_RELATIONSHIP = /\b(?:I\s+(?:built|created|developed|designed|maintained|led|made|authored)|my\s+|(?:creator|author|builder|developer|designer)\s+of)\b/iu;

// `name` is curly-quoted below — see checkPriorEmployerOpening's comment above
// for why a job-specific value in this fingerprinted battery cannot be
// interpolated bare.
export function checkNamedArtifactIntroduction(paragraphs = [], projectNames = []) {
  const passages = Array.isArray(paragraphs) ? paragraphs : [];
  const observations = [];
  for (const name of (Array.isArray(projectNames) ? projectNames : []).map(text).filter(Boolean)) {
    const namePattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'iu');
    let first = null;
    for (let index = 0; index < passages.length && !first; index++) {
      const sentence = sentences(passages[index]).find(item => namePattern.test(text(item)));
      if (sentence) first = { index, sentence: text(sentence) };
    }
    if (!first) continue;
    const nameIndex = first.sentence.search(namePattern);
    const before = first.sentence.slice(0, Math.max(0, nameIndex));
    const after = first.sentence.slice(nameIndex + name.length);
    const sameSentenceIntroduction = (ARTIFACT_RELATIONSHIP.test(before) || ARTIFACT_RELATIONSHIP.test(after))
      && (ARTIFACT_DESCRIPTOR.test(before) || ARTIFACT_DESCRIPTOR.test(after));
    if (sameSentenceIntroduction) continue;
    observations.push(`paragraph ${first.index + 1} first names “${name}” without identifying it as the candidate's project, product, system, or role context; introduce that context before relying on the name`);
  }
  return observationResult('named-artifact-introduction', observations, MAX_STANDALONE_INTRODUCTION_OBSERVATIONS,
    `${passages.length} paragraph(s) introduce unfamiliar named candidate artifacts before relying on them`);
}

// A project can be introduced correctly and still make an abrupt first
// impression when it is the grammatical subject of the letter's first
// sentence. The reader has not yet been told why this particular proof is the
// argument for this application. Keep this deliberately narrow: it only
// catches a known candidate artifact or employer in the leading grammatical
// frame. A mention of “this role” later in the same sentence does not repair a
// proof-first opener; the direction must come first. Later paragraphs can lead
// with the artifact once the thesis is set. leadingProject/leadingEmployer are
// curly-quoted in the observations below — see checkPriorEmployerOpening's
// comment above.
export function checkOpeningArtifactContext(paragraphs = [], projectNames = [], employerNames = []) {
  const firstSentence = sentences(Array.isArray(paragraphs) ? paragraphs[0] : '')[0] || '';
  if (!firstSentence) return result('opening-artifact-context', true, 'no opening sentence to inspect');
  const opening = text(firstSentence);
  const projects = (Array.isArray(projectNames) ? projectNames : []).map(text).filter(Boolean);
  const employers = (Array.isArray(employerNames) ? employerNames : []).map(text).filter(Boolean);
  const leadingProject = projects.find(name => {
    const escaped = escapeRegExp(name);
    return new RegExp(
      `^(?:${escaped}(?:\\b|[,:])|(?:in|with|through|from|on)\\s+(?:my\\s+(?:personal\\s+)?(?:project|work|app|application|system)\\s+)?${escaped}(?:\\b|[,:])|my\\s+(?:personal\\s+)?(?:project|work|app|application|system)\\s*,?\\s+${escaped}(?:\\b|[,:]))`,
      'iu',
    ).test(opening);
  });
  if (leadingProject) {
    return result('opening-artifact-context', false, `opening leads with the candidate's project “${leadingProject}” before establishing its relevance to the target role; lead with the job-specific thesis, then introduce the project as proof`);
  }
  const leadingEmployer = employers.find(name => {
    const escaped = escapeRegExp(name);
    return new RegExp(
      `^(?:${escaped}(?:\\b|[,:])|(?:at|with|for)\\s+${escaped}(?:\\b|[,:])|as\\s+[^.!?]{0,90}\\b(?:at|with|for)\\s+${escaped}(?:\\b|[,:])|(?:in|during)\\s+my\\b[^.!?]{0,70}\\b(?:at|with|for)\\s+${escaped}(?:\\b|[,:]))`,
      'iu',
    ).test(opening);
  });
  return leadingEmployer
    ? result('opening-artifact-context', false, `opening leads with prior-employer evidence from “${leadingEmployer}” before establishing its relevance to the target role; lead with the job-specific thesis, then introduce the experience as proof`)
    : result('opening-artifact-context', true, 'opening establishes its direction before any known project or prior-employer proof');
}

// Bare industry labels can imply operational or domain tenure the evidence
// does not establish ("My aviation work" can sound like work on aircraft).
// Keep the lexicon closed and require a concrete system/task instead.
const BROAD_DOMAIN_WORK_LABEL = /^(?:My|This|That)\s+(?:aviation|aerospace|automotive|banking|defen[cs]e|education|energy|finance|fintech|government|healthcare|insurance|logistics|manufacturing|medical|public[- ]sector|retail|telecom)\s+work\b/iu;

export function checkVagueDomainWorkLabel(paragraphs = []) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const observations = [];
  list.forEach((paragraph, index) => {
    const firstSentence = sentences(paragraph)[0] || '';
    const match = BROAD_DOMAIN_WORK_LABEL.exec(firstSentence);
    if (!match) return;
    observations.push(`paragraph ${index + 1} opens with “${boundedDetailValue(match[0])}”; name the supported software, system, or responsibility instead of the industry alone`);
  });
  return observationResult('vague-domain-work-label', observations, MAX_EXPERIENCE_FRAMING_OBSERVATIONS,
    `${list.length} paragraph(s) describe cross-domain evidence through concrete work`);
}

// A plural third-person pronoun needs something plural, or collective, or
// distributive, before it to stand for. Prose about data moving between
// parties is where this goes wrong most visibly: a possessive “their” in front
// of a data or interface noun, with no party named for it to belong to, leaves
// the reader unable to say whose data or whose interface it is. The detector
// is structural: it reads the passage's own words for an antecedent and
// consults no list of data-flow nouns or verbs.
const PLURAL_THIRD_PERSON_PRONOUN = /(?<![\p{L}\p{N}'’-])(they|them|their|theirs)(?![\p{L}\p{N}'’-])/giu;
// Plural nouns the -s test cannot see, collective nouns that take “they”, and
// the distributive words that license a singular “they” (“each user … their”).
const IRREGULAR_OR_COLLECTIVE_ANTECEDENTS = new Set([
  'people', 'staff', 'personnel', 'faculty', 'children', 'men', 'women', 'team', 'group', 'committee', 'board',
  'crew', 'class', 'each', 'every', 'everyone', 'everybody', 'anyone', 'anybody', 'someone', 'somebody',
  'whoever', 'both', 'others', 'several', 'many', 'various',
]);
// Words that end in -s without being plural nouns and are not function words.
const NON_PLURAL_S_WORDS = new Set([
  'always', 'perhaps', 'previous', 'series', 'news', 'sometimes', 'towards', 'besides', 'thus', 'plus', 'serious',
]);

function pluralAntecedentCandidate(word) {
  if (IRREGULAR_OR_COLLECTIVE_ANTECEDENTS.has(word)) return true;
  if (word.length < 4 || FRAME_FUNCTION_WORDS.has(word) || NON_PLURAL_S_WORDS.has(word)) return false;
  return /[^s]s$/u.test(word) && !/(?:us|is)$/u.test(word);
}

/**
 * A capitalized word that does not open its sentence is a name, and a named
 * party is something “they” and “their” can stand for (“Acme … their API”).
 * The first word of a sentence is capitalized by position, so it never counts,
 * and neither does the pronoun “I”.
 */
function namedPartyBefore(sentenceTexts) {
  return sentenceTexts.some(sentence => (text(sentence).match(WORD_TOKEN_RE) || [])
    .some((token, index) => index > 0 && token.length > 1 && /^\p{Lu}/u.test(token)));
}

/** Require explicit actors in prose instead of a plural pronoun with nothing to stand for. */
export function checkReferenceClarity(passages = []) {
  const list = Array.isArray(passages) ? passages : [];
  const observations = [];
  list.forEach((passage, index) => {
    const passageSentences = sentences(passage);
    for (let position = 0; position < passageSentences.length; position++) {
      const sentence = text(passageSentences[position]);
      const previous = position > 0 ? words(passageSentences[position - 1]) : [];
      for (const match of sentence.matchAll(PLURAL_THIRD_PERSON_PRONOUN)) {
        const lead = sentence.slice(0, match.index);
        const before = [...previous, ...words(lead)];
        if (before.some(pluralAntecedentCandidate)) continue;
        if (namedPartyBefore([...(position > 0 ? [passageSentences[position - 1]] : []), lead])) continue;
        // “<A>, <B>, and their <noun>”: the pronoun closes a coordination, and
        // the conjuncts before it are its antecedent even when each is singular.
        if (/\b(?:and|or)\s*$/iu.test(lead.replace(/,\s*$/u, ''))) continue;
        const following = words(sentence.slice(match.index + match[0].length)).slice(0, 2);
        observations.push(`passage ${index + 1} uses “${boundedDetailValue([match[0], ...following].join(' '))}” with no plural, collective, or distributive noun before it for the pronoun to stand for; name the data owner, producer, consumer, vendor, or agency explicitly`);
        break;
      }
    }
  });
  return observationResult('reference-clarity', observations, MAX_REFERENCE_CLARITY_OBSERVATIONS,
    `${list.length} passage(s) give each plural pronoun an antecedent`);
}

/** Keep a temporal modifier beside the action it actually modifies. */
export function checkModifierAttachment(passages = []) {
  const list = Array.isArray(passages) ? passages : [];
  const observations = [];
  list.forEach((passage, index) => {
    const source = text(passage);
    const match = /\bapplying (?:it|them|this|that)\b[^.]{0,100}\bafter\s+[\p{L}][\p{L}'’-]*ing\b/iu.exec(source);
    if (!match) return;
    observations.push(`passage ${index + 1} uses “${boundedDetailValue(match[0])}”; move the earlier action beside “after” or split the sequence into two sentences`);
  });
  return observationResult('modifier-attachment', observations, MAX_REFERENCE_CLARITY_OBSERVATIONS,
    `${list.length} passage(s) attach temporal modifiers to the intended action`);
}

// Slash shorthand is common in raw notes, but in a migration sentence it can
// leave a reader unsure whether a system, its tracking function, or the data
// moved. This detects only the high-confidence movement shape; conventional
// paired actions such as “sign-in/sign-out system” already name one clear
// artifact and remain outside the rule.
const AMBIGUOUS_MIGRATION_SLASH_OBJECT = /\b[\p{L}-]+\/[\p{L}-]+(?:\s+[\p{L}-]+){0,2}\s+(?:moved|migrated|transitioned|transferred)\b/iu;
const AMBIGUOUS_MIGRATION_ABSTRACT_OBJECT = /\b(?:tracking|management|processing|reporting)\s+(?:moved|migrated|transitioned|transferred)\b/iu;
const CONVENTIONAL_PAIRED_SLASH_ACTION = /\b([\p{L}]+)-in\s*\/\s*\1-out\b/iu;

/** Requires migration copy to name the systems or data that moved. */
export function checkMigrationObjectClarity(passages = []) {
  const list = Array.isArray(passages) ? passages : [];
  const observations = [];
  list.forEach((passage, index) => {
    const source = text(passage);
    const slash = AMBIGUOUS_MIGRATION_SLASH_OBJECT.exec(source);
    const match = slash && !CONVENTIONAL_PAIRED_SLASH_ACTION.test(slash[0])
      ? slash
      : AMBIGUOUS_MIGRATION_ABSTRACT_OBJECT.exec(source);
    if (!match) return;
    observations.push(`passage ${index + 1} leaves a migration object ambiguous (“${boundedDetailValue(match[0])}”); name the systems and/or data that moved, and rewrite slash shorthand as natural coordination`);
  });
  return observationResult('migration-object-clarity', observations, MAX_COPY_PRECISION_OBSERVATIONS,
    `${list.length} passage(s) name the systems or data affected by migration`);
}

// Widely recognized stack tokens only. Technologies whose names are ordinary
// English words or common given names (Go, Swift, R, C, D) are deliberately
// absent: matching is case-sensitive, and capitalization alone cannot tell
// “Go” the language from “Go” at the start of a sentence. A missed tool name
// costs nothing here; a false one costs a revision cycle.
export const STACK_TOOL_LEXICON = Object.freeze([
  'React', 'Redux', 'Angular', 'Vue', 'Svelte', 'Nuxt', 'Next.js', 'Node.js', 'Deno', 'Express',
  'jQuery', 'Tailwind', 'Bootstrap', 'Sass', 'Webpack', 'Vite', 'Electron', 'TypeScript', 'JavaScript',
  'Python', 'Django', 'Flask', 'FastAPI', 'Celery', 'SQLAlchemy', 'Pandas', 'NumPy', 'PyTorch', 'TensorFlow',
  'Rails', 'Laravel', 'PHP', 'Java', 'Kotlin', 'Scala', 'Spring', 'Haskell', 'Elixir', 'Erlang', 'Clojure',
  'Rust', 'C#', 'C++', 'Objective-C', '.NET', 'ASP.NET', 'PowerShell', 'Bash', 'Linux', 'Ubuntu',
  'PostgreSQL', 'Postgres', 'MySQL', 'SQLite', 'MongoDB', 'Mongoose', 'Prisma', 'Sequelize', 'Redis',
  'Elasticsearch', 'Kafka', 'RabbitMQ', 'GraphQL', 'Nginx', 'Gunicorn', 'uWSGI', 'Apache', 'Tomcat',
  'Docker Compose', 'Docker', 'Kubernetes', 'Terraform', 'Ansible', 'Jenkins', 'GitHub Actions', 'GitLab',
  'Bitbucket', 'Git', 'Jira', 'Airflow', 'Spark', 'Hadoop', 'AWS', 'Azure', 'GCP', 'Lambda', 'EC2', 'S3',
  'Vercel', 'Netlify', 'Heroku', 'Cloudflare', 'Firebase', 'Supabase', 'Grafana', 'Prometheus', 'Sentry',
  'Datadog', 'Stripe', 'Twilio', 'SharePoint', 'Salesforce', 'Jest', 'Cypress', 'Playwright', 'Puppeteer',
  'Selenium',
]);

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Longest-first alternation so “Docker Compose” consumes both of its words and
// is not counted a second time as “Docker”. Letter/number lookarounds rather
// than \b: the tokens end in punctuation (“C++”, “.NET”, “Node.js”) that \b
// would anchor in the wrong place.
const STACK_TOOL_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${[...STACK_TOOL_LEXICON].sort((left, right) => right.length - left.length).map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}])`,
  'gu');

/**
 * A tool, framework, or product name earns a place in the LETTER only when the
 * posting or the research names it, or when it is that paragraph's single
 * concrete anchor; otherwise the technology category carries the argument and
 * the résumé carries the stack. This is also the punctuation-agnostic form of
 * the anti-unloading rule: a stack dump is high anchor density whatever
 * delimiter introduces it, so a semicolon or a dash is no longer an escape.
 */
export function checkAnchorRelevance(paragraphs = [], jobText = '', researchText = '') {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  // Normalize each source separately so a null/undefined corpus argument
  // stringifies to nothing instead of to a literal "null" the lexicon would
  // then be matched against.
  const corpus = `${normalized(jobText)} ${normalized(researchText)}`.trim();
  // Never punish a missing corpus: with no posting and no research text every
  // name would read as unlicensed and the whole letter would be rewritten.
  if (!corpus) return result('anchor-relevance', true, 'skipped: no posting or research text supplied');
  // Same reasoning for a corpus that is present but is only posting metadata:
  // a title, company, location, and salary can license a name they happen to
  // contain, but they can never establish that the employer does not want one.
  const corpusWordCount = wordCount(corpus);
  if (corpusWordCount < MIN_ANCHOR_RELEVANCE_CORPUS_WORDS) {
    return result('anchor-relevance', true,
      `skipped: posting and research text supply only ${corpusWordCount} word(s), too few to treat an unmentioned tool name as off-posting`);
  }
  const licenses = new Map();
  // A posting that says “Docker” licenses “Docker Compose”: the head token is
  // the technology, and the suffix is the flavour of it the letter names.
  const licensed = entry => {
    if (!licenses.has(entry)) {
      // Word-boundary-aware, like STACK_TOOL_PATTERN above: a raw substring
      // test would let a corpus mentioning only “JavaScript” license the
      // unrelated “Java”, or “GitHub Actions”/“GitLab” license “Git”.
      const headToken = entry.split(' ')[0];
      const alternatives = headToken === entry ? [entry] : [entry, headToken];
      const pattern = new RegExp(
        `(?<![\\p{L}\\p{N}])(?:${alternatives.map(alt => escapeRegExp(normalized(alt))).join('|')})(?![\\p{L}\\p{N}])`,
        'u');
      licenses.set(entry, pattern.test(corpus));
    }
    return licenses.get(entry);
  };
  const observations = [];
  const letterWide = [];
  for (let index = 0; index < list.length; index++) {
    const unlicensed = [];
    for (const match of text(list[index]).matchAll(STACK_TOOL_PATTERN)) {
      const entry = match[0];
      if (licensed(entry) || unlicensed.includes(entry)) continue;
      unlicensed.push(entry);
      if (!letterWide.includes(entry)) letterWide.push(entry);
    }
    if (unlicensed.length > MAX_PARAGRAPH_OFF_POSTING_TOOLS) {
      observations.push(`paragraph ${index + 1} names ${unlicensed.length} stack tools the posting and research never mention (${boundedQuotedList(unlicensed)}); keep at most one as that paragraph's single concrete anchor and describe the rest by technology category rather than by product name`);
    }
  }
  // A tour spread one name per paragraph is still a tour, so the letter-wide
  // total is checked even when no single paragraph exceeded its anchor.
  if (letterWide.length > MAX_LETTER_OFF_POSTING_TOOLS) {
    observations.push(`letter names ${letterWide.length} stack tools the posting and research never mention (${boundedQuotedList(letterWide)}); the resume carries the stack — keep at most ${MAX_LETTER_OFF_POSTING_TOOLS} off-posting tool names in the whole letter`);
  }
  return observationResult('anchor-relevance', observations, MAX_ANCHOR_RELEVANCE_OBSERVATIONS,
    `${letterWide.length} off-posting stack tool name(s) across ${list.length} paragraph(s)`);
}

// A cross-domain example earns its specificity in the evidence sentence. When
// a target-facing thesis carries two adjacent, source-only terms into the role
// claim (a prior workflow's two-word mechanic, for example), it quietly recasts
// that workflow as work the new team needs. This is deliberately narrower than
// a semantic relevance scorer: it only rejects a concrete source phrase in a
// thesis or explicitly target-facing sentence, and only when the posting is
// substantial enough for silence to be meaningful.
const TARGET_FACING_REFERENCE = /\b(?:this|the|your)\s+(?:(?:[\p{L}'’-]+\s+){0,5})(?:role|position|team|work|service|services|system|systems|moderni[sz]ation)\b|\bat\s+(?:the\s+)?target\s+(?:employer|company)\b/iu;
const TARGET_TRANSFER_VERB = /\bi\s+(?:(?:would\s+)?(?:bring|apply|use)|would\s+(?:draw\s+on|contribute))\b/iu;
const TARGET_APPLICATION_CONSTRUCTION = /\b(?:applying|bringing|contributing)\s+my\b/iu;
const TARGET_SCOPE_STOP_WORDS = new Set([
  'about', 'after', 'also', 'and', 'are', 'before', 'between', 'build', 'building', 'by', 'can', 'could', 'design', 'designing', 'develop', 'developing', 'experience', 'for', 'from', 'help', 'implement', 'implementing', 'in', 'into', 'is', 'make', 'making', 'of', 'on', 'or', 'our', 'support', 'supporting', 'that', 'the', 'this', 'through', 'to', 'usable', 'use', 'using', 'web', 'with', 'would', 'your',
]);
function sourceOnlyTerm(word, jobTerms, evidenceTerms) {
  const normalizedWord = word.replace(/s$/u, '');
  return normalizedWord.length >= 4
    && !TARGET_SCOPE_STOP_WORDS.has(normalizedWord)
    && evidenceTerms.has(normalizedWord)
    && !jobTerms.has(normalizedWord);
}

function scopeTerms(value) {
  return words(value)
    .flatMap(word => word.split('-'))
    .filter(Boolean)
    .map(word => word.replace(/s$/u, ''));
}

// Words that make a sentence target-facing, or carry the offer itself, without
// saying anything about what the target does. A sentence whose only posting
// words are these (“I would bring my … experience to this role”) offers the
// candidate's experience and claims nothing about the work. Plain English
// function and reference words, no field's vocabulary. Terms are compared the
// way scopeTerms writes them: lower case, trailing “s” removed.
const TARGET_GENERIC_REFERENCE_WORDS = new Set([
  'role', 'position', 'team', 'organization', 'organisation', 'company', 'employer', 'department', 'project', 'job', 'opportunity',
  'work', 'service', 'system', 'modernization', 'modernisation', 'bring', 'apply', 'applying', 'bringing', 'contribute', 'contributing', 'draw',
  'would', 'could', 'will', 'able', 'want', 'have', 'been', 'their', 'these', 'those', 'which', 'where', 'while', 'when', 'what', 'each', 'every',
  'skill', 'background', 'capability', 'practice', 'approach', 'judgment', 'knowledge', 'strength', 'ability', 'expertise', 'foundation',
]);

/**
 * Keeps a prior workflow's mechanics in its proof sentence instead of
 * promoting them into the target thesis. A role thesis is always target
 * facing; prose needs an explicit target reference plus a prospective-transfer
 * verb before this limited lexical check applies.
 *
 * What the check protects is the reader's picture of the TARGET: a sentence
 * that sets two of the candidate's own workflow terms beside a responsibility
 * the posting names teaches the reader that the team does that workflow. A
 * sentence that names no responsibility of the posting at all offers the
 * candidate's experience and says nothing about the team, whatever words the
 * experience is called by, and is not read. The posting has to name something
 * the sentence is about (a content word of the posting that is not the
 * offer's own vocabulary, see TARGET_GENERIC_REFERENCE_WORDS) for the pair to
 * be set beside it; the pair itself is still found the way it always was.
 */
export function checkTargetClaimScope(plan = {}, paragraphs = [], evidence = {}, jobText = '') {
  if (wordCount(jobText) < MIN_ANCHOR_RELEVANCE_CORPUS_WORDS) {
    return result('target-claim-scope', true, 'skipped: posting text is too short to distinguish target needs from prior-work mechanics');
  }
  const jobTerms = new Set(scopeTerms(jobText));
  const evidenceTerms = new Set(bulletTexts(evidence)
    .flatMap(scopeTerms));
  if (!evidenceTerms.size) return result('target-claim-scope', true, 'skipped: no candidate evidence supplied');
  const claims = [{ label: 'roleThesis', value: text(plan?.roleThesis) }];
  (Array.isArray(paragraphs) ? paragraphs : []).forEach((paragraph, paragraphIndex) => {
    sentences(paragraph).forEach((sentence, sentenceIndex) => {
      const value = text(sentence);
      if (TARGET_FACING_REFERENCE.test(value)
        && (TARGET_TRANSFER_VERB.test(value) || TARGET_APPLICATION_CONSTRUCTION.test(value))) {
        claims.push({ label: `paragraph ${paragraphIndex + 1}, sentence ${sentenceIndex + 1}`, value });
      }
    });
  });
  const observations = [];
  for (const claim of claims) {
    const claimWords = scopeTerms(claim.value);
    // Nothing of the target is named, so nothing is claimed about it.
    const namesTargetWork = claimWords.some(word => word.length >= 4
      && jobTerms.has(word)
      && !TARGET_SCOPE_STOP_WORDS.has(word)
      && !TARGET_GENERIC_REFERENCE_WORDS.has(word));
    if (!namesTargetWork) continue;
    // Two adjacent source-only terms is the signal. A single source-only noun
    // is not: a posting that says “stock” where the evidence says “inventory”
    // (or “residents” for “patients”) licenses the candidate's own word for the
    // same thing, and no fixed noun list can tell the synonym from the leak.
    for (let index = 0; index < claimWords.length - 1; index++) {
      const pair = claimWords.slice(index, index + 2);
      if (!pair.every(word => sourceOnlyTerm(word, jobTerms, evidenceTerms))) continue;
      observations.push(`${claim.label} presents the prior-work mechanics “${pair.join(' ')}” as target work even though the posting never names them; state the broader capability the posting supports, then use the specific prior workflow only as evidence`);
      break;
    }
    if (observations.length >= MAX_TARGET_CLAIM_SCOPE_OBSERVATIONS) break;
  }
  return observationResult('target-claim-scope', observations, MAX_TARGET_CLAIM_SCOPE_OBSERVATIONS,
    'target-facing claims keep prior-work mechanics in their evidence sentences');
}

// A sentence can name an otherwise sound accomplishment and then spend its
// final appositive merely declaring that the accomplishment is relevant. That
// leaves the recruiter to infer the connection to the named responsibility.
// Keep this deliberately limited to the generated comma-tail shape: judging
// whether every sentence is persuasive would require semantic scoring, while
// this construction has no explanatory work beyond the assertion itself.
const DETACHED_RELEVANCE_ASSERTION = /,\s*(?:work|experience|background|skills?|qualifications?|migration|transition|change|decision)\s+(?:(?:that|which)\s+(?:is|was|are|were)\s+)?(?:(?:directly|closely)\s+)?(?:relevant|applicable)\s+to\s+(?:this|the)\s+(?:role|position)(?:['’]s)?\b/iu;

/** Requires an asserted relevance tail to explain the action-to-need connection. */
export function checkDetachedRelevanceClaim(paragraphs = []) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const observations = [];
  for (let index = 0; index < list.length; index++) {
    for (const sentence of sentences(list[index])) {
      const match = DETACHED_RELEVANCE_ASSERTION.exec(text(sentence));
      if (!match) continue;
      observations.push(`paragraph ${index + 1} ends with an asserted relevance tail (“${boundedDetailValue(match[0])}”); connect the named action directly to the specific responsibility, using conditional language for work that would occur after hiring, or remove the relevance label`);
      if (observations.length >= MAX_COPY_PRECISION_OBSERVATIONS) break;
    }
    if (observations.length >= MAX_COPY_PRECISION_OBSERVATIONS) break;
  }
  return observationResult('detached-relevance-claim', observations, MAX_COPY_PRECISION_OBSERVATIONS,
    `${list.length} paragraph(s) explain relevance through an action-to-responsibility connection`);
}

// Completed experience belongs in a past-tense evidence sentence, but the work
// the candidate proposes to do after hiring is contingent. Limit the check to
// the generated bridge shape where a candidate-owned experience noun becomes
// the subject of a non-conditional readiness claim ("prepared/equips me to
// contribute"). This leaves ordinary past evidence and current capability
// statements alone while requiring the prospective contribution itself to be
// conditional or otherwise explicitly future-facing.
const NONCONDITIONAL_PROSPECTIVE_CONTRIBUTION = /\b(?:this|that|my|the)\s+(?:[\p{L}’'-]+\s+){0,3}(?:experience|work|background|practice|project|(?:migration|transition|decision)(?:\s+(?:experience|work|background|practice|project))?)\s+(?:help(?:s|ed)|enable(?:s|d)|allow(?:s|ed)|prepare(?:s|d)|equip(?:s|ped)|position(?:s|ed))\s+me\s+(?:to\s+)?(?:contribute|support|help|advance|strengthen|improve|build|deliver)\b/iu;
const PROSPECTIVE_CONTRIBUTION_TARGET = /\b(?:(?:this|your)\s+(?:[\p{L}’'-]+\s+){0,2}(?:role|position|team|organization|organisation|department|program|programme|work|systems?|services?|moderni[sz]ation)|the\s+(?:role|position))\b/iu;

function companyReferenceAliases(companyName = '') {
  const name = text(companyName);
  if (!name) return [];
  // Job boards vary between a trading name and a legal name.  Treat the
  // suffix-less name as the same employer without guessing from a token in a
  // longer unrelated company name.
  const tradingName = normalizedCompanyDisplayName(name)
    .replace(/\b(?:incorporated|inc\.?|llc|ltd\.?|limited|corp\.?|corporation|co\.?|company|plc)\s*$/iu, '').replace(/[,\s]+$/u, '');
  const ignored = new Set(['and', 'of', 'the', 'for', 'at']);
  const acronym = words(tradingName || name)
    .filter(word => !ignored.has(normalized(word)))
    .map(word => word[0] || '')
    .join('').toUpperCase();
  return [...new Set([name, tradingName, acronym.length >= 2 ? acronym : ''].filter(Boolean))];
}

function namesProspectiveCompany(sentence, companyName = '') {
  const line = normalized(sentence);
  return companyReferenceAliases(companyName).some(alias => {
    const company = normalized(alias);
    return line.includes(`${company}'s`) || line.includes(`at ${company}`) || line.includes(`for ${company}`);
  });
}

// A letter's envelope is host-authored, but its body is model-authored.  That
// otherwise leaves a particularly damaging copy/paste error possible: a
// correct salutation followed by "at Other Company" in a prospective claim.
// Limit the detector to the prospective employer frame so past evidence at a
// cited prior employer remains ordinary, truthful experience prose.
const PROSPECTIVE_COMPANY_FRAME = /\b(?:(?:i|we|my\s+(?:work|experience|background)|this\s+(?:work|experience))\s+(?:(?:would|could|can|will)\s+)?(?:contribute|support|help|build|deliver|join|work|apply|bring)|(?:your|this)\s+(?:role|team|company|organization|organisation|mission|work|platform|product))\b/iu;
const NAMED_COMPANY_AFTER_PREPOSITION = /\b(at|for|with)\s+([\p{Lu}][\p{L}\p{N}&.'’-]*(?:\s+[\p{Lu}][\p{L}\p{N}&.'’-]*){0,5})\b/gu;
const NAMED_COMPANY_POSSESSIVE = /\b([\p{Lu}][\p{L}\p{N}&.'’-]*(?:\s+[\p{Lu}][\p{L}\p{N}&.'’-]*){0,5})['’]s\b/gu;
// These are capitalized product/domain abbreviations, not employer names.
// Do not turn an ordinary prospective sentence such as "bring AI practice"
// into an alleged copy/paste company mismatch.
const NON_COMPANY_ACRONYMS = new Set(['AI', 'API', 'APIS', 'B2B', 'B2C', 'CI', 'CD', 'CRM', 'CSS', 'ERP', 'HTML', 'IT', 'ML', 'SaaS', 'SDK', 'SQL', 'UI', 'UX']);

function sameCompanyReference(value, aliases) {
  const reference = item => normalized(item).replace(/[.,;:]+$/u, '').replace(/['’]s?$/u, '').trim();
  const candidate = reference(value);
  return aliases.some(alias => reference(alias) === candidate);
}

// These are ordinary English nouns, verbs, adjectives and adverbs as well as
// possible organization labels. Their lowercase use supplies no proper name.
const COMMON_COMPANY_ALIAS_WORDS = new Set([
  ...ARGUMENT_STOP_WORDS,
  'apple', 'beacon', 'block', 'box', 'bridge', 'canvas', 'compass', 'current', 'field', 'forward',
  'guide', 'hired', 'indeed', 'level', 'linear', 'loop', 'monday', 'notion', 'orange', 'remote',
  'scale', 'shift', 'signal', 'square', 'stripe', 'talent', 'target', 'track', 'way',
]);

function aliasSurfaceAllowed(alias, written) {
  const plain = value => text(value).replace(/[.,;:]+$/u, '').replace(/['’]s?$/u, '').trim();
  const original = plain(alias);
  const caseSensitive = !/\s/u.test(original) && (original.length <= 3 || COMMON_COMPANY_ALIAS_WORDS.has(original.toLowerCase()) || TOOL_NAME_WORDS.has(original.toLowerCase()));
  return !caseSensitive || plain(written) === original;
}

function plausibleNamedCompany(value) {
  const compact = String(value || '').replace(/[.,;:]+$/u, '').trim();
  return Boolean(compact) && !NON_COMPANY_ACRONYMS.has(compact);
}

function isPriorEmployerEvidenceBeforeProspectiveFrame(sentence, employerIndex) {
  const prospectiveIndex = sentence.search(PROSPECTIVE_COMPANY_FRAME);
  if (prospectiveIndex < 0 || employerIndex >= prospectiveIndex) return false;
  // A known prior employer is legitimate when this sentence first states
  // completed work there and only then turns to the target role. Do not let
  // a bare "At Acme, I would ..." construction borrow that allowance.
  const intervening = sentence.slice(employerIndex, prospectiveIndex);
  return /\b(?:built|created|delivered|designed|developed|drove|implemented|improved|led|managed|operated|shipped|supported|worked)\b/iu.test(intervening);
}

// The words of every tool name the module already treats as a technology, so a
// name made only of them is a product the candidate works with, not an employer.
const TOOL_NAME_WORDS = new Set(STACK_TOOL_LEXICON
  .flatMap(entry => entry.split(/\s+/u))
  .map(word => word.toLowerCase()));

function namesOnlyTools(name) {
  const parts = String(name || '').split(/\s+/u).map(word => word.replace(/[.,;:]+$/u, '').toLowerCase()).filter(Boolean);
  return parts.length > 0 && parts.every(word => TOOL_NAME_WORDS.has(word));
}

// A suffix that makes a capitalised run read as a legal entity.
const COMPANY_SUFFIX_RE = /(?:^|\s)(?:inc|incorporated|llc|ltd|limited|corp|corporation|co|company|plc|gmbh|ag|sa)\.?$/iu;

function occursAsWholeName(name, corpus) {
  const needle = normalized(name).replace(/[.,;:]+$/u, '').trim();
  if (!needle || !corpus) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, 'u').test(corpus);
}

// A known prior employer named after a past-tense verb in the same clause is a
// reference to history (“the way it worked at <employer>”, “as I did at
// <employer>”), not the employer a future contribution is directed to.
const PAST_HISTORY_BEFORE_EMPLOYER = /\b(?:did|had|was|were|built|created|delivered|designed|developed|drove|implemented|improved|led|managed|operated|ran|shipped|supported|wrote|worked)\s+(?:[\p{L}'’-]+\s+){0,3}(?:at|for|with|to)\s+$/iu;

/**
 * Keeps a named prospective employer bound to this job.  Known prior
 * employers are allowed only in a past-evidence sentence; an unknown named
 * company in a future contribution sentence is never a safe target guess.
 *
 * The defect this reads is a copy/paste company error: a name that belongs to
 * some other application standing where this job's employer should be. A name
 * the approved record already explains cannot be one. So a name is not read as
 * an employer when it is a technology the candidate works with (a tool name, or
 * one the evidence itself names), when the posting names it, when it follows
 * “with” as a single word (“work with <Name> services”), or, for a known prior
 * employer, when it only recalls the work done there. A run of capitalised words
 * after “at” or “for”, or a possessive, that the evidence and the posting never
 * mention is still refused.
 */
export function checkTargetCompanyBinding(paragraphs = [], companyName = '', priorEmployers = [], { evidence = null, jobText = '', forbiddenNames = [] } = {}) {
  const targetAliases = [...new Set(targetCompanyNames(companyName).flatMap(companyReferenceAliases))];
  const priorAliases = (Array.isArray(priorEmployers) ? priorEmployers : [])
    .flatMap(companyReferenceAliases);
  const forbiddenAliases = (Array.isArray(forbiddenNames) ? forbiddenNames : [])
    .filter(name => !sameCompanyReference(name, targetAliases))
    .flatMap(companyReferenceAliases);
  // Generated short initialisms keep the existing refusal to guess a company
  // from "WE". An explicit short name such as "Box" can be scanned, but only
  // in its original case, just like an ordinary-word company label.
  const explicitShortAliases = new Set([...(Array.isArray(priorEmployers) ? priorEmployers : []), ...(Array.isArray(forbiddenNames) ? forbiddenNames : [])]
    .flatMap(name => [text(name), normalizedCompanyDisplayName(name)])
    .filter(name => name.length <= 3 && !/\s/u.test(name)));
  const additionalAlias = alias => alias.length > 3 || /\s/u.test(alias) || explicitShortAliases.has(alias);
  const bindingAliases = [...new Set([...priorAliases, ...forbiddenAliases])].filter(additionalAlias);
  const bindingForbiddenAliases = forbiddenAliases.filter(additionalAlias);
  if (!targetAliases.length && !priorAliases.length && !forbiddenAliases.length) {
    return result('target-company-binding', true, 'skipped: no company identities are available');
  }
  const postingCorpus = normalized(jobText);
  const projectText = (Array.isArray(evidence?.projects) ? evidence.projects : [])
    .map(project => `${project?.name || ''} ${project?.description || ''}`).join(' ');
  const evidenceCorpus = normalized(`${resumeEvidenceText(evidence || {})} ${projectText}`);
  const observations = [];
  (Array.isArray(paragraphs) ? paragraphs : []).forEach((paragraph, paragraphIndex) => {
    sentences(paragraph).forEach((sentence, sentenceIndex) => {
      const value = text(sentence);
      const targetSpans = targetAliases.flatMap(alias => [...value.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(alias)}(?:['’]s?)?(?![\\p{L}\\p{N}])`, 'giu'))]
        .map(match => [match.index, match.index + match[0].length]))
        .sort((left, right) => right[1] - right[0] - (left[1] - left[0]));
      const aliasObjects = bindingAliases.flatMap(alias =>
        [...value.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])(to|join|joining|help|helping|support|supporting|serve|serving|assist|assisting)\\s+(?:the\\s+)?(${escapeRegExp(alias)})(?:['’]s?)?(?![\\p{L}\\p{N}])`, 'giu'))].filter(match => aliasSurfaceAllowed(alias, match[2])).map(match => ({
          value: match[2], index: match.index ?? -1, preposition: match[1].toLowerCase(), prefixEnd: (match.index ?? 0) + match[0].indexOf(match[2]),
        })));
      if (!PROSPECTIVE_COMPANY_FRAME.test(value)
        && !(aliasObjects.length && /\b(?:i|we)(?:['’](?:d|ll))?\b/iu.test(value))) return;
      const explicitlyTargetBound = /\b(?:for|in|to)\s+this\s+role\b|\b(?:your|this)\s+(?:team|company|organization|organisation|mission|platform|product)\b/iu.test(value)
        || targetAliases.some(alias => occursAsWholeName(alias, normalized(value)));
      const namedEmployers = [
        ...[...value.matchAll(NAMED_COMPANY_AFTER_PREPOSITION)].map(match => ({
          value: match[2], index: match.index ?? -1, preposition: match[1].toLowerCase(), prefixEnd: (match.index ?? 0) + match[0].length - match[2].length,
        })),
        ...[...value.matchAll(NAMED_COMPANY_POSSESSIVE)].map(match => ({
          value: match[1], index: match.index ?? -1, preposition: '', prefixEnd: match.index ?? 0,
        })),
        ...aliasObjects,
        ...bindingAliases.flatMap(alias =>
          [...value.matchAll(new RegExp(`^(At|For|With|To)\\s+(${escapeRegExp(alias)})(?=,?\\s+(?:i|we)\\s+(?:would|could|can|will)\\b)`, 'giu'))].map(match => ({
            value: match[2], index: 0, preposition: match[1].toLowerCase(), prefixEnd: match[0].indexOf(match[2]),
          }))),
        // Prior-employer subjects and plural possessives are prospective
        // targets too, without widening the ordinary preposition extractor.
        ...bindingAliases.flatMap(alias =>
          [...value.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])(${escapeRegExp(alias)})(?:['’]s?(?=\\s)|(?=\\s+(?:would|could|can|will)\\b))(?![\\p{L}\\p{N}])`, 'giu'))].map(match => ({
            value: match[1], index: match.index ?? -1, preposition: '', prefixEnd: match.index ?? 0,
          }))),
        ...bindingForbiddenAliases.flatMap(alias =>
          [...value.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])(${escapeRegExp(alias)})(?:['’]s?)?(?![\\p{L}\\p{N}])`, 'giu'))].map(match => ({
            value: match[1], index: match.index ?? -1, preposition: '', prefixEnd: match.index ?? 0,
          }))),
      ].filter(match => {
        if (!plausibleNamedCompany(match.value)) return false;
        const start = match.prefixEnd; const end = start + match.value.length;
        if (targetSpans.some(([targetStart, targetEnd]) => targetStart <= start && end <= targetEnd)) return false;
        const approvedAliases = [...priorAliases, ...forbiddenAliases].filter(alias => sameCompanyReference(match.value, [alias]));
        return !approvedAliases.length || approvedAliases.some(alias => aliasSurfaceAllowed(alias, match.value));
      });
      for (const employer of namedEmployers) {
        const named = employer.value;
        if (sameCompanyReference(named, targetAliases)) continue;
        const knownPrior = sameCompanyReference(named, priorAliases);
        const forbidden = sameCompanyReference(named, forbiddenAliases);
        if (knownPrior && isPriorEmployerEvidenceBeforeProspectiveFrame(value, employer.index)) continue;
        if (knownPrior && PAST_HISTORY_BEFORE_EMPLOYER.test(value.slice(0, employer.prefixEnd))) continue;
        if (!knownPrior && !forbidden) {
          if (namesOnlyTools(named)) continue;
          if (occursAsWholeName(named, postingCorpus) || occursAsWholeName(named, evidenceCorpus)) continue;
          // A "with X" phrase names past tools or experience when the same
          // sentence explicitly binds the proposed work to this target.
          // Keep "for X", "at X", and known prior employers as targets.
          if (explicitlyTargetBound && employer.preposition === 'with' && !COMPANY_SUFFIX_RE.test(named)) continue;
          // “with” takes a product, a language or a client far more often than
          // a new employer; a single word after it is read only when it is
          // known to be an employer, which the branches above already did.
          if (employer.preposition === 'with' && !/\s/u.test(named.trim()) && !COMPANY_SUFFIX_RE.test(named)) continue;
        }
        observations.push(`paragraph ${paragraphIndex + 1} sentence ${sentenceIndex + 1} directs prospective contribution to “${boundedDetailValue(named)}”${forbidden ? ', the poster' : knownPrior ? ', a prior employer' : ''}; bind future-facing work to this job’s employer or use “this role”, and keep prior employers only in past-tense evidence context`);
        break;
      }
    });
  });
  return observationResult('target-company-binding', observations, MAX_COPY_PRECISION_OBSERVATIONS,
    `${(Array.isArray(paragraphs) ? paragraphs : []).length} paragraph(s) bind any named prospective employer to this job`);
}

/** Keeps target-facing contribution claims conditional or future-facing. */
export function checkProspectiveContributionTense(paragraphs = [], companyName = '') {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const observations = [];
  const finalParagraphIndex = list.length - 1;
  for (let index = 0; index < list.length; index++) {
    const paragraphSentences = sentences(list[index]);
    // checkDirectWelcomeClosing certifies exactly ONE sentence per letter —
    // finalSubstantiveClosingSentenceIndex's pick in the FINAL paragraph — not
    // "any sentence in the final paragraph that happens to match an
    // invitation shape". Computing that position once, from this same
    // sentences() call, and comparing by INDEX below (not by re-testing every
    // sentence's text against certifiedClosingInvitation) is what keeps a
    // genuine readiness-bridge defect in an earlier sentence of the final
    // paragraph from being exempted just because it shares an invitation
    // regex's wording with the sentence actually certified.
    const certifiedIndex = index === finalParagraphIndex
      ? finalSubstantiveClosingSentenceIndex(paragraphSentences)
      : -1;
    for (let sentenceIndex = 0; sentenceIndex < paragraphSentences.length; sentenceIndex++) {
      const sentence = paragraphSentences[sentenceIndex];
      const value = text(sentence);
      // See certifiedClosingInvitation's comment: the ONE sentence
      // checkDirectWelcomeClosing has already certified must not be rejected
      // here for the present tense that certification requires.
      if (sentenceIndex === certifiedIndex && certifiedClosingInvitation(value)) continue;
      const match = NONCONDITIONAL_PROSPECTIVE_CONTRIBUTION.exec(value);
      if (!match || (!PROSPECTIVE_CONTRIBUTION_TARGET.test(value) && !namesProspectiveCompany(sentence, companyName))) continue;
      observations.push(`paragraph ${index + 1} uses a past/present readiness bridge for prospective-employer work (“${boundedDetailValue(match[0])}”); state the completed work as past evidence, then use conditional or future-facing target language in a transfer form that differs from the transfer forms of the neighbouring paragraphs`);
      if (observations.length >= MAX_COPY_PRECISION_OBSERVATIONS) break;
    }
    if (observations.length >= MAX_COPY_PRECISION_OBSERVATIONS) break;
  }
  return observationResult('prospective-contribution-tense', observations, MAX_COPY_PRECISION_OBSERVATIONS,
    `${list.length} paragraph(s) frame proposed employer contributions conditionally or prospectively`);
}

// Employment dates on a résumé normally name months, not days. Treat an
// explicit end month as over only after the deterministic reference month has
// passed; on the end month itself the candidate may still be employed. A
// year-only end date is held to the same caution one level up: the role may
// have run to December, so it is over only once the reference year has passed.
// This keeps the gate conservative and avoids letting the host clock change a
// completed package's verdict.
//
// The dates are read by the same parser the tenure engine uses
// (jobFitAssessment.js parseCareerDate), so a spelling one of them accepts the
// other cannot drop.
const ENDED_ROLE_CURRENT_EMPLOYMENT_OBSERVATIONS = 4;
// These are deliberately employment-action forms, not a general present-tense
// lexicon. The gate reads them only after a role/employer frame has already
// made the action current work, so it catches “I am building” as well as “I
// build” without turning employer-free capability prose into an employment
// claim.
const CURRENT_WORK_VERBS = '(?:build(?:s|ing)?|creat(?:e|es|ing)|deliver(?:s|ing)?|design(?:s|ing)?|develop(?:s|ing)?|implement(?:s|ing)?|lead(?:s|ing)?|maintain(?:s|ing)?|manag(?:e|es|ing)|operat(?:e|es|ing)|run(?:s|ning)?|support(?:s|ing)?|work(?:s|ing)?)';
const CURRENT_WORK_SUBJECT = `i\\s+(?:(?:am|['’]m)\\s+)?(?:currently\\s+)?${CURRENT_WORK_VERBS}`;

function referenceYearMonth(referenceDate) {
  if (referenceDate instanceof Date && Number.isFinite(referenceDate.getTime())) {
    return { year: referenceDate.getUTCFullYear(), month: referenceDate.getUTCMonth() };
  }
  // Newly queued Local AI jobs freeze an ISO timestamp in input.json. Do not
  // accept locale-shaped strings here: their parsing varies by host and would
  // make an otherwise identical handoff nondeterministic.
  const match = /^\s*((?:19|20)\d{2})-(0[1-9]|1[0-2])(?:-\d{2})?(?:T.*)?\s*$/u.exec(String(referenceDate || ''));
  return match ? { year: Number(match[1]), month: Number(match[2]) - 1 } : null;
}

// The end a role states, as { year, month } (`month` null for a year-only end),
// or null when it states none or is still open.
function explicitEndDate(role) {
  const { end } = careerRoleDateInputs(role);
  if (end == null || end === '') return null;
  const parsed = parseCareerDate(end, { lenient: true });
  return parsed && !parsed.current ? { year: parsed.year, month: parsed.month } : null;
}

function endedBeforeReference(role, reference) {
  const end = explicitEndDate(role);
  if (!end) return null;
  const ended = end.month == null
    ? end.year < reference.year
    : end.year < reference.year || (end.year === reference.year && end.month < reference.month);
  return ended ? end : null;
}

function currentEmploymentFrame(sentence, role) {
  const company = text(role?.company);
  if (!company) return '';
  const employer = escapeRegExp(company);
  const title = text(role?.title);
  const roleTitle = title ? escapeRegExp(title) : '';
  // The title-specific forms capture the common misleading construction
  // (“As a Software Engineer at Acme, I build ...”) without treating a general
  // present-tense capability claim that merely recalls prior evidence as work
  // the candidate is doing now.
  if (roleTitle) {
    const asRole = new RegExp(`\\bas\\s+(?:an?\\s+|the\\s+)?${roleTitle}\\s+(?:at|with)\\s+${employer}\\s*,?\\s+${CURRENT_WORK_SUBJECT}\\b`, 'iu');
    if (asRole.test(sentence)) return asRole.exec(sentence)?.[0] || company;
    const isRole = new RegExp(`\\bi\\s+(?:am|['’]m)\\s+(?:currently\\s+)?(?:an?\\s+|the\\s+)?${roleTitle}\\s+(?:at|with)\\s+${employer}\\b`, 'iu');
    if (isRole.test(sentence)) return isRole.exec(sentence)?.[0] || company;
  }
  const currentRole = new RegExp(`\\b(?:my|the)\\s+(?:current|present|ongoing)\\s+(?:role|position|work|employment)\\b[^.!?]{0,80}\\b(?:at|with)\\s+${employer}\\b`, 'iu');
  if (currentRole.test(sentence)) return currentRole.exec(sentence)?.[0] || company;
  const employedThere = new RegExp(`\\bi\\s+(?:am|['’]m|remain|continue\\s+to\\s+be)\\s+(?:currently\\s+)?(?:employed|working)\\s+(?:at|with)\\s+${employer}\\b|\\bi\\s+(?:currently\\s+)?(?:work|serve|continue\\s+to\\s+work)\\s+(?:at|with)\\s+${employer}\\b`, 'iu');
  if (employedThere.test(sentence)) return employedThere.exec(sentence)?.[0] || company;
  const atEmployer = new RegExp(`\\b(?:at|with)\\s+${employer}\\s*,?\\s+${CURRENT_WORK_SUBJECT}\\b`, 'iu');
  return atEmployer.test(sentence) ? (atEmployer.exec(sentence)?.[0] || company) : '';
}

/**
 * Rejects only explicit present/current-employment framing for a résumé role
 * whose stated end month is before the frozen handoff month, or whose
 * year-only end falls in an earlier year than the handoff. Present/Current
 * date ranges, unparseable dates, and employer-free capability claims remain
 * outside this narrow factual gate.
 */
export function checkEndedRoleCurrentEmployment(paragraphs = [], evidence = {}, referenceDate = null) {
  const reference = referenceYearMonth(referenceDate);
  if (!reference) return {
    ...result('ended-role-current-employment', true, 'skipped: no deterministic reference month is available'),
    endedRoleCount: 0, failureCount: 0, referenceMonth: null,
  };
  const endedRoles = (Array.isArray(evidence?.roles) ? evidence.roles : [])
    .map(role => ({ role, end: endedBeforeReference(role, reference) }))
    .filter(({ role, end }) => end && text(role?.company));
  const referenceMonth = `${reference.year}-${String(reference.month + 1).padStart(2, '0')}`;
  if (!endedRoles.length) return {
    ...result('ended-role-current-employment', true, 'no résumé role has an explicit end date before the reference month'),
    endedRoleCount: 0, failureCount: 0, referenceMonth,
  };
  const observations = [];
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  for (let paragraphIndex = 0; paragraphIndex < list.length; paragraphIndex++) {
    for (const sentence of sentences(list[paragraphIndex])) {
      for (const { role, end } of endedRoles) {
        const frame = currentEmploymentFrame(text(sentence), role);
        if (!frame) continue;
        const roleLabel = [text(role.title), text(role.company)].filter(Boolean).join(' at ');
        const endLabel = end.month == null
          ? `${end.year} (year-only end date)`
          : `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][end.month]} ${end.year}`;
        observations.push(`paragraph ${paragraphIndex + 1} frames the explicitly ended role “${boundedDetailValue(roleLabel)}” (${boundedDetailValue(text(role.dates))}; ended ${endLabel} before the reference ${end.month == null ? 'year' : 'month'}) as current employment (“${boundedDetailValue(frame)}”); describe that role's evidence in past tense or remove the current-work framing`);
        if (observations.length >= ENDED_ROLE_CURRENT_EMPLOYMENT_OBSERVATIONS) break;
      }
      if (observations.length >= ENDED_ROLE_CURRENT_EMPLOYMENT_OBSERVATIONS) break;
    }
    if (observations.length >= ENDED_ROLE_CURRENT_EMPLOYMENT_OBSERVATIONS) break;
  }
  return {
    ...observationResult('ended-role-current-employment', observations, ENDED_ROLE_CURRENT_EMPLOYMENT_OBSERVATIONS,
      'no explicitly ended résumé role is presented as current employment or current work'),
    endedRoleCount: endedRoles.length,
    failureCount: observations.length,
    referenceMonth,
  };
}

// “I built X. I built Y too.” appends a second proof without saying why it
// follows. Both halves are required before a sentence is flagged: an additive
// opener in front of a non-evidence sentence is ordinary connective prose.
// The build verb must also follow the connective subject immediately, with at
// most one -ly adverb between them. Accepting a build verb anywhere in the
// sentence swept in subordinate clauses — “In addition, I supported the staff
// who wrote the policy.”, “I also saw how a poorly designed intake process
// created rework for the front office.” — where the connective joins prose,
// not a second artifact.
const ADDITIVE_SEAM_CONNECTIVE_BUILD = /^(?:i\s+(?:also|additionally)\s+|additionally,?\s+i\s+|in\s+addition,?\s+i\s+|on\s+top\s+of\s+that,?\s+i\s+)(?:\p{L}+ly\s+)?(?:built|wrote|created|developed|designed|shipped|launched|made|delivered|maintained|architected|implemented)\b/u;
const ADDITIVE_SEAM_EVIDENCE_OPENERS = /^i\s+(?:built|wrote|created|developed|designed|shipped|launched|made|delivered)\b/u;
// Additive “too” need not end the sentence: a real letter escaped the trailer
// branch with “I built the <system> too, in <tooling>, covering …”, where the
// seam sits mid-sentence in front of a trailing clause. Punctuation is the
// deterministic separator — additive “too”
// is always followed by a mark or the sentence end (“too,” “too.”), while
// degree “too” is always followed by the word it modifies (“too slow”, “too
// many”), so the lookahead admits the first and never the second. “As well”
// stays end-anchored on purpose: mid-sentence “as well as the reporting layer”
// is a comparative, not an appended proof.
const ADDITIVE_SEAM_TRAILERS = /\btoo(?=\s*[,.!?;:]|\s*$)|\bas\s+well[.!?]?$/u;

/**
 * Catch the additive seam, not the words “also” or “too”: the sentence must
 * both wear the connective and be a piece of build evidence. The repair is
 * argumentative rather than lexical, which is why the detail asks for the gap
 * the artifact answers instead of a synonym for the connective.
 */
export function checkAdditiveSeam(paragraphs = []) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const observations = [];
  for (let index = 0; index < list.length; index++) {
    for (const sentence of sentences(list[index])) {
      const candidate = normalized(sentence);
      const seam = ADDITIVE_SEAM_CONNECTIVE_BUILD.test(candidate)
        || (ADDITIVE_SEAM_EVIDENCE_OPENERS.test(candidate) && ADDITIVE_SEAM_TRAILERS.test(candidate));
      if (!seam) continue;
      observations.push(`paragraph ${index + 1} appends evidence with a bare additive connective (“${leadingWordsSnippet(sentence)}”); state the gap or need this evidence answers before naming the artifact, or state its relation to the previous proof`);
    }
  }
  return observationResult('additive-seam', observations, MAX_ADDITIVE_SEAM_OBSERVATIONS,
    `${list.length} paragraph(s) join their evidence without a bare additive connective`);
}

// A responsibility pivot needs more than the fact that two tasks occurred in
// one job. These constructions have already produced letters that move from
// one system or lifecycle stage to another without explaining their shared
// responsibility: “That was a different problem. I solved it …”, “The same
// job included …”, and a sentence that only compares two work categories
// (“<Category> extended my <field> work beyond <category>.”). Keep the check
// deliberately lexical and narrow. It catches the opaque hand-off, not every
// use of “problem”, “challenge”, “same”, or “beyond”.
const OPAQUE_RESPONSIBILITY_PIVOT = /\b(?:a|another|the)\s+(?:different|separate)\s+(?:problem|challenge)\b/iu;
const ANAPHORIC_PIVOT_SOLUTION = /^(?:i|we)\s+(?:solved|addressed|handled|tackled|fixed)\s+(?:it|that|this)\b/iu;
const SAME_JOB_SCOPE_OPENER = /^the\s+same\s+(?:job|role|position)\s+(?:also\s+)?(?:included|involved|covered)\b/iu;

// The three category constructions below share one idea: a sentence made of
// BARE labels, with no determiner, name, figure or constraint anywhere in the
// label, says that one kind of work relates to another without saying how.
// The labels are recognised by their form, never by a vocabulary of work
// categories: a label is bare when it is a few lowercase words with no
// determiner, possessive, digit or capitalized name, and it is abstract when
// its head word is a nominalization (a word ending -tion, -ment, -ance, -ity,
// -ing and the like). Concrete uses stay legal because a constraint or a named
// object takes the label out of scope: “the migration extended the catalog
// without an outage” states a mechanism and a result.
const LABEL_BLOCKING_DETERMINERS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'my', 'our', 'your', 'their', 'his', 'her', 'its',
  'some', 'any', 'each', 'every', 'all', 'no', 'both', 'such',
]);
const ABSTRACT_LABEL_HEAD = /(?:tion|sion|ment|ance|ence|ity|ing|ism|ness|ship)s?$/u;

/**
 * Whether a phrase is a bare category label. `initial` lets the first word be
 * capitalized, because the phrase opens its sentence.
 */
function isBareCategoryLabel(phrase, { initial = false, abstract = false, maxWords = 4 } = {}) {
  const tokens = text(phrase).match(WORD_TOKEN_RE) || [];
  if (!tokens.length || tokens.length > maxWords) return false;
  if (/[\p{N}]/u.test(phrase) || /['’]s\b/u.test(phrase)) return false;
  const named = tokens.some((token, index) => /^\p{Lu}/u.test(token) && !(initial && index === 0));
  if (named || tokens.some(token => LABEL_BLOCKING_DETERMINERS.has(token.toLowerCase()))) return false;
  return !abstract || ABSTRACT_LABEL_HEAD.test(tokens[tokens.length - 1].toLowerCase());
}

// “<A> also extended my <B> work beyond <C>”: one abstract category called
// broader than another. Requiring the whole sentence to fit the frame keeps
// concrete uses legal.
const SCOPE_EXTENSION_FRAME = /^(.{1,80}?)\s+(?:also\s+)?(?:extended|broadened|expanded|widened)\s+my\s+(.{1,60}?)\s+(?:work|experience|background|practice)\s+beyond\s+(.{1,60}?)[.!?]?$/iu;

function isCategoryScopeExtension(sentence) {
  const match = SCOPE_EXTENSION_FRAME.exec(text(sentence));
  return Boolean(match)
    && isBareCategoryLabel(match[1], { initial: true, abstract: true })
    && isBareCategoryLabel(match[2])
    && isBareCategoryLabel(match[3], { abstract: true });
}

// “Beyond <bare category>, I <did something>” has the same defect in
// introductory form: a bare abstract category marks addition but supplies no
// relationship. A determiner, named object, constraint, or other material
// before the comma takes the sentence out of scope.
const BARE_BEYOND_OPENER = /^beyond\s+([^,]{1,60}),\s*(?:i|we)\s+(?:\p{L}+ly\s+)?(?:\p{L}+ed|built|wrote|led|ran|made|took|kept|drove)\b/iu;

function isBareBeyondCategoryOpener(sentence) {
  const match = BARE_BEYOND_OPENER.exec(text(sentence));
  return Boolean(match) && isBareCategoryLabel(match[1], { abstract: true });
}

// Once an umbrella sentence has named its branches, repeating each label
// through the same low-information frame makes the paragraph read like an
// outline: “I <light verb> <branch one> by …. I <light verb> <branch two> by
// ….”. A light verb names a responsibility without saying what was done, and
// the actions themselves should instantiate the branches. The labels are not
// listed: a label counts when its content words were ALREADY stated by an
// earlier sentence of the paragraph, which is what an umbrella is. One useful
// “handled X by” sentence is not a defect, nor is a concrete problem such as an
// outage or backlog that no earlier sentence named as a branch.
const LIGHT_RESPONSIBILITY_VERBS = '(?:handled|addressed|covered|managed|supported|demonstrated|tackled|oversaw|owned)';
const MIRRORED_CATEGORY_SCAFFOLD = new RegExp(
  String.raw`^(?:(?:separately|similarly|additionally|in\s+(?:separate|related|parallel|subsequent|additional)\s+[^,]{1,60}),\s*)?(?:i|we)\s+${LIGHT_RESPONSIBILITY_VERBS}\s+(?:the\s+)?([^,.;:!?]{1,50}?)\s+(?:by|through|such\s+as)\b`, 'iu');

/** The branch label a mirrored scaffold sentence announces, or '' when it is not one. */
function scaffoldBranchLabel(sentence) {
  const label = MIRRORED_CATEGORY_SCAFFOLD.exec(text(sentence))?.[1] || '';
  return label && isBareCategoryLabel(label) ? normalized(label) : '';
}

/** Whether every content word of a label was already used by the given earlier words. */
function labelWasAlreadyStated(label, earlierWords) {
  const contentWords = words(label).filter(word => !FRAME_FUNCTION_WORDS.has(word));
  return contentWords.length > 0 && contentWords.every(word => earlierWords.some(earlier => referentStemsMatch(word, earlier)));
}

/**
 * Requires a substantive bridge when prose changes responsibilities.
 *
 * A shared employer, job, or chronology is context, not an argumentative
 * relationship. The repair names the shared responsibility, constraint, or
 * outcome before introducing the next proof; when the evidence cannot support
 * one, the writer should remove the weaker proof: the résumé already carries
 * it, and giving it a paragraph of its own is the inventory the letter-proportion
 * check refuses.
 */
export function checkResponsibilityTransition(paragraphs = []) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const observations = [];
  for (let index = 0; index < list.length; index++) {
    const paragraph = text(list[index]);
    if (SAME_JOB_SCOPE_OPENER.test(paragraph)) {
      observations.push(`paragraph ${index + 1} opens with “${leadingWordsSnippet(paragraph)}”; shared job scope is not a bridge between responsibilities — name the shared responsibility, constraint, or outcome before the new proof, or remove it because the résumé already carries it`);
    }
    const paragraphSentences = sentences(paragraph);
    for (let sentenceIndex = 0; sentenceIndex < paragraphSentences.length; sentenceIndex++) {
      const sentence = paragraphSentences[sentenceIndex];
      if (isCategoryScopeExtension(sentence)) {
        observations.push(`paragraph ${index + 1} says “${boundedDetailValue(sentence)}”, which only renames one work category as broader than another; replace the scope comparison with a supported dependency, shared constraint, or outcome that explains why the next proof follows`);
      }
      if (isBareBeyondCategoryOpener(sentence)) {
        observations.push(`paragraph ${index + 1} opens evidence with a bare category transition (“${leadingWordsSnippet(sentence)}”); “beyond” marks addition but does not explain the relationship—name the dependency, shared constraint, or outcome that connects the proofs`);
      }
      const solution = paragraphSentences[sentenceIndex + 1];
      if (!solution || !OPAQUE_RESPONSIBILITY_PIVOT.test(sentence) || !ANAPHORIC_PIVOT_SOLUTION.test(solution)) continue;
      observations.push(`paragraph ${index + 1} shifts from “${leadingWordsSnippet(sentence)}” to “${leadingWordsSnippet(solution)}” through an opaque problem label; name the shared responsibility, constraint, or outcome before the new proof, or remove it because the résumé already carries it`);
    }
    for (let sentenceIndex = 0; sentenceIndex < paragraphSentences.length - 1; sentenceIndex++) {
      const first = scaffoldBranchLabel(paragraphSentences[sentenceIndex]);
      const second = scaffoldBranchLabel(paragraphSentences[sentenceIndex + 1]);
      if (!first || !second || first === second) continue;
      const earlierWords = paragraphSentences.slice(0, sentenceIndex).flatMap(words);
      if (!labelWasAlreadyStated(first, earlierWords) || !labelWasAlreadyStated(second, earlierWords)) continue;
      observations.push(`paragraph ${index + 1} repeats mirrored abstract labels (“${boundedDetailValue(first)}” then “${boundedDetailValue(second)}”); state the umbrella once, then let concrete action verbs demonstrate each branch, retaining only the separation cue needed to preserve factual scope`);
      break;
    }
  }
  return observationResult('responsibility-transition', observations, MAX_RESPONSIBILITY_TRANSITION_OBSERVATIONS,
    `${list.length} paragraph(s) bridge responsibility shifts with a substantive relationship`);
}

// In “every existing tool calls for”, the ordinary compound noun “tool calls”
// wins on a first pass even though “calls for” is the predicate. This is a
// garden-path, not a punctuation issue, so the repair must choose a predicate
// that cannot attach to “tool” (for example, “requires” or “demands”).
const TOOL_CALLS_GARDEN_PATH = /\btool\s+calls\s+for\b/iu;

/** Prevent a familiar compound noun from obscuring the intended predicate. */
export function checkToolCallsGardenPath(paragraphs = []) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const observations = [];
  for (let index = 0; index < list.length; index++) {
    for (const sentence of sentences(list[index])) {
      const match = TOOL_CALLS_GARDEN_PATH.exec(sentence);
      if (!match) continue;
      observations.push(`paragraph ${index + 1} creates a garden-path reading with “${boundedDetailValue(match[0])}”; readers initially parse “tool calls” as a compound noun, so replace “calls for” with “requires” or recast the sentence`);
    }
  }
  return observationResult('tool-calls-garden-path', observations, MAX_COPY_PRECISION_OBSERVATIONS,
    `${list.length} paragraph(s) avoid the “tool calls for” garden path`);
}

// A scoping phrase that names a category of built software, followed by a
// first-person build of that same category, only repeats itself: the sentence
// supplies neither a decision, constraint, mechanism, nor result. The category
// nouns are the generic hypernyms of built software (tool, system, application
// and the like), and the build object must be one of them with no modifier and
// nothing after it; a following specific object or result makes the sentence
// ordinary evidence, and a scope that names something other than a software
// category is information.
const SOFTWARE_CATEGORY_NOUN = '(?:software|code|applications?|apps?|systems?|tools?|solutions?|programs?|platforms?)';
const CATEGORY_RESTATING_BUILD = new RegExp(
  String.raw`^(?:for|with|where|when|across|among)\s+([^,.!?]{1,100}?),?\s+(?:i|we)\s+(?:built|developed|wrote|created|made)\s+(${SOFTWARE_CATEGORY_NOUN})[.!?]?$`, 'iu');
const SOFTWARE_CATEGORY_NOUN_RE = new RegExp(`\\b${SOFTWARE_CATEGORY_NOUN}\\b`, 'iu');

function restatesSoftwareCategory(sentence) {
  const match = CATEGORY_RESTATING_BUILD.exec(text(sentence));
  return Boolean(match) && SOFTWARE_CATEGORY_NOUN_RE.test(match[1]);
}

/** Reject a category-restating bridge sentence that cannot advance the argument. */
export function checkLowInformationToolBuild(paragraphs = []) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const observations = [];
  for (let index = 0; index < list.length; index++) {
    for (const sentence of sentences(list[index])) {
      if (!restatesSoftwareCategory(sentence)) continue;
      observations.push(`paragraph ${index + 1} says “${boundedDetailValue(sentence)}”, which only restates that the scoped thing is software; replace it with the supported decision, constraint, mechanism, or result—or remove it`);
    }
  }
  return observationResult('low-information-tool-build', observations, MAX_COPY_PRECISION_OBSERVATIONS,
    `${list.length} paragraph(s) avoid category-restating software claims`);
}

// A “containerized … with/using/via <tool>” clause credits <tool> with the
// containerizing. That credit is a role claim, and it is decided by the
// CURRENT résumé: the résumé states which tool carries its containerization,
// so a different technology the same résumé uses in some other role (a web
// server, a proxy, a runtime) cannot be promoted into that slot by the letter.
// Nothing here names a technology. A tool is recognized by how it is written,
// as a capitalized or identifier-shaped name, and it is judged only against
// what the evidence says. The check reads the local clause grammar, not the
// mere co-occurrence of two tools elsewhere in a paragraph, and it reads the
// instrument that follows the preposition, never the object that precedes it.
const CONTAINERIZATION_CLAUSE = /\bcontaineri[sz](?:e|ed|ing)\b[^.!?]{0,180}?\b(?:with|using|via)\b([^.!?]{0,180})/iu;
const EVIDENCE_CONTAINERIZATION_CLAUSE = /\bcontaineri[sz](?:e|ed|ing)\b[^.!?]{0,180}?(?<![\p{L}\p{N}-])(?:with|using|via|in|through|under|on)(?![\p{L}\p{N}-])([^.!?]{0,180})/iu;
// Where an instrument list ends: a clause that gives another tool its own role
// (“then configured …”, “, running … behind …”, “, with … handling …”), or the
// first word that opens a purpose, place or manner phrase instead of continuing
// a list of tools.
const SEPARATE_DEPLOYMENT_ROLE_CLAUSE = /(?:,?\s+(?:and\s+)?then|,?\s+while|,?\s+where|,?\s+and)\s+(?:configured|used|ran|placed|served|deployed|operated|set\s+up)\b|,\s*(?:while|with|using|via|which|where|behind|fronted)\b|,\s*\p{L}+ing\b|\s(?:so|for|to|behind|under|on|in|by|because|which|that|while|where|when|after|before|across|into|onto|over|from|at|as|then|plus|alongside|through)\s/iu;
// A tool name as it is written in prose: a capitalized word (optionally
// continued by further capitalized words), a camel-case or underscore
// identifier, or a dotted/plus/hash name. Single capital letters and the
// closed function words never count.
const WRITTEN_TOOL_NAME = /(?<![\p{L}\p{N}])(?:\p{Lu}[\p{L}\p{N}_.+#]*(?:\s+\p{Lu}[\p{L}\p{N}_.+#]*)*|\p{Ll}+\p{Lu}[\p{L}\p{N}]*|\p{L}+_\p{L}+)(?![\p{L}\p{N}])/gu;

/** Tool names written in the instrument phrase of a containerization clause. */
function writtenToolNames(instrumentPhrase) {
  return [...String(instrumentPhrase || '').matchAll(WRITTEN_TOOL_NAME)]
    .map(match => match[0].trim())
    .filter(name => name.length > 1 && !FRAME_FUNCTION_WORDS.has(name.toLowerCase()));
}

/** The tool list a containerization instrument governs, cut where another role or phrase begins. */
function governedInstrumentPhrase(clauseTail) {
  return String(clauseTail || '').split(SEPARATE_DEPLOYMENT_ROLE_CLAUSE, 1)[0];
}

/**
 * Every word the résumé places in the instrument slot of its own
 * containerization clauses, and a readable label for the names it uses there.
 */
function evidenceContainerizationInstruments(evidence) {
  const sources = [
    ...bulletTexts(evidence),
    ...(Array.isArray(evidence?.projects) ? evidence.projects : []).map(project => text(project?.description)),
  ];
  const instrumentWords = new Set();
  const labels = [];
  for (const source of sources) {
    for (const sentence of sentences(source)) {
      const tail = EVIDENCE_CONTAINERIZATION_CLAUSE.exec(sentence)?.[1];
      if (!tail) continue;
      const phrase = governedInstrumentPhrase(tail);
      genericWords(phrase).forEach(word => instrumentWords.add(word));
      const names = writtenToolNames(phrase);
      labels.push(...(names.length ? names : [words(phrase).slice(0, 4).join(' ')]).filter(Boolean));
    }
  }
  return { instrumentWords, labels: [...new Set(labels)] };
}

/** Every word the résumé evidence states anywhere, for deciding whether it states a name at all. */
function evidenceCorpusWords(evidence) {
  const skills = Array.isArray(evidence?.skills) ? evidence.skills : [];
  return genericWords([
    ...bulletTexts(evidence),
    ...(Array.isArray(evidence?.projects) ? evidence.projects : []).map(project => text(project?.description)),
    ...skills.flatMap(skill => [skill?.group || '', ...(Array.isArray(skill?.items) ? skill.items : [])]),
  ].join(' '));
}

/**
 * Ensure each tool a letter credits with containerization is the one the
 * current résumé credits. A letter tool is a role misattribution only when the
 * résumé states that very tool in some role AND names a different instrument
 * for its own containerization; with no containerization clause in the résumé
 * there is nothing for the letter to contradict, and a tool the résumé never
 * states is an ungrounded-name problem the grounding checks own. Every span
 * the letter or résumé supplied is curly-quoted below like every other
 * letter-matched span this file reports: this check is one of
 * PASTE_CHECK_PROSE_UNITS' fingerprinted battery — see
 * checkPriorEmployerOpening's comment above for why that variation cannot be
 * interpolated bare.
 */
export function checkContainerizationTechnologyRoles(paragraphs = [], evidence = {}) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const observations = [];
  const { instrumentWords, labels } = evidenceContainerizationInstruments(evidence);
  if (instrumentWords.size) {
    const corpusWords = evidenceCorpusWords(evidence);
    for (let index = 0; index < list.length; index++) {
      for (const sentence of sentences(list[index])) {
        const clause = CONTAINERIZATION_CLAUSE.exec(sentence);
        if (!clause) continue;
        // A later “then configured <tool> …” clause has supplied that tool with
        // its own role; do not mistake it for a member of the preceding
        // “containerized with …” list.
        const misattributed = writtenToolNames(governedInstrumentPhrase(clause[1])).find(name => {
          const nameWords = genericWords(name);
          return containsWordSequence(corpusWords, nameWords) && !nameWords.some(word => instrumentWords.has(word));
        });
        if (!misattributed) continue;
        observations.push(`paragraph ${index + 1} says “${boundedDetailValue(clause[0])}”, crediting “${misattributed}” with the containerization, but the résumé names “${boundedDetailValue(labels.join(', '))}” for that and states “${misattributed}” in a different role; credit the containerization only to what the résumé shows doing it, and describe “${misattributed}” in its own role separately`);
      }
    }
  }
  return observationResult('containerization-technology-roles', observations, MAX_COPY_PRECISION_OBSERVATIONS,
    `${list.length} paragraph(s) give deployment technologies role-accurate verbs`);
}

// Advertisement-object nouns are usually a sign that the letter is talking to
// the source document instead of the employer. One narrow exception is needed
// for honest provenance: a source document may own a reporting verb when the
// sentence attributes listing-only employer context. Keep that grammatical
// source distinct from the position itself, which cannot describe, state, or
// report anything.
// Two things a fixed bigram at a fixed offset cannot see, both measured on a
// letter this battery passed: a modifier between the determiner and the head
// noun (“the <job title> role centers on …”, “your recent posting asks
// for …”) and a fronted clause in front of the phrase (“At <company>, the role
// centers on …”). Neither changes what the sentence does
// with the advertisement, and the contract promises these are reported
// wherever they stand, so the phrase is read as a noun phrase anywhere in the
// sentence instead.
//
// A modifier is any word that is not one of these: a determiner, pronoun,
// preposition, conjunction or copula begins a new phrase rather than modifying
// this one, so a run that crossed one would join two phrases (“the skills the
// role requires” is one phrase ending at “skills” and another beginning at
// “the”).
const PHRASE_BREAKING_WORDS = 'the|a|an|this|that|these|those|my|your|our|his|her|its|their|and|or|but|nor|of|in|on|at|to|for|with|from|by|as|than|which|who|whom|whose|what|i|we|you|he|she|it|they|is|are|was|were|be|been';
// These modifiers point at a role other than the advertised one, which is the
// exemption the detached-reference message already states. Keeping them out of
// the run leaves “the previous role centers on hardware” alone.
const CONTRASTED_REFERENT_WORDS = 'same|other|another|previous|prior|former|earlier|latter|current|next|last|old|original|first|second|third';
const modifierRun = (limit, extraStops = '') => {
  const stops = extraStops ? `${PHRASE_BREAKING_WORDS}|${extraStops}` : PHRASE_BREAKING_WORDS;
  return `(?:(?!(?:${stops})\\b)[\\p{L}\\p{N}][\\p{L}\\p{N}'-]*\\s+){0,${limit}}`;
};
const roleModifierRun = limit => modifierRun(limit, CONTRASTED_REFERENT_WORDS);
// A preposition directly in front of the phrase makes it that preposition's
// object, so the verb after it belongs to an earlier subject: “my
// understanding of the role is …” and “I asked about the position's on-call
// expectations” say nothing about what the advertised position requires.
const OBJECT_GOVERNING_PREPOSITIONS = 'of|to|for|in|into|on|onto|at|with|without|about|from|within|across|toward|towards|through|throughout|by|as|than|like|beyond|under|underneath|over|above|below|during|against|regarding|concerning|per|upon|behind|between|among|amongst|around|alongside|beside|besides|despite|except|excepting|including|near|outside|inside|via|versus|amid|atop|off|since|until|unlike';
const SUBJECT_POSITION = `(?<!\\b(?:${OBJECT_GOVERNING_PREPOSITIONS})\\s)`;
const POSTING_REFERENCE_PATTERN = new RegExp(`\\b(?:your|the|this)\\s+${modifierRun(3)}(?:job\\s+)?(?:posting|advert(?:isement)?)\\b|\\bjob\\s+ad\\b|\\bas\\s+advertised\\b`, 'giu');
// The sanctioned attribution form and the bare one it is distinguished from
// stay anchored to the sentence opening, because that rule is about how a
// sentence opens — but the sanctioned form accepts the same modifiers the
// reference pattern now reads, so “The recent job posting describes …” is not
// rejected for a word the exception cannot see. The bare form excludes the
// specificity words instead: “job”, “role” or “position” in front of
// “listing” is exactly the naming this observation asks for.
const SOURCE_DOCUMENT_ATTRIBUTION = new RegExp(`^(?:the|this)\\s+${modifierRun(3)}(?:(?:job|role|position)\\s+)?(?:posting|listing|description|advert(?:isement)?)\\s+(?:describes?|states?|notes?|identifies?|specifies?|indicates?|outlines?|explains?)\\b`, 'iu');
const BARE_LISTING_ATTRIBUTION = new RegExp(`^(?:the|this)\\s+${modifierRun(3, 'job|role|position')}listing\\s+(?:describes?|states?|notes?|identifies?|specifies?|indicates?|outlines?|explains?)\\b`, 'iu');
// The head noun is singular, so only an -s verb form can be its predicate: a
// bare form after it is a noun in a compound (“the position offer”, “the role
// focus”), and reading those as predicates is how an unanchored pattern
// acquires false positives.
const NON_SOURCE_REPORTING_SUBJECT = new RegExp(`${SUBJECT_POSITION}\\b(?:the|this)\\s+${roleModifierRun(5)}(?:role|position|job)\\s+(?:describes|states|says|notes|mentions|indicates|specifies|outlines|explains)\\b`, 'iu');
const DETACHED_TARGET_POSITION = new RegExp(`${SUBJECT_POSITION}\\bthe\\s+${roleModifierRun(5)}(?:role|position)(?:'s|\\s+(?:needs|requires|focuses|centers|involves|offers|calls|is|would|can|will|seeks))\\b`, 'iu');

/** Keeps target-position references proximal and source attribution grammatical. */
export function checkPostingReference(paragraphs = []) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const observations = [];
  for (let index = 0; index < list.length; index++) {
    const seen = new Set();
    for (const sentence of sentences(list[index])) {
      const sourceAttribution = SOURCE_DOCUMENT_ATTRIBUTION.exec(sentence);
      const bareListingAttribution = BARE_LISTING_ATTRIBUTION.exec(sentence);
      if (bareListingAttribution) {
        observations.push(`paragraph ${index + 1} begins with underspecified source attribution (“${boundedDetailValue(bareListingAttribution[0])}”); name this role and its work directly, or, when provenance genuinely matters, say “this job listing” or “this job description”`);
      }
      const invalidSource = NON_SOURCE_REPORTING_SUBJECT.exec(sentence);
      if (invalidSource) {
        observations.push(`paragraph ${index + 1} makes the target position the source of a statement (“${boundedDetailValue(invalidSource[0])}”); make the source document the grammatical subject when attribution is required`);
      }
      const detachedTarget = DETACHED_TARGET_POSITION.exec(sentence);
      if (detachedTarget) {
        observations.push(`paragraph ${index + 1} uses a detached target-position reference where the position states or requires something (“${boundedDetailValue(detachedTarget[0])}”); use a proximal reference for the position attached to this application unless contrasting it with another role`);
      }
      for (const match of sentence.matchAll(POSTING_REFERENCE_PATTERN)) {
        // A leading source attribution owns its reporting verb legitimately.
        // Do not grant the exception to later advertisement references in the
        // same sentence, which still address the source document as an object.
        if (sourceAttribution && Number(match.index) < sourceAttribution[0].length) continue;
        const phrase = normalized(match[0]);
        if (seen.has(phrase)) continue;
        seen.add(phrase);
        observations.push(`paragraph ${index + 1} addresses the advertisement itself (“${boundedDetailValue(match[0])}”); name the employer's need directly unless the sentence is explicitly attributing listing-only context to its source document`);
      }
    }
  }
  return observationResult('posting-reference', observations, MAX_POSTING_REFERENCE_OBSERVATIONS,
    `${list.length} paragraph(s) use proximal target-position references and grammatical source attribution`);
}

// An asserted analogy is a claim the reader is invited to test, and the test
// usually fails: the two domains are never identical. The shared mechanism is
// arguable; the equivalence is not. This family stays small and literal so
// ordinary uses (“translated the requirements”, a mirror in a data pipeline)
// are not swept in. Only the reliable carriers stay. Literal replication
// (“our dashboard mirrors production latency within a second”) and unit
// restatement (“that volume translates to about two hundred tickets a week”)
// state a fact rather than assert an analogy, so “mirrors” is gone entirely
// and “translates to/into” fires only when “directly” makes the claim a
// cross-domain equivalence rather than a conversion.
// One row per carrier, because the cover-letter contract prints this family
// and a writer cannot avoid a construction stated as “no asserted
// equivalence”. `source` is what the check matches and `disclosure` is what
// the prompt prints, so a carrier added here reaches both from one edit and a
// prompt can never name a carrier this table does not read. The frame row
// describes its shape rather than one wording: it spans two clauses, so no
// short phrase can stand for it.
const CLAIMED_EQUIVALENCE_CARRIERS = Object.freeze([
  { disclosure: '“maps onto”, with or without “directly”', source: String.raw`\bmaps?\s+(?:directly\s+)?onto\b` },
  { disclosure: '“translates directly to” or “translates directly into”', source: String.raw`\btranslates?\s+directly\s+(?:to|into)\b` },
  { disclosure: '“is exactly what” or “is precisely what”', source: String.raw`\bis\s+(?:exactly|precisely)\s+what\b` },
  {
    disclosure: '“a/the/another side, form, version, facet, aspect, expression or manifestation of the same … problem, challenge, decision, question or issue”',
    source: String.raw`\b(?:a|the|another)\s+(?:side|form|version|facet|aspect|expression|manifestation)\s+of\s+the\s+same\s+(?:(?:[\p{L}-]+)\s+){0,3}(?:problem|challenge|decision|question|issue)\b`,
  },
  {
    disclosure: 'calling a prior and target domain the same … problem, challenge, decision, question or issue in another/different context, setting, domain, environment, form or guise',
    source: String.raw`\b(?:is|are|represents?|reflects?|recreates?|repeats?)\s+(?:the\s+)?same\s+(?:(?:[\p{L}-]+)\s+){0,3}(?:problem|challenge|decision|question|issue)\s+(?:in|under|within|through)\s+(?:another|a\s+different)\s+(?:context|setting|domain|environment|form|guise)\b`,
  },
  {
    disclosure: 'and calling two things two (or both) answers, responses, sides or forms to one, or to the same, decision, question, call or choice',
    source: String.raw`\b[^.!?]{1,80}\s+and\s+[^.!?]{1,80}\s+are\s+(?:two|both)\s+(?:answers?|responses?|sides?|forms?)\s+(?:to|of)\s+(?:one|the\s+same)\s+(?:(?:[\p{L}-]+)\s+){0,4}(?:decision|question|call|choice)\b`,
  },
]);

// Printed by the cover-letter contract. Derived from the table above for the
// same reason COVER_LETTER_LOGISTICS_PROMISE_CLASSES is: a hand-copied list
// drifts from the patterns that reject the letter.
export const COVER_LETTER_EQUIVALENCE_CARRIERS = CLAIMED_EQUIVALENCE_CARRIERS
  .map(carrier => carrier.disclosure).join(', ');

const CLAIMED_EQUIVALENCE_PATTERN = new RegExp(
  CLAIMED_EQUIVALENCE_CARRIERS.map(carrier => carrier.source).join('|'), 'giu');

/** Flags asserted cross-domain equivalence, not the transfer argument itself. */
export function checkClaimedEquivalence(paragraphs = []) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const observations = [];
  for (let index = 0; index < list.length; index++) {
    const seen = new Set();
    for (const match of text(list[index]).matchAll(CLAIMED_EQUIVALENCE_PATTERN)) {
      const phrase = normalized(match[0]);
      if (seen.has(phrase)) continue;
      seen.add(phrase);
      observations.push(`paragraph ${index + 1} asserts a cross-domain equivalence (“${boundedDetailValue(match[0])}”); name the source-supported transferable capability and explain how its shared mechanism (a constraint, a flow, a decision rule the two domains both rely on) helps with an actual responsibility in the posting, while preserving the boundary between domains`);
    }
  }
  return observationResult('claimed-equivalence', observations, MAX_CLAIMED_EQUIVALENCE_OBSERVATIONS,
    `${list.length} paragraph(s) argue transfer without asserting an equivalence`);
}

// A non-final paragraph must not spend its last sentence announcing a new
// workplace/practice that the next paragraph never develops. This deliberately
// targets the high-confidence generated shape rather than trying to infer the
// topic of every possible final sentence.
const DANGLING_TERMINAL_SYNTHESIS = /^(?:the|this|that)\s+(?:boundary|practice|approach|discipline|experience|judgment|work|decision)\b[^.!?]{0,120}\b(?:also\s+)?(?:shaped|informed|guided)\s+how\s+i\s+(?:used|approached|handled|worked)\b[^.!?]{0,180}\b(?:at|in)\s+[^.!?]+[.!?]?$/iu;

/** Rejects a paragraph-final topic launch that is neither developed nor carried forward. */
export function checkDanglingParagraphTransition(paragraphs = []) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const observations = [];
  for (let index = 0; index < list.length - 1; index++) {
    const finalSentence = sentences(list[index]).at(-1) || '';
    const match = DANGLING_TERMINAL_SYNTHESIS.exec(text(finalSentence));
    if (!match) continue;
    observations.push(`paragraph ${index + 1} ends by launching an undeveloped topic (“${boundedDetailValue(finalSentence)}”); develop the concrete mechanism or result in that paragraph, carry the exact subject into the next paragraph, or remove the sentence`);
  }
  return observationResult('dangling-paragraph-transition', observations, MAX_COPY_PRECISION_OBSERVATIONS,
    `${list.length} paragraph(s) conclude their own point or explicitly carry the next subject forward`);
}

/**
 * The prompt asks for short causal sentences and the model still produced a
 * 62-word sentence with nested purpose clauses. The threshold is deliberately
 * far above ordinary long-sentence advice: this is a runaway-clause detector,
 * not a readability score, so a well-built 30-word sentence is never revision
 * work.
 */
export function checkSentenceLength(paragraphs = []) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const observations = [];
  for (let index = 0; index < list.length; index++) {
    for (const sentence of sentences(list[index])) {
      const count = wordCount(sentence);
      if (count <= MAX_SENTENCE_WORDS) continue;
      observations.push(`paragraph ${index + 1} contains a ${count}-word sentence beginning “${leadingWordsSnippet(sentence)}”; split it into short causal sentences`);
    }
  }
  return observationResult('sentence-length', observations, MAX_SENTENCE_LENGTH_OBSERVATIONS,
    `${list.length} paragraph(s) keep every sentence under ${MAX_SENTENCE_WORDS + 1} words`);
}

// Range semantics come from the dependency-free dashRanges.js grammar shared
// with the document hard gate. A softer cover-letter rule must not send a
// shipping-safe range back for revision.

/**
 * Every dash form the document gate rejects, so each one becomes a revisable
 * observation instead of a thrown build. The spaced hyphen matters most: the
 * gate's own test is exactly /\s-\s/, and a letter carrying one used to reach
 * buildApplicationDocument() with no observation to repair it, failing the
 * whole application over a punctuation defect one revision would have fixed.
 */
function hasDashSplice(raw) {
  if (raw.includes('—') || /\s-\s/u.test(raw)) return true;
  if (/(?:[\p{L}\p{N}]|\s)--(?:[\p{L}\p{N}]|\s)/u.test(raw)) return true;
  for (let index = raw.indexOf('–'); index !== -1; index = raw.indexOf('–', index + 1)) {
    if (!enDashIsRange(raw, index)) return true;
  }
  return false;
}

/**
 * House register: short declarative sentences, no semicolons and no dashes as
 * clause splices. These marks read as generated prose to this user. Colons are
 * allowed again (user decision, 2026-10-20). Each observation mirrors a
 * rejection in the document hard gate (assertCandidateDashPunctuation).
 *
 * This is the one check that must read the RAW paragraph string: text()
 * normalizes every dash glyph to '-', which would erase exactly the
 * distinction being made here.
 */
export function checkPunctuationStyle(paragraphs = []) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const observations = [];
  for (let index = 0; index < list.length; index++) {
    const raw = String(list[index] ?? '');
    // One observation per paragraph and kind: the repair is the same for the
    // whole paragraph, so repeating it per mark would only crowd the prompt.
    if (raw.includes(';')) {
      observations.push(`paragraph ${index + 1} uses a semicolon; split the clause into two short sentences`);
    }
    if (hasDashSplice(raw)) {
      observations.push(`paragraph ${index + 1} uses a dash as a clause splice; restructure into separate sentences or a comma`);
    }
  }
  return observationResult('punctuation-style', observations, MAX_PUNCTUATION_OBSERVATIONS,
    `${list.length} paragraph(s) avoid semicolons and dash splices`);
}

// Passport-desk register in a letter that is otherwise first-person prose.
// Two fixed formulas rather than an attempt to score formality: each one has a
// plain first-person rewrite, which is the repair the observation asks for.
const PLAIN_REGISTER_PATTERNS = Object.freeze([
  /\bin\s+possession\s+of\b/iu,
  /\bpossess(?:es)?\s+a\s+valid\b/iu,
]);

/** Keeps any remaining factual prose direct rather than officialese. */
export function checkPlainRegister(paragraphs = []) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const observations = [];
  for (let index = 0; index < list.length; index++) {
    const paragraph = text(list[index]);
    const answeredGap = /\banswer(?:ed|ing|s)?\s+(?:that|this|the|a)\s+gap\b/iu.exec(paragraph);
    if (answeredGap) {
      observations.push(`paragraph ${index + 1} uses unnatural wording (“${boundedDetailValue(answeredGap[0])}”); use “closed the gap” or “addressed the gap”`);
    }
    const evidenceBring = /\b(?:are|is) the evidence I would bring\b/iu.exec(paragraph);
    if (evidenceBring) {
      observations.push(`paragraph ${index + 1} treats capabilities as “${boundedDetailValue(evidenceBring[0])}”; say what experience, skills, or work the candidate would bring`);
    }
    for (const pattern of PLAIN_REGISTER_PATTERNS) {
      const match = pattern.exec(paragraph);
      if (!match) continue;
      observations.push(`paragraph ${index + 1} uses bureaucratic register (“${boundedDetailValue(match[0])}”); state the fact in plain first-person English`);
    }
  }
  return observationResult('plain-register', observations, MAX_PLAIN_REGISTER_OBSERVATIONS,
    `${list.length} paragraph(s) use direct, non-bureaucratic prose`);
}

// A sentence-initial workplace phrase followed directly by “I” needs a comma
// to keep the organization and the subject from running together. The generic
// lexicon covers organization types, while supplied résumé employers cover
// proper names without teaching the check one candidate's domain vocabulary.
// Ordinary short adjuncts remain outside this high-confidence check.
const INTRODUCTORY_WORKPLACE_COMMA = /^(At\s+(?:(?:the|my|our)\s+)?(?:[\p{L}&.'’()-]+\s+){0,5}(?:district|company|organisation|organization|agency|school|university|college|employer|office|firm|department|ministry|council|bank|hospital|clinic|laboratory|lab|startup|team))\s+I\b/iu;

/** Sets off a sentence-initial workplace phrase when the first-person subject follows. */
export function checkIntroductoryWorkplaceComma(paragraphs = [], workplaceNames = []) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const namedWorkplaces = (Array.isArray(workplaceNames) ? workplaceNames : [])
    .map(text).filter(Boolean).sort((left, right) => right.length - left.length)
    .map(name => new RegExp(`^(At\\s+${escapeRegExp(name)})\\s+I\\b`, 'iu'));
  const observations = [];
  for (let index = 0; index < list.length; index++) {
    for (const sentence of sentences(list[index])) {
      const genericMatch = INTRODUCTORY_WORKPLACE_COMMA.exec(sentence);
      const namedMatch = namedWorkplaces.map(pattern => pattern.exec(sentence)).find(Boolean);
      const phrase = genericMatch?.[1] || namedMatch?.[1];
      if (!phrase) continue;
      observations.push(`paragraph ${index + 1} begins a sentence “${leadingWordsSnippet(sentence, 7)}” without setting off the introductory workplace phrase; insert a comma after “${boundedDetailValue(phrase)}”`);
    }
  }
  return observationResult('introductory-workplace-comma', observations, MAX_COPY_PRECISION_OBSERVATIONS,
    `${list.length} paragraph(s) set off sentence-initial workplace phrases before “I”`);
}

// In UI-guidance prose, bare “point” is ambiguous: one can point in the
// metaphorical sense of referring to something. The limitation being argued is
// visible on-screen indication, so require that distinction wherever a
// sentence says an actor cannot point at a concrete UI target. No actor is
// named here: any subject (a person, a guide, a tool) can be the one that
// cannot indicate the control.
const BARE_UI_POINT = /\b(?:cannot|can't)\s+(?!visually\b)(?:physically\s+)?(?:point|gesture)(?:\s+(?:at|to)\s+(?:the\s+)?|\s+out\s+(?:which\s+|the\s+))(?:control|button|field|menu|icon|element|link|tab|toggle|checkbox|input|panel|dialog|window|option|area|region|part)\b/iu;

/** Distinguishes a visible UI indication from metaphorical reference. */
export function checkVisualReferencePrecision(paragraphs = []) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const observations = [];
  for (let index = 0; index < list.length; index++) {
    for (const sentence of sentences(list[index])) {
      const match = BARE_UI_POINT.exec(sentence);
      if (!match) continue;
      observations.push(`paragraph ${index + 1} says “${boundedDetailValue(match[0])}”; name the literal limitation as an inability to visually indicate the on-screen control, not a bare inability to “point”`);
    }
  }
  return observationResult('visual-reference-precision', observations, MAX_COPY_PRECISION_OBSERVATIONS,
    `${list.length} paragraph(s) distinguish visible UI indication from metaphorical reference`);
}

// “I would welcome the chance …” is polite boilerplate that weakens the last
// line with an unnecessary conditional. This check is intentionally limited
// to that stock cover-letter formula; other valid uses of “would welcome” are
// not rewritten by a general lexical ban.
//
// Both alternatives share one contraction shape, and only the first used to
// spell it correctly: `I(?:\s+would|'d)` requires a space before "would" but
// none before "'d", because the contraction attaches straight to "I" with no
// space of its own. The second alternative was written `I\s+(?:would|'d)`,
// which forces that same space in front of "'d" too — a space "I'd be glad to
// discuss…" never has — so the contraction silently passed this check while
// "I would be glad to discuss…" was caught right beside it.
const CONDITIONAL_WELCOME_CLOSE = /\bI(?:\s+would|'d)\s+welcome\s+(?:(?:the\s+)?(?:chance|opportunity)|(?:a\s+)?(?:conversation|discussion))\b|\bI(?:\s+would|'d)\s+be\s+(?:glad|happy|pleased)\s+to\s+(?:discuss|talk|speak|connect|share|explore)\b/iu;

// A closing can be grammatically direct yet still leave the reader with only
// the writer's wish to have a conversation or learn more. Keep this family
// deliberately bounded to first-person intention/desire plus a conversational
// or learning endpoint. It does not judge ordinary uses of want/hope/plan, or
// invitations that occur before the final sentence of the letter.
const SELF_DIRECTED_CONVERSATION_CLOSE = /\bI\s+(?:want|hope|plan|aim|intend)\s+to\s+(?:talk|speak|discuss|connect|learn|explore)\b/iu;
const LOOK_FORWARD_CONVERSATION_CLOSE = /\bI\s+look\s+forward\s+to\s+(?:talking|speaking|discussing|connecting|learning|exploring)\b/iu;
const DIRECT_CONVERSATION_CLOSE = /\bI\s+welcome\s+(?:(?:(?:the\s+)?(?:chance|opportunity))\s+to\s+(?:talk|speak|discuss|connect|share|explore)|(?:a\s+)?(?:conversation|discussion)\b)/iu;
const EMPLOYER_CHOICE_CLOSE = /\b(?:conversation|discussion)\s+about\s+whether\b[^.!?]{0,180}\b(?:or|versus)\b/iu;

// checkProspectiveContributionTense's own design note records that a
// modal-only guard "measurably rejected" a present-tense contribution bridge
// — the reason CONTRIBUTION_VERBS_PRESENT exists on checkDirectWelcomeClosing.
// That made the two checks pull in opposite directions on the identical
// sentence: "I welcome the chance to talk about how my <domain> experience
// helps me contribute to your <team>." passes checkDirectWelcomeClosing
// (it is exactly the direct, present-tense, three-half invitation that check
// certifies) and fails checkProspectiveContributionTense (its present-tense
// "helps me contribute" bridge is the shape NONCONDITIONAL_PROSPECTIVE_
// CONTRIBUTION exists to catch). Once one check has certified a sentence as a
// direct closing invitation, the other must not then reject it for using the
// present tense that certification requires. Scoped to the four closing-
// invitation shapes in the FINAL paragraph only, not to "present tense in the
// closing paragraph" generally: an ordinary present-tense readiness bridge
// that is not one of these certified invitation shapes — the exact thing this
// check exists to catch — must still be caught even in the last paragraph.
//
// LOOK_FORWARD_CONVERSATION_CLOSE belongs in this list for the same reason
// SELF_DIRECTED_CONVERSATION_CLOSE does: checkDirectWelcomeClosing's own
// selfDirectedMatch already ORs the two together (one certifying branch, not
// two), so a closing certified via "I look forward to discussing ..." was
// being rejected right back by this function for the identical present-tense
// bridge its own certifying branch requires — the exact two-checks-pulling-
// opposite-ways bug this whole certifiedClosingInvitation function exists to
// prevent, reproduced by omission.
function certifiedClosingInvitation(value) {
  return CONDITIONAL_WELCOME_CLOSE.test(value)
    || DIRECT_CONVERSATION_CLOSE.test(value)
    || SELF_DIRECTED_CONVERSATION_CLOSE.test(value)
    || LOOK_FORWARD_CONVERSATION_CLOSE.test(value);
}

// A future-facing discussion can be an effective close when it makes the
// candidate's contribution concrete. Two independent conditions, because the
// contract (STYLE.md §11.2, SKILL.md, and the routine, which all say to apply
// this "as a register rule, not as a template for the closing sentence") asks
// for a connection, not a word order:
//
//   1. the closing names an asset the candidate demonstrably owns, and
//   2. it points that asset at the employer's work.
//
// Requiring one fused `my … <modal> <verb>` pattern made the check a template
// after all: “applying my <domain> experience to the <systems> this role
// owns” and “the <artifact> work I built would fit the <systems> this team
// runs” are exactly the closings the guidance asks for, and both were rejected.
// Ownership still has to be explicit — a bare demonstrative (“that work”)
// leans on an earlier paragraph instead of standing up in the invitation.
// "knowledge"/"know-how" widen the asset lexicon for a candidate paraphrasing
// to avoid repeating "experience" a second time in the same letter —
// checkRepeatedPhrase already pushes a writer toward exactly that paraphrase
// once "experience" has been used once, so the asset lexicon has to accept
// the word that pressure produces.
const CANDIDATE_ASSET_NOUNS = 'experience|expertise|skills?|work|background|perspective|practice|training'
  + '|knowledge|know-how';
// Concrete artifact nouns a candidate plausibly built and would name with "the
// <noun> I built/wrote/…": app, application, dashboard, parser, extractor,
// renderer, agent, and api cover common candidate-built shapes the prior list
// missed. This branch still requires the authorship clause immediately after
// the noun, so widening the noun list alone cannot admit an employer-owned
// artifact the candidate merely used.
const CANDIDATE_ARTIFACT_NOUNS = 'server|service|tool|tooling|pipeline|pipelines|integration|integrations'
  + '|connector|connectors|system|systems|harness|platform|prototype|library|scraper|model'
  + '|app|application|dashboard|parser|extractor|renderer|agent|api';
// Three ways to mark an asset as the candidate's, in decreasing explicitness:
// a possessive; an authorship clause; or a demonstrative that carries its own
// descriptor. The third exists because “that <domain> experience” does name
// the asset — it is a bare demonstrative (“that work”) that names nothing and
// leans entirely on an earlier paragraph, so the descriptor is required.
// Demonstratives only, never “the”: “the engineering practice this team uses”
// is employer-facing, and accepting it would make the guard meaningless.
// The demonstrative branch is also restricted to ASSET nouns — artifact nouns
// (systems, pipelines, integrations) are usually the EMPLOYER's in a closing.
// The descriptor slot counts words, so it needs a floor on what counts as a
// descriptor: "that kind of work" leans on an earlier paragraph exactly as much
// as "that work" does. The floor is on the HEAD modifier — the token attached
// to the asset noun — not on the first token, because "that broader kind of
// work" is just as vacuous while "that same-day <domain> experience" is not.
// A light-noun frame always puts `of` or a light noun in the head position.
const DESCRIPTOR_FILLERS = 'of|kind|kinds|sort|sorts|type|types|phase|part|parts|area|areas|line|piece'
  + '|bit|amount|next|same|other|others|more|much|such|that|this';
// The verbs that make “the <artifact> I <verb>” an authorship clause. One list,
// read by the fixed-noun branch below, by the letter-used-noun branch after it and
// by the guidance a writer is shown, so the three can never name different verbs.
export const CANDIDATE_AUTHORSHIP_VERBS = Object.freeze(['built', 'wrote', 'designed', 'created', 'developed', 'shipped', 'led', 'own', 'owned', 'maintained', 'architected']);
// The authorship verbs that are also proof verbs (PAST_PROOF_VERBS): a first-person clause with one of
// them is a completed action of the candidate, which makes the paragraph that holds it proof-bearing.
const CLOSING_AUTHORSHIP_PROOF_VERBS = Object.freeze(CANDIDATE_AUTHORSHIP_VERBS.filter(verb => PAST_PROOF_VERBS.includes(verb)));
const CANDIDATE_ASSET_CLOSE = new RegExp(
  `\\bmy\\s+(?:[\\p{L}’'-]+\\s+){0,3}(?:${CANDIDATE_ASSET_NOUNS})\\b`
  + `|\\bthe\\s+(?:[\\p{L}’'-]+\\s+){0,3}(?:${CANDIDATE_ASSET_NOUNS}|${CANDIDATE_ARTIFACT_NOUNS})\\s+I\\s+`
  + `(?:${CANDIDATE_AUTHORSHIP_VERBS.join('|')})\\b`
  + `|\\b(?:that|this|those|these)\\s+(?:[\\p{L}’'-]+\\s+){0,2}(?!(?:${DESCRIPTOR_FILLERS})\\s)[\\p{L}’'-]+\\s+(?:${CANDIDATE_ASSET_NOUNS})\\b`,
  'iu',
);
// The authorship clause above accepts only the artifact nouns listed in
// CANDIDATE_ARTIFACT_NOUNS, and no list reaches every field: a closing built on
// the strongest thing the candidate made (“the <noun> I built”) was rejected
// whenever that noun was not one of about twenty-five words, although the clause
// itself already proves the candidate says they built it. The list is not
// lengthened. The same clause is also accepted when its noun is one the LETTER
// has already used for the candidate's own work, so a closing can refer back to
// what the letter showed:
//   - the head noun of the object of an earlier first-person sentence whose verb
//     is an authorship verb (“I built a <modifiers> <noun> that …”), or
//   - the head noun of the object of such a verb in a career-data quote one of the
//     letter's paragraphs cites (a quote is verb-led: “Built a <noun> …”).
// The head is the last word of the object phrase before the first preposition,
// relative word or conjunction, so “I built a board that replaced the sheet”
// licenses “the board I built” and not “the sheet I built”. A closing that names
// something the letter never said it made (rename the artifact and it is rejected
// again), a bare pronoun or a light noun (“the one I built”) names nothing and
// never counts, and every other part of the closing check is unchanged.
//
// What is read is the DIRECT object of the verb and nothing else. Three things the
// first version read as an object are not one:
//   - “that” in front of a noun is a determiner (“I built that <noun> with …”), and
//     it is a relative or complementizer only when what follows is a verb, a
//     subject pronoun, an article or the end of the clause (“I built that replaced
//     …”, “I wrote that the …”), so a demonstrative object licenses its noun;
//   - a coordinated chunk is an object only when it is a plain noun phrase: a chunk
//     that opens with a subject pronoun, holds a finite verb (a participle that is
//     not followed by “by”, an auxiliary, a plural or third-person -s word before
//     the last) or starts a second noun phrase after its noun is a new clause with
//     its own subject, and it ends the reading (“I built the <noun>, and the
//     drivers loved the result” licenses the first noun only);
//   - “I built” inside a relative clause has no object after it (“the <noun> I
//     built reduced empty trips”): the noun before it is the thing built, and the
//     words after the verb belong to the main clause.
// Anything the reading cannot place licenses nothing, so a doubtful shape costs the
// writer one rejection that says how to name the asset, never an authorship claim
// the letter did not make.
const AUTHORSHIP_VERB_FORMS = 'build|builds|built|building|wrote|write|writes|writing|written|design|designs|designed|designing'
  + '|create|creates|created|creating|develop|develops|developed|developing|ship|ships|shipped|shipping'
  + '|lead|leads|led|leading|own|owns|owned|owning|maintain|maintains|maintained|maintaining'
  + '|architect|architects|architected|architecting';
const AUTHORED_OBJECT_STOP_WORDS = new Set([
  'for', 'to', 'in', 'on', 'at', 'with', 'by', 'from', 'into', 'of', 'that', 'which', 'who', 'whom', 'whose', 'so', 'because', 'while',
  'when', 'where', 'as', 'using', 'through', 'across', 'after', 'before', 'during', 'than', 'within', 'over', 'under', 'between', 'per',
  'via', 'until', 'about', 'against', 'around', 'then', 'if', 'is', 'are', 'was', 'were',
]);
// Words that can end an object phrase without naming anything: pronouns and the
// light nouns DESCRIPTOR_FILLERS already treats as vacuous.
const VACUOUS_AUTHORED_HEADS = new Set([
  'it', 'them', 'one', 'ones', 'thing', 'things', 'something', 'everything', 'anything', 'part', 'parts', 'piece', 'pieces', 'kind', 'kinds',
  'sort', 'sorts', 'type', 'types', 'bit', 'amount', 'area', 'areas', 'this', 'that', 'these', 'those', 'same', 'other', 'others', 'more', 'much', 'such',
  // Nouns a relative clause hangs on without naming anything the candidate made.
  'fact', 'idea', 'reason', 'way', 'time', 'day', 'year', 'week', 'month', 'what', 'which',
]);
const AUTHORED_ARTIFACT_CLOSE = new RegExp(
  `\\bthe\\s+(?:[\\p{L}’'-]+\\s+){0,3}([\\p{L}’'-]+)\\s+I\\s+(?:${CANDIDATE_AUTHORSHIP_VERBS.join('|')})\\b`,
  'giu',
);
const FIRST_PERSON_AUTHORSHIP = new RegExp(`\\b(?:i|we)\\s+(?:(?:have|has|had|also|then|later|personally)\\s+){0,2}(?:${AUTHORSHIP_VERB_FORMS})\\b`, 'giu');
const ANY_AUTHORSHIP = new RegExp(`\\b(?:${AUTHORSHIP_VERB_FORMS})\\b`, 'giu');

function authoredNounKey(word) {
  const key = normalizedArgumentTerm(String(word || '').toLowerCase().replace(/['’]s$/u, ''));
  // normalizedArgumentTerm leaves a four-letter plural alone (“hubs”, “maps”), so a
  // letter that built “hubs” would not license “the hub I built”.
  return key.length === 4 && /s$/u.test(key) && !/(?:ss|us|is)$/u.test(key) ? key.slice(0, -1) : key;
}

const AUTHORED_OBJECT_DETERMINERS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'our', 'their', 'its', 'his', 'her', 'your', 'each', 'every', 'all', 'both',
  'some', 'any', 'several', 'many', 'two', 'three', 'four', 'five', 'six',
]);

// Words the object reading below tells apart. Articles and possessives begin a noun
// phrase, so one that turns up after the noun starts a second noun phrase (a reduced
// relative or a new clause); the other determiners (“each”, “three”) may follow an
// adjective (“the first three dashboards”) and do not.
const AUTHORED_ARTICLES = new Set(['a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'our', 'your', 'their', 'its', 'his', 'her']);
const AUTHORED_SUBJECT_PRONOUNS = new Set(['i', 'we', 'you', 'they', 'he', 'she', 'it', 'who']);
// Auxiliaries and the plainest irregular past tenses: a noun phrase that runs into one
// has met the verb of a clause of its own.
const AUTHORED_CLAUSE_VERBS = new Set([
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had', 'will', 'would', 'can', 'could', 'should', 'may', 'might', 'must', 'shall',
  'does', 'did', 'do', 'got', 'took', 'made', 'ran', 'went', 'came', 'gave', 'found', 'kept', 'held', 'said', 'began', 'chose', 'drove', 'told',
  'knew', 'felt', 'thought', 'met', 'paid', 'sent', 'sold', 'stood', 'taught', 'brought', 'bought', 'caught', 'became',
]);
const AUTHORED_RELATIVE_PRONOUNS = new Set(['that', 'which', 'whom']);
// A noun phrase after one of these is the object of a preposition, and “I built” that
// follows it starts the main clause (“At the depot I built a …”).
const AUTHORED_PREPOSITIONS = new Set([
  'for', 'to', 'in', 'on', 'at', 'with', 'by', 'from', 'into', 'of', 'as', 'through', 'across', 'after', 'before', 'during', 'within', 'over', 'under',
  'between', 'per', 'via', 'until', 'about', 'against', 'around', 'since', 'throughout', 'despite', 'beyond', 'among', 'toward', 'towards', 'upon',
  'onto', 'near', 'behind', 'outside', 'inside', 'without', 'like', 'amid', 'beside', 'except', 'following', 'including', 'regarding',
]);
// A time phrase opens a sentence without being something built (“This summer I built …”).
const AUTHORED_TIME_NOUNS = new Set([
  'day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years', 'quarter', 'quarters', 'season', 'seasons', 'summer', 'winter', 'spring',
  'autumn', 'fall', 'semester', 'term', 'decade', 'time', 'times', 'morning', 'mornings', 'evening', 'evenings', 'night', 'nights', 'afternoon',
  'shift', 'shifts', 'period', 'stint', 'tenure', 'phase',
]);
const AUTHORSHIP_VERB_WORDS = new Set(AUTHORSHIP_VERB_FORMS.split('|'));
const AUTHORED_TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}’'-]*|,/gu;
const MAX_AUTHORED_OBJECTS = 4;
const MAX_AUTHORED_PHRASE_WORDS = 6;

const isAuthoredCoordinator = token => token === ',' || /^(?:and|or)$/iu.test(token);
// A past participle or a simple past (“used”, “reviewed”): a hyphenated compound is a modifier and is never one.
const isAuthoredParticiple = word => !word.includes('-') && word.length >= 4 && /[^aeiou]ed$/iu.test(word) && !/^(?:shed|sled|bred|fled|sped)$/iu.test(word);
const isAuthoredPluralOrThirdPerson = word => /s$/u.test(word) && !/(?:ss|us|is)$/u.test(word) && !word.includes('-');

// Does a “that” at the start of an object phrase determine a noun that follows (“that hub with …”)?
// It does not when what follows is a verb, a subject pronoun, an article, a preposition or the end of
// the clause: there it is a relative pronoun, a complementizer or a bare pronoun object.
function demonstrativeBeginsObject(tokens, at) {
  const next = tokens[at + 1];
  if (!next || next === ',') return false;
  const lower = next.toLowerCase();
  if (AUTHORED_SUBJECT_PRONOUNS.has(lower) || AUTHORED_ARTICLES.has(lower) || AUTHORED_CLAUSE_VERBS.has(lower)
    || AUTHORED_OBJECT_STOP_WORDS.has(lower) || isAuthoredCoordinator(lower)) return false;
  if (isAuthoredParticiple(lower)) {
    const after = tokens[at + 2]?.toLowerCase();
    if (after === undefined || after === ',' || AUTHORED_ARTICLES.has(after) || AUTHORED_SUBJECT_PRONOUNS.has(after)
      || after === 'them' || after === 'all' || after === 'both' || AUTHORED_OBJECT_STOP_WORDS.has(after) || isAuthoredCoordinator(after)) return false;
  }
  return true;
}

// One noun phrase from `start`, up to a coordinator, a stop word, an auxiliary, a second article or
// the sixth word. Returns the words, the participle bookkeeping the head choice needs, and what ended it.
function readAuthoredObjectPhrase(tokens) {
  const phrase = [];
  let beforeParticiple = '';
  let participleAt = -1;
  let end = 'end';
  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at];
    const lower = token.toLowerCase();
    if (isAuthoredCoordinator(token)) { end = 'coordinator'; break; }
    if (!phrase.length && lower === 'that' && demonstrativeBeginsObject(tokens, at)) { phrase.push(token); continue; }
    if (AUTHORED_OBJECT_STOP_WORDS.has(lower)) { end = AUTHORED_CLAUSE_VERBS.has(lower) ? 'clause' : 'stop'; break; }
    if (AUTHORED_CLAUSE_VERBS.has(lower)) { end = 'clause'; break; }
    if (phrase.length >= MAX_AUTHORED_PHRASE_WORDS) { end = 'stop'; break; }
    if (AUTHORED_ARTICLES.has(lower) && phrase.some(word => !AUTHORED_OBJECT_DETERMINERS.has(word.toLowerCase()))) { end = 'article'; break; }
    if (!beforeParticiple && lower.length >= 4 && /(?:ed|ing)$/u.test(lower) && phrase.some(word => !AUTHORED_OBJECT_DETERMINERS.has(word.toLowerCase()))) {
      beforeParticiple = phrase.at(-1);
      participleAt = phrase.length;
    }
    phrase.push(token);
  }
  return { phrase, beforeParticiple, trailingParticiple: participleAt >= 0 && participleAt === phrase.length - 1, end };
}

// A coordinated chunk that holds a clause of its own: a finite verb sits inside it (a participle that
// is not followed by “by”, or a plural or third-person -s word that is not the last), so the nouns
// around that verb are not objects of the authorship verb.
function authoredChunkHasClause(phrase) {
  return phrase.some((word, index) => {
    const lower = word.toLowerCase();
    if (index > 0 && isAuthoredParticiple(lower) && phrase[index + 1]?.toLowerCase() !== 'by') return true;
    return index < phrase.length - 1 && isAuthoredPluralOrThirdPerson(lower) && !AUTHORED_ARTICLES.has(lower) && !AUTHORED_OBJECT_DETERMINERS.has(lower);
  });
}

function pushAuthoredHeads(phrase, beforeParticiple, trailingParticiple, heads) {
  for (const candidate of [trailingParticiple ? '' : phrase.at(-1), beforeParticiple]) {
    const word = String(candidate || '');
    if (!word || AUTHORED_OBJECT_DETERMINERS.has(word.toLowerCase())) continue;
    const key = authoredNounKey(word);
    if (key.length >= 3 && !VACUOUS_AUTHORED_HEADS.has(key)) heads.push(key);
  }
}

// Is “I built” (the words before it are `before`, the clause after the verb is `rest`) a relative clause
// that modifies a noun, as in “the hub I built reduced onboarding time” or “hubs that I built”? Then that
// noun is the thing built and the words after the verb belong to the main clause. Returns the noun, or
// null when the verb has an object of its own: an article or quantifier right after it, a comma or a
// preposition phrase before it (“At the depot I built …”), a time phrase (“This summer I built …”),
// or no noun phrase before it at all.
function authoredRelativeAntecedent(before, rest) {
  const restLead = (rest.match(/[\p{L}\p{N}][\p{L}\p{N}’'-]*/u) || [''])[0].toLowerCase();
  if (AUTHORED_ARTICLES.has(restLead) || AUTHORED_OBJECT_DETERMINERS.has(restLead)) return null;
  const tokens = (before.split(/[;:()]|\s-+\s/u).at(-1) || '').match(AUTHORED_TOKEN_RE) || [];
  const last = tokens.at(-1);
  if (!last || last === ',') return null;
  const marked = AUTHORED_RELATIVE_PRONOUNS.has(last.toLowerCase());
  let headAt = tokens.length - (marked ? 2 : 1);
  if (marked && tokens[headAt] === ',') headAt -= 1;
  const head = tokens[headAt];
  const headLower = String(head || '').toLowerCase();
  if (!head || !/^\p{L}/u.test(head) || AUTHORED_OBJECT_STOP_WORDS.has(headLower) || AUTHORED_ARTICLES.has(headLower)
    || AUTHORED_CLAUSE_VERBS.has(headLower) || AUTHORED_OBJECT_DETERMINERS.has(headLower)) return null;
  let determinerAt = -1;
  for (let at = headAt - 1; at >= 0 && at >= headAt - 4; at -= 1) {
    const lower = tokens[at].toLowerCase();
    if (AUTHORED_ARTICLES.has(lower) || AUTHORED_OBJECT_DETERMINERS.has(lower)) { determinerAt = at; break; }
    if (tokens[at] === ',' || AUTHORED_OBJECT_STOP_WORDS.has(lower) || AUTHORED_CLAUSE_VERBS.has(lower) || isAuthoredCoordinator(tokens[at])) break;
  }
  // With an explicit relative pronoun a noun phrase needs a determiner or a plural head (“hubs that I built”).
  if (marked) return determinerAt >= 0 || isAuthoredPluralOrThirdPerson(headLower) ? head : null;
  if (determinerAt < 0 || AUTHORED_TIME_NOUNS.has(headLower)) return null;
  const lead = tokens[determinerAt - 1]?.toLowerCase();
  return lead && (AUTHORED_PREPOSITIONS.has(lead) || /ing$/u.test(lead)) ? null : head;
}

// The heads of the noun phrases that follow one authorship verb, `rest` being the clause after it.
// The first chunk is the verb's object; later chunks (after a comma, “and” or “or”) are coordinated
// objects, a coordinated authorship verb with its own object, or the start of a new clause, which
// ends the reading. An object that a preposition, a relative word or a second noun phrase ends is the
// last one read.
function authoredDirectObjectHeads(rest) {
  const tokens = rest.match(AUTHORED_TOKEN_RE) || [];
  const chunks = [[]];
  for (const token of tokens) {
    if (isAuthoredCoordinator(token)) chunks.push([]); else chunks.at(-1).push(token);
  }
  const heads = [];
  // A verb followed at once by a coordinator shares the object of the verb that ends the chain:
  // “I built, tested and deployed a hub”.
  let chain = chunks[0].length === 0 && chunks.length > 1;
  let read = 0;
  for (let index = 0; index < chunks.length && read < MAX_AUTHORED_OBJECTS; index += 1) {
    let chunk = chunks[index];
    if (!chunk.length) continue;
    const lead = chunk[0].toLowerCase();
    if (index > 0) {
      if (AUTHORED_SUBJECT_PRONOUNS.has(lead)) break;
      const startsNounPhrase = AUTHORED_ARTICLES.has(lead) || AUTHORED_OBJECT_DETERMINERS.has(lead);
      if (AUTHORSHIP_VERB_WORDS.has(lead) || (chain && !startsNounPhrase)) {
        // A coordinated verb: a lone one passes the object on, one with words after it takes them.
        if (chunk.length === 1) continue;
        chunk = chunk.slice(1);
      } else if (isAuthoredParticiple(lead) && chunk.length > 1) continue;
    }
    read += 1;
    const { phrase, beforeParticiple, trailingParticiple, end } = readAuthoredObjectPhrase(chunk);
    if (index > 0 && (end === 'clause' || authoredChunkHasClause(phrase))) break;
    pushAuthoredHeads(phrase, beforeParticiple, trailingParticiple, heads);
    if (end !== 'end') break;
    chain = false;
  }
  return heads;
}

/**
 * The head nouns of the objects an authorship verb takes in `value`. With
 * `firstPersonOnly` the verb must follow I or we (a sentence of the letter);
 * without it any occurrence counts (a verb-led quote). Bounded: at most four
 * coordinated objects per verb, six words per object.
 *
 * The head is the last word of the object phrase. A participle that follows a
 * noun begins a reduced relative clause (“a chart used by every crew”,
 * “dashboards tracking daily sales”), so the word before it is the head too;
 * both candidates are kept, because a participle that opens a phrase (“a
 * ripening chart”) is a modifier and the last word is then the head. A
 * participle that ends the phrase is never a head itself.
 *
 * Only the direct object is read (see the comment above AUTHORSHIP_VERB_FORMS
 * for what that excludes): a relative clause (“the hub I built …”) licenses the
 * noun it modifies and nothing after the verb.
 */
function authoredObjectHeads(value, { firstPersonOnly }) {
  const heads = [];
  const source = String(value || '');
  const pattern = firstPersonOnly ? FIRST_PERSON_AUTHORSHIP : ANY_AUTHORSHIP;
  for (const match of source.matchAll(pattern)) {
    const rest = source.slice(match.index + match[0].length).split(/[.!?;:]/u)[0] ?? '';
    if (firstPersonOnly) {
      const antecedent = authoredRelativeAntecedent(source.slice(0, match.index), rest);
      if (antecedent) { pushAuthoredHeads([antecedent], '', false, heads); continue; }
    }
    heads.push(...authoredDirectObjectHeads(rest));
  }
  return heads;
}

/**
 * The nouns the letter has already used for the candidate's own work: the
 * objects of first-person authorship sentences in `sentencesBefore`, and the
 * objects of authorship verbs in the career-data quotes the letter cites.
 */
function letterAuthoredNouns(sentencesBefore, citations) {
  const nouns = new Set();
  for (const sentence of sentencesBefore) for (const head of authoredObjectHeads(sentence, { firstPersonOnly: true })) nouns.add(head);
  for (const paragraphQuotes of Array.isArray(citations) ? citations : []) {
    for (const quote of Array.isArray(paragraphQuotes) ? paragraphQuotes : []) {
      for (const head of authoredObjectHeads(text(quote), { firstPersonOnly: false })) nouns.add(head);
    }
  }
  return nouns;
}

/** Does `value` carry “the <noun> I <authorship verb>” with a noun the letter already used? */
function authoredNounClose(value, authoredNouns) {
  if (!authoredNouns || !authoredNouns.size) return false;
  for (const match of String(value || '').matchAll(AUTHORED_ARTIFACT_CLOSE)) {
    if (authoredNouns.has(authoredNounKey(match[1]))) return true;
  }
  return false;
}

// The present-tense forms are not optional extras: the routine and SKILL.md
// both tell the writer to keep this invitation in direct present tense, and a
// modal-only guard measurably rejected “…how my <domain> experience supports
// your <backlog>” — the sentence the contract asks for.
//
// The verbs are three closed lists, held as data so the regex below and the
// guidance a writer reads (contributionHalfRequirement) can never name different
// verbs. A verb outside them fails the action half however natural it reads
// (“could benefit”, “addresses”), which a writer cannot see unless it is told.
//   after a modal   the base forms, with up to two words between (“could … support”);
//   present tense   the same verbs in the third person (“supports”);
//   anywhere        eight verbs in the bare or -ing form (“applying … to …”); the guidance prints the -ing forms.
export const CLOSING_ACTION_MODAL_VERBS = Object.freeze([
  'support', 'contribute', 'help', 'advance', 'strengthen', 'improve', 'build', 'deliver', 'apply', 'serve', 'shorten', 'extend', 'scale', 'accelerate', 'fit',
]);
export const CLOSING_ACTION_MODALS = Object.freeze(['can', 'could', 'would', 'will', 'might']);
const CLOSING_ACTION_PRESENT_VERBS = Object.freeze([
  'supports', 'contributes', 'helps', 'advances', 'strengthens', 'improves', 'builds', 'delivers', 'applies', 'serves', 'shortens', 'extends', 'scales', 'accelerates', 'fits',
]);
export const CLOSING_ACTION_OPEN_BASE_VERBS = Object.freeze(['apply', 'bring', 'put', 'use', 'contribute', 'extend', 'connect', 'carry']);
export const CLOSING_ACTION_OPEN_PARTICIPLES = Object.freeze([
  'applying', 'bringing', 'putting', 'using', 'contributing', 'extending', 'connecting', 'carrying',
]);
// “contribute to” reads as one verb: the optional “to” changes what is matched, never whether it matches.
const closingVerbPattern = verb => (/^contribute/u.test(verb) ? `${verb}(?:\\s+to)?` : verb);
const CONTRIBUTION_VERBS = CLOSING_ACTION_MODAL_VERBS.map(closingVerbPattern).join('|');
const CONTRIBUTION_VERBS_PRESENT = CLOSING_ACTION_PRESENT_VERBS.map(closingVerbPattern).join('|');
const CANDIDATE_CONTRIBUTION_ACTION = new RegExp(
  `\\b(?:${CLOSING_ACTION_MODALS.join('|')})\\s+(?:[\\p{L}’'-]+\\s+){0,2}(?:${CONTRIBUTION_VERBS})\\b`
  + `|\\b(?:${CONTRIBUTION_VERBS_PRESENT})\\b`
  + `|\\b(?:${[...CLOSING_ACTION_OPEN_BASE_VERBS, ...CLOSING_ACTION_OPEN_PARTICIPLES].join('|')})\\b`,
  'iu',
);

// The third condition is what makes this a CONNECTION test rather than a
// vocabulary test. Asset and action alone are both satisfied by "I welcome a
// conversation about using my experience", which points nowhere: the action
// verbs are among the commonest in English and neither test requires the
// sentence to reach the employer's side at all. STYLE.md §11.2 asks the
// closing to carry "the role-facing contribution", so the sentence has to name
// the other side of that connection.
//
// EMPLOYER_TARGET_NOUNS/EMPLOYER_FACING_TARGET are the GENERIC lexicon only —
// "your", "the/this <noun>", the reader nouns. A comment here used to claim
// "No company name is available here", which was false: evaluateCoverLetterChecks
// already receives companyName and already threads it into
// checkCompanySpecificity and checkProspectiveContributionTense a few hundred
// lines away — this check alone dropped it on the floor. Measured cost: a
// job's closing paragraph named the employer BY NAME — "…could support
// <Employer>'s <initiative>." — which is exactly the shape every other
// rule in this app pushes a writer toward (checkOpeningEmployerShorthand,
// checkPriorEmployerOpening, and company-specificity itself all want the
// employer named, not a placeholder pronoun). The generic-only lexicon
// rejected it anyway, four consecutive rounds (2026-09-24,
// 13:08:05Z–13:10:40Z, every rejection fingerprint 752d8241 on this check's
// direct-conversation branch), because "<Employer>'s" satisfies none of
// "your", "the/this <noun>", or the reader-noun list. employerFacingTarget()
// below now also accepts the employer's own name, derived from companyName.
const EMPLOYER_TARGET_NOUNS = 'team|teams|role|position|group|organi[sz]ation|company|district|product|products'
  + '|platform|codebase|backlog|roadmap|effort|work|mission|practice|pipeline|pipelines|system|systems|service|services'
  // Nouns an employer-facing closing names when the target is a specific
  // initiative rather than a standing team or system: "the <product>
  // rollout", "this migration", "your onboarding flow". Measured directly
  // against the incident's own rejected sentences ("…support <Employer>'s
  // <product> rollout", "…support <Employer>'s <data> sync") — rollout and
  // sync-style initiative nouns are exactly what those closings used.
  + '|rollout|migration|launch|stack|infrastructure|deployment|workflow|workflows|onboarding|store|stores';
const EMPLOYER_FACING_TARGET = new RegExp(
  '\\byour(?:s)?\\b'
  // A modifier slot is required: real closings say "the service team", "this
  // engineering group", not only the bare noun.
  + `|\\b(?:this|the)\\s+(?:[\\p{L}’'-]+\\s+){0,2}(?:${EMPLOYER_TARGET_NOUNS})\\b`
  + '|\\b(?:client|clients|customer|customers|user|users|student|students|patient|patients|here)\\b',
  'iu',
);

// Legal-entity suffixes stripped before deriving a distinctive token:
// "Acme Inc." names the same reader-facing company as "Acme", and
// matching only the full string with the suffix still attached would reject a
// writer who — correctly, by every naming convention this app otherwise
// enforces — drops the suffix in prose. "Co." keeps its period required (a
// bare "Co" is two letters and too easy to collide with an ordinary word
// ending); every other suffix accepts an optional trailing period so "Inc"
// and "Inc." both strip.
const COMPANY_LEGAL_SUFFIXES = [
  'incorporated', 'corporation', 'company', 'limited',
  'l\\.l\\.c\\.?', 'llc', 'inc\\.?', 'ltd\\.?', 'corp\\.?', 'co\\.',
  'plc', 'gmbh', 's\\.a\\.?', 'pty', 'ab', 'nv',
];
// Requires a comma or whitespace immediately before the suffix, so the suffix
// has to be its own trailing token — "Cisco" ends in "co" but has no comma or
// space in front of it, so it is never mistaken for a stripped "Co.".
const COMPANY_LEGAL_SUFFIX_RE = new RegExp(`[,\\s]+(?:${COMPANY_LEGAL_SUFFIXES.join('|')})\\s*$`, 'iu');

// Tokens too generic to identify a company on their own. Deliberately the
// short, explicit list the task asked for rather than a general stopword
// list: a longer list would start rejecting real leading tokens ("And Co",
// "For Good") that happen to share a word with a function word.
const COMPANY_TARGET_STOPWORDS = new Set(['the', 'a', 'an']);

/**
 * Builds a matcher for an employer's own name, or null when companyName
 * carries nothing safe to match on. For a MULTI-word name, matches the full
 * name CASE-INSENSITIVELY plus its distinctive leading token ("Acme" for
 * "Acme Inc.") CASE-SENSITIVELY — the two halves deliberately do not
 * share a case-sensitivity rule (see below for why the full multi-word name
 * is exempt from the case-sensitive treatment). A SINGLE-word name gets only
 * the case-sensitive token match — see the dedicated comment on that branch
 * below for why it is not also given a case-insensitive alternative the way
 * the multi-word full name is. Every alternative optionally accepts a
 * trailing possessive "'s" — straight or curly, since the letter text this
 * matches against is not guaranteed to have gone through text()'s apostrophe
 * normalization by the time this runs — and all are escapeRegExp'd: this
 * app's own company names include parenthesized forms ("Example Web Services
 * (EWS)") whose literal characters would otherwise be read as regex syntax.
 *
 * Case-sensitive tokens are guarded only by length>=3 and a 3-word stopword
 * set. Measured false positives: "Fine Mart" -> "Fine" matched "my fine
 * work"; "Focus Corporation" -> "Focus" matched this app's own guidance
 * text ("focus work"); and this app's own job board turns up real employers
 * whose distinguishing token is an ordinary English word, such as a
 * single-word brand that is also a common noun or verb. Each one let candidate-facing prose
 * satisfy the target half of the three-part closing requirement without the
 * sentence ever reaching the employer's side — a false PASS, the more
 * expensive of the two failure directions on a check gating a paste handoff.
 * Matching that token CASE-SENSITIVELY, exactly as the company spells it,
 * closes that: a letter naming the employer writes "Anchor's ingestion
 * pipeline" with the posting's own capital; candidate-facing prose writes
 * "anchor" lowercase. This is not airtight — sentence-initial
 * capitalization ("Anchor handles onboarding.") would still satisfy the
 * case-sensitive match for reasons that have nothing to do with the employer
 * — but that residual risk is small here specifically: every sentence this
 * check grades has already matched one of the invitation regexes above
 * (CONDITIONAL_WELCOME_CLOSE, DIRECT_CONVERSATION_CLOSE,
 * SELF_DIRECTED_CONVERSATION_CLOSE, LOOK_FORWARD_CONVERSATION_CLOSE), and
 * every one of those anchors at the START of the sentence ("I welcome a
 * conversation about ...", "I look forward to ..."), so the token is almost
 * never itself sentence-initial.
 */
function companyNameTargetPattern(companyName) {
  const stripped = text(companyName).replace(COMPANY_LEGAL_SUFFIX_RE, '').trim();
  if (stripped.length < 3) return null;
  const tokens = stripped.split(/\s+/).filter(Boolean);
  if (tokens.every(token => COMPANY_TARGET_STOPWORDS.has(normalized(token)))) return null;
  // Both alternatives share the identical boundary + optional-possessive
  // wrapper; only the case-sensitivity flag differs between them, which is
  // why they are two separate regexes rather than two branches of one
  // alternation — a single RegExp cannot vary case-sensitivity per branch.
  const boundedAlternative = token => `(?<![\\p{L}\\p{N}])${escapeRegExp(token)}(?:['’]s)?(?![\\p{L}\\p{N}])`;
  // A single-word company name IS its own leading token: nothing distinguishes
  // it from an ordinary word except capitalization, the identical collision
  // the multi-word leading-token fix above exists to close. Measured: with
  // companyName 'Anchor', "how my <asset> could support my own anchor
  // of ideas" — pure candidate-facing prose, no employer reference at all —
  // satisfied the target half before this branch existed, because a
  // single-word name fell through to fullNamePattern below, which is
  // case-INSENSITIVE by design for the multi-word case. That design choice is
  // right for a two-word full name ("Fine Mart" together, lowercase or not, is
  // measurably unlikely to appear by coincidence) but wrong for a one-word
  // name that IS one of this app's own measured ordinary-word collisions
  // (single-word brands that are also common nouns) — a single common word
  // colliding with ordinary prose is exactly the case the multi-word branch
  // already treats as too risky to match case-insensitively. So a one-word
  // name is routed through the case-sensitive path instead of the full-name
  // path, never both — a single-word "full name" and a single-word "leading
  // token" would be the identical string, so building both would only test
  // the same regex twice.
  if (tokens.length === 1) {
    const single = tokens[0];
    if (single.length < 3 || COMPANY_TARGET_STOPWORDS.has(normalized(single))) return null;
    const singleTokenPattern = new RegExp(boundedAlternative(single), 'u');
    return { test: value => singleTokenPattern.test(value) };
  }
  const fullNamePattern = new RegExp(boundedAlternative(stripped), 'iu');
  const leading = tokens[0];
  const leadingTokenPattern = (leading.length >= 3 && !COMPANY_TARGET_STOPWORDS.has(normalized(leading)))
    ? new RegExp(boundedAlternative(leading), 'u')
    : null;
  return { test: value => fullNamePattern.test(value) || (leadingTokenPattern ? leadingTokenPattern.test(value) : false) };
}

/**
 * EMPLOYER_FACING_TARGET plus the employer's own name. Routed through here so
 * every place inside this check that needs to know whether a sentence reaches
 * the employer's side reads the identical rule — see the EMPLOYER_TARGET_NOUNS
 * comment above for the incident that made the company-name half necessary.
 */
function employerFacingTarget(value, companyName) {
  if (EMPLOYER_FACING_TARGET.test(value)) return true;
  const companyPattern = companyNameTargetPattern(companyName);
  return companyPattern ? companyPattern.test(value) : false;
}

/**
 * Which of the three contribution predicates a closing sentence still fails,
 * in a fixed order (asset, action, target) so a message built from this array
 * always lists them the same way. An empty array means the sentence satisfies
 * the full connection. See the comment on candidateContributionRequirement
 * below for why the CALLER, not this function, decides how much of this to
 * report.
 */
function missingContributionHalves(value, companyName, { authoredNouns = null } = {}) {
  const missing = [];
  if (!CANDIDATE_ASSET_CLOSE.test(value) && !authoredNounClose(value, authoredNouns)) missing.push('asset');
  if (!CANDIDATE_CONTRIBUTION_ACTION.test(value)) missing.push('action');
  if (!employerFacingTarget(value, companyName)) missing.push('target');
  return missing;
}

// The observation has to be executable on its own: a writer reading only this
// line must be able to produce a closing that passes. The previous wording
// ("name the experience, skills, or work…") described the goal but not the
// things the check tests, so a revision could name the experience, still miss
// the ownership marker, and fail the identical check a second time.
//
// Composed from one function — contributionHalfRequirement() below — rather
// than hand-maintained twice, so the conditional-modal branch (which grades
// all three predicates at once, since none of them has been checked yet at
// that point in the sentence) and the two branches that already know exactly
// which predicate failed read the identical wording for whichever half they
// name. That composition is load-bearing, not tidiness, across two separate
// incidents on the same check:
//
// 1. A single job's cover-letter paste handoff was rejected 16 consecutive
//    times over 87 minutes (2026-09-24, 08:23:19Z to 09:50:59Z), every
//    rejection naming this check's id, while the response grew from 4227 to
//    4314 chars rewriting the contribution clause and never touching the
//    conditional modal that actually tripped it — because the conditional
//    branch's own message pointed at the contribution clause ("name the
//    specific work or contribution to discuss") instead of at the modal.
//    Composing the same requirement into both branches means a writer told to
//    delete the modal is told, in the same round, the one other way this
//    sentence can still fail once the modal is gone.
//
// 2. The same check rejected a different job's letter a second time, 4
//    consecutive rounds (2026-09-24, 13:08:05Z–13:10:40Z), every round
//    fingerprint 752d8241 on the direct-conversation branch (branch 4). The
//    single fixed message every branch shared quoted an example for the asset
//    half and the action half but never for the target half — the exact half
//    the closing kept failing, once the generic-only employer lexicon (see
//    the EMPLOYER_TARGET_NOUNS comment above) rejected a company-named
//    target. A writer who already has a working asset and action and reads a
//    message that only ever demonstrates asset and action has no way to learn
//    what the sentence actually still needs, and rewrites the two halves that
//    were never broken. missingContributionHalves() above now reports WHICH
//    predicates failed; candidateContributionRequirement() below builds the
//    message from only those, so a writer who satisfies two of three is told
//    about the one that is failing and nothing else.
function contributionHalfRequirement(half, companyName) {
  switch (half) {
    case 'asset':
      return 'name the candidate’s asset with a possessive, an authorship clause, or a demonstrative that carries '
        + 'its own descriptor (“my <descriptor> work”, “the <artifact> I built”, “that <descriptor> experience”), '
        + 'never a bare demonstrative (“that work”); in an authorship clause the verb is one of '
        + `${CANDIDATE_AUTHORSHIP_VERBS.slice(0, -1).join(', ')} or ${CANDIDATE_AUTHORSHIP_VERBS.at(-1)}, and the <artifact> is a noun this letter has `
        + 'already used for your own work, either as the object of an earlier sentence of yours with such a verb or in a '
        + 'career-data quote the letter cites (a short fixed list of everyday artifact nouns also passes without that); '
        + `an authorship clause states a past action of yours when its verb is ${CLOSING_AUTHORSHIP_PROOF_VERBS.slice(0, -1).join(', ')} or ${CLOSING_AUTHORSHIP_PROOF_VERBS.at(-1)}, `
        + 'and a closing that holds one is a proof-bearing paragraph, so the review must also record an argumentMapping for it (a proof span and a '
        + 'jobNeedQuote that no other paragraph uses): use a possessive asset unless the artifact is the strongest item the letter showed';
    case 'action':
      return 'say what that asset does for the target work, with one of these verbs: '
        + `${CLOSING_ACTION_MODAL_VERBS.slice(0, -1).join(', ')} or ${CLOSING_ACTION_MODAL_VERBS.at(-1)}, after ${CLOSING_ACTION_MODALS.slice(0, -1).join(', ')} or ${CLOSING_ACTION_MODALS.at(-1)} `
        + '(up to two words may stand between) or in the present tense (“supports”, “applies”); or '
        + `${CLOSING_ACTION_OPEN_PARTICIPLES.slice(0, -1).join(', ')} or ${CLOSING_ACTION_OPEN_PARTICIPLES.at(-1)}; `
        + 'a verb outside these fails this half however naturally it reads';
    case 'target': {
      // This half had no example at all before the second incident above.
      // companyName is named in the message itself, when a usable pattern can
      // actually be built from it (see companyNameTargetPattern), so the
      // writer does not have to guess that the employer's own spelling counts
      // as reaching the employer's side — and is never told a name the
      // matcher itself would refuse (too short, or nothing but a stopword).
      // The name goes inside curly quotes like every other example here, and
      // that placement is load-bearing rather than cosmetic:
      // checkObservationFingerprint (localAiApplication.js) strips every
      // curly-quoted span before hashing precisely so a branch's fingerprint
      // is its own fixed wording and nothing job-specific. Interpolated bare,
      // the employer's name would survive into the digest — giving the SAME
      // branch a different fingerprint per company (defeating the cross-receipt
      // branch comparison the fingerprint exists for) and carrying job content
      // into a receipt whose header promises it never does.
      const named = companyNameTargetPattern(companyName) ? text(companyName) : '';
      const namedClause = named ? `, or the employer’s own name exactly as this letter already spells it (“${named}”)` : '';
      return 'reach the employer’s side too — “your …”, “the”/“this” plus up to two words and a noun for the team, '
        + 'product or work (“the … <noun>”, “this … <noun>”), a reader noun '
        + `(“clients”, “customers”, “users”)${namedClause}; a sentence naming only the `
        + 'candidate’s side fails this half even when the asset and action are both present';
    }
    default:
      return '';
  }
}

/**
 * Builds the remediation text from exactly the missing halves (the
 * direct-conversation and self-directed branches, which have already graded
 * all three predicates) or from all three at once (the conditional-modal
 * branch, which grades the sentence before the modal is even gone). See the
 * incident notes on contributionHalfRequirement above for why per-half
 * attribution replaced one fixed message shared by every branch.
 */
function candidateContributionRequirement(missing, companyName) {
  const lead = missing.length === 3
    ? 'the sentence needs all three parts'
    : missing.length === 1
      ? `the sentence is missing its ${missing[0]} half`
      : `the sentence is missing its ${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]} halves`;
  const parts = missing.map(half => contributionHalfRequirement(half, companyName));
  const requirement = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join('; ')}; and ${parts[parts.length - 1]}`;
  // The repeat-floor clause above tells a writer how far to vary a half's
  // WORDS. It says nothing about SHAPE: checkRepeatedSentenceShape grades this
  // closing sentence's syntactic frame against every other sentence in the
  // letter independently of wording, so a rewrite that clears the word floor
  // by swapping nouns and verbs into the same slots can still trip that check.
  // Naming it here, in the same message already sending a writer toward a
  // wording rewrite, keeps the two floors from reading as one problem with one
  // fix.
  return `${lead} — ${requirement}; name whichever half is rewritten in wording this letter has not already used `
    + `for it elsewhere — a run of ${MIN_CROSS_PARAGRAPH_REPEAT_WORDS} or more words carried verbatim from an `
    + 'earlier paragraph into this one is counted as a repeat on its own, independent of this check; sentence shape '
    + 'is graded separately from wording too, so if an earlier sentence already used this one’s shape, vary the '
    + 'construction and not only the words';
}

// Passed to candidateContributionRequirement by the conditional-modal branch,
// which has not evaluated any of the three predicates yet at the point it
// fires — the modal itself is what failed the sentence, so all three still
// belong in that branch's message regardless of what the clause after the
// modal actually contains.
const ALL_CONTRIBUTION_HALVES = Object.freeze(['asset', 'action', 'target']);

/**
 * The three parts a closing's final substantive sentence needs (asset, action,
 * target), each in the words checkDirectWelcomeClosing itself reports, with no
 * employer name. The stage contract states them once, before any closing has
 * been written, so a writer does not first learn them from a rejection; it
 * reads them from this function so the contract and the check cannot drift.
 */
export function closingContributionParts() {
  return ALL_CONTRIBUTION_HALVES.map(half => contributionHalfRequirement(half, ''));
}

// The functions the host requires of the sentences of a cover letter, each in one phrase, and the
// checks that can reject a letter for losing one. No closing function is listed: how a letter closes
// is the writer's choice. The phrases are built from the budgets so they can never name a function
// the gates do not read; the map from check
// id to function is what a test holds against the checks themselves: delete each sentence of a
// letter in turn, and every check that newly fails must be a key here, so a function the gates
// enforce cannot go unnamed. Generic by construction: no field of work, no wording, nothing a
// writer could copy.
const HOST_LETTER_FUNCTION_PHRASES = Object.freeze({
  'claim-and-relevance': OWING_CLAIM_PARAGRAPHS === OWING_RELEVANCE_PARAGRAPHS
    ? `a claim phrase and a sentence relating its proof to the job need in ${OWING_CLAIM_PARAGRAPHS}`
    : `a claim phrase in ${OWING_CLAIM_PARAGRAPHS} and a sentence relating its proof to the job need in ${OWING_RELEVANCE_PARAGRAPHS}`,
  proof: 'a proof sentence in every proof-bearing paragraph',
  // The opening is read by three checks: the first sentence may not lead with a prior employer's or a
  // named project's evidence, and the sentence that first names either must carry the candidate's part in it.
  opening: 'an opening that leads with the target work, with the candidate’s role stated wherever a prior employer or named project is first named',
  // Deleting a sentence shortens its paragraph, and the proportion limits count paragraphs, sentences and words.
  proportion: 'paragraphs long enough to stay within the letter’s proportion limits',
});
export const HOST_REQUIRED_LETTER_FUNCTION_CHECKS = Object.freeze({
  'paragraph-argument-links': Object.freeze(['claim-and-relevance', 'proof']),
  'opening-artifact-context': Object.freeze(['opening']),
  'prior-employer-opening': Object.freeze(['opening']),
  'named-artifact-introduction': Object.freeze(['opening']),
  'letter-proportion': Object.freeze(['proportion']),
});
export const HOST_REQUIRED_LETTER_FUNCTIONS = ['claim-and-relevance', 'proof', 'opening', 'proportion']
  .map(name => HOST_LETTER_FUNCTION_PHRASES[name])
  .reduce((joined, phrase, index, all) => (index === 0 ? phrase : `${joined}, ${index === all.length - 1 ? 'and ' : ''}${phrase}`), '');

// A trailing courtesy or sign-off sentence — "Thank you for your
// consideration.", "I am available at your convenience." — carries no
// invitation and no contribution, so grading only sentences(paragraph).at(-1)
// let a closing paragraph pass by ending on one regardless of what the
// sentence before it said. Measured: "I would welcome the chance to talk about
// that work. Thank you for your consideration." and "I welcome a conversation
// about that work. Thank you for your consideration." both passed, though both
// close on exactly the invitation this check exists to reject. The fix walks
// backward past sentences this matcher recognizes rather than widening the
// scope to the whole paragraph, because the comment inside
// checkDirectWelcomeClosing already explains why grading the two invitation
// shapes at different scopes made the rule unlearnable — a per-branch scope
// change here would repeat that mistake. If every sentence in the paragraph is
// courtesy, there is no substantive sentence to fall back to and today's
// behaviour holds: the last sentence is graded, no invitation regex fires, and
// the paragraph passes.
const COURTESY_CLOSING_SENTENCE = /^(?:thank\s+you\s+for\b|i\s+(?:truly\s+)?appreciate\s+(?:your|the)\b|please\s+(?:feel\s+free|do\s+not\s+hesitate)\b|i(?:\s+am|'m)\s+available\b|feel\s+free\s+to\s+(?:reach|contact)\b)/iu;

/**
 * Index into an already-split sentence list of the final sentence that
 * carries content beyond courtesy, walking backward past every sentence
 * COURTESY_CLOSING_SENTENCE recognizes. Shared by checkDirectWelcomeClosing —
 * which certifies the sentence it returns — and
 * checkProspectiveContributionTense's own exemption, which must skip that
 * SAME sentence and no other. Returning a POSITION rather than text is what
 * makes the second caller correct: identifying "the certified sentence" by
 * text equality would exempt every sentence in the paragraph that happens to
 * share its wording, including a genuine readiness-bridge defect in an
 * earlier, merely identical-looking sentence.
 */
function finalSubstantiveClosingSentenceIndex(paragraphSentences) {
  for (let index = paragraphSentences.length - 1; index >= 0; index--) {
    if (!COURTESY_CLOSING_SENTENCE.test(paragraphSentences[index])) return index;
  }
  return paragraphSentences.length ? paragraphSentences.length - 1 : -1;
}


/** Keeps the invitation in the closing direct and specific. */
export function checkDirectWelcomeClosing(paragraphs = [], companyName = '', { citations = null } = {}) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const observations = [];
  const index = list.length - 1;
  const closingSentences = index >= 0 ? sentences(list[index]) : [];
  const finalIndex = finalSubstantiveClosingSentenceIndex(closingSentences);
  const finalSentence = finalIndex >= 0 ? closingSentences[finalIndex] : '';
  // What the letter has already said the candidate made: every sentence before
  // the one graded (earlier paragraphs, and earlier sentences of the closing
  // paragraph), and the quotes the letter cites. See AUTHORED_ARTIFACT_CLOSE.
  const authoredNouns = letterAuthoredNouns(
    [...list.slice(0, Math.max(index, 0)).flatMap(paragraph => sentences(paragraph)), ...closingSentences.slice(0, Math.max(finalIndex, 0))],
    citations,
  );
  const conditionalMatch = CONDITIONAL_WELCOME_CLOSE.exec(finalSentence);
  if (conditionalMatch) {
    observations.push(`paragraph ${index + 1}'s final substantive sentence opens with a conditional or deferential `
      + `invitation (“${boundedDetailValue(conditionalMatch[0])}”); delete that opening modal and make the invitation `
      + 'direct, in the present tense — do not rewrite the clause after it, since the modal itself is what fails '
      + `this check, not the clause it introduces. Once the modal is gone the sentence is graded as a direct `
      + `invitation, so ${candidateContributionRequirement(ALL_CONTRIBUTION_HALVES, companyName)}`);
  }
  // Computed once and reused by both branches below: they read the identical
  // finalSentence/companyName pair, and missingContributionHalves is a pure
  // function of that pair.
  const missing = missingContributionHalves(finalSentence, companyName, { authoredNouns });
  const selfDirectedMatch = SELF_DIRECTED_CONVERSATION_CLOSE.exec(finalSentence)
    || LOOK_FORWARD_CONVERSATION_CLOSE.exec(finalSentence);
  if (selfDirectedMatch && missing.length) {
    observations.push(`paragraph ${index + 1}'s final substantive sentence ends with conversation or learning intent (“${boundedDetailValue(selfDirectedMatch[0])}”) but no candidate contribution; the invitation wording itself is correct, so keep it; ${candidateContributionRequirement(missing, companyName)}`);
  }
  const directConversation = DIRECT_CONVERSATION_CLOSE.exec(finalSentence);
  const employerChoice = EMPLOYER_CHOICE_CLOSE.exec(finalSentence);
  if (employerChoice) {
    observations.push(`paragraph ${index + 1}'s final substantive sentence asks the employer to choose between initiatives (“${boundedDetailValue(employerChoice[0])}”); close with the candidate's concrete contribution to the target work instead of posing a question for the employer to decide`);
    // Both branches read the FINAL SUBSTANTIVE SENTENCE, deliberately. STYLE.md
    // §11.2 is explicit that "its final sentence should connect the
    // candidate's relevant contribution to the target work", and grading the
    // two invitation shapes at different scopes made the rule unlearnable: the
    // same closing paragraph passed with "I welcome a conversation about that
    // work" and failed with "I look forward to discussing that work", decided
    // only by which verb the last sentence happened to use.
  } else if (directConversation && missing.length) {
    observations.push(`paragraph ${index + 1}'s final substantive sentence uses a direct conversation invitation (“${boundedDetailValue(directConversation[0])}”) but never connects a candidate asset to the employer's work; the invitation wording itself is correct, so keep it; ${candidateContributionRequirement(missing, companyName)}`);
  }
  return observationResult('direct-welcome-closing', observations, MAX_COPY_PRECISION_OBSERVATIONS,
    `${list.length} paragraph(s) use a direct, specific invitation when they close with “welcome”`);
}

// Numbers a person writes out in a résumé or a letter. The claim side and the
// evidence side read the same table, so "four years" in the prose is the same
// value as "4 years" in the quote and neither spelling is a way past the gate.
// The table runs to ninety-nine, with compounds ("twenty-five", "thirty two"),
// because a span of thirty years is as much a claim as a span of three.
const DURATION_ONES = Object.freeze(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']);
const DURATION_TEENS = Object.freeze(['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']);
const DURATION_TENS = Object.freeze(['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']);
const DURATION_NUMBER_WORDS = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
});
const DURATION_JOIN = '[-\u2013\u2011\\s]';
const DURATION_NUMBER_SOURCE = `(?:\\d{1,2}(?:\\.\\d{1,2})?|(?:${DURATION_TENS.join('|')})(?:${DURATION_JOIN}+(?:${DURATION_ONES.join('|')}))?|${[...DURATION_TEENS, ...DURATION_ONES].join('|')})`;
// A decade is ten years: "a decade", "two decades" and "decade-plus" are spans.
const DURATION_COUNT_SOURCE = `(?:${DURATION_NUMBER_SOURCE}|an?)`;
const DURATION_PLUS_SOURCE = `(?:\\+|${DURATION_JOIN}*plus\\b)`;
// "over four years" and "4+ years" assert a floor, so any longer span in the
// evidence supports them. Every other shape asserts the number itself.
const DURATION_LOWER_BOUND_WORDS = Object.freeze(['over', 'more than', 'at least', 'upwards of', 'north of', 'greater than']);
// "More than" a number is strictly more: a quote stating exactly that number
// does not support it, where "at least" and a trailing "+" are met by it.
const DURATION_STRICT_BOUND_WORDS = Object.freeze(['over', 'more than', 'upwards of', 'north of', 'greater than']);
const DURATION_HEDGE_WORDS = Object.freeze(['nearly', 'almost', 'about', 'around', 'roughly', 'approximately']);
const DURATION_QUALIFIER_SOURCE = `(?:${[...DURATION_LOWER_BOUND_WORDS, ...DURATION_HEDGE_WORDS].join('|')})`;
// An experience span the CANDIDATE claims, not every mention of a year. These
// markers carry that meaning and nothing else does reliably: a bound on the
// number ("4+", "over four", and the hedges, which are the fingerprint of a
// span someone computed), the word experience attached to the span, the
// preposition "for" ("for six years", "for over a decade"), or the span written
// as decades ("a decade", "decades of experience"). A start year ("since
// 2021") is the same claim stated from the other end.
//
// A bare "<number> years of <noun>" was measured too wide to keep. It reads
// the same in "three years of <field> work" and in "cut the nightly
// job from three years of accumulated backlog to a same-day queue", where the
// years belong to the backlog; rejecting the second costs a round AND deletes
// a true, concrete detail, which is worse than the claim it would catch. That
// unmarked shape is left to the contracts, which state the rule in full on all
// three stages that can write one. "for N years of <noun>" is read the same
// way: the years belong to the noun unless the noun is experience. Silent by
// construction: "the four-year rollout", "from three years to six weeks",
// "Python 3", "24/7", and any bare calendar year.
//
// "years of <something> experience" is the posting's own way of asking, and
// the phrase names the span as practice however many words separate the two,
// so the word is looked for in the clause that follows rather than only
// directly after. The window stops at the first sentence break: a later
// sentence that happens to use the word is not this phrase's meaning.
const DURATION_UNIT_SOURCE = '(years?|yrs?|decades?)';
const DURATION_CLAIM_RE = new RegExp(
  `(?:\\b(${DURATION_QUALIFIER_SOURCE})\\s+)?`
  + `\\b(${DURATION_COUNT_SOURCE})\\s*(${DURATION_PLUS_SOURCE})?${DURATION_JOIN}*${DURATION_UNIT_SOURCE}\\b`
  + `(?:${DURATION_JOIN}*(${DURATION_PLUS_SOURCE}))?(?:['’]s?)?`
  + '(?:\\s+(of|in))?(\\s+experience)?\\b',
  'giu');
// "decades of experience" with no count at all still says at least two.
const DURATION_BARE_DECADES_RE = new RegExp(
  `(?:\\b(${DURATION_QUALIFIER_SOURCE})\\s+)?\\b(?:(?:several|multiple|many)\\s+)?decades\\b(?:\\s+(of|in))?(\\s+experience)?\\b`,
  'giu');
const DURATION_COUNT_BEFORE_RE = new RegExp(`(?:${DURATION_COUNT_SOURCE})${DURATION_JOIN}*(?:${DURATION_PLUS_SOURCE})?${DURATION_JOIN}*$`, 'iu');
const DURATION_FOR_BEFORE_RE = /\bfor\s+(?:the\s+(?:past|last)\s+)?$/iu;
const DURATION_SINCE_MONTH_SOURCE = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DURATION_SINCE_RE = new RegExp(`\\bsince\\s+(?:(?:early|mid|late)${DURATION_JOIN}+)?(?:${DURATION_SINCE_MONTH_SOURCE}\\.?\\s+)?((?:19|20)\\d{2})\\b`, 'giu');
// The same evidence-side shapes, read from a quote: it decides whether the span
// was WRITTEN DOWN and what it says, not how a claim happened to be phrased.
const DURATION_EVIDENCE_RE = new RegExp(
  `(?:\\b(${DURATION_QUALIFIER_SOURCE})\\s+)?\\b(${DURATION_COUNT_SOURCE})\\s*(${DURATION_PLUS_SOURCE})?${DURATION_JOIN}*${DURATION_UNIT_SOURCE}\\b`
  + `(?:${DURATION_JOIN}*(${DURATION_PLUS_SOURCE}))?`,
  'giu');
const DURATION_EXPERIENCE_WINDOW_CHARS = 72;
const DURATION_EXPERIENCE_TAIL_RE = /^[^.;:!?]*\bexperience\b/iu;
// A number of years in a quote is not automatically the candidate's own time:
// "cut the backlog from six years of accumulated files" states a backlog's
// age. A quote states the candidate's span when it carries a bound or a hedge,
// calls the span experience, or presents it as time spent. These are the
// presentations of time spent, deliberately structural words and punctuation
// rather than any field's vocabulary.
const DURATION_OWN_TIME_BEFORE_RE = /(?:\b(?:has|have|had|having|worked|working|works|served|serving|serves|spent|spending|employed|practi[cs](?:ed|ing)|been|remained|stayed)\b(?:\s+[\p{L}'’-]+){0,3}|\bfor(?:\s+the\s+(?:past|last))?)\s*$/iu;
const DURATION_LABEL_BEFORE_RE = /(?:[([:]|\s-)\s*$/u;
const DURATION_OWN_TIME_AFTER_RES = Object.freeze([
  /^\s*(?:as|at|with|in|on)\b/iu,
  /^[-\s]*(?:career|tenure|veteran|history)\b/iu,
  /^['’]s?\s+(?:tenure|service|career)\b/iu,
]);

// Every stage that can write a span states this rule in prose, so the shapes
// and the window are derived from the constants findUnsupportedDurationClaim
// reads instead of transcribed into three contracts. Stating the SHAPES is
// what makes the rule followable: the phrase that trips it is decided by a
// bound, a hedge, or the word that follows, never by who the sentence says the
// span belongs to — so a writer told only "a span must be supported" cannot
// tell that attributing one to the posting is still a claim.
export const DURATION_CLAIM_SHAPE_RULE = 'a span of years is read as a claim when the number carries a bound '
  + `(a trailing “+” or “-plus”, or ${DURATION_LOWER_BOUND_WORDS.join(', ')}), when it carries a hedge `
  + `(${DURATION_HEDGE_WORDS.join(', ')}), when it follows “for” (“for six years”), or when the words following it, `
  + `within ${DURATION_EXPERIENCE_WINDOW_CHARS} characters and before the first sentence break, call that span experience; `
  + 'a decade counts as ten years in every one of those shapes (“a decade of experience”, “two decades”, “decades of experience”), '
  + 'and a start year (“since 2021”) is read as a claim too. A bounded span is supported by any '
  + `longer span the cited quotes state (a bound written ${DURATION_STRICT_BOUND_WORDS.join(', ')} needs a strictly longer one), `
  + 'a start year by a cited quote that states that year, and every other shape needs a cited quote stating that same number of '
  + 'years. A quote supports a bound, a hedge or an experience span only when it states the number as the candidate’s own '
  + 'time: with a bound or hedge, as experience, or as time spent (“has six years”, “worked for six years”, '
  + '“six years as”, “Python (six years)”); a number of years the quote gives to something else, such as a '
  + 'backlog’s age, supports none of them';

function durationValue(token) {
  const lower = String(token || '').toLowerCase();
  if (lower === 'a' || lower === 'an') return 1;
  if (/^\d/u.test(lower)) return Number.parseFloat(lower);
  return lower.split(/[-\u2013\u2011\s]+/u).reduce((sum, part) => sum + (DURATION_NUMBER_WORDS[part] ?? Number.NaN), 0);
}

// Years a counted unit stands for: a decade is ten, and “half a decade” is five.
function durationSpanYears(source, matchIndex, count, unit) {
  const number = durationValue(count);
  if (!/^decade/iu.test(unit)) return number;
  return /^an?$/iu.test(count) && /\bhalf[-\s]+$/iu.test(source.slice(Math.max(0, matchIndex - 16), matchIndex)) ? 5 : number * 10;
}

// Only a short window around a number is ever read, so the prose a number sits
// in is bounded however long the text is.
const DURATION_CONTEXT_CHARS = 120;

function sentenceClauseBefore(source, index) {
  return source.slice(Math.max(0, index - DURATION_CONTEXT_CHARS), index).split(/[.;!?\n]/u).at(-1) ?? '';
}

function sentenceClauseAfter(source, index) {
  return (source.slice(index, index + DURATION_EXPERIENCE_WINDOW_CHARS).split(/[.;!?\n]/u)[0] ?? '');
}

/**
 * Every span of years one quote states, each with the value (decades counted as
 * ten years), whether it is open-ended ("N+", "over N": a longer span is
 * possible), and whether the quote presents it as the candidate's own time.
 */
function durationStatements(sourceText) {
  const source = String(sourceText || '');
  const statements = [];
  for (const match of source.matchAll(DURATION_EVIDENCE_RE)) {
    const [phrase, qualifier, count, plus, unit, plusAfter] = match;
    if (/^an?$/iu.test(count) && !/^decade/iu.test(unit)) continue;
    const value = durationSpanYears(source, match.index, count, unit);
    if (!Number.isFinite(value)) continue;
    const lowerQualifier = String(qualifier || '').toLowerCase();
    const before = sentenceClauseBefore(source, match.index);
    const after = sentenceClauseAfter(source, match.index + phrase.length);
    const marked = Boolean(plus || plusAfter || qualifier);
    statements.push({
      value,
      open: Boolean(plus || plusAfter) || DURATION_STRICT_BOUND_WORDS.includes(lowerQualifier),
      own: marked
        || DURATION_EXPERIENCE_TAIL_RE.test(after)
        || DURATION_OWN_TIME_BEFORE_RE.test(before)
        || DURATION_LABEL_BEFORE_RE.test(before)
        || DURATION_OWN_TIME_AFTER_RES.some(pattern => pattern.test(after)),
    });
  }
  for (const match of source.matchAll(DURATION_BARE_DECADES_RE)) {
    if (DURATION_COUNT_BEFORE_RE.test(source.slice(Math.max(0, match.index - 48), match.index))) continue;
    statements.push({ value: 20, open: true, own: true });
  }
  return statements;
}

/** The spans one final text claims, in reading order. */
function durationClaims(finalText) {
  const source = String(finalText || '');
  const claims = [];
  for (const match of source.matchAll(DURATION_CLAIM_RE)) {
    const [phrase, qualifier, count, plus, unit, plusAfter, preposition, experience] = match;
    if (/^an?$/iu.test(count) && !/^decade/iu.test(unit)) continue;
    const claimed = durationSpanYears(source, match.index, count, unit);
    if (!Number.isFinite(claimed)) continue;
    const lowerQualifier = String(qualifier || '').toLowerCase();
    const lowerBound = Boolean(plus || plusAfter) || DURATION_LOWER_BOUND_WORDS.includes(lowerQualifier);
    const tail = source.slice(match.index + phrase.length, match.index + phrase.length + DURATION_EXPERIENCE_WINDOW_CHARS);
    const claimsExperience = Boolean(experience) || (Boolean(preposition) && DURATION_EXPERIENCE_TAIL_RE.test(tail));
    // "for six years of <noun>" gives the years to the noun, not to the candidate.
    const afterFor = DURATION_FOR_BEFORE_RE.test(source.slice(Math.max(0, match.index - 32), match.index))
      && !(/^of$/iu.test(preposition || '') && !claimsExperience);
    // Without a bound on the number, the span being named as experience, or the
    // preposition "for", it is not claimed as the candidate's own practice; see
    // DURATION_CLAIM_RE.
    if (!lowerBound && !qualifier && !claimsExperience && !afterFor) continue;
    claims.push({
      index: match.index,
      // The trailing preposition is only how the shape was recognized; quoting
      // it back ("4+ years of") would read like a truncated sentence.
      phrase: phrase.trim().replace(/\s+(?:of|in)$/iu, ''),
      claimed,
      lowerBound,
      strictBound: DURATION_STRICT_BOUND_WORDS.includes(lowerQualifier),
      ownTimeRequired: lowerBound || Boolean(qualifier) || claimsExperience,
    });
  }
  for (const match of source.matchAll(DURATION_BARE_DECADES_RE)) {
    const [phrase, qualifier, preposition, experience] = match;
    if (DURATION_COUNT_BEFORE_RE.test(source.slice(Math.max(0, match.index - 48), match.index))) continue;
    const tail = source.slice(match.index + phrase.length, match.index + phrase.length + DURATION_EXPERIENCE_WINDOW_CHARS);
    const claimsExperience = Boolean(experience) || (Boolean(preposition) && DURATION_EXPERIENCE_TAIL_RE.test(tail));
    const afterFor = DURATION_FOR_BEFORE_RE.test(source.slice(Math.max(0, match.index - 32), match.index)) && !(/^of$/iu.test(preposition || '') && !claimsExperience);
    if (!qualifier && !claimsExperience && !afterFor) continue;
    claims.push({
      index: match.index,
      phrase: phrase.trim().replace(/\s+(?:of|in)$/iu, ''),
      claimed: 20,
      lowerBound: true,
      strictBound: DURATION_STRICT_BOUND_WORDS.includes(String(qualifier || '').toLowerCase()),
      ownTimeRequired: true,
    });
  }
  for (const match of source.matchAll(DURATION_SINCE_RE)) {
    claims.push({ index: match.index, phrase: match[0].trim(), startYear: Number(match[1]) });
  }
  return claims.sort((left, right) => left.index - right.index);
}

/**
 * The one unsupported-experience-span decision, shared by the résumé stage, the
 * cover-letter stage, and the completion-time grounding pass, so no stage can
 * reach a different verdict. A call site supplies the final text of one unit
 * and the career-data quotes bound to THAT unit; nothing else is in scope,
 * because a span is only as true as the evidence the unit itself cites.
 *
 * This is the numeric claim a host can actually decide. A general "every
 * figure must occur in the evidence" rule fires on a year inside a date range,
 * a version number, a ratio like 24/7, and a percentage the evidence rounds
 * differently — each a rejection with no obvious repair. A span of years is
 * different: it is either written down in the cited passage or it was computed
 * by the writer, and the computation a writer most often performs is adding up
 * separate employment dates, which is precisely the claim no single passage
 * supports.
 *
 * Returns the phrase the caller submitted and the spans its own evidence
 * states, so a rejection can be written without handing back corpus text the
 * responder could paste in unchanged.
 */
export function findUnsupportedDurationClaim(finalText, sourceQuotes = []) {
  const quotes = (Array.isArray(sourceQuotes) ? sourceQuotes : [sourceQuotes]).map(quote => text(quote)).filter(Boolean);
  // Each quote is read alone: the words around a number are the quote's own, and
  // joining quotes would let one quote's wording describe another quote's span.
  const statements = quotes.flatMap(durationStatements);
  const citedYears = quotes.join(' ');
  for (const claim of durationClaims(finalText)) {
    if (claim.startYear != null) {
      const stated = new RegExp(`(?<![\\p{L}\\p{N}])${claim.startYear}(?![\\p{L}\\p{N}])`, 'u');
      if (stated.test(citedYears)) continue;
      return { phrase: boundedDetailValue(claim.phrase), years: null, startYear: claim.startYear, lowerBound: false, statedYears: [] };
    }
    const pool = claim.ownTimeRequired ? statements.filter(statement => statement.own) : statements;
    const supported = claim.lowerBound
      ? pool.some(statement => (claim.strictBound
        ? statement.value > claim.claimed || (statement.value === claim.claimed && statement.open)
        : statement.value >= claim.claimed))
      : pool.some(statement => statement.value === claim.claimed);
    if (supported) continue;
    return {
      phrase: boundedDetailValue(claim.phrase),
      years: claim.claimed,
      lowerBound: claim.lowerBound,
      statedYears: [...new Set(pool.map(statement => statement.value))].sort((a, b) => a - b),
    };
  }
  return null;
}

/**
 * findUnsupportedDurationClaim over a whole letter, as a check row.
 *
 * `citations` is parallel to `paragraphs`: for paragraph i, the career-data
 * quotes it cites. Each paragraph is judged against ITS OWN quotes, which is
 * how every stage that writes a span reads it (a span is only as true as the
 * evidence the unit itself cites). When the quotes cannot be lined up with the
 * paragraphs the check does not judge rather than guess, the way
 * analyzeLetterProportion treats an unlined quote limit. The decision itself
 * is findUnsupportedDurationClaim's, unchanged.
 */
export function checkUnsupportedExperienceSpan(paragraphs = [], citations = null) {
  const list = (Array.isArray(paragraphs) ? paragraphs : []).map(text);
  if (!Array.isArray(citations) || citations.length !== list.length) {
    return result('unsupported-experience-span', true, 'skipped: the quotes each paragraph cites are not available');
  }
  const observations = [];
  list.forEach((paragraph, index) => {
    const found = findUnsupportedDurationClaim(paragraph, Array.isArray(citations[index]) ? citations[index] : []);
    if (found) observations.push(`paragraph ${index + 1} claims an experience span (“${found.phrase}”) that none of the career-data evidence it cites states`);
  });
  return observationResult('unsupported-experience-span', observations, MAX_GENERIC_OBSERVATIONS,
    `${list.length} paragraph(s) claim no experience span their cited evidence does not state`);
}

// A paragraph-opening demonstrative noun phrase promises that its referent
// sits in the paragraph the reader just finished. A shipped letter opened a
// paragraph “That <topic> practice …” two paragraphs after the <topic>
// material, forcing the reader to hunt backward. Deliberately narrow: only
// the opening words of paragraphs after the first are read, only when the
// demonstrative heads a noun phrase (pronoun and fixed-phrase heads are
// skipped via the stopword set), and the referent search stems both sides so
// a verb form anchors its noun form. Mid-paragraph demonstratives have local
// context and stay out of scope.
const OPENING_DEMONSTRATIVE_RE = /^(?:that|this|these|those)\s+([\p{L}’'-]+)(?:\s+([\p{L}’'-]+))?/iu;
const DEMONSTRATIVE_HEAD_STOPWORDS = new Set([
  'is', 'was', 'are', 'were', 'be', 'being', 'been', 'has', 'had', 'have',
  'said', 'same', 'one', 'way', 'why', 'how', 'what', 'kind', 'sort', 'much',
  'many', 'last', 'first', 'second', 'time', 'point', 'and', 'or', 'of', 'in',
  'to', 'a', 'an', 'the', 'my', 'own', 'very',
]);

const DEMONSTRATIVE_AUXILIARY_WORDS = new Set([
  'would', 'could', 'can', 'will', 'should', 'may', 'might', 'must', 'shall', 'do', 'does', 'did',
  'cannot', 'needs',
]);

function referentStem(word) {
  const lower = String(word || '').toLowerCase();
  const stripped = lower.replace(/(?:ation|ing|ed|es|s)$/u, '');
  return stripped.length >= 4 ? stripped : lower;
}

function referentStemsMatch(left, right) {
  const a = referentStem(left);
  const b = referentStem(right);
  if (Math.min(a.length, b.length) < 4) return a === b;
  return a.startsWith(b) || b.startsWith(a);
}

/** Keeps a paragraph-opening “That/This <noun>” anchored to the previous paragraph. */
export function checkOpeningDemonstrative(paragraphs = []) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const observations = [];
  for (let index = 1; index < list.length; index++) {
    const paragraph = text(list[index]);
    const match = OPENING_DEMONSTRATIVE_RE.exec(paragraph);
    if (!match) continue;
    // A modal or auxiliary is never a noun, so it can neither be the head to look
    // for nor be the word that satisfies the search: “That would help” has no
    // noun phrase at all, and “That judgment would” is looking for judgment
    // alone. Before this, a “would” anywhere in the previous paragraph anchored
    // “That judgment would”, and “That would help” was reported for a “would”
    // the previous paragraph did not carry.
    const isAuxiliary = word => DEMONSTRATIVE_AUXILIARY_WORDS.has(word) || word.endsWith("n't");
    if (isAuxiliary(match[1].toLowerCase())) continue;
    const heads = [match[1], match[2]]
      .filter(Boolean)
      .map(word => word.toLowerCase())
      .filter(word => !DEMONSTRATIVE_HEAD_STOPWORDS.has(word) && !isAuxiliary(word));
    if (!heads.length) continue;
    const previousWords = words(list[index - 1]);
    if (heads.some(head => previousWords.some(word => referentStemsMatch(head, word)))) continue;
    observations.push(`paragraph ${index + 1} opens with “${leadingWordsSnippet(paragraph, 4)}”, but the previous paragraph never mentions ${heads.map(head => `“${head}”`).join(' or ')}; name the referent explicitly or open with this paragraph's own subject`);
  }
  return observationResult('opening-demonstrative', observations, MAX_OPENING_DEMONSTRATIVE_OBSERVATIONS,
    `${list.length} paragraph(s) anchor their opening references in the preceding paragraph`);
}

/** Opening word as written: the first run of letters/apostrophes, or '' when none. */
function paragraphOpeningWord(value) {
  const match = /[\p{L}][\p{L}'’]*/u.exec(text(value));
  return match ? match[0] : '';
}

function listParagraphNumbers(numbers) {
  if (numbers.length <= 1) return numbers.join('');
  return `${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`;
}

/**
 * Records consecutive paragraphs that open on the same word (case-insensitive).
 * Advisory only: names paragraph numbers and the writer's own word, never a
 * replacement string.
 */
export function checkParagraphOpeners(paragraphs = []) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const openers = list.map(paragraph => paragraphOpeningWord(paragraph));
  const observations = [];
  let start = 0;
  while (start < openers.length) {
    const key = openers[start].toLowerCase();
    let end = start + 1;
    if (key) {
      while (end < openers.length && openers[end].toLowerCase() === key) end++;
    }
    if (key && end - start >= 2) {
      const numbers = [];
      for (let index = start; index < end; index++) numbers.push(index + 1);
      observations.push(`paragraphs ${listParagraphNumbers(numbers)} open with the same word (“${boundedDetailValue(openers[start])}”); start at least one of them on a different word, such as the work or its setting`);
    }
    start = end;
  }
  return observationResult('paragraph-openers', observations, MAX_PARAGRAPH_OPENER_OBSERVATIONS,
    `${list.length} paragraph(s) open on different words`);
}

// At a paragraph boundary, “The department” after a named employer
// makes the prior employer sound like generic context rather than the named
// source of the next evidence. This is intentionally narrower than a ban on
// definite descriptions: only organization labels that match a known employer
// named in the immediately preceding paragraph are in scope.
const EMPLOYER_ORGANIZATION_LABELS = new Set([
  'district', 'department', 'agency', 'company', 'organization', 'organisation',
  'university', 'college', 'hospital', 'city', 'county', 'state',
]);
const OPENING_EMPLOYER_SHORTHAND = /^the\s+(?:school\s+)?([\p{L}’'-]+)\b/iu;

/**
 * Flags a vague employer shorthand at a paragraph boundary without prescribing
 * repetition. `employer` is curly-quoted below — see checkPriorEmployerOpening's
 * comment above.
 */
export function checkOpeningEmployerShorthand(paragraphs = [], employerNames = []) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const employers = (Array.isArray(employerNames) ? employerNames : []).map(text).filter(Boolean);
  const observations = [];
  for (let index = 1; index < list.length; index++) {
    const paragraph = text(list[index]);
    const match = OPENING_EMPLOYER_SHORTHAND.exec(paragraph);
    const label = normalized(match?.[1]);
    if (!label || !EMPLOYER_ORGANIZATION_LABELS.has(label)) continue;
    const previous = normalized(list[index - 1]);
    const employer = employers.find(name => words(name).includes(label) && previous.includes(normalized(name)));
    if (!employer) continue;
    // Names the offending span and the shape of the repair, and quotes no
    // wording for the letter to adopt. The rule is stated in full beside
    // checkRepeatedSentenceShape below: a gate that hands over a string hands
    // over something to copy into the letter. This message and the adjacent one
    // both used to offer a literal re-entry cue as the repair, and the letter of
    // 2026-09-23 opened two of its four paragraphs with exactly that cue. The
    // employer's own name stays: it is the candidate's employer, already in the
    // letter, and it is what makes the observation locatable.
    observations.push(`paragraph ${index + 1} opens with employer shorthand (“${leadingWordsSnippet(paragraph, 3)}”) after naming “${employer}” in the prior paragraph; open instead on whatever this paragraph is actually about, whether that is the candidate, the work itself, or “${employer}” named in full where another employer or role could be the referent`);
    if (observations.length >= MAX_EXPERIENCE_FRAMING_OBSERVATIONS) break;
  }
  return observationResult('opening-employer-shorthand', observations, MAX_EXPERIENCE_FRAMING_OBSERVATIONS,
    `${list.length} paragraph(s) avoid vague employer shorthand at paragraph boundaries`);
}

/**
 * Full-name repetition in consecutive evidence paragraphs is usually
 * unnecessary after a single clear employer mention. Keep the guard narrow:
 * it applies only when the candidate begins the next sentence with the same
 * employer, and ignores contexts that name multiple employers. `employer` is
 * curly-quoted below — see checkPriorEmployerOpening's comment above.
 */
export function checkAdjacentEmployerRepetition(paragraphs = [], employerNames = []) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const employers = (Array.isArray(employerNames) ? employerNames : [])
    .map(text).filter(Boolean)
    .sort((left, right) => right.length - left.length);
  const observations = [];
  for (let index = 1; index < list.length; index++) {
    const previous = text(list[index - 1]);
    const opening = text(sentences(list[index])[0]);
    const priorMentions = employers.filter(employer => {
      const reference = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(employer)}(?![\\p{L}\\p{N}])`, 'iu');
      return reference.test(previous);
    });
    if (priorMentions.length !== 1) continue;
    const employer = priorMentions[0];
    const repeatedCandidateOpening = new RegExp(`^(?:at\\s+)?${escapeRegExp(employer)}\\s*,\\s*i\\b`, 'iu');
    if (!repeatedCandidateOpening.test(opening)) continue;
    // Same rule as the message above, and the same repair: describe what the
    // opening should be about and stop. A named cue here is a phrase the letter
    // will contain, which is how two of four paragraphs came to share one.
    observations.push(`paragraph ${index + 1} repeats “${employer}” in its opening immediately after paragraph ${index}; one established employer needs no re-introduction, so let the opening start from this paragraph's own subject and keep “${employer}” only where another employer or role could be the referent`);
    if (observations.length >= MAX_EXPERIENCE_FRAMING_OBSERVATIONS) break;
  }
  return observationResult('adjacent-employer-repetition', observations, MAX_EXPERIENCE_FRAMING_OBSERVATIONS,
    `${list.length} paragraph(s) avoid needless full-name repetition after a single, established prior employer`);
}

// Closed by construction: articles, pronouns, determiners, auxiliaries and
// modals, the common prepositions, and the coordinating and subordinating
// conjunctions. Everything else is content, and this list is the whole
// difference between the two. It is deliberately not a part-of-speech tagger —
// a word is in the list or it is not, so the same sentence reduces to the same
// shape on every run and in every locale.
const FRAME_FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'our', 'your', 'his', 'her', 'its', 'their',
  'i', 'we', 'you', 'he', 'she', 'it', 'they', 'me', 'us', 'them', 'who', 'whom', 'which', 'what', 'whose',
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'can', 'could', 'shall', 'should', 'may', 'might', 'must',
  'at', 'in', 'on', 'of', 'to', 'for', 'with', 'by', 'from', 'as', 'into', 'over', 'under', 'across', 'through',
  'about', 'after', 'before', 'during', 'within', 'without', 'between', 'among', 'against', 'than', 'like',
  'and', 'or', 'but', 'so', 'because', 'while', 'when', 'where', 'if', 'though', 'although', 'since',
  'both', 'also', 'not', 'no', 'there', 'here', 'then', 'still', 'more', 'most', 'each', 'every', 'all',
  'any', 'some', 'one', 'own', 'same', 'such', 'very', 'too', 'only',
]);
// Deliberately not an ellipsis: every quoted detail value passes through
// text(), whose NFKC pass rewrites U+2026 to three periods, so a quoted frame
// would no longer contain the glyph its own legend names. An asterisk survives
// that normalization and cannot be read as the truncation marker either.
const FRAME_WILDCARD = '*';

/**
 * Reduces a sentence to the shape of its opening: function words stay literal,
 * every run of content words collapses to one wildcard. Collapsing the run is
 * what makes the comparison a shape rather than a phrase — two sentences that
 * differ only in the verb and the noun filling their slots reduce to the same
 * elements however long those fillers are. Returns '' for a sentence with no
 * comparable shape, so a short or wildcard-heavy sentence is simply not judged.
 */
function sentenceShapeFrame(sentence) {
  const skeleton = [];
  let literals = 0;
  for (const word of words(sentence)) {
    const token = FRAME_FUNCTION_WORDS.has(word) ? word : FRAME_WILDCARD;
    if (token === FRAME_WILDCARD && skeleton[skeleton.length - 1] === FRAME_WILDCARD) continue;
    if (token !== FRAME_WILDCARD) literals += 1;
    skeleton.push(token);
    if (skeleton.length >= SENTENCE_SHAPE_FRAME_WORDS) break;
  }
  if (skeleton.length < SENTENCE_SHAPE_FRAME_WORDS) return '';
  if (literals < MIN_SENTENCE_SHAPE_FUNCTION_WORDS) return '';
  return skeleton.join(' ');
}

/**
 * The most paragraphs that may carry one shape before the letter is reading as
 * a filled template. All but two, and never fewer than two, so a letter may
 * still run three of six paragraphs in deliberate parallel while four of four
 * is reported.
 */
export function sharedSentenceShapeCeiling(paragraphCount) {
  return Math.max(MIN_SHARED_SHAPE_PARAGRAPHS - 1, paragraphCount - 2);
}

// The contract is written before the letter exists, so the clause it prints
// has to state the ceiling as a formula. Both numbers in that formula are read
// back out of the function above rather than restated by hand: the flat floor
// it returns for the shortest judged letter, and the offset it subtracts once
// the letter is long enough for the count to govern. A hand-copied pair here
// would look guarded and drift the first time the formula moved.
const SHAPE_CEILING_LONG_LETTER_PROBE = 10;
const SHAPE_CEILING_FLOOR = sharedSentenceShapeCeiling(MIN_SHARED_SHAPE_PARAGRAPHS);
const SHAPE_CEILING_OFFSET = SHAPE_CEILING_LONG_LETTER_PROBE - sharedSentenceShapeCeiling(SHAPE_CEILING_LONG_LETTER_PROBE);
export const SHARED_SENTENCE_SHAPE_CEILING_RULE =
  `at most ${SHAPE_CEILING_FLOOR} of them may carry one shape,`
  + ` and once the letter runs longer than ${SHAPE_CEILING_FLOOR + SHAPE_CEILING_OFFSET} paragraphs`
  + ` the ceiling is its paragraph count less ${SHAPE_CEILING_OFFSET}`;
// The adjacency branch of the same check, stated for the contract. A ceiling is
// a count, and a count cannot see distance: two adjacent paragraphs are always
// at or under SHAPE_CEILING_FLOOR, which is how the letter of 2026-09-23 opened
// paragraphs 2 and 3 on one frame and passed the whole battery. The
// clause has no number of its own, so there is none to derive; it is written
// beside the ceiling rule it qualifies so the contract can never print the
// formula without the condition the formula cannot express.
export const ADJACENT_SENTENCE_SHAPE_RULE =
  'and no two paragraphs standing next to each other may carry one shape at all,'
  + ' because the parallelism that ceiling leaves room for is parallelism spread through the letter,'
  + ' not paragraphs running together';

/**
 * Names where each repeat sits. A paragraph number alone was enough while only
 * closings were read; now that any sentence can carry the shape, the sentence
 * ordinal is the difference between an observation and a hunt.
 */
function joinShapeLocations(locations) {
  const parts = locations.map(({ paragraph, sentence }) => `paragraph ${paragraph} sentence ${sentence}`);
  if (parts.length < 2) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The locations of one shape that sit in consecutive paragraphs, in paragraph
 * order. A location with no neighbour one paragraph away is dropped: a shape in
 * paragraphs 1 and 4 is spread parallelism the ceiling governs, and naming
 * paragraph 1 in an adjacency report would point the writer at a sentence the
 * report is not about.
 */
function backToBackShapeLocations(locations) {
  const ordered = [...locations].sort((left, right) => left.paragraph - right.paragraph || left.sentence - right.sentence);
  return ordered.filter((location, index) => ordered.some((other, otherIndex) =>
    otherIndex !== index && Math.abs(other.paragraph - location.paragraph) === 1));
}

/**
 * How many of those sentences have to move. Breaking a run of consecutive
 * paragraphs takes every second paragraph in the run, so a pair costs one
 * rewrite and a triad also costs one: the middle. Each maximal run is counted
 * on its own, because two separate adjacent pairs of one shape are two repairs.
 */
function backToBackShapeRewrites(locations) {
  let rewrites = 0;
  let run = 1;
  for (let index = 1; index <= locations.length; index++) {
    const continues = index < locations.length && locations[index].paragraph - locations[index - 1].paragraph === 1;
    if (continues) {
      run += 1;
      continue;
    }
    rewrites += Math.floor(run / 2);
    run = 1;
  }
  return rewrites;
}

/**
 * Every sentence shape the letter carries, and which of them the shape check
 * reports: the ones over the count ceiling, and the ones carried by paragraphs
 * standing next to each other. One reading shared by checkRepeatedSentenceShape
 * and by checkRepeatedTransferCarrier, which must not name a pair of sentences
 * this one already reports. `list` is the letter's non-empty paragraph texts.
 */
function sentenceShapeAnalysis(list) {
  const shapes = new Map();
  list.forEach((paragraph, index) => {
    const seen = new Set();
    sentences(paragraph).forEach((sentence, position) => {
      const frame = sentenceShapeFrame(sentence);
      if (!frame || seen.has(frame)) return;
      seen.add(frame);
      shapes.set(frame, [...(shapes.get(frame) || []), { paragraph: index + 1, sentence: position + 1 }]);
    });
  });
  const ceiling = sharedSentenceShapeCeiling(list.length);
  const over = [...shapes]
    .filter(([, locations]) => locations.length > ceiling)
    .sort((left, right) => right[1].length - left[1].length);
  // The ceiling counts, and a count cannot see distance. It exists to permit
  // deliberate parallelism, which is why it allows a shape in all but two
  // paragraphs; but what a reader registers as one template filled twice is
  // back-to-back, and two adjacent paragraphs are always at or under a ceiling
  // that starts at two. A live letter is the measurement: paragraph 2 opened
  // "In that role, my <field> experience includes" and paragraph 3 answered
  // "In that <title> role, my <other field> experience spans", one shape in
  // consecutive paragraphs, two of four, and the whole battery passed it. So adjacency is read as its own defect, and
  // only for shapes the count has not already reported, because a shape over
  // the ceiling is the same defect and must not be named twice in one message.
  //
  // This branch charges a shape checkRepeatedPhrase excuses the words of, and on
  // that same letter it does: it reports paragraph 1 sentence 5 and paragraph 2
  // sentence 4 for one shape, "i would * that *", while
  // repeatComparisonSentence removes those very words from the repeat
  // comparison. Read as one rule the pair looks contradictory; they are two
  // levels of one policy. A stock transfer frame is a choice the writer makes,
  // never a requirement, and the words of a frame are not charged twice (the
  // budget and the repeated-transfer-carrier check police the frame). Reaching
  // for the same shape again in the very next paragraph is reported here, where
  // the shape is read: paragraph 3 of that letter shows the alternative was
  // available, transferring on "I can apply that" while 1 and 2 both used
  // "I would apply that". The asymmetry is the design.
  const adjacent = [...shapes]
    .filter(([frame, locations]) => !over.some(([reported]) => reported === frame)
      && backToBackShapeLocations(locations).length > 0)
    .map(([frame, locations]) => [frame, backToBackShapeLocations(locations)])
    .sort((left, right) => right[1].length - left[1].length
      || left[1][0].paragraph - right[1][0].paragraph);
  return { shapes, ceiling, over, adjacent };
}

/**
 * When every paragraph makes its move the same way, the letter reads as one
 * template filled four times rather than an argument developed four ways. No
 * run-length check can see this: a template rotates the verb and the noun
 * through fixed slots, so two sentences built on one frame share no run long
 * enough to register, and `checkRedundancy` compares the letter to the RÉSUMÉ
 * rather than paragraph to paragraph. This compares shapes instead, and
 * reports only the count, the shape it read, and where it read it — whether
 * that shape is filler or deliberate parallelism is the writer's judgement,
 * which is why the ceiling leaves room for a parallel pair or a parallel triad
 * in a long letter.
 *
 * Every sentence is read, not only the closing one. Reading a single position
 * measured the position rather than the template: the live letter of
 * 2026-09-21 was rejected for four paragraphs closing on one shape, came back
 * with two closings rotated, and still opened every paragraph's evidence with
 * one frame, which this check could not see and which a reader sees first. A
 * paragraph is counted once per shape however often it repeats that shape
 * inside itself, so parallelism a writer builds within one paragraph is its
 * own business.
 */
export function checkRepeatedSentenceShape(paragraphs = []) {
  const list = (Array.isArray(paragraphs) ? paragraphs : []).map(text).filter(Boolean);
  if (list.length < MIN_SHARED_SHAPE_PARAGRAPHS) {
    return result('repeated-sentence-shape', true,
      `letter has ${list.length} paragraph(s); sentence shapes are compared from ${MIN_SHARED_SHAPE_PARAGRAPHS}`);
  }
  const { ceiling, over, adjacent } = sentenceShapeAnalysis(list);
  if (!over.length && !adjacent.length) {
    return result('repeated-sentence-shape', true,
      `no sentence shape is carried by more than ${ceiling} of ${list.length} paragraph(s) or by two consecutive paragraphs`);
  }
  // No em dash and no suggested replacement wording: this detail is quoted
  // back to the writer verbatim, and a gate that hands over a string hands
  // over something to copy into the letter.
  // The ceiling alone left the writer to subtract: a repair measured against
  // this message rotated one sentence out of four, which still left three on
  // the shape, and cost a whole round to a count the check had already done.
  const visible = over.slice(0, MAX_REPEATED_SHAPE_OBSERVATIONS);
  const omitted = over.length - visible.length;
  const reports = visible.map(([frame, locations]) =>
    `${joinShapeLocations(locations)} reduce to the same sentence shape “${boundedDetailValue(frame)}”,`
    + ` and at most ${ceiling} of these ${list.length} paragraphs may carry one shape,`
    + ` so at least ${locations.length - ceiling} of those ${locations.length} sentences must be rewritten to a different shape`);
  // The adjacency report does the same arithmetic the count report does, so the
  // writer is never left to work out how many sentences have to move: breaking
  // a run of N consecutive paragraphs takes every second one of them.
  const adjacentVisible = adjacent.slice(0, MAX_REPEATED_SHAPE_OBSERVATIONS);
  const adjacentOmitted = adjacent.length - adjacentVisible.length;
  const adjacentReports = adjacentVisible.map(([frame, locations]) =>
    `${joinShapeLocations(locations)} carry the same sentence shape “${boundedDetailValue(frame)}” in back-to-back paragraphs,`
    + ` and the ${ceiling} paragraphs the count allows one shape are for parallelism spread through the letter rather than for paragraphs running together,`
    + ` so at least ${backToBackShapeRewrites(locations)} of those ${locations.length} sentences must be rewritten to a different shape`);
  return result('repeated-sentence-shape', false,
    `${[...reports, ...adjacentReports].join('; ')}`
    + `${omitted ? `; ${omitted} additional repeated shape(s) omitted` : ''}`
    + `${adjacentOmitted ? `; ${adjacentOmitted} additional back-to-back shape(s) omitted` : ''};`
    + ` a sentence shape is that sentence's first ${SENTENCE_SHAPE_FRAME_WORDS} words with every run of content words shown as ${FRAME_WILDCARD},`
    + ` so rotating the verb or the noun through the same slots leaves it unchanged`);
}

// Derived from the cue the argument gate enforces rather than restated, so the
// rule that MANDATES the carrier and the exclusion that excuses it can never
// drift apart. Only the global flag differs: the exclusion has to find every
// carrier in a sentence, not the first one. matchAll iterates a clone, so the
// shared literal's lastIndex is never carried between callers.
const FORMULAIC_TRANSFER_FRAME_GLOBAL = new RegExp(FORMULAIC_TRANSFER_FRAME.source, `${FORMULAIC_TRANSFER_FRAME.flags}g`);
// A blanked position stands for a word removed from the comparison. Real tokens
// come out of WORD_TOKEN_RE, which matches letters, digits and two connectors,
// so no word of the letter can contain a space or a colon and none of them can
// ever equal one of these. The position is part of the value because two
// blanked positions must not match each other either: two sentences that both
// dropped the same carrier would otherwise read as sharing it.
const BLANKED_TOKEN_PREFIX = 'blanked ';

function blankedToken(key, index) {
  return `${BLANKED_TOKEN_PREFIX}${key}:${index}`;
}

/** Every occurrence of one word run replaced by blanks the comparison cannot match. */
function blankWordRun(tokens, runWords, key) {
  if (!runWords.length) return tokens;
  const blanked = [...tokens];
  for (let index = 0; index + runWords.length <= tokens.length; index++) {
    if (!runWords.every((word, offset) => tokens[index + offset] === word)) continue;
    for (let offset = 0; offset < runWords.length; offset++) blanked[index + offset] = blankedToken(key, index + offset);
  }
  return blanked;
}

// The phrase a transfer carrier hands over, and why the walk below reads only a
// determiner-headed one. A stock frame points back at the proof with a bare
// back-reference in six fixed phrases only, so a capability that fits none of
// them has to be NAMED again in the frame, and that re-naming is the noun
// phrase the carrier's verb takes: “I would apply THAT <CAPABILITY> APPROACH”,
// “I would apply MY EXPERIENCE DELIVERING <THINGS>”. The frame dictates both,
// and both land beside the claim they answer inside one paragraph.
//
// A carrier whose own match already reaches the capability noun (“apply that
// experience”) has named what it transfers inside the match, so there is nothing
// to walk; and the two cue shapes that end on the TARGET rather than on a
// capability (“helping this role”, “supporting your team”) are followed by the
// target's own words, which no frame dictates. Requiring a determiner is what
// separates the two cases without a second cue list.
const TRANSFERRED_CAPABILITY_DETERMINERS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'our', 'its', 'their', 'his', 'her',
]);
// The real end of either phrase is the first function word after it, which is
// what stops the walk on every letter measured so far; this is the bound for a
// sentence that has no function word left. Five words is the longest re-naming
// the measured letters carry (“my experience delivering <things>”), so
// six leaves one word of headroom and still cannot swallow a sentence's tail.
const MAX_TRANSFERRED_CAPABILITY_WORDS = 6;
// Where the stock frames put the responsibility the transfer reaches: apply,
// bring, use or contribute the capability TO the responsibility. The
// responsibility has to be named — relevanceNamesNeed grades the relevance span
// for two content words of its jobNeedQuote — and at the drafting stage no
// caller yet holds that quote, so the slot the frame dictates is read instead of
// the words it will later be graded against. Only this one
// preposition: a measured letter hung “across <two areas>” off its capability
// phrase before reaching “to <responsibility> …”, and reading
// every preposition would have excused exactly the echo this round is for.
const TRANSFER_TARGET_PREPOSITION = 'to';
// The back-references a stock frame may use in place of re-naming the
// capability. Pointing back at the proof is not restating it, so they are
// excused from the repeat comparison. Global copies only: the exclusion has to
// find every occurrence in a sentence, not the first.
const PERMITTED_ANAPHORA_GLOBAL = [
  DIRECT_PROOF_ANAPHORA, DIRECT_PROOF_ARTIFACT_REFERENCE, DIRECT_PROOF_PRONOUN_REFERENCE,
].map(pattern => new RegExp(pattern.source, `${pattern.flags}g`));

/** Character spans one regex matches in a sentence. */
function matchedSpans(source, pattern) {
  return [...source.matchAll(pattern)].map(match => ({ start: match.index, end: match.index + match[0].length }));
}

/** Whether a token sits inside any of those spans. */
function tokenInSpans(token, spans) {
  return spans.some(span => token.start < span.end && token.end > span.start);
}

/**
 * Token positions of one noun phrase: its determiner, then its words up to the
 * first function word.
 *
 * A function word is where a noun phrase ends: “that <capability> approach ACROSS
 * <areas>” ends at “across”, “my experience delivering <things>
 * TO <responsibility>” at “to”, “the <responsibility> THIS role
 * needs” at “this”. FRAME_FUNCTION_WORDS is the same closed set the shape check
 * holds literal and runContentWordCount counts against, so the three checks
 * agree on which words are syntax.
 *
 * `requireDeterminer` is what separates the two slots. A capability handed over
 * is written with one (“that <capability> approach”, “my experience delivering
 * <things>”), and requiring it is what keeps the walk off a carrier
 * that already named the capability inside its own match (“apply that experience
 * to …”, where the next word is the preposition) and off the two cue shapes that
 * end on the target rather than a capability. A responsibility is as often bare
 * (“to <responsibility>”) as determined (“to the <responsibility>
 * this role needs”), so the target slot takes either.
 */
function nounPhrasePositions(tokens, start, { requireDeterminer }) {
  if (start < 0 || start >= tokens.length) return [];
  const determined = TRANSFERRED_CAPABILITY_DETERMINERS.has(tokens[start].word);
  if (requireDeterminer && !determined) return [];
  const positions = determined ? [start] : [];
  for (let index = determined ? start + 1 : start;
    index < tokens.length && positions.length < MAX_TRANSFERRED_CAPABILITY_WORDS; index++) {
    if (FRAME_FUNCTION_WORDS.has(tokens[index].word)) break;
    positions.push(index);
  }
  return positions;
}

/**
 * Token positions one carrier's dictated phrases occupy: the capability it hands
 * over, and the responsibility it reaches.
 *
 * Everything between the two is the writer's own, which is the whole point of
 * reading them as two phrases rather than as one span from the carrier to the
 * end of the sentence. On the measured letter that middle is “across <two
 * areas>”, carried verbatim out of the proof sentence three sentences earlier.
 */
function transferPhrasePositions(tokens, carrier) {
  const afterCarrier = tokens.findIndex(token => token.start >= carrier.end);
  if (afterCarrier < 0) return { capability: [], target: [] };
  const capability = nounPhrasePositions(tokens, afterCarrier, { requireDeterminer: true });
  const searchFrom = capability.length ? capability[capability.length - 1] + 1 : afterCarrier;
  const preposition = tokens
    .findIndex((token, index) => index >= searchFrom && token.word === TRANSFER_TARGET_PREPOSITION);
  const target = preposition < 0 ? [] : nounPhrasePositions(tokens, preposition + 1, { requireDeterminer: false });
  return { capability, target };
}

function dictatedTransferPositions(tokens, carrier) {
  const { capability, target } = transferPhrasePositions(tokens, carrier);
  return [...capability, ...target];
}

/**
 * One sentence as a comparable word stream, with the words a stock transfer
 * frame occupies blanked out, plus a second stream for the comparison against
 * its OWN paragraph, where the frame dictates more of the sentence than the
 * carrier.
 *
 * FORMULAIC_TRANSFER_FRAME is a stock frame, and its words are not charged here.
 * Two other checks police the frame itself: the budget (checkTransferCarrierBudget)
 * allows it in at most MAX_EXPLICIT_TRANSFER_PARAGRAPHS paragraphs, and
 * checkRepeatedTransferCarrier and the shape check refuse one form in neighbouring
 * paragraphs, so charging the same words again here would report one defect three
 * times. The carrier's words are removed from the comparison rather than
 * filtered off the result, because longestSharedRun answers with one run per
 * pair: post-filtering the carrier would let it stand in front of a real repeat
 * in the same pair of sentences and hide it, which is exactly what happens in
 * a measured letter, where one pair of transfer sentences carries both the
 * carrier and a four-word run the writer repeated on top of it.
 *
 * This excuses the carrier's WORDS while checkRepeatedSentenceShape's adjacency
 * branch charges its SHAPE, and on a measured letter both fired that way at once:
 * nothing here reported "i would apply that", and that check reported paragraph 1
 * sentence 5 and paragraph 2 sentence 4 for carrying one shape in back-to-back
 * paragraphs. They are two levels of one policy. Choosing the SAME shape in two
 * paragraphs that stand next to each other is a choice the writer makes, so it is
 * reported where the shape is read; the words of a frame are then not charged a
 * second time where the phrases are compared.
 *
 * The second stream is what a transfer sentence is compared as against the rest
 * of ITS OWN paragraph, and it exists because the first build of this exclusion
 * took the whole sentence out of that comparison. Inside one paragraph a stock
 * frame dictates the CONTENT of its sentence too: the capability has to be
 * re-named (see TRANSFERRED_CAPABILITY_DETERMINERS) and the sentence reaches the
 * responsibility its jobNeedQuote came from, so the need gets named again as
 * well, and both re-namings land beside the claim and the need they answer.
 * Comparing them made this check contradict the frame it is excusing, and it did:
 * comparing the whole sentence failed 39 test sites that assert a well-formed
 * fixture letter is accepted, 38 of them on one shared fixture paragraph.
 *
 * But blanking the WHOLE sentence overshoots, and a measured letter is the
 * cost. Its paragraph 1 stated “<capability> across <two areas>” in sentences 2
 * and 3 and then closed on “I would apply that <capability> approach across
 * <two areas> to …”. “That <capability> approach” is the re-naming the frame
 * dictates; “across <two areas>” is elaboration hung off it and a verbatim echo
 * of sentence 3 that the whole-sentence exemption could not see. So only the
 * dictated words come out: the carrier, the capability phrase it hands over, the
 * responsibility phrase it reaches, the back-references permitted in place of
 * the capability phrase, and the paragraph's own job-need vocabulary where a
 * caller holds the quote. Everything else in the sentence is compared exactly as
 * any other sentence is.
 *
 * Across paragraphs nothing is blanked but the carrier. Nothing asks two
 * paragraphs to transfer the same capability in the same words, and the measured
 * letter carried one four-word run from one transfer sentence into the next.
 */
function repeatComparisonSentence(sentence, key, jobNeedQuote) {
  const source = normalized(sentence);
  const tokens = [...source.matchAll(WORD_TOKEN_RE)]
    .map(match => ({ word: match[0], start: match.index, end: match.index + match[0].length }));
  const carriers = matchedSpans(source, FORMULAIC_TRANSFER_FRAME_GLOBAL);
  const carried = tokens.map(token => tokenInSpans(token, carriers));
  const words = tokens.map((token, index) => (carried[index] ? blankedToken(key, index) : token.word));
  // A sentence with no carrier is under no content mandate at either distance,
  // so it is compared as one stream and the two are the same array.
  if (!carriers.length) return { words, sameParagraphWords: words };
  const anaphora = PERMITTED_ANAPHORA_GLOBAL.flatMap(pattern => matchedSpans(source, pattern));
  const dictated = new Set(carriers.flatMap(carrier => dictatedTransferPositions(tokens, carrier)));
  // argumentContentWords is the same reader relevanceNamesNeed grades the
  // overlap with, so the words excused here are exactly the ones that gate
  // makes the sentence carry: its stop words and its plural folding included.
  const needTerms = new Set(argumentContentWords(jobNeedQuote));
  const sameParagraphWords = tokens.map((token, index) => (
    carried[index] || dictated.has(index) || tokenInSpans(token, anaphora)
      || argumentContentWords(token.word).some(term => needTerms.has(term))
      ? blankedToken(key, index)
      : token.word));
  return { words, sameParagraphWords };
}

/**
 * The letter's sentences as comparable word streams, each tagged with where it
 * sits. `jobNeedQuotes` is indexed by paragraph: the quote the paragraph's
 * argument mapping answers, where the caller holds one.
 */
function repeatComparisonUnits(paragraphs, jobNeedQuotes = []) {
  const units = [];
  paragraphs.forEach((paragraph, paragraphIndex) => {
    sentences(paragraph).forEach((sentence, sentenceIndex) => {
      const key = `${paragraphIndex}.${sentenceIndex}`;
      units.push({
        paragraph: paragraphIndex + 1,
        sentence: sentenceIndex + 1,
        key,
        ...repeatComparisonSentence(sentence, key, jobNeedQuotes[paragraphIndex] || ''),
      });
    });
  });
  return units;
}

/** The stream one unit is compared as at one distance, with its blanking key. */
function comparedUnit(unit, together) {
  return { key: unit.key, words: together ? unit.sameParagraphWords : unit.words };
}

// A name is SUPPOSED to recur. An employer, a product or a project named twice
// is the same thing named twice, and how often a name may be repeated is
// already governed by checkPriorEmployerOpening, checkOpeningEmployerShorthand
// and checkAdjacentEmployerRepetition, so a run of nothing but names belongs to
// them and not here. Capitalization is read across the whole letter rather than
// at the occurrence, because a name is capitalized wherever it appears while an
// ordinary word is capitalized only where a sentence happens to open with it,
// and a run of ordinary words is never capitalized the whole way through.
const CAPITALIZED_TOKEN_RE = /\p{Lu}[\p{L}\p{N}]*(?:['’-][\p{L}\p{N}]+)*/gu;

function capitalizedSourceWords(paragraphs) {
  const found = new Set();
  paragraphs.forEach(paragraph => {
    for (const match of text(paragraph).matchAll(CAPITALIZED_TOKEN_RE)) {
      words(match[0]).forEach(word => found.add(word));
    }
  });
  return found;
}

/**
 * How many words of a run carry content, by the ONE closed set this file keeps
 * for the distinction: FRAME_FUNCTION_WORDS, the articles, pronouns,
 * determiners, auxiliaries, modals, common prepositions and conjunctions the
 * sentence-shape frame holds literal. A word is content exactly when that set
 * does not hold it. Reusing the set rather than authoring a second stopword list
 * is what keeps the two checks agreeing on the word: the shape check erases runs
 * of content and this one counts them, and a word that was content to one and
 * syntax to the other would make the pair incoherent to a reader and to a
 * writer repairing against both. A blanked position can never reach here, so it
 * is not special-cased: its token carries a space and a colon, which
 * WORD_TOKEN_RE cannot produce, and it is unique per sentence and position, so
 * two sentences never share one.
 */
function runContentWordCount(runWords) {
  return runWords.filter(word => !FRAME_FUNCTION_WORDS.has(word)).length;
}

/**
 * The longest run two sentences share that this check is entitled to report, or
 * null. An excused run is blanked out of both sentences and the pair is asked
 * again, so a run of names, or a run that is only syntax, costs the pair its own
 * report and nothing else.
 *
 * Both exclusions share the one peel budget, and the order longestSharedRun
 * answers in is what keeps that safe: it returns the LONGEST run in the pair, so
 * a run peeled off here was at least as long as any repeat still underneath it.
 * A pair that spends the whole budget therefore had that many runs longer than
 * its real repeat, and the cost of the bound is a repeat gone unreported rather
 * than a wrong report, which is the direction this check is tuned in.
 */
function reportableSharedRun(left, right, floor, nameWords) {
  let leftWords = left.words;
  let rightWords = right.words;
  for (let peel = 0; peel <= MAX_EXCUSED_RUN_PEELS; peel++) {
    const run = longestSharedRun(leftWords, rightWords);
    if (run.length < floor) return null;
    // A run of nothing but names is another rule's business (see
    // capitalizedSourceWords). A run carrying fewer than
    // MIN_REPEAT_CONTENT_WORDS content words is ordinary English syntax
    // recurring, not a statement made twice; the constant carries the
    // measurement that put the boundary at two.
    const excused = run.words.every(word => nameWords.has(word))
      || runContentWordCount(run.words) < MIN_REPEAT_CONTENT_WORDS;
    if (!excused) return run.words;
    leftWords = blankWordRun(leftWords, run.words, `${left.key}excused${peel}`);
    rightWords = blankWordRun(rightWords, run.words, `${right.key}excused${peel}`);
  }
  return null;
}

/** Distinct locations of one repeat, in reading order. */
function orderedRepeatLocations(locations) {
  const seen = new Map();
  locations.forEach(location => seen.set(`${location.paragraph}.${location.sentence}`, location));
  return [...seen.values()].sort((left, right) => left.paragraph - right.paragraph || left.sentence - right.sentence);
}

/** Longest repeat first, with a run already contained in a longer one dropped. */
function orderedRepeatedRuns(found) {
  const entries = [...found.values()]
    .map(entry => ({ run: entry.run, locations: orderedRepeatLocations(entry.locations) }))
    .sort((left, right) => right.run.length - left.run.length
      || left.locations[0].paragraph - right.locations[0].paragraph
      || left.locations[0].sentence - right.locations[0].sentence);
  // A shorter run sitting inside a longer reported one is the same repeat seen
  // through a narrower window WHERE it names the same sentences, and reporting
  // both would then spend the observation cap on one sentence pair and ask for
  // one repair twice. It stops being the same repeat the moment it names a
  // sentence the longer run does not: a third sentence reaching for part of
  // those words has its own repair, and rewriting either sentence the longer run
  // names leaves it standing. Dropping it on length alone is what hid sentence 5
  // of the measured letter's paragraph 1, which echoed “<two areas>” out of
  // the six words sentences 2 and 3 already shared.
  //
  // With locations collected from the PAIRS that share a run, every sentence in
  // a run's location set carries that run, so any pair drawn from that set
  // reports the run itself and a contained run always names a sentence from
  // outside the set. The location test therefore excuses nothing today and this
  // filter drops nothing; it is kept as the condition rather than deleted
  // because it is the correct one if a later change ever widens how a run's
  // locations are gathered, and because deleting it would leave the next reader
  // to re-derive why length alone was wrong.
  return entries.filter((entry, index) => !entries.some((other, otherIndex) =>
    otherIndex !== index && other.run.length > entry.run.length && containsWordSequence(other.run, entry.run)
    && entry.locations.every(location => other.locations
      .some(kept => kept.paragraph === location.paragraph && kept.sentence === location.sentence))));
}

// What the letter contract prints for the check below. Every floor is read out
// of the same constants checkRepeatedPhrase compares against, so the shape a
// writer is told to avoid can never drift from the shape it is graded by. Every
// exclusion is stated too, and that is not padding: a writer who does not know
// them over-corrects. The words a stock transfer frame dictates, and a run of
// names, are repeats another check already polices or the letter cannot avoid, so
// rewriting one spends a handoff round for nothing; a
// writer who thinks the ordinary syntax holding two sentences together is
// counted has to write around the language to satisfy a rule that never applied
// to it; and one who is told only that a transfer sentence is treated specially
// hangs the next echo off the phrase it excuses, which is the defect this round
// was opened for, so the clause says what is still counted there.
export const REPEATED_PHRASE_RULE =
  `a verbatim run of ${MIN_SAME_PARAGRAPH_REPEAT_WORDS} words or more repeated inside one paragraph,`
  + ` or of ${MIN_CROSS_PARAGRAPH_REPEAT_WORDS} words or more carried from one paragraph into another,`
  + ' is reported at every position it stands in past the first, wherever in the letter it sits;'
  + ' the words of a stock transfer frame are not counted here, because the transfer budget and the repeated-form rule limit the frame itself,'
  + ' and inside its own paragraph neither is the capability phrase that frame hands over, nor the responsibility phrase it reaches,'
  + ' each read to the first function word that ends it, nor a back-reference standing in for the capability,'
  + ' nor the wording its own paragraph’s job-need quote puts there, since a sentence that names the target has to name that need;'
  + ' what a transfer sentence adds around those words is counted like any other wording.'
  + ' A run of nothing but capitalized names is not counted either,'
  + ` and neither is a run carrying fewer than ${MIN_REPEAT_CONTENT_WORDS} content words,`
  + ' which is the scaffolding two English sentences share rather than either of them reaching back for the other,'
  + ' so make each point in its own words rather than reaching back for the words that made it last time';

/**
 * The letter repeating itself. Nothing in this battery compared a paragraph to
 * itself or to another paragraph: `checkRedundancy` and `checkSalientPhraseEcho`
 * measure the letter against the RÉSUMÉ, `checkRepeatedSentenceShape` compares
 * skeletons with every content word erased, and every other n-gram site takes
 * its needle from the résumé, the plan or a fixed list. So a measured letter
 * stated one "<capability> across <two areas>" phrase twice in one paragraph,
 * opened a sentence in each of two paragraphs with the same
 * "The <noun> was" frame, and named one compound "<modifier> <modifier>
 * <category>" twice in three sentences, and the whole battery passed it.
 *
 * Two floors, one per distance, and both are the reader's position rather than
 * a statistical one: see MIN_SAME_PARAGRAPH_REPEAT_WORDS. Three exclusions. Two
 * of them are repeats another rule asked for: the words the argument contract
 * dictates in a transfer sentence (blanked in repeatComparisonSentence, which
 * carries what each of them is and why the list is longer inside one paragraph
 * than across two) and a run of names (excused in reportableSharedRun). The
 * third is a repeat that is not a restatement at all, whoever asked for it: a
 * run carrying fewer than MIN_REPEAT_CONTENT_WORDS content words is the syntax
 * two English sentences share, and the constant carries the ten measured runs
 * that made the exclusion necessary. The report names the run and where it sits
 * and stops there, because a message that supplied a replacement would be
 * supplying the next letter's wording.
 *
 * What the report does NOT do is say what the repeat means. It used to: "a run
 * of N words or more repeated inside one paragraph is the same statement made
 * twice" asserted a cause, and the cause is untrue wherever the run is a
 * lowercase compound artifact name, because two sentences can make two different
 * statements about one named thing. The design system's own fixture letter is
 * the measurement — its paragraph 1 names one compound artifact in
 * sentence 2 and again in sentence 4, once as what was built and once as what
 * moved onto a third-party platform. That run stays reported: it is
 * indistinguishable in structure from the compound-category repeat
 * this check was written for, and the letter contract already asks a writer to
 * frame an artifact on first mention and then use the shortest unambiguous
 * reference, so a full compound name repeated verbatim is a defect by the
 * contract the letter already has. The wording was what was wrong, so the
 * message now states the run, its length, the positions it stands at, the floor
 * it passed, and what satisfies the rule.
 */
export function checkRepeatedPhrase(paragraphs = [], { jobNeedQuotes = [] } = {}) {
  const list = (Array.isArray(paragraphs) ? paragraphs : []).map(text).filter(Boolean);
  const units = repeatComparisonUnits(list, Array.isArray(jobNeedQuotes) ? jobNeedQuotes : []);
  const nameWords = capitalizedSourceWords(list);
  const sameParagraph = new Map();
  const crossParagraph = new Map();
  for (let left = 0; left < units.length; left++) {
    for (let right = left + 1; right < units.length; right++) {
      const together = units[left].paragraph === units[right].paragraph;
      // Which stream each sentence is compared as carries the whole difference
      // between the two distances: inside one paragraph a transfer sentence is
      // read with the words the argument rules dictate blanked out, and across
      // paragraphs with only its carrier blanked. repeatComparisonSentence holds
      // the measurement behind that split.
      const floor = together ? MIN_SAME_PARAGRAPH_REPEAT_WORDS : MIN_CROSS_PARAGRAPH_REPEAT_WORDS;
      const run = reportableSharedRun(comparedUnit(units[left], together), comparedUnit(units[right], together),
        floor, nameWords);
      if (!run) continue;
      const found = together ? sameParagraph : crossParagraph;
      const phrase = run.join(' ');
      const entry = found.get(phrase) || { run, locations: [] };
      entry.locations.push(units[left], units[right]);
      found.set(phrase, entry);
    }
  }
  // Same-paragraph repeats lead. They are the ones a reader hits hardest, they
  // are repaired inside one paragraph, and the measured letter's own complaint
  // was one of them.
  const observations = [
    ...orderedRepeatedRuns(sameParagraph).map(({ run, locations }) =>
      `${joinShapeLocations(locations)} repeat one run of ${run.length} words, ${quotedRunPhrase(run)}, inside paragraph ${locations[0].paragraph};`
      + ` the floor inside one paragraph is ${MIN_SAME_PARAGRAPH_REPEAT_WORDS} words, and a run at or past it satisfies the rule while it stands at one position only,`
      + ` so all but one of those ${locations.length} sentences has to make its point without it`),
    ...orderedRepeatedRuns(crossParagraph).map(({ run, locations }) =>
      `${joinShapeLocations(locations)} repeat one run of ${run.length} words, ${quotedRunPhrase(run)}, across paragraphs;`
      + ` the floor from one paragraph into another is ${MIN_CROSS_PARAGRAPH_REPEAT_WORDS} words, and a run at or past it satisfies the rule while it stands at one position only,`
      + ` so all but one of those ${locations.length} sentences has to make its point without it`),
  ];
  return observationResult('repeated-phrase', observations, MAX_REPEATED_PHRASE_OBSERVATIONS,
    `${list.length} paragraph(s) repeat no run of ${MIN_SAME_PARAGRAPH_REPEAT_WORDS} words inside one paragraph`
    + ` and none of ${MIN_CROSS_PARAGRAPH_REPEAT_WORDS} words across paragraphs`);
}

const MAX_TRANSFER_CARRIER_OBSERVATIONS = 4;
const MAX_DANGLING_DEMONSTRATIVE_OBSERVATIONS = 4;

// A letter may carry a stock transfer frame in at most
// MAX_EXPLICIT_TRANSFER_PARAGRAPHS paragraphs (see checkTransferCarrierBudget)
// and no rule requires one, so the words of a carrier are a choice that the
// budget and this check police and checkRepeatedPhrase leaves alone. What is
// reported here is reaching for the SAME form in the paragraph right after: a
// shipped letter handed paragraph 2's proof over with “That <field> experience
// would support …” and paragraph 3's with “That <noun> would support …”, and
// passed every check because checkRepeatedSentenceShape compares a five-word
// frame whose fifth slot differed (“… and” against “… for”). Both sentences
// are one transfer form once the noun phrase and the verb are read as slots,
// which is what the normalization below does. The repair asked for is the
// writer's own wording, never a different member of a list: nothing here
// names a form to move to.
//
// The rule says exactly what the code does, because a writer told a looser
// version rotates the wrong part. After I only WOULD or CAN is a modal slot, so
// “I would apply that X” and “I would bring my Y” are one form whatever
// follows the verb; a carrier led by a noun phrase keeps its determiner and
// would; and any other carrier is its bare verb, determiner and noun slot, so a
// modal the cue does not list (will, could) stands in front of it without
// making a form of its own. The examples use X and Y rather than words: a gate
// that names a string gets it copied.
export const REPEATED_TRANSFER_CARRIER_RULE =
  'a stock transfer frame is never required, and every carrier-shaped phrase is read in any two consecutive paragraphs,'
  + ' the opening and the closing included, so two paragraphs standing next to each other may not both carry the same form;'
  + ' a form is what is left of the carrier once its verb and its noun are slots, so changing only the verb or only the noun keeps the same form:'
  + ' after I, only would or can is part of the form, so “I would apply that X” and “I would bring my Y” are one form, and “I can bring” is another;'
  + ' a carrier led by that, this, these, those or the and a noun phrase keeps that determiner and would,'
  + ' so “that X would support” and “that Y would help” are one form;'
  + ' any other carrier keeps its determiner and a would standing directly before its verb, and no other modal,'
  + ' so “will apply that X” and “could apply that Y” are one form;'
  + ' reaching for one form again in the very next paragraph is a choice, because no rule requires a carrier at all,'
  + ' and the repair is your own wording in one of the two paragraphs, not a different stock form';

const TRANSFER_FORM_SUBJECT_RE = /^(that|this|these|those|the)\s+.+\s+(would)\s+(?:help|support|enable)$/u;
const TRANSFER_FORM_FIRST_PERSON_RE = /^i\s+(would|can)\s+(?:apply|bring|use|contribute)$/u;
const TRANSFER_FORM_OBJECT_RE = /^((?:would\s+)?)(?:apply|bring|use|contribute)\s+(that|this|my|the)\s+\S+$/u;
// The verb slot of a form. Angle brackets keep it from being read as a word of
// the letter, and it is deliberately not one of the verbs the cue accepts: a
// message that showed a real verb would hand the writer a string to copy.
const TRANSFER_FORM_VERB_SLOT = '<verb>';

/**
 * The form of one matched transfer carrier: the words the writer chose to carry
 * it, with the parts that rotate through it left as slots. The noun phrase is a
 * wildcard and the verb family (apply, bring, use, contribute; help, support,
 * enable) is a verb slot, because swapping only the verb or only the noun leaves
 * the form unchanged, which is the same reading the shape check gives a
 * sentence. The modal and the determiner stay where the rule above says they do.
 * Anything that matches no slot-bearing shape (“helping the team”) is its own
 * form as written.
 */
function transferCarrierForm(carrier) {
  const value = normalized(carrier);
  const subject = TRANSFER_FORM_SUBJECT_RE.exec(value);
  if (subject) return `${subject[1]} ${FRAME_WILDCARD} ${subject[2]} ${TRANSFER_FORM_VERB_SLOT}`;
  const firstPerson = TRANSFER_FORM_FIRST_PERSON_RE.exec(value);
  if (firstPerson) return `i ${firstPerson[1]} ${TRANSFER_FORM_VERB_SLOT}`;
  const object = TRANSFER_FORM_OBJECT_RE.exec(value);
  if (object) return `${object[1]}${TRANSFER_FORM_VERB_SLOT} ${object[2]} ${FRAME_WILDCARD}`;
  return value;
}

// The two cue shapes that end on the TARGET (“helping this role”, “supporting your
// team”) are not read. They carry no capability noun, so they are ordinary
// English that any sentence about the employer can contain (“to support the
// team”), and a body paragraph and the closing one sharing it is not two proofs
// handed over the same way. Only a carrier that names what is being handed over,
// or the act of handing it, is a form the writer chose to transfer with.
const TARGET_ONLY_CARRIER_RE = /^(?:help|support)/u;

/** Every transfer carrier form in a paragraph, with the sentence that carries it. */
function paragraphTransferForms(paragraph) {
  const forms = new Map();
  sentences(paragraph).forEach((sentence, position) => {
    for (const match of normalized(sentence).matchAll(FORMULAIC_TRANSFER_FRAME_GLOBAL)) {
      const form = transferCarrierForm(match[0]);
      if (TARGET_ONLY_CARRIER_RE.test(form)) continue;
      if (!forms.has(form)) forms.set(form, { sentence: position + 1, frame: sentenceShapeFrame(sentence) });
    }
  });
  return forms;
}

function joinAlternatives(items) {
  if (items.length < 2) return items[0] || '';
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/**
 * Two paragraphs standing next to each other carry the same transfer form.
 *
 * A pair the sentence-shape check also reports is reported here too. Suppressing
 * it left a hole: a repair that answers the shape report alone can keep the
 * carrier, and the same two sentences then fail this check a round later. One
 * rewrite of a carrier clears both, so a double report costs nothing, and the
 * message says when the two name the same sentences so the writer makes one
 * edit that answers both rather than two that conflict.
 *
 * The message also names the forms the pair's OUTER neighbours use. Rotating a
 * pair's end paragraph onto the form of the paragraph beyond it moves the
 * defect one paragraph over, which is what a message that named only the
 * shared form invited.
 */
export function checkRepeatedTransferCarrier(paragraphs = []) {
  const list = (Array.isArray(paragraphs) ? paragraphs : []).map(text).filter(Boolean);
  const perParagraph = list.map(paragraphTransferForms);
  const reportedShapes = new Map();
  if (list.length >= MIN_SHARED_SHAPE_PARAGRAPHS) {
    const { over, adjacent } = sentenceShapeAnalysis(list);
    for (const [frame, locations] of [...over, ...adjacent]) {
      reportedShapes.set(frame, new Set([...(reportedShapes.get(frame) || []), ...locations.map(location => location.paragraph)]));
    }
  }
  const pairs = new Map();
  for (let index = 0; index + 1 < list.length; index++) {
    for (const [form, here] of perParagraph[index]) {
      const next = perParagraph[index + 1].get(form);
      if (!next) continue;
      const reported = reportedShapes.get(here.frame);
      const sameShapeReport = Boolean(here.frame && here.frame === next.frame && reported?.has(index + 1) && reported.has(index + 2));
      pairs.set(form, [...(pairs.get(form) || []), { paragraph: index + 1, here, next, sameShapeReport }]);
    }
  }
  const neighbourForms = (paragraphNumber, shared) => (perParagraph[paragraphNumber - 1] ? [...perParagraph[paragraphNumber - 1].keys()] : [])
    .filter(form => form !== shared)
    .map(form => `“${boundedDetailValue(form)}” (paragraph ${paragraphNumber} uses it)`);
  const observations = [];
  for (const [form, found] of pairs) {
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const last = run[run.length - 1];
      const spanned = [...run.map(pair => pair.paragraph), last.paragraph + 1];
      const where = [...run.map(pair => `paragraph ${pair.paragraph} sentence ${pair.here.sentence}`),
        `paragraph ${last.paragraph + 1} sentence ${last.next.sentence}`];
      const named = spanned.length === 2
        ? `paragraphs ${spanned[0]} and ${spanned[1]} both carry`
        : `paragraphs ${spanned.slice(0, -1).join(', ')} and ${spanned[spanned.length - 1]} all carry`;
      const repair = spanned.length === 2
        ? 'one of them'
        : `at least ${Math.floor(spanned.length / 2)} of them so that no two neighbouring paragraphs share it`;
      const avoid = [...neighbourForms(spanned[0] - 1, form), ...neighbourForms(spanned[spanned.length - 1] + 1, form)];
      const sameShape = run.some(pair => pair.sameShapeReport);
      observations.push({
        start: spanned[0],
        message: `${named} the same transfer form “${boundedDetailValue(form)}” (${where.join(', ')});`
          + ` rewrite the carrier in ${repair} in your own wording, since no stock transfer form is required${avoid.length ? ` and ${joinAlternatives(avoid)} would be the same defect again` : ''}`
          + `${sameShape ? '; repeated-sentence-shape reports these same sentences, so one rewrite that changes both the carrier form and the sentence shape answers both reports' : ''}`,
      });
      run = [];
    };
    for (const pair of found) {
      if (run.length && pair.paragraph !== run[run.length - 1].paragraph + 1) flush();
      run.push(pair);
    }
    flush();
  }
  observations.sort((left, right) => left.start - right.start);
  return observationResult('repeated-transfer-carrier', observations.map(({ message }) => message), MAX_TRANSFER_CARRIER_OBSERVATIONS,
    `${list.length} paragraph(s) carry no transfer form in two consecutive paragraphs`);
}

// The one place a demonstrative's noun is a CLOSED vocabulary. Judging every
// sentence-opening “That <noun>” read open English without a part-of-speech
// tagger, and it was wrong in every direction: “I rebuilt the API. That rebuild
// …”, “This cut p95 latency …”, “These safeguards …”, “That reliability …”
// after “reliable”, and the claim-span rule's own “That difficulty lay in …”
// were all reported, and each repair for a true report broke a second rule. So
// this reads only the demonstrative-headed TRANSFER CARRIER in its subject
// shape, whose nouns FORMULAIC_TRANSFER_FRAME lists, and only the nouns the
// back-references below do not already excuse.
//
// The object shape (“I would apply that capability”) is deliberately NOT read.
// It sits directly after the proof sentence it transfers, so its noun reads as
// a summary of the action just described rather than as a term nobody has
// introduced, and a shipped letter's paragraph 1 measured that way: flagging it
// was a false positive. A sentence that OPENS on the demonstrative and names a
// quality with no referent is what reads as dangling, so only that is judged.
//
// “That experience”, “this experience”, “that work”, “this work”, “those
// patterns” and “these patterns” point back at the proof sentence with nothing
// earlier required, so those three nouns are exempt. The others (capability, approach, judgment, practice)
// have no such licence: a paragraph about a practice that turns its proof
// toward the employer with “That <noun> would support …” names a second
// abstraction nobody has introduced, which is what the shipped sentence did.
const DEMONSTRATIVE_EXEMPT_CARRIER_NOUN_LIST = Object.freeze(['experience', 'work', 'pattern', 'patterns']);
const DEMONSTRATIVE_EXEMPT_CARRIER_NOUNS = new Set(DEMONSTRATIVE_EXEMPT_CARRIER_NOUN_LIST);
const DEMONSTRATIVE_JUDGED_SUBJECT_NOUNS = Object.freeze(
  TRANSFER_CUE_SUBJECT_NOUNS.filter(noun => !DEMONSTRATIVE_EXEMPT_CARRIER_NOUNS.has(noun)));
// The nouns the rule prints: the singular of each judged noun, read off the
// same array the regex below is built from.
const DEMONSTRATIVE_JUDGED_NOUN_LIST = Object.freeze(DEMONSTRATIVE_JUDGED_SUBJECT_NOUNS.filter(noun => !noun.endsWith('s')));

export const DANGLING_DEMONSTRATIVE_RULE =
  'a sentence after the first of its paragraph that turns its proof toward the employer with that, this, these or those,'
  + ` then any modifiers, then ${joinAlternatives(DEMONSTRATIVE_JUDGED_NOUN_LIST)} (or its plural) and would help, support or enable,`
  + ' must find that noun, or a word standing before it in the carrier, or a form of one of them,'
  + ' in an earlier sentence of the same paragraph, so put a word an earlier sentence of the paragraph uses for that capability directly before the noun,'
  + ` or use one of the back-references that name ${joinAlternatives([...DEMONSTRATIVE_EXEMPT_CARRIER_NOUN_LIST])} and need no earlier mention;`
  + ' no object-position carrier such as apply that X, and no other sentence that opens with a demonstrative, is read here';

const DEMONSTRATIVE_SUBJECT_CARRIER_RE = new RegExp(
  String.raw`\b(that|this|these|those)\s+((?:[\p{L}'’-]+\s+){0,5})(${DEMONSTRATIVE_JUDGED_SUBJECT_NOUNS.join('|')})\s+would\s+(?:help|support|enable)\b`, 'giu');

/** A noun and its plural read as one word, so “capabilities” finds “capability”. */
function carrierNounStem(word) {
  const lower = String(word || '').toLowerCase();
  if (/[^aeiou]ies$/u.test(lower)) return `${lower.slice(0, -3)}y`;
  return /[^s]s$/u.test(lower) ? lower.slice(0, -1) : lower;
}

/**
 * Every demonstrative-headed carrier in one sentence whose noun is judged:
 * where it is, what it says, and the words that can excuse it. Modifier words
 * are the ones standing between the determiner and the noun, minus function
 * words, so “that very approach” is not excused by the “very” an earlier
 * sentence happens to contain.
 */
function demonstrativeCarriers(sentence) {
  const source = normalized(sentence);
  const found = [];
  for (const match of source.matchAll(DEMONSTRATIVE_SUBJECT_CARRIER_RE)) {
    const modifiers = (match[2].match(WORD_TOKEN_RE) || []).filter(word => !FRAME_FUNCTION_WORDS.has(word));
    found.push({ index: match.index, span: match[0], noun: match[3], modifiers });
  }
  return found.sort((left, right) => left.index - right.index);
}

/**
 * A demonstrative-headed transfer carrier, after the first sentence of its
 * paragraph, must find its noun, or a word before that noun in the carrier, in
 * an earlier sentence of the same paragraph. See the constants above for the
 * closed scope and the exemptions, and why nothing else is read.
 */
export function checkDanglingDemonstrative(paragraphs = []) {
  const list = (Array.isArray(paragraphs) ? paragraphs : []).map(text).filter(Boolean);
  const observations = [];
  list.forEach((paragraph, paragraphIndex) => {
    const own = sentences(paragraph);
    own.forEach((sentence, position) => {
      if (position === 0) return;
      const earlier = own.slice(0, position).flatMap(words).flatMap(word => [word, ...word.split('-')]).map(carrierNounStem);
      for (const carrier of demonstrativeCarriers(sentence)) {
        const candidates = [...carrier.modifiers, carrier.noun];
        const referenced = candidates.some(candidate => [candidate, ...candidate.split('-')].some(part => {
          const stem = carrierNounStem(part);
          return earlier.some(word => referentStemsMatch(stem, word));
        }));
        if (referenced) continue;
        const quoted = sentence.slice(carrier.index, carrier.index + carrier.span.length);
        observations.push(`paragraph ${paragraphIndex + 1} sentence ${position + 1} carries “${boundedDetailValue(quoted)}”,`
          + ` but no earlier sentence of paragraph ${paragraphIndex + 1} mentions ${joinAlternatives(candidates.map(candidate => `“${candidate}”`))};`
          + ' put a word an earlier sentence of this paragraph uses for that capability directly before the noun,'
          + ' or use one of the back-references that name experience, work or patterns and need no earlier mention');
        break;
      }
    });
  });
  return observationResult('dangling-demonstrative', observations, MAX_DANGLING_DEMONSTRATIVE_OBSERVATIONS,
    `${list.length} paragraph(s) open no demonstrative transfer carrier on a capability noun the paragraph has not yet used`);
}

// ---------------------------------------------------------------------------
// TRANSFER BUDGET AND BENEFIT SUPPORT
//
// The two checks below police the sentence about the target from the two sides
// the argument gate cannot see. The gate asks that the first
// MAX_EXPLICIT_TRANSFER_PARAGRAPHS proof-bearing paragraphs HAVE one, in any
// wording; nothing before these asked how many paragraphs lean on a stock frame
// for it, or what such a sentence may claim. A letter whose every proof
// paragraph ended on a stock transfer passed every check and read as a
// template, and a sentence about the target that named an operational benefit
// the proof never showed passed too, because the per-sentence grounding rules
// do not read a prospective sentence as a claim. Both read structure and a
// closed vocabulary only, never a name or a phrase of any candidate, employer
// or listing.
// ---------------------------------------------------------------------------

function joinAnd(items) {
  return items.length < 2 ? String(items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function paragraphNumberList(numbers) {
  return `paragraph${numbers.length === 1 ? '' : 's'} ${joinAnd(numbers.map(String))}`;
}

/**
 * More paragraphs carry a stock transfer frame than the letter's budget allows.
 *
 * Counts paragraphs, not carriers: a paragraph with two forms is one paragraph.
 * The two cue shapes that end on the target alone (“helping this role”) are not
 * transfer forms here for the same reason checkRepeatedTransferCarrier does not
 * read them, so they cost nothing. The opening and the closing count, because a
 * closing that hands the work over is the same cadence as a proof paragraph that
 * does. Only the frames are counted: a sentence about the target in the writer's
 * own words is the one thing the letter owes (checkParagraphArgumentLinks) and
 * is never a carrier, however often it appears. The frame the message lets stay
 * is the one in the paragraph that owes the sentence, else the one in the first
 * proof-bearing paragraph that carries one, else the earliest: the paragraphs it
 * tells the writer to rewrite are every other carrier, so removing exactly those
 * always leaves a letter inside the budget, and the owing paragraph is free to
 * word its sentence however it likes. The message names the repair and none of
 * the carrier wording: a message that quotes a string gets it copied.
 */
export function checkTransferCarrierBudget(paragraphs = []) {
  const list = (Array.isArray(paragraphs) ? paragraphs : []).map(text).filter(Boolean);
  const owed = explicitTransferOwed(list);
  const carriers = [];
  list.forEach((paragraph, index) => {
    const forms = paragraphTransferForms(paragraph);
    if (!forms.size) return;
    carriers.push({
      paragraph: index + 1,
      sentence: Math.min(...[...forms.values()].map(found => found.sentence)),
      owed: owed[index],
      proofBearing: paragraphHasCandidatePastProof(paragraph),
    });
  });
  if (carriers.length <= MAX_EXPLICIT_TRANSFER_PARAGRAPHS) {
    return result('transfer-carrier-budget', true,
      `${carriers.length} of ${list.length} paragraph(s) carry a stock transfer frame, within the budget of ${MAX_EXPLICIT_TRANSFER_PARAGRAPHS}`);
  }
  // Which frames stay: the owing paragraph's first, then a proof paragraph's, then the earliest.
  const rank = carrier => (carrier.owed ? 0 : carrier.proofBearing ? 1 : 2);
  const kept = new Set([...carriers].sort((left, right) => rank(left) - rank(right) || left.paragraph - right.paragraph)
    .slice(0, MAX_EXPLICIT_TRANSFER_PARAGRAPHS).map(carrier => carrier.paragraph));
  const excess = carriers.filter(carrier => !kept.has(carrier.paragraph));
  return result('transfer-carrier-budget', false,
    `${paragraphNumberList(carriers.map(carrier => carrier.paragraph))} carry a stock transfer frame, but a letter may carry one in at most ${MAX_EXPLICIT_TRANSFER_PARAGRAPHS} ${MAX_EXPLICIT_TRANSFER_PARAGRAPHS === 1 ? 'paragraph' : 'paragraphs'},`
    + ` the opening and the closing counted, and none is required: the one sentence a letter owes about why its work matters to the target is`
    + ` worded however the writer likes, in ${OWING_PROOF_PARAGRAPHS};`
    + ` end ${paragraphNumberList(excess.map(carrier => carrier.paragraph))} on what the work did by taking the frame out of`
    + ` ${excess.map(carrier => `paragraph ${carrier.paragraph} sentence ${carrier.sentence}`).join(', ')},`
    + ' keeping each paragraph’s proof, so that a proof paragraph closes on its last sentence about the work'
    + ' and an opening or closing states its point without a stock frame');
}

// The benefits a sentence about the target is most often tempted to promise, as closed
// classes. `claimed` are the words that ASSERT the benefit in a transfer
// sentence; they are deliberately narrow (whole words, no verb that is also an
// ordinary action such as perform or scale), because a word listed here can
// reject a sentence. `attested` are the further words that STATE the same
// benefit class in a proof sentence or a quote, and are deliberately wider
// than the claimed ones: a proof that says the work “reduced crashes” or
// “added failover” attests reliability or availability without using those
// words, and rejecting a sentence for a synonym the evidence supplies would
// be a false positive the other way. The effective attestation set of a
// class is claimed + attested. Whole words only, compared lowercase with a
// possessive removed and a hyphenated compound read as its parts.
//
// Classes, with why each is here: availability, reliability, resilience,
// scalability and performance are the operational qualities a prospective
// sentence turns a deployment or integration task into; cost, security,
// accuracy, safety and compliance are the outcome classes a tool or a process
// is credited with. They are generic across fields; none names a technology, a
// product or an employer. A benefit outside this list is not read, which is the
// direction the check errs in.
export const TRANSFER_BENEFIT_CLASSES = Object.freeze([
  {
    name: 'availability',
    claimed: ['availability', 'available', 'uptime', 'downtime', 'outage', 'outages'],
    attested: ['failover', 'redundancy', 'redundant', 'replica', 'replicas', 'replication', 'standby'],
  },
  {
    name: 'reliability',
    claimed: ['reliability', 'reliable', 'reliably', 'dependable', 'dependability', 'stability', 'stable', 'robust', 'robustness'],
    attested: ['stabilize', 'stabilized', 'stabilizing', 'failure', 'failures', 'crash', 'crashes', 'defect', 'defects', 'bug', 'bugs', 'incident', 'incidents', 'flaky', 'monitoring', 'alerting', 'regression', 'regressions'],
  },
  {
    name: 'resilience',
    claimed: ['resilience', 'resilient', 'resiliency', 'tolerant'],
    attested: ['recovery', 'recover', 'recovered', 'recovering', 'failover', 'retry', 'retries', 'fallback', 'fallbacks', 'backup', 'backups', 'redundancy', 'redundant', 'restore', 'restored', 'restoring', 'rollback', 'rollbacks'],
  },
  {
    name: 'scalability',
    claimed: ['scalability', 'scalable', 'elastic', 'elasticity'],
    attested: ['scale', 'scaled', 'scales', 'scaling', 'throughput', 'concurrency', 'concurrent', 'shard', 'shards', 'sharding', 'horizontal', 'capacity', 'load', 'loads'],
  },
  {
    name: 'performance',
    claimed: ['performance', 'performant', 'latency', 'speed', 'faster', 'speedup'],
    attested: ['fast', 'quick', 'quicker', 'quickly', 'optimize', 'optimized', 'optimizing', 'optimization', 'optimizations', 'tuned', 'tuning', 'efficient', 'efficiency', 'throughput', 'cache', 'cached', 'caching', 'parallel', 'parallelized', 'profile', 'profiled', 'profiling'],
  },
  {
    name: 'cost',
    claimed: ['cost', 'costs', 'costly', 'cheaper', 'savings', 'expense', 'expenses'],
    attested: ['save', 'saved', 'saving', 'spend', 'spending', 'budget', 'budgets', 'price', 'prices', 'pricing', 'license', 'licenses', 'licensing', 'billing', 'frugal', 'economical'],
  },
  {
    name: 'security',
    claimed: ['security', 'secure', 'securely', 'secured', 'secures', 'securing'],
    attested: ['authentication', 'authenticate', 'authenticated', 'authorization', 'authorize', 'authorized', 'access', 'permission', 'permissions', 'encryption', 'encrypt', 'encrypted', 'credential', 'credentials', 'password', 'passwords', 'vulnerability', 'vulnerabilities', 'hardening', 'hardened', 'privacy', 'restricted', 'restrict', 'restricting', 'audit', 'audited', 'auditing', 'token', 'tokens', 'sso', 'oauth', 'tls', 'ssl', 'sanitized', 'sanitization', 'threat', 'threats', 'mfa'],
  },
  {
    name: 'accuracy',
    claimed: ['accuracy', 'accurate', 'accurately', 'correctness', 'precise', 'precision', 'exactness'],
    attested: ['validate', 'validated', 'validation', 'validations', 'verify', 'verified', 'verification', 'reconcile', 'reconciled', 'reconciliation', 'correct', 'corrected', 'correction', 'corrections', 'error', 'errors', 'mismatch', 'mismatches', 'consistent', 'consistency', 'integrity', 'checksum'],
  },
  {
    name: 'safety',
    claimed: ['safety', 'safe', 'safely'],
    attested: ['hazard', 'hazards', 'risk', 'risks', 'harm', 'incident', 'incidents', 'protocol', 'protocols', 'compliance', 'compliant', 'regulation', 'regulations', 'regulatory'],
  },
  {
    name: 'compliance',
    claimed: ['compliance', 'compliant'],
    attested: ['regulation', 'regulations', 'regulatory', 'audit', 'audits', 'audited', 'auditing', 'policy', 'policies', 'standard', 'standards', 'certification', 'certified'],
  },
]);
export const TRANSFER_BENEFIT_CLASS_NAMES = Object.freeze(TRANSFER_BENEFIT_CLASSES.map(benefit => benefit.name));
export const TRANSFER_BENEFIT_SUPPORT_RULE = `a sentence of a proof-bearing paragraph that states no action of yours, the sentence about why the work matters to the target included, may name a benefit of the work (${joinAlternatives(TRANSFER_BENEFIT_CLASS_NAMES)}, or a form of one such as its adjective or adverb)`
  + ' only when a proof sentence of the same paragraph or a career-data quote the paragraph cites states that benefit'
  + ' in its own words or in a closely related one, except that the posting’s own name for a responsibility is not a claim:'
  + ' a benefit word standing next to a word with which it makes a two-word run the posting itself contains, and the words after “to” in “apply that approach to …”,'
  + ' may use the posting’s own word; otherwise the sentence names the responsibility and claims no benefit the proof did not show';

const BENEFIT_CLAIM_CLASS_BY_WORD = new Map(TRANSFER_BENEFIT_CLASSES.flatMap(benefit => benefit.claimed.map(word => [word, benefit.name])));
const BENEFIT_ATTESTATION_BY_CLASS = new Map(TRANSFER_BENEFIT_CLASSES.map(benefit => [benefit.name, new Set([...benefit.claimed, ...benefit.attested])]));
const MAX_TRANSFER_BENEFIT_OBSERVATIONS = 4;
const MAX_BENEFIT_PROOF_TERMS = 8;

function benefitWords(value) {
  return genericWords(value).map(word => word.replace(/'s$/u, ''));
}

/** The benefit classes a text states in claimed words, as a set of class names. */
function benefitClassesStated(value) {
  return new Set(benefitWords(value).map(word => BENEFIT_CLAIM_CLASS_BY_WORD.get(word)).filter(Boolean));
}

/**
 * The consecutive word pairs of a text, as strings. A benefit word that sits in
 * a pair the posting itself contains is the posting's own name for a
 * responsibility (“dependable retries”, “data security”), not a benefit the work
 * claims to bring.
 */
function wordPairs(value) {
  const parsed = benefitWords(value);
  const pairs = new Set();
  for (let index = 0; index + 1 < parsed.length; index += 1) pairs.add(`${parsed[index]} ${parsed[index + 1]}`);
  return pairs;
}

/**
 * The first claimed word of each benefit class in one sentence, in sentence
 * order, except the words that NAME the responsibility. A sentence about the
 * target names a concrete responsibility drawn from the posting, and a stock
 * frame puts it in the phrase after “to” (“apply that approach to
 * <responsibility>”). A responsibility such as “reliable delivery” or “data
 * security” is the posting's own requirement, not a benefit this work claims to
 * bring, and a check that rejected it would forbid naming the responsibility
 * the letter owes. So a benefit word inside that slot is not read when the
 * posting itself states a word of the same class, and a benefit word standing
 * next to a word it makes a two-word run with in the posting (`postingPairs`) is
 * not read in a sentence worded any other way; the same word anywhere else
 * (“… would keep the service available”, “… would support its availability”) is
 * a claim about what the work achieves.
 *
 * The line is drawn at the preposition on purpose for the stock frame. “Apply X
 * to <Y>” names where the work goes, and the object of “support” or “help”
 * asserts an effect on it, but two spellings of one effect differ only by a
 * determiner (“would support availability”, “would support the availability of
 * …”), so no other slot can be excused without excusing both. What this leaves
 * open is an infinitive of purpose inside the slot (“to improve availability”)
 * when the posting states the class: telling it from a responsibility needs a
 * part-of-speech tagger, and the check errs toward the sentence the writer can
 * still defend.
 */
function benefitClaims(sentence, postingClasses, postingPairs = new Set()) {
  const source = normalized(sentence);
  const tokens = [...source.matchAll(WORD_TOKEN_RE)].map(match => ({ word: match[0], start: match.index, end: match.index + match[0].length }));
  const responsibility = new Set(matchedSpans(source, FORMULAIC_TRANSFER_FRAME_GLOBAL)
    .flatMap(carrier => transferPhrasePositions(tokens, carrier).target));
  const flat = tokens.flatMap((token, index) => token.word.split('-').map(part => ({ word: part.replace(/'s$/u, ''), index })));
  const found = new Map();
  flat.forEach(({ word, index }, position) => {
    const className = BENEFIT_CLAIM_CLASS_BY_WORD.get(word);
    if (!className || found.has(className)) return;
    if (responsibility.has(index) && postingClasses.has(className)) return;
    const before = flat[position - 1];
    const after = flat[position + 1];
    if ((before && postingPairs.has(`${before.word} ${word}`)) || (after && postingPairs.has(`${word} ${after.word}`))) return;
    found.set(className, word);
  });
  return [...found].map(([className, word]) => ({ className, word }));
}

/**
 * A sentence of a proof-bearing paragraph names an operational benefit the
 * paragraph's proof does not state.
 *
 * The sentence that says why the work matters to the target is worded however
 * the writer likes, so no phrase can pick it out, and the host cannot know which
 * of a paragraph's sentences the audit will call its relevance. Every sentence of
 * a proof-bearing paragraph that states no action of the candidate's own is
 * therefore read (a sentence that does is proof, and is what attests). A
 * claimed word of TRANSFER_BENEFIT_CLASSES passes when a proof sentence of the
 * same paragraph or a career-data quote the paragraph cites carries any word of
 * the same class, when it names the responsibility a stock frame applies the work
 * to (the phrase after “to”) in the posting's own terms (`jobText` states a word
 * of that class), or when it sits in a two-word run the posting itself contains
 * (see benefitClaims for why neither is a claim). `citations` is parallel to
 * `paragraphs` exactly as letter-proportion reads it, and when it does not line
 * up the check is silent rather than guessing what the quotes say: a benefit the
 * quotes would have attested must never be reported against a paragraph whose
 * quotes were not available to read.
 *
 * What it does not read, on purpose. A sentence that restates the proof as a
 * stronger demonstrated outcome, in words outside the lexicon, is a judgment
 * about how strong two verbs are, and no closed lexical test separates it from a
 * faithful restatement without rejecting honest ones, so it stays with the
 * per-sentence grounding rules and the reviewers. The opening and closing carry
 * no proof of their own to attest anything and are not read either.
 *
 * The message quotes the word it read and lists the proof's own terms, which is
 * the whole of the repair information: it offers no wording to put in its place.
 */
export function checkTransferBenefitSupport(paragraphs = [], { citations = null, jobText = '' } = {}) {
  const source = Array.isArray(paragraphs) ? paragraphs : [];
  if (!(Array.isArray(citations) && citations.length === source.length)) {
    return result('transfer-benefit-support', true, 'skipped: the quotes each paragraph cites are not available, so no benefit is judged unsupported');
  }
  const postingClasses = benefitClassesStated(jobText);
  const postingPairs = wordPairs(jobText);
  const observations = [];
  let ordinal = 0;
  source.forEach((raw, sourceIndex) => {
    const paragraph = text(raw);
    if (!paragraph) return;
    ordinal += 1;
    if (!paragraphHasCandidatePastProof(paragraph)) return;
    const own = sentences(paragraph);
    const proofSentences = own.filter(paragraphHasCandidatePastProof);
    const readable = own
      .map((sentence, position) => ({ sentence, position }))
      .filter(({ sentence }) => !paragraphHasCandidatePastProof(sentence));
    if (!readable.length) return;
    const quotes = Array.isArray(citations[sourceIndex]) ? citations[sourceIndex] : [];
    const attestedWords = new Set([...proofSentences, ...quotes].flatMap(benefitWords));
    const proofTerms = [...new Set(proofSentences.flatMap(argumentContentWords))].slice(0, MAX_BENEFIT_PROOF_TERMS);
    for (const { sentence, position } of readable) {
      const unsupported = benefitClaims(sentence, postingClasses, postingPairs)
        .filter(({ className }) => ![...BENEFIT_ATTESTATION_BY_CLASS.get(className)].some(word => attestedWords.has(word)));
      if (!unsupported.length) continue;
      observations.push(`paragraph ${ordinal} sentence ${position + 1} puts ${joinAnd(unsupported.map(({ word }) => `“${word}”`))}`
        + ` in a sentence that states no action of yours, a benefit of the ${joinAnd(unsupported.map(({ className }) => className))} class that neither the paragraph’s proof sentences nor the quotes it cites state;`
        + ` the proof’s own terms are ${proofTerms.length ? proofTerms.map(term => `“${term}”`).join(', ') : '(none after the content-word filter)'}`);
    }
  });
  return observationResult('transfer-benefit-support', observations, MAX_TRANSFER_BENEFIT_OBSERVATIONS,
    'no sentence of a proof-bearing paragraph names a benefit the paragraph’s proof and cited quotes leave unstated');
}

/**
 * The job-need quote each letter paragraph answers, indexed by paragraph.
 *
 * There is exactly one jobNeedQuote in this pipeline: the field the generation
 * audit's coverLetterPlan records per paragraph, which checkParagraphArgumentLinks
 * grades as a span of the posting. So that is the field read here, off whichever
 * plan the caller passes, and nothing is invented where a plan has no paragraph
 * records — which is every plan built from a coverLetterArgument alone, including
 * the one the cover-letter drafting stage and the completion gate hold. A
 * paragraph with no quote to read simply has no need vocabulary blanked, and what
 * that costs is bounded rather than lucky: both re-namings a stock frame
 * dictates are already excused by POSITION — the capability the carrier hands over
 * and the responsibility it reaches (see dictatedTransferPositions) — so reading
 * the quote adds only the paragraph that names its need somewhere other than the
 * slot the transfer shape puts it in.
 */
function paragraphJobNeedQuotes(plan) {
  return (Array.isArray(plan?.paragraphs) ? plan.paragraphs : [])
    .map(planned => text(planned?.argumentMapping?.jobNeedQuote));
}

/** Returns the strict pre-prose gate without ever throwing or blocking shipping. */
export function checkPlanGate(plan = {}, evidence = {}, needs = [], jobText = '', researchText = '') {
  const checks = [
    checkRoleThesis(plan),
    checkEvidenceGrounding(plan, evidence),
    checkNeedGrounding(needs, jobText, researchText),
    checkLogisticsExclusion(plan),
    checkMappingNarrativeStructure(plan),
  ];
  const mappings = Array.isArray(plan?.mappings) ? plan.mappings : [];
  if (mappings.length < 1) checks.push(result('plan-mappings', false, 'plan has no mappings'));
  else checks.push(result('plan-mappings', true, `plan has ${mappings.length} mapping(s)`));
  // When needs analysis succeeded, a mapping must actually point back to that
  // ranked list. Without this check an out-of-range `needIndex` can make the
  // plan look valid while silently bypassing the top-need telemetry and the
  // argument contract. If needs are unavailable, the documented direct-job
  // fallback intentionally has no list to validate against.
  const rankedNeeds = Array.isArray(needs) ? needs : [];
  if (rankedNeeds.length) {
    const invalid = mappings.findIndex(mapping => !Number.isInteger(mapping?.needIndex)
      || mapping.needIndex < 0 || mapping.needIndex >= rankedNeeds.length);
    checks.push(invalid === -1
      ? result('plan-need-references', true, `${mappings.length} mapping(s) reference ranked needs`)
      : result('plan-need-references', false, `mapping ${invalid + 1} references invalid needIndex “${boundedDetailValue(mappings[invalid]?.needIndex) || 'missing'}”`));
  }
  const allStated = mappings.length > 0 && mappings.every(mapping => mapping?.resumeStatus === 'stated');
  checks.push(result('plan-redundancy', !allStated,
    allStated ? 'all mappings are marked resumeStatus “stated”' : 'at least one mapping requires interpretation'));
  checks.push(checkAllNeedDisposition(plan, rankedNeeds));
  const topNeedDisposition = checkTopNeedDisposition(plan, rankedNeeds);
  checks.push(topNeedDisposition);
  checks.push(checkEligibilityNeedDisposition(plan, rankedNeeds));
  // A recorded top-ranked hard screen is an honest status, not a revision
  // instruction: retrying it would pressure the model to manufacture a
  // credential. An undisposed top need remains retryable because the plan has
  // failed to make its choice auditable at all.
  const shouldRetry = checks.some(check => !check.passed
    && !(check.id === 'top-need-disposition' && /honestly dropped/.test(check.detail))
    && check.id !== 'eligibility-need-disposition');
  return { shouldRetry, checks };
}

// ---------------------------------------------------------------------------
// CHECK DISPOSITIONS
//
// What a failure of each cover-letter check is allowed to DO.
//
// The career file is a fixed hand and the system plays it as well as it can.
// What rejects a letter is TRUTH (a fact, a figure, an ownership or strength,
// a date, a claim about the employer or the posting the writer cannot support,
// evidence the paragraph does not cite) and HYGIENE (schema, structure, a
// record that is missing or does not line up). TASTE (cadence, wording, the
// grammar of a required sentence, repetition limits, opening and closing
// forms, paragraph shape) never does: a deterministic wording gate cannot be
// satisfied naturally, and a writer who must satisfy one writes filler. The
// gate audit measured exactly that, so every check carries one of three
// dispositions.
//
//   'gate'     a failure blocks the letter and is returned for correction;
//   'advisory' a failure never blocks. It is kept as a content-free record
//              (the check id and how many observations there were; the
//              observation text is not persisted) and the writer prompt may
//              still describe the check as guidance;
//   'off'      the check is not run by production callers. The function stays
//              exported and tested; partitionCheckResults drops its rows.
//
// An id this table does not list is a GATE: a check added without being
// classified fails closed, as every check did before there was a table, until
// someone decides. The drift test (scripts/tests/gapfix-v17-letter-dispositions.js)
// fails on that omission, and on a row that names an id nothing emits, instead
// of letting either ship silently.
//
// A check that mixes a truth half with a taste half is split: its row keeps its
// legacy shape and carries its halves as `parts`, each under an id of its own
// (figure-discipline / figure-count, role-thesis / role-thesis-shape,
// paragraph-argument-links / paragraph-argument-shape, letter-proportion /
// letter-paragraph-ceiling). partitionCheckResults reads the halves, so the
// truth half can hold while the taste half advises.
// ---------------------------------------------------------------------------

export const CHECK_DISPOSITION_VALUES = Object.freeze(['gate', 'advisory', 'off']);

// [id, disposition, class, why]. The class is the audit's (TRUTH / HYGIENE /
// TASTE / MIXED); where the disposition departs from the audit's recommendation
// the `why` says so. One list builds all three frozen maps, so no id can have a
// disposition without a stated reason.
const CHECK_DISPOSITION_ROWS = Object.freeze([
  // ---- the production battery (evaluateCoverLetterChecks), in battery order
  ['redundancy', 'advisory', 'TASTE', 'a verbatim run shared with a résumé bullet is repetition, not a falsehood; the word floor re-rejects a repair the host itself suggested and misses a restated meaning.'],
  ['salient-phrase-echo', 'off', 'TASTE', 'depends on a refrain list the writer cannot see, so the rule cannot be learned; no fact is at stake.'],
  ['generic-phrases', 'advisory', 'TASTE', 'stock phrases and opener formulas are a true weakness, but a closed list that synonyms pass is a lexical lottery, not a gate.'],
  ['interest-framing', 'advisory', 'TASTE', 'declarations of enthusiasm are style advice with no fact in them.'],
  ['experience-infinitive-grammar', 'off', 'TASTE', 'the grammar of one construction a writer does not produce.'],
  ['company-specificity', 'off', 'TASTE', 'inert in the paste pipeline, which never supplies research text, and wording-only where it does run.'],
  ['shape', 'gate', 'HYGIENE', 'a letter needs at least one non-empty body paragraph.'],
  ['figure-discipline', 'gate', 'MIXED', 'a figure the approved evidence never states is a fabricated metric. Only that half gates (the count cap is figure-count), and a figure is licensed by the evidence the letter cites as well as by the mapped evidence.'],
  ['logistics-exclusion', 'gate', 'MIXED', 'availability, start-date, location and relocation promises state facts about the candidate that no approved evidence supports; promise-shaped patterns, no false positives measured.'],
  ['compound-hyphenation', 'off', 'TASTE', 'orthography; the message already prints the corrected spelling.'],
  ['parallel-structure', 'off', 'TASTE', 'grammar heuristics.'],
  ['prior-employer-opening', 'advisory', 'TASTE', 'where a sentence states the candidate’s relationship to an employer is a wording preference; the closed frames rejected complete relationship statements and taught one template.'],
  ['named-artifact-introduction', 'advisory', 'TASTE', 'introduction style, not fact.'],
  ['opening-artifact-context', 'advisory', 'TASTE', 'opening form; with the other opening checks it steered writers toward an abstract opener about the employer’s domain, which is the unsupported claim a gate should be catching.'],
  ['vague-domain-work-label', 'off', 'TASTE', 'a one-pattern wording fixer.'],
  ['reference-clarity', 'off', 'TASTE', 'grammar judgment that rejected a plural pronoun with a plain coordinated antecedent.'],
  ['modifier-attachment', 'off', 'TASTE', 'one regex fitted to one past sentence.'],
  ['migration-object-clarity', 'off', 'TASTE', 'a one-pattern fixer.'],
  ['opening-posting-restatement', 'advisory', 'TASTE', 'rejected the opener the host’s own opening rule asks for (naming the role and the employer).'],
  ['opening-job-summary-scaffolding', 'advisory', 'TASTE', 'style.'],
  ['anchor-relevance', 'advisory', 'TASTE', 'forbids accurate, relevant tool naming and its repair makes the letter vaguer; it is not a truth gate.'],
  ['target-claim-scope', 'gate', 'MIXED', 'telling the employer its role involves the candidate’s own prior mechanics is a claim about the employer. Held as a gate once it reads only sentences that name a responsibility of the posting.'],
  ['target-company-binding', 'gate', 'TRUTH', 'a name from another application where this job’s employer belongs is a copy/paste company error. Held as a gate once it excludes technologies, names the evidence or posting explains, and history recalled in the past tense.'],
  ['detached-relevance-claim', 'off', 'TASTE', 'a one-pattern wording rule.'],
  ['prospective-contribution-tense', 'advisory', 'TASTE', 'the tense of a hedge; no fact at stake.'],
  ['additive-seam', 'off', 'TASTE', 'connective style.'],
  ['responsibility-transition', 'off', 'TASTE', 'fixed phrases.'],
  ['tool-calls-garden-path', 'off', 'TASTE', 'a single literal string.'],
  ['low-information-tool-build', 'off', 'TASTE', 'one wording pattern.'],
  ['containerization-technology-roles', 'gate', 'TRUTH', 'fires only when a tool is credited with a role the résumé itself assigns to another tool: attribution truth, precise.'],
  ['posting-reference', 'advisory', 'TASTE', 'register advice.'],
  ['claimed-equivalence', 'advisory', 'MIXED', 'an asserted cross-domain equivalence is truth-adjacent, but the lexical carriers also match innocent phrasing and cannot tell a claim about the employer from the candidate’s own account; advice, not a gate.'],
  ['dangling-paragraph-transition', 'off', 'TASTE', 'one regex shape.'],
  ['sentence-length', 'advisory', 'TASTE', 'a readability preference.'],
  ['punctuation-style', 'advisory', 'TASTE', 'house style the host can normalise mechanically instead of rejecting.'],
  ['paragraph-openers', 'advisory', 'TASTE', 'opening-word variety that the brief asks for; the host records it and never rejects on it.'],
  ['plain-register', 'off', 'TASTE', 'a few fixed phrases from past letters.'],
  ['introductory-workplace-comma', 'off', 'TASTE', 'comma placement.'],
  ['visual-reference-precision', 'off', 'TASTE', 'fitted to one project description.'],
  ['direct-welcome-closing', 'off', 'TASTE', 'it certified one closing shape, a direct invitation, and that shape became the stock closing of every letter; how a letter closes is the writer’s choice.'],
  ['opening-demonstrative', 'off', 'TASTE', 'cohesion judgment for a reviewer.'],
  ['opening-employer-shorthand', 'off', 'TASTE', 'wording.'],
  ['adjacent-employer-repetition', 'off', 'TASTE', 'wording that pulled opposite to prior-employer-opening.'],
  ['entailed-premise', 'off', 'TASTE', 'one regex.'],
  ['repeated-sentence-shape', 'off', 'TASTE', 'teaches a writer to contort syntax and did not catch the monotone shape it names.'],
  ['repeated-phrase', 'advisory', 'TASTE', 'the floor sits below ordinary repeated naming of one thing; repetition of an idea is a reviewer’s call.'],
  ['candidate-agency', 'advisory', 'TASTE', 'existed so the audit’s span obligations had something to grade, and those obligations are advisory now.'],
  ['letter-proportion', 'advisory', 'TASTE', 'counts over how the letter is cut and worded, not facts; page fit is measured by the renderer. Its paragraph ceiling is split off as letter-paragraph-ceiling.'],
  ['repeated-transfer-carrier', 'off', 'TASTE', 'existed only to fence the mandated transfer sentence.'],
  ['dangling-demonstrative', 'off', 'TASTE', 'a cohesion rule.'],
  ['ended-role-current-employment', 'gate', 'TRUTH', 'a role with an explicit past end date framed as current employment is a false date claim; reads explicit end dates only.'],
  ['transfer-carrier-budget', 'off', 'TASTE', 'a fence around the mandated transfer sentence.'],
  ['transfer-benefit-support', 'gate', 'TRUTH', 'a benefit class (reliability, cost, safety and so on) that neither the proof nor the cited quotes state is an outcome the evidence does not show; a closed lexicon that errs toward silence.'],

  // ---- rows the production battery adds around evaluateCoverLetterChecks
  ['role-thesis', 'gate', 'HYGIENE', 'only the half that records a roleThesis at all gates; one sentence, long enough and free of stock language is role-thesis-shape.'],
  ['mapping-narrative-structure', 'off', 'TASTE', 'scaffolding for the argument plan, not a property of the letter.'],
  ['evidence-grounding', 'gate', 'HYGIENE', 'binds each argument evidence string to a final résumé bullet; cheap and precise.'],
  ['paragraph-argument-links', 'gate', 'MIXED', 'the provenance half of the argument audit: a recorded span must be an exact span of its paragraph, a jobNeedQuote an exact span of the posting copy, and the paragraph may not promote a use requirement into a build or a tool-assisted practice into a product. The span grammar is paragraph-argument-shape.'],
  ['paragraph-argument-span-gaps', 'off', 'TASTE', 'the drafting twin of the span grammar; it rejected paragraphs that were not defective and carried no check id.'],
  ['unsupported-experience-span', 'gate', 'TRUTH', 'a span of years the text claims must be stated by a quote the same unit cites; computed durations are a classic fabrication.'],

  // ---- halves split off the rows above, each under its own id
  ['role-thesis-shape', 'advisory', 'TASTE', 'sentence count, length and stock language in the thesis are wording.'],
  ['figure-count', 'advisory', 'TASTE', 'how many figures a letter carries is a density preference.'],
  ['letter-paragraph-ceiling', 'advisory', 'TASTE', 'paragraph count is a layout proxy; the renderer measures actual one-page fit.'],
  ['paragraph-argument-shape', 'advisory', 'TASTE', 'the claim must match a closed capability grammar, a proof must use one of a closed list of verbs, a relevance span must carry words of the quote, a paragraph that states an action owes a mapping, no two paragraphs bind one quote: wording decided by literal form.'],

  // ---- the needs-analysis plan gate: no production caller since the APIs were removed
  ['need-grounding', 'off', 'HYGIENE', 'dead code: no production caller.'],
  ['plan-mappings', 'off', 'HYGIENE', 'dead code: no production caller.'],
  ['plan-need-references', 'off', 'HYGIENE', 'dead code: no production caller.'],
  ['plan-redundancy', 'off', 'TASTE', 'dead code: no production caller.'],
  ['all-needs-disposition', 'off', 'HYGIENE', 'dead code: no production caller.'],
  ['top-need-disposition', 'off', 'HYGIENE', 'dead code: no production caller.'],
  ['eligibility-need-disposition', 'off', 'HYGIENE', 'dead code: no production caller.'],
  ['needs-portfolio', 'off', 'TASTE', 'dead code: no production caller.'],
  ['work-sample-link', 'off', 'HYGIENE', 'dead code: no production caller.'],
]);

export const CHECK_DISPOSITIONS = Object.freeze(Object.fromEntries(CHECK_DISPOSITION_ROWS.map(([id, disposition]) => [id, disposition])));
export const CHECK_CLASSES = Object.freeze(Object.fromEntries(CHECK_DISPOSITION_ROWS.map(([id, , checkClass]) => [id, checkClass])));
export const CHECK_RATIONALES = Object.freeze(Object.fromEntries(CHECK_DISPOSITION_ROWS.map(([id, , , why]) => [id, why])));

const VALID_DISPOSITIONS = new Set(CHECK_DISPOSITION_VALUES);

/**
 * The disposition of one check id. An id the table does not list, or lists
 * with a value that is not one of the three, is a gate: the safe answer for a
 * check nobody has classified is the one it had before there was a table.
 * `table` is injectable so a test can flip one entry and prove the outcome
 * flips with it.
 */
export function checkDisposition(id, table = CHECK_DISPOSITIONS) {
  if (typeof id !== 'string' || !table || typeof table !== 'object' || !Object.hasOwn(table, id)) return 'gate';
  const value = table[id];
  return VALID_DISPOSITIONS.has(value) ? value : 'gate';
}

/**
 * The independently judged halves of a result row. A row that mixes a truth
 * half with a taste half carries them as `parts` (see the block comment above);
 * any other row is its own single half. A row whose `parts` are not a usable
 * list is read as the whole row, never as nothing.
 */
export function checkResultParts(row) {
  const parts = row && typeof row === 'object' ? row.parts : null;
  if (Array.isArray(parts) && parts.length && parts.every(part => part && typeof part === 'object' && typeof part.id === 'string')) {
    return parts;
  }
  return [row];
}

function advisoryObservationCount(row) {
  return Number.isInteger(row?.observationCount) && row.observationCount > 0 ? row.observationCount : 1;
}

/**
 * Split check result rows (the { id, passed, detail } rows evaluateCoverLetterChecks
 * and its siblings return) by what a failure is allowed to do.
 *
 *   blocking  the failed halves whose disposition is 'gate', as rows (with
 *             their detail, which the correction prompt prints);
 *   advisory  the failed halves whose disposition is 'advisory', as
 *             content-free records { id, count }: the id and how many
 *             observations there were, never the observation text. One record
 *             per id, counts summed;
 *   (dropped) a failed half whose disposition is 'off', and every half that
 *             passed.
 *
 * Fail-safe in the direction of blocking: a half with no id, an id the table
 * does not list, and a row that does not say `passed: true` all count as
 * failed gates, because an unattributable failure must not be waved through.
 */
export function partitionCheckResults(results, table = CHECK_DISPOSITIONS) {
  const blocking = [];
  const advisoryCounts = new Map();
  for (const row of Array.isArray(results) ? results : []) {
    if (!row || typeof row !== 'object') continue;
    for (const part of checkResultParts(row)) {
      if (part.passed === true) continue;
      const disposition = checkDisposition(part.id, table);
      if (disposition === 'off') continue;
      if (disposition === 'advisory') {
        advisoryCounts.set(part.id, (advisoryCounts.get(part.id) || 0) + advisoryObservationCount(part));
        continue;
      }
      blocking.push(part);
    }
  }
  return { blocking, advisory: [...advisoryCounts].map(([id, count]) => ({ id, count })) };
}

/**
 * The table as data, for documents and tests: the values, the default, the
 * counts, the ids grouped by disposition and one row per id with its class and
 * the reason it has the disposition it has.
 */
export function describeCheckDispositions(table = CHECK_DISPOSITIONS) {
  const ids = { gate: [], advisory: [], off: [] };
  const rows = Object.keys(table).map(id => {
    const disposition = checkDisposition(id, table);
    ids[disposition].push(id);
    return { id, disposition, class: CHECK_CLASSES[id] ?? null, rationale: CHECK_RATIONALES[id] ?? null };
  });
  return {
    values: CHECK_DISPOSITION_VALUES,
    defaultDisposition: 'gate',
    counts: { gate: ids.gate.length, advisory: ids.advisory.length, off: ids.off.length, total: rows.length },
    ids,
    rows,
  };
}

/** Evaluates the prose-level checks used to decide the single revision attempt. */
export function evaluateCoverLetterChecks({ plan = {}, paragraphs = [], evidence = {}, jobText = '', researchText = '', companyName = '', forbiddenNames = [], referenceDate = null, paragraphCitations = null, activeOnly = false } = {}) {
  const plannedCompanyDetail = text(plan?.companyHook?.detail);
  const priorEmployers = (Array.isArray(evidence?.roles) ? evidence.roles : [])
    .map(role => text(role?.company)).filter(Boolean);
  const companySpecificity = () => researchText && !plannedCompanyDetail
    ? result('company-specificity', true, 'skipped: argument plan intentionally omitted a company-specific hook')
    : checkCompanySpecificity(paragraphs, researchText, companyName, plannedCompanyDetail);
  const checks = [
    ['redundancy', () => checkRedundancy(paragraphs, evidence)],
    ['salient-phrase-echo', () => checkSalientPhraseEcho(paragraphs, evidence, jobText)],
    ['generic-phrases', () => checkGenericPhrases(paragraphs)],
    ['interest-framing', () => checkInterestFraming(paragraphs)],
    ['experience-infinitive-grammar', () => checkExperienceInfinitiveGrammar(paragraphs)],
    ['company-specificity', companySpecificity],
    ['shape', () => checkShape(plan, paragraphs)],
    ['figure-discipline', () => checkFigureDiscipline(paragraphs, evidence, plan, { citations: paragraphCitations })],
    ['logistics-exclusion', () => checkLogisticsExclusion(plan, paragraphs)],
    // Register and style checks. They are appended rather than interleaved so
    // the established check order stays stable, and every one of them reads
    // paragraphs only, so they still run in the plan-degraded path where the
    // call site filters out the plan-dependent 'shape' result.
    ['compound-hyphenation', () => checkCompoundHyphenation(paragraphs)],
    ['parallel-structure', () => checkParallelStructure(paragraphs)],
    ['prior-employer-opening', () => checkPriorEmployerOpening(paragraphs, priorEmployers)],
    ['named-artifact-introduction', () => checkNamedArtifactIntroduction(paragraphs, (Array.isArray(evidence?.projects) ? evidence.projects : []).map(project => project?.name))],
    ['opening-artifact-context', () => checkOpeningArtifactContext(
      paragraphs,
      (Array.isArray(evidence?.projects) ? evidence.projects : []).map(project => project?.name),
      priorEmployers,
    )],
    ['vague-domain-work-label', () => checkVagueDomainWorkLabel(paragraphs)],
    ['reference-clarity', () => checkReferenceClarity(paragraphs)],
    ['modifier-attachment', () => checkModifierAttachment(paragraphs)],
    ['migration-object-clarity', () => checkMigrationObjectClarity(paragraphs)],
    ['opening-posting-restatement', () => checkOpeningPostingRestatement(paragraphs, jobText)],
    ['opening-job-summary-scaffolding', () => checkOpeningJobSummaryScaffolding(paragraphs)],
    ['anchor-relevance', () => checkAnchorRelevance(paragraphs, jobText, researchText)],
    ['target-claim-scope', () => checkTargetClaimScope(plan, paragraphs, evidence, jobText)],
    ['target-company-binding', () => checkTargetCompanyBinding(paragraphs, companyName, priorEmployers, { evidence, jobText, forbiddenNames })],
    ['detached-relevance-claim', () => checkDetachedRelevanceClaim(paragraphs)],
    ['prospective-contribution-tense', () => checkProspectiveContributionTense(paragraphs, companyName)],
    ['additive-seam', () => checkAdditiveSeam(paragraphs)],
    ['responsibility-transition', () => checkResponsibilityTransition(paragraphs)],
    ['tool-calls-garden-path', () => checkToolCallsGardenPath(paragraphs)],
    ['low-information-tool-build', () => checkLowInformationToolBuild(paragraphs)],
    ['containerization-technology-roles', () => checkContainerizationTechnologyRoles(paragraphs, evidence)],
    ['posting-reference', () => checkPostingReference(paragraphs)],
    ['claimed-equivalence', () => checkClaimedEquivalence(paragraphs)],
    ['dangling-paragraph-transition', () => checkDanglingParagraphTransition(paragraphs)],
    ['sentence-length', () => checkSentenceLength(paragraphs)],
    ['punctuation-style', () => checkPunctuationStyle(paragraphs)],
    ['paragraph-openers', () => checkParagraphOpeners(paragraphs)],
    ['plain-register', () => checkPlainRegister(paragraphs)],
    ['introductory-workplace-comma', () => checkIntroductoryWorkplaceComma(paragraphs, priorEmployers)],
    ['visual-reference-precision', () => checkVisualReferencePrecision(paragraphs)],
    ['direct-welcome-closing', () => checkDirectWelcomeClosing(paragraphs, companyName, { citations: paragraphCitations })],
    ['opening-demonstrative', () => checkOpeningDemonstrative(paragraphs)],
    ['opening-employer-shorthand', () => checkOpeningEmployerShorthand(paragraphs, priorEmployers)],
    ['adjacent-employer-repetition', () => checkAdjacentEmployerRepetition(paragraphs, priorEmployers)],
    ['entailed-premise', () => checkEntailedPremise(paragraphs)],
    ['repeated-sentence-shape', () => checkRepeatedSentenceShape(paragraphs)],
    ['repeated-phrase', () => checkRepeatedPhrase(paragraphs, { jobNeedQuotes: paragraphJobNeedQuotes(plan) })],
    ['candidate-agency', () => checkCandidateAgency(paragraphs)],
    // Reads how the letter is cut rather than what it says, and is the only
    // check here that can refuse a letter of dozens of one-sentence
    // paragraphs. It sits beside the agency check it tightens. The optional
    // per-paragraph citations are the career-data quotes each paragraph is
    // bound to; a caller that cannot supply them still gets every structural
    // limit.
    ['letter-proportion', () => checkLetterProportion(paragraphs, { citations: paragraphCitations })],
    // Appended last for the same reason as the register block above: the
    // established order stays stable and both read paragraphs only.
    ['repeated-transfer-carrier', () => checkRepeatedTransferCarrier(paragraphs)],
    ['dangling-demonstrative', () => checkDanglingDemonstrative(paragraphs)],
    ['ended-role-current-employment', () => checkEndedRoleCurrentEmployment(paragraphs, evidence, referenceDate)],
    // Appended after the established order for the same reason as above. The
    // budget reads paragraphs only; the benefit check also reads the quotes
    // each paragraph cites and is silent when they are not supplied.
    ['transfer-carrier-budget', () => checkTransferCarrierBudget(paragraphs)],
    ['transfer-benefit-support', () => checkTransferBenefitSupport(paragraphs, { citations: paragraphCitations, jobText })],
  ];
  return checks.filter(([id]) => !activeOnly || checkDisposition(id) !== 'off').map(([, run]) => run());
}

/** Authors the stable cover-letter fields without changing the document-builder contract. */
export function authorCoverLetterEnvelope({ job = {}, evidence = {}, today = '' } = {}) {
  const company = salutationCompanyName(job.company);
  const identity = evidence?.identity || {};
  return {
    name: text(identity.name),
    tagline: text(identity.tagline),
    // These are authored from the accepted résumé, not from model-provided
    // letter fields. The renderer uses them to recreate the identical shared
    // letterhead component, including the design-system separator margins.
    subtitleRole: text(identity.subtitleRole),
    credential: text(identity.credential),
    // Normalize before filtering: a model/resumé source can contain whitespace
    // entries that are truthy before normalization but render as empty contact
    // separators in the paired cover-letter letterhead.
    contact: Array.isArray(identity.contact) ? identity.contact.map(text).filter(Boolean) : [],
    date: text(today),
    // The design system deliberately has no recipient address block. The
    // company belongs in the generic salutation, while a named contact, when
    // supplied by a future source, belongs in that salutation rather than a
    // second piece of letterhead.
    recipient: '',
    salutation: company ? `Dear ${company} Hiring Team,` : 'Dear Hiring Team,',
    closing: 'Best regards,',
    signatureTitle: '',
  };
}
