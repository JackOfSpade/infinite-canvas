import assert from 'node:assert/strict';
import {
  TYPED_JOB_LISTING_MAX_CHARS, TYPED_JOB_PAGE_MAX_CHARS, TYPED_JOB_TEXT_MAX_CHARS, composeReadPage, parseTypedJobUrl, postingPrompt, resolveTypedJob,
} from '../../electron/ipc/interviewTypedJob.js';

// Synthetic data only: example.test domains and "Acme".
const LISTING = 'Acme Widget Engineer. You will build widget schedulers for Acme customers. Requirements: five years of widget experience, clear writing, and care for reliability. '.repeat(3);
const PAGE = `Careers at Acme. ${LISTING} Apply now.`;

function fakeCall(handlers) {
  const calls = [];
  const callText = async (args) => {
    calls.push(args);
    const handler = handlers[args.claudeStage];
    if (!handler) throw new Error(`unexpected stage ${args.claudeStage}`);
    return typeof handler === 'function' ? handler(args, calls) : handler;
  };
  return { callText, calls };
}
const intakeTarget = (extra = {}) => ({ kind: 'target', url: '', company: 'Acme', role: 'Widget Engineer', location: 'Springfield', ask: '', ...extra });
const research = (result = {}, prose = 'Acme makes widgets. Source: https://acme.example.test/about') => `${prose}\nRESULT: ${JSON.stringify({
  organization: 'Acme Widgets Inc', identityUncertain: false, officialSiteUrl: 'https://acme.example.test/', careersUrl: 'https://acme.example.test/careers', openPostingUrl: '', ...result,
})}`;
const posting = (extra = {}) => ({ isPosting: true, title: 'Widget Engineer', company: 'Acme Widgets Inc', location: 'Springfield', listingText: LISTING, closed: false, matchesExpected: true, ...extra });
const pageReader = (map = {}) => async (url) => (url in map ? map[url] : { ok: false, text: '', finalUrl: url, status: 0 });
const okPage = (url, text = PAGE) => ({ ok: true, text, finalUrl: url, status: 200 });

async function rejects(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code);
    assert.equal(typeof error.userMessage, 'string');
    assert.ok(error.userMessage.length > 0);
    return true;
  });
}

export default [
  {
    name: 'typed job: a link is read with its query string and judged to be a posting',
    async run() {
      const url = 'https://jobs.example.test/o/123?gh_jid=987&src=x';
      const { callText, calls } = fakeCall({
        'typed-job-intake': { kind: 'link', url, company: '', role: '', location: '', ask: '' },
        'typed-job-posting': posting(),
      });
      const seen = [];
      const readPage = async (u, options) => { seen.push([u, typeof options.signal]); return okPage('https://jobs.example.test/o/123?gh_jid=987'); };
      const out = await resolveTypedJob({ text: url, callText, readPage });
      assert.deepEqual(seen, [[url, 'undefined']]);
      assert.equal(out.kind, 'link');
      assert.deepEqual(out.job, { title: 'Widget Engineer', company: 'Acme Widgets Inc', location: 'Springfield' });
      assert.equal(out.jobUrl, 'https://jobs.example.test/o/123?gh_jid=987');
      assert.equal(out.listingText, LISTING.trim());
      assert.deepEqual(out.notes, []);
      assert.deepEqual(calls.map(c => c.claudeStage), ['typed-job-intake', 'typed-job-posting']);
      // The model reads the unprocessed page, fenced as untrusted data.
      assert.ok(calls[1].prompt.includes(PAGE));
      assert.match(calls[1].prompt, /<untrusted-typed-job-page-/);
      assert.match(calls[0].prompt, /<untrusted-typed-job-text-/);
    },
  },
  {
    name: 'typed job: a link that fails to read, is not a posting, or is closed raises the right code',
    async run() {
      const url = 'https://jobs.example.test/o/1';
      const intake = { kind: 'link', url, company: '', role: '', location: '', ask: '' };
      let { callText } = fakeCall({ 'typed-job-intake': intake, 'typed-job-posting': posting() });
      await rejects(resolveTypedJob({ text: url, callText, readPage: pageReader({}) }), 'typed-job-unreadable-link');
      await rejects(resolveTypedJob({ text: url, callText, readPage: pageReader({ [url]: okPage(url, 'too short') }) }), 'typed-job-unreadable-link');
      await rejects(resolveTypedJob({ text: url, callText, readPage: async () => { throw new Error('boom'); } }), 'typed-job-unreadable-link');
      ({ callText } = fakeCall({ 'typed-job-intake': { ...intake, url: 'http://jobs.example.test/o/1' }, 'typed-job-posting': posting() }));
      await rejects(resolveTypedJob({ text: url, callText, readPage: pageReader({ [url]: okPage(url) }) }), 'typed-job-unreadable-link');
      ({ callText } = fakeCall({ 'typed-job-intake': intake, 'typed-job-posting': posting({ isPosting: false, listingText: '' }) }));
      await rejects(resolveTypedJob({ text: url, callText, readPage: pageReader({ [url]: okPage(url) }) }), 'typed-job-not-a-posting');
      ({ callText } = fakeCall({ 'typed-job-intake': intake, 'typed-job-posting': posting({ listingText: 'tiny' }) }));
      await rejects(resolveTypedJob({ text: url, callText, readPage: pageReader({ [url]: okPage(url) }) }), 'typed-job-not-a-posting');
      ({ callText } = fakeCall({ 'typed-job-intake': intake, 'typed-job-posting': posting({ closed: true }) }));
      await assert.rejects(resolveTypedJob({ text: url, callText, readPage: pageReader({ [url]: okPage(url) }) }), error => {
        assert.equal(error.code, 'typed-job-not-a-posting');
        assert.match(error.userMessage, /closed/);
        return true;
      });
    },
  },
  {
    name: 'typed job: a company and role with a matching open posting is found',
    async run() {
      const open = 'https://acme.example.test/careers/widget-engineer';
      const { callText, calls } = fakeCall({
        'typed-job-intake': intakeTarget(),
        'typed-job-research': research({ openPostingUrl: open }),
        'typed-job-posting': posting(),
      });
      const out = await resolveTypedJob({ text: 'Widget Engineer at Acme, Springfield', callText, readPage: pageReader({ [open]: okPage(open) }) });
      assert.equal(out.kind, 'found');
      assert.equal(out.jobUrl, open);
      assert.equal(out.organization, 'Acme Widgets Inc');
      assert.equal(out.listingText, LISTING.trim());
      assert.equal(out.notes.length, 1);
      assert.deepEqual(calls.map(c => c.claudeStage), ['typed-job-intake', 'typed-job-research', 'typed-job-posting']);
      // The posting judge is told which organisation and role it must match.
      assert.ok(calls[2].prompt.includes('Acme Widgets Inc'));
      assert.ok(calls[2].prompt.includes('Widget Engineer'));
    },
  },
  {
    name: 'typed job: a posting that does not match the organisation or role, is closed, or cannot be read falls to a generated listing',
    async run() {
      const open = 'https://acme.example.test/careers/widget-engineer';
      for (const [name, judged, reader] of [
        ['mismatch', posting({ matchesExpected: false }), pageReader({ [open]: okPage(open) })],
        ['closed', posting({ closed: true }), pageReader({ [open]: okPage(open) })],
        ['not posting', posting({ isPosting: false, listingText: '' }), pageReader({ [open]: okPage(open) })],
        ['unreadable', posting(), pageReader({})],
      ]) {
        const { callText, calls } = fakeCall({
          'typed-job-intake': intakeTarget(),
          'typed-job-research': research({ openPostingUrl: open }),
          'typed-job-posting': judged,
          'typed-job-listing': { title: 'Widget Engineer', location: 'Springfield', listingText: `Generated ${LISTING}` },
        });
        const out = await resolveTypedJob({ text: 'Widget Engineer at Acme', callText, readPage: reader });
        assert.equal(out.kind, 'generated', name);
        assert.equal(out.jobUrl, 'https://acme.example.test/careers', name);
        assert.ok(calls.some(c => c.claudeStage === 'typed-job-listing'), name);
        assert.ok(out.notes.length >= 2, name);
      }
    },
  },
  {
    name: 'typed job: no open posting generates a listing from only the company, role, location and research',
    async run() {
      const researchText = research({}, 'Acme builds scheduling widgets in Springfield. Postings use Overview, Responsibilities, Requirements, Benefits.');
      const { callText, calls } = fakeCall({
        'typed-job-intake': intakeTarget(),
        'typed-job-research': researchText,
        'typed-job-listing': { title: 'Senior Widget Engineer', location: 'Springfield, USA', listingText: LISTING },
      });
      const out = await resolveTypedJob({ text: 'Widget Engineer at Acme in Springfield. My resume is SECRETMARK and I have CAREERMARK experience', callText, readPage: pageReader({}) });
      assert.equal(out.kind, 'generated');
      assert.deepEqual(out.job, { title: 'Senior Widget Engineer', company: 'Acme Widgets Inc', location: 'Springfield, USA' });
      assert.equal(out.jobUrl, 'https://acme.example.test/careers');
      assert.match(out.notes[0], /generated/);
      const call = calls.find(c => c.claudeStage === 'typed-job-listing');
      assert.equal(call.task, 'typed-job-listing');
      assert.ok(call.schema);
      const prompt = call.prompt;
      for (const kept of ['Acme Widgets Inc', 'Widget Engineer', 'Springfield', 'Overview, Responsibilities']) assert.ok(prompt.includes(kept), kept);
      for (const leaked of ['SECRETMARK', 'CAREERMARK']) assert.equal(prompt.includes(leaked), false, leaked);
      assert.equal(/resume|résumé|\bcv\b|career|candidate|applicant history/i.test(prompt.replace(/Acme builds[\s\S]*?Benefits\./, '').replace(/https:\/\/acme\.example\.test\/careers/g, '')), false);
      assert.match(prompt, /no information about any person/);
      assert.match(prompt, /requisition/);
      assert.match(prompt, /Do not copy another company/);
    },
  },
  {
    name: 'typed job: generation without a location uses the research-free location and falls back to the typed role',
    async run() {
      const { callText } = fakeCall({
        'typed-job-intake': intakeTarget({ location: '' }),
        'typed-job-research': research(),
        'typed-job-listing': { title: '', location: '', listingText: LISTING },
      });
      const out = await resolveTypedJob({ text: 'Acme Widget Engineer', callText, readPage: pageReader({}) });
      assert.deepEqual(out.job, { title: 'Widget Engineer', company: 'Acme Widgets Inc', location: 'Unknown' });
    },
  },
  {
    name: 'typed job: unclear text carries the intake question and spends no research',
    async run() {
      for (const intake of [
        { kind: 'unclear', url: '', company: '', role: '', location: '', ask: 'Which company, and which role?' },
        intakeTarget({ role: '' }),
        intakeTarget({ company: '' }),
      ]) {
        const { callText, calls } = fakeCall({ 'typed-job-intake': intake });
        await assert.rejects(resolveTypedJob({ text: 'hmm', callText, readPage: pageReader({}) }), error => {
          assert.equal(error.code, 'typed-job-unclear');
          if (intake.kind === 'unclear') assert.equal(error.userMessage, 'Which company, and which role?');
          return true;
        });
        assert.equal(calls.length, 1);
      }
      const { callText, calls } = fakeCall({});
      await rejects(resolveTypedJob({ text: '   ', callText, readPage: pageReader({}) }), 'typed-job-unclear');
      assert.equal(calls.length, 0);
      const garbled = fakeCall({ 'typed-job-intake': 'not json' });
      await rejects(resolveTypedJob({ text: 'x', callText: garbled.callText, readPage: pageReader({}) }), 'typed-job-unclear');
    },
  },
  {
    name: 'typed job: an uncertain identity, a missing official site or a missing result line is a company-uncertain failure',
    async run() {
      for (const reply of [
        research({ identityUncertain: true }),
        research({ officialSiteUrl: '', careersUrl: '' }),
        research({ officialSiteUrl: 'http://acme.example.test/', careersUrl: 'javascript:alert(1)' }),
        research({ organization: '' }),
        'Acme is a company. No structured line at the end.',
      ]) {
        const { callText } = fakeCall({ 'typed-job-intake': intakeTarget(), 'typed-job-research': reply });
        await rejects(resolveTypedJob({ text: 'Acme Widget Engineer', callText, readPage: pageReader({}) }), 'typed-job-company-uncertain');
      }
    },
  },
  {
    name: 'typed job: failed or empty web research means nothing is generated',
    async run() {
      for (const research_ of [() => { const e = new Error('limit'); e.code = 'PARALLEL_SEARCH_EXHAUSTED'; throw e; }, () => '', () => '   ']) {
        const { callText, calls } = fakeCall({ 'typed-job-intake': intakeTarget(), 'typed-job-research': research_, 'typed-job-listing': { title: 't', location: '', listingText: LISTING } });
        await rejects(resolveTypedJob({ text: 'Acme Widget Engineer', callText, readPage: pageReader({}) }), 'typed-job-search-unavailable');
        assert.equal(calls.some(c => c.claudeStage === 'typed-job-listing'), false);
      }
    },
  },
  {
    name: 'typed job: research gets its own stage and only the company, role and location, and generation failing is reported',
    async run() {
      const { callText, calls } = fakeCall({
        'typed-job-intake': intakeTarget(),
        'typed-job-research': research(),
        'typed-job-listing': { title: 'x', location: '', listingText: 'short' },
      });
      await rejects(resolveTypedJob({ text: 'Acme Widget Engineer', callText, readPage: pageReader({}) }), 'typed-job-generation-failed');
      const call = calls.find(c => c.claudeStage === 'typed-job-research');
      assert.equal(call.schema, undefined);
      assert.match(call.prompt, /identityUncertain/);
      assert.match(call.prompt, /<untrusted-typed-job-target-/);
    },
  },
  {
    name: 'typed job: an abort is rethrown untouched at every step',
    async run() {
      const url = 'https://jobs.example.test/o/1';
      const abortError = Object.assign(new Error('Aborted'), { name: 'AbortError' });
      // Aborted before the first call.
      const controller = new AbortController();
      controller.abort();
      const first = fakeCall({});
      await assert.rejects(resolveTypedJob({ text: url, callText: first.callText, readPage: pageReader({}), signal: controller.signal }), error => error.name === 'AbortError');
      assert.equal(first.calls.length, 0);
      // Thrown by the research call: not turned into search-unavailable.
      const research_ = fakeCall({ 'typed-job-intake': intakeTarget(), 'typed-job-research': () => { throw abortError; } });
      await assert.rejects(resolveTypedJob({ text: 'Acme Widget Engineer', callText: research_.callText, readPage: pageReader({}) }), error => error === abortError);
      // Thrown by the page read: not turned into unreadable-link.
      const link = fakeCall({ 'typed-job-intake': { kind: 'link', url, company: '', role: '', location: '', ask: '' } });
      await assert.rejects(resolveTypedJob({ text: url, callText: link.callText, readPage: async () => { throw abortError; } }), error => error === abortError);
      // Aborted during the listing call.
      const live = new AbortController();
      const gen = fakeCall({ 'typed-job-intake': intakeTarget(), 'typed-job-research': research(), 'typed-job-listing': () => { live.abort(); throw new Error('network closed'); } });
      await assert.rejects(resolveTypedJob({ text: 'Acme Widget Engineer', callText: gen.callText, readPage: pageReader({}), signal: live.signal }), error => error.name === 'AbortError' || error.message === 'network closed');
    },
  },
  {
    name: 'typed job: text, page and listing sizes are capped',
    async run() {
      const none = fakeCall({});
      await rejects(resolveTypedJob({ text: 'a'.repeat(TYPED_JOB_TEXT_MAX_CHARS + 1), callText: none.callText, readPage: pageReader({}) }), 'typed-job-unclear');
      assert.equal(none.calls.length, 0);
      const url = 'https://jobs.example.test/o/1';
      const { callText, calls } = fakeCall({
        'typed-job-intake': { kind: 'link', url, company: '', role: '', location: '', ask: '' },
        'typed-job-posting': posting({ listingText: 'L'.repeat(TYPED_JOB_LISTING_MAX_CHARS + 5000), title: 'T'.repeat(900) }),
      });
      const huge = 'P'.repeat(TYPED_JOB_PAGE_MAX_CHARS + 50_000);
      const out = await resolveTypedJob({ text: url, callText, readPage: pageReader({ [url]: okPage(url, huge) }) });
      assert.equal(out.listingText.length, TYPED_JOB_LISTING_MAX_CHARS);
      assert.equal(out.job.title.length, 300);
      const pagePart = calls[1].prompt.match(/P{100,}/)[0];
      assert.equal(pagePart.length, TYPED_JOB_PAGE_MAX_CHARS);
    },
  },
  {
    name: 'typed job: the typed link parser keeps the query, drops the fragment and refuses unsafe forms',
    run() {
      assert.equal(parseTypedJobUrl('https://a.example.test/j?id=1&x=2#top').href, 'https://a.example.test/j?id=1&x=2');
      for (const bad of ['http://a.example.test/', 'https://user:pw@a.example.test/', 'ftp://a.example.test', 'not a url', '', null, 'javascript:alert(1)']) assert.equal(parseTypedJobUrl(bad), null, String(bad));
    },
  },
  {
    name: 'typed job: composeReadPage tries the plain fetch, then the rendered page, then the reader',
    async run() {
      const url = 'https://jobs.example.test/o/1';
      const long = 'Role text. '.repeat(60);
      const order = [];
      const fetchPage = async () => { order.push('fetch'); return { body: '<html><body><script>var a=1</script><div id="root"></div></body></html>', url, contentType: 'text/html' }; };
      const renderPage = async () => { order.push('render'); return { ok: true, status: 200, finalUrl: `${url}?rendered=1`, text: long }; };
      const readerPage = async () => { order.push('reader'); return `reader ${long}`; };
      const read = composeReadPage({ fetchPage, renderPage, readerPage });
      assert.deepEqual(await read(url, {}), { ok: true, text: long.trim(), finalUrl: `${url}?rendered=1`, status: 200 });
      assert.deepEqual(order, ['fetch', 'render']);

      // The plain fetch wins when it has enough text; html is turned into text and JSON-LD is kept.
      order.length = 0;
      const html = `<html><head><script type="application/ld+json">{"@type":"JobPosting","title":"Widget Engineer"}</script><style>.a{}</style></head><body><h1>Widget Engineer</h1><p>${long}</p></body></html>`;
      const plain = composeReadPage({ fetchPage: async () => { order.push('fetch'); return { body: html, url, contentType: 'text/html' }; }, renderPage });
      const out = await plain(url, {});
      assert.equal(out.ok, true);
      assert.match(out.text, /Widget Engineer/);
      assert.match(out.text, /"@type":"JobPosting"/);
      assert.equal(out.text.includes('<p>'), false);
      assert.deepEqual(order, ['fetch']);

      // Failures fall through to the reader, which returns a string.
      const viaReader = composeReadPage({
        fetchPage: async () => { throw new Error('fetch-failed'); },
        renderPage: async () => ({ ok: false, reason: 'busy' }),
        readerPage: async () => long,
      });
      assert.deepEqual(await viaReader(url, {}), { ok: true, text: long.trim(), finalUrl: url, status: 200 });

      // Nothing readable: not ok, and a 404 stops the chain.
      const none = composeReadPage({ fetchPage: async () => ({ body: 'tiny', url }), renderPage: async () => ({ ok: false, reason: 'load-failed' }), readerPage: async () => '' });
      assert.equal((await none(url, {})).ok, false);
      let later = false;
      const gone = composeReadPage({ fetchPage: async () => ({ body: '', url, status: 404 }), renderPage: async () => { later = true; return { ok: true, text: long }; } });
      assert.deepEqual(await gone(url, {}), { ok: false, text: '', finalUrl: url, status: 404 });
      assert.equal(later, false);
      const goneRendered = composeReadPage({ renderPage: async () => ({ ok: true, status: 410, finalUrl: url, text: '' }), readerPage: async () => long });
      assert.equal((await goneRendered(url, {})).status, 410);

      // Abort is rethrown, never swallowed as a failed source.
      const abortError = Object.assign(new Error('Aborted'), { name: 'AbortError' });
      await assert.rejects(composeReadPage({ fetchPage: async () => { throw abortError; }, renderPage })(url, {}), error => error === abortError);
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(composeReadPage({ fetchPage })(url, { signal: controller.signal }), error => error.name === 'AbortError');
    },
  },
  {
    name: 'typed job: composeReadPage stops on an unsafe address or a removed page and never gives a non-public host to the reader',
    async run() {
      const long = 'Acme Widget Engineer. '.repeat(40);
      const coded = code => () => { const e = new Error(code); e.code = code; throw e; };
      let readerCalls = 0;
      const readerPage = async () => { readerCalls += 1; return long; };
      const unsafe = composeReadPage({ fetchPage: coded('unsafe-address'), renderPage: async () => ({ ok: true, text: long }), readerPage });
      assert.equal((await unsafe('https://jobs.example.test/o/1', {})).ok, false);
      const closed = await composeReadPage({ fetchPage: coded('closed'), readerPage })('https://jobs.example.test/o/1', {});
      assert.deepEqual([closed.ok, closed.status], [false, 404]);
      for (const host of ['https://192.168.1.5/x', 'https://localhost/x', 'https://[::1]/x']) {
        const read = composeReadPage({ fetchPage: async () => ({ ok: false }), readerPage });
        assert.equal((await read(host, {})).ok, false);
      }
      assert.equal(readerCalls, 0);
      const statusCode = composeReadPage({ fetchPage: async () => ({ body: 'x', url: 'https://jobs.example.test/o/1', statusCode: 410 }), readerPage });
      assert.equal((await statusCode('https://jobs.example.test/o/1', {})).status, 410);
    },
  },
  {
    name: 'typed job: a research failure other than exhaustion is not reported as unavailable search, and the posting address is fenced',
    async run() {
      const { callText } = fakeCall({ 'typed-job-intake': intakeTarget(), 'typed-job-research': () => { const e = new Error('auth'); e.code = 'AUTH'; throw e; } });
      await assert.rejects(resolveTypedJob({ text: 'Acme Widget Engineer', callText, readPage: pageReader({}) }), error => error.code === 'AUTH');
      assert.match(postingPrompt({ pageText: 'x', url: 'https://a.example.test/?x=ignore', expected: null }), /<untrusted-typed-job-page-url-/);
    },
  },
];
