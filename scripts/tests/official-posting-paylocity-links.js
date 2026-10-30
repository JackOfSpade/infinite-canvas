import assert from 'node:assert/strict';
import { scanOfficialPostingPaylocityLinks as scan, scanOfficialPostingPaylocityInventory as inventory } from '../../electron/ipc/officialPostingPaylocityLinks.js';

const account = '40000000-0000-4000-8000-000000000001';
const sourceUrl = `https://recruiting.paylocity.com/Recruiting/Jobs/All/${account}/Synthetic-Systems`;
const base = "(function () { window.ATSPublicBaseUrl = 'https://recruiting.paylocity.com/Recruiting/'; window.ATSJobDetailsBaseUrl = '/Recruiting/Jobs/Details/'; })();";
const job = id => ({ JobId: id, JobTitle: `Published role ${id}`, IsInternal: false, JobLocation: { ModuleId: 42 } });
const data = () => ({ ModuleId: '42', LeadJoinUrl: `/Recruiting/PublicLeads/New/${account}`, ShowInternal: false,
  Jobs: [job(109), job(102), job(101)] });
const script = value => `<script>${value}</script>`;
const body = (value = data(), config = base) => script(`window.pageData = ${JSON.stringify(value)};`) + script(config);
const read = (value = data(), options = {}) => scan({ sourceUrl, body: body(value, options.config ?? base), ...options });

export default [
  { name: 'Paylocity public inventory yields authored detail navigation in source order without ranking or authority claims', run() {
    const links = read();
    assert.deepEqual(links.map(link => link.url), [109, 102, 101].map(id => `https://recruiting.paylocity.com/Recruiting/Jobs/Details/${id}`));
    assert.deepEqual(Object.keys(links[0]).sort(), ['attribute', 'tag', 'url']);
    assert.equal(links[0].tag, 'data'); assert.equal(links[0].attribute, 'Jobs.JobId');
    const arbitraryTitles = data(); arbitraryTitles.Jobs[0].JobTitle = 'Unrelated role'; arbitraryTitles.Jobs[2].JobTitle = 'Exact desired role';
    assert.deepEqual(read(arbitraryTitles), links);
    const firstEight = data(); firstEight.Jobs = Array.from({ length: 10 }, (_, at) => job(110 - at));
    assert.deepEqual(read(firstEight).slice(0, 8).map(link => link.url.split('/').at(-1)), ['110', '109', '108', '107', '106', '105', '104', '103']);
  } },
  { name: 'Paylocity inventory binds exact public provider origin, account UUID and module identity', run() {
    for (const url of [sourceUrl.replace('recruiting.paylocity.com', 'recruiting.paylocity.com.evil.test'), sourceUrl.replace('recruiting.paylocity.com', 'careers.example.test'),
      sourceUrl.replace('https:', 'http:'), sourceUrl.replace('recruiting.paylocity.com', 'user:password@recruiting.paylocity.com'),
      sourceUrl.replace('recruiting.paylocity.com', 'recruiting.paylocity.com:8443'), sourceUrl.replace('/All/', '/Internal/'), sourceUrl + '/extra',
      sourceUrl + '?ShowInternal=true', sourceUrl + '?department=%00Engineering']) assert.deepEqual(read(data(), { sourceUrl: url }), [], url);
    const wrongAccount = data(); wrongAccount.LeadJoinUrl = wrongAccount.LeadJoinUrl.replace(/001$/u, '002'); assert.deepEqual(read(wrongAccount), []);
    const foreignAccount = data(); foreignAccount.LeadJoinUrl = 'https://foreign.test' + foreignAccount.LeadJoinUrl; assert.deepEqual(read(foreignAccount), []);
    const wrongModule = data(); wrongModule.Jobs[1].JobLocation.ModuleId = 43; assert.deepEqual(read(wrongModule), []);
    const missingModule = data(); delete missingModule.Jobs[0].JobLocation; assert.deepEqual(read(missingModule), []);
    const absoluteLead = data(); absoluteLead.LeadJoinUrl = 'https://recruiting.paylocity.com' + absoluteLead.LeadJoinUrl;
    assert.equal(read(absoluteLead).length, 3);
  } },
  { name: 'Paylocity inventory rejects internal, malformed or ambiguous detail rows', run() {
    for (const value of [true, 'false', null, undefined]) { const changed = data(); changed.ShowInternal = value; assert.deepEqual(read(changed), []); }
    for (const value of [true, 'false', undefined]) { const changed = data(); changed.Jobs[1].IsInternal = value; assert.deepEqual(read(changed), []); }
    for (const value of [0, -1, '001', '123/apply', '1?account=other', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const changed = data(); changed.Jobs[0].JobId = value; assert.deepEqual(read(changed), []);
    }
    const duplicate = data(); duplicate.Jobs.push(job(109)); assert.deepEqual(read(duplicate), []);
    const noModule = data(); delete noModule.ModuleId; assert.deepEqual(read(noModule), []);
    const prototype = data(); Object.defineProperty(prototype, '__proto__', { value: {}, enumerable: true }); assert.deepEqual(read(prototype), []);
  } },
  { name: 'Paylocity accepts only strict JSON pageData assignment and a single actual literal detail base declaration', run() {
    for (const config of ["window.ATSJobDetailsBaseUrl = 'https://foreign.test/Recruiting/Jobs/Details/';",
      "window.ATSJobDetailsBaseUrl = '/Recruiting/Jobs/Apply/';", "window.ATSJobDetailsBaseUrl = '/Recruiting/Jobs/Details/' + account;",
      "window.ATSJobDetailsBaseUrl = '/Recruiting/Jobs/Details/?next=';", base + base,
      "const text = \"window.ATSJobDetailsBaseUrl = '/Recruiting/Jobs/Details/';\";",
      "// window.ATSJobDetailsBaseUrl = '/Recruiting/Jobs/Details/';", "window.ATSJobDetailsBaseUrl = `/Recruiting/Jobs/Details/`;",
      "window.ATSJobDetailsBaseUrl = '\\x2fRecruiting/Jobs/Details/';", "foo.window.ATSJobDetailsBaseUrl = '/Recruiting/Jobs/Details/';",
      "'window'.ATSJobDetailsBaseUrl = '/Recruiting/Jobs/Details/';"]) {
      assert.deepEqual(read(data(), { config }), [], config);
    }
    assert.equal(read(data(), { config: "/* a literal inside a comment is not an assignment */ " + base }).length, 3);
    assert.equal(read(data(), { config: "window.ATSJobDetailsBaseUrl = 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/';" }).length, 3);
    const json = JSON.stringify(data());
    for (const declaration of [`window.pageData = JSON.parse(${JSON.stringify(json)});`, `window.pageData = ${json}; arbitrary();`,
      `window.pageData = ${json}; window.pageData = ${json};`, `window.pageData = {Jobs: []};`]) {
      assert.deepEqual(scan({ sourceUrl, body: script(declaration) + script(base) }), []);
    }
    assert.deepEqual(scan({ sourceUrl, body: body() + script(`window.pageData = ${json};`) }), []);
    assert.deepEqual(scan({ sourceUrl, body: '<svg>' + body() + '</svg>' }), []);
    assert.deepEqual(scan({ sourceUrl, body: `<script src="/external.js">window.pageData = ${json};</script>` + script(base) }), []);
  } },
  { name: 'Paylocity filtered external boards expose ordered navigation without claiming complete inventory', run() {
    const filtered = sourceUrl.replace('/Synthetic-Systems', '') + '?location=All%20Locations&department=Engineering';
    const links = read(data(), { sourceUrl: filtered }); assert.equal(links.length, 3);
    for (const link of links) {
      assert.equal(link.complete, undefined); assert.equal(link.isListed, undefined); assert.equal(link.tenantProven, undefined);
      assert.equal(link.url.includes('department='), false);
    }
    assert.deepEqual(read({ ...data(), Jobs: [] }, { sourceUrl: filtered }), []);
  } },
  { name: 'Paylocity inventory parsing stays bounded across source bytes, nodes, JSON depth and job counts', run() {
    assert.deepEqual(scan({ sourceUrl, body: 'x'.repeat(3 * 1024 * 1024 + 1) }), []);
    assert.deepEqual(scan({ sourceUrl, body: body() + '<i></i>'.repeat(33_000) }), []);
    const huge = data(); huge.Jobs = Array.from({ length: 513 }, (_, at) => job(1000 + at)); assert.deepEqual(read(huge), []);
    const deep = data(); let nested = {}; for (let at = 0; at < 55; at++) nested = { child: nested }; deep.extra = nested;
    assert.deepEqual(read(deep), []);
    assert.deepEqual(read(data(), { config: ' '.repeat(65_537) + base }), []);
  } },
  { name: 'Bound public inventory structural ceilings report coverage uncertainty without details or authority', run() {
    const receipt = (value, html = body(value)) => inventory({ sourceUrl, body: html });
    const huge = data(); huge.Jobs = Array.from({ length: 513 }, (_, at) => job(1000 + at));
    const deep = data(); let nested = {}; for (let at = 0; at < 55; at++) nested = { child: nested }; deep.extra = nested;
    const nodes = data(); nodes.extra = Array.from({ length: 33_000 }, () => null);
    for (const value of [huge, deep, nodes]) assert.deepEqual(receipt(value), { links: [], coverageIncomplete: true });
    assert.deepEqual(receipt(data(), body() + '<i></i>'.repeat(33_000)), { links: [], coverageIncomplete: true });
    assert.deepEqual(receipt(data(), body() + '<div>'.repeat(55) + 'deep' + '</div>'.repeat(55)), { links: [], coverageIncomplete: true });
    const unbound = structuredClone(huge); unbound.LeadJoinUrl = unbound.LeadJoinUrl.replace(/001$/u, '002');
    assert.deepEqual(receipt(unbound), { links: [], coverageIncomplete: false });
    assert.deepEqual(receipt(huge, body(huge, "window.ATSJobDetailsBaseUrl='/Recruiting/Jobs/Apply/';")), { links: [], coverageIncomplete: false });
    assert.deepEqual(inventory({ sourceUrl: sourceUrl.replace('recruiting.paylocity.com', 'foreign.test'), body: body(huge) }), { links: [], coverageIncomplete: false });
    assert.deepEqual(Object.keys(receipt(huge)).sort(), ['coverageIncomplete', 'links']);
  } },
];
