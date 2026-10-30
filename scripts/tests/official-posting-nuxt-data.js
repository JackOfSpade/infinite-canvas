import assert from 'node:assert/strict';
import { extractOfficialPostingNuxtData as extract } from '../../electron/ipc/officialPostingNuxtData.js';
import { officialPostingSemanticCandidateEvidence } from '../../electron/ipc/officialPostingSemantic.js';
import { normalizeOfficialLocation } from '../../electron/ipc/officialPostingFields.js';

const sourceUrl = 'https://synthetic.test/company/careers/roles/12345?gh_jid=12345';
const key = 'greenhouse-job-12345-auto';
const content = `<h2>Responsibilities</h2><p>${'Build reliable distributed services with the engineering team. '.repeat(12)}</p><h2>Requirements</h2><p>${'Experience maintaining production services and collaborating across teams. '.repeat(10)}</p>`;
function fixture(overrides = {}) {
  const values = [null];
  const add = value => {
    const at = values.length; values.push(null);
    values[at] = Array.isArray(value) ? value.map(add) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, add(child)])) : value;
    return at;
  };
  const job = add({ id: 12345, title: 'Software Engineer', content, absolute_url: sourceUrl,
    requisition_id: 'REQ-42', location: { name: 'Toronto, Canada' }, ...overrides });
  const record = values.length; values.push(null); values[record] = { boardToken: add('synthetic-board'), job };
  const data = values.length; values.push({ [key]: record });
  const dataWrapper = values.length; values.push(['ShallowReactive', data]);
  const once = values.length; values.push(['Set']);
  const errors = values.length; values.push({ [key]: -1 });
  const root = values.length; values.push({ data: dataWrapper, once, _errors: errors });
  values[0] = ['ShallowReactive', root];
  return { values, job, record, data, dataWrapper, root, add };
}
const body = values => `<script id="__NUXT_DATA__" type="application/json">${JSON.stringify(values).replace(/</gu, '\\u003C')}</script>`;
const read = (value = fixture(), options = {}) => extract({ body: body(value.values), sourceUrl, employer: 'Synthetic Systems', now: Date.parse('2030-01-01'), ...options });

export default [
  { name: 'Nuxt source parser retains complete URL-bound typed posting and independent employer context', run() {
    const [candidate] = read();
    assert.equal(candidate.title, 'Software Engineer'); assert.equal(candidate.employer, 'Synthetic Systems');
    assert.equal(candidate.location.display, 'Toronto, Canada'); assert.equal(candidate.identifier, 'REQ-42');
    assert.ok(candidate.description.endsWith('collaborating across teams.'));
    assert.equal(candidate.description.match(/Build reliable distributed services/gu).length, 12);
    assert.equal(candidate.sourceUrl, sourceUrl); assert.equal(candidate.live, true); assert.equal(candidate.isListed, true);
    assert.equal(candidate.tenantProven, undefined); assert.equal(candidate.domainProven, undefined); assert.equal(candidate.tenant, '');
    const reactive = fixture(); reactive.values[0][0] = 'Reactive'; reactive.values[reactive.dataWrapper][0] = 'Reactive';
    assert.equal(read(reactive).length, 1);
    assert.deepEqual(read(fixture(), { employer: '' }), []);
    assert.equal(read(fixture({ company_name: 'Authored Employer' }), { employer: '' })[0].employer, 'Authored Employer');
  } },
  { name: 'Nuxt source parser uses only a unique typed data key and rejects unrelated or ambiguous records', run() {
    const wrong = fixture(); wrong.values[wrong.data]['unrelated-job-12345'] = wrong.values[wrong.data][key]; delete wrong.values[wrong.data][key];
    assert.deepEqual(read(wrong), []);
    const duplicate = fixture(); duplicate.values[duplicate.data]['greenhouse-job-54321-auto'] = duplicate.record;
    assert.deepEqual(read(duplicate), []);
    const errorsOnly = fixture(); errorsOnly.values[errorsOnly.root].data = errorsOnly.values[errorsOnly.root]._errors;
    assert.deepEqual(read(errorsOnly), []);
    const plainRoot = fixture(); plainRoot.values[0] = plainRoot.values[plainRoot.root]; assert.deepEqual(read(plainRoot), []);
    assert.deepEqual(extract({ sourceUrl, employer: 'Synthetic Systems', body: body(fixture().values).replace('application/json', 'text/javascript') }), []);
    assert.deepEqual(extract({ sourceUrl, employer: 'Synthetic Systems', body: body(fixture().values) + body(fixture().values) }), []);
    assert.deepEqual(extract({ sourceUrl, employer: 'Synthetic Systems', body: '<svg>' + body(fixture().values) + '</svg>' }), []);
    assert.deepEqual(extract({ sourceUrl, employer: 'Synthetic Systems', body: '<script>window.jobs=' + JSON.stringify(fixture().values) + '</script>' }), []);
  } },
  { name: 'Nuxt source parser rejects mismatched posting IDs, hosts, paths, queries and unsafe URLs', run() {
    for (const url of [sourceUrl.replace('12345?', '54321?'), sourceUrl.replace('gh_jid=12345', 'gh_jid=54321'),
      sourceUrl + '&gh_jid=12345', sourceUrl + '&other=1', sourceUrl.replace('https:', 'http:'), sourceUrl.replace('synthetic.test', 'foreign.test'),
      sourceUrl.replace('/company/', '/other/'), sourceUrl.replace('synthetic.test', 'name:password@synthetic.test'), sourceUrl + '#apply']) {
      assert.deepEqual(read(fixture({ absolute_url: url })), [], url);
    }
    assert.deepEqual(read(fixture({ id: 54321 })), []);
    assert.deepEqual(read(fixture(), { sourceUrl: sourceUrl.replace('gh_jid=12345', 'gh_jid=54321') }), []);
    assert.deepEqual(read(fixture(), { sourceUrl: sourceUrl.replace('/roles/12345', '/roles/012345') }), []);
  } },
  { name: 'Nuxt source parser rejects invalid references, cycles, prototype keys and unsupported devalue tags', run() {
    const invalid = fixture(); invalid.values[invalid.job].content = invalid.values.length + 1; assert.deepEqual(read(invalid), []);
    const negative = fixture(); negative.values[negative.job].content = -2; assert.deepEqual(read(negative), []);
    const cycle = fixture(); cycle.values[cycle.job].loop = cycle.job; assert.deepEqual(read(cycle), []);
    const prototype = fixture(); Object.defineProperty(prototype.values[prototype.job], '__proto__', { value: prototype.job, enumerable: true });
    assert.deepEqual(read(prototype), []);
    const unknown = fixture(); unknown.values[unknown.dataWrapper][0] = 'ExecutableReducer'; assert.deepEqual(read(unknown), []);
    const inline = fixture(); inline.values[inline.job].content = { value: 'not a reference' }; assert.deepEqual(read(inline), []);
  } },
  { name: 'Nuxt source parser preserves explicit listing, closure and expiry cues without converting expiry to closure', run() {
    for (const flags of [{ isListed: false }, { is_listed: false }, { live: false }, { published: false }, { active: false },
      { closed: true }, { is_closed: true }, { status: 'closed' }, { status: 'unpublished' }]) {
      const [candidate] = read(fixture(flags)); assert.equal(candidate.isListed, false); assert.equal(candidate.live, false);
    }
    const [expired] = read(fixture({ application_deadline: '2029-12-31T00:00:00Z' }));
    assert.equal(expired.isListed, true); assert.equal(expired.live, false); assert.equal(expired.closed, undefined);
    assert.equal(expired.validThrough, '2029-12-31T00:00:00Z');
    const [multiple] = read(fixture({ validThrough: '2031-01-01', application_deadline: '2029-01-01' }));
    assert.equal(multiple.validThrough, '2029-01-01'); assert.equal(multiple.live, false);
    assert.deepEqual(read(fixture({ isListed: 'false' })), []); assert.deepEqual(read(fixture({ validThrough: 'invalid' })), []);
  } },
  { name: 'Nuxt source location preserves explicit remote restrictions and keeps unknown remote facts unspecified', run() {
    const [unknown] = read();
    assert.equal(unknown.location.remote, undefined);
    assert.match(officialPostingSemanticCandidateEvidence(unknown), /Remote: unspecified/u);
    assert.equal(read(fixture({ remote: null, workMode: '' }))[0].location.remote, undefined);
    const [country] = read(fixture({ location: { name: 'Remote - Canada' } }));
    assert.deepEqual(country.location, { display: 'Remote - Canada', workMode: 'remote', remote: true, remoteCountry: 'Canada', remoteRegion: '' });
    assert.deepEqual(normalizeOfficialLocation(country.location), country.location);
    assert.match(officialPostingSemanticCandidateEvidence(country), /Remote: true\nRemote country: Canada/u);
    const [typed] = read(fixture({ location: { name: 'Distributed team', remote: true, remoteCountry: 'Canada', remoteRegion: 'Ontario' } }));
    assert.equal(typed.location.remote, true); assert.equal(typed.location.workMode, 'remote'); assert.equal(typed.location.remoteRegion, 'Ontario');
    const [emptyTopLevel] = read(fixture({ remoteCountry: '', workMode: '', location: { name: 'Distributed team', remote: true, remoteCountry: 'Canada' } }));
    assert.equal(emptyTopLevel.location.remoteCountry, 'Canada'); assert.equal(emptyTopLevel.location.remote, true);
    const [jobTyped] = read(fixture({ remote: false, workMode: 'hybrid' }));
    assert.equal(jobTyped.location.remote, false); assert.equal(jobTyped.location.workMode, 'hybrid');
    const [unrestricted] = read(fixture({ location: { name: 'Distributed team', remote: true } }));
    assert.equal(unrestricted.location.remote, true); assert.equal(unrestricted.location.remoteCountry, '');
    assert.equal(normalizeOfficialLocation(unrestricted.location), null);
    for (const display of ['Remote - Toronto', 'Remote - Ontario', 'Remote - Anywhere']) {
      const [candidate] = read(fixture({ location: { name: display } }));
      assert.equal(candidate.location.remoteCountry, ''); assert.equal(candidate.location.remoteRegion, '');
      assert.equal(candidate.location.remote, undefined);
    }
    for (const fields of [{ location: { name: 'Remote - Canada', remote: false } },
      { location: { name: 'Remote - Canada', remoteCountry: 'United States' } },
      { remote: true, location: { name: 'Toronto', remote: false } }, { remote: 'true' },
      { workMode: 'remote', remote: false }]) assert.deepEqual(read(fixture(fields)), []);
  } },
  { name: 'Nuxt source parser sanitizes full description and rejects incomplete, huge or excessively nested data', run() {
    const [candidate] = read(fixture({ content: content + '<script>active script</script><style>hidden style</style>' }));
    assert.ok(!candidate.description.includes('active script')); assert.ok(!candidate.description.includes('hidden style'));
    assert.deepEqual(read(fixture({ content: 'Preview only' })), []);
    assert.deepEqual(extract({ sourceUrl, employer: 'Synthetic Systems', body: 'x'.repeat(3 * 1024 * 1024 + 1) }), []);
    const huge = fixture(); for (let at = 0; at < 33_000; at++) huge.values.push(null); assert.deepEqual(read(huge), []);
    const deep = fixture(); let previous = deep.job;
    for (let at = 0; at < 55; at++) { const index = deep.values.length; deep.values.push({ child: previous }); previous = index; }
    assert.deepEqual(read(deep), []);
    assert.deepEqual(read(fixture({ content: '<div>'.repeat(55) + content + '</div>'.repeat(55) })), []);
  } },
];
