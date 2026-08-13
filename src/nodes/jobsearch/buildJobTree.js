import { structuralEdge } from '../_shared/edgeHelpers.js';
import { isJobCardVisible } from '../../utils/jobCardFilters.js';

/**
 * Pure helpers for turning scored jobs + an AI-created taxonomy into the React
 * Flow node/edge graph the Job Search Module spawns. Lives outside the component so the
 * algorithm is unit-testable without a ReactFlow runtime — JobSearchNode.jsx wires
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
 *  - parseSalaryToNumeric     → salary text → annual USD
 *  - computeLayoutPositions   → tight (x,y) for the current expand state
 *  - computeJobTreeView       → single derivation of `hidden` from expand × filter
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

function formatSalaryShort(value) {
  const n = Math.round(Number(value) || 0);
  if (n >= 1000 && n % 1000 === 0) return `$${Math.round(n / 1000)}k`;
  return `$${n.toLocaleString('en-US')}`;
}

/** A salary-band label is data derived from its bounds, never model-authored prose. */
export function canonicalSalaryRangeLabel(minSalary, maxSalary) {
  const min = Math.max(0, Math.round(Number(minSalary) || 0));
  const max = Math.max(0, Math.round(Number(maxSalary) || 0));
  if (min === 0 && max === 0) return 'Unspecified';
  if (max === 0) return `${formatSalaryShort(min)}+/yr`;
  if (min <= 1) return `Under ${formatSalaryShort(max)}/yr`;
  return `${formatSalaryShort(min)}–${formatSalaryShort(max)}/yr`;
}

/**
 * Salary text → approximate annual USD. Takes the first number in a range and
 * annualizes hourly/daily rates. Used by buildJobTreeNodes (and the re-layout in
 * computeJobTreeView) so every card lands in a consistent salary range. Returns
 * 0 when unparseable.
 */
export function parseSalaryToNumeric(salaryStr) {
  if (!salaryStr) return 0;
  const raw = String(salaryStr);
  const clean = raw.toLowerCase().replace(/[$,]/g, '');
  // A benefits blurb such as "401k matching" is common in descriptions and is
  // never pay. Keep legitimate bare "$95k" / "95k" salary values intact.
  if (!/\$/.test(raw) && /\b401\s*k\b/i.test(raw)) return 0;
  const m = clean.match(/(\d+(?:\.\d+)?)\s*([km](?![a-z]))?/);
  if (!m) return 0;
  let val = parseFloat(m[1]);
  if (m[2] === 'k') val *= 1000;
  if (m[2] === 'm') val *= 1000000;
  // SUB-ANNUAL cadences — the ones that drive a multiplier below. Word forms
  // ("$19 Hourly", "$1.6K Weekly") are as common on a pay chip as slash forms,
  // and `\bhour\b` does not match "hourly", so both spellings are listed.
  const hasCadence = /\b(?:bi[-\s]?weekly|week|wk|weekly|month|mo|monthly|day|daily|hour|hr|hourly)s?\b|\/\s*(?:bi[-\s]?wk|wk|mo|day|hr)\b/.test(clean);
  // An ANNUAL cadence needs no multiplier, but it does prove the number is pay —
  // so it lifts the implausible-magnitude guard for a genuinely low annual figure
  // ("$8,000 a year" on a part-time req). Gated on a currency marker so the bare
  // word in prose ("3 years experience") stays an incidental number, not a salary.
  const hasAnnualCadence = /[$€£]/.test(raw) && /\b(?:year|yr|yearly|annual|annually|annum)s?\b|\/\s*yr\b/.test(clean);
  const hasRange = /\d+(?:\.\d+)?\s*(?:k)?\s*(?:[-–—]|to)\s*\$?\s*\d+/i.test(raw);
  const hasPayContext = /\b(?:salary|pay|compensation|wage|rate)\b/i.test(raw);
  // Do not turn incidental small numbers in a loosely extracted salary field
  // ("3 shifts", "2 days", etc.) into annual compensation. Large bare values
  // and `95k` remain accepted for sources that omit currency formatting.
  //
  // A currency symbol is NOT evidence of an annual figure and never was: the
  // guard used to exempt anything with a `$`, so a ZipRecruiter chip whose "/hr"
  // the extractor had dropped ("$19", "$20", "$18.15") was annualized verbatim
  // into a nineteen-dollar-a-year salary and bucketed as real pay. An amount this
  // small with no cadence, no range and no pay context is a cadence we LOST, not
  // an annual salary — and guessing "it must be hourly" would invent a number the
  // listing never stated, so it goes to Unspecified and the raw text still shows
  // on the card. The extractor-side fixes (MONEY_SRC word forms,
  // formatJsonLdSalary's unit guard) are what recover the real value.
  if (val < 10000 && !hasCadence && !hasAnnualCadence && !hasRange && !hasPayContext) return 0;
  // Cadence wins over magnitude: "$1.6K/wk" is $83,200/year, while
  // "$22/hour" is $45,760/year. Match biweekly before weekly.
  if (/\bbi[-\s]?weekly\b|\bbiweekly\b|\/\s*bi[-\s]?wk\b/.test(clean)) val *= 26;
  else if (/\b(?:week|wk|weekly)s?\b|\/\s*wk\b/.test(clean)) val *= 52;
  else if (/\b(?:month|mo|monthly)s?\b|\/\s*mo\b/.test(clean)) val *= 12;
  else if (/\b(?:day|daily)\b|\/\s*day\b/.test(clean)) val *= 5 * 52;
  else if (/\b(?:hour|hr|hourly)s?\b|\/\s*hr\b/.test(clean)) val *= 40 * 52;
  return Number.isFinite(val) && val > 0 ? Math.round(val) : 0;
}

// ── Deterministic placement ────────────────────────────────────────────────

/** Normalize + sort AI bands high→low; guarantee coverage down to 0. */
function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function bandLabel(label, minScore, maxScore) {
  const raw = String(label || 'Match').trim();
  const expected = `${minScore}–${maxScore}%`;
  if (raw && raw.includes(expected)) return raw;
  const base = raw.replace(/\s*\([^)]*\)\s*$/, '').trim() || 'Match';
  return `${base} (${expected})`;
}

export function normalizeBandsWithRepairs(bands) {
  const repairs = [];
  const input = Array.isArray(bands) ? bands : [];
  const byMin = new Map();
  for (const raw of input) {
    const minScore = clampScore(raw?.minScore);
    if (!Number.isFinite(Number(raw?.minScore)) || Number(raw?.minScore) !== minScore) repairs.push('clamped invalid likelihood bound');
    if (!byMin.has(minScore)) byMin.set(minScore, raw || {});
    else repairs.push(`dropped duplicate likelihood lower bound ${minScore}`);
  }
  if (!byMin.size) {
    repairs.push('used default likelihood bands');
    DEFAULT_BANDS.forEach(b => byMin.set(b.minScore, b));
  }
  if (!byMin.has(0)) {
    byMin.set(0, { label: 'Match', minScore: 0 });
    repairs.push('added 0% likelihood catch-all');
  }
  const ascending = [...byMin.entries()].sort((a, b) => a[0] - b[0]);
  const normalized = ascending.map(([minScore, raw], i) => {
    const maxScore = i + 1 < ascending.length ? ascending[i + 1][0] - 1 : 100;
    const label = bandLabel(raw?.label, minScore, maxScore);
    if (String(raw?.label || '').trim() !== label) repairs.push(`canonicalized likelihood label "${String(raw?.label || '').trim() || 'Match'}"`);
    return { label, minScore, maxScore };
  });
  return { bands: normalized.reverse(), repairs };
}

export function normalizeBands(bands) {
  return normalizeBandsWithRepairs(bands).bands;
}

/** Split AI salary ranges into ordered (high→low) real ranges + an Unspecified. */
export function normalizeRangesWithRepairs(ranges) {
  const repairs = [];
  const input = Array.isArray(ranges) ? ranges : [];
  const byMin = new Map();
  let sawUnspecified = false;
  for (const raw of input) {
    let minSalary = Math.max(0, Math.round(Number(raw?.minSalary) || 0));
    let maxSalary = Math.max(0, Math.round(Number(raw?.maxSalary) || 0));
    if (!Number.isFinite(Number(raw?.minSalary)) || !Number.isFinite(Number(raw?.maxSalary))) repairs.push('repaired non-numeric salary bound');
    if (minSalary === 0 && maxSalary === 0) {
      if (sawUnspecified) repairs.push('dropped duplicate Unspecified salary range');
      sawUnspecified = true;
      continue;
    }
    if (minSalary === 0) {
      minSalary = 1;
      repairs.push('repaired zero lower bound on salary range');
    }
    if (maxSalary > 0 && maxSalary <= minSalary) {
      maxSalary = 0;
      repairs.push(`made invalid salary range at ${formatSalaryShort(minSalary)} open-ended`);
    }
    const existing = byMin.get(minSalary);
    if (!existing) byMin.set(minSalary, { minSalary, maxSalary, rawLabel: String(raw?.label || '').trim() });
    else repairs.push(`dropped duplicate salary lower bound ${formatSalaryShort(minSalary)}`);
  }
  const real = [...byMin.values()].sort((a, b) => b.minSalary - a.minSalary);
  let unspecified = { label: 'Unspecified', minSalary: 0, maxSalary: 0 };
  if (!sawUnspecified) repairs.push('added missing Unspecified salary range');
  const lowest = real[real.length - 1];
  if (lowest && lowest.minSalary > 1) {
    // Keep parseable low salaries out of the "Unspecified" bucket when the AI
    // forgets to include a bottom catch-all range.
    real.push({
      minSalary: 1,
      maxSalary: lowest.minSalary,
    });
    repairs.push(`added low-salary catch-all below ${formatSalaryShort(lowest.minSalary)}`);
  }
  // Ranges are threshold buckets in placeRange, so derive every upper bound
  // from the next higher threshold. This makes their labels truthful and the
  // bands contiguous even if the model supplied overlapping/gapped maxima.
  real.forEach((range, index) => {
    const expectedMax = index === 0 ? 0 : real[index - 1].minSalary;
    if (range.maxSalary !== expectedMax) repairs.push(`normalized salary upper bound for ${formatSalaryShort(range.minSalary)}`);
    range.maxSalary = expectedMax;
    range.label = canonicalSalaryRangeLabel(range.minSalary, range.maxSalary);
    if (range.rawLabel !== range.label) repairs.push(`canonicalized salary label "${range.rawLabel || '(blank)'}"`);
    delete range.rawLabel;
  });
  return { real, unspecified, repairs };
}

export function normalizeRanges(ranges) {
  const { real, unspecified } = normalizeRangesWithRepairs(ranges);
  return { real, unspecified };
}

/**
 * Canonicalize model taxonomy before it becomes persisted UI state. Roles remain
 * model-created, but invalid/out-of-range/duplicate membership cannot distort
 * the deterministic tree (first valid role assignment wins, as on the renderer).
 */
export function sanitizeJobTaxonomy(tree, jobCount = 0, salaries = []) {
  const { bands, repairs: bandRepairs } = normalizeBandsWithRepairs(tree?.likelihoodBands);
  const { real, unspecified, repairs: rangeRepairs } = normalizeRangesWithRepairs(tree?.salaryRanges);
  const repairs = [...bandRepairs, ...rangeRepairs];
  const parseableSalary = (salaries || []).some(s => parseSalaryToNumeric(s) > 0);
  if (real.length === 0 && parseableSalary) {
    const fallback = normalizeRangesWithRepairs(DEFAULT_RANGES);
    real.push(...fallback.real);
    repairs.push('used default salary ranges because model returned no real range for parseable pay');
  }

  const usedIndices = new Set();
  const roleMap = new Map();
  for (const raw of Array.isArray(tree?.roles) ? tree.roles : []) {
    const name = String(raw?.name || '').trim().slice(0, 120) || 'Other';
    if (name !== raw?.name) repairs.push('canonicalized blank or oversized role name');
    const valid = [];
    for (const index of Array.isArray(raw?.jobIndices) ? raw.jobIndices : []) {
      if (!Number.isInteger(index) || index < 0 || index >= jobCount) {
        repairs.push('dropped invalid role job index');
      } else if (usedIndices.has(index)) {
        repairs.push(`dropped duplicate role assignment for job ${index}`);
      } else {
        usedIndices.add(index);
        valid.push(index);
      }
    }
    if (!roleMap.has(name)) roleMap.set(name, []);
    roleMap.get(name).push(...valid);
  }
  if (usedIndices.size < jobCount) repairs.push(`${jobCount - usedIndices.size} job(s) omitted from roles; renderer will use Other`);
  return {
    likelihoodBands: bands,
    salaryRanges: [...real, unspecified],
    roles: [...roleMap.entries()].map(([name, jobIndices]) => ({ name, jobIndices })),
    repairs: [...new Set(repairs)],
  };
}

/** Band a score lands in (first whose minScore it meets, in high→low order).
 *  Single source of truth for band placement, used by buildJobTreeNodes (the
 *  Job Board's Combine spawn) so every card is placed deterministically. */
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
    .filter(n => n.data?.hubId === hubId && n.type === 'jobgroup' && !allChildIds.has(n.id) && !n.hidden)
    .sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0));

  const positions = {};

  function layoutNode(nodeId, startY) {
    const node = nodeById.get(nodeId);
    if (!node) return startY;
    // Hidden nodes (collapsed OR filtered out) take no layout space, so the tree
    // tightens around whatever is removed. Visibility is owned by `hidden`
    // (see computeJobTreeView); this function just lays out what's visible.
    if (node.hidden) return startY;

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

    // Walk EVERY child: visibility (incl. the role leaves' visibleCount window,
    // which under a filter slices the MATCHING cards, not raw childIds) is
    // owned entirely by `hidden` (computeJobTreeView), and hidden nodes take no
    // layout space — so the old visibleCount slice here would have skipped
    // revealed cards that sit beyond the raw-index window when a filter is on,
    // leaving them unpositioned.
    const childIds = Array.isArray(node.data?.childIds) ? node.data.childIds : [];
    let nextY = startY;
    for (const cid of childIds) nextY = layoutNode(cid, nextY);
    return nextY;
  }

  let nextY = hubPos.y;
  for (const root of rootGroups) nextY = layoutNode(root.id, nextY);
  return positions;
}

/**
 * Count the LIVE, filter-matching job cards under a group's childIds —
 * recursively, so it works for band/salary groups (whose children are groups)
 * and role leaves (whose children are cards) alike. Dismissed cards (ids whose
 * node no longer exists) and filtered-out cards don't count, so group badges
 * and the role leaves' "Show more" math stay truthful as cards are dismissed —
 * dismissal being the PRIMARY interaction on disposable cards. Pure: the node
 * accessor is injected so it runs against ReactFlow's nodeLookup (in a store
 * selector) or a plain Map (in tests).
 *
 * @param {string[]} childIds   the group's data.childIds
 * @param {(id: string) => object|undefined} getNodeById
 * @param {{scoreThreshold?: number, sourceFilter?: string|null}} filter
 * @returns {number}
 */
export function countMatchingDescendantCards(childIds, getNodeById, filter = {}) {
  let count = 0;
  const visited = new Set();
  const stack = Array.isArray(childIds) ? [...childIds] : [];
  while (stack.length > 0) {
    const cid = stack.pop();
    if (visited.has(cid)) continue;
    visited.add(cid);
    const n = getNodeById(cid);
    if (!n) continue; // dismissed/deleted — takes no slot
    if (n.type === 'jobcard') {
      if (isJobCardVisible(n.data || {}, filter)) count++;
    } else if (Array.isArray(n.data?.childIds)) {
      stack.push(...n.data.childIds);
    }
  }
  return count;
}

/**
 * Recompute the job tree's visibility for `hubId` from the single source of truth:
 * (current expand/collapse state) × (active card filter). Sets `hidden` on every
 * card/group so a filter ACTUALLY REMOVES non-matching cards and any branch with
 * no matching descendant (not just dims them), then relays out so the tree tightens.
 * Clearing the filter restores the normal collapsed view (everything matches).
 *
 * This is the one place that derives `hidden` — collapse/expand just flips a
 * group's `data.expanded` and calls this, so reveal always respects the filter.
 *
 * `filter` = { scoreThreshold?, sourceFilter? } (same shape as jobCardFilters).
 * Pure: returns a new nodes array (or the same ref when nothing changed).
 */
export function computeJobTreeView(nodes, hubId, filter = {}, COL_X_ = COL_X) {
  const list = Array.isArray(nodes) ? nodes : [];
  const byId = new Map(list.map(n => [n.id, n]));
  const cardMatch = (d) => isJobCardVisible(d || {}, filter);

  // # of matching descendant cards per group (memoized) — a group with 0 is an
  // empty branch under the current filter and gets removed entirely.
  const matchCount = new Map();
  const countMatches = (id) => {
    if (matchCount.has(id)) return matchCount.get(id);
    matchCount.set(id, 0); // guard against cycles
    let c = 0;
    for (const cid of byId.get(id)?.data?.childIds || []) {
      const child = byId.get(cid);
      if (!child) continue;
      c += child.type === 'jobcard' ? (cardMatch(child.data) ? 1 : 0) : countMatches(cid);
    }
    matchCount.set(id, c);
    return c;
  };

  // Band roots = this hub's jobgroups not referenced as anyone's child.
  const allChildIds = new Set();
  list.forEach(n => { if (n.data?.hubId === hubId && Array.isArray(n.data?.childIds)) n.data.childIds.forEach(c => allChildIds.add(c)); });
  const rootGroups = list.filter(n => n.data?.hubId === hubId && n.type === 'jobgroup' && !allChildIds.has(n.id));

  // Walk open paths; collect what should be VISIBLE (matching cards + non-empty
  // branches on an expanded path). Role leaves paginate over the MATCHING,
  // still-on-canvas cards: slicing raw childIds (the old behavior) let
  // non-matching cards and dismissed ghosts consume pagination slots, so an
  // expanded role under a source filter could render zero cards while matches
  // sat beyond the window. Layout positions whatever is revealed (it walks all
  // children and skips hidden), so window math lives only here.
  const visible = new Set();
  const walk = (id) => {
    const node = byId.get(id);
    if (!node) return;
    if (node.type === 'jobcard') { if (cardMatch(node.data)) visible.add(id); return; }
    if (countMatches(id) === 0) return;          // empty branch → removed
    visible.add(id);
    if (!node.data?.expanded) return;
    const childIds = Array.isArray(node.data?.childIds) ? node.data.childIds : [];
    const childrenAreCards = childIds.some(cid => byId.get(cid)?.type === 'jobcard');
    if (childrenAreCards) {
      childIds
        .filter(cid => { const c = byId.get(cid); return c?.type === 'jobcard' && cardMatch(c.data); })
        .slice(0, node.data?.visibleCount ?? ROLE_VISIBLE_DEFAULT)
        .forEach(cid => visible.add(cid));
    } else {
      childIds.forEach(walk);
    }
  };
  rootGroups.forEach(r => walk(r.id));

  // Flat-spawn fallback (bucketing failed → no jobgroups): those jobcards are
  // wired directly to the hub with no group tree, so the walk above never reaches
  // them and they'd ALL be forced hidden (a blank board on filter/restore). Treat
  // each hub-owned jobcard that isn't any group's child as top-level and reveal it
  // iff it matches the filter — mirroring walk's jobcard branch. No-op on the
  // grouped path (those cards ARE in allChildIds, so the guard skips them).
  list.forEach(n => {
    if (n.type === 'jobcard' && n.data?.hubId === hubId && !allChildIds.has(n.id) && cardMatch(n.data)) {
      visible.add(n.id);
    }
  });

  // Apply hidden (+ clear any leftover opacity dim from the old filter approach).
  let changed = false;
  const withHidden = list.map(n => {
    if ((n.type !== 'jobcard' && n.type !== 'jobgroup') || n.data?.hubId !== hubId) return n;
    const hide = !visible.has(n.id);
    const dim = n.type === 'jobcard' && n.style?.opacity !== undefined && n.style.opacity !== 1;
    if (!!n.hidden === hide && !dim) return n;
    changed = true;
    const next = { ...n, hidden: hide };
    if (dim) { const { opacity: _opacity, ...rest } = n.style; next.style = rest; }
    return next;
  });
  if (!changed) return nodes;

  const hubPos = byId.get(hubId)?.position || { x: 0, y: 0 };
  const positions = computeLayoutPositions(withHidden, hubId, COL_X_, hubPos);
  return withHidden.map(n => {
    const p = positions[n.id];
    if (p && (p.x !== n.position.x || p.y !== n.position.y)) return { ...n, position: p };
    return n;
  });
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
        source: job.source, url: job.url, posted: job.posted, language: job.language,
        // The ORIGIN search module's id (the board merges cards from several
        // modules, each with its own career data) — the card's "Generate
        // Résumé" reads careerData from this hub. A string reference, not a
        // copy: the old per-card resumeProfile clone persisted N identical
        // profile objects into the canvas file and nothing ever read it.
        originHubId: job.originHubId || null, isNew: false,
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
            source: job.source, url: job.url, posted: job.posted, language: job.language,
            originHubId: job.originHubId || null, isNew: false,
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
