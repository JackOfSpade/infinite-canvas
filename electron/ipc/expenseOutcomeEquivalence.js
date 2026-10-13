// A closed, evidence-relative spelling of one cost outcome. This does not
// generalize to work, effort, time, headcount or an accomplished reduction.
const PURPOSE_RE = /\bto\s+(?:reduce|lower)\s+(?<before>(?:[\p{L}-]+\s+){0,4})(?<noun>expenses?|costs?)\b(?<after>\s+of\s+(?:[\p{L}-]+\s*){1,3})?/iu;
const INTENT_TRANSFER_RE = /\b(?<actor>we|i|our\s+(?:team|company|organization)|the\s+[\p{L}-]+)\s+(?<bridge>[^.;]{0,100}?)\b(?:decid(?:ed|ing)|plan(?:ned|ning)?|intend(?:ed|ing)?|aim(?:ed|ing)?|chose|choose|sought)\s+to\s+(?<verb>offload|shift|transfer)\b/iu;
const COST_RE = /\b(?<before>(?:[\p{L}-]+\s+){0,4})(?<noun>expenses?|costs?)\b(?<after>\s+of\s+(?:[\p{L}-]+\s*){1,3})?/giu;
const FIRST_PARTY_RE = /^(?:we|i|our\s+(?:team|company|organization))$/iu;
const ORGANIZATION_RE = /^the\s+(?:team|company|organization|business|agency|district|clinic|library|warehouse|school|hospital|office|department)$/iu;
// The only outcome nouns are cost and expense. Their modifiers are copied from
// the two texts being compared, not supplied by a career-specific vocabulary.
const MODIFIER_FILLER = new Set(['the', 'a', 'an', 'our', 'its', 'ongoing', 'recurring', 'continuous', 'continuing', 'future', 'annual', 'monthly', 'in', 'house', 'of']);
const descriptor = groups => [...(String(groups.after || '').match(/[\p{L}]+/gu) || []),
  ...(String(groups.before || '').match(/[\p{L}]+/gu) || [])]
  .map(word => word.toLowerCase()).filter(word => !MODIFIER_FILLER.has(word)).sort().join(' ');
const COMMON_WORK = new Set(['the', 'a', 'an', 'to', 'of', 'for', 'and', 'our', 'we', 'i', 'was', 'were', 'is', 'are', 'this', 'that', 'their', 'into', 'from', 'with', 'by', 'in', 'on', 'at', 'expense', 'expenses', 'cost', 'costs', 'ongoing', 'continuous', 'recurring', 'future', 'annual', 'monthly', 'offload', 'offloaded', 'offloading', 'shift', 'shifted', 'shifting', 'transfer', 'transferred', 'transferring', 'reduce', 'lower', 'decided', 'decision', 'planned', 'intended', 'aimed', 'sought', 'external', 'outside', 'provider', 'third', 'party', 'service', 'system', 'systems', 'platform', 'platforms', 'move', 'moved', 'moving']);
const tokens = value => (String(value).toLowerCase().match(/[\p{L}]+/gu) || []).filter(word => !COMMON_WORK.has(word));

function sameActor(claim, sourceActor) {
  const actor = String(sourceActor).toLowerCase();
  if (FIRST_PARTY_RE.test(actor)) {
    // A career-data first-person plural can also be called the employer in
    // the claim, but an external vendor or customer cannot impersonate it.
    if (/\b(?:vendor|partner|customer|client|supplier|contractor)\b/iu.test(claim)) return false;
    return /\b(?:we|i|our|my)\b/iu.test(claim)
      || /\bthe\s+(?:team|company|organization|business|agency|district|clinic|library|warehouse|school|hospital|office|department)\b/iu.test(claim)
      || /\b(?:migration|transition|move)\b[^.!?]{0,90}\bdecision\b/iu.test(claim);
  }
  if (!ORGANIZATION_RE.test(actor)) return false;
  return new RegExp(`\\b${actor.replace(/\s+/gu, '\\s+')}\\b`, 'iu').test(claim);
}

/** True only for a purpose claim supported by the same actor's same cost-transfer intent. */
export function supportsExpensePurpose(claimText, boundQuotes) {
  const claim = String(claimText ?? '');
  const purpose = PURPOSE_RE.exec(claim);
  if (!purpose) return false;
  const claimKind = descriptor(purpose.groups);
  const frameStart = Math.max(claim.lastIndexOf('.', purpose.index), claim.lastIndexOf(';', purpose.index), claim.lastIndexOf('!', purpose.index)) + 1;
  const frame = claim.slice(frameStart, claim.indexOf('.', purpose.index) < 0 ? undefined : claim.indexOf('.', purpose.index));
  // The equivalence never supplies a figure or magnitude. The check is local
  // to the cost claim, so a later sentence's unrelated third-party reference
  // cannot be mistaken for "one third" of the expense.
  if (/\d|%|\b(?:half|quarter|twice|double|significantly|substantially)\b|\bby\s+(?:a\s+)?third\b/iu.test(frame.slice(purpose.index - frameStart))) return false;
  for (const rawQuote of Array.isArray(boundQuotes) ? boundQuotes : []) {
    const quote = String(rawQuote ?? '');
    const intent = INTENT_TRANSFER_RE.exec(quote);
    if (!intent || !sameActor(frame, intent.groups.actor)
      || /\b(?:vendor|partner|customer|client|supplier|contractor|not|never)\b/iu.test(intent.groups.bridge)) continue;
    const tail = quote.slice(intent.index + intent[0].length, intent.index + intent[0].length + 125);
    // The quote must move the expense away, not merely discuss a transfer.
    const cost = COST_RE.exec(tail);
    COST_RE.lastIndex = 0;
    if (!cost) continue;
    if (descriptor(cost.groups) !== claimKind) continue;
    if (!/\b(?:away|out|off|to\s+(?:(?:a|an|the)\s+)?third[ -]party|to\s+(?:(?:a|an|the)\s+)?(?:another|external|outside))\b/iu.test(quote.slice(intent.index))) continue;
    const claimWork = new Set(tokens(frame).filter(word => !claimKind.split(' ').includes(word)));
    const sourceWork = new Set(tokens(quote).filter(word => !claimKind.split(' ').includes(word)));
    if (![...claimWork].some(word => sourceWork.has(word))) continue;
    return true;
  }
  return false;
}
