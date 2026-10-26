import assert from 'node:assert/strict';
import {
  domainBrandMatchesEmployer, leadingTitleSegment, proveBidirectionalOwnership, registrableDomain,
} from '../../electron/ipc/officialSourceHosts.js';
import {
  __debug, canonicalLeadUrl, descriptionOverlap, evaluateOfficialPostingMatch, flatPostingText, plainPostingText, selectOfficialPostingMatch, buildOfficialPostingComparisonSet,
} from '../../electron/ipc/officialPostingMatch.js';
import { buildOfficialPostingMatchRequest, validateOfficialPostingMatchResponse } from '../../electron/ipc/officialPostingBridge.js';
import { resolveOfficialPosting } from '../../electron/ipc/officialPostingResolver.js';

// AMENDMENT-3 sections 1-4 plus the small-pool resolutions R1 (best match with
// margin among same-identity postings) and R2 (a small pool never accepts on
// description alone). Synthetic names only.
const EMPLOYER = 'Northwind Labs';
const POSTER = 'Acme Talent Partners';
const ROOT = 'https://northwind.test/';
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

const boardJob = (extra = {}) => ({ id: 'req-one', title: 'Software Engineer', companyName: EMPLOYER, location: 'Lakeview, Ontario, Canada',
  descriptionPlain: lines(1, 8).join(' '), jobUrl: 'https://jobs.ashbyhq.com/northwind/req-one', isListed: true, ...extra });
const jsonld = (url, extra = {}) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', url, title: 'Software Engineer',
  hiringOrganization: { name: EMPLOYER, sameAs: ROOT }, description: lines(1, 8).join(' '),
  jobLocation: { address: { addressLocality: 'Lakeview', addressRegion: 'Ontario', addressCountry: 'Canada' } }, identifier: 'req-one', ...extra })}</script>`;
const boardApi = jobs => ({ body: JSON.stringify({ jobs }), contentType: 'application/json' });
const BOARD = 'https://api.ashbyhq.com/posting-api/job-board/northwind?includeCompensation=true';
const POSTING = 'https://jobs.ashbyhq.com/northwind/req-one';
function network(pages, requests = []) {
  return async url => {
    requests.push(url);
    const page = pages[url];
    if (!page) { const error = new Error('Fixture page is closed'); error.code = 'closed'; throw error; }
    return { url, contentType: 'text/html', statusCode: 200, ...(typeof page === 'string' ? { body: page } : page) };
  };
}
const row = (extra = {}) => ({ title: 'Software Engineer', company: EMPLOYER, location: 'Lakeview, Ontario, Canada',
  snippet: lines(1, 8).join(' '), salary: '', salaryProvenance: 'unknown', url: 'https://www.linkedin.com/jobs/view/synthetic-role-30', ...extra });
const otherJobs = count => Array.from({ length: count }, (_, index) => boardJob({ id: `other-${index}`, title: `Specialist ${index}`,
  jobUrl: `https://jobs.ashbyhq.com/northwind/other-${index}`, descriptionPlain: lines(100 + index * 10, 8).join(' ') }));
// Tie-breaker quote normalization fixtures. A converter renders lists as "* item" / "1. item" lines under an upper-cased heading, while a
// model quotes plain prose that may cross list items.
const NBSP = String.fromCharCode(160);
const converted = (sentences, heading = 'RESPONSIBILITIES') => [heading, ...sentences.map((item, index) => (
  index % 3 === 0 ? `* ${item}` : index % 3 === 1 ? `${index}. ${item}` : `  - ${item}`))].join('\n');
const joinGroups = (sentences, groups) => groups.map(group => group.map(index => sentences[index]).join(' '));
const quoteAnswer = (pairs, extra = {}) => ({ choice: 'P1', conflicts: [], distinguishing: [], ...extra, evidence: pairs.map(([scrapedQuote, officialQuote]) => ({ scrapedQuote, officialQuote })) });
const comparativeContext = (scrapedText, officialText, { peerDescriptions = [], rivalDescriptions = [] } = {}) => {
  const job = row({ snippet: scrapedText });
  const candidate = (id, description, title = job.title) => ({ title, employer: EMPLOYER, description, sourceUrl: `https://careers.northwind.test/job/${id}` });
  const option = (id, description) => ({ id, title: job.title, location: job.location, status: 'live', description, candidate: candidate(id, description) });
  return { job, options: [option('P1', officialText), ...rivalDescriptions.map((body, index) => option(`P${index + 2}`, body))],
    peerCandidates: peerDescriptions.map((body, index) => candidate(`peer-${index}`, body, `Specialist ${index}`)) };
};
function verifiedComparativeEvidence(scrapedText, officialText, answer, settings = {}) {
  const context = comparativeContext(scrapedText, officialText, settings);
  // These normalization fixtures supply a complete distinguishing answer from
  // their already quoted evidence; omission and wrong-source cases live in the bridge group.
  const distinguishing = context.options.slice(1).flatMap(option => {
    const pair = answer.evidence.find(pair => !flatPostingText(option.description).includes(flatPostingText(pair.officialQuote)));
    return pair ? [{ optionId: option.id, officialQuote: pair.officialQuote, reason: 'The quoted role duty distinguishes this option.' }] : [];
  });
  try { validateOfficialPostingMatchResponse({ ...answer, distinguishing }, context); return true; } catch { return false; }
}
function assertNoPosting(result) {
  assert.ok(['L5', 'L6'].includes(result.officialPosting.level), JSON.stringify(result.officialPosting));
  assert.equal(result.officialPosting.sourceUrl || '', '');
  assert.equal(result.officialPosting.officialApplyUrl || '', '');
  assert.equal(result.description, undefined);
}

// Section 1: a marketing-suffixed root title, no og:site_name, a careers page
// that links to the tenant and its posting, and a posting that points back.
function roundTripPages({ rootTitle = `${EMPLOYER} – The workflow platform for regional dispatch`, careersLinks = true, sameAs = ROOT, jobs = [boardJob(), ...otherJobs(5)], root = ROOT } = {}) {
  return {
    [root]: `<title>${rootTitle}</title><a href="/careers">Careers</a>`,
    [`${root}careers`]: `<title>Join the team</title>${careersLinks ? `<a href="https://jobs.ashbyhq.com/northwind">Open roles</a><a href="${POSTING}">Software Engineer</a>` : '<p>No openings listed.</p>'}`,
    'https://jobs.ashbyhq.com/northwind': '<main>Available roles</main>',
    [POSTING]: jsonld(POSTING, { hiringOrganization: { name: EMPLOYER, sameAs } }),
    [BOARD]: boardApi(jobs),
  };
}

export default [
  {
    name: 'Amendment 3 ownership: a mutual round trip proves a marketing-titled employer domain and its tenant (L2)',
    async run() {
      const requests = [];
      const result = await resolveOfficialPosting(row(), { fetch: network(roundTripPages(), requests), candidateUrls: [ROOT] });
      assert.equal(result.officialPosting.level, 'L2', JSON.stringify(result.officialPosting));
      assert.equal(result.officialPosting.sourceUrl, POSTING);
      assert.equal(result.officialPosting.employer, EMPLOYER);
      assert.ok(result.officialPosting.trail.includes('domain-proof'));
      assert.ok(result.officialPosting.trail.includes('description-anchor'));
      // A recruiter row reaches the same proof when the client is named by the row's own title.
      const recruiter = row({ company: POSTER, title: `Software Engineer at ${EMPLOYER}`, snippet: `Our client is hiring. ${lines(1, 8).join(' ')}` });
      const client = await resolveOfficialPosting(recruiter, { fetch: network(roundTripPages()), candidateUrls: [ROOT] });
      assert.equal(client.officialPosting.level, 'L2'); assert.equal(client.officialPosting.sourceUrl, POSTING);
    },
  },
  {
    name: 'Amendment 3 ownership: a recruiter-branded domain titled Careers at the employer is rejected',
    async run() {
      for (const [root, title] of [['https://acmetalent.test/', 'Acme Talent Partners | Executive Search'],
        ['https://northwindjobs.test/', `Careers at ${EMPLOYER} | ${POSTER}`]]) {
        const pages = roundTripPages({ root, rootTitle: title, sameAs: root });
        pages[`${root}careers`] = `<title>Careers at ${EMPLOYER}</title><a href="https://jobs.ashbyhq.com/northwind">Open roles</a><a href="${POSTING}">Software Engineer</a>`;
        const job = row({ company: POSTER, title: `Software Engineer at ${EMPLOYER}`, snippet: `Our client is hiring. ${lines(1, 8).join(' ')}` });
        const result = await resolveOfficialPosting(job, { fetch: network(pages), candidateUrls: [`${root}careers`] });
        assertNoPosting(result);
        assert.ok(result.officialPosting.trail.includes('tenant-unproven') || result.officialPosting.trail.includes('poster-tenant'), root);
      }
    },
  },
  {
    name: 'Amendment 3 ownership: a sameAs with no link back from the domain proves nothing',
    async run() {
      const pages = roundTripPages({ careersLinks: false });
      const result = await resolveOfficialPosting(row({ applyOptions: [{ label: 'Apply', href: POSTING }] }), { fetch: network(pages), candidateUrls: [ROOT] });
      assertNoPosting(result);
      assert.ok(result.officialPosting.trail.includes('tenant-unproven'));
      // A domain whose brand is wrong fails even when it links to the tenant and the tenant points back.
      const wrong = roundTripPages({ rootTitle: 'Unrelated Group – Marketing', root: 'https://elsewhere.test/', sameAs: 'https://elsewhere.test/' });
      const mismatch = await resolveOfficialPosting(row(), { fetch: network(wrong), candidateUrls: ['https://elsewhere.test/'] });
      assertNoPosting(mismatch);
    },
  },
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
    name: 'Amendment 3 description: an employer-site posting with a Phenom-style board resolves to L1 through the resolver',
    async run() {
      const target = 3; const urls = Array.from({ length: 8 }, (_, index) => `https://northwind.test/job/${index}`);
      const pages = { [ROOT]: '<title>Northwind Labs</title><a href="/careers">Careers</a>',
        [`${ROOT}careers`]: `<title>Careers</title>${urls.map(url => `<a href="${url}">Role</a>`).join('')}` };
      urls.forEach((url, index) => {
        pages[url] = jsonld(url, { title: index === target ? 'Software Engineer' : `Specialist ${index}`, identifier: `req-${index}`,
          description: `${lines(3000 + index * 20, 10).join(' ')} ${PROCESS} ${ABOUT}` });
      });
      const partial = lines(3000 + target * 20, 6).join('\n');
      const result = await resolveOfficialPosting(row({ snippet: partial }), { fetch: network(pages), candidateUrls: [ROOT] });
      assert.equal(result.officialPosting.level, 'L1', JSON.stringify(result.officialPosting));
      assert.equal(result.officialPosting.sourceUrl, urls[target]);
      assert.ok(result.officialPosting.trail.includes('description-anchor'));
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
    name: 'Amendment 3 description: a twin role in another city sharing 31 of 32 lines never erases or replaces the right city (33 posting board)',
    async run() {
      const shared = lines(5000, 31);
      const vancouver = boardJob({ id: 'van', title: 'Data Engineer', location: 'Vancouver, British Columbia, Canada', jobUrl: 'https://jobs.ashbyhq.com/northwind/van',
        descriptionPlain: [...shared, sentence(5100)].join(' ') });
      const tokyo = boardJob({ id: 'tok', title: 'Data Engineer', location: 'Tokyo, Japan', jobUrl: 'https://jobs.ashbyhq.com/northwind/tok',
        descriptionPlain: [...shared, sentence(5200)].join(' ') });
      const others = Array.from({ length: 31 }, (_, index) => boardJob({ id: `x-${index}`, title: `Specialist ${index}`, jobUrl: `https://jobs.ashbyhq.com/northwind/x-${index}`,
        descriptionPlain: `${lines(6000 + index * 20, 10).join(' ')} ${PROCESS}` }));
      const pages = { [ROOT]: '<title>Northwind Labs</title><a href="/careers">Careers</a>',
        [`${ROOT}careers`]: '<title>Careers at Northwind Labs</title><a href="https://jobs.ashbyhq.com/northwind">Open roles</a>',
        'https://jobs.ashbyhq.com/northwind': '<main>Available roles</main>', [BOARD]: boardApi([tokyo, ...others, vancouver]) };
      const rowFor = (location, tail) => row({ title: 'Data Engineer', location, snippet: [...shared, sentence(tail)].join(' ') });
      const run = job => resolveOfficialPosting(job, { fetch: network(pages), candidateUrls: [ROOT] });
      const van = await run(rowFor('Vancouver, British Columbia, Canada', 5100));
      assert.equal(van.officialPosting.sourceUrl, 'https://jobs.ashbyhq.com/northwind/van', JSON.stringify(van.officialPosting));
      const tok = await run(rowFor('Tokyo, Japan', 5200));
      assert.equal(tok.officialPosting.sourceUrl, 'https://jobs.ashbyhq.com/northwind/tok', JSON.stringify(tok.officialPosting));
      // Without the Vancouver posting the Tokyo twin is never selected for the Vancouver row.
      pages[BOARD] = boardApi([tokyo, ...others]);
      assertNoPosting(await run(rowFor('Vancouver, British Columbia, Canada', 5100)));
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
    name: 'Amendment 3 R2: fewer than four peers never accepts on description alone, with or without a closed true peer',
    async run() {
      const process = lines(9100, 11).join(' ');
      const actual = `${sentence(9200)} ${process}`; const sibling = `${sentence(9300)} ${process}`;
      assert.equal(descriptionOverlap(actual, sibling).anchored, true, 'the overlap itself is unchanged for no-peer input');
      const jobs = (...items) => items;
      const page = list => ({ [ROOT]: '<title>Northwind Labs</title><a href="/careers">Careers</a>',
        [`${ROOT}careers`]: '<title>Careers at Northwind Labs</title><a href="https://jobs.ashbyhq.com/northwind">Open roles</a>',
        'https://jobs.ashbyhq.com/northwind': '<main>Roles</main>', [BOARD]: boardApi(list) });
      const live = boardJob({ id: 'sibling', jobUrl: 'https://jobs.ashbyhq.com/northwind/sibling', descriptionPlain: sibling });
      const closed = boardJob({ isListed: false, descriptionPlain: actual });
      // (i) the exact conflict: a closed true peer and a live wrong-role sibling sharing unlabelled process text.
      const conflict = await resolveOfficialPosting(row({ snippet: actual }), { fetch: network(page(jobs(closed, live))), candidateUrls: [ROOT] });
      assertNoPosting(conflict);
      assert.equal(conflict.officialPosting.outcome, 'closed');
      assert.ok(conflict.officialPosting.trail.includes('closed')); assert.ok(conflict.officialPosting.trail.includes('no-anchor'));
      // (ii) the same texts with no peer at all.
      const lone = await resolveOfficialPosting(row({ snippet: actual }), { fetch: network(page(jobs(live))), candidateUrls: [ROOT] });
      assertNoPosting(lone);
      assert.ok(lone.officialPosting.trail.includes('no-anchor'));
      // Deterministic anchors still accept before any comparative judgment.
      const own = boardJob({ descriptionPlain: lines(1, 8).join(' ') });
      const identified = await resolveOfficialPosting(row({ identifier: 'req-one' }), { fetch: network(page(jobs(own))), candidateUrls: [ROOT] });
      assert.equal(identified.officialPosting.level, 'L2'); assert.ok(identified.officialPosting.trail.includes('identifier-anchor'));
      // Two texts that each keep a role sentence the other lacks: no independent anchor, no match.
      const twoSided = await resolveOfficialPosting(row({ snippet: `${lines(1, 7).join(' ')} ${sentence(9998)}` }),
        { fetch: network(page(jobs(boardJob({ descriptionPlain: `${lines(1, 7).join(' ')} ${sentence(9997)}` })))), candidateUrls: [ROOT] });
      assertNoPosting(twoSided); assert.ok(twoSided.officialPosting.trail.includes('no-anchor'));
      // Nesting resolution: an identical text is one text nested in the other and accepts without a peer.
      const nested = await resolveOfficialPosting(row(), { fetch: network(page(jobs(own))), candidateUrls: [ROOT] });
      assert.equal(nested.officialPosting.level, 'L2'); assert.ok(nested.officialPosting.trail.includes('description-anchor'));
    },
  },
  {
    name: 'Amendment 5 comparative validation handles a small pool after the deterministic evaluator refuses non-nested text',
    run() {
      const text = lines(1, 12); const quotes = [text[0], text[5], text[10]];
      const candidate = { title: 'Software Engineer', employer: EMPLOYER, location: { display: 'Lakeview, Ontario, Canada' }, description: text.join(' '),
        sourceUrl: 'https://careers.northwind.test/job/1', ats: '', tenant: '', employerDomainProven: true, live: true, isListed: true, statusCode: 200 };
      const scraped = row({ snippet: text.join(' ') });
      const partial = row({ snippet: `${text.slice(0, 11).join(' ')} ${sentence(9998)}` });
      assert.equal(evaluateOfficialPostingMatch(partial, candidate, { now: NOW }).reason, 'no-anchor');
      assert.equal(evaluateOfficialPostingMatch(scraped, candidate, { now: NOW }).anchor, 'description-anchor');
      const { options } = buildOfficialPostingComparisonSet(partial, [candidate], { now: NOW });
      const answer = quoteAnswer(quotes.map(quote => [quote, quote]));
      assert.deepEqual(validateOfficialPostingMatchResponse(answer, { job: partial, options }), answer);
    },
  },
  {
    name: 'Amendment 5 comparative quotes require unique role evidence rather than rejecting every shared pair',
    run() {
      const text = lines(1, 12); const quotes = [text[0], text[5], text[10]];
      const answer = quoteAnswer(quotes.map(quote => [quote, quote]));
      assert.equal(verifiedComparativeEvidence(text.join(' '), text.join(' '), answer), true);
      assert.equal(verifiedComparativeEvidence(text.join(' '), text.join(' '), answer, { peerDescriptions: [`${quotes[0]} Other work.`] }), true, 'one other-title peer is not a frequency estimate');
      assert.equal(verifiedComparativeEvidence(text.join(' '), text.join(' '), answer, { rivalDescriptions: [`${quotes[2]} Other work.`] }), true, 'other quoted role duties distinguish the chosen posting');
      assert.equal(verifiedComparativeEvidence(text.join(' '), text.join(' '), answer, { rivalDescriptions: [text.join(' ')] }), false, 'an identical same-identity rival has no distinctive evidence');
      const copy = lines(9500, 4).join(' ');
      const crowd = Array.from({ length: 6 }, (_, index) => `${lines(9600 + index * 10, 6).join(' ')} ${copy}`);
      const boilerplate = quoteAnswer([sentence(9500), sentence(9501), sentence(9502)].map(quote => [quote, quote]));
      const official = `${lines(9700, 3).join(' ')} ${sentence(9500)} ${lines(9710, 3).join(' ')} ${sentence(9501)} ${lines(9720, 3).join(' ')} ${sentence(9502)}`;
      assert.equal(verifiedComparativeEvidence(official, official, boilerplate), true);
      assert.equal(verifiedComparativeEvidence(official, official, boilerplate, { peerDescriptions: crowd }), false, 'max(3, 20%) frequency copy never counts');
    },
  },
  {
    name: 'Amendment 3 lead identity: the row url or one of its own apply options is an identifier anchor, nothing else is',
    async run() {
      const url = 'https://northwind.test/jobs/one';
      const pages = { [ROOT]: '<title>Northwind Labs</title>', [url]: jsonld(url, { description: lines(500, 8).join(' ') }) };
      const unrelated = row({ snippet: lines(1, 8).join(' ') });
      const exactUrl = await resolveOfficialPosting({ ...unrelated, url }, { fetch: network(pages) });
      assert.equal(exactUrl.officialPosting.level, 'L1', JSON.stringify(exactUrl.officialPosting));
      assert.ok(exactUrl.officialPosting.trail.includes('identifier-anchor'));
      const tracked = await resolveOfficialPosting({ ...unrelated, url: `${url}?utm_source=board#top` }, { fetch: network(pages) });
      assert.equal(tracked.officialPosting.level, 'L1', 'tracking parameters are removed before comparing');
      const viaApply = await resolveOfficialPosting({ ...unrelated, applyOptions: [{ label: 'Apply on Northwind Labs', href: url }] }, { fetch: network(pages) });
      assert.equal(viaApply.officialPosting.level, 'L1'); assert.ok(viaApply.officialPosting.trail.includes('identifier-anchor'));
      // A job-id parameter belongs to the identity: another id is another posting.
      const idUrl = `${url}?gh_jid=77`;
      const idPages = { [ROOT]: '<title>Northwind Labs</title>', [idUrl]: jsonld(idUrl, { description: lines(500, 8).join(' ') }) };
      assert.equal((await resolveOfficialPosting({ ...unrelated, url: idUrl }, { fetch: network(idPages) })).officialPosting.level, 'L1');
      const otherId = await resolveOfficialPosting({ ...unrelated, url: `${url}?gh_jid=88`, applyOptions: [{ label: 'Apply', href: idUrl.replace('gh_jid=77', 'gh_jid=77') }] }, { fetch: network(idPages), candidateUrls: [idUrl] });
      assert.equal(otherId.officialPosting.level, 'L1', 'one of the row\'s own apply options still names the posting');
      const wrongId = await resolveOfficialPosting({ ...unrelated, url: `${url}?gh_jid=88` }, { fetch: network(idPages), candidateUrls: [idUrl] });
      assertNoPosting(wrongId);
      assert.equal(canonicalLeadUrl('https://Northwind.test/jobs/one/?utm_source=x&gh_jid=7&ref=a#top'), 'https://northwind.test/jobs/one?gh_jid=7');
      assert.equal(canonicalLeadUrl('http://northwind.test/jobs/one'), '');
      assert.equal(canonicalLeadUrl('https://northwind.test/jobs/one?jobId=9&id=2'), 'https://northwind.test/jobs/one?id=2&jobId=9');
    },
  },
  {
    name: 'Amendment 3 lead identity: the same url from description text or a bridge candidate is not an anchor',
    async run() {
      const url = 'https://northwind.test/jobs/one';
      const pages = { [ROOT]: '<title>Northwind Labs</title>', [url]: jsonld(url, { description: lines(500, 8).join(' ') }) };
      const unrelated = row({ snippet: lines(1, 8).join(' ') });
      const fromText = await resolveOfficialPosting({ ...unrelated, snippet: `${unrelated.snippet} Apply at ${url}.` }, { fetch: network(pages) });
      assertNoPosting(fromText);
      assert.ok(fromText.officialPosting.trail.includes('no-anchor'));
      const fromBridge = await resolveOfficialPosting(unrelated, { fetch: network(pages), research: async () => [{ employer: EMPLOYER, postingUrl: url }] });
      assertNoPosting(fromBridge);
      assert.ok(fromBridge.officialPosting.trail.includes('no-anchor'));
      const direct = await resolveOfficialPosting(unrelated, { fetch: network(pages), candidateUrls: [url] });
      assertNoPosting(direct);
    },
  },
  {
    name: 'Amendment 5 comparative quote normalization: converter list markers, headings and typography never hide the quoted wording',
    run() {
      const sentences = lines(1, 12);
      const groups = joinGroups(sentences, [[0, 1], [5, 6, 7], [10, 11]]);
      const answer = quoteAnswer(groups.map(quote => [quote, quote]));
      const official = converted(sentences); const plain = sentences.join(' ');
      // The fixture is only meaningful when a raw search could not find a quote that crosses list items.
      assert.equal(official.replace(/\s+/gu, ' ').includes(groups[0]), false);
      assert.equal(verifiedComparativeEvidence(plain, official, answer), true, 'a bulleted official text and unbulleted quotes');
      assert.equal(verifiedComparativeEvidence(official, plain, answer), true, 'a bulleted scraped text and unbulleted quotes');
      assert.equal(verifiedComparativeEvidence(official, official, answer), true);
      const nbsp = sentences.map((sentence, index) => `${NBSP}• ${sentence.replace(' and ', `${NBSP}and `)}${index % 2 ? NBSP : ''}`).join('\r\n');
      assert.equal(verifiedComparativeEvidence(nbsp, official, answer), true, 'bullet glyphs, non-breaking spaces and CRLF');
      // Quotes copied with their own markers and line breaks locate the same way.
      const marked = official.split('\n');
      const withMarkers = quoteAnswer([[groups[0], marked.slice(1, 3).join('\n')], [groups[1], marked.slice(6, 9).join('\n')], [groups[2], marked.slice(11, 13).join('\n')]]);
      assert.equal(verifiedComparativeEvidence(plain, official, withMarkers), true);
      // Verbatim evidence preserves case, including text upper-cased by a converter.
      const shouted = converted(sentences.map((sentence, index) => (index >= 5 && index <= 7 ? sentence.toUpperCase() : sentence)));
      assert.equal(verifiedComparativeEvidence(plain, shouted, answer), false);
      const shoutedAnswer = quoteAnswer(groups.map((quote, index) => [quote, index === 1 ? quote.toUpperCase() : quote]));
      assert.equal(verifiedComparativeEvidence(plain, shouted, shoutedAnswer), true);
    },
  },
  {
    name: 'Amendment 5 comparative quote normalization: typographic quotes, dashes and non-breaking spaces compare as plain punctuation',
    run() {
      const typed = ['Partner with dispatchers on the scheduler\'s nightly rebalancing pass, including carrier lane exceptions during peak volume.',
        'Draft the "quarterly lane review" for finance - covering tariff tables, fuel cards and settlement files.',
        'Maintain yard queue dashboards so operations managers can review dock windows before the evening cutoff.'];
      const typeset = value => value.replace(/'/gu, '’').replace(/"([^"]*)"/gu, '“$1”').replace(/ - /gu, ' — ').replace(/ on the /u, `${NBSP}on${NBSP}the `);
      const fill = lines(300, 3);
      const scraped = [fill[0], typed[0], fill[1], typed[1], fill[2], typed[2]].join(' ');
      const official = converted([fill[0], ...typed.slice(0, 1).map(typeset), fill[1], typeset(typed[1]), fill[2], typeset(typed[2])]);
      assert.notEqual(official.replace(/\s+/gu, ' ').includes(typed[1]), true, 'fixture: the typeset text differs from the plain quotes');
      const answer = quoteAnswer(typed.map(quote => [quote, quote]));
      assert.equal(verifiedComparativeEvidence(scraped, official, answer), true);
      assert.equal(verifiedComparativeEvidence(official, scraped, answer), true);
      // The reverse direction: typeset quotes against plain text.
      assert.equal(verifiedComparativeEvidence(scraped, scraped, quoteAnswer(typed.map(quote => [typeset(quote), typeset(quote)]))), true);
      // Punctuation is unified, not removed: a different word is still a different quote.
      const reworded = quoteAnswer([[typed[0], typed[0]], [typed[1], typed[1].replace('finance', 'treasury')], [typed[2], typed[2]]]);
      assert.equal(verifiedComparativeEvidence(scraped, official, reworded), false);
    },
  },
  {
    name: 'Amendment 5 comparative quote normalization: a quote absent from either text still fails, even when the other text needs normalization to match',
    run() {
      const sentences = lines(1, 12);
      const groups = joinGroups(sentences, [[0, 1], [5, 6, 7], [10, 11]]);
      const plain = sentences.join(' '); const official = converted(sentences);
      const altered = quote => quote.replace(' and ', ' plus ');
      const dropped = quote => quote.replace(' and ', ' ');
      const withMiddle = replacement => quoteAnswer(groups.map((quote, index) => [quote, index === 1 ? replacement : quote]));
      for (const [scrapedText, officialText] of [[official, plain], [plain, official], [official, official]]) {
        assert.equal(verifiedComparativeEvidence(scrapedText, officialText, quoteAnswer(groups.map(quote => [quote, quote]))), true);
        for (const side of [0, 1]) {
          for (const change of [altered, dropped]) {
            const pairs = groups.map((quote, index) => (index === 1 ? [side === 0 ? change(quote) : quote, side === 1 ? change(quote) : quote] : [quote, quote]));
            assert.equal(verifiedComparativeEvidence(scrapedText, officialText, quoteAnswer(pairs)), false,
              `one quote absent from the ${side === 0 ? 'scraped' : 'official'} text (${change.name})`);
          }
        }
      }
      void withMiddle;
      // A quote present in only one of the texts fails for the other, however each is normalized.
      const onlyOfficial = `${converted(sentences)}\n* ${sentence(9990)}`;
      const lone = quoteAnswer([[groups[0], groups[0]], [groups[1], groups[1]], [sentence(9990), sentence(9990)]]);
      assert.equal(verifiedComparativeEvidence(plain, onlyOfficial, lone), false);
      assert.equal(verifiedComparativeEvidence(onlyOfficial, plain, lone), false);
      // Normalization joins adjacent list items, never non-adjacent ones.
      assert.equal(verifiedComparativeEvidence(plain, official, quoteAnswer([[`${sentences[0]} ${sentences[2]}`, `${sentences[0]} ${sentences[2]}`], [groups[1], groups[1]], [groups[2], groups[2]]])), false);
      // Still required: three pairs, eight words, no conflicts, two separated parts.
      assert.equal(verifiedComparativeEvidence(plain, official, quoteAnswer(groups.slice(0, 2).map(quote => [quote, quote]))), false);
      assert.equal(verifiedComparativeEvidence(plain, official, quoteAnswer(groups.map(quote => [quote, quote]), { conflicts: ['different team'] })), false);
      assert.equal(verifiedComparativeEvidence(plain, official, quoteAnswer(groups.map(() => [groups[0], groups[0]]))), false, 'repeating one passage');
      const short = quoteAnswer([[groups[0], groups[0]], [groups[1], groups[1]], ['* Calibrate nightly freight lanes', 'Calibrate nightly freight lanes']]);
      assert.equal(verifiedComparativeEvidence(plain, official, short), false, 'a marker is not a word');
    },
  },
  {
    name: 'Amendment 5 comparative quote normalization: numbered rivals and boilerplate crowds are compared in the same plain form',
    run() {
      const sentences = lines(1, 12);
      const groups = joinGroups(sentences, [[0, 1], [5, 6, 7], [10, 11]]);
      const plain = sentences.join(' '); const official = converted(sentences);
      const answer = quoteAnswer(groups.map(quote => [quote, quote]));
      const numberedRival = sentences.map((item, index) => `${index + 1}. ${item}`).join('\n');
      assert.equal(verifiedComparativeEvidence(plain, official, answer, { peerDescriptions: [], rivalDescriptions: [numberedRival] }), false, 'a quote crossing numbered items of a gate-passing rival');
      assert.equal(verifiedComparativeEvidence(plain, official, answer, { peerDescriptions: [], rivalDescriptions: [converted(lines(700, 12))] }), true);
      // Boilerplate frequency counts numbered copies of the same wording as the same wording.
      const crowd = Array.from({ length: 6 }, (_, index) => `${converted(lines(800 + index * 10, 6))}\n${numberedRival}`);
      assert.equal(verifiedComparativeEvidence(plain, official, answer, { peerDescriptions: crowd, rivalDescriptions: [] }), false);
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
    name: 'Amendment 5 comparative quote normalization: a converter-rendered official text validates after deterministic refusal',
    run() {
      const text = lines(1, 12);
      const candidate = { title: 'Software Engineer', employer: EMPLOYER, location: { display: 'Lakeview, Ontario, Canada' }, description: converted(text),
        sourceUrl: 'https://careers.northwind.test/job/1', ats: '', tenant: '', employerDomainProven: true, live: true, isListed: true, statusCode: 200 };
      const partial = row({ snippet: `${text.slice(0, 11).join(' ')} ${sentence(9998)}` });
      const groups = joinGroups(text, [[0, 1], [4, 5, 6], [9, 10]]);
      const answer = quoteAnswer(groups.map(quote => [quote, quote]));
      assert.equal(evaluateOfficialPostingMatch(partial, candidate, { now: NOW }).reason, 'no-anchor');
      const { options } = buildOfficialPostingComparisonSet(partial, [candidate], { now: NOW });
      assert.deepEqual(validateOfficialPostingMatchResponse(answer, { job: partial, options }), answer);
      const invented = quoteAnswer(groups.map((quote, index) => (index === 1 ? [quote, quote.replace(' and ', ' plus ')] : [quote, quote])));
      assert.throws(() => validateOfficialPostingMatchResponse(invented, { job: partial, options }));
    },
  },
  {
    name: 'Amendment 3 bridge: the match prompt shows the plain form the host checks, and the validator verifies in that form',
    run() {
      const sentences = lines(1, 12);
      const groups = joinGroups(sentences, [[0, 1], [5, 6, 7], [10, 11]]);
      const scrapedDescription = converted(sentences, 'About the role'); const officialDescription = converted(sentences);
      const context = comparativeContext(scrapedDescription, officialDescription);
      const request = buildOfficialPostingMatchRequest({ ...context, run: 'A' });
      const supplied = JSON.parse(request.prompt.split('BEGIN UNTRUSTED POSTING COMPARISON JSON\n')[1].split('\nEND UNTRUSTED POSTING COMPARISON JSON')[0]);
      assert.equal(supplied.scraped.description, plainPostingText(scrapedDescription));
      assert.equal(supplied.options[0].description, plainPostingText(officialDescription));
      for (const shown of [supplied.scraped.description, supplied.options[0].description]) {
        assert.equal(/^[ \t]*(?:[*•-]|\d{1,3}[.)])[ \t]/mu.test(shown), false, 'no list marker survives at a line start');
        assert.ok(sentences.every(sentence => shown.includes(sentence)), 'every sentence is shown verbatim');
      }
      const answer = quoteAnswer(groups.map(quote => [quote, quote]));
      assert.deepEqual(request.responseValidator(answer), answer);
      assert.deepEqual(validateOfficialPostingMatchResponse(JSON.stringify(answer), context), answer);
      // A quote copied with its markers and line breaks is the same wording.
      const marked = officialDescription.split('\n');
      const copied = quoteAnswer([[groups[0], marked.slice(1, 3).join('\n')], [groups[1], marked.slice(6, 9).join('\n')], [groups[2], marked.slice(11, 13).join('\n')]]);
      assert.deepEqual(validateOfficialPostingMatchResponse(copied, context), copied);
      const failing = pairs => { try { validateOfficialPostingMatchResponse(quoteAnswer(pairs), context); } catch (error) { return error.correctionRuleIds || []; } return null; };
      const quote = groups[1].replace(' and ', ' plus ');
      assert.ok(failing([[groups[0], groups[0]], [quote, groups[1]], [groups[2], groups[2]]])?.includes('LOOKUP_OFFICIAL_MATCH_VERBATIM'), 'absent from the scraped text');
      assert.ok(failing([[groups[0], groups[0]], [groups[1], quote], [groups[2], groups[2]]])?.includes('LOOKUP_OFFICIAL_MATCH_VERBATIM'), 'absent from the official text');
      // The comparative verbatim check remains case-sensitive.
      assert.ok(failing([[groups[0], groups[0]], [groups[1].toUpperCase(), groups[1]], [groups[2], groups[2]]])?.includes('LOOKUP_OFFICIAL_MATCH_VERBATIM'));
      assert.ok(failing(groups.slice(0, 2).map(item => [item, item]))?.includes('LOOKUP_OFFICIAL_MATCH_COUNT'));
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
    name: 'Amendment 3 deterministic anchors: the resolver returns the lead posting whichever same-title sibling is read first',
    async run() {
      const second = 'https://jobs.ashbyhq.com/northwind/req-two';
      const jobs = [boardJob(), boardJob({ id: 'req-two', jobUrl: second, descriptionPlain: lines(300, 8).join(' ') }), ...otherJobs(5)];
      const pages = roundTripPages({ jobs }); pages[second] = jsonld(second, { identifier: 'req-two', description: lines(300, 8).join(' ') });
      const summary = 'Short reformatted marketing summary of this role with different wording from the official text so no five word run is shared.';
      const mention = `${summary} Also see ${second} for a related opening.`;
      const apply = [{ label: 'Apply on Northwind Labs', href: POSTING }];
      for (const job of [row({ snippet: summary, applyOptions: apply }), row({ snippet: mention, applyOptions: apply }), row({ snippet: mention, url: POSTING })]) {
        const result = await resolveOfficialPosting(job, { fetch: network(pages), candidateUrls: [] });
        assert.equal(result.officialPosting.level, 'L2', JSON.stringify(result.officialPosting));
        assert.equal(result.officialPosting.sourceUrl, POSTING);
        assert.ok(result.officialPosting.trail.includes('identifier-anchor'), JSON.stringify(result.officialPosting.trail));
      }
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
  {
    name: 'Amendment 3 ownership: a recruiter tenant whose slug extends the poster name is still the poster tenant, even when it names the client',
    async run() {
      const root = ROOT;
      for (const slug of ['acme-talent', 'acme-careers', 'acme-jobs', 'acmetalentjobs', 'acme-recruiting', 'acmetalentpartnersinc']) {
        const url = `https://jobs.ashbyhq.com/${slug}/req-one`;
        const pages = { [root]: `<title>${EMPLOYER}</title>`, [url]: jsonld(url, { hiringOrganization: { name: EMPLOYER, sameAs: root } }),
          [`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`]: boardApi([boardJob({ jobUrl: url })]) };
        const job = row({ company: POSTER, title: `Software Engineer at ${EMPLOYER}`, snippet: `Our client is hiring. ${lines(1, 8).join(' ')}`, applyOptions: [{ label: 'Apply', href: url }] });
        const result = await resolveOfficialPosting(job, { fetch: network(pages), candidateUrls: [] });
        assertNoPosting(result);
        assert.ok(result.officialPosting.trail.includes('poster-tenant'), `${slug}: ${JSON.stringify(result.officialPosting.trail)}`);
      }
    },
  },
];
