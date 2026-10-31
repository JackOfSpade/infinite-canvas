/** Deterministic, deliberately conservative checks for prepared spoken claims.
 * Equivalences below normalize grammar, not new achievements. Exact sources
 * remain the authority; a fluent sentence alone never establishes entailment.
 */
const WORDS = /[\p{L}]+(?:\+\+|#|\*)?|\d+(?:[.,]\d+)*|[%$£€]/gu;
const FUNCTION_WORDS = new Set(('a an the i we my our me us it its they their them he she his her this that these those and or but so as at by for from in into of on to with without through between against than until while which who whom what when where how each all some others another other one both also then there had has have having be been being am is are was were do did does can could would should will may might not no never only already about over under up out before after more most such per very own together solo co closely correctly example work job approach strength strengths experience taking').split(' '));
const NUMBER_WORDS = new Map(Object.entries({ zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20', thirty: '30', forty: '40', fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90', hundred: '100', thousand: '1000', million: '1000000', billion: '1000000000' }));
const ROOTS = new Map();
for (const group of [
  'build built building', 'choose chose chosen choosing', 'design designed designing',
  'implement implemented implementing implementation', 'test tested testing tests',
  'maintain maintained maintaining maintenance', 'improve improved improving improvements improvement',
  'reduce reduced reduces reducing reduction reductions cut cuts cutting',
  'increase increased increases increasing', 'save saved saves saving',
  'accelerate accelerated accelerates accelerating', 'eliminate eliminated eliminates eliminating',
  'grow grew grows growing',
  'migrate migrated migrating migration move moved moving', 'interrupt interrupted interrupting interruption',
  'day daily', 'run ran running', 'keep kept keeping', 'write wrote written writing',
  'synchronize synchronized synchronization syncing sync synced', 'book booked booking',
  'automate automated automating automation automations', 'evaluate evaluated evaluating evaluation',
  'analyze analyzed analyzing analysis', 'recommend recommended recommending recommendation',
  'inform informed informing', 'present presented presenting', 'deliver delivered delivering delivery',
  'account accounts accounting', 'cost costs costing', 'ship shipped shipping',
  'share shared sharing', 'route routes routing', 'coordinate coordinated coordinating',
  'review reviewed reviewing', 'lead led leading', 'create created creating',
  'add added adding', 'include included including', 'ready readiness',
  '% percent percentage',
  'know knew known', 'see saw seeing', 'use used using', 'retire retired retiring',
  // Explicitly calibrated inflections from spoken replay. Do not broaden the
  // suffix stemmer: a shared stem must never make a different entity equivalent.
  'consume consumed consumes consuming', 'produce produced produces producing',
  'provide provided provides providing', 'use uses', 'serve served serves serving',
  'process processed processes processing', 'include includes',
  'develop developed develops developing', 'approach approaches',
  'work worked works working', 'help helped helps helping',
  'connect connected connects connecting', 'let lets',
  'support supported supports supporting', 'assist assisted assists assisting',
  'contribute contributed contributes contributing contribution',
  'decide decided decides deciding', 'own owned owns owning',
  'preserve preserved preserves preserving',
]) for (const form of group.split(' ')) ROOTS.set(form, group.split(' ')[0]);

function rawTokens(value) {
  // Possessive punctuation does not introduce an extra content noun "s".
  return String(value || '').normalize('NFKC').replace(/(?<=\p{L})['’]s\b/gu, '').match(WORDS) || [];
}
function root(value) {
  const word = value.toLowerCase();
  if (ROOTS.has(word)) return ROOTS.get(word);
  if (NUMBER_WORDS.has(word)) return NUMBER_WORDS.get(word);
  if (/^\d/u.test(word)) return word.replaceAll(',', '');
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3).replace(/(.)\1$/u, '$1');
  if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2).replace(/(.)\1$/u, '$1');
  if (word.endsWith('s') && word.length > 3 && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}
function tokens(value) {
  const result = [];
  const raw = rawTokens(value);
  for (let index = 0; index < raw.length; index++) {
    if (!NUMBER_WORDS.has(raw[index].toLowerCase())) { result.push(root(raw[index])); continue; }
    let total = 0; let part = 0;
    while (index < raw.length && NUMBER_WORDS.has(raw[index].toLowerCase())) {
      const number = Number(NUMBER_WORDS.get(raw[index].toLowerCase()));
      if (number === 100) part = Math.max(1, part) * number;
      else if (number >= 1000) { total += Math.max(1, part) * number; part = 0; }
      else part += number;
      index++;
    }
    index--; result.push(String(total + part));
  }
  return result;
}
function quantities(value) {
  const result = [];
  for (const { segment } of new Intl.Segmenter('en', { granularity: 'sentence' }).segment(value)) {
    const words = tokens(segment);
    for (const [index, word] of words.entries()) {
      if (!/^\d/u.test(word)) continue;
      const next = words[index + 1];
      const currency = /^[£€$]$/u.test(words[index - 1] || '') ? words[index - 1] : '';
      const unit = next && !FUNCTION_WORDS.has(next) && !/^\d/u.test(next) ? next : '';
      result.push(`${word}:${currency || unit}`);
    }
  }
  return result;
}
function negativePredicates(value) {
  return [...value.matchAll(/\b(?:did not|does not|do not|never|not|failed to)\s+(?:\w+ly\s+)?([\p{L}]+)/giu)].map(match => root(match[1]));
}
export function interviewSpokenWordCount(value) { return String(value || '').trim().split(/\s+/u).filter(Boolean).length; }
const ACTION_ROOTS = new Set(['build', 'maintain', 'improve', 'implement', 'test', 'migrate', 'create', 'lead', 'review', 'coordinate', 'evaluate', 'add', 'write', 'ship', 'automate', 'resolv', 'coach', 'trac', 'choose', 'interview', 'stop']);
export function interviewClaimActions(value) { return [...new Set(tokens(value).filter(token => ACTION_ROOTS.has(token)))].sort(); }
export function interviewClaimContent(value) {
  // Filter grammar before inflection normalization: has/had must not become
  // content roots such as ha. Number words retain their normalized quantity.
  const content = rawTokens(value).filter(token => !FUNCTION_WORDS.has(token.toLowerCase()) || NUMBER_WORDS.has(token.toLowerCase()));
  return [...new Set(tokens(content.join(' ')).filter(token => !FUNCTION_WORDS.has(token)
    && !['approximately', 'roughly', 'around', 'nearly'].includes(token)))];
}
function oneSentence(value) {
  return [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(value)].filter(item => item.segment.trim()).length === 1;
}

export function deriveInterviewCandorFlags(value) {
  const flags = new Set();
  if (/\binherit\w*\b|not (?:originally )?built by me|(?:built|designed|created) by (?:another|other|external)/iu.test(value)) flags.add('inherited');
  if (/co[- ]built|(?:with|together with) (?:the |an? )?(?:other|another) engineer/iu.test(value)) flags.add('co-built');
  if (/some (?:built )?solo.*(?:others?|co[- ]built)/iu.test(value)) flags.add('mixed-solo-co-built');
  if (/\bteam\b[^.]*\b(?:chosen|chose|decided|selected)\b[^.]*\bbefore\b|(?:chosen|decided|selected) before I joined/iu.test(value)) flags.add('team-chosen');
  if (/\bretired\b/iu.test(value)) flags.add('retired');
  if (/\breplaced\b|retired in favor of/iu.test(value)) flags.add('replaced');
  if (/\b(?:supported|helped|contributed)\s+[\p{L}]|(?<![-\p{L}])assisted\s+[\p{L}]|\b(?:supporting|assisting) role\b/iu.test(value)) flags.add('supported-only');
  if (/\bI (?:observed|shadowed)\b|^Observed:|\b(?:led|built|designed)\s+(?:in \d+\s+)?by\s+(?:another|other|external)\b/iu.test(value)) flags.add('observer');
  if (/\b(?:did not|never|no longer|was not|were not|not responsible|failed to)\b/iu.test(value)) flags.add('negated');
  if (approximateQuantities(value).length) flags.add('approximate');
  if (/\b(?:partial(?:ly)?|partly|subset|portion)\b|\bsome but not all\b/iu.test(value)) flags.add('partial');
  if (/\bsuch as\b|\bfor example\b|\be\.g\./iu.test(value)) flags.add('example-only');
  if (/\bpersonal projects?\b|\bself[- ]funded\b/iu.test(value)) flags.add('personal-project');
  return [...flags].sort();
}

// Qualifiers stay attached to their own quantity/example, even when another
// citation happens to contain an unqualified number or a stronger action.
function approximateQuantities(value) {
  const words = tokens(String(value).replace(/[~≈]\s*(?=\d)/gu, 'approximately '));
  const result = [];
  for (const [index, word] of words.entries()) {
    if (!/^\d/u.test(word) || !['about', 'approximately', 'roughly', 'around', 'nearly'].includes(words[index - 1])) continue;
    const next = words[index + 1];
    const unit = next && !FUNCTION_WORDS.has(next) && !/^\d/u.test(next) ? next : '';
    result.push(`${word}:${unit}`);
  }
  return result;
}
function exampleOnlyTerms(value) {
  const marker = /\bsuch as\b|\bfor example\b|\be\.g\.,?/giu;
  const terms = new Set();
  for (const match of value.matchAll(marker)) {
    const rest = value.slice(match.index + match[0].length);
    const example = rest.split(/[)\n]/u)[0];
    const outside = new Set(tokens(value.slice(0, match.index) + rest.slice(example.length)));
    for (const token of tokens(example)) if (!outside.has(token) && !FUNCTION_WORDS.has(token)) terms.add(token);
  }
  return terms;
}
const SUPPORT_ACTIONS = new Set(['support', 'help', 'contribute']);
const OWNERSHIP_ACTIONS = new Set([...ACTION_ROOTS, 'evaluate', 'analyze', 'recommend', 'present', 'decide', 'own', 'design', 'develop', 'deliver', 'adopt', 'use', 'delegate']);
function unsupportedSoloActions(value) {
  // The first candidate verb must express a contribution; further independent
  // predicates cannot hide behind that opening supporting verb.
  const clauses = value.split(/[,;]|\b(?:and|but|then|while)\s+(?=(?:(?:I|we)\s+)?(?:[\p{L}]+\s+){0,2}[\p{L}]+)/iu);
  const rejected = [];
  const firstIndex = clauses.findIndex(clause => /\b(?:I|we)\b/iu.test(clause));
  const first = clauses[firstIndex] || clauses[0];
  const subject = first.match(/\b(?:I|we)\s+(?:(?:have|had|also|only|closely)\s+)*([\p{L}]+)/iu);
  if (!subject || !SUPPORT_ACTIONS.has(root(subject[1]))) rejected.push(subject?.[1] || first.trim());
  // A later explicit candidate subject and participial adjunct each keep their
  // own agency; neither can borrow the modest verb at the sentence opening.
  for (const match of value.matchAll(/\b(?:I|we)\s+(?:(?:have|had|also|only|closely|personally|already)\s+)*([\p{L}]+)/giu)) {
    if (!SUPPORT_ACTIONS.has(root(match[1]))) rejected.push(match[1]);
  }
  for (const match of value.matchAll(/\b(?:after|before|by|while|then|having)\s+(?:(?:I|we|have|had|also)\s+)*([\p{L}]+)/giu)) {
    if (OWNERSHIP_ACTIONS.has(root(match[1])) && !SUPPORT_ACTIONS.has(root(match[1]))) rejected.push(match[1]);
  }
  for (const clause of clauses.slice(Math.max(0, firstIndex) + 1)) {
    // A documented team/management subject remains a third-party action.
    if (/^\s*(?:the\s+)?(?:team|management|manager|other engineer)\b/iu.test(clause)) continue;
    const predicate = clause.match(/^\s*(?:(?:I|we)\s+)?(?:(?:also|then|later|personally|fully|directly)\s+)*([\p{L}]+)/iu);
    const action = predicate?.[1];
    if (action && OWNERSHIP_ACTIONS.has(root(action)) && !SUPPORT_ACTIONS.has(root(action))) rejected.push(action);
  }
  return [...new Set(rejected)];
}

// Limited structural paraphrases required to turn evidence notes into speech.
// Each alternative still needs all its objects/entities from the same citation.
function licensedEquivalent(word, source, original) {
  const has = (...values) => values.some(value => source.has(value));
  if (['about', 'approximately', 'roughly', 'around', 'nearly'].includes(word)) return approximateQuantities(original).length > 0;
  if (word === 'deliver') return has('migrate', 'ship', 'complete');
  if (word === 'keep') return has('maintain', 'stay');
  if (word === 'live') return has('service') && /stayed|remain/iu.test(original);
  if (word === 'cover') return has('implement', 'include');
  if (word === 'ready') return has('set') && has('up');
  if (word === 'old') return /in-house systems stayed/iu.test(original);
  if (word === 'turn') return has('extract', 'load', 'ingest');
  if (word === 'record' || word === 'usable') return has('database') && has('load');
  if (word === 'aware') return has('curvature') && has('account');
  if (word === 'split' || word === 'share') return has('co', 'together') && /solo/iu.test(original);
  if (word === 'end' || word === 'finish') return has('ship', 'complete');
  if (word === 'avoid') return has('steer') && has('warning');
  if (word === 'follow' || word === 'up') return has('flag') && has('appointment');
  if (word === 'miss') return /not (?:called|booked)/iu.test(original);
  if (word === 'therapist' && has('therapist')) return true;
  // These are narrow speech equivalents, each retaining the cited objects and
  // the independent agency/candor checks below. They cannot license an entity,
  // a measurement, a new outcome or a new candidate contribution.
  if (word === 'work') return has('build', 'maintain', 'implement', 'test', 'migrate', 'evaluate', 'support', 'adopt');
  if (word === 'support' || word === 'contribute') return has('support', 'assist', 'help', 'contribute');
  if (word === 'help') return has('support', 'assist') || has('implement', 'maintain', 'migrate', 'build') && /\b(?:with (?:the |an? )?(?:other|another) engineer|co[- ]built)\b/iu.test(original);
  if (word === 'connect') return has('integration') && has('between');
  if (word === 'use') return has('adopt') && has('tool') || /\bbuilt on\b/iu.test(original);
  if (word === 'develop') return has('build') && /\bpractical sense\b/iu.test(original);
  if (word === 'fit') return has('match') && has('task') && /\bdoes it well\b/iu.test(original);
  if (word === 'process') return has('ingest') && has('run') && has('ocr') && has('load');
  if (word === 'include') return /\bwith optional\b|\bsuch as\b|\bfor example\b|\be\.g\./iu.test(original);
  if (word === 'let') return /\bwhere you\b/iu.test(original);
  return false;
}

function quoted(values) { return [...new Set(values)].map(value => JSON.stringify(value)).join(', '); }
function matches(value, pattern) { return [...value.matchAll(pattern)].map(match => match[0]); }
function agencyWords(value) { return matches(value, /\b(?:I|we|my|our)\b/giu); }
function numericWords(value) { return rawTokens(value).filter(token => NUMBER_WORDS.has(token.toLowerCase()) || /^\d|^[%$£€]$/u.test(token)); }
function sentenceCount(value) { return [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(value)].filter(item => item.segment.trim()).length; }

const literalPattern = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const roleEnd = item => /\b(?:present|current)\b/iu.test(item.roleContext?.endDate || '')
  ? Infinity : Date.parse(item.roleContext?.endDate || '') || 0;

/** The intro may summarize employment metadata without claiming any of the
 * role's achievements. Pair the title and employer from the SAME sealed role;
 * a bag of names from several citations cannot establish a different role. */
export function interviewIntroRoleSummary(claim, sources) {
  if (!claim || !Array.isArray(claim.evidenceIds) || !claim.evidenceIds.length || typeof claim.text !== 'string') return false;
  const cited = sources.filter(source => claim.evidenceIds.includes(source.id));
  if (!cited.length || cited.some(source => source.kind !== 'career' || !source.roleId
    || !source.roleContext?.title || !source.roleContext?.employer)) return false;
  const roles = [...new Map(cited.map(source => [source.roleId, source.roleContext])).values()];
  const pairs = roles.map(role => `${literalPattern(role.title)} at ${literalPattern(role.employer)}`);
  const pair = `(?:${pairs.join('|')})`;
  if (!new RegExp(`^I worked as (?:a |an )?${pair}(?:,? and (?:as )?(?:a |an )?${pair}){0,3}\\.$`, 'u').test(claim.text)) return false;
  return roles.every(role => claim.text.includes(`${role.title} at ${role.employer}`));
}

function introChronologyTokens(claim, cited, roleEvidence) {
  const licensed = new Set();
  if (!cited.length || cited.some(source => source.kind !== 'career' || !source.roleId || !roleEnd(source))
    || new Set(cited.map(source => source.roleId)).size !== 1) return licensed;
  const current = Math.max(...cited.map(roleEnd));
  const available = roleEvidence.filter(source => source.kind === 'career' && source.roleId && roleEnd(source));
  const latest = Math.max(...available.map(roleEnd), current);
  if (/^I last worked\b/u.test(claim.text) && current === latest) licensed.add('last');
  if (/^Earlier,\s/u.test(claim.text) && current < latest) licensed.add('earlier');
  if (/^Previously,\s/u.test(claim.text) && Number.isFinite(current) && current < Date.now()) licensed.add('previously');
  return licensed;
}

/** All examples are invented by the host and never derived from user data. */
export const INTERVIEW_INTRO_ALLOWANCE_EXAMPLES = Object.freeze({
  rule: 'INTRO_ONLY: sealed role metadata may support an exact employment summary; keep each title paired with its own employer. Separate achievement claims still require their own evidence and every candor/number/entity check. Last/Earlier require dated role order; Previously requires an ended role. Do not speak role dates as achievement quantities.',
  positive: { metadata: [{ title: 'Engineer', employer: 'Sample Works' }, { title: 'Analyst', employer: 'Example Labs' }], claim: 'I worked as Engineer at Sample Works and Analyst at Example Labs.' },
  negative: { claim: 'I worked as Analyst at Sample Works and Engineer at Example Labs.', reason: 'Swapping the cited employer/title pairs is unsupported.' },
});

const OUTCOME_VERBS = /\b(?:improv(?:e|es|ed|ing)|reduc(?:e|es|ed|ing)|cut(?:s|ting)?|increas(?:e|es|ed|ing)|boost(?:s|ed|ing)?|sav(?:e|es|ed|ing)|grew|grow(?:s|ing)?|accelerat(?:e|es|ed|ing)|eliminat(?:e|es|ed|ing))\b/giu;
function outcomeObject(value) {
  const phrase = value.split(/[.,;!?]|\b(?:but|while|because|although|then|after|before|using|through|with)\b|\b(?:and|or)\s+(?:(?:I|we)\s+)?(?:built|implemented|added|created|improved|reduced|saved|eliminated|increased|reviewed|maintained|evaluated|analyzed|compared|supported|helped)\b/iu)[0];
  return interviewClaimContent(phrase);
}
function achievedOutcome(claimText, outcome, sources) {
  const claimObject = outcomeObject(claimText.slice(outcome.index + outcome[0].length));
  if (!claimObject.length) return false;
  return sources.some(source => [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(source.text)].some(({ segment }) => {
    for (const match of segment.matchAll(OUTCOME_VERBS)) {
      if (root(match[0]) !== root(outcome[0])) continue;
      const prefix = segment.slice(0, match.index);
      // Purpose, possibility and an unachieved plan cannot become a result.
      // Modal scope includes coordinated predicates in the same clause.
      if (/\b(?:to|without|not|never|than)\s+(?:[\p{L}]+ly\s+)*$/iu.test(prefix)
        || /\b(?:could|would|should|may|might|can|plans?|planned|aims?|aimed|intended|hopes?|goal|purpose)\b[^.;]*$/iu.test(prefix)) continue;
      const sourceObject = new Set(outcomeObject(segment.slice(match.index + match[0].length)));
      if (claimObject.every(token => sourceObject.has(token))) return true;
    }
    return false;
  }));
}

/** Quote the worker's own offending words as evidence, never replacement prose. */
export function interviewClaimFailures(claim, sources, { intro = false, roleEvidence = sources } = {}) {
  const failures = [];
  const add = (rule, instruction) => failures.push({ rule: `INTERVIEW_ANSWER_${rule}`, instruction });
  if (typeof claim?.text !== 'string' || !claim.text.trim()) { add('CLAIM', `text is ${JSON.stringify(claim?.text) ?? 'missing'}; provide one nonempty bounded spoken sentence.`); return failures; }
  if (!Array.isArray(claim.evidenceIds) || !claim.evidenceIds.length || claim.evidenceIds.length > 4
    || new Set(claim.evidenceIds).size !== claim.evidenceIds.length || claim.evidenceIds.some(id => !sources.some(item => item.id === id))) {
    add('CITATION', `returned evidenceIds ${JSON.stringify(claim.evidenceIds) ?? 'missing'}; bind this claim to one to four distinct supplied evidence IDs, removing unknown or repeated IDs.`); return failures;
  }
  const cited = sources.filter(item => claim.evidenceIds.includes(item.id));
  const chronology = intro ? introChronologyTokens(claim, cited, roleEvidence) : new Set();
  const original = cited.map(item => item.text).join(' ');
  // Only the sealed role title/employer may extend entity vocabulary. A UI
  // label, role theme or another citation's metadata cannot create a claim.
  const roleNames = cited.flatMap(item => [item.roleContext?.title, item.roleContext?.employer]).filter(item => typeof item === 'string');
  const source = new Set(tokens([original, ...roleNames].join(' ')));
  const value = claim.text;
  if (!oneSentence(value)) add('SENTENCE', `returned ${sentenceCount(value)} sentences in ${JSON.stringify(value)}; retain one spoken claim in one sentence.`);
  const noteWords = matches(value, /[()[\]]|\b(?:tech(?:nologies)? used|candor|honesty note|source note|not originally built by me)\s*:?/giu);
  if (noteWords.length) add('NOTE_LEAK', `remove note formatting or boilerplate ${quoted(noteWords)} from the spoken claim; preserve its factual qualifications through ownership and tense.`);
  const sourceNumbers = new Set(tokens(original).filter(token => /^\d/u.test(token) || /^[%$£€]$/u.test(token)));
  // A singular collaborator is entailed by the definite singular source note.
  if (/\b(?:the other|another) engineer\b/iu.test(original)) sourceNumbers.add('1');
  const claimNumbers = tokens(value).filter(token => /^\d/u.test(token) || /^[%$£€]$/u.test(token));
  if (claimNumbers.some(token => !sourceNumbers.has(token))) add('NUMBER', `check the returned numeric tokens ${quoted(numericWords(value))}; unsupported normalized values ${quoted(claimNumbers.filter(token => !sourceNumbers.has(token)))} are absent from the cited evidence. Remove unsupported quantities; spoken-number equivalents are allowed.`);
  const sourceQuantities = new Set(quantities(original));
  if (/\b(?:the other|another) engineer\b/iu.test(original)) { sourceQuantities.add('1:'); sourceQuantities.add('1:engineer'); }
  const wrongQuantities = quantities(value).filter(quantity => !sourceQuantities.has(quantity));
  if (wrongQuantities.length) add('QUANTITY', `returned numeric tokens ${quoted(numericWords(value))} in ${JSON.stringify(value)} bind to unsupported quantity/unit pairs ${quoted(wrongQuantities)}; bind each quantity to its cited unit or counted object. A duration cannot become a count or percentage.`);
  const unsupported = rawTokens(value).filter(token => {
    const lower = token.toLowerCase(); const normalized = root(token);
    if (FUNCTION_WORDS.has(lower) || NUMBER_WORDS.has(lower) || source.has(normalized) || chronology.has(lower)) return false;
    return !licensedEquivalent(normalized, source, original);
  });
  // Capitalized entities/technologies have no synonym license. Sealed role
  // metadata can supply employer/title names; arbitrary labels cannot.
  const entities = rawTokens(value).filter((token, index) => /[\p{Lu}]/u.test(token)
    && !FUNCTION_WORDS.has(token.toLowerCase()) && !(index === 0 && token.length > 1 && !/[\p{Lu}]/u.test(token.slice(1))));
  const unsupportedEntities = entities.filter(token => !source.has(root(token)));
  if (unsupportedEntities.length) add('ENTITY', `remove or re-cite unsupported entity/technology tokens ${quoted(unsupportedEntities)}; these names do not occur in this claim’s cited evidence. Entity names have no synonym license.`);
  if (unsupported.length) add('NEW_FACT', `remove or re-cite unsupported content tokens ${quoted(unsupported)}; use content nouns and verbs from this claim’s cited evidence or an explicitly licensed equivalent. These quoted words identify the error, not replacement wording.`);
  // A bounded employment summary asserts no achievement predicate, so source
  // restrictions on who built or selected a particular project do not apply.
  // Entity and numeric checks above still run; all other speech keeps them.
  if (intro && interviewIntroRoleSummary(claim, cited)) return failures;
  if (intro && /^I worked as\s/u.test(value)) add('INTRO_ROLE_SUMMARY', 'an employment summary must pair each complete sealed title with its own employer, using only I worked as [title] at [employer] and [title] at [employer]. State achievement details in separately cited claims.');
  const flags = new Set(cited.flatMap(item => deriveInterviewCandorFlags(item.text)));
  // Joining time in a team-decision statement is not a candidate action.
  const agencyValue = value.replace(/\bbefore I joined\b/giu, 'before joining');
  const candidateAgency = /\b(?:I|we|my|our)\b/iu.test(agencyValue);
  const implicitCandidate = /^(?:(?:Situation|Task|Action|Result|Point):\s*)?(?:Built|Led|Maintained|Improved|Implemented|Tested|Created|Developed|Wrote|Evaluated|Supported|Helped|Contributed|Assisted|Adopted|Automated|Migrated|Coordinated|Reviewed|Resolved|Coached|Traced|Interviewed|Stopped)\b/iu;
  if (candidateAgency && !cited.some(item => /\b(?:I|we|my|our)\b/iu.test(item.text) || implicitCandidate.test(item.text))) add('ATTRIBUTION', `the candidate subject ${quoted(agencyWords(agencyValue))} assigns personal agency in ${JSON.stringify(value)}, but the citation states only a neutral or third-person event. Use a descriptive event statement attributed to its documented owner, or cite evidence that explicitly supports the candidate action.`);
  const inheritedVerbs = matches(value, /\b(?:built|build|building|design\w*|creat\w*|architect\w*)\b/giu);
  if (flags.has('inherited') && inheritedVerbs.length) add('INHERITED', `the construction verbs ${quoted(inheritedVerbs)} claim original creation of inherited work. Describe only the cited maintenance, extension or additions; retain inherited ownership.`);
  const namedCollaborator = /\bwith (?:the |an? |one )?(?:other|another) engineer\b|\b(?:the other|another) engineer and I\b|\bI and (?:the other|another) engineer\b/iu.test(value);
  if (flags.has('co-built') && candidateAgency && (!/\bwe\b/iu.test(value) && !namedCollaborator
    || /\bI (?:built|build|created|designed)\b/iu.test(value) && !namedCollaborator && !flags.has('mixed-solo-co-built'))) add('CO_BUILT', `the subject/ownership words ${quoted(agencyWords(value))} in ${JSON.stringify(value)} omit shared ownership. Use 'we' or explicitly name work 'with the other engineer'; the cited evidence says the work was shared. Retain any documented solo/shared split.`);
  if (flags.has('mixed-solo-co-built') && /\b(?:all|every)\b/iu.test(value) && /\b(?:we|together|solo)\b/iu.test(value)) add('CO_BUILT', `the scope words ${quoted(matches(value, /\b(?:all|every|we|together|solo)\b/giu))} generalize one contribution to all work. Preserve the cited split between some individual work and other shared work explicitly.`);
  const candidateChoiceText = agencyValue.replace(/\b(?:the )?team\s+(?:(?:had|already)\s+)*(?:chose|chosen|selected|decided)[^,;.]*?(?=,|;|\.|$|\b(?:and|but|so|I|we|my|our)\b)/giu, '')
    .replace(/\bteam(?:['’]s\s+|[- ])chosen\b/giu, '');
  if (flags.has('team-chosen') && candidateAgency
    && (/\b(?:chose|choose|chosen|choosing|design\w*)\b/iu.test(candidateChoiceText)
      || !/\b(?:implement\w*|test\w*)\b/iu.test(value))) add('TEAM_CHOSEN', `the candidate-attributed wording ${JSON.stringify(value)} ${/\b(?:chose|choose|chosen|choosing|design\w*)\b/iu.test(candidateChoiceText) ? `claims selection/design through ${quoted(matches(candidateChoiceText, /\b(?:chose|choose|chosen|choosing|design\w*)\b/giu))}` : 'does not limit the contribution to implementation/testing'}. Attribute implementation or testing to the candidate; the cited team made the earlier algorithm choice.`);
  if (flags.has('team-chosen') && candidateAgency && /\bmodified\b/iu.test(value)
    && !/\bteam(?:['’]s\s+|[- ])chosen\b|\b(?:the )?team\s+(?:(?:had|already)\s+)*(?:chose|chosen|selected|decided)\b/iu.test(value)) add('TEAM_CHOSEN', `the modified-algorithm wording ${JSON.stringify(value)} omits the team's earlier choice and can imply modification authorship. Attribute the choice to the cited team in this same claim, or omit modified and describe implementation/testing only.`);
  if (flags.has('observer') && candidateAgency) add('ATTRIBUTION', `the personal subject ${quoted(agencyWords(value))} in ${JSON.stringify(value)} turns observed work into candidate agency. Attribute the event to the actual documented owner and retain observation as the candidate’s contribution.`);
  if (flags.has('negated') && (negativePredicates(original).some(verb => tokens(value).includes(verb) && !negativePredicates(value).includes(verb))
    || !/\b(?:not|never|no|without|failed to)\b/iu.test(value)
    || /failed to/iu.test(original) && /never failed|not fail/iu.test(value))) {
    const affected = rawTokens(value).filter(token => negativePredicates(original).includes(root(token)));
    add('NEGATION', `the returned claim ${JSON.stringify(value)} loses or reverses a cited limitation${affected.length ? ` on your predicate tokens ${quoted(affected)}` : ''}. Preserve the limitation on that same action; unrelated negative words cannot preserve its polarity.`);
  }
  if (flags.has('supported-only') && candidateAgency) {
    const actions = unsupportedSoloActions(value);
    if (actions.length) add('SUPPORTED_ONLY', `the candidate action wording ${quoted(actions)} in ${JSON.stringify(value)} exceeds the documented supporting role. Limit the candidate's verbs to supported, helped or contributed; do not claim evaluation, presentation, leadership, ownership or decision as a solo action.`);
  }
  const approximate = new Set(cited.flatMap(item => approximateQuantities(item.text)));
  const valueQuantities = new Set(quantities(value));
  const unqualified = [...approximate].filter(quantity => valueQuantities.has(quantity) && !approximateQuantities(value).includes(quantity));
  if (unqualified.length) add('APPROXIMATE', `the numeric wording ${quoted(numericWords(value))} in ${JSON.stringify(value)} drops approximation for ${quoted(unqualified)}. Keep about, approximately or roughly attached to that same cited quantity, or omit the quantity.`);
  if (flags.has('partial') && candidateAgency && !/\b(?:partial(?:ly)?|partly|subset|portion)\b|\bsome but not all\b/iu.test(value)) add('PARTIAL', `the candidate claim ${JSON.stringify(value)} drops the cited partial scope. Preserve the partial/portion limitation on the same work; do not imply complete implementation or ownership.`);
  const exampleTerms = new Set(cited.flatMap(item => [...exampleOnlyTerms(item.text)]));
  if (flags.has('example-only') && tokens(value).some(token => exampleTerms.has(token)) && !/\bsuch as\b|\bfor example\b|\bincluding\b|\be\.g\./iu.test(value)) add('EXAMPLE_ONLY', `the claim ${JSON.stringify(value)} promotes cited example-only details into an unqualified assertion. Retain such as, for example or including on the example, without implying an exhaustive scope or a completed outcome.`);
  if (flags.has('personal-project') && candidateAgency && !/\bpersonal projects?\b|\bself[- ]funded\b/iu.test(value)) add('PERSONAL_PROJECT', `the personal action ${JSON.stringify(value)} omits the cited personal-project context. State personal projects or self-funded in this claim so the work cannot be mistaken for workplace experience.`);
  // A present retirement status is fine; a continuing candidate action stays
  // contradictory even if the sentence also happens to say retired/replaced.
  const ongoing = value.replace(/\b(?:is|are)\s+(?:(?:now|already|fully)\s+)?(?:retired|replaced|no longer)\b/giu, '');
  const currentWords = matches(ongoing, /\b(?:is|are|currently|still|maintains|runs|serves|supports|provides)\b|\b(?:I|we) (?:maintain|improve|add|extend|run|use|build|support|provide)\b/giu);
  if ((flags.has('retired') || flags.has('replaced')) && currentWords.length) add('RETIRED', `the present/continuing wording ${quoted(currentWords)} treats retired or replaced work as current. Use historical tense and preserve the documented retirement/replacement.`);
  // Outcomes need their own achieved predicate and object. A qualitative
  // source-stated effect is enough; neither an unrelated metric nor a purpose
  // such as "to eliminate costs" establishes that the effect happened.
  for (const match of value.matchAll(OUTCOME_VERBS)) {
    if (!achievedOutcome(value, match, cited)) {
      add('OUTCOME', `the outcome verb ${JSON.stringify(match[0])} lacks its own cited achieved result on the same object. Preserve an explicitly stated qualitative or measured effect; a purpose, plan or unrelated number cannot establish an outcome.`);
      break;
    }
  }
  const shipmentWords = matches(value, /\bshipp?\w*\b/giu);
  if (shipmentWords.length && !/\bshipped\b/iu.test(original)) add('SHIPPED', `the shipment wording ${quoted(shipmentWords)} lacks an explicit cited statement that the work shipped. Remove that shipment claim or cite source evidence that states shipment.`);
  return failures;
}

export function interviewHeadlineFailures(value) {
  const failures = [];
  const add = (rule, instruction) => failures.push({ rule: `INTERVIEW_ANSWER_${rule}`, instruction });
  const count = interviewSpokenWordCount(value);
  if (count < 10 || count > 16) add('HEADLINE_LENGTH', `returned ${count} whitespace-separated words in ${JSON.stringify(value)}; shorten or expand this headline to 10–16 words while preserving its cited qualifications.`);
  const punctuation = matches(value, /[():;]/gu);
  if (!oneSentence(value) || punctuation.length) add('HEADLINE_SENTENCE', `returned ${sentenceCount(value)} sentences${punctuation.length ? ` and prohibited punctuation ${quoted(punctuation)}` : ''} in ${JSON.stringify(value)}; use one sentence without parentheses, colons or semicolons.`);
  if (!/\b(?:I|we|my|our)\b/iu.test(value) || /\b(?:I|we)\s+(?:was|were|am|are)\s+\w+ed\b/iu.test(value)) add('HEADLINE_ACTIVE', `the headline ${JSON.stringify(value)} ${/\b(?:I|we|my|our)\b/iu.test(value) ? 'uses a passive candidate construction' : 'has no first-person subject'}; use an active first-person action supported by the citation.`);
  if (!tokens(value).some(token => ['build', 'implement', 'test', 'maintain', 'improve', 'migrate', 'deliver', 'evaluate', 'automate', 'lead', 'create', 'develop', 'write', 'learn', 'adopt', 'keep', 'work', 'ship', 'present', 'analyze', 'support', 'help', 'contribute', 'turn', 'add', 'integrate', 'use', 'coordinate', 'review', 'resolv', 'coach', 'trac', 'choose', 'interview', 'stop'].includes(token))) add('HEADLINE_ACTIVE', `the headline ${JSON.stringify(value)} has no recognized supported action verb; state an active first-person action explicitly supported by the cited evidence.`);
  return failures;
}
export function interviewStandaloneFailures(value) {
  const unresolved = /^\s*(?:they|those|it)\b|^\s*(?:these|this)\s+(?:is|are|was|were|have|had|has|do|did|does|can|could|would|will|also|then)\b|^\s*the data\s+(?!from\b|in\b|for\b|about\b|on\b|that\b|which\b)/iu.test(value);
  return unresolved ? [{ rule: 'INTERVIEW_ANSWER_UNRESOLVED_REFERENCE', instruction: `the standalone claim ${JSON.stringify(value)} begins with an unresolved reference. Name the actual cited subject in this same sentence so it can be read aloud independently.` }] : [];
}
export function interviewBulletFailures(value) {
  const count = interviewSpokenWordCount(value);
  return [...(count < 8 || count > 18 ? [{ rule: 'INTERVIEW_ANSWER_BULLET_LENGTH', instruction: `returned ${count} whitespace-separated words in ${JSON.stringify(value)}; shorten or expand this bullet to 8–18 words while preserving its cited qualifications.` }] : []), ...interviewStandaloneFailures(value)];
}

export { interviewQuestionFit, interviewEvidenceRank } from './interviewQuestionFit.js';
