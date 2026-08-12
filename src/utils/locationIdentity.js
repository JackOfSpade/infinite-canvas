// Identity for the applied-jobs store (docs/resume-achievement-mining-design.md §6.3).
//
// This is the piece most likely to be quietly wrong, and the two ways it can be
// wrong are not symmetric:
//   - too STRICT (two spellings of the same job fail to match) → the job
//     resurfaces in a future search and the user dismisses it again. Annoying,
//     recoverable.
//   - too LOOSE (two different jobs collapse onto one key) → a real opening
//     silently vanishes from every future search on every canvas, forever,
//     with no way to notice or undo once the card that would have shown it is
//     gone.
// Every judgment call below is made in the strict direction on purpose.
//
// Why this can't reuse the existing identity helpers as-is (both are correct
// for their own job and wrong for this one — see the design doc for the full
// argument):
//   - jobsHistory.dedupKeysFor (electron/ipc/jobsHistory.js) falls back to
//     `tc:title|company` with NO location when location is missing. That's the
//     right call for a 60-day "don't re-show" cache (worst case: one extra
//     over-show). It's the wrong call here: a permanent, global store must
//     never treat "location unknown" as "location doesn't matter."
//   - jobIdentity.dedupJobsAcrossSources (src/utils/jobIdentity.js) merges two
//     same-title/company jobs when EITHER side's location is unknown, so a
//     real Austin opening would read as "already applied" because the user
//     applied to a same-titled Denver job whose location field happened to be
//     blank. Right for cross-source SAME-RUN dedup (a missing location there
//     usually means "the other source's copy of the SAME posting didn't carry
//     one"); wrong for two independently-sourced applications months apart.
//   - The two modules also disagree with each other on whitespace: jobIdentity's
//     `keyPart` lowercases+trims but doesn't collapse internal whitespace;
//     jobsHistory's `normText` does. The same string produces two different
//     keys depending on which module happened to run. Not reused here either.
//
// MATCH RULE (deliberate product decision, not an implementation detail):
// urlKey match OR (title + company + location) match, and an UNKNOWN location
// never matches anything — not even another unknown-location record for the
// same title+company. Same title + same company + different city is a
// DIFFERENT job: the competition pool differs, a candidate can be a strong fit
// in one city and a weak one in another, and multi-req employers (Google,
// Amazon, …) post the identical title across a dozen cities as a dozen
// distinct reqs. A location-less job is therefore never a wildcard that can
// match a located one, and two location-less jobs never match each other —
// both directions of "might be the same job" are exactly the false-positive
// this module exists to prevent.
//
// Pure module: no electron/fs/network imports. Every export tolerates
// null/undefined/non-string input by returning the "unknown" value ('' for
// strings, an empty-tupleKey object for appliedKeysFor) rather than throwing —
// upstream job records come from scraped/LLM-produced data of uneven shape,
// and a crash here must never be how a location mismatch gets discovered.

import { US_STATES, CA_PROVINCES } from './jobLocation.js';

// Combined code<->name lookup, same shape/idea as jobLocation.js's private
// SUBDIVISIONS — kept as a local combination (not exported from jobLocation.js)
// so this module owns its own view of "what counts as a fold-able subdivision"
// independent of that module's adherence-auditor-specific regex helpers.
const SUBDIVISIONS = { ...US_STATES, ...CA_PROVINCES };
const SUBDIVISION_NAME_TO_CODE = new Map(
  Object.entries(SUBDIVISIONS).map(([code, name]) => [name, code])
);

// Trailing country qualifiers to drop. Built from the punctuation-stripped,
// period-removed, lowercase form the pipeline below always produces, so
// "U.S." / "U.S.A." / "(US)" all arrive here as "u s" / "u s a" / "us" — see
// canonicalizeLocation's normalization steps for why periods and parens never
// survive to this check.
const COUNTRY_TOKENS = new Set([
  'united states', 'usa', 'us', 'u s', 'u s a',
]);

// Precompiled once at module load, not `new RegExp(...)` inside
// canonicalizeLocation's per-call loop below. This function runs on both
// sides of every job/record comparison (appliedRecordMatches, and now the
// batched filterOutApplied path), so a five-token loop that re-constructs a
// RegExp object on every single call is a real per-call allocation cost, not
// a one-time one — see filterOutApplied's doc-comment in appliedJobs.js for
// the pair-count math that makes this matter at scale. Order matches
// COUNTRY_TOKENS iteration order; behavior is unchanged (same patterns,
// same trailing-word-boundary match), only the construction is hoisted.
const COUNTRY_TOKEN_RES = Array.from(COUNTRY_TOKENS, (token) => new RegExp(`\\b${token}$`));

// Fold to the single token 'remote' whenever the flattened (comma/hyphen/paren
// -stripped) string starts with the word "remote" — covers every
// "remote(-| |\()?<qualifier>" shape a source is observed to send (`remote`,
// `remote - us`, `remote (us)`, `remote united states`, `remote anywhere`,
// `remote worldwide`, `remote first`, `fully remote` after the "fully "
// prefix is swallowed by the \b test below) — plus a short exact-match list
// for variants that don't lead with the word "remote" at all: WWR/RemoteOK
// sometimes carry the literal field value 'Anywhere', 'WFH', 'Distributed',
// etc. instead. Location fields are short place strings, not sentences, so a
// bare "contains remote" test doesn't risk false-positiving on real prose.
const REMOTE_WORD_RE = /\bremote\b/;
const REMOTE_EXACT_TOKENS = new Set([
  'anywhere', 'wfh', 'work from home', 'distributed',
  'telecommute', 'telecommuting', 'virtual', 'wfa', 'work from anywhere',
]);

function isRemoteToken(flat) {
  return REMOTE_WORD_RE.test(flat) || REMOTE_EXACT_TOKENS.has(flat);
}

// Shared first stage for all four canonicalizers: strip diacritics via NFD
// decomposition + combining-mark removal ("Montréal" -> "Montreal" -> lower
// -> "montreal") so accented and unaccented spellings of the same place/name
// collapse to one key, then lowercase. Every caller re-collapses whitespace
// itself afterward because location needs comma-aware collapsing (see below)
// while title/company just need plain whitespace collapsing.
function stripDiacriticsLower(s) {
  // U+0300-U+036F is the Unicode "Combining Diacritical Marks" block, written
  // as an escaped \u range (never pasted combining characters directly) so the
  // source file stays plain ASCII - a literal combining glyph sitting in a
  // regex is the same class of hazard as a literal NUL byte (see the composite
  // Map-key delimiter note): editors/diffs can silently mis-encode or drop it.
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function asString(raw) {
  // Anything other than a real string is treated as absent rather than
  // coerced (String(someObject) => "[object Object]" would be worse than
  // silence — it would canonicalize to a stable-looking but meaningless key).
  return typeof raw === 'string' ? raw : '';
}

/**
 * Canonicalize a job/company title for identity matching: diacritic-fold,
 * lowercase, collapse internal whitespace, trim. Deliberately minimal — a
 * title carries no state/remote/hyphen-reconstruction hazards, only the
 * whitespace-collapsing disagreement documented at the top of this file
 * between jobIdentity's keyPart (doesn't collapse) and jobsHistory's normText
 * (does). This module always collapses, matching normText's behavior.
 */
export function canonicalizeTitle(raw) {
  return stripDiacriticsLower(asString(raw)).replace(/\s+/g, ' ').trim();
}

/** Same treatment as canonicalizeTitle; company names hit the same hazard. */
export function canonicalizeCompany(raw) {
  return stripDiacriticsLower(asString(raw)).replace(/\s+/g, ' ').trim();
}

/**
 * Canonicalize a location string into 'city, st' / 'remote' / '' (unknown).
 *
 * Pipeline, in order (each step motivated by an observed real-source shape —
 * see the format-variance table in docs/resume-achievement-mining-design.md
 * §6.3):
 *   1. NFD diacritic strip + lowercase ("Montréal" -> "montreal").
 *   2. Hyphens -> spaces. ZipRecruiter reconstructs its location field from a
 *      URL slug by turning every '-' into a space
 *      (electron/extractors/jobs.js), so a real hyphenated place name from
 *      any OTHER source ("Winston-Salem") must fold to the same token as
 *      ZipRecruiter's reconstruction ("Winston Salem") or the two never
 *      match. Doing this before anything else means both inputs are
 *      byte-identical ("winston salem") by the time later steps run.
 *   3. Strip everything that isn't a letter, digit, comma or space. This is
 *      one rule that simultaneously handles periods in country abbreviations
 *      ("U.S." -> "u s", "U.S.A." -> "u s a") and parenthetical qualifiers
 *      ("Remote (US)" -> "remote  us " -> "remote us" after whitespace
 *      collapse) without a separate rule for each punctuation shape.
 *   4. Collapse comma spacing and whitespace.
 *   5. Remote check on a comma-flattened copy — BEFORE country/state parsing,
 *      because "Remote - US" or "Remote, United States" must fold to the
 *      literal 'remote' token, not to a parsed (city="remote", state="us")
 *      pair.
 *   6. Split on commas; drop a trailing country token (united states / usa /
 *      us / u s / u s a).
 *   7. Fold the (new) trailing segment against the US_STATES / CA_PROVINCES
 *      tables — full name -> code AND code -> itself, either direction,
 *      since sources send both ("Denver, CO" vs "Golden, Colorado").
 *   8. If the resolved state's code or full name ALSO appears as a trailing
 *      word inside the city segment, strip it there too. This targets
 *      USAJobs's `PositionLocationDisplay` shape, "Washington DC, District of
 *      Columbia" — city segment "washington dc" already embeds the state
 *      abbreviation the state segment also resolves to. Left alone this
 *      would canonicalize to "washington dc, dc"; a plain "Washington, DC"
 *      from another source canonicalizes to "washington, dc" — two keys for
 *      one place. Stripping the trailing duplicate collapses both onto
 *      "washington, dc".
 *
 * Deliberately NOT done: guessing a state from a bare city name (Indeed's
 * `addressLocality` is sometimes just "Austin" with no state anywhere in the
 * record) — a wrong guess is a false MATCH risk, and this module's stated
 * bias is to accept false negatives, never false positives. A bare city
 * canonicalizes to itself ("austin") with no state suffix; it will only match
 * another record that ALSO canonicalizes to a bare "austin" (no state).
 */
export function canonicalizeLocation(raw) {
  const s = asString(raw);
  if (!s.trim()) return '';

  let norm = stripDiacriticsLower(s)
    .replace(/-/g, ' ')
    .replace(/[^a-z0-9, ]+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^,+\s*/, '')
    .replace(/\s*,+$/, '');
  if (!norm) return '';

  const flat = norm.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  if (isRemoteToken(flat)) return 'remote';

  const segments = norm.split(',').map((seg) => seg.trim()).filter(Boolean);
  if (segments.length === 0) return '';

  // Drop a trailing country qualifier. Matched as a trailing WORD SEQUENCE
  // within the last segment, not as a whole-segment equality check — a
  // parenthesized qualifier ("CO (US)") loses its comma boundary once step 3
  // turns the parens into spaces, so "Denver, CO (US)" arrives here as
  // segments ["denver", "co us"], with "us" merged into the same segment as
  // the state. A whole-segment check would miss this entirely and leak "us"
  // into the state field; trimming a trailing token match handles both the
  // comma-separated shape ("Denver, CO, United States") and the
  // paren-merged one identically.
  //
  // Unconditional — NOT guarded to segments.length > 1. A location that is
  // JUST a country ("United States", "USA", "US", "U.S.") arrives as a single
  // segment that IS entirely the token; skipping the strip for that case (an
  // earlier version of this function did) let it fall through to the return
  // at the bottom as if it were a real city name, so "United States"/"USA"/
  // "US"/"U.S." each canonicalized to a different non-empty, city-looking key
  // ('united states'/'usa'/'us'/'u s') instead of all folding to '' unknown —
  // a bare country carries no city identity, exactly the "tells you nothing"
  // input this module's unknown-never-matches invariant exists to catch. The
  // segments.pop()-to-empty branch right below already turns a
  // country-token-only segment into segments.length === 0, which the check
  // after this block correctly resolves to ''.
  const lastIdx = segments.length - 1;
  for (const re of COUNTRY_TOKEN_RES) {
    if (re.test(segments[lastIdx])) {
      segments[lastIdx] = segments[lastIdx].replace(re, '').trim();
      break;
    }
  }
  if (!segments[lastIdx]) segments.pop();
  if (segments.length === 0) return '';

  // Resolve a trailing subdivision (US state / CA province), by code or full
  // name, and pop it off so what's left is the city portion.
  let stateCode = null;
  if (segments.length > 1) {
    const last = segments[segments.length - 1];
    if (SUBDIVISIONS[last]) stateCode = last;
    else if (SUBDIVISION_NAME_TO_CODE.has(last)) stateCode = SUBDIVISION_NAME_TO_CODE.get(last);
    if (stateCode) segments.pop();
  } else if (SUBDIVISION_NAME_TO_CODE.has(segments[0])) {
    // A lone segment that IS a full subdivision name ("California" with no
    // city) — treat it as the state, not as a city literally named that.
    stateCode = SUBDIVISION_NAME_TO_CODE.get(segments[0]);
    segments.pop();
  }

  let city = segments.join(', ').trim();

  // De-duplicate an embedded state abbreviation/name at the end of the city
  // segment (the USAJobs "Washington DC, District of Columbia" case: city
  // segment "washington dc" already embeds the state code its own state
  // segment also resolves to). Guarded against emptying the city entirely —
  // "New York, NY" hits this same code path because the state's full name
  // ("new york") is ALSO a real city name, so a city segment that's nothing
  // BUT the duplicate ("new york") must be left alone rather than stripped
  // down to '', which would silently turn a real city into "no city known".
  // Only apply when something legible remains.
  if (stateCode && city) {
    const stateName = SUBDIVISIONS[stateCode];
    const escapedName = stateName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const stripped = city
      .replace(new RegExp(`\\b${escapedName}$`), '')
      .replace(new RegExp(`\\b${stateCode}$`), '')
      .trim();
    if (stripped) city = stripped;
  }

  if (city && stateCode) return `${city}, ${stateCode}`;
  if (city) return city;
  if (stateCode) return stateCode;
  return '';
}

// Indeed's scraped links are click-redirect stubs (`/rc/clk`, `/pagead/clk`)
// whose PATH is identical across every listing — the identity lives in the
// `jk` query param, and everything else in the query is a per-scrape session
// token. Mirrors the exact same observed behavior already handled in
// electron/ipc/jobsHistory.js's normUrl (reused by idea per this module's
// task brief, not imported — that module isn't ours to depend on and pulls
// in `fs`/`logger`, which a pure src/utils module must not do).
const REDIRECT_STUB_RE = /\/(?:rc|pagead)\/clk$/;

/**
 * Canonicalize a job listing URL to its identity-bearing form, or '' when the
 * URL carries no usable identity (a redirect stub with no `jk`, an empty/
 * unparseable string). Query strings are dropped by default — listing
 * identity normally lives in the path, and every dropped param is
 * incidentally also a tracking param (utm_*, session tokens, referral
 * codes) — except Indeed's `jk`, which IS the identity and lives nowhere
 * else once the path collapses.
 */
export function canonicalizeJobUrl(url) {
  const raw = asString(url).trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.toLowerCase().replace(/\/+$/, '') || '/';
    const jk = u.searchParams.get('jk');
    if (jk) return `https://${host}${path}?jk=${jk.toLowerCase()}`;
    if (REDIRECT_STUB_RE.test(path)) return '';
    return `https://${host}${path}`;
  } catch {
    // Not an absolute, parseable URL (relative path, malformed string) —
    // best-effort fallback: drop query/fragment, normalize protocol/www.
    const stripped = raw.split(/[?#]/)[0];
    if (!stripped) return '';
    return stripped.toLowerCase()
      .replace(/^https?:\/\//, 'https://')
      .replace(/^https:\/\/www\./, 'https://')
      .replace(/\/+$/, '');
  }
}

/**
 * Both identity keys for one job/applied-record, from whatever shape either
 * side happens to have (`{ url, title, company, location }` — a scraped job
 * and a stored applied-jobs record share this shape by design, see the
 * design doc §6.2 record schema).
 *
 * `tupleKey` is '' whenever title, company, OR location canonicalize to
 * empty — an empty tupleKey must never be treated as a match key by a caller
 * (appliedRecordMatches enforces this; see its doc-comment for why an empty
 * string cannot leak through the `&&` guard there). This is what makes
 * "unknown location never matches" hold: a location-less job's tupleKey is
 * unconditionally '', so it can only ever match via urlKey, never via the
 * tuple.
 */
export function appliedKeysFor(job) {
  const urlKey = canonicalizeJobUrl(job?.url);
  const titleKey = canonicalizeTitle(job?.title);
  const companyKey = canonicalizeCompany(job?.company);
  const locationKey = canonicalizeLocation(job?.location);
  const tupleKey = (titleKey && companyKey && locationKey)
    ? `${titleKey}|${companyKey}|${locationKey}`
    : '';
  return { urlKey, tupleKey };
}

/**
 * Same derivation appliedRecordMatches used to do inline for its `record`
 * side, pulled out so both the O(n*m) pairwise path (appliedRecordMatches)
 * and the batched O(n+m) path (appliedJobs.js's filterOutApplied) derive a
 * stored record's keys through the exact same logic — one place, so a future
 * change to the fallback rule can't silently diverge between the two
 * callers.
 *
 * Re-canonicalizes from the record's own RAW fields (not from any
 * `urlKey`/`locationKey` the store may have persisted alongside them) —
 * deliberately, so that improving this module's canonicalization later
 * transparently re-keys every existing stored record on the next comparison,
 * with nothing to migrate. A record missing raw `url`/`location` (an older
 * store shape) falls back to whatever precomputed key it does carry;
 * canonicalizeJobUrl/canonicalizeLocation are idempotent, so re-running them
 * on an already-canonical stored key is harmless.
 */
export function appliedKeysForRecord(record) {
  const recordJob = {
    url: record?.url || record?.urlKey || '',
    title: record?.title || '',
    company: record?.company || '',
    location: record?.location || record?.locationKey || '',
  };
  return appliedKeysFor(recordJob);
}

/**
 * Does `job` (a freshly scraped listing) match `record` (a stored
 * applied-jobs entry)? True on urlKey match OR tupleKey match.
 *
 * `record`'s keys go through appliedKeysForRecord (see its doc-comment for
 * why that re-canonicalizes from raw fields rather than trusting a
 * persisted key).
 *
 * Both branches use `&&` before comparing, not just `===`, specifically so
 * that two empty keys (`'' === ''`) can never register as a match — an
 * unknown location, or a record with no URL at all, must never become a
 * wildcard. This is the enforcement point for the module's core invariant;
 * see appliedKeysFor's doc-comment for how tupleKey becomes '' in the first
 * place.
 */
export function appliedRecordMatches(job, record) {
  if (!job || !record) return false;
  const jobKeys = appliedKeysFor(job);
  const recordKeys = appliedKeysForRecord(record);
  if (jobKeys.urlKey && recordKeys.urlKey && jobKeys.urlKey === recordKeys.urlKey) return true;
  if (jobKeys.tupleKey && recordKeys.tupleKey && jobKeys.tupleKey === recordKeys.tupleKey) return true;
  return false;
}
