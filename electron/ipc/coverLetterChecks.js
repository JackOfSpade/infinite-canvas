// Deterministic, dependency-free checks for the cover-letter argument harness.
// Keep this module free of Electron/LLM/fs imports: the checks are deliberately
// usable from the Node smoke suite and from the application pipeline.

export const MIN_EVIDENCE_SHINGLE_WORDS = 5;
export const MIN_EVIDENCE_TOKEN_OVERLAP = 0.6;
export const REDUNDANCY_SHINGLE_WORDS = 8;
export const MAX_REDUNDANCY_PHRASE_WORDS = 24;
export const MAX_CHECK_DETAIL_VALUE_CHARS = 160;
export const MAX_LETTER_FIGURES = 3;
export const MAX_FIGURE_DETAIL_ITEMS = 12;
export const MAX_GENERIC_OBSERVATIONS = 12;
export const MAX_LOGISTICS_CONTAINMENT_OBSERVATIONS = 8;
export const MAX_HYPHENATION_OBSERVATIONS = 8;
export const MAX_ANCHOR_RELEVANCE_OBSERVATIONS = 8;
export const MAX_ADDITIVE_SEAM_OBSERVATIONS = 4;
export const MAX_POSTING_REFERENCE_OBSERVATIONS = 4;
export const MAX_CLAIMED_EQUIVALENCE_OBSERVATIONS = 4;
export const MAX_SENTENCE_LENGTH_OBSERVATIONS = 5;
export const MAX_PUNCTUATION_OBSERVATIONS = 8;
export const MAX_PLAIN_REGISTER_OBSERVATIONS = 4;
export const MAX_SALIENT_ECHO_OBSERVATIONS = 4;
export const MAX_LEGAL_STATUS_OBSERVATIONS = 4;
export const MAX_OPENING_DEMONSTRATIVE_OBSERVATIONS = 4;
export const MAX_PARALLEL_STRUCTURE_OBSERVATIONS = 8;
export const MAX_EXPERIENCE_FRAMING_OBSERVATIONS = 4;
export const MAX_REFERENCE_CLARITY_OBSERVATIONS = 8;
export const MAX_COPY_PRECISION_OBSERVATIONS = 4;
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
export const OBSERVATION_SNIPPET_WORDS = 8;

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

function words(value) {
  return normalized(value).match(/[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu) || [];
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
  if (countWords < 6) return result('role-thesis', false, `roleThesis has only ${countWords} words; it does not establish a specific controlling claim`);
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
  return result('mapping-narrative-structure', true, `second mapping explicitly ${role}s the primary proof`);
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
 * Career data has one deliberately narrow plan-only lane: stated logistics.
 * Treat that lane like résumé evidence rather than trusting a model-authored
 * availability or relocation assertion.  Near-quote/overlap permits normal
 * grammatical cleanup while requiring the source to actually say it.
 */
export function checkLogisticsGrounding(plan = {}, careerData = '') {
  const logistics = text(plan?.logistics);
  if (!logistics) return result('logistics-grounding', true, 'no career-data logistics claim');
  const sourceWords = words(careerData);
  const logisticsWords = words(logistics);
  const run = sharedRunLength(logisticsWords, sourceWords);
  const overlap = tokenOverlap(logisticsWords, sourceWords);
  const shortClaim = logisticsWords.length < 8;
  const requiredRun = Math.min(MIN_EVIDENCE_SHINGLE_WORDS, logisticsWords.length);
  // Short phrases have too few tokens for a bag-of-words score to mean
  // anything: “available weekends, local” can otherwise be assembled from
  // unrelated profile fragments. Require the entire short phrase as a source
  // run; longer prose still needs both a concrete source run and broad overlap.
  const grounded = shortClaim
    ? run === logisticsWords.length
    : run >= requiredRun && overlap >= MIN_EVIDENCE_TOKEN_OVERLAP;
  return grounded
    ? result('logistics-grounding', true, 'plan logistics are grounded in career data')
    : result('logistics-grounding', false,
      `plan logistics share a longest ${run}-word run and ${Math.round(overlap * 100)}% token overlap with career data${shortClaim ? '; short logistics claims require a contiguous source match' : ''}`);
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
 * authorization, or other logistical qualification.
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
    `${dropped.length} eligibility need(s) honestly dropped: ${dropped.map(item => `#${item.index + 1} ${item.kind} — ${boundedDetailValue(item.reason)}`).join('; ')}`);
}

/**
 * A truthful plan may leave a hard credential or eligibility screen unargued.
 * That cannot be fixed by asking the model to invent a qualification, but it
 * must remain visible beside the shipped letter rather than only in telemetry.
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
      `top-ranked ${kind} need is not argued (honestly dropped): ${boundedDetailValue(dropped.reason) || 'no reason recorded'}`);
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

// These are logistics concepts, not a general claim or tone vocabulary. The
// prose writer receives logistics only through the plan, so a concept absent
// from that field is necessarily a strengthened availability/location promise.
const LOGISTICS_CONCEPTS = Object.freeze([
  { label: 'availability', pattern: /\bavailab(?:le|ility)\b/iu },
  { label: 'full-time', pattern: /\bfull[- ]time\b/iu },
  { label: 'part-time', pattern: /\bpart[- ]time\b/iu },
  { label: 'evening schedule', pattern: /\bevenings?\b/iu },
  { label: 'overnight schedule', pattern: /\bovernights?\b/iu },
  { label: 'weekend schedule', pattern: /\bweekends?\b/iu },
  { label: 'shift schedule', pattern: /\bshifts?\b/iu },
  { label: 'on-call schedule', pattern: /\bon[- ]call\b/iu },
  { label: 'round-the-clock coverage', pattern: /\bround[- ]the[- ]clock\b/iu },
  { label: 'continuous coverage', pattern: /\bcontinuous(?:[\s,;:-]+[\p{L}-]+)?[\s,;:-]+coverage\b/iu },
  { label: 'coverage', pattern: /\bcoverage\b/iu },
  { label: '24/7 coverage', pattern: /\b(?:24\s*\/\s*7|24[- ]?hour)\b/iu },
  { label: 'relocation', pattern: /\brelocat(?:e|es|ed|ing|ion)\b/iu },
  { label: 'local status', pattern: /\blocal(?:ly)?\b/iu },
  { label: 'commute', pattern: /\bcommut(?:e|es|ed|ing)\b/iu },
]);

/**
 * Keep logistics promises structurally contained to plan.logistics. This does
 * not attempt semantic inference: it only forbids named scheduling, coverage,
 * and location concepts that the plan did not explicitly supply.
 */
export function checkLogisticsContainment(plan = {}, paragraphs = []) {
  const planLogistics = text(plan?.logistics);
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const observations = [];
  for (let paragraphIndex = 0; paragraphIndex < list.length; paragraphIndex++) {
    const paragraph = text(list[paragraphIndex]);
    for (const concept of LOGISTICS_CONCEPTS) {
      if (concept.pattern.test(paragraph) && !concept.pattern.test(planLogistics)) {
        observations.push(`paragraph ${paragraphIndex + 1} mentions ${concept.label}, which is absent from plan logistics`);
      }
    }
  }
  if (observations.length) {
    const visible = observations.slice(0, MAX_LOGISTICS_CONTAINMENT_OBSERVATIONS);
    return result('logistics-containment', false,
      `logistics containment observations: ${visible.join('; ')}${observations.length > visible.length ? `; ${observations.length - visible.length} additional observation(s) omitted` : ''}`);
  }
  return result('logistics-containment', true, 'prose logistics concepts are contained in plan logistics');
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

/**
 * A process range promises grammatically parallel endpoints. This deliberately
 * checks the high-confidence generated-prose failure only: a noun-like left
 * endpoint followed by a gerund right endpoint. Wider coordination needs a
 * prose audit; this narrow form is safe enough to reject before publication.
 */
export function checkParallelStructure(passages = []) {
  const list = Array.isArray(passages) ? passages : [];
  const observations = [];
  const processRange = /\bfrom\s+([^,.;:!?]{1,80}?)\s+(to|through)\s+([\p{L}][\p{L}'’-]*ing)\b/giu;
  const opaqueRunRange = /\b(?:ran|run|running)\s+(?:each|every)(?:\s+one)?\s+from\s+([^,.;:!?]{1,60}?)\s+(?:to|through)\s+([^,.;:!?]{1,60})/giu;
  for (let index = 0; index < list.length; index++) {
    const passage = text(list[index]);
    const opaque = opaqueRunRange.exec(passage);
    if (opaque) {
      observations.push(`passage ${index + 1} uses “${boundedDetailValue(opaque[0])}”; name the process steps with explicit action verbs instead of “run each from X through Y”`);
      opaqueRunRange.lastIndex = 0;
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
 * The first cover-letter sentence must orient an unfamiliar prior employer.
 * A bare "At <employer>" opener assumes the reader already knows why that
 * organization belongs in the argument; naming the prior role or relationship
 * supplies that missing context. Later evidence paragraphs may use the shorter
 * form once the letter's argument is established.
 */
export function checkPriorEmployerOpening(paragraphs = [], employerNames = []) {
  const firstSentence = sentences(Array.isArray(paragraphs) ? paragraphs[0] : '')[0] || '';
  const observations = [];
  for (const employer of (Array.isArray(employerNames) ? employerNames : [])
    .map(text).filter(Boolean).sort((left, right) => right.length - left.length)) {
    if (!new RegExp(`^At\\s+${escapeRegExp(employer)}\\s*,`, 'iu').test(firstSentence)) continue;
    observations.push(`opening sentence begins “${leadingWordsSnippet(firstSentence, 6)}”; introduce the candidate's prior role or relationship at ${employer} before the evidence`);
    break;
  }
  return observationResult('prior-employer-opening', observations, MAX_EXPERIENCE_FRAMING_OBSERVATIONS,
    'the opening sentence contextualizes any prior employer it introduces');
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
      licenses.set(entry, corpus.includes(normalized(entry)) || corpus.includes(normalized(entry.split(' ')[0])));
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
    observations.push(`letter names ${letterWide.length} stack tools the posting and research never mention (${boundedQuotedList(letterWide)}); the resume carries the stack — keep at most one off-posting tool name in the whole letter`);
  }
  return observationResult('anchor-relevance', observations, MAX_ANCHOR_RELEVANCE_OBSERVATIONS,
    `${letterWide.length} off-posting stack tool name(s) across ${list.length} paragraph(s)`);
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

/** Ensure each deployment technology is governed by a verb describing its actual role. */
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
      observations.push(`paragraph ${index + 1} says “${boundedDetailValue(containerizationPhrase[0])}”; ${serverMatch[0]} is a web or application server, not a containerization tool—name Docker or Docker Compose for containerization and describe ${serverMatch[0]}'s server or proxy role separately`);
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
const POSTING_REFERENCE_PATTERN = /\b(?:your|the|this)\s+(?:job\s+)?(?:posting|advert(?:isement)?)\b|\bjob\s+ad\b|\bas\s+advertised\b/giu;
const SOURCE_DOCUMENT_ATTRIBUTION = /^(?:the|this)\s+(?:(?:job|role|position)\s+)?(?:posting|listing|description|advert(?:isement)?)\s+(?:describes?|states?|notes?|identifies?|specifies?|indicates?|outlines?|explains?)\b/iu;
const BARE_LISTING_ATTRIBUTION = /^(?:the|this)\s+listing\s+(?:describes?|states?|notes?|identifies?|specifies?|indicates?|outlines?|explains?)\b/iu;
const NON_SOURCE_REPORTING_SUBJECT = /^(?:the|this)\s+(?:role|position|job)\s+(?:describes?|states?|says?|notes?|mentions?|indicates?|specifies?|outlines?|explains?)\b/iu;
const DETACHED_TARGET_POSITION = /^the\s+(?:role|position)(?:'s|\s+(?:needs?|requires?|focus(?:es)?|centers?|involves?|offers?|calls?|is|would|can|will|seeks?))\b/iu;

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
        observations.push(`paragraph ${index + 1} opens with a detached target-position reference (“${boundedDetailValue(detachedTarget[0])}”); use a proximal reference for the position attached to this application unless contrasting it with another role`);
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
const CLAIMED_EQUIVALENCE_PATTERN = /\bmaps?\s+(?:directly\s+)?onto\b|\btranslates?\s+directly\s+(?:to|into)\b|\bis\s+(?:exactly|precisely)\s+what\b|\b[^.!?]{1,80}\s+and\s+[^.!?]{1,80}\s+are\s+(?:two|both)\s+(?:answers?|responses?|sides?|forms?)\s+(?:to|of)\s+(?:one|the\s+same)\s+(?:(?:[\p{L}-]+)\s+){0,4}(?:decision|question|call|choice)\b/giu;

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
      observations.push(`paragraph ${index + 1} asserts a cross-domain equivalence (“${boundedDetailValue(match[0])}”); an asserted analogy invites the reader to test the gap — explain the shared mechanism (constraints, data flow, failure modes) and let the transfer stay implicit`);
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
// Two fixed formulas rather than an attempt to score formality. Citizenship
// and “legally entitled to” phrasing used to live here as register repairs;
// they moved to checkLegalStatus because their correct repair is removal, and
// a register suggestion (“write it plainly: I am a Canadian citizen”) was
// canonicalizing the exact sentence the letter must not contain.
const PLAIN_REGISTER_PATTERNS = Object.freeze([
  /\bin\s+possession\s+of\b/iu,
  /\bpossess(?:es)?\s+a\s+valid\b/iu,
]);

/** Keeps logistics facts in plain first person rather than officialese. */
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
    `${list.length} paragraph(s) state logistics facts in plain first person`);
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
const CONDITIONAL_WELCOME_CLOSE = /\bI(?:\s+would|'d)\s+welcome\s+(?:(?:the\s+)?(?:chance|opportunity)|(?:a\s+)?(?:conversation|discussion))\b|\bI\s+(?:would|'d)\s+be\s+(?:glad|happy|pleased)\s+to\s+(?:discuss|talk|speak|connect|share|explore)\b/iu;

// A closing can be grammatically direct yet still leave the reader with only
// the writer's wish to have a conversation or learn more. Keep this family
// deliberately bounded to first-person intention/desire plus a conversational
// or learning endpoint. It does not judge ordinary uses of want/hope/plan, or
// invitations that occur before the final sentence of the letter.
const SELF_DIRECTED_CONVERSATION_CLOSE = /\bI\s+(?:want|hope|plan|aim|intend)\s+to\s+(?:talk|speak|discuss|connect|learn|explore)\b/iu;
const LOOK_FORWARD_CONVERSATION_CLOSE = /\bI\s+look\s+forward\s+to\s+(?:talking|speaking|discussing|connecting|learning|exploring)\b/iu;
const DIRECT_CONVERSATION_CLOSE = /\bI\s+welcome\s+(?:(?:(?:the\s+)?(?:chance|opportunity))\s+to\s+(?:talk|speak|discuss|connect|share|explore)|(?:a\s+)?(?:conversation|discussion)\b)/iu;
const EMPLOYER_CHOICE_CLOSE = /\b(?:conversation|discussion)\s+about\s+whether\b[^.!?]{0,180}\b(?:or|versus)\b/iu;
const CANDIDATE_CONTRIBUTION_CLOSE = /\bmy\s+(?:(?:[\p{L}’'-]+\s+){0,3})(?:experience|skills?|work|background|perspective|practice)\b[^.!?]{0,180}\b(?:can|could|would|will)\s+(?:support|contribute(?:\s+to)?|help|advance|strengthen|improve|build|deliver|apply)\b/iu;

// A future-facing discussion can be an effective close when it makes the
// candidate's contribution concrete. The positive guard is deliberately
// modest: it recognizes an explicit candidate asset connected to an action
// that advances the employer's work, rather than trying to infer relevance
// from every sentence containing a conversation verb.
function hasCandidateContributionClose(value) {
  return CANDIDATE_CONTRIBUTION_CLOSE.test(value);
}

/** Keeps the invitation in the closing direct and specific. */
export function checkDirectWelcomeClosing(paragraphs = []) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const observations = [];
  const index = list.length - 1;
  const finalSentence = index >= 0 ? (sentences(list[index]).at(-1) || '') : '';
  const conditionalMatch = CONDITIONAL_WELCOME_CLOSE.exec(finalSentence);
  if (conditionalMatch) observations.push(`paragraph ${index + 1} uses a conditional or deferential invitation (“${boundedDetailValue(conditionalMatch[0])}”); make the invitation direct and name the specific work or contribution to discuss`);
  const selfDirectedMatch = SELF_DIRECTED_CONVERSATION_CLOSE.exec(finalSentence)
    || LOOK_FORWARD_CONVERSATION_CLOSE.exec(finalSentence);
  if (selfDirectedMatch && !hasCandidateContributionClose(finalSentence)) {
    observations.push(`paragraph ${index + 1} ends with conversation or learning intent (“${boundedDetailValue(selfDirectedMatch[0])}”) but no candidate contribution; close by connecting the candidate's experience, skills, or work to the specific work they could support`);
  }
  const directConversation = DIRECT_CONVERSATION_CLOSE.exec(finalSentence);
  const employerChoice = EMPLOYER_CHOICE_CLOSE.exec(finalSentence);
  if (employerChoice) {
    observations.push(`paragraph ${index + 1} asks the employer to choose between initiatives (“${boundedDetailValue(employerChoice[0])}”); close with the candidate's concrete contribution to the target work instead of posing an employer-facing prototype question`);
  } else if (directConversation && !hasCandidateContributionClose(text(list[index]))) {
    observations.push(`paragraph ${index + 1} uses a direct conversation invitation (“${boundedDetailValue(directConversation[0])}”) but never connects a candidate asset to the employer's work; name the experience, skills, or work that could support the specific target responsibility`);
  }
  return observationResult('direct-welcome-closing', observations, MAX_COPY_PRECISION_OBSERVATIONS,
    `${list.length} paragraph(s) use a direct, specific invitation when they close with “welcome”`);
}

// Legal work status is application-form data, never letter prose: the form
// asks the question, and a letter that answers it unasked spends argument
// space on an eligibility screen. Unlike the register family this is a
// removal rule, not a rephrasing rule, so no observation suggests a plain
// wording. Closed list; the capitalized-nationality guard keeps common-noun
// uses such as “citizen developers” out of scope.
const LEGAL_STATUS_CONCEPTS = Object.freeze([
  { label: 'citizenship', pattern: /\b\p{Lu}(?:\p{L}|\.)*\s+citizen(?:ship)?\b/u },
  { label: 'citizenship', pattern: /\b(?:my|dual)\s+citizenship\b/iu },
  { label: 'citizenship', pattern: /\bcitizen\s+of\s+\p{Lu}\p{L}+\b/u },
  { label: 'work authorization', pattern: /\bwork\s+(?:authoriza|authorisa)tion\b/iu },
  { label: 'work authorization', pattern: /\bwork\s+(?:permit|eligibility)\b/iu },
  { label: 'work authorization', pattern: /\b(?:authorized|authorised|eligible|entitled|cleared)\s+to\s+work\b/iu },
  { label: 'work authorization', pattern: /\bright\s+to\s+work\b/iu },
  { label: 'work authorization', pattern: /\blegally\s+entitled\s+to\b/iu },
  { label: 'residency status', pattern: /\bpermanent\s+residen(?:t|ts|cy)\b/iu },
  { label: 'residency status', pattern: /\bgreen\s+card\b/iu },
  { label: 'visa status', pattern: /\bvisa\s+(?:status|sponsorship|holder|requirements?)\b/iu },
  { label: 'visa status', pattern: /\b(?:require|need|needs|without|no)\s+(?:a\s+)?(?:visa|sponsorship)\b/iu },
  { label: 'visa status', pattern: /\b(?:work|student|immigration)\s+visa\b/iu },
]);

function legalStatusMatch(value) {
  for (const concept of LEGAL_STATUS_CONCEPTS) {
    const match = concept.pattern.exec(value);
    if (match) return { label: concept.label, phrase: match[0] };
  }
  return null;
}

/**
 * Legal work status never belongs in letter prose; the repair is deletion.
 * There is no compliant rewording, which is why the old plain-register
 * citizenship arm (which suggested one) was retired rather than kept beside
 * this check with contradictory advice.
 */
export function checkLegalStatus(paragraphs = []) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const observations = [];
  for (let index = 0; index < list.length; index++) {
    const found = legalStatusMatch(text(list[index]));
    if (!found) continue;
    observations.push(`paragraph ${index + 1} states ${found.label} (“${boundedDetailValue(found.phrase)}”); delete the statement — legal work status belongs on the application form, never in the letter`);
  }
  return observationResult('legal-status', observations, MAX_LEGAL_STATUS_OBSERVATIONS,
    `${list.length} paragraph(s) leave legal work status to the application form`);
}

/** Plan-side twin of checkLegalStatus, so the fact is retried out of the plan before prose exists. */
export function checkLogisticsLegalStatus(plan = {}) {
  const found = legalStatusMatch(text(plan?.logistics));
  if (found) {
    return result('logistics-legal-status', false,
      `plan logistics states ${found.label} (“${boundedDetailValue(found.phrase)}”); logistics carries availability, location intent, or stated motivation — legal work status belongs on the application form, so remove it from the plan entirely`);
  }
  return result('logistics-legal-status', true, 'plan logistics carries no legal work status');
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

/** Returns the strict pre-prose gate without ever throwing or blocking shipping. */
export function checkPlanGate(plan = {}, evidence = {}, needs = [], jobText = '', researchText = '', careerData = '') {
  const checks = [
    checkRoleThesis(plan),
    checkEvidenceGrounding(plan, evidence),
    checkNeedGrounding(needs, jobText, researchText),
    checkLogisticsGrounding(plan, careerData),
    checkLogisticsLegalStatus(plan),
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
    checkExperienceInfinitiveGrammar(paragraphs),
    companySpecificity,
    checkShape(plan, paragraphs),
    checkFigureDiscipline(paragraphs, evidence, plan),
    checkLogisticsContainment(plan, paragraphs),
    // Register and style checks. They are appended rather than interleaved so
    // the established check order stays stable, and every one of them reads
    // paragraphs only, so they still run in the plan-degraded path where the
    // call site filters out the plan-dependent 'shape' result.
    checkCompoundHyphenation(paragraphs),
    checkParallelStructure(paragraphs),
    checkPriorEmployerOpening(paragraphs, priorEmployers),
    checkVagueDomainWorkLabel(paragraphs),
    checkReferenceClarity(paragraphs),
    checkModifierAttachment(paragraphs),
    checkAnchorRelevance(paragraphs, jobText, researchText),
    checkAdditiveSeam(paragraphs),
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
    checkDirectWelcomeClosing(paragraphs),
    checkLegalStatus(paragraphs),
    checkOpeningDemonstrative(paragraphs),
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
