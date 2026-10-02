import { LOCATION_TREATMENT, PLATFORM_AUTH_COOKIES, assert, buildJobsPipelineSnapshot, classifyGlassdoorLookupFailure, decodeHtmlEntities, deriveLocationParam, describeGlassdoorLocationFailure, describeLocationTreatment, detectLanguage, explicitSalaryCurrency, foldVerificationSample, formatSalaryCurrencyLabel, getJobsTelemetry, getSellMonitorConfig, glassdoorCachedLocationUsable, glassdoorLookupAttemptIsTransient, glassdoorRequestedCountry, glassdoorUrlHasLocationId, glassdoorLocationProof, isGlassdoorCanonicalResultsUrl, parseClaimedResultTotal, zipRecruiterSearchPageNumber, shouldTryZipRecruiterDirectContinuation, REVEAL_STABLE_PASSES, hasMojibake, indeedHostForLocation, inferSalaryCurrency, normalizeJobMarkup, normalizeJobsMarkup, orderByVerification, pickGlassdoorLocation, recordJobsSourceScope, repairJobsMojibake, repairMojibake, stripHtmlToText, summarizeGlassdoorLookupAttempts, summarizeLocationAdherence, tagJobLanguage, upgradeGlassdoorCountryRootCache, validateGlassdoorLocationPick, verificationScore } from '../test-dependencies.js';
import { normalizeLocationInput } from '../../src/utils/jobLocation.js';

export default [
  {
    name: 'Salary currency labels prioritize listing text and clearly mark location fallback',
    run: () => {
      assert(explicitSalaryCurrency('CA$95,000 - CA$120,000/yr') === 'CAD', 'country-qualified dollar values are recognized');
      assert(explicitSalaryCurrency('US$90,000/yr') === 'USD', 'US-qualified dollar values are recognized');
      assert(explicitSalaryCurrency('€80,000/yr') === 'EUR', 'unambiguous currency symbols are recognized');
      const inferredCanada = inferSalaryCurrency('$95,000 - $120,000/yr', 'Toronto, ON');
      assert(inferredCanada?.currency === 'CAD' && inferredCanada.inferred, 'an ambiguous dollar value uses the Canadian job location');
      const inferredUS = inferSalaryCurrency('90,000 - 120,000/yr', 'Denver, CO');
      assert(inferredUS?.currency === 'USD' && inferredUS.inferred, 'a currency-less listing uses the US job location');
      assert(formatSalaryCurrencyLabel('$90,000/yr', 'Remote') === 'Currency not specified', 'unresolved remote locations are not guessed');
      return { explicit: 3, inferred: 2 };
    },
  },
{
    name: 'auth-cookie contract: Reverb uses active credentials cookie, not historical marker',
    run: () => {
      const reverb = PLATFORM_AUTH_COOKIES.reverb || [];
      assert(reverb.includes('user_credentials'), 'Reverb should auto-detect its signed credentials cookie');
      assert(!reverb.includes('has_logged_in'), 'Reverb historical login marker must not count as an active session');
      const config = getSellMonitorConfig('reverb');
      assert(config?.verifyUrl === 'https://reverb.com/my/selling/listings', 'Reverb should participate in verified selling-session checks');
      return { ok: true, reverb, verifyUrl: config.verifyUrl };
    },
  },
  {
    name: 'Glassdoor strict location validation: exact country and subdivision evidence is required',
    run: () => {
      const canada = { locationId: 3, locationType: 'N', countryId: 3, country2LetterIso: 'CA', longName: 'Canada' };
      const usa = { locationId: 1, locationType: 'N', countryId: 1, country2LetterIso: 'US', longName: 'United States' };
      const toronto = { locationId: 1001, locationType: 'C', countryId: 3, country2LetterIso: 'CA', longName: 'Toronto, Ontario, Canada' };
      const denver = { locationId: 1002, locationType: 'C', countryId: 1, country2LetterIso: 'US', longName: 'Denver, Colorado, United States' };

      assert(glassdoorRequestedCountry('Canada')?.iso === 'CA', 'Canada resolves to CA');
      assert(glassdoorRequestedCountry('Denver, CO')?.iso === 'US', 'US country is inferred from a state code');
      assert(validateGlassdoorLocationPick({ locId: '3', locT: 'N' }, [canada], 'Canada') === null, 'Canada country object is accepted');
      assert(validateGlassdoorLocationPick({ locId: '1', locT: 'N' }, [usa], 'USA') === null, 'US country object is accepted');
      assert(validateGlassdoorLocationPick({ locId: '1001', locT: 'C' }, [toronto], 'Toronto, Ontario, Canada') === null, 'Toronto/Canada exact city result is accepted');
      assert(validateGlassdoorLocationPick({ locId: '1002', locT: 'C' }, [denver], 'Denver, CO') === null, 'Denver/CO accepts a result spelling Colorado in full');
      assert(!!validateGlassdoorLocationPick({ locId: '1', locT: 'N' }, [usa], 'Canada'), 'a US result is rejected for Canada');
      assert(!!validateGlassdoorLocationPick({ locId: '1001', locT: 'C' }, [toronto], 'Canada'), 'country-only target rejects a city result');
      // A remote-only search has no location FILTER but still pins a market via
      // a nation-level locId. Reporting it as "unscoped" would contradict the URL
      // the run actually issued.
      // Glassdoor accepts a nation-tier locId and echoes the country in its
      // header, but does NOT filter on it (measured: `_IN1` returned Ontario
      // listings titled "United States jobs"; one province out-counted all of
      // Canada). The report must not describe a filter the board never applied.
      const nationLine = describeLocationTreatment('glassdoor', '', 'United States');
      assert(nationLine.includes('nation tier'), 'the tier is named');
      assert(/NOT enforced/i.test(nationLine), 'the report states the nation tier is not enforced');
      assert(!/\bpins\b|\bpinned\b/i.test(nationLine), 'the report never claims the country was pinned');
      assert(describeLocationTreatment('glassdoor', '', '') === 'no location param (unscoped)',
        'with neither a filter nor a country, unscoped is still the honest answer');
      assert(describeLocationTreatment('ziprecruiter', '', 'United States') === 'no location param (unscoped)',
        'the country pin is Glassdoor-specific — no other source gains one');
      assert(describeLocationTreatment('glassdoor', 'Denver, CO', 'United States').includes('Denver, CO'),
        'an explicit location still reports the location, not the country');
      assert(glassdoorUrlHasLocationId('https://www.glassdoor.ca/Job/canada-jobs-SRCH_IL.0,6_IN3_KO7,24.htm', '3'), 'matching IN3 canonical route is accepted');
      assert(glassdoorUrlHasLocationId('https://www.glassdoor.ca/Job/united-states-jobs-SRCH_IL.0,13_IN1_KO14,31.htm', '1'), 'matching IN1 canonical route is accepted');
      assert(!glassdoorUrlHasLocationId('https://www.glassdoor.ca/Job/jobs.htm?locId=3&locT=N', '3'), 'query-only locId is not proof that Glassdoor applied the location');
      assert(!glassdoorUrlHasLocationId('https://www.glassdoor.ca/Job/canada-jobs-SRCH_IL.0,6_IN3_KO7,24.htm', '1'), 'mismatched canonical route is rejected');
      // City and state routes use _IC / _IS. Recognizing only _IN meant every
      // city- or state-scoped search resolved and navigated correctly and was
      // then discarded as "location not applied".
      assert(glassdoorUrlHasLocationId('https://www.glassdoor.com/Job/denver-jobs-SRCH_IL.0,6_IC1148170_KO7,24.htm', '1148170'), 'city route _IC is accepted');
      assert(glassdoorUrlHasLocationId('https://www.glassdoor.com/Job/colorado-jobs-SRCH_IL.0,8_IS1234_KO9,26.htm', '1234'), 'state route _IS is accepted');
      assert(!glassdoorUrlHasLocationId('https://www.glassdoor.com/Job/denver-jobs-SRCH_IL.0,6_IC1148170_KO7,24.htm', '999'), 'a mismatched city id is still rejected');
      // N/S/C are verified live; the letter class stays OPEN because the safety
      // property is the numeric id, not the type letter. An unseen scope tier
      // (a metro type is the known gap) must not be read as "location not
      // applied" — that skips the whole source, the expensive failure.
      assert(glassdoorUrlHasLocationId('https://www.glassdoor.com/Job/metro-jobs-SRCH_IL.0,5_IM987654_KO6,23.htm', '987654'),
        'an unseen scope letter is accepted when the resolved id matches');
      assert(!glassdoorUrlHasLocationId('https://www.glassdoor.com/Job/metro-jobs-SRCH_IL.0,5_IM987654_KO6,23.htm', '1148170'),
        'an unseen scope letter with a DIFFERENT id is still rejected — the id is the proof');
      // `_IL` brackets the LOCATION substring (not the keyword), so it must
      // never be read as a type marker: the type is the letter before the digits.
      assert(!glassdoorUrlHasLocationId('https://www.glassdoor.com/Job/denver-jobs-SRCH_IL.0,6_IC1148170_KO7,24.htm', '0'),
        'the _IL offset pair is not mistaken for a location id');

      // Three-way proof: a query Glassdoor declines to slugify stays on
      // /Job/jobs.htm, where the marker CANNOT appear — so its absence proves
      // nothing and must not skip the whole source.
      assert(glassdoorLocationProof('https://www.glassdoor.com/Job/denver-jobs-SRCH_IL.0,6_IC1148170_KO7,24.htm', '1148170') === 'applied', 'canonical slug carrying the id reads applied');
      assert(glassdoorLocationProof('https://www.glassdoor.com/Job/canada-jobs-SRCH_IL.0,6_IN3_KO7,24.htm', '1') === 'missing', 'canonical slug with the WRONG id is a real failure');
      assert(glassdoorLocationProof('https://www.glassdoor.com/Job/jobs.htm?sc.keyword=x&locId=1', '1') === 'unavailable', 'non-canonical route cannot prove or disprove the location');
      // ZipRecruiter is the ONE board whose advertised total matched its
      // reachable count when walked to the end (520 reachable, 520 in the
      // header). Two shapes must never be read as a total: the path form's
      // capped "1000+", and the "Showing results N-M" window.
      // A scroll list must NOT stop on the first no-growth pass. Google's cards
      // arrive in batches of ten and the count stalls for one full pass at every
      // batch boundary, while a complete reveal takes 18-47 passes — so a
      // first-plateau stop halts at a boundary and silently under-collects,
      // which from outside looks exactly like the list virtualizing (it does
      // not). This guards a regression back to 1.
      assert(REVEAL_STABLE_PASSES > 1, 'a single no-growth pass must never end a scroll reveal');
      assert(REVEAL_STABLE_PASSES >= 3, 'the streak must clear the observed one-pass batch-boundary stall with margin');
      assert(parseClaimedResultTotal('521 Systems Architect Jobs in Denver, CO') === 521, 'a plain advertised total parses');
      assert(parseClaimedResultTotal('12,431 Registered Nurse Jobs') === 12431, 'thousands separators parse');
      assert(parseClaimedResultTotal('1000+ Sales Jobs') === null, 'a capped 1000+ is a ceiling, not a count');
      assert(parseClaimedResultTotal('Showing results 501-520') === null, 'a result window is not a total');
      assert(parseClaimedResultTotal('No jobs found') === null, 'no number means no total');
      for (const junk of ['', null, undefined, '0 jobs']) {
        assert(parseClaimedResultTotal(junk) === null, `"${junk}" yields no total`);
      }
      assert(zipRecruiterSearchPageNumber('https://www.ziprecruiter.com/jobs-search?search=x') === 1
        && zipRecruiterSearchPageNumber('https://www.ziprecruiter.com/jobs-search/21?search=x') === 21
        && zipRecruiterSearchPageNumber('https://www.ziprecruiter.com/jobseeker/home') === null,
      'ZipRecruiter direct-continuation verification accepts only the exact numbered results route');
      assert(shouldTryZipRecruiterDirectContinuation({
        sourceId: 'ziprecruiter', claimedTotal: 581, collected: 385,
        pageNum: 20, maxPages: 1000, hasNextUrl: true,
      }), 'an unlinked ZipRecruiter page below its advertised count probes the next direct page');
      assert(!shouldTryZipRecruiterDirectContinuation({
        sourceId: 'ziprecruiter', claimedTotal: 581, collected: 385,
        pageNum: 20, maxPages: 20, hasNextUrl: true,
      }) && !shouldTryZipRecruiterDirectContinuation({
        sourceId: 'glassdoor', claimedTotal: 581, collected: 385,
        pageNum: 20, maxPages: 1000, hasNextUrl: true,
      }) && !shouldTryZipRecruiterDirectContinuation({
        sourceId: 'ziprecruiter', claimedTotal: 385, collected: 385,
        pageNum: 20, maxPages: 1000, hasNextUrl: true,
      }), 'direct continuation respects the user page ceiling and never broadens another source or a complete corpus');
      assert(isGlassdoorCanonicalResultsUrl('https://www.glassdoor.com/Job/canada-jobs-SRCH_IL.0,6_IN3.htm'), 'SRCH slug is canonical');
      assert(!isGlassdoorCanonicalResultsUrl('https://www.glassdoor.com/Job/jobs.htm?sc.keyword=x'), 'jobs.htm is not canonical');
      return { ok: true };
    },
  },
{
    // The reported failure: glassdoor.ca answered the location autocomplete with
    // HTTP 504 and its legacy endpoint with HTTP 503, which skipped Glassdoor for
    // the whole run and told the user to check their spelling. A transport result
    // is not a verdict on the location text — it must be retried and reported as
    // what it was.
    name: 'Glassdoor location lookup: server-side failures are transient, a parsed answer is a verdict',
    run: () => {
      const gatewayTimeout = { host: 'www.glassdoor.ca', path: '/autocomplete/location?term=Canada', status: 504 };
      const unavailable = { host: 'www.glassdoor.ca', path: '/findPopularLocationAjax.htm?term=Canada', status: 503 };
      assert(glassdoorLookupAttemptIsTransient(gatewayTimeout), 'HTTP 504 is a transport failure worth retrying');
      assert(glassdoorLookupAttemptIsTransient(unavailable), 'HTTP 503 is a transport failure worth retrying');
      assert(glassdoorLookupAttemptIsTransient({ path: '/autocomplete/location', error: 'no response within 8s' }),
        'a request that never got a response is transient');
      assert(glassdoorLookupAttemptIsTransient({ path: '/autocomplete/location', status: 200, error: 'non-json response' }),
        'a 200 that is not parseable JSON never answered the question');
      // A parsed answer — even an empty one — is a real verdict, not a retry candidate.
      assert(!glassdoorLookupAttemptIsTransient({ path: '/autocomplete/location', status: 200, rows: 0 }),
        'a parsed empty result is an answer, not a transport failure');
      assert(!glassdoorLookupAttemptIsTransient({ path: '/autocomplete/location', status: 200, rows: 4 }),
        'a parsed populated result is an answer');
      assert(!glassdoorLookupAttemptIsTransient({ path: '/autocomplete/location', status: 403 }),
        'a hard rejection is not retried into a longer outage');
      assert(classifyGlassdoorLookupFailure([
        { path: '/autocomplete/location', status: 403 },
        { path: '/findPopularLocationAjax.htm', status: 403 },
      ]) === 'access-denied', 'HTTP 403 is access denial, never a location no-match');
      assert(classifyGlassdoorLookupFailure([gatewayTimeout, unavailable]) === 'transient',
        'retryable transport-only attempts remain transient');
      assert(classifyGlassdoorLookupFailure([{ path: '/autocomplete/location', status: 200, rows: 0 }]) === 'no-match',
        'a parsed empty response is the only lookup-level no-match verdict');
      assert(!glassdoorLookupAttemptIsTransient(null), 'a missing attempt is not treated as transient');

      // The trail reads as observations, collapses repeats, and names every host tried.
      const trail = summarizeGlassdoorLookupAttempts([
        gatewayTimeout, gatewayTimeout, unavailable, unavailable,
        { host: 'www.glassdoor.com', path: '/autocomplete/location?term=Canada', status: 200, rows: 0 },
      ]);
      assert(trail.includes('www.glassdoor.ca/autocomplete/location→HTTP 504 ×2'), `trail collapses repeats: ${trail}`);
      assert(trail.includes('www.glassdoor.ca/findPopularLocationAjax.htm→HTTP 503 ×2'), `trail names the legacy endpoint: ${trail}`);
      assert(trail.includes('www.glassdoor.com/autocomplete/location→HTTP 200 with 0 location(s)'), `trail records the fallback host answer: ${trail}`);
      assert(!trail.includes('term=Canada'), 'the query string is stripped — the endpoint is the observation');
      assert(summarizeGlassdoorLookupAttempts([]) === 'no lookup attempt was recorded', 'an empty trail says so plainly');

      // Wording: a 504 must not be reported as a spelling problem.
      const transient = describeGlassdoorLocationFailure({ location: 'Canada', failure: `autocomplete lookup failed (${trail})`, failureKind: 'transient' });
      assert(/skipped before navigating its locKeyword-only nationwide URL/.test(transient.evidence), 'evidence still states the safety boundary');
      assert(!/spelling/i.test(transient.suggestion), `a transport failure must not blame spelling: ${transient.suggestion}`);
      assert(/retrying Glassdoor is the fix/i.test(transient.suggestion), 'transient failures tell the user to retry');
      const denied = describeGlassdoorLocationFailure({ location: 'Canada', failure: 'autocomplete lookup failed (HTTP 403)', failureKind: 'access-denied' });
      assert(/anti-bot\/session result/i.test(denied.suggestion) && !/spelling/i.test(denied.suggestion),
        `an access denial tells the user to clear verification, not edit the location: ${denied.suggestion}`);
      const rejected = describeGlassdoorLocationFailure({ location: 'Candada', failure: 'selected CA, but the requested country is US', failureKind: 'rejected' });
      assert(/spelling/i.test(rejected.suggestion), 'a rejected match DOES point at the location text');
      const cancelled = describeGlassdoorLocationFailure({ location: 'Canada', failure: 'search was cancelled during location resolution', failureKind: 'cancelled' });
      assert(/nothing to correct/i.test(cancelled.suggestion) && !/spelling/i.test(cancelled.suggestion),
        'a user-cancelled run is never presented as a location mistake');
      const unknown = describeGlassdoorLocationFailure({ location: 'Canada', failure: 'autocomplete returned no verified exact match', failureKind: 'unknown' });
      assert(/spelling/i.test(unknown.suggestion), 'an unclassified failure keeps the original conservative advice');
      return { ok: true, trail };
    },
  },
  {
    // A locId alone is an opaque number. Country provenance is what lets a
    // country-scoped run reuse it — without that, "Canada" re-ran an
    // outage-prone Cloudflare-gated lookup on every single run.
    name: 'Glassdoor locId cache: only country-verified entries may skip the live lookup',
    run: () => {
      const canada = { locId: '3', locT: 'N', country: 'CA' };
      assert(glassdoorCachedLocationUsable(canada, 'Canada'), 'a CA-verified country entry serves a Canada search');
      assert(!glassdoorCachedLocationUsable({ locId: '3', locT: 'N' }, 'Canada'),
        'a legacy entry with no country provenance is re-resolved, never trusted');
      assert(!glassdoorCachedLocationUsable({ locId: '1', locT: 'N', country: 'US' }, 'Canada'),
        'a US entry never serves a Canada search');
      assert(!glassdoorCachedLocationUsable({ locId: '1001', locT: 'C', country: 'CA' }, 'Canada'),
        'a country-only search rejects a cached city, matching the live validation rule');
      assert(glassdoorCachedLocationUsable({ locId: '1148170', locT: 'C', country: 'US' }, 'Denver, CO'),
        'a city entry serves its own city search');
      assert(!glassdoorCachedLocationUsable({ locId: '1148170', locT: 'C', country: 'CA' }, 'Denver, CO'),
        'country inferred from a state code is still enforced');
      // Unqualified locations have no country to check, so any stable id is fine.
      assert(glassdoorCachedLocationUsable({ locId: '2552', locT: 'C' }, 'Berlin'),
        'an unqualified location can use a legacy entry');
      assert(!glassdoorCachedLocationUsable({ locId: '0', locT: 'N', country: 'CA' }, 'Canada'), 'a non-positive id is not usable');
      assert(!glassdoorCachedLocationUsable({ locT: 'N', country: 'CA' }, 'Canada'), 'a missing id is not usable');
      assert(!glassdoorCachedLocationUsable(null, 'Canada'), 'no cache entry is not usable');
      const upgradedCanada = upgradeGlassdoorCountryRootCache({ locId: '3', locT: 'N' }, 'Canada');
      assert(upgradedCanada.country === 'CA' && glassdoorCachedLocationUsable(upgradedCanada, 'Canada'),
        'the stable Canada country root receives CA provenance and becomes reusable');
      const upgradedUs = upgradeGlassdoorCountryRootCache({ locId: '1', locT: 'N' }, 'United States');
      assert(upgradedUs.country === 'US' && glassdoorCachedLocationUsable(upgradedUs, 'United States'),
        'the stable US country root receives US provenance and becomes reusable');
      assert(upgradeGlassdoorCountryRootCache({ locId: '2281069', locT: 'C' }, 'Toronto, Ontario, Canada').country == null,
        'legacy city IDs remain opaque and still require live verification');
      assert(upgradeGlassdoorCountryRootCache({ locId: '1', locT: 'N' }, 'Canada').country == null,
        'a mismatched known country root is never blessed with provenance');
      return { ok: true };
    },
  },
  {
    name: 'normalizeLocationInput: country, province/state, and city scopes remain board-ready',
    run: () => {
      const cases = [
        ['Canada', { boardReady: 'Canada', country: 'Canada', countryCode: 'CA', scope: 'country', city: '', subdivisionCode: '' }],
        ['USA', { boardReady: 'United States', country: 'United States', countryCode: 'US', scope: 'country', city: '', subdivisionCode: '' }],
        ['Ontario, Canada', { boardReady: 'Ontario, Canada', country: 'Canada', countryCode: 'CA', scope: 'subdivision', city: '', subdivisionCode: 'ON' }],
        ['Colorado, USA', { boardReady: 'Colorado, United States', country: 'United States', countryCode: 'US', scope: 'subdivision', city: '', subdivisionCode: 'CO' }],
        ['Toronto, Ontario, Canada', { boardReady: 'Toronto, Ontario, Canada', country: 'Canada', countryCode: 'CA', scope: 'city', city: 'Toronto', subdivisionCode: 'ON' }],
        ['Denver, Colorado, USA', { boardReady: 'Denver, CO', country: 'United States', countryCode: 'US', scope: 'city', city: 'Denver', subdivisionCode: 'CO' }],
      ];
      for (const [raw, expected] of cases) {
        const actual = normalizeLocationInput(raw);
        for (const [key, value] of Object.entries(expected)) {
          assert(actual[key] === value, `${raw}: ${key} expected ${JSON.stringify(value)}, got ${JSON.stringify(actual[key])}`);
        }
      }
      // Existing board-ready formats and country aliases are idempotent.
      assert(normalizeLocationInput('Denver, CO').boardReady === 'Denver, CO', 'US postal-code format stays board-ready');
      assert(normalizeLocationInput('Toronto, ON, Canada').boardReady === 'Toronto, Ontario, Canada', 'Canadian province code expands to an unambiguous board-ready name');
      assert(normalizeLocationInput('United States of America').boardReady === 'United States', 'US country alias normalizes');
      const conflict = normalizeLocationInput('Ontario, USA');
      assert(conflict.countryConflict && conflict.boardReady === '' && conflict.scope === 'unknown', 'conflicting country/subdivision is rejected rather than silently mis-scoped');
      return { ok: true, cases: cases.length };
    },
  },
{
    // The query LLM now returns a STRUCTURED location object so a board's location
    // FILTER never receives prose. deriveLocationParam flattens it deterministically
    // into the "City, ST" string actually sent to USAJobs/Dice/Indeed/ZR/Glassdoor/LinkedIn.
    name: 'deriveLocationParam: structured canonical → board-ready string (typo-corrected)',
    run: () => {
      // "denvr" → corrected structured object → clean "Denver, CO".
      assert(deriveLocationParam({ city: 'Denver', stateCode: 'CO', region: '', country: 'United States', isRemote: false, display: 'Denver, CO' }) === 'Denver, CO', 'city+state → "City, ST"');
      assert(deriveLocationParam({ city: 'Denver', stateCode: 'Colorado', country: 'USA' }) === 'Denver, CO', 'full US state + country alias → USPS board-ready format');
      assert(deriveLocationParam({ region: 'Colorado', country: 'USA' }) === 'Colorado, United States', 'state-only scope stays human-readable and country-qualified');
      assert(deriveLocationParam({ city: 'Toronto', stateCode: 'ON', country: 'Canada' }) === 'Toronto, Ontario, Canada', 'Canadian province code expands with country');
      // city+state is built deterministically, NOT trusted from a possibly-prose display.
      assert(deriveLocationParam({ city: 'Denver', stateCode: 'CO', display: 'around the Denver metro area' }) === 'Denver, CO', 'city+state wins over prose display');
      assert(deriveLocationParam({ city: 'Austin', stateCode: '', region: '', display: 'Austin' }) === 'Austin', 'city-only falls through to city');
      assert(deriveLocationParam({ city: '', stateCode: '', region: 'Bay Area', display: 'Bay Area' }) === 'Bay Area', 'region when no city');
      // Remote → empty param (no geo filter sent → nationwide, which includes remote).
      assert(deriveLocationParam({ city: '', stateCode: '', region: '', isRemote: true, display: 'Remote' }) === '', 'remote → empty param');
      assert(deriveLocationParam({ city: '', stateCode: '', region: '', isRemote: false, display: 'Remote' }) === '', '"Remote" display is never sent as a geo filter');
      // Regression: isRemote used to be checked AFTER the place-shaped display
      // fallback, so a remote-in-country search leaked the literal string
      // "Remote, United States" into every board's location filter.
      assert(deriveLocationParam({ city: '', stateCode: '', region: '', country: 'United States', isRemote: true, display: 'Remote, United States' }) === '',
        'remote-in-country: display never leaks as a geo param');
      assert(deriveLocationParam({ city: '', stateCode: '', region: '', isRemote: false, display: 'Remote, USA' }, '') === '',
        'remote-flavored display is rejected by the place-shape guard even when isRemote is unset');
      assert(deriveLocationParam({ city: 'Denver', stateCode: 'CO', country: 'United States', isRemote: true, display: 'Remote' }) === 'Denver, CO',
        'hybrid (remote + a real city) still geo-filters to the city');
      // Defensive: a non-object (legacy/empty) falls back to the raw input, never throws.
      assert(deriveLocationParam(null, 'denvr') === 'denvr', 'null struct → raw fallback');
      assert(deriveLocationParam({}, '') === '', 'empty struct + no fallback → ""');
      // Prose-leak guard: a model that ignores the schema and puts a sentence in
      // `display` must NOT have it reach a board's location field — fall back to raw.
      assert(deriveLocationParam({ city: '', stateCode: '', region: '', display: 'somewhere in the midwest, ideally' }, 'midwest') === 'midwest', 'prose display rejected → raw fallback');
      assert(deriveLocationParam({ city: '', stateCode: '', region: '', display: 'anywhere near the coast' }, '') === '', 'prose display + no fallback → "" (never sends prose)');
      // A genuine place-shaped display (no structured fields) is still accepted.
      assert(deriveLocationParam({ city: '', stateCode: '', region: '', display: 'San Francisco, CA' }) === 'San Francisco, CA', 'place-shaped display accepted');
      assert(LOCATION_TREATMENT.google === 'keyword-only: canonical location appended to the query (no location param available)',
        'Google diagnostics state that the canonical location is appended to its keyword query, not only LLM-baked');
      assert(describeLocationTreatment('linkedin', 'Canada') === 'param: location=Canada',
        'LinkedIn report telemetry includes the actual canonical location parameter value');
      assert(describeLocationTreatment('linkedin', 'Toronto, Ontario, Canada') === 'param: location=Toronto, Ontario, Canada',
        'location-report formatting preserves a multi-part canonical board value');
      assert(describeLocationTreatment('linkedin', '') === 'no location param (unscoped)',
        'a genuinely unscoped run does not claim that a blank location parameter was sent');
      return { ok: true };
    },
  },
{
    name: 'Indeed host: country-qualified locations choose their country board',
    run: () => {
      assert(indeedHostForLocation('Whitby, Ontario, Canada') === 'ca.indeed.com',
        'Canadian city search uses ca.indeed.com rather than the US board');
      assert(indeedHostForLocation('Canada') === 'ca.indeed.com',
        'country-only Canadian search uses ca.indeed.com');
      assert(indeedHostForLocation('Denver, CO') === 'www.indeed.com',
        'US/default search keeps the global Indeed host');
      assert(indeedHostForLocation('London, United Kingdom') === 'uk.indeed.com',
        'UK city search uses the UK Indeed host');
      assert(indeedHostForLocation('') === 'www.indeed.com' && indeedHostForLocation(null) === 'www.indeed.com',
        'blank/missing locations retain the global Indeed host');
      assert(indeedHostForLocation('Ontario, CA') === 'www.indeed.com',
        'CA state abbreviation means California here, never Canada');
      return { canada: 'ca.indeed.com', us: 'www.indeed.com' };
    },
  },
{
    // Glassdoor's location filter is keyed by a numeric locId (locKeyword text is
    // ignored — confirmed empirically). This is the real findPopularLocationAjax
    // payload for "Denver": pickGlassdoorLocation must choose Denver, CO (1148170),
    // NOT Denver City, TX / Denver, PA / etc.
    name: 'pickGlassdoorLocation: resolves the correct homonym by state (real Glassdoor JSON)',
    run: () => {
      const denverResults = [
        { compoundId: 'C1148170', id: 'C1148170', label: 'Denver, CO (US)', locationId: 1148170, locationType: 'C', longName: 'Denver, CO (US)', realId: 1148170 },
        { compoundId: 'C1139288', id: 'C1139288', label: 'Denver City, TX (US)', locationId: 1139288, locationType: 'C', longName: 'Denver City, TX (US)', realId: 1139288 },
        { compoundId: 'C1152344', id: 'C1152344', label: 'Denver, PA (US)', locationId: 1152344, locationType: 'C', longName: 'Denver, PA (US)', realId: 1152344 },
        { compoundId: 'C1149511', id: 'C1149511', label: 'Denver, IA (US)', locationId: 1149511, locationType: 'C', longName: 'Denver, IA (US)', realId: 1149511 },
      ];
      const co = pickGlassdoorLocation(denverResults, 'Denver, CO');
      assert(co && co.locId === '1148170' && co.locT === 'C', `Denver, CO → 1148170/C, got ${JSON.stringify(co)}`);
      // Different state picks the right homonym, not the first result.
      const pa = pickGlassdoorLocation(denverResults, 'Denver, PA');
      assert(pa && pa.locId === '1152344', `Denver, PA → 1152344, got ${JSON.stringify(pa)}`);
      // No state given → first (most prominent) result.
      const bare = pickGlassdoorLocation(denverResults, 'Denver');
      assert(bare && bare.locId === '1148170', `bare "Denver" → first (1148170), got ${JSON.stringify(bare)}`);
      // Empty / malformed input → null, never throws.
      assert(pickGlassdoorLocation([], 'Denver, CO') === null, 'empty results → null');
      assert(pickGlassdoorLocation(null, 'Denver, CO') === null, 'null results → null');
      return { ok: true };
    },
  },
{
    name: 'summarizeLocationAdherence: flags off-target survivors (the Miami-for-Denver leak)',
    run: () => {
      const jobs = [
        { title: 'Brand Manager', location: 'Denver, CO', source: 'indeed' },     // in-area (city)
        { title: 'Marketing Lead', location: 'Boulder, CO', source: 'dice' },     // in-area (same state)
        { title: 'Sr. Brand Mgr, BK', location: 'Miami, FL', source: 'linkedin' },// OFF-TARGET
        { title: 'Growth PM', location: 'Remote', source: 'remoteok' },           // remote bucket
        { title: 'Mystery role', location: '', source: 'google' },                // unknown
      ];
      const a = summarizeLocationAdherence(jobs, 'Denver, CO');
      assert(a.total === 5, 'counts all kept jobs');
      assert(a.matched === 2, `2 in-area (city + same-state), got ${a.matched}`);
      assert(a.remote === 1, '1 remote');
      assert(a.offTarget === 1, `1 off-target (Miami), got ${a.offTarget}`);
      assert(a.unknown === 1, '1 unknown (no location)');
      assert(a.offSamples.length === 1 && /Miami/.test(a.offSamples[0]), 'off-target sample names the Miami role');
      // No target location → nothing to audit.
      assert(summarizeLocationAdherence(jobs, '') === null, 'no canonical → null');
      return { ok: true, adherence: a };
    },
  },
{
    name: 'summarizeLocationAdherence: remote-board listings count as remote (not off-target) even with a city',
    run: () => {
      const jobs = [
        { title: 'Estimator II', location: 'Pune Division', source: 'remoteok' },          // remote board + city → remote
        { title: 'Social Media Mod', location: 'Philippines', source: 'weworkremotely' },   // remote board + region → remote
        { title: 'Data Eng', location: 'Raleigh, NC', source: 'glassdoor' },               // hard-param source → off-target leak
      ];
      const a = summarizeLocationAdherence(jobs, 'Durham, Ontario, Canada');
      assert(a.remote === 2, `remote-board listings bucket as remote, got ${a.remote}`);
      assert(a.offTarget === 1, `only the glassdoor leak is off-target, got ${a.offTarget}`);
      assert(!a.offBySource.remoteok && !a.offBySource.weworkremotely, 'no remote board attributed to off-target');
      return { ok: true, adherence: a };
    },
  },
{
    name: 'summarizeLocationAdherence: same Canadian province (code-only job) counts as in-area',
    run: () => {
      const jobs = [
        { title: 'Data Engineer', location: 'Whitby, ON', source: 'ziprecruiter' },     // exact city
        { title: 'Sr Data Engineer', location: 'Toronto, ON', source: 'ziprecruiter' }, // same province, code only
        { title: 'DBA', location: 'Ottawa, Ontario', source: 'glassdoor' },             // same province, spelled out
        { title: 'Analyst', location: 'Vancouver, BC', source: 'ziprecruiter' },        // different province → off-target
      ];
      const a = summarizeLocationAdherence(jobs, 'Whitby, Ontario, Canada');
      assert(a.matched === 3, `Whitby + both Ontario jobs are in-area, got ${a.matched}`);
      assert(a.offTarget === 1 && /Vancouver/.test(a.offSamples[0] || ''), `only BC is off-target, got ${a.offTarget}`);
      return { ok: true, adherence: a };
    },
  },
{
    name: 'summarizeLocationAdherence: country target "Canada" → any province is in-area, only cross-border is off',
    run: () => {
      const jobs = [
        { title: 'Data Engineer', location: 'Toronto, ON', source: 'ziprecruiter' },      // ON code → in Canada
        { title: 'DBA', location: 'Montreal, QC', source: 'ziprecruiter' },               // QC code → in Canada
        { title: 'Architect', location: 'Halifax, Nova Scotia', source: 'glassdoor' },    // full name → in Canada
        { title: 'Analyst', location: 'Vancouver, BC', source: 'indeed' },                // BC code → in Canada
        { title: 'Sales Mgr', location: 'Houston, TX', source: 'indeed' },                // US → cross-border leak
        { title: 'Coordinator', location: 'Newmarket', source: 'google' },                // no country evidence
      ];
      const a = summarizeLocationAdherence(jobs, 'Canada');
      assert(a.country === 'Canada', `country target detected, got ${a.country}`);
      assert(a.matched === 4, `all 4 Canadian jobs in-area, got ${a.matched}`);
      assert(a.offTarget === 1 && /Houston/.test(a.offSamples[0] || ''), `only Houston TX is off, got ${a.offTarget}`);
      assert(a.unclear === 1 && /Newmarket/.test(a.unclearSamples[0] || ''),
        'country-only target leaves an unqualified city as unclear instead of falsely off-target');
      return { ok: true, adherence: a };
    },
  },
{
    name: 'summarizeLocationAdherence: Canada keeps ambiguous cities unclear and labels confirmed US leaks',
    run: () => {
      const a = summarizeLocationAdherence([
        { title: 'Toronto role', location: 'Toronto, ON', source: 'glassdoor' },
        { title: 'Calgary role', location: 'Calgary, Alberta, Canada', source: 'linkedin' },
        { title: 'US role', location: 'Haysi, VA 24256', source: 'indeed' },
        { title: 'Bare city', location: 'Newmarket', source: 'glassdoor' },
        { title: 'Metro region', location: 'Greater Montreal Metropolitan Area', source: 'linkedin' },
        { title: 'Remote board role', location: 'Austin, TX', source: 'weworkremotely' },
        { title: 'No location', location: '', source: 'google' },
      ], 'Canada');
      assert(a.matched === 2, `Canadian province/country evidence matches both jobs, got ${a.matched}`);
      assert(a.offTarget === 1 && /United States/.test(a.offSamples[0] || ''),
        `Haysi, VA is a confirmed US leak, got ${JSON.stringify(a.offSamples)}`);
      assert(a.unclear === 2 && a.unclearSamples.some(sample => /Newmarket/.test(sample))
        && a.unclearSamples.some(sample => /Greater Montreal/.test(sample)),
      'bare Canadian-looking cities/metros remain unclear rather than falsely off-target');
      assert(a.remote === 1 && a.unknown === 1, 'remote board and missing location retain their own buckets');
      return { ok: true, adherence: a };
    },
  },
{
    name: 'summarizeLocationAdherence: USAJobs postings with an undecidable location are US by construction',
    run: () => {
      // A live run reported "4 unclear · by source: usajobs=4" — all four were
      // federal postings reading "Location Negotiable After Selection", i.e. US
      // jobs with no pinnable state, not jobs of unknowable country.
      const negotiable = { location: 'Location Negotiable After Selection', source: 'usajobs' };
      const us = summarizeLocationAdherence([
        { title: 'CSR', ...negotiable },
        { title: 'Lead CSR', ...negotiable },
        { title: 'Bare city elsewhere', location: 'Newmarket', source: 'glassdoor' },
      ], 'United States');
      assert(us.matched === 2 && us.unclear === 1,
        `USAJobs undecidable locations count in-area for a US target, got matched=${us.matched} unclear=${us.unclear}`);
      assert(!us.unclearBySource.usajobs, 'usajobs no longer contributes to the unclear tally on a US search');
      // Must NOT swallow a genuine OCONUS posting. Only Canada's subdivisions are
      // enumerable, so "Ramstein, Germany" can't be PROVEN foreign — but it names a
      // real place, so the shortcut must not claim it as in-area either.
      const oconus = summarizeLocationAdherence([
        { title: 'Germany role', location: 'Ramstein, Germany', source: 'usajobs' },
        { title: 'Japan role', location: 'Yokosuka, Japan', source: 'usajobs' },
      ], 'United States');
      assert(oconus.unclear === 2 && oconus.matched === 0,
        `a USAJobs posting that names a real non-US place stays unclear, got ${JSON.stringify(oconus)}`);
      const canadaLeak = summarizeLocationAdherence([
        { title: 'CA role', location: 'Toronto, Ontario, Canada', source: 'usajobs' },
      ], 'United States');
      assert(canadaLeak.offTarget === 1,
        'a USAJobs posting naming an enumerable foreign country is still reported off-target');
      // Must NOT apply to a city/state-level target, or to a non-US country target.
      const city = summarizeLocationAdherence([{ title: 'CSR', ...negotiable }], 'Denver, CO');
      assert(city.offTarget === 1 && city.matched === 0,
        'a city-level target still judges USAJobs on real location tokens');
      const canada = summarizeLocationAdherence([{ title: 'CSR', ...negotiable }], 'Canada');
      assert(canada.unclear === 1 && canada.matched === 0,
        'the US-by-construction shortcut does not fire for a non-US country target');
      return { ok: true, us, oconus };
    },
  },
{
    name: 'summarizeLocationAdherence: subdivision codes require a structured location slot',
    run: () => {
      const a = summarizeLocationAdherence([
        { title: 'French role', location: 'Office in Paris', source: 'google' },
        { title: 'French role 2', location: 'On-site, Paris', source: 'google' },
        { title: 'Ontario role', location: 'Toronto, ON', source: 'google' },
        { title: 'US role', location: 'Haysi, VA 24256', source: 'indeed' },
      ], 'Canada');
      assert(a.matched === 1, `only structured Toronto, ON should count Canadian, got ${a.matched}`);
      assert(a.offTarget === 1 && /Haysi/.test(a.offSamples[0] || ''),
        `only structured VA should be a confirmed US leak, got ${JSON.stringify(a.offSamples)}`);
      assert(a.unclear === 2, `plain English in/on must not become IN/ON state/province evidence, got ${a.unclear}`);
      return { ok: true, adherence: a };
    },
  },
{
    name: 'summarizeLocationAdherence: a single-word CITY is not mistaken for a country',
    run: () => {
      // "Toronto" alone (no province/country) must stay a city match, not flip
      // into country mode — detectCountryTarget only fires on known country names.
      const jobs = [
        { title: 'Eng', location: 'Toronto, ON', source: 'ziprecruiter' },
        { title: 'Eng', location: 'Calgary, AB', source: 'ziprecruiter' }, // diff city, no country target → off
      ];
      const a = summarizeLocationAdherence(jobs, 'Toronto');
      assert(a.country === null, `"Toronto" is not a country, got ${a.country}`);
      assert(a.matched === 1 && a.offTarget === 1, `city match only: 1 in / 1 off, got ${a.matched}/${a.offTarget}`);
      return { ok: true, adherence: a };
    },
  },
{
    name: 'summarizeLocationAdherence: province target "Quebec, Canada" matches same-province jobs (not treated as a city)',
    run: () => {
      const jobs = [
        { title: 'Data Eng', location: 'Montreal, QC', source: 'ziprecruiter' },       // QC code → in-province
        { title: 'DBA', location: 'Quebec City, Quebec', source: 'glassdoor' },        // province name → in
        { title: 'Analyst', location: 'Laval, QC', source: 'indeed' },                 // QC code → in
        { title: 'SDE', location: 'Boston, MA', source: 'indeed' },                    // US → off (real leak)
      ];
      const a = summarizeLocationAdherence(jobs, 'Quebec, Canada');
      assert(a.country === null, `province search is not a bare-country target, got ${a.country}`);
      assert(a.matched === 3, `all 3 Quebec jobs in-area, got ${a.matched}`);
      assert(a.offTarget === 1 && /Boston/.test(a.offSamples[0] || ''), `only Boston off, got ${a.offTarget}`);
      return { ok: true, adherence: a };
    },
  },
{
    name: 'summarizeLocationAdherence: "Washington, DC" stays a city (Seattle, WA is NOT in-area)',
    run: () => {
      // Regression guard: the first segment "Washington" is a state NAME, but the
      // 2nd segment "DC" is the real subdivision — so it must stay a city search,
      // not flip to "Washington state" and count Seattle as in-area.
      const jobs = [
        { title: 'PM', location: 'Washington, DC', source: 'indeed' },   // in
        { title: 'Eng', location: 'Seattle, WA', source: 'indeed' },     // WA state → off
      ];
      const a = summarizeLocationAdherence(jobs, 'Washington, DC');
      assert(a.matched === 1 && a.offTarget === 1 && /Seattle/.test(a.offSamples[0] || ''),
        `DC city match only: Seattle off, got ${a.matched}/${a.offTarget}`);
      return { ok: true, adherence: a };
    },
  },
{
    name: 'summarizeLocationAdherence: US territories (GU/PR/VI/AS/MP) count in-area on a "United States" target',
    run: () => {
      // Regression guard: a live run reported "Tamuning, GU" (Guam) as `unclear`
      // on a "United States" search — GU is Guam's USPS code, a US territory, and
      // US_STATES (which feeds buildCountryRegex's "United States" subdivision
      // list) didn't carry it or its sibling territories.
      const jobs = [
        { title: 'Patient Services Associate', location: 'Tamuning, GU', source: 'glassdoor' },
        { title: 'Front Desk', location: 'San Juan, Puerto Rico', source: 'indeed' },
        { title: 'Analyst', location: 'San Juan, PR', source: 'indeed' },
        { title: 'Tech', location: 'Charlotte Amalie, VI', source: 'indeed' },
        { title: 'Clerk', location: 'Pago Pago, AS', source: 'indeed' },
        { title: 'Nurse', location: 'Saipan, MP', source: 'indeed' },
        { title: 'Canada leak', location: 'Toronto, ON', source: 'indeed' }, // still off-target
      ];
      const a = summarizeLocationAdherence(jobs, 'United States');
      assert(a.matched === 6, `all 6 territory postings are in-area, got ${a.matched}`);
      assert(a.unclear === 0, `no territory should fall into unclear, got ${a.unclear}`);
      assert(a.offTarget === 1 && /Toronto/.test(a.offSamples[0] || ''),
        `only the Canadian leak stays off-target, got ${a.offTarget}`);
      return { ok: true, adherence: a };
    },
  },
{
    // Who produced the in-area count decides what it is worth: a source that
    // received no location parameter renders its location strings relative to the
    // search, so its agreement is an echo. And the off-target check can only
    // recognize countries whose subdivisions we enumerate, which bounds what
    // "0 off-target" is evidence of.
    name: 'summarizeLocationAdherence: in-area jobs are attributed per source and cross-border reach is enumerable',
    run: () => {
      const country = summarizeLocationAdherence([
        { title: 'Data Engineer', location: 'Toronto, ON', source: 'google' },
        { title: 'DBA', location: 'Montreal, QC', source: 'google' },
        { title: 'Architect', location: 'Halifax, Nova Scotia', source: 'glassdoor' },
        { title: 'Sales Mgr', location: 'Houston, TX', source: 'indeed' },       // cross-border leak
        { title: 'Coordinator', location: 'Newmarket', source: 'google' },       // unclear
        { title: 'Remote role', location: 'Austin, TX', source: 'weworkremotely' }, // remote board
      ], 'Canada');
      assert(country.matched === 3, `3 Canadian jobs in-area, got ${country.matched}`);
      assert(country.matchedBySource.google === 2 && country.matchedBySource.glassdoor === 1,
        `in-area jobs are tallied per source, got ${JSON.stringify(country.matchedBySource)}`);
      assert(!country.matchedBySource.indeed && !country.matchedBySource.weworkremotely,
        'off-target, unclear and remote jobs never enter the in-area tally');
      assert(country.foreignDetectable.join(', ') === 'United States',
        `a Canada target can only detect US tokens, got ${JSON.stringify(country.foreignDetectable)}`);
      const us = summarizeLocationAdherence([{ title: 'CSR', location: 'Denver, CO', source: 'indeed' }], 'United States');
      assert(us.foreignDetectable.join(', ') === 'Canada' && us.matchedBySource.indeed === 1,
        `a US target detects Canada only, got ${JSON.stringify(us.foreignDetectable)}`);
      // The USAJobs US-by-construction shortcut is a match like any other and must
      // be attributed, or a hard-param source's contribution disappears from the tally.
      const federal = summarizeLocationAdherence([
        { title: 'CSR', location: 'Location Negotiable After Selection', source: 'usajobs' },
      ], 'United States');
      assert(federal.matched === 1 && federal.matchedBySource.usajobs === 1,
        `the USAJobs placeless shortcut is attributed, got ${JSON.stringify(federal.matchedBySource)}`);
      // City / subdivision mode: same tally, and no cross-border claim at all —
      // the foreign detector only runs on a lone-country target.
      const region = summarizeLocationAdherence([
        { title: 'Brand Manager', location: 'Denver, CO', source: 'indeed' },
        { title: 'Marketing Lead', location: 'Boulder, CO', source: 'dice' },
        { title: 'Sr. Brand Mgr', location: 'Miami, FL', source: 'linkedin' },
      ], 'Denver, CO');
      assert(region.matchedBySource.indeed === 1 && region.matchedBySource.dice === 1 && !region.matchedBySource.linkedin,
        `region mode tallies in-area per source, got ${JSON.stringify(region.matchedBySource)}`);
      assert(Array.isArray(region.foreignDetectable) && region.foreignDetectable.length === 0,
        `a city target claims no cross-border reach, got ${JSON.stringify(region.foreignDetectable)}`);
      return { ok: true, country: country.matchedBySource, region: region.matchedBySource };
    },
  },
{
    // The adherence line is read by a person deciding whether a location filter
    // worked, so its WORDING is the product. Driven through the real report
    // renderer: the label and both caveats must stay tied to the tallies.
    name: 'bug report: adherence line says remote-by-location, states detector reach, and caveats a keyword-only in-area figure',
    run: () => {
      const telemetry = getJobsTelemetry();
      const prior = {
        nodeId: telemetry.nodeId,
        boardNodeId: telemetry.boardNodeId,
        windowId: telemetry.windowId,
        bucketing: telemetry.bucketing,
        search: telemetry.search,
        pipeline: telemetry.pipeline,
      };
      const renderCanada = (jobs, perSource) => {
        recordJobsSourceScope('location-adherence-diagnostics', 903);
        telemetry.pipeline = null;
        telemetry.search = {
          ts: Date.now(),
          queries: 1,
          raw: jobs.length,
          deduped: jobs.length,
          ageDropped: 0,
          historyDropped: 0,
          kept: jobs.length,
          location: {
            rawInput: 'Canada',
            canonical: 'Canada',
            perSource,
            adherence: summarizeLocationAdherence(jobs, 'Canada'),
          },
        };
        const report = buildJobsPipelineSnapshot(new Set(['location-adherence-diagnostics']), 903, null);
        return report.split('\n');
      };
      try {
        const keywordOnly = renderCanada([
          { title: 'Data Engineer', location: 'Espanola, ON', source: 'google' },
          { title: 'Data Engineer', location: 'Wawa, ON', source: 'google' },
          { title: 'Analyst', location: 'Canada', source: 'google' },
          { title: 'DBA', location: 'Montreal, QC', source: 'google' },
        ], { google: LOCATION_TREATMENT.google });
        const line = keywordOnly.find(l => l.startsWith('- Location adherence')) || '';
        assert(/0 remote-by-location,/.test(line),
          `the remote bucket is labelled by what it measures (location fields), got: ${line}`);
        assert(!/\d+ remote,/.test(line), `the bare "remote" census wording is gone, got: ${line}`);
        const renderedKeywordOnly = keywordOnly.join('\n');
        assert(renderedKeywordOnly.includes('Target location: configured location')
          && renderedKeywordOnly.includes('`google`: configured')
          && renderedKeywordOnly.includes('Location adherence over 4 kept job(s)')
          && !renderedKeywordOnly.includes('Canada')
          && !renderedKeywordOnly.includes('Espanola')
          && !renderedKeywordOnly.includes('Wawa')
          && !renderedKeywordOnly.includes('Montreal'),
        'location diagnostics retain target/adherence structure while withholding synthetic raw place values');

        // Negative control: one real-param source in the in-area tally means the
        // figure is no longer only the provider's own rendering.
        const withParamSource = renderCanada([
          { title: 'Data Engineer', location: 'Espanola, ON', source: 'google' },
          { title: 'Data Engineer', location: 'Wawa, ON', source: 'google' },
          { title: 'Analyst', location: 'Canada', source: 'google' },
          { title: 'DBA', location: 'Montreal, QC', source: 'indeed' },
        ], { google: LOCATION_TREATMENT.google, indeed: 'param: location=Canada' });
        assert(!withParamSource.some(l => l.includes('rests entirely on keyword-only source(s)')),
          'the keyword-only caveat must not fire when a location-param source contributed to the in-area count');
        assert(withParamSource.some(l => l.includes('Location adherence over 4 kept job(s)')),
          'the aggregate adherence evidence remains useful when source treatment changes');
        return { ok: true, line };
      } finally {
        telemetry.nodeId = prior.nodeId;
        telemetry.boardNodeId = prior.boardNodeId;
        telemetry.windowId = prior.windowId;
        telemetry.bucketing = prior.bucketing;
        telemetry.search = prior.search;
        telemetry.pipeline = prior.pipeline;
      }
    },
  },
{
    name: 'detectLanguage: Portuguese JD body (English title) → pt; near-tie garbage stays en',
    run: () => {
      // Real shape from a WeWorkRemotely listing: English title, Portuguese body.
      const ptBody = 'Data Quality Analyst I. Headquarters: BR. Conheça a nossa banda! Somos uma empresa inovadora e buscamos um analista de qualidade de dados para a nossa equipe, com experiência em SQL e responsabilidades de governança.';
      assert(detectLanguage(ptBody) === 'pt', `Portuguese body → pt, got ${detectLanguage(ptBody)}`);
      // English JD with a lone accented loanword must NOT be tagged.
      const enBody = 'Estimator II. About Us: Honeywell helps organizations solve the world\'s most complex challenges in automation and energy. You will prepare cost estimates, bids, and proposals. 5 years experience required.';
      assert(detectLanguage(enBody) === 'en', `English body → en, got ${detectLanguage(enBody)}`);
      return { ok: true };
  },
},
{
    name: 'tagJobLanguage: refreshed English content clears a stale non-English card chip',
    run: () => {
      const job = {
        title: 'Développeur logiciel',
        snippet: 'Nous recherchons un développeur expérimenté pour concevoir des applications et collaborer avec notre équipe produit.',
      };
      tagJobLanguage(job);
      assert(job.language === 'fr', `French initial scrape must be tagged, got ${job.language}`);

      // Detail recovery can replace a localized teaser with the employer's
      // English job description. A retained `fr` field would render a false
      // language chip even though the latest, richer evidence is English.
      job.title = 'Software Engineer';
      job.snippet = 'Join our engineering team to build reliable software, improve developer workflows, and collaborate with product partners.';
      job.description = 'You will design services, review code, ship product improvements, and work closely with a collaborative team of engineers and designers.';
      tagJobLanguage(job);
      assert(job.language === undefined, `English refresh must remove stale language, got ${job.language}`);

      // A sparse post-detail state is inconclusive, not evidence that the old
      // French label remains valid. The detector deliberately defaults weak
      // signals to English, which means no chip should be rendered.
      job.language = 'fr';
      job.title = 'VP';
      job.snippet = '';
      job.description = '';
      tagJobLanguage(job);
      assert(job.language === undefined, `inconclusive refresh must remove stale language, got ${job.language}`);
      return { ok: true };
    },
  },
{
    name: 'repairMojibake: reverses UTF-8-as-Latin-1, leaves clean text + real accents alone',
    run: () => {
      const e2 = String.fromCharCode(0xe2);
      const moji = 'we' + e2 + String.fromCharCode(0x80, 0x99) + 'd love' + e2 + String.fromCharCode(0x80, 0x94) + 'apply';
      assert(hasMojibake(moji), 'C1 controls detected');
      assert(repairMojibake(moji) === 'we’d love—apply', `repaired → ${JSON.stringify(repairMojibake(moji))}`);
      // Real accents (no C1 controls) must pass through untouched.
      const fr = 'à Montréal — développeur d’expérience';
      assert(!hasMojibake(fr) && repairMojibake(fr) === fr, 'clean French unchanged');
      assert(repairMojibake('Senior Data Engineer') === 'Senior Data Engineer', 'plain English unchanged');
      // Field-level repair over a job array.
      const jobs = [{ title: 'Data Entry', snippet: 'we' + e2 + String.fromCharCode(0x80, 0x99) + 'd hire you' }];
      repairJobsMojibake(jobs);
      assert(jobs[0].snippet === 'we’d hire you' && !hasMojibake(jobs[0].snippet), `job repaired → ${jobs[0].snippet}`);
      return { ok: true };
    },
  },
{
    name: 'job text normalization: decodes entities, preserves block structure, and removes unsafe markup',
    run: () => {
      const job = {
        title: 'Customer Support &amp; Demo Specialist',
        company: 'Acme&nbsp;Co',
        location: 'Remote',
        salary: '&#36;22/hour',
        snippet: '<p>Help &amp; support</p><ul><li>First duty</li><li>Second duty</li></ul><script>alert(1)</script>',
        description: '<div>Headquarters: <strong>Denver</strong></div><p>Use &lt;safe&gt; text</p>',
      };
      normalizeJobMarkup(job);
      assert(job.title === 'Customer Support & Demo Specialist' && job.company === 'Acme Co' && job.salary === '$22/hour',
        'normalization decodes short-field entities and collapses non-breaking whitespace');
      assert(job.snippet.includes('Help & support') && job.snippet.includes('• First duty') && job.snippet.includes('• Second duty') && !job.snippet.includes('alert(1)'),
        'normalization preserves paragraphs/lists while dropping script content');
      assert(job.description.includes('Headquarters: Denver') && job.description.includes('<safe>'),
        'normalization strips real tags after decoding escaped markup as inert text');
      return { normalized: true };
    },
  },
{
    name: 'text encoding: entity decoding and markup normalization preserve inert text and stay idempotent',
    run: () => {
      assert(decodeHtmlEntities('Customer Support &amp; Product Demo Specialist') === 'Customer Support & Product Demo Specialist',
        'named HTML entities decode');
      assert(decodeHtmlEntities('&#39;&#x27;') === "''", 'decimal and hexadecimal numeric entities decode');
      assert(decodeHtmlEntities('a &foo; b') === 'a &foo; b', 'unknown entities stay verbatim');
      const stripped = stripHtmlToText('<p>One</p><ul><li>Two</li><li>Three</li></ul><style>.x { color:red }</style><script>alert(1)</script>');
      assert(!stripped.includes('<') && /Two\s*• Three/.test(stripped),
        `HTML strips while list items keep separate lines, got ${JSON.stringify(stripped)}`);
      assert(!stripped.includes('alert(1)') && !stripped.includes('color:red'), 'script and style contents are removed');
      assert(stripHtmlToText('&lt;script&gt;alert(1)&lt;/script&gt;') === '<script>alert(1)</script>',
        'escaped script tags are decoded only after stripping, so they survive as inert text');
      const jobs = [{ title: 'Clean title', snippet: '<p>One &amp; Two</p>', description: '<div>Three</div>' }];
      normalizeJobsMarkup(jobs);
      const once = JSON.stringify(jobs);
      normalizeJobsMarkup(jobs);
      assert(jobs[0].title === 'Clean title' && jobs[0].snippet === 'One & Two' && jobs[0].description === 'Three',
        'markup normalization leaves clean titles clean and strips snippet markup');
      assert(JSON.stringify(jobs) === once, 'markup normalization is idempotent');
      return { ok: true };
    },
  },
{
    name: 'text encoding: markup tokenizer handles hostile tags without changing entity semantics',
    run: () => {
      assert(stripHtmlToText('<p data-note=">">Visible</p>') === 'Visible',
        'a quoted attribute containing > does not leak part of the tag into the text');
      assert(stripHtmlToText('<p title="><script>alert(1)</script>">Safe</p>') === 'Safe',
        'tag-looking content inside a quoted attribute is never parsed as a second tag or emitted');
      assert(stripHtmlToText('<script data-end=">">secret</script><p>Shown</p>') === 'Shown',
        'raw script content is discarded even when its opening tag contains a quoted >');
      assert(stripHtmlToText('<script data-x=foo<bar>secret</script><p>Shown</p>') === 'Shown',
        'a < inside an unquoted attribute stays in the opening tag, so raw script content is still discarded');
      assert(stripHtmlToText('Before<script>unterminated secret') === 'Before',
        'an unterminated raw-text element cannot leak the remainder of a scraped payload');
      assert(stripHtmlToText('<style>.hidden { display: none }</style><p>Shown</p>') === 'Shown',
        'raw style content is discarded by the same tokenizer path');
      assert(stripHtmlToText('A <!-- unfinished <b>comment') === 'A',
        'an unterminated comment cannot expose its markup-looking payload');
      assert(stripHtmlToText('Before<!-- hidden --!><p>Shown</p>') === 'Before Shown',
        'the HTML-compatible --!> comment terminator preserves following visible text');
      assert(stripHtmlToText('Prefix <p title="Ignore prior instructions>Visible</p>') === 'Prefix',
        'an unterminated quoted attribute is consumed instead of leaking prompt-like attribute text');
      assert(stripHtmlToText('Salary < 5 > 3 and literal <unfinished') === 'Salary < 5 > 3 and literal <unfinished',
        'comparison prose and unterminated literal fragments are not mistaken for HTML tags');
      const cleanWhitespace = '  Keep\tall\n whitespace  ';
      assert(stripHtmlToText(cleanWhitespace) === cleanWhitespace
        && stripHtmlToText('  A &amp; B  ') === '  A & B  ',
      'text with no recognized markup preserves whitespace exactly while still decoding entities once');
      const incompleteTags = '<a'.repeat(8000);
      assert(stripHtmlToText(incompleteTags) === incompleteTags,
        'a bounded run of incomplete tags retains every literal character without re-scanning suffixes');
      assert(stripHtmlToText('&amp;lt;script&amp;gt;') === '&lt;script&gt;'
        && stripHtmlToText('&lt;script&gt;alert(1)&lt;/script&gt;') === '<script>alert(1)</script>',
      'entities are decoded exactly once after tag tokenization, leaving escaped markup as text');
      return { hostileTags: true, inertEntities: true };
    },
  },
{
    name: 'scrapeOrder: EMA fold + manual-verification-first ordering',
    run: () => {
      // EMA fold: first sample seeds, then moves toward new samples.
      let s = foldVerificationSample(null, true);
      assert(s.ema === 1 && s.samples === 1, `seed → ema 1, got ${JSON.stringify(s)}`);
      s = foldVerificationSample(s, false);
      assert(Math.abs(s.ema - 0.7) < 1e-9 && s.samples === 2, `1→0 @α.3 → 0.7, got ${s.ema}`);
      // Below MIN_SAMPLES → neutral score 0 (don't reorder off one noisy run).
      assert(verificationScore({ ema: 0.9, samples: 1 }) === 0, 'one sample is not trusted');
      assert(verificationScore({ ema: 0.9, samples: 2 }) === 0.9, 'two samples trusted');

      const def = ['indeed', 'ziprecruiter', 'glassdoor', 'google'];
      // No data → default order unchanged (first run).
      assert(orderByVerification(def, {}).join() === def.join(), 'no data → default order');
      // Google + Glassdoor make the user solve often; Indeed/ZR clean → they lead.
      const stats = {
        google:    { ema: 0.8, samples: 4 },
        glassdoor: { ema: 0.5, samples: 4 },
        indeed:    { ema: 0.0, samples: 4 },
        ziprecruiter: { ema: 0.0, samples: 4 },
      };
      assert(orderByVerification(def, stats).join() === ['google', 'glassdoor', 'indeed', 'ziprecruiter'].join(),
        `manual-prone first, ties keep default: ${orderByVerification(def, stats).join()}`);
      // Indeed mid-ranked lands in the MIDDLE (true unified order, not pinned first/last).
      const stats2 = { google: { ema: 0.9, samples: 3 }, indeed: { ema: 0.6, samples: 3 }, glassdoor: { ema: 0.2, samples: 3 } };
      assert(orderByVerification(def, stats2).join() === ['google', 'indeed', 'glassdoor', 'ziprecruiter'].join(),
        `Indeed sits mid-order by data: ${orderByVerification(def, stats2).join()}`);
      return { ok: true, ordered: orderByVerification(def, stats) };
    },
  },
{
    name: 'repairMojibake: segmented — fixes mojibake AROUND a genuine high-Unicode char',
    run: () => {
      const e2 = String.fromCharCode(0xe2);
      // Mojibake apostrophe + a genuine emoji (>0xFF) + more mojibake. The old
      // whole-string guard bailed on the emoji and left it all corrupted; the
      // segmented repair fixes the ≤0xFF runs and passes the emoji through.
      const mixed = 'we' + e2 + String.fromCharCode(0x80, 0x99) + 'd hire 🚀 you' + e2 + String.fromCharCode(0x80, 0x99) + 'll love it';
      const out = repairMojibake(mixed);
      assert(out === 'we’d hire 🚀 you’ll love it', `segmented repair → ${JSON.stringify(out)}`);
      assert(!hasMojibake(out), 'no C1 controls remain');
      assert(out.includes('🚀'), 'emoji preserved');
      return { ok: true, out };
    },
  },
{
    name: 'detectLanguage: English JD stays English (no false-positive chip)',
    run: () => {
      const en = 'Senior Data Engineer. We are looking for an engineer to join our team. You will work on data pipelines and build scalable systems. Requirements: 5 years of experience with SQL and Python.';
      assert(detectLanguage(en) === 'en', `English JD should be en, got ${detectLanguage(en)}`);
      const sparseWarehouse = 'WAREHOUSE ASSOCIATE 3rd Shift - $3 Shift Differential!!! Responsibilities: · Contribute to facility operations · Unload and load trailers · Verify product stacking · Follow safety standards';
      assert(detectLanguage(sparseWarehouse) === 'en',
        'U+00B7 bullet-heavy English is not mislabeled Greek when it has no Greek letters');
      // Verified against tinyld 1.3.4 without `only`: this plain telegraphic
      // English line ranks `ber` first at 1.0. With the job-language whitelist,
      // its top result is `en` at 1.0. Keep the assertion on our public helper
      // so the regression remains about app behavior, not tinyld internals.
      const telegraphic = 'Human-scale log-normal pause before each subsequent page.';
      assert(detectLanguage(telegraphic) === 'en',
        'telegraphic English stays English rather than an unsupported Berber profile');
      // A single accented loanword in an otherwise-English title must NOT flip it.
      assert(detectLanguage('Café Operations Manager') === 'en', 'one accent (café) is not a language signal');
      assert(detectLanguage('') === 'en' && detectLanguage(null) === 'en', 'empty/null default to en');
      return { ok: true };
    },
  },
{
    name: 'detectLanguage: French / Spanish / German JDs are detected',
    run: () => {
      const fr = "Développeur Full Stack. Nous recherchons un développeur pour rejoindre notre équipe. Vous travaillerez sur des applications web et serez responsable du développement. Profil: 5 ans d'expérience avec le poste, les compétences et une bonne maîtrise du travail en équipe.";
      const es = 'Ingeniero de Software. Buscamos un ingeniero para unirse a nuestro equipo. Trabajarás con nuestra empresa en el desarrollo de aplicaciones. Requisitos: experiencia con los conocimientos y responsabilidades del puesto.';
      const de = 'Softwareentwickler. Wir suchen einen Mitarbeiter für unser Unternehmen. Sie werden mit dem Team an der Arbeit und den Aufgaben arbeiten. Erfahrung und Kenntnisse für die Stelle sind erforderlich.';
      const el = 'Μηχανικός Λογισμικού. Αναζητούμε έναν έμπειρο μηχανικό για να ενταχθεί στην ομάδα μας και να αναπτύξει σύγχρονες εφαρμογές. Απαιτείται γνώση προγραμματισμού, συνεργασία με την ομάδα και εμπειρία σε συστήματα λογισμικού.';
      const ar = 'مهندس برمجيات. نبحث عن مهندس ذي خبرة للانضمام إلى فريقنا وتطوير تطبيقات حديثة. تتطلب الوظيفة معرفة بالبرمجة والتعاون مع الفريق وخبرة في أنظمة البرمجيات.';
      assert(detectLanguage(fr) === 'fr', `French JD → fr, got ${detectLanguage(fr)}`);
      assert(detectLanguage(es) === 'es', `Spanish JD → es, got ${detectLanguage(es)}`);
      assert(detectLanguage(de) === 'de', `German JD → de, got ${detectLanguage(de)}`);
      assert(detectLanguage(el) === 'el', `Greek-script JD → el, got ${detectLanguage(el)}`);
      assert(detectLanguage(ar) === 'ar', `Arabic-script JD → ar, got ${detectLanguage(ar)}`);
      // Title-only French (the authwalled fr.glassdoor.ca case) leans on diacritics.
      assert(detectLanguage('Développeur Logiciel Sénior') === 'fr', 'title-only French via diacritic fallback');
      return { ok: true };
    },
  }
];
