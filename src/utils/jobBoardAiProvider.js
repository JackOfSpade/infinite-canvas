/**
 * A successful IPC envelope is not enough to safely replace an existing board:
 * it must contain a complete model-produced role partition for every input job.
 * Likelihood bands and salary ranges may be omitted because their fixed/canonical
 * normalization is deterministic; role assignments are the provider-owned
 * semantic taxonomy and cannot be fabricated. Keep this validation in the
 * renderer too, since old/preload-mismatched builds can otherwise turn an
 * incomplete response into a destructive re-combine.
 */
export function validateJobBoardTaxonomy(taxonomy, jobCount) {
  const count = Math.max(0, Math.floor(Number(jobCount) || 0));
  if (!taxonomy || typeof taxonomy !== 'object') return { valid: false, reason: 'No taxonomy was returned.' };
  const { roles } = taxonomy;
  if (!Array.isArray(roles) || roles.length === 0) return { valid: false, reason: 'The taxonomy has no role assignments.' };

  const assigned = new Set();
  for (const role of roles) {
    if (!String(role?.name || '').trim()) return { valid: false, reason: 'A role assignment has no name.' };
    if (!Array.isArray(role?.jobIndices)) return { valid: false, reason: 'A role assignment is missing job indexes.' };
    for (const index of role.jobIndices) {
      if (!Number.isInteger(index) || index < 0 || index >= count || assigned.has(index)) {
        return { valid: false, reason: 'Role assignments are incomplete or overlap.' };
      }
      assigned.add(index);
    }
  }
  if (assigned.size !== count) return { valid: false, reason: 'Not every job received a role assignment.' };
  return { valid: true, reason: '' };
}

/**
 * Pre-taxonomy boards from the short-lived flat-card implementation are not a
 * trustworthy completed result.  Keep locked boards as historical snapshots,
 * but prompt every editable legacy board to successfully re-combine instead of
 * continuing to show its direct-to-hub cards after an upgrade.
 */
export function isLegacyUnbucketedJobBoard(boardData, nodes, hubId) {
  if (boardData?.hubState !== 'done' || boardData?.locked || boardData?.jobTaxonomy) return false;
  const children = Array.isArray(nodes) ? nodes.filter((node) => node?.data?.hubId === hubId) : [];
  return children.some((node) => node.type === 'jobcard') && !children.some((node) => node.type === 'jobgroup');
}
