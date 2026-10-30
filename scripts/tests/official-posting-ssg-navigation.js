import assert from 'node:assert/strict';
import { scanOfficialPostingSsgNavigation as scan, scanOfficialPostingSsgNavigationInventory as inventory } from '../../electron/ipc/officialPostingSsgNavigation.js';

const origin = 'https://synthetic.test';
const link = slug => ({ _type: 'internalLink', targetBlank: false, text: slug === 'careers' ? 'Careers' : 'Open Roles',
  reference: { _type: 'page', parent: null, language: null, slug: { _type: 'slug', current: slug }, title: slug === 'careers' ? 'Careers' : 'Open Roles' } });
const fixture = (path = '') => ({ settings: { _type: 'settings', orgUrl: origin + '/',
  companySection: { _type: 'menuSection', linkLists: [{ _type: 'linkList', links: [link('careers'), link('open-roles')] }] },
  footerLinks: [{ _type: 'linkList', links: [link('careers')] }] },
content: { _type: 'page', parent: null, path, slug: { _type: 'slug', current: path || 'home' } } });
const script = (id, value) => `<script id="${id}" type="application/json">${JSON.stringify(value).replace(/</gu, '\\u003C')}</script>`;
const body = (value = fixture(), sourceUrl = origin + '/') => `<link rel="canonical" href="${sourceUrl}">`
  + script('ssgContent', value.content) + script('ssgSiteSettings', value.settings);
const read = (value = fixture(), sourceUrl = origin + '/') => scan({ body: body(value, sourceUrl), sourceUrl });

export default [
  { name: 'SSG navigation emits corroborated typed company/footer careers routes once without ownership flags', run() {
    const result = read();
    assert.deepEqual(result.map(value => value.url), [origin + '/careers', origin + '/open-roles']);
    assert.deepEqual(Object.keys(result[0]).sort(), ['attribute', 'tag', 'url']);
    assert.equal(result[0].tag, 'declaration'); assert.equal(result[0].attribute, 'url');
    assert.deepEqual(read(fixture('careers'), origin + '/careers'), result);
    assert.deepEqual(read(fixture('open-roles'), origin + '/open-roles'), result);
  } },
  { name: 'SSG settings, content, slug and canonical must bind the actual same-origin current page', run() {
    for (const alter of [value => { value.settings._type = 'unknown'; }, value => { value.settings.orgUrl = 'https://foreign.test/'; },
      value => { value.settings.orgUrl = origin + '/other'; }, value => { value.content._type = 'settings'; },
      value => { value.content.path = 'other'; }, value => { value.content.slug.current = 'other'; },
      value => { value.content.parent = { slug: 'other' }; }, value => { value.content.language = 'fr'; }]) {
      const value = fixture(); alter(value); assert.deepEqual(read(value), []);
    }
    assert.deepEqual(scan({ sourceUrl: origin + '/', body: body(fixture(), origin + '/other') }), []);
    assert.deepEqual(scan({ sourceUrl: origin + '/', body: body() + '<link rel="canonical" href="https://foreign.test/">' }), []);
    assert.deepEqual(read(fixture(), origin + '/?preview=true'), []);
    assert.deepEqual(read(fixture('home'), origin + '/home'), []);
    assert.deepEqual(read(fixture(), origin.replace('https:', 'http:') + '/'), []);
    assert.deepEqual(read(fixture(), origin.replace('synthetic.test', 'name:password@synthetic.test') + '/'), []);
  } },
  { name: 'SSG navigation ignores unrelated trees, external links and incomplete or conflicting labels', run() {
    const nested = fixture(); delete nested.settings.companySection; delete nested.settings.footerLinks;
    nested.settings.arbitrary = { links: [link('careers')] }; nested.content.slices = [{ links: [link('open-roles')] }];
    assert.deepEqual(read(nested), []);
    for (const alter of [value => { value._type = 'externalLink'; }, value => { value.targetBlank = true; }, value => { value.hidden = true; },
      value => { value.text = 'Explore jobs'; }, value => { value.reference.title = 'Other'; }, value => { value.reference.parent = { _type: 'page' }; },
      value => { value.reference.language = 'en'; }, value => { delete value.reference.language; }, value => { value.reference._type = 'externalPage'; },
      value => { value.reference.slug.current = '../careers'; }, value => { value.reference.slug.current = 'https://foreign.test/careers'; }]) {
      const value = fixture(); delete value.settings.footerLinks; const target = value.settings.companySection.linkLists[0].links[0];
      value.settings.companySection.linkLists[0].links = [target]; alter(target); assert.deepEqual(read(value), []);
    }
    const hidden = fixture(); hidden.settings.companySection.hidden = true; delete hidden.settings.footerLinks; assert.deepEqual(read(hidden), []);
  } },
  { name: 'SSG parser requires unique inert HTML JSON declarations and rejects arbitrary executable data', run() {
    for (const html of [body() + script('ssgSiteSettings', fixture().settings), body().replace('application/json', 'text/javascript'),
      body().replace('id="ssgContent"', 'id="ssgContent" src="/data.js"'), '<svg>' + body() + '</svg>',
      '<link rel="canonical" href="https://synthetic.test/"><script>window.ssgSiteSettings=' + JSON.stringify(fixture().settings) + '</script>']) {
      assert.deepEqual(scan({ sourceUrl: origin + '/', body: html }), []);
    }
    const prototype = fixture(); Object.defineProperty(prototype.settings, '__proto__', { enumerable: true, value: { unsafe: true } });
    assert.deepEqual(read(prototype), []);
  } },
  { name: 'SSG typed inventory receipts preserve uncertainty for every recognized structural ceiling', run() {
    const normal = inventory({ body: body(), sourceUrl: origin + '/' });
    assert.deepEqual(normal, { links: read(), coverageIncomplete: false });
    const huge = fixture(); huge.settings.extra = 'x'.repeat(512 * 1024);
    const deep = fixture(); let nested = {}; for (let at = 0; at < 55; at++) nested = { child: nested }; deep.content.extra = nested;
    const nodes = fixture(); nodes.settings.extra = Array.from({ length: 33_000 }, () => null);
    for (const html of [body(huge), body(deep), body(nodes), body() + '<i></i>'.repeat(33_000),
      body() + 'x'.repeat(3 * 1024 * 1024), '<div>'.repeat(55) + body() + '</div>'.repeat(55)]) {
      assert.deepEqual(inventory({ body: html, sourceUrl: origin + '/' }), { links: [], coverageIncomplete: true });
    }
    // Even a declaration beyond the inspected prefix must not disappear as a complete empty page.
    for (const html of ['<i></i>'.repeat(33_000) + body(),
      '<i></i>'.repeat(33_000) + body().replace('id="ssgContent"', 'ID="ssg&#67;ontent"'),
      'x'.repeat(3 * 1024 * 1024 + 1), '<i></i>'.repeat(33_000)]) {
      assert.deepEqual(inventory({ body: html, sourceUrl: origin + '/' }), { links: [], coverageIncomplete: true });
    }
    assert.deepEqual(inventory({ body: '<div>Ordinary small page</div>', sourceUrl: origin + '/' }), { links: [], coverageIncomplete: false });
  } },
  { name: 'SSG unreadable recognized declarations cannot silently claim complete navigation or supply links', run() {
    for (const html of [body() + script('ssgSiteSettings', fixture().settings),
      body().replace(script('ssgContent', fixture().content), '<script id="ssgContent" type="application/json">{invalid</script>'),
      script('ssgContent', fixture().content), body().replace('application/json', 'text/javascript'),
      body().replace('id="ssgContent"', 'id="ssgContent" src="/data.js"'),
      body({ ...fixture(), settings: { _type: 'unrelated', orgUrl: 'https://foreign.test/' } })]) {
      assert.deepEqual(inventory({ body: html, sourceUrl: origin + '/' }), { links: [], coverageIncomplete: true });
      assert.deepEqual(scan({ body: html, sourceUrl: origin + '/' }), []);
    }
    assert.deepEqual(inventory({ body: '<script>window.ssgSiteSettings={}</script>', sourceUrl: origin + '/' }), { links: [], coverageIncomplete: false });
    assert.deepEqual(inventory({ body: body(), sourceUrl: 'http://synthetic.test/' }), { links: [], coverageIncomplete: false });
  } },
  { name: 'SSG parsing bounds JSON bytes, structural depth, nodes and HTML before extracting routes', run() {
    const huge = fixture(); huge.settings.extra = 'x'.repeat(512 * 1024); assert.deepEqual(read(huge), []);
    const deep = fixture(); let nested = {}; for (let at = 0; at < 55; at++) nested = { child: nested }; deep.content.extra = nested; assert.deepEqual(read(deep), []);
    const nodes = fixture(); nodes.content.extra = Array.from({ length: 33_000 }, () => null); assert.deepEqual(read(nodes), []);
    assert.deepEqual(scan({ sourceUrl: origin + '/', body: body() + '<i></i>'.repeat(33_000) }), []);
    assert.deepEqual(scan({ sourceUrl: origin + '/', body: 'x'.repeat(3 * 1024 * 1024 + 1) }), []);
  } },
];
