import assert from 'node:assert/strict';
import { renderOfficialPostingPage } from '../../electron/ipc/officialPostingRenderedPage.js';
import { snapshotOfficialPostingLeads } from '../../electron/ipc/officialPostingSnapshot.js';
import { resolveOfficialPostings } from '../../electron/ipc/officialPostingService.js';
import { mostOfficialSource, normalizeOfficialPosting } from '../../electron/ipc/officialPostingFields.js';
import { officialPostingSemanticInputHash } from '../../electron/ipc/officialPostingSemantic.js';
import { createOfficialPostingStore } from '../../electron/ipc/officialPostingStore.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const URL_A = 'https://careers.northwind.test/job/42';
const VISIBLE = `Dispatch Engineer\nApply now\n${'Build routing services for regional delivery teams. '.repeat(10)}`;

// A browser whose main page and embedded frames are driven by the test.
function fakeBrowser({ frames = [], evaluate, responses = [], status = 200 } = {}) {
  const handlers = {};
  const main = {};
  let reads = 0;
  const page = {
    on(name, fn) { handlers[name] = fn; },
    evaluateOnNewDocument: async () => {}, setExtraHTTPHeaders: async () => {}, setBypassServiceWorker: async () => {}, setRequestInterception: async () => {},
    createCDPSession: async () => ({ send: async () => {} }),
    mainFrame: () => main, url: () => URL_A, frames: () => [main, ...frames],
    async goto() {
      for (const code of responses) {
        handlers.response?.({ status: () => code, remoteAddress: () => ({ ip: '93.184.216.34' }),
          request: () => ({ isNavigationRequest: () => true, frame: () => main }) });
      }
      return { status: () => status };
    },
    evaluate: async (fn, arg) => {
      if (!arg) return VISIBLE.length;
      reads += 1;
      if (evaluate) return evaluate(reads);
      return { title: 'Dispatch Engineer', text: VISIBLE, html: `<p>${VISIBLE}</p>` };
    },
  };
  const browser = { createBrowserContext: async () => ({ newPage: async () => page, close: async () => {} }) };
  return { browser, reads: () => reads };
}
const frameOf = (box, text, url = 'https://forms.northwind.test/apply') => ({
  frameElement: async () => ({ boundingBox: async () => box }), url: () => url, evaluate: async () => text });
const open = fake => renderOfficialPostingPage(URL_A, { getBrowser: async () => fake.browser, isPublicUrl: async () => true, withLock: fn => fn() });

// The resolveOfficialPostings harness.
const DESCRIPTION = 'Northwind Labs is hiring a Dispatch Engineer to build reliable routing services for regional delivery teams.\n'
  + '• Design the dispatch scheduling service and its reporting pipeline.\n'
  + '• Review route reports with operations leads every week.\n'
  + 'Requirements: five years building backend services in TypeScript or Go.';
const job = () => ({ title: 'Dispatch Engineer', company: 'Northwind Labs', location: 'Lakeview, Ontario, Canada',
  snippet: DESCRIPTION, url: 'https://www.linkedin.com/jobs/view/synthetic-dispatch', sourceJobKey: 'dispatch-1' });
const POSTING = 'https://job-boards.greenhouse.io/northwind/jobs/4455667';
const CAREERS = 'https://northwind.test/careers';
const research = ids => ids.map(id => `BEGIN OFFICIAL POSTING RESEARCH ${id}\nCANDIDATE: ${JSON.stringify({ careersPageUrl: CAREERS,
  postingUrl: POSTING, employer: 'Northwind Labs', employerDomain: 'https://northwind.test', ats: 'Greenhouse' })}\nEND OFFICIAL POSTING RESEARCH ${id}`).join('\n');
const requestedIds = prompt => prompt.match(/Requested ids: ([a-f0-9, ]+)\./u)[1].split(', ');
const hostLeads = prompt => JSON.parse(prompt.split('BEGIN HOST LEADS JSON\n')[1].split('\nEND HOST LEADS JSON')[0]);
const offline = async () => { const error = new Error('offline test'); error.code = 'fetch-failed'; throw error; };
const uncertain = conflicts => ({ choice: 'uncertain', postingUrl: '', status: 'unknown', statusQuote: '', employerLinked: false, employerPageUrl: '',
  employerLinkQuote: '', title: '', employer: '', location: '', salary: '', description: '', evidence: [], conflicts });
async function withStore(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'official-fixes-'));
  try { return await run(createOfficialPostingStore(path.join(root, 'official-postings'))); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
const shownPage = url => ({ ok: true, status: 200, finalUrl: url, settled: true, title: 'Dispatch Engineer', text: VISIBLE, html: `<main>${VISIBLE}</main>` });

// Runs a lookup and returns the host leads and rendered/plain reads each judge round saw.
async function lookup({ conflicts, prior, rendered }) {
  return withStore(async store => {
    const rounds = { 1: [], 2: [] }; const prompts = { 1: '', 2: '' };
    const callRaw = async prompt => research(requestedIds(prompt));
    const callMatch = async (prompt, options) => {
      const round = prompt.includes('second independent review (round 2)') ? 2 : 1;
      rounds[round] = hostLeads(prompt); prompts[round] = prompt;
      void options;
      return JSON.stringify(uncertain(round === 1 ? conflicts : ['Still unsure.']));
    };
    const snapshotRender = async url => { rendered.push(url); return shownPage(url); };
    await resolveOfficialPostings([job()], { store, snapshotFetch: offline, snapshotRender, callRaw, callMatch,
      priorOfficialRecords: [prior || null] });
    return { rounds, prompts };
  });
}

// A posting page that may have gone, judged by both pairs.
const GONE = 'https://careers.northwind.test/jobs/dispatch-engineer-42';
const goneAnswer = { choice: 'P1', postingUrl: GONE, status: 'closed', statusQuote: 'The page you are looking for does not exist', employerLinked: false, employerPageUrl: '',
  employerLinkQuote: '', title: '', employer: '', location: '', salary: '', description: '', evidence: [], conflicts: [] };
const confirmedPrior = (inputHash = officialPostingSemanticInputHash(job())) => ({ officialPosting: normalizeOfficialPosting({ level: 'L1', outcome: 'found',
  employer: 'Northwind Labs', title: 'Dispatch Engineer', sourceUrl: GONE, officialApplyUrl: GONE, fetchedAt: '2026-11-01T00:00:00.000Z', salary: { text: '', provenance: 'unknown' },
  semanticMatch: { version: 1, inputHash, sourceHash: 'a'.repeat(64) }, trail: ['worker-research', 'comparative-match', 'semantic-match-v1'] }) });
async function goneLookup({ prior = null, answer, answerB = answer, page = { title: '', text: 'The page you are looking for does not exist', status: 404 } }) {
  return withStore(async store => {
    let leads = [];
    const callRaw = async prompt => research(requestedIds(prompt)).replaceAll(POSTING, GONE);
    const callMatch = async prompt => {
      leads = hostLeads(prompt);
      const chosenId = leads.find(item => item.url === GONE).id;
      const reply = prompt.startsWith('Independent official posting judgment run B') ? answerB : answer;
      return JSON.stringify(reply.choice === 'P1' ? { ...reply, choice: chosenId } : reply);
    };
    const snapshotRender = async url => ({ ok: true, status: page.status, finalUrl: url, settled: true, title: page.title, text: page.text, html: `<main>${page.text}</main>` });
    const { jobs } = await resolveOfficialPostings([job()], { store, snapshotFetch: offline, snapshotRender, callRaw, callMatch, bypassCache: true, priorOfficialRecords: [prior] });
    return { posting: jobs[0].officialPosting, leads };
  });
}

export default [
  {
    name: 'A hidden or tiny frame is ignored, a visible one is read, and each frame is bounded to 40000 characters',
    async run() {
      const junk = 'TRACKING-JUNK '.repeat(500);
      const long = `${'A'.repeat(50_000)}END-OF-FORM`;
      const fake = fakeBrowser({ frames: [
        frameOf(null, junk, 'https://hidden.test/a'),
        frameOf({ width: 1, height: 1 }, junk, 'https://tiny.test/b'),
        frameOf({ width: 99, height: 400 }, junk, 'https://narrow.test/c'),
        frameOf({ width: 600, height: 49 }, junk, 'https://short.test/d'),
        frameOf({ width: 600, height: 500 }, 'Application form: name, email, resume', 'https://forms.northwind.test/visible'),
        frameOf({ width: 600, height: 500 }, long, 'https://forms.northwind.test/long'),
      ] });
      const page = await open(fake);
      assert.equal(page.ok, true);
      assert.ok(!page.text.includes('TRACKING-JUNK'), 'hidden and tiny frames add nothing');
      assert.match(page.text, /\[Embedded frame: https:\/\/forms\.northwind\.test\/visible\]\nApplication form: name, email, resume/u);
      const longPart = page.text.split('[Embedded frame: https://forms.northwind.test/long]\n')[1];
      assert.equal(longPart.length, 40_000, 'one frame adds at most 40000 characters');
      assert.ok(!longPart.includes('END-OF-FORM'));
    },
  },
  {
    name: 'A first read that throws because the document was destroyed is retried and then succeeds',
    async run() {
      const fake = fakeBrowser({ evaluate: reads => {
        if (reads === 1) throw new Error('Execution context was destroyed, most likely because of a navigation.');
        return { title: 'Dispatch Engineer', text: VISIBLE, html: `<p>${VISIBLE}</p>` };
      } });
      const page = await open(fake);
      assert.equal(page.ok, true);
      assert.equal(page.text, VISIBLE);
      assert.equal(fake.reads(), 2);
    },
  },
  {
    name: 'A page whose document never becomes readable still fails as load-failed',
    async run() {
      const fake = fakeBrowser({ evaluate: () => { throw new Error('Execution context was destroyed'); } });
      const page = await open(fake);
      assert.equal(page.ok, false);
      assert.equal(page.reason, 'load-failed');
      assert.ok(fake.reads() > 1, 'it retried before giving up');
    },
  },
  {
    name: 'The last document status wins over the first: 202 then 200 is read, 200 then 404 is gone',
    async run() {
      const second = await open(fakeBrowser({ responses: [202, 200], status: 202 }));
      assert.equal(second.ok, true);
      assert.equal(second.status, 200);
      assert.equal(second.text, VISIBLE);
      const gone = await open(fakeBrowser({ responses: [200, 404], status: 200 }));
      assert.equal(gone.ok, true);
      assert.equal(gone.status, 404);
      assert.equal(gone.text, '');
    },
  },
  {
    name: 'A board whose data download failed reports the rendered page as its source, a read board keeps board-data',
    async run() {
      const lead = { id: 'P1', url: POSTING, kind: 'posting' };
      const failedBoard = async url => {
        if (url.includes('boards-api')) throw Object.assign(new Error('boom'), { code: 'fetch-failed' });
        return { url, contentType: 'text/html', body: '<html><body><div id="root"></div></body></html>' };
      };
      const [snap] = await snapshotOfficialPostingLeads([{ ...lead, dataUrl: 'https://boards-api.greenhouse.io/v1/boards/northwind/jobs/4455667' }],
        { fetch: failedBoard, render: async url => shownPage(url) });
      assert.equal(snap.rendered, true);
      assert.equal(snap.source, 'page');
      const goodBoard = async url => (url.includes('boards-api')
        ? { url, contentType: 'application/json', body: JSON.stringify({ id: 4455667, title: 'Dispatch Engineer', content: `<p>${DESCRIPTION}</p>`, location: { name: 'Lakeview' } }) }
        : { url, contentType: 'text/html', body: '<html><body><div id="root"></div></body></html>' });
      const [kept] = await snapshotOfficialPostingLeads([{ ...lead, dataUrl: 'https://boards-api.greenhouse.io/v1/boards/northwind/jobs/4455667' }],
        { fetch: goodBoard, render: async url => shownPage(url) });
      assert.equal(kept.rendered, true);
      assert.equal(kept.source, 'board-data');
    },
  },
  {
    name: 'A first-pair uncertain judge naming an https address in conflicts leads the second pair to that address with a rendered snapshot',
    async run() {
      const CITED = 'https://careers.northwind.test/jobs/dispatch-engineer-42';
      const rendered = [];
      const { rounds, prompts } = await lookup({ rendered, conflicts: [`The posting may be at ${CITED}, but the fetch returned only a page shell.`] });
      assert.ok(!rounds[1].some(item => item.url === CITED), 'the first pair did not have it');
      const added = rounds[2].find(item => item.url === CITED);
      assert.ok(added, 'the second pair has the cited address as a lead');
      assert.equal(added.kind, 'posting');
      assert.ok(rendered.includes(CITED), 'it was opened in the browser');
      assert.match(prompts[2], /Apply now/u, 'the second pair carries its rendered snapshot');
    },
  },
  {
    name: 'Markup and punctuation around an address a judge names are not part of it',
    async run() {
      for (const wrapped of ['**https://careers.northwind.test/jobs/42**', '`https://careers.northwind.test/jobs/42`', 'https://careers.northwind.test/jobs/42!', 'https://careers.northwind.test/jobs/42\u201d.']) {
        const { rounds } = await lookup({ rendered: [], conflicts: [`Possibly ${wrapped}`] });
        assert.ok(rounds[2].some(item => item.url === 'https://careers.northwind.test/jobs/42'), wrapped);
      }
    },
  },
  {
    name: 'An aggregator address a judge names in conflicts is not added as a lead',
    async run() {
      const rendered = [];
      const AGG = 'https://www.indeed.com/viewjob?jk=abcdef123456';
      const { rounds } = await lookup({ rendered, conflicts: [`Saw it on ${AGG} only.`] });
      assert.ok(!rounds[2].some(item => item.url === AGG));
      assert.ok(!rendered.includes(AGG));
    },
  },
  {
    name: "A prior record's 'Unconfirmed · cited' alternative is among the first pair's leads, and an ordinary alternative is not",
    async run() {
      const CITED = 'https://careers.northwind.test/jobs/cited-before';
      const PLAIN = 'https://careers.northwind.test/jobs/not-cited';
      const priorPosting = normalizeOfficialPosting({ outcome: 'ambiguous', level: 'L6', employer: 'Northwind Labs', trail: ['semantic-uncertain'],
        alternatives: [{ url: CITED, title: 'Unconfirmed · cited by a judge' }, { url: PLAIN, title: 'Some other title' }] });
      assert.ok(priorPosting?.alternatives?.length === 2, 'the prior record kept both alternatives');
      const rendered = [];
      const { rounds } = await lookup({ rendered, conflicts: ['Cannot tell.'], prior: { officialPosting: priorPosting } });
      assert.ok(rounds[1].some(item => item.url === CITED && item.kind === 'posting'), 'the cited address is a first-pair lead');
      assert.ok(!rounds[1].some(item => item.url === PLAIN));
    },
  },
  {
    name: 'A confirmed official page that now says the job is gone closes the job on the pages alone, with what was confirmed earlier',
    async run() {
      const { posting, leads } = await goneLookup({ prior: confirmedPrior(), answer: goneAnswer });
      const lead = leads.find(item => item.url === GONE);
      assert.equal(lead.confirmedEarlier, true);
      assert.equal(lead.title, 'Dispatch Engineer');
      assert.equal(posting.outcome, 'closed');
      assert.equal(posting.title, 'Dispatch Engineer');
      assert.equal(posting.employer, 'Northwind Labs');
      assert.equal(mostOfficialSource({ officialPosting: posting }).closed, true);
    },
  },
  {
    name: 'A page never confirmed that says the job is gone leaves the listing as the source, however its address reads',
    async run() {
      const claimed = { ...goneAnswer, title: 'Dispatch Engineer', employer: 'Northwind Labs', employerLinked: true,
        employerPageUrl: CAREERS, employerLinkQuote: 'Open roles',
        evidence: [{ scrapedQuote: 'Dispatch Engineer', officialQuote: 'Dispatch Engineer' }] };
      const { posting, leads } = await goneLookup({ answer: claimed });
      assert.equal(leads.find(item => item.url === GONE)?.confirmedEarlier, undefined);
      assert.notEqual(posting.outcome, 'closed');
      assert.ok(posting.trail.includes('official-liveness-unconfirmed'));
      assert.deepEqual(mostOfficialSource({ officialPosting: posting, listingLiveness: { verdict: 'open', basis: 'open-marker', board: 'linkedin', at: '2026-11-05T00:00:00.000Z' } }),
        { kind: 'listing', closed: false });
    },
  },
  {
    name: 'A page never confirmed that still shows the job and a closed notice closes it',
    async run() {
      const claimed = { ...goneAnswer, statusQuote: 'No longer accepting applications', title: 'Dispatch Engineer', employer: 'Northwind Labs', employerLinked: true,
        employerPageUrl: CAREERS, employerLinkQuote: 'Open roles',
        evidence: [{ scrapedQuote: 'Dispatch Engineer', officialQuote: 'Dispatch Engineer' }] };
      const { posting } = await goneLookup({ answer: claimed, page: { title: 'Dispatch Engineer', text: `Dispatch Engineer\nNo longer accepting applications\n${DESCRIPTION}`, status: 200 } });
      assert.equal(posting.outcome, 'closed');
      assert.equal(mostOfficialSource({ officialPosting: posting }).closed, true);
    },
  },
  {
    name: 'A confirmation of a different listing text does not let a gone page close this job',
    async run() {
      const { posting, leads } = await goneLookup({ prior: confirmedPrior('0'.repeat(64)), answer: goneAnswer });
      assert.equal(leads.find(item => item.url === GONE)?.confirmedEarlier, undefined);
      assert.notEqual(posting.outcome, 'closed');
    },
  },
  {
    name: 'A confirmed page behind a login or a server error does not close the job, and one judge alone cannot either',
    async run() {
      const failing = await goneLookup({ prior: confirmedPrior(), answer: goneAnswer, page: { title: '', text: 'Service unavailable', status: 503 } });
      assert.notEqual(failing.posting.outcome, 'closed');
      const split = await goneLookup({ prior: confirmedPrior(), answer: goneAnswer, answerB: uncertain(['Cannot tell.']) });
      assert.notEqual(split.posting.outcome, 'closed');
    },
  },
  {
    name: 'A confirmed page that loads normally closes the job only on words really on that page',
    async run() {
      const notice = { title: '', text: 'Sorry, this role is no longer available. Browse our other openings at Northwind Labs.', status: 200 };
      const quoted = { ...goneAnswer, statusQuote: 'this role is no longer available' };
      assert.equal((await goneLookup({ prior: confirmedPrior(), answer: quoted, page: notice })).posting.outcome, 'closed');
      const challenge = { title: '', text: 'Checking your browser before you continue. Northwind Labs security.', status: 200 };
      assert.notEqual((await goneLookup({ prior: confirmedPrior(), answer: quoted, page: challenge })).posting.outcome, 'closed');
    },
  },
];
