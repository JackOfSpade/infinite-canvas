import assert from 'node:assert/strict';
import { extractOfficialCareersCmsFacts as extract, phenomSearchForm, phenomSearchJobLinks } from '../../electron/ipc/officialPostingCareersCms.js';

const id = '30000000-0000-4000-8000-000000000001';
const url = 'https://synthetic.test/us/eng/careers';
const linkKey = 'CAREERS_SECTION-1_LINK-1_URL';
const textKey = 'CAREERS_SECTION-1_LINK-1_TEXT';
const altKey = 'CAREERS_SECTION-2_SLIDE-1_IMAGE-ALT-TEXT';
const fields = () => Object.fromEntries([[linkKey, `https://recruiting.paylocity.com/Recruiting/Jobs/All/${id}`],
  [textKey, 'View Job Openings'], [altKey, 'Lobby of Synthetic Systems North America']].map(([key, value]) => [key, { key, value }]));
const state = records => ({ region: 'us', language: 'eng', 12345: { b: { 'eng-US': records || fields() } } });
const body = value => `<script id="ng-state" type="application/json">${JSON.stringify(value)}</script>`;
const read = (value = state(), sourceUrl = url) => extract({ body: body(value), sourceUrl });

const phenom = (jobs = [{ jobId: 'R101', title: 'Software Developer II' }, { reqId: 'R202', title: 'Data/Eng: Lead' }, { title: 'No id' }, { jobId: 'bad id', title: 'X' }], base = 'https://careers.synthetic.test/global/en/') =>
  `<script>phApp = phApp || {"country":"global","locale":"en_global","baseUrl":"${base}"};phApp.routes={"search-results":"search-results"};
  phApp.ddo = {"eagerLoadRefineSearch":{"data":{"jobs":${JSON.stringify(jobs)}}},"other":{"jobs":[{"jobId":"R9","title":"Stray"}]}};</script>`;
const search = 'https://careers.synthetic.test/global/en/search-results?keywords=Software%20Developer%20II';

export default [
  { name: 'careers CMS facts preserve exact typed source roles and current locale without fabricating anchors', run() {
    const facts = read();
    assert.equal(facts.links[0].url.endsWith(id), true); assert.equal(facts.links[0].key, linkKey);
    assert.equal(facts.links[0].role, 'job-openings'); assert.equal(facts.links[0].tag, undefined);
    assert.equal(facts.branding[0].text, 'Lobby of Synthetic Systems North America'); assert.equal(facts.branding[0].key, altKey);
    assert.equal(facts.tenantProven, undefined);
    const extra = fields();
    for (const [key, value] of [['CAREERS_SECTION-2_LINK-1_URL', 'https://social.test/brand'], ['CAREERS_SECTION-2_LINK-1_TEXT', 'Facebook'],
      ['CAREERS_SECTION-3_LINK-1_URL', 'https://recruiting.paylocity.com/Recruiting/Jobs/List/123'], ['CAREERS_SECTION-3_LINK-1_TEXT', 'View Job Openings']]) extra[key] = { key, value };
    assert.equal(read(state(extra)).links.length, 1);
  } },
  { name: 'careers CMS rejects other locales, unrelated pages, arbitrary scripts and unrecognized roles', run() {
    assert.equal(read({ ...state(), region: 'ca' }), null);
    assert.equal(read({ ...state(), language: 'fra' }), null);
    assert.equal(read({ region: 'us', language: 'eng', 12345: { b: { 'eng-CA': fields() } } }), null);
    assert.equal(read(state(), 'https://synthetic.test/us/eng/products'), null);
    assert.equal(extract({ sourceUrl: url, body: `<script>window.anything=${JSON.stringify(state())}</script>` }), null);
    assert.equal(read({ ...state(), arbitrary: { b: { 'eng-US': fields() } }, 12345: {} }), null);
    const record = fields(); record[altKey] = { key: 'UNRELATED_ALT', value: record[altKey].value }; assert.equal(read(state(record)), null);
    const markup = fields(); markup[altKey].value = '<b>Synthetic Systems North America</b>'; assert.equal(read(state(markup)), null);
  } },
  { name: 'careers CMS rejects missing or conflicting record pairs, wrong account URLs and duplicate envelopes', run() {
    const unpaired = fields(); delete unpaired[textKey]; assert.equal(read(state(unpaired)), null);
    const labelled = fields(); labelled[textKey].value = 'Visit our client'; assert.equal(read(state(labelled)), null);
    const wrongUrl = fields(); wrongUrl[linkKey].value = 'https://foreign.test/jobs'; assert.equal(read(state(wrongUrl)), null);
    const conflict = fields(); conflict[altKey].value = 'Different entity';
    assert.equal(read({ ...state(), 54321: { b: { 'eng-US': conflict } } }), null);
    assert.equal(extract({ sourceUrl: url, body: body(state()) + body(state()) }), null);
    const two = fields(); const secondKey = 'CAREERS_SECTION-2_LINK-1_URL';
    two[secondKey] = { key: secondKey, value: two[linkKey].value.replace(/001$/u, '002') };
    two[secondKey.replace(/URL$/u, 'TEXT')] = { key: secondKey.replace(/URL$/u, 'TEXT'), value: 'View Job Openings' };
    assert.equal(read(state(two)), null);
  } },
  { name: 'careers CMS stays bounded for huge HTML, JSON state and excessive depth', run() {
    assert.equal(extract({ sourceUrl: url, body: 'x'.repeat(3 * 1024 * 1024 + 1) }), null);
    assert.equal(extract({ sourceUrl: url, body: body(state()) + '<i></i>'.repeat(33_000) }), null);
    let nested = {}; for (let at = 0; at < 55; at++) nested = { child: nested };
    assert.equal(read({ ...state(), nested }), null);
  } },
  { name: 'Phenom careers pages yield their own search form and, on a search page, bounded job-detail links', run() {
    assert.deepEqual(phenomSearchForm(phenom(), 'https://careers.synthetic.test/'), { url: 'https://careers.synthetic.test/global/en/search-results', param: 'keywords' });
    assert.deepEqual(phenomSearchJobLinks(phenom(), search).map(link => link.url), [
      'https://careers.synthetic.test/global/en/job/R101/Software-Developer-II', 'https://careers.synthetic.test/global/en/job/R202/Data-Eng-Lead']);
    assert.deepEqual(phenomSearchJobLinks(phenom(), 'https://careers.synthetic.test/'), [], 'only a keyword search page lists jobs');
    assert.deepEqual(phenomSearchJobLinks(phenom(), 'https://careers.synthetic.test/global/en/search-results'), [], 'an unfiltered page is not a title search');
  } },
  { name: 'Phenom detection requires the bootstrap, the search route, and a same-origin locale base', run() {
    assert.equal(phenomSearchForm('<main>Jobs</main>', 'https://careers.synthetic.test/'), null);
    assert.equal(phenomSearchForm(phenom().replace('"search-results":"search-results"', '"other":"x"'), 'https://careers.synthetic.test/'), null);
    assert.equal(phenomSearchForm(phenom([], 'https://elsewhere.test/global/en/'), 'https://careers.synthetic.test/'), null);
    assert.equal(phenomSearchForm(phenom([], 'https://careers.synthetic.test/a/b/c/d/'), 'https://careers.synthetic.test/'), null);
    assert.equal(phenomSearchForm(phenom().replace('phApp = phApp ||', 'x ='), 'https://careers.synthetic.test/'), null);
  } },
];
