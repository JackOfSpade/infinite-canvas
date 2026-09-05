// Preference inputs are user-authored free text, while the candidate pool
// contains full listings and evidence quotes. Neither belongs in a report.

// A hub can live inside a folder (a sidebar module dropped onto a group, or
// spawned while a sub-canvas is open), so redaction has to follow
// `data.canvasData.nodes` down. The depth cap bounds a corrupt/cyclic canvas;
// past it the nested nodes are dropped rather than passed through unredacted,
// and the count of what was dropped is stated so the payload never reads as a
// complete canvas.
const MAX_NESTED_CANVAS_DEPTH = 12;

function redactNestedCanvas(node, depth) {
  const canvasData = node?.data?.canvasData;
  if (!Array.isArray(canvasData?.nodes)) return node;
  const overDepth = depth >= MAX_NESTED_CANVAS_DEPTH;
  return {
    ...node,
    data: {
      ...node.data,
      canvasData: {
        ...canvasData,
        nodes: overDepth ? [] : canvasData.nodes.map((child) => redactNode(child, depth + 1)),
        ...(overDepth ? { nestedNodesOmitted: canvasData.nodes.length } : {}),
      },
    },
  };
}

function redactNode(node, depth) {
  if (!node?.data) return node;

  if (node.type !== 'jobhub') {
    if (Array.isArray(node.data.scoredJobs)) {
      const { scoredJobs, ...restData } = node.data;
      return redactNestedCanvas({ ...node, data: { ...restData, scoredJobsCount: scoredJobs.length } }, depth);
    }
    return redactNestedCanvas(node, depth);
  }

  const { scoredJobs, preferenceCandidatePool, ...restData } = node.data;
  for (const key of [
    'jobPreferences', 'activeJobPreferences', 'pendingJobPreferences',
    'jobPreferencePlan', 'pendingJobPreferencePlan',
    'jobPreferencesInterpretation', 'pendingJobPreferencesInterpretation',
    'preferenceEvaluation',
  ]) delete restData[key];
  return redactNestedCanvas({
    ...node,
    data: {
      ...restData,
      ...(Array.isArray(scoredJobs) ? { scoredJobsCount: scoredJobs.length } : {}),
      ...(Array.isArray(preferenceCandidatePool) ? { preferenceCandidatePoolCount: preferenceCandidatePool.length } : {}),
    },
  }, depth);
}

// Not the recursive entry point itself: callers pass this straight to
// `Array.prototype.map`, which would feed the array index in as the depth.
export function redactNodeForIssueReport(node) {
  return redactNode(node, 0);
}
