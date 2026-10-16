// Keep semantic input bytes in the renderer. The host capability ledger accepts
// bounded identifiers, so bind the complete input with a cryptographic digest.
export async function jobAnalysisInputDigest(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
