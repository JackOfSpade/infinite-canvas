/**
 * Target-role title gate — "every word the user typed must be in the title".
 *
 * When the user pins a target role, the contract is exact and deterministic: a
 * job survives only when EVERY word of the typed role appears in the job TITLE.
 * Words may appear in any order, with any number of other words between them,
 * in any letter case.
 *
 *   "System Architect"  KEEPS  "System Architect II"
 *                              "System and Computer Architect"
 *                              "grocery system Architect"
 *                              "Systems Architect"                  (system → systems)
 *                              "System Engineer/Architect (OT/ICS)"
 *                       DROPS  "Construction Architect"             (no system*)
 *                              "System Engineer"                    (no architect*)
 *                              "Solution Architect"                 (no system*)
 *
 * WHY THIS IS A CLIENT-SIDE GATE AND NOT A BOARD QUERY
 * No job board can express this rule, so pushing it down would lose jobs:
 *   • Dice's `AND` is the closest any board gets — and it is EXACT-token, not
 *     prefix, so `System AND Architect` (59 hits) and `Systems AND Architect`
 *     (147 hits) are DISJOINT sets. Pushing the rule down would silently drop
 *     the larger, more canonical plural set.
 *   • Every board also matches on the DESCRIPTION. A bare `System Architect` on
 *     Dice returned 32 titles in its first 100 with no "system" anywhere in the
 *     title (Solution Architect, Software Architect, Salesforce Field Service
 *     Architect) — those matched on body text alone.
 *   • Quoting is not a substitute: it is phrase-ADJACENT, so `"System Architect"`
 *     drops "System and Computer Architect", the exact case this rule keeps. It
 *     is also destructive on the USAJobs API, where a quoted phrase returns 0.
 * So each board stays on its widest honest query and this gate is the single
 * source of truth, applied identically to every source and every code path.
 *
 * PREFIX MATCHING IS ONE-DIRECTIONAL, BY DESIGN
 * A title word satisfies a typed word when it STARTS WITH it, which absorbs
 * inflection (system → systems, architect → architects / architecture). The
 * reverse deliberately does NOT hold: typing "Systems" does not match a "System
 * Architect" posting. Inflection only ever lengthens a word, so matching both
 * directions would admit unrelated shorter words without recovering anything
 * real.
 *
 * SHORT WORDS MUST MATCH WHOLE
 * A typed word shorter than PREFIX_MIN_LENGTH must equal a title word outright.
 * Prefix matching exists to absorb inflection and a one- or two-letter token has
 * no inflection to absorb — without this rule "C++ Developer" tokenizes to
 * ["c", "developer"] and "c" would prefix-match "Cloud", "Customer" and
 * "Consulting", quietly restoring the fuzzy matching this gate removes.
 *
 * ── TECH-INDUSTRY VOCABULARY ──────────────────────────────────────────────
 * Plain word-splitting is wrong for software job titles in four specific ways,
 * each of which produced a real false positive or false negative. The fixes are
 * a small, deliberately closed vocabulary applied IDENTICALLY to the typed role
 * and the job title, so the two are always compared on the same terms. This is
 * targeted semantic knowledge, not pattern-guessing: every entry below names a
 * technology whose written form is unstable across job postings.
 *
 * 1. SYMBOLS CARRY MEANING. Stripping punctuation makes "C++", "C#" and "C" all
 *    collapse to "c" — three different languages, one token. Worse, ".NET"
 *    collapses to "net", which then PREFIX-MATCHES "Network": a ".NET Developer"
 *    search would return "Network Developer". Symbol-bearing names are rewritten
 *    to durable words (cplusplus / csharp / dotnet) before punctuation is
 *    stripped, so the distinction survives and the collision disappears.
 *
 * 2. THE JS ECOSYSTEM IS WRITTEN FOUR WAYS. "Node.js", "Node JS", "NodeJS" and
 *    "Node-js" are one thing; naive splitting makes the first two into two
 *    tokens and the third into one, so a "Node.js Developer" search misses a
 *    "NodeJS Developer" posting. Only a known runtime/framework name may absorb
 *    a following "js" — a general rule would fuse unrelated pairs.
 *
 * 3. COMPOUND ROLE NAMES SPLIT AND JOIN FREELY. "Full Stack", "Full-Stack" and
 *    "Fullstack" are the same role. Without normalization, typing "Full Stack"
 *    requires a title word starting with "stack", so "Fullstack Engineer" is
 *    dropped — the single most common miss in software titles.
 *
 * 4. SENIORITY IS ABBREVIATED. "Sr." and "Senior" are the same word, and a
 *    pinned "Senior Data Engineer" otherwise drops every "Sr. Data Engineer".
 *
 * Separately, PREFIX_BLOCKLIST handles the one case where prefix matching
 * crosses into a genuinely different technology: "Java" must not match
 * "JavaScript". This is a precise word-pair block rather than a whole-word
 * requirement, so "Java" still matches "JavaEE" and "Java8".
 */

/**
 * Below this length a typed word must match a title word exactly rather than by
 * prefix. Three is the shortest length at which a prefix is still evidence of
 * the same word rather than a coincidence ("dev" → "developer" is real; "c" →
 * "cloud" is not).
 */
const PREFIX_MIN_LENGTH = 3;

/**
 * Runtime/framework names allowed to absorb a trailing "js". Deliberately a
 * closed list: a general `<word> js` rule would fuse unrelated pairs such as
 * "Full Stack JS" into "stackjs".
 */
const JS_ECOSYSTEM = 'node|react|vue|next|nuxt|angular|ember|express|nest|svelte|three|backbone';

/**
 * Role compounds written both as one word and as two. Each is rewritten to ONE
 * canonical spelling on both sides of the comparison.
 *
 * The *Ops family SPLITS rather than joins, and that asymmetry is deliberate.
 * Joining produced a token ("devops") with no internal word boundary, which the
 * `ops -> operations` alias below could then never reach — so "Dev Ops Engineer"
 * stopped matching "Development Operations Engineer", and any *Ops spelling not
 * in this list (SecOps, FinOps) failed to unify with its spaced form in EITHER
 * direction. Splitting to "<prefix> operations" makes every spelling converge on
 * the same two tokens and lets the ordinary prefix rule finish the job
 * (dev -> development, sec -> security).
 */
const COMPOUND_ROLE_PATTERNS = [
  [/\bfull[\s._-]*stack\b/g, ' fullstack '],
  [/\bfront[\s._-]*end\b/g, ' frontend '],
  [/\bback[\s._-]*end\b/g, ' backend '],
  [/\be[\s._-]*commerce\b/g, ' ecommerce '],
  // *Ops: split, never join. Listed before the generic rule so the prefix stays
  // its own token.
  [/\b(dev|ml|sec|fin|data|git|it)[\s._-]*ops\b/g, ' $1 operations '],
];

/**
 * Typed word → pattern of title words it must NOT prefix-match, because the
 * longer word names a different technology. Checked before the prefix rule.
 */
const PREFIX_BLOCKLIST = new Map([
  ['java', /^javascripts?$/],
]);

/**
 * Rewrite technology names to a single durable spelling. Runs on lowercased,
 * accent-folded text BEFORE punctuation is stripped — that ordering is the
 * whole point, since the punctuation is what carries the meaning.
 */
function canonicalizeTechText(folded) {
  let text = ` ${folded} `;
  // Symbol-bearing language names. Order matters: `c++` before any bare `c`
  // handling, and `.net` anchored so it cannot fire inside "next.js".
  text = text
    .replace(/\bc\+\+/g, ' cplusplus ')
    .replace(/\bcpp\b/g, ' cplusplus ')
    .replace(/\bc#/g, ' csharp ')
    .replace(/\bf#/g, ' fsharp ')
    // Unanchored so a host-prefixed spelling splits correctly too: "asp.net"
    // must become "asp dotnet", not the token "net" that collides with Network.
    .replace(/\.net\b/g, ' dotnet ');
  // JS ecosystem: node.js / node js / node-js / nodejs all become one token.
  text = text.replace(new RegExp(`\\b(${JS_ECOSYSTEM})[\\s._-]*js\\b`, 'g'), ' $1js ');
  // Compound role names.
  for (const [pattern, replacement] of COMPOUND_ROLE_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  // Ampersand names are ONE name, not two initials. Without this "R&D" and
  // "M&A" shred into single-letter tokens, and single letters are matched whole
  // — so a pinned "M&A Analyst" was satisfied by any title containing a stray
  // "A" and "M", e.g. "Senior Analyst, A M Best Company".
  text = text.replace(/\b([a-z])\s*&\s*([a-z])\b/g, ' $1$2 ');
  // Seniority abbreviations. The trailing dot is already handled by the word
  // boundary; both spellings converge on the long form.
  text = text
    .replace(/\bsnr\b/g, ' senior ')
    .replace(/\bsr\b/g, ' senior ')
    .replace(/\bjr\b/g, ' junior ');
  // "Ops" is not a prefix of "Operations" ("ope" ≠ "ops"), so the prefix rule
  // cannot bridge them and a standalone alias is required. The *Ops compounds
  // above split rather than join precisely so their "ops" reaches this line.
  text = text.replace(/\bops\b/g, ' operations ');
  return text;
}

/**
 * Case- and accent-insensitive word split, shared by the role and the title so
 * the two are always compared on identical terms. Punctuation is a separator,
 * never part of a word: "System Engineer/Architect (OT/ICS)" must yield a bare
 * "architect" or a slash would hide it from the gate.
 */
function toComparableWords(value) {
  const folded = String(value == null ? '' : value)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase();
  return canonicalizeTechText(folded)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Split a typed target role into the distinct words a title must satisfy.
 * Duplicates collapse ("Systems Systems Engineer" asks nothing extra of a
 * title), and a blank/whitespace-only role yields no tokens — which callers
 * treat as "no gate", never as "match nothing".
 *
 * @param {string} role Raw user-typed target role.
 * @returns {string[]} Deduplicated comparable words, in typed order.
 */
export function tokenizeTargetRole(role) {
  const seen = new Set();
  const tokens = [];
  for (const word of toComparableWords(role)) {
    if (seen.has(word)) continue;
    seen.add(word);
    tokens.push(word);
  }
  return tokens;
}

/** Does one title word satisfy one typed token? */
function wordSatisfiesToken(word, token) {
  if (word === token) return true;
  if (token.length < PREFIX_MIN_LENGTH) return false;
  const blocked = PREFIX_BLOCKLIST.get(token);
  if (blocked && blocked.test(word)) return false;
  return word.startsWith(token);
}

/**
 * Does one title satisfy every token?
 *
 * An empty token list means no target role was set, so the gate is open — a
 * role-less (exploratory) run must never be narrowed by this rule. An empty
 * title with a non-empty token list fails: the rule is defined over the title,
 * and a job with no title offers no evidence it matches. Those are reported as
 * drops rather than silently kept, so a source shipping untitled rows stays
 * visible in diagnostics instead of being absorbed.
 *
 * @param {string} title Job title as extracted from the board.
 * @param {string[]} tokens Output of tokenizeTargetRole.
 * @returns {boolean}
 */
export function titleMatchesTargetRoleTokens(title, tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return true;
  const words = toComparableWords(title);
  if (words.length === 0) return false;
  return tokens.every(token => words.some(word => wordSatisfiesToken(word, token)));
}

/**
 * Convenience wrapper for a raw (untokenized) role. Prefer tokenizing once and
 * calling titleMatchesTargetRoleTokens when testing many jobs against one role.
 *
 * @param {string} title
 * @param {string} role
 * @returns {boolean}
 */
export function titleMatchesTargetRole(title, role) {
  return titleMatchesTargetRoleTokens(title, tokenizeTargetRole(role));
}

/**
 * Apply the gate to a gathered job set.
 *
 * Returns the survivors plus enough accounting for the run report to state what
 * the gate did as an OBSERVATION — how many rows each source lost and a few
 * verbatim titles — without asserting why a board returned them. A no-op run
 * (no target role) returns the input array itself so a role-less search is
 * provably untouched.
 *
 * `normalizeTitle` decodes a title for COMPARISON only, without mutating the
 * job. It is required for correctness, not politeness: the gate runs before the
 * mojibake/markup cleanup on three of the four gather paths and after it on the
 * fourth, so without a shared normalization the same posting could be kept when
 * found by one path and dropped when found by another.
 *
 * @param {Array<{title?: string, source?: string}>} jobs
 * @param {string} targetRole
 * @param {{ sampleLimit?: number, normalizeTitle?: (t: string) => string }} [options]
 * @returns {{ jobs: Array, tokens: string[], dropped: number, droppedBySource: Object, samples: Array }}
 */
export function filterJobsByTargetRole(jobs, targetRole, options = {}) {
  const rows = Array.isArray(jobs) ? jobs : [];
  const tokens = tokenizeTargetRole(targetRole);
  if (tokens.length === 0) {
    return { jobs: rows, tokens, dropped: 0, droppedBySource: {}, samples: [] };
  }
  const normalizeTitle = typeof options.normalizeTitle === 'function'
    ? options.normalizeTitle
    : (title) => title;

  const sampleLimit = Number.isFinite(options.sampleLimit) ? Math.max(0, options.sampleLimit) : 12;
  const kept = [];
  const droppedBySource = {};
  const samples = [];
  let dropped = 0;

  for (const job of rows) {
    if (titleMatchesTargetRoleTokens(normalizeTitle(job?.title), tokens)) {
      kept.push(job);
      continue;
    }
    dropped++;
    const source = String(job?.source || '?');
    droppedBySource[source] = (droppedBySource[source] || 0) + 1;
    if (samples.length < sampleLimit) {
      samples.push({ source, title: String(job?.title || '').slice(0, 160) });
    }
  }

  return { jobs: kept, tokens, dropped, droppedBySource, samples };
}

/**
 * Boolean/operator syntax a user might type into the target-role box.
 *
 * Operators are unsafe to broadcast: measured across the seven boards, negation
 * is IGNORED and count-increasing on Glassdoor/LinkedIn/ZipRecruiter,
 * DESTRUCTIVE on Google and USAJobs (query → 0 rows), and on ZipRecruiter it
 * INVERTS INTENT — `Controller NOT carpenter NOT superintendent` returned five
 * results, all carpenters and superintendents. The typed text is still sent
 * through unchanged; this only lets the caller surface a non-blocking advisory,
 * because the inversion is otherwise completely invisible in the run report.
 *
 * @param {string} role
 * @returns {string[]} The operator-looking fragments found, for the advisory.
 */
export function detectQueryOperators(role) {
  const text = String(role == null ? '' : role);
  const found = new Set();
  if (/(^|\s)-\S/.test(text)) found.add('-term');
  for (const word of ['NOT', 'AND', 'OR']) {
    if (new RegExp(`(^|\\s)${word}(\\s|$)`).test(text)) found.add(word);
  }
  if (/\b\w+:/.test(text)) found.add('field:');
  if (/"/.test(text)) found.add('"quotes"');
  return [...found];
}
