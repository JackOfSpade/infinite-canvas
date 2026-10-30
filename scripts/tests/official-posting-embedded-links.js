import assert from 'node:assert/strict';
import {
  scanEmbeddedOfficialJobLinks, OFFICIAL_EMBEDDED_LINK_MAX_BYTES,
  OFFICIAL_EMBEDDED_LINK_MAX_NODES, OFFICIAL_EMBEDDED_LINK_MAX_LINKS,
} from '../../electron/ipc/officialPostingEmbeddedLinks.js';

const sourceUrl = 'https://www.synthetic-employer.com/careers';
const jobUrl = 'https://jobs.ashbyhq.com/synthetic-employer/synthetic-role';
const job = (extra = {}) => ({ title: 'Synthetic Platform Role', jobUrl,
  applyUrl: jobUrl + '/application', ...extra });
const jsonScript = (value, attributes = 'type="application/json"') =>
  '<script ' + attributes + '>' + JSON.stringify(value) + '</script>';
const flightScript = value => '<script>self.__next_f.push(' + JSON.stringify([1,
  'a:["$","$L4",null,' + JSON.stringify(value) + ']\nb:I["client-module"]\n']) + ')</script>';
const expected = [
  { url: jobUrl, tag: 'data', attribute: 'jobUrl' },
  { url: jobUrl + '/application', tag: 'data', attribute: 'applyUrl' },
];

export default [
  {
    name: 'embedded official links parse framework JSON and Next Flight transport without executing page code',
    run() {
      for (const html of [jsonScript({ props: { pageProps: { jobs: [job()] } } }, 'id="__NEXT_DATA__" type="application/json"'),
        jsonScript({ jobs: [job()] }), jsonScript({ jobs: [job()] }, 'id="__NEXT_DATA__"'), flightScript({ jobs: [job()] })]) {
        assert.deepEqual(scanEmbeddedOfficialJobLinks(html, sourceUrl), expected);
      }
      assert.deepEqual(scanEmbeddedOfficialJobLinks(flightScript({ jobs: [job(), job()] }) + jsonScript(job()), sourceUrl), expected,
        'the same declared URL is emitted only once across framework payloads');
    },
  },
  {
    name: 'embedded official links require typed fields and a title in the same record with consistent posting identities',
    run() {
      for (const value of [
        { title: 'Synthetic role', url: jobUrl }, { title: 'Synthetic role', metadata: { jobUrl } }, { jobUrl },
        job({ title: '' }), job({ title: '<b>Synthetic role</b>' }), job({ title: 'x'.repeat(501) }),
        job({ applyUrl: 'https://jobs.ashbyhq.com/another-employer/synthetic-role/application' }),
        job({ applyUrl: 'https://jobs.ashbyhq.com/synthetic-employer/different-role/application' }),
        { article: { title: 'Synthetic article' }, outbound: { jobUrl } },
      ]) assert.deepEqual(scanEmbeddedOfficialJobLinks(jsonScript(value), sourceUrl), [], JSON.stringify(value));
      assert.deepEqual(scanEmbeddedOfficialJobLinks(jsonScript({ title: 'Synthetic role', jobUrl }), sourceUrl), [expected[0]]);
      assert.deepEqual(scanEmbeddedOfficialJobLinks(jsonScript({ title: 'Synthetic role', applyUrl: jobUrl + '/application' }), sourceUrl), [expected[1]]);
    },
  },
  {
    name: 'embedded official links ignore unrelated JavaScript literals, unrecognized scripts and inert nested JSON strings',
    run() {
      const value = JSON.stringify(job());
      for (const html of [
        '<script>const unrelated = ' + value + ';</script>', '<script>doSomething(' + value + ');</script>',
        '<script>self.__next_f.push(' + JSON.stringify([0, 'a:' + value]) + ')</script>',
        '<script>self.__next_f.push(' + JSON.stringify([1, 'a:' + value]) + '); sideEffect();</script>',
        jsonScript(job(), 'src="https://cdn.example.com/script.js" type="application/json"'),
        jsonScript(job(), 'src="" type="application/json"'), jsonScript(job(), 'type="text/plain"'),
        '<svg>' + jsonScript(job()) + '</svg>', '<template>' + jsonScript(job()) + '</template>',
        jsonScript({ description: value }), '<p>' + value + '</p>',
      ]) assert.deepEqual(scanEmbeddedOfficialJobLinks(html, sourceUrl), [], html);
      assert.deepEqual(scanEmbeddedOfficialJobLinks('<script>self.__next_f.push([1,notJson])</script>', sourceUrl), []);
    },
  },
  {
    name: 'embedded official links reject unsafe URLs, non-ATS sites, board roots and malformed paired metadata',
    run() {
      for (const value of ['http://jobs.ashbyhq.com/synthetic-employer/role',
        'https://user:secret@jobs.ashbyhq.com/synthetic-employer/role', 'https://jobs.ashbyhq.com:444/synthetic-employer/role',
        'https://www.linkedin.com/jobs/view/synthetic', 'https://careers.synthetic-employer.com/jobs/role',
        'https://jobs.ashbyhq.com/synthetic-employer', 'https://job-boards.greenhouse.io/synthetic-employer',
        'https://jobs.ashbyhq.com/synthetic-employer/role\n', 'javascript:alert(1)', null, {}]) {
        assert.deepEqual(scanEmbeddedOfficialJobLinks(jsonScript({ title: 'Synthetic role', jobUrl: value }), sourceUrl), []);
      }
      assert.deepEqual(scanEmbeddedOfficialJobLinks(jsonScript(job({ applyUrl: 'http://private.invalid/role' })), sourceUrl), []);
      for (const base of ['http://careers.example.com/', 'https://user:secret@careers.example.com/', 'not a URL']) {
        assert.deepEqual(scanEmbeddedOfficialJobLinks(jsonScript(job()), base), []);
      }
      assert.deepEqual(scanEmbeddedOfficialJobLinks(jsonScript({ title: 'Synthetic role',
        jobUrl: 'https://job-boards.greenhouse.io/synthetic-employer/jobs/123',
        applyUrl: 'https://boards.greenhouse.io/synthetic-employer/jobs/123#app' }), sourceUrl), [
        { url: 'https://job-boards.greenhouse.io/synthetic-employer/jobs/123', tag: 'data', attribute: 'jobUrl' },
        { url: 'https://boards.greenhouse.io/synthetic-employer/jobs/123', tag: 'data', attribute: 'applyUrl' },
      ]);
    },
  },
  {
    name: 'embedded official links bound source bytes, decoded data, object traversal and returned links',
    run() {
      assert.deepEqual(scanEmbeddedOfficialJobLinks('x'.repeat(OFFICIAL_EMBEDDED_LINK_MAX_BYTES + 1), sourceUrl), []);
      assert.deepEqual(scanEmbeddedOfficialJobLinks(jsonScript(job()) + '\0', sourceUrl), []);
      const objects = Array.from({ length: OFFICIAL_EMBEDDED_LINK_MAX_NODES }, () => ({}));
      assert.deepEqual(scanEmbeddedOfficialJobLinks(jsonScript([job(), ...objects]), sourceUrl), []);
      let deep = job();
      for (let index = 0; index < 65; index++) deep = { child: deep };
      assert.deepEqual(scanEmbeddedOfficialJobLinks(jsonScript(deep), sourceUrl), []);
      assert.deepEqual(scanEmbeddedOfficialJobLinks(jsonScript(job()) + '<i></i>'.repeat(32768), sourceUrl), []);
      const many = Array.from({ length: OFFICIAL_EMBEDDED_LINK_MAX_LINKS + 1 }, (_, index) => ({
        title: 'Synthetic role', jobUrl: jobUrl + '-' + index,
      }));
      assert.deepEqual(scanEmbeddedOfficialJobLinks(jsonScript(many), sourceUrl), []);
      const within = many.slice(0, OFFICIAL_EMBEDDED_LINK_MAX_LINKS);
      assert.equal(scanEmbeddedOfficialJobLinks(jsonScript(within), sourceUrl).length, OFFICIAL_EMBEDDED_LINK_MAX_LINKS);
      const escaped = JSON.stringify({ padding: '\\'.repeat(600_000), jobs: [job()] });
      const nested = jsonScript(escaped);
      assert.ok(Buffer.byteLength(nested) < OFFICIAL_EMBEDDED_LINK_MAX_BYTES);
      assert.deepEqual(scanEmbeddedOfficialJobLinks(nested, sourceUrl), [], 'cumulative decoded JSON bytes are bounded too');
    },
  },
  {
    name: 'embedded official links bound outer JSON-string decoding and never expose job text in link receipts',
    run() {
      const payload = { jobs: [job({ description: 'SYNTHETIC_INERT_DESCRIPTION', location: 'Synthetic City' })] };
      assert.deepEqual(scanEmbeddedOfficialJobLinks(jsonScript(JSON.stringify(payload)), sourceUrl), expected);
      assert.deepEqual(scanEmbeddedOfficialJobLinks(jsonScript(JSON.stringify(JSON.stringify(payload))), sourceUrl), expected);
      const tooDeep = jsonScript(JSON.stringify(JSON.stringify(JSON.stringify(payload))));
      assert.deepEqual(scanEmbeddedOfficialJobLinks(tooDeep, sourceUrl), []);
      const result = scanEmbeddedOfficialJobLinks(flightScript(payload), sourceUrl);
      assert.deepEqual(result, expected);
      assert.equal(JSON.stringify(result).includes('SYNTHETIC_INERT_DESCRIPTION'), false);
    },
  },
];
