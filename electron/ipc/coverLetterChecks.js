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

function sentenceCount(value) {
  const source = text(value);
  if (!source) return 0;
  if (typeof Intl?.Segmenter === 'function') {
    return Array.from(new Intl.Segmenter('en', { granularity: 'sentence' }).segment(source))
      .filter(segment => text(segment?.segment)).length;
  }
  return source.split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}])/u).filter(Boolean).length;
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
      return result('evidence-grounding', false,
        `mapping ${mappingIndex + 1} shares a longest ${bestRun}-word run and ${Math.round(bestOverlap * 100)}% token overlap with résumé bullets`);
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

/** Returns the strict pre-prose gate without ever throwing or blocking shipping. */
export function checkPlanGate(plan = {}, evidence = {}, needs = [], jobText = '', researchText = '', careerData = '') {
  const checks = [
    checkRoleThesis(plan),
    checkEvidenceGrounding(plan, evidence),
    checkNeedGrounding(needs, jobText, researchText),
    checkLogisticsGrounding(plan, careerData),
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
export function evaluateCoverLetterChecks({ plan = {}, paragraphs = [], evidence = {}, researchText = '', companyName = '' } = {}) {
  const plannedCompanyDetail = text(plan?.companyHook?.detail);
  const companySpecificity = researchText && !plannedCompanyDetail
    ? result('company-specificity', true, 'skipped: argument plan intentionally omitted a company-specific hook')
    : checkCompanySpecificity(paragraphs, researchText, companyName, plannedCompanyDetail);
  return [
    checkRedundancy(paragraphs, evidence),
    checkGenericPhrases(paragraphs),
    checkExperienceInfinitiveGrammar(paragraphs),
    companySpecificity,
    checkShape(plan, paragraphs),
    checkFigureDiscipline(paragraphs, evidence, plan),
    checkLogisticsContainment(plan, paragraphs),
  ];
}

/** Authors the stable cover-letter fields without changing the document-builder contract. */
export function authorCoverLetterEnvelope({ job = {}, evidence = {}, today = '' } = {}) {
  const company = text(job.company);
  const identity = evidence?.identity || {};
  return {
    name: text(identity.name),
    tagline: text(identity.tagline),
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
