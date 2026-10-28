// Pure shared wire schema: main-process records and renderer whitelists use
// the same field list. Scraped identity fields remain separate from these.
export const OFFICIAL_POSTING_ROW_FIELDS = Object.freeze(['postedBy', 'applyOptions', 'salaryProvenance', 'officialPosting', 'boardClosed', 'listingLiveness', 'alternateListings']);
export const LOCAL_AI_APPLICATION_SNIPPET_MAX_CHARS = 80_000;
export const OFFICIAL_POSTING_LEVELS = Object.freeze(['L1', 'L2', 'L3', 'L4', 'L5', 'L6']);
export const OFFICIAL_POSTING_OUTCOMES = Object.freeze(['found', 'link-only', 'not-found', 'ambiguous', 'unreadable', 'closed', 'failed']);
export const SALARY_PROVENANCES = Object.freeze(['posted', 'estimated', 'unknown']);
export const OFFICIAL_POSTING_COMPARATIVE_CODES = Object.freeze([
  'comparative-match', 'comparative-disagree', 'comparative-invalid', 'comparative-none', 'comparative-unavailable',
]);
export const OFFICIAL_POSTING_TRAIL = Object.freeze([
  'free-lead', 'careers-page', 'ats-adapter', 'json-ld', 'structured-proof', 'domain-proof',
  'salary-anchor', 'identifier-anchor', 'description-anchor', 'quoted-match', 'cache-hit', 'recent-miss',
  'bridge-research', 'bridge-timeout', 'bridge-unavailable', 'bridge-aborted', 'research-miss',
  'title-mismatch', 'location-mismatch', 'employer-mismatch', 'tenant-unproven', 'poster-tenant',
  'salary-mismatch', 'no-anchor', 'invalid-quotes', 'ambiguous', 'closed', 'unreadable', 'oversize',
  'unsafe-url', 'unsafe-address', 'fetch-timeout', 'fetch-failed', 'unsupported-content-type',
  'crawl-budget', 'crawl-partial', 'invalid-text', 'stub-text', 'official-text-missing', 'no-resolution', 'reverified', 'reverify-failed', 'official-liveness-unconfirmed', 'material-jd-change', 'failed',
  'semantic-match-v1', 'semantic-uncertain', 'semantic-overflow',
  ...OFFICIAL_POSTING_COMPARATIVE_CODES,
  'comparative-a-valid', 'comparative-a-invalid', 'comparative-b-valid', 'comparative-b-invalid', 'comparative-truncated', 'insufficient-text',
  ...['a', 'b', 'choice'].flatMap(run => ['none', 'uncertain', ...Array.from({ length: 8 }, (_, index) => `p${index + 1}`)]
    .map(choice => `comparative-${run}-${choice}`)),
]);

/** Bounded decisions only: no quotes, reasons, prompts or conversation ids. */
export function officialPostingComparativeTrail({ validA = false, validB = false, choiceA, choiceB } = {}) {
  const choiceCode = value => ['none', 'uncertain'].includes(value) || /^P[1-8]$/u.test(String(value || '')) ? String(value).toLowerCase() : '';
  const a = choiceCode(choiceA); const b = choiceCode(choiceB);
  return [`comparative-a-${validA === true ? 'valid' : 'invalid'}`, `comparative-b-${validB === true ? 'valid' : 'invalid'}`,
    ...(a ? [`comparative-a-${a}`] : []), ...(b ? [`comparative-b-${b}`] : []),
    ...(validA === true && validB === true && a && a === b ? [`comparative-choice-${a}`] : [])];
}

const DURABILITY_TRAIL_CODES = new Set(['bridge-aborted', 'bridge-timeout', 'bridge-unavailable', 'research-miss',
  'fetch-failed', 'fetch-timeout', 'crawl-budget', 'crawl-partial', 'official-text-missing', 'failed', 'identifier-anchor',
  'comparative-invalid', 'comparative-unavailable', 'comparative-truncated', 'insufficient-text', 'semantic-uncertain', 'semantic-overflow', 'official-liveness-unconfirmed']);
/** Host trail compaction must retain the evidence that prevents persistence. */
export function boundedOfficialPostingTrail(values) {
  const codes = [...new Set((Array.isArray(values) ? values : []).filter(code => OFFICIAL_POSTING_TRAIL.includes(code)))];
  if (codes.length <= 32) return codes;
  const durability = codes.filter(code => DURABILITY_TRAIL_CODES.has(code) || code === 'semantic-match-v1');
  const comparison = codes.filter(code => code.startsWith('comparative-') && !DURABILITY_TRAIL_CODES.has(code));
  const required = [...durability, ...comparison].slice(0, 32);
  const room = 32 - required.length;
  const others = codes.filter(code => !DURABILITY_TRAIL_CODES.has(code) && code !== 'semantic-match-v1' && !code.startsWith('comparative-'));
  return [...required, ...(room ? others.slice(-room) : [])];
}
export const OFFICIAL_POSTING_LABELS = Object.freeze({
  L1: 'Official careers site', L2: 'ATS linked from careers page', L3: "Employer's ATS",
  L4: 'Official link, listing text', L5: 'Original listing', L6: 'Original listing (employer unknown)',
});

export function officialHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2_000 || [...value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^utm_/iu.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch { return ''; }
}

export function normalizeApplyOptions(value) {
  const options = []; const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const href = officialHttpsUrl(item?.href);
    if (!href || seen.has(href)) continue;
    const label = typeof item?.label === 'string' ? [...item.label].map(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char).join('').replace(/\s+/gu, ' ').trim().slice(0, 120) : '';
    seen.add(href); options.push({ label, href });
    if (options.length === 8) break;
  }
  return options;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
}
function shortString(value, max = 500) {
  return typeof value === 'string' && value.length <= max && !/[<>]/u.test(value)
    && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}
/** Bounded source text only; semantic employer identity belongs to AI. */
export function officialPostingEmployerText(value) {
  return shortString(value, 120) ? value.trim() : '';
}
export function normalizeOfficialSalary(value) {
  if (!exactKeys(value, ['text', 'provenance']) || !shortString(value.text, 500) || !SALARY_PROVENANCES.includes(value.provenance)) return null;
  return { text: value.text, provenance: value.provenance };
}
export function normalizeOfficialLocation(value) {
  if (!exactKeys(value, ['display', 'workMode', 'remote', 'remoteCountry', 'remoteRegion'])) return null;
  if (!shortString(value.display, 500) || !['', 'remote', 'hybrid', 'onsite', 'on-site'].includes(value.workMode ?? '')
    || (value.remote !== undefined && typeof value.remote !== 'boolean')
    || !shortString(value.remoteCountry ?? '', 120) || !shortString(value.remoteRegion ?? '', 160)) return null;
  const suppliedMode = value.workMode || '';
  if ((value.remote === true && suppliedMode && suppliedMode !== 'remote') || (value.remote === false && suppliedMode === 'remote')) return null;
  const remote = value.remote === true || suppliedMode === 'remote';
  const remoteCountry = value.remoteCountry || ''; const remoteRegion = value.remoteRegion || '';
  const statedRestriction = restriction => restriction.trim() && !/^(?:none|n\/a|not stated|unspecified|unknown)$/iu.test(restriction.trim());
  if (remote ? !statedRestriction(remoteCountry) && !statedRestriction(remoteRegion) : remoteCountry || remoteRegion) return null;
  return { display: value.display, workMode: remote ? 'remote' : suppliedMode, remote, remoteCountry, remoteRegion };
}

export function normalizeOfficialPosting(value) {
  const keys = ['level', 'outcome', 'employer', 'title', 'location', 'salary', 'sourceUrl', 'officialApplyUrl',
    'ats', 'tenant', 'fetchedAt', 'contentHash', 'scrapedListingSha256', 'trail', 'alternatives', 'semanticMatch'];
  if (!exactKeys(value, keys) || !OFFICIAL_POSTING_LEVELS.includes(value.level) || !OFFICIAL_POSTING_OUTCOMES.includes(value.outcome)
    || !shortString(value.employer, 120)) return null;
  const result = { level: value.level, outcome: value.outcome, employer: value.employer };
  for (const [key, max] of [['title', 500], ['ats', 80], ['tenant', 240]]) {
    if (value[key] === undefined) continue;
    if (!shortString(value[key], max)) return null;
    result[key] = value[key];
  }
  for (const key of ['sourceUrl', 'officialApplyUrl']) {
    if (value[key] === undefined || value[key] === '') continue;
    const url = officialHttpsUrl(value[key]); if (!url) return null; result[key] = url;
  }
  for (const [key, normalize] of [['location', normalizeOfficialLocation], ['salary', normalizeOfficialSalary]]) {
    if (value[key] === undefined) continue;
    result[key] = normalize(value[key]); if (!result[key]) return null;
  }
  for (const key of ['contentHash', 'scrapedListingSha256']) {
    if (value[key] === undefined || value[key] === '') continue;
    if (!/^[a-f0-9]{64}$/u.test(value[key])) return null; result[key] = value[key];
  }
  if (value.semanticMatch !== undefined) {
    if (!exactKeys(value.semanticMatch, ['version', 'inputHash', 'sourceHash']) || value.semanticMatch.version !== 1
      || !/^[a-f0-9]{64}$/u.test(value.semanticMatch.inputHash)) return null;
    if (value.semanticMatch.sourceHash !== undefined && !/^[a-f0-9]{64}$/u.test(value.semanticMatch.sourceHash)) return null;
    result.semanticMatch = { version: 1, inputHash: value.semanticMatch.inputHash,
      ...(value.semanticMatch.sourceHash ? { sourceHash: value.semanticMatch.sourceHash } : {}) };
  }
  if (value.fetchedAt !== undefined) {
    if (!shortString(value.fetchedAt, 40) || !Number.isFinite(Date.parse(value.fetchedAt))) return null;
    result.fetchedAt = value.fetchedAt;
  }
  if (value.trail !== undefined) {
    if (!Array.isArray(value.trail) || value.trail.length > 32 || value.trail.some(item => !OFFICIAL_POSTING_TRAIL.includes(item))) return null;
    result.trail = [...new Set(value.trail)];
  }
  if (value.alternatives !== undefined) {
    if (!Array.isArray(value.alternatives) || value.alternatives.length > 12) return null;
    result.alternatives = [];
    for (const item of value.alternatives) {
      if (!exactKeys(item, ['url', 'title']) || !shortString(item.title, 500)) return null;
      const url = officialHttpsUrl(item.url); if (!url) return null;
      result.alternatives.push({ url, title: item.title });
    }
  }
  return result;
}

// A job board's detail page said the listing is gone. That is evidence about the
// board, never the final word: the employer's own posting may still be live, so
// the row travels to the official-posting resolver carrying this bounded marker.
export const BOARD_CLOSED_REASONS = Object.freeze([
  'detail-page-not-found', 'ziprecruiter-closed-job-redirect',
  'indeed-page-unavailable', 'indeed-job-unavailable', 'linkedin-no-longer-accepting',
  'http-not-found', 'ai-confirmed-closed', 'workday-posting-unavailable',
]);
const BOARD_LABELS = Object.freeze({
  linkedin: 'LinkedIn', indeed: 'Indeed', ziprecruiter: 'ZipRecruiter', glassdoor: 'Glassdoor', dice: 'Dice',
  google: 'Google', remoteok: 'RemoteOK', weworkremotely: 'WWRemotely',
});
const BOARD_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/u;
/** Bounded board links only; scraped identity and page evidence are separate. */
export function normalizeAlternateListings(value) {
  const links = []; const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    if (!exactKeys(item, ['board', 'url']) || !['board', 'url'].every(key => Object.hasOwn(item, key))
      || typeof item.board !== 'string' || !BOARD_ID_RE.test(item.board)) continue;
    const url = officialHttpsUrl(item.url);
    if (!url || seen.has(url)) continue;
    seen.add(url); links.push({ board: item.board, url });
    if (links.length === 3) break;
  }
  return links;
}
export function boardClosedBoardLabel(board) {
  if (typeof board !== 'string' || !BOARD_ID_RE.test(board)) return '';
  return BOARD_LABELS[board] || board.charAt(0).toUpperCase() + board.slice(1);
}
/** Exact keys, a source id, an enumerated reason and a real instant. Anything else is not a board-closed row. */
export function normalizeBoardClosed(value) {
  if (!exactKeys(value, ['board', 'reason', 'at']) || !['board', 'reason', 'at'].every(key => Object.hasOwn(value, key))) return null;
  if (typeof value.board !== 'string' || !BOARD_ID_RE.test(value.board) || !BOARD_CLOSED_REASONS.includes(value.reason)) return null;
  if (!shortString(value.at, 40)) return null;
  const instant = Date.parse(value.at);
  if (!Number.isFinite(instant)) return null;
  return { board: value.board, reason: value.reason, at: new Date(instant).toISOString() };
}

export const LISTING_LIVENESS_VERDICTS = Object.freeze(['open', 'closed', 'pending', 'unclear']);
export const LISTING_LIVENESS_BASES = Object.freeze(['open-marker', 'structural', 'ai', 'closed-marker', 'neither', 'both']);
/** A bounded observation, never a copy of page text or a URL. */
export function normalizeListingLiveness(value) {
  if (!exactKeys(value, ['verdict', 'basis', 'board', 'at'])
    || !['verdict', 'basis', 'board', 'at'].every(key => Object.hasOwn(value, key))) return null;
  if (!LISTING_LIVENESS_VERDICTS.includes(value.verdict) || !LISTING_LIVENESS_BASES.includes(value.basis)
    || typeof value.board !== 'string' || !BOARD_ID_RE.test(value.board) || !shortString(value.at, 40)) return null;
  const instant = Date.parse(value.at);
  if (!Number.isFinite(instant)) return null;
  return { verdict: value.verdict, basis: value.basis, board: value.board, at: new Date(instant).toISOString() };
}

/** Stable source-copy preference; legacy boardClosed alone is still unconfirmed. */
export function listingStateRank(job) {
  const state = normalizeListingLiveness(job?.listingLiveness);
  if (state?.verdict === 'closed') return 4;
  if (state?.verdict === 'open' && !normalizeBoardClosed(job?.boardClosed)) return 1;
  if (state?.verdict === 'pending' && ['closed-marker', 'both'].includes(state.basis)) return 3;
  if (!state && normalizeBoardClosed(job?.boardClosed)) return 3;
  return 2;
}

// Trail codes meaning the research step did not run, did not finish, or hit a
// transient failure. A miss carrying any of them is retryable, never a conclusion.
const RESEARCH_UNSETTLED_TRAIL = Object.freeze(['bridge-aborted', 'bridge-timeout', 'bridge-unavailable', 'research-miss',
  'fetch-failed', 'fetch-timeout', 'crawl-budget', 'crawl-partial', 'official-text-missing', 'failed',
  'comparative-invalid', 'comparative-unavailable', 'comparative-truncated', 'insufficient-text', 'semantic-uncertain', 'semantic-overflow', 'official-liveness-unconfirmed']);
/** True only for a definitive miss reached after research actually ran (or an official page that is itself closed). */
export function officialResearchSettled(value) {
  const posting = value && typeof value === 'object' ? value : null;
  if (!posting || !['L5', 'L6'].includes(posting.level) || !['not-found', 'ambiguous', 'closed'].includes(posting.outcome)) return false;
  const trail = Array.isArray(posting.trail) ? posting.trail : [];
  if (trail.some(code => RESEARCH_UNSETTLED_TRAIL.includes(code))) return false;
  return posting.outcome === 'closed' || trail.includes('bridge-research')
    || trail.includes('comparative-none') || trail.includes('comparative-disagree');
}
