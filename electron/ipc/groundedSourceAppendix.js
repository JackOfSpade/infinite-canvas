// A READ-ONLY parser for legacy grounded-research provenance.
//
// Historically a provider's server-side grounding tool returned source metadata
// separately from its prose, and this module re-attached that provenance as a
// small deterministic prefix so a later extraction pass never had to copy the
// raw, sometimes-encrypted search payload.
//
// That server-side grounding tool is gone — every AI call is a human copy/paste
// handoff now (nonApiAi.js) and `grounding: true` is only ever an instruction
// inside the copied prompt (llm.js callLLMRaw). Nothing produces this appendix
// any more, so the writer was deleted with the provider modules rather than
// kept as an uncalled inverse.
//
// The READER stays live and load-bearing: compensation research persisted
// BEFORE that migration still carries the prefix, and jobCompensation.js reads
// those cached strings (roleFamilyExperienceBandCache) to recover source URLs.
// Dropping it would silently lose provenance on already-stored research.
// Newly pasted research is plain prose with no appendix, which
// jobCompensation.js's whole-prose scan already handles.

export const GROUNDED_SOURCE_METADATA_MARKER = 'Grounded source URLs (provider metadata):';

function safeHttpUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    // A persisted source URL must never carry an embedded credential into text
    // we keep. Web search results have public URLs, so a credential-bearing URL
    // is not a valid source for this purpose.
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return '';
    return parsed.href;
  } catch {
    return '';
  }
}

/**
 * Read only URL-first source rows from the legacy appendix prefix.
 * This deliberately ignores arbitrary URLs in model prose and in page titles.
 */
export function groundedMetadataUrls(research) {
  const lines = String(research || '').split(/\r?\n/);
  if (lines[0] !== GROUNDED_SOURCE_METADATA_MARKER) return [];
  const seen = new Set();
  const urls = [];
  for (let i = 1; i < lines.length && lines[i] !== ''; i++) {
    const match = /^-\s+(https?:\/\/\S+)\s+—\s+.*$/.exec(lines[i]);
    const url = safeHttpUrl(match?.[1]);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}
