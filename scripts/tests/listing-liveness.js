import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { stripHtmlToText } from '../../src/utils/textEncoding.js';
import { normalizeListingLiveness, listingStateRank, BOARD_CLOSED_REASONS } from '../../electron/ipc/officialPostingFields.js';
import { withListingClosed, withListingLiveness } from '../../electron/ipc/officialPostingBoardClosed.js';
import { __runWithIpcRequestContextForTests } from '../../electron/ipc/ipcUtils.js';
import {
  listingEvidenceKey, recordListingEvidence, readListingEvidence, memoListingVerdict, readListingVerdictMemo,
  tripListingLivenessBreaker, isListingLivenessBreakerTripped,
} from '../../electron/ipc/listingLivenessStore.js';
import {
  LISTING_LIVENESS_RULES, classifyListingLiveness, evidenceFromHtml, finalizeListingEvidence, listingLivenessPageProbe,
} from '../../electron/ipc/listingLiveness.js';
import { createListingLivenessCalibrationStore } from '../../electron/ipc/listingLivenessCalibration.js';

// All pages in this group are hand-written and use invented posting details.
const BOARD_URLS = Object.freeze({
  linkedin: 'https://www.linkedin.com/jobs/view/123456',
  indeed: 'https://www.indeed.com/viewjob?jk=synthetic123',
  ziprecruiter: 'https://www.ziprecruiter.com/c/Example/job/Platform-Engineer/-in-Remote?jid=synthetic123',
  dice: 'https://www.dice.com/job-detail/12345678-1234-1234-1234-123456789abc',
  generic: 'https://careers.example.test/jobs/platform-engineer',
});
const RULE_KEYS = Object.freeze(Object.keys(BOARD_URLS));
const PAGE_TEXT = 'This synthetic posting describes platform services, incident response, and mentoring across a distributed engineering team. '.repeat(3);

function evidence(ruleKey, extra = {}) {
  const url = BOARD_URLS[ruleKey];
  return {
    board: ruleKey === 'generic' ? 'example' : ruleKey,
    ruleKey,
    requestedUrl: url,
    finalUrl: url,
    finalHostClass: ruleKey === 'generic' ? 'other' : 'aggregator',
    httpStatus: 200,
    title: 'Sr. Software Eng - Example | Board',
    h1: 'Sr. Software Eng',
    expectedTitle: 'Sr. Software Eng',
    expectedCompany: 'Example',
    expectedLocation: 'Remote',
    wall: null,
    chromeText: PAGE_TEXT,
    descriptionText: 'Build reliable software and mentor teammates.',
    descriptionIsPage: false,
    closedHits: [],
    openSignals: [],
    jsonLd: { validThrough: null, isListed: null },
    workdayPostingAvailable: null,
    redirectedAway: false,
    titleMatchesPage: true,
    ...extra,
  };
}

function classify(ruleKey, extra = {}, rules = LISTING_LIVENESS_RULES[ruleKey]) {
  return classifyListingLiveness(evidence(ruleKey, extra), rules);
}

function verdict(result, wantVerdict, wantBasis) {
  assert.equal(result.verdict, wantVerdict);
  assert.equal(result.basis, wantBasis);
}

function activeRules(ruleKey) {
  const rules = LISTING_LIVENESS_RULES[ruleKey];
  assert.ok(Array.isArray(rules?.openRules) && rules.openRules.length > 0, `${ruleKey} ships a candidate open rule`);
  return { ...rules, openRules: rules.openRules.map(rule => ({ ...rule, state: 'active' })) };
}

function htmlPage({ title = 'Sr. Software Eng - Example | Board', h1 = 'Sr. Software Eng', banner = '', description = PAGE_TEXT,
  descriptionSelector = 'id="job-details"', jsonLd = '' } = {}) {
  return `<!doctype html><html><head><title>${title}</title>${jsonLd}</head><body><main><h1>${h1}</h1>${banner}<div ${descriptionSelector}>${description}</div></main></body></html>`;
}

function httpEvidence(ruleKey, html, extra = {}) {
  return evidenceFromHtml(html, {
    board: ruleKey === 'generic' ? 'example' : ruleKey,
    ruleKey,
    requestedUrl: BOARD_URLS[ruleKey],
    finalUrl: BOARD_URLS[ruleKey],
    httpStatus: 200,
    expectedTitle: 'Sr. Software Eng',
    expectedCompany: 'Example',
    expectedLocation: 'Remote',
    rules: LISTING_LIVENESS_RULES[ruleKey],
    ...extra,
  });
}

function probeInJsdom(html, args, prepare = null) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://www.linkedin.com/jobs/view/123456' });
  try {
    prepare?.(dom.window);
    dom.window.eval(`window.__listingProbe = ${listingLivenessPageProbe.toString()}`);
    return dom.window.__listingProbe(args);
  } finally {
    dom.window.close();
  }
}

async function withCalibrationStore(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'synthetic-listing-liveness-'));
  try { return await run(createListingLivenessCalibrationStore(root)); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

export default [
  {
    name: 'listing liveness: exact bounded row fields rank open, pending, legacy, and confirmed closed',
    run() {
      const at = '2026-10-24T12:00:00.000Z';
      const stamp = (verdict, basis) => ({ verdict, basis, board: 'linkedin', at });
      const legacy = { board: 'linkedin', reason: 'linkedin-no-longer-accepting', at };
      assert.deepEqual(normalizeListingLiveness(stamp('open', 'ai')), stamp('open', 'ai'));
      assert.deepEqual(normalizeListingLiveness({ ...stamp('open', 'ai'), at: '2026-10-24T12:00:00Z' }), stamp('open', 'ai'));
      for (const invalid of [null, {}, { ...stamp('open', 'ai'), title: 'private page text' },
        { ...stamp('open', 'ai'), board: 'Bad Board' }, stamp('gone', 'ai'), stamp('open', 'guessed'),
        { ...stamp('open', 'ai'), at: 'not-an-instant' }, { ...stamp('open', 'ai'), at: '<script>' }]) {
        assert.equal(normalizeListingLiveness(invalid), null);
      }
      assert.ok(BOARD_CLOSED_REASONS.includes('http-not-found'));
      assert.ok(BOARD_CLOSED_REASONS.includes('ai-confirmed-closed'));
      assert.equal(listingStateRank({ listingLiveness: stamp('open', 'open-marker') }), 1);
      assert.equal(listingStateRank({ listingLiveness: stamp('pending', 'neither') }), 2);
      assert.equal(listingStateRank({ listingLiveness: stamp('unclear', 'ai') }), 2);
      assert.equal(listingStateRank({}), 2);
      assert.equal(listingStateRank({ listingLiveness: stamp('pending', 'closed-marker') }), 3);
      assert.equal(listingStateRank({ listingLiveness: stamp('pending', 'both') }), 3);
      assert.equal(listingStateRank({ boardClosed: legacy }), 3);
      assert.equal(listingStateRank({ listingLiveness: stamp('closed', 'structural'), boardClosed: legacy }), 4);
    },
  },
  {
    name: 'listing liveness: single-writer helpers replace or clear both paired row fields',
    run() {
      const now = new Date('2026-10-24T12:00:00.000Z');
      const plain = { source: 'linkedin', title: 'Synthetic Engineer', url: BOARD_URLS.linkedin };
      const closed = withListingClosed(plain, { board: 'linkedin', reason: 'http-not-found', basis: 'structural', now });
      assert.equal(closed.listingLiveness.verdict, 'closed');
      assert.equal(closed.boardClosed.board, 'linkedin');
      assert.equal(closed.listingLiveness.at, closed.boardClosed.at);
      assert.equal(listingStateRank(closed), 4);
      const reopened = withListingLiveness(closed, { verdict: 'open', basis: 'open-marker', board: 'linkedin', now });
      assert.equal(reopened.boardClosed, undefined);
      assert.equal(reopened.listingLiveness.verdict, 'open');
      assert.equal(listingStateRank(reopened), 1);
      const pending = withListingLiveness(closed, { verdict: 'pending', basis: 'neither', board: 'linkedin', now });
      assert.equal(pending.boardClosed, undefined);
      assert.equal(pending.listingLiveness.verdict, 'pending');
      assert.equal(withListingLiveness(closed, { verdict: 'closed', basis: 'ai', board: 'linkedin', now }), closed,
        'a close must use the paired close writer');
      assert.equal(withListingClosed(plain, { board: 'linkedin', reason: 'unrecognized', now }), plain);
    },
  },
  {
    name: 'listing liveness: request-local evidence and memo are bounded, isolated, and inert without context',
    run() {
      const row = index => ({ source: 'linkedin', jobkey: `synthetic-${index}`, title: 'Synthetic Engineer' });
      assert.equal(listingEvidenceKey(row(1)), 'linkedin|synthetic-1');
      assert.equal(recordListingEvidence(row(1), { title: 'private text' }), false);
      assert.equal(readListingEvidence(row(1)), null);
      assert.equal(memoListingVerdict(row(1), { verdict: 'open' }), false);
      assert.equal(readListingVerdictMemo(row(1)), null);
      tripListingLivenessBreaker();
      assert.equal(isListingLivenessBreakerTripped(), false);
      __runWithIpcRequestContextForTests({ livenessEvidence: new Map() }, () => {
        const first = row(0);
        assert.equal(recordListingEvidence(first, { id: 'first' }), true);
        assert.deepEqual(readListingEvidence(first), { id: 'first' });
        assert.equal(memoListingVerdict(first, { verdict: 'unclear' }), true);
        assert.deepEqual(readListingVerdictMemo(first), { verdict: 'unclear' });
        for (let index = 1; index <= 5_000; index++) recordListingEvidence(row(index), { id: index });
        assert.equal(readListingEvidence(first), null, 'oldest entry evicted at the cap');
        assert.deepEqual(readListingEvidence(row(5_000)), { id: 5_000 });
        assert.equal(isListingLivenessBreakerTripped(), false);
        tripListingLivenessBreaker();
        assert.equal(isListingLivenessBreakerTripped(), true);
      });
      __runWithIpcRequestContextForTests({ livenessEvidence: new Map() }, () => {
        assert.equal(readListingEvidence(row(5_000)), null);
        assert.equal(isListingLivenessBreakerTripped(), false);
      });
    },
  },
  {
    name: 'listing liveness: all board rules begin in shadow and every ambiguous marker combination needs AI',
    run() {
      assert.deepEqual(Object.keys(LISTING_LIVENESS_RULES).sort(), [...RULE_KEYS].sort());
      for (const ruleKey of RULE_KEYS) {
        const rules = LISTING_LIVENESS_RULES[ruleKey];
        assert.ok(Array.isArray(rules.openRules) && rules.openRules.length > 0, ruleKey);
        assert.ok(rules.openRules.every(rule => rule.state === 'shadow' && Number.isInteger(rule.version)), ruleKey);
        const openSignal = { ruleId: rules.openRules[0].id, state: 'shadow' };
        const closedHit = { ruleId: 'synthetic-closed-notice', insideDescription: false, context: 'This job is no longer available.' };
        verdict(classify(ruleKey, { closedHits: [closedHit] }), 'needs-ai', 'closed-marker');
        verdict(classify(ruleKey, { closedHits: [{ ...closedHit, insideDescription: true }] }), 'needs-ai', 'neither');
        verdict(classify(ruleKey), 'needs-ai', 'neither');
        verdict(classify(ruleKey, { openSignals: [openSignal] }), 'needs-ai', 'neither');
        verdict(classify(ruleKey, { openSignals: [openSignal], closedHits: [closedHit] }), 'needs-ai', 'closed-marker');
        verdict(classify(ruleKey, { title: 'Sr. Software Eng', chromeText: 'A short page.' }), 'unknown', 'thin');
        verdict(classify(ruleKey, { title: 'Sr. Software Eng', chromeText: 'Gone.', httpStatus: 404 }), 'closed', 'structural');
        verdict(classify(ruleKey, { finalUrl: `${BOARD_URLS[ruleKey]}#redirected`, redirectedAway: true }), 'needs-ai', 'neither');
      }
    },
  },
  {
    name: 'listing liveness: expiry and JSON-LD closed facts never imply an open page',
    run() {
      const today = new Date().toISOString().slice(0, 10);
      for (const ruleKey of RULE_KEYS) {
        verdict(classify(ruleKey, { jsonLd: { validThrough: '2020-01-01', isListed: null } }), 'needs-ai', 'closed-marker');
        verdict(classify(ruleKey, { jsonLd: { validThrough: today, isListed: null } }), 'needs-ai', 'neither');
        verdict(classify(ruleKey, { jsonLd: { validThrough: null, isListed: false } }), 'needs-ai', 'closed-marker');
        verdict(classify(ruleKey, { jsonLd: { validThrough: '2100-01-01', isListed: true } }), 'needs-ai', 'neither');
      }
    },
  },
  {
    name: 'listing liveness: active open rules require this job title and an intact native listing id',
    run() {
      for (const ruleKey of RULE_KEYS) {
        const rules = activeRules(ruleKey);
        const signal = { ruleId: rules.openRules[0].id, state: 'active' };
        const closedHit = { ruleId: 'synthetic-closed-notice', insideDescription: false, context: 'This job is no longer available.' };
        verdict(classify(ruleKey, { openSignals: [signal] }, rules), 'open', 'open-marker');
        verdict(classify(ruleKey, { openSignals: [signal], redirectedAway: true }, rules), 'needs-ai', 'neither');
        verdict(classify(ruleKey, { openSignals: [signal], titleMatchesPage: false }, rules), 'needs-ai', 'neither');
        verdict(classify(ruleKey, { openSignals: [signal], closedHits: [closedHit] }, rules), 'needs-ai', 'both');
      }
    },
  },
  {
    name: 'listing liveness: wall and structural precedence keep challenge pages unknown and truly missing pages closed',
    run() {
      for (const [ruleKey, wallCodes] of [
        ['linkedin', ['authwall', 'soft-block', 'login-wall']],
        ['indeed', ['challenge', 'login-wall']],
        ['ziprecruiter', ['challenge', 'rate-limit', 'appcast', 'error-shell']],
      ]) {
        for (const wall of wallCodes) verdict(classify(ruleKey, { wall, httpStatus: 404 }), 'unknown', 'wall');
      }
      for (const httpStatus of [0, 401, 403, 429, 500, 503]) {
        verdict(classify('dice', { httpStatus, chromeText: 'Unavailable.' }), 'unknown', 'wall');
      }
      verdict(classify('ziprecruiter', {
        finalUrl: 'https://www.ziprecruiter.com/jobseeker/home?closed_job_redirect=1',
        chromeText: 'Short page.',
      }), 'closed', 'structural');
      verdict(classify('ziprecruiter', { workdayPostingAvailable: false, chromeText: '' }), 'closed', 'structural');
      verdict(classify('ziprecruiter', {
        finalUrl: 'https://careers.example.test/jobs/platform-engineer', finalHostClass: 'other', httpStatus: 404,
        chromeText: 'Missing.',
      }), 'closed', 'structural');
    },
  },
  {
    name: 'listing liveness: HTTP evidence separates board notices from description prose and anti-bot words',
    run() {
      const diceNotice = htmlPage({ banner: '<aside>This job is no longer available.</aside>' });
      verdict(classifyListingLiveness(httpEvidence('dice', diceNotice), LISTING_LIVENESS_RULES.dice), 'needs-ai', 'closed-marker');
      const prose = htmlPage({ description: `${PAGE_TEXT} Our API team discusses rate limiting in ordinary product work. ${PAGE_TEXT}` });
      const proseEvidence = httpEvidence('dice', prose);
      assert.equal(proseEvidence.wall ?? null, null);
      verdict(classifyListingLiveness(proseEvidence, LISTING_LIVENESS_RULES.dice), 'needs-ai', 'neither');
      for (const httpStatus of [0, 401, 403, 429, 500]) {
        verdict(classifyListingLiveness(httpEvidence('dice', prose, { httpStatus }), LISTING_LIVENESS_RULES.dice), 'unknown', 'wall');
      }
      const external = httpEvidence('ziprecruiter', `<!doctype html><html><head><title>Sr. Software Eng</title></head><body><h1>Sr. Software Eng</h1><p>This job is no longer available.</p><p>${PAGE_TEXT}</p></body></html>`, {
        finalUrl: 'https://careers.example.test/jobs/platform-engineer',
        descriptionCapture: 'external-page-full-text',
      });
      assert.equal(external.descriptionIsPage, true);
      verdict(classifyListingLiveness(external, LISTING_LIVENESS_RULES.ziprecruiter), 'needs-ai', 'closed-marker');
    },
  },
  {
    name: 'listing liveness amendment: bare no-longer-available notices reach AI but quoted prose does not',
    run() {
      for (const notice of [
        'This position is no longer available.',
        'This posting is no longer available.',
        'Job no longer available.',
      ]) {
        const outside = httpEvidence('ziprecruiter', htmlPage({
          banner: `<aside>${notice}</aside>`, descriptionSelector: 'class="job_description"',
        }));
        assert.ok(outside.closedHits.some(hit => hit.ruleId === 'no-longer-available' && !hit.insideDescription), notice);
        verdict(classifyListingLiveness(outside, LISTING_LIVENESS_RULES.ziprecruiter), 'needs-ai', 'closed-marker');
        const inside = httpEvidence('ziprecruiter', htmlPage({
          banner: `<nav>${PAGE_TEXT.repeat(3)}</nav>`,
          description: `${PAGE_TEXT} ${notice} ${PAGE_TEXT}`, descriptionSelector: 'class="job_description"',
        }));
        assert.ok(inside.closedHits.some(hit => hit.ruleId === 'no-longer-available' && hit.insideDescription), notice);
        verdict(classifyListingLiveness(inside, LISTING_LIVENESS_RULES.ziprecruiter), 'needs-ai', 'neither');
      }
    },
  },
  {
    name: 'listing liveness: board description boundaries ignore quoted closure and treat page-like containers as chrome',
    run() {
      const selectors = {
        linkedin: 'id="job-details"', indeed: 'id="jobDescriptionText"',
        ziprecruiter: 'class="job_description"', dice: 'id="jobDescription"', generic: 'id="job-details"',
      };
      const quoted = `${'Synthetic responsibilities and team context. '.repeat(3)}This job is no longer available.${' More task context follows here.'.repeat(3)}`;
      for (const ruleKey of RULE_KEYS) {
        const html = htmlPage({ banner: `<aside>${PAGE_TEXT}</aside>`, description: quoted,
          descriptionSelector: selectors[ruleKey] });
        const found = httpEvidence(ruleKey, html);
        assert.equal(found.descriptionIsPage, false, `${ruleKey}: a distinct description remains distinct`);
        assert.ok(found.closedHits.some(hit => hit.insideDescription === true), ruleKey);
        verdict(classifyListingLiveness(found, LISTING_LIVENESS_RULES[ruleKey]), 'needs-ai', 'neither');

        // JSON-LD recovers the description even when the board's DOM container moved.
        const jsonLd = `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting',
          title: 'Sr. Software Eng', description: quoted })}</script>`;
        const moved = httpEvidence(ruleKey, htmlPage({ banner: `<aside>${PAGE_TEXT}</aside>`, description: quoted,
          descriptionSelector: 'id="redesigned-description"', jsonLd }));
        assert.equal(moved.descriptionIsPage, false, `${ruleKey}: JSON-LD description remains distinct`);
        assert.ok(moved.closedHits.some(hit => hit.insideDescription === true), ruleKey);
        verdict(classifyListingLiveness(moved, LISTING_LIVENESS_RULES[ruleKey]), 'needs-ai', 'neither');
      }
      const broad = httpEvidence('linkedin', htmlPage({ banner: '', description: `<h2>Sr. Software Eng</h2>${quoted}` }));
      // A page-like capture has no trustworthy description boundary; its notice goes to AI.
      assert.equal(broad.descriptionIsPage, true);
      verdict(classifyListingLiveness(broad, LISTING_LIVENESS_RULES.linkedin), 'needs-ai', 'closed-marker');
    },
  },
  {
    name: 'listing liveness amendment: HTTP container matching includes prose after nested tags and rejects a short teaser',
    run() {
      const nav = `<nav>${PAGE_TEXT.repeat(5)}</nav>`;
      const tail = `If this job is no longer available, contact the recruiter. ${PAGE_TEXT}`;
      const nestedDescription = `<p>${PAGE_TEXT}</p><div class="inner"><p>${PAGE_TEXT}</p></div><p>${tail}</p>`;
      const jsonLd = description => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting',
        title: 'Sr. Software Eng', description })}</script>`;
      const nested = httpEvidence('dice', htmlPage({ banner: nav, description: nestedDescription,
        descriptionSelector: 'id="jobDescription"', jsonLd: jsonLd(nestedDescription) }));
      assert.ok(nested.descriptionText.includes('If this job is no longer available'),
        'the outer description continues after its nested div');
      assert.ok(nested.closedHits.some(hit => hit.ruleId === 'job-no-longer-available' && hit.insideDescription));
      verdict(classifyListingLiveness(nested, LISTING_LIVENESS_RULES.dice), 'needs-ai', 'neither');

      const moved = `<section>${PAGE_TEXT} ${tail}</section>`;
      const short = httpEvidence('dice', htmlPage({ banner: nav, description: 'Tiny teaser.',
        descriptionSelector: 'id="jobDescription"', jsonLd: jsonLd(`${PAGE_TEXT} ${tail}`) }).replace(
        '<div id="jobDescription">Tiny teaser.</div>', `<div id="jobDescription">Tiny teaser.</div>${moved}`));
      assert.ok(short.descriptionText.length > 160, 'long JSON-LD beats a short teaser container');
      assert.ok(short.closedHits.some(hit => hit.ruleId === 'job-no-longer-available' && hit.insideDescription));
      verdict(classifyListingLiveness(short, LISTING_LIVENESS_RULES.dice), 'needs-ai', 'neither');
    },
  },
  {
    name: 'listing liveness: page title and h1 share coreTitle matching rules with the expected title',
    run() {
      const matching = httpEvidence('dice', htmlPage());
      assert.equal(matching.titleMatchesPage, true);
      const mismatch = httpEvidence('dice', htmlPage({ title: 'Accountant - Example | Board', h1: 'Accountant' }));
      assert.equal(mismatch.titleMatchesPage, false);
    },
  },
  {
    name: 'listing liveness amendment: HTTP chrome starts at h1 after title rather than the title copy',
    run() {
      const found = httpEvidence('dice', htmlPage({
        title: 'Sr. Software Eng | Synthetic Board', h1: 'Sr. Software Eng',
        banner: '<p>Body marker after heading.</p>',
      }));
      assert.ok(found.chromeText.startsWith('Sr. Software Eng'));
      assert.equal(found.chromeText.includes('| Synthetic Board'), false);
      assert.ok(found.chromeText.includes('Body marker after heading.'));
    },
  },
  {
    name: 'listing liveness amendment: ZipRecruiter query identity uses jid and lvk rather than path slugs',
    run() {
      const html = htmlPage();
      for (const key of ['jid', 'lvk']) {
        const requestedUrl = `https://www.ziprecruiter.com/c/Synthetic-Company/Job/Platform-Builder/-in-Remote?${key}=synthetic-a`;
        const changedUrl = `https://www.ziprecruiter.com/c/Synthetic-Company/Job/Platform-Builder/-in-Remote?${key}=synthetic-b`;
        const same = httpEvidence('ziprecruiter', html, { requestedUrl, finalUrl: requestedUrl });
        const changed = httpEvidence('ziprecruiter', html, { requestedUrl, finalUrl: changedUrl });
        assert.equal(same.redirectedAway, false, `${key}: native id survives`);
        assert.equal(changed.redirectedAway, true, `${key}: same title and city are a different native listing`);
      }
      const requestedUrl = 'https://www.ziprecruiter.com/jobs/synthetic-company/platform-builder?lvk=synthetic-a';
      const changedUrl = 'https://www.ziprecruiter.com/jobs/synthetic-company/platform-builder?lvk=synthetic-b';
      assert.equal(httpEvidence('ziprecruiter', html, { requestedUrl, finalUrl: changedUrl }).redirectedAway,
        true, 'the /jobs/ form also keeps its lvk identity');
    },
  },
  {
    name: 'listing liveness amendment: fetched HTML reads only enabled configured apply controls',
    run() {
      const controls = {
        linkedin: '<button class="jobs-apply-button">Apply</button>',
        indeed: '<button id="indeedApplyButton">Apply</button>',
        ziprecruiter: '<a class="apply_button" href="/apply">Apply</a>',
        dice: '<button data-testid="apply-button">Apply</button>',
      };
      for (const [ruleKey, control] of Object.entries(controls)) {
        const rules = activeRules(ruleKey);
        const html = htmlPage({ banner: `<aside>${control}</aside>` });
        const found = httpEvidence(ruleKey, html, { rules });
        assert.ok(found.openSignals.some(signal => signal.ruleId === rules.openRules[0].id
          && signal.state === 'active'), `${ruleKey}: configured enabled control fires`);
        verdict(classifyListingLiveness(found, rules), 'open', 'open-marker');
        const inert = htmlPage({ jsonLd: `<script>const inert = ${JSON.stringify(control)};</script>` });
        assert.deepEqual(httpEvidence(ruleKey, inert, { rules }).openSignals, [], `${ruleKey}: script markup is inert`);
        const disabled = htmlPage({ banner: `<aside>${control.replace(/^(<(?:button|a))\b/u, '$1 disabled')}</aside>` });
        assert.deepEqual(httpEvidence(ruleKey, disabled, { rules }).openSignals, [], `${ruleKey}: disabled control is inert`);
      }
    },
  },
  {
    name: 'listing liveness amendment: redirect identity and USAJobs ATS class are derived from actual hosts',
    run() {
      const requestedUrl = BOARD_URLS.linkedin;
      const redirected = finalUrl => finalizeListingEvidence({ requestedUrl, finalUrl }).redirectedAway;
      assert.equal(redirected(requestedUrl), false);
      assert.equal(redirected('https://www.linkedin.com/jobs/search/'), true);
      assert.equal(redirected('https://careers.example.test/jobs/synthetic-role'), null);
      assert.equal(redirected(null), null);
      assert.equal(finalizeListingEvidence({ requestedUrl: 'https://www.usajobs.gov/job/synthetic-123',
        finalUrl: 'https://www.usajobs.gov/job/synthetic-123' }).finalHostClass, 'ats');
    },
  },
  {
    name: 'listing liveness amendment: title match needs enough tokens from either title or h1',
    run() {
      const base = { expectedTitle: 'Platform Reliability Engineer', expectedCompany: 'Synthetic Works' };
      assert.equal(finalizeListingEvidence({ ...base, title: 'Platform Reliability Engineer | Board',
        h1: 'Unrelated Role' }).titleMatchesPage, true, 'title alone can match');
      assert.equal(finalizeListingEvidence({ ...base, title: 'Unrelated Role',
        h1: 'Platform Reliability Engineer' }).titleMatchesPage, true, 'h1 alone can match');
      assert.equal(finalizeListingEvidence({ ...base, title: 'Platform Accountant',
        h1: 'Unrelated Role' }).titleMatchesPage, false, 'one shared token is insufficient');
      assert.equal(finalizeListingEvidence({ ...base, title: '', h1: '' }).titleMatchesPage, null);
      const title404 = finalizeListingEvidence(evidence('dice', { title: '404 | Synthetic Board' }));
      assert.ok(title404.closedHits.some(hit => hit.ruleId === 'title-404' && !hit.insideDescription));
      assert.equal(title404.httpStatus, 200, 'a title 404 is an AI marker, not HTTP 404');
      verdict(classifyListingLiveness(title404), 'needs-ai', 'closed-marker');
    },
  },
  {
    name: 'listing liveness amendment: each whole-page description condition is independent',
    run() {
      const selector = 'id="jobDescription"';
      const ordinary = htmlPage({ descriptionSelector: selector, banner: `<nav>${PAGE_TEXT.repeat(5)}</nav>` });
      assert.equal(httpEvidence('dice', ordinary).descriptionIsPage, false);
      assert.equal(httpEvidence('dice', ordinary, { descriptionCapture: 'external-page-full-text' }).descriptionIsPage,
        true, 'explicit full-page capture');
      assert.equal(httpEvidence('dice', htmlPage({ descriptionSelector: 'id="moved-description"' })).descriptionIsPage,
        true, 'no container or JSON-LD boundary');
      assert.equal(httpEvidence('dice', htmlPage({ banner: '<nav>Short navigation.</nav>',
        description: 'Synthetic platform work. '.repeat(35), descriptionSelector: selector })).descriptionIsPage,
        true, 'container occupies more than 70 percent of page text');
      assert.equal(httpEvidence('dice', htmlPage({ banner: `<nav>${PAGE_TEXT.repeat(10)}</nav>`,
        description: `<h2>Sr. Software Eng</h2>${'Synthetic platform work. '.repeat(3)}`,
        descriptionSelector: selector })).descriptionIsPage, true, 'container repeats the job heading');
    },
  },
  {
    name: 'listing liveness amendment: long-page anti-bot prose is not a wall and HTTP 410 is structural',
    run() {
      verdict(classify('dice', { chromeText: 'Access denied.' }), 'unknown', 'wall');
      verdict(classify('dice', { chromeText: `Access denied. ${'Synthetic platform detail. '.repeat(100)}` }),
        'needs-ai', 'neither');
      verdict(classify('dice', { httpStatus: 410, chromeText: '' }), 'closed', 'structural');
    },
  },
  {
    name: 'listing liveness amendment: HTML expiry, six hits and three-thousand-character chrome stay bounded',
    run() {
      const validThrough = '<script type="application/ld+json">'
        + JSON.stringify({ '@type': 'JobPosting', title: 'Sr. Software Eng', validThrough: '2020-01-01' })
        + '</script>';
      const expired = httpEvidence('dice', htmlPage({ jsonLd: validThrough }));
      assert.equal(expired.jsonLd.validThrough, '2020-01-01');
      verdict(classifyListingLiveness(expired), 'needs-ai', 'closed-marker');
      const boundedEvidence = finalizeListingEvidence(evidence('dice', {
        chromeText: 'x'.repeat(4_000),
        closedHits: Array.from({ length: 9 }, (_, index) => ({ ruleId: `synthetic-rule-${index}`,
          insideDescription: false, context: 'Synthetic notice.' })),
      }));
      assert.equal(boundedEvidence.chromeText.length, 3_000);
      assert.equal(boundedEvidence.closedHits.length, 6);
    },
  },
  {
    name: 'listing liveness: in-page probe is closure-free and a throwing open rule does not fire',
    run() {
      const rules = activeRules('linkedin');
      assert.throws(() => JSDOM.fragment('<a>Apply</a>').querySelector('a['));
      const thrownRule = { ...rules.openRules[0], selectors: ['a['] };
      const probe = probeInJsdom(htmlPage({ banner: '<aside>No longer accepting applications.</aside>' }), {
        rules: { ...rules, openRules: [thrownRule] }, expectedTitle: 'Sr. Software Eng',
      });
      assert.ok(Array.isArray(probe.closedHits));
      assert.ok(Array.isArray(probe.openSignals));
      assert.equal(probe.openSignals.some(signal => signal.ruleId === thrownRule.id), false);
      assert.ok(probe.closedHits.some(hit => hit.insideDescription === false));
    },
  },
  {
    name: 'listing liveness amendment: app-owned overlay is absent from generic page evidence',
    run() {
      const html = '<!doctype html><html><head><title>Platform Engineer - Remote - Indeed</title></head>'
        + '<body><div>Loading…</div><div id="__ic-panel">Job Collector Retrying descriptions… Indeed '
        + 'jobs collected '.repeat(8) + '</div></body></html>';
      const probed = probeInJsdom(html, { rules: LISTING_LIVENESS_RULES.indeed, expectedTitle: 'Platform Engineer' });
      assert.equal(probed.chromeText.includes('Job Collector'), false, 'our overlay cannot count as posting chrome');
      const url = BOARD_URLS.indeed;
      const result = classifyListingLiveness(finalizeListingEvidence({ ...probed, board: 'indeed', ruleKey: 'indeed',
        requestedUrl: url, finalUrl: url, httpStatus: 200, expectedTitle: 'Platform Engineer',
        expectedCompany: 'Example', expectedLocation: 'Remote' }), LISTING_LIVENESS_RULES.indeed);
      verdict(result, 'unknown', 'thin');
    },
  },
  {
    name: 'listing liveness amendment 2: overlay exclusion reads only live rendered page text',
    run() {
      const visible = 'Platform Engineer\nSynthetic platform work spans services, alerts, and incident review.';
      const panel = 'Job Collector Retrying descriptions';
      const html = '<!doctype html><html><head><title>Platform Engineer | Indeed</title></head>'
        + '<body><h1>Platform Engineer</h1><p>Synthetic platform work spans services, alerts, and incident review.</p>'
        + '<div style="display:none">Hidden false closure notice.</div>'
        + '<script>window.syntheticBoot = "This job is no longer available";</script>'
        + `<div id="__ic-panel">${panel}</div></body></html>`;
      const probed = probeInJsdom(html, { rules: LISTING_LIVENESS_RULES.indeed,
        expectedTitle: 'Platform Engineer', excludeSelectors: ['#__ic-panel'] }, window => {
        Object.defineProperty(window.HTMLElement.prototype, 'innerText', { configurable: true,
          get() {
            if (!this.isConnected) throw new Error('detached nodes have no rendered text');
            if (this === window.document.body) {
              return this.querySelector('#__ic-panel')?.style.display === 'none' ? visible : `${visible}\n${panel}`;
            }
            return this.textContent;
          },
        });
      });
      assert.equal(probed.chromeText.includes(panel), false, 'the app overlay is excluded');
      assert.equal(probed.chromeText.includes('Hidden false closure'), false, 'hidden text is not rendered');
      assert.equal(probed.chromeText.includes('syntheticBoot'), false, 'scripts are not rendered');
      assert.equal(probed.closedHits.length, 0, 'a script closure string is not page evidence');
      assert.ok(probed.chromeText.includes('Synthetic platform work'));
    },
  },
  {
    name: 'listing liveness amendment 2: fallback descriptions match live list boundaries while real banners remain outside',
    run() {
      const paragraph = 'Responsibilities include building services and mentoring teammates across the group.';
      const listOne = 'Own incident review.';
      const listTwo = 'Check alerts. If this job is no longer available, ask the recruiter.';
      const benefits = 'Benefits include health coverage.';
      const markup = `<p>${paragraph}</p><ul><li>${listOne}</li><li>${listTwo}</li></ul><p>${benefits}</p>`;
      const callerDescription = stripHtmlToText(markup);
      const nav = 'Jobs Companies Salaries Career advice Sign in Post a job Help Search saved alerts. '.repeat(5);
      const renderedDescription = `${paragraph}\n${listOne}\n${listTwo}\n${benefits}`;
      const jsonLd = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting',
        description: markup })}</script>`;
      const html = banner => `<!doctype html><html><head><title>Platform Engineer | ZipRecruiter</title>${jsonLd}</head>`
        + `<body><nav>${nav}${banner}</nav><main><h1>Platform Engineer</h1><div class="renamed-description">${markup}</div></main></body></html>`;
      const run = banner => probeInJsdom(html(banner), { rules: LISTING_LIVENESS_RULES.ziprecruiter,
        expectedTitle: 'Platform Engineer', descriptionText: callerDescription }, window => {
        Object.defineProperty(window.document.body, 'innerText', { configurable: true,
          get() { return `${nav}${banner}\nPlatform Engineer\n${renderedDescription}`; },
        });
      });
      const quoted = run('');
      assert.equal(quoted.descriptionIsPage, false);
      assert.ok(quoted.closedHits.length > 0, 'the live body contains the quoted phrase');
      assert.ok(quoted.closedHits.every(hit => hit.insideDescription), 'list bullets are formatting, not a board notice');
      const withBanner = run('This job is no longer available. ');
      assert.ok(withBanner.closedHits.some(hit => !hit.insideDescription), 'a real banner remains outside the description');
    },
  },
  {
    name: 'listing liveness amendment 2: ordered list numbers do not turn quoted closure into a board banner',
    run() {
      const paragraph = 'Responsibilities include building services and mentoring teammates across the group.';
      const listOne = 'Own incident review.';
      const listTwo = 'Check alerts. If this job is no longer available, ask the recruiter.';
      const benefits = 'Benefits include health coverage.';
      const markup = `<p>${paragraph}</p><ol><li>${listOne}</li><li>${listTwo}</li></ol><p>${benefits}</p>`;
      const callerDescription = stripHtmlToText(markup);
      assert.ok(callerDescription.includes('• '), 'the caller uses text bullet markers');
      const nav = 'Jobs Companies Salaries Career advice Sign in Post a job Help Search saved alerts. '.repeat(5);
      const jsonLd = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting',
        description: markup })}</script>`;
      const html = `<!doctype html><html><head><title>Platform Engineer | ZipRecruiter</title>${jsonLd}</head>`
        + `<body><nav>${nav}</nav><main><h1>Platform Engineer</h1><div class="renamed-description">${markup}</div></main></body></html>`;
      const run = banner => probeInJsdom(html, { rules: LISTING_LIVENESS_RULES.ziprecruiter,
        expectedTitle: 'Platform Engineer', descriptionText: callerDescription }, window => {
        Object.defineProperty(window.document.body, 'innerText', { configurable: true,
          get() { return `${nav}${banner}\nPlatform Engineer\n${paragraph}\n1. ${listOne}\n2. ${listTwo}\n${benefits}`; },
        });
      });
      const quoted = run('');
      assert.equal(quoted.descriptionIsPage, false);
      assert.ok(quoted.closedHits.length > 0);
      assert.ok(quoted.closedHits.every(hit => hit.insideDescription),
        'ordered-list numbers and caller bullets are presentation only');
      const withBanner = run('This job is no longer available. ');
      assert.ok(withBanner.closedHits.some(hit => !hit.insideDescription),
        'the same phrase in a real page banner stays outside the description');
    },
  },
  {
    name: 'listing liveness amendment: DOM probe keeps JSON-LD markup and quoted closure inside description for every rule key',
    run() {
      const prose = `${'Synthetic platform responsibilities and teammate support. '.repeat(4)}If this job is no longer available, contact the recruiter. ${'Additional engineering work and incident response. '.repeat(4)}`;
      const jsonDescription = `<p>${prose}</p><ul><li>Document service operations.</li></ul>`;
      const jsonLd = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Sr. Software Eng', description: jsonDescription })}</script>`;
      const nav = `<nav>${PAGE_TEXT.repeat(5)}</nav>`;
      const html = htmlPage({ jsonLd, banner: nav, description: jsonDescription,
        descriptionSelector: 'id="redesigned-description"' });
      for (const ruleKey of RULE_KEYS) {
        const probe = probeInJsdom(html, { rules: LISTING_LIVENESS_RULES[ruleKey],
          expectedTitle: 'Sr. Software Eng', descriptionText: prose });
        assert.equal(probe.descriptionText, prose, `${ruleKey}: caller text takes precedence over JSON-LD`);
        assert.equal(probe.descriptionIsPage, false, ruleKey);
        assert.ok(probe.closedHits.some(hit => hit.ruleId === 'job-no-longer-available' && hit.insideDescription), ruleKey);
        assert.ok(probe.closedHits.every(hit => hit.insideDescription), `${ruleKey}: quoted prose stays inside`);
      }
      const fromJson = probeInJsdom(html, { rules: LISTING_LIVENESS_RULES.dice, expectedTitle: 'Sr. Software Eng' });
      assert.equal(fromJson.descriptionText.includes('<p>'), false, 'JSON-LD HTML is converted to text');
      assert.ok(fromJson.closedHits.some(hit => hit.ruleId === 'job-no-longer-available' && hit.insideDescription));
      const splitDescription = `<p>${'Synthetic platform responsibilities and teammate support. '.repeat(4)}</p>`
        + '<p>If this job is no longer available, contact the recruiter.</p>'
        + `<p>${'Additional engineering work and incident response. '.repeat(4)}</p>`;
      const splitJson = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting',
        description: splitDescription })}</script>`;
      const split = probeInJsdom(htmlPage({ jsonLd: splitJson, banner: nav,
        description: splitDescription, descriptionSelector: 'id="redesigned-description"' }), {
        rules: LISTING_LIVENESS_RULES.dice, expectedTitle: 'Sr. Software Eng',
      });
      assert.ok(split.closedHits.some(hit => hit.ruleId === 'job-no-longer-available' && hit.insideDescription),
        'a paragraph boundary in JSON-LD must not turn quoted prose into a board notice');

      const zipHtml = htmlPage({ banner: nav, description: `<p>${prose}</p>`,
        descriptionSelector: 'class="whitespace-pre-line text-base"' });
      const zip = probeInJsdom(zipHtml, { rules: LISTING_LIVENESS_RULES.ziprecruiter,
        expectedTitle: 'Sr. Software Eng' });
      assert.equal(zip.descriptionIsPage, false, 'ZipRecruiter live container is distinct from chrome');
      assert.ok(zip.closedHits.some(hit => hit.ruleId === 'job-no-longer-available' && hit.insideDescription));
    },
  },
  {
    name: 'listing liveness amendment: prose at either description edge stays inside on DOM and HTML paths',
    run() {
      const selectors = {
        linkedin: 'id="job-details"', indeed: 'id="jobDescriptionText"',
        ziprecruiter: 'class="whitespace-pre-line"', dice: 'id="jobDescription"', generic: 'id="job-details"',
      };
      const nav = `<nav>${PAGE_TEXT.repeat(5)}</nav>`;
      const phrase = 'This job is no longer available.';
      for (const ruleKey of RULE_KEYS) {
        for (const side of ['start', 'end']) {
          const description = side === 'start' ? `${phrase} ${PAGE_TEXT}` : `${PAGE_TEXT} ${phrase}`;
          const html = `<!doctype html><html><head><title>Sr. Software Eng | Board</title></head>`
            + `<body>${nav}<h1>Sr. Software Eng</h1><div ${selectors[ruleKey]}>${description}</div>${nav}</body></html>`;
          const dom = probeInJsdom(html, { rules: LISTING_LIVENESS_RULES[ruleKey], expectedTitle: 'Sr. Software Eng' });
          assert.equal(dom.descriptionIsPage, false, `${ruleKey}/${side}: DOM boundary exists`);
          assert.ok(dom.closedHits.length > 0, `${ruleKey}/${side}: DOM saw the quoted phrase`);
          assert.ok(dom.closedHits.every(hit => hit.insideDescription), `${ruleKey}/${side}: DOM quoted prose`);
          const fetched = httpEvidence(ruleKey, html);
          assert.equal(fetched.descriptionIsPage, false, `${ruleKey}/${side}: HTML boundary exists`);
          assert.ok(fetched.closedHits.length > 0, `${ruleKey}/${side}: HTML saw the quoted phrase`);
          assert.ok(fetched.closedHits.every(hit => hit.insideDescription), `${ruleKey}/${side}: HTML quoted prose`);
        }
      }
    },
  },
  {
    name: 'listing liveness amendment: quote-source context remains effective when JSON-LD extends visible prose',
    run() {
      const visible = `${PAGE_TEXT} If this job is no longer available, contact the recruiter. ${PAGE_TEXT}`;
      const extended = `Additional synthetic description context. ${visible} More synthetic description context.`;
      const jsonLd = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting',
        description: extended })}</script>`;
      const html = htmlPage({ jsonLd, banner: `<nav>${PAGE_TEXT.repeat(8)}</nav>`,
        description: visible, descriptionSelector: 'id="redesigned-description"' });
      const dom = probeInJsdom(html, { rules: LISTING_LIVENESS_RULES.dice,
        expectedTitle: 'Sr. Software Eng', descriptionText: extended });
      assert.equal(dom.descriptionIsPage, false);
      assert.ok(dom.closedHits.some(hit => hit.ruleId === 'job-no-longer-available' && hit.insideDescription));
      const fetched = httpEvidence('dice', html);
      assert.equal(fetched.descriptionIsPage, false);
      assert.ok(fetched.closedHits.some(hit => hit.ruleId === 'job-no-longer-available' && hit.insideDescription));
    },
  },
  {
    name: 'listing liveness calibration: promotion needs all independent thresholds and a shadow rule version',
    async run() {
      await withCalibrationStore(async store => {
        const ruleKey = 'linkedin'; const ruleId = LISTING_LIVENESS_RULES.linkedin.openRules[0].id;
        const fired = evidence(ruleKey, { openSignals: [{ ruleId, state: 'shadow' }] });
        const silent = evidence(ruleKey);
        for (let index = 0; index < 20; index++) await store.recordAiAnswer({ ruleKey, evidence: fired, verdict: 'open' });
        for (let index = 0; index < 5; index++) await store.recordAiAnswer({ ruleKey, evidence: silent, verdict: 'closed' });
        for (let index = 0; index < 14; index++) await store.recordAiAnswer({ ruleKey, evidence: silent, verdict: 'unclear' });
        let snap = await store.snapshot();
        assert.equal(snap.boards.linkedin.aiCheckedPages, 39);
        assert.equal(snap.boards.linkedin.rules[ruleId].firedAndAiOpen, 20);
        assert.equal(snap.boards.linkedin.rules[ruleId].silentOnAiClosed, 5);
        assert.equal(snap.rulesFor(ruleKey).openRules[0].state, 'shadow');
        const answer = await store.recordAiAnswer({ ruleKey, evidence: silent, verdict: 'unclear' });
        assert.deepEqual(answer.promoted, [ruleId]);
        snap = await store.snapshot();
        assert.equal(snap.boards.linkedin.aiCheckedPages, 40);
        assert.equal(snap.rulesFor(ruleKey).openRules[0].state, 'active');
        assert.ok(Object.isFrozen(snap) && Object.isFrozen(snap.boards.linkedin.rules[ruleId]));
        const closed = await store.recordAiAnswer({ ruleKey, evidence: fired, verdict: 'closed', now: '2026-10-25T00:00:00Z' });
        assert.deepEqual(closed.demoted, [ruleId]);
        assert.equal(closed.snapshot.rulesFor(ruleKey).openRules[0].state, 'shadow');
        assert.equal(closed.snapshot.boards.linkedin.rules[ruleId].firedAndAiOpen, 0);
        assert.equal(await store.latestDemotedAt(ruleKey), '2026-10-25T00:00:00.000Z');
        const disk = await fs.readFile(store.file, 'utf8');
        for (const forbidden of [PAGE_TEXT, BOARD_URLS.linkedin, 'Sr. Software Eng']) assert.equal(disk.includes(forbidden), false);
      });
    },
  },
  {
    name: 'listing liveness calibration: ineligible pages, version changes and suspension never promote stale counts',
    async run() {
      await withCalibrationStore(async store => {
        const ruleKey = 'indeed'; const ruleId = LISTING_LIVENESS_RULES.indeed.openRules[0].id;
        const fired = evidence(ruleKey, { openSignals: [{ ruleId, state: 'shadow' }] });
        for (const change of [
          { closedHits: [{ ruleId: 'synthetic-closed', insideDescription: false, context: 'Closed notice.' }] },
          { redirectedAway: true }, { titleMatchesPage: false },
        ]) await store.recordAiAnswer({ ruleKey, evidence: { ...fired, ...change }, verdict: 'open' });
        await store.recordAiAnswer({ ruleKey, evidence: { ...fired, closedHits: [
          { ruleId: 'synthetic-closed', insideDescription: false, context: 'Closed notice.' },
        ] }, verdict: 'closed' });
        let snap = await store.snapshot();
        assert.equal(snap.boards.indeed.rules[ruleId].firedAndAiOpen, 0);
        assert.equal(snap.boards.indeed.rules[ruleId].demotedAt, null, 'an ineligible close cannot demote');
        assert.equal(snap.boards.indeed.aiCheckedPages, 4);
        const document = JSON.parse(await fs.readFile(store.file, 'utf8'));
        document.boards.indeed.aiCheckedPages = 40;
        Object.assign(document.boards.indeed.rules[ruleId], {
          firedAndAiOpen: 20, silentOnAiClosed: 5, state: 'shadow', version: LISTING_LIVENESS_RULES.indeed.openRules[0].version - 1,
        });
        await fs.writeFile(store.file, JSON.stringify(document));
        snap = await store.snapshot();
        assert.equal(snap.boards.indeed.rules[ruleId].firedAndAiOpen, 0, 'a selector-version change discards old evidence');
        assert.equal(snap.rulesFor(ruleKey).openRules[0].state, 'shadow');

        const current = JSON.parse(await fs.readFile(store.file, 'utf8'));
        Object.assign(current.boards.indeed.rules[ruleId], { version: LISTING_LIVENESS_RULES.indeed.openRules[0].version,
          firedAndAiOpen: 20, silentOnAiClosed: 5, state: 'shadow', suspendedUntil: '2026-11-01T00:00:00.000Z' });
        await fs.writeFile(store.file, JSON.stringify(current));
        const before = await store.recordAiAnswer({ ruleKey, evidence: evidence(ruleKey), verdict: 'unclear', now: '2026-10-31T00:00:00Z' });
        assert.deepEqual(before.promoted, []);
        const after = await store.recordAiAnswer({ ruleKey, evidence: evidence(ruleKey), verdict: 'unclear', now: '2026-11-02T00:00:00Z' });
        assert.deepEqual(after.promoted, [ruleId]);
        const demoted = await store.demoteRule({ ruleKey, ruleId, now: '2026-11-03T00:00:00Z' });
        assert.equal(demoted.rulesFor(ruleKey).openRules[0].state, 'shadow');
        assert.equal(demoted.boards.indeed.rules[ruleId].demotedAt, '2026-11-03T00:00:00.000Z');
        assert.equal(demoted.boards.indeed.rules[ruleId].suspendedUntil, '2026-11-10T00:00:00.000Z');
      });
    },
  },
  {
    name: 'listing liveness calibration: concurrent answers are serialized and a corrupt file starts shadow',
    async run() {
      await withCalibrationStore(async store => {
        const ruleKey = 'dice'; const ruleId = LISTING_LIVENESS_RULES.dice.openRules[0].id;
        await fs.mkdir(path.dirname(store.file), { recursive: true });
        await fs.writeFile(store.file, '{invalid json');
        assert.equal((await store.snapshot()).rulesFor(ruleKey).openRules[0].state, 'shadow');
        const fired = evidence(ruleKey, { openSignals: [{ ruleId, state: 'shadow' }] });
        await Promise.all(Array.from({ length: 12 }, () => store.recordAiAnswer({ ruleKey, evidence: fired, verdict: 'open' })));
        const snap = await store.snapshot();
        assert.equal(snap.boards.dice.aiCheckedPages, 12);
        assert.equal(snap.boards.dice.rules[ruleId].firedAndAiOpen, 12);
        assert.equal(snap.rulesFor(ruleKey).openRules[0].state, 'shadow');
      });
    },
  },
];
