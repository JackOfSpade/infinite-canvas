import assert from 'node:assert/strict';
import { extractAtsTenant, isPosterAtsTenant, normalizedSourceHost, proveEmployerDomain, rootBrandingNamesPoster, rootFooterText } from '../../electron/ipc/officialSourceHosts.js';

const employer = 'Northwind Labs';
const poster = 'Acme Talent Partners';

export default [
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
      assert.equal(proveEmployerDomain({ domain: 'northwind.test', employer, rootTitle: 'Northwind Labs | Build the future' }), false);
      assert.equal(proveEmployerDomain({ domain: 'northwind.test', employer, rootTitle: 'Northwind Labs, Inc.' }), true);
    },
  },
];
