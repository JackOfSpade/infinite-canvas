import assert from 'node:assert/strict';
import { renderOfficialPostingPage } from '../../electron/ipc/officialPostingRenderedPage.js';
import { snapshotOfficialPostingLeads } from '../../electron/ipc/officialPostingSnapshot.js';
import { decideOfficialPostingJudgments } from '../../electron/ipc/officialPostingJudge.js';
import { resolveOfficialPostings } from '../../electron/ipc/officialPostingService.js';
import { refreshOfficialPostingEntries } from '../../electron/ipc/officialPostingRefresh.js';
import { addGoogleApplyCapture, createGoogleApplyRedirectResolver, isGoogleApplyRedirect, normalizeGoogleApplyOptions, readGoogleApplyCaptureCounts, selectGoogleApplyUrl } from '../../electron/ipc/browser/manualScraper.js';
import { JSDOM } from 'jsdom';
import { readIndeedDescriptionText } from '../../electron/extractors/indeedBrowser.js';
import { readFileSync } from 'node:fs';
import { boundedOfficialPostingTrail, mostOfficialSource, normalizeOfficialPosting } from '../../electron/ipc/officialPostingFields.js';
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
async function lookup({ conflicts, finalConflicts = ['Still unsure.'], prior, rendered, finder = research, finalUrl = url => url }) {
  return withStore(async store => {
    const rounds = { 1: [], 2: [] }; const prompts = { 1: '', 2: '' };
    const callRaw = async prompt => finder(requestedIds(prompt));
    const callMatch = async (prompt, options) => {
      const round = prompt.includes('second independent review (round 2)') ? 2 : 1;
      rounds[round] = hostLeads(prompt); prompts[round] = prompt;
      void options;
      return JSON.stringify(uncertain(round === 1 ? conflicts : finalConflicts));
    };
    const snapshotRender = async url => { rendered.push(url); return { ...shownPage(url), finalUrl: finalUrl(url) }; };
    const { jobs } = await resolveOfficialPostings([job()], { store, snapshotFetch: offline, snapshotRender, callRaw, callMatch,
      priorOfficialRecords: [prior || null] });
    return { rounds, prompts, posting: jobs[0].officialPosting };
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
    name: "Indeed's current description panel is read, without the CSS inside it",
    run() {
      const dom = new JSDOM('<div id="jobsearch-ViewjobPaneWrapper"><div class="react-native-html-content simple-job-description-html"><style>@layer htmlContent { p { color: red; } }</style><p>Build routing services.</p><script>var x = 1;</script></div></div>');
      const element = dom.window.document.querySelector('.simple-job-description-html');
      assert.equal(readIndeedDescriptionText(element), 'Build routing services.');
      assert.ok(element.querySelector('style'), 'the page itself is left alone');
      const source = readFileSync(new URL('../../electron/extractors/indeedBrowser.js', import.meta.url), 'utf8');
      assert.match(source, /const DESC_SELECTOR\s*=.*\.simple-job-description-html/u);
      assert.doesNotMatch(source, /\$eval\(DESC_SELECTOR, el =>/u, 'every read strips the CSS');
    },
  },
  {
    name: "A Google redirect resolves to its first address off Google, and that page is never loaded",
    async run() {
      const GOTO = token => `https://www.google.com/goto?url=${token}`;
      assert.ok(isGoogleApplyRedirect(GOTO('CAES')));
      for (const other of ['https://www.google.com/search?udm=8', 'https://www.google.com/goto', 'https://evil.test/goto?url=x', 'http://www.google.com/goto?url=x', 'https://mail.google.com/goto?url=x', 'https://www.google.evil.test/goto?url=x']) assert.equal(isGoogleApplyRedirect(other), false, other);
      const fakeTab = routes => {
        const handlers = {}; const main = {}; const log = { continued: [], aborted: [], gotos: 0 };
        return { log, tab: { on: (name, fn) => { handlers[name] = fn; }, mainFrame: () => main, setRequestInterception: async () => {}, close: async () => { log.closed = true; },
          async goto(url) {
            log.gotos += 1;
            for (const hop of routes[url] || [url]) {
              if (hop.status) { handlers.response({ status: () => hop.status }); continue; }
              handlers.request({ url: () => hop, isNavigationRequest: () => true, frame: () => main, continue: async () => { log.continued.push(hop); }, abort: async () => { log.aborted.push(hop); } });
            }
            throw new Error('net::ERR_FAILED');
          } } };
      };
      assert.equal(selectGoogleApplyUrl([{ label: 'Apply on Google', href: 'https://google.wd5.myworkdayjobs.com/careers/job/42' }]), 'https://google.wd5.myworkdayjobs.com/careers/job/42', 'a job board whose address merely names Google is not Google');
      const broken = { setRequestInterception: async () => { throw new Error('closing'); }, close: async () => { broken.closed = true; } };
      await createGoogleApplyRedirectResolver(async () => broken).resolve([{ label: 'Apply on X', href: GOTO('z') }]);
      assert.ok(broken.closed, 'a tab that could not intercept is closed, never used');
      const site = 'https://ca.linkedin.com/jobs/view/42?utm_campaign=x';
      const { tab, log } = fakeTab({ [GOTO('a')]: [GOTO('a'), site], [GOTO('dead')]: [GOTO('dead')] });
      const resolver = createGoogleApplyRedirectResolver(async () => tab);
      const direct = { label: 'Apply on Acme', href: 'https://acme.test/jobs/1' };
      const out = await resolver.resolve([{ label: 'Apply on LinkedIn', href: GOTO('a') }, { label: 'Apply on Gone', href: GOTO('dead') }, direct]);
      assert.equal(out[0].href, site); assert.equal(out[1].href, GOTO('dead'), 'one that never left Google stays as it was'); assert.deepEqual(out[2], direct);
      assert.ok(log.aborted.includes(site), 'the destination is stopped, not loaded');
      assert.ok(log.continued.includes(GOTO('a')) && !log.continued.includes(site));
      assert.equal(selectGoogleApplyUrl(out, 'LinkedIn'), 'https://ca.linkedin.com/jobs/view/42');
      assert.deepEqual(normalizeGoogleApplyOptions(out).map(option => option.label), ['Apply on LinkedIn', 'Apply on Acme'], 'an unfollowed redirect is never offered');
      await resolver.close(); assert.ok(log.closed);
      const limited = fakeTab({ [GOTO('a')]: [{ status: 429 }, 'https://www.google.com/sorry/index'], [GOTO('b')]: [site] });
      const stopping = createGoogleApplyRedirectResolver(async () => limited.tab);
      const stopped = await stopping.resolve([{ label: 'Apply on A', href: GOTO('a') }, { label: 'Apply on B', href: GOTO('b') }]);
      assert.equal(stopping.rateLimited, true); assert.equal(limited.log.gotos, 1, 'no further Google requests once rate-limited');
      assert.deepEqual(stopped.map(item => item.href), [GOTO('a'), GOTO('b')]);
      const idle = fakeTab({}); let opened = 0;
      await createGoogleApplyRedirectResolver(async () => { opened += 1; return idle.tab; }).resolve([direct]);
      assert.equal(opened, 0, 'a signed-in page with direct links opens no tab');
    },
  },
  {
    name: 'A missed Google Apply-on read records where the link was lost, in counts only',
    run() {
      const dom = new JSDOM(`<main><section aria-hidden="true"><a href="https://a.test/1" title="Apply on Wrong">Apply on Wrong</a></section>
        <button>Apply now</button><div data-share-url="x"><a href="https://a.test/2" title="Apply on Card">Apply on Card</a></div></main>`, { url: 'https://www.google.com/search' });
      const counts = readGoogleApplyCaptureCounts(dom.window.document);
      assert.deepEqual({ ...counts, noLayout: undefined, pageHidden: undefined }, { otherControls: 1, anchors: 2, ariaHidden: 1, inJobCard: 1, noLayout: undefined, pageHidden: undefined });
      assert.equal(JSON.stringify(counts).includes('Wrong'), false);
      let total = addGoogleApplyCapture(null, { url: 'https://a.test/ok', candidates: [{}] });
      total = addGoogleApplyCapture(total, { url: '', candidates: [], counts });
      total = addGoogleApplyCapture(total, { url: '', candidates: [{}], readFailed: true, counts: null });
      assert.deepEqual([total.reads, total.captured, total.missed, total.ariaHidden, total.inJobCard, total.addressRejected, total.readFailed], [3, 1, 2, 1, 1, 1, 1]);
    },
  },
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
    name: 'An address only a final-round judge names is kept for the next recheck, and that judge is told so',
    async run() {
      const NAMED = 'https://northwind.bamboohr.test/careers/33';
      const { posting, prompts } = await lookup({ rendered: [], conflicts: ['Unsure.'], finalConflicts: [`It may be at ${NAMED}, which returned a page shell.`] });
      const kept = posting.alternatives.find(item => item.url === NAMED);
      assert.ok(kept, 'the named address is recorded');
      assert.ok(kept.title.startsWith('Unconfirmed · cited'), 'under the title a recheck reads back as a lead');
      assert.match(prompts[2], /keep it for the next recheck/u);
      assert.doesNotMatch(prompts[2], /open it in a browser for the second review/u);
      assert.match(prompts[1], /open it in a browser for the second review/u);
    },
  },
  {
    name: 'A refresh of an unsettled card reads the addresses judges cited on that card, though no result was stored for it',
    async run() {
      const NAMED = 'https://northwind.bamboohr.test/careers/33';
      await withStore(async store => {
        const seen = [];
        const callRaw = async prompt => research(requestedIds(prompt));
        const callMatch = async prompt => { seen.push(...hostLeads(prompt).map(item => item.url)); return JSON.stringify(uncertain(['Still unsure.'])); };
        const row = job();
        const unsettled = (await lookup({ rendered: [], conflicts: ['Unsure.'], finalConflicts: [`It may be at ${NAMED}.`] })).posting;
        assert.ok(unsettled.alternatives.some(item => item.url === NAMED));
        row.officialPosting = normalizeOfficialPosting({ ...unsettled, alternatives: [...unsettled.alternatives, { url: 'https://northwind.test/other', title: 'Northwind careers page lead' }] });
        assert.ok(row.officialPosting?.alternatives?.some(item => item.url === NAMED), 'a real unsettled record keeps it');
        await refreshOfficialPostingEntries({ nodeId: 'board', manualAiRunId: 'run', entries: [{ cardId: 'card', job: row }] }, { store, callRaw, callMatch, snapshotFetch: offline });
        assert.ok(seen.includes(NAMED), 'the cited address is a lead');
        assert.ok(!seen.includes('https://northwind.test/other'), 'a generic alternative is not');
      });
    },
  },
  {
    name: "A final-round judge naming where a lead's own redirect ended adds nothing, and neither does an aggregator",
    async run() {
      const CLOSED = 'https://careers.northwind.test/closedjob';
      const AGG = 'https://www.indeed.com/viewjob?jk=abcdef123456';
      const { posting } = await lookup({ rendered: [], finalUrl: url => (url === POSTING ? CLOSED : url), conflicts: ['Unsure.'], finalConflicts: [`It redirected to ${CLOSED}. Also seen on ${AGG}.`] });
      assert.ok(!posting.alternatives.some(item => item.url === CLOSED || item.url === AGG));
    },
  },
  {
    name: "The finder's employer site joins the leads only when no lead is on it",
    async run() {
      const board = 'https://acme-labs.breezy.hr/p/7306c5fe89ae-dispatch-engineer';
      const finderWith = domain => ids => ids.map(id => `BEGIN OFFICIAL POSTING RESEARCH ${id}\nCANDIDATE: ${JSON.stringify({ careersPageUrl: '', postingUrl: board,
        employer: 'Northwind Labs', employerDomain: domain, ats: '' })}\nEND OFFICIAL POSTING RESEARCH ${id}`).join('\n');
      const site = (await lookup({ rendered: [], conflicts: ['Unsure.'], finder: finderWith('https://www.northwind.test') })).rounds[1];
      const added = site.find(item => item.url.startsWith('https://www.northwind.test'));
      assert.ok(added, 'the employer site is a lead');
      assert.equal(added.kind, 'careers');
      assert.ok(Number(site.find(item => item.url === board).id.slice(1)) < Number(added.id.slice(1)), 'numbered after the posting');
      const already = (await lookup({ rendered: [], conflicts: ['Unsure.'] })).rounds[1];
      assert.equal(already.filter(item => item.url.includes('northwind.test')).length, 1, 'a careers page on that site is enough');
      const aggregator = (await lookup({ rendered: [], conflicts: ['Unsure.'], finder: finderWith('https://www.indeed.com') })).rounds[1];
      assert.ok(!aggregator.some(item => item.url.includes('indeed.com')));
      const hosted = (await lookup({ rendered: [], conflicts: ['Unsure.'], finder: finderWith('https://jobs.lever.co') })).rounds[1];
      assert.ok(!hosted.some(item => item.url.includes('lever.co')), 'a job board is not the employer\'s site');
    },
  },
  {
    name: 'A pair agreeing on the page but not on its title or employer says which one split',
    run() {
      const url = 'https://careers.northwind.test/job/42';
      const answer = over => ({ choice: 'P1', postingUrl: url, status: 'open', statusQuote: 'Apply Now', employerLinked: true, employerPageUrl: url, employerLinkQuote: 'Dispatch Engineer',
        title: 'Dispatch Engineer', employer: 'Northwind Labs', location: '', salary: '', description: DESCRIPTION, evidence: [], conflicts: [], ...over });
      const decide = (a, b) => decideOfficialPostingJudgments(job(), { leads: [{ id: 'P1', url, kind: 'posting', employer: '' }], answerA: answer(a), answerB: answer(b), now: () => 0,
        fallback: (_job, fields) => ({ officialPosting: fields }), comparativeTrail: () => [], inputHash: 'x', employerEqual: (left, right) => left === right }).officialPosting;
      const employer = decide({ employer: 'Northwind' }, {});
      assert.equal(employer.outcome, 'ambiguous');
      assert.ok(employer.trail.includes('judge-employer-split') && employer.trail.includes('semantic-uncertain') && !employer.trail.includes('judge-title-split'));
      const title = decide({ title: 'Dispatch Engineer II' }, {});
      assert.ok(title.trail.includes('judge-title-split') && !title.trail.includes('judge-employer-split'));
      assert.ok(boundedOfficialPostingTrail(employer.trail).includes('judge-employer-split'), 'the code is a recognised trail code');
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
