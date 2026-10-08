import { assert } from './testHelpers.js';
import { buildJobsPipelineSnapshot, getJobsTelemetry } from '../test-dependencies.js';
import { researchCompensationAssessments } from '../../electron/ipc/jobs.js';
import {
  classifyCompensationLocationGap,
  resolveCompensationLocation,
} from '../../electron/ipc/jobCompensation.js';
import {
  JOB_LOCATION_LOOKUP_MAX_POSTINGS,
  JOB_LOCATION_LOOKUP_TASK,
  __resetJobLocationLookupCacheForTests,
  applyLookedUpLocation,
  buildJobLocationLookupPrompt,
  buildJobLocationLookupRequest,
  classifyOfficialSourceHost,
  companiesAgree,
  evaluateLookupRow,
  jobLocationLookupId,
  locationSourceLink,
  parseJobLocationLookupBatch,
  runJobLocationLookup,
  selectLookupRequests,
  titlesPlausiblyAgree,
} from '../../electron/ipc/jobLocationLookup.js';

const residences = { usa: { country: 'United States', city: 'Austin', subdivision: 'TX' }, canada: { country: 'Canada', city: 'Toronto', subdivision: 'ON' } };

function job(overrides = {}) {
  return {
    title: 'Senior Software Engineer',
    company: 'Acme Robotics',
    location: 'Multiple Locations',
    url: 'https://www.linkedin.com/jobs/view/123',
    salary: 'C$140,000 per year',
    matchScore: 90,
    compensationContext: { roleFamily: 'Software Engineering', seniority: 'senior', employmentType: 'full-time' },
    experienceAssessment: { categorySpecificExperience: [{ requiredMinimumYears: 5 }] },
    ...overrides,
  };
}

const FOUND = {
  result: 'FOUND',
  'source url': 'https://boards.greenhouse.io/acmerobotics/jobs/12345',
  'posting title': 'Senior Software Engineer',
  company: 'Acme Robotics Inc.',
  location: 'Toronto, ON, Canada',
  'work mode': 'onsite',
  'remote country restriction': 'none',
  'evidence quote': 'Location: Toronto, ON, Canada',
};

function section(id, fields) {
  const body = Object.entries(fields).map(([k, v]) => `${k.toUpperCase()}: ${v}`).join('\n');
  return `BEGIN JOB LOCATION LOOKUP ${id}\n${body}\nEND JOB LOCATION LOOKUP ${id}`;
}

function rowFor(overrides = {}) {
  const fields = { ...FOUND, ...overrides };
  return {
    found: true,
    sourceUrl: fields['source url'], postingTitle: fields['posting title'], company: fields.company,
    location: fields.location, workMode: fields['work mode'], remoteCountry: fields['remote country restriction'],
    evidenceQuote: fields['evidence quote'],
  };
}

export default [{
  name: 'Location gap classifier separates what an employer posting can fix from a missing saved residence',
  run: () => {
    const ctx = (over = {}) => ({ workMode: 'unknown', remoteRegion: 'unknown', remoteCountry: '', ...over });
    const cases = [
      ['placeholder listing location', job({ location: 'Multiple Locations' }), ctx(), 'fixable'],
      ['empty listing location', job({ location: '' }), ctx(), 'fixable'],
      ['bare hybrid', job({ location: 'Hybrid' }), ctx(), 'fixable'],
      ['resolvable city', job({ location: 'Toronto, ON, Canada' }), ctx(), null],
      ['bare Remote, no region', job({ location: 'Remote' }), ctx(), 'fixable'],
      ['Remote with a stated country but no saved residence', job({ location: 'Remote - Germany' }), ctx(), 'residence'],
      ['scorer-stated remote with a US region and no US residence', job({ location: '' }), ctx({ workMode: 'remote', remoteRegion: 'usa' }), 'residence'],
    ];
    for (const [label, j, c, want] of cases) {
      const got = classifyCompensationLocationGap(j, c, label.includes('no saved residence') || label.includes('no US residence') ? {} : residences);
      assert(got === want, `${label}: expected ${want}, got ${got}`);
    }
    return { cases: cases.length };
  },
}, {
  name: 'Source host policy: employer and ATS hosts pass, job boards and unrelated hosts do not',
  run: () => {
    const rows = [
      ['boards.greenhouse.io', 'Acme Robotics', 'ats'],
      ['acme-robotics.myworkdayjobs.com', 'Anything', 'ats'],
      ['careers.acmerobotics.com', 'Acme Robotics Inc.', 'employer'],
      ['careers.google.com', 'Google', 'employer'],
      ['careers.monsterenergy.com', 'Monster Energy', 'employer'],
      ['www.linkedin.com', 'Acme Robotics', 'aggregator'],
      ['ca.indeed.com', 'Acme Robotics', 'aggregator'],
      ['indeed.co.uk', 'Acme Robotics', 'aggregator'],
      ['www.glassdoor.ca', 'Acme Robotics', 'aggregator'],
      ['jobs.ziprecruiter.com', 'Acme Robotics', 'aggregator'],
      ['www.monster.com', 'Acme Robotics', 'aggregator'],
      ['careers.acme.co.uk', 'Acme', 'employer'],
      ['acme.evil.com', 'Acme Robotics', 'unrelated'],
      ['acmefake.com', 'Acme Robotics', 'unrelated'],
      ['acme.github.io', 'Acme Robotics', 'unrelated'],
      ['acme.s3.amazonaws.com', 'Acme Robotics', 'unrelated'],
      ['bankrate.com', 'Bank of America', 'unrelated'],
      ['notlinkedin.com.example.org', 'Acme Robotics', 'unrelated'],
      ['random-blog.example.org', 'Acme Robotics', 'unrelated'],
      ['192.168.1.5', 'Acme Robotics', 'invalid'],
      ['localhost', 'Acme Robotics', 'invalid'],
    ];
    for (const [host, company, want] of rows) {
      assert(classifyOfficialSourceHost(host, company) === want, `${host} / ${company} should classify as ${want}, got ${classifyOfficialSourceHost(host, company)}`);
    }
    assert(companiesAgree('Acme Robotics', 'Acme Robotics Inc.') && companiesAgree('Acme', 'ACME, LLC') && companiesAgree('Acme', 'Acme Robotics')
      && !companiesAgree('Go', 'Google') && !companiesAgree('Acme', 'Globex')
      && !companiesAgree('Meta', 'Metabolic Health Inc') && !companiesAgree('Apple', "Applebee's") && !companiesAgree('Block', 'Blockchain Foundation'),
    'company agreement is lenient on suffixes but compares whole words, so a prefix of an unrelated name does not agree');
    assert(titlesPlausiblyAgree('Sr. Software Engineer II', 'Senior Software Engineer II') && titlesPlausiblyAgree('Software Engineer 2', 'Software Engineer II')
      && !titlesPlausiblyAgree('Senior Software Engineer', 'Registered Nurse')
      && !titlesPlausiblyAgree('Senior Software Engineer', 'Junior Software Engineer') && !titlesPlausiblyAgree('Staff Software Engineer', 'Software Engineer Intern')
      && !titlesPlausiblyAgree('Software Engineer II', 'Software Engineer III'),
    'title agreement tolerates abbreviations and word order but requires the level qualifiers to match');
    return { rows: rows.length };
  },
}, {
  name: 'Lookup response parsing is strict on structure and accepts decorated labels',
  run: () => {
    const a = buildJobLocationLookupRequest(job());
    const b = buildJobLocationLookupRequest(job({ title: 'Staff Engineer', url: 'https://example.test/2' }));
    const requests = [a, b];
    const good = `${section(a.id, FOUND)}\n\n${section(b.id, { result: 'NOT FOUND', reason: 'only on a job board' })}`;
    const parsed = parseJobLocationLookupBatch(good, requests);
    assert(parsed.get(a.id).found === true && parsed.get(b.id).found === false, 'FOUND and NOT FOUND rows parse');
    const decorated = good.replace('RESULT: FOUND', '- **RESULT:** FOUND').replace('LOCATION: Toronto', '**LOCATION:** "Toronto');
    assert(parseJobLocationLookupBatch(decorated, requests).get(a.id).found === true, 'bullet/bold decorated labels still parse');

    const bad = {
      'preface text': `Here you go!\n${good}`,
      'missing section': section(a.id, FOUND),
      'unknown id': `${good}\n${section('f'.repeat(24), { result: 'NOT FOUND' })}`,
      'duplicate section': `${good}\n${section(a.id, FOUND)}`,
      'no RESULT line': `${section(a.id, { ...FOUND, result: 'maybe' })}\n${section(b.id, { result: 'NOT FOUND' })}`,
      'FOUND without a URL': `${section(a.id, { ...FOUND, 'source url': '' })}\n${section(b.id, { result: 'NOT FOUND' })}`,
      'nested marker': `BEGIN JOB LOCATION LOOKUP ${a.id}\nBEGIN JOB LOCATION LOOKUP ${b.id}\nEND JOB LOCATION LOOKUP ${a.id}`,
    };
    for (const [label, raw] of Object.entries(bad)) {
      let threw = false;
      try { parseJobLocationLookupBatch(raw, requests); } catch { threw = true; }
      assert(threw, `${label} must be rejected so the handoff asks for a corrected response`);
    }
    return { rejected: Object.keys(bad).length };
  },
}, {
  name: 'Host validation drops untrustworthy rows without throwing and keeps the reason as a bounded enum',
  run: () => {
    const j = job();
    const ok = evaluateLookupRow(rowFor(), j);
    assert(ok.ok && ok.found.display && !ok.found.remote && ok.found.sourceUrl.startsWith('https://boards.greenhouse.io/'), `a clean official-site row is accepted, got ${JSON.stringify(ok)}`);
    const cases = [
      ['aggregator source', { 'source url': 'https://www.linkedin.com/jobs/view/999' }, 'AGGREGATOR_SOURCE'],
      ['unrelated host', { 'source url': 'https://random-blog.example.org/acme' }, 'SOURCE_NOT_OFFICIAL'],
      ['non-http URL', { 'source url': 'ftp://acme.example/jobs/1' }, 'SOURCE_URL_INVALID'],
      ['credentialed URL', { 'source url': 'https://user:pw@boards.greenhouse.io/acme/1' }, 'SOURCE_URL_INVALID'],
      ['company mismatch', { company: 'Globex Corporation' }, 'COMPANY_MISMATCH'],
      ['title mismatch', { 'posting title': 'Registered Nurse' }, 'TITLE_MISMATCH'],
      ['several locations', { location: 'Toronto, ON, Canada | Austin, TX, United States' }, 'LOCATION_AMBIGUOUS'],
      ['evidence does not state the place', { 'evidence quote': 'We are an equal opportunity employer.' }, 'EVIDENCE_DOES_NOT_STATE_LOCATION'],
      ['evidence too short', { 'evidence quote': 'Toronto' }, 'EVIDENCE_TOO_SHORT'],
      ['non-geographic place', { location: 'Various Locations', 'evidence quote': 'Location: Various Locations' }, 'LOCATION_UNPARSEABLE'],
      ['bad work mode', { 'work mode': 'sometimes' }, 'WORK_MODE_INVALID'],
      ['evidence names only the country for a city claim', { 'evidence quote': 'We hire talented people across Canada' }, 'EVIDENCE_DOES_NOT_STATE_LOCATION'],
      ['placeholder that parses as a bare city', { location: 'Several locations', 'evidence quote': 'Location: Several locations' }, 'LOCATION_UNPARSEABLE'],
      ['places joined with or', { location: 'Toronto, ON, Canada or Austin, TX, United States' }, 'LOCATION_AMBIGUOUS'],
      ['places joined with a slash', { location: 'Toronto, ON / Montreal, QC', 'evidence quote': 'Toronto, ON / Montreal, QC' }, 'LOCATION_AMBIGUOUS'],
      ['unrelated host that merely contains the company name', { 'source url': 'https://acme.evil.com/jobs/1' }, 'SOURCE_NOT_OFFICIAL'],
    ];
    for (const [label, over, want] of cases) {
      const verdict = evaluateLookupRow(rowFor(over), j);
      assert(!verdict.ok && verdict.reason === want, `${label}: expected ${want}, got ${JSON.stringify(verdict)}`);
    }
    const remote = evaluateLookupRow(rowFor({ 'work mode': 'remote', location: 'Remote - Canada', 'remote country restriction': 'Canada', 'evidence quote': 'This role is remote within Canada.' }), j);
    assert(remote.ok && remote.found.remote && remote.found.remoteCountry === 'Canada', `a remote row with a stated country is accepted, got ${JSON.stringify(remote)}`);
    const remoteWrongCountry = evaluateLookupRow(rowFor({ 'work mode': 'remote', location: 'Remote', 'remote country restriction': 'United States', 'evidence quote': 'Remote (Canada)' }), j);
    const remoteBareWord = evaluateLookupRow(rowFor({ 'work mode': 'remote', location: 'Remote', 'remote country restriction': 'Canada', 'evidence quote': 'This is a fully remote role' }), j);
    const remoteUsAlias = evaluateLookupRow(rowFor({ 'work mode': 'remote', location: 'Remote', 'remote country restriction': 'United States', 'evidence quote': 'Remote (US)' }), j);
    assert(!remoteWrongCountry.ok && remoteWrongCountry.reason === 'EVIDENCE_DOES_NOT_STATE_LOCATION' && !remoteBareWord.ok && remoteUsAlias.ok,
      'a remote country must be stated by the quote itself (aliases like "US" accepted, the bare word "remote" is not enough)');
    const unknownVsRemote = evaluateLookupRow(rowFor({ 'work mode': 'unknown' }), job({ location: 'Remote', remote: true }));
    assert(!unknownVsRemote.ok && unknownVsRemote.reason === 'WORK_MODE_UNKNOWN', 'an unknown work mode cannot overturn a listing that says Remote');
    const remoteNoCountry = evaluateLookupRow(rowFor({ 'work mode': 'remote', location: 'Remote', 'remote country restriction': 'none', 'evidence quote': 'This role is fully remote.' }), j);
    assert(!remoteNoCountry.ok && remoteNoCountry.reason === 'REMOTE_COUNTRY_MISSING', 'a remote posting that names no country cannot choose a residence');
    return { cases: cases.length };
  },
}, {
  name: 'A looked-up location resolves through copies and never rewrites the scraped card',
  run: () => {
    const j = job();
    const context = { workMode: 'unknown', remoteRegion: 'unknown', remoteCountry: '' };
    assert(resolveCompensationLocation(j, context, residences) === null, 'the scraped placeholder resolves to nothing on its own');
    const verdict = evaluateLookupRow(rowFor(), j);
    const shadow = applyLookedUpLocation(j, context, verdict.found);
    const location = resolveCompensationLocation(shadow.job, shadow.context, residences);
    assert(location?.city === 'Toronto' && location.level === 'city', `the posting's city becomes the comparison location, got ${JSON.stringify(location)}`);
    assert(j.location === 'Multiple Locations' && context.workMode === 'unknown', 'the originals are untouched');

    const remoteVerdict = evaluateLookupRow(rowFor({ 'work mode': 'remote', location: 'Remote - Canada', 'remote country restriction': 'Canada', 'evidence quote': 'Remote within Canada' }), j);
    const remoteJob = job({ location: 'Remote' });
    const remoteShadow = applyLookedUpLocation(remoteJob, { workMode: 'unknown', remoteRegion: 'unknown' }, remoteVerdict.found);
    const remoteLocation = resolveCompensationLocation(remoteShadow.job, remoteShadow.context, residences);
    assert(remoteLocation?.kind === 'remote_canada_residence', `a Canada-restricted remote posting maps to the saved Canada residence, got ${JSON.stringify(remoteLocation)}`);
    assert(resolveCompensationLocation(remoteShadow.job, remoteShadow.context, {}) === null, 'with no saved residence a remote posting still falls back honestly');
    assert(locationSourceLink(verdict.found).url === verdict.found.sourceUrl && locationSourceLink(null) === null, 'provenance link carries the official URL');
    return { city: location.city };
  },
}, {
  name: 'Lookup prompt is deterministic, fenced, bounded and states every rule the host enforces',
  run: () => {
    const reqs = [1, 2, 3].map(n => buildJobLocationLookupRequest(job({ title: `Engineer ${n}`, url: `https://x.test/${n}` })));
    const prompt = buildJobLocationLookupPrompt(reqs);
    const nonce = /untrusted-job-posting-identity-[0-9a-f]{8}/g;
    assert(prompt.replace(nonce, 'N') === buildJobLocationLookupPrompt(reqs).replace(nonce, 'N'), 'prompt is stable apart from the fence nonce');
    for (const phrase of ['SAME posting', 'NOT acceptable sources', 'NOT FOUND is a correct and expected answer', 'separated by " | "', 'verbatim',
      'at least 8 characters', 'city together with its state/province or country', 'never join places with "or"']) {
      assert(prompt.includes(phrase), `prompt must state: ${phrase}`);
    }
    assert(reqs.every(r => prompt.includes(`BEGIN REQUEST ${r.id}`)) && (prompt.match(/untrusted-job-posting-identity-/g) || []).length >= 3, 'every posting is fenced as untrusted data');
    assert(buildJobLocationLookupRequest(job({ company: '' })) === null && buildJobLocationLookupRequest(job({ title: '' })) === null, 'a card with no title or company cannot be looked up');
    assert(jobLocationLookupId(job()) === jobLocationLookupId(job()) && jobLocationLookupId(job()) !== jobLocationLookupId(job({ company: 'Globex' })), 'ids are deterministic and identity-bound');
    const many = Array.from({ length: JOB_LOCATION_LOOKUP_MAX_POSTINGS + 5 }, (_, i) => ({ request: buildJobLocationLookupRequest(job({ title: `Role ${i}`, url: `https://x.test/${i}` })), score: 70 + (i % 20) }));
    const picked = selectLookupRequests(many);
    assert(picked.requests.length === JOB_LOCATION_LOOKUP_MAX_POSTINGS && picked.overflow === 5, 'overflow is capped and counted, never chunked into a second handoff');
    assert(picked.requests.every((r, i, all) => i === 0 || all[i - 1].id < r.id), 'kept postings are sorted by id so the prompt identity is stable');
    return { sent: picked.requests.length };
  },
}, {
  name: 'runJobLocationLookup makes one grounded call, fails closed, and caches an answered batch',
  run: async () => {
    __resetJobLocationLookupCacheForTests();
    const jobs = [job(), job({ title: 'Staff Engineer', url: 'https://x.test/staff' }), job({ title: 'Data Scientist', url: 'https://x.test/ds' })];
    const requests = jobs.map(buildJobLocationLookupRequest);
    const jobsById = new Map(requests.map((r, i) => [r.id, jobs[i]]));
    const calls = [];
    const callRaw = async (prompt, options) => {
      calls.push({ prompt, options });
      return [
        section(requests[0].id, FOUND),
        section(requests[1].id, { ...FOUND, 'source url': 'https://www.indeed.com/viewjob?jk=1', 'posting title': 'Staff Engineer' }),
        section(requests[2].id, { result: 'NOT FOUND' }),
      ].join('\n');
    };
    const run = await runJobLocationLookup({ requests, jobsById, callRaw, signal: { aborted: false }, now: 1000 });
    assert(calls.length === 1 && run.handoffs === 1, 'N postings cost exactly one handoff');
    assert(calls[0].options.task === JOB_LOCATION_LOOKUP_TASK && calls[0].options.grounding === true
      && calls[0].options.hints.itemCount === 3 && typeof calls[0].options.responseValidator === 'function',
    'the call is a grounded, validator-gated batch on the registered research-batch task');
    const outcomes = requests.map(r => run.outcomes.get(r.id));
    assert(outcomes[0].outcome === 'found' && outcomes[1].outcome === 'rejected' && outcomes[1].reason === 'AGGREGATOR_SOURCE' && outcomes[2].outcome === 'not-found',
      `per-row outcomes, got ${JSON.stringify(outcomes)}`);

    const again = await runJobLocationLookup({ requests, jobsById, callRaw, signal: { aborted: false }, now: 2000 });
    assert(calls.length === 1 && again.cacheHit && again.handoffs === 0, 'a fully answered batch is not asked again');
    const later = await runJobLocationLookup({ requests, jobsById, callRaw, signal: { aborted: false }, now: 1000 + 25 * 60 * 60 * 1000 });
    assert(calls.length === 2 && !later.cacheHit, 'misses expire after a day, so a later run asks again');

    __resetJobLocationLookupCacheForTests();
    const thrown = await runJobLocationLookup({ requests, jobsById, callRaw: async () => { throw new Error('transport down'); }, signal: { aborted: false }, now: 1 });
    assert(thrown.failed && !thrown.interrupted && thrown.outcomes.size === 0 && /transport down/.test(thrown.error), 'a transport failure is reported, never swallowed into found data');
    const flipped = { aborted: false };
    const interrupted = await runJobLocationLookup({ requests, jobsById, callRaw: async () => { flipped.aborted = true; throw new Error('Node deleted'); }, signal: flipped, now: 1 });
    assert(interrupted.interrupted && !interrupted.failed, 'a cancelled run is interrupted, not failed');
    const pre = await runJobLocationLookup({ requests, jobsById, callRaw: async () => { throw new Error('must not be called'); }, signal: { aborted: true }, now: 1 });
    assert(pre.interrupted && pre.handoffs === 0, 'an already-aborted run never starts a handoff');
    assert((await runJobLocationLookup({ requests: [], jobsById, callRaw, signal: {} })).handoffs === 0, 'nothing to look up means no call');
    return { calls: calls.length };
  },
}, {
  name: 'Compensation research looks up the employer posting once, then proceeds with the recovered location',
  run: async () => {
    __resetJobLocationLookupCacheForTests();
    const { getJobsTelemetry } = await import('../test-dependencies.js');
    const jobs = [
      job(),
      job({ title: 'Platform Engineer', url: 'https://x.test/platform', location: 'Toronto, ON, Canada' }),
      job({ title: 'Support Engineer', url: 'https://x.test/support', matchScore: 40 }),
      job({ title: 'Remote Engineer', url: 'https://x.test/remote', location: 'Remote - Germany' }),
    ];
    const signal = { aborted: false };
    const calls = [];
    // Flip the signal right after the lookup so the run stops at the role-band
    // prerequisite: this test is about what happens up to and including the
    // location gate, not about the downstream salary research.
    const callRaw = async (prompt, options) => {
      calls.push({ prompt, options });
      const id = buildJobLocationLookupRequest(jobs[0]).id;
      signal.aborted = true;
      return section(id, FOUND);
    };
    await researchCompensationAssessments(jobs, { nodeId: 'location-lookup-integration', signal, remoteResidences: residences, locationLookupCallRaw: callRaw });
    const t = getJobsTelemetry().compensation;
    assert(calls.length === 1 && calls[0].options.hints.itemCount === 1,
      'exactly one lookup, and only for the fit-qualified job with an unusable location (not the resolvable, below-fit or residence-dependent ones)');
    assert(jobs[0].compensationAssessment?.reasonCode === 'research_interrupted'
      && jobs[0].compensationAssessment.comparisonLocation?.city === 'Toronto',
    `the recovered location reaches the card's comparison location, got ${JSON.stringify(jobs[0].compensationAssessment)}`);
    assert(jobs[0].location === 'Multiple Locations', 'the scraped location is preserved on the card');
    assert(t.locationLookup.postings === 1 && t.locationLookup.jobs === 1 && t.locationLookup.handoffs === 1
      && t.locationLookup.resolved === 1 && t.locationLookup.rejected === 0 && t.locationLookup.failed === 0,
    `lookup telemetry reconciles, got ${JSON.stringify(t.locationLookup)}`);
    assert(t.skippedNoLocation === 1 && jobs[3].compensationAssessment?.reasonCode === 'comparison_location_unavailable',
      'a Remote posting that needs a missing saved residence is not sent and keeps its fallback');
    assert(!/employer's own posting/.test(jobs[3].compensationAssessment.justification), 'a job that was never looked up does not claim it was');
    return { resolved: t.locationLookup.resolved };
  },
}, {
  name: 'A failed or unusable lookup leaves the existing fallback and says what was tried',
  run: async () => {
    __resetJobLocationLookupCacheForTests();
    const { getJobsTelemetry } = await import('../test-dependencies.js');
    const jobs = [job(), job({ title: 'Staff Engineer', url: 'https://x.test/staff' })];
    const ids = jobs.map(j => buildJobLocationLookupRequest(j).id);
    const unusable = async () => [
      section(ids[0], { ...FOUND, 'source url': 'https://www.glassdoor.com/job/1' }),
      section(ids[1], { result: 'NOT FOUND' }),
    ].join('\n');
    await researchCompensationAssessments(jobs, { nodeId: 'location-lookup-unusable', signal: { aborted: false }, remoteResidences: residences, locationLookupCallRaw: unusable });
    let t = getJobsTelemetry().compensation;
    assert(jobs.every(j => j.compensationAssessment?.reasonCode === 'comparison_location_unavailable'
      && /search for the employer's own posting did not return a location/.test(j.compensationAssessment.justification)),
    'rejected and not-found jobs keep comparison_location_unavailable with an observation, not a diagnosis');
    assert(t.locationLookup.rejected === 1 && t.locationLookup.notFound === 1 && t.locationLookup.resolved === 0
      && t.locationLookup.rejectionReasons.AGGREGATOR_SOURCE === 1 && t.skippedNoLocation === 2,
    `counts reconcile, got ${JSON.stringify(t.locationLookup)}`);

    __resetJobLocationLookupCacheForTests();
    const failing = [job(), job({ title: 'Staff Engineer', url: 'https://x.test/staff' })];
    await researchCompensationAssessments(failing, { nodeId: 'location-lookup-failed', signal: { aborted: false }, remoteResidences: residences, locationLookupCallRaw: async () => { throw new Error('boom'); } });
    t = getJobsTelemetry().compensation;
    assert(failing.every(j => j.compensationAssessment?.reasonCode === 'comparison_location_unavailable')
      && t.locationLookup.failed === 2 && t.locationLookup.handoffs === 1 && t.skippedNoLocation === 2,
    `a thrown lookup fails every sent job closed, got ${JSON.stringify(t.locationLookup)}`);
    return { failed: t.locationLookup.failed };
  },
}, {
  name: 'Both assessment builders reserve a display slot for the location provenance link',
  run: async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../../electron/ipc/jobs.js', import.meta.url), 'utf8');
    assert(source.split('item.locationSource ? 4 : 5').length === 3 && source.split('locationLink ? [...links, locationLink] : links').length === 3,
      'the batch and per-cohort builders must each cap salary evidence at 4 and append the location link, so the verdict set equals the displayed set');
    return { builders: 2 };
  },
}, {
  name: 'Bug report renders the lookup as counts and enum codes only, and old telemetry still renders',
  run: () => {
    const telemetry = getJobsTelemetry();
    const saved = {
      nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search, pipeline: telemetry.pipeline,
      resolves: telemetry.resolves, scoring: telemetry.scoring, bucketing: telemetry.bucketing, compensation: telemetry.compensation, history: telemetry.history,
    };
    const base = {
      ts: Date.now(), scoredInput: 12, skippedBelowFit: 4, eligible: 8, minFitScore: 70, skippedNoLocation: 2, skippedNoCurrency: 0,
      preResearchCandidates: 6, skippedNoExperience: 0, skippedNoExperienceBand: 0, roleBandLookups: 1, roleBandResearches: 1, roleBandCacheHits: 0,
      roleBandFailures: 0, roleBandFailureJobs: 0, roleBandInterruptedJobs: 0, marketCandidates: 6, missingOffer: 0, recommendedNoOffer: 0,
      cohorts: 1, researched: 1, failedCohorts: 0, assessed: 6, cacheHits: 0, failures: [],
    };
    const render = (compensation) => {
      Object.assign(telemetry, { nodeId: 'lookup-report', windowId: null, search: null, pipeline: null, resolves: {}, scoring: null, bucketing: null, history: null, compensation });
      return buildJobsPipelineSnapshot(new Set(['lookup-report']), null, null);
    };
    try {
      const withLookup = render({
        ...base,
        locationLookup: {
          postings: 4, jobs: 5, handoffs: 1, cacheHit: false, overflowPostings: 1, noIdentityJobs: 0,
          resolved: 3, foundUnresolved: 0, rejected: 1, notFound: 1, failed: 0, interrupted: 0,
          rejectionReasons: { AGGREGATOR_SOURCE: 1, 'https://evil.example/Acme Corp': 9 }, error: 'https://secret.example/acme-robotics-senior-engineer',
        },
      });
      assert(withLookup.includes('Employer-posting location lookup: 5 job(s) / 4 posting(s) sent in 1 handoff(s) → 3 now have a comparison location, 0 found a posting but still no market location, 1 rejected by host checks, 1 not found, 0 failed, 0 interrupted.')
        && withLookup.includes('host-check rejections: AGGREGATOR_SOURCE=1')
        && withLookup.includes('1 further posting(s) were not sent'),
      'the lookup line states observations and bounded enum reasons');
      assert(!withLookup.includes('evil.example') && !withLookup.includes('secret.example') && !withLookup.includes('Acme'),
        'no URL, title or company (including a hostile reason key or the raw error) reaches the report');
      const without = render(base);
      assert(!without.includes('Employer-posting location lookup') && !/undefined|NaN/.test(without.split('### Competitive salary check')[1] || ''),
        'telemetry recorded before the lookup existed renders unchanged');
      const idle = render({ ...base, locationLookup: { postings: 0, jobs: 0, handoffs: 0, noIdentityJobs: 0 } });
      assert(idle.includes('Employer-posting location lookup: no posting was sent.'), 'an idle lookup says nothing was sent');
    } finally {
      Object.assign(telemetry, saved);
    }
    return { ok: true };
  },
}];
