// Exact, request-scoped bridge ownership for ordinary non-API (push) handoffs.
// The claim id is a random token minted with the request, not a task/node
// label, so a bridge claim can never hide a sibling's copy/paste controls.
export function isBridgeHeldPush(status, bridgeClaimId) {
  if (typeof bridgeClaimId !== 'string' || !bridgeClaimId) return false;
  const claimed = status?.push?.claimed;
  return Array.isArray(claimed) && claimed.includes(bridgeClaimId);
}

// The bridge status exposes only opaque per-request claim ids.  This means an
// unclaimed dock row can say it is eligible for the selected ChatGPT route
// without guessing from its task name or hub, and without exposing its prompt.
export function isBridgeAvailablePush(status, bridgeClaimId) {
  if (typeof bridgeClaimId !== 'string' || !bridgeClaimId) return false;
  const available = status?.push?.available;
  return Array.isArray(available) && available.includes(bridgeClaimId);
}
