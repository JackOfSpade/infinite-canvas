/**
 * Pure helpers deciding which module-specific bug-report sections to include,
 * from the canvas node types. Shared by the renderer (useIssueReporter, which
 * stamps the flags into filterStats BEFORE a filter code can delete the `nodes`
 * section) and the main process (bugReport.generateMarkdown). One predicate so
 * the two can't drift. Framework-agnostic (no React / Electron deps).
 */

export function isJobNodeType(type) {
  return typeof type === 'string' && type.toLowerCase().startsWith('job');
}

export function isSellNodeType(type) {
  const t = typeof type === 'string' ? type.toLowerCase() : '';
  return t === 'sellhub' || t === 'marketplacecard' || t === 'listing' || t === 'compsourcecard';
}

/**
 * Resolve job/sell node presence from a (possibly filter-trimmed) report payload.
 * Prefer the flags stamped into filterStats — computed while `nodes` was still
 * intact — falling back to scanning `nodes` when present. Uses `??` (not `||`) so
 * a genuine `false` from a node-less canvas is respected rather than forcing the
 * module sections back in.
 *
 * @param {{filterStats?: {hasJobNodes?: boolean, hasSellNodes?: boolean}, nodes?: object[]}} payload
 * @returns {{hasJobNodes: boolean, hasSellNodes: boolean}}
 */
export function resolveNodePresence(payload) {
  const fs = payload?.filterStats;
  const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
  return {
    hasJobNodes: fs?.hasJobNodes ?? nodes.some(n => isJobNodeType(n?.type)),
    hasSellNodes: fs?.hasSellNodes ?? nodes.some(n => isSellNodeType(n?.type)),
  };
}
