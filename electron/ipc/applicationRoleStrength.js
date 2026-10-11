/**
 * Role-strength fidelity of generated application prose.
 *
 * The question this module answers about a sentence of generated résumé or
 * cover-letter copy and the career-data statements it cites: when the evidence
 * says the candidate SUPPORTED some work (maintained it, monitored it,
 * administered it, took part in it), and says that the work itself carries out
 * an action ("report-job maintenance that rebuilds the summaries"), does the
 * sentence keep the candidate in that support role, or does it make the
 * candidate the actor of the action ("Rebuilt the summaries")?
 *
 * Role strength is an ORDERED class, not a word list:
 *
 *     support (1)  <  perform (2)  <  create or own (3)
 *
 * A statement that puts the candidate at one class never supports a sentence
 * that puts the candidate at a higher one for the same work. The vocabulary
 * below is generic English (language data). It never names a person, employer,
 * product, school or listing; the CURRENT approved evidence is the only thing
 * that decides what a sentence may claim, and the same sentence is admissible
 * or not as a function of the statements it is read against.
 *
 * What the module enforces of that order, for the SAME work, is exactly three
 * comparisons (anything else is outside it and is listed at the end):
 *
 *   TRIPWIRE. The evidence gives an action V to a work the candidate supported.
 *   A claim that makes the candidate the actor of an action with V's stem has
 *   moved V from the work to the candidate, so it stands at the perform rung at
 *   the least (its own rung when the vocabulary ranks it higher), above the
 *   support rung the evidence gives. This holds even when V is itself a support
 *   verb ("support that administered medications" does not license
 *   "Administered medications"): the claim's class is read from the comparison,
 *   not from the verb's word list.
 *   RUNG SKIP. A creation verb (rank 3) whose direct object is the supported
 *   work itself ("Rebuilt the feed") is two rungs above support, whatever V is.
 *   Only a statement that says the candidate made that work releases it. The
 *   creation vocabulary is the verbs of authorship, fabrication, release and
 *   remaking of every field, not of one trade: drafted, composed, formulated,
 *   fabricated, manufactured, fashioned, prepared, issued, published, released,
 *   shipped, deployed, installed, overhauled, and the phrasal pairs (stood up,
 *   set up, rolled out, put together). A one-word synonym swap inside it does
 *   not reopen the inflation.
 *   UNCLASSED ACT. A verb the vocabulary does not class (migrated, integrated,
 *   configured, piloted) cannot be placed on the ladder, so it is decided
 *   fail-closed in ONE frame only: it opens its clause (or follows "I"/"we"), it
 *   is not a verb of sustaining (fixed, patched, tested, documented, taught: what
 *   a person does to a work that already exists), and its direct object is the
 *   supported work as the statement names it (the head noun, every term of the
 *   work, at most one more modifier). Anywhere else an unclassed verb says
 *   nothing about the candidate's part and is left alone. The sentence is
 *   released by the usual means: a statement that says the candidate did it, a
 *   statement that made the work, or the support role stated in the sentence.
 *
 * Not compared here, and so the residual that stays open: ownership verbs (led,
 * managed, oversaw, owned) over a supported work, because "administer" and
 * "manage" name one activity in everyday use and the strength-family gate in
 * applicationClaimGrounding.js already orders leadership and authorship words;
 * perform verbs over the supported work itself (ran, operated, executed,
 * delivered: "Ran the feed"), the adjacent rung and not separable from support
 * by word class; and a verb that merely names V in other words (a synonym
 * outside the stem rule below), which no vocabulary can list.
 *
 * Mechanism, each step shared by every domain:
 *
 *   1. ASSERTIONS. A statement presents an action verb V as carried out by a
 *      work whose head is a support-class word, or as the activity the
 *      candidate only took part in. Seven shapes are read:
 *        - a support NOUN with the work before it:  "<work> maintenance that <V>s ..."
 *        - a support NOUN with the work after it:   "maintenance of <work> that <V>s ..."
 *        - a support VERB with the work after it:   "Maintained <work> that <V>s ..."
 *        - the same verb with a non-restrictive or parenthesised relative:
 *          "Maintained <work>, which <V>s ..." and "Maintained <work> (which <V>s ...)"
 *        - the same verb with a reduced relative after a plural work:
 *          "Maintained <works> <V>ing ..."
 *        - a support verb whose object is a classed activity: "Assisted <people>
 *          in <V>ing <thing>", "Contributed to <V>ing <thing>", "Helped <V> <thing>".
 *        - membership of the group that did it: "Member of the team that <V>ed
 *          <thing>", "Part of the group that ...", "Worked with the crew that ...",
 *          "On the committee that ..." (leading the group is another statement and
 *          is not read; a claim that says the candidate worked with a group states
 *          the role).
 *      V follows a relative pronoun ("that", "which", "who"), a comma-led
 *      participle (", doing ..."), a plural work, a preposition, or a purpose
 *      "to" (noun shapes only). A passive relative ("that was approved") has no
 *      actor and is not read, nor is a clause with a subject of its own ("that
 *      the team requested"), a stative or instrumental verb ("that includes",
 *      "that uses"), or a comma-led gerund that is one more item of a list of
 *      duties ("maintenance, patching, and monitoring") or has no direct object
 *      ("monitoring, alerting on failures"). Those are as often the candidate's
 *      duties as the work's actions, so they are left alone.
 *   2. CLAIMS. The sentence's own actions are the verbs the candidate is the
 *      actor of: a clause-opening verb, a verb after "I"/"we", a verb coordinated
 *      to one of those, a participle after a comma, and "by/through/via -ing".
 *      A verb inside a relative clause ("jobs that compile ...") is the work's.
 *      Each action carries the noun phrase it acts on (its direct object, up to
 *      a preposition) and the wider reach of its clause.
 *   3. A claim is a MISMATCH when (tripwire) one of its own actions shares V's
 *      stem (inflection, or a common prefix of at least four letters covering
 *      most of the shorter stem), the sentence is about the same work (it
 *      shares a content term with the assertion), the sentence states no
 *      support role for that work, and no statement says the candidate made
 *      the work or performed V; or (rung skip) one of its creation verbs acts
 *      directly on the supported work and no statement says the candidate made it;
 *      or (unclassed act) a verb outside the vocabulary and outside the verbs of
 *      sustaining opens the sentence with the supported work as its direct
 *      object, and no statement or stated role releases it.
 *   4. A SUPPORT ROLE IS STATED only by a support verb in the candidate's own
 *      verb position whose object or reach is the same work, or by the support
 *      noun the statement used, close after an action of the text and beside the
 *      work. A word that is a support word only as a noun in some other phrase
 *      ("financial services", "support team", "castle keep") states nothing.
 *   5. THE SAME WORK is decided by the clause that states the authorship, never
 *      by the sentence it sits in: the noun phrase the authoring or performing
 *      verb acts on has to end in the work's head noun and share most of its
 *      terms (for performing V: the object of V). A clause of the same sentence
 *      that builds some other thing, and two generic words in common, are not
 *      the same work.
 *   6. Statements that merely EXCERPT a longer statement are not statements of
 *      their own. A host projection can cite a technology row that carries only
 *      the clause after "that"; the fuller statement it was cut from is what
 *      says how the candidate stood to the work, so the excerpt is dropped and
 *      the statement it came from is read instead.
 *
 * The fail-closed side. A support noun is read literally ("application support
 * that resolves tickets" asserts that the support resolves them): a bullet that
 * makes the candidate the actor needs a support verb of its own, or a quote that
 * says the candidate did the action, to pass; the cost of the stricter reading
 * is one repair that is always available, and the cost of the looser one is an
 * ownership claim the evidence does not make.
 *
 * Uncovered, by design or for want of a safe reading:
 *   - synonyms of V outside the stem rule ("pulls" restated as "Fetched");
 *   - a statement whose subject is a role noun ("support agent that resolves ...",
 *     "on-call responder for the service that settles ...") and an authorship
 *     stated as a noun ("author of ...") or a passive;
 *   - an activity stated as a noun ("participated in the redesign of ..." read as
 *     "Redesigned ..."), and "one of the analysts who <V>ed ...";
 *   - a work named by a pronoun or by a different noun than the statement used;
 *   - a reduced relative after a singular work ("Maintained the planner assigning
 *     ...") and a gerund object without a determiner; a relative clause carried by
 *     a second sentence ("Kept the export running; it updates ...");
 *   - an activity V the vocabulary does not class after "assisted in" (the
 *     unclassed-act frame reads the claim, not the statement);
 *   - an unclassed claim verb anywhere but the exact frame (mid-sentence, as a
 *     participle, or on a different noun phrase), and a verb of sustaining
 *     acting on the work, which can be a made work in disguise ("Rebuilt" is in
 *     the vocabulary, "Improved" is not);
 *   - a verb ending in "-ly" that the adverb rule does not know and that takes a
 *     bare plural object ("that sully incoming orders" reads "sully" as an
 *     adverb; with a determiner or preposition after it, it is read as the verb);
 *   - the ownership and perform rungs over a supported work (see above).
 *
 * Nothing in this module reads the filesystem or any host state.
 */
import { evidenceBody, relatednessStem, relatednessTerms } from './applicationClaimGrounding.js';

// ---------------------------------------------------------------------------
// Language data: ordered role-strength classes
// ---------------------------------------------------------------------------

// Verbs that make a thing. A statement that says the candidate did one of these
// to the work is the strongest evidence a sentence can lean on. CORE is the list
// that also decides whether a work was made by the candidate before a support
// head ("Built monitoring that ..."); WIDER adds the authorship, fabrication,
// release and remaking verbs of every field (a clinic drafts a protocol, a plant
// manufactures a part, a lab formulates a reagent, a desk issues a notice, a
// studio publishes a score, a software team ships a service). Both rank at the
// creation rung wherever a claim is compared with a supported work.
const CORE_MAKING_VERBS = Object.freeze([
  'build', 'develop', 'engineer', 'design', 'implement', 'create', 'author', 'launch', 'architect', 'write', 'code', 'program',
  'devise', 'establish', 'found', 'pioneer', 'introduce', 'initiate', 'construct', 'produce', 'invent', 'originate', 'rebuild',
  'redesign', 'rewrite', 'refactor', 'assemble', 'craft', 'automate',
]);
const WIDER_MAKING_VERBS = Object.freeze([
  // authorship and composition
  'draft', 'compose', 'formulate', 'conceive', 'make', 'generate', 'prepare', 'synthesize', 'fashion',
  // fabrication and standing a thing up
  'fabricate', 'manufacture', 'install', 'commission', 'provision', 'prototype', 'bootstrap',
  // release and publication
  'publish', 'release', 'issue', 'ship', 'deploy', 'institute', 'productionize',
  // remaking
  'overhaul', 'revamp', 'rework', 'remake', 'reengineer', 'rearchitect', 'reimagine', 'reinvent', 'remodel', 'modernize', 'transform',
]);
const MAKING_VERBS = Object.freeze([...CORE_MAKING_VERBS, ...WIDER_MAKING_VERBS]);
/**
 * Phrasal verbs of making, "<verb> <particle>": the verb alone is not a creation verb ("set the table", "stood
 * watch"), the pair is. Read in a claim or a statement when the particle follows the verb directly.
 */
export const ROLE_STRENGTH_PHRASAL_MAKING = Object.freeze([
  'stand up', 'set up', 'spin up', 'roll out', 'put together', 'draw up', 'stitch together',
]);
// Verbs that put the candidate in charge of a thing.
const OWNING_VERBS = Object.freeze([
  'lead', 'own', 'direct', 'head', 'spearhead', 'orchestrate', 'manage', 'supervise', 'oversee', 'captain', 'chair', 'steer',
]);
const PERFORMING_VERBS = Object.freeze([
  'run', 'operate', 'execute', 'perform', 'conduct', 'handle', 'carry', 'complete', 'deliver', 'process',
]);
const SUPPORTING_VERBS = Object.freeze([
  'maintain', 'support', 'monitor', 'administer', 'assist', 'aid', 'help', 'participate', 'contribute', 'service', 'sustain', 'keep',
  'tend', 'steward', 'backstop', 'babysit', 'upkeep',
]);
/**
 * Verbs for what a person does to a work that already exists without making it: they investigate it, correct it, bring
 * it up to date, operate it, move it, teach others to use it. A verb outside the vocabulary that acts directly on the supported work is read
 * as an unclassified act only if it is not one of these (see roleStrengthFindings); the list caps the false rejects of
 * that fail-closed reading, it is not a list of what the candidate may claim.
 */
export const ROLE_STRENGTH_SUSTAINING_VERBS = Object.freeze([
  'fix', 'repair', 'patch', 'update', 'upgrade', 'tune', 'retune', 'calibrate', 'debug', 'troubleshoot', 'diagnose', 'correct', 'resolve',
  'adjust', 'revise', 'edit', 'amend', 'renew', 'restore', 'refresh', 'clean', 'secure', 'harden', 'stabilize',
  'test', 'retest', 'review', 'audit', 'inspect', 'check', 'verify', 'validate', 'evaluate', 'assess', 'analyze', 'analyse', 'study',
  'measure', 'benchmark', 'profile', 'investigate', 'examine', 'document', 'optimize', 'optimise', 'improve', 'enhance', 'streamline',
  'simplify', 'strengthen', 'extend', 'expand', 'scale',
  'train', 'teach', 'coach', 'mentor', 'onboard', 'explain', 'demonstrate', 'present', 'use', 'utilize', 'query', 'access',
  // operating a work that exists
  'set', 'reset', 'restart', 'reboot', 'rerun', 'start', 'stop', 'pause', 'resume', 'enable', 'disable', 'switch', 'toggle', 'load', 'unload',
  'open', 'close', 'lock', 'unlock', 'flush', 'clear', 'drain', 'refill', 'rotate', 'archive', 'schedule', 'label', 'tag',
  // handling a work that exists, and the light verbs that say nothing about making one
  'put', 'take', 'bring', 'move', 'get', 'give', 'send', 'show', 'find', 'see', 'hold', 'choose', 'select', 'pick', 'add', 'remove', 'delete', 'drop',
  'watch', 'observe', 'track', 'log', 'count',
  // moving a measure of it, protecting it, reporting on it, finding out about it, sharing it
  'accelerate', 'speed', 'reduce', 'increase', 'decrease', 'cut', 'lower', 'raise', 'boost', 'minimize', 'maximize', 'double', 'triple', 'prioritize',
  'protect', 'safeguard', 'plan', 'assign', 'allocate', 'budget', 'approve', 'coordinate', 'recover', 'rescue', 'salvage', 'retrieve', 'report',
  'record', 'collect', 'gather', 'share', 'sort', 'rank', 'rate', 'map', 'classify', 'catalog', 'inventory', 'list', 'summarize', 'tabulate',
  'compare', 'calculate', 'compute', 'forecast', 'estimate', 'predict', 'interpret', 'describe', 'define', 'specify', 'outline', 'collaborate',
  'partner', 'consult', 'advise', 'brief', 'counsel', 'guide', 'educate', 'instruct', 'inform', 'communicate', 'appraise', 'certify', 'detect',
  'discover', 'identify', 'determine', 'uncover', 'explore', 'research', 'survey', 'screen', 'interview', 'question', 'transfer', 'route',
  'dispatch', 'distribute', 'supply', 'submit', 'transmit', 'receive', 'obtain', 'acquire', 'purchase', 'procure', 'source', 'license', 'register',
  'serve', 'represent', 'promote', 'market', 'showcase', 'display', 'visualize', 'illustrate', 'render', 'refine', 'address', 'ensure', 'achieve',
  'accomplish', 'exceed', 'earn', 'win', 'save', 'drive', 'announce', 'anticipate', 'apply', 'change', 'contain', 'control', 'locate', 'prevent', 'search',
  'respond', 'solve', 'master', 'navigate', 'negotiate', 'offer', 'propose', 'provide', 'target', 'recruit', 'hire', 'extract', 'leverage', 'focus',
  'influence', 'eliminate', 'encourage', 'foster', 'facilitate', 'mediate', 'motivate', 'stimulate', 'regulate', 'reinforce', 'expedite', 'finalize',
]);
const PRONOUN_OBJECTS = new Set(['it', 'them', 'this', 'these']);
// A particle that makes a verb a phrasal verb ("backed up", "cleaned out", "handed over"): the pair is not the bare verb, and the
// vocabulary cannot class it, so it is not read as a verb acting directly on a work.
const VERB_PARTICLES = new Set(['up', 'out', 'off', 'down', 'back', 'over', 'away', 'through', 'together', 'aside', 'around']);

/**
 * The ordered classes. `rank` is the order; a higher rank is a stronger statement of the candidate's part. The ranks are
 * read where a claim is compared with the evidence: the class a claim stands at when it takes over the work's action
 * (never below `perform`), and the rung skip (a creation verb is two ranks above support).
 */
export const ROLE_STRENGTH_CLASSES = Object.freeze([
  Object.freeze({ id: 'support', rank: 1, label: 'support', claimed: 'supported', verbs: SUPPORTING_VERBS }),
  Object.freeze({ id: 'perform', rank: 2, label: 'performance', claimed: 'performed', verbs: PERFORMING_VERBS }),
  Object.freeze({ id: 'create', rank: 3, label: 'creation or ownership', claimed: 'created or owned', verbs: Object.freeze([...MAKING_VERBS, ...OWNING_VERBS]) }),
]);

/** Nouns that name the support of some work. Each is read only with a work and an action beside it (see the mechanism above). */
export const SUPPORT_HEAD_NOUNS = Object.freeze([
  'maintenance', 'upkeep', 'monitoring', 'administration', 'oversight', 'assistance', 'participation', 'operation', 'support',
  'servicing', 'stewardship', 'sustainment', 'housekeeping',
]);
// Words that are as often a verb or a role as a support noun. They count as a
// head only with something before them in the clause that is not a verb marker.
const AMBIGUOUS_HEADS = new Set(['support', 'monitoring', 'servicing', 'operation']);

// Surface forms that no suffix rule reaches.
const IRREGULAR_BASES = Object.freeze({
  ran: 'run', run: 'run', runs: 'run', wrote: 'write', written: 'write', built: 'build', led: 'lead', kept: 'keep', sent: 'send',
  made: 'make', took: 'take', taken: 'take', gave: 'give', given: 'give', held: 'hold', began: 'begin', begun: 'begin', drove: 'drive',
  driven: 'drive', chose: 'choose', chosen: 'choose', brought: 'bring', taught: 'teach', saw: 'see', seen: 'see', found: 'find',
  got: 'get', gotten: 'get', met: 'meet', paid: 'pay', sold: 'sell', spent: 'spend', oversaw: 'oversee', overseen: 'oversee',
  undertook: 'undertake', understood: 'understand', won: 'win', grew: 'grow', grown: 'grow', rose: 'rise', fed: 'feed',
  rebuilt: 'rebuild', rewrote: 'rewrite', rewritten: 'rewrite', stood: 'stand', did: 'do', done: 'do', went: 'go', gone: 'go',
  bought: 'buy', caught: 'catch', cut: 'cut', put: 'put', set: 'set', read: 'read', thought: 'think',
  spun: 'spin', drew: 'draw', drawn: 'draw', remade: 'remake', troubleshot: 'troubleshoot', used: 'use',
});

// A past form of a verb that ends in a consonant and "y" loses the "y" ("copied", "applied"): fold the "i" back, so the
// four-letter bases ("copy"/"copied", "rely"/"relied") share a stem as the longer ones do.
const foldTrailingI = stem => stem.replace(/(?<=\p{L}{3})i$/u, 'y');

// The stem two inflections of a verb share ("organized", "organizes" and
// "organize" are one stem).
const actionStem = word => foldTrailingI(relatednessStem(IRREGULAR_BASES[String(word).toLowerCase()] || String(word).toLowerCase()));
// The stem of a vocabulary entry, which is always a base form: the irregular table is for inflected text ("found" is
// the past of "find" there, and "founded" is the verb the vocabulary means).
const vocabularyStem = verb => foldTrailingI(relatednessStem(verb));

const classByStem = new Map();
for (const klass of ROLE_STRENGTH_CLASSES) for (const verb of klass.verbs) classByStem.set(vocabularyStem(verb), klass);
const makingStems = new Set(MAKING_VERBS.map(vocabularyStem));
// The narrower list that says a work was made by the candidate before a support head ("Built monitoring that ...").
const coreMakingStems = new Set(CORE_MAKING_VERBS.map(vocabularyStem));
const supportStems = new Set(SUPPORTING_VERBS.map(vocabularyStem));
const sustainingStems = new Set(ROLE_STRENGTH_SUSTAINING_VERBS.map(vocabularyStem));
// Verbs that are as often a noun at the head of a clause ("Release notes for the desk", "Draft policies"): read as a verb
// there only with a determiner or a number beside it.
const NOUN_PRONE_STEMS = new Set(['draft', 'issue', 'release', 'ship', 'produce', 'commission', 'prototype', 'manufacture', 'fashion', 'transform', 'provision'].map(vocabularyStem));
// "stand up", "set up": the particle that makes the verb a verb of making, by the verb's stem.
const PHRASAL_PARTICLES = new Map(ROLE_STRENGTH_PHRASAL_MAKING.map(entry => {
  const [verb, particle] = entry.split(' ');
  return [vocabularyStem(verb), particle];
}));
const headStems = new Map(SUPPORT_HEAD_NOUNS.map(noun => [noun, relatednessStem(noun)]));

const commonPrefix = (left, right) => {
  let at = 0;
  while (at < left.length && at < right.length && left[at] === right[at]) at += 1;
  return at;
};

/**
 * Do two verb stems name the same action? Equal stems do. Otherwise they share a
 * prefix of at least four letters that covers most of the shorter stem: an
 * abbreviation and its long form ("prep", "prepar(e)"; "calc", "calculat(e)"),
 * or two spellings ("organis(e)", "organiz(e)"), are one action; "comp(ile)" and
 * "comp(ute)" are not. The rule is generic and has a known cost: a short stem and
 * the same stem plus one letter also merge.
 */
export function sameActionStem(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  const shared = commonPrefix(left, right);
  return shared >= 4 && shared >= Math.ceil(Math.min(left.length, right.length) * 0.75);
}

// A support noun and a support verb that name the same activity ("maintenance",
// "maintained"; "oversight", "oversaw"; "administration", "administered").
const sameRootStem = (left, right) => Boolean(left && right) && (left === right || commonPrefix(left, right) >= 5);

// ---------------------------------------------------------------------------
// Tokens and clauses
// ---------------------------------------------------------------------------

const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
const CLAUSE_GAP_RE = /[;:—–()]|\s-\s/u;

function tokenize(text) {
  const source = String(text ?? '');
  const tokens = [];
  let last = 0;
  for (const match of source.matchAll(TOKEN_RE)) {
    const raw = match[0].replace(/’/gu, "'");
    tokens.push({ raw, w: raw.toLowerCase(), start: match.index, end: match.index + match[0].length, gap: source.slice(last, match.index) });
    last = match.index + match[0].length;
  }
  return tokens;
}

/**
 * Sentences of a statement or a claim; a list marker and a bullet dash do not belong to one. A spaced dash before a
 * capital also ends one: a career text whose lines were joined keeps its entries apart that way (" - Wrote ...").
 */
function sentencesOf(text) {
  return String(text ?? '')
    .split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}"'(])|\s[-–—]\s+(?=[\p{Lu}\p{N}])|\n+/u)
    .map(sentence => sentence.replace(/^[\s\-*•]+/u, '').trim())
    .filter(Boolean);
}

const RELATIVES = new Set(['that', 'which', 'who', 'whom']);
const COORDINATORS = new Set(['and', 'but', 'then', 'while', 'so', 'yet', 'or']);
const PREPOSITIONS = new Set(['of', 'for', 'on', 'over', 'in', 'at', 'by', 'with', 'from', 'into', 'onto', 'across', 'through', 'via', 'under', 'between', 'among', 'per', 'within', 'without', 'toward', 'towards', 'than', 'as', 'to']);
const DETERMINERS = new Set(['the', 'a', 'an', 'our', 'their', 'its', 'his', 'her', 'my', 'your', 'this', 'these', 'those', 'all', 'each', 'every', 'any', 'some', 'both', 'no', 'several', 'many', 'various', 'multiple']);
const PRONOUNS = new Set(['i', 'we', 'you', 'they', 'he', 'she', 'it', 'us', 'them', 'me', 'who', 'what', 'there']);
const BE_FORMS = new Set(['am', 'is', 'are', 'was', 'were', 'be', 'been', 'being']);
const AUXILIARIES = new Set([...BE_FORMS, 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'can', 'could', 'should', 'shall', 'may', 'might', 'must']);
const MODALS = new Set(['will', 'would', 'can', 'could', 'should', 'shall', 'may', 'might', 'must']);
// The closed list of common adverbs, the "-ly" ones among them. An "-ly" word outside it is read as an adverb only by
// the open rule below, which is the weaker of the two: not every "-ly" word is one.
const ADVERB_WORDS = new Set([
  'also', 'then', 'now', 'just', 'still', 'always', 'never', 'not', 'once', 'often', 'currently', 'even', 'together', 'again', 'already', 'twice', 'soon', 'ever',
  'actively', 'additionally', 'annually', 'automatically', 'briefly', 'carefully', 'closely', 'collaboratively', 'completely', 'consistently', 'continually',
  'continuously', 'daily', 'directly', 'early', 'effectively', 'efficiently', 'entirely', 'eventually', 'exclusively', 'extensively', 'finally', 'formerly',
  'frequently', 'fully', 'generally', 'gradually', 'hourly', 'immediately', 'independently', 'initially', 'jointly', 'largely', 'locally', 'mainly', 'manually',
  'mostly', 'monthly', 'nightly', 'normally', 'occasionally', 'originally', 'partially', 'partly', 'periodically', 'personally', 'previously', 'primarily',
  'proactively', 'promptly', 'quarterly', 'quickly', 'rapidly', 'recently', 'regularly', 'reliably', 'remotely', 'repeatedly', 'routinely', 'seamlessly',
  'securely', 'separately', 'simply', 'simultaneously', 'slowly', 'solely', 'steadily', 'subsequently', 'successfully', 'swiftly', 'systematically', 'thoroughly',
  'typically', 'usually', 'weekly', 'yearly',
]);
// "-ly" words that are verbs or nouns, never adverbs: "jobs that apply discounts" has the verb "apply" right after the relative
// pronoun, and a prefix does not change that ("reapply", "oversupply").
const LY_NON_ADVERBS = /^(?:(?:re|mis|over|under|out)?(?:apply|supply|reply|comply|imply|multiply|rally|tally|ally|dally)|family|assembly|anomaly|monopoly|bully|belly|gully|jelly|butterfly|doily|folly|holly|homily)$/u;
// Verbs that say what a work is or has, or what it is built from, not what it does.
const STATIVE_VERBS = new Set(['include', 'contain', 'comprise', 'consist', 'remain', 'exist', 'belong', 'depend', 'equal', 'mean', 'seem', 'appear', 'become', 'need', 'want', 'require', 'involve', 'have', 'be', 'use', 'utilize', 'leverage', 'feature']);
const STATIVE_STEMS = new Set([...STATIVE_VERBS].map(verb => relatednessStem(verb)));
// A verb of that kind, in any form ("using" keeps its suffix under the stem rule).
const isStativeForm = word => STATIVE_STEMS.has(actionStem(word)) || word === 'using';
const EXPERIENCE_NOUNS = new Set(['experience', 'work', 'background', 'role', 'time', 'job', 'responsibility', 'responsibilities', 'practice', 'expertise', 'history', 'tenure']);
const MANNER_PREPOSITIONS = new Set(['by', 'through', 'via', 'while', 'after']);
// "responsible for rebuilding ...", "in charge of rebuilding ...": the candidate's own duty.
const DUTY_FRAME_RE = /(?:^|\s)(?:(?:responsible|accountable) for|charge of|(?:tasked|charged|entrusted) with)$/u;

// An "-ly" word outside the closed list: an adverb unless it is a known verb or noun of that shape.
const isOpenAdverb = word => word.length > 4 && word.endsWith('ly') && !LY_NON_ADVERBS.test(word);
const isAdverb = word => ADVERB_WORDS.has(word) || isOpenAdverb(word);
// Can a verb stand at this token, or an adverb that leads to one ("quickly and carefully compiles")? A determiner, a
// preposition, a pronoun, a relative pronoun, a number or a break cannot: the "-ly" word before it is the verb itself.
function verbCanFollow(tokens, index, depth = 0) {
  const next = tokens[index];
  if (!next || !isWordLike(next.w) || CLAUSE_GAP_RE.test(next.gap)) return false;
  if (COORDINATORS.has(next.w)) return depth < 3 && verbCanFollow(tokens, index + 1, depth + 1);
  return !(DETERMINERS.has(next.w) || PREPOSITIONS.has(next.w) || PRONOUNS.has(next.w) || RELATIVES.has(next.w));
}
// Is this token an adverb where it stands? A word of the closed list is, always. An open "-ly" word is only when a verb
// can follow it: "that supply wind forecasts" and "that comply with the rules" have no adverb in them even for a verb the
// exception list does not know.
function adverbAt(tokens, index) {
  const word = tokens[index]?.w;
  if (!word) return false;
  if (ADVERB_WORDS.has(word)) return true;
  return isOpenAdverb(word) && verbCanFollow(tokens, index + 1);
}
const isWordLike = word => /^\p{L}{3,}$/u.test(word);
const isParticipleForm = word => (word.length > 4 && (word.endsWith('ed') || word.endsWith('ing'))) || Object.hasOwn(IRREGULAR_BASES, word);
const isPastForm = word => (word.length > 3 && word.endsWith('ed')) || (Object.hasOwn(IRREGULAR_BASES, word) && IRREGULAR_BASES[word] !== word);

function clauseStarts(tokens) {
  const starts = new Set([0]);
  tokens.forEach((token, index) => { if (index > 0 && CLAUSE_GAP_RE.test(token.gap)) starts.add(index); });
  return starts;
}

const clauseStartOf = (starts, index) => {
  let start = 0;
  for (const candidate of starts) if (candidate <= index && candidate > start) start = candidate;
  return start;
};

// ---------------------------------------------------------------------------
// The actions a text makes the candidate the actor of
// ---------------------------------------------------------------------------

function ownPosition(tokens, index, starts, state) {
  const token = tokens[index];
  const word = token.w;
  if (!isWordLike(word) || AUXILIARIES.has(word) || DETERMINERS.has(word) || PREPOSITIONS.has(word) || COORDINATORS.has(word)
    || PRONOUNS.has(word) || RELATIVES.has(word) || adverbAt(tokens, index)) return null;
  // A verb that opens its clause ("Rebuilt the summaries nightly"), after any adverbs.
  const clauseStart = clauseStartOf(starts, index);
  const before = tokens.slice(clauseStart, index);
  const next = tokens[index + 1]?.w || '';
  if (before.every((entry, offset) => adverbAt(tokens, clauseStart + offset))) {
    const stem = actionStem(word);
    const baseForm = !isParticipleForm(word) && (!classByStem.has(stem) || NOUN_PRONE_STEMS.has(stem));
    // A base-form or plural opening word is a verb only with an object beside it ("Compile the roster"), never a noun or a noun modifier ("Summaries compiled nightly", "Compile scripts").
    if (!baseForm || DETERMINERS.has(next) || /^\d/u.test(next)) return 'initial';
    return null;
  }
  // A verb after the candidate as the subject: "I rebuilt", "we have rebuilt", "I also rebuilt".
  let cursor = index - 1;
  let sawBe = false;
  let sawModal = false;
  while (cursor >= clauseStart && (adverbAt(tokens, cursor) || AUXILIARIES.has(tokens[cursor].w))) {
    if (BE_FORMS.has(tokens[cursor].w)) sawBe = true;
    if (MODALS.has(tokens[cursor].w)) sawModal = true;
    cursor -= 1;
  }
  const subject = cursor >= clauseStart ? tokens[cursor].w : '';
  if (/^(?:i|we|i've|we've)$/u.test(subject) && !sawModal && (!sawBe || word.endsWith('ing'))) return 'subject';
  // "I'm compiling", "we're compiling": a contracted be, so the verb has to be the progressive.
  if (/^(?:i'm|we're)$/u.test(subject) && word.endsWith('ing') && word.length > 4) return 'subject';
  // A verb coordinated to one the candidate already did ("Maintained jobs and rebuilt reports"),
  // unless a relative clause or an infinitive opened in between and the verb belongs to it.
  const previous = tokens[index - 1];
  if (state.lastOwn >= 0 && state.barrier < state.lastOwn && (isPastForm(word) || isPhrasalMaking(tokens, index))
    && (COORDINATORS.has(previous.w) || (/,/u.test(token.gap) && state.lastOwn === index - 1))) return 'coordinated';
  // A participle the candidate's clause carries, or a means ("by rebuilding ...", ", rebuilding ...").
  if (word.endsWith('ing') && word.length > 4) {
    if (MANNER_PREPOSITIONS.has(previous.w)) return 'manner';
    if (DUTY_FRAME_RE.test(tokens.slice(Math.max(clauseStart, index - 3), index).map(entry => entry.w).join(' '))) return 'duty';
    if (/,/u.test(token.gap) && state.lastOwn >= 0 && state.barrier < state.lastOwn) return 'participial';
    // "my experience rebuilding ...": the candidate's own experience doing it.
    if (EXPERIENCE_NOUNS.has(previous.w) && tokens.slice(Math.max(clauseStart, index - 4), index - 1).some(entry => entry.w === 'my' || entry.w === 'our')) return 'experience';
  }
  return null;
}

/**
 * Every token of a sentence the candidate is the actor of, in reading order:
 * `{ index, position }`. The one scan every reading of a text shares.
 */
function ownActionPositions(tokens, starts) {
  const found = [];
  const state = { lastOwn: -1, barrier: -1 };
  tokens.forEach((token, index) => {
    if (starts.has(index)) { state.lastOwn = -1; state.barrier = -1; }
    if (RELATIVES.has(token.w) || token.w === 'to') state.barrier = index;
    const position = ownPosition(tokens, index, starts, state);
    if (!position) return;
    found.push({ index, position });
    state.lastOwn = index;
  });
  return found;
}

// The last content term of a run of tokens ("the nightly report jobs" -> "job"), or ''.
function headTerm(words) {
  for (let at = words.length - 1; at >= 0; at -= 1) {
    const [term] = relatednessTerms(words[at]);
    if (term) return term;
  }
  return '';
}

// The noun phrase that starts at `from`, up to `stop`: ends at a preposition, coordinator, relative pronoun,
// auxiliary or any break in the sentence, at most `limit` words. Trailing adverbs ("... summaries daily") are not part of it.
function nounPhraseAt(tokens, from, stop = tokens.length, limit = 8) {
  const taken = [];
  for (let cursor = from; cursor < Math.min(stop, tokens.length) && taken.length < limit; cursor += 1) {
    const token = tokens[cursor];
    if (CLAUSE_GAP_RE.test(token.gap) || (cursor > from && /,/u.test(token.gap)) || NOUN_PHRASE_BREAKS.has(token.w)) break;
    // A quantifier in the middle of a phrase opens a phrase of its own ("... the jobs each night", "... the feed every quarter").
    if (cursor > from && NEW_PHRASE_WORDS.has(token.w)) break;
    // "a runbook covering the jobs": a participle with an object of its own starts a modifier, not more of the phrase
    // ("the existing report jobs", "the processing queue" have none).
    if (cursor > from && token.w.endsWith('ing') && token.w.length > 4 && (DETERMINERS.has(tokens[cursor + 1]?.w) || /^\d/u.test(tokens[cursor + 1]?.w || ''))) break;
    taken.push(token);
  }
  while (taken.length > 1 && isAdverb(taken[taken.length - 1].w)) taken.pop();
  return taken;
}

const phraseOf = taken => ({ terms: relatednessTerms(taken.map(token => token.raw).join(' ')), head: headTerm(taken.map(token => token.raw)) });

// The noun phrase right before `end`, walking back to a preposition, coordinator, auxiliary, relative pronoun or break:
// what a relative clause ("the jobs that I maintain") is about.
function phraseBefore(tokens, end, limit = 6) {
  const taken = [];
  for (let cursor = end - 1; cursor >= 0 && taken.length < limit; cursor -= 1) {
    const token = tokens[cursor];
    if (NOUN_PHRASE_BREAKS.has(token.w) || PRONOUNS.has(token.w)) break;
    taken.unshift(token);
    if (CLAUSE_GAP_RE.test(token.gap) || /,/u.test(token.gap)) break;
  }
  return taken;
}

// "Stood up the service", "set up the desk": the verb is followed directly by the particle that makes the pair a verb of making.
const isPhrasalMaking = (tokens, index) => {
  const particle = PHRASAL_PARTICLES.get(actionStem(tokens[index].w));
  const next = tokens[index + 1];
  return Boolean(particle) && next?.w === particle && !CLAUSE_GAP_RE.test(next.gap) && !/,/u.test(next.gap);
};

// What an action acts on: its direct object (`np`), and the terms of the wider reach of its clause up to the next
// action of the candidate, a relative pronoun or a break (`reach`). An action in a relative clause of the candidate's
// own ("the jobs that I maintain") acts on what the clause is about.
function actionScopes(tokens, found) {
  const scopes = found.map((entry, at) => {
    const next = found[at + 1]?.index ?? tokens.length;
    const objectFrom = entry.index + 1 + (isPhrasalMaking(tokens, entry.index) ? 1 : 0);
    let np = nounPhraseAt(tokens, objectFrom, next);
    const reach = [];
    let cursor = objectFrom;
    for (; cursor < next && reach.length < 10; cursor += 1) {
      if (CLAUSE_GAP_RE.test(tokens[cursor].gap) || RELATIVES.has(tokens[cursor].w)) break;
      reach.push(tokens[cursor]);
    }
    if (!np.length && /^(?:i|we)$/u.test(tokens[entry.index - 1]?.w || '') && RELATIVES.has(tokens[entry.index - 2]?.w)) {
      np = phraseBefore(tokens, entry.index - 2);
      reach.unshift(...np);
    }
    // Nothing but a coordinator or an adverb between this action and the next one of the candidate.
    const adjacent = at + 1 < found.length && cursor >= next && np.length === 0 && reach.every(token => COORDINATORS.has(token.w) || isAdverb(token.w));
    return { np, reach, adjacent };
  });
  // "Designed and built the jobs": an action with nothing of its own to act on shares the object of the one it is coordinated to.
  for (let at = scopes.length - 2; at >= 0; at -= 1) {
    if (!scopes[at].adjacent) continue;
    scopes[at].np = scopes[at + 1].np;
    scopes[at].reach = scopes[at + 1].reach;
  }
  return scopes;
}

/**
 * The actions of a text the candidate is the actor of, in reading order:
 * `{ word, stem, cls, position, sentence, index, making, pronounObject, particle, np, reachTerms }`. `cls` is the verb's role-strength
 * class from the vocabulary above (the creation class for a phrasal pair such as "set up", whose `word` holds both
 * words), or null for a verb the vocabulary does not class; `np` is the noun phrase the
 * action acts on, as `{ terms, head }`, and `reachTerms` the terms of its clause that follow it.
 */
export function candidateActions(text) {
  const found = [];
  sentencesOf(text).forEach((sentence, sentenceIndex) => {
    const tokens = tokenize(sentence);
    const own = ownActionPositions(tokens, clauseStarts(tokens));
    const scopes = actionScopes(tokens, own);
    own.forEach(({ index, position }, at) => {
      const token = tokens[index];
      const stem = actionStem(token.w);
      const phrasal = isPhrasalMaking(tokens, index);
      const following = tokens[index + 1];
      found.push({
        word: phrasal ? `${token.raw} ${following.raw}` : token.raw, stem, cls: phrasal ? CREATE_CLASS : classByStem.get(stem) || null, position, sentence, sentenceIndex, index,
        making: phrasal || makingStems.has(stem), np: phraseOf(scopes[at].np), reachTerms: phraseOf(scopes[at].reach).terms,
        // The object is a pronoun ("migrated it"): it names the thing the sentence around it names.
        pronounObject: PRONOUN_OBJECTS.has(tokens[index + 1 + (phrasal ? 1 : 0)]?.w),
        // A particle right after the verb ("backed up the ledger"): a phrasal verb, not a verb acting directly on what follows.
        particle: !phrasal && following && VERB_PARTICLES.has(following.w) && !CLAUSE_GAP_RE.test(following.gap) && !/,/u.test(following.gap) ? following.w : '',
      });
    });
  });
  return found;
}

// ---------------------------------------------------------------------------
// The assertions a statement makes: support of a work that carries out an action
// ---------------------------------------------------------------------------

const verbSuffixCategory = word => {
  if (word.endsWith('ing') && word.length > 4) return 'ing';
  if (word.endsWith('ed') && word.length > 3) return 'ed';
  if (word.endsWith('s') && !/(?:ss|us|is)$/u.test(word)) return 's';
  return 'base';
};

function skipAdverbs(tokens, index) {
  let cursor = index;
  while (tokens[cursor] && adverbAt(tokens, cursor)) cursor += 1;
  return cursor;
}

/** The action verbs a connector hands to the work it follows, or [] when the clause names another actor or has none. */
function actionVerbsAfter(tokens, connectorIndex, kind) {
  let cursor = kind === 'participial' ? connectorIndex : skipAdverbs(tokens, connectorIndex + 1);
  if (kind === 'relative') {
    const lead = tokens[cursor]?.w;
    if (!lead || DETERMINERS.has(lead) || PRONOUNS.has(lead)) return [];
    if (AUXILIARIES.has(lead)) {
      cursor = skipAdverbs(tokens, cursor + 1);
      // "that was approved" is a passive: the work performs nothing. "that was compiling" is active.
      if (BE_FORMS.has(lead) && !(tokens[cursor]?.w || '').endsWith('ing')) return [];
    }
  }
  const verb = tokens[cursor];
  if (!verb || !isWordLike(verb.w) || AUXILIARIES.has(verb.w) || DETERMINERS.has(verb.w) || PREPOSITIONS.has(verb.w)
    || PRONOUNS.has(verb.w) || isStativeForm(verb.w)) return [];
  const verbs = [verb];
  // A coordinated verb handed to the same work: "that compiles and checks ...", "compiling, checking ...".
  for (let extra = 0; extra < 2; extra += 1) {
    const last = verbs[verbs.length - 1];
    const lastIndex = tokens.indexOf(last);
    const joined = tokens[lastIndex + 1];
    if (!joined) break;
    const candidate = (joined.w === 'and' || joined.w === 'or') ? tokens[lastIndex + 2] : (/,/u.test(joined.gap) && !PREPOSITIONS.has(joined.w) ? joined : null);
    if (!candidate || !isWordLike(candidate.w) || AUXILIARIES.has(candidate.w) || DETERMINERS.has(candidate.w) || PREPOSITIONS.has(candidate.w)
      || PRONOUNS.has(candidate.w) || verbSuffixCategory(candidate.w) !== verbSuffixCategory(verb.w)) break;
    verbs.push(candidate);
  }
  return verbs;
}

// A comma-led gerund that is one more item of a list of duties ("maintenance, patching, and monitoring")
// is not a participle handed to the work, and a verb with nothing after it has no action to hand over.
function continuesGerundList(tokens, verb) {
  const at = tokens.indexOf(verb);
  for (let cursor = at + 1; cursor < tokens.length && cursor <= at + 7; cursor += 1) {
    const token = tokens[cursor];
    if (CLAUSE_GAP_RE.test(token.gap)) return false;
    const listed = /,/u.test(token.gap) || COORDINATORS.has(tokens[cursor - 1].w);
    const word = COORDINATORS.has(token.w) ? tokens[cursor + 1]?.w : token.w;
    if (listed && word && word.endsWith('ing') && word.length > 4) return true;
  }
  return false;
}

// A verb handed to the work takes a direct object ("recording soil readings"); one followed by a preposition or
// nothing is as often one more duty in a list ("monitoring, alerting on failures") as an action of the work.
function hasObjectAfter(tokens, verb) {
  const next = tokens[tokens.indexOf(verb) + 1];
  return Boolean(next) && !COORDINATORS.has(next.w) && !PREPOSITIONS.has(next.w) && !CLAUSE_GAP_RE.test(next.gap) && !/,/u.test(next.gap);
}

const NOUN_PHRASE_BREAKS = new Set([...PREPOSITIONS, ...COORDINATORS, ...RELATIVES, ...AUXILIARIES, 'not']);
const NEW_PHRASE_WORDS = new Set(['each', 'every']);

function objectTermsAfter(tokens, lastVerb) {
  const from = tokens.indexOf(lastVerb) + 1;
  const words = [];
  for (let cursor = from; cursor < tokens.length && words.length < 10; cursor += 1) {
    if (CLAUSE_GAP_RE.test(tokens[cursor].gap)) break;
    if (RELATIVES.has(tokens[cursor].w)) break;
    words.push(tokens[cursor].raw);
  }
  return relatednessTerms(words.join(' '));
}

function nounAssertions(tokens, starts, sentence) {
  const found = [];
  tokens.forEach((token, head) => {
    if (!headStems.has(token.w)) return;
    const clauseStart = clauseStartOf(starts, head);
    const previous = tokens[head - 1];
    const ambiguous = AMBIGUOUS_HEADS.has(token.w);
    // An ambiguous word is a head only after something that is not a verb marker ("application support"),
    // never as the verb itself ("to support users", "I support teams").
    const takesWork = ['of', 'for', 'on', 'over'].includes(tokens[head + 1]?.w);
    if (ambiguous && ((head <= clauseStart && !takesWork) || (previous && (AUXILIARIES.has(previous.w) || PRONOUNS.has(previous.w)
      || RELATIVES.has(previous.w) || previous.w === 'to' || COORDINATORS.has(previous.w))))) return;
    // A work the candidate made is not support of it: "Built monitoring that tracks ...".
    if (tokens.slice(clauseStart, head).some(entry => coreMakingStems.has(actionStem(entry.w)) && isParticipleForm(entry.w))) return;
    // The work before the head: "<work> maintenance".
    let artifactFrom = head;
    while (artifactFrom > clauseStart && head - artifactFrom < 4) {
      const candidate = tokens[artifactFrom - 1];
      if (NOUN_PHRASE_BREAKS.has(candidate.w) || /,/u.test(tokens[artifactFrom].gap) || (isParticipleForm(candidate.w) && /ed$/u.test(candidate.w))) break;
      artifactFrom -= 1;
    }
    let artifact = tokens.slice(artifactFrom, head);
    let connectorIndex = -1;
    let kind = '';
    const after = tokens[head + 1];
    if (after && (['of', 'for', 'on', 'over'].includes(after.w))) {
      // The work after the head: "maintenance of <work> that ...".
      let cursor = head + 2;
      for (; cursor < tokens.length && cursor <= head + 8; cursor += 1) {
        if (relativeIntro(tokens[cursor])) break;
        if (CLAUSE_GAP_RE.test(tokens[cursor].gap) || COORDINATORS.has(tokens[cursor].w)) { cursor = -1; break; }
        if (RELATIVES.has(tokens[cursor].w) || (isParticipleForm(tokens[cursor].w) && /ing$/u.test(tokens[cursor].w) && /,/u.test(tokens[cursor].gap))) break;
      }
      if (cursor > 0 && cursor < tokens.length && cursor > head + 2) {
        artifact = tokens.slice(head + 2, cursor);
        connectorIndex = cursor;
        kind = RELATIVES.has(tokens[cursor].w) ? 'relative' : 'participial';
      }
    } else if (after) {
      if (RELATIVES.has(after.w)) { connectorIndex = head + 1; kind = 'relative'; }
      else if (after.w === 'to' && tokens[head + 2] && !DETERMINERS.has(tokens[head + 2].w) && !PRONOUNS.has(tokens[head + 2].w)
        && isWordLike(tokens[head + 2].w) && !PREPOSITIONS.has(tokens[head + 2].w)) { connectorIndex = head + 1; kind = 'purpose'; }
      else if (/,/u.test(after.gap) && after.w.endsWith('ing') && after.w.length > 4) { connectorIndex = head + 1; kind = 'participial'; }
    }
    if (connectorIndex < 0) return;
    const verbs = kind === 'purpose' ? purposeVerb(tokens, connectorIndex) : actionVerbsAfter(tokens, connectorIndex, kind);
    if (!verbs.length) return;
    if (kind !== 'relative' && (!hasObjectAfter(tokens, verbs[verbs.length - 1]) || (kind === 'participial' && continuesGerundList(tokens, verbs[0])))) return;
    found.push(buildAssertion({ kind: 'noun', head: token.raw, headStem: headStems.get(token.w), tokens, artifact, verbs, connector: kind, sentence }));
  });
  return found;
}

// "<support> to keep the reports current": an infinitive, in its base form (a plural after "to" is a noun: "assistance to analysts").
function purposeVerb(tokens, toIndex) {
  const verb = tokens[skipAdverbs(tokens, toIndex + 1)];
  if (!verb || !isWordLike(verb.w) || AUXILIARIES.has(verb.w) || isStativeForm(verb.w) || verbSuffixCategory(verb.w) !== 'base') return [];
  return [verb];
}

// A relative pronoun that opens a non-restrictive clause (", which routes ...") or a parenthesis ("(which routes ...)").
const relativeIntro = token => RELATIVES.has(token.w) && /^[\s,(]*$/u.test(token.gap);

const isGerund = word => isWordLike(word) && word.endsWith('ing') && word.length > 4;
const isPluralNoun = word => isWordLike(word) && /s$/u.test(word) && !/(?:ss|us|is)$/u.test(word)
  && !AUXILIARIES.has(word) && !DETERMINERS.has(word) && !PREPOSITIONS.has(word) && !PRONOUNS.has(word) && !COORDINATORS.has(word);
// A participle after a plural work that more often states the candidate's purpose or outcome ("Maintained accounts
// ensuring least-privilege access"), or only that the work is in use ("servers running ..."), than what the work does;
// only a reduced relative of an operating work is read.
const SOFT_PARTICIPLES = new Set(['ensure', 'enable', 'allow', 'provide', 'improve', 'reduce', 'increase', 'maximize', 'minimize', 'achieve', 'deliver',
  'drive', 'meet', 'satisfy', 'guarantee', 'secure', 'protect', 'prevent', 'optimize', 'boost', 'cut', 'save', 'lower', 'raise', 'avoid', 'eliminate',
  'speed', 'accelerate', 'streamline', 'enhance', 'promote', 'foster', 'facilitate', 'run', 'operate', 'work', 'function'].map(verb => relatednessStem(verb)));

// "Maintained <works> compiling <object>": a gerund right after a plural work, with an object, that is not one more
// item of a list of duties, a support verb itself, or a stative, instrumental or soft verb ("including", "using", "ensuring").
function startsReducedRelative(tokens, supportIndex, at) {
  const gerund = tokens[at];
  if (!isGerund(gerund.w) || at - 1 <= supportIndex || !isPluralNoun(tokens[at - 1].w)) return false;
  const stem = actionStem(gerund.w);
  if (supportStems.has(stem) || isStativeForm(gerund.w) || SOFT_PARTICIPLES.has(stem) || AUXILIARIES.has(gerund.w)) return false;
  return hasObjectAfter(tokens, gerund) && !continuesGerundList(tokens, gerund);
}

function verbAssertions(tokens, starts, sentence) {
  const found = [];
  for (const { index } of ownActionPositions(tokens, starts)) {
    const token = tokens[index];
    if (!supportStems.has(actionStem(token.w))) continue;
    // The work the support verb takes: a short phrase up to a relative pronoun (restrictive, after a comma, or in a
    // parenthesis) or a plural work's participle, never across a coordinator or a punctuation break.
    let cursor = index + 1;
    let kind = '';
    for (; cursor < tokens.length && cursor <= index + 12; cursor += 1) {
      const entry = tokens[cursor];
      if (relativeIntro(entry)) { kind = 'relative'; break; }
      if (CLAUSE_GAP_RE.test(entry.gap) || COORDINATORS.has(entry.w) || /,/u.test(entry.gap)) break;
      if (RELATIVES.has(entry.w)) { kind = 'relative'; break; }
      if (startsReducedRelative(tokens, index, cursor)) { kind = 'participial'; break; }
    }
    if (!kind || cursor === index + 1) continue;
    const artifact = tokens.slice(index + 1, cursor);
    const verbs = actionVerbsAfter(tokens, cursor, kind);
    if (!verbs.length) continue;
    found.push(buildAssertion({ kind: 'verb', head: token.raw, headStem: actionStem(token.w), tokens, artifact, verbs, connector: kind, sentence }));
  }
  return found;
}

// A support verb whose object is an activity the candidate only took part in: "Assisted <people> in building
// <thing>", "Contributed to <V>ing <thing>", "Helped build <thing>". The activity must be one the vocabulary classes
// and must have a determiner or a number for its object, so a noun ("building inspections", "code review") is not read as one.
const FRAME_STEMS = new Set(['help', 'assist', 'aid', 'participate', 'contribute', 'support'].map(actionStem));
const HELP_STEMS = new Set(['help', 'assist', 'aid'].map(actionStem));
const FRAME_PREPOSITIONS = new Set(['in', 'with', 'on', 'to']);

const classedActivity = word => {
  const klass = classByStem.get(actionStem(word));
  return Boolean(klass) && klass.id !== 'support';
};
const startsObject = (tokens, at) => Boolean(tokens[at]) && !CLAUSE_GAP_RE.test(tokens[at].gap) && (DETERMINERS.has(tokens[at].w) || /^\d/u.test(tokens[at].w));
const isBaseVerb = word => isWordLike(word) && verbSuffixCategory(word) === 'base' && !isPastForm(word) && !AUXILIARIES.has(word) && !DETERMINERS.has(word)
  && !PREPOSITIONS.has(word) && !PRONOUNS.has(word) && !COORDINATORS.has(word) && !RELATIVES.has(word);

function frameAssertions(tokens, starts, sentence) {
  const found = [];
  for (const { index } of ownActionPositions(tokens, starts)) {
    const token = tokens[index];
    const stem = actionStem(token.w);
    if (!FRAME_STEMS.has(stem)) continue;
    let verb = null;
    for (let cursor = index + 1; cursor < tokens.length && cursor <= index + 8 && !verb; cursor += 1) {
      const entry = tokens[cursor];
      if (CLAUSE_GAP_RE.test(entry.gap) || COORDINATORS.has(entry.w) || RELATIVES.has(entry.w) || /,/u.test(entry.gap)) break;
      if (FRAME_PREPOSITIONS.has(entry.w)) {
        const gerund = tokens[cursor + 1];
        if (gerund && isGerund(gerund.w) && classedActivity(gerund.w) && startsObject(tokens, cursor + 2)) verb = gerund;
      } else if (HELP_STEMS.has(stem) && cursor <= index + 4 && isBaseVerb(entry.w) && classedActivity(entry.w) && startsObject(tokens, cursor + 1)) {
        verb = entry;
      }
    }
    if (!verb) continue;
    const artifact = nounPhraseAt(tokens, tokens.indexOf(verb) + 1);
    if (!artifact.length) continue;
    found.push(buildAssertion({ kind: 'frame', head: token.raw, headStem: stem, tokens, artifact, verbs: [verb], connector: 'frame', sentence }));
  }
  return found;
}

// A statement that puts the candidate IN the group that carried out an activity ("Member of the team that migrated the donor
// database", "Worked with the crew that rebuilt the signage", "On the committee that drafted the policy"): the activity is the
// group's, and the candidate's part in it is membership, not authorship. The group is a collective noun followed by a relative
// pronoun and a verb that has an object; the word before the group is a preposition of belonging ("on", "in", "within", "with",
// "among", "alongside") or, for "of", a word for belonging ("member", "part"). Leading the group is another statement ("Led the
// team that ...") and is not read here.
const MEMBER_WORDS = new Set(['member', 'members', 'part', 'participant', 'participants', 'contributor', 'contributors']);
const GROUP_NOUNS = new Set(['team', 'teams', 'group', 'groups', 'squad', 'squads', 'crew', 'crews', 'committee', 'committees', 'taskforce', 'department', 'departments', 'cohort', 'collective', 'workforce', 'organization', 'organisation', 'council']);
const BELONGING_PREPOSITIONS = new Set(['on', 'in', 'within', 'with', 'among', 'alongside']);
const COMPANION_WORDS = new Set(['alongside', 'jointly', 'together', 'colleagues', 'coworkers', 'teammates', 'peers']);
const WITH_WORDS = new Set(['with', 'within', 'among', 'alongside', 'on']);
const COMPANION_PREFIXES = ['collaborat', 'cooperat', 'partner'];

function teamAssertions(tokens, starts, sentence) {
  const found = [];
  tokens.forEach((relative, at) => {
    if (!RELATIVES.has(relative.w) || at < 2 || CLAUSE_GAP_RE.test(relative.gap)) return;
    if (!GROUP_NOUNS.has(tokens[at - 1].w)) return;
    const clauseStart = clauseStartOf(starts, at);
    // The modifiers and determiner before the group noun.
    let cursor = at - 2;
    let modifiers = 0;
    while (cursor >= clauseStart && modifiers < 4 && !NOUN_PHRASE_BREAKS.has(tokens[cursor].w) && !DETERMINERS.has(tokens[cursor].w) && !/,/u.test(tokens[cursor + 1].gap)) { cursor -= 1; modifiers += 1; }
    if (cursor >= clauseStart && DETERMINERS.has(tokens[cursor].w)) cursor -= 1;
    const preposition = cursor >= clauseStart ? tokens[cursor] : null;
    if (!preposition || !(preposition.w === 'of' || BELONGING_PREPOSITIONS.has(preposition.w))) return;
    const lead = cursor - 1 >= clauseStart ? tokens[cursor - 1] : null;
    const isMember = Boolean(lead && MEMBER_WORDS.has(lead.w));
    // "of" needs a word for belonging before it ("the budget of the team that ..." is not belonging).
    if (preposition.w === 'of' && !isMember) return;
    const verbs = actionVerbsAfter(tokens, at, 'relative');
    if (!verbs.length) return;
    const artifact = nounPhraseAt(tokens, tokens.indexOf(verbs[verbs.length - 1]) + 1);
    if (!artifact.length) return;
    const from = isMember ? cursor - 1 : cursor;
    found.push(buildAssertion({
      kind: 'team', head: tokens.slice(from, at).map(token => token.raw).join(' '), headStem: isMember ? relatednessStem(lead.w) : '',
      tokens, artifact, verbs, connector: 'team', sentence,
    }));
  });
  return found;
}

function buildAssertion({ kind, head, headStem, tokens, artifact, verbs, connector, sentence }) {
  const verbStems = verbs.map(verb => actionStem(verb.w));
  const lastVerb = verbs[verbs.length - 1];
  // The work is the first noun phrase of what the statement says ("the nightly report jobs" of "the nightly report jobs for
  // the finance team"), after any leading preposition ("in the rollout"); its terms are all the phrase's.
  let artifactFrom = 0;
  while (artifactFrom < artifact.length - 1 && PREPOSITIONS.has(artifact[artifactFrom].w)) artifactFrom += 1;
  const firstPhrase = phraseOf(nounPhraseAt(artifact, artifactFrom));
  const artifactPhrase = { terms: phraseOf(artifact).terms, head: firstPhrase.head };
  const objectPhrase = phraseOf(nounPhraseAt(tokens, tokens.indexOf(lastVerb) + 1));
  const artifactTerms = new Set(artifactPhrase.terms);
  const objectTerms = new Set(objectPhrase.terms);
  const terms = new Set([...artifactTerms, ...objectTermsAfter(tokens, lastVerb)]);
  for (const stem of [...verbStems, headStem]) { terms.delete(stem); artifactTerms.delete(stem); objectTerms.delete(stem); }
  const artifactList = [...artifactTerms];
  const dropped = new Set([...verbStems, headStem]);
  return {
    kind, head, headStem, connector,
    // The terms of the first noun phrase alone: the work as the statement names it, without what follows it.
    workTerms: firstPhrase.terms.filter(term => !dropped.has(term)),
    artifact: artifact.map(token => token.raw).join(' '),
    verbs: verbs.map(verb => ({ word: verb.raw, stem: actionStem(verb.w) })),
    terms: [...terms],
    artifactTerms: artifactList,
    // The work's head noun ("the nightly report jobs" -> "job") and the head of what its action acts on.
    artifactHead: artifactList.includes(artifactPhrase.head) ? artifactPhrase.head : (artifactList[artifactList.length - 1] || ''),
    objectTerms: [...objectTerms],
    objectHead: objectTerms.has(objectPhrase.head) ? objectPhrase.head : '',
    sentence,
  };
}

/** The support assertions of one statement (see the mechanism above): `{ kind, head, headStem, artifact, verbs, terms, artifactTerms, artifactHead, objectTerms, objectHead, connector, sentence }`. */
export function supportAssertions(statement) {
  const found = [];
  for (const sentence of sentencesOf(statement)) {
    const tokens = tokenize(sentence);
    const starts = clauseStarts(tokens);
    found.push(...nounAssertions(tokens, starts, sentence), ...verbAssertions(tokens, starts, sentence), ...frameAssertions(tokens, starts, sentence),
      ...teamAssertions(tokens, starts, sentence));
  }
  return found;
}

// ---------------------------------------------------------------------------
// Statements: what the cited quotes were said in
// ---------------------------------------------------------------------------

const normalizeStatement = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
const comparable = value => normalizeStatement(value).replace(/^[\s\-*•]+/u, '').toLowerCase();
const MIN_EXCERPT_CHARS = 12;
const MAX_CORPUS_STATEMENTS = 6;
// A career-text line this short is one statement and is read whole (its other sentences may say the candidate made
// the work). A longer one is a joined text, and only the sentences that contain the excerpt are the statement.
const MAX_STATEMENT_CHARS = 600;

let corpusMemo = { corpus: null, lines: [] };

function corpusStatementsContaining(corpus, bodies) {
  if (typeof corpus !== 'string' || !corpus) return [];
  if (corpusMemo.corpus !== corpus) {
    corpusMemo = { corpus, lines: corpus.split(/\n+/u).map(line => ({ raw: normalizeStatement(line), key: comparable(line) })).filter(line => line.key) };
  }
  const found = [];
  for (const body of bodies) {
    const key = comparable(body);
    if (key.length < MIN_EXCERPT_CHARS) continue;
    for (const line of corpusMemo.lines) {
      if (line.key.length <= key.length || !line.key.includes(key)) continue;
      if (line.raw.length <= MAX_STATEMENT_CHARS) found.push(line.raw);
      else found.push(...sentencesOf(line.raw).filter(sentence => comparable(sentence).length > key.length && comparable(sentence).includes(key)));
      if (found.length >= MAX_CORPUS_STATEMENTS) return found.slice(0, MAX_CORPUS_STATEMENTS);
    }
  }
  return found;
}

/**
 * The statements a sentence is read against. `quotes` are the quotes the unit
 * cites; `statements` are fuller statements of the same entity (the host
 * projection of a quote that excerpts one); `corpus` is a career-data text in
 * which the cited quotes occur as part of a longer line. A statement that is
 * contained in another is an excerpt and is not read: the one it was cut from
 * says how the candidate stood to the work.
 */
export function roleStrengthStatements(quotes, { statements = [], corpus = '' } = {}) {
  const bodies = [];
  const seen = new Set();
  const add = value => {
    const body = normalizeStatement(evidenceBody(value));
    const key = comparable(body);
    if (!key || seen.has(key)) return;
    seen.add(key);
    bodies.push(body);
  };
  const cited = (Array.isArray(quotes) ? quotes : []).map(value => normalizeStatement(evidenceBody(value))).filter(Boolean);
  cited.forEach(add);
  (Array.isArray(statements) ? statements : []).forEach(add);
  corpusStatementsContaining(corpus, cited).forEach(add);
  return bodies.filter(body => {
    const key = comparable(body);
    return !(key.length >= MIN_EXCERPT_CHARS && bodies.some(other => other !== body && comparable(other).length > key.length && comparable(other).includes(key)));
  });
}

// ---------------------------------------------------------------------------
// The finding
// ---------------------------------------------------------------------------

const MAX_FINDINGS = 2;

const SUPPORT_CLASS = ROLE_STRENGTH_CLASSES[0];
const PERFORM_CLASS = ROLE_STRENGTH_CLASSES[1];
const CREATE_CLASS = ROLE_STRENGTH_CLASSES[2];

const clipWords = (text, count = 14) => {
  const words = normalizeStatement(text).split(' ');
  return words.length > count ? `${words.slice(0, count).join(' ')}…` : words.join(' ');
};

// Do these terms name the work: the work's head noun, and at least two of its terms (all of them when it has one)?
const sharesWork = (terms, wanted, head) => Boolean(wanted.length && head) && terms.includes(head)
  && wanted.filter(term => terms.includes(term)).length >= Math.min(2, wanted.length);

// A noun phrase names the work when it ENDS in the work's head noun ("rebuilt the nightly report jobs", not "built a
// dashboard for the report jobs") and shares most of its terms.
const namesArtifact = (phrase, assertion) => phrase.head === assertion.artifactHead && sharesWork(phrase.terms, assertion.artifactTerms, assertion.artifactHead);
// ... or the object the work's action acts on ("compiled ledger summaries").
const namesObject = (phrase, assertion) => phrase.head === assertion.objectHead && sharesWork(phrase.terms, assertion.objectTerms, assertion.objectHead);

// Does a clause reach the work? Its terms hold the work's head noun and at least two of its terms.
const reachesWork = (terms, assertion) => sharesWork(terms, assertion.artifactTerms, assertion.artifactHead);

// Does the text state a support role for the work? Only the candidate's own support verb counts, and only
// when its object or reach is the work ("Maintained the nightly jobs", "while maintaining the jobs"): a word that is
// a support word as a noun in some other phrase ("the financial services team", "a support desk") states nothing, and
// neither does a support verb about some other work. The one other statement of the role is the support noun the
// source itself used, beside the work and either close after another action of the text ("Provided <work>
// maintenance, ...") or as the candidate's role ("..., as the <work> maintenance lead").
function supportStated(assertion, matched, claimActions) {
  const siblings = claimActions.filter(action => action.sentenceIndex === matched.sentenceIndex && action !== matched);
  for (const action of siblings) {
    if (action.cls?.id !== SUPPORT_CLASS.id) continue;
    if (!assertion.artifactTerms.length || reachesWork(action.reachTerms, assertion)) return true;
  }
  const tokens = tokenize(matched.sentence);
  // Belonging to a group is stated by a word for belonging or for working with others anywhere in the claim's sentence ("as
  // part of the platform group", "alongside two analysts", "collaborated"), or by a group the candidate is WITH ("with a team of
  // six", "within the crew"). A group the work was done FOR ("for the planning team") states nothing about the candidate's part.
  if (assertion.kind === 'team') {
    return tokens.some((token, index) => MEMBER_WORDS.has(token.w) || COMPANION_WORDS.has(token.w) || COMPANION_PREFIXES.some(prefix => token.w.startsWith(prefix))
      || (GROUP_NOUNS.has(token.w) && tokens.slice(Math.max(0, index - 4), index).some(entry => WITH_WORDS.has(entry.w))));
  }
  const reach = assertion.artifactTerms.length ? 6 : 3;
  return tokens.some((token, index) => {
    if (!isWordLike(token.w) || !sameRootStem(relatednessStem(token.w), assertion.headStem)) return false;
    const previousWord = tokens[skipBack(tokens, index)]?.w || '';
    if (RELATIVES.has(previousWord) || DETERMINERS.has(previousWord)) return false;
    const asRole = tokens.slice(Math.max(0, index - 7), index).some(entry => entry.w === 'as');
    if (!asRole && !siblings.some(action => index > action.index && index - action.index <= reach)) return false;
    if (!assertion.artifactTerms.length) return true;
    return reachesWork(relatednessTerms(tokens.slice(Math.max(0, index - 4), index + 5).map(entry => entry.raw).join(' ')), assertion);
  });
}

// The index of the nearest earlier token that is not an adverb, or -1.
function skipBack(tokens, index) {
  let cursor = index - 1;
  while (cursor >= 0 && adverbAt(tokens, cursor)) cursor -= 1;
  return cursor;
}

// Do two noun phrases name one thing? The same head noun, and at least two of their terms in common (all of them when
// one phrase has a single term).
const samePhrase = (left, right) => Boolean(left.head) && left.head === right.head
  && left.terms.filter(term => right.terms.includes(term)).length >= Math.min(2, left.terms.length, right.terms.length);

// A statement in which the candidate made the work, or did the action itself, about the same work. Decided by the
// clause that states it: the noun phrase the verb acts on has to name the work (a verb that makes something), or
// name what the work's action acts on (the very verb the work performs), or name what the claim itself acts on (the
// candidate did the claimed action on the claimed thing, which is what the claim says). The sentence around it
// decides nothing: a clause that builds some other thing, or two generic words in common, is not the same work.
// `creationOnly` is the release for a claim that makes the candidate the maker of the work itself: the candidate
// having done V says nothing about having made the work that does it.
function authoredBy(statementActions, assertion, claimed, { creationOnly = false } = {}) {
  return statementActions.some(action => {
    const sameAction = !creationOnly && assertion.verbs.some(verb => sameActionStem(verb.stem, action.stem));
    if (action.cls?.id === SUPPORT_CLASS.id && !sameAction) return false;
    if (!action.making && !sameAction) return false;
    if (namesArtifact(action.np, assertion) || (sameAction && namesObject(action.np, assertion))) return true;
    // The candidate's own statement of the very action the claim makes, on the very thing the claim makes it on.
    const sameAsClaim = sameActionStem(action.stem, claimed.stem) || (action.making && claimed.making);
    return sameAsClaim && samePhrase(action.np, claimed.np);
  });
}

// Does a statement say the candidate did the claimed act themself, to the claimed thing (or to "it", which the statement
// then leaves to the sentence around it)? The release for a claim whose verb the vocabulary cannot class.
const statedByCandidate = (statementActions, claimed) => statementActions.some(action => sameActionStem(action.stem, claimed.stem)
  && (samePhrase(action.np, claimed.np) || action.pronounObject));

// The exact frame of an act the vocabulary cannot class: the claim's verb opens its clause (or follows "I"/"we"), is no verb of
// sustaining, and acts directly on the supported work as the statement names it, with at most one more modifier ("Shipped the
// new <work>"). Anywhere else an unclassed verb says nothing about the candidate's part and is left alone.
function actsOnSupportedWorkUnclassed(action, assertion) {
  if (action.cls || action.particle || (action.position !== 'initial' && action.position !== 'subject') || sustainingStems.has(action.stem)) return false;
  if (assertion.kind === 'frame' || sameRootStem(action.stem, assertion.headStem) || !assertion.workTerms.length) return false;
  return action.np.head === assertion.artifactHead && assertion.workTerms.every(term => action.np.terms.includes(term))
    && action.np.terms.length <= assertion.workTerms.length + 1;
}

// The class a claim stands at when it takes over an action the evidence gives the work: the perform rung at the
// least, or the verb's own rung when the vocabulary ranks it higher. A support verb that IS the work's action
// ("administered") is the candidate performing it here, not stating a support role.
const claimedClass = action => (action.cls && action.cls.rank >= PERFORM_CLASS.rank ? action.cls : PERFORM_CLASS);

/**
 * Role-strength findings of a sentence (a résumé bullet, or a first-person
 * letter sentence) against the statements its quotes were said in. Each finding
 * is `{ code: 'role-strength', shape, claimVerb, claimClass, sourceVerb, head, headKind, snippet, artifact }`
 * where `shape` is 'action' (the claim takes an action the evidence gives the
 * supported work), 'creation' (the claim presents the candidate as the maker of
 * the supported work itself) or 'unclassified' (a verb outside the vocabulary
 * acts directly on the supported work, in the exact frame described above).
 * Fail-closed: a sentence that makes the candidate the actor of an action the
 * evidence gives to a supported work, states no support role for that work, and
 * has no statement that the candidate made the work or did the action, is a finding;
 * so is a sentence that makes the candidate the maker of the supported work when no
 * statement says so.
 */
export function roleStrengthFindings(text, quotes, options = {}) {
  const claimActions = candidateActions(text);
  if (!claimActions.length) return [];
  const bodies = roleStrengthStatements(quotes, options);
  const assertions = bodies.flatMap(body => supportAssertions(body));
  if (!assertions.length) return [];
  const statementActions = bodies.flatMap(body => candidateActions(body));
  const claimTerms = new Set(relatednessTerms(text));
  const findings = [];
  const reported = new Set();
  for (const assertion of assertions) {
    for (const action of claimActions) {
      const matchedVerb = assertion.verbs.find(verb => sameActionStem(verb.stem, action.stem));
      let shape = '';
      if (matchedVerb) {
        // The head's own activity ("operated" for "operation") is the support role itself.
        if (sameRootStem(action.stem, assertion.headStem)) continue;
        const related = assertion.terms.length === 0
          || assertion.terms.some(term => claimTerms.has(term) && !sameActionStem(term, action.stem));
        if (!related || supportStated(assertion, action, claimActions) || authoredBy(statementActions, assertion, action)) continue;
        shape = 'action';
      } else if (action.making && action.cls.rank >= SUPPORT_CLASS.rank + 2 && namesArtifact(action.np, assertion)) {
        if (authoredBy(statementActions, assertion, action, { creationOnly: true })) continue;
        shape = 'creation';
      } else if (actsOnSupportedWorkUnclassed(action, assertion)) {
        // Fail closed, in this one frame only: a verb the vocabulary does not class, acting directly on the work the statement
        // gives to someone else's action, with nothing said about the candidate's part.
        if (authoredBy(statementActions, assertion, action, { creationOnly: true }) || statedByCandidate(statementActions, action)
          || supportStated(assertion, action, claimActions)) continue;
        shape = 'unclassified';
      } else continue;
      const key = `${action.sentenceIndex}|${action.index}|${assertion.headStem}`;
      if (reported.has(key)) continue;
      reported.add(key);
      findings.push({
        code: 'role-strength',
        shape,
        claimVerb: action.word,
        claimClass: claimedClass(action).claimed,
        sourceVerb: (matchedVerb || assertion.verbs[0]).word,
        head: assertion.head,
        headKind: assertion.kind,
        artifact: assertion.artifact,
        snippet: clipWords(assertion.sentence),
      });
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}

/**
 * The writer-facing observation for one finding: the class mismatch, stated as an
 * observation, and the two repairs that are faithful. Neither repair is a word to
 * copy: one holds the candidate to the support role the statement gives, the other
 * is available only where the career data really says the candidate did it.
 */
export function describeRoleStrengthFinding(unit, finding) {
  const q = value => `“${value}”`;
  let part = `the candidate's part is ${q(finding.head)}`;
  if (finding.headKind === 'verb') part = `the candidate ${q(finding.head)} the work`;
  if (finding.headKind === 'frame') part = `the candidate ${q(finding.head)} in ${q(finding.sourceVerb)} the work, not that the candidate alone did it`;
  if (finding.headKind === 'team') part = `the candidate's part is ${q(finding.head)}, a group that ${q(finding.sourceVerb)} the work, not the candidate alone`;
  const gives = finding.headKind === 'frame' || finding.headKind === 'team' ? '' : ` and gives ${q(finding.sourceVerb)} to the work itself`;
  let lead = `${unit} presents the candidate as the actor of ${q(finding.claimVerb)}, but a bound career-data statement (${q(finding.snippet)}) says ${part}${gives}.`;
  if (finding.shape === 'creation') {
    lead = `${unit} presents the candidate as the maker of ${q(finding.claimVerb)} ${q(finding.artifact)}, but a bound career-data statement (${q(finding.snippet)}) says ${part}${gives}, and no cited statement says the candidate made it.`;
  } else if (finding.shape === 'unclassified') {
    lead = `${unit} presents the candidate as the actor of ${q(finding.claimVerb)} on ${q(finding.artifact)}, but a bound career-data statement (${q(finding.snippet)}) says ${part}${gives}, and no cited statement says the candidate did that to it.`;
  }
  return `${lead} Observed class mismatch: the source says the candidate supported it; the text claims the candidate ${finding.claimClass} it. `
    + `Two repairs are faithful. Either hold the candidate to the support role the statement gives, stating that role in this same sentence in your own words with a verb that matches it and leaving ${q(finding.sourceVerb)} with the work; `
    + 'or, only where the career data really says the candidate made the work or did the action themself, cite that statement as well as this one.';
}
