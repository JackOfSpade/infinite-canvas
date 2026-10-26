import assert from 'node:assert/strict';
import {
  buildListingLivenessRequest, LISTING_LIVENESS_CORRECTION_TEMPLATES,
  LISTING_LIVENESS_RESPONSE_SCHEMA, LISTING_LIVENESS_TASK, validateListingLivenessResponse,
} from '../../electron/ipc/listingLivenessAi.js';
import { bridgeLinked, bridgeWorkerPoolActive } from '../../electron/ipc/handoffBridge/bridgeAvailability.js';

const fixture = (extra = {}) => ({ row: { source: 'linkedin', title: 'Platform Engineer',
  company: 'Northwind Labs', location: 'Remote' }, evidence: {
  board: 'linkedin', requestedUrl: 'https://www.linkedin.com/jobs/view/123?tracking=private#details',
  finalUrl: 'https://www.linkedin.com/jobs/view/123?source=private', httpStatus: 200,
  expectedTitle: 'Platform Engineer', expectedCompany: 'Northwind Labs', expectedLocation: 'Remote',
  title: 'Platform Engineer - Northwind Labs', h1: 'Platform Engineer',
  chromeText: 'Platform Engineer at Northwind Labs. Applications are open for this position.',
  descriptionText: 'The role supports platform services. The release calendar closes in November.',
  descriptionIsPage: false, closedHits: [], openSignals: [{ ruleId: 'hidden-control', state: 'shadow' }],
  jsonLd: { validThrough: '', isListed: null }, redirectedAway: false, titleMatchesPage: true,
  ...extra,
} });
const answer = (verdict = 'open', quote = 'Applications are open for this position.') => ({
  rows: [{ id: 'r1', verdict, quote }],
});
function rejectRule(value, members, ruleId) {
  assert.throws(() => validateListingLivenessResponse(value, members), error => {
    assert.equal(error.code, 'LISTING_LIVENESS_RESPONSE_INVALID');
    assert.ok(error.correctionRuleIds?.includes(ruleId), JSON.stringify(error.correctionRuleIds));
    assert.ok(error.correctionDetails?.every(line => !line.includes('Northwind Labs') && !line.includes('Applications are open')),
      'correction lines do not disclose expected page text');
    return true;
  });
}

export default [
  { name: 'listing liveness request sends bounded page evidence in an untrusted JSON fence without open signals', run: () => {
    const request = buildListingLivenessRequest([fixture({ title: '<script>Platform Engineer</script>' })], { batch: 2, batchTotal: 3 });
    assert.equal(request.task, LISTING_LIVENESS_TASK);
    assert.equal(request.format, 'json');
    assert.equal(request.responseSchema, LISTING_LIVENESS_RESPONSE_SCHEMA);
    assert.deepEqual(request.hints, { itemCount: 1, batch: 2, batchTotal: 3 });
    assert.deepEqual(request.manualHandoff, {});
    assert.match(request.prompt, /<untrusted-job-listing-pages-[a-f0-9]{8}>/u);
    assert.match(request.prompt, /<\/untrusted-job-listing-pages-[a-f0-9]{8}>/u);
    assert.ok(!request.prompt.includes('<script>') && request.prompt.includes('\\u003cscript\\u003e'));
    assert.ok(!request.prompt.includes('openSignals') && !request.prompt.includes('hidden-control'));
    assert.ok(!request.prompt.includes('descriptionText') && !request.prompt.includes('The role supports'));
    assert.ok(!request.prompt.includes('tracking=private') && !request.prompt.includes('source=private'));
    assert.ok(request.prompt.includes('jobs/view/123'));
    assert.equal(request.responseValidator(answer()).rows.length, 1);
  } },
  { name: 'listing liveness prompt labels outside and inside hits and whole-page text; ids follow input order', run: () => {
    const second = fixture({ board: 'ziprecruiter', descriptionIsPage: true,
      closedHits: [{ ruleId: 'closed-notice', insideDescription: false, context: 'This job has expired.' },
        { ruleId: 'ordinary-expiry', insideDescription: true, context: 'Project expires next week.' }] });
    const request = buildListingLivenessRequest([fixture(), second]);
    assert.ok(request.prompt.includes('"id":"r1"') && request.prompt.includes('"id":"r2"'));
    assert.ok(request.prompt.includes('"location":"outside description"'));
    assert.ok(request.prompt.includes('"location":"inside description"'));
    assert.ok(request.prompt.includes('the whole page text is supplied'));
    assert.ok(request.prompt.includes('"pageText":'));
    assert.equal(request.responseValidator({ rows: [
      { id: 'r1', verdict: 'unclear', quote: '' }, { id: 'r2', verdict: 'unclear', quote: '' },
    ] }).rows.length, 2);
  } },
  { name: 'listing liveness validator enforces exact id coverage and response row fields', run: () => {
    const members = [fixture(), fixture()];
    rejectRule({ rows: [{ id: 'r1', verdict: 'unclear', quote: '' }] }, members, 'LIVENESS_ID_MISSING');
    rejectRule({ rows: [{ id: 'r1', verdict: 'unclear', quote: '' }, { id: 'r1', verdict: 'unclear', quote: '' }] }, members, 'LIVENESS_ID_DUPLICATE');
    rejectRule({ rows: [{ id: 'r1', verdict: 'unclear', quote: '' }, { id: 'r9', verdict: 'unclear', quote: '' }] }, members, 'LIVENESS_ID_UNKNOWN');
    rejectRule({ rows: [{ id: 'r1', verdict: 'unclear', quote: '', extra: true },
      { id: 'r2', verdict: 'unclear', quote: '' }] }, members, 'LIVENESS_ROW_FIELDS');
    rejectRule({ rows: [{ id: 'r1', verdict: 'maybe', quote: '' },
      { id: 'r2', verdict: 'unclear', quote: '' }] }, members, 'LIVENESS_VERDICT');
  } },
  { name: 'listing liveness validator rejects missing, long and foreign quotes', run: () => {
    const members = [fixture()];
    rejectRule(answer('open', ''), members, 'LIVENESS_QUOTE_REQUIRED');
    rejectRule(answer('closed', ''), members, 'LIVENESS_QUOTE_REQUIRED');
    rejectRule(answer('open', 'x'.repeat(241)), members, 'LIVENESS_QUOTE_TOO_LONG');
    rejectRule(answer('closed', 'The job is permanently gone.'), members, 'LIVENESS_QUOTE_NOT_ON_PAGE');
    rejectRule(answer('unclear', 'Applications are open for this position.'), members, 'LIVENESS_UNCLEAR_QUOTE');
  } },
  { name: 'listing liveness validator excludes description evidence and requires one sent piece', run: () => {
    const members = [fixture({ descriptionText: 'The release calendar closes in November.',
      chromeText: 'The release calendar closes in November. Applications are open for this position.' })];
    rejectRule(answer('closed', 'The release calendar closes in November.'), members, 'LIVENESS_QUOTE_IN_DESCRIPTION');
    rejectRule(answer('open', 'Northwind Labs Platform Engineer'), members, 'LIVENESS_QUOTE_NOT_ON_PAGE');
    assert.equal(validateListingLivenessResponse(answer('open', 'APPLICATIONS ARE OPEN FOR THIS POSITION.'), members).rows.length, 1);
  } },
  { name: 'listing liveness validator rejects open on redirected or title-mismatched pages', run: () => {
    rejectRule(answer(), [fixture({ redirectedAway: true })], 'LIVENESS_OPEN_MISMATCH');
    rejectRule(answer(), [fixture({ titleMatchesPage: false })], 'LIVENESS_OPEN_MISMATCH');
    assert.equal(validateListingLivenessResponse(answer('unclear', ''), [fixture({ redirectedAway: true, titleMatchesPage: false })]).rows[0].verdict, 'unclear');
  } },
  { name: 'listing liveness validator allows closed with no quote only for isListed false and whole-page description quotes', run: () => {
    assert.equal(validateListingLivenessResponse(answer('closed', ''), [fixture({ jsonLd: { isListed: false } })]).rows[0].verdict, 'closed');
    const wholePage = fixture({ descriptionIsPage: true,
      chromeText: 'Platform Engineer. This job has expired.', descriptionText: 'Platform Engineer. This job has expired.' });
    assert.equal(validateListingLivenessResponse(answer('closed', 'This job has expired.'), [wholePage]).rows[0].verdict, 'closed');
    const longPage = fixture({ descriptionIsPage: true,
      chromeText: 'Platform Engineer. Current listing details.',
      descriptionText: `${'Ordinary page details. '.repeat(160)}This job has expired.` });
    assert.ok(buildListingLivenessRequest([longPage]).prompt.includes('This job has expired.'));
    assert.equal(validateListingLivenessResponse(answer('closed', 'This job has expired.'), [longPage]).rows[0].verdict, 'closed');
    rejectRule(answer('closed', ''), [fixture({ jsonLd: { isListed: null } })], 'LIVENESS_QUOTE_REQUIRED');
  } },
  { name: 'listing liveness quote normalization removes format characters on both sides', run: () => {
    const members = [fixture({ chromeText: 'Applications are o\u200bpen for this position.', descriptionText: '' })];
    assert.equal(validateListingLivenessResponse(answer('open', 'Applications are open for this position.'), members).rows.length, 1);
    const inDescription = [fixture({ chromeText: 'Applications are o\u200bpen for this position.',
      descriptionText: 'Applications are open for this position.' })];
    rejectRule(answer('open', 'Applications are o\u200bpen for this position.'), inDescription, 'LIVENESS_QUOTE_IN_DESCRIPTION');
  } },
  { name: 'listing liveness templates and strict bridge readiness are available', run: () => {
    assert.ok(Object.isFrozen(LISTING_LIVENESS_CORRECTION_TEMPLATES));
    assert.equal(Object.keys(LISTING_LIVENESS_CORRECTION_TEMPLATES).length, 13);
    const linked = { enabled: true, link: { state: 'linked' }, chat: { pool: { active: false } } };
    assert.equal(bridgeLinked(linked), true);
    assert.equal(bridgeWorkerPoolActive(linked), false);
    assert.equal(bridgeWorkerPoolActive({ ...linked, chat: { pool: { active: true } } }), true);
    assert.equal(bridgeLinked({ ...linked, enabled: false }), false);
    assert.equal(bridgeLinked({ ...linked, link: { state: 'pairing' } }), false);
    assert.equal(bridgeWorkerPoolActive({ ...linked, link: { state: 'pairing' }, chat: { pool: { active: true } } }), false);
  } },
];
