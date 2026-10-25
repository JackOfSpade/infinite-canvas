import { targetCompanyNames } from './coverLetterChecks.js';

/**
 * Claim-versus-evidence grounding for generated application prose.
 *
 * Every function here answers one question about a sentence of generated
 * résumé or cover-letter copy and the career-data quotes the unit cites: does
 * the evidence state what the sentence claims, at no greater strength? The
 * vocabulary is generic English (ownership verbs, number words, time units,
 * scale words, credential words). It never names a person, employer, product,
 * school, or listing; the CURRENT approved evidence is the only thing that can
 * widen what a sentence may claim.
 *
 * Mechanisms, each shared by every domain:
 *
 *   - STRENGTH CLASSES. Ownership and authorship are ordered classes inside a
 *     family (shared < full, and for authorship built < founded). A claim is
 *     supported only by a mention, in a quote that is about the same work, made
 *     by the candidate rather than by someone else the quote describes, at the
 *     same or a stronger class.
 *   - NAMED TERMS. Every capitalized, acronym, or technology-shaped term in the
 *     prose must occur in a cited quote (or be a trusted role/employer name).
 *     A tool named as USED must be used in the quote, not merely evaluated,
 *     owned by someone else, or offered as one of several alternatives.
 *   - QUANTITIES. Every count in the prose must be a count a cited quote
 *     states, and a lower bound ("over 50", "50+") needs a lower bound at least
 *     that large.
 *   - RATE INTERVALS, SCALE WORDS, COMPARATIVE MAGNITUDES, CREDENTIAL WORDS,
 *     CALENDAR YEARS, and APPENDED CLAUSES each compare one kind of claim with
 *     the same kind of statement in the evidence.
 *
 * Nothing in this module reads the filesystem or any host state; callers inject
 * the token function whose stop-word list they already use.
 */

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const APOSTROPHES = /[’‘ʼ]/gu;
const WORD_RE = /[\p{L}\p{N}]+/gu;

const wordsOf = text => String(text ?? '').toLowerCase().match(WORD_RE) || [];
const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

function stemToken(word) {
  const lower = String(word).toLowerCase().replace(/'s$/u, '');
  if (lower.length > 3 && lower.endsWith('ies')) return `${lower.slice(0, -3)}y`;
  if (lower.length > 3 && /(?:ch|sh|x|z|ss)es$/u.test(lower)) return lower.slice(0, -2);
  if (lower.length > 3 && lower.endsWith('s') && !lower.endsWith('ss')) return lower.slice(0, -1);
  return lower;
}

/**
 * The statement a cited career-data quote makes, without the host labels the
 * catalog wraps around it ("- Achievement [id]: ..."). An entity identifier is
 * the host's, never the source's: it must not be able to state anything.
 */
export function evidenceBody(quote) {
  return String(quote ?? '')
    .replace(APOSTROPHES, "'")
    .replace(/^\s*(?:[-*•]\s*)?[^[\]\n]{0,80}?\[[^\]\n]{1,200}\]\s*:\s*/u, '')
    .replace(/\[[^\]\n]{0,200}\]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

const blankOut = (text, phrases) => {
  let out = String(text ?? '');
  for (const phrase of phrases) {
    const trimmed = String(phrase ?? '').trim();
    if (trimmed.length < 3) continue;
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(trimmed).replace(/\s+/gu, '\\s+')}(?![\\p{L}\\p{N}])`, 'giu'), match => ' '.repeat(match.length));
  }
  return out;
};

const clip = (text, max = 90) => {
  const value = String(text ?? '').replace(/\s+/gu, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

// ---------------------------------------------------------------------------
// Strength classes (ownership and authorship)
// ---------------------------------------------------------------------------

const DETERMINER_BEFORE_NOUN = /\b(?:the|a|an|our|their|his|her|its|your)\s+(?:[\p{L}'-]+\s+){0,2}$/iu;
// The words between the frame and the title are a determiner and modifiers of
// that title ("worked as THE SENIOR team lead"), never a preposition: "worked
// UNDER the team lead", "worked WITH the manager of" bring in another person,
// whose title the frame does not give the candidate.
const SELF_FRAME_BEFORE_NOUN = /\b(?:served|serving|acted|acting|worked|working|functioned|functioning|was|were|am|became|become|becoming|appointed|named|promoted|hired|elected|selected|chosen|as)\b(?:\s+(?:to|as))?\s+(?:the\s+|a\s+|an\s+|our\s+)?(?:(?!(?:under|with|for|alongside|beside|besides|beneath|below|above|behind|by|from|of|on|in|at|among|amongst|between|against|toward|towards|without|like|unlike|after|before|near|next|into|onto|over|across|around|through|via|per|and|or|but|to)\b)[\p{L}'-]+\s+){0,2}$/iu;
const FOLLOWING_PREPOSITION = /^\s+(?:for|of|on|over|across|in)\b/iu;
const NOUN_LEAD_BEFORE = /(?:\bsales|\bqualified|\bnew|\bpotential|\bwarm|\bcold|\bhot|\bmarketing|\binbound|\boutbound|\d+|\bmany|\bmore|\bfewer|\bkey|\btop|\bgenerat\w*|\bconvert\w*|\bnurtur\w*|\bfollow-up)\s+$/iu;
const NOUN_LEAD_AFTER = /^\s*(?:time|times|generation|gen|paint|poisoning|pipe|acid|in\b|magnet|scoring|nurturing)/iu;

const MANAGE_NOUN_VERB_BEFORE = /\b(?:held|had|has|have|took|take|taking|assumed|exercised|retained|provided|given|with|full|day-to-day|overall|direct|primary|operational)\s+(?:[\p{L}'-]+\s+){0,1}$/iu;

const SHARED_MARKER = /\b(?:help(?:ed|ing|s)?|assist(?:ed|ing|s)?|aid(?:ed|ing)?|contribut(?:ed|ing|es)|participat(?:ed|ing|es)|collaborat(?:ed|ing|es)|partner(?:ed|ing)|support(?:ed|ing|s)|cooperat(?:ed|ing)|shar(?:ed|ing|es)|joint(?:ly)?|together|part\s+of|took\s+part|taking\s+part|alongside|backed\s+up|co-?)\b(?:\s+[\p{L}'-]+){0,3}\s*$/iu;

const PRONOUN_OTHER = /\b(?:he|she|they|it)\s+(?:also\s+|then\s+|previously\s+|later\s+)?$/iu;
const ROLE_NOUN_SUBJECT = /\b(?:manager|supervisor|director|lead|head|chief|officer|owner|founder|boss|mentor|principal|partner|coordinator|executive|president|vendor|client|customer|consultant|instructor|professor|advisor|sponsor)s?\s+(?:also\s+|then\s+|previously\s+|later\s+)?$/iu;
// A group the candidate belongs to did it: shared credit, not another person's.
const GROUP_SUBJECT = /\b(?:team|committee|board|department|group|crew|squad)\s+(?:also\s+|then\s+|previously\s+|later\s+)?$/iu;
const RELATIVE_PRONOUN = /\b(?:who|whom|whose|which|that)\b/giu;
const FIRST_PERSON = /\b(?:i|we|me|my|our|myself|ourselves)\b/giu;

/** Mentions are located by these specs; `side` says whether the claim, the evidence, or both are scanned. */
const claimOnlyVerb = String.raw`built|created|developed|designed|implemented|established|launched|introduced|initiated|engineered|architected|architecting|authored|wrote|coded|programmed|devised|creating|developing|designing|implementing|establishing|launching|authoring`;
const authorEvidenceVerb = String.raw`built|builds|build|building|created|creates|create|creating|developed|develops|develop|developing|designed|designs|designing|implemented|implements|implement|implementing|engineered|engineering|engineer|engineers|architected|architecting|architect|architects|established|establishes|establishing|launched|launches|launching|introduced|introduces|initiated|initiates|authored|authors|wrote|written|writing|coded|programmed|devised|produced|produces|constructed|assembled|prepared|drafted|crafted|formulated|deployed|shipped|delivered|rebuilt|redesigned|rewrote|refactored|stood\s+up|set\s+up|spun\s+up`;

const MENTION_SPECS = [
  // --- leadership ---
  {
    family: 'lead', kind: 'verb', side: 'both',
    re: /\b(?:led|leading|headed|directed|directing|spearheaded|spearheading|orchestrated|orchestrating|captained|chaired|steered|steering)\b/giu,
    reject: (text, m) => {
      const after = text.slice(m.end);
      if (/^\s+(?:to|toward|towards|into|at)\b/iu.test(after)) return true; // causal or directional, not leadership
      if (/^(?:leading)$/iu.test(m.match) && /^[\s-]+(?:edge|provider|brand|cause|indicator|candidate)\b/iu.test(after)) return true;
      if (/^headed$/iu.test(m.match) && /^\s+(?:by|for)\b/iu.test(after) && !/\b(?:was|were|is|are)\s+$/iu.test(text.slice(0, m.start))) return true;
      return false;
    },
  },
  {
    family: 'lead', kind: 'verb', side: 'evidence',
    re: /\blead(?:s)?\b/giu,
    reject: (text, m) => NOUN_LEAD_BEFORE.test(text.slice(Math.max(0, m.start - 24), m.start)) || NOUN_LEAD_AFTER.test(text.slice(m.end))
      || /(?:\b(?:the|a|an|our|their|his|her|its|your|team|project|tech|technical|shift|unit|group|program|workstream|squad|crew|section|department|site|design|engineering|product|principal|senior|assistant|associate)\s+)$/iu.test(text.slice(Math.max(0, m.start - 20), m.start)),
  },
  {
    family: 'lead', kind: 'noun', side: 'both',
    re: /\b(?:(?:team|project|tech(?:nical)?|shift|unit|group|program|workstream|squad|crew|section|department|site|design|engineering|product|principal|senior|assistant|associate)\s+)*(?:lead|leader)\b/giu,
    nounEligible: true,
  },
  { family: 'lead', kind: 'noun', side: 'both', re: /\bhead\s+of\b/giu, nounEligible: false },
  // --- management / oversight ---
  {
    family: 'manage', kind: 'verb', side: 'both',
    re: /\b(?:managed|managing|supervised|supervising|oversaw|overseeing)\b/giu,
    reject: (text, m) => /^managed$/iu.test(m.match) && /^\s+(?:services?|care|hosting|network|environment|infrastructure|cloud|accounts?)\b/iu.test(text.slice(m.end)),
  },
  { family: 'manage', kind: 'verb', side: 'evidence', re: /\b(?:manage|manages|supervise|supervises|oversee|oversees)\b/giu },
  { family: 'manage', kind: 'phrase', side: 'both', re: /\bin\s+charge\s+of\b/giu },
  {
    family: 'manage', kind: 'noun', side: 'both',
    re: /\b(?:management|oversight|supervision)\s+(?:of|over|for)\b/giu,
    reject: (text, m) => !MANAGE_NOUN_VERB_BEFORE.test(text.slice(0, m.start)),
  },
  { family: 'manage', kind: 'noun', side: 'both', re: /\b(?:manager|supervisor)\s+(?:of|for|over)\b/giu, nounEligible: false },
  { families: ['manage', 'own'], kind: 'phrase', side: 'evidence', re: /\b(?:responsible|accountable)\s+for\b/giu },
  // --- ownership ---
  { family: 'own', kind: 'verb', side: 'both', re: /\b(?:owned|owning|owns)\b/giu },
  { family: 'own', kind: 'verb', side: 'both', re: /(?<=\b(?:to|will|would|can|could|should|must|i|we|who)\s+(?:\p{L}+ly\s+)?)\bown\b/giu },
  { family: 'own', kind: 'noun', side: 'both', re: /\bownership\b/giu },
  { family: 'own', kind: 'noun', side: 'both', re: /\bowner\s+(?:of|for|over)\b/giu, nounEligible: false },
  // --- exclusivity ---
  {
    family: 'sole', kind: 'modifier', side: 'both',
    re: /\b(?:single-?handed(?:ly)?|solely|sole|independently|unaided|solo|by\s+myself|on\s+my\s+own|all\s+by\s+myself|without\s+(?:any\s+)?(?:help|assistance|support))\b/giu,
  },
  { family: 'sole', kind: 'modifier', side: 'both', re: /\balone\b/giu, reject: (text, m) => /\b(?:not|let|never)\s+$/iu.test(text.slice(Math.max(0, m.start - 8), m.start)) },
  { family: 'sole', kind: 'modifier', side: 'evidence', re: /\b(?:autonomous(?:ly)?|self-directed)\b/giu },
  // --- authorship (built < founded) ---
  { family: 'author', rank: 1, kind: 'verb', side: 'claim', re: new RegExp(String.raw`\b(?:${claimOnlyVerb})\b`, 'giu') },
  { family: 'author', rank: 1, kind: 'verb', side: 'evidence', re: new RegExp(String.raw`\b(?:${authorEvidenceVerb})\b`, 'giu') },
  { family: 'author', rank: 2, kind: 'verb', side: 'both', re: /\b(?:founded|co-founded|pioneered|pioneering|originated|invented|inventing)\b/giu },
];

function nounMentionEligible(spec, text, m, side) {
  if (spec.nounEligible === false) return true;
  if (spec.nounEligible !== true) return true;
  const followedByPreposition = FOLLOWING_PREPOSITION.test(text.slice(m.end));
  if (side === 'claim') return followedByPreposition;
  return followedByPreposition || SELF_FRAME_BEFORE_NOUN.test(text.slice(0, m.start));
}

const BOUNDARY_RE = /(?:[.;:!?]\s+|\s[—–]\s|\s+(?:and|but|then|while|so|also)\s+)/gu;

function clausePrefix(text, start) {
  const head = text.slice(0, start);
  let cut = 0;
  for (const match of head.matchAll(BOUNDARY_RE)) cut = match.index + match[0].length;
  return head.slice(cut);
}

function lastIndexOfRegex(text, regex) {
  let index = -1;
  for (const match of text.matchAll(regex)) index = match.index;
  return index;
}

function classifyMention(text, mention) {
  const prefix = clausePrefix(text, mention.start);
  const after = text.slice(mention.end, mention.end + 48);
  let level = 1;
  if (/\bco-$/iu.test(text.slice(0, mention.start)) || mention.match.toLowerCase().startsWith('co-')) level = 0;
  else if (SHARED_MARKER.test(prefix)) level = 0;
  else if (/^\s*(?:jointly|together)\b/iu.test(after)) level = 0;
  let other = false;
  // "<verb> by <someone>" is a passive whose agent is someone else, with or
  // without its auxiliary: the reduced passive "Led by the regional director,
  // the migration ..." credits the director exactly as "was led by" does. The
  // candidate is the agent only in "by me/us", and "by example", "by <-ing>"
  // and "by <number>" state a manner, means or margin, not an agent.
  if (mention.kind === 'verb'
    && /^\s+by\s+(?!(?:me|myself|us|ourselves|our|my|example)\b|\p{L}+ing\b|\d)/iu.test(after)) other = true;
  if (!other) {
    const pronounIndex = lastIndexOfRegex(prefix.slice(-60), RELATIVE_PRONOUN);
    const personIndex = lastIndexOfRegex(prefix.slice(-60), FIRST_PERSON);
    if (pronounIndex !== -1 && pronounIndex > personIndex) other = true;
  }
  if (!other && (PRONOUN_OTHER.test(prefix) || ROLE_NOUN_SUBJECT.test(prefix))) other = true;
  if (!other && GROUP_SUBJECT.test(prefix)) level = 0;
  if (!other && mention.kind === 'noun' && DETERMINER_BEFORE_NOUN.test(prefix) && !SELF_FRAME_BEFORE_NOUN.test(prefix)) other = true;
  mention.level = level;
  mention.self = !other;
  return mention;
}

/** Every strength mention of a text, tagged with its family, rank, level (0 shared, 1 full) and whether the candidate made it. */
export function scanStrengthMentions(rawText, side) {
  const text = String(rawText ?? '').replace(APOSTROPHES, "'");
  const found = [];
  for (const spec of MENTION_SPECS) {
    if (spec.side !== 'both' && spec.side !== side) continue;
    for (const match of text.matchAll(spec.re)) {
      const mention = { kind: spec.kind, rank: spec.rank || 1, match: match[0], start: match.index, end: match.index + match[0].length };
      if (spec.reject && spec.reject(text, mention)) continue;
      if (spec.kind === 'noun' && !nounMentionEligible(spec, text, mention, side)) continue;
      classifyMention(text, mention);
      for (const family of spec.families || [spec.family]) found.push({ ...mention, family });
    }
  }
  return found;
}

function contentTokens(sentence, mentions, ctx) {
  const mentionWords = new Set(mentions.flatMap(m => wordsOf(m.match)));
  return ctx.meaningful(sentence).filter(token => !mentionWords.has(token));
}

const lightStem = token => {
  let word = String(token).toLowerCase();
  if (word.length > 4) word = word.replace(/(?:ing|ed)$/u, '');
  if (word.length > 3) word = word.replace(/(?:es|s|e)$/u, '');
  return word;
};

function overlapCount(tokens, body, ctx) {
  const available = new Set(ctx.meaningful(body).map(lightStem));
  return new Set(tokens.map(lightStem).filter(stem => available.has(stem))).size;
}

/**
 * Is every claim mention of one strength family supported by the evidence?
 * Returns `{ match }` for the first unsupported claim mention, else null.
 *
 * A mention is supported only by a quote that (a) is about the same work, (b)
 * states the same family, (c) attributes it to the candidate rather than to
 * someone the quote describes, and (d) states it at no lower a class than the
 * claim: "co-led" and "helped lead" never support "led", "contributed to"
 * supports no authorship, and "built" never supports "founded".
 */
export function assessStrengthFamily(familyId, sentence, evidenceBodies, ctx) {
  const claimText = blankOut(sentence, ctx.trustedNames || []);
  const claim = scanStrengthMentions(claimText, 'claim').filter(m => m.family === familyId && m.self);
  if (!claim.length) return null;
  const allClaimMentions = scanStrengthMentions(claimText, 'claim').filter(m => m.self);
  const tokens = contentTokens(sentence, allClaimMentions, ctx);
  const threshold = Math.min(2, new Set(tokens.map(lightStem)).size);
  const evidence = evidenceBodies.map(body => ({
    body,
    mentions: scanStrengthMentions(body, 'evidence').filter(m => m.family === familyId && m.self),
  })).filter(entry => entry.mentions.length);
  for (const mention of claim) {
    const supported = evidence.some(entry => entry.mentions.some(found => found.level >= mention.level && found.rank >= mention.rank)
      && overlapCount(tokens, entry.body, ctx) >= threshold);
    // A bound authority entity may split the description of its work and the
    // candidate's authorship disposition into separate approved units. The
    // latter still needs a literal authorship word, and a bound description
    // from that same entity must identify the work in this claim.
    const entitySupported = familyId === 'author' && Array.isArray(ctx.authorshipEntityGroups)
      && ctx.authorshipEntityGroups.some(group => group.some((body, index) =>
        scanStrengthMentions(body, 'evidence').some(found => found.family === 'author' && found.self
          && found.level >= mention.level && found.rank >= mention.rank)
        && group.some((description, descriptionIndex) => descriptionIndex !== index
          && overlapCount(tokens, description, ctx) >= threshold)));
    // The class the claim asked for: an origination claim ("founded") that only
    // a lower class ("built") supports is answered by different forms.
    if (!supported && !entitySupported) return { match: mention.match, rank: mention.rank };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Named terms and tool-use strength
// ---------------------------------------------------------------------------

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const NAME_ALLOWANCE = new Set([
  'i', 'a', 'id', 'ok', 'am', 'pm', 'pc', 'tv', 'faq', 'diy', 'asap', 'eta', 'mr', 'mrs', 'ms', 'dr', 'jr', 'sr', 'present', 'current',
  'spring', 'summer', 'fall', 'autumn', 'winter', ...MONTHS, ...WEEKDAYS,
]);
const CURRENCY_NOUNS = new Set(['dollar', 'dollars', 'euro', 'euros', 'pound', 'pounds', 'yen', 'yuan', 'rupee', 'rupees', 'peso', 'pesos', 'franc', 'francs', 'krona', 'kronor']);
const NAME_CONNECTORS = new Set(['of', 'and', 'for', 'the', 'de', 'la', '&']);
const NAME_ALLOWED_PATTERNS = [/^Q[1-4]$/u, /^H[12]$/u, /^FY\d{2,4}$/u];
// These complete English words are grammatical contractions, never entity
// names. Keep this closed: stripping an apostrophe suffix from arbitrary words
// would also exempt real people, products and credentials.
const NAME_CONTRACTIONS = new Set([
  "i've", "i'm", "i'd", "i'll", "we're", "we've", "we'd", "we'll",
  "it's", "don't", "doesn't", "didn't", "can't", "won't", "isn't", "aren't",
  "they're", "they've", "you're", "you've", "that's", "there's",
]);

function isNamedPiece(piece, clauseInitial) {
  if (NAME_CONTRACTIONS.has(String(piece).toLowerCase().replace(APOSTROPHES, "'"))) return false;
  if (!/\p{L}/u.test(piece)) return false;
  const letters = piece.replace(/[^\p{L}]/gu, '');
  const upper = (piece.match(/\p{Lu}/gu) || []).length;
  const lower = (piece.match(/\p{Ll}/gu) || []).length;
  const hasDigit = /\p{N}/u.test(piece);
  const symbol = /[+#]$/u.test(piece) || /^\.\p{L}/u.test(piece) || (/\p{L}\.\p{L}/u.test(piece) && upper >= 1);
  if (letters.length === 1 && !symbol) return false;
  const acronym = upper >= 2 && lower === 0 && letters.length >= 2;
  const camel = upper >= 2 && lower >= 1;
  const mixedAlnum = hasDigit && /^\p{Lu}/u.test(piece);
  const titled = upper === 1 && /^\p{Lu}/u.test(piece) && lower >= 1 && !hasDigit;
  if (acronym || camel || symbol || mixedAlnum) return true;
  return titled && !clauseInitial;
}

function evidenceNameIndex(bodies) {
  const words = new Set();
  const stems = new Set();
  const symbols = new Set();
  const sequences = [];
  for (const body of bodies) {
    const sequence = wordsOf(body);
    sequences.push(sequence);
    for (const word of sequence) { words.add(word); stems.add(stemToken(word)); }
    for (const match of String(body).toLowerCase().matchAll(/[\p{L}\p{N}]+(?:[+#]+|(?:\.[\p{L}\p{N}]+)+)/gu)) symbols.add(match[0]);
    for (const match of String(body).toLowerCase().matchAll(/\.[\p{L}][\p{L}\p{N}]*/gu)) symbols.add(match[0]);
  }
  return { words, stems, symbols, sequences, phrases: initialismPhrases(bodies) };
}

const INITIALISM_SKIP = new Set(['of', 'and', 'the', 'for', 'to', 'in', 'on', 'a', 'an', 'at', 'by']);
// An acronym is grounded by its EXPANSION, and an expansion is a name or a noun
// phrase: "Amazon Web Services", "service level agreement". The initial letters
// of any run of evidence words are not one: "Managed logistics" does not state
// ML, "and improved" does not state AI, "Prepared monthly plans" does not state
// PMP. So an expansion is read only inside one phrase (no punctuation between
// its words), its words are never function words or verbs (a word ending in
// -ed, a closed list of irregular past and base verbs, or a word the evidence
// opens a statement with, which in career data is the action verb), and
//   - a two-letter acronym needs every expansion word written as a name
//     (capitalized and not opening its statement), because two initials match
//     some pair of words in almost any sentence;
//   - a longer one accepts a lowercase noun phrase, or the same capitalized name.
// Where an acronym is written literally in the evidence it is grounded as a word
// and never reaches this reading.
const INITIALISM_VERB_WORDS = new Set([
  'built', 'wrote', 'led', 'ran', 'kept', 'held', 'made', 'took', 'gave', 'got', 'set', 'put', 'cut', 'sent', 'taught', 'chose', 'began', 'won',
  'spent', 'drove', 'found', 'met', 'paid', 'sold', 'told', 'brought', 'grew', 'drew', 'rose', 'lost', 'left', 'saw', 'knew', 'became', 'did',
  'went', 'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'had', 'with', 'from', 'into', 'as', 'or', 'but', 'this', 'that', 'our', 'my',
  'their', 'its', 'his', 'her', 'your', 'we', 'i', 'they', 'it', 'who', 'which', 'while', 'over', 'across', 'per', 'each', 'every', 'all',
]);
/** The phrases of the evidence (text between punctuation), words in their original case, each marked when it opens a statement. */
function initialismPhrases(bodies) {
  const phrases = [];
  for (const body of bodies) {
    for (const statement of String(body ?? '').split(/[.;:!?]+(?:\s+|$)/u)) {
      String(statement).split(/[,()[\]{}"“”/|]+|\s[—–-]\s/u).forEach((part, position) => {
        const words = [...part.matchAll(/[\p{L}\p{N}]+(?:['’]\p{L}+)?/gu)].map(match => match[0]);
        if (words.length) phrases.push({ words, opensStatement: position === 0 });
      });
    }
  }
  return phrases;
}
/** May this evidence word stand for one letter of an acronym? Never a function word or a verb. */
function initialismWordAllowed(word, opensStatement, requireName, nextWord) {
  const lower = word.toLowerCase();
  if (!/^\p{L}/u.test(word) || INITIALISM_SKIP.has(lower) || INITIALISM_VERB_WORDS.has(lower)) return false;
  if (lower.length > 3 && lower.endsWith('ed')) return false;
  // The word a career statement opens with is its action verb ("Analyzed weekly sales ..."),
  // unless it begins a multi-word name ("Amazon Web Services ...").
  if (opensStatement && !(/^\p{Lu}/u.test(word) && /^\p{Lu}/u.test(String(nextWord ?? '')))) return false;
  if (opensStatement && requireName) return false;
  return !requireName || /^\p{Lu}/u.test(word);
}
function initialismMatchesAt(letters, words, cursor, matched, opensAt, requireName) {
  if (matched === letters.length) return true;
  if (cursor >= words.length) return false;
  const word = words[cursor];
  const lower = word.toLowerCase();
  if (lower[0] === letters[matched] && initialismWordAllowed(word, opensAt(cursor), requireName, words[cursor + 1])
    && initialismMatchesAt(letters, words, cursor + 1, matched + 1, opensAt, requireName)) return true;
  // Inside an expansion a joining word may be skipped ("Department of Labor") or stand for its letter.
  if (matched > 0 && INITIALISM_SKIP.has(lower)) {
    if (lower[0] === letters[matched] && initialismMatchesAt(letters, words, cursor + 1, matched + 1, opensAt, requireName)) return true;
    return initialismMatchesAt(letters, words, cursor + 1, matched, opensAt, requireName);
  }
  return false;
}
function initialismGrounded(acronym, index) {
  const letters = acronym.toLowerCase().replace(/[^a-z]/gu, '');
  if (letters.length < 2 || letters.length > 8) return false;
  const requireName = letters.length === 2;
  return (index.phrases || []).some(phrase => phrase.words.some((_, start) =>
    initialismMatchesAt(letters, phrase.words, start, 0, at => phrase.opensStatement && at === 0, requireName)));
}

function pieceGrounded(piece, index, exempt, currencyCodes = null) {
  const lower = piece.toLowerCase();
  // An ISO currency code beside an amount is a figure marker the figure gate grades, not a name.
  if (currencyCodes && currencyCodes.has(piece)) return true;
  if (NAME_ALLOWANCE.has(lower) || NAME_ALLOWED_PATTERNS.some(pattern => pattern.test(piece))) return true;
  if (index.symbols.has(lower)) return true;
  if (/[+#]/u.test(lower)) return false;
  const pieces = wordsOf(piece.replace(/'s$/iu, ''));
  if (!pieces.length) return true;
  return pieces.every(word => {
    const stem = stemToken(word);
    return index.words.has(word) || index.stems.has(stem) || exempt.has(word) || exempt.has(stem)
      || (/^\p{Lu}+$/u.test(piece.replace(/[^\p{L}]/gu, '')) && initialismGrounded(word, index));
  });
}

const STRONG_USE_FRAME = /\b(?:using|utili[sz]ing|leverag(?:ing|ed)|(?:proficien(?:t|cy)|skilled|fluent|fluency|expertise|expert|experienced|familiar(?:ity)?|competent|comfortable|trained|certified|knowledgeable)\s+(?:with|in|on|using)|(?:hands-on|practical|working)\s+(?:experience|knowledge)\s+(?:with|in|of|using)|experience\s+(?:with|in|using)|(?:built|written|coded|developed|implemented|deployed|configured|automated|scripted|programmed|delivered)\s+(?:in|with|on|using)|powered\s+by|based\s+on)\s+(?:the\s+|a\s+|an\s+|our\s+)?$/iu;
const WEAK_USE_FRAME = /\b(?:with|in|on|via|through|within)\s+(?:the\s+|a\s+|an\s+)?$/iu;
const EXPOSURE_BEFORE = /\b(?:evaluat\w*|consider\w*|assess\w*|compar\w*|explor\w*|trial\w*|demo\w*|attend\w*|shadow\w*|observ\w*|selected|chosen|chose|propos\w*|recommend\w*|procur\w*|purchas\w*|bought|licensed|installed|mandated|rejected|replac\w*|researched|investigat\w*|vetted|piloted)\b[^.;:!?]{0,60}$/iu;
const EXPOSURE_AFTER = /^\W*(?:[\p{L}'-]+\s+){0,3}?(?:was|were|is|are|had\s+been|has\s+been)\s+(?:[\p{L}'-]+\s+){0,2}?(?:selected|chosen|supplied|licensed|purchased|bought|installed|set\s+up|built|written|created|developed|owned|managed|run|maintained|provided|mandated|required|used|adopted|configured|administered|operated)\s+by\b|^\W*(?:[\p{L}'-]+\s+){0,4}?as\s+(?:a|an|the)\s+(?:possible|potential|candidate|replacement|alternative|substitute|option)\b/iu;

function evidenceUseClasses(runText, firstToken, bodies) {
  const classes = new Set();
  const search = needle => {
    const pattern = escapeRegExp(needle).replace(/\s+/gu, '\\s+');
    return new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'giu');
  };
  for (const needle of [runText, firstToken]) {
    for (const body of bodies) {
      for (const match of body.matchAll(search(needle))) {
        const clauseBefore = clausePrefix(body, match.index);
        const after = body.slice(match.index + match[0].length, match.index + match[0].length + 90);
        if (EXPOSURE_BEFORE.test(clauseBefore) || EXPOSURE_AFTER.test(after)) classes.add('exposure');
        else if (/^\s*(?:[\p{Ll}][\p{L}'-]*\s+){0,2}(?:,\s*)?(?:or|and\/or|\/)\s+\p{L}/iu.test(after) || /(?:\beither|\bor|\band\/or)\s+(?:the\s+|a\s+|an\s+)?$/iu.test(clauseBefore)) classes.add('alternative');
        else classes.add('use');
      }
    }
    if (classes.size) break;
  }
  return classes;
}

/**
 * Named-term findings. `sentence` is one candidate sentence (or a whole bullet);
 * `bodies` are the cited quotes' statements. A finding is either an ungrounded
 * term ("name") or a tool-use claim the evidence only evaluates, attributes to
 * someone else, or offers as one of several alternatives ("use").
 */
export function namedTermFindings(sentence, bodies, ctx) {
  const findings = [];
  const index = evidenceNameIndex(bodies);
  const exempt = new Set((ctx.trustedNames || []).flatMap(name => wordsOf(name).flatMap(word => [word, stemToken(word)])));
  for (const token of ctx.exemptTokens || []) { exempt.add(String(token).toLowerCase()); exempt.add(stemToken(token)); }
  // A caller that reads a sentence ADDRESSED TO THE TARGET (second person, the
  // employer's name, "this role") passes the posting: a name the posting itself
  // uses is free there, because the sentence is about the target's own stack.
  // The caller never passes it for any other sentence, so a name the posting
  // states cannot be attached to the candidate's own cited work, and a name
  // neither the quotes nor the posting state is ungrounded either way.
  for (const word of ctx.postingText ? wordsOf(ctx.postingText) : []) { exempt.add(word); exempt.add(stemToken(word)); }
  const text = String(sentence ?? '').replace(APOSTROPHES, "'");
  let clauseInitial = true;
  const runs = [];
  let open = null;
  const chunks = [...text.matchAll(/\S+/gu)];
  for (const [chunkIndex, chunk] of chunks.entries()) {
    const raw = chunk[0];
    const nextCore = (chunks[chunkIndex + 1]?.[0] || '').toLowerCase().replace(/[^\p{L}]/gu, '');
    const lead = raw.match(/^[("'“‘[{]+/u)?.[0] ?? '';
    let core = raw.slice(lead.length);
    const trail = core.match(/[)"'”’\]},;:!?.…]+$/u)?.[0] ?? '';
    core = core.slice(0, core.length - trail.length);
    const standaloneBoundary = /^[—–•|-]$/u.test(raw);
    // An amount with its currency marker (US$1M, C$5, €3k) is a figure the figure gate grades, never a name.
    // ("1 US dollar" qualifies the currency of a figure the figure gate grades.)
    const pieces = /[$€£¥₹]/u.test(core) || CURRENCY_NOUNS.has(nextCore) ? [] : core.split(/-(?=[\p{L}\p{N}])/u).filter(Boolean);
    const named = [];
    pieces.forEach((piece, position) => {
      if (isNamedPiece(piece, clauseInitial && position === 0)) named.push({ piece });
    });
    if (named.length) {
      if (!open) { open = { start: chunk.index, pieces: [] }; runs.push(open); }
      named.forEach((entry, position) => {
        open.pieces.push({ ...entry, connector: position === 0 ? open.connector || '' : '', grounded: pieceGrounded(entry.piece, index, exempt, ctx.currencyCodes) });
      });
      open.connector = '';
    } else if (open && !named.length && NAME_CONNECTORS.has(core.toLowerCase()) && !trail) {
      open.connector = core;
    } else if (core || standaloneBoundary) {
      open = null;
    }
    clauseInitial = /[.!?;:]$/u.test(trail) || standaloneBoundary;
    if (/,$/u.test(trail) && open) open = null;
  }
  const seen = new Set();
  for (const run of runs) {
    // One finding per stretch of consecutive ungrounded pieces ("Director of Nursing").
    const groups = [];
    for (const piece of run.pieces) {
      if (piece.grounded) { groups.push(null); continue; }
      const last = groups[groups.length - 1];
      if (last) last.push(piece); else groups.push([piece]);
    }
    const ungroundedGroups = groups.filter(Boolean);
    if (ungroundedGroups.length) {
      for (const group of ungroundedGroups) {
        const term = group.map((piece, position) => `${position && piece.connector ? `${piece.connector} ` : ''}${piece.piece}`).join(' ');
        if (!seen.has(term.toLowerCase())) { seen.add(term.toLowerCase()); findings.push({ code: 'name', term }); }
      }
      continue;
    }
    // Every piece is a name the evidence states: when it is claimed as a tool the candidate USED, the evidence must use it too.
    const before = text.slice(Math.max(0, run.start - 70), run.start);
    const clauseBefore = clausePrefix(text, run.start);
    const techy = run.pieces.some(piece => /\p{Lu}.*\p{Ll}.*\p{Lu}|^\p{Lu}{2,}$|[+#]$|\p{N}/u.test(piece.piece));
    const strong = STRONG_USE_FRAME.test(before);
    if (!(strong || (techy && WEAK_USE_FRAME.test(before)))) continue;
    if (EXPOSURE_BEFORE.test(clauseBefore)) continue;
    // "using Alpha and Beta" claims both, so each name joined by a connector is judged on its own.
    const names = [];
    for (const piece of run.pieces) {
      if (!names.length || piece.connector) names.push([piece.piece]); else names[names.length - 1].push(piece.piece);
    }
    for (const name of names) {
      const term = name.join(' ');
      const claimAlternative = /^\s*(?:[\p{Ll}][\p{L}'-]*\s+){0,2}(?:,\s*)?(?:or|and\/or|\/)\s+\p{L}/iu.test(text.slice(run.start + run.pieces.map(piece => piece.piece).join(' ').length)) || /(?:\beither|\bor)\s+$/iu.test(clauseBefore);
      const classes = evidenceUseClasses(term, name[0], bodies);
      const ok = claimAlternative ? (classes.has('alternative') || classes.has('use')) : classes.has('use');
      if (!ok && classes.size && !seen.has(`use:${term.toLowerCase()}`)) {
        seen.add(`use:${term.toLowerCase()}`);
        findings.push({ code: 'use', term, reason: classes.has('alternative') && !classes.has('exposure') ? 'alternative' : 'exposure' });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Quantities (counts, bounds, rate intervals)
// ---------------------------------------------------------------------------

const ONES = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES = { hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 };
const NUMBER_WORD = `(?:${Object.keys(TENS).join('|')})(?:[-\\s](?:one|two|three|four|five|six|seven|eight|nine))?|${Object.keys(ONES).join('|')}`;
const SPELLED_RE = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${NUMBER_WORD})(?:[-\s]+(?:hundred|thousand|million|billion))?(?![\p{L}\p{N}])`, 'giu');

export const SPELLED_NUMBER_PATTERN = String.raw`(?:${NUMBER_WORD})(?:[-\s]+(?:hundred|thousand|million|billion))?`;

export function spelledNumberValue(phrase) { return spelledValue(phrase); }

function spelledValue(phrase) {
  let total = 0;
  let current = 0;
  for (const word of String(phrase).toLowerCase().split(/[-\s]+/u).filter(Boolean)) {
    if (word in ONES) current += ONES[word];
    else if (word in TENS) current += TENS[word];
    else if (word === 'hundred') current = (current || 1) * 100;
    else if (word in SCALES) { total += (current || 1) * SCALES[word]; current = 0; }
  }
  return total + current;
}

const LOWER_BOUND_BEFORE = /(?:\bover|\bmore\s+than|\babove|\bexceed(?:s|ed|ing)?|\bat\s+least|\bupwards?\s+of|\bin\s+excess\s+of|\bbeyond|\bgreater\s+than)\s+$/iu;
const UPPER_BOUND_BEFORE = /(?:\bunder|\bfewer\s+than|\bless\s+than|\bup\s+to|\bbelow|\bat\s+most|\bno\s+more\s+than|\bas\s+many\s+as)\s+$/iu;
const LOWER_BOUND_AFTER = /^\s*(?:\+|plus\b|or\s+more\b|and\s+(?:up|above|over|more)\b)/iu;
const DIGIT_RE = /(?<![\p{L}\p{N}_$€£¥₹#./:+,-])(?<digits>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?<magnitude>\s?(?:thousand|million|billion|trillion)\b|[kKmMbB](?![\p{L}\p{N}]))?(?![\p{L}\p{N}_%×])/gu;
const MAGNITUDE_VALUE = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, trillion: 1e12 };
const LABEL_BEFORE = /\b(?:page|pages|section|sections|figure|fig|table|step|steps|chapter|exhibit|appendix|article|rule|level|tier|phase|grade|version|release|stage|part|volume|vol|no|number|item|room|gate|bay|aisle|building|floor|suite|route|channel|model|series|class|type|form|policy|fy|q|iso|rfc|sprint|week|day|month|quarter|term|semester|season|cohort|batch|wave|window|bed|beds)\s+$/iu;
const NOT_COUNT_FOLLOWER = new Set(['percent', 'percentage', 'pct', 'cent', 'x', 'times', 'am', 'pm', 'dollars', 'dollar', 'euros', 'euro', 'pounds', 'pound', 'yen', 'yuan', 'rupees', 'rupee', 'usd', 'cad', 'eur', 'gbp', 'of', 'the', 'a', 'an', 'and', 'or', 'th', 'st', 'nd', 'rd']);
const TEMPORAL_BEFORE = /(?:\b(?:in|since|from|during|until|till|through|between|by|before|after|circa|around|fy|fiscal|class\s+of|early|late|mid|of|and|to)\s+)$/iu;
const MONTH_BEFORE = new RegExp(`\\b(?:${MONTHS.join('|')})\\.?\\s*,?\\s*$`, 'iu');
const GROUP_NOUN_OF_BEFORE = /\b(?:team|staff|crew|group|squad|cohort|panel|committee|department|workforce|force|roster|class|pool|fleet)\s+of\s+$/iu;
const POPULATION_FOLLOWER = /^(?:end[- ]?users?|users?|students?|teachers?|customers?|clients?|residents?|patients?|employees?|staff|families|schools?)$/iu;

function normalizeRanges(text) {
  return text.replace(/(?<=\d)\s*[–—]\s*(?=\d)/gu, ' to ').replace(/(?<=\d)-(?=\d)/gu, ' to ');
}

function nextWord(text, index) {
  return /^\s*(?:-\s*)?(?<word>[\p{L}][\p{L}'-]*)/u.exec(text.slice(index))?.groups?.word?.toLowerCase() || '';
}

function nextPhrase(text, index) {
  return /^\s*(?:-\s*)?(?<phrase>[\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*)?)/u.exec(text.slice(index))?.groups?.phrase?.toLowerCase() || '';
}

// Words that end the noun phrase a count counts: "3 agents OVER 12 months",
// "12 analysts ON the team". A count is a count OF the words before them.
const COUNT_RUN_STOP = new Set(['of', 'the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'from', 'into', 'onto', 'with', 'by', 'across',
  'per', 'that', 'who', 'which', 'as', 'is', 'are', 'was', 'were', 'our', 'your', 'my', 'their', 'its', 'his', 'her', 'this', 'these', 'those',
  'each', 'every', 'all', 'also', 'than', 'so', 'then', 'but', 'it', 'through', 'over', 'during', 'under', 'until', 'via', 'since', 'after',
  'before', 'within', 'without', 'about', 'around', 'between', 'among', 'including', 'while', 'when', 'where', 'whose', 'like', 'not', 'no',
  'toward', 'towards', 'against', 'beyond', 'throughout', 'plus', 'more', 'fewer', 'less']);
const MAX_COUNT_RUN_WORDS = 4;
// Units of time: "a team of 12" counts people, never months.
const TIME_HEAD_STEMS = new Set(['second', 'minute', 'hour', 'day', 'week', 'weekend', 'month', 'quarter', 'year', 'decade', 'shift', 'sprint', 'semester', 'term', 'season', 'night', 'fortnight'].map(word => relatednessStem(word)));

function countRunWords(fragment) {
  const run = [];
  for (const word of wordsOf(fragment)) {
    if (COUNT_RUN_STOP.has(word) || /^\d/u.test(word)) break;
    run.push(word);
    if (run.length === MAX_COUNT_RUN_WORDS) break;
  }
  return run;
}

/**
 * What a count counts: the run of words after it up to a preposition, a
 * conjunction or punctuation ("12 support agents on ..." counts support agents),
 * the group it sizes ("a team of 12"), the noun a label gives it ("Vendors
 * onboarded: 12"), and for "12 of 40 stores" the noun after the total. Stems;
 * `head` is the last word of the run, the noun the count is a count of.
 */
function countedThing(text, start, end) {
  const phraseEnd = /[.,;:!?()[\]{}"“”]|\s[—–]\s/u;
  const rest = text.slice(end).split(phraseEnd)[0];
  let run = countRunWords(rest.replace(/^\s*-\s*/u, ''));
  if (!run.length) {
    const ofTotal = /^\s*of\s+(?:(?:the|our|its|their|all)\s+)?(?:\d[\d,.]*|[\p{L}]+)\s+/iu.exec(rest);
    if (ofTotal) run = countRunWords(rest.slice(ofTotal[0].length));
  }
  const before = text.slice(Math.max(0, start - 40), start);
  const group = GROUP_NOUN_OF_BEFORE.exec(before.slice(-24))?.[0]?.trim().split(/\s+/u)[0]?.toLowerCase() || '';
  const label = /(?:^|[.;:!?]\s*|\s)((?:[\p{L}][\p{L}'-]*\s+){0,2}[\p{L}][\p{L}'-]*)\s*:\s*$/u.exec(before)?.[1] || '';
  const stems = run.map(relatednessStem);
  const labelStems = run.length ? [] : wordsOf(label).filter(word => !COUNT_RUN_STOP.has(word)).map(relatednessStem);
  const words = new Set([...stems, ...labelStems, ...(group ? [relatednessStem(group)] : [])]);
  const heads = new Set([...(stems.length ? [stems[stems.length - 1]] : []), ...labelStems.slice(-1), ...(group ? [relatednessStem(group)] : [])]);
  const described = run.length ? run.join(' ') : (wordsOf(label).filter(word => !COUNT_RUN_STOP.has(word)).join(' ') || group);
  return { words, heads, group: Boolean(group), counts: stems.length > 0 || labelStems.length > 0, text: described };
}

/**
 * Does an evidence count count the same thing as a claimed count? The value is
 * not enough: "3 agents over 12 months" states 12 only for months, and that 12
 * is no evidence of "12 support agents". The thing is the same when the
 * claim's noun is among the words the evidence count counts, or the evidence's
 * noun among the claim's ("12 agents" and "12 support agents"). A count that
 * counts no word ("finished 12 of them") is compared by value, as is a group
 * size ("a team of 12"), which a count of a unit of time never supports.
 */
function countsSameThing(claim, found) {
  const own = claim.thing;
  const other = found.thing;
  if (!own || !other) return true;
  if (!own.counts) {
    if (!own.group) return true;
    return !(other.counts && [...other.heads].every(head => TIME_HEAD_STEMS.has(head)));
  }
  return [...own.heads].some(head => other.words.has(head)) || [...other.heads].some(head => own.words.has(head));
}

function boundOf(text, start, end) {
  const before = text.slice(Math.max(0, start - 24), start);
  const after = text.slice(end, end + 16);
  if (LOWER_BOUND_BEFORE.test(before) || LOWER_BOUND_AFTER.test(after)) return 'lower';
  if (UPPER_BOUND_BEFORE.test(before)) return 'upper';
  return 'exact';
}

/** Counts a text states. `permissive` (evidence side) keeps every number; the claim side keeps only those that read as a count of something. */
export function extractQuantities(rawText, { permissive = false, skipPopulationNouns = false } = {}) {
  const text = normalizeRanges(String(rawText ?? '').replace(APOSTROPHES, "'"));
  const found = [];
  const push = (raw, value, start, end, extra = {}) => {
    const lead = LOWER_BOUND_BEFORE.exec(text.slice(Math.max(0, start - 24), start))?.[0] ?? '';
    const plus = /^\s*\+/u.test(text.slice(end, end + 3)) ? '+' : '';
    found.push({ raw, value, bound: boundOf(text, start, end), start, end, display: `${lead}${raw}${plus}`.trim(), thing: countedThing(text, start, end), ...extra });
  };
  for (const match of text.matchAll(DIGIT_RE)) {
    const { digits, magnitude } = match.groups;
    const start = match.index;
    const end = start + match[0].length;
    const mag = magnitude ? MAGNITUDE_VALUE[magnitude.trim().toLowerCase()] : 1;
    const value = Number(digits.replace(/,/gu, '')) * mag;
    if (!Number.isFinite(value)) continue;
    if (!permissive) {
      const follower = nextWord(text, end);
      const before = text.slice(Math.max(0, start - 16), start);
      const groupSize = GROUP_NOUN_OF_BEFORE.test(before);
      if (!follower && !groupSize && !/^\s*(?:to\s+)?\d/u.test(text.slice(end))) continue;
      if (NOT_COUNT_FOLLOWER.has(follower) && !groupSize && !/^\s*to\s+\d/u.test(text.slice(end))) continue;
      if (skipPopulationNouns && POPULATION_FOLLOWER.test(follower)) continue;
      if (LABEL_BEFORE.test(before) || /\d\s*(?:[x\u00d7]|times|by)\s*$/iu.test(before)) continue;
      // An amount beside its ISO currency code ("USD 1,000,000", "5,000 EUR") is the figure gate's.
      if (/(?<![\p{L}\p{N}])[A-Z]{3}\s+$/u.test(before) || /^\s*[A-Z]{3}(?![\p{L}\p{N}])/u.test(text.slice(end))) continue;
      if (/^(?:19|20)\d{2}$/u.test(digits) && !magnitude) {
        if (TEMPORAL_BEFORE.test(before) || MONTH_BEFORE.test(before) || !follower) continue;
        if (MONTHS.includes(follower) || WEEKDAYS.includes(follower)) continue;
      }
      if (value <= 1) continue;
    }
    push(match[0].trim(), value, start, end, { follower: nextWord(text, end), phrase: nextPhrase(text, end) });
  }
  for (const match of text.matchAll(SPELLED_RE)) {
    const start = match.index;
    const end = start + match[0].length;
    const value = spelledValue(match[0]);
    if (!value) continue;
    if (!permissive) {
      const follower = nextWord(text, end);
      const groupSize = GROUP_NOUN_OF_BEFORE.test(text.slice(Math.max(0, start - 16), start));
      if ((!follower || NOT_COUNT_FOLLOWER.has(follower)) && !groupSize) continue;
      if (skipPopulationNouns && POPULATION_FOLLOWER.test(follower)) continue;
      if (/^one$/iu.test(match[0].trim())) continue;
      if (LABEL_BEFORE.test(text.slice(Math.max(0, start - 16), start))) continue;
    }
    push(match[0].trim(), value, start, end, { follower: nextWord(text, end), phrase: nextPhrase(text, end), spelled: true });
  }
  if (permissive) {
    for (const match of text.matchAll(/\b(?:(?:half\s+a|a|one|two|three|four|five|six|several|many)\s+)?dozen\b/giu)) {
      const lead = /^(?:half\s+a|a|one|two|three|four|five|six)/iu.exec(match[0])?.[0]?.toLowerCase() || 'a';
      const factor = lead === 'half a' ? 0.5 : (ONES[lead] || 1);
      push(match[0], 12 * factor, match.index, match.index + match[0].length);
    }
    for (const match of text.matchAll(/\bone\b/giu)) push(match[0], 1, match.index, match.index + 3);
    for (const match of text.matchAll(/\b(?:(?:a|one)\s+)?(?:hundred|thousand|million|billion)\b/giu)) push(match[0], SCALES[match[0].toLowerCase().replace(/^(?:a|one)\s+/u, '')], match.index, match.index + match[0].length);
  } else {
    for (const match of text.matchAll(/\b(?:(?:a|one|two|three|four|five|six)\s+)?dozen\b(?!\s+of\b)/giu)) {
      const lead = /^(?:a|one|two|three|four|five|six)/iu.exec(match[0])?.[0]?.toLowerCase() || 'a';
      push(match[0], 12 * (ONES[lead] || 1), match.index, match.index + match[0].length, { follower: nextWord(text, match.index + match[0].length) });
    }
  }
  return found;
}

const sameValue = (left, right) => Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));

function quantitySupported(claim, evidenceQuantities) {
  if (claim.bound === 'lower') {
    return evidenceQuantities.some(found => (found.bound === 'lower' ? found.value >= claim.value - 1e-9 : found.value > claim.value + 1e-9));
  }
  return evidenceQuantities.some(found => sameValue(found.value, claim.value));
}

// Words that follow a count without being the thing counted ("four of the", "six across").
const COUNTED_NOUN_SKIP = new Set(['of', 'the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'from', 'into', 'onto', 'with', 'by', 'across',
  'per', 'that', 'who', 'which', 'as', 'is', 'are', 'was', 'were', 'our', 'your', 'my', 'their', 'its', 'his', 'her', 'this', 'these', 'those',
  'each', 'every', 'all', 'also', 'than', 'so', 'then', 'but', 'it']);

/** The words a count is a count OF ("four regional offices" counts regional and office), as stems; empty when it counts nothing. */
function countedNouns(quantity) {
  return new Set(wordsOf(quantity.phrase || quantity.follower || '').filter(word => !COUNTED_NOUN_SKIP.has(word)).map(stemToken));
}

/**
 * Does the posting state this count FOR THE SAME THING? A number is evidence of
 * nothing by itself: the posting's "four distribution centers" does not make
 * "four dock crews" a fact about the candidate's work, so a posting count
 * supports a claim only when it counts the same noun, and never when a cited
 * quote counts that same noun differently (the cited work wins).
 */
function postingCountSupports(claim, postingQuantities, evidenceQuantities) {
  // A count with no counted noun after it has an empty set, which no posting count shares.
  const nouns = countedNouns(claim);
  const sameNoun = found => [...countedNouns(found)].some(noun => nouns.has(noun));
  if (evidenceQuantities.some(found => sameNoun(found) && !sameValue(found.value, claim.value))) return false;
  return quantitySupported(claim, postingQuantities.filter(sameNoun));
}

/** Counts in the sentence that no cited quote states (a lower bound needs a lower bound at least as large). */
export function quantityFindings(sentence, bodies, ctx) {
  const evidence = bodies.flatMap(body => extractQuantities(body, { permissive: true }));
  // The posting's own counts, for the caller that reads a sentence addressed to
  // the target (see namedTermFindings). A posting count is evidence only for
  // the SAME counted noun, and never against a quote that counts that noun
  // differently (postingCountSupports); a count neither the quotes nor the
  // posting state, for that noun, is not supported.
  const postingQuantities = ctx.postingText ? extractQuantities(String(ctx.postingText), { permissive: true }) : [];
  const claims = extractQuantities(blankOut(sentence, ctx.trustedNames || []), { skipPopulationNouns: ctx.skipPopulationNouns !== false });
  const findings = [];
  const seen = new Set();
  for (const claim of claims) {
    // An experience span is the duration gate's claim to judge; this rule reads the other counts.
    const tail = sentence.slice(claim.end, claim.end + 60);
    if (/^\s*\+?\s*(?:years?|yrs?)\b(?:\s+of)?\s+(?:[\p{L}'-]+\s+){0,3}?(?:experience|expertise|background)\b/iu.test(tail)) continue;
    // A count is supported only by a count of the same thing (countsSameThing).
    if (quantitySupported(claim, evidence.filter(found => countsSameThing(claim, found)))) continue;
    if (postingQuantities.length && postingCountSupports(claim, postingQuantities, evidence)) continue;
    const key = `${claim.raw}|${claim.bound}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const display = claim.display || claim.raw;
    // The same number stated for something else, so the rejection can say why the number alone is not support.
    const elsewhere = evidence.find(found => quantitySupported(claim, [found])) || null;
    const otherThing = elsewhere ? (elsewhere.thing?.text || elsewhere.phrase || elsewhere.follower || '') : '';
    findings.push({ code: 'quantity', term: display, bound: claim.bound, follower: claim.thing?.text || claim.phrase || claim.follower || '', ...(elsewhere ? { otherThing: otherThing || 'something else' } : {}) });
  }
  // Unnumbered spans ("a decade") are counts of years.
  for (const match of String(sentence ?? '').matchAll(/\b(?<bound>over|more\s+than|nearly|almost|about|around|for|the\s+past|the\s+last)?\s*(?<n>a|one|two|three|four|five|six|several|many|multiple)\s+decades?\b/giu)) {
    const n = match.groups.n.toLowerCase();
    const multiplicity = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, several: 3, many: 3, multiple: 3 }[n] || 1;
    const value = 10 * multiplicity;
    const lower = /^(?:over|more\s+than|many|several|multiple)/iu.test(`${match.groups.bound || ''} ${n}`.trim());
    const stated = bodies.some(body => /\bdecades?\b/iu.test(body))
      || bodies.some(body => [...String(body).matchAll(/(\d+(?:\.\d+)?)\s*\+?[-\s]*(?:years?|yrs?)\b/giu)].some(found => (lower ? Number(found[1]) > value : Number(found[1]) >= value)))
      || bodies.some(body => extractQuantities(body, { permissive: true }).some(found => /^(?:years?|yrs?)$/iu.test(nextWord(body, found.end)) && (lower ? found.value > value : found.value >= value)));
    if (!stated) findings.push({ code: 'quantity', term: match[0].trim(), bound: lower ? 'lower' : 'exact', follower: 'years' });
  }
  return findings;
}

const CANONICAL_UNITS = {
  hourly: 'hour', hr: 'hour', hrs: 'hour', hours: 'hour', daily: 'day', days: 'day', nightly: 'night', nights: 'night',
  weekly: 'week', weeks: 'week', biweekly: 'week', fortnightly: 'fortnight', monthly: 'month', months: 'month', quarterly: 'quarter', quarters: 'quarter',
  annually: 'year', yearly: 'year', annual: 'year', years: 'year', shifts: 'shift', sprints: 'sprint', weekends: 'weekend', weekdays: 'weekday',
};
const canonicalUnit = word => {
  const lower = String(word).toLowerCase();
  return CANONICAL_UNITS[lower] || stemToken(lower);
};
const NOT_INTERVAL = new Set(['diem', 'se', 'capita', 'cent', 'annum']);
const TIME_UNIT = 'hour|day|week|weekday|weekend|month|quarter|year|shift|sprint|night|morning|semester|term|season|cycle|release|iteration|fortnight';

function intervalMatches(text, { evidenceSide }) {
  const found = [];
  const lower = String(text ?? '').toLowerCase();
  const add = (match, unit) => found.push({ unit, raw: match[0], start: match.index });
  for (const match of lower.matchAll(/\bper\s+(?:a\s+|an\s+|the\s+)?([\p{L}]+)/gu)) if (!NOT_INTERVAL.has(match[1])) add(match, canonicalUnit(match[1]));
  for (const match of lower.matchAll(new RegExp(String.raw`\b(?:each|every)\s+(${TIME_UNIT})\b`, 'gu'))) add(match, canonicalUnit(match[1]));
  if (evidenceSide) {
    for (const match of lower.matchAll(new RegExp(String.raw`\b(?:a|an|per)\s+(${TIME_UNIT})\b`, 'gu'))) add(match, canonicalUnit(match[1]));
    for (const match of lower.matchAll(/\b(hourly|daily|nightly|weekly|biweekly|fortnightly|monthly|quarterly|annually|yearly|annual)\b/gu)) add(match, canonicalUnit(match[1]));
    for (const match of lower.matchAll(/\bday-to-day\b|\bweek-to-week\b|\bmonth-to-month\b/gu)) add(match, match[0].split('-')[0]);
  } else {
    for (const match of lower.matchAll(/\b(hourly|nightly|quarterly|annually|yearly|biweekly|fortnightly)\b/gu)) add(match, canonicalUnit(match[1]));
  }
  return found;
}

const intervalUnits = (text, options) => new Set(intervalMatches(text, options).map(entry => entry.unit));

/** The rate intervals a sentence claims ("per hour" claims hour) with the words that claim them, as intervalFindings compares them. */
export function claimedIntervals(sentence) {
  return intervalMatches(sentence, { evidenceSide: false });
}

/** The rate intervals a cited quote states, as intervalFindings reads them: a quote that states none gives nothing to compare with. */
export function statedIntervals(quote) {
  return intervalMatches(evidenceBody(quote), { evidenceSide: true });
}

// A number a few words before an interval: "200 refund requests per hour",
// "$2M per year", "twelve audits each quarter". The interval then makes the
// number a RATE, which is a stronger claim than the total the number states.
// Only a COUNT becomes a rate this way: a currency amount or a percentage
// beside an interval is the figure gate's, and a typed metric row records a
// figure without the interval its achievement states it per.
const COUNT_BEFORE_INTERVAL = new RegExp(String.raw`(?:(?<![$€£¥₹\d.,])\d[\d,.]*(?![\d,.]|\s*%)(?:\s*(?:[kmb]\b|thousand|million|billion))?|(?<![\p{L}\p{N}])(?:${NUMBER_WORD}|hundred|thousand|million|billion|dozen)(?![\p{L}\p{N}]))(?:\s+(?:[\p{L}'-]+|\d[\d,.]*)){0,5}\s+$`, 'iu');
const RATE_TIME_UNITS = new Set(TIME_UNIT.split('|'));

/** Is this claimed interval attached to a number in the same phrase (a rate, not a cadence)? */
function intervalBindsCount(text, start) {
  const head = String(text ?? '').slice(0, start).split(/[.,;:!?()]|\s[—–]\s/u).pop() || '';
  return COUNT_BEFORE_INTERVAL.test(` ${head}`);
}

/** Rate intervals ("per hour", "each quarter") the cited quotes never state. */
export function intervalFindings(sentence, bodies) {
  const matches = intervalMatches(sentence, { evidenceSide: false });
  if (!matches.length) return [];
  const claimed = new Set(matches.map(entry => entry.unit));
  const stated = new Set(bodies.flatMap(body => [...intervalUnits(body, { evidenceSide: true })]));
  // A quote that states no interval at all (a typed metric row, a bare count)
  // gives nothing to compare a CADENCE with ("I closed the books each
  // quarter"); the defect read then is an interval the evidence states
  // differently ("per shift" restated as "per hour"). An interval attached to a
  // number is different: it turns the quote's total into a rate ("200 refund
  // requests" restated as "200 refund requests per hour"), so a quote that
  // states no interval for it does not support it.
  if (!stated.size) {
    const lower = String(sentence ?? '').toLowerCase();
    const bound = new Set(matches.filter(entry => RATE_TIME_UNITS.has(entry.unit) && intervalBindsCount(lower, entry.start)).map(entry => entry.unit));
    return [...bound].map(unit => ({ code: 'interval', term: `per ${unit}`, rate: true }));
  }
  return [...claimed].filter(unit => !stated.has(unit)).map(unit => ({ code: 'interval', term: `per ${unit}` }));
}

// ---------------------------------------------------------------------------
// Scale words and comparative magnitudes
// ---------------------------------------------------------------------------

const BULK = [
  { word: 'dozens', re: /\bdozens\s+of\b/giu, minimum: 24 },
  { word: 'hundreds', re: /\bhundreds\s+of\b(?!\s+thousands?)/giu, minimum: 100 },
  { word: 'thousands', re: /\b(?<!tens\s+of\s)(?<!hundreds\s+of\s)thousands\s+of\b/giu, minimum: 1e3 },
  { word: 'tens of thousands', re: /\btens\s+of\s+thousands\b/giu, minimum: 2e4 },
  { word: 'hundreds of thousands', re: /\bhundreds\s+of\s+thousands\b/giu, minimum: 2e5 },
  { word: 'millions', re: /\bmillions\s+of\b/giu, minimum: 1e6 },
  { word: 'billions', re: /\bbillions\s+of\b/giu, minimum: 1e9 },
  { word: 'trillions', re: /\btrillions\s+of\b/giu, minimum: 1e12 },
];

function countValues(bodies) {
  return bodies.flatMap(body => extractQuantities(body, { permissive: true }))
    .filter(found => !(Number.isInteger(found.value) && found.value >= 1900 && found.value <= 2100 && !/[,kmb]/iu.test(found.raw)))
    .map(found => found.value);
}

/** "millions of", "thousands of", ...: the evidence must state a count that large, or the same bulk word. */
export function assessBulkQuantity(sentence, bodies) {
  const values = countValues(bodies);
  for (const bulk of BULK) {
    for (const match of String(sentence ?? '').matchAll(bulk.re)) {
      const stated = bodies.some(body => new RegExp(bulk.re.source, 'iu').test(body)) || values.some(value => value >= bulk.minimum);
      if (!stated) return { match: match[0].trim() };
    }
  }
  return null;
}

const LARGE_SCALE_CLAIM = /\b(?:(?:enterprise|large|massive|web|internet|planet(?:ary)?|industrial|mass|global|national)[- ]scale|enterprise[- ](?:grade|level|class))\b/giu;
const LARGE_SCALE_EVIDENCE = /\b(?:(?:enterprise|large|larger|massive|web|internet|planet(?:ary)?|industrial|mass|global|national|district|company|organi[sz]ation|regional|significant|full|production)[- ]scale|enterprise[- ](?:grade|level|class)|at\s+(?:(?:the|a|an)\s+)?(?:\p{L}+\s+)?scale)\b/iu;
const VOLUME_CLAIM = /\b(?:high[- ](?:volume|throughput|traffic|load|velocity)|(?:large|massive|heavy|high)\s+volumes?)\b/giu;
const VOLUME_EVIDENCE = /\b(?:high[- ](?:volume|throughput|traffic|load|velocity)|(?:large|larger|massive|heavy|high)\s+volumes?)\b/iu;
const GLOBAL_CLAIM = /\b(?:global(?:ly)?|worldwide|world-wide|multinational|(?:around|across)\s+the\s+(?:world|globe))\b/giu;
const GLOBAL_EVIDENCE = /\b(?:global(?:ly)?|worldwide|world-wide|multinational|international(?:ly)?|(?:around|across)\s+the\s+(?:world|globe))\b/iu;
const NATIONAL_CLAIM = /\b(?:nationwide|nation-wide|countrywide|across\s+the\s+country|coast[- ]to[- ]coast)\b/giu;
const NATIONAL_EVIDENCE = /\b(?:nationwide|nation-wide|countrywide|national(?:ly)?|across\s+the\s+country|coast[- ]to[- ]coast)\b/iu;
const ORG_WIDE_WORDS = new Set(['district', 'company', 'organization', 'organisation', 'enterprise']);
const X_WIDE_CLAIM = /\b(?<x>state|city|county|campus|site|store|school|region|branch|hospital|plant|warehouse|building|office|team|shift|unit|ward|floor|division|department|facility|system|firm|agency|institution|university|network|nation|country|world)(?:[- ]|)wide\b/giu;

/** Large-scale, high-volume and geographic scope words the evidence must state in its own words. */
export function assessScaleWord(conceptId, sentence, bodies) {
  const text = String(sentence ?? '');
  const joined = bodies.join(' ');
  switch (conceptId) {
    case 'large-scale': {
      const match = text.match(LARGE_SCALE_CLAIM);
      return match && !LARGE_SCALE_EVIDENCE.test(joined) ? { match: match[0] } : null;
    }
    case 'high-volume': {
      const match = text.match(VOLUME_CLAIM);
      if (!match || VOLUME_EVIDENCE.test(joined)) return null;
      return countValues(bodies).some(value => value >= 1e3) ? null : { match: match[0] };
    }
    case 'geographic': {
      const global = text.match(GLOBAL_CLAIM);
      if (global && !GLOBAL_EVIDENCE.test(joined)) return { match: global[0] };
      const national = text.match(NATIONAL_CLAIM);
      if (national && !NATIONAL_EVIDENCE.test(joined)) return { match: national[0] };
      for (const found of text.matchAll(X_WIDE_CLAIM)) {
        const x = found.groups.x.toLowerCase();
        if (ORG_WIDE_WORDS.has(x)) continue;
        if (x === 'nation' || x === 'country') { if (!NATIONAL_EVIDENCE.test(joined)) return { match: found[0] }; continue; }
        if (x === 'world') { if (!GLOBAL_EVIDENCE.test(joined)) return { match: found[0] }; continue; }
        const evidence = new RegExp(String.raw`\b(?:${escapeRegExp(x)}[- ]?wide|(?:entire|whole)\s+${escapeRegExp(x)}|across\s+(?:the|our|its|all|every|each)\s+(?:entire\s+|whole\s+)?${escapeRegExp(x)}s?|throughout\s+(?:the|our|its)\s+(?:entire\s+|whole\s+)?${escapeRegExp(x)}|all\s+${escapeRegExp(x)}s)\b`, 'iu');
        if (!evidence.test(joined)) return { match: found[0] };
      }
      return null;
    }
    default:
      return null;
  }
}

const SPELLED_MULTIPLE = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twenty: 20, hundred: 100, thousand: 1000 };
const FRACTION_WORDS = { half: [1, 2], halves: [1, 2], third: [1, 3], thirds: [1, 3], quarter: [1, 4], quarters: [1, 4], fifth: [1, 5], fifths: [1, 5], sixth: [1, 6], sixths: [1, 6], eighth: [1, 8], eighths: [1, 8], tenth: [1, 10], tenths: [1, 10] };
const NUMERATOR = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };

function magnitudeKeys(rawText) {
  const text = String(rawText ?? '').toLowerCase().replace(APOSTROPHES, "'");
  const keys = new Map();
  const add = (key, match) => { if (!keys.has(key)) keys.set(key, match); };
  for (const match of text.matchAll(/\b(?:doubl(?:ed|ing|es)|double\s+(?:the|its|their|our|your|a|an|\d)|two-?fold|twice\s+as\s+\p{L}+|two\s+times\s+(?:as|the|more)|2(?:x|×)(?![\p{L}\p{N}]))/gu)) add('x2', match[0]);
  for (const match of text.matchAll(/\b(?:tripl(?:ed|ing|es)|triple\s+(?:the|its|their|our|your|a|an|\d)|three-?fold|thrice|three\s+times|3(?:x|×)(?![\p{L}\p{N}]))/gu)) add('x3', match[0]);
  for (const match of text.matchAll(/\b(?:quadrupl(?:ed|ing|es)|four-?fold|four\s+times|4(?:x|×)(?![\p{L}\p{N}]))/gu)) add('x4', match[0]);
  for (const match of text.matchAll(/\b(?:ten-?fold|ten\s+times|10(?:x|×)(?![\p{L}\p{N}]))/gu)) add('x10', match[0]);
  for (const match of text.matchAll(/\b(?<word>five|six|seven|eight|nine|twenty|hundred|thousand)-?fold\b/gu)) add(`x${SPELLED_MULTIPLE[match.groups.word]}`, match[0]);
  for (const match of text.matchAll(/\b(\d+(?:\.\d+)?)(?:x|×|\s+times(?!\s+\d))(?![\p{L}\p{N}])/gu)) add(`x${Number(match[1])}`, match[0]);
  // A fraction is a COMPARATIVE magnitude only in a comparative frame: "by
  // half", "cut in half", "halved", "by a third", "to one quarter of", "a third
  // faster". The same words are just as often an ordinal or a cadence ("the
  // third consecutive audit", "each quarter", "the third quarter",
  // "third-party"), which state no magnitude at all, so a bare fraction word is
  // read on neither side. A fraction OF something ("half the team", "a third of
  // the stores") is a PORTION: a different claim, which a comparison does not
  // state ("trained half the team" is no evidence of "halved onboarding time").
  for (const match of text.matchAll(/\b(?:halv(?:ed|ing|es)|by\s+half|in\s+half|to\s+half)\b/gu)) add('fraction:1/2', match[0]);
  for (const match of text.matchAll(/\bhalf\s+(?:the|its|their|of|our|his|her|a|an)\b/gu)) add('portion:1/2', match[0]);
  const reduce = (a, b) => { let x = a; let y = b; while (y) [x, y] = [y, x % y]; return [a / x, b / x]; };
  const fractionOf = groups => {
    const [num, den] = FRACTION_WORDS[groups.f] || [1, 1];
    return reduce(groups.n ? NUMERATOR[groups.n] : num, den);
  };
  const FRACTION = String.raw`(?:(?<n>a|one|two|three|four|five|six|seven|eight|nine)[-\s]+)?(?<f>thirds?|quarters?|fifths?|sixths?|eighths?|tenths?)`;
  // After the fraction, a comparative frame ends or compares; a noun after it ("a third shift", "to a fourth site") is an ordinal.
  const COMPARATIVE_TAIL = String.raw`(?=\s*(?:$|[.,;:!?)\]—–]|\s(?:of|in|on|over|from|since|compared|versus|vs|than|within|while|and|or|but|after|before|across|through|for|with|at|by|year-over-year|less|more|fewer|faster|slower|lower|higher|cheaper|smaller|larger|shorter|longer|quicker|sooner)\b))`;
  for (const match of text.matchAll(new RegExp(String.raw`\b(?:by|to)\s+${FRACTION}${COMPARATIVE_TAIL}`, 'gu'))) {
    const [a, b] = fractionOf(match.groups);
    add(`fraction:${a}/${b}`, match[0]);
  }
  for (const match of text.matchAll(new RegExp(String.raw`\b(?<n>a|one|two|three|four|five|six|seven|eight|nine)[-\s]+(?<f>thirds?|quarters?|fifths?|sixths?|eighths?|tenths?)\s+(?:less|more|fewer|faster|slower|lower|higher|cheaper|smaller|larger|shorter|longer|quicker|sooner)\b`, 'gu'))) {
    const [a, b] = fractionOf(match.groups);
    add(`fraction:${a}/${b}`, match[0]);
  }
  for (const match of text.matchAll(new RegExp(String.raw`(?<!\b(?:by|to)\s)\b(?<n>a|one|two|three|four|five|six|seven|eight|nine)[-\s]+(?<f>thirds?|quarters?|fifths?|sixths?|eighths?|tenths?)\s+of\b`, 'gu'))) {
    const [a, b] = fractionOf(match.groups);
    add(`portion:${a}/${b}`, match[0]);
  }
  for (const match of text.matchAll(/\borders?\s+of\s+magnitude\b/gu)) add('orders', match[0]);
  return keys;
}

/** The percent figures a text states, for fraction equivalence ("by half" is "by 50%"). */
function percentFigures(rawText) {
  return [...String(rawText ?? '').matchAll(/(\d+(?:\.\d+)?)\s*(?:%|percent\b|per\s*cent\b)/giu)].map(match => Number(match[1]));
}

const CLAIM_MAGNITUDE_RE = /\b(?:doubl(?:ed|ing|es)|double\s+(?:the|its|their|our|your|a|an|\d)|two-?fold|twice\s+as\s+\p{L}+|two\s+times\s+(?:as|the|more)|tripl(?:ed|ing|es)|triple\s+(?:the|its|their|our|your|a|an|\d)|three-?fold|thrice|quadrupl(?:ed|ing|es)|four-?fold|ten-?fold|(?:five|six|seven|eight|nine|twenty|hundred|thousand)-?fold|halv(?:ed|ing|es)|by\s+half|in\s+half|to\s+half|half\s+(?:the|its|their|of|our|his|her|a|an)|(?:by|to)\s+(?:(?:a|one|two|three|four|five|six|seven|eight|nine)[-\s]+)?(?:thirds?|quarters?|fifths?|sixths?|eighths?|tenths?)\b|(?:a|one|two|three|four|five|six|seven|eight|nine)[-\s]+(?:thirds?|quarters?|fifths?|sixths?|eighths?|tenths?)\s+(?:of|less|more|fewer|faster|slower|lower|higher|cheaper|smaller|larger|shorter|longer|quicker|sooner)\b|orders?\s+of\s+magnitude)/giu;

/** Comparative magnitudes ("doubled", "by half", "tenfold") need the same comparison, or a figure that is the same comparison, in the evidence. */
export function assessComparativeMagnitude(sentence, bodies) {
  const claimKeys = [...magnitudeKeys(sentence).entries()];
  if (!claimKeys.length) return null;
  const evidenceKeys = new Set();
  const percents = [];
  for (const body of bodies) {
    for (const key of magnitudeKeys(body).keys()) evidenceKeys.add(key);
    percents.push(...percentFigures(body));
  }
  for (const [key, matched] of claimKeys) {
    if (evidenceKeys.has(key)) continue;
    // "half the time" can be a comparison as well as a portion, so a stated comparison supports it; never the reverse.
    if (key.startsWith('portion:') && evidenceKeys.has(key.replace('portion:', 'fraction:'))) continue;
    const fraction = /^(?:fraction|portion):(\d+)\/(\d+)$/u.exec(key);
    if (fraction) {
      const pct = (Number(fraction[1]) / Number(fraction[2])) * 100;
      if (percents.some(value => Math.abs(value - pct) <= 1 || Math.abs(value - (100 - pct)) <= 1)) continue;
    }
    const wording = String(sentence).match(CLAIM_MAGNITUDE_RE)?.find(candidate => new RegExp(`${escapeRegExp(String(matched).split(/\s+/u)[0])}`, 'iu').test(candidate));
    return { match: wording || matched };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Credentials, calendar years, appended clauses
// ---------------------------------------------------------------------------

const CREDENTIAL_GROUPS = [
  { group: 'licence', re: /\b(?:licen[sc](?:e|es|ed|ure|ing))\b/giu },
  { group: 'certification', re: /\b(?:certif(?:y|ies|ied|ication|ications|icate|icates)|board-certified)\b/giu },
  { group: 'accreditation', re: /\b(?:accredit(?:ed|ation|ations))\b/giu },
  { group: 'academic', re: /\b(?:diploma|bachelor(?:'s)?|master(?:'s)\b|master\s+of|doctorate|doctoral|ph\.?d\.?|mba|associate(?:'s)?\s+degree)\b|(?<!(?:high|great|large|significant|certain|fair|varying|some|any)\s)\b(?<!\d\s)\bdegrees?\b(?!\s+of\b)/giu },
];
const CREDENTIAL_ANY = /\bcredential(?:s|ed)?\b/iu;
const CREDENTIAL_EVIDENCE = {
  licence: /\blicen[sc](?:e|es|ed|ure|ing)\b/iu,
  certification: /\b(?:certif(?:y|ies|ied|ication|ications|icate|icates)|board-certified)\b/iu,
  accreditation: /\baccredit(?:ed|ation|ations)\b/iu,
};

// A degree is matched to a degree of the SAME LEVEL in the evidence, stated as
// a degree: "master data", "a sales associate", "a 360-degree review" and "a
// high degree of" state no degree at all, and a bachelor's is not a master's.
// Each level lists the ways a record writes it (the word, "<level> of", and the
// dotted or run-together letters, which are matched case-sensitively).
const DEGREE_LEVELS = [
  { level: 'associate', words: /\bassociate(?:'s|s)?\s+(?:degree|of\s+(?:arts|science|applied))\b/iu, letters: /(?<![\p{L}.])(?:A\.A\.S?\.|A\.S\.|AAS)(?![\p{L}])/u },
  // Two bare capitals ("BS", "MS", "MA") are as often a product, a place or a
  // title as a degree ("MS Excel"), so only their dotted forms are read.
  { level: 'bachelor', words: /\bbachelor(?:'s|s)?\b|\bbaccalaureate\b/iu, letters: /(?<![\p{L}.])(?:B\.(?:S|A|Sc|Eng|Com|Ed|F\.A|B\.A|S\.N|Tech)\.|BSc|BEng|BCom|BBA|BFA|BSN|BTech)(?![\p{L}])/u },
  { level: 'master', words: /\bmaster(?:'s|s)?\s+(?:degree|of|in|programme|program)\b|\bmaster's\b/iu, letters: /(?<![\p{L}.])(?:M\.(?:S|A|Sc|Eng|Ed|B\.A|P\.H|F\.A|S\.N|Phil)\.|MSc|MEng|MBA|MPH|MFA|MEd|MPA|MSN|MPhil|LLM)(?![\p{L}])/u },
  { level: 'doctorate', words: /\bdoctora(?:te|l)\b|\bph\.?\s?d\b/iu, letters: /(?<![\p{L}.])(?:Ph\.?D\.?|DPhil|EdD|PsyD|DNP|J\.D\.|M\.D\.|DVM|DDS)(?![\p{L}])/u },
  { level: 'diploma', words: /\bdiploma\b/iu, letters: null },
];
// "degree" as a credential, not an angle, an extent or a temperature.
const DEGREE_WORD = /(?<!\b(?:high|great|large|significant|certain|fair|varying|some|any|lesser|small|considerable)\s)(?<![\d-]\s?)\bdegrees?\b(?!\s+of\b)(?![-\s]*(?:celsius|fahrenheit|angle|turn|view|feedback|review))/iu;
// The specific degree named by its letters ("an MBA") is that degree, which a
// statement of another degree of the same level does not state.
const NAMED_DEGREE = /(?<![\p{L}.])(MBA|MPH|MFA|MSN|BSN|LLM)(?![\p{L}])/u;

function degreeLevelsIn(text) {
  const value = String(text ?? '').replace(APOSTROPHES, "'");
  return new Set(DEGREE_LEVELS.filter(entry => entry.words.test(value) || (entry.letters && entry.letters.test(value))).map(entry => entry.level));
}

// Words that say nothing about WHICH credential: the verbs of holding one, the
// article, the candidate. Everything else near the credential word is its
// object ("PMP certification", "certified in food safety", "licensed practical nurse").
const CREDENTIAL_NEIGHBOUR_SKIP = new Set(['a', 'an', 'the', 'my', 'our', 'i', 'we', 'me', 'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has',
  'had', 'hold', 'holds', 'held', 'holding', 'earn', 'earned', 'earning', 'obtain', 'obtained', 'receive', 'received', 'complete', 'completed', 'achieve',
  'achieved', 'award', 'awarded', 'gain', 'gained', 'current', 'currently', 'active', 'valid', 'maintain', 'maintained', 'pass', 'passed', 'also',
  'and', 'or', 'with', 'as', 'by', 'of', 'in', 'on', 'for', 'to', 'from', 'at', 'while', 'who', 'which', 'that', 'this', 'its', 'their', 'full', 'fully',
  'certification', 'certifications', 'certified', 'certificate', 'certificates', 'certify', 'licence', 'license', 'licensed', 'licenses', 'licences',
  'licensure', 'accredited', 'accreditation', 'credential', 'credentials', 'since', 'year', 'years']);
const CREDENTIAL_NEIGHBOURS = 3;

/** The content words beside a credential word, within its phrase (no punctuation between), `reach` on each side, as stems. */
function credentialNeighbours(text, index, length, reach) {
  const value = String(text ?? '');
  const phraseBreak = /[.;:!?,()[\]]/u;
  let from = index;
  while (from > 0 && !phraseBreak.test(value[from - 1])) from -= 1;
  let to = index + length;
  while (to < value.length && !phraseBreak.test(value[to])) to += 1;
  const content = fragment => (fragment.toLowerCase().match(/[\p{L}\p{N}]+(?:'\p{L}+)?/gu) || [])
    .map(word => word.replace(/'s$/u, ''))
    .filter(word => !CREDENTIAL_NEIGHBOUR_SKIP.has(word) && !/^\d/u.test(word));
  const picked = [...content(value.slice(from, index)).slice(-reach), ...content(value.slice(index + length, to)).slice(0, reach)];
  return new Set(picked.map(relatednessStem));
}

/**
 * A licence, certification or accreditation claim is supported only by a quote
 * that records a credential of the same kind FOR THE SAME THING: a word next to
 * the claim's credential word ("PMP", "food safety", "practical nurse") must sit
 * next to the quote's credential word too. "Certified forklift operators" does
 * not state a PMP certification. A claim whose credential word names nothing
 * ("I hold a certification") needs only the same kind.
 */
function credentialStated(group, sentence, match, bodies) {
  const evidenceRe = CREDENTIAL_EVIDENCE[group];
  const wanted = credentialNeighbours(sentence, match.index, match[0].length, CREDENTIAL_NEIGHBOURS);
  return bodies.some(body => {
    const global = new RegExp(evidenceRe.source, 'giu');
    for (const found of String(body).replace(APOSTROPHES, "'").matchAll(global)) {
      if (!wanted.size) return true;
      const near = credentialNeighbours(String(body).replace(APOSTROPHES, "'"), found.index, found[0].length, CREDENTIAL_NEIGHBOURS + 1);
      if ([...wanted].some(stem => near.has(stem))) return true;
    }
    return false;
  });
}

/**
 * A degree claim is supported only by a quote that states a degree of the same
 * level ("bachelor's" by a bachelor's or a B.S., never by "sales associate" or
 * "master data"), a degree named by its letters ("an MBA") by that same degree,
 * and the bare word "degree" by a quote that states any degree.
 */
function degreeStated(claimText, bodies) {
  const evidence = bodies.map(body => String(body).replace(APOSTROPHES, "'"));
  const claimLevels = degreeLevelsIn(claimText);
  const named = NAMED_DEGREE.exec(claimText)?.[1];
  if (named && !evidence.some(body => new RegExp(`(?<![\\p{L}.])${named}(?![\\p{L}])`, 'u').test(body)
    || (named === 'MBA' && /\bmaster\s+of\s+business\s+administration\b/iu.test(body)))) return named;
  for (const level of claimLevels) {
    if (!evidence.some(body => degreeLevelsIn(body).has(level))) return level;
  }
  if (!claimLevels.size && DEGREE_WORD.test(claimText) && !evidence.some(body => degreeLevelsIn(body).size || DEGREE_WORD.test(body))) return 'degree';
  return null;
}

/** Licence, certification, accreditation and degree wording the cited quotes never record. */
export function credentialFindings(sentence, bodies) {
  const text = String(sentence ?? '').replace(APOSTROPHES, "'");
  const joined = bodies.join(' ');
  const findings = [];
  for (const { group, re } of CREDENTIAL_GROUPS) {
    for (const match of text.matchAll(re)) {
      // Commercial licensing terms describe a purchase arrangement, not a
      // professional qualification. Do not demand a personal credential for
      // evaluating a vendor's licensing costs or models.
      if (group === 'licence' && /^licen[sc]ing$/iu.test(match[0])
        && /^\s+(?:approaches|models|costs|fees|terms|agreements)\b/iu.test(text.slice(match.index + match[0].length))) continue;
      const unsupported = group === 'academic' ? Boolean(degreeStated(text, bodies)) : !credentialStated(group, text, match, bodies);
      if (unsupported) { findings.push({ code: 'credential', term: match[0] }); break; }
    }
  }
  if (!findings.length && CREDENTIAL_ANY.test(text)) {
    const anyStated = Object.values(CREDENTIAL_EVIDENCE).some(re => re.test(joined)) || bodies.some(body => degreeLevelsIn(body).size > 0);
    if (!anyStated && !CREDENTIAL_ANY.test(joined)) findings.push({ code: 'credential', term: 'credential' });
  }
  return findings;
}

const MONTH_NAMES = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec';
const YEAR_RE = '(?:19|20)\\d{2}';

/** Calendar years a sentence dates its work with: after a temporal word, in a range, or after a month. */
export function statedYears(rawText) {
  const text = String(rawText ?? '');
  const years = [];
  const add = (year, raw) => { const value = Number(year); if (!years.some(entry => entry.year === value)) years.push({ year: value, raw }); };
  for (const match of text.matchAll(new RegExp(String.raw`\b(?:in|since|from|during|until|till|through|between|by|starting|beginning|ending|circa|around|as\s+of|back\s+in|of)\s+(?:(?:early|late|mid|the\s+(?:summer|fall|autumn|winter|spring)\s+of|the\s+(?:end|start|beginning)\s+of)[-\s]+)?(${YEAR_RE})\b(?!\s*(?:%|x\b|\d))`, 'giu'))) add(match[1], match[0]);
  for (const match of text.matchAll(new RegExp(String.raw`\b(${YEAR_RE})\s*(?:[–—-]|to|through|until|and)\s*(${YEAR_RE}|present|now|current|today)\b`, 'giu'))) {
    add(match[1], match[0]);
    if (/^\d/u.test(match[2])) add(match[2], match[0]);
  }
  for (const match of text.matchAll(new RegExp(String.raw`\b(?:${MONTH_NAMES})\.?\s*,?\s*(${YEAR_RE})\b`, 'giu'))) add(match[1], match[0]);
  return years;
}

/** Years the sentence dates its work with that no quote states and no approved role's own dates state. */
export function yearFindings(sentence, bodies, ctx) {
  const claimed = statedYears(sentence);
  if (!claimed.length) return [];
  const quoteYears = new Set(bodies.flatMap(body => [...String(body).matchAll(new RegExp(`(?<![\\p{L}\\p{N}])(${YEAR_RE})(?![\\p{L}\\p{N}])`, 'gu'))].map(match => Number(match[1]))));
  const trusted = new Set((ctx.trustedYears || []).map(Number));
  return claimed
    .filter(({ year }) => !quoteYears.has(year) && !trusted.has(year))
    .map(({ year, raw }) => ({ code: 'year', term: String(year), raw }));
}

const CLAUSE_SPLIT = /;|,?\s+(?:and|but|while|then|so)\s+(?=(?:I|we)\b|[\p{L}]+(?:ed|ing)\b)|,\s+(?=[\p{L}]+ing\b)|,\s+(?:which|where|thereby|resulting|allowing|enabling)\b/gu;

/** A coordinated or trailing clause that shares nothing with the quotes is appended work, not a restatement of the cited work. */
export function clauseFindings(sentence, bodies, ctx) {
  const parts = String(sentence ?? '').split(CLAUSE_SPLIT).map(part => part.trim()).filter(Boolean);
  if (parts.length < 2) return [];
  const available = new Set(bodies.flatMap(body => ctx.meaningful(body)).map(lightStem));
  const findings = [];
  for (const part of parts.slice(1)) {
    // A caller may exempt a clause that states no work at all (one that only addresses the target); it decides which.
    if (typeof ctx.exemptClause === 'function' && ctx.exemptClause(part, String(sentence ?? ''))) continue;
    const tokens = ctx.meaningful(part);
    if (tokens.length >= 2 && !tokens.some(token => available.has(lightStem(token)))) findings.push({ code: 'clause', term: clip(part) });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Which cited quote a clause is about (sentence-local support)
// ---------------------------------------------------------------------------
//
// A paragraph cites up to four quotes, and judging a claim against all of them
// lets a sentence borrow a qualifier, figure, count, name or ownership word from
// a quote that is about OTHER work merely because that quote is cited in the
// same paragraph. The proportion limits make merged paragraphs the normal
// shape, so the borrowing has to be closed without rejecting the sentence that
// truthfully blends two proofs. The unit of "the same work" is the CLAUSE that
// carries the claim: a sentence is cut where it coordinates ("..., and I
// shared the report ..."), each flagged token is judged against the quotes that
// clause is about, and the quote that states it for other work is named in the
// rejection. Three facts make that satisfiable by construction:
//
//   - The terms that decide relatedness are stems (outage and outages are one
//     term; managed and manage are one), and the ownership verb and any tool
//     name COUNT: they identify the work. Only the claim's own words (a
//     qualifier, a figure, an interval) are left out, because stating "daily" is
//     what a quote must do to support "daily", not evidence that it is about the
//     same work.
//   - The best-sharing quote is always related. Another quote is related when
//       (a) it shares at least half as many terms as the best one AND covers
//           nearly as much of the clause (a second statement of the same work)
//           or at least MIN_LOCAL_QUOTE_DISTINCT_TERMS terms the best quote does
//           not (it states a distinct part of the clause), or
//       (b) it is made almost entirely of the best quote's own terms, or says the
//           same thing in the same words for MIN_LOCAL_QUOTE_SHARED_RUN
//           consecutive terms (the same work, in more detail).
//     A quote that shares only the subject matter the cited quotes have in common
//     (the same records, the same database) states nothing distinct about the
//     clause and is not related.
//   - When the clause gives no basis (it shares too little with every quote), the
//     best-sharing quotes stand in, and when it shares nothing, every quote stays:
//     the earlier behaviour for a sentence the unit-level floor already judged.
export const MIN_LOCAL_QUOTE_SHARED_TERMS = 2;
export const LOCAL_QUOTE_SHARE_FRACTION = 0.5;
export const LOCAL_QUOTE_NEAR_DUPLICATE_FRACTION = 0.8;
export const MIN_LOCAL_QUOTE_DISTINCT_TERMS = 2;
export const LOCAL_QUOTE_CONTAINMENT_FRACTION = 0.8;
export const MIN_LOCAL_QUOTE_SHARED_RUN = 5;

/** One stem per word family for relatedness only (outage/outages, managed/manage, planning/plans). */
export function relatednessStem(token) {
  let word = String(token ?? '').toLowerCase().replace(/'s$/u, '');
  if (word.length <= 3 || !/\p{L}/u.test(word)) return word;
  if (word.length > 4 && word.endsWith('ies')) word = `${word.slice(0, -3)}y`;
  else if (/(?:ss|sh|ch|x|z)es$/u.test(word)) word = word.slice(0, -2);
  else if (word.endsWith('s') && !/(?:ss|us|is)$/u.test(word)) word = word.slice(0, -1);
  if (word.length > 5 && word.endsWith('ing')) word = word.slice(0, -3);
  else if (word.length > 4 && word.endsWith('ed')) word = word.slice(0, -2);
  if (word.length > 3 && word.endsWith('e')) word = word.slice(0, -1);
  if (word.length > 3 && /([^aeiou\d])\1$/u.test(word) && !/(?:ll|ss|zz)$/u.test(word)) word = word.slice(0, -1);
  return word;
}

// A closed list of irregular and base-form verbs that open a coordinated clause
// ("... and wrote the runbook", "... and hold a licence"). A regular verb ends
// in -ed or -ing; a word the cited quotes themselves open a statement with is
// a verb too (verbHints). Words that are as often nouns (support, report,
// review, plan) are deliberately absent: a missed cut only widens a clause.
const CLAUSE_OPENING_VERBS = new Set([
  'built', 'wrote', 'led', 'ran', 'kept', 'held', 'made', 'took', 'gave', 'got', 'set', 'put', 'cut', 'sent', 'taught', 'chose', 'began',
  'won', 'spent', 'drove', 'found', 'met', 'paid', 'sold', 'told', 'brought', 'thought', 'understood', 'grew', 'drew', 'rose', 'lost', 'left',
  'saw', 'knew', 'became', 'fed', 'hold', 'lead', 'run', 'build', 'write', 'keep', 'make', 'take', 'give', 'get', 'send', 'teach', 'choose',
  'own', 'manage', 'coach', 'train', 'mentor', 'maintain', 'deliver', 'create', 'develop', 'analyze', 'analyse', 'monitor', 'oversee',
  'supervise', 'organize', 'organise', 'prepare', 'produce', 'provide', 'serve', 'hire', 'handle', 'schedule', 'track', 'ship', 'launch',
]);
const CLAUSE_OPENING_ADVERBS = new Set(['also', 'then', 'later', 'now', 'still', 'always', 'never', 'personally', 'currently', 'just', 'even', 'once', 'often']);
const CLAUSE_SUBJECT_WORDS = new Set(['i', 'we', 'he', 'she', 'they', 'it', 'you']);
const CLAUSE_BOUNDARY_RE = /\s*;\s*|\s+[—–]\s+|:\s+|,?\s+(?:and|but|then|while|so|yet)\s+/giu;

function opensClause(rest, verbHints, afterComma) {
  const words = String(rest ?? '').match(/[\p{L}][\p{L}'’-]*/gu)?.slice(0, 3).map(word => word.toLowerCase().replace(/’/gu, "'")) || [];
  let position = 0;
  while (position < words.length - 1 && (CLAUSE_OPENING_ADVERBS.has(words[position]) || (words[position].length > 4 && words[position].endsWith('ly')))) position += 1;
  const word = words[position];
  if (!word) return false;
  if (CLAUSE_SUBJECT_WORDS.has(word)) return true;
  if (word.length > 3 && word.endsWith('ed')) return true;
  // "and billing records" is a noun phrase; ", and managing the budget" is a clause.
  if (word.length > 4 && word.endsWith('ing')) return afterComma;
  return CLAUSE_OPENING_VERBS.has(word) || (verbHints instanceof Set && verbHints.has(word));
}

/** The words the cited quotes open a statement with, which are verbs in career data ("Built ...", "Led ...", "Coached ..."). */
export function quoteVerbHints(bodies) {
  const hints = new Set();
  for (const body of bodies) {
    for (const match of String(body ?? '').matchAll(/(?:^|[.;]\s+)(?<word>[\p{L}][\p{L}'-]*)/gu)) hints.add(match.groups.word.toLowerCase());
  }
  return hints;
}

/**
 * The clauses of a sentence, cut where it coordinates a new statement: ";", a
 * dash, a colon, or "and"/"but"/"then"/"while"/"so" followed by a subject or a
 * verb. A relative or participial modifier ("..., cutting effort by 40%", "that
 * loads records") stays with the clause it modifies, because its figure or
 * qualifier is a statement about that clause's work. A list ("Python, SQL, and
 * Tableau") is not cut. Offsets index the original sentence.
 */
export function groundingClauses(sentence, verbHints = null) {
  const text = String(sentence ?? '');
  const clauses = [];
  let start = 0;
  for (const match of text.matchAll(CLAUSE_BOUNDARY_RE)) {
    // Punctuation always cuts; a coordinator cuts only when a new statement follows it.
    const punctuation = !/\p{L}/u.test(match[0]);
    const end = match.index + match[0].length;
    if (!punctuation && !opensClause(text.slice(end), verbHints, match[0].trimStart().startsWith(','))) continue;
    // "I tracked and prepared them weekly" coordinates two verbs that share one complement: a part with
    // nothing but a subject and a verb in it has no work of its own to be judged against.
    if (!punctuation && relatednessTerms(text.slice(start, match.index)).length < 2) continue;
    if (match.index > start) clauses.push({ start, end: match.index });
    start = end;
  }
  if (start < text.length) clauses.push({ start, end: text.length });
  const result = clauses.map(({ start: from, end: to }) => ({ start: from, end: to, text: text.slice(from, to).trim() })).filter(clause => clause.text);
  return result.length ? result : [{ start: 0, end: text.length, text: text.trim() }];
}

/** The clause indexes whose text contains a term (case-insensitive); empty when the term is not written in the sentence. */
export function clauseIndexesContaining(sentence, clauses, term) {
  const needle = String(term ?? '').toLowerCase().replace(/\s+/gu, ' ').trim();
  if (!needle) return [];
  const haystack = String(sentence ?? '').toLowerCase();
  const found = new Set();
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const index = clauses.findIndex(clause => at >= clause.start && at < clause.end);
    if (index !== -1) found.add(index);
  }
  return [...found].sort((left, right) => left - right);
}

// The words that say nothing about WHICH work a statement is about: function
// words, and the filler verbs every statement of work uses. Ownership and
// authorship verbs (led, managed, owned, built, designed) are NOT here: they
// identify the work, so a clause and a quote that share one share evidence.
const RELATEDNESS_SKIP = new Set([
  'a', 'about', 'after', 'all', 'also', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'both', 'but', 'by', 'each', 'for', 'from',
  'had', 'has', 'have', 'he', 'her', 'his', 'i', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'our', 'she', 'so', 'that',
  'the', 'their', 'them', 'then', 'these', 'they', 'this', 'those', 'through', 'to', 'was', 'we', 'were', 'which', 'who', 'will', 'with',
  'within', 'would', 'you', 'your', 'work', 'worked', 'use', 'used', 'using', 'help', 'helped', 'provide', 'provided', 'make', 'made',
]);

/** The stems of the terms of a text that identify its work (see RELATEDNESS_SKIP), counted once each. */
export function relatednessTerms(text) {
  return [...new Set(wordsOf(text)
    .filter(word => !RELATEDNESS_SKIP.has(word) && (word.length > 1 || /\d/u.test(word)))
    .map(relatednessStem)
    .filter(Boolean))];
}

// The stems of a text in reading order, function words dropped and any excluded
// term replaced by a mark that matches nothing, so a shared run cannot run through a claim's own words.
const contentSequence = (text, excluded) => wordsOf(text)
  .filter(word => !RELATEDNESS_SKIP.has(word) && (word.length > 1 || /\d/u.test(word)))
  .map(relatednessStem)
  .map(stem => (excluded.has(stem) ? null : stem));

/** The longest run of consecutive content terms two texts share (the same wording, not merely the same subject matter). */
function longestSharedRun(left, right) {
  let best = 0;
  let previous = new Array(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    const row = new Array(right.length + 1).fill(0);
    for (let j = 1; j <= right.length; j += 1) {
      if (left[i - 1] !== null && left[i - 1] === right[j - 1]) {
        row[j] = previous[j - 1] + 1;
        if (row[j] > best) best = row[j];
      }
    }
    previous = row;
  }
  return best;
}

/**
 * Which cited quotes a clause is about. `clauseText` is the clause (or the
 * sentence when it has no usable clause); `excludeText` holds the claim's own
 * words, which are left out of the comparison (stating "daily" is what a quote
 * must do to support "daily", not evidence that it is about the same work).
 * Returns { indexes, mode, shares }: mode is 'related' (the floor was reached),
 * 'best' (nothing reached it, so the best-sharing quotes stand in) or 'all' (the
 * clause shares nothing with any quote).
 */
export function relatedQuoteIndexes(clauseText, quotes, excludeText = '') {
  const excluded = new Set(relatednessTerms(excludeText));
  const stems = relatednessTerms(clauseText);
  const list = Array.isArray(quotes) ? quotes : [];
  const all = list.map((_, index) => index);
  const terms = list.map(quote => new Set(relatednessTerms(evidenceBody(quote)).filter(stem => !excluded.has(stem))));
  const clauseSequence = contentSequence(clauseText, excluded);
  const covered = terms.map(body => new Set(stems.filter(stem => body.has(stem))));
  const shares = covered.map(set => set.size);
  const best = Math.max(0, ...shares);
  if (best === 0) return { indexes: all, mode: 'all', shares };
  const bestSet = all.filter(index => shares[index] === best);
  if (best < MIN_LOCAL_QUOTE_SHARED_TERMS) return { indexes: bestSet, mode: 'best', shares };
  const bestCovered = new Set(bestSet.flatMap(index => [...covered[index]]));
  const bestTerms = new Set(bestSet.flatMap(index => [...terms[index]]));
  const floor = Math.max(MIN_LOCAL_QUOTE_SHARED_TERMS, Math.ceil(best * LOCAL_QUOTE_SHARE_FRACTION));
  const nearly = Math.ceil(best * LOCAL_QUOTE_NEAR_DUPLICATE_FRACTION);
  const indexes = all.filter(index => {
    if (bestSet.includes(index)) return true;
    if (shares[index] < MIN_LOCAL_QUOTE_SHARED_TERMS) return false;
    // A quote made almost entirely of the best quote's own terms restates (part of) the same work.
    const own = [...terms[index]];
    if (own.length && own.filter(stem => bestTerms.has(stem)).length >= Math.ceil(own.length * LOCAL_QUOTE_CONTAINMENT_FRACTION)) return true;
    // A quote that says the same thing in the same words, then goes on to say more, is the same work stated in more detail.
    if (longestSharedRun(clauseSequence, contentSequence(evidenceBody(list[index]), excluded)) >= MIN_LOCAL_QUOTE_SHARED_RUN) return true;
    return shares[index] >= floor
      && (shares[index] >= nearly || [...covered[index]].filter(stem => !bestCovered.has(stem)).length >= MIN_LOCAL_QUOTE_DISTINCT_TERMS);
  });
  return { indexes, mode: 'related', shares };
}

// A quote that is not the clause's best match can still state a claim FOR THE
// WORDS IT IS MADE ABOUT. "weekly" in "the weekly dashboard" is supported by a
// quote that says "a weekly dashboard", whatever the rest of the sentence is
// about; "twelve promotions" by a quote that analyzes twelve promotions; "in
// Snowflake" by a quote that loads the same database in Snowflake. The claim has
// to stand beside the same words in the quote as in the sentence. This is used
// only to rescue a claim the clause-level reading found borrowed, and it is not
// available to a figure or an ownership word, which are judged by the clause alone.
const around = (words, from, to, count, skipAfter = 0) => {
  const before = [];
  for (let at = from - 1; at >= 0 && before.length < count; at -= 1) if (!RELATEDNESS_SKIP.has(words[at].word)) before.push(words[at].word);
  const after = [];
  let skipped = 0;
  for (let at = to; at < words.length && after.length < count; at += 1) {
    if (RELATEDNESS_SKIP.has(words[at].word)) continue;
    if (skipped < skipAfter) { skipped += 1; continue; }
    after.push(words[at].word);
  }
  return [...before, ...after];
};
const positionedWords = text => [...String(text ?? '').toLowerCase().matchAll(WORD_RE)].map(match => ({ word: match[0], start: match.index, end: match.index + match[0].length }));

/**
 * Does a quote state the claim (sourceRegex) beside one of the words the sentence's claim (claimRegex) sits beside?
 * `skipAfter` leaves out that many content words right after the claim: the noun a count counts is the count's own, not a neighbour.
 */
export function statedBesideSameWords(claimText, claimRegex, sourceRegex, quote, { skipAfter = 0 } = {}) {
  const match = new RegExp(claimRegex.source, claimRegex.flags.replace('g', '')).exec(String(claimText ?? ''));
  if (!match) return false;
  const claimWords = positionedWords(claimText);
  const inside = new Set(claimWords.filter(entry => entry.start >= match.index && entry.end <= match.index + match[0].length).map(entry => relatednessStem(entry.word)));
  const first = claimWords.findIndex(entry => entry.start >= match.index);
  const last = claimWords.findIndex(entry => entry.start >= match.index + match[0].length);
  const neighbours = new Set(around(claimWords, first === -1 ? claimWords.length : first, last === -1 ? claimWords.length : last, 2, skipAfter)
    .map(relatednessStem).filter(stem => !inside.has(stem)));
  if (!neighbours.size) return false;
  const body = evidenceBody(quote);
  const quoteWords = positionedWords(body);
  const global = new RegExp(sourceRegex.source, sourceRegex.flags.includes('g') ? sourceRegex.flags : `${sourceRegex.flags}g`);
  for (const found of body.matchAll(global)) {
    const from = quoteWords.findIndex(entry => entry.start >= found.index);
    const to = quoteWords.findIndex(entry => entry.start >= found.index + found[0].length);
    const lo = Math.max(0, (from === -1 ? quoteWords.length : from) - 3);
    const hi = Math.min(quoteWords.length, (to === -1 ? quoteWords.length : to) + 3);
    if (quoteWords.slice(lo, hi).some(entry => neighbours.has(relatednessStem(entry.word)))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// One call for the claim kinds that are not qualifier-table rows
// ---------------------------------------------------------------------------

/**
 * All claim-grounding findings for one sentence (or one whole bullet):
 * ungrounded names, tool-use strength, counts, rate intervals, credentials,
 * years, and appended clauses.
 */
export function claimGroundingFindings(sentence, quotes, ctx) {
  const bodies = (Array.isArray(quotes) ? quotes : []).map(evidenceBody).filter(Boolean);
  const text = String(sentence ?? '');
  return [
    ...namedTermFindings(text, bodies, ctx),
    ...quantityFindings(text, bodies, ctx),
    ...intervalFindings(text, bodies),
    ...credentialFindings(text, bodies),
    ...yearFindings(text, bodies, ctx),
    ...clauseFindings(text, bodies, ctx),
  ];
}

function describeQuantityFollower(finding) {
  return finding.follower ? ` (counting ${finding.follower})` : '';
}

/** The writer-facing sentence for one finding. */
export function describeClaimFinding(unit, finding, { targetCompany = '' } = {}) {
  const q = value => `“${value}”`;
  const tokens = value => String(value ?? '').replace(/['’]s\b/giu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const term = tokens(finding.term);
  const employerTerm = term.length > 0 && targetCompanyNames(targetCompany).some(name => {
    const company = tokens(name);
    return company.some((_, index) => term.every((word, offset) => company[index + offset] === word));
  });
  switch (finding.code) {
    case 'target-employment-frame':
      return `${unit} names ${q(finding.term)}, the employer this letter is addressed to. Name it only as the owner of a need your work meets, or as a place you would join, never as a place your work happened; do not say you worked, built or helped at, for or on it.`;
    case 'name':
      if (employerTerm) return `${unit} names ${q(finding.term)}, the employer this letter is addressed to. Name it only as the owner of a need your work meets, or as a place you would join, never as a place your work happened; do not say you worked, built or helped at, for or on it.`;
      return `${unit} names ${q(finding.term)}, which none of its bound career-data quotes states. Every capitalized or acronym term (a tool, product, organization, title, program, or place) must occur in one of the quotes the unit cites, so quote the passage that names it or leave the name out.`;
    case 'use':
      return `${unit} claims hands-on use of ${q(finding.term)}, but its bound career-data quotes ${finding.reason === 'alternative' ? 'offer it only as one of several alternatives' : 'only evaluate it, attribute it to another party, or describe a system someone else chose or owned'}. State use of a tool only where a cited quote says the candidate used that tool.`;
    case 'quantity':
      return `${unit} states the count ${q(finding.term)}${describeQuantityFollower(finding)}, which none of its bound career-data quotes states${finding.bound === 'lower' ? ' as a lower bound that large' : ''}${finding.otherThing ? ` for that thing (a cited quote gives that number only for ${q(finding.otherThing)}, and a number counts only what its quote counts)` : ''}. Use the number a cited quote gives for the same thing, in digits or words, with “over”, “more than”, or “N+” only where the quote bounds it that way, or drop the count.`;
    case 'interval':
      return finding.rate
        ? `${unit} states the rate interval ${q(finding.term)} for a number, which none of its bound career-data quotes states: they give that number as a total, and an interval makes it a rate. State the number as the quote does, without the interval, or cite a quote that states it ${finding.term}.`
        : `${unit} states the rate interval ${q(finding.term)}, which none of its bound career-data quotes states. Keep the interval the quote gives the figure per.`;
    case 'credential':
      return `${unit} asserts ${q(finding.term)}, but none of its bound career-data quotes records that licence, certification, accreditation, or degree. Cite the record that states it or leave the credential out.`;
    case 'year':
      return `${unit} dates its work with ${q(finding.raw || finding.term)}, but ${finding.term} is neither stated by a bound career-data quote nor one of the years an approved role's own dates state.`;
    case 'clause':
      return `${unit} adds the clause ${q(finding.term)}, which shares no meaningful term with its bound career-data quotes. Each coordinated or trailing clause must restate work a cited quote states.`;
    default:
      return `${unit} states ${q(finding.term)}, which its bound career-data quotes do not.`;
  }
}

/** Stated once for the correction brief and the drafting contracts, from the mechanisms above. */
export const CLAIM_GROUNDING_RULE = 'names, counts and scale are claims too: every capitalized or acronym term (tool, product, organization, title, place), every count with its \u201cover\u201d/\u201cN+\u201d bound, every \u201cper <interval>\u201d, every scale or comparison word (millions, nationwide, doubled, by half), every licence, certification or degree word, and every calendar year must be stated by a quote the unit cites; a trailing clause must restate cited work; and a tool is claimed as used only where a quote says it was used, not merely evaluated, owned by someone else, or one of several alternatives. An ownership or authorship word must be said of the candidate, at no lower a level (co-led, helped lead and contributed to do not support led or built), in a quote about the same work';
