import assert from 'node:assert/strict';
import {
  careersPageEmployerFromTitle, classifyOfficialSourceHost, extractAtsTenant, isAggregatorHost, isKnownAtsHost,
  proveEmployerDomain, strictEmployerEqual,
} from '../../electron/ipc/officialSourceHosts.js';
import {
  coreTitle, descriptionOverlap, evaluateOfficialPostingMatch, frozenOfficialEmployer,
  locationsCompatible, posterEmployerSignals, resolveScrapedEmployer,
  selectOfficialPostingMatch, verifiedTieBreakerMatch,
} from '../../electron/ipc/officialPostingMatch.js';

const EMPLOYER = 'Northwind Labs';
const DESCRIPTION = 'Design reliable ledger reconciliation services for regional dispatch teams. '
  + 'Build clear operational dashboards that explain every record correction to reviewers. '
  + 'Partner with engineers and service owners to sequence dependent release changes. '
  + 'Maintain repeatable migration checks and diagnose incomplete loads during weekly operations. '
  + 'Document interface contracts and improve the audit trail for nightly exports. '
  + 'Help colleagues investigate delayed work and keep the intake queues moving.';
const row = extra => ({ title: 'Senior Software Engineer', company: EMPLOYER, location: 'Toronto, ON, Canada',
  salary: 'CAD 120,000-150,000', salaryProvenance: 'posted', snippet: DESCRIPTION, url: 'https://board.example/job/1', ...extra });
const candidate = extra => ({ title: 'Senior Software Engineer', employer: EMPLOYER, location: { display: 'Toronto, Ontario, Canada', workMode: 'hybrid', remote: false },
  salary: { text: 'CAD 120k-150k', provenance: 'posted' }, description: DESCRIPTION,
  sourceUrl: 'https://jobs.ashbyhq.com/northwind/posting-one', tenant: 'northwind', ats: 'ashby', tenantProven: true,
  statusCode: 200, live: true, ...extra });
const NOW = Date.parse('2026-10-24T00:00:00Z');
const evaluate = (scraped = row(), official = candidate(), options = {}) => evaluateOfficialPostingMatch(scraped, official, { now: NOW, ...options });

export default [
  {
    name: 'Official posting hosts: mirrors remain aggregators and USAJobs is official',
    run() {
      for (const host of ['www.bebee.com', 'ca.trabajo.org', 'jobright.ai', 'www.careerbeacon.com', 'ca.indeed.com']) assert.equal(isAggregatorHost(host), true, host);
      assert.equal(isAggregatorHost('usajobs.gov'), false);
      assert.equal(classifyOfficialSourceHost('www.usajobs.gov', 'Federal Agency'), 'official');
      assert.equal(isKnownAtsHost('recruiting.adp.com'), true);
      assert.equal(isKnownAtsHost('tenant.oraclecloud.com'), true);
      assert.equal(isAggregatorHost('notjobright.ai.example'), false);
    },
  },
  {
    name: 'Official posting hosts: tenant extraction preserves vendor namespaces and custom Teamtailor proof',
    run() {
      for (const [url, ats, tenant] of [
        ['https://jobs.ashbyhq.com/northwind/123', 'ashby', 'northwind'],
        ['https://boards.greenhouse.io/northwind/jobs/123', 'greenhouse', 'northwind'],
        ['https://job-boards.greenhouse.io/northwind/jobs/123', 'greenhouse', 'northwind'],
        ['https://boards.greenhouse.io/embed/job_board/js?for=northwind', 'greenhouse', 'northwind'],
        ['https://boards.greenhouse.io/embed/job_board?for=northwind', 'greenhouse', 'northwind'],
        ['https://jobs.lever.co/northwind/123', 'lever', 'northwind'],
        ['https://northwind.wd5.myworkdayjobs.com/External/job/123', 'workday', 'northwind/External'],
        ['https://northwind.wd5.myworkdayjobs.com/en-US/External/job/123', 'workday', 'northwind/External'],
        ['https://northwind.wd5.myworkdayjobs.com/fr-CA/External/job/123', 'workday', 'northwind/External'],
      ]) assert.deepEqual(extractAtsTenant(url), { ats, tenant });
      assert.deepEqual(extractAtsTenant('https://careers.northwind.example/', { html: '<script src="https://cdn.teamtailor-cdn.com/app.js"></script>' }), { ats: 'teamtailor', tenant: 'careers.northwind.example' });
      for (const html of [
        '<script src="https://assets-aws.teamtailor-cdn.com/assets/careersite.js"></script>',
        '<link rel="stylesheet" href="https://assets-aws.teamtailor-cdn.com/assets/careersite.css">',
        '<script src="//cdn2.teamtailor-cdn.com/assets/careersite.js"></script>',
        '<footer>Powered by <a href="https://www.teamtailor.com/">Teamtailor</a></footer>',
      ]) assert.deepEqual(extractAtsTenant('https://careers.northwind.example/jobs/123', { html }), { ats: 'teamtailor', tenant: 'careers.northwind.example' });
      for (const html of [
        '<script src="https://assets-aws.teamtailor-cdn.com.evil.test/assets/app.js"></script>',
        '<script src="https://notassets-aws.teamtailor-cdn.com/assets/app.js"></script>',
        '<script src="https://assets-aws.teamtailor-cdn.com@evil.test/assets/app.js"></script>',
        '<script src="https://evil.test/?url=https://assets-aws.teamtailor-cdn.com/assets/app.js"></script>',
        '<script src="http://assets-aws.teamtailor-cdn.com/assets/app.js"></script>',
        '<script data-src="https://assets-aws.teamtailor-cdn.com/assets/app.js"></script>',
        '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><script xlink:src="https://assets-aws.teamtailor-cdn.com/assets/app.js"></script><link xlink:href="https://assets-aws.teamtailor-cdn.com/assets/app.css"></link></svg>',
        '<svg><script src="https://assets-aws.teamtailor-cdn.com/assets/app.js"></script></svg>',
        '<script>const text = "https://assets-aws.teamtailor-cdn.com/assets/app.js";</script>',
        '<!-- <script src="https://assets-aws.teamtailor-cdn.com/assets/app.js"></script> -->',
        '<p>https://assets-aws.teamtailor-cdn.com/assets/app.js</p>',
        '<footer>Powered by Teamtailorish</footer>',
      ]) assert.equal(extractAtsTenant('https://careers.northwind.example/jobs/123', { html }), null, html);
      assert.equal(extractAtsTenant('https://jobs.ashbyhq.com/'), null);
      assert.equal(extractAtsTenant('https://boards.greenhouse.io/embed/job_board?for=northwind%2Fother'), null);
      assert.equal(extractAtsTenant('https://boards.greenhouse.io/embed/job_board?for='), null);
      assert.equal(extractAtsTenant('https://boards.greenhouse.io/embed/job_board?for=..'), null);
      assert.equal(extractAtsTenant('https://boards.greenhouse.io/embed/job_board?for=northwind&for=other'), null);
      assert.equal(extractAtsTenant('https://boards.greenhouse.io/embed/other?for=northwind'), null);
      assert.equal(extractAtsTenant('https://boards.greenhouse.io/northwind/jobs/123?for=unrelated').tenant, 'northwind');
      assert.equal(extractAtsTenant('https://northwind.wd5.myworkdayjobs.com/en-US/'), null);
      assert.equal(extractAtsTenant('https://northwind.wd5.myworkdayjobs.com/en-US/job/123'), null);
      assert.equal(extractAtsTenant('https://linkedin.com/jobs/northwind'), null);
    },
  },
  {
    name: 'Official posting hosts: custom Teamtailor detection handles bounded flat pages and requires a real resource attribute',
    run() {
      const flat = `${'<i></i>'.repeat(150000)}<script src="https://assets-aws.teamtailor-cdn.com/assets/careersite.js"></script>`;
      assert.ok(Buffer.byteLength(flat) < 3 * 1024 * 1024);
      assert.deepEqual(extractAtsTenant('https://careers.northwind.example/', { html: flat }), { ats: 'teamtailor', tenant: 'careers.northwind.example' });
      for (const html of ['<script></script>', '<script src=""></script>', '<link rel="stylesheet">', '<iframe></iframe>']) {
        assert.equal(extractAtsTenant('https://assets-aws.teamtailor-cdn.com/', { html }), null, html);
      }
    },
  },
  {
    name: 'Official posting hosts: employer domain proof never uses a name prefix or self-asserted sameAs',
    run() {
      assert.equal(strictEmployerEqual('Northwind Labs, Inc.', 'NORTHWIND LABS'), true);
      assert.equal(strictEmployerEqual('Northwind Labs', 'Northwind Labs Consulting'), false);
      assert.equal(strictEmployerEqual('A & B, LLC', 'a and b'), true);
      assert.equal(classifyOfficialSourceHost('careers.northwind.example', EMPLOYER), 'unrelated');
      assert.equal(proveEmployerDomain({ domain: 'northwind.example', employer: EMPLOYER, rootSiteName: 'Northwind' }), false);
      assert.equal(proveEmployerDomain({ domain: 'northwind.example', employer: EMPLOYER, rootTitle: EMPLOYER }), true);
      assert.equal(proveEmployerDomain({ domain: 'northwind.example', employer: EMPLOYER, rootTitle: `${EMPLOYER} | Marketing copy` }), false, 'root title proof compares the whole title');
      assert.equal(careersPageEmployerFromTitle(`Careers at ${EMPLOYER} | Build the future`), EMPLOYER);
      assert.equal(careersPageEmployerFromTitle(`Careers at ${EMPLOYER}`), EMPLOYER);
      assert.equal(careersPageEmployerFromTitle(`${EMPLOYER} | Careers and marketing`), '');
      assert.equal(careersPageEmployerFromTitle(`Stories about Careers at ${EMPLOYER}`), '');
      assert.equal(careersPageEmployerFromTitle(`Careers at Other Labs | ${EMPLOYER}`), 'Other Labs');
      const attestation = { domain: 'northwind.example', employer: EMPLOYER, sameAs: 'https://northwind.example/', postingUrl: 'https://northwind.example/jobs/1' };
      assert.equal(proveEmployerDomain(attestation), false);
      assert.equal(proveEmployerDomain({ ...attestation, postingUrl: 'https://jobs.ashbyhq.com/northwind/123' }), true);
      assert.equal(proveEmployerDomain({ ...attestation, domain: 'linkedin.com', rootTitle: EMPLOYER }), false);
      assert.equal(proveEmployerDomain({ ...attestation, poster: 'Acme Talent', posterDomain: 'northwind.example', rootTitle: EMPLOYER }), false);
      const careers = { domain: 'northwind.example', employer: EMPLOYER, careersPageUrl: 'https://northwind.example/careers', careersPageEmployer: EMPLOYER,
        careersLinks: ['https://jobs.ashbyhq.com/northwind'], postingUrl: 'https://jobs.ashbyhq.com/northwind/123' };
      assert.equal(proveEmployerDomain(careers), true);
      assert.equal(proveEmployerDomain({ ...careers, careersPageEmployer: 'Northwind Consulting' }), false);
      assert.equal(proveEmployerDomain({ ...careers, careersLinks: ['https://jobs.ashbyhq.com/another-tenant'] }), false);
    },
  },
  {
    name: 'Official posting matching: core titles normalize presentation while retaining sibling and level identity',
    run() {
      assert.equal(coreTitle('Sr. Software Eng. at Northwind Labs'), 'senior software engineer');
      assert.equal(coreTitle('Sr. Software Eng. - CAD 120k-150k + equity'), 'senior software engineer');
      assert.equal(coreTitle('Senior Software Engineer (Hybrid) - Toronto, ON', { location: 'Toronto, ON' }), 'senior software engineer');
      assert.equal(coreTitle('Senior Software Engineer - Toronto', { location: 'Toronto, ON, Canada' }), 'senior software engineer');
      assert.equal(coreTitle('Jr. Front End Dev.'), 'junior front end developer');
      assert.notEqual(coreTitle('Software Engineer'), coreTitle('Forward Deployed Engineer'));
      assert.notEqual(coreTitle('Senior Software Engineer'), coreTitle('Staff Software Engineer'));
      assert.notEqual(coreTitle('Software Engineer II'), coreTitle('Software Engineer III'));
    },
  },
  {
    name: 'Official posting matching: canonical city, region, country and remote constraints reject twins',
    run() {
      assert.equal(locationsCompatible(row(), candidate()), true);
      assert.equal(locationsCompatible(row(), candidate({ location: { display: 'Austin, TX, United States' } })), false);
      assert.equal(locationsCompatible(row({ location: 'Toronto, ON, Canada' }), candidate({ location: { display: 'Toronto, OH, United States' } })), false);
      assert.equal(locationsCompatible(row(), candidate({ location: { display: 'Montreal, QC, Canada | Toronto, ON, Canada' } })), true);
      assert.equal(locationsCompatible(row({ location: 'Ontario, Canada' }), candidate()), false);
      assert.equal(locationsCompatible(row({ location: 'Ontario, Canada' }), candidate({ location: { display: 'ON, Canada' } })), true);
      assert.equal(locationsCompatible(row({ location: 'Lakeview, Ontario, Canada' }), candidate({ location: { display: 'Canada' } })), false);
      assert.equal(locationsCompatible(row({ location: 'Canada' }), candidate({ location: { display: 'Lakeview, Ontario, Canada' } })), false);
      assert.equal(locationsCompatible(row({ location: 'Ontario, Canada' }), candidate({ location: { display: 'Canada' } })), false);
      assert.equal(locationsCompatible(row({ location: 'Lakeview' }), candidate({ location: { display: 'Lakeview, Ontario, Canada' } })), true);
      assert.equal(evaluate(row({ location: 'Lakeview, Ontario, Canada' }), candidate({ location: { display: 'Canada' } })).reason, 'location-mismatch', 'posted salary cannot anchor away a missing city');
      assert.equal(locationsCompatible(row({ location: 'Remote - Canada', remote: true }), candidate({ location: { display: '', remote: true, remoteCountry: 'Canada' } })), true);
      assert.equal(locationsCompatible(row({ location: 'Remote - Canada', remote: true }), candidate({ location: { display: '', remote: true, remoteCountry: 'United States' } })), false);
      assert.equal(locationsCompatible(row({ location: 'Remote' }), candidate({ location: { display: '', remote: true, remoteCountry: 'Canada' } })), false);
      assert.equal(locationsCompatible(row({ location: 'Multiple Locations' }), candidate()), false);
    },
  },
  {
    name: 'Official posting matching: same-band siblings, city twins, wrong employers, poster tenants and closed jobs fail hard gates',
    run() {
      assert.equal(evaluate().passed, true);
      for (const [overrides, reason] of [
        [{ title: 'Forward Deployed Engineer' }, 'title-mismatch'],
        [{ location: { display: 'Vancouver, BC, Canada' } }, 'location-mismatch'],
        [{ employer: 'Northwind Labs Consulting' }, 'employer-mismatch'],
        [{ tenantProven: false }, 'tenant-unproven'],
        [{ posterTenant: true }, 'poster-tenant'],
        [{ validThrough: '2026-10-23T23:59:59Z' }, 'closed'],
        [{ live: false, statusCode: 404 }, 'closed'],
      ]) assert.equal(evaluate(row(), candidate(overrides)).reason, reason);
      assert.equal(evaluate(row(), candidate({ sourceUrl: 'https://jobs.linkedin.com/123' })).reason, 'unsafe-url');
    },
  },
  {
    name: 'Official posting matching: official government portal proof is exact to host, job route and agency',
    run() {
      const agency = 'Federal Research Agency';
      const scraped = row({ company: agency });
      const portal = candidate({ employer: agency, sourceUrl: 'https://www.usajobs.gov/job/12345678',
        ats: '', tenant: '', tenantProven: false, employerDomainProven: false, officialPortalProven: true });
      assert.equal(evaluate(scraped, portal).anchor, 'salary-anchor');
      for (const overrides of [
        { sourceUrl: 'https://usajobs.gov.example/job/12345678' },
        { sourceUrl: 'https://agency.usajobs.gov/job/12345678' },
        { sourceUrl: 'https://www.usajobs.gov/job/not-an-id' },
        { sourceUrl: 'https://www.usajobs.gov/jobs/12345678' },
        { officialPortalProven: false },
      ]) assert.equal(evaluate(scraped, { ...portal, ...overrides }).reason, 'tenant-unproven');
      assert.equal(evaluate(scraped, { ...portal, employer: 'Different Federal Agency' }, { employerHypotheses: ['Different Federal Agency'] }).reason, 'tenant-unproven');
      assert.equal(evaluate(scraped, { ...portal, title: 'Staff Software Engineer' }).reason, 'title-mismatch');
      assert.equal(evaluate(scraped, { ...portal, salary: { text: 'CAD 130k-160k', provenance: 'posted' } }).reason, 'salary-mismatch');
    },
  },
  {
    name: 'Official posting matching: only posted salary anchors or vetoes and units and currencies stay exact',
    run() {
      const noOverlap = { description: 'This separate posting contains a wholly different set of responsibilities and requirements.' };
      assert.equal(evaluate(row(), candidate(noOverlap)).anchor, 'salary-anchor');
      assert.equal(evaluate(row({ salary: 'USD 120k-150k' }), candidate({ ...noOverlap, salary: { text: 'USD 120000-150000', provenance: 'posted' } })).anchor, 'salary-anchor');
      assert.equal(evaluate(row({ salary: '$120000-150000' }), candidate(noOverlap)).reason, 'no-anchor', 'a Canadian city cannot establish the currency of a bare dollar sign');
      assert.equal(evaluate(row(), candidate({ ...noOverlap, salary: { text: '$120000-150000', provenance: 'posted' } })).reason, 'no-anchor', 'the official offer also needs an explicit currency');
      assert.equal(evaluate(row({ salary: '$90000-100000', identifier: 'REQ-42' }), candidate({ ...noOverlap, identifier: 'REQ-42' })).anchor, 'identifier-anchor', 'unknown currency cannot veto an independent identifier anchor');
      assert.equal(evaluate(row({ identifier: 'REQ-42' }), candidate({ ...noOverlap, identifier: 'REQ-42', salary: { text: '$90000-100000', provenance: 'posted' } })).anchor, 'identifier-anchor');
      assert.equal(evaluate(row({ salary: '$90000-100000' }), candidate()).anchor, 'description-anchor', 'unknown currency cannot veto independently anchored text');
      assert.equal(evaluate(row({ salaryProvenance: 'estimated' }), candidate(noOverlap)).reason, 'no-anchor');
      assert.equal(evaluate(row({ salaryProvenance: undefined }), candidate({ ...noOverlap, salary: { text: 'CAD 10k-20k', provenance: 'posted' } })).reason, 'no-anchor');
      assert.equal(evaluate(row(), candidate({ salary: { text: 'CAD 130k-160k', provenance: 'posted' } })).reason, 'salary-mismatch');
      assert.equal(evaluate(row(), candidate({ salary: { text: 'USD 120k-150k', provenance: 'posted' } })).reason, 'salary-mismatch');
      assert.equal(evaluate(row({ salary: 'CAD 104000', snippet: 'Full time', salaryProvenance: 'posted' }), candidate({ ...noOverlap, salary: { text: 'CAD 50 per hour', provenance: 'posted' }, snippet: 'Full time' })).reason, 'salary-mismatch');
      assert.equal(evaluate(row({ salaryProvenance: 'estimated', identifier: 'REQ-42' }), candidate({ ...noOverlap, identifier: { value: 'REQ-42' } })).anchor, 'identifier-anchor');
      assert.equal(evaluate(row({ salaryProvenance: 'unknown' }), candidate({ salary: { text: '', provenance: 'unknown' } })).anchor, 'description-anchor');
      assert.equal(descriptionOverlap('We seek qualified applicants.', 'We seek qualified applicants.').anchored, false);
    },
  },
  {
    name: 'Official posting matching: quotation verifier requires three verbatim long pairs across distinct parts',
    run() {
      const quotes = DESCRIPTION.split(/(?<=\.)\s+/u).filter(Boolean);
      const answer = { sameJob: true, matchingPairs: [quotes[0], quotes[2], quotes[4]].map(quote => ({ scrapedQuote: quote, officialQuote: quote })), conflicts: [] };
      assert.equal(verifiedTieBreakerMatch(DESCRIPTION, DESCRIPTION, answer), true);
      assert.equal(verifiedTieBreakerMatch(DESCRIPTION, DESCRIPTION, { ...answer, matchingPairs: answer.matchingPairs.slice(0, 2) }), false);
      assert.equal(verifiedTieBreakerMatch(DESCRIPTION, DESCRIPTION, { ...answer, matchingPairs: answer.matchingPairs.map(pair => ({ ...pair, officialQuote: 'Invented wording that never occurs in the fetched official description text.' })) }), false);
      assert.equal(verifiedTieBreakerMatch(DESCRIPTION, DESCRIPTION, { ...answer, conflicts: ['different team'] }), false);
      assert.equal(verifiedTieBreakerMatch(DESCRIPTION, DESCRIPTION, { ...answer, matchingPairs: [answer.matchingPairs[0], answer.matchingPairs[0], answer.matchingPairs[0]] }), false);
      const filler = 'A distinct application-specific narrative describes entirely separate day to day work and planning priorities. ';
      const officialText = `${quotes[0]} ${filler.repeat(2)} ${quotes[2]} ${filler.repeat(2)} ${quotes[4]}`;
      const noAnchor = candidate({ salary: { text: '', provenance: 'unknown' }, description: officialText });
      assert.equal(descriptionOverlap(DESCRIPTION, officialText).anchored, false);
      const result = evaluate(row({ salaryProvenance: 'unknown' }), noAnchor, { tieBreaker: answer });
      assert.equal(result.anchor, 'quoted-match');
    },
  },
  {
    name: 'Official posting matching: unique decisions preserve ambiguity and refuse unanchored evergreen postings',
    run() {
      assert.equal(selectOfficialPostingMatch(row(), [candidate()], { now: NOW }).outcome, 'found');
      const twins = [candidate({ sourceUrl: 'https://jobs.ashbyhq.com/northwind/alpha', team: 'Ledger' }), candidate({ sourceUrl: 'https://jobs.ashbyhq.com/northwind/beta', team: 'Intake' })];
      assert.equal(selectOfficialPostingMatch(row(), twins, { now: NOW }).outcome, 'ambiguous');
      const noAnchor = { salary: { text: '', provenance: 'unknown' }, description: 'Evergreen expression of interest for future openings.' };
      assert.equal(selectOfficialPostingMatch(row({ salaryProvenance: 'unknown' }), [candidate(noAnchor)], { now: NOW }).outcome, 'not-found');
      const unanchoredTwins = twins.map(item => ({ ...item, ...noAnchor }));
      const ambiguity = selectOfficialPostingMatch(row({ salaryProvenance: 'unknown' }), unanchoredTwins, { now: NOW });
      assert.equal(ambiguity.outcome, 'ambiguous');
      assert.equal(ambiguity.candidate, null);
      assert.equal(ambiguity.alternatives.length, 2);
    },
  },
  {
    name: 'Official posting signals: independent corroboration distinguishes poster from employer without a recruiter blocklist',
    run() {
      const recruiter = row({ title: 'Senior Software Engineer at Northwind Labs', company: 'Acme Talent Partners',
        snippet: 'We are hiring for our client. Company Description Northwind Labs is a technology company.',
        url: 'https://www.linkedin.com/jobs/view/senior-software-engineer-at-northwind-labs-at-acme-talent-partners-123456' });
      const signals = posterEmployerSignals(recruiter);
      assert.equal(signals.strongCount, 1);
      assert.equal(signals.S3, true);
      assert.equal(signals.S4[0], EMPLOYER);
      assert.equal(posterEmployerSignals({ ...recruiter, url: 'https://www.linkedin.com/jobs/view/software-engineer-at-acme-talent-partners-at-northwind-labs-123456' }).S2, 'northwind labs');
      assert.equal(resolveScrapedEmployer(recruiter).employer, EMPLOYER);
      assert.equal(resolveScrapedEmployer(recruiter).level, 'L5');
      assert.equal(resolveScrapedEmployer({ ...recruiter, snippet: 'We are hiring for our client.' }).level, 'L6');
      assert.equal(resolveScrapedEmployer({ ...recruiter, title: 'Senior Software Engineer', url: 'https://board.example/job/1' }).level, 'L6');
      assert.equal(resolveScrapedEmployer(row({ snippet: 'Build reliable services for the dispatch team.' })).employer, EMPLOYER);
      assert.equal(evaluate(recruiter, candidate()).passed, true, 'an official strict hypothesis match can verify a recruiter posting');
      assert.equal(evaluate(recruiter, candidate({ employer: 'Acme Talent Partners', sourceUrl: 'https://jobs.ashbyhq.com/acme-talent/123', tenant: 'acme-talent' })).reason, 'poster-tenant');
      const unnamedClient = { ...recruiter, title: 'Senior Software Engineer', url: 'https://board.example/job/1', snippet: 'We are hiring for our client.' };
      assert.equal(evaluate(unnamedClient, candidate()).reason, 'employer-mismatch');
      assert.equal(evaluate(unnamedClient, candidate(), { employerHypotheses: [EMPLOYER] }).passed, true);
      assert.equal(evaluate(unnamedClient, candidate({ tenantProven: false }), { employerHypotheses: [EMPLOYER] }).reason, 'tenant-unproven');
      assert.equal(evaluate(unnamedClient, candidate({ employer: 'Acme Talent Partners', sourceUrl: 'https://jobs.ashbyhq.com/acme-talent/123', tenant: 'acme-talent' })).reason, 'poster-tenant');
      const school = { title: 'Teacher at Birch Elementary School', company: 'Birch School District',
        snippet: 'Birch Elementary School is part of Birch School District. Teach classroom lessons.' };
      assert.equal(posterEmployerSignals(school).pointsAway, false);
      assert.equal(resolveScrapedEmployer(school).level, 'L5');
      assert.equal(resolveScrapedEmployer(school).employer, 'Birch School District');
    },
  },
  {
    name: 'Official posting signals: company headings stay separate from organization subjects',
    run() {
      for (const separator of ['\n\n', '\r\n\r\n']) {
        const own = row({ snippet: `${EMPLOYER}${separator}${EMPLOYER} is a technology company. Build reliable services.` });
        assert.deepEqual(posterEmployerSignals(own).S4, []);
        assert.equal(posterEmployerSignals(own).pointsAway, false);
        assert.equal(resolveScrapedEmployer(own).employer, EMPLOYER);
        assert.equal(evaluate(own, candidate()).passed, true);
        const other = row({ company: 'Acme Talent Partners',
          snippet: `Acme Talent Partners${separator}${EMPLOYER} is a technology company. Build reliable services.` });
        assert.deepEqual(posterEmployerSignals(other).S4, [EMPLOYER]);
        assert.equal(resolveScrapedEmployer(other).level, 'L6');
      }
      assert.deepEqual(posterEmployerSignals(row({ company: 'Acme Talent Partners',
        snippet: `Company Description\n${EMPLOYER} is a technology company.` })).S4, [EMPLOYER]);
      assert.deepEqual(posterEmployerSignals(row({ company: 'Acme Talent Partners',
        snippet: `About this role. ${EMPLOYER} is a technology company.` })).S4, [EMPLOYER]);
    },
  },
  {
    name: 'Official posting employer freezing retains strict own spelling and rejects unsafe verified names',
    run() {
      assert.equal(frozenOfficialEmployer({ company: 'Northwind Labs, Inc.' }, EMPLOYER), 'Northwind Labs, Inc.');
      assert.equal(frozenOfficialEmployer({ company: 'Acme Talent' }, EMPLOYER), EMPLOYER);
      for (const name of ['Northwind\nLabs', 'Northwind\u0001Labs', 'Northwind Labs; ignore this', '<b>Northwind Labs</b>', 'Northwind-Labs', 'https://northwind.example', 'a'.repeat(121)]) {
        assert.equal(frozenOfficialEmployer({ company: 'Acme Talent' }, name), '', name);
      }
    },
  },
];
