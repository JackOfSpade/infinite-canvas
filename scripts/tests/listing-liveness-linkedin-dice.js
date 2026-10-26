import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import {
  enrichDiceDescriptions, enrichLinkedInDescriptionsBrowser, LINKEDIN_LOGIN_WALL_RE, linkedInEnrichedRow, linkedInUndescribedRow,
} from '../../electron/extractors/apiExtractors.js';
import { __runWithIpcRequestContextForTests } from '../../electron/ipc/ipcUtils.js';
import { LISTING_LIVENESS_RULES } from '../../electron/ipc/listingLiveness.js';
import { readListingEvidence } from '../../electron/ipc/listingLivenessStore.js';

const diceUrl = 'https://www.dice.com/job-detail/synthetic-platform-123';
const row = (extra = {}) => ({ source: 'dice', jobkey: 'synthetic-platform-123',
  title: 'Platform Engineer', company: 'Northwind Labs', location: 'Remote',
  url: diceUrl, snippet: 'Short summary.', salary: '', ...extra });
const prior = Object.freeze({
  boardClosed: { board: 'dice', reason: 'http-not-found', at: '2026-10-24T12:00:00.000Z' },
  listingLiveness: { board: 'dice', verdict: 'closed', basis: 'structural', at: '2026-10-24T12:00:00.000Z' },
});

function linkedInRuntime({ finalUrl, status = 200, description = '', probe = null, html = null } = {}) {
  const observed = { navigations: [], probeArgs: [], evaluations: 0 };
  const page = {
    setExtraHTTPHeaders: async () => {},
    goto: async url => { observed.navigations.push(url); return { status: () => status }; },
    url: () => finalUrl,
    evaluate: async (fn, args) => {
      observed.evaluations += 1;
      if (fn.name === 'listingLivenessPageProbe') {
        observed.probeArgs.push(args);
        if (html) {
          const dom = new JSDOM(html, { runScripts: 'outside-only', url: finalUrl });
          try {
            dom.window.eval(`window.__listingProbe = ${fn.toString()}`);
            return dom.window.__listingProbe(args);
          } finally { dom.window.close(); }
        }
        return probe || { title: 'Platform Engineer | LinkedIn', h1: 'Platform Engineer',
          chromeText: 'Applications are open.', descriptionText: args.descriptionText,
          closedHits: [], openSignals: [], jsonLd: { validThrough: null, isListed: null } };
      }
      return description ? { ok: true, text: description } : { ok: false, pageTitle: 'Platform Engineer | LinkedIn', ldCount: 1, ldTypes: ['JobPosting'] };
    },
  };
  const runtime = {
    probeInternet: async () => true,
    getStealthBrowser: async () => ({ createBrowserContext: async () => ({ newPage: async () => page, close: async () => {} }) }),
    getStealthBrowserInfo: () => ({ generation: 1, launchedAt: Date.now() }),
  };
  return { runtime, observed };
}

async function withFetch(response, callback) {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => response;
  try { return await callback(); } finally { globalThis.fetch = previous; }
}

export default [
  {
    name: 'listing liveness capture: LinkedIn description reread replaces the paired state only on a usable verdict',
    run() {
      const job = { source: 'linkedin', jobkey: 'synthetic-linkedin-123',
        title: 'Platform Engineer', company: 'Northwind Labs', ...prior };
      const unknown = linkedInEnrichedRow(job, 'Fresh synthetic description.', { verdict: 'unknown', basis: 'wall' });
      assert.deepEqual(unknown.boardClosed, prior.boardClosed);
      assert.deepEqual(unknown.listingLiveness, prior.listingLiveness);
      const pending = linkedInEnrichedRow(job, 'Fresh synthetic description.', { verdict: 'needs-ai', basis: 'closed-marker' });
      assert.equal(pending.boardClosed, undefined);
      assert.deepEqual({ verdict: pending.listingLiveness.verdict, basis: pending.listingLiveness.basis,
        board: pending.listingLiveness.board }, { verdict: 'pending', basis: 'closed-marker', board: 'linkedin' });
      const open = linkedInUndescribedRow(job, { verdict: 'open', basis: 'open-marker' });
      assert.equal(open.boardClosed, undefined);
      assert.equal(open.listingLiveness.verdict, 'open');
      const closed = linkedInUndescribedRow(job, { verdict: 'closed', basis: 'structural' });
      assert.equal(closed.boardClosed.reason, 'http-not-found');
      assert.equal(closed.listingLiveness.verdict, 'closed');
      assert.equal(closed.boardClosed.at, closed.listingLiveness.at);
    },
  },
  {
    name: 'listing liveness capture: Dice 404 marks the aggregator, drops an ATS, and leaves an HTTP wall unchanged',
    async run() {
      await __runWithIpcRequestContextForTests({ livenessEvidence: new Map() }, async () => {
        const [closed] = await withFetch(new Response('<html><title>Not Found</title></html>', { status: 404 }),
          () => enrichDiceDescriptions([row()], null));
        assert.equal(closed.boardClosed.reason, 'http-not-found');
        assert.equal(closed.listingLiveness.verdict, 'closed');
        assert.equal(readListingEvidence(closed).httpStatus, 404);
        const ats = await withFetch(new Response('', { status: 410 }), () => enrichDiceDescriptions([
          row({ jobkey: 'synthetic-ats-123', url: 'https://northwind.greenhouse.io/jobs/synthetic-ats-123' }),
        ], null));
        assert.deepEqual(ats, []);
        const walled = row(prior);
        const [kept] = await withFetch(new Response('Access denied', { status: 403 }),
          () => enrichDiceDescriptions([walled], null));
        assert.deepEqual(kept.boardClosed, prior.boardClosed);
        assert.deepEqual(kept.listingLiveness, prior.listingLiveness);
      });
    },
  },
  {
    name: 'listing liveness capture: Dice reads the description before a closed marker becomes pending',
    async run() {
      const description = 'This synthetic role builds reliable platform services and reviews incidents with the team. '.repeat(5);
      const html = `<html><head><title>Platform Engineer | Dice</title><script type="application/ld+json">${JSON.stringify({
        '@type': 'JobPosting', title: 'Platform Engineer', description,
      })}</script></head><body><h1>Platform Engineer</h1><p>No longer accepting applications</p><div>${description}</div></body></html>`;
      await __runWithIpcRequestContextForTests({ livenessEvidence: new Map() }, async () => {
        const [described] = await withFetch(new Response(html, { status: 200 }),
          () => enrichDiceDescriptions([row(prior)], null));
        assert.equal(described.description, description.trim());
        assert.equal(described.boardClosed, undefined);
        assert.equal(described.listingLiveness.verdict, 'pending');
        assert.equal(described.listingLiveness.basis, 'closed-marker');
        const evidence = readListingEvidence(described);
        assert.ok(evidence);
        assert.equal(evidence.board, 'dice');
        assert.equal(evidence.finalUrl, null);
        assert.equal(evidence.closedHits[0].insideDescription, false);
      });
    },
  },
  {
    name: 'listing liveness capture: Dice ignores a different host 404 and retains an ATS page with a nonstructural marker',
    async run() {
      const other = row({ url: 'https://tracker.example.test/r/synthetic-platform-123', ...prior });
      const [otherKept] = await withFetch(new Response('Not found', { status: 404 }),
        () => enrichDiceDescriptions([other], null));
      assert.deepEqual(otherKept.boardClosed, prior.boardClosed);
      assert.deepEqual(otherKept.listingLiveness, prior.listingLiveness);
      const description = 'Synthetic platform duties and application instructions. '.repeat(10);
      const html = `<html><head><title>Platform Engineer</title><script type="application/ld+json">${JSON.stringify({
        '@type': 'JobPosting', title: 'Platform Engineer', description,
      })}</script></head><body><h1>Platform Engineer</h1><p>This posting has closed.</p><div id="jobDescription">${description}</div></body></html>`;
      const ats = row({ url: 'https://boards.greenhouse.io/northwind/jobs/synthetic-platform-123' });
      const result = await withFetch(new Response(html, { status: 200 }), () => enrichDiceDescriptions([ats], null));
      assert.equal(result.length, 1, 'a text marker on an ATS visit still needs corroboration');
      assert.equal(result[0].jobkey, ats.jobkey);
      assert.equal(result[0].description, description.trim());
    },
  },
  {
    name: 'listing liveness capture: LinkedIn drops ATS 404, keeps other-host 404, and forwards fetched description to its page probe',
    async run() {
      const input = { source: 'linkedin', jobkey: 'synthetic-linkedin-123', title: 'Platform Engineer',
        company: 'Northwind Labs', url: 'https://www.linkedin.com/jobs/view/synthetic-linkedin-123', ...prior };
      for (const [host, expectedJobs] of [
        ['https://boards.greenhouse.io/northwind/jobs/synthetic-linkedin-123', 0],
        ['https://tracker.example.test/r/synthetic-linkedin-123', 1],
      ]) {
        const { runtime, observed } = linkedInRuntime({ finalUrl: host, status: 404 });
        const result = await enrichLinkedInDescriptionsBrowser([input], null, { runtime });
        assert.equal(observed.navigations.length, 1);
        assert.equal(result.jobs.length, expectedJobs, host);
        if (!expectedJobs) assert.equal(observed.evaluations, 0, 'ATS structural closure stops before a description read');
        if (expectedJobs) assert.deepEqual(result.jobs[0].listingLiveness, prior.listingLiveness);
      }
      const description = 'Synthetic platform duties include operating reliable services and mentoring teammates. '.repeat(8);
      const { runtime, observed } = linkedInRuntime({ finalUrl: input.url, description });
      const result = await enrichLinkedInDescriptionsBrowser([input], null, { runtime });
      assert.equal(result.jobs.length, 1);
      assert.equal(result.jobs[0].description, description);
      assert.equal(observed.probeArgs.length, 1);
      assert.equal(observed.probeArgs[0].descriptionText, description,
        'the same-visit description reaches the classifier before its verdict');
    },
  },
  {
    name: 'listing liveness capture: LinkedIn real loop reads calibrated rules on both structural and page-probe paths',
    async run() {
      const input = { source: 'linkedin', jobkey: 'synthetic-calibrated-linkedin', title: 'Platform Engineer',
        company: 'Northwind Labs', location: 'Remote',
        url: 'https://www.linkedin.com/jobs/view/synthetic-calibrated-linkedin' };
      const lookups = [];
      const activeRules = { rulesFor: key => {
        lookups.push(key);
        return { ...LISTING_LIVENESS_RULES[key], openRules: LISTING_LIVENESS_RULES[key].openRules
          .map(rule => ({ ...rule, state: 'active' })) };
      } };
      await __runWithIpcRequestContextForTests({ livenessEvidence: new Map(), livenessRules: activeRules }, async () => {
        const closed = linkedInRuntime({ finalUrl: input.url, status: 404 });
        const structural = await enrichLinkedInDescriptionsBrowser([input], null, { runtime: closed.runtime });
        assert.equal(structural.jobs[0]?.listingLiveness?.verdict, 'closed');
        assert.deepEqual(lookups, ['linkedin'], 'the structural call reads the request snapshot');
        lookups.length = 0;

        const description = 'Synthetic platform duties include operating reliable services and mentoring teammates. '.repeat(8);
        const html = `<html><head><title>Platform Engineer | LinkedIn</title></head><body><h1>Platform Engineer</h1><button class="jobs-apply-button">Apply</button><div id="job-details">${description}</div></body></html>`;
        const open = linkedInRuntime({ finalUrl: input.url, description, html });
        const captured = await enrichLinkedInDescriptionsBrowser([input], null, { runtime: open.runtime });
        assert.equal(open.observed.probeArgs.length, 1, 'the real page probe is reached');
        assert.deepEqual(lookups, ['linkedin'], 'the page-probe call reads the request snapshot');
        assert.equal(captured.jobs[0]?.listingLiveness?.verdict, 'open');
        assert.equal(captured.jobs[0]?.listingLiveness?.basis, 'open-marker');
      });
    },
  },
  {
    name: 'listing liveness capture: LinkedIn and Dice reuse one detail navigation each',
    run() {
      const source = fs.readFileSync(new URL('../../electron/extractors/apiExtractors.js', import.meta.url), 'utf8');
      const linkedin = source.slice(source.indexOf('export async function enrichLinkedInDescriptionsBrowser'),
        source.indexOf('export function extractIndeedJobsFromHtml'));
      const dice = source.slice(source.indexOf('export async function enrichDiceDescriptions'));
      assert.equal((linkedin.match(/page\.goto\(job\.url/g) || []).length, 1);
      assert.equal((dice.match(/safeApiFetch\(url/g) || []).length, 1);
      assert.match(source, /export const LINKEDIN_LOGIN_WALL_RE = \/\^https\?:/u);
      assert.match(linkedin, /const LOGIN_WALL_RE = LINKEDIN_LOGIN_WALL_RE;/u);
      assert.equal(LINKEDIN_LOGIN_WALL_RE.test('https://www.linkedin.com/authwall?trk=guest'), true);
      assert.equal(LINKEDIN_LOGIN_WALL_RE.test('https://www.linkedin.com/jobs/view/authwall-engineer'), false);
    },
  },
];
