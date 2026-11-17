import assert from 'node:assert/strict';
import {
  domainBrandMatchesEmployer, leadingTitleSegment, proveBidirectionalOwnership, registrableDomain,
} from '../../electron/ipc/officialSourceHosts.js';
import {
  canonicalLeadUrl, descriptionOverlap, flatPostingText, plainPostingText,
} from '../../electron/ipc/officialPostingMatch.js';

// AMENDMENT-3 sections 1-4 plus the small-pool resolutions R1 (best match with
// margin among same-identity postings) and R2 (a small pool never accepts on
// description alone). Synthetic names only.
const EMPLOYER = 'Northwind Labs';
const POSTER = 'Acme Talent Partners';
const NOW = Date.parse('2026-10-24T00:00:00Z');

const VERBS = ['Calibrate', 'Reconcile', 'Tune', 'Audit', 'Schedule', 'Profile', 'Migrate', 'Inspect', 'Replay', 'Model', 'Partition', 'Index', 'Simulate', 'Validate', 'Throttle', 'Compact'];
const NOUNS = ['freight lanes', 'carrier ledgers', 'depot manifests', 'pallet routes', 'dock windows', 'fuel cards', 'yard queues', 'tariff tables', 'driver rosters', 'loading bays',
  'invoice batches', 'customs records', 'cargo seals', 'weigh tickets', 'trailer pools', 'transfer hubs', 'relay stops', 'dispatch rules', 'settlement files', 'route plans'];
const MODS = ['nightly', 'regional', 'seasonal', 'archived', 'priority', 'overflow', 'pending', 'weekly', 'inbound', 'outbound', 'reserved', 'split'];
const TAILS = ['before the evening cutoff', 'for the northern depots', 'against the signed contracts', 'during peak volume', 'with the finance reviewers', 'across the shared pipeline',
  'after each quarterly audit', 'inside the staging environment', 'alongside the planning analysts', 'under changing carrier rules', 'for the harbor terminals', 'through the batch scheduler'];
function mix(seed) { let x = (seed + 1) * 2654435761 % 4294967296; x = (x ^ (x >>> 15)) * 2246822519 % 4294967296; return (x ^ (x >>> 13)) >>> 0; }
/** One deterministic synthetic sentence; distinct seeds do not share five-word runs. */
const sentence = seed => `${VERBS[mix(seed) % 16]} ${MODS[mix(seed + 1) % 12]} ${NOUNS[mix(seed + 2) % 20]} and ${MODS[mix(seed + 3) % 12]} ${NOUNS[mix(seed + 4) % 20]} ${TAILS[mix(seed + 5) % 12]} with experience number ${seed}.`;
const lines = (from, count) => Array.from({ length: count }, (_, index) => sentence(from + index));
const ABOUT = 'About Northwind Labs. Northwind Labs builds workflow products for regional businesses across the country. '
  + 'We value kind colleagues, steady progress and thoughtful conversations in every office. '
  + 'We offer health coverage, flexible schedules, paid parental leave and a learning budget for every employee. '
  + 'Northwind Labs is an equal opportunity employer and welcomes applicants from every background and ability.';
// Process copy shared by every posting on a board but never labelled as a company section.
const PROCESS = lines(9000, 6).join(' ');

const NBSP = String.fromCharCode(160);


export default [
  {
    name: 'Amendment 3 ownership: pure checks require link, back reference, brand and no poster, aggregator or ATS veto',
    run() {
      const proof = { domain: 'northwind.test', employer: EMPLOYER, poster: POSTER, linksToTenant: true, tenantPointsBack: true, route: { ats: 'ashby', tenant: 'northwind' } };
      assert.equal(proveBidirectionalOwnership(proof), true);
      assert.equal(proveBidirectionalOwnership({ ...proof, linksToTenant: false }), false);
      assert.equal(proveBidirectionalOwnership({ ...proof, tenantPointsBack: false }), false);
      assert.equal(proveBidirectionalOwnership({ ...proof, domain: 'harbor.test', employer: 'Harbor One' }), true, 'brand alone is the collision the other checks exist for');
      assert.equal(proveBidirectionalOwnership({ ...proof, domain: 'harbor.test', employer: 'Harbor One', linksToTenant: false }), false);
      assert.equal(proveBidirectionalOwnership({ ...proof, domain: 'acmetalent.test' }), false);
      assert.equal(proveBidirectionalOwnership({ ...proof, domain: 'indeed.com' }), false);
      assert.equal(proveBidirectionalOwnership({ ...proof, domain: 'jobs.lever.co' }), false);
      assert.equal(proveBidirectionalOwnership({ ...proof, rootTitle: `Northwind Labs | ${POSTER}` }), false);
      assert.equal(proveBidirectionalOwnership({ ...proof, rootFooter: `Recruiting by ${POSTER}` }), false);
      assert.equal(proveBidirectionalOwnership({ ...proof, route: { ats: 'ashby', tenant: 'acme-talent' } }), false);
      assert.equal(proveBidirectionalOwnership({ ...proof, poster: EMPLOYER, rootTitle: `Northwind Labs | ${EMPLOYER}` }), true, 'an own-employer row has no poster to veto');
      assert.equal(domainBrandMatchesEmployer({ domain: 'birch.test', employer: 'Birch Security' }), true);
      assert.equal(domainBrandMatchesEmployer({ domain: 'cedar.test', employer: 'Cedar AI' }), true);
      assert.equal(domainBrandMatchesEmployer({ domain: 'cedarai.test', employer: 'Cedar AI' }), true);
      assert.equal(domainBrandMatchesEmployer({ domain: 'birch-security.test', employer: 'Birch Security' }), true);
      assert.equal(domainBrandMatchesEmployer({ domain: 'getbirch.test', employer: 'Birch Security' }), false);
      assert.equal(domainBrandMatchesEmployer({ domain: 'getbirch.test', employer: 'Birch Security', rootTitle: 'Birch – Access reviews' }), true);
      assert.equal(domainBrandMatchesEmployer({ domain: 'getbirch.test', employer: 'Birch Security', rootTitle: 'Access reviews – Birch' }), false);
      assert.equal(domainBrandMatchesEmployer({ domain: 'jobmirror.test', employer: EMPLOYER, rootTitle: 'Careers at Northwind Labs | JobMirror' }), false);
      assert.equal(registrableDomain('https://careers.northwind.test/jobs'), 'northwind.test');
      assert.equal(registrableDomain('https://www.northwind.co.uk/'), 'northwind.co.uk');
      assert.equal(leadingTitleSegment('Birch – Access reviews'), 'Birch');
      assert.equal(leadingTitleSegment('Cedar AI - Data platform'), 'Cedar AI');
    },
  },
  {
    name: 'Amendment 3 description: a Phenom-style 20 posting site with shared copy accepts a partial reformatted scraped description (L1)',
    async run() {
      const target = 7; const postings = Array.from({ length: 20 }, (_, index) => ({
        title: index === target ? 'Software Engineer' : `Specialist ${index}`, employer: EMPLOYER, location: { display: 'Lakeview, Ontario, Canada' },
        description: `${lines(2000 + index * 20, 10).join(' ')} ${PROCESS} ${ABOUT}`, sourceUrl: `https://careers.northwind.test/job/${index}`,
        ats: '', tenant: '', employerDomainProven: true, tenantProven: false, live: true, isListed: true, statusCode: 200, identifier: `req-${index}`,
      }));
      const partial = lines(2000 + target * 20, 6).map(line => `• ${line.replace(/\.$/u, ';').toLowerCase()}`).join('\n');
      // The shared process copy alone supplies nothing: the same text with only copy identifies no posting.
      assert.ok(descriptionOverlap(partial, postings[target].description, { peerDescriptions: postings.filter((_, index) => index !== target).map(item => item.description) }).anchored);
    },
  },
  {
    name: 'Amendment 5 comparative quote normalization: only list markers at a line start go, and a normalized form is stable',
    run() {
      const kept = ['3.5 years of experience with carrier ledgers', '401(k) matching for every employee', '-5% variance on weigh tickets', 'A. Smith and Co. audits', '**Bold** claim about yard queues', 'Scale to 10,000 pallet routes'];
      for (const line of kept) assert.equal(plainPostingText(line), line);
      assert.equal(plainPostingText('* one\n  - two\n1. three\n10) four\n• five\n– six\n- - seven\n*\n-'), 'one\n  two\nthree\nfour\nfive\nsix\nseven\n\n', 'indentation is kept for the prompt, markers are not');
      assert.equal(plainPostingText('it’s “quoted” – and — dashes'), 'it\'s "quoted" - and - dashes');
      assert.equal(flatPostingText(`  * one${NBSP}${NBSP}two \n\n  2. three  `), 'one two three');
      for (const sample of [`* a\n1. b ${NBSP}c`, 'plain text', '', `-\nfoo bar`, '- – x']) assert.equal(flatPostingText(flatPostingText(sample)), flatPostingText(sample));
    },
  },
  {
    name: 'Amendment 3 role text: a company section ends at the next role heading, listed or not, and identical About-first text anchors',
    run() {
      const section = ([head, seed]) => `${head}\n${lines(seed, 6).join('\n')}`;
      // Each section is [heading, seed, isCompanyCopy]; the first sentence of a section is sentence(seed).
      const layouts = [
        [['About Northwind Labs', 1, true], ['The Role', 20], ['Key Responsibilities', 40], ['Minimum Qualifications', 60]],
        [['About the Company', 1, true], ['Position Summary', 20], ['Duties', 40]],
        [['About Northwind', 1, true], ['Role Overview', 20], ['Key Duties', 40], ['Required Skills', 60]],
        [['About Us', 1, true], ['What Success Looks Like', 20], ['How You Will Contribute', 40]],
        [['ABOUT NORTHWIND', 1, true], ['THE OPPORTUNITY', 20], ['WHAT WE ARE LOOKING FOR', 40]],
        [['About Northwind', 1, true], ['Our Mission', 20, true], ['The Role', 40], ['Responsibilities', 60]],
      ];
      for (const layout of layouts) {
        const text = layout.map(section).join('\n');
        assert.equal(descriptionOverlap(text, text).anchored, true, `${layout[0][0]} / ${layout[1][0]}`);
      }
    },
  },
  {
    name: 'Amendment 3 lead identity: vendor tracking parameters and apply-page suffixes never hide the posting, and identifiers never collapse',
    run() {
      const pairs = [
        ['https://jobs.lever.co/northwind/0a1b2c3d-1111-2222-3333-444455556666', 'https://jobs.lever.co/northwind/0a1b2c3d-1111-2222-3333-444455556666?lever-origin=applied&lever-source%5B%5D=Google+Jobs'],
        ['https://jobs.lever.co/northwind/0a1b2c3d-1111-2222-3333-444455556666', 'https://jobs.lever.co/northwind/0a1b2c3d-1111-2222-3333-444455556666/apply?lever-source[]=Google+Jobs'],
        ['https://boards.greenhouse.io/northwind/jobs/123456', 'https://boards.greenhouse.io/northwind/jobs/123456?gh_src=abc123'],
        ['https://jobs.smartrecruiters.com/Northwind/743999-engineer', 'https://jobs.smartrecruiters.com/Northwind/743999-engineer?trid=1c7c4cd3-aaaa'],
        ['https://jobs.jobvite.com/northwind/job/oAbC123', 'https://jobs.jobvite.com/northwind/job/oAbC123?__jvst=Job+Board&__jvsd=Google+for+Jobs'],
        ['https://careers-northwind.icims.com/jobs/1234/engineer/job', 'https://careers-northwind.icims.com/jobs/1234/engineer/job?mode=job&iis=Google+Jobs&iisn=Google+Jobs'],
        ['https://northwind.wd5.myworkdayjobs.com/en-US/careers/job/Toronto/Engineer_R123', 'https://northwind.wd5.myworkdayjobs.com/en-US/careers/job/Toronto/Engineer_R123?source=Google_Jobs'],
        ['https://northwind.taleo.net/careersection/ex/jobdetail.ftl?job=1234', 'https://northwind.taleo.net/careersection/ex/jobdetail.ftl?job=1234&src=JB-10062'],
        ['https://apply.workable.com/northwind/j/ABC123/', 'https://apply.workable.com/northwind/j/ABC123/apply/?utm_source=google_jobs_apply&utm_medium=organic'],
        ['https://northwind.bamboohr.com/careers/12', 'https://northwind.bamboohr.com/careers/12?source=aWQ9MQ'],
        ['https://jobs.ashbyhq.com/northwind/abc', 'https://jobs.ashbyhq.com/northwind/abc/application?utm_source=x'],
        ['https://jobs.ashbyhq.com/northwind/abc', 'https://jobs.ashbyhq.com/northwind/abc/Application/'],
        ['https://careers.northwind.test/job/123', 'https://careers.northwind.test/job/123/apply'],
        ['https://careers.northwind.test/job/123', 'https://careers.northwind.test/job/123/applications/new'],
        ['https://careers.northwind.test/job/123', 'https://careers.northwind.test/job/123?ccuid=abc&codes=GJOBS&lang=en'],
        ['https://careers.northwind.test/job/123', 'https://careers.northwind.test/job/123?rx_source=google&rx_medium=organic&jobsource=gj&sourceid=9&trk=x&fbclid=z&gclid=y&ref=q&src=w'],
        ['https://careers.northwind.test/job/123?gh_jid=7', 'https://careers.northwind.test/job/123/apply?gh_jid=7&lever-via=zz&utm_campaign=c'],
      ];
      for (const [posting, lead] of pairs) assert.equal(canonicalLeadUrl(lead), canonicalLeadUrl(posting), lead);
      // A parameter that is not tracking identifies the posting, and an apply page is only stripped from a real posting path.
      for (const [one, other] of [
        ['https://careers.northwind.test/jobs?gh_jid=1', 'https://careers.northwind.test/jobs?gh_jid=2'],
        ['https://careers.northwind.test/jobs?id=1&lang=en', 'https://careers.northwind.test/jobs?id=2&lang=en'],
        ['https://northwind.taleo.net/jobdetail.ftl?job=1&src=x', 'https://northwind.taleo.net/jobdetail.ftl?job=2&src=x'],
        ['https://careers.northwind.test/view?rx_job=1&rx_source=g', 'https://careers.northwind.test/view?rx_job=2&rx_source=g'],
        ['https://careers.northwind.test/view?mode=edit', 'https://careers.northwind.test/view?mode=job'],
        ['https://careers.northwind.test/apply', 'https://careers.northwind.test/'],
        ['https://careers.northwind.test/job/123', 'https://careers.northwind.test/job/124'],
        ['https://careers.northwind.test/job/123/apply', 'https://careers.northwind.test/job/124/apply'],
        ['https://careers.northwind.test/job/123?req=a', 'https://careers.northwind.test/job/123?req=b'],
      ]) assert.notEqual(canonicalLeadUrl(one), canonicalLeadUrl(other), `${one} versus ${other}`);
    },
  },
];
