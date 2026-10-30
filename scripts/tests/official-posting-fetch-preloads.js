import assert from 'node:assert/strict';
import { scanOfficialPostingFetchPreloads as scan } from '../../electron/ipc/officialPostingFetchPreloads.js';

const sourceUrl = 'https://synthetic.test/careers/open-roles';
const link = (href, extra = '') => `<link rel="preload" as="fetch" crossorigin="anonymous" href="${href}" ${extra}>`;
const read = body => scan({ body, sourceUrl });

export default [
  { name: 'Authored anonymous fetch preloads resolve exact same-origin URLs and actual document base without proof fields', run() {
    assert.deepEqual(read(link('assets/data.json')), { urls: ['https://synthetic.test/careers/assets/data.json'], coverageIncomplete: false });
    const result = read('<base href="/">' + link('assets/data.json') + link('/assets/shader.vs') + link('/assets/data.json'));
    assert.deepEqual(result, { urls: ['https://synthetic.test/assets/data.json', 'https://synthetic.test/assets/shader.vs'], coverageIncomplete: false });
    assert.deepEqual(Object.keys(result).sort(), ['coverageIncomplete', 'urls']);
    assert.deepEqual(read('<link REL="preload modulepreload" AS="FETCH" crossorigin href="/data.json">').urls, ['https://synthetic.test/data.json']);
    assert.deepEqual(scan({ body: link('/data.json'), sourceUrl: sourceUrl + '?job=42' }).urls, ['https://synthetic.test/data.json']);
  } },
  { name: 'Fetch preload scope rejects other origins, unsafe URLs, credentialed modes and unrelated resource declarations', run() {
    for (const href of ['https://foreign.test/data.json', 'http://synthetic.test/data.json', 'https://user:password@synthetic.test/data.json',
      'https://synthetic.test:8443/data.json', '/data.json#fragment', 'data:application/json,{}', '//foreign.test/data.json']) assert.deepEqual(read(link(href)).urls, []);
    for (const body of ['<link rel="preload" as="fetch" crossorigin="use-credentials" href="/data.json">',
      '<link rel="preload" as="fetch" href="/data.json">', '<link rel="prefetch" as="fetch" crossorigin="anonymous" href="/data.json">',
      '<link rel="preload" as="font" crossorigin="anonymous" href="/font.woff2">', '<link rel="preload" as="image" crossorigin="anonymous" href="/image.png">',
      '<script>window.preload=' + JSON.stringify('/data.json') + '</script>', '<svg>' + link('/data.json') + '</svg>',
      '<template>' + link('/data.json') + '</template>']) assert.deepEqual(read(body).urls, [], body);
    assert.deepEqual(scan({ body: link('/data.json'), sourceUrl: 'http://synthetic.test/' }).urls, []);
  } },
  { name: 'Ambiguous or unsafe document bases leave preload coverage explicitly incomplete', run() {
    for (const base of ['<base href="https://foreign.test/">', '<base href="/?token=other">', '<base href="/"><base href="/">',
      '<base href="http://synthetic.test/">', '<base href="https://user:password@synthetic.test/">']) {
      assert.deepEqual(read(base + link('/data.json')), { urls: [], coverageIncomplete: true });
    }
  } },
  { name: 'Fetch preload byte, node, depth and URL-set ceilings never return a silently complete subset', run() {
    assert.deepEqual(read('x'.repeat(3 * 1024 * 1024 + 1)), { urls: [], coverageIncomplete: true });
    assert.deepEqual(read(link('/data.json') + '<i></i>'.repeat(33_000)), { urls: [], coverageIncomplete: true });
    assert.deepEqual(read(link('/data.json') + '<div>'.repeat(55) + 'deep' + '</div>'.repeat(55)), { urls: [], coverageIncomplete: true });
    assert.deepEqual(read(Array.from({ length: 65 }, (_, at) => link(`/resource-${at}.json`)).join('')), { urls: [], coverageIncomplete: true });
    assert.equal(read(Array.from({ length: 64 }, (_, at) => link(`/resource-${at}.json`)).join('')).urls.length, 64);
    assert.equal(read(Array.from({ length: 100 }, () => link('/same-resource.json')).join('')).urls.length, 1);
  } },
];
