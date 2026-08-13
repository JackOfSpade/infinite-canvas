// Pure location helpers for the job-search pipeline. Kept dependency-free (no
// electron / puppeteer) so they're unit-testable in isolation and shared by the
// main process (electron/ipc/jobs.js) without dragging in the scrape stack.
//
// Context: the query-generation LLM returns a STRUCTURED canonicalLocation
// object (city/stateCode/region/country/isRemote/display) rather than free-form
// prose, because job-board location FILTERS reject prose. `deriveLocationParam`
// flattens that object into the single board-ready string we pass as a location
// parameter where supported, or append to Google for Jobs' keyword query (which
// has no reliable location param); `summarizeLocationAdherence` audits how many
// of the kept jobs actually sit in the target area (a Denver search that surfaces
// a Miami role should be visible, not hidden).

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

// Recognize a target that is JUST a country (e.g. "Canada", "United States").
// Unlike normalizeCountry (which passes unrecognized input through), this returns
// null for anything not a known country — so a single-word CITY ("Berlin") is not
// mistaken for a country. Used by the adherence auditor to switch into
// country-membership mode instead of city/subdivision matching.
function detectCountryTarget(seg) {
  const key = String(seg || '').toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
  return COUNTRY_ALIASES[key] || null;
}

/**
 * Flatten the structured canonicalLocation into one board-ready location-filter
 * string — deterministically, so a stray prose token the model might leave in
 * `display` can never reach a board's location field. Most-specific scope wins:
 * city (+ US state code or non-US province) → region → (remote ⇒ no param) →
 * place-shaped display → country → raw fallback. For NON-US places the country is
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
  // Remote-only → no geo param (nationwide already includes remote). Checked
  // BEFORE the display fallback AND before country: a remote-in-country search
  // often arrives as {isRemote: true, display: "Remote, United States"} — that
  // display is "place-shaped" by the guard below, so checking it first used to
  // leak the literal string "Remote, United States" into every board's location
  // filter (Indeed l=, ZipRecruiter location=, USAJobs LocationName=…), which
  // zero-results or mis-filters. isRemote with a real city/region resolved above
  // still geo-filters (hybrid searches want the place).
  if (struct.isRemote) return '';
  // Only trust the model's free-text `display` if it's PLACE-SHAPED (short, no
  // sentence punctuation, no prose filler — and no "remote", which is a work
  // mode, not a place). The schema says display must be a place, never a
  // sentence — this guards against model misbehavior so a stray phrase
  // ("somewhere in the midwest, ideally") never reaches a board's location
  // field. Word/length bounds allow "City, Province, Country". Rarely reached now
  // that city/region assemble above; an unshaped display falls back to raw input.
  const placeShaped = display
    && display.length <= 48
    && !/[.;:!?]/.test(display)
    && (display.match(/\s/g) || []).length <= 5
    && !/\b(in|of|the|or|near|around|somewhere|anywhere|ideally|preferably|maybe|remote|hybrid)\b/i.test(display);
  if (placeShaped) return display;
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
  google:         'keyword-only: canonical location appended to the query (no location param available)',
  remoteok:       'remote board — location N/A (candidate-city tokens geo-stripped from relevance)',
  weworkremotely: 'remote board — location N/A (candidate-city tokens geo-stripped from relevance)',
};

// Remote-only job boards: every listing is remote regardless of the city/region in
// its location field (that's the company HQ or a region hint, not a work-site
// requirement). Location adherence buckets these as `remote`, never off-target.
// Derived from LOCATION_TREATMENT so a new remote board added above is honored here.
export const REMOTE_BOARD_SOURCES = new Set(
  Object.entries(LOCATION_TREATMENT).filter(([, t]) => /remote board/i.test(t)).map(([id]) => id)
);

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
// Exported so src/utils/locationIdentity.js can fold state/province names <->
// codes for applied-job identity matching without duplicating this table —
// see that module for why a second copy would be a correctness hazard (two
// tables drifting apart silently breaks the "same state" match).
export const US_STATES = {
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

// Canadian provinces/territories — same code↔name shape as US_STATES, so a search
// for "Whitby, Ontario" counts a same-province job that lists only the code
// ("Toronto, ON") as in-area instead of off-target.
export const CA_PROVINCES = {
  ab: 'alberta', bc: 'british columbia', mb: 'manitoba', nb: 'new brunswick',
  nl: 'newfoundland and labrador', ns: 'nova scotia', nt: 'northwest territories',
  nu: 'nunavut', on: 'ontario', pe: 'prince edward island', qc: 'quebec',
  sk: 'saskatchewan', yt: 'yukon',
};

// Combined subdivision lookup (US states + Canadian provinces); codes don't collide.
const SUBDIVISIONS = { ...US_STATES, ...CA_PROVINCES };

// Build a regex that matches the target state by EITHER its 2-letter code or its
// full name. `stateToken` arrives alpha-only (spaces already stripped: "new york"
// → "newyork"), so resolve it to a code first, then match the spaced full name.
// Unknown tokens (non-US / unrecognized) fall back to matching the token as-is.
function buildStateRegex(stateToken) {
  if (!stateToken) return null;
  let code = SUBDIVISIONS[stateToken] ? stateToken : null;
  if (!code) {
    for (const [c, name] of Object.entries(SUBDIVISIONS)) {
      if (name.replace(/\s/g, '') === stateToken) { code = c; break; }
    }
  }
  const alts = code ? [code, SUBDIVISIONS[code]] : [stateToken];
  const pattern = alts.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`\\b(?:${pattern})\\b`);
}

// If a target SEGMENT is a US state or Canadian province — by 2-letter code
// ("QC") or full name ("Quebec") — return its canonical 2-letter code, else null.
// Lets the adherence auditor recognize a PROVINCE search ("Quebec, Canada") and
// match same-province jobs ("Montreal, QC") instead of treating "Quebec" as a city.
function subdivisionCode(seg) {
  const alpha = String(seg || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!alpha) return null;
  if (SUBDIVISIONS[alpha]) return alpha;
  for (const [code, name] of Object.entries(SUBDIVISIONS)) {
    if (name.replace(/\s/g, '') === alpha) return code;
  }
  return null;
}

// Subdivisions we can enumerate per country, for country-level adherence (below).
const COUNTRY_SUBDIVISIONS = {
  'Canada': CA_PROVINCES,
  'United States': US_STATES,
};

// Build a regex that matches a job IN the target COUNTRY — i.e. anywhere within
// it. Matches the country name itself plus, where we can enumerate them, every
// subdivision by 2-letter code (word-bounded) or full name. For a country whose
// subdivisions we don't list (UK, Australia, …) it falls back to the country
// name only — which still works because non-US listings get the country appended
// ("Amsterdam, Netherlands"). Lets "Toronto, ON" count as in-area for "Canada".
function buildCountryRegex(country) {
  const c = String(country || '').trim();
  if (!c) return null;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = [esc(c.toLowerCase())];
  const subs = COUNTRY_SUBDIVISIONS[c];
  if (subs) {
    for (const code of Object.keys(subs)) parts.push(`\\b${esc(code)}\\b`);
    for (const name of Object.values(subs)) parts.push(esc(name));
  }
  return new RegExp(`(?:${parts.join('|')})`, 'i');
}

// Every country we can enumerate subdivisions for, EXCEPT the target — used to
// tell "this listing is provably somewhere else" apart from "this listing just
// doesn't say". See summarizeLocationAdherence for why absence isn't evidence.
function buildForeignRegexes(targetCountry) {
  const out = [];
  for (const [country, subs] of Object.entries(COUNTRY_SUBDIVISIONS)) {
    if (country === targetCountry) continue;
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = [`\\b${esc(country.toLowerCase())}\\b`];
    for (const code of Object.keys(subs)) parts.push(`\\b${esc(code)}\\b`);
    for (const name of Object.values(subs)) parts.push(`\\b${esc(name)}\\b`);
    out.push({ country, re: new RegExp(`(?:${parts.join('|')})`, 'i') });
  }
  return out;
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
  const segments = loc.split(',').map(s => s.trim()).filter(Boolean);

  // Country = any segment that's a recognized country name ("Canada", "United States").
  let countryTarget = null;
  for (const s of segments) { const c = detectCountryTarget(s); if (c) { countryTarget = c; break; } }

  // Subdivision (US state / CA province): prefer a NON-FIRST segment ("Denver, CO"
  // / "Washington, DC" → use the 2nd, so a city that happens to share a state's
  // name stays a city). Fall back to the FIRST segment only when it IS a state/
  // province name AND the rest of the target is just the country — i.e. "Quebec,
  // Canada" / "Ontario, Canada" mean the PROVINCE, not a city. Without this a
  // province search treats "Quebec" as a city substring and mis-flags
  // "Montreal, QC" as off-target.
  let subCode = null;
  for (let i = 1; i < segments.length; i++) { const c = subdivisionCode(segments[i]); if (c) { subCode = c; break; } }
  let cityToken = (segments[0] || '').toLowerCase();
  if (!subCode) {
    const firstAsSub = subdivisionCode(segments[0]);
    const restIsCountryOnly = segments.slice(1).every(s => detectCountryTarget(s));
    if (firstAsSub && restIsCountryOnly) { subCode = firstAsSub; cityToken = ''; }
  }

  // Country-MEMBERSHIP mode only when the WHOLE target is a lone country (no city/
  // subdivision): "Canada" alone counts any province in-area, but "Quebec, Canada"
  // must pin to Quebec — not all of Canada. Otherwise the city/subdivision path
  // would mis-flag every Canadian city as off-target on a "Canada" search.
  const countryOnly = !!countryTarget && !subCode && segments.length === 1;
  const countryRe = countryOnly ? buildCountryRegex(countryTarget) : null;
  const foreignRes = countryOnly ? buildForeignRegexes(countryTarget) : [];
  const stateRe = subCode ? buildStateRegex(subCode) : null;
  const counts = { target: loc, country: countryOnly ? countryTarget : null, total: 0, matched: 0, remote: 0, offTarget: 0, unclear: 0, unknown: 0, offSamples: [], unclearSamples: [], offBySource: {}, unclearBySource: {} };
  for (const j of (Array.isArray(jobs) ? jobs : [])) {
    counts.total++;
    const src = j?.source || '?';
    // Remote-only board ⇒ remote regardless of the city/region shown (location N/A).
    if (REMOTE_BOARD_SOURCES.has(src)) { counts.remote++; continue; }
    const jl = String(j?.location || '').trim().toLowerCase();
    if (!jl) { counts.unknown++; continue; }
    if (/\b(remote|anywhere|work from home|wfh|distributed)\b/.test(jl)) { counts.remote++; continue; }
    const sample = `${String(j?.title || '?').slice(0, 48)} — ${String(j?.location || '').slice(0, 40)} [${src}]`;
    if (countryRe) {
      // A COUNTRY target can only be judged on POSITIVE evidence, in both
      // directions. We can enumerate a country's subdivisions but not its cities,
      // so a bare "Newmarket" / "Nanaimo" / "Greater Montreal Metropolitan Area"
      // carries no country token at all — and the old absence-of-evidence rule
      // called every one of them a cross-border leak. A live Canada search
      // reported "8 OUTSIDE Canada" when only the 3 US ones were real, which is
      // exactly the wrong thing for a diagnostic to be confidently wrong about.
      // So: in-country token ⇒ in-area; a token from a DIFFERENT country we can
      // enumerate ⇒ off-target; neither ⇒ `unclear`, counted and reported as its
      // own bucket rather than folded into a leak figure.
      if (countryRe.test(jl)) { counts.matched++; continue; }
      const foreign = foreignRes.find(f => f.re.test(jl));
      if (foreign) {
        counts.offTarget++;
        counts.offBySource[src] = (counts.offBySource[src] || 0) + 1;
        if (counts.offSamples.length < 6) counts.offSamples.push(`${sample} → ${foreign.country}`);
      } else {
        counts.unclear++;
        counts.unclearBySource[src] = (counts.unclearBySource[src] || 0) + 1;
        if (counts.unclearSamples.length < 6) counts.unclearSamples.push(sample);
      }
      continue;
    }
    // City / subdivision target: the token IS enumerable, so absence is evidence.
    const cityHit  = cityToken.length >= 3 && jl.includes(cityToken);
    const stateHit = stateRe && stateRe.test(jl);
    if (cityHit || stateHit) counts.matched++;
    else {
      counts.offTarget++;
      counts.offBySource[src] = (counts.offBySource[src] || 0) + 1;
      if (counts.offSamples.length < 6) counts.offSamples.push(sample);
    }
  }
  return counts;
}
