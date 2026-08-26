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
 * A query is eventually sent to every enabled job source, so this boundary is
 * deliberately strict about accepting only user/model text. String coercion
 * turns malformed structured-output values into searches such as
 * "[object Object]", which wastes a full source run and obscures the actual
 * query-generation error. Whitespace is also normalized before deduping: it
 * has no search meaning but otherwise lets equivalent queries run twice.
 */
function normalizeJobSearchQuery(value) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

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
