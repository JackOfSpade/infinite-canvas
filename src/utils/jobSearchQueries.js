// Exploratory bundles (target role blank) come from the query-generation model.
// Keep every distinct query it produced; the one safe omission is a normalized
// duplicate already present in the same bundle. A set target role instead uses
// buildExactTargetRoleQueryBundle and never enters model variation generation.
const QUERY_GROUP_KEYS = [
  'targetRoleQueries',
  'titleQueries',
  'suggestedRoleQueries',
  'skillsOnlyQueries',
];

/** A target-role run has exactly one scrape query and no generated variations. */
export function buildExactTargetRoleQueryBundle(targetRole) {
  const role = normalizeJobSearchQuery(targetRole);
  return {
    targetRoleQueries: role ? [role] : [],
    titleQueries: [],
    suggestedRoleQueries: [],
    skillsOnlyQueries: [],
  };
}

/**
 * A Job Preferences plan that produced `titles` (always worked out by the AI
 * from the brief + career profile, with any title the user wrote in the brief
 * preserved verbatim inside that list — see jobPreferences.js) searches those
 * titles verbatim, the same
 * "one query per role, no model variation" shape as
 * buildExactTargetRoleQueryBundle, just for N roles instead of one. Building
 * this bundle locally — instead of a second generateJobQueries model call —
 * is the whole point: every AI call in this app is a human copy/paste
 * handoff, so a plan that already named its roles must not pay for another
 * one just to re-derive them.
 */
export function buildPinnedTitleQueryBundle(titles) {
  const seen = new Set();
  const targetRoleQueries = [];
  for (const raw of Array.isArray(titles) ? titles : []) {
    const role = normalizeJobSearchQuery(raw);
    if (!role) continue;
    const identity = role.toLowerCase();
    if (seen.has(identity)) continue; // e.g. AI-generated "Backend Engineer" twice
    seen.add(identity);
    targetRoleQueries.push(role);
  }
  return {
    targetRoleQueries,
    titleQueries: [],
    suggestedRoleQueries: [],
    skillsOnlyQueries: [],
  };
}

/**
 * A query is eventually sent to every enabled job source, so this boundary is
 * deliberately strict about accepting only user/model text. String coercion
 * turns malformed structured-output values into searches such as
 * "[object Object]", which wastes a full source run and obscures the actual
 * query-generation error. Whitespace is also normalized before deduping: it
 * has no search meaning but otherwise lets equivalent queries run twice.
 *
 * Unicode canonical form is normalized too (NFC), for the same reason as the
 * whitespace collapse above: it is an invisible ENCODING difference, not a
 * search-meaning difference. Career data is frequently PDF/OCR-derived, and
 * PDF text extraction routinely yields NFD (decomposed) accented characters
 * — e.g. "e" + a combining acute accent — that render pixel-identical to the
 * normal NFC "é" but compare unequal byte-for-byte. Composing to NFC is
 * lossless and reversible-in-appearance (no character is added, removed, or
 * folded to a different one — see MDN String.prototype.normalize), so this
 * cannot merge two genuinely different queries the way stemming or
 * punctuation-stripping could. Deliberately NOT using NFKC: that form also
 * folds compatibility variants (ligatures, full-width/half-width, sub/super-
 * script digits) into a different base character — a stronger claim of
 * "same search" than this function is willing to make.
 */
function normalizeJobSearchQuery(value) {
  return typeof value === 'string' ? value.normalize('NFC').replace(/\s+/gu, ' ').trim() : '';
}

// Dedup-key audit (query-generation is now uncapped at up to 20 per group —
// see JOB_QUERY_GENERATION_SCHEMA — so near-dupe merging matters more than
// before). The identity below is `normalizeJobSearchQuery(value).toLowerCase()`.
// What that ALREADY merges, and why each is safe (encoding noise, zero
// search-meaning, cannot lose coverage):
//   - internal run-of-whitespace ("Product  Engineer" / tabs / newlines) → collapsed to one space
//   - leading/trailing whitespace → trimmed
//   - letter case ("Product Engineer" vs "product engineer") → case-folded
//   - Unicode canonical form (NFD vs NFC accents, e.g. from PDF-extracted
//     career data) → composed to NFC (added by this pass; see
//     normalizeJobSearchQuery's docstring)
// What is DELIBERATELY left distinct — merging any of these risks silently
// dropping search coverage, which is worse than one duplicate scrape:
//   - wording/synonyms ("Product Engineer" vs "Product Manager, Engineering")
//   - seniority/qualifier tokens ("Software Engineer" vs "Senior Software
//     Engineer" vs "Software Engineer II") — boards treat these as different
//     searches, and dropping the qualifier is stemming, not dedup
//   - punctuation ("Sr." vs "Sr", "Front-End" vs "Front End") — a board may
//     treat a hyphen or period as meaningful; this function has no way to
//     know which boards do, so it never strips punctuation
//   - word order / pluralization — no stemming, ever
export function flattenJobSearchQueries(queryBundle) {
  const seen = new Set();
  const queries = [];

  for (const key of QUERY_GROUP_KEYS) {
    const group = queryBundle?.[key];
    if (!Array.isArray(group)) continue;
    for (const value of group) {
      const query = normalizeJobSearchQuery(value);
      if (!query) continue;
      const identity = query.toLowerCase();
      if (seen.has(identity)) continue;
      seen.add(identity);
      queries.push(query);
    }
  }

  return queries;
}
