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
  const role = String(targetRole || '').trim();
  return {
    targetRoleQueries: role ? [role] : [],
    titleQueries: [],
    suggestedRoleQueries: [],
    skillsOnlyQueries: [],
  };
}

export function flattenJobSearchQueries(queryBundle) {
  const seen = new Set();
  const queries = [];

  for (const key of QUERY_GROUP_KEYS) {
    const group = queryBundle?.[key];
    if (!Array.isArray(group)) continue;
    for (const value of group) {
      const query = String(value || '').trim();
      if (!query) continue;
      const identity = query.toLowerCase();
      if (seen.has(identity)) continue;
      seen.add(identity);
      queries.push(query);
    }
  }

  return queries;
}
