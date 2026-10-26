// Request-local page evidence. It is deliberately never attached to a job row,
// receipt, persisted state, or diagnostic report.
import { sourceJobKey } from '../../src/utils/jobIdentity.js';
import { getCurrentIpcRequestContext } from './ipcUtils.js';
import { officialHttpsUrl } from './officialPostingFields.js';

const MAX_ENTRIES = 5_000;
const flagsByMap = new WeakMap();
const expiryByMap = new WeakMap();
const MAX_EXPIRY_CANDIDATES = 8;

function evidenceMap() {
  const map = getCurrentIpcRequestContext()?.livenessEvidence;
  return map instanceof Map ? map : null;
}

export function listingEvidenceKey(row) {
  const source = typeof row?.source === 'string' ? row.source : '';
  const identity = sourceJobKey(row);
  return source && identity ? `${source}|${identity}` : '';
}

export function recordListingEvidence(row, evidence) {
  const map = evidenceMap(); const key = listingEvidenceKey(row);
  if (!map || !key || !evidence || typeof evidence !== 'object') return false;
  map.delete(key);
  map.set(key, { evidence, memo: null });
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value);
  return true;
}

export function readListingEvidence(row) {
  const map = evidenceMap(); const key = listingEvidenceKey(row);
  return key ? map?.get(key)?.evidence || null : null;
}

export function memoListingVerdict(row, verdict) {
  const map = evidenceMap(); const key = listingEvidenceKey(row);
  if (!map || !key || !map.has(key)) return false;
  const prior = map.get(key);
  map.set(key, { ...prior, memo: verdict });
  return true;
}

export function readListingVerdictMemo(row) {
  const map = evidenceMap(); const key = listingEvidenceKey(row);
  return key ? map?.get(key)?.memo ?? null : null;
}

// Official candidate page text shares the request lifetime of ordinary board
// evidence. Only bounded URLs may leave the resolver; neither this evidence nor
// candidate AI answers belongs on a persisted job or resolution receipt.
function expiryMap() {
  const map = evidenceMap();
  if (!map) return null;
  if (!expiryByMap.has(map)) expiryByMap.set(map, new Map());
  return expiryByMap.get(map);
}

export function recordOfficialExpiryCandidates(row, candidates, { truncated = false } = {}) {
  const map = expiryMap(); const key = listingEvidenceKey(row);
  if (!map || !key || !Array.isArray(candidates)) return false;
  const seen = new Set(); const entries = [];
  for (const candidate of candidates) {
    const url = officialHttpsUrl(candidate?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    if (entries.length < MAX_EXPIRY_CANDIDATES) entries.push({ url,
      evidence: candidate?.evidence && typeof candidate.evidence === 'object'
        ? candidate.evidence : null, verdict: null });
  }
  if (!entries.length) return false;
  map.set(key, { candidates: entries, truncated: truncated === true || seen.size > MAX_EXPIRY_CANDIDATES });
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value);
  return true;
}

export function readOfficialExpiryCandidates(row) {
  const key = listingEvidenceKey(row);
  return key ? (expiryMap()?.get(key)?.candidates || []).map(candidate => ({ ...candidate })) : [];
}

export function setOfficialExpiryCandidateVerdict(row, url, verdict) {
  const key = listingEvidenceKey(row); const href = officialHttpsUrl(url);
  const bucket = key && href ? expiryMap()?.get(key) : null;
  const candidate = bucket?.candidates.find(item => item.url === href);
  if (!candidate || !['open', 'closed', 'unclear'].includes(verdict)) return false;
  candidate.verdict = verdict;
  return true;
}

export function officialExpiryCandidatesConfirmedClosed(row) {
  const key = listingEvidenceKey(row);
  const bucket = key ? expiryMap()?.get(key) : null;
  return Boolean(bucket && !bucket.truncated && bucket.candidates.length
    && bucket.candidates.every(candidate => candidate.verdict === 'closed'));
}

function runFlags() {
  const map = evidenceMap();
  if (!map) return null;
  if (!flagsByMap.has(map)) flagsByMap.set(map, { breakerTripped: false });
  return flagsByMap.get(map);
}

export function tripListingLivenessBreaker() {
  const flags = runFlags();
  if (flags) flags.breakerTripped = true;
}

export function isListingLivenessBreakerTripped() {
  return runFlags()?.breakerTripped === true;
}
