import { buildOfficialPostingSemanticInventory, buildOfficialPostingSemanticOptions } from './officialPostingSemantic.js';
import { validateSemanticOfficialPostingMatchResponse, validateSemanticOfficialPostingShortlistResponse } from './officialPostingBridge.js';
import { officialPostingComparativeTrail } from './officialPostingFields.js';

/** The host admits independently proven sources. Only the two AI judgments
 * decide whether their meaning identifies the original posting. */
export async function resolveSemanticOfficialPosting(job, candidates, { match, shortlist, signal, now = Date.now } = {}) {
  const trail = [];
  const unsettled = (code = 'semantic-uncertain', alternatives = []) => ({ outcome: 'ambiguous', candidate: null,
    evaluations: [], alternatives, trail: [...trail, code], settled: false });
  let inventory;
  try { inventory = buildOfficialPostingSemanticInventory(candidates, { now }); }
  catch { return unsettled('semantic-overflow'); }
  if (!inventory.length) return { outcome: 'not-found', candidate: null, evaluations: [], alternatives: [], trail, settled: true };
  let selected = inventory;
  if (selected.length > 8) {
    if (!shortlist) return unsettled('comparative-unavailable');
    // Each round includes every remaining record. No lexical rank or array
    // slice silently removes a candidate from semantic consideration.
    while (selected.length > 8) {
      const next = [];
      for (let index = 0; index < selected.length; index += 64) {
        if (signal?.aborted) return unsettled('bridge-aborted');
        const chunk = selected.slice(index, index + 64);
        try {
          const answer = validateSemanticOfficialPostingShortlistResponse(await shortlist(job, chunk, { signal }), { candidates: chunk });
          if (answer.uncertain) return unsettled();
          next.push(...chunk.filter(item => answer.selected.includes(item.id)));
        } catch { return unsettled('comparative-invalid'); }
      }
      // A shortlist is triage, so an empty selection cannot establish a miss.
      if (!next.length || next.length >= selected.length) return unsettled();
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
  const finish = result => ({ ...result, comparison });
  if (!runs.A || !runs.B) return finish(unsettled(signal?.aborted ? 'bridge-aborted' : comparison.unavailable ? 'comparative-unavailable' : 'comparative-invalid'));
  if (runs.A.choice !== runs.B.choice) {
    comparison.disagreement = true;
    return finish(unsettled('semantic-uncertain', options.map(item => ({ url: item.sourceUrl, title: item.title }))));
  }
  comparison.agreement = true;
  if (runs.A.choice === 'uncertain') return finish(unsettled());
  if (runs.A.choice === 'none') {
    comparison.none = true;
    return finish({ outcome: 'not-found', candidate: null, evaluations: [], alternatives: [], trail: [...trail, 'comparative-none'], settled: true });
  }
  const chosen = options.find(item => item.id === runs.A.choice);
  comparison.accepted = true;
  const unavailable = chosen.status !== 'live';
  return finish({ outcome: chosen.status === 'closed' ? 'closed' : unavailable ? 'unreadable' : 'found', candidate: unavailable ? null : chosen.candidate,
    evaluations: [{ candidate: chosen.candidate, passed: !unavailable, identityPass: true,
      reason: unavailable ? 'closed' : '', anchors: ['comparative-match'], reasons: [] }],
    alternatives: [], trail: [...trail, chosen.status === 'closed' ? 'closed' : 'comparative-match',
      ...(chosen.status === 'unavailable' ? ['official-liveness-unconfirmed'] : [])], settled: chosen.status !== 'unavailable' });
}
