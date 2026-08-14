import { LOCATION_TREATMENT, PLATFORM_AUTH_COOKIES, assert, decodeHtmlEntities, deriveLocationParam, detectLanguage, foldVerificationSample, getSellMonitorConfig, hasMojibake, indeedHostForLocation, normalizeJobMarkup, normalizeJobsMarkup, orderByVerification, pickGlassdoorLocation, repairJobsMojibake, repairMojibake, stripHtmlToText, summarizeLocationAdherence, verificationScore } from '../test-dependencies.js';

export default [
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
    // The query LLM now returns a STRUCTURED location object so a board's location
    // FILTER never receives prose. deriveLocationParam flattens it deterministically
    // into the "City, ST" string actually sent to USAJobs/Dice/Indeed/ZR/Glassdoor/LinkedIn.
    name: 'deriveLocationParam: structured canonical → board-ready string (typo-corrected)',
    run: () => {
      // "denvr" → corrected structured object → clean "Denver, CO".
      assert(deriveLocationParam({ city: 'Denver', stateCode: 'CO', region: '', country: 'United States', isRemote: false, display: 'Denver, CO' }) === 'Denver, CO', 'city+state → "City, ST"');
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
