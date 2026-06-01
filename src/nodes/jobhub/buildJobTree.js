import { structuralEdge } from '../_shared/edgeHelpers.js';

/**
 * Pure helpers for turning scored jobs + an AI-created taxonomy into the React
 * Flow node/edge graph the JobHub spawns. Lives outside the component so the
 * algorithm is unit-testable without a ReactFlow runtime — JobHubNode.jsx wires
 * up the IPC plumbing and passes the results to ReactFlow.
 *
 * The results hierarchy is THREE grouping levels, deepest last:
 *   1. Likelihood band — interview-likelihood (matchScore), ordered HIGH→LOW.
 *   2. Salary range    — ordered HIGH→LOW (Unspecified last).
 *   3. Job role        — ordered A→Z.
 * …then the job cards (ordered by score desc).
 *
 * The AI (bucketing pass) CREATES every band / range / role label — nothing is
 * hardcoded. It returns the band + range definitions and a role partition; the
 * renderer places each job into its band (by its own matchScore) and its salary
 * range (by parsed salary) DETERMINISTICALLY, so a weak model can't drop or
 * duplicate jobs across the three nested levels. Only the role grouping (the
 * creative consolidation) comes from the AI's partition; jobs the AI leaves out
 * fall into a swept "Other" role.
 *
 * Exports:
 *  - partitionJobsForBranches → display set = all scored jobs (target ≡ no-target)
 *  - parseSalaryToNumeric     → salary text → annual USD (shared with append)
 *  - computeLayoutPositions   → tight (x,y) for the current expand state
 *  - buildJobTreeNodes        → emits the {nodes, edges} graph
 */

// Column x-offsets per tree level + row heights. One layout: likelihood is
// always the first level (no target-role branch column).
export const COL_X = { likelihood: 400, salary: 700, role: 1000, job: 1400 };
const ROW_H = { group: 70, job: 280 }; // module-local: only used within this file

// Vertical gap kept below an EXPANDED job card (one whose measured height exceeds
// the fixed ROW_H.job). Collapsed/normal cards keep the original ROW_H.job
// spacing via the Math.max in computeLayoutPositions, so the default layout is
// unchanged — this only governs how far the next card sits below a grown one.
const JOB_V_GAP = 40;

// Leaf (role) groups paginate their cards; reveal the first N on expand.
export const ROLE_VISIBLE_DEFAULT = 10;

// Fallbacks ONLY when the AI omits bands/ranges (normal path is AI-defined).
const DEFAULT_BANDS = [
  { label: 'Strong match (65–100%)', minScore: 65, maxScore: 100 },
  { label: 'Possible (40–64%)',      minScore: 40, maxScore: 64 },
  { label: 'Long shot (0–39%)',      minScore: 0,  maxScore: 39 },
];
const DEFAULT_RANGES = [
  { label: '$150k+',     minSalary: 150000, maxSalary: 0 },
  { label: '$100–150k',  minSalary: 100000, maxSalary: 150000 },
  { label: '$60–100k',   minSalary: 60000,  maxSalary: 100000 },
  { label: 'Under $60k', minSalary: 1,      maxSalary: 60000 },
  { label: 'Unspecified', minSalary: 0,     maxSalary: 0 },
];

/**
 * Salary text → approximate annual USD. Takes the first number in a range and
 * annualizes hourly/daily rates. Shared with the append path so spawned and
 * appended cards land in the same salary range. Returns 0 when unparseable.
 */
export function parseSalaryToNumeric(salaryStr) {
  if (!salaryStr) return 0;
  const clean = String(salaryStr).toLowerCase().replace(/[$,]/g, '');
  const m = clean.match(/(\d+)\s*(k)?/);
  if (!m) return 0;
  let val = parseFloat(m[1]);
  if (m[2] === 'k') val *= 1000;
  if (val < 1000) {
    if (clean.includes('hour') || clean.includes('hr')) val = val * 40 * 52;
    else if (clean.includes('day')) val = val * 5 * 52;
  }
  return val;
}

/**
 * Display set = EVERY scored job. Target and no-target runs are identical here:
 * a target role only adds queries upstream (see generate-job-queries); it never
 * gates, fills, sorts, or categorizes the results differently. Kept as a named
 * function so the "all scored jobs are shown" contract has one tested home.
 */
export function partitionJobsForBranches(scoredJobs) {
  return { displayedJobs: scoredJobs };
}

// ── Deterministic placement ────────────────────────────────────────────────

/** Normalize + sort AI bands high→low; guarantee coverage down to 0. */
export function normalizeBands(bands) {
  const src = Array.isArray(bands) && bands.length ? bands : DEFAULT_BANDS;
  return [...src]
    .map(b => ({ label: b.label || 'Match', minScore: Number(b.minScore) || 0, maxScore: Number(b.maxScore) || 100 }))
    .sort((a, b) => b.minScore - a.minScore);
}

/** Split AI salary ranges into ordered (high→low) real ranges + an Unspecified. */
export function normalizeRanges(ranges) {
  const src = Array.isArray(ranges) && ranges.length ? ranges : DEFAULT_RANGES;
  const mapped = src.map(r => ({
    label: r.label || 'Unspecified',
    minSalary: Number(r.minSalary) || 0,
    maxSalary: Number(r.maxSalary) || 0,
  }));
  let unspecified = mapped.find(r => r.minSalary === 0 && r.maxSalary === 0);
  const real = mapped.filter(r => r !== unspecified).sort((a, b) => b.minSalary - a.minSalary);
  if (!unspecified) unspecified = { label: 'Unspecified', minSalary: 0, maxSalary: 0 };
  return { real, unspecified };
}

/** Band a score lands in (first whose minScore it meets, in high→low order).
 *  Exported so the JobHubNode append path places appended cards on the exact
 *  same band as the initial spawn (single source of truth — see its callsite). */
export function placeBand(score, bands) {
  const s = typeof score === 'number' ? score : 0;
  for (const b of bands) if (s >= b.minScore) return b;
  return bands[bands.length - 1];
}

/** Salary range a number lands in; unknown/zero salary → Unspecified. */
export function placeRange(salNum, realRanges, unspecified) {
  if (!(salNum > 0)) return unspecified;
  for (const r of realRanges) if (salNum >= r.minSalary) return r;
  return unspecified;
}

/**
 * Compute absolute canvas positions for every visible job-tree node owned by
 * `hubId`, based on the current expanded/collapsed state. Kind-agnostic: a
 * group's x comes from COL_X[kind]; a group whose direct children are job cards
 * paginates them via visibleCount. Returns { [nodeId]: {x, y} } for reachable
 * visible nodes only.
 */
export function computeLayoutPositions(nodes, hubId, COL_X_, hubPos) {
  const nodeById = new Map(nodes.map(n => [n.id, n]));

  const allChildIds = new Set();
  nodes.forEach(n => {
    if (n.data?.hubId === hubId && Array.isArray(n.data?.childIds)) {
      n.data.childIds.forEach(cid => allChildIds.add(cid));
    }
  });

  const rootGroups = nodes
    .filter(n => n.data?.hubId === hubId && n.type === 'jobgroup' && !allChildIds.has(n.id))
    .sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0));

  const positions = {};

  function layoutNode(nodeId, startY) {
    const node = nodeById.get(nodeId);
    if (!node) return startY;

    let x;
    if (node.type === 'jobcard') {
      x = hubPos.x + COL_X_.job;
    } else {
      const kx = COL_X_[node.data?.kind];
      if (kx == null) return startY;
      x = hubPos.x + kx;
    }
    positions[nodeId] = { x, y: startY };

    if (node.type === 'jobcard') {
      // Height-aware stacking: a card taller than the fixed row (e.g. one whose
      // justification is expanded) pushes the cards below it down; when it
      // collapses again they slide back up. Falls back to the fixed row height
      // until ReactFlow has measured the node. Math.max preserves the original
      // spacing for normal/collapsed cards so the default layout is untouched.
      const h = node.measured?.height;
      return startY + (h ? Math.max(ROW_H.job, h + JOB_V_GAP) : ROW_H.job);
    }
    if (!node.data?.expanded) return startY + ROW_H.group;

    const childIds = Array.isArray(node.data?.childIds) ? node.data.childIds : [];
    const childrenAreCards = childIds.length > 0 && nodeById.get(childIds[0])?.type === 'jobcard';
    const visCount = childrenAreCards
      ? Math.min(node.data?.visibleCount ?? ROLE_VISIBLE_DEFAULT, childIds.length)
      : childIds.length;

    let nextY = startY;
    for (let i = 0; i < visCount; i++) nextY = layoutNode(childIds[i], nextY);
    return nextY;
  }

  let nextY = hubPos.y;
  for (const root of rootGroups) nextY = layoutNode(root.id, nextY);
  return positions;
}


/**
 * Build the ReactFlow `newNodes` / `newEdges` arrays for the whole job subtree
 * (likelihood band → salary range → role → cards). Pure: emits arrays, calls no
 * ReactFlow setters.
 *
 * @param {object[]} displayedJobs  the scored jobs to show (post target-select)
 * @param {object|null} bucketTree  { likelihoodBands, salaryRanges, roles } from
 *                                   the AI, or null to flat-spawn on failure
 */
export function buildJobTreeNodes({
  displayedJobs,
  bucketTree,
  profile,
  originalPos,
  hubId,
  baseNodeId,
}) {
  const newNodes = [];
  const newEdges = [];
  const edgeProps = structuralEdge('rgba(96,165,250,0.5)');
  let nextJobIdx = 0;

  const pushEdge = (s, t) => newEdges.push({ id: `edge-${s}-${t}`, source: s, target: t, ...edgeProps });

  const pushCard = (job) => {
    const id = `${baseNodeId}-job-${nextJobIdx++}`;
    newNodes.push({
      id,
      type: 'jobcard',
      position: { x: originalPos.x + COL_X.job, y: originalPos.y },
      hidden: true,
      data: {
        hubId,
        title: job.title, company: job.company, location: job.location,
        salary: job.salary, snippet: job.snippet, matchScore: job.matchScore,
        reasoning: job.reasoning, careerDirection: job.careerDirection,
        source: job.source, url: job.url, posted: job.posted,
        resumeProfile: profile, isNew: false,
      },
    });
    return id;
  };

  const pushGroup = (id, kind, label, childIds, count, { hidden = true, ...extra } = {}) => {
    newNodes.push({
      id,
      type: 'jobgroup',
      position: { x: originalPos.x + COL_X[kind], y: originalPos.y },
      hidden,
      data: {
        kind, hubId, label, count, childIds, expanded: false,
        ...(kind === 'role' ? { visibleCount: Math.min(ROLE_VISIBLE_DEFAULT, childIds.length) } : {}),
        ...extra,
      },
    });
  };

  const hasTaxonomy = bucketTree && Array.isArray(bucketTree.roles);

  if (hasTaxonomy) {
    const bands = normalizeBands(bucketTree.likelihoodBands);
    const { real: realRanges, unspecified } = normalizeRanges(bucketTree.salaryRanges);

    // index → role name (first occurrence wins if the AI duplicated an index)
    const roleByIdx = new Map();
    (bucketTree.roles || []).forEach(r => {
      (r.jobIndices || []).forEach(i => { if (!roleByIdx.has(i)) roleByIdx.set(i, r.name || 'Other'); });
    });

    // Group every displayed job: band → range → role → jobs[]
    const tree = new Map(); // bandLabel -> Map(rangeLabel -> Map(roleName -> jobs[]))
    displayedJobs.forEach((job, i) => {
      const band = placeBand(job.matchScore, bands);
      const range = placeRange(parseSalaryToNumeric(job.salary), realRanges, unspecified);
      const role = roleByIdx.get(i) || 'Other';
      if (!tree.has(band.label)) tree.set(band.label, new Map());
      const byRange = tree.get(band.label);
      if (!byRange.has(range.label)) byRange.set(range.label, new Map());
      const byRole = byRange.get(range.label);
      if (!byRole.has(role)) byRole.set(role, []);
      byRole.get(role).push(job);
    });

    // Emit in canonical order: bands high→low, ranges high→low (Unspecified
    // last), roles A→Z, cards score-desc.
    const orderedRanges = [...realRanges, unspecified];
    let bi = 0;
    for (const band of bands) {
      const byRange = tree.get(band.label);
      if (!byRange) continue;
      const bandId = `${baseNodeId}-L${bi++}`;
      const bandChildIds = [];
      let bandCount = 0;
      let si = 0;
      for (const range of orderedRanges) {
        const byRole = byRange.get(range.label);
        if (!byRole) continue;
        const rangeId = `${bandId}-S${si++}`;
        const rangeChildIds = [];
        let rangeCount = 0;
        const roleNames = [...byRole.keys()].sort((a, b) => a.localeCompare(b));
        let ri = 0;
        for (const roleName of roleNames) {
          const jobs = [...byRole.get(roleName)].sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));
          const roleId = `${rangeId}-R${ri++}`;
          const cardIds = jobs.map(j => { const cid = pushCard(j); pushEdge(roleId, cid); return cid; });
          pushGroup(roleId, 'role', roleName, cardIds, cardIds.length);
          pushEdge(rangeId, roleId);
          rangeChildIds.push(roleId);
          rangeCount += cardIds.length;
        }
        pushGroup(rangeId, 'salary', range.label, rangeChildIds, rangeCount, {
          minSalary: range.minSalary, maxSalary: range.maxSalary,
        });
        pushEdge(bandId, rangeId);
        bandChildIds.push(rangeId);
        bandCount += rangeCount;
      }
      // Band nodes are the visible roots; everything below starts collapsed.
      pushGroup(bandId, 'likelihood', band.label, bandChildIds, bandCount, {
        hidden: false, minScore: band.minScore, maxScore: band.maxScore,
      });
      pushEdge(hubId, bandId);
    }
  } else {
    // Bucketing failed entirely — flat spawn under the hub so the user still
    // sees their jobs (score-desc), just without the band/range/role tree.
    [...displayedJobs]
      .sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0))
      .forEach((job, index) => {
        const id = `${baseNodeId}-job-flat-${index}`;
        newNodes.push({
          id,
          type: 'jobcard',
          position: { x: originalPos.x + COL_X.job, y: originalPos.y + index * ROW_H.job },
          data: {
            hubId,
            title: job.title, company: job.company, location: job.location,
            salary: job.salary, snippet: job.snippet, matchScore: job.matchScore,
            reasoning: job.reasoning, careerDirection: job.careerDirection,
            source: job.source, url: job.url, posted: job.posted,
            resumeProfile: profile, isNew: false,
          },
        });
        pushEdge(hubId, id);
      });
  }

  // ── Lay out the collapsed tree ───────────────────────────────────────────
  // Everything spawns COLLAPSED — the band roots are visible (hidden:false) but
  // closed, and all ranges/roles/cards stay hidden until the user expands. One
  // layout pass stacks the band roots (they all spawn at the same y otherwise).
  // The flat-spawn fallback has no groups → no-op.
  const hasGroups = newNodes.some(n => n.type === 'jobgroup');
  if (hasGroups) {
    const layoutPos = computeLayoutPositions(newNodes, hubId, COL_X, originalPos);
    newNodes.forEach(n => { if (layoutPos[n.id]) n.position = layoutPos[n.id]; });
  }

  // Slider iterates over spawned scores.
  const spawnedScores = displayedJobs.map(j => j.matchScore || 0);
  const scoreRangeMin = spawnedScores.length > 0 ? Math.min(...spawnedScores) : 0;
  const scoreRangeMax = spawnedScores.length > 0 ? Math.max(...spawnedScores) : 100;

  return { newNodes, newEdges, scoreRangeMin, scoreRangeMax };
}
