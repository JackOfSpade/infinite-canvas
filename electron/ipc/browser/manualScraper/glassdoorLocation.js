import { injectOverlay, updateOverlay } from './scrapeBrowser.js';
import { waitForReady } from './pageReadiness.js';
import { NAV_SETTLE_MS } from './walkRules.js';
import { logger } from '../../../logger.js';
import { humanDelay } from '../../../utils/humanDelay.js';
import { getGlassdoorLocId, saveGlassdoorLocId } from '../../settings.js';
import { CA_PROVINCES, normalizeLocationInput, pickGlassdoorLocation, US_STATES } from '../../../../src/utils/jobLocation.js';

export function glassdoorRequestedCountry(location) {
  const normalized = normalizeLocationInput(location);
  return normalized.countryCode
    ? { iso: normalized.countryCode, countryOnly: normalized.scope === 'country' }
    : null;
}

export function glassdoorCandidateLocId(candidate) {
  const rawId = candidate?.locationId ?? candidate?.realId
    ?? (typeof candidate?.id === 'string' ? candidate.id.replace(/^[A-Za-z]/, '') : candidate?.id);
  const locId = rawId != null ? String(rawId).trim() : '';
  return /^\d+$/.test(locId) && Number(locId) > 0 ? locId : null;
}

export function glassdoorCandidateText(candidate) {
  return [
    candidate?.longName, candidate?.label, candidate?.name,
    candidate?.countryName, candidate?.country?.name,
  ].filter(Boolean).join(' ').toLowerCase();
}

export function glassdoorCandidateCountryIso(candidate) {
  const raw = candidate?.country2LetterIso ?? candidate?.countryCode
    ?? candidate?.country?.country2LetterIso ?? candidate?.country?.code;
  if (typeof raw === 'string' && /^[a-z]{2}$/i.test(raw.trim())) return raw.trim().toUpperCase();
  // Glassdoor's verified autocomplete response uses countryId=3 for CA and 1
  // for US. Keep the label checks too: the legacy response exposes "(US)"
  // rather than country2LetterIso.
  if (Number(candidate?.countryId) === 3) return 'CA';
  if (Number(candidate?.countryId) === 1) return 'US';
  const text = glassdoorCandidateText(candidate);
  if (/\bcanada\b|\(\s*ca\s*\)/i.test(text)) return 'CA';
  if (/\bunited states(?: of america)?\b|\busa\b|\(\s*us\s*\)/i.test(text)) return 'US';
  return '';
}

export function glassdoorTextHasScopeTerm(text, term) {
  const normalized = String(term || '').trim().toLowerCase();
  if (!normalized) return true;
  const esc = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`\\b${esc(normalized)}\\b`, 'i').test(text)) return true;
  // Autocomplete labels often abbreviate province/state names ("Toronto, ON")
  // even when the request is written out ("Toronto, Ontario, Canada").
  const subdivisions = { ...US_STATES, ...CA_PROVINCES };
  const compact = normalized.replace(/[^a-z]/g, '');
  const code = Object.hasOwn(subdivisions, compact)
    ? compact
    : Object.entries(subdivisions).find(([, name]) => name.replace(/\s/g, '') === compact)?.[0];
  if (!code) return false;
  const fullName = subdivisions[code];
  return new RegExp(`(?:\\b${esc(fullName)}\\b|(?:^|[,(/])\\s*${esc(code)}(?=$|[, )]))`, 'i').test(text);
}

export function validateGlassdoorLocationPick(picked, results, location) {
  if (!picked?.locId || !/^\d+$/.test(String(picked.locId))) return 'returned no positive numeric location ID';
  const candidate = results.find(item => glassdoorCandidateLocId(item) === String(picked.locId));
  if (!candidate) return 'returned a location ID that was not present in the autocomplete response';

  const requestedCountry = glassdoorRequestedCountry(location);
  const candidateCountry = glassdoorCandidateCountryIso(candidate);
  if (requestedCountry) {
    if (!candidateCountry) return `could not verify the selected result belongs to ${requestedCountry.iso}`;
    if (candidateCountry !== requestedCountry.iso) return `selected ${candidateCountry}, but the requested country is ${requestedCountry.iso}`;
    // Country-only searches must select the actual country object (Glassdoor's
    // current autocomplete identifies it as N), never a similarly-named city.
    if (requestedCountry.countryOnly && String(candidate.locationType || picked.locT || '').toUpperCase() !== 'N') {
      return 'selected a non-country autocomplete result for a country-only search';
    }
  }

  const normalizedLocation = normalizeLocationInput(location);
  const scopedTerms = [normalizedLocation.city, normalizedLocation.subdivision].filter(Boolean);
  const candidateText = glassdoorCandidateText(candidate);
  for (const term of scopedTerms) {
    if (!glassdoorTextHasScopeTerm(candidateText, term)) return `selected result does not match requested scope term "${term}"`;
  }
  return null;
}

export function glassdoorUrlHasLocationId(url, locId) {
  const id = String(locId || '').trim();
  if (!/^\d+$/.test(id)) return false;
  try {
    const parsed = new URL(url);
    // Glassdoor encodes the applied location by TYPE: _IN nation, _IS state,
    // _IC city — all three verified live. Recognizing only _IN meant every city-
    // or state-scoped search resolved correctly, navigated correctly, and was
    // then discarded as "location not applied".
    //
    // The alphabet is now fully measured: N nation, S state/province, C city,
    // M metro. Canadian provinces use S — there is no separate non-US
    // subdivision letter. The metro tier is NOT additive (`_IM615` and
    // `_IC1132348` return the same top listings; M labels merely append the
    // country), so there is nothing to gain by targeting it — do not add a
    // metro lookup expecting extra reach.
    //
    // The class stays OPEN anyway, because the safety property is the numeric
    // id and not the type letter: we require the exact locId WE resolved to
    // appear in the landed path. A tier Glassdoor adds later would otherwise
    // read as "location not applied" and skip the whole source, the expensive
    // failure. An unknown letter beside the right id cannot admit a DIFFERENT
    // location.
    //
    // The .com -> .ca redirect is slug-safe: the path is preserved byte-for-byte
    // and only the host changes (plus a countryRedirect param), so this proof
    // survives it.
    return new RegExp(`_I[A-Z]{1,2}${id}(?:_|[.-]|$)`, 'i').test(decodeURIComponent(parsed.pathname));
  } catch {
    return false;
  }
}

/**
 * Is this a canonical Glassdoor results slug (the route that carries the
 * `_I{type}{id}` location marker at all)?
 *
 * Glassdoor only rewrites a query it can normalize into a slug. A query it
 * declines to slugify stays on `/Job/jobs.htm`, where no location marker is
 * ever present — so on that shape the marker's ABSENCE proves nothing.
 */
export function isGlassdoorCanonicalResultsUrl(url) {
  try {
    return /SRCH/i.test(decodeURIComponent(new URL(url).pathname));
  } catch {
    return false;
  }
}

/**
 * The URL to re-navigate to when Glassdoor's canonical redirect dropped the
 * posting-date filter, or null when nothing needs redoing.
 *
 * Measured live: a task URL of `/Job/jobs.htm?sc.keyword=...&fromAge=14` is
 * client-redirected to `/Job/united-states-...-jobs-SRCH_IL...htm?sc.keyword=...`
 * with `fromAge` GONE (12,084 results, most 30d+), while the SAME canonical URL
 * with `fromAge=14` appended answers with 2,680 results all <=13d. So the fix is
 * a single re-navigation onto the landed route carrying the requested value —
 * the host, path and every other landed param are preserved because the slug is
 * the route Glassdoor actually served.
 *
 * Returns null unless all three hold: the requested URL carries a fromAge, the
 * landed URL is a canonical SRCH route (on `/Job/jobs.htm` Glassdoor re-derives
 * the query, so appending is pointless), and the landed fromAge differs from
 * the requested one. Pure and non-throwing — malformed input is "no fix".
 */
export function glassdoorDateFilterReapplyUrl(landedUrl, requestedUrl) {
  try {
    const requestedFromAge = String(new URL(requestedUrl).searchParams.get('fromAge') ?? '').trim();
    if (!requestedFromAge) return null;
    if (!isGlassdoorCanonicalResultsUrl(landedUrl)) return null;
    const landed = new URL(landedUrl);
    const landedFromAge = String(landed.searchParams.get('fromAge') ?? '').trim();
    if (landedFromAge === requestedFromAge) return null;
    landed.searchParams.set('fromAge', requestedFromAge);
    return landed.toString();
  } catch {
    return null;
  }
}

/**
 * Three-way verdict on whether Glassdoor applied the location we resolved.
 *
 *   'applied'     — the canonical slug carries the matching _I{N|S|C}{id}.
 *   'missing'     — canonical slug, but a different location (or none). A real
 *                   failure: extracting would yield unscoped results.
 *   'unavailable' — non-canonical route (`/Job/jobs.htm`), where the marker
 *                   cannot appear. Says nothing either way.
 *
 * The third case used to be indistinguishable from the second, and its handler
 * skipped the WHOLE SOURCE — discarding every remaining Glassdoor query in the
 * run — because Glassdoor declined to slugify one query.
 *
 * @returns {'applied'|'missing'|'unavailable'}
 */
export function glassdoorLocationProof(url, locId) {
  if (glassdoorUrlHasLocationId(url, locId)) return 'applied';
  return isGlassdoorCanonicalResultsUrl(url) ? 'missing' : 'unavailable';
}

export function glassdoorAutocompleteRows(data) {
  if (Array.isArray(data)) return data;
  for (const key of ['data', 'results', 'locations', 'suggestions']) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return [];
}

// Glassdoor's autocomplete answering with a server-side failure says nothing
// about whether the requested location exists — it is a transport outcome, not
// a verdict, so it is worth retrying and must never be reported as a spelling
// problem. A well-formed response that simply has no acceptable match IS a
// verdict: retrying it just burns the run's time budget.
export const GLASSDOOR_LOOKUP_RETRY_STATUSES = [408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524];

export const GLASSDOOR_LOOKUP_MAX_ATTEMPTS = 2;   // per endpoint, per host

// per endpoint, per host
export const GLASSDOOR_LOOKUP_BACKOFF_MS = 800;

export const GLASSDOOR_LOOKUP_FETCH_TIMEOUT_MS = 8000;

// Whole-lookup ceiling. A gateway that times out on every attempt must not be
// able to stretch one source's location step past this before we give up.
export const GLASSDOOR_LOOKUP_BUDGET_MS = 40_000;

/**
 * True when a recorded lookup attempt failed at the transport layer (server
 * error, refused connection, unparseable body) rather than answering the
 * question. An attempt with no `status` never got a response at all.
 */
export function glassdoorLookupAttemptIsTransient(attempt) {
  if (!attempt) return false;
  if (attempt.rows != null) return false;   // a parsed answer, however empty, is a verdict
  // Reaching here means nothing parseable came back: an unreachable origin, an
  // aborted request, or a 200 carrying something other than the JSON payload
  // (an anti-bot interstitial reads exactly like this).
  if (attempt.error) return true;
  if (!Number.isFinite(Number(attempt.status))) return true;
  return GLASSDOOR_LOOKUP_RETRY_STATUSES.includes(Number(attempt.status));
}

/**
 * Render the attempt trail as observations — "which endpoint returned what" —
 * with no claim about the cause. Repeated identical outcomes collapse to `×N`
 * so a retried lookup stays readable on a source card.
 */
export function summarizeGlassdoorLookupAttempts(attempts) {
  const list = Array.isArray(attempts) ? attempts : [];
  if (list.length === 0) return 'no lookup attempt was recorded';
  const order = [];
  const counts = new Map();
  for (const attempt of list) {
    const endpoint = String(attempt?.path || '(unknown endpoint)').split('?')[0];
    const outcome = attempt?.error
      ? String(attempt.error)
      : attempt?.rows != null
        ? `HTTP ${attempt.status} with ${attempt.rows} location(s)`
        : `HTTP ${attempt?.status ?? '?'}`;
    const label = `${attempt?.host ? `${attempt.host}` : ''}${endpoint}→${outcome}`;
    if (!counts.has(label)) order.push(label);
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return order.map(label => (counts.get(label) > 1 ? `${label} ×${counts.get(label)}` : label)).join(', ');
}

/**
 * Whether a persisted cache entry is enough proof to skip the live lookup.
 * A locId is a stable platform id, but on its own it is an opaque number: for a
 * country-scoped search it only counts once the entry records the country it
 * was validated against. Entries written before that field existed have no
 * `country` and are deliberately re-resolved unless the resolver can upgrade
 * one of the two exact, known country-root IDs below.
 */
export function glassdoorCachedLocationUsable(cached, location) {
  const locId = String(cached?.locId ?? '').trim();
  if (!/^\d+$/.test(locId) || Number(locId) <= 0) return false;
  const requestedCountry = glassdoorRequestedCountry(location);
  if (!requestedCountry) return true;
  if (cached.country !== requestedCountry.iso) return false;
  // Mirrors validateGlassdoorLocationPick: a country-only search must hold the
  // country object itself, never a similarly-named city inside that country.
  if (requestedCountry.countryOnly && String(cached.locT || '').toUpperCase() !== 'N') return false;
  return true;
}

/**
 * Add provenance to the two stable Glassdoor country-root IDs that the app
 * already knows how to validate from live autocomplete responses. This is
 * intentionally limited to country-only requests and N (nation) entries: a
 * legacy city/province ID remains opaque and must still be resolved live.
 */
export function upgradeGlassdoorCountryRootCache(cached, location) {
  if (!cached || cached.country) return cached;
  const requested = glassdoorRequestedCountry(location);
  if (!requested?.countryOnly || String(cached.locT || '').toUpperCase() !== 'N') return cached;
  const knownRoot = requested.iso === 'CA' ? '3' : requested.iso === 'US' ? '1' : null;
  if (!knownRoot || String(cached.locId || '').trim() !== knownRoot) return cached;
  return { ...cached, country: requested.iso };
}

/**
 * Classify the aggregate outcome separately from retry policy. HTTP 403 is
 * deliberately not retried, but it is still an access denial—not evidence that
 * a human-entered location failed to match.
 */
export function classifyGlassdoorLookupFailure(attempts) {
  const list = Array.isArray(attempts) ? attempts : [];
  if (list.some(attempt => attempt?.rows != null)) return 'no-match';
  if (list.some(attempt => [401, 403].includes(Number(attempt?.status)))) return 'access-denied';
  if (list.length > 0 && list.every(attempt => glassdoorLookupAttemptIsTransient(attempt))) return 'transient';
  return 'no-match';
}

/**
 * Word the skip for what was actually observed. A transport failure and an
 * unrecognized location produce the same outcome (Glassdoor is skipped rather
 * than searched nationwide) but call for opposite user actions, and telling
 * someone to check their spelling because a gateway returned 504 sends them
 * hunting a bug that is not theirs.
 */
export function describeGlassdoorLocationFailure({ location, failure, failureKind }) {
  const evidence = `Glassdoor location "${location}" could not be verified: ${failure}. `
    + 'The source was skipped before navigating its locKeyword-only nationwide URL.';
  const suggestion = failureKind === 'transient'
    ? 'Those are Glassdoor-side transport results, not a rejection of the location text — retrying Glassdoor is the fix. '
      + 'Once any location verifies once it is cached with its country, so later runs skip this lookup entirely.'
    : failureKind === 'access-denied'
      ? 'Glassdoor denied the browser lookup before it could answer. This is an anti-bot/session result, not a rejection of the location text. '
        + 'Open Glassdoor in Chrome and clear any human verification, then retry the search.'
    : failureKind === 'rejected'
      ? 'Glassdoor answered, but no result matched the requested location closely enough to be safe to search. '
        + 'Check the preferred location spelling, or use a more specific form (e.g. "Toronto, Ontario, Canada").'
      : failureKind === 'cancelled'
        ? 'The search was stopped before this lookup finished — nothing to correct. Glassdoor will resolve the location on the next run.'
        : 'Check the preferred location spelling and retry Glassdoor. '
          + 'If its location autocomplete is unavailable, use the other country-scoped sources for this run.';
  return { evidence, suggestion };
}

/**
 * Park the page on `host` so the autocomplete fetch below is same-origin.
 * The landing host is CONFIRMED rather than assumed: Glassdoor country-redirects
 * (a .com request on a CA account lands on .ca — see the login verify trace), and
 * a relative fetch issued from the wrong origin would silently answer for the
 * wrong market. Settling is polled because one fixed wait races a slow redirect
 * chain, which would report a reachable origin as unreachable.
 */
export async function ensureGlassdoorOrigin(page, host) {
  const currentHost = () => {
    try { return new URL(page.url()).hostname.toLowerCase(); } catch { return ''; }
  };
  if (currentHost() === host) return true;
  const originUrl = `https://${host}/Job/index.htm`;
  await page.evaluate(u => { window.location.href = u; }, originUrl).catch(() => {});
  let previous = '';
  for (let settle = 0; settle < 3; settle++) {
    await new Promise(r => setTimeout(r, humanDelay(NAV_SETTLE_MS)));
    const landed = currentHost();
    if (landed === host) return true;
    // Glassdoor country-redirects (a .com request on a CA account lands on .ca).
    // Once the URL has stopped moving somewhere else, more waiting cannot
    // change the answer — stop burning settle time on it.
    if (landed && landed === previous) return false;
    previous = landed;
  }
  return false;
}

/**
 * Resolve a Glassdoor location string to its numeric `locId`. Glassdoor's search
 * location FILTER is keyed by locId (the `locKeyword` text alone is silently
 * ignored — verified empirically), and the location-autocomplete endpoint is
 * Cloudflare-gated, so the lookup MUST run from the glassdoor.com origin inside
 * this already-CF-cleared browser (a plain server-side fetch 403s). The result is
 * cached persistently (a locId is a stable platform id), so this costs an extra
 * navigation only on the first-ever use of a given location. A requested
 * location is a safety boundary: failure to resolve or verify it returns a
 * failure object and the caller SKIPS Glassdoor rather than navigating a
 * locKeyword-only (nationwide) URL.
 */
export async function resolveGlassdoorLocId(page, location, signal, runCache = null, overlayBase = null) {
  const key = String(location || '').trim().toLowerCase();
  if (!key) return { failure: 'no location was supplied', failureKind: 'no-location' };
  if (runCache?.has(key)) return runCache.get(key);
  let cached = getGlassdoorLocId(key);
  const upgradedCache = upgradeGlassdoorCountryRootCache(cached, location);
  if (upgradedCache !== cached) {
    cached = upgradedCache;
    saveGlassdoorLocId(key, cached);
    logger.info(`[BrowserScraper] Glassdoor upgraded known country-root locId ${cached.locId}/${cached.locT} for "${location}" with ${cached.country} provenance`);
  }
  if (glassdoorCachedLocationUsable(cached, location)) {
    runCache?.set(key, cached);
    return cached;
  }
  if (cached) {
    logger.info(`[BrowserScraper] Glassdoor cached locId ${cached.locId}/${cached.locT} for "${location}" lacks matching country provenance — re-resolving`);
  }
  if (signal?.aborted) return { failure: 'search was cancelled before location resolution', failureKind: 'cancelled' };
  // Same-origin fetch must use the country site whose autocomplete/search path
  // was verified. Canada uses .ca; United States and unclassified city targets
  // use .com. Crossing hosts here can change the default market despite locId —
  // which is why .com is only ever a LOOKUP fallback, tried after the country
  // host fails at the transport layer, and still subject to the same country
  // validation below. The search navigation itself never changes host.
  const desiredHost = normalizeLocationInput(location).countryCode === 'CA'
    ? 'www.glassdoor.ca'
    : 'www.glassdoor.com';
  const hosts = desiredHost === 'www.glassdoor.com' ? [desiredHost] : [desiredHost, 'www.glassdoor.com'];
  const normalizedRequest = normalizeLocationInput(location);
  const subdivisionName = normalizedRequest.subdivisionCode
    ? (US_STATES[normalizedRequest.subdivisionCode.toLowerCase()] || CA_PROVINCES[normalizedRequest.subdivisionCode.toLowerCase()] || normalizedRequest.subdivision)
    : normalizedRequest.subdivision;
  // Prefer the most specific human-readable label. A US board-ready state scope
  // is "CO", but Glassdoor's autocomplete is more reliable with "colorado".
  const term = normalizedRequest.city || subdivisionName || normalizedRequest.country || (location.split(',')[0] || location).trim();

  const deadline = Date.now() + GLASSDOOR_LOOKUP_BUDGET_MS;
  const attempts = [];
  let rows = [];
  for (const host of hosts) {
    if (signal?.aborted) return { failure: 'search was cancelled during location resolution', failureKind: 'cancelled', attempts };
    if (Date.now() >= deadline) {
      attempts.push({ host, path: '(budget)', error: `gave up after ${Math.round(GLASSDOOR_LOOKUP_BUDGET_MS / 1000)}s` });
      break;
    }
    if (!await ensureGlassdoorOrigin(page, host)) {
      attempts.push({ host, path: '(origin)', error: 'could not reach the Glassdoor origin to run the lookup' });
      continue;
    }
    // Location resolution happens before the normal results navigation, so it
    // must run the challenge gate itself. Previously a visible Cloudflare page
    // was left for the human to watch while both autocomplete calls returned
    // 403 and the source was incorrectly dismissed as a location no-match.
    if (overlayBase) {
      await injectOverlay(page).catch(() => {});
      await updateOverlay(page, {
        ...overlayBase,
        status: 'Checking Glassdoor location…',
      }).catch(() => {});
      const originReady = await waitForReady(
        page,
        'glassdoor',
        overlayBase,
        signal,
        `https://${host}/Job/index.htm`,
        { challengeOnly: true },
      );
      if (originReady === 'abort' || signal?.aborted) {
        return { failure: 'search was cancelled during location verification', failureKind: 'cancelled', attempts };
      }
      if (originReady === 'hard-block' || originReady === 'skip') {
        return {
          failure: originReady === 'hard-block'
            ? 'the Glassdoor origin showed a non-interactive human-verification block'
            : 'the Glassdoor origin re-served its human-verification challenge after recovery',
          failureKind: 'access-denied',
          attempts,
        };
      }
    }
    const res = await page.evaluate(async (t, cfg) => {
      // Runs inside the page: no imports are available here, so the row shapes
      // and the retry loop are inlined. Keep rowsOf in sync with
      // glassdoorAutocompleteRows.
      const rowsOf = (data) => {
        if (Array.isArray(data)) return data;
        for (const k of ['data', 'results', 'locations', 'suggestions']) {
          if (Array.isArray(data?.[k])) return data[k];
        }
        return [];
      };
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      // The first path is Glassdoor's current visible autocomplete; the second
      // is its older endpoint, kept as a compatibility fallback. BOTH answers
      // go through the same validation on the Node side.
      const paths = [
        `/autocomplete/location?locationTypeFilters=CITY,STATE,COUNTRY&caller=jobs&term=${encodeURIComponent(t)}`,
        `/findPopularLocationAjax.htm?term=${encodeURIComponent(t)}&maxLocationsToReturn=10`,
      ];
      const log = [];
      for (const path of paths) {
        for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
          if (Date.now() >= cfg.deadline) {
            log.push({ path, error: 'lookup budget exhausted' });
            return { attempts: log };
          }
          const record = { path };
          let parsed = null;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), cfg.fetchTimeoutMs);
          try {
            const r = await fetch(path, {
              headers: { 'Accept': 'application/json, text/plain, */*' },
              credentials: 'include',
              signal: controller.signal,
            });
            record.status = r.status;
            if (r.ok) {
              const text = await r.text();
              try { parsed = JSON.parse(text); record.rows = rowsOf(parsed).length; }
              catch { record.error = 'non-json response'; }
            }
          } catch (e) {
            record.error = controller.signal.aborted
              ? `no response within ${Math.round(cfg.fetchTimeoutMs / 1000)}s`
              : String((e && e.message) || e);
          } finally { clearTimeout(timer); }
          log.push(record);
          if (record.rows > 0) return { data: parsed, endpoint: path, attempts: log };
          // A parsed-but-empty answer is a verdict for this endpoint: move to
          // the next one rather than asking the same question again.
          if (record.rows != null) break;
          const retryable = !Number.isFinite(Number(record.status))
            || cfg.retryStatuses.includes(Number(record.status));
          if (!retryable || attempt === cfg.maxAttempts) break;
          await sleep(cfg.backoffMs * attempt);
        }
      }
      return { attempts: log };
    }, term, {
      maxAttempts: GLASSDOOR_LOOKUP_MAX_ATTEMPTS,
      backoffMs: GLASSDOOR_LOOKUP_BACKOFF_MS,
      fetchTimeoutMs: GLASSDOOR_LOOKUP_FETCH_TIMEOUT_MS,
      retryStatuses: GLASSDOOR_LOOKUP_RETRY_STATUSES,
      deadline,
    }).catch(e => ({ attempts: [{ path: '(evaluate)', error: String(e?.message || e) }] }));

    for (const attempt of res?.attempts || []) attempts.push({ host, ...attempt });
    rows = glassdoorAutocompleteRows(res?.data);
    if (rows.length > 0) break;
    // Only cross to the fallback host when this one never actually answered.
    // A real, empty answer would be just as empty over there.
    if (!(res?.attempts || []).every(attempt => glassdoorLookupAttemptIsTransient(attempt))) break;
  }

  if (rows.length === 0) {
    const trail = summarizeGlassdoorLookupAttempts(attempts);
    logger.warn(`[BrowserScraper] Glassdoor locId lookup failed for "${location}" — ${trail}`);
    return {
      failure: `autocomplete lookup failed (${trail})`,
      failureKind: classifyGlassdoorLookupFailure(attempts),
      attempts,
    };
  }
  const picked = pickGlassdoorLocation(rows, location);
  const validationFailure = validateGlassdoorLocationPick(picked, rows, location);
  if (!validationFailure) {
    // Record the country the pick was validated against so a later run can
    // trust the cached entry instead of re-running this outage-prone lookup.
    const candidate = rows.find(item => glassdoorCandidateLocId(item) === String(picked.locId));
    const country = glassdoorCandidateCountryIso(candidate);
    const verified = country ? { ...picked, country } : { ...picked };
    saveGlassdoorLocId(key, verified);
    runCache?.set(key, verified);
    return verified;
  }
  logger.warn(`[BrowserScraper] Glassdoor locId lookup rejected for "${location}": ${validationFailure}`);
  return {
    failure: validationFailure,
    failureKind: 'rejected',
    attempts,
  };
}
