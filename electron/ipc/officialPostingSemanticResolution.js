import { buildOfficialPostingSemanticInventory, buildOfficialPostingSemanticOptions, evaluateOfficialPostingSourceEligibility } from './officialPostingSemantic.js';
import { validateSemanticOfficialPostingMatchResponse, validateSemanticOfficialPostingShortlistResponse } from './officialPostingBridge.js';
import { officialPostingComparativeTrail } from './officialPostingFields.js';
import { canonicalLeadUrl, sameRequisition } from './officialPostingMatch.js';
import { strictEmployerEqual } from './officialSourceHosts.js';
import { recordOfficialPostingSemanticDiscovery } from './officialPostingDiscoveryDiagnostics.js';

const titleKey = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** Two options that are the same live posting (same URL or requisition, identical title and employer) are one answer, so a split between
 * them is not a disagreement. Any difference in status, title, employer or requisition keeps the split unsettled. */
function equivalentOptions(a, b) {
  if (!a || !b || a.status !== 'live' || b.status !== 'live' || !titleKey(a.title) || titleKey(a.title) !== titleKey(b.title)
    || !strictEmployerEqual(a.employer, b.employer)) return false;
  const url = canonicalLeadUrl(a.sourceUrl);
  return (url !== '' && url === canonicalLeadUrl(b.sourceUrl)) || sameRequisition(a.candidate || a, b.candidate || b);
}
const proofRank = option => Number(option.candidate?.tenantProven === true) * 2 + Number(option.candidate?.employerDomainProven === true);
/** Deterministic representative: tenant proof, then domain proof, then the fuller description, then the lower option id. */
function representativeOption(a, b) {
  return [a, b].sort((x, y) => proofRank(y) - proofRank(x) || String(y.description || '').length - String(x.description || '').length
    || Number(x.id.slice(1)) - Number(y.id.slice(1)))[0];
}

/** The host admits independently proven sources. Only the two AI judgments
 * decide whether their meaning identifies the original posting. */
export async function resolveSemanticOfficialPosting(job, candidates, { match, shortlist, signal, now = Date.now, onDiscovery } = {}) {
  const trail = [];
  const unsettled = (code = 'semantic-uncertain', alternatives = []) => ({ outcome: 'ambiguous', candidate: null,
    evaluations: [], alternatives, trail: [...trail, code], settled: false });
  const sources = Array.isArray(candidates) ? candidates : [];
  const rejected = {};
  let inventory;
  const recorded = result => {
    const attempt = recordOfficialPostingSemanticDiscovery(job, { candidateCount: sources.length, eligibleCount: inventory?.length || 0,
      rejected, outcome: result.outcome, settled: result.settled === true,
      comparisonRuns: Number(result.comparison?.validA === true) + Number(result.comparison?.validB === true) });
    try { onDiscovery?.(attempt); } catch { /* Diagnostics must not interrupt resolution. */ }
    return result;
  };
  try {
    for (const source of sources) {
      const admission = evaluateOfficialPostingSourceEligibility(source, { now });
      if (!admission.eligible) rejected[admission.reason] = (rejected[admission.reason] || 0) + 1;
    }
    inventory = buildOfficialPostingSemanticInventory(candidates, { now });
  }
  catch { return recorded(unsettled('semantic-overflow')); }
  // Failing to prove ownership is not a comparison finding that the job is
  // absent. Keep fetched but unproved employer sources available for a retry.
  if (!inventory.length && rejected['source-unproven']) return recorded(unsettled('source-unproven'));
  // No fetched, verified source is a research gap, not evidence that the
  // original posting is absent. Only comparisons can settle a semantic miss.
  if (!inventory.length) return recorded(unsettled('research-miss'));
  let selected = inventory;
  if (selected.length > 8) {
    if (!shortlist) return recorded(unsettled('comparative-unavailable'));
    // Each round includes every remaining record. No lexical rank or array
    // slice silently removes a candidate from semantic consideration.
    while (selected.length > 8) {
      const next = [];
      for (let index = 0; index < selected.length; index += 64) {
        if (signal?.aborted) return recorded(unsettled('bridge-aborted'));
        const chunk = selected.slice(index, index + 64);
        try {
          const answer = validateSemanticOfficialPostingShortlistResponse(await shortlist(job, chunk, { signal }), { candidates: chunk });
          if (answer.uncertain) return recorded(unsettled());
          next.push(...chunk.filter(item => answer.selected.includes(item.id)));
        } catch { return recorded(unsettled('comparative-invalid')); }
      }
      // A shortlist is triage, so an empty selection cannot establish a miss.
      if (!next.length || next.length >= selected.length) return recorded(unsettled());
      selected = next;
    }
  }
  const { options } = buildOfficialPostingSemanticOptions(inventory, selected.map(item => item.id));
  const comparison = { optionCount: options.length, preCapCount: inventory.length, truncated: false,
    validA: false, validB: false, choiceA: null, choiceB: null, agreement: false, disagreement: false,
    none: false, unavailable: false, accepted: false, invalidRuns: 0 };
  const runs = {};
  for (const run of ['A', 'B']) {
    if (!match || signal?.aborted) {
      comparison.unavailable = !signal?.aborted;
      comparison.invalidRuns += 1;
      continue;
    }
    try {
      const raw = await match(job, options, { run, signal });
      if (signal?.aborted) throw new Error('Comparison stopped');
      runs[run] = validateSemanticOfficialPostingMatchResponse(raw, { job, options });
      comparison[`valid${run}`] = true;
      comparison[`choice${run}`] = runs[run].choice;
    } catch (error) {
      comparison.invalidRuns += 1;
      if (['comparative-unavailable', 'bridge-unavailable', 'OFFICIAL_POSTING_COMPARATIVE_UNAVAILABLE'].includes(error?.code)) comparison.unavailable = true;
    }
  }
  trail.push(...officialPostingComparativeTrail(comparison));
  const finish = result => recorded({ ...result, comparison });
  if (!runs.A || !runs.B) return finish(unsettled(signal?.aborted ? 'bridge-aborted' : comparison.unavailable ? 'comparative-unavailable' : 'comparative-invalid'));
  const optionA = options.find(item => item.id === runs.A.choice); const optionB = options.find(item => item.id === runs.B.choice);
  const equivalent = runs.A.choice !== runs.B.choice && equivalentOptions(optionA, optionB);
  if (equivalent) trail.push('comparative-equivalent', `comparative-choice-${representativeOption(optionA, optionB).id.toLowerCase()}`);
  if (runs.A.choice !== runs.B.choice && !equivalent) {
    comparison.disagreement = true;
    return finish(unsettled('semantic-uncertain', options.map(item => ({ url: item.sourceUrl, title: item.title }))));
  }
  comparison.agreement = true;
  if (runs.A.choice === 'uncertain') return finish(unsettled());
  if (runs.A.choice === 'none') {
    comparison.none = true;
    if (rejected['source-unproven']) return finish({ ...unsettled('source-unproven'),
      trail: [...trail, 'comparative-none', 'source-unproven'] });
    return finish({ outcome: 'not-found', candidate: null, evaluations: [], alternatives: [], trail: [...trail, 'comparative-none'], settled: true });
  }
  const chosen = equivalent ? representativeOption(optionA, optionB) : options.find(item => item.id === runs.A.choice);
  comparison.accepted = true;
  const unavailable = chosen.status !== 'live';
  return finish({ outcome: chosen.status === 'closed' ? 'closed' : unavailable ? 'unreadable' : 'found', candidate: unavailable ? null : chosen.candidate,
    evaluations: [{ candidate: chosen.candidate, passed: !unavailable, identityPass: true,
      reason: unavailable ? 'closed' : '', anchors: ['comparative-match'], reasons: [] }],
    alternatives: [], trail: [...trail, chosen.status === 'closed' ? 'closed' : 'comparative-match',
      ...(chosen.status === 'unavailable' ? ['official-liveness-unconfirmed'] : [])], settled: chosen.status !== 'unavailable' });
}
