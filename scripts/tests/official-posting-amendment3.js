import assert from 'node:assert/strict';
import {
  domainBrandMatchesEmployer, leadingTitleSegment, proveBidirectionalOwnership, registrableDomain,
} from '../../electron/ipc/officialSourceHosts.js';
import {
  __debug, canonicalLeadUrl, descriptionOverlap, evaluateOfficialPostingMatch, flatPostingText, plainPostingText, selectOfficialPostingMatch,
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

const row = (extra = {}) => ({ title: 'Software Engineer', company: EMPLOYER, location: 'Lakeview, Ontario, Canada',
  snippet: lines(1, 8).join(' '), salary: '', salaryProvenance: 'unknown', url: 'https://www.linkedin.com/jobs/view/synthetic-role-30', ...extra });
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
      const scraped = row({ snippet: partial });
      const decision = selectOfficialPostingMatch(scraped, postings, { now: NOW });
      assert.equal(decision.outcome, 'found');
      assert.equal(decision.candidate.sourceUrl, postings[target].sourceUrl);
      assert.equal(evaluateOfficialPostingMatch(scraped, postings[target], { now: NOW, peerCandidates: postings }).anchor, 'description-anchor');
      // The shared process copy alone supplies nothing: the same text with only copy identifies no posting.
      const copyOnly = row({ snippet: `${PROCESS} ${ABOUT}` });
      assert.equal(selectOfficialPostingMatch(copyOnly, postings, { now: NOW }).outcome, 'not-found');
      assert.ok(descriptionOverlap(partial, postings[target].description, { peerDescriptions: postings.filter((_, index) => index !== target).map(item => item.description) }).anchored);
    },
  },
  {
    name: 'Amendment 3 description: shared copy with a same-title same-city sibling never anchors it, closed true role or not',
    async run() {
      const make = (index, extra = {}) => ({ title: 'Software Engineer', employer: EMPLOYER, location: { display: 'Lakeview, Ontario, Canada' },
        description: `${lines(4000 + index * 20, 10).join(' ')} ${PROCESS} ${ABOUT}`, sourceUrl: `https://careers.northwind.test/job/${index}`,
        ats: '', tenant: '', employerDomainProven: true, live: true, isListed: true, statusCode: 200, ...extra });
      const others = Array.from({ length: 18 }, (_, index) => make(index + 2, { title: `Specialist ${index}` }));
      const sibling = make(1); const closedTrue = make(0, { live: false, isListed: false, statusCode: 410 });
      const scraped = row({ snippet: `${lines(4000, 8).join(' ')} ${PROCESS} ${ABOUT}` });
      const withClosed = selectOfficialPostingMatch(scraped, [closedTrue, sibling, ...others], { now: NOW });
      assert.equal(withClosed.candidate, null); assert.equal(withClosed.outcome, 'closed');
      const withoutClosed = selectOfficialPostingMatch(scraped, [sibling, ...others], { now: NOW });
      assert.equal(withoutClosed.candidate, null); assert.equal(withoutClosed.outcome, 'not-found');
      assert.equal(evaluateOfficialPostingMatch(scraped, sibling, { now: NOW, peerCandidates: [sibling, ...others] }).reason, 'no-anchor');
    },
  },
  {
    name: 'Amendment 3 R1: the highest score wins only by a 0.05 margin, a closed best is closed and live near-ties are ambiguous',
    run() {
      const base = lines(7000, 40);
      const posting = (index, text, extra = {}) => ({ title: 'Software Engineer', employer: EMPLOYER, location: { display: 'Lakeview, Ontario, Canada' },
        description: text.join(' '), sourceUrl: `https://careers.northwind.test/job/${index}`, ats: '', tenant: '', employerDomainProven: true,
        live: true, isListed: true, statusCode: 200, ...extra });
      const others = Array.from({ length: 4 }, (_, index) => posting(100 + index, lines(7500 + index * 20, 10), { title: `Specialist ${index}` }));
      const scraped = row({ snippet: base.join(' ') });
      const exact = posting(1, base); const partial = posting(2, [...base.slice(0, 32), ...lines(8000, 8)]);
      assert.equal(selectOfficialPostingMatch(scraped, [exact, partial, ...others], { now: NOW }).candidate.sourceUrl, exact.sourceUrl, 'a clear winner');
      const near = posting(3, [...base.slice(0, 39), sentence(8100)]);
      assert.equal(selectOfficialPostingMatch(scraped, [exact, near, ...others], { now: NOW }).outcome, 'ambiguous', 'live postings within 0.05');
      const closedExact = posting(4, base, { live: false, isListed: false, statusCode: 404 });
      const closed = selectOfficialPostingMatch(scraped, [closedExact, partial, ...others], { now: NOW });
      assert.equal(closed.outcome, 'closed'); assert.equal(closed.candidate, null);
      const tie = selectOfficialPostingMatch(scraped, [closedExact, exact, ...others], { now: NOW });
      assert.equal(tie.outcome, 'closed', 'a closed twin tied for the best score is the scraped job');
      // A closed posting in another city or under another title never competes.
      const closedTokyo = posting(5, base, { live: false, isListed: false, statusCode: 404, location: { display: 'Tokyo, Japan' } });
      const closedOther = posting(6, base, { live: false, isListed: false, statusCode: 404, title: 'Staff Engineer' });
      assert.equal(selectOfficialPostingMatch(scraped, [closedTokyo, closedOther, exact, ...others], { now: NOW }).candidate.sourceUrl, exact.sourceUrl);
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
    name: 'Amendment 3 gram cache: a board larger than 512 postings stays cached, recently used entries survive and memory is bounded',
    run() {
      const { roleGrams, gramCacheStats } = __debug;
      const source = index => `${sentence(70000 + index)} ${sentence(80000 + index)}`;
      const { maxEntries, maxWeight } = gramCacheStats();
      assert.ok(maxEntries >= 4096 && maxWeight > 0);
      const first = source(0); const firstGrams = roleGrams(first);
      for (let index = 1; index <= 700; index++) roleGrams(source(index));
      assert.equal(roleGrams(first), firstGrams, 'the old 512-entry cap would have cleared it');
      // A board scanned repeatedly stays cached when it fits.
      const board = Array.from({ length: 700 }, (_, index) => source(1 + index));
      const cached = board.map(roleGrams);
      assert.ok(board.every((item, index) => roleGrams(item) === cached[index]));
      // Recent use protects an entry while newer ones push others out.
      const keep = source(900); const keepGrams = roleGrams(keep);
      for (let index = 1; index <= 5000; index++) {
        roleGrams(source(1000 + index));
        if (index % 100 === 0) assert.equal(roleGrams(keep), keepGrams, 'a recently used entry is not evicted');
      }
      for (let index = 1; index <= maxEntries + 10; index++) roleGrams(source(7000 + index));
      const stats = gramCacheStats();
      assert.ok(stats.entries <= maxEntries, `${stats.entries} entries`); assert.ok(stats.weight <= maxWeight, `${stats.weight} weight`);
      assert.notEqual(roleGrams(keep), keepGrams, 'an entry untouched for a full cache turnover is evicted');
      assert.equal(roleGrams(source(7000 + maxEntries + 10)), roleGrams(source(7000 + maxEntries + 10)), 'the newest entry is cached');
    },
  },
  {
    name: 'Amendment 3 role text: an About heading that names the role keeps its paragraph, and only company sections are dropped',
    run() {
      const { roleDescription } = __debug;
      const body = 'Build the dispatch scheduler for freight depots. Own the carrier ledger reconciliation service. Partner with finance on settlement files.';
      const requirements = 'Requirements\nFive years of experience with queues.';
      for (const heading of ['About this role', 'About This Role', 'About the job', 'About the position', 'About you', 'About You', 'About the opportunity',
        'About our team', 'About working here', 'About the role', 'ABOUT THE ROLE', 'About the internship']) {
        for (const text of [`${heading}\n${body}\n${requirements}`, `${heading}. ${body} Requirements Five years of experience with queues.`]) {
          assert.ok(roleDescription(text).includes('Build the dispatch scheduler'), `${heading}: ${roleDescription(text)}`);
        }
      }
      for (const heading of ['About us', 'About Us', 'About the Company', 'About Northwind', 'ABOUT NORTHWIND LABS', 'About Our Company', 'About The Trade Desk']) {
        const role = roleDescription(`${heading}\nNorthwind makes freight tools.\n${requirements}`);
        assert.ok(!role.includes('freight tools'), `${heading} paragraph is company copy`);
        assert.ok(role.includes('Five years'), heading);
      }
      // "About" in running prose is not a heading at all.
      assert.ok(roleDescription('About 40 percent of the work is reconciliation. Requirements Five years.').includes('40 percent'));
    },
  },
  {
    name: 'Amendment 3 role text: a company section ends at the next role heading, listed or not, and identical About-first text anchors',
    run() {
      const { roleDescription } = __debug;
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
        const text = layout.map(section).join('\n'); const role = roleDescription(text);
        for (const [head, seed, company] of layout) assert.equal(role.includes(sentence(seed)), !company, `${layout[0][0]} / ${head}`);
        assert.equal(descriptionOverlap(text, text).anchored, true, `${layout[0][0]} / ${layout[1][0]}`);
      }
      // The company copy itself is still dropped, including its own sub-headings and unbulleted benefit lines.
      const company = ['About Northwind', ...lines(300, 3), 'Our Mission', ...lines(310, 3), 'Perks', 'Health Insurance', 'Paid Time Off', 'Remote Work Stipend',
        'The Role', ...lines(320, 3)].join('\n');
      const role = roleDescription(company);
      for (const index of [300, 310]) assert.ok(!role.includes(sentence(index)), `company sentence ${index} is dropped`);
      assert.ok(!role.includes('Paid Time Off') && !role.includes('Remote Work Stipend'));
      assert.ok(role.includes(sentence(320)));
    },
  },
  {
    name: 'Amendment 3 role text: a sibling that differs only under an About heading naming the role never anchors, live true posting or not',
    run() {
      const requirements = lines(500, 8).join(' ');
      const posting = (id, text, extra = {}) => ({ title: 'Software Engineer', employer: EMPLOYER, location: { display: 'Lakeview, Ontario, Canada' }, description: text,
        sourceUrl: `https://careers.northwind.test/job/${id}`, ats: '', tenant: '', employerDomainProven: true, tenantProven: false, live: true, isListed: true, statusCode: 200, ...extra });
      const others = Array.from({ length: 6 }, (_, index) => posting(`o${index}`, lines(1000 + index * 30, 10).join(' '), { title: `Specialist ${index}` }));
      for (const heading of ['The Role', 'About the Role', 'About this role', 'About the job', 'About the position', 'About the opportunity']) {
        const make = seed => `${heading}\n${lines(seed, 8).join(' ')}\nRequirements\n${requirements}`;
        const truePosting = posting('true', make(100)); const sibling = posting('sibling', make(200));
        const scraped = row({ snippet: make(100) });
        // The true posting is closed or absent: the live sibling of another team is not it.
        const absent = selectOfficialPostingMatch(scraped, [sibling, ...others], { now: NOW });
        assert.equal(absent.outcome, 'not-found', heading); assert.equal(absent.candidate, null, heading);
        const closed = selectOfficialPostingMatch(scraped, [{ ...truePosting, live: false, isListed: false, statusCode: 410 }, sibling, ...others], { now: NOW });
        assert.equal(closed.candidate, null, heading);
        // Both live: the posting whose own summary matches wins, never the sibling.
        const both = selectOfficialPostingMatch(scraped, [sibling, truePosting, ...others], { now: NOW });
        assert.equal(both.outcome, 'found', heading); assert.equal(both.candidate.sourceUrl, truePosting.sourceUrl, heading);
      }
    },
  },
  {
    name: 'Amendment 3 deterministic anchors: an unanchored same-title sibling never voids a requisition or lead anchor, in any order',
    run() {
      const posting = (id, text, extra = {}) => ({ title: 'Software Engineer', employer: EMPLOYER, location: { display: 'Lakeview, Ontario, Canada' }, description: text.join(' '),
        sourceUrl: `https://careers.northwind.test/job/${id}`, ats: '', tenant: '', employerDomainProven: true, tenantProven: false, live: true, isListed: true, statusCode: 200, ...extra });
      const a = posting('a', lines(100, 10), { identifier: 'REQ-7' }); const b = posting('b', lines(200, 10), { identifier: 'REQ-9' });
      const others = Array.from({ length: 5 }, (_, index) => posting(`o${index}`, lines(1000 + index * 30, 10), { title: `Specialist ${index}` }));
      const summary = 'Short reformatted marketing summary of the role that shares no five word run with either official text at all today.';
      const byLead = row({ snippet: summary, applyOptions: [{ label: 'Apply on Northwind Labs', href: `${a.sourceUrl}?utm_source=google_jobs_apply` }] });
      const byUrl = row({ snippet: summary, url: a.sourceUrl });
      const byId = row({ snippet: summary, identifier: 'REQ-7' });
      const pools = [[a, b, ...others], [b, a, ...others], [...others, b, a], [b, ...others, a], [a, b]];
      for (const [label, job] of [['lead apply option', byLead], ['lead row url', byUrl], ['requisition id', byId]]) {
        for (const pool of pools) {
          const decision = selectOfficialPostingMatch(job, pool, { now: NOW });
          assert.equal(decision.outcome, 'found', `${label}: ${pool.map(item => item.sourceUrl.split('/').pop()).join(',')}`);
          assert.equal(decision.candidate.sourceUrl, a.sourceUrl, label);
        }
      }
      // Two candidates that really are named by the row stay ambiguous.
      const named = row({ snippet: summary, identifier: 'REQ-9', applyOptions: [{ label: 'Apply', href: a.sourceUrl }] });
      for (const pool of [[a, b, ...others], [b, a, ...others]]) assert.equal(selectOfficialPostingMatch(named, pool, { now: NOW }).outcome, 'ambiguous');
      // A sibling that itself anchors on the description is a real rival of an identifier anchor.
      const rival = row({ snippet: lines(200, 10).join(' '), identifier: 'REQ-7' });
      for (const pool of [[a, b, ...others], [b, a, ...others]]) assert.equal(selectOfficialPostingMatch(rival, pool, { now: NOW }).outcome, 'ambiguous');
      // A placeholder identifier (fewer than four characters) names no posting, so it does not override the unanchored sibling.
      const placeholder = row({ snippet: summary, identifier: 'A1' });
      for (const pool of [[{ ...a, identifier: 'A1' }, b, ...others], [b, { ...a, identifier: 'A1' }, ...others]]) {
        assert.equal(selectOfficialPostingMatch(placeholder, pool, { now: NOW }).outcome, 'ambiguous');
      }
      // Without any deterministic anchor the unanchored siblings stay unresolved: two of them are ambiguous and one alone is not a match.
      assert.equal(selectOfficialPostingMatch(row({ snippet: summary }), [a, b, ...others], { now: NOW }).outcome, 'ambiguous');
      assert.equal(selectOfficialPostingMatch(row({ snippet: summary }), [b, ...others], { now: NOW }).outcome, 'not-found');
    },
  },
  {
    name: 'Amendment 3 R2: stub peers that contribute no text never turn a small pool into an estimated one',
    run() {
      const posting = (id, text, extra = {}) => ({ title: 'Software Engineer', employer: EMPLOYER, location: { display: 'Lakeview, Ontario, Canada' }, description: text,
        sourceUrl: `https://careers.northwind.test/job/${id}`, ats: '', tenant: '', employerDomainProven: true, tenantProven: false, live: true, isListed: true, statusCode: 200, ...extra });
      const shared = lines(500, 14).join(' ');
      const sibling = posting('sibling', `${shared} ${lines(200, 2).join(' ')}`);
      const scraped = row({ snippet: `${shared} ${lines(100, 2).join(' ')}` });
      const containment = descriptionOverlap(scraped.snippet, sibling.description).containment;
      assert.ok(containment >= 0.85 && containment < 0.98, `the fixture sits between the anchor and the small-pool nesting: ${containment}`);
      const real = Array.from({ length: 3 }, (_, index) => posting(`o${index}`, lines(1000 + index * 30, 10).join(' '), { title: `Specialist ${index}` }));
      const stubs = ['See job details.', '', 'Apply now'].map((text, index) => posting(`s${index}`, text, { title: `Coordinator ${index}` }));
      const stubText = posting('s9', 'Details.', { title: 'Coordinator 9' });
      for (const pool of [[sibling, ...real], [sibling, ...real, ...stubs, stubText], [sibling, ...real, stubText, stubText, { ...stubText, sourceUrl: `${stubText.sourceUrl}x` }]]) {
        const decision = selectOfficialPostingMatch(scraped, pool, { now: NOW });
        assert.equal(decision.outcome, 'not-found', `${pool.length} postings`);
        assert.equal(evaluateOfficialPostingMatch(scraped, sibling, { now: NOW, peerCandidates: pool }).reason, 'no-anchor');
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
      // Through the evaluator: a Google apply link in a vendor shape is the lead anchor for that exact posting only.
      const target = { title: 'Software Engineer', employer: EMPLOYER, location: { display: 'Lakeview, Ontario, Canada' }, description: lines(100, 10).join(' '),
        sourceUrl: 'https://careers.northwind.test/job/123', ats: '', tenant: '', employerDomainProven: true, live: true, isListed: true, statusCode: 200 };
      const lead = href => row({ snippet: 'Short reformatted marketing summary of the role that shares no five word run with the official text at all today.',
        applyOptions: [{ label: 'Apply on Northwind Labs', href }] });
      assert.equal(evaluateOfficialPostingMatch(lead('https://careers.northwind.test/job/123/apply?trid=abc&lang=en&codes=GJOBS'), target, { now: NOW }).anchor, 'identifier-anchor');
      assert.equal(evaluateOfficialPostingMatch(lead('https://careers.northwind.test/job/124/apply?trid=abc'), target, { now: NOW }).reason, 'no-anchor');
    },
  },
  {
    name: 'Amendment 4 flat and sentence-case company regions never hide a differing sibling role summary',
    run() {
      const company = ['Northwind Labs builds workflow software for regional carriers.', 'We value steady progress and thoughtful conversations in every office.',
        'Our teams work across three time zones and meet in person twice a year.', 'We publish our engineering notes openly for the whole industry to read.'];
      const candidate = (id, description, extra = {}) => ({ title: 'Software Engineer', employer: EMPLOYER, location: { display: 'Lakeview, Ontario, Canada' }, description,
        sourceUrl: `https://careers.northwind.test/job/${id}`, employerDomainProven: true, live: true, isListed: true, statusCode: 200, ...extra });
      for (const flat of [false, true]) for (const heading of ['Your impact', 'A day in the life', 'The opportunity', "Who we're looking for", 'Your day to day', 'Why this role matters', 'Overview', 'Summary', 'Description']) {
        for (const requirements of ['What You Bring', 'Key Responsibilities', 'Minimum Qualifications']) {
          const make = seed => ['About Northwind Labs', ...company, heading, ...lines(seed, 4), requirements, ...lines(3000, 6)].join(flat ? ' ' : '\n');
          const actual = make(100); const sibling = candidate('sibling', make(500)); const scraped = row({ snippet: actual });
          for (const pool of [[sibling], [sibling, candidate('true', actual, { live: false, isListed: false, statusCode: 410 })]]) {
            const result = selectOfficialPostingMatch(scraped, pool, { now: NOW });
            assert.equal(result.candidate, null, `${flat ? 'flat' : 'structured'} / ${heading} / ${requirements} never picks the sibling`);
          }
          const deterministic = selectOfficialPostingMatch({ ...scraped, applyOptions: [{ label: 'Apply', href: sibling.sourceUrl }] }, [sibling], { now: NOW });
          assert.equal(deterministic.candidate?.sourceUrl, sibling.sourceUrl, 'an own lead remains independently decisive');
        }
      }
      // A short swallowed summary can be less than half the source, while a
      // huge company block can dominate any text leaked by a fixed cap.
      for (const [intro, count] of [[['Northwind builds freight tools.'], 100], [lines(8000, 200), 6]]) {
        const make = seed => ['About Northwind Labs', ...intro, 'An unfamiliar heading', ...lines(seed, 1), 'What You Bring', ...lines(3000, count)].join(' ');
        const sibling = candidate('sibling', make(500));
        assert.equal(selectOfficialPostingMatch(row({ snippet: make(100) }), [sibling], { now: NOW }).candidate, null, `${intro.length} company sentences / ${count} shared requirements`);
      }
    },
  },
  {
    name: 'Amendment 4 company openers drop this company and organization what we do and how we work copy',
    run() {
      for (const heading of ['About This Company', 'About This Organization', 'About What We Do', 'About How We Work']) {
        const retained = __debug.roleDescription(`${heading}\nNorthwind makes freight tools.\nResponsibilities\n${lines(100, 4).join('\n')}`);
        assert.ok(!retained.includes('freight tools'), heading);
        assert.ok(retained.includes(sentence(100)), heading);
      }
    },
  },
  {
    name: 'Amendment 4 structured scraped Overview and Opportunity retain safe matches against flat official text',
    run() {
      for (const heading of ['Overview', 'The Opportunity', 'Your impact', 'Your day to day', 'A day in the life', "Who we're looking for", 'Why this role matters']) {
        const parts = ['About Northwind Labs', ...lines(1000, 4), heading, ...lines(100, 5), 'What You Bring', ...lines(3000, 6)];
        const actual = parts.join(' '); const snippet = parts.join('\n');
        const candidate = { title: 'Software Engineer', employer: EMPLOYER, location: { display: 'Lakeview, Ontario, Canada' }, description: actual,
          sourceUrl: 'https://careers.northwind.test/job/true', employerDomainProven: true, live: true, isListed: true, statusCode: 200 };
        assert.equal(selectOfficialPostingMatch(row({ snippet }), [candidate], { now: NOW }).candidate?.sourceUrl, candidate.sourceUrl, heading);
      }
    },
  },
  {
    name: 'Amendment 5 company-only truncated snippets never anchor a live same-title sibling',
    run() {
      const company = lines(7000, 30);
      for (const heading of ['About Northwind Labs', 'About Us']) for (const flat of [false, true]) {
        for (const tagline of ['', 'Building tools for regional carriers', 'Description of our company']) {
          const join = parts => parts.filter(Boolean).join(flat ? ' ' : '\n');
          const official = join([heading, tagline, ...company, 'Responsibilities', ...lines(500, 8), 'What You Bring', ...lines(3000, 6)]);
          const candidate = { title: 'Software Engineer', employer: EMPLOYER, location: { display: 'Lakeview, Ontario, Canada' }, description: official,
            sourceUrl: 'https://careers.northwind.test/job/sibling', employerDomainProven: true, live: true, isListed: true, statusCode: 200 };
          for (const take of [5, 20, 24, 28, 30]) {
            const snippet = join([heading, tagline, ...company.slice(0, take)]);
            const decision = selectOfficialPostingMatch(row({ snippet }), [candidate], { now: NOW });
            assert.notEqual(decision.outcome, 'found', `${heading} / flat=${flat} / ${tagline} / ${take}`);
          }
        }
      }
    },
  },
  {
    name: 'Amendment 5 company corroboration tolerates char-truncated boundaries but still refuses interior rewrites',
    run() {
      const company = lines(7000, 5).join(' ');
      const official = ['About Northwind Labs', company, 'Responsibilities', ...lines(100, 8), 'Requirements', ...lines(3000, 6),
        'Benefits', 'We offer health coverage and paid time off for every employee.', 'Northwind Labs is an equal opportunity employer and welcomes every applicant.'].join('\n');
      const candidate = (id, description, extra = {}) => ({ title: 'Software Engineer', employer: EMPLOYER, location: { display: 'Lakeview, Ontario, Canada' }, description,
        sourceUrl: `https://careers.northwind.test/job/${id}`, employerDomainProven: true, live: true, isListed: true, statusCode: 200, ...extra });
      const peers = Array.from({ length: 6 }, (_, index) => candidate(`peer-${index}`, ['About Northwind Labs', company, 'Responsibilities', ...lines(1000 + index * 40, 8)].join('\n'), { title: `Specialist ${index}` }));
      for (let cut = 900; cut < official.length; cut += 3) {
        assert.equal(selectOfficialPostingMatch(row({ snippet: `${official.slice(0, cut)}…` }), [candidate('true', official), ...peers], { now: NOW }).outcome, 'found', `cut ${cut}`);
      }
      const rewritten = official.replace(sentence(104), sentence(9904));
      assert.notEqual(selectOfficialPostingMatch(row({ snippet: rewritten }), [candidate('true', official), ...peers], { now: NOW }).outcome, 'found');
    },
  },
];
