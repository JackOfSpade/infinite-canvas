const DEFAULT_JOB_STATUS = 'New';

export function isJobCardVisible(jobData = {}, {
  sourceFilter = null,
  scoreThreshold = 0,
  statusFilters = [],
} = {}) {
  const activeStatusFilters = Array.isArray(statusFilters) ? statusFilters : [];
  const sourceOk = !sourceFilter || jobData.source === sourceFilter;
  const scoreOk = (jobData.matchScore ?? 0) >= scoreThreshold;
  const statusOk = activeStatusFilters.length === 0 ||
    activeStatusFilters.includes(jobData.status || DEFAULT_JOB_STATUS);

  return sourceOk && scoreOk && statusOk;
}

export function getJobCardFilterOpacity(jobData, filters) {
  return isJobCardVisible(jobData, filters) ? 1 : 0.15;
}

export function applyJobCardFiltersToNodes(nodes, hubId, filters) {
  return (Array.isArray(nodes) ? nodes : []).map(node => {
    if (node?.type !== 'jobcard' || node.data?.hubId !== hubId) return node;

    const opacity = getJobCardFilterOpacity(node.data, filters);
    if ((node.style?.opacity ?? 1) === opacity) return node;

    return {
      ...node,
      style: {
        ...node.style,
        opacity,
      },
    };
  });
}
