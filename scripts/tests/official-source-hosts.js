import assert from 'node:assert/strict';
import { OFFICIAL_SEARCH_PARAM, explicitEmployerAlias, extractAtsTenant, isAtsCorporateBrandAlias, isAtsCorporateHost, isHostedAtsSurface, isKnownAtsHost, isOfficialCareersUrl, isPosterAtsTenant, normalizedSourceHost, proveBidirectionalOwnership, proveEmployerDomain, rootBrandingNamesPoster, rootFooterText, sourceEmployerLabelEqual, sourceTenantTaglineEqual, strictEmployerEqual } from '../../electron/ipc/officialSourceHosts.js';

const employer = 'Northwind Labs';
const poster = 'Acme Talent Partners';

export default [
  {
    name: 'Strict employer normalization treats a Companies business suffix like Company without accepting a business-unit prefix',
    run() {
      assert.equal(strictEmployerEqual('Northwind Companies', 'Northwind'), true);
      assert.equal(strictEmployerEqual('Northwind Company Inc.', 'Northwind Companies'), true);
      assert.equal(strictEmployerEqual('Northwind Consulting', 'Northwind'), false);
      assert.equal(strictEmployerEqual('Northwind North America Inc.', 'Northwind Companies'), false);
    },
  },

  {
    name: 'Source display qualifiers preserve exact base labels and reject recruiter nested and unrelated annotations',
    run() {
      for (const label of ['Northwind Labs', 'Northwind Labs (A Northstar Company)', 'Northwind Labs (A Northstar Technology Lab)',
        'Northwind Labs (An Example Division)']) assert.equal(sourceEmployerLabelEqual('Northwind Labs', label), true, label);
      for (const label of ['Northwind (A Northstar Company)', 'Northwind Labs (Hiring for Example Company)',
        'Northwind Labs (A Recruiting Company)', 'Northwind Labs (A Client Business)', 'Northwind Labs (A Northstar (US) Company)',
        'Northwind Labs (A Northstar Company) for another employer', 'Northwind Labs (Northstar Company)']) {
        assert.equal(sourceEmployerLabelEqual('Northwind Labs', label), false, label);
      }
    },
  },

  {
    name: 'Explicit employer aliases require a complete declared relationship rather than prefixes or nearby names',
    run() {
      const pair = { left: 'Northwind Insights Inc.', right: 'Northwind' };
      for (const body of ['Northwind Insights, Inc. (“Northwind”) respects privacy.',
        'Northwind is a trading name of Northwind Insights Inc.',
        'Northwind and the Dispatch logo are trademarks of Northwind Insights Inc.']) {
        assert.equal(explicitEmployerAlias({ ...pair, body }), true, body);
      }
      for (const body of ['Northwind Insights Inc. provides Northwind services.',
        'Other Insights Inc. (“Northwind”) respects privacy.',
        'Northwind Insights Inc. (“Other”) respects privacy.',
        '<script>Northwind Insights Inc. (“Northwind”)</script>']) {
        assert.equal(explicitEmployerAlias({ ...pair, body }), false, body);
      }
      const root = { domain: 'northwind.test', employer: pair.left, poster: pair.right, rootSiteName: pair.right };
      assert.equal(proveEmployerDomain(root), false);
      assert.equal(proveEmployerDomain({ ...root, rootAliases: [[pair.left, pair.right]] }), true);
      for (const value of ['https://boards-api.greenhouse.io/v1/boards/Northwind/jobs?content=true',
        'https://api.greenhouse.io/v1/boards/Northwind/jobs/123']) assert.deepEqual(extractAtsTenant(value), { ats: 'greenhouse', tenant: 'northwind' });
      for (const value of ['https://api.greenhouse.io/v1/boards/Northwind/jobs/123/application',
        'https://api.greenhouse.io/v1/boards/Northwind/jobs/not-an-id', 'https://api.greenhouse.io/v1/boards/jobs/jobs',
        'https://api.greenhouse.io.example.test/v1/boards/Northwind/jobs']) assert.equal(extractAtsTenant(value), null, value);
    },
  },

  {
    name: 'Official careers navigation recognizes standalone hiring vocabulary without matching product names or query text',
    run() {
      for (const path of ['/careers', '/company/hiring', '/careers-talent/join-the-synthetic-ecosystem', '/careers-and-talent/team', '/join-us', '/work-with-us/', '/opportunities', '/openings/role', '/open-roles', '/company/open-roles/', '/%6fpen-roles', '/%68iring']) {
        assert.equal(isOfficialCareersUrl(`https://northwind.test${path}`), true, path);
      }
      for (const path of ['/rehiring', '/hiring-tools', '/careers-talent-tools', '/join-the-synthetic-ecosystem', '/jobs-analytics', '/open-roles-tools', '/reopen-roles', '/open-role', '/join-us-now', '/product?next=/hiring', '/product?next=/open-roles', '/%2Fhiring', '/%2Fopen-roles']) {
        assert.equal(isOfficialCareersUrl(`https://northwind.test${path}`), false, path);
      }
      for (const host of ['careers.northwind.test', 'career.northwind.test', 'jobs.northwind.test', 'job.northwind.test']) {
        assert.equal(isOfficialCareersUrl(`https://${host}/`), true, host);
        assert.equal(proveEmployerDomain({ domain: host, employer: 'Northwind Labs' }), false, 'navigation vocabulary grants no ownership');
      }
      for (const host of ['hiring.northwind.test', 'www.careers.northwind.test', 'careers.customer.northwind.test', 'mycareers.northwind.test']) {
        assert.equal(isOfficialCareersUrl(`https://${host}/`), false, host);
      }
      assert.equal(isOfficialCareersUrl('http://northwind.test/hiring'), false);
    },
  },
  {
    name: 'ATS corporate legal aliases require actual branded-root copyright evidence and retain unrelated poster vetoes',
    run() {
      const proof = { domain: 'www.greenhouse.com', employer: 'Greenhouse', poster: 'Greenhouse Software',
        rootTitle: 'Greenhouse | Synthetic hiring platform', rootFooter: '© 2026 Greenhouse Software, Inc. All rights reserved.' };
      assert.equal(isAtsCorporateBrandAlias(proof), true);
      assert.equal(proveEmployerDomain(proof), true);
      assert.equal(proveBidirectionalOwnership({ ...proof, linksToTenant: true, tenantPointsBack: true,
        route: { ats: 'greenhouse', tenant: 'synthetic-corporate-team' } }), true);
      for (const change of [{ domain: 'jobs.greenhouse.com' }, { domain: 'greenhouse.example.test' },
        { rootFooter: 'Recruiting by Greenhouse Software' }, { rootFooter: '© 2026 Greenhouse Staffing, Inc. All rights reserved.' },
        { poster: 'Acme Talent Partners' }, { rootTitle: 'Other Software | Synthetic hiring platform' },
        { employer: 'House' }, { rootFooter: '© 2026 Other Software, Inc. Recruiting by Greenhouse Software.' }]) {
        assert.equal(isAtsCorporateBrandAlias({ ...proof, ...change }), false, JSON.stringify(change));
      }
      assert.equal(proveBidirectionalOwnership({ ...proof, linksToTenant: false, tenantPointsBack: true }), false);
      assert.equal(proveEmployerDomain({ ...proof, rootFooter: 'Recruiting by Greenhouse Software' }), false);
    },
  },
  {
    name: 'Official source hosts separate exact ATS corporate marketing sites from customer tenant surfaces',
    run() {
      for (const host of ['ashbyhq.com', 'www.ashbyhq.com', 'greenhouse.com', 'www.greenhouse.com', 'rippling.com', 'www.rippling.com']) {
        assert.equal(isKnownAtsHost(host), true, 'vendor categorization remains intact');
        assert.equal(isAtsCorporateHost(host), true, host);
        assert.equal(isHostedAtsSurface(host), false, host);
      }
      for (const host of ['jobs.ashbyhq.com', 'api.ashbyhq.com', 'customer.ashbyhq.com', 'www.customer.ashbyhq.com',
        'job-boards.greenhouse.io', 'boards.greenhouse.io', 'boards-api.greenhouse.io', 'api.greenhouse.io', 'customer.greenhouse.com', 'ats.rippling.com', 'customer.rippling.com', 'myworkdayjobs.com']) {
        assert.equal(isAtsCorporateHost(host), false, host);
        assert.equal(isHostedAtsSurface(host), true, host);
      }
      for (const host of ['ashbyhq.com.example.test', 'greenhouse.com.example.test', 'www.greenhouse.example.test',
        'https://user@www.greenhouse.com/']) assert.equal(isAtsCorporateHost(host), false, host);
    },
  },
  {
    name: 'Official source ownership recognizes branded corporate vendor root titles without granting tenant or unrelated employer ownership',
    run() {
      for (const [domain, employer] of [['www.ashbyhq.com', 'Ashby'], ['www.greenhouse.com', 'Greenhouse']]) {
        assert.equal(proveEmployerDomain({ domain, employer, rootTitle: `${employer} | Synthetic workflow platform` }), true);
        assert.equal(proveEmployerDomain({ domain, employer, rootTitle: `Synthetic workflow platform | ${employer}` }), employer === 'Greenhouse');
        assert.equal(proveEmployerDomain({ domain, employer, rootTitle: `${employer} Support | Synthetic platform` }), false);
        assert.equal(proveEmployerDomain({ domain, employer: 'Northwind Labs', rootTitle: `${employer} | Synthetic platform` }), false);
        assert.equal(proveEmployerDomain({ domain, employer, poster, rootTitle: `${employer} | Synthetic platform`,
          rootFooter: `Recruiting by ${poster}` }), false);
      }
      for (const domain of ['jobs.ashbyhq.com', 'customer.greenhouse.com', 'job-boards.greenhouse.io']) {
        assert.equal(proveEmployerDomain({ domain, employer: 'Northwind Labs', rootTitle: 'Northwind Labs' }), false, domain);
      }
      assert.equal(proveEmployerDomain({ domain: 'northwind.test', employer, rootTitle: 'Northwind Labs | Synthetic platform' }), true,
        'an explicit leading brand and matching domain also identify an ordinary employer marketing root');
      assert.equal(proveEmployerDomain({ domain: 'unrelated.test', employer, rootTitle: 'Northwind Labs | Synthetic platform' }), false);
    },
  },
  {
    name: 'Official source hosts extract distinct normalized company tenants instead of vendor-wide path constants',
    run() {
      const tenants = [
        ['https://join.com/companies/Northwind/123-engineer', { ats: 'join', tenant: 'northwind' }],
        ['https://www.comeet.com/jobs/Northwind/12.345/engineer', { ats: 'comeet', tenant: 'northwind' }],
        ['https://jobs.dayforcehcm.com/en-US/Northwind/CANDIDATEPORTAL/jobs/123', { ats: 'dayforce', tenant: 'northwind' }],
        ['https://recruiting.paylocity.com/recruiting/jobs/All/ABCDEF01-2345-6789-ABCD-EF0123456789', { ats: 'paylocity', tenant: 'abcdef01-2345-6789-abcd-ef0123456789' }],
        ['https://jobs.lever.co/Northwind/one', { ats: 'lever', tenant: 'northwind' }],
        ['https://northwind.wd5.myworkdayjobs.com/en-US/External/job/Lakeview/Engineer_R1', { ats: 'workday', tenant: 'northwind/external' }],
        ['https://northwind.wd5.myworkdayjobs.com/EXTERNAL/job/Lakeview/Engineer_R1', { ats: 'workday', tenant: 'northwind/external' }],
        ['https://apply.workable.com/Northwind/j/ABC123/', { ats: 'workable', tenant: 'northwind' }],
        ['https://jobs.smartrecruiters.com/Northwind/123-engineer', { ats: 'smartrecruiters', tenant: 'northwind' }],
        ['https://ats.rippling.com/Northwind/jobs/123', { ats: 'rippling', tenant: 'northwind' }],
        ['https://jobs.jobvite.com/Northwind/job/o1', { ats: 'jobvite', tenant: 'northwind' }],
        ['https://job-boards.eu.greenhouse.io/Northwind/jobs/1', { ats: 'greenhouse', tenant: 'northwind' }],
      ];
      for (const [url, expected] of tenants) assert.deepEqual(extractAtsTenant(url), expected, url);
      for (const [a, b] of [
        ['https://join.com/companies/northwind/123', 'https://join.com/companies/acme-talent/456'],
        ['https://www.comeet.com/jobs/northwind/1', 'https://www.comeet.com/jobs/acme-talent/2'],
        ['https://jobs.dayforcehcm.com/en-US/northwind/jobs/1', 'https://jobs.dayforcehcm.com/en-US/acme-talent/jobs/2'],
        ['https://recruiting.paylocity.com/recruiting/jobs/All/abcdef01-2345-6789-abcd-ef0123456789', 'https://recruiting.paylocity.com/recruiting/jobs/All/abcdef02-2345-6789-abcd-ef0123456789'],
      ]) assert.notDeepEqual(extractAtsTenant(a), extractAtsTenant(b), `${a} versus ${b}`);
      assert.deepEqual(extractAtsTenant('https://jobs.lever.co/Northwind/one'), extractAtsTenant('https://jobs.lever.co/northwind/two'));
    },
  },
  {
    name: 'Official source hosts return no tenant when the vendor route has no safe company key',
    run() {
      for (const url of [
        'https://join.com/companies', 'https://join.com/jobs/123', 'https://www.comeet.com/jobs',
        'https://jobs.dayforcehcm.com/en-US', 'https://jobs.dayforcehcm.com/en-US/jobs/123',
        'https://recruiting.paylocity.com/recruiting/jobs/Details/123/Northwind',
        'https://recruiting.paylocity.com/recruiting/jobs/All/not-a-company-id',
        'https://sjobs.brassring.com/TGnewUI/Search/home/HomeWithPreLoad?partnerid=1&siteid=2&jobid=3',
        'https://workforcenow.adp.com/jobs', 'https://jobs.lever.co/login', 'https://jobs.ashbyhq.com/%2F',
        'https://jobs.smartrecruiters.com', 'https://apply.workable.com/jobs/one',
        'https://www.teamtailor.com/jobs', 'https://teamtailor.com', 'https://app.teamtailor.com/careers',
        'https://www.oraclecloud.com/careers', 'https://jobs.icims.com/jobs', 'https://www.icims.com/',
      ]) assert.equal(extractAtsTenant(url), null, url);
      assert.equal(normalizedSourceHost(['https://northwind.test/']), '', 'an array cannot be coerced into a sameAs host attestation');
    },
  },
  {
    name: 'Official source hosts identify poster slug tokens without treating a different slug as positive employer proof',
    run() {
      for (const url of [
        'https://jobs.lever.co/Acme-Talent/one', 'https://jobs.ashbyhq.com/acme-talent/one',
        'https://join.com/companies/acme-talent/one', 'https://www.comeet.com/jobs/acme-talent/1',
        'https://jobs.smartrecruiters.com/AcmeTalent/one',
        'https://acme-talent.wd5.myworkdayjobs.com/External/job/one', 'https://acme-talent.teamtailor.com/jobs/one',
        'https://careers-acme-talent.icims.com/jobs/one',
      ]) assert.equal(isPosterAtsTenant(extractAtsTenant(url), poster), true, url);
      for (const url of ['https://jobs.lever.co/northwind/one', 'https://jobs.lever.co/acme-other/one',
        'https://jobs.lever.co/acme-talentless/one', 'https://northwind.teamtailor.com/jobs/one']) {
        assert.equal(isPosterAtsTenant(extractAtsTenant(url), poster), false, url);
      }
      assert.equal(isPosterAtsTenant({ ats: 'paylocity', tenant: 'abcdef01-2345-6789-abcd-ef0123456789' }, poster), false);
      assert.equal(isPosterAtsTenant(null, poster), false);
    },
  },
  {
    name: 'Official source hosts treat a slug that extends the poster name with a careers or recruiting word as the poster tenant',
    run() {
      // The poster's name, a leading part of it (four characters or more) or its compact form, plus only generic careers words.
      for (const url of [
        'https://jobs.lever.co/acme-careers/one', 'https://jobs.ashbyhq.com/acme-jobs/one', 'https://jobs.ashbyhq.com/acmetalentjobs/one',
        'https://jobs.lever.co/acme-recruiting/one', 'https://boards.greenhouse.io/acmetalentpartnersinc/jobs/1', 'https://jobs.lever.co/careers-acme/one',
        'https://jobs.lever.co/acme-talent-partners-careers/one', 'https://jobs.lever.co/acmetalentcareers/one', 'https://jobs.lever.co/acme-hiring/one',
        'https://acme-careers.wd5.myworkdayjobs.com/External/job/one', 'https://acme-careers.teamtailor.com/jobs/one', 'https://careers-acme-jobs.icims.com/jobs/one',
      ]) assert.equal(isPosterAtsTenant(extractAtsTenant(url), poster), true, url);
      // A different company, or a slug that adds a real name, is not vetoed.
      for (const url of [
        'https://jobs.lever.co/acme-dynamics/one', 'https://jobs.lever.co/acmelabs/one', 'https://jobs.lever.co/acme-talentless/one',
        'https://jobs.lever.co/acme-careers-northwind/one', 'https://jobs.lever.co/northwind-careers/one', 'https://jobs.lever.co/careers/one',
        'https://jobs.lever.co/acmetalentpartnerscapital/one',
      ]) assert.equal(isPosterAtsTenant(extractAtsTenant(url), poster), false, url);
      // A short first word is not a name claim by itself; the whole short poster name still is.
      assert.equal(isPosterAtsTenant({ ats: 'lever', tenant: 'ab-careers' }, 'Ab Talent Partners'), false);
      assert.equal(isPosterAtsTenant({ ats: 'lever', tenant: 'ibm-careers' }, 'IBM Inc'), true);
      assert.equal(isPosterAtsTenant({ ats: 'lever', tenant: 'ibm-research' }, 'IBM Inc'), false);
    },
  },
  {
    name: 'Official source hosts veto poster tokens contained in root title site name or real footer text',
    run() {
      for (const field of ['rootTitle', 'rootSiteName', 'rootFooter']) {
        const branding = { [field]: `Recruiting by ${poster}, Inc. | Open roles` };
        assert.equal(rootBrandingNamesPoster(branding, poster), true, field);
        assert.equal(proveEmployerDomain({ domain: 'careers.test', employer, poster, rootTitle: employer, ...branding }), false, field);
      }
      assert.equal(rootBrandingNamesPoster({ rootTitle: 'Acme Talent Partnersish' }, poster), false);
      assert.equal(rootBrandingNamesPoster({ rootTitle: 'Acme and Partners Talent' }, poster), false);
      assert.equal(rootFooterText('<p>Acme Talent Partners</p><script>Acme Talent Partners</script><footer>Owned by <b>Northwind Labs</b><style>.x{}</style></footer>'), 'Owned by Northwind Labs');
      assert.equal(rootFooterText('<footer><script>Acme Talent Partners</script><template>Acme Talent Partners</template>Northwind Labs</footer>'), 'Northwind Labs');
    },
  },
  {
    name: 'Official source ownership equates only the apex and www hosts for independent careers proof and poster vetoes',
    run() {
      const postingUrl = 'https://jobs.lever.co/northwind/one';
      for (const [domain, careersHost] of [['nwlhq.test', 'www.nwlhq.test'], ['www.nwlhq.test', 'nwlhq.test']]) {
        const page = { domain, employer, independentEmployer: employer, careersPageEmployer: employer,
          careersPageUrl: `https://${careersHost}/careers`, careersLinks: [postingUrl], postingUrl };
        assert.equal(proveEmployerDomain(page), true, `${domain} and ${careersHost} have the same ownership`);
        assert.equal(proveEmployerDomain({ domain, employer, poster, posterDomain: careersHost, rootTitle: employer }), false,
          'the alias cannot evade a poster-domain veto');
      }
      for (const careersHost of ['careers.nwlhq.test', 'www.careers.nwlhq.test', 'elsewhere.test', 'www.elsewhere.test']) {
        assert.equal(proveEmployerDomain({ domain: 'nwlhq.test', employer, independentEmployer: employer,
          careersPageEmployer: employer, careersPageUrl: `https://${careersHost}/careers`, careersLinks: [postingUrl], postingUrl }), false, careersHost);
      }
    },
  },
  {
    name: 'Official source hosts require independent host ownership before accepting a careers title or off-domain attestation',
    run() {
      const page = { domain: 'careers.northwind.test', employer, poster,
        careersPageUrl: 'https://careers.northwind.test/careers', careersPageEmployer: employer,
        careersLinks: ['https://jobs.lever.co/northwind'], postingUrl: 'https://jobs.lever.co/northwind/one' };
      assert.equal(proveEmployerDomain(page), false);
      assert.equal(proveEmployerDomain({ ...page, independentEmployer: 'Other Labs' }), false);
      assert.equal(proveEmployerDomain({ ...page, independentEmployer: employer }), true);
      const attestation = { domain: 'northwind.test', employer, poster,
        postingUrl: 'https://jobs.lever.co/northwind/one', sameAs: 'https://northwind.test/' };
      assert.equal(proveEmployerDomain(attestation), false);
      assert.equal(proveEmployerDomain({ ...attestation, independentEmployer: employer }), true);
      assert.equal(proveEmployerDomain({ ...attestation, independentEmployer: employer, rootFooter: `Copyright ${poster}` }), false);
      assert.equal(proveEmployerDomain({ domain: 'northwind.test', employer, rootTitle: 'Northwind Labs | Build the future' }), true);
      assert.equal(proveEmployerDomain({ domain: 'northwind.test', employer, rootTitle: 'Northwind Labs, Inc.' }), true);
    },
  },
  {
    name: 'Conventional careers roots require a complete employer title and matching registrable brand',
    run() {
      for (const [domain, rootTitle] of [['careers.northwind.test', 'Northwind Labs Careers - Open roles'],
        ['jobs.northwind.test', 'Jobs at Northwind Labs | Join us'], ['job.northwind.test', 'Northwind Labs Jobs'],
        ['career.northwind.test', 'Careers at Northwind Labs']]) {
        assert.equal(proveEmployerDomain({ domain, employer, poster: employer, rootTitle }), true);
      }
      for (const [domain, rootTitle] of [['careers.tools.northwind.test', 'Northwind Labs Careers'],
        ['jobs-tools.northwind.test', 'Northwind Labs Careers'], ['careers.other.test', 'Northwind Labs Careers'],
        ['careers.northwind.test', 'Northwind Careers'], ['careers.northwind.test', 'Agency Northwind Labs Careers'],
        ['https://careers.northwind.test/company', 'Northwind Labs Careers']]) {
        assert.equal(proveEmployerDomain({ domain, employer, poster: employer, rootTitle }), false, `${domain}: ${rootTitle}`);
      }
    },
  },
  {
    name: 'Static asset paths are never read as ATS tenants and tagline board labels reject intermediaries',
    run() {
      for (const url of ['https://jobs.lever.co/js/bug-snag.js', 'https://jobs.lever.co/css/site.css', 'https://jobs.lever.co/favicon.ico',
        'https://jobs.lever.co/static/app.js', 'https://job-boards.greenhouse.io/assets/x.js', 'https://jobs.ashbyhq.com/images/logo.png',
        'https://jobs.lever.co/robots.txt', 'https://jobs.lever.co/app.js']) assert.equal(extractAtsTenant(url), null, url);
      assert.deepEqual(extractAtsTenant('https://jobs.lever.co/cognite/abc'), { ats: 'lever', tenant: 'cognite' });
      assert.deepEqual(extractAtsTenant('https://job-boards.greenhouse.io/braze'), { ats: 'greenhouse', tenant: 'braze' });
      assert.equal(sourceTenantTaglineEqual('Cognite', 'Cognite - AI for Industry'), true);
      assert.equal(sourceTenantTaglineEqual('Cognite', 'Cognite | AI for Industry'), true);
      assert.equal(sourceTenantTaglineEqual('Cognite', 'Cognite'), true);
      for (const label of ['Cognite - Staffing Partner', 'Cognite Talent - Jobs', 'Other Co - Cognite', 'Cognite-AI', 'Cognite - Hiring for a client'])
        assert.equal(sourceTenantTaglineEqual('Cognite', label), false, label);
    },
  },
  {
    name: 'Only keyword-search parameter names are search parameters',
    run() {
      for (const name of ['keyword', 'keywords', 'q', 'Query', 'search', 'term', 'text']) assert.equal(OFFICIAL_SEARCH_PARAM.test(name), true, name);
      for (const name of ['location', 'page', 'department', 'qq', 'searchType', 'utm_term']) assert.equal(OFFICIAL_SEARCH_PARAM.test(name), false, name);
    },
  },
];
