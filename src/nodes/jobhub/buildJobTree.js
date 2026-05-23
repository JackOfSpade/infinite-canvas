import { structuralEdge } from '../_shared/edgeHelpers';
import { EventLogger } from '../../utils/EventLogger';

/**
 * Pure helpers for turning scored jobs + a bucket tree into the React Flow
 * node/edge graph the JobHub spawns onto the canvas. Lives outside the
 * component so the algorithm can be reasoned about (and unit-tested) without
 * a ReactFlow runtime — JobHubNode.jsx just wires up the IPC plumbing and
 * passes the results to ReactFlow.
 *
 * Three exports:
 *  - partitionJobsForBranches  → splits scored jobs into target / other
 *  - buildJobsForBucketing     → preps the bucketing input with the
 *                                careerDirection override that clusters
 *                                target jobs under one synthetic category
 *  - buildJobTreeNodes         → emits the {nodes, edges} graph
 */

// AI-judgment cutoff for "good chance of interview." Below this we treat
// the candidate as unlikely to clear initial screen — used to decide the
// Other Strong cutoff AND the loose-fill ladder for Target Role.
export const LIKELY_THRESHOLD = 65;
// Minimum size of the Target Role branch when loose-fill kicks in: better
// to show 5 best-shot longshots than an empty branch on a real pivot.
const TARGET_FILL_MIN  = 5;
// "Other Strong Matches" relaxation: when too few non-target jobs clear
// LIKELY_THRESHOLD, lower the bar to admit up to OTHER_FILL_MIN of the best
// (never below OTHER_FLOOR) so a niche/weak run still surfaces its top non-
// target matches instead of an empty branch — the non-target analog of
// TARGET_FILL_MIN. See strongMatchGate.
const OTHER_FLOOR    = 50;
const OTHER_FILL_MIN = 5;

/**
 * Cutoff score for the "Other Strong Matches" branch, derived from the run's
 * own non-target score distribution. Stays at LIKELY_THRESHOLD when there are
 * already ≥ OTHER_FILL_MIN strong non-target jobs; otherwise drops to the score
 * of the OTHER_FILL_MIN-th best (clamped to [OTHER_FLOOR, LIKELY_THRESHOLD]) so
 * a thin run still shows its best non-target matches. Computed once per run and
 * persisted on the hub (data.strongMatchGate) so later appends bucket the same way.
 * @param {number[]} nonTargetScores  matchScores of the run's non-target jobs
 */
export function strongMatchGate(nonTargetScores = []) {
  const strong = nonTargetScores.filter(s => s >= LIKELY_THRESHOLD).length;
  if (strong >= OTHER_FILL_MIN || nonTargetScores.length === 0) return LIKELY_THRESHOLD;
  const sortedDesc = [...nonTargetScores].sort((a, b) => b - a);
  const nth = sortedDesc[Math.min(OTHER_FILL_MIN, sortedDesc.length) - 1];
  return Math.max(OTHER_FLOOR, Math.min(LIKELY_THRESHOLD, nth ?? LIKELY_THRESHOLD));
}
// Synthetic careerDirection name we override target jobs to before
// bucketing, so the AI clusters them under one category whose buckets
// mount directly under the Target Role branch (no Category level).
export const TARGET_BUCKETING_CATEGORY = 'Target Role';

// Tree layout — column x-offsets and row stacking heights. With branches,
// every level shifts one column right vs. the no-target layout.
export const COL_X_WITH_TARGET    = { branch: 400, category: 700, bucket: 1000, job: 1400 };
export const COL_X_WITHOUT_TARGET = { category: 400, bucket: 700, job: 1100 };
export const ROW_H = { branch: 90, category: 70, bucket: 70, job: 280 };

// Per-bucket pagination — buckets reveal the first N jobs on expand; the
// JobGroupNode component implements the Show-more interaction.
const BUCKET_VISIBLE_DEFAULT = 10;

/**
 * Compute absolute canvas positions for every visible job-tree node owned by
 * `hubId`, based on the current expanded/collapsed state in `nodes`. Called
 * after every expand, collapse, or show-more so the layout is always tight
 * rather than pre-spaced for the fully-expanded case.
 *
 * Returns a map of { [nodeId]: { x, y } }. Only nodes that are reachable from
 * the hub's root groups (categories or branches) are included — other canvas
 * nodes (source cards, other hubs) are untouched.
 */
export function computeLayoutPositions(nodes, hubId, COL_X, hubPos) {
  const nodeById = new Map(nodes.map(n => [n.id, n]));

  // Collect every ID that appears as a child of some group node for this hub
  const allChildIds = new Set();
  nodes.forEach(n => {
    if (n.data?.hubId === hubId && Array.isArray(n.data?.childIds)) {
      n.data.childIds.forEach(cid => allChildIds.add(cid));
    }
  });

  // Root groups: hub-owned jobgroup nodes not listed as a child of any other group
  const rootGroups = nodes
    .filter(n => n.data?.hubId === hubId && n.type === 'jobgroup' && !allChildIds.has(n.id))
    .sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0));

  const positions = {};

  function layoutNode(nodeId, startY) {
    const node = nodeById.get(nodeId);
    if (!node) return startY;

    const kind = node.data?.kind;
    let x;
    if (node.type === 'jobcard') {
      x = hubPos.x + COL_X.job;
    } else if (kind === 'bucket') {
      x = hubPos.x + COL_X.bucket;
    } else if (kind === 'category') {
      x = hubPos.x + COL_X.category;
    } else if (kind === 'branch') {
      x = hubPos.x + COL_X.branch;
    } else {
      return startY;
    }

    positions[nodeId] = { x, y: startY };

    if (node.type === 'jobcard') {
      return startY + ROW_H.job;
    }

    if (!node.data?.expanded) {
      const h = kind === 'branch' ? ROW_H.branch : ROW_H.bucket; // bucket === category === 70
      return startY + h;
    }

    // Expanded: lay out visible children
    const childIds = Array.isArray(node.data?.childIds) ? node.data.childIds : [];
    const isBucketNode = kind === 'bucket';
    const visCount = isBucketNode
      ? Math.min(node.data?.visibleCount ?? BUCKET_VISIBLE_DEFAULT, childIds.length)
      : childIds.length;

    let nextY = startY;
    for (let i = 0; i < visCount; i++) {
      nextY = layoutNode(childIds[i], nextY);
    }
    return nextY;
  }

  let nextY = hubPos.y;
  for (const root of rootGroups) {
    nextY = layoutNode(root.id, nextY);
  }

  return positions;
}

// Stable per-job fingerprint. The search-side dedup pass already enforces
// uniqueness on (title|company); url is defense-in-depth in case future
// sources surface duplicate listings.
const keyOf = (job) => `${job?.title}|${job?.company}|${job?.url || ''}`;

/**
 * Split scored jobs into:
 *  - targetList: target-role matches (≥ LIKELY) plus loose-fill up to 5
 *  - otherList:  non-target matches with score ≥ LIKELY
 *  - displayedJobs: union of the two, in target-first order
 *
 * When `hasTarget` is false the function is a passthrough — caller spawns
 * every scored job under the original flat hub structure.
 */
export function partitionJobsForBranches(scoredJobs, hasTarget) {
  if (!hasTarget) {
    return { targetList: [], otherList: [], displayedJobs: scoredJobs, gate: LIKELY_THRESHOLD };
  }
  const targetCandidates = scoredJobs.filter(j => j.isTargetRoleMatch);
  const likelyTargets = targetCandidates.filter(j => (j.matchScore || 0) >= LIKELY_THRESHOLD);
  let targetList;
  if (likelyTargets.length >= TARGET_FILL_MIN) {
    targetList = likelyTargets;
  } else {
    // Loose-fill: backfill the Target Role branch with the highest-scoring
    // sub-threshold target jobs so the user gets ~5 best shots to chase
    // even when the pivot is a real stretch. Badged 'stretch' so the card
    // strength indicator distinguishes filler from genuine likely matches.
    const needed = TARGET_FILL_MIN - likelyTargets.length;
    const fillers = targetCandidates
      .filter(j => (j.matchScore || 0) < LIKELY_THRESHOLD)
      .sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0))
      .slice(0, needed)
      .map(j => ({ ...j, strengthLabel: 'stretch' }));
    targetList = [...likelyTargets, ...fillers];
  }
  // Relative cutoff from this run's non-target distribution (relaxes when thin).
  const gate = strongMatchGate(
    scoredJobs.filter(j => !j.isTargetRoleMatch).map(j => j.matchScore || 0),
  );
  const otherList = scoredJobs.filter(
    j => !j.isTargetRoleMatch && (j.matchScore || 0) >= gate,
  );
  return { targetList, otherList, displayedJobs: [...targetList, ...otherList], gate };
}

/**
 * Build the bucket-jobs input array. When hasTarget is true, overrides the
 * careerDirection on target jobs to TARGET_BUCKETING_CATEGORY so the
 * downstream AI bucketing produces a dedicated "Target Role" category we
 * mount under the Target Role branch.
 *
 * Pass `displayedJobs` (the filtered set) when hasTarget; pass the full
 * scored array otherwise — the function infers the right source via flag.
 */
export function buildJobsForBucketing(displayedJobs, targetList, scoredJobs, hasTarget) {
  if (!hasTarget) return scoredJobs;
  const targetKeys = new Set(targetList.map(keyOf));
  return displayedJobs.map(j => (targetKeys.has(keyOf(j))
    ? { ...j, careerDirection: TARGET_BUCKETING_CATEGORY }
    : j));
}

/**
 * Build the ReactFlow `newNodes` / `newEdges` arrays for the entire job
 * subtree (branches → categories → buckets → cards). Pure: emits arrays,
 * does not call any ReactFlow setters.
 */
export function buildJobTreeNodes({
  scoredJobs,
  bucketTree,
  bucketingInput,
  targetList,
  otherList,
  displayedJobs,
  hasTarget,
  targetRole,
  profile,
  originalPos,
  hubId,
  baseNodeId,
}) {
  const newNodes = [];
  const newEdges = [];
  const structuralEdgeProps = structuralEdge('rgba(96,165,250,0.5)');
  const COL_X = hasTarget ? COL_X_WITH_TARGET : COL_X_WITHOUT_TARGET;

  // bucketingInput holds the indices the AI's `jobIndices` reference. When
  // there's no target role the AI sees the full scored array verbatim.
  const lookupArr = hasTarget ? bucketingInput : scoredJobs;
  const targetKeySet = hasTarget ? new Set(targetList.map(keyOf)) : new Set();

  const spawnedKeys = new Set();
  let nextJobNodeIdx = 0;

  // ── Small spawn helpers ──────────────────────────────────────────────
  const pushJobNode = (job, position) => {
    const jobId = `${baseNodeId}-job-${nextJobNodeIdx++}`;
    newNodes.push({
      id: jobId,
      type: 'jobcard',
      position,
      hidden: true,
      data: {
        hubId,
        title: job.title, company: job.company, location: job.location,
        salary: job.salary, snippet: job.snippet, matchScore: job.matchScore,
        reasoning: job.reasoning, careerDirection: job.careerDirection,
        strengthLabel: job.strengthLabel, source: job.source,
        url: job.url, posted: job.posted, resumeProfile: profile, isNew: false,
        isTargetRoleMatch: !!job.isTargetRoleMatch,
      },
    });
    return jobId;
  };

  const pushBucketNode = ({ id, x, y, label, childIds, minSalary = 0, maxSalary = 0 }) => {
    newNodes.push({
      id,
      type: 'jobgroup',
      position: { x: originalPos.x + x, y },
      hidden: true,
      data: {
        kind: 'bucket', hubId, label, count: childIds.length,
        childIds, visibleCount: Math.min(BUCKET_VISIBLE_DEFAULT, childIds.length),
        expanded: false, minSalary, maxSalary,
      },
    });
  };

  const pushEdge = (sourceId, targetId) => {
    newEdges.push({
      id: `edge-${sourceId}-${targetId}`,
      source: sourceId, target: targetId,
      ...structuralEdgeProps,
    });
  };

  // Resolve a bucket's jobIndices into spawned job-node IDs. Skips jobs
  // already spawned (defensive against AI returning the same index twice)
  // and jobs that don't satisfy the optional caller-supplied filter.
  const spawnBucketJobs = (jobIndices, bucketY, jobColX, keyFilter) => {
    const ids = [];
    (jobIndices || []).forEach((jobIdx, ji) => {
      const sourceJob = lookupArr[jobIdx];
      if (!sourceJob) return;
      const k = keyOf(sourceJob);
      if (spawnedKeys.has(k)) return;
      if (keyFilter && !keyFilter(k)) return;
      spawnedKeys.add(k);
      // Prefer the displayed-list copy so the strengthLabel override
      // applied during loose-fill propagates onto the spawned card.
      const displayJob = (hasTarget ? displayedJobs : scoredJobs).find(j => keyOf(j) === k) || sourceJob;
      const jobId = pushJobNode(displayJob, { x: originalPos.x + jobColX, y: bucketY + ji * ROW_H.job });
      ids.push(jobId);
    });
    return ids;
  };

  // Spawn one category's buckets + jobs. Returns the category node id or
  // null when no surviving buckets remain (so callers can omit it from
  // their parent's childIds without dangling references).
  const spawnCategorySubtree = (category, catY, parentId, idPrefix, ci, parentColX, bucketColX, jobColX, keyFilter) => {
    const catId = `${idPrefix}-cat-${ci}`;
    const catChildIds = [];
    let catJobCount = 0;
    let nextBucY = catY;

    (category.buckets || []).forEach((bucket, bi) => {
      const bucId = `${catId}-buc-${bi}`;
      const bucY  = nextBucY;
      const bucChildIds = spawnBucketJobs(bucket.jobIndices, bucY, jobColX, keyFilter);
      bucChildIds.forEach(jobId => pushEdge(bucId, jobId));
      if (bucChildIds.length === 0) return; // skip empty bucket entirely
      catChildIds.push(bucId);
      catJobCount += bucChildIds.length;
      pushBucketNode({
        id: bucId, x: bucketColX, y: bucY, label: bucket.label || 'Unspecified',
        childIds: bucChildIds, minSalary: bucket.minSalary, maxSalary: bucket.maxSalary,
      });
      pushEdge(catId, bucId);
      // Minimal spacing at spawn — relayout corrects positions on first expand
      nextBucY = bucY + ROW_H.bucket;
    });

    if (catChildIds.length === 0) return null;
    newNodes.push({
      id: catId,
      type: 'jobgroup',
      position: { x: originalPos.x + parentColX, y: catY },
      hidden: parentId !== hubId, // hidden under a branch; visible under hub root
      data: {
        kind: 'category', hubId, label: category.name || 'Other',
        count: catJobCount, childIds: catChildIds, expanded: false,
      },
    });
    pushEdge(parentId, catId);
    return { catId, nextY: nextBucY };
  };

  // Single-bucket fallback for jobs the AI failed to bucket. Used both for
  // missing-target sweep under Target Role branch and for Uncategorized
  // sweep under the Other Strong / hub-root level.
  const spawnFallbackBucket = (jobs, bucId, bucY, jobColX) => {
    const ids = jobs.map((job, ji) => {
      spawnedKeys.add(keyOf(job));
      const jobId = pushJobNode(job, { x: originalPos.x + jobColX, y: bucY + ji * ROW_H.job });
      pushEdge(bucId, jobId);
      return jobId;
    });
    return ids;
  };

  // ── Main spawning algorithm ──────────────────────────────────────────
  if (bucketTree && hasTarget) {
    // Target Role branch: skip the Category level — all target jobs cluster
    // under the synthetic "Target Role" category whose buckets we mount
    // directly under the branch.
    const targetCategory = bucketTree.find(c => c.name === TARGET_BUCKETING_CATEGORY);
    const targetBranchId = `${baseNodeId}-branch-target`;
    const targetBranchChildIds = [];
    const targetBranchY = originalPos.y;

    let nextTargetBucY = targetBranchY;
    (targetCategory?.buckets || []).forEach((bucket, bi) => {
      const bucId = `${targetBranchId}-buc-${bi}`;
      const bucY  = nextTargetBucY;
      const bucChildIds = spawnBucketJobs(bucket.jobIndices, bucY, COL_X.job, (k) => targetKeySet.has(k));
      bucChildIds.forEach(jobId => pushEdge(bucId, jobId));
      if (bucChildIds.length === 0) return;
      targetBranchChildIds.push(bucId);
      pushBucketNode({
        id: bucId, x: COL_X.bucket, y: bucY, label: bucket.label || 'Unspecified',
        childIds: bucChildIds, minSalary: bucket.minSalary, maxSalary: bucket.maxSalary,
      });
      pushEdge(targetBranchId, bucId);
      nextTargetBucY = bucY + ROW_H.bucket;
    });

    // Sweep any target jobs the AI missed into a synthetic "All" bucket so
    // nothing falls off the canvas.
    const targetMissing = targetList.filter(j => !spawnedKeys.has(keyOf(j)));
    if (targetMissing.length > 0) {
      EventLogger.error(`[JobHub] Target bucketing missed ${targetMissing.length} job(s) — placing in synthetic "All"`);
      const bucId = `${targetBranchId}-buc-fallback`;
      const bucY  = nextTargetBucY;
      const bucChildIds = spawnFallbackBucket(targetMissing, bucId, bucY, COL_X.job);
      targetBranchChildIds.push(bucId);
      pushBucketNode({ id: bucId, x: COL_X.bucket, y: bucY, label: 'All', childIds: bucChildIds });
      pushEdge(targetBranchId, bucId);
      nextTargetBucY = bucY + ROW_H.bucket;
    }

    // Target Role branch node — always visible, even when empty, so the
    // user knows their target was processed.
    newNodes.push({
      id: targetBranchId,
      type: 'jobgroup',
      position: { x: originalPos.x + COL_X.branch, y: targetBranchY },
      data: {
        kind: 'branch', hubId, label: `Target Role · ${targetRole}`,
        count: targetList.length, childIds: targetBranchChildIds, expanded: false,
      },
    });
    pushEdge(hubId, targetBranchId);

    // Other Strong Matches branch — only when non-empty.
    if (otherList.length > 0) {
      const otherBranchId = `${baseNodeId}-branch-other`;
      const otherBranchY  = nextTargetBucY + ROW_H.branch;
      const otherCategories = bucketTree.filter(c => c.name !== TARGET_BUCKETING_CATEGORY);
      const otherKeyFilter = (k) => !targetKeySet.has(k);
      const otherBranchChildIds = [];

      let nextCatY = otherBranchY;
      otherCategories.forEach((cat, ci) => {
        const result = spawnCategorySubtree(
          cat, nextCatY, otherBranchId, otherBranchId, ci,
          COL_X.category, COL_X.bucket, COL_X.job, otherKeyFilter,
        );
        if (result) {
          otherBranchChildIds.push(result.catId);
          nextCatY += ROW_H.category;
        }
      });

      const otherMissing = otherList.filter(j => !spawnedKeys.has(keyOf(j)));
      if (otherMissing.length > 0) {
        EventLogger.error(`[JobHub] Other bucketing missed ${otherMissing.length} job(s) — placing in synthetic Uncategorized`);
        const catId = `${otherBranchId}-cat-missing`;
        const catY  = nextCatY;
        const bucId = `${catId}-buc-0`;
        const bucChildIds = spawnFallbackBucket(otherMissing, bucId, catY, COL_X.job);
        pushBucketNode({ id: bucId, x: COL_X.bucket, y: catY, label: 'All', childIds: bucChildIds });
        pushEdge(catId, bucId);
        newNodes.push({
          id: catId, type: 'jobgroup',
          position: { x: originalPos.x + COL_X.category, y: catY },
          hidden: true,
          data: {
            kind: 'category', hubId, label: 'Uncategorized',
            count: bucChildIds.length, childIds: [bucId], expanded: false,
          },
        });
        pushEdge(otherBranchId, catId);
        otherBranchChildIds.push(catId);
      }

      if (otherBranchChildIds.length > 0) {
        newNodes.push({
          id: otherBranchId, type: 'jobgroup',
          position: { x: originalPos.x + COL_X.branch, y: otherBranchY },
          data: {
            kind: 'branch', hubId, label: 'Other Strong Matches',
            count: otherList.length, childIds: otherBranchChildIds, expanded: false,
          },
        });
        pushEdge(hubId, otherBranchId);
      }
    }
  } else if (bucketTree) {
    // No target role — original flat structure: categories direct under hub.
    let nextCatY = originalPos.y;
    bucketTree.forEach((category, ci) => {
      const result = spawnCategorySubtree(
        category, nextCatY, hubId, baseNodeId, ci,
        COL_X.category, COL_X.bucket, COL_X.job, null,
      );
      // Minimal spacing at spawn — relayout corrects positions on expand
      if (result) nextCatY += ROW_H.category;
    });
    // Uncategorized sweep for any unbucketed scored jobs.
    const missing = scoredJobs.filter(j => !spawnedKeys.has(keyOf(j)));
    if (missing.length > 0) {
      EventLogger.error(`[JobHub] Bucketing missed ${missing.length} job(s) — placing in synthetic Uncategorized`);
      const catId = `${baseNodeId}-cat-missing`;
      const catY  = nextCatY;
      const bucId = `${catId}-buc-0`;
      const bucChildIds = spawnFallbackBucket(missing, bucId, catY, COL_X.job);
      pushBucketNode({ id: bucId, x: COL_X.bucket, y: catY, label: 'All', childIds: bucChildIds });
      pushEdge(catId, bucId);
      newNodes.push({
        id: catId, type: 'jobgroup',
        position: { x: originalPos.x + COL_X.category, y: catY },
        data: {
          kind: 'category', hubId, label: 'Uncategorized',
          count: bucChildIds.length, childIds: [bucId], expanded: false,
        },
      });
      pushEdge(hubId, catId);
    }
  } else {
    // Bucketing failed entirely — flat spawn under the hub (legacy fallback
    // so the user still sees something after a bucket-jobs error).
    const flatSource = hasTarget ? displayedJobs : scoredJobs;
    flatSource.forEach((job, index) => {
      const jobId = `${baseNodeId}-job-flat-${index}`;
      newNodes.push({
        id: jobId,
        type: 'jobcard',
        position: { x: originalPos.x + COL_X.job, y: originalPos.y + index * ROW_H.job },
        data: {
          hubId,
          title: job.title, company: job.company, location: job.location,
          salary: job.salary, snippet: job.snippet, matchScore: job.matchScore,
          reasoning: job.reasoning, careerDirection: job.careerDirection,
          strengthLabel: job.strengthLabel, source: job.source,
          url: job.url, posted: job.posted, resumeProfile: profile, isNew: false,
          isTargetRoleMatch: !!job.isTargetRoleMatch,
        },
      });
      pushEdge(hubId, jobId);
    });
  }

  // Slider iterates over spawned scores, not the full scored array.
  const flatJobsToSpawn = hasTarget ? displayedJobs : scoredJobs;
  const spawnedScores = flatJobsToSpawn.map(j => j.matchScore || 0);
  const scoreRangeMin = spawnedScores.length > 0 ? Math.min(...spawnedScores) : 0;
  const scoreRangeMax = spawnedScores.length > 0 ? Math.max(...spawnedScores) : 100;

  return { newNodes, newEdges, scoreRangeMin, scoreRangeMax };
}
