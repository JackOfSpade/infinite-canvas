import assert from 'node:assert/strict';
import { extractRegionalEmployerAccountReceipt as receipt } from '../../electron/ipc/officialPostingRegionalOwnership.js';
import { extractOfficialPostingVendorCandidates as candidates } from '../../electron/ipc/officialPostingVendorAdapters.js';

const id = '20000000-0000-4000-8000-000000000001';
const otherId = '20000000-0000-4000-8000-000000000002';
const source = 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/12';
const employer = 'Synthetic Systems North America Inc.';
const account = value => `https://recruiting.paylocity.com/Recruiting/Jobs/All/${value}`;
const ats = ({ name = employer, publisher = 'Synthetic Systems Companies', description = 'Build product software with our engineering team.' } = {}) =>
  `<h2 id="LayoutLogoName">${publisher}</h2><a href="${account(id)}">All jobs</a><script type="application/ld+json">${JSON.stringify({
    '@type': 'JobPosting', title: 'Software Engineer', url: source, description, hiringOrganization: { name },
  })}</script>`;
const careers = ({ name = 'Synthetic Systems North America', link = account(id), label = 'Lobby of' } = {}) =>
  `<h1>Careers at Synthetic Systems</h1><img alt="${label} ${name}"><a href="${link}">View jobs</a>`;
function read(options = {}) {
  const atsBody = options.atsBody || ats();
  return receipt({ candidate: Object.hasOwn(options, 'candidate') ? options.candidate : candidates({ body: atsBody, sourceUrl: source })[0], atsBody, atsSourceUrl: source,
    rootEmployer: 'Synthetic Systems', careersBody: careers(), careersUrl: 'https://synthetic.test/careers', ...options });
}

export default [
  { name: 'regional family receipt preserves legal employer and separately binds the actual parent publisher and account', run() {
    const result = read();
    assert.equal(result.employer, employer); assert.equal(result.publisher, 'Synthetic Systems Companies');
    assert.equal(result.rootEmployer, 'Synthetic Systems'); assert.equal(result.regionalQualifier, 'north america');
    assert.equal(result.tenant, id); assert.equal(result.tenantProven, undefined); assert.equal(result.employerDomainProven, undefined);
    assert.equal(read({ rootEmployer: 'Synthetic Systems Corporation' }).employer, employer);
  } },
  { name: 'regional account receipt requires an explicit complete entity name on the actual careers page', run() {
    for (const careersBody of [careers({ name: 'Synthetic Systems' }), '<h1>North America opportunities</h1>',
      `<script>${employer}</script><a href="${account(id)}">Jobs</a>`,
      `<template><img alt="${employer}"></template><a href="${account(id)}">Jobs</a>`]) assert.equal(read({ careersBody }), null);
    assert.equal(read({ careersBody: careers({ name: employer }) }).employer, employer);
  } },
  { name: 'regional account receipt rejects another or ambiguous account and a mismatched publisher', run() {
    assert.equal(read({ careersBody: careers({ link: account(otherId) }) }), null);
    assert.equal(read({ careersBody: careers() + `<a href="${account(otherId)}">Other jobs</a>` }), null);
    assert.equal(read({ atsBody: ats({ publisher: 'Other Systems Companies' }) }), null);
    assert.equal(read({ atsBody: ats() + '<h2 id="LayoutLogoName">Another Company</h2>' }), null);
    const candidate = candidates({ body: ats(), sourceUrl: source })[0];
    assert.equal(read({ candidate: { ...candidate, tenant: otherId } }), null);
    assert.equal(read({ candidate: { ...candidate, hiringOrganization: { name: 'Other Systems' } } }), null);
    assert.equal(read({ atsSourceUrl: source.replace('/12', '/13') }), null);
  } },
  { name: 'regional account receipt allows only exact recognized regional suffixes and rejects arbitrary shared prefixes', run() {
    for (const region of ['Europe', 'Canada', 'US', 'UK', 'United States', 'United Kingdom']) {
      const name = `Synthetic Systems ${region}`;
      assert.equal(read({ atsBody: ats({ name }), careersBody: careers({ name }) }).regionalQualifier, region.toLowerCase());
    }
    for (const region of ['South America', 'International', 'Client Services', 'Europe Software', 'Research']) {
      const name = `Synthetic Systems ${region}`;
      assert.equal(read({ atsBody: ats({ name }), careersBody: careers({ name }) }), null);
    }
  } },
  { name: 'regional receipt rejects intermediary or client framing and malformed or unbound source data', run() {
    for (const description of ['We are hiring for our client.', 'Work with the staffing agency.', 'Our recruitment agency is helping.']) {
      assert.equal(read({ atsBody: ats({ description }) }), null);
    }
    assert.equal(read({ careersBody: careers({ label: 'Our client' }) }), null);
    assert.equal(read({ careersBody: careers() + '<p>Our recruiters explain the recruitment process to people serving clients.</p>' }).employer, employer);
    assert.equal(read({ atsBody: ats({ description: 'Our own recruiters explain the recruitment process. Our software serves clients.' }) }).employer, employer);
    assert.equal(read({ careersUrl: 'http://synthetic.test/careers' }), null);
    assert.equal(read({ careersBody: '\0' }), null);
    assert.equal(read({ atsBody: 'x'.repeat(3 * 1024 * 1024 + 1), candidate: {} }), null);
    assert.equal(read({ candidate: {} }), null);
  } },
  { name: 'regional receipt rejects wide HTML before traversing or spreading unbounded child lists', run() {
    const candidate = candidates({ body: ats(), sourceUrl: source })[0];
    assert.equal(read({ candidate, atsBody: ats() + '<i></i>'.repeat(33_000) }), null);
    assert.equal(read({ careersBody: careers() + '<i></i>'.repeat(33_000) }), null);
  } },
  { name: 'regional receipt can consume typed authored careers declarations without inventing DOM anchors', run() {
    const key = 'CAREERS_SECTION-1_LINK-1_URL'; const alt = 'CAREERS_SECTION-2_SLIDE-1_IMAGE-ALT-TEXT';
    const fields = Object.fromEntries([[key, account(id)], [key.replace(/URL$/u, 'TEXT'), 'View Job Openings'],
      [alt, 'Lobby of Synthetic Systems North America']].map(([k, value]) => [k, { key: k, value }]));
    const careersBody = `<script id="ng-state" type="application/json">${JSON.stringify({ region: 'us', language: 'eng', 12345: { b: { 'eng-US': fields } } })}</script>`;
    const result = read({ careersBody, careersUrl: 'https://synthetic.test/us/eng/careers' });
    assert.equal(result.employer, employer); assert.equal(result.declaredCareersFacts.links[0].key, key);
    assert.equal(read({ careersBody, careersUrl: 'https://synthetic.test/ca/eng/careers' }), null);
    assert.equal(read({ careersBody: careersBody + `<a href="${account(otherId)}">Other account</a>`, careersUrl: 'https://synthetic.test/us/eng/careers' }), null);
  } },
];
