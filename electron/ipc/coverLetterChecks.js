// Deterministic, dependency-free checks for the cover-letter argument harness.
// Keep this module free of Electron/LLM/fs imports: the checks are deliberately
// usable from the Node smoke suite and from the application pipeline.

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
const MAX_SALIENT_ECHO_OBSERVATIONS = 4;
const MAX_OPENING_DEMONSTRATIVE_OBSERVATIONS = 4;
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
// repeats in the same letter carry two ("the engineering challenge was"), three
// ("scalability across the ui and backend") and three ("device management
// platforms"). So two is the boundary the measurement draws, and the stricter
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
  // Hollow balance: “a clear view of its downsides and trade-offs as well as
  // its upsides” asserts judgment without exercising any. Only the fixed
  // doublet is listed, and deliberately so: a wider “<downside noun> … as well
  // as <upside noun>” frame also fires on sentences that state a real judgment
  // (“I documented the benefits of the migration as well as its limitations”),
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
// mandated carrier occupies. A second copy of this pattern would be a second
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

const SPELLED_FIGURE_VALUES = Object.freeze({
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
  seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12',
  thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16',
  seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20',
});
const SPELLED_FIGURE_UNITS = '(?:years?|months?|weeks?|days?|hours?|minutes?|percent)';
const SPELLED_FIGURE_RE = new RegExp(`\\b(${Object.keys(SPELLED_FIGURE_VALUES).join('|')})\\s*-?\\s*(${SPELLED_FIGURE_UNITS})\\b`, 'giu');

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

function boundedDetailValue(value) {
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

function bulletTexts(evidence) {
  return Array.isArray(evidence?.bulletTexts) ? evidence.bulletTexts.filter(Boolean).map(text) : [];
}

const GENERIC_THESIS_PATTERNS = Object.freeze([
  { label: 'generic fit claim', pattern: /\b(?:strong|great|ideal|excellent|perfect)\s+(?:fit|candidate)\b/iu },
  { label: 'generic qualification claim', pattern: /\b(?:qualified|well[- ]suited)\s+for\b/iu },
  { label: 'generic alignment claim', pattern: /\b(?:background|experience|skills|qualifications)\b.{0,60}\b(?:aligns?|matches?|fits?)\b/iu },
  { label: 'generic blend claim', pattern: /\b(?:unique|strong)\s+blend\s+of\b/iu },
]);

/**
 * Shared segmentation for every sentence-level check. Intl.Segmenter knows
 * that “Inc.” and “e.g.” are not sentence ends; the regex fallback keeps the
 * checks working on a runtime without ICU sentence data rather than letting a
 * missing segmenter silently disable them.
 */
export function sentences(value) {
  const source = text(value);
  if (!source) return [];
  if (typeof Intl?.Segmenter === 'function') {
    return Array.from(new Intl.Segmenter('en', { granularity: 'sentence' }).segment(source))
      .map(segment => text(segment?.segment))
      .filter(Boolean);
  }
  return source.split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}])/u).map(text).filter(Boolean);
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
  if (!thesis) return result('role-thesis', false, 'roleThesis is missing');
  const count = sentenceCount(thesis);
  if (count !== 1) return result('role-thesis', false, `roleThesis contains ${count} sentences; exactly one controlling claim is required`);
  const countWords = wordCount(thesis);
  if (countWords < MIN_ROLE_THESIS_WORDS) return result('role-thesis', false, `roleThesis has only ${countWords} words; it does not establish a specific controlling claim`);
  const genericLanguage = checkGenericPhrases([thesis]);
  if (!genericLanguage.passed) return result('role-thesis', false, `roleThesis is generic: ${genericLanguage.detail}`);
  const genericPattern = GENERIC_THESIS_PATTERNS.find(item => item.pattern.test(thesis));
  if (genericPattern) return result('role-thesis', false, `roleThesis contains a ${genericPattern.label}`);
  return result('role-thesis', true, 'roleThesis is one non-generic controlling claim');
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
// thing a span-only contract cannot prove: that the purported relevance is a
// concrete transfer to an actual responsibility in the posting. It does not
// attempt to infer claims from prose or impose sentence order; relevance may
// precede the proof and one sentence may perform more than one job.
const ARGUMENT_TRANSFER_CUE = /\b(?:i\s+would\s+(?:apply|bring|use|contribute)|i\s+can\s+(?:apply|bring|use)|(?:would\s+)?(?:apply|bring|use|contribute)\s+(?:that|this|my|the)\s+(?:experience|work|capability|practice|approach|judgment)|(?:that|this|these|those|the)\s+(?:[\p{L}'’-]+\s+){0,5}(?:pattern|patterns|practice|practices|experience|work|capability|capabilities|approach|approaches|judgment|judgments)\s+would\s+(?:help|support|enable)|help(?:ing)?\s+(?:this|the|your)\s+(?:role|team|work)|support(?:ing)?\s+(?:this|the|your)\s+(?:role|team|work))\b/iu;
const GENERIC_ARGUMENT_RELEVANCE = /\b(?:experience|background|skills?|capabilit(?:y|ies)|work)\b[^.!?]{0,50}\b(?:relevant|applicable|valuable|useful|beneficial|transferable|well[- ]suited|fit)\b|\b(?:innovative|dynamic|fast[- ]paced)\s+(?:team|environment|work)\b/iu;
const VACUOUS_TARGET_WORK = /\b(?:interface and service work|service and interface work)\b/iu;
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
export const ARGUMENT_CLAIM_SPAN_RULE = 'a claim span states the candidate capability itself, in one of these shapes: my, I am, '
  + 'I\u2019m or I have, followed within the sentence by experience, background, skill, capability, practice, approach, judgment or '
  + 'foundation; I build, design, implement, maintain, improve, secure or worked on, followed within the sentence by an interface, '
  + 'workflow, service, system, application, software or access; my \u2026 work spans; or designing, building, implementing, '
  + 'maintaining, improving or securing something is, has been or remains a capability, skill, foundation or strength; or the or '
  + 'that engineering, work, hard part, difficulty, challenge or problem was, lay or sat in, largely, mostly, mainly, less, '
  + 'chiefly or really doing something, where that gerund is followed by its own object rather than standing alone as a mood \u2014 and it '
  + 'names the capability rather than one particular past action, and never the transfer';
export const ARGUMENT_RELEVANCE_SPAN_RULE = 'a relevance span states the transfer outright, in one of these shapes: I would apply, '
  + 'bring, use or contribute; I can apply, bring or use; apply, bring, use or contribute that, this, my or the experience, work, '
  + 'capability, practice, approach or judgment; that, this, these, those or the \u2026 pattern, practice, experience, work, '
  + 'capability, approach or judgment would help, support or enable; or helping or supporting this, the or your role, team or work '
  + '\u2014 and it names a concrete responsibility drawn from the posting passage the same paragraph answers';

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
function wordAlignedSpans(value) {
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
    for (const end of ends) if (end > start) spans.push(source.slice(start, end));
  }
  return spans;
}

// Printed by the review contract beside the three span rules, from the
// predicate that decides it. Silence here was the ANTI-disclosure: a writer
// told only "an exact span" may read the letters back out of the middle of a
// word, and the reporter that is supposed to name an unmappable paragraph
// three stages earlier cannot see that span at all.
export const ARGUMENT_SPAN_ALIGNMENT_RULE = 'each of those three spans is copied out of the paragraph on word '
  + 'boundaries: a cut may fall anywhere the paragraph is not between two letters or digits — dropping a trailing '
  + 'comma, or entering a hyphenated compound at its second half, is fine — and a span that begins or ends inside a '
  + 'word is rejected even though its letters do appear there';

function relevanceNamesNeed(relevance, jobNeedQuote) {
  const needTerms = new Set(argumentContentWords(jobNeedQuote));
  const relevanceTerms = argumentContentWords(relevance);
  // Two shared content words make accidental overlap unlikely. One unusually
  // specific shared term is enough for short requirement quotes such as
  // “Identity Center” or “authorization”.
  const matches = [...new Set(relevanceTerms.filter(term => needTerms.has(term)))];
  return matches.length >= 2 || matches.some(term => term.length >= 9);
}

const DIRECT_PROOF_ANAPHORA = /\b(?:(?:that|this)\s+(?:experience|work)|(?:those|these)\s+patterns)\b/iu;
const DIRECT_PROOF_ARTIFACT_REFERENCE = /\bthe\s+(?:system|application|interface|workflow|service|tool)\b/iu;
const DIRECT_PROOF_PRONOUN_REFERENCE = /\bi\s+(?:would|can|will)\s+(?:apply|bring|use|contribute)\s+it\b/iu;
const PROOF_ARTIFACT_CUE = /\b(?:system|application|interface|workflow|service|tool)\b/iu;

const MECHANISM_TERM_MIN_LETTERS = 5;

// The two rules the review contract prints for the mapping it has to record,
// built FROM the regexes and word lists above rather than transcribed. The
// contract used to promise "sharing a word of five letters or more with the
// claim or the proof, unless it is the sentence directly after the proof
// sentence and refers back to it" — and both halves overpromised. A shared
// word does not count when argumentContentWords drops it (experience, work,
// role, team and the rest of ARGUMENT_STOP_WORDS are dropped, and that is the
// obvious word to share), and "refers back to it" is a whole language of
// reference where the code accepts six fixed phrases with nothing between the
// determiner and the noun. A writer told the loose version selects a span the
// gate rejects, and the only repair is rewriting the paragraph — a whole
// round, at the last and most expensive stage.
export const ARGUMENT_RELEVANCE_MECHANISM_RULE = 'the relevance span must also carry a word of '
  + `${MECHANISM_TERM_MIN_LETTERS} letters or more that the claim or the proof carries too, compared `
  + 'case-insensitively with a plural and its singular counting as one word, and these '
  + `${ARGUMENT_STOP_WORDS.size} words never count as that shared word: ${[...ARGUMENT_STOP_WORDS].sort().join(', ')}`;
export const ARGUMENT_RELEVANCE_ANAPHORA_RULE = 'one narrow exception stands in for that shared word: a relevance '
  + 'span sitting inside the sentence directly after the sentence the proof span came from may instead point back '
  + 'with “that experience”, “this experience”, “that work”, “this work”, “those patterns” or “these patterns”, '
  + 'each written with no word between the two — “that backend experience” is not one of them — or, only where the '
  + 'proof’s own sentence names a system, application, interface, workflow, service or tool, with “the” and one of '
  + 'those same six nouns, or with “I would”, “I can” or “I will” followed by apply, bring, use or contribute and then “it”';
export const ARGUMENT_MAPPING_REQUIRED_RULE = 'a paragraph needs an argumentMapping exactly when its own words put I '
  + 'or we — optionally with have or has, and optionally also — directly in front of one of the verbs the proof-span '
  + 'rule below closes over, and that list is the whole test: a paragraph that states an action of yours in any other '
  + 'verb carries no span that can serve as its proof, so its argumentMapping is omitted rather than supplied, and '
  + 'supplying one anyway is rejected for a proof that states no candidate past action';

// The shared word may come from the proof as well as the claim, and the three
// spans may overlap, so a relevance span that reaches back over its own proof
// satisfies this trivially. That looseness is deliberate, and was measured
// before it was kept. Banning containment between spans changed nothing: the
// whole suite still passed, and every paragraph tried stayed mappable, because
// a partly overlapping span shares the same words. Banning overlap outright
// did bite — it left three of four ordinary paragraphs with no legal mapping
// at all, including the "I would apply that experience to …" shape the
// anaphora exception below exists to allow — and none of them is visible to
// the drafting-stage reporter, so each would have become a rejection on a
// frozen letter whose only repair is a rewrite. A shared noun between a
// transfer sentence and the evidence it transfers is what the rule is for;
// reading it off an overlapping span is a weak audit, not a bad letter.
function relevanceSharesMechanism(relevance, claim, proof, paragraph = '') {
  const sourceTerms = new Set(argumentContentWords(`${claim} ${proof}`).filter(term => term.length >= MECHANISM_TERM_MIN_LETTERS));
  if (argumentContentWords(relevance).some(term => term.length >= MECHANISM_TERM_MIN_LETTERS && sourceTerms.has(term))) return true;
  // A writer need not repeat a capability noun after a proof that directly
  // precedes the bridge. Restrict this exception to explicit anaphora and
  // adjacent sentences so “that experience” has one clear, mapped antecedent
  // rather than permitting a detached generic closing to borrow any earlier
  // work in the letter.
  const paragraphSentences = sentences(paragraph);
  const proofIndex = paragraphSentences.findIndex(sentence => normalizedSpanIsInParagraph(proof, sentence));
  const relevanceIndex = paragraphSentences.findIndex(sentence => normalizedSpanIsInParagraph(relevance, sentence));
  const adjacentProof = proofIndex >= 0 && relevanceIndex === proofIndex + 1
    && paragraphHasCandidatePastProof(paragraphSentences[proofIndex]);
  if (!adjacentProof) return false;
  if (DIRECT_PROOF_ANAPHORA.test(relevance)) return true;
  // “The system” and “it” only get this exception when the immediately prior
  // mapped proof actually names an artifact. Without that antecedent they are
  // too ambiguous to certify a proof-to-target bridge deterministically.
  return PROOF_ARTIFACT_CUE.test(paragraphSentences[proofIndex])
    && (DIRECT_PROOF_ARTIFACT_REFERENCE.test(relevance) || DIRECT_PROOF_PRONOUN_REFERENCE.test(relevance));
}

// What the jobNeedQuote observation calls the posting copy it compared
// against, for a caller that has only one. A pipeline that prints a DIFFERENT
// copy to the responder than it grades against must pass its own label, or the
// rejection sends the writer back to the copy the gate never reads.
const DEFAULT_POSTING_QUOTE_LABEL = 'the job posting';

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
    return result('paragraph-argument-links', false, 'coverLetterPlan has no paragraph-level argument mappings');
  }
  if (plannedParagraphs.length !== finalParagraphs.length) {
    return result('paragraph-argument-links', false, `coverLetterPlan has ${plannedParagraphs.length} paragraph record(s), but the final letter has ${finalParagraphs.length} paragraph(s)`);
  }
  const observations = [];
  plannedParagraphs.forEach((planned, index) => {
    const mapping = planned?.argumentMapping;
    const paragraph = finalParagraphs[index] || '';
    if (mapping == null) {
      if (paragraphHasCandidatePastProof(paragraph)) {
        observations.push(`paragraph ${index + 1} contains a candidate past action but has no argumentMapping`);
      }
      return;
    }
    const claim = text(mapping.claim);
    const proof = text(mapping.proof);
    const relevance = text(mapping.relevance);
    const jobNeedQuote = text(mapping.jobNeedQuote);
    const label = `paragraph ${index + 1}`;
    for (const [field, span] of [['claim', claim], ['proof', proof], ['relevance', relevance]]) {
      if (!span) observations.push(`${label} argumentMapping.${field} is missing`);
      else if (!normalizedSpanIsInParagraph(span, paragraph)) observations.push(`${label} argumentMapping.${field} is not an exact normalized span of the final paragraph`);
      // Reported separately from containment because the repair is a different
      // one: the words are there, the cut is not on their boundaries. Extend
      // or trim the field to whole words; nothing in the letter has to change.
      else if (!wordAlignedSpanIsInParagraph(span, paragraph)) observations.push(`${label} argumentMapping.${field} begins or ends inside a word of the final paragraph; copy it out on word boundaries`);
    }
    if (!jobNeedQuote) observations.push(`${label} argumentMapping.jobNeedQuote is missing`);
    // Names the copy it was compared against, because that is the whole
    // repair: the words can be in the posting and still not be in this copy of
    // it, and a reader told only "the job posting" re-copies from whichever
    // one is nearest.
    else if (!normalized(postingQuoteText).includes(normalized(jobNeedQuote))) observations.push(`${label} argumentMapping.jobNeedQuote does not occur in ${postingQuoteLabel}; it is compared as a substring of that copy with only letter case ignored, so copy the span out of that copy's own characters`);
    if (claim && proof && normalized(claim) === normalized(proof)) observations.push(`${label} argumentMapping.claim duplicates its proof instead of stating the candidate capability it demonstrates`);
    if (claim && relevance && normalized(claim) === normalized(relevance)) observations.push(`${label} argumentMapping.claim duplicates its relevance instead of separating the candidate capability from the target transfer`);
    if (proof && relevance && normalized(proof) === normalized(relevance)) observations.push(`${label} argumentMapping.proof duplicates its relevance instead of separating past evidence from target transfer`);
    if (claim && (!CANDIDATE_CAPABILITY_CUE.test(claim)
      || (paragraphHasCandidatePastProof(claim) && !isGeneralPresentPerfectCapability(claim))
      || ARGUMENT_TRANSFER_CUE.test(claim))) {
      observations.push(`${label} argumentMapping.claim must state a general candidate capability, not a past proof or target-facing transfer`);
    }
    if (proof && !paragraphHasCandidatePastProof(proof)) observations.push(`${label} argumentMapping.proof does not state a candidate past action`);
    if (relevance) {
      if (GENERIC_ARGUMENT_RELEVANCE.test(relevance)) observations.push(`${label} argumentMapping.relevance uses a generic relevance label instead of explaining the transfer to target work`);
      if (VACUOUS_TARGET_WORK.test(relevance)) observations.push(`${label} argumentMapping.relevance names only a vacuous target label; state the actual responsibility or mechanism`);
      if (!ARGUMENT_TRANSFER_CUE.test(relevance)) observations.push(`${label} argumentMapping.relevance does not explicitly state how the candidate would transfer the proof to the target responsibility`);
      if (jobNeedQuote && !relevanceNamesNeed(relevance, jobNeedQuote)) observations.push(`${label} argumentMapping.relevance does not name a concrete responsibility from its jobNeedQuote`);
      if (!relevanceSharesMechanism(relevance, claim, proof, paragraph)) observations.push(`${label} argumentMapping.relevance does not name the shared capability or mechanism that connects the proof to target work`);
    }
  });
  const mappedCount = plannedParagraphs.filter(item => item?.argumentMapping != null).length;
  if (!mappedCount && finalParagraphs.some(paragraphHasCandidatePastProof)) {
    observations.push('coverLetterPlan has no argumentMapping for a proof-bearing paragraph');
  }
  return observations.length
    ? result('paragraph-argument-links', false, observations.slice(0, 12).join('; '))
    : result('paragraph-argument-links', true, `${mappedCount} proof-bearing paragraph argument mapping(s) bind exact claim, proof, relevance, and job-need spans`);
}

// A jobNeedQuote reaches checkParagraphArgumentLinks only after the generation
// -audit sanitizer has truncated the field, so no quote the gate can accept is
// longer than this. localAiApplication.js reads the same constant to do that
// truncating, and the enumeration below reads it to bound the quotes it
// considers reachable: a quote longer than this is one the gate never sees.
export const MAX_ARGUMENT_MAPPING_FIELD_CHARS = 1_000;
// Beyond this the span enumeration is quadratic in a paragraph no cover letter
// writes. Past it the reporter falls back to the cue-only verdict, which is
// the weaker one, so the subset relation holds either way.
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
function paragraphOffersRelevanceSpan(paragraph, postingQuoteText) {
  if (!ARGUMENT_TRANSFER_CUE.test(paragraph)) return false;
  const posting = text(postingQuoteText);
  const words = String(paragraph).split(/\s+/u).filter(Boolean);
  if (!posting || words.length > MAX_SPAN_ENUMERATION_WORDS) return true;
  const occurrences = postingTermOccurrences(posting);
  if (!occurrences.length) return true;
  for (const span of wordAlignedSpans(paragraph)) {
    const relevance = text(span);
    if (!ARGUMENT_TRANSFER_CUE.test(relevance)) continue;
    if (GENERIC_ARGUMENT_RELEVANCE.test(relevance) || VACUOUS_TARGET_WORK.test(relevance)) continue;
    if (relevanceCanNameSomeNeed(relevance, occurrences)) return true;
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
 * span of its paragraph, `normalized()` is `text()` lowercased, and both cues
 * are case-insensitive and unanchored — so a cue that matches a legal span
 * matches the whole paragraph too. A paragraph reported here therefore has no
 * span that could satisfy that field, and the gate must report the same field.
 * The reverse does not hold, and must not: a paragraph that offers a span
 * whose OTHER conditions fail is the review's to report, not this stage's.
 *
 * "By construction" is exact only because both sides read one predicate for
 * what counts as a span of a paragraph. This enumeration used to walk whole
 * words while the gate took any substring, so a span cut out of the middle of
 * a word — “systems delivery path” inside “microsystems delivery path” — was
 * legal at completion and invisible here: the letter was reported unmappable
 * at the stage that could still rewrite it, for a field the gate would have
 * accepted. `wordAlignedSpans` now enumerates exactly what
 * `wordAlignedSpanIsInParagraph` admits there.
 *
 * The relevance half needs the posting to reach that same standard. Carrying
 * the transfer cue is necessary for a relevance span but not sufficient: the
 * gate also rejects a span that reads as a generic relevance label, and a span
 * that names nothing from the posting. A paragraph whose only cue-bearing
 * spans are generic, and whose remaining ones share too little with the
 * posting, has no legal relevance span at all — and used to be reported by
 * nobody until the completion gate read it, with the letter frozen and the
 * only repair a rewrite. With `postingQuoteText` supplied, the candidate spans
 * are enumerated instead of guessed; without it the cue test stands alone,
 * which is the weaker verdict and therefore still a subset. That argument
 * holds only while this reads the SAME posting copy checkParagraphArgumentLinks
 * grades jobNeedQuote against: a copy with fewer terms in it would report a
 * paragraph the gate can map.
 *
 * Returns `[{ field, rule }]`, empty when the paragraph states no past action
 * of the candidate's or already offers both spans.
 */
export function paragraphArgumentSpanGaps(paragraph = '', postingQuoteText = '') {
  const value = text(paragraph);
  if (!paragraphHasCandidatePastProof(value)) return [];
  const gaps = [];
  if (!CANDIDATE_CAPABILITY_CUE.test(value)) gaps.push({ field: 'claim', rule: ARGUMENT_CLAIM_SPAN_RULE });
  if (!paragraphOffersRelevanceSpan(value, postingQuoteText)) gaps.push({ field: 'relevance', rule: ARGUMENT_RELEVANCE_SPAN_RULE });
  return gaps;
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

// Short, distinctive source constructions can feel repetitive across the
// résumé and letter even though they are below the general eight-word copy
// threshold. Keep this list narrow so ordinary technical overlap remains
// available for accurate evidence.
const SALIENT_ECHO_PHRASES = Object.freeze([
  'built from scratch',
]);

// The cover-letter contract prints the run length checkRedundancy rejects, and
// a threshold stated alone reads as a promise that anything shorter is safe.
// These phrases are the exception, so the contract prints them from this list
// rather than beside it.
export const COVER_LETTER_SALIENT_ECHO_PHRASES = SALIENT_ECHO_PHRASES
  .map(phrase => `“${phrase}”`).join(', ');

export function checkSalientPhraseEcho(paragraphs = [], evidence = {}) {
  const resumeWords = genericWords(bulletTexts(evidence).join(' '));
  const observations = [];
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  for (const phrase of SALIENT_ECHO_PHRASES) {
    const phraseWords = genericWords(phrase);
    if (!containsWordSequence(resumeWords, phraseWords)) continue;
    for (let index = 0; index < list.length; index++) {
      if (!containsWordSequence(genericWords(list[index]), phraseWords)) continue;
      observations.push(`paragraph ${index + 1} repeats the résumé phrase “${phrase}”; preserve the fact but use a natural supported alternative such as “designed and implemented,” “created,” “developed,” or “delivered”`);
    }
  }
  return observationResult('salient-phrase-echo', observations, MAX_SALIENT_ECHO_OBSERVATIONS,
    `${list.length} paragraph(s) avoid distinctive short phrase echoes from the résumé`);
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

function figures(value) {
  // Keep an explicitly signed figure intact. Starting the old matcher at the
  // digit after a minus sign made `-32%` indistinguishable from `32%`, which
  // can reverse the meaning of a résumé-backed metric. The unsigned branch
  // deliberately refuses to begin immediately after +/- so it cannot evade
  // the signed branch. Before matching, turn a dash *between two digits*
  // into a separator: `2024-2025` and `10–20%` are ranges, not a positive
  // number followed by a negative one. A real unary minus (`-32%`) has no
  // digit immediately before it and remains intact.
  const figureText = text(value).replace(/(\d)\s*-\s*(?=(?:[$€£])?\d)/g, '$1 ');
  const digitFigures = figureText.match(/(?<![\p{L}\p{N}])(?:[+-](?:[$€£])?\d[\d,]*(?:\.\d+)?(?:%|[kKmMbB])?|(?<![+-])(?:[$€£])?\d[\d,]*(?:\.\d+)?(?:%|[kKmMbB])?)(?![\p{L}\p{N}])/gu) || [];
  // A quantity written as words is still a quantitative claim when it carries
  // a duration or percentage unit.  Limiting this to explicit units avoids
  // treating ordinary prose such as “one of the team” as a figure.
  const spelledFigures = [...figureText.matchAll(SPELLED_FIGURE_RE)].map(match => match[0]);
  return [...digitFigures, ...spelledFigures];
}

function normalizeFigure(value) {
  // Separators and letter case do not alter a figure, but its currency sign
  // does. `$40` must not be treated as evidence for `40` (or vice versa).
  return text(value)
    .replace(/,/g, '')
    .toLowerCase()
    .replace(SPELLED_FIGURE_RE, (_match, quantity, unit) => `${SPELLED_FIGURE_VALUES[quantity.toLowerCase()]} ${unit.toLowerCase().replace(/s$/, '')}`)
    .replace(/(\d+)\s*-?\s*(years?|months?|weeks?|days?|hours?|minutes?|percent)\b/gu, (_match, quantity, unit) => `${quantity} ${unit.toLowerCase().replace(/s$/, '')}`);
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

export function checkFigureDiscipline(paragraphs = [], evidence = {}, plan = null) {
  const letterFigures = figures((Array.isArray(paragraphs) ? paragraphs : []).join(' '));
  // These checks must remain diagnostic-only. A partially persisted or legacy
  // evidence payload therefore cannot turn a recoverable letter defect into a
  // thrown application-generation failure.
  const roles = Array.isArray(evidence?.roles) ? evidence.roles : [];
  const skills = Array.isArray(evidence?.skills) ? evidence.skills : [];
  const education = Array.isArray(evidence?.education) ? evidence.education : [];
  const résuméText = [
    ...bulletTexts(evidence),
    ...roles.flatMap(role => [
      role?.title || '', role?.company || '', role?.dates || '', role?.location || '', role?.summary || '',
      ...(Array.isArray(role?.bullets) ? role.bullets : []).map(bullet => bullet?.text || ''),
    ]),
    ...skills.flatMap(skill => [skill?.group || '', ...(Array.isArray(skill?.items) ? skill.items : [])]),
    ...education,
  ].join(' ');
  const mappings = Array.isArray(plan?.mappings) ? plan.mappings : [];
  // Planned prose may use figures only from the evidence anchors the planner
  // selected. Treating every number anywhere in the résumé as permission let
  // an unrelated/research-only figure pass by coincidence. The direct fallback
  // has no mappings, so it retains the full fitted-résumé evidence boundary.
  const permittedFigureText = mappings.length
    ? mappings.map(mapping => text(mapping?.evidence)).join(' ')
    : résuméText;
  const résuméFigures = new Set(figures(permittedFigureText).map(normalizeFigure));
  const missingFigures = [];
  const seenMissing = new Set();
  for (const figure of letterFigures) {
    const normalizedFigure = normalizeFigure(figure);
    if (!résuméFigures.has(normalizedFigure) && !seenMissing.has(normalizedFigure)) {
      seenMissing.add(normalizedFigure);
      missingFigures.push(figure);
    }
  }
  const observations = [];
  if (letterFigures.length > MAX_LETTER_FIGURES) {
    observations.push(`letter contains ${letterFigures.length} figures ${boundedQuotedList(letterFigures)}; maximum is ${MAX_LETTER_FIGURES}`);
  }
  if (missingFigures.length) {
    observations.push(`figures absent from résumé evidence: ${boundedQuotedList(missingFigures)}`);
  }
  if (observations.length) return result('figure-discipline', false, observations.join('; '));
  return result('figure-discipline', true, `${letterFigures.length} figure(s) appear in résumé evidence`);
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
  return result(id, false,
    `${visible.join('; ')}${omitted ? `; ${omitted} additional observation(s) omitted` : ''}`);
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
  // Conjugated verbs (“students checked in devices”, “checking out a laptop”)
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

// “Before <thing> was adopted, <subject> had to choose <it>”: the subordinate
// clause supplies the acquisition and the main clause claims only the choice
// that acquisition already implies. The pronoun object is required, so “before
// the district adopted a vendor, I had to evaluate the market” — a different,
// informative claim — does not match.
const ENTAILED_ACQUISITION_PREMISE = /\b(?:before|prior to)\b[^,.;:!?]{0,90}?\b(?:adopted|adoption|purchased|bought|deployed|implemented|rolled out|brought in|selected|chosen)\b[^,.;:!?]{0,40},\s*[^,.;:!?]{0,60}?\b(?:had|needed)\s+to\s+(?:choose|select|pick|approve|evaluate|assess|decide\s+on)\s+(?:them|it|those|these|one)\b/iu;

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
  // migrated, ported) stay out on purpose: “moved each record from the student
  // system to the warehouse” states an action between two real endpoints.
  const stewardedRange = new RegExp(String.raw`\b(?:ran|run|runs|running|carried|carry|carries|carrying|took|take|takes|taking|owned|own|owns|owning|drove|drive|drives|driving|guided|guide|guides|guiding|handled|handle|handles|handling|managed|manage|manages|managing|shepherded|shepherd|shepherds|shepherding|ushered|usher|ushers|ushering|walked|walk|walks|walking|steered|steer|steers|steering)\b\s+(?:(?:each|every|all)(?:\s+[\p{L}'’-]+){0,2}|it|them|one)\s+from\s+([^,.;:!?]{1,60}?)\s+(?:to|through)\s+([^,.;:!?]{1,60})`, 'giu');
  // `through` is the inclusive-range preposition of an enumerable series
  // (“2019 through 2023”, “Monday through Friday”), where no other reading is
  // available. Between prose endpoints it keeps a live path reading, because a
  // quote request can literally pass through a final analysis, so a span
  // between abstract endpoints reads unambiguously only with `to`.
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
 * entails spends a line to reach the next claim: “before those products were
 * adopted, the district had to choose them” tells a reader nothing, because
 * adoption entails selection. The pattern stays closed to that entailment — a
 * completed acquisition event followed by an obligation to select the same
 * thing, referred to by a pronoun — because the general form (a premise the
 * page already supports) needs a reading of the argument, not a match. That
 * general form is stated in the letter prompt instead.
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
    if (!first || relationship.test(first.sentence)) continue;
    observations.push(`paragraph ${first.index + 1} first names “${employer}” without the candidate's role or relationship; introduce that context before relying on the employer as evidence`);
  }
  return observationResult('prior-employer-opening', observations, MAX_EXPERIENCE_FRAMING_OBSERVATIONS,
    'each prior employer is introduced with the candidate\'s role or relationship before its evidence');
}

// These checks receive project names from the structured résumé markup, never
// arbitrary capitalization in prose. That makes the check strict for a known
// artifact such as AI-Chalkboard without mistaking a target company, city, or
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

const UNCLEAR_DATA_FLOW_REFERENCES = Object.freeze([
  /\bacross with (?:its|their) data\b/iu,
  /\bdata they (?:consumed|ingested|produced|provided|returned|used)\b/iu,
  /\bthrough their APIs?\b/iu,
]);

/** Require explicit actors in data-flow prose instead of plural pronouns. */
export function checkReferenceClarity(passages = []) {
  const list = Array.isArray(passages) ? passages : [];
  const observations = [];
  list.forEach((passage, index) => {
    const source = text(passage);
    for (const pattern of UNCLEAR_DATA_FLOW_REFERENCES) {
      const match = pattern.exec(source);
      if (!match) continue;
      observations.push(`passage ${index + 1} uses “${boundedDetailValue(match[0])}”; name the data owner, producer, consumer, vendor, or agency explicitly`);
    }
  });
  return observationResult('reference-clarity', observations, MAX_REFERENCE_CLARITY_OBSERVATIONS,
    `${list.length} passage(s) name data-flow actors explicitly`);
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
      observations.push(`paragraph ${index + 1} names ${unlicensed.length} stack tools the posting and research never mention (${boundedQuotedList(unlicensed)}); keep at most one as that paragraph's single concrete anchor and describe the rest by technology category (for example “a component-based front end”, “containerized deployment”)`);
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
// claim ("conditional device actions", for example), it quietly recasts the
// prior workflow as work the new team needs. This is deliberately narrower
// than a semantic relevance scorer: it only rejects a concrete source phrase
// in a thesis or explicitly target-facing sentence, and only when the posting
// is substantial enough for silence to be meaningful.
const TARGET_FACING_REFERENCE = /\b(?:this|the|your)\s+(?:(?:[\p{L}'’-]+\s+){0,5})(?:role|position|team|work|service|services|system|systems|moderni[sz]ation)\b|\bat\s+(?:the\s+)?target\s+(?:employer|company)\b/iu;
const TARGET_TRANSFER_VERB = /\bi\s+(?:(?:would\s+)?(?:bring|apply|use)|would\s+(?:draw\s+on|contribute))\b/iu;
const TARGET_APPLICATION_CONSTRUCTION = /\b(?:applying|bringing|contributing)\s+my\b/iu;
const TARGET_SCOPE_STOP_WORDS = new Set([
  'about', 'after', 'also', 'and', 'are', 'before', 'between', 'build', 'building', 'by', 'can', 'could', 'design', 'designing', 'develop', 'developing', 'experience', 'for', 'from', 'help', 'implement', 'implementing', 'in', 'into', 'is', 'make', 'making', 'of', 'on', 'or', 'our', 'support', 'supporting', 'that', 'the', 'this', 'through', 'to', 'usable', 'use', 'using', 'web', 'with', 'would', 'your',
]);
// These terms name concrete physical, operational, or line-of-business
// artifacts. They can establish a source example, but an unmentioned one is
// almost never the capability a software role is asking for. The posting still
// licenses the term when it actually needs it. Keep this conservative: broad
// engineering nouns such as interface, access, service, and system are not
// domain artifacts and remain eligible for a transferable thesis.
const SOURCE_DOMAIN_ARTIFACTS = new Set([
  'barcode', 'badge', 'checkout', 'classroom', 'device', 'equipment', 'fleet',
  'inventory', 'kiosk', 'parcel', 'patient', 'shipment', 'student',
  'ticket', 'vehicle', 'warehouse',
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

/**
 * Keeps a prior workflow's mechanics in its proof sentence instead of
 * promoting them into the target thesis. A role thesis is always target
 * facing; prose needs an explicit target reference plus a prospective-transfer
 * verb before this limited lexical check applies.
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
    const sourceDomainTerm = claimWords.find(word => SOURCE_DOMAIN_ARTIFACTS.has(word)
      && sourceOnlyTerm(word, jobTerms, evidenceTerms));
    if (sourceDomainTerm) {
      observations.push(`${claim.label} presents the prior-work domain artifact “${sourceDomainTerm}” as target work even though the posting never names it; state the broader capability the posting supports, then use the specific prior workflow only as evidence`);
      if (observations.length >= MAX_TARGET_CLAIM_SCOPE_OBSERVATIONS) break;
      continue;
    }
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
  const ignored = new Set(['and', 'of', 'the', 'for', 'at']);
  const acronym = words(name)
    .filter(word => !ignored.has(normalized(word)))
    .map(word => word[0] || '')
    .join('');
  return [...new Set([name, acronym.length >= 2 ? acronym : ''].filter(Boolean))];
}

function namesProspectiveCompany(sentence, companyName = '') {
  const line = normalized(sentence);
  return companyReferenceAliases(companyName).some(alias => {
    const company = normalized(alias);
    return line.includes(`${company}'s`) || line.includes(`at ${company}`) || line.includes(`for ${company}`);
  });
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
      observations.push(`paragraph ${index + 1} uses a past/present readiness bridge for prospective-employer work (“${boundedDetailValue(match[0])}”); state the completed work as past evidence, then use conditional or future-facing target language, such as “At the target employer, I would apply that experience to …”`);
      if (observations.length >= MAX_COPY_PRECISION_OBSERVATIONS) break;
    }
    if (observations.length >= MAX_COPY_PRECISION_OBSERVATIONS) break;
  }
  return observationResult('prospective-contribution-tense', observations, MAX_COPY_PRECISION_OBSERVATIONS,
    `${list.length} paragraph(s) frame proposed employer contributions conditionally or prospectively`);
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
// branch with “I built the device check-in system from scratch too, in React
// and TypeScript, covering …”, where the seam sits mid-sentence in front of a
// trailing clause. Punctuation is the deterministic separator — additive “too”
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
// job included …”, and “Migration extended my systems work beyond
// evaluation.” Keep the check deliberately lexical and narrow. It catches the
// opaque hand-off, not every use of “problem”, “challenge”, “same”, or
// “beyond”.
const OPAQUE_RESPONSIBILITY_PIVOT = /\b(?:a|another|the)\s+(?:different|separate)\s+(?:problem|challenge)\b/iu;
const ANAPHORIC_PIVOT_SOLUTION = /^(?:i|we)\s+(?:solved|addressed|handled|tackled|fixed)\s+(?:it|that|this)\b/iu;
const SAME_JOB_SCOPE_OPENER = /^the\s+same\s+(?:job|role|position)\s+(?:also\s+)?(?:included|involved|covered)\b/iu;
// This terminal grammar says only that one abstract work category is broader
// than another. Requiring the whole sentence to fit the frame keeps concrete
// uses legal: “the migration extended the catalog without an outage” states a
// mechanism and result, while the generated scope sentence below states
// neither.
const CATEGORY_SCOPE_EXTENSION = /^(?:(?:operational|system|systems|platform|product|software|technology|technical|vendor|third[- ]party|data|service|application)\s+){0,3}(?:migration|implementation|integration|evaluation|assessment|selection|administration|deployment|operations?|planning)\s+(?:also\s+)?(?:extended|broadened|expanded)\s+my\s+(?:(?:third[- ]party|system|systems|platform|product|software|technology|technical|vendor|data|service|application)\s+){0,3}(?:work|experience|background|practice)\s+beyond\s+(?:(?:operational|system|systems|platform|product|software|technology|technical|vendor|third[- ]party|data|service|application)\s+){0,3}(?:migration|implementation|integration|evaluation|assessment|selection|administration|deployment|operations?|planning)[.!?]?$/iu;
// “Beyond moving operations, I used …” has the same defect in introductory
// form: a bare generic category marks addition but supplies no relationship.
// A determiner, named object, constraint, or other material before the comma
// takes the sentence out of scope, so “Beyond migrating the district catalog,
// I …” and “Beyond migration during the cutover, I …” remain legal.
const BARE_BEYOND_CATEGORY_OPENER = /^beyond\s+(?:(?:moving|migrating|evaluating|assessing|selecting|implementing|integrating|deploying|administering|operating|planning)\s+)?(?:(?:operational|system|platform|product|software|technology|technical|vendor|third[- ]party|data|service|application)\s+){0,2}(?:operations?|systems?|platforms?|products?|software|technology|tools?|data|services?|applications?|workflows?|migration|implementation|integration|evaluation|assessment|selection|administration|deployment|planning)\s*,\s*(?:i|we)\s+(?:\p{L}+ly\s+)?(?:used|built|created|developed|wrote|implemented|designed|managed|led|migrated|integrated|deployed|evaluated|assessed|selected|maintained)\b/iu;
// Once an umbrella sentence has named the branches, repeating each abstract
// label through the same low-information frame makes the paragraph read like
// an outline: “I handled workflow change by ... I addressed data exchange by
// ...”. The actions themselves should instantiate the branches. Keep this
// deliberately narrow to adjacent, mirrored first-person frames over a small
// set of abstract work categories; one useful “addressed X by” sentence is not
// a defect, nor is a concrete problem such as an outage or backlog.
const MIRRORED_CATEGORY_SCAFFOLD = /^(?:(?:separately|similarly|additionally|in\s+(?:separate|related|parallel|subsequent|additional)\s+[^,]{1,60}),\s*)?i\s+(?:handled|addressed|covered|managed|supported|demonstrated)\s+(?:the\s+)?(workflow changes?|data exchange|product evaluation|system migration|systems integration|implementation planning|vendor selection|platform administration|service deployment|operations?)\s+(?:by|through|such\s+as)\b/iu;

/**
 * Requires a substantive bridge when prose changes responsibilities.
 *
 * A shared employer, job, or chronology is context, not an argumentative
 * relationship. The repair names the shared responsibility, constraint, or
 * outcome before introducing the next proof; when the evidence cannot support
 * one, the writer should split or remove the weaker proof.
 */
export function checkResponsibilityTransition(paragraphs = []) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const observations = [];
  for (let index = 0; index < list.length; index++) {
    const paragraph = text(list[index]);
    if (SAME_JOB_SCOPE_OPENER.test(paragraph)) {
      observations.push(`paragraph ${index + 1} opens with “${leadingWordsSnippet(paragraph)}”; shared job scope is not a bridge between responsibilities — name the shared responsibility, constraint, or outcome before the new proof, or split or remove it`);
    }
    const paragraphSentences = sentences(paragraph);
    for (let sentenceIndex = 0; sentenceIndex < paragraphSentences.length; sentenceIndex++) {
      const sentence = paragraphSentences[sentenceIndex];
      if (CATEGORY_SCOPE_EXTENSION.test(sentence)) {
        observations.push(`paragraph ${index + 1} says “${boundedDetailValue(sentence)}”, which only renames one work category as broader than another; replace the scope comparison with a supported dependency, shared constraint, or outcome that explains why the next proof follows`);
      }
      if (BARE_BEYOND_CATEGORY_OPENER.test(sentence)) {
        observations.push(`paragraph ${index + 1} opens evidence with a bare category transition (“${leadingWordsSnippet(sentence)}”); “beyond” marks addition but does not explain the relationship—name the dependency, shared constraint, or outcome that connects the proofs`);
      }
      const solution = paragraphSentences[sentenceIndex + 1];
      if (!solution || !OPAQUE_RESPONSIBILITY_PIVOT.test(sentence) || !ANAPHORIC_PIVOT_SOLUTION.test(solution)) continue;
      observations.push(`paragraph ${index + 1} shifts from “${leadingWordsSnippet(sentence)}” to “${leadingWordsSnippet(solution)}” through an opaque problem label; name the shared responsibility, constraint, or outcome before the new proof, or split or remove it`);
    }
    for (let sentenceIndex = 0; sentenceIndex < paragraphSentences.length - 1; sentenceIndex++) {
      const first = MIRRORED_CATEGORY_SCAFFOLD.exec(normalized(paragraphSentences[sentenceIndex]));
      const second = MIRRORED_CATEGORY_SCAFFOLD.exec(normalized(paragraphSentences[sentenceIndex + 1]));
      if (!first || !second || first[1].toLowerCase() === second[1].toLowerCase()) continue;
      observations.push(`paragraph ${index + 1} repeats mirrored abstract labels (“${boundedDetailValue(first[1])}” then “${boundedDetailValue(second[1])}”); state the umbrella once, then let concrete action verbs demonstrate each branch, retaining only the separation cue needed to preserve factual scope`);
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

// “For tools that remained in-house, I built software.” only repeats its own
// category: a tool is software, so the sentence supplies neither a decision,
// constraint, mechanism, nor result. Keep this terminal form deliberately
// closed; a following specific object or result makes it ordinary evidence.
const LOW_INFORMATION_TOOL_BUILD = /^for\s+tools?\b[^.!?]{0,100},?\s+i\s+(?:built|developed|wrote|created)\s+software[.!?]?$/iu;

/** Reject a category-restating bridge sentence that cannot advance the argument. */
export function checkLowInformationToolBuild(paragraphs = []) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const observations = [];
  for (let index = 0; index < list.length; index++) {
    for (const sentence of sentences(list[index])) {
      const match = LOW_INFORMATION_TOOL_BUILD.exec(text(sentence));
      if (!match) continue;
      observations.push(`paragraph ${index + 1} says “${boundedDetailValue(sentence)}”, which only restates that tools are software; replace it with the supported decision, constraint, mechanism, or result—or remove it`);
    }
  }
  return observationResult('low-information-tool-build', observations, MAX_COPY_PRECISION_OBSERVATIONS,
    `${list.length} paragraph(s) avoid category-restating software claims`);
}

// These are web/application servers and reverse proxies, not containerization
// tools. The check reads the local “containerized … with/using/via …” grammar,
// not the mere co-occurrence of Docker and a server elsewhere in a paragraph.
const NON_CONTAINER_SERVER_TOOL = /\b(?:Nginx|Gunicorn|uWSGI|Apache|Tomcat|Caddy|HAProxy|Traefik|IIS|Passenger|Puma|Unicorn|mod_wsgi)\b/iu;
const CONTAINERIZATION_WITH_TOOL = /\bcontaineri[sz](?:e|ed|ing)\b[^.!?]{0,180}\b(?:with|using|via)\b[^.!?]{0,180}/iu;
const SEPARATE_DEPLOYMENT_ROLE_CLAUSE = /(?:,?\s+(?:and\s+)?then|,?\s+while|,?\s+where|,?\s+and)\s+(?:configured|used|ran|placed|served|deployed|operated|set\s+up)\b/iu;

/**
 * Ensure each deployment technology is governed by a verb describing its
 * actual role. serverMatch[0] is curly-quoted below like every other letter-
 * matched span this file reports: it names whichever one of the closed
 * NON_CONTAINER_SERVER_TOOL list the letter actually wrote (Nginx, Apache,
 * ...), which still varies letter to letter, and this check is one of
 * PASTE_CHECK_PROSE_UNITS' fingerprinted battery — see
 * checkPriorEmployerOpening's comment above for why that variation cannot be
 * interpolated bare.
 */
export function checkContainerizationTechnologyRoles(paragraphs = []) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const observations = [];
  for (let index = 0; index < list.length; index++) {
    for (const sentence of sentences(list[index])) {
      const containerizationPhrase = CONTAINERIZATION_WITH_TOOL.exec(sentence);
      if (!containerizationPhrase) continue;
      // A later “then configured Nginx …” clause has supplied Nginx with its
      // own role; do not mistake that separate predicate for a member of the
      // preceding “containerized with …” list.
      const governedTools = containerizationPhrase[0].split(SEPARATE_DEPLOYMENT_ROLE_CLAUSE, 1)[0];
      const serverMatch = NON_CONTAINER_SERVER_TOOL.exec(governedTools);
      if (!serverMatch) continue;
      observations.push(`paragraph ${index + 1} says “${boundedDetailValue(containerizationPhrase[0])}”; “${serverMatch[0]}” is a web or application server, not a containerization tool—name Docker or Docker Compose for containerization and describe “${serverMatch[0]}”'s server or proxy role separately`);
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
// noun (“the Intermediate Software Developer role centers on …”, “your recent
// posting asks for …”) and a fronted clause in front of the phrase (“At
// Axonify, the role centers on …”). Neither changes what the sentence does
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
      observations.push(`paragraph ${index + 1} asserts a cross-domain equivalence (“${boundedDetailValue(match[0])}”); name the source-supported transferable capability and explain how its shared mechanism (such as interaction design or data flow) helps with an actual responsibility in the posting, while preserving the boundary between domains`);
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

// Range semantics copied from the design-system hard gate (enDashIsRange in
// electron/ipc/resumeHtml.js, which throws during document build). A range may
// be spaced and may name the month on both sides (“May 2023 – June 2026”), and
// the gate blesses every such form, so a stricter soft rule here would send
// shipping-safe copy back for a revision round that could only damage it. The
// predicate is duplicated rather than imported because this module must stay
// free of the document builder's Electron/fs/jsdom imports; the harness asserts
// the two agree on a shared corpus.
const RANGE_MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const RANGE_RIGHT_ENDPOINT = new RegExp(`^\\s*(?:\\d|present\\b|${RANGE_MONTH}\\.?\\s+\\d{4}\\b)`, 'i');

function enDashIsRange(raw, index) {
  return /\d\s*$/.test(raw.slice(Math.max(0, index - 32), index))
    && RANGE_RIGHT_ENDPOINT.test(raw.slice(index + 1, index + 34));
}

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
 * House register: short declarative sentences, no semicolons, no dashes as
 * clause splices. Both marks read as generated prose to this user, and the
 * semicolon in particular became the model's escape hatch once the colon
 * unload was banned by name.
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

// In UI-guidance prose, bare “point” is ambiguous because an agent can point
// in the metaphorical sense of referring to something. The limitation being
// argued is visible on-screen indication, so require that distinction only in
// sentences that name both an agent-like actor and a concrete UI target.
const BARE_AGENT_UI_POINT = /\b(?:(?:AI\s+)?(?:agent|assistant)|Claude|automated\s+guide)\b[^.!?]{0,220}\b(?:cannot|can't)\s+(?!visually\b)(?:physically\s+)?(?:point|gesture)(?:\s+(?:at|to)\s+(?:the\s+)?|\s+out\s+(?:which\s+|the\s+))(?:control|button|field|menu|icon|element|link|tab|toggle|checkbox|input|panel|dialog|window|option|area|region|part)\b/iu;

/** Distinguishes a visible UI indication from metaphorical reference. */
export function checkVisualReferencePrecision(paragraphs = []) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const observations = [];
  for (let index = 0; index < list.length; index++) {
    for (const sentence of sentences(list[index])) {
      const match = BARE_AGENT_UI_POINT.exec(sentence);
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
// sentence: "I welcome the chance to talk about how my pipeline experience
// helps me contribute to your platform team." passes checkDirectWelcomeClosing
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
// after all: “applying my MCP server experience to the agent integrations this
// role owns” and “the connector work I built would fit the systems this team
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
// descriptor. The third exists because “that MCP server experience” does name
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
// work" is just as vacuous while "that same-day pipeline experience" is not.
// A light-noun frame always puts `of` or a light noun in the head position.
const DESCRIPTOR_FILLERS = 'of|kind|kinds|sort|sorts|type|types|phase|part|parts|area|areas|line|piece'
  + '|bit|amount|next|same|other|others|more|much|such|that|this';
const CANDIDATE_ASSET_CLOSE = new RegExp(
  `\\bmy\\s+(?:[\\p{L}’'-]+\\s+){0,3}(?:${CANDIDATE_ASSET_NOUNS})\\b`
  + `|\\bthe\\s+(?:[\\p{L}’'-]+\\s+){0,3}(?:${CANDIDATE_ASSET_NOUNS}|${CANDIDATE_ARTIFACT_NOUNS})\\s+I\\s+`
  + '(?:built|wrote|designed|created|developed|shipped|led|own|owned|maintained|architected)\\b'
  + `|\\b(?:that|this|those|these)\\s+(?:[\\p{L}’'-]+\\s+){0,2}(?!(?:${DESCRIPTOR_FILLERS})\\s)[\\p{L}’'-]+\\s+(?:${CANDIDATE_ASSET_NOUNS})\\b`,
  'iu',
);
// The present-tense forms are not optional extras: the routine and SKILL.md
// both tell the writer to keep this invitation in direct present tense, and a
// modal-only guard measurably rejected “…how my pipeline experience supports
// your ingestion backlog” — the sentence the contract asks for.
const CONTRIBUTION_VERBS = 'support|contribute(?:\\s+to)?|help|advance|strengthen|improve|build|deliver'
  + '|apply|serve|shorten|extend|scale|accelerate|fit';
const CONTRIBUTION_VERBS_PRESENT = 'supports|contributes(?:\\s+to)?|helps|advances|strengthens|improves|builds'
  + '|delivers|applies|serves|shortens|extends|scales|accelerates|fits';
const CANDIDATE_CONTRIBUTION_ACTION = new RegExp(
  `\\b(?:can|could|would|will|might)\\s+(?:[\\p{L}’'-]+\\s+){0,2}(?:${CONTRIBUTION_VERBS})\\b`
  + `|\\b(?:${CONTRIBUTION_VERBS_PRESENT})\\b`
  + '|\\b(?:apply|applying|bring|bringing|put|putting|use|using|contribute|contributing'
  + '|extend|extending|connect|connecting|carry|carrying)\\b',
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
// Micromart's smart-store rollout." — which is exactly the shape every other
// rule in this app pushes a writer toward (checkOpeningEmployerShorthand,
// checkPriorEmployerOpening, and company-specificity itself all want the
// employer named, not a placeholder pronoun). The generic-only lexicon
// rejected it anyway, four consecutive rounds (2026-09-24,
// 13:08:05Z–13:10:40Z, every rejection fingerprint 752d8241 on this check's
// direct-conversation branch), because "Micromart's" satisfies none of
// "your", "the/this <noun>", or the reader-noun list. employerFacingTarget()
// below now also accepts the employer's own name, derived from companyName.
const EMPLOYER_TARGET_NOUNS = 'team|teams|role|position|group|organi[sz]ation|company|district|product|products'
  + '|platform|codebase|backlog|roadmap|effort|work|mission|practice|pipeline|pipelines|system|systems|service|services'
  // Nouns an employer-facing closing names when the target is a specific
  // initiative rather than a standing team or system: "the smart-store
  // rollout", "this migration", "your onboarding flow". Measured directly
  // against the incident's own rejected sentences ("…support Micromart's
  // smart-store rollout", "…support Micromart's inventory sync") — rollout and
  // migration are exactly the nouns those closings used.
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
// "Micromart Inc." names the same reader-facing company as "Micromart", and
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
 * name CASE-INSENSITIVELY plus its distinctive leading token ("Micromart" for
 * "Micromart Inc.") CASE-SENSITIVELY — the two halves deliberately do not
 * share a case-sensitivity rule (see below for why the full multi-word name
 * is exempt from the case-sensitive treatment). A SINGLE-word name gets only
 * the case-sensitive token match — see the dedicated comment on that branch
 * below for why it is not also given a case-insensitive alternative the way
 * the multi-word full name is. Every alternative optionally accepts a
 * trailing possessive "'s" — straight or curly, since the letter text this
 * matches against is not guaranteed to have gone through text()'s apostrophe
 * normalization by the time this runs — and all are escapeRegExp'd: this
 * app's own company names include parenthesized forms ("Amazon Web Services
 * (AWS)") whose literal characters would otherwise be read as regex syntax.
 *
 * Case-sensitive tokens are guarded only by length>=3 and a 3-word stopword
 * set. Measured false positives: "Best Buy" -> "Best" matched "my best
 * work"; "Target Corporation" -> "Target" matched this app's own guidance
 * text ("target work"); and this app's own job board turns up real employers
 * whose distinguishing token is an ordinary English word — Float, Loop
 * Financial, Provision, Stripe, Top Hat. Each one let candidate-facing prose
 * satisfy the target half of the three-part closing requirement without the
 * sentence ever reaching the employer's side — a false PASS, the more
 * expensive of the two failure directions on a check gating a paste handoff.
 * Matching that token CASE-SENSITIVELY, exactly as the company spells it,
 * closes that: a letter naming the employer writes "Provision's ingestion
 * pipeline" with the posting's own capital; candidate-facing prose writes
 * "provision" lowercase. This is not airtight — sentence-initial
 * capitalization ("Provision handles onboarding.") would still satisfy the
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
  // companyName 'Float', "how my integration work could support my own float
  // of ideas" — pure candidate-facing prose, no employer reference at all —
  // satisfied the target half before this branch existed, because a
  // single-word name fell through to fullNamePattern below, which is
  // case-INSENSITIVE by design for the multi-word case. That design choice is
  // right for a two-word full name ("Best Buy" together, lowercase or not, is
  // measurably unlikely to appear by coincidence) but wrong for a one-word
  // name that IS one of this app's own measured ordinary-word collisions
  // (Float, Provision, Stripe are all single tokens) — a single common word
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
function missingContributionHalves(value, companyName) {
  const missing = [];
  if (!CANDIDATE_ASSET_CLOSE.test(value)) missing.push('asset');
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
        + 'its own descriptor (“my integration work”, “the connector I built”, “that MCP server experience”), '
        + 'never a bare demonstrative (“that work”)';
    case 'action':
      return 'say what that asset does for the target work (“…could support…”, “…supports…”, “applying … to …”)';
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
      return 'reach the employer’s side too — “your …”, “the”/“this” plus a work noun (“the … platform”, “this '
        + `… pipeline”), a reader noun (“clients”, “customers”, “users”)${namedClause}; a sentence naming only the `
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
 * COURTESY_CLOSING_SENTENCE recognizes. Shared by finalSubstantiveClosingSentence
 * below — which is what checkDirectWelcomeClosing certifies — and
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

/** The final sentence of a paragraph that carries content beyond courtesy. */
function finalSubstantiveClosingSentence(paragraph) {
  const list = sentences(paragraph);
  const index = finalSubstantiveClosingSentenceIndex(list);
  return index >= 0 ? list[index] : '';
}

/** Keeps the invitation in the closing direct and specific. */
export function checkDirectWelcomeClosing(paragraphs = [], companyName = '') {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const observations = [];
  const index = list.length - 1;
  const finalSentence = index >= 0 ? finalSubstantiveClosingSentence(list[index]) : '';
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
  const missing = missingContributionHalves(finalSentence, companyName);
  const selfDirectedMatch = SELF_DIRECTED_CONVERSATION_CLOSE.exec(finalSentence)
    || LOOK_FORWARD_CONVERSATION_CLOSE.exec(finalSentence);
  if (selfDirectedMatch && missing.length) {
    observations.push(`paragraph ${index + 1}'s final substantive sentence ends with conversation or learning intent (“${boundedDetailValue(selfDirectedMatch[0])}”) but no candidate contribution; the invitation wording itself is correct, so keep it; ${candidateContributionRequirement(missing, companyName)}`);
  }
  const directConversation = DIRECT_CONVERSATION_CLOSE.exec(finalSentence);
  const employerChoice = EMPLOYER_CHOICE_CLOSE.exec(finalSentence);
  if (employerChoice) {
    observations.push(`paragraph ${index + 1}'s final substantive sentence asks the employer to choose between initiatives (“${boundedDetailValue(employerChoice[0])}”); close with the candidate's concrete contribution to the target work instead of posing an employer-facing prototype question`);
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
const DURATION_NUMBER_WORDS = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
});
const DURATION_NUMBER_SOURCE = `(?:\\d{1,2}|${Object.keys(DURATION_NUMBER_WORDS).join('|')})`;
// "over four years" and "4+ years" assert a floor, so any longer span in the
// evidence supports them. Every other shape asserts the number itself.
const DURATION_LOWER_BOUND_WORDS = Object.freeze(['over', 'more than', 'at least', 'upwards of', 'north of', 'greater than']);
const DURATION_HEDGE_WORDS = Object.freeze(['nearly', 'almost', 'about', 'around', 'roughly', 'approximately']);
const DURATION_QUALIFIER_SOURCE = `(?:${[...DURATION_LOWER_BOUND_WORDS, ...DURATION_HEDGE_WORDS].join('|')})`;
// An experience span the CANDIDATE claims, not every mention of a year. Two
// markers carry that meaning and nothing else does reliably: a bound on the
// number ("4+", "over four", and the hedges, which are the fingerprint of a
// span someone computed), or the word experience attached to the span.
//
// A bare "<number> years of <noun>" was measured too wide to keep. It reads
// the same in "three years of full-stack development" and in "cut the nightly
// job from three years of accumulated backlog to a same-day queue", where the
// years belong to the backlog; rejecting the second costs a round AND deletes
// a true, concrete detail, which is worse than the claim it would catch. That
// unmarked shape is left to the contracts, which state the rule in full on all
// three stages that can write one. Silent by construction: "the four-year
// rollout", "from three years to six weeks", "Python 3", "24/7", and any bare
// calendar year.
//
// "years of <something> experience" is the posting's own way of asking, and
// the phrase names the span as practice however many words separate the two,
// so the word is looked for in the clause that follows rather than only
// directly after. The window stops at the first sentence break: a later
// sentence that happens to use the word is not this phrase's meaning.
const DURATION_CLAIM_RE = new RegExp(
  `(?:\\b(${DURATION_QUALIFIER_SOURCE})\\s+)?`
  + `\\b(${DURATION_NUMBER_SOURCE})\\s*(\\+)?\\s*(?:[-\u2013\u2011]\\s*)?years?\\b(?:['\u2019]s?)?`
  + `(?:\\s+(of|in))?(\\s+experience)?\\b`,
  'giu');
// Any "<number> years" the evidence states, in any shape. The evidence side is
// deliberately wider than the claim side, exactly as the qualifier rules are:
// it decides whether the span was WRITTEN DOWN, not how it was phrased.
const DURATION_EXPERIENCE_WINDOW_CHARS = 72;
const DURATION_EXPERIENCE_TAIL_RE = /^[^.;:!?]*\bexperience\b/iu;
const DURATION_EVIDENCE_RE = new RegExp(`\\b(${DURATION_NUMBER_SOURCE})\\s*\\+?\\s*(?:[-\u2013\u2011]\\s*)?years?\\b`, 'giu');

// Every stage that can write a span states this rule in prose, so the shapes
// and the window are derived from the constants findUnsupportedDurationClaim
// reads instead of transcribed into three contracts. Stating the SHAPES is
// what makes the rule followable: the phrase that trips it is decided by a
// bound, a hedge, or the word that follows, never by who the sentence says the
// span belongs to \u2014 so a writer told only "a span must be supported" cannot
// tell that attributing one to the posting is still a claim.
export const DURATION_CLAIM_SHAPE_RULE = 'a span of years is read as a claim when the number carries a bound '
  + `(a trailing \u201c+\u201d, or ${DURATION_LOWER_BOUND_WORDS.join(', ')}), when it carries a hedge `
  + `(${DURATION_HEDGE_WORDS.join(', ')}), or when the words following it, within ${DURATION_EXPERIENCE_WINDOW_CHARS} `
  + 'characters and before the first sentence break, call that span experience; a bounded span is supported by any '
  + 'longer span the cited quotes state, and every other shape needs a cited quote stating that same number of years';

function durationValue(token) {
  const lower = String(token || '').toLowerCase();
  return Object.hasOwn(DURATION_NUMBER_WORDS, lower) ? DURATION_NUMBER_WORDS[lower] : Number.parseInt(lower, 10);
}

function statedDurationYears(sourceText) {
  const years = new Set();
  for (const match of String(sourceText || '').matchAll(DURATION_EVIDENCE_RE)) {
    const value = durationValue(match[1]);
    if (Number.isFinite(value)) years.add(value);
  }
  return years;
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
  const stated = statedDurationYears(quotes.join(' '));
  for (const match of String(finalText || '').matchAll(DURATION_CLAIM_RE)) {
    const [phrase, qualifier, number, plus, preposition, experience] = match;
    const claimed = durationValue(number);
    if (!Number.isFinite(claimed)) continue;
    const lowerBound = Boolean(plus) || DURATION_LOWER_BOUND_WORDS.includes(String(qualifier || '').toLowerCase());
    const claimsExperience = Boolean(experience)
      || (Boolean(preposition) && DURATION_EXPERIENCE_TAIL_RE.test(String(finalText).slice(match.index + phrase.length, match.index + phrase.length + DURATION_EXPERIENCE_WINDOW_CHARS)));
    // Without a bound on the number or the span being named as experience, it
    // is not claimed as the candidate's own practice; see DURATION_CLAIM_RE.
    if (!lowerBound && !qualifier && !claimsExperience) continue;
    const supported = lowerBound
      ? [...stated].some(value => value >= claimed)
      : stated.has(claimed);
    if (supported) continue;
    return {
      // The trailing preposition is only how the shape was recognized; quoting
      // it back ("4+ years of") would read like a truncated sentence.
      phrase: boundedDetailValue(phrase.trim().replace(/\s+(?:of|in)$/iu, '')),
      years: claimed,
      lowerBound,
      statedYears: [...stated].sort((a, b) => a - b),
    };
  }
  return null;
}

// A paragraph-opening demonstrative noun phrase promises that its referent
// sits in the paragraph the reader just finished. A shipped letter opened a
// paragraph “That evaluation practice …” two paragraphs after the evaluation
// material, forcing the reader to hunt backward. Deliberately narrow: only
// the opening words of paragraphs after the first are read, only when the
// demonstrative heads a noun phrase (pronoun and fixed-phrase heads are
// skipped via the stopword set), and the referent search stems both sides so
// “evaluated” anchors “evaluation”. Mid-paragraph demonstratives have local
// context and stay out of scope.
const OPENING_DEMONSTRATIVE_RE = /^(?:that|this|these|those)\s+([\p{L}’'-]+)(?:\s+([\p{L}’'-]+))?/iu;
const DEMONSTRATIVE_HEAD_STOPWORDS = new Set([
  'is', 'was', 'are', 'were', 'be', 'being', 'been', 'has', 'had', 'have',
  'said', 'same', 'one', 'way', 'why', 'how', 'what', 'kind', 'sort', 'much',
  'many', 'last', 'first', 'second', 'time', 'point', 'and', 'or', 'of', 'in',
  'to', 'a', 'an', 'the', 'my', 'own', 'very',
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
    const heads = [match[1], match[2]]
      .filter(Boolean)
      .map(word => word.toLowerCase())
      .filter(word => !DEMONSTRATIVE_HEAD_STOPWORDS.has(word));
    if (!heads.length) continue;
    const previousWords = words(list[index - 1]);
    if (heads.some(head => previousWords.some(word => referentStemsMatch(head, word)))) continue;
    observations.push(`paragraph ${index + 1} opens with “${leadingWordsSnippet(paragraph, 4)}”, but the previous paragraph never mentions ${heads.map(head => `“${head}”`).join(' or ')}; name the referent explicitly or open with this paragraph's own subject`);
  }
  return observationResult('opening-demonstrative', observations, MAX_OPENING_DEMONSTRATIVE_OBSERVATIONS,
    `${list.length} paragraph(s) anchor their opening references in the preceding paragraph`);
}

// At a paragraph boundary, “The district” after “Thomson School District”
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
  // that starts at two. The live letter of 2026-09-23 is the measurement:
  // paragraph 2 opened "In that role, my application experience includes" and
  // paragraph 3 answered "In that Software Engineer role, my migration
  // experience spans", one shape in consecutive paragraphs, two of four, and
  // the whole battery passed it. So adjacency is read as its own defect, and
  // only for shapes the count has not already reported, because a shape over
  // the ceiling is the same defect and must not be named twice in one message.
  //
  // This branch charges a shape checkRepeatedPhrase excuses the words of, and on
  // that same letter it does: it reports paragraph 1 sentence 5 and paragraph 2
  // sentence 4 for one shape, "i would * that *", while
  // repeatComparisonSentence removes those very words from the repeat
  // comparison. Read as one rule the pair looks contradictory; they are two
  // levels, and what the writer was free to do differs at each. ARGUMENT_RELEVANCE_SPAN_RULE mandates a transfer
  // carrier but offers a CHOICE of shapes to carry it in, so once one is chosen
  // its words are compliance and charging them would charge obedience. Reaching
  // for the same shape again in the very next paragraph is not compliance with
  // anything: the rule left that open, and paragraph 3 of that letter shows it
  // was satisfiable, transferring on "I can apply that" while 1 and 2 both used
  // "I would apply that". Rotating among the shapes a rule offers is exactly
  // what this check exists to ask for, so the asymmetry is the design.
  const adjacent = [...shapes]
    .filter(([frame, locations]) => !over.some(([reported]) => reported === frame)
      && backToBackShapeLocations(locations).length > 0)
    .map(([frame, locations]) => [frame, backToBackShapeLocations(locations)])
    .sort((left, right) => right[1].length - left[1].length
      || left[1][0].paragraph - right[1][0].paragraph);
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
const ARGUMENT_TRANSFER_CUE_GLOBAL = new RegExp(ARGUMENT_TRANSFER_CUE.source, `${ARGUMENT_TRANSFER_CUE.flags}g`);
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
// determiner-headed one. ARGUMENT_RELEVANCE_ANAPHORA_RULE permits a bare
// back-reference in six fixed phrases only, so a capability that fits none of
// them has to be NAMED again in the transfer sentence, and that re-naming is the
// noun phrase the carrier's verb takes: “I would apply THAT SCALABILITY
// APPROACH”, “I would apply MY EXPERIENCE DELIVERING SUPPORTED SYSTEMS”. Both
// are mandated, and both land beside the claim they answer inside one paragraph.
//
// A carrier whose own match already reaches the capability noun (“apply that
// experience”) has named what it transfers inside the match, so there is nothing
// to walk; and the two cue shapes that end on the TARGET rather than on a
// capability (“helping this role”, “supporting your team”) are followed by the
// target's own words, which no rule mandates. Requiring a determiner is what
// separates the two cases without a second cue list.
const TRANSFERRED_CAPABILITY_DETERMINERS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'our', 'its', 'their', 'his', 'her',
]);
// The real end of either phrase is the first function word after it, which is
// what stops the walk on every letter measured so far; this is the bound for a
// sentence that has no function word left. Five words is the longest re-naming
// the measured letters carry (“my experience delivering supported systems”), so
// six leaves one word of headroom and still cannot swallow a sentence's tail.
const MAX_TRANSFERRED_CAPABILITY_WORDS = 6;
// Where ARGUMENT_RELEVANCE_SPAN_RULE's shapes put the responsibility the
// transfer reaches: apply, bring, use or contribute the capability TO the
// responsibility. The responsibility has to be named — relevanceNamesNeed grades
// the relevance span for two content words of its jobNeedQuote — and at the
// drafting stage no caller yet holds that quote, so the slot the rule mandates
// is read instead of the words it will later be graded against. Only this one
// preposition: the measured letter of 2026-09-23 hung “across UI and backend”
// off its capability phrase before reaching “to feature design …”, and reading
// every preposition would have excused exactly the echo this round is for.
const TRANSFER_TARGET_PREPOSITION = 'to';
// Read off the three regexes the anaphora rule is PRINTED from rather than
// restated, so the phrases a writer is told may stand in for the re-naming are
// the same ones excused here. Global copies only: the exclusion has to find
// every occurrence in a sentence, not the first.
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
 * A function word is where a noun phrase ends: “that scalability approach ACROSS
 * ui and backend” ends at “across”, “my experience delivering supported systems
 * TO reliable system delivery” at “to”, “the reliable system delivery THIS role
 * needs” at “this”. FRAME_FUNCTION_WORDS is the same closed set the shape check
 * holds literal and runContentWordCount counts against, so the three checks
 * agree on which words are syntax.
 *
 * `requireDeterminer` is what separates the two slots. A capability handed over
 * is written with one (“that scalability approach”, “my experience delivering
 * supported systems”), and requiring it is what keeps the walk off a carrier
 * that already named the capability inside its own match (“apply that experience
 * to …”, where the next word is the preposition) and off the two cue shapes that
 * end on the target rather than a capability. A responsibility is as often bare
 * (“to reliable system delivery”) as determined (“to the reliable system
 * delivery this role needs”), so the target slot takes either.
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
 * Token positions one carrier's mandated phrases occupy: the capability it hands
 * over, and the responsibility it reaches.
 *
 * Everything between the two is the writer's own, which is the whole point of
 * reading them as two phrases rather than as one span from the carrier to the
 * end of the sentence. On the measured letter that middle is “across UI and
 * backend”, carried verbatim out of the proof sentence three sentences earlier.
 */
function mandatedTransferPositions(tokens, carrier) {
  const afterCarrier = tokens.findIndex(token => token.start >= carrier.end);
  if (afterCarrier < 0) return [];
  const capability = nounPhrasePositions(tokens, afterCarrier, { requireDeterminer: true });
  const searchFrom = capability.length ? capability[capability.length - 1] + 1 : afterCarrier;
  const preposition = tokens
    .findIndex((token, index) => index >= searchFrom && token.word === TRANSFER_TARGET_PREPOSITION);
  const target = preposition < 0 ? [] : nounPhrasePositions(tokens, preposition + 1, { requireDeterminer: false });
  return [...capability, ...target];
}

/**
 * One sentence as a comparable word stream, with the words a mandated argument
 * carrier occupies blanked out, plus a second stream for the comparison against
 * its OWN paragraph, where the rules dictate more of the sentence than the
 * carrier.
 *
 * ARGUMENT_TRANSFER_CUE is not a phrase the writer chose. The argument contract
 * REQUIRES that carrier shape in every proof-bearing paragraph and prints it to
 * the stage that writes them, so a letter whose paragraphs all carry it is
 * obeying the rules, and reporting the repeat would make two rules contradict
 * each other. The carrier's words are removed from the comparison rather than
 * filtered off the result, because longestSharedRun answers with one run per
 * pair: post-filtering the carrier would let it stand in front of a real repeat
 * in the same pair of sentences and hide it, which is exactly what happens in
 * the measured letter, where one pair of transfer sentences carries both the
 * mandated carrier and a four-word run the writer repeated on top of it.
 *
 * This excuses the carrier's WORDS while checkRepeatedSentenceShape's adjacency
 * branch charges its SHAPE, and on the measured letter both fire that way at
 * once: nothing here reports "i would apply that", and that check reports
 * paragraph 1 sentence 5 and paragraph 2 sentence 4 for carrying one shape in
 * back-to-back paragraphs. That is deliberate, and it is not two rules
 * contradicting each other, because the writer's freedom differs at the two
 * levels. ARGUMENT_RELEVANCE_SPAN_RULE offers a CHOICE of carrier shapes: I
 * would apply, bring, use or contribute; I can apply, bring or use; apply,
 * bring, use or contribute that, this, my or the experience, work, capability,
 * practice, approach or judgment; and the rest enumerated there. Once a writer
 * has chosen one, its exact words are mandated, so charging those words would be
 * charging compliance. Choosing the SAME shape in two paragraphs that stand next
 * to each other is mandated by nothing: it is a choice that rule left open and
 * the writer declined to make, and the measured letter's own paragraph 3 proves
 * the alternative was available, since it transferred on "I can apply that"
 * where paragraphs 1 and 2 both reached for "I would apply that". Making a
 * writer rotate among the shapes a rule offers has been the shape check's whole
 * job since it was written.
 *
 * The second stream is what a transfer sentence is compared as against the rest
 * of ITS OWN paragraph, and it exists because the first build of this exclusion
 * took the whole sentence out of that comparison. The reason it did is sound as
 * far as it goes: inside one paragraph the transfer sentence is the one sentence
 * whose CONTENT the rules dictate too — the capability has to be re-named (see
 * TRANSFERRED_CAPABILITY_DETERMINERS) and the relevance span has to reach the
 * responsibility its jobNeedQuote came from, so the need gets named again as
 * well — and both re-namings land beside the claim and the need they answer.
 * Comparing them would make this check contradict the three rules that produced
 * them, and it did: comparing the whole sentence failed 39 test sites that
 * assert a contract-following fixture letter is accepted, 38 of them on one
 * shared fixture paragraph.
 *
 * But blanking the WHOLE sentence overshoots, and the measured letter of
 * 2026-09-23 is the cost. Its paragraph 1 stated “scalability across the UI and
 * backend” in sentences 2 and 3 and then closed on “I would apply that
 * scalability approach across UI and backend to …”. “That scalability approach”
 * is the mandated re-naming; “across UI and backend” is elaboration hung off it,
 * mandated by nothing, and a verbatim echo of sentence 3 that the whole-sentence
 * exemption could not see. So only the mandated words come out: the carrier, the
 * capability phrase it hands over, the responsibility phrase it reaches, the
 * phrases the anaphora rule permits in place of the capability phrase, and the
 * paragraph's own job-need vocabulary where a caller holds the quote. Everything
 * else in the sentence is compared exactly as any other sentence is.
 *
 * Across paragraphs nothing is blanked but the carrier. Nothing asks two
 * paragraphs to transfer the same capability in the same words, and the measured
 * letter carried one four-word run from one transfer sentence into the next.
 */
function repeatComparisonSentence(sentence, key, jobNeedQuote) {
  const source = normalized(sentence);
  const tokens = [...source.matchAll(WORD_TOKEN_RE)]
    .map(match => ({ word: match[0], start: match.index, end: match.index + match[0].length }));
  const carriers = matchedSpans(source, ARGUMENT_TRANSFER_CUE_GLOBAL);
  const carried = tokens.map(token => tokenInSpans(token, carriers));
  const words = tokens.map((token, index) => (carried[index] ? blankedToken(key, index) : token.word));
  // A sentence with no carrier is under no content mandate at either distance,
  // so it is compared as one stream and the two are the same array.
  if (!carriers.length) return { words, sameParagraphWords: words };
  const anaphora = PERMITTED_ANAPHORA_GLOBAL.flatMap(pattern => matchedSpans(source, pattern));
  const mandated = new Set(carriers.flatMap(carrier => mandatedTransferPositions(tokens, carrier)));
  // argumentContentWords is the same reader relevanceNamesNeed grades the
  // overlap with, so the words excused here are exactly the ones that gate
  // makes the sentence carry: its stop words and its plural folding included.
  const needTerms = new Set(argumentContentWords(jobNeedQuote));
  const sameParagraphWords = tokens.map((token, index) => (
    carried[index] || mandated.has(index) || tokenInSpans(token, anaphora)
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
  // of the measured letter's paragraph 1, which echoed “ui and backend” out of
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
// them over-corrects. The words the argument contract dictates in a transfer
// sentence, and a run of names, are repeats the system itself asked for, so
// rewriting one spends a handoff round AND breaks the rule that demanded it; a
// writer who thinks the ordinary syntax holding two sentences together is
// counted has to write around the language to satisfy a rule that never applied
// to it; and one who is told only that a transfer sentence is treated specially
// hangs the next echo off the phrase it excuses, which is the defect this round
// was opened for, so the clause says what is still counted there.
export const REPEATED_PHRASE_RULE =
  `a verbatim run of ${MIN_SAME_PARAGRAPH_REPEAT_WORDS} words or more repeated inside one paragraph,`
  + ` or of ${MIN_CROSS_PARAGRAPH_REPEAT_WORDS} words or more carried from one paragraph into another,`
  + ' is reported at every position it stands in past the first, wherever in the letter it sits;'
  + ' the mandated transfer carrier is never counted against you, and inside its own paragraph neither is the'
  + ' capability phrase that carrier hands over, nor the responsibility phrase it reaches, each read to the'
  + ' first function word that ends it, nor a phrase the anaphora exception lets stand in for the capability,'
  + ' nor the wording its own paragraph’s job-need quote puts there, since the relevance rules mandate each of those;'
  + ' what a transfer sentence adds around those mandated words is counted like any other wording.'
  + ' A run of nothing but capitalized names is not counted either,'
  + ` and neither is a run carrying fewer than ${MIN_REPEAT_CONTENT_WORDS} content words,`
  + ' which is the scaffolding two English sentences share rather than either of them reaching back for the other,'
  + ' so make each point in its own words rather than reaching back for the words that made it last time';

/**
 * The letter repeating itself. Nothing in this battery compared a paragraph to
 * itself or to another paragraph: `checkRedundancy` and `checkSalientPhraseEcho`
 * measure the letter against the RÉSUMÉ, `checkRepeatedSentenceShape` compares
 * skeletons with every content word erased, and every other n-gram site takes
 * its needle from the résumé, the plan or a fixed list. So the letter of
 * 2026-09-23 stated "scalability across the UI and backend" twice in one
 * paragraph, opened a sentence in each of two paragraphs with "The engineering
 * challenge was", and named "device management platforms" twice in three
 * sentences, and the whole battery passed it.
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
 * the measurement — its paragraph 1 names "device check-in and check-out" in
 * sentence 2 and again in sentence 4, once as what was built and once as what
 * moved onto a third-party platform. That run stays reported: it is
 * indistinguishable in structure from the "device management platforms" repeat
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
 * that costs is bounded rather than lucky: both re-namings the relevance rules
 * mandate are already excused by POSITION — the capability the carrier hands over
 * and the responsibility it reaches (see mandatedTransferPositions) — so reading
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

/** Evaluates the prose-level checks used to decide the single revision attempt. */
export function evaluateCoverLetterChecks({ plan = {}, paragraphs = [], evidence = {}, jobText = '', researchText = '', companyName = '' } = {}) {
  const plannedCompanyDetail = text(plan?.companyHook?.detail);
  const priorEmployers = (Array.isArray(evidence?.roles) ? evidence.roles : [])
    .map(role => text(role?.company)).filter(Boolean);
  const companySpecificity = researchText && !plannedCompanyDetail
    ? result('company-specificity', true, 'skipped: argument plan intentionally omitted a company-specific hook')
    : checkCompanySpecificity(paragraphs, researchText, companyName, plannedCompanyDetail);
  return [
    checkRedundancy(paragraphs, evidence),
    checkSalientPhraseEcho(paragraphs, evidence),
    checkGenericPhrases(paragraphs),
    checkInterestFraming(paragraphs),
    checkExperienceInfinitiveGrammar(paragraphs),
    companySpecificity,
    checkShape(plan, paragraphs),
    checkFigureDiscipline(paragraphs, evidence, plan),
    checkLogisticsExclusion(plan, paragraphs),
    // Register and style checks. They are appended rather than interleaved so
    // the established check order stays stable, and every one of them reads
    // paragraphs only, so they still run in the plan-degraded path where the
    // call site filters out the plan-dependent 'shape' result.
    checkCompoundHyphenation(paragraphs),
    checkParallelStructure(paragraphs),
    checkPriorEmployerOpening(paragraphs, priorEmployers),
    checkNamedArtifactIntroduction(paragraphs, (Array.isArray(evidence?.projects) ? evidence.projects : []).map(project => project?.name)),
    checkOpeningArtifactContext(
      paragraphs,
      (Array.isArray(evidence?.projects) ? evidence.projects : []).map(project => project?.name),
      priorEmployers,
    ),
    checkVagueDomainWorkLabel(paragraphs),
    checkReferenceClarity(paragraphs),
    checkModifierAttachment(paragraphs),
    checkAnchorRelevance(paragraphs, jobText, researchText),
    checkTargetClaimScope(plan, paragraphs, evidence, jobText),
    checkDetachedRelevanceClaim(paragraphs),
    checkProspectiveContributionTense(paragraphs, companyName),
    checkAdditiveSeam(paragraphs),
    checkResponsibilityTransition(paragraphs),
    checkToolCallsGardenPath(paragraphs),
    checkLowInformationToolBuild(paragraphs),
    checkContainerizationTechnologyRoles(paragraphs),
    checkPostingReference(paragraphs),
    checkClaimedEquivalence(paragraphs),
    checkDanglingParagraphTransition(paragraphs),
    checkSentenceLength(paragraphs),
    checkPunctuationStyle(paragraphs),
    checkPlainRegister(paragraphs),
    checkIntroductoryWorkplaceComma(paragraphs, priorEmployers),
    checkVisualReferencePrecision(paragraphs),
    checkDirectWelcomeClosing(paragraphs, companyName),
    checkOpeningDemonstrative(paragraphs),
    checkOpeningEmployerShorthand(paragraphs, priorEmployers),
    checkAdjacentEmployerRepetition(paragraphs, priorEmployers),
    checkEntailedPremise(paragraphs),
    checkRepeatedSentenceShape(paragraphs),
    checkRepeatedPhrase(paragraphs, { jobNeedQuotes: paragraphJobNeedQuotes(plan) }),
    checkCandidateAgency(paragraphs),
  ];
}

/** Authors the stable cover-letter fields without changing the document-builder contract. */
export function authorCoverLetterEnvelope({ job = {}, evidence = {}, today = '' } = {}) {
  const company = text(job.company);
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
    closing: 'Sincerely,',
    signatureTitle: '',
  };
}
