import assert from 'node:assert/strict';
import {
  careersPageEmployerFromTitle, classifyOfficialSourceHost, extractAtsTenant, isAggregatorHost, isKnownAtsHost,
  proveEmployerDomain, strictEmployerEqual,
} from '../../electron/ipc/officialSourceHosts.js';
import {
  consolidatedSinglePlace, coreTitle, descriptionOverlap, frozenOfficialEmployer, isSingleStatedPlace,
  locationsCompatible, posterEmployerSignals, resolveScrapedEmployer,
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
        ['https://northwind.wd5.myworkdayjobs.com/External/job/123', 'workday', 'northwind/external'],
        ['https://northwind.wd5.myworkdayjobs.com/en-US/External/job/123', 'workday', 'northwind/external'],
        ['https://northwind.wd5.myworkdayjobs.com/fr-CA/External/job/123', 'workday', 'northwind/external'],
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
      assert.equal(proveEmployerDomain({ domain: 'northwind.example', employer: EMPLOYER, rootTitle: `${EMPLOYER} | Marketing copy` }), true, 'an exact fetched brand segment and matching corporate domain support employer discovery');
      assert.equal(proveEmployerDomain({ domain: 'unrelated.example', employer: EMPLOYER, rootTitle: `${EMPLOYER} | Marketing copy` }), false, 'a brand segment cannot authorize an unrelated domain');
      assert.equal(careersPageEmployerFromTitle(`Careers at ${EMPLOYER} | Build the future`), EMPLOYER);
      assert.equal(careersPageEmployerFromTitle(`Careers at ${EMPLOYER}`), EMPLOYER);
      assert.equal(careersPageEmployerFromTitle(`${EMPLOYER} | Careers and marketing`), '');
      assert.equal(careersPageEmployerFromTitle(`Stories about Careers at ${EMPLOYER}`), '');
      assert.equal(careersPageEmployerFromTitle(`Careers at Other Labs | ${EMPLOYER}`), 'Other Labs');
      const attestation = { domain: 'northwind.example', employer: EMPLOYER, sameAs: 'https://northwind.example/', postingUrl: 'https://northwind.example/jobs/1' };
      assert.equal(proveEmployerDomain(attestation), false);
      assert.equal(proveEmployerDomain({ ...attestation, postingUrl: 'https://jobs.ashbyhq.com/northwind/123' }), false, 'the posting cannot self-attest its sameAs host');
      assert.equal(proveEmployerDomain({ ...attestation, postingUrl: 'https://jobs.ashbyhq.com/northwind/123', independentEmployer: EMPLOYER }), true);
      assert.equal(proveEmployerDomain({ ...attestation, domain: 'linkedin.com', rootTitle: EMPLOYER }), false);
      assert.equal(proveEmployerDomain({ ...attestation, poster: 'Acme Talent', posterDomain: 'northwind.example', rootTitle: EMPLOYER }), false);
      const careers = { domain: 'northwind.example', employer: EMPLOYER, careersPageUrl: 'https://northwind.example/careers', careersPageEmployer: EMPLOYER,
        careersLinks: ['https://jobs.ashbyhq.com/northwind'], postingUrl: 'https://jobs.ashbyhq.com/northwind/123' };
      assert.equal(proveEmployerDomain(careers), false, 'a path title cannot establish its host');
      assert.equal(proveEmployerDomain({ ...careers, independentEmployer: EMPLOYER }), true);
      assert.equal(proveEmployerDomain({ ...careers, independentEmployer: EMPLOYER, careersPageEmployer: 'Northwind Consulting' }), false);
      assert.equal(proveEmployerDomain({ ...careers, independentEmployer: EMPLOYER, careersLinks: ['https://jobs.ashbyhq.com/another-tenant'] }), false);
    },
  },
  {
    name: 'Official posting matching: core titles normalize presentation while retaining sibling and level identity',
    run() {
      assert.equal(coreTitle('Sr. Software Eng. at Northwind Labs', { company: 'Northwind Labs' }), 'senior software engineer');
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
      assert.equal(locationsCompatible(row({ location: 'Remote - Canada', remote: true }), candidate({ location: { display: '', remote: true, remoteCountry: 'Canada' } })), true);
      assert.equal(locationsCompatible(row({ location: 'Remote - Canada', remote: true }), candidate({ location: { display: '', remote: true, remoteCountry: 'United States' } })), false);
      assert.equal(locationsCompatible(row({ location: 'Remote' }), candidate({ location: { display: '', remote: true, remoteCountry: 'Canada' } })), false);
      assert.equal(locationsCompatible(row({ location: 'Multiple Locations' }), candidate()), false);
    },
  },
  {
    name: 'Official posting matching: only posted salary anchors or vetoes and units and currencies stay exact',
    run() {
      assert.equal(descriptionOverlap('We seek qualified applicants.', 'We seek qualified applicants.').anchored, false);
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
    name: 'Official posting matching: description anchors need containment of the scraped text and an independent anchor for weak overlap',
    run() {
      const added = 'Coordinate exception handling across outbound warehouse feeds while operators compare rejected records against documented delivery contracts. '
        + 'Review archival retention settings and reconcile delayed transfers with the transport scheduling staff.';
      const longer = `${DESCRIPTION} ${added}`;
      // Amendment 3: a partial scraped description contained in a longer official text anchors.
      // The weak band is the reverse: a scraped text that the official text contains only in part.
      assert.equal(descriptionOverlap(DESCRIPTION, longer).anchored, true);
      const overlap = descriptionOverlap(longer, DESCRIPTION);
      assert.ok(overlap.score >= 0.6 && overlap.score < 0.85, JSON.stringify(overlap));
      assert.equal(overlap.anchored, false);
      assert.equal(overlap.weak, true);
      assert.ok(overlap.coverageRight > overlap.coverageLeft);
      assert.equal(descriptionOverlap('ledger route queue audit export '.repeat(10), 'ledger route queue audit export '.repeat(10)).anchored, false, 'repetition cannot supply twelve distinctive grams');
      assert.equal(descriptionOverlap(DESCRIPTION, DESCRIPTION).anchored, true);
    },
  },
  {
    name: 'Official posting signals: ordinary pronouns, skills, client-service copy, company brands and title decorations preserve the employer',
    run() {
      const prefixes = ['This is a full-time role.', 'It is an exciting opportunity.', 'There is a lot to do.', 'SQL is a must.',
        'Python is a plus.', 'Machine Learning is a requirement.', 'Data Science is a useful background.',
        'Communication is a core part of the job.', 'Remote is a requirement.', 'Our Mission is the reason we exist.',
        'Northwind is a leading technology company.', 'Northwind Labs Research is a technology company.',
        'We build tools that our customers love.', 'We deliver services for our clients.', 'We are hiring for a Software Engineer.',
        'We are recruiting for several engineering roles.', 'Act on behalf of the support team during incidents.'];
      for (const prefix of prefixes) {
        const scraped = row({ snippet: `${prefix} ${DESCRIPTION}` });
        assert.equal(posterEmployerSignals(scraped).pointsAway, false, prefix);
        assert.equal(resolveScrapedEmployer(scraped).level, 'L5', prefix);
        assert.equal(resolveScrapedEmployer(scraped).employer, EMPLOYER, prefix);
      }
      for (const decoration of ['(Remote)', '- Remote', ', Toronto', '| Hiring now', '$120k', 'Inc.']) {
        const scraped = row({ title: `Senior Software Engineer at ${EMPLOYER} ${decoration}` });
        assert.equal(posterEmployerSignals(scraped).S1, '', decoration);
        assert.equal(resolveScrapedEmployer(scraped).employer, EMPLOYER, decoration);
      }
      assert.equal(posterEmployerSignals(row({ title: `Senior Software Engineer at The ${EMPLOYER}` })).S1, '');
      assert.equal(posterEmployerSignals(row({ company: 'Northwind', title: `Senior Software Engineer at ${EMPLOYER}` })).S1, '');
      const recruiting = row({ company: 'Acme Talent Partners', snippet: 'We are recruiting for Northwind Labs. Company Description Northwind Labs is a technology company.' });
      assert.equal(posterEmployerSignals(recruiting).S3, true);
      assert.deepEqual(posterEmployerSignals(recruiting).S4, [EMPLOYER]);
    },
  },
  {
    name: 'Official posting matching: genuine intermediary copy vetoes both poster-owned domains and poster tenants',
    run() {
      const scraped = row({ company: 'Acme Talent Partners', snippet: `Our client, a dispatch software company, is hiring. ${DESCRIPTION}` });
      assert.equal(posterEmployerSignals(scraped).S3, true);
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
  {
    name: 'A single stated place is one non-remote place, never a list, a work mode or "Multiple locations"',
    run() {
      for (const place of ['Burnaby', 'Burnaby, British Columbia, Canada', 'Toronto, ON']) assert.equal(isSingleStatedPlace(place), true, place);
      for (const place of ['Burnaby | Vancouver', 'Remote', 'Remote, Canada', 'Multiple locations', '']) assert.equal(isSingleStatedPlace(place), false, place);
    },
  },
  {
    name: 'A consolidated row resolves to one place only when every posting names the same place',
    run() {
      const rowOf = (...locations) => ({ location: 'Multiple locations', postingVariants: locations.map(location => ({ location })) });
      assert.equal(consolidatedSinglePlace(rowOf('Burnaby', 'Burnaby, British Columbia, Canada')), 'Burnaby, British Columbia, Canada',
        'the most specific spelling of the one shared place wins');
      assert.equal(consolidatedSinglePlace(rowOf('Burnaby', 'Toronto, ON')), null, 'two different cities are really several places');
      assert.equal(consolidatedSinglePlace(rowOf('Burnaby', 'Burnaby | Vancouver')), null, 'a variant listing several places is not one place');
      assert.equal(consolidatedSinglePlace(rowOf('Burnaby', 'Remote, Canada')), null, 'a remote variant leaves the row unresolved');
      assert.equal(consolidatedSinglePlace(rowOf('Burnaby', '')), null, 'a variant without a location leaves the row unresolved');
      assert.equal(consolidatedSinglePlace(rowOf('Burnaby')), null, 'a single posting is not a consolidated row');
      assert.equal(consolidatedSinglePlace({}), null);
    },
  },
];
