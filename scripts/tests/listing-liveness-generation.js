import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import electronPkg from 'electron';
import {
  checkListingForGeneration, createListingLivenessProbe, decideGenerationListingCheck,
  getListingLivenessProbeCounts, isProbeableListingHost, normalizeListingAudit,
} from '../../electron/ipc/listingLivenessProbe.js';
import {
  getPreparedOfficialPosting, prepareOfficialPostingForGeneration, registerOfficialPostingGenerationHandlers,
} from '../../electron/ipc/officialPostingGeneration.js';
import { LISTING_LIVENESS_RULES } from '../../electron/ipc/listingLiveness.js';

const AT = Date.parse('2026-01-03T12:00:00Z');
const job = (extra = {}) => ({ title: 'Synthetic Platform Builder', company: 'Northwind Labs', location: 'Lakeview, Ontario',
  source: 'linkedin', sourceJobKey: 'synthetic-liveness-one', url: 'https://www.linkedin.com/jobs/view/synthetic-one',
  snippet: 'A synthetic position that exercises the Generate listing check.', ...extra });
const state = (verdict, basis, at = AT - 60_000) => ({ verdict, basis, board: 'linkedin', at: new Date(at).toISOString() });
const marker = () => ({ board: 'linkedin', reason: 'linkedin-no-longer-accepting', at: new Date(AT - 60_000).toISOString() });
const miss = (extra = {}) => ({ level: 'L5', outcome: 'not-found', employer: 'Northwind Labs', trail: ['bridge-research'], ...extra });
const ambiguous = () => ({ level: 'L6', outcome: 'ambiguous', employer: '', trail: ['bridge-research', 'ambiguous'] });
const official = () => ({ level: 'L4', outcome: 'link-only', employer: 'Northwind Labs',
  sourceUrl: 'https://northwind.test/jobs/synthetic-one',
  officialApplyUrl: 'https://northwind.test/jobs/synthetic-one', trail: ['description-anchor'] });
const evidence = (extra = {}) => ({ requestedUrl: job().url, finalUrl: job().url, httpStatus: 200,
  title: 'Synthetic Platform Builder - Northwind Labs', h1: 'Synthetic Platform Builder', expectedTitle: 'Synthetic Platform Builder',
  expectedCompany: 'Northwind Labs', expectedLocation: 'Lakeview, Ontario',
  chromeText: 'Synthetic Platform Builder Northwind Labs is hiring engineers to build reliable tools. Apply now for this role.',
  descriptionText: 'Engineers will build tools and improve operations.', descriptionIsPage: false,
  titleMatchesPage: true, redirectedAway: false, closedHits: [], openSignals: [],
  jsonLd: { validThrough: '', isListed: null }, ...extra });
const calibration = (active = false, demotedAt = null) => ({
  snapshot: async () => ({ rulesFor: key => ({
    ...LISTING_LIVENESS_RULES[key],
    openRules: LISTING_LIVENESS_RULES[key].openRules.map(rule => ({ ...rule, state: active ? 'active' : 'shadow' })),
  }) }),
  latestDemotedAt: async () => demotedAt,
  recordAiAnswer: async () => ({ promoted: [], demoted: [] }),
});
async function withRefKeepAlive(run) {
  const keepAlive = setInterval(() => {}, 1000);
  try { return await run(); } finally { clearInterval(keepAlive); }
}
const deadline = () => AT + 8 * 60_000;
const decision = (row, posting, verdict, basis, listingOverride = false) =>
  decideGenerationListingCheck({ job: row, posting, verdict, basis, at: AT, listingOverride });
const args = row => ({ nodeId: 'synthetic-board', cardId: 'synthetic-card',
  manualAiRunId: 'synthetic-generation-run', job: row });

export default [
  {
    name: 'Capture navigation pins keep one LinkedIn detail visit and no second Dice fetch',
    run() {
      const source = fs.readFileSync(new URL('../../electron/extractors/apiExtractors.js', import.meta.url), 'utf8');
      const linkedInStart = source.indexOf('export async function enrichLinkedInDescriptionsBrowser(');
      const linkedInLoopStart = source.indexOf('for (let i = 0; i < enriched.length; i++) {', linkedInStart);
      const linkedInLoopEnd = source.indexOf('  } finally {', linkedInLoopStart);
      assert.ok(linkedInStart >= 0 && linkedInLoopStart > linkedInStart && linkedInLoopEnd > linkedInLoopStart);
      const linkedInLoop = source.slice(linkedInLoopStart, linkedInLoopEnd);
      assert.equal((linkedInLoop.match(/\bpage\s*\.\s*goto\s*\(/gu) || []).length, 1,
        'the LinkedIn detail loop must dispatch one page navigation per attempt');

      const diceStart = source.indexOf('export async function enrichDiceDescriptions(');
      const diceEnd = source.indexOf('\n}\n', diceStart);
      assert.ok(diceStart >= 0 && diceEnd > diceStart);
      const dice = source.slice(diceStart, diceEnd);
      assert.equal((dice.match(/\bsafeApiFetch\s*\(url\b/gu) || []).length, 1,
        'the Dice detail loop needs its existing page fetch');
      assert.equal((dice.match(/\bfetchHtmlClean\s*\(/gu) || []).length, 0,
        'Dice must classify the HTML from its existing fetch');
    },
  },
  {
    name: 'Capture navigation pin keeps the ZipRecruiter liveness stamp reachable',
    run() {
      const source = fs.readFileSync(new URL('../../electron/ipc/browser/manualScraper.js', import.meta.url), 'utf8');
      const expansionStart = source.indexOf('async function expandDescriptions(');
      const mergeStart = source.indexOf('enhanced[i] = mergeExpandedJobDetail(job, {', expansionStart);
      const continuation = source.indexOf('if (text) expandedCount++', mergeStart);
      assert.ok(expansionStart >= 0 && mergeStart > expansionStart && continuation > mergeStart);
      const stampPath = source.slice(mergeStart, continuation);
      assert.match(stampPath, /if \(sourceId === 'ziprecruiter'\) \{\s*const stamped = await captureZipRecruiterListingLiveness\(/u);
      assert.doesNotMatch(stampPath, /\bif\s*\(\s*false\s*\)/u,
        'ZipRecruiter detail capture must not be disabled by a dead branch');
    },
  },
  {
    name: 'Generate host predicate mirrors the card fallback and sends a Google apply link to its actual host',
    async run() {
      for (const url of ['https://linkedin.com/jobs/view/one', 'http://www.linkedin.com/jobs/view/one',
        'https://ca.indeed.com/viewjob?jk=one', 'https://www.ziprecruiter.com/jobs/one',
        'https://www.dice.com/job-detail/one', 'https://remoteok.com/jobs/one',
        'https://weworkremotely.com/jobs/one']) assert.equal(isProbeableListingHost(url), true, url);
      for (const url of ['https://www.glassdoor.com/job/one', 'https://www.google.com/search?q=job',
        'https://jobs.ashbyhq.com/northwind/one', 'https://northwind.test/jobs/one',
        'https://indeed.com.evil.com/viewjob?jk=one', 'https://remoteok.com.evil.com/jobs/one'])
        assert.equal(isProbeableListingHost(url), false, url);
      const calls = [];
      const visit = name => async () => { calls.push(name); return evidence(); };
      const row = job({ source: 'google', url: 'https://www.linkedin.com/jobs/view/synthetic-one' });
      const probe = createListingLivenessProbe({ job: row, visitLinkedIn: visit('linkedin'),
        visitIndeed: visit('indeed'), visitZipRecruiter: visit('zip'), fetchDiceHtml: visit('dice'),
        withProfileLock: fn => fn(), paceLinkedIn: async () => {} });
      const result = await probe.probe(row.url);
      assert.deepEqual(calls, ['linkedin']);
      assert.equal(result.board, 'google');
      assert.equal(result.ruleKey, 'linkedin');
      const spoof = 'https://indeed.com.evil.com/viewjob?jk=one';
      assert.equal((await probe.probe(spoof)).unknown, 'unobservable');
      assert.deepEqual(calls, ['linkedin'], 'spoofed Indeed host never gets a browser visit');
      const employer = job({ source: 'linkedin', url: 'https://northwind.test/jobs/synthetic-one' });
      const employerProbe = createListingLivenessProbe({ job: employer, visitLinkedIn: visit('wrong-source'),
        withProfileLock: fn => fn(), paceLinkedIn: async () => {} });
      assert.equal((await employerProbe.probe(employer.url)).unknown, 'unobservable');
      assert.deepEqual(calls, ['linkedin'], 'the source label cannot send an employer URL to LinkedIn');
    },
  },
  {
    name: 'Generate RemoteOK and WeWorkRemotely fetch generic HTML evidence and can confirm open or closed',
    async run() {
      const calls = [];
      const html = '<title>Synthetic Platform Builder - Northwind Labs</title>'
        + '<main><h1>Synthetic Platform Builder</h1><div class="job-description">'
        + 'Build synthetic platform tools and support reliable operations for a distributed team. '
        + 'The role includes engineering, testing, documentation and collaboration with colleagues.</div>'
        + '<button data-testid="apply-button">Apply</button></main>';
      for (const url of ['https://remoteok.com/jobs/synthetic-one',
        'https://weworkremotely.com/remote-jobs/synthetic-one']) {
        const row = job({ source: url.includes('remoteok') ? 'remoteok' : 'weworkremotely', url });
        const probe = createListingLivenessProbe({ job: row, withProfileLock: fn => fn(),
          fetchGenericHtml: async requested => { calls.push(requested); return { ok: true, status: 200,
            finalUrl: requested, html }; },
          rulesFor: key => ({ ...LISTING_LIVENESS_RULES[key], openRules: LISTING_LIVENESS_RULES[key].openRules
            .map(rule => ({ ...rule, state: 'active' })) }) });
        const page = await probe.probe(url);
        assert.equal(page.ruleKey, 'generic');
        assert.equal(page.titleMatchesPage, true);
        assert.ok(page.openSignals.some(signal => signal.ruleId === 'generic-enabled-apply'));
        const result = await checkListingForGeneration({ job: row, posting: miss(), probe,
          calibrationStore: calibration(true), now: () => AT, deadline: deadline() });
        assert.equal(result.listingCheck.action, 'proceed');
        assert.equal(result.listingAudit.outcome, 'open');
      }
      assert.equal(calls.length, 4, 'each direct probe and Generate check makes one HTML visit');
      const closedUrl = 'https://remoteok.com/jobs/synthetic-closed';
      const closedRow = job({ source: 'remoteok', url: closedUrl });
      const closedProbe = createListingLivenessProbe({ job: closedRow, withProfileLock: fn => fn(),
        fetchGenericHtml: async () => ({ ok: true, status: 404, finalUrl: closedUrl, html: '' }) });
      const closed = await checkListingForGeneration({ job: closedRow, posting: miss(), probe: closedProbe,
        calibrationStore: calibration(), now: () => AT, deadline: deadline() });
      assert.equal(closed.listingCheck.action, 'refuse-final');
      assert.equal(closed.listingLiveness.verdict, 'closed');
    },
  },
  {
    name: 'Generate RemoteOK and WeWorkRemotely treat a Cloudflare wall or failed HTML visit as unobservable',
    async run() {
      for (const [url, response] of [
        ['https://remoteok.com/jobs/synthetic-one', { ok: true, status: 200,
          html: '<title>Just a moment...</title><body>Checking your browser before accessing this job.</body>' }],
        ['https://weworkremotely.com/remote-jobs/synthetic-one', { ok: true, status: 403,
          html: '<title>Verify you are human</title><body>Additional verification required.</body>' }],
        ['https://remoteok.com/jobs/synthetic-two', { ok: false, error: 'synthetic fetch failure' }],
      ]) {
        const row = job({ source: url.includes('remoteok') ? 'remoteok' : 'weworkremotely', url });
        let visits = 0;
        const probe = createListingLivenessProbe({ job: row, withProfileLock: fn => fn(),
          fetchGenericHtml: async () => { visits += 1; return { ...response, finalUrl: url }; } });
        assert.ok((await probe.probe(url)).unknown, 'wall and failed visits do not become listing evidence');
        const result = await checkListingForGeneration({ job: row, posting: miss(), probe,
          calibrationStore: calibration(), now: () => AT, deadline: deadline() });
        assert.equal(visits, 2, 'the HTML fetch must run for the direct probe and Generate check');
        assert.equal(result.listingCheck.action, 'proceed');
        assert.equal(result.listingAudit.outcome, 'unobservable');
      }
      for (const url of ['https://www.glassdoor.com/job/synthetic-one',
        'https://www.google.com/search?q=synthetic-job']) {
        const row = job({ url });
        assert.equal(isProbeableListingHost(url), false);
        assert.equal((await createListingLivenessProbe({ job: row }).probe(url)).unknown, 'unobservable');
      }
    },
  },
  {
    name: 'Generate variant check probes four observable links and omits only structurally or AI confirmed closure',
    async run() {
      const { checkPostingVariantsForGeneration } = await import('../../electron/ipc/listingLivenessProbe.js');
      const variants = [
        { location: 'Card only', url: 'https://www.google.com/search?q=synthetic-platform' },
        { location: 'Closed structural', url: 'https://www.linkedin.com/jobs/view/synthetic-closed-structural' },
        { location: 'Open', url: 'https://www.linkedin.com/jobs/view/synthetic-open' },
        { location: 'Unknown', url: 'https://www.linkedin.com/jobs/view/synthetic-unknown' },
        { location: 'Closed AI', url: 'https://www.linkedin.com/jobs/view/synthetic-closed-ai' },
        { location: 'Unprobed', url: 'https://www.linkedin.com/jobs/view/synthetic-fifth' },
      ];
      const visits = []; const paced = []; let aiCalls = 0;
      const probe = createListingLivenessProbe({ job: job(), withProfileLock: fn => fn(),
        paceLinkedIn: async () => { paced.push(true); },
        visitLinkedIn: async url => {
          visits.push(url);
          if (url.includes('closed-structural')) return evidence({ requestedUrl: url, finalUrl: url,
            httpStatus: 404, chromeText: '' });
          if (url.includes('synthetic-open')) return evidence({ requestedUrl: url, finalUrl: url,
            openSignals: [{ ruleId: 'linkedin-enabled-apply', state: 'active' }] });
          if (url.includes('synthetic-unknown')) return { unknown: 'challenge' };
          return evidence({ requestedUrl: url, finalUrl: url,
            chromeText: 'Synthetic Platform Builder at Northwind Labs. This job is no longer available. '
              + 'The remaining page describes synthetic tools and reliable engineering work.',
            closedHits: [{ ruleId: 'no-longer-available', insideDescription: false,
              context: 'This job is no longer available.' }] });
        }, rulesFor: key => ({ ...LISTING_LIVENESS_RULES[key], openRules: LISTING_LIVENESS_RULES[key].openRules
          .map(rule => ({ ...rule, state: 'active' })) }) });
      const before = structuredClone(variants);
      const kept = await checkPostingVariantsForGeneration({ job: job(), variants, probe,
        bridgeAvailable: true, calibrationStore: calibration(true), now: () => AT, deadline: deadline(),
        callText: async (_prompt, request) => { aiCalls += 1;
          return request.responseValidator({ rows: [{ id: 'r1', verdict: 'closed', quote: 'This job is no longer available.' }] }); } });
      assert.equal(visits.length, 4);
      assert.equal(paced.length, 4, 'LinkedIn variants use the shared pacing gate');
      assert.equal(aiCalls, 1);
      assert.deepEqual(kept.map(variant => variant.location), ['Card only', 'Open', 'Unknown', 'Unprobed']);
      assert.deepEqual(variants, before, 'variant checks do not mutate the scraped row');
    },
  },
  {
    name: 'Generate variant check shares the tail deadline and preserves undecided variants without changing primary',
    async run() {
      const { checkPostingVariantsForGeneration } = await import('../../electron/ipc/listingLivenessProbe.js');
      const variants = [
        { location: 'First', url: 'https://www.dice.com/job-detail/synthetic-first' },
        { location: 'Second', url: 'https://www.dice.com/job-detail/synthetic-second' },
      ];
      const row = job(); const before = structuredClone(row);
      let clock = AT; const visits = [];
      const kept = await checkPostingVariantsForGeneration({ job: row, variants,
        probe: { probe: async url => { visits.push(url); clock = deadline();
          return evidence({ requestedUrl: url, finalUrl: url, jsonLd: { isListed: false, validThrough: '' } }); } },
        bridgeAvailable: true, calibrationStore: calibration(), now: () => clock, deadline: deadline(),
        callText: async () => { throw new Error('variant AI must not run after the tail deadline'); } });
      assert.deepEqual(visits, [variants[0].url]);
      assert.deepEqual(kept.map(variant => variant.location), ['First', 'Second']);
      assert.deepEqual(row, before, 'variant check cannot revise the primary row or action');
    },
  },
  {
    name: 'Generate variant check keeps unclear and unsupported closed answers',
    async run() {
      const { checkPostingVariantsForGeneration } = await import('../../electron/ipc/listingLivenessProbe.js');
      const variants = [
        { location: 'Unclear', url: 'https://www.dice.com/job-detail/synthetic-unclear' },
        { location: 'Unsupported', url: 'https://www.dice.com/job-detail/synthetic-unsupported' },
      ];
      let calls = 0;
      const kept = await checkPostingVariantsForGeneration({ job: job(), variants,
        probe: { probe: async url => evidence({ requestedUrl: url, finalUrl: url,
          chromeText: 'Synthetic Platform Builder at Northwind Labs. This job is no longer available. '
            + 'The remaining page describes synthetic tools and reliable engineering work.',
          closedHits: [{ ruleId: 'no-longer-available', insideDescription: false,
            context: 'This job is no longer available.' }] }) },
        bridgeAvailable: true, calibrationStore: calibration(), now: () => AT, deadline: deadline(),
        callText: async () => ({ rows: [{ id: 'r1', verdict: ++calls === 1 ? 'unclear' : 'closed',
          quote: calls === 1 ? '' : 'A quote absent from this synthetic page.' }] }) });
      assert.equal(calls, 2);
      assert.deepEqual(kept.map(variant => variant.location), ['Unclear', 'Unsupported']);
    },
  },
  {
    name: 'Generate probe keeps one visit, returns unknown for walls and other-host 404, and keeps same-host 404 structural',
    async run() {
      const row = job(); const lock = fn => fn();
      for (const [raw, expected] of [
        [{ httpStatus: 429, chromeText: '' }, 'http-wall'],
        [{ httpStatus: 0, chromeText: '' }, 'http-wall'],
        [{ httpStatus: 404, finalUrl: 'https://northwind.test/jobs/one', chromeText: '' }, 'other-host-not-found'],
        [{ unknown: 'challenge' }, 'challenge'],
      ]) {
        const probe = createListingLivenessProbe({ job: row, visitLinkedIn: async () => ({ ...evidence(), ...raw }),
          withProfileLock: lock, paceLinkedIn: async () => {} });
        assert.equal((await probe.probe(row.url)).unknown, expected);
      }
      const probe = createListingLivenessProbe({ job: row,
        visitLinkedIn: async () => ({ ...evidence(), httpStatus: 404, chromeText: '' }),
        withProfileLock: lock, paceLinkedIn: async () => {} });
      assert.equal((await probe.probe(row.url)).httpStatus, 404);
    },
  },
  {
    name: 'Generate lock and visit deadlines return unknown without leaving an opened visit behind',
    async run() {
      const row = job();
      const lockTimed = createListingLivenessProbe({ job: row, lockWaitMs: 5,
        withProfileLock: (_fn, signal) => new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
        paceLinkedIn: async () => {} });
      assert.equal((await lockTimed.probe(row.url)).unknown, 'lock-timeout');
      let closed = false;
      const visitTimed = createListingLivenessProbe({ job: row, visitMs: 5,
        withProfileLock: fn => fn(), paceLinkedIn: async () => {},
        visitLinkedIn: async (_url, { signal }) => {
          try {
            await new Promise((_resolve, reject) =>
              signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
          } finally { closed = true; }
        } });
      assert.equal((await visitTimed.probe(row.url)).unknown, 'visit-timeout');
      assert.equal(closed, true);
    },
  },
  {
    name: 'Generate LinkedIn guest pacing gate separates two rapid one-page visits',
    async run() {
      const starts = [];
      const probe = createListingLivenessProbe({ job: job(), withProfileLock: fn => fn(),
        visitLinkedIn: async () => { starts.push(Date.now()); return evidence(); } });
      await Promise.all([probe.probe(job().url), probe.probe(job().url)]);
      assert.equal(starts.length, 2);
      assert.ok(starts[1] - starts[0] >= 2_400, `guest visits were only ${starts[1] - starts[0]}ms apart`);
    },
  },
  {
    name: 'Generate LinkedIn pacing queue cancels a waiting visit immediately',
    async run() {
      let visits = 0;
      const probe = createListingLivenessProbe({ job: job(), withProfileLock: fn => fn(),
        visitLinkedIn: async () => { visits += 1; return evidence(); } });
      await probe.probe(job().url);
      const pacing = probe.probe(job().url);
      const controller = new AbortController();
      const started = Date.now();
      const waiting = probe.probe(job().url, { signal: controller.signal });
      setTimeout(() => controller.abort(new Error('synthetic-user-cancel')), 20);
      try {
        await assert.rejects(waiting, /synthetic-user-cancel/u);
        assert.ok(Date.now() - started < 750, 'Cancel must not wait for LinkedIn guest pacing');
      } finally { await pacing; }
      assert.equal(visits, 2, 'the cancelled visit must not dispatch');
    },
  },
  {
    name: 'Generate decision matrix is official-first and distinguishes settled, ambiguous, pending-marker and hold',
    async run() {
      const row = job();
      assert.equal(decision(row, official(), 'closed', 'structural').listingCheck.action, 'proceed');
      assert.equal(decision(row, miss(), 'closed', 'ai').listingCheck.action, 'refuse-final');
      assert.equal(decision(row, ambiguous(), 'closed', 'ai').message,
        'Closed on LinkedIn — several official postings match');
      assert.equal(decision(row, { ...miss(), trail: ['bridge-unavailable'] }, 'closed', 'ai').message,
        'Closed on LinkedIn — official posting not checked yet');
      assert.equal(decision(row, miss(), 'pending', 'closed-marker').message,
        'Possibly closed on LinkedIn — not confirmed yet');
      assert.equal(decision(row, miss(), 'unknown', 'both').listingCheck.action, 'refuse-retry');
      assert.equal(decision(row, miss(), 'pending', 'neither').listingCheck.action, 'hold');
      assert.equal(decision(row, miss(), 'unclear', 'ai').listingCheck.action, 'hold');
      assert.equal(decision(row, miss(), 'open', 'ai').listingCheck.action, 'proceed');
      assert.equal(decision(row, miss(), 'unobservable', 'unobservable').listingAudit.outcome, 'unobservable');
      assert.equal(decision(row, miss(), 'closed', 'ai', true).listingCheck.action, 'proceed');
      assert.equal(decision(row, miss(), 'pending', 'closed-marker', true).listingCheck.action, 'proceed');
      const override = decision(row, miss(), 'unclear', 'ai', true);
      assert.equal(override.listingCheck.action, 'proceed');
      assert.equal(override.listingCheck.override, true);
      assert.equal(override.listingAudit.outcome, 'override');
      assert.equal(normalizeListingAudit({ outcome: 'unavailable' }).outcome, 'unavailable');
      assert.equal(normalizeListingAudit({ outcome: 'alternate', basis: 'ai', at: new Date(AT).toISOString() })?.outcome,
        'alternate');
      assert.equal(normalizeListingAudit({ outcome: 'open', basis: 'ai', at: 'invalid' }), null);
    },
  },
  {
    name: 'Generate stored closed never probes and fresh open skips only after the latest demotion',
    async run() {
      let visits = 0;
      const probe = { probe: async () => { visits += 1; return evidence({ httpStatus: 404, chromeText: '' }); } };
      const closed = await checkListingForGeneration({ job: job({ listingLiveness: state('closed', 'structural'),
        boardClosed: marker() }), posting: miss(), probe, calibrationStore: calibration(), now: () => AT, deadline: deadline() });
      assert.equal(closed.listingCheck.action, 'refuse-final');
      assert.equal(visits, 0);
      const fresh = await checkListingForGeneration({ job: job({ listingLiveness: state('open', 'open-marker') }),
        posting: miss(), probe, calibrationStore: calibration(false, new Date(AT - 120_000).toISOString()),
        now: () => AT, deadline: deadline() });
      assert.equal(fresh.listingCheck.action, 'proceed');
      assert.equal(visits, 0);
      const demoted = await checkListingForGeneration({ job: job({ listingLiveness: state('open', 'open-marker') }),
        posting: miss(), probe, calibrationStore: calibration(false, new Date(AT - 60_000).toISOString()),
        now: () => AT, deadline: deadline() });
      assert.equal(demoted.listingCheck.action, 'refuse-final');
      assert.equal(visits, 1);
      assert.equal(demoted.listingLiveness.verdict, 'closed');
    },
  },
  {
    name: 'Generate official-live skips the probe and an open record older than 24 hours is rechecked',
    async run() {
      let visits = 0;
      const probe = { probe: async () => { visits += 1; return evidence({ httpStatus: 404, chromeText: '' }); } };
      const officialResult = await checkListingForGeneration({ job: job(),
        posting: official(), probe, calibrationStore: calibration(), now: () => AT, deadline: deadline() });
      assert.equal(officialResult.listingCheck.action, 'proceed');
      assert.equal(visits, 0, 'a live official posting wins before a listing probe');
      const old = job({ listingLiveness: state('open', 'open-marker', AT - 25 * 60 * 60_000) });
      const rechecked = await checkListingForGeneration({ job: old, posting: miss(), probe,
        calibrationStore: calibration(), now: () => AT, deadline: deadline() });
      assert.equal(visits, 1, 'a stored open record expires after 24 hours');
      assert.equal(rechecked.listingCheck.action, 'refuse-final');
      assert.equal(rechecked.listingLiveness.verdict, 'closed');
    },
  },
  {
    name: 'Generate fresh-open demotion lookup follows the URL host when the source label differs',
    async run() {
      const keys = []; let visits = 0;
      const row = job({ source: 'google', listingLiveness: { ...state('open', 'ai'), board: 'google' } });
      const result = await checkListingForGeneration({ job: row, posting: miss(),
        probe: { probe: async () => { visits += 1; return evidence({ httpStatus: 404, chromeText: '' }); } },
        calibrationStore: { latestDemotedAt: async key => {
          keys.push(key);
          return key === 'linkedin' ? new Date(AT - 30_000).toISOString() : null;
        } },
        now: () => AT, deadline: deadline() });
      assert.deepEqual(keys, ['linkedin']);
      assert.equal(visits, 1);
      assert.equal(result.listingCheck.action, 'refuse-final');
    },
  },
  {
    name: 'Generate probe open clears a legacy marker, while unknown preserves it and refuses possibly closed',
    async run() {
      const row = job({ boardClosed: marker() });
      const openEvidence = evidence({ openSignals: [{ ruleId: 'linkedin-enabled-apply', state: 'active' }] });
      const open = await checkListingForGeneration({ job: row, posting: miss(),
        probe: { probe: async () => openEvidence }, calibrationStore: calibration(true),
        now: () => AT, deadline: deadline() });
      assert.equal(open.listingCheck.action, 'proceed');
      assert.equal(open.listingLiveness.verdict, 'open');
      assert.equal(open.boardClosed, null);
      const unknown = await checkListingForGeneration({ job: row, posting: miss(),
        probe: { probe: async () => ({ unknown: 'challenge' }) }, calibrationStore: calibration(),
        now: () => AT, deadline: deadline() });
      assert.equal(unknown.listingCheck.action, 'refuse-retry');
      assert.match(unknown.message, /^Possibly closed on LinkedIn/u);
      assert.deepEqual(unknown.boardClosed, marker());
    },
  },
  {
    name: 'Generate single-row structured AI accepts isListed false, then a short budget keeps pending and final posting',
    async run() {
      const seen = []; let calibrated = 0;
      const row = job();
      const page = evidence({ jsonLd: { isListed: false, validThrough: '' }, closedHits: [] });
      const store = { ...calibration(), recordAiAnswer: async () => { calibrated += 1; } };
      const options = { job: row, posting: miss(), probe: { probe: async () => page },
        calibrationStore: store, bridgeAvailable: true, now: () => AT };
      const closed = await checkListingForGeneration({ ...options, deadline: deadline(),
        callText: async (_prompt, request) => { seen.push(request.task);
          return { rows: [{ id: 'r1', verdict: 'closed', quote: '' }] }; } });
      assert.deepEqual(seen, ['job-listing-liveness']);
      assert.equal(calibrated, 1);
      assert.equal(closed.listingCheck.action, 'refuse-final');
      assert.equal(closed.boardClosed.reason, 'ai-confirmed-closed');
      let skippedAiCalls = 0;
      const pending = await checkListingForGeneration({ ...options, deadline: AT + 89_999,
        callText: async () => { skippedAiCalls += 1; return { rows: [{ id: 'r1', verdict: 'closed', quote: '' }] }; } });
      assert.equal(skippedAiCalls, 0, 'the sub-90-second floor must skip the AI');
      assert.equal(pending.listingCheck.verdict, 'pending');
      assert.equal(pending.listingLiveness.basis, 'closed-marker');
      assert.equal(pending.listingCheck.action, 'refuse-retry');
      let unavailableAiCalls = 0;
      await checkListingForGeneration({ ...options, bridgeAvailable: false, deadline: deadline(),
        callText: async () => { unavailableAiCalls += 1; return { rows: [{ id: 'r1', verdict: 'closed', quote: '' }] }; } });
      assert.equal(unavailableAiCalls, 0, 'the unavailable worker pool must skip the AI');
    },
  },
  {
    name: 'Generate prepare releases its official slot before the probe tail and carries a typed audit record',
    async run() {
      const row = job({ url: 'https://northwind.test/jobs/synthetic-one', source: 'linkedin' });
      let held = false; let visits = 0;
      const result = await prepareOfficialPostingForGeneration(args(row), {
        projectJob: value => value, slots: { acquire: async () => { held = true; return () => { held = false; }; } },
        store: { find: async () => null },
        bridgeStatus: async () => ({ enabled: false }),
        resolve: async jobs => ({ jobs: jobs.map(value => ({ ...value, officialPosting: miss({ trail: ['bridge-unavailable'] }) })) }),
        listingProbe: { probe: async () => { visits += 1; assert.equal(held, false); return evidence(); } },
        now: () => AT,
      });
      assert.equal(visits, 0, 'an unobservable host skips the probe');
      assert.equal(result.listingCheck.action, 'proceed');
      assert.equal(result.listingAudit, undefined, 'audit stays in the trusted prepared record');
      const trusted = getPreparedOfficialPosting(result.resolutionId, row, { now: AT });
      assert.equal(trusted.listingAudit.outcome, 'unobservable');
      assert.equal(result.listingLiveness, null);
      assert.equal(result.boardClosed, null);
      assert.equal(typeof result.message, 'string');
      assert.equal(result.officialPosting.level, 'L5');
      const probed = await prepareOfficialPostingForGeneration(args(job()), {
        slots: { acquire: async () => { held = true; return () => { held = false; }; } },
        store: { find: async () => null }, bridgeStatus: async () => ({
          enabled: true, link: { state: 'linked' }, chat: { pool: { active: true } },
        }),
        resolve: async jobs => ({ jobs: jobs.map(value => ({ ...value, officialPosting: miss() })) }),
        listingProbe: { probe: async () => {
          visits += 1; assert.equal(held, false); return evidence({ httpStatus: 404, chromeText: '' });
        } },
        calibrationStore: calibration(), now: () => AT,
      });
      assert.equal(visits, 1);
      assert.equal(probed.listingCheck.action, 'refuse-final');
      assert.equal(probed.officialPosting.level, 'L5');
    },
  },
  {
    name: 'Generate override skips the probe and converts listing-status pauses; tail failure preserves the official result',
    async run() {
      const row = job({ listingLiveness: state('unclear', 'ai') });
      let overrideVisits = 0;
      const result = await prepareOfficialPostingForGeneration({ ...args(row), listingOverride: true }, {
        store: { find: async () => null }, bridgeStatus: async () => ({ enabled: false }),
        resolve: async jobs => ({ jobs: jobs.map(value => ({ ...value, officialPosting: miss() })) }),
        listingProbe: { probe: async () => { overrideVisits += 1; return evidence(); } },
        now: () => AT,
      });
      assert.equal(overrideVisits, 0, 'override must not probe');
      assert.equal(result.listingCheck.action, 'proceed');
      assert.equal(result.listingCheck.override, true);
      assert.equal(result.officialPosting.level, 'L5');
      assert.equal(getPreparedOfficialPosting(result.resolutionId, row, { now: AT }).listingAudit.outcome, 'override');
      let directVisits = 0; let directAiCalls = 0;
      const direct = await checkListingForGeneration({ job: row, posting: miss(), listingOverride: true,
        probe: { probe: async () => { directVisits += 1; return evidence({ jsonLd: { isListed: false, validThrough: '' } }); } },
        callText: async () => { directAiCalls += 1; return { rows: [{ id: 'r1', verdict: 'closed', quote: '' }] }; },
        bridgeAvailable: true, calibrationStore: calibration(), now: () => AT, deadline: deadline() });
      assert.equal(direct.listingCheck.action, 'proceed');
      assert.equal(directVisits, 0); assert.equal(directAiCalls, 0);
      const failedTail = await prepareOfficialPostingForGeneration(args(job()), {
        store: { find: async () => null }, bridgeStatus: async () => ({ enabled: false }),
        resolve: async jobs => ({ jobs: jobs.map(value => ({ ...value, officialPosting: miss() })) }),
        listingProbe: { probe: async () => { throw new Error('synthetic probe failure'); } },
        now: () => AT,
      });
      assert.equal(failedTail.officialPosting.level, 'L5');
      assert.equal(failedTail.officialPosting.outcome, 'not-found');
      assert.ok(failedTail.officialPosting.trail.includes('bridge-research'), 'the tail failure retains resolved research');
      assert.equal(failedTail.listingCheck.action, 'hold');
      assert.equal(failedTail.message, "Couldn't confirm the listing is still open");
      const counts = getListingLivenessProbeCounts();
      assert.ok(counts.checked >= 1);
      assert.ok(counts.override >= 1);
    },
  },
  {
    name: 'Generate override bypasses possible and confirmed closure while retaining evidence and a bound audit',
    async run() {
      for (const [verdict, basis, posting] of [
        ['pending', 'closed-marker', miss()],
        ['closed', 'structural', miss()],
        ['closed', 'ai', ambiguous()],
        ['closed', 'ai', miss({ outcome: 'closed' })],
      ]) {
        const row = job({ listingLiveness: state(verdict, basis), boardClosed: marker() });
        const result = await prepareOfficialPostingForGeneration({ ...args(row), listingOverride: true }, {
          store: { find: async () => null }, bridgeStatus: async () => ({ enabled: false }),
          resolve: async jobs => ({ jobs: jobs.map(value => ({ ...value, officialPosting: posting })) }),
          listingProbe: { probe: async () => { throw new Error('Override must skip the listing probe'); } },
          now: () => AT,
        });
        assert.equal(result.listingCheck.action, 'proceed');
        assert.equal(result.listingCheck.override, true);
        assert.equal(result.listingCheck.verdict, verdict);
        assert.deepEqual(result.listingLiveness, row.listingLiveness);
        assert.deepEqual(result.boardClosed, row.boardClosed);
        const prepared = getPreparedOfficialPosting(result.resolutionId, row, { now: AT });
        assert.equal(prepared.listingAudit.outcome, 'override');
        assert.equal(prepared.listingAudit.basis, basis);
      }
    },
  },
  {
    name: 'Generate override survives a whole-budget timeout and a projection error and converts a stored refusal',
    async run() {
      const timeoutRow = job({ sourceJobKey: 'synthetic-timeout' });
      const pending = prepareOfficialPostingForGeneration({ ...args(timeoutRow), listingOverride: true }, {
        slots: { acquire: signal => new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })) },
        bridgeStatus: async () => ({ enabled: false }), timeoutMs: 5, now: () => AT,
      });
      const keepAlive = setTimeout(() => {}, 25);
      const timed = await pending.finally(() => clearTimeout(keepAlive));
      assert.equal(timed.listingCheck.action, 'proceed');
      assert.equal(timed.listingCheck.override, true);
      assert.equal(timed.listingAudit, undefined);
      const projection = await prepareOfficialPostingForGeneration({ ...args(job()), listingOverride: true }, {
        projectJob: () => { throw new Error('synthetic projection failure'); }, now: () => AT,
      });
      assert.equal(projection.listingCheck.action, 'proceed');
      assert.equal(projection.listingCheck.override, true);
      const refused = await prepareOfficialPostingForGeneration({
        ...args(job({ boardClosed: marker(), listingLiveness: state('closed', 'structural') })), listingOverride: true,
      }, { projectJob: () => { throw new Error('synthetic projection failure'); }, now: () => AT });
      assert.equal(refused.listingCheck.action, 'proceed');
      assert.equal(refused.listingCheck.override, true);
    },
  },
  {
    name: 'Generate timeout still resolves stored closed, fresh open, and unobservable listing states',
    async run() {
      return withRefKeepAlive(async () => {
        const timeoutOptions = {
          slots: { acquire: signal => new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })) },
          bridgeStatus: async () => ({ enabled: false }), timeoutMs: 5, now: () => AT,
          calibrationStore: calibration(),
        };
        for (const override of [false, true]) {
          const closedRow = job({ sourceJobKey: `synthetic-closed-timeout-${override}`,
            listingLiveness: state('closed', 'ai'), boardClosed: marker() });
          const closed = await prepareOfficialPostingForGeneration({ ...args(closedRow), listingOverride: override }, timeoutOptions);
          assert.equal(closed.listingCheck.action, override ? 'proceed' : 'refuse-retry');
          assert.equal(closed.listingCheck.override, override);
        }
        const openRow = job({ sourceJobKey: 'synthetic-open-timeout', listingLiveness: state('open', 'ai') });
        const open = await prepareOfficialPostingForGeneration(args(openRow), timeoutOptions);
        assert.equal(open.listingCheck.action, 'proceed');
        assert.equal(getPreparedOfficialPosting(open.resolutionId, openRow, { now: AT }).listingAudit.outcome, 'open');
        const unobservableRow = job({ source: 'remoteok', sourceJobKey: 'synthetic-unobservable-timeout',
          url: 'https://remoteok.com/remote-jobs/synthetic-one' });
        const unobservable = await prepareOfficialPostingForGeneration(args(unobservableRow), timeoutOptions);
        assert.equal(unobservable.listingCheck.action, 'proceed');
        assert.equal(getPreparedOfficialPosting(unobservable.resolutionId, unobservableRow, { now: AT }).listingAudit.outcome,
          'unobservable');

        let demotionReads = 0;
        const tail = await prepareOfficialPostingForGeneration(args(openRow), {
          store: { find: async () => null }, bridgeStatus: async () => ({ enabled: false }),
          resolve: async jobs => ({ jobs: jobs.map(value => ({ ...value, officialPosting: miss() })) }),
          calibrationStore: { latestDemotedAt: async () => {
            demotionReads += 1;
            if (demotionReads === 1) await new Promise(resolve => setTimeout(resolve, 20));
            return null;
          } },
          timeoutMs: 5, now: () => AT,
      });
      assert.equal(tail.listingCheck.action, 'proceed');
      assert.ok(demotionReads >= 2, 'tail timeout rechecks the stored open state without the aborted signal');
      });
    },
  },
  {
    name: 'Generate timeout holds a closed primary when an alternate cannot be checked',
    async run() {
      return withRefKeepAlive(async () => {
        const alternateUrl = 'https://www.indeed.com/viewjob?jk=synthetic-timeout-alternate';
        const row = job({ source: 'linkedin', sourceJobKey: 'synthetic-closed-alternate-timeout',
          url: 'https://www.linkedin.com/jobs/view/synthetic-closed-alternate-timeout',
          listingLiveness: state('closed', 'ai'), boardClosed: marker(),
          alternateListings: [{ board: 'indeed', url: alternateUrl }] });
        let visited = false;
        const result = await prepareOfficialPostingForGeneration(args(row), {
          slots: { acquire: signal => new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })) },
          bridgeStatus: async () => ({ enabled: false }), timeoutMs: 5, now: () => AT,
          calibrationStore: calibration(),
          listingProbe: { probe: async () => { visited = true; throw new Error('no budget for alternate'); } },
        });
        assert.equal(visited, false);
        assert.equal(result.listingCheck.action, 'hold');
        assert.equal(result.listingCheck.override, false);
      });
    },
  },
  {
    name: 'Generate prepare requires an active worker pool before the listing AI step',
    async run() {
      for (const [active, expectedCalls] of [[false, 0], [true, 1]]) {
        let aiCalls = 0;
        const result = await prepareOfficialPostingForGeneration(args(job({ sourceJobKey: `synthetic-pool-${active}` })), {
          store: { find: async () => null },
          bridgeStatus: async () => ({ enabled: true, link: { state: 'linked' }, chat: { pool: { active } } }),
          resolve: async jobs => ({ jobs: jobs.map(value => ({ ...value, officialPosting: miss() })) }),
          listingProbe: { probe: async () => evidence({ jsonLd: { isListed: false, validThrough: '' } }) },
          callText: async (_prompt, request) => {
            aiCalls += 1;
            return request.responseValidator({ rows: [{ id: 'r1', verdict: 'closed', quote: '' }] });
          },
          calibrationStore: calibration(), now: () => AT,
        });
        assert.equal(aiCalls, expectedCalls, `worker pool active=${active}`);
        assert.equal(result.listingCheck.action, active ? 'refuse-final' : 'refuse-retry');
      }
    },
  },
  {
    name: 'Generate prepare IPC accepts boolean override and rejects a non-boolean override',
    async run() {
      const previous = electronPkg.ipcMain.__getInvokeHandler('prepare-official-posting-for-generation');
      const sender = new EventEmitter(); sender.id = 9072; sender.isDestroyed = () => false;
      try {
        registerOfficialPostingGenerationHandlers({ projectJob: row => ({ ...row }), store: { find: async () => null },
          bridgeStatus: async () => ({ enabled: false }),
          resolve: async jobs => ({ jobs: jobs.map(value => ({ ...value, officialPosting: miss() })) }), now: () => AT });
        const invoke = electronPkg.ipcMain.__getInvokeHandler('prepare-official-posting-for-generation');
        const row = job({ source: 'remoteok', url: 'https://remoteok.com/jobs/synthetic-override' });
        const accepted = await invoke({ sender }, { ...args(row), listingOverride: true });
        assert.notEqual(accepted.success, false, JSON.stringify(accepted));
        const rejected = await invoke({ sender }, { ...args(row), listingOverride: 'yes' });
        assert.equal(rejected.success, false);
      } finally { if (previous) electronPkg.ipcMain.handle('prepare-official-posting-for-generation', previous); }
    },
  },
  {
    name: 'Generate held telemetry counts typed timeout, projection, and tail fallbacks',
    async run() {
      return withRefKeepAlive(async () => {
        const before = getListingLivenessProbeCounts().held;
        const timed = await prepareOfficialPostingForGeneration(args(job({ sourceJobKey: 'synthetic-held-timeout' })), {
          slots: { acquire: signal => new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })) },
          bridgeStatus: async () => ({ enabled: false }), timeoutMs: 5, now: () => AT,
      });
      assert.equal(timed.listingCheck.action, 'hold');
      assert.equal(getListingLivenessProbeCounts().held, before + 1);
      const projection = await prepareOfficialPostingForGeneration(args(job()), {
        projectJob: () => { throw new Error('synthetic projection failure'); }, now: () => AT,
      });
      assert.equal(projection.listingCheck.action, 'hold');
      assert.equal(getListingLivenessProbeCounts().held, before + 2);
      const tail = await prepareOfficialPostingForGeneration(args(job()), {
        store: { find: async () => null }, bridgeStatus: async () => ({ enabled: false }),
        resolve: async jobs => ({ jobs: jobs.map(value => ({ ...value, officialPosting: miss() })) }),
        listingProbe: { probe: async () => { throw new Error('synthetic probe failure'); } }, now: () => AT,
      });
      assert.equal(tail.listingCheck.action, 'hold');
      assert.equal(getListingLivenessProbeCounts().held, before + 3);
      });
    },
  },
];
