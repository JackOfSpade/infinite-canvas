// Pure location helpers for the job-search pipeline. Kept dependency-free (no
// electron / puppeteer) so they're unit-testable in isolation and shared by the
// main process (electron/ipc/jobs.js) without dragging in the scrape stack.
//
// Context: the query-generation LLM returns a STRUCTURED canonicalLocation
// object (city/stateCode/region/country/isRemote/display) rather than free-form
// prose, because job-board location FILTERS reject prose. `deriveLocationParam`
// flattens that object into the single board-ready string we pass as each
// platform's location param; `summarizeLocationAdherence` audits how many of the
// kept jobs actually sit in the target area (a Denver search that surfaces a
// Miami role should be visible, not hidden).

// Canonical, board-friendly country names. The query-gen model infers a country
// as FREE TEXT — "US" / "USA" / "U.S." / "America" / "United States of America"
// all mean one place — but a board's location FILTER needs ONE consistent string.
// Map common variants + unambiguous ISO codes to a canonical full name; anything
// unrecognized passes through (already a plain country name the model produced,
// which boards tolerate). Mirrors the US_STATES code↔name normalization below.
// Ambiguous 2-letter codes that collide with US state codes (ca=California,
// in=Indiana, de=Delaware, or=Oregon…) are intentionally OMITTED — the schema
// asks the model for full names, so those would be mis-maps far more often than hits.
const COUNTRY_ALIASES = {
  'us': 'United States', 'usa': 'United States', 'america': 'United States',
  'united states of america': 'United States', 'united states': 'United States',
  'uk': 'United Kingdom', 'gb': 'United Kingdom', 'great britain': 'United Kingdom',
  'britain': 'United Kingdom', 'england': 'United Kingdom', 'united kingdom': 'United Kingdom',
  'can': 'Canada', 'canada': 'Canada',
  'aus': 'Australia', 'australia': 'Australia',
  'nz': 'New Zealand', 'new zealand': 'New Zealand',
  'ireland': 'Ireland', 'germany': 'Germany', 'deutschland': 'Germany',
  'france': 'France', 'india': 'India', 'singapore': 'Singapore',
};

/**
 * Normalize a free-text / ISO country into a canonical, board-ready name so the
 * value sent as a location parameter is consistent regardless of how the model
 * phrased it. Unrecognized inputs pass through trimmed (boards accept a plain
 * country name). Pure + testable.
 */
export function normalizeCountry(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const key = s.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
  return COUNTRY_ALIASES[key] || s;
}

/**
 * Flatten the structured canonicalLocation into one board-ready location-filter
 * string — deterministically, so a stray prose token the model might leave in
 * `display` can never reach a board's location field. Most-specific scope wins:
 * city (+ US state code or non-US province) → region → place-shaped display →
 * (remote ⇒ no param) → country → raw fallback. For NON-US places the country is
 * appended ("Whitby, Ontario, Canada") so an international city isn't ambiguous;
 * US places omit it ("Denver, CO"). Returns "" for remote-only / unresolvable so
 * no geo param is sent (nationwide, which already includes remote). Country is the
 * coarsest structured scope — passed best-effort; a US-only board (USAJobs) or a
 * radius board (Dice) may just return zero for it, which is acceptable (we never
 * exclude a platform for an out-of-scope location).
 */
export function deriveLocationParam(struct, rawFallback = '') {
  if (!struct || typeof struct !== 'object') return String(rawFallback || '').trim();
  const city    = String(struct.city || '').trim();
  const state   = String(struct.stateCode || '').trim();   // US 2-letter code OR non-US province/region name
  const region  = String(struct.region || '').trim();
  const country = normalizeCountry(struct.country);          // canonical name ('' if none)
  const display = String(struct.display || '').trim();
  const isUS    = country === 'United States';

  // Append the country for a NON-US place so an international city isn't ambiguous
  // on a board (bare "Whitby" could be Whitby, England → "Whitby, Ontario, Canada"
  // is not). US places omit it: boards default to US and the suffix is redundant
  // (and "Denver, CO, United States" can actually match worse than "Denver, CO").
  const withCountry = (s) => (s && country && !isUS) ? `${s}, ${country}` : s;

  if (city) {
    // Subdivision: US state code or a non-US province/region. city+sub+(country)
    // yields "Denver, CO" (US) or "Whitby, Ontario, Canada" (non-US). Without a
    // sub we still append the country for non-US → "Whitby, Canada".
    const sub = state || region;
    return withCountry(sub ? `${city}, ${sub}` : city);
  }
  if (region) return withCountry(region);
  // Only trust the model's free-text `display` if it's PLACE-SHAPED (short, no
  // sentence punctuation, no prose filler). The schema says display must be a
  // place, never a sentence — this guards against model misbehavior so a stray
  // phrase ("somewhere in the midwest, ideally") never reaches a board's location
  // field. Word/length bounds allow "City, Province, Country". Rarely reached now
  // that city/region assemble above; an unshaped display falls back to raw input.
  const placeShaped = display
    && display.length <= 48
    && !/[.;:!?]/.test(display)
    && (display.match(/\s/g) || []).length <= 5
    && !/\b(in|of|the|or|near|around|somewhere|anywhere|ideally|preferably|maybe)\b/i.test(display);
  if (placeShaped && !/^remote$/i.test(display)) return display;
  // Remote-only → no geo param. Checked BEFORE country so a "remote in the US"
  // search isn't pinned to "United States" (country is always set on US searches).
  if (struct.isRemote) return '';
  // Country-only scope (nothing finer resolved) — emitted from the structured
  // field (already normalized above) so a genuine country search ("Canada") and
  // the career-data no-location default reach every board's filter.
  if (country) return country;
  return String(rawFallback || '').trim();
}

/**
 * How each source applied the target location THIS run. Deterministic from the
 * code (mirrors buildJobTasks / fetchHttpSources / the API fetchers) so the bug
 * report can answer "was location adhered to per platform?" without guessing.
 */
export const LOCATION_TREATMENT = {
  usajobs:        'param: LocationName=',
  dice:           'param: location= (+30mi radius)',
  indeed:         'param: l=',
  ziprecruiter:   'param: location=',
  glassdoor:      'param: locId= (resolved in-browser from the location; locKeyword text alone is ignored by Glassdoor)',
  linkedin:       'param: location=',
  google:         'keyword-only (no location param available; relies on the LLM baking the place into the query)',
  remoteok:       'remote board — location N/A (candidate-city tokens geo-stripped from relevance)',
  weworkremotely: 'remote board — location N/A (candidate-city tokens geo-stripped from relevance)',
};

/**
 * Pick the right Glassdoor location from its autocomplete results
 * (findPopularLocationAjax.htm). Glassdoor's location FILTER is keyed by a numeric
 * `locId` — the `locKeyword` text alone is ignored — so we resolve the text to an
 * id. The endpoint returns several homonyms ("Denver, CO" + "Denver City, TX" +
 * "Denver, PA" …); prefer the one matching our state, else the city, else the
 * first (Glassdoor ranks the most prominent match first). Pure + testable.
 * Returns { locId, locT } or null.
 */
export function pickGlassdoorLocation(results, canonical) {
  if (!Array.isArray(results) || results.length === 0) return null;
  const loc = String(canonical || '').trim();
  const city  = (loc.split(',')[0] || '').trim().toLowerCase();
  const state = (loc.split(',')[1] || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  const text = r => `${String(r?.longName || '')} ${String(r?.label || '')}`.toLowerCase();
  let pick = null;
  if (state) {
    const stateRe = new RegExp(`,\\s*${state}\\b`, 'i');
    pick = results.find(r => stateRe.test(text(r)) && (!city || text(r).includes(city)))
        || results.find(r => stateRe.test(text(r)));
  }
  if (!pick && city) pick = results.find(r => text(r).includes(city));
  if (!pick) pick = results[0]; // Glassdoor ranks the most prominent match first
  // `compoundId`/`id` look like "C1148170"; locationId/realId are the numeric form.
  const rawId = pick.locationId ?? pick.realId ?? (typeof pick.id === 'string' ? pick.id.replace(/^[A-Za-z]/, '') : pick.id);
  const locId = rawId != null && String(rawId).trim() ? String(rawId).trim() : null;
  if (!locId) return null;
  return { locId, locT: pick.locationType || 'C' };
}

// US state code ↔ full name. The adherence check derives a state token from the
// canonical ("Denver, CO" → "co"), but job boards spell the state out far more
// often than they use the 2-letter code ("Golden, Colorado, USA") — so we resolve
// the token to its code and match BOTH spellings, else an in-state suburb reads as
// out-of-area. Keys are codes; values keep their spaces for the word-boundary regex.
const US_STATES = {
  al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california',
  co: 'colorado', ct: 'connecticut', de: 'delaware', fl: 'florida', ga: 'georgia',
  hi: 'hawaii', id: 'idaho', il: 'illinois', in: 'indiana', ia: 'iowa',
  ks: 'kansas', ky: 'kentucky', la: 'louisiana', me: 'maine', md: 'maryland',
  ma: 'massachusetts', mi: 'michigan', mn: 'minnesota', ms: 'mississippi', mo: 'missouri',
  mt: 'montana', ne: 'nebraska', nv: 'nevada', nh: 'new hampshire', nj: 'new jersey',
  nm: 'new mexico', ny: 'new york', nc: 'north carolina', nd: 'north dakota', oh: 'ohio',
  ok: 'oklahoma', or: 'oregon', pa: 'pennsylvania', ri: 'rhode island', sc: 'south carolina',
  sd: 'south dakota', tn: 'tennessee', tx: 'texas', ut: 'utah', vt: 'vermont',
  va: 'virginia', wa: 'washington', wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming',
  dc: 'district of columbia',
};

// Build a regex that matches the target state by EITHER its 2-letter code or its
// full name. `stateToken` arrives alpha-only (spaces already stripped: "new york"
// → "newyork"), so resolve it to a code first, then match the spaced full name.
// Unknown tokens (non-US / unrecognized) fall back to matching the token as-is.
function buildStateRegex(stateToken) {
  if (!stateToken) return null;
  let code = US_STATES[stateToken] ? stateToken : null;
  if (!code) {
    for (const [c, name] of Object.entries(US_STATES)) {
      if (name.replace(/\s/g, '') === stateToken) { code = c; break; }
    }
  }
  const alts = code ? [code, US_STATES[code]] : [stateToken];
  const pattern = alts.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`\\b(?:${pattern})\\b`);
}

/**
 * Audit how many KEPT jobs sit in the target location so a leak (a Denver search
 * surfacing a Miami role) is visible in the bug report instead of hidden.
 * Heuristic, diagnostic-only: city substring OR same-state (code OR full name) =
 * match; remote is bucketed separately; a missing location field is "unknown".
 * `offBySource` tallies off-target jobs per source so the report can tell a
 * keyword-only/remote spillover apart from a real-param source's radius/leak.
 * Returns null when no target location was set (nothing to adhere to).
 */
export function summarizeLocationAdherence(jobs, canonical) {
  const loc = String(canonical || '').trim();
  if (!loc) return null;
  const cityToken  = loc.split(',')[0].trim().toLowerCase();
  const stateToken = (loc.split(',')[1] || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  const stateRe = buildStateRegex(stateToken);
  const counts = { target: loc, total: 0, matched: 0, remote: 0, offTarget: 0, unknown: 0, offSamples: [], offBySource: {} };
  for (const j of (Array.isArray(jobs) ? jobs : [])) {
    counts.total++;
    const jl = String(j?.location || '').trim().toLowerCase();
    if (!jl) { counts.unknown++; continue; }
    if (/\b(remote|anywhere|work from home|wfh|distributed)\b/.test(jl)) { counts.remote++; continue; }
    const cityHit  = cityToken.length >= 3 && jl.includes(cityToken);
    const stateHit = stateRe && stateRe.test(jl);
    if (cityHit || stateHit) counts.matched++;
    else {
      counts.offTarget++;
      const src = j?.source || '?';
      counts.offBySource[src] = (counts.offBySource[src] || 0) + 1;
      if (counts.offSamples.length < 6) counts.offSamples.push(`${String(j?.title || '?').slice(0, 48)} — ${String(j?.location || '').slice(0, 40)} [${src}]`);
    }
  }
  return counts;
}
